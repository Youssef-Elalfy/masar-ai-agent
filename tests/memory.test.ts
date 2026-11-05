import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ConsentStore } from '../server/src/memory/consent-store.ts';
import { OpenAIEmbeddingProvider } from '../server/src/memory/embeddings.ts';
import { MemoryConsentError, MemoryContentError, MemoryService } from '../server/src/memory/memory-service.ts';
import type { FetchLike } from '../server/src/agent/providers/types.ts';
import { HashEmbeddingProvider } from './helpers.ts';
import { createTestSql } from './pglite-sql.ts';

const sql = await createTestSql();
const consents = new ConsentStore(sql);
const embedder = new HashEmbeddingProvider();
const semantic = new MemoryService(sql, consents, embedder);
const lexical = new MemoryService(sql, consents, null);
const signal = new AbortController().signal;

async function optIn(owner: string): Promise<void> {
  await consents.grant(owner, 'long_term_memory', { conversationId: null });
}

/** Profiles above 15 items are searched; smaller ones are returned whole. */
async function addFiller(service: MemoryService, owner: string, n = 16): Promise<void> {
  for (let i = 0; i < n; i++) {
    await service.savePreference(owner, { category: 'other', content: `filler note number ${i} about museums`, conversationId: 'c' }, signal);
  }
}

test('T036: nothing is saved without opt-in, and recall reports no_consent', async () => {
  await assert.rejects(semantic.savePreference('m-none', { category: 'trip_style', content: 'يحب البحر', conversationId: 'c' }, signal), MemoryConsentError);
  const recall = await semantic.recall('m-none', 'بحر', null, signal);
  assert.equal(recall.status, 'no_consent');
  assert.deepEqual(recall.items, []);
});

test('T037: opted-in preference is recalled in a LATER session (semantic, pgvector)', async () => {
  await optIn('m-a');
  await semantic.savePreference('m-a', { category: 'trip_style', content: 'Loves beach trips by the sea', conversationId: 'conv-1' }, signal);
  await semantic.savePreference('m-a', { category: 'destination_interest', content: 'Interested in Japan in summer', conversationId: 'conv-1' }, signal);
  await addFiller(semantic, 'm-a');
  const recall = await semantic.recall('m-a', 'sea beach', 'conv-2', signal);
  assert.equal(recall.status, 'ok');
  assert.equal(recall.retrieval, 'semantic');
  assert.equal(recall.items[0]?.content, 'Loves beach trips by the sea');
  assert.ok(recall.items.every((i) => i.content !== 'Interested in Japan in summer' || (i.similarity ?? 0) < (recall.items[0]?.similarity ?? 1)));
});

test('Arabic recall works lexically without an embedding provider', async () => {
  await optIn('m-ar');
  await lexical.savePreference('m-ar', { category: 'trip_style', content: 'بيحب رحلات البحر والغطس', conversationId: 'c' }, signal);
  await addFiller(lexical, 'm-ar');
  const recall = await lexical.recall('m-ar', 'رحلات البحر', null, signal);
  assert.equal(recall.retrieval, 'lexical');
  assert.deepEqual(recall.items.map((i) => i.content), ['بيحب رحلات البحر والغطس']);
});

test('T038: a correction supersedes the old single-valued preference (newest wins)', async () => {
  await optIn('m-b');
  await semantic.savePreference('m-b', { category: 'budget', content: 'Budget 10000 EGP per person', conversationId: 'c' }, signal);
  const corrected = await semantic.savePreference('m-b', { category: 'budget', content: 'Budget 5000 EGP per person', conversationId: 'c' }, signal);
  assert.equal(corrected.superseded.length, 1);
  const all = await semantic.recall('m-b', undefined, null, signal);
  assert.deepEqual(all.items.map((i) => i.content), ['Budget 5000 EGP per person']);
  // Multi-valued categories accumulate instead.
  await semantic.savePreference('m-b', { category: 'destination_interest', content: 'Luxor', conversationId: 'c' }, signal);
  await semantic.savePreference('m-b', { category: 'destination_interest', content: 'Nubia', conversationId: 'c' }, signal);
  assert.equal((await semantic.list('m-b')).filter((i) => i.category === 'destination_interest').length, 2);
});

test('contact details are refused as memory (they belong to consented CRM flows)', async () => {
  await optIn('m-c');
  for (const content of ['My number is 01012345678', 'رقمي ٠١٠١٢٣٤٥٦٧٨', 'mail me at a@b.com']) {
    await assert.rejects(semantic.savePreference('m-c', { category: 'other', content, conversationId: 'c' }, signal), MemoryContentError);
  }
});

test('T039: forget deletes for real; nothing is recalled afterwards', async () => {
  await optIn('m-d');
  await semantic.savePreference('m-d', { category: 'trip_style', content: 'desert camping', conversationId: 'c' }, signal);
  await semantic.savePreference('m-d', { category: 'budget', content: '7000 EGP', conversationId: 'c' }, signal);
  assert.equal(await semantic.forget('m-d', { kind: 'category', category: 'budget' }), 1);
  assert.deepEqual((await semantic.list('m-d')).map((i) => i.category), ['trip_style']);
  assert.equal(await semantic.forget('m-d', { kind: 'all' }), 1);
  assert.deepEqual((await semantic.recall('m-d', 'desert', null, signal)).items, []);
  const [row] = await sql.query(`select count(*)::int as n from public.memory_items where owner_id = 'm-d'`);
  assert.equal(row?.['n'], 0);
});

test('withdrawn consent erases memories and blocks further saves', async () => {
  await optIn('m-e');
  await semantic.savePreference('m-e', { category: 'trip_style', content: 'family beach holidays', conversationId: 'c' }, signal);
  const revoked = await consents.revoke('m-e', 'long_term_memory');
  assert.deepEqual(revoked, { revoked: true, deletedMemories: 1 });
  assert.equal((await semantic.recall('m-e', 'beach', null, signal)).status, 'no_consent');
  await assert.rejects(semantic.savePreference('m-e', { category: 'trip_style', content: 'x', conversationId: 'c' }, signal), MemoryConsentError);
  // Re-opting in starts empty.
  await optIn('m-e');
  assert.deepEqual(await semantic.list('m-e'), []);
});

test('T047: cross-user isolation — user B never sees user A memories', async () => {
  await optIn('iso-a');
  await optIn('iso-b');
  await semantic.savePreference('iso-a', { category: 'trip_style', content: 'Secret preference: luxury sea resorts', conversationId: 'c' }, signal);
  const recallB = await semantic.recall('iso-b', 'luxury sea resorts', null, signal);
  assert.deepEqual(recallB.items, []);
  assert.deepEqual(await semantic.list('iso-b'), []);
});

test('embedding outage degrades to lexical storage/recall with a warning, not a failure', async () => {
  await optIn('m-f');
  embedder.failNext = true;
  const saved = await semantic.savePreference('m-f', { category: 'trip_style', content: 'snorkeling in the red sea', conversationId: 'c' }, signal);
  assert.match(saved.warnings.join(' '), /Embedding service unavailable/);
  const recall = await semantic.recall('m-f', 'snorkeling red sea', null, signal);
  assert.deepEqual(recall.items.map((i) => i.content), ['snorkeling in the red sea']);
});

test('OpenAI embeddings adapter: request shape, ordering and dimension check', async () => {
  const calls: unknown[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push(JSON.parse(String(init.body)) as unknown);
    const vec = (n: number) => new Array<number>(1024).fill(n);
    return new Response(JSON.stringify({ data: [{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }] }), { status: 200 });
  };
  const provider = new OpenAIEmbeddingProvider({ apiKey: 'k', model: 'text-embedding-3-small', fetchImpl });
  assert.equal(provider.label, 'openai/text-embedding-3-small@1024');
  const out = await provider.embed(['a', 'b'], signal);
  assert.deepEqual(out.map((v) => v[0]), [1, 2]);
  assert.deepEqual(z.object({ model: z.string(), input: z.array(z.string()), dimensions: z.number() }).parse(calls[0]), {
    model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 1024,
  });
  const bad: FetchLike = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 });
  await assert.rejects(new OpenAIEmbeddingProvider({ apiKey: 'k', model: 'm', fetchImpl: bad }).embed(['a'], signal));
});
