import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// History > Data access (migration 20261009220000): who looked at personal data, filterable, CSV; the
// quarterly access review with its Reviewed stamp; a list exported with personal data in it is recorded
// once with its count; the Business switch and the Team cap. Invented people only.

const ME = '11111111-1111-1111-1111-111111111111';
const DESK = '22222222-2222-2222-2222-222222222222';
const team = [
  { user_id: ME, email: 'owner@example.com', role: 'admin', modules_view: null, modules_edit: null, is_me: true },
  { user_id: DESK, email: 'desk@example.com', role: 'frontdesk', modules_view: ['queue', 'cashier'], modules_edit: null, is_me: false },
];
const more = [
  { user_id: ME, disabled_at: null, caps: null, display_name: 'Owner', last_sign_in_at: '2026-10-08T18:00:00Z' },
  { user_id: DESK, disabled_at: null, caps: { can_see_pii_unmasked: true }, display_name: 'Desk Dana', last_sign_in_at: null },
];
const REVEALS = [
  { id: 2, at: new Date().toISOString(), user_id: DESK, who: 'Desk Dana', customer_id: 'c1', booking_id: null, fields: ['email', 'phone'], via: 'reveal', what: null, n_rows: null },
  { id: 1, at: new Date().toISOString(), user_id: ME, who: 'Owner', customer_id: null, booking_id: null, fields: ['phone'], via: 'export', what: 'Account report', n_rows: 42 },
];
type Call = { name: string; body: Record<string, unknown> };
function rpcs(page: Page) {
  const calls: Call[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); } });
  return calls;
}
async function boot(page: Page, x: Record<string, unknown> = {}) {
  const fx: Record<string, unknown> = {
    sessions: [], queue_entries: [], bikes: [], customers: [{ id: 'c1', name: 'Hidden Huda', phone: '0551234567', email: 'huda@example.com' }],
    pii_reveals: REVEALS, 'rpc:staff_team_list': team, 'rpc:staff_team_more': more, 'rpc:staff_people': [{ user_id: DESK, name: 'Desk Dana' }, { user_id: ME, name: 'Owner' }],
    'rpc:staff_pii_reveal': true, 'rpc:staff_access_reviewed': { at: '2026-10-10T08:00:00.000Z', by: 'Owner', accounts: 2 }, ...x,
  };
  for (const k of Object.keys(fx)) if (fx[k] === undefined) delete fx[k]; // left out: the database does not have it
  await stubSupabase(page, fx);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@staff:history s1010 data access', () => {
  test('History > Data access lists the looks with customer names, and the review shows each account', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('history');S.histView='access';renderHistory()`);
    await expect(page).toHaveURL(/\/history\/data-access$/);
    const tbl = page.locator('#mny-host .pa-tbl').first();
    await expect(tbl).toContainText('Hidden Huda');
    await expect(tbl).toContainText('Desk Dana');
    await expect(tbl).toContainText('Email, Phone');
    await expect(tbl).toContainText('Account report · 42 rows');
    const rv = page.locator('#mny-host .pa-review');
    await expect(rv).toContainText('Not reviewed yet');
    await expect(rv).toContainText('Desk Dana');
    await expect(rv).toContainText('See personal data unhidden');
    await expect(rv).toContainText('Bookings'); // the account's sections, named
  });

  test('Mark as reviewed stamps the review through its function', async ({ page }) => {
    await boot(page);
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('history');S.histView='access';renderHistory()`);
    await page.locator('#pa-rv-btn').click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_access_reviewed').length).toBe(1);
    await expect(page.locator('#mny-host .pa-stamp')).toContainText('Last reviewed');
    await expect(page.locator('#mny-host .pa-stamp')).toContainText('Owner');
  });

  test('a CSV with phones in it records one export line with its count', async ({ page }) => {
    await boot(page);
    const calls = rpcs(page);
    await page.evaluate(`_downloadCsv('x.csv',[[t('nameLabel'),t('repColPhone')],['A','0500000001'],['B','0500000002']],'Spec list')`);
    await expect.poll(() => calls.filter((c) => c.name === 'staff_pii_reveal').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_pii_reveal')!.body).toMatchObject({ p_via: 'export', p_what: 'Spec list', p_rows: 2, p_fields: ['phone'], p_customer: null });
    await page.evaluate(`_downloadCsv('y.csv',[[t('nameLabel')],['A']],'No personal data')`);
    await page.waitForTimeout(300);
    expect(calls.filter((c) => c.name === 'staff_pii_reveal')).toHaveLength(1);
  });

  test('before the database update the page says so instead of failing', async ({ page }) => {
    await boot(page, { pii_reveals: undefined });
    await page.evaluate(`setStaffTab('history');S.histView='access';renderHistory()`);
    await expect(page.locator('#mny-host')).toContainText(/database/i);
  });

  test('Settings > Business has the switch, on by default; Team offers the cap and sends it only when on', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_access': true, 'rpc:staff_set_caps': true, 'rpc:staff_operator_list': [] });
    await page.evaluate(`setStaffTab('settings');setSettingsView('business')`);
    await expect(page.locator('#biz-pii_mask')).toBeChecked();
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('team')`);
    const desk = page.locator(`.tm-acct[data-acct="${DESK}"]`);
    const chip = desk.locator('[data-cap="pii"]');
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await chip.click();
    await desk.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_set_caps').length).toBe(1);
    expect((calls.find((c) => c.name === 'staff_set_caps')!.body.p_caps as Record<string, unknown>).can_see_pii_unmasked).toBeUndefined();
  });
});
