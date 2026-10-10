import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-10: "in members and accounts sections add a lot of filter types and sorts add as much as
// you can". Customers > Accounts and Community > Members share one list (_amFiltered); its Filter button now
// holds every filter the account answers (_amDefs) and a long Sort list (_amSorts), with Reset.

const customers = [
  { id: 'c1', name: 'Huda Saleh', email: 'huda.saleh@example.test', phone: '+966551239876', gender: 'female', birth_date: '1990-05-05', height: 160, nationality: 'Saudi Arabia', city: 'Jeddah', country: 'Saudi Arabia', type_preference: 'Hybrid', socials: { instagram: 'huda.rides' }, created_at: '2026-01-05T10:00:00Z' },
  { id: 'c2', name: 'Karim Mansour', email: 'karim.mansour@example.test', phone: '+201005553412', gender: 'male', birth_date: '1980-03-12', height: 186, nationality: 'Egypt', city: 'Riyadh', country: 'Saudi Arabia', type_preference: 'Road', socials: { x: 'karim' }, created_at: '2026-02-05T10:00:00Z' },
  { id: 'c3', name: 'Zaid Newcomer', email: '', phone: '+966551239876', gender: null, birth_date: null, height: 172, nationality: null, city: null, country: null, type_preference: null, socials: null, created_at: '2026-09-05T10:00:00Z' },
];
const sessions = [
  { id: '2026-08-25', day: 'Tuesday', session_date: '2026-08-25', capacity: 12, status: 'closed', created_at: 2, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' },
];
const bk = (id: string, cust: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, customer_id: cust, session_id: '2026-08-25', session_day: 'Tuesday', session_date: '2026-08-25', queue_num: 1, name: cust,
  type_preference: 'Road', size: 'M', status, paid: true, price: 75, registered_at: '2026-08-01T10:00:00Z', ...extra,
});
const queue_entries = [
  bk('q1', 'c1', 'done'),
  bk('q2', 'c2', 'done'),
  bk('q3', 'c2', 'done'),
  bk('q4', 'c2', 'noshow', { paid: false }),
];
const tags = [{ id: 'tag_saturday', name: 'Community', color: '#0c7a3d', locked: true, auto_grant: false }];
const customer_tags = [{ customer_id: 'c1', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 }];

async function open(page: Page, sec: 'customers' | 'community') {
  await stubSupabase(page, { sessions, queue_entries, bikes: [], customers, tags, customer_tags, customer_flags: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0&&(S.queue||[]).length>0');
  await page.evaluate(sec === 'customers'
    ? `setStaffTab('customers');S.customersTab='accounts';renderCustomers()`
    : `setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
  await page.locator('[aria-controls="fm-am"]').click();
}
const rows = (page: Page) => page.locator('#am-cust-rows .am-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-cust')));

test.describe('@staff:accounts and members filters and sorts', () => {
  test('accounts: every new filter narrows the list, the button counts them, Reset clears them', async ({ page }) => {
    await open(page, 'customers');
    const panel = page.locator('#fm-am');
    expect(await rows(page)).toEqual(['c3', 'c2', 'c1']);
    for (const [lbl, v, want] of [
      ['Rides', '0', ['c3']],
      ['Rides', '2', ['c2']],
      ['Rides', 'nobook', ['c3']],
      ['No-Show', '1', ['c2']],
      ['Height', '180', ['c2']],
      ['Age', '45', ['c2']],
      ['Age', 'unset', ['c3']],
      ['City of residence', 'Jeddah', ['c1']],
      ['Bike type preference', 'Road', ['c2']],
      ['Community member', 'yes', ['c1']],
      ['Community member', 'no', ['c3', 'c2']],
      ['Social accounts', 'x', ['c2']],
      ['Social accounts', 'none', ['c3']],
      ['Instagram', 'yes', ['c1']],
      ['Email', 'no', ['c3']],
      ['Phone', 'intl', ['c2']],
      ['Phone', 'shared', ['c3', 'c1']],
      ['Gender', 'unset', ['c3']],
      ['Nationality', 'unset', ['c3']],
    ] as const) {
      await panel.getByLabel(lbl, { exact: true }).selectOption(v);
      expect(await rows(page), `${lbl} = ${v}`).toEqual(want);
      await panel.getByLabel(lbl, { exact: true }).selectOption('');
    }
    // two at once: the button counts both, Reset takes both off
    await panel.getByLabel('Gender', { exact: true }).selectOption('male');
    await panel.getByLabel('Upcoming booking', { exact: true }).selectOption('no');
    await expect(page.locator('[aria-controls="fm-am"]')).toContainText('(2)');
    expect(await rows(page)).toEqual(['c2']);
    await panel.locator('.am-reset').click();
    expect(await rows(page)).toEqual(['c3', 'c2', 'c1']);
  });

  test('accounts: the sorts order the list and the row shows what it is sorted on', async ({ page }) => {
    await open(page, 'customers');
    const sort = page.locator('#fm-am').getByLabel('Sort by');
    for (const [v, want] of [
      ['old', ['c1', 'c2', 'c3']],
      ['za', ['c3', 'c2', 'c1']],
      ['rides', ['c2', 'c1', 'c3']],
      ['ridesLo', ['c3', 'c1', 'c2']],
      ['noshow', ['c2', 'c3', 'c1']], // nobody else has one: the rest newest first
      ['eld', ['c2', 'c1', 'c3']], // no birth date goes last
      ['tall', ['c2', 'c3', 'c1']],
      ['short', ['c1', 'c3', 'c2']],
      ['city', ['c1', 'c2', 'c3']],
    ] as const) {
      await sort.selectOption(v);
      expect(await rows(page), `sort ${v}`).toEqual(want);
    }
    await sort.selectOption('rides');
    await expect(page.locator('.am-row[data-cust="c2"] .am-sortline')).toHaveText('Rides completed: 2');
  });

  test('members: the same panel, scoped to the members, without the Community member filter', async ({ page }) => {
    await open(page, 'community');
    expect(await rows(page)).toEqual(['c1']);
    await expect(page.locator('#fm-am').getByLabel('Community member', { exact: true })).toHaveCount(0);
    await page.locator('#fm-am').getByLabel('Rides', { exact: true }).selectOption('1');
    expect(await rows(page)).toEqual(['c1']);
    await page.locator('#fm-am').getByLabel('Rides', { exact: true }).selectOption('0');
    expect(await rows(page)).toEqual([]);
  });
});
