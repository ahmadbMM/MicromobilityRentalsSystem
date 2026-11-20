import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// "Running late" on the ticket (the customer features round, 2026-11-19, item 1; the user: "'Still coming?' gets a third
// answer next to I'm coming / Can't come: Running late (10, 20 or 30 min). The desk sees it ... so staff stop chasing
// riders who already said so."). Only where there is a time to turn up (Late arrivals' _ltrAt), from two hours before
// it until an hour after the start; after the start it is the row's only button. A pick saves at once through
// booking_late (migration 20261119600100) and one chip takes the buttons' place; tapping it opens the pop-up again with
// "I'm on time". Staff see it on the roster, in the check-in drawer and in the Filters panel, and the "Running late?"
// WhatsApp leaves those riders out. All Supabase traffic is stubbed; the riders are invented.

const SAT = '2026-11-14', NIGHT = '2026-11-20';
// the Saturday ride gathers at 06:00 and sets off at 06:30: Running late from 04:00 to 07:30
const sat = (o: Record<string, unknown> = {}) => ({ id: SAT, day: 'Saturday', session_date: SAT, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}', ...o });
// a circuit night: riders come any time, so never Running late
const night = (o: Record<string, unknown> = {}) => ({ id: NIGHT, day: 'Friday', session_date: NIGHT, capacity: 20, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...o });
const feed = { ok: true, today: SAT, me: { kind: 'first', levels: [1], target: 1, chosen: false, n: 0, ends_on: '2026-11-30', sats: 4 }, club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null };
const row = (id: string, sid: string, o: Record<string, unknown> = {}) => ({ id, session_id: sid, session_date: sid.slice(0, 10), session_day: sid === SAT ? 'Saturday' : 'Friday', customer_id: 'c1', name: 'Lina Haddad', queue_num: 4, status: 'waiting', paid: false, price: sid === SAT ? 0 : 75, type_preference: 'Road', created_at: 1, approval: sid === SAT ? 'approved' : null, coming_at: null, late_min: null, late_at: null, ...o });
const at = (hm: string, day = SAT) => new Date(`${day}T${hm}:00+03:00`);

type Sent = { p_id?: string; p_token?: string; p_session?: string; p_min?: number | null };
/** Signs the rider in at a fixed moment. booking_late answers as the function does: it writes the fixture's rows, so a
 *  reload reads the answer back. */
async function rider(page: Page, rows: Record<string, unknown>[], when: Date, fx: Fixtures = {}, tab = 'myrides') {
  const calls: Sent[] = [];
  await page.clock.setFixedTime(when);
  await stubSupabase(page, { sessions: [sat(), night()], customers: [], queue_entries: rows, bikes: [], 'rpc:my_bookings': rows, 'rpc:community_member': true, 'rpc:hub_feed': feed, ...fx });
  if (!('rpc:booking_late' in fx)) {
    await page.route('**/rest/v1/rpc/booking_late*', async (r) => {
      const b = (r.request().postDataJSON() || {}) as Sent;
      calls.push(b);
      const stamp = when.toISOString();
      rows.forEach((x) => { if (x.session_id === b.p_session && x.status === 'waiting') { x.late_min = b.p_min ?? null; x.late_at = b.p_min ? stamp : null; if (b.p_min) x.coming_at = x.coming_at || stamp; } });
      await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, late_min: b.p_min ?? null, late_at: b.p_min ? stamp : null, coming_at: b.p_min ? stamp : null, n: 1 }) });
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
const pop = (page: Page) => page.locator('#confirm-modal .rl-pick');
const paintAt = async (page: Page, when: Date) => { await page.clock.setFixedTime(when); await page.evaluate('renderMyRides()'); };

test.describe('@customer:bookings Running late on the ticket', () => {
  test('its window: from two hours before the time to turn up beside the two answers, alone after the start, gone an hour after it', async ({ page }) => {
    await rider(page, [row('q1', SAT)], at('03:59'));
    await expect(still(page).locator('button')).toHaveText(['I’m coming', 'Can’t come']); // two hours and a minute before the gathering
    await paintAt(page, at('04:00'));
    await expect(still(page).locator('button')).toHaveText(['I’m coming', 'Running late', 'Can’t come']);
    await expect(still(page)).toHaveAttribute('role', 'group');
    await expect(still(page).locator('.rl-btn')).toHaveAttribute('aria-haspopup', 'dialog');
    // no hint line: the row holds the buttons and not one word more
    expect(await still(page).evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === 3 && (n.textContent || '').trim()).length + el.querySelectorAll(':scope > :not(button)').length)).toBe(0);
    if (process.env.SHOT_DIR) await ticket(page).screenshot({ path: `${process.env.SHOT_DIR}/rl-three-${test.info().project.name}.png` });
    await paintAt(page, at('06:29'));
    await expect(still(page).locator('button')).toHaveCount(3);
    await paintAt(page, at('06:30')); // the ride sets off: Still coming? goes, Running late stays
    await expect(still(page).locator('button')).toHaveText(['Running late']);
    await paintAt(page, at('07:29'));
    await expect(still(page).locator('button')).toHaveText(['Running late']);
    await paintAt(page, at('07:30'));
    await expect(ticket(page)).toBeVisible();
    await expect(still(page)).toHaveCount(0);
  });

  test('a pick saves at once, one chip says it, and tapping the chip changes it or takes it back with "I\'m on time"', async ({ page }) => {
    const rows = [row('q1', SAT), row('q2', SAT, { name: 'Maya Haddad', queue_num: 5 })];
    const calls = await rider(page, rows, at('05:40'));
    await still(page).locator('button', { hasText: 'Running late' }).click();
    await expect(pop(page)).toBeVisible();
    await expect(pop(page)).toHaveAttribute('aria-labelledby', 'dlgt-rl');
    await expect(page.locator('#dlgt-rl')).toHaveText('How late will you be?');
    await expect(pop(page).locator('.rl-acts button')).toHaveText(['10 min', '20 min', '30 min']); // nothing picked yet: no "I'm on time"
    if (process.env.SHOT_DIR) await pop(page).screenshot({ path: `${process.env.SHOT_DIR}/rl-pop-${test.info().project.name}.png` });
    await pop(page).locator('button', { hasText: '20 min' }).click();
    await expect(pop(page)).toHaveCount(0);
    await expect(still(page).locator('.rl-chip')).toHaveText('Running late, about 20 min');
    await expect(still(page).locator('button')).toHaveCount(1); // the chip alone: it counts as coming
    expect(calls).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_session: SAT, p_min: 20 }]);
    expect(await page.evaluate(`S.queue.filter(e=>e.lateMin===20&&e.comingAt).map(e=>e.id).sort()`)).toEqual(['q1', 'q2']); // the whole party
    if (process.env.SHOT_DIR) await ticket(page).screenshot({ path: `${process.env.SHOT_DIR}/rl-chip-${test.info().project.name}.png` });
    // the chip opens it again: the pick pressed, and the way back
    await still(page).locator('.rl-chip').click();
    await expect(pop(page).locator('[aria-pressed="true"]')).toHaveText('20 min');
    await expect(pop(page).locator('.rl-ontime')).toHaveText('I’m on time');
    await pop(page).locator('button', { hasText: '30 min' }).click();
    await expect(still(page).locator('.rl-chip')).toHaveText('Running late, about 30 min');
    // it survives a reload
    await page.reload();
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    await expect(still(page).locator('.rl-chip')).toHaveText('Running late, about 30 min');
    await still(page).locator('.rl-chip').click();
    await pop(page).locator('.rl-ontime').click();
    expect(calls.map((c) => c.p_min)).toEqual([20, 30, null]);
    // cleared: the yes it stamped stands, so the row says Coming with Running late beside it
    await expect(still(page).locator('.stc-ok')).toHaveText('Coming');
    await expect(still(page).locator('button')).toHaveText(['Running late']);
  });

  test('never on a circuit night, a waitlisted booking or a ride staff have not confirmed; nothing before the migration', async ({ page }) => {
    await rider(page, [row('q1', NIGHT), row('q2', SAT)], at('20:45', NIGHT));
    const nt = page.locator('#tab-myrides .ticket-card').filter({ has: page.locator('[data-on-click*="_stcYes"][data-on-click*="2026-11-20"]') });
    await expect(nt).toHaveCount(1);
    await expect(nt.locator('.stc-row button')).toHaveText(['I’m coming', 'Can’t come']); // Still coming? yes; Running late no
    await paintAt(page, at('21:10', NIGHT));
    await expect(page.locator('#tab-myrides .rl-btn')).toHaveCount(0);
    // the Saturday ride, inside its window, booking by booking
    await page.clock.setFixedTime(at('05:00'));
    const paint = (js: string) => page.evaluate(`(()=>{const e=S.queue.find(x=>x.id==='q2'),s=S.sessions.find(x=>x.id==='${SAT}');${js};renderMyRides();})()`);
    const st = page.locator('#tab-myrides .ticket-card').filter({ has: page.locator('.cu-tk-share[data-on-click*="q2"]') });
    await paint(`e.status='waiting'`);
    await expect(st.locator('.rl-btn')).toHaveCount(1);
    await paint(`e.status='waitlist'`);
    await expect(st.locator('.stc-row')).toHaveCount(0);
    await paint(`e.status='waiting';e.approval='pending'`);
    await expect(st.locator('.stc-row')).toHaveCount(0);
    await paint(`e.approval='approved';s.hide_queue=true`); // approved, but the list is not out yet
    await expect(st.locator('.stc-row')).toHaveCount(0);
    await paint(`s.hide_queue=false;e.status='active'`); // checked in
    await expect(st.locator('.stc-row')).toHaveCount(0);
    await paint(`e.status='waiting';delete e.lateMin`); // a row read without the column: Still coming? alone
    await expect(st.locator('.stc-row button')).toHaveText(['I’m coming', 'Can’t come']);
  });

  test('a refusal is said in words and the bookings are read again; offline it asks to try again', async ({ page }) => {
    await rider(page, [row('q1', SAT)], at('06:40'), { 'rpc:booking_late': { ok: false, error: 'closed' } });
    let reads = 0;
    page.on('request', (r) => { if (/\/(rpc\/my_bookings|queue_entries)$/.test(new URL(r.url()).pathname)) reads++; });
    await still(page).locator('.rl-btn').click();
    await pop(page).locator('button', { hasText: '10 min' }).click();
    await expect(page.locator('.toast.error')).toContainText('Too late to change this now');
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(still(page).locator('.rl-chip')).toHaveCount(0);
    // offline: the centred Try again, before anything is sent
    await page.evaluate(`S._netDown=true`);
    await still(page).locator('.rl-btn').click();
    await pop(page).locator('button', { hasText: '10 min' }).click();
    await expect(page.locator('#confirm-modal [role="dialog"]')).toContainText(await page.evaluate(`t('offlineActTitle')`) as string);
  });

  test('Arabic: the buttons, the pop-up and the chip', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cq_lang', 'ar'));
    await rider(page, [row('q1', SAT, { late_min: 10, late_at: at('05:30').toISOString(), coming_at: at('05:30').toISOString() })], at('05:45'));
    await expect(still(page).locator('.rl-chip')).toHaveText('سأتأخر نحو 10 دقيقة');
    await still(page).locator('.rl-chip').click();
    await expect(page.locator('#dlgt-rl')).toHaveText('كم ستتأخر؟');
    await expect(pop(page).locator('.rl-ontime')).toHaveText('سأصل في الموعد');
    await page.evaluate(`(()=>{const e=S.queue.find(x=>x.id==='q1');e.lateMin=null;e.comingAt=null;closeConfirm();renderMyRides();})()`);
    await expect(still(page).locator('button')).toHaveText(['سأحضر', 'سأتأخر', 'لا أستطيع الحضور']);
    if (process.env.SHOT_DIR) await ticket(page).screenshot({ path: `${process.env.SHOT_DIR}/rl-ar-${test.info().project.name}.png` });
  });

  test('a late answer given for another date does not count', async ({ page }) => {
    await rider(page, [row('q1', SAT, { late_min: 20, late_at: '2026-11-07T03:00:00Z' })], at('05:00'));
    await expect(still(page).locator('.rl-chip')).toHaveCount(0);
    await expect(still(page).locator('.rl-btn')).toHaveCount(1);
  });
});

test.describe('@customer:members Running late on the Community card', () => {
  test('the card carries the same button through _hubDeps.still, and the chip once said', async ({ page }) => {
    const calls = await rider(page, [row('q1', SAT)], at('05:00'), {}, 'members');
    const hero = page.locator('#hub-body .hub-hero');
    await expect(hero).toHaveClass(/hub-hero-today/);
    await expect(hero.locator('.stc-row button')).toHaveText(['I’m coming', 'Running late', 'Can’t come']);
    await hero.locator('.rl-btn').click();
    await pop(page).locator('button', { hasText: '10 min' }).click();
    await expect(hero.locator('.rl-chip')).toHaveText('Running late, about 10 min');
    expect(calls).toHaveLength(1);
    if (process.env.SHOT_DIR) await hero.screenshot({ path: `${process.env.SHOT_DIR}/rl-card-${test.info().project.name}.png` });
    await page.clock.setFixedTime(at('06:45')); // after the start: the card is still "today", the chip still says it
    await page.evaluate('_hubRender()');
    await expect(hero.locator('.rl-chip')).toHaveText('Running late, about 10 min');
  });
});

// ── Staff ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const DAY = '2099-05-05';
const gather = { id: 'g0', day: 'Tuesday', session_date: DAY, capacity: 30, status: 'open', created_at: 1, ride_kind: 'snd96', bike_slots: JSON.stringify({ Road: 20, _time: '06:00 - 07:00' }) };
const ksa = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+03:00`).toISOString();
const bk = (id: string, qn: number, name: string, o: Record<string, unknown> = {}) => ({
  id, session_id: 'g0', session_day: 'Tuesday', session_date: DAY, queue_num: qn, name, phone: '+96655187000' + qn, customer_id: 'c' + qn, group_id: null,
  status: 'waiting', paid: true, price: 75, walk_in: false, registered_at: `${DAY}T00:00:00Z`, height: 175, type_preference: 'Road', coming_at: null, late_min: null, late_at: null, ...o,
});
const desk = [
  bk('r1', 1, 'Rami Running', { late_min: 20, late_at: ksa('05:50'), coming_at: ksa('05:50') }),
  bk('r2', 2, 'Sami Silent'),
  bk('r3', 3, 'Omar Arrived', { status: 'active', checked_in_at: ksa('06:05'), late_min: 10, late_at: ksa('05:40') }),
];
async function staff(page: Page, rows: Record<string, unknown>[] = desk) {
  await page.clock.setFixedTime(new Date(ksa('06:20')));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await stubSupabase(page, { sessions: [gather], bikes: [], customers: [], staff_options: [], queue_entries: rows });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length===${rows.length}`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfShowFinished=true;setSfSession('g0')`);
}
const tr = (page: Page, id: string) => page.locator(`#q-results [data-id="${id}"]`).first();
const shown = (page: Page) => page.locator('#q-results :is(.queue-table tbody tr[data-id], .q-card)');

test.describe('@staff:bookings Running late on the roster', () => {
  test('the status cell says it beside Late arrivals\' mark until check-in; the check-in drawer says it too', async ({ page }) => {
    await staff(page);
    const mk = tr(page, 'r1').locator('.rq-st2 .rq-rl');
    await expect(mk).toHaveText('Running late · ~20 min');
    await expect(mk).toHaveAttribute('title', /^Running late · ~20 min · .*05:50/);
    await expect(tr(page, 'r2').locator('.rq-rl')).toHaveCount(0);
    await expect(tr(page, 'r3').locator('.rq-rl')).toHaveCount(0); // checked in: done with
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/rl-roster.png` });
    await page.evaluate(`showCheckinModal('r1')`);
    await expect(page.locator('#checkin-modal [role="dialog"] .rl-ci')).toContainText('Running late · ~20 min');
    await page.evaluate(`closeCheckinModal()`);
    await page.evaluate(`showCheckinModal('r2')`);
    await expect(page.locator('#checkin-modal [role="dialog"]')).toBeVisible();
    await expect(page.locator('#checkin-modal .rl-ci')).toHaveCount(0);
  });

  test('the "Running late?" WhatsApp leaves out riders who already said so', async ({ page }) => {
    await staff(page);
    expect(await page.evaluate(`_n6cRemRows('g0','late').map(e=>e.id)`)).toEqual(['r2']);
    await page.evaluate(`openRemindSheet('g0','late')`);
    await expect(page.locator('#confirm-modal .rem-row')).toHaveCount(1);
    await expect(page.locator('#confirm-modal .rem-row')).toContainText('Sami Silent');
  });

  test('when every rider not here said so, the sheet still opens on "Running late?" (with nobody to send to), never the 2-hour one', async ({ page }) => {
    await staff(page, [desk[0], { ...desk[1], late_min: 10, late_at: ksa('06:10'), coming_at: ksa('06:10') }, desk[2]]);
    expect(await page.evaluate(`_n6cRemRows('g0','late').length`)).toBe(0);
    expect(await page.evaluate(`_n6cRemRows('g0','late',1).map(e=>e.id).sort()`)).toEqual(['r1', 'r2']);
    await page.evaluate(`openRemindSheet('g0')`);
    await expect.poll(() => page.evaluate('S._rem&&S._rem.kind')).toBe('late');
    await expect(page.locator('#confirm-modal .rem-row')).toHaveCount(0);
  });

  test('"Said running late" in the Filters panel, and status:runninglate (Arabic too)', async ({ page }) => {
    await staff(page);
    const opt = page.locator('#tab-queue select.filter-select option[value="rlsaid"]');
    await expect(opt).toHaveCount(1);
    await expect(opt).toHaveText('Said running late');
    await page.evaluate(`setSfStatus('rlsaid')`);
    await expect(shown(page)).toHaveCount(1);
    await expect(tr(page, 'r1')).toBeVisible();
    await page.locator('#tab-queue .f-clr').click();
    await expect(shown(page)).toHaveCount(3);
    await page.waitForFunction(`typeof _sqParse==='function'`);
    const hits = (q: string) => page.evaluate(`getQueue().filter(e=>_searchHit(e,${JSON.stringify(q)})).map(e=>e.id).sort().join(',')`);
    expect(await hits('status:runninglate')).toBe('r1');
    expect(await hits('حالة:سيتأخر')).toBe('r1');
    expect(await hits('status:waiting')).toBe('r1,r2');
  });

  test('a rider\'s answer arriving on the live channel shows without a reload', async ({ page }) => {
    await staff(page);
    await expect(tr(page, 'r2').locator('.rq-rl')).toHaveCount(0);
    await page.evaluate(`window.__noWiden=false`); // the desk's own path: the event's row merged and painted (the suite turns it off)
    await page.evaluate(`_onRt({table:'queue_entries',eventType:'UPDATE',schema:'public',new:${JSON.stringify({ ...desk[1], late_min: 30, late_at: ksa('06:15'), coming_at: ksa('06:15'), updated_at: ksa('06:15') })},old:{id:'r2'}})`);
    await expect(tr(page, 'r2').locator('.rq-rl')).toHaveText('Running late · ~30 min');
  });

  test('the words are in every language pack: the rider\'s in the rider packs, the desk\'s in the staff packs', () => {
    const pack = (f: string) => JSON.parse(readFileSync(resolve(__dirname, '../lang', f), 'utf8')) as Record<string, string>;
    for (const l of ['ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn', 'ms']) {
      const r = pack(`${l}.json`), s = pack(`staff-${l}.json`);
      for (const k of ['rlBtn', 'rlAsk', 'rlMin', 'rlChip', 'rlOnTime', 'rlNoMore', 'rlNoPlace']) expect((r[k] || '').length, `${l} ${k}`).toBeGreaterThan(2);
      for (const k of ['rlSt', 'rlSaidOpt']) { expect((s[k] || '').length, `staff ${l} ${k}`).toBeGreaterThan(3); expect(r[k], `${l}: ${k} stays out of the rider pack`).toBeUndefined(); }
      expect(r.rlChip, l).toContain('{0}');
    }
  });
});

test.describe('@customer:bookings the running_late migration', () => {
  const sql = readFileSync(resolve(__dirname, '../supabase/migrations/20261119600100_running_late.sql'), 'utf8');
  test('a new function beside booking_coming, the rider\'s own door, and the guard keeps both columns', () => {
    expect(sql).toMatch(/create or replace function public\.booking_late\(p_id text, p_token text, p_session text, p_min integer\)\s*returns jsonb\s*language plpgsql volatile security definer set search_path to 'public'/);
    expect(sql).not.toMatch(/function public\.booking_coming\(/); // its arguments are the website's: untouched
    expect(sql).toMatch(/not _cust_token_ok\(p_id, p_token\)/);
    expect(sql).toMatch(/q\.session_id = p_session and q\.customer_id = p_id and q\.status = 'waiting'/);
    expect(sql).toMatch(/check \(late_min is null or late_min in \(10, 20, 30\)\)/);
    expect(sql).toMatch(/revoke all on function public\.booking_late\(text, text, text, integer\) from public;\s*grant execute on function public\.booking_late\(text, text, text, integer\) to anon, authenticated;/);
    expect(sql).toMatch(/before insert or update of coming_at, late_min, late_at, session_id, status on public\.queue_entries/);
    expect((sql.match(/new\.late_min := (old\.late_min|null); new\.late_at := (old\.late_at|null);/g) || []).length).toBe(3);
    expect(sql).toMatch(/q\.session_id = p_session and q\.customer_id = p_id and q\.status in \('active', 'done'\)\) then\s*return jsonb_build_object\('ok', false, 'error', 'closed'\);/); // a party partly checked in
    expect(sql).toContain("values ('20261119600100', 'running_late')");
  });
});
