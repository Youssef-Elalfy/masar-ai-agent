import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../db/sql.ts';
import { redactValue } from '../observability/redact.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** Stable hash of tool arguments, so an approval covers exactly the arguments the user saw. */
export function argsHash(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(args ?? {}))).digest('hex');
}

export interface PendingApproval {
  approvalId: string;
  toolName: string;
  argsPreview: unknown;
  expiresAt: string;
}

/**
 * Human-in-the-loop approvals for write tools: single-use, owner-scoped, bound to tool + exact
 * arguments, and time-limited. Only the user-facing client may call `decide` (never the model).
 */
export class ApprovalStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  /** `preview` is what the user sees and what is stored; it must already be masked (default: redacted arguments). */
  async request(args: { ownerId: string; conversationId: string; toolName: string; input: unknown; preview?: unknown }): Promise<PendingApproval> {
    const preview = args.preview ?? redactValue(args.input);
    const rows = await this.sql.query(
      `insert into public.approvals (owner_id, conversation_id, tool_name, args_hash, args_preview)
       values ($1, $2, $3, $4, $5::jsonb) returning id, expires_at`,
      [args.ownerId, args.conversationId, args.toolName, argsHash(args.input), JSON.stringify(preview)],
    );
    const row = z.object({ id: z.string(), expires_at: z.union([z.date(), z.string()]) }).parse(rows[0]);
    return { approvalId: row.id, toolName: args.toolName, argsPreview: preview, expiresAt: new Date(row.expires_at).toISOString() };
  }

  async decide(approvalId: string, ownerId: string, approved: boolean): Promise<boolean> {
    const rows = await this.sql.query(
      `update public.approvals set status = $3, decided_at = now()
       where id = $1 and owner_id = $2 and status = 'pending' and expires_at > now() returning id`,
      [approvalId, ownerId, approved ? 'approved' : 'rejected'],
    );
    return rows.length === 1;
  }

  /** Undecided, unexpired approvals of one conversation (so a reloaded client can still show them). */
  async pending(ownerId: string, conversationId: string): Promise<PendingApproval[]> {
    const rows = await this.sql.query(
      `select id, tool_name, args_preview, expires_at from public.approvals
       where owner_id = $1 and conversation_id = $2 and status = 'pending' and expires_at > now() order by created_at`,
      [ownerId, conversationId],
    );
    return rows.map((r) => {
      const row = z.object({ id: z.string(), tool_name: z.string(), args_preview: z.unknown(), expires_at: z.union([z.date(), z.string()]) }).parse(r);
      return { approvalId: row.id, toolName: row.tool_name, argsPreview: row.args_preview, expiresAt: new Date(row.expires_at).toISOString() };
    });
  }

  /** Atomically consumes one matching approved approval; returns its id or null. */
  async consume(args: { ownerId: string; conversationId: string; toolName: string; input: unknown }): Promise<string | null> {
    const rows = await this.sql.query(
      `update public.approvals set status = 'consumed', consumed_at = now()
       where id = (
         select id from public.approvals
         where owner_id = $1 and conversation_id = $2 and tool_name = $3 and args_hash = $4 and status = 'approved' and expires_at > now()
         order by decided_at limit 1 for update skip locked
       ) returning id`,
      [args.ownerId, args.conversationId, args.toolName, argsHash(args.input)],
    );
    const id = rows[0]?.['id'];
    return typeof id === 'string' ? id : null;
  }
}
