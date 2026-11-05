import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../server/src/db/pg-sql.ts';

test('an idle-connection error on the Postgres pool is handled (it used to crash the server process)', async () => {
  const logs: string[] = [];
  // Nothing connects until a query runs, so a placeholder URL is enough to build the pool.
  const pool = createPool('postgres://user:example-placeholder@127.0.0.1:1/db', { log: (m) => logs.push(m) });
  assert.equal(pool.listenerCount('error'), 1);
  const err = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
  assert.doesNotThrow(() => pool.emit('error', err));
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? '', /ECONNRESET/);
  assert.doesNotMatch(logs[0] ?? '', /example-placeholder|postgres:\/\//, 'the connection string is never logged');
  await pool.end();
});
