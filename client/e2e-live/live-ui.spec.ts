import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * LIVE UI check against the real server (`npm run web` on :8787): Gemini free tier, Supabase, Tavily (≈2 credits),
 * Groq Whisper (1 call). Not part of `npm run e2e`. Uses a fake name/phone; everything created is deleted at the end.
 * Run: npm run build:client && npm run web   (then)   npx playwright test -c client/playwright.live.config.ts
 */

const REPORTS = fileURLToPath(new URL('../../reports/', import.meta.url));
const VOICE_FILE = fileURLToPath(new URL('../../.tmp/voice-samples/T043_eg_arabic.wav', import.meta.url));
const shot = (page: Page, name: string) => page.screenshot({ path: `${REPORTS}ui-screenshots/live-${name}.png` });
const composer = (page: Page) => page.locator('#composer');
const results: Record<string, unknown> = { ranAt: new Date().toISOString(), server: 'http://127.0.0.1:8787' };
const ONLY = (process.env['LIVE_ONLY'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (step: string) => ONLY.length === 0 || ONLY.includes(step);
if (ONLY.length > 0) results['only'] = ONLY;

async function waitForTurn(page: Page) {
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 150_000 });
}
const log = (m: string) => console.log(`[live ${new Date().toISOString().slice(11, 19)}] ${m}`);
const PROVIDER_DOWN = /temporary problem reaching the AI service|مشكلة مؤقتة في الاتصال بخدمة الذكاء الاصطناعي/;

async function send(page: Page, text: string) {
  log(`send: ${text.slice(0, 60)}`);
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 10_000 }).catch(() => undefined);
  await waitForTurn(page);
  log('turn finished');
}
const lastAnswer = (page: Page) => page.getByRole('log').locator('.md').last();
const answerText = async (page: Page) => (await lastAnswer(page).innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 300);
async function toolsOfLastAnswer(page: Page): Promise<string[]> {
  const toggle = page.getByRole('button', { name: /Used \d+ tool/ }).last();
  if ((await toggle.count()) === 0) return [];
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return (await toggle.locator('xpath=following-sibling::ul[1]/li').allInnerTexts()).map((t) => t.trim());
}

test('live UI: Tavily listings, memory save/forget, CRM approval, Groq voice note, cleanup', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  mkdirSync(`${REPORTS}ui-screenshots`, { recursive: true });
  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible();

  try {
    if (want('research')) await test.step('external research (Tavily, ≈2 credits)', async () => {
      await send(page, 'Find me offers for a 7-day trip to Turkey from Cairo in December.');
      const first = await answerText(page);
      const failedSend = await page.getByRole('alert').allInnerTexts();
      results['firstTurn'] = { answer: first, alerts: failedSend };
      if (PROVIDER_DOWN.test(first) || (!first && failedSend.length > 0)) {
        results['blocked'] = 'All free-tier LLM providers unavailable (quota/overload); the UI showed the honest fallback message.';
        log('BLOCKED: provider unavailable');
        await shot(page, 'provider-unavailable');
        throw new Error('BLOCKED_PROVIDER');
      }
      log('research: reading cards');
      const notice = page.getByText(/External research: \d+ result\(s\) via|External search unavailable/).first();
      await expect.soft(notice).toBeVisible({ timeout: 5_000 });
      const cards = page.getByText('External · Availability not verified');
      const hrefs = await page.getByRole('link', { name: 'View original source' }).evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
      results['research'] = {
        notice: (await notice.count()) ? await notice.innerText() : null,
        externalCards: await cards.count(),
        allHttps: hrefs.every((h) => h.startsWith('https://')),
        tools: await toolsOfLastAnswer(page),
        answerStart: await answerText(page),
      };
      expect.soft(await cards.count()).toBeGreaterThan(0);
      expect.soft(hrefs.every((h) => h.startsWith('https://'))).toBe(true);
      await shot(page, 'research');
    });

    if (want('memory')) await test.step('memory: consent → save → visible → forget', async () => {
      await send(page, 'Please remember that I prefer beach trips.');
      const dialog = page.getByRole('dialog', { name: 'Remember your preferences?' });
      let viaModel = true;
      if (!(await dialog.isVisible())) {
        viaModel = false; // the model did not ask; the customer can still opt in from the Memory panel
        await page.getByRole('button', { name: 'Turn memory on' }).click();
      }
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      results['memoryConsentText'] = (await dialog.innerText({ timeout: 5_000 })).slice(0, 400);
      await shot(page, 'consent');
      await dialog.getByRole('button', { name: 'Allow' }).click();
      await expect(dialog).toHaveCount(0);
      await waitForTurn(page); // the client sends "I agreed to turn memory on." so the agent can save it
      await expect.soft(page.getByText('On', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      let items = page.getByRole('button', { name: /^Forget: / });
      if ((await items.count()) === 0) {
        await send(page, 'Yes, please save that I prefer beach trips.');
        items = page.getByRole('button', { name: /^Forget: / });
      }
      results['memory'] = {
        consentAskedByModel: viaModel,
        savedItems: await items.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
        tools: await toolsOfLastAnswer(page),
      };
      expect.soft(await items.count()).toBeGreaterThan(0);
      await shot(page, 'memory-saved');
      while ((await items.count()) > 0) {
        const before = await items.count();
        await items.first().click();
        await expect(items).toHaveCount(before - 1, { timeout: 10_000 });
      }
      await expect.soft(page.getByText('Nothing saved')).toBeVisible();
    });

    if (want('crm')) await test.step('CRM: approval card → approve → demo CRM reference', async () => {
      await send(page, 'I want a quote for the Sharm El Sheikh program. My name is Test Live and my phone is 01012345678. Please register my request.');
      const card = page.getByRole('group', { name: /Approval needed/ });
      if ((await card.count()) === 0) await send(page, 'Yes, please go ahead and save my contact details.');
      await expect.soft(card.first()).toBeVisible({ timeout: 5_000 });
      if ((await card.count()) > 0) {
        const preview = await card.first().innerText({ timeout: 5_000 });
        results['crmPreviewMasked'] = !preview.includes('01012345678');
        expect.soft(preview).not.toContain('01012345678');
        await shot(page, 'crm-approval');
        await card.first().getByRole('button', { name: 'Approve' }).click();
        await page.waitForTimeout(500);
        await waitForTurn(page);
        // A quote request may need its own approval after the lead.
        for (let i = 0; i < 2; i++) {
          const next = page.getByRole('group', { name: /Approval needed/ });
          if ((await next.count()) === 0) break;
          await next.first().getByRole('button', { name: 'Approve' }).click();
          await page.waitForTimeout(500);
          await waitForTurn(page);
        }
      }
      const records = page.getByText(/(Contact lead \(demo CRM\)|Quote request|Human review request) · R[LQH]-/);
      results['crm'] = { records: await records.allInnerTexts(), tools: await toolsOfLastAnswer(page), answerStart: await answerText(page) };
      expect.soft(await records.count()).toBeGreaterThan(0);
      await shot(page, 'crm-saved');
    });

    if (want('voice')) await test.step('voice note: upload a WAV → Groq Whisper → review → send', async () => {
      await page.getByRole('button', { name: 'New conversation' }).click();
      await page.locator('input[type="file"]').setInputFiles(VOICE_FILE);
      await expect(page.locator('p:not(.sr-only)', { hasText: 'Review the transcript before sending' })).toBeVisible({ timeout: 90_000 });
      const transcript = await composer(page).inputValue();
      results['voiceTranscript'] = transcript;
      expect.soft(transcript).toMatch(/غردق/);
      await shot(page, 'voice-review');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await waitForTurn(page);
      const hurghada = page.getByRole('article', { name: 'Red Sea Escape' });
      results['voiceTurn'] = { hurghadaCard: await hurghada.count(), tools: await toolsOfLastAnswer(page), answerStart: await answerText(page) };
      await expect.soft(hurghada.first()).toContainText('6,500 EGP', { timeout: 5_000 });
      await shot(page, 'voice-answer');
    });
  } finally {
    await test.step('cleanup: CRM records, memory consent, conversations', async () => {
      const crmDelete = page.getByRole('button', { name: 'Delete all my requests' });
      if (await crmDelete.count()) {
        await crmDelete.click();
        await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
        await expect.soft(page.getByText('No saved requests.')).toBeVisible({ timeout: 10_000 });
      }
      const memoryOff = page.getByRole('button', { name: 'Turn off and delete' });
      if (await memoryOff.count()) {
        await memoryOff.click();
        await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
      }
      for (let i = 0; i < 6; i++) {
        const del = page.getByRole('button', { name: /^Delete conversation: / });
        if ((await del.count()) === 0) break;
        await del.first().click();
        await page.getByRole('dialog', { name: 'Delete this conversation?' }).getByRole('button', { name: 'Delete' }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
      // Verify against the server (same browser cookie), not the sidebar: a stale list must not report "0 left".
      const headers = { 'x-rahhal-client': 'web' };
      const left = (await (await page.request.get('/api/conversations', { headers })).json()) as { conversations: Array<{ id: string }> };
      for (const c of left.conversations) await page.request.delete(`/api/conversations/${c.id}`, { headers });
      const after = (await (await page.request.get('/api/conversations', { headers })).json()) as { conversations: unknown[] };
      const crm = (await (await page.request.get('/api/crm', { headers })).json()) as { records: unknown[] };
      const memory = (await (await page.request.get('/api/memory', { headers })).json()) as { consent: string; items: unknown[] };
      if (memory.consent === 'active') await page.request.delete('/api/memory/consent', { headers });
      results['cleanup'] = { conversationsFoundByServer: left.conversations.length, conversationsLeft: after.conversations.length, crmRecordsLeft: crm.records.length, memoryItemsLeft: memory.items.length, memoryConsentWasActive: memory.consent === 'active' };
      writeFileSync(`${REPORTS}ui-live-check-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, `${JSON.stringify(results, null, 2)}\n`);
    });
  }
});
