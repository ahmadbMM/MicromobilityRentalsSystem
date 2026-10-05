import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Tickets and the account, 2026-10-05 fixes: a waitlisted rider's place is the server's live rank
// (never the W serial), an own-bike ride on a paid night counts as ridden, the badge popup behaves as
// a dialog, and the calendar file speaks the rider's language and the ride's kind.

const PW = {
  id: '2099-01-13-pw', session_date: '2099-01-13', day: 'Wednesday', status: 'open', capacity: 2, created_at: 1,
  event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, title: 'Petromin Wednesday Ride',
  bike_slots: '{"_time":"19:00 - 21:00","_total":2}',
};
const qe = (id: string, n: number, status: string, wl: number | null, cust: string | null, extra: Record<string, unknown> = {}) => ({
  id, session_id: PW.id, session_day: 'Wednesday', session_date: '2099-01-13', queue_num: n, waitlist_num: wl,
  name: 'Rider ' + n, size: 'M', type_preference: 'Road', status, paid: false, price: 75, customer_id: cust,
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});
// W7 for the rider, but only one rider is still ahead of them
const queue = [qe('a', 1, 'waiting', null, null), qe('b', 2, 'waiting', null, null), qe('x', 3, 'waitlist', 6, null), qe('c', 4, 'waitlist', 7, 'c1')];
async function myRides(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, { sessions: [PW], bikes: [], queue_entries: queue, 'rpc:community_member': true, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Rider 4' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`showView('customer');setCustTab('myrides')`);
}

test.describe('@customer:bookings fix5 tickets', () => {
  test("a waitlisted rider's place is the server's rank, not the W serial", async ({ page }) => {
    await myRides(page, { 'rpc:customer_waitlist_ranks': [{ entry_id: 'c', rank: 2 }] });
    await expect(page.locator('#tab-myrides .wl-note').first()).toContainText('number 2 in line');
    await expect(page.locator('#tab-myrides .ticket-num-label.wl-loud').first()).toContainText('number 2 in line');
    await expect(page.locator('#tab-myrides')).not.toContainText('number 7');
  });

  test('with no rank from the server the ticket says only that the rider is in line', async ({ page }) => {
    await myRides(page, { 'rpc:customer_waitlist_ranks': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_waitlist_ranks in the schema cache' } } });
    await expect(page.locator('#tab-myrides .wl-note').first()).toContainText('in line for a place');
    await expect(page.locator('#tab-myrides')).not.toContainText('number 7');
    await expect(page.locator('#tab-myrides .ticket-num-label.wl-loud').first()).not.toContainText('number');
  });

  test("an own-bike ride on a paid night counts as ridden", async ({ page }) => {
    const past = { ...PW, id: '2026-01-14-pw', session_date: '2026-01-14', status: 'closed' };
    const own = { ...qe('o1', 5, 'done', null, 'c1'), session_id: past.id, session_date: '2026-01-14', type_preference: 'Own', price: 0 };
    await stubSupabase(page, { sessions: [past], bikes: [], queue_entries: [own], 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Rider 5' });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`_rideCompleted(getQueue().find(e=>e.id==='o1'))`)).toBe(true);
    await page.evaluate(`showView('customer');setCustTab('myrides')`);
    await expect(page.locator('#tab-myrides .ticket-card')).toHaveCount(1); // the past ride, not "nothing yet"
  });

  test('the badge popup takes the focus, closes on Escape and gives the focus back', async ({ page }) => {
    await myRides(page, {});
    await page.evaluate(`setCustTab('account')`);
    await page.locator('#acc-first').focus();
    await page.evaluate('_mrBadgeInfo(0)');
    await expect(page.locator('#badge-pop .badge-pop-box > button')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#badge-pop')).toHaveCount(0);
    await expect(page.locator('#acc-first')).toBeFocused();
  });

  test('the calendar file names a rental a rental, and anything else a booking', async ({ page }) => {
    const swim = { id: '2099-01-14-swim', session_date: '2099-01-14', day: 'Thursday', status: 'open', capacity: 10, created_at: 1, event_kind: 'community', ride_kind: 'swim', needs_approval: false, bike_slots: '{"_time":"07:00 - 08:00"}' };
    const circuit = { id: '2099-01-15', session_date: '2099-01-15', day: 'Friday', status: 'open', capacity: 10, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":10}' };
    await stubSupabase(page, { sessions: [swim, circuit], bikes: [], queue_entries: [] });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    const ics = (id: string) => page.evaluate(`new Promise(res=>{const o=URL.createObjectURL;URL.createObjectURL=b=>{URL.createObjectURL=o;b.text().then(res);return o.call(URL,b);};downloadBookingICS('${id}');})`) as Promise<string>;
    const s = await ics(swim.id);
    expect(s).toContain('DESCRIPTION:Your MicroMobility booking.');
    expect(s).not.toContain('bike rental');
    expect(s).toMatch(/DESCRIPTION:Reminder: /);
    const c = await ics(circuit.id);
    expect(c).toContain('DESCRIPTION:Your MicroMobility bike rental.');
  });
});
