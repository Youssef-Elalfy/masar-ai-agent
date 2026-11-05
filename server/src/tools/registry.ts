import { z } from 'zod';
import { redactValue } from '../observability/redact.ts';

export const TOOL_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNKNOWN_TOOL',
  'APPROVAL_REQUIRED',
  'TOOL_TIMEOUT',
  'TOOL_FAILED',
  'NOT_FOUND',
  'AMBIGUOUS_REFERENCE',
  'CONSENT_REQUIRED',
  'NOT_ALLOWED',
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** Safe, user-presentable tool failure. Never carries stack traces to the model or the user. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details: unknown;
  constructor(code: ToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

/** The client shows the server-fixed notice for this policy version (never model-authored text). */
export interface ConsentRequest {
  purpose: 'long_term_memory';
  policyVersion: string;
}

/** Server-controlled context. Identity fields come from the session, never from model output. */
export interface ToolContext {
  traceId: string;
  conversationId: string;
  ownerId: string;
  now: Date;
  signal: AbortSignal;
  /** Set only for write tools, after the runtime consumed a matching user approval. */
  approvalId?: string;
  /** Asks the client to show a consent prompt to the user after this turn (the model can never grant consent). */
  requestConsent?: (request: ConsentRequest) => void;
}

/**
 * How a write tool is authorized: a per-call user approval bound to its exact arguments,
 * or a standing, revocable consent for a purpose that the user granted in the client.
 */
export type WriteAuthorization = { kind: 'approval' } | { kind: 'consent'; purpose: 'long_term_memory' };

export type SourceType =
  | 'company_demo'
  | 'company_verified'
  | 'external_listing'
  | 'supplier_live_inventory'
  | 'estimated_itinerary'
  | 'general_information'
  | 'unavailable'
  | 'system';

export interface ToolOutput {
  sourceType: SourceType;
  /** One-line factual summary stored in the trace (no PII). */
  summary: string;
  result: unknown;
  warnings?: string[];
}

export interface ToolDefinition<S extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;
  sideEffect: 'read' | 'write';
  /** Write tools only; defaults to per-call approval. */
  authorization?: WriteAuthorization;
  /** What the user is shown when asked to approve (default: PII-redacted arguments). Stored in approvals. */
  approvalPreview?: (input: z.output<S>) => unknown;
  /** Write tools: return an existing identical record (idempotency) so no new approval is needed. */
  precheck?: (input: z.output<S>, ctx: ToolContext) => Promise<ToolOutput | null>;
  execute: (input: z.output<S>, ctx: ToolContext) => Promise<ToolOutput> | ToolOutput;
}

/** Provider-neutral tool description sent to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
}

export interface RegisteredTool {
  spec: ToolSpec;
  sideEffect: 'read' | 'write';
  authorization: WriteAuthorization | null;
  /** Approval prompt content for raw model arguments (falls back to redacted arguments if invalid). */
  approvalPreview: (rawInput: unknown) => unknown;
  precheck: ((rawInput: unknown, ctx: ToolContext) => Promise<ToolOutput | null>) | null;
  /** Schema check without executing; returns a safe error message or null. */
  validate: (rawInput: unknown) => string | null;
  /** Validates raw model arguments, then executes. Throws ToolError on any failure. */
  run: (rawInput: unknown, ctx: ToolContext) => Promise<ToolOutput>;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema, { io: 'input' }) };
  delete json['$schema'];
  return json;
}

export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): RegisteredTool {
  return {
    spec: { name: def.name, description: def.description, inputJsonSchema: toJsonSchema(def.inputSchema) },
    sideEffect: def.sideEffect,
    authorization: def.sideEffect === 'write' ? def.authorization ?? { kind: 'approval' } : null,
    approvalPreview: (rawInput) => {
      const parsed = def.inputSchema.safeParse(rawInput ?? {});
      return parsed.success && def.approvalPreview ? def.approvalPreview(parsed.data) : redactValue(rawInput);
    },
    validate: (rawInput) => {
      const parsed = def.inputSchema.safeParse(rawInput ?? {});
      return parsed.success ? null : `Invalid arguments for ${def.name}: ${z.prettifyError(parsed.error)}`;
    },
    precheck: def.precheck
      ? async (rawInput, ctx) => {
        const parsed = def.inputSchema.safeParse(rawInput ?? {});
        return parsed.success && def.precheck ? def.precheck(parsed.data, ctx) : null;
      }
      : null,
    run: async (rawInput, ctx) => {
      const parsed = def.inputSchema.safeParse(rawInput ?? {});
      if (!parsed.success) {
        throw new ToolError('VALIDATION_ERROR', `Invalid arguments for ${def.name}: ${z.prettifyError(parsed.error)}`);
      }
      return def.execute(parsed.data, ctx);
    },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(...tools: RegisteredTool[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.spec.name)) throw new Error(`Duplicate tool name: ${tool.spec.name}`);
      this.tools.set(tool.spec.name, tool);
    }
    return this;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }
}
