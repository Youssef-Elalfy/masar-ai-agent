import { normalizeDigits } from '../observability/redact.ts';

/**
 * Normalizes a phone number to E.164 (+digits). Egyptian mobiles accept local forms
 * (01xxxxxxxxx, 1xxxxxxxxx, +20/0020 prefixes, Arabic-Indic digits). Returns null when invalid.
 */
export function normalizePhone(raw: string): string | null {
  const s = normalizeDigits(raw).replace(/[\s\-().]/g, '');
  const digits = s.replace(/^\+/, '').replace(/^00/, '');
  if (!/^\d+$/.test(digits)) return null;
  if (/^01[0125]\d{8}$/.test(digits)) return `+2${digits}`;
  if (/^1[0125]\d{8}$/.test(digits)) return `+20${digits}`;
  if (/^201[0125]\d{8}$/.test(digits)) return `+${digits}`;
  // Other countries: plausible international number with an explicit + or 00 prefix.
  if ((s.startsWith('+') || s.startsWith('00')) && /^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return null;
}

/** "+201012345678" → "+20 10••••••78" (enough for the user to recognize, not to reuse). */
export function maskPhone(e164: string): string {
  if (e164.length < 7) return '••••';
  return `${e164.slice(0, 3)} ${e164.slice(3, 5)}${'•'.repeat(Math.max(2, e164.length - 7))}${e164.slice(-2)}`;
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '••••';
  return `${user.slice(0, 1)}•••@${domain}`;
}

/** "Ahmed Hassan" → "A••••• H•••••". */
export function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => `${[...w][0] ?? ''}${'•'.repeat(Math.max(1, [...w].length - 1))}`)
    .join(' ');
}
