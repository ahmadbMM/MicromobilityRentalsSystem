import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// The Updates list (new features build F3, 2026-11-13): a page of Account, /account/updates, listing every message the
// app addressed to the rider, newest first, each with a title, its text, its date and where it leads. Its rows are in the
// database with push on or off (migration 20261114010300), a rider reads only their own, and opening the page marks them
// read. Unread rows light the Community tab's dot (members) and set the app icon's badge. The ways in are a row on
// Account > Notifications and, for members, a button on the Community tab's staff card. All Supabase traffic is stubbed;
// what only the database can enforce is checked in the migration's own text.

const TOKEN = 'a'.repeat(32);
const rows = [
  { id: 6, kind: 'waitlist', title: 'A place is free for you', body: 'Saturday Social Ride: take it within 30 minutes', at: '2026-11-12T18:05:00Z', url: '/?claim=' + TOKEN, unread: true },
  { id: 5, kind: 'reminder', title: 'Ride tomorrow', body: 'Saturday Social Ride, meet at 06:00', at: '2026-11-12T18:00:00Z', url: '/my-bookings', unread: true },
  { id: 4, kind: 'note', title: 'A note from the team', body: 'Bring water this Saturday', at: '2026-11-10T09:00:00Z', url: '/members?src=push', unread: false },
  { id: 3, kind: 'challenge', title: 'Your new challenge is ready', body: 'Open Community to see this month\'s challenge', at: '2026-11-01T07:00:00Z', url: '/members?src=push', unread: false },
  { id: 2, kind: 'info', title: 'MicroMobility Volunteers', body: 'You are confirmed for Saturday.', at: '2026-10-20T09:00:00Z', url: 'https://volunteer.micromobility.sa/#updates', unread: false },
  { id: 1, kind: 'info', title: 'MicroMobility', body: 'An older message', at: '2026-10-01T09:00:00Z', url: 'https://example.com/elsewhere', unread: false },
];
const list = (r: unknown[] = rows) => ({ ok: true, rows: r });
const unread = (n: number, comm = 0) => ({ ok: true, n, comm });
const absent = (fn: string) => ({ __rpcError: { status: 404, code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } });
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const feed = { ok: true, today, me: { kind: 'level', target: 4, n: 1, ends_on: '2099-01-28', sats: 4, levels: [2, 3, 4], chosen: true }, club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null };
const pulse = { ok: true, member: true, dot: false, me: feed.me, goals: [], fresh: [] };

// Every RPC the page sent, with its body.
function rpcLog(page: Page) {
  const out: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rpc\/(\w+)/); if (m && r.method() === 'POST') { let b = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ } out.push({ fn: m[1]!, body: b }); } });
  return out;
}
const sent = (log: { fn: string }[], fn: string) => log.filter((x) => x.fn === fn).length;

// The app icon's badge, as the page set it: a number, or 0 for cleared.
async function badgeSpy(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __badge: number[] };
    w.__badge = [];
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: (n: number) => { w.__badge.push(n); return Promise.resolve(); } });
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: () => { w.__badge.push(0); return Promise.resolve(); } });
  });
}
const badge = (page: Page) => page.evaluate('window.__badge') as Promise<number[]>;

async function boot(page: Page, fx: Fixtures = {}, o: { member?: boolean; path?: string } = {}) {
  const log = rpcLog(page);
  await badgeSpy(page);
  await stubSupabase(page, {
    sessions: [], queue_entries: [], bikes: [],
    'rpc:community_member': !!o.member, 'rpc:hub_pulse': o.member ? pulse : { ok: true, member: false }, 'rpc:hub_feed': feed,
    'rpc:customer_updates_unread': unread(0), 'rpc:customer_updates': list(),
    ...fx,
  });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'female' });
  await page.goto(o.path || '/');
  await waitForSb(page);
  return log;
}
const at = (page: Page) => new URL(page.url()).pathname;
const item = (page: Page, i: number) => page.locator('#inb-body .inb-list > li').nth(i);
const dotOn = (page: Page) => page.evaluate(`['#customer-tab-nav [data-ctab="members"]','#bnav-members'].map(q=>{const b=document.querySelector(q);return !!b&&b.classList.contains('has-dot')})`);

test.describe('@customer:account the Updates list', () => {
  test('the page: every message newest first, each with its title, text, date and where it leads', async ({ page }) => {
    const log = await boot(page, {}, { path: '/account/updates' });
    await expect(page.locator('#acc-pg-updates-h')).toHaveText('Updates');
    await expect(page.locator('#inb-body .inb-list > li')).toHaveCount(6);
    // own rows only: the read carries this rider's id and token and the page's language, and names nobody else
    expect(log.find((x) => x.fn === 'customer_updates')!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_lang: 'en' });
    // the order the database gave (newest first), never re-sorted
    expect(await page.locator('#inb-body .inb-t > bdi').allTextContents()).toEqual(rows.map((r) => r.title));
    const day = (d: string) => page.evaluate(`shortDate('${d}')`) as Promise<string>;
    // a reminder: title, text, the day it was written, and Bookings
    const rem = item(page, 1);
    await expect(rem.locator('.inb-t')).toContainText('Ride tomorrow');
    await expect(rem.locator('.inb-b')).toHaveText('Saturday Social Ride, meet at 06:00');
    await expect(rem.locator('.inb-m')).toHaveText(`${await day('2026-11-12')} · Bookings`);
    await expect(rem.locator('button.inb-row')).toHaveCount(1);
    // a freed place: its row opens the claim
    await expect(item(page, 0).locator('.inb-m')).toContainText('Take your place');
    // the Community's are a member's: for anyone else the row leads nowhere and is not a button
    await expect(item(page, 2).locator('.inb-m')).toHaveText(await day('2026-11-10'));
    await expect(item(page, 2).locator('button, a')).toHaveCount(0);
    // the volunteer portal: a link of its own, in a new tab, said so
    const vol = item(page, 4).locator('a.inb-row');
    await expect(vol).toHaveAttribute('href', 'https://volunteer.micromobility.sa/#updates');
    await expect(vol).toHaveAttribute('target', '_blank');
    await expect(vol).toHaveAttribute('rel', /noopener/);
    await expect(vol.locator('.inb-m')).toContainText('Volunteering');
    await expect(vol.locator('.inb-m .sr-only')).toContainText(await page.evaluate(`t('opensNewTab')`) as string);
    // an address that is not the app's leads nowhere
    await expect(item(page, 5).locator('button, a')).toHaveCount(0);
    // a page: no bar, no toast, no hint line
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0);
    await expect(page.locator('#acc-pg-updates .cu-card-sub6, #acc-pg-updates .cu-type-hint')).toHaveCount(0);
    // a message's own words are text, never markup
    expect(await page.locator('#inb-body script, #inb-body [style]').count()).toBe(0);
  });

  test('a row leads where it says: Bookings, the claim of a freed place, and for a member the Community tab', async ({ page }) => {
    const log = await boot(page, { 'rpc:customer_claim_get': { ok: false } }, { path: '/account/updates', member: true });
    await expect(page.locator('#inb-body .inb-list > li')).toHaveCount(6);
    await expect(item(page, 2).locator('.inb-m')).toContainText('Community');
    await item(page, 2).locator('button.inb-row').click();
    await expect.poll(() => page.evaluate('S.custTab')).toBe('members');
    expect(at(page)).toBe('/members');
    await page.evaluate(`setCustTab('account','updates')`);
    await item(page, 0).locator('button.inb-row').click();
    await expect.poll(() => sent(log, 'customer_claim_get')).toBe(1);
    expect(log.find((x) => x.fn === 'customer_claim_get')!.body).toEqual({ p_token: TOKEN });
    await expect(page.locator('#wl-claim [role="dialog"] #wlc-title')).toHaveText('This offer has ended');
    await page.evaluate('_wlcClose()');
    await item(page, 1).locator('button.inb-row').click();
    await expect.poll(() => page.evaluate('S.custTab')).toBe('myrides');
    expect(at(page)).toBe('/my-bookings');
  });

  test('unread to read: the count on the two rows, the new rows marked once, and opening the list clears it all', async ({ page }) => {
    const log = await boot(page, { 'rpc:customer_updates_unread': unread(2) });
    await expect.poll(() => sent(log, 'customer_updates_unread')).toBe(1);
    expect(log.find((x) => x.fn === 'customer_updates_unread')!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec' });
    // the app icon's badge says how many, and nothing has read the list yet
    await expect.poll(() => badge(page)).toEqual([2]);
    expect(sent(log, 'customer_updates')).toBe(0);
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#acc-v-notifications')).toHaveText('2');
    await page.evaluate(`_accOpen('notifications')`);
    expect(at(page)).toBe('/account/notifications');
    const way = page.locator('#acc-pg-notifications #acc-r-updates');
    await expect(way).toBeVisible();
    await expect(way.locator('.acc-row-t')).toHaveText('Updates');
    await expect(way.locator('.acc-row-v')).toHaveText('2');
    // still unread: looking at Notifications is not opening the list
    expect(sent(log, 'customer_updates')).toBe(0);
    await way.click();
    await expect.poll(() => at(page)).toBe('/account/updates');
    await expect(page.locator('#inb-body .inb-list > li')).toHaveCount(6);
    expect(sent(log, 'customer_updates')).toBe(1);
    // the two that were unread carry the mark, said as "New"; the rest none
    await expect(page.locator('#inb-body .inb-row.inb-unread')).toHaveCount(2);
    await expect(item(page, 0).locator('.inb-new .sr-only')).toHaveText('New');
    await expect(item(page, 2).locator('.inb-new')).toHaveCount(0);
    // read now: the icon's badge is cleared and both counts are gone, with no second count asked
    await expect.poll(() => badge(page)).toEqual([2, 0]);
    await expect(page.locator('#acc-v-updates')).toHaveText('');
    await expect(page.locator('#acc-v-notifications')).not.toHaveText('2');
    expect(sent(log, 'customer_updates_unread')).toBe(1);
    // Back from the list is Notifications, the page that opened it
    await page.goBack();
    await expect.poll(() => at(page)).toBe('/account/notifications');
    await expect(way.locator('.acc-row-v')).toHaveText('');
  });

  test('a member: unread updates light the Community tab\'s dot, the staff card carries the way in, and reading them puts the dot out', async ({ page }) => {
    const log = await boot(page, { 'rpc:customer_updates_unread': unread(3, 1) }, { member: true });
    await expect.poll(() => sent(log, 'customer_updates_unread')).toBe(1);
    // the pulse itself lit nothing (dot: false): the unread updates did
    await expect.poll(() => dotOn(page)).toEqual([true, true]);
    await expect.poll(() => badge(page)).toEqual([3]);
    await page.evaluate(`_commTap()`);
    const btn = page.locator('#hub-body #hub-inb');
    await expect(btn).toBeVisible();
    // a tap while the dot is lit is the dot's, whichever lit it
    await expect.poll(() => log.find((x) => x.fn === 'hub_feed')?.body.p_src).toBe('dot');
    // the Community message among them is read by opening the tab (its own read clears it on the server): two are left
    await expect(btn).toHaveText('Updates · 2');
    await expect.poll(() => badge(page)).toEqual([3, 2]);
    // on the staff card, whichever it is (here the tip of the week)
    expect(await btn.evaluate((el) => !!el.closest('.hub-card') && !!el.closest('.hub-card')!.querySelector('.hub-line'))).toBe(true);
    await btn.click();
    await expect.poll(() => at(page)).toBe('/account/updates');
    await expect(page.locator('#inb-body .inb-list > li')).toHaveCount(6);
    await expect.poll(() => badge(page)).toEqual([3, 2, 0]);
    expect(await dotOn(page)).toEqual([false, false]);
    // back on Community the button stays, with no count
    await page.evaluate(`setCustTab('members')`);
    await expect(page.locator('#hub-body #hub-inb')).toHaveText('Updates');
    await page.evaluate(`setCustTab('register')`);
    expect(await dotOn(page)).toEqual([false, false]);
  });

  test('the empty state: one card, no error', async ({ page }) => {
    await boot(page, { 'rpc:customer_updates': list([]) }, { path: '/account/updates' });
    const card = page.locator('#inb-body .inb-empty');
    await expect(card).toBeVisible();
    await expect(card).toHaveText('No updates yet');
    await expect(page.locator('#inb-body .inb-list, #inb-body button')).toHaveCount(0);
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0);
  });

  test('a rider with push off still gets rows: no key, no switches, and the list is there', async ({ page }) => {
    const log = await boot(page, { 'rpc:customer_updates_unread': unread(1) }, { path: '/account/notifications' });
    // push is dormant in this build (no public key): no switch is drawn and nothing subscribes
    expect(await page.evaluate('VAPID_PUBLIC_KEY')).toBe('');
    await expect(page.locator('#acc-push input')).toHaveCount(0);
    await expect(page.locator('#acc-pg-notifications #acc-r-updates')).toBeVisible();
    await page.locator('#acc-pg-notifications #acc-r-updates').click();
    await expect(page.locator('#inb-body .inb-list > li')).toHaveCount(6);
    expect(sent(log, 'customer_push_subscribe')).toBe(0);
  });

  test('before the database has it: no row, no button, no dot, and the page itself is empty, never an error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const log = await boot(page, { 'rpc:customer_updates_unread': absent('customer_updates_unread'), 'rpc:customer_updates': absent('customer_updates') }, { member: true });
    await expect.poll(() => sent(log, 'customer_updates_unread')).toBe(1);
    await expect.poll(() => page.evaluate('S._inbOff')).toBe(true);
    expect(await dotOn(page)).toEqual([false, false]);
    await page.evaluate(`_commTap()`);
    await expect(page.locator('#hub-body .hub-card').first()).toBeVisible();
    await expect(page.locator('#hub-body button#hub-inb')).toHaveCount(0);
    await page.evaluate(`setCustTab('account','notifications')`);
    await expect(page.locator('#acc-r-updates')).toBeHidden();
    await expect(page.locator('#acc-pg-notifications .inb-entry')).toBeHidden();
    // never asked again
    await page.evaluate(`_commNavPaint()`);
    expect(sent(log, 'customer_updates_unread')).toBe(1);
    // its address, opened by hand: the empty card
    await page.evaluate(`setCustTab('account','updates')`);
    await expect(page.locator('#inb-body .inb-empty')).toHaveText('No updates yet');
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a read that fails says so with Try again, and the second try draws the list', async ({ page }) => {
    await boot(page, { 'rpc:customer_updates': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } }, { path: '/account/updates' });
    const card = page.locator('#inb-body .inb-card');
    await expect(card).toContainText('We could not load this page');
    await page.unroute('**://*.supabase.co/**');
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], 'rpc:customer_updates': list(rows.slice(0, 2)) });
    await card.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('#inb-body .inb-list > li')).toHaveCount(2);
  });

  test('its own words: all ten languages, and the list is asked for in the page\'s language', async ({ page }) => {
    const log = await boot(page, { 'rpc:customer_updates': list(rows.slice(0, 1)) }, { path: '/account/updates' });
    await expect(page.locator('#inb-body .inb-list > li')).toHaveCount(1);
    const bad = await page.evaluate(`Object.entries(INB_T).filter(([k,v])=>v.length!==INB_LANGS.length||INB_LANGS.length!==10||v.some(x=>!String(x).trim())).map(([k])=>k)`);
    expect(bad).toEqual([]);
    // Latin digits in every language
    expect(await page.evaluate(`Object.values(INB_T).flat().filter(x=>/[\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F\\u09E6-\\u09EF]/.test(x))`)).toEqual([]);
    await page.evaluate(`setLang('ar')`);
    await expect.poll(() => log.filter((x) => x.fn === 'customer_updates').map((x) => x.body.p_lang)).toEqual(['en', 'ar']);
    await expect(page.locator('#acc-pg-updates-h')).toHaveText('التحديثات');
    await expect(item(page, 0).locator('.inb-m')).toContainText('أكّد مكانك');
    await expect(item(page, 0).locator('.inb-new .sr-only')).toHaveText('جديد');
  });

  test('a phone: the rows wrap inside the page, nothing runs off the side', async ({ page }) => {
    const long = { ...rows[1]!, title: 'A very long title that has to wrap because it does not fit on one line of a phone', body: 'x'.repeat(120) + ' ' + 'A long sentence that keeps going so the row must grow taller instead of wider. '.repeat(3) };
    await boot(page, { 'rpc:customer_updates': list([long, ...rows]) }, { path: '/account/updates' });
    await expect(page.locator('#inb-body .inb-list > li')).toHaveCount(7);
    const over = await page.evaluate(`(()=>{const b=document.getElementById('inb-body'),r=b.getBoundingClientRect();return{page:document.documentElement.scrollWidth-document.documentElement.clientWidth,list:b.scrollWidth-b.clientWidth,right:Math.round(r.right-window.innerWidth)}})()`) as { page: number; list: number; right: number };
    expect(over.page).toBeLessThanOrEqual(0);
    expect(over.list).toBeLessThanOrEqual(0);
    expect(over.right).toBeLessThanOrEqual(0);
    // a row is a comfortable target
    const h = await item(page, 1).locator('.inb-row').evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(56);
  });

  test('every kind of message wears a drawn glyph, the recap too', async ({ page }) => {
    const kinds = ['reminder', 'change', 'waitlist', 'challenge', 'recap', 'note', 'info'];
    await boot(page, { 'rpc:customer_updates': list(kinds.map((kind, i) => ({ id: 20 - i, kind, title: kind, body: '', at: '2026-11-12T18:00:00Z', url: '', unread: false }))) }, { path: '/account/updates' });
    await expect(page.locator('#inb-body .inb-list > li')).toHaveCount(kinds.length);
    // a name the rider icon set lacks draws an empty svg
    expect(await page.locator('#inb-body .inb-ic svg').evaluateAll((els) => els.map((el) => el.childElementCount > 0))).toEqual(kinds.map(() => true));
  });

  test('signing out clears the app icon\'s badge and forgets the count and the list: a shared phone starts the next person with none', async ({ page }) => {
    await boot(page, { 'rpc:customer_updates_unread': unread(3) });
    await expect.poll(() => badge(page)).toEqual([3]);
    await page.evaluate('doLogout(true)');
    await expect.poll(() => badge(page)).toEqual([3, 0]);
    expect(await page.evaluate('[S._inb, S._inbList]')).toEqual([null, null]);
  });

  test('two pages deep: Back from the list is Notifications, Back again the menu, and the browser\'s Back then leaves the account', async ({ page }) => {
    await boot(page, { 'rpc:customer_updates_unread': unread(1) });
    const start = at(page);
    await page.evaluate(`setCustTab('account')`);
    expect(at(page)).toBe('/account');
    await page.evaluate(`_accOpen('notifications')`);
    await page.locator('#acc-pg-notifications #acc-r-updates').click();
    await expect.poll(() => at(page)).toBe('/account/updates');
    await page.evaluate('custBack()');
    await expect.poll(() => at(page)).toBe('/account/notifications');
    await page.evaluate('custBack()');
    await expect.poll(() => at(page)).toBe('/account');
    await expect.poll(() => page.evaluate('S.accPage')).toBe(null);
    // the menu was reached by going back, not by a new entry on top of the two pages
    await page.goBack();
    await expect.poll(() => at(page)).toBe(start);
  });
});

// ── What only the database can enforce, read in the migration itself ───────────────────────────────
test.describe('@customer:account the Updates list: the database\'s rules', () => {
  const sql = readFileSync(resolve(__dirname, '../supabase/migrations/20261114010300_updates_list.sql'), 'utf8');
  // One function's text, from its header to its last line.
  const fn = (name: string) => {
    const a = sql.indexOf(`create or replace function public.${name}(`);
    expect(a, name).toBeGreaterThan(-1);
    const b = sql.indexOf('end $$;', a);
    return sql.slice(a, b);
  };

  test('own rows only: both reads check the rider\'s token first and read nothing but their own accounts\' rows', () => {
    for (const name of ['customer_updates', 'customer_updates_unread']) {
      const f = fn(name);
      const body = f.slice(f.indexOf('begin'));
      expect(body.trimStart().slice(5).trimStart(), name).toMatch(/^if p_id is null or p_token is null or not _cust_token_ok\(p_id, p_token\) then return jsonb_build_object\('ok', false, 'error', 'denied'\); end if;/);
      expect(f, name).toMatch(/security definer set search_path to 'public'/);
      // every read and write of the store is narrowed to the caller
      const uses = f.match(/(from|update) push_outbox[\s\S]*?;/g) || [];
      expect(uses.length, name).toBeGreaterThan(0);
      for (const u of uses) expect(u, name).toMatch(/customer_id = any\((v_accts|_accts_of\(p_id\))\)/);
    }
    expect(fn('customer_updates')).toContain('v_accts := _accts_of(p_id);');
    // no argument names another rider
    expect(sql).toContain('create or replace function public.customer_updates(p_id text, p_token text, p_lang text default \'en\')');
    expect(sql).toContain('create or replace function public.customer_updates_unread(p_id text, p_token text)');
    // riders call them with the anon key; the store itself stays closed and no table is added
    expect(sql).toContain('grant execute on function public.customer_updates(text, text, text) to anon, authenticated;');
    expect(sql).toContain('grant execute on function public.customer_updates_unread(text, text) to anon, authenticated;');
    expect(sql).not.toMatch(/grant [^;]* on (table )?public\.push_outbox/i);
    expect(sql).not.toMatch(/create table/i);
  });

  test('unread to read, and ninety days: the list marks what it returned, the count ignores the read, a daily job drops the old', () => {
    const f = fn('customer_updates');
    expect(f).toMatch(/update push_outbox set read_at = now\(\) where customer_id = any\(v_accts\) and read_at is null;/);
    expect(f).toContain("o.created_at > now() - interval '90 days'");
    expect(f).toMatch(/order by o\.created_at desc, o\.id desc/);
    const n = fn('customer_updates_unread');
    expect(n).toContain('o.read_at is null');
    expect(n).toContain("o.created_at > now() - interval '90 days'");
    // a Community message older than the member's last open of the tab counts as read, in both
    for (const x of [f, n]) expect(x).toContain("not (o.cat = 'community' and v_seen is not null and o.created_at <= v_seen)");
    expect(fn('_updates_sweep')).toContain("delete from push_outbox where created_at < now() - interval '90 days';");
    expect(sql).toContain("select cron.schedule('mm-updates-sweep', '20 1 * * *', 'select public._updates_sweep()');");
  });

  test('a rider with push off still gets rows: the gate keeps every row, and no writer asks for a subscription', () => {
    const gate = fn('_push_outbox_gate');
    // it dropped the row (return null) for a switch that was off; now the row stays and only its push is held back
    expect(gate).not.toMatch(/return null/);
    expect(gate).toContain("new.result := 'inapp';");
    expect(gate).toContain('new.sent_at := now();');
    expect(gate).toMatch(/return new;\s*$/);
    // consent decides the push exactly as before
    expect(gate).toContain("new.cat = 'community' and not exists (select 1 from push_prefs p where p.customer_id = new.customer_id and p.community)");
    expect(gate).toContain("new.cat = 'rides' and exists (select 1 from push_prefs p where p.customer_id = new.customer_id and not p.rides)");
    // the writers address everyone: a subscription and the switches are the gate's business alone
    for (const name of ['_hub_push_tick', '_session_change_push', '_updates_wl_in', '_updates_wl_offer', '_updates_note']) {
      const f = fn(name);
      expect(f, name).not.toContain('push_subscriptions');
      expect(f, name).toContain('insert into push_outbox');
      expect(f, name).toMatch(/security definer set search_path to 'public'/);
    }
    for (const name of ['_hub_push_tick', '_session_change_push']) expect(fn(name), name).not.toContain('push_prefs');
    // the reminder still tells staff to skip a rider only when it really goes out as a push
    const tick = fn('_hub_push_tick');
    // (in a block of its own: a mark the table refuses never undoes the run's rows)
    expect(tick).toMatch(/returning sent_at into v_sent;[\s\S]*?if v_sent is null then\s+begin\s+update queue_entries set reminded_at = now\(\), reminded_kind = 'push'[^;]*;\s+exception when others then\s+null;/);
    // and the table takes that mark: its check named staff's two kinds alone and refused 'push', which stopped the whole
    // run. Widened here, before the function is made.
    const drop = sql.indexOf('alter table public.queue_entries drop constraint if exists queue_entries_reminded_kind_chk;');
    const add = sql.indexOf("add constraint queue_entries_reminded_kind_chk\n  check (reminded_kind is null or reminded_kind in ('24h', '2h', 'push'));");
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
    expect(add).toBeLessThan(sql.indexOf('create or replace function public._hub_push_tick('));
  });

  test('a session with no bike is never called a ride: its reminder and its change notice have words of their own', () => {
    // the kinds the app gives no bike (KIND_TRAITS) are the kinds the database says "session" for
    const src = readFileSync(resolve(__dirname, '../app.src.html'), 'utf8');
    const noBike = [...src.match(/const KIND_TRAITS=\{(.*?)\};/)![1]!.matchAll(/(\w+):\{bike:false/g)].map((m) => m[1]).sort();
    expect(noBike.length).toBeGreaterThan(5);
    const keyFn = sql.slice(sql.indexOf('create or replace function public._updates_key('), sql.indexOf('revoke all on function public._updates_key('));
    expect([...keyFn.match(/_session_kind\(p_session\) in \(([^)]*)\)/)![1]!.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort()).toEqual(noBike);
    expect(keyFn).toMatch(/then p_key \|\| '_s' else p_key end;/);
    expect(keyFn).toMatch(/security definer set search_path to 'public'/);
    expect(sql).toContain('revoke all on function public._updates_key(text, text) from public, anon, authenticated;');
    expect(readFileSync(resolve(__dirname, '../supabase/checks/security-attributes.sql'), 'utf8')).toContain("('_updates_key', true,");
    // both writers ask it, write the words it names, and store that key, so the list says the same words
    const tick = fn('_hub_push_tick'), chg = fn('_session_change_push');
    expect(tick).toContain("v_key := _updates_key('remind', r.sid);");
    expect(tick).toContain('_push_text(r.customer_id, v_key,');
    expect(tick).toContain("'rides', v_key, array[v_sess, v_at]");
    expect(chg).toContain("v_key := _updates_key('change', new.id);");
    expect(chg).toContain('_push_text(q.customer_id, v_key,');
    expect(chg).toMatch(/'rides',\s+v_key, array\[/);
    for (const f of [tick, chg]) expect(f).not.toMatch(/_push_text\([a-z]\.customer_id, '(remind|change)'/);
    // the reminder keeps what 20261114010200_still_coming changed in this function (it runs first, and this file replaces
    // the whole function): a session with no bike takes that file's 'remind:nc' words, and the reminder opens the ticket
    expect(tick).toContain("if v_key = 'remind_s' then v_key := 'remind:nc'; end if;");
    expect(tick).toContain("'/my-bookings?tk=' || r.id, 'rides', v_key");
    expect(sql).not.toContain("('remind_s',");
    // the words: all ten languages, the same placeholders as the ride's, and no ride, bike or cycling in any of them
    for (const [key, holds] of [['change_s', ['{0}']]] as const) {
      const found = [...sql.matchAll(new RegExp(`\\('${key}', '([a-z]{2})', '((?:[^']|'')*)', '((?:[^']|'')*)'\\)`, 'g'))];
      expect(found.map((m) => m[1]).sort(), key).toEqual(['ar', 'bn', 'en', 'es', 'fr', 'hi', 'ne', 'pt', 'tl', 'ur']);
      for (const m of found) {
        expect(m[2]!.trim(), `${key} ${m[1]}`).not.toBe('');
        for (const h of holds) expect(m[3], `${key} ${m[1]}`).toContain(h);
        expect(`${m[2]} ${m[3]}`, `${key} ${m[1]}`).not.toMatch(/ride|bike|cycl|v[ée]lo|bici|sortie|salida|passeio|رحل|جول|دراج|رائیڈ|سائیکل|राइड|साइकिल|রাইড|সাইকেল/i);
      }
    }
  });

  test('every kind has a writer, and the three new messages are written in all ten languages', () => {
    const tick = fn('_hub_push_tick');
    for (const tag of ["'rem-' || r.id", "'hub-ch-' || to_char(v_month, 'YYYYMM')", "'hub-rc-' || r.pid"]) expect(tick).toContain(tag);
    expect(fn('_session_change_push')).toContain("'chg-' || new.id");
    expect(fn('_updates_wl_in')).toContain("'booking-' || new.id");
    expect(fn('_updates_wl_offer')).toContain("'offer-' || new.id");
    expect(fn('_updates_note')).toContain("'hub-note-' || new.id");
    // and the list names each kind from its tag
    const f = fn('customer_updates');
    for (const k of ['reminder', 'change', 'waitlist', 'challenge', 'recap', 'note', 'info']) expect(f).toContain(`'${k}'`);
    for (const key of ['note', 'wlin', 'wloffer']) {
      const langs = [...sql.matchAll(new RegExp(`\\('${key}',\\s+'([a-z]{2})', '`, 'g'))].map((m) => m[1]).sort();
      expect(langs, key).toEqual(['ar', 'bn', 'en', 'es', 'fr', 'hi', 'ne', 'pt', 'tl', 'ur']);
    }
    // no native digits in the words
    expect(sql).not.toMatch(new RegExp('[\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F\\u09E6-\\u09EF]'));
    // nobody but the functions may run the helpers
    for (const h of ['_updates_text(text, text[], text)', '_updates_wl_in()', '_updates_wl_offer()', '_updates_note()', '_updates_sweep()', '_push_outbox_gate()', '_hub_push_tick()', '_session_change_push()']) {
      expect(sql, h).toContain(`revoke all on function public.${h} from public, anon, authenticated;`);
    }
    // each function is on the drift check's list
    const checks = readFileSync(resolve(__dirname, '../supabase/checks/security-attributes.sql'), 'utf8');
    for (const name of ['customer_updates', 'customer_updates_unread', '_updates_text', '_updates_wl_in', '_updates_wl_offer', '_updates_note', '_updates_sweep']) expect(checks, name).toContain(`('${name}', true,`);
  });
});
