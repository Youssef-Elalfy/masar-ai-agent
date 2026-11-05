import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT } from '../server/src/config.ts';
import { destinationMention, destinationTerms, extractOffer, type ExtractedOffer, type SearchHit } from '../server/src/research/offer-extraction.ts';
import { ExternalResearchService } from '../server/src/research/research-service.ts';
import type { WebSearch } from '../server/src/research/tavily.ts';

// Regression tests from the single live Tavily search for Turkey (2026-11-03). No network.
const Fixture = z.object({ hits: z.array(z.object({ title: z.string(), url: z.string(), content: z.string(), publishedDate: z.string().nullable() })) });
const { hits } = Fixture.parse(JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'tests', 'fixtures', 'tavily-turkey-2026-11-03.json'), 'utf8')));
const NOW = '2026-11-04T10:00:00.000Z';

function byHost(host: string): SearchHit {
  const h = hits.find((x) => new URL(x.url).hostname.replace(/^www\./, '') === host);
  if (!h) throw new Error(`fixture missing ${host}`);
  return h;
}
function offer(host: string): ExtractedOffer {
  const r = extractOffer(byHost(host), 'Turkey', NOW);
  if (typeof r === 'string') throw new Error(`${host} dropped: ${r}`);
  return r;
}

test('relevance: pages not about Turkey, or about trips FROM Turkey, are dropped', () => {
  assert.equal(extractOffer(byHost('egypttoursportal.com'), 'Turkey', NOW), 'reverse_direction'); // "Egypt Tour Packages from Turkey/Istanbul"
  assert.equal(extractOffer(byHost('tripidaysegytours.com'), 'Turkey', NOW), 'not_about_destination'); // Egypt family tours
  assert.equal(extractOffer(byHost('etlaala-trips.com'), 'Turkey', NOW), 'not_about_destination'); // 7 days in Egypt
});

test('Arabic and English destination aliases, and direction words, are understood', () => {
  const terms = destinationTerms('Turkey');
  assert.equal(destinationMention('رحلة إسطنبول 8 أيام', terms), 'as_destination');
  assert.equal(destinationMention('رحلات طيران من القاهرة إلى اسطنبول', terms), 'as_destination');
  assert.equal(destinationMention('Egypt tours from Turkey/Istanbul', terms), 'only_as_origin');
  assert.equal(destinationMention('Explore Turkey and Egypt in 7 days', terms), 'as_destination');
  assert.deepEqual([...destinationTerms('تركيا')].sort(), [...destinationTerms('Turkey')].sort());
});

test('several prices or currencies → no single headline price; all kept with context', () => {
  const memphis = offer('memphistrips.com'); // "599 دولار + 17,500 جنيه مصرى"
  assert.equal(memphis.offer.price_amount, null);
  assert.deepEqual(memphis.evidence.pricesFound.map((p) => [p.amount, p.currency]), [[599, 'USD'], [17500, 'EGP']]);
  assert.match(memphis.evidence.priceNote ?? '', /different currencies/);
  assert.deepEqual([memphis.offer.days, memphis.offer.nights], [8, 7]);
  const ilink = offer('ilinktours.com'); // "Starting From $300 … for just $1215"
  assert.equal(ilink.offer.price_amount, null);
  assert.deepEqual(ilink.evidence.pricesFound.map((p) => p.amount), [300, 1215]);
});

test('single price keeps its basis and context ("from $14.00 per adult (price varies by group size)")', () => {
  const ta = offer('tripadvisor.com');
  assert.deepEqual([ta.offer.price_amount, ta.offer.price_currency], [14, 'USD']);
  assert.match(ta.offer.price_basis ?? '', /per person/);
  assert.match(ta.offer.price_basis ?? '', /starting from/);
  assert.match(ta.evidence.pricesFound[0]?.context ?? '', /price varies by group size/);
});

test('flight-fare pages are labeled as flights, and "seen 1 day ago" is not a trip length', () => {
  const air = offer('flights.airarabia.com');
  assert.equal(air.evidence.listingType, 'flight_fare');
  assert.equal(air.offer.days, null);
  assert.deepEqual([air.offer.price_amount, air.offer.price_currency], [1013, 'AED']);
  const tickets = offer('tripsegypt.net');
  assert.equal(tickets.evidence.listingType, 'flight_fare');
  assert.match(tickets.offer.price_basis ?? '', /starting from/);
});

test('whole pipeline on the real hits: 5 relevant listings, packages first, drops reported', async () => {
  const replay: WebSearch = { id: 'replay', search: async () => ({ hits, credits: 0 }) };
  const outcome = await new ExternalResearchService({ sql: null, search: replay, clock: () => new Date(NOW) }).research({ destination: 'Turkey', departureCity: 'Cairo', days: 7 }, new AbortController().signal);
  assert.equal(outcome.status, 'ok');
  if (outcome.status !== 'ok') return;
  assert.deepEqual(outcome.offers.map((o) => o.offer.provider), ['ilinktours.com', 'tripadvisor.com', 'memphistrips.com', 'flights.airarabia.com', 'tripsegypt.net']);
  assert.deepEqual(outcome.dropped, { reverse_direction: 2, not_about_destination: 4, duplicate: 5 });
  assert.ok(outcome.offers.every((o) => o.offer.status === 'listed_unverified' && o.offer.verified_at === null));
});

test('tool output gives the retrieval time in Cairo time for the customer', async () => {
  const { createExternalResearchTool } = await import('../server/src/tools/external-research.ts');
  const replay: WebSearch = { id: 'replay', search: async () => ({ hits, credits: 0 }) };
  // 23:42 UTC on Nov 3 is already Nov 4 in Cairo.
  const service = new ExternalResearchService({ sql: null, search: replay, clock: () => new Date('2026-11-03T23:42:07Z') });
  const tool = createExternalResearchTool(service);
  const out = await tool.run({ destination: 'Turkey' }, { traceId: 't', conversationId: 'c', ownerId: 'o', now: new Date(), signal: new AbortController().signal });
  const result = z.looseObject({ retrievedAtLocal: z.string(), filteredOut: z.record(z.string(), z.number()) }).parse(out.result);
  assert.equal(result.retrievedAtLocal, '2026-11-04 01:42 (Cairo time)');
  assert.equal(result.filteredOut['reverse_direction'], 2);
});
