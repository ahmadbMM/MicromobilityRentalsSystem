import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Two accounts for one person (2026-09-28): Community > Duplicates lists the likely pairs (the same
// phone, or the same name and birth date), a merge keeps the account with more bookings unless the
// admin keeps the other, staff_merge_customers does the work behind the PIN, a merged account is off
// every list, and a merge can be undone for thirty days from the undo bar or the recent list.
const customers = [
  { id: 'c-amal-1', name: 'Amal Saleh', email: 'amal@x.sa', phone: '+966500000001', created_at: '2026-01-01T10:00:00Z', birth_date: '1990-05-05' },
  { id: 'c-amal-2', name: 'Amal Saleh', email: 'amal.s@y.sa', phone: '+966500000001', created_at: '2026-03-01T10:00:00Z', birth_date: null },
  { id: 'c-badr-1', name: 'Badr Ali', email: 'badr@x.sa', phone: '+966500000002', created_at: '2026-01-01T10:00:00Z', birth_date: '1985-01-02' },
  { id: 'c-badr-2', name: 'badr ali', email: 'b.ali@y.sa', phone: '+966500000099', created_at: '2026-02-01T10:00:00Z', birth_date: '1985-01-02' },
  { id: 'c-solo', name: 'Solo Rider', email: 'solo@x.sa', phone: '+966500000003', created_at: '2026-01-01T10:00:00Z', birth_date: null },
  { id: 'c-gone', name: 'Gone Rider', email: 'gone@x.sa', phone: '+966500000004', created_at: '2026-01-01T10:00:00Z', merged_into: 'c-solo' },
];
const row = (id: string, cust: string) => ({ id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 1, name: 'x', phone: '', customer_id: cust, status: 'done', paid: true, price: 30, registered_at: '2026-01-01T10:00:00Z' });
const queue = [row('q1', 'c-amal-1'), row('q2', 'c-amal-2'), row('q3', 'c-amal-2'), row('q4', 'c-badr-1')];
const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const merges = [{ id: 7, keep_id: 'c-solo', drop_id: 'c-gone', keep_name: 'Solo Rider', drop_name: 'Gone Rider', merged_at: '2026-09-27T10:00:00Z', merged_by: 'Spec Staff', undone_at: null }];

async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: queue, bikes: [], customers, tags: [], customer_tags: [], staff_options: [], customer_merges: merges, 'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: false }], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
}
function rpcs(page: Page, name: string) {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().includes(`/rest/v1/rpc/${name}`)) { try { calls.push(r.postDataJSON() || {}); } catch { calls.push({}); } } });
  return calls;
}

test('a merged account is off the lists, and the likely pairs are found by phone and by name with birth date', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(`(S.customers||[]).map(c=>c.id).sort()`)).toEqual(['c-amal-1', 'c-amal-2', 'c-badr-1', 'c-badr-2', 'c-solo']);
  const g = await page.evaluate(`_dupGroups().map(g=>({why:g.why,ids:g.accts.map(c=>c.id)}))`);
  expect(g).toEqual([{ why: 'phone', ids: ['c-amal-2', 'c-amal-1'] }, { why: 'name', ids: ['c-badr-1', 'c-badr-2'] }]); // the one with more bookings first
});

// A number staff put on a family's accounts is not a duplicate (the owner, 2026-09-30: "leave them
// out only the ones that staff put them"; riders cannot take a number in use): on one number only
// accounts with the same first name pair, a spelling of it included.
test('a family on one number is not a pair; the same first name on it, however spelt, still is', async ({ page }) => {
  const FAM = '+966500000077';
  const fam = [
    { id: 'c-huda', name: 'Huda Al Saleh', email: 'huda@x.sa', phone: FAM, created_at: '2025-01-01T10:00:00Z', birth_date: '1985-03-03' },
    { id: 'c-sara', name: 'Sara Al Saleh', email: 'sara@x.sa', phone: FAM, created_at: '2025-02-01T10:00:00Z', birth_date: '2014-04-04' },
    { id: 'c-lina', name: 'Lina Al Saleh', email: 'lina@x.sa', phone: FAM, created_at: '2025-03-01T10:00:00Z', birth_date: '2016-05-05' },
  ];
  await boot(page, { customers: [...customers, ...fam] });
  expect(await page.evaluate(`_dupGroups().map(g=>g.accts.map(c=>c.id).sort().join(','))`)).toEqual(['c-amal-1,c-amal-2', 'c-badr-1,c-badr-2']);
  // Huda made again as Hoda on the same number: that pair is offered, her children are not
  await page.evaluate(`S.customers.push({id:'c-hoda',name:'Hoda Saleh',email:'hoda@y.sa',phone:'${FAM}',created_at:'2026-05-01T10:00:00Z',birth_date:null})`);
  expect(await page.evaluate(`_dupGroups().filter(g=>g.why==='phone').map(g=>g.accts.map(c=>c.id).sort().join(','))`)).toEqual(['c-amal-1,c-amal-2', 'c-hoda,c-huda']);
  await page.evaluate(`setStaffTab('customers');setCustomersTab('duplicates')`);
  await expect(page.locator('#tab-customers .filter-pill.active')).toContainText('Duplicates (3)');
  await expect(page.locator('#tab-customers .mg-group', { hasText: 'Sara Al Saleh' })).toHaveCount(0);
});

test('the tab has its own address, lists the pairs, opens the merge dialog with the keeper chosen, lets the admin keep the other, and calls the function', async ({ page }) => {
  await boot(page, { 'rpc:staff_merge_customers': { ok: true, id: 8, keep_name: 'Amal Saleh', drop_name: 'Amal Saleh' } });
  const calls = rpcs(page, 'staff_merge_customers');
  await page.evaluate(`setStaffTab('customers');setCustomersTab('duplicates')`);
  expect(await page.evaluate(`location.pathname`)).toBe('/customers/duplicates');
  const tab = page.locator('#tab-customers');
  await expect(tab.locator('.filter-pill.active')).toContainText('Duplicates (2)');
  await expect(tab.locator('.mg-group')).toHaveCount(2);
  await expect(tab.locator('.mg-group').first()).toContainText('Same phone');
  await expect(tab.locator('.mg-group').first().locator('.mg-acct').first()).toContainText('2 bookings');
  await expect(tab).toContainText('Recent merges');
  await expect(tab.locator('.mg-row')).toContainText('Gone Rider');

  await tab.locator('.mg-group').first().locator('button', { hasText: 'Merge' }).click();
  const dlg = page.locator('#confirm-modal');
  await expect(dlg).toContainText('Merge accounts');
  await expect(dlg.locator('.mg-dlg-side').first()).not.toContainText('amal.s@y.sa'); // masked until shown (2026-10-10)
  await page.evaluate(`_piiReveal(null,'c-amal-1','');_piiReveal(null,'c-amal-2','')`);
  await expect(dlg.locator('.mg-dlg-side').first()).toContainText('amal.s@y.sa'); // more bookings stays
  await dlg.locator('button', { hasText: 'Keep the other one' }).click();
  await expect(dlg.locator('.mg-dlg-side').first()).toContainText('amal@x.sa');
  await dlg.locator('button', { hasText: 'Merge accounts' }).last().click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ p_keep: 'c-amal-1', p_drop: 'c-amal-2', p_by: 'Spec Staff', p_op: 'Spec Staff', p_approval: null }); // the approval travels with it (2026-10-04)
  // the merge is on the undo bar
  expect(await page.evaluate(`S.undoStack.length`)).toBe(1);
});

test('the manual picker finds accounts by name or phone, and refuses the same account twice', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffTab('customers');setCustomersTab('duplicates')`);
  const tab = page.locator('#tab-customers');
  const a = tab.locator('.mg-pick').first().locator('input');
  await a.fill('0500000003');
  await expect(tab.locator('.mg-pick').first().locator('.mg-matches button')).toHaveCount(1);
  await tab.locator('.mg-pick').first().locator('.mg-matches button').click();
  await expect(tab.locator('.mg-pick').first().locator('.mg-picked')).toContainText('Solo Rider');
  await tab.locator('.mg-pick').nth(1).locator('input').fill('badr');
  await expect(tab.locator('.mg-pick').nth(1).locator('.mg-matches button')).toHaveCount(2);
  await tab.locator('.mg-pick').nth(1).locator('.mg-matches button').first().click();
  await expect(tab.locator('button', { hasText: /^Merge$/ }).last()).toBeEnabled();
  // the same account twice
  await page.evaluate(`S._mgA='c-solo';S._mgB='c-solo';_mgManualGo()`);
  await expect(page.locator('#confirm-modal')).toBeHidden();
});

test('Undo on a recent merge calls the function; a database without it says so', async ({ page }) => {
  await boot(page, { 'rpc:staff_unmerge_customers': { ok: true, id: 7, keep_name: 'Solo Rider', drop_name: 'Gone Rider' } });
  const calls = rpcs(page, 'staff_unmerge_customers');
  await page.evaluate(`setStaffTab('customers');setCustomersTab('duplicates')`);
  await page.locator('#tab-customers .mg-row button', { hasText: 'Undo merge' }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ p_id: 7 });
});

test('before the database update the merge says so instead of failing', async ({ page }) => {
  await boot(page, { 'rpc:staff_merge_customers': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_merge_customers' } } });
  await page.evaluate(`setStaffTab('customers');setCustomersTab('duplicates')`);
  await page.evaluate(`_mgRun('c-amal-1','c-amal-2')`);
  await expect(page.locator('.toast, #toast, [role="status"]').filter({ hasText: /database/i }).first()).toBeVisible();
  expect(await page.evaluate(`S.undoStack.length`)).toBe(0);
});

test('Front Desk has no Duplicates tab', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffRole('admin');setStaffTab('customers');setCustomersTab('duplicates')`);
  await expect(page.locator('#tab-customers .filter-pill', { hasText: 'Duplicates' })).toHaveCount(1);
  await page.evaluate(`S.staffRole='frontdesk';S.customersTab='duplicates';renderCustomers()`);
  await expect(page.locator('#tab-customers .filter-pill', { hasText: 'Duplicates' })).toHaveCount(0);
  await expect(page.locator('#tab-customers .mg-group')).toHaveCount(0);
});

// A failed read of the recent merges (network, timeout, lapsed sign-in) used to repaint the tab,
// and the repaint read again at once: a read-and-redraw loop for as long as the failure lasted.
test('a failed read of the recent merges is said once, not retried in a loop; opening the tab again retries', async ({ page }) => {
  await boot(page);
  let n = 0;
  await page.route(/\/rest\/v1\/customer_merges/, (r) => { n++; return r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout' }) }); });
  await page.evaluate(`S._mgRows=null;setStaffTab('customers');setCustomersTab('duplicates')`);
  await expect(page.locator('#tab-customers .tm-note')).toContainText(/connection|connect/i);
  await page.waitForTimeout(600);
  expect(n).toBe(1);
  await page.evaluate(`setCustomersTab('duplicates')`);
  await expect.poll(() => n).toBe(2);
});

// The manual merge search repaints the tab as staff type; the box keeps its focus through it.
test('typing in the manual merge search keeps the focus across the repaint', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffTab('customers');setCustomersTab('duplicates')`);
  const box = page.locator('#mg-qa');
  await box.click();
  await page.keyboard.type('Am');
  await page.waitForTimeout(300);
  await page.keyboard.type('al');
  await expect(page.locator('#mg-qa')).toHaveValue('Amal');
  await expect(page.locator('#mg-qa')).toBeFocused();
  await expect(page.locator('#tab-customers .mg-matches button').first()).toContainText('Amal');
});
