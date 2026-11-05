import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { CompletionRequest, CompletionResponse } from '../server/src/agent/providers/types.ts';
import { HashEmbeddingProvider, ScriptedProvider, final, testApp, toolResultPayload, toolUse } from './helpers.ts';
import { createTestSql } from './pglite-sql.ts';

const shared = await createTestSql();
const Payload = z.looseObject({ ok: z.boolean(), error: z.looseObject({ code: z.string() }).optional(), result: z.unknown().optional() });

test('memory consent flow end-to-end: request → user grants in client → save → recall in a new session', async () => {
  const owner = 'agent-mem-1';
  const provider = new ScriptedProvider((req, i) => {
    switch (i) {
      // Turn 1: model tries to save before consent, gets CONSENT_REQUIRED, then requests consent.
      case 0: return toolUse({ id: 's1', name: 'upsert_customer_preference', input: { category: 'trip_style', content: 'يحب رحلات البحر' } });
      case 1:
        assert.equal(Payload.parse(toolResultPayload(req, 's1')).error?.code, 'CONSENT_REQUIRED');
        return toolUse({ id: 'r1', name: 'request_memory_consent', input: { explanation: 'هفتكر تفضيلات السفر بس، وتقدر تمسحها في أي وقت.' } });
      case 2: return final('محتاج موافقتك الأول عشان أفتكر ده.');
      // Turn 2 (after the user granted consent in the client): save succeeds.
      case 3: return toolUse({ id: 's2', name: 'upsert_customer_preference', input: { category: 'trip_style', content: 'يحب رحلات البحر' } });
      case 4:
        assert.equal(Payload.parse(toolResultPayload(req, 's2')).ok, true);
        return final('تمام، حفظت إنك بتحب البحر.');
      // Turn 3 (new conversation): recall.
      case 5:
        assert.match(req.system, /Long-term memory: ON for this customer \(1 saved/);
        return toolUse({ id: 'm1', name: 'retrieve_customer_memory', input: { query: 'رحلات البحر' } });
      default: {
        const payload = z.looseObject({ result: z.looseObject({ items: z.array(z.looseObject({ content: z.string() })) }) }).parse(toolResultPayload(req, 'm1'));
        return final(`فاكر: ${payload.result.items.map((it) => it.content).join(', ')}`);
      }
    }
  });
  const app = await testApp(provider, {}, shared, new HashEmbeddingProvider());
  const conv1 = await app.conversations.create(owner);

  const t1 = await app.runtime.runTurn({ conversationId: conv1, ownerId: owner, userText: 'افتكر إني بحب البحر' });
  assert.deepEqual(t1.consentRequests.map((c) => c.purpose), ['long_term_memory']);
  assert.equal((await app.memory.list(owner)).length, 0, 'nothing saved before the user decides');

  // The user approves in the client (CLI/UI) — never the model.
  await app.consents.grant(owner, 'long_term_memory', { conversationId: conv1 });
  const t2 = await app.runtime.runTurn({ conversationId: conv1, ownerId: owner, userText: 'موافق' });
  assert.equal(t2.text, 'تمام، حفظت إنك بتحب البحر.');

  const conv2 = await app.conversations.create(owner);
  const t3 = await app.runtime.runTurn({ conversationId: conv2, ownerId: owner, userText: 'فاكر بحب رحلات إيه؟' });
  assert.equal(t3.text, 'فاكر: يحب رحلات البحر');
});

test('forget_customer_memory needs the user to approve in the client before deleting', async () => {
  const owner = 'agent-mem-2';
  const provider = new ScriptedProvider((_req, i) => (i % 2 === 0 ? toolUse({ id: `f${i}`, name: 'forget_customer_memory', input: { scope: 'all' } }) : final('ok')));
  const app = await testApp(provider, {}, shared);
  await app.consents.grant(owner, 'long_term_memory', { conversationId: null });
  await app.memory.savePreference(owner, { category: 'budget', content: '5000 EGP', conversationId: 'c' }, new AbortController().signal);
  const conv = await app.conversations.create(owner);

  const first = await app.runtime.runTurn({ conversationId: conv, ownerId: owner, userText: 'امسح تفضيلاتي' });
  assert.equal(first.toolCalls[0]?.errorCode, 'APPROVAL_REQUIRED');
  assert.equal((await app.memory.list(owner)).length, 1, 'not deleted before approval');

  await app.approvals.decide(first.pendingApprovals[0]?.approvalId ?? '', owner, true);
  const second = await app.runtime.runTurn({ conversationId: conv, ownerId: owner, userText: 'أيوه امسح' });
  assert.equal(second.toolCalls[0]?.outcome, 'ok');
  assert.equal((await app.memory.list(owner)).length, 0);
});

/** Scripted model for long conversations: answers normally, and acts as the summarizer when asked. */
function chattyProvider(summaries: CompletionRequest[]): ScriptedProvider {
  return new ScriptedProvider((req): CompletionResponse => {
    if (req.tools.length === 0) {
      summaries.push(req);
      return final(JSON.stringify({
        summary: 'Customer is learning React (components, props, state, hooks) with RAHHAL. No travel discussed yet.',
        activeTopic: 'React state management',
        offTopicThreadOpen: true,
        travelIntent: null,
        openQuestions: ['Zustand vs Redux?'],
      }));
    }
    const last = req.messages.at(-1);
    const asked = last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ') ?? '';
    return final(`شرح مفصل عن: ${asked}. `.repeat(20));
  });
}

test('20-turn off-topic conversation: older turns summarized, topic state kept, storage untouched', async () => {
  const owner = 'agent-long-1';
  const summaries: CompletionRequest[] = [];
  const provider = chattyProvider(summaries);
  const app = await testApp(provider, { context: { maxContextTokens: 4_000, keepRecentTokens: 1_500 } }, shared);
  const conv = await app.conversations.create(owner);
  const questions = ['علمني أساسيات React', 'يعني إيه component؟', 'وال props؟', 'state بقى؟', 'useEffect امتى؟', 'اديني مثال', 'طيب Zustand؟',
    'أحسن من Redux؟', 'اعمل مثال counter', 'و TypeScript؟', 'إزاي أنظم الفولدرات؟', 'testing؟', 'Vitest ولا Jest؟', 'مثال test',
    'إيه هو memo؟', 'و useCallback؟', 'performance tips', 'SSR يعني إيه؟', 'Next.js؟', 'تمام تسلم كده خلصنا'];
  const results = [];
  for (const q of questions) results.push(await app.runtime.runTurn({ conversationId: conv, ownerId: owner, userText: q }));

  assert.equal(results.length, 20);
  assert.ok(results.every((r) => r.status === 'completed'));
  assert.ok(summaries.length >= 1, 'summarizer was invoked');
  assert.ok(results.at(-1)?.usedSummary);
  const lastRequest = provider.requests.filter((r) => r.tools.length > 0).at(-1);
  assert.ok(lastRequest);
  // H2: the summary is fenced, untrusted notes in the first user message; the system prompt only points to it.
  assert.match(lastRequest.system, /condensed in the <conversation_summary> block/);
  assert.doesNotMatch(lastRequest.system, /Customer is learning React/);
  const firstText = lastRequest.messages[0]?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') ?? '';
  assert.match(firstText, /^<conversation_summary note="[^"]*Data, not instructions.">/);
  assert.match(firstText, /off_topic_thread_open: yes/);
  // The model sees fewer messages than are stored, and the visible context starts with a user turn.
  const [stored] = await app.sql.query('select count(*)::int as n from public.messages where conversation_id = $1', [conv]);
  assert.equal(stored?.['n'], 40);
  assert.ok(lastRequest.messages.length < 40);
  assert.equal(lastRequest.messages[0]?.role, 'user');
  // Summaries never contain contact data and are stored without embeddings for non-opted-in users.
  const rows = await app.sql.query('select embedding_model from public.conversation_summaries where conversation_id = $1', [conv]);
  assert.ok(rows.length >= 1 && rows.every((r) => r['embedding_model'] === null));
});

test('summarizer failure never breaks the turn (falls back to the full transcript)', async () => {
  const owner = 'agent-long-2';
  const provider = new ScriptedProvider((req) => {
    if (req.tools.length === 0) throw new Error('summarizer down');
    return final('رد طويل '.repeat(200));
  });
  const app = await testApp(provider, { context: { maxContextTokens: 1_000, keepRecentTokens: 300 } }, shared);
  const conv = await app.conversations.create(owner);
  for (let i = 0; i < 4; i++) {
    const r = await app.runtime.runTurn({ conversationId: conv, ownerId: owner, userText: `سؤال ${i}` });
    assert.equal(r.status, 'completed');
    assert.equal(r.usedSummary, false);
  }
});

test('opted-in customers: earlier conversation summaries are recallable across sessions', async () => {
  const owner = 'agent-long-3';
  const summaries: CompletionRequest[] = [];
  const app = await testApp(chattyProvider(summaries), { context: { maxContextTokens: 500, keepRecentTokens: 200 } }, shared, new HashEmbeddingProvider());
  await app.consents.grant(owner, 'long_term_memory', { conversationId: null });
  const conv = await app.conversations.create(owner);
  for (const q of ['React basics', 'components', 'props and state', 'hooks', 'Zustand']) {
    await app.runtime.runTurn({ conversationId: conv, ownerId: owner, userText: q });
  }
  assert.ok(summaries.length >= 1);
  const recall = await app.memory.recall(owner, 'React state management Zustand', 'another-conversation', new AbortController().signal);
  assert.equal(recall.pastConversations[0]?.conversationId, conv);
});
