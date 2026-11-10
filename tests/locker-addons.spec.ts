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

  // Edited from the Add-ons dialog as well (the user, 2026-11-10: "allow the staff to edit add ons of a customer such as lockers").
  test('the card hands the key back, and Edit opens the reservation over it and brings the Add-ons back on close', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_return': { ok: true } });
    await page.evaluate(`showAddonPicker('q1')`);
    const card = addons(page).locator('.lk-ad');
    await card.getByRole('button', { name: 'Hand back' }).click();
    await expect.poll(() => sent(seen, 'staff_locker_return')).toEqual({ p_rental: 'R1' });
    await card.getByRole('button', { name: 'Edit' }).click();
    const ed = page.getByRole('dialog', { name: 'Locker reservation' });
    await expect(ed).toBeVisible();
    await expect(addons(page)).toHaveCount(0); // it steps aside: the locker dialogs sit under its z-index
    await page.locator('#lk-ed .chrome-dact').getByRole('button', { name: 'Close' }).click();
    await expect(ed).toHaveCount(0);
    await expect(addons(page).locator('.lk-ad')).toContainText('Locker 1');
  });

  test('a number picked but its key not given: Give key on the card gives that locker', async ({ page }) => {
    const seen = calls(page);
    const keyDue = [rentals[0], { ...rentals[1], locker_id: 'L2' }];
    await staff(page, { locker_rentals: keyDue, 'rpc:staff_locker_assign': { ok: true, code: '2' } });
    await page.evaluate(`showAddonPicker('q2')`);
    const card = addons(page).locator('.lk-ad');
    await expect(card).toContainText('Key not given');
    await card.getByRole('button', { name: 'Give key' }).click();
    await expect.poll(() => sent(seen, 'staff_locker_assign')).toEqual({ p_rental: 'R2', p_code: '2' });
  });

  test('a booking with no locker on a locker night: Add a locker opens Assign a locker, and closing it comes back', async ({ page }) => {
    await staff(page, { queue_entries: [...queue, bk('q3', 3, { name: 'Sara Spare', customer_id: null, addons: [] })] });
    await page.evaluate(`showAddonPicker('q3')`);
    const card = addons(page).locator('.lk-ad');
    await expect(card).toHaveClass(/lk-ad-none/);
    await expect(addons(page)).not.toContainText('No add-ons available'); // a locker is on offer
    await card.getByRole('button', { name: 'Add a locker' }).click();
    const as = page.getByRole('dialog', { name: /Assign a locker #3 Sara Spare/ });
    await expect(as).toBeVisible();
    await expect(addons(page)).toHaveCount(0);
    await as.getByRole('button', { name: 'Close' }).first().click();
    await expect(as).toHaveCount(0);
    await expect(addons(page).locator('.lk-ad-none')).toBeVisible();
  });

  test('an add-on the session no longer offers is listed and comes off; a finished ride shows its add-ons and changes none', async ({ page }) => {
    const inventory = [{ id: 'w1', name: 'Spec Water', category: 'Drinks', qty: 9, price: 5, low_threshold: 0, updated_at: '2026-11-01T00:00:00Z' }];
    const water = [...LINE, { id: 'w1', qty: 1, p: 5 }];
    const rows = [bk('q1', 1, { addons: water }), bk('q2', 2, { name: 'Omar Other', customer_id: 'c2', status: 'done', addons: water })];
    await staff(page, { inventory, queue_entries: rows });
    await page.evaluate(`showAddonPicker('q1')`);
    const d = addons(page);
    const w = d.locator('[class^="dk-ap-card"]').filter({ hasText: 'Spec Water' });
    await expect(w.locator('.dk-ap-qty')).toHaveText('1');
    await w.getByRole('button', { name: /Spec Water/ }).first().click(); // the − (its label names the product)
    await expect.poll(() => page.evaluate(`entryAddons(_qGet('q1')).some(x=>x.id==='w1')`)).toBe(false);
    await expect.poll(() => page.evaluate(`_lkFeeOf(_qGet('q1'))`)).toBe(10); // the locker line stays
    await page.evaluate(`closeAddonPicker()`);
    if (test.info().project.name !== 'mobile') { // a done ride with a locker opens its Add-ons (the roster lists done rides under their filter)
      await page.evaluate(`S.sfStatus='done';renderStaffQueue()`);
      await expect(page.locator('#tab-queue tr[data-id="q2"] button.rq-adbtn')).toHaveText('Add-ons 2');
    }
    await page.evaluate(`showAddonPicker('q2')`);
    const w2 = addons(page).locator('[class^="dk-ap-card"]').filter({ hasText: 'Spec Water' });
    await expect(w2.locator('.dk-ap-qty')).toHaveText('1');
    for (const b of await w2.locator('.dk-ap-step button').all()) await expect(b).toBeDisabled();
    await expect(addons(page).locator('.lk-ad').getByRole('button', { name: 'Edit' })).toBeVisible();
  });

  test('Assign a locker offers Unassign beside Hand back once the booking has a number', async ({ page }) => {
    await staff(page);
    await page.evaluate(`_lkAssignOpen('q1')`);
    const dlg = page.getByRole('dialog', { name: /Assign a locker #1 Rana Rider/ });
    await expect(dlg.getByRole('button', { name: 'Hand back' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Unassign' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Cancel locker' })).toBeVisible();
  });
});
