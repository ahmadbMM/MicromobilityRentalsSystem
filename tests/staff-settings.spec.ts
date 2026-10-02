import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Every staff account has a Settings page (the owner, 2026-10-02): its name and picture, its sign-in
// email and password, and which notifications the bell gives it. The name, picture and choices are
// the account's (staff_my_settings); the email changes through staff_set_own_email, which checks the
// current password on the server.

const calls: Record<string, Record<string, unknown>[]> = {};
async function open(page: Page, x: Record<string, unknown> = {}) {
  for (const k of Object.keys(calls)) delete calls[k];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/(staff_my_settings|staff_set_own_email)/);
    if (m && r.method() === 'POST') (calls[m[1]] = calls[m[1]] || []).push(r.postDataJSON());
  });
  await stubSupabase(page, {
    sessions: [], bikes: [], queue_entries: [],
    'rpc:staff_my_settings': { display_name: 'Sara Nasser', photo: null, nt_off: [] },
    'rpc:staff_set_own_email': 'sara.new@micromobility.sa',
    ...x,
  });
  await unlockStaff(page);
  await page.goto('/settings');
  await waitForSb(page);
  await expect(page.locator('#tab-settings .page-title')).toHaveText('Settings');
}

test('Settings has its own address and every role can open it', async ({ page }) => {
  await open(page);
  expect(new URL(page.url()).pathname).toBe('/settings');
  await page.evaluate(`setStaffRole('frontdesk');setStaffTab('settings')`);
  expect(await page.evaluate('S.staffTab')).toBe('settings');
  await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="settings"]')).toBeAttached();
  await expect(page.locator('#tab-settings .form-title')).toHaveText(['Profile', 'Sign-in', 'Notifications']);
});

test('the name is saved to the account and the bar shows it', async ({ page }) => {
  await open(page);
  await page.fill('#set-name', 'S');
  await page.click('#set-name-save');
  await expect(page.locator('#set-name-err')).toHaveText('Enter a name of at least 2 letters.');
  expect(calls.staff_my_settings).toBeUndefined();
  await page.fill('#set-name', '  Sara   Nasser ');
  await page.click('#set-name-save');
  await expect.poll(() => calls.staff_my_settings?.length).toBe(1);
  expect(calls.staff_my_settings![0]).toEqual({ p_name: 'Sara Nasser' });
  await expect(page.locator('#topbar .op-chip-name')).toHaveText('Sara Nasser');
});

test('a picture is added, and shows on the page and in the bar', async ({ page }) => {
  const url = 'https://qpffkzmsfyilicwcsszz.supabase.co/storage/v1/object/public/photos/p/abc.jpg';
  await open(page, { 'rpc:staff_my_settings': { display_name: null, photo: url, nt_off: [] } });
  // a 2x2 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgDADXpBvqGGvb3AAAAAElFTkSuQmCC', 'base64');
  await page.setInputFiles('#set-photo-in', { name: 'me.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => calls.staff_my_settings?.length).toBe(1);
  const sent = calls.staff_my_settings![0];
  expect(sent.p_set_photo).toBe(true);
  expect(String(sent.p_photo)).toMatch(/^(https:\/\/|data:image\/)/);
  await expect(page.locator('#tab-settings .set-avatar img')).toHaveAttribute('src', url);
  await expect(page.locator('#set-photo-rm')).toBeVisible();
});

test('a notification kind is turned off for the account, and the bell follows', async ({ page }) => {
  await open(page, { 'rpc:staff_my_settings': { display_name: null, photo: null, nt_off: ['stock'] } });
  const box = page.locator('#tab-settings .set-tog', { hasText: 'Low stock' }).locator('input');
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect.poll(() => calls.staff_my_settings?.length).toBe(1);
  expect(calls.staff_my_settings![0]).toEqual({ p_nt_off: ['stock'] });
  expect(await page.evaluate('S._ntOff')).toEqual(['stock']);
});

test('the email changes with the current password, and a wrong one is said plainly', async ({ page }) => {
  await open(page, { 'rpc:staff_set_own_email': { __rpcError: { status: 400, code: 'P0001', message: 'BAD_PASSWORD' } } });
  await page.fill('#set-email', 'not-an-email');
  await page.click('#set-email-save');
  await expect(page.locator('#set-email-err')).toHaveText('Enter a valid email address.');
  await page.fill('#set-email', 'Sara.New@micromobility.sa');
  await page.fill('#set-email-pwd', 'wrong');
  await page.click('#set-email-save');
  await expect(page.locator('#set-email-err')).toHaveText('The current password is not right.');
  expect(calls.staff_set_own_email![0]).toEqual({ p_password: 'wrong', p_email: 'sara.new@micromobility.sa' });
});

test('a new password must be strong and typed twice the same', async ({ page }) => {
  await open(page);
  await page.fill('#set-pwd-cur', 'Current1');
  await page.fill('#set-pwd-new', 'short');
  await page.click('#set-pwd-save');
  await expect(page.locator('#set-pwd-err')).not.toBeEmpty();
  await page.fill('#set-pwd-new', 'Longer123');
  await page.fill('#set-pwd-new2', 'Longer124');
  await page.click('#set-pwd-save');
  await expect(page.locator('#set-pwd-err')).toHaveText(/match/i);
});
