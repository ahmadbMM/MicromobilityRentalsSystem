import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';
import { readFileSync } from 'node:fs';

// The Blood Donation event (the owner, 2026-10-13; moved 2026-11-03 to Thursday 5 November, 17:00-23:00): open to
// everyone, no bikes. The hosts' logos and the poster's short rules on the card, the whole poster in Arabic and English
// in a pop-up read from its own file. No ID or Iqama number is asked for.

const BD = '2099-11-05-bd';
const blood = {
  id: BD, session_date: '2099-11-05', day: 'Thursday', status: 'open', capacity: 500, created_at: 1,
  event_kind: 'community', ride_kind: 'blood', needs_approval: false, hide_queue: true, spots: 500, open_to_all: true,
  paid_ride: false, location: 'JCC', meet_url: 'https://maps.app.goo.gl/U77D5RvQPagN8Yke8', bike_slots: '{"_time":"17:00 - 23:00"}',
};

test.describe('Blood Donation event', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page, { sessions: [blood] });
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(() => typeof (window as unknown as Record<string, unknown>)._bldLive === 'function');
    await page.evaluate(() => { const w = window as unknown as Record<string, (() => void) | undefined>; w.renderLandingAvail?.(); });
  });

  test('the kind is known, needs no bike, and its bookings read as not cycling', async ({ page }) => {
    const r = await page.evaluate((s) => {
      const w = window as unknown as Record<string, (...a: unknown[]) => unknown>;
      return { kind: w._rideKind(s), bike: w._needsBike(s), name: w._evName(s), steps: w._regSteps(s), ev: w._evOf(s), community: w._evMatch(s, 'community') };
    }, blood);
    expect(r).toEqual({ kind: 'blood', bike: false, name: 'Blood Donation', steps: [1, 2, 3], ev: 'blood', community: false });
  });

  test('the pop-up shows the whole poster in English and Arabic, and must be confirmed', async ({ page }) => {
    await page.evaluate(() => { (window as unknown as Record<string, () => void>).showBloodInfo(); });
    const box = page.locator('.bld-info-box');
    await expect(box).toBeVisible();
    await expect(box.locator('.x-close')).toHaveCount(0);
    await expect(box.locator('#bld-info-ok')).toHaveText(/read this/);
    await expect(box.locator('.bld-sec')).toHaveCount(15);
    await expect(box.locator('.bld-poster')).toHaveAttribute('dir', 'ltr');
    await expect(box).toContainText('at least 50 kg');
    await box.locator('.bld-lang button[data-l="ar"]').click();
    await expect(box.locator('.bld-poster')).toHaveAttribute('dir', 'rtl');
    await expect(box).toContainText('شروط التبرع بالدم');
    await expect(box.locator('.bld-plate img')).toBeVisible();
    await expect(box.locator('a.bld-info-pdf')).toHaveAttribute('href', '/assets/blood-donation-poster.pdf');
  });

  test('viewed from a card, the pop-up simply closes', async ({ page }) => {
    await page.evaluate(() => { (window as unknown as Record<string, () => void>)._bldInfoView(); });
    const box = page.locator('.bld-info-box');
    await expect(box.locator('.bld-sec')).toHaveCount(15);
    await box.locator('#bld-info-ok').click();
    await expect(box).toHaveCount(0);
  });

  test('the poster file says the same in both languages, and the step never asks for an ID number', async () => {
    const d = JSON.parse(readFileSync('assets/blood-info.json', 'utf8'));
    expect(d.ar.sections.map((s: { i?: string[] }) => (s.i || []).length)).toEqual(d.en.sections.map((s: { i?: string[] }) => (s.i || []).length));
    const src = readFileSync('app.src.html', 'utf8');
    const step = src.slice(src.indexOf('function _bldPanelHtml'), src.indexOf('function _bldRetry'));
    expect(step).not.toMatch(/national_id|nationalId/);
  });
});

// Words that would mean a price on this event. The reward's own words ("free ride") are lower case on purpose.
const NO_PRICE = /\bFree\b|\bTotal\b|⃁|\bSAR\b|\bPaid\b|\bPending\b/;
const profile = (x: Record<string, unknown> = {}) => [{ id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', birth_date: '1995-05-05', height: 165, type_preference: 'Any', nationality: 'Saudi Arabia', ...x }];
const custFx = (x: Record<string, unknown> = {}) => ({
  sessions: [blood], queue_entries: [], 'rpc:customer_profile': profile(), 'rpc:customer_blood_type': 'O+', 'rpc:customer_set_blood_type': true, 'rpc:customer_update_profile': true,
  'rpc:customer_emergency': [{ emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' }], 'rpc:customer_blood_rewards': [], ...x,
});

test.describe('@customer:blood Blood Donation registration', () => {
  test('details filled in, the poster confirmed, the hosts agreed to, and the booking carries the agreement', async ({ page }) => {
    const sent: string[] = [];
    page.on('request', (r) => { const m = /rpc\/(customer_update_profile|customer_set_blood_type)/.exec(r.url()); if (m) sent.push(m[1]); });
    await stubSupabase(page, custFx());
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    const rows = await captureBookingRows(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
    await expect(page.locator('.bld-wrap .bld-plate img')).toBeVisible();
    await expect(page.locator('.bld-wrap .bld-sum > *')).toHaveCount(4);
    await expect(page.locator('body')).not.toHaveClass(/bld-skin/);
    await page.locator('.bld-card').click();
    // one look from the first step, under the hosts' plate
    await expect(page.locator('body')).toHaveClass(/bld-skin/);
    await expect(page.locator('#tab-register .bld-head .bld-plate img')).toBeVisible();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect(page.locator('#run-first')).toHaveValue('Sara');
    await expect(page.locator('#bld-phone')).toHaveValue('+966500000001');
    await expect(page.locator('#bld-bt')).toHaveValue('O+');
    await expect(page.locator('#bld-nat')).toHaveValue('Saudi Arabia');
    // a blank blood type is refused
    await page.locator('#bld-bt').selectOption('');
    await page.locator('#bld-next').click();
    await expect(page.locator('.bld-info-box')).toHaveCount(0);
    // the poster must be confirmed: no close button, and Back books nothing
    await page.locator('#bld-bt').selectOption('A+');
    await page.locator('#bld-next').click();
    await expect(page.locator('.bld-info-box .bld-sec').first()).toBeVisible();
    await expect(page.locator('.bld-info-box .x-close')).toHaveCount(0);
    await page.locator('#bld-info-ok').click();
    // the hospital and the ministries, named; never "the race"
    const sg = page.locator('#share-gate .sg-box');
    await expect(sg).toContainText('King Fahd Armed Forces Hospital');
    await expect(sg).toContainText('Ministry of Sport');
    await expect(sg).toContainText('Blood type');
    await expect(sg).not.toContainText('race');
    await sg.locator('.wg-cb').check();
    await sg.locator('.pg-btn').click();
    // its own agreement: a medical procedure by the hosts' team, not an activity; one person, no "on behalf of"; the partners not released
    const wv = page.locator('#reg-waiver');
    await expect(wv).toContainText('Donor agreement');
    await expect(wv).toContainText('medical procedure carried out by the event’s medical team');
    await expect(wv).toContainText('I can withdraw at any time');
    await expect(wv).toContainText('I have read this and I agree');
    expect(await wv.innerText()).not.toMatch(/waiver|activity|take part|own risk|fracture|on behalf|partners|\bride waiver\b/i);
    await expect(page.locator('#wv-why')).toContainText('Tick the agreement');
    await page.locator('#reg-waiver-cb').check();
    // no price, no total, nothing to pay: the review
    await expect(page.locator('#tab-register')).not.toContainText(NO_PRICE);
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(1);
    // and the ticket: the donor's number, the plate, the rules, no price
    const tk = page.locator('#tab-register .ticket-card.th-blood');
    await expect(tk.locator('.bld-plate img')).toBeVisible();
    await expect(tk).toContainText('Donor number');
    await expect(tk.locator('.bld-sum > *')).toHaveCount(4);
    await expect(page.locator('#tab-register')).not.toContainText(NO_PRICE);
    await expect(page.locator('#tab-register')).toContainText('registration desk');
    expect(rows[0]).toMatchObject({ session_id: BD, type_preference: 'None', price: 0, share_ok: true, waiver_version: 'blood-2026-11-v1' });
    expect(sent).toEqual(['customer_set_blood_type']);
  });

  test('an account under 18 is told and cannot go on', async ({ page }) => {
    await stubSupabase(page, custFx({ 'rpc:customer_profile': profile({ birth_date: '2090-01-01' }) }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '2090-01-01' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
    await page.locator('.bld-card').click();
    await expect(page.locator('#bld-age-t')).toHaveText('18 or over only');
    await expect(page.locator('#bld-bt')).toHaveCount(0);
  });

  test('the ticket shows the rules, then the free ride once staff confirm the donation', async ({ page }) => {
    const row = { id: 'q1', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 7, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'done', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c1', donated_at: '2099-11-05T16:00:00Z' };
    await stubSupabase(page, custFx({ queue_entries: [row], 'rpc:customer_entries': [row], 'rpc:customer_blood_rewards': [{ entry_id: 'q1', code: 'BD-1A2B3C4D', expires_at: '2099-12-05', used: false }] }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    const html = await page.evaluate((s) => {
      const w = window as unknown as Record<string, (...a: unknown[]) => string>;
      return w._bldTkHtml({ id: 'q1', status: 'waiting' }, s, false);
    }, blood);
    
    expect(html).toContain('bld-sum');
    expect(html).toContain('bld-rw-q1');
    await expect.poll(() => page.evaluate('(S._bldR||[]).length')).toBe(1);
    const again = await page.evaluate((s) => (window as unknown as Record<string, (...a: unknown[]) => string>)._bldTkHtml({ id: 'q1', status: 'done' }, s, true), blood);
    expect(again).toContain('BD-1A2B3C4D');
    expect(again).not.toContain('bld-sum');
  });

  test('My Bookings: the ticket carries the plate, the free ride code and no price, and nothing to edit or move', async ({ page }) => {
    const row = { id: 'q1', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 7, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c1', waiver_at: '2099-11-01T10:00:00Z', waiver_version: 'activity-2026-10-v3', data_share_at: '2099-11-01T10:00:00Z' };
    await stubSupabase(page, custFx({ queue_entries: [row], 'rpc:customer_queue': [row], 'rpc:customer_entries': [row], 'rpc:customer_blood_rewards': [{ entry_id: 'q1', code: 'BD-1A2B3C4D', expires_at: '2099-12-05', used: false }] }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card.th-blood');
    await expect(tk.locator('.bld-rw')).toContainText('BD-1A2B3C4D');
    await expect(tk.locator('.bld-plate img')).toBeVisible();
    await expect(tk).toContainText('Donor number');
    await expect(tk).not.toContainText(NO_PRICE);
    await expect(tk.locator('.cu-tk-total')).toHaveCount(0);
    await expect(tk.locator('.cu-tr-money')).toHaveCount(0);
    await expect(tk).not.toContainText('Reschedule');
    await expect(tk.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(tk.getByRole('button', { name: /Cancel/ })).toHaveCount(1);
    // the page around it is My Bookings, not the event
    await expect(page.locator('body')).not.toHaveClass(/bld-skin/);
  });
});

test.describe('@staff:bookings Blood Donation', () => {
  test('Donated is offered once someone is checked in, and sends the confirmation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = (id: string, status: string, donated: string | null) => ({
      id, session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: Number(id.slice(1)), name: 'Donor ' + id,
      phone: '055000000' + id.slice(1), type_preference: 'None', size: '', status, paid: false, price: 0,
      registered_at: '2099-11-01T10:00:00Z', customer_id: 'c' + id, donated_at: donated,
    });
    const calls: Record<string, unknown>[] = [];
    await stubSupabase(page, { sessions: [blood], bikes: [], queue_entries: [row('r1', 'waiting', null), row('r2', 'active', null), row('r3', 'active', '2099-11-05T15:00:00Z')], customers: [{ id: 'cr1', blood_type: 'O+' }, { id: 'cr2', blood_type: 'AB-' }, { id: 'cr3', blood_type: 'unknown' }] });
    await page.route(/\/rest\/v1\/rpc\/staff_blood_donated/, (route) => {
      calls.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, donated: true, code: 'BD-1A2B3C4D', expires_at: '2099-12-05' }) });
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${BD}';renderStaffQueue()`);
    const tq = page.locator('#tab-queue .queue-table');
    await expect(tq.locator('thead')).toContainText('Donated');
    await expect(tq.locator('thead')).toContainText('Blood type');
    await expect(tq.locator('thead')).toContainText('Donor');
    // each account's blood type, read with the list
    await expect(tq.locator('tbody .bld-bt')).toHaveText(['O+', 'AB\u2212', 'Not known']);
    // no bike words and no money at the desk
    const panel = page.locator('#tab-queue');
    expect(await panel.innerText()).not.toMatch(/on bike|Return Bike|# of Riders|\bPaid\b|Payment|⃁|\bSAR\b|Walk-in|Add rider/i);
    await expect(panel).toContainText('Checked in');
    await expect(tq.getByRole('button', { name: 'Finished' })).toHaveCount(2);
    await expect(page.locator('.walkin-head')).toHaveCount(0);
    await expect(tq.getByRole('button', { name: 'Mark donated' })).toHaveCount(1);
    await expect(tq.locator('tbody .rr-chip.rr-yes')).toHaveText(['Donated']);
    await tq.getByRole('button', { name: 'Mark donated' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_entry_id: 'r2', p_on: true });
    await expect(tq.locator('tbody .rr-chip.rr-yes')).toHaveCount(2);
  });

  test('the phone card says the same: blood type and Donated, no bike line, no add-ons', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const row = { id: 'r2', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 2, name: 'Donor r2', phone: '0550000002', type_preference: 'None', size: '', status: 'active', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'cr2', donated_at: null };
    await stubSupabase(page, { sessions: [blood], bikes: [], queue_entries: [row], customers: [{ id: 'cr2', blood_type: 'B+' }] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${BD}';renderStaffQueue()`);
    const card = page.locator('#tab-queue .q-card').first();
    await expect(card).toContainText('Blood type');
    await expect(card.locator('.bld-bt')).toHaveText('B+');
    await expect(card.getByRole('button', { name: 'Mark donated' })).toBeVisible();
    await expect(card).not.toContainText('No bike');
    await expect(card.locator('.rq-cad')).toHaveCount(0);
  });

  test('someone booked without the agreement is asked for it in the same words, and the desk reads the same text', async ({ page }) => {
    const row = { id: 'q1', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 7, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c1', waiver_at: null, waiver_version: null };
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (/rpc\/customer_accept_waiver/.test(r.url())) sent.push(r.postDataJSON()); });
    await stubSupabase(page, custFx({ queue_entries: [row], 'rpc:customer_queue': [row], 'rpc:customer_entries': [row], 'rpc:customer_accept_waiver': 1 }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S._wg={sid:'${BD}',ok:false,saving:false,net:false};renderWaiverGate()`);
    const box = page.locator('.wg-box');
    await expect(box.locator('.fx-kicker')).toHaveText('Agreement needed');
    await expect(box.locator('#wg-title')).toHaveText('Donor agreement');
    await expect(box.locator('#wg-sub')).toContainText('You’re registered for this event');
    expect(await box.innerText()).not.toMatch(/waiver|activity|take part|own risk|fracture|on behalf/i);
    await box.locator('.wg-cb').check();
    await box.locator('.pg-btn').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_session_id: BD, p_version: 'blood-2026-11-v1' });
  });
});

// Hidden until the session exists (the user, 2026-11-03: "dont make the blood donation event visible until i tell you").
test.describe('@customer:reserve Blood Donation before its session exists', () => {
  test('no card, no way in by link, and the notice names no event or host', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [] });
    await page.goto('/?ev=blood&session=2099-11-05-bd');
    await waitForSb(page);
    await page.evaluate('goLanding()');
    await page.waitForTimeout(300);
    await expect(page.locator('.bld-wrap')).toHaveCount(0);
    await expect(page.locator('.bld-card')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveClass(/bld-skin/);
    expect(await page.locator('body').innerText()).not.toMatch(/Blood Donation|Give blood/i);
    await page.evaluate('showPrivacyNotice()');
    const box = page.locator('#privacy-backdrop .pv-box');
    await expect(box).toContainText('a blood donation event');
    expect(await box.innerText()).not.toMatch(/King Fahd|Ministry of Sport|Ministry of Defense|free ride/i);
  });
});
