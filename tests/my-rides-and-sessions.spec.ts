import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// My Rides, My Account and the session editor: the booking ticket, the account save, and what
// a session edit (and its Undo) writes.

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const dayOff = (n: number) => {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

const jcc = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, day: 'Sunday', session_date: date, capacity: 20, status: 'open', created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...over,
});
const booking = (over: Record<string, unknown> = {}) => ({
  id: 'b1', name: 'Spec Rider', customer_id: 'c1', session_id: 'x', session_day: 'Sunday', session_date: '2099-01-01',
  queue_num: 1, status: 'waiting', paid: false, price: 75, type_preference: 'Road', registered_at: '2099-01-01T10:00:00Z', ...over,
});

async function customer(page: Page, fixtures: Record<string, unknown>, cust: Record<string, unknown> = {}) {
  await stubSupabase(page, { bikes: [], 'rpc:customer_booking_update': true, 'rpc:community_member': true, ...fixtures });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', ...cust });
  await page.goto('/');
  await waitForSb(page);
}
async function staff(page: Page, fixtures: Record<string, unknown>) {
  await stubSupabase(page, { bikes: [], queue_entries: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0');
}
function writesTo(page: Page, table: string) {
  const w: { method: string; url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (['POST', 'PATCH', 'DELETE'].includes(r.method()) && r.url().includes(`/rest/v1/${table}`)) {
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* DELETE */ }
      w.push({ method: r.method(), url: decodeURIComponent(r.url()), body: Array.isArray(body) ? body[0] : body });
    }
  });
  return w;
}

// ── Book my usual ────────────────────────────────────────────────────────────
// It used to jump a returning rider straight to review, past the waiver, and the booking was
// stamped as waiver-accepted all the same. It also picked a night the Reserve list would not
// offer (a past one still 'open', the National Day ride) and the choice vanished at once.
test('Book my usual takes the rider through the waiver, on a night the circuit list offers', async ({ page }) => {
  const sessions = [
    jcc('past', dayOff(-3)),                                                         // never closed
    jcc('nd', dayOff(1), { ride_kind: 'snd96', paid_ride: true, open_to_all: true, bike_slots: '{"_time":"16:00 - 18:00","_total":20}' }),
    jcc('next', dayOff(2)),
  ];
  await customer(page, { sessions, queue_entries: [booking({ session_id: 'old', session_date: '2099-01-01', status: 'done', paid: true })] },
    { height: 175, type_preference: 'Road' });
  await page.evaluate(`S.selEvent='community';bookMyUsual()`);
  expect(await page.evaluate('[S.selSession,S.selEvent,S.regStep]')).toEqual(['next', 'jcc', 3]);
  await expect(page.locator('#reg-waiver .mm-waiver-agree')).toBeVisible();          // the review, with its waiver to tick (2026-10-10)
  await expect(page.locator('#tab-register .mm-reg-foot .btn-primary')).toBeDisabled();
});

// ── Undo of a date move ──────────────────────────────────────────────────────
const satRide = {
  id: '2099-02-06', day: 'Saturday', session_date: '2099-02-06', capacity: 25, status: 'open', created_at: '2099-01-01T00:00:00Z',
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 25, paid_ride: false,
  title: 'Dawn Ride', meet_url: 'https://maps.example.test/meet', breakfast_name: 'Corner Cafe', breakfast_url: 'https://maps.example.test/cafe',
  addons: '["gel"]', bike_slots: '{"_time":"06:00 - 06:30"}',
};
test('undoing a date move brings the ride back as it was, not as a bare circuit night', async ({ page }) => {
  await staff(page, { sessions: [satRide] });
  const sw = writesTo(page, 'sessions');
  await page.evaluate(`startEditSession('2099-02-06');S.editSessDate='2099-02-13';saveSessionEdit()`);
  await expect.poll(() => sw.filter((w) => w.method === 'DELETE').length).toBe(1);
  const moved = sw.find((w) => w.method === 'POST')!.body;
  expect(moved).toMatchObject({ id: '2099-02-13', event_kind: 'community', ride_kind: 'saturday', needs_approval: true, spots: 25, addons: '["gel"]' });

  await page.waitForFunction('S.editSessionId===null&&S.undoStack.length>0');   // saved, and its Undo is on the stack
  await page.evaluate('doUndo()');
  await expect.poll(() => sw.filter((w) => w.method === 'POST').length).toBe(2);
  const back = sw.filter((w) => w.method === 'POST')[1].body;
  expect(back).toMatchObject({
    id: '2099-02-06', session_date: '2099-02-06', day: 'Saturday', event_kind: 'community', ride_kind: 'saturday',
    needs_approval: true, hide_queue: true, spots: 25, title: 'Dawn Ride', meet_url: 'https://maps.example.test/meet',
    breakfast_name: 'Corner Cafe', addons: '["gel"]', paid_ride: false,
  });
});

test('undoing an ordinary edit puts back the name, spots and meeting point too', async ({ page }) => {
  await staff(page, { sessions: [satRide] });
  const sw = writesTo(page, 'sessions');
  await page.evaluate(`setStaffTab('sessions');startEditSession('2099-02-06')`);
  await page.fill('#es-spots', '40');
  await page.evaluate(`S.editSessMapUrl='https://maps.example.test/elsewhere';saveSessionEdit()`);
  await expect.poll(() => sw.some((w) => 'meet_url' in w.body)).toBe(true);
  await page.waitForFunction('S.editSessionId===null&&S.undoStack.length>0');   // saved, and its Undo is on the stack
  await page.evaluate('doUndo()');
  await expect.poll(() => sw.filter((w) => w.method === 'PATCH' && 'title' in w.body && w.body.spots === 25).length).toBe(1);
  const back = sw.filter((w) => w.method === 'PATCH' && w.body.spots === 25).pop()!.body;
  expect(back).toMatchObject({ spots: 25, capacity: 25, title: 'Dawn Ride', meet_url: 'https://maps.example.test/meet', addons: '["gel"]' });
});

// ── Petromin date move ───────────────────────────────────────────────────────
const pw = {
  id: '2099-02-04-pw', day: 'Wednesday', session_date: '2099-02-04', capacity: 20, status: 'open', created_at: 1,
  event_kind: 'community', ride_kind: 'petromin', needs_approval: false, hide_queue: false, paid_ride: true,
  bike_slots: '{"_time":"20:00 - 22:00","_total":20}',
};
test('moving a Petromin night takes its registrations along before the old row goes', async ({ page }) => {
  await staff(page, { sessions: [pw] });
  const rr = writesTo(page, 'rider_registrations');
  const sw = writesTo(page, 'sessions');
  await page.evaluate(`S.editSessionId='2099-02-04-pw';S.editSessDate='2099-02-11';S.editSessStatus='open';S.editSessMode='total';S.editSessTotal=20;saveSessionEdit()`);
  await expect.poll(() => sw.filter((w) => w.method === 'DELETE').length).toBe(1);
  expect(rr).toHaveLength(1);
  expect(rr[0].body).toEqual({ session_id: '2099-02-11-pw' });
  expect(rr[0].url).toContain('session_id=eq.2099-02-04-pw');
});

test('if the registrations cannot move, the old Petromin row is kept', async ({ page }) => {
  await stubSupabase(page, { sessions: [pw], bikes: [], queue_entries: [] }, { table: 'rider_registrations', methods: ['PATCH'] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0');
  const sw = writesTo(page, 'sessions');
  await page.evaluate(`S.editSessionId='2099-02-04-pw';S.editSessDate='2099-02-11';S.editSessStatus='open';S.editSessMode='total';S.editSessTotal=20;saveSessionEdit()`);
  await expect.poll(() => sw.filter((w) => w.method === 'POST').length).toBe(1);
  await page.waitForTimeout(400);
  expect(sw.filter((w) => w.method === 'DELETE')).toHaveLength(0);         // nothing nulled by the FK
});

// ── Spots do not leak between session edits ──────────────────────────────────
test('the spot cap shown is the session being edited, whatever was typed for another', async ({ page }) => {
  const other = { ...satRide, id: '2099-02-20', session_date: '2099-02-20', spots: 15, capacity: 15, title: null };
  await staff(page, { sessions: [satRide, other] });
  await page.evaluate(`setStaffTab('sessions');startEditSession('2099-02-06')`);
  await page.fill('#es-spots', '30');
  await page.evaluate(`S.editSessionId=null;renderSessions();startEditSession('2099-02-20')`);
  await expect(page.locator('#es-spots')).toHaveValue('15');
});

// ── Titles: a stock name is not saved ─────────────────────────────────────────
test('an edit keeps a typed ride name and stores no stock name, so each viewer reads their own', async ({ page }) => {
  const pool = { ...satRide, id: '2099-02-07', session_date: '2099-02-07', ride_kind: 'swim', title: 'Triathlon Pool Session', bike_slots: '{"_time":"18:00 - 19:30"}' };
  await staff(page, { sessions: [pool] });
  const sw = writesTo(page, 'sessions');
  await page.evaluate(`setStaffTab('sessions');startEditSession('2099-02-07')`);
  await expect(page.locator('#es-title')).toHaveValue('');                   // the stock name is only a placeholder
  await page.evaluate('saveSessionEdit()');
  await expect.poll(() => sw.some((w) => 'title' in w.body)).toBe(true);
  expect(sw.find((w) => 'title' in w.body)!.body.title).toBeNull();
  await page.waitForFunction('S.editSessionId===null');                     // the first save has finished
  await page.evaluate(`startEditSession('2099-02-07')`);
  await page.fill('#es-title', 'Sunrise Laps');
  await page.evaluate('saveSessionEdit()');
  await expect.poll(() => sw.filter((w) => 'title' in w.body).length).toBe(2);
  expect(sw.filter((w) => 'title' in w.body)[1].body.title).toBe('Sunrise Laps');
});

// ── Customer cancel returns the add-ons while the booking is still live ───────
test("a customer's last booking returns its add-ons around the cancel, and takes them again if the cancel fails", async ({ page }) => {
  const s = jcc('s1', dayOff(3));
  const calls: string[] = [];
  let refuseCancel = false;
  await customer(page, {
    sessions: [s], inventory: [{ id: 'gel', name: 'Gel', qty: 5, price: 10 }],
    queue_entries: [booking({ session_id: 's1', session_date: dayOff(3), addons: '[{"id":"gel","qty":2}]' })],
    'rpc:customer_addon_stock': true,
  });
  await page.route(/\/rest\/v1\/rpc\/customer_(addon_stock|booking_update)/, async (r) => {
    const b = r.request().postDataJSON();
    if (/addon_stock/.test(r.request().url())) { calls.push('stock:' + b.p_items.map((i: { delta: number }) => i.delta).join(',')); return r.fulfill({ status: 200, headers: head, body: 'true' }); }
    calls.push('cancel');
    return r.fulfill({ status: 200, headers: head, body: refuseCancel ? 'false' : 'true' });
  });
  await page.evaluate(`cancelBooking('b1','Change of plans')`);
  // The account's last live booking: stock goes back on both sides of the cancel. The RPC as it
  // stands answers only the first (the rider still has a live booking), the reworked one only
  // the second (the booking no longer holds its place); the stub says yes to both.
  await expect.poll(() => calls.join(' ')).toBe('stock:2 cancel stock:2');

  calls.length = 0;
  refuseCancel = true;
  await page.evaluate(`S.queue=[entryFromDB(${JSON.stringify(booking({ session_id: 's1', session_date: dayOff(3), addons: '[{"id":"gel","qty":2}]' }))})];cancelBooking('b1','Change of plans')`);
  await expect.poll(() => calls.join(' ')).toBe('stock:2 cancel stock:-2');  // refused: the add-ons are taken again
});

test('with another live booking on the account, the add-ons go back after the cancel only', async ({ page }) => {
  const s = jcc('s1', dayOff(3)), s2 = jcc('s2', dayOff(5));
  const calls: string[] = [];
  await customer(page, {
    sessions: [s, s2], inventory: [{ id: 'gel', name: 'Gel', qty: 5, price: 10 }],
    queue_entries: [booking({ session_id: 's1', session_date: dayOff(3), addons: '[{"id":"gel","qty":2}]' }),
      booking({ id: 'b2', session_id: 's2', session_date: dayOff(5), queue_num: 4 })],
  });
  await page.route(/\/rest\/v1\/rpc\/customer_(addon_stock|booking_update)/, async (r) => {
    const b = r.request().postDataJSON();
    calls.push(/addon_stock/.test(r.request().url()) ? 'stock:' + b.p_items.map((i: { delta: number }) => i.delta).join(',') : 'cancel');
    return r.fulfill({ status: 200, headers: head, body: 'true' });
  });
  await page.evaluate(`cancelBooking('b1','Change of plans')`);
  await expect.poll(() => calls.join(' ')).toBe('cancel stock:2');
});

// ── My Account saves over the account as it is now ───────────────────────────
test('My Account keeps staff corrections and the nationality on file for boxes the rider left alone', async ({ page }) => {
  const saves: Record<string, unknown>[] = [];
  let profileCalls = 0;
  await customer(page, { sessions: [], queue_entries: [] }, { name: 'Old Name', height: 170, country: 'Saudi Arabia', city: 'Jeddah' });
  await page.route(/\/rest\/v1\/rpc\/customer_profile/, async (r) => {
    profileCalls++;
    if (profileCalls === 1) return r.fulfill({ status: 500, headers: head, body: JSON.stringify({ code: 'XX000', message: 'down' }) });
    return r.fulfill({ status: 200, headers: head, body: JSON.stringify([{ id: 'c1', name: 'Fixed By Staff', email: 'spec@example.com', phone: '+966500000001', height: 170, country: 'Saudi Arabia', city: 'Jeddah', nationality: 'Egypt', socials: { instagram: 'rider.one' } }]) });
  });
  await page.route(/\/rest\/v1\/rpc\/customer_(update_profile|set_socials)/, async (r) => { saves.push({ url: r.request().url(), ...r.request().postDataJSON() }); await r.fulfill({ status: 200, headers: head, body: 'true' }); });
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-first')).toHaveValue('Old');              // the first read failed: the sign-in copy shows
  await page.fill('#acc-height', '181');                                      // the one thing the rider changes
  await page.evaluate('saveAccount()');
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ p_name: 'Fixed By Staff', p_height: 181, p_nationality: 'Egypt', p_country: 'Saudi Arabia' });
  expect(await page.evaluate('[S.loggedIn.name,S.loggedIn.nationality]')).toEqual(['Fixed By Staff', 'Egypt']);
});

test('My Account refuses to save when it cannot read the account first', async ({ page }) => {
  const saves: string[] = [];
  await customer(page, { sessions: [], queue_entries: [], 'rpc:customer_profile': { __rpcError: { status: 500, code: 'XX000', message: 'down' } } });
  page.on('request', (r) => { if (/rpc\/customer_update_profile/.test(r.url())) saves.push(r.url()); });
  await page.evaluate(`setCustTab('account')`);
  await page.fill('#acc-height', '181');
  await page.evaluate('saveAccount()');
  await expect(page.locator('#acc-err')).toHaveText(/Connection error/);
  expect(saves).toHaveLength(0);
});

// ── My Rides: past nights are not current, free rides count ───────────────────
test('a night that is over is not a current ride, and the account does not call it Today', async ({ page }) => {
  const sessions = [jcc('gone', dayOff(-2)), jcc('wl', dayOff(-1)), jcc('soon', dayOff(4))];
  await customer(page, { sessions, queue_entries: [
    booking({ id: 'q1', session_id: 'gone', session_date: dayOff(-2), status: 'waiting', queue_num: 3 }),
    booking({ id: 'q2', session_id: 'wl', session_date: dayOff(-1), status: 'waitlist', queue_num: 9, waitlist_num: 2 }),
    booking({ id: 'q3', session_id: 'soon', session_date: dayOff(4), status: 'waiting', queue_num: 4 }),
  ] });
  await page.evaluate(`setCustTab('myrides')`);
  await expect(page.locator('#tab-myrides .ticket-card')).toHaveCount(1);
  await expect(page.locator('#tab-myrides .ticket-card')).toContainText('#4');
  const dash = String(await page.evaluate('_seasonDashboard(S.loggedIn)'));
  expect(dash).not.toContain('>Today<');
});

const freeSat = { ...satRide, id: dayOff(-7), session_date: dayOff(-7), hide_queue: false, status: 'closed' };
test('a completed complimentary ride counts as a ride, though nothing was paid', async ({ page }) => {
  await customer(page, { sessions: [freeSat], queue_entries: [
    booking({ id: 'f1', session_id: freeSat.id, session_date: freeSat.session_date, status: 'done', paid: false, price: 0, approval: 'approved', checked_out_at: freeSat.session_date + 'T08:00:00Z' }),
  ] });
  await page.evaluate(`setCustTab('myrides')`);
  await expect(page.locator('#tab-myrides .ticket-card')).toHaveCount(1);
  expect(await page.evaluate(`getQueue().filter(_rideCompleted).length`)).toBe(1);
  expect(await page.evaluate(`_mrTier(getQueue().filter(e=>e.customerId==='c1'&&_rideCompleted(e)).length).next.need`)).toBe(2);
});

// ── Community ticket: no number, published or not ─────────────────────────────
test('a published community ticket still shows no queue number', async ({ page }) => {
  const pub = { ...satRide, id: '2099-03-06', session_date: '2099-03-06', hide_queue: false };
  await customer(page, { sessions: [pub], queue_entries: [booking({ session_id: pub.id, session_date: pub.session_date, queue_num: 7, approval: 'approved', price: 0 })] });
  await page.evaluate(`setCustTab('myrides')`);
  const card = page.locator('#tab-myrides .ticket-card');
  await expect(card).toHaveCount(1);
  expect(await card.innerText()).not.toContain('#7');
  await expect(card.locator('.appr-ok')).toBeVisible();                      // the verdict is still said, loudly
});

test('a booking on a session this device cannot see shows no queue number either', async ({ page }) => {
  // A private ride drops out of list_sessions once the member's tag lapses; my_bookings still has it.
  await customer(page, { sessions: [], queue_entries: [booking({ session_id: 'gated', session_date: '2099-03-13', queue_num: 8, approval: 'approved', price: 0 })] });
  await page.evaluate(`setCustTab('myrides')`);
  const card = page.locator('#tab-myrides .ticket-card');
  await expect(card).toHaveCount(1);
  expect(await card.innerText()).not.toContain('#8');
});

// ── Clone ────────────────────────────────────────────────────────────────────
test('a clone leaves retired bikes behind and keeps the bike collection time', async ({ page }) => {
  const old = jcc('2026-08-02', '2026-08-02', { status: 'closed', bike_slots: '{"_time":"21:00 - 23:00","_collect":"20:05","_bikes":["b1","b2","b3"]}' });
  await staff(page, { sessions: [old], bikes: [
    { id: 'b1', name: 'R-01', type: 'Road', size: 'M', status: 'retired' },
    { id: 'b2', name: 'R-02', type: 'Road', size: 'M', status: 'available' },
    { id: 'b3', name: 'H-01', type: 'Hybrid', size: 'L', status: 'maintenance' },
  ] });
  await page.evaluate(`setStaffTab('sessions');cloneSession('2026-08-02')`);
  expect(await page.evaluate('[S.newSessMode,S.newSessAssignedIds,S.newSessCollect]')).toEqual(['fleet', ['b2'], '20:05']);
});

// ── The N shortcut ───────────────────────────────────────────────────────────
test('N on All sessions opens tonight\'s next rider, not one left waiting on a past night', async ({ page }) => {
  await staff(page, { sessions: [jcc('old', dayOff(-9)), jcc('tonight', today)], queue_entries: [
    booking({ id: 'stale', session_id: 'old', session_date: dayOff(-9), queue_num: 1 }),
    booking({ id: 'now2', session_id: 'tonight', session_date: today, queue_num: 2 }),
    booking({ id: 'now1', session_id: 'tonight', session_date: today, queue_num: 1, status: 'active' }),
  ] });
  await page.evaluate(`window.__ci=null;showCheckinModal=id=>{window.__ci=id};S.sfSession='all';_kbCheckInNext()`);
  expect(await page.evaluate('window.__ci')).toBe('now2');
});

// ── You're next ──────────────────────────────────────────────────────────────
test("riders already on a bike are not ahead: the next waiting rider is told they are next", async ({ page }) => {
  const s = jcc('s1', dayOff(0));
  await customer(page, { sessions: [s], queue_entries: [
    booking({ id: 'o1', customer_id: 'c9', session_id: 's1', session_date: dayOff(0), queue_num: 1, status: 'active' }),
    booking({ id: 'o2', customer_id: 'c9', session_id: 's1', session_date: dayOff(0), queue_num: 2, status: 'active' }),
    booking({ id: 'me', session_id: 's1', session_date: dayOff(0), queue_num: 3 }),
  ] });
  await page.evaluate(`setCustTab('myrides')`);
  await expect(page.locator('#tab-myrides .ticket-card')).toContainText('You’re next');
});

// Said on the ride's day only (2026-09-30): "You're next" on a ride days away counted a queue nobody
// is standing in yet.
test("a ride on another day carries no queue cue", async ({ page }) => {
  const s = jcc('s1', dayOff(1));
  await customer(page, { sessions: [s], queue_entries: [booking({ id: 'me', session_id: 's1', session_date: dayOff(1), queue_num: 1 })] });
  await page.evaluate(`setCustTab('myrides')`);
  await expect(page.locator('#tab-myrides .ticket-card')).toHaveCount(1);
  await expect(page.locator('#tab-myrides .ticket-card')).not.toContainText('You’re next');
  await expect(page.locator('#tab-myrides .ticket-card')).not.toContainText('in the queue');
});

// ── Calendar file across midnight ─────────────────────────────────────────────
test('a window that runs past midnight ends on the next day in the calendar file', async ({ page }) => {
  await customer(page, { sessions: [jcc('late', '2099-04-10', { bike_slots: '{"_time":"22:30 - 00:30","_total":20}' })], queue_entries: [] });
  const ics = await page.evaluate(async () => {
    let blob: Blob | null = null;
    URL.createObjectURL = ((b: Blob) => { blob = b; return 'blob:x'; }) as typeof URL.createObjectURL;
    HTMLAnchorElement.prototype.click = () => {};
    // @ts-expect-error app global
    downloadBookingICS('late');
    return blob ? await (blob as Blob).text() : '';
  });
  // In UTC (KSA is UTC+3): 22:30 Jeddah is 19:30Z, and 00:30 the next morning is 21:30Z the same date.
  expect(ics).toContain('DTSTART:20990410T193000Z');
  expect(ics).toContain('DTEND:20990410T213000Z');
});

test.describe('a phone set to another zone', () => {
  test.use({ timezoneId: 'Europe/London' });
  test('the calendar times are Jeddah\'s whatever zone the phone is set to', async ({ page }) => {
    await customer(page, { sessions: [jcc('eve', '2099-04-10', { bike_slots: '{"_time":"21:00 - 23:00","_total":20}' })], queue_entries: [] });
    const ics = await page.evaluate(async () => {
      let blob: Blob | null = null;
      URL.createObjectURL = ((b: Blob) => { blob = b; return 'blob:x'; }) as typeof URL.createObjectURL;
      HTMLAnchorElement.prototype.click = () => {};
      // @ts-expect-error app global
      downloadBookingICS('eve');
      return blob ? await (blob as Blob).text() : '';
    });
    expect(ics).toContain('DTSTART:20990410T180000Z'); // 21:00 in Jeddah, not 21:00 in London
    expect(ics).toContain('DTEND:20990410T200000Z');
  });
});

// ── Session add-on Select all / Clear ─────────────────────────────────────────
test('Select all and Clear move only the listed add-ons, a sold-out offer stays', async ({ page }) => {
  await staff(page, { sessions: [jcc('s1', '2099-05-01')], inventory: [
    { id: 'a1', name: 'Gel', qty: 5, price: 10 }, { id: 'a2', name: 'Bar', qty: 3, price: 8 }, { id: 'out', name: 'Drink', qty: 0, price: 6 },
  ] });
  await page.evaluate(`setStaffTab('sessions');S.editSessAddons=['out','a1'];_sessAddonSelectAll('edit')`);
  expect((await page.evaluate('S.editSessAddons') as string[]).sort()).toEqual(['a1', 'a2', 'out']);
  await page.evaluate(`_sessAddonSelectAll('edit')`);
  expect(await page.evaluate('S.editSessAddons')).toEqual(['out']);
});

// ── Promo bound to one customer ───────────────────────────────────────────────
test('a promo code for one customer binds to the account picked, never to a namesake', async ({ page }) => {
  const customers = [
    { id: 'c1', name: 'Ali Hassan', phone: '+966500000001', email: 'a1@example.test' },
    { id: 'c2', name: 'Ali Hassan', phone: '+966500000002', email: 'a2@example.test' },
  ];
  await stubSupabase(page, { sessions: [jcc('s1', '2099-05-01')], bikes: [], queue_entries: [], customers, promo_codes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===2');
  const pw = writesTo(page, 'promo_codes');
  await page.evaluate(`S._pcCode='ALI10';S._pcValue='10';S._pcCust='Ali Hassan';addPromo()`);
  await page.waitForTimeout(300);
  expect(pw).toHaveLength(0);                                                 // ambiguous: nothing written
  await page.evaluate(`S._pcCode='ALI10';S._pcValue='10';S._pcCust='Ali Hassan · +966500000002';addPromo()`);
  await expect.poll(() => pw.length).toBe(1);
  expect(pw[0].body.customer_id).toBe('c2');
});
