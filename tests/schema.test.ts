import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { listMigrations, migrate } from '../server/src/db/migrate.ts';
import { createTestSql } from './pglite-sql.ts';

const sql = await createTestSql();

/** Deterministic 1024-dim unit-ish vector pointing mostly along one axis. */
function vec(axis: number, wobble = 0): string {
  const v = new Array<number>(1024).fill(0);
  v[axis] = 1;
  v[(axis + 1) % 1024] = wobble;
  return `[${v.join(',')}]`;
}

async function grantConsent(owner: string, purpose = 'long_term_memory'): Promise<string> {
  await sql.query('insert into public.customers (owner_id) values ($1) on conflict do nothing', [owner]);
  const [row] = await sql.query('insert into public.consents (owner_id, purpose, policy_version) values ($1, $2, $3) returning id', [owner, purpose, 'v1']);
  return z.object({ id: z.string() }).parse(row).id;
}

async function addMemory(owner: string, consentId: string, content: string, embedding: string | null, extra: Record<string, unknown> = {}) {
  await sql.query(
    `insert into public.memory_items (owner_id, consent_id, kind, category, content, purpose, embedding, embedding_model, deleted_at, expires_at)
     values ($1, $2, $3, $4, $5, 'travel_personalization', $6::extensions.vector, $7, $8, $9)`,
    [owner, consentId, extra['kind'] ?? 'preference', 'trip_style', content, embedding, embedding ? 'openai/text-embedding-3-small@1024' : null,
      extra['deleted_at'] ?? null, extra['expires_at'] ?? null],
  );
}

async function recall(owner: string, query: string): Promise<string[]> {
  const rows = await sql.query('select content from public.match_memory_items($1, $2::extensions.vector, $3, 10, 0.5)', [owner, query, 'openai/text-embedding-3-small@1024']);
  return rows.map((r) => String(r['content']));
}

test('migrations are idempotent and every table has RLS enabled', async () => {
  assert.deepEqual(await migrate(sql), []);
  assert.ok(listMigrations().length >= 1);
  const rows = await sql.query(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`);
  const withoutRls = rows.filter((r) => r['relrowsecurity'] !== true).map((r) => String(r['relname']));
  assert.deepEqual(withoutRls, []);
});

test('migrations recorded by Supabase under another version (same name) are not re-applied', async () => {
  const fresh = await createTestSql({ migrate: false });
  await fresh.exec(`
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations (version text primary key, name text);
    insert into supabase_migrations.schema_migrations values ('20990101000000', 'rahhal_core'), ('20990101000001', 'fk_indexes'), ('20990101000002', 'memory_audit');
  `);
  assert.deepEqual(await migrate(fresh), []);
  assert.equal((await fresh.query(`select to_regclass('public.packages') is null as absent`))[0]?.['absent'], true);
  await fresh.close();
});

test('every foreign key flagged by the Supabase advisor has a covering index', async () => {
  const rows = await sql.query(`
    select c.conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])`);
  assert.deepEqual(rows.map((r) => `${String(r['tbl'])}.${String(r['col'])}`), []);
});

test('pgvector recall is owner-scoped, consent-aware and skips deleted/expired/contact items', async () => {
  const consentA = await grantConsent('mem-a');
  const consentB = await grantConsent('mem-b');
  await addMemory('mem-a', consentA, 'يحب رحلات البحر', vec(1, 0.1));
  await addMemory('mem-a', consentA, 'deleted preference', vec(1, 0.2), { deleted_at: new Date().toISOString() });
  await addMemory('mem-a', consentA, 'expired preference', vec(1, 0.2), { expires_at: '2020-01-01T00:00:00Z' });
  await addMemory('mem-a', consentA, 'unrelated: likes desert', vec(500));
  await addMemory('mem-b', consentB, 'user B likes the sea too', vec(1));

  assert.deepEqual(await recall('mem-a', vec(1)), ['يحب رحلات البحر']);
  assert.deepEqual(await recall('mem-b', vec(1)), ['user B likes the sea too']);

  // Withdrawn consent → nothing is recalled.
  await sql.query('update public.consents set revoked_at = now() where id = $1', [consentA]);
  assert.deepEqual(await recall('mem-a', vec(1)), []);
});

test('contact details can never carry an embedding', async () => {
  const consent = await grantConsent('mem-c', 'contact_storage');
  await assert.rejects(addMemory('mem-c', consent, 'phone 010…', vec(3), { kind: 'contact' }));
  await addMemory('mem-c', consent, 'phone stored without vector', null, { kind: 'contact' });
});

test('only one active consent per owner and purpose', async () => {
  await grantConsent('mem-d');
  await assert.rejects(grantConsent('mem-d'));
});

test('deleting a customer erases their sessions, memories and traces (cascade)', async () => {
  const consent = await grantConsent('mem-e');
  await addMemory('mem-e', consent, 'to be erased', vec(7));
  await sql.query(`insert into public.conversations (id, owner_id) values ('conv_e', 'mem-e')`);
  await sql.query(`insert into public.messages (conversation_id, owner_id, seq, role, content) values ('conv_e', 'mem-e', 1, 'user', '[]')`);
  await sql.query(`insert into public.agent_runs (trace_id, conversation_id, owner_id, provider, model, status) values ('tr_e', 'conv_e', 'mem-e', 'p', 'm', 'completed')`);
  await sql.query(`delete from public.customers where owner_id = 'mem-e'`);
  for (const table of ['memory_items', 'conversations', 'messages', 'agent_runs', 'consents']) {
    const [row] = await sql.query(`select count(*)::int as n from public.${table} where owner_id = 'mem-e'`);
    assert.equal(row?.['n'], 0, table);
  }
});

test('purge_expired_data removes expired conversations', async () => {
  await sql.query(`insert into public.customers (owner_id) values ('mem-f')`);
  await sql.query(`insert into public.conversations (id, owner_id, expires_at) values ('conv_old', 'mem-f', now() - interval '1 day')`);
  await sql.query('select public.purge_expired_data()');
  assert.equal((await sql.query(`select 1 from public.conversations where id = 'conv_old'`)).length, 0);
});
