import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// My Account carries every question the community form asks (the owner, 2026-09-29): besides the
// name, contacts, height, birth date, nationality, handles and bike type it already had, the
// gender, profession, workplace and how they heard of us. An approved application or a
// learn-to-ride sign-up fills them on the server; customer_about reads them, customer_set_about
// saves them (20260929110000). The workplace, labelled Company (the owner, 2026-09-29), is also on the
// staff application cards.

const sessions = [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];
const profile = { id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', gender: 'male', nationality: 'Egypt', socials: null };

async function account(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [profile],
    'rpc:customer_update_profile': true, 'rpc:customer_set_socials': true, 'rpc:customer_set_about': true,
    ...extra,
  });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
}
const sent = (page: Page, rpc: string) => {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().includes(`/rpc/${rpc}`)) calls.push(JSON.parse(r.postData() || '{}')); });
  return calls;
};

test('the account page shows what the application filled in and saves a change through customer_set_about', async ({ page }) => {
  await account(page, { 'rpc:customer_about': [{ profession: 'Architect', workplace: 'Saudi Aramco', heard_from: 'friend' }] });
  await expect(page.locator('#acc-profession')).toHaveValue('Architect');
  await expect(page.locator('#acc-workplace')).toHaveValue('Saudi Aramco');
  await expect(page.locator('#acc-heard')).toHaveValue('friend');
  await expect(page.locator('#agn-male')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#agn-female')).toHaveAttribute('aria-pressed', 'false');
  // every answer of the form's list, in the page's language
  expect(await page.locator('#acc-heard option').count()).toBe(18);

  const calls = sent(page, 'customer_set_about'), saves = sent(page, 'customer_update_profile');
  // nothing changed: the profile is saved, the rest is not sent
  await page.evaluate(`saveAccount()`);
  await expect.poll(() => saves.length).toBe(1);
  await expect.poll(() => page.evaluate(`!!document.getElementById('acc-profession')`)).toBe(true);
  expect(calls).toHaveLength(0);

  await page.fill('#acc-workplace', '  King   Abdulaziz University ');
  await page.click('#agn-female');
  await expect(page.locator('#agn-female')).toHaveAttribute('aria-pressed', 'true');
  await page.selectOption('#acc-heard', 'instagram');
  await page.evaluate(`saveAccount()`);
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_profession: 'Architect', p_workplace: 'King Abdulaziz University', p_heard_from: 'instagram', p_gender: 'female' });
  expect(await page.evaluate(`[S.loggedIn.workplace,S.loggedIn.gender,S.loggedIn.heard_from]`)).toEqual(['King Abdulaziz University', 'female', 'instagram']);
});

test('an account the desk made keeps its "desk" answer until the rider picks one, and a box can be cleared', async ({ page }) => {
  await account(page, { 'rpc:customer_about': [{ profession: 'Nurse', workplace: null, heard_from: 'desk' }] });
  await expect(page.locator('#acc-heard')).toHaveValue('');
  const calls = sent(page, 'customer_set_about');
  await page.fill('#acc-profession', '');
  await page.fill('#acc-workplace', 'KFSH');
  await page.evaluate(`saveAccount()`);
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ p_profession: null, p_workplace: 'KFSH', p_heard_from: null, p_gender: 'male' });
  expect(await page.evaluate(`S.loggedIn.heard_from`)).toBe('desk');
});

test('a workplace or profession the forms would refuse is refused before anything is sent', async ({ page }) => {
  await account(page, { 'rpc:customer_about': [{ profession: null, workplace: null, heard_from: null }] });
  const calls: string[] = [];
  page.on('request', (r) => { if (/rpc\/customer_(update_profile|set_about)/.test(r.url())) calls.push(r.url()); });
  await page.fill('#acc-workplace', 'x');
  await page.evaluate(`saveAccount()`);
  await expect(page.locator('#acc-err')).toHaveText('Enter your company: 2 to 120 characters.');
  await page.fill('#acc-workplace', 'Almarai');
  await page.fill('#acc-profession', '<b>');
  await page.evaluate(`saveAccount()`);
  await expect(page.locator('#acc-err')).toHaveText('Enter your profession: 2 to 80 characters.');
  expect(calls).toHaveLength(0);
});

test('the server refusing a workplace says so on the form', async ({ page }) => {
  await account(page, {
    'rpc:customer_about': [{ profession: 'Pilot', workplace: null, heard_from: null }],
    'rpc:customer_set_about': { __rpcError: { status: 400, code: '22023', message: 'BAD_INPUT', details: 'workplace' } },
  });
  await page.fill('#acc-workplace', 'Saudia');
  await page.evaluate(`saveAccount()`);
  await expect(page.locator('#acc-err')).toHaveText('Enter your company: 2 to 120 characters.');
});

test('before the database has customer_about the page keeps its old form', async ({ page }) => {
  await account(page, { 'rpc:customer_about': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_about' } } });
  await expect(page.locator('#acc-nationality')).toBeVisible();
  await expect(page.locator('#acc-profession, #acc-workplace, #acc-heard, #agn-male')).toHaveCount(0);
  const calls = sent(page, 'customer_update_profile');
  await page.fill('#acc-height', '181');
  await page.evaluate(`saveAccount()`);
  await expect.poll(() => calls.length).toBe(1);
});

test('the application cards show the workplace', async ({ page }) => {
  const app = {
    created_at: '2026-09-29T08:00:00Z', updated_at: '2026-09-29T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12',
    gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
    customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect', workplace: 'Saudi Aramco',
    id: 'a1', status: 'pending', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', instagram: '', linkedin: '',
  };
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [{ id: 'c9', name: 'Other Rider', email: 'o@example.com', created_at: '2026-01-01T00:00:00Z' }], tags: [], customer_tags: [], community_applications: [app] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
  const card = page.locator('.ca-row[data-app-id="a1"]');
  await expect(card).toContainText('Company');
  await expect(card).toContainText('Saudi Aramco');
});
