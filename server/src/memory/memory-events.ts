import type { Sql } from '../db/sql.ts';

export type MemoryEvent = 'consent_granted' | 'consent_declined' | 'consent_revoked' | 'memory_saved' | 'memory_forgotten' | 'erased_all';

/** Content-free audit trail of consent decisions, saves and deletions (docs/03: "audit deletion"). */
export async function recordMemoryEvent(
  sql: Sql,
  e: { ownerId: string; event: MemoryEvent; conversationId?: string | null; category?: string | null; itemCount?: number | null; traceId?: string | null; policyVersion?: string | null },
): Promise<void> {
  await sql.query(
    `insert into public.memory_events (owner_id, event, conversation_id, category, item_count, trace_id, policy_version)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.ownerId, e.event, e.conversationId ?? null, e.category ?? null, e.itemCount ?? null, e.traceId ?? null, e.policyVersion ?? null],
  );
}
