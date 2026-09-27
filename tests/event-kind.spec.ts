import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// A ticketed event as a ride kind (2026-09-28): seats, its own price, a rule about who may book, no
// bikes and no queue numbers, on the same sessions, bookings, waitlist and passes as a ride.
const d = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const ev = { id: d(4) + '-ev', day: 'Friday', session_date: d(4), capacity: 30, spots: 30, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'event', paid_ride: true, price: 40, open_to_all: true, needs_approval: false, hide_queue: true, title: 'Bike maintenance class', description: 'Two hours on brakes and gears.', bike_slots: '{"_time":"19:00 - 21:00"}' };
const jcc = { id: d(2), day: 'Wednesday', session_date: d(2), capacity: 12, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' };

test('the kind is read from the row: seats, no bike, no approval, its own name, price and event', async ({ page }) => {
  await stubSupabase(page, { sessions: [ev, jcc], queue_entries: [], bikes: [] });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  const r = await page.evaluate(`(()=>{const s=allSessions().find(x=>x.ride_kind==='event'),j=allSessions().find(x=>!x.ride_kind);
    return {kind:_rideKind(s),comm:_isCommunity(s),bike:_needsBike(s),waiver:_needsWaiver(s),appr:_isApprovalRide(s),name:_evName(s),ev:_evOf(s),match:_evMatch(s,'event'),inComm:_evMatch(s,'community'),inJcc:_evMatch(s,'jcc'),seat:_evSeatPrice(s),jccSeat:_evSeatPrice(j),free:_isFreeRide(s),live:_eventsLive(),cls:_evClass(s)};})()`);
  expect(r).toEqual({ kind: 'event', comm: true, bike: false, waiver: false, appr: false, name: 'Bike maintenance class', ev: 'event', match: true, inComm: false, inJcc: false, seat: 40, jccSeat: null, free: false, live: true, cls: 'ev-event' });
});

test('a rider sees the Events card while one is on the books, and the review prices the seat, not a bike', async ({ page }) => {
  await stubSupabase(page, { sessions: [ev, jcc], queue_entries: [], bikes: [] });
  await loginCustomer(page, { height: 175, type_preference: 'Hybrid' });
  await page.goto('/');
  await waitForSb(page);
  await expect(page.locator('.landing-event-card.ev-event')).toContainText('Events');
  await page.evaluate(`S.selEvent='event';S.selSession=${JSON.stringify(ev.id)};S.regStep=3;setCustTab('register')`);
  await expect(page.locator('#tab-register')).toContainText('SAR 40');
  // no event, no card
  await page.evaluate(`S.sessions=S.sessions.filter(s=>s.ride_kind!=='event');goLanding&&goLanding()`).catch(() => {});
});

test.describe('staff', () => {
  async function boot(page: Page) {
    await stubSupabase(page, { sessions: [jcc], queue_entries: [], bikes: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
  }
  test('the form offers Event with its description, price and who-may-book, and writes the kind, the gate and the extras', async ({ page }) => {
    await boot(page);
    const posts: Record<string, unknown>[] = [], patches: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/sessions')) { if (r.method() === 'POST') { try { posts.push(r.postDataJSON()); } catch { /* */ } } if (r.method() === 'PATCH') { try { patches.push(r.postDataJSON()); } catch { /* */ } } } });
    await page.locator('#sess-host .ev-pick.ev-event').click();
    await expect(page.locator('#ns-desc')).toBeVisible();
    await expect(page.locator('#ns-price')).toBeVisible();
    await expect(page.locator('#ns-title')).toHaveValue('Event');
    await page.locator('#ns-title').fill('Repair night');
    await page.locator('#ns-desc').fill('Fix a flat in five minutes.');
    await page.locator('#ns-price').fill('35');
    await page.locator('#ns-spots').fill('25');
    await page.locator('#sess-host button', { hasText: 'Community members' }).click();
    await page.locator('#ns-date').fill(d(9));
    await page.locator('#ns-start').fill('19:00');
    await page.locator('#ns-end').fill('21:00');
    await page.evaluate(`addSession()`);
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ id: d(9) + '-ev', capacity: 25, status: 'closed' });
    await expect.poll(() => patches.length).toBeGreaterThanOrEqual(3);
    const gate = patches.find((p) => 'needs_approval' in p) as Record<string, unknown>;
    expect(gate).toMatchObject({ event_kind: 'community', needs_approval: false, hide_queue: true, spots: 25, title: 'Repair night' });
    const kind = patches.find((p) => 'ride_kind' in p) as Record<string, unknown>;
    expect(kind).toEqual({ ride_kind: 'event', paid_ride: true, open_to_all: false });
    const extra = patches.find((p) => 'price' in p) as Record<string, unknown>;
    expect(extra).toMatchObject({ description: 'Fix a flat in five minutes.', price: 35 });
  });
});
