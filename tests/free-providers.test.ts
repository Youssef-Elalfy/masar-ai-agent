import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { FallbackProvider, RateLimiter, RateLimitedProvider, type FallbackEvent } from '../server/src/agent/providers/fallback.ts';
import { GeminiProvider, SKIP_THOUGHT_SIGNATURE, toGeminiSchema } from '../server/src/agent/providers/gemini.ts';
import { parseRateLimitBody } from '../server/src/agent/providers/http.ts';
import { GROQ_BASE_URL, OpenAIProvider } from '../server/src/agent/providers/openai.ts';
import { ProviderError, type ChatMessage, type CompletionRequest, type FetchLike } from '../server/src/agent/providers/types.ts';
import { GeminiEmbeddingProvider } from '../server/src/memory/embeddings.ts';
import { GroqWhisper, readAudioFile, VoiceInputError } from '../server/src/voice/stt.ts';
import { ScriptedProvider, final, testApp } from './helpers.ts';

const FAST = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };
const signal = new AbortController().signal;
const tools = [{
  name: 'search_company_packages',
  description: 'd',
  inputJsonSchema: {
    type: 'object', additionalProperties: false,
    properties: { maxPricePerPerson: { type: 'number', exclusiveMinimum: 0 }, query: { type: 'string', maxLength: 200 }, id: { type: 'string', format: 'uuid' } },
  },
}];
const req = (messages: ChatMessage[], toolChoice: 'auto' | 'none' = 'auto'): CompletionRequest => ({ system: 'SYS', messages, tools, toolChoice, signal });

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const impl: FetchLike = async (url, init) => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
    calls.push({ url, headers: z.record(z.string(), z.string()).parse(init.headers), body });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status, headers: next.headers ?? {} });
  };
  return { impl, calls };
}

const Body = z.looseObject({
  systemInstruction: z.unknown(),
  contents: z.array(z.object({ role: z.string(), parts: z.array(z.looseObject({})) })),
  tools: z.array(z.object({ functionDeclarations: z.array(z.looseObject({ name: z.string(), parameters: z.unknown() })) })).optional(),
  toolConfig: z.object({ functionCallingConfig: z.object({ mode: z.string() }) }).optional(),
});

test('Gemini: schema is converted to the OpenAPI subset (no additionalProperties/$schema; exclusiveMinimum → minimum)', () => {
  assert.deepEqual(toGeminiSchema(tools[0]?.inputJsonSchema), {
    type: 'object',
    properties: { maxPricePerPerson: { type: 'number', minimum: 0 }, query: { type: 'string', maxLength: 200 }, id: { type: 'string' } },
  });
});

test('Gemini: request shape, key header, NONE mode on the last step', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: { candidates: [{ content: { role: 'model', parts: [{ text: 'تمام' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } } }]);
  const gemini = new GeminiProvider({ apiKey: 'g-key', model: 'gemini-3.8-flash', fetchImpl: impl, retry: FAST });
  const res = await gemini.complete(req([{ role: 'user', content: [{ type: 'text', text: 'اهلا' }] }], 'none'));
  assert.equal(res.stopReason, 'end_turn');
  assert.deepEqual(res.content[0], { type: 'text', text: 'تمام' });
  assert.equal(calls[0]?.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(calls[0]?.headers['x-goog-api-key'], 'g-key');
  const body = Body.parse(calls[0]?.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'SYS' }] });
  assert.equal(body.toolConfig?.functionCallingConfig.mode, 'NONE');
  assert.equal(body.tools?.[0]?.functionDeclarations[0]?.name, 'search_company_packages');
});

test('Gemini: function calls round-trip with thought signatures replayed exactly; results carry name + id', async () => {
  const { impl, calls } = fakeFetch([
    { status: 200, body: { candidates: [{ content: { role: 'model', parts: [
      { functionCall: { name: 'search_company_packages', args: { query: 'Hurghada' } }, thoughtSignature: 'SIG-1' },
      { functionCall: { name: 'list_company_destinations', args: {} } },
    ] }, finishReason: 'STOP' }] } },
    { status: 200, body: { candidates: [{ content: { parts: [{ text: '6500 جنيه (DEMO)' }] }, finishReason: 'STOP' }] } },
  ]);
  const gemini = new GeminiProvider({ apiKey: 'k', model: 'gemini-3.8-flash', fetchImpl: impl, retry: FAST });
  const history: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'بكام الغردقة؟' }] }];
  const first = await gemini.complete(req(history));
  assert.equal(first.stopReason, 'tool_use');
  const calls1 = first.content.flatMap((b) => (b.type === 'tool_call' ? [b] : []));
  assert.equal(calls1.length, 2);
  history.push({ role: 'assistant', content: first.content });
  history.push({ role: 'user', content: calls1.map((c) => ({ type: 'tool_result', toolCallId: c.id, content: '{"ok":true,"price":6500}', isError: false })) });
  await gemini.complete(req(history));
  const second = Body.parse(calls[1]?.body);
  const modelTurn = second.contents[1];
  assert.equal(modelTurn?.role, 'model');
  assert.equal(modelTurn?.parts[0]?.['thoughtSignature'], 'SIG-1', 'signature replayed unchanged');
  assert.equal(modelTurn?.parts[1]?.['thoughtSignature'], undefined, 'parallel calls: only the first part carries it');
  const responses = second.contents[2]?.parts.map((p) => z.object({ functionResponse: z.object({ name: z.string(), id: z.string(), response: z.unknown() }) }).parse(p).functionResponse);
  assert.deepEqual(responses?.map((r) => r.name), ['search_company_packages', 'list_company_destinations']);
  assert.deepEqual(responses?.map((r) => r.id), calls1.map((c) => c.id));
  assert.deepEqual(responses?.[0]?.response, { ok: true, price: 6500 });
});

test('Gemini: history produced by another provider gets the documented skip signature on the first call only', () => {
  const gemini = new GeminiProvider({ apiKey: 'k', model: 'gemini-3.8-flash' });
  const body = Body.parse(gemini.buildBody(req([
    { role: 'user', content: [{ type: 'text', text: 'x' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'groq_1', name: 'a', input: {} }, { type: 'tool_call', id: 'groq_2', name: 'b', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'groq_1', content: '{}', isError: false }, { type: 'tool_result', toolCallId: 'groq_2', content: 'plain', isError: false }] },
  ])));
  assert.deepEqual(body.contents[1]?.parts.map((p) => p['thoughtSignature']), [SKIP_THOUGHT_SIGNATURE, undefined]);
  assert.deepEqual(z.looseObject({ functionResponse: z.looseObject({ response: z.unknown() }) }).parse(body.contents[2]?.parts[1]).functionResponse.response, { content: 'plain' });
});

test('Gemini: safety blocks become refusals; consecutive user turns are merged', async () => {
  const { impl } = fakeFetch([
    { status: 200, body: { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] } },
    { status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } },
  ]);
  const gemini = new GeminiProvider({ apiKey: 'k', model: 'gemini-3.5-flash-lite', fetchImpl: impl });
  assert.equal((await gemini.complete(req([{ role: 'user', content: [{ type: 'text', text: 'a' }] }]))).stopReason, 'refusal');
  assert.equal((await gemini.complete(req([{ role: 'user', content: [{ type: 'text', text: 'a' }] }]))).stopReason, 'refusal');
  const merged = Body.parse(gemini.buildBody(req([{ role: 'user', content: [{ type: 'text', text: 'summary' }] }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }])));
  assert.equal(merged.contents.length, 1);
  assert.equal(merged.contents[0]?.parts.length, 2);
});

test('free-tier 429: per-day quota fails fast (no retries) with quota scope; per-minute retries', async () => {
  const dayBody = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }] } });
  assert.deepEqual(parseRateLimitBody(dayBody), { retryAfterMs: 41_000, quotaScope: 'day' });
  const day = fakeFetch([{ status: 429, body: dayBody }]);
  const g1 = new GeminiProvider({ apiKey: 'k', model: 'gemini-3.8-flash', fetchImpl: day.impl, retry: FAST });
  await assert.rejects(g1.complete(req([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])), (e: unknown) => e instanceof ProviderError && e.quotaScope === 'day');
  assert.equal(day.calls.length, 1);
  const minuteBody = JSON.stringify({ error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { retryDelay: '0s' }] } });
  const minute = fakeFetch([{ status: 429, body: minuteBody }, { status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }]);
  const g2 = new GeminiProvider({ apiKey: 'k', model: 'gemini-3.8-flash', fetchImpl: minute.impl, retry: FAST });
  assert.equal((await g2.complete(req([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]))).stopReason, 'end_turn');
  assert.equal(minute.calls.length, 2);
});

test('Groq adapter: OpenAI-compatible endpoint and provider id', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: { model: 'llama-3.3-70b-versatile', choices: [{ finish_reason: 'stop', message: { content: 'أهلاً' } }] } }]);
  const groq = new OpenAIProvider({ apiKey: 'q', model: 'llama-3.3-70b-versatile', id: 'groq', baseUrl: GROQ_BASE_URL, fetchImpl: impl });
  const res = await groq.complete(req([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
  assert.equal(groq.id, 'groq');
  assert.equal(calls[0]?.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(calls[0]?.headers['authorization'], 'Bearer q');
  assert.deepEqual(res.content[0], { type: 'text', text: 'أهلاً' });
});

test('fallback: primary rate-limited → secondary serves; primary cools down; bad requests are not spread', async () => {
  let now = new Date('2026-11-03T12:00:00Z');
  const events: FallbackEvent[] = [];
  const primary = new ScriptedProvider(() => {
    throw new ProviderError('PROVIDER_RATE_LIMIT', 'Gemini rate limit (429, minute quota)', { quotaScope: 'minute', retryAfterMs: 20_000 });
  });
  const secondary = new ScriptedProvider(() => final('from groq'));
  const chain = new FallbackProvider([primary, secondary], { clock: () => now, onFallback: (e) => events.push(e) });
  assert.equal((await chain.complete(req([]))).content[0]?.type, 'text');
  await chain.complete(req([]));
  assert.equal(primary.requests.length, 1, 'primary skipped while cooling down');
  assert.equal(secondary.requests.length, 2);
  assert.equal(events[0]?.cooldownMs, 30_000);
  now = new Date(now.getTime() + 31_000);
  await chain.complete(req([]));
  assert.equal(primary.requests.length, 2, 'primary retried after the cooldown');

  const bad = new FallbackProvider([
    new ScriptedProvider(() => { throw new ProviderError('PROVIDER_BAD_REQUEST', 'bad'); }),
    secondary,
  ]);
  await assert.rejects(bad.complete(req([])), (e: unknown) => e instanceof ProviderError && e.code === 'PROVIDER_BAD_REQUEST');
});

test('fallback: an exhausted daily quota cools down until the Pacific-midnight reset', async () => {
  const now = new Date('2026-11-03T20:00:00Z'); // 12:00 in Los Angeles
  const events: FallbackEvent[] = [];
  const chain = new FallbackProvider([
    new ScriptedProvider(() => { throw new ProviderError('PROVIDER_RATE_LIMIT', 'daily', { quotaScope: 'day' }); }),
    new ScriptedProvider(() => final('ok')),
  ], { clock: () => now, onFallback: (e) => events.push(e) });
  await chain.complete(req([]));
  assert.equal(events[0]?.cooldownMs, 12 * 3_600_000);
});

test('local rate limiter: paces per minute and enforces a daily cap', async () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const limiter = new RateLimiter({ rpm: 2, rpd: 3 }, () => now);
  await limiter.acquire(signal, 0, 'gemini');
  await assert.rejects(limiter.acquire(signal, 0, 'gemini'), (e: unknown) => e instanceof ProviderError && e.quotaScope === 'minute');
  const capped = new RateLimiter({ rpm: 1000, rpd: 2 }, () => now);
  await capped.acquire(signal, 1_000, 'g');
  await capped.acquire(signal, 1_000, 'g');
  await assert.rejects(capped.acquire(signal, 1_000, 'g'), (e: unknown) => e instanceof ProviderError && e.quotaScope === 'day');
  const limited = new RateLimitedProvider(new ScriptedProvider(() => final('x')), new RateLimiter({ rpm: 1, rpd: null }, () => now), 0);
  await limited.complete(req([]));
  await assert.rejects(limited.complete(req([])));
});

test('runtime + fallback chain: a rate-limited primary does not fail the customer turn', async () => {
  const chain = new FallbackProvider([
    new ScriptedProvider(() => { throw new ProviderError('PROVIDER_RATE_LIMIT', 'busy', { quotaScope: 'minute' }); }),
    new ScriptedProvider(() => final('أهلاً! أقدر أساعدك في إيه؟')),
  ]);
  const app = await testApp(chain);
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create('fb-owner'), ownerId: 'fb-owner', userText: 'اهلا' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'أهلاً! أقدر أساعدك في إيه؟');
});

test('Gemini embeddings: task type per purpose, 1024 dims requested, vectors normalized, wrong size rejected', async () => {
  const raw = new Array<number>(1024).fill(0).map((_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));
  const { impl, calls } = fakeFetch([{ status: 200, body: { embedding: { values: raw } } }, { status: 200, body: { embedding: { values: raw } } }]);
  const e = new GeminiEmbeddingProvider({ apiKey: 'k', model: 'gemini-embedding-001', fetchImpl: impl });
  assert.equal(e.label, 'gemini/gemini-embedding-001@1024');
  const [doc] = await e.embed(['يحب البحر'], signal, 'document');
  await e.embed(['بحر'], signal, 'query');
  assert.deepEqual([doc?.[0], doc?.[1]], [0.6, 0.8]);
  const Req = z.object({ taskType: z.string(), outputDimensionality: z.number(), content: z.object({ parts: z.array(z.object({ text: z.string() })) }) });
  assert.deepEqual(calls.map((c) => Req.parse(c.body).taskType), ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY']);
  assert.equal(Req.parse(calls[0]?.body).outputDimensionality, 1024);
  assert.equal(calls[0]?.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent');
  const bad = fakeFetch([{ status: 200, body: { embedding: { values: [1, 2, 3] } } }]);
  await assert.rejects(new GeminiEmbeddingProvider({ apiKey: 'k', model: 'gemini-embedding-001', fetchImpl: bad.impl }).embed(['x'], signal));
});

test('voice: audio files are validated before upload (format, empty)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rahhal-voice-'));
  const txt = path.join(dir, 'note.txt');
  await writeFile(txt, 'not audio');
  await assert.rejects(readAudioFile(txt), (e: unknown) => e instanceof VoiceInputError && e.code === 'UNSUPPORTED_FORMAT');
  const empty = path.join(dir, 'empty.ogg');
  await writeFile(empty, '');
  await assert.rejects(readAudioFile(empty), (e: unknown) => e instanceof VoiceInputError && e.code === 'EMPTY');
  await assert.rejects(readAudioFile(path.join(dir, 'missing.ogg')), (e: unknown) => e instanceof VoiceInputError && e.code === 'NOT_FOUND');
  const ok = path.join(dir, 'note.ogg');
  await writeFile(ok, new Uint8Array([1, 2, 3]));
  assert.equal((await readAudioFile(ok)).filename, 'note.ogg');
});

test('voice: Groq Whisper multipart request and low-confidence detection', async () => {
  let captured: FormData | null = null;
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    if (init.body instanceof FormData) captured = init.body;
    return new Response(JSON.stringify({ text: ' عايز الغردقة بسبعة آلاف ', language: 'arabic', duration: 3.2, segments: [{ avg_logprob: -1.4, no_speech_prob: 0.01 }] }), { status: 200 });
  };
  const whisper = new GroqWhisper({ apiKey: 'q', model: 'whisper-large-v3-turbo', fetchImpl });
  const t = await whisper.transcribe({ bytes: new Uint8Array([1, 2, 3]), filename: 'note.ogg' }, signal);
  assert.equal(t.text, 'عايز الغردقة بسبعة آلاف');
  assert.equal(t.lowConfidence, true);
  const form = z.instanceof(FormData).parse(captured);
  assert.equal(form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(form.get('response_format'), 'verbose_json');
  assert.ok(String(form.get('prompt')).includes('الغردقة'));
});

test('fallback: a primary that hangs (e.g. overloaded) is abandoned after its per-call budget; the next model answers', async () => {
  const events: FallbackEvent[] = [];
  const hanging = new ScriptedProvider((r) => new Promise((_, reject) => {
    r.signal.addEventListener('abort', () => reject(new ProviderError('PROVIDER_TIMEOUT', 'aborted')), { once: true });
  }));
  const chain = new FallbackProvider([hanging, new ScriptedProvider(() => final('from flash-lite'))], { perCallTimeoutMs: 50, onFallback: (e) => events.push(e) });
  const started = Date.now();
  const res = await chain.complete({ ...req([]), signal: AbortSignal.timeout(5_000) });
  assert.deepEqual(res.content[0], { type: 'text', text: 'from flash-lite' });
  assert.ok(Date.now() - started < 2_000);
  assert.match(events[0]?.reason ?? '', /did not answer within 50 ms/);
  assert.equal(events[0]?.cooldownMs, 60_000);
});

test('live regression: the primary gets a short budget, fallbacks a longer one (flash-lite needs ~21 s for the full prompt)', async () => {
  const hangs = (model: string) => ({
    id: 'gemini', model,
    complete: (req: CompletionRequest) => new Promise<never>((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  });
  const slowButAnswers = {
    id: 'gemini', model: 'lite',
    complete: (req: CompletionRequest) => new Promise<import('../server/src/agent/providers/types.ts').CompletionResponse>((resolve, reject) => {
      const t = setTimeout(() => resolve({ content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'lite' }), 120);
      req.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    }),
  };
  const events: FallbackEvent[] = [];
  const chain = new FallbackProvider([hangs('primary'), slowButAnswers], { primaryCallTimeoutMs: 40, perCallTimeoutMs: 400, onFallback: (e) => events.push(e) });
  const started = Date.now();
  const res = await chain.complete({ system: 's', messages: [], tools: [], toolChoice: 'auto', signal: AbortSignal.timeout(5_000) });
  assert.equal(res.model, 'lite', 'the slower fallback was allowed to finish');
  assert.ok(Date.now() - started < 400, 'the hanging primary was abandoned after its short budget');
  assert.match(events[0]?.reason ?? '', /did not answer within 40 ms/);
});
