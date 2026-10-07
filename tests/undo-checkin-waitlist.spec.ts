import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Undo check-in puts a rider who came off the waitlist back onto it (the owner, 2026-10-07: "back to
// waitlist" - put back as waiting they held a place, and could over-fill a full night). The write sends
// status 'waitlist' with the W number the row kept through the check-in (the queue number stays), the
// add-ons' stock taken at the check-in comes back, and the Staff List row the check-in spent is on the
// list again. A rider who was waiting before the check-in goes back to waiting, as before. Every path
// that undoes a check-in: the row's Undo check-in (after a check-in in the modal), the party menu, the
// Undo of a bulk check-in, of the bike picker, of Express, and a Petromin registration's.

type Row = Record<string, unknown>;
type Hit = { table: string; url: string; body: Row; matched: string[] };

function matches(row: Row, params: URLSearchParams) {
  for (const [k, v] of params) {
    const m = v.match(/^(eq|neq|in|is)\.(.*)$/);
    if (!m || ['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const val = row[k];
    const s = val == null ? 'null' : String(val);
    if (m[1] === 'eq' && s !== m[2]) return false;
    if (m[1] === 'neq' && s === m[2]) return false;
    if (m[1] === 'is' && !(m[2] === 'null' ? val == null : s === m[2])) return false;
    if (m[1] === 'in' && !m[2].replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')).includes(s)) return false;
  }
  return true;
}

/** The tables the desk writes, held in memory: a GET answers them as they now are, a PATCH changes
 *  the rows its filters match and answers with exactly those, and staff_checkin checks a waiting or
 *  waitlisted booking in as the database does (the W number and the queue number stay as they are). */
async function stateful(page: Page, t: Record<string, Row[]>) {
  const hits: Hit[] = [];
  const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  await page.route(/\/rest\/v1\/(queue_entries|bikes|desk_waitlist|inventory)(\?|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const table = url.pathname.split('/').pop() as string;
    const rows = t[table];
    if (!rows || req.method() === 'OPTIONS') return route.fallback();
    if (req.method() === 'GET' || req.method() === 'HEAD') {
      return route.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${rows.length}/${rows.length}` }, body: JSON.stringify(rows) });
    }
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Row;
      const hit = rows.filter((r) => matches(r, url.searchParams));
      hit.forEach((r) => Object.assign(r, body));
      hits.push({ table, url: decodeURIComponent(req.url()), body, matched: hit.map((r) => String(r.id)) });
      return route.fulfill({ status: 200, headers: head, body: JSON.stringify(hit) });
    }
    return route.fallback();
  });
  await page.route(/\/rest\/v1\/rpc\/staff_checkin/, async (route) => {
    const b = route.request().postDataJSON() as { p_booking_id: string; p_bike_id?: string | null; p_price?: number | null };
    const r = t.queue_entries.find((x) => x.id === b.p_booking_id);
    if (!r || (r.status !== 'waiting' && r.status !== 'waitlist')) {
      return route.fulfill({ status: 200, headers: head, body: JSON.stringify({ ok: true, noop: true }) });
    }
    const bikes = b.p_bike_id ? [b.p_bike_id] : [];
    Object.assign(r, { status: 'active', assigned_bike_id: b.p_bike_id || null, checked_in_at: '2099-03-03T18:00:00.000Z' }, b.p_price != null ? { price: b.p_price } : {});
    bikes.forEach((id) => { const k = t.bikes.find((x) => x.id === id); if (k) k.status = 'in-use'; });
    return route.fulfill({ status: 200, headers: head, body: JSON.stringify({ ok: true, noop: false, assignment_id: 'a1', bikes, reservation_dropped: false }) });
  });
  return hits;
}
/** The add-on stock levels the desk wrote and the database took, in order. */
const stock = (hits: Hit[]) => hits.filter((h) => h.table === 'inventory' && h.matched.length).map((h) => h.body.qty);
/** The reads of the database's record of a row (audit_log), as their addresses. */
function auditReads(page: Page) {
  const out: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/audit_log')) out.push(decodeURIComponent(r.url())); });
  return out;
}

const SID = '2099-03-03';
const sessions = [{ id: SID, session_date: SID, day: 'Tuesday', status: 'open', capacity: 1, created_at: 1 }];
const row = (id: string, qn: number, status: string, x: Row = {}): Row => ({
  id, session_id: SID, session_day: 'Tuesday', session_date: SID, queue_num: qn, name: 'R ' + id, phone: '',
  type_preference: 'Road', size: 'M', status, paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z', ...x,
});
const gel = (qty: number) => JSON.stringify([{ id: 'gel', qty }]);
const mw = (id: string, booking: string): Row => ({
  id, name: 'R ' + booking, phone: '', bike_type: 'Road', status: 'waiting', paid: false, kind: 'managed', sort_order: 1,
  booking_id: booking, created_at: '2099-01-01T10:00:00Z', resolved_at: null,
});
const bike = (id: string, status: string): Row => ({ id, name: 'Bike ' + id, type: 'Road', size: 'M', status, colors: [], color_names: [] });
const tables = (queue_entries: Row[], desk_waitlist: Row[] = [], bikes: Row[] = []) => ({
  queue_entries, desk_waitlist, bikes, inventory: [{ id: 'gel', name: 'Gel', category: 'EnergyGels', qty: 5, price: 8, low_threshold: 1 }],
});

async function boot(page: Page, t: Record<string, Row[]>, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, ...fx });
  const hits = await stateful(page, t);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  return hits;
}
const qPatch = (hits: Hit[], id: string, status: string) =>
  hits.filter((h) => h.table === 'queue_entries' && h.url.includes(`id=eq.${id}`) && h.body.status === status).pop();

test.describe('@staff:bookings undo check-in, back to the waitlist', () => {
  test('a rider checked in off the waitlist goes back onto it: W number, add-ons and Staff List row, and its redo', async ({ page }) => {
    const t = tables([row('A', 1, 'waiting'), row('W1', 2, 'waitlist', { waitlist_num: 1, addons: gel(2) })], [mw('mw1', 'W1')]);
    const hits = await boot(page, t);
    const W1 = t.queue_entries[1];
    await page.evaluate(`(async()=>{S._ciId='W1';S._ciType='Road';S._ciPaid='pending';await confirmCheckinModal();})()`);
    await expect.poll(() => W1.status).toBe('active');
    await expect.poll(() => stock(hits)).toEqual([3]);                  // leaving the waitlist takes the stock
    await expect.poll(() => t.desk_waitlist[0].status).toBe('done');    // and spends the Staff List row

    await page.evaluate(`doUndoCheckin('W1')`);
    const undo = qPatch(hits, 'W1', 'waitlist')!;
    expect(undo.body).toEqual({ status: 'waitlist', assigned_bike_id: null, waitlist_num: 1 }); // the W number it kept
    expect(undo.url).toContain('status=eq.active');                     // guarded on still being on a bike
    expect(W1).toMatchObject({ status: 'waitlist', waitlist_num: 1, queue_num: 2, checked_in_at: null });
    expect(stock(hits)).toEqual([3, 5]);                                // given back
    expect(t.desk_waitlist[0]).toMatchObject({ status: 'waiting', resolved_at: null }); // on the Staff List again
    expect(await page.evaluate(`getQueue().find(x=>x.id==='W1').status`)).toBe('waitlist');
    expect(t.queue_entries[0].status).toBe('waiting');                  // nobody else moved

    // The Undo of the undo checks them in again, off the waitlist as before.
    await page.evaluate('S.undoStack[S.undoStack.length-1].fn()');
    expect(qPatch(hits, 'W1', 'active')!.url).toContain('status=eq.waitlist');
    expect(W1.status).toBe('active');
    expect(W1.checked_in_at).toBe('2099-03-03T18:00:00.000Z');
    expect(stock(hits)).toEqual([3, 5, 3]);
    expect(t.desk_waitlist[0].status).toBe('done');
  });

  test('a rider who was waiting before the check-in goes back to waiting, exactly as before', async ({ page }) => {
    const t = tables([row('A', 1, 'waiting', { addons: gel(1) }), row('W1', 2, 'waitlist', { waitlist_num: 1 })], [mw('mwA', 'A')]);
    const hits = await boot(page, t);
    const audit = auditReads(page);
    await page.evaluate(`(async()=>{S._ciId='A';S._ciType='Road';S._ciPaid='pending';await confirmCheckinModal();})()`);
    await expect.poll(() => t.queue_entries[0].status).toBe('active');
    await expect.poll(() => t.desk_waitlist[0].status).toBe('done');
    await page.evaluate(`doUndoCheckin('A')`);
    const undo = qPatch(hits, 'A', 'waiting')!;
    expect(undo.body).toEqual({ status: 'waiting', assigned_bike_id: null });
    expect(undo.url).toContain('status=eq.active');
    expect(t.queue_entries.map((r) => r.status)).toEqual(['waiting', 'waitlist']);
    expect(stock(hits)).toEqual([]);                                    // a waiting booking keeps what it took when booked
    expect(t.desk_waitlist[0].status).toBe('done');                     // the Staff List row stays spent, as it did
    expect(audit).toHaveLength(0);                                      // never on the waitlist: nothing to look up
    await page.evaluate('S.undoStack[S.undoStack.length-1].fn()');
    expect(qPatch(hits, 'A', 'active')!.url).toContain('status=eq.waiting');
  });

  test('the Undo of a bulk check-in: the waitlisted rider back onto the waitlist, the waiting one back to waiting', async ({ page }) => {
    const t = tables([row('A', 1, 'waiting'), row('W1', 2, 'waitlist', { waitlist_num: 1, addons: gel(2) })]);
    const hits = await boot(page, t);
    await page.evaluate(`(async()=>{S.sfSelected=['A','W1'];await bulkSfCheckin();})()`);
    await expect.poll(() => t.queue_entries.map((r) => r.status)).toEqual(['active', 'active']);
    await expect.poll(() => stock(hits)).toEqual([3]);
    await page.evaluate('S.undoStack[S.undoStack.length-1].fn()');
    expect(qPatch(hits, 'A', 'waiting')!.body).toEqual({ status: 'waiting', assigned_bike_id: null });
    expect(qPatch(hits, 'W1', 'waitlist')!.body).toEqual({ status: 'waitlist', assigned_bike_id: null, waitlist_num: 1 });
    expect(t.queue_entries.map((r) => r.status)).toEqual(['waiting', 'waitlist']);
    expect(stock(hits)).toEqual([3, 5]);
  });

  test('the party menu asks the database who came off the waitlist (checked in on another desk)', async ({ page }) => {
    const p = { customer_id: 'cp', checked_in_at: '2099-03-03T18:00:00.000Z' };
    const t = tables([row('X', 1, 'active', { ...p, waitlist_num: 2 }), row('Y', 2, 'active', { ...p, waitlist_num: 3 }), row('Z', 3, 'active', p)]);
    // what select=row_id,changed->status answers, newest first
    const audit_log = [
      { row_id: 'X', status: { old: 'done', new: 'active' } },           // a re-open since: not a check-in
      { row_id: 'X', status: { old: 'waitlist', new: 'active' } },
      { row_id: 'Y', status: { old: 'waiting', new: 'active' } },        // waitlisted once, promoted, then checked in
    ];
    await boot(page, t, { audit_log });
    const audit = auditReads(page);
    await page.evaluate(`confirmPartyUndoCheckin(['X','Y','Z'])`);
    await page.locator('#confirm-modal button', { hasText: 'Undo Check-in' }).click();
    await expect.poll(() => t.queue_entries.map((r) => r.status)).toEqual(['waitlist', 'waiting', 'waiting']);
    expect(t.queue_entries[0].waitlist_num).toBe(2);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('row_id=in.(X,Y)');                      // Z has no W number: not asked about
    expect(audit[0]).toContain('select=row_id,changed->status');
    expect(audit[0]).toContain('changed->status->>new=eq.active');
  });

  test('a bike handed straight off the waitlist: its Undo puts the rider back onto it and the bike back on the rack', async ({ page }) => {
    const t = tables([row('A', 1, 'waiting'), row('W1', 2, 'waitlist', { waitlist_num: 1 })], [], [bike('b1', 'available')]);
    const hits = await boot(page, t);
    await page.evaluate(`(async()=>{openModal('W1');S.modalBikes=['b1'];await confirmAssign();})()`);
    await expect.poll(() => t.queue_entries[1].status).toBe('active');
    expect(t.bikes[0].status).toBe('in-use');
    await page.evaluate('S.undoStack[S.undoStack.length-1].fn()');
    const undo = qPatch(hits, 'W1', 'waitlist')!;
    expect(undo.body).toMatchObject({ status: 'waitlist', assigned_bike_id: null, waitlist_num: 1 });
    expect(undo.url).toContain('assigned_bike_id=eq.b1');
    expect(t.queue_entries[1].status).toBe('waitlist');
    expect(t.bikes[0].status).toBe('available');
  });

  test('Express: its Undo puts a rider who came off the waitlist back onto it', async ({ page }) => {
    const t = tables([row('A', 1, 'waiting'), row('W1', 2, 'waitlist', { waitlist_num: 1, paid: true })]);
    const hits = await boot(page, t);
    await page.evaluate(`_expressCheckin(getQueue().find(x=>x.id==='W1'),()=>{})`);
    await expect.poll(() => t.queue_entries[1].status).toBe('active');
    await page.evaluate('S.undoStack[S.undoStack.length-1].fn()');
    expect(qPatch(hits, 'W1', 'waitlist')!.body).toEqual({ status: 'waitlist', assigned_bike_id: null, waitlist_num: 1 });
    expect(t.queue_entries[1].status).toBe('waitlist');
  });

  test('a Petromin registration: Undo check-in puts a booking that came off the waitlist back onto it', async ({ page }) => {
    const PW = '2099-03-04-pw';
    const pw = { id: PW, day: 'Wednesday', session_date: '2099-03-04', capacity: 1, status: 'open', created_at: 2, event_kind: 'community',
      ride_kind: 'petromin', paid_ride: true, bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 1 }) };
    const on = { session_id: PW, session_day: 'Wednesday', session_date: '2099-03-04', price: 50 };
    const t = tables([row('P1', 1, 'waiting', on), row('P2', 2, 'waitlist', { ...on, waitlist_num: 1 })]);
    const reg = { id: 1, source: 'petromin', session_id: PW, booking_no: 'P-002', party_no: 1, badge: 'B-2', name: 'R P2', phone: '+966500000011',
      company: 'Petromin', height: 175, type_preference: 'Road', matched_entry_id: 'P2', matched_customer_id: null, match_kind: 'booking',
      submissions: 1, price: null, checked_in_at: null, checked_in_by: null, checked_out_at: null, checked_out_by: null,
      created_at: '2099-03-03T09:00:00Z', updated_at: '2099-03-03T09:00:00Z' };
    const hits = await boot(page, t, { sessions: [...sessions, pw], rider_registrations: [reg] });
    await page.evaluate(`(async()=>{S._staffAuthed=true;await loadData();await loadRiders();})()`);
    await page.evaluate(`riderCheckin(1)`);
    await expect.poll(() => t.queue_entries[1].status).toBe('active');
    await page.evaluate(`riderUndoCheckin(1)`);
    await expect.poll(() => t.queue_entries[1].status).toBe('waitlist');
    expect(qPatch(hits, 'P2', 'waitlist')!.body).toEqual({ status: 'waitlist', assigned_bike_id: null, waitlist_num: 1 });
    expect(t.queue_entries[0].status).toBe('waiting');
  });
});
