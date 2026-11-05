import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { zNum, type Sql } from '../db/sql.ts';
import { argsHash } from '../security/approvals.ts';
import { redactText, redactValue } from './redact.ts';

export function newTraceId(): string {
  return `tr_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export interface ToolExecutionInput {
  traceId: string;
  step: number;
  toolCallId: string;
  toolName: string;
  sideEffect: 'read' | 'write';
  input: unknown;
  outcome: 'ok' | 'error';
  errorCode: string | null;
  resultSummary: string | null;
  sourceType: string | null;
  latencyMs: number;
}

export interface ToolExecutionView {
  step: number;
  toolName: string;
  inputRedacted: unknown;
  outcome: string;
  errorCode: string | null;
  resultSummary: string | null;
  sourceType: string | null;
  latencyMs: number;
}

/** Events carry only redacted data, so listeners (CLI, future UI stream) never see raw PII. */
export type TraceEvent =
  | { kind: 'run_started'; traceId: string; provider: string; model: string }
  | { kind: 'model_call'; traceId: string; step: number; latencyMs: number; stopReason: string; model: string }
  | { kind: 'tool_started'; traceId: string; step: number; toolName: string }
  | { kind: 'grounding_check'; traceId: string; step: number; issues: string[] }
  | { kind: 'style_check'; traceId: string; step: number; issues: string[] }
  | { kind: 'tool'; traceId: string; execution: ToolExecutionView }
  | { kind: 'run_finished'; traceId: string; status: string; steps: number; latencyMs: number; inputTokens: number; outputTokens: number };

const ToolRow = z.object({
  step: zNum,
  tool_name: z.string(),
  input_redacted: z.unknown(),
  outcome: z.string(),
  error_code: z.string().nullable(),
  result_summary: z.string().nullable(),
  source_type: z.string().nullable(),
  latency_ms: zNum,
});

/** Persists observable actions (never model reasoning) to agent_runs / tool_executions. */
export class TraceRecorder {
  private readonly sql: Sql;
  private readonly redact: boolean;
  private readonly listeners: Array<(e: TraceEvent) => void> = [];

  constructor(sql: Sql, opts: { redact: boolean }) {
    this.sql = sql;
    this.redact = opts.redact;
  }

  /** Subscribe to redacted events; returns an unsubscribe function. */
  onEvent(listener: (e: TraceEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(e: TraceEvent): void {
    for (const l of this.listeners) l(e);
  }

  async startRun(run: { traceId: string; conversationId: string; ownerId: string; provider: string; model: string }): Promise<void> {
    await this.sql.query(
      'insert into public.agent_runs (trace_id, conversation_id, owner_id, provider, model, status) values ($1, $2, $3, $4, $5, $6)',
      [run.traceId, run.conversationId, run.ownerId, run.provider, run.model, 'running'],
    );
    this.emit({ kind: 'run_started', traceId: run.traceId, provider: run.provider, model: run.model });
  }

  /** A final answer was held back for claiming catalog facts without a lookup (observable, no content stored). */
  groundingCheck(e: { traceId: string; step: number; issues: string[] }): void {
    this.emit({ kind: 'grounding_check', ...e });
  }

  /** A final answer was held back by the style guard (issue codes only, no content). */
  styleCheck(e: { traceId: string; step: number; issues: string[] }): void {
    this.emit({ kind: 'style_check', ...e });
  }

  /** A tool call is about to run (name only, no input), so a UI can show real progress. */
  toolStarted(e: { traceId: string; step: number; toolName: string }): void {
    this.emit({ kind: 'tool_started', ...e });
  }

  modelCall(e: { traceId: string; step: number; latencyMs: number; stopReason: string; model: string }): void {
    this.emit({ kind: 'model_call', ...e });
  }

  /** Write-tool inputs are stored as key names + hash only; read-tool inputs are redacted. */
  private storedInput(rec: ToolExecutionInput): unknown {
    if (rec.sideEffect === 'write') {
      const keys = rec.input !== null && typeof rec.input === 'object' ? Object.keys(rec.input) : [];
      return { keys, argsHash: argsHash(rec.input) };
    }
    return this.redact ? redactValue(rec.input) : rec.input;
  }

  async recordTool(rec: ToolExecutionInput): Promise<void> {
    const view: ToolExecutionView = {
      step: rec.step,
      toolName: rec.toolName,
      inputRedacted: this.storedInput(rec),
      outcome: rec.outcome,
      errorCode: rec.errorCode,
      resultSummary: rec.resultSummary === null ? null : redactText(rec.resultSummary),
      sourceType: rec.sourceType,
      latencyMs: rec.latencyMs,
    };
    await this.sql.query(
      `insert into public.tool_executions (trace_id, step, tool_call_id, tool_name, input_redacted, outcome, error_code, result_summary,
         source_type, latency_ms) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [rec.traceId, view.step, rec.toolCallId, view.toolName, JSON.stringify(view.inputRedacted ?? null), view.outcome, view.errorCode,
        view.resultSummary, view.sourceType, view.latencyMs],
    );
    this.emit({ kind: 'tool', traceId: rec.traceId, execution: view });
  }

  async finishRun(e: { traceId: string; status: string; errorCode: string | null; steps: number; inputTokens: number; outputTokens: number; latencyMs: number }): Promise<void> {
    await this.sql.query(
      `update public.agent_runs set status = $2, error_code = $3, steps = $4, input_tokens = $5, output_tokens = $6, finished_at = now(), latency_ms = $7
       where trace_id = $1`,
      [e.traceId, e.status, e.errorCode, e.steps, e.inputTokens, e.outputTokens, e.latencyMs],
    );
    this.emit({ kind: 'run_finished', traceId: e.traceId, status: e.status, steps: e.steps, latencyMs: e.latencyMs, inputTokens: e.inputTokens, outputTokens: e.outputTokens });
  }

  async toolExecutions(traceId: string): Promise<ToolExecutionView[]> {
    const rows = await this.sql.query(
      `select step, tool_name, input_redacted, outcome, error_code, result_summary, source_type, latency_ms
       from public.tool_executions where trace_id = $1 order by id`,
      [traceId],
    );
    return rows.map((r) => {
      const t = ToolRow.parse(r);
      return {
        step: t.step, toolName: t.tool_name, inputRedacted: t.input_redacted, outcome: t.outcome, errorCode: t.error_code,
        resultSummary: t.result_summary, sourceType: t.source_type, latencyMs: t.latency_ms,
      };
    });
  }
}
