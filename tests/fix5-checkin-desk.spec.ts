import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, checkinAsRow } from './helpers/supabase';

// The 2026-10-05 fixes at the desk: check-in, the classic bike picker, Hand-over and the scanner.
//   - only a payment the staffer tapped goes on into "Assign specific bike…", and the picker says so;
//   - the picker's price goes through staff_set_price, the log and an Undo;
//   - a rider on the house switched to Paid pays the fare again;
//   - Undo check-in frees the bike the rider holds now, and its redo puts the arrival back;
//   - Reserve bike changes only a rider still expected;
//   - riders on their own bike are not waiting for one; Hand-over asks about the fare only for
//     another type and writes the fare it promised;
//   - Express asks the Saturday group; a closed check-in forgets its scanned list; the scanner's
//     amount owed has the add-ons; a Petromin ticket opens tonight's registration.

const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const D = '2099-03-10';
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const SESSION = { id: 's0', day: 'Tuesday', session_date: D, capacity: 12, status: 'open', created_at: 1 };
const bike = (id: string, n: number, type: string, status = 'available') => ({
  id, name: `${type} ${String(n).padStart(3, '0')}`, bike_number: n, type, size: 'M', status, colors: ['#000000'], color_names: [''],
});
const entry = (id: string, n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: 's0', session_day: 'Tuesday', session_date: D, queue_num: n, name: 'Rider ' + id, phone: '',
  customer_id: null, status, paid: false, price: 57.5, type_preference: 'Hybrid', size: 'M', walk_in: true,
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});

async function boot(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, { sessions: [SESSION], bikes: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
}
function patches(page: Page, table: string) {
  const out: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'PATCH' || !r.url().includes(`/rest/v1/${table}`)) return;
    let body: Record<string, unknown> = {};
    try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
    out.push({ url: decodeURIComponent(r.url()), body });
  });
  return out;
}
function checkins(page: Page) {
  const rows: Record<string, unknown>[] = [];
  page.on('request', (r) => { const row = checkinAsRow(r); if (row) rows.push(row); });
  return rows;
}
function rpcCalls(page: Page) {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (!m || r.method() !== 'POST') return;
    let body: Record<string, unknown> = {};
    try { body = r.postDataJSON() || {}; } catch { /* no body */ }
    calls.push({ name: m[1], body });
  });
  return calls;
}
const payPaid = (page: Page) => page.locator('#checkin-modal .ci-opts button', { hasText: 'Paid' }).first();

test.describe('@staff:checkin the payment carried into the bike picker', () => {
  const fx = { queue_entries: [entry('q1', 1, 'waiting')], bikes: [bike('b1', 1, 'Hybrid')] };

  test('the Paid the modal opens on is not carried: the rider stays unpaid', async ({ page }) => {
    await boot(page, fx);
    const p = patches(page, 'queue_entries');
    const ci = checkins(page);
    await page.evaluate(`showCheckinModal('q1')`);
    await page.locator('#checkin-modal .bkm-alink').click();
    await expect.poll(() => page.evaluate('S.modalRider')).toBe('q1');
    await expect(page.locator('#bkm-carry')).toHaveCount(0);
    await page.evaluate(`(async()=>{S.modalBikes=['b1'];await confirmAssign();})()`);
    await expect.poll(() => ci.length).toBe(1);
    await page.waitForTimeout(300);
    expect(ci[0].paid).toBeUndefined();
    expect(p.some((x) => x.body.paid === true)).toBe(false);
  });

  test('a Paid the staffer tapped goes with the bike, and the picker says so', async ({ page }) => {
    await boot(page, fx);
    const p = patches(page, 'queue_entries');
    await page.evaluate(`showCheckinModal('q1')`);
    await payPaid(page).click();
    await page.locator('#checkin-modal .bkm-alink').click();
    await expect(page.locator('#bkm-carry')).toContainText('Paid');
    await page.evaluate(`(async()=>{S.modalBikes=['b1'];await confirmAssign();})()`);
    await expect.poll(() => p.some((x) => x.url.includes('id=eq.q1') && x.body.paid === true)).toBe(true);
  });

  test('the picker\'s own pay button drops the carried payment', async ({ page }) => {
    await boot(page, fx);
    await page.evaluate(`showCheckinModal('q1')`);
    await payPaid(page).click();
    await page.locator('#checkin-modal .bkm-alink').click();
    await expect(page.locator('#bkm-carry')).toBeVisible();
    await page.locator('#bike-modal .pay-toggle.house').click();
    await expect(page.locator('#bkm-carry')).toHaveCount(0);
    expect(await page.evaluate('S._ciPayCarry')).toBeNull();
  });
});

test.describe('@staff:checkin prices and payments', () => {
  test('the picker\'s price goes through staff_set_price, the log and an Undo', async ({ page }) => {
    await boot(page, { queue_entries: [entry('q1', 1, 'waiting')], bikes: [bike('b1', 1, 'Hybrid')], 'rpc:staff_set_price': { ok: true } });
    const calls = rpcCalls(page);
    await page.evaluate(`openModal('q1');S.modalPriceEdit=true;renderModal()`);
    await page.fill('#modal-price-inp', '40');
    await page.evaluate(`saveModalPrice('q1')`);
    expect(calls.filter((c) => c.name === 'staff_set_price').map((c) => c.body)).toEqual([expect.objectContaining({ p_booking_id: 'q1', p_price: 40 })]);
    expect(await page.evaluate('S.undoStack.length')).toBe(1);
    expect(await page.evaluate(`S.fullLog.some(l=>/#1 Rider q1/.test(l.label)&&/40/.test(l.label))`)).toBe(true);
  });

  test('a rider on the house switched to Paid pays the fare again', async ({ page }) => {
    await boot(page, { queue_entries: [entry('h', 1, 'waiting', { paid: true, price: 0 })] });
    const ci = checkins(page);
    await page.evaluate(`showCheckinModal('h')`);
    expect(await page.evaluate('S._ciPaid')).toBe('house');
    await payPaid(page).click();
    await expect(page.locator('#ci-money')).toContainText('57.5');
    await page.evaluate('confirmCheckinModal()');
    await expect.poll(() => ci.length).toBe(1);
    expect(ci[0]).toMatchObject({ price: 57.5, pay_method: 'card' });
  });
});

test.describe('@staff:checkin undo and reserve', () => {
  test('Undo check-in frees the bike held now, guarded on it, and the redo puts the arrival back', async ({ page }) => {
    const at = '2099-03-10T18:00:00.000Z';
    await boot(page, {
      queue_entries: [entry('r1', 1, 'active', { assigned_bike_id: 'b2', paid: true, checked_in_at: at })],
      bikes: [bike('b1', 1, 'Hybrid'), bike('b2', 2, 'Hybrid', 'in-use')],
    });
    const q = patches(page, 'queue_entries');
    const b = patches(page, 'bikes');
    // the entry as it was at check-in (bike 1); the row now holds bike 2
    await page.evaluate(`_undoCheckinWrite({...getQueue().find(x=>x.id==='r1'),assignedBikeId:'b1'})`);
    expect(q[0].url).toContain('assigned_bike_id=eq.b2');
    expect(b).toHaveLength(1);
    expect(b[0].url).toContain('id=eq.b2');
    expect(b[0].url).toContain('status=eq.in-use');
    // Undo check-in, then its redo from the topbar's Undo
    q.length = 0;
    await page.evaluate(`doUndoCheckin('r1')`);
    await expect.poll(() => page.evaluate('S.undoStack.length')).toBe(1);
    await page.evaluate('S.undoStack[S.undoStack.length-1].fn()');
    await expect.poll(() => q.some((x) => x.body.status === 'active')).toBe(true);
    expect(q.find((x) => x.body.status === 'active')!.body.checked_in_at).toBe(at);
  });

  test('Reserve bike changes only a rider still expected', async ({ page }) => {
    await boot(page, { queue_entries: [entry('e1', 1, 'waiting')], bikes: [bike('h1', 1, 'Hybrid')] });
    await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
      const r = route.request();
      if (r.method() === 'PATCH' && decodeURIComponent(r.url()).includes('status=in.')) return route.fulfill({ status: 200, headers: head, body: '[]' });
      return route.fallback();
    });
    await page.evaluate(`(async()=>{openModal('e1');S.modalBikes=['h1'];await reserveBike();})()`);
    await expect(page.locator('.toast', { hasText: 'changed on another device' }).first()).toBeVisible();
    expect(await page.evaluate('S.undoStack.length')).toBe(0);
  });
});

test.describe('@staff:handover riders and fares', () => {
  test('a rider on their own bike is not waiting for one', async ({ page }) => {
    await boot(page, { queue_entries: [entry('own', 1, 'active', { type_preference: 'Own', paid: true, price: 0 }), entry('r2', 2, 'active', { paid: true })] });
    await page.evaluate(`S.sfSession='s0';localStorage.setItem('cq_ho',JSON.stringify({id:'own',at:Date.now()}))`);
    expect(await page.evaluate('_hoRows().map(e=>e.id)')).toEqual(['r2']);
    expect(await page.evaluate(`statusBadgeFor(getQueue().find(x=>x.id==='own'))`)).not.toContain('Needs bike');
    expect(await page.evaluate(`statusBadgeFor(getQueue().find(x=>x.id==='r2'))`)).toContain('Needs bike');
    expect(await page.evaluate('_hoTarget()')).toBeNull();
  });

  test('a Road Carbon rider handed a Road bike is not asked about the fare', async ({ page }) => {
    await boot(page, { queue_entries: [entry('rc', 1, 'active', { type_preference: 'Road Carbon', price: 250 })], bikes: [bike('r1', 1, 'Road')] });
    const calls = rpcCalls(page);
    const p = patches(page, 'queue_entries');
    await page.evaluate(`_hoAssign('rc',{found:true,bike:getBikes().find(b=>b.id==='r1')})`);
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    expect(calls.some((c) => c.name === 'staff_swap_bike')).toBe(true);
    expect(p.some((x) => 'type_preference' in x.body)).toBe(false);
  });

  test('an unpaid rider handed another type is asked, and the fare follows the bike', async ({ page }) => {
    await boot(page, { queue_entries: [entry('hy', 1, 'active')], bikes: [bike('r1', 1, 'Road')] });
    const p = patches(page, 'queue_entries');
    const done = page.evaluate(`_hoAssign('hy',{found:true,bike:getBikes().find(b=>b.id==='r1')})`);
    await expect(page.locator('#confirm-modal')).toContainText('The fare follows the bike.');
    await page.evaluate('_doConfirm()');
    await done;
    const fare = p.find((x) => 'type_preference' in x.body);
    expect(fare?.body).toEqual({ type_preference: 'Road', price: 75 });
    expect(fare?.url).toContain('paid=eq.false');
  });

  test('a paid rider handed another type is told their fare stays, and it does', async ({ page }) => {
    await boot(page, { queue_entries: [entry('pd', 1, 'active', { paid: true })], bikes: [bike('r1', 1, 'Road')] });
    const p = patches(page, 'queue_entries');
    const done = page.evaluate(`_hoAssign('pd',{found:true,bike:getBikes().find(b=>b.id==='r1')})`);
    await expect(page.locator('#confirm-modal')).toContainText('Their fare stays as it is.');
    await page.evaluate('_doConfirm()');
    await done;
    expect(p.some((x) => 'type_preference' in x.body || 'price' in x.body)).toBe(false);
  });
});

test.describe('@staff:scanner Express, scanned lists and what is owed', () => {
  const SAT = { id: 'sat', day: 'Saturday', session_date: D, capacity: 20, spots: 20, status: 'open', created_at: 1,
    event_kind: 'community', ride_kind: 'saturday', needs_approval: true };
  const rider = (id: string, group: string | null) => entry(id, 1, 'waiting', { session_id: 'sat', session_day: 'Saturday', approval: 'approved', price: 0, ride_group: group });

  for (const group of [null, 'beg']) {
    test(`Express on the Saturday ride ${group ? 'checks a rider with a group in' : 'asks the group first'}`, async ({ page }) => {
      await stubSupabase(page, { sessions: [SAT], bikes: [], queue_entries: [rider('g1', group)] });
      await unlockStaff(page);
      await page.goto('/');
      await waitForSb(page);
      await page.waitForFunction('getQueue().length>0');
      const calls = rpcCalls(page);
      await page.evaluate(`_expressCheckin(getQueue().find(x=>x.id==='g1'),()=>{})`);
      if (group) {
        await expect.poll(() => calls.some((c) => c.name === 'staff_checkin')).toBe(true);
      } else {
        await expect(page.locator('#checkin-modal .ci-sat')).toBeVisible();
        expect(calls.some((c) => c.name === 'staff_checkin')).toBe(false);
      }
    });
  }

  test('a closed check-in forgets its scanned list; stepping on to the next rider keeps it', async ({ page }) => {
    await boot(page, { queue_entries: [entry('a', 1, 'waiting'), entry('b', 2, 'waiting')] });
    await page.evaluate(`S._ciBatch=['a','b'];showCheckinModal('a');_ciCloseForNext(getQueue().find(x=>x.id==='a'))`);
    expect(await page.evaluate('S._ciBatch')).toEqual(['a', 'b']);
    await page.evaluate(`showCheckinModal('b');closeCheckinModal()`);
    expect(await page.evaluate('S._ciBatch')).toBeNull();
  });

  test('a rider already in is said to owe their add-ons too', async ({ page }) => {
    await boot(page, {
      queue_entries: [entry('o', 1, 'active', { assigned_bike_id: 'b1', addons: [{ id: 'i1', qty: 1, p: 8 }] })],
      bikes: [bike('b1', 1, 'Hybrid', 'in-use')],
      inventory: [{ id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 5, price: 10, low_threshold: 1 }],
    });
    const said = await page.evaluate(`(()=>{let m='';_scanTicket(getQueue().find(x=>x.id==='o'),(x)=>{m=x;});return m;})()`);
    expect(said).toContain('owes SAR 65.5');
  });

  test('a Petromin ticket opens tonight\'s registration, whatever night is on show', async ({ page }) => {
    const pm = (id: string, date: string) => ({ id, day: 'Monday', session_date: date, capacity: 30, status: 'open', created_at: 1,
      event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false });
    const reg = (id: string, sid: string) => ({ id, name: 'Rider ' + id, booking_no: 'P-001', session_id: sid, source: 'petromin', updated_at: '2099-01-01T10:00:00Z' });
    await stubSupabase(page, {
      sessions: [pm('pm-today', TODAY), pm('pm-later', D)], bikes: [],
      queue_entries: [entry('x', 1, 'waiting')],
      rider_registrations: [reg('r-later', 'pm-later'), reg('r-today', 'pm-today')],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`(async()=>{await loadRiders();S.ridersSession='pm-later';await _scanRider('P-001',()=>{});})()`);
    expect(await page.evaluate('S._riderModalId')).toBe('r-today');
  });
});
