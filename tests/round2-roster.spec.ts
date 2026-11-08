import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, staffReady, type FailWrite } from './helpers/supabase';

// The Bookings roster, round two (the user's picks on the round-two page, 2026-11-08: s_bookings, s_dialog_speed,
// d_bulk = in place, d_undo = row). One action per row and a ⋯ menu; the select box in a column of its own; two lines
// a booking; the event's mark beside the number; the number the desk acts on first; the selection's actions in the
// filter row's place, never a bar at the foot; Undo on the row for 10 s after a check-in, for every staff member; a
// row that answers at once and, refused, goes back and says why on itself rather than on a bar.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24', RUN = '2026-09-26';
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOf = (d: string) => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
const sess = (d: string, o: Record<string, unknown> = {}) => ({ id: d, day: dayOf(d), session_date: d, capacity: 40, status: 'open', location: 'JCC', bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }), created_at: 1, ...o });
const sessions = [sess(TODAY), sess(RUN, { event_kind: 'community', ride_kind: 'runher', spots: 20, bike_slots: JSON.stringify({ _time: '06:00 - 08:00' }) })];
const q = (id: string, n: number, o: Record<string, unknown> = {}) => ({
  id, session_id: TODAY, session_day: dayOf(TODAY), session_date: TODAY, queue_num: n, name: 'Rider ' + n, status: 'waiting', paid: false,
  price: 80, type_preference: 'Hybrid', size: 'M', height: 172, phone: '05500000' + String(n).padStart(2, '0'), registered_at: '2026-09-15T10:00:00Z', ...o,
});
const G = { group_id: 'g1', group_name: 'Two Friends' };
const queue_entries = [
  q('w1', 1, { name: 'Wafa Waiting', walk_in: true, addons: JSON.stringify([{ id: 'i1', qty: 2 }]) }),
  q('w2', 2, { name: 'Walid Paid', paid: true, desk_note: 'Bring the blue helmet from the van, the one with the long strap' }),
  q('r1', 3, { name: 'Rana Reserved', reserved: true, reserved_bike_no: '12' }),
  q('a1', 4, { name: 'Adel Onbike', status: 'active', paid: true, checked_in_at: '2026-09-24T17:00:00Z' }),
  q('d1', 5, { name: 'Dina Done', status: 'done', paid: true, ride_duration: 60 }),
  q('n1', 6, { name: 'Nour Noshow', status: 'noshow' }),
  q('c1', 7, { name: 'Camil Cancelled', status: 'cancelled', cancelled_by: 'customer' }),
  q('l1', 8, { name: 'Lina Waitlist', status: 'waitlist', waitlist_num: 1 }),
  q('p1', 9, { ...G, name: 'Party One' }),
  q('p2', 10, { ...G, name: 'Party Two' }),
  q('x1', 1, { session_id: RUN, session_day: dayOf(RUN), session_date: RUN, name: 'Runner Rida', approval: 'approved', price: 0 }),
];
const inventory = [{ id: 'i1', name: 'Water', category: 'Drinks', qty: 30, price: 5, addon: true }];

async function open(page: Page, o: { width?: number; fail?: FailWrite; rpc?: Record<string, unknown> } = {}) {
  await page.setViewportSize({ width: o.width || 1280, height: 900 });
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, queue_entries, inventory, ...(o.rpc || {}) }, o.fail);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await staffReady(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${TODAY}';S._sfPicked=true;S.sfStatus='all';S.sfSearch='';S.sfSelected=[];S.sfShowFinished=true;renderStaffQueue()`); // finished riders unfolded
  await expect(page.locator('#q-results [data-id="w1"]').first()).toBeVisible();
}
const row = (page: Page, id: string) => page.locator(`#q-results .queue-table tbody tr[data-id="${id}"]`);
const patches = (page: Page, id: string) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r: Request) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries') && r.url().includes(`id=eq.${id}`)) out.push(r.postDataJSON() as Record<string, unknown>);
  });
  return out;
};

test.describe('@staff:bookings round two roster', () => {
  test('one action per row for its state, ⋯ for the rest, each named with its booking; the select box has a column of its own', async ({ page }) => {
    await open(page);
    const want: Record<string, string> = { w1: 'Check In', r1: 'Give bike', a1: 'Return Bike', d1: 'Re-open', n1: 'Customer Showed', l1: 'Check In', p1: 'Check in (2)' };
    for (const [id, label] of Object.entries(want)) {
      const slot = row(page, id).locator('td.rq-mng');
      await expect(slot.locator('.rq-act'), id).toHaveCount(1);
      await expect(slot.locator('.rq-act'), id).toHaveText(label);
      await expect(slot.locator('.rq-act'), id).toHaveAttribute('aria-label', new RegExp(`^${label.replace(/[()]/g, '\\$&')} · #\\d+ `));
      await expect(slot.locator('.rq-more'), id).toHaveCount(1);
      await expect(slot.locator('.rq-more'), id).toHaveAttribute('aria-label', /^More actions · #\d+ /);
      await expect(slot.locator('input[type="checkbox"]'), id).toHaveCount(0); // no box among the actions any more
    }
    // the box leads the row (waiting and on a bike), and a party's folded row has none
    await expect(row(page, 'w1').locator('td').first()).toHaveClass(/rq-sel/);
    await expect(row(page, 'w1').locator('td.rq-sel input[type="checkbox"]')).toHaveAttribute('aria-label', /Select booking #1 Wafa Waiting/);
    await expect(row(page, 'a1').locator('td.rq-sel input[type="checkbox"]')).toHaveCount(1);
    await expect(row(page, 'p1').locator('td.rq-sel input')).toHaveCount(0);
    // a cancelled booking: Restore
    await page.evaluate(`S.sfStatus='cancelled';renderStaffQueue()`);
    await expect(row(page, 'c1').locator('td.rq-mng .rq-act')).toHaveText('Restore');
    // every other action is still in the ⋯ menu: No-show, Edit, Cancel... for a waiting rider
    expect(await page.evaluate(`(S._rowMenus['w1']||[]).map(i=>i.run.split('(')[0])`)).toEqual(expect.arrayContaining(['confirmNoShow', 'showBookingEditModal', 'staffCancelEntry']));
  });

  test('two lines a booking at 1280: no single booking grows past them, and the table stays in its box', async ({ page }) => {
    await open(page);
    const m = await page.evaluate(() => {
      const w = document.querySelector('#q-results .queue-table-desktop-wrap') as HTMLElement;
      const rows = [...document.querySelectorAll('#q-results .queue-table tbody tr[data-id]:not(.party-row)')].map((tr) => [tr.getAttribute('data-id'), Math.round(tr.getBoundingClientRect().height)]);
      return { rows, over: (w.querySelector('table') as HTMLElement).getBoundingClientRect().width - w.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
    });
    for (const [id, h] of m.rows) expect(h as number, String(id)).toBeLessThan(80); // add-ons, a walk-in tag and a long desk note included
    expect(m.over).toBeLessThanOrEqual(1);
    expect(m.page).toBeLessThanOrEqual(0);
    // the price at its cell's end in tabular figures
    expect(await row(page, 'w1').locator('td.rq-price').evaluate((td) => [getComputedStyle(td).textAlign, getComputedStyle(td).fontVariantNumeric])).toEqual(['end', 'tabular-nums']);
  });

  test('a long name shows whole beside a member\'s mark and "3/5 no-shows", and the table still fits a 1280 laptop', async ({ page }) => {
    // the name gave way to its marks and the cell's 15em cap held the column narrow: "Firyal K…" (the user, 2026-11-08)
    const PAST = '2026-09-17';
    const past = (id: string, status: string) => q(id, 1, { session_id: PAST, session_day: dayOf(PAST), session_date: PAST, customer_id: 'cf', status });
    for (const width of [1280, 1440]) {
      await open(page, { width, rpc: {
        sessions: [...sessions, sess(PAST)],
        queue_entries: [...queue_entries, q('f1', 11, { name: 'Firyal Kamal Al Harbi Abdulrahman', customer_id: 'cf' }),
          past('h1', 'noshow'), past('h2', 'noshow'), past('h3', 'noshow'), past('h4', 'done'), past('h5', 'done')],
        tags: [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false }],
        customer_tags: [{ customer_id: 'cf', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 }],
      } });
      const f1 = row(page, 'f1');
      await expect(f1.locator('.rq-rider .cm-mk')).toBeVisible();
      await expect(f1.locator('.rq-rider .rq-nsflag')).toHaveText('3/5 no-shows');
      const m = await f1.evaluate((tr) => {
        const nm = tr.querySelector('.rq-nm') as HTMLElement, td = nm.closest('td') as HTMLElement, w = tr.closest('.queue-table-desktop-wrap') as HTMLElement;
        const marks = [...td.querySelectorAll('.rq-rn > :not(.rq-nm)')].map((x) => x.getBoundingClientRect());
        return { cut: nm.scrollWidth - nm.clientWidth, inCell: marks.every((r) => r.right <= td.getBoundingClientRect().right + 0.5),
          oneLine: marks.every((r) => Math.abs(r.top - marks[0].top) < 2 && Math.abs(r.top - nm.getBoundingClientRect().top) < 8),
          over: (w.querySelector('table') as HTMLElement).getBoundingClientRect().width - w.clientWidth };
      });
      expect(m.cut, `${width}: the name is cut`).toBe(0);
      expect(m.inCell, `${width}: a mark spills out of the Rider cell`).toBe(true);
      expect(m.over, `${width}: the table is wider than its box`).toBeLessThanOrEqual(1);
      if (width === 1440) expect(m.oneLine, 'room for the name and its marks on one line').toBe(true); // at 1280 they may step under it
    }
  });

  test('the number the desk acts on leads the figures bar, larger', async ({ page }) => {
    await open(page);
    const first = page.locator('#q-live-count .q-lc-btn').first();
    await expect(first).toHaveClass(/q-lc-waiting/);
    await expect(first).toHaveClass(/q-lc-big/);
    const [big, next] = await page.locator('#q-live-count .q-lc-btn .num').evaluateAll((b) => b.slice(0, 2).map((x) => parseFloat(getComputedStyle(x).fontSize)));
    expect(big).toBeGreaterThan(next + 4);
  });

  test('ticked rows put their actions in the filter row\'s place, sticky, with no bar at the foot', async ({ page }) => {
    await open(page);
    await row(page, 'w1').locator('td.rq-sel input').check();
    await row(page, 'w2').locator('td.rq-sel input').check();
    const bar = page.locator('#tab-queue > #q-bulk');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('role', 'toolbar');
    await expect(bar.locator('.rq-bulkn')).toHaveText('2 selected');
    for (const b of ['Check in', 'Mark paid', 'No-Show (2)', 'Clear']) await expect(bar.getByRole('button', { name: b })).toBeVisible();
    await expect(page.locator('#tab-queue .filter-bar')).toHaveCount(0); // in its place
    expect(await bar.evaluate((e) => getComputedStyle(e).position)).toBe('sticky');
    await expect(page.locator('#tab-queue .rq-bulk')).toHaveCount(0); // the old bottom bar
    expect(await page.evaluate(`document.body.classList.contains('q-bulk')`)).toBe(false);
    // nothing new fixed at the foot of the screen
    expect(await page.evaluate(() => [...document.querySelectorAll('#tab-queue *')].filter((e) => getComputedStyle(e).position === 'fixed' && !(e as HTMLElement).closest('.fab-row')).length)).toBe(0);
    // the header's box reads mixed, and selects every rider shown
    expect(await page.locator('#q-results .rq-selall').evaluate((i) => (i as HTMLInputElement).indeterminate)).toBe(true);
    await bar.getByRole('button', { name: 'Clear' }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.locator('#tab-queue .filter-bar #sf-search-input')).toBeVisible();
  });

  test('a check-in leaves Undo on its row for 10 s, for any staff member, and Undo puts the booking back as it was', async ({ page }) => {
    await open(page);
    const sent = patches(page, 'w1');
    await page.evaluate(`showCheckinModal('w1')`);
    await page.locator('#ci-confirm').click();
    const slot = row(page, 'w1').locator('td.rq-mng');
    await expect(slot.locator('.rq-undo')).toBeVisible();
    await expect(slot.locator('.rq-undo')).toHaveAttribute('aria-label', /^Undo Check-in · #1 Wafa Waiting/);
    expect(await page.evaluate(`S.view==='staff'&&_ruMap.get('w1').until-Date.now()`)).toBeGreaterThan(9000);
    expect(await page.evaluate('RU_MS')).toBe(10000);
    await slot.locator('.rq-undo').click();
    await expect(slot.locator('.rq-undo')).toHaveCount(0);
    // back to waiting with no bike, no arrival, and the payment the check-in recorded taken back (the stub keeps no PATCH,
    // so what was sent is the proof; a re-read answers the stub's check-in again)
    await expect.poll(() => sent.find((b) => b.status === 'waiting')).toMatchObject({ status: 'waiting', assigned_bike_id: null, paid: false });
    await expect.poll(() => sent.some((b) => 'checked_in_at' in b && b.checked_in_at === null)).toBe(true);
    // the check-in's line in the log is spent: the topbar's Undo cannot take it back a second time
    await expect.poll(() => page.evaluate(`S.actionLog.filter(l=>/^Check In: #1 /.test(l.label)).every(l=>l.undone)`)).toBe(true);
    // another check-in's Undo goes after 10 s: its slot holds Return Bike again
    const slot2 = row(page, 'w2').locator('td.rq-mng');
    await page.evaluate(`showCheckinModal('w2')`);
    await page.locator('#ci-confirm').click();
    await expect(slot2.locator('.rq-undo')).toBeVisible();
    await page.evaluate(`_ruMap.forEach(v=>{v.until=Date.now()-1});_rowTimer()`);
    await expect(slot2.locator('.rq-act')).toHaveText('Return Bike');
  });

  test('a desk tap paints its row at once; refused, the row goes back and says why on itself, not on a bar', async ({ page }) => {
    await open(page);
    // the pay pill: the write held back a moment, then refused
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    await page.route(/\/rest\/v1\/queue_entries\?.*id=eq\.w1/, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      await held;
      await route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'P0001', message: 'Payment refused by the till' }) });
    });
    await page.evaluate(`void togglePayment('w1','card')`); // not awaited: the write is held back
    await expect(row(page, 'w1').locator('.pay-toggle')).toHaveClass(/paid/); // at once
    await expect(row(page, 'w1')).toHaveClass(/rq-pend/);
    release();
    await expect(row(page, 'w1').locator('.pay-toggle')).toHaveClass(/pending/); // back as it was
    await expect(row(page, 'w1')).not.toHaveClass(/rq-pend/);
    await expect(row(page, 'w1').locator('.rq-err')).toContainText('Payment refused by the till');
    await expect(page.locator('#err-bar-el')).toBeHidden();
  });

  test('a refused check-in from the selection and a refused no-show go back on their rows, said there', async ({ page }) => {
    await open(page, { rpc: { 'rpc:staff_checkin': { __rpcError: { status: 400, code: 'P0001', message: 'BAD_BOOKING_STATE: #2 is cancelled, not waiting' } } }, fail: { table: 'queue_entries', methods: ['PATCH'], status: 400, code: 'P0001', message: 'No-show refused' } });
    await page.evaluate(`S.sfSelected=['w2'];renderStaffQueue()`);
    await page.locator('#q-bulk').getByRole('button', { name: 'Check in' }).click();
    await expect(row(page, 'w2').locator('.status-badge')).toHaveClass(/st-waiting/);
    await expect(row(page, 'w2').locator('.rq-err')).toBeVisible();
    await page.evaluate(`doNoShow('w1')`);
    await expect(row(page, 'w1').locator('.status-badge')).toHaveClass(/st-waiting/);
    await expect(row(page, 'w1').locator('.rq-err')).toContainText('No-show refused');
    await expect(page.locator('#err-bar-el')).toBeHidden();
  });

  test('the session\'s event colour is a small mark beside the number, most of use on All sessions', async ({ page }) => {
    await open(page);
    await page.evaluate(`S.sfSession='all';renderStaffQueue()`);
    const jcc = row(page, 'w1').locator('td.rq-numc .rq-ev');
    const run = row(page, 'x1').locator('td.rq-numc .rq-ev');
    await expect(jcc).toHaveClass(/rq-ev-jcc/);
    await expect(run).toHaveClass(/rq-ev-runher/);
    const [a, b] = await Promise.all([jcc, run].map((l) => l.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, rowH: (e.closest('tr') as HTMLElement).getBoundingClientRect().height }))));
    expect(a.bg).not.toBe(b.bg);
    for (const m of [a, b]) { expect(m.w).toBeLessThanOrEqual(10); expect(m.h).toBeLessThan(m.rowH / 2); } // a mark, not a band
  });
});

test.describe('@staff:bookings round two roster on a phone', () => {
  test('a card holds its select box in the corner and one action beside ⋯ on one row', async ({ page }) => {
    await open(page, { width: 390 });
    const card = page.locator('#q-results .q-card[data-id="w1"]');
    await expect(card.locator('.rq-ch .rq-cchk input[type="checkbox"]')).toHaveCount(1);
    const acts = card.locator('.rq-acts');
    await expect(acts.locator('.rq-act')).toHaveCount(1);
    await expect(acts.locator('.rq-more')).toHaveCount(1);
    const [p, m] = await Promise.all([acts.locator('.rq-act'), acts.locator('.rq-more')].map((l) => l.evaluate((e) => e.getBoundingClientRect().top)));
    expect(Math.abs(p - m)).toBeLessThan(2);
    expect(await acts.locator('.rq-act').evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(43.5);
  });
});
