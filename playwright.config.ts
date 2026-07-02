import { defineConfig, devices } from '@playwright/test';

// UI smoke tests run against the static console (no Cloudflare credentials
// needed); API-dependent behavior is covered by worker/CLI unit tests.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory apps/worker/console',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
