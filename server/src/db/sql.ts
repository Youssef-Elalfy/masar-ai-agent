import { z } from 'zod';

export type Row = Record<string, unknown>;

/**
 * Minimal Postgres access port. Implemented by node-postgres for Supabase (pg-sql.ts)
 * and by PGlite in tests. Always use $1..$n parameters; never interpolate values.
 */
export interface Sql {
  query(text: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Runs a multi-statement script without parameters (migrations). */
  exec(script: string): Promise<void>;
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres drivers return timestamps as Date and numeric/bigint as string; normalize at the edge. */
export const zIso = z.union([z.date(), z.string()]).transform((v) => (typeof v === 'string' ? new Date(v).toISOString() : v.toISOString()));
export const zIsoNullable = zIso.nullable();
export const zNum = z.coerce.number();
export const zStringList = z.array(z.string()).catch([]);
