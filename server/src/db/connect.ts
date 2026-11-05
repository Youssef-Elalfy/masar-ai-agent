import type { AppConfig } from '../config.ts';
import { createPgSql } from './pg-sql.ts';
import type { Sql } from './sql.ts';

export const DATABASE_URL_HELP =
  'DATABASE_URL is not set. In the Supabase dashboard for project "rahhal-ai-agent" open Connect → Connection string (Session pooler), ' +
  'paste it into .env as DATABASE_URL with your database password. Never commit .env.';

/** Opens the configured Supabase Postgres database, or returns why it cannot. */
export function connectDatabase(config: AppConfig): { sql: Sql } | { error: string } {
  if (!config.databaseUrl) return { error: DATABASE_URL_HELP };
  return { sql: createPgSql(config.databaseUrl) };
}
