import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';
// These specs cover the automatic promotion: Settings > Business wl_offer_mode 'auto' (the default is 'staff' since
// 2026-10-09, R7: staff choose who gets a freed place, tests/s1010-remind-waitlist.spec.ts).
const WL_AUTO = [{ key: 'biz', items: { wl_offer_mode: 'auto' } }];

// The 2026-09-25 review: the app side of the database fixes (20260925140000), and a staff path
// the review found promoting a waitlister into a place nobody had given up.

const S1 = '2099-02-01';
const sessions = [
  { id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 10, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":10}' },
];
function rpcCalls(page: Page, name: string) {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(`/rest/v1/rpc/${name}`)) calls.push(r.postDataJSON());
  });
  return calls;
}

test('a paid booking is not moved to a dearer bike from the phone; one that costs the same is', async ({ page }) => {
  const holder = {
    id: 'holder', session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: 5, name: 'Spec Rider', phone: '0500000001',
    customer_id: 'c1', type_preference: 'Hybrid', height: 175, size: 'M', status: 'waiting', paid: true, price: 57.5, registered_at: '2099-01-01T10:00:00Z',
  };
  await stubSupabase(page, { staff_options: WL_AUTO, sessions, 'rpc:list_sessions': sessions, queue_entries: [holder], bikes: [], 'rpc:customer_booking_update': true });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  const updates = rpcCalls(page, 'customer_booking_update');
  await page.evaluate(`S.lastTickets=[];S.selEvent='jcc';S.selSession='${S1}';S.regStep=2;setCustTab('register')`);
  await expect.poll(() => page.evaluate('S.modifyEntryId')).toBe('holder');
  // Road Carbon is 250: the desk hands that bike over and takes the difference
  await page.evaluate(`S.regBikeTypes=['Road Carbon'];submitModifyBooking()`);
  await expect(page.locator('.toast').last()).toContainText('already paid');
  expect(updates.length).toBe(0);
  await page.evaluate(`S.regBikeTypes=['Mountain'];submitModifyBooking()`);
  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0]).toMatchObject({ p_entry_id: 'holder', p_patch: { type_preference: 'Mountain' } });
});

test("the rider's own hidden bike types and on-the-house perk arrive with the profile as a booking starts", async ({ page }) => {
  await stubSupabase(page, { staff_options: WL_AUTO,
    sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', hidden_types: 'Road', default_pay: 'house:Hybrid' }],
  });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`selectEvent('jcc')`);
  await expect.poll(() => page.evaluate(`_regTypeHidden('Road')`)).toBe(true);
  expect(await page.evaluate(`[_regHouseFor('Hybrid'),_regHouseFor('Road')]`)).toEqual([true, false]);
});

test('cancelling an own-bike rider, who held no place, promotes nobody; cancelling a rider who held one does', async ({ page }) => {
  // Tomorrow's ride: a ride that is over takes nobody new (_sessEnded, 2026-10-05), and from 23:00 in
  // Riyadh a 21:00-23:00 ride dated today is over, which turned this red for the last hour of every day.
  const TODAY = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  const sess = [{ id: TODAY, session_date: TODAY, day: 'Friday', status: 'open', capacity: 1, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":1}' }];
  const row = (id: string, n: number, name: string, x: Record<string, unknown> = {}) => ({
    id, session_id: TODAY, session_day: 'Friday', session_date: TODAY, queue_num: n, name, phone: `05500000${n}0`,
    type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: `${TODAY}T10:0${n}:00Z`, ...x,
  });
  await stubSupabase(page, { staff_options: WL_AUTO,
    sessions: sess,
    queue_entries: [row('e1', 1, 'Amal Saad'), row('own', 2, 'Badr Omar', { type_preference: 'Own', price: 0 }), row('wl', 3, 'Dana Faisal', { status: 'waitlist', waitlist_num: 1 })],
    bikes: [],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const promotes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries') && r.url().includes('id=eq.wl') && /"status":"waiting"/.test(r.postData() || '')) promotes.push(r.url());
  });
  await page.evaluate(`_staffCancelNow('own')`);
  await page.waitForTimeout(400);
  expect(promotes.length).toBe(0);
  await page.evaluate(`_staffCancelNow('e1')`);
  await expect.poll(() => promotes.length).toBe(1);
});
