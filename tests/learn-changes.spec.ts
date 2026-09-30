import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Asking a learn-to-ride sign-up for changes (the owner, 2026-09-30), as a community applicant is
// asked (application-changes.spec.ts): staff pick the person's fields on a New or Scheduled
// sign-up, get a link (/?learnfix=<token>) and a message in the sign-up's language; the page asks
// for those fields only (20260930190000). All Supabase traffic is stubbed.

const TOKEN = 'b1b2c3d4e5f60718293a4b5c6d7e8f901234';
const customers = [{ id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', created_at: '2026-01-05T10:00:00Z' }];
const base = {
  created_at: '2026-09-27T08:00:00Z', updated_at: '2026-09-27T08:00:00Z', submissions: 1, for_whom: 'self', learner_name: null,
  learner_age: 34, learner_gender: 'female', learner_height: 162, level: 'never', notes: '', lang: 'en',
  lesson_at: null as string | null, lesson_place: null as string | null, decided_at: null as string | null, decided_by: null as string | null,
  customer_id: null as string | null, existing_account: null as boolean | null, account_oauth: null as boolean | null,
  birth_date: '1992-02-02', gender: 'female', nationality: 'Egypt', height: 162, profession: 'Teacher', workplace: null, instagram: null, linkedin: null, ride_news: false,
};
const nadia = { ...base, id: 'l1', status: 'pending', name: 'Nadia Omar', email: 'nadia.omar@gmail.com', phone: '+966552220001' };
const omar = { ...base, id: 'l3', status: 'scheduled', name: 'Omar Farouk', email: 'omar.farouk@gmail.com', phone: '+966553330002', lang: 'ar',
  lesson_at: '2026-10-04T15:00:00Z', lesson_place: 'JCC', decided_at: '2026-09-27T09:00:00Z', decided_by: 'Desk A', customer_id: 'c1', existing_account: true };
const done = { ...base, id: 'l5', status: 'done', name: 'Done Learner', email: 'done.l@gmail.com', phone: '+966554440009' };

async function staff(page: Page, extra: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: [], learn_applications: [nadia, omar, done], ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');setCommTab('learning')`);
  await expect(page.locator('.la-row')).toHaveCount(1);
}
const row = (page: Page, id: string) => page.locator(`.la-row[data-learn-id="${id}"]`);

test('staff ask a new sign-up for changes, get the link and message, and the card says it is waiting', async ({ page }) => {
  await staff(page, { 'rpc:staff_learn_ask_changes': { ok: true, token: TOKEN, fields: ['workplace', 'instagram'], note: 'Where do you work?' } });
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/staff_learn_ask_changes/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });

  await row(page, 'l1').locator('.la-fix-btn').click();
  const dlg = page.locator('#confirm-modal .ca-fx-box');
  await expect(dlg).toContainText('Ask Nadia Omar for changes');
  expect(await dlg.locator('[data-ca-fix]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.caFix)))
    .toEqual(['name', 'email', 'phone', 'birth_date', 'gender', 'nationality', 'height', 'profession', 'workplace', 'instagram', 'linkedin']);
  await dlg.locator('[data-ca-fix="instagram"]').click();
  await dlg.locator('[data-ca-fix="workplace"]').click();
  await dlg.locator('#ca-fx-note').fill('Where do you work?');
  await dlg.locator('.ca-fx-go').click();

  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ p_id: 'l1', p_fields: ['workplace', 'instagram'], p_note: 'Where do you work?', p_by: 'Spec Staff' });
  const msg = page.locator('#confirm-modal .ca-msg-box');
  const txt = await msg.locator('#la-msg-text').inputValue();
  expect(txt).toContain('Hi Nadia,');
  expect(txt).toContain('learn-to-ride lesson');
  expect(txt).toContain('Before your lesson, please update the following on your sign-up:');
  expect(txt).toContain('• Company\n• Instagram');
  expect(txt).toContain('Note from our team: Where do you work?');
  expect(txt).toContain(`https://micromobilityrentals.pages.dev/?learnfix=${TOKEN}&lang=en`);
  expect(txt).not.toContain('Temporary password');
  await msg.locator('#la-msg-lang').selectOption('ar');
  expect(await msg.locator('#la-msg-text').inputValue()).toContain('• الشركة');
  await msg.locator('.ca-x').click();

  await expect(row(page, 'l1').locator('.ca-fix-wait')).toContainText('Company, Instagram');
  await row(page, 'l1').locator('.la-fix-msg').click();
  await expect(page.locator('#confirm-modal #la-msg-text')).toHaveValue(new RegExp(`learnfix=${TOKEN}`));
});

test('a scheduled sign-up can be asked too, its account’s own details left out; a done one cannot', async ({ page }) => {
  await staff(page);
  await page.locator('.filter-pill[data-la-filter="scheduled"]').click();
  await row(page, 'l3').locator('.la-fix-btn').click();
  expect(await page.locator('#confirm-modal .ca-fx-box [data-ca-fix]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.caFix)))
    .toEqual(['birth_date', 'nationality', 'profession', 'workplace', 'instagram', 'linkedin']);
  await page.locator('#confirm-modal .ca-fx-box .chrome-x').click();
  await page.locator('.filter-pill[data-la-filter="done"]').click();
  await expect(row(page, 'l5').locator('.la-fix-btn')).toHaveCount(0);
});

test('the card shows what was changed and what it was', async ({ page }) => {
  await staff(page, { learn_applications: [{ ...nadia, workplace: 'Acme', fix_token: TOKEN, fix_fields: ['workplace'], fix_note: null,
    fix_asked_at: '2026-09-30T08:00:00Z', fix_asked_by: 'Desk A', fix_done_at: '2026-09-30T09:00:00Z', fix_prev: { workplace: '' } }] });
  await expect(row(page, 'l1').locator('.ca-fix-done')).toContainText('Updated by the applicant');
  await expect(row(page, 'l1').locator('.ca-fix-done')).toContainText('Company');
  await expect(row(page, 'l1').locator('.la-fix-msg')).toHaveCount(0);
});

async function applicant(page: Page, get: unknown, extra: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], 'rpc:list_sessions': [], queue_entries: [], bikes: [], 'rpc:learn_fix_get': get, ...extra });
  await page.goto(`/?learnfix=${TOKEN}&lang=en`);
  await waitForSb(page);
}
const ASK = { ok: true, first: 'Nadia', lang: 'en', fields: ['height', 'workplace', 'instagram'], note: null,
  values: { height: 162, workplace: null, instagram: null } };

test('the page asks for the sign-up’s fields only, checks them, and sends them to learn_fix_submit', async ({ page }) => {
  await applicant(page, ASK, { 'rpc:learn_fix_submit': { ok: true } });
  const sent: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/learn_fix_submit/.test(r.url())) sent.push(JSON.parse(r.postData() || '{}')); });
  const box = page.locator('#app-fix .afx-box');
  await expect(box.locator('#afx-title')).toHaveText('Update your sign-up');
  await expect(box).toContainText('before your lesson');
  await expect(box.locator('.fx-item')).toHaveCount(3);
  await expect(box.locator('.fx-item[data-afx="workplace"] .fx-was')).toContainText('You left this empty');
  expect(new URL(page.url()).searchParams.has('learnfix')).toBe(false);
  expect(await page.evaluate(`sessionStorage.getItem('cq_appfix')`)).toBe(`l:${TOKEN}`);

  await box.locator('#afx-height').fill('79');
  await box.locator('#afx-save').click();
  await expect(box.locator('.fx-item.err')).toHaveCount(3);
  await expect(box.locator('.fx-item[data-afx="height"] .pg-msg')).toContainText('between 80 and 250');
  expect(sent.length).toBe(0);

  await box.locator('#afx-height').fill('85');
  await box.locator('#afx-work').fill('  Acme   Riyadh ');
  await box.locator('#afx-instagram').fill('@nadia.rides');
  await box.locator('#afx-save').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ p_token: TOKEN, p: { height: 85, workplace: 'Acme Riyadh', instagram: 'nadia.rides' } });
  await expect(page.locator('#app-fix [data-afx-state="thanks"]')).toContainText('Your sign-up is updated');
  await page.locator('#app-fix .afx-close').click();
  await expect(page.locator('#app-fix')).toBeHidden();
  expect(await page.evaluate(`sessionStorage.getItem('cq_appfix')`)).toBe(null);
});

test('a closed sign-up’s link says so, in the sign-up’s words', async ({ page }) => {
  await applicant(page, { ok: false, error: 'gone' });
  await expect(page.locator('#app-fix [data-afx-state="gone"]')).toContainText('Your sign-up may already be closed');
});
