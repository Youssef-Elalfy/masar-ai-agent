// Responsive evidence: (1) a screen recording of one live session being resized continuously (shrink and grow,
// both axes), (2) a contact sheet of sampled sizes (Arabic dark + English light). Test server only, no quota.
// Usage: node client/e2e-live/qa/responsive-evidence.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:8798';
const out = 'reports/responsive';
mkdirSync(`${out}/video`, { recursive: true });
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });

// 1) Live resize recording (frame 1600x1000; the page occupies the top-left area at each size).
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: `${out}/video`, size: { width: 1600, height: 1000 } } });
  await ctx.addInitScript(() => { localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: 'ar', theme: 'dark', motion: 'system' })); sessionStorage.setItem('masar.intro.v1', '1'); });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForTimeout(2500);
  const steps = [];
  for (let i = 0; i <= 40; i++) steps.push([Math.round(1600 - i * 31), Math.round(1000 - i * 13)]);
  for (let i = 0; i <= 40; i++) steps.push([Math.round(360 + i * 25), Math.round(480 + i * 4)]);
  for (let i = 0; i <= 20; i++) steps.push([Math.round(1360 + i * 12), Math.round(640 + i * 18)]);
  for (const [w, h] of steps) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(110);
  }
  await page.waitForTimeout(800);
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), `${out}/video/live-resize-ar-dark.webm`);
  console.log(`${out}/video/live-resize-ar-dark.webm`);
}

// 2) Contact sheet of sampled sizes.
const samples = [[1920, 1080], [1440, 900], [1280, 640], [1100, 560], [1013, 701], [900, 1200], [820, 480], [700, 900], [540, 720], [412, 915], [390, 640], [333, 611]];
const shots = [];
for (const [lang, theme] of [['ar', 'dark'], ['en', 'light']]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(([l, t]) => { localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: l, theme: t, motion: 'reduce' })); sessionStorage.setItem('masar.intro.v1', '1'); }, [lang, theme]);
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForTimeout(2500);
  for (const [w, h] of samples) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
    const file = `${out}/${lang}-${theme}-${w}x${h}.png`;
    await page.screenshot({ path: file });
    const m = await page.evaluate(() => { const s = document.querySelector('[data-region="welcome"]'); return { layout: document.querySelector('.shell').dataset.layout, overflowY: s.scrollHeight - s.clientHeight, hOverflow: document.documentElement.scrollWidth - innerWidth }; });
    shots.push({ file, label: `${lang}/${theme} ${w}×${h} · ${m.layout} · v-overflow ${m.overflowY}px · h-overflow ${m.hOverflow}px` });
  }
  await ctx.close();
}
const cells = shots.map((s) => `<figure><div class="f"><img src="data:image/png;base64,${readFileSync(s.file).toString('base64')}"></div><figcaption>${s.label}</figcaption></figure>`).join('');
const html = `<html><body style="margin:0;background:#0b1220;color:#cbd5e1;font:13px system-ui"><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:10px">${cells}</div>
<style>figure{margin:0}.f{height:260px;display:grid;place-items:center;background:#111a2e;border-radius:8px;overflow:hidden}img{max-width:100%;max-height:260px;display:block}figcaption{padding:4px 2px}</style></body></html>`;
const sheet = await (await browser.newContext({ viewport: { width: 1600, height: 200 } })).newPage();
await sheet.setContent(html);
await sheet.screenshot({ path: `${out}/contact-sheet.png`, fullPage: true });
console.log(`${out}/contact-sheet.png`);
for (const s of shots) console.log(s.label);
await browser.close();
