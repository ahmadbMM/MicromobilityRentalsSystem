import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// The Experiences card, its list and the Saturday Social Ride (the owner's picks on the theming page, 2026-11-13): the card
// leads with marks for what it holds and no lockup (Q1 c, Q2 c, Q3 a), says About and See dates (A4); the list opens in the
// card's pattern (B1), offers a kind switch (B5), says Date on a list mixing rides and pool sessions (B3), marks each row
// with its kind's tile and motif (B2), shows the Saturday ride's number (Q6 a) and sunrise (Q5); a date's sheet has its
// kind's drawing (C3) and the Saturday routes (D1); the Saturday ticket has the dawn and the number (C4); a session's
// Arabic name shows on the Arabic page (Q9 a).

const sess = (id: string, x: Record<string, unknown>) => ({ id, session_date: id.slice(0, 10), status: 'open', capacity: 200, spots: 200, created_at: 1, event_kind: 'community', needs_approval: true, hide_queue: true, ...x });
const sat = (id: string, x: Record<string, unknown> = {}) => sess(id, { day: 'Saturday', ride_kind: 'saturday', bike_slots: '{"_time":"06:00 - 06:30"}', ...x });
const SESSIONS = [
  sat('2026-07-11', { status: 'closed' }), // before the series' first ride in the app: not counted
  sat('2026-07-18', { status: 'closed' }), // Ride 1
  sat('2026-07-25', { status: 'closed' }), // Ride 2
  sat('2026-08-01', { status: 'deleted' }), // deleted: not counted
  sat('2026-08-08', { status: 'closed', cancelled_at: '2026-08-07T10:00:00Z' }), // called off: not counted
  sat('2026-08-15', { status: 'closed' }), // Ride 3
  sat('2099-11-14'), // Ride 4
  sat('2099-11-21'), // Ride 5
  sess('2099-11-18-pw', { day: 'Wednesday', ride_kind: 'petromin', paid_ride: true, price: 57.5, needs_approval: false, hide_queue: false, title: "Petromin's Wednesdays", title_ar: 'أربعاء بترومين', bike_slots: '{"_time":"20:00 - 22:00"}' }),
  sess('2099-11-19-sw', { day: 'Thursday', ride_kind: 'swim', title: 'Triathlon Pool Session', bike_slots: '{"_time":"18:00 - 19:30"}' }),
  { id: '2099-11-16', session_date: '2099-11-16', day: 'Monday', status: 'open', capacity: 12, created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":12}' },
];
const booking = (id: string, sid: string, x: Record<string, unknown> = {}) => ({ id, name: 'Sara Haddad', customer_id: 'c1', session_id: sid, session_day: 'Saturday', session_date: sid.slice(0, 10), queue_num: 7, status: 'waiting', paid: false, price: 0, registered_at: 1, type_preference: 'Hybrid', approval: 'pending', ...x });

async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubSupabase(page, { sessions: SESSIONS, queue_entries: [], 'rpc:community_member': true, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', birth_date: '1995-05-05' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}
const sheet = (page: Page) => page.locator('#bike-info-modal .ev-info');
const row = (page: Page, id: string) => page.locator(`#sc-${id}`);

test.describe('@customer:experiences the Experiences card, its list and the Saturday ride', () => {
  test('the card leads, holds a mark per kind on its books and no lockup, and says About and See dates', async ({ page }) => {
    await boot(page);
    const first = page.locator('#land-events .landing-events-grid > .lec-wrap').first();
    await expect(first.locator('.landing-event-card')).toHaveClass(/\bev-community\b/);
    await expect(first.locator('.lec2-logo')).toHaveCount(0);
    const marks = first.locator('.lec-marks .lec-mk');
    await expect(marks).toHaveCount(3);
    expect(await marks.evaluateAll((els) => els.map((e) => (/\bev-(\w+)/.exec(e.className) || [])[1]))).toEqual(['saturday', 'swim', 'petromin']);
    await expect(first.locator('.lec-marks')).toHaveAttribute('aria-label', 'Saturday Social Ride · Triathlon Pool Session · Petromin night');
    await expect.poll(() => page.evaluate('!!(S._infoMem&&!S._infoMem.busy)')).toBe(true);
    await page.evaluate('renderLandingAvail()');
    await expect(page.locator('#land-events .lec-about.ab-community')).toHaveText('About');
    await expect(page.locator('#land-events .lec-about.ab-jcc')).toHaveText('About this event'); // the other cards keep theirs
    await page.locator('#land-events .lec-about.ab-community').click();
    await expect(sheet(page).locator('.ev-info-kick')).toHaveText('About');
    await expect(sheet(page).getByRole('button', { name: 'See dates' })).toBeVisible();
  });

  test('the list: the band, Date on a mixed list, the kind switch, each kind on its row', async ({ page }) => {
    await boot(page);
    await page.evaluate(`selectEvent('community')`);
    await expect(page.locator('.reg-band .reg-band-k')).toHaveText('MicroMobility Experiences');
    await expect(page.locator('.reg-band #reg-h')).toHaveText('Choose a date');
    // the kinds in the card's order
    const kinds = page.locator('.reg-kinds .reg-kind');
    await expect(kinds).toHaveText(['All', 'Saturday', 'Pool', 'Petromin']);
    await expect(kinds.first()).toHaveAttribute('aria-pressed', 'true');
    // rows: the tile, the motif, the Saturday ride's number counted from 18 Jul 2026 (deleted and called off nights skipped)
    await expect(row(page, '2099-11-14').locator('.k-tile svg')).toHaveCount(1);
    await expect(row(page, '2099-11-14').locator('.sess-ride-no')).toHaveText('Ride 4');
    await expect(row(page, '2099-11-21').locator('.sess-ride-no')).toHaveText('Ride 5');
    await expect(row(page, '2099-11-19-sw').locator('.sess-ride-no')).toHaveCount(0);
    for (const id of ['2099-11-14', '2099-11-19-sw', '2099-11-18-pw']) await expect(row(page, id).locator('> .k-art.sess-motif')).toHaveCount(1);
    expect(await row(page, '2099-11-14').locator('.sess-motif').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('linear-gradient');
    expect(await row(page, '2099-11-19-sw').locator('.sess-motif').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('data:image/svg+xml');
    // sunrise on the Saturday ride's meta line only
    await expect(row(page, '2099-11-14').locator('.sess-card-meta')).toContainText(/Sunrise \d{1,2}:\d{2} AM/);
    await expect(row(page, '2099-11-19-sw').locator('.sess-card-meta')).not.toContainText('Sunrise');
    // Pool alone: the rows narrow and the words are the session's; All brings the rest back
    await kinds.filter({ hasText: 'Pool' }).click();
    await expect(page.locator('.sess-card')).toHaveCount(1);
    await expect(page.locator('#reg-h')).toHaveText('Choose your session');
    await kinds.filter({ hasText: 'Saturday' }).click();
    await expect(page.locator('.sess-card')).toHaveCount(2);
    await expect(page.locator('#reg-h')).toHaveText('Choose your ride');
    await kinds.filter({ hasText: 'All' }).click();
    await expect(page.locator('.sess-card')).toHaveCount(4);
    // a new visit starts on All
    await page.locator('.reg-kinds .reg-kind', { hasText: 'Pool' }).click();
    await page.evaluate(`goLanding();selectEvent('community')`);
    await expect(page.locator('.sess-card')).toHaveCount(4);
  });

  test('the circuit list has no band and no switch', async ({ page }) => {
    await boot(page);
    await page.evaluate(`selectEvent('jcc')`);
    await expect(page.locator('#reg-h')).toBeVisible();
    await expect(page.locator('.reg-band, .reg-kinds')).toHaveCount(0);
  });

  test('a Saturday date’s sheet: the dawn, its number, the routes and sunrise; the pool’s has its water', async ({ page }) => {
    await boot(page);
    await page.evaluate(`selectEvent('community');showSessInfo('2099-11-14')`);
    await expect(sheet(page).locator('> .ev-info-art.k-art')).toHaveCount(1);
    await expect(sheet(page).locator('.ev-info-no')).toHaveText('Ride 4');
    const route = sheet(page).locator('svg.sr-route');
    await expect(route).toHaveAttribute('aria-hidden', 'true');
    await expect(route.locator('.sr-pill text')).toHaveText(['20 km', '40 km']);
    await expect(sheet(page).locator('.ev-info-facts > div', { has: page.locator('dt', { hasText: 'Sunrise' }) }).locator('dd')).toHaveText(/^\d{1,2}:\d{2} AM$/);
    await page.evaluate(`closeEventInfo();showSessInfo('2099-11-19-sw')`);
    await expect(sheet(page).locator('> .ev-info-art.k-art')).toHaveCount(1);
    await expect(sheet(page).locator('svg.sr-route, .ev-info-no')).toHaveCount(0);
    await expect(sheet(page).locator('.ev-info-facts dt', { hasText: 'Sunrise' })).toHaveCount(0);
  });

  test('the route turns round for Arabic, and the Arabic page shows the Arabic name staff typed', async ({ page }) => {
    await boot(page);
    const startX = async () => Number(await page.locator('#bike-info-modal svg.sr-route .sr-st').getAttribute('cx'));
    await page.evaluate(`selectEvent('community');showSessInfo('2099-11-14')`);
    expect(await startX()).toBe(16);
    await page.evaluate(`closeEventInfo();setLang('ar')`);
    await expect.poll(() => page.evaluate(`t('kfAll')`)).toBe('الكل');
    await page.evaluate(`showSessInfo('2099-11-14')`);
    expect(await startX()).toBe(304);
    await page.evaluate(`closeEventInfo();renderRegister()`);
    await expect(row(page, '2099-11-18-pw').locator('.sess-comm-chip')).toHaveText('أربعاء بترومين');
    await expect(row(page, '2099-11-19-sw').locator('.sess-comm-chip')).toHaveText('Triathlon Pool Session'); // no Arabic name: as typed
    await page.evaluate(`setLang('en')`);
    await expect(row(page, '2099-11-18-pw').locator('.sess-comm-chip')).toHaveText("Petromin's Wednesdays");
  });

  // The dawn picture across the ticket's top, and the ride's number on it, went on 2026-11-13 (the user: "remove the
  // images at the top of the booking cards").
  test('the Saturday ticket has no picture across its top; the booking number still waits for Publish', async ({ page }) => {
    const b = [booking('s1', '2099-11-14')];
    await boot(page, { queue_entries: b, 'rpc:my_bookings': b });
    await page.evaluate(`goCustomer('myrides')`);
    const card = page.locator('#tab-myrides .ticket-card.th-saturday');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.k-art')).toHaveCount(0);
    await expect(card).not.toContainText('Ride 4');
    await expect(card.locator('.ticket-num')).not.toContainText('#7');
  });

  test('sunrise and the ride number are worked out on the phone', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`[_sunriseMin('2026-11-14'),_sunriseMin('2026-12-19'),_sunriseMin('2026-07-18')]`)).toEqual([393, 415, 350]);
    expect(await page.evaluate(`[_satRideNo(_sessGet('2026-07-18')),_satRideNo(_sessGet('2026-08-15')),_satRideNo(_sessGet('2026-07-11')),_satRideNo(_sessGet('2099-11-19-sw'))]`)).toEqual([1, 3, 0, 0]);
  });
});

test.describe('@staff:sessions the session form asks the Arabic name', () => {
  const pool = sess('2099-11-19-sw', { day: 'Thursday', ride_kind: 'swim', title: 'Triathlon Pool Session', title_ar: null, bike_slots: '{"_time":"18:00 - 19:30"}' });
  async function staff(page: Page, sessions: unknown[]) {
    await stubSupabase(page, { bikes: [], queue_entries: [], sessions });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('allSessions().length>0');
  }
  function writes(page: Page) {
    const w: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (['POST', 'PATCH'].includes(r.method()) && r.url().includes('/rest/v1/sessions')) { try { const b = r.postDataJSON(); w.push(Array.isArray(b) ? b[0] : b); } catch { /* none */ } }
    });
    return w;
  }

  test('an edit saves what is typed in Arabic', async ({ page }) => {
    await staff(page, [pool]);
    const w = writes(page);
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-11-19-sw')`);
    await page.fill('#es-title-ar', 'جلسة المسبح');
    await page.evaluate('saveSessionEdit()');
    await expect.poll(() => w.some((b) => 'title_ar' in b)).toBe(true);
    expect(w.find((b) => 'title_ar' in b)!.title_ar).toBe('جلسة المسبح');
  });

  test('a database without the column is not asked for it', async ({ page }) => {
    const old: Record<string, unknown> = { ...pool };
    delete old.title_ar;
    await staff(page, [old]);
    const w = writes(page);
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-11-19-sw')`);
    await expect(page.locator('#es-title')).toBeVisible();
    await expect(page.locator('#es-title-ar')).toHaveCount(0);
    await page.evaluate('saveSessionEdit()');
    await expect.poll(() => w.some((b) => 'title' in b)).toBe(true);
    expect(w.some((b) => 'title_ar' in b)).toBe(false);
  });
});
