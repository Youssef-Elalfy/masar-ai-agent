import { createHash } from 'node:crypto';
import type { Sql } from '../db/sql.ts';
import { extractOffer, type DropReason, type ExtractedOffer } from './offer-extraction.ts';
import { SearchError, type SearchFailure, type WebSearch } from './tavily.ts';

export interface ResearchInput {
  destination: string;
  departureCity?: string | undefined;
  dateRange?: string | undefined;
  travelers?: number | undefined;
  maxBudget?: number | undefined;
  currency?: string | undefined;
  days?: number | undefined;
}

export type ResearchOutcome =
  | { status: 'ok' | 'no_results'; provider: string; offers: ExtractedOffer[]; dropped: Partial<Record<DropReason | 'duplicate', number>>; queries: string[]; retrievedAt: string; creditsUsed: number | null; cached: boolean }
  | { status: 'provider_not_configured' }
  | { status: SearchFailure; provider: string };

const MAX_OFFERS = 6;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const OFFER_CACHE_TTL = '24 hours';

/** Two short queries (English + Egyptian-market Arabic) from structured constraints; never from free model text. */
export function buildQueries(input: ResearchInput): string[] {
  const from = input.departureCity?.trim() || 'Egypt';
  const days = input.days ? `${input.days} days ` : '';
  const when = input.dateRange?.trim() ? ` ${input.dateRange.trim()}` : '';
  const en = `${input.destination} ${days}tour package from ${from}${when} price`.replace(/\s+/g, ' ').trim();
  const ar = `برنامج سياحي ${input.destination} ${input.days ? `${input.days} أيام ` : ''}من ${input.departureCity?.trim() || 'مصر'}${when} السعر`.replace(/\s+/g, ' ').trim();
  return [en.slice(0, 200), ar.slice(0, 200)];
}

/**
 * Worldwide external-offer research: web search → deterministic, attributed extraction → contract-valid
 * listings marked `listed_unverified`. Never claims availability; never invents providers, links or prices.
 */
export class ExternalResearchService {
  private readonly sql: Sql | null;
  private readonly search: WebSearch | null;
  private readonly clock: () => Date;
  private readonly cache = new Map<string, { at: number; offers: ExtractedOffer[]; dropped: Partial<Record<DropReason | 'duplicate', number>>; queries: string[]; retrievedAt: string }>();

  constructor(deps: { sql: Sql | null; search: WebSearch | null; clock?: () => Date }) {
    this.sql = deps.sql;
    this.search = deps.search;
    this.clock = deps.clock ?? (() => new Date());
  }

  get providerId(): string | null {
    return this.search?.id ?? null;
  }

  async research(input: ResearchInput, signal: AbortSignal): Promise<ResearchOutcome> {
    if (!this.search) return { status: 'provider_not_configured' };
    const queries = buildQueries(input);
    const key = queries.join('\n').toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.clock().getTime() - hit.at < CACHE_TTL_MS) {
      return { status: hit.offers.length > 0 ? 'ok' : 'no_results', provider: this.search.id, offers: hit.offers, dropped: hit.dropped, queries: hit.queries, retrievedAt: hit.retrievedAt, creditsUsed: 0, cached: true };
    }
    let results;
    try {
      results = await Promise.all(queries.map((q) => this.search?.search(q, signal)));
    } catch (err) {
      return { status: err instanceof SearchError ? err.reason : 'unavailable', provider: this.search.id };
    }
    const retrievedAt = this.clock().toISOString();
    const seen = new Set<string>();
    const offers: ExtractedOffer[] = [];
    const dropped: Partial<Record<DropReason | 'duplicate', number>> = {};
    const drop = (reason: DropReason | 'duplicate') => {
      dropped[reason] = (dropped[reason] ?? 0) + 1;
    };
    for (const r of results) {
      for (const h of r?.hits ?? []) {
        const extracted = extractOffer(h, input.destination, retrievedAt);
        if (typeof extracted === 'string') {
          drop(extracted);
          continue;
        }
        const url = extracted.offer.provider_url ?? '';
        if (seen.has(url)) {
          drop('duplicate');
          continue;
        }
        seen.add(url);
        offers.push(extracted);
      }
    }
    // Packages before flight fares, then listings with any price; search ranking kept otherwise.
    const rank = (o: ExtractedOffer) => (o.evidence.listingType === 'package_or_tour' ? 2 : 0) + (o.evidence.pricesFound.length > 0 ? 1 : 0);
    offers.sort((a, b) => rank(b) - rank(a));
    const top = offers.slice(0, MAX_OFFERS);
    const credits = results.reduce<number | null>((sum, r) => (r?.credits === null || r?.credits === undefined ? sum : (sum ?? 0) + r.credits), null);
    this.cache.set(key, { at: this.clock().getTime(), offers: top, dropped, queries, retrievedAt });
    await this.persist(top);
    return { status: top.length > 0 ? 'ok' : 'no_results', provider: this.search.id, offers: top, dropped, queries, retrievedAt, creditsUsed: credits, cached: false };
  }

  /** Evidence trail in external_offers_cache (expires after 24 h). A storage failure never hides the results. */
  private async persist(offers: ExtractedOffer[]): Promise<void> {
    if (!this.sql) return;
    for (const { offer, evidence } of offers) {
      const rawHash = createHash('sha256').update(`${offer.provider_url}|${offer.title}|${evidence.snippet}`).digest('hex');
      try {
        await this.sql.query(
          `insert into public.external_offers_cache (provider_name, source_url, destination, title, price_amount, price_currency, price_basis, status,
             payload, raw_hash, retrieved_at, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz, $11::timestamptz + interval '${OFFER_CACHE_TTL}')
           on conflict (raw_hash) do nothing`,
          [offer.provider, offer.provider_url, offer.destination, offer.title, offer.price_amount, offer.price_currency, offer.price_basis, offer.status,
            JSON.stringify({ offer, evidence }), rawHash, offer.retrieved_at],
        );
      } catch {
        // Evidence persistence is best-effort.
      }
    }
  }
}
