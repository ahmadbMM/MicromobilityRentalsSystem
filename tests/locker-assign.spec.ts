import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Assign a locker, redrawn (the user, 2026-11-10: "the lockers assignment modal looks very basic and not going with the
// website's theme fix it and search for bugs in it and make sure it's as smooth as it can go"): the time as cards (the
// booking's own ride time picked to start with), the cabinet's doors (taken or out of service off), one action that says
// what it does, closed once done; a typed number checked before anything is written; a tag tapped while it is open; a
// locker handed back can be followed by another; a desk fee already rung up is not put in the cart again. The rules are
// the database's (staff_locker_*); this is what the dialog asks for and draws. All traffic stubbed; invented data.

const ksaDay = (n = 0) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const TODAY = ksaDay(0);
const sessions = [
  { id: 's1', day: 'Tuesday', session_date: TODAY, capacity: 40, status: 'open', created_at: 1, lockers: true, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' },
];
const customers = [
  { id: 'c1', name: 'Rana Rider', email: 'rana@example.test', phone: '+966500000021', height: 170, created_at: '2026-01-01T00:00:00Z' },
  { id: 'c2', name: 'Omar Other', email: 'omar@example.test', phone: '+966500000022', height: 180, created_at: '2026-01-02T00:00:00Z' },
  { id: 'c3', name: 'Sara Saeed', email: 'sara@example.test', phone: '+966500000023', height: 165, created_at: '2026-01-03T00:00:00Z' },
];
const bk = (id: string, n: number, x: Record<string, unknown> = {}) => ({
  id, session_id: 's1', session_day: 'Tuesday', session_date: TODAY, queue_num: n, name: 'Rana Rider', customer_id: 'c1', phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 50, registered_at: '2026-11-09T10:00:00Z', ...x,
});
const lockers = ['1', '2', '3', '4'].map((c) => ({ id: 'L' + c, code: c, status: c === '4' ? 'out' : 'available', note: '', created_at: '2026-11-09T09:00:00Z' }));
const rent = (id: string, x: Record<string, unknown>) => ({
  id, day: TODAY, period: 'late', booking_id: null, session_id: 's1', customer_id: null, name: '', locker_id: null, price: 10, on_bill: true,
  status: 'reserved', created_at: '2026-11-09T10:00:00Z', created_by: 'rider', pay: null, receipt_id: null, house: false, refunded: 0, till_lines: [], ...x,
});
const queue = [bk('q1', 1, { status: 'active' }), bk('q2', 2, { name: 'Omar Other', customer_id: 'c2' }), bk('q3', 3, { name: 'Sara Saeed', customer_id: 'c3' })];
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
const n = (seen: { name: string }[], name: string) => seen.filter((c) => c.name === name).length;
const sent = (seen: { name: string; body: Record<string, unknown> }[], name: string) => seen.find((c) => c.name === name)?.body;
async function staff(page: Page, fx: Fixtures = {}) {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions, customers, tags: [], customer_tags: [], queue_entries: queue, bikes: [], staff_options: [],
    'rpc:staff_operator_list': ops, lockers, locker_rentals: rentals, ...fx });
  await unlockStaff(page);
  // The evening of TODAY's ride, before any locker time ends: from 23:00 in Riyadh a key given for the late time read
  // Overdue, not Key given, and main went red every night until midnight (2026-11-12, 23:05).
  await page.clock.setFixedTime(new Date(`${TODAY}T18:00:00+03:00`));
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded&&(S.customers||[]).length>0');
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='admin';setStaffTab('queue')`);
}
async function open(page: Page, id: string, who: RegExp) {
  await page.evaluate(`_lkAssignOpen('${id}')`);
  const dlg = page.getByRole('dialog', { name: who });
  await expect(dlg.locator('.lk-as-doors')).toBeVisible();
  return dlg;
}

test.describe('@staff:lockers Assign a locker', () => {
  test('the ride\'s own time is picked; doors taken for it or out of service are off; a door tapped is assigned and given in one go, then it closes', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_reserve': { ok: true, id: 'R9', booking_id: 'q3', addons: '[{"id":"locker","qty":1,"p":10}]' }, 'rpc:staff_locker_assign': { ok: true, code: '2' } });
    const dlg = await open(page, 'q3', /Assign a locker #3 Sara Saeed/);
    await expect(dlg.locator('.lk-as-sub')).toContainText('Today');
    await expect(dlg.getByRole('button', { name: /9 PM - 11 PM/ })).toHaveAttribute('aria-pressed', 'true'); // a 9 PM ride: 9-11 PM to start with
    await expect(dlg.getByRole('button', { name: 'Locker 1 · In use' })).toBeDisabled(); // Rana has it 9-11 PM
    await expect(dlg.getByRole('button', { name: 'Locker 4 · Out of service' })).toBeDisabled();
    await expect(dlg.locator('#lk-as-go')).toHaveText('Assign');
    await dlg.getByRole('button', { name: 'Locker 2', exact: true }).click();
    await expect(dlg.locator('#lk-as-go')).toHaveText('Assign locker 2');
    await dlg.locator('#lk-as-go').click();
    await expect(dlg).toBeHidden();
    expect(sent(seen, 'staff_locker_reserve')).toEqual({ p_booking_id: 'q3', p_period: 'late', p_on_bill: true });
    expect(sent(seen, 'staff_locker_assign')).toEqual({ p_rental: 'R9', p_code: '2' });
    await expect(page.locator('.toast', { hasText: 'Locker 2 given' })).toHaveCount(1); // one toast for the two steps (a quiet one: heard, the desk's success toasts)
    await expect(page.locator('.toast', { hasText: 'Locker added' })).toHaveCount(0);
  });

  test('6-8 PM picked instead: door 1 is free then; a typed number taken for the time is said and nothing is written', async ({ page }) => {
    const seen = calls(page);
    await staff(page);
    const dlg = await open(page, 'q3', /Assign a locker #3 Sara Saeed/);
    await dlg.getByRole('button', { name: /6 PM - 8 PM/ }).click();
    await expect(dlg.getByRole('button', { name: 'Locker 1', exact: true })).toBeEnabled(); // Rana's is 9-11 PM: free 6-8 PM (the owner: per time)
    await dlg.getByRole('button', { name: /6 PM - 11 PM/ }).click();
    await dlg.locator('#lk-as-in').fill('1');
    await expect(dlg.locator('#lk-as-msg')).toHaveText('That locker is taken (Rana Rider)');
    await expect(dlg.locator('#lk-as-go')).toBeDisabled();
    await dlg.locator('#lk-as-in').press('Enter');
    await dlg.locator('#lk-as-in').fill('9');
    await expect(dlg.locator('#lk-as-msg')).toHaveText('No locker 9');
    expect(n(seen, 'staff_locker_reserve')).toBe(0);
  });

  test('a locker in use: Hand back is the action, Enter in an empty box never does it; a door picked turns it into Move', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_assign': { ok: true, code: '3' } });
    const dlg = await open(page, 'q1', /Assign a locker #1 Rana Rider/);
    await expect(dlg.locator('.lk-as-cur')).toContainText('Locker 1');
    await expect(dlg.locator('.lk-as-cur')).toContainText('In use');
    await expect(dlg.getByRole('button', { name: 'Locker 1 · Current' })).toBeVisible();
    await expect(dlg.locator('#lk-as-go')).toHaveText('Hand back');
    await dlg.locator('#lk-as-in').press('Enter');
    await page.waitForTimeout(300);
    expect(n(seen, 'staff_locker_return')).toBe(0);
    await dlg.getByRole('button', { name: 'Locker 3', exact: true }).click();
    await expect(dlg.locator('#lk-as-go')).toHaveText('Move to locker 3');
    await expect(dlg.getByRole('button', { name: 'Hand back' })).toBeVisible(); // still there, beside Edit and Cancel
    await dlg.locator('#lk-as-go').click();
    await expect(dlg).toBeHidden();
    expect(sent(seen, 'staff_locker_assign')).toEqual({ p_rental: 'R1', p_code: '3' });
  });

  test('a reservation holding a door, key not given: Move changes its number only (stays reserved, nothing in the till)', async ({ page }) => {
    const seen = calls(page);
    const held = [rentals[0], { ...rentals[1], locker_id: 'L2', on_bill: false, pay: 'desk' }];
    await staff(page, { locker_rentals: held, 'rpc:staff_locker_edit': { ok: true, code: '3' }, 'rpc:staff_locker_assign': { ok: true, code: '3' } });
    const dlg = await open(page, 'q2', /Assign a locker #2 Omar Other/);
    await expect(dlg.locator('#lk-as-go')).toHaveText('Give key');
    await dlg.getByRole('button', { name: 'Locker 3', exact: true }).click();
    await expect(dlg.locator('#lk-as-go')).toHaveText('Move to locker 3');
    await dlg.locator('#lk-as-go').click();
    await expect.poll(() => n(seen, 'staff_locker_edit')).toBe(1);
    expect(sent(seen, 'staff_locker_edit')).toMatchObject({ p_rental: 'R2', p_code: '3', p_day: null, p_period: null });
    expect(n(seen, 'staff_locker_assign')).toBe(0);
    await expect(dlg).toBeVisible(); // Give key stays its own step
    expect(await page.evaluate(`(S._ctCart||[]).length`)).toBe(0);
  });

  test('a locker\'s tag tapped while the dialog is open gives that locker to the booking waiting for one', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_assign': { ok: true, code: '3' } });
    const dlg = await open(page, 'q2', /Assign a locker #2 Omar Other/);
    await expect(dlg.locator('.lk-as-cur')).toContainText('Waiting for a number');
    await expect(dlg.locator('#lk-as-go')).toBeDisabled();
    await page.evaluate(`_lockerArrived('3')`);
    await expect.poll(() => n(seen, 'staff_locker_assign')).toBe(1);
    expect(sent(seen, 'staff_locker_assign')).toEqual({ p_rental: 'R2', p_code: '3' });
    await expect(dlg).toBeHidden();
  });

  test('a locker handed back: its card stays, and another can be assigned', async ({ page }) => {
    const seen = calls(page);
    const back = [rentals[0], { ...rentals[1], locker_id: 'L2', status: 'returned' }];
    await staff(page, { locker_rentals: back, 'rpc:staff_locker_reserve': { ok: true, id: 'R9', booking_id: 'q2', addons: '[]' } });
    const dlg = await open(page, 'q2', /Assign a locker #2 Omar Other/);
    await expect(dlg.locator('.lk-as-cur')).toContainText('Handed back');
    await expect(dlg.locator('.lk-as-p')).toHaveCount(3);
    await dlg.getByRole('button', { name: /6 PM - 11 PM/ }).click();
    await dlg.locator('#lk-as-go').click();
    await expect(dlg).toBeHidden();
    expect(sent(seen, 'staff_locker_reserve')).toEqual({ p_booking_id: 'q2', p_period: 'both', p_on_bill: true });
  });

  test('a desk fee already rung up at the till is not put in the Sales cart again when the key is given', async ({ page }) => {
    const rung = rent('R8', { customer_id: 'c3', name: 'Sara Saeed', locker_id: 'L3', period: 'early', on_bill: false, created_by: 'page', pay: 'desk', till_lines: ['rc1:0'] });
    const due = rent('R7', { customer_id: 'c2', name: 'Omar Other', locker_id: 'L2', period: 'early', on_bill: false, created_by: 'page', pay: 'desk' });
    await staff(page, { locker_rentals: [rentals[0], rung, due], 'rpc:staff_locker_assign': { ok: true, code: '3' } });
    await page.evaluate(`_lkLoad(true,todayStr())`);
    await page.waitForFunction(`_lkRows(todayStr()).length===3`);
    expect(await page.evaluate(`_lkGive('R8','3',todayStr())`)).toBe(true);
    expect(await page.evaluate(`(S._ctCart||[]).length`)).toBe(0);
    expect(await page.evaluate(`_lkGive('R7','2',todayStr())`)).toBe(true); // not rung up yet: into the cart, once
    expect(await page.evaluate(`(S._ctCart||[]).filter(l=>l.lk==='R7').length`)).toBe(1);
    expect(await page.evaluate(`_lkTillDue(_lkRows(todayStr()).find(r=>r.id==='R7'))`)).toBe(false); // in the cart now: not twice
    await page.evaluate(`S._ctHeld=[{custId:'c2',cust:'Omar Other',lines:S._ctCart.filter(l=>l.lk==='R7')}];S._ctCart=[]`);
    expect(await page.evaluate(`_lkTillDue(_lkRows(todayStr()).find(r=>r.id==='R7'))`)).toBe(false); // waiting as a held sale: not twice either
  });
});
