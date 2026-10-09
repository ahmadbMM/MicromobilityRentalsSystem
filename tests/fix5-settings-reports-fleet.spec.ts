import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The 2026-10-05 fixes to Settings, Team, the reports and the fleet:
//   - an account limited to some sections saves its own Settings;
//   - a message template save stops when the templates cannot be read;
//   - the Team page names each role select for its account;
//   - a password change says Supabase's refusals in the staffer's language;
//   - the printed account report is an admin's, with the PIN;
//   - Add-ons sold counts riders who took them, at the price they were sold at; Kids is a report filter;
//   - a rental price of 0 is kept, a per-type Add starts empty, a retired bike's number is taken.

const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
async function boot(page: Page, fx: Record<string, unknown> = {}, path = '/') {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], ...fx });
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
}
function writesTo(page: Page, table: string) {
  const out: string[] = [];
  page.on('request', (r) => { if (['POST', 'PATCH'].includes(r.method()) && r.url().includes(`/rest/v1/${table}`)) out.push(r.method()); });
  return out;
}

test.describe('@staff:settings Settings and Team', () => {
  test('an account with an edit list still saves its own Settings', async ({ page }) => {
    await boot(page, { 'rpc:staff_my_settings': { display_name: 'Spec Staff', photo: null, nt_off: [] } }, '/settings');
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/staff_my_settings')) asked.push(r.url()); });
    await page.evaluate(`S._myEdit=[];S.staffTab='settings'`);
    expect(await page.evaluate('_roNow()')).toBe(false);
    expect(await page.evaluate(`_setSave({p_nt_off:[]})`)).toEqual({ ok: true });
    expect(asked).toHaveLength(1);
    // the sections the list leaves out stay read-only
    expect(await page.evaluate(`(S.staffTab='queue',_roNow())`)).toBe(true);
  });

  test('a template save stops when the saved templates cannot be read', async ({ page }) => {
    await boot(page);
    const w = writesTo(page, 'site_content');
    await page.route(/\/rest\/v1\/site_content/, (route) => route.request().method() === 'GET'
      ? route.fulfill({ status: 500, headers: head, body: JSON.stringify({ code: 'XX000', message: 'read failed' }) })
      : route.fallback());
    await page.evaluate(`S._tplEd={id:'wa_turn',lang:'en',text:{en:'Hello from the desk',ar:''}}`);
    await page.evaluate('_tplEdSave()');
    await expect(page.locator('#err-bar-el')).toBeVisible();
    expect(w).toHaveLength(0); // nothing written over the other admins' messages
  });

  test('the Team page names each role select for its account', async ({ page }) => {
    await boot(page, {
      'rpc:staff_operator_list': [],
      'rpc:staff_team_list': [
        { user_id: 'u1', email: 'owner@example.com', role: 'admin', modules_view: null, modules_edit: null, is_me: true },
        { user_id: 'u2', email: 'desk@example.com', role: 'frontdesk', modules_view: null, modules_edit: null, is_me: false },
      ],
    });
    await page.evaluate(`setStaffTab('team')`);
    await expect(page.locator('#tab-team [data-acct="u2"] .tm-role')).toHaveAttribute('aria-label', 'Role for desk@example.com');
  });

  test('a password change says Supabase\'s refusal in the staffer\'s words', async ({ page }) => {
    await boot(page, {
      'rpc:staff_my_settings': { display_name: 'Spec Staff', photo: null, nt_off: [] },
      'auth:token': { access_token: 'jwt', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r',
        user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'staff@example.com' } },
    }, '/settings');
    await page.route(/\/auth\/v1\/user/, (route) => route.request().method() === 'PUT'
      ? route.fulfill({ status: 422, headers: head, body: JSON.stringify({ code: 422, error_code: 'same_password', msg: 'New password should be different from the old password.' }) })
      : route.fallback());
    await page.fill('#set-pwd-cur', 'Current1');
    await page.fill('#set-pwd-new', 'Current1');
    await page.fill('#set-pwd-new2', 'Current1');
    await page.click('#set-pwd-save');
    await expect(page.locator('#set-pwd-err')).toHaveText('Choose a password different from your current one.');
  });
});

test.describe('@staff:reports the account report and add-on sales', () => {
  const customers = [{ id: 'c1', name: 'Amal Spec', created_at: '2099-01-01T10:00:00Z' }];

  test('the printed account report is an admin\'s', async ({ page }) => {
    await boot(page, { customers });
    await page.waitForFunction('getCustomers().length===1');
    await page.evaluate(`window.__opened=0;window.open=()=>{window.__opened++;return null;};S.staffRole='frontdesk'`);
    await page.evaluate('printAccountReport()');
    await expect(page.locator('.toast', { hasText: 'Your account cannot export lists.' }).first()).toBeVisible(); // the export cap, off for non-admins by default (2026-10-09)
    expect(await page.evaluate('window.__opened')).toBe(0);
  });

  test('an operator with a PIN is asked for it before the report opens', async ({ page }) => {
    await boot(page, { customers, 'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: true }] });
    await page.waitForFunction('getCustomers().length===1');
    await page.evaluate(`window.__opened=0;window.open=()=>{window.__opened++;return null;};void printAccountReport()`); // waits on the keypad: not awaited
    await expect(page.getByRole('dialog', { name: 'Confirm with your PIN: Account report' })).toBeVisible();
    expect(await page.evaluate('window.__opened')).toBe(0);
  });

  test('Add-ons sold counts riders who took them, at the price they were sold at', async ({ page }) => {
    await boot(page, { inventory: [{ id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 5, price: 10, low_threshold: 1 }] });
    await page.waitForFunction(`(S.inventory||[]).length===1`);
    const r = await page.evaluate(`addonSalesFromGroups([[
      {status:'done',addons:[{id:'i1',qty:2,p:8}]},
      {status:'active',addons:[{id:'i1',qty:1}]},
      {status:'noshow',addons:[{id:'i1',qty:1,p:8}]},
      {status:'waiting',addons:[{id:'i1',qty:3,p:8}]}]])`) as { totalUnits: number; totalValue: number };
    expect(r.totalUnits).toBe(3);   // 2 done + 1 on the bike; the no-show and the rider still waiting took nothing
    expect(r.totalValue).toBe(26);  // 2 x 8 sold, 1 x 10 for a line from before sold prices were kept
  });

  test('the report builder can filter by Kids', async ({ page }) => {
    await boot(page);
    await page.evaluate('showPrintReportOptions()');
    await expect(page.locator('#print-opts-modal option[value="Kids"]')).toHaveCount(1);
  });
});

test.describe('@staff:bikes the bike form and the import', () => {
  test('a rental price of 0 is a price, not "not set"', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`[(S._bkRentalPrice='0',_bkRentalVal()),(S._bkRentalPrice='',_bkRentalVal()),(S._bkRentalPrice='57.5',_bkRentalVal())]`)).toEqual([0, null, 57.5]);
  });

  test('a per-type Add starts from an empty form', async ({ page }) => {
    await boot(page);
    const s = await page.evaluate(`(()=>{S._bkPriv={orig:null,typed:{serial:'SN-1'}};S._bkBrand='Alvas';S._bkRentalPrice='95';
      _on_renderBikes_14(null,null,'Road');return {priv:S._bkPriv,brand:S._bkBrand,price:S._bkRentalPrice,type:S.addBikeType,open:S.showAddBike};})()`);
    expect(s).toEqual({ priv: null, brand: '', price: '', type: 'Road', open: true });
  });

  test('the import preview counts a retired bike\'s number as taken', async ({ page }) => {
    await boot(page, { bikes: [{ id: 'old', name: 'Road 007', bike_number: 7, type: 'Road', size: 'M', status: 'retired', colors: ['#000000'], color_names: [''] }] });
    await page.waitForFunction('getBikes().length===1');
    expect(await page.evaluate(`_bkCsvRows('number,type\\n7,Road\\n8,Road').rows.map(r=>r.errs)`)).toEqual([['bkImportErrDup'], []]);
  });
});
