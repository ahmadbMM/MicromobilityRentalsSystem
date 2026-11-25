import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';
import { hubPart } from './helpers/hub';

// Suggest a ride (2026-11-18, migration 20261118210500; the user's pick: "Suggest a ride: a member sends staff a route, a
// breakfast spot or an idea, and sees only their own suggestions, each marked Planned or Done. When one happens, an Updates
// entry tells them."). The member's side is a card on the Community tab (member-hub.js) and its own page; the staff side is
// Community > Activities > Suggestions. All Supabase traffic is stubbed; what only the database enforces (own rows only, the
// limits, one Updates row per status) is checked in the migration's own text below and was run on a local Postgres.

const sess = { id: '2099-01-03', day: 'Saturday', session_date: '2099-01-03', capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' };
const feed = {
  ok: true, today: '2026-11-18',
  me: { kind: 'level', levels: [1, 2, 3], target: 2, chosen: true, n: 1, ends_on: '2026-11-30', sats: 4 },
  club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null,
};
const mine = [
  { id: 3, kind: 'breakfast', body: 'The bakery by the north park', status: 'done', reply: 'Booked for the ride of 6 December', at: '2026-11-15T07:00:00Z', day: '2026-11-15' },
  { id: 2, kind: 'route', body: 'A loop along the corniche\nand back through the old town', status: 'planned', reply: null, at: '2026-11-10T07:00:00Z', day: '2026-11-10' },
  { id: 1, kind: 'idea', body: 'A slower group for beginners', status: 'sent', reply: null, at: '2026-11-01T07:00:00Z', day: '2026-11-01' },
];
const okList = (rows: unknown[] = mine) => ({ ok: true, rows });
const absent = (fn: string) => ({ __rpcError: { status: 404, code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } });

function rpcLog(page: Page) {
  const out: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rpc\/(\w+)/); if (m && r.method() === 'POST') { let b = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ } out.push({ fn: m[1]!, body: b }); } });
  return out;
}
async function member(page: Page, fx: Fixtures = {}, path = '/') {
  const log = rpcLog(page);
  await stubSupabase(page, {
    sessions: [sess], customers: [], queue_entries: [], bikes: [],
    'rpc:community_member': true, 'rpc:hub_feed': feed, 'rpc:hub_pulse': { ok: true, member: true, dot: false, me: feed.me, goals: [], fresh: [] },
    'rpc:ride_suggestions_mine': okList(), ...fx,
  });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'female' });
  await page.goto(path);
  await waitForSb(page);
  return log;
}
async function openTab(page: Page) {
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
  await hubPart(page, 'club'); // the card sits in the tab's Club part (2026-11-20)
}
const card = (page: Page) => page.locator('#hub-body .rsg-card');
const pageEl = (page: Page) => page.locator('#hub-body #rsg-page');

test.describe('@customer:members Suggest a ride', () => {
  test('the card sits before the invitation and opens the page; the list is the member\'s own, with Sent, Planned, Done and the team\'s reply', async ({ page }) => {
    const log = await member(page);
    await openTab(page);
    await expect(card(page)).toContainText('Suggest a ride');
    // the Club part's last card but the invitation (2026-11-20)
    const order = await page.evaluate(`[...document.querySelectorAll('#hub-pane-club > .hub-card')].map(e=>e.classList.contains('rsg-card')?'sg':e.querySelector('[data-on-click*="_hubInvite"]')?'inv':'x')`) as string[];
    expect(order.slice(order.includes('inv') ? -2 : -1)).toEqual(order.includes('inv') ? ['sg', 'inv'] : ['sg']);
    expect(log.filter((x) => x.fn === 'ride_suggestions_mine')).toHaveLength(0); // nothing is read for the card itself
    await card(page).getByRole('button', { name: 'Make a suggestion' }).click();
    await expect(pageEl(page).locator('h2')).toHaveText('Suggest a ride');
    await expect.poll(() => log.filter((x) => x.fn === 'ride_suggestions_mine').length).toBe(1);
    expect(log.find((x) => x.fn === 'ride_suggestions_mine')!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec' });
    const rows = pageEl(page).locator('.rsg-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator('.rsg-st')).toHaveText('Done');
    await expect(rows.nth(0)).toContainText('Breakfast spot');
    await expect(rows.nth(0).locator('.rsg-reply')).toContainText('From the team');
    await expect(rows.nth(0).locator('.rsg-reply')).toContainText('Booked for the ride of 6 December');
    await expect(rows.nth(1).locator('.rsg-st')).toHaveText('Planned');
    await expect(rows.nth(1).locator('.rsg-reply')).toHaveCount(0);
    await expect(rows.nth(2).locator('.rsg-st')).toHaveText('Sent');
    // every control is named, nothing inline, no sideways scroll
    await expect(page.getByLabel('Your suggestion')).toBeVisible();
    await expect(pageEl(page).getByRole('group', { name: 'What is it?' }).locator('button')).toHaveText(['Route', 'Breakfast spot', 'Ride idea', 'Something else']);
    expect(await page.locator('#rsg-page [style], #rsg-page script').count()).toBe(0);
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
    // Close goes back to the feed
    await pageEl(page).getByRole('button', { name: 'Close' }).click();
    await expect(card(page)).toBeVisible();
  });

  test('Send: what is missing is said first, then the new one lands at the top with no toast', async ({ page }) => {
    const row = { id: 9, kind: 'route', body: 'Out to the lighthouse at sunrise', status: 'sent', reply: null, at: '2026-11-18T05:00:00Z', day: '2026-11-18' };
    const log = await member(page, { 'rpc:ride_suggest': { ok: true, row } });
    await openTab(page);
    await card(page).getByRole('button', { name: 'Make a suggestion' }).click();
    await expect(pageEl(page).locator('.rsg-row')).toHaveCount(3);
    const send = pageEl(page).getByRole('button', { name: 'Send' });
    await send.click();
    await expect(page.locator('#rsg-msg')).toHaveText('Please pick what it is.');
    await pageEl(page).getByRole('button', { name: 'Route' }).click();
    await expect(pageEl(page).getByRole('button', { name: 'Route' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#rsg-msg')).toHaveText('');
    await page.getByLabel('Your suggestion').fill('ab');
    await send.click();
    await expect(page.locator('#rsg-msg')).toHaveText('Please write at least 3 characters.');
    await expect(page.getByLabel('Your suggestion')).toHaveAttribute('aria-invalid', 'true');
    expect(log.filter((x) => x.fn === 'ride_suggest')).toHaveLength(0);
    await page.getByLabel('Your suggestion').fill('  Out to the lighthouse at sunrise  ');
    await send.click();
    await expect.poll(() => log.filter((x) => x.fn === 'ride_suggest').length).toBe(1);
    expect(log.find((x) => x.fn === 'ride_suggest')!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_kind: 'route', p_body: 'Out to the lighthouse at sunrise' });
    await expect(pageEl(page).locator('.rsg-row')).toHaveCount(4);
    await expect(pageEl(page).locator('.rsg-row').first()).toContainText('Out to the lighthouse at sunrise');
    await expect(pageEl(page).locator('.rsg-row').first().locator('.rsg-st')).toHaveText('Sent');
    await expect(page.getByLabel('Your suggestion')).toHaveValue('');
    await expect(pageEl(page).getByRole('button', { name: 'Route' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.toast:not(.quiet), #err-bar-el')).toHaveCount(0); // no bar, no toast after Send
  });

  test('each refusal is said in words, and what the member typed stays', async ({ page }) => {
    const said: [string, string][] = [['day', 'You can send 3 suggestions a day. Please try again tomorrow.'],
      ['open', 'You have 10 suggestions waiting for the team. You can send more once they have looked at them.'],
      ['member', 'Suggestions are for Community members.']];
    await member(page);
    let n = 0;
    await page.route('**/rest/v1/rpc/ride_suggest', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: said[Math.min(n++, said.length - 1)]![0] }) }));
    await openTab(page);
    await card(page).getByRole('button', { name: 'Make a suggestion' }).click();
    await pageEl(page).getByRole('button', { name: 'Ride idea' }).click();
    await page.getByLabel('Your suggestion').fill('A ride to the date farms');
    for (const [, words] of said) {
      await pageEl(page).getByRole('button', { name: 'Send' }).click();
      await expect(page.locator('#rsg-msg')).toHaveText(words);
      await expect(page.getByLabel('Your suggestion')).toHaveValue('A ride to the date farms');
      await expect(pageEl(page).getByRole('button', { name: 'Ride idea' })).toHaveAttribute('aria-pressed', 'true');
      await expect(pageEl(page).locator('.rsg-row')).toHaveCount(3);
    }
    expect(n).toBe(3);
  });

  test('a repaint of the tab keeps what the member is typing; the page speaks Arabic', async ({ page }) => {
    await member(page);
    await openTab(page);
    await card(page).getByRole('button', { name: 'Make a suggestion' }).click();
    await expect(pageEl(page).locator('.rsg-row')).toHaveCount(3);
    await pageEl(page).getByRole('button', { name: 'Something else' }).click();
    const box = page.getByLabel('Your suggestion');
    await box.fill('Water stops on the long');
    await box.press('End');
    await page.evaluate(`S._rsg.rows=S._rsg.rows.slice(0,1);_hubRender()`); // the list part changes, the form does not
    await expect(pageEl(page).locator('.rsg-row')).toHaveCount(1);
    await expect(box).toHaveValue('Water stops on the long');
    await expect(box).toBeFocused();
    await expect(pageEl(page).getByRole('button', { name: 'Something else' })).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(`S.lang='ar';_hubRender()`);
    await expect(pageEl(page).locator('h2')).toHaveText('اقترح جولة');
    await expect(page.locator('#rsg-text')).toHaveValue('Water stops on the long');
    await expect(pageEl(page).locator('.rsg-st').first()).toHaveText('نُفّذ');
  });

  test('a suggestion\'s Updates row opens the suggestions page, from the list and from a cold link', async ({ page }) => {
    const news = { id: 7, kind: 'info', title: 'We made your suggestion happen', body: '“The bakery by the north park”', at: '2026-11-17T09:00:00Z', url: '/members?src=push&hv=suggest', unread: true };
    const log = await member(page, { 'rpc:customer_updates_unread': { ok: true, n: 0, comm: 0 }, 'rpc:customer_updates': { ok: true, rows: [news] } }, '/account/updates');
    const row = page.locator('#inb-body .inb-list > li').first();
    await expect(row).toContainText('We made your suggestion happen');
    await row.locator('button.inb-row').click();
    await expect.poll(() => page.evaluate('S.custTab')).toBe('members');
    await expect(pageEl(page).locator('h2')).toHaveText('Suggest a ride');
    await expect(pageEl(page).locator('.rsg-row')).toHaveCount(3);
    expect(log.some((x) => x.fn === 'ride_suggestions_mine')).toBe(true);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await member(page, {}, '/members?src=push&hv=suggest');
    await expect(pageEl(page).locator('h2')).toHaveText('Suggest a ride');
    expect(new URL(page.url()).search).toBe(''); // src and hv come off the address
  });

  test('a database without it: the page closes and the card goes', async ({ page }) => {
    await member(page, { 'rpc:ride_suggestions_mine': absent('ride_suggestions_mine') });
    await openTab(page);
    await card(page).getByRole('button', { name: 'Make a suggestion' }).click();
    await expect(page.locator('#hub-pane-club')).toBeVisible(); // back on the part the card was in
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('#rsg-page')).toHaveCount(0);
  });

  test('every word of the page in all ten languages, Latin digits in Nepali and Bengali', async ({ page }) => {
    await member(page);
    await openTab(page);
    const bad = await page.evaluate(`Object.entries(HUB_T).filter(([k])=>k.startsWith('rsg')).filter(([k,v])=>v.length!==11||v.some(x=>!String(x).trim())).map(([k])=>k)`);
    expect(bad).toEqual([]);
    const native = await page.evaluate(`Object.entries(HUB_T).filter(([k])=>k.startsWith('rsg')).filter(([k,v])=>/[०-९০-৯]/.test(v[8]+v[9])).map(([k])=>k)`);
    expect(native).toEqual([]);
  });
});

// ── Staff: Community > Activities > Suggestions ─────────────────────────────────────────────────────────────────────
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'l@example.com', phone: '+966550000101', created_at: '2026-06-10T00:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'o@example.com', phone: '+966550000102', created_at: '2026-06-11T00:00:00Z' },
];
const sugs = [
  { id: 14, customer_id: 'c2', kind: 'breakfast', body: 'The bakery by the north park', status: 'new', reply: null, created_at: '2026-11-17T06:00:00Z', status_at: null },
  { id: 13, customer_id: 'c1', kind: 'route', body: 'A loop along the corniche', status: 'new', reply: null, created_at: '2026-11-16T06:00:00Z', status_at: null },
  { id: 12, customer_id: 'c1', kind: 'idea', body: 'A slower group for beginners', status: 'planned', reply: 'In December', created_at: '2026-11-10T06:00:00Z', status_at: '2026-11-11T06:00:00Z' },
  { id: 11, customer_id: 'c2', kind: 'other', body: 'Night rides in summer', status: 'closed', reply: null, created_at: '2026-11-01T06:00:00Z', status_at: '2026-11-02T06:00:00Z' },
];
async function staff(page: Page, fx: Fixtures = {}) {
  const log = rpcLog(page);
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], staff_options: [],
    tags: [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: 'green', locked: true }], customer_tags: [],
    titles: [], customer_titles: [], rotm_rounds: [], hub_goals: [], squads: [], squad_members: [], hub_photos: [], member_welcome: [], hub_posts: [], badges: [],
    ride_suggestions: sugs, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
  await page.waitForFunction('S._acAt>0&&!S._acBusy&&!!S._ac&&!!S._acSg');
  return log;
}
const tab = (page: Page) => page.locator('#tab-community');

test.describe('@staff:community Suggestions', () => {
  test('the pill counts the new ones; filters, newest first; the member\'s name and mobile in full, the name opens the account window', async ({ page }) => {
    await staff(page);
    const pill = tab(page).locator('.filter-pill', { hasText: /^Suggestions/ });
    await expect(pill).toHaveText('Suggestions (2)');
    await pill.click();
    await expect(tab(page).locator('.filter-pill', { hasText: /^New \(/ })).toHaveText('New (2)');
    await expect(tab(page).locator('.filter-pill', { hasText: /^Planned/ })).toHaveText('Planned (1)');
    await expect(tab(page).locator('.filter-pill', { hasText: /^Closed/ })).toHaveText('Closed (1)');
    const cards = tab(page).locator('[data-sg]');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('Omar Saleh');
    await expect(cards.nth(0)).toContainText('+966550000102');
    await expect(cards.nth(0)).toContainText('Breakfast spot');
    await expect(cards.nth(0)).toContainText('The bakery by the north park');
    await expect(cards.nth(1)).toContainText('Lina Haddad');
    await expect(cards.nth(1).getByLabel('Reply to the member')).toBeVisible();
    await page.evaluate(`window.__acct=[];window.openAccountHistory=(id)=>{window.__acct.push(id);}`);
    await cards.nth(1).getByRole('button', { name: 'Lina Haddad' }).click();
    await expect.poll(() => page.evaluate('window.__acct')).toEqual(['c1']);
    await tab(page).locator('.filter-pill', { hasText: /^Closed/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Night rides in summer');
  });

  test('Planned and Done change the status through the one function; the reply is saved alone and survives a repaint', async ({ page }) => {
    const log = await staff(page, {
      'rpc:staff_ride_suggestion_set': { id: 13, customer_id: 'c1', kind: 'route', body: 'A loop along the corniche', status: 'planned', reply: null, created_at: '2026-11-16T06:00:00Z', status_at: '2026-11-18T06:00:00Z' },
    });
    await tab(page).locator('.filter-pill', { hasText: /^Suggestions/ }).click();
    const lina = tab(page).locator('[data-sg="13"]');
    await lina.getByRole('button', { name: 'Planned' }).click();
    await expect.poll(() => log.filter((x) => x.fn === 'staff_ride_suggestion_set').length).toBe(1);
    expect(log.find((x) => x.fn === 'staff_ride_suggestion_set')!.body).toEqual({ p_sid: 13, p_status: 'planned', p_reply: null });
    await expect(tab(page).locator('.filter-pill', { hasText: /^Suggestions/ })).toHaveText('Suggestions (1)');
    await expect(tab(page).locator('[data-sg]')).toHaveCount(1); // it left New
    await tab(page).locator('.filter-pill', { hasText: /^Planned/ }).click();
    const moved = tab(page).locator('[data-sg="13"]');
    await expect(moved.getByRole('button', { name: 'Planned' })).toBeDisabled();
    await moved.getByLabel('Reply to the member').fill('We ride it on 6 December');
    await page.evaluate('renderCommunity()');
    await expect(moved.getByLabel('Reply to the member')).toHaveValue('We ride it on 6 December');
    await moved.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => log.filter((x) => x.fn === 'staff_ride_suggestion_set').length).toBe(2);
    expect(log.filter((x) => x.fn === 'staff_ride_suggestion_set')[1]!.body).toEqual({ p_sid: 13, p_status: null, p_reply: 'We ride it on 6 December' });
  });

  test('a refusal is said and nothing moves; a viewer sees no buttons; a database without the table hides the pill', async ({ page }) => {
    await staff(page, { 'rpc:staff_ride_suggestion_set': { __rpcError: { status: 403, code: '42501', message: 'FORBIDDEN' } } });
    await tab(page).locator('.filter-pill', { hasText: /^Suggestions/ }).click();
    await tab(page).locator('[data-sg="14"]').getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await expect(tab(page).locator('[data-sg]')).toHaveCount(2);
    await page.evaluate(`S._myEdit=['bookings'];renderCommunity()`);
    await expect(tab(page).locator('[data-sg="14"] button', { hasText: /^(Planned|Done|Close)$/ })).toHaveCount(0);
    await expect(tab(page).locator('[data-sg="14"] textarea')).toHaveCount(0);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], staff_options: [], tags: [], customer_tags: [], titles: [], customer_titles: [],
      rotm_rounds: [], hub_goals: [], squads: [], squad_members: [], hub_photos: [], member_welcome: [], hub_posts: [], badges: [] });
    await page.route('**/rest/v1/ride_suggestions*', (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table \'public.ride_suggestions\' in the schema cache' }) }));
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
    await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
    await page.waitForFunction('S._acAt>0&&!S._acBusy&&!!S._ac&&S._acSgMissing===true');
    await expect(tab(page).locator('.filter-pill', { hasText: /^Suggestions/ })).toHaveCount(0);
    await expect(tab(page).locator('.filter-pill', { hasText: /^Challenges/ })).toBeVisible();
  });
});

// ── The migration's own text: what only the database can hold ──────────────────────────────────────────────────────
test.describe('@build Suggest a ride migration', () => {
  const sql = readFileSync(resolve(__dirname, '../supabase/migrations/20261118210500_ride_suggestions.sql'), 'utf8');
  test('own rows only, members only, the limits, staff rights, one Updates row per status, RLS and grants', () => {
    expect(sql).toMatch(/create table if not exists public\.ride_suggestions/);
    expect(sql).toMatch(/alter table public\.ride_suggestions enable row level security;/);
    expect(sql).toMatch(/revoke all on public\.ride_suggestions from public, anon, authenticated;/);
    expect(sql).toMatch(/create policy "staff read" on public\.ride_suggestions for select using \(\(select _staff_mod\('community'\)\)\);/);
    expect(sql).toMatch(/s\.customer_id = any\(_accts_of\(p_id\)\)/); // the member's list: their own accounts only
    expect(sql).toMatch(/if not _member_active\(p_id\) then return jsonb_build_object\('ok', false, 'error', 'member'\)/);
    expect(sql).toMatch(/interval '1 day'\) >= 3 then/);
    expect(sql).toMatch(/s\.status = 'new'\) >= 10 then/);
    expect(sql).toMatch(/if not \(select _staff_mod\('community', true\)\) then raise exception 'FORBIDDEN'/);
    expect(sql).toMatch(/when s\.status in \('planned', 'done'\) then s\.status else 'sent' end/); // a closed one reads as sent
    expect(sql).toMatch(/before update of status on public\.ride_suggestions\s+for each row when \(old\.status is distinct from new\.status\)/);
    expect(sql).toMatch(/new\.status = any\(new\.told\)/);
    expect(sql).toMatch(/'hub-sug-' \|\| new\.id \|\| '-' \|\| new\.status/);
    expect(sql).toMatch(/on conflict \(customer_id, tag\) do nothing;/);
    expect((sql.match(/\('sug(plan|done)', '(en|ar|fr|es|pt|ur|hi|tl|ne|bn)'/g) || []).length).toBe(20);
    expect(sql).toMatch(/grant execute on function public\.ride_suggest\(text, text, text, text\) to anon, authenticated;/);
    expect(sql).toMatch(/revoke all on function public\.staff_ride_suggestion_set\(bigint, text, text\) from public, anon;/);
    expect(sql).toMatch(/revoke all on function public\._updates_suggestion\(\) from public, anon, authenticated;/);
    expect(sql).toMatch(/values \('20261118210500', 'ride_suggestions'\)/);
    expect((sql.match(/security definer set search_path to 'public'/g) || []).length).toBe(4);
  });
});
