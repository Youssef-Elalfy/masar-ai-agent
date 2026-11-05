import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.ts';
import type { Sql } from './sql.ts';

export const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'supabase', 'migrations');

export interface Migration {
  version: string;
  name: string;
  sql: string;
}

export function listMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort()
    .map((file) => ({ version: file.slice(0, 14), name: file.slice(15, -4), sql: readFileSync(path.join(dir, file), 'utf8') }));
}

/**
 * Applies pending migrations in order. Skips versions already recorded either by this runner
 * or by Supabase's own migration history (when applied through the Supabase MCP / CLI).
 */
export async function migrate(sql: Sql, migrations = listMigrations()): Promise<string[]> {
  await sql.exec(`
    create table if not exists public.rahhal_schema_migrations (version text primary key, name text not null, applied_at timestamptz not null default now());
    alter table public.rahhal_schema_migrations enable row level security;
  `);
  const applied = new Set((await sql.query('select version from public.rahhal_schema_migrations')).map((r) => String(r['version'])));
  // The Supabase MCP/CLI assigns its own version timestamp, so also match on migration name.
  const appliedNames = new Set<string>();
  const supabaseHistory = await sql.query(`select to_regclass('supabase_migrations.schema_migrations') is not null as present`);
  if (supabaseHistory[0]?.['present'] === true) {
    for (const r of await sql.query('select version, name from supabase_migrations.schema_migrations')) {
      applied.add(String(r['version']));
      if (r['name'] !== null) appliedNames.add(String(r['name']));
    }
  }
  const done: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.version) || appliedNames.has(m.name)) continue;
    await sql.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('insert into public.rahhal_schema_migrations (version, name) values ($1, $2)', [m.version, m.name]);
    });
    done.push(`${m.version}_${m.name}`);
  }
  return done;
}
