// Close-ups of the real LivingOrb in the dev-only lab (client/orb-lab.html). Usage: node ... <outDir> [states...]
// Needs `npx vite --config client/vite.config.ts --mode e2e` running. Hardware GPU (ANGLE D3D11).
import { chromium } from '@playwright/test';
const [out, ...only] = process.argv.slice(2);
const shots = [
  ['idle-dark', 'idle', 'dark', 0], ['thinking-dark', 'thinking', 'dark', 0], ['searching-dark', 'searching', 'dark', 0],
  ['listening-dark', 'listening', 'dark', 0.75], ['responding-dark', 'responding', 'dark', 0], ['error-dark', 'error', 'dark', 0],
  ['idle-light', 'idle', 'light', 0], ['searching-light', 'searching', 'light', 0],
].filter(([n]) => only.length === 0 || only.includes(n));
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 760, height: 760 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error' || /THREE/.test(m.text())) console.log('console:', m.text().slice(0, 400)); });
for (const [name, state, theme, amp] of shots) {
  await page.goto(`http://127.0.0.1:5173/orb-lab.html?state=${state}&theme=${theme}&amp=${amp}&orb=full`);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}/${name}.png`, clip: { x: 130, y: 130, width: 500, height: 500 } });
  console.log(name, await page.locator('.orb').getAttribute('data-tier'), await page.locator('.orb').getAttribute('data-ready'));
}
await browser.close();
