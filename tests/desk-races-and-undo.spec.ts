import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The queue's desk actions (cancel, no-show, re-open, close-out, cancel-night) and their undos,
// against a stub that keeps state and honours PostgREST's eq./in. filters, so a guarded write
// that matches nothing really comes back empty - the shape of "another desk got there first".

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

/** queue_entries and bikes held in memory: GET returns them, PATCH applies to the rows its filters
 *  match and answers with exactly those rows. `refuse` answers a PATCH with an RLS error. */
async function statefulTables(page: Page, tables: Record<string, Row[]>, refuse?: (table: string, body: Row) => boolean) {
  const hits: Hit[] = [];
  const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  await page.route(/\/rest\/v1\/(queue_entries|bikes)(\?|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const table = url.pathname.split('/').pop() as string;
    const rows = tables[table];
    if (!rows || req.method() === 'OPTIONS') return route.fallback();
    if (req.method() === 'GET' || req.method() === 'HEAD') {
      return route.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${rows.length}/${rows.length}` }, body: JSON.stringify(rows) });
    }
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Row;
      if (refuse && refuse(table, body)) {
        return route.fulfill({ status: 403, headers: head, body: JSON.stringify({ code: '42501', message: 'new row violates row-level security policy' }) });
      }
      const hit = rows.filter((r) => matches(r, url.searchParams));
      hit.forEach((r) => Object.assign(r, body));
      hits.push({ table, url: decodeURIComponent(req.url()), body, matched: hit.map((r) => String(r.id)) });
      return route.fulfill({ status: 200, headers: head, body: JSON.stringify(hit) });
    }
    return route.fallback();
  });
  return hits;
}

function inventoryWrites(page: Page) {
  const out: Row[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/inventory')) out.push(r.postDataJSON()); });
  return out;
}

const SID = '2099-03-03';
const sessions = [{ id: SID, session_date: SID, day: 'Tuesday', status: 'open', capacity: 2, created_at: 1 }];
const inventory = [{ id: 'gel', name: 'Gel', category: 'EnergyGels', qty: 5, price: 8, low_threshold: 1 }];
let n = 0;
const row = (id: string, status: string, x: Row = {}): Row => ({
  id, session_id: SID, session_day: 'Tuesday', session_date: SID, queue_num: ++n, name: 'R ' + id, phone: '',
  type_preference: 'Road', size: 'M', status, paid: false, price: 75, registered_at: `2099-01-01T10:0${n % 10}:00Z`, ...x,
});
const bike = (id: string, status: string): Row => ({ id, name: 'Bike ' + id, type: 'Road', size: 'M', status, colors: [], color_names: [] });

async function boot(page: Page, q: Row[], bikes: Row[] = [], refuse?: (table: string, body: Row) => boolean) {
  await stubSupabase(page, { sessions, inventory, 'rpc:staff_return': { ok: true, noop: false, bikes_freed: 1 } });
  const hits = await statefulTables(page, { queue_entries: q, bikes }, refuse);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  return hits;
}
// The undo is pushed at the very end of an action, after its last reload: wait for it rather than
// for the last write the action made.
const undoTop = async (page: Page) => {
  await page.waitForFunction('S.undoStack.length>0');
  return page.evaluate('S.undoStack[S.undoStack.length-1].fn()');
};

test('a refused cancel of a rider on a bike frees nothing, promotes nobody and offers no undo', async ({ page }) => {
  const q = [row('A', 'active', { assigned_bike_id: 'b1', addons: JSON.stringify([{ id: 'gel', qty: 1 }]) }), row('W', 'waitlist', { waitlist_num: 1 })];
  const bikes = [bike('b1', 'in-use')];
  const hits = await boot(page, q, bikes, (t, b) => t === 'queue_entries' && b.status === 'cancelled');
  const inv = inventoryWrites(page);
  await page.evaluate(`_staffCancelNow('A')`);
  await page.waitForTimeout(300);
  expect(bikes[0].status).toBe('in-use');                       // the rider is still on it
  expect(q[1].status).toBe('waitlist');                         // nobody promoted into a place still held
  expect(hits.filter((h) => h.table === 'bikes')).toHaveLength(0);
  expect(inv).toHaveLength(0);                                  // the add-ons are still out with the rider
  expect(await page.evaluate('S.undoStack.length')).toBe(0);
});

test('a no-show from the waitlist promotes nobody, restocks nothing, and its undo keeps them waitlisted', async ({ page }) => {
  const q = [row('A', 'waiting'), row('B', 'waiting'), row('W1', 'waitlist', { waitlist_num: 1, addons: JSON.stringify([{ id: 'gel', qty: 2 }]) }), row('W2', 'waitlist', { waitlist_num: 2 })];
  await boot(page, q);
  const inv = inventoryWrites(page);
  await page.evaluate(`doNoShow('W1')`);
  await page.waitForTimeout(200);
  expect(q[2].status).toBe('noshow');
  expect(q[3].status).toBe('waitlist');                         // W2 did not jump into a place nobody gave up
  expect(inv).toHaveLength(0);                                  // W1 never held add-on stock
  await undoTop(page);
  expect(q[2].status).toBe('waitlist');                         // back to what they were, not confirmed
  expect(inv).toHaveLength(0);
});

test('a waiting rider\'s no-show still hands the place to W1', async ({ page }) => {
  const q = [row('A', 'waiting'), row('B', 'waiting'), row('W1', 'waitlist', { waitlist_num: 1 })];
  await boot(page, q);
  await page.evaluate(`doNoShow('A')`);
  await expect.poll(() => q[2].status).toBe('waiting');
});

test('a desk whose copy is behind cannot no-show or cancel a rider another desk already checked in', async ({ page }) => {
  const q = [row('A', 'waiting', { addons: JSON.stringify([{ id: 'gel', qty: 1 }]) }), row('B', 'waiting'), row('W', 'waitlist', { waitlist_num: 1 })];
  const hits = await boot(page, q);
  const inv = inventoryWrites(page);
  q[0].status = 'active'; q[0].assigned_bike_id = 'b9';        // desk two checked A in; this desk has not heard yet
  await page.evaluate(`doNoShow('A')`);
  await page.waitForTimeout(200);
  expect(q[0].status).toBe('active');
  expect(q[2].status).toBe('waitlist');
  expect(inv).toHaveLength(0);
  expect(hits.find((h) => h.body.status === 'noshow')!.url).toContain('status=eq.waiting');

  q[0].status = 'cancelled';                                     // and now desk two cancelled them
  await page.evaluate(`(async()=>{const e=getQueue().find(x=>x.id==='A');e.status='waiting';await _staffCancelNow('A');})()`);
  await page.waitForTimeout(200);
  expect(q[2].status).toBe('waitlist');                          // a second cancel promotes nobody
  expect(inv).toHaveLength(0);                                   // nor restocks a second time
});

test('undoing a cancel takes the place back from the rider it went to', async ({ page }) => {
  const q = [row('A', 'waiting'), row('B', 'waiting'), row('W', 'waitlist', { waitlist_num: 1 })];
  await boot(page, q);
  await page.evaluate(`_staffCancelNow('A')`);
  await expect.poll(() => q[2].status).toBe('waiting');         // the freed place went to W
  await undoTop(page);
  expect(q[0].status).toBe('waiting');
  expect(q[2].status).toBe('waitlist');                          // two on one place is a 13th rider on 12 bikes
  expect(q[2].waitlist_num).toBe(1);                             // back at the head of the line
});

test('when the promoted rider is already out, the restored booking waits on the waitlist', async ({ page }) => {
  const q = [row('A', 'waiting'), row('B', 'waiting'), row('W', 'waitlist', { waitlist_num: 1 })];
  await boot(page, q);
  await page.evaluate(`doNoShow('A')`);
  await expect.poll(() => q[2].status).toBe('waiting');
  q[2].status = 'active';                                        // W was checked in straight away
  await page.evaluate('loadData()');
  await undoTop(page);
  expect(q[2].status).toBe('active');                            // their place now
  expect(q[0].status).toBe('waitlist');                          // the night is full: A waits for a place
  expect(q[0].waitlist_num).toBeTruthy();
});

test('re-opening a ride onto a bike someone else now has leaves that bike alone', async ({ page }) => {
  const q = [row('A', 'done', { assigned_bike_id: 'b1', paid: true }), row('B', 'active', { assigned_bike_id: 'b1' })];
  const bikes = [bike('b1', 'in-use')];
  await boot(page, q, bikes);
  await page.waitForFunction('getBikes().length>0');
  await page.evaluate(`doReopen('A')`);
  await expect.poll(() => q[0].status).toBe('active');
  expect(q[0].assigned_bike_id).toBeNull();                      // not "on" B's bike
  expect(bikes[0].status).toBe('in-use');
  await undoTop(page);
  expect(q[0].status).toBe('done');
  expect(q[0].assigned_bike_id).toBe('b1');                      // the ride record keeps its bike
  expect(bikes[0].status).toBe('in-use');                        // and B's bike was never freed
});

test('re-opening a ride takes a still-free bike back', async ({ page }) => {
  const q = [row('A', 'done', { assigned_bike_id: 'b2', paid: true })];
  const bikes = [bike('b2', 'available')];
  await boot(page, q, bikes);
  await page.evaluate(`doReopen('A')`);
  await expect.poll(() => q[0].status).toBe('active');
  expect(q[0].assigned_bike_id).toBe('b2');
  expect(bikes[0].status).toBe('in-use');
});

test('close-out returns the no-shows\' add-ons, hands bikes back, and its undo re-claims them', async ({ page }) => {
  const OLD = '2020-02-02';
  const old = (id: string, st: string, x: Row = {}) => row(id, st, { session_id: OLD, session_date: OLD, ...x });
  const q = [old('A', 'active', { assigned_bike_id: 'b1', checked_in_at: '2020-02-02T18:00:00Z' }),
    old('N', 'waiting', { addons: JSON.stringify([{ id: 'gel', qty: 2 }]) })];
  const bikes = [bike('b1', 'in-use')];
  await stubSupabase(page, { sessions: [{ id: OLD, session_date: OLD, day: 'Sunday', status: 'closed', capacity: 10, created_at: 1 }], inventory });
  await statefulTables(page, { queue_entries: q, bikes });
  // the return is staff_return on the server (no page-side fallback since 2026-10-04): it frees the bike
  await page.route(/\/rest\/v1\/rpc\/staff_return/, (r) => {
    const b = r.request().postDataJSON() as { p_booking_id: string };
    const row = q.find((x) => x.id === b.p_booking_id);
    if (row) { row.status = 'done'; bikes.filter((x) => x.id === row.assigned_bike_id).forEach((x) => { x.status = 'available'; }); }
    return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, noop: false, bikes_freed: 1 }) });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  const inv = inventoryWrites(page);
  await page.evaluate(`closeOutSession('${OLD}')`);
  await page.locator('.confirm-box button').filter({ hasText: /close out/i }).click();
  await expect.poll(() => q[1].status).toBe('noshow');
  await expect.poll(() => bikes[0].status).toBe('available');
  await expect.poll(() => inv.length).toBeGreaterThan(0);
  expect(inv[0].qty).toBe(7);                                    // 5 + the no-show's 2
  await undoTop(page);
  expect(q[0].status).toBe('active');
  expect(bikes[0].status).toBe('in-use');                        // re-claimed, not left reading free
  expect(q[1].status).toBe('waiting');
});

test('cancel-night: undo gives back bikes, add-ons and the session\'s own status', async ({ page }) => {
  const q = [row('A', 'active', { assigned_bike_id: 'b1' }), row('B', 'waiting', { addons: JSON.stringify([{ id: 'gel', qty: 1 }]) })];
  const bikes = [bike('b1', 'in-use')];
  await boot(page, q, bikes);
  const inv = inventoryWrites(page);
  await page.evaluate(`showCancelNight('${SID}')`);
  await page.evaluate('execCancelNight()');
  await expect.poll(() => q[1].status).toBe('cancelled');
  expect(bikes[0].status).toBe('available');
  await expect.poll(() => inv.length).toBe(1);                   // B's add-on went back
  await undoTop(page);
  expect(q[0].status).toBe('active');
  expect(q[0].assigned_bike_id).toBe('b1');
  expect(bikes[0].status).toBe('in-use');
  expect(q[1].status).toBe('waiting');
  expect(inv).toHaveLength(2);                                   // and was reserved again
});

test('cancel-night: the WhatsApp links carry the message as edited', async ({ page }) => {
  const q = [row('A', 'waiting', { phone: '0551234567' })];
  await boot(page, q);
  await page.evaluate(`showCancelNight('${SID}')`);
  await page.locator('#cn-msg').fill('New date: Friday 8pm');
  const href = await page.locator('#cancel-night-modal a[data-wa]').getAttribute('href');
  expect(decodeURIComponent(href!)).toContain('New date: Friday 8pm');
});

test('the return payment screen asks for the rental and the add-ons', async ({ page }) => {
  const q = [row('A', 'active', { price: 75, addons: JSON.stringify([{ id: 'gel', qty: 2 }]) })];
  await boot(page, q);
  await page.waitForFunction('(S.inventory||[]).length>0');
  await page.evaluate(`showReturnPayModal('A')`);
  await expect(page.locator('#return-pay-modal')).toContainText('SAR 91');
});

test('bulk Paid leaves an already-paid row alone', async ({ page }) => {
  const q = [row('A', 'waiting'), row('S', 'active', { paid: true, pay_method: 'split', card_amount: 40 })];
  const hits = await boot(page, q);
  await page.evaluate(`S.sfSelected=['A','S'];bulkSfPaid()`);
  await expect.poll(() => q[0].paid).toBe(true);
  expect(q[1].pay_method).toBe('split');
  expect(hits.filter((h) => h.body.paid === true).map((h) => h.matched).flat()).toEqual(['A']);
});

test('a refused price edit is not reported as saved', async ({ page }) => {
  const q = [row('A', 'waiting', { price: 75 })];
  await boot(page, q, [], (t, b) => t === 'queue_entries' && 'price' in b);
  await page.evaluate(`saveEditedPrice('A',50)`);
  await page.waitForTimeout(200);
  expect(await page.evaluate(`getQueue().find(e=>e.id==='A').price`)).toBe(75);
  expect(await page.evaluate('S.undoStack.length')).toBe(0);
});

test('the promotion goes down the line when the first in line was already dealt with', async ({ page }) => {
  const q = [row('A', 'waiting'), row('B', 'waiting'), row('W1', 'waitlist', { waitlist_num: 1 }), row('W2', 'waitlist', { waitlist_num: 2 })];
  await boot(page, q);
  q[2].status = 'cancelled';                                     // W1 cancelled elsewhere; this desk still lists them
  await page.evaluate(`_staffCancelNow('A')`);
  await expect.poll(() => q[3].status).toBe('waiting');
});

test('a restored no-show does not take a number a waitlisted rider holds', async ({ page }) => {
  const q = [row('N', 'noshow', { queue_num: 3 }), row('W', 'waitlist', { queue_num: 3, waitlist_num: 1 }), row('B', 'waiting', { queue_num: 5 })];
  await boot(page, q);
  const undo = page.evaluate(`doUndoNoShow('N')`);
  await page.locator('#confirm-modal').getByRole('button', { name: 'Restore' }).click(); // the night is full (capacity 2): it asks first
  await undo;
  await expect.poll(() => q[0].status).toBe('waiting');
  expect(q[0].queue_num).not.toBe(3);
});

test('the topbar Undo keeps a refused reversal undoable, and claims it before running it', async ({ page }) => {
  await stubSupabase(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const r = await page.evaluate(`(async()=>{
    pushUndo('Refused', async()=>false);
    const e=S.actionLog[0];
    await doUndo();
    const afterRefused={undone:e.undone,stack:S.undoStack.length};
    window.__runs=0;
    pushUndo('Slow', async()=>{window.__runs++;await new Promise(r=>setTimeout(r,150));});
    const p=doUndo();
    const t0=Date.now();while(!window.__runs&&Date.now()-t0<2000)await new Promise(r=>setTimeout(r,5)); // past the code check, the reversal running
    const claimed=S.actionLog[0].undone;
    confirmLogUndo(S.actionLog[0].id);                     // the Logs view's Undo while the topbar's is still running
    const asked=document.getElementById('confirm-modal').style.display==='block';
    await p;await new Promise(r=>setTimeout(r,250));
    return {afterRefused,runs:window.__runs,claimed,asked};
  })()`) as { afterRefused: { undone: boolean; stack: number }; runs: number; claimed: boolean; asked: boolean };
  expect(r.afterRefused.undone).toBe(false);
  expect(r.afterRefused.stack).toBe(1);
  expect(r.runs).toBe(1);
  expect(r.claimed).toBe(true);
  expect(r.asked).toBe(false);
});

test('a render with nothing left to add still retires an older render\'s pending rows', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', '_qPaintRest fills the desktop roster table, which a phone does not show');
  const q = [row('A', 'waiting')];
  await boot(page, q);
  await page.evaluate(`setStaffTab('queue');renderStaffQueue()`);
  await page.waitForSelector('#q-results .queue-table tbody');
  const stale = await page.evaluate(`(async()=>{
    _qPaintRest('<tbody><tr id="stale-row"><td>old</td></tr></tbody>');  // an older, longer render
    _qPaintRest('');                                                       // a newer one, before the frame
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return !!document.getElementById('stale-row');
  })()`);
  expect(stale).toBe(false);
});

test('a no-show sharing a number with a live booking is not a duplicate', async ({ page }) => {
  const q = [row('N', 'noshow', { queue_num: 2 }), row('B', 'waiting', { queue_num: 2 })];
  await boot(page, q);
  await page.evaluate('fixDuplicateQNums()');
  await page.waitForTimeout(150);
  await expect(page.locator('.confirm-box')).toHaveCount(0);
  expect(q[1].queue_num).toBe(2);
});

test('the log keeps two identical actions made in the same minute', async ({ page }) => {
  await stubSupabase(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const lines = await page.evaluate(`(()=>{
    const now=Date.now();
    S._dbLog=[{ts:now,label:'3 paid',by:'Desk A'},{ts:now+5000,label:'3 paid',by:'Desk B'}];S._dbLogAt=now;
    S.fullLog=[{ts:now,label:'3 paid',by:'Desk A'}];            // this device's own copy of the first
    const host=document.createElement('div');host.id='hist-log-host';document.body.appendChild(host);
    renderLogs();
    return (host.innerText.match(/3 paid/g)||[]).length;
  })()`);
  expect(lines).toBe(2);
});

test('a return whose payment write fails is not reported as paid, and the retry saves it', async ({ page }) => {
  const entry = row('A', 'active', { assigned_bike_id: 'b1' });
  await stubSupabase(page, {
    sessions, inventory, queue_entries: [entry], bikes: [bike('b1', 'in-use')],
    'rpc:staff_return': { ok: true, noop: false, bikes_freed: 1 },
  }, { table: 'queue_entries', methods: ['PATCH'], once: true });
  const patches: Row[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) patches.push(r.postDataJSON()); });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`_finishReturn('A',true,'ok',null)`);
  await expect(page.locator('#err-bar-el')).toBeVisible();          // the failure is on screen, with a retry
  await expect(page.locator('#toast-container')).not.toContainText('marked as paid');
  expect(await page.evaluate('S.undoStack.length')).toBe(0);         // nothing to undo on a half-done return
  await page.locator('#err-bar-el button', { hasText: 'Try again' }).click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1].paid).toBe(true);                                 // the retry saves just the payment
  expect(patches[1].status).toBeUndefined();
  await expect(page.locator('#toast-container')).toContainText('marked as paid');
});
