// Layout probe: sweeps many viewport sizes (samples, not targets) on the empty state and reports overflow, clipping
// and composer overlap. Usage: node client/e2e-live/qa/layout-probe.mjs [baseUrl] [lang]
import { chromium } from '@playwright/test';
const base = process.argv[2] ?? 'http://127.0.0.1:8798';
const lang = process.argv[3] ?? 'ar';
const widths = [320, 360, 390, 430, 540, 600, 700, 768, 820, 900, 1000, 1100, 1180, 1280, 1366, 1440, 1600, 1920, 2560];
const heights = [480, 560, 640, 700, 768, 820, 900, 1080, 1440];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((l) => { localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: l, theme: 'dark', motion: 'reduce' })); sessionStorage.setItem('masar.intro.v1', '1'); }, lang);
const page = await ctx.newPage();
await page.goto(base);
await page.waitForSelector('.starter');
const problems = [];
let checked = 0;
for (const w of widths) {
  for (const h of heights) {
    await page.setViewportSize({ width: w, height: h });
    // Wait until the layout is stable (the same scroll metrics on consecutive frames), not a fixed delay.
    await page.evaluate(() => new Promise((resolve) => {
      let last = ''; let same = 0; const t0 = performance.now();
      const tick = () => {
        const sc = document.querySelector('[data-region="welcome"]');
        const now = sc ? `${sc.clientHeight}/${sc.scrollHeight}/${innerWidth}x${innerHeight}` : '';
        same = now === last ? same + 1 : 0; last = now;
        if (same >= 6 || performance.now() - t0 > 3000) resolve(null); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    const r = await page.evaluate(() => {
      const scroller = document.querySelector('[data-region="welcome"]') ?? document.querySelector('main .scroll-area');
      const composer = document.querySelector('.composer-shell');
      const starters = [...document.querySelectorAll('.starter')];
      if (!scroller || !composer) return { error: 'missing' };
      const s = scroller.getBoundingClientRect();
      const c = composer.getBoundingClientRect();
      const overflowY = scroller.scrollHeight - scroller.clientHeight;
      const hScroll = document.documentElement.scrollWidth - innerWidth;
      const overlap = starters.some((el) => { const b = el.getBoundingClientRect(); return b.bottom > c.top + 1 && b.top < c.bottom && b.bottom <= s.bottom + 400 && b.top < c.top && b.bottom > s.bottom + 1; });
      // Content above the scroll origin can never be reached (centred overflow clipping).
      scroller.scrollTop = 0;
      const first = scroller.firstElementChild?.firstElementChild?.getBoundingClientRect();
      const clippedTop = first ? first.top < s.top - 1 : false;
      const startersBelowRegion = starters.some((el) => el.getBoundingClientRect().bottom > s.bottom + 1);
      return { overflowY, hScroll, overlap, clippedTop, startersBelowRegion, regionH: Math.round(s.height) };
    });
    checked++;
    const bad = [];
    if (r.error) bad.push(r.error);
    if (r.hScroll > 0) bad.push(`h-scroll ${r.hScroll}`);
    if (r.clippedTop) bad.push('top clipped');
    if (r.overflowY > 0) bad.push(`v-overflow ${r.overflowY}`);
    if (bad.length) {
      // Re-check after a fresh load at the same size: a difference means the layout depends on resize history.
      await page.reload();
      await page.waitForSelector('.starter');
      await page.waitForTimeout(400);
      const fresh = await page.evaluate(() => { const sc = document.querySelector('[data-region="welcome"]'); return sc.scrollHeight - sc.clientHeight; });
      problems.push(`${w}x${h} (region ${r.regionH}): ${bad.join(', ')} | fresh load overflow ${fresh}`);
    }
  }
}
console.log(`checked ${checked} sizes, ${problems.length} with overflow/issues`);
for (const p of problems) console.log('  ' + p);
await browser.close();
