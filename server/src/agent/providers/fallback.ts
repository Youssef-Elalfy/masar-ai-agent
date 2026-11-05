import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError, type CompletionRequest, type CompletionResponse, type LLMProvider } from './types.ts';

/** Gemini daily quotas reset at midnight Pacific time. */
function msUntilNextPacificMidnight(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    .formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000;
  return Math.max(60_000, 24 * 3_600_000 - elapsed);
}

function pacificDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

export interface RateLimit {
  /** Requests per minute allowed by this client (keep at or below the account's free-tier limit). */
  rpm: number;
  /** Requests per (Pacific) day; null = not enforced client-side. */
  rpd: number | null;
}

/**
 * Client-side pacing for free-tier quotas: spaces requests at 60s/rpm and stops at the daily cap,
 * so the app backs off before the provider has to refuse it.
 */
export class RateLimiter {
  private readonly limit: RateLimit;
  private readonly clock: () => Date;
  private nextSlotAt = 0;
  private day = '';
  private usedToday = 0;

  constructor(limit: RateLimit, clock: () => Date = () => new Date()) {
    this.limit = limit;
    this.clock = clock;
  }

  /** Waits for a slot, or throws PROVIDER_RATE_LIMIT if the wait exceeds maxWaitMs or the daily cap is used. */
  async acquire(signal: AbortSignal, maxWaitMs: number, label: string): Promise<void> {
    const now = this.clock();
    const today = pacificDay(now);
    if (today !== this.day) {
      this.day = today;
      this.usedToday = 0;
    }
    if (this.limit.rpd !== null && this.usedToday >= this.limit.rpd) {
      throw new ProviderError('PROVIDER_RATE_LIMIT', `${label}: local daily request cap reached`, { quotaScope: 'day', retryAfterMs: msUntilNextPacificMidnight(now) });
    }
    const interval = 60_000 / Math.max(1, this.limit.rpm);
    const startAt = Math.max(now.getTime(), this.nextSlotAt);
    const wait = startAt - now.getTime();
    if (wait > maxWaitMs) {
      throw new ProviderError('PROVIDER_RATE_LIMIT', `${label}: local per-minute pacing`, { quotaScope: 'minute', retryAfterMs: wait });
    }
    this.nextSlotAt = startAt + interval;
    this.usedToday++;
    if (wait > 0) await delay(wait, undefined, { signal }).catch(() => undefined);
  }
}

/** Wraps a provider with a RateLimiter. */
export class RateLimitedProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  private readonly inner: LLMProvider;
  private readonly limiter: RateLimiter;
  private readonly maxWaitMs: number;

  constructor(inner: LLMProvider, limiter: RateLimiter, maxWaitMs = 8_000) {
    this.inner = inner;
    this.limiter = limiter;
    this.maxWaitMs = maxWaitMs;
    this.id = inner.id;
    this.model = inner.model;
  }

  /** Waits for a request slot (client-side pacing); throws PROVIDER_RATE_LIMIT if the wait would be too long. */
  async pace(signal: AbortSignal): Promise<void> {
    await this.limiter.acquire(signal, this.maxWaitMs, `${this.inner.id} ${this.inner.model}`);
  }

  /** Calls the provider without pacing (the caller already paced). */
  completeNow(request: CompletionRequest): Promise<CompletionResponse> {
    return this.inner.complete(request);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    await this.pace(request.signal);
    return this.completeNow(request);
  }
}

export interface FallbackEvent {
  from: string;
  to: string | null;
  reason: string;
  cooldownMs: number;
}

/**
 * Ordered chain of free-tier providers (e.g. gemini-3.8-flash → gemini-3.5-flash-lite → groq).
 * On rate limits/outages it cools the failing entry down for the right window and tries the next.
 * Requests with invalid input (400) are not retried elsewhere; they surface as provider errors.
 */
export class FallbackProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  private readonly chain: LLMProvider[];
  private readonly cooldownUntil = new Map<number, number>();
  private readonly clock: () => Date;
  private readonly onFallback: ((e: FallbackEvent) => void) | undefined;

  private readonly perCallTimeoutMs: number;
  private readonly primaryCallTimeoutMs: number;

  /**
   * perCallTimeoutMs: budget of each fallback entry. primaryCallTimeoutMs: budget of the first entry (shorter, so an
   * overloaded primary costs little; its cooldown then skips it for the rest of the turn). Defaults to perCallTimeoutMs.
   */
  constructor(chain: LLMProvider[], opts: { clock?: () => Date; onFallback?: (e: FallbackEvent) => void; perCallTimeoutMs?: number; primaryCallTimeoutMs?: number } = {}) {
    const first = chain[0];
    if (!first) throw new Error('FallbackProvider needs at least one provider.');
    this.chain = chain;
    this.clock = opts.clock ?? (() => new Date());
    this.onFallback = opts.onFallback;
    this.perCallTimeoutMs = opts.perCallTimeoutMs ?? 20_000;
    this.primaryCallTimeoutMs = opts.primaryCallTimeoutMs ?? this.perCallTimeoutMs;
    this.id = chain.map((p) => p.id).filter((v, i, a) => a.indexOf(v) === i).join('→');
    this.model = chain.map((p) => p.model).join('→');
  }

  private cooldownFor(err: ProviderError): number {
    if (err.code === 'PROVIDER_AUTH') return 60 * 60_000;
    if (err.code === 'PROVIDER_RATE_LIMIT') {
      if (err.quotaScope === 'day') return err.retryAfterMs ?? msUntilNextPacificMidnight(this.clock());
      return Math.max(err.retryAfterMs ?? 0, 30_000);
    }
    // Overloaded ("high demand" 503) or slow: give it a minute before trying again.
    return 60_000;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    let lastError: ProviderError | null = null;
    for (const [index, provider] of this.chain.entries()) {
      if ((this.cooldownUntil.get(index) ?? 0) > this.clock().getTime()) continue;
      let attempt: AbortSignal | null = null;
      try {
        // Pacing waits happen BEFORE the per-call clock starts: our own rate limiting must not eat the model's budget.
        if (provider instanceof RateLimitedProvider) await provider.pace(request.signal);
        // Each entry gets its own time budget so one hanging model cannot use up the whole turn.
        const budget = index === 0 ? this.primaryCallTimeoutMs : this.perCallTimeoutMs;
        attempt = AbortSignal.any([request.signal, AbortSignal.timeout(budget)]);
        const pending = { ...request, signal: attempt };
        const response = await (provider instanceof RateLimitedProvider ? provider.completeNow(pending) : provider.complete(pending));
        this.cooldownUntil.delete(index);
        return response;
      } catch (caught) {
        let err = caught;
        if (attempt?.aborted && !request.signal.aborted) {
          err = new ProviderError('PROVIDER_UNAVAILABLE', `${provider.model} did not answer within ${index === 0 ? this.primaryCallTimeoutMs : this.perCallTimeoutMs} ms`, { retryable: true });
        }
        if (!(err instanceof ProviderError) || request.signal.aborted) throw err;
        // Malformed requests and bad responses would fail the same way elsewhere; don't spread them.
        if (err.code === 'PROVIDER_BAD_REQUEST' || err.code === 'PROVIDER_BAD_RESPONSE' || err.code === 'PROVIDER_TIMEOUT') throw err;
        lastError = err;
        const cooldownMs = this.cooldownFor(err);
        this.cooldownUntil.set(index, this.clock().getTime() + cooldownMs);
        const next = this.chain.slice(index + 1).find((_, j) => (this.cooldownUntil.get(index + 1 + j) ?? 0) <= this.clock().getTime());
        this.onFallback?.({ from: `${provider.id}:${provider.model}`, to: next ? `${next.id}:${next.model}` : null, reason: err.message, cooldownMs });
      }
    }
    throw lastError ?? new ProviderError('PROVIDER_RATE_LIMIT', 'All free-tier providers are cooling down; try again shortly.', { retryable: false, quotaScope: 'minute' });
  }
}
