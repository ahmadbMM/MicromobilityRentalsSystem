import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-07: "in applications section add all types of filters and sorts possible" and
// "i want a money spent filter and sort everywhere there are accounts and customers". Both
// Applications lists get a Filter button (a sort and every field the cards show); money spent (paid
// bookings, by _bookingRevenue) filters and sorts Accounts, the account report, Applications,
// Flagged and Birthdays.

const customers = [
  { id: 'c1', name: 'Huda Saleh', email: 'huda.saleh@example.test', phone: '+966551239876', gender: 'female', birth_date: '1990-05-05', created_at: '2026-01-05T10:00:00Z' },
  { id: 'c2', name: 'Karim Mansour', email: 'karim.mansour@example.test', phone: '+966552468013', gender: 'male', birth_date: '1994-03-12', created_at: '2026-02-05T10:00:00Z' },
  { id: 'c3', name: 'Zaid Newcomer', email: 'zaid@example.test', phone: '+966553000003', gender: 'male', birth_date: '2000-01-01', created_at: '2026-09-05T10:00:00Z' },
];
const sessions = [
  { id: '2026-08-25', day: 'Tuesday', session_date: '2026-08-25', capacity: 12, status: 'closed', created_at: 2, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' },
];
const bk = (id: string, cust: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, customer_id: cust, session_id: '2026-08-25', session_day: 'Tuesday', session_date: '2026-08-25', queue_num: 1, name: cust,
  type_preference: 'Road', size: 'M', status, paid: true, price: 75, registered_at: '2026-08-01T10:00:00Z', ...extra,
});
const queue_entries = [
  bk('q1', 'c1', 'done'),                         // Huda: 75
  bk('q2', 'c2', 'done', { price: 300 }),         // Karim: 300 + 300 = 600
  bk('q3', 'c2', 'done', { price: 300 }),
  bk('q4', 'c3', 'cancelled', { price: 500 }),    // paid then cancelled: keeps nothing
];
const base = {
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12',
  gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
  customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect', instagram: '', linkedin: '',
};
const apps = [
  { ...base, id: 'a1', status: 'pending', name: 'Karim Mansour', email: 'karim.mansour@example.test', phone: '+966552468013', customer_id: 'c2', instagram: 'karim.rides' },
  { ...base, id: 'a2', status: 'pending', name: 'Huda Saleh', email: 'huda.saleh@example.test', phone: '+966551239876', gender: 'female', height: 160, birth_date: '1990-05-05', nationality: 'Saudi Arabia', lang: 'ar', bike_type: 'Hybrid', submissions: 2, created_at: '2026-09-21T08:00:00Z' },
  { ...base, id: 'a3', status: 'pending', name: 'Ali Noaccount', email: 'ali@example.test', phone: '+966554000004', height: 185, birth_date: '2010-06-01', created_at: '2026-09-23T08:00:00Z' },
];
const lbase = {
  created_at: '2026-09-27T08:00:00Z', updated_at: '2026-09-27T08:00:00Z', submissions: 1, for_whom: 'self', learner_name: null,
  learner_gender: 'female', learner_height: 162, level: 'never', notes: '', lang: 'en', lesson_at: null, lesson_place: null,
  decided_at: null, decided_by: null, customer_id: null, existing_account: null, account_oauth: null, priority: null,
};
const learners = [
  { ...lbase, id: 'l1', status: 'pending', name: 'Nadia Omar', email: 'nadia@example.test', phone: '+966552220001', learner_age: 34, priority: 'low' },
  { ...lbase, id: 'l2', status: 'pending', name: 'Huda Saleh', email: 'huda.saleh@example.test', phone: '+966551239876', priority: 'critical', created_at: '2026-09-26T08:00:00Z',
    learners: [{ who: 'self', age: 36, gender: 'female', level: 'tried' }, { who: 'child', name: 'Sara', age: 7, gender: 'female', level: 'never' }] },
];

async function staff(page: Page, tab: string, sec = 'community') {
  await stubSupabase(page, { sessions, queue_entries, bikes: [], customers, tags: [], customer_tags: [], community_applications: apps, learn_applications: learners, customer_flags: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0&&(S.queue||[]).length>0');
  await page.evaluate(sec === 'customers'
    ? `setStaffTab('customers');S.customersTab=${JSON.stringify(tab)};renderCustomers()`
    : `setStaffTab('community');S.communityTab=${JSON.stringify(tab)};renderCommunity()`);
}
const ids = (page: Page, sel: string, attr: string) => page.locator(sel).evaluateAll((els, a) => els.map((e) => e.getAttribute(a as string)), attr);

test.describe('@staff:community list filters and money spent', () => {
  test('community applications: the Filter button narrows the list and the pill counts, and sorts it', async ({ page }) => {
    await staff(page, 'applications');
    await expect(page.locator('.ca-row')).toHaveCount(3);
    const panel = page.locator('#fm-caap');
    await expect(panel).not.toHaveClass(/open/);
    await page.locator('[aria-controls="fm-caap"]').click();
    await expect(panel).toHaveClass(/open/);

    // a filter: gender. The list and the Pending pill's count both follow; the button counts it.
    await panel.getByLabel('Gender', { exact: true }).selectOption('female');
    await expect(page.locator('.ca-row')).toHaveCount(1);
    await expect(page.locator('.filter-pill[data-ca-filter="pending"]')).toHaveText('Pending (1)');
    await expect(page.locator('[aria-controls="fm-caap"]')).toContainText('(1)');
    await page.locator('#fm-caap .ap-reset').click();
    await expect(page.locator('.ca-row')).toHaveCount(3);

    // more filters: sent twice, height band, age band, an account on file
    for (const [lbl, v, want] of [['Sent more than once', 'yes', ['a2']], ['Height', 'u150', []], ['Height', '180', ['a3']], ['Age', 'u18', ['a3']], ['Account', 'no', ['a3']], ['Instagram', 'yes', ['a1']]] as const) {
      await page.locator('#fm-caap').getByLabel(lbl, { exact: true }).selectOption(v);
      expect(await ids(page, '.ca-row', 'data-app-id')).toEqual(want);
      await page.locator('#fm-caap .ap-reset').click();
    }

    // the community list's Sort is its toolbar's (with the saved views): it gains money spent (the applicant's
    // account: Karim 600, Huda 75, Ali none = last), height and times sent
    const sort = page.locator('.ca-tb select[aria-label="Sort"]');
    await expect(page.locator('#fm-caap').getByLabel('Sort by')).toHaveCount(0);
    await sort.selectOption('spentHi');
    expect(await ids(page, '.ca-row', 'data-app-id')).toEqual(['a1', 'a2', 'a3']);
    await expect(page.locator('.ca-row[data-app-id="a1"] .sp-line')).toContainText('SAR 600');
    await sort.selectOption('spentLo');
    expect(await ids(page, '.ca-row', 'data-app-id')).toEqual(['a2', 'a1', 'a3']);
    await sort.selectOption('tall');
    expect(await ids(page, '.ca-row', 'data-app-id')).toEqual(['a3', 'a1', 'a2']);
    await sort.selectOption('sent');
    expect(await ids(page, '.ca-row', 'data-app-id')).toEqual(['a2', 'a3', 'a1']);
    await sort.selectOption('new');

    // the money filter: 500 to 999 leaves Karim
    await page.locator('#fm-caap').getByLabel('Money spent').selectOption('500');
    expect(await ids(page, '.ca-row', 'data-app-id')).toEqual(['a1']);

    // a saved view keeps the Filter panel's picks with its status, search and sort
    await page.evaluate(`(()=>{const v=_caViews();v.push({name:'Big spenders',f:'pending',q:'',sort:'new',ap:{spent:'500'}});_caViewsPut(v);})()`);
    await page.locator('#fm-caap .ap-reset').click();
    await expect(page.locator('.ca-row')).toHaveCount(3);
    await page.evaluate(`_caViewUse(_caViews().findIndex(x=>x.name==='Big spenders'))`);
    expect(await ids(page, '.ca-row', 'data-app-id')).toEqual(['a1']);
  });

  test('learn to ride: priority, learners and their level filter; priority and learners sort', async ({ page }) => {
    await staff(page, 'learning');
    await expect(page.locator('.la-row')).toHaveCount(2);
    await page.locator('[aria-controls="fm-laap"]').click();
    const panel = page.locator('#fm-laap');
    await panel.getByLabel('Priority', { exact: true }).selectOption('low');
    expect(await ids(page, '.la-row', 'data-learn-id')).toEqual(['l1']);
    await panel.locator('.ap-reset').click();
    await panel.getByLabel('Learners include').selectOption('child');
    expect(await ids(page, '.la-row', 'data-learn-id')).toEqual(['l2']);
    await panel.locator('.ap-reset').click();
    await panel.getByLabel('Number of learners').selectOption('2');
    expect(await ids(page, '.la-row', 'data-learn-id')).toEqual(['l2']);
    await panel.locator('.ap-reset').click();
    await panel.getByLabel('Riding so far').selectOption('tried');
    expect(await ids(page, '.la-row', 'data-learn-id')).toEqual(['l2']);
    await panel.locator('.ap-reset').click();
    await panel.getByLabel('Sort by').selectOption('az');
    expect(await ids(page, '.la-row', 'data-learn-id')).toEqual(['l2', 'l1']);
    await panel.getByLabel('Sort by').selectOption('new');
    expect(await ids(page, '.la-row', 'data-learn-id')).toEqual(['l1', 'l2']);
    await panel.getByLabel('Sort by').selectOption('learners');
    expect(await ids(page, '.la-row', 'data-learn-id')).toEqual(['l2', 'l1']);
  });

  test('accounts: money spent sorts and filters the list, and shows on each row', async ({ page }) => {
    await staff(page, 'accounts', 'customers');
    await page.locator('[aria-controls="fm-am"]').click();
    await page.locator('#fm-am').getByLabel('Sort by').selectOption('spentHi');
    expect(await ids(page, '#am-cust-rows .am-row', 'data-cust')).toEqual(['c2', 'c1', 'c3']);
    await expect(page.locator('.am-row[data-cust="c2"] .sp-line')).toContainText('SAR 600');
    await expect(page.locator('.am-row[data-cust="c3"] .sp-line')).toContainText('SAR 0'); // paid then cancelled
    await page.locator('#fm-am').getByLabel('Money spent').selectOption('none');
    expect(await ids(page, '#am-cust-rows .am-row', 'data-cust')).toEqual(['c3']);
    await page.locator('#fm-am').getByLabel('Money spent').selectOption('u100');
    expect(await ids(page, '#am-cust-rows .am-row', 'data-cust')).toEqual(['c1']);
  });

  test('the account report, Birthdays and Flagged filter and sort by money spent too', async ({ page }) => {
    await staff(page, 'accounts', 'customers');
    const rep = await page.evaluate(`(()=>{const o=_accOpts();const out={};
      o.sort='spent';out.most=_accRows().map(r=>r.c.id);
      o.sort='spentLo';out.least=_accRows().map(r=>r.c.id);
      o.sort='name';o.fSpent='any';out.any=_accRows().map(r=>r.c.id);
      out.opts=_accFilterDefs().find(d=>d[0]==='fSpent')[2].map(x=>x[0]);
      o.fSpent='all';return out;})()`);
    expect(rep).toEqual({ most: ['c2', 'c1', 'c3'], least: ['c3', 'c1', 'c2'], any: ['c1', 'c2'], opts: ['all', 'none', 'any', 'u100', '100', '500', '1000'] });

    const bd = await page.evaluate(`(()=>{S._bdTag='all';const out={};
      S._bdSort='spentHi';out.most=_bdFiltered().map(r=>r.c.id);
      S._bdSort='';S._bdSpent='1000';out.over=_bdFiltered().map(r=>r.c.id);
      S._bdSpent='';return out;})()`);
    expect(bd).toEqual({ most: ['c2', 'c1', 'c3'], over: [] });

    await page.evaluate(`S._flags=[{id:'f1',customer_id:'c1',status:'pending',fields:['email'],flagged_at:'2026-10-01T10:00:00Z'},{id:'f2',customer_id:'c2',status:'pending',fields:['email'],flagged_at:'2026-09-01T10:00:00Z'}];S._flagsAt=Date.now();S._flagsSig=_flagsSig();S.customersTab='flagged';renderCustomers()`);
    expect(await ids(page, '.flg-row', 'data-flag-id')).toEqual(['f1', 'f2']);
    await page.locator('[aria-controls="fm-flg"]').click();
    await page.locator('#fm-flg').getByLabel('Sort by').selectOption('spentHi');
    expect(await ids(page, '.flg-row', 'data-flag-id')).toEqual(['f2', 'f1']);
    await expect(page.locator('.flg-row[data-flag-id="f2"] .sp-line')).toContainText('SAR 600');
    await page.locator('#fm-flg').getByLabel('Money spent').selectOption('u100');
    expect(await ids(page, '.flg-row', 'data-flag-id')).toEqual(['f1']);
  });
});
