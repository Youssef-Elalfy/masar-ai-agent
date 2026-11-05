import { defineConfig, devices } from '@playwright/test';

// LIVE UI check (real Gemini/Supabase/Tavily/Groq) against an already running `npm run web` on :8787.
// Separate from the deterministic `npm run e2e` suite; run deliberately: npx playwright test -c client/playwright.live.config.ts
export default defineConfig({
  testDir: './e2e-live',
  outputDir: '../reports/e2e-live-artifacts',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:8787', trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
});
