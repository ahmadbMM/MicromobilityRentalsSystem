import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Where staff pick riders, two helps: the rider's no-show history as a chip (from the second
// offence — one no-show is a flat tyre, two is a pattern), and one press to approve every
// PENDING request still waiting. Waitlisted requests are exactly the ones parked to decide
// individually, so bulk leaves them alone.

const SAT = 'sat-1';
const sessions = [{ id: SAT, session_date: '2099-01-06', day: 'Saturday', status: 'open', capacity: 30, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false, spots: 30 }];
const e = (id: string, x: Record<string, unknown> = {}) => ({
  id, session_id: SAT, session_day: 'Saturday', session_date: '2099-01-06', queue_num: 1,
  name: 'R ' + id, phone: '0550000009', type_preference: 'Any', size: 'M', status: 'waiting',
  paid: false, price: 0, registered_at: '2099-01-01T10:00:00Z', approval: 'pending', customer_id: 'cust1', ...x });

async function boot(page: import('@playwright/test').Page, queue_entries: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${SAT}';renderStaffQueue()`);
  await page.waitForTimeout(250);
}

test('two past no-shows put a chip on the request; one does not', async ({ page }) => {
  await boot(page, [
    e('now'),
    e('h1', { queue_num: 2, status: 'noshow', registered_at: '2098-12-01T10:00:00Z' }),
    e('h2', { queue_num: 3, status: 'noshow', registered_at: '2098-11-01T10:00:00Z' }),
    e('h3', { queue_num: 4, status: 'done',   registered_at: '2098-10-01T10:00:00Z' }),
    e('other', { queue_num: 5, customer_id: 'cust2', phone: '0550000002' }),
  ]);
  const txt = await page.evaluate(`document.getElementById('tab-queue').innerText`) as string;
  expect(txt).toMatch(/2\/3 no-shows/i); // the chip is a capitalised tile since 8b1a9f1
  // and the clean rider carries nothing
  const rows = await page.evaluate(`[...document.querySelectorAll('#q-results tbody tr, #q-results .q-card')].map(r=>r.innerText)`) as string[];
  const otherRow = rows.find((r) => r.includes('R other'))!;
  expect(otherRow).not.toMatch(/no-shows/i);
});

test('bulk approve takes the pending-and-waiting, leaves the waitlist, and is guarded', async ({ page }) => {
  await boot(page, [
    e('p1'), e('p2', { queue_num: 2 }),
    e('w1', { queue_num: 3, status: 'waitlist', waitlist_num: 1 }),
    e('done1', { queue_num: 4, approval: 'approved' }),
  ]);
  const patches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) patches.push(r.url());
  });
  await expect(page.locator('#tab-queue')).toContainText('Approve all (2)');
  await page.getByRole('button', { name: /Approve all/ }).click();
  await page.locator('.confirm-box button').filter({ hasText: /^✓?\s*Approve$/i }).click();
  await expect.poll(() => patches.length, { timeout: 5000 }).toBeGreaterThan(0);
  const u = decodeURIComponent(patches[0]);
  expect(u).toContain('id=in.(p1,p2)');
  expect(u).toContain('approval=eq.pending');   // a just-rejected rider is not resurrected
});

// The owner, 2026-10-02: "dont add a separate button for undo approval, clicking on the approved
// button undos approval, and remove the multi select button from the saturday social ride".
test('the Approved tile undoes the approval itself, and the Saturday ride has no select boxes', async ({ page }) => {
  await boot(page, [e('a1', { approval: 'approved' }), e('p1', { queue_num: 2 })]);
  const tab = page.locator('#tab-queue');
  await expect(tab.getByRole('button', { name: /Undo approval/ }).filter({ hasNotText: /Approved/i })).toHaveCount(0);
  await expect(tab.locator('.row-select')).toHaveCount(0);
  const patches: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) patches.push(r.postData() || ''); });
  await tab.locator('button.rq-apok').first().click();
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  expect(JSON.parse(patches[0])).toMatchObject({ approval: 'pending' });
});

test('a circuit night keeps its select boxes', async ({ page }) => {
  const NIGHT = 'n-1';
  await stubSupabase(page, { sessions: [{ id: NIGHT, session_date: '2099-01-05', day: 'Monday', status: 'open', capacity: 30, created_at: 1 }],
    queue_entries: [e('c1', { session_id: NIGHT, session_day: 'Monday', session_date: '2099-01-05', approval: null, price: 115 })], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${NIGHT}';renderStaffQueue()`);
  await expect(page.locator('#tab-queue .row-select')).not.toHaveCount(0);
});
