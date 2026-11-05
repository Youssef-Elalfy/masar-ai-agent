import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError, type FetchLike, type QuotaScope } from './types.ts';

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Reads rate-limit hints from an error body without surfacing it: Gemini sends RetryInfo
 * (`"retryDelay": "31s"`) and a quota id naming the window (e.g. "...PerDay..." / "...PerMinute...").
 */
export function parseRateLimitBody(body: string): { retryAfterMs: number | null; quotaScope: QuotaScope } {
  const delayMatch = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  const retryAfterMs = delayMatch?.[1] ? Math.round(Number(delayMatch[1]) * 1000) : null;
  const quotaScope: QuotaScope = /per\s*day|perday|requests_per_day|RPD/i.test(body) ? 'day' : /per\s*minute|perminute|RPM|TPM/i.test(body) ? 'minute' : null;
  return { retryAfterMs, quotaScope };
}

function errorFor(status: number, retryAfterMs: number | null, quotaScope: QuotaScope, providerName: string): ProviderError {
  if (status === 429) {
    // A spent daily quota will not recover within this request: fail fast so a fallback provider can take over.
    const retryable = quotaScope !== 'day';
    return new ProviderError('PROVIDER_RATE_LIMIT', `${providerName} rate limit (429${quotaScope ? `, ${quotaScope} quota` : ''})`, { status, retryable, retryAfterMs, quotaScope });
  }
  if (status === 401 || status === 403) return new ProviderError('PROVIDER_AUTH', `${providerName} rejected the credentials (${status})`, { status });
  if (status === 408 || status === 409 || status >= 500) return new ProviderError('PROVIDER_UNAVAILABLE', `${providerName} unavailable (${status})`, { status, retryable: true, retryAfterMs });
  return new ProviderError('PROVIDER_BAD_REQUEST', `${providerName} rejected the request (${status})`, { status });
}

/**
 * Sends a request with bounded exponential backoff on 408/409/429/5xx and network errors.
 * Error bodies are only parsed for rate-limit hints; they are never surfaced (they may echo request content).
 */
export async function sendWithRetry(args: {
  fetchImpl: FetchLike;
  url: string;
  headers: Record<string, string>;
  /** FormData is rebuilt per attempt by the caller only if it is a stream; strings and FormData are reusable. */
  body: string | FormData;
  signal: AbortSignal;
  providerName: string;
  retry?: RetryPolicy;
  /** Waits longer than this are not slept through: the error is thrown so a fallback can be used. */
  maxRetryWaitMs?: number;
}): Promise<Response> {
  const retry = args.retry ?? DEFAULT_RETRY;
  const maxWait = args.maxRetryWaitMs ?? retry.maxDelayMs;
  let lastError: ProviderError | null = null;
  for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
    if (attempt > 0 && lastError) {
      const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
      const wait = lastError.retryAfterMs ?? backoff;
      if (wait > maxWait) throw lastError;
      await delay(wait, undefined, { signal: args.signal }).catch(() => undefined);
    }
    if (args.signal.aborted) throw new ProviderError('PROVIDER_TIMEOUT', `${args.providerName} call exceeded the agent deadline`);
    let response: Response;
    try {
      response = await args.fetchImpl(args.url, { method: 'POST', headers: args.headers, body: args.body, signal: args.signal });
    } catch {
      if (args.signal.aborted) throw new ProviderError('PROVIDER_TIMEOUT', `${args.providerName} call exceeded the agent deadline`);
      lastError = new ProviderError('PROVIDER_UNAVAILABLE', `${args.providerName} network error`, { retryable: true });
      continue;
    }
    if (response.ok) return response;
    const hints = response.status === 429 ? parseRateLimitBody((await response.text().catch(() => '')).slice(0, 20_000)) : { retryAfterMs: null, quotaScope: null };
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after')) ?? hints.retryAfterMs;
    lastError = errorFor(response.status, retryAfterMs, hints.quotaScope, args.providerName);
    if (!lastError.retryable) throw lastError;
  }
  throw lastError ?? new ProviderError('PROVIDER_UNAVAILABLE', `${args.providerName} failed`);
}

/** JSON POST with retry; returns the parsed body. */
export async function postJsonWithRetry(args: {
  fetchImpl: FetchLike;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  providerName: string;
  retry?: RetryPolicy;
  maxRetryWaitMs?: number;
}): Promise<unknown> {
  const response = await sendWithRetry({ ...args, headers: { 'content-type': 'application/json', ...args.headers }, body: JSON.stringify(args.body) });
  try {
    return await response.json();
  } catch {
    throw new ProviderError('PROVIDER_BAD_RESPONSE', `${args.providerName} returned non-JSON`);
  }
}
