import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ConsentStore, consentText } from '../server/src/memory/consent-store.ts';
import { ContextManager } from '../server/src/memory/context-manager.ts';
import { ConversationStore } from '../server/src/memory/conversation-store.ts';
import { MemoryService } from '../server/src/memory/memory-service.ts';
import type { CompletionResponse, ContentBlock } from '../server/src/agent/providers/types.ts';
import { HashEmbeddingProvider, ScriptedProvider, final, testApp } from './helpers.ts';
import { createTestSql } from './pglite-sql.ts';

const sql = await createTestSql();
const consents = new ConsentStore(sql);
const memory = new MemoryService(sql, consents, new HashEmbeddingProvider());
const conversations = new ConversationStore(sql);
const signal = new AbortController().signal;

const optIn = (owner: string) => consents.grant(owner, 'long_term_memory', { conversationId: null });
const events = async (owner: string) =>
  (await sql.query('select event, category, item_count from public.memory_events where owner_id = $1 order by id', [owner]))
    .map((r) => `${String(r['event'])}:${String(r['category'] ?? '')}:${String(r['item_count'] ?? '')}`);

test('H1: budgets typed with Arabic-Indic digits are saved (not mistaken for contact details)', async () => {
  await optIn('rf-h1');
  const saved = await memory.savePreference('rf-h1', { category: 'budget', content: 'ميزانيتي ٥٠٠٠ جنيه للفرد', conversationId: 'c' }, signal);
  assert.equal(saved.duplicate, false);
  await assert.rejects(memory.savePreference('rf-h1', { category: 'other', content: 'رقمي ٠١٠١٢٣٤٥٦٧٨', conversationId: 'c' }, signal));
});

test('H3: forgetting propagates to conversation summaries; summaries from before consent are never recalled', async () => {
  await optIn('rf-h3');
  await sql.query(`insert into public.conversations (id, owner_id) values ('conv-h3-old', 'rf-h3')`);
  await sql.query(
    `insert into public.conversation_summaries (conversation_id, owner_id, summary, covers_until_seq, created_at)
     values ('conv-h3-old', 'rf-h3', 'Customer budget 5000 EGP, wants Hurghada', 4, now() - interval '1 day')`,
  );
  // Summary predates the consent → not returned.
  assert.deepEqual((await memory.recall('rf-h3', undefined, 'conv-now', signal)).pastConversations, []);
  await sql.query(`update public.conversation_summaries set created_at = now() where conversation_id = 'conv-h3-old'`);
  assert.equal((await memory.recall('rf-h3', undefined, 'conv-now', signal)).pastConversations.length, 1);
  await memory.savePreference('rf-h3', { category: 'budget', content: '5000 EGP', conversationId: 'c' }, signal);
  await memory.forget('rf-h3', { kind: 'category', category: 'budget' });
  const [row] = await sql.query(`select count(*)::int as n from public.conversation_summaries where owner_id = 'rf-h3'`);
  assert.equal(row?.['n'], 0);
});

test('M7: one (latest) summary per earlier conversation', async () => {
  await optIn('rf-m7');
  await sql.query(`insert into public.conversations (id, owner_id) values ('conv-m7', 'rf-m7')`);
  await sql.query(
    `insert into public.conversation_summaries (conversation_id, owner_id, summary, covers_until_seq)
     values ('conv-m7', 'rf-m7', 'old version: budget 10000', 4), ('conv-m7', 'rf-m7', 'new version: budget 5000', 8)`,
  );
  const past = (await memory.recall('rf-m7', undefined, 'other', signal)).pastConversations;
  assert.deepEqual(past.map((p) => p.summary), ['new version: budget 5000']);
});

test('M4/M5: duplicates are not stored twice; a specific item can be replaced or forgotten by id', async () => {
  await optIn('rf-m45');
  const a = await memory.savePreference('rf-m45', { category: 'destination_interest', content: 'Luxor temples', conversationId: 'c' }, signal);
  const again = await memory.savePreference('rf-m45', { category: 'destination_interest', content: 'luxor  temples!', conversationId: 'c' }, signal);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, a.id);
  const nubia = await memory.savePreference('rf-m45', { category: 'destination_interest', content: 'Nubia', conversationId: 'c' }, signal);
  const replaced = await memory.savePreference('rf-m45', { category: 'destination_interest', content: 'Aswan and Nubia', conversationId: 'c', replacesItemId: nubia.id }, signal);
  assert.deepEqual(replaced.superseded, [nubia.id]);
  assert.deepEqual((await memory.list('rf-m45')).map((i) => i.content).sort(), ['Aswan and Nubia', 'Luxor temples']);
  assert.equal(await memory.forget('rf-m45', { kind: 'item', itemId: replaced.id }), 2, 'item and its superseded history');
  assert.deepEqual((await memory.list('rf-m45')).map((i) => i.content), ['Luxor temples']);
});

test('M6: consent decisions, saves and deletions are audited without content', async () => {
  await optIn('rf-m6');
  await memory.savePreference('rf-m6', { category: 'trip_style', content: 'beach', conversationId: 'c', traceId: 'tr_x' }, signal);
  await memory.forget('rf-m6', { kind: 'all' });
  await consents.revoke('rf-m6', 'long_term_memory');
  await consents.decline('rf-m6', 'conv-m6');
  assert.deepEqual(await events('rf-m6'), ['consent_granted::', 'memory_saved:trip_style:1', 'memory_forgotten:all:1', 'consent_revoked::0', 'consent_declined::']);
  assert.equal(await consents.declinedIn('rf-m6', 'conv-m6'), true);
  const columns = (await sql.query(`select column_name from information_schema.columns where table_name = 'memory_events'`)).map((r) => String(r['column_name']));
  assert.ok(!columns.includes('content'));
  const [prov] = await sql.query(`select source_trace_id from public.memory_items where owner_id = 'rf-m6'`);
  assert.equal(prov, undefined, 'item was deleted');
});

test('M3: saves keep provenance (trace id)', async () => {
  await optIn('rf-m3');
  await memory.savePreference('rf-m3', { category: 'trip_style', content: 'desert camping', conversationId: 'conv-m3', traceId: 'tr_prov' }, signal);
  const [row] = await sql.query(`select source_trace_id, source_conversation_id from public.memory_items where owner_id = 'rf-m3'`);
  assert.deepEqual([row?.['source_trace_id'], row?.['source_conversation_id']], ['tr_prov', 'conv-m3']);
});

test('M11: a save cannot land after consent was revoked (insert is guarded in SQL)', async () => {
  await optIn('rf-m11');
  await consents.revoke('rf-m11', 'long_term_memory');
  await assert.rejects(memory.savePreference('rf-m11', { category: 'trip_style', content: 'x y z', conversationId: 'c' }, signal));
  const [row] = await sql.query(`select count(*)::int as n from public.memory_items where owner_id = 'rf-m11'`);
  assert.equal(row?.['n'], 0);
});

test('M1: consent notice is server-fixed, versioned and discloses the embedding processor', () => {
  assert.match(consentText('en', 'openai/text-embedding-3-small@1024'), /OpenAI embeddings/);
  assert.doesNotMatch(consentText('en', null), /OpenAI/);
  assert.match(consentText('ar', null), /\/forget/);
});

test('erase-all removes every row of the customer across tables', async () => {
  await optIn('rf-erase');
  await memory.savePreference('rf-erase', { category: 'trip_style', content: 'family trips', conversationId: 'c' }, signal);
  await sql.query(`insert into public.conversations (id, owner_id) values ('conv-erase', 'rf-erase')`);
  await memory.eraseAll('rf-erase');
  for (const table of ['customers', 'consents', 'memory_items', 'conversations', 'memory_events']) {
    const [row] = await sql.query(`select count(*)::int as n from public.${table} where owner_id = 'rf-erase'`);
    assert.equal(row?.['n'], 0, table);
  }
});

test('purge removes an expired preference together with its history (no FK error, no resurrection)', async () => {
  await optIn('rf-purge');
  await memory.savePreference('rf-purge', { category: 'budget', content: '10000 EGP', conversationId: 'c' }, signal);
  await memory.savePreference('rf-purge', { category: 'budget', content: '7000 EGP', conversationId: 'c' }, signal);
  const current = await memory.savePreference('rf-purge', { category: 'budget', content: '5000 EGP', conversationId: 'c' }, signal);
  // One-level chains: both older rows point at the current one.
  const chain = await sql.query(`select superseded_by from public.memory_items where owner_id = 'rf-purge' and superseded_by is not null`);
  assert.ok(chain.length === 2 && chain.every((r) => r['superseded_by'] === current.id));
  await sql.query(`update public.memory_items set expires_at = now() - interval '1 minute' where id = $1`, [current.id]);
  await sql.query('select public.purge_expired_data()');
  const [row] = await sql.query(`select count(*)::int as n from public.memory_items where owner_id = 'rf-purge'`);
  assert.equal(row?.['n'], 0);
});

test('forget tool schema: a category with scope "all" is rejected (no silent delete-everything)', async () => {
  const app = await testApp(new ScriptedProvider(() => final('x')), {}, sql);
  const tool = app.registry.get('forget_customer_memory');
  assert.ok(tool);
  assert.equal(tool.spec.inputJsonSchema['type'], 'object');
  const ctx = { traceId: 't', conversationId: 'c', ownerId: 'rf-schema', now: new Date(), signal };
  await assert.rejects(tool.run({ scope: 'all', category: 'budget' }, ctx), /not allowed otherwise/);
  await assert.rejects(tool.run({ scope: 'item' }, ctx), /itemId is required/);
});

test('M2: after the customer declines, the system prompt says not to ask again in this conversation', async () => {
  const provider = new ScriptedProvider(() => final('تمام'));
  const app = await testApp(provider, {}, sql);
  const conv = await app.conversations.create('rf-decline');
  await app.consents.decline('rf-decline', conv);
  await app.runtime.runTurn({ conversationId: conv, ownerId: 'rf-decline', userText: 'اهلا' });
  assert.match(provider.requests[0]?.system ?? '', /declined memory in this conversation; do not ask again/);
});

test('H4 + M10: compaction still happens when the recent window is one long tool loop; bad summaries are discarded with backoff', async () => {
  const owner = 'rf-h4';
  const conv = await conversations.create(owner);
  const append = (role: 'user' | 'assistant', content: ContentBlock[]) => conversations.append(conv, owner, { role, content }, null);
  await append('user', [{ type: 'text', text: 'first question about Hurghada' }]);
  await append('assistant', [{ type: 'text', text: 'answer one' }]);
  await append('user', [{ type: 'text', text: 'second question with a long tool loop' }]);
  for (let i = 0; i < 6; i++) {
    await append('assistant', [{ type: 'tool_call', id: `t${i}`, name: 'search_company_packages', input: {} }]);
    await append('user', [{ type: 'tool_result', toolCallId: `t${i}`, content: 'x'.repeat(800), isError: false }]);
  }
  let calls = 0;
  let output = 'Sorry, I cannot summarize that.';
  const summarizer = new ScriptedProvider((): CompletionResponse => {
    calls++;
    return final(output);
  });
  const manager = new ContextManager({ sql, conversations, provider: summarizer, consents, embeddings: null, budget: { maxContextTokens: 600, keepRecentTokens: 400 } });

  // Unparseable summarizer output is discarded, then the conversation backs off (no retry on the next turn).
  const first = await manager.prepare(conv, owner, signal);
  assert.equal(first.summary, null);
  await manager.prepare(conv, owner, signal);
  assert.equal(calls, 1, 'backoff prevents an immediate retry');

  // A fresh manager (backoff cleared) with a valid summary compacts at the earlier clean turn start.
  output = JSON.stringify({ summary: 'Asked about Hurghada; got answer one.', activeTopic: 'Hurghada', offTopicThreadOpen: false, travelIntent: 'beach trip', openQuestions: [] });
  const fresh = new ContextManager({ sql, conversations, provider: summarizer, consents, embeddings: null, budget: { maxContextTokens: 600, keepRecentTokens: 400 } });
  const prepared = await fresh.prepare(conv, owner, signal);
  assert.ok(prepared.summary, 'summary created despite no clean start inside the keep window');
  const texts = prepared.messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])));
  assert.match(texts[0] ?? '', /^<conversation_summary/);
  assert.equal(texts[1], 'second question with a long tool loop');
  const Row = z.object({ n: z.coerce.number() });
  assert.equal(Row.parse((await sql.query('select count(*) as n from public.conversation_summaries where conversation_id = $1', [conv]))[0]).n, 1);
});
