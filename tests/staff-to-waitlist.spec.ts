import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-07: "add an action to do bookings to change a current booking to waitlist,
// and add an option when adding a rider in a booking to add them waitlisted".
const sessions = [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }];
const qe = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id, name: 'Rider ' + n, phone: '050000000' + n, session_id: 's1', session_day: 'Friday', session_date: '2099-01-09',
  queue_num: n, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-09T10:00:00Z', ...extra,
});

async function open(page: import('@playwright/test').Page, queue_entries = [qe('e1', 1), qe('e2', 2, { status: 'waitlist', waitlist_num: 1 })]) {
  await stubSupabase(page, { sessions, queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
}

function patches(page: import('@playwright/test').Page) {
  const out: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('queue_entries')) out.push(r.url() + ' ' + (r.postData() || '')); });
  return out;
}
function posts(page: import('@playwright/test').Page) {
  const out: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/queue_entries')) out.push(r.postData() || ''); });
  return out;
}

test('a waiting booking offers Move to waitlist; a waitlisted one does not', async ({ page }) => {
  await open(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='s1';S.sfStatus='all';renderStaffQueue()`);
  await page.waitForFunction(`S._rowMenus&&S._rowMenus['e1']&&S._rowMenus['e2']`);
  const labels = await page.evaluate(`({a:S._rowMenus['e1'].map(i=>i.label),b:S._rowMenus['e2'].map(i=>i.label)})`) as { a: string[]; b: string[] };
  expect(labels.a.some((l) => /Move to waitlist/.test(l))).toBe(true);
  expect(labels.b.some((l) => /Move to waitlist/.test(l))).toBe(false);
});

test('Move to waitlist puts the booking at the end of the line, guarded on waiting', async ({ page }) => {
  await open(page);
  const writes = patches(page);
  await page.evaluate(`staffToWaitlist('e1')`);
  await expect.poll(() => writes.find((w) => /"status":"waitlist"/.test(w))).toBeTruthy();
  const w = writes.find((x) => /"status":"waitlist"/.test(x))!;
  expect(w).toContain('id=eq.e1');
  expect(w).toContain('status=eq.waiting');
  expect(w).toContain('"waitlist_num":2'); // behind the rider already on W1
  expect(w).not.toContain('approval');
});

test('a rider added in the editor with Waitlist ticked is booked waitlisted, the others are not', async ({ page }) => {
  await open(page);
  const sent = posts(page);
  await page.evaluate(`(async()=>{ showBookingEditModal('e1'); _beAddRider(); _beAddRider();
    document.getElementById('be-nr-name-0').value='Seated Rider';
    document.getElementById('be-nr-name-1').value='Parked Rider';
    document.getElementById('be-nr-wl-1').checked=true;
    await saveBookingEdit(); })()`);
  await expect.poll(() => sent.length).toBe(2);
  const seated = JSON.parse(sent.find((b) => /Seated Rider/.test(b))!);
  const parked = JSON.parse(sent.find((b) => /Parked Rider/.test(b))!);
  expect(seated.status).toBe('waiting');
  expect(seated.waitlist_num ?? null).toBe(null);
  expect(parked.status).toBe('waitlist');
  expect(parked.waitlist_num).toBe(2);
});

test('the Waitlist tick survives the editor repainting', async ({ page }) => {
  await open(page);
  await page.evaluate(`setStaffTab('queue');renderStaffQueue();showBookingEditModal('e1'); _beAddRider()`);
  await page.locator('#be-nr-wl-0').check();
  await page.evaluate(`_beAddRider()`); // repaints the modal from state
  await expect(page.locator('#be-nr-wl-0')).toBeChecked();
  await expect(page.locator('#be-nr-wl-1')).not.toBeChecked();
});
