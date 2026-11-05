import { expect, test, type Page } from '@playwright/test';

// Round 5 regressions: composer direction, header lockup alignment, and drawers/dialogs that must be fixed overlays.

async function useLanguage(page: Page, lang: 'ar' | 'en') {
  await page.addInitScript((l) => {
    localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: l, theme: 'dark', motion: 'reduce' }));
    sessionStorage.setItem('masar.intro.v1', '1');
  }, lang);
  await page.goto('/');
  await expect(page.locator('.starter').first()).toBeVisible();
}

const fieldDir = (page: Page) => page.locator('#composer').evaluate((el) => ({ dir: getComputedStyle(el).direction, align: getComputedStyle(el).textAlign }));

/** Fixed, on screen, with real content. */
async function overlayBox(page: Page) {
  return page.getByRole('dialog').evaluate((el) => {
    const b = el.getBoundingClientRect();
    return {
      position: getComputedStyle(el).position,
      onScreen: b.top >= -1 && b.bottom <= innerHeight + 1 && b.left >= -1 && b.right <= innerWidth + 1,
      width: b.width,
      height: b.height,
      text: (el.textContent ?? '').trim().length,
    };
  });
}

test('Arabic composer is a real RTL field: right-aligned placeholder and caret; typed English follows its script', async ({ page }) => {
  await useLanguage(page, 'ar');
  expect(await fieldDir(page)).toEqual({ dir: 'rtl', align: 'start' });
  await page.locator('#composer').fill('8000');
  expect((await fieldDir(page)).dir).toBe('rtl'); // digits only: still the UI direction
  await page.locator('#composer').fill('Sharm in December');
  expect((await fieldDir(page)).dir).toBe('ltr');
  await page.locator('#composer').fill('عايز شرم في ديسمبر');
  expect((await fieldDir(page)).dir).toBe('rtl');
});

test('English composer stays LTR', async ({ page }) => {
  await useLanguage(page, 'en');
  expect(await fieldDir(page)).toEqual({ dir: 'ltr', align: 'start' });
  await page.locator('#composer').fill('عايز شرم');
  expect((await fieldDir(page)).dir).toBe('rtl');
});

for (const lang of ['ar', 'en'] as const) {
  test(`header lockup (${lang}) is anchored at the bar's start edge`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'on narrow screens the menu button and brand symbol lead the bar by design');
    await useLanguage(page, lang);
    const gap = await page.evaluate((l) => {
      const bar = document.querySelector('header.topbar')?.getBoundingClientRect();
      const title = document.querySelector('header.topbar h1')?.getBoundingClientRect();
      const sub = document.querySelector('header.topbar h1 + p')?.getBoundingClientRect();
      if (!bar || !title || !sub) return null;
      return l === 'ar'
        ? { title: bar.right - title.right, sub: bar.right - sub.right }
        : { title: title.left - bar.left, sub: sub.left - bar.left };
    }, lang);
    expect(gap).not.toBeNull();
    // Only the bar's own padding before the title, and both lines share the same start edge.
    expect(gap?.title ?? 99).toBeLessThanOrEqual(28);
    expect(Math.abs((gap?.title ?? 0) - (gap?.sub ?? 99))).toBeLessThanOrEqual(1);
  });
}

for (const lang of ['ar', 'en'] as const) {
  test(`narrow screens (${lang}): history and context drawers open on screen with content, repeatedly`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await useLanguage(page, lang);
    const menu = page.getByRole('button', { name: lang === 'ar' ? 'القائمة' : 'Menu' });
    for (let i = 0; i < 3; i++) {
      await menu.click();
      const box = await overlayBox(page);
      expect(box.position).toBe('fixed');
      expect(box.onScreen).toBe(true);
      expect(box.width).toBeGreaterThan(250);
      await expect(page.getByRole('dialog').getByRole('button', { name: lang === 'ar' ? 'محادثة جديدة' : 'New conversation' })).toBeVisible();
      await expect(page.getByRole('dialog').getByRole('searchbox')).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    await page.getByRole('button', { name: lang === 'ar' ? 'تفاصيل الرحلة' : 'Trip context' }).click();
    const ctx = await overlayBox(page);
    expect(ctx.position).toBe('fixed');
    expect(ctx.onScreen).toBe(true);
    expect(ctx.text).toBeGreaterThan(20);
    await page.keyboard.press('Escape');
    // The workspace is intact afterwards.
    await expect(page.locator('#composer')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });
}

test('dialogs that share the glass panel style are fixed overlays on screen (delete confirmation)', async ({ page }) => {
  await useLanguage(page, 'en');
  await page.locator('#composer').fill('hello');
  await page.locator('#composer').press('Enter');
  await expect(page.getByRole('log').locator('.msg-ai')).toHaveCount(1);
  if (test.info().project.name === 'mobile') await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: /^Delete conversation/ }).first().click();
  const box = await page.getByRole('alertdialog').or(page.getByRole('dialog').filter({ hasText: 'Delete this conversation?' })).last().evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { position: getComputedStyle(el).position, onScreen: b.top >= 0 && b.bottom <= innerHeight && b.height > 80 };
  });
  expect(box).toEqual({ position: 'fixed', onScreen: true });
});
