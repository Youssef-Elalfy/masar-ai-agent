// Close-up captures of the hero orb from the real app (no agent turns, no API quota).
// Usage: node client/e2e-live/qa/orb-closeup.mjs <baseUrl> <outPrefix>
import { chromium } from '@playwright/test';
const [base, prefix] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => { localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: 'ar', theme: t, motion: 'system' })); sessionStorage.setItem('masar.intro.v1', '1'); }, theme);
  const page = await ctx.newPage();
  await page.goto(`${base}/?orb=full`);
  await page.waitForTimeout(4000);
  const box = await page.locator('.orb-stage').boundingBox();
  const clip = { x: box.x + box.width * 0.05, y: box.y + box.height * 0.05, width: box.width * 0.9, height: box.height * 0.9 };
  await page.screenshot({ path: `${prefix}-${theme}.png`, clip });
  console.log(`${prefix}-${theme}.png`);
  await ctx.close();
}
await browser.close();
