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
const directory = { ok: true, members: [] };

const rpcBodies = (page: Page, fn: string) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r: Request) => { if (new URL(r.url()).pathname.endsWith('/rpc/' + fn)) out.push(r.postDataJSON()); });
  return out;
};
async function rider(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:customer_my_titles': mine, 'rpc:member_directory': directory, 'rpc:customer_title_prefs': { ok: true }, ...fx });
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
  test('a member picks the title their account shows, and the choice is sent', async ({ page }) => {
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

  test('a refused choice puts the pick back and says so; there is no switch for a list that is gone', async ({ page }) => {
    await rider(page, { 'rpc:customer_title_prefs': { ok: false, error: 'member' } });
    await account(page);
    await expect(page.locator('#tt-hide')).toHaveCount(0);
    await page.locator('#tt-mine .tt-pick', { hasText: 'Ride Captain' }).click();
    await expect(page.locator('#toast-container')).toContainText('We could not save that');
    await expect(page.locator('#tt-mine .tt-pick.on')).toContainText('Legend');
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

test.describe('@customer:account friend invite', () => {
  test('the invite shares a message asking the friend to fill in the form, with the member\'s link', async ({ page }) => {
    await rider(page, { 'rpc:member_invite_code': { ok: true, code: 'abcdef0123456789' } });
    await page.addInitScript(() => { (navigator as unknown as { share: unknown }).share = (d: unknown) => { (window as unknown as { _shared: unknown })._shared = d; return Promise.resolve(); }; });
    await page.reload();
    await waitForSb(page);
    await account(page);
    await page.waitForFunction('S._invCode&&S._invCode.code');
    await page.locator('#tt-mine .tt-invite').click();
    const text = await page.evaluate('window._shared.text') as string;
    expect(text).toContain('fill in this form');
    expect(text).toContain('https://micromobility.sa/community/registration?inv=abcdef0123456789&lang=en');
  });

  test('without a share sheet it opens WhatsApp; a refused code says so and opens nothing', async ({ page }) => {
    await rider(page, { 'rpc:member_invite_code': { ok: true, code: 'abcdef0123456789' } });
    await page.addInitScript(() => { Object.defineProperty(navigator, 'share', { value: undefined }); window.open = ((u: string) => { (window as unknown as { _opened: string })._opened = u; return null; }) as typeof window.open; });
    await page.reload();
    await waitForSb(page);
    await account(page);
    await page.waitForFunction('S._invCode&&S._invCode.code');
    await page.locator('#tt-mine .tt-invite').click();
    expect(await page.evaluate('window._opened')).toContain('https://wa.me/?text=');
    await page.evaluate(`S._invCode=null;window._opened=null;sb.rpc=()=>Promise.resolve({data:{ok:false,error:'member'}})`);
    await page.locator('#tt-mine .tt-invite').click();
    await expect(page.locator('#toast-container')).toContainText('could not make your invitation');
    expect(await page.evaluate('window._opened')).toBeNull();
  });
});

test.describe('@customer:members the Community page', () => {
  test('a member has the Community tab in the menus, between Bookings and Account, and it reads as current', async ({ page }) => {
    await rider(page);
    await page.evaluate(`setCustTab('account')`);
    const tops = page.locator('#customer-tab-nav .tab-btn'), bot = page.locator('#bnav-members');
    await page.waitForFunction('S._infoMem&&S._infoMem.ok');
    await expect(tops.nth(2)).toHaveAttribute('data-ctab', 'members');
    expect(await tops.nth(2).evaluate((e) => (e as HTMLElement).hidden)).toBe(false);
    expect(await bot.evaluate((e) => (e as HTMLElement).hidden)).toBe(false);
    await page.evaluate(`setCustTab('members')`);
    await expect(tops.nth(2)).toHaveAttribute('aria-current', 'page');
    await expect(bot).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#tab-members button', { hasText: 'Back to Account' })).toHaveCount(0);
    await expect(page.locator('#customer-tab-nav [data-ctab="account"]')).not.toHaveAttribute('aria-current', 'page');
  });

  test('anyone else never sees the tab: not a member, signed out, or after signing out', async ({ page }) => {
    await rider(page, { 'rpc:community_member': false });
    await page.evaluate(`setCustTab('account')`);
    await page.waitForFunction('S._infoMem&&!S._infoMem.busy');
    for (const sel of ['#customer-tab-nav [data-ctab="members"]', '#bnav-members']) await expect(page.locator(sel)).toBeHidden();
    await expect(page.locator('#cust-bnav-grid')).not.toHaveClass(/with-comm/);
  });

  test('a member signing out loses the tab', async ({ page }) => {
    await rider(page);
    await page.evaluate(`setCustTab('account')`);
    await page.waitForFunction('S._infoMem&&S._infoMem.ok');
    await page.evaluate(`doLogout(true);_commNavPaint()`);
    expect(await page.locator('#bnav-members').evaluate((e) => (e as HTMLElement).hidden)).toBe(true);
    expect(await page.locator('#customer-tab-nav [data-ctab="members"]').evaluate((e) => (e as HTMLElement).hidden)).toBe(true);
  });

  test('it opens from the menu and names nobody', async ({ page }) => {
    await rider(page);
    await page.waitForFunction('S._infoMem&&S._infoMem.ok');
    await page.locator('#customer-tab-nav [data-ctab="members"], #bnav-members').locator('visible=true').first().click();
    await expect(page).toHaveURL(/\/members/);
    await expect(page.locator('#hub-nav')).toBeAttached();
    await expect(page.locator('#tab-members .mb-row, #mb-q')).toHaveCount(0);
  });

  test('a non-member asking for the page leaves it and sees nobody', async ({ page }) => {
    await rider(page, { 'rpc:member_directory': { ok: false, error: 'member' } });
    await page.evaluate(`setCustTab('members')`);
    await expect(page).toHaveURL(/\/reserve/);
    await expect(page.locator('#tab-members .mb-row')).toHaveCount(0);
    await expect(page.locator('#tab-members')).not.toHaveClass(/active/);
  });

  test('a failed read offers to try again, and the retry opens the page', async ({ page }) => {
    await rider(page, { 'rpc:member_directory': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    await page.evaluate(`setCustTab('members')`);
    await expect(page.locator('#tab-members')).toContainText('We could not load the members');
    await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], 'rpc:member_directory': directory });
    await page.locator('#tab-members button', { hasText: 'Try again' }).click();
    await expect(page.locator('#hub-nav')).toBeAttached();
  });

  test('a directly opened /members address lands on the page', async ({ page }) => {
    await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], 'rpc:customer_my_titles': mine, 'rpc:member_directory': directory });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
    await page.goto('/members');
    await waitForSb(page);
    await expect(page.locator('#hub-nav')).toBeAttached();
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

  test('an admin makes a title; a name is required and the count must be whole', async ({ page }) => {
    await staff(page);
    const posts: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/rest/v1/titles')) posts.push(r.postDataJSON()); });
    await page.locator('#tab-community button', { hasText: 'New title' }).click();
    await page.locator('#tab-community .tt-form .btn-primary').click();
    await expect(page.locator('#toast-container')).toContainText('English or in Arabic');
    await page.locator('#tt-f-name').fill('Pace Setter');
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

  for (const [box, words] of [['#tt-f-name', 'Pace Setter'], ['#tt-f-name_ar', 'ضابط الإيقاع']]) {
    test(`a title can be written in one language: ${words} goes in both names`, async ({ page }) => {
      await staff(page);
      const posts: Record<string, unknown>[] = [];
      page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/rest/v1/titles')) posts.push(r.postDataJSON()); });
      await page.locator('#tab-community button', { hasText: 'New title' }).click();
      await page.locator(box).fill(words);
      await page.locator('#tab-community .tt-form .btn-primary').click();
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0]).toMatchObject({ name: words, name_ar: words });
      await expect(page.locator('#tab-community .am-tag-row', { hasText: words })).toBeVisible();
    });
  }

  test('a title written in one language reopens with that box filled, and a correction reaches both names', async ({ page }) => {
    const once = { ...captain, id: 'ttl_en', name: 'Pace Setter', name_ar: 'Pace Setter' };
    const onceAr = { ...captain, id: 'ttl_ar', name: 'ضابط الإيقاع', name_ar: 'ضابط الإيقاع' };
    await staff(page, { titles: [captain, once, onceAr] });
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname.endsWith('/rest/v1/titles')) patches.push(r.postDataJSON()); });
    const edit = (id: string) => page.locator(`#tab-community [data-title="${id}"] button`, { hasText: 'Edit' }).click();
    await edit('ttl_cap');
    await expect(page.locator('#tt-f-name')).toHaveValue('Ride Captain');
    await expect(page.locator('#tt-f-name_ar')).toHaveValue('قائد الرحلة');
    await edit('ttl_ar');
    await expect(page.locator('#tt-f-name')).toHaveValue('');
    await expect(page.locator('#tt-f-name_ar')).toHaveValue('ضابط الإيقاع');
    await edit('ttl_en');
    await expect(page.locator('#tt-f-name')).toHaveValue('Pace Setter');
    await expect(page.locator('#tt-f-name_ar')).toHaveValue('');
    await page.locator('#tt-f-name').fill('Pace Maker');
    await page.locator('#tab-community .tt-form .btn-primary').click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toMatchObject({ name: 'Pace Maker', name_ar: 'Pace Maker' });
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
