import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type FailWrite } from './helpers/supabase';

// Review fixes of 2026-10-05 (Bookings, the roster, the editors): the group editor leaves a seat's
// 'None' alone and skips members who left; a failed registrations read is not retried on every
// paint; a moved booking takes the new ride's type rules and fare; the account editor writes what
// it showed even when it is closed mid-save; the walk-in's Retry never books a landed party twice;
// Previous / Next follow the roster as drawn; Enter on a booking number counts the ride picked;
// Front Desk sees no Saturday cancellations; "vs last week" compares like with like; bulk Paid
// re-reads its own rows; the sort headers are buttons.

const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const dayOff = (n: number) => {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
async function staff(page: Page, fixtures: Record<string, unknown>, fail?: FailWrite) {
  await stubSupabase(page, { bikes: [], queue_entries: [], ...fixtures }, fail);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0');
}
function writesTo(page: Page, table: string) {
  const w: { method: string; url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (['POST', 'PATCH'].includes(r.method()) && new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) {
      let body: Record<string, unknown> = {};
      try { const b = r.postDataJSON(); body = (Array.isArray(b) ? b[0] : b) || {}; } catch { /* not JSON */ }
      w.push({ method: r.method(), url: decodeURIComponent(r.url()), body });
    }
  });
  return w;
}
const jcc = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, day: 'Sunday', session_date: date, capacity: 20, status: 'open', created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...over,
});
const bk = (id: string, sid: string, date: string, n: number, over: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: date, queue_num: n, name: `Rider ${id}`, phone: `05500000${String(n).padStart(2, '0')}`,
  customer_id: null, type_preference: 'Road', size: 'M', height: 178, status: 'waiting', paid: false, price: 75,
  registered_at: '2099-01-01T10:00:00Z', ...over,
});
const patchOf = (w: { method: string; url: string; body: Record<string, unknown> }[], id: string) =>
  w.filter((x) => x.method === 'PATCH' && x.url.includes(`id=eq.${id}`)).map((x) => x.body);

test.describe('@staff:bookings rb1 group editor (2026-10-05)', () => {
  test('on a ride without bikes the group editor offers no bike type and leaves the seats as they are', async ({ page }) => {
    const ev = jcc('ev1', '2099-03-05', { day: 'Thursday', event_kind: 'community', ride_kind: 'event', needs_approval: false, hide_queue: true,
      paid_ride: true, price: 50, spots: 30, bike_slots: '{"_time":"19:00 - 21:00"}' });
    const seat = (id: string, n: number) => bk(id, 'ev1', '2099-03-05', n, { type_preference: 'None', size: '', height: null, price: 50, group_id: 'g1', group_name: 'Falcons' });
    await staff(page, { sessions: [ev], queue_entries: [seat('e1', 1), seat('e2', 2)] });
    const qw = writesTo(page, 'queue_entries');
    await page.evaluate(`showGroupEditModal('e1')`);
    await expect(page.locator('#ge-gname')).toHaveValue('Falcons');
    await expect(page.locator('#ge-r-type-0, #ge-r-type-1')).toHaveCount(0);
    await page.evaluate('saveGroupEdit()');
    await expect.poll(() => qw.filter((x) => x.method === 'PATCH').length).toBe(2);
    for (const w of qw) { expect(w.body).not.toHaveProperty('type_preference'); expect(w.body).not.toHaveProperty('price'); }
  });

  test('a member who cancelled after the group editor opened is not moved with the others', async ({ page }) => {
    const g = (id: string, n: number) => bk(id, 's0', '2099-03-01', n, { group_id: 'g1', group_name: 'Falcons' });
    await staff(page, { sessions: [jcc('s0', '2099-03-01'), jcc('s1', '2099-03-08')], queue_entries: [g('e1', 1), g('e2', 2), g('e3', 3)] });
    const qw = writesTo(page, 'queue_entries');
    await page.evaluate(`showGroupEditModal('e1')`);
    await expect(page.locator('#ge-sess')).toBeVisible();
    await page.evaluate(`getQueue().find(e=>e.id==='e2').status='cancelled'`); // cancelled meanwhile, on another device
    await page.selectOption('#ge-sess', 's1');
    await page.evaluate('saveGroupEdit()');
    await expect.poll(() => qw.filter((x) => x.method === 'PATCH').length).toBe(2);
    expect(patchOf(qw, 'e1')[0]).toMatchObject({ session_id: 's1' });
    expect(patchOf(qw, 'e3')[0]).toMatchObject({ session_id: 's1' });
    expect(patchOf(qw, 'e2')).toEqual([]);
  });
});

test.describe('@staff:bookings rb1 registrations read (2026-10-05)', () => {
  test('a failed registrations read is not asked again on every paint', async ({ page }) => {
    const pm = jcc('pm1', '2099-03-04', { day: 'Wednesday', event_kind: 'community', ride_kind: 'petromin', needs_approval: false, paid_ride: true });
    await stubSupabase(page, { sessions: [jcc('s0', '2099-03-01'), pm], queue_entries: [bk('e1', 's0', '2099-03-01', 1)], bikes: [] });
    let reads = 0;
    await page.route(/\/rest\/v1\/rider_registrations/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback();
      reads++;
      return r.fulfill({ status: 500, headers: head, body: JSON.stringify({ message: 'boom' }) });
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';renderStaffQueue()`);
    await page.waitForTimeout(1500);
    for (let i = 0; i < 3; i++) await page.evaluate('renderStaffQueue()');
    await page.waitForTimeout(500);
    expect(reads).toBeLessThanOrEqual(1);
    expect(await page.evaluate('S.ridersLoaded')).toBeFalsy();
  });
});

test.describe('@staff:bookings rb1 booking move (2026-10-05)', () => {
  const sat = { id: 'sat1', day: 'Saturday', session_date: '2099-03-07', capacity: 20, spots: 20, status: 'open', created_at: 1,
    event_kind: 'community', ride_kind: 'saturday', needs_approval: true, paid_ride: false, bike_slots: '{"_time":"06:00 - 08:00"}' };
  async function move(page: Page, id: string, to: string) {
    await page.evaluate(`showBookingEditModal('${id}')`);
    await page.evaluate(`document.getElementById('be-sess').value='${to}';saveBookingEdit()`);
  }

  test('a free Saturday booking moved to a circuit night takes the night’s fare, and its own bike becomes Any', async ({ page }) => {
    await staff(page, { sessions: [sat, jcc('j1', '2099-03-08')],
      queue_entries: [bk('b1', 'sat1', '2099-03-07', 1, { type_preference: 'Own', price: 0, approval: 'approved', session_day: 'Saturday' })] });
    const qw = writesTo(page, 'queue_entries');
    await move(page, 'b1', 'j1');
    await expect.poll(() => patchOf(qw, 'b1').length).toBe(1);
    expect(patchOf(qw, 'b1')[0]).toMatchObject({ session_id: 'j1', type_preference: 'Any', price: 57.5 });
  });

  test('a Petromin employee’s fare does not follow them to a public night', async ({ page }) => {
    const pm = jcc('pm1', '2099-03-04', { day: 'Wednesday', event_kind: 'community', ride_kind: 'petromin', needs_approval: false, paid_ride: true });
    await staff(page, { sessions: [pm, jcc('j1', '2099-03-08')],
      queue_entries: [bk('p1', 'pm1', '2099-03-04', 1, { type_preference: 'Hybrid', price: 50, session_day: 'Wednesday' })],
      rider_registrations: [{ id: 7, session_id: 'pm1', source: 'petromin', name: 'Rider p1', matched_entry_id: 'p1', updated_at: '2099-03-01T10:00:00Z' }] });
    const qw = writesTo(page, 'queue_entries');
    await move(page, 'p1', 'j1');
    await expect.poll(() => patchOf(qw, 'p1').length).toBe(1);
    expect(patchOf(qw, 'p1')[0]).toMatchObject({ session_id: 'j1', price: 57.5 });
  });

  test('a price staff set by hand, and a promo code’s, stay with the booking on the new night', async ({ page }) => {
    await staff(page, { sessions: [jcc('j0', '2099-03-01'), jcc('j1', '2099-03-08')],
      queue_entries: [bk('h1', 'j0', '2099-03-01', 1, { price: 40 }), bk('c1', 'j0', '2099-03-01', 2, { price: 67.5, promo_code: 'TEN' })] });
    const qw = writesTo(page, 'queue_entries');
    await move(page, 'h1', 'j1');
    await expect.poll(() => patchOf(qw, 'h1').length).toBe(1);
    expect(patchOf(qw, 'h1')[0].session_id).toBe('j1');
    expect(patchOf(qw, 'h1')[0]).not.toHaveProperty('price');
    await page.waitForFunction('!S._beId');
    await move(page, 'c1', 'j1');
    await expect.poll(() => patchOf(qw, 'c1').length).toBe(1);
    expect(patchOf(qw, 'c1')[0]).not.toHaveProperty('price');
  });

  test('a paid move the server refuses (PAID_MOVE) is said in the desk’s words', async ({ page }) => {
    await staff(page, { sessions: [jcc('j0', '2099-03-01'), jcc('j1', '2099-03-08')], queue_entries: [bk('m1', 'j0', '2099-03-01', 1, { paid: true })] });
    await page.route(/\/rest\/v1\/queue_entries\?/, (r) => (r.request().method() === 'PATCH'
      ? r.fulfill({ status: 400, headers: head, body: JSON.stringify({ code: 'P0001', message: 'PAID_MOVE' }) })
      : r.fallback()));
    await move(page, 'm1', 'j1');
    await expect(page.locator('#err-bar-el')).toContainText('This booking is paid, and that ride has a different fare');
  });
});

test.describe('@staff:bookings rb1 account editor (2026-10-05)', () => {
  test('closing the editor while the save is on the wire still writes what it showed', async ({ page }) => {
    const customers = [{ id: 'c1', name: 'Huda Saleh', email: 'huda@example.test', phone: '+966550000009', created_at: '2026-06-10T09:00:00Z',
      profession: 'Engineer', workplace: 'Aramco', heard_from: 'instagram', type_preference: 'Road', height: 165, default_pay: 'house', hidden_types: 'Kids' }];
    await staff(page, { sessions: [jcc('s0', '2099-03-01')], customers });
    await page.waitForFunction('(S.customers||[]).length>0');
    // the duplicate-email check: slow, and nobody else has the address (the stub would answer every account)
    await page.route(/\/rest\/v1\/customers\?select=id&email/, async (r) => { await new Promise((ok) => setTimeout(ok, 700)); return r.fulfill({ status: 200, headers: head, body: '[]' }); });
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /\/rest\/v1\/customers\?/.test(r.url())) sent.push(r.postDataJSON()); });
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(page.locator('#cf-prof')).toHaveValue('Engineer');
    await page.fill('#cf-email', 'huda.new@example.test');                  // a changed email: the duplicate check goes out first
    await page.evaluate('saveCustForm();closeCustFormModal()');
    await expect.poll(() => sent.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ email: 'huda.new@example.test', default_pay: 'house', hidden_types: 'Kids', profession: 'Engineer', workplace: 'Aramco', heard_from: 'instagram' });
  });
});

test.describe('@staff:bookings rb1 walk-in retry (2026-10-05)', () => {
  for (const landed of [true, false]) {
    test(`Retry after a failed walk-in insert ${landed ? 'finds the party that landed and books nothing more' : 'books it when it never landed'}`, async ({ page }) => {
      await staff(page, { sessions: [jcc('s0', '2099-03-01')] });
      let posts = 0;
      const looked: string[] = [];
      await page.route(/\/rest\/v1\/queue_entries/, (r) => {
        const req = r.request();
        if (req.method() === 'POST') {
          posts++;
          if (posts === 1) return r.fulfill({ status: 503, headers: head, body: JSON.stringify({ code: 'PGRST000', message: 'no answer from the database' }) });
        }
        const u = decodeURIComponent(req.url());
        const m = req.method() === 'GET' && u.match(/select=id&id=in\.\(([^)]*)\)/);
        if (m) {
          looked.push(m[1]);
          const ids = m[1].split(',').map((x) => x.replace(/"/g, ''));
          return r.fulfill({ status: 200, headers: head, body: JSON.stringify(landed ? ids.map((id) => ({ id })) : []) });
        }
        return r.fallback();
      });
      await page.evaluate(`setStaffTab('queue');showWalkinModal()`);
      await page.locator('#walkin-modal #wi-name').fill('Tamer Walk');
      await page.evaluate('saveWalkin()');
      await expect(page.locator('#err-bar-el')).toBeVisible();
      expect(posts).toBe(1);
      await page.locator('#err-bar-el button', { hasText: 'Try again' }).click();
      await page.waitForFunction(`document.getElementById('walkin-modal').style.display==='none'`); // saved: the form closed
      expect(looked).toHaveLength(1);                                         // asked first
      expect(posts).toBe(landed ? 1 : 2);                                     // never a second copy of a landed party
    });
  }

  test('a later walk-in with the same name, after the form was closed, is booked', async ({ page }) => {
    await staff(page, { sessions: [jcc('s0', '2099-03-01')] });
    let posts = 0;
    await page.route(/\/rest\/v1\/queue_entries/, (r) => {
      if (r.request().method() === 'POST' && ++posts === 1) return r.fulfill({ status: 503, headers: head, body: JSON.stringify({ code: 'PGRST000', message: 'no answer from the database' }) });
      return r.fallback();
    });
    await page.evaluate(`setStaffTab('queue');showWalkinModal()`);
    await page.locator('#walkin-modal #wi-name').fill('Tamer Walk');
    await page.evaluate('saveWalkin()');
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await page.evaluate('closeErrorBar();closeWalkinModal();showWalkinModal()');
    await page.locator('#walkin-modal #wi-name').fill('Tamer Walk');
    await page.evaluate('saveWalkin()');
    await page.waitForFunction(`document.getElementById('walkin-modal').style.display==='none'`);
    expect(posts).toBe(2);
  });
});

test.describe('@staff:bookings rb1 roster (2026-10-05)', () => {
  test('Previous / Next walk the roster as drawn: a party’s riders together', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await staff(page, { sessions: [jcc('s0', '2099-03-01')], queue_entries: [
      bk('e1', 's0', '2099-03-01', 1, { name: 'Ali Party', group_id: 'g1' }),
      bk('e2', 's0', '2099-03-01', 2, { name: 'Badr Solo' }),
      bk('e3', 's0', '2099-03-01', 3, { name: 'Zed Party', group_id: 'g1' }),
    ] });
    await page.evaluate(`setStaffTab('queue');setSfSession('s0');S.sfSort='name';S.sfSortDir=1;renderStaffQueue()`);
    expect(await page.evaluate('S._qOrder')).toEqual(['e1', 'e3', 'e2']);
    await page.evaluate(`showCheckinModal('e1')`);
    await expect(page.locator('#checkin-modal .ci-chain .ci-next')).toContainText('Zed');
  });

  test('Enter on a booking number counts the ride picked, and opens the one rider expected there', async ({ page }) => {
    const r1 = jcc('t1', today), r2 = jcc('t2', dayOff(1));
    await staff(page, { sessions: [r1, r2], queue_entries: [bk('a5', 't1', today, 5), bk('b5', 't2', dayOff(1), 5), bk('c5', 't1', today, 6, { status: 'done' })] });
    await page.evaluate(`setStaffTab('queue');setSfSession('t1')`);
    await page.evaluate(`S.sfSearch='5';sfSearchEnter()`);
    await expect.poll(() => page.evaluate('S._ciId')).toBe('a5');
  });

  test('with every ride showing, a booking number on two rides opens nothing', async ({ page }) => {
    const r1 = jcc('t1', today), r2 = jcc('t2', dayOff(1));
    await staff(page, { sessions: [r1, r2], queue_entries: [bk('a5', 't1', today, 5), bk('b5', 't2', dayOff(1), 5)] });
    await page.evaluate(`setStaffTab('queue');setSfSession('all');renderStaffQueue()`);
    await page.evaluate(`S.sfSearch='5';sfSearchEnter()`);
    await page.waitForTimeout(300);
    expect(await page.evaluate('S._ciId||null')).toBeNull();
  });

  test('Front Desk is not shown a Saturday ride’s cancellations', async ({ page }) => {
    const sat = { id: 'sat1', day: 'Saturday', session_date: dayOff(2), capacity: 20, spots: 20, status: 'open', created_at: 1,
      event_kind: 'community', ride_kind: 'saturday', needs_approval: true, paid_ride: false, bike_slots: '{"_time":"06:00 - 08:00"}' };
    const now = new Date().toISOString();
    await staff(page, { sessions: [sat, jcc('t1', today)], queue_entries: [
      bk('x1', 'sat1', dayOff(2), 1, { status: 'cancelled', cancelled_at: now, approval: 'approved' }),
      bk('x2', 't1', today, 1, { status: 'cancelled', cancelled_at: now }),
    ] });
    await page.evaluate(`S.sfSession='all'`);
    expect((await page.evaluate('_cxRecent().map(e=>e.id)') as string[]).sort()).toEqual(['x1', 'x2']); // admin
    await page.evaluate(`S.staffRole='frontdesk'`);
    expect(await page.evaluate('_cxRecent().map(e=>e.id)')).toEqual(['x2']);
  });

  test('“vs last week” on a Petromin night leaves out last week’s registered riders too', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    const pw = (id: string, date: string) => jcc(id, date, { day: 'Wednesday', event_kind: 'community', ride_kind: 'petromin', needs_approval: false, paid_ride: true });
    const W1 = '2099-03-11', W0 = '2099-03-04';
    const q = [bk('n1', 'pw1', W1, 1), bk('n2', 'pw1', W1, 2), bk('n3', 'pw1', W1, 3),
      bk('l1', 'pw0', W0, 1), bk('l2', 'pw0', W0, 2), bk('l3', 'pw0', W0, 3), bk('l4', 'pw0', W0, 4), bk('l5', 'pw0', W0, 5)];
    const reg = (id: number, sid: string, e: string) => ({ id, session_id: sid, source: 'petromin', name: 'Rider ' + e, matched_entry_id: e, updated_at: '2099-03-01T10:00:00Z' });
    await staff(page, { sessions: [pw('pw0', W0), pw('pw1', W1)], queue_entries: q,
      rider_registrations: [reg(1, 'pw1', 'n3'), reg(2, 'pw0', 'l3'), reg(3, 'pw0', 'l4'), reg(4, 'pw0', 'l5')] });
    await page.evaluate(`setStaffTab('queue');setSfSession('pw1')`);
    await page.waitForFunction('S.ridersLoaded===true');
    await page.evaluate('renderStaffQueue()');
    const first = page.locator('#tab-queue .stat-strip .stat-chip').first();
    await expect(first).toContainText('2');                                // this week: two riders on the roster
    await expect(first.locator('.stat-delta')).toHaveText('0');             // last week: two as well, not five
  });

  test('bulk Paid and its Undo read back only the rows they touched', async ({ page }) => {
    await staff(page, { sessions: [jcc('s0', '2099-03-01')], queue_entries: [bk('e1', 's0', '2099-03-01', 1), bk('e2', 's0', '2099-03-01', 2), bk('e3', 's0', '2099-03-01', 3)] });
    const reads: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/queue_entries')) reads.push(decodeURIComponent(r.url())); });
    await page.evaluate(`window.__ld=0;const _o=loadData;window.loadData=function(){window.__ld++;return _o.apply(this,arguments);}`);
    await page.evaluate(`setStaffTab('queue');setSfSession('s0');S.sfSelected=['e1','e2'];bulkSfPaid()`);
    await expect.poll(() => reads.some((u) => /id=in\.\(.*e1.*e2.*\)|id=in\.\(.*e2.*e1.*\)/.test(u))).toBe(true);
    await page.waitForFunction('S.undoStack.length>0');
    await page.evaluate('doUndo()');
    await expect.poll(() => reads.filter((u) => /id=in\./.test(u)).length).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate('window.__ld')).toBe(0);
  });

  test('the roster’s sort headers are buttons, and the header says the order', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await staff(page, { sessions: [jcc('s0', '2099-03-01')], queue_entries: [bk('e1', 's0', '2099-03-01', 1, { name: 'Zed' }), bk('e2', 's0', '2099-03-01', 2, { name: 'Ali' })] });
    await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
    const table = page.locator('#tab-queue table.queue-table');
    await expect(table).toHaveAttribute('data-nosort', '');
    const btn = table.locator('thead th button.q-sort-btn', { hasText: 'Rider' });
    await expect(btn).toBeVisible();
    await expect(table.locator('thead th[data-on-click]')).toHaveCount(0);
    await btn.click();
    await expect(table.locator('thead th', { has: page.locator('button.q-sort-btn', { hasText: 'Rider' }) })).toHaveAttribute('aria-sort', 'ascending');
    expect(await page.evaluate('S.sfSort')).toBe('name');
    await expect(table.locator('thead th.th-sort')).toHaveCount(0);         // the page's own table sorter keeps off it
    await table.locator('thead th button.q-sort-btn', { hasText: 'Rider' }).focus();
    await page.keyboard.press('Enter');
    await expect(table.locator('thead th', { has: page.locator('button.q-sort-btn', { hasText: 'Rider' }) })).toHaveAttribute('aria-sort', 'descending');
  });
});
