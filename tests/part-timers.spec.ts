import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Team > Part-timers (2026-10-07): staff accounts marked as part-timers with a rate per hour, hours logged
// per day and ride, and what we owe over a date range or over rides picked on the calendar or in the list.

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
const people = [{ user_id: DESK, name: 'Sara Desk', rate: 25, active: true }];
const shifts = [
  { id: 1, part_timer_id: DESK, work_date: A, session_id: 'ra', hours: 3, rate: 25, amount: 75, note: '' },
  { id: 2, part_timer_id: DESK, work_date: B, session_id: 'rb', hours: 4, rate: 30, amount: 120, note: '' },
  { id: 3, part_timer_id: DESK, work_date: OLD, session_id: null, hours: 2, rate: 25, amount: 50, note: 'workshop' },
];

async function boot(page: Page, x: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions, part_timers: people, part_timer_shifts: shifts,
    'rpc:staff_part_timer_accounts': accts, 'rpc:staff_operator_list': [], 'rpc:staff_team_list': [], ...x,
  });
  await unlockStaff(page);
  await page.goto('/team/part-timers');
  await waitForSb(page);
  await expect(page.locator('#tab-team .pt-owe')).toBeVisible();
}
const tile = (page: Page, k: string) => page.locator(`#pt-tiles [data-k="${k}"]`);
async function totals(page: Page, hours: string, rides: string, owed: string) {
  await expect(tile(page, 'hours')).toHaveText(hours);
  await expect(tile(page, 'rides')).toHaveText(rides);
  await expect(tile(page, 'owed')).toHaveText(owed);
}
// An insert's answer as PostgREST gives it for .single(): one object, with the id and the computed amount.
async function answerWrites(page: Page, table: string, extra: (sent: Record<string, unknown>) => Record<string, unknown>) {
  const sentRows: Record<string, unknown>[] = [];
  await page.route(`**/rest/v1/${table}*`, async (route) => {
    const m = route.request().method();
    if (m !== 'POST' && m !== 'PATCH') return route.fallback();
    const sent = route.request().postDataJSON() as Record<string, unknown>;
    sentRows.push(sent);
    await route.fulfill({ status: m === 'POST' ? 201 : 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ...sent, ...extra(sent) }) });
  });
  return sentRows;
}

test.describe('@staff:team part-timers', () => {
  test('the address opens the page; a date range adds the hours, rides and money owed', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate('location.pathname')).toBe('/team/part-timers');
    await totals(page, '7 h', '2', 'SAR 195');
    // one row per part-timer and one per entry
    await expect(page.locator('#tab-team .pt-per tbody tr')).toHaveCount(1);
    await expect(page.locator('#tab-team .pt-entries tbody tr')).toHaveCount(2);
    // the rides are named, also when the page is the first one opened
    await expect(page.locator('#tab-team .pt-entries tbody tr[data-shift="1"]')).toContainText('21:00');
    await page.locator('#tab-team .pt-range button', { hasText: 'Last month' }).click();
    await totals(page, '2 h', '0', 'SAR 50');
    await page.locator('#pt-from').fill(OLD);
    await page.locator('#pt-from').dispatchEvent('change');
    await page.locator('#pt-to').fill(B);
    await page.locator('#pt-to').dispatchEvent('change');
    await totals(page, '9 h', '2', 'SAR 245');
  });

  test('rides picked on the calendar and in the list give their totals', async ({ page }) => {
    await boot(page);
    await page.locator('#tab-team .pt-modes button', { hasText: 'Pick rides' }).click();
    await expect(page.locator('#tab-team .pt-owe .empty-state')).toBeVisible(); // nothing picked yet
    await page.locator('#tab-team .pt-pick[data-sid="ra"]').click();
    await expect(page.locator('#tab-team .pt-pick[data-sid="ra"]')).toHaveAttribute('aria-pressed', 'true');
    await totals(page, '3 h', '1', 'SAR 75');
    await page.locator('#tab-team .pt-vt button', { hasText: 'List' }).click();
    await page.locator('#tab-team .pt-ride input[data-sid="rb"]').check();
    await totals(page, '7 h', '2', 'SAR 195');
    await expect(page.locator('#tab-team .pt-picked')).toContainText('Rides picked: 2');
    await page.locator('#tab-team .pt-picked button', { hasText: 'Clear' }).click();
    await expect(page.locator('#tab-team .pt-ride input:checked')).toHaveCount(0);
  });

  test('logging hours on a ride saves the person, the ride, its day, the hours and the rate', async ({ page }) => {
    await boot(page);
    const sent = await answerWrites(page, 'part_timer_shifts', () => ({ id: 9, amount: 62.5 }));
    await page.locator('#pt-who').selectOption(DESK);
    await expect(page.locator('#pt-rate')).toHaveValue('25'); // the person's rate
    await page.locator('#pt-sid').selectOption('ra');
    await expect(page.locator('#pt-date')).toHaveValue(A);
    await page.locator('#pt-hours').fill('2.5');
    await expect(page.locator('#pt-amt')).toHaveText('2.5 h × SAR 25 = SAR 62.50');
    await page.locator('#tab-team .pt-log button', { hasText: 'Save hours' }).click();
    // Sara already has 3 h on that ride: asked first
    await page.locator('#confirm-modal button', { hasText: 'Log as well' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ part_timer_id: DESK, work_date: A, session_id: 'ra', hours: 2.5, rate: 25, note: '' });
    await totals(page, '9.5 h', '2', 'SAR 257.50');
  });

  test('hours out of range are refused before anything is sent', async ({ page }) => {
    await boot(page);
    const sent = await answerWrites(page, 'part_timer_shifts', () => ({ id: 9 }));
    await page.locator('#pt-who').selectOption(DESK);
    await page.locator('#pt-hours').fill('30');
    await page.locator('#tab-team .pt-log button', { hasText: 'Save hours' }).click();
    await expect(page.locator('#tab-team')).toContainText('Hours must be more than 0 and no more than 24.');
    expect(sent).toHaveLength(0);
  });

  test('a staff account becomes a part-timer with its rate; accounts already added are not offered', async ({ page }) => {
    await boot(page);
    const sent = await answerWrites(page, 'part_timers', () => ({ active: true }));
    const pick = page.locator('#pt-add-acct option');
    await expect(pick).toHaveText(['Choose a staff account', 'Owner · owner@example.com', 'lead']);
    await page.locator('#pt-add-acct').selectOption(LEAD);
    await page.locator('#pt-add-rate').fill('40');
    await page.locator('#tab-team .pt-add button').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ user_id: LEAD, name: 'lead', rate: 40, active: true });
    await expect(page.locator(`#tab-team .pt-person[data-pt="${LEAD}"]`)).toContainText('SAR 40');
  });

  test('before the database update the page says so', async ({ page }) => {
    await stubSupabase(page, { sessions, 'rpc:staff_part_timer_accounts': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_part_timer_accounts' } }, 'rpc:staff_operator_list': [], 'rpc:staff_team_list': [] });
    await unlockStaff(page);
    await page.goto('/team/part-timers');
    await waitForSb(page);
    await expect(page.locator('#tab-team .tm-note')).toHaveText('Waiting for the database update.');
  });
});
