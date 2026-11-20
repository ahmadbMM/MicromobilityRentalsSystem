import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, stubRealtime, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';
import { hubPart } from './helpers/hub';

// The Community chat (2026-11-20, migration 20261120203000; the user: "can we create a live chat in the booking app but only
// for community members?", then "Full name", "One club chat", "Text only"). The member's side is a card on the Community tab
// (member-hub.js) and its own page; the staff side is Community > Activities > Chat. All Supabase traffic is stubbed, the
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
// The card leads the Club part of the tab (the three parts of 2026-11-20), reached through the switch as a member does.
async function openClub(page: Page) {
  await openTab(page);
  await hubPart(page, 'club');
}
async function openChat(page: Page) {
  await openClub(page);
  await card(page).getByRole('button', { name: 'Open the chat' }).click();
  await expect(pageEl(page).locator('h2')).toHaveText('Community chat');
}
const card = (page: Page) => page.locator('#hub-body .cht-card');
const pageEl = (page: Page) => page.locator('#hub-body #cht-page');
const rowsEl = (page: Page) => pageEl(page).locator('.cht-row');
const dlg = (page: Page) => page.locator('#confirm-modal .confirm-box');
const calls = (log: { fn: string; body: Record<string, unknown> }[], fn: string) => log.filter((x) => x.fn === fn);

test.describe('@customer:members Community chat', () => {
  test('the card counts what is new; the page shows each message under its writer\'s full name, the member\'s own on the other side, the team\'s by name', async ({ page }) => {
    const { log } = await member(page, { 'rpc:chat_peek': { ok: true, n: 3 } });
    await openClub(page);
    await expect(card(page)).toContainText('Community chat');
    expect(await page.evaluate(`document.querySelector('#hub-pane-club .hub-card')===document.querySelector('#hub-body .cht-card')`)).toBe(true); // it leads the Club part
    await expect(card(page).locator('.cht-n')).toHaveText('3 new');
    expect(calls(log, 'chat_peek')[0]!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_after: null }); // nothing read to the end on this phone yet
    expect(calls(log, 'chat_read')).toHaveLength(0); // no message is read for the card
    await card(page).getByRole('button', { name: 'Open the chat' }).click();
    await expect(pageEl(page).locator('h2')).toHaveText('Community chat');
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
    // Close goes back to the Club part; the card no longer counts them
    await pageEl(page).getByRole('button', { name: 'Close' }).click();
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('.cht-n')).toHaveCount(0);
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

  test('/members?hv=chat opens the chat from a cold link, and the address is cleaned', async ({ page }) => {
    await member(page, {}, '/members?src=push&hv=chat');
    await expect(pageEl(page).locator('h2')).toHaveText('Community chat');
    await expect(rowsEl(page)).toHaveCount(4);
    expect(new URL(page.url()).search).toBe('');
  });

  test('a database without it: no card; one that loses it while the page is open closes the page', async ({ page }) => {
    await member(page, { 'rpc:chat_peek': absent('chat_peek') });
    await openTab(page);
    await expect(card(page)).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await member(page, { 'rpc:chat_read': absent('chat_read') });
    await openClub(page);
    await card(page).getByRole('button', { name: 'Open the chat' }).click();
    await expect(page.locator('#hub-pane-club')).toBeVisible(); // back in the Club part
    await expect(page.locator('#cht-page')).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
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
    const bad = await page.evaluate(`Object.entries(HUB_T).filter(([k])=>k.startsWith('cht')).filter(([k,v])=>v.length!==10||v.some(x=>!String(x).trim())).map(([k])=>k)`);
    expect(bad).toEqual([]);
    expect(await page.evaluate(`Object.keys(HUB_T).filter(k=>k.startsWith('cht')).length`)).toBeGreaterThanOrEqual(19);
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

  test('the ping is empty and public; staff calls need the Community edit right; old messages go after 12 months', () => {
    expect(sql).toContain(`perform realtime.send('{}'::jsonb, 'tick', 'hub-chat', false);`);
    for (const f of ['staff_chat_send', 'staff_chat_set', 'staff_chat_mute']) {
      expect(fnBody(f)).toContain(`if (select _staff_mod('community', true)) is not true then raise exception 'FORBIDDEN'`);
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon;`));
    }
    expect(sql).toContain(`delete from hub_chat m where m.created_at < now() - interval '12 months';`);
    expect(sql).toContain(`perform cron.schedule('mm-chat-purge'`);
    // the limits and the third report
    expect(fnBody('chat_send')).toContain(`interval '5 minutes') >= 20`);
    expect(fnBody('chat_send')).toContain(`if p_agree is not true then return jsonb_build_object('ok', false, 'error', 'agree');`);
    expect(fnBody('chat_report')).toContain('v_n >= 3');
    expect(fnBody('chat_report')).toContain('m.customer_id = any(v_me)'); // never their own
  });
});

// ── Staff: Community > Activities > Chat ────────────────────────────────────────────────────────────────────────────────
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'l@example.com', phone: '+966550000101', created_at: '2026-06-10T00:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'o@example.com', phone: '+966550000102', created_at: '2026-06-11T00:00:00Z' },
  { id: 'c3', name: 'Sara Nasser', email: 's@example.com', phone: '+966550000103', created_at: '2026-06-12T00:00:00Z' },
];
const chat = [
  { id: 25, customer_id: null, staff_user: 'u-1', body: 'Meet at gate 2', created_at: '2026-11-20T06:00:00Z', removed_at: null, removed_by: null, reports: 0, checked_at: null },
  { id: 24, customer_id: 'c2', staff_user: null, body: 'Buy my old bike, cheap', created_at: '2026-11-19T16:00:00Z', removed_at: null, removed_by: null, reports: 2, checked_at: null },
  { id: 23, customer_id: 'c3', staff_user: null, body: 'Something rude', created_at: '2026-11-19T15:30:00Z', removed_at: '2026-11-19T15:40:00Z', removed_by: 'reports', reports: 3, checked_at: null },
  { id: 22, customer_id: 'c1', staff_user: null, body: 'I am in', created_at: '2026-11-19T15:10:00Z', removed_at: null, removed_by: null, reports: 0, checked_at: null },
  { id: 21, customer_id: 'c2', staff_user: null, body: 'Who is riding on Saturday?', created_at: '2026-11-19T15:00:00Z', removed_at: null, removed_by: null, reports: 1, checked_at: '2026-11-19T15:05:00Z' },
];
async function staff(page: Page, fx: Fixtures = {}) {
  const log = rpcLog(page);
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], staff_options: [],
    tags: [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: 'green', locked: true }], customer_tags: [],
    titles: [], customer_titles: [], rotm_rounds: [], hub_goals: [], squads: [], squad_members: [], hub_photos: [], member_welcome: [], hub_posts: [], badges: [],
    ride_suggestions: [], hub_chat: chat, hub_chat_members: [{ customer_id: 'c3', muted_until: 'infinity', muted_at: '2026-11-19T15:45:00Z' }], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
  await page.waitForFunction('S._acAt>0&&!S._acBusy&&!!S._ac&&!!S._acCh');
  return log;
}
const tab = (page: Page) => page.locator('#tab-community');
const cards = (page: Page) => tab(page).locator('[data-ch]');
const fpill = (page: Page, re: RegExp) => tab(page).locator('#ac-ch-list .filter-pill', { hasText: re });

test.describe('@staff:community Chat', () => {
  test('the pill counts the reports nobody has looked at; All, Reported, Removed and Muted; the writer\'s name opens their account', async ({ page }) => {
    await staff(page);
    const pill = tab(page).locator('.filter-pill', { hasText: /^Chat/ });
    await expect(pill).toHaveText('Chat (2)'); // 24 and 23: reported, not yet looked at (21 was kept)
    await pill.click();
    await expect(fpill(page, /^All/)).toHaveText('All (5)');
    await expect(fpill(page, /^Reported/)).toHaveText('Reported (2)');
    await expect(fpill(page, /^Removed/)).toHaveText('Removed (1)');
    await expect(fpill(page, /^Muted/)).toHaveText('Muted (1)');
    await expect(cards(page)).toHaveCount(5); // newest first
    await expect(cards(page).nth(0)).toContainText('Team');
    await expect(cards(page).nth(0)).toContainText('Meet at gate 2');
    await expect(cards(page).nth(0).getByRole('button', { name: 'Mute' })).toHaveCount(0); // nobody to mute on the team's own
    await expect(cards(page).nth(1)).toContainText('Omar Saleh');
    await expect(cards(page).nth(1)).toContainText('Reports: 2');
    await expect(cards(page).nth(1).getByRole('button', { name: 'Keep' })).toBeVisible();
    await expect(cards(page).nth(2)).toContainText('Hidden after 3 reports');
    await expect(cards(page).nth(2)).toContainText('Muted until lifted');
    await expect(cards(page).nth(2).getByRole('button', { name: 'Put back' })).toBeVisible();
    await expect(cards(page).nth(4).getByRole('button', { name: 'Keep' })).toHaveCount(0); // already looked at
    await page.evaluate(`window.__acct=[];window.openAccountHistory=(id)=>{window.__acct.push(id);}`);
    await cards(page).nth(1).getByRole('button', { name: 'Omar Saleh' }).click();
    expect(await page.evaluate('window.__acct')).toEqual(['c2']);
    await fpill(page, /^Reported/).click();
    await expect(cards(page)).toHaveCount(2);
    await fpill(page, /^Removed/).click();
    await expect(cards(page)).toHaveCount(1);
    await fpill(page, /^Muted/).click();
    await expect(tab(page).locator('[data-chm]')).toHaveCount(1);
    await expect(tab(page).locator('[data-chm]')).toContainText('Sara Nasser');
    expect(await page.locator('#ac-ch-list [style]').count()).toBe(0);
  });

  test('Remove, Keep and Put back go through staff_chat_set and to the staff log', async ({ page }) => {
    const log = await staff(page);
    await page.route('**/rest/v1/rpc/staff_chat_set', (r) => {
      const b = r.request().postDataJSON() as { p_mid: number; p_removed: boolean };
      const row = chat.find((x) => x.id === b.p_mid)!;
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify({ ...row, removed_at: b.p_removed ? '2026-11-20T07:00:00Z' : null, removed_by: b.p_removed ? 'staff' : null, checked_at: '2026-11-20T07:00:00Z' }) });
    });
    await tab(page).locator('.filter-pill', { hasText: /^Chat/ }).click();
    const c24 = tab(page).locator('[data-ch="24"]'), c23 = tab(page).locator('[data-ch="23"]'), c22 = tab(page).locator('[data-ch="22"]');
    await c24.getByRole('button', { name: 'Keep' }).click();
    await expect.poll(() => calls(log, 'staff_chat_set').length).toBe(1);
    expect(calls(log, 'staff_chat_set')[0]!.body).toEqual({ p_mid: 24, p_removed: false });
    await expect(c24.getByRole('button', { name: 'Keep' })).toHaveCount(0);
    await expect(fpill(page, /^Reported/)).toHaveText('Reported (1)');
    await c23.getByRole('button', { name: 'Put back' }).click();
    await expect.poll(() => calls(log, 'staff_chat_set').length).toBe(2);
    expect(calls(log, 'staff_chat_set')[1]!.body).toEqual({ p_mid: 23, p_removed: false });
    await expect(c23.getByRole('button', { name: 'Remove' })).toBeVisible();
    await c22.getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => calls(log, 'staff_chat_set').length).toBe(3);
    expect(calls(log, 'staff_chat_set')[2]!.body).toEqual({ p_mid: 22, p_removed: true });
    await expect(c22).toContainText('Removed by staff');
    await expect(c22.getByRole('button', { name: 'Put back' })).toBeVisible();
    const said = await page.evaluate(`(S.fullLog||[]).map(x=>x.label).join(' | ')`) as string;
    expect(said).toContain('Chat: Lina Haddad · Remove');
    expect(said).toContain('Chat: Omar Saleh · Keep');
  });

  test('Mute opens its three lengths; a muted account shows Lift mute; the team writes as the team', async ({ page }) => {
    const log = await staff(page);
    await page.route('**/rest/v1/rpc/staff_chat_mute', (r) => {
      const b = r.request().postDataJSON() as { p_customer: string; p_days: number | null };
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify({ customer_id: b.p_customer, agreed_at: null, muted_at: b.p_days == null ? null : '2026-11-20T07:00:00Z', muted_until: b.p_days == null ? null : b.p_days === 0 ? 'infinity' : '2099-01-01T00:00:00+00:00' }) });
    });
    await page.route('**/rest/v1/rpc/staff_chat_send', (r) => {
      const b = r.request().postDataJSON() as { p_body: string };
      return r.fulfill({ status: 200, headers: json, body: JSON.stringify({ id: 26, customer_id: null, staff_user: 'u-1', body: b.p_body, created_at: '2026-11-20T08:00:00Z', removed_at: null, removed_by: null, reports: 0, checked_at: null }) });
    });
    await tab(page).locator('.filter-pill', { hasText: /^Chat/ }).click();
    const c24 = tab(page).locator('[data-ch="24"]'), c21 = tab(page).locator('[data-ch="21"]');
    await c24.getByRole('button', { name: 'Mute', exact: true }).click();
    await expect(c24.getByRole('group', { name: 'Mute' }).locator('button')).toHaveText(['1 day', '7 days', 'Until lifted', 'Cancel']);
    await expect(c21.getByRole('group', { name: 'Mute' })).toHaveCount(0); // only the card that asked
    await c24.getByRole('button', { name: 'Cancel' }).click();
    await expect(c24.getByRole('group', { name: 'Mute' })).toHaveCount(0);
    expect(calls(log, 'staff_chat_mute')).toHaveLength(0);
    await c24.getByRole('button', { name: 'Mute', exact: true }).click();
    await c24.getByRole('button', { name: '7 days' }).click();
    await expect.poll(() => calls(log, 'staff_chat_mute').length).toBe(1);
    expect(calls(log, 'staff_chat_mute')[0]!.body).toEqual({ p_customer: 'c2', p_days: 7 });
    await expect(c24).toContainText('Muted until'); // both of this member's messages say so
    await expect(c21).toContainText('Muted until');
    await expect(fpill(page, /^Muted/)).toHaveText('Muted (2)');
    await c21.getByRole('button', { name: 'Lift mute' }).click();
    await expect.poll(() => calls(log, 'staff_chat_mute').length).toBe(2);
    expect(calls(log, 'staff_chat_mute')[1]!.body).toEqual({ p_customer: 'c2', p_days: null });
    await expect(c24.getByRole('button', { name: 'Mute', exact: true })).toBeVisible();
    await expect(fpill(page, /^Muted/)).toHaveText('Muted (1)');
    // the team's own message
    const box = tab(page).getByLabel('Message as the MicroMobility team');
    await tab(page).locator('#ac-ch-go').click(); // nothing typed: nothing sent
    expect(calls(log, 'staff_chat_send')).toHaveLength(0);
    await box.fill('  Route change: we start at the north gate  ');
    await tab(page).locator('#ac-ch-go').click();
    await expect.poll(() => calls(log, 'staff_chat_send').length).toBe(1);
    expect(calls(log, 'staff_chat_send')[0]!.body).toEqual({ p_body: 'Route change: we start at the north gate' });
    await expect(cards(page).first()).toContainText('Route change: we start at the north gate');
    await expect(cards(page).first()).toContainText('Team');
    await expect(box).toHaveValue('');
  });

  test('the list reads again by itself without touching the box; a view-only account sees no actions; a database without it has no pill', async ({ page }) => {
    await staff(page);
    await tab(page).locator('.filter-pill', { hasText: /^Chat/ }).click();
    const box = tab(page).getByLabel('Message as the MicroMobility team');
    await box.fill('Typing a long');
    await page.evaluate(`window.__box=document.getElementById('ac-ch-text');S._acCh=S._acCh.slice(0,2);_acChPaint()`);
    await expect(cards(page)).toHaveCount(2);
    expect(await page.evaluate(`window.__box===document.getElementById('ac-ch-text')&&window.__box.value`)).toBe('Typing a long');
    // view only
    await page.evaluate(`S._myEdit=[];renderCommunity()`);
    await expect(cards(page)).toHaveCount(2);
    await expect(tab(page).locator('#ac-ch-text')).toHaveCount(0);
    await expect(cards(page).first().locator('button:not(.ca-link)')).toHaveCount(0);
    // a database without the table
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.route('**/rest/v1/hub_chat?**', (r) => r.fulfill({ status: 404, headers: json, body: JSON.stringify({ code: 'PGRST205', message: `Could not find the table 'public.hub_chat' in the schema cache` }) }));
    await page.evaluate(`S._myEdit=null;S._acTabV='goals';S._acChAt=0;_acChLoad(true)`);
    await page.waitForFunction('S._acChMissing===true');
    await expect(tab(page).locator('.filter-pill', { hasText: /^Chat/ })).toHaveCount(0);
  });
});
