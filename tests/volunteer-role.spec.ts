import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';
import { readFileSync } from 'node:fs';

// The Volunteer role (2026-11-05): one page, one donor at a time, no staff panel and no staff data.

const row = { id: 'abc123xyz', name: 'Sara Donor', number: 12, checked_in: false, donated: false, mine_in: false, mine_donated: false };

test.describe('Volunteer role', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page, {});
    await unlockStaff(page);
    await page.addInitScript(() => { localStorage.setItem('cq_role', 'volunteer'); });
    await page.route(/\/rest\/v1\/rpc\/staff_volunteer_find/, (route) => route.fulfill({ json: [row] }));
    await page.route(/\/rest\/v1\/rpc\/staff_volunteer_(checkin|donated)/, (route) => route.fulfill({ json: { ok: true } }));
    await page.goto('/');
    await waitForSb(page);
    await expect(page.locator('#vol-page .vol-title')).toBeVisible();
  });

  test('sees the one page, never the panel', async ({ page }) => {
    await expect(page.locator('#view-staff')).toBeHidden();
    await expect(page.locator('#vol-rows .vol-row')).toHaveCount(0);
    await expect(page.locator('#loading-screen')).toBeHidden(); // nothing to wait for: the boot spinner must not stay over the page
    await page.evaluate(() => { (window as unknown as { setStaffTab: (t: string) => void }).setStaffTab('customers'); });
    await expect(page.locator('#view-staff')).toBeHidden();
  });

  test('a mobile is searched whole, a short one is a booking number, anything else is refused', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.route(/\/rest\/v1\/rpc\/staff_volunteer_find/, (route) => { sent.push(route.request().postDataJSON()); return route.fulfill({ json: [row] }); });
    await page.fill('#vol-q', '050 123 4567');
    await page.click('#vol-find');
    await expect(page.locator('.vol-name')).toContainText('Sara Donor');
    await page.fill('#vol-q', '12');
    await page.press('#vol-q', 'Enter');
    await page.waitForFunction(() => document.querySelector('#vol-q') !== null);
    await page.fill('#vol-q', 'Sara');
    await page.click('#vol-find');
    await expect(page.locator('#vol-msg')).toContainText('whole mobile');
    await expect(page.locator('.vol-row')).toHaveCount(0);
    expect(sent).toEqual([{ p_mobile: '0501234567' }, { p_number: 12 }]);
  });

  test('check-in, then donated, then the undo of the volunteer\'s own mark', async ({ page }) => {
    await page.fill('#vol-q', '12');
    await page.click('#vol-find');
    await expect(page.locator('.vol-acts button')).toHaveCount(1);
    await page.click('.vol-acts .btn-primary');
    await expect(page.locator('.vol-chips')).toContainText('Checked in');
    await expect(page.locator('.vol-acts button')).toHaveCount(2);
    await page.click('.vol-acts .btn-primary');
    await expect(page.locator('.vol-chips .rr-yes')).toHaveCount(2);
    await expect(page.locator('.vol-acts button')).toHaveCount(1);
    await expect(page.locator('.vol-acts button')).toHaveText('Undo donated');
  });

  test('a donor someone else marked offers no undo', async ({ page }) => {
    await page.route(/\/rest\/v1\/rpc\/staff_volunteer_find/, (route) => route.fulfill({ json: [{ ...row, checked_in: true, donated: true }] }));
    await page.fill('#vol-q', '12');
    await page.click('#vol-find');
    await expect(page.locator('.vol-row')).toHaveCount(1);
    await expect(page.locator('.vol-acts button')).toHaveCount(0);
  });

  test('outside the window it says so', async ({ page }) => {
    await page.route(/\/rest\/v1\/rpc\/staff_volunteer_find/, (route) => route.fulfill({ status: 403, json: { code: '42501', message: 'VOL_CLOSED' } }));
    await page.fill('#vol-q', '12');
    await page.click('#vol-find');
    await expect(page.locator('#vol-msg')).toContainText('not open');
  });

  test('a scanned ticket goes by its reference', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.route(/\/rest\/v1\/rpc\/staff_volunteer_find/, (route) => { sent.push(route.request().postDataJSON()); return route.fulfill({ json: [row] }); });
    await page.evaluate(() => (window as unknown as { _volScanned: (s: string) => Promise<void> })._volScanned('MMC-12-abc123'));
    await expect(page.locator('.vol-name')).toContainText('Sara Donor');
    expect(sent).toEqual([{ p_ref: 'abc123', p_ref_num: 12 }]);
  });
});

test('the database gates refuse the role, and no code reaches the volunteer', () => {
  const sql = readFileSync('supabase/migrations/20261105090000_blood_volunteer_role.sql', 'utf8');
  for (const fn of ['is_staff', '_staff_mod', '_staff_cap']) {
    const body = sql.slice(sql.indexOf(`function public.${fn}(`));
    expect(body.slice(0, body.indexOf('$function$;'))).toContain("is distinct from 'volunteer'");
  }
  const vol = sql.slice(sql.indexOf('function public.staff_volunteer_donated('));
  expect(vol.slice(0, vol.indexOf('end $function$'))).not.toMatch(/'code'|return _blood_donated_apply/);
});
