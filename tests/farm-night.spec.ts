import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// The Farm House Night (the user, 2026-11-13): Nawar Farm House Night at Little Farmhouse in Dhahban, a date inside
// MicroMobility Experiences for community members and their families. Staff approve every place as on the Saturday
// ride; a member books themselves and their family on one booking, each by name. Arrival from 4:30 PM, dinner at
// 8:30 PM. Its own look, "Harvest Supper", from the venue's Instagram: rust, peach and a fan of rounded feathers.

const FH = '2099-11-19-fh';
const farm = {
  id: FH, session_date: '2099-11-19', day: 'Thursday', status: 'open', capacity: 60, created_at: 1,
  event_kind: 'community', ride_kind: 'farm', needs_approval: true, hide_queue: true, spots: 60, open_to_all: false,
  paid_ride: false, title: 'Nawar Farm House Night', title_ar: 'ليلة مزرعة نوار', location: 'Little Farmhouse, Dhahban',
  meet_name: 'Little Farmhouse, Dhahban', meet_url: 'https://maps.app.goo.gl/BYteRL5JCueWZUEs6', bike_slots: '{"_time":"16:30 - 20:30"}',
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
    expect(k).toEqual({ kind: 'farm', bike: false, approval: true, free: true, party: true, max: 5, steps: [1, 2, 3], gathers: true,
      waiver: 'activity', nc: true, time: 'Arrival 4:30 PM · Dinner 8:30 PM', featured: true });
  });

  test('its date card sits inside Experiences in the venue\'s colours', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`selectEvent('community')`);
    const card = page.locator('#tab-register .sess-card.fh-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.fh-card-title')).toHaveText('Nawar Farm House Night');
    await expect(card.locator('.fh-card-meta')).toContainText('Arrival 4:30 PM · Dinner 8:30 PM');
    await expect(card.locator('.fh-card-meta')).toContainText('Little Farmhouse, Dhahban');
    await expect(card.locator('.fh-card-with')).toHaveText('Members and their families');
    await expect(card.locator('img.fh-card-mark')).toHaveAttribute('src', '/assets/farm-mark.svg');
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
    await expect(card.locator('.fh-card-title')).toHaveText('ليلة مزرعة نوار');
    await expect(card.locator('.fh-card-meta')).toContainText('الوصول');
    await expect(card.locator('.fh-card-meta')).toContainText('العشاء');
  });

  test('Details says who comes, when to arrive and when dinner is, and opens the farm\'s map', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`showSessInfo('${FH}')`);
    const box = page.locator('#bike-info-modal .ev-info');
    await expect(box).toContainText('Nawar Farm House Night');
    await expect(box.locator('.ev-info-text')).toContainText('Arrive from 4:30 PM');
    await expect(box.locator('.ev-info-text')).toContainText('dinner at 8:30 PM');
    await expect(box.locator('.ev-info-facts')).toContainText('Community members and their families');
    await expect(box.locator('.ev-info-facts')).toContainText('Little Farmhouse, Dhahban');
    await expect(box.locator('.ev-info-facts a')).toHaveAttribute('href', 'https://maps.app.goo.gl/BYteRL5JCueWZUEs6');
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
    await expect(page.locator('#tab-register .fh-flow-head')).toContainText('Nawar Farm House Night');
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
    await expect(page.locator('#tab-register')).not.toContainText('Bike Type');
    await page.locator('#reg-waiver-cb').check();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(3);
    expect(rows.map((r) => r.name)).toEqual(['Sara Haddad', 'Lina Haddad', 'Omar Haddad']);
    for (const r of rows) expect(r).toMatchObject({ session_id: FH, type_preference: 'None', price: 0 });
    // one booking: the family shares its group
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
    const tk = page.locator('#tab-register .ticket-card').first();
    await expect(tk).toHaveClass(/\bth-farm\b/);
    await expect(tk).toContainText('Waiting for confirmation');
    // leaving Reserve takes the skin with it
    await page.evaluate(`setCustTab('myrides')`);
    await expect(page.locator('body')).not.toHaveClass(/\bfarm-skin\b/);
  });

  test('the stepper stops at five people a booking', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`selectEvent('community')`);
    await page.locator('#tab-register .sess-card.fh-card').click();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(2);
    for (let i = 0; i < 6; i++) await page.locator('#reg-qty-inc').click();
    await expect(page.locator('#tab-register .qty-val')).toHaveText('5');
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
    expect(await page.evaluate(`_sessShort(allSessions().find(x=>x.id==='${FH}'))`)).toBe('Nawar Farm House Night');
    expect(await page.evaluate(`_sessShort({...allSessions().find(x=>x.id==='${FH}'),title:null})`)).toBe('Farm night');
    expect(await page.evaluate(`_noWalkin(allSessions().find(x=>x.id==='${FH}'))`)).toBe(true);
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
    const items = await page.evaluate(`_partyMenuExtra(getQueue().filter(e=>e.sessionId==='${FH}'),'',0).filter(Boolean).map(x=>x.label)`);
    expect(items[0]).toBe('✓ Approve (3)');
    // one family member already approved: the press takes the other two
    const two = await page.evaluate(`(()=>{const g=getQueue().filter(e=>e.sessionId==='${FH}');g[0].approval='approved';return _apprPartyIds(g);})()`);
    expect(two).toEqual(['q2', 'q3']);
    // the party counts people, not bikes
    await page.evaluate(`setStaffTab('queue');S.sfSession='${FH}';renderStaffQueue()`);
    await expect(page.locator('#tab-queue')).toContainText('3 participants');
    await expect(page.locator('#tab-queue')).not.toContainText('3 bikes');
  });
});
