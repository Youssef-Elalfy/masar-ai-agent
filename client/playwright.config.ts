import { defineConfig, devices } from '@playwright/test';

// E2E for the RAHHAL web console against the deterministic test server (no live LLM/Tavily/Groq calls).
// Build first: npm run build:client && npm run e2e
export default defineConfig({
  testDir: './e2e',
  outputDir: '../reports/e2e-artifacts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: '../reports/e2e-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:8799',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
  webServer: {
    command: 'node client/e2e/e2e-server.ts',
    cwd: '..',
    url: 'http://127.0.0.1:8799/api/status',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
