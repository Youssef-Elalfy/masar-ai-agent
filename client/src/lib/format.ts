import type { Lang } from './i18n.ts';

const CURRENCY_AR: Record<string, string> = { EGP: 'جنيه', USD: 'دولار', EUR: 'يورو', TRY: 'ليرة تركي', SAR: 'ريال', AED: 'درهم', GBP: 'جنيه إسترليني' };

/** Money exactly as the source gave it: Western digits in both languages, no conversion, no rounding beyond 2 decimals. */
export function formatMoney(amount: number, currency: string, lang: Lang): string {
  const n = new Intl.NumberFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', { maximumFractionDigits: 2 }).format(amount);
  return lang === 'ar' ? `${n} ${CURRENCY_AR[currency] ?? currency}` : `${n} ${currency}`;
}

/** Date + time in Cairo (where the demo company operates). */
export function formatCairo(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    timeZone: 'Africa/Cairo', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

export type DateGroup = 'today' | 'yesterday' | 'earlier';
export function dateGroup(iso: string, now = new Date()): DateGroup {
  const key = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(d);
  const d = new Date(iso);
  if (key(d) === key(now)) return 'today';
  if (key(d) === key(new Date(now.getTime() - 86_400_000))) return 'yesterday';
  return 'earlier';
}

/** Arabic text detection for per-message direction. */
export const isArabic = (text: string) => /[؀-ۿ]/.test(text);
