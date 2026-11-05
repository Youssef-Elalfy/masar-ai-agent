// Visual QA (MASAR, 2026-11-04): run against a built client served by the test server:
//   E2E_PORT=8798 E2E_SEARCH_DELAY_MS=1800 node client/e2e/e2e-server.ts   then   node client/e2e-live/qa/masar-states.mjs
// No live LLM / Tavily / Groq calls. Writes reports/masar-shots/.
// Visual QA: real app (built) against the deterministic test server; captures states + a screen recording.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const base = process.argv[2] ?? 'http://127.0.0.1:8798';
const out = 'reports/masar-shots';
mkdirSync(`${out}/video`, { recursive: true });
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

async function session(name, { lang, theme, w, h, mobile = false, video = false }, fn) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
    permissions: ['microphone'],
    ...(video ? { recordVideo: { dir: `${out}/video`, size: { width: w, height: h } } } : {}),
  });
  await ctx.addInitScript(([l, t]) => { localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: l, theme: t, motion: 'system' })); }, [lang, theme]);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}] console error: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => console.log(`[${name}] page error: ${e.message}`));
  await fn(page);
  await ctx.close();
}
const send = async (page, text) => { await page.locator('#composer').fill(text); await page.keyboard.press('Enter'); };
const orbState = (page) => page.locator('.orb').getAttribute('data-state');

await session('flow-ar-dark', { lang: 'ar', theme: 'dark', w: 1440, h: 900, video: true }, async (page) => {
  await page.goto(base);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/intro-ar-dark.png` });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${out}/state-idle-hero.png` });
  // Motion evidence: the same orb + background region 600 ms apart must differ.
  const clip = { x: 560, y: 90, width: 400, height: 300 };
  const a = await page.screenshot({ clip }); await page.waitForTimeout(600); const b = await page.screenshot({ clip });
  console.log('idle orb region changes over 600 ms:', !a.equals(b));
  const bgClip = { x: 0, y: 0, width: 360, height: 900 };
  const c = await page.screenshot({ clip: bgClip }); await page.waitForTimeout(1500); const d = await page.screenshot({ clip: bgClip });
  console.log('background region changes over 1.5 s:', !c.equals(d));
  await send(page, 'قارن الغردقة وشرم لميزانية 8000 جنيه للفرد');
  await page.getByRole('log').locator('article').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/state-conversation-catalog.png` });
  await send(page, 'دوّر على عروض لتركيا أسبوع');
  await page.waitForTimeout(700);
  console.log('orb state during research:', await orbState(page), '| bg:', await page.locator('.lb').getAttribute('data-state'));
  await page.screenshot({ path: `${out}/state-searching.png` });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${out}/state-external-results.png` });
  await send(page, 'slow');
  await page.waitForTimeout(1200);
  console.log('orb state during slow model call:', await orbState(page));
  await page.screenshot({ path: `${out}/state-thinking.png` });
  await page.getByRole('button', { name: /إيقاف|Stop/ }).click();
  await page.waitForTimeout(1500);
  console.log('orb state after stop:', await orbState(page));
  // Voice: Chrome's fake microphone produces a real tone, so the level meter and orb react to real samples.
  await page.getByRole('button', { name: /سجّل|Record/ }).first().click();
  await page.waitForTimeout(1600);
  console.log('orb state while recording:', await orbState(page));
  await page.screenshot({ path: `${out}/state-listening.png` });
  await page.getByRole('button', { name: /إلغاء التسجيل|Cancel recording/ }).click().catch(() => console.log('cancel button not found'));
  await page.waitForTimeout(800);
  console.log('orb state after cancel:', await orbState(page));
});

for (const v of [
  { name: 'ar-light-conversation', lang: 'ar', theme: 'light', w: 1440, h: 900 },
  { name: 'en-dark-conversation', lang: 'en', theme: 'dark', w: 1440, h: 900 },
  { name: 'en-light-conversation', lang: 'en', theme: 'light', w: 1440, h: 900 },
  { name: 'ar-mobile-conversation', lang: 'ar', theme: 'dark', w: 412, h: 915, mobile: true },
  { name: 'en-mobile-light-conversation', lang: 'en', theme: 'light', w: 412, h: 915, mobile: true },
]) {
  await session(v.name, v, async (page) => {
    await page.addInitScript(() => sessionStorage.setItem('masar.intro.v1', '1'));
    await page.goto(base);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${out}/${v.name.replace('-conversation', '')}-empty.png` });
    await send(page, v.lang === 'ar' ? 'قارن الغردقة وشرم لميزانية 8000 جنيه للفرد' : 'Compare Hurghada and Sharm for 8,000 EGP per person');
    await page.getByRole('log').locator('article').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${v.name}.png` });
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log(`${v.name}: orb tier ${await page.locator('.orb').getAttribute('data-tier')}, horizontal overflow ${scrollW}px`);
  });
}
await browser.close();
