import { readFileSync } from 'node:fs';
import { loadConfig, loadDotEnv } from '../config.ts';
import { connectDatabase } from '../db/connect.ts';
import { loadCompanyFixture } from '../db/seed.ts';
import { CatalogRepository } from './repository.ts';
import { PackageInputSchema } from './types.ts';

// Usage: npm run catalog:add -- path/to/package.json
// Adds or updates one company package row. No code or prompt changes are needed for new destinations.
const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run catalog:add -- <package.json>');
  process.exit(1);
}
const parsed = PackageInputSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
if (!parsed.success) {
  console.error(`Invalid package file:\n${parsed.error.message}`);
  process.exit(1);
}
loadDotEnv();
const db = connectDatabase(loadConfig());
if ('error' in db) {
  console.error(db.error);
  process.exit(1);
}
try {
  const company = loadCompanyFixture();
  await CatalogRepository.ensureOrganization(db.sql, { id: company.id, name: company.name, nameAr: company.nameAr, demo: company.fictional });
  const saved = await new CatalogRepository(db.sql, company.id).upsertPackage(parsed.data);
  console.log(`Saved ${saved.id} (${saved.destination}, ${saved.days} days, ${saved.price.amount} ${saved.price.currency}, ${saved.sourceType}).`);
} finally {
  await db.sql.close();
}
