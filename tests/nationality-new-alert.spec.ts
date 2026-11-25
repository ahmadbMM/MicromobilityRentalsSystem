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

// The user, 2026-11-25: the list is its own People section, New nationalities (/people/nationalities); the overview keeps
// a bar (Open, Got it) only while someone new waits.
const sec = (page: import('@playwright/test').Page) => page.locator('#tab-community .nn-sec');
async function openSec(page: import('@playwright/test').Page) {
  await open(page);
  await page.evaluate(`setCommTab('nationalities')`);
  await expect(sec(page)).toBeVisible();
}

test('the overview has a bar naming them; New nationalities lists them, newest first', async ({ page }) => {
  await open(page);
  const bar = page.locator('#tab-community .natnew-box.natnew-min');
  await expect(bar.locator('h3')).toHaveText('2 new nationalities in Customers');
  await expect(page.locator('#tab-community .natnew-row')).toHaveCount(0);
  await bar.getByRole('button', { name: 'Show list (2)' }).click();
  await expect(sec(page)).toBeVisible();
  await expect(page).toHaveURL(/\/people\/nationalities$/);
  const box = sec(page);
  await expect(box.locator('.natnew-row')).toHaveCount(2);
  await expect(box.locator('.natnew-row').first()).toContainText('Farah India');
  await expect(box).toContainText('Ghazi Jordan');
  await expect(box).not.toContainText('Badr Saudi');
  await expect(box).not.toContainText('Hana Blank');
  // its own top-level group in People's nav, with the count of new ones
  await expect(page.locator('#tab-community [data-ppl-grp="nationalities"]')).toHaveText('New nationalities (2)');
  // not on other views
  await page.evaluate(`setCommTab('accounts')`);
  await expect(page.locator('#tab-community .natnew-box')).toHaveCount(0);
  // its rows open the account window, not the editor
  await page.evaluate(`setCommTab('nationalities')`);
  await sec(page).locator('.natnew-row').first().click();
  await expect(page.locator('#cust-modal #ah-title')).toHaveText('Farah India');
});

test('Got it takes the overview bar away until another such customer appears; the section keeps everyone', async ({ page }) => {
  await open(page);
  await page.locator('#tab-community .natnew-box').getByRole('button', { name: 'Got it' }).click();
  await expect(page.locator('#tab-community .natnew-box')).toHaveCount(0);
  await page.evaluate(`setCommTab('nationalities')`);
  await expect(sec(page).locator('.natnew-row')).toHaveCount(2);
  await expect(sec(page).getByRole('button', { name: 'Got it' })).toHaveCount(0);
  await page.evaluate(`S.customers=[...S.customers,{id:'k9',name:'Ivo Brazil',email:'k9@example.test',nationality:'Brazil',created_at:new Date().toISOString()}];setCommTab('overview')`);
  const bar = page.locator('#tab-community .natnew-box.natnew-min');
  await expect(bar.locator('h3')).toHaveText('A new nationality in Customers');
  await expect(bar.getByRole('button', { name: 'Show list (1)' })).toBeVisible();
});

test('each person has Invite and the other buttons; Invite marks them invited for the team', async ({ page }) => {
  await open(page);
  await page.evaluate(`S.customers=S.customers.map(c=>c.id==='k6'?{...c,phone:'+966500000006',ride_news:true}:c.id==='k7'?{...c,phone:'+962790000007'}:c);setCommTab('nationalities')`);
  const box = sec(page);
  await expect(box.locator('.dash-kpi').first()).toContainText('2');
  const farah = box.locator('.nn-item').filter({ hasText: 'Farah India' });
  const inv = farah.getByRole('link', { name: 'Invite' });
  const href = decodeURIComponent((await inv.getAttribute('href'))!);
  expect(href).toContain('https://wa.me/966500000006?text=');
  expect(href).toContain('नमस्ते Farah'); // the language her nationality suggests (India: Hindi), as the reminders pick it
  expect(href).toContain('https://micromobility.sa/community/registration?lang=hi');
  const ghazi = decodeURIComponent((await box.locator('.nn-item').filter({ hasText: 'Ghazi Jordan' }).getByRole('link', { name: 'Invite' }).getAttribute('href'))!);
  expect(ghazi).toContain('مرحبًا Ghazi'); // Jordan: Arabic
  for (const name of ['Invite to a session', 'WhatsApp', 'Call', 'Copy message', 'New booking', 'Open account']) await expect(farah.getByRole(name === 'WhatsApp' || name === 'Call' ? 'link' : 'button', { name, exact: true })).toBeVisible();
  // Ghazi has not agreed to news: said on his row
  await expect(box.locator('.nn-item').filter({ hasText: 'Ghazi Jordan' })).toContainText('Not agreed to news');
  await expect(farah).not.toContainText('Not agreed to news');
  // invited (the click's own handler; the WhatsApp tab itself is not opened here)
  const writes: unknown[] = [];
  page.on('request', (r) => { if (['POST', 'PATCH'].includes(r.method()) && /staff_options/.test(r.url())) writes.push(r.postDataJSON()); });
  await page.evaluate(`_nnInvited('k6','whatsapp')`);
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(JSON.stringify(writes[0])).toContain('natnew_inv');
  await expect(farah.locator('.nn-chip-on')).toContainText('Invited');
  await expect(farah.getByRole('link', { name: 'Invite again' })).toBeVisible();
  // the Invited filter
  await box.locator('#natnew-inv').selectOption('no');
  await expect(box.locator('.natnew-row')).toHaveCount(1);
  await expect(box).toContainText('Ghazi Jordan');
  await box.locator('#natnew-inv').selectOption('yes');
  await expect(box.locator('.natnew-row')).toHaveCount(1);
  await expect(box).toContainText('Farah India');
  // Message all opens the group dialog with the list as filtered
  await box.getByRole('button', { name: 'Message all (1)' }).click();
  await expect(page.locator('#confirm-modal').getByRole('button', { name: 'Marketing' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(`[S._seg.ids,S._seg.tab,S._seg.kind]`)).toEqual([['k6'], 'msg', 'news']);
});

test('the nationalities nobody holds yet are listed under it', async ({ page }) => {
  await openSec(page);
  const none = sec(page).locator('.nn-none');
  await none.locator('summary').click();
  await expect(none.locator('.nn-nat').filter({ hasText: /^Brazil$/ })).toHaveCount(1);
  await expect(none.locator('.nn-nat').filter({ hasText: /^India$/ })).toHaveCount(0);
});

test('a member from that nationality joining takes its customers off the list', async ({ page }) => {
  await open(page);
  await page.evaluate(`S.customerTags=[...S.customerTags,{customer_id:'k6',tag_id:'tag_saturday',added_at:Date.now(),expires_at:null,starts_at:null}];setCommTab('nationalities')`);
  const box = sec(page);
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
  await openSec(page);
  await page.evaluate(`localStorage.removeItem('cq_natnew_view');S._nn=null;S.customers=[...S.customers,
    {id:'k10',name:'Zara Brazil',email:'zara@example.test',phone:'+966500000010',nationality:'Brazil',gender:'female',created_at:new Date(Date.now()-2*864e5).toISOString()},
    {id:'k11',name:'Amir Brazil',email:'amir@example.test',nationality:'Brazil',gender:'male',created_at:'2026-07-01T10:00:00Z'}];renderCommunity()`);
  const box = sec(page);
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
  await openSec(page);
  await page.evaluate(`localStorage.setItem('cq_natnew_view',JSON.stringify({show:12}));S._nn=null;S.customers=[...S.customers,...Array.from({length:14},(_,i)=>({id:'b'+i,name:'Brazil '+i,email:'b'+i+'@example.test',nationality:'Brazil',created_at:'2026-08-0'+(1+i%9)+'T10:00:00Z'}))];renderCommunity()`);
  const box = sec(page);
  await expect(box.locator('.natnew-row')).toHaveCount(12);
  await box.getByRole('button', { name: 'Show 4 more' }).click();
  await expect(box.locator('.natnew-row')).toHaveCount(16);
});
