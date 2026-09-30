import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// The Micromobility Triathlon Workshop is a community session with the Saturday ride's shape
// — staff approve the list, the queue stays hidden, one place each, complimentary — that
// involves no bicycle, and that ANYONE signed in may book: open_to_all on the session lifts
// the members gate, in the app and in the database alike. It is featured on the landing page
// as a card of its own, beside the circuit and the Experiences umbrella, not under either.

const WS = '2099-03-10-tw';
const RIDE = 'ride-1';
const sessions = [
  {
    id: WS, day: 'Tuesday', session_date: '2099-03-10', capacity: 30, status: 'open', created_at: 2,
    event_kind: 'community', ride_kind: 'workshop', needs_approval: true, hide_queue: true, paid_ride: false,
    open_to_all: true, spots: 30, title: 'Micromobility Triathlon Workshop',
    meet_url: 'https://maps.example.test/hq', bike_slots: '{"_time":"18:00 - 20:00","_total":30}',
  },
  {
    id: RIDE, day: 'Saturday', session_date: '2099-03-07', capacity: 20, status: 'open', created_at: 1,
    event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false,
    spots: 20, bike_slots: '{"_time":"05:30 - 06:00","_total":20}',
  },
];

// A customer with NO community tag: the members RPC says no.
async function asAnyone(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], 'rpc:community_member': false, ...extra });
  await loginCustomer(page, { id: 'c1', name: 'Spec Anyone' });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
}

test('it has the Saturday shape, minus the bike and minus the gate', async ({ page }) => {
  await asAnyone(page);
  const s = await page.evaluate(`(()=>{const x=allSessions().find(s=>s.id==='${WS}');
    return {kind:_rideKind(x),community:_isCommunity(x),approval:_isApprovalRide(x),free:_isFreeRide(x),
            group:_isGroupRide(x),bike:_needsBike(x),open:_openToAll(x),cls:_evClass(x)};})()`);
  expect(s).toEqual({ kind: 'workshop', community: true, approval: true, free: true, group: false, bike: false, open: true, cls: 'ev-workshop' });
  // the Saturday ride is untouched: still gated
  expect(await page.evaluate(`_openToAll(allSessions().find(s=>s.id==='${RIDE}'))`)).toBe(false);
});

test('the landing page no longer offers it as a card', async ({ page }) => {
  await asAnyone(page);
  await page.evaluate(`goLanding()`);
  await expect(page.locator('#land-events .landing-event-card:not(.ev-snd96)')).toHaveCount(2);
  await expect(page.locator('#land-events .landing-event-card.ev-workshop')).toHaveCount(0);
  expect(await page.evaluate(`document.getElementById('land-events').textContent`)).not.toMatch(/T100|Triathlon/);
});

test('reached directly, the workshop list still opens without the members dialog', async ({ page }) => {
  await asAnyone(page);
  await page.evaluate(`goLanding()`);
  await page.evaluate(`selectEvent('workshop')`);
  await expect.poll(() => page.evaluate('S.selEvent')).toBe('workshop');
  await expect(page.locator('#tab-register')).toContainText('Micromobility Triathlon Workshop');
  await expect(page.locator('#tab-register .sess-partner')).toHaveText('In partnership with Saudi Triathlon Federation');
  expect(await page.evaluate(`document.getElementById('confirm-modal').style.display`)).not.toBe('block');
});

test('it lists under its own card only, and no other ride lists under it', async ({ page }) => {
  await asAnyone(page);
  const under = await page.evaluate(`(()=>{const all=allSessions();
    const ids=ev=>all.filter(s=>_evMatch(s,ev)).map(s=>s.id).sort();
    return {workshop:ids('workshop'),community:ids('community'),jcc:ids('jcc')};})()`) as Record<string, string[]>;
  expect(under.workshop).toEqual([WS]);
  expect(under.community).toEqual([RIDE]);
  expect(under.jcc).toEqual([]);
});

test('a customer without the tag goes straight to the review; the Saturday ride still turns them away', async ({ page }) => {
  await asAnyone(page);
  await page.evaluate(`S.selEvent='workshop';goCustomer('register');S.regStep=1;renderRegister()`);
  await page.evaluate(`selectSessCard('${WS}')`);
  await expect.poll(() => page.evaluate('S.selSession')).toBe(WS);
  await page.evaluate(`regNextFromSession()`);
  expect(await page.evaluate('S.regStep')).toBe(3);            // no riders step, no waiver: day, then confirm
  const panel = page.locator('#tab-register');
  await expect(panel).toContainText('Review and confirm');
  await expect(panel).not.toContainText('waiver');
  await expect(panel).not.toContainText('Bike Type');
  await expect(panel.locator('.reg-stepper')).toHaveAttribute('aria-label', 'Step 2 of 2');
  // Back from the review returns to the day list, not to an empty riders panel
  await page.locator('#tab-register .mm-reg-foot .btn-secondary').click();
  expect(await page.evaluate('S.regStep')).toBe(1);
  // the members gate is exactly where it was for the Saturday ride
  await page.evaluate(`S.selEvent='community';S.selSession=null;S.regStep=1;renderRegister()`);
  await page.evaluate(`selectSessCard('${RIDE}')`);
  await expect(page.locator('#confirm-modal')).toContainText('Community members only');
  expect(await page.evaluate('S.selSession')).toBeNull();
});

test('nothing about cycling on the review: no bike type, no height, participants not riders', async ({ page }) => {
  await asAnyone(page);
  // a saved cycling profile must not leak onto a workshop booking
  await page.evaluate(`S.selEvent='workshop';goCustomer('register');S.regStep=1;renderRegister();
    S.selSession='${WS}';S.regBikeTypes=['Road'];S.regBikeHeights=['177'];regNextFromSession()`);
  const panel = page.locator('#tab-register');
  await expect(panel).toContainText('Participants (1)');
  await expect(panel).not.toContainText('Riders');
  await expect(panel).not.toContainText('Road');
  await expect(panel).not.toContainText('177');
  await expect(panel).toContainText('Free');
});

test('the booking is one person, no bike, free, and carries no waiver', async ({ page }) => {
  await asAnyone(page);
  await page.evaluate(`S.selEvent='workshop';goCustomer('register');S.regStep=1;renderRegister()`);
  const rpc: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rpc/customer_create_booking')) rpc.push(r.postData() || '');
  });
  // a stale quantity from a circuit booking must not turn into three places
  await page.evaluate(`S.selSession='${WS}';S.regQty=3;ensureBikeSizes();regNextFromSession();submitReg()`);
  await expect.poll(() => rpc.length, { timeout: 6000 }).toBeGreaterThan(0);
  const entries = JSON.parse(rpc[0]).p_entries;
  expect(entries).toHaveLength(1);
  expect(entries[0].type_preference).toBe('None');
  expect(entries[0].size).toBe('');
  expect(entries[0].price).toBe(0);
  expect(entries[0].waiver_version ?? null).toBeNull();
});

test('a second reservation on the same workshop is refused', async ({ page }) => {
  await asAnyone(page, {
    queue_entries: [{
      id: 'q1', session_id: WS, session_day: 'Tuesday', session_date: '2099-03-10', queue_num: 1,
      name: 'Spec Anyone', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0,
      registered_at: '2099-01-01T10:00:00Z', approval: 'pending', customer_id: 'c1',
    }],
  });
  await page.evaluate(`S.selEvent='workshop';goCustomer('register');S.regStep=1;renderRegister()`);
  const rpc: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rpc/customer_create_booking')) rpc.push(r.postData() || '');
  });
  await page.evaluate(`S.selSession='${WS}';regNextFromSession();submitReg()`);
  await expect(page.locator('#already-booked-banner')).toBeVisible();
  await expect(page.locator('#already-booked-banner')).toContainText('You already have a booking for this session.');
  expect(rpc).toHaveLength(0);
});

test('staff see the open-booking hint, a session name and a spot cap; no breakfast, no gathering', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue();
    S.showAddSession=true;S.newSessEvent='workshop';renderSessions()`);
  const form = page.locator('#sess-add-form');
  await expect(form).toContainText('Open to every signed-in customer');
  await expect(form).toContainText('Session name');
  await expect(form).toContainText('Spots');
  await expect(form).toContainText('Meeting point');
  await expect(form).not.toContainText('Breakfast spot');
  await expect(form).not.toContainText('Gathering time');
  await expect(form.locator('#ns-title')).toHaveValue('T100 Triathlon Prep');
});

test('creating one stamps the kind, lifts the gate, and keeps the approval shape', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const writes: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' && r.method() !== 'PATCH') return;
    if (!r.url().includes('/rest/v1/sessions')) return;
    const b = r.postDataJSON();
    (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => writes.push({ ...x }));
  });
  await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='workshop';S.newSessSpots='30';renderSessions()`);
  await page.evaluate(`document.getElementById('ns-date').value='2099-01-13';addSession()`);
  await expect.poll(() => writes.length).toBeGreaterThan(1);
  const created = writes.find((w) => w.id);
  expect(created?.id).toBe('2099-01-13-tw');   // a circuit session may share the date
  expect(created?.capacity).toBe(30);
  const gate = Object.assign({}, ...writes.filter((w) => !w.id));
  expect(gate.event_kind).toBe('community');
  expect(gate.ride_kind).toBe('workshop');
  expect(gate.open_to_all).toBe(true);         // the whole point
  expect(gate.paid_ride).toBe(false);
  expect(gate.needs_approval).toBe(true);
  expect(gate.hide_queue).toBe(true);
  expect(gate.spots).toBe(30);
  // The name field was left at its prefilled default, so no title is stored and every reader
  // sees the default in their own language.
  expect(gate.title).toBeNull();
  expect(await page.evaluate(`_evName({event_kind:'community',ride_kind:'workshop',title:null})`)).toBe('T100 Triathlon Prep');
});

test('editing one keeps it open, and does not turn it into a Saturday ride', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`allSessions().length>0`);
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/sessions')) writes.push(r.postData() || '');
  });
  await page.evaluate(`S.editSessionId='${WS}';S.editSessDate='2099-03-10';S.editSessStatus='open';
    S.editSessTitle='';S.editSessMapUrl='https://maps.example.test/hq';S.editSessTotal=30;saveSessionEdit()`);
  await expect.poll(() => writes.some((w) => w.includes('ride_kind')), { timeout: 6000 }).toBe(true);
  const kindWrite = JSON.parse(writes.find((w) => w.includes('ride_kind'))!);
  expect(kindWrite.ride_kind).toBe('workshop');
  expect(kindWrite.open_to_all).toBe(true);
  expect(kindWrite.paid_ride).toBe(false);
  const ce = writes.map((w) => JSON.parse(w)).find((w) => 'breakfast_name' in w);
  expect(ce.breakfast_name).toBeNull();
  expect(ce.needs_approval).toBe(true);
});

// Same trap as the pool session: a light orange "dark theme" twin (#fb923c) always won on the
// white cards, at about 2.3:1. The workshop's name has to read at 4.5:1 or better.
test('the workshop name on its card reads at 4.5:1 or better', async ({ page }) => {
  // two workshop dates, so the picker lists cards instead of the single-session summary
  const second = { ...sessions[0], id: '2099-03-17-tw', session_date: '2099-03-17' };
  await asAnyone(page, { sessions: [...sessions, second] });
  await page.evaluate(`S.selEvent='workshop';goCustomer('register');S.regStep=1;renderRegister()`);
  const chip = page.locator('.sess-card .sess-comm-chip.ev-workshop').first();
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
