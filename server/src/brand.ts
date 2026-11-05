import type { CompanyInfo } from './db/seed.ts';

/**
 * Customer-facing brand (renamed from RAHHAL AI on 2026-11-04). Internal identifiers — the organization id
 * "rahhal-ai-demo-company", its stored name, package ids, env names, API routes and the repository folder — are left
 * unchanged on purpose, so no stored data or migration is touched by the rename.
 */
export const BRAND = {
  name: 'MASAR AI',
  nameAr: 'مَسَارٌ',
  tagline: 'ذكاءٌ يقود رحلتك',
} as const;

/** Name the customer sees for the company: the brand for the fictional demo company, the real name otherwise. */
export function customerFacingCompany(company: CompanyInfo): { name: string; nameAr: string } {
  return company.fictional ? { name: BRAND.name, nameAr: BRAND.nameAr } : { name: company.name, nameAr: company.nameAr ?? company.name };
}
