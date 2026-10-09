import { test, expect } from '@playwright/test';
import { stubSupabase, waitForSb } from './helpers/supabase';

// A rider who leaves a forced page through Log out without answering meets it again the next
// time they sign in - on the same page (no reload) or a fresh one (the owner, 2026-10-09: "if a
// log out happens without adding the info requested make sure it pops up again the next time he
// signs in"): the nationality after the first booking, the birth date after the fourth, and the
// emergency contact of every account.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }];
const row = (i: number) => ({
  id: 'b' + i, customer_id: 'c9', session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: i + 1,
  name: 'Test User', phone: '+966508727012', type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75,
  registered_at: '2026-10-01T10:00:00Z',
});
const customer = { id: 'c9', name: 'Test User', email: 'x@y.com', phone: '+966508727012', height: 170, type_preference: 'Road', created_at: '2026-01-01', session_token: 'tok9' };

async function signIn(page: import('@playwright/test').Page) {
  await page.evaluate('openAuthModal()');
  await page.fill('#a-identifier', 'x@y.com');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.evaluate('doLogin()');
  await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
}

async function boot(page: import('@playwright/test').Page, bookings: Record<string, unknown>[], profile: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions, queue_entries: bookings, 'rpc:my_bookings': bookings,
    'rpc:customer_login': [{ ...customer, ...profile }],
    'rpc:customer_profile': [{ ...customer, ...profile }], ...extra,
  });
  await page.goto('/');
  await waitForSb(page);
}

for (const c of [
  { name: 'the nationality, one booking', rows: [row(0)], profile: { nationality: null, birth_date: '1990-01-01' }, host: '#profile-gate .pg-box', field: '#pg-nat' },
  { name: 'the birth date, four bookings', rows: [0, 1, 2, 3].map(row), profile: { nationality: 'Jordan', birth_date: null }, host: '#profile-gate .pg-box', field: '#pg-birth-y' },
]) {
  test(`${c.name}: Log out without answering, sign in again on the same page, and it is back`, async ({ page }) => {
    await boot(page, c.rows, c.profile);
    await signIn(page);
    const box = page.locator(c.host);
    await expect(box).toBeVisible();
    await expect(page.locator(c.field)).toBeVisible();
    await box.locator('.gate-out').click();                            // Log out, nothing given
    await expect(box).toBeHidden();
    expect(await page.evaluate('S.loggedIn')).toBeNull();
    await signIn(page);
    await expect(box).toBeVisible();
    await expect(page.locator(c.field)).toBeVisible();
    await page.reload();                                               // and on a fresh page, still signed in
    await waitForSb(page);
    await expect(box).toBeVisible();
  });
}

test('the emergency contact: Log out without answering, sign in again on the same page, and it is back', async ({ page }) => {
  await boot(page, [], { nationality: 'Jordan', birth_date: '1990-01-01' }, { 'rpc:customer_fix_fields': ['emergency'] });
  await signIn(page);
  const box = page.locator('#fix-gate .fx-box');
  await expect(box).toBeVisible();
  await box.locator('.gate-out').click();
  await expect(box).toBeHidden();
  await signIn(page);
  await expect(box).toBeVisible();
});
