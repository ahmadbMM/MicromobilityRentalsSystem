import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Titles for community members and the members list (the owner, 2026-11-02). Staff make and give
// titles in Community > Titles; a member picks the one others see and can hide from the list; members
// read each other through member_directory, which carries no account id. All Supabase traffic is stubbed.

const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina@example.com', phone: '+966551876215', gender: 'female', created_at: '2026-06-10T00:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar@example.com', phone: '+966551876216', gender: 'male', created_at: '2026-06-11T00:00:00Z' },
  { id: 'c3', name: 'Sara Nabil', email: 'sara@example.com', phone: '+966551876217', gender: 'female', created_at: '2026-06-12T00:00:00Z' },
];
const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: 'green', locked: true }];
const customer_tags = [
  { customer_id: 'c1', tag_id: 'tag_saturday', added_at: 1 },
  { customer_id: 'c2', tag_id: 'tag_saturday', added_at: 1 },
];
const captain = { id: 'ttl_cap', name: 'Ride Captain', name_ar: 'قائد الرحلة', color: 'gold', auto_rides: null, retired: false, sort: 500 };
const legend = { id: 'ttl_leg', name: 'Legend', name_ar: 'أسطورة', color: 'purple', auto_rides: 50, retired: false, sort: 501 };
const mine = { ok: true, member: true, hidden: false, shown: 'ttl_leg', titles: [
  { id: 'ttl_cap', name: 'Ride Captain', name_ar: 'قائد الرحلة', color: 'gold', auto: false, expires_on: '2099-01-31' },
  { id: 'ttl_leg', name: 'Legend', name_ar: 'أسطورة', color: 'purple', auto: true, expires_on: null },
] };
const directory = { ok: true, members: [
  { name: 'Lina Haddad', me: true, title: { name: 'Legend', name_ar: 'أسطورة', color: 'purple' }, rides: 51, badges: [] },
  { name: 'Omar Saleh', me: false, title: { name: 'Ride Captain', name_ar: 'قائد الرحلة', color: 'gold' }, rides: 1,
    badges: [{ slug: 'bd_c1', icon: 'moon', color: 'purple', name: 'Night Owl', name_ar: 'بومة الليل', system: false }] },
  { name: 'Sara Nabil', me: false, title: null, rides: 7, badges: [] },
] };

const rpcBodies = (page: Page, fn: string) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r: Request) => { if (new URL(r.url()).pathname.endsWith('/rpc/' + fn)) out.push(r.postDataJSON()); });
  return out;
};
async function rider(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], 'rpc:customer_my_titles': mine, 'rpc:member_directory': directory, 'rpc:customer_title_prefs': { ok: true }, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
  await page.goto('/');
  await waitForSb(page);
}
const account = async (page: Page) => { await page.evaluate(`setCustTab('account')`); await expect(page.locator('#tt-mine')).toBeVisible(); };
async function staff(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], tags, customer_tags, staff_options: [], titles: [captain, legend], customer_titles: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='titles';renderCommunity()`);
  await page.waitForFunction('S._ttAt>0&&!S._ttBusy');
}

test.describe('@customer:account member titles', () => {
  test('a member picks the title others see, and the choice is sent', async ({ page }) => {
    await rider(page);
    const sent = rpcBodies(page, 'customer_title_prefs');
    await account(page);
    await expect(page.locator('#tt-mine .tt-pick.on')).toContainText('Legend');
    await expect(page.locator('#tt-mine .amb-mine-title')).toHaveText('Your title');
    await page.locator('#tt-mine .tt-pick', { hasText: 'Ride Captain' }).click();
    await expect(page.locator('#tt-mine .tt-pick.on')).toContainText('Ride Captain');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_id: 'c1', p_token: 'tok-spec', p_shown: 'ttl_cap', p_hidden: false });
  });

  test('hiding is sent, and a refusal puts the switch back and says so', async ({ page }) => {
    await rider(page, { 'rpc:customer_title_prefs': { ok: false, error: 'member' } });
    await account(page);
    await page.locator('#tt-hide').click();
    await expect(page.locator('#toast-container')).toContainText('We could not save that');
    await expect(page.locator('#tt-hide')).not.toBeChecked();
  });

  test('an account that is not a member gets no card', async ({ page }) => {
    await rider(page, { 'rpc:customer_my_titles': { ok: true, member: false } });
    await page.evaluate(`setCustTab('account')`);
    await page.waitForFunction(`!S._ttMineBusy&&document.querySelector('#tab-account').children.length>0`);
    await expect(page.locator('#tt-mine')).toHaveCount(0);
  });

  test('a database without the function shows no card and no error', async ({ page }) => {
    await rider(page, { 'rpc:customer_my_titles': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function' } } });
    await page.evaluate(`setCustTab('account')`);
    await page.waitForFunction(`!S._ttMineBusy&&document.querySelector('#tab-account').children.length>0`);
    await expect(page.locator('#tt-mine')).toHaveCount(0);
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0);
  });

  test('Arabic reads the Arabic name; another language reads the English', async ({ page }) => {
    await rider(page);
    await account(page);
    await page.evaluate(`S.lang='ar';_ttMinePaint()`);
    await expect(page.locator('#tt-mine .tt-pick.on')).toContainText('أسطورة');
    await page.evaluate(`S.lang='fr';_ttMinePaint()`);
    await expect(page.locator('#tt-mine .tt-pick.on')).toContainText('Legend');
  });
});

test.describe('@customer:members members list', () => {
  test('the list opens from the account, searches by name, and a card shows title, rides and badges', async ({ page }) => {
    await rider(page);
    await account(page);
    await page.locator('#tt-mine .tt-open').click();
    await expect(page).toHaveURL(/\/members/);
    await expect(page.locator('#tab-members .mb-row')).toHaveCount(3);
    await expect(page.locator('#tab-members .mb-row').first()).toContainText('You');
    await page.locator('#mb-q').fill('omar');
    await expect(page.locator('#tab-members .mb-row')).toHaveCount(1);
    await expect(page.locator('#mb-q')).toBeFocused();
    await page.locator('#tab-members .mb-row').click();
    const card = page.locator('#badge-pop .mb-card');
    await expect(card).toContainText('Omar Saleh');
    await expect(card).toContainText('Ride Captain');
    await expect(card).toContainText('1 ride');
    await expect(card).toContainText('Night Owl');
    await card.locator('.mb-close').click();
    await expect(page.locator('#badge-pop')).toHaveCount(0);
    await page.locator('#mb-q').fill('nobody');
    await expect(page.locator('#tab-members')).toContainText('No members match');
  });

  test('a non-member asking for the page leaves it and sees nobody', async ({ page }) => {
    await rider(page, { 'rpc:member_directory': { ok: false, error: 'member' } });
    await page.evaluate(`setCustTab('members')`);
    await expect(page).toHaveURL(/\/reserve/);
    await expect(page.locator('#tab-members .mb-row')).toHaveCount(0);
    await expect(page.locator('#tab-members')).not.toHaveClass(/active/);
  });

  test('a failed read offers to try again, and the retry paints the list', async ({ page }) => {
    await rider(page, { 'rpc:member_directory': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    await page.evaluate(`setCustTab('members')`);
    await expect(page.locator('#tab-members')).toContainText('We could not load the members');
    await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], 'rpc:member_directory': directory });
    await page.locator('#tab-members button', { hasText: 'Try again' }).click();
    await expect(page.locator('#tab-members .mb-row')).toHaveCount(3);
  });

  test('a directly opened /members address lands on the page', async ({ page }) => {
    await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], 'rpc:customer_my_titles': mine, 'rpc:member_directory': directory });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
    await page.goto('/members');
    await waitForSb(page);
    await expect(page.locator('#tab-members .mb-row')).toHaveCount(3);
    await expect(page).toHaveURL(/\/members/);
  });
});

test.describe('@staff:community titles', () => {
  test('the section has its own address and lists hand-given and automatic titles', async ({ page }) => {
    await staff(page);
    await expect(page).toHaveURL(/\/community\/titles/);
    await expect(page.locator('#tab-community [data-title="ttl_cap"]')).toContainText('Given by staff');
    await expect(page.locator('#tab-community [data-title="ttl_leg"]')).toContainText('Automatic at 50 Saturday rides');
  });

  test('an admin makes a title; both names are required and the count must be whole', async ({ page }) => {
    await staff(page);
    const posts: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/rest/v1/titles')) posts.push(r.postDataJSON()); });
    await page.locator('#tab-community button', { hasText: 'New title' }).click();
    await page.locator('#tt-f-name').fill('Pace Setter');
    await page.locator('#tab-community .tt-form .btn-primary').click();
    await expect(page.locator('#toast-container')).toContainText('English and in Arabic');
    await page.locator('#tt-f-name_ar').fill('ضابط الإيقاع');
    await page.locator('#tt-f-auto').fill('2.5');
    await page.locator('#tab-community .tt-form .btn-primary').click();
    await expect(page.locator('#toast-container')).toContainText('whole number');
    expect(posts).toHaveLength(0);
    await page.locator('#tt-f-auto').fill('');
    await page.locator('#tab-community .tt-form .btn-primary').click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ name: 'Pace Setter', name_ar: 'ضابط الإيقاع', color: 'green', auto_rides: null });
    await expect(page.locator('#tab-community .am-tag-row', { hasText: 'Pace Setter' })).toBeVisible();
  });

  test('a staffer who is not an admin gives titles but cannot edit the list', async ({ page }) => {
    await staff(page);
    await page.evaluate(`S.staffRole='frontdesk';renderCommunity()`);
    await expect(page.locator('#tab-community button', { hasText: 'New title' })).toHaveCount(0);
    await expect(page.locator('#tab-community [data-title="ttl_cap"] button', { hasText: 'Holders' })).toHaveCount(1);
    await expect(page.locator('#tab-community [data-title="ttl_cap"] button', { hasText: 'Edit' })).toHaveCount(0);
  });

  test('a title goes only to a community member, with an end date, and is taken back', async ({ page }) => {
    await staff(page);
    const writes: { method: string; body: unknown }[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/customer_titles')) writes.push({ method: r.method(), body: r.postDataJSON() }); });
    await page.locator('#tab-community [data-title="ttl_cap"] button', { hasText: 'Holders' }).click();
    await page.locator('#tt-until').fill('2099-01-31');
    await page.locator('#tt-q').fill('sara');
    await page.waitForTimeout(400);
    await expect(page.locator('#tab-community .tg-give')).toHaveCount(0); // Sara holds no Community tag
    await page.locator('#tt-q').fill('omar');
    await expect(page.locator('#tab-community .tg-give')).toHaveCount(1);
    await page.locator('#tab-community .tg-give button').click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].body).toMatchObject({ customer_id: 'c2', title_id: 'ttl_cap', expires_on: '2099-01-31', given_by: 'Spec Staff' });
    await page.locator('#tab-community .tg-row:not(.tg-give) .btn-red').click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].method).toBe('DELETE');
  });

  test('an automatic title lists who holds it, and offers nothing to give', async ({ page }) => {
    await staff(page, { 'rpc:staff_title_auto_holders': [{ customer_id: 'c2', nights: 52 }] });
    await page.locator('#tab-community [data-title="ttl_leg"] button', { hasText: 'Holders' }).click();
    await expect(page.locator('#tab-community .tg-holders')).toContainText('Omar Saleh');
    await expect(page.locator('#tab-community .tg-holders')).toContainText('52 Saturday rides');
    await expect(page.locator('#tt-q')).toHaveCount(0);
  });

  test('delete asks for a second tap, and a title someone was given has none', async ({ page }) => {
    await staff(page, { customer_titles: [{ customer_id: 'c2', title_id: 'ttl_cap', expires_on: null, given_by: 'Spec', given_at: '2026-11-02T00:00:00Z' }] });
    await expect(page.locator('#tab-community [data-title="ttl_cap"] .btn-red')).toHaveCount(0);
    const del = page.locator('#tab-community [data-title="ttl_leg"] .btn-red');
    await del.click();
    await expect(del).toContainText('Tap again');
    await del.click();
    await expect(page.locator('#tab-community [data-title="ttl_leg"]')).toHaveCount(0);
  });

  test('a database without the tables says so', async ({ page }) => {
    await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], tags, customer_tags, staff_options: [], titles: { __tableError: true } as never });
    await page.route('**/rest/v1/titles*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.titles' in the schema cache" }) }));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='titles';renderCommunity()`);
    await expect(page.locator('#tab-community')).toContainText('not set up on the database');
  });
});
