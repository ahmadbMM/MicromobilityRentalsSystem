import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// After Team > Invite (2026-10-09, migration 20261009208000): staff_invite writes Auth's tables itself, so the page
// reads the new account back (staff_invite_check) before it hands over the temporary password, and says plainly
// what is missing when the account cannot sign in.
const ME = '11111111-1111-1111-1111-111111111111';
const NEW = '33333333-3333-3333-3333-333333333333';
const team = [{ user_id: ME, email: 'owner@example.com', role: 'admin', modules_view: null, modules_edit: null, is_me: true }];
const more = [{ user_id: ME, disabled_at: null, caps: null, display_name: 'Owner', last_sign_in_at: '2026-10-08T18:00:00Z' }];

async function invite(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], 'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: false }],
    'rpc:staff_team_list': team, 'rpc:staff_team_more': more, 'rpc:staff_invite': { ok: true, user_id: NEW }, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();setStaffTab('team')`);
  await page.fill('#tm-inv-email', 'new.person@example.com');
  await page.fill('#tm-inv-name', 'Ali Hassan');
  await page.click('#tm-inv-go');
}

test.describe('@staff:team invite read-back', () => {
  test('an account missing its email sign-in is reported and its password is not shown', async ({ page }) => {
    await invite(page, { 'rpc:staff_invite_check': { ok: false, staff: true, auth: true, identity: false, confirmed: true, password: true } });
    const dlg = page.getByRole('dialog', { name: 'The account was not set up fully' });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('new.person@example.com');
    await expect(dlg.locator('.tm-inv-miss li')).toHaveText(['Sign-in with email']);
    await expect(page.locator('#tm-pwd-val')).toHaveCount(0);
  });

  test('a sound account shows its temporary password', async ({ page }) => {
    await invite(page, { 'rpc:staff_invite_check': { ok: true, staff: true, auth: true, identity: true, confirmed: true, password: true } });
    await expect(page.locator('#tm-pwd-val')).toBeVisible();
  });

  test('before the database update Team\'s list stands in: an account not on it is reported', async ({ page }) => {
    await invite(page, {});
    const dlg = page.getByRole('dialog', { name: 'The account was not set up fully' });
    await expect(dlg.locator('.tm-inv-miss li')).toHaveText(['The staff account']);
  });
});
