import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Every field of an account can be flagged (the owner, 2026-10-06: "when flagging a customer make the staff be able
// to flag every single field"): besides the ten there were, the bike type, profession, company, how they heard of
// us, each social handle and the emergency contact. The rider answers each on the correction page, the optional
// ones with "I don't have one" too, and customer_fix_save takes them (20261006021500).

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }];
// The second emergency contact too (20261007150000): the dialog offers it once the database is known to have it, and the
// stub answers the dialog's probe as a database that has (tests/second-emergency-staff.spec.ts covers one that has not).
const ALL = ['name', 'email', 'phone', 'whatsapp', 'birth_date', 'gender', 'nationality', 'country', 'city', 'height', 'photo',
  'type_preference', 'profession', 'workplace', 'heard_from', 'instagram', 'x', 'tiktok', 'linkedin', 'emergency', 'emergency2'];

test.describe('@staff:community flag every field', () => {
  test('the dialog lists every field the account holds, with what it holds, and asks for the new ones', async ({ page }) => {
    const customers = [{ id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', profession: 'Enginer', workplace: 'Acme',
      heard_from: 'friend', socials: { instagram: 'old.handle', x: 'oldx' }, type_preference: 'Road', created_at: '2026-01-01T00:00:00Z' }];
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, customer_flags: [], tags: [], customer_tags: [],
      'rpc:staff_flag_customer': { id: 1, customer_id: 'c1', fields: ['profession'], status: 'pending' } });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
    const calls: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/staff_flag_customer/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });
    await page.evaluate(`showFlagFieldsModal('c1')`);
    const dlg = page.locator('#confirm-modal .fl-box');
    expect(await dlg.locator('.fl-row').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.flag))).toEqual(ALL);
    // each row says what the account holds
    await expect(dlg.locator('.fl-row[data-flag="profession"]')).toContainText('Enginer');
    await expect(dlg.locator('.fl-row[data-flag="workplace"]')).toContainText('Acme');
    await expect(dlg.locator('.fl-row[data-flag="instagram"]')).toContainText('@old.handle');
    await expect(dlg.locator('.fl-row[data-flag="x"]')).toContainText('@oldx');
    await expect(dlg.locator('.fl-row[data-flag="heard_from"]')).toContainText(await page.evaluate(`heardLabel('friend')`) as string);
    await expect(dlg.locator('.fl-row[data-flag="type_preference"]')).toContainText(await page.evaluate(`typeLabel('Road')`) as string);
    for (const k of ['emergency', 'instagram', 'profession']) await dlg.locator(`.fl-row[data-flag="${k}"]`).click();
    await dlg.locator('#fl-send').click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_customer_id: 'c1', p_fields: ['profession', 'instagram', 'emergency'] }); // in the account's order
  });

  test('the Flagged list reads a handle and an emergency contact from the history', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags: [], customer_tags: [],
      customers: [{ id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', created_at: '2026-01-01T00:00:00Z' }],
      customer_flags: [{ id: 'f1', customer_id: 'c1', fields: ['instagram', 'emergency'], status: 'answered', flagged_at: '2026-10-05T09:00:00Z',
        answered_at: '2026-10-05T10:00:00Z', flagged_by: 'Desk', changes: {
          instagram: { before: 'old.handle', after: 'new.handle', at: '2026-10-05T10:00:00Z' },
          emergency: { before: null, after: { name: 'Nora Haddad', phone: '+966551234567', relation: 'sibling' }, at: '2026-10-05T10:00:00Z' } } }] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
    await page.evaluate(`setStaffTab('customers');S.customersTab='flagged';renderCustomers()`);
    const row = page.locator('.flg-row[data-flag-id="f1"]');
    await expect(row.locator('.flg-change[data-field="instagram"]')).toContainText('@old.handle');
    await expect(row.locator('.flg-change[data-field="instagram"]')).toContainText('@new.handle');
    await expect(row.locator('.flg-change[data-field="emergency"]')).toContainText('Nora Haddad');
    await expect(row.locator('.flg-change[data-field="emergency"]')).toContainText('Brother or sister');
  });
});

test.describe('@customer:fix the rider answers every kind of field', () => {
  async function rider(page: Page, flags: string[]) {
    await stubSupabase(page, {
      sessions, queue_entries: [], 'rpc:my_bookings': [],
      'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', type_preference: 'Road', socials: { instagram: 'old.handle' } }],
      'rpc:customer_about': [{ profession: 'Enginer', workplace: 'Acme', heard_from: 'friend', sign_in: 'password' }],
      'rpc:customer_emergency': [{ emergency_name: 'Ali Saleh', emergency_phone: '+966551112222', emergency_relation: 'friend' }],
      'rpc:customer_fix_fields': flags,
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

  test('the boxes, what the account holds, the checks, and what goes to customer_fix_save', async ({ page }) => {
    await rider(page, ['type_preference', 'profession', 'workplace', 'heard_from', 'instagram', 'emergency']);
    const sent = saves(page);
    await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
    await expect(page.locator('#fix-gate .fx-box')).toBeVisible();
    await expect(page.locator('#fix-gate .fx-item')).toHaveCount(6);
    // what the account holds, read for these fields; every box starts empty
    await expect(page.locator('.fx-item[data-fx="profession"] .fx-was')).toHaveText('On your account: Enginer');
    await expect(page.locator('.fx-item[data-fx="workplace"] .fx-was')).toHaveText('On your account: Acme');
    await expect(page.locator('.fx-item[data-fx="instagram"] .fx-was')).toContainText('@old.handle');
    await expect(page.locator('.fx-item[data-fx="emergency"] .fx-was')).toContainText('Ali Saleh');
    await expect(page.locator('.fx-item[data-fx="type_preference"] .fx-was')).toContainText(await page.evaluate(`typeLabel('Road')`) as string);
    await expect(page.locator('#fx-profession')).toHaveValue('');
    await expect(page.locator('#fx-soc-instagram')).toHaveValue('');
    // the optional ones offer "I don't have one", the others do not
    await expect(page.locator('#fix-gate .fx-none')).toHaveCount(4);

    // nothing answered: every item says so, nothing is sent
    await page.click('#fx-save');
    await expect(page.locator('#fix-gate .fx-item.err')).toHaveCount(6);
    expect(sent).toHaveLength(0);

    await page.selectOption('#fx-type', 'Hybrid');
    await page.fill('#fx-profession', '  Civil   engineer ');
    await page.locator('.fx-item[data-fx="workplace"] .fx-none').click();
    await expect(page.locator('#fx-workplace')).toBeDisabled();
    await page.selectOption('#fx-heard', 'instagram');
    await page.fill('#fx-soc-instagram', 'https://www.instagram.com/new.handle/');
    await page.fill('#fx-em-name', 'Nora Haddad');
    await page.fill('#fx-em-phone', '0500000001'); // the rider's own number
    await page.selectOption('#fx-em-rel', 'sibling');
    await page.click('#fx-save');
    await expect(page.locator('.fx-item[data-fx="emergency"] .pg-msg')).toContainText('can’t be your own');
    expect(sent).toHaveLength(0);
    // the page moves the focus to the refused item 80 ms after the save (_fixFocusErr): typing before that, a slow
    // machine sent the number into the name box
    await expect(page.locator('#fx-em-name')).toBeFocused();
    await page.fill('#fx-em-phone', '0551234567');
    await page.click('#fx-save');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_values).toEqual({
      type_preference: 'Hybrid', profession: 'Civil engineer', heard_from: 'instagram', instagram: 'new.handle',
      emergency: { name: 'Nora Haddad', phone: '+966551234567', relation: 'sibling' }, none: ['workplace'],
    });
    await expect(page.locator('#fix-gate .fx-box')).toHaveCount(0);
  });

  test('a handle that is not one, and "I don\'t have one" for a handle and the emergency contact', async ({ page }) => {
    await rider(page, ['x', 'linkedin', 'emergency']);
    const sent = saves(page);
    await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
    await page.fill('#fx-soc-x', 'not a handle!');
    await page.locator('.fx-item[data-fx="linkedin"] .fx-none').click();
    await page.locator('.fx-item[data-fx="emergency"] .fx-none').click();
    await page.click('#fx-save');
    await expect(page.locator('.fx-item[data-fx="x"] .pg-msg')).toContainText('Check the');
    expect(sent).toHaveLength(0);
    await page.fill('#fx-soc-x', '@good_x');
    await page.click('#fx-save');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_values).toEqual({ x: 'good_x', none: ['linkedin', 'emergency'] });
  });
});
