import { z } from 'zod';
import { postJsonWithRetry, type RetryPolicy } from '../agent/providers/http.ts';
import { ProviderError, type FetchLike } from '../agent/providers/types.ts';
import { NON_OFFER_DOMAINS, type SearchHit } from './offer-extraction.ts';

const ResponseSchema = z.object({
  results: z.array(z.looseObject({
    title: z.string().catch(''),
    url: z.string(),
    content: z.string().catch(''),
    published_date: z.string().nullish(),
  })),
  usage: z.looseObject({ credits: z.number().optional() }).nullish(),
});

export type SearchFailure = 'rate_limited' | 'quota_exhausted' | 'auth_failed' | 'timeout' | 'unavailable';

export class SearchError extends Error {
  readonly reason: SearchFailure;
  constructor(reason: SearchFailure, message: string) {
    super(message);
    this.name = 'SearchError';
    this.reason = reason;
  }
}

export interface WebSearch {
  readonly id: string;
  search(query: string, signal: AbortSignal): Promise<{ hits: SearchHit[]; credits: number | null }>;
}

/**
 * Tavily Search (free "Researcher" plan: 1,000 credits/month, no card). Always `search_depth: basic`
 * (1 credit) — `advanced`/`auto_parameters` would cost more and are never sent.
 */
export class TavilySearch implements WebSearch {
  readonly id = 'tavily';
  private readonly opts: { apiKey: string; maxResults: number; fetchImpl?: FetchLike; retry?: RetryPolicy };

  constructor(opts: { apiKey: string; maxResults?: number; fetchImpl?: FetchLike; retry?: RetryPolicy }) {
    this.opts = { ...opts, maxResults: Math.min(opts.maxResults ?? 8, 10) };
  }

  async search(query: string, signal: AbortSignal): Promise<{ hits: SearchHit[]; credits: number | null }> {
    let raw: unknown;
    try {
      raw = await postJsonWithRetry({
        fetchImpl: this.opts.fetchImpl ?? fetch,
        url: 'https://api.tavily.com/search',
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        body: {
          query,
          search_depth: 'basic',
          max_results: this.opts.maxResults,
          topic: 'general',
          include_answer: false,
          include_raw_content: false,
          include_published_date: true,
          include_usage: true,
          exclude_domains: NON_OFFER_DOMAINS,
        },
        signal,
        providerName: 'Tavily',
        retry: this.opts.retry ?? { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 3_000 },
        maxRetryWaitMs: 5_000,
      });
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.code === 'PROVIDER_RATE_LIMIT') throw new SearchError('rate_limited', 'Search rate limit reached.');
        if (err.code === 'PROVIDER_AUTH') throw new SearchError('auth_failed', 'Search key was rejected.');
        if (err.code === 'PROVIDER_TIMEOUT') throw new SearchError('timeout', 'Search timed out.');
        // Tavily: 432 = plan (monthly free credits) limit, 433 = pay-as-you-go limit.
        if (err.status === 432 || err.status === 433) throw new SearchError('quota_exhausted', 'Monthly free search credits are used up.');
      }
      throw new SearchError('unavailable', 'Search service unavailable.');
    }
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) throw new SearchError('unavailable', 'Search response had an unexpected shape.');
    return {
      hits: parsed.data.results.map((r) => ({ title: r.title, url: r.url, content: r.content, publishedDate: r.published_date ?? null })),
      credits: parsed.data.usage?.credits ?? null,
    };
  }
}
