import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// "Still coming?" the day before (new features build F2, 2026-11-13). From 24 hours before the time to turn up until the
// session starts, a booking that holds a place shows "I'm coming" and "Can't come" on its ticket and on the Community
// tab's card. "I'm coming" stamps the booking (booking_coming, migration 20261114010200) and one quiet chip takes the
// buttons' place; "Can't come" opens the cancel dialog as it is. No line of text goes with them. Staff see a tick on the
// roster. The evening-before reminder gains one sentence and links to the ticket. All Supabase traffic is stubbed.

const SAT = '2026-11-14', NIGHT = '2026-11-20';
const sat = (o: Record<string, unknown> = {}) => ({ id: SAT, day: 'Saturday', session_date: SAT, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}', ...o });
const night = (o: Record<string, unknown> = {}) => ({ id: NIGHT, day: 'Friday', session_date: NIGHT, capacity: 20, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...o });
const later = { id: '2099-01-03', day: 'Saturday', session_date: '2099-01-03', capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' };
const feed = { ok: true, today: '2026-11-13', me: { kind: 'first', levels: [1], target: 1, chosen: false, n: 0, ends_on: '2026-11-30', sats: 4 }, club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null };
// coming_at: null is a booking read from a database that has the column; `bare` drops it (a database before the migration).
const row = (id: string, sid: string, o: Record<string, unknown> = {}) => ({ id, session_id: sid, session_date: sid.slice(0, 10), session_day: sid === SAT ? 'Saturday' : 'Friday', customer_id: 'c1', name: 'Lina Haddad', queue_num: 4, status: 'waiting', paid: false, price: sid === SAT ? 0 : 75, type_preference: 'Road', created_at: 1, approval: sid === SAT ? 'approved' : null, coming_at: null, ...o });
const bare = (r: Record<string, unknown>) => { const rest = { ...r }; delete rest.coming_at; return rest; };

type Sent = { p_id?: string; p_token?: string; p_session?: string };
/** Signs the rider in on Bookings at a fixed moment. booking_coming answers as the function does: it stamps the fixture's
 *  rows, so a reload reads the answer back through my_bookings. */
async function rider(page: Page, rows: Record<string, unknown>[], at: string, fx: Fixtures = {}, tab = 'myrides') {
  const calls: Sent[] = [];
  await page.clock.setFixedTime(new Date(at));
  await stubSupabase(page, { sessions: [sat(), night(), later], customers: [], queue_entries: rows, bikes: [], 'rpc:my_bookings': rows, 'rpc:community_member': true, 'rpc:hub_feed': feed, ...fx });
  if (!('rpc:booking_coming' in fx)) {
    await page.route('**/rest/v1/rpc/booking_coming*', async (r) => {
      const b = (r.request().postDataJSON() || {}) as Sent;
      calls.push(b);
      const stamp = new Date(at).toISOString();
      rows.forEach((x) => { if (x.session_id === b.p_session && x.status === 'waiting') x.coming_at = x.coming_at || stamp; });
      await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, coming_at: stamp, n: 1 }) });
    });
  }
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'male' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('${tab}')`);
  return calls;
}
const ticket = (page: Page) => page.locator('#tab-myrides .ticket-card').first();
const still = (page: Page) => page.locator('#tab-myrides .ticket-card .stc-row');
const hero = (page: Page) => page.locator('#hub-body .hub-hero');

test.describe('@customer:bookings "Still coming?" on the ticket', () => {
  test('the two buttons appear only inside the 24 hours before the time to turn up, and leave at the start', async ({ page }) => {
    // a circuit night: bikes are collected at 20:30, the ride starts at 21:00
    await rider(page, [row('q1', NIGHT)], '2026-11-19T20:00:00+03:00');
    await expect(ticket(page)).toBeVisible();
    await expect(still(page)).toHaveCount(0); // 24 and a half hours before bike collection: nothing yet
    await page.clock.setFixedTime(new Date('2026-11-19T20:31:00+03:00'));
    await page.evaluate(`renderMyRides()`);
    await expect(still(page).locator('button')).toHaveText(['I’m coming', 'Can’t come']);
    await expect(still(page)).toHaveAttribute('role', 'group');
    await expect(still(page)).toHaveAttribute('aria-label', 'Are you still coming?');
    // no hint line: the row holds the two buttons and not one word more
    expect(await still(page).evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === 3 && (n.textContent || '').trim()).length + el.querySelectorAll(':scope > :not(button)').length)).toBe(0);
    await page.clock.setFixedTime(new Date('2026-11-20T20:59:00+03:00'));
    await page.evaluate(`renderMyRides()`);
    await expect(still(page).locator('button')).toHaveCount(2); // a minute before the start: still there
    await page.clock.setFixedTime(new Date('2026-11-20T21:00:00+03:00'));
    await page.evaluate(`renderMyRides()`);
    await expect(ticket(page)).toBeVisible();
    await expect(still(page)).toHaveCount(0);
  });

  test('"I\'m coming" stamps the booking through booking_coming, a quiet chip takes the buttons\' place, and it survives a reload', async ({ page }) => {
    const rows = [row('q1', SAT)];
    const calls = await rider(page, rows, '2026-11-13T07:00:00+03:00');
    const shot = async (name: string) => { if (process.env.SHOT_DIR) await ticket(page).screenshot({ path: `${process.env.SHOT_DIR}/stc-${name}-${test.info().project.name}.png` }); };
    await shot('ticket-ask');
    await still(page).locator('button', { hasText: 'I’m coming' }).click();
    await expect(still(page).locator('.stc-ok')).toHaveText('Coming');
    await expect(still(page).locator('button')).toHaveCount(0);
    await shot('ticket-yes');
    expect(calls).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_session: SAT }]);
    expect(await page.evaluate(`S.queue.find(e=>e.id==='q1').comingAt`)).toBe('2026-11-13T04:00:00.000Z');
    await expect(page.locator('#tab-myrides .ticket-card .cu-tk-actions button', { hasText: 'Cancel' })).toBeVisible(); // the ticket's own Cancel stays
    await page.reload();
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    await expect(still(page).locator('.stc-ok')).toHaveText('Coming');
    await expect(still(page).locator('button')).toHaveCount(0);
    expect(calls).toHaveLength(1);
  });

  test('"Can\'t come" opens the cancel dialog as it is, and nothing is stamped', async ({ page }) => {
    const calls = await rider(page, [row('q1', SAT)], '2026-11-13T07:00:00+03:00');
    await still(page).locator('button', { hasText: 'Can’t come' }).click();
    const dlg = page.locator('#cancel-reason-modal [role="dialog"]');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#cr-title')).toHaveText(await page.evaluate(`t('cancelReasonTitle')`) as string);
    await expect(dlg.locator('input[name="cr-reason"]').first()).toBeAttached();
    await expect(dlg.locator('button', { hasText: await page.evaluate(`t('keepBookingBtn')`) as string })).toBeVisible();
    expect(calls).toHaveLength(0);
    await dlg.locator('button', { hasText: await page.evaluate(`t('keepBookingBtn')`) as string }).click();
    await expect(still(page).locator('button')).toHaveCount(2); // kept: the question still stands
  });

  test('every rider of the booking is confirmed by one tap', async ({ page }) => {
    const rows = [row('q1', NIGHT), row('q2', NIGHT, { name: 'Maya Haddad', queue_num: 5 })];
    const calls = await rider(page, rows, '2026-11-20T10:00:00+03:00');
    await expect(still(page)).toHaveCount(1);
    if (process.env.SHOT_DIR) await ticket(page).screenshot({ path: `${process.env.SHOT_DIR}/stc-night-ask-${test.info().project.name}.png` });
    await still(page).locator('button', { hasText: 'I’m coming' }).click();
    await expect(still(page).locator('.stc-ok')).toBeVisible();
    if (process.env.SHOT_DIR) await ticket(page).screenshot({ path: `${process.env.SHOT_DIR}/stc-night-yes-${test.info().project.name}.png` });
    expect(calls).toHaveLength(1);
    expect(await page.evaluate(`S.queue.filter(e=>e.comingAt).map(e=>e.id).sort()`)).toEqual(['q1', 'q2']);
  });

  test('nothing on a waitlisted booking, on a ride staff have not confirmed, on a ride called off, or once checked in', async ({ page }) => {
    await rider(page, [row('q1', SAT, { status: 'waitlist' })], '2026-11-13T07:00:00+03:00');
    await expect(ticket(page)).toBeVisible();
    await expect(still(page)).toHaveCount(0);
    const paint = (js: string) => page.evaluate(`(()=>{const e=S.queue.find(x=>x.id==='q1'),s=S.sessions.find(x=>x.id==='${SAT}');${js};renderMyRides();})()`);
    await paint(`e.status='waiting'`);
    await expect(still(page).locator('button')).toHaveCount(2); // the same booking with a place: asked
    await paint(`e.approval='pending'`);
    await expect(still(page)).toHaveCount(0);
    await paint(`e.approval='approved';s.hide_queue=true`); // approved, but the list is not out yet
    await expect(still(page)).toHaveCount(0);
    await paint(`s.hide_queue=false;s.ride_status='cancelled'`);
    await expect(still(page)).toHaveCount(0);
    await paint(`s.ride_status=null;e.status='active'`);
    await expect(still(page)).toHaveCount(0);
    await paint(`e.status='waiting'`);
    await expect(still(page).locator('button')).toHaveCount(2);
  });

  test('a yes given for another date does not count: the booking is asked again', async ({ page }) => {
    await rider(page, [row('q1', SAT, { coming_at: '2026-11-05T09:00:00Z' })], '2026-11-13T07:00:00+03:00');
    await expect(still(page).locator('button')).toHaveCount(2);
    await expect(still(page).locator('.stc-ok')).toHaveCount(0);
  });

  test('a database before the migration: no buttons; one without the function: they go without a word', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await rider(page, [bare(row('q1', SAT))], '2026-11-13T07:00:00+03:00');
    await expect(ticket(page)).toBeVisible();
    await expect(still(page)).toHaveCount(0);
    // the column is there but the function is not (PGRST202, the stub's answer for an RPC not yet in the database)
    await page.evaluate(`(()=>{S.queue.find(x=>x.id==='q1').comingAt=null;renderMyRides();})()`);
    await page.unroute('**/rest/v1/rpc/booking_coming*');
    await still(page).locator('button', { hasText: 'I’m coming' }).click();
    await expect(still(page)).toHaveCount(0);
    await expect(ticket(page)).toBeVisible();
    await expect(page.locator('.toast.error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a session the server says has started or been called off: the booking is read again', async ({ page }) => {
    const rows = [row('q1', SAT)];
    await rider(page, rows, '2026-11-13T07:00:00+03:00', { 'rpc:booking_coming': { ok: false, error: 'closed' } });
    let reads = 0;
    // (the stubbed suite runs in open mode, where the page reads the bookings table; production reads my_bookings)
    page.on('request', (r) => { if (/\/(rpc\/my_bookings|queue_entries)$/.test(new URL(r.url()).pathname)) reads++; });
    await still(page).locator('button', { hasText: 'I’m coming' }).click();
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(still(page).locator('.stc-ok')).toHaveCount(0);
  });

  test('the words are the page\'s language (Arabic), and the reminder\'s link opens Bookings at that ticket', async ({ page }) => {
    const rows = [row('q0', '2099-01-03', { approval: 'approved', price: 0, session_day: 'Saturday' }), row('q1', NIGHT)];
    await page.addInitScript(() => localStorage.setItem('cq_lang', 'ar'));
    await page.clock.setFixedTime(new Date('2026-11-20T10:00:00+03:00'));
    await stubSupabase(page, { sessions: [night(), later], customers: [], queue_entries: rows, bikes: [], 'rpc:my_bookings': rows });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'male' });
    await page.goto('/my-bookings?tk=q1');
    await waitForSb(page);
    await expect(still(page).locator('button')).toHaveText(['سأحضر', 'لا أستطيع الحضور']);
    await expect.poll(() => page.evaluate('location.pathname+location.search')).toBe('/my-bookings');
    await expect(still(page)).toBeInViewport();
  });
});

test.describe('@customer:members "Still coming?" on the Community card', () => {
  test('the card carries the same two buttons from "tomorrow" on; a yes leaves one chip there and on the ticket', async ({ page }) => {
    const rows = [row('q1', SAT)];
    const calls = await rider(page, rows, '2026-11-12T12:00:00+03:00', {}, 'members');
    await expect(hero(page)).toBeVisible();
    await expect(hero(page)).not.toHaveClass(/hub-hero-(tomorrow|today)/);
    await expect(hero(page).locator('.stc-row')).toHaveCount(0); // two days before: nothing
    await page.clock.setFixedTime(new Date('2026-11-13T07:00:00+03:00'));
    await page.evaluate(`_hubRender()`);
    await expect(hero(page)).toHaveClass(/hub-hero-tomorrow/);
    await expect(hero(page).locator('.stc-row button')).toHaveText(['I’m coming', 'Can’t come']);
    await expect(hero(page).locator('button', { hasText: 'Show ticket' })).toBeVisible();
    if (process.env.SHOT_DIR) await hero(page).screenshot({ path: `${process.env.SHOT_DIR}/stc-card-ask-${test.info().project.name}.png` });
    await hero(page).locator('button', { hasText: 'I’m coming' }).click();
    await expect(hero(page).locator('.stc-ok')).toHaveText('Coming');
    if (process.env.SHOT_DIR) await hero(page).screenshot({ path: `${process.env.SHOT_DIR}/stc-card-yes-${test.info().project.name}.png` });
    await expect(hero(page).locator('.stc-row button')).toHaveCount(0);
    expect(calls).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_session: SAT }]);
    await page.evaluate(`setCustTab('myrides')`);
    await expect(still(page).locator('.stc-ok')).toHaveText('Coming');
  });

  test('"Can\'t come" on the card opens the cancel dialog; the card leaves at the start, and a waitlisted booking has none', async ({ page }) => {
    await rider(page, [row('q1', SAT)], '2026-11-14T05:00:00+03:00', {}, 'members');
    await expect(hero(page)).toHaveClass(/hub-hero-today/);
    await hero(page).locator('button', { hasText: 'Can’t come' }).click();
    await expect(page.locator('#cancel-reason-modal [role="dialog"]')).toBeVisible();
    await page.evaluate(`closeCancelReasonModal()`);
    await page.clock.setFixedTime(new Date('2026-11-14T06:30:00+03:00')); // the ride starts: the card stays "today", the question goes
    await page.evaluate(`_hubRender()`);
    await expect(hero(page)).toHaveClass(/hub-hero-today/);
    await expect(hero(page).locator('.stc-row')).toHaveCount(0);
    await page.clock.setFixedTime(new Date('2026-11-14T05:00:00+03:00'));
    await page.evaluate(`(()=>{S.queue.find(x=>x.id==='q1').status='waitlist';_hubRender();})()`);
    await expect(hero(page)).toBeVisible();
    await expect(hero(page).locator('.stc-row')).toHaveCount(0);
  });
});

test.describe('@staff:bookings "Still coming?" on the roster', () => {
  test('a rider who confirmed carries a tick after the name, with when on hover; nobody else does', async ({ page }) => {
    const r = (n: number, name: string, o: Record<string, unknown> = {}) => ({ id: 'q' + n, session_id: NIGHT, session_day: 'Friday', session_date: NIGHT, queue_num: n, name, customer_id: 'c' + n, phone: '', email: '', type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-11-10T10:00:00Z', coming_at: null, ...o });
    await page.clock.setFixedTime(new Date('2026-11-20T12:00:00+03:00'));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await stubSupabase(page, { sessions: [night()], bikes: [], customers: [], staff_options: [], queue_entries: [
      r(1, 'Came Back', { coming_at: '2026-11-19T18:40:00Z' }), r(2, 'Said Nothing'),
      r(3, 'Old Answer', { coming_at: '2026-11-10T09:00:00Z' }), // given for another date (before a move): not shown
      r(4, 'Already In', { status: 'active', coming_at: '2026-11-19T18:40:00Z', checked_in_at: '2026-11-20T08:00:00Z' }),
    ] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${NIGHT}';renderStaffQueue()`);
    const tr = (id: string) => page.locator(`#tab-queue .queue-table tbody tr[data-id="${id}"]`);
    const mk = tr('q1').locator('.rider-name .stc-mk');
    await expect(mk).toBeVisible();
    await expect(mk).toHaveAttribute('aria-label', 'Confirmed coming');
    await expect(mk).toHaveAttribute('title', /^Confirmed coming · .*21:40/);
    for (const id of ['q2', 'q3', 'q4']) await expect(tr(id).locator('.stc-mk')).toHaveCount(0);
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/stc-roster.png` });
  });

  test('the mark is named in every staff language pack, the rider\'s words in every rider pack', () => {
    const pack = (f: string) => JSON.parse(readFileSync(resolve(__dirname, '../lang', f), 'utf8')) as Record<string, string>;
    for (const l of ['ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']) {
      expect((pack(`staff-${l}.json`).stillMark || '').length, `staff ${l}`).toBeGreaterThan(3);
      const r = pack(`${l}.json`);
      for (const k of ['stillYes', 'stillNo', 'stillOk', 'stillAsk']) expect((r[k] || '').length, `${l} ${k}`).toBeGreaterThan(2);
      expect(r.stillMark, `${l}: the staff word stays out of the rider pack`).toBeUndefined();
    }
  });
});

test.describe('@customer:bookings the evening-before reminder', () => {
  const sql = readFileSync(resolve(__dirname, '../supabase/migrations/20261114010200_still_coming.sql'), 'utf8');
  const words = [...sql.matchAll(/^\s*\('(remind(?::nc)?)',\s*'([a-z]{2})',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\)/gm)].map((m) => ({ key: m[1], lang: m[2], title: m[3], body: m[4].replace(/''/g, "'") }));

  test('both messages are written in all ten languages, with the session and the time, and a second sentence', () => {
    const langs = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
    for (const key of ['remind', 'remind:nc']) {
      expect(words.filter((w) => w.key === key).map((w) => w.lang)).toEqual(langs);
    }
    for (const w of words) {
      expect(w.title.length, `${w.key} ${w.lang} title`).toBeGreaterThan(3);
      expect(w.body, `${w.key} ${w.lang}`).toContain('{0}');
      expect(w.body, `${w.key} ${w.lang}`).toContain('{1}');
      expect(w.body.length, `${w.key} ${w.lang}`).toBeGreaterThan(45);
      expect(w.body.length, `${w.key} ${w.lang}`).toBeLessThanOrEqual(300);
      expect(w.body, `${w.key} ${w.lang}: Latin digits only`).not.toMatch(/[٠-٩۰-۹०-९০-৯]/);
    }
    expect(words.find((w) => w.key === 'remind' && w.lang === 'en')!.body).toBe("{0}, meet at {1}. If you can't come, cancel so another rider can take the bike.");
  });

  test('neither names a waitlist or uses a pay word; a session with no bike never says ride, bike or cycling', () => {
    const en = (k: string) => words.find((w) => w.key === k && w.lang === 'en')!;
    for (const w of words) {
      expect(`${w.title} ${w.body}`, `${w.key} ${w.lang}`).not.toMatch(/waitlist|waiting list|liste d.attente|lista de espera|قائمة الانتظار|انتظار|प्रतीक्षा|অপেক্ষা/i);
      expect(`${w.title} ${w.body}`, `${w.key} ${w.lang}`).not.toMatch(/\b(pay|paid|fee|refund|charge|price|free|SAR)\b|ريال|رسوم|استرداد/i);
    }
    expect(`${en('remind:nc').title} ${en('remind:nc').body}`).not.toMatch(/\b(ride|rider|bike|cycl\w*)\b/i);
    for (const w of words.filter((x) => x.key === 'remind:nc')) {
      expect(`${w.title} ${w.body}`, w.lang).not.toMatch(/دراج|رحل|vélo|sortie|cycliste|bici|ciclista|salida|passeio|bicicleta|سائیکل|رائیڈ|سوار|साइकिल|राइड|bike|ride|साइकल|সাইকেল|রাইড/i);
    }
  });

  test('the reminder opens that booking\'s ticket, a bike-free session takes its own words, and its mark is allowed', () => {
    expect(sql).toContain(`'/my-bookings?tk=' || r.id`);
    expect(sql).toMatch(/case when coalesce\(r\.no_bike, false\) then 'remind:nc' else 'remind' end/);
    expect(sql).toMatch(/reminded_kind in \('24h', '2h', 'push'\)/);
    // the function is the rider's own door and nobody else's
    expect(sql).toMatch(/not _cust_token_ok\(p_id, p_token\)/);
    expect(sql).toMatch(/q\.session_id = p_session and q\.customer_id = p_id and q\.status = 'waiting'/);
    expect(sql).toMatch(/revoke all on function public\.booking_coming\(text, text, text\) from public;\s*grant execute on function public\.booking_coming\(text, text, text\) to anon, authenticated;/);
  });
});
