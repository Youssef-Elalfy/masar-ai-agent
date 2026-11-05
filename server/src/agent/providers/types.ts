import type { ToolSpec } from '../../tools/registry.ts';

/** Provider-neutral conversation content. Stored append-only in the messages table. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; inputError?: string | undefined }
  | { type: 'tool_result'; toolCallId: string; content: string; isError: boolean }
  /** Provider-specific block (e.g. Anthropic thinking) replayed unchanged to the same provider/model only. */
  | { type: 'opaque'; provider: string; model: string; block: unknown };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** 'none' forces a text answer (used on the last allowed step); tools stay declared for history validity. */
  toolChoice?: 'auto' | 'none';
  signal: AbortSignal;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface CompletionResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

export type ProviderErrorCode =
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_BAD_REQUEST'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_BAD_RESPONSE';

/** Which free-tier quota a 429 refers to: per-minute limits recover soon, daily ones only after the reset. */
export type QuotaScope = 'minute' | 'day' | null;

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly quotaScope: QuotaScope;
  constructor(code: ProviderErrorCode, message: string, opts: { status?: number; retryable?: boolean; retryAfterMs?: number | null; quotaScope?: QuotaScope } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.quotaScope = opts.quotaScope ?? null;
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
