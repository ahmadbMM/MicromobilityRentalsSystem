import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// "Same group again" (the user, 2026-11-19, item 3: "'Book my usual' only books one person today. This would also fill in
// the companions from the rider's last group booking (names, heights, bike types), so a family or group of friends can
// rebook in one go"). The circuit list's shortcut reads the account's latest circuit booking: with companions it says
// Same group again and fills the whole party on the riders step; solo history keeps Book my usual as it was.

const PAST = '2099-02-03';
const S1 = '2099-02-10';
const S2 = '2099-02-17';
const night = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_date: id, day: 'Tuesday', status: 'open', capacity: 12, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":12}', ...extra,
});
const row = (id: string, name: string, q: number, extra: Record<string, unknown> = {}) => ({
  id, session_id: PAST, session_day: 'Tuesday', session_date: PAST, queue_num: q, name, phone: '0500000001',
  customer_id: 'c1', type_preference: 'Road', height: 175, status: 'done', paid: true, price: 75,
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});
// The last circuit booking: a child first in the queue, then the account holder, then a friend.
const party = [
  row('p1', 'Kid One', 4, { type_preference: 'Kids', height: 130 }),
  row('p2', 'Spec Rider', 5, { type_preference: 'Mountain', height: 176 }),
  row('p3', 'Friend Two', 6, { type_preference: 'Hybrid', height: 170 }),
];

async function open(page: Page, rows: Record<string, unknown>[], sessions: Record<string, unknown>[] = [night(S1), night(S2)], cust: Record<string, unknown> = {}) {
  const all = [night(PAST, { status: 'closed' }), ...sessions];
  await stubSupabase(page, { sessions: all, 'rpc:list_sessions': all, queue_entries: rows, 'rpc:my_bookings': rows });
  await loginCustomer(page, { height: 175, type_preference: 'Road', ...cust });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.lastTickets=[];S.selEvent='jcc';S.selSession=null;S.regStep=1;setCustTab('register')`);
}
const usual = (page: Page) => page.locator('#tab-register .cu-usual');

test.describe('@customer:reserve Same group again', () => {
  test('the button says Same group again for a group, and fills the party in order on the riders step', async ({ page }) => {
    await open(page, party);
    await expect(usual(page)).toHaveText(/Same group again/);
    await usual(page).click();
    expect(await page.evaluate('S.regStep')).toBe(2); // never skipped: the rider sees who is coming
    expect(await page.evaluate('S.selSession')).toBe(S1);
    expect(await page.evaluate('S.regQty')).toBe(3);
    // the account holder first (with the account's own height and type, as Book my usual), then the queue's order
    expect(await page.evaluate('S.regRiderNames.slice(0,3)')).toEqual(['Spec Rider', 'Kid One', 'Friend Two']);
    expect(await page.evaluate('S.regBikeHeights.slice(0,3)')).toEqual(['175', '130', '170']);
    expect(await page.evaluate('S.regBikeTypes.slice(0,3)')).toEqual(['Road', 'Kids', 'Hybrid']);
    await expect(page.locator('#reg-rider-name-1')).toHaveValue('Kid One');
    await expect(page.locator('#reg-rider-name-2')).toHaveValue('Friend Two');
    await expect(page.locator('#reg-height-1')).toHaveValue('130');
    await expect(page.locator('#reg-type-wrap-1 [data-type="Kids"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#toast-container')).toContainText('Your group is filled in. Just confirm.');
    // the existing controls take a rider off
    await page.locator('#reg-qty-dec').click();
    expect(await page.evaluate('S.regQty')).toBe(2);
  });

  test('a type the rider may not pick is asked again; a child keeps or gets the Kids bike by height', async ({ page }) => {
    const rows = [
      row('p2', 'Spec Rider', 1),
      row('p3', 'Friend Two', 2, { type_preference: 'Hybrid', height: 170 }), // hidden from this account
      row('p4', 'Third Rider', 3, { type_preference: 'Mountain', height: 168 }), // closed on the night
    ];
    await open(page, rows, [night(S1, { closed_types: ['Mountain'] })], { hidden_types: 'Hybrid' });
    await usual(page).click();
    expect(await page.evaluate('S.regBikeTypes.slice(0,3).map(x=>x||null)')).toEqual(['Road', null, null]);
    // Any (staff's) and None (a seat) are asked again too; a child's height with no type takes Kids, a grown one with Kids does not
    const kids = [
      row('k1', 'Spec Rider', 1),
      row('k2', 'Small Rider', 2, { type_preference: 'Any', height: 120 }),
      row('k3', 'Tall Rider', 3, { type_preference: 'Kids', height: 160 }),
    ];
    await page.evaluate(`S.queue=${JSON.stringify(kids)}.map(entryFromDB);S.lastTickets=[];S.selSession=null;S.regStep=1;renderRegister()`);
    await usual(page).click();
    expect(await page.evaluate('S.regBikeTypes.slice(0,3).map(x=>x||null)')).toEqual(['Road', 'Kids', null]);
  });

  test('the night needs places for the whole party, else the night with the most', async ({ page }) => {
    await open(page, party, [night(S1, { capacity: 2 }), night(S2)]);
    await usual(page).click();
    expect(await page.evaluate('S.selSession')).toBe(S2); // the sooner night has two places for three riders
    await page.evaluate(`S.lastTickets=[];S.selSession=null;S.regStep=1;renderRegister()`);
    await page.evaluate(`S.sessions.forEach(s=>{if(s.id==='${S2}')s.capacity=1;});renderRegister()`);
    await usual(page).click();
    expect(await page.evaluate('S.selSession')).toBe(S1); // none fits: the one with the most places, and step one's checks speak
  });

  test('a party past the riders an account may book is cut there, the holder first, and the riders step says so', async ({ page }) => {
    const four = [...party, row('p4', 'Fourth Rider', 7, { type_preference: 'Road', height: 180 })];
    // the sooner night has three places: enough for the three an account may book, so it is the one picked
    await open(page, four, [night(S1, { capacity: 3 }), night(S2)]);
    await usual(page).click();
    expect(await page.evaluate('S.selSession')).toBe(S1);
    expect(await page.evaluate('S.regQty')).toBe(3);
    expect(await page.evaluate('S.regRiderNames.slice(0,3)')).toEqual(['Spec Rider', 'Kid One', 'Friend Two']);
    await expect(page.locator('#tab-register .qty-cap-note')).toHaveText('One account can book up to 3 riders.');
    // a party within the cap does not say it
    await page.evaluate(`S.queue=${JSON.stringify(party)}.map(entryFromDB);S.lastTickets=[];S.selSession=null;S.regStep=1;renderRegister()`);
    await usual(page).click();
    await expect(page.locator('#tab-register .qty-cap-note')).toHaveCount(0);
  });

  test('solo history keeps Book my usual as it was', async ({ page }) => {
    await open(page, [row('s1', 'Spec Rider', 1), row('x1', 'Gone Friend', 2, { status: 'cancelled' })]);
    await expect(usual(page)).toHaveText(/Book my usual/);
    await usual(page).click();
    expect(await page.evaluate('S.regQty')).toBe(1);
    expect(await page.evaluate('S.regStep')).toBe(3); // height and type known: on to the review, as before
    expect(await page.evaluate('[S.regBikeTypes[0],S.regBikeHeights[0]]')).toEqual(['Road', '175']); // rider 1 is the account holder (no name box)
    await expect(page.locator('#toast-container')).toContainText('Your usual booking is filled in. Just confirm.');
  });

  test('Arabic says it too', async ({ page }) => {
    await open(page, party);
    await page.evaluate(`setLang('ar')`);
    await expect(usual(page)).toHaveText(/المجموعة نفسها مجدداً/);
  });
});
