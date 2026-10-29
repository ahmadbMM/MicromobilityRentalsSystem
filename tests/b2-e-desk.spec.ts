import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The staff review's second batch, desk part (2026-10-29; the review of 2026-10-28):
// P10 an approval ride's request not approved yet stays out of Select all, the bulk Check in / No-show, a party's chain,
//     Scan several and Express (S03-core3-05, S04-core4-04); Express holds back a waitlisted rider and a bike deposit, as the
//     check-in's Confirm would (S04-core4-05); staff_checkin's NOT_APPROVED is said in the desk's words;
// P11 a rider with no fleet bike on record returns in one tap; the sheet stays for a fleet bike and opens on demand from the
//     row menu's "Return with a note" (S04-core4-02);
// P12 the bike picker's first check-in goes the drawer's way: op id, desk outbox, the deposit, the Team report's kind, one row
//     read (S05-core5-01); the pay pill writes paid, price and the method at once (S03-core3-10); a queued payment replays
//     guarded on what it replaced, and Retry sends it as it is (S12-team-settings-02);
// P13 Emergency contact on every booking with an account and in the check-in drawer (S14-best-practice-02); No waiver yet on
//     the roster, its filter and chip, and the rider agreeing on the desk device (S14-best-practice-03);
// P08 a session edit or a template push that leaves fewer places than people booked asks first (S02-core2-06).
// Invented riders, accounts and bikes only.

const ksaDay = (n = 0) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10); // UTC+3 arithmetic
const TODAY = ksaDay(0), D1 = ksaDay(1), D3 = ksaDay(3);
type Row = Record<string, unknown>;

const jcc = (id: string, date: string, over: Row = {}): Row => ({
  id, day: 'Sunday', session_date: date, capacity: 40, status: 'open', created_at: 1, location: 'JCC',
  bike_slots: '{"_time":"21:00 - 23:00","_total":40}', ...over,
});
// An approval ride the desk can tick boxes on (the Saturday ride has none): a workshop staff still approve.
const ws = (id: string, date: string, over: Row = {}): Row => ({
  id, day: 'Monday', session_date: date, capacity: 20, spots: 20, status: 'open', created_at: 1, event_kind: 'community',
  ride_kind: 'workshop', needs_approval: true, hide_queue: true, paid_ride: false, open_to_all: true, bike_slots: '{"_time":"18:00 - 20:00"}', ...over,
});
const bk = (id: string, sid: string, date: string, n: number, over: Row = {}): Row => ({
  id, session_id: sid, session_day: 'Sunday', session_date: date, queue_num: n, name: `Rider ${id}`,
  phone: `05500000${String(n).padStart(2, '0')}`, customer_id: null, type_preference: 'Road', size: 'M', height: 178,
  status: 'waiting', paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z', ...over,
});
const bike = (n: number, over: Row = {}): Row => ({ id: `bk${n}`, name: `R-${String(n).padStart(2, '0')}`, bike_number: n, type: 'Road', size: 'M', status: 'available', colors: [], ...over });
const json = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

async function boot(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, { bikes: [], queue_entries: [], customers: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0');
}
/** The stub answers a write and forgets it: keep queue_entries PATCHes on the fixture rows, as the database would. */
async function keepPatches(page: Page, rows: Row[]) {
  await page.route(/\/rest\/v1\/queue_entries/, async (route: Route) => {
    const r = route.request();
    if (r.method() === 'PATCH') {
      const id = (decodeURIComponent(r.url()).match(/id=eq\.([^&]+)/) || [])[1];
      const row = rows.find((x) => x.id === id);
      try { if (row) Object.assign(row, r.postDataJSON() || {}); } catch { /* not JSON */ }
    }
    return route.fallback();
  });
}
/** Every RPC the page calls: its name and what it sent. */
function rpcs(page: Page) {
  const out: { name: string; body: Row }[] = [];
  page.on('request', (r: Request) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (m) { let b: Row = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ } out.push({ name: m[1], body: b }); }
  });
  return out;
}
/** Every write to a table: method, URL (decoded) and body. */
function writes(page: Page, table: string) {
  const out: { method: string; url: string; body: Row }[] = [];
  page.on('request', (r: Request) => {
    if (!['POST', 'PATCH', 'DELETE'].includes(r.method()) || !new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) return;
    let b: unknown = {}; try { b = r.postDataJSON(); } catch { /* none */ }
    out.push({ method: r.method(), url: decodeURIComponent(r.url()), body: (Array.isArray(b) ? b[0] : b) as Row });
  });
  return out;
}

test.describe('@staff:bookings b2-e requests not approved yet stay out of the fast paths (2026-10-29)', () => {
  test('Select all, the bulk Check in and the bulk No-show leave them alone', async ({ page }) => {
    const q = [
      bk('a1', 'w1', D1, 1, { approval: 'approved', price: 0 }), bk('a2', 'w1', D1, 2, { approval: 'approved', price: 0 }),
      bk('p1', 'w1', D1, 3, { approval: 'pending', price: 0 }), bk('p2', 'w1', D1, 4, { approval: null, price: 0 }),
      bk('r1', 'w1', D1, 5, { approval: 'rejected', price: 0 }), bk('in1', 'w1', D1, 6, { approval: 'approved', status: 'active', price: 0 }),
    ];
    await boot(page, { sessions: [ws('w1', D1)], queue_entries: q });
    const calls = rpcs(page);
    const qw = writes(page, 'queue_entries');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('w1');toggleSfSelect('a1')`);
    const all = page.locator('#bulk-selall');
    await expect(all).toContainText('(3)'); // a1, a2 and the rider on the ride: never the three requests
    await all.click();
    expect((await page.evaluate('S.sfSelected.slice().sort()')) as string[]).toEqual(['a1', 'a2', 'in1']);
    // a request put on the selection some other way is dropped by the bar, and by the actions themselves
    await page.evaluate(`S.sfSelected.push('p1','p2','r1');renderStaffQueue()`);
    expect((await page.evaluate('S.sfSelected.slice().sort()')) as string[]).toEqual(['a1', 'a2', 'in1']);
    await page.evaluate(`_checkinMany(['a1','p1','p2','r1'])`);
    await expect.poll(() => calls.filter((c) => c.name === 'staff_checkin').map((c) => c.body.p_booking_id)).toEqual(['a1']);
    await page.waitForTimeout(300);
    expect(calls.filter((c) => c.name === 'staff_checkin')).toHaveLength(1);
    await page.evaluate(`S.sfSelected=['a2','p2'];bulkSfNoShow();0`); // it waits on its question
    const confirm = page.locator('#confirm-modal .chrome-dact .btn-red');
    await expect(page.locator('#confirm-modal')).toContainText('Rider a2');
    await expect(page.locator('#confirm-modal')).not.toContainText('Rider p2');
    await confirm.click();
    await expect.poll(() => qw.filter((w) => w.body && w.body.status === 'noshow').map((w) => w.url.match(/id=eq\.([^&]+)/)![1])).toEqual(['a2']);
  });

  test('a party\'s chain and its steps pass over a member not approved yet; Previous and Next too', async ({ page }) => {
    const q = [
      bk('m1', 'w1', D1, 1, { approval: 'approved', group_id: 'g1', price: 0 }),
      bk('m2', 'w1', D1, 2, { approval: 'pending', group_id: 'g1', price: 0 }),
      bk('m3', 'w1', D1, 3, { approval: 'approved', group_id: 'g1', price: 0 }),
    ];
    await boot(page, { sessions: [ws('w1', D1)], queue_entries: q });
    await keepPatches(page, q);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('w1');_partyOpenAll();renderStaffQueue();showCheckinModal('m1')`);
    const steps = page.locator('#checkin-modal .bkm-step');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(1)).toBeDisabled();
    await expect(steps.nth(1)).toContainText('Pending approval');
    await expect(steps.nth(1)).toHaveClass(/bkm-stepna/);
    await expect(steps.nth(2)).toBeEnabled();
    expect(await page.evaluate(`_ciPartyRest(getQueue().find(x=>x.id==='m1')).map(x=>x.id)`)).toEqual(['m3']);
    expect(await page.evaluate(`_ciChain().map(x=>x.id)`)).not.toContain('m2');
    await page.locator('#checkin-modal #ci-confirm').click();
    await page.waitForFunction(`S._ciId==='m3'`); // on to the next one that may ride, never the request
  });

  test('the drawer of a request not approved yet says so, and the server\'s NOT_APPROVED is said in the desk\'s words', async ({ page }) => {
    await boot(page, {
      sessions: [ws('w1', D1)], queue_entries: [bk('p1', 'w1', D1, 1, { approval: 'pending', price: 0 })],
      'rpc:staff_checkin': { __rpcError: { status: 400, code: 'P0001', message: 'NOT_APPROVED: #1 is not approved for this session yet' } },
    });
    await page.evaluate(`showCheckinModal('p1')`);
    await expect(page.locator('#checkin-modal .ci-ttag')).toHaveText('Pending approval');
    await page.locator('#checkin-modal #ci-confirm').click();
    await expect(page.locator('#checkin-modal #ci-error')).toHaveText('Not approved for this session yet. Approve the request on the list first.');
    expect(await page.evaluate(`_rpcSay({message:'NOT_APPROVED: #1 is not approved for this session yet'})`)).toBe('Not approved for this session yet. Approve the request on the list first.');
  });

  test('a ticket not approved yet stops the scan; Approve approves it and carries on as the scan would', async ({ page }) => {
    const q = [bk('p1', 'w1', TODAY, 1, { approval: 'pending', price: 0 })];
    await boot(page, { sessions: [ws('w1', TODAY)], queue_entries: q });
    await keepPatches(page, q);
    const calls = rpcs(page);
    await page.evaluate(`window.__said=[];_scanTicket(getQueue().find(x=>x.id==='p1'),(m,c)=>window.__said.push([m,c]))`);
    const [msg, colour] = (await page.evaluate('window.__said[window.__said.length-1]')) as [string, string];
    expect(msg).toBe('#1 Rider p1 is not approved for this session yet.');
    expect(colour).toBe('#ffb347'); // Check (amber), not Stop
    expect(await page.evaluate('_scanExcept&&_scanExcept.lbl')).toBe('apprApproveBtn');
    expect(await page.evaluate('S._ciId')).toBeFalsy();
    await page.evaluate('_scanExceptionGo()');
    await page.waitForFunction(`S._ciId==='p1'`); // approved, then its check-in opens, as the scan would have
    expect(q[0].approval).toBe('approved');
    expect(calls.some((c) => c.name === 'staff_checkin')).toBe(false);
  });

  test('Scan several counts and opens only the riders that can be checked in', async ({ page }) => {
    const q = [
      bk('s1', 'w1', TODAY, 1, { approval: 'approved', group_id: 'g2', price: 0 }),
      bk('s2', 'w1', TODAY, 2, { approval: 'pending', group_id: 'g2', price: 0 }),
    ];
    await boot(page, { sessions: [ws('w1', TODAY)], queue_entries: q });
    const html = await page.evaluate(`_scanBatch=['s1'];_scanBatchHtml()`) as string;
    expect(html).toContain('Check in 1');
    expect(html).not.toContain('+1'); // the request does not come with the ticket
    await page.evaluate('_scanBatchGo()');
    await page.waitForFunction(`S._ciId==='s1'`);
    expect(await page.evaluate(`_ciPartyRest(getQueue().find(x=>x.id==='s1')).length`)).toBe(0);
  });

  test('Express checks in who can go and holds back a waitlisted rider, saying how many', async ({ page }) => {
    const q = [
      bk('x1', 'j1', TODAY, 1, { paid: true, group_id: 'g3' }),
      bk('x2', 'j1', TODAY, 2, { paid: true, group_id: 'g3', status: 'waitlist', waitlist_num: 1 }),
    ];
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: q });
    const calls = rpcs(page);
    await page.evaluate(`window.__said=[];_expressCheckin(getQueue().find(x=>x.id==='x1'),(m,c)=>window.__said.push([m,c]))`);
    await expect.poll(() => page.evaluate('window.__said.length')).toBeGreaterThan(0);
    expect(calls.filter((c) => c.name === 'staff_checkin').map((c) => c.body.p_booking_id)).toEqual(['x1']);
    const [msg, colour] = (await page.evaluate('window.__said[window.__said.length-1]')) as [string, string];
    expect(msg).toContain('1 held back: waitlist, approval or deposit');
    expect(colour).toBe('#ffb347');
    // the waitlisted rider's own ticket opens the check-in, whose title says Waitlist
    await page.evaluate(`_expressCheckin(getQueue().find(x=>x.id==='x2'),()=>{})`);
    await page.waitForFunction(`S._ciId==='x2'`);
    await expect(page.locator('#checkin-modal .ci-ttag')).toHaveText('Waitlist');
    expect(calls.filter((c) => c.name === 'staff_checkin')).toHaveLength(1);
  });

  test('Express stops for a bike deposit as the check-in does, but not on a ride-group ride, which takes none', async ({ page }) => {
    const sat = { id: 'sat1', day: 'Saturday', session_date: TODAY, status: 'open', capacity: 30, spots: 30, created_at: 1, event_kind: 'community',
      ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false, bike_slots: '{"_time":"05:45 - 06:15"}' };
    const q = [
      bk('d1', 'j1', TODAY, 1, { paid: true, type_preference: 'Road Carbon', price: 250 }),
      bk('d2', 'sat1', TODAY, 1, { approval: 'approved', type_preference: 'Road Carbon', price: 0, ride_group: 'beg' }),
    ];
    await boot(page, { sessions: [jcc('j1', TODAY), sat], queue_entries: q, staff_options: [{ key: 'biz', items: { deposits: { 'Road Carbon': 500 } } }] });
    await page.waitForFunction(`_depOn()`);
    const calls = rpcs(page);
    await page.evaluate(`_expressCheckin(getQueue().find(x=>x.id==='d1'),()=>{})`);
    await page.waitForFunction(`S._ciId==='d1'`);
    await expect(page.locator('#checkin-modal .ci-dep')).toContainText('500');
    expect(calls.some((c) => c.name === 'staff_checkin')).toBe(false);
    await page.evaluate('closeCheckinModal()');
    await page.evaluate(`_expressCheckin(getQueue().find(x=>x.id==='d2'),()=>{})`);
    await expect.poll(() => calls.filter((c) => c.name === 'staff_checkin').map((c) => c.body.p_booking_id)).toEqual(['d2']);
  });
});

test.describe('@staff:bookings b2-e return in one tap when no fleet bike is on record (2026-10-29)', () => {
  const rows = () => [
    bk('r1', 'j1', TODAY, 1, { status: 'active', paid: true, pay_method: 'card', checked_in_at: '2099-01-01T18:00:00Z' }),
    bk('r2', 'j1', TODAY, 2, { status: 'active', checked_in_at: '2099-01-01T18:00:00Z' }),
    bk('r3', 'j1', TODAY, 3, { status: 'active', paid: true, pay_method: 'card', assigned_bike_id: 'bk1', checked_in_at: '2099-01-01T18:00:00Z' }),
  ];
  test('paid: one tap; owing: the payment question, then no sheet; a fleet bike keeps the sheet', async ({ page }) => {
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: rows(), bikes: [bike(1, { status: 'in-use' })] });
    const calls = rpcs(page);
    await page.evaluate(`doReturn('r1')`);
    await expect.poll(() => calls.filter((c) => c.name === 'staff_return').map((c) => c.body.p_booking_id)).toEqual(['r1']);
    await expect(page.locator('#return-modal [role="dialog"]')).toHaveCount(0);
    await expect(page.locator('#return-pay-modal [role="dialog"]')).toHaveCount(0);
    await page.evaluate(`doReturn('r2')`);
    const pay = page.locator('#return-pay-modal [role="dialog"]');
    await expect(pay).toBeVisible();
    await pay.getByRole('button', { name: /Mark Paid/i }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_return').map((c) => c.body.p_booking_id)).toEqual(['r1', 'r2']);
    await expect(page.locator('#return-modal [role="dialog"]')).toHaveCount(0);
    await page.evaluate(`doReturn('r3')`);
    await expect(page.locator('#return-modal [role="dialog"]')).toBeVisible(); // a fleet bike: its condition is asked
  });

  test('"Return with a note" opens the sheet on demand and its note reaches the log', async ({ page }) => {
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: rows(), bikes: [bike(1, { status: 'in-use' })] });
    const calls = rpcs(page);
    const log = writes(page, 'staff_actions');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('j1')`);
    const menu = (id: string) => page.evaluate(`(S._rowMenus['${id}']||[]).map(i=>i.run)`) as Promise<string[]>;
    expect(await menu('r1')).toContain(`_dkYRetNote('r1')`);
    expect(await menu('r3')).not.toContain(`_dkYRetNote('r3')`); // its Return opens the sheet anyway
    await page.evaluate(`_dkYRetNote('r1')`);
    const box = page.locator('#return-modal [role="dialog"]');
    await expect(box).toBeVisible();
    await box.locator('#ret-notes').fill('Scratched frame');
    await box.locator('#ret-confirm').click();
    await expect.poll(() => calls.find((c) => c.name === 'staff_return')?.body.p_notes).toBe('Scratched frame');
    await expect.poll(() => log.some((w) => String(w.body.action || '').includes('Scratched frame'))).toBe(true);
  });

  test('Return all asks a condition only of a fleet bike', async ({ page }) => {
    const q = rows();
    q[0].paid = false; // someone owes, so the sheet is drawn
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: q, bikes: [bike(1, { status: 'in-use' })] });
    await page.evaluate(`showBulkReturn(['r1','r3'])`);
    const rowsOf = page.locator('#return-modal .br-row');
    await expect(rowsOf).toHaveCount(2);
    await expect(rowsOf.nth(0).locator('.br-segs')).toHaveCount(0);
    await expect(rowsOf.nth(1).locator('.br-segs')).toHaveCount(1);
  });
});

test.describe('@staff:bookings b2-e the bike picker, the pay pill and the outbox (2026-10-29)', () => {
  test('the picker\'s first check-in: op id, the Team report\'s kind, this row read again and not every list', async ({ page }) => {
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: [bk('w1', 'j1', TODAY, 1)], bikes: [bike(1)] });
    const calls = rpcs(page);
    const log = writes(page, 'staff_actions');
    const reads: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/')) reads.push(decodeURIComponent(r.url())); });
    await page.evaluate(`(async()=>{openModal('w1');S.modalBikes=['bk1'];await confirmAssign();})()`);
    const ci = calls.find((c) => c.name === 'staff_checkin');
    expect(ci?.body).toMatchObject({ p_booking_id: 'w1', p_bike_id: 'bk1' });
    expect(ci?.body.p_op_id).toBeTruthy();
    await expect.poll(() => log.some((w) => w.body.kind === 'checkin' && w.body.entity_id === 'w1')).toBe(true);
    expect(reads.some((u) => /\/rest\/v1\/queue_entries\?.*id=in\.\(.*w1/.test(u))).toBe(true);
    expect(reads.filter((u) => /\/rest\/v1\/(sessions|inventory|promo_codes|desk_waitlist)\b/.test(u))).toEqual([]);
    expect(await page.evaluate(`getQueue().find(x=>x.id==='w1').status`)).toBe('active');
  });

  test('offline, the picker\'s check-in waits in the desk outbox like the drawer\'s', async ({ page, context }) => {
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: [bk('w1', 'j1', TODAY, 1)], bikes: [bike(1)] });
    await context.setOffline(true);
    await page.evaluate(`(async()=>{openModal('w1');S.modalBikes=['bk1'];await confirmAssign();})()`);
    await page.waitForFunction('_DQ.length===1');
    const op = await page.evaluate(`({kind:_DQ[0].kind,bike:_DQ[0].args.p_bike_id,op:!!_DQ[0].args.p_op_id})`);
    expect(op).toEqual({ kind: 'checkin', bike: 'bk1', op: true });
    expect(await page.evaluate(`getQueue().find(x=>x.id==='w1').status`)).toBe('active');
    expect(await page.evaluate(`getBikes().find(b=>b.id==='bk1').status`)).toBe('in-use');
    await expect(page.locator('#bike-modal')).toBeHidden();
    await context.setOffline(false);
  });

  test('a premium bike\'s deposit is asked in the drawer, the bike already in its field', async ({ page }) => {
    await boot(page, {
      sessions: [jcc('j1', TODAY)], queue_entries: [bk('w1', 'j1', TODAY, 1, { type_preference: 'Road Carbon', price: 250 })], bikes: [bike(1)],
      staff_options: [{ key: 'biz', items: { deposits: { 'Road Carbon': 500 } } }],
    });
    await page.waitForFunction(`_depOn()`);
    const calls = rpcs(page);
    await page.evaluate(`(async()=>{openModal('w1');S.modalBikes=['bk1'];await confirmAssign();})()`);
    await page.waitForFunction(`S._ciId==='w1'`);
    await expect(page.locator('#checkin-modal .ci-dep')).toContainText('500');
    expect(await page.evaluate('S._ciBike&&S._ciBike.bike.id')).toBe('bk1');
    expect(calls.some((c) => c.name === 'staff_checkin')).toBe(false);
  });

  test('the pay pill writes paid, price and the method in one update', async ({ page }) => {
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: [bk('w1', 'j1', TODAY, 1)] });
    const qw = writes(page, 'queue_entries');
    await page.evaluate(`togglePayment('w1','card')`);
    await expect.poll(() => qw.filter((w) => w.method === 'PATCH').length).toBe(1);
    await page.waitForTimeout(300);
    const p = qw.filter((w) => w.method === 'PATCH');
    expect(p).toHaveLength(1);
    expect(p[0].body).toEqual({ paid: true, price: 75, pay_method: 'card', card_amount: null });
  });

  test('a payment kept offline replays guarded; changed on another device it needs attention, and Retry sends it as it is', async ({ page, context }) => {
    const q = [bk('w1', 'j1', TODAY, 1)];
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: q });
    await context.setOffline(true);
    await page.evaluate(`togglePayment('w1','card')`);
    await page.waitForFunction('_DQ.length===1');
    expect(await page.evaluate(`({g:_DQ[0].guard,p:_DQ[0].prev})`)).toEqual({ g: true, p: { paid: false, price: 75, pay_method: null, card_amount: null } });
    // meanwhile another desk put the ride on the house: the guarded write finds no row
    Object.assign(q[0], { paid: true, price: 0, pay_method: null });
    const patches: string[] = [];
    await page.route(/\/rest\/v1\/queue_entries/, async (route: Route) => {
      const r = route.request();
      if (r.method() !== 'PATCH') return route.fallback();
      const u = decodeURIComponent(r.url());
      patches.push(u);
      if (u.includes('paid=eq.false')) return route.fulfill({ status: 200, headers: json, body: '[]' });
      return route.fallback();
    });
    await context.setOffline(false);
    await page.evaluate('_dqFlush()');
    await page.waitForFunction(`_DQ.length===1&&_DQ[0].st==='attention'`);
    expect(await page.evaluate('_DQ[0].why')).toBe('Changed on another device: now On the house');
    expect(patches[0]).toContain('paid=eq.false');
    expect(patches[0]).toContain('price=eq.75');
    expect(patches[0]).toContain('pay_method=is.null');
    await page.evaluate(`_dqRetry('')`);
    await page.waitForFunction('_DQ.length===0');
    expect(patches[patches.length - 1]).not.toContain('paid=eq.');
  });
});

test.describe('@staff:bookings b2-e emergency contact and the waiver at the desk (2026-10-29)', () => {
  test('the row menu and the drawer offer the emergency contact on any booking with an account', async ({ page }) => {
    const cust = { id: 'c1', name: 'Rider e1', email: '', phone: '0550000001', emergency_name: 'Mona Ali', emergency_phone: '0551234567', emergency_relation: 'mother' };
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: [bk('e1', 'j1', TODAY, 1, { customer_id: 'c1' }), bk('e2', 'j1', TODAY, 2)], customers: [cust] });
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('j1')`);
    const menu = (id: string) => page.evaluate(`(S._rowMenus['${id}']||[]).map(i=>i.run)`) as Promise<string[]>;
    expect(await menu('e1')).toContain(`_runEmShow('c1')`); // a circuit night, not only runs and races
    expect((await menu('e2')).some((r) => r.startsWith('_runEmShow'))).toBe(false); // a walk-in with no account
    await page.evaluate(`showCheckinModal('e1')`);
    await page.locator('#checkin-modal #ci-em').click();
    const dlg = page.locator('#confirm-modal [role="dialog"]');
    await expect(dlg).toContainText('Mona Ali');
    await expect(dlg.locator('a[href="tel:0551234567"]')).toHaveCount(1);
    await page.evaluate('closeConfirm()');
    await page.evaluate(`showCheckinModal('e2')`);
    await expect(page.locator('#checkin-modal #ci-em')).toHaveCount(0);
  });

  test('No waiver yet: the mark on the roster, the chip and the status filter', async ({ page }) => {
    const q = [
      bk('nw1', 'j1', TODAY, 1, { waiver_version: null }),
      bk('wv1', 'j1', TODAY, 2, { waiver_version: '2026-10-v3' }),
      bk('un1', 'j1', TODAY, 3), // read without the column: nothing is known, nothing is said
    ];
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: q });
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('j1')`);
    await expect(page.locator('#tab-queue .rq-nowv')).toHaveCount(1);
    await expect(page.locator('#tab-queue .rq-nowv')).toHaveText(/No waiver yet/);
    const chip = page.locator('#tab-queue .stat-chip', { hasText: 'No waiver yet' });
    await expect(chip).toContainText('1');
    await chip.click();
    expect(await page.evaluate('S.sfStatus')).toBe('nowaiver');
    expect(await page.evaluate('S._qOrder')).toEqual(['nw1']);
    await expect(page.locator('#tab-queue select option[value="nowaiver"]').first()).toHaveText('No waiver yet');
  });

  test('the rider reads the session\'s waiver in their language on the desk device and agrees for the party', async ({ page }) => {
    const q = [
      bk('n1', 'j1', TODAY, 1, { waiver_version: null, customer_id: 'c2', group_id: 'g9' }),
      bk('n2', 'j1', TODAY, 2, { waiver_version: null, group_id: 'g9' }),
    ];
    await boot(page, { sessions: [jcc('j1', TODAY)], queue_entries: q, customers: [{ id: 'c2', name: 'Rider n1', phone: '0550000001', nationality: 'SA' }] });
    const calls = rpcs(page);
    await page.route(/\/rest\/v1\/rpc\/staff_record_waiver/, async (route: Route) => {
      const b = route.request().postDataJSON() as { p_entry_ids: string[]; p_version: string };
      q.forEach((r) => { if (b.p_entry_ids.includes(String(r.id))) r.waiver_version = b.p_version; });
      return route.fulfill({ status: 200, headers: json, body: JSON.stringify({ ok: true, stamped: b.p_entry_ids.length }) });
    });
    await page.evaluate(`showCheckinModal('n1')`);
    await page.locator('#checkin-modal #ci-wv').click();
    const sheet = page.locator('#confirm-modal .dky-wv');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('select')).toHaveValue('ar'); // a Saudi account reads Arabic first
    await expect(sheet.locator('#dky-wv-t')).toHaveText('إقرار الركوب');
    await expect(sheet.locator('.dky-wv-txt')).toHaveAttribute('dir', 'rtl');
    await expect(sheet).toContainText('#1 Rider n1, #2 Rider n2'); // the party it covers
    await sheet.locator('select').selectOption('en');
    await expect(sheet.locator('#dky-wv-t')).toHaveText('Ride waiver');
    const go = sheet.locator('#dky-wv-go');
    await expect(go).toBeDisabled();
    await sheet.locator('.dky-wv-ok input').check();
    await expect(go).toBeEnabled();
    await expect(go).toHaveText('Agree and continue');
    await go.click();
    await expect(sheet).toHaveCount(0);
    const call = calls.find((c) => c.name === 'staff_record_waiver');
    expect(call?.body).toMatchObject({ p_entry_ids: ['n1', 'n2'], p_version: '2026-10-v3' });
    await expect(page.locator('#checkin-modal #ci-wv')).toHaveCount(0);
    expect(await page.evaluate(`getQueue().filter(x=>['n1','n2'].includes(x.id)).map(x=>x.waiverVersion)`)).toEqual(['2026-10-v3', '2026-10-v3']);
  });

  test('a pool session\'s sheet shows the swim waiver; a database without the function says so', async ({ page }) => {
    const pool = { id: 'p1s', day: 'Friday', session_date: TODAY, capacity: 20, spots: 20, status: 'open', created_at: 1, event_kind: 'community',
      ride_kind: 'swim', needs_approval: false, hide_queue: true, paid_ride: false, open_to_all: true, bike_slots: '{"_time":"07:00 - 08:00"}' };
    await boot(page, {
      sessions: [pool], queue_entries: [bk('sw1', 'p1s', TODAY, 1, { waiver_version: null, price: 0, type_preference: 'None' })],
      'rpc:staff_record_waiver': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_record_waiver in the schema cache' } },
    });
    await page.evaluate(`showCheckinModal('sw1')`);
    await page.locator('#checkin-modal #ci-wv').click();
    const sheet = page.locator('#confirm-modal .dky-wv');
    await expect(sheet.locator('#dky-wv-t')).toHaveText('Swim waiver');
    await sheet.locator('.dky-wv-ok input').check();
    await sheet.locator('#dky-wv-go').click();
    await expect(sheet.locator('.dky-wv-err')).toHaveText('Waiting for the database update.');
  });
});

test.describe('@staff:sessions b2-e fewer places than people booked (2026-10-29)', () => {
  const SID = D3;
  const fx = () => ({
    sessions: [jcc(SID, D3, { capacity: 10, bike_slots: '{"_time":"21:00 - 23:00","_total":10}', template_id: 't1' })],
    queue_entries: [1, 2, 3, 4, 5, 6].map((n) => bk(`b${n}`, SID, D3, n)),
  });
  test('a session edit that cuts the places below the riders booked asks first; Cancel saves nothing', async ({ page }) => {
    await boot(page, fx());
    const sw = writes(page, 'sessions');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SID}')`);
    await page.fill('#es-total', '4');
    await page.evaluate('saveSessionEdit();0'); // it waits on its question
    const dlg = page.locator('#confirm-modal [role="dialog"]');
    await expect(dlg).toContainText('Fewer places than people booked');
    await expect(dlg).toContainText('6 booked, 4 places');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);
    expect(sw.filter((w) => 'capacity' in (w.body || {}))).toHaveLength(0);
    expect(await page.evaluate('S.editSessionId')).toBe(SID); // still editing
    await page.evaluate('saveSessionEdit();0');
    await dlg.getByRole('button', { name: 'Save anyway' }).click();
    await expect.poll(() => sw.find((w) => 'capacity' in (w.body || {}))?.body.capacity).toBe(4);
  });

  test('a raise, or a cut that still holds everyone, asks nothing', async ({ page }) => {
    await boot(page, fx());
    const sw = writes(page, 'sessions');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SID}')`);
    await page.fill('#es-total', '8');
    await page.evaluate('saveSessionEdit()');
    await expect.poll(() => sw.find((w) => 'capacity' in (w.body || {}))?.body.capacity).toBe(8);
    await expect(page.locator('#confirm-modal [role="dialog"]')).toHaveCount(0);
  });

  test('a template pushed to its future rides asks first when one would be over-booked', async ({ page }) => {
    await boot(page, fx());
    const sw = writes(page, 'sessions');
    const push = `_nsTplPush({id:'t1',label:'Circuit',form:{newSessEvent:'jcc',newSessStartTime:'21:00',newSessEndTime:'23:00',newSessMode:'total',newSessTotal:4}},[allSessions().find(x=>x.id==='${SID}')])`;
    await page.evaluate(`setStaffTab('sessions');window.__p=${push};0`);
    const dlg = page.locator('#confirm-modal [role="dialog"]');
    await expect(dlg).toContainText('6 booked, 4 places');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await page.evaluate('window.__p');
    expect(sw.filter((w) => 'capacity' in (w.body || {}))).toHaveLength(0);
    await page.evaluate(`window.__p=${push};0`);
    await dlg.getByRole('button', { name: 'Save anyway' }).click();
    await page.evaluate('window.__p');
    expect(sw.find((w) => 'capacity' in (w.body || {}))?.body.capacity).toBe(4);
  });
});
