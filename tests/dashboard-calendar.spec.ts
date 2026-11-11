import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Claude Design #22 and #23: a Dashboard for today, and the sessions laid out as a month.

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const [Y, M] = TODAY.split('-').map(Number);
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const NEXT = (() => { const d = new Date(Y, M, 1); return ym(d.getFullYear(), d.getMonth() + 1); })(); // next month, 1-based
const sessions = [
  { id: TODAY, session_date: TODAY, day: 'Friday', status: 'open', capacity: 40, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' },
  { id: `${NEXT}-10`, session_date: `${NEXT}-10`, day: 'Sunday', status: 'closed', capacity: 120, created_at: 2, bike_slots: '{"_time":"21:00 - 23:00","_total":120}' },
];
const row = (id: string, n: number, name: string, x: Record<string, unknown> = {}) => ({
  id, session_id: TODAY, session_day: 'Friday', session_date: TODAY, queue_num: n, name, phone: '0550000001',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: `${TODAY}T10:0${n}:00Z`, ...x,
});
async function staff(page: Page) {
  await stubSupabase(page, {
    sessions,
    queue_entries: [row('e1', 1, 'Amal Saad'), row('e2', 2, 'Badr Omar', { status: 'active', paid: true }), row('e3', 3, 'Dana Faisal', { status: 'done', paid: true })],
    bikes: [{ id: 'b1', name: 'Road 9001', bike_number: 9001, type: 'Road', size: 'M', status: 'available', colors: [] }],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test('the Dashboard shows today: numbers, sessions, what needs attention and quick actions', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('dashboard')`);
  const tab = page.locator('#tab-dashboard');
  await expect(tab.locator('.page-title')).toHaveText('Dashboard');
  // round two (2026-11-08): one main figure with its parts in a key, then three supporting figures
  const kpi = (label: string) => tab.locator('.dash-kpi', { hasText: label }).locator('strong');
  await expect(tab.locator('.dash-hero strong')).toHaveText('3');
  const leg = tab.locator('.dash-hero .dash-leg');
  await expect(leg.locator('span', { hasText: 'Waiting' }).locator('b')).toHaveText('1');
  await expect(leg.locator('span', { hasText: 'On bikes now' }).locator('b')).toHaveText('1');
  await expect(leg.locator('span', { hasText: 'Rides done today' }).locator('b')).toHaveText('1');
  await expect(kpi('Collected today')).toHaveText('SAR 150');
  await expect(kpi('Available bikes')).toHaveText('1');
  await expect(tab.locator('.dash-card', { hasText: 'Quick actions' }).getByRole('button')).toHaveCount(4);
  // today's session opens the roster on it
  await tab.locator('.dash-card', { hasText: "Today's sessions" }).locator('.dash-row').first().click();
  expect(await page.evaluate(`({tab:S.staffTab,sess:S.sfSession})`)).toEqual({ tab: 'queue', sess: TODAY });
});

test('Front desk does not get the Dashboard', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffRole('frontdesk');setStaffTab('dashboard')`);
  expect(await page.evaluate('S.staffTab')).toBe('queue');
});

test('the sessions calendar lays the month out by day, opens a session, and starts one on a free day', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('sessions')`);
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.evaluate(`S._n6rCalMode='month';renderSessions()`); // a phone opens on the week (2026-11-06)
  const cal = page.locator('.sess-cal');
  await expect(cal.locator(`.cal-cell[data-day="${TODAY}"] .cal-sess`)).toContainText('21:00');
  await expect(cal.locator(`.cal-cell[data-day="${TODAY}"] .cal-sess em`)).toHaveText('3/40');
  // next month holds the other session
  await cal.getByRole('button', { name: 'Next month' }).click();
  await expect(page.locator(`.sess-cal .cal-cell[data-day="${NEXT}-10"] .cal-sess`)).toHaveCount(1);
  // a free day starts a new session on that date
  await page.locator(`.sess-cal .cal-cell[data-day="${NEXT}-11"] .cal-add`).click();
  await expect(page.locator('#ns-date')).toHaveValue(`${NEXT}-11`);
  // a session opens in a pop-up over the month (2026-11-06), and from there in the list with its detail
  await page.locator(`.sess-cal .cal-cell[data-day="${NEXT}-10"] .cal-sess`).click();
  await page.locator('#confirm-modal').getByRole('button', { name: 'Open', exact: true }).click();
  expect(await page.evaluate(`({view:S.sessView,sel:S.selSessionDetail})`)).toEqual({ view: 'list', sel: `${NEXT}-10` });
});
