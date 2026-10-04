import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Review fixes of 2026-10-04 (sessions, booking editor, walk-in, forced password, application
// messages): an event is edited by its seats and keeps its shape; a booking move that is refused
// puts a checked-in rider back on the bike, and a taken number is retried; the walk-in offers Road
// Carbon only where the ride has it; the booking editor greys out the nights the save would refuse;
// a failed temporary-password check is asked again; the application message's WhatsApp link has the
// country code.

const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
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
    if (['POST', 'PATCH'].includes(r.method()) && r.url().includes(`/rest/v1/${table}`)) {
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      w.push({ method: r.method(), url: r.url(), body });
    }
  });
  return w;
}

// ── An event is edited by its seats ───────────────────────────────────────────
const event = (over: Record<string, unknown> = {}) => ({
  id: '2099-03-05-ev', day: 'Thursday', session_date: '2099-03-05', capacity: 30, spots: 30, status: 'open', created_at: 1,
  bike_slots: '{"_time":"19:00 - 21:00"}', event_kind: 'community', ride_kind: 'event', needs_approval: false,
  hide_queue: true, paid_ride: false, price: 0, open_to_all: true, ...over,
});
for (const paid of [false, true]) {
  test(`editing a ${paid ? 'paid' : 'free'} event asks for its seats and keeps it first come, first seated`, async ({ page }) => {
    await staff(page, { sessions: [event(paid ? { paid_ride: true, price: 120 } : {})] });
    const sw = writesTo(page, 'sessions');
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-03-05-ev')`);
    await expect(page.locator('#es-spots')).toHaveValue('30');             // seats, not "add bikes"
    await expect(page.locator('.ss-modes')).toHaveCount(0);
    await page.fill('#es-spots', '45');
    await page.evaluate('saveSessionEdit()');
    await page.waitForFunction('S.editSessionId===null');
    await expect.poll(() => sw.some((w) => 'needs_approval' in w.body)).toBe(true);
    expect(sw.find((w) => 'needs_approval' in w.body)!.body).toMatchObject({ needs_approval: false, hide_queue: true, spots: 45 });
    expect(sw.find((w) => 'capacity' in w.body)!.body).toMatchObject({ capacity: 45 });
    expect(sw.find((w) => 'paid_ride' in w.body)!.body).toMatchObject({ ride_kind: 'event', paid_ride: paid });
  });
}

// ── A refused move puts the rider back on the bike; a taken number is tried again ──────────
const D0 = '2099-02-08', D1 = '2099-02-15';
const sess = (id: string, date: string, cap = 9) => ({
  id, day: 'Sunday', session_date: date, capacity: cap, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: cap }), location: 'JCC', addons: null,
});
const rider = (id: string, qn: number, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Sunday', session_date: D0, queue_num: qn, name: `Rider ${id}`,
  type_preference: 'Hybrid', size: 'M', status, paid: true, price: 30, registered_at: '2099-01-01T10:00:00Z', ...extra,
});
async function moveBoot(page: Page, failMove: 'unique' | 'denied') {
  const q = [rider('mover', 1, 'active', { assigned_bike_id: 'b1', checked_in_at: '2099-02-08T18:00:00Z' })];
  await stubSupabase(page, { sessions: [sess('s0', D0), sess('s1', D1)], queue_entries: q,
    bikes: [{ id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'in-use', rental_price: 57.5 }] });
  let refused = 0;
  await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
    const r = route.request();
    if (r.method() === 'PATCH') {
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      if (body.session_id === 's1' && (failMove === 'denied' || refused === 0)) {
        refused++;
        return route.fulfill(failMove === 'unique'
          ? { status: 409, headers: head, body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint' }) }
          : { status: 403, headers: head, body: JSON.stringify({ code: '42501', message: 'permission denied' }) });
      }
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      const row = q.find((x) => x.id === id);
      if (row) Object.assign(row, body);
    }
    return route.fallback();
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
}

test('a move refused for a taken number is tried again with a fresh one', async ({ page }) => {
  await moveBoot(page, 'unique');
  const qw = writesTo(page, 'queue_entries');
  await page.evaluate(`showBookingEditModal('mover')`);
  await page.evaluate(`document.getElementById('be-sess').value='s1';saveBookingEdit()`);
  await expect.poll(() => qw.filter((w) => w.body.session_id === 's1').length).toBe(2);
  await expect(page.locator('#booking-edit-modal [role="dialog"]')).toHaveCount(0); // saved: the editor closed
});

test('a move the database refuses puts the checked-in rider back on their bike', async ({ page }) => {
  await moveBoot(page, 'denied');
  const qw = writesTo(page, 'queue_entries');
  await page.evaluate(`showBookingEditModal('mover')`);
  await page.evaluate(`document.getElementById('be-sess').value='s1';saveBookingEdit()`);
  await expect.poll(() => qw.some((w) => w.body.status === 'active' && w.body.assigned_bike_id === 'b1')).toBe(true);
  await expect.poll(() => qw.some((w) => w.body.checked_in_at === '2099-02-08T18:00:00Z')).toBe(true); // the check-in time comes back too
});

test('the booking editor greys out a night the save would call full (finished riders still hold their place)', async ({ page }) => {
  const done = Array.from({ length: 2 }, (_, i) => rider(`d${i}`, i + 2, 'done', { session_id: 's1', session_date: D1 }));
  await staff(page, { sessions: [sess('s0', D0), { ...sess('s1', D1, 2), session_date: '2999-01-01' }],
    queue_entries: [rider('w1', 1, 'waiting'), ...done] });
  await page.evaluate(`showBookingEditModal('w1')`);
  await expect(page.locator('#be-sess option[value="s1"]')).toBeDisabled();
});

// ── Walk-in: no Road Carbon where the ride has none ─────────────────────────────
test('the walk-in offers no Road Carbon on a Saturday ride, and a carried-over pick books as Any', async ({ page }) => {
  const sat = { id: '2099-02-07', day: 'Saturday', session_date: '2099-02-07', capacity: 20, spots: 20, status: 'open', created_at: 1,
    bike_slots: '{"_time":"06:00 - 08:00"}', event_kind: 'community', ride_kind: 'saturday', needs_approval: true };
  await staff(page, { sessions: [sat] });
  const posted: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /queue_entries/.test(r.url())) { const b = JSON.parse(r.postData() || '[]'); posted.push(...(Array.isArray(b) ? b : [b])); } });
  await page.evaluate(`S._wiType='Road Carbon';setStaffTab('queue');showWalkinModal()`);
  await expect(page.locator('#walkin-modal [data-wi-type="Road Carbon"]')).toHaveCount(0);
  expect(await page.evaluate('S._wiType')).toBe('Any');
  await page.evaluate(`_wiInsertRiders('2099-02-07',[{name:'Carbon Fan',height:180,type:'Road Carbon'}],'',null)`);
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toMatchObject({ name: 'Carbon Fan', type_preference: 'Any' });
});

// ── Forced password: a failed check is asked again ─────────────────────────────
test('a temporary-password check that fails is asked again, and the gate shows once it answers', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [] });
  let calls = 0;
  await page.route(/rpc\/customer_pwd_state/, (r) => {
    calls++;
    return calls === 1
      ? r.fulfill({ status: 503, headers: head, body: JSON.stringify({ message: 'upstream unavailable' }) })
      : r.fulfill({ status: 200, headers: head, body: 'true' });
  });
  await loginCustomer(page, { id: 'tp1', session_token: 'tok-temp' });
  await page.goto('/');
  await waitForSb(page);
  await expect.poll(() => calls).toBeGreaterThan(0);
  await expect(page.locator('#pwd-gate')).toHaveCount(0);
  await page.evaluate(`_pwdMustCheck(S.loggedIn||getSession())`);
  await expect(page.locator('#pwd-gate .pg-box')).toBeVisible();
});

// ── The application message's WhatsApp link ─────────────────────────────────────
test('a local 05 number gets its country code in the message dialog WhatsApp link', async ({ page }) => {
  await staff(page, { sessions: [sess('s0', D0)] });
  await page.evaluate(`_tpMsgOpen('Karim Mansour','karim@example.test','0552468013','Kp7wXr4Mnq')`);
  const href = await page.locator('#confirm-modal a.ca-wa').getAttribute('href');
  expect(href).toMatch(/^https:\/\/wa\.me\/966552468013\?text=/);
});
