import { z } from 'zod';
import { zIso, zNum, type Sql } from '../db/sql.ts';
import { normalizeDigits, redactText } from '../observability/redact.ts';
import { normalizeForSearch } from '../text/normalize.ts';
import type { ConsentStore } from './consent-store.ts';
import { toVectorLiteral, type EmbeddingPurpose, type EmbeddingProvider } from './embeddings.ts';
import { recordMemoryEvent } from './memory-events.ts';

export const MEMORY_CATEGORIES = [
  'budget', 'departure_city', 'travel_party', 'preferred_language', 'travel_dates',
  'trip_style', 'destination_interest', 'accessibility_or_diet', 'other',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Categories holding one current value: a new save supersedes the old one ("budget is now 5000, not 10000"). */
const SINGLE_VALUED = new Set<MemoryCategory>(['budget', 'departure_city', 'travel_party', 'preferred_language', 'travel_dates']);

const MAX_RECALL = 30;
/** Owners with this many items or fewer get everything back (no embedding call, nothing missed). */
const SMALL_PROFILE = 15;
const SEMANTIC_MIN_SIMILARITY = 0.3;
const LEXICAL_MIN_SIMILARITY = 0.2;

export class MemoryConsentError extends Error {
  constructor() {
    super('Long-term memory consent is not active for this customer.');
    this.name = 'MemoryConsentError';
  }
}

export class MemoryContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryContentError';
  }
}

export interface MemoryItem {
  id: string;
  category: string;
  content: string;
  updatedAt: string;
  similarity: number | null;
}

export interface PastConversation {
  conversationId: string;
  summary: string;
  createdAt: string;
}

export type RetrievalMode = 'semantic' | 'lexical' | 'all';

export interface RecallResult {
  status: 'ok' | 'no_consent';
  retrieval: RetrievalMode | null;
  items: MemoryItem[];
  pastConversations: PastConversation[];
  warnings: string[];
}

export type ForgetScope = { kind: 'all' } | { kind: 'category'; category: MemoryCategory } | { kind: 'item'; itemId: string };

const ItemRow = z.object({ id: z.string(), category: z.string(), content: z.string(), updated_at: zIso, similarity: zNum.nullable().optional() });
const SummaryRow = z.object({ conversation_id: z.string(), summary: z.string(), created_at: zIso });

/** Active, owner-scoped, consented, non-contact items. $1 = owner id. */
const ACTIVE_FROM = `public.memory_items m join public.consents c on c.id = m.consent_id and c.revoked_at is null and c.owner_id = m.owner_id
  where m.owner_id = $1 and m.kind <> 'contact' and m.deleted_at is null and m.superseded_by is null
    and (m.expires_at is null or m.expires_at > now())`;

/** Latest summary per earlier conversation, written after the current consent was granted. $1 owner, $2 current conversation, $3 granted_at. */
const LATEST_SUMMARIES = `select distinct on (s.conversation_id) s.conversation_id, s.summary, s.created_at, s.embedding, s.embedding_model
  from public.conversation_summaries s
  where s.owner_id = $1 and s.conversation_id <> $2 and s.expires_at > now() and s.created_at >= $3::timestamptz
  order by s.conversation_id, s.covers_until_seq desc`;

/**
 * Consent-aware long-term memory: preferences with provenance, newest-wins correction, dedupe,
 * owner-scoped semantic (pgvector) or lexical (pg_trgm) recall, and audited hard deletion.
 */
export class MemoryService {
  private readonly sql: Sql;
  private readonly consents: ConsentStore;
  private readonly embeddings: EmbeddingProvider | null;

  constructor(sql: Sql, consents: ConsentStore, embeddings: EmbeddingProvider | null) {
    this.sql = sql;
    this.consents = consents;
    this.embeddings = embeddings;
  }

  get retrievalBackend(): string {
    return this.embeddings ? `semantic:${this.embeddings.label}` : 'lexical_fallback (no embedding provider configured)';
  }

  get embeddingLabel(): string | null {
    return this.embeddings?.label ?? null;
  }

  async status(ownerId: string): Promise<{ consentActive: boolean; itemCount: number }> {
    const consent = await this.consents.active(ownerId, 'long_term_memory');
    if (!consent) return { consentActive: false, itemCount: 0 };
    const [row] = await this.sql.query(`select count(*)::int as n from ${ACTIVE_FROM}`, [ownerId]);
    return { consentActive: true, itemCount: Number(row?.['n'] ?? 0) };
  }

  private async tryEmbed(text: string, signal: AbortSignal, warnings: string[], purpose: EmbeddingPurpose): Promise<string | null> {
    if (!this.embeddings) return null;
    try {
      const [vector] = await this.embeddings.embed([text], signal, purpose);
      return vector ? toVectorLiteral(vector) : null;
    } catch {
      warnings.push('Embedding service unavailable; stored/searched without semantic vectors.');
      return null;
    }
  }

  async savePreference(
    ownerId: string,
    input: { category: MemoryCategory; content: string; conversationId: string; traceId?: string; messageSeq?: number; replacesItemId?: string },
    signal: AbortSignal,
  ): Promise<{ id: string; superseded: string[]; duplicate: boolean; warnings: string[] }> {
    if (!(await this.consents.active(ownerId, 'long_term_memory'))) throw new MemoryConsentError();
    const content = input.content.trim();
    // Compare on normalized digits so "٥٠٠٠ جنيه" is a budget, not a "contact detail".
    if (redactText(content) !== normalizeDigits(content)) {
      throw new MemoryContentError('Contact details (phone, email, ID numbers) are never stored as preferences.');
    }
    const normalized = normalizeForSearch(normalizeDigits(content));
    const existing = (await this.sql.query(`select m.id, m.category, m.content, m.updated_at from ${ACTIVE_FROM} and m.category = $2`, [ownerId, input.category]))
      .map(toItem);
    const duplicate = existing.find((i) => normalizeForSearch(normalizeDigits(i.content)) === normalized);
    if (duplicate) return { id: duplicate.id, superseded: [], duplicate: true, warnings: [] };

    const warnings: string[] = [];
    const vector = await this.tryEmbed(`${input.category}: ${content}`, signal, warnings, 'document');
    const result = await this.sql.transaction(async (tx) => {
      // Insert only while consent is still active (no orphan if a revoke races this save).
      const inserted = await tx.query(
        `insert into public.memory_items (owner_id, consent_id, kind, category, content, purpose, source_conversation_id, source_message_seq,
           source_trace_id, embedding, embedding_model)
         select $1, c.id, 'preference', $2, $3, 'travel_personalization', $4, $5, $6, $7::extensions.vector, $8
         from public.consents c where c.owner_id = $1 and c.purpose = 'long_term_memory' and c.revoked_at is null
         returning id`,
        [ownerId, input.category, content, input.conversationId, input.messageSeq ?? null, input.traceId ?? null, vector, vector ? this.embeddings?.label ?? null : null],
      );
      const first = inserted[0];
      if (!first) throw new MemoryConsentError();
      const id = z.object({ id: z.string() }).parse(first).id;
      const toSupersede = SINGLE_VALUED.has(input.category)
        ? existing.map((i) => i.id)
        : existing.filter((i) => i.id === input.replacesItemId).map((i) => i.id);
      if (toSupersede.length > 0) {
        // Keep chains one level deep: older history and the replaced rows all point at the new row.
        await tx.query('update public.memory_items set superseded_by = $2 where owner_id = $1 and superseded_by = any($3::uuid[])', [ownerId, id, toSupersede]);
        await tx.query(
          `update public.memory_items set superseded_by = $2, embedding = null, embedding_model = null, updated_at = now()
           where owner_id = $1 and id = any($3::uuid[])`,
          [ownerId, id, toSupersede],
        );
      }
      await recordMemoryEvent(tx, { ownerId, event: 'memory_saved', conversationId: input.conversationId, category: input.category, itemCount: 1, traceId: input.traceId ?? null });
      return { id, superseded: toSupersede };
    });
    return { ...result, duplicate: false, warnings };
  }

  /** Small profiles: everything. Otherwise without a query: newest items; with a query: semantic first, lexical merged by score. */
  async recall(ownerId: string, query: string | undefined, conversationId: string | null, signal: AbortSignal): Promise<RecallResult> {
    const consent = await this.consents.active(ownerId, 'long_term_memory');
    if (!consent) return { status: 'no_consent', retrieval: null, items: [], pastConversations: [], warnings: [] };
    const warnings: string[] = [];
    const cleanQuery = query?.trim() ? redactText(query.trim()) : '';
    const { itemCount } = await this.status(ownerId);
    const vector = cleanQuery ? await this.tryEmbed(cleanQuery, signal, warnings, 'query') : null;
    const pastConversations = await this.pastConversations(ownerId, cleanQuery, vector, conversationId, consent.grantedAt);

    if (!cleanQuery || itemCount <= SMALL_PROFILE) {
      const rows = await this.sql.query(`select m.id, m.category, m.content, m.updated_at from ${ACTIVE_FROM} order by m.updated_at desc limit ${MAX_RECALL}`, [ownerId]);
      return { status: 'ok', retrieval: 'all', items: rows.map(toItem), pastConversations, warnings };
    }
    const byId = new Map<string, MemoryItem>();
    let retrieval: RetrievalMode = 'lexical';
    if (vector && this.embeddings) {
      retrieval = 'semantic';
      const rows = await this.sql.query(
        'select id, category, content, updated_at, similarity from public.match_memory_items($1, $2::extensions.vector, $3, $4, $5)',
        [ownerId, vector, this.embeddings.label, MAX_RECALL, SEMANTIC_MIN_SIMILARITY],
      );
      for (const item of rows.map(toItem)) byId.set(item.id, item);
    }
    const lexical = await this.sql.query(
      `select m.id, m.category, m.content, m.updated_at, extensions.word_similarity($2, m.content) as similarity
       from ${ACTIVE_FROM} and extensions.word_similarity($2, m.content) >= $3 order by similarity desc limit ${MAX_RECALL}`,
      [ownerId, cleanQuery, LEXICAL_MIN_SIMILARITY],
    );
    for (const item of lexical.map(toItem)) {
      const prev = byId.get(item.id);
      if (!prev || (item.similarity ?? 0) > (prev.similarity ?? 0)) byId.set(item.id, item);
    }
    const items = [...byId.values()].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)).slice(0, MAX_RECALL);
    return { status: 'ok', retrieval, items, pastConversations, warnings };
  }

  /** Latest summary per earlier conversation (after consent was granted); semantic and lexical matches merged. */
  private async pastConversations(ownerId: string, query: string, vector: string | null, currentConversationId: string | null, grantedAt: string): Promise<PastConversation[]> {
    const params = [ownerId, currentConversationId ?? '', grantedAt];
    let rows;
    if (!query) {
      rows = await this.sql.query(`select * from (${LATEST_SUMMARIES}) l order by l.created_at desc limit 3`, params);
    } else {
      const semantic = vector && this.embeddings
        ? await this.sql.query(
          `select l.conversation_id, l.summary, l.created_at, 1 - (l.embedding operator(extensions.<=>) $4::extensions.vector) as score
           from (${LATEST_SUMMARIES}) l where l.embedding_model = $5 and 1 - (l.embedding operator(extensions.<=>) $4::extensions.vector) >= $6`,
          [...params, vector, this.embeddings.label, SEMANTIC_MIN_SIMILARITY],
        )
        : [];
      const lexical = await this.sql.query(
        `select l.conversation_id, l.summary, l.created_at, extensions.word_similarity($4, l.summary) as score
         from (${LATEST_SUMMARIES}) l where extensions.word_similarity($4, l.summary) >= $5`,
        [...params, query, LEXICAL_MIN_SIMILARITY],
      );
      const best = new Map<string, { row: Record<string, unknown>; score: number }>();
      for (const row of [...semantic, ...lexical]) {
        const id = String(row['conversation_id']);
        const score = Number(row['score']);
        const prev = best.get(id);
        if (!prev || score > prev.score) best.set(id, { row, score });
      }
      rows = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 3).map((b) => b.row);
    }
    return rows.map((r) => {
      const s = SummaryRow.parse(r);
      return { conversationId: s.conversation_id, summary: s.summary, createdAt: s.created_at };
    });
  }

  async list(ownerId: string): Promise<MemoryItem[]> {
    const rows = await this.sql.query(`select m.id, m.category, m.content, m.updated_at from ${ACTIVE_FROM} order by m.category, m.updated_at desc`, [ownerId]);
    return rows.map(toItem);
  }

  /**
   * Hard delete (including superseded history) for one item, one category or everything. Deletion propagates
   * to every conversation summary of the owner, since summaries may restate the forgotten preference.
   */
  async forget(ownerId: string, scope: ForgetScope, audit: { conversationId?: string | null; traceId?: string | null } = {}): Promise<number> {
    return this.sql.transaction(async (tx) => {
      const params: unknown[] = [ownerId];
      let filter = "owner_id = $1 and kind <> 'contact'";
      if (scope.kind === 'category') {
        params.push(scope.category);
        filter += ' and category = $2';
      } else if (scope.kind === 'item') {
        params.push(scope.itemId);
        filter += ' and (id = $2::uuid or superseded_by = $2::uuid)';
      }
      // Resolve the exact rows first; unlinking before matching would let replaced history escape the delete.
      const ids = (await tx.query(`select id from public.memory_items where ${filter}`, params)).map((r) => String(r['id']));
      await tx.query('update public.memory_items set superseded_by = null where owner_id = $1 and id = any($2::uuid[])', [ownerId, ids]);
      const deleted = (await tx.query('delete from public.memory_items where owner_id = $1 and id = any($2::uuid[]) returning id', [ownerId, ids])).length;
      await tx.query('delete from public.conversation_summaries where owner_id = $1', [ownerId]);
      await recordMemoryEvent(tx, {
        ownerId, event: 'memory_forgotten', conversationId: audit.conversationId ?? null, traceId: audit.traceId ?? null,
        category: scope.kind === 'category' ? scope.category : scope.kind, itemCount: deleted,
      });
      return deleted;
    });
  }

  /**
   * "Delete everything about me": removes the customer row, cascading to conversations, messages, summaries,
   * memories, consents, approvals, CRM rows and traces. Leaves no audit row (the audit table cascades too).
   */
  async eraseAll(ownerId: string): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await tx.query('update public.memory_items set superseded_by = null where owner_id = $1', [ownerId]);
      await tx.query('delete from public.customers where owner_id = $1', [ownerId]);
    });
  }
}

function toItem(r: Record<string, unknown>): MemoryItem {
  const i = ItemRow.parse(r);
  return { id: i.id, category: i.category, content: i.content, updatedAt: i.updated_at, similarity: i.similarity ?? null };
}
