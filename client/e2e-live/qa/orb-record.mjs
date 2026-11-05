// Close-up motion recording of the real orb cycling through its states (lab harness, hardware GPU).
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
const out = 'reports/orb-compare/video';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 720, height: 720 }, recordVideo: { dir: out, size: { width: 720, height: 720 } } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:5173/orb-lab.html?cycle=1&theme=${theme}&orb=full`);
  await page.waitForTimeout(16000);
  const video = page.video();
  await ctx.close();
  const path = await video.path();
  renameSync(path, `${out}/orb-states-${theme}.webm`);
  console.log(`${out}/orb-states-${theme}.webm`);
}
await browser.close();
console.log(readdirSync(out));
