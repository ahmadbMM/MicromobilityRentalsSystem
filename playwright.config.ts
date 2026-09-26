import { defineConfig, devices } from '@playwright/test';

// E2E safety net for the strangler rewrite.
// All Supabase traffic is stubbed in tests/helpers/supabase.ts —
// the suite never reads or writes production data.
// Two checkouts of this repo run their suites at once on this machine; each takes its own
// port, or the second one silently tests whatever the first one is serving.
const PORT = process.env.PW_PORT || '4173';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'block',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `node scripts/serve.mjs ${PORT}`, // Pages and its middleware, stood in for (the app's own addresses answer with the app)
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
});
