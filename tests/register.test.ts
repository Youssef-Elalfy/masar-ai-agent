import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../server/src/agent/system-prompt.ts';
import { arabicRegister, mentionsDemoNotice, replyLanguage, styleIssues } from '../server/src/agent/style.ts';
import { loadCompanyFixture } from '../server/src/db/seed.ts';
import { ScriptedProvider, final, testApp } from './helpers.ts';

// Saved from the Round 2 live check (2026-11-04, gemini via the web API).
const LIVE_MSA_QUESTION = 'ما الفرق بين برنامج الغردقة وبرنامج شرم الشيخ من حيث السعر والمدة؟';
const LIVE_EGYPTIAN_ANSWER_TO_MSA =
  'من حيث المدة، الاتنين نفس الطول تقريباً:\n- **الغردقة (هروب للبحر الأحمر):** 4 أيام / 3 ليالٍ.\n- **شرم الشيخ (جنة سيناء):** 4 أيام / 3 ليالٍ.\n\nيعني برنامج الغردقة أوفر بحوالي 2,600 جنيه للإجمالي لشخصين، والاتنين بيعتمدوا على أجواء البحر والاسترخاء. تحب نعرف تفاصيل الأنشطة أو المزارات في واحد فيهم؟';
const LIVE_MIXED_QUESTION = 'طيب ممكن تقولي الـinclusions بتاعة الـSharm program؟';
const LIVE_FEMININE_DRIFT =
  'راجعت تفاصيل برنامج شرم الشيخ (جنة سيناء) في الكتالوج، وده اللي بيشمله البرنامج:\n\n- إقامة لمدة 3 ليالٍ.\n\nحابة أضيف إن الأسعار دي تجريبية لعرض الكتالوج والحجز الفعلي مش متاح. تحبني أساعدك بأي تفاصيل تانية عن البرنامج؟';

test('register detection: Modern Standard Arabic, Egyptian Arabic, English, and unclear text', () => {
  assert.equal(arabicRegister(LIVE_MSA_QUESTION), 'msa');
  assert.equal(arabicRegister('هل يمكنني معرفة أسعار الرحلات إلى الأقصر؟'), 'msa');
  assert.equal(arabicRegister('عايز أسافر مع مراتي في ديسمبر، إيه أحسن برنامج عندكم؟'), 'egyptian');
  assert.equal(arabicRegister('ممكن تفاصيل برنامج النوبة'), null); // no clear marker: no forced register
  assert.equal(replyLanguage('Is the Sharm price per person?'), 'english');
  assert.equal(replyLanguage(LIVE_MSA_QUESTION), 'msa');
  assert.equal(replyLanguage('3ayez r7la le sharm'), null);
});

test('saved live replies: an Egyptian answer to a formal question and feminine self-reference are flagged', () => {
  assert.deepEqual(styleIssues(LIVE_EGYPTIAN_ANSWER_TO_MSA, LIVE_MSA_QUESTION), ['register_mismatch']);
  assert.deepEqual(styleIssues(LIVE_FEMININE_DRIFT, LIVE_MIXED_QUESTION), ['self_gender']);
});

test('no false alarms: matching registers, second-person feminine, feminine nouns, the masculine self', () => {
  const msaAnswer = 'مدة البرنامجين متساوية: أربعة أيام وثلاث ليالٍ، بينما يبلغ سعر الغردقة 6,500 جنيه للفرد وشرم الشيخ 7,800 جنيه (أسعار تجريبية). هل ترغب في معرفة الأنشطة؟';
  assert.deepEqual(styleIssues(msaAnswer, LIVE_MSA_QUESTION), []);
  assert.deepEqual(styleIssues('أكيد! عندنا برنامج للغردقة 4 أيام. تحب أعرض لك التفاصيل؟', 'عايز أعرف إيه البرامج اللي عندكم للغردقة'), []);
  assert.deepEqual(styleIssues('تمام، حابة تعرفي تفاصيل أكتر عن البرنامج؟', 'أنا عايزة رحلة للأقصر مع صحابي'), []);
  assert.deepEqual(styleIssues('الرحلة جاهزة للعرض، والإقامة مريحة جداً على البحر.', 'عايز رحلة مريحة على البحر'), []);
  assert.deepEqual(styleIssues('حابب أضيف إن الحجز الفعلي مش متاح.', 'ينفع أحجز دلوقتي؟'), []);
});

test('demo-notice detection covers the Arabic and English phrasings the model uses', () => {
  assert.equal(mentionsDemoNotice('الأسعار دي تجريبية للعرض'), true);
  assert.equal(mentionsDemoNotice('Note: these are demo prices.'), true);
  assert.equal(mentionsDemoNotice('The cheapest program is Fayoum.'), false);
});

test('prompt: per-turn register hint and "disclaimer already given" fact; masculine self-reference rule', () => {
  const company = loadCompanyFixture();
  const now = new Date('2026-11-05T10:00:00Z');
  const msa = buildSystemPrompt(company, now, { summary: null, memory: null, replyLanguage: 'msa', demoNoticeGiven: true });
  assert.match(msa, /latest message is in Modern Standard Arabic/);
  assert.match(msa, /already told the customer earlier in this conversation/);
  const plain = buildSystemPrompt(company, now);
  assert.doesNotMatch(plain, /latest message is in|already told the customer/);
  assert.match(plain, /masculine singular/);
});

test('runtime: the disclaimer fact appears only after a reply already gave it; the hint follows each message', async () => {
  const systems: string[] = [];
  const provider = new ScriptedProvider((req, i) => {
    systems.push(req.system);
    return final(i === 0 ? 'أقل برنامج هو الفيوم بـ 3,200 جنيه للفرد (أسعار تجريبية).' : 'The Fayoum program is 2 days and 1 night.');
  });
  const app = await testApp(provider);
  const conversationId = await app.conversations.create('r-1');
  await app.runtime.runTurn({ conversationId, ownerId: 'r-1', userText: 'إيه أرخص برنامج عندكم دلوقتي؟' });
  await app.runtime.runTurn({ conversationId, ownerId: 'r-1', userText: 'How long is the Fayoum program?' });
  assert.match(systems[0] ?? '', /latest message is in Egyptian Arabic/);
  assert.doesNotMatch(systems[0] ?? '', /already told the customer/);
  assert.match(systems[1] ?? '', /latest message is in English/);
  assert.match(systems[1] ?? '', /already told the customer/);
});
