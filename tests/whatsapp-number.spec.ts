import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// WhatsApp number (the owner, 2026-10-07): every community member is asked whether their mobile is their
// WhatsApp number too - Yes / No, and on No a WhatsApp number box with the mobile's country codes. The server
// asks it (_customer_asks, 20261007200000), staff can flag it, and the desk's WhatsApp links use the answer.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }];

async function rider(page: Page, held: Record<string, unknown> = { phone: '0500000001', whatsapp_same: null, whatsapp: null }) {
  await stubSupabase(page, {
    sessions, queue_entries: [], 'rpc:my_bookings': [],
    'rpc:customer_whatsapp': [held],
    'rpc:customer_fix_fields': ['whatsapp'],
    'rpc:customer_fix_save': [],
  });
  await loginCustomer(page, { id: 'c1', phone: '0500000001' });
  await page.goto('/');
  await waitForSb(page);
}
function saves(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (/rpc\/customer_fix_save/.test(r.url())) bodies.push(JSON.parse(r.postData() || '{}')); });
  return bodies;
}

test.describe('@customer:fix WhatsApp number', () => {
  test('Yes: the mobile is their WhatsApp too', async ({ page }) => {
    await rider(page);
    const sent = saves(page);
    await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
    const it = page.locator('#fix-gate .fx-item[data-fx="whatsapp"]');
    await expect(it).toBeVisible();
    // the server asked it on its own: the account's check-up, not "our team noticed"
    await expect(page.locator('#fx-title')).toHaveText('A few details for your account');
    await expect(it.locator('.fx-q')).toHaveText('Is 0500000001 your WhatsApp number too?');
    await expect(page.locator('#fx-wa-phone')).toHaveCount(0);
    // nothing picked: asked to pick, nothing sent
    await page.click('#fx-save');
    await expect(it).toHaveClass(/err/);
    expect(sent).toHaveLength(0);
    await it.locator('.fx-opt', { hasText: 'Yes' }).click();
    await expect(it.locator('.fx-opt.on')).toHaveText('Yes');
    await page.click('#fx-save');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_values).toEqual({ whatsapp: { same: true } });
    await expect(page.locator('#fix-gate .fx-box')).toHaveCount(0);
  });

  test('No: a WhatsApp number box with the country codes, checked like the mobile', async ({ page }) => {
    await rider(page);
    const sent = saves(page);
    await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
    const it = page.locator('#fix-gate .fx-item[data-fx="whatsapp"]');
    await it.locator('.fx-opt', { hasText: 'No' }).click();
    await expect(page.locator('#fx-wa-phone')).toBeVisible();
    await expect(page.locator('#fx-wa-phone')).toBeFocused();
    await expect(page.locator('#fx-wa-cc')).toHaveValue('+966');
    expect(await page.locator('#fx-wa-cc option').count()).toBeGreaterThan(100); // the mobile's own list
    await page.click('#fx-save');
    await expect(it.locator('.pg-msg')).toHaveText('Enter your WhatsApp number.');
    expect(sent).toHaveLength(0);
    await page.selectOption('#fx-wa-cc', '+971');
    await page.fill('#fx-wa-phone', '050 123 4567');
    await page.click('#fx-save');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_values).toEqual({ whatsapp: { same: false, phone: '+971501234567' } });
  });

  test('a staff flag on an answered one reads as a correction and shows what is on file', async ({ page }) => {
    await rider(page, { phone: '0500000001', whatsapp_same: false, whatsapp: '+971501234567' });
    await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
    const it = page.locator('#fix-gate .fx-item[data-fx="whatsapp"]');
    await expect(it.locator('.fx-was')).toHaveText('On your account: +971501234567');
    await expect(page.locator('#fx-title')).toHaveText('Let’s get your details right');
    // in Arabic too
    await page.evaluate(`setLang('ar')`);
    await expect(it.locator('.fx-lbl')).toHaveText('رقم WhatsApp');
  });
});

test.describe('@staff:community WhatsApp number', () => {
  test('staff flag it, read the answer in the history, and the application card uses it', async ({ page }) => {
    const customers = [
      { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', whatsapp_same: false, whatsapp: '+971501234567', created_at: '2026-01-01T00:00:00Z' },
      { id: 'c2', name: 'Nora Saleh', email: 'nora@example.com', phone: '+966500000002', whatsapp_same: true, whatsapp: null, created_at: '2026-01-02T00:00:00Z' },
    ];
    const app = { id: 'a1', status: 'pending', name: 'Karim Mansour', email: 'karim@example.com', phone: '+966552468013', whatsapp_same: false,
      whatsapp: '+201001234567', created_at: '2026-10-07T08:00:00Z', updated_at: '2026-10-07T08:00:00Z', submissions: 1, height: 178,
      birth_date: '1994-03-12', gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, instagram: '', linkedin: '',
      profession: 'Architect', customer_id: null, existing_account: null, account_oauth: null };
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: [app],
      customer_flags: [{ id: 'f1', customer_id: 'c2', fields: ['whatsapp'], status: 'answered', flagged_at: '2026-10-07T09:00:00Z',
        answered_at: '2026-10-07T10:00:00Z', flagged_by: 'Desk', changes: {
          whatsapp: { before: { same: true, phone: '+966500000002' }, after: { same: false, phone: '+966551234567' }, at: '2026-10-07T10:00:00Z' } } }],
      'rpc:staff_flag_customer': { id: 1, customer_id: 'c1', fields: ['whatsapp'], status: 'pending' } });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');

    const calls: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/staff_flag_customer/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });
    await page.evaluate(`showFlagFieldsModal('c1')`);
    const dlg = page.locator('#confirm-modal .fl-box');
    await expect(dlg.locator('.fl-row[data-flag="whatsapp"]')).toContainText('+971501234567');
    await dlg.locator('.fl-row[data-flag="whatsapp"]').click();
    await dlg.locator('#fl-send').click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_customer_id: 'c1', p_fields: ['whatsapp'] });
    await page.evaluate(`closeConfirm&&closeConfirm()`).catch(() => {});

    await page.evaluate(`setStaffTab('community');S.communityTab='flagged';renderCommunity()`);
    const ch = page.locator('.flg-row[data-flag-id="f1"] .flg-change[data-field="whatsapp"]');
    await expect(ch).toContainText('+966500000002 · Same as mobile');
    await expect(ch).toContainText('+966551234567');

    await page.evaluate(`S.communityTab='applications';renderCommunity()`);
    const card = page.locator('.ca-row[data-app-id="a1"]');
    await expect(card.locator('.ca-kv', { hasText: 'WhatsApp number' }).locator('b')).toHaveText('+201001234567');
    await expect(card.locator('a.ca-chat')).toHaveAttribute('href', 'https://wa.me/201001234567');
    await expect(card.locator('a.ca-call')).toHaveAttribute('href', 'tel:+966552468013');
  });
});
