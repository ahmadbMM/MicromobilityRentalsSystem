import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Petromin billing report and the roster, 2026-09-22:
//  * the printed sheet numbers its rows 1, 2, 3… in booking order — the P-0NN a rider was given
//    is on their badge, the sheet is an invoice line-up;
//  * its summary says how many of each bike type went out, Mountain included;
//  * a rider who registered on the form is handled on the Petromin page, so their booking is off
//    the Queue's own list.

const D = '2099-03-04';
const SESS = `${D}-pw`;
const sessions = [
  { id: SESS, day: 'Wednesday', session_date: D, capacity: 35, status: 'open', created_at: 1, ride_kind: 'petromin', event_kind: 'community', paid_ride: true, bike_slots: JSON.stringify({ _time: '19:00 - 21:00' }) },
];
const entry = (id: string, n: number, name: string) => ({
  id, session_id: SESS, session_day: 'Wednesday', session_date: D, queue_num: n, name, phone: `05000000${n}${n}`,
  type_preference: 'Hybrid', size: 'M', status: 'waiting', paid: false, price: 60, registered_at: `${D}T10:0${n}:00Z`,
});
const base = { source: 'petromin', company: 'Petromin', created_at: `${D}T09:00:00Z`, updated_at: `${D}T09:00:00Z`, height: 175, party_no: 1, submissions: 1, match_kind: 'none', matched_entry_id: null, matched_customer_id: null, checked_in_at: `${D}T16:00:00Z` };
const reg = (id: number, no: string, name: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ ...base, id, session_id: SESS, booking_no: no, badge: `B${id}`, name, phone: `+96650000000${id}`, type_preference: type, checked_out_at: `${D}T17:30:00Z`, price: type === 'Road' ? 75 : 50, ...extra });

type P = import('@playwright/test').Page;
async function boot(page: P, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test('the printed report numbers its rows 1..N and counts every bike type, Mountain included', async ({ page }) => {
  await boot(page, {
    rider_registrations: [
      reg(1, 'P-003', 'Third Rider', 'Mountain'),
      reg(2, 'P-001', 'First Rider', 'Road'),
      reg(3, 'P-002', 'Second Rider', 'Mountain'),
    ],
  });
  await page.evaluate(`S.ridersSession=${JSON.stringify(SESS)};setStaffTab('riders')`);
  await expect(page.locator('#riders-results tbody tr')).toHaveCount(3);
  // catch what the print window would have been given
  const html = await page.evaluate(`(()=>{let out='';const real=window.open;S._rxTap=(h)=>{out=h;return true;};
    printRidersReport('Petromin');window.open=real;return out;})()`) as string;

  const rows = [...html.matchAll(/<tr><td>(\d+)<\/td><td>/g)].map((m) => m[1]);
  expect(rows).toEqual(['1', '2', '3']);                       // 1..N, not P-001 / P-002 / P-003
  expect(html.indexOf('First Rider')).toBeLessThan(html.indexOf('Second Rider'));  // booking order kept
  expect(html.indexOf('Second Rider')).toBeLessThan(html.indexOf('Third Rider'));
  // the summary: rides, then one tile per bike type
  expect(html).toMatch(/<span class="total-num">2<\/span><span class="total-lbl">Mountain<\/span>/);
  expect(html).toMatch(/<span class="total-num">1<\/span><span class="total-lbl">Road<\/span>/);
});

test("a rider who came from the form is on the Petromin page, not on the Queue's list", async ({ page }) => {
  await boot(page, {
    queue_entries: [entry('q1', 1, 'Website Rider'), entry('q2', 2, 'Form Rider')],
    rider_registrations: [reg(1, 'P-001', 'Form Rider', 'Hybrid', { matched_entry_id: 'q2', match_kind: 'booking', checked_out_at: null })],
  });
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession=${JSON.stringify(SESS)};renderStaffQueue()`);
  await expect.poll(async () => await page.evaluate(`document.getElementById('q-results').innerText`)).toContain('Website Rider');
  expect(await page.evaluate(`document.getElementById('q-results').innerText`)).not.toContain('Form Rider');
  // the roster's own figures leave them out too — they are counted on the Petromin page
  expect(await page.evaluate(`document.getElementById('tab-queue').innerText`)).toMatch(/1\s*#? ?of Riders|1\s*Riders/i);
  // and there they are
  await page.evaluate(`S.ridersSession=${JSON.stringify(SESS)};setStaffTab('riders')`);
  await expect(page.locator('#riders-results')).toContainText('Form Rider');
});
