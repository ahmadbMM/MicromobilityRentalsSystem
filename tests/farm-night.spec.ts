import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// The Farm House Night (the user, 2026-11-13): The Farmhouse Night at Farmhouse in Dhahban (first named
// Nawar Farm House Night), a date inside MicroMobility Experiences for community members and their families. Staff
// approve every place as on the Saturday ride; a member books themselves and up to three more on one booking, each by
// name. Arrival from 4:30 PM, dinner at 8:30 PM. Its own look, "Harvest Supper", from the venue's Instagram: rust,
// peach, a fan of rounded feathers and the account's own picture as its logo.

const FH = '2099-11-19-fh';
const farm = {
  id: FH, session_date: '2099-11-19', day: 'Thursday', status: 'open', capacity: 60, created_at: 1,
  event_kind: 'community', ride_kind: 'farm', needs_approval: true, hide_queue: true, spots: 60, open_to_all: false,
  paid_ride: false, title: 'The Farmhouse Night', title_ar: 'ليلة فارم هاوس', location: 'Farmhouse, Dhahban',
  meet_name: 'Farmhouse, Dhahban', meet_url: 'https://maps.app.goo.gl/BYteRL5JCueWZUEs6', bike_slots: '{"_time":"16:30 - 20:30","_ig":"thefarmhouse.jed"}',
};
const sat = {
  id: '2099-11-21-2', session_date: '2099-11-21', day: 'Saturday', status: 'open', capacity: 120, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 120, open_to_all: false,
  bike_slots: '{"_time":"05:45 - 06:15"}',
};

async function custBoot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [farm, sat], queue_entries: [], 'rpc:community_member': true, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}

test.describe('@customer:farm Farm House Night', () => {
  test('a bike-free kind of its own that staff approve and that takes a family', async ({ page }) => {
    await custBoot(page);
    const k = await page.evaluate(`(()=>{const s=allSessions().find(x=>x.id==='${FH}');
      return {kind:_rideKind(s),bike:_needsBike(s),approval:_isApprovalRide(s),free:_isFreeRide(s),party:_partyRide(s),max:_maxRiders(s),
        steps:_regSteps(s),gathers:_gathersTime(s),waiver:_waiverKind(s),nc:_ncEntry({sessionId:'2099-12-03-fh'}),
        time:sessionTime(s),featured:_featured(s)};})()`);
    expect(k).toEqual({ kind: 'farm', bike: false, approval: true, free: true, party: true, max: 4, steps: [1, 2, 3], gathers: true,
      waiver: 'farm', nc: true, time: 'Arrival 4:30 PM · Dinner 8:30 PM', featured: true });
  });

  test('the Experiences card shows its mark to members alone', async ({ page }) => {
    await custBoot(page);
    await expect.poll(() => page.evaluate(`_commMarks()`)).toContain('ev-farm');
  });

  test('a rider who is not a member sees no farm mark', async ({ page }) => {
    await custBoot(page, { 'rpc:community_member': false });
    await page.evaluate(`_infoMember()`);
    await expect.poll(() => page.evaluate(`!!(S._infoMem&&!S._infoMem.busy)`)).toBe(true);
    expect(await page.evaluate(`_commMarks()`)).toContain('ev-saturday');
    expect(await page.evaluate(`_commMarks()`)).not.toContain('ev-farm');
  });

  test('its date card sits inside Experiences in the venue\'s colours', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`selectEvent('community')`);
    const card = page.locator('#tab-register .sess-card.fh-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.fh-card-title')).toHaveText('The Farmhouse Night');
    await expect(card.locator('.fh-card-meta')).toContainText('Arrival 4:30 PM · Dinner 8:30 PM');
    await expect(card.locator('.fh-card-meta')).toContainText('Farmhouse, Dhahban');
    await expect(card.locator('.fh-card-with')).toHaveText('Members and their families');
    await expect(card.locator('img.fh-card-mark')).toHaveAttribute('src', '/assets/farm-logo.jpg');
    await expect(card.locator('svg.fh-scene')).toHaveCount(1);
    await expect(card).not.toContainText(/ride|bike/i);
    // never a count of places: staff choose who comes
    await expect(card).not.toContainText(/left|places/i);
    // the Saturday ride beside it keeps its own card
    await expect(page.locator('#tab-register .sess-card:not(.fh-card)')).toHaveCount(1);
    // the card stays inside the list at a phone's width
    await page.setViewportSize({ width: 320, height: 700 });
    const [c, w] = await Promise.all([card.boundingBox(), page.locator('#tab-register').boundingBox()]);
    expect(c && w && c.x >= w.x - 0.5 && c.x + c.width <= w.x + w.width + 0.5).toBeTruthy();
  });

  test('the Arabic page names it in Arabic, arrival and dinner', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`setLang('ar')`);
    await page.evaluate(`selectEvent('community')`);
    const card = page.locator('#tab-register .sess-card.fh-card');
    await expect(card.locator('.fh-card-title')).toHaveText('ليلة فارم هاوس');
    await expect(card.locator('.fh-card-meta')).toContainText('الوصول');
    await expect(card.locator('.fh-card-meta')).toContainText('العشاء');
  });

  test('Details says who comes, when to arrive and when dinner is, and opens the farm\'s map', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`showSessInfo('${FH}')`);
    const box = page.locator('#bike-info-modal .ev-info');
    await expect(box).toContainText('The Farmhouse Night');
    await expect(box.locator('.ev-info-text')).toContainText('Arrive from 4:30 PM');
    await expect(box.locator('.ev-info-text')).toContainText('dinner at 8:30 PM');
    await expect(box.locator('.ev-info-facts')).toContainText('Community members and their families');
    await expect(box.locator('.ev-info-facts')).toContainText('Farmhouse, Dhahban');
    await expect(box.locator('.ev-info-facts a', { hasText: 'Map' })).toHaveAttribute('href', 'https://maps.app.goo.gl/BYteRL5JCueWZUEs6');
    // the farm's Instagram, opening its account
    const ig = box.locator('.ev-info-facts a.ev-info-ig');
    await expect(ig).toHaveText('@thefarmhouse.jed');
    await expect(ig).toHaveAttribute('href', 'https://www.instagram.com/thefarmhouse.jed');
    await expect(ig).toHaveAttribute('target', '_blank');
  });

  test('booking: the member and two family members by name, sent for approval in the farm skin', async ({ page }) => {
    await custBoot(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(`selectEvent('community')`);
    await page.locator('#tab-register .sess-card.fh-card').click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(FH);
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(2);
    await expect(page.locator('body')).toHaveClass(/\bfarm-skin\b/);
    await expect(page.locator('#tab-register .fh-flow-head')).toContainText('The Farmhouse Night');
    // the venue's Instagram on the plate before the member books (2026-11-14)
    const ig = page.locator('#tab-register .fh-flow-head a.fh-flow-ig');
    await expect(ig).toHaveAttribute('href', 'https://www.instagram.com/thefarmhouse.jed');
    await expect(ig).toHaveAttribute('target', '_blank');
    await expect(ig).toContainText('@thefarmhouse.jed');
    await expect(page.locator('#tab-register .reg-row-label')).toHaveText('People coming');
    await page.locator('#reg-qty-inc').click();
    await page.locator('#reg-qty-inc').click();
    await expect(page.locator('#tab-register .qty-val')).toHaveText('3');
    await expect(page.locator('#tab-register .cu-rider-head').nth(0)).toContainText('You');
    await expect(page.locator('#tab-register .cu-rider-head').nth(1)).toContainText('Family member');
    await page.locator('#reg-rider-name-1').fill('Lina Haddad');
    await page.locator('#reg-rider-name-2').fill('Omar Haddad');
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(3);
    await expect(ig).toBeVisible();
    await expect(page.locator('#tab-register')).not.toContainText('Bike Type');
    // the farm night's own waiver: the farm, its animals, the food, and the family on the booking
    await expect(page.locator('#reg-waiver')).toContainText('Farm House Night waiver');
    await expect(page.locator('#reg-waiver-lbl')).toHaveText('I have read the waiver and agree for myself and on behalf of everyone on this booking');
    await page.evaluate('showWaiverText()');
    const wv = page.locator('#bike-info-modal');
    await expect(wv).toContainText('animals that can bite, kick or scratch');
    await expect(wv).toContainText('allergy or dietary need');
    await expect(wv).toContainText('supervise them at all times');
    await page.evaluate('closeWaiverText()');
    await page.locator('#reg-waiver-cb').check();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(3);
    expect(rows.map((r) => r.name)).toEqual(['Sara Haddad', 'Lina Haddad', 'Omar Haddad']);
    for (const r of rows) expect(r).toMatchObject({ session_id: FH, type_preference: 'None', price: 0, waiver_version: 'farm-2026-11-v1' });
    // one booking: the family shares its group
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
    const tk = page.locator('#tab-register .ticket-card').first();
    await expect(tk).toHaveClass(/\bth-farm\b/);
    await expect(tk).toContainText('Waiting for confirmation');
    // booked: the ticket carries the Instagram, the plate above it no longer does
    await expect(page.locator('#tab-register .fh-flow-ig')).toHaveCount(0);
    await expect(tk.locator('a.tk-ig')).toHaveCount(1);
    // leaving Reserve takes the skin with it
    await page.evaluate(`setCustTab('myrides')`);
    await expect(page.locator('body')).not.toHaveClass(/\bfarm-skin\b/);
  });

  test('the stepper stops at four people a booking: the account holder and three with them', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`selectEvent('community')`);
    await page.locator('#tab-register .sess-card.fh-card').click();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(2);
    for (let i = 0; i < 6; i++) await page.locator('#reg-qty-inc').click();
    await expect(page.locator('#tab-register .qty-val')).toHaveText('4');
    // an event keeps Settings > Business event_seat_max (five); the farm night's four is its own
    expect(await page.evaluate(`[FARM_SEAT_MAX,_maxRiders({...allSessions().find(x=>x.id==='${FH}'),id:'2099-11-20-ev',ride_kind:'event',needs_approval:false})]`)).toEqual([4, 5]);
  });

  test('My Bookings: the family\'s ticket in its colours, with Edit to add or remove family members', async ({ page }) => {
    const base = { session_id: FH, session_day: 'Thursday', session_date: '2099-11-19', phone: '+966500000001', type_preference: 'None',
      size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-11-12T10:00:00Z', customer_id: 'c1', approval: 'pending', group_id: 'g1' };
    const mine = [{ ...base, id: 'q1', queue_num: 4, name: 'Sara Haddad' }, { ...base, id: 'q2', queue_num: 5, name: 'Lina Haddad' }];
    await custBoot(page, { 'rpc:my_bookings': mine, queue_entries: mine });
    await page.evaluate(`setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card').first();
    await expect(tk).toHaveClass(/\bth-farm\b/);
    await expect(tk).toContainText('Arrival 4:30 PM · Dinner 8:30 PM');
    await expect(tk).not.toContainText('Gathering');
    // the farm's Instagram on the ticket
    await expect(tk.locator('a.tk-ig')).toHaveAttribute('href', 'https://www.instagram.com/thefarmhouse.jed');
    // its countdown runs to arrival, then to dinner
    expect(await page.evaluate(`_cdAttr(allSessions().find(x=>x.id==='${FH}'),'2099-11-19')`)).toMatch(/:fhCdArrive\|\d+:fhCdDinner$/);
    await expect(tk).not.toContainText(/\bbike\b/i);
    await expect(page.locator('#tab-myrides .cu-act88', { hasText: 'Edit' })).toHaveCount(1);
  });
});

test.describe('@staff:sessions Farm House Night', () => {
  test('the new session form offers it: approval, members and their families, arrival and dinner, its own id', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [farm, sat], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await page.locator('#tab-sessions .ev-pick.ev-farm').click();
    await expect(page.locator('#tab-sessions .ev-pick.ev-farm')).toHaveText('Farm House Night');
    await expect(page.locator('#tab-sessions .ss-hint', { hasText: 'families' })).toContainText('approve');
    await expect(page.locator('#ns-spots')).toHaveValue('60');
    await expect(page.locator('#ns-title')).toHaveValue('Farm House Night');
    await expect(page.locator('label[for="ns-start"]')).toHaveText('Arrival');
    await expect(page.locator('label[for="ns-end"]')).toHaveText('Dinner');
    expect(await page.evaluate(`[_nsComm(),_nsSeats(),_nsTwoTimes(),_nsKind(),_sessIdSuffix('farm')]`)).toEqual([true, true, true, 'farm', '-fh']);
    // staff's lists name it by its title, its kind's short name when it has none; no walk-ins on it
    expect(await page.evaluate(`_sessShort(allSessions().find(x=>x.id==='${FH}'))`)).toBe('The Farmhouse Night');
    expect(await page.evaluate(`_sessShort({...allSessions().find(x=>x.id==='${FH}'),title:null})`)).toBe('Farm night');
    // staff add people by hand: walk-ins, Add rider, Add group (the user, 2026-11-13)
    expect(await page.evaluate(`[_noWalkin,_noAddRider,_noGroupAdd].map(f=>f(allSessions().find(x=>x.id==='${FH}')))`)).toEqual([false, false, false]);
    expect(await page.evaluate(`_sfTheme(allSessions().find(x=>x.id==='${FH}'))`)).toBe('farm');
  });

  test('Bookings: a family waiting on approval is approved together from its menu', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const base = { session_id: FH, session_day: 'Thursday', session_date: '2099-11-19', phone: '+966500000001', type_preference: 'None',
      size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-11-12T10:00:00Z', customer_id: 'c1', approval: 'pending', group_id: 'g1' };
    const fam = [{ ...base, id: 'q1', queue_num: 4, name: 'Sara Haddad' }, { ...base, id: 'q2', queue_num: 5, name: 'Lina Haddad' },
      { ...base, id: 'q3', queue_num: 6, name: 'Omar Haddad' }];
    await stubSupabase(page, { sessions: [farm, sat], bikes: [], queue_entries: fam });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`_apprPartyIds(getQueue().filter(e=>e.sessionId==='${FH}'))`)).toEqual(['q1', 'q2', 'q3']);
    const items = await page.evaluate(`_partyMenuExtra(getQueue().filter(e=>e.sessionId==='${FH}'),'',0).filter(Boolean).map(x=>x.label)`) as string[];
    expect(items[0]).toBe('✓ Approve (3)');
    // one family member already approved: the press takes the other two
    const two = await page.evaluate(`(()=>{const g=getQueue().filter(e=>e.sessionId==='${FH}');g[0].approval='approved';return _apprPartyIds(g);})()`);
    expect(two).toEqual(['q2', 'q3']);
    // the party counts people, not bikes
    await page.evaluate(`setStaffTab('queue');S.sfSession='${FH}';renderStaffQueue()`);
    await expect(page.locator('#tab-queue')).toContainText('3 participants');
    await expect(page.locator('#tab-queue')).not.toContainText('3 bikes');
  });

  test('the booking editor adds family members to a farm booking, waiting on the booking\'s own decision', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const one = { session_id: FH, session_day: 'Thursday', session_date: '2099-11-19', phone: '+966500000001', type_preference: 'None',
      size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-11-12T10:00:00Z', customer_id: 'c1', approval: 'pending',
      id: 'q1', queue_num: 4, name: 'Sara Haddad' };
    const posts: Record<string, unknown>[] = [];
    await stubSupabase(page, { sessions: [farm, sat], bikes: [], queue_entries: [one] });
    await page.route('**/rest/v1/queue_entries*', async (route) => {
      if (route.request().method() === 'POST') { const b = route.request().postDataJSON(); posts.push(...(Array.isArray(b) ? b : [b])); }
      await route.fallback();
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.sfSession='${FH}';renderStaffQueue();showBookingEditModal('q1')`);
    const modal = page.locator('#booking-edit-modal');
    await expect(modal.locator('.dk-w100-mt8')).toBeVisible(); // + Add rider
    await modal.locator('.dk-w100-mt8').click();
    await modal.locator('#be-nr-name-0').fill('Lina Haddad');
    await modal.locator('.modal-footer .btn-primary').click();
    await expect.poll(() => posts.length).toBeGreaterThan(0);
    expect(posts[0]).toMatchObject({ name: 'Lina Haddad', session_id: FH, approval: 'pending', customer_id: 'c1' });
  });

  test('the session editor keeps and changes the venue\'s Instagram', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [farm, sat], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${FH}')`);
    await expect(page.locator('#es-ig')).toHaveValue('thefarmhouse.jed');
    expect(await page.evaluate(`[_igClean('@thefarmhouse.jed'),_igClean('https://www.instagram.com/thefarmhouse.jed/?hl=en'),IG_HANDLE.test('bad handle')]`)).toEqual(['thefarmhouse.jed', 'thefarmhouse.jed', false]);
  });
});

// The Farmhouse Night badge (the user, 2026-11-14: "create a badge for attending the farmhouse night"): a barn under a
// crescent moon on the night's own medal, peach into ember into maroon, for the member checked in on a farm night (on
// site or checked out). Shown only to those who hold it.
test.describe('@customer:farm The Farmhouse Night badge', () => {
  const row = (x: Record<string, unknown>) => ({ id: 'q1', session_id: FH, session_day: 'Thursday', session_date: '2099-11-19', queue_num: 3, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'active', paid: false, price: 0, registered_at: '2099-11-14T10:00:00Z', customer_id: 'c1', ...x });
  async function rider(page: Page, x: Record<string, unknown>, sessions: unknown[] = [farm, sat]) {
    const r = row(x);
    await stubSupabase(page, {
      sessions, queue_entries: [r], 'rpc:my_bookings': [r], 'rpc:community_member': true,
      'rpc:customer_profile': [{ id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', birth_date: '1995-05-05', height: 165, type_preference: 'Any', nationality: 'Saudi Arabia' }],
      'rpc:customer_update_profile': true,
      'rpc:customer_emergency': [{ emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' }],
    });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
  }

  test('checked in on the night: the barn on the farm medal, once with a pop-up', async ({ page }) => {
    await rider(page, {});
    const pop = page.locator('#badge-pop');
    await expect(pop).toContainText('Farmhouse Night');
    await expect(pop).toContainText('Come to one of our farmhouse nights.');
    await expect(pop.locator('svg.bdg-m.bdg-sp')).toHaveCount(1);
    await expect(pop.locator('.sp-farm')).not.toHaveCount(0);
    await pop.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#tab-account .mr-badges .mr-badge.sp-farm', { hasText: 'Farmhouse Night' })).toHaveCount(1);
  });

  for (const [what, x, ses] of [
    ['checked out', { status: 'done' }, undefined],
    ['a night over that the device no longer lists (read from the id)', { status: 'done', session_id: '2099-10-15-fh', session_date: '2099-10-15' }, [sat]],
  ] as const) {
    test(`${what} earns it too`, async ({ page }) => {
      await rider(page, x, ses ? [...ses] : undefined);
      await expect(page.locator('#badge-pop')).toContainText('Farmhouse Night');
    });
  }

  for (const [what, x] of [
    ['a family still waiting on approval', { status: 'waiting' }],
    ['a booking called off', { status: 'cancelled' }],
    ['a member who never came', { status: 'noshow' }],
    ['a Saturday ride ridden', { status: 'done', session_id: '2099-11-21-2', session_date: '2099-11-21', type_preference: 'Road', paid: true }],
  ] as const) {
    test(`${what} does not get it, not even to earn`, async ({ page }) => {
      await rider(page, x);
      await expect(page.locator('#mr-badges-host')).toHaveCount(1);
      await page.evaluate(`_mrBadgesMore()`);
      await expect(page.locator('#tab-account .mr-badge', { hasText: 'Farmhouse Night' })).toHaveCount(0);
    });
  }

  test('the Arabic page names it as the night is named', async ({ page }) => {
    await rider(page, { status: 'done' });
    await page.locator('#badge-pop').getByRole('button', { name: 'Close' }).click();
    await page.evaluate(`setLang('ar')`);
    await expect(page.locator('#tab-account .mr-badges .mr-badge.sp-farm')).toContainText('ليلة فارم هاوس'); // the Arabic pack arrives, then the page repaints
    expect(await page.evaluate(`[t('bdgFarmNightD'),_bdgName({system:true,slug:'farmhouse_night'})]`)).toEqual(['احضر ليلة فارم هاوس معنا.', 'ليلة فارم هاوس']);
  });

  test('every language has it, and the migration adds it for holders only', async () => {
    for (const code of ['es', 'fr', 'hi', 'ur', 'bn', 'ne', 'pt', 'tl']) {
      const pack = JSON.parse(readFileSync(`i18n/${code}.json`, 'utf8')) as Record<string, string>;
      for (const k of ['bdgFarmNight', 'bdgFarmNightD', 'bdgFarmNightA']) expect(pack[k], `${code} ${k}`).toBeTruthy();
    }
    const sql = readFileSync('supabase/migrations/20261114200000_farmhouse_night_badge.sql', 'utf8');
    expect(sql).toMatch(/'bd_farmhouse_night', 'farmhouse_night', 'barn', 'orange'.*true, true, 93, true\)/);
    expect(sql).toContain("values ('20261114200000', 'farmhouse_night_badge')");
  });
});
