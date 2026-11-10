import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// A booking's locker in its Add-ons dialog, with Unassign and Cancel locker (the user, 2026-11-10: "i want the locker to be
// shown on add ons in each booking if it was added ... allow the staff to undo or to unassign a locker if it was mistakenly
// assigned or wanted to be cancelled"). The fee line is the database's ({id:'locker'}, zy_locker_line); Unassign is
// staff_locker_edit with an empty number, Cancel locker is staff_locker_cancel. All traffic stubbed; invented data.

const ksaDay = (n = 0) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const TODAY = ksaDay(0);
const sessions = [{ id: 's1', day: 'Tuesday', session_date: TODAY, capacity: 40, status: 'open', created_at: 1, lockers: true, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' }];
const customers = [
  { id: 'c1', name: 'Rana Rider', email: 'rana@example.test', phone: '+966500000021', height: 170, created_at: '2026-01-01T00:00:00Z' },
  { id: 'c2', name: 'Omar Other', email: 'omar@example.test', phone: '+966500000022', height: 180, created_at: '2026-01-02T00:00:00Z' },
];
const LINE = [{ id: 'locker', qty: 1, p: 10 }];
const bk = (id: string, n: number, x: Record<string, unknown> = {}) => ({
  id, session_id: 's1', session_day: 'Tuesday', session_date: TODAY, queue_num: n, name: 'Rana Rider', customer_id: 'c1', phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 50, registered_at: '2026-11-09T10:00:00Z', addons: LINE, ...x,
});
const queue = [bk('q1', 1), bk('q2', 2, { name: 'Omar Other', customer_id: 'c2' })];
const lockers = ['1', '2'].map((c) => ({ id: 'L' + c, code: c, status: 'available', note: '', created_at: '2026-11-09T09:00:00Z' }));
const rent = (id: string, x: Record<string, unknown>) => ({
  id, day: TODAY, period: 'late', booking_id: null, session_id: 's1', customer_id: null, name: '', locker_id: null, price: 10, on_bill: true,
  status: 'reserved', created_at: '2026-11-09T10:00:00Z', created_by: 'staff', pay: null, receipt_id: null, house: false, refunded: 0, ...x,
});
const rentals = [
  rent('R1', { booking_id: 'q1', customer_id: 'c1', name: 'Rana Rider', locker_id: 'L1', status: 'in_use' }),
  rent('R2', { booking_id: 'q2', customer_id: 'c2', name: 'Omar Other', period: 'early' }),
];

function calls(page: Page) {
  const seen: { name: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (!m || r.method() !== 'POST') return;
    let body = {}; try { body = r.postDataJSON() || {}; } catch { /* none */ }
    seen.push({ name: m[1], body });
  });
  return seen;
}
const sent = (seen: { name: string; body: Record<string, unknown> }[], name: string) => seen.find((c) => c.name === name)?.body;
async function staff(page: Page, fx: Fixtures = {}) {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions, customers, tags: [], customer_tags: [], queue_entries: queue, bikes: [], staff_options: [],
    'rpc:staff_operator_list': ops, lockers, locker_rentals: rentals, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded&&(S.customers||[]).length>0');
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='admin';`);
  await page.evaluate(`setStaffTab('queue');renderStaffQueue()`);
}
const addons = (page: Page) => page.getByRole('dialog', { name: 'Edit add-ons' });

test.describe('@staff:lockers a booking\'s locker in its add-ons', () => {
  test('the Add-ons button that counts the locker opens it: number, time, key state; Unassign takes the number off', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_edit': { ok: true, id: 'R1', day: TODAY, period: 'late', status: 'reserved', code: null, price: 10, due: 0, back: 0, booking_id: 'q1', addons: LINE } });
    if (test.info().project.name === 'mobile') await page.evaluate(`showAddonPicker('q1')`); // a phone's card lists the line and adds from its own button
    else {
      const btn = page.locator('#tab-queue tr[data-id="q1"] .rq-adbtn');
      await expect(btn).toHaveText('Add-ons 1');
      await btn.click();
    }
    const d = addons(page);
    const card = d.locator('.lk-ad');
    await expect(card).toContainText('Locker 1');
    await expect(card).toContainText('9 PM - 11 PM');
    await expect(card).toContainText('Key given');
    await expect(d).not.toContainText('No add-ons available'); // the session sells no stock items, but the booking has its locker
    await card.getByRole('button', { name: 'Unassign' }).click();
    const q = page.getByRole('dialog', { name: 'Unassign locker 1?' });
    await expect(q).toContainText('keeps its locker time and fee');
    await q.getByRole('button', { name: 'Unassign' }).click();
    await expect.poll(() => sent(seen, 'staff_locker_edit')).toBeTruthy();
    expect(sent(seen, 'staff_locker_edit')).toMatchObject({ p_rental: 'R1', p_day: null, p_period: null, p_code: '', p_name: null, p_customer: null });
    await expect(page.locator('.toast').filter({ hasText: 'Locker 1 unassigned' })).toHaveCount(1); // a quiet toast: said, not shown
  });

  test('a locker with no number yet says so and offers Cancel locker only; Cancel takes its fee off the booking', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_cancel': { ok: true, booking_id: 'q2', addons: [] } });
    await page.evaluate(`showAddonPicker('q2')`);
    const card = addons(page).locator('.lk-ad');
    await expect(card).toContainText('No locker number yet');
    await expect(card).toContainText('6 PM - 8 PM');
    await expect(card.getByRole('button', { name: 'Unassign' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Cancel locker' }).click();
    const q = page.getByRole('dialog', { name: 'Cancel this locker?' });
    await expect(q).toContainText('Its fee comes off the booking.');
    await q.getByRole('button', { name: 'Cancel locker' }).click();
    await expect.poll(() => sent(seen, 'staff_locker_cancel')).toBeTruthy();
    expect(sent(seen, 'staff_locker_cancel')).toEqual({ p_rental: 'R2', p_reason: 'staff', p_undo: false });
    await expect.poll(() => page.evaluate(`_lkFeeOf(_qGet('q2'))`)).toBe(0); // the line the server dropped, drawn without a reload
  });

  test('Assign a locker offers Unassign beside Hand back once the booking has a number', async ({ page }) => {
    await staff(page);
    await page.evaluate(`_lkAssignOpen('q1')`);
    const dlg = page.getByRole('dialog', { name: /Assign a locker · #1 Rana Rider/ });
    await expect(dlg.getByRole('button', { name: 'Hand back' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Unassign' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Cancel locker' })).toBeVisible();
  });
});
