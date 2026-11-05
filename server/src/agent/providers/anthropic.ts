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

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];

const ResponseSchema = z.object({
  model: z.string(),
  stop_reason: z.string().nullable(),
  content: z.array(z.looseObject({ type: z.string() })),
  usage: z.looseObject({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
  }),
});
const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() });

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  fetchImpl?: FetchLike;
  retry?: RetryPolicy;
}

function toWire(messages: ChatMessage[], model: string): unknown[] {
  return messages
    .map((m) => ({
      role: m.role,
      content: m.content.flatMap((b): unknown[] => {
        switch (b.type) {
          case 'text':
            return b.text ? [{ type: 'text', text: b.text }] : [];
          case 'tool_call':
            return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }];
          case 'tool_result':
            return [{ type: 'tool_result', tool_use_id: b.toolCallId, content: b.content, is_error: b.isError }];
          case 'opaque':
            // Thinking/fallback blocks go back unchanged, and only to the model that produced them.
            return b.provider === 'anthropic' && b.model === model ? [b.block] : [];
        }
      }),
    }))
    .filter((m) => m.content.length > 0);
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly model: string;
  private readonly opts: AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    this.opts = opts;
    this.model = opts.model;
  }

  buildBody(request: CompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.opts.maxTokens ?? 16_000,
      system: request.system,
      messages: toWire(request.messages, this.model),
      output_config: { effort: this.opts.effort },
    };
    if (request.tools.length > 0) {
      body['tools'] = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputJsonSchema }));
      if (request.toolChoice === 'none') body['tool_choice'] = { type: 'none' };
    }
    if (FALLBACK_MODELS.includes(this.model)) body['fallbacks'] = 'default';
    return body;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const headers: Record<string, string> = { 'x-api-key': this.opts.apiKey, 'anthropic-version': API_VERSION };
    if (FALLBACK_MODELS.includes(this.model)) headers['anthropic-beta'] = FALLBACK_BETA;
    const raw = await postJsonWithRetry({
      fetchImpl: this.opts.fetchImpl ?? fetch,
      url: API_URL,
      headers,
      body: this.buildBody(request),
      signal: request.signal,
      providerName: 'Anthropic',
      ...(this.opts.retry ? { retry: this.opts.retry } : {}),
    });
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Anthropic response did not match the expected shape');
    const res = parsed.data;
    const content: ContentBlock[] = res.content.map((block): ContentBlock => {
      const text = TextBlock.safeParse(block);
      if (text.success) return { type: 'text', text: text.data.text };
      const tool = ToolUseBlock.safeParse(block);
      if (tool.success) return { type: 'tool_call', id: tool.data.id, name: tool.data.name, input: tool.data.input };
      // Stamp the model that served the turn (a refusal fallback may differ from the requested model).
      return { type: 'opaque', provider: 'anthropic', model: res.model, block };
    });
    return {
      content,
      stopReason: mapStop(res.stop_reason),
      model: res.model,
      usage: {
        inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
        outputTokens: res.usage.output_tokens,
      },
    };
  }
}
