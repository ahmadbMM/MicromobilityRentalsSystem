import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Social accounts on the profile: Instagram, X, TikTok, LinkedIn. Optional, never asked at
// signup, seen by staff only. Whatever gets pasted is reduced to the bare handle.

const sessions = [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];

test('My Account shows saved handles, cleans pasted URLs, and saves through the RPC', async ({ page }) => {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', nationality: null, socials: { instagram: 'malik.r' } }],
    'rpc:customer_update_profile': true, 'rpc:customer_set_socials': true,
  });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-soc-instagram')).toHaveValue('malik.r');

  const calls: string[] = [];
  page.on('request', r => { if (/rpc\/customer_set_socials/.test(r.url())) calls.push(r.postData() || ''); });
  await page.fill('#acc-soc-x', 'https://x.com/MalikR/?s=20');
  await page.fill('#acc-soc-tiktok', '@malik.rides');
  await page.fill('#acc-soc-linkedin', 'https://www.linkedin.com/in/malik-r/');
  await page.evaluate(`saveAccount()`);
  await expect.poll(() => calls.length).toBe(1);
  expect(JSON.parse(calls[0]).p_socials).toEqual({ instagram: 'malik.r', x: 'MalikR', tiktok: 'malik.rides', linkedin: 'malik-r' });
  expect(await page.evaluate(`S.loggedIn.socials`)).toEqual({ instagram: 'malik.r', x: 'MalikR', tiktok: 'malik.rides', linkedin: 'malik-r' });
});

test('a handle that cannot be right is refused before anything is sent', async ({ page }) => {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [{ id: 'c1', nationality: null, socials: null }],
    'rpc:customer_update_profile': true, 'rpc:customer_set_socials': true,
  });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  const calls: string[] = [];
  page.on('request', r => { if (/rpc\/customer_(set_socials|update_profile)/.test(r.url())) calls.push(r.url()); });
  await page.fill('#acc-soc-instagram', 'bad handle!');
  await page.evaluate(`saveAccount()`);
  await expect(page.locator('#tab-account')).toContainText('Check the Instagram handle');
  expect(calls).toHaveLength(0);
});

test('the signup form never asks for social accounts', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [] });
  await page.goto('/');
  await waitForSb(page);
  expect(await page.evaluate(`document.querySelectorAll('#auth-modal [id*="-soc-"]').length`)).toBe(0);
});

test('staff see the icons on the Community row, edit them on the form, and report on them', async ({ page }) => {
  const customers = [
    { id: 'c1', name: 'Amal Member', email: 'amal@example.test', phone: '+966500000001', gender: 'female', socials: { instagram: 'amal.rides', linkedin: 'amal-m' }, created_at: '2026-08-20T10:00:00Z' },
    { id: 'c2', name: 'Bader Lapsed', email: 'bader@example.test', phone: '+966500000002', gender: 'male', socials: null, created_at: '2025-01-05T10:00:00Z' },
  ];
  await stubSupabase(page, { customers, tags: [], customer_tags: [], sessions, queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0');
  await page.evaluate(`localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null;setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);

  const links = page.locator('.am-cust').filter({ hasText: 'Amal Member' }).locator('.soc-link');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', 'https://www.instagram.com/amal.rides');
  await expect(links.nth(1)).toHaveAttribute('href', 'https://www.linkedin.com/in/amal-m');
  await expect(links.first()).toHaveText('@amal.rides');                 // the username is the link
  await expect(links.nth(1)).toHaveText('amal-m');
  await expect(page.locator('.am-cust').filter({ hasText: 'Bader Lapsed' }).locator('.soc-link')).toHaveCount(0);

  // the on-screen report links a handle too
  await page.evaluate(`_accOpts().cols.instagram=1`);
  expect(await page.evaluate(`_accReportHtml()`)).toContain('<a href="https://www.instagram.com/amal.rides"');

  const cells = await page.evaluate(`_accRows().map(r=>[r.c.id,r.cells.instagram+'|'+r.cells.linkedin])`) as [string, string][];
  expect(Object.fromEntries(cells)).toEqual({ c1: 'amal.rides|amal-m', c2: '|' });

  const patches: string[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && /customers/.test(r.url())) patches.push(r.postData() || ''); });
  // the form: an Open link beside a filled handle, appearing as one is typed
  await page.evaluate(`showEditCustomerModal('c1')`);
  await expect(page.locator('#cf-soc-instagram-open')).toHaveAttribute('href', 'https://www.instagram.com/amal.rides');
  await expect(page.locator('#cf-soc-x-open')).toBeHidden();
  await page.evaluate(`showEditCustomerModal('c2')`);
  await page.fill('#cf-soc-x', '@bader_l');
  await expect(page.locator('#cf-soc-x-open')).toBeVisible();
  await expect(page.locator('#cf-soc-x-open')).toHaveAttribute('href', 'https://x.com/bader_l');
  await page.evaluate(`saveCustForm()`);
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  expect(JSON.parse(patches[0]).socials).toEqual({ x: 'bader_l' });
});
