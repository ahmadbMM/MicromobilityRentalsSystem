import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The owner, 2026-11-03: "show jcc waitlisted bookings that they collect their bikes on 9:15 and make it clear
// that they are waitlisted". A circuit night's riders with a place collect from 8:15 PM; those on its waitlist
// are told 9:15 PM, under a solid band. The other rides keep their one collection time.

const JCC = '2099-01-13';
const PM = '2099-01-14-pm';
const jcc = { id: JCC, session_date: JCC, day: 'Tuesday', status: 'open', capacity: 2, created_at: 1, event_kind: null, ride_kind: null, bike_slots: '{"_time":"21:00 - 23:00","_collect":"20:15","_total":2}' };
const petromin = { id: PM, session_date: '2099-01-14', day: 'Wednesday', status: 'open', capacity: 1, created_at: 2, event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false, title: 'Petromin Wednesday Ride', bike_slots: '{"_time":"19:00 - 21:00","_collect":"18:45","_total":1}' };
const qe = (id: string, sid: string, n: number, status: string, wl: number | null, cust: string | null, reg = '2099-01-01T10:00:00Z') => ({
  id, session_id: sid, session_day: 'Tuesday', session_date: sid.slice(0, 10), queue_num: n, waitlist_num: wl, name: 'Rider ' + n,
  size: 'M', type_preference: 'Road', status, paid: false, price: 75, customer_id: cust, registered_at: reg,
});

async function open(page: import('@playwright/test').Page, queue_entries: unknown[], lang = 'en') {
  await stubSupabase(page, { sessions: [jcc, petromin], bikes: [], queue_entries, 'rpc:community_member': true, 'rpc:customer_waitlist_ranks': [{ entry_id: 'c', rank: 3 }] });
  await loginCustomer(page, { id: 'c1', name: 'Rider 12' });
  await page.goto('/?lang=' + lang);
  await waitForSb(page);
  await page.evaluate(`showView('customer');setCustTab('myrides')`);
}

test.describe('a circuit night waitlist', () => {
  test('My Bookings says 9:15 PM under a solid waitlist band, and 8:15 PM nowhere', async ({ page }) => {
    await open(page, [qe('c', JCC, 12, 'waitlist', 3, 'c1')]);
    const card = page.locator('#tab-myrides .ticket-card').first();
    await expect(card).toHaveClass(/\btk-wl\b/);
    await expect(card.locator('.wl-collect')).toHaveText('Waitlisted riders collect bikes from 9:15 PM');
    await expect(card).not.toContainText('8:15');
    const band = await card.locator('.wl-loud').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(band).not.toBe('rgba(0, 0, 0, 0)');
    await expect(card.locator('.wl-loud')).toContainText('On the waitlist');
  });

  test('the card after booking says 9:15 PM in its line and its collection field', async ({ page }) => {
    await open(page, [qe('c', JCC, 12, 'waitlist', 3, 'c1')]);
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${JCC}';S.lastTickets=getQueue().filter(e=>e.id==='c');renderRegister();`);
    const card = page.locator('#tab-register .ticket-card');
    await expect(card.locator('.wl-collect')).toHaveText('Waitlisted riders collect bikes from 9:15 PM');
    await expect(card.locator('.ticket-col', { hasText: 'Bike collection time' }).locator('.ticket-value')).toHaveText('9:15 PM');
    await expect(card).not.toContainText('8:15');
  });

  test('a rider with a place still collects at 8:15 PM', async ({ page }) => {
    await open(page, [qe('c', JCC, 2, 'waiting', null, 'c1')]);
    const card = page.locator('#tab-myrides .ticket-card').first();
    await expect(card.locator('.tk-collect')).toContainText('Collect bikes from 8:15 PM');
    await expect(card.locator('.wl-collect')).toHaveCount(0);
  });

  test('a party with one rider on the waitlist: the ticket says 8:15 PM, that rider 9:15 PM', async ({ page }) => {
    await open(page, [qe('a', JCC, 2, 'waiting', null, 'c1'), qe('c', JCC, 12, 'waitlist', 3, 'c1')]);
    const card = page.locator('#tab-myrides .ticket-card').first();
    await expect(card.locator('.tk-collect')).toContainText('8:15 PM');
    await expect(card.locator('.cu-tr-row .wl-collect')).toHaveCount(1);
    await expect(card.locator('.cu-tr-row', { hasText: 'Rider 12' }).locator('.wl-collect')).toContainText('9:15 PM');
    await expect(card.locator('.cu-tr-row', { hasText: 'Rider 2' }).locator('.wl-collect')).toHaveCount(0);
  });

  test('another ride keeps its one collection time on the waitlist', async ({ page }) => {
    await open(page, [qe('c', PM, 12, 'waitlist', 3, 'c1')]);
    const card = page.locator('#tab-myrides .ticket-card').first();
    await expect(card.locator('.wl-collect')).toHaveCount(0);
    await expect(card.locator('.tk-collect')).toContainText('6:45 PM');
  });

  test('Arabic says it too, in Western digits', async ({ page }) => {
    await open(page, [qe('c', JCC, 12, 'waitlist', 3, 'c1')], 'ar');
    await expect(page.locator('#tab-myrides .ticket-card .wl-collect').first()).toHaveText('استلام الدراجات لقائمة الانتظار من 9:15 م');
  });

  test('the landing on the night says 9:15 PM', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2099-01-13T15:00:00+03:00'));
    await open(page, [qe('c', JCC, 12, 'waitlist', 3, 'c1')]);
    await page.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="zz-today">'+_todayCardHtml(getCustomers().find(c=>c.id==='c1')||{id:'c1'})+'</div>')`);
    await expect(page.locator('#zz-today .land-today.wl .wl-collect')).toHaveText('Waitlisted riders collect bikes from 9:15 PM');
  });
});
