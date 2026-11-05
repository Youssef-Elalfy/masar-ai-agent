import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Anonymous per-browser owner identity for the web console. The owner id lives in an HttpOnly,
 * SameSite=Strict cookie signed with HMAC-SHA256, so a browser cannot claim another owner's id.
 * This isolates conversations, memory and CRM records per browser; it is not a login system.
 */
export const OWNER_COOKIE = 'rahhal_owner';
const OWNER_PATTERN = /^web_[0-9a-f-]{36}$/;
const MAX_AGE_SECONDS = 30 * 24 * 3600;

export class OwnerSessions {
  private readonly secret: Buffer;

  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error('Web session secret must be at least 32 bytes.');
    this.secret = secret;
  }

  private sign(ownerId: string): string {
    return createHmac('sha256', this.secret).update(ownerId).digest('base64url');
  }

  /** Returns the verified owner id from the request, or null when absent or tampered with. */
  verify(req: IncomingMessage): string | null {
    const raw = parseCookies(req.headers.cookie ?? '')[OWNER_COOKIE];
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot < 0) return null;
    const ownerId = raw.slice(0, dot);
    if (!OWNER_PATTERN.test(ownerId)) return null;
    const given = Buffer.from(raw.slice(dot + 1));
    const expected = Buffer.from(this.sign(ownerId));
    return given.length === expected.length && timingSafeEqual(given, expected) ? ownerId : null;
  }

  /** A new owner id plus the Set-Cookie header value for it. */
  issue(secure: boolean): { ownerId: string; cookie: string } {
    const ownerId = `web_${randomUUID()}`;
    const attrs = [`${OWNER_COOKIE}=${ownerId}.${this.sign(ownerId)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${MAX_AGE_SECONDS}`];
    if (secure) attrs.push('Secure');
    return { ownerId, cookie: attrs.join('; ') };
  }
}

export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

/** Fixed-window counter per key (protects the free-tier LLM/STT quotas from a runaway client). */
export class RateLimit {
  private readonly hits = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** True if allowed (and counted). */
  take(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t - entry.start >= this.windowMs) {
      this.hits.set(key, { start: t, count: 1 });
      if (this.hits.size > 10_000) this.prune(t);
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if (t - v.start >= this.windowMs) this.hits.delete(k);
  }
}
