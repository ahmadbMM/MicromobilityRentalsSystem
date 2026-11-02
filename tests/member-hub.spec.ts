import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// The Community page's activities (the owner, 2026-11-03): kudos, Rider of the Month, challenges and the
// community goal, squads, the photo wall, the welcome and the year in review, from member-hub.js; and what runs them,
// Community > Activities. All Supabase traffic is stubbed; the rules themselves are the database's.

const directory = { ok: true, members: [
  { name: 'Lina Haddad', me: true, ref: 'r1', new: false, kudos: 2, title: null, rides: 5, badges: [] },
  { name: 'Omar Saleh', me: false, ref: 'r2', new: true, kudos: 3, title: null, rides: 1, badges: [] },
  { name: 'Sara Nabil', me: false, ref: 'r3', new: false, kudos: 0, title: null, rides: 7, badges: [] },
] };
const overview = {
  ok: true, kudos_got: 2,
  together: { session: 's1', date: '2026-10-31', people: [{ ref: 'r2', name: 'Omar Saleh', given: false }, { ref: 'r3', name: 'Sara Nabil', given: true }] },
  round: { id: 'rd1', label: 'Rider of November', label_ar: 'راكب نوفمبر', closes_on: '2099-01-31', mine: 'r3' },
  last_winner: { label: 'Rider of October', label_ar: 'راكب أكتوبر', name: 'Sara Nabil' },
  goals: [
    { id: 'g1', kind: 'challenge', name: 'Three Saturdays', name_ar: 'ثلاثة', reward: 'A free coffee', reward_ar: 'قهوة', target: 3, ends_on: '2099-01-31', progress: 1 },
    { id: 'g2', kind: 'goal', name: 'Group total', name_ar: 'المجموع', reward: null, reward_ar: null, target: 10, ends_on: '2099-01-31', progress: 10 },
  ],
  squad: null, board: [{ name: 'Night Owls', members: 4, rides: 9, mine: false }],
  buddy: 'Sara Nabil', welcoming: [], year: null,
};
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const photos = { ok: true, pending: 1, photos: [
  { id: 'ph1', caption: 'Corniche', at: '2026-10-31T10:00:00Z', mine: false, by: 'Omar Saleh', reacts: 2, reacted: false },
  { id: 'ph2', caption: '', at: '2026-10-30T10:00:00Z', mine: true, by: 'Lina Haddad', reacts: 0, reacted: false },
] };
const calls = (page: Page, fn: string) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname.endsWith('/rpc/' + fn)) out.push(r.postDataJSON()); });
  return out;
};
async function member(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], customers: [], queue_entries: [], bikes: [], 'rpc:member_directory': directory, 'rpc:hub_overview': overview,
    'rpc:hub_kudos': { ok: true }, 'rpc:hub_vote': { ok: true }, 'rpc:hub_squad_create': { ok: true }, 'rpc:hub_squad_join': { ok: true }, 'rpc:hub_squad_leave': { ok: true },
    'rpc:hub_photos_list': photos, 'rpc:hub_photo_img': JPEG, 'rpc:hub_photo_react': { ok: true }, 'rpc:hub_photo_report': { ok: true }, 'rpc:hub_photo_delete': { ok: true }, 'rpc:hub_photo_post': { ok: true }, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-nav .hub-tab').first()).toBeVisible();
}
const tab = (page: Page, name: string) => page.locator('#hub-nav .hub-tab', { hasText: name }).click();

test.describe('@customer:members the Community page activities', () => {
  test('the file loads only on this page, and every word exists in all ten languages', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('member-hub.js')) asked.push(r.url()); });
    await stubSupabase(page, { sessions: [], customers: [], queue_entries: [], bikes: [], 'rpc:member_directory': directory, 'rpc:hub_overview': overview });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await page.waitForTimeout(300);
    expect(asked).toEqual([]);
    await page.evaluate(`setCustTab('members')`);
    await expect(page.locator('#hub-nav .hub-tab').first()).toBeVisible();
    expect(asked).toHaveLength(1);
    const bad = await page.evaluate(`Object.entries(HUB_T).filter(([k,v])=>v.length!==10||v.some(x=>!String(x).trim())).map(([k])=>k)`);
    expect(bad).toEqual([]);
  });

  test('without the file the members list still works', async ({ page }) => {
    await page.route('**/member-hub.js*', (r) => r.abort());
    await stubSupabase(page, { sessions: [], customers: [], queue_entries: [], bikes: [], 'rpc:member_directory': directory });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('members')`);
    await expect(page.locator('#tab-members .mb-row')).toHaveCount(3);
  });

  test('the list says who is new, the card their kudos, and a new member reads their buddy', async ({ page }) => {
    await member(page);
    await expect(page.locator('.mb-row', { hasText: 'Omar Saleh' })).toContainText('New');
    await expect(page.locator('.mb-row', { hasText: 'Sara Nabil' })).not.toContainText('New');
    await expect(page.locator('#hub-top')).toContainText('Your welcome buddy: Sara Nabil');
    await page.locator('.mb-row', { hasText: 'Omar Saleh' }).click();
    await expect(page.locator('#badge-pop .mb-card')).toContainText('Kudos: 3');
  });

  test('the search and text boxes fill the width, and the tabs fit a phone', async ({ page }) => {
    await member(page);
    const width = async (sel: string) => (await page.locator(sel).boundingBox())!.width, nav = await width('#hub-nav');
    expect(await width('#mb-q')).toBeGreaterThan(nav * 0.9);
    await tab(page, 'Photos');
    await expect(page.locator('#ph-cap')).toBeVisible();
    expect(await width('#ph-cap')).toBeGreaterThan(nav * 0.75);
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
  });

  test('kudos go to someone who was there, once', async ({ page }) => {
    await member(page);
    const sent = calls(page, 'hub_kudos');
    await tab(page, 'Kudos');
    await expect(page.locator('#hub-body')).toContainText('Kudos you received: 2');
    await expect(page.locator('#hub-body .hub-row', { hasText: 'Sara Nabil' })).toContainText('Given');
    await page.locator('#hub-body .hub-row', { hasText: 'Omar Saleh' }).locator('button').click();
    await expect(page.locator('#hub-body .hub-row', { hasText: 'Omar Saleh' })).toContainText('Given');
    expect(sent[0]).toMatchObject({ p_session: 's1', p_ref: 'r2' });
  });

  test('the vote shows my choice, never me, and changes it; the last winner is named', async ({ page }) => {
    await member(page);
    const sent = calls(page, 'hub_vote');
    await tab(page, 'Vote');
    await expect(page.locator('#hub-body')).toContainText('Rider of October');
    await expect(page.locator('#hub-body .hub-row', { hasText: 'Sara Nabil' })).toContainText('Your vote');
    await expect(page.locator('#hub-body .hub-row', { hasText: 'Lina Haddad' })).toHaveCount(0);
    await page.locator('#hub-body .hub-row', { hasText: 'Omar Saleh' }).locator('button').click();
    await expect(page.locator('#hub-body .hub-row', { hasText: 'Omar Saleh' })).toContainText('Your vote');
    expect(sent[0]).toMatchObject({ p_round: 'rd1', p_ref: 'r2' });
  });

  test('challenges and the goal show their progress and reward', async ({ page }) => {
    await member(page);
    await tab(page, 'Challenges');
    const cards = page.locator('#hub-body .hub-card');
    await expect(cards.first()).toContainText('Your challenge');
    await expect(cards.first()).toContainText('A free coffee');
    await expect(cards.first().locator('[role=progressbar]')).toHaveAttribute('aria-valuenow', '1');
    await expect(cards.nth(1)).toContainText('Community goal');
    await expect(cards.nth(1)).toContainText('Done');
  });

  test('a squad is made or joined, a wrong code says so, and the board lists squads', async ({ page }) => {
    await member(page, { 'rpc:hub_squad_join': { ok: false, error: 'code' } });
    const made = calls(page, 'hub_squad_create');
    await tab(page, 'Squads');
    await expect(page.locator('#hub-body')).toContainText('Night Owls');
    await page.locator('#sq-code').fill('ABC123');
    await page.locator('#hub-body button', { hasText: 'Join with a code' }).click();
    await expect(page.locator('#toast-container')).toContainText('That code is not right');
    await page.locator('#sq-name').fill('Sunrise');
    await page.locator('#hub-body button', { hasText: 'Start a squad' }).click();
    await expect.poll(() => made.length).toBe(1);
    expect(made[0]).toMatchObject({ p_name: 'Sunrise' });
  });

  test('in a squad: its code, its people, and leaving asks twice', async ({ page }) => {
    await member(page, { 'rpc:hub_overview': { ...overview, squad: { name: 'Night Owls', code: 'ABC123', members: ['Lina Haddad', 'Omar Saleh'] } } });
    const left = calls(page, 'hub_squad_leave');
    await tab(page, 'Squads');
    await expect(page.locator('#hub-body')).toContainText('ABC123');
    await expect(page.locator('#hub-body')).toContainText('Omar Saleh');
    await page.locator('#hub-body button', { hasText: 'Leave the squad' }).click();
    expect(left).toHaveLength(0);
    await page.locator('#hub-body button', { hasText: 'Tap again' }).click();
    await expect.poll(() => left.length).toBe(1);
  });

  test('the photo wall: each picture read by itself; clap; take-down and delete ask twice', async ({ page }) => {
    await member(page);
    const imgs = calls(page, 'hub_photo_img'), rep = calls(page, 'hub_photo_report'), del = calls(page, 'hub_photo_delete');
    await tab(page, 'Photos');
    await expect(page.locator('#hub-body .hub-photo')).toHaveCount(2);
    await expect.poll(() => imgs.length).toBe(2);
    await expect(page.locator('img[data-ph="ph1"]')).toHaveAttribute('src', JPEG);
    const first = page.locator('#hub-body .hub-photo').first();
    await first.locator('button', { hasText: 'Applaud' }).click();
    await expect(first.locator('button', { hasText: 'Applaud' })).toContainText('3');
    await first.locator('button', { hasText: 'Ask to take down' }).click();
    expect(rep).toHaveLength(0);
    await first.locator('button', { hasText: 'Tap again' }).click();
    await expect.poll(() => rep.length).toBe(1);
    await expect(page.locator('#hub-body .hub-photo')).toHaveCount(1);
    await page.locator('#hub-body .hub-photo button', { hasText: 'Delete my photo' }).click();
    await page.locator('#hub-body .hub-photo button', { hasText: 'Tap again' }).click();
    await expect.poll(() => del.length).toBe(1);
  });

  test('posting needs a photo and the promise; what goes is a small JPEG', async ({ page }) => {
    await member(page);
    const posts = calls(page, 'hub_photo_post');
    await tab(page, 'Photos');
    await page.locator('#hub-body button', { hasText: 'Post a photo' }).click();
    await expect(page.locator('#toast-container')).toContainText('tick the box');
    expect(posts).toHaveLength(0);
    const png = Buffer.from(await page.evaluate(`(()=>{const c=document.createElement('canvas');c.width=2400;c.height=1600;const x=c.getContext('2d');for(let i=0;i<4000;i++){x.fillStyle='hsl('+(i%360)+',80%,50%)';x.fillRect(Math.random()*2400,Math.random()*1600,40,40);}return c.toDataURL('image/png').split(',')[1];})()`) as string, 'base64');
    await page.locator('#ph-file').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: png });
    await page.locator('#ph-cap').fill('Sunset');
    await page.locator('#ph-ack').check();
    await page.locator('#hub-body button', { hasText: 'Post a photo' }).click();
    await expect.poll(() => posts.length).toBe(1);
    const sent = posts[0] as { p_img: string; p_caption: string; p_ack: boolean };
    expect(sent.p_img.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(sent.p_img.length).toBeLessThan(200000);
    expect(sent.p_caption).toBe('Sunset');
    expect(sent.p_ack).toBe(true);
    await expect(page.locator('#hub-body')).toContainText('Yours waiting: 2');
  });

  test('the year appears only when there is one, and shares its numbers', async ({ page }) => {
    await member(page);
    await expect(page.locator('#hub-nav .hub-tab', { hasText: 'Your year' })).toHaveCount(0);
    await page.evaluate(`S._hub.d.year={year:2026,rides:12,saturdays:8,kinds:3,first:'2026-01-10',kudos:4,badges:2};(window._shared=null);navigator.share=(d)=>{window._shared=d;return Promise.resolve();};_hubRender()`);
    await tab(page, 'Your year');
    await expect(page.locator('#hub-body .hub-stats')).toContainText('12');
    await page.locator('#hub-body button', { hasText: 'Share my year' }).click();
    expect(await page.evaluate('window._shared.text')).toContain('12 sessions, 8 Saturday rides, 4 kudos');
  });

  test('a failed read offers to try again, and the list stays', async ({ page }) => {
    await member(page, { 'rpc:hub_overview': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    await tab(page, 'Kudos');
    await expect(page.locator('#hub-body button', { hasText: 'Try again' })).toBeVisible();
    await tab(page, 'Members');
    await expect(page.locator('#tab-members .mb-row')).toHaveCount(3);
  });
});

const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'l@example.com', phone: '+966551876215', created_at: '2026-06-10T00:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'o@example.com', phone: '+966551876216', created_at: '2026-06-11T00:00:00Z' },
];
const round = { id: 'rd1', label: 'Rider of November', label_ar: 'راكب', opens_on: '2026-11-01', closes_on: '2026-11-20', title_id: 'ttl_rotm', winner_id: null, winner_name: null };
async function staff(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], staff_options: [],
    tags: [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: 'green', locked: true }],
    customer_tags: [{ customer_id: 'c1', tag_id: 'tag_saturday', added_at: 1 }, { customer_id: 'c2', tag_id: 'tag_saturday', added_at: Date.now() }],
    titles: [{ id: 'ttl_rotm', name: 'Rider of the Month', name_ar: 'راكب الشهر', color: 'gold', auto_rides: null, retired: false, sort: 500 }], customer_titles: [],
    rotm_rounds: [round], hub_goals: [], squads: [{ id: 'sq1', name: 'Night Owls', code: 'ABC123' }], squad_members: [{ customer_id: 'c1', squad_id: 'sq1' }],
    hub_photos: [{ id: 'ph1', customer_id: 'c2', caption: 'Corniche', status: 'pending', reported_at: null, report_reason: null, created_at: '2026-11-01T00:00:00Z' }],
    member_welcome: [], 'rpc:staff_rotm_tally': [{ customer_id: 'c2', name: 'Omar Saleh', votes: 4 }], 'rpc:staff_goal_progress': [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
  await page.waitForFunction('S._acAt>0&&!S._acBusy&&!!S._ac');
}
const writes = (page: Page, table: string) => {
  const out: { method: string; body: unknown }[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/' + table)) out.push({ method: r.method(), body: r.postDataJSON() }); });
  return out;
};
const sub = (page: Page, name: RegExp) => page.locator('#tab-community .filter-pill', { hasText: name }).click();

test.describe('@staff:community activities', () => {
  test('the section has its address, and the Photos pill counts what waits', async ({ page }) => {
    await staff(page);
    await expect(page).toHaveURL(/\/community\/activities/);
    await expect(page.locator('#tab-community .filter-pill', { hasText: /^Photos/ })).toContainText('(1)');
  });

  test('crowning the winner names them and gives the title until the end of the next month', async ({ page }) => {
    await staff(page);
    const rd = writes(page, 'rotm_rounds'), tt = writes(page, 'customer_titles');
    await page.locator('[data-round="rd1"] button', { hasText: 'Votes' }).click();
    await expect(page.locator('#tab-community .tg-holders')).toContainText('4 votes');
    await page.locator('#tab-community .tg-holders button', { hasText: 'Make winner' }).click();
    expect(rd).toHaveLength(0);
    await page.locator('#tab-community .tg-holders button', { hasText: 'Tap again' }).click();
    await expect.poll(() => tt.length).toBe(1);
    expect(rd[0].body).toMatchObject({ winner_id: 'c2', winner_name: 'Omar Saleh' });
    expect(tt[0].body).toMatchObject({ customer_id: 'c2', title_id: 'ttl_rotm', expires_on: '2026-12-31' });
    await expect(page.locator('[data-round="rd1"]')).toContainText('Winner: Omar Saleh');
  });

  test('a challenge needs both names and dates, then saves', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'hub_goals');
    await sub(page, /^Challenges/);
    await page.locator('#tab-community button', { hasText: 'New challenge or goal' }).click();
    await page.locator('#ac-g-en').fill('Three Saturdays');
    await page.locator('#tab-community .bdg-foot .btn-primary').click();
    await expect(page.locator('#toast-container')).toContainText('both names');
    expect(w).toHaveLength(0);
    await page.locator('#ac-g-ar').fill('ثلاثة');
    await page.locator('#ac-g-target').fill('3');
    await page.locator('#ac-g-to').fill('2099-01-31');
    await page.locator('#tab-community .bdg-foot .btn-primary').click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toMatchObject({ kind: 'challenge', scope: 'saturday', target: 3, name: 'Three Saturdays' });
    await expect(page.locator('#tab-community .am-tag-row', { hasText: 'Three Saturdays' })).toBeVisible();
  });

  test('a photo is approved; a rejected one sends the picture away with it', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'hub_photos');
    await sub(page, /^Photos/);
    await page.locator('[data-photo="ph1"] button', { hasText: 'Approve' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toMatchObject({ status: 'approved', decided_by: 'Spec Staff' });
    await page.locator('[data-photo="ph1"] button', { hasText: 'Reject and delete' }).click();
    await page.locator('[data-photo="ph1"] button', { hasText: 'Tap again' }).click();
    await expect.poll(() => w.length).toBe(2);
    expect(w[1].body).toMatchObject({ status: 'rejected', img: null });
    await expect(page.locator('[data-photo="ph1"]')).toHaveCount(0);
  });

  test('a new member is given a welcome buddy; an older member is not listed', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'member_welcome');
    await sub(page, /^Welcome/);
    await expect(page.locator('[data-new="c1"]')).toHaveCount(0);
    await page.locator('[data-new="c2"] select').selectOption('c1');
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toMatchObject({ customer_id: 'c2', buddy_id: 'c1' });
  });

  test('a squad is removed on the second tap', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'squads');
    await sub(page, /^Squads/);
    await expect(page.locator('[data-squad="sq1"]')).toContainText('ABC123');
    await page.locator('[data-squad="sq1"] .btn-red').click();
    expect(w).toHaveLength(0);
    await page.locator('[data-squad="sq1"] .btn-red').click();
    await expect.poll(() => w.length).toBe(1);
    await expect(page.locator('[data-squad="sq1"]')).toHaveCount(0);
  });

  test('a database without the tables says so', async ({ page }) => {
    await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], tags: [], customer_tags: [], staff_options: [] });
    await page.route('**/rest/v1/rotm_rounds*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: 'no table' }) }));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
    await expect(page.locator('#tab-community')).toContainText('not set up on the database');
  });
});
