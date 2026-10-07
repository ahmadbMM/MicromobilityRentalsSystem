import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Third pass: bikes out past two hours get a banner that filters to them, longest first;
// the chips carry a delta against the same night last week; the Community list can show
// the accounts still missing a detail.

const S1 = '2099-01-09', PREV = '2099-01-02';   // both Fridays
const sessions = [
  { id: S1, day: 'Friday', session_date: S1, capacity: 12, status: 'open', created_at: 2 },
  { id: PREV, day: 'Friday', session_date: PREV, capacity: 12, status: 'closed', created_at: 1 },
];
const bikes = [{ id: 'b1', name: 'R-11', type: 'Road', size: 'M', status: 'in-use', colors: [] }];
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const row = (id: string, n: number, x: Record<string, unknown> = {}) => ({
  id, name: 'Rider ' + id, session_id: S1, session_day: 'Friday', session_date: S1, queue_num: n, status: 'waiting', paid: false,
  price: 75, registered_at: S1 + 'T10:00:00Z', type_preference: 'Road', size: 'M', phone: '05500000' + n, ...x });

async function boot(page: import('@playwright/test').Page, q: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, bikes, queue_entries: q, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${S1}';S.sfStatus='all';renderStaffQueue()`);
}

test('bikes out past two hours: a banner, and Show lists them longest first', async ({ page }) => {
  await boot(page, [row('fresh', 1, { status: 'active', checked_in_at: ago(10) }), row('late', 2, { status: 'active', checked_in_at: ago(190) }), row('w', 3)]);
  const banner = page.locator('.overdue-banner');
  await expect(banner).toContainText('1 bike out over 2 h');
  await banner.getByRole('button', { name: 'Show' }).click();
  expect(await page.evaluate('S.sfStatus')).toBe('active');
  const names = await page.evaluate(`[...document.querySelectorAll('#q-results .rider-name')].map(e=>e.textContent.trim())`) as string[];
  expect(names[0]).toContain('Rider late');                    // longest out first
  expect(names).toHaveLength(2);
  await page.evaluate(`setSfStatus('all')`);
  await expect(page.locator('.overdue-banner')).toContainText('1 bike out over 2 h');
});

test('no bike past two hours: no banner', async ({ page }) => {
  await boot(page, [row('fresh', 1, { status: 'active', checked_in_at: ago(30) })]);
  await expect(page.locator('.overdue-banner')).toHaveCount(0);
});

test('the chips say how tonight compares with the same night last week', async ({ page }) => {
  const prev = (id: string, n: number, x: Record<string, unknown> = {}) => row(id, n, { session_id: PREV, session_date: PREV, ...x });
  await boot(page, [
    row('a', 1, { status: 'done', paid: true }), row('b', 2), row('c', 3),
    prev('p1', 1, { status: 'done', paid: true }), prev('p2', 2, { status: 'done', paid: true }), prev('p3', 3, { status: 'done', paid: true }), prev('p4', 4, { status: 'noshow' }), prev('p5', 5, { status: 'cancelled' }),
  ]);
  const deltas = await page.evaluate(`[...document.querySelectorAll('.stat-strip .stat-chip')].map(c=>[c.textContent.replace(/\\s+/g,' ').trim(), (c.querySelector('.stat-delta')||{}).textContent||null])`) as [string, string | null][];
  const riders = deltas.find(([t]) => t.includes('# of Riders'))!, done = deltas.find(([t]) => t.includes('Completed'))!;
  expect(riders[1]).toBe('-1');                                 // 3 tonight vs 4 last week (the cancelled one never counted)
  expect(done[1]).toBe('-2');                                   // 1 vs 3
  await expect(page.locator('.stat-delta').first()).toHaveAttribute('title', 'vs last Friday');
});

test('with no session last week, the chips carry no delta', async ({ page }) => {
  await stubSupabase(page, { sessions: [sessions[0]], bikes, queue_entries: [row('a', 1)] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${S1}';renderStaffQueue()`);
  await expect(page.locator('.stat-delta')).toHaveCount(0);
});

test('Community: the Missing details chip lists the accounts still lacking one, and says which', async ({ page }) => {
  const customers = [
    { id: 'c1', name: 'Amal Full', email: 'amal@example.test', phone: '+966500000001', gender: 'female', birth_date: '1990-01-01', nationality: 'Egypt', created_at: '2026-08-20T10:00:00Z' },
    { id: 'c2', name: 'Bader Gap', email: 'bader@example.test', phone: '+966500000002', gender: 'male', birth_date: null, nationality: null, created_at: '2025-01-05T10:00:00Z' },
  ];
  await stubSupabase(page, { customers, tags: [], customer_tags: [], sessions, queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0');
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  const chip = page.getByRole('button', { name: 'Missing details (1)' });
  await expect(chip).toBeVisible();
  await expect(page.locator('.am-cust')).toHaveCount(2);
  await chip.click();
  await expect(page.locator('.am-cust')).toHaveCount(1);
  await expect(page.locator('.am-cust')).toContainText('Bader Gap');
  await expect(page.locator('.am-missing')).toHaveText('Missing: Birth date, Nationality');
  await page.getByRole('button', { name: 'Missing details (1)' }).click();
  await expect(page.locator('.am-cust')).toHaveCount(2);
});

test('Repeat weekly is on the new-session form', async ({ page }) => {
  await boot(page, [row('a', 1)]);
  await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
  await expect(page.locator('#ns-repeat')).toBeVisible();
});
