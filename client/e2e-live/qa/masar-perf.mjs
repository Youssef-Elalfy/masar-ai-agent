// Frame-rate probe per orb tier and agent state (MASAR, 2026-11-04). Needs a fresh test server on :8798 per run
// (the research result is cached per server): node client/e2e-live/qa/masar-perf.mjs full|reduced|css|mobile
import { chromium } from '@playwright/test';
const base = 'http://127.0.0.1:8798';
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
async function measure(page, ms) {
  return page.evaluate((dur) => new Promise((resolve) => {
    const deltas = []; let last = performance.now(); const end = last + dur;
    const f = (t) => { deltas.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else {
      deltas.sort((a, b) => a - b);
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      resolve({ fps: +(1000 / avg).toFixed(1), p95ms: +deltas[Math.floor(deltas.length * 0.95)].toFixed(1), worstMs: +deltas.at(-1).toFixed(1) });
    } };
    requestAnimationFrame(f);
  }), ms);
}
const send = async (page, text) => { await page.locator('#composer').fill(text); await page.keyboard.press('Enter'); };
async function run(label, { tier, w = 1440, h = 900, mobile = false, cpu = 1 }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2.6 : 1, isMobile: mobile, hasTouch: mobile, permissions: ['microphone'] });
  await ctx.addInitScript(() => { localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: 'ar', theme: 'dark', motion: 'system' })); sessionStorage.setItem('masar.intro.v1', '1'); });
  const page = await ctx.newPage();
  if (cpu > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu }); }
  await page.goto(`${base}/?orb=${tier}`);
  await page.waitForTimeout(3000);
  const res = { label, tier: await page.locator('.orb').getAttribute('data-tier') };
  res.idleHero = await measure(page, 3000);
  await send(page, 'دوّر على عروض لتركيا 9 أيام'); // new query text → not cached → 1.8 s real "searching"
  await page.waitForTimeout(250);
  res.searchingState = await page.locator('.orb').getAttribute('data-state');
  res.searching = await measure(page, 1300);
  await page.waitForTimeout(2500);
  res.idleDocked = await measure(page, 3000);
  await page.getByRole('button', { name: /سجّل|Record/ }).first().click();
  await page.waitForTimeout(1200);
  res.listeningState = await page.locator('.orb').getAttribute('data-state');
  res.listening = await measure(page, 3000);
  await page.getByRole('button', { name: /إلغاء|Cancel/ }).first().click().catch(() => undefined);
  res.finalTier = await page.locator('.orb').getAttribute('data-tier');
  console.log(JSON.stringify(res));
  await ctx.close();
}
const which = process.argv[2];
const runs = { full: ['desktop full', { tier: 'full' }], reduced: ['desktop reduced', { tier: 'reduced' }], css: ['desktop css', { tier: 'css' }], mobile: ['mobile-emulated reduced, 4x CPU throttle', { tier: 'reduced', w: 412, h: 915, mobile: true, cpu: 4 }] };
await run(...runs[which]);
await browser.close();
