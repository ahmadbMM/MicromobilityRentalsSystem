import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The staff review, 2026-10-28, P01 "Make Close out settle the night correctly":
// - Close out names the paid riders it would mark No-show, each They rode / No-show, No-show by default; They rode is
//   the checked-in riders' write, and the count line follows the choices (S03-core3-02, S13-open-items-01).
// - Before the session's end it says so in the warning colour and its button reads Close out early (S03-core3-02).
// - It says who can undo it, as it really is: no bar at the top (S03-core3-02, S13-open-items-01).
// - Close asks about Close out on a night that has begun (today or before) with riders still open; Just close settles
//   nothing (S02-core2-03, S13-open-items-03, S14-best-practice-05).
// - The bell: one line per night before today left open, opening that night and its Close out; Rides past 2 hours keeps
//   to today's riders (S13-open-items-03).
// - The bulk No-show asks when the account cannot undo it or the session has not started (S03-core3-06).
// Invented riders only.

type Row = Record<string, unknown>;
const KSA = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // the KSA day, as todayStr()
const OLD = '2020-03-03', OLD2 = '2020-03-04', FUT = '2099-03-03';
const DAY = '2099-05-05'; // "today" for the specs that fix the clock (page.clock), so the hour is never the machine's
const night = (id: string, date: string, x: Row = {}): Row => ({
  id, session_date: date, day: 'Tuesday', status: 'open', capacity: 10, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":10}', ...x,
});
const row = (id: string, sid: string, date: string, num: number, status: string, x: Row = {}): Row => ({
  id, session_id: sid, session_day: 'Tuesday', session_date: date, queue_num: num, name: 'Rider ' + id.toUpperCase(),
  phone: '', customer_id: null, group_id: null, status, paid: false, price: 75, walk_in: true,
  registered_at: `2020-01-01T10:0${num}:00Z`, type_preference: 'Road', size: 'M', ...x,
});
const bike = (id: string, n: number, status: string): Row => ({ id, name: 'Road ' + n, bike_number: n, type: 'Road', size: 'M', status, colors: [], color_names: [] });

function matches(r: Row, params: URLSearchParams) {
  for (const [k, v] of params) {
    const m = v.match(/^(eq|in|is)\.(.*)$/);
    if (!m || ['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const s = r[k] == null ? 'null' : String(r[k]);
    if (m[1] === 'eq' && s !== m[2]) return false;
    if (m[1] === 'is' && !(m[2] === 'null' ? r[k] == null : s === m[2])) return false;
    if (m[1] === 'in' && !m[2].replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')).includes(s)) return false;
  }
  return true;
}

/** queue_entries and bikes held in memory: a GET answers them, a PATCH changes the rows its filters match and answers them. */
async function boot(page: Page, sessions: Row[], q: Row[], bikes: Row[] = [], init?: () => void) {
  await stubSupabase(page, { sessions, bikes });
  const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  const tables: Record<string, Row[]> = { queue_entries: q, bikes };
  const writes: { table: string; body: Row; url: string }[] = [];
  await page.route(/\/rest\/v1\/(queue_entries|bikes)(\?|$)/, async (route) => {
    const req = route.request(), url = new URL(req.url()), table = url.pathname.split('/').pop() as string, rows = tables[table];
    if (req.method() === 'GET') return route.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${rows.length}/${rows.length}` }, body: JSON.stringify(rows) });
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Row, hit = rows.filter((r) => matches(r, url.searchParams));
      hit.forEach((r) => Object.assign(r, body));
      writes.push({ table, body, url: decodeURIComponent(req.url()) });
      return route.fulfill({ status: 200, headers: head, body: JSON.stringify(hit) });
    }
    return route.fallback();
  });
  const returns: Row[] = [];
  await page.route(/\/rest\/v1\/rpc\/staff_return/, (r) => {
    const b = r.request().postDataJSON() as Row;
    returns.push(b);
    const e = q.find((x) => x.id === b.p_booking_id);
    if (e) { e.status = 'done'; bikes.filter((x) => x.id === e.assigned_bike_id).forEach((x) => { x.status = 'available'; }); }
    return r.fulfill({ status: 200, headers: head, body: JSON.stringify({ ok: true, noop: false, bikes_freed: 1 }) });
  });
  if (init) await page.addInitScript(init);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  return { writes, returns };
}

test.describe('@staff:bookings b1-a close out settles the night correctly', () => {
  test('paid riders who never arrived are named: They rode completes one, the rest are No-show, and Undo brings them back', async ({ page }) => {
    const q = [
      row('a', OLD, OLD, 1, 'active', { assigned_bike_id: 'b1', checked_in_at: '2020-03-03T18:00:00Z', paid: true }),
      row('b', OLD, OLD, 2, 'waiting', { checked_in_at: '2020-03-03T18:05:00Z' }),
      row('c', OLD, OLD, 3, 'waiting', { paid: true, pay_method: 'card' }),
      row('d', OLD, OLD, 4, 'waiting', { paid: true, pay_method: 'cash' }),
      row('e', OLD, OLD, 5, 'waiting'),
    ];
    const bikes = [bike('b1', 1, 'in-use')];
    const { writes, returns } = await boot(page, [night(OLD, OLD)], q, bikes);
    await page.evaluate(`closeOutSession('${OLD}')`);
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box.locator('#co-x-sum')).toHaveText('2 checked-in rider(s) will be marked Completed and 3 who never arrived will be marked No-show. Waitlisted riders are not touched.');
    const paid = box.locator('.co-x-paid .co-x-row');
    await expect(box.locator('.co-x-paid')).toContainText('Paid, never checked in (2)');
    await expect(paid).toHaveCount(2);
    await expect(paid.nth(0)).toContainText('#3 Rider C');
    await expect(paid.nth(1)).toContainText('#4 Rider D');
    await expect(box.locator('.co-x-paid')).not.toContainText('Rider E'); // unpaid: the count line only
    await expect(box.locator('.co-x-paid')).not.toContainText('Rider B'); // checked in: completed as before
    // No-show is the default, as it always did, now in sight
    await expect(paid.nth(0).locator('.co-x-ns')).toHaveAttribute('aria-pressed', 'true');
    await expect(paid.nth(0).locator('.co-x-rode')).toHaveAttribute('aria-pressed', 'false');
    await paid.nth(0).getByRole('button', { name: 'They rode' }).click();
    await expect(paid.nth(0).locator('.co-x-rode')).toHaveAttribute('aria-pressed', 'true');
    await expect(paid.nth(0).locator('.co-x-ns')).toHaveAttribute('aria-pressed', 'false');
    await expect(box.locator('#co-x-sum')).toContainText('3 checked-in rider(s) will be marked Completed and 2 who never arrived');
    // the night is over: no early line and the button is Close out; nothing promises a bar at the top
    await expect(box.locator('.co-x-early')).toHaveCount(0);
    await expect(box).not.toContainText(/bar at the top/i);
    await expect(box.locator('.co-x-undo')).toHaveText('You can undo it on this device until the page is reloaded: from History > Log, or with Undo at the top while it is your last action.');
    await box.locator('.co-mk-ok').click(); // bike 001 is back
    await box.getByRole('button', { name: /^close out$/i }).click();
    await expect.poll(() => q.map((r) => r.status).join()).toBe('done,done,done,noshow,noshow');
    expect(returns.map((r) => r.p_booking_id)).toEqual(['a']);
    const done = writes.find((w) => w.table === 'queue_entries' && w.body.status === 'done')!;
    expect(done.url).toContain('id=in.(b,c)');           // They rode takes the checked-in riders' write
    expect(done.url).toContain('status=eq.waiting');     // guarded on what it saw
    const ns = writes.find((w) => w.table === 'queue_entries' && w.body.status === 'noshow')!;
    expect(ns.url).toContain('id=in.(d,e)');
    // the log names who was completed on staff's word
    await expect.poll(() => page.evaluate(`S.fullLog.map(l=>l.label).join('|')`)).toContain('They rode: #3 Rider C');
    // and the admin's Undo puts the night back as it was
    expect(await page.evaluate(`S.undoStack[S.undoStack.length-1].label`)).toContain('Close out the night');
    await page.evaluate('doUndo()');
    await expect.poll(() => q.map((r) => r.status).join()).toBe('active,waiting,waiting,waiting,waiting');
  });

  test('before the end the dialog says so and reads Close out early; a desk account is told it cannot undo; no bikes, They came', async ({ page }) => {
    const EV = DAY + '-ev';
    const ev = night(EV, DAY, { event_kind: 'community', ride_kind: 'event', paid_ride: true, needs_approval: false });
    const q = [
      row('p', EV, DAY, 1, 'waiting', { paid: true, price: 50, type_preference: 'None' }),
      row('u', EV, DAY, 2, 'waiting', { price: 50, type_preference: 'None' }),
    ];
    await page.clock.setFixedTime(new Date(`${DAY}T20:00:00+03:00`)); // the evening of the session, before its 23:00 end
    await boot(page, [ev], q);
    await page.evaluate(`setStaffRole('frontdesk');closeOutSession('${EV}')`);
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box.locator('.co-x-early')).toHaveText('This session ends at 11 PM. 2 rider(s) may still arrive.');
    await expect(box.locator('.co-x-paid .co-x-row')).toHaveCount(1);
    await expect(box.locator('.co-x-paid')).toContainText('#1 Rider P');
    await expect(box.locator('.co-x-paid')).toContainText('They came');   // a session without bikes never says rode
    await expect(box.locator('.co-x-paid')).not.toContainText('They rode');
    await expect(box.locator('.co-x-undo')).toHaveText('Your account cannot undo a close-out. A rider marked No-show by mistake can be brought back with Customer Showed on their row.');
    await expect(box).not.toContainText(/bar at the top/i);
    // in the warning colour (the token every warning on the desk wears)
    const warn = await page.evaluate(`(()=>{const s=document.createElement('span');s.style.color='var(--orange)';document.body.appendChild(s);const c=getComputedStyle(s).color;s.remove();return c;})()`);
    expect(await box.locator('.co-x-early').evaluate((el) => getComputedStyle(el).color)).toBe(warn);
    await expect(box.getByRole('button', { name: /^close out$/i })).toHaveCount(0);
    // once the session has ended it is a plain Close out, with nothing about the end
    await page.evaluate('closeConfirm()');
    await page.clock.setFixedTime(new Date(`${DAY}T23:20:00+03:00`));
    await page.evaluate(`closeOutSession('${EV}')`);
    await expect(box.locator('.co-x-early')).toHaveCount(0);
    await expect(box.getByRole('button', { name: 'Close out early' })).toHaveCount(0);
    await page.evaluate('closeConfirm()');
    await page.clock.setFixedTime(new Date(`${DAY}T20:00:00+03:00`));
    await page.evaluate(`closeOutSession('${EV}')`);
    const early = box.getByRole('button', { name: 'Close out early' });
    await expect(early).toBeVisible();
    await early.click();
    await expect.poll(() => q.map((r) => r.status).join()).toBe('noshow,noshow'); // No-show by default, as before
  });

  test('Close asks about Close out on a night with riders still open; Just close settles nothing', async ({ page }) => {
    const q = [
      row('a', OLD, OLD, 1, 'active', { checked_in_at: '2020-03-03T18:00:00Z' }),
      row('w', OLD, OLD, 2, 'waiting'),
      row('x', OLD, OLD, 3, 'waiting', { paid: true }),
      row('f', FUT, FUT, 1, 'waiting'),
      row('g', OLD2, OLD2, 1, 'done'),
    ];
    const { writes } = await boot(page, [night(OLD, OLD), night(FUT, FUT), night(OLD2, OLD2)], q);
    const qWrites = () => writes.filter((w) => w.table === 'queue_entries').length;
    await page.evaluate(`toggleSession('${OLD}','closed')`);
    const ask = page.locator('#co-x-ask');
    await expect(ask).toBeVisible();
    await expect(ask).toHaveAttribute('role', 'dialog');
    await expect(ask).toContainText('3 riders are still open on this night. Close only changes the status; Close out settles them.');
    await ask.getByRole('button', { name: 'Just close' }).click();
    await expect(ask).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(qWrites()).toBe(0); // Close never touches bookings
    // a night still ahead, and a night with nobody open, are not asked about
    await page.evaluate(`toggleSession('${FUT}','closed')`);
    await page.waitForTimeout(400);
    await expect(ask).toHaveCount(0);
    await page.evaluate(`toggleSession('${OLD2}','closed')`);
    await page.waitForTimeout(400);
    await expect(ask).toHaveCount(0);
    // Close out now opens the Close out dialog, which still asks before it settles anything
    await page.evaluate(`toggleSession('${OLD}','closed')`);
    await ask.getByRole('button', { name: 'Close out now' }).click();
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box).toContainText('Close out the night');
    await expect(box.locator('#co-x-sum')).toContainText('1 checked-in rider(s) will be marked Completed and 2 who never arrived');
    expect(qWrites()).toBe(0);
  });

  test('tonight closed before it starts (sign-ups stopped) is not asked about; once it has begun, it is', async ({ page }) => {
    const q = [row('t1', DAY, DAY, 1, 'waiting'), row('t2', DAY, DAY, 2, 'waiting', { paid: true })];
    await page.clock.setFixedTime(new Date(`${DAY}T15:00:00+03:00`)); // the afternoon, the ride at 21:00
    await boot(page, [night(DAY, DAY)], q);
    const ask = page.locator('#co-x-ask');
    await page.evaluate(`toggleSession('${DAY}','closed')`);
    await page.waitForTimeout(400);
    await expect(ask).toHaveCount(0);
    await page.clock.setFixedTime(new Date(`${DAY}T22:40:00+03:00`)); // the ride is on: packing up
    await page.evaluate(`toggleSession('${DAY}','closed')`);
    await expect(ask).toContainText('2 riders are still open on this night.');
  });

  test('the bell: one line per night left open, opening that night and its Close out; Rides past 2 hours keeps to today', async ({ page }) => {
    const ago = new Date(Date.now() - 3 * 3600e3).toISOString();
    const SAT = '2020-03-07';
    const q = [
      row('o1', OLD, OLD, 1, 'active', { checked_in_at: '2020-03-03T18:00:00Z' }),
      row('o2', OLD, OLD, 2, 'active', { checked_in_at: '2020-03-03T18:01:00Z' }),
      row('o3', OLD, OLD, 3, 'waiting'),
      row('s1', SAT, SAT, 1, 'waiting', { approval: 'approved', price: 0 }),
      row('d1', OLD2, OLD2, 1, 'done'),
      row('t1', KSA, KSA, 1, 'active', { checked_in_at: ago }),
    ];
    const sat = night(SAT, SAT, { day: 'Saturday', event_kind: 'community', ride_kind: 'saturday', needs_approval: true, paid_ride: false, bike_slots: '{"_time":"06:00 - 08:00"}' });
    await boot(page, [night(OLD, OLD), night(OLD2, OLD2), sat, night(KSA, KSA, { bike_slots: '{"_time":"00:00 - 23:59"}' })], q, [],
      () => localStorage.setItem('cq_nt_read2', JSON.stringify({ coopen: [], long: [] })));
    const kinds = () => page.evaluate(`JSON.stringify(_ntKindsNow().filter(k=>k.k==='coopen'||k.k==='long').map(k=>({k:k.k,ids:k.ids,txt:k.items.map(i=>i.txt)})))`).then((s) => JSON.parse(s as string) as { k: string; ids: string[]; txt: string[] }[]);
    let ks = await kinds();
    const open = ks.find((k) => k.k === 'coopen')!;
    expect(open.ids.sort()).toEqual([OLD, SAT].sort());                   // one line per night, an admin sees the Saturday side
    expect(open.txt.find((t) => t.includes('3 still open'))).toBeTruthy(); // 2 on a bike and 1 waiting, as one line
    expect(ks.find((k) => k.k === 'long')!.ids).toEqual(['t1']);         // only today's long ride; the old night's riders are not one line each
    // Front Desk never meets the Saturday side; an account without Bookings has no such line
    await page.evaluate(`setStaffRole('frontdesk')`);
    ks = await kinds();
    expect(ks.find((k) => k.k === 'coopen')!.ids).toEqual([OLD]);
    await page.evaluate(`setStaffRole('mechanic')`);
    ks = await kinds();
    expect(ks.some((k) => k.k === 'coopen')).toBe(false);
    await page.evaluate(`setStaffRole('admin');setStaffTab('dashboard')`);
    // the line in the bell opens that night's roster and its Close out
    await page.evaluate('_ntSync();_ntOpen()');
    const line = page.locator(`#nt-panel .nt-row[data-nt="coopen"][data-nt-id="${OLD}"]`);
    await expect(line).toContainText('3 still open');
    await line.click();
    await expect.poll(() => page.evaluate(`S.staffTab+'|'+S.queueView+'|'+S.sfSession`)).toBe(`queue|bookings|${OLD}`);
    await expect(page.locator('#confirm-modal .confirm-box')).toContainText('Close out the night');
    // Settings lists the new kind so an account can turn it off
    expect(await page.evaluate(`NT_KINDS.some(k=>k[0]==='coopen'&&k[1]==='ntkCoOpen')`)).toBe(true);
  });

  test('the bulk No-show asks when the account cannot undo it or the session has not started; otherwise one tap', async ({ page }) => {
    const q = [
      row('x1', OLD, OLD, 1, 'waiting'), row('x2', OLD, OLD, 2, 'waiting'),
      row('y1', OLD, OLD, 3, 'waiting'), row('y2', OLD, OLD, 4, 'waiting', { paid: true }),
      row('z1', FUT, FUT, 1, 'waiting'),
    ];
    const { writes } = await boot(page, [night(OLD, OLD), night(FUT, FUT)], q);
    const nsWrites = () => writes.filter((w) => w.table === 'queue_entries' && w.body.status === 'noshow');
    const pick = (sid: string, ids: string[]) => page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('${sid}');S.sfSelected=${JSON.stringify(ids)};renderStaffQueue()`);
    const box = page.locator('#confirm-modal .confirm-box');
    // an admin, a night that has begun: one tap, as before
    await pick(OLD, ['x1', 'x2']);
    await page.locator('#bulk-noshow').click();
    await expect.poll(() => nsWrites().length).toBe(2);
    await expect(box).toHaveCount(0);
    // a session still ahead: asked first, and Cancel marks nobody
    await pick(FUT, ['z1']);
    await page.locator('#bulk-noshow').click();
    await expect(box).toContainText('Their session has not started yet.');
    await expect(box).toContainText('#1 Rider Z1');
    await box.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);
    expect(nsWrites().length).toBe(2);
    expect(q[4].status).toBe('waiting');
    // a desk account cannot undo it: asked, the riders named and the paid one marked
    await page.evaluate(`setStaffRole('frontdesk')`);
    await pick(OLD, ['y1', 'y2']);
    await page.locator('#bulk-noshow').click();
    await expect(box).toContainText('Mark these riders as no-show (2)?');
    await expect(box).toContainText('#3 Rider Y1');
    await expect(box).toContainText('#4 Rider Y2 · Paid');
    await expect(box).toContainText('Your account cannot undo actions.');
    await expect(box).not.toContainText('Their session has not started yet.');
    await box.getByRole('button', { name: 'No-Show' }).click();
    await expect.poll(() => nsWrites().length).toBe(4);
    expect(q[2].status).toBe('noshow');
    expect(q[3].status).toBe('noshow');
  });
});
