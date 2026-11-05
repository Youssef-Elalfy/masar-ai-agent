import { loadConfig, loadDotEnv } from '../config.ts';
import { CatalogRepository } from '../catalog/repository.ts';
import { ConsentStore } from '../memory/consent-store.ts';
import { EMBEDDING_DIMENSIONS, toVectorLiteral } from '../memory/embeddings.ts';
import { MemoryService } from '../memory/memory-service.ts';
import { connectDatabase } from './connect.ts';
import { listMigrations } from './migrate.ts';
import { loadCompanyFixture } from './seed.ts';

// Read-only health check of the configured database through the app's real repositories.
// Everything runs in a READ ONLY transaction, so Postgres rejects any write. Credentials are never printed.
loadDotEnv();
const config = loadConfig();
const db = connectDatabase(config);
if ('error' in db) {
  console.error(db.error);
  process.exit(1);
}

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
};

try {
  await db.sql.transaction(async (tx) => {
    await tx.query('set transaction read only');
    const [version] = await tx.query("select current_setting('server_version') as v, current_setting('transaction_read_only') as ro");
    check('connection', version?.['ro'] === 'on', `Postgres ${String(version?.['v'])}, transaction read-only=${String(version?.['ro'])}`);

    const history = await tx.query(`select to_regclass('supabase_migrations.schema_migrations') is not null as present`);
    const applied = history[0]?.['present'] === true
      ? (await tx.query('select name from supabase_migrations.schema_migrations order by version')).map((r) => String(r['name']))
      : [];
    const local = listMigrations().map((m) => m.name);
    check('migrations', local.every((n) => applied.includes(n)), `applied=[${applied.join(', ')}] local=[${local.join(', ')}]`);

    const company = loadCompanyFixture();
    const catalog = new CatalogRepository(tx, company.id);
    const all = await catalog.search();
    check('catalog: all packages', all.length >= 4, all.map((p) => `${p.id}=${p.price.amount} ${p.price.currency}/${p.days}d`).join(', '));
    check('catalog: DEMO flags', all.every((p) => p.sourceType === 'company_demo' && !p.bookingEnabled), 'all company_demo, booking disabled');
    const cheapest = all[0];
    check('catalog: cheapest', cheapest?.id === 'pkg-fayoum-001' && cheapest.price.amount === 3200, `${cheapest?.id ?? 'none'} ${cheapest?.price.amount ?? ''}`);
    const sea = (await catalog.search({ text: 'بحر' })).map((p) => p.id).sort();
    check('catalog: Arabic search "بحر"', sea.join(',') === 'pkg-hurghada-001,pkg-sharm-001', sea.join(', '));
    const budget = (await catalog.search({ maxPricePerPerson: 7000, currency: 'EGP' })).map((p) => p.id);
    check('catalog: ≤7000 EGP', budget.join(',') === 'pkg-fayoum-001,pkg-hurghada-001', budget.join(', '));
    const destinations = await catalog.listDestinations();
    check('catalog: destinations', destinations.length >= 4, destinations.map((d) => d.destination).join(', '));
    const fayoum = await catalog.getById('pkg-fayoum-001');
    check('catalog: details', fayoum?.exclusions.some((e) => e.includes('الباجي')) === true, `Fayoum exclusions=${fayoum?.exclusions.length ?? 0}`);
    const departures = await catalog.departures('pkg-hurghada-001');
    check('catalog: departures', departures.length === 0, `${departures.length} stored (none expected → availability on request)`);

    // Memory layer, read-only: an unknown owner has no consent and nothing is recalled.
    const probeOwner = `db-check-probe-${Date.now()}`;
    const consents = new ConsentStore(tx);
    check('memory: consent lookup', (await consents.active(probeOwner, 'long_term_memory')) === null, 'no consent for unknown owner');
    const recall = await new MemoryService(tx, consents, null).recall(probeOwner, 'رحلات البحر', null, AbortSignal.timeout(10_000));
    check('memory: recall without consent', recall.status === 'no_consent' && recall.items.length === 0, recall.status);
    const unit = toVectorLiteral(Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0)));
    const matches = await tx.query('select count(*)::int as n from public.match_memory_items($1, $2::extensions.vector, $3, 5, 0)', [probeOwner, unit, 'probe']);
    check('memory: match_memory_items (pgvector)', matches[0]?.['n'] === 0, 'function callable, 0 rows for unknown owner');
    const [trgm] = await tx.query('select extensions.word_similarity($1, $2) as s', ['بحر', 'رحلات البحر']);
    check('memory: pg_trgm word_similarity (Arabic)', Number(trgm?.['s']) > 0, `similarity=${Number(trgm?.['s']).toFixed(2)}`);
    const [counts] = await tx.query(
      `select (select count(*) from public.customers)::int as customers, (select count(*) from public.conversations)::int as conversations,
              (select count(*) from public.memory_items)::int as memories, (select count(*) from public.agent_runs)::int as runs`,
    );
    console.log(`INFO  row counts: ${JSON.stringify(counts)}`);
  });
} catch (err) {
  failures++;
  // Error class only; driver messages can echo connection details.
  console.log(`FAIL  check aborted: ${err instanceof Error ? err.name : 'unknown error'}`);
} finally {
  await db.sql.close();
}
console.log(failures === 0 ? 'All database checks passed.' : `${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
