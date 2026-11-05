/**
 * Search normalization for Arabic + English + Franco input. Applied identically to stored
 * search text and to queries: folds Arabic letter variants, strips diacritics, tatweel and the
 * definite article with its clitics (وال/بال/فال/كال/لل), lowercases Latin.
 */
export function normalizeForSearch(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '') // harakat, superscript alef, tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
    .map(stripArticle)
    .join(' ');
}

function stripArticle(word: string): string {
  if (word.length > 4 && /^[وفبك]ال/.test(word)) return word.slice(3);
  if (word.length > 4 && word.startsWith('لل')) return word.slice(2);
  if (word.length > 3 && word.startsWith('ال')) return word.slice(2);
  return word;
}

/** Equivalent travel terms across English, Arabic and Franco Arabic. */
const SYNONYM_GROUPS: string[][] = [
  ['sea', 'beach', 'بحر', 'شاطي', 'شاطئ', 'شط', 'ba7r', 'b7r', 'bahr'],
  ['desert', 'sahara', 'صحرا', 'صحراء', 'sa7ra'],
  ['culture', 'heritage', 'ثقافه', 'ثقافي', 'تراث', 'تاريخ', 'history'],
  ['nile', 'نيل'],
  ['family', 'عائلي', 'عيله', 'اسره', 'عائله'],
  ['adventure', 'مغامره', 'mughamra'],
  ['relaxation', 'resort', 'استجمام', 'استرخاء', 'منتجع', 'راحه'],
  ['snorkeling', 'diving', 'غطس', 'سنوركل'],
  ['nature', 'طبيعه'],
  ['budget', 'cheap', 'اقتصادي', 'رخيص'],
].map((group) => group.map(normalizeForSearch));

const STOPWORDS = new Set(
  ['the', 'and', 'for', 'with', 'trip', 'trips', 'package', 'packages', 'tour', 'رحله', 'رحلات', 'برنامج', 'برامج',
    'عايز', 'عاوز', 'عايزين', 'على', 'الي', 'الى', 'من', 'في', 'عن', 'عند', 'عندكم', '3ayez', 'r7la', '3al'].map(normalizeForSearch),
);

/** Stored search text: normalized words plus every synonym of any word that belongs to a group. */
export function buildSearchText(parts: string[]): string {
  const words = new Set(normalizeForSearch(parts.join(' ')).split(' ').filter(Boolean));
  for (const group of SYNONYM_GROUPS) {
    if (group.some((term) => words.has(term))) for (const term of group) words.add(term);
  }
  return [...words].join(' ');
}

/** Query tokens worth matching (drops stopwords and 1–2 letter fragments). */
export function queryTokens(text: string): string[] {
  return normalizeForSearch(text).split(' ').filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Token matches when some stored word starts with it (so "غردق" matches "غردقه", "في" never matches "فيوم"). */
export function tokenMatches(searchText: string, token: string): boolean {
  return searchText.split(' ').some((word) => word.startsWith(token));
}
