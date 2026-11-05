import { z } from 'zod';
import { zIso, type Sql } from '../db/sql.ts';
import { recordMemoryEvent } from './memory-events.ts';

export const CONSENT_PURPOSES = ['long_term_memory', 'contact_storage', 'lead_creation', 'human_handoff'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const MEMORY_POLICY_VERSION = 'memory-v1-2026-11';

/**
 * Server-fixed consent wording shown by the client (never model-authored), versioned with the policy.
 * `{processor}` is replaced with the embedding processor actually configured.
 */
export const MEMORY_CONSENT_TEXT: Record<'ar' | 'en', string> = {
  ar: 'مَسَارٌ (شركة تجريبية) عايز يفتكر تفضيلات السفر بتاعتك بس (الميزانية، نوع الرحلة، الوجهات اللي بتحبها، مدينة السفر، عدد المسافرين، التواريخ) عشان يقترح عليك رحلات أنسب في المحادثات الجاية. مش هيتحفظ رقم تليفون أو إيميل أو اسم. {processor} البيانات بتفضل لحد ما تمسحها، وتقدر تشوفها أو تمسحها أو تقفل الذاكرة في أي وقت (/memory، /forget، /memory off).',
  en: 'MASAR AI (a demo company) would like to remember your travel preferences only (budget, trip style, destinations of interest, departure city, party, dates) to suggest better trips in future conversations. No phone numbers, emails or names are stored. {processor} Data is kept until you delete it; you can view, delete or switch memory off anytime (/memory, /forget, /memory off).',
};

/** Same policy and meaning; only the pointer to the controls differs between the CLI and the web console. */
const WEB_CONTROLS: Record<'ar' | 'en', string> = { ar: '(من لوحة الذاكرة)', en: '(in the Memory panel)' };

export function consentText(lang: 'ar' | 'en', embeddingLabel: string | null, channel: 'cli' | 'web' = 'cli'): string {
  let processor = '';
  if (embeddingLabel?.startsWith('gemini/')) {
    processor = lang === 'ar'
      ? 'للبحث بالمعنى، نص التفضيل بيتبعت لخدمة Google Gemini (الخطة المجانية، وجوجل ممكن تستخدم البيانات دي لتحسين منتجاتها).'
      : 'For meaning-based search, preference text is sent to Google Gemini (free tier; Google may use this data to improve its products).';
  } else if (embeddingLabel?.startsWith('openai/')) {
    processor = lang === 'ar' ? 'للبحث بالمعنى، نص التفضيل بيتبعت لخدمة OpenAI embeddings.' : 'For meaning-based search, preference text is sent to the OpenAI embeddings service.';
  }
  const text = MEMORY_CONSENT_TEXT[lang].replace('{processor}', processor).replace(/\s{2,}/g, ' ');
  return channel === 'web' ? text.replace(/\(\/memory[^)]*\)/, WEB_CONTROLS[lang]) : text;
}

export interface ActiveConsent {
  id: string;
  purpose: ConsentPurpose;
  grantedAt: string;
}

/**
 * Per-owner, per-purpose consent log. `grant`/`decline` must only be called from a user-facing decision
 * (CLI prompt / UI button), never from model output. Revoking long-term memory erases the memories and summaries.
 */
export class ConsentStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async active(ownerId: string, purpose: ConsentPurpose): Promise<ActiveConsent | null> {
    const rows = await this.sql.query(
      'select id, purpose, granted_at from public.consents where owner_id = $1 and purpose = $2 and revoked_at is null',
      [ownerId, purpose],
    );
    const row = rows[0];
    if (!row) return null;
    const r = z.object({ id: z.string(), purpose: z.enum(CONSENT_PURPOSES), granted_at: zIso }).parse(row);
    return { id: r.id, purpose: r.purpose, grantedAt: r.granted_at };
  }

  async grant(ownerId: string, purpose: ConsentPurpose, evidence: { conversationId: string | null; messageSeq?: number }): Promise<ActiveConsent> {
    const existing = await this.active(ownerId, purpose);
    if (existing) return existing;
    await this.sql.query('insert into public.customers (owner_id) values ($1) on conflict (owner_id) do nothing', [ownerId]);
    await this.sql.query(
      `insert into public.consents (owner_id, purpose, policy_version, evidence_conversation_id, evidence_message_seq)
       values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [ownerId, purpose, MEMORY_POLICY_VERSION, evidence.conversationId, evidence.messageSeq ?? null],
    );
    const granted = await this.active(ownerId, purpose);
    if (!granted) throw new Error('Consent was not recorded.');
    // The memory audit log covers memory consent only; CRM consents carry their approval as evidence.
    if (purpose === 'long_term_memory') {
      await recordMemoryEvent(this.sql, { ownerId, event: 'consent_granted', conversationId: evidence.conversationId, policyVersion: MEMORY_POLICY_VERSION });
    }
    return granted;
  }

  /** Records that the customer said no, so the assistant does not ask again in this conversation. */
  async decline(ownerId: string, conversationId: string): Promise<void> {
    await this.sql.query('insert into public.customers (owner_id) values ($1) on conflict (owner_id) do nothing', [ownerId]);
    await recordMemoryEvent(this.sql, { ownerId, event: 'consent_declined', conversationId, policyVersion: MEMORY_POLICY_VERSION });
  }

  async declinedIn(ownerId: string, conversationId: string): Promise<boolean> {
    const rows = await this.sql.query(
      `select 1 from public.memory_events where owner_id = $1 and conversation_id = $2 and event = 'consent_declined' limit 1`,
      [ownerId, conversationId],
    );
    return rows.length > 0;
  }

  /** Revokes and, for long-term memory, deletes the stored memories and ALL conversation summaries of the owner. */
  async revoke(ownerId: string, purpose: ConsentPurpose): Promise<{ revoked: boolean; deletedMemories: number }> {
    return this.sql.transaction(async (tx) => {
      const revoked = await tx.query(
        'update public.consents set revoked_at = now() where owner_id = $1 and purpose = $2 and revoked_at is null returning id',
        [ownerId, purpose],
      );
      let deletedMemories = 0;
      if (purpose === 'long_term_memory' && revoked.length > 0) {
        await tx.query("update public.memory_items set superseded_by = null where owner_id = $1 and kind <> 'contact'", [ownerId]);
        deletedMemories = (await tx.query("delete from public.memory_items where owner_id = $1 and kind <> 'contact' returning id", [ownerId])).length;
        await tx.query('delete from public.conversation_summaries where owner_id = $1', [ownerId]);
        await recordMemoryEvent(tx, { ownerId, event: 'consent_revoked', itemCount: deletedMemories, policyVersion: MEMORY_POLICY_VERSION });
      }
      return { revoked: revoked.length > 0, deletedMemories };
    });
  }
}
