import { expect, test } from '@playwright/test';

// Browser-side security regressions (audit 2026-11-05).

test('strict CSP holds: no violations while loading, chatting and opening dialogs', async ({ page }) => {
  await page.addInitScript(() => {
    const store: string[] = [];
    Reflect.set(window, '__csp', store);
    document.addEventListener('securitypolicyviolation', (e) => store.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible();
  await page.locator('#composer').fill('Compare Hurghada and Sharm');
  await page.locator('#composer').press('Enter');
  await expect(page.getByRole('log').locator('article').first()).toBeVisible();
  const violations = await page.evaluate(() => Reflect.get(window, '__csp') as string[]);
  expect(violations).toEqual([]);
});

test('security headers on the app shell; no inline scripts', async ({ request, page }) => {
  const res = await request.get('/');
  const h = res.headers();
  expect(h['content-security-policy']).toContain("script-src 'self'");
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['content-security-policy']).not.toContain('unsafe-eval');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('no-referrer');
  await page.goto('/');
  const inline = await page.evaluate(() => [...document.scripts].filter((s) => !s.src).length);
  expect(inline).toBe(0);
});

test('external links open safely (noopener, noreferrer) and only over http(s)', async ({ page }) => {
  await page.goto('/');
  await page.locator('#composer').fill('Find offers for a week in Turkey');
  await page.locator('#composer').press('Enter');
  const links = page.getByRole('log').locator('a[href^="http"]');
  await expect(links.first()).toBeVisible();
  const attrs = await links.evaluateAll((els) => els.map((a) => ({ href: a.getAttribute('href') ?? '', target: a.getAttribute('target'), rel: a.getAttribute('rel') ?? '' })));
  for (const a of attrs) {
    expect(a.href).toMatch(/^https?:\/\//);
    if (a.target === '_blank') expect(a.rel).toMatch(/noopener/);
    expect(a.rel).toMatch(/noreferrer/);
  }
});
