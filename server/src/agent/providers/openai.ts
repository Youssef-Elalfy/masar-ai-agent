import { z } from 'zod';
import { postJsonWithRetry, type RetryPolicy } from './http.ts';
import {
  ProviderError,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type FetchLike,
  type LLMProvider,
  type StopReason,
} from './types.ts';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

const ResponseSchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z
            .array(z.object({ id: z.string(), type: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
});

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint; Groq uses https://api.groq.com/openai/v1. */
  baseUrl?: string;
  /** Provider id used in traces ("openai", "groq"). */
  id?: string;
  fetchImpl?: FetchLike;
  retry?: RetryPolicy;
  maxRetryWaitMs?: number;
}

function toWire(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    if (m.role === 'assistant') {
      const toolCalls = m.content.flatMap((b) =>
        b.type === 'tool_call' ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
      );
      if (!text && toolCalls.length === 0) continue;
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolCallId, content: b.content });
      }
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

function mapStop(reason: string | null, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_use';
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/**
 * Chat Completions adapter for OpenAI-compatible APIs (Groq in the free-tier setup).
 * Not yet verified against a live API from this machine.
 */
export class OpenAIProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  private readonly opts: OpenAIOptions;

  constructor(opts: OpenAIOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.id = opts.id ?? 'openai';
  }

  buildBody(request: CompletionRequest): Record<string, unknown> {
    return {
      model: this.model,
      messages: toWire(request.system, request.messages),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputJsonSchema } })),
            ...(request.toolChoice === 'none' ? { tool_choice: 'none' } : {}),
          }
        : {}),
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const raw = await postJsonWithRetry({
      fetchImpl: this.opts.fetchImpl ?? fetch,
      url: `${this.opts.baseUrl ?? OPENAI_BASE_URL}/chat/completions`,
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      body: this.buildBody(request),
      signal: request.signal,
      providerName: this.id === 'openai' ? 'OpenAI' : `${this.id} ${this.model}`,
      ...(this.opts.retry ? { retry: this.opts.retry } : {}),
      ...(this.opts.maxRetryWaitMs !== undefined ? { maxRetryWaitMs: this.opts.maxRetryWaitMs } : {}),
    });
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'OpenAI response did not match the expected shape');
    const choice = parsed.data.choices[0];
    if (!choice) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'OpenAI returned no choices');
    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
    for (const call of choice.message.tool_calls ?? []) {
      try {
        content.push({ type: 'tool_call', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) as unknown });
      } catch {
        content.push({ type: 'tool_call', id: call.id, name: call.function.name, input: {}, inputError: 'Arguments were not valid JSON.' });
      }
    }
    const hasToolCalls = (choice.message.tool_calls ?? []).length > 0;
    return {
      content,
      stopReason: choice.message.refusal ? 'refusal' : mapStop(choice.finish_reason, hasToolCalls),
      model: parsed.data.model,
      usage: { inputTokens: parsed.data.usage?.prompt_tokens ?? 0, outputTokens: parsed.data.usage?.completion_tokens ?? 0 },
    };
  }
}
