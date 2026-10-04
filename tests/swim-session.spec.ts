import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// A swim session is a community session that involves no bicycle. It answers four of the
// five questions the code asks about a session exactly as the Saturday ride does — members
// only, staff approve, one spot each, the queue stays hidden — and a sixth one for the first
// time: there is no bike to size, choose, or hand over.
//
// The booking still has to satisfy two NOT NULL columns, so it carries type_preference
// 'None' (a deliberate sentinel: 'Any' would mean "any bike will do") and an empty size.

const SWIM = 'swim-1';
const RIDE = 'ride-1';
const sessions = [
  {
    id: SWIM, day: 'Thursday', session_date: '2099-03-05', capacity: 20, status: 'open', created_at: 2,
    event_kind: 'community', ride_kind: 'swim', needs_approval: true, hide_queue: true, paid_ride: false,
    spots: 20, title: 'Triathlon Pool Session', meet_url: 'https://maps.example.test/pool',
    bike_slots: '{"_time":"18:00 - 19:30","_total":20}',
  },
  {
    id: RIDE, day: 'Saturday', session_date: '2099-03-07', capacity: 20, status: 'open', created_at: 1,
    event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false,
    spots: 20, bike_slots: '{"_time":"05:30 - 06:00","_total":20}',
  },
];

async function asMember(page: import('@playwright/test').Page) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Swimmer' });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
  await page.evaluate(`S.selEvent='community';goCustomer('register');S.regStep=1;renderRegister()`);
}

test('a swim session is bike-free; a ride is not', async ({ page }) => {
  await asMember(page);
  expect(await page.evaluate(`_needsBike(allSessions().find(s=>s.id==='${SWIM}'))`)).toBe(false);
  expect(await page.evaluate(`_needsBike(allSessions().find(s=>s.id==='${RIDE}'))`)).toBe(true);
  expect(await page.evaluate(`_rideKind(allSessions().find(s=>s.id==='${SWIM}'))`)).toBe('swim');
});

test('it keeps the Saturday shape: members only, approved, solo, free, hidden queue', async ({ page }) => {
  await asMember(page);
  const s = await page.evaluate(`(()=>{const x=allSessions().find(s=>s.id==='${SWIM}');
    return {community:_isCommunity(x),approval:_isApprovalRide(x),free:_isFreeRide(x),group:_isGroupRide(x)};})()`);
  expect(s).toEqual({ community: true, approval: true, free: true, group: false });
});

test('choosing it skips the riders step — there is nothing to ask', async ({ page }) => {
  await asMember(page);
  await page.evaluate(`S.selSession='${SWIM}';regNextFromSession()`);
  expect(await page.evaluate('S.regStep')).toBe(2.5);          // straight to the waiver
  await expect(page.locator('#tab-register')).not.toContainText('Bike Type');
  await expect(page.locator('#tab-register')).not.toContainText('Height');
});

test('a ride still goes through the riders step', async ({ page }) => {
  await asMember(page);
  await page.evaluate(`S.selSession='${RIDE}';regNextFromSession()`);
  expect(await page.evaluate('S.regStep')).toBe(2);
});

test('the swimmer agrees to a swim waiver, not a cycling one', async ({ page }) => {
  await asMember(page);
  await page.evaluate(`S.selSession='${SWIM}';regNextFromSession()`);
  const panel = page.locator('#tab-register');
  await expect(panel).toContainText('Swimming carries risk');
  await expect(panel).not.toContainText('wear a helmet');
  await expect(panel).not.toContainText('rented bike');
  // the wrapper has to name the activity too, or the record says a swimmer accepted a
  // "Ride waiver" on behalf of every "rider" — consent to the wrong thing
  await expect(panel).toContainText('Swim waiver');
  await expect(panel).not.toContainText('Ride waiver');
  await expect(panel).toContainText('on behalf of everyone on this booking');
  await expect(panel).not.toContainText('every rider on this booking');
});

test('back from the waiver returns to the session list, not an empty step', async ({ page }) => {
  await asMember(page);
  await page.evaluate(`S.selSession='${SWIM}';regNextFromSession()`);
  await page.locator('#tab-register .mm-reg-foot .btn-secondary').click();
  expect(await page.evaluate('S.regStep')).toBe(1);
});

test('the booking carries the sentinel type and the swim waiver version', async ({ page }) => {
  await asMember(page);
  const rpc: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rpc/customer_create_booking')) rpc.push(r.postData() || '');
  });
  await page.evaluate(`S.selSession='${SWIM}';regNextFromSession();toggleWaiver(true);regWaiverContinue();submitReg()`);
  await expect.poll(() => rpc.length, { timeout: 6000 }).toBeGreaterThan(0);
  const e = JSON.parse(rpc[0]).p_entries[0];
  expect(e.type_preference).toBe('None');   // not 'Any' — that would mean "any bike will do"
  expect(e.size).toBe('');
  expect(e.waiver_version).toBe('swim-2026-10-v3');
  expect(e.price).toBe(0);                  // free, like the Saturday ride
});

test('the stepper names the middle step for what it actually is', async ({ page }) => {
  await asMember(page);
  await page.evaluate(`S.selSession='${SWIM}';regNextFromSession()`);
  await expect(page.locator('#tab-register .reg-stepper')).toContainText('Swim waiver');
  await expect(page.locator('#tab-register .reg-stepper')).not.toContainText('Riders');
});

test('staff checking a swimmer in are offered no bike', async ({ page }) => {
  await stubSupabase(page, {
    sessions, bikes: [{ id: 'b1', name: 'R-01', type: 'Road', size: 'M', status: 'available', colors: [] }],
    queue_entries: [{
      id: 'q1', session_id: SWIM, session_day: 'Thursday', session_date: '2099-03-05', queue_num: 1,
      name: 'Spec Swimmer', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0,
      registered_at: '2099-01-01T10:00:00Z', approval: 'approved',
    }],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`showCheckinModal('q1')`);
  const html = await page.evaluate(`document.getElementById('checkin-modal').innerHTML`) as string;
  expect(html).not.toContain('openModal(');       // no route into the bike picker
  expect(html).toContain('ci-out-checkin');        // but they can still be marked as here:
  expect(html).toContain('confirmCheckinOutcome'); // Check In is chosen, and Confirm applies it
});

test('the swim session carries its own identity colour, not the circuit blue', async ({ page }) => {
  await asMember(page);
  const cls = await page.evaluate(`_evClass(allSessions().find(s=>s.id==='${SWIM}'))`);
  expect(cls).toBe('ev-swim');
});

// A pool session ends at the pool. The social ride's breakfast stop is not part of it, so the
// staff form never asks and the rider's card never shows one — but the MEETING POINT stays,
// because a pool session still has to say where.
test('the staff form offers no breakfast spot for a pool session', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue();
    S.showAddSession=true;S.newSessEvent='swim';renderSessions()`);
  const form = page.locator('#sess-add-form');
  await expect(form).not.toContainText('Breakfast spot');
  await expect(form).toContainText('Meeting point');       // still asked — it happens somewhere
  // and the social ride is untouched
  await page.evaluate(`S.newSessEvent='community';renderSessions()`);
  await expect(form).toContainText('Breakfast spot');
});

test('the rider card shows no breakfast for a pool session', async ({ page }) => {
  await asMember(page);
  const html = await page.evaluate(
    `_commInfoHtml({...allSessions().find(s=>s.id==='${SWIM}'),breakfast_name:'Brew92',breakfast_url:'https://maps.example.test/cafe'})`) as string;
  expect(html).toBe('');                                    // even with a spot set on the row
  const ride = await page.evaluate(
    `_commInfoHtml({...allSessions().find(s=>s.id==='${RIDE}'),breakfast_name:'Brew92',breakfast_url:'https://maps.example.test/cafe'})`) as string;
  expect(ride).toContain('Brew92');                         // the social ride still does
});

// Editing re-asserts the session's identity, because a date change re-inserts the row bare.
// It used to re-assert a two-kind world (petromin or saturday), so any edit to a pool session
// turned it into a Saturday Social Ride — bikes, breakfast and all.
test('editing a pool session does not turn it into a Saturday ride', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`allSessions().length>0`);
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/sessions')) writes.push(r.postData() || '');
  });
  await page.evaluate(`S.editSessionId='${SWIM}';S.editSessDate='2099-03-05';S.editSessStatus='open';
    S.editSessTitle='';S.editSessMapUrl='https://maps.example.test/pool';S.editSessTotal=20;saveSessionEdit()`);
  await expect.poll(() => writes.some((w) => w.includes('ride_kind')), { timeout: 6000 }).toBe(true);
  const kindWrite = JSON.parse(writes.find((w) => w.includes('ride_kind'))!);
  expect(kindWrite.ride_kind).toBe('swim');
  expect(kindWrite.paid_ride).toBe(false);
  const ce = writes.map((w) => JSON.parse(w)).find((w) => 'breakfast_name' in w);
  expect(ce.breakfast_name).toBeNull();                     // no breakfast written onto it
  expect(ce.meet_url).toBe('https://maps.example.test/pool');   // meeting point survives
  expect(ce.needs_approval).toBe(true);                     // and it is still an approval ride
});

// A pool session does not set off together, so "Gathering · Start" is the wrong shape for it.
// It reads as a plain window, exactly like the Petromin ride — and the staff form asks for the
// two times the rider is actually shown rather than for a gathering nobody is told about.
test('the rider sees a plain window, not a gathering time', async ({ page }) => {
  await asMember(page);
  const swim = await page.evaluate(`sessionTime(allSessions().find(s=>s.id==='${SWIM}'))`) as string;
  expect(swim).not.toMatch(/Gathering/i);
  expect(swim).toBe('6 PM - 7:30 PM');            // fmt12h drops a :00
  // the Saturday ride still gathers before it starts
  const ride = await page.evaluate(`sessionTime(allSessions().find(s=>s.id==='${RIDE}'))`) as string;
  expect(ride).toMatch(/Gathering/i);
  expect(ride).toContain('Start');
});

test('the staff form asks for start and end, not gathering', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue();
    S.showAddSession=true;S.newSessEvent='swim';renderSessions()`);
  const form = page.locator('#sess-add-form');
  await expect(form).not.toContainText('Gathering time');
  await expect(form).toContainText('Start time');
  await expect(form).toContainText('End time');
  // the social ride keeps both halves of its gathering
  await page.evaluate(`S.newSessEvent='community';renderSessions()`);
  await expect(form).toContainText('Gathering time');
});

// Ride words on a session that has no bike. The Experiences list can hold a Saturday ride and
// a pool session at the same time, so its subtitle has to cover both; the circuit keeps "ride".
test('the session step does not tell a swimmer to pick a day to ride', async ({ page }) => {
  await asMember(page);
  const panel = page.locator('#tab-register');
  await expect(panel).toContainText('Pick the day you would like to join.');
  await expect(panel).not.toContainText('want to ride');
  await page.evaluate(`S.selEvent='jcc';renderRegister()`);
  await expect(panel).toContainText('want to ride');   // the circuit is still a ride
});

test('the staff form calls it a session name, not a ride name', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue();
    S.showAddSession=true;S.newSessEvent='swim';renderSessions()`);
  const form = page.locator('#sess-add-form');
  await expect(form).toContainText('Session name');
  await expect(form).not.toContainText('Ride name');
  await page.evaluate(`S.newSessEvent='petromin';renderSessions()`);
  await expect(form).toContainText('Ride name');
});

// Five bookings on the first real pool session came through the wizard and carried 'None' with
// no size. Two were added by staff and carried a bike type, a frame size and a height copied
// from the customer's saved preference -- one of them 'Own', which counted a swimmer as having
// brought a bicycle. Enforced in entryToDB, where every write path converges.
test('a staff-added rider carries no bike answers either', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`allSessions().length>0`);
  const row = await page.evaluate(`entryToDB({id:'x',name:'Staff Added',sessionId:'${SWIM}',
    typePreference:'Own',size:'M',height:174,assignedBikeId:'b1',status:'waiting',paid:false,price:0,
    queueNum:1,registeredAt:'2099-01-01T00:00:00Z'})`) as Record<string, unknown>;
  expect(row.type_preference).toBe('None');
  expect(row.size).toBe('');
  expect(row.height).toBeNull();
  expect(row.assigned_bike_id).toBeNull();
});

test('a ride keeps what staff entered', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`allSessions().length>0`);
  const row = await page.evaluate(`entryToDB({id:'y',name:'Rider',sessionId:'${RIDE}',
    typePreference:'Own',size:'M',height:174,status:'waiting',paid:false,price:0,
    queueNum:1,registeredAt:'2099-01-01T00:00:00Z'})`) as Record<string, unknown>;
  expect(row.type_preference).toBe('Own');
  expect(row.height).toBe(174);
});

// The pool's teal had a light "dark theme" twin (#3fc9dd) that won on every page, because the
// head script always sets data-theme="dark" while every surface is white paper - so the ride's
// name was drawn at about 2:1. It has to read at the 4.5:1 body-text minimum on its card.
test('the pool session name on its card reads at 4.5:1 or better', async ({ page }) => {
  await asMember(page);
  const chip = page.locator('.sess-card .sess-comm-chip.ev-swim').first();
  await expect(chip).toBeVisible();
  const ratio = await chip.evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    let bgEl: Element | null = el, bg = 'rgba(0, 0, 0, 0)';
    while (bgEl && /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(bg)) { bg = getComputedStyle(bgEl).backgroundColor; bgEl = bgEl.parentElement; }
    const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(bg));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
