import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolError, type ToolContext, type ToolOutput } from '../server/src/tools/registry.ts';
import { ScriptedProvider, final, testApp } from './helpers.ts';

const app = await testApp(new ScriptedProvider(() => final('unused')));
const ctx: ToolContext = {
  traceId: 'tr_test', conversationId: 'c', ownerId: 'o', now: new Date('2026-11-03T10:00:00Z'), signal: new AbortController().signal,
};

async function run(name: string, input: unknown): Promise<ToolOutput> {
  const tool = app.registry.get(name);
  assert.ok(tool, `tool ${name} registered`);
  return tool.run(input, ctx);
}

async function runError(name: string, input: unknown): Promise<ToolError> {
  const tool = app.registry.get(name);
  assert.ok(tool);
  try {
    await tool.run(input, ctx);
  } catch (err) {
    assert.ok(err instanceof ToolError);
    return err;
  }
  throw new Error('expected ToolError');
}

const Pricing = z.looseObject({
  perPerson: z.number(),
  adultsSubtotal: z.number().nullable(),
  totalForParty: z.number().nullable(),
  totalNote: z.string(),
  withinTotalBudget: z.boolean().optional(),
  warnings: z.array(z.string()),
});
const PkgRow = z.looseObject({ id: z.string(), position: z.number().optional(), pricing: Pricing });
const SearchResult = z.looseObject({ packages: z.array(PkgRow) });

test('every tool exposes a JSON schema to the model', () => {
  assert.deepEqual(app.registry.specs().map((s) => s.name).sort(), [
    'check_company_departures', 'compare_company_packages', 'create_lead', 'create_quote_request', 'forget_customer_memory', 'get_package_details',
    'get_system_status', 'list_company_destinations', 'request_human_handoff', 'request_memory_consent', 'research_external_packages',
    'retrieve_customer_memory', 'search_company_packages', 'upsert_customer_preference',
  ]);
  for (const spec of app.registry.specs()) {
    assert.equal(spec.inputJsonSchema['type'], 'object');
    assert.equal(spec.inputJsonSchema['$schema'], undefined);
  }
});

test('list_company_destinations reads the DB and flags DEMO', async () => {
  const out = await run('list_company_destinations', {});
  assert.equal(out.sourceType, 'company_demo');
  const result = z.looseObject({ destinations: z.array(z.unknown()), companyIsFictional: z.boolean(), notice: z.string() }).parse(out.result);
  assert.equal(result.destinations.length, 4);
  assert.equal(result.companyIsFictional, true);
  assert.match(result.notice, /DEMO/);
});

test('T009: two adults, 15000 EGP total, "بحر" → Hurghada 13000 fits, Sharm 15600 does not', async () => {
  const out = await run('search_company_packages', { query: 'بحر', adults: 2, totalBudget: 15000, budgetCurrency: 'egp' });
  const byId = Object.fromEntries(SearchResult.parse(out.result).packages.map((r) => [r.id, r.pricing]));
  assert.equal(byId['pkg-hurghada-001']?.totalForParty, 13000);
  assert.equal(byId['pkg-hurghada-001']?.withinTotalBudget, true);
  assert.equal(byId['pkg-sharm-001']?.totalForParty, 15600);
  assert.equal(byId['pkg-sharm-001']?.withinTotalBudget, false);
});

test('budget in another or unknown currency → no verdict, no conversion, explicit warning', async () => {
  for (const budgetCurrency of ['USD', undefined]) {
    const out = await run('search_company_packages', { query: 'Hurghada', adults: 2, totalBudget: 500, ...(budgetCurrency ? { budgetCurrency } : {}) });
    const [row] = SearchResult.parse(out.result).packages;
    assert.equal(row?.pricing.withinTotalBudget, undefined);
    assert.match(row?.pricing.warnings.join(' ') ?? '', /no budget verdict/);
  }
});

test('maxPricePerPerson without a currency is rejected so the model asks', async () => {
  assert.equal((await runError('search_company_packages', { maxPricePerPerson: 7000 })).code, 'VALIDATION_ERROR');
});

test('T010: children → adults subtotal only, no party total, no guessed discount', async () => {
  const out = await run('search_company_packages', { query: 'Hurghada', adults: 2, children: 2 });
  const [row] = SearchResult.parse(out.result).packages;
  assert.equal(row?.pricing.totalForParty, null);
  assert.equal(row?.pricing.adultsSubtotal, 13000);
  assert.match(row?.pricing.totalNote ?? '', /Child rates are not stored/);
});

test('double-occupancy basis with one adult warns about a single supplement', async () => {
  const out = await run('search_company_packages', { query: 'Hurghada', adults: 1 });
  const [row] = SearchResult.parse(out.result).packages;
  assert.match(row?.pricing.warnings.join(' ') ?? '', /single-room supplement/);
});

test('T011: Fayoum details show buggy (الباجي) as excluded', async () => {
  const out = await run('get_package_details', { package: 'الفيوم' });
  const { package: pkg } = z.looseObject({ package: z.looseObject({ exclusions: z.array(z.string()) }) }).parse(out.result);
  assert.ok(pkg.exclusions.some((e) => e.includes('الباجي')));
});

test('T007/T014: compare keeps the user order so "the second one" is position 2', async () => {
  const out = await run('compare_company_packages', { packages: ['النوبة', 'الغردقة'] });
  const result = z.looseObject({ rows: z.array(PkgRow), cheapestPerPerson: z.looseObject({ id: z.string() }) }).parse(out.result);
  assert.deepEqual(result.rows.map((r) => [r.position, r.id]), [[1, 'pkg-nubia-001'], [2, 'pkg-hurghada-001']]);
  assert.equal(result.cheapestPerPerson.id, 'pkg-hurghada-001');
});

test('T012: departures default to today (Cairo) and are unconfirmed when none are stored', async () => {
  await app.sql.query(
    `insert into public.package_departures (id, package_id, departure_date, availability_status, seats_remaining, verified_at)
     values ('dep-past', 'pkg-hurghada-001', '2026-10-01', 'confirmed', 4, now()),
            ('dep-future', 'pkg-hurghada-001', '2026-11-20', 'limited', 2, null)`,
  );
  const out = await run('check_company_departures', { package: 'pkg-hurghada-001' });
  const result = z.looseObject({ availability: z.string(), departures: z.array(z.looseObject({ id: z.string(), verificationStale: z.boolean() })) }).parse(out.result);
  assert.deepEqual(result.departures.map((d) => [d.id, d.verificationStale]), [['dep-future', true]]);
  const none = z.looseObject({ availability: z.string() }).parse((await run('check_company_departures', { package: 'pkg-nubia-001' })).result);
  assert.equal(none.availability, 'no_confirmed_departures');
});

test('ambiguous and missing references produce safe error codes', async () => {
  assert.equal((await runError('get_package_details', { package: 'sea' })).code, 'AMBIGUOUS_REFERENCE');
  assert.equal((await runError('get_package_details', { package: 'Tokyo' })).code, 'NOT_FOUND');
});

test('invalid arguments are rejected by Zod before execution', async () => {
  assert.equal((await runError('search_company_packages', { maxDays: 'four' })).code, 'VALIDATION_ERROR');
  assert.equal((await runError('check_company_departures', { package: 'x', startDate: 'next friday' })).code, 'VALIDATION_ERROR');
});

test('T023: external research without a provider returns an honest unavailable status', async () => {
  const out = await run('research_external_packages', { destination: 'Greece' });
  assert.equal(out.sourceType, 'unavailable');
  const result = z.looseObject({ status: z.string(), offers: z.array(z.unknown()) }).parse(out.result);
  assert.equal(result.status, 'provider_not_configured');
  assert.deepEqual(result.offers, []);
});

test('system status reports real capability state truthfully', async () => {
  const result = z.record(z.string(), z.string()).parse((await run('get_system_status', {})).result);
  assert.equal(result['externalTravelSearch'], 'not_connected');
  assert.ok((result['longTermMemory'] ?? '').startsWith('opt_in (lexical_fallback'));
  assert.equal(result['leadCreation'], 'not_configured (PII_ENCRYPTION_KEY missing)');
  assert.equal(result['onlineBooking'], 'not_supported');
});
