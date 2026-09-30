import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, unlockStaff, captureBookingRows } from './helpers/supabase';

// The Saudi National Day 96 ride: a public, paid community ride with its own card on the
// event picker and its own skin on the Reserve flow. What is checked here is what would
// quietly break it — the card appearing at all, the ride filtering to its own sessions,
// the members gate staying off, the party cap, and the skin coming off again on the way out.

const snd = {
  id: 'snd1', day: 'Wednesday', session_date: '2099-09-23', capacity: 24, status: 'open',
  created_at: 1, location: 'JCC', event_kind: 'community', ride_kind: 'snd96',
  needs_approval: false, hide_queue: false, paid_ride: true, open_to_all: true,
  spots: null, title: 'Saudi National Day 96 Ride',
  bike_slots: JSON.stringify({ _time: '20:00 - 22:00', Road: 12, Hybrid: 12 }),
};
const jcc = { id: 's1', day: 'Sunday', session_date: '2099-09-27', capacity: 12, status: 'open', created_at: 1, location: 'JCC' };
const sat = {
  id: 'comm1', day: 'Saturday', session_date: '2099-09-26', capacity: 20, status: 'open', created_at: 1,
  location: 'JCC', event_kind: 'community', needs_approval: true, hide_queue: true, spots: 20, title: 'Saturday Social Ride',
};
const fixtures = { sessions: [jcc, snd, sat], bikes: [], queue_entries: [] };

async function boot(page: Page) {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
}

test('the event picker carries the National Day card, with the official lockup', async ({ page }) => {
  await boot(page);
  const card = page.locator('.landing-event-card.ev-snd96');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Saudi National Day 96 Ride');
  await expect(card.locator('img')).toHaveAttribute('src', '/assets/snd96-logo.svg');
});

test('once the ride is over the card is gone, and the other two stay', async ({ page }) => {
  const over = { ...snd, session_date: '2020-09-23', status: 'closed' };
  await stubSupabase(page, { ...fixtures, sessions: [jcc, over, sat] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await expect(page.locator('#land-events .landing-event-card.ev-jcc')).toBeVisible();
  await expect(page.locator('#land-events .landing-event-card.ev-snd96')).toHaveCount(0);
  await expect(page.locator('#land-events .landing-event-card')).toHaveCount(2);
});

test('the ride is open to everyone: no members gate between the card and the sessions', async ({ page }) => {
  await boot(page);
  await page.locator('.landing-event-card.ev-snd96').click();
  // the gate that answers a community click never opens for this ride
  await expect(page.locator('#comm-members-modal, .comm-members-box')).toHaveCount(0);
  // one date, so the ride is shown rather than offered as a choice
  await expect(page.locator('.sess-solo')).toContainText('Saudi National Day 96 Ride');
  // there is no gate to open: the umbrella never covers this ride, even on this row, which
  // carries the old 'community' stamp
  expect(await page.evaluate(`_isCommunity(allSessions().find(s=>s.id==='snd1'))`)).toBe(false);
});

test('each card lists only its own ride', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(`allSessions().filter(s=>_evMatch(s,'snd96')).map(s=>s.id)`)).toEqual(['snd1']);
  // the umbrella card keeps the Saturday ride and does NOT swallow the National Day one
  expect(await page.evaluate(`allSessions().filter(s=>_evMatch(s,'community')).map(s=>s.id)`)).toEqual(['comm1']);
  expect(await page.evaluate(`allSessions().filter(s=>_evMatch(s,'jcc')).map(s=>s.id)`)).toEqual(['s1']);
});

test('the flow wears the skin while it is on the ride, and takes it off on the way out', async ({ page }) => {
  await boot(page);
  await page.locator('.landing-event-card.ev-snd96').click();
  expect(await page.evaluate(`document.body.classList.contains('snd96')`)).toBe(true);
  await expect(page.locator('.snd-flow-head')).toBeVisible();
  // a different ride is a different flow: the skin must not follow it
  await page.evaluate(`selectEvent('jcc')`);
  await expect(page.locator('.snd-flow-head')).toHaveCount(0);
  expect(await page.evaluate(`document.body.classList.contains('snd96')`)).toBe(false);
});

test('one account seats a party of three, and the ticket carries the ride', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(`_maxRiders(allSessions().find(s=>s.id==='snd1'))`)).toBe(3);
  await page.locator('.landing-event-card.ev-snd96').click();
  await page.evaluate(`
    S.lastTickets=[{id:'bk1',queueNum:12,status:'waiting',sessionId:'snd1',sessionDay:'Wednesday',
      sessionDate:'23 Sep 2099',name:'Spec Rider',typePreference:'Road',price:60,paid:false}];
    renderRegister();`);
  await expect(page.locator('.ticket-card.ev-snd96')).toBeVisible();
});

// ── Its times gather, they do not run to an end ──────────────────────────────
// The National Day ride gathers and then sets off, so its two times are "gathering" and
// "start": there is no end time to ask for and no bike collection time either. That used to
// be inferred from needing staff approval, which this ride does not, so the two ideas had to
// come apart: the ride KIND decides now.

test('its stored times read as gathering then start, and Petromin still reads start then end', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);

  expect(await page.evaluate(`_gathersTime(allSessions().find(s=>s.id==='snd1'))`)).toBe(true);
  // 20:00 - 22:00 on a gathering ride means gather at 8 and set off at 10 — no end time.
  expect(await page.evaluate(`sessionCollectTime(allSessions().find(s=>s.id==='snd1'))`)).toBe('20:00');
  expect(await page.evaluate(`sessionTime(allSessions().find(s=>s.id==='snd1'))`)).toMatch(/8 PM.*10 PM/);

  // The Saturday ride gathers too, and always did.
  expect(await page.evaluate(`_gathersTime(allSessions().find(s=>s.id==='comm1'))`)).toBe(true);

  // Petromin does NOT: it hands bikes out, so its window is start-to-end and its collection
  // time is 45 minutes before the off. This is the regression the trait change could cause.
  const petro = `{id:'p1',day:'Wednesday',session_date:'2099-09-30',status:'open',capacity:35,
    event_kind:'community',ride_kind:'petromin',paid_ride:true,needs_approval:false,
    bike_slots:JSON.stringify({_time:'19:00 - 21:00',_total:35})}`;
  expect(await page.evaluate(`_gathersTime(${petro})`)).toBe(false);
  expect(await page.evaluate(`sessionCollectTime(${petro})`)).toBe('18:15');
  expect(await page.evaluate(`_gathersTime(allSessions().find(s=>s.id==='s1'))`)).toBe(false);
});

test('the ticket names the gathering, not a bike collection', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.lastTickets=[{id:'t1',queueNum:4,name:'Spec Rider',sessionId:'snd1',
    sessionDay:'Wednesday',sessionDate:'2099-09-23',status:'waiting'}];S.regStep=4;setCustTab('register')`);
  const card = page.locator('.ticket-card').first();
  await expect(card).toContainText('8 PM');
  await expect(card).toContainText(/Gathering time/i);
  await expect(card).not.toContainText(/collection/i);
});

test('the session form asks for a gathering and a start, with no end and no collection time', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await page.addInitScript(() => localStorage.setItem('cq_staff', '1'));
  await page.goto('/');
  await waitForSb(page);
  // Two named times: yes. Petromin keeps its window plus a bike collection time.
  expect(await page.evaluate(`(()=>{S.newSessEvent='snd96';return _nsTwoTimes();})()`)).toBe(true);
  expect(await page.evaluate(`(()=>{S.newSessEvent='petromin';return _nsTwoTimes();})()`)).toBe(false);
  expect(await page.evaluate(`_twoTimesSess(allSessions().find(s=>s.id==='snd1'))`)).toBe(true);
  expect(await page.evaluate(`_gathers(allSessions().find(s=>s.id==='snd1'))`)).toBe(true);

  // ...but it is NOT a spots ride. It rents bikes from the fleet and it is paid, so it keeps
  // the fleet picker and the add-ons and does not get a meeting point. Counting spots and
  // naming two times are different questions, and conflating them cost this ride its fleet.
  expect(await page.evaluate(`(()=>{S.newSessEvent='snd96';return _nsSeats();})()`)).toBe(false);
  expect(await page.evaluate(`_needsBike(allSessions().find(s=>s.id==='snd1'))`)).toBe(true);
  // The pool session is the other way round: spots, no bikes, and start-to-end times.
  expect(await page.evaluate(`(()=>{S.newSessEvent='swim';return [_nsSeats(),_nsTwoTimes()];})()`)).toEqual([true, true]);
  expect(await page.evaluate(`_kindHas('swim','gathering')`)).toBe(false);
});

// ── It is a circuit night, not a community event ─────────────────────────────
// It never needed the umbrella: no members tag, no staff approval, circuit prices, an
// ordinary bike fleet. The flag only decided where staff found it, and it quietly carried
// the ride's identity, because _rideKind answered "jcc" for anything outside the umbrella.

test('it is stamped as a circuit night and still keeps its own identity', async ({ page }) => {
  const plain = { ...snd, event_kind: null };
  await stubSupabase(page, { sessions: [jcc, plain, sat], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  const s = `allSessions().find(x=>x.id==='snd1')`;

  expect(await page.evaluate(`_isCommunity(${s})`)).toBe(false);   // out of the umbrella
  expect(await page.evaluate(`_rideKind(${s})`)).toBe('snd96');    // ...but still itself
  expect(await page.evaluate(`_evMatch(${s},'snd96')`)).toBe(true); // its own card
  expect(await page.evaluate(`_maxRiders(${s})`)).toBe(3);          // its own rider cap
  expect(await page.evaluate(`_gathersTime(${s})`)).toBe(true);     // and its gathering time
  expect(await page.evaluate(`sessionCollectTime(${s})`)).toBe('20:00');
  // It is not filed with the employer rides, and has no employee registration desk.
  expect(await page.evaluate(`_evMatch(${s},'community')`)).toBe(false);
  expect(await page.evaluate(`allSessions().filter(x=>_isCommunity(x)).map(x=>x.id)`)).not.toContain('snd1');
  // ...and having left the umbrella it must not fall into the circuit list either, or it
  // would be offered twice: once under its own card and once among the circuit nights.
  expect(await page.evaluate(`_evMatch(${s},'jcc')`)).toBe(false);
  expect(await page.evaluate(`allSessions().filter(x=>_evMatch(x,'jcc')).map(x=>x.id)`)).toEqual(['s1']);
});

test('the rider cap rolls with the account, exactly as the circuit does', async ({ page }) => {
  // Three riders per ACCOUNT per session, not per booking. A second booking for the same
  // night draws on the same three, so the cap has to count what the account already holds -
  // a flat three would let a rider book three and then three more.
  const plain = { ...snd, event_kind: null };
  const held = (id: string, sid: string) => ({ id, name: 'Spec Rider', customer_id: 'c1', session_id: sid,
    session_day: 'Wednesday', session_date: '2099-09-23', queue_num: 1, status: 'waiting', paid: false, price: 60 });
  await stubSupabase(page, { sessions: [jcc, plain, sat], bikes: [],
    queue_entries: [held('h1', 'snd1'), held('h2', 'snd1')] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  // two of the three already booked leaves one
  expect(await page.evaluate(`_maxRiders(allSessions().find(x=>x.id==='snd1'))`)).toBe(1);
  // and a night the account holds nothing on still offers all three
  expect(await page.evaluate(`_maxRiders(allSessions().find(x=>x.id==='s1'))`)).toBe(3);
});

test('a session stamped the old way still behaves the same', async ({ page }) => {
  // Rows created before this change carry event_kind 'community'. The ride kind is read off
  // the row first, so they keep their card, their cap and their gathering time.
  await stubSupabase(page, { sessions: [jcc, snd, sat], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  const s = `allSessions().find(x=>x.id==='snd1')`;
  expect(await page.evaluate(`_rideKind(${s})`)).toBe('snd96');
  expect(await page.evaluate(`_gathersTime(${s})`)).toBe(true);
  expect(await page.evaluate(`_maxRiders(${s})`)).toBe(3);
});

test('the circuit, the Saturday ride and Petromin are untouched', async ({ page }) => {
  const pet = { id: 'p1', day: 'Wednesday', session_date: '2099-09-30', capacity: 35, status: 'open',
    created_at: 1, event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false,
    bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }) };
  await stubSupabase(page, { sessions: [jcc, sat, pet], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  const kind = (id: string) => page.evaluate(`_rideKind(allSessions().find(x=>x.id==='${id}'))`);
  expect(await kind('s1')).toBe('jcc');
  expect(await kind('comm1')).toBe('saturday');
  expect(await kind('p1')).toBe('petromin');
  // Petromin still runs start-to-end with a bike collection time 45 minutes before the off.
  expect(await page.evaluate(`_gathersTime(allSessions().find(x=>x.id==='p1'))`)).toBe(false);
  expect(await page.evaluate(`sessionCollectTime(allSessions().find(x=>x.id==='p1'))`)).toBe('18:15');
});

// ── One date, two rides ──────────────────────────────────────────────────────
// A session's id is its date, so a date holds one session unless the ride carries a mark.
// The National Day ride borrowed the Petromin mark, being paid like one — so the two could
// never share a date. 23 September 2026 already held a Petromin ride, and the National Day
// ride staff tried to put on it was skipped as a date that already exists.
const pw = {
  id: '2099-01-14-pw', day: 'Wednesday', session_date: '2099-01-14', capacity: 35, status: 'closed',
  created_at: 1, event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false,
  bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }),
};

function sessionWrites(page: Page) {
  const writes: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' && r.method() !== 'PATCH') return;
    if (!r.url().includes('/rest/v1/sessions')) return;
    const b = r.postDataJSON();
    (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => writes.push({ ...x }));
  });
  return writes;
}

test('it can be put on a date a Petromin ride already holds', async ({ page }) => {
  await stubSupabase(page, { sessions: [pw], queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const writes = sessionWrites(page);
  await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='snd96';S.newSessMode='total';S.newSessTotal='40';renderSessions()`);
  await page.evaluate(`document.getElementById('ns-date').value='2099-01-14';addSession()`);
  await expect.poll(() => writes.length).toBeGreaterThan(1);

  const created = writes.find((w) => w.id);
  expect(created?.id).toBe('2099-01-14-nd');   // its own mark, not the Petromin one
  expect(created?.capacity).toBe(40);
  const gate = Object.assign({}, ...writes.filter((w) => !w.id));
  expect(gate.event_kind).toBe(null);          // a circuit night, not an employer ride
  expect(gate.ride_kind).toBe('snd96');
  expect(gate.paid_ride).toBe(true);
  expect(gate.needs_approval).toBe(false);
});

test('moving its date keeps its mark, so the move cannot land on another ride', async ({ page }) => {
  const nd = { ...snd, id: '2099-01-14-nd', session_date: '2099-01-14', event_kind: null };
  await stubSupabase(page, { sessions: [pw, nd], queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`allSessions().length>1`);
  const writes = sessionWrites(page);
  await page.evaluate(`S.editSessionId='2099-01-14-nd';S.editSessDate='2099-01-21';S.editSessStatus='open';S.editSessMode='total';S.editSessTotal=40;saveSessionEdit()`);
  await expect.poll(() => writes.some((w) => w.id)).toBe(true);
  expect(writes.find((w) => w.id)?.id).toBe('2099-01-21-nd');
});

// ── A date holds as many sessions as staff put on it ─────────────────────────
// The id is still the date plus the ride's mark, because that is what every screen reads.
// A second session of the same kind on the same date takes the next number after it.
test('a second session on the same date is numbered, not refused', async ({ page }) => {
  const nd = { ...snd, id: '2099-01-14-nd', session_date: '2099-01-14', event_kind: null };
  await stubSupabase(page, { sessions: [nd], queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  // the stub answers a repeated id the way Postgres does, so the client has to find the gap
  await page.route('**/rest/v1/sessions*', async (route) => {
    const r = route.request();
    if (r.method() === 'POST' && String(r.postData() || '').includes('"2099-01-14-nd"')) {
      return route.fulfill({ status: 409, contentType: 'application/json',
        body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint' }) });
    }
    await route.fallback();
  });
  const writes = sessionWrites(page);
  await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='snd96';S.newSessMode='total';S.newSessTotal='12';renderSessions()`);
  await page.evaluate(`document.getElementById('ns-date').value='2099-01-14';addSession()`);

  await expect.poll(() => writes.filter((w) => w.id).length).toBe(2);
  expect(writes.filter((w) => w.id).map((w) => w.id)).toEqual(['2099-01-14-nd', '2099-01-14-nd-2']);
  // and the one that stuck is the one that got its event fields
  const gate = Object.assign({}, ...writes.filter((w) => !w.id));
  expect(gate.ride_kind).toBe('snd96');
});

test('saving a numbered session does not read as a date change', async ({ page }) => {
  // Its id carries a number, so rebuilding the id from the date alone would drop it: the save
  // would copy the session onto the FIRST session's id and delete this one.
  const nd2 = { ...snd, id: '2099-01-14-nd-2', session_date: '2099-01-14', event_kind: null };
  await stubSupabase(page, { sessions: [nd2], queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`allSessions().length>0`);
  const writes = sessionWrites(page);
  const deletes: string[] = [];
  page.on('request', (r) => { if (r.method() === 'DELETE' && r.url().includes('/rest/v1/sessions')) deletes.push(r.url()); });
  await page.evaluate(`S.editSessionId='2099-01-14-nd-2';S.editSessDate='2099-01-14';S.editSessStatus='open';S.editSessMode='total';S.editSessTotal=20;saveSessionEdit()`);
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes.some((w) => w.id)).toBe(false);   // nothing was re-inserted: it never moved
  expect(deletes).toEqual([]);                    // and the session is still there
});

// ── The federation's form is what actually puts a rider on the start line ────
// Booking a bike here is not entering the ride: entry is a separate form on sacf.sa that we
// cannot see or check. So the confirmation says so, in bold, and the popup holds itself shut
// long enough to be read rather than dismissed on reflex.
const FORM_URL = 'https://sacf.sa/?page_id=11138';

// The event has to be picked as well as the session: a rider reaches a session through its
// card, and renderRegister drops a selection that is not in the picked event's own list.
async function bookInto(page: Page, event: string, sessionId: string) {
  await page.evaluate(`S.selEvent='${event}';S.selSession='${sessionId}';S.regQty=1;S.regBikeHeights=[175];
    S.regBikeTypes=['Road'];S.regRiderNames=['Spec Rider'];S.promoApplied=null;S.waiverOk=true;submitReg();`);
}

test('booking it asks for the sign-up form, and will not be dismissed at once', async ({ page }) => {
  const plain = { ...snd, event_kind: null };
  await stubSupabase(page, { sessions: [jcc, plain, sat], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await bookInto(page, 'snd96', 'snd1');

  const box = page.locator('#booth-popup');
  await expect(box).toBeVisible();
  // it replaces the pay-at-the-booth cue rather than joining it
  await expect(page.locator('#booth-popup-msg')).not.toContainText('booth');
  const link = page.locator('#booth-popup-msg a');
  await expect(link).toHaveAttribute('href', FORM_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  // the warning is bold, and it is the warning that is bold
  await expect(page.locator('#booth-popup-extra strong'))
    .toHaveText('You will not be able to take part unless you complete the form.');

  const close = page.locator('.booth-popup-close');
  await expect(close).toBeDisabled();          // a reflex tap does nothing
  await expect(close).toHaveText('\u2715');    // it dims, it does not count down
  await page.evaluate(`closeBoothPopup()`);    // nor does anything else reaching for it
  await expect(box).toBeVisible();

  await expect(close).toBeEnabled({ timeout: 9000 });
  await close.click();
  await expect(box).toBeHidden();
});

// Since 2026-09-30 the circuit's pay-at-the-booth cue is on the riders step, the review and the
// ticket itself, before and after the booking; no popup repeats it (the National Day one stays).
test('a circuit booking gets no popup: the ticket says what is paid at the booth', async ({ page }) => {
  await stubSupabase(page, { sessions: [jcc], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await bookInto(page, 'jcc', 's1');

  await expect(page.locator('#tab-register .ticket-card')).toContainText('at the booth when you arrive');
  await expect(page.locator('#booth-popup')).toBeHidden();
});

// ── One date, so nothing to pick ─────────────────────────────────────────────
// The National Day ride is a single night. Step one used to be a list holding one card that
// had to be tapped before Continue would light up; now picking the event opens the ride.
test('picking the event opens the ride itself, not a list of one', async ({ page }) => {
  const plain = { ...snd, event_kind: null };
  await stubSupabase(page, { sessions: [jcc, plain, sat], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await page.locator('.landing-event-card.ev-snd96').click();

  await expect(page.locator('.sess-solo')).toBeVisible();
  await expect(page.locator('.sess-card')).toHaveCount(0);        // no picker
  await expect(page.locator('.sess-solo')).toContainText('Saudi National Day 96 Ride');
  await expect(page.locator('.sess-solo')).toContainText('Wednesday');
  await expect(page.locator('.sess-solo')).toContainText('Gathering 8 PM');
  await expect(page.locator('.sess-solo')).toContainText('Start 10 PM');
  // the ride is already chosen, so Continue is live without a tap
  expect(await page.evaluate(`S.selSession`)).toBe('snd1');
  await expect(page.locator('.mm-reg-foot .btn-primary')).toBeEnabled();
  await page.locator('.mm-reg-foot .btn-primary').click();
  expect(await page.evaluate(`S.regStep`)).toBe(2);
});

test('a second National Day date brings the picker back', async ({ page }) => {
  const a = { ...snd, event_kind: null };
  const b = { ...snd, id: 'snd2', event_kind: null, session_date: '2099-09-24', day: 'Thursday' };
  await stubSupabase(page, { sessions: [a, b], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await page.locator('.landing-event-card.ev-snd96').click();

  await expect(page.locator('.sess-solo')).toHaveCount(0);
  await expect(page.locator('.sess-card')).toHaveCount(2);
  expect(await page.evaluate(`S.selSession`)).toBe(null);   // a real choice, so nothing is chosen
});

test('the circuit still asks which night', async ({ page }) => {
  const b = { ...jcc, id: 's2', session_date: '2099-09-28', day: 'Monday' };
  await stubSupabase(page, { sessions: [jcc, b], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`selectEvent('jcc')`);
  await expect(page.locator('.sess-card')).toHaveCount(2);
  await expect(page.locator('.sess-solo')).toHaveCount(0);
  expect(await page.evaluate(`S.selSession`)).toBe(null);
});

// ── The green field is a dark surface wherever it is met ─────────────────────
// The card paints itself teal on any page, but its ink came from the page. Met on paper -
// My Bookings, the confirmation, a staff screen - every var() inside it still resolved to
// the palette meant for white paper: the type chip wrote near-black on the field at 1.08:1,
// the RIDERS/ADD-ONS/TOTAL labels and the date block sat at 2.15, "Pending" at 2.77, the
// total in house green at 2.98, and the status badges, which are literals on both skins,
// between 2.1 and 2.52. This measures the card the way a browser composites it.
const CONTRAST = `(() => {
  const px = (c) => { const m = c.match(/[\\d.]+/g) || []; return { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  const bgOf = (el) => { let ls = [], n = el;
    while (n && n !== document.documentElement) { const c = px(getComputedStyle(n).backgroundColor);
      if (c.a > 0) { ls.unshift(c); if (c.a === 1) break; } n = n.parentElement; }
    return ls.reduce((b, l) => over(l, b), { r: 255, g: 255, b: 255, a: 1 }); };
  const card = document.querySelector('.ticket-card.ev-snd96');
  if (!card) return [{ text: 'NO CARD', ratio: 0, need: 4.5 }];
  const out = [];
  card.querySelectorAll('*').forEach((el) => {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!own) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || !el.getClientRects().length) return;
    const size = parseFloat(cs.fontSize), weight = +cs.fontWeight || 400, bg = bgOf(el);
    out.push({ text: own.slice(0, 30), ratio: +ratio(over(px(cs.color), bg), bg).toFixed(2),
      need: (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5 });
  });
  return out.sort((a, b) => a.ratio - b.ratio);
})()`;

test('the booking card is readable on a paper page, in every state a rider can meet it', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [snd], bikes: [],
    queue_entries: [{
      id: 'bk1', session_id: 'snd1', session_day: 'Wednesday', session_date: '2099-09-23',
      queue_num: 1, name: 'Spec Rider', phone: '0500000000', customer_id: 'c1',
      status: 'waiting', paid: false, price: 75, type_preference: 'Road', size: 'M',
      registered_at: '2099-01-01T10:00:00Z',
    }],
  });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`setCustTab('myrides');renderMyRides();`);
  await expect(page.locator('.ticket-card.ev-snd96')).toBeVisible();
  // The takeover is NOT up: this is the page the card is met on most of the time.
  expect(await page.evaluate(`document.body.classList.contains('snd96')`)).toBe(false);

  for (const [state, setup] of [
    ['waiting', `S.queue[0].status='waiting';S.queue[0].paid=false;`],
    ['on the bike', `S.queue[0].status='active';`],
    ['waitlisted', `S.queue[0].status='waitlist';S.queue[0].waitlistNum=3;`],
    ['paid', `S.queue[0].status='waiting';S.queue[0].paid=true;`],
    ['finished', `S.queue[0].status='done';`],
  ] as const) {
    await page.evaluate(`${setup}renderMyRides();`);
    const rows = await page.evaluate(CONTRAST) as Array<{ text: string; ratio: number; need: number }>;
    expect(rows.length, state).toBeGreaterThan(5);
    const failed = rows.filter((r) => r.ratio < r.need).map((r) => `"${r.text}" ${r.ratio}:1`);
    expect(failed, `${state}: unreadable text on the green field`).toEqual([]);
  }
});

test('it reads the same whether or not the takeover is up', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [snd], bikes: [],
    queue_entries: [{
      id: 'bk1', session_id: 'snd1', session_day: 'Wednesday', session_date: '2099-09-23',
      queue_num: 1, name: 'Spec Rider', phone: '0500000000', customer_id: 'c1',
      status: 'waiting', paid: false, price: 75, type_preference: 'Road', size: 'M',
      registered_at: '2099-01-01T10:00:00Z',
    }],
  });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`setCustTab('myrides');renderMyRides();`);
  await expect(page.locator('.ticket-card.ev-snd96')).toBeVisible();
  // The ink the card writes with comes from the card, not from the page under it. These are
  // the lines that broke: the type chip read 1.08:1 on paper against 13.18 under the takeover,
  // because the page decided how its own card read. (The buttons are not in this list - they
  // are the page's buttons, and they follow the page's skin on purpose. 'Add-ons' used to be
  // sampled here too; the section now only exists when the booking has add-ons, and this one
  // has none. 'Total' carries the same muted ink, so the reading is unchanged.)
  const inks = () => page.evaluate(`(() => {
    const card = document.querySelector('.ticket-card.ev-snd96');
    const out = {};
    card.querySelectorAll('*').forEach((el) => {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim())
        .map((n) => n.textContent.trim()).join(' ');
      const key = /^(Road|Riders ·|Total|Pay at the booth)$/.test(own) ? own : /^\u2066\u20C1\u00A075\u2069$/.test(own) ? 'price' : '';
      if (key && !out[key]) out[key] = getComputedStyle(el).color;
    });
    return out;
  })()`) as Promise<Record<string, string>>;
  const onPaper = await inks();
  expect(Object.keys(onPaper).sort()).toEqual(['Pay at the booth', 'Riders ·', 'Road', 'Total', 'price']);
  await page.evaluate(`document.body.classList.add('snd96');renderMyRides();`);
  expect(await inks()).toEqual(onPaper);
});

// ── Bike owners ride free ────────────────────────────────────────────────────
// The National Day ride takes riders on their own bikes as well as on ours. An owner pays
// nothing and takes none of the ride's places: those count Micromobility bikes. The circuit
// keeps its rental-only menu.

async function toRiders(page: Page) {
  await page.locator('.landing-event-card.ev-snd96').click();
  await page.locator('.mm-reg-foot .btn-primary').click();
  expect(await page.evaluate(`S.regStep`)).toBe(2);
}

test('a rider can say they bring their own bike, and it is free', async ({ page }) => {
  const plain = { ...snd, event_kind: null };                 // as the live row is stamped
  await stubSupabase(page, { sessions: [jcc, plain, sat], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  const rows = await captureBookingRows(page);
  await page.goto('/');
  await waitForSb(page);
  await toRiders(page);

  const types = await page.evaluate(`Array.from(document.querySelectorAll('[data-type-slot="0"]')).map(b=>b.dataset.type)`);
  expect(types).toContain('Own');
  expect(types).toContain('Road Carbon');                     // not a community ride: carbon stays
  await expect(page.locator('[data-type-slot="0"][data-type="Own"]')).toHaveText('I have my own bike');

  await page.evaluate(`S.regQty=1;S.regBikeHeights=[175];S.regBikeTypes=['Own'];S.regRiderNames=['Spec Rider'];S.promoApplied=null;S.waiverOk=true;submitReg();`);
  await expect.poll(() => rows.length).toBe(1);
  expect(rows[0].type_preference).toBe('Own');
  expect(rows[0].price).toBe(0);
});

test('an owner is told their place is booked; a renter, their bike', async ({ page }) => {
  const plain = { ...snd, event_kind: null };
  await stubSupabase(page, { sessions: [jcc, plain, sat], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.selEvent='snd96';S.selSession='snd1';S.regQty=1;S.regBikeHeights=[175];
    S.regBikeTypes=['Own'];S.regRiderNames=['Spec Rider'];S.promoApplied=null;S.waiverOk=true;submitReg();`);
  await expect(page.locator('#booth-popup-msg')).toContainText('Your place is booked');
  await expect(page.locator('#booth-popup-msg')).not.toContainText('Your bike is booked');
  expect(await page.evaluate(`t('snd96FormMsg')`)).toContain('Your bike is booked');
});

test('an owner takes none of the ride\'s places, and the circuit still offers no owner option', async ({ page }) => {
  const plain = { ...snd, event_kind: null };
  await stubSupabase(page, { sessions: [jcc, plain, sat], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  const offered = (id: string) => page.evaluate(`_ownOffered(allSessions().find(x=>x.id==='${id}'))`);
  expect(await offered('snd1')).toBe(true);
  expect(await offered('comm1')).toBe(true);
  expect(await offered('s1')).toBe(false);
  expect(await page.evaluate(`_holdsSpot({status:'waiting',typePreference:'Own'},allSessions().find(x=>x.id==='snd1'))`)).toBe(false);
  expect(await page.evaluate(`_holdsSpot({status:'waiting',typePreference:'Road'},allSessions().find(x=>x.id==='snd1'))`)).toBe(true);
});

test('at the desk, the walk-in menu offers an owner on this ride and not on the circuit', async ({ page }) => {
  const plain = { ...snd, event_kind: null };
  await stubSupabase(page, { sessions: [jcc, plain], bikes: [], queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.sfSession='snd1';S._wiType='Own';showWalkinModal()`);
  await expect(page.locator('#walkin-modal [data-wi-type="Own"]')).toHaveCount(1);
  await page.locator('#wi-name').fill('Desk Rider');
  await page.selectOption('#wi-sess', 's1');                 // the circuit: the menu follows
  await expect(page.locator('#walkin-modal [data-wi-type="Own"]')).toHaveCount(0);
  expect(await page.evaluate(`S._wiType`)).toBe('Any');       // an owner carried there rents
  await expect(page.locator('#wi-name')).toHaveValue('Desk Rider');
  await page.selectOption('#wi-sess', 'snd1');
  await expect(page.locator('#walkin-modal [data-wi-type="Own"]')).toHaveCount(1);
});

test('check-in and the booking editor offer the owner type on this ride', async ({ page }) => {
  const plain = { ...snd, event_kind: null };
  const own = { id: 'e1', session_id: 'snd1', session_day: 'Wednesday', session_date: '2099-09-23', queue_num: 1,
    name: 'Owner Rider', status: 'waiting', paid: false, price: 0, type_preference: 'Own', registered_at: '2099-01-01T10:00:00Z' };
  await stubSupabase(page, { sessions: [jcc, plain], bikes: [], queue_entries: [own] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`showCheckinModal('e1')`);
  await expect(page.locator('button.toggle-btn', { hasText: 'Bike owner' }).first()).toBeVisible();
  await page.evaluate(`closeCheckinModal&&closeCheckinModal()`).catch(() => {});
  await page.evaluate(`showBookingEditModal('e1')`);
  await expect(page.locator('button', { hasText: 'Bike owner' }).first()).toBeVisible();
});

// ── Edit opens the booking under its own ride ─────────────────────────────────
// Edit set the session but not the event, and the Reserve flow drops a session that is not in
// the current event's list. In a freshly opened app the event is the circuit, so Edit on a
// National Day booking landed on the circuit's sessions, and a confirm from there got the
// pay-at-the-booth popup - closable at once - instead of the federation form and its hold.
test('Edit on a National Day booking opens the ride, and saving it is an edit, not a new circuit booking', async ({ page }) => {
  const nd = { ...snd, event_kind: null };
  const held = { id: 'b1', name: 'Spec Rider', customer_id: 'c1', session_id: 'snd1', session_day: 'Wednesday',
    session_date: '2099-09-23', queue_num: 1, status: 'waiting', paid: false, price: 75, type_preference: 'Road', height: 175 };
  await stubSupabase(page, { sessions: [jcc, nd, sat], bikes: [], queue_entries: [held] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  const created: string[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /rpc\/customer_create_booking|rest\/v1\/queue_entries/.test(r.url())) created.push(r.url()); });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('myrides')`);
  await page.locator('.ticket-card button', { hasText: 'Edit' }).first().click();
  expect(await page.evaluate(`[S.selEvent,S.selSession,S.regStep]`)).toEqual(['snd96', 'snd1', 2]);
  expect(await page.evaluate(`document.body.classList.contains('snd96')`)).toBe(true);
  // the review step's button is the edit's own save, as the rider would press it
  await page.evaluate(`S.regStep=3;renderRegister();`);
  const save = page.locator('.mm-reg-foot .btn-primary, button.btn-primary[data-on-click*="submitModifyBooking"]').first();
  await expect(save).toHaveAttribute('data-on-click', '["submitModifyBooking"]');
  await save.click();
  await page.waitForTimeout(800);
  expect(created).toEqual([]);                                                    // no new booking made
  expect(await page.evaluate(`document.getElementById('booth-popup').style.display!=='flex'
    ||document.getElementById('booth-popup-title').textContent!=='Payment Info'`)).toBe(true);
});
