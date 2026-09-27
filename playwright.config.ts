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
  // CI's runner has 4 CPUs; Playwright's default is half of them. Three workers per shard measured
  // fastest for these browser-heavy specs (2026-09-27); local runs keep the default.
  workers: process.env.CI ? 3 : undefined,
  retries: process.env.CI ? 2 : 0,
  // Every run also leaves a JSON record (gitignored): a test that failed and then passed on a retry
  // is "flaky" there, which the console reporters do not make visible. CI uploads the file per shard
  // and prints the flaky tests from it; locally it is the last run's ground truth.
  reporter: [
    [process.env.CI ? 'github' : 'list'],
    ['json', { outputFile: 'tests/.results/last-run.json' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'block',
    trace: 'on-first-retry',
    // The server sends the site's real Content-Security-Policy (scripts/serve.mjs applies _headers),
    // which allows no eval - and Playwright's string-form evaluate()/waitForFunction() run through
    // eval inside the page. The suite therefore bypasses the policy in the browser; tests/csp.spec.ts
    // turns it back on for itself and drives the page with function-form calls only.
    bypassCSP: true,
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
