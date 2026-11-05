// Round 5 check: drawer/dialog positioning, composer direction and header lockup (test server, no quota).
// Usage: node client/e2e-live/qa/round5-check.mjs [baseUrl] [outDir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const base = process.argv[2] ?? 'http://127.0.0.1:8798';
const out = process.argv[3] ?? 'reports/round5';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [lang, theme] of [['ar', 'dark'], ['en', 'light']]) {
  for (const [w, h] of [[390, 780], [1366, 820]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript(([l, t]) => { localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: l, theme: t, motion: 'reduce' })); sessionStorage.setItem('masar.intro.v1', '1'); }, [lang, theme]);
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForSelector('.starter');
    await page.waitForTimeout(800);
    const tag = `${lang}-${theme}-${w}x${h}`;
    const composer = await page.locator('#composer').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { dir: cs.direction, align: cs.textAlign, placeholderDir: el.getAttribute('dir') };
    });
    const header = await page.evaluate(() => {
      const bar = document.querySelector('header.topbar')?.getBoundingClientRect();
      const title = document.querySelector('header.topbar h1')?.getBoundingClientRect();
      return bar && title ? { startGap: Math.round(document.documentElement.dir === 'rtl' ? bar.right - title.right : title.left - bar.left) } : null;
    });
    await page.screenshot({ path: `${out}/${tag}.png` });
    let drawer = null;
    const menu = page.getByRole('button', { name: lang === 'ar' ? 'القائمة' : 'Menu' });
    if (await menu.count()) {
      await menu.click();
      await page.waitForTimeout(500);
      drawer = await page.getByRole('dialog').evaluate((el) => {
        const b = el.getBoundingClientRect();
        return { position: getComputedStyle(el).position, top: Math.round(b.top), left: Math.round(b.left), width: Math.round(b.width), height: Math.round(b.height), inViewport: b.top >= 0 && b.bottom <= innerHeight + 1 && b.width > 100, newChatVisible: !!el.querySelector('button.btn-brand') };
      });
      await page.screenshot({ path: `${out}/${tag}-drawer.png` });
    }
    console.log(tag, JSON.stringify({ composer, header, drawer }));
    await ctx.close();
  }
}
await browser.close();
