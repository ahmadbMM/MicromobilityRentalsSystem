import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Report a bike problem (new features build F15, 2026-11-13). A rider who is checked in with a bike has one button on the
// ticket, until 3 hours after the session. It opens a centred pop-up (bike-report.js, fetched on the first tap): a short
// list of faults and an optional note, sent through bike_report (migration 20261114081500). Staff see the report in the
// Workshop's own list behind a "Bike reports" pill and mark it resolved. A second report inside the limit is refused
// without a word. All Supabase traffic is stubbed.

const DAY = '2099-02-01'; // a circuit night, 18:00 - 20:00 in Riyadh
const night = { id: DAY, day: 'Sunday', session_date: DAY, capacity: 20, status: 'open', created_at: 1, location: 'JCC', bike_slots: '{"_time":"18:00 - 20:00","_total":20}' };
const bikes = [{ id: 'k1', name: 'H-12', type: 'Hybrid', status: 'in-use' }, { id: 'k2', name: 'H-14', type: 'Hybrid', status: 'in-use' }];
// bike_report_at: null is a booking read from a database that has the column; `bare` drops it (a database before the migration).
const bk = (o: Record<string, unknown> = {}) => ({
  id: 'q1', session_id: DAY, session_date: DAY, session_day: 'Sunday', name: 'Spec Rider', customer_id: 'c1', queue_num: 7, status: 'active', paid: true, price: 75,
  type_preference: 'Hybrid', registered_at: '2099-01-01T10:00:00Z', checked_in_at: '2099-02-01T14:20:00Z', assigned_bike_id: 'k1', bike_report_at: null, ...o,
});
const bare = (r: Record<string, unknown>) => { const rest = { ...r }; delete rest.bike_report_at; return rest; };

type Sent = { p_id?: string; p_token?: string; p_booking?: string; p_fault?: string; p_note?: string | null; p_bike?: string };
/** Signs the rider in on Bookings at a fixed moment. bike_report answers as the function does: it stamps the booking, so a
 *  reload reads the report's time back through my_bookings. `answer` replaces that with a fixed reply, or 'absent' leaves
 *  the stub's own answer for a function the database does not have (PGRST202). */
async function rider(page: Page, rows: Record<string, unknown>[], at: string, answer?: Record<string, unknown> | 'absent') {
  const calls: Sent[] = [];
  await page.clock.setFixedTime(new Date(at));
  await stubSupabase(page, { sessions: [night], 'rpc:list_sessions': [night], bikes, customers: [], queue_entries: rows, 'rpc:my_bookings': rows });
  if (answer !== 'absent') {
    await page.route('**/rest/v1/rpc/bike_report*', async (r) => {
      const b = (r.request().postDataJSON() || {}) as Sent;
      calls.push(b);
      const stamp = new Date(at).toISOString();
      if (!answer) rows.forEach((x) => { if (x.id === b.p_booking) x.bike_report_at = stamp; });
      await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(answer || { ok: true, at: stamp }) });
    });
  }
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('myrides')`);
  await expect(page.locator('#tab-myrides .ticket-card').first()).toBeVisible();
  return calls;
}
const btn = (page: Page) => page.locator('#tab-myrides .ticket-card .brp-btn');
const chip = (page: Page) => page.locator('#tab-myrides .ticket-card .brp-ok');
const dlg = (page: Page) => page.locator('#brp-modal [role="dialog"]');
const fault = (page: Page, name: string) => dlg(page).locator('.brp-opt', { hasText: name }).locator('input[name="brp-fault"]');
const repaint = (page: Page, at: string) => page.clock.setFixedTime(new Date(at)).then(() => page.evaluate(`renderMyRides()`));

test.describe('@customer:bookings Report a bike problem on the ticket', () => {
  test('no button without a bike: not before check-in, not checked in without one, not on a database before the migration', async ({ page }) => {
    // booked, with a bike already reserved for the booking: not checked in yet
    await rider(page, [bk({ status: 'waiting', checked_in_at: null })], '2099-02-01T17:30:00+03:00');
    await expect(btn(page)).toHaveCount(0);
    // checked in, the bike not handed over yet
    await page.evaluate(`Object.assign(S.queue.find(e=>e.id==='q1'),{status:'active',assignedBikeId:null});renderMyRides()`);
    await expect(page.locator('#tab-myrides .ticket-card .cu-cue')).toHaveText('Checked in. Your bike is being handed over.');
    await expect(btn(page)).toHaveCount(0);
    // the bike is on the booking: one button, and not one word more with it
    await page.evaluate(`S.queue.find(e=>e.id==='q1').assignedBikeId='k1';renderMyRides()`);
    await expect(btn(page)).toHaveCount(1);
    await expect(btn(page)).toHaveText('Report a bike problem');
    expect(await page.locator('#tab-myrides .ticket-card .brp-row').evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === 3 && (n.textContent || '').trim()).length + el.querySelectorAll(':scope > :not(button)').length)).toBe(0);
    // a booking read without the column (the migration has not run): nothing
    await page.evaluate(`S.queue.find(e=>e.id==='q1').bikeReportAt=undefined;renderMyRides()`);
    await expect(btn(page)).toHaveCount(0);
  });

  test('a database before the migration shows nothing on a rider who is on a bike', async ({ page }) => {
    await rider(page, [bare(bk())], '2099-02-01T18:30:00+03:00');
    await expect(page.locator('#tab-myrides .ticket-card .cu-cue')).toHaveText('On the bike: H-12');
    await expect(btn(page)).toHaveCount(0);
    await expect(chip(page)).toHaveCount(0);
  });

  test('the button stays after the ride, until 3 hours after the session ends', async ({ page }) => {
    await rider(page, [bk({ status: 'done', ride_duration: 80, checked_out_at: '2099-02-01T16:40:00Z' })], '2099-02-01T19:45:00+03:00');
    await expect(btn(page)).toHaveCount(1);
    await repaint(page, '2099-02-01T22:59:00+03:00');
    await expect(btn(page)).toHaveCount(1); // a minute before 3 hours after 20:00
    await repaint(page, '2099-02-01T23:00:00+03:00');
    await expect(page.locator('#tab-myrides .ticket-card').first()).toBeVisible();
    await expect(btn(page)).toHaveCount(0);
  });

  test('the pop-up is centred, lists the faults and an optional note, and Send stores the report', async ({ page }) => {
    const rows = [bk()];
    const calls = await rider(page, rows, '2099-02-01T18:30:00+03:00');
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('bike-report.js')) asked.push(r.url()); });
    const shot = async (name: string, loc = page.locator('#tab-myrides .ticket-card').first()) => { if (process.env.SHOT_DIR) await loc.screenshot({ path: `${process.env.SHOT_DIR}/brp-${name}-${test.info().project.name}.png` }); };
    await shot('ticket-button');
    await btn(page).click();
    await expect(dlg(page)).toBeVisible();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\/bike-report\.js\?v=[0-9a-f]{10}$/); // its own file, with the build's stamp
    await expect(dlg(page).locator('#brp-title')).toHaveText('Report a bike problem');
    await expect(dlg(page).locator('input[name="brp-fault"]')).toHaveCount(7);
    await expect(dlg(page).locator('.brp-opt')).toHaveText(['Brakes', 'Gears', 'Tyre', 'Chain', 'Saddle', 'Lights', 'Other']);
    await expect(dlg(page).locator('input[name="brp-bike"]')).toHaveCount(0); // one bike: nothing to choose
    await expect(dlg(page).getByLabel('Note (optional)')).toHaveAttribute('maxlength', '300');
    await expect(dlg(page).getByLabel('Note (optional)')).toHaveCSS('font-size', '16px'); // the riders' own field size: a phone does not zoom in on it
    // centred at every width, never a sheet at the foot
    const box = (await dlg(page).boundingBox())!, vp = page.viewportSize()!;
    expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - vp.height / 2)).toBeLessThan(2);
    expect(box.height).toBeLessThanOrEqual(vp.height);
    await shot('popup', page.locator('#brp-modal .modal-backdrop'));
    // nothing picked: said in the pop-up, and nothing sent
    await dlg(page).locator('.brp-send').click();
    await expect(dlg(page).locator('#brp-err')).toHaveText('Choose what is wrong.');
    expect(calls).toHaveLength(0);
    await fault(page, 'Brakes').check();
    await expect(dlg(page).locator('#brp-err')).toHaveText('');
    await dlg(page).getByLabel('Note (optional)').fill('  The rear brake does not bite  ');
    await dlg(page).locator('.brp-send').click();
    await expect(dlg(page)).toHaveCount(0);
    expect(calls).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_booking: 'q1', p_fault: 'brakes', p_note: 'The rear brake does not bite', p_bike: 'k1' }]);
    // no bar after it: one quiet chip where the button was
    await expect(chip(page)).toHaveText('Problem reported');
    await expect(btn(page)).toHaveCount(0);
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0);
    await shot('ticket-chip');
    // read back from the booking after a reload
    await page.reload();
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    await expect(chip(page)).toHaveText('Problem reported');
    await expect(btn(page)).toHaveCount(0);
    // ten minutes on, the button is back (a new fault can show later in the ride)
    await repaint(page, '2099-02-01T18:40:01+03:00');
    await expect(btn(page)).toHaveCount(1);
    await expect(chip(page)).toHaveCount(0);
    expect(calls).toHaveLength(1);
  });

  test('a second report within the limit is refused quietly: the pop-up closes as after a report taken, with no error', async ({ page }) => {
    // the first report went eleven minutes ago, so the button is back; the server still refuses (its limits are its own)
    const calls = await rider(page, [bk({ bike_report_at: '2099-02-01T15:19:00Z' })], '2099-02-01T18:30:00+03:00', { ok: false, error: 'limit', at: '2099-02-01T15:19:00Z' });
    await btn(page).click();
    await fault(page, 'Gears').check();
    await dlg(page).locator('.brp-send').click();
    await expect(dlg(page)).toHaveCount(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].p_fault).toBe('gears');
    expect(calls[0].p_note).toBeNull();
    await expect(chip(page)).toHaveText('Problem reported');
    await expect(btn(page)).toHaveCount(0);
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0);
    await expect(page.locator('#brp-err')).toHaveCount(0);
  });

  test('a database without the function: the pop-up closes, the button goes, and no error is shown', async ({ page }) => {
    await rider(page, [bk()], '2099-02-01T18:30:00+03:00', 'absent');
    await btn(page).click();
    await fault(page, 'Other').check();
    await dlg(page).locator('.brp-send').click();
    await expect(dlg(page)).toHaveCount(0);
    await expect(btn(page)).toHaveCount(0);
    await expect(chip(page)).toHaveCount(0);
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0);
  });

  test('a failed send stays in the pop-up, says so there, and can be sent again', async ({ page }) => {
    await rider(page, [bk()], '2099-02-01T18:30:00+03:00', 'absent');
    let n = 0;
    await page.route('**/rest/v1/rpc/bike_report*', async (r) => {
      n++;
      if (n === 1) return r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'XX000', message: 'boom' }) });
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, at: '2099-02-01T15:30:00Z' }) });
    });
    await btn(page).click();
    await fault(page, 'Chain').check();
    await dlg(page).locator('.brp-send').click();
    await expect(dlg(page).locator('#brp-err')).toHaveText('We could not send it. Please try again.');
    await expect(dlg(page).locator('.brp-send')).toBeEnabled();
    await dlg(page).locator('.brp-send').click();
    await expect(dlg(page)).toHaveCount(0);
    await expect(chip(page)).toHaveText('Problem reported');
    expect(n).toBe(2);
  });

  test('a booking with two bikes asks which one, and Close or Escape sends nothing', async ({ page }) => {
    const rows = [bk(), bk({ id: 'q2', name: 'Maya Rider', queue_num: 8, assigned_bike_id: 'k2' })];
    const calls = await rider(page, rows, '2099-02-01T18:30:00+03:00');
    await expect(btn(page)).toHaveCount(1); // one button for the booking
    await btn(page).click();
    await expect(dlg(page).getByRole('radiogroup', { name: 'Bike', exact: true }).locator('.brp-opt')).toHaveText(['H-12 · Spec Rider', 'H-14 · Maya Rider']);
    await expect(dlg(page).locator('input[name="brp-bike"]').first()).toBeChecked();
    await dlg(page).locator('.brp-close').click();
    await expect(dlg(page)).toHaveCount(0);
    await btn(page).click();
    await expect(dlg(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg(page)).toHaveCount(0);
    expect(calls).toHaveLength(0);
    await btn(page).click();
    await dlg(page).locator('.brp-opt', { hasText: 'H-14' }).locator('input').check();
    await fault(page, 'Tyre').check();
    await dlg(page).locator('.brp-send').click();
    await expect(dlg(page)).toHaveCount(0);
    expect(calls).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_booking: 'q2', p_fault: 'tyre', p_note: null, p_bike: 'k2' }]);
    // the other rider's bike can still be reported: the button stays until both have been
    await expect(btn(page)).toHaveCount(1);
  });

  test('its words are in all ten languages, and Arabic reads right to left', async ({ page }) => {
    await rider(page, [bk()], '2099-02-01T18:30:00+03:00');
    await btn(page).click();
    await expect(dlg(page)).toBeVisible();
    const rowsOk = await page.evaluate(`Object.keys(BRP_T).length>=12&&Object.values(BRP_T).every(r=>Array.isArray(r)&&r.length===BRP_LANGS.length&&r.every(x=>typeof x==='string'&&x.trim()))&&BRP_LANGS.length===10&&BRP_FAULTS.every(k=>BRP_T[k])`);
    expect(rowsOk).toBe(true);
    // Latin digits in every language, and no emoji
    expect(await page.evaluate(`Object.values(BRP_T).flat().every(x=>!/[\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F\\u09E6-\\u09EF]/.test(x)&&!/\\p{Extended_Pictographic}/u.test(x))`)).toBe(true);
    await page.keyboard.press('Escape');
    await page.evaluate(`setLang('ar')`);
    await expect(btn(page)).toHaveText('الإبلاغ عن مشكلة في الدراجة');
    await btn(page).click();
    await expect(dlg(page).locator('#brp-title')).toHaveText('الإبلاغ عن مشكلة في الدراجة');
    await expect(dlg(page).locator('.brp-opt').first()).toHaveText('المكابح');
    await expect(dlg(page).locator('.brp-send')).toHaveText('إرسال البلاغ');
    expect(await dlg(page).evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
  });
});

// ── Staff: the Workshop's list ───────────────────────────────────────────────
const sessions = [{ id: '2099-05-05', day: 'Tuesday', session_date: '2099-05-05', capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}' }];
const job = (o: Record<string, unknown> = {}) => ({
  id: 42, created_at: '2099-05-01T09:30:00Z', customer_id: null, name: 'Sara Ali', phone: '+966551234567', email: null,
  service: 'full-service', service_label: 'Full service', price_quoted: 409, parts: [], lane: 'dropoff', pickup_address: null, preferred_date: '2099-05-06', preferred_time: '17:00',
  bike: 'ALVAS DA54 AL', notes: null, lang: 'en', status: 'new', scheduled_for: null, price_final: null, staff_notes: null, updated_at: '2099-05-01T09:30:00Z', updated_by: 'website', ...o,
});
const report = (o: Record<string, unknown> = {}) => ({
  id: 5, created_at: '2099-05-05T18:40:00Z', bike_id: 'k1', booking_id: 'q9', customer_id: 'c9', session_id: '2099-05-05', fault: 'brakes', note: 'The rear brake does not bite',
  status: 'open', resolved_at: null, resolved_by: null, updated_at: '2099-05-05T18:40:00Z', ...o,
});
const booking = { id: 'q9', session_id: '2099-05-05', session_date: '2099-05-05', session_day: 'Tuesday', name: 'Lina Haddad', customer_id: 'c9', queue_num: 4, status: 'done', paid: true, price: 75, type_preference: 'Hybrid', registered_at: '2099-05-01T10:00:00Z', assigned_bike_id: 'k1', checked_in_at: '2099-05-05T18:05:00Z' };
const account = { id: 'c9', name: 'Lina Haddad', phone: '+966500000009', email: 'lina@example.com', created_at: '2099-01-01T10:00:00Z' };

type Write = { method: string; url: string; body: unknown };
async function workshop(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions, queue_entries: [booking], customers: [account], bikes, workshop_jobs: [job()], workshop_job_events: [], ...fx });
  await unlockStaff(page);
  const writes: Write[] = [];
  page.on('request', (r) => {
    if (/\/rest\/v1\/bike_reports(\?|$)/.test(r.url()) && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) {
      let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
      writes.push({ method: r.method(), url: decodeURIComponent(r.url()), body });
    }
  });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('workshop')`);
  await expect(page.locator('#tab-workshop [data-ws-filter="new"]')).toBeVisible();
  return writes;
}
const pill = (page: Page) => page.locator('#tab-workshop [data-ws-filter="reports"]');
const row = (page: Page, id: number) => page.locator(`#ws-list .wsr-row[data-br-id="${id}"]`);

test.describe('@staff:workshop Bike reports in the Workshop list', () => {
  test('a report is a row in the Workshop list: bike, rider, booking, fault, note, time, open or resolved', async ({ page }) => {
    await workshop(page, { bike_reports: [report(), report({ id: 3, created_at: '2099-05-04T18:00:00Z', bike_id: 'k2', booking_id: null, customer_id: null, fault: 'lights', note: null, status: 'resolved', resolved_at: '2099-05-04T19:00:00Z', resolved_by: 'Omar', updated_at: '2099-05-04T19:00:00Z' })] });
    // one more pill in the list that is already there, counting the open ones; the rail's badge counts them with the new requests
    await expect(pill(page)).toHaveText('Bike reports (1)');
    const item = page.locator('#staff-tab-nav .tab-btn[data-stab="workshop"] .tab-badge');
    await expect(item).toHaveText('2');
    await expect(item).toHaveAttribute('title', '1 new workshop requests · 1 open bike reports');
    await expect(page.locator('#ws-list .ws-row')).toHaveCount(1); // still the requests until the pill is picked
    await expect(page.locator('#ws-list .wsr-row')).toHaveCount(0);
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#ws-list .wsr-row')).toHaveCount(2);
    await expect(page.locator('#ws-list .wsr-row').first()).toHaveAttribute('data-br-id', '5'); // open ones lead
    const r = row(page, 5);
    await expect(r).toHaveCSS('display', 'block'); // stacked like every Workshop row (its class is its own: .br-row is the several-bikes return dialog's)
    await expect(r.locator('.ca-name')).toHaveText('H-12 · Brakes');
    await expect(r.locator('.ca-status')).toHaveText('Open');
    await expect(r.locator('.ca-when')).toContainText('Sent');
    await expect(r.locator('.ca-when')).toContainText('2099');
    await expect(r.locator('.ca-kv').filter({ hasText: 'Rider' }).locator('b')).toHaveText('Lina Haddad');
    await expect(r.locator('.ca-kv').filter({ hasText: 'Booking' }).locator('b')).toContainText('#4');
    await expect(r.locator('.ws-line')).toHaveText('Rider’s noteThe rear brake does not bite');
    await expect(r.locator('.br-set')).toHaveText('Mark resolved');
    if (process.env.SHOT_DIR) await page.locator('#tab-workshop').screenshot({ path: `${process.env.SHOT_DIR}/brp-staff-${test.info().project.name}.png` });
    // a resolved one whose booking and account are gone: the bike and the fault still stand
    const done = row(page, 3);
    await expect(done.locator('.ca-name')).toHaveText('H-14 · Lights');
    await expect(done.locator('.ca-status')).toHaveText('Resolved');
    await expect(done.locator('.ca-when')).toContainText('by Omar');
    await expect(done.locator('.br-set')).toHaveText('Reopen');
    // no Select and no Export on the reports; the search narrows them
    await expect(page.locator('#tab-workshop .lt-sel-btn')).toHaveCount(0);
    await expect(page.locator('#tab-workshop .lt-csv')).toHaveCount(0);
    const fold = page.locator('[data-srch="ws"] .srch-btn'); // a phone folds the search into a button
    if (await fold.isVisible()) await fold.click();
    await page.locator('#ws-search-input').fill('lights');
    await expect(page.locator('#ws-list .wsr-row')).toHaveCount(1);
    await expect(row(page, 3)).toBeVisible();
    await page.locator('#ws-search-input').fill('nothing like it');
    await expect(page.locator('#ws-list')).toContainText('No request matches your search.');
  });

  test('Mark resolved writes the status signed with the operator, and Reopen opens it again', async ({ page }) => {
    const writes = await workshop(page, { bike_reports: [report()] });
    await pill(page).click();
    await row(page, 5).locator('.br-set').click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].url).toContain('id=eq.5');
    expect(writes[0].body).toEqual({ status: 'resolved', resolved_by: 'Spec Staff' });
    await expect(row(page, 5).locator('.ca-status')).toHaveText('Resolved');
    await expect(pill(page)).toHaveText('Bike reports (0)');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="workshop"] .tab-badge')).toHaveText('1'); // the new request alone
    await row(page, 5).locator('.br-set').click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].body).toEqual({ status: 'open', resolved_by: null });
    await expect(row(page, 5).locator('.ca-status')).toHaveText('Open');
    await expect(pill(page)).toHaveText('Bike reports (1)');
  });

  test('staff who may only look at the Workshop get no button', async ({ page }) => {
    await workshop(page, { bike_reports: [report()] });
    await pill(page).click();
    await expect(row(page, 5).locator('.br-set')).toHaveCount(1);
    await page.evaluate(`S._myEdit=['queue'];renderWorkshop()`);
    await expect(row(page, 5)).toBeVisible();
    await expect(row(page, 5).locator('.br-set')).toHaveCount(0);
  });

  test('before the migration there is no pill, and the Workshop works as it did', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (/\/rest\/v1\/bike_reports(\?|$)/.test(r.url())) asked.push(r.method()); });
    await workshop(page); // no bike_reports fixture: the stub answers as a database without the table (PGRST205)
    await expect(page.locator('#ws-list .ws-row')).toHaveCount(1);
    await expect(pill(page)).toHaveCount(0);
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="workshop"] .tab-badge')).toHaveText('1');
    await expect(page.locator('#toast-container .toast.error')).toHaveCount(0);
    // not asked again by the list's own repaints
    await page.evaluate(`_wsLoad()`);
    await page.evaluate(`renderWorkshop()`);
    await expect(page.locator('#ws-list .ws-row')).toHaveCount(1);
    expect(asked.filter((m) => m === 'GET')).toHaveLength(1);
  });

  test('an empty list says so', async ({ page }) => {
    await workshop(page, { bike_reports: [] });
    await expect(pill(page)).toHaveText('Bike reports (0)');
    await pill(page).click();
    await expect(page.locator('#ws-list')).toContainText('No bike reports.');
  });
});
