import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeDigits } from '../observability/redact.ts';
import { normalizeForSearch } from '../text/normalize.ts';

/** Mirror of contracts/travel-offer-result.schema.json (additionalProperties: false). */
export const TravelOfferResultSchema = z.strictObject({
  id: z.string().min(1),
  source_type: z.enum(['company_demo', 'company_verified', 'external_listing', 'supplier_live_inventory', 'estimated_itinerary', 'general_information', 'unavailable']),
  status: z.enum(['demo_only', 'listed_unverified', 'verified_available', 'verified_unavailable', 'on_request', 'estimate_only', 'unknown']),
  destination: z.string(),
  country: z.string().nullable(),
  provider: z.string(),
  provider_url: z.url({ protocol: /^https$/ }).nullable(),
  title: z.string().nullable(),
  days: z.number().int().min(1).nullable(),
  nights: z.number().int().min(0).nullable(),
  price_amount: z.number().min(0).nullable(),
  price_currency: z.string().nullable(),
  price_basis: z.string().nullable(),
  travel_dates: z.string().nullable(),
  inclusions: z.array(z.string()),
  exclusions: z.array(z.string()),
  retrieved_at: z.iso.datetime(),
  verified_at: z.iso.datetime().nullable(),
  disclaimer: z.string(),
});
export type TravelOfferResult = z.infer<typeof TravelOfferResultSchema>;

export interface SearchHit {
  title: string;
  url: string;
  content: string;
  publishedDate: string | null;
}

export interface PriceMention {
  amount: number;
  currency: string;
  /** Exact text the price was read from, so the user can see it was not invented. */
  text: string;
  /** Words around the price ("from $14.00 per adult (price varies by group size)"). */
  context: string;
}

export type ListingType = 'package_or_tour' | 'flight_fare';

export interface ExtractedOffer {
  offer: TravelOfferResult;
  evidence: {
    snippet: string;
    publishedDate: string | null;
    pricesFound: PriceMention[];
    listingType: ListingType;
    /** Why price_amount is null although prices were found (e.g. several prices or currencies). */
    priceNote: string | null;
  };
}

/** Why a search hit was not turned into an offer (reported in aggregate, never shown as an offer). */
export type DropReason = 'invalid_url' | 'not_about_destination' | 'reverse_direction' | 'contract_invalid';

const DISCLAIMER =
  'External listing found on the web by automated search. Not a MASAR (company) program; availability, dates and final price are NOT verified — confirm directly with the provider.';

/** Sites that describe places but do not sell trips; excluded at search time. */
export const NON_OFFER_DOMAINS = ['wikipedia.org', 'youtube.com', 'reddit.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'pinterest.com', 'x.com', 'twitter.com', 'quora.com'];

const MAX_SNIPPET_CHARS = 300;

/** Untrusted web text → bounded plain text: no control/bidi-override characters, collapsed whitespace, length cap. */
export function sanitizeSnippet(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SNIPPET_CHARS);
}

// ───────────────────────── Prices ─────────────────────────
const CURRENCY_ALIASES: Array<[RegExp, string]> = [
  [/^(egp|le|l\.e\.?|جنيه|ج\.?م\.?|جم)$/i, 'EGP'],
  [/^(usd|us\$|\$|دولار)$/i, 'USD'],
  [/^(eur|€|يورو)$/i, 'EUR'],
  [/^(gbp|£|استرليني|إسترليني)$/i, 'GBP'],
  [/^(try|tl|₺|ليرة)$/i, 'TRY'],
  [/^(aed|درهم)$/i, 'AED'],
  [/^(sar|ريال)$/i, 'SAR'],
];
const CURRENCY_TOKEN = String.raw`(EGP|LE|L\.E\.?|USD|US\$|EUR|GBP|TRY|TL|AED|SAR|\$|€|£|₺|جنيه|ج\.?م\.?|جم|دولار|يورو|استرليني|إسترليني|ليرة|درهم|ريال)`;
const AMOUNT = String.raw`(\d{1,3}(?:[,٬]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const PRICE_BEFORE = new RegExp(`${CURRENCY_TOKEN}\\s?${AMOUNT}`, 'gi');
const PRICE_AFTER = new RegExp(`${AMOUNT}\\s?${CURRENCY_TOKEN}`, 'gi');
const CONTEXT_CHARS = 45;

function currencyCode(token: string): string | null {
  for (const [pattern, code] of CURRENCY_ALIASES) if (pattern.test(token.trim())) return code;
  return null;
}

/** Prices that literally appear in the text with an explicit currency, with surrounding words. Bare numbers are never prices. */
export function findPrices(text: string): PriceMention[] {
  const normalized = normalizeDigits(text);
  const found: Array<PriceMention & { index: number }> = [];
  const add = (amountRaw: string, currencyRaw: string, matchText: string, index: number) => {
    const currency = currencyCode(currencyRaw);
    const amount = Number(amountRaw.replace(/[,٬]/g, ''));
    if (!currency || !Number.isFinite(amount) || amount <= 0) return;
    if (found.some((p) => p.amount === amount && p.currency === currency)) return;
    const context = normalized.slice(Math.max(0, index - CONTEXT_CHARS), index + matchText.length + CONTEXT_CHARS).trim();
    found.push({ amount, currency, text: matchText.trim(), context, index });
  };
  for (const m of normalized.matchAll(PRICE_BEFORE)) if (m[1] && m[2]) add(m[2], m[1], m[0], m.index);
  for (const m of normalized.matchAll(PRICE_AFTER)) if (m[1] && m[2]) add(m[1], m[2], m[0], m.index);
  return found.sort((a, b) => a.index - b.index).slice(0, 4).map(({ index: _index, ...p }) => p);
}

/** Basis words near a single price ("per adult", "للفرد", "for two", "الغرفة المزدوجة"). */
function priceBasis(context: string): string | null {
  const parts: string[] = [];
  if (/(per\s+(person|adult|pax)|للفرد|سعر الفرد|للشخص الواحد|للشخص(?!ين))/i.test(context)) parts.push('per person');
  else if (/(for\s+two|للشخصين|لشخصين)/i.test(context)) parts.push('for two people');
  if (/(double|twin|الغرفة المزدوجة|الغرفه المزدوجه|غرفة مزدوجة)/i.test(context)) parts.push('double occupancy');
  if (/(from|starting|يبدأ|يبدا|ابتداء|من حوالي)/i.test(context)) parts.push('starting from');
  return parts.length > 0 ? `${parts.join(', ')} (as listed)` : null;
}

// ───────────────────────── Relevance ─────────────────────────
/** Common destination aliases (English, Turkish/local, Arabic); unknown destinations match by their own name. */
const DESTINATION_ALIASES: Record<string, string[]> = {
  turkey: ['turkey', 'türkiye', 'turkiye', 'istanbul', 'cappadocia', 'antalya', 'bodrum', 'تركيا', 'إسطنبول', 'اسطنبول', 'كابادوكيا', 'أنطاليا', 'انطاليا'],
  japan: ['japan', 'tokyo', 'kyoto', 'osaka', 'اليابان', 'طوكيو', 'كيوتو'],
  italy: ['italy', 'rome', 'milan', 'venice', 'florence', 'إيطاليا', 'ايطاليا', 'روما', 'ميلانو', 'البندقية', 'فلورنسا'],
  uae: ['uae', 'emirates', 'dubai', 'abu dhabi', 'الإمارات', 'الامارات', 'دبي', 'أبوظبي', 'ابوظبي'],
  maldives: ['maldives', 'المالديف'],
  greece: ['greece', 'athens', 'santorini', 'mykonos', 'اليونان', 'أثينا', 'سانتوريني'],
  france: ['france', 'paris', 'فرنسا', 'باريس'],
  spain: ['spain', 'madrid', 'barcelona', 'إسبانيا', 'اسبانيا', 'مدريد', 'برشلونة'],
  thailand: ['thailand', 'bangkok', 'phuket', 'تايلاند', 'بانكوك', 'بوكيت'],
  malaysia: ['malaysia', 'kuala lumpur', 'ماليزيا', 'كوالالمبور'],
  georgia: ['georgia', 'tbilisi', 'batumi', 'جورجيا', 'تبليسي', 'باتومي'],
  'saudi arabia': ['saudi', 'riyadh', 'jeddah', 'السعودية', 'الرياض', 'جدة', 'العمرة', 'umrah'],
};

export function destinationTerms(destination: string): string[] {
  const key = destination.trim().toLowerCase();
  const fromMap = Object.entries(DESTINATION_ALIASES).find(([k, aliases]) => k === key || aliases.some((a) => normalizeForSearch(a) === normalizeForSearch(destination)));
  const terms = new Set([destination, ...(fromMap?.[1] ?? [])].map((t) => normalizeForSearch(t)).filter((t) => t.length >= 3));
  return [...terms];
}

const FROM_WORDS = new Set(['from', 'من']);
const TO_WORDS = new Set(['to', 'in', 'الي', 'في', 'لي', 'into', 'visit', 'explore']);

/**
 * How the destination is mentioned: 'none', 'only_as_origin' ("Egypt tours from Turkey"), or 'as_destination'.
 * Works on normalized words; the nearest direction word within 3 words before a mention decides.
 */
export function destinationMention(text: string, terms: string[]): 'none' | 'only_as_origin' | 'as_destination' {
  const words = normalizeForSearch(text).split(' ');
  let mentions = 0;
  let fromMentions = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? '';
    const hit = terms.some((t) => (t.includes(' ') ? words.slice(i, i + t.split(' ').length).join(' ') === t : w === t || w.startsWith(t)));
    if (!hit) continue;
    mentions++;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const prev = words[j] ?? '';
      if (TO_WORDS.has(prev)) break;
      if (FROM_WORDS.has(prev)) {
        fromMentions++;
        break;
      }
    }
  }
  if (mentions === 0) return 'none';
  return fromMentions === mentions ? 'only_as_origin' : 'as_destination';
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function listingType(title: string, url: URL): ListingType {
  const hay = `${title} ${url.hostname} ${safeDecode(url.pathname)}`.toLowerCase();
  return /(flight|airfare|airline|طيران|تذاكر|تذكرة)/.test(hay) ? 'flight_fare' : 'package_or_tour';
}

// ───────────────────────── Extraction ─────────────────────────
function firstInt(text: string, pattern: RegExp, min: number): number | null {
  const m = pattern.exec(normalizeDigits(text));
  const n = m?.[1] ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= min && n <= 60 ? n : null;
}

function providerName(url: URL): string {
  return url.hostname.replace(/^www\./, '');
}

export function offerId(url: string, title: string): string {
  return `ext_${createHash('sha256').update(`${url}|${title}`).digest('hex').slice(0, 16)}`;
}

/**
 * Deterministic extraction (no LLM): every field comes from the search hit itself.
 * Dropped: non-https/credentialed URLs, pages not about the destination, pages where the destination is only
 * the origin. A headline price is set only when exactly one price appears; otherwise all prices stay in evidence.
 */
export function extractOffer(hit: SearchHit, destination: string, retrievedAt: string): ExtractedOffer | DropReason {
  let url: URL;
  try {
    url = new URL(hit.url);
  } catch {
    return 'invalid_url';
  }
  if (url.protocol !== 'https:' || url.username || url.password) return 'invalid_url';
  const title = sanitizeSnippet(hit.title).slice(0, 200) || null;
  const snippet = sanitizeSnippet(hit.content);
  const text = `${title ?? ''} ${snippet}`;
  const terms = destinationTerms(destination);
  // The URL path only counts when the visible text never names the destination (slugs lose "from/to" words).
  let mention = destinationMention(text, terms);
  if (mention === 'none') mention = destinationMention(safeDecode(url.pathname).replace(/[-_/]/g, ' '), terms);
  if (mention === 'none') return 'not_about_destination';
  if (mention === 'only_as_origin') return 'reverse_direction';

  const prices = findPrices(text);
  const single = prices.length === 1 ? prices[0] : undefined;
  const priceNote = prices.length > 1
    ? `Listing shows ${prices.length} different prices${new Set(prices.map((p) => p.currency)).size > 1 ? ' in different currencies (possibly combined)' : ''}; see pricesFound with context — no single price.`
    : null;
  // Durations need ≥2 days / ≥1 night ("seen 1 day ago" is not a trip length).
  const days = firstInt(text, /(\d{1,2})\s*(?:-|\s)?\s*(?:days?(?![a-z])|أيام|ايام|يوم)(?!\s*(?:ago|منذ))/i, 2);
  const nights = firstInt(text, /(\d{1,2})\s*(?:-|\s)?\s*(?:nights?|ليالي|ليالى|ليال|ليله|ليلة)/i, 1);
  const offer: TravelOfferResult = {
    id: offerId(url.toString(), title ?? ''),
    source_type: 'external_listing',
    status: 'listed_unverified',
    destination,
    country: null,
    provider: providerName(url),
    provider_url: url.toString(),
    title,
    days,
    nights: nights !== null && days !== null && nights > days ? null : nights,
    price_amount: single?.amount ?? null,
    price_currency: single?.currency ?? null,
    price_basis: single ? priceBasis(single.context) : null,
    travel_dates: null,
    inclusions: [],
    exclusions: [],
    retrieved_at: retrievedAt,
    verified_at: null,
    disclaimer: DISCLAIMER,
  };
  const valid = TravelOfferResultSchema.safeParse(offer);
  if (!valid.success) return 'contract_invalid';
  return {
    offer: valid.data,
    evidence: { snippet, publishedDate: hit.publishedDate, pricesFound: prices, listingType: listingType(title ?? '', url), priceNote },
  };
}
