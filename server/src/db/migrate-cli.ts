import { loadConfig, loadDotEnv } from '../config.ts';
import { connectDatabase } from './connect.ts';
import { listMigrations, migrate } from './migrate.ts';

// Applies supabase/migrations/*.sql to DATABASE_URL. Versions already applied through the
// Supabase MCP/CLI are detected and skipped.
loadDotEnv();
const db = connectDatabase(loadConfig());
if ('error' in db) {
  console.error(db.error);
  process.exit(1);
}
try {
  const applied = await migrate(db.sql);
  console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : `Up to date (${listMigrations().length} migration file(s)).`);
} finally {
  await db.sql.close();
}
