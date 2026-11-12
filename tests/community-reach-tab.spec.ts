import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// The Community tab after launch (2026-11-13, reports/Community tab reach after launch.md): each open of the tab tells the read
// where it came from, once (R3); the next session's card gives its two times and where it meets with one map button (R9) and
// changes with the time to turn up, with staff's word on the ride as a chip (R10); the Saturday report is number tiles (R13);
// a club goal reached names the next Saturday's own target (R20). All Supabase traffic is stubbed; hub_feed's p_src and the
// new session and post fields are the contract of migration 20261113120000.

const sess = (id: string, date: string, o: Record<string, unknown> = {}) => ({ id, day: 'Saturday', session_date: date, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}', ...o });
const open = [sess('2099-01-03', '2099-01-03'), sess('2099-01-10', '2099-01-10'), sess('2099-01-17', '2099-01-17')];
const feed = (o: Record<string, unknown> = {}) => ({
  ok: true, today: '2026-11-13',
  me: { kind: 'first', levels: [1], target: 1, chosen: false, n: 0, ends_on: '2026-11-30', sats: 4 },
  club: { scope: 'saturday', target: 446, n: 312, mine: 2, from: '2026-11-01', ends_on: '2026-11-30', manual: false },
  goals: [], numbers: { last: '2026-11-07', last_riders: 96, last_rides: 96, month: 312, all: 2104, since: '2026-06-13' },
  post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null, ...o,
});
const booking = (id: string, sid: string, o: Record<string, unknown> = {}) => ({ id, session_id: sid, session_date: sid.slice(0, 10), session_day: 'Saturday', customer_id: 'c1', name: 'Lina Haddad', queue_num: 4, status: 'waiting', paid: false, price: 0, type_preference: 'Road', created_at: 1, ...o });
async function member(page: Page, fx: Fixtures = {}, at?: string) {
  if (at) await page.clock.setFixedTime(new Date(at));
  await stubSupabase(page, { sessions: open, customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed(), ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'male' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
}
const feedsSent = (page: Page) => {
  const out: (string | null)[] = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname.endsWith('/rpc/hub_feed')) { let b: Record<string, unknown> = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ } out.push(typeof b.p_src === 'string' ? b.p_src : null); } });
  return out;
};
const hero = (page: Page) => page.locator('#hub-body .hub-hero');

test.describe('@customer:members R3 where an open came from', () => {
  test('the first read of each open carries its source; a repaint, a refresh and Try again carry none', async ({ page }) => {
    const sent = feedsSent(page);
    await member(page);
    await expect.poll(() => sent).toEqual(['tab']);
    await page.evaluate(`_hubRender()`);
    await page.waitForTimeout(300);
    expect(sent).toEqual(['tab']); // a repaint of the same open reads nothing
    await page.evaluate(`_hubRetry()`);
    await expect.poll(() => sent).toEqual(['tab', null]);
    await page.evaluate(`S._hub.at=Date.now()-13e4;_hubRender()`); // the two-minute refresh
    await expect.poll(() => sent).toEqual(['tab', null, null]);
    await page.evaluate(`setCustTab('account')`);
    await page.evaluate(`S._hubSrc='dot';setCustTab('members')`); // another part of the app names the way in first
    await expect.poll(() => sent).toEqual(['tab', null, null, 'dot']);
    expect(await page.evaluate('S._hubSrc')).toBeNull();
    await page.evaluate(`setCustTab('myrides')`);
    await page.evaluate(`setCustTab('members')`);
    await expect.poll(() => sent).toEqual(['tab', null, null, 'dot', 'tab']);
    await page.evaluate(`S._hubSrc='push';setCustTab('members')`); // a push opened on the tab itself is an open of its own
    await expect.poll(() => sent).toEqual(['tab', null, null, 'dot', 'tab', 'push']);
  });

  test('a first read that got no answer counted nothing, so the next one carries the source', async ({ page }) => {
    const sent = feedsSent(page);
    await stubSupabase(page, { sessions: open, customers: [], queue_entries: [], bikes: [], 'rpc:hub_feed': feed() });
    let fail = true;
    await page.route('**/rest/v1/rpc/hub_feed*', (r) => (fail
      ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'boom' }) })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed()) })));
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`localStorage.removeItem('cq_hub_c1');S._hubSrc='rating';setCustTab('members')`);
    await expect(page.locator('#hub-body button', { hasText: 'Try again' })).toBeVisible();
    fail = false;
    await page.locator('#hub-body button', { hasText: 'Try again' }).click();
    await expect(hero(page)).toBeVisible();
    expect(sent).toEqual(['rating', 'rating']);
    await page.evaluate(`_hubRetry()`);
    await expect.poll(() => sent).toEqual(['rating', 'rating', null]);
  });

  test('a database before the entry points is read the old way', async ({ page }) => {
    const sent = feedsSent(page);
    await stubSupabase(page, { sessions: open, customers: [], queue_entries: [], bikes: [], 'rpc:hub_feed': feed() });
    await page.route('**/rest/v1/rpc/hub_feed*', (r) => {
      const b = r.request().postDataJSON() || {};
      return 'p_src' in b
        ? r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.hub_feed(p_id, p_src, p_token) in the schema cache', details: null, hint: null }) })
        : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed()) });
    });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('members')`);
    await expect(hero(page)).toBeVisible();
    await expect(page.locator('#hub-body .hub-stale')).toHaveCount(0);
    expect(sent).toEqual(['tab', null]);
  });
});

test.describe('@customer:members R9 R10 the next session', () => {
  const meet = { meet_url: 'https://maps.app.goo.gl/abc123', meet_name: 'Corniche North Gate', meet_name_ar: 'بوابة الكورنيش الشمالية', meet_lat: 21.5821, meet_lng: 39.1072 };

  test('a booked ride gives its two times and where it meets, with one map button on the point itself', async ({ page }) => {
    const s = sess('2099-01-10', '2099-01-10', meet);
    await member(page, { sessions: [open[0], s, open[2]], queue_entries: [booking('q1', s.id)], 'rpc:my_bookings': [booking('q1', s.id)] });
    const h = hero(page);
    await expect(h.locator('.hub-k').first()).toHaveText('Your next session');
    await expect(h.locator('.hub-f', { hasText: 'Gathering time' })).toContainText('6 AM');
    await expect(h.locator('.hub-f', { hasText: 'Start time' })).toContainText('6:30 AM');
    await expect(h.locator('.hub-place')).toContainText('Meeting point');
    await expect(h.locator('.hub-place')).toContainText('Corniche North Gate');
    await expect(h.locator('a.hub-map, button.hub-map')).toHaveCount(1);
    await expect(h.locator('a.hub-map')).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=21.5821,39.1072');
    await expect(h.locator('a.hub-map')).toHaveAttribute('target', '_blank');
    await expect(h.locator('.hub-hero-m')).not.toContainText('6:30'); // the times are the fields, not repeated in the date line
    await expect(h.locator('.hub-place')).toBeVisible();
    expect(await page.evaluate(`[...document.querySelectorAll('#hub-body .hub-hero > *')].map(x=>x.className).filter(c=>/hub-fields|hub-place/.test(c))`)).toEqual(['hub-fields', 'hub-place']);
    await h.locator('button', { hasText: 'Show ticket' }).click();
    await expect.poll(() => page.evaluate('S.custTab')).toBe('myrides');
    await page.evaluate(`setLang('ar');setCustTab('members')`);
    await expect(hero(page).locator('.hub-place')).toContainText('بوابة الكورنيش الشمالية');
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
  });

  test('without a named point the ticket\'s own name and link; a held ride names a meeting point with no map', async ({ page }) => {
    const s = sess('2099-01-10', '2099-01-10', { meet_url: 'https://maps.app.goo.gl/abc123' });
    await member(page, { sessions: [open[0], s, open[2]], queue_entries: [booking('q1', s.id)], 'rpc:my_bookings': [booking('q1', s.id)] });
    const h = hero(page);
    await expect(h.locator('.hub-place .hub-fk')).toHaveText('Meeting point');
    await expect(h.locator('.hub-place .hub-fv')).toHaveCount(0); // the ticket names it "Meeting point", which the label already says
    await expect(h.locator('a.hub-map')).toHaveAttribute('href', 'https://maps.app.goo.gl/abc123');
    await expect(h.locator('a.hub-map')).toHaveText(/Map/);
    // the breakfast spot told later (reveal_at ahead) and the row without its meeting point: no map, never the circuit's
    await page.evaluate(`(()=>{const x=S.sessions.find(z=>z.id==='2099-01-10');x.meet_url='';x.reveal_at='2099-01-09T18:00:00+03:00';_hubRender();})()`);
    await expect(h.locator('.hub-place .hub-fk')).toHaveText('Meeting point');
    await expect(h.locator('.hub-map')).toHaveCount(0);
    await expect(h).not.toContainText('Breakfast');
  });

  test('a pool session keeps its own words; a circuit night gives bike collection and the circuit\'s directions', async ({ page }) => {
    const pool = sess('sw-1', '2099-01-05', { ride_kind: 'swim', day: 'Monday', bike_slots: '{"_time":"19:00 - 20:30","_total":20}' });
    await member(page, { sessions: [...open, pool], queue_entries: [booking('q1', 'sw-1', { session_date: '2099-01-05', session_day: 'Monday' })], 'rpc:my_bookings': [booking('q1', 'sw-1', { session_date: '2099-01-05', session_day: 'Monday' })] });
    const h = hero(page);
    await expect(h.locator('.hub-f', { hasText: 'Start time' })).toContainText('7 PM');
    await expect(h.locator('.hub-f', { hasText: 'End time' })).toContainText('8:30 PM');
    await expect(h).not.toContainText('Gathering');
    const night = { id: '2099-01-02', day: 'Friday', session_date: '2099-01-02', capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_collect":"20:15","Road":10}' };
    await page.evaluate(`(()=>{S.sessions=[${JSON.stringify(night)}];const e=getQueue().find(x=>x.id==='q1');e.sessionId='2099-01-02';e.sessionDate='2099-01-02';_hubRender();})()`);
    await expect(h.locator('.hub-f', { hasText: 'Bike collection time' })).toContainText('8:15 PM');
    await expect(h.locator('.hub-f', { hasText: 'Start time' })).toContainText('9 PM');
    await expect(h.locator('.hub-place .hub-fk')).toHaveText('Where');
    await expect(h.locator('.hub-place .hub-fv')).toHaveText('Jeddah Corniche Circuit');
    await expect(h.locator('a.hub-map')).toHaveAttribute('href', /google\.com\/maps\/dir\//);
  });

  test('from 24 hours before the gathering the day heads the card', async ({ page }) => {
    const s = sess('2026-11-14', '2026-11-14', meet);
    await member(page, { sessions: [s, ...open], queue_entries: [booking('q1', s.id)], 'rpc:my_bookings': [booking('q1', s.id)] }, '2026-11-13T07:00:00+03:00');
    const h = hero(page);
    await expect(h).toHaveClass(/hub-hero-tomorrow/);
    await expect(h.locator('.hub-k').first()).toHaveText('Tomorrow');
    await expect(h.locator('.hub-hero-m')).not.toContainText('Tomorrow');
    await expect(h.locator('button', { hasText: 'Show ticket' })).toHaveAttribute('data-on-click', /setCustTab/);
  });

  test('from 3 hours before, where to go comes first and Show ticket opens the ticket; staff\'s word is a chip', async ({ page }) => {
    const s = sess('2026-11-14', '2026-11-14', { ...meet, ride_status: 'moved' });
    await member(page, { sessions: [s, ...open], queue_entries: [booking('q1', s.id)], 'rpc:my_bookings': [booking('q1', s.id)] }, '2026-11-14T04:00:00+03:00');
    const h = hero(page);
    await expect(h).toHaveClass(/hub-hero-today/);
    await expect(h.locator('.hub-k').first()).toHaveText('Today');
    await expect(h.locator('.hub-rs')).toHaveText('Start moved');
    expect(await page.evaluate(`[...document.querySelectorAll('#hub-body .hub-hero > *')].map(x=>x.className).filter(c=>/hub-fields|hub-place/.test(c))`)).toEqual(['hub-place', 'hub-fields']);
    await page.evaluate(`(()=>{S.sessions.find(z=>z.id==='2026-11-14').ride_status='cancelled';_hubRender();})()`);
    await expect(h.locator('.hub-rs')).toHaveText('Cancelled');
    await page.evaluate(`(()=>{S.sessions.find(z=>z.id==='2026-11-14').ride_status='nonsense';_hubRender();})()`);
    await expect(h.locator('.hub-rs')).toHaveCount(0);
    await h.locator('button', { hasText: 'Show ticket' }).click();
    await expect.poll(() => page.evaluate('S.custTab')).toBe('myrides');
    await expect(page.locator('#tab-myrides .ticket-card').first()).toBeInViewport();
  });

  test('an hour after the start the card moves on to the next booked session', async ({ page }) => {
    const s = sess('2026-11-14', '2026-11-14', meet), q = [booking('q1', s.id, { status: 'active' }), booking('q2', '2099-01-10')];
    await member(page, { sessions: [s, ...open], queue_entries: q, 'rpc:my_bookings': q }, '2026-11-14T07:31:00+03:00');
    const h = hero(page);
    await expect(h.locator('.hub-k').first()).toHaveText('Your next session');
    await expect(h.locator('.hub-hero-m')).toContainText('2099');
  });

  test('with nothing else booked, the recap of the ride the member rode leads the page', async ({ page }) => {
    const s = sess('2026-11-14', '2026-11-14', meet), q = [booking('q1', s.id, { status: 'done' })];
    const post = { id: 'post_14', auto: true, line: null, line_ar: null, riders: 120, rides: 120, first_rides: 11, leads: null, volunteers: null, prev_riders: 104, mine: 2, kind: 'saturday', date: '2026-11-14', img: false };
    await member(page, { sessions: [s, ...open], queue_entries: q, 'rpc:my_bookings': q, 'rpc:hub_feed': feed({ post }) }, '2026-11-14T12:00:00+03:00');
    const order = (await page.evaluate(`[...document.querySelectorAll('#hub-body > *')].map(x=>x.classList.contains('hub-report')?'report':x.classList.contains('hub-hero')?'hero':'other')`)) as string[];
    expect(order.indexOf('report')).toBeLessThan(order.indexOf('hero'));
    await expect(hero(page).locator('.hub-k').first()).toHaveText('Next session to book');
    await page.clock.setFixedTime(new Date('2026-11-16T12:00:00+03:00')); // two days on it takes its own place again
    await page.evaluate(`_hubRender()`);
    const later = (await page.evaluate(`[...document.querySelectorAll('#hub-body > *')].map(x=>x.classList.contains('hub-report')?'report':x.classList.contains('hub-hero')?'hero':'other')`)) as string[];
    expect(later.indexOf('report')).toBeGreaterThan(later.indexOf('hero'));
  });
});

test.describe('@customer:members R13 R20 the report and the goal', () => {
  const post = { id: 'post_7', auto: true, line: 'A calm morning on the Corniche.', line_ar: 'صباح هادئ على الكورنيش', riders: 96, rides: 96, first_rides: 12, leads: 4, volunteers: 11, prev_riders: 88, mine: 3, kind: 'saturday', date: '2026-11-07', img: false };

  test('the Saturday report is number tiles, the member\'s own line, and the staff\'s line', async ({ page }) => {
    await member(page, { 'rpc:hub_feed': feed({ post }) });
    const card = page.locator('#hub-body .hub-report');
    const tile = (l: string) => card.locator('.hub-stat').filter({ has: page.getByText(l, { exact: true }) });
    await expect(tile('Riders')).toContainText('96');
    await expect(tile('First Saturday rides')).toContainText('12');
    await expect(tile('Volunteers')).toContainText('11');
    await expect(tile('Change from last week')).toContainText('+8');
    await expect(tile('Community goal')).toContainText('312 / 446');
    await expect(tile('Rides')).toHaveCount(0); // rides as many as riders: one tile
    await expect(tile('Ride leads')).toHaveCount(0); // under 10 never shows
    await expect(card.locator('.hub-mine')).toContainText('Your Saturday rides this month');
    await expect(card.locator('.hub-mine')).toContainText('3');
    await expect(card).toContainText('A calm morning on the Corniche.');
    await expect(page.locator('#hub-body')).not.toContainText('Tip of the week');
    await page.evaluate(`Object.assign(S._hub.d.post,{prev_riders:101,mine:null,rides:98});S._hub.d.club={name:'Cool Season',name_ar:'موسم',scope:'saturday',target:8,n:2,mine:1,from:'2026-11-01',ends_on:'2027-02-28'};_hubRender()`);
    await expect(tile('Change from last week')).toContainText('-5');
    await expect(tile('Rides')).toContainText('98');
    await expect(tile('Community goal')).toHaveCount(0); // a staff goal running is not the month's own
    await expect(card.locator('.hub-mine')).toHaveCount(0);
    await page.evaluate(`setLang('ar')`);
    await expect(page.locator('#hub-body .hub-report .hub-stat bdi[dir=ltr]').first()).toHaveText('-5');
    await page.evaluate(`setLang('bn')`);
    expect(await page.evaluate(`/[০-৯०-९٠-٩]/.test(document.getElementById('hub-body').textContent)`)).toBe(false);
  });

  test('without a report the tip of the week is the staff card', async ({ page }) => {
    await member(page);
    await expect(page.locator('#hub-body')).toContainText('Tip of the week');
    await expect(page.locator('#hub-body .hub-report')).toHaveCount(0);
  });

  test('a goal reached says so and names the next Saturday\'s own target', async ({ page }) => {
    await member(page, { 'rpc:hub_feed': feed({ club: { scope: 'saturday', target: 446, n: 450, mine: 3, from: '2026-11-01', ends_on: '2026-11-30', manual: false, next: { date: '2026-11-28', target: 140 } } }) });
    const card = page.locator('#hub-body .hub-card', { hasText: 'Community goal' });
    await expect(card).toContainText('The club reached it');
    await expect(card.locator('.hub-f', { hasText: 'Next Saturday' })).toContainText('28 Nov 2026');
    await expect(card.locator('.hub-f', { hasText: 'Target' })).toContainText('140');
    await page.evaluate(`Object.assign(S._hub.d.club,{n:300,next:{date:'2026-11-28',target:140}});_hubRender()`);
    await expect(card.locator('.hub-next')).toHaveCount(0); // not reached: no next target
  });
});
