import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-11: "add an option in report builder for community and customers to show the last time
// they logged on/opened the website" + "and an option to sort them with it". staff_last_seen (20261011130000)
// gives each account's last opening (customer_seen, stamped by the app and the website) and last sign-in
// (customer_activity); the report gains two columns, two filters and four sorts, as do Accounts and Members.

const ago = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
const customers = [
  { id: 'a1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', created_at: '2026-06-10T09:00:00Z' },
  { id: 'a2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', created_at: '2026-06-11T09:00:00Z' },
  { id: 'a3', name: 'Sara Nabil', email: 'sara.nabil@gmail.com', created_at: '2026-06-12T09:00:00Z' },
];
const seen = [
  { id: 'a1', seen_at: ago(2), via: 'app', signin_at: ago(120) },
  { id: 'a2', seen_at: ago(200), via: 'web', signin_at: null },
];

async function staff(page: Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [], 'rpc:staff_last_seen': seen });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===3');
  await page.evaluate(`localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null;_lsEnsure()`);
  await page.waitForFunction('!!S._lsMap');
}
const report = (page: Page, k: string, v: string, sort = 'name') => page.evaluate(
  `(()=>{const o=_accOpts();o[${JSON.stringify(k)}]=${JSON.stringify(v)};o.sort=${JSON.stringify(sort)};const ids=_accRows().map(r=>r.c.id);o[${JSON.stringify(k)}]='all';o.sort='name';return ids;})()`,
) as Promise<string[]>;

test.describe('@staff:community last opened and last signed in', () => {
  test('report: filters, sorts (never seen last) and the two columns', async ({ page }) => {
    await staff(page);
    expect(await report(page, 'x_amSeen', '7')).toEqual(['a1']);
    expect(await report(page, 'x_amSeen', 'old')).toEqual(['a2']);
    expect(await report(page, 'x_amSeen', 'never')).toEqual(['a3']);
    expect(await report(page, 'x_amSignedIn', 'old')).toEqual(['a1']);
    expect(await report(page, 'x_amSignedIn', 'never')).toEqual(['a2', 'a3']);
    expect(await report(page, 'fTag', 'all', 'x_seen')).toEqual(['a1', 'a2', 'a3']);
    expect(await report(page, 'fTag', 'all', 'x_seenOld')).toEqual(['a2', 'a1', 'a3']);
    expect(await report(page, 'fTag', 'all', 'x_signin')).toEqual(['a1', 'a3', 'a2']);
    const cells = await page.evaluate(`_accRows().map(r=>[r.c.id,r.cells.lastSeen,r.cells.lastSignin])`) as string[][];
    expect(cells.find((c) => c[0] === 'a2')![1]).toContain('Website');
    expect(cells.find((c) => c[0] === 'a3')!.slice(1)).toEqual(['', '']);
  });

  test('report builder and Accounts list carry the new choices', async ({ page }) => {
    await staff(page);
    await page.evaluate('showAccountReportOptions()');
    const dlg = page.locator('#print-opts-modal');
    await expect(dlg.getByLabel('Last opened the app or website', { exact: true }).first()).toHaveCount(1);
    await expect(dlg.getByLabel('Sort by', { exact: true }).locator('option[value="x_seen"]')).toHaveCount(1);
    await expect(dlg.getByLabel('Sort by', { exact: true }).locator('option[value="x_signinOld"]')).toHaveCount(1);
    await page.evaluate(`closeModal&&document.querySelectorAll('.modal-overlay').forEach(m=>m.remove())`).catch(() => {});
    await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';S.amSort='seen';renderCustomers()`);
    expect(await page.locator('#am-cust-rows .am-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-cust')))).toEqual(['a1', 'a2', 'a3']);
    await expect(page.locator('#am-cust-rows .am-row[data-cust="a1"] .am-sortline')).toContainText('Last opened the app or website');
  });
});

test('@customer the app stamps the rider as seen when it opens on a remembered session', async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [], 'rpc:customer_token_ok': true });
  await page.route(/\/rest\/v1\/rpc\/customer_seen/, async (r) => { calls.push(JSON.parse(r.request().postData() || '{}')); await r.fulfill({ status: 204, body: '' }); });
  await page.addInitScript(() => localStorage.setItem('cq_session', JSON.stringify({ id: 'c9', name: 'Hadi Karam', email: 'hadi.karam@gmail.com', session_token: 'tok9' })));
  await page.goto('/');
  await expect.poll(() => calls.length, { timeout: 15000 }).toBeGreaterThan(0);
  expect(calls[0]).toEqual({ p_id: 'c9', p_token: 'tok9', p_via: 'app' });
});
