import { randomUUID } from 'node:crypto';
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

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/**
 * Documented placeholder for functionCall parts that Gemini did not produce (e.g. turns served by the
 * fallback provider). Gemini 3 rejects function-call history without a signature (HTTP 400).
 */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/** JSON Schema keywords the generateContent `parameters` (OpenAPI subset) accepts; everything else is dropped. */
const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern',
]);

/** Converts Zod-generated JSON Schema into Gemini's OpenAPI-subset `parameters`. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value !== null && typeof value === 'object') {
      out['properties'] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === 'exclusiveMinimum' && typeof value === 'number' && !('minimum' in schema)) {
      out['minimum'] = value; // ".positive()" → closest supported bound; the server-side Zod check stays exact
    } else if (ALLOWED_SCHEMA_KEYS.has(key)) {
      out[key] = key === 'items' ? toGeminiSchema(value) : value;
    }
  }
  if (out['format'] !== undefined && !['enum', 'date-time', 'int32', 'int64', 'float', 'double'].includes(String(out['format']))) delete out['format'];
  return out;
}

const PartSchema = z.looseObject({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  thoughtSignature: z.string().optional(),
  functionCall: z.looseObject({ name: z.string(), args: z.record(z.string(), z.unknown()).optional(), id: z.string().optional() }).optional(),
});
const ResponseSchema = z.object({
  candidates: z.array(z.looseObject({
    content: z.looseObject({ role: z.string().optional(), parts: z.array(PartSchema).optional() }).optional(),
    finishReason: z.string().optional(),
  })).optional(),
  promptFeedback: z.looseObject({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z.looseObject({
    promptTokenCount: z.number().optional(),
    candidatesTokenCount: z.number().optional(),
    thoughtsTokenCount: z.number().optional(),
  }).optional(),
  modelVersion: z.string().optional(),
});
type Part = z.infer<typeof PartSchema>;

export interface GeminiOptions {
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  retry?: RetryPolicy;
  maxRetryWaitMs?: number;
}

function isGemini3(model: string): boolean {
  return /^gemini-([3-9]|\d{2,})/.test(model);
}

function parseResultContent(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.fromEntries(Object.entries(parsed));
    return { result: parsed };
  } catch {
    return { content };
  }
}

/**
 * Google Gemini (generateContent REST) adapter. Model turns produced by this model are replayed with
 * their original parts (thought signatures intact); other history is rebuilt from neutral blocks.
 */
export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini';
  readonly model: string;
  private readonly opts: GeminiOptions;

  constructor(opts: GeminiOptions) {
    this.opts = opts;
    this.model = opts.model;
  }

  private toContents(messages: ChatMessage[]): Array<{ role: 'user' | 'model'; parts: unknown[] }> {
    const callNames = new Map<string, string>();
    for (const m of messages) for (const b of m.content) if (b.type === 'tool_call') callNames.set(b.id, b.name);
    const contents: Array<{ role: 'user' | 'model'; parts: unknown[] }> = [];
    for (const m of messages) {
      let parts: unknown[];
      if (m.role === 'assistant') {
        const raw = m.content.find((b): b is Extract<ContentBlock, { type: 'opaque' }> => b.type === 'opaque' && b.provider === 'gemini' && b.model === this.model);
        const rawParts = raw ? z.object({ parts: z.array(z.unknown()) }).safeParse(raw.block) : null;
        if (rawParts?.success) {
          parts = rawParts.data.parts; // exactly as returned, signatures included
        } else {
          let signed = false;
          parts = m.content.flatMap((b): unknown[] => {
            if (b.type === 'text') return b.text ? [{ text: b.text }] : [];
            if (b.type !== 'tool_call') return [];
            const part: Record<string, unknown> = { functionCall: { name: b.name, args: b.input ?? {}, id: b.id } };
            if (!signed && isGemini3(this.model)) part['thoughtSignature'] = SKIP_THOUGHT_SIGNATURE;
            signed = true;
            return [part];
          });
        }
      } else {
        parts = m.content.flatMap((b): unknown[] => {
          if (b.type === 'text') return b.text ? [{ text: b.text }] : [];
          if (b.type === 'tool_result') {
            return [{ functionResponse: { name: callNames.get(b.toolCallId) ?? 'unknown_tool', id: b.toolCallId, response: parseResultContent(b.content) } }];
          }
          return [];
        });
      }
      if (parts.length === 0) continue;
      const role = m.role === 'assistant' ? 'model' : 'user';
      const last = contents.at(-1);
      // Merge consecutive same-role turns (contents, not parts: signed parts are never merged).
      if (last && last.role === role) last.parts.push(...parts);
      else contents.push({ role, parts });
    }
    return contents;
  }

  buildBody(request: CompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: this.toContents(request.messages),
    };
    if (request.tools.length > 0) {
      body['tools'] = [{
        functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.inputJsonSchema) })),
      }];
      body['toolConfig'] = { functionCallingConfig: { mode: request.toolChoice === 'none' ? 'NONE' : 'AUTO' } };
    }
    return body;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const raw = await postJsonWithRetry({
      fetchImpl: this.opts.fetchImpl ?? fetch,
      url: `${API_BASE}/${encodeURIComponent(this.model)}:generateContent`,
      headers: { 'x-goog-api-key': this.opts.apiKey },
      body: this.buildBody(request),
      signal: request.signal,
      providerName: `Gemini ${this.model}`,
      ...(this.opts.retry ? { retry: this.opts.retry } : {}),
      ...(this.opts.maxRetryWaitMs !== undefined ? { maxRetryWaitMs: this.opts.maxRetryWaitMs } : {}),
    });
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Gemini response did not match the expected shape');
    const res = parsed.data;
    const usage = {
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
    };
    const candidate = res.candidates?.[0];
    if (!candidate) {
      // Prompt blocked by safety filters → refusal, never an error message to the user.
      return { content: [], stopReason: res.promptFeedback?.blockReason ? 'refusal' : 'other', usage, model: this.model };
    }
    const parts: Part[] = candidate.content?.parts ?? [];
    const content: ContentBlock[] = [];
    for (const part of parts) {
      if (part.functionCall) {
        content.push({ type: 'tool_call', id: part.functionCall.id ?? `gc_${randomUUID().slice(0, 12)}`, name: part.functionCall.name, input: part.functionCall.args ?? {} });
      } else if (part.text && !part.thought) {
        content.push({ type: 'text', text: part.text });
      }
    }
    if (parts.length > 0) {
      // Keep the original parts, with generated call ids written back so tool results can reference them.
      let callIndex = 0;
      const calls = content.filter((b) => b.type === 'tool_call');
      const replayParts = parts.map((p) => {
        if (!p.functionCall) return p;
        const id = calls[callIndex++]?.id;
        return { ...p, functionCall: { ...p.functionCall, ...(id ? { id } : {}) } };
      });
      content.push({ type: 'opaque', provider: 'gemini', model: this.model, block: { parts: replayParts } });
    }
    return { content, stopReason: mapFinish(candidate.finishReason, content.some((b) => b.type === 'tool_call')), usage, model: this.model };
  }
}

function mapFinish(reason: string | undefined, hasCalls: boolean): StopReason {
  if (hasCalls && (reason === undefined || reason === 'STOP')) return 'tool_use';
  switch (reason) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'refusal';
    default:
      return 'other'; // e.g. MALFORMED_FUNCTION_CALL → runtime returns an honest "incomplete" fallback
  }
}
