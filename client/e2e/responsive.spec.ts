import { expect, test, type Page } from '@playwright/test';

// Responsive behaviour is tested on sampled sizes (including odd, in-between ones). They are samples, not layout
// targets: the layout itself has no device sizes (em-based panel modes, container queries, flex/grid).

type Metrics = {
  layout: string | null;
  hOverflow: number;
  regionH: number;
  regionW: number;
  vOverflow: number;
  topClipped: boolean;
  composerOverlap: boolean;
  remPx: number;
};

async function settle(page: Page): Promise<void> {
  // Wait until consecutive frames report the same layout (not a fixed delay).
  await page.evaluate(() => new Promise((resolve) => {
    let last = '';
    let same = 0;
    const t0 = performance.now();
    const tick = () => {
      const sc = document.querySelector('[data-region="welcome"]');
      const now = sc ? `${sc.clientHeight}/${sc.scrollHeight}/${innerWidth}x${innerHeight}` : `x/${innerWidth}x${innerHeight}`;
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= 5 || performance.now() - t0 > 3000) resolve(null);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

async function metrics(page: Page): Promise<Metrics> {
  await settle(page);
  return page.evaluate(() => {
    const region = document.querySelector('[data-region="welcome"]') as HTMLElement;
    const composer = document.querySelector('.composer-shell') as HTMLElement;
    const r = region.getBoundingClientRect();
    const c = composer.getBoundingClientRect();
    region.scrollTop = 0;
    const first = region.querySelector('.welcome-content')?.firstElementChild?.getBoundingClientRect();
    return {
      layout: document.querySelector('.shell')?.getAttribute('data-layout') ?? null,
      hOverflow: document.documentElement.scrollWidth - window.innerWidth,
      regionH: r.height,
      regionW: r.width,
      vOverflow: region.scrollHeight - region.clientHeight,
      topClipped: first ? first.top < r.top - 1 : true,
      // The composer is laid out after the scroll region: it must start at or below the region's bottom edge.
      composerOverlap: c.top < r.bottom - 1,
      remPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  });
}

/** Every suggestion can be scrolled fully into view inside the region, above the composer. */
async function startersReachable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const region = document.querySelector('[data-region="welcome"]') as HTMLElement;
    const c = (document.querySelector('.composer-shell') as HTMLElement).getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('.starter')].every((el) => {
      el.scrollIntoView({ block: 'nearest' });
      const b = el.getBoundingClientRect();
      const r = region.getBoundingClientRect();
      return b.top >= r.top - 1 && b.bottom <= r.bottom + 1 && b.bottom <= c.top + 1;
    });
  });
}

function expectedLayout(widthPx: number, remPx: number): string {
  const em = widthPx / remPx;
  return em >= 72 ? 'wide' : em >= 50 ? 'medium' : 'narrow';
}

test.describe('responsive workspace', () => {
  test.skip(({ isMobile }) => isMobile, 'viewport sweeps run on the desktop project');

  for (const lang of ['ar', 'en'] as const) {
    test(`sampled sizes (${lang}): no sideways overflow, no clipping, no composer overlap, scroll only when needed`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.addInitScript((l) => {
        localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: l, theme: 'dark', motion: 'reduce' }));
        sessionStorage.setItem('masar.intro.v1', '1');
      }, lang);
      await page.goto('/');
      await expect(page.locator('.starter').first()).toBeVisible();
      const sizes: Array<[number, number]> = [
        [333, 611], [360, 780], [412, 915], [455, 702], [599, 851], [640, 400], [777, 533], [820, 480], [911, 640],
        [1013, 701], [1100, 560], [1180, 820], [1280, 720], [1366, 768], [1440, 900], [1555, 877], [1920, 1080], [2560, 1300],
      ];
      for (const [w, h] of sizes) {
        await page.setViewportSize({ width: w, height: h });
        const m = await metrics(page);
        const where = `${lang} ${w}x${h}`;
        expect(m.layout, where).toBe(expectedLayout(w, m.remPx));
        expect(m.hOverflow, where).toBeLessThanOrEqual(0);
        expect(m.topClipped, where).toBe(false);
        expect(m.composerOverlap, where).toBe(false);
        expect(await startersReachable(page), where).toBe(true);
        // Content fits (no scrollbar) whenever the region is not genuinely small: at least 36rem tall in a narrow
        // column, or 19rem tall when the column is wide enough for the side-by-side arrangement.
        const roomy = m.regionH >= 36 * m.remPx || (m.regionW >= 37.5 * m.remPx && m.regionH >= 19 * m.remPx);
        if (roomy) expect(m.vOverflow, `${where} region ${Math.round(m.regionW)}x${Math.round(m.regionH)}`).toBeLessThanOrEqual(1);
      }
    });
  }

  test('live resizing in one session: the layout follows continuously (no stale heights, no history effects)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await expect(page.locator('.starter').first()).toBeVisible();
    // A slow drag-like sweep: shrink, then grow, width and height together.
    const path: Array<[number, number]> = [];
    for (let i = 0; i <= 12; i++) path.push([1700 - i * 110, 1000 - i * 40]);
    for (let i = 0; i <= 12; i++) path.push([380 + i * 110, 520 + i * 35]);
    for (const [w, h] of path) {
      await page.setViewportSize({ width: w, height: h });
      const m = await metrics(page);
      const shell = await page.locator('.shell').boundingBox();
      expect(Math.round(shell?.height ?? 0), `${w}x${h} shell height`).toBe(h);
      expect(m.hOverflow, `${w}x${h}`).toBeLessThanOrEqual(0);
      expect(m.composerOverlap, `${w}x${h}`).toBe(false);
      expect(m.topClipped, `${w}x${h}`).toBe(false);
    }
  });

  test('200% zoom equivalent (a 1440x900 window at 2x scale): narrower panel mode, everything reachable', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('.starter').first()).toBeVisible();
    const m = await metrics(page);
    expect(m.layout).toBe('narrow');
    expect(m.hOverflow).toBeLessThanOrEqual(0);
    expect(m.composerOverlap).toBe(false);
    expect(await startersReachable(page)).toBe(true);
    // History stays available as a drawer.
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await ctx.close();
  });

  test('panels respond to available width: wide shows both, medium keeps history, narrow uses drawers', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.shell')).toHaveAttribute('data-layout', 'wide');
    await expect(page.locator('.shell > .panel')).toHaveCount(2);
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator('.shell')).toHaveAttribute('data-layout', 'medium');
    await expect(page.locator('.shell > .panel')).toHaveCount(1);
    await page.getByRole('button', { name: 'Trip context' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(page.locator('.shell')).toHaveAttribute('data-layout', 'narrow');
    await expect(page.locator('.shell > .panel')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  });

  test('chat on a small window: one scrolling region, the composer never covers the latest answer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await page.addInitScript(() => localStorage.setItem('rahhal.settings.v1', JSON.stringify({ lang: 'ar', theme: 'dark', motion: 'reduce' })));
    await page.goto('/');
    for (let i = 0; i < 2; i++) {
      await page.locator('#composer').fill('اعرض قائمة');
      await page.locator('#composer').press('Enter');
      await expect(page.getByRole('log').locator('.msg-ai')).toHaveCount(i + 1);
    }
    const r = await page.evaluate(() => {
      const scrollers = [...document.querySelectorAll('main *')].filter((el) => {
        const s = getComputedStyle(el);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
      });
      const log = document.querySelector('[role="log"]') as HTMLElement;
      const scroller = log.parentElement as HTMLElement;
      scroller.scrollTop = scroller.scrollHeight;
      const last = [...document.querySelectorAll('.msg-ai')].at(-1)?.getBoundingClientRect();
      const composer = (document.querySelector('.composer-shell') as HTMLElement).getBoundingClientRect();
      return { scrollingRegions: scrollers.length, lastBottom: last?.bottom ?? 0, composerTop: composer.top, hOverflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(r.scrollingRegions).toBe(1);
    expect(r.lastBottom).toBeLessThanOrEqual(r.composerTop);
    expect(r.hOverflow).toBeLessThanOrEqual(0);
  });
});

test.describe('mobile orientation and on-screen keyboard', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile project only');

  test('portrait and landscape both fit without sideways overflow, and the composer stays usable', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.starter').first()).toBeVisible();
    for (const [w, h] of [[412, 839], [839, 412], [412, 839]] as const) {
      await page.setViewportSize({ width: w, height: h });
      const m = await metrics(page);
      expect(m.hOverflow, `${w}x${h}`).toBeLessThanOrEqual(0);
      expect(m.composerOverlap, `${w}x${h}`).toBe(false);
      expect(m.topClipped, `${w}x${h}`).toBe(false);
      expect(await startersReachable(page), `${w}x${h}`).toBe(true);
      await expect(page.locator('#composer')).toBeInViewport();
    }
  });

  test('keyboard open (viewport shrinks with resizes-content): composer remains visible above it', async ({ page }) => {
    await page.goto('/');
    await page.locator('#composer').focus();
    // interactive-widget=resizes-content: the layout viewport shrinks by the keyboard height.
    await page.setViewportSize({ width: 412, height: 839 - 320 });
    const m = await metrics(page);
    expect(m.composerOverlap).toBe(false);
    await expect(page.locator('#composer')).toBeInViewport();
    await expect(page.locator('#composer')).toBeFocused();
    expect(await startersReachable(page)).toBe(true);
  });
});
