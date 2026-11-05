// Orb lifecycle probe: mounts/unmounts the WebGL orb many times (reduced-motion toggle ⇒ static CSS orb ⇒ back to
// WebGL) and watches for leaked WebGL contexts ("Too many active WebGL contexts"), context loss, JS heap growth and
// CSP violations. Test server only. Usage: node client/e2e-live/qa/orb-lifecycle.mjs [baseUrl] [cycles]
import { chromium } from '@playwright/test';
const base = process.argv[2] ?? 'http://127.0.0.1:8798';
const cycles = Number(process.argv[3] ?? 24);
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const warnings = [];
page.on('console', (m) => { const t = m.text(); if (/WebGL|context|CSP|Content Security Policy/i.test(t)) warnings.push(`${m.type()}: ${t.slice(0, 160)}`); });
await page.addInitScript(() => {
  sessionStorage.setItem('masar.intro.v1', '1');
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
});
await page.goto(base);
await page.waitForSelector('.orb[data-ready="true"]', { timeout: 20000 });
const heap = () => page.evaluate(() => { if (typeof gc === 'function') gc(); return Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576 * 10) / 10; });
const start = await heap();
const samples = [];
for (let i = 0; i < cycles; i++) {
  // Reduced motion → static CSS orb (WebGL scene destroyed); back → a new WebGL scene.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForSelector('.orb[data-tier="static"]');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForSelector('.orb[data-ready="true"]', { timeout: 20000 });
  if (i % 6 === 5) samples.push(await heap());
}
await page.waitForTimeout(1500);
const end = await heap();
const finalTier = await page.locator('.orb').getAttribute('data-tier');
const csp = await page.evaluate(() => window.__cspViolations);
console.log(JSON.stringify({ cycles, heapStartMB: start, heapSamplesMB: samples, heapEndMB: end, finalTier, cspViolations: csp, webglWarnings: warnings }, null, 1));
await browser.close();
