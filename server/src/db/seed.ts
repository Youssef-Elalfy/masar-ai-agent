import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT } from '../config.ts';
import { CatalogRepository } from '../catalog/repository.ts';
import { PackageInputSchema } from '../catalog/types.ts';
import type { Sql } from './sql.ts';

const CompanyFixtureSchema = z.object({
  id: z.string(),
  name: z.string(),
  name_ar: z.string().nullable(),
  fictional: z.boolean(),
});
const PackagesFixtureSchema = z.object({
  data_status: z.literal('DEMO_ONLY_NOT_LIVE_OFFERS'),
  packages: z.array(z.record(z.string(), z.unknown())),
});

export interface CompanyInfo {
  id: string;
  name: string;
  nameAr: string | null;
  fictional: boolean;
}

export function loadCompanyFixture(file = path.join(PROJECT_ROOT, 'fixtures', 'company.json')): CompanyInfo {
  const c = CompanyFixtureSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  return { id: c.id, name: c.name, nameAr: c.name_ar, fictional: c.fictional };
}

/** Idempotent: re-running updates the same rows and never duplicates packages. */
export async function seedDemoCatalog(sql: Sql, fixturesDir = path.join(PROJECT_ROOT, 'fixtures')): Promise<{ company: CompanyInfo; packageIds: string[] }> {
  const company = loadCompanyFixture(path.join(fixturesDir, 'company.json'));
  const fixture = PackagesFixtureSchema.parse(JSON.parse(readFileSync(path.join(fixturesDir, 'packages.json'), 'utf8')));
  const packageIds = await sql.transaction(async (tx) => {
    await CatalogRepository.ensureOrganization(tx, { id: company.id, name: company.name, nameAr: company.nameAr, demo: company.fictional });
    const repo = new CatalogRepository(tx, company.id);
    const ids: string[] = [];
    for (const raw of fixture.packages) {
      ids.push((await repo.upsertPackage(PackageInputSchema.parse({ ...raw, source_type: 'company_demo' }))).id);
    }
    return ids;
  });
  return { company, packageIds };
}
