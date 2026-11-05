// Orb-only frame rate in the dev lab (600 px canvas, larger than the app's 260 px hero): isolates the orb's GPU cost.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 760, height: 760 }, deviceScaleFactor: 1.5 })).newPage();
const measure = () => page.evaluate(() => new Promise((resolve) => {
  const d = []; let last = performance.now(); const end = last + 3000;
  const f = (t) => { d.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else { d.sort((a, b) => a - b); resolve({ fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p95ms: +d[Math.floor(d.length * 0.95)].toFixed(1) }); } };
  requestAnimationFrame(f);
}));
for (const tier of ['full', 'reduced', 'css']) {
  for (const state of ['idle', 'searching', 'listening']) {
    await page.goto(`http://127.0.0.1:5173/orb-lab.html?state=${state}&theme=dark&amp=0.4&orb=${tier}`);
    await page.waitForTimeout(2500);
    console.log(tier.padEnd(8), state.padEnd(10), JSON.stringify(await measure()), await page.locator('.orb').getAttribute('data-tier'));
  }
}
await browser.close();
