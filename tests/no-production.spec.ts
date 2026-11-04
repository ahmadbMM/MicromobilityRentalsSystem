import { test, expect } from '@playwright/test';
import { stubSupabase } from './helpers/supabase';

// The suite never touches production, and not only because every spec remembers to stub. The stubs work a page at a
// time, so a second tab nobody stubbed read the real project: s1009-custom-prefs did, thousands of requests a day
// from CI, and it failed whenever production was slow, which blocked the deploy on the night of 2026-11-03.
// playwright.config.ts makes the project's host fail to resolve in the browsers the suite starts.
const PROD = 'https://qpffkzmsfyilicwcsszz.supabase.co/rest/v1/sessions?select=id&limit=1';
const ask = (url: string) => fetch(url).then((r) => r.status, () => 'no answer');

test.describe('@build the suite cannot reach production', () => {
  test('a tab nobody stubbed gets no answer: the host does not resolve', async ({ page, context }) => {
    const tab = await context.newPage();
    const failed: (string | undefined)[] = [];
    tab.on('requestfailed', (r) => failed.push(r.failure()?.errorText));
    await tab.goto('/robots.txt');
    expect(await tab.evaluate(ask, PROD)).toBe('no answer');
    expect(failed).toEqual(['net::ERR_NAME_NOT_RESOLVED']);
    expect(page.isClosed()).toBe(false);
  });

  test('a stubbed page is answered as before: the stub comes first', async ({ page }) => {
    await stubSupabase(page, { sessions: [] });
    await page.goto('/robots.txt');
    expect(await page.evaluate(ask, PROD)).toBe(200);
  });
});
