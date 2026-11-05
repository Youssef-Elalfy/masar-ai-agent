// README gallery: fresh screenshots of the real app against the deterministic test server (scripted model, fixture
// search results, no real conversations or keys). JPEG for small files. Usage:
//   E2E_PORT=8798 node client/e2e/e2e-server.ts   then   node client/e2e-live/qa/readme-shots.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:8798';
const out = 'docs/assets';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });

async function shot(name, { lang, theme, w, h, mobile = false, message = null, waitFor = null }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1.25, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(([l, t]) => {
    localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: l, theme: t, motion: 'system' }));
    sessionStorage.setItem('masar.intro.v1', '1');
  }, [lang, theme]);
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForSelector('.orb[data-ready="true"]', { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  if (message) {
    await page.locator('#composer').fill(message);
    await page.keyboard.press('Enter');
    if (waitFor) await page.getByRole('log').locator(waitFor).first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(2200);
  }
  await page.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 84 });
  console.log(`${out}/${name}.jpg`);
  await ctx.close();
}

await shot('masar-welcome-dark-ar', { lang: 'ar', theme: 'dark', w: 1440, h: 900 });
await shot('masar-catalog-dark-ar', { lang: 'ar', theme: 'dark', w: 1440, h: 900, message: 'قارن الغردقة وشرم لميزانية 8000 جنيه للفرد', waitFor: 'article' });
await shot('masar-research-light-en', { lang: 'en', theme: 'light', w: 1440, h: 900, message: 'Find offers for a week in Turkey', waitFor: 'article' });
await shot('masar-mobile-dark-ar', { lang: 'ar', theme: 'dark', w: 390, h: 844, mobile: true });
await browser.close();
