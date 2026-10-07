import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-07: "make the system give a notification and big box in the community page that
// someone of a nationality we dont have appeared in the customers area". A customer whose nationality
// no community member has: a line in the bell, and a big box on the Community section until Got it.
const day = 86400000;
const T0 = Date.now();
const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#00e585', locked: true }];
const cust = (id: string, name: string, nationality: string, created = '2026-08-20T10:00:00Z') =>
  ({ id, name, email: `${id}@example.test`, nationality, gender: 'male', created_at: created });
const people = [
  cust('k1', 'Ali Saudi', 'Saudi Arabia'),   // a member
  cust('k2', 'Badr Saudi', 'Saudi Arabia'),  // a customer, but the community has Saudis
  cust('k6', 'Farah India', 'India', '2026-09-01T10:00:00Z'),
  cust('k7', 'Ghazi Jordan', 'Jordan'),       // his Community tag has lapsed: Jordan is not in the community
  cust('k8', 'Hana Blank', ''),               // no nationality: never news
];
const live = (customer_id: string) => ({ customer_id, tag_id: 'tag_saturday', added_at: T0 - 30 * day, expires_at: null, starts_at: null });
const customer_tags = [live('k1'), { customer_id: 'k7', tag_id: 'tag_saturday', added_at: T0 - 400 * day, expires_at: T0 - 10 * day, starts_at: null }];

async function open(page: import('@playwright/test').Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: people, tags, customer_tags });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getCustomers().length===${people.length}`);
  // the rider lists count as whole only under staff sign-in, which the specs do not have
  await page.evaluate(`localStorage.removeItem('cq_natnew_ok');_listOk.riders=true;setStaffTab('community');S.communityTab='overview';renderCommunity()`);
}

test('the community section opens on a big box naming them, newest first', async ({ page }) => {
  await open(page);
  const box = page.locator('#tab-community .natnew-box');
  await expect(box).toBeVisible();
  await expect(box.locator('h3')).toHaveText('2 new nationalities in Customers');
  await expect(box.locator('.natnew-row')).toHaveCount(2);
  await expect(box.locator('.natnew-row').first()).toContainText('Farah India');
  await expect(box).toContainText('Ghazi Jordan');
  await expect(box).not.toContainText('Badr Saudi');
  await expect(box).not.toContainText('Hana Blank');
  // on the other Community views too, and never on Customers
  await page.evaluate(`setCommTab('tags')`);
  await expect(page.locator('#tab-community .natnew-box')).toBeVisible();
  await page.evaluate(`setStaffTab('customers')`);
  await expect(page.locator('.natnew-box')).toHaveCount(0);
});

test('Got it puts the box away until another such customer appears', async ({ page }) => {
  await open(page);
  await page.locator('#tab-community .natnew-box').getByRole('button', { name: 'Got it' }).click();
  await expect(page.locator('#tab-community .natnew-box')).toHaveCount(0);
  await page.evaluate(`S.customers=[...S.customers,{id:'k9',name:'Ivo Brazil',email:'k9@example.test',nationality:'Brazil',created_at:new Date().toISOString()}];renderCommunity()`);
  const box = page.locator('#tab-community .natnew-box');
  await expect(box.locator('h3')).toHaveText('A new nationality in Customers');
  await expect(box.locator('.natnew-row')).toHaveCount(1);
  await expect(box).toContainText('Ivo Brazil');
});

test('a member from that nationality joining takes its customers off the list', async ({ page }) => {
  await open(page);
  await page.evaluate(`S.customerTags=[...S.customerTags,{customer_id:'k6',tag_id:'tag_saturday',added_at:Date.now(),expires_at:null,starts_at:null}];renderCommunity()`);
  const box = page.locator('#tab-community .natnew-box');
  await expect(box.locator('.natnew-row')).toHaveCount(1);
  await expect(box).not.toContainText('Farah India');
});

test('the bell has a kind for it, with a line per customer', async ({ page }) => {
  await open(page);
  const k = await page.evaluate(`(()=>{const x=_ntKindsNow().find(r=>r.k==='natnew');return x&&{ids:x.ids,txt:x.items.map(i=>i.txt),ready:x.ready};})()`) as { ids: string[]; txt: string[]; ready: boolean } | null;
  expect(k).not.toBeNull();
  expect(k!.ids.sort()).toEqual(['k6', 'k7']);
  expect(k!.ready).toBe(true);
  expect(k!.txt.find((x) => x.startsWith('Farah India'))).toContain('India');
  expect(await page.evaluate(`NT_KINDS.some(r=>r[0]==='natnew')`)).toBe(true); // can be turned off on Settings
});
