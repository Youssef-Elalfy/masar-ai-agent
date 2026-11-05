import pg from 'pg';
import type { Row, Sql } from './sql.ts';

function wrapClient(client: pg.PoolClient): Sql {
  const self: Sql = {
    query: async (text, params = []) => (await client.query<Row>(text, [...params])).rows,
    exec: async (script) => {
      await client.query(script);
    },
    // Nested transactions reuse the outer one.
    transaction: async (fn) => fn(self),
    close: async () => undefined,
  };
  return self;
}

/**
 * node-postgres pool for Supabase (use the pooler connection string from the Supabase dashboard).
 * An idle connection dropped by the network or the pooler makes the pool emit "error"; without a listener Node
 * treats that as an unhandled error and the whole server process exits. The listener logs the error code only
 * (never the connection string) and the pool replaces the connection on the next query.
 */
export function createPool(connectionString: string, opts: { max?: number; log?: (message: string) => void } = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  const log = opts.log ?? ((message: string) => console.warn(message));
  pool.on('error', (err: Error & { code?: string }) => log(`[db] idle connection error (${err.code ?? err.name}); it will be replaced on the next query`));
  return pool;
}

export function createPgSql(connectionString: string, opts: { max?: number } = {}): Sql {
  const pool = createPool(connectionString, opts);
  return {
    query: async (text, params = []) => (await pool.query<Row>(text, [...params])).rows,
    exec: async (script) => {
      await pool.query(script);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('begin');
        const result = await fn(wrapClient(client));
        await client.query('commit');
        return result;
      } catch (err) {
        // If even the rollback fails the connection is unusable: destroy it instead of returning it to the pool.
        await client.query('rollback').catch(() => {
          broken = true;
        });
        throw err;
      } finally {
        client.release(broken);
      }
    },
    close: async () => {
      await pool.end();
    },
  };
}
