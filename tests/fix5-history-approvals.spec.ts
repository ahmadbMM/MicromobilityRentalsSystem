import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// The 2026-10-05 fixes to History, the waitlist, approvals, Customer activity and Reschedule:
//   - a removal another desk got to first changed nothing else, and the log line came after the write;
//   - nothing is promoted into a ride that has ended, and a done row frees no place;
//   - a waitlisted rider on their own bike is passed over, except on the Petromin ride;
//   - Restore retires the Remove it answers, and History's Undo is an admin's;
//   - Approve, To waitlist, Unapprove and Reject change only a booking still as it was seen;
//   - Customer activity pages by time and id, and its CSV goes through the common export;
//   - Reschedule offers only open circuit rides, and says the server's refusals in the rider's language.

const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const FUT = '2099-11-11';
const PAST = '2020-01-05';
const sess = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, session_date: date, day: 'Wednesday', status: 'open', capacity: 2, created_at: 1, ...extra,
});
const e = (id: string, n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: FUT, session_day: 'Wednesday', session_date: FUT, queue_num: n, name: 'Rider ' + id,
  phone: '05590000' + n, type_preference: 'Road', status, paid: false, price: 75, size: 'M',
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});

async function boot(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, { sessions: [sess(FUT, FUT), sess(PAST, PAST, { status: 'closed' })], bikes: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
}
/** Every PATCH sent to a table, as url + body. */
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
/** Answers a guarded write with no row, as the server does when another desk changed it first. */
async function noRowFor(page: Page, when: (url: string, body: Record<string, unknown>) => boolean) {
  await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
    const r = route.request();
    let body: Record<string, unknown> = {};
    try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
    if (r.method() === 'PATCH' && when(decodeURIComponent(r.url()), body)) return route.fulfill({ status: 200, headers: head, body: '[]' });
    return route.fallback();
  });
}

test.describe('@staff:history remove, restore and the waitlist', () => {
  test('a removal another desk got to first promotes nobody and logs nothing', async ({ page }) => {
    await boot(page, { queue_entries: [e('a', 1, 'waiting'), e('w', 2, 'waitlist', { waitlist_num: 1 })] });
    await noRowFor(page, (url, b) => b.status === 'removed' && url.includes('status=eq.waiting'));
    const p = patches(page, 'queue_entries');
    await page.evaluate(`doRemove('a')`);
    await expect(page.locator('.toast', { hasText: 'changed on another device' }).first()).toBeVisible();
    expect(p.some((x) => x.url.includes('id=eq.w') && x.body.status === 'waiting')).toBe(false);
    expect(await page.evaluate('S.histLog.length')).toBe(0);
  });

  test('removing a waiting row on a ride that has ended promotes nobody into it', async ({ page }) => {
    const past = (x: Record<string, unknown>) => ({ ...x, session_id: PAST, session_date: PAST, session_day: 'Sunday' });
    await boot(page, { queue_entries: [past(e('a', 1, 'waiting')), past(e('w', 2, 'waitlist', { waitlist_num: 1 }))] });
    const p = patches(page, 'queue_entries');
    await page.evaluate(`doRemove('a')`);
    await expect.poll(() => p.some((x) => x.body.status === 'removed')).toBe(true);
    await page.waitForTimeout(300);
    expect(p.some((x) => x.url.includes('id=eq.w'))).toBe(false);
  });

  test('removing a done row frees no place, so nobody is promoted', async ({ page }) => {
    await boot(page, { queue_entries: [e('d', 1, 'done', { paid: true }), e('b', 2, 'waiting'), e('w', 3, 'waitlist', { waitlist_num: 1 })] });
    const p = patches(page, 'queue_entries');
    await page.evaluate(`doRemove('d')`);
    await expect.poll(() => p.some((x) => x.body.status === 'removed' && x.url.includes('status=eq.done'))).toBe(true);
    await page.waitForTimeout(300);
    expect(p.some((x) => x.url.includes('id=eq.w'))).toBe(false);
  });

  for (const petromin of [false, true]) {
    test(`a freed place ${petromin ? 'goes to a waitlisted bike owner on the Petromin ride' : 'passes over a waitlisted rider on their own bike'}`, async ({ page }) => {
      const ride = sess('cr', FUT, { event_kind: 'community', needs_approval: false, paid_ride: true, ...(petromin ? { ride_kind: 'petromin' } : {}) });
      const on = (x: Record<string, unknown>) => ({ ...x, session_id: 'cr' });
      await stubSupabase(page, {
        sessions: [ride], bikes: [],
        queue_entries: [on(e('a', 1, 'waiting')), on(e('b', 2, 'waiting')),
          on(e('own', 3, 'waitlist', { waitlist_num: 1, type_preference: 'Own' })), on(e('w', 4, 'waitlist', { waitlist_num: 2 }))],
      });
      await unlockStaff(page);
      await page.goto('/');
      await waitForSb(page);
      await page.waitForFunction('getQueue().length>0');
      const p = patches(page, 'queue_entries');
      await page.evaluate(`doRemove('a')`);
      await expect.poll(() => p.some((x) => x.body.status === 'waiting')).toBe(true);
      const promoted = p.filter((x) => x.body.status === 'waiting').map((x) => (x.url.match(/id=eq\.([^&]+)/) || [])[1]);
      expect(promoted).toEqual([petromin ? 'own' : 'w']);
    });
  }

  test('Restore retires the Remove it answers, and only an admin undoes from History', async ({ page }) => {
    await boot(page, { queue_entries: [e('a', 1, 'waiting'), e('b', 2, 'done', { paid: true })] });
    await page.evaluate(`doRemove('a')`);
    await expect.poll(() => page.evaluate(`S.histLog.length`)).toBe(1);
    // the stub reads back the fixture: set the row as the server now holds it
    await page.evaluate(`getQueue().find(x=>x.id==='a').status='removed';getQueue().find(x=>x.id==='a').removedFrom='waiting'`);
    const p = patches(page, 'queue_entries');
    await page.evaluate(`doRestoreEntry('a')`);
    await expect.poll(() => page.evaluate(`S.histLog.length`)).toBe(2);
    expect(p.find((x) => x.url.includes('id=eq.a'))!.url).toContain('status=eq.removed');
    expect(await page.evaluate(`S.histLog.find(l=>l.kind==='removed').undone`)).toBe(true);
    // a front-desk account is told so, and nothing is written
    await page.evaluate(`S.staffRole='frontdesk'`);
    const before = p.length;
    await page.evaluate(`undoHistLog(S.histLog.find(l=>l.kind==='restored').id)`);
    await expect(page.locator('.toast', { hasText: 'admin' }).first()).toBeAttached();
    expect(p.length).toBe(before);
    expect(await page.evaluate(`S.histLog.find(l=>l.kind==='restored').undone`)).toBe(false);
  });
});

test.describe('@staff:bookings approvals change only a booking still as it was seen', () => {
  const sat = sess('sat', FUT, { day: 'Saturday', capacity: 10, spots: 10, event_kind: 'community', ride_kind: 'saturday', needs_approval: true });
  const on = (x: Record<string, unknown>) => ({ ...x, session_id: 'sat', session_day: 'Saturday' });

  test('every approval write is guarded on the status seen', async ({ page }) => {
    await stubSupabase(page, {
      sessions: [sat], bikes: [],
      queue_entries: [on(e('p1', 1, 'waiting', { approval: 'pending' })), on(e('p2', 2, 'waiting', { approval: 'pending' })),
        on(e('p3', 3, 'waiting', { approval: 'pending' })), on(e('ok', 4, 'waiting', { approval: 'approved' }))],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    const p = patches(page, 'queue_entries');
    await page.evaluate(`(async()=>{await approveEntry('p1');await commToWaitlist('p2');await rejectEntry('p3');await unapproveEntry('ok');})()`);
    const urlOf = (id: string) => p.find((x) => x.url.includes(`id=eq.${id}`))?.url || '';
    expect(urlOf('p1')).toContain('status=eq.waiting');
    expect(urlOf('p2')).toContain('status=eq.waiting');
    expect(urlOf('p3')).toContain('status=eq.waiting');
    expect(urlOf('ok')).toMatch(/status=eq\.waiting.*approval=eq\.approved|approval=eq\.approved.*status=eq\.waiting/);
  });

  test('approving a booking the rider has just cancelled does not bring it back', async ({ page }) => {
    await stubSupabase(page, { sessions: [sat], bikes: [], queue_entries: [on(e('p1', 1, 'waiting', { approval: 'pending' }))] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await noRowFor(page, (url, b) => b.approval === 'approved');
    await page.evaluate(`approveEntry('p1')`);
    await expect(page.locator('.toast', { hasText: 'changed on another device' }).first()).toBeVisible();
    expect(await page.evaluate('S.undoStack.length')).toBe(0); // nothing to undo: nothing was approved
  });
});

test.describe('@staff:history customer activity', () => {
  const at = '2099-01-02T10:00:00+00:00';
  const act = (id: number) => ({ id, at, customer_id: 'c1', who: 'Spec Rider', action: 'book', detail: {}, origin: 'micromobility.sa' });

  test('Load older pages after the last line by its time and its id', async ({ page }) => {
    await boot(page, { queue_entries: [e('a', 1, 'waiting')], customer_activity: [act(12), act(11)] });
    const asked: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/customer_activity')) asked.push(r.url()); });
    await page.evaluate(`(async()=>{await _cactLoad();await _cactLoad(true);})()`);
    const olderUrl = asked.find((u) => new URL(u).searchParams.has('or'));
    expect(olderUrl).toBeTruthy();
    const older = new URL(olderUrl!);
    expect(older.searchParams.get('order')).toBe('at.desc,id.desc');
    expect(older.searchParams.get('or')).toBe(`(at.lt."${at}",and(at.eq."${at}",id.lt.11))`);
  });

  test('the CSV names every column and is logged like every export', async ({ page }) => {
    await boot(page, { queue_entries: [e('a', 1, 'waiting')] });
    const csv = await page.evaluate(`(async()=>{let out='';const _B=window.Blob;window.Blob=function(p){out=p.join('');return new _B(p,{type:'text/plain'});};
      const _a=document.createElement.bind(document);document.createElement=(t)=>{const el=_a(t);if(t==='a')el.click=()=>{};return el;};
      try{S._cactExport=[${JSON.stringify(act(1))}];exportCustActivityCSV();}finally{window.Blob=_B;document.createElement=_a;}return out;})()`) as string;
    expect(csv.replace(/^﻿/, '').split('\n')[0]).toBe('Time,By,Action,Details,Site');
    expect(await page.evaluate(`S.fullLog[S.fullLog.length-1].label`)).toBe('Exported Customer activity as CSV (1 rows)');
  });
});

test.describe('@customer:reschedule where a booking can move', () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  const day = (n: number) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const ride = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
    id, day: 'Sunday', session_date: day(n), capacity: 9, status: 'open', created_at: 1,
    bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 9 }), location: 'JCC', addons: null, ...extra,
  });
  const sessions = [
    ride('s0', 3), ride('s1', 4), ride('far', 30), ride('gone', -1),
    ride('pm', 5, { event_kind: 'community', ride_kind: 'petromin', needs_approval: false, paid_ride: true }),
    ride('ev', 6, { event_kind: 'community', ride_kind: 'event', needs_approval: false, open_to_all: true }),
  ];
  const mine = { id: 'mine', customer_id: 'c1', session_id: 's0', session_date: day(3), session_day: 'Sunday', queue_num: 1,
    name: 'Spec Rider', status: 'waiting', type_preference: 'Hybrid', size: 'M', paid: false, price: 57.5, registered_at: '2099-01-01T10:00:00Z' };
  async function rider(page: Page, x: Record<string, unknown> = {}) {
    await stubSupabase(page, { sessions, bikes: [], queue_entries: [mine], customers: [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.test' }], ...x });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().some(x=>x.id==='mine')`);
    await page.evaluate(`S._bw={days:10,at:null}`); // the booking window: rides more than ten days ahead are not open yet
  }

  test('only an open circuit ride that has not ended and is open for booking is offered', async ({ page }) => {
    await rider(page);
    await page.evaluate(`showRescheduleModal('s0')`);
    const offered = await page.evaluate(`[...document.querySelectorAll('#reschedule-modal button')].map(b=>b.getAttribute('data-on-click')||'').filter(a=>a.includes('rescheduleBooking'))`) as string[];
    expect(offered).toHaveLength(1);
    expect(offered[0]).toContain('"s1"');
  });

  for (const [code, said] of [
    ['NOT_OPEN_YET: booking for that night opens later', 'That session is not open for booking yet.'],
    ['PAID_MOVE', 'This booking is paid. To move it to a session with a different price, ask at the booth.'],
  ] as const) {
    test(`a move refused with ${code.split(':')[0]} is said in the rider's words`, async ({ page }) => {
      await rider(page, { 'rpc:customer_booking_update': { __rpcError: { status: 400, code: 'P0001', message: code } } });
      await page.evaluate(`rescheduleBooking('s0','s1')`);
      await expect(page.locator('.toast', { hasText: said }).first()).toBeVisible();
      await expect(page.locator('#err-bar-el')).toBeHidden();
    });
  }

  test('a ride that is not open yet is refused before anything is sent', async ({ page }) => {
    await rider(page);
    const rpcs: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/customer_booking_update')) rpcs.push(r.url()); });
    await page.evaluate(`rescheduleBooking('s0','far')`);
    await expect(page.locator('.toast', { hasText: 'Booking opens' }).first()).toBeVisible();
    expect(rpcs).toHaveLength(0);
  });
});
