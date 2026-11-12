import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// Yoga (the user, 2026-11-12): Hatha Yoga for Cyclists with Jassim Alsaady, a date inside MicroMobility Experiences for
// community members. Free, one place each, first come first served, a start and an end, no bike anywhere. Its own look,
// "Sunset Hatha": a sun setting on the horizon with a crescent moon (assets/yoga-mark.svg), sand, clay and sage.

const YG = '2099-11-21-yg';
const yoga = {
  id: YG, session_date: '2099-11-21', day: 'Saturday', status: 'open', capacity: 15, created_at: 1,
  event_kind: 'community', ride_kind: 'yoga', needs_approval: false, hide_queue: true, spots: 15, open_to_all: false,
  paid_ride: false, location: 'SILKDEER', meet_url: 'https://maps.app.goo.gl/TfCSEPEPxA4C5f7d7', bike_slots: '{"_time":"16:00 - 17:30"}',
};
const sat = {
  id: '2099-11-21-2', session_date: '2099-11-21', day: 'Saturday', status: 'open', capacity: 120, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 120, open_to_all: false,
  bike_slots: '{"_time":"05:45 - 06:15"}',
};

async function custBoot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [yoga, sat], queue_entries: [], 'rpc:community_member': true, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}

test.describe('@customer:yoga Hatha Yoga for Cyclists', () => {
  test('a bike-free kind of its own, told apart by its id', async ({ page }) => {
    await custBoot(page);
    const k = await page.evaluate(`(()=>{const s=allSessions().find(x=>x.id==='${YG}');
      return {kind:_rideKind(s),bike:_needsBike(s),approval:_isApprovalRide(s),free:_isFreeRide(s),waiver:_waiverKind(s),nc:_ncEntry({sessionId:'2099-12-05-yg'}),mins:_ygMins(s)};})()`);
    expect(k).toEqual({ kind: 'yoga', bike: false, approval: false, free: true, waiver: 'activity', nc: true, mins: 90 });
  });

  test('its date card sits inside Experiences in its own colours', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`selectEvent('community')`);
    const card = page.locator('#tab-register .sess-card.yg-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.yg-card-title')).toHaveText('Hatha Yoga for Cyclists');
    await expect(card.locator('.yg-card-meta')).toContainText('4 PM - 5:30 PM');
    await expect(card.locator('.yg-card-meta')).toContainText('90 min');
    await expect(card.locator('.yg-card-meta')).toContainText('SILKDEER');
    await expect(card.locator('.yg-card-with')).toHaveText('with Jassim Alsaady');
    await expect(card.locator('img.yg-card-mark')).toHaveAttribute('src', '/assets/yoga-mark.svg');
    await expect(card.locator('svg.yg-scene')).toHaveCount(1);
    // nothing about riding on it
    await expect(card).not.toContainText(/ride|bike/i);
    // the Saturday ride beside it keeps its own card
    await expect(page.locator('#tab-register .sess-card:not(.yg-card)')).toHaveCount(1);
    // the card stays inside the list at a phone's width
    await page.setViewportSize({ width: 320, height: 700 });
    const [c, w] = await Promise.all([card.boundingBox(), page.locator('#tab-register').boundingBox()]);
    expect(c && w && c.x >= w.x - 0.5 && c.x + c.width <= w.x + w.width + 0.5).toBeTruthy();
  });

  test('Details says who leads it, how long, the level and what to bring', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`showSessInfo('${YG}')`);
    const box = page.locator('#bike-info-modal .ev-info');
    await expect(box).toContainText('Hatha Yoga for Cyclists');
    await expect(box.locator('.ev-info-text')).toContainText('4 PM to 5:30 PM');
    await expect(box.locator('.ev-info-facts')).toContainText('Jassim Alsaady');
    await expect(box.locator('.ev-info-facts')).toContainText('90 min');
    await expect(box.locator('.ev-info-facts')).toContainText('All levels');
    await expect(box.locator('.ev-info-facts')).toContainText('Your yoga mat');
    await expect(box.locator('.ev-info-facts')).toContainText('SILKDEER');
    // its own map, never the circuit's directions
    await expect(box.locator('.ev-info-facts a')).toHaveAttribute('href', 'https://maps.app.goo.gl/TfCSEPEPxA4C5f7d7');
  });

  test('booking: straight to the review in the yoga skin, one place, no bike, its own ticket', async ({ page }) => {
    await custBoot(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(`selectEvent('community')`);
    await page.locator('#tab-register .sess-card.yg-card').click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(YG);
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(3);
    await expect(page.locator('body')).toHaveClass(/\byoga-skin\b/);
    await expect(page.locator('#tab-register .yg-flow-head')).toContainText('Hatha Yoga for Cyclists');
    await expect(page.locator('#tab-register .yg-flow-head')).toContainText('with Jassim Alsaady');
    await expect(page.locator('#tab-register')).not.toContainText('Bike Type');
    await page.locator('#reg-waiver-cb').check();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: YG, type_preference: 'None', price: 0 });
    const tk = page.locator('#tab-register .ticket-card').first();
    await expect(tk).toHaveClass(/\bth-yoga\b/);
    await expect(tk.locator('.tk-logo-yoga')).toHaveAttribute('src', '/assets/yoga-mark.svg');
    // leaving Reserve takes the skin with it
    await page.evaluate(`setCustTab('myrides')`);
    await expect(page.locator('body')).not.toHaveClass(/\byoga-skin\b/);
  });

  test('My Bookings: the ticket in its colours says who leads it, the level and what to bring', async ({ page }) => {
    const mine = { id: 'q1', session_id: YG, session_day: 'Saturday', session_date: '2099-11-21', queue_num: 4, name: 'Sara Haddad',
      phone: '+966500000001', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0,
      registered_at: '2099-11-12T10:00:00Z', customer_id: 'c1' };
    await custBoot(page, { 'rpc:my_bookings': [mine], queue_entries: [mine] });
    await page.evaluate(`setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card').first();
    await expect(tk).toHaveClass(/\bth-yoga\b/);
    await expect(tk.locator('.yg-know')).toContainText('Jassim Alsaady');
    await expect(tk.locator('.yg-know')).toContainText('All levels');
    await expect(tk.locator('.yg-know')).toContainText('Your yoga mat');
    await expect(tk).not.toContainText(/\bbike\b/i);
    await expect(tk.locator('a.cu-tk-dir')).toHaveAttribute('href', 'https://maps.app.goo.gl/TfCSEPEPxA4C5f7d7');
  });
});

test.describe('@staff:sessions Yoga', () => {
  test('the new session form offers Yoga: members only, first come first served, 15 places, its own id', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [yoga, sat], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await page.locator('#tab-sessions .ev-pick.ev-yoga').click();
    await expect(page.locator('#tab-sessions .ev-pick.ev-yoga')).toHaveText('Hatha Yoga for Cyclists');
    await expect(page.locator('#tab-sessions .ss-hint', { hasText: 'Yoga' })).toContainText('first come first served');
    await expect(page.locator('#ns-spots')).toHaveValue('15');
    await expect(page.locator('#ns-title')).toHaveValue('Hatha Yoga for Cyclists');
    expect(await page.evaluate(`[_nsComm(),_nsSeats(),_nsTwoTimes(),_nsKind(),_sessIdSuffix('yoga')]`)).toEqual([true, true, true, 'yoga', '-yg']);
    // its mark and short name in staff lists
    expect(await page.evaluate(`_sessShort(allSessions().find(x=>x.id==='${YG}'))`)).toBe('Yoga');
    expect(await page.evaluate(`_sfTheme(allSessions().find(x=>x.id==='${YG}'))`)).toBe('yoga');
  });
});
