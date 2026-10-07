import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07 (s01):
// - a staff sign-in whose staff-row lookup failed asks again in the background; that second read
//   named four columns, so the account's own settings (its name, picture and notification choices)
//   never arrived and the operator gate asked the name again;
// - choosing the language by hand asks for its pack at once and starts the waits again, also when
//   a long wait (up to five minutes) was still pending.

const SESSION = {
  access_token: 'fake-jwt', token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fake-refresh',
  user: { id: 'u-staff-1', aud: 'authenticated', role: 'authenticated', email: 'staff@example.com' },
};
const head = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
const ROW: Record<string, unknown> = {
  user_id: 'u-staff-1', role: 'frontdesk', modules_view: null, modules_edit: null, must_change_pwd: false,
  display_name: 'Test Operator', photo: null, nt_off: ['lowrate'],
};

test.describe('@staff:security bughunt oct7 s01 staff row retry', () => {
  test('the background retry after a failed staff lookup brings the account’s settings too', async ({ page }) => {
    await stubSupabase(page, { sessions: [], staff: [ROW], 'auth:token': SESSION });
    await unlockStaff(page);
    let asks = 0;
    const selects: string[] = [];
    // after the stub: the newest route answers. The first read fails; the next ones answer only the
    // columns asked for, as PostgREST does.
    await page.route(/\/rest\/v1\/staff\?/, (r) => {
      const req = r.request();
      if (req.method() !== 'GET') return r.fallback();
      const sel = new URL(req.url()).searchParams.get('select') || '*';
      selects.push(sel);
      // 500, not 503: supabase-js asks again by itself after a 503 or 520
      if (asks++ === 0) return r.fulfill({ status: 500, headers: head, body: JSON.stringify({ code: 'XX000', message: 'unavailable' }) });
      const row = sel === '*' ? ROW : Object.fromEntries(sel.split(',').map((c) => [c, ROW[c]]));
      return r.fulfill({ status: 200, headers: head, body: JSON.stringify([row]) });
    });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`staffAuthSignIn('staff@example.com','Passw0rd!').then(r=>r.ok)`)).toBe(true);
    expect(asks).toBe(1);
    await expect.poll(() => page.evaluate(`S._meName`), { timeout: 15000 }).toBe('Test Operator');
    expect(await page.evaluate(`S.staffRole`)).toBe('frontdesk');
    expect(await page.evaluate(`JSON.stringify(S._ntOff)`)).toBe('["lowrate"]');
    expect(selects[1]).toBe('*');
  });
});

test.describe('@i18n bughunt oct7 s01 language retry', () => {
  test('a hand pick asks again within seconds even when a long wait was pending', async ({ page }) => {
    await stubSupabase(page, { sessions: [] });
    let fail = true;
    const asks: string[] = [];
    await page.route(/\/lang\/fr\.json/, (r) => { asks.push(r.request().url()); return fail ? r.fulfill({ status: 503, body: '' }) : r.fallback(); });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setLang('fr')`);
    await expect.poll(() => asks.length).toBe(1);
    // as after four failed asks: the next one is five minutes away
    await page.evaluate(`clearTimeout(_langRetryT);_langRetryT=setTimeout(()=>{},300000);_langRetryN=5`);
    await page.evaluate(`setLang('fr')`);
    await expect.poll(() => asks.length).toBe(2); // asked at once
    fail = false;
    // and again five seconds later, not five minutes
    await expect.poll(() => page.evaluate(`_langLoaded('fr')`), { timeout: 10000 }).toBe(true);
    expect(asks.length).toBe(3);
  });
});
