import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Asking an applicant for changes (the owner, 2026-09-29): staff pick the fields of a pending
// community application that need changing or adding, get a link that asks for those only and a
// message in the applicant's language; the applicant's page (/?appfix=<token>) shows what they
// sent above an empty box and sends the answers back (20260929100000). All Supabase traffic is stubbed.

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234';
const base = {
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12',
  gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
  customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect',
};
const karim = { ...base, id: 'a1', status: 'pending', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', instagram: 'karim.rides', linkedin: 'karim-mansour-arch' };
const customers = [{ id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', created_at: '2026-01-05T10:00:00Z' }];

async function staff(page: Page, extra: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: [karim], ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
  await expect(page.locator('.ca-row')).toHaveCount(1);
}
const card = (page: Page) => page.locator('.ca-row[data-app-id="a1"]');

// Sent from an account (the form makes it first, 2026-09-30): the name, email, mobile, gender and
// height are the account's, so the link asks only for the rest.
test('an application sent from an account asks only for its own answers, not the account’s', async ({ page }) => {
  await staff(page, { community_applications: [{ ...karim, customer_id: 'c1' }] });
  await card(page).locator('.ca-fix-btn').click();
  const dlg = page.locator('#confirm-modal .ca-fx-box');
  expect(await dlg.locator('[data-ca-fix]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.caFix))).toEqual(['birth_date', 'nationality', 'bike_type', 'profession', 'instagram', 'linkedin']);
});

test('staff pick the fields, get the link and a message in the applicant’s language, and the card says it is waiting', async ({ page }) => {
  await staff(page, { 'rpc:staff_community_ask_changes': { ok: true, token: TOKEN, fields: ['phone', 'instagram'], note: 'We could not find this Instagram account' } });
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/staff_community_ask_changes/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });

  await card(page).locator('.ca-fix-btn').click();
  const dlg = page.locator('#confirm-modal .ca-fx-box');
  await expect(dlg).toContainText('Ask Karim Mansour for changes');
  await expect(dlg.locator('.ca-fx-go')).toBeDisabled(); // nothing picked yet
  await dlg.locator('[data-ca-fix="instagram"]').click();
  await dlg.locator('[data-ca-fix="phone"]').click();
  await expect(dlg.locator('[data-ca-fix="phone"]')).toHaveAttribute('aria-pressed', 'true');
  await dlg.locator('#ca-fx-note').fill('We could not find this Instagram account');
  await expect(dlg.locator('.ca-fx-go')).toHaveText('Create link (2)');
  await dlg.locator('.ca-fx-go').click();

  await expect.poll(() => calls.length).toBe(1);
  // In the page's order, whatever order they were picked in
  expect(calls[0]).toEqual({ p_id: 'a1', p_fields: ['phone', 'instagram'], p_note: 'We could not find this Instagram account', p_by: 'Spec Staff' });
  const msg = page.locator('#confirm-modal .ca-msg-box');
  await expect(msg).toBeVisible();
  const txt = await msg.locator('#ca-msg-text').inputValue();
  expect(txt).toContain('Hi Karim,');
  expect(txt).toContain('please update the following:');
  expect(txt).toContain('• Mobile number\n• Instagram');
  expect(txt).toContain('Note from our team: We could not find this Instagram account');
  expect(txt).toContain(`https://micromobilityrentals.pages.dev/?appfix=${TOKEN}&lang=en`);
  expect(decodeURIComponent((await msg.locator('a.ca-wa').getAttribute('href'))!.split('text=')[1])).toBe(txt);
  await msg.locator('#ca-msg-lang').selectOption('ar');
  const ar = await msg.locator('#ca-msg-text').inputValue();
  expect(ar).toContain('رقم الجوال');
  expect(ar).toContain(`&lang=ar`);
  await msg.locator('.ca-x').click();

  await expect(card(page).locator('.ca-fix-wait')).toContainText('Phone Number, Instagram');
  await expect(card(page).locator('.ca-fix-wait')).toContainText('Waiting for the applicant');
  await expect(card(page).locator('.ca-fix-q')).toContainText('We could not find this Instagram account');
  // The message can be opened again while the applicant has not answered
  await card(page).locator('.ca-fix-msg').click();
  await expect(page.locator('#confirm-modal #ca-msg-text')).toHaveValue(new RegExp(`appfix=${TOKEN}`));
});

test('the card shows what the applicant changed and what it was', async ({ page }) => {
  await staff(page, { community_applications: [{ ...karim, phone: '+966551112222', instagram: 'karim.new',
    fix_token: TOKEN, fix_fields: ['phone', 'instagram'], fix_note: null, fix_asked_at: '2026-09-29T08:00:00Z', fix_asked_by: 'Desk A',
    fix_done_at: '2026-09-29T09:30:00Z', fix_prev: { phone: '+966552468013', instagram: 'karim.rides' } }] });
  const done = card(page).locator('.ca-fix-done');
  await expect(done).toContainText('Updated by the applicant');
  await expect(done).toContainText('was +966552468013');
  await expect(done).toContainText('was @karim.rides');
  await expect(card(page).locator('.ca-fix-msg')).toHaveCount(0);
  await expect(card(page)).toContainText('+966551112222');
});

async function applicant(page: Page, get: unknown, extra: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], 'rpc:list_sessions': [], queue_entries: [], bikes: [], 'rpc:community_fix_get': get, ...extra });
  await page.goto(`/?appfix=${TOKEN}&lang=en`);
  await waitForSb(page);
}
const ASK = { ok: true, first: 'Karim', lang: 'en', fields: ['phone', 'bike_type', 'instagram'], note: 'We could not find this Instagram account',
  values: { phone: '+966552468013', bike_type: 'Road', instagram: 'karim.rides' } };

test('the applicant’s page asks for the requested fields only, checks them, and sends the answers', async ({ page }) => {
  await applicant(page, ASK, { 'rpc:community_fix_submit': { ok: true } });
  const sent: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/community_fix_submit/.test(r.url())) sent.push(JSON.parse(r.postData() || '{}')); });
  const box = page.locator('#app-fix .afx-box');
  await expect(box.locator('#afx-title')).toHaveText('Update your application');
  await expect(box).toContainText('Hi Karim');
  await expect(box.locator('.afx-note')).toContainText('We could not find this Instagram account');
  await expect(box.locator('.fx-item')).toHaveCount(3);
  await expect(box.locator('.fx-item[data-afx="phone"] .fx-was')).toContainText('You sent: +966552468013');
  await expect(box.locator('.fx-item[data-afx="instagram"] .fx-was')).toContainText('@karim.rides');
  await expect(box.locator('.fx-item[data-afx="email"]')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('appfix')).toBe(false); // the token comes off the address bar

  // Empty boxes cannot be sent
  await box.locator('#afx-save').click();
  await expect(box.locator('.fx-item.err')).toHaveCount(3);
  expect(sent.length).toBe(0);

  await box.locator('#afx-phone').fill('0551112222');
  await box.locator('.fx-item[data-afx="bike_type"] .fx-opt', { hasText: 'Hybrid' }).click();
  await box.locator('#afx-instagram').fill('https://instagram.com/karim.new/');
  await box.locator('#afx-save').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ p_token: TOKEN, p: { phone: '+966551112222', bike_type: 'Hybrid', instagram: 'karim.new' } });
  await expect(page.locator('#app-fix [data-afx-state="thanks"]')).toContainText('Your application is updated');
  await page.locator('#app-fix .afx-close').click();
  await expect(page.locator('#app-fix')).toBeHidden();
  expect(await page.evaluate(`sessionStorage.getItem('cq_appfix')`)).toBe(null);
});

test('a field the server refuses is pointed out, and a link that no longer works says so', async ({ page }) => {
  await applicant(page, { ...ASK, fields: ['phone'] }, { 'rpc:community_fix_submit': { ok: false, error: 'phone' } });
  const box = page.locator('#app-fix .afx-box');
  await box.locator('#afx-phone').fill('0551112222');
  await box.locator('#afx-save').click();
  await expect(box.locator('.fx-item[data-afx="phone"] .pg-msg')).toContainText('valid phone number');
});

test('a decided application or a replaced request opens on "This link no longer works"', async ({ page }) => {
  await applicant(page, { ok: false, error: 'gone' });
  await expect(page.locator('#app-fix [data-afx-state="gone"]')).toContainText('This link no longer works');
  await page.locator('#app-fix .afx-close').click();
  await expect(page.locator('#app-fix')).toBeHidden();
});
