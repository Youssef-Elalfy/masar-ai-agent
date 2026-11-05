import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = fileURLToPath(new URL('../../reports/ui-screenshots/', import.meta.url));

// Runs against client/e2e/e2e-server.ts (real HTTP/agent/tools/SQL; scripted LLM, recorded Tavily fixture, fake STT).
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}${test.info().project.name}-${name}.png`, fullPage: false });
const composer = (page: Page) => page.locator('#composer');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

async function openContext(page: Page) {
  if (test.info().project.name === 'mobile') await page.getByRole('button', { name: 'Trip context' }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible();
});

test('empty state: greeting, starters fill the composer (no auto-send), DEMO notice', async ({ page }) => {
  await expect(page.getByRole('heading', { name: "Hi, I'm MASAR. Shall we plan your trip?" })).toBeVisible();
  await expect(page.getByText('Programs and prices are for demonstration.')).toBeVisible();
  await page.getByRole('button', { name: 'Find offers for a week in Turkey' }).click();
  await expect(composer(page)).toHaveValue('Find offers for a week in Turkey');
  await expect(page.getByRole('log')).toHaveCount(0);
  await shot(page, 'empty-en-dark');
});

test('Arabic RTL and the theme toggle apply and persist after reload', async ({ page, isMobile }) => {
  const initial = await page.locator('html').getAttribute('data-theme');
  const other = initial === 'dark' ? 'light' : 'dark';
  if (isMobile) {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'العربية' }).click();
    await page.getByRole('button', { name: 'الإعدادات' }).click();
    await page.getByRole('menuitem', { name: other === 'light' ? 'فاتح' : 'داكن' }).click();
  } else {
    await page.getByRole('button', { name: 'عربي' }).click();
    await page.getByRole('button', { name: /المظهر/ }).click();
  }
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('data-theme', other);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('data-theme', other);
  await expect(page.getByRole('heading', { name: 'أهلاً! أنا مسار، نختار رحلتك سوا؟' })).toBeVisible();
  await shot(page, 'empty-ar-light');
});

test('catalog turn: real tool activity, DEMO cards with DB prices, journey context, resume from history', async ({ page, isMobile }) => {
  await send(page, 'عايز الغردقة أو شرم بحد أقصى 8000 جنيه للفرد، إحنا 2');
  await expect(page.getByText('Used 1 tool(s)')).toBeVisible();
  const sharm = page.getByRole('article', { name: 'Sinai Paradise' });
  const hurghada = page.getByRole('article', { name: 'Red Sea Escape' });
  await expect(sharm).toContainText('7,800 EGP');
  await expect(sharm).toContainText('DEMO PACKAGE');
  await expect(sharm).toContainText('15,600 EGP');
  await expect(hurghada).toContainText('6,500 EGP');
  await shot(page, 'catalog-cards');

  await openContext(page);
  await expect(page.getByText('Journey context')).toBeVisible();
  await expect(page.getByText('Max price / person')).toBeVisible();
  await expect(page.getByText('Searching company catalog').first()).toBeVisible();
  if (isMobile) await page.keyboard.press('Escape');

  // A fresh page load resumes the stored conversation from the server (cards rebuilt from stored tool results).
  await page.reload();
  if (isMobile) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: /^عايز الغردقة أو شرم/ }).click();
  await expect(page.getByRole('article', { name: 'Sinai Paradise' })).toContainText('7,800 EGP');
});

test('external research: provider, Cairo retrieval time, unverified badge, https source links only', async ({ page }) => {
  await send(page, 'Find offers for a week in Turkey');
  await expect(page.getByText(/External research: \d+ result\(s\) via tavily-fixture/)).toBeVisible();
  const badges = page.getByText('External · Availability not verified');
  await expect(badges.first()).toBeVisible();
  expect(await badges.count()).toBeGreaterThan(0);
  await expect(page.getByText(/Retrieved .* Cairo time/).first()).toBeVisible();
  const links = page.getByRole('link', { name: 'View original source' });
  for (const href of await links.evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))) expect(href).toMatch(/^https:\/\//);
  for (const rel of await links.evaluateAll((els) => els.map((e) => e.getAttribute('rel') ?? ''))) expect(rel).toContain('noopener');
  await expect(page.getByText('Book now')).toHaveCount(0);
  await shot(page, 'external-offers');
});

test('CRM: nothing is saved before approval; approve once; reference from the server', async ({ page }) => {
  await send(page, 'register me please, 01012345678');
  const card = page.getByRole('group', { name: /Approval needed/ });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('01012345678');
  await openContext(page);
  await expect(page.getByText('No saved requests.')).toBeVisible();
  if (test.info().project.name === 'mobile') await page.keyboard.press('Escape');
  await shot(page, 'approval-card');

  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/Contact lead \(demo CRM\) · RL-/)).toBeVisible();
  await expect(page.getByText('Demo CRM: no booking or payment, and no real staff will call.').first()).toBeVisible();
  await expect(page.getByRole('group', { name: /Approval needed/ })).toHaveCount(0);
});

test('memory: the consent dialog shows the server wording; "Not now" is recorded', async ({ page }) => {
  await send(page, 'remember that I like the sea');
  const dialog = page.getByRole('dialog', { name: 'Remember your preferences?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Memory panel');
  await expect(dialog).toContainText('No phone numbers, emails or names are stored.');
  await shot(page, 'consent-dialog');
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog).toHaveCount(0);
  await openContext(page);
  await expect(page.getByText('Declined here')).toBeVisible();
});

test('stop: a running turn can be canceled and the transcript stays consistent', async ({ page }) => {
  await send(page, 'slow question');
  await expect(page.getByText('MASAR is working…').first()).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('log').getByText('Stopped as you asked. You can continue or send a new question.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
});

test('voice note: real MediaRecorder (fake mic) → server transcription → review → sent as voice transcript', async ({ page }) => {
  await page.getByRole('button', { name: 'Record a voice note' }).click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await page.waitForTimeout(1500);
  await shot(page, 'voice-recording');
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(composer(page)).toHaveValue('عايز شرم الشيخ أربع أيام');
  await expect(page.locator('p:not(.sr-only)', { hasText: 'Review the transcript before sending' })).toBeVisible();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Sinai Paradise' })).toBeVisible();
  // The reviewed transcript is what reached the agent (sent with input kind voice_transcript).
  await expect(page.getByRole('log').getByText('عايز شرم الشيخ أربع أيام', { exact: true })).toBeVisible();
});

test('delete a conversation only after confirmation', async ({ page, isMobile }) => {
  await send(page, 'hello');
  await expect(page.getByRole('log').getByText('أهلاً! أنا مسار')).toBeVisible();
  if (isMobile) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: /Delete conversation: hello/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this conversation?' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog).toHaveCount(0);
  // On mobile the history drawer stays open after deleting, showing the updated (empty) list.
  await expect(page.getByText('No conversations yet')).toBeVisible();
  if (isMobile) await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: "Hi, I'm MASAR. Shall we plan your trip?" })).toBeVisible();
});

test('reduced motion: no running animations, static living background', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  await expect(page.locator('.lb')).toHaveAttribute('data-motion', 'off');
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect as KeyframeEffect | null)?.getComputedTiming().iterations === Infinity).length);
  expect(running).toBe(0);
});

test('living background is decorative and never intercepts input', async ({ page }) => {
  const lb = page.locator('.lb');
  await expect(lb).toHaveAttribute('aria-hidden', 'true');
  expect(await lb.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  await composer(page).click();
  await expect(composer(page)).toBeFocused();
});

test('accessibility basics: named controls, landmarks, no horizontal scroll, keyboard send', async ({ page }) => {
  const unnamed = await page.locator('button:visible').evaluateAll((els) => els.filter((e) => !(e.getAttribute('aria-label') || e.textContent?.trim())).length);
  expect(unnamed).toBe(0);
  await expect(page.getByRole('main')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await composer(page).focus();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('log').getByText('أهلاً! أنا مسار')).toBeVisible();
  // The finished answer is announced once through a polite live region.
  await expect(page.locator('[aria-live="polite"][aria-atomic="true"]')).toContainText('MASAR: أهلاً! أنا مسار');
});

test('brand: exact vocalized wordmark مَسَارٌ, MASAR title, the old public brand is gone', async ({ page }) => {
  await expect(page).toHaveTitle('مَسَارٌ · MASAR AI');
  await page.evaluate(() => localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: 'ar', theme: 'dark', motion: 'system' })));
  await page.reload();
  await expect(page.locator('.wm-text').first()).toHaveText('مَسَارٌ');
  expect(await page.locator('body').innerText()).not.toMatch(/RAHHAL|رحّال/);
});

test('living orb: decorative, never takes input, follows real agent states (thinking → stopped → idle)', async ({ page }) => {
  const orb = page.locator('.orb');
  await expect(orb).toHaveAttribute('aria-hidden', 'true');
  await expect(orb).toHaveAttribute('data-state', 'idle');
  expect(await page.locator('.orb-stage').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  await send(page, 'slow question');
  await expect(orb).toHaveAttribute('data-state', 'thinking');
  // The text twin of the orb state (only while the server reports a running turn).
  await expect(page.getByText('Analyzing your request…')).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(orb).toHaveAttribute('data-state', 'idle');
  await expect(page.getByText('Ready when you are')).toBeVisible();
  expect(await page.locator('canvas').count()).toBeLessThanOrEqual(1);
});

test('orb fallbacks: CSS orb without WebGL; a lost WebGL context falls back instead of going blank', async ({ page }) => {
  await page.goto('/?orb=css');
  await expect(page.locator('.orb')).toHaveAttribute('data-tier', 'css');
  await expect(page.locator('.css-orb')).toBeVisible();
  await expect(page.locator('.orb canvas')).toHaveCount(0);

  await page.goto('/?orb=reduced');
  const orb = page.locator('.orb');
  await expect.poll(async () => (await orb.getAttribute('data-ready')) === 'true' || (await orb.getAttribute('data-tier')) === 'css', { timeout: 15_000 }).toBe(true);
  if ((await orb.getAttribute('data-tier')) !== 'css') {
    await page.locator('.orb canvas').evaluate((c) => {
      const canvas = c as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    });
    await expect(orb).toHaveAttribute('data-tier', 'css');
  }
  await expect(page.locator('.css-orb')).toBeVisible();
});

test('RTL lists: markers sit inside a gutter on the reading side, never against the panel edge', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: 'ar', theme: 'dark', motion: 'system' })));
  await page.reload();
  await send(page, 'اعرض قائمة');
  const md = page.getByRole('log').locator('.md').last();
  await expect(md.locator('ol > li')).toHaveCount(3);
  const geo = await md.evaluate((el) => {
    const panel = el.closest('.msg-ai')?.getBoundingClientRect();
    const ulLi = el.querySelector('ul > li');
    const olLi = el.querySelector('ol > li');
    if (!panel || !ulLi || !olLi) return null;
    const bullet = getComputedStyle(ulLi, '::before');
    const badge = getComputedStyle(olLi, '::before');
    return {
      dir: getComputedStyle(el).direction,
      listStyle: getComputedStyle(el.querySelector('ul') as Element).listStyleType,
      bulletRight: bullet.right, bulletLeft: bullet.left, badgeRight: badge.right, badgeLeft: badge.left,
      gutterPx: parseFloat(getComputedStyle(ulLi).paddingInlineStart),
      edgeGapPx: panel.right - ulLi.getBoundingClientRect().right,
    };
  });
  expect(geo).not.toBeNull();
  expect(geo?.dir).toBe('rtl');
  expect(geo?.listStyle).toBe('none');
  // Markers are positioned from the right (reading side) in RTL, not from the left.
  // (computed insets of positioned boxes are used values, so check which side is anchored at the gutter edge)
  expect(geo?.badgeRight).toBe('0px');
  expect(parseFloat(geo?.badgeLeft ?? '0')).toBeGreaterThan(100);
  expect(parseFloat(geo?.bulletRight ?? '99')).toBeLessThan(12);
  expect(geo?.gutterPx ?? 0).toBeGreaterThanOrEqual(20);
  expect(geo?.edgeGapPx ?? 0).toBeGreaterThanOrEqual(12);
});

test('LTR lists mirror the RTL layout (markers on the left)', async ({ page }) => {
  await send(page, 'show a list');
  const badge = await page.getByRole('log').locator('.md ol > li').first().evaluate((li) => {
    const b = getComputedStyle(li, '::before');
    return { left: b.left, right: b.right };
  });
  expect(badge.left).toBe('0px');
  expect(parseFloat(badge.right)).toBeGreaterThan(100);
});

test('scrollbars stay quiet: transparent at rest, and the desktop welcome screen needs no scrolling', async ({ page }) => {
  const area = page.locator('main .scroll-area').first();
  expect(await area.evaluate((el) => getComputedStyle(el).scrollbarColor)).toMatch(/transparent transparent|rgba\(0, 0, 0, 0\) rgba\(0, 0, 0, 0\)/);
  if (test.info().project.name === 'desktop') {
    expect(await area.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  }
});
