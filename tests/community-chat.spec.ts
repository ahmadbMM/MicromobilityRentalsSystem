import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, stubRealtime, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';
import { hubPart } from './helpers/hub';

// The Community chat (2026-11-20, migration 20261120203000; the user: "can we create a live chat in the booking app but only
// for community members?", then "Full name", "One club chat", "Text only"). The member's side is a round button at the bottom
// corner of every page (app.src.html _chtFab*; the user, 2026-11-20: "show the chat in booking app as an icon at the bottom
// corner of the page"; it was a card on the Community tab) and the chat's own page (member-hub.js); the staff side is
// the Chat section (/chat, since 2026-11-20, migration 20261120233000). All Supabase traffic is stubbed, the

// realtime socket too; what only the database enforces (members only, the limits, the reports that hide a message, the mute)
// is checked in the migration's own text below and was run on a local Postgres.

const sess = { id: '2099-01-03', day: 'Saturday', session_date: '2099-01-03', capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' };
const feed = {
  ok: true, today: '2026-11-20',
  me: { kind: 'level', levels: [1, 2, 3], target: 2, chosen: true, n: 1, ends_on: '2026-11-30', sats: 4 },
  club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null,
};
type Msg = { id: number; at: string; day: string; body: string; team: boolean; mine: boolean; name: string | null; k: string };
const msgs: Msg[] = [
  { id: 11, at: '2026-11-19T15:00:00Z', day: '2026-11-19', body: 'Who is riding on Saturday?', team: false, mine: false, name: 'Omar Saleh', k: 'k-omar' },
  { id: 12, at: '2026-11-19T15:01:00Z', day: '2026-11-19', body: 'Bringing two friends', team: false, mine: false, name: 'Omar Saleh', k: 'k-omar' },
  { id: 13, at: '2026-11-19T15:10:00Z', day: '2026-11-19', body: 'I am in', team: false, mine: true, name: 'Lina Haddad', k: 'k-lina' },
  { id: 14, at: '2026-11-20T06:00:00Z', day: '2026-11-20', body: 'Meet at gate 2\nat 05:45', team: true, mine: false, name: null, k: 'team' },
];
const read = (o: Record<string, unknown> = {}) => ({ ok: true, rows: msgs, reset: false, more: false, gone: [], me: { agreed: true, muted: false, until: null }, ...o });
const absent = (fn: string) => ({ __rpcError: { status: 404, code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } });
const json = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

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
    'rpc:chat_peek': { ok: true, n: 0 }, 'rpc:chat_read': read(), ...fx,
  });
  const rt = await stubRealtime(page); // again, after stubSupabase: this one answers the page's socket and can send a tick
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'female' });
  await page.goto(path);
  await waitForSb(page);
  return { log, rt };
}
async function openTab(page: Page) {
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
}
// The way in: the round button at the bottom corner, on whatever page the member is on.
async function openChat(page: Page) {
  await expect(fab(page)).toBeVisible();
  await fab(page).click();
  await expect(pageEl(page).locator('h2')).toHaveText('Community chat');
}
const fab = (page: Page) => page.locator('#cht-fab');
const pageEl = (page: Page) => page.locator('#hub-body #cht-page');
const rowsEl = (page: Page) => pageEl(page).locator('.cht-row');
const dlg = (page: Page) => page.locator('#confirm-modal .confirm-box');
const calls = (log: { fn: string; body: Record<string, unknown> }[], fn: string) => log.filter((x) => x.fn === fn);

test.describe('@customer:members Community chat', () => {
  test('the corner button counts what is new and opens the chat: each message under its writer\'s full name, the member\'s own on the other side, the team\'s by name; Close goes back to the page it was opened from', async ({ page }) => {
    const { log } = await member(page, { 'rpc:chat_peek': { ok: true, n: 3 } });
    await page.evaluate(`setCustTab('myrides')`); // on any page, not only the Community tab
    await expect(fab(page)).toBeVisible();
    await expect(fab(page).locator('.cht-fab-n')).toHaveText('3');
    await expect(fab(page)).toHaveAccessibleName('Community chat, 3 new');
    expect(calls(log, 'chat_peek')[0]!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_after: null }); // nothing read to the end on this phone yet
    expect(calls(log, 'chat_read')).toHaveLength(0); // no message is read for the button
    expect(await page.locator('#cht-fab svg').count()).toBe(1); // the app's own drawn mark, no emoji
    await fab(page).click();
    await expect(pageEl(page).locator('h2')).toHaveText('Community chat');
    await expect(fab(page)).toBeHidden(); // the chat is the page: no button over it
    await expect(rowsEl(page)).toHaveCount(4);
    expect(calls(log, 'chat_read')[0]!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec' });
    // another member: the full name over the first of a run, not again over the second
    await expect(rowsEl(page).nth(0).locator('.cht-who')).toHaveText('Omar Saleh');
    await expect(rowsEl(page).nth(0).locator('.cht-body')).toHaveText('Who is riding on Saturday?');
    await expect(rowsEl(page).nth(1)).toHaveClass(/\bcht-run\b/);
    await expect(rowsEl(page).nth(1).locator('.cht-who')).toHaveCount(0);
    // the member's own: the other side, no name
    await expect(rowsEl(page).nth(2)).toHaveClass(/\bcht-mine\b/);
    await expect(rowsEl(page).nth(2).locator('.cht-who')).toHaveCount(0);
    // the team's
    await expect(rowsEl(page).nth(3)).toHaveClass(/\bcht-team\b/);
    await expect(rowsEl(page).nth(3).locator('.cht-who')).toHaveText('MicroMobility team');
    await expect(pageEl(page).locator('.cht-day')).toHaveCount(2); // two days
    // one button a message: Report on another member's, Remove on their own, none on the team's
    await expect(rowsEl(page).nth(0).getByRole('button', { name: 'Report' })).toBeVisible();
    await expect(rowsEl(page).nth(2).getByRole('button', { name: 'Remove' })).toBeVisible();
    await expect(rowsEl(page).nth(3).locator('button')).toHaveCount(0);
    // every control is named, nothing inline, no sideways scroll, nothing but text
    await expect(page.getByLabel('Message')).toBeVisible();
    await expect(pageEl(page).getByRole('button', { name: 'Send' })).toBeVisible();
    expect(await page.locator('#cht-page [style], #cht-page script, #cht-page img, #cht-page a').count()).toBe(0);
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
    // read to the end: only the id read to is kept on the phone, never a message
    await expect.poll(() => page.evaluate(`localStorage.getItem('cq_cht_seen_c1')`)).toBe('14');
    expect(await page.evaluate(`Object.keys(localStorage).filter(k=>/cht/i.test(k))`)).toEqual(['cq_cht_seen_c1']);
    expect(await page.evaluate(`JSON.stringify(localStorage).includes('Who is riding')`)).toBe(false);
    // Close goes back to Bookings, where the button was; it no longer counts them
    await pageEl(page).getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#tab-myrides')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#cht-page')).toHaveCount(0);
    await expect(fab(page)).toBeVisible();
    await expect(fab(page).locator('.cht-fab-n')).toHaveCount(0);
    await expect(fab(page)).toHaveAccessibleName('Community chat');
    await expect.poll(() => page.evaluate('!!S._chtCh||!!S._chtT')).toBe(false); // the topic and the page's clock are let go
  });

  test('the first message asks for the member\'s yes to their full name, once; then it is sent and lands with no toast', async ({ page }) => {
    const { log } = await member(page, { 'rpc:chat_read': read({ me: { agreed: false, muted: false, until: null } }) });
    let n = 20;
    await page.route('**/rest/v1/rpc/chat_send', (r) => {
      const b = r.request().postDataJSON() as { p_body: string };
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify({ ok: true, row: { id: ++n, at: '2026-11-20T07:00:00Z', day: '2026-11-20', body: b.p_body, team: false, mine: true, name: 'Lina Haddad', k: 'k-lina' } }) });
    });
    await openChat(page);
    await expect(rowsEl(page)).toHaveCount(4);
    const box = page.getByLabel('Message');
    await box.fill('  See you all there  ');
    await pageEl(page).getByRole('button', { name: 'Send' }).click();
    await expect(dlg(page)).toContainText('Other members will see your full name, Lina Haddad, with your messages.');
    expect(calls(log, 'chat_send')).toHaveLength(0); // nothing is sent before the yes
    // Cancel sends nothing and keeps the words
    await dlg(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg(page)).toHaveCount(0);
    await expect(box).toHaveValue('  See you all there  ');
    expect(calls(log, 'chat_send')).toHaveLength(0);
    await pageEl(page).getByRole('button', { name: 'Send' }).click();
    await dlg(page).getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => calls(log, 'chat_send').length).toBe(1);
    expect(calls(log, 'chat_send')[0]!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_body: 'See you all there', p_agree: true });
    await expect(rowsEl(page)).toHaveCount(5);
    await expect(rowsEl(page).last()).toHaveClass(/\bcht-mine\b/);
    await expect(rowsEl(page).last().locator('.cht-body')).toHaveText('See you all there');
    await expect(box).toHaveValue('');
    await expect(page.locator('.toast:not(.quiet), #err-bar-el')).toHaveCount(0);
    // the second one is not asked again
    await box.fill('And bring water');
    await pageEl(page).getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => calls(log, 'chat_send').length).toBe(2);
    await expect(dlg(page)).toHaveCount(0);
    expect(calls(log, 'chat_send')[1]!.body).toMatchObject({ p_body: 'And bring water', p_agree: false });
    await expect(rowsEl(page)).toHaveCount(6);
  });

  test('a database that says the yes is still owed asks for it then; each refusal is said in words and what was typed stays; a muted member cannot write', async ({ page }) => {
    const { log } = await member(page);
    const answers: Record<string, unknown>[] = [{ ok: false, error: 'agree' }, { ok: false, error: 'fast' }, { ok: false, error: 'limit' }, { ok: false, error: 'nonsense' }, { ok: false, error: 'muted', until: null }];
    let i = 0;
    await page.route('**/rest/v1/rpc/chat_send', (r) => r.fulfill({ status: 200, headers: json, body: JSON.stringify(answers[Math.min(i++, answers.length - 1)]) }));
    await openChat(page);
    const box = page.getByLabel('Message'), send = pageEl(page).getByRole('button', { name: 'Send' }), msg = page.locator('#cht-msg');
    await box.fill('Hello');
    await send.click(); // the page thought the yes was given; the database says it is owed
    await expect(dlg(page)).toContainText('Lina Haddad');
    await dlg(page).getByRole('button', { name: 'Send' }).click();
    await expect(msg).toHaveText('You are sending too fast. Please try again in a moment.');
    expect(calls(log, 'chat_send')[1]!.body).toMatchObject({ p_agree: true });
    await expect(box).toHaveValue('Hello');
    await send.click(); // the yes was given a moment ago: not asked a second time
    await expect(msg).toHaveText('You have sent many messages. Please try again in a few minutes.');
    await expect(dlg(page)).toHaveCount(0);
    expect(calls(log, 'chat_send')[2]!.body).toMatchObject({ p_agree: true });
    await send.click();
    await expect(msg).toHaveText('We could not do that. Please try again.');
    await box.fill('Hello again'); // typing clears what was said
    await expect(msg).toHaveText('');
    await send.click();
    await expect(msg).toHaveText('You cannot write in the chat for now.');
    await expect(box).toBeDisabled();
    await expect(send).toBeDisabled();
    await expect(rowsEl(page)).toHaveCount(4); // reading goes on
  });

  test('muted until a day: the read says so, the box is closed and names the day', async ({ page }) => {
    await member(page, { 'rpc:chat_read': read({ me: { agreed: true, muted: true, until: '2026-11-27T10:00:00+00:00' } }) });
    await openChat(page);
    await expect(page.locator('#cht-msg')).toContainText('You cannot write in the chat until');
    await expect(page.locator('#cht-msg')).toContainText('27');
    await expect(page.getByLabel('Message')).toBeDisabled();
    await expect(rowsEl(page)).toHaveCount(4);
  });

  test('live: a tick on the topic makes the page ask for what came after the last message; a removed one goes; a page far behind starts again', async ({ page }) => {
    const { log, rt } = await member(page);
    const later: Record<string, unknown>[] = [
      { ok: true, rows: [{ id: 15, at: '2026-11-20T06:05:00Z', day: '2026-11-20', body: 'On my way', team: false, mine: false, name: 'Sara Nasser', k: 'k-sara' }], reset: false, more: false, gone: [12], me: { agreed: true, muted: false, until: null } },
      { ok: true, rows: [{ id: 90, at: '2026-11-20T09:00:00Z', day: '2026-11-20', body: 'A new start', team: true, mine: false, name: null, k: 'team' }], reset: true, more: true, gone: [], me: { agreed: true, muted: false, until: null } },
    ];
    let i = 0;
    await page.route('**/rest/v1/rpc/chat_read', (r) => {
      const b = r.request().postDataJSON() as { p_after?: number };
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify(b.p_after == null ? read() : later[Math.min(i++, later.length - 1)]) });
    });
    await openChat(page);
    await expect(rowsEl(page)).toHaveCount(4);
    await page.waitForFunction('S._chtLive===true'); // the topic is joined
    const before = calls(log, 'chat_read').length;
    rt.broadcast('realtime:hub-chat', 'tick', {});
    await expect(rowsEl(page).last().locator('.cht-body')).toHaveText('On my way');
    await expect(rowsEl(page).last().locator('.cht-who')).toHaveText('Sara Nasser');
    await expect(pageEl(page).locator('.cht-row[data-id="12"]')).toHaveCount(0); // removed elsewhere: gone here
    await expect(rowsEl(page)).toHaveCount(4);
    expect(calls(log, 'chat_read').slice(before)[0]!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_after: 14 });
    await expect.poll(() => page.evaluate(`localStorage.getItem('cq_cht_seen_c1')`)).toBe('15'); // the reader was at the end: it followed
    // a second tick: the database says the page is too far behind, so it starts again from the newest
    await page.evaluate('S._cht.tickNext=0');
    rt.broadcast('realtime:hub-chat', 'tick', {});
    await expect(rowsEl(page)).toHaveCount(1);
    await expect(rowsEl(page).first().locator('.cht-body')).toHaveText('A new start');
    await expect(pageEl(page).getByRole('button', { name: 'Earlier messages' })).toBeVisible();
    // the tick carried nothing: no message, no name
    expect(JSON.stringify(calls(log, 'chat_read').map((x) => Object.keys(x.body).sort()))).not.toContain('body');
  });

  test('ticks that bring nothing are answered less and less often', async ({ page }) => {
    const { log, rt } = await member(page);
    await page.route('**/rest/v1/rpc/chat_read', (r) => {
      const b = r.request().postDataJSON() as { p_after?: number };
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify(b.p_after == null ? read() : read({ rows: [] })) });
    });
    await openChat(page);
    await page.waitForFunction('S._chtLive===true');
    const n0 = calls(log, 'chat_read').length;
    rt.broadcast('realtime:hub-chat', 'tick', {});
    await expect.poll(() => calls(log, 'chat_read').length).toBe(n0 + 1);
    await page.waitForFunction('!S._cht.loading&&S._cht.tickGap>=1500'); // nothing came: the next tick waits
    for (let k = 0; k < 20; k++) rt.broadcast('realtime:hub-chat', 'tick', {});
    await page.waitForTimeout(700);
    expect(calls(log, 'chat_read').length).toBe(n0 + 1); // twenty ticks inside the wait: not one more read
    await expect.poll(() => calls(log, 'chat_read').length, { timeout: 5000 }).toBe(n0 + 2); // then one for the burst
    expect(await page.evaluate('S._cht.tickGap')).toBeGreaterThanOrEqual(3000);
  });

  test('Remove takes the member\'s own message away after a yes; Report tells the team about someone else\'s, once', async ({ page }) => {
    const { log } = await member(page, { 'rpc:chat_remove': { ok: true, id: 13 }, 'rpc:chat_report': { ok: true, id: 11 } });
    await openChat(page);
    await rowsEl(page).nth(2).getByRole('button', { name: 'Remove' }).click();
    await expect(dlg(page)).toContainText('Remove your message?');
    await expect(dlg(page)).toContainText('I am in');
    await dlg(page).getByRole('button', { name: 'Cancel' }).click();
    expect(calls(log, 'chat_remove')).toHaveLength(0);
    await expect(rowsEl(page)).toHaveCount(4);
    await rowsEl(page).nth(2).getByRole('button', { name: 'Remove' }).click();
    await dlg(page).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => calls(log, 'chat_remove').length).toBe(1);
    expect(calls(log, 'chat_remove')[0]!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_msg: 13 });
    await expect(rowsEl(page)).toHaveCount(3);
    await expect(pageEl(page).locator('.cht-row[data-id="13"]')).toHaveCount(0);
    // report
    await rowsEl(page).nth(0).getByRole('button', { name: 'Report' }).click();
    await expect(dlg(page)).toContainText('Report this message to the team?');
    await expect(dlg(page)).toContainText('Omar Saleh: Who is riding on Saturday?');
    await dlg(page).getByRole('button', { name: 'Report' }).click();
    await expect.poll(() => calls(log, 'chat_report').length).toBe(1);
    expect(calls(log, 'chat_report')[0]!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_msg: 11 });
    await expect(rowsEl(page).nth(0).locator('.cht-rep')).toHaveText('Reported');
    await expect(rowsEl(page).nth(0).getByRole('button', { name: 'Report' })).toHaveCount(0);
    await expect(rowsEl(page).nth(1).getByRole('button', { name: 'Report' })).toBeVisible(); // the other one still can be
    await expect(page.locator('.toast:not(.quiet), #err-bar-el')).toHaveCount(0);
  });

  test('Earlier messages asks for the ones before the first and puts them above', async ({ page }) => {
    const { log } = await member(page);
    const older = [
      { id: 8, at: '2026-11-18T10:00:00Z', day: '2026-11-18', body: 'Great ride today', team: false, mine: false, name: 'Sara Nasser', k: 'k-sara' },
      { id: 9, at: '2026-11-18T10:02:00Z', day: '2026-11-18', body: 'Thank you all', team: false, mine: true, name: 'Lina Haddad', k: 'k-lina' },
    ];
    await page.route('**/rest/v1/rpc/chat_read', (r) => {
      const b = r.request().postDataJSON() as { p_before?: number; p_after?: number };
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify(b.p_before != null ? read({ rows: older, more: false }) : b.p_after != null ? read({ rows: [] }) : read({ more: true })) });
    });
    await openChat(page);
    await expect(rowsEl(page)).toHaveCount(4);
    await pageEl(page).getByRole('button', { name: 'Earlier messages' }).click();
    await expect(rowsEl(page)).toHaveCount(6);
    expect(calls(log, 'chat_read').find((x) => x.body.p_before != null)!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_before: 11 });
    await expect(rowsEl(page).first().locator('.cht-body')).toHaveText('Great ride today');
    await expect(pageEl(page).getByRole('button', { name: 'Earlier messages' })).toHaveCount(0); // no more before these
    await expect(pageEl(page).locator('.cht-day')).toHaveCount(3);
  });

  test('a read landing keeps what the member is typing; the page speaks Arabic; Enter sends with a keyboard and a mouse', async ({ page }, info) => {
    const { log } = await member(page, { 'rpc:chat_send': { ok: true, row: { id: 30, at: '2026-11-20T08:00:00Z', day: '2026-11-20', body: 'Half a thought', team: false, mine: true, name: 'Lina Haddad', k: 'k-lina' } } });
    await openChat(page);
    const box = page.getByLabel('Message');
    await box.fill('Half a thought');
    await page.evaluate(`S._cht.rows=S._cht.rows.slice(0,2);_hubRender()`); // the messages change, the box does not
    await expect(rowsEl(page)).toHaveCount(2);
    await expect(box).toHaveValue('Half a thought');
    await expect(box).toBeFocused();
    await page.evaluate(`S.lang='ar';_hubRender()`);
    await expect(pageEl(page).locator('h2')).toHaveText('دردشة المجتمع');
    await expect(page.locator('#cht-text')).toHaveValue('Half a thought');
    await page.evaluate(`S.lang='en';_hubRender()`);
    await page.locator('#cht-text').focus();
    await page.keyboard.press('Shift+Enter'); // always a new line
    expect(calls(log, 'chat_send')).toHaveLength(0);
    await page.locator('#cht-text').fill('Half a thought');
    await page.keyboard.press('Enter');
    if (info.project.name === 'mobile') {
      expect(calls(log, 'chat_send')).toHaveLength(0); // on a phone Enter is a new line; Send is the button
    } else {
      await expect.poll(() => calls(log, 'chat_send').length).toBe(1);
      expect(calls(log, 'chat_send')[0]!.body).toMatchObject({ p_body: 'Half a thought' });
    }
  });

  test('six hours: a message leaves the open page the moment it turns six hours old, by the database\'s clock', async ({ page }) => {
    // the database says how long a message is shown (keep, seconds) and what time it is (now); here its clock runs an
    // hour ahead of this device's, so a message 5 h 30 min old by the device is already 6 h 30 min old by the database
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString(), H = 3600e3;
    const row = (id: number, at: string, body: string): Msg => ({ id, at, day: at.slice(0, 10), body, team: false, mine: false, name: 'Omar Saleh', k: 'k-omar' });
    const rows = [row(41, ago(5.5 * H), 'older than six hours by the database'), row(42, ago(5 * H - 5000), 'five seconds left'), row(43, ago(H), 'an hour old')];
    await member(page);
    await page.route('**/rest/v1/rpc/chat_read', (r) => {
      const b = r.request().postDataJSON() as { p_after?: number };
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify(read({ rows: b.p_after == null ? rows : [], now: new Date(Date.now() + H).toISOString(), keep: 6 * 3600 })) });
    });
    await openChat(page);
    await expect(rowsEl(page).locator('.cht-body')).toHaveText(['five seconds left', 'an hour old']); // 41 is past its six hours already
    expect(await page.evaluate('S._cht.ttl')).toBe(6 * H);
    await expect(rowsEl(page).locator('.cht-body')).toHaveText(['an hour old'], { timeout: 15000 }); // 42 turns six hours old on screen
    // nothing asked the database to delete anything, and nothing is kept on the phone
    expect(await page.evaluate(`Object.keys(localStorage).filter(k=>/cht/i.test(k))`)).toEqual(['cq_cht_seen_c1']);
  });

  test('/members?hv=chat opens the chat from a cold link, and the address is cleaned', async ({ page }) => {
    await member(page, {}, '/members?src=push&hv=chat');
    await expect(pageEl(page).locator('h2')).toHaveText('Community chat');
    await expect(rowsEl(page)).toHaveCount(4);
    expect(new URL(page.url()).search).toBe('');
    await pageEl(page).getByRole('button', { name: 'Close' }).click(); // nowhere to go back to: the Community tab
    await expect(page.locator('#tab-members')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#cht-page')).toHaveCount(0);
  });

  test('a database without it: no button; one that loses it while the page is open closes the page', async ({ page }) => {
    const { log } = await member(page, { 'rpc:chat_peek': absent('chat_peek') });
    await expect.poll(() => calls(log, 'chat_peek').length).toBeGreaterThan(0);
    await expect(fab(page)).toBeHidden();
    await openTab(page);
    await expect(fab(page)).toBeHidden();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await member(page, { 'rpc:chat_read': absent('chat_read') });
    await openTab(page);
    await fab(page).click();
    await expect(page.locator('#hub-body .hub-hero')).toBeVisible(); // back on the tab
    await expect(page.locator('#cht-page')).toHaveCount(0);
    await expect(fab(page)).toBeHidden();
  });

  test('the button sits at the bottom end corner, above the tab bar on a phone and on the left in Arabic; never for a rider who is not a member', async ({ page }, info) => {
    await member(page);
    await page.evaluate(`setCustTab('myrides')`);
    await expect(fab(page)).toBeVisible();
    const vp = page.viewportSize()!;
    let b = (await fab(page).boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44); // a thumb's size
    expect(vp.width - (b.x + b.width)).toBeLessThan(24); // at the end edge
    expect(vp.height - (b.y + b.height)).toBeLessThan(info.project.name === 'mobile' ? 160 : 40); // at the bottom
    if (info.project.name === 'mobile') {
      const nav = (await page.locator('#cust-bottom-nav').boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(nav.y); // above the floating tab bar, not on it
    }
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
    await page.evaluate(`setLang('ar')`);
    await expect(fab(page)).toHaveAccessibleName('دردشة المجتمع');
    b = (await fab(page).boundingBox())!;
    expect(b.x).toBeLessThan(24); // the end edge is the left in Arabic
    await page.evaluate(`setLang('en')`);
    // the Community tab has it too, and no card for the chat any more
    await openTab(page);
    await expect(fab(page)).toBeVisible();
    await hubPart(page, 'club');
    await expect(page.locator('#hub-body .cht-card')).toHaveCount(0);
    // the tab bar's Community shows the tab, not the chat the button opened
    await fab(page).click();
    await expect(pageEl(page)).toBeVisible();
    await page.evaluate(`_commTap()`);
    await expect(page.locator('#hub-body .hub-hero, #hub-body .hub-sec').first()).toBeVisible();
    await expect(page.locator('#cht-page')).toHaveCount(0);
    await expect(fab(page)).toBeVisible();
    // not a member: no button and nothing asked
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const { log } = await member(page, { 'rpc:community_member': false, 'rpc:hub_pulse': { ok: true, member: false, dot: false, fresh: [] } });
    await page.evaluate(`setCustTab('myrides')`);
    await expect.poll(() => calls(log, 'community_member').length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await expect(fab(page)).toBeHidden();
    expect(calls(log, 'chat_peek')).toHaveLength(0);
  });

  test('a failed first read says so and Try again reads again', async ({ page }) => {
    const { log } = await member(page);
    let fail = true;
    await page.route('**/rest/v1/rpc/chat_read', (r) => fail
      ? r.fulfill({ status: 500, headers: json, body: JSON.stringify({ code: 'XX000', message: 'boom' }) })
      : r.fulfill({ status: 200, headers: json, body: JSON.stringify(read()) }));
    await openChat(page);
    await expect(pageEl(page).locator('#cht-log')).toContainText('We could not do that. Please try again.');
    const n = calls(log, 'chat_read').length;
    fail = false;
    await pageEl(page).getByRole('button', { name: 'Try again' }).click();
    await expect(rowsEl(page)).toHaveCount(4);
    expect(calls(log, 'chat_read').length).toBeGreaterThan(n);
  });

  test('every word of the chat in all ten languages, Latin digits in Nepali and Bengali', async ({ page }) => {
    await member(page);
    await openTab(page);
    const bad = await page.evaluate(`Object.entries(HUB_T).filter(([k])=>k.startsWith('cht')).filter(([k,v])=>v.length!==11||v.some(x=>!String(x).trim())).map(([k])=>k)`);
    expect(bad).toEqual([]);
    expect(await page.evaluate(`Object.keys(HUB_T).filter(k=>k.startsWith('cht')).length`)).toBeGreaterThanOrEqual(17);
    // the corner button's two words live with the app's own (every language file, check-i18n's parity)
    expect(await page.evaluate(`['chtFab','chtFabNew'].every(k=>LANG.en[k])`)).toBe(true);
    const native = await page.evaluate(`Object.entries(HUB_T).filter(([k])=>k.startsWith('cht')).filter(([k,v])=>/[०-९০-৯]/.test(v[8]+v[9])).map(([k])=>k)`);
    expect(native).toEqual([]);
    const holes = await page.evaluate(`Object.entries(HUB_T).filter(([k])=>k.startsWith('cht')).filter(([k,v])=>new Set(v.map(x=>(String(x).match(/\\{\\d\\}/g)||[]).sort().join())).size!==1).map(([k])=>k)`);
    expect(holes).toEqual([]); // the same {0} in every language
  });
});

// ── What only the database enforces, read in the migration's own text ───────────────────────────────────────────────────
test.describe('@build Community chat migration', () => {
  const sql = readFileSync(resolve(__dirname, '../supabase/migrations/20261120203000_community_chat.sql'), 'utf8');
  const fnBody = (name: string) => { const i = sql.indexOf(`create or replace function public.${name}(`); expect(i, name).toBeGreaterThan(-1); return sql.slice(i, sql.indexOf('end $$;', i)); };

  test('every member call checks the token and the membership before anything else', () => {
    for (const f of ['chat_read', 'chat_peek', 'chat_send', 'chat_remove', 'chat_report']) {
      const b = fnBody(f);
      const tok = b.indexOf('not _cust_token_ok(p_id, p_token)'), mem = b.indexOf('not _member_active(p_id)');
      expect(tok, `${f} token`).toBeGreaterThan(-1);
      expect(mem, `${f} member`).toBeGreaterThan(tok);
      for (const w of ['from hub_chat', 'insert into', 'update hub_chat']) { const j = b.indexOf(w); if (j > -1) expect(j, `${f}: ${w} after the checks`).toBeGreaterThan(mem); }
      expect(sql).toContain(`grant execute on function public.${f}(`);
    }
  });

  test('a member reads a full name and the message, and nothing else about a member', () => {
    const i = sql.indexOf('create or replace function public._chat_row('), row = sql.slice(i, sql.indexOf('$$;', i));
    const keys = [...row.matchAll(/'(\w+)',\s/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(['at', 'body', 'day', 'id', 'k', 'mine', 'name', 'team']);
    expect(row).not.toMatch(/phone|email|birth|gender|photo|title|badge|customer_id'/);
    expect(sql).toMatch(/revoke all on function public\._chat_row\(public\.hub_chat, text\[\]\) from public, anon, authenticated;/);
  });

  test('the three tables are closed to riders: RLS on, nothing granted to anon, staff read only', () => {
    for (const tb of ['hub_chat', 'hub_chat_members', 'hub_chat_reports']) {
      expect(sql).toContain(`alter table public.${tb} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${tb} from public, anon, authenticated;`);
      expect(sql).toContain(`grant select on public.${tb} to authenticated;`);
      expect(sql).toContain(`create policy "staff read" on public.${tb} for select using ((select _staff_mod('community')));`);
    }
    expect(sql).not.toMatch(/grant (insert|update|delete|all)[^;]*hub_chat/);
  });

  test('the ping is empty and public; staff calls need the Community edit right; the limits and the third report', () => {
    expect(sql).toContain(`perform realtime.send('{}'::jsonb, 'tick', 'hub-chat', false);`);
    for (const f of ['staff_chat_send', 'staff_chat_set', 'staff_chat_mute']) {
      expect(fnBody(f)).toContain(`if (select _staff_mod('community', true)) is not true then raise exception 'FORBIDDEN'`);
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon;`));
    }
    // the limits and the third report
    expect(fnBody('chat_send')).toContain(`interval '5 minutes') >= 20`);
    expect(fnBody('chat_send')).toContain(`if p_agree is not true then return jsonb_build_object('ok', false, 'error', 'agree');`);
    expect(fnBody('chat_report')).toContain('v_n >= 3');
    expect(fnBody('chat_report')).toContain('m.customer_id = any(v_me)'); // never their own
  });
});

// Members see a message for six hours, staff keep every message and nothing is deleted (the user, 2026-11-20: "delete chats
// when it completes 6 hours but keep it shown for staff and never delete them"; migration 20261120213000).
test.describe('@build Community chat, six hours', () => {
  const sql = readFileSync(resolve(__dirname, '../supabase/migrations/20261120213000_community_chat_six_hours.sql'), 'utf8');
  const body = (name: string, end = 'end $$;') => { const i = sql.indexOf(`create or replace function public.${name}(`); expect(i, name).toBeGreaterThan(-1); return sql.slice(i, sql.indexOf(end, i)); };

  test('members read the last six hours only; the window is one function', () => {
    expect(body('_chat_keep', '$$;\n')).toContain(`select interval '6 hours';`);
    expect(body('_chat_shown', '$$;\n')).toContain('and m.created_at > now() - _chat_keep()');
    expect(body('_chat_shown', '$$;\n')).toContain('m.removed_at is null');
    expect(body('chat_read')).toContain(`'now', now(), 'keep', extract(epoch from _chat_keep())::integer,`);
    for (const f of ['chat_read', 'chat_peek']) {
      const b = body(f);
      expect(b, f).toContain('where m.created_at > now() - _chat_keep() order by m.created_at limit 1;'); // the window found by time, not by walking the kept messages
      expect((b.match(/from hub_chat m/g) || []).length, f).toBe((b.match(/m\.id >= v_min|m\.created_at > now\(\) - _chat_keep\(\) order by/g) || []).length); // every read starts inside it
    }
  });

  test('nothing deletes a message any more: the daily job is unscheduled and its function dropped; staff still read the table', () => {
    expect(sql).toContain(`perform cron.unschedule('mm-chat-purge');`);
    expect(sql).toContain('drop function if exists public._chat_purge();');
    expect(sql).not.toMatch(/delete from\s+(public\.)?hub_chat/);
    expect(sql).not.toMatch(/drop (table|policy)|revoke [^;]* on (table )?public\.hub_chat /);
    expect(sql).toContain('create index if not exists hub_chat_created_at on public.hub_chat (created_at);');
  });

  test('the rebuilt calls keep their checks, their definer rights and their grants', () => {
    for (const f of ['chat_read', 'chat_peek', 'chat_send']) {
      const b = body(f);
      const tok = b.indexOf('not _cust_token_ok(p_id, p_token)'), mem = b.indexOf('not _member_active(p_id)');
      expect(tok, `${f} token`).toBeGreaterThan(-1);
      expect(mem, `${f} member`).toBeGreaterThan(tok);
      expect(b.indexOf('from hub_chat'), `${f} reads after the checks`).toBeGreaterThan(mem);
      expect(b, f).toMatch(/language plpgsql (stable|volatile) security definer set search_path to 'public'/);
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to anon, authenticated;`));
    }
    expect(body('chat_send')).toContain(`interval '5 minutes') >= 20`);
    expect(body('chat_send')).toContain(`if p_agree is not true then return jsonb_build_object('ok', false, 'error', 'agree');`);
    expect(sql.includes(String.fromCharCode(92))).toBe(false); // no backslash escape that a tool or a paste could misread
  });
});

// ── Staff: the Chat section (/chat, 2026-11-20, migration 20261120233000) ──────────────────────────────────────────────
// The user: "create a whole separate page in staff for chat and let them be able to edit delete and modify messages in real time".
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'l@example.com', phone: '+966550000101', created_at: '2026-06-10T00:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'o@example.com', phone: '+966550000102', created_at: '2026-06-11T00:00:00Z' },
  { id: 'c3', name: 'Sara Nasser', email: 's@example.com', phone: '+966550000103', created_at: '2026-06-12T00:00:00Z' },
];
type ChatRow = { id: number; customer_id: string | null; staff_user: string | null; body: string; created_at: string; removed_at: string | null; removed_by: string | null;
  removed_user: string | null; reports: number; checked_at: string | null; edited_at: string | null; edited_user: string | null; changed_at: string };
const row = (o: Partial<ChatRow> & { id: number; body: string; created_at: string }): ChatRow => ({ customer_id: null, staff_user: null, removed_at: null, removed_by: null, removed_user: null, reports: 0, checked_at: null, edited_at: null, edited_user: null, changed_at: o.created_at, ...o });
const chat = [
  row({ id: 25, staff_user: 'u-1', body: 'Meet at gate 2', created_at: '2026-11-20T06:00:00Z' }),
  row({ id: 24, customer_id: 'c2', body: 'Buy my old bike, cheap', created_at: '2026-11-19T16:00:00Z', reports: 2 }),
  row({ id: 23, customer_id: 'c3', body: 'Something rude', created_at: '2026-11-19T15:30:00Z', removed_at: '2026-11-19T15:40:00Z', removed_by: 'reports', reports: 3 }),
  row({ id: 22, customer_id: 'c1', body: 'I am in', created_at: '2026-11-19T15:10:00Z', edited_at: '2026-11-19T15:20:00Z', edited_user: 'u-2' }),
  row({ id: 21, customer_id: 'c2', body: 'Who is riding on Saturday?', created_at: '2026-11-19T15:00:00Z', reports: 1, checked_at: '2026-11-19T15:05:00Z' }),
];
const people = [{ user_id: 'u-1', name: 'Huda' }, { user_id: 'u-2', name: 'Faisal' }];
async function staff(page: Page, fx: Fixtures = {}) {
  const log = rpcLog(page);
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], staff_options: [],
    tags: [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: 'green', locked: true }], customer_tags: [],
    hub_chat: chat, hub_chat_members: [{ customer_id: 'c3', muted_until: 'infinity', muted_at: '2026-11-19T15:45:00Z' }],
    hub_chat_edits: [{ id: 1, msg_id: 22, body_before: 'I am inn', body_after: 'I am in', staff_user: 'u-2', created_at: '2026-11-19T15:20:00Z' }],
    'rpc:staff_people': people, ...fx });
  const rt = await stubRealtime(page);
  await unlockStaff(page);
  await page.goto('/chat');
  await waitForSb(page);
  await page.waitForFunction(`S.view==='staff'&&S.staffTab==='chat'`);
  await page.waitForFunction('(S.customers||[]).length>0&&!!S._chs&&S._chs.rows!==null&&!S._chs.busy');
  return { log, rt };
}
const sec = (page: Page) => page.locator('#tab-chat');
const msg = (page: Page, id: number) => sec(page).locator(`.chs-msg[data-ch="${id}"]`);
const msgs2 = (page: Page) => sec(page).locator('.chs-msg[data-ch]');
const fpill = (page: Page, re: RegExp) => sec(page).locator('#chs-pills .filter-pill', { hasText: re });
const setRoute = (page: Page) => page.route('**/rest/v1/rpc/staff_chat_set', (r) => {
  const b = r.request().postDataJSON() as { p_mid: number; p_removed: boolean };
  const x = chat.find((y) => y.id === b.p_mid)!;
  return r.fulfill({ status: 200, headers: json, body: JSON.stringify({ ...x, removed_at: b.p_removed ? '2026-11-20T07:00:00Z' : null, removed_by: b.p_removed ? 'staff' : null, removed_user: b.p_removed ? 'u-1' : null, checked_at: '2026-11-20T07:00:00Z', changed_at: '2026-11-20T07:00:00Z' }) });
});

test.describe('@staff:chat the Chat section', () => {
  test('its own page under People, with the reported messages waiting on the rail; the room oldest first under its day; the writer opens their account', async ({ page }) => {
    await staff(page);
    expect(new URL(page.url()).pathname).toBe('/chat');
    const order = await page.locator('#staff-tab-nav .tab-btn[data-stab]').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.stab));
    expect(order.indexOf('chat')).toBe(order.indexOf('testimonials') + 1);
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="chat"] .tab-badge')).toHaveText('2'); // 24 and 23: reported, nobody looked (21 was kept)
    await expect(sec(page).locator('h1')).toHaveText('Community chat');
    await expect(sec(page).locator('#chs-log')).toHaveAttribute('role', 'log');
    await expect(fpill(page, /^All/)).toHaveText('All (5)');
    await expect(fpill(page, /^Reported/)).toHaveText('Reported (2)');
    await expect(fpill(page, /^Deleted/)).toHaveText('Deleted (1)');
    await expect(fpill(page, /^Edited/)).toHaveText('Edited (1)');
    await expect(fpill(page, /^Muted/)).toHaveText('Muted (1)');
    expect(await msgs2(page).evaluateAll((m) => m.map((x) => (x as HTMLElement).dataset.ch))).toEqual(['21', '22', '23', '24', '25']); // as members see it: newest at the foot
    await expect(sec(page).locator('.chs-day')).toHaveCount(2);
    await expect(msg(page, 25)).toContainText('MicroMobility team');
    await expect(msg(page, 25)).toContainText('Huda'); // which of the team wrote it
    await expect(msg(page, 25).getByRole('button', { name: 'Mute' })).toHaveCount(0);
    await expect(msg(page, 24)).toContainText('Reports: 2');
    await expect(msg(page, 24).getByRole('button', { name: 'Keep' })).toBeVisible();
    await expect(msg(page, 24).locator('.chs-old')).toHaveText('No longer shown to members');
    await expect(msg(page, 23)).toContainText('Hidden after 3 reports');
    await expect(msg(page, 23)).toContainText('Muted until lifted');
    await expect(msg(page, 23).getByRole('button', { name: 'Put back' })).toBeVisible();
    await expect(msg(page, 22).locator('.chs-edtag')).toHaveText('Edited by Faisal');
    await expect(msg(page, 21).getByRole('button', { name: 'Keep' })).toHaveCount(0); // already looked at
    await page.evaluate(`window.__acct=[];window.openAccountHistory=(id)=>{window.__acct.push(id);}`);
    await msg(page, 24).getByRole('button', { name: 'Omar Saleh' }).click();
    expect(await page.evaluate('window.__acct')).toEqual(['c2']);
    // the pills, the search, the Filters
    await fpill(page, /^Reported/).click();
    await expect(msgs2(page)).toHaveCount(2);
    await fpill(page, /^Edited/).click();
    await expect(msgs2(page)).toHaveCount(1);
    await fpill(page, /^Muted/).click();
    await expect(sec(page).locator('[data-chm]')).toHaveCount(1);
    await expect(sec(page).locator('[data-chm]')).toContainText('Sara Nasser');
    await fpill(page, /^All/).click();
    if (!(await sec(page).locator('#chs-q').isVisible())) await sec(page).locator('[data-srch="chs"] .srch-btn').click(); // a phone folds the search into a button
    await sec(page).locator('#chs-q').fill('saturday');
    await expect(msgs2(page)).toHaveCount(1);
    await sec(page).locator('#chs-q').fill('omar');
    await expect(msgs2(page)).toHaveCount(2); // by the writer's name too
    await sec(page).locator('#chs-q').fill('');
    await sec(page).locator('[aria-controls="fm-chs"]').click();
    await sec(page).locator('#chs-f-who').selectOption('team');
    await expect(msgs2(page)).toHaveCount(1);
    await expect(sec(page).locator('[aria-controls="fm-chs"]')).toContainText('(1)');
    // the Members' page no longer has a Chat pill
    expect(await page.evaluate(`typeof _acChHtml`)).toBe('undefined');
    expect(await page.locator('#tab-chat [style]').count()).toBe(0);
  });

  test('Edit: in place, with the words the staffer saw; the message says it was edited and by whom; its earlier wordings open', async ({ page }) => {
    const { log } = await staff(page);
    await page.route('**/rest/v1/rpc/staff_chat_edit', (r) => {
      const b = r.request().postDataJSON() as { p_mid: number; p_body: string };
      const x = chat.find((y) => y.id === b.p_mid)!;
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify({ ...x, body: b.p_body.trim(), edited_at: '2026-11-20T07:00:00Z', edited_user: 'u-1', changed_at: '2026-11-20T07:00:00Z' }) });
    });
    const m = msg(page, 24);
    await m.getByRole('button', { name: 'Edit' }).click();
    const box = m.locator('#chs-ed');
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('Buy my old bike, cheap');
    await expect(m.getByText('Members will see "Edited by the team".')).toBeVisible();
    await box.press('Escape'); // Escape leaves it as it was
    await expect(m.locator('#chs-ed')).toHaveCount(0);
    expect(calls(log, 'staff_chat_edit')).toHaveLength(0);
    await m.getByRole('button', { name: 'Edit' }).click();
    await m.locator('#chs-ed').fill('Selling a bike: [link removed by the team]');
    await expect(m.locator('#chs-ed-n')).toHaveText('42/500');
    await m.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => calls(log, 'staff_chat_edit').length).toBe(1);
    expect(calls(log, 'staff_chat_edit')[0]!.body).toEqual({ p_mid: 24, p_body: 'Selling a bike: [link removed by the team]', p_was: 'Buy my old bike, cheap' });
    await expect(m.locator('.chs-body')).toHaveText('Selling a bike: [link removed by the team]');
    await expect(m.locator('.chs-edtag')).toHaveText('Edited by Huda');
    await expect(fpill(page, /^Edited/)).toHaveText('Edited (2)');
    const said = await page.evaluate(`(S.fullLog||[]).map(x=>x.label).join(' | ')`) as string;
    expect(said).toContain('Chat: Omar Saleh · Edit · Buy my old bike, cheap → Selling a bike: [link removed by the team]');
    // the earlier wording of 22
    await msg(page, 22).locator('.chs-edtag').click();
    await expect(msg(page, 22).locator('.chs-hist')).toContainText('Earlier wording');
    await expect(msg(page, 22).locator('.chs-hist-b')).toHaveText('I am inn');
    await expect(msg(page, 22).locator('.chs-hist')).toContainText('Faisal');
    await msg(page, 22).locator('.chs-edtag').click();
    await expect(msg(page, 22).locator('.chs-hist')).toHaveCount(0);
  });

  test('two staff on one message: a Save over words that changed meanwhile is refused and shows them; the next Save replaces them knowingly', async ({ page }) => {
    const { log } = await staff(page);
    let n = 0;
    await page.route('**/rest/v1/rpc/staff_chat_edit', (r) => {
      const b = r.request().postDataJSON() as { p_mid: number; p_body: string };
      if (n++ === 0) return r.fulfill({ status: 400, headers: json, body: JSON.stringify({ code: 'P0001', message: 'CHANGED', details: null, hint: null }) });
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify({ ...chat[1], body: b.p_body, edited_at: '2026-11-20T07:01:00Z', edited_user: 'u-1', changed_at: '2026-11-20T07:01:00Z' }) });
    });
    const m = msg(page, 24);
    await m.getByRole('button', { name: 'Edit' }).click();
    await m.locator('#chs-ed').fill('My version');
    await expect(m.locator('#chs-ed-warn')).toBeHidden();
    // meanwhile another staffer edited it; this page has not heard yet
    const theirs = chat.map((x) => x.id === 24 ? { ...x, body: 'Their version', edited_at: '2026-11-20T07:00:00Z', edited_user: 'u-2', changed_at: '2026-11-20T07:00:00Z' } : x);
    await page.route('**/rest/v1/hub_chat?**', (r) => r.fulfill({ status: 200, headers: json, body: JSON.stringify(theirs) }));
    await m.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => calls(log, 'staff_chat_edit').length).toBe(1);
    expect(calls(log, 'staff_chat_edit')[0]!.body).toEqual({ p_mid: 24, p_body: 'My version', p_was: 'Buy my old bike, cheap' });
    await expect(m.locator('#chs-ed-warn')).toBeVisible();
    await expect(m.locator('#chs-ed-now')).toHaveText('Their version');
    await expect(m.locator('.chs-edtag')).toHaveText('Edited by Faisal'); // the line on top follows; the box keeps what is typed
    await expect(m.locator('#chs-ed')).toHaveValue('My version');
    await m.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => calls(log, 'staff_chat_edit').length).toBe(2);
    expect(calls(log, 'staff_chat_edit')[1]!.body).toEqual({ p_mid: 24, p_body: 'My version', p_was: 'Their version' });
    await expect(m.locator('.chs-body')).toHaveText('My version');
    await expect(m.locator('#chs-ed')).toHaveCount(0);
  });

  test('Delete, Keep and Put back go through staff_chat_set and to the staff log; a deleted message stays for staff and says who', async ({ page }) => {
    const { log } = await staff(page);
    await setRoute(page);
    await msg(page, 24).getByRole('button', { name: 'Keep' }).click();
    await expect.poll(() => calls(log, 'staff_chat_set').length).toBe(1);
    expect(calls(log, 'staff_chat_set')[0]!.body).toEqual({ p_mid: 24, p_removed: false });
    await expect(msg(page, 24).getByRole('button', { name: 'Keep' })).toHaveCount(0);
    await expect(fpill(page, /^Reported/)).toHaveText('Reported (1)');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="chat"] .tab-badge')).toHaveText('1');
    await msg(page, 23).getByRole('button', { name: 'Put back' }).click();
    await expect.poll(() => calls(log, 'staff_chat_set').length).toBe(2);
    expect(calls(log, 'staff_chat_set')[1]!.body).toEqual({ p_mid: 23, p_removed: false });
    await expect(msg(page, 23).getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="chat"] .tab-badge')).toHaveCount(0);
    await msg(page, 22).getByRole('button', { name: 'Delete' }).click(); // no question: Put back undoes it
    await expect.poll(() => calls(log, 'staff_chat_set').length).toBe(3);
    expect(calls(log, 'staff_chat_set')[2]!.body).toEqual({ p_mid: 22, p_removed: true });
    await expect(msg(page, 22)).toContainText('Deleted by Huda');
    await expect(msg(page, 22).locator('.chs-body')).toHaveText('I am in'); // kept for staff
    await expect(msg(page, 22).getByRole('button', { name: 'Put back' })).toBeVisible();
    const said = await page.evaluate(`(S.fullLog||[]).map(x=>x.label).join(' | ')`) as string;
    expect(said).toContain('Chat: Lina Haddad · Delete · I am in');
    expect(said).toContain('Chat: Omar Saleh · Keep');
  });

  test('Mute opens its three lengths; a muted account shows Lift mute; the team writes as the team with Ctrl+Enter or Send', async ({ page }) => {
    const { log } = await staff(page);
    await page.route('**/rest/v1/rpc/staff_chat_mute', (r) => {
      const b = r.request().postDataJSON() as { p_customer: string; p_days: number | null };
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify({ customer_id: b.p_customer, agreed_at: null, muted_at: b.p_days == null ? null : '2026-11-20T07:00:00Z', muted_until: b.p_days == null ? null : b.p_days === 0 ? 'infinity' : '2099-01-01T00:00:00+00:00' }) });
    });
    let id = 26;
    await page.route('**/rest/v1/rpc/staff_chat_send', (r) => {
      const b = r.request().postDataJSON() as { p_body: string };
      const at = new Date().toISOString();
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify(row({ id: id++, staff_user: 'u-1', body: b.p_body, created_at: at, changed_at: at })) });
    });
    const c24 = msg(page, 24), c21 = msg(page, 21);
    await c24.getByRole('button', { name: 'Mute', exact: true }).click();
    await expect(c24.getByRole('group', { name: 'Mute' }).locator('button')).toHaveText(['1 day', '7 days', 'Until lifted', 'Cancel']);
    await expect(c21.getByRole('group', { name: 'Mute' })).toHaveCount(0); // only the message that asked
    await c24.getByRole('button', { name: 'Cancel' }).click();
    await expect(c24.getByRole('group', { name: 'Mute' })).toHaveCount(0);
    await c24.getByRole('button', { name: 'Mute', exact: true }).click();
    await c24.getByRole('button', { name: '7 days' }).click();
    await expect.poll(() => calls(log, 'staff_chat_mute').length).toBe(1);
    expect(calls(log, 'staff_chat_mute')[0]!.body).toEqual({ p_customer: 'c2', p_days: 7 });
    await expect(c24).toContainText('Muted until');
    await expect(c21).toContainText('Muted until'); // both of this member's messages say so
    await expect(fpill(page, /^Muted/)).toHaveText('Muted (2)');
    await c21.getByRole('button', { name: 'Lift mute' }).click();
    await expect.poll(() => calls(log, 'staff_chat_mute').length).toBe(2);
    expect(calls(log, 'staff_chat_mute')[1]!.body).toEqual({ p_customer: 'c2', p_days: null });
    await expect(fpill(page, /^Muted/)).toHaveText('Muted (1)');
    // the team's box
    const box = sec(page).getByLabel('Message as the MicroMobility team');
    await sec(page).locator('#chs-go').click(); // nothing typed: nothing sent
    expect(calls(log, 'staff_chat_send')).toHaveLength(0);
    await box.fill('  Route change: we start at the north gate  ');
    await sec(page).locator('#chs-go').click();
    await expect.poll(() => calls(log, 'staff_chat_send').length).toBe(1);
    expect(calls(log, 'staff_chat_send')[0]!.body).toEqual({ p_body: 'Route change: we start at the north gate' });
    await expect(msgs2(page).last()).toContainText('Route change: we start at the north gate');
    await expect(msgs2(page).last().locator('.chs-old')).toHaveCount(0); // written just now: members still see it
    await expect(box).toHaveValue('');
    await box.fill('Second one');
    await box.press('Control+Enter');
    await expect.poll(() => calls(log, 'staff_chat_send').length).toBe(2);
    await expect(msgs2(page).last()).toContainText('Second one');
  });

  test('live: a tick on the topic reads what changed since the last read; a new message and a change land without touching the boxes', async ({ page }) => {
    const { rt } = await staff(page);
    await page.waitForFunction('S._chs.live===true'); // the topic is joined
    await expect(sec(page).locator('#chs-live')).toHaveText('Live');
    const asked: string[] = [];
    let now = [...chat];
    await page.route('**/rest/v1/hub_chat?**', (r) => {
      const u = new URL(r.request().url()); asked.push(u.searchParams.get('changed_at') || '');
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify(u.searchParams.get('changed_at') ? now : chat) });
    });
    const box = sec(page).getByLabel('Message as the MicroMobility team');
    await box.fill('Half typed');
    await msg(page, 21).getByRole('button', { name: 'Edit' }).click();
    await msg(page, 21).locator('#chs-ed').fill('Editing here');
    now = [{ ...chat[1]!, body: 'Changed elsewhere', edited_at: '2026-11-20T07:00:00Z', edited_user: 'u-2', changed_at: '2026-11-20T07:00:00Z' },
      row({ id: 26, customer_id: 'c3', body: 'Just arrived', created_at: '2026-11-20T07:00:05Z' })];
    rt.broadcast('realtime:hub-chat', 'tick', {});
    await expect(msg(page, 26)).toContainText('Just arrived');
    await expect(msg(page, 24).locator('.chs-body')).toHaveText('Changed elsewhere');
    await expect(msg(page, 24).locator('.chs-edtag')).toHaveText('Edited by Faisal');
    expect(asked.some((x) => /^gte\.2026-11-20T05:59:5/.test(x))).toBe(true); // since the newest change it had read, less five seconds
    await expect(box).toHaveValue('Half typed');
    await expect(msg(page, 21).locator('#chs-ed')).toHaveValue('Editing here');
    // a staff-only change (a report) comes as 'staff'
    now = [{ ...chat[4]!, reports: 2, checked_at: null, changed_at: '2026-11-20T07:01:00Z' }];
    await page.evaluate('S._chs.tickNext=0');
    rt.broadcast('realtime:hub-chat', 'staff', {});
    await expect(msg(page, 21)).toContainText('Reports: 2');
    await expect(msg(page, 21).locator('#chs-ed')).toHaveValue('Editing here');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="chat"] .tab-badge')).toHaveText('3');
  });

  test('Earlier messages reads the page before the first one held; staff keep every message', async ({ page }) => {
    const many = Array.from({ length: 300 }, (_, i) => row({ id: 1000 - i, customer_id: 'c2', body: 'message ' + (1000 - i), created_at: '2026-11-19T10:00:00Z' }));
    const older = [row({ id: 700, customer_id: 'c1', body: 'from last year', created_at: '2025-11-19T10:00:00Z' }),
      row({ id: 699, customer_id: 'c3', body: 'the very first message', created_at: '2025-11-18T10:00:00Z' })];
    const asked: string[] = [];
    await staff(page, { hub_chat: many });
    await page.route('**/rest/v1/hub_chat?**', (r) => {
      const u = new URL(r.request().url()); asked.push(u.searchParams.get('id') || '');
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify(u.searchParams.get('id') ? older : []) });
    });
    await expect(msgs2(page)).toHaveCount(300);
    await sec(page).getByRole('button', { name: 'Earlier messages' }).click();
    await expect(msgs2(page)).toHaveCount(302);
    expect(asked).toContain('lt.701');
    await expect(msgs2(page).first()).toContainText('the very first message');
    await expect(msgs2(page).first().locator('.chs-old')).toHaveText('No longer shown to members'); // a year on, staff still read it
    await expect(sec(page).getByRole('button', { name: 'Earlier messages' })).toHaveCount(0); // that was all of them
  });

  test('a view-only account sees the room and no actions; a database without the chat says so; one before the edits offers no Edit', async ({ page }) => {
    await staff(page);
    await page.evaluate(`S._myEdit=[];renderChat()`);
    await expect(msgs2(page)).toHaveCount(5);
    await expect(sec(page).locator('#chs-text')).toHaveCount(0);
    await expect(sec(page).locator('.chs-acts')).toHaveCount(0);
    await page.evaluate(`S._myEdit=null`);
    // a database before 20261120233000: the new columns are unknown
    await page.route('**/rest/v1/hub_chat?**', (r) => {
      const u = new URL(r.request().url());
      if ((u.searchParams.get('select') || '').includes('changed_at')) return r.fulfill({ status: 400, headers: json, body: JSON.stringify({ code: '42703', message: 'column hub_chat.edited_at does not exist' }) });
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify(chat.map(({ edited_at: _e, edited_user: _u, changed_at: _c, ...x }) => x)) });
    });
    await page.evaluate(`S._chs=null;renderChat()`);
    await page.waitForFunction('S._chs&&S._chs.old===true&&S._chs.rows&&S._chs.rows.length===5');
    await expect(msgs2(page)).toHaveCount(5);
    await expect(sec(page).getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(sec(page).getByRole('button', { name: 'Delete' }).first()).toBeVisible();
    await expect(fpill(page, /^Edited/)).toHaveCount(0);
    // a database without the chat
    await page.route('**/rest/v1/hub_chat**', (r) => r.fulfill({ status: 404, headers: json, body: JSON.stringify({ code: 'PGRST205', message: `Could not find the table 'public.hub_chat' in the schema cache` }) }));
    await page.evaluate(`S._chs=null;renderChat()`);
    await expect(sec(page)).toContainText('The chat is not set up on the database yet.');
  });
});

test.describe('@customer:members Community chat, the team\'s edits', () => {
  test('an edit reaches the open page: the words are swapped in place and marked "Edited by the team"', async ({ page }) => {
    const { rt } = await member(page);
    let i = 0;
    await page.route('**/rest/v1/rpc/chat_read', (r) => {
      const b = r.request().postDataJSON() as { p_after?: number };
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify(b.p_after == null ? read() : read({ rows: [], edits: i++ ? [] : [{ ...msgs[2], body: 'I am in [edited]', ed: true }] })) });
    });
    await openChat(page);
    await expect(rowsEl(page)).toHaveCount(4);
    await expect(pageEl(page).locator('.cht-ed')).toHaveCount(0);
    await page.waitForFunction('S._chtLive===true');
    rt.broadcast('realtime:hub-chat', 'tick', {});
    const r13 = pageEl(page).locator('.cht-row[data-id="13"]');
    await expect(r13.locator('.cht-body')).toHaveText('I am in [edited]');
    await expect(r13.locator('.cht-ed')).toHaveText('Edited by the team');
    await expect(rowsEl(page)).toHaveCount(4);
    // the staff-only broadcast is not the members' tick
    const before = await page.evaluate(`S._cht.readAt`);
    rt.broadcast('realtime:hub-chat', 'staff', {});
    await page.waitForTimeout(800);
    expect(await page.evaluate(`S._cht.readAt`)).toBe(before);
  });
});

// The staff page (20261120233000): staff edits are kept, members see they were edited, the live signals carry nothing.
test.describe('@build Community chat, the staff page', () => {
  const sql = readFileSync(resolve(__dirname, '../supabase/migrations/20261120233000_community_chat_staff_page.sql'), 'utf8');
  const fnBody = (name: string) => { const i = sql.indexOf(`create or replace function public.${name}(`); expect(i, name).toBeGreaterThan(-1); return sql.slice(i, sql.indexOf('$$;', i)); };

  test('an edit needs the Community edit right, keeps the earlier words and refuses words that changed meanwhile', () => {
    const b = fnBody('staff_chat_edit');
    expect(b).toContain(`if (select _staff_mod('community', true)) is not true then raise exception 'FORBIDDEN'`);
    expect(b).toContain('_chat_clean(p_body)');
    expect(b).toContain(`if p_was is not null and r.body is distinct from p_was then raise exception 'CHANGED'`);
    expect(b.indexOf('insert into hub_chat_edits')).toBeLessThan(b.indexOf('update hub_chat m set body'));
    expect(b).toContain('language plpgsql volatile security definer set search_path to');
    expect(sql).toContain('revoke all on function public.staff_chat_edit(bigint, text, text) from public, anon;');
    expect(sql).not.toMatch(/delete from (public\.)?hub_chat/); // nothing is ever deleted
  });

  test('the edits table is closed to riders, staff read only; members read that a message was edited, never the earlier words', () => {
    expect(sql).toContain('alter table public.hub_chat_edits enable row level security;');
    expect(sql).toContain('revoke all on public.hub_chat_edits from public, anon, authenticated;');
    expect(sql).toContain(`create policy "staff read" on public.hub_chat_edits for select using ((select _staff_mod('community')));`);
    const i = sql.indexOf('create or replace function public._chat_row('), r = sql.slice(i, sql.indexOf('$$;', i));
    expect([...r.matchAll(/'(\w+)',\s/g)].map((m) => m[1]).sort()).toEqual(['at', 'body', 'day', 'ed', 'id', 'k', 'mine', 'name', 'team']);
    expect(r).not.toMatch(/hub_chat_edits|body_before/);
    const read = fnBody('chat_read');
    expect(read.indexOf('not _cust_token_ok(p_id, p_token)')).toBeLessThan(read.indexOf('not _member_active(p_id)'));
    expect(read).toContain(`m.edited_at > now() - interval '2 days' and _chat_shown(m)`);
  });

  test('the signals stay empty: an edit sends the members\' tick, a report, a Keep and a mute send the staff one', () => {
    expect(fnBody('_chat_tick_staff')).toContain(`perform realtime.send('{}'::jsonb, 'staff', 'hub-chat', false);`);
    expect(sql).toMatch(/create trigger hub_chat_tick_body after update of body on public\.hub_chat\s+for each row when \(old\.body is distinct from new\.body\) execute function public\._chat_tick\(\);/);
    expect(sql).toContain('create trigger hub_chat_tick_staff after update of reports, checked_at on public.hub_chat');
    expect(sql).toContain('create trigger hub_chat_members_tick_upd after update of muted_until on public.hub_chat_members');
    expect(sql).not.toMatch(/supabase_realtime/);
  });
});
