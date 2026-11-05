const SENSITIVE_KEY = /(phone|mobile|whatsapp|e_?mail|passport|national_?id|address|contact|^name$|full_?name|first_?name|last_?name|customer_?name)/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Egyptian mobiles (01x…, +201x…), any +international number, and long digit runs (cards, IDs).
const EG_MOBILE = /(?<![\d+])(?:\+?20[\s-]?)?0?1[0125][\s-]?\d{4}[\s-]?\d{4}(?!\d)/g;
const INTL_PHONE = /(?<!\d)\+\d[\d\s-]{7,}\d(?!\d)/g;
const LONG_DIGITS = /\d{10,}/g;

/** Arabic-Indic and Persian digits → ASCII, so ٠١٠١٢٣٤٥٦٧٨ is caught like 01012345678. */
export function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function redactText(text: string): string {
  return normalizeDigits(text)
    .replace(EMAIL, '[REDACTED_EMAIL]')
    .replace(INTL_PHONE, '[REDACTED_PHONE]')
    .replace(EG_MOBILE, '[REDACTED_PHONE]')
    .replace(LONG_DIGITS, '[REDACTED_NUMBER]');
}

/** Deep-copies a JSON-like value with PII-shaped keys and strings masked, for trace storage. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactValue(v)]));
  }
  return value;
}
