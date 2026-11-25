import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// The Wednesday Community Ride (the user, 2026-11-25): a hybrid of the Petromin night and the Saturday Social Ride. A bike
// ride inside MicroMobility Experiences for community members alone, not featured; first come first served; paid like a
// Petromin night's website booker (the standard fare per type at the desk, own bike free); meet up 6:30 PM, ride 7 PM at
// the Saturday ride's meeting point; no ride groups, distance or route; no place limit (500 places, never counted out).

const WC = '2099-11-25-wc';
const SAT_MAP = 'https://maps.app.goo.gl/pdcMn1mGcCdabia7A?g_st=ic';
const wed = {
  id: WC, session_date: '2099-11-25', day: 'Wednesday', status: 'open', capacity: 500, created_at: 1,
  event_kind: 'community', ride_kind: 'wed', needs_approval: false, hide_queue: true, spots: 500, open_to_all: false,
  paid_ride: true, price: null, title: 'Wednesday Community Ride', title_ar: 'جولة الأربعاء المجتمعية', meet_url: SAT_MAP,
  bike_slots: '{"_time":"18:30 - 19:00"}',
};
const sat = {
  id: '2099-11-28', session_date: '2099-11-28', day: 'Saturday', status: 'open', capacity: 120, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 120, open_to_all: false,
  meet_url: SAT_MAP, bike_slots: '{"_time":"05:45 - 06:15"}',
};

async function custBoot(page: Page, fx: Record<string, unknown> = {}, member = true) {
  await stubSupabase(page, { sessions: [wed, sat], queue_entries: [], 'rpc:community_member': member, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}

test.describe('@customer:wed Wednesday Community Ride', () => {
  test('a paid bike ride of its own kind that gathers, takes a party of two, no groups, not featured', async ({ page }) => {
    await custBoot(page);
    const k = await page.evaluate(`(()=>{const s=allSessions().find(x=>x.id==='${WC}');
      return {kind:_rideKind(s),bike:_needsBike(s),approval:_isApprovalRide(s),free:_isFreeRide(s),waiver:_waiverKind(s),
        groups:_hasRideGroups(s),gathers:_gathersTime(s),party:_isGroupRide(s),max:_maxRiders(s),feat:_featured(s),
        exp:_evMatch(s,'community'),ev:_evOf(s),steps:_regSteps(s),seat:_evSeatPrice(s),bf:_hasBreakfast(s),km:_rideKm(s),
        time:sessionTime(s),where:_venueName(s),map:_ownMapUrl(s),noCarbon:_noCarbon(s)};})()`);
    expect(k).toEqual({
      kind: 'wed', bike: true, approval: false, free: false, waiver: 'ride', groups: false, gathers: true, party: true, max: 2,
      feat: false, exp: true, ev: 'community', steps: [1, 2, 3], seat: null, bf: false, km: 0,
      time: 'Gathering 6:30 PM · Start 7 PM', where: 'Meeting point', map: SAT_MAP, noCarbon: true,
    });
  });

  test('a member finds it inside Experiences, in the community ride look, never featured, never counted out', async ({ page }) => {
    await custBoot(page);
    // the Experiences card carries its mark for a member
    await expect(page.locator('#land-events .lec-marks .lec-mk.ev-wed')).toHaveCount(1);
    // the event picker features nothing of it
    expect(await page.evaluate(`_featLand().some(s=>s.id==='${WC}')`)).toBe(false);
    await page.evaluate(`selectEvent('community')`);
    const card = page.locator('#tab-register .sess-card.ev-wed');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Wednesday Community Ride');
    await expect(card).toContainText('Gathering 6:30 PM · Start 7 PM');
    await expect(card).toContainText('57.5');
    await expect(card.locator('.k-art')).toHaveCount(1); // the Saturday ride's art
    await expect(card).not.toContainText(/left|places/i);
    await expect(page.locator('#tab-register .sess-feat .ev-wed')).toHaveCount(0);
  });

  test('a rider who is not a member does not see it, nor its Details', async ({ page }) => {
    await custBoot(page, {}, false);
    await expect(page.locator('#land-events .landing-events-grid')).toBeVisible();
    await expect(page.locator('#land-events .lec-mk.ev-wed')).toHaveCount(0);
    expect(await page.evaluate(`_infoShowSess(allSessions().find(x=>x.id==='${WC}'))`)).toBe(false);
    expect(await page.evaluate(`_infoDetailsBtn(allSessions().find(x=>x.id==='${WC}'),1)`)).toBe('');
  });

  test('Details: meet 6:30 PM and ride 7 PM where the Saturday ride starts, the fare, no count, no distance or route', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`showSessInfo('${WC}')`);
    const box = page.locator('#bike-info-modal .ev-info');
    await expect(box).toContainText('Wednesday Community Ride');
    const text = box.locator('.ev-info-text');
    await expect(text).toContainText('6:30 PM');
    await expect(text).toContainText('7 PM');
    await expect(text).toContainText('where the Saturday Social Ride starts');
    await expect(text).toContainText('own bike and ride free');
    await expect(text).toContainText('A helmet comes with every bike');
    const facts = box.locator('.ev-info-facts');
    await expect(facts).toContainText('Community members');
    await expect(facts).toContainText('57.5');
    await expect(facts).toContainText('Meeting point');
    await expect(facts.locator('a', { hasText: 'Map' })).toHaveAttribute('href', SAT_MAP);
    await expect(facts).toContainText('Available');
    await expect(facts).not.toContainText(/\d+ (places|spots) left|Beginner|Intermediate|\bkm\b|Breakfast/i);
  });

  test('booking: no ride group step, the standard fare per type, an own bike free, two at most', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`selectEvent('community')`);
    await page.locator('#tab-register .sess-card.ev-wed').click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(WC);
    await page.evaluate(`S.regStep=2;renderRegister();setBikeType(0,'Road')`);
    await expect(page.locator('#tab-register .rg-grid')).toHaveCount(0); // no Beginner / Intermediate
    await expect(page.locator('.qty-stepper')).toBeVisible(); // a party, as a Petromin night
    await expect(page.locator('#reg-foot-tot')).toContainText('75');
    await page.evaluate(`setBikeType(0,'Hybrid')`);
    await expect(page.locator('#reg-foot-tot')).toContainText('57.5');
    expect(await page.evaluate(`[priceForType('Own'),bikeTypeOpts(true,_noCarbon(_sessDisp('${WC}'))).includes('Road Carbon')]`)).toEqual([0, false]);
    // the booking itself: the type's fare, no approval
    const rows = await captureBookingRows(page);
    await page.evaluate(
      `S.selSession='${WC}'; S.regQty=2; S.regBikeHeights=[175,168]; S.regBikeTypes=['Road','Own'];
       S.regRiderNames=['Sara Haddad','Friend']; S.promoApplied=null; S.waiverOk=true; submitReg();`,
    );
    await expect.poll(() => rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ session_id: WC, type_preference: 'Road', price: 75 });
    expect(rows[1]).toMatchObject({ session_id: WC, type_preference: 'Own', price: 0 });
    expect(rows[0].approval ?? null).toBeNull();
  });

  test('My Bookings: the ticket says Gathering 6:30 PM, Start 7 PM, the meeting point and its map, the fare to pay', async ({ page }) => {
    const mine = { id: 'q1', session_id: WC, session_day: 'Wednesday', session_date: '2099-11-25', queue_num: 4, name: 'Sara Haddad',
      phone: '+966500000001', type_preference: 'Hybrid', size: 'M', height: 170, status: 'waiting', paid: false, price: 57.5,
      registered_at: '2099-11-24T10:00:00Z', customer_id: 'c1' };
    await custBoot(page, { 'rpc:my_bookings': [mine], queue_entries: [mine] });
    await page.evaluate(`setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card').first();
    await expect(tk).toHaveClass(/\bth-saturday\b/);
    await expect(tk).toContainText('Gathering 6:30 PM');
    await expect(tk).toContainText('Start 7 PM');
    await expect(tk).toContainText('57.5');
    await expect(tk).not.toContainText(/Beginner|Intermediate|\bkm\b|breakfast|Jeddah Corniche Circuit/i);
    await expect(tk.locator('.tk-route')).toHaveCount(0); // no route, never the circuit's
    const dir = tk.locator('a.cu-tk-dir');
    await expect(dir).toHaveAttribute('href', SAT_MAP);
    await expect(dir).toContainText('Meeting point');
  });
});

test.describe('@staff:sessions Wednesday Community Ride', () => {
  test('the new session form offers it: members only, paid, no place limit, meet 6:30, start 7, the Saturday map, its own id', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [sat], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await page.locator('#tab-sessions .ev-pick.ev-wed').click();
    await expect(page.locator('#tab-sessions .ev-pick.ev-wed')).toHaveText('Wednesday Community Ride');
    await expect(page.locator('#tab-sessions .ss-hint', { hasText: 'Wednesday evening ride' })).toContainText('first come first served');
    await expect(page.locator('#ns-spots')).toHaveValue('500');
    await expect(page.locator('#ns-map')).toHaveValue(SAT_MAP);
    await expect(page.locator('#ns-title')).toHaveValue('Wednesday Community Ride');
    await expect(page.locator('#ns-price')).toHaveCount(0); // the fare is the bike type's
    await expect(page.locator('#newSessKm-all')).toHaveCount(0); // no distance
    await expect(page.locator('#ns-route')).toHaveCount(0); // no route
    expect(await page.evaluate(`[S.newSessStartTime,S.newSessEndTime]`)).toEqual(['18:30', '19:00']);
    expect(await page.evaluate(`[_nsComm(),_nsSeats(),_nsTwoTimes(),_nsKind(),_kindHasBf('wed'),_sessIdSuffix('wed')]`)).toEqual([true, true, true, 'wed', false, '-wc']);
    // Save: the row a Wednesday is made with
    const posts: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/sessions') && r.method() === 'POST') { try { posts.push(r.postDataJSON()); } catch { /* */ } } });
    await page.locator('#ns-date').fill('2099-12-02');
    await page.evaluate(`addSession()`);
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ id: '2099-12-02-wc', capacity: 500, spots: 500, event_kind: 'community', ride_kind: 'wed',
      open_to_all: false, paid_ride: true, needs_approval: false, hide_queue: true, title: null, meet_url: SAT_MAP,
      bike_slots: '{"_time":"18:30 - 19:00"}' });
    expect(posts[0].price ?? null).toBeNull();
  });

  test('its short name, mark and colours in staff lists, its editor and its announcements', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [wed, sat], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const s = `allSessions().find(x=>x.id==='${WC}')`;
    expect(await page.evaluate(`[_sessShort(${s}),_sfTheme(${s}),_evClass(${s}),KIND_IC.wed,SESS_MK_IC.wed,_editSeats(${s}),_noGroupAdd(${s}),_noWalkin(${s}),_noAddRider(${s}),_stockEvName('Wednesday Community Ride')]`))
      .toEqual(['Wednesday', 'comm', 'ev-wed', 'bike', 'bike', true, false, false, false, true]);
    expect(await page.evaluate(`[ANN_TYPES.some(x=>x[0]==='wed'),ANN_HAS.includes('wk_wed'),ANN_HAS.includes('ann_wed')]`)).toEqual([true, true, true]);
    const ann = (await page.evaluate(`_annOne(${s},'en').txt`)) as string;
    expect(ann).toContain('Wednesday Community Ride with MicroMobility');
    expect(ann).toContain('Meet up: *6:30 PM*');
    expect(ann).toContain('Ride starts: *7:00 PM*');
    expect(ann.indexOf('Booking:')).toBeLessThan(ann.indexOf(SAT_MAP)); // the booking link first
    expect(ann).toMatch(/Community Members Only/);
    expect(ann).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u); // no emoji
    const ar = (await page.evaluate(`_annOne(${s},'ar').txt`)) as string;
    expect(ar).toContain('جولة الأربعاء المجتمعية');
  });
});

test.describe('@build Wednesday Community Ride outside the page', () => {
  test('the passes, the calendar feed and the migration know the kind', async () => {
    expect(readFileSync('functions/api/ics.js', 'utf8')).toContain("const FEED_GATHERS = new Set(['saturday', 'snd96', 'runher', 'vlap', 'farm', 'wed']);");
    expect(readFileSync('functions/api/google-wallet.js', 'utf8')).toContain('wed: "Wednesday Community Ride"');
    const pass = readFileSync('scripts/wallet/wallet-pass.src.js', 'utf8');
    expect(pass).toContain('wed:      { ...EXP, venue: "Wednesday Community Ride" }');
    expect(pass).toContain('paint: false, wed: true };');
    expect(readFileSync('functions/api/wallet-pass.js', 'utf8')).toContain('"Wednesday Community Ride"');
    const m = readFileSync('supabase/migrations/20261125170000_wednesday_community_ride.sql', 'utf8');
    expect(m).toContain("'yoga','farm','ktri','paint','wed') then s.ride_kind");
    expect(m).toContain("when 'wed' then 'Wednesday Community Ride'");
    expect(m).toContain("v_start := case when v_kind in ('saturday', 'snd96', 'runher', 'vlap', 'farm', 'wed') then v_to else v_from end;");
    expect(m).toContain("values ('20261125170000', 'wednesday_community_ride')");
    expect((m.match(/security definer/g) || []).length).toBe(4);
    expect(m.replace(/--.*$/gm, "")).not.toMatch(/\b(drop (table|function)|delete from)\b/i);
    const rows = readFileSync('supabase/checks/wednesday-community-ride-sessions.sql', 'utf8');
    expect(rows).toContain("generate_series(date '2026-11-25', date '2027-02-24', interval '7 days')");
    expect(rows).toContain('{"_time":"18:30 - 19:00"}');
  });
});
