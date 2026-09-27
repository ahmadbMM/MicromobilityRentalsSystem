import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// A waitlisted booking used to show the WORD "Waitlist" where its number goes, so the rider
// had nothing to quote at the desk and staff had no count of who was queued. The number now
// stays and the waitlisted state is said loudly beside it — on the rider's card and on the
// staff roster — and the staff panel counts and filters them.

const sess = {
  id: '2099-01-13-pw', session_date: '2099-01-13', day: 'Wednesday', status: 'open',
  capacity: 2, created_at: 1, event_kind: 'community', ride_kind: 'petromin', paid_ride: true,
  needs_approval: false, hide_queue: false, title: 'Petromin Wednesday Ride',
  bike_slots: '{"_time":"19:00 - 21:00","_total":2}',
};
const qe = (id: string, n: number, status: string, wl: number | null, cust: string | null) => ({
  id, session_id: sess.id, session_day: 'Wednesday', session_date: '2099-01-13',
  queue_num: n, waitlist_num: wl, name: 'Rider ' + n, size: 'M', type_preference: 'Road',
  status, paid: false, price: 75, customer_id: cust, registered_at: '2099-01-01T10:00:00Z',
});
const queue_entries = [
  qe('a', 1, 'waiting', null, null), qe('b', 2, 'waiting', null, null),
  qe('c', 3, 'waitlist', 1, 'c1'), qe('d', 4, 'waitlist', 2, null),
];

test.describe('a rider on the waitlist', () => {
  test('keeps their booking number, and is told loudly that they are waitlisted', async ({ page }) => {
    await stubSupabase(page, { sessions: [sess], bikes: [], queue_entries, 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Rider 3' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`showView('customer');setCustTab('myrides')`);

    const card = page.locator('#tab-myrides').first();
    await expect(card).toContainText('#3');                    // the number, not the word in its place
    await expect(page.locator('.ticket-num-label.wl-loud').first()).toContainText(/waitlist/i);
    await expect(page.locator('#tab-myrides .badge-waitlist').first()).toBeVisible();
    // and they are told what it means, with the number staff can quote back to them
    await expect(page.locator('.ticket-num-label.wl-loud').first()).toContainText('W1');
    await expect(page.locator('.wl-note').first()).toContainText(/W1 in line/i);
  });
});

test.describe('the staff panel', () => {
  async function staffQueue(page: import('@playwright/test').Page) {
    await stubSupabase(page, { sessions: [sess], bikes: [], queue_entries });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.sfSession='${sess.id}';renderStaffQueue()`);
  }

  test('lists waitlisted bookings with their numbers and a badge of their own', async ({ page }) => {
    await staffQueue(page);
    const html = await page.evaluate(`document.getElementById('tab-queue').innerHTML`) as string;
    expect(html).toContain('#3');
    expect(html).toContain('W1');                 // the waitlist position staff order by
    expect(html).toContain('badge-waitlist');     // its own badge, not the "waiting" one
    // and it is a heavier, louder treatment than a rider who actually has a place
    const weights = await page.evaluate(`(()=>{const w=document.querySelector('.badge-waitlist'),v=document.querySelector('.badge-waiting');
      return [getComputedStyle(w).fontWeight, getComputedStyle(v).fontWeight];})()`) as string[];
    expect(Number(weights[0])).toBeGreaterThan(Number(weights[1]));
  });

  test('counts them on the stats row, and the count filters to them', async ({ page }) => {
    await staffQueue(page);
    const stat = page.locator('.stat-chip', { hasText: /waitlist/i }).first();
    await expect(stat).toContainText('2');
    await stat.click();
    expect(await page.evaluate('S.sfStatus')).toBe('waitlist');
    // "Rider" is also a column heading, so count body rows naming a numbered rider
    const rows = await page.evaluate(`Array.from(document.querySelectorAll('#q-results tbody tr, #q-results .q-card')).map(r=>r.textContent||'').filter(x=>/Rider \\d/.test(x)).length`);
    expect(rows).toBe(2); // only the two waitlisted riders remain
  });

  test('offers waitlist in the status filter on an ordinary session too', async ({ page }) => {
    await staffQueue(page);
    const opts = await page.evaluate(`Array.from(document.querySelectorAll('select')).flatMap(s=>Array.from(s.options||[]).map(o=>o.value))`) as string[];
    expect(opts).toContain('waitlist');
  });

  test('a session with nobody waitlisted shows no such card', async ({ page }) => {
    await stubSupabase(page, { sessions: [sess], bikes: [], queue_entries: [qe('a', 1, 'waiting', null, null)] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.sfSession='${sess.id}';renderStaffQueue()`);
    await expect(page.locator('.stat-chip', { hasText: /waitlist/i })).toHaveCount(0);
  });
});
