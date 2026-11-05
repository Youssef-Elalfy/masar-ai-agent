import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AnthropicProvider } from '../server/src/agent/providers/anthropic.ts';
import { OpenAIProvider } from '../server/src/agent/providers/openai.ts';
import { ProviderError, type ChatMessage, type CompletionRequest, type FetchLike } from '../server/src/agent/providers/types.ts';

const FAST_RETRY = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };
const tools = [{ name: 'search_company_packages', description: 'd', inputJsonSchema: { type: 'object', properties: {} } }];

function request(messages: ChatMessage[]): CompletionRequest {
  return { system: 'SYS', messages, tools, signal: new AbortController().signal };
}

/** Fake fetch that records calls and replays queued responses. */
function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: z.record(z.string(), z.string()).parse(init.headers), body: JSON.parse(String(init.body)) as unknown });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers ?? {} });
  };
  return { impl, calls };
}

const history: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'بكام الغردقة؟' }] },
  {
    role: 'assistant',
    content: [
      { type: 'opaque', provider: 'anthropic', model: 'claude-opus-5-5', block: { type: 'thinking', thinking: '', signature: 'sig' } },
      { type: 'opaque', provider: 'anthropic', model: 'claude-haiku-5-5', block: { type: 'thinking', thinking: '', signature: 'other' } },
      { type: 'tool_call', id: 'toolu_1', name: 'search_company_packages', input: { query: 'Hurghada' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', toolCallId: 'toolu_1', content: '{"ok":true}', isError: false }] },
];

test('Anthropic: request body, headers and history translation', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '6500 جنيه' }], usage: { input_tokens: 10, output_tokens: 5 } } }]);
  const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-opus-5-5', effort: 'medium', fetchImpl: impl });
  const res = await provider.complete(request(history));
  assert.equal(res.stopReason, 'end_turn');
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers['x-api-key'], 'test-key');
  assert.equal(call.headers['anthropic-version'], '2026-10-21');
  assert.equal(call.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  const body = z.looseObject({
    system: z.string(), fallbacks: z.string(), output_config: z.object({ effort: z.string() }),
    tools: z.array(z.looseObject({ name: z.string(), input_schema: z.unknown() })),
    messages: z.array(z.object({ role: z.string(), content: z.array(z.looseObject({ type: z.string() })) })),
  }).parse(call.body);
  assert.equal(body.system, 'SYS');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.tools[0]?.name, 'search_company_packages');
  assert.ok('input_schema' in (body.tools[0] ?? {}));
  // Thinking from this model is replayed; thinking from another model is dropped.
  assert.deepEqual(body.messages[1]?.content.map((b) => b.type), ['thinking', 'tool_use']);
  assert.deepEqual(body.messages[2]?.content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}', is_error: false });
  assert.equal('temperature' in body, false);
});

test('Anthropic: no fallbacks field for models without server-side fallback', () => {
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-5-5', effort: 'low' });
  assert.equal('fallbacks' in provider.buildBody(request(history)), false);
});

test('Anthropic: response blocks keep order; thinking stays opaque; tool_use becomes tool_call', async () => {
  const { impl } = fakeFetch([{
    status: 200,
    body: {
      model: 'claude-opus-5-5', stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '', signature: 's1' },
        { type: 'text', text: 'هراجع الكتالوج' },
        { type: 'tool_use', id: 'toolu_9', name: 'search_company_packages', input: { query: 'Nubia' } },
      ],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
    },
  }]);
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', effort: 'medium', fetchImpl: impl });
  const res = await provider.complete(request([{ role: 'user', content: [{ type: 'text', text: 'النوبة' }] }]));
  assert.deepEqual(res.content.map((b) => b.type), ['opaque', 'text', 'tool_call']);
  assert.deepEqual(res.content[2], { type: 'tool_call', id: 'toolu_9', name: 'search_company_packages', input: { query: 'Nubia' } });
  assert.equal(res.stopReason, 'tool_use');
  assert.equal(res.usage.inputTokens, 150);
});

test('Anthropic: retries 429 (honoring retry-after) then succeeds', async () => {
  const ok = { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
  const { impl, calls } = fakeFetch([
    { status: 429, body: { error: 'rate' }, headers: { 'retry-after': '0' } },
    { status: 529, body: { error: 'overloaded' } },
    { status: 200, body: ok },
  ]);
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-5-5', effort: 'low', fetchImpl: impl, retry: FAST_RETRY });
  const res = await provider.complete(request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
  assert.equal(calls.length, 3);
  assert.equal(res.content[0]?.type, 'text');
});

test('Anthropic: 401 is not retried and maps to PROVIDER_AUTH', async () => {
  const { impl, calls } = fakeFetch([{ status: 401, body: { error: 'auth' } }]);
  const provider = new AnthropicProvider({ apiKey: 'bad', model: 'claude-haiku-5-5', effort: 'low', fetchImpl: impl, retry: FAST_RETRY });
  await assert.rejects(provider.complete(request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])), (err: unknown) =>
    err instanceof ProviderError && err.code === 'PROVIDER_AUTH');
  assert.equal(calls.length, 1);
});

test('Anthropic: persistent 429 surfaces PROVIDER_RATE_LIMIT after bounded retries', async () => {
  const { impl, calls } = fakeFetch([0, 1, 2].map(() => ({ status: 429, body: {} })));
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-5-5', effort: 'low', fetchImpl: impl, retry: FAST_RETRY });
  await assert.rejects(provider.complete(request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])), (err: unknown) =>
    err instanceof ProviderError && err.code === 'PROVIDER_RATE_LIMIT');
  assert.equal(calls.length, 3);
});

test('OpenAI: history → chat messages with tool_calls and tool role; opaque blocks dropped', () => {
  const provider = new OpenAIProvider({ apiKey: 'k', model: 'test-model' });
  const body = z.looseObject({
    messages: z.array(z.looseObject({ role: z.string() })),
    tools: z.array(z.looseObject({ type: z.literal('function'), function: z.looseObject({ name: z.string(), parameters: z.unknown() }) })),
  }).parse(provider.buildBody(request(history)));
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.deepEqual(body.messages[2], {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'search_company_packages', arguments: '{"query":"Hurghada"}' } }],
  });
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: '{"ok":true}' });
  assert.equal(body.tools[0]?.function.name, 'search_company_packages');
});

test('OpenAI: tool calls parsed; malformed JSON arguments flagged instead of crashing', async () => {
  const { impl, calls } = fakeFetch([{
    status: 200,
    body: {
      model: 'test-model',
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_package_details', arguments: '{"package":"Fayoum"}' } },
        { id: 'call_2', type: 'function', function: { name: 'get_package_details', arguments: '{bad json' } },
      ] } }],
      usage: { prompt_tokens: 30, completion_tokens: 7 },
    },
  }]);
  const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'test-model', fetchImpl: impl });
  const res = await provider.complete(request([{ role: 'user', content: [{ type: 'text', text: 'الفيوم' }] }]));
  assert.equal(calls[0]?.headers['authorization'], 'Bearer sk-test');
  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(res.content[0], { type: 'tool_call', id: 'call_1', name: 'get_package_details', input: { package: 'Fayoum' } });
  const second = res.content[1];
  assert.ok(second?.type === 'tool_call' && second.inputError);
  assert.deepEqual(res.usage, { inputTokens: 30, outputTokens: 7 });
});
