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

test('Got it folds the box to a bar until another such customer appears', async ({ page }) => {
  await open(page);
  await page.locator('#tab-community .natnew-box').getByRole('button', { name: 'Got it' }).click();
  await expect(page.locator('#tab-community .natnew-box.natnew-min')).toBeVisible();
  await expect(page.locator('#tab-community .natnew-row')).toHaveCount(0);
  await page.evaluate(`S.customers=[...S.customers,{id:'k9',name:'Ivo Brazil',email:'k9@example.test',nationality:'Brazil',created_at:new Date().toISOString()}];renderCommunity()`);
  const box = page.locator('#tab-community .natnew-box');
  await expect(box.locator('h3')).toHaveText('A new nationality in Customers');
  await expect(box.locator('.natnew-row')).toHaveCount(1);
  await expect(box).toContainText('Ivo Brazil');
});

// The owner, 2026-10-09: "i want the unique nationalities box to be accessible not one i click the got it
// button it vanishes".
test('after Got it, Show list opens everyone again and Hide list folds it', async ({ page }) => {
  await open(page);
  await page.locator('#tab-community .natnew-box').getByRole('button', { name: 'Got it' }).click();
  const bar = page.locator('#tab-community .natnew-box.natnew-min');
  await expect(bar.locator('h3')).toHaveText('Nationalities no community member has yet');
  await bar.getByRole('button', { name: 'Show list (2)' }).click();
  const box = page.locator('#tab-community .natnew-box');
  await expect(box).not.toHaveClass(/natnew-min/);
  await expect(box.locator('.natnew-row')).toHaveCount(2);
  await expect(box.getByRole('button', { name: 'Got it' })).toHaveCount(0);
  await box.locator('#natnew-q').fill('jordan');
  await expect(box.locator('.natnew-row')).toHaveCount(1);
  await page.evaluate(`setCommTab('tags')`); // stays open across Community views
  await expect(page.locator('#tab-community .natnew-row')).toHaveCount(1);
  await page.locator('#tab-community .natnew-box').getByRole('button', { name: 'Hide list' }).click();
  await expect(page.locator('#tab-community .natnew-box.natnew-min')).toBeVisible();
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

// The owner, 2026-10-09: "add filters and search bar and sorting and customizability" to the box.
test('the box can be searched, filtered, sorted and laid out', async ({ page }) => {
  await open(page);
  await page.evaluate(`localStorage.removeItem('cq_natnew_view');S._nn=null;S.customers=[...S.customers,
    {id:'k10',name:'Zara Brazil',email:'zara@example.test',phone:'+966500000010',nationality:'Brazil',gender:'female',created_at:new Date(Date.now()-2*864e5).toISOString()},
    {id:'k11',name:'Amir Brazil',email:'amir@example.test',nationality:'Brazil',gender:'male',created_at:'2026-07-01T10:00:00Z'}];renderCommunity()`);
  const box = page.locator('#tab-community .natnew-box');
  const names = () => box.locator('.natnew-row .natnew-name').allTextContents();
  await expect(box.locator('.natnew-row')).toHaveCount(4);
  await expect(box.locator('.natnew-count')).toHaveText('4 of 4 customers');
  // search keeps its caret through the repaint
  await box.locator('#natnew-q').fill('jordan');
  await expect(box.locator('.natnew-row')).toHaveCount(1);
  await expect(box.locator('#natnew-q')).toBeFocused();
  await expect(box.locator('#natnew-reset')).toBeVisible();
  await box.locator('#natnew-q').fill('');
  // nationality, gender and joined filters
  await box.locator('#natnew-nat').selectOption('Brazil');
  await expect.poll(names).toEqual(['Zara Brazil', 'Amir Brazil']);
  await box.locator('#natnew-gender').selectOption('female');
  await expect.poll(names).toEqual(['Zara Brazil']);
  await box.locator('#natnew-gender').selectOption('');
  await box.locator('#natnew-since').selectOption('7');
  await expect.poll(names).toEqual(['Zara Brazil']);
  await box.locator('#natnew-reset').click();
  await expect(box.locator('.natnew-row')).toHaveCount(4);
  await expect(box.locator('#natnew-nat')).toHaveValue('');
  // sorting
  await box.locator('#natnew-sort').selectOption('name');
  await expect.poll(names).toEqual(['Amir Brazil', 'Farah India', 'Ghazi Jordan', 'Zara Brazil']);
  await box.locator('#natnew-sort').selectOption('big');
  await expect.poll(async () => (await names()).slice(0, 2).sort()).toEqual(['Amir Brazil', 'Zara Brazil']);
  // Customize: group by nationality, and show the email and phone
  await box.locator('.natnew-cust summary').click();
  await box.getByRole('checkbox', { name: 'Group by nationality' }).check();
  await expect(box.locator('.natnew-grp')).toHaveCount(3);
  await expect(box.locator('.natnew-grp-h').first()).toHaveText('Brazil 2');
  await box.getByRole('checkbox', { name: 'Phone' }).check();
  await expect(box).toContainText('+966500000010');
  // how many show
  await box.locator('#natnew-show').selectOption('12');
  await box.getByRole('checkbox', { name: 'Group by nationality' }).uncheck();
  // the device keeps the layout across a repaint; the filters last the visit
  await page.evaluate(`renderCommunity()`);
  await expect(box.locator('#natnew-sort')).toHaveValue('big');
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_natnew_view')).phone`)).toBe(true);
});

test('Show more lists the rest past the chosen number', async ({ page }) => {
  await open(page);
  await page.evaluate(`localStorage.setItem('cq_natnew_view',JSON.stringify({show:12}));S._nn=null;S.customers=[...S.customers,...Array.from({length:14},(_,i)=>({id:'b'+i,name:'Brazil '+i,email:'b'+i+'@example.test',nationality:'Brazil',created_at:'2026-08-0'+(1+i%9)+'T10:00:00Z'}))];renderCommunity()`);
  const box = page.locator('#tab-community .natnew-box');
  await expect(box.locator('.natnew-row')).toHaveCount(12);
  await box.getByRole('button', { name: 'Show 4 more' }).click();
  await expect(box.locator('.natnew-row')).toHaveCount(16);
});
