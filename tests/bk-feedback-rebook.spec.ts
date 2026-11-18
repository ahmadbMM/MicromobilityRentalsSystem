import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, stubRealtime, unlockStaff, waitForSb } from './helpers/supabase';

// Last feedback at check-in and Book next week (the user, 2026-11-18, items 3 and 4 of the proposed Bookings features).
// The check-in drawer shows the rider's last rating (scores, tags, reasons, comment) and the incidents of their last ride when
// there is something to act on, and nothing otherwise. A booking's ⋯ menu books the same party into the next session of the
// same kind (the walk-in form, prefilled, with every guard of a desk add); the First-timers pop-up marks tonight's first
// riders Booked again or offers Book next week; the close-night list asks whether tonight's first-timers were asked about
// next week. No migration. Invented riders only; the clock is fixed on the night so it is always "today".

const DAY = '2099-05-05';
const PAST = '2099-04-28';
const NEXT = '2099-05-12';
const NOW = new Date(`${DAY}T20:00:00+03:00`);
const slots = JSON.stringify({ _total: 20, _time: '20:00 - 22:00' });
const sess = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Tuesday', session_date: date, capacity: 20, status: 'open', created_at: 1, bike_slots: slots, ...extra,
});
const sessions = [sess('p0', PAST, { status: 'closed' }), sess('s0', DAY), sess('s1', NEXT)];
const row = (id: string, sid: string, date: string, qn: number, name: string, status: string, cid: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: sid, session_day: 'Tuesday', session_date: date, queue_num: qn, name, phone: '0500000000', customer_id: cid, group_id: null,
  status, paid: true, price: 75, walk_in: !cid, registered_at: `${date}T15:00:00Z`, height: 175, type_preference: 'Road', ...extra,
});
const id = (n: number) => `aaaa${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;
const [A, A2, B, C, D, F1, F2, W, PA, PB, PD, F1N, BN] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(id);
const customers = [
  { id: 'cust-amal', name: 'Amal Road', phone: '0500000011', height: 175, created_at: '2099-01-01T00:00:00Z' },
  { id: 'cust-badr', name: 'Badr Top', phone: '0500000012', created_at: '2099-01-01T00:00:00Z' },
  { id: 'cust-dina', name: 'Dina Fall', phone: '0500000013', created_at: '2099-01-01T00:00:00Z' },
  { id: 'cust-farah', name: 'Farah First', phone: '0500000014', created_at: '2099-01-01T00:00:00Z' },
  { id: 'cust-ghada', name: 'Ghada First', phone: '0500000015', created_at: '2099-01-01T00:00:00Z' },
  { id: 'cust-wafa', name: 'Wafa List', phone: '0500000016', created_at: '2099-01-01T00:00:00Z' },
];
const rows = [
  // tonight
  row(A, 's0', DAY, 1, 'Amal Road', 'waiting', 'cust-amal'),
  row(A2, 's0', DAY, 2, 'Sami Road', 'waiting', 'cust-amal', { height: 150, type_preference: 'Own' }), // a type the next night does not offer
  row(B, 's0', DAY, 3, 'Badr Top', 'waiting', 'cust-badr'),
  row(C, 's0', DAY, 4, 'Walk Up', 'waiting', null),
  row(D, 's0', DAY, 5, 'Dina Fall', 'waiting', 'cust-dina'),
  row(F1, 's0', DAY, 6, 'Farah First', 'done', 'cust-farah'),
  row(F2, 's0', DAY, 7, 'Ghada First', 'done', 'cust-ghada'),
  row(W, 's0', DAY, 8, 'Wafa List', 'waitlist', 'cust-wafa'),
  // last week: Amal said the seat was low, Badr gave ten and ten, Dina fell (no rating)
  row(PA, 'p0', PAST, 1, 'Amal Road', 'done', 'cust-amal', { rating_bike: 6, rating_exp: 9, feedback: 'Great night', rated_at: `${PAST}T21:00:00Z`,
    rating_detail: { form: 'rental', s: { service: 9, bike: 6 }, why: { bike: 'Seat too low' } } }),
  row(PB, 'p0', PAST, 2, 'Badr Top', 'done', 'cust-badr', { rating_bike: 10, rating_exp: 10, rated_at: `${PAST}T21:00:00Z`,
    rating_detail: { form: 'rental', s: { service: 10, bike: 10 }, why: {} } }),
  row(PD, 'p0', PAST, 3, 'Dina Fall', 'done', 'cust-dina'),
  // next week: Farah and Badr have booked again
  row(F1N, 's1', NEXT, 1, 'Farah First', 'waiting', 'cust-farah'),
  row(BN, 's1', NEXT, 2, 'Badr Top', 'waiting', 'cust-badr'),
];
const incidents = [{ id: 7, booking_id: PD, session_id: 'p0', customer_id: 'cust-dina', rider_name: 'Dina Fall', kind: 'fall', note: 'Slipped at the turn',
  happened_at: `${PAST}T18:30:00Z`, created_at: `${PAST}T18:40:00Z`, author_name: 'Sara' }];
const head = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { queue_entries: rows, sessions, bikes: [], customers, booking_incidents: incidents, till_sessions: [], till_counts: [], ...extra });
  await stubRealtime(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
  await page.waitForFunction(`typeof _bnwItem==='function'&&typeof _lfbBox==='function'`); // the desk part is in
}
const menu = (page: Page, bid: string) => page.evaluate(`(_entryActions0(_qGet('${bid}')),(S._rowMenus['${bid}']||[]).map(i=>i.label.replace(/<[^>]+>/g,'').trim()))`) as Promise<string[]>;
const drawer = (page: Page) => page.locator('#checkin-modal [role="dialog"]');

test.describe('@staff:bookings last feedback at check-in and Book next week', () => {
  test('the drawer shows the last ride\'s feedback when there is something to act on, and nothing for a top rating', async ({ page }) => {
    await boot(page);
    await page.evaluate(`showCheckinModal('${A}')`);
    const box = drawer(page).locator('.lfb');
    await expect(box).toBeVisible();
    await expect(box).toContainText('Last ride');
    await expect(box).toContainText('Bike 6/10');
    await expect(box).toContainText('Service 9/10');
    await expect(box).toContainText('Seat too low');                       // the reason the rider gave for the bike's 6
    await expect(box).toContainText('Great night');                        // the comment
    await expect(box).not.toHaveClass(/lfb-bad/);                          // calm: no low score, no incident
    // the guest on Amal's account is not Amal: the account's rating is shown on the account's own rider only
    await page.evaluate(`closeCheckinModal();showCheckinModal('${A2}')`);
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).locator('.lfb')).toHaveCount(0);
    // ten and ten with no comment: nothing to act on, nothing drawn
    await page.evaluate(`closeCheckinModal();showCheckinModal('${B}')`);
    await expect(drawer(page)).toContainText('Badr Top');
    await expect(drawer(page).locator('.lfb')).toHaveCount(0);
    // no account: nothing
    await page.evaluate(`closeCheckinModal();showCheckinModal('${C}')`);
    await expect(drawer(page)).toContainText('Walk Up');
    await expect(drawer(page).locator('.lfb')).toHaveCount(0);
    // an incident on the last ride: shown, in red, once the account's incidents are read
    await page.evaluate(`closeCheckinModal();showCheckinModal('${D}')`);
    const bad = drawer(page).locator('.lfb.lfb-bad');
    await expect(bad).toBeVisible();
    await expect(bad).toContainText('Fall');
    await expect(bad).toContainText('Slipped at the turn');
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0);
  });

  test('a low score is said in red on the Saturday drawer too', async ({ page }) => {
    const sat = (id: string, date: string) => sess(id, date, { event_kind: 'community', needs_approval: true });
    const sr = (id: string, sid: string, date: string, st: string, x: Record<string, unknown> = {}) => row(id, sid, date, 1, 'Amal Road', st, 'cust-amal', { approval: 'approved', price: 0, ...x });
    await boot(page, {
      sessions: [sat('sp', PAST), sat('s0', DAY)],
      queue_entries: [sr(A, 's0', DAY, 'waiting'), sr(PA, 'sp', PAST, 'done', { rating_bike: 2, rating_exp: 7, rated_at: `${PAST}T21:00:00Z`,
        rating_detail: { form: 'social', s: { ride: 7, ride_bike: 2, overall: 7 }, why: { ride_bike: 'Brakes squeaked' } } })],
      booking_incidents: [],
    });
    await page.evaluate(`showCheckinModal('${A}')`);
    const box = page.locator('#checkin-modal .ci-sat .lfb');
    await expect(box).toBeVisible();
    await expect(box).toHaveClass(/lfb-bad/);
    await expect(box).toContainText('Bike 2/10');
    await expect(box).toContainText('Brakes squeaked');
  });

  test('Book next week is a Booking tile on waiting, on-bike and done bookings with an account, only while the next night of the kind takes them', async ({ page }) => {
    await boot(page);
    const lbl = 'Book next week · ' + await page.evaluate(`shortDate('${NEXT}')`);
    expect(await menu(page, A)).toContain(lbl);
    expect(await page.evaluate(`S._rowMenus['${A}'].find(i=>/^_bnwOpen\\(/.test(i.run)).g`)).toBe('bk');
    expect(await menu(page, F2)).toContain(lbl);                         // done
    await page.evaluate(`_qGet('${D}').status='active'`);
    expect(await menu(page, D)).toContain(lbl);                          // on a bike
    expect(await menu(page, B)).not.toContain(lbl);                      // already holds the next night
    expect(await menu(page, C)).not.toContain(lbl);                      // no account
    expect(await menu(page, W)).not.toContain(lbl);                      // waitlisted
    // Amal's party (two riders on one account) folded into one row or card: its own menu has the tile too
    await page.evaluate(`renderStaffQueue()`);
    const party = await page.evaluate(`Object.entries(S._rowMenus).filter(([k])=>/^party(card)?:/.test(k)&&k.endsWith('${A}')).map(([,v])=>v.some(i=>/^_bnwOpen\\('${A}'\\)/.test(i.run)))`) as boolean[];
    expect(party.length).toBeGreaterThan(0);
    expect(party.every(Boolean)).toBe(true);
    // the next night closed, more than 14 days away, or a one-off event: no tile
    const without = async (js: string) => { await page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='s1'?Object.assign({},s,${js}):s)`); return menu(page, A); };
    expect((await without(`{status:'closed'}`)).some((l) => l.startsWith('Book next week'))).toBe(false);
    expect((await without(`{status:'open',session_date:'2099-05-25'}`)).some((l) => l.startsWith('Book next week'))).toBe(false);
    expect((await without(`{session_date:'${NEXT}'}`)).some((l) => l.startsWith('Book next week'))).toBe(true);
    await page.evaluate(`S.sessions=S.sessions.map(s=>Object.assign({},s,{event_kind:'community',ride_kind:'event'}))`);
    expect((await menu(page, A)).some((l) => l.startsWith('Book next week'))).toBe(false);
  });

  test('the tile opens the walk-in form on the next night with the party, their heights and types; Book adds them there', async ({ page }) => {
    await boot(page);
    await page.evaluate(`_entryActions0(_qGet('${A}'));S._rowMenus['${A}'].find(i=>/^_bnwOpen\\(/.test(i.run)).act()`);
    const f = page.locator('#walkin-modal [role="dialog"]');
    await expect(f).toBeVisible();
    await expect(f.locator('.modal-title')).toHaveText('Book next week');
    await expect(f.locator('#wi-sess')).toHaveValue('s1');
    await expect(f.locator('#wi-name')).toHaveValue('Amal Road');
    await expect(f.locator('#wi-phone')).toHaveValue('0500000000');
    await expect(f.locator('#wi-height')).toHaveValue('175');
    await expect(f.locator('[data-wi-type="Road"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(f.locator('#wi-r-name-0')).toHaveValue('Sami Road');
    await expect(f.locator('#wi-r-h-0')).toHaveValue('150');
    await expect(f.locator('#wi-r-type-0')).toHaveValue('Any');             // Own is not offered on the next night: Any, as the editor's move
    await expect(f.locator('#wi-pay-lbl')).toHaveCount(0);                 // no payment, no check-in: a booking for another night
    await expect(f.getByRole('button', { name: /Check In|Add & check in/ })).toHaveCount(0);
    const post = page.waitForRequest((r) => r.method() === 'POST' && /\/rest\/v1\/queue_entries/.test(r.url()));
    await f.getByRole('button', { name: 'Book (2)' }).click();
    const sent = (await post).postDataJSON() as Record<string, unknown>[];
    expect(sent.map((x) => [x.session_id, x.name, x.customer_id, x.status, x.type_preference, x.height])).toEqual([
      ['s1', 'Amal Road', 'cust-amal', 'waiting', 'Road', 175],
      ['s1', 'Sami Road', null, 'waiting', 'Any', 150],
    ]);
    expect(sent.every((x) => x.paid === false && !x.promo_code)).toBe(true);
    await expect(page.locator('#walkin-modal [role="dialog"]')).toHaveCount(0);
    expect(await page.evaluate(`S.fullLog.some(l=>/^Book next week: #\\d+ Amal Road \\+1$/.test(l.label))`)).toBe(true);
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0);
  });

  test('First-timers marks tonight\'s first riders Booked again, or offers Book next week', async ({ page }) => {
    await boot(page);
    await page.evaluate(`_n6cFtOpen()`);
    const ft = page.locator('#confirm-modal .bnw-ft .bnw-ft-row');
    await expect(ft).toHaveCount(2);
    await expect(page.locator('#confirm-modal .bnw-ft-h')).toHaveText("Tonight's first-timers (2)");
    const farah = ft.filter({ hasText: 'Farah First' }), ghada = ft.filter({ hasText: 'Ghada First' });
    await expect(farah.locator('.bnw-again')).toContainText('Booked again');
    await expect(farah.getByRole('button')).toHaveCount(0);
    await ghada.getByRole('button', { name: /Book next week/ }).click();
    await expect(page.locator('#confirm-modal .bnw-ft')).toHaveCount(0);
    await expect(page.locator('#walkin-modal #wi-name')).toHaveValue('Ghada First');
    await expect(page.locator('#walkin-modal #wi-sess')).toHaveValue('s1');
  });

  test('the close-night list asks whether tonight\'s first-timers were asked about next week; a tick passes it; none without a next night', async ({ page }) => {
    await boot(page);
    const held: Record<string, unknown>[] = [], sent: Record<string, unknown>[] = [];
    await page.route(/\/rest\/v1\/session_checks/, async (r: Route) => {
      const m = r.request().method();
      if (m === 'POST') {
        const b = r.request().postDataJSON() as Record<string, unknown>;
        sent.push(b);
        const x = { ...b, id: held.length + 100, done_by_name: 'Desk Dana', done_at: NOW.toISOString() };
        held.push(x);
        return r.fulfill({ status: 201, headers: head, body: JSON.stringify([x]) });
      }
      if (m === 'GET') return r.fulfill({ status: 200, headers: head, body: JSON.stringify(held) });
      return r.fallback();
    });
    await page.evaluate(`_ckOpen('close','s0')`);
    const it = page.locator('#desk-sheet .ck-li').filter({ hasText: 'First-timers asked about next week' });
    await expect(it).toHaveCount(1);
    await expect(it).toContainText('1 not booked yet');
    await expect(it.locator('.ck-no')).toHaveCount(1);
    await expect(it.locator('.ck-owe-r').filter({ hasText: '#7 Ghada First' }).getByRole('button', { name: 'Book next week' })).toBeVisible();
    await expect(it).not.toContainText('Farah First');                     // booked again already
    await it.getByRole('button', { name: 'Mark as asked' }).click();
    await expect(it.locator('.ck-ok')).toHaveCount(1);
    await expect(it.getByRole('button', { name: 'Mark as asked' })).toHaveAttribute('aria-pressed', 'true');
    await expect(it).toContainText('Desk Dana');
    expect(sent).toEqual([{ session_id: 's0', list: 'close', item_key: 'rebook' }]);
    // no next night of the kind: no item
    await page.evaluate(`_dkClose();S.sessions=S.sessions.filter(s=>s.id!=='s1');_ckOpen('close','s0')`);
    await expect(page.locator('#desk-sheet .ck-li').first()).toBeVisible();
    await expect(page.locator('#desk-sheet .ck-li').filter({ hasText: 'First-timers asked' })).toHaveCount(0);
  });
});
