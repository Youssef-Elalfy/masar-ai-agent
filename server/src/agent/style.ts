/**
 * Style guard: a small, high-precision check on the final reply. Like the grounding guard, a reply with an issue is
 * held back once per turn and the model rewrites it (the customer never sees the draft). It never edits text itself:
 * fixing wording with string replacements would be fragile, so only clear, rule-level problems are detected.
 */
export type StyleIssue = 'language_mismatch' | 'register_mismatch' | 'self_gender' | 'meta_project_mention' | 'pet_name';

const LETTER = /\p{L}/gu;
const ARABIC = /\p{Script=Arabic}/u;
const URL_OR_CODE = /https?:\/\/\S+|`{3}[\s\S]*?`{3}|`[^`]*`/g;
// Franco Arabic ("3ayez r7la", "2ana"): Latin letters with digits standing for Arabic sounds. Answered in Arabic.
const FRANCO = /\b[a-z]*[2356789][a-z]+\b|\b[a-z]+[2356789][a-z]*\b/i;
// The customer chose a language explicitly ("answer in English", "رد بالعربي", "translate").
const LANGUAGE_REQUEST = /\b(in|into)\s+(english|arabic)\b|\btranslate\b|بال(عربي|عربية|انجليزي|إنجليزي|انجليزية|إنجليزية)|ترجم/i;
// Development/meta details a customer did not ask about (live finding: "demo data for this university project").
const META = /universit(y|ies)|graduation project|college project|student project|جامع(ي|ة|ية)|مشروع (تخرج|جامعي|التخرج)|system prompt|test(ing)? (mode|environment)|بيئة اختبار/i;
const ASKED_ABOUT_ORIGIN = /\b(who|what)\b.*\b(built|made|created|developed|behind|are you)\b|universit|project|مين|مشروع|جامع|تخرج|اتعملت|اتبنيت|صممك|طورك/i;
const PET_NAMES = /حبايبي|حبيبي|حبيبتي|يا قلبي|يا روحي/;

// Arabic register markers: frequent words that belong clearly to one register (ambiguous words are left out).
const EGYPTIAN = ['عايز', 'عايزة', 'عايزين', 'عاوز', 'إيه', 'ايه', 'إزاي', 'ازاي', 'ده', 'دي', 'دول', 'كده', 'كدا', 'فين', 'ليه', 'مش', 'بتاع', 'بتاعة', 'بتاعت', 'بتاعك', 'دلوقتي', 'عشان', 'علشان', 'بقى', 'أوي', 'اوي', 'خالص', 'النهارده', 'إمبارح', 'زي', 'لسه', 'طيب', 'الاتنين', 'اتنين', 'تحب', 'تحبي', 'إحنا', 'احنا', 'هنعمل', 'هتلاقي'];
const MSA = ['ماذا', 'لماذا', 'هل', 'الذي', 'التي', 'الذين', 'أريد', 'اريد', 'أود', 'نود', 'كيف', 'أين', 'متى', 'هذا', 'هذه', 'هؤلاء', 'ليس', 'ليست', 'سوف', 'لدي', 'لديكم', 'لدينا', 'يمكن', 'يمكنني', 'يمكنك', 'حيث', 'ينبغي', 'أيضًا', 'أيضاً', 'عندما', 'الآن', 'ترغب', 'تودّ', 'تود'];
const AR_WORD = /[\p{Script=Arabic}ً-ْ]+/gu;
const DIACRITICS = /[ً-ْ]/g;
function markerCounts(text: string): { egyptian: number; msa: number } {
  const words = (text.replace(URL_OR_CODE, ' ').match(AR_WORD) ?? []).map((w) => w.replace(DIACRITICS, ''));
  let egyptian = 0;
  let msa = /^\s*ما\s/u.test(text) ? 1 : 0; // "ما الفرق …؟" opens a formal question
  for (const w of words) {
    if (EGYPTIAN.includes(w)) egyptian++;
    else if (MSA.includes(w)) msa++;
  }
  return { egyptian, msa };
}

/** Register of clearly Arabic text: 'msa' or 'egyptian' when the markers agree, otherwise null (mixed or unclear). */
export function arabicRegister(text: string): 'msa' | 'egyptian' | null {
  if (clearLanguage(text) !== 'ar') return null;
  const { egyptian, msa } = markerCounts(text);
  if (msa >= 2 && egyptian === 0) return 'msa';
  if (egyptian >= 1 && egyptian > msa) return 'egyptian';
  return null;
}

/** Language the reply should use, from the latest customer message only (null when unclear: no hint is given). */
export function replyLanguage(userText: string): 'english' | 'msa' | 'egyptian' | null {
  const lang = clearLanguage(userText);
  if (lang === 'en') return 'english';
  if (lang === 'ar') return arabicRegister(userText);
  return null;
}

// The assistant speaks of itself in the masculine singular. A feminine first-person form ("حابة أضيف", "أنا متأكدة")
// is drift (live finding). Second person ("حابة تعرفي؟", addressing a woman) is not matched: it needs "أنا" or a
// following first-person verb (أ…).
const SELF_FEMININE = /(?:^|[^\p{L}])(?:أنا\s+(?:حابة|حابه|مبسوطة|متأكدة|آسفة|اسفة|سعيدة|مستعدة|فاهمة|عارفة|شايفة)|(?:حابة|حابه|مبسوطة|متأكدة|آسفة|اسفة|سعيدة|مستعدة)\s+أ\p{Script=Arabic}+)/u;

/** Did this assistant text already tell the customer the company / prices are demos? */
export function mentionsDemoNotice(text: string): boolean {
  return /تجريبي|تجريبية|للعرض فقط|\bdemo\b|illustrative/i.test(text);
}

function arabicShare(text: string): { share: number; letters: number } {
  const letters = text.replace(URL_OR_CODE, ' ').match(LETTER) ?? [];
  if (letters.length === 0) return { share: 0, letters: 0 };
  return { share: letters.filter((c) => ARABIC.test(c)).length / letters.length, letters: letters.length };
}

/** 'ar' | 'en' when the text is clearly one language; null for mixed, very short, Franco or number-only text. */
export function clearLanguage(text: string): 'ar' | 'en' | null {
  const { share, letters } = arabicShare(text);
  if (letters < 8) return null;
  if (share >= 0.6) return 'ar';
  if (share <= 0.1 && !FRANCO.test(text)) return 'en';
  return null;
}

export function styleIssues(reply: string, userText: string): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const asked = clearLanguage(userText);
  const answered = clearLanguage(reply);
  const languageRequested = LANGUAGE_REQUEST.test(userText);
  if (asked && answered && asked !== answered && !languageRequested) issues.push('language_mismatch');
  if (asked === 'ar' && answered === 'ar' && !languageRequested) {
    const wanted = arabicRegister(userText);
    const got = markerCounts(reply);
    // Formal question, clearly colloquial answer (live finding) — or the reverse, with a stricter threshold.
    if (wanted === 'msa' && got.egyptian >= 2 && got.egyptian > got.msa) issues.push('register_mismatch');
    else if (wanted === 'egyptian' && got.msa >= 4 && got.egyptian === 0) issues.push('register_mismatch');
  }
  if (SELF_FEMININE.test(reply)) issues.push('self_gender');
  if (META.test(reply) && !ASKED_ABOUT_ORIGIN.test(userText)) issues.push('meta_project_mention');
  if (PET_NAMES.test(reply) && !PET_NAMES.test(userText)) issues.push('pet_name');
  return issues;
}

const FIX: Record<StyleIssue, (userText: string) => string> = {
  language_mismatch: (userText) =>
    `Reply in the language of the customer's latest message (${clearLanguage(userText) === 'en' ? 'English' : 'Arabic, in the same register they used'}), unless they asked for another language.`,
  meta_project_mention: () =>
    'Do not mention universities, graduation projects, testing or how this assistant was built (the customer did not ask). Keep the customer-relevant facts: the company is a demo and its prices are demo prices.',
  pet_name: () => 'Do not use pet names or terms of endearment.',
  register_mismatch: (userText) =>
    arabicRegister(userText) === 'msa'
      ? 'The customer wrote in Modern Standard Arabic: answer in clear, neutral Modern Standard Arabic throughout, with no Egyptian colloquial words (such as عايز، إيه، ده، كده، تحب، الاتنين).'
      : 'The customer wrote in Egyptian Arabic: answer naturally in Egyptian Arabic throughout, not in formal Modern Standard Arabic.',
  self_gender: () => 'Refer to yourself in the masculine singular consistently (حابب، متأكد، مبسوط), never in the feminine.',
};

/** Runtime note sent back to the model (never shown to the customer; the transcript view hides the held-back draft). */
export function styleNote(issues: StyleIssue[], userText: string): string {
  return (
    '[Automatic runtime check — not written by the customer] Rewrite your previous reply for the customer. ' +
    issues.map((i) => FIX[i](userText)).join(' ') +
    ' Keep the same facts and tool results; call a tool only if the answer needs one. Do not mention this check.'
  );
}

export const RUNTIME_NOTE_PREFIX = '[Automatic runtime check';
