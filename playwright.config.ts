import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:3137';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === '1' ? { channel: 'chrome' } : {}),
  },
  webServer: {
    command: 'node node_modules/next/dist/bin/next start apps/web --hostname 127.0.0.1 --port 3137',
    url: baseURL,
    reuseExistingServer: false,
    env: { MALHA_MODE: 'demo', MALHA_DEMO_DB: 'memory://' },
    timeout: 120_000,
  },
});
