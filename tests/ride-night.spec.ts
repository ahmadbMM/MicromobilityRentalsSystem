import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The ticket through the night, the countdown, the route, Your rides and the closest badges
// (the owner, 2026-10-01: "do 1 2 5 6 10"). The clock is held at 15:00 in Riyadh on the ride's
// day; the ride is 18:00 - 20:00 at the circuit, so bikes are collected from 17:15.

const DAY = '2099-02-01';
const NOW = new Date('2099-02-01T15:00:00+03:00');
const jcc = (id: string, date: string, o: Record<string, unknown> = {}) => ({ id, day: 'Sunday', session_date: date, capacity: 20, status: 'open', created_at: 1, location: 'JCC', bike_slots: '{"_time":"18:00 - 20:00","_total":20}', ...o });
const bk = (o: Record<string, unknown>) => ({ name: 'Spec Rider', customer_id: 'c1', session_day: 'Sunday', queue_num: 7, status: 'waiting', paid: true, price: 75, type_preference: 'Hybrid', registered_at: '2099-01-01T10:00:00Z', ...o });
const bikes = [{ id: 'k1', name: 'H-12', type: 'Hybrid', status: 'rented' }];

async function open(page: Page, entries: Record<string, unknown>[], lang = 'en', sessions = [jcc(DAY, DAY)]) {
  await page.clock.setFixedTime(NOW);
  await page.setViewportSize({ width: 390, height: 2400 });
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, bikes, queue_entries: entries });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/?lang=' + lang);
  await waitForSb(page);
  await page.evaluate("goCustomer('myrides')");
}
const stages = (page: Page) => page.locator('#tab-myrides .ticket-card .tk-stages li');

test.describe('@customer:bookings the ride night on the ticket', () => {
  test('before the ride: the countdown to bike collection, Booked, and the circuit drawn', async ({ page }) => {
    await open(page, [bk({ id: 'b1', session_id: DAY, session_date: DAY })]);
    const card = page.locator('#tab-myrides .ticket-card.tk-live');
    await expect(card.locator('.tk-cd')).toHaveText('Bike collection in 2 h 15 min');
    await expect(stages(page)).toHaveText(['Booked', 'Checked in', 'On the bike', 'Done']);
    await expect(card.locator('.tk-stages li[aria-current="step"]')).toHaveText('Booked');
    await expect(card.locator('.tk-route .tk-rt-m')).toHaveText('6.17 km a lap · Flat, smooth tarmac, floodlit at night');
    await expect(card.locator('.tk-rt-map path')).toHaveCount(1);
    // past the collection time it counts to the start, and after the start it is gone
    await page.clock.setFixedTime(new Date('2099-02-01T17:30:00+03:00'));
    await page.evaluate('_cdTick()');
    await expect(card.locator('.tk-cd')).toHaveText('Starts in 30 min');
    await page.clock.setFixedTime(new Date('2099-02-01T18:01:00+03:00'));
    await page.evaluate('_cdTick()');
    await expect(card.locator('.tk-cd')).toHaveCount(0);
  });

  test('checked in without a bike, then on the bike, then done', async ({ page }) => {
    await open(page, [bk({ id: 'b1', session_id: DAY, session_date: DAY, status: 'active', checked_in_at: '2099-02-01T14:20:00Z' })]);
    const card = page.locator('#tab-myrides .ticket-card');
    await expect(card.locator('.cu-cue')).toHaveText('Checked in. Your bike is being handed over.');
    await expect(card.locator('.tk-stages li[aria-current="step"] .tk-st-l')).toHaveText('Checked in');
    await expect(card.locator('.tk-cd')).toHaveCount(0);
    await page.evaluate("S.queue.find(e=>e.id==='b1').assignedBikeId='k1';renderMyRides()");
    await expect(card.locator('.cu-cue')).toHaveText('On the bike: H-12');
    await expect(card.locator('.tk-stages li[aria-current="step"]')).toContainText('On the bike');
    await expect(card.locator('.tk-stages li[aria-current="step"] .tk-st-s')).toHaveText('H-12');
    await page.evaluate("Object.assign(S.queue.find(e=>e.id==='b1'),{status:'done',rideDuration:72,checkedOutAt:'2099-02-01T15:32:00Z'});renderMyRides()");
    const past = page.locator('#tab-myrides .ticket-card.tk-past');
    await expect(past.locator('.cu-cue')).toHaveText('Ride done: 1 h 12 min on the bike.');
    await expect(past.locator('.tk-stages li.on')).toHaveCount(4);
    await expect(past.locator('.tk-rt-done')).toHaveText('Ridden');
  });

  test('a ride a week away has no stages or countdown, and a swim has no route', async ({ page }) => {
    const swim = jcc('sw', DAY, { event_kind: 'community', ride_kind: 'swim', needs_approval: false, location: null });
    await open(page, [bk({ id: 'b1', session_id: '2099-02-08', session_date: '2099-02-08' }), bk({ id: 'b2', session_id: 'sw', session_date: DAY })], 'en', [jcc('2099-02-08', '2099-02-08'), swim]);
    const later = page.locator('#tab-myrides .ticket-card').filter({ hasText: '8' }).last();
    await expect(page.locator('#tab-myrides .ticket-card')).toHaveCount(2);
    await expect(later.locator('.tk-stages')).toHaveCount(0);
    await expect(later.locator('.tk-cd')).toHaveCount(0);
    await expect(page.locator('#tab-myrides .tk-route')).toHaveCount(1); // the circuit night only
  });

  test('the stages fit the card in Arabic on a phone', async ({ page }) => {
    await open(page, [bk({ id: 'b1', session_id: DAY, session_date: DAY, status: 'active', assigned_bike_id: 'k1', checked_in_at: '2099-02-01T14:20:00Z' })], 'ar');
    const card = page.locator('#tab-myrides .ticket-card');
    await expect(card.locator('.tk-stages li')).toHaveCount(4);
    const out = await card.evaluate((c) => {
      const b = c.getBoundingClientRect();
      return [...c.querySelectorAll('.tk-stages li, .tk-route, .tk-cd')].filter((e) => { const r = e.getBoundingClientRect(); return r.left < b.left - 0.5 || r.right > b.right + 0.5; }).length;
    });
    expect(out).toBe(0);
  });
});

test.describe('@customer:account your rides and the closest badges', () => {
  test('the week strip, the record and the badges nearest to earn', async ({ page }) => {
    const past = ['2099-01-04', '2099-01-11', '2099-01-25'];
    const s = past.map((d) => jcc(d, d, { status: 'closed' }));
    await open(page, past.map((d, i) => bk({ id: 'p' + i, session_id: d, session_date: d, status: 'done', ride_duration: 50, rating_exp: 9, rating_detail: { form: 'rental', s: { experience: 9 }, why: {} } })), 'en', s); // rated: an unrated ride would hold the forced rating page over the account
    await page.evaluate("goCustomer('account')");
    const myr = page.locator('#tab-account .myr');
    await expect(myr.locator('.myr-weeks i')).toHaveCount(26);
    await expect(myr.locator('.myr-weeks i.on')).toHaveCount(3);
    await expect(myr.locator('.myr-wl')).toHaveText('3 of the last 26 weeks with a ride');
    await expect(myr.locator('dt')).toHaveText(['Rides this year', 'Favourite bike', 'Time on the bike', 'First ride']);
    await expect(myr.locator('dd').nth(0)).toHaveText('3');
    await expect(myr.locator('dd').nth(1)).toHaveText('Hybrid');
    await expect(myr.locator('dd').nth(2)).toHaveText('2 h 30 min');
    const next = page.locator('#tab-account .bd-next-row');
    await expect(next).toHaveCount(2);
    // two to go on both: Safety Car (4 of 6 weeks, a quiet week forgiven) leads Regular (3 of 5 rides)
    await expect(next.locator('.bd-next-n')).toHaveText(['4/6', '3/5']);
    await next.nth(1).click();
    await expect(page.locator('#badge-pop .badge-pop-prog')).toHaveText('3/5');
  });

  test('no rides: no strip and no closest badges', async ({ page }) => {
    await open(page, []);
    await page.evaluate("goCustomer('account')");
    await expect(page.locator('#tab-account .mr-season')).toBeVisible();
    await expect(page.locator('#tab-account .myr')).toHaveCount(0);
    await expect(page.locator('#tab-account .bd-next')).toHaveCount(0);
  });
});
