import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The visual-comparison harness: a local tool, never run by CI (whose `npx playwright test` reads
// playwright.config.ts, testDir ./tests) and never served (functions/_middleware.js refuses .ts and
// /visual/, and scripts/assemble-dist.mjs copies only its listed files).
//
// It exists for the passes that move inline style="…" into classes (so the Content-Security-Policy
// can drop style-src 'unsafe-inline'): a pass must not change a pixel. Take the baseline from the
// untouched build, convert, then compare:
//   VISUAL_SNAPS=/some/dir npx playwright test -c playwright.visual.config.ts --update-snapshots   (baseline)
//   VISUAL_SNAPS=/some/dir npx playwright test -c playwright.visual.config.ts                      (compare)
// `npm run build:html` first each time: the page under test is the built index.html + staff.js.
// Screenshots and diffs go to VISUAL_SNAPS (default: <tmp>/mm-visual-snaps), never into the repo.
const PORT = process.env.VIS_PORT || '4795';
const SNAPS = process.env.VISUAL_SNAPS || join(tmpdir(), 'mm-visual-snaps');

export default defineConfig({
  testDir: 'visual',
  testMatch: '**/*.visual.ts',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  outputDir: join(SNAPS, '_results'),
  snapshotPathTemplate: join(SNAPS, '{arg}{ext}'),
  expect: { toHaveScreenshot: { maxDiffPixels: 0, animations: 'disabled', caret: 'hide', scale: 'device' } },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    serviceWorkers: 'block',
    bypassCSP: true, // string-form evaluate(), as in the suite (playwright.config.ts)
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'Asia/Riyadh',
  },
  webServer: {
    command: `node scripts/serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false, // a server already on the port would be another checkout's
  },
});
