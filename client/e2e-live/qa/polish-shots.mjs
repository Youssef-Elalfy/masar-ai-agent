// Round 3 polish QA: empty states, list typography and first-screen overflow, against the test server (no quota).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const base = process.argv[2] ?? 'http://127.0.0.1:8798';
const out = 'reports/round3-shots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const views = [
  { name: 'ar-dark-1440', lang: 'ar', theme: 'dark', w: 1440, h: 900, msg: 'اعرض قائمة' },
  { name: 'ar-light-1440', lang: 'ar', theme: 'light', w: 1440, h: 900, msg: 'اعرض قائمة' },
  { name: 'en-dark-1440', lang: 'en', theme: 'dark', w: 1440, h: 900, msg: 'show a list' },
  { name: 'en-light-1366', lang: 'en', theme: 'light', w: 1366, h: 768, msg: 'show a list' },
  { name: 'ar-dark-1366', lang: 'ar', theme: 'dark', w: 1366, h: 768, msg: 'اعرض قائمة' },
  { name: 'ar-mobile', lang: 'ar', theme: 'dark', w: 412, h: 915, mobile: true, msg: 'اعرض قائمة' },
  { name: 'en-mobile-light', lang: 'en', theme: 'light', w: 390, h: 844, mobile: true, msg: 'show a list' },
];
for (const v of views) {
  const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: v.mobile ? 2 : 1, isMobile: !!v.mobile, hasTouch: !!v.mobile });
  await ctx.addInitScript(([l, t]) => { localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: l, theme: t, motion: 'system' })); sessionStorage.setItem('masar.intro.v1', '1'); }, [v.lang, v.theme]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${v.name}] page error ${e.message}`));
  await page.goto(base);
  await page.waitForTimeout(3000);
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('main .scroll-area');
    return el ? el.scrollHeight - el.clientHeight : null;
  });
  await page.screenshot({ path: `${out}/${v.name}-empty.png` });
  await page.locator('#composer').fill(v.msg);
  await page.keyboard.press('Enter');
  await page.getByRole('log').locator('.md ol').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${v.name}-lists.png` });
  const msg = page.getByRole('log').locator('.msg-ai').last();
  await msg.screenshot({ path: `${out}/${v.name}-lists-closeup.png` });
  const geo = await msg.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const rtl = getComputedStyle(el.querySelector('.md')).direction === 'rtl';
    const li = el.querySelector('.md ul > li');
    const marker = getComputedStyle(li, '::before');
    const liBox = li.getBoundingClientRect();
    const edgeGap = rtl ? box.right - liBox.right : liBox.left - box.left;
    return { dir: rtl ? 'rtl' : 'ltr', markerToEdgePx: Math.round(edgeGap + parseFloat(marker.insetInlineStart || marker.right || '0')), textIndentPx: Math.round(parseFloat(getComputedStyle(li).paddingInlineStart)) };
  });
  console.log(`${v.name}: empty-state overflow ${overflow}px, list ${JSON.stringify(geo)}, page h-scroll ${await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)}px`);
  await ctx.close();
}
await browser.close();
