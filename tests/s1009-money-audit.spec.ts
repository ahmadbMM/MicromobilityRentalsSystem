import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The record of who did what (2026-10-09; migration 20261009150000): a record's Changes panel reads
// its audit_log rows as sentences (M1), admins search the trail and export it, the Action Log pages
// on the server with a custom range, names the signed-in account and opens the record a line is
// about (M2), and History > Exceptions and Analytics > Team add up voids, refunds, discounts, price
// changes and each person's work (M3, M5).
const TOMORROW = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const NOW = new Date().toISOString();
const UID = '11111111-1111-1111-1111-111111111111';
const sessions = [{ id: 's0', day: 'Friday', session_date: TOMORROW, capacity: 12, status: 'open', created_at: 1 }];
const q1 = { id: 'q1', session_id: 's0', session_day: 'Friday', session_date: TOMORROW, queue_num: 7, name: 'Rider One', phone: '0500000001', status: 'waiting', paid: false, price: 75, type_preference: 'Road', registered_at: '2026-01-01T10:00:00Z' };
const audit = [
  { id: 9, at: NOW, actor: UID, actor_email: 'desk@example.com', tbl: 'queue_entries', row_id: 'q1', op: 'UPDATE', changed: { price: { old: 75, new: 0 }, paid: { old: false, new: true }, password_hash: { old: 'x', new: 'y' } } },
  { id: 8, at: NOW, actor: null, actor_email: null, tbl: 'queue_entries', row_id: 'q1', op: 'UPDATE', changed: { status: { old: 'waiting', new: 'active' } } },
];
const people = [{ user_id: UID, name: 'Desk Person', email: 'desk@example.com', role: 'frontdesk' }];
const voided = { id: 'v1', receipt_id: 'rv', session_id: 's0', name: 'Water', qty: 1, price: 5, pay: 'paid', category: 'drinks', created_at: NOW, voided_at: NOW, voided_by: 'Spec Staff', void_reason: 'wrong_item' };
const house = { id: 'h1', receipt_id: 'rh', session_id: 's0', name: 'Gel', qty: 1, price: 12, pay: 'house', category: 'EnergyGels', created_at: NOW, sold_by: UID, sold_by_name: 'Desk Person' };

async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [q1], bikes: [], audit_log: audit, 'rpc:staff_people': people, ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`localStorage.setItem('cq_op_name','Spec Staff');S.staffRole='admin';`);
}

test.describe('@staff:history audit trail, action log, exceptions, team', () => {
  test('a booking\'s Changes reads its audit rows as sentences, names the account, hides secrets', async ({ page }) => {
    await boot(page);
    await page.evaluate(`showBookingEditModal('q1')`);
    await page.locator('#booking-edit-modal').getByRole('button', { name: 'Changes', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: /Changes/ });
    await expect(dlg).toContainText('Price: SAR 75 → SAR 0');
    await expect(dlg).toContainText('Paid: No → Yes');
    await expect(dlg).toContainText('Desk Person');
    await expect(dlg).toContainText('System'); // a row with no account: the database itself
    await expect(dlg).not.toContainText('password');
    await dlg.getByRole('button', { name: 'Close' }).click();
    await expect(dlg).toHaveCount(0);
  });

  test('without the audit table the panel says so instead of failing', async ({ page }) => {
    await boot(page);
    await page.route(/\/rest\/v1\/audit_log/, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.audit_log' in the schema cache" }) }));
    await page.evaluate(`openAuditPanel('bikes',['b1'],'Road 01')`);
    await expect(page.getByRole('dialog', { name: /Changes/ })).toContainText('Waiting for the database update');
  });

  test('History > Audit trail (admins) lists every table\'s rows and exports them', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('history');S.histView='audit';renderHistory()`);
    await expect(page).toHaveURL(/\/history\/audit$/);
    const host = page.locator('#mny-host');
    await expect(host).toContainText('Bookings');
    await expect(host).toContainText('Status: Waiting');
    const dl = page.waitForEvent('download');
    await host.getByRole('button', { name: /Export CSV/ }).click();
    expect((await dl).suggestedFilename()).toBe('audit_trail.csv');
    // a front-desk account has no Audit pill
    await page.evaluate(`S.staffRole='frontdesk';S.histView='rides';renderHistory()`);
    await expect(page.locator('#tab-history').getByRole('button', { name: 'Audit trail' })).toHaveCount(0);
  });

  test('the Action Log: a line carries what it was about, the account and the amount, and opens the record', async ({ page }) => {
    await boot(page, { staff_actions: [{ id: 5, at: NOW, action: 'Check in: #7 Rider One', who: 'Device Name', user_id: UID, kind: 'checkin', entity: 'booking', entity_id: 'q1', amount: 75 }] });
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/staff_actions')) { try { sent.push(r.postDataJSON()); } catch { /* none */ } } });
    await page.evaluate(`logAction('Refund · test',{k:'refund',e:'receipt',id:'r9',amt:12.5})`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1]).toMatchObject({ action: 'Refund · test', kind: 'refund', entity: 'receipt', entity_id: 'r9', amount: 12.5 });
    await page.evaluate(`setStaffTab('history');S.histView='log';S._dbLogAt=0;renderHistory()`);
    const row = page.locator('.lg-row').filter({ hasText: '#7 Rider One' });
    await expect(row).toContainText('Device Name');
    await expect(row).toContainText('Desk Person');
    await expect(row).toContainText('SAR 75');
    await row.getByRole('button', { name: /#7 Rider One/ }).click();
    await expect(page.locator('#booking-edit-modal [role="dialog"]')).toBeVisible();
  });

  test('the Action Log asks the server for the custom range and for older pages', async ({ page }) => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: 1000 - i, at: NOW, action: 'Line ' + i, who: 'X', user_id: null }));
    await boot(page, { staff_actions: many });
    const gets: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/staff_actions')) gets.push(decodeURIComponent(r.url())); });
    await page.evaluate(`setStaffTab('history');S.histView='log';S._logDay='custom';S._logFrom='2026-10-01';S._logTo='2026-10-03';S._dbLog=null;renderHistory()`);
    await expect.poll(() => gets.some((u) => u.includes('at=gte.2026-09-30T21:00:00') && u.includes('at=lt.2026-10-03T21:00:00'))).toBe(true);
    await page.evaluate(`S._logDay='all';S._dbLog=null;S._dbLogAt=0;renderLogs()`);
    await expect(page.getByRole('button', { name: 'Load older' })).toBeVisible();
    const before = gets.length;
    await page.getByRole('button', { name: 'Load older' }).click();
    await expect.poll(() => gets.slice(before).some((u) => /or=\(at\.lt\./.test(u))).toBe(true);
  });

  test('History > Exceptions: voids with their reason, on-the-house lines, booking price changes, by operator; print and CSV', async ({ page }) => {
    await boot(page, { cashier_sales: [voided, house] });
    await page.evaluate(`setStaffTab('history');S.histView='exceptions';renderHistory()`);
    const host = page.locator('#mny-host');
    await expect(host).toContainText('Wrong item');
    await expect(host).toContainText('Gel');
    await expect(host).toContainText('#7 Rider One: SAR 75 → SAR 0');
    await expect(host).toContainText('Rides on the house');
    await expect(host.locator('table').first()).toContainText('Spec Staff');
    await expect(host.locator('table').first()).toContainText('Desk Person');
    const dl = page.waitForEvent('download');
    await host.getByRole('button', { name: /Export CSV/ }).click();
    expect((await dl).suggestedFilename()).toMatch(/^exceptions_/);
    await page.evaluate(`window.open=()=>({closed:false,document:{write:(h)=>{window.__ex=(window.__ex||'')+h;},close(){},querySelectorAll:()=>[]},focus(){},print(){},close(){}})`);
    await host.getByRole('button', { name: /Print/ }).click();
    await expect.poll(() => page.evaluate(`window.__ex||''`)).toContain('Wrong item');
  });

  test('Analytics > Team: sales and desk work per person (admins only)', async ({ page }) => {
    await boot(page, { cashier_sales: [{ ...house, pay: 'paid', id: 'p1' }], staff_actions: [{ user_id: UID, who: 'Desk Person', kind: 'checkin', amount: null }, { user_id: UID, who: 'Desk Person', kind: 'checkin', amount: null }, { user_id: UID, who: 'Desk Person', kind: 'refund', amount: 5 }] });
    await page.evaluate(`setStaffTab('analytics');setAnView('team')`);
    await expect(page).toHaveURL(/\/analytics\/team$/);
    const row = page.locator('#an-team-host tr').filter({ hasText: 'Desk Person' });
    await expect(row).toContainText('SAR 12');
    await expect(row.locator('td').nth(3)).toHaveText('2');
    await expect(row.locator('td').nth(7)).toHaveText('1');
  });
});
