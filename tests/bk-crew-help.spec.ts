import { test, expect, type Page, type Route, type WebSocketRoute, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Two staff-only Bookings features the user picked on 2026-11-18 from a list of proposed ones:
// - Tonight's crew (migration 20261118230000): "Who is working tonight and in what role: desk, bikes, leader, sweeper or
//   door. It's set in the opening checklist, shows next to Notes, and fills in the part-timers' hours at close-out."
//   session_crew rows; the figures bar's Crew (N) after Notes and its centred pop-up; another desk's change on staff-ref;
//   the opening list's Crew set; the close-out's part-timers' hours pre-filled with the crew's part-timers.
// - Call for help (no table): "A desk button that sends 'Help needed at bikes' to the other staff devices through the
//   bell." The call rides in the caller's presence on the private topic staff-desk; the others get a centred pop-up and a
//   bell line, and On my way is the responder's presence. This spec answers the realtime socket itself, so it can read
//   what the page tracks and send the presence another device would have.
// Invented people only; the clock is fixed on the night so it is always "today".

const DAY = '2099-05-05';
const NOW = new Date(`${DAY}T20:00:00+03:00`);
const session = {
  id: 's0', day: 'Tuesday', session_date: DAY, capacity: 12, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ Road: 4, _time: '20:00 - 23:00' }),
};
const A = 'aaaa1111-0000-4000-8000-0000000000a1';
const rows = [{
  id: A, session_id: 's0', session_day: 'Tuesday', session_date: DAY, queue_num: 1, name: 'Amal Road', phone: '', customer_id: null, group_id: null,
  status: 'waiting', paid: true, price: 75, walk_in: true, registered_at: `${DAY}T15:00:00Z`, height: 175, type_preference: 'Road',
}];
const SARA = '5a5a0000-0000-4000-8000-000000000001', OMAR = '0a0a0000-0000-4000-8000-000000000002', LINA = '1a1a0000-0000-4000-8000-000000000003';
const people = [
  { user_id: SARA, name: 'Sara Desk', part_timer: false },
  { user_id: OMAR, name: 'Omar Part', part_timer: true },
  { user_id: LINA, name: 'Lina Lead', part_timer: false },
];
const nameOf = (u: unknown) => people.find((p) => p.user_id === u)?.name || 'staff';
const crewSara = { id: 'cr-1', session_id: 's0', staff_user_id: SARA, name: 'Sara Desk', role: 'desk', created_by_name: 'Dana', created_at: `${DAY}T14:00:00Z` };
const head = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };

type Sent = { m: string; url: string; body?: Record<string, unknown> };
// session_crew as the server would hold it: an insert comes back stamped with the person's name, an update is guarded
// on the role in the address, a delete takes the row away.
async function serveCrew(page: Page, held: Record<string, unknown>[]) {
  const sent: Sent[] = [];
  await page.route(/\/rest\/v1\/session_crew/, async (r: Route) => {
    const m = r.request().method(), url = decodeURIComponent(r.request().url());
    if (m === 'GET') return r.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${held.length}/${held.length}` }, body: JSON.stringify(held) });
    const id = url.match(/id=eq\.([^&]+)/)?.[1];
    if (m === 'POST') {
      const b = r.request().postDataJSON() as Record<string, unknown>;
      sent.push({ m, url, body: b });
      const x = { ...b, id: 'cr-' + (held.length + 10), name: nameOf(b.staff_user_id), created_by_name: 'Spec Staff', created_at: NOW.toISOString() };
      held.push(x);
      return r.fulfill({ status: 201, headers: head, body: JSON.stringify([x]) });
    }
    if (m === 'PATCH') {
      const b = r.request().postDataJSON() as Record<string, unknown>;
      sent.push({ m, url, body: b });
      const was = url.match(/role=eq\.([a-z]+)/)?.[1], x = held.find((y) => y.id === id && (!was || y.role === was));
      if (x) Object.assign(x, b);
      return r.fulfill({ status: 200, headers: head, body: JSON.stringify(x ? [x] : []) });
    }
    if (m === 'DELETE') {
      sent.push({ m, url });
      const i = held.findIndex((y) => y.id === id), gone = i >= 0 ? held.splice(i, 1) : [];
      return r.fulfill({ status: 200, headers: head, body: JSON.stringify(gone.map((x) => ({ id: x.id }))) });
    }
    return r.fallback();
  });
  return sent;
}

// The realtime socket, answered here (as helpers/supabase.ts stubRealtime does), keeping what the page tracks on
// staff-desk and sending what another device's presence would be.
type Joined = { ws: WebSocketRoute; topic: string; joinRef: unknown; asArray: boolean };
async function liveStub(page: Page) {
  const joined: Joined[] = [];
  const tracks: Record<string, unknown>[] = [];
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    ws.onMessage((raw) => {
      let p: unknown;
      try { p = JSON.parse(String(raw)); } catch { return; }
      const asArray = Array.isArray(p);
      const [joinRef, ref, topic, event, payload] = asArray ? p as unknown[]
        : (() => { const o = p as Record<string, unknown>; return [o.join_ref, o.ref, o.topic, o.event, o.payload]; })();
      const pl = (payload || {}) as Record<string, unknown>;
      if (event === 'presence' && topic === 'realtime:staff-desk' && pl.event === 'track') tracks.push(pl.payload as Record<string, unknown>);
      if (ref == null) return;
      if (event === 'phx_join') joined.push({ ws, topic: String(topic), joinRef, asArray });
      const pc = event === 'phx_join' ? (((pl.config || {}) as Record<string, unknown>).postgres_changes as Record<string, unknown>[] || []) : [];
      const reply = { status: 'ok', response: event === 'phx_join' ? { postgres_changes: pc.map((b, i) => ({ ...b, id: i + 1 })) } : {} };
      ws.send(JSON.stringify(asArray ? [joinRef, ref, topic, 'phx_reply', reply] : { join_ref: joinRef, ref, topic, event: 'phx_reply', payload: reply }));
    });
  });
  const send = (topic: string, event: string, payload: unknown) => {
    for (const j of joined.filter((x) => x.topic === topic)) {
      j.ws.send(JSON.stringify(j.asArray ? [j.joinRef, null, topic, event, payload] : { join_ref: j.joinRef, ref: null, topic, event, payload }));
    }
  };
  return {
    tracks,
    broadcast: (topic: string, event: string, payload: unknown) => send(topic, 'broadcast', { type: 'broadcast', event, payload }),
    presence: (state: Record<string, unknown>) => send('realtime:staff-desk', 'presence_state', state),
    diff: (d: Record<string, unknown>) => send('realtime:staff-desk', 'presence_diff', d),
  };
}

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { queue_entries: rows, sessions: [session], bikes: [], 'rpc:staff_crew_people': people, ...extra });
  const rt = await liveStub(page);
  await unlockStaff(page);
  return rt;
}
async function toRoster(page: Page) {
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
}
async function live(page: Page) {
  await page.evaluate(`S._staffAuthed = true; setupRefRealtime()`);
  await page.waitForFunction(`_refLive === true && !!_n6bPresCh && _n6bPresCh.state === 'joined'`, null, { timeout: 8000 });
}
const sheet = (page: Page) => page.locator('#desk-sheet [role="dialog"]');
const logLines = (page: Page) => page.evaluate(`S.fullLog.map(l=>l.label)`) as Promise<string[]>;

test.describe('@staff:bookings Tonight\'s crew', () => {
  test('Crew (N) sits after Notes; the pop-up adds (saying what is missing), changes a role and removes, with the right rows and no toast', async ({ page }) => {
    await boot(page);
    const held: Record<string, unknown>[] = [{ ...crewSara }];
    const sent = await serveCrew(page, held);
    await toRoster(page);
    const figs = page.locator('#q-live-count .s10-figs');
    const chip = figs.locator('.crw-chip');
    await expect(chip).toHaveText(/Crew \(1\)/);
    await expect(figs.locator('.snt-chip + .crw-chip')).toHaveCount(1);            // right after Notes
    // also a More action in the header's Session group, with Call for help first
    await page.locator('#tab-queue .sh-more').first().click();
    const items = await page.getByRole('menuitem').allTextContents();
    const call = items.findIndex((x) => /Call for help/.test(x)), open = items.findIndex((x) => /Open the night/.test(x)), crew = items.findIndex((x) => /Tonight.s crew/.test(x));
    expect(call).toBeGreaterThanOrEqual(0);
    expect(call).toBeLessThan(open);
    expect(open).toBeLessThan(crew);
    await page.getByRole('menuitem', { name: /Tonight.s crew/ }).click();
    const dlg = sheet(page);
    await expect(dlg).toContainText('Sara Desk');
    await dlg.getByRole('button', { name: 'Close' }).last().click();
    await chip.click();
    await expect(dlg).toContainText('Tonight\'s crew');
    await expect(dlg.locator('.crw-li')).toHaveCount(1);
    await expect(dlg.locator('.ck-h').first()).toContainText('Desk');
    // tapped short, the dialog says what is missing
    await dlg.getByRole('button', { name: 'Add to crew' }).click();
    await expect(dlg.locator('#crw-err')).toHaveText('Choose a person.');
    // the picker: who is not on the crew yet, part-timers marked
    await expect(dlg.locator('#crw-who option')).toHaveText(['Choose a person', 'Omar Part · Part-timer', 'Lina Lead']);
    await dlg.locator('#crw-who').selectOption(OMAR);
    await dlg.getByRole('button', { name: 'Add to crew' }).click();
    await expect(dlg.locator('#crw-err')).toHaveText('Choose a role.');
    await expect(dlg.locator('.crw-new .inc-k')).toHaveText(['Desk', 'Bikes', 'Leader', 'Sweeper', 'Door']);
    await dlg.locator('#crw-k-sweeper').click();
    await dlg.getByRole('button', { name: 'Add to crew' }).click();
    await expect(dlg.locator('.crw-li')).toHaveCount(2);
    expect(sent.filter((x) => x.m === 'POST').map((x) => x.body)).toEqual([{ session_id: 's0', staff_user_id: OMAR, role: 'sweeper' }]); // the name and who added them are the database's
    await expect(dlg.locator('.crw-li').filter({ hasText: 'Omar Part' })).toContainText('Part-timer');
    await expect(chip).toHaveText(/Crew \(2\)/);
    await expect(dlg.locator('#crw-who option')).toHaveText(['Choose a person', 'Lina Lead']);
    // a new role is an update guarded on the role it had
    await dlg.getByLabel('Role of Sara Desk').selectOption('leader');
    await expect.poll(() => sent.filter((x) => x.m === 'PATCH').length).toBe(1);
    const pt = sent.find((x) => x.m === 'PATCH')!;
    expect(pt.body).toEqual({ role: 'leader' });
    expect(pt.url).toContain('id=eq.cr-1');
    expect(pt.url).toContain('role=eq.desk');
    await expect(dlg.locator('.ck-h').first()).toContainText('Leader');
    // remove
    await dlg.getByRole('button', { name: 'Remove · Omar Part' }).click();
    await expect(dlg.locator('.crw-li')).toHaveCount(1);
    expect(sent.filter((x) => x.m === 'DELETE').map((x) => x.url.match(/id=eq\.([^&]+)/)?.[1])).toEqual(['cr-11']);
    await expect(chip).toHaveText(/Crew \(1\)/);
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0);                // no bar after an action
    const log = await logLines(page);
    expect(log).toContain('Tonight\'s crew: Omar Part · Sweeper');
    expect(log).toContain('Tonight\'s crew: Sara Desk · Desk → Leader');
    expect(log).toContain('Tonight\'s crew: Remove · Omar Part');
  });

  test('another desk\'s change arrives on staff-ref, and the opening checklist\'s Crew set ticks itself once the night has a crew', async ({ page }) => {
    const rt = await boot(page);
    const held: Record<string, unknown>[] = [];
    await serveCrew(page, held);
    await toRoster(page);
    const chip = page.locator('#q-live-count .crw-chip');
    await expect(chip).toHaveText(/Crew$/);
    await page.evaluate(`_ckOpen('open','s0')`);
    const dlg = sheet(page);
    await expect(dlg.getByRole('checkbox', { name: 'Crew set' })).toHaveAttribute('aria-checked', 'false');
    await live(page);
    const lina = { id: 'cr-9', session_id: 's0', staff_user_id: LINA, name: 'Lina Lead', role: 'leader', created_by_name: 'Omar', created_at: NOW.toISOString() };
    held.push(lina);
    rt.broadcast('realtime:staff-ref', 'session_crew', { op: 'INSERT', row: lina, old: null });
    await expect(dlg.getByRole('checkbox', { name: 'Crew set' })).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.locator('.ck-li').filter({ hasText: 'Crew set' })).toContainText('1 on the crew');
    await expect(chip).toHaveText(/Crew \(1\)/);
    // the item's button opens the crew; the pop-up reads the night's crew again as it opens, and that answer lands before
    // another desk changes it (under load it could be served before the removal and arrive after it: 2026-11-18)
    const reread = page.waitForResponse((r) => r.url().includes('/rest/v1/session_crew') && r.request().method() === 'GET');
    await dlg.locator('.ck-li').filter({ hasText: 'Crew set' }).getByRole('button', { name: 'Tonight\'s crew' }).click();
    await reread;
    await expect(sheet(page)).toContainText('Lina Lead');
    // a removal on another desk takes it off again
    held.splice(0, 1);
    rt.broadcast('realtime:staff-ref', 'session_crew', { op: 'DELETE', row: null, old: { id: 'cr-9', session_id: 's0' } });
    await expect(chip).toHaveText(/Crew$/);
    await expect(sheet(page).locator('.crw-li')).toHaveCount(0);
  });

  test('before the database has the table, Crew says so and opens nothing', async ({ page }) => {
    await boot(page);
    await page.route(/\/rest\/v1\/session_crew/, (r: Route) => r.fulfill({ status: 404, headers: head, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table', details: null, hint: null }) }));
    await toRoster(page);
    await page.waitForFunction(`S._crw && S._crw.miss === true`);
    await page.locator('#q-live-count .crw-chip').click();
    await expect(page.locator('.toast').filter({ hasText: 'Waiting for the database update' }).first()).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    // the opening list's Crew set stays a tick staff make
    await page.evaluate(`_ckOpen('open','s0')`);
    await expect(sheet(page).getByRole('checkbox', { name: 'Crew set' })).toBeEnabled();
  });
});

// The part-timers' hours at a JCC close-out (pt-closeout.spec.ts), pre-filled from the night's crew.
const JCC = '2020-01-01';
const JOUD = 'aaaaaaaa-0000-0000-0000-000000000001', ANMAR = 'aaaaaaaa-0000-0000-0000-000000000002';
const jcc = { id: JCC, session_date: JCC, day: 'Wednesday', status: 'closed', capacity: 10, created_at: 1, bike_slots: JSON.stringify({ _time: '19:00 - 22:00', _total: 10 }) };
const jccRow = {
  id: 'j', session_id: JCC, session_day: 'Wednesday', session_date: JCC, queue_num: 1, name: 'R j', phone: '0550000001',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: true, price: 75, approval: 'approved',
  registered_at: '2020-01-01T10:00:00Z', checked_in_at: JCC + 'T19:10:00Z',
};

test.describe('@staff:bookings Tonight\'s crew at the close-out', () => {
  test('the crew\'s part-timers not logged yet come first with the night\'s hours, still editable', async ({ page }) => {
    await stubSupabase(page, {
      sessions: [jcc], bikes: [], queue_entries: [jccRow],
      part_timers: [{ user_id: JOUD, name: 'Joud Part', active: true }, { user_id: ANMAR, name: 'Anmar Part', active: true }],
      part_timer_kinds: [{ id: 1, name: 'Customers check-in', rate: 30, active: true }, { id: 2, name: 'Bikes handling', rate: 25, active: true }],
      // Anmar already has hours on this night: not pre-filled again
      part_timer_shifts: [{ id: 7, part_timer_id: ANMAR, work_date: JCC, session_id: JCC, kind_id: 2, hours: 4, rate: 25, amount: 100, note: '', payout_id: null }],
      session_crew: [
        { id: 'k1', session_id: JCC, staff_user_id: JOUD, name: 'Joud Part', role: 'bikes' },
        { id: 'k2', session_id: JCC, staff_user_id: ANMAR, name: 'Anmar Part', role: 'desk' },
        { id: 'k3', session_id: JCC, staff_user_id: SARA, name: 'Sara Desk', role: 'leader' }, // not a part-timer
      ],
    });
    await unlockStaff(page);
    const posts: unknown[] = [];
    page.on('request', (r: Request) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/part_timer_shifts')) posts.push(r.postDataJSON()); });
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`closeOutSession('${JCC}')`);
    await page.locator('#desk-sheet .ck-go').click();
    await page.locator('#confirm-modal .confirm-box button').filter({ hasText: /close out/i }).click();
    const dlg = page.locator('#ptc-modal .ptc-box');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.ptc-row')).toHaveCount(1);
    await expect(page.locator('#ptc-who-0')).toHaveValue(JOUD);
    await expect(page.locator('#ptc-h-0')).toHaveValue('3');                        // 19:00 - 22:00
    await page.locator('#ptc-h-0').fill('3.5');
    await page.locator('#ptc-kind-0').selectOption('2');
    await dlg.getByRole('button', { name: 'Save hours' }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toEqual([{ part_timer_id: JOUD, kind_id: 2, work_date: JCC, session_id: JCC, hours: 3.5, rate: 25, note: '' }]);
  });
});

test.describe('@staff:bookings Call for help', () => {
  test('another device\'s call: a centred pop-up and a bell line; On my way is said in this device\'s presence; the call ending takes it away', async ({ page }) => {
    const rt = await boot(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('dashboard')`);                              // any section
    await live(page);
    const call = { id: 'c1', at: NOW.toISOString(), where: 'bikes', note: 'Flat tyre at gate 2', name: 'Sara' };
    rt.presence({ 'dev-sara': { metas: [{ phx_ref: 'r1', n: 'Sara', b: null, help: call }] } });
    const pop = page.locator('#hlp-pop [role="alertdialog"]');
    await expect(pop).toBeVisible();
    await expect(pop.getByRole('heading')).toHaveText(/Sara needs help at Bikes/);
    await expect(pop).toContainText('Flat tyre at gate 2');
    await expect.poll(() => page.evaluate(`_ntItems().filter(i=>i.k==='help').map(i=>i.txt).join('|')`)).toBe('Sara needs help at Bikes · 20:00 · Flat tyre at gate 2');
    expect(await page.evaluate(`NT_KINDS.some(k=>k[0]==='help'&&k[2]==='queue')`)).toBe(true); // its Settings switch
    await pop.getByRole('button', { name: 'On my way' }).click();
    await expect(pop).toHaveCount(0);
    await expect.poll(() => rt.tracks.some((x) => x.coming === 'c1')).toBe(true);
    expect(await logLines(page)).toContain('On my way: Sara');
    // the caller's device leaves the channel: the call is over, and so is this device's On my way
    rt.diff({ joins: {}, leaves: { 'dev-sara': { metas: [{ phx_ref: 'r1', n: 'Sara', b: null, help: call }] } } });
    await expect.poll(() => { const l = rt.tracks[rt.tracks.length - 1]; return !!l && !('coming' in l); }).toBe(true);
    // a second call shows, and closes itself when its caller ends it; the bell keeps both for the day
    const c2 = { id: 'c2', at: NOW.toISOString(), where: 'lockers', note: '', name: 'Omar' };
    rt.presence({ 'dev-omar': { metas: [{ phx_ref: 'r2', n: 'Omar', b: null, help: c2 }] } });
    await expect(pop).toContainText('Omar needs help at Lockers');
    rt.presence({ 'dev-omar': { metas: [{ phx_ref: 'r3', n: 'Omar', b: null }] } });
    await expect(pop).toHaveCount(0);
    await expect.poll(() => page.evaluate(`_ntItems().filter(i=>i.k==='help').length`)).toBe(2);
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0);
  });

  test('the caller: Call for help in Bookings\' More asks where, goes out in presence, lists who is on the way, End call takes it back', async ({ page }) => {
    const rt = await boot(page);
    await toRoster(page);
    await live(page);
    await page.locator('#tab-queue .sh-more').first().click();
    await page.getByRole('menuitem', { name: /Call for help/ }).click();
    const dlg = sheet(page);
    await expect(dlg).toContainText('Call for help');
    await dlg.locator('#hlp-send').click();                                        // tapped short
    await expect(dlg.locator('#hlp-err')).toHaveText('Choose where.');
    await expect(dlg.getByRole('group').getByRole('button')).toHaveText(['Desk', 'Bikes', 'Lockers', 'Door', 'Other']);
    await dlg.getByRole('button', { name: 'Bikes' }).click();
    await dlg.getByLabel('Note').fill('Flat tyre');
    await dlg.locator('#hlp-send').click();
    await expect(dlg).toContainText('Calling for help at Bikes');
    await expect(dlg.locator('#hlp-coming')).toHaveText('No one yet');
    await expect.poll(() => rt.tracks.filter((x) => x.help).length).toBe(1);
    const h = rt.tracks.find((x) => x.help)!.help as Record<string, unknown>;
    expect(h.where).toBe('bikes');
    expect(h.note).toBe('Flat tyre');
    expect(typeof h.id).toBe('string');
    expect(await logLines(page)).toContain('Called for help: Bikes');
    // another device answers On my way
    rt.presence({ 'dev-omar': { metas: [{ phx_ref: 'r1', n: 'Omar', b: null, coming: h.id }] } });
    await expect(dlg.locator('#hlp-coming')).toHaveText('Omar');
    await expect(page.locator('#hlp-pop [role="alertdialog"]')).toHaveCount(0);   // the caller gets no pop-up of their own
    await dlg.getByRole('button', { name: 'End call' }).click();
    await expect(dlg).toHaveCount(0);
    await expect.poll(() => { const l = rt.tracks[rt.tracks.length - 1]; return !!l && !l.help; }).toBe(true);
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0);
  });

  test('the Door screen has its own Call for help', async ({ page }) => {
    await boot(page);
    await page.addInitScript(() => { localStorage.setItem('cq_role', 'door'); });
    await page.goto('/');
    await waitForSb(page);
    await expect(page.locator('#door-page h1')).toHaveText('Door check-in');
    await page.locator('#door-page .zg-help').click();
    await expect(sheet(page)).toContainText('Call for help');
    await expect(sheet(page).getByRole('button', { name: 'Door' })).toBeVisible();
  });
});
