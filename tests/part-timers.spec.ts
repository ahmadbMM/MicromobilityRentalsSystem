import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Team > Part-timers (2026-10-07): the front desk's part-timers are staff accounts; each kind of work has its
// rate per hour; hours are logged per day and ride under a kind; what we owe is added over a date range or over
// rides picked on the calendar or in the list, unpaid / paid / all; payments are marked, undone and printed.

const ME = '11111111-1111-1111-1111-111111111111';
const DESK = '22222222-2222-2222-2222-222222222222';
const LEAD = '33333333-3333-3333-3333-333333333333';

// Dates in this KSA month and the last one, so "This month" and "Last month" find them on any day.
const ksaToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const ym = ksaToday().slice(0, 7);
const lastYm = (() => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); })();
const A = `${ym}-05`, B = `${ym}-06`, OLD = `${lastYm}-10`;

const sess = (id: string, date: string, time: string) => ({
  id, day: 'Sunday', session_date: date, capacity: 40, status: 'closed', created_at: 1, location: 'JCC', addons: null,
  bike_slots: JSON.stringify({ _time: time, _total: 40 }),
});
const sessions = [sess('ra', A, '21:00 - 23:00'), sess('rb', B, '06:30 - 08:00')];
const accts = [
  { user_id: ME, email: 'owner@example.com', display_name: 'Owner', role: 'admin' },
  { user_id: DESK, email: 'desk@example.com', display_name: 'Sara Desk', role: 'frontdesk' },
  { user_id: LEAD, email: 'lead@example.com', display_name: null, role: 'leader' },
];
const people = [{ user_id: DESK, name: 'Sara Desk', active: true }];
const kinds = [
  { id: 1, name: 'Welcome and check-in', rate: 25, active: true },
  { id: 2, name: 'Bike handout', rate: 30, active: true },
];
const shifts = [
  { id: 1, part_timer_id: DESK, work_date: A, session_id: 'ra', kind_id: 1, hours: 3, rate: 25, amount: 75, note: '', payout_id: null },
  { id: 2, part_timer_id: DESK, work_date: B, session_id: 'rb', kind_id: 2, hours: 4, rate: 30, amount: 120, note: '', payout_id: 5 },
  { id: 3, part_timer_id: DESK, work_date: OLD, session_id: null, kind_id: 1, hours: 2, rate: 25, amount: 50, note: 'workshop', payout_id: null },
];
const payouts = [{ id: 5, part_timer_id: DESK, paid_on: B, method: 'cash', note: '', hours: 4, amount: 120, entries: 1 }];

async function boot(page: Page, x: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions, part_timers: people, part_timer_kinds: kinds, part_timer_shifts: shifts, part_timer_payouts: payouts,
    'rpc:staff_part_timer_accounts': accts, 'rpc:staff_operator_list': [], 'rpc:staff_team_list': [], ...x,
  });
  await unlockStaff(page);
  await page.goto('/team/part-timers');
  await waitForSb(page);
  await expect(page.locator('#tab-team .pt-owe')).toBeVisible();
}
const tile = (page: Page, k: string) => page.locator(`#pt-tiles [data-k="${k}"]`);
async function totals(page: Page, hours: string, rides: string, owed: string, paid: string) {
  await expect(tile(page, 'hours')).toHaveText(hours);
  await expect(tile(page, 'rides')).toHaveText(rides);
  await expect(tile(page, 'owed')).toHaveText(owed);
  await expect(tile(page, 'paid')).toHaveText(paid);
}
const status = (page: Page, label: string) => page.locator('#tab-team .pt-modes .filter-pill', { hasText: new RegExp(`^${label}$`) }).click();
const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
// An insert's answer as PostgREST gives it for .single(): one object, with the id and the computed amount.
async function answerWrites(page: Page, table: string, extra: (sent: Record<string, unknown>) => Record<string, unknown>) {
  const sentRows: Record<string, unknown>[] = [];
  await page.route(`**/rest/v1/${table}*`, async (route) => {
    const m = route.request().method();
    if (m !== 'POST' && m !== 'PATCH') return route.fallback();
    const sent = route.request().postDataJSON() as Record<string, unknown>;
    sentRows.push(sent);
    await route.fulfill({ status: m === 'POST' ? 201 : 200, headers: cors, body: JSON.stringify({ ...sent, ...extra(sent) }) });
  });
  return sentRows;
}
async function rpcCalls(page: Page, name: string, answer: unknown) {
  const calls: unknown[] = [];
  await page.route(`**/rest/v1/rpc/${name}*`, async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, headers: cors, body: JSON.stringify(answer) });
  });
  return calls;
}

test.describe('@staff:team part-timers', () => {
  test('the address opens the page; a date range adds hours, rides, what we owe and what was paid', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate('location.pathname')).toBe('/team/part-timers');
    await totals(page, '3 h', '1', 'SAR 75', 'SAR 0'); // unpaid, this month
    await status(page, 'All');
    await totals(page, '7 h', '2', 'SAR 75', 'SAR 120');
    await expect(page.locator('#tab-team .pt-entries tbody tr')).toHaveCount(2);
    // the rides are named, also when the page is the first one opened; the paid entry is locked
    await expect(page.locator('#tab-team .pt-entries tr[data-shift="1"]')).toContainText('21:00');
    await expect(page.locator('#tab-team .pt-entries tr[data-shift="2"] button')).toHaveCount(0);
    await expect(page.locator('#tab-team .pt-entries tr[data-shift="2"]')).toContainText('Paid');
    // per kind of work
    await expect(page.locator('#tab-team .pt-perk tbody tr')).toHaveCount(2);
    await expect(page.locator('#tab-team .pt-perk tr[data-kind="2"]')).toContainText('SAR 120');
    await page.locator('#tab-team .pt-range button', { hasText: 'Last month' }).click();
    await totals(page, '2 h', '0', 'SAR 50', 'SAR 0');
    await page.locator('#pt-to').fill(B);
    await page.locator('#pt-to').dispatchEvent('change');
    await totals(page, '9 h', '2', 'SAR 125', 'SAR 120');
  });

  test('rides picked on the calendar and in the list give their totals', async ({ page }) => {
    await boot(page);
    await page.locator('#tab-team .pt-modes button', { hasText: 'Pick rides' }).click();
    await status(page, 'All');
    await expect(page.locator('#tab-team .pt-owe .empty-state')).toBeVisible(); // nothing picked yet
    await page.locator('#tab-team .pt-pick[data-sid="ra"]').click();
    await expect(page.locator('#tab-team .pt-pick[data-sid="ra"]')).toHaveAttribute('aria-pressed', 'true');
    await totals(page, '3 h', '1', 'SAR 75', 'SAR 0');
    await page.locator('#tab-team .pt-vt button', { hasText: 'List' }).click();
    await page.locator('#tab-team .pt-ride input[data-sid="rb"]').check();
    await totals(page, '7 h', '2', 'SAR 75', 'SAR 120');
    await expect(page.locator('#tab-team .pt-picked')).toContainText('Rides picked: 2');
    await page.locator('#tab-team .pt-picked button', { hasText: 'Clear' }).click();
    await expect(page.locator('#tab-team .pt-ride input:checked')).toHaveCount(0);
  });

  test('logging hours takes the kind of work and its rate, the ride and its day', async ({ page }) => {
    await boot(page);
    const sent = await answerWrites(page, 'part_timer_shifts', () => ({ id: 9, amount: 62.5, payout_id: null }));
    await page.locator('#pt-who').selectOption(DESK);
    await page.locator('#pt-kind').selectOption('1');
    await expect(page.locator('#pt-rate')).toHaveValue('25'); // the kind's rate
    await page.locator('#pt-sid').selectOption('ra');
    await expect(page.locator('#pt-date')).toHaveValue(A);
    await page.locator('#pt-hours').fill('2.5');
    await expect(page.locator('#pt-amt')).toHaveText('2.5 h × SAR 25 = SAR 62.50');
    await page.locator('#tab-team .pt-log button', { hasText: 'Save hours' }).click();
    // Sara already has 3 h on that ride: asked first
    await page.locator('#confirm-modal button', { hasText: 'Log as well' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ part_timer_id: DESK, kind_id: 1, work_date: A, session_id: 'ra', hours: 2.5, rate: 25, note: '' });
    await totals(page, '5.5 h', '1', 'SAR 137.50', 'SAR 0');
  });

  test('no kind of work, or hours out of range, are refused before anything is sent', async ({ page }) => {
    await boot(page);
    const sent = await answerWrites(page, 'part_timer_shifts', () => ({ id: 9 }));
    await page.locator('#pt-who').selectOption(DESK);
    await page.locator('#pt-hours').fill('3');
    await page.locator('#tab-team .pt-log button', { hasText: 'Save hours' }).click();
    await expect(page.locator('#tab-team')).toContainText('Choose the kind of work.');
    await page.locator('#pt-kind').selectOption('2');
    await page.locator('#pt-hours').fill('30');
    await page.locator('#tab-team .pt-log button', { hasText: 'Save hours' }).click();
    await expect(page.locator('#tab-team')).toContainText('Hours must be more than 0 and no more than 24.');
    expect(sent).toHaveLength(0);
  });

  test('Mark as paid pays the unpaid entries of the choice; a payment can be undone', async ({ page }) => {
    await boot(page);
    const pay = await rpcCalls(page, 'staff_pt_pay', [{ id: 6, part_timer_id: DESK, paid_on: ksaToday(), method: 'transfer', note: '', hours: 3, amount: 75, entries: 1 }]);
    const unpay = await rpcCalls(page, 'staff_pt_unpay', 1);
    await page.locator('#tab-team .pt-paybtn').click();
    await expect(page.locator('#confirm-modal')).toContainText('3 h · SAR 75 · Entries: 1 · Part-timers: 1');
    await page.locator('#pt-pay-how').selectOption('transfer');
    await page.locator('#confirm-modal button', { hasText: 'Mark as paid' }).click();
    await expect.poll(() => pay.length).toBe(1);
    expect(pay[0]).toEqual({ p_shift_ids: [1], p_paid_on: ksaToday(), p_method: 'transfer', p_note: '' });
    // the earlier payment, undone from Payments
    await page.locator('#tab-team .pt-pays tr[data-payout="5"] button', { hasText: 'Undo payment' }).click();
    await page.locator('#confirm-modal button', { hasText: 'Undo payment' }).click();
    await expect.poll(() => unpay.length).toBe(1);
    expect(unpay[0]).toEqual({ p_payout_id: 5 });
  });

  test('a pay slip prints the payment with its entries', async ({ page }) => {
    await boot(page);
    const html = await page.evaluate(() => new Promise<string>((res) => {
      const w = window as unknown as { open: unknown; _ptSlipOf: (id: number) => void };
      const orig = w.open; let cap = '';
      w.open = () => ({ document: { write: (h: string) => { cap = h; }, close() {}, querySelectorAll: () => [] }, focus() {}, print() {} });
      try { w._ptSlipOf(5); } finally { w.open = orig; }
      res(cap);
    }));
    expect(html).toContain('Pay slip');
    expect(html).toContain('Sara Desk');
    expect(html).toContain('Bike handout');
    expect(html).toContain('SAR 120.00');
    expect(html).toContain('Received by');
  });

  test('a staff account becomes a part-timer; a kind of work is added with its rate', async ({ page }) => {
    await boot(page);
    const sent = await answerWrites(page, 'part_timers', () => ({ active: true }));
    await expect(page.locator('#pt-add-acct option')).toHaveText(['Choose a staff account', 'Owner · owner@example.com', 'lead']);
    await page.locator('#pt-add-acct').selectOption(LEAD);
    await page.locator('#tab-team .pt-people .pt-add button').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ user_id: LEAD, name: 'lead', active: true });
    const sentK = await answerWrites(page, 'part_timer_kinds', () => ({ id: 3 }));
    await page.locator('#pt-nk-name').fill('Payments');
    await page.locator('#pt-nk-rate').fill('28');
    await page.locator('#tab-team .pt-kinds .pt-add button').click();
    await expect.poll(() => sentK.length).toBe(1);
    expect(sentK[0]).toEqual({ name: 'Payments', rate: 28, active: true });
    await expect(page.locator('#tab-team .pt-kind[data-kind="3"]')).toContainText('SAR 28');
  });

  test('before the database update the page says so', async ({ page }) => {
    await stubSupabase(page, { sessions, 'rpc:staff_part_timer_accounts': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_part_timer_accounts' } }, 'rpc:staff_operator_list': [], 'rpc:staff_team_list': [] });
    await unlockStaff(page);
    await page.goto('/team/part-timers');
    await waitForSb(page);
    await expect(page.locator('#tab-team .tm-note')).toHaveText('Waiting for the database update.');
  });
});
