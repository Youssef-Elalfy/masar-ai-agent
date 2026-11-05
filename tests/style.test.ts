import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../server/src/agent/system-prompt.ts';
import { clearLanguage, styleIssues, styleNote } from '../server/src/agent/style.ts';
import { loadCompanyFixture } from '../server/src/db/seed.ts';
import { buildTranscript } from '../server/src/web/views.ts';
import type { CompletionRequest } from '../server/src/agent/providers/types.ts';
import { ScriptedProvider, final, testApp } from './helpers.ts';

// Saved replies from the live check of 2026-11-04 (gemini-3.5-flash-lite via the web API).
const LIVE = {
  englishCheapest:
    'I checked the company catalog. The cheapest program per person is:\n\n- **Fayoum Desert Adventure (مغامرة الفيوم)**\n  - **Duration:** 2 days / 1 night\n  - **Price:** 3,200 EGP per person\n  - *(Note: All prices are demo/illustrative data for this university project).*',
  englishCapabilities:
    "I cannot book or issue flights, as flight ticketing and live booking are not supported in this demo. \n\nRegarding your preferences, long-term memory is currently turned off. If you'd like me to remember your travel preferences for future conversations, I can set that up for you—just let me know, and I'll send a request for you to confirm.",
  arabicHurghada:
    'أهلاً بيك! راجعت كتالوج الشركة ولقيت رحلة واحدة متاحة للغردقة مدتها 4 أيام (3 ليالي):\n\n- **اسم الرحلة:** هروب للبحر الأحمر (Red Sea Escape)\n- **المدة:** 4 أيام / 3 ليالي\n- **السعر:** 6,500 جنيه للفرد في الغرفة المزدوجة *(ملاحظة: هذه الأسعار تجريبية للعرض في المشروع التجريبي)*.',
};

// Saved scenarios: [customer message, reply, expected issues].
const SCENARIOS: Array<[string, string, string[]]> = [
  ['Which of your programs is the cheapest per person?', LIVE.englishCheapest, ['meta_project_mention']],
  ['Can you book flights for me, and can you remember my preferences for next time?', LIVE.englishCapabilities, []],
  ['أهلاً، عايز رحلة للغردقة 4 أيام، إيه المتاح؟', LIVE.arabicHurghada, []],
  // M6 live finding: an English question answered in Arabic.
  ['What is the best time of year to visit Nubia?', 'أحسن وقت لزيارة النوبة هو من أكتوبر لحد أبريل، الجو بيبقى لطيف ومناسب للرحلات النيلية.', ['language_mismatch']],
  ['عايز أعرف أحسن وقت أزور فيه أسوان', 'The best time to visit Aswan is from October to April, when the weather is mild.', ['language_mismatch']],
  // Modern Standard Arabic in, MSA out; mixed in, mixed out; Franco in, Arabic out.
  ['ما هي أفضل الوجهات الشتوية في مصر؟', 'من أفضل الوجهات الشتوية في مصر: الأقصر وأسوان لاعتدال الطقس، والغردقة للشواطئ.', []],
  ['عايز trip رخيصة للـweekend', 'عندك اختيار حلو: الفيوم يومين وليلة، وده أرخص برنامج عندنا (أسعار تجريبية).', []],
  ['3ayez r7la le sharm', 'تمام! عندنا برنامج لشرم الشيخ 4 أيام / 3 ليالي. تحب أعرض لك التفاصيل؟', []],
  // The customer asked about the language or the project: allowed.
  ['ممكن ترد بالإنجليزي؟', 'Sure, I will reply in English from now on. How can I help with your trip?', []],
  ['Who built you?', 'I am a demo AI travel assistant built as a university project; the company and its prices are demonstrations.', []],
  // Pet names are not used unless the customer used them first.
  ['عندكم رحلات للأقصر؟', 'أيوه يا حبيبي، عندنا برنامج للأقصر.', ['pet_name']],
  // Short, numeric or link-only messages have no clear language: never flagged.
  ['8000', 'Got it: a budget of 8,000 EGP. Per person or in total?', []],
  ['https://example.com/offer', 'ده لينك لعرض خارجي، أقدر أساعدك تقارنه ببرامج الشركة.', []],
];

test('saved scenarios: the style guard flags exactly the known problems and nothing else', () => {
  for (const [userText, reply, expected] of SCENARIOS) {
    assert.deepEqual(styleIssues(reply, userText), expected, `${userText} → ${reply.slice(0, 60)}`);
  }
});

test('language detection ignores links and code, and stays silent on Franco or very short text', () => {
  assert.equal(clearLanguage('شوف المصدر هنا https://www.example.com/turkey-tours-from-cairo-7-days'), 'ar');
  assert.equal(clearLanguage('3ayez r7la le sharm el sheikh'), null);
  assert.equal(clearLanguage('ok'), null);
  assert.equal(clearLanguage('Which of your programs is cheapest?'), 'en');
});

test('the rewrite note names the fix and keeps the honest demo facts', () => {
  const note = styleNote(['meta_project_mention', 'language_mismatch'], 'Which program is cheapest?');
  assert.match(note, /^\[Automatic runtime check/);
  assert.match(note, /English/);
  assert.match(note, /demo prices/);
});

test('prompt: no university-project framing reaches the model unasked; honesty and writing guidance are present', () => {
  const prompt = buildSystemPrompt(loadCompanyFixture(), new Date('2026-11-04T10:00:00Z'));
  const identity = prompt.split('\n')[0] ?? '';
  assert.doesNotMatch(identity, /university/i);
  assert.match(identity, /FICTIONAL demo travel company/);
  assert.match(identity, /real booking is not available/);
  assert.match(prompt, /Only if the customer asks who built you/);
  assert.match(prompt, /تحب، عايز، إزاي/);
  assert.match(prompt, /Do not repeat the same disclaimer in every reply/);
});

const lastText = (req: CompletionRequest | undefined) => req?.messages.at(-1)?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') ?? '';

test('runtime: a reply in the wrong language is held back once and rewritten; the customer sees only the rewrite', async () => {
  const provider = new ScriptedProvider((req, i) => {
    if (i === 0) return final('أحسن وقت لزيارة النوبة من أكتوبر لحد أبريل.');
    assert.match(lastText(req), /^\[Automatic runtime check.*English/);
    return final('The best time to visit Nubia is from October to April.');
  });
  const app = await testApp(provider);
  const conversationId = await app.conversations.create('s-1');
  const events: string[] = [];
  const off = app.tracer.onEvent((e) => { if (e.kind === 'style_check') events.push(e.issues.join(',')); });
  const result = await app.runtime.runTurn({ conversationId, ownerId: 's-1', userText: 'What is the best time to visit Nubia?' });
  off();
  assert.equal(result.status, 'completed');
  assert.equal(result.styleCorrections, 1);
  assert.equal(result.text, 'The best time to visit Nubia is from October to April.');
  assert.deepEqual(events, ['language_mismatch']);
  const items = buildTranscript(await app.conversations.load(conversationId, 's-1'));
  assert.deepEqual(items.map((i) => i.text), ['What is the best time to visit Nubia?', 'The best time to visit Nubia is from October to April.']);
});

test('runtime: the style guard rewrites at most once per turn (bounded free-tier usage)', async () => {
  const provider = new ScriptedProvider(() => final('All prices here are demo data for this university project.'));
  const app = await testApp(provider);
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create('s-2'), ownerId: 's-2', userText: 'Which program is the cheapest?' });
  assert.equal(provider.requests.length, 2);
  assert.equal(result.styleCorrections, 1);
  assert.equal(result.status, 'completed');
});

test('runtime: a clean reply costs no extra model call', async () => {
  const provider = new ScriptedProvider(() => final('The cheapest program is Fayoum, 3,200 EGP per person (demo prices).'));
  const app = await testApp(provider);
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create('s-3'), ownerId: 's-3', userText: 'Which program is the cheapest?' });
  assert.equal(provider.requests.length, 1);
  assert.equal(result.styleCorrections, 0);
});
