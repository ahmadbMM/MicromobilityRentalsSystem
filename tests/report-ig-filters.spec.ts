import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-10: "add me a lot of sorts and filters in the report builder for community and members and
// accounts especially instagram related ones". The account report builder takes the accounts list's filters
// (_amDefs, held as x_<key>) and sorts (_amSorts, x_<value>); Instagram gains finer follower bands, the place
// against the community average, a ranking, when and how the count was taken, the check's outcome and handles
// that look wrong - on the report and on the Accounts / Members Filter panel alike.

const customers = [
  { id: 'm1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', socials: { instagram: 'lina.rides' }, created_at: '2026-06-10T09:00:00Z' },
  { id: 'm2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', socials: { instagram: 'omar_s' }, created_at: '2026-06-11T09:00:00Z' },
  { id: 'm3', name: 'Sara Nabil', email: 'sara.nabil@gmail.com', socials: { instagram: 'sara.n' }, created_at: '2026-06-12T09:00:00Z' },
  { id: 'c4', name: 'Hadi Karam', email: 'hadi.karam@gmail.com', socials: { instagram: 'hadi.k' }, created_at: '2026-06-13T09:00:00Z' },
  { id: 'c5', name: 'Rami Fares', email: 'rami.fares@gmail.com', socials: { instagram: 'my insta page' }, created_at: '2026-06-14T09:00:00Z' },
];
const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#00e585', locked: true }];
const customer_tags = ['m1', 'm2', 'm3'].map((id) => ({ customer_id: id, tag_id: 'tag_saturday', added_at: Date.now() - 864e5, expires_at: null, starts_at: null }));
const recent = new Date(Date.now() - 2 * 864e5).toISOString();
const row = (cid: string, handle: string, followers: number | null, extra: Record<string, unknown> = {}) =>
  ({ customer_id: cid, handle, followers, source: 'auto', counted_at: recent, status: 'ok', tried_at: null, updated_by: null, ...extra });
// members with a count: 1,000 and 4,000 -> the average is 2,500. Hadi (no member) 10,000. Sara's account is private.
const customer_ig_followers = [
  row('m1', 'lina.rides', 1000, { source: 'staff', counted_at: '2026-01-05T10:00:00Z' }),
  row('m2', 'omar_s', 4000),
  row('m3', 'sara.n', null, { status: 'unavailable', counted_at: null }),
  row('c4', 'hadi.k', 10000),
];

async function staff(page: Page) {
  await page.route('**/api/ig-followers', (r) => r.fulfill({ contentType: 'application/json', body: '{"ok":false,"skipped":"not configured"}' }));
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags, customer_tags, staff_options: [], customer_ig_followers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===5');
  await page.evaluate(`localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null`);
  await page.evaluate('_igFetch()');
  await page.waitForFunction('S.igRows&&S.igRows.size===4');
}
// The report's rows with one pick set (and put back), in the report's order.
const report = (page: Page, k: string, v: string, sort = 'name') => page.evaluate(
  `(()=>{const o=_accOpts();o[${JSON.stringify(k)}]=${JSON.stringify(v)};o.sort=${JSON.stringify(sort)};const ids=_accRows().map(r=>r.c.id);o[${JSON.stringify(k)}]='all';o.sort='name';return ids;})()`,
) as Promise<string[]>;

test.describe('@staff:community account report filters and sorts, Instagram first', () => {
  test('report: the Instagram filters', async ({ page }) => {
    await staff(page);
    expect(await report(page, 'x_amIg', 'yes')).toEqual(['c4', 'm1', 'm2', 'm3']); // Rami's handle is not one
    expect(await report(page, 'x_amIgBad', 'yes')).toEqual(['c5']);
    expect(await report(page, 'x_amIgN', '1k')).toEqual(['m1', 'm2']); // 1,000 to 4,999
    expect(await report(page, 'x_amIgN', '10k')).toEqual(['c4']);
    expect(await report(page, 'x_amIgN', 'none')).toEqual(['m3']);
    expect(await report(page, 'x_amIgAvg', 'x2')).toEqual(['c4']);
    expect(await report(page, 'x_amIgAvg', 'half')).toEqual(['m1']);
    expect(await report(page, 'x_amIgAvg', 'above')).toEqual(['c4', 'm2']);
    expect(await report(page, 'x_amIgRank', '10')).toEqual(['c4', 'm1', 'm2']);
    expect(await report(page, 'x_amIgSrc', 'staff')).toEqual(['m1']);
    expect(await report(page, 'x_amIgStatus', 'unavailable')).toEqual(['m3']);
    expect(await report(page, 'x_amIgFresh', '7')).toEqual(['c4', 'm2']);
    expect(await report(page, 'x_amIgFresh', 'old')).toEqual(['m1']);
    expect(await report(page, 'x_amMember', 'yes')).toEqual(['m1', 'm2', 'm3']);
  });

  test('report: the Instagram sorts, accounts without a count last', async ({ page }) => {
    await staff(page);
    expect(await report(page, 'fTag', 'all', 'x_igHi')).toEqual(['c4', 'm2', 'm1', 'c5', 'm3']);
    expect(await report(page, 'fTag', 'all', 'x_igLo')).toEqual(['m1', 'm2', 'c4', 'c5', 'm3']);
    expect(await report(page, 'fTag', 'all', 'x_igHandle')).toEqual(['c4', 'm1', 'm2', 'm3', 'c5']);
    expect((await report(page, 'fTag', 'all', 'x_igOld'))[0]).toBe('m1');
  });

  test('report builder: the new filters and sorts are on the dialog and a pick changes the count', async ({ page }) => {
    await staff(page);
    await page.evaluate('showAccountReportOptions()');
    const dlg = page.locator('#print-opts-modal');
    for (const lbl of ['Instagram followers', 'Against the community average', 'Instagram ranking', 'Followers counted', 'Count taken by', 'Instagram check', 'Instagram handle looks wrong', 'Community member', 'Social accounts']) {
      await expect(dlg.getByLabel(lbl, { exact: true }), lbl).toHaveCount(1);
    }
    await expect(dlg.getByLabel('Sort by', { exact: true }).locator('option[value="x_igHi"]')).toHaveCount(1);
    await dlg.getByLabel('Against the community average', { exact: true }).selectOption('x2');
    await expect(page.locator('#acr-count')).toContainText('1 / 5');
  });

  test('Accounts list: the same Instagram filters behind the Filter button', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
    await page.locator('[aria-controls="fm-am"]').click();
    await page.locator('#fm-am').getByLabel('Against the community average', { exact: true }).selectOption('half');
    expect(await page.locator('#am-cust-rows .am-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-cust')))).toEqual(['m1']);
  });
});
