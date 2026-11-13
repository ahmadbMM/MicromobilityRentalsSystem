import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// The "My month" card on the Community tab (new features build F13, 2026-11-13; member-hub.js, migration
// 20261114081300). From the 26th to the end of the month a member with two or more finished sessions that month sees
// their own month: Saturdays ridden, sessions by kind, badges earned this month and one comparison with their own month
// before. Its first day is kept in the database (site_content 'hub.month.from', 26 December 2026). The card has a read
// of its own (hub_month), asked only from the 26th by the date the tab's own read gives; the database decides whether it
// shows, and the page checks the same rules on what came back, which is what these specs read. Share hands it to the
// share pop-up of badge-share.js as a picture. All Supabase traffic is stubbed.

const EMOJI = /\p{Extended_Pictographic}/u;
const sat = (id: string) => ({ id, day: 'Saturday', session_date: id, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' });
const feed = (today: string, o: Record<string, unknown> = {}) => ({
  ok: true, today,
  me: { kind: 'level', levels: [1, 2, 3], target: 2, chosen: true, n: 1, ends_on: today.slice(0, 8) + '28', sats: 4 },
  club: null, goals: [],
  numbers: { last: '2026-11-07', last_riders: 96, last_rides: 96, month: 96, all: 2104, since: '2026-06-13' },
  post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null, ...o,
});
// December 2026 as the database answers it on the 27th: five sessions (three Saturday rides, a pool session, a circuit
// night), two badges, and November's three sessions to compare with.
const month = (o: Record<string, unknown> = {}) => ({
  ok: true, show: true, today: '2026-12-27', from: '2026-12-26', month: '2026-12-01',
  sessions: 5, saturdays: 3, kinds: [{ k: 'saturday', n: 3 }, { k: 'rental', n: 1 }, { k: 'swim', n: 1 }], badges: 2,
  prev: { month: '2026-11-01', sessions: 3 }, ...o,
});
// Answers the stub's fixtures: the stub reads them at each request, so a spec changes an answer by setting it there.
async function member(page: Page, today: string, fx: Fixtures = {}) {
  const all: Fixtures = { sessions: [sat('2099-01-03')], customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed(today), ...fx };
  await stubSupabase(page, all);
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'male' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
  return all as Record<string, unknown>;
}
const rpcSent = (page: Page) => {
  const out: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rpc\/(\w+)/); if (m) { let b = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ } out.push({ fn: m[1]!, body: b }); } });
  return out;
};
const card = (page: Page) => page.locator('#hub-body #hub-mon');
const tile = (page: Page, k: string) => card(page).locator(`.hub-stat[data-mon="${k}"]`);
// The read has been asked and answered (or was never due): the page is settled before a card's absence is read.
const asked = (sent: { fn: string }[]) => sent.filter((x) => x.fn === 'hub_month').length;

test.describe('@customer:members the My month card', () => {
  test('from the 26th: the member\'s own Saturdays, sessions by kind, badges and one comparison, as the database sends them', async ({ page }) => {
    const sent = rpcSent(page);
    await member(page, '2026-12-27', { 'rpc:hub_month': month() });
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('.hub-k')).toHaveText('My month');
    await expect(card(page).locator('.hub-name')).toHaveText('December 2026');
    await expect(tile(page, 'sats')).toHaveText('3Saturdays ridden');
    await expect(tile(page, 'sessions')).toHaveText('5Sessions');
    await expect(tile(page, 'badges')).toHaveText('2Badges earned');
    await expect(tile(page, 'prev')).toHaveText('+2Sessions compared with November');
    await expect(card(page).locator('.hub-stat')).toHaveCount(4); // one comparison, no other
    // sessions by kind, most first; a session without a ride kind is the circuit's own
    const kinds = card(page).locator('.hub-kinds li');
    await expect(kinds).toHaveCount(3);
    await expect(kinds.nth(0)).toHaveText(/Saturday Social Ride\s*3/);
    await expect(card(page).locator('.hub-kinds li[data-kind="jcc"]')).toHaveText(/Jeddah Corniche Circuit\s*1/);
    await expect(card(page).locator('.hub-kinds li[data-kind="swim"]')).toHaveText(/Triathlon Pool Session\s*1/);
    // its own read, with the rider's own token and nothing else; asked once
    const reads = sent.filter((x) => x.fn === 'hub_month');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec' });
    // it sits under the next session's card and above what is coming up
    const order = await page.evaluate(`[...document.querySelectorAll('#hub-body > *')].map(e=>e.id||e.className)`) as string[];
    expect(order.indexOf('hub-mon')).toBeGreaterThan(order.findIndex((x) => x.includes('hub-hero')));
    expect(order.indexOf('hub-mon')).toBe(order.findIndex((x) => x.includes('hub-hero')) + 1);
    // private: nothing about the club or anyone else in it, no emoji, no sideways scroll
    await expect(card(page)).not.toContainText(/club|member|rank|average|most|others/i);
    expect(EMOJI.test((await card(page).textContent()) || '')).toBe(false);
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
    // kept on the phone for the next open
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_hubm_c1')).m.sessions`)).toBe(5);
  });

  test('hidden before the 26th: the read is not even asked, and a copy kept on the phone is not shown', async ({ page }) => {
    const sent = rpcSent(page);
    await page.addInitScript((v) => localStorage.setItem('cq_hubm_c1', v), JSON.stringify({ day: '2026-12-25', m: month({ today: '2026-12-25' }) }));
    await member(page, '2026-12-25', { 'rpc:hub_month': month({ today: '2026-12-25' }) });
    await expect(page.locator('#hub-body .hub-card').first()).toBeVisible();
    await page.waitForTimeout(400);
    expect(asked(sent)).toBe(0);
    await expect(card(page)).toHaveCount(0);
    // the last day of the month still shows it; the 1st does not
    expect(await page.evaluate(`[_monDue({today:'2026-12-26'}),_monDue({today:'2026-12-31'}),_monDue({today:'2027-01-01'}),_monDue({today:'2026-12-25'}),_monDue({})]`)).toEqual([true, true, false, false, false]);
  });

  test('hidden before its first day: the database says no, and an answer dated before the first day is not shown either', async ({ page }) => {
    const sent = rpcSent(page);
    // 27 November 2026: on or after the 26th, but before 26 December
    await member(page, '2026-11-27', { 'rpc:hub_month': { ok: true, show: false } });
    await expect.poll(() => asked(sent)).toBe(1);
    await page.waitForTimeout(200);
    await expect(card(page)).toHaveCount(0);
    expect(await page.evaluate(`localStorage.getItem('cq_hubm_c1')`)).toBeNull();
    // the page's own check of an answer: the first day after today, another month's answer, a missing first day
    const ok = (m: Record<string, unknown>, day: string) => page.evaluate(`_monOk(${JSON.stringify(m)},${JSON.stringify(day)})`);
    expect(await ok(month({ today: '2026-11-27', month: '2026-11-01' }), '2026-11-27')).toBe(false); // first day 26 December
    expect(await ok(month(), '2026-12-26')).toBe(true); // the first day itself
    expect(await ok(month(), '2026-12-27')).toBe(true);
    expect(await ok(month({ from: '2027-01-26' }), '2026-12-27')).toBe(false); // staff moved the first day on
    expect(await ok(month({ from: null }), '2026-12-27')).toBe(false);
    expect(await ok(month(), '2027-01-27')).toBe(false); // December's answer in January
    expect(await ok(month({ show: false }), '2026-12-27')).toBe(false);
  });

  test('hidden before its first day on the page too: a "show" answer whose first day is still ahead draws nothing', async ({ page }) => {
    const sent = rpcSent(page);
    await member(page, '2026-11-27', { 'rpc:hub_month': month({ today: '2026-11-27', month: '2026-11-01', prev: { month: '2026-10-01', sessions: 1 } }) });
    await expect.poll(() => asked(sent)).toBe(1);
    await page.waitForTimeout(200);
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
  });

  test('hidden under two sessions, shown from two', async ({ page }) => {
    const sent = rpcSent(page);
    const fx = await member(page, '2026-12-27', { 'rpc:hub_month': month({ sessions: 1, saturdays: 1, kinds: [{ k: 'saturday', n: 1 }], badges: 0 }) });
    await expect.poll(() => asked(sent)).toBe(1);
    await page.waitForTimeout(200);
    await expect(card(page)).toHaveCount(0);
    // the database's own answer for one session
    fx['rpc:hub_month'] = { ok: true, show: false };
    await page.evaluate(`S._hubMon=null;_hubFetch(true)`);
    await expect.poll(() => asked(sent)).toBe(2);
    await page.waitForTimeout(200);
    await expect(card(page)).toHaveCount(0);
    // two sessions: shown
    fx['rpc:hub_month'] = month({ sessions: 2, saturdays: 2, kinds: [{ k: 'saturday', n: 2 }], badges: 0, prev: { month: '2026-11-01', sessions: 2 } });
    await page.evaluate(`S._hubMon=null;_hubFetch(true)`);
    await expect(card(page)).toBeVisible();
    await expect(tile(page, 'sessions')).toHaveText('2Sessions');
    await expect(tile(page, 'sats')).toHaveText('2Saturdays ridden');
    await expect(tile(page, 'badges')).toHaveText('0Badges earned');
    await expect(tile(page, 'prev')).toHaveText('0Sessions compared with November'); // the same as the month before
    await expect(card(page).locator('.hub-kinds li')).toHaveCount(1);
  });

  test('the comparison is with the member\'s own month before: fewer says so plainly, and a first month has none', async ({ page }) => {
    await member(page, '2026-12-30', { 'rpc:hub_month': month({ today: '2026-12-30', sessions: 2, saturdays: 0, kinds: [{ k: 'yoga', n: 1 }, { k: 'swim', n: 1 }], badges: 0, prev: { month: '2026-11-01', sessions: 6 } }) });
    await expect(card(page)).toBeVisible();
    await expect(tile(page, 'prev')).toHaveText('-4Sessions compared with November');
    await expect(tile(page, 'sats')).toHaveText('0Saturdays ridden');
    // sessions that are not rides are named as what they are
    await expect(card(page).locator('.hub-kinds li[data-kind="yoga"]')).toHaveText(/Hatha Yoga for Cyclists\s*1/);
    await expect(card(page).locator('.hub-kinds')).not.toContainText(/\bride\b|\bbike\b|\bcycling\b/i);
    // a member whose first session is this month: the database sends no previous month, and the tile is left out
    await page.evaluate(`S._hubMon.m.prev=null;_hubRender()`);
    await expect(card(page)).toBeVisible();
    await expect(tile(page, 'prev')).toHaveCount(0);
    await expect(card(page).locator('.hub-stat')).toHaveCount(3);
  });

  test('a database without the function: no card, no error, the rest of the tab as it was, and it is not asked again', async ({ page }) => {
    const sent = rpcSent(page);
    await page.addInitScript((v) => localStorage.setItem('cq_hubm_c1', v), JSON.stringify({ day: '2026-12-26', m: month({ today: '2026-12-26' }) }));
    await member(page, '2026-12-27'); // hub_month is not in the stubbed database: PGRST202
    await expect.poll(() => asked(sent)).toBe(1);
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('#toast-container')).toHaveText('');
    await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
    await expect(page.locator('#hub-body')).toContainText('Your challenge');
    expect(await page.evaluate(`localStorage.getItem('cq_hubm_c1')`)).toBeNull();
    await page.evaluate(`_hubFetch(true)`);
    await expect.poll(() => sent.filter((x) => x.fn === 'hub_feed').length).toBeGreaterThan(1);
    await page.waitForTimeout(300);
    expect(asked(sent)).toBe(1);
  });

  test('a read that fails says nothing; a member who is refused sees no card', async ({ page }) => {
    const sent = rpcSent(page);
    const fx = await member(page, '2026-12-27', { 'rpc:hub_month': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    await expect.poll(() => asked(sent)).toBe(1);
    await page.waitForTimeout(200);
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('#toast-container')).toHaveText('');
    fx['rpc:hub_month'] = { ok: false, error: 'denied' };
    await page.evaluate(`_hubFetch(true)`);
    await expect.poll(() => asked(sent)).toBe(2);
    await page.waitForTimeout(200);
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('#toast-container')).toHaveText('');
  });

  test('another account on the same phone never sees the first one\'s month', async ({ page }) => {
    await member(page, '2026-12-27', { 'rpc:hub_month': month() });
    await expect(card(page)).toBeVisible();
    expect(await page.evaluate(`_monHtml({id:'c2',session_token:'x'},S._hub.d)`)).toBe('');
    expect(await page.evaluate(`_monSub({id:'c2',session_token:'x'},String)`)).toBeNull();
  });

  test('Arabic: the card reads right to left with the month named in Arabic and its numbers in Latin digits', async ({ page }) => {
    await member(page, '2026-12-27', { 'rpc:hub_month': month() });
    await expect(card(page)).toBeVisible();
    await page.evaluate(`setLang('ar');setCustTab('members')`);
    await expect(card(page).locator('.hub-k')).toHaveText('شهري');
    await expect(tile(page, 'sats')).toContainText('أيام السبت التي ركبت فيها');
    await expect(tile(page, 'sats').locator('strong')).toHaveText('3');
    await expect(tile(page, 'prev').locator('strong')).toHaveText('+2');
    await expect(tile(page, 'prev')).toContainText('الأنشطة مقارنةً بشهر نوفمبر');
    await expect(card(page).locator('.hub-kinds li[data-kind="saturday"]')).toContainText('جولة السبت الاجتماعية');
    expect(await page.evaluate(`getComputedStyle(document.getElementById('hub-mon')).direction`)).toBe('rtl');
    expect(/[٠-٩۰-۹]/.test((await card(page).locator('.hub-stats').textContent()) || '')).toBe(false);
  });

  test('Share: the card goes out as a picture through the share pop-up, with only what is above zero', async ({ page }) => {
    await member(page, '2026-12-27', { 'rpc:hub_month': month() });
    await expect(card(page)).toBeVisible();
    await page.evaluate(`navigator.canShare=(d)=>!!(d&&d.files&&d.files.length);navigator.share=(d)=>{window._shared=d;return Promise.resolve();}`);
    const share = card(page).getByRole('button', { name: 'Share' });
    await share.click();
    const pic = page.locator('#badge-pop #shr-img');
    await expect(pic).toBeVisible();
    // the month, the Saturdays, the sessions, the kinds other than the Saturday ride, the badges, the gain; no name, no club line
    await expect(pic).toHaveAttribute('alt', 'MicroMobility · My month · December 2026 · Saturdays ridden: 3 · Sessions: 5 · Jeddah Corniche Circuit: 1 · Triathlon Pool Session: 1 · Badges earned: 2 · Sessions compared with November: +2');
    expect(await page.evaluate(`(async()=>{const bm=await createImageBitmap(await fetch(document.getElementById('shr-img').src).then(r=>r.blob()));return [bm.width,bm.height];})()`)).toEqual([1080, 1920]);
    await expect(page.locator('#shr-name')).not.toBeChecked();
    await page.locator('#badge-pop label[for="shr-name"]').click();
    await expect(pic).toHaveAttribute('alt', /^MicroMobility · Lina · My month · December 2026 · /);
    await expect(pic).not.toHaveAttribute('alt', /Haddad/);
    await page.locator('#badge-pop #shr-go').click();
    const out = await page.evaluate(`({keys:Object.keys(window._shared||{}),n:(window._shared.files||[]).length,name:window._shared.files[0].name,type:window._shared.files[0].type})`);
    expect(out).toEqual({ keys: ['files'], n: 1, name: 'micromobility-2026-12.png', type: 'image/png' });
    await page.locator('#badge-pop #shr-x').click();
    await expect(page.locator('#badge-pop')).toHaveCount(0);
    // a month with no badge and fewer sessions than the one before: the picture leaves both lines out
    await page.evaluate(`S._hubMon.m.badges=0;S._hubMon.m.prev.sessions=9;S._hubMon.m.kinds=[{k:'saturday',n:5}];S._hubMon.m.saturdays=5;_hubRender()`);
    await expect(tile(page, 'prev')).toHaveText('-4Sessions compared with November');
    await card(page).getByRole('button', { name: 'Share' }).click();
    await expect(pic).toBeVisible();
    await expect(pic).toHaveAttribute('alt', 'MicroMobility · My month · December 2026 · Saturdays ridden: 5 · Sessions: 5');
  });

  test('every word of the card exists in all ten languages', async ({ page }) => {
    await member(page, '2026-12-27', { 'rpc:hub_month': month() });
    const rows = await page.evaluate(`['monTitle','monSats','monBadges','monVs','yrSessions'].map(k=>[k,(HUB_T[k]||[]).length,(HUB_T[k]||[]).every(x=>String(x).trim()&&!/\\p{Extended_Pictographic}/u.test(x))])`);
    expect(rows).toEqual([['monTitle', 10, true], ['monSats', 10, true], ['monBadges', 10, true], ['monVs', 10, true], ['yrSessions', 10, true]]);
    expect(await page.evaluate(`HUB_T.monVs.every(x=>x.includes('{0}'))`)).toBe(true);
  });
});

test.describe('@customer:members the My month card, in the database', () => {
  const sql = readFileSync('supabase/migrations/20261114081300_hub_month.sql', 'utf8');
  test('the function checks the rider\'s token, the first day, the 26th and two sessions before it answers a number', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.hub_month'), sql.indexOf('revoke all on function public.hub_month'));
    const at = (s: string) => { const i = fn.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const numbers = at(`'sessions', v_n`);
    expect(at('not _cust_token_ok(p_id, p_token)')).toBeLessThan(numbers);
    expect(at('not _member_active(p_id)')).toBeLessThan(numbers);
    expect(at(`key = 'hub.month.from'`)).toBeLessThan(numbers);
    expect(at('v_today < v_from or extract(day from v_today) < 26')).toBeLessThan(numbers);
    expect(at('coalesce(v_n, 0) < 2')).toBeLessThan(numbers);
    expect(fn).toMatch(/language plpgsql stable security definer set search_path to 'public'/);
    // the caller's own accounts only: no read of another rider, no club count
    expect(fn).not.toMatch(/_hub_club|customer_tags|customers c\b|name/);
    expect((fn.match(/customer_id = any\(v_accts\)/g) || []).length).toBe(2);
  });
  test('the first day is a row staff or a later migration can change, seeded as 26 December 2026; the function is granted and listed', () => {
    expect(sql).toMatch(/insert into public\.site_content \(key, value, updated_by\)\s+values \('hub\.month\.from', '"2026-12-26"'::jsonb, 'migration'\)\s+on conflict \(key\) do nothing;/);
    expect(sql).toContain('revoke all on function public.hub_month(text, text) from public;');
    expect(sql).toContain('grant execute on function public.hub_month(text, text) to anon, authenticated;');
    expect(sql).toMatch(/values \('20261114081300', 'hub_month'\)/);
    expect(readFileSync('supabase/checks/security-attributes.sql', 'utf8')).toContain(`('hub_month', true,`);
  });
});
