import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The Account part as a menu and its small pages (the user, 2026-11-10: "do a full rework on the account page"; picked
// a menu whose rows open small pages with their own Save and address, the profile card above the switch, the wallet
// and Invite friends as two tiles, what the profile lacks on its row in amber, Delete my account as the last row, and
// menu and page side by side on a wide screen).

const sessions = [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];
const profile = { id: 'c1', name: 'Sara Khalid', email: 'sara@example.com', phone: '+966500000001', height: 168, birth_date: '1994-03-02', country: 'Saudi Arabia', city: 'Jeddah', nationality: 'Saudi Arabia', gender: 'female', type_preference: 'Hybrid', photo: null };

async function open(page: Page, extra: Record<string, unknown> = {}, path = '/', who: Record<string, unknown> = profile) {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [who], 'rpc:customer_about': [{ profession: 'Architect', workplace: 'Design Co', heard_from: 'instagram' }],
    'rpc:customer_update_profile': true, 'rpc:customer_set_socials': true, 'rpc:customer_set_about': true,
    'rpc:customer_whatsapp': [{ phone: '+966500000001', whatsapp_same: true, whatsapp: null }], 'rpc:customer_set_whatsapp': true,
    'rpc:customer_blood_type': 'B-', 'rpc:customer_set_blood_type': true,
    'rpc:customer_emergency': [{ emergency_name: 'Ali Saleh', emergency_phone: '+966551112222', emergency_relation: 'friend' }],
    'rpc:customer_wallet': { balance: 70, rows: [] },
    'rpc:customer_referral': { ok: true, on: true, code: 'K7MQ2X', days: 60, cap: 10, joined: 0, rode: 0, earned: 0, referred: false, can_enter: false, rewards: [] },
    'rpc:customer_deletion_request': { requested_at: null },
    ...extra,
  });
  await loginCustomer(page, who);
  await page.goto(path);
  await waitForSb(page);
  if (path === '/') await page.evaluate(`setCustTab('account')`);
}
const sent = (page: Page, rpc: string) => {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().includes(`/rpc/${rpc}`)) calls.push(JSON.parse(r.postData() || '{}')); });
  return calls;
};
const at = (page: Page) => new URL(page.url()).pathname;
const row = (page: Page, k: string) => page.locator(`#acc-r-${k}`);

test.describe('@customer:account the account menu and its pages', () => {
  test('the menu: the profile card above the switch, the two tiles, rows with their values, Log out and Delete last', async ({ page }) => {
    await open(page);
    await expect(page.locator('#acc-id')).toContainText('Sara Khalid');
    const card = await page.locator('#acc-id').boundingBox(), sw = await page.locator('#tab-account .acc-views').boundingBox();
    expect(card!.y).toBeLessThan(sw!.y);
    await expect(page.locator('#acc-tv-wallet')).toContainText('70');
    await expect(page.locator('#acc-tv-invite')).toHaveText('K7MQ2X');
    await expect(page.locator('#acc-v-contact')).toHaveText('+966500000001');
    await expect(page.locator('#acc-v-residence')).toHaveText('Jeddah');
    await expect(page.locator('#acc-v-riding')).toHaveText('Hybrid · 168 cm');
    await expect(page.locator('#acc-v-emergency')).toHaveText('Ali Saleh');
    await expect(page.locator('#acc-v-about')).toHaveText('Architect');
    // the photo is the one thing missing: said on its row, in amber, not in a sentence
    await expect(page.locator('#acc-v-personal')).toHaveText('Add profile photo');
    await expect(page.locator('#acc-v-personal')).toHaveClass(/acc-add/);
    const last = page.locator('#tab-account .acc-menu .acc-row:visible').last();
    await expect(last).toHaveId('acc-r-delete');
    await expect(page.locator('#acc-out-btn')).toBeVisible();
    expect(at(page)).toBe('/account');
  });

  test('a row opens its page at its own address; Back returns to the menu', async ({ page, isMobile }) => {
    await open(page);
    await row(page, 'contact').click();
    expect(at(page)).toBe('/account/contact');
    await expect(page.locator('#acc-pg-contact-h')).toHaveText('Contact');
    await expect(page.locator('#acc-email')).toBeVisible();
    await expect(page.locator('#acc-first')).toBeHidden();
    if (isMobile) await expect(page.locator('#tab-account .acc-menu')).toBeHidden();
    await page.goBack();
    expect(at(page)).toBe('/account');
    await expect(page.locator('#acc-r-contact')).toBeVisible();
    await expect(page.locator('#acc-email')).toBeHidden();
    // a link opens a page directly, and the app's Back leads to the menu
    await page.evaluate(`setCustTab('account','riding')`);
    await expect(page.locator('#acc-height')).toBeVisible();
    await page.locator('#cust-back-btn').click();
    expect(at(page)).toBe('/account');
  });

  test('a page saves its own fields only: every other column goes as on file', async ({ page }) => {
    await open(page);
    const saves = sent(page, 'customer_update_profile'), wa = sent(page, 'customer_set_whatsapp');
    await row(page, 'residence').click();
    // a box on another page edited behind the rider's back is not taken along
    await page.evaluate(`document.getElementById('acc-first').value='Typed'`);
    await page.selectOption('#acc-city', { index: 1 });
    const city = await page.locator('#acc-city').inputValue();
    await page.locator('#acc-save-residence').click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ p_name: 'Sara Khalid', p_email: 'sara@example.com', p_city: city, p_country: 'Saudi Arabia', p_height: 168 });
    expect(wa).toHaveLength(0);
    // Contact: the WhatsApp number is a field of the page, saved by its Save
    await page.evaluate(`setCustTab('account','contact')`);
    await page.locator('#acc-wa .fx-opt').nth(1).click();
    await page.fill('#acc-wa-phone', '551234567');
    await page.locator('#acc-save-contact').click();
    await expect.poll(() => wa.length).toBe(1);
    expect(wa[0]).toMatchObject({ p_same: false, p_phone: '+966551234567' });
    expect(saves).toHaveLength(1); // the profile itself was unchanged
  });

  test('an error stays on its page; a page with nothing changed saves nothing', async ({ page }) => {
    await open(page);
    const saves = sent(page, 'customer_update_profile');
    await page.evaluate(`setCustTab('account','riding')`);
    await page.locator('#acc-save-riding').click();
    await expect(page.locator('#toast-container .toast').last()).toContainText('Saved');
    expect(saves).toHaveLength(0);
    await page.fill('#acc-height', '20');
    await page.locator('#acc-save-riding').click();
    await expect(page.locator('#acc-err-riding')).not.toBeEmpty();
    expect(saves).toHaveLength(0);
  });

  test('leaving a page with unsaved edits asks first: Keep editing stays, Discard goes back to the menu', async ({ page }) => {
    await open(page);
    await row(page, 'personal').click();
    await page.fill('#acc-first', 'Noura');
    await page.locator('#cust-back-btn').click();
    const dlg = page.locator('#confirm-modal');
    await expect(dlg).toContainText('Discard your changes?');
    await dlg.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator('#acc-first')).toHaveValue('Noura');
    expect(at(page)).toBe('/account/personal');
    // the browser's Back asks too, and Discard puts the boxes back
    await page.goBack();
    await expect(dlg).toContainText('Discard your changes?');
    await dlg.getByRole('button', { name: 'Discard' }).click();
    await expect.poll(() => at(page)).toBe('/account');
    await row(page, 'personal').click();
    await expect(page.locator('#acc-first')).toHaveValue('Sara');
  });

  test('Delete my account is its own page; a request shows on its row', async ({ page }) => {
    await open(page, { 'rpc:customer_deletion_request': { requested_at: '2099-01-02T10:00:00Z' } });
    await expect(page.locator('#acc-v-delete')).toHaveText('Requested');
    await row(page, 'delete').click();
    expect(at(page)).toBe('/account/delete');
    await expect(page.locator('#acc-del-btn')).toBeVisible();
  });

  test('a wide screen shows the menu and the page side by side, Personal details when none is picked', async ({ page, isMobile }) => {
    test.skip(isMobile, 'wide screens only');
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    await expect(page.locator('#acc-r-contact')).toBeVisible();
    await expect(page.locator('#acc-first')).toBeVisible();
    await row(page, 'contact').click();
    await expect(page.locator('#acc-email')).toBeVisible();
    await expect(page.locator('#acc-r-personal')).toBeVisible();
    await expect(page.locator('#acc-r-contact')).toHaveAttribute('aria-current', 'page');
  });

  test('Arabic: the rows mirror and say their values in Arabic', async ({ page }) => {
    await open(page, {}, '/account?lang=ar');
    await expect(page.locator('#acc-r-personal .acc-row-t')).toHaveText('البيانات الشخصية');
    await expect(page.locator('#acc-v-personal')).toHaveText('أضف صورة الملف');
  });
});
