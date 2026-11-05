import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../db/sql.ts';
import type { ChatMessage } from '../agent/providers/types.ts';
import { repairHistory } from '../agent/history.ts';

const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), input: z.unknown(), inputError: z.string().optional() }),
  z.object({ type: z.literal('tool_result'), toolCallId: z.string(), content: z.string(), isError: z.boolean() }),
  z.object({ type: z.literal('opaque'), provider: z.string(), model: z.string(), block: z.unknown() }),
]);
const MessageRow = z.object({ role: z.enum(['user', 'assistant']), content: z.array(ContentBlockSchema) });

const ConversationListRow = z
  .object({ id: z.string(), created_at: z.coerce.date(), updated_at: z.coerce.date(), user_turns: z.coerce.number(), title: z.string().nullable() })
  .transform((r) => ({ id: r.id, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), userTurns: r.user_turns, title: r.title }));
export type ConversationSummaryRow = z.output<typeof ConversationListRow>;

export interface StoredMessage {
  seq: number;
  message: ChatMessage;
}

/** Same error for "missing" and "someone else's" so conversation ids cannot be probed. */
export class ConversationAccessError extends Error {
  constructor() {
    super('Conversation not found.');
    this.name = 'ConversationAccessError';
  }
}

/** Append-only session history scoped to a server-side owner id (never model-supplied). */
export class ConversationStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async ensureCustomer(ownerId: string, locale: string | null = null): Promise<void> {
    await this.sql.query(
      `insert into public.customers (owner_id, locale) values ($1, $2) on conflict (owner_id) do update set updated_at = now()`,
      [ownerId, locale],
    );
  }

  async create(ownerId: string, locale: string | null = null): Promise<string> {
    await this.ensureCustomer(ownerId, locale);
    const id = `conv_${randomUUID()}`;
    await this.sql.query('insert into public.conversations (id, owner_id, locale) values ($1, $2, $3)', [id, ownerId, locale]);
    return id;
  }

  async assertOwner(conversationId: string, ownerId: string): Promise<void> {
    const rows = await this.sql.query('select 1 from public.conversations where id = $1 and owner_id = $2', [conversationId, ownerId]);
    if (rows.length === 0) throw new ConversationAccessError();
  }

  /** Loads the transcript, repaired so every tool call is answered (see agent/history.ts). */
  async load(conversationId: string, ownerId: string): Promise<ChatMessage[]> {
    return repairHistory((await this.loadRecords(conversationId, ownerId)).map((r) => r.message));
  }

  /** Raw stored messages with their sequence numbers (unrepaired; used by the context manager). */
  async loadRecords(conversationId: string, ownerId: string): Promise<StoredMessage[]> {
    await this.assertOwner(conversationId, ownerId);
    const rows = await this.sql.query(
      'select seq, role, content from public.messages where conversation_id = $1 and owner_id = $2 order by seq',
      [conversationId, ownerId],
    );
    return rows.map((r) => {
      const { seq, ...message } = MessageRow.extend({ seq: z.coerce.number() }).parse(r);
      return { seq, message };
    });
  }

  /**
   * The owner's conversations, newest activity first. The title is the first customer text (trimmed),
   * excluding automatic runtime notes; computed in SQL so transcripts are not loaded.
   */
  async list(ownerId: string, limit = 50): Promise<ConversationSummaryRow[]> {
    const rows = await this.sql.query(
      `select c.id, c.created_at, c.updated_at,
         (select count(*) from public.messages m where m.conversation_id = c.id and m.role = 'user'
            and exists (select 1 from jsonb_array_elements(m.content) b where b->>'type' = 'text' and b->>'text' not like '[Automatic runtime check%')) as user_turns,
         (select left(b->>'text', 120) from public.messages m, jsonb_array_elements(m.content) b
            where m.conversation_id = c.id and m.role = 'user' and b->>'type' = 'text' and b->>'text' not like '[Automatic runtime check%'
            order by m.seq limit 1) as title
       from public.conversations c where c.owner_id = $1 order by c.updated_at desc limit $2`,
      [ownerId, limit],
    );
    return rows.map((r) => ConversationListRow.parse(r));
  }

  /**
   * Deletes one conversation of this owner: transcript and summaries (cascade), its approvals and traces.
   * Saved memories and CRM requests are separate customer data with their own controls.
   */
  async delete(conversationId: string, ownerId: string): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const deleted = await tx.query('delete from public.conversations where id = $1 and owner_id = $2 returning id', [conversationId, ownerId]);
      if (deleted.length === 0) throw new ConversationAccessError();
      await tx.query('delete from public.approvals where conversation_id = $1 and owner_id = $2', [conversationId, ownerId]);
      await tx.query('delete from public.agent_runs where conversation_id = $1 and owner_id = $2', [conversationId, ownerId]);
    });
  }

  /** Atomic per-conversation sequence; retries if a concurrent writer took the same seq. */
  async append(conversationId: string, ownerId: string, message: ChatMessage, traceId: string | null): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.sql.query(
          `insert into public.messages (conversation_id, owner_id, seq, role, content, trace_id)
           select $1, $2, coalesce(max(seq), 0) + 1, $3, $4::jsonb, $5 from public.messages where conversation_id = $1`,
          [conversationId, ownerId, message.role, JSON.stringify(message.content), traceId],
        );
        // Activity extends the 30-day session retention window (an active conversation is never purged mid-use).
        await this.sql.query("update public.conversations set updated_at = now(), expires_at = greatest(expires_at, now() + interval '30 days') where id = $1", [conversationId]);
        return;
      } catch (err) {
        if (attempt >= 2 || !(err instanceof Error) || !/unique|duplicate/i.test(err.message)) throw err;
      }
    }
  }
}
