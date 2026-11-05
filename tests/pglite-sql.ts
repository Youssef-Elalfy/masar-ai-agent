import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { migrate } from '../server/src/db/migrate.ts';
import type { Row, Sql } from '../server/src/db/sql.ts';

/** TEST-ONLY: in-process Postgres 18 + pgvector + pg_trgm, migrated with the real supabase/migrations files. */
export async function createTestSql(opts: { migrate?: boolean } = {}): Promise<Sql> {
  const db = await PGlite.create({ extensions: { vector, pg_trgm } });
  const wrap = (q: PGlite | Transaction, inTx: boolean): Sql => {
    const self: Sql = {
      query: async (text, params = []) => (await q.query<Row>(text, [...params])).rows,
      exec: async (script) => {
        await q.exec(script);
      },
      transaction: async (fn) => (inTx ? fn(self) : db.transaction((tx) => fn(wrap(tx, true)))),
      close: async () => {
        if (!inTx) await db.close();
      },
    };
    return self;
  };
  const sql = wrap(db, false);
  if (opts.migrate !== false) await migrate(sql);
  return sql;
}
