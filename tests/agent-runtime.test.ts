import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ProviderError, type CompletionResponse } from '../server/src/agent/providers/types.ts';
import { ConversationAccessError } from '../server/src/memory/conversation-store.ts';
import { defineTool } from '../server/src/tools/registry.ts';
import { ScriptedProvider, final, testApp as freshApp, toolResultPayload, toolUse } from './helpers.ts';
import { createTestSql } from './pglite-sql.ts';
import type { AppConfig } from '../server/src/config.ts';
import type { LLMProvider } from '../server/src/agent/providers/types.ts';

// One migrated Postgres for this file; every test uses its own conversations.
const shared = await createTestSql();
const testApp = (provider: LLMProvider, overrides: Partial<AppConfig> = {}) => freshApp(provider, overrides, shared);

const OWNER = 'user-a';
const Payload = z.looseObject({
  ok: z.boolean(),
  error: z.looseObject({ code: z.string(), details: z.looseObject({ approvalId: z.string() }).optional() }).optional(),
  result: z.unknown().optional(),
});

/** Every tool_call in a transcript must be answered by the next user message. */
function assertNoDanglingToolCalls(messages: Array<{ role: string; content: Array<{ type: string; id?: string | undefined; toolCallId?: string | undefined }> }>) {
  messages.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    const ids = m.content.flatMap((b) => (b.type === 'tool_call' && b.id ? [b.id] : []));
    if (ids.length === 0) return;
    const answered = new Set((messages[i + 1]?.content ?? []).flatMap((b) => (b.type === 'tool_result' && b.toolCallId ? [b.toolCallId] : [])));
    assert.deepEqual(ids.filter((id) => !answered.has(id)), [], `unanswered tool calls after message ${i}`);
  });
}

test('multi-step turn: parallel catalog tools → grounded final answer, persisted and traced in Postgres', async () => {
  const provider = new ScriptedProvider((req, i) => {
    if (i === 0) {
      return toolUse(
        { id: 'c1', name: 'list_company_destinations', input: {} },
        { id: 'c2', name: 'search_company_packages', input: { sortBy: 'price_asc' } },
      );
    }
    const payload = z.looseObject({ result: z.looseObject({ packages: z.array(z.looseObject({ id: z.string(), pricing: z.looseObject({ perPerson: z.number() }) })) }) })
      .parse(toolResultPayload(req, 'c2'));
    const cheapest = payload.result.packages[0];
    return final(`أرخص رحلة: ${cheapest?.id} بسعر ${cheapest?.pricing.perPerson} جنيه (DEMO)`);
  });
  const app = await testApp(provider);
  const conv = await app.conversations.create(OWNER);
  const result = await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'إيه البرامج اللي عندكم؟ أرخص رحلة كام؟' });

  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 2);
  assert.equal(result.text, 'أرخص رحلة: pkg-fayoum-001 بسعر 3200 جنيه (DEMO)');
  assert.deepEqual(result.toolCalls.map((t) => [t.name, t.outcome, t.sourceType]).sort(), [
    ['list_company_destinations', 'ok', 'company_demo'],
    ['search_company_packages', 'ok', 'company_demo'],
  ]);
  assert.equal(provider.requests[0]?.tools.length, 14);
  assert.equal(provider.requests[0]?.toolChoice, 'auto');
  const stored = await app.conversations.load(conv, OWNER);
  assert.deepEqual(stored.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  const traced = await app.tracer.toolExecutions(result.traceId);
  assert.equal(traced.length, 2);
  assert.ok(traced.every((t) => t.step === 1 && t.outcome === 'ok'));
  const [run] = await app.sql.query('select status, steps, input_tokens, owner_id from public.agent_runs where trace_id = $1', [result.traceId]);
  assert.deepEqual([run?.['status'], run?.['steps'], run?.['input_tokens'], run?.['owner_id']], ['completed', 2, 220, OWNER]);
});

test('history carries across turns (follow-up sees earlier context)', async () => {
  const provider = new ScriptedProvider((_req, i) => final(i === 0 ? 'أول رد' : 'تاني رد'));
  const app = await testApp(provider);
  const conv = await app.conversations.create(OWNER);
  await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'قارن النوبة والغردقة' });
  await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'طب التانية فيها بحر؟' });
  assert.deepEqual(provider.requests[1]?.messages.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('invalid tool arguments go back to the model as VALIDATION_ERROR and it can recover', async () => {
  const provider = new ScriptedProvider((req, i) => {
    if (i === 0) return toolUse({ id: 'bad', name: 'search_company_packages', input: { maxDays: 'four' } });
    if (i === 1) {
      assert.equal(Payload.parse(toolResultPayload(req, 'bad')).error?.code, 'VALIDATION_ERROR');
      return toolUse({ id: 'good', name: 'search_company_packages', input: { maxDays: 4 } });
    }
    return final('done');
  });
  const app = await testApp(provider);
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create(OWNER), ownerId: OWNER, userText: 'عايز trip 4 days' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.toolCalls.map((t) => t.outcome), ['error', 'ok']);
});

test('unknown tool names are refused, not executed', async () => {
  const provider = new ScriptedProvider((req, i) => {
    if (i === 0) return toolUse({ id: 'x', name: 'book_flight_now', input: {} });
    assert.equal(Payload.parse(toolResultPayload(req, 'x')).error?.code, 'UNKNOWN_TOOL');
    return final('مش متاح');
  });
  const app = await testApp(provider);
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create(OWNER), ownerId: OWNER, userText: 'احجزلي' });
  assert.equal(result.toolCalls[0]?.errorCode, 'UNKNOWN_TOOL');
});

test('last step forces a text answer from gathered data (tool_choice none) instead of wasting it', async () => {
  const provider = new ScriptedProvider((req, i) =>
    req.toolChoice === 'none' ? final('ده اللي لقيته في الكتالوج') : toolUse({ id: `l${i}`, name: 'list_company_destinations', input: {} }));
  const app = await testApp(provider, { maxAgentSteps: 3 });
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create(OWNER), ownerId: OWNER, userText: 'loop' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'ده اللي لقيته في الكتالوج');
  assert.deepEqual(provider.requests.map((r) => r.toolChoice), ['auto', 'auto', 'none']);
  assert.equal(result.toolCalls.length, 2);
});

test('a model that ignores tool_choice none hits max_steps with no dangling tool call stored', async () => {
  const provider = new ScriptedProvider((_req, i) => toolUse({ id: `loop${i}`, name: 'list_company_destinations', input: {} }));
  const app = await testApp(provider, { maxAgentSteps: 2 });
  const conv = await app.conversations.create(OWNER);
  const result = await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'كرر البحث' });
  assert.equal(result.status, 'max_steps');
  assert.match(result.text, /معلش/);
  const rows = await app.sql.query('select role, content from public.messages where conversation_id = $1 order by seq', [conv]);
  assertNoDanglingToolCalls(z.array(z.object({ role: z.string(), content: z.array(z.looseObject({ type: z.string(), id: z.string().optional(), toolCallId: z.string().optional() })) })).parse(rows));
});

test('C1: truncated tool call (max_tokens) is not executed and leaves a valid transcript', async () => {
  const truncated: CompletionResponse = { ...toolUse({ id: 't1', name: 'search_company_packages', input: { query: 'Hur' } }), stopReason: 'max_tokens' };
  const provider = new ScriptedProvider((req, i) => {
    if (i === 1) {
      // Next turn: the provider sees the earlier tool call answered by a synthetic error result.
      assert.equal(Payload.parse(toolResultPayload(req, 't1')).error?.code, 'NOT_EXECUTED');
      return final('تمام');
    }
    return truncated;
  });
  const app = await testApp(provider);
  const conv = await app.conversations.create(OWNER);
  const first = await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'الغردقة' });
  assert.equal(first.status, 'max_tokens');
  assert.equal(first.toolCalls.length, 0);
  const second = await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'طيب؟' });
  assert.equal(second.status, 'completed');
});

test('empty final text gets a fallback in the user language', async () => {
  const app = await testApp(new ScriptedProvider(() => final('')));
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create(OWNER), ownerId: OWNER, userText: 'hello there' });
  assert.equal(result.status, 'empty_response');
  assert.match(result.text, /^Sorry/);
});

test('provider failures become an honest message, never a stack trace', async () => {
  const provider = new ScriptedProvider(() => {
    throw new ProviderError('PROVIDER_RATE_LIMIT', 'Anthropic rate limit (429)', { status: 429, retryable: true });
  });
  const app = await testApp(provider);
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create(OWNER), ownerId: OWNER, userText: 'هاي' });
  assert.equal(result.status, 'provider_error');
  assert.equal(result.errorCode, 'PROVIDER_RATE_LIMIT');
  assert.doesNotMatch(result.text, /429|Error|at /);
});

test('concurrent turns on one conversation are serialized (no interleaved history)', async () => {
  const provider = new ScriptedProvider(async (_req, i) => {
    if (i % 2 === 0) {
      await delay(20);
      return toolUse({ id: `p${i}`, name: 'list_company_destinations', input: {} });
    }
    return final(`done ${i}`);
  });
  const app = await testApp(provider);
  const conv = await app.conversations.create(OWNER);
  const results = await Promise.all([
    app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'one' }),
    app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'two' }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['completed', 'completed']);
  const roles = (await app.conversations.load(conv, OWNER)).map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
});

const writeTool = (counter: { n: number }) => defineTool({
  name: 'create_test_record',
  description: 'test-only write tool',
  inputSchema: z.object({ note: z.string(), phone: z.string().optional() }),
  sideEffect: 'write',
  execute: (_input, ctx) => {
    counter.n++;
    return { sourceType: 'system', summary: `written with ${ctx.approvalId ?? 'none'}`, result: { id: 'rec_1' } };
  },
});

test('H6: write tools need a user approval bound to the exact arguments, and it is single-use', async () => {
  const counter = { n: 0 };
  const args = { note: 'quote for Fayoum', phone: '01012345678' };
  const app = await testApp(new ScriptedProvider((_req, i) => (i % 2 === 0 ? toolUse({ id: `w${i}`, name: 'create_test_record', input: args }) : final('ok'))));
  app.registry.register(writeTool(counter));
  const conv = await app.conversations.create(OWNER);

  const first = await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'save' });
  assert.equal(first.toolCalls[0]?.errorCode, 'APPROVAL_REQUIRED');
  assert.equal(counter.n, 0);
  const [pending] = first.pendingApprovals;
  assert.ok(pending);
  assert.deepEqual(pending.argsPreview, { note: 'quote for Fayoum', phone: '[REDACTED]' });

  // Another owner cannot approve it; the real owner can.
  assert.equal(await app.approvals.decide(pending.approvalId, 'user-b', true), false);
  assert.equal(await app.approvals.decide(pending.approvalId, OWNER, true), true);

  const second = await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'go on' });
  assert.equal(second.toolCalls[0]?.outcome, 'ok');
  assert.equal(counter.n, 1);

  // Approval consumed: the same call needs a fresh approval.
  const third = await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'again' });
  assert.equal(third.toolCalls[0]?.errorCode, 'APPROVAL_REQUIRED');
  assert.equal(counter.n, 1);

  // Trace stores only key names + hash for write inputs.
  const [traced] = await app.tracer.toolExecutions(second.traceId);
  assert.deepEqual(z.looseObject({ keys: z.array(z.string()) }).parse(traced?.inputRedacted).keys, ['note', 'phone']);
});

test('approval for one set of arguments does not authorize different arguments', async () => {
  const counter = { n: 0 };
  let input: unknown = { note: 'A' };
  const app = await testApp(new ScriptedProvider((_req, i) => (i % 2 === 0 ? toolUse({ id: `w${i}`, name: 'create_test_record', input }) : final('ok'))));
  app.registry.register(writeTool(counter));
  const conv = await app.conversations.create(OWNER);
  const first = await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'save A' });
  await app.approvals.decide(first.pendingApprovals[0]?.approvalId ?? '', OWNER, true);
  input = { note: 'B' };
  const second = await app.runtime.runTurn({ conversationId: conv, ownerId: OWNER, userText: 'save B instead' });
  assert.equal(second.toolCalls[0]?.errorCode, 'APPROVAL_REQUIRED');
  assert.equal(counter.n, 0);
});

test('slow tools time out with TOOL_TIMEOUT', async () => {
  const slow = defineTool({
    name: 'slow_lookup', description: 'test-only', inputSchema: z.object({}), sideEffect: 'read',
    execute: async () => {
      await delay(500);
      return { sourceType: 'system', summary: 'late', result: {} };
    },
  });
  const app = await testApp(new ScriptedProvider((_r, i) => (i === 0 ? toolUse({ id: 's', name: 'slow_lookup', input: {} }) : final('x'))), { toolTimeoutMs: 50 });
  app.registry.register(slow);
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create(OWNER), ownerId: OWNER, userText: 'go' });
  assert.equal(result.toolCalls[0]?.errorCode, 'TOOL_TIMEOUT');
});

test('trace inputs and summaries are redacted; listeners never see raw input', async () => {
  const echo = defineTool({
    name: 'echo_contact', description: 'test-only', inputSchema: z.object({ customerName: z.string(), notes: z.string() }), sideEffect: 'read',
    execute: (input) => ({ sourceType: 'system', summary: `noted ${input.notes}`, result: {} }),
  });
  const app = await testApp(new ScriptedProvider((_r, i) =>
    i === 0 ? toolUse({ id: 'e', name: 'echo_contact', input: { customerName: 'Ahmed', notes: 'call ٠١٠١٢٣٤٥٦٧٨ or a@b.com' } }) : final('x')));
  app.registry.register(echo);
  const seen: string[] = [];
  app.tracer.onEvent((e) => seen.push(JSON.stringify(e)));
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create(OWNER), ownerId: OWNER, userText: 'x' });
  const [row] = await app.tracer.toolExecutions(result.traceId);
  assert.deepEqual(row?.inputRedacted, { customerName: '[REDACTED]', notes: 'call [REDACTED_PHONE] or [REDACTED_EMAIL]' });
  assert.equal(row?.resultSummary, 'noted call [REDACTED_PHONE] or [REDACTED_EMAIL]');
  assert.ok(seen.every((s) => !s.includes('Ahmed') && !s.includes('a@b.com')));
});

test('conversations are isolated per owner with one indistinguishable error', async () => {
  const app = await testApp(new ScriptedProvider(() => final('x')));
  const conv = await app.conversations.create('user-a');
  await assert.rejects(app.runtime.runTurn({ conversationId: conv, ownerId: 'user-b', userText: 'show me user A history' }), ConversationAccessError);
  await assert.rejects(app.runtime.runTurn({ conversationId: 'conv_missing', ownerId: 'user-b', userText: 'x' }), ConversationAccessError);
});
