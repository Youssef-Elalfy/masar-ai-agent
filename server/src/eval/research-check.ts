import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT, loadConfig, loadDotEnv } from '../config.ts';
import { createApp, createEmbeddings, createProvider, createWebSearch } from '../app.ts';
import { connectDatabase } from '../db/connect.ts';
import { normalizeDigits } from '../observability/redact.ts';
import { readFileSync } from 'node:fs';
import { findPrices, TravelOfferResultSchema, type SearchHit } from '../research/offer-extraction.ts';
import { SearchError, type WebSearch } from '../research/tavily.ts';

// One live, budget-capped M3 verification: real agent + real Tavily + Supabase, then automated checks
// on every returned listing and on the agent's reply. Never prints keys or connection strings.
// Usage: npm run research:check -- --confirm            (one capped live search)
//        npm run research:check -- --confirm --replay   (saved real results, 0 search credits)

const MAX_QUERIES = 2; // one research call = English + Arabic query = 2 basic credits
const USER_TEXT = 'دورلي على برامج تركيا أسبوع من القاهرة الشهر الجاي';

/** Hard cap around the real search client: anything beyond MAX_QUERIES is refused locally (no credits). */
class CappedSearch implements WebSearch {
  readonly id: string;
  readonly queries: string[] = [];
  credits = 0;
  private readonly inner: WebSearch;

  constructor(inner: WebSearch) {
    this.inner = inner;
    this.id = inner.id;
  }

  async search(query: string, signal: AbortSignal): Promise<{ hits: SearchHit[]; credits: number | null }> {
    if (this.queries.length >= MAX_QUERIES) throw new SearchError('unavailable', 'Local verification budget reached (no live call made).');
    this.queries.push(query);
    const result = await this.inner.search(query, signal);
    this.credits += result.credits ?? 0;
    return result;
  }
}

const OfferWithEvidence = TravelOfferResultSchema.extend({
  evidence: z.object({
    snippet: z.string(),
    publishedDate: z.string().nullable(),
    pricesFound: z.array(z.object({ amount: z.number(), currency: z.string(), text: z.string(), context: z.string() })),
    listingType: z.enum(['package_or_tour', 'flight_fare']),
    priceNote: z.string().nullable(),
  }),
});
const ToolPayload = z.looseObject({
  ok: z.boolean(),
  sourceType: z.string().optional(),
  result: z.looseObject({ status: z.string(), offers: z.array(z.unknown()).optional(), untrustedContent: z.boolean().optional() }).optional(),
});

/** Existence check for a source URL: HEAD, then a 1-byte GET for servers that reject HEAD. Body is never read. */
async function urlStatus(url: string): Promise<number | 'unreachable'> {
  for (const init of [{ method: 'HEAD' }, { method: 'GET', headers: { range: 'bytes=0-0' } }] as const) {
    try {
      const res = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(8_000) });
      await res.body?.cancel();
      if (res.status !== 405 && res.status !== 501) return res.status;
    } catch {
      // try next method
    }
  }
  return 'unreachable';
}

const REPLAY_FIXTURE = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'tavily-turkey-2026-11-03.json');
const ReplayFixture = z.object({ hits: z.array(z.object({ title: z.string(), url: z.string(), content: z.string(), publishedDate: z.string().nullable() })) });

/** Replays real, previously retrieved search results: no network call, no credits. */
class ReplaySearch implements WebSearch {
  readonly id = 'tavily-replay';
  private readonly hits: SearchHit[];
  constructor(hits: SearchHit[]) {
    this.hits = hits;
  }
  async search(): Promise<{ hits: SearchHit[]; credits: number | null }> {
    return { hits: this.hits, credits: 0 };
  }
}

loadDotEnv();
const config = loadConfig();
const replay = process.argv.includes('--replay');
const provider = createProvider(config, { onFallback: (e) => console.log(`   ⇄ fallback: ${e.from} → ${e.to ?? 'none'} (${e.reason})`) });
const realSearch = replay ? new ReplaySearch(ReplayFixture.parse(JSON.parse(readFileSync(REPLAY_FIXTURE, 'utf8'))).hits) : createWebSearch(config);
if (!provider || !realSearch) {
  console.error(`Cannot run: ${!provider ? config.providerIssue : config.searchIssue}`);
  process.exit(1);
}
console.log(replay
  ? `M3 replay check: saved real Turkey results (${path.relative(PROJECT_ROOT, REPLAY_FIXTURE)}), 0 search credits + live LLM ${provider.model}.`
  : `M3 live check: 1 research call max (${MAX_QUERIES} basic Tavily queries ≈ ${MAX_QUERIES} credits) + LLM ${provider.model}.`);
if (!process.argv.includes('--confirm')) {
  console.log('Dry run only. Re-run with --confirm to make the single live search.');
  process.exit(0);
}
const db = connectDatabase(config);
if ('error' in db) {
  console.error(db.error);
  process.exit(1);
}

const search = new CappedSearch(realSearch);
const app = await createApp(config, provider, db.sql, createEmbeddings(config), { webSearch: search });
const ownerId = `research-check-${new Date().toISOString().replace(/[:.]/g, '-')}`;
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};

try {
  const conversationId = await app.conversations.create(ownerId, 'ar-EG');
  const turn = await app.runtime.runTurn({ conversationId, ownerId, userText: USER_TEXT });
  console.log(`\nTurn: ${turn.status} in ${turn.latencyMs} ms · trace ${turn.traceId} · tools: ${turn.toolCalls.map((t) => `${t.name}(${t.outcome})`).join(', ') || 'none'}`);
  console.log(`${replay ? 'Replayed queries (no network)' : 'Tavily queries sent'}: ${search.queries.length} (${search.queries.map((q) => `"${q}"`).join(', ')}) · credits reported: ${search.credits}`);
  check(search.queries.length <= MAX_QUERIES, 'live search budget respected', `${search.queries.length}/${MAX_QUERIES} queries`);

  // The exact tool results the model received, read back from the stored transcript.
  const messages = await app.conversations.load(conversationId, ownerId);
  const researchIds = new Set(messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_call' && b.name === 'research_external_packages' ? [b.id] : []))));
  const payloads = messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_result' && researchIds.has(b.toolCallId) ? [ToolPayload.parse(JSON.parse(b.content))] : [])));
  check(payloads.length >= 1, 'agent called research_external_packages', `${payloads.length} call(s)`);
  const live = payloads.find((p) => p.result?.status === 'ok') ?? payloads[0];
  console.log(`Research status: ${live?.result?.status ?? 'none'} · sourceType: ${live?.sourceType ?? '-'} · untrustedContent flag: ${live?.result?.untrustedContent ?? '-'}`);

  const offers = (live?.result?.offers ?? []).map((o) => OfferWithEvidence.safeParse(o));
  check(offers.every((o) => o.success), 'every listing matches contracts/travel-offer-result.schema.json', `${offers.filter((o) => o.success).length}/${offers.length}`);
  const valid = offers.flatMap((o) => (o.success ? [o.data] : []));
  const urlResults: Array<{ url: string; status: number | 'unreachable' }> = [];

  console.log('\nListings:');
  for (const [i, o] of valid.entries()) {
    const url = new URL(o.provider_url ?? 'https://invalid.invalid');
    const hostOk = url.protocol === 'https:' && url.hostname.replace(/^www\./, '') === o.provider;
    const source = normalizeDigits(`${o.title ?? ''} ${o.evidence.snippet}`);
    const first = o.evidence.pricesFound[0];
    // Headline price only when exactly one price is listed; every listed price must appear verbatim in the source.
    const allVerbatim = o.evidence.pricesFound.every((p) => source.includes(normalizeDigits(p.text)));
    const priceOk = allVerbatim && (o.price_amount === null
      ? o.evidence.pricesFound.length !== 1 && (o.evidence.pricesFound.length === 0 || o.evidence.priceNote !== null)
      : o.evidence.pricesFound.length === 1 && first !== undefined && first.amount === o.price_amount && first.currency === o.price_currency);
    const honest = o.source_type === 'external_listing' && o.status === 'listed_unverified' && o.verified_at === null;
    // Replay: URLs were already checked during the live run; avoid repeat requests to third-party sites.
    const status = replay ? 200 : await urlStatus(url.toString());
    urlResults.push({ url: url.toString(), status });
    const exists = typeof status === 'number' && status < 500 && status !== 404 && status !== 410;
    console.log(`  ${i + 1}. ${o.provider} — ${(o.title ?? '').slice(0, 70)}`);
    console.log(`     ${url.toString()}  [HTTP ${status}]`);
    const priceLabel = o.price_amount !== null
      ? `${o.price_amount} ${o.price_currency} (as listed: "${first?.text ?? ''}"${o.price_basis ? `, ${o.price_basis}` : ''})`
      : o.evidence.pricesFound.length > 1 ? `several: ${o.evidence.pricesFound.map((p) => p.text).join(' | ')}` : 'not shown in listing';
    console.log(`     ${o.evidence.listingType} · price: ${priceLabel} · days/nights: ${o.days ?? '?'}/${o.nights ?? '?'} · status: ${o.status}`);
    check(hostOk, `  listing ${i + 1} https URL and provider = domain`);
    check(priceOk, `  listing ${i + 1} price literally present in source text (or none claimed)`);
    check(honest, `  listing ${i + 1} honest status (external_listing / listed_unverified / not verified)`);
    if (!replay) check(exists, `  listing ${i + 1} source URL exists`, `HTTP ${status}${status === 403 || status === 401 ? ' (page exists, blocks automated access)' : ''}`);
  }

  // Every price the agent states must come from a listing's pricesFound (Turkey has no company package).
  const allowed = valid.flatMap((o) => o.evidence.pricesFound);
  const claimed = findPrices(turn.text);
  const unsupported = claimed.filter((c) => !allowed.some((a) => a.amount === c.amount && a.currency === c.currency));
  console.log(`\nAgent reply:\n${turn.text}\n`);
  check(unsupported.length === 0, 'every price in the reply is backed by a listing', unsupported.length > 0 ? `unsupported: ${unsupported.map((u) => u.text).join(', ')}` : `${claimed.length} price(s) quoted`);
  check(valid.length === 0 || /http/.test(turn.text), 'reply includes source links');

  const dir = path.join(PROJECT_ROOT, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `research-check-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify({ ranAt: new Date().toISOString(), mode: replay ? 'replay' : 'live', ownerId, traceId: turn.traceId, status: turn.status, queries: search.queries, credits: search.credits, offers: valid, urlResults, reply: turn.text, failures }, null, 2)}\n`);
  console.log(`Report: ${path.relative(PROJECT_ROOT, file)}`);
} finally {
  await app.sql.close();
}
console.log(failures === 0 ? 'All M3 live checks passed.' : `${failures} M3 live check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
