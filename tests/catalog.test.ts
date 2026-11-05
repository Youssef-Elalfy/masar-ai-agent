import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemoCatalog } from '../server/src/db/seed.ts';
import { CatalogRepository } from '../server/src/catalog/repository.ts';
import { normalizeForSearch, queryTokens } from '../server/src/text/normalize.ts';
import { createTestSql } from './pglite-sql.ts';

const sql = await createTestSql();
const { company } = await seedDemoCatalog(sql);
const repo = new CatalogRepository(sql, company.id);

test('seed loads the four DEMO packages with exact fixture values (NUMERIC prices)', async () => {
  const all = await repo.search();
  assert.equal(all.length, 4);
  const hurghada = all.find((p) => p.destination === 'Hurghada');
  assert.ok(hurghada);
  assert.deepEqual([hurghada.price.amount, hurghada.price.currency, hurghada.days, hurghada.nights], [6500, 'EGP', 4, 3]);
  assert.ok(all.every((p) => p.sourceType === 'company_demo' && !p.bookingEnabled));
});

test('seeding twice is idempotent', async () => {
  await seedDemoCatalog(sql);
  assert.equal((await repo.search()).length, 4);
});

test('default sort is cheapest first: Fayoum 3200 EGP / 2 days', async () => {
  const [cheapest] = await repo.search({ sortBy: 'price_asc' });
  assert.deepEqual([cheapest?.destination, cheapest?.price.amount, cheapest?.days], ['Fayoum', 3200, 2]);
});

test('Arabic, English and clitic forms resolve the same package', async () => {
  for (const q of ['الغردقة', 'غردقه', 'للغردقة', 'بالغردقة', 'Hurghada', 'hurghada red sea']) {
    assert.deepEqual((await repo.search({ text: q })).map((p) => p.id), ['pkg-hurghada-001'], `query ${q}`);
  }
  assert.deepEqual((await repo.search({ text: 'شرم' })).map((p) => p.id), ['pkg-sharm-001']);
});

test('"بحر" / "sea" / Franco "ba7r" find BOTH beach packages (Arabic synonyms of English tags)', async () => {
  for (const q of ['بحر', 'sea', '3ayez r7la 3al ba7r', 'شاطئ']) {
    assert.deepEqual((await repo.search({ text: q })).map((p) => p.id).sort(), ['pkg-hurghada-001', 'pkg-sharm-001'], `query ${q}`);
  }
  assert.deepEqual((await repo.search({ text: 'صحراء' })).map((p) => p.id), ['pkg-fayoum-001']);
});

test('short or stop-word queries never match by accident ("في" must not hit الفيوم)', async () => {
  assert.deepEqual(queryTokens('في'), []);
  assert.deepEqual(await repo.search({ text: 'في' }), []);
});

test('price filter is currency-scoped: 7000 EGP returns Fayoum and Hurghada; 7000 USD returns nothing', async () => {
  assert.deepEqual((await repo.search({ maxPricePerPerson: 7000, currency: 'EGP' })).map((p) => p.id), ['pkg-fayoum-001', 'pkg-hurghada-001']);
  assert.deepEqual(await repo.search({ maxPricePerPerson: 7000, currency: 'USD' }), []);
});

test('live regression: a query naming two destinations returns both (Hurghada was dropped for "الغردقة شرم الشيخ")', async () => {
  for (const q of ['الغردقة شرم الشيخ', 'الغردقة أو شرم', 'Hurghada or Sharm El Sheikh']) {
    assert.deepEqual((await repo.search({ text: q, maxPricePerPerson: 8000, currency: 'EGP' })).map((p) => p.id).sort(), ['pkg-hurghada-001', 'pkg-sharm-001'], `query ${q}`);
  }
  // Narrowing still works: an extra descriptive word does not pull in every package that shares it.
  assert.deepEqual((await repo.search({ text: 'Hurghada beach' })).map((p) => p.id), ['pkg-hurghada-001']);
});

test('unknown destination returns nothing (no invented package)', async () => {
  assert.deepEqual(await repo.search({ text: 'Luxor' }), []);
});

test('a fifth destination needs only a DB row, no code change', async () => {
  await repo.upsertPackage({
    id: 'pkg-luxor-001', slug: 'luxor-temples', destination: 'Luxor', destination_ar: 'الأقصر', country: 'Egypt', type: 'culture',
    name_ar: 'معابد الأقصر', name_en: 'Luxor Temples', days: 3, nights: 2, price_per_person: 5400, currency: 'EGP',
    pricing_basis: 'per adult', status: 'demo_on_request', disclaimer_ar: 'عرض افتراضي للشرح فقط',
  });
  assert.equal((await repo.search()).length, 5);
  assert.deepEqual((await repo.search({ text: 'الاقصر' })).map((p) => p.id), ['pkg-luxor-001']);
  assert.ok((await repo.listDestinations()).some((d) => d.destination === 'Luxor'));
});

test('catalog queries are scoped to the organization', async () => {
  assert.deepEqual(await new CatalogRepository(sql, 'another-org').search(), []);
});

test('invalid package rows are rejected', async () => {
  await assert.rejects(repo.upsertPackage({
    id: 'bad', slug: 'Bad Slug', destination: 'X', country: 'Y', type: 'z', name_ar: 'س', days: 0, nights: 0,
    price_per_person: 1, currency: 'EGP', pricing_basis: 'p', status: 's', disclaimer_ar: 'd',
  }));
});

test('normalization folds Arabic variants, the article and its clitics', () => {
  assert.equal(normalizeForSearch('الأقصر'), normalizeForSearch('اقصر'));
  assert.equal(normalizeForSearch('رحلةٌ إلى الغردقة!'), 'رحله الي غردقه');
  assert.equal(normalizeForSearch('والغردقة'), 'غردقه');
});
