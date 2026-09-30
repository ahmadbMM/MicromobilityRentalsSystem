import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// A rider signed in with Google on 24 Sep 2026 came back two hours later to a page where every
// read came back 401 (PGRST303): supabase-js judges a token's expiry by the phone's own clock,
// and a phone running slow kept sending the sign-in the server had already expired, without
// ever renewing it. Public reads went down with it, list_sessions included, and the booking
// list said no sessions were available while the week's rides were open.

const fixtures = {
  sessions: [{ id: 's1', day: 'Sunday', session_date: '2099-01-04', capacity: 12, status: 'open', created_at: 1, location: 'JCC' }],
  bikes: [{ id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 }],
  queue_entries: [],
};

const googleUser = { id: 'u-rider-1', aud: 'authenticated', role: 'authenticated', email: 'spec@example.com', app_metadata: { provider: 'google' } };

test('a sign-in token the server refuses is renewed once and the sessions load', async ({ page }) => {
  await stubSupabase(page, {
    ...fixtures,
    'auth:token': {
      access_token: 'fresh-jwt', token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r2', user: googleUser,
    },
  });
  // The server has expired this token; the phone's clock says it has hours left, so
  // supabase-js keeps sending it and never renews it on its own.
  const seen: string[] = [];
  await page.route('**://*.supabase.co/rest/v1/**', (route) => {
    const auth = route.request().headers()['authorization'] || '';
    seen.push(auth.replace(/^Bearer\s+/, ''));
    if (auth === 'Bearer stale-jwt') {
      return route.fulfill({
        status: 401,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'PGRST303', message: 'JWT expired', details: null, hint: null }),
      });
    }
    return route.fallback();
  });
  await page.addInitScript((u) => {
    localStorage.setItem('sb-amyqxovbnlreassrqihr-auth-token', JSON.stringify({
      access_token: 'stale-jwt', token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3 * 3600, refresh_token: 'r1', user: u,
    }));
  }, googleUser);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);

  expect(seen).toContain('stale-jwt'); // the scenario really ran
  expect(seen).toContain('fresh-jwt'); // and the refused requests went again on a renewed token
  expect(await page.evaluate(`S.sessions.map(s=>s.id)`)).toEqual(['s1']);

  await page.locator('#land-events .landing-event-card.ev-jcc').click();
  await page.waitForFunction(`S.view==='customer'`);
  await expect(page.locator('.sess-card')).toHaveCount(1);
  await expect(page.locator('.sess-load-err')).toHaveCount(0);
});

test('a sessions read that failed says so and offers a retry, not "no sessions available"', async ({ page }) => {
  let fail = true;
  await stubSupabase(page, fixtures);
  await page.route('**://*.supabase.co/rest/v1/rpc/list_sessions', (route) => fail
    ? route.fulfill({
      status: 500,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'XX000', message: 'boom', details: null, hint: null }),
    })
    : route.fallback());
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await page.waitForFunction(`typeof S!=='undefined'&&S.dataLoaded&&S._sessErr===true`);

  await page.evaluate(`selectEvent('jcc')`);
  await page.waitForFunction(`S.view==='customer'`);
  const err = page.locator('.sess-load-err');
  await expect(err).toBeVisible();
  await expect(page.locator('#tab-register')).not.toContainText('No rides are open for booking right now.');

  fail = false;
  await err.getByRole('button').click();
  await expect(page.locator('.sess-card')).toHaveCount(1);
  await expect(err).toHaveCount(0);
});
