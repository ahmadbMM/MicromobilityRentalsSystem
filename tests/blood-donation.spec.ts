import { test, expect, type Page } from '@playwright/test';
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
    expect(r).toEqual({ kind: 'blood', bike: false, name: 'Micromobility Blood Donation', steps: [1, 2, 3], ev: 'blood', community: false });
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
    // the card is a teaser: the rules wait on About, the donor step and the ticket
    await expect(page.locator('.bld-wrap .bld-sum')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveClass(/bld-skin/);
    await page.locator('.bld-card').click();
    // one look from the first step, under the hosts' plate
    await expect(page.locator('body')).toHaveClass(/bld-skin/);
    await expect(page.locator('#tab-register .bld-head .bld-plate img')).toBeVisible();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    // the first question: donor or visitor, and the rest waits for the answer
    await expect(page.locator('#bld-after')).toBeHidden();
    await page.locator('#bld-next').click();
    await expect(page.locator('#bld-role-g')).toHaveClass(/field-invalid/);
    await page.locator('.bld-role[data-role="donor"]').click();
    await expect(page.locator('.bld-role[data-role="donor"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#bld-role-g')).not.toHaveClass(/field-invalid/);
    await expect(page.locator('#bld-after')).toBeVisible();
    // then the club or community: a name, or I don't have one
    await page.locator('#bld-next').click();
    await expect(page.locator('#bld-club-g')).toHaveClass(/field-invalid/);
    await page.locator('#bld-club').fill('Jeddah Riders');
    await expect(page.locator('#bld-club-g')).not.toHaveClass(/field-invalid/);
    await expect(page.locator('#run-first')).toHaveValue('Sara');
    await expect(page.locator('#bld-phone')).toHaveValue('+966500000001');
    await expect(page.locator('#bld-bt')).toHaveValue('O+');
    await expect(page.locator('#bld-nat')).toHaveValue('Saudi Arabia');
    // a blank blood type is refused
    await page.evaluate("document.getElementById('bld-bt').value=''");
    await page.locator('#bld-next').click();
    await expect(page.locator('.bld-info-box')).toHaveCount(0);
    // the poster must be confirmed: no close button, and Back books nothing
    await expect(page.locator('#bld-bt-g')).toHaveClass(/field-invalid/);
    await page.locator('.bld-pick[data-bt="A+"]').click();
    await expect(page.locator('.bld-pick[data-bt="A+"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.bld-pick.on')).toHaveCount(1);
    await page.locator('#bld-next').click();
    await expect(page.locator('.bld-info-box .bld-sec').first()).toBeVisible();
    await expect(page.locator('.bld-info-box .x-close')).toHaveCount(0);
    await page.locator('#bld-info-ok').click();
    // the hospital and the ministries, named; never "the race"
    const sg = page.locator('#share-gate .sg-box');
    // partners and third parties, and nobody named: no party, no logo, no venue
    await expect(sg).toContainText('our event partners and third parties');
    await expect(sg).toContainText('Blood type');
    await expect(sg).not.toContainText('race');
    expect(await sg.innerText()).not.toMatch(/King Fahd|Ministry|Motorsport|SMC|JCC|Jeddah/);
    await expect(sg.locator('.bld-plate')).toHaveCount(0);
    await expect(sg.locator('.pg-btn')).toBeDisabled();
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
    await expect(tk.locator('.bld-tk-vis')).toHaveCount(0);
    await expect(tk.locator('.bld-tk-club')).toContainText('Jeddah Riders');
    expect(rows[0]).toMatchObject({ session_id: BD, type_preference: 'None', price: 0, share_ok: true, waiver_version: 'blood-2026-11-v1', blood_role: 'donor', blood_club: 'Jeddah Riders' });
    expect(sent).toEqual(['customer_set_blood_type']);
  });

  test('the card is the picture: the words stay clear of the arm, and it is mirrored in Arabic', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await stubSupabase(page, custFx());
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
    const pic = page.locator('.bld-card .bld-card-img');
    await expect(pic).toHaveAttribute('src', '/assets/blood-card.webp');
    // all five logos, Saudi Motorsport among them, in the plate's alt text; MicroMobility above the four partners
    const plate = page.locator('.bld-card .bld-plate img');
    await expect(plate).toHaveAttribute('alt', /MicroMobility.*Saudi Motorsport Company.*Ministry of Sport/);
    await expect(plate).toHaveAttribute('src', /blood-partners\.webp\?v=3$/);
    await expect.poll(() => plate.evaluate((i: HTMLImageElement) => i.naturalHeight)).toBe(433);
    await expect(pic).toHaveAttribute('alt', '');
    // "Different types": all eight on the card
    await expect(page.locator('.bld-card .bld-ti')).toHaveCount(8);
    await expect(page.locator('.bld-card .bld-cause')).toContainText('Different types. One purpose.');
    await expect(page.locator('.bld-card .lec-title')).toHaveText(/Micromobility Blood Donation/i);
    await pic.scrollIntoViewIfNeeded();
    await expect.poll(() => pic.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1200);
    // the arm starts 40% down the picture
    const room = () => page.evaluate(() => {
      const i = document.querySelector('.bld-card .bld-card-img')!.getBoundingClientRect(), c = document.querySelector('.bld-card')!.getBoundingClientRect(), w = document.querySelector('.bld-card .bld-tiles')!.getBoundingClientRect();
      return { clear: Math.round(i.top + i.height * 0.4 - w.bottom), bleed: Math.round(c.bottom - i.bottom) };
    });
    let r = await room();
    expect(r.clear).toBeGreaterThanOrEqual(0);
    expect(r.bleed).toBeLessThanOrEqual(1);
    await expect(pic).toHaveCSS('transform', 'none');
    await page.evaluate(`setLang('ar')`);
    await page.evaluate('goLanding()');
    await expect(page.locator('.bld-card .bld-card-img')).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)');
    r = await room();
    expect(r.clear).toBeGreaterThanOrEqual(0);
  });

  test('every card sits at its own height: the event card leaves its neighbours alone', async ({ page }) => {
    const jcc = { id: '2099-11-08', session_date: '2099-11-08', day: 'Sunday', status: 'open', capacity: 50, created_at: 2, event_kind: 'jcc', spots: 50, bike_slots: '{"_time":"21:00 - 23:00"}' };
    const sizes = () => page.evaluate(() => [...document.querySelectorAll('.landing-events-grid > *')].map((c) => { const b = c.getBoundingClientRect(); return { blood: c.classList.contains('bld-wrap'), w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }; }));
    await page.setViewportSize({ width: 390, height: 844 });
    await stubSupabase(page, custFx({ sessions: [blood, jcc] }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
    await expect(page.locator('.bld-wrap')).toBeVisible();
    let cards = await sizes();
    expect(cards.length).toBeGreaterThan(1);
    // a phone shows the event card and the start of the next one on one screen
    expect(cards[0].blood).toBe(true);
    expect(cards[0].h).toBeLessThan(440);
    for (const c of cards.filter((x) => !x.blood)) expect(c.h).toBeLessThan(260);
    // a wide screen gives it the row, and the row below keeps its own height
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.evaluate('goLanding()');
    await expect(page.locator('.bld-wrap')).toBeVisible();
    cards = await sizes();
    const grid = await page.locator('.landing-events-grid').boundingBox();
    expect(cards[0].w).toBe(Math.round(grid!.width));
    expect(cards[0].h).toBeLessThan(400);
    for (const c of cards.filter((x) => !x.blood)) { expect(c.top).toBeGreaterThan(cards[0].top); expect(c.h).toBeLessThan(260); }
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
    await expect(tk.locator('.bld-tk-type')).toContainText('O+');
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

  test('a visitor gives name, mobile, gender, birth date and nationality, saved to the account, and the ticket has a stripe saying Visitor', async ({ page }) => {
    const sent: string[] = [];
    page.on('request', (r) => { const m = /rpc\/(customer_update_profile|customer_set_blood_type|customer_set_gender)/.exec(r.url()); if (m) sent.push(m[1]); });
    await stubSupabase(page, custFx({ 'rpc:customer_blood_type': null, 'rpc:customer_set_gender': true, 'rpc:customer_profile': profile({ gender: null }) }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    const rows = await captureBookingRows(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
    await page.locator('.bld-card').click();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await page.locator('.bld-role[data-role="visitor"]').click();
    // no blood type, and only the rules that are a visitor's; the rest of the step is the donor's
    await expect(page.locator('#bld-bt-g')).toBeHidden();
    // only the age rule: a visitor brings no ID or Iqama
    await expect(page.locator('#bld-after .bld-sum > *')).toHaveCount(1);
    await expect(page.locator('#bld-id-note')).toBeHidden();
    expect(await page.locator('#bld-after').innerText()).not.toContain('Iqama');
    await expect(page.locator('#run-first')).toHaveValue('Sara');
    await expect(page.locator('#bld-phone')).toBeVisible();
    await expect(page.locator('#bld-nat')).toBeVisible();
    await expect(page.locator('#run-dob-d')).toBeVisible();
    // no email; gender in its place
    await expect(page.locator('#bld-email-g')).toBeHidden();
    await expect(page.locator('#bld-gender-g')).toBeVisible();
    // I don't have one answers the club question and empties the field
    await page.locator('#bld-club').fill('Typed then changed');
    await page.locator('#bld-club-none').click();
    await expect(page.locator('#bld-club-none')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#bld-club')).toBeDisabled();
    await expect(page.locator('#bld-club')).toHaveValue('');
    // gender is required, and goes to the account
    await page.locator('#bld-next').click();
    await expect(page.locator('#bld-gender-g')).toHaveClass(/field-invalid/);
    await page.locator('#bld-gender-g [data-gender="female"]').click();
    await expect(page.locator('#bld-gender-g')).not.toHaveClass(/field-invalid/);
    await page.locator('#bld-next').click();
    // no poster to confirm; sharing still asked, with what a visitor gave on its list
    await expect(page.locator('.bld-info-box')).toHaveCount(0);
    const sg = page.locator('#share-gate .sg-box');
    await expect(sg).toContainText('our event partners and third parties');
    await expect(sg).toContainText('Birth date');
    await expect(sg).toContainText('Gender');
    await expect(sg).not.toContainText('Blood type');
    await expect(sg).not.toContainText('Email');
    await sg.locator('.wg-cb').check();
    await sg.locator('.pg-btn').click();
    // their own agreement, and the review says Visitor
    const wv = page.locator('#reg-waiver');
    await expect(wv).toContainText('Visitor agreement');
    await expect(wv).toContainText('as a visitor and will not give blood');
    await expect(wv).toContainText('checked-in visitors their free ride');
    await expect(wv).not.toContainText('Donor agreement');
    expect(await wv.innerText()).not.toMatch(/resting after I donate|health questions|Iqama|partners/i);
    await page.locator('#reg-waiver-cb').check();
    await expect(page.locator('#tab-register .cu-rv-sec')).toContainText('Visitor');
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: BD, share_ok: true, waiver_version: 'blood-2026-11-v2', blood_role: 'visitor', blood_club: '' });
    const tk = page.locator('#tab-register .ticket-card.th-blood');
    await expect(tk.locator('.bld-tk-type.bld-tk-vis')).toHaveText(/visitor/i);
    await expect(tk).toContainText('Visitor number');
    await expect(tk).not.toContainText('Donor number');
    await expect(tk).not.toContainText('Your type');
    await expect(tk.locator('.bld-sum > *')).toHaveCount(1);
    await expect(tk).not.toContainText('Iqama');
    await expect(tk).toContainText('Checked-in visitors get one free ride');
    await expect(tk).not.toContainText('Checked-in donors');
    // the gender went to the account, the rest already matched it, and no blood type was asked for
    expect(sent).toEqual(['customer_set_gender']);
  });

  test('changing the answer asks the sharing and the agreement again: a visitor\'s yes never covers a donor\'s blood type', async ({ page }) => {
    await stubSupabase(page, custFx({ 'rpc:customer_set_gender': true, 'rpc:customer_profile': profile({ gender: 'female' }) }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
    await page.locator('.bld-card').click();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await page.locator('.bld-role[data-role="visitor"]').click();
    await page.locator('#bld-club').fill('Jeddah Riders');
    await page.locator('#bld-next').click();
    const sg = page.locator('#share-gate .sg-box');
    await expect(sg).not.toContainText('Blood type');
    await sg.locator('.wg-cb').check();
    await sg.locator('.pg-btn').click();
    await page.locator('#reg-waiver-cb').check();
    await expect(page.locator('#reg-waiver')).toContainText('Visitor agreement');
    await page.evaluate('S.regStep=2;renderRegister()');
    await page.locator('.bld-role[data-role="donor"]').click();
    await expect(page.locator('#bld-id-note')).toBeVisible();
    await expect(page.locator('#bld-after .bld-sum > *')).toHaveCount(4);
    await page.locator('#bld-next').click();
    await page.locator('#bld-info-ok').click();
    // asked again, now with the blood type on the list, and the agreement is the donor's, unticked
    await expect(sg).toContainText('Blood type');
    await sg.locator('.wg-cb').check();
    await sg.locator('.pg-btn').click();
    await expect(page.locator('#reg-waiver')).toContainText('Donor agreement');
    await expect(page.locator('#reg-waiver-cb')).not.toBeChecked();
  });

  test('someone on the list as a visitor with no agreement is asked for a visitor\'s, and it is recorded as that', async ({ page }) => {
    const row = { id: 'q1', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 7, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c1', waiver_version: null, waiver_at: null, data_share_at: '2099-11-01T10:00:00Z', blood_role: 'visitor', blood_club: '' };
    const sent: Record<string, unknown>[] = [];
    await stubSupabase(page, custFx({ queue_entries: [row], 'rpc:customer_queue': [row], 'rpc:customer_entries': [row] }));
    await page.route(/\/rest\/v1\/rpc\/customer_accept_waiver/, (route) => {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '1' });
    });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    const g = page.locator('#waiver-gate .wg-box');
    await expect(g).toContainText('as a visitor and will not give blood');
    await expect(g.locator('.wg-sec')).toHaveText('Visitor');
    await g.locator('.wg-cb').check();
    await g.locator('.pg-btn').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_session_id: BD, p_version: 'blood-2026-11-v2' });
  });

  test('My Bookings: a visitor sees the stripe where a donor sees the blood type', async ({ page }) => {
    const row = { id: 'q1', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 7, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c1', waiver_version: 'blood-2026-11-v1', waiver_at: '2099-11-01T10:00:00Z', data_share_at: '2099-11-01T10:00:00Z', blood_role: 'visitor', blood_club: 'Jeddah Riders' };
    await stubSupabase(page, custFx({ queue_entries: [row], 'rpc:customer_queue': [row], 'rpc:customer_entries': [row] }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card.th-blood');
    await expect(tk.locator('.bld-tk-type.bld-tk-vis')).toHaveText(/visitor/i);
    await expect(tk).not.toContainText('O+');
    await expect(tk).toContainText('Visitor number');
    await expect(tk.locator('.bld-tk-club')).toContainText('Jeddah Riders');
    await expect(tk).not.toContainText('Checked-in donors');
    await expect(page.locator('#club-gate .cg-box')).toHaveCount(0);
  });

  test('a checked-in visitor sees their free ride in a visitor\'s words', async ({ page }) => {
    const row = { id: 'q1', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 7, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'active', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c1', waiver_version: 'blood-2026-11-v1', waiver_at: '2099-11-01T10:00:00Z', data_share_at: '2099-11-01T10:00:00Z', blood_role: 'visitor', blood_club: '' };
    await stubSupabase(page, custFx({ queue_entries: [row], 'rpc:customer_queue': [row], 'rpc:customer_entries': [row], 'rpc:customer_blood_rewards': [{ entry_id: 'q1', code: 'BD-1A2B3C4D', expires_at: '2099-12-05', used: false }] }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card.th-blood');
    await expect(tk.locator('.bld-rw')).toContainText('BD-1A2B3C4D');
    await expect(tk.locator('.bld-rw')).toContainText('Thank you for coming');
    await expect(tk.locator('.bld-rw')).not.toContainText('donating');
  });

  test('the visitor\'s form fills in what the account has and saves what changed, leaving the account\'s email alone', async ({ page }) => {
    const updates: Record<string, unknown>[] = [];
    await stubSupabase(page, custFx({ 'rpc:customer_set_gender': true, 'rpc:customer_profile': profile({ gender: 'female' }) }));
    await page.route(/\/rest\/v1\/rpc\/customer_update_profile/, (route) => {
      updates.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: 'true' });
    });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
    await page.locator('.bld-card').click();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await page.locator('.bld-role[data-role="visitor"]').click();
    await expect(page.locator('#run-first')).toHaveValue('Sara');
    await expect(page.locator('#bld-phone')).toHaveValue('+966500000001');
    await expect(page.locator('#bld-nat')).toHaveValue('Saudi Arabia');
    await expect(page.locator('#bld-gender-g [data-gender="female"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#bld-club').fill('Jeddah Riders');
    await page.locator('#bld-phone').fill('+966500000009');
    await page.locator('#bld-next').click();
    await expect.poll(() => updates.length).toBe(1);
    expect(updates[0]).toMatchObject({ p_id: 'c1', p_phone: '+966500000009', p_email: 'sara@example.com', p_name: 'Sara Haddad', p_nationality: 'Saudi Arabia', p_birth_date: '1995-05-05' });
    await expect(page.locator('#share-gate .sg-box')).toBeVisible();
  });

  const preRow = { id: 'q1', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 7, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c1', waiver_version: 'blood-2026-11-v1', waiver_at: '2099-11-01T10:00:00Z', data_share_at: '2099-11-01T10:00:00Z', blood_role: null, blood_club: null };
  const clubCalls = async (page: Page) => {
    const calls: Record<string, unknown>[] = [];
    await page.route(/\/rest\/v1\/rpc\/customer_set_blood_club/, (route) => {
      calls.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '1' });
    });
    return calls;
  };

  test('everyone registered before the question gets a forced pop-up: a name goes through, a blank does not', async ({ page }) => {
    await stubSupabase(page, custFx({ queue_entries: [preRow], 'rpc:customer_queue': [preRow], 'rpc:customer_entries': [preRow] }));
    const calls = await clubCalls(page);
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    const g = page.locator('#club-gate .cg-box');
    await expect(g).toBeVisible();
    await expect(g).toContainText('Which club or community are you from?');
    // nothing closes it but an answer, or Log out
    await expect(g.locator('.x-close')).toHaveCount(0);
    await expect(g.getByRole('button', { name: 'Log out' })).toBeVisible();
    await g.locator('#cg-save').click();
    await expect(g).toContainText('Enter your club or community');
    expect(calls).toEqual([]);
    await g.locator('#cg-club').fill('  Jeddah   Riders ');
    await g.locator('#cg-save').click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_id: 'c1', p_session_id: BD, p_club: 'Jeddah Riders' });
    await expect(page.locator('#club-gate .cg-box')).toHaveCount(0);
    await expect(page.locator('#tab-myrides .ticket-card.th-blood .bld-tk-club')).toContainText('Jeddah Riders');
    // answered: it does not come back, and a donor stays a donor
    await page.evaluate('_forceRatingPrompt()');
    await expect(page.locator('#club-gate .cg-box')).toHaveCount(0);
    await expect(page.locator('#tab-myrides .ticket-card.th-blood')).toContainText('Donor number');
  });

  test('the forced pop-up takes I don\'t have one, and asks nobody who has answered or whose row did not carry the column', async ({ page }) => {
    await stubSupabase(page, custFx({ queue_entries: [preRow], 'rpc:customer_queue': [preRow], 'rpc:customer_entries': [preRow] }));
    const calls = await clubCalls(page);
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    const g = page.locator('#club-gate .cg-box');
    await g.locator('#cg-none').click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_session_id: BD, p_club: '' });
    await expect(g).toHaveCount(0);
    const asks = await page.evaluate(`(()=>{const q=getQueue(),o={};for(const[k,v]of [['none',''],['named','Club'],['unread',undefined],['unanswered',null]]){q[0].bloodClub=v;o[k]=!!_pendingClub();}return o;})()`);
    expect(asks).toEqual({ none: false, named: false, unread: false, unanswered: true });
  });
});

test.describe('@customer:blood The Blood Donor and Volunteer badges', () => {
  const row = (donated: string | null) => ({ id: 'q1', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 7, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'done', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c1', donated_at: donated });
  const catalog = [
    { id: 'bd_blood_donor', slug: 'blood_donor', icon: 'drop', color: 'red', name: 'Blood Donor', system: true, auto: true, retired: false, sort: 91 },
    { id: 'bd_volunteer', slug: 'volunteer', icon: 'hand', color: 'blue', name: 'Volunteer', system: true, auto: false, retired: false, sort: 81 },
  ];
  async function rider(page: Page, donated: string | null, x: Record<string, unknown> = {}) {
    await stubSupabase(page, custFx({ queue_entries: [row(donated)], 'rpc:my_bookings': [row(donated)], 'rpc:badge_catalog': catalog, ...x }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
  }

  test('marked Donated: the drop on the red medal, once with a pop-up, with no word of a ride', async ({ page }) => {
    await rider(page, '2099-11-05T16:00:00Z');
    const pop = page.locator('#badge-pop');
    await expect(pop).toContainText('New badge!');
    await expect(pop).toContainText('Blood Donor');
    await expect(pop).toContainText('Donate blood at one of our events.');
    await expect(pop.locator('svg.bdg-m.bdc-red')).toHaveCount(1);
    expect(await pop.innerText()).not.toMatch(/\bride\b|\bbike\b/i);
    await pop.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#tab-account .mr-badges .mr-badge', { hasText: 'Blood Donor' })).toHaveCount(1);
  });

  test('the mark taken back, or never given, shows no badge at all: not even to earn', async ({ page }) => {
    await rider(page, null);
    await expect(page.locator('#mr-badges-host')).toHaveCount(1);
    await page.evaluate(`_mrBadgesMore()`);
    await expect(page.locator('#tab-account .mr-badge', { hasText: 'Blood Donor' })).toHaveCount(0);
    await expect(page.locator('#badge-pop')).toHaveCount(0);
  });

  test('Volunteer: staff give it, on its own blue medal, the heart cut out of the raised hand', async ({ page }) => {
    await rider(page, null, { 'rpc:customer_my_badges': [{ ...catalog[1], note: 'Blood Donation night', at: '2099-11-05T18:00:00Z' }] });
    const pop = page.locator('#badge-pop');
    await expect(pop).toContainText('Volunteer');
    await expect(pop).toContainText('Given by the MicroMobility team');
    await expect(pop).toContainText('Blood Donation night');
    await expect(pop.locator('svg.bdg-m.bdg-sp path[fill-rule="evenodd"]')).toHaveCount(1);
    await expect(page.locator('#badge-pop .badge-pop-box.sp-volunteer')).toHaveCount(1);
    expect(await page.evaluate(`[BDG_GIVEN_SYS.includes('volunteer'),BD_SYS.blood_donor[1],BD_SYS.volunteer[1],BDG_GIVEN_SYS.includes('blood_donor')]`)).toEqual([true, 'red', 'volunteer', false]);
  });

  test('every language has both badges, and the migration offers Volunteer to staff and earns Blood Donor', async () => {
    for (const code of ['es', 'fr', 'hi', 'ur', 'bn', 'ne', 'pt', 'tl']) {
      const pack = JSON.parse(readFileSync(`i18n/${code}.json`, 'utf8')) as Record<string, string>;
      for (const k of ['bdgBloodDonor', 'bdgBloodDonorD', 'bdgBloodDonorA', 'bdgVolunteer', 'bdgVolunteerD', 'bdgVolunteerA']) expect(pack[k], `${code} ${k}`).toBeTruthy();
    }
    const sql = readFileSync('supabase/migrations/20261105100000_donor_volunteer_badges.sql', 'utf8');
    expect(sql).toMatch(/'bd_blood_donor'.*true, true,\s+91\)/);
    expect(sql).toMatch(/'bd_volunteer'.*true, false, 81\)/);
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

  test('every sort and filter: blood type, donated, free ride code and the Accounts list, no money, and the report', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = (n: number, status: string, donated: string | null, inAt: string | null = null) => ({
      id: 'r' + n, session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: n, name: 'Donor ' + n, phone: '055000000' + n,
      type_preference: 'None', size: '', status, paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c' + n, donated_at: donated, checked_in_at: inAt,
    });
    const acct = (n: number, x: Record<string, unknown>) => ({ id: 'c' + n, name: 'Donor ' + n, phone: '055000000' + n, email: `d${n}@example.com`, ...x });
    await stubSupabase(page, {
      sessions: [blood], bikes: [],
      queue_entries: [row(1, 'waiting', null), row(2, 'active', null, '2099-11-05T14:00:00Z'), row(3, 'active', '2099-11-05T15:00:00Z', '2099-11-05T14:30:00Z'), row(4, 'done', '2099-11-05T16:00:00Z', '2099-11-05T14:45:00Z')],
      customers: [acct(1, { blood_type: 'O+', city: 'Jeddah', workplace: 'Acme' }), acct(2, { blood_type: 'AB-', city: 'Riyadh' }), acct(3, { blood_type: 'unknown', city: 'Jeddah' }), acct(4, { blood_type: null, city: 'Makkah' })],
      promo_codes: [{ id: 'p3', code: 'BD-3', blood_entry_id: 'r3', uses: 1, active: true }, { id: 'p4', code: 'BD-4', blood_entry_id: 'r4', uses: 0, active: true }],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${BD}';renderStaffQueue()`);
    const tab = page.locator('#tab-queue');
    await expect(tab.locator('.queue-table tbody .bld-bt')).toHaveText(['O+', 'AB\u2212', 'Not known']);
    await page.waitForFunction('!!S._bq');
    await page.waitForFunction('S.promoCodes&&S.promoCodes.length>0');
    const shown = () => page.evaluate<string>(`[...document.querySelectorAll('#q-results .queue-table tbody tr')].map(r=>(r.innerText.match(/Donor \\d/)||[''])[0]).filter(Boolean).join()`);
    const set = (js: string) => page.evaluate(`${js};renderStaffQueue()`);
    // blood type and Donated in plain view; the long list is drawn only once Advanced opens, and never holds money
    await expect(tab.locator('select[aria-label="Blood type"] option')).toHaveCount(11);
    await expect(tab.locator('select[aria-label="City of residence"]')).toHaveCount(0);
    await tab.locator('.filter-toggle').click();
    await expect(tab.locator('select[aria-label="City of residence"] option')).toHaveText(['All', 'Not set', 'Jeddah', 'Makkah', 'Riyadh']);
    expect(await tab.locator('#fm-q select').count()).toBeGreaterThan(35);
    expect(await tab.locator('#fm-q').innerText()).not.toMatch(/\bPaid\b|Payment|Spent|⃁|\bSAR\b/);
    // the filters
    await set(`S.sfBt='O+'`); expect(await shown()).toBe('Donor 1');
    await set(`S.sfBt='unknown'`); expect(await shown()).toBe('Donor 3');
    await set(`S.sfBt='unset'`); expect(await shown()).toBe('Donor 4');
    await set(`S.sfBt='all';S.sfDon='yes'`); expect(await shown()).toBe('Donor 3,Donor 4');
    await set(`S.sfDon='wait'`); expect(await shown()).toBe('Donor 2');
    await set(`S.sfDon='no'`); expect(await shown()).toBe('Donor 1,Donor 2');
    await set(`S.sfDon='all';S.sfRw='used'`); expect(await shown()).toBe('Donor 3');
    await set(`S.sfRw='open'`); expect(await shown()).toBe('Donor 4');
    await set(`S.sfRw='none'`); expect(await shown()).toBe('Donor 1,Donor 2');
    await set(`S.sfRw='all';_bqAm('amCity','Jeddah')`); expect(await shown()).toBe('Donor 1,Donor 3');
    await expect(tab.locator('select[aria-label="City of residence"]')).toHaveValue('Jeddah');
    expect(await page.evaluate('_svGet("queue").sfAm.amCity')).toBe('Jeddah');
    expect(await page.evaluate(`S.amCity||''`)).toBe(''); // the Accounts page keeps its own picks
    await set(`_dkXClearFilters()`); expect(await shown()).toBe('Donor 1,Donor 2,Donor 3'); // nothing picked: finished donors fold again
    // the sorts, those with no value last in either order
    await expect(tab.locator('select.q-sort-pick option', { hasText: /^Blood type$/ })).toHaveCount(1);
    await expect(tab.locator('select.q-sort-pick option', { hasText: /Spent|spent/ })).toHaveCount(0);
    await set(`S.sfSort='bq:bt';S.sfSortDir=1`); expect(await shown()).toBe('Donor 2,Donor 1,Donor 3,Donor 4');
    await expect(tab.locator('select.q-sort-pick')).toHaveValue('bq:bt');
    await set(`S.sfSortDir=-1`); expect(await shown()).toBe('Donor 3,Donor 1,Donor 2,Donor 4');
    await set(`S.sfSort='bq:don';S.sfSortDir=1`); expect(await shown()).toBe('Donor 4,Donor 3,Donor 1,Donor 2');
    await set(`S.sfSort='bq:in'`); expect(await shown()).toBe('Donor 4,Donor 3,Donor 2,Donor 1');
    await set(`S.sfSort='bq:acity'`); expect(await shown()).toBe('Donor 1,Donor 3,Donor 4,Donor 2');
    await set(`S.sfSort='queue'`);
    // the report's dialog: no payment filter, its own two, and a payment filter left from another night does nothing
    await page.evaluate(`_repOpts().fPay='paid';showPrintReportOptions()`);
    const dlg = page.locator('#print-opts-modal');
    await expect(dlg.locator('select[aria-label="Payment"], select[aria-label="Filter Payment"]')).toHaveCount(0);
    await expect(dlg.locator('select[aria-label="Donated"]')).toHaveCount(1);
    await expect(dlg.locator('select[aria-label="Blood type"]')).toHaveCount(1);
    const inReport = (js: string) => page.evaluate<string>(`(()=>{${js};return _repFilter(getQueue().filter(e=>e.sessionId==='${BD}')).map(e=>e.name).join()})()`);
    expect(await inReport('')).toBe('Donor 1,Donor 2,Donor 3,Donor 4');
    expect(await inReport(`_repOpts().fDon='yes'`)).toBe('Donor 3,Donor 4');
    expect(await inReport(`_repOpts().fDon='all';_repOpts().fBt='AB-'`)).toBe('Donor 2');
  });

  test('donors and visitors read apart: chips, figures that filter, no Mark donated for a visitor, one tap to switch, the club', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = (id: string, status: string, role: string | null, club: string | null, donated: string | null = null) => ({
      id, session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: Number(id.slice(1)), name: 'Person ' + id,
      phone: '055000000' + id.slice(1), type_preference: 'None', size: '', status, paid: false, price: 0,
      registered_at: '2099-11-01T10:00:00Z', customer_id: 'c' + id, donated_at: donated, blood_role: role, blood_club: club,
    });
    const calls: Record<string, unknown>[] = [];
    await stubSupabase(page, { sessions: [blood], bikes: [], queue_entries: [row('r1', 'waiting', null, 'Jeddah Riders'), row('r2', 'active', 'visitor', ''), row('r3', 'active', 'donor', null, '2099-11-05T15:00:00Z'), row('r4', 'waiting', 'visitor', null)], customers: [{ id: 'cr1', blood_type: 'O+' }, { id: 'cr2', blood_type: 'AB-' }, { id: 'cr3', blood_type: 'A+' }, { id: 'cr4', blood_type: null }] });
    await page.route(/\/rest\/v1\/rpc\/staff_blood_role/, (route) => {
      calls.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) });
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${BD}';renderStaffQueue()`);
    const tq = page.locator('#tab-queue .queue-table');
    await expect(tq.locator('thead')).toContainText('Donor or visitor');
    await expect(tq.locator('thead')).toContainText('Club or community');
    await expect(tq.locator('tbody .bld-chip-v')).toHaveCount(2);
    await expect(tq.locator('tbody .bld-chip-d')).toHaveCount(2);
    // a null is a donor; a visitor's blood type is never shown, even with one on the account
    await expect(tq.locator('tbody .bld-bt')).toHaveText(['O+', 'A+']);
    // nothing to mark on a visitor: check-in gives them the free ride
    await expect(tq.getByRole('button', { name: 'Mark donated' })).toHaveCount(0);
    await expect(tq.locator('tbody tr', { hasText: 'Person r2' }).first().locator('.rr-chip.rr-yes')).toHaveText('Free ride');
    await expect(tq.locator('tbody tr', { hasText: 'Person r4' }).first().locator('.rr-chip.rr-yes')).toHaveCount(0);
    // the club: a name, None, or not answered yet
    await expect(tq.locator('tbody .bld-club')).toHaveText(['Jeddah Riders']);
    const body = await tq.innerText();
    expect(body).toContain('None');
    expect(body).toContain('Not answered yet');
    // the figures say how many of each, and filter
    const donors = page.locator('#tab-queue .stat-chip', { hasText: 'Donors' }), visitors = page.locator('#tab-queue .stat-chip', { hasText: 'Visitors' });
    await expect(donors.locator('b')).toHaveText('2');
    await expect(visitors.locator('b')).toHaveText('2');
    await visitors.click();
    await expect(tq.locator('tbody .bld-chip-d')).toHaveCount(0);
    await expect(tq.locator('tbody .bld-chip-v')).toHaveCount(2);
    await page.locator('#tab-queue .stat-chip', { hasText: 'Visitors' }).click();
    await expect(tq.locator('tbody .bld-chip-d')).toHaveCount(2);
    // one tap: the checked-in visitor becomes a donor and can now be marked; the marked donor has no switch at all
    const r2 = tq.locator('tbody tr', { hasText: 'Person r2' }).first();
    await r2.getByRole('button', { name: 'Make donor' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_entry_id: 'r2', p_role: 'donor' });
    await expect(tq.locator('tbody tr', { hasText: 'Person r2' }).first().getByRole('button', { name: 'Mark donated' })).toBeVisible();
    await expect(tq.locator('tbody tr', { hasText: 'Person r3' }).first().locator('.bld-sw')).toHaveCount(0);
    await tq.locator('tbody tr', { hasText: 'Person r1' }).first().getByRole('button', { name: 'Make visitor' }).click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toEqual({ p_entry_id: 'r1', p_role: 'visitor' });
    // the report knows both
    const rep = await page.evaluate((s) => {
      const w = window as unknown as Record<string, (...a: unknown[]) => unknown>;
      return { role: w._repColFits(s, 'brole'), club: w._repColFits(s, 'bclub'), other: w._repColFits({ id: 'x', event_kind: 'rental' }, 'brole') };
    }, blood);
    expect(rep).toEqual({ role: true, club: true, other: false });
  });

  test('staff edit a registration: filled in from the account, saved to the account, the booking follows', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = { id: 'r1', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 1, name: 'Sara Haddad', phone: '+966500000001', email: 'sara@example.com', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c1', donated_at: null, blood_role: 'visitor', blood_club: null };
    const acct = { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', gender: 'female', birth_date: '1995-05-05', nationality: 'Saudi Arabia', blood_type: 'O+', created_at: '2026-01-01' };
    const patches: { url: string; body: Record<string, unknown> }[] = [], roles: Record<string, unknown>[] = [];
    await stubSupabase(page, { sessions: [blood], bikes: [], queue_entries: [row], customers: [acct], 'rpc:staff_phone_accounts': [] });
    await page.route(/\/rest\/v1\/(customers|queue_entries)\?/, (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      patches.push({ url: route.request().url(), body: route.request().postDataJSON() });
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' });
    });
    await page.route(/\/rest\/v1\/rpc\/staff_blood_role/, (route) => {
      roles.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) });
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${BD}';renderStaffQueue()`);
    await page.locator('#tab-queue .queue-table').waitFor();
    await page.evaluate(`_bldEditOpen('r1')`);
    const d = page.locator('#booking-edit-modal .bld-edit');
    await expect(d).toBeVisible();
    await expect(d).toContainText('saved to their account too');
    // filled in from the account; a visitor shows no blood type
    await expect(d.locator('#bed-first')).toHaveValue('Sara');
    await expect(d.locator('#bed-last')).toHaveValue('Haddad');
    await expect(d.locator('#bed-phone')).toHaveValue('+966500000001');
    await expect(d.locator('#bed-email')).toHaveValue('sara@example.com');
    await expect(d.locator('#bed-gender')).toHaveValue('female');
    await expect(d.locator('#bed-nat')).toHaveValue('Saudi Arabia');
    await expect(d.locator('#bed-role')).toHaveValue('visitor');
    await expect(d.locator('#bed-bt-g')).toBeHidden();
    // nothing changed: nothing written
    await d.locator('#bed-save').click();
    await expect(d).toHaveCount(0);
    expect(patches).toEqual([]);
    // the name, the mobile, the club, and donor with a blood type
    await page.evaluate(`_bldEditOpen('r1')`);
    await d.locator('#bed-first').fill('Sarah');
    await d.locator('#bed-phone').fill('0500000009');
    await d.locator('#bed-club').fill('Jeddah   Riders');
    await d.locator('#bed-role').selectOption('donor');
    await expect(d.locator('#bed-bt-g')).toBeVisible();
    await d.locator('#bed-bt').selectOption('A+');
    await d.locator('#bed-save').click();
    await expect.poll(() => roles.length).toBe(1);
    const toAcct = patches.find((p) => p.url.includes('/customers?'))!, toRow = patches.find((p) => p.url.includes('/queue_entries?'))!;
    expect(toAcct.url).toContain('id=eq.c1');
    expect(toAcct.body).toEqual({ name: 'Sarah Haddad', phone: '+966500000009', blood_type: 'A+' });
    expect(toRow.url).toContain('id=eq.r1');
    expect(toRow.body).toEqual({ name: 'Sarah Haddad', phone: '+966500000009', blood_club: 'Jeddah Riders' });
    expect(roles[0]).toEqual({ p_entry_id: 'r1', p_role: 'donor' });
    await expect(d).toHaveCount(0);
    // the list says so at once
    const tq = page.locator('#tab-queue .queue-table');
    await expect(tq.locator('tbody .bld-chip-d')).toHaveCount(1);
    await expect(tq.locator('tbody .bld-club')).toHaveText(['Jeddah Riders']);
    await expect(tq).toContainText('Sarah Haddad');
    // I don't have one answers the club for them; a marked donation holds the role
    await page.evaluate(`_bldEditOpen('r1')`);
    await d.locator('#bed-club-none').check();
    await expect(d.locator('#bed-club')).toBeDisabled();
    await d.locator('#bed-save').click();
    await expect.poll(() => patches.filter((p) => p.url.includes('/queue_entries?')).length).toBe(2);
    expect(patches.filter((p) => p.url.includes('/queue_entries?'))[1].body).toMatchObject({ blood_club: '' });
    await page.evaluate(`getQueue()[0].donatedAt='2099-11-05T15:00:00Z';_bldEditOpen('r1')`);
    await expect(d.locator('#bed-role')).toBeDisabled();
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
    await expect(card.locator('.bld-chip-d')).toHaveText('Donor');
    await expect(card.getByRole('button', { name: 'Make visitor' })).toBeVisible();
    await expect(card).toContainText('Club or community');
  });

  test('someone on the list who never agreed to share is stopped until they do, nobody named, in Arabic too', async ({ page }) => {
    const row = { id: 'q1', session_id: BD, session_day: 'Thursday', session_date: '2099-11-05', queue_num: 7, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-11-01T10:00:00Z', customer_id: 'c1', waiver_at: '2099-11-01T10:00:00Z', waiver_version: 'blood-2026-11-v1', data_share_at: null };
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (/rpc\/customer_accept_share/.test(r.url())) sent.push(r.postDataJSON()); });
    await stubSupabase(page, custFx({ queue_entries: [row], 'rpc:customer_queue': [row], 'rpc:customer_entries': [row], 'rpc:customer_accept_share': 1 }));
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    const sg = page.locator('#share-gate .sg-box');
    await expect(sg).toBeVisible();
    await expect(sg.locator('.wg-agree')).toContainText('I agree that MicroMobility shares my details with its partners and third parties');
    expect(await sg.innerText()).not.toMatch(/JCC|Jeddah|King Fahd|Motorsport/);
    await expect(sg.locator('.pg-btn')).toBeDisabled();
    await expect(sg.locator('.x-close')).toHaveCount(0);
    await page.evaluate(`setLang('ar')`);
    await expect(sg).toContainText('شركائنا وأطراف ثالثة');
    expect(await sg.innerText()).not.toMatch(/JCC|كورنيش|SMC/);
    await sg.locator('.wg-cb').check();
    await sg.locator('.pg-btn').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_session_id: BD });
    await expect(sg).toHaveCount(0);
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
    // who receives a donor's details is in the notice, by role: the page where they agree names them
    await expect(box).toContainText('Partners and third parties of a blood donation event');
    await expect(box).toContainText('To share a donor’s details with the partners and third parties of a blood donation event');
    expect(await box.innerText()).not.toMatch(/King Fahd|Ministry of Sport|Ministry of Defense|free ride/i);
  });
});
