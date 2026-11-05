import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT } from '../../server/src/config.ts';
import { createApp } from '../../server/src/app.ts';
import type { CompletionRequest, CompletionResponse } from '../../server/src/agent/providers/types.ts';
import type { WebSearch } from '../../server/src/research/tavily.ts';
import type { SpeechToText } from '../../server/src/voice/stt.ts';
import { createWebHandler } from '../../server/src/web/server.ts';
import { OwnerSessions } from '../../server/src/web/session.ts';
import { ScriptedProvider, final, testConfig, toolUse } from '../../tests/helpers.ts';
import { createTestSql } from '../../tests/pglite-sql.ts';

/**
 * TEST-ONLY server for Playwright E2E. Real HTTP layer, agent runtime, tools, catalog SQL (PGlite with the real
 * migrations), approvals, memory consent and CRM; the LLM is a deterministic script, web search replays the
 * recorded real Tavily fixture, and STT returns a fixed transcript. Never used outside `npm run e2e`.
 */

const lastText = (req: CompletionRequest): string => {
  const last = req.messages.at(-1);
  return last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ') ?? '';
};
const lastIsToolResult = (req: CompletionRequest) => req.messages.at(-1)?.content.some((b) => b.type === 'tool_result') === true;
const LEAD = { name: 'Test User', phone: '01012345678', destination: 'Sharm El Sheikh' };

function script(req: CompletionRequest): CompletionResponse | Promise<CompletionResponse> {
  // The style guard asks for a rewrite when a scripted Arabic answer follows an English message: repeat it (accepted once).
  if (lastText(req).startsWith('[Automatic runtime check') && !/catalog lookup/.test(lastText(req))) {
    const previous = req.messages.at(-2)?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ') ?? '';
    return final(previous);
  }
  if (lastIsToolResult(req)) {
    const results = req.messages.at(-1)?.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : [])).join(' ') ?? '';
    if (/APPROVAL_REQUIRED|approval request was shown/i.test(results)) return final('محتاج موافقتك الأول على حفظ بيانات التواصل (CRM تجريبي).');
    if (/"reference"/.test(results)) return final('اتسجل طلبك في الـCRM التجريبي. مفيش حجز ولا دفع.');
    if (/external_listing|listed_unverified/.test(results)) return final('دي **قوائم خارجية** من مواقع تانية، والتوافر مش مؤكد. راجع المصدر قبل أي قرار.');
    if (/consent|memory/i.test(results)) return final('هيظهرلك طلب موافقة رسمي على الذاكرة.');
    return final('لقيت البرامج دي في الكتالوج (**أسعار تجريبية**):\n\n- راجع الكروت تحت\n- تقدر تسأل عن التفاصيل');
  }
  const text = lastText(req);
  if (/وافقت، كمّل|Approved\. Please go ahead/.test(text)) return toolUse({ id: `lead-${req.messages.length}`, name: 'create_lead', input: LEAD });
  if (/سجلني|register me/i.test(text)) return toolUse({ id: `lead-${req.messages.length}`, name: 'create_lead', input: LEAD });
  if (/تركيا|Turkey/i.test(text)) return toolUse({ id: `r-${req.messages.length}`, name: 'research_external_packages', input: { destination: 'Turkey', days: 7, departureCity: 'Cairo' } });
  if (/افتكر|remember/i.test(text)) return toolUse({ id: `m-${req.messages.length}`, name: 'request_memory_consent', input: {} });
  if (/شرم|الغردقة|Sharm|Hurghada/i.test(text)) return toolUse({ id: `s-${req.messages.length}`, name: 'search_company_packages', input: { query: 'الغردقة شرم الشيخ', maxPricePerPerson: 8000, budgetCurrency: 'EGP', adults: 2 } });
  // Typography fixture (lists in Arabic / English): bullets, numbered steps, a long wrapping item, a heading.
  if (/اعرض قائمة/.test(text)) {
    return final([
      'ده ملخص سريع لبرنامج **جنة سيناء** (أسعار تجريبية):',
      '',
      '### المميزات',
      '- إقامة 3 ليالٍ على البحر مباشرةً',
      '- **السعر:** 7,800 جنيه للفرد في الغرفة المزدوجة، والإجمالي لشخصين 15,600 جنيه، مع إمكانية مراجعة التفاصيل قبل أي طلب عرض سعر',
      '- مواصلات من وإلى المطار',
      '',
      '### خطوات اليوم الأول',
      '1. الوصول وتسجيل الدخول',
      '2. جولة على الشاطئ',
      '3. عشاء ترحيبي',
      '',
      'تحب أعرض لك تفاصيل الأيام التانية؟',
    ].join('\n'));
  }
  if (/show a list/i.test(text)) {
    return final(['Here is a quick summary:', '', '- 3 nights by the sea', '- **Price:** 7,800 EGP per person (demo)', '', '1. Arrival and check-in', '2. Beach walk', '3. Welcome dinner'].join('\n'));
  }
  if (/slow|بطيء/i.test(text)) {
    // Long turn for the stop-button test; honors cancellation like a real provider.
    return new Promise<CompletionResponse>((resolve, reject) => {
      const timer = setTimeout(() => resolve(final('done')), 8000);
      req.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
  }
  return final('أهلاً! أنا مسار، مساعد ذكاء اصطناعي لشركة سياحة تجريبية. تحب أساعدك في إيه؟');
}

const Fixture = z.object({ hits: z.array(z.object({ title: z.string(), url: z.string(), content: z.string(), publishedDate: z.string().nullable() })) });
const { hits } = Fixture.parse(JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'tests', 'fixtures', 'tavily-turkey-2026-11-03.json'), 'utf8')));
// E2E_SEARCH_DELAY_MS (visual QA only) keeps the fixture search "running" long enough to capture the searching state.
const searchDelay = Number(process.env['E2E_SEARCH_DELAY_MS'] ?? 0);
const webSearch: WebSearch = {
  id: 'tavily-fixture',
  search: async () => {
    if (searchDelay > 0) await new Promise((r) => setTimeout(r, searchDelay));
    return { hits, credits: 0 };
  },
};
const stt: SpeechToText = {
  label: 'e2e/fake-stt',
  transcribe: async () => ({ text: 'عايز شرم الشيخ أربع أيام', language: 'arabic', durationSec: 2.4, lowConfidence: false, model: 'fake' }),
};

const provider = new ScriptedProvider((req) => script(req));
const app = await createApp(testConfig({ piiEncryptionKey: randomBytes(32).toString('base64') }), provider, await createTestSql(), null, { seedDemo: true, webSearch });
const handler = createWebHandler({
  app,
  stt,
  sessions: new OwnerSessions(randomBytes(32)),
  staticDir: path.join(PROJECT_ROOT, 'client', 'dist'),
  status: {
    company: { name: app.company.name, fictional: true },
    model: 'e2e-scripted',
    freeTierOnly: true,
    features: { voiceNotes: true, webResearch: true, crm: true, memoryRetrieval: app.memory.retrievalBackend },
  },
  limits: { turnsPerMinute: 1000, globalTurnsPerMinute: 1000, voicePerMinute: 1000 },
});
const port = Number(process.env['E2E_PORT'] ?? 8799);
createServer((req, res) => void handler(req, res)).listen(port, '127.0.0.1', () => console.log(`E2E server on http://127.0.0.1:${port}`));
