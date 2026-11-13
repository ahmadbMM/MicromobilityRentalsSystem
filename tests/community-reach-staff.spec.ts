import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The Community tab's reach, staff side (2026-11-13, reports/Community tab reach after launch.md R3, R10, R11, R13, R14, R20,
// R21, R22; migrations 20261114000100 and 20261114000200). Community > Activities: the numbers by entry point and week by week,
// the automatic Saturday report staff can edit or hide, the WhatsApp link with its source tag, the club goal by month and
// Ramadan's dates. The session editor: the meeting point by name and coordinate, and the ride's status. The reminder sheet:
// a rider the server reminded by push the evening before is skipped like one reminded on WhatsApp. All Supabase traffic is stubbed.

const NOW = new Date('2026-11-13T09:00:00Z'); // a Friday in Riyadh; the months and Ramadan below are read from it
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'l@example.com', phone: '+966551876215', created_at: '2026-06-10T00:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'o@example.com', phone: '+966551876216', created_at: '2026-06-11T00:00:00Z' },
];
const sat7 = { id: '2026-11-07', day: 'Saturday', session_date: '2026-11-07', capacity: 160, status: 'closed', created_at: 1, event_kind: 'community', ride_kind: 'saturday', bike_slots: '{"_time":"06:00 - 06:30","_total":160}' };
const autoPost = { id: 'post_auto_1107', session_id: '2026-11-07', line: null, line_ar: null, riders: 138, rides: 140, shows_from: '2026-11-07', shows_until: '2026-11-13', created_at: '2026-11-07T08:30:00Z',
  auto: true, first_rides: 14, leads: 6, volunteers: 11, prev_riders: 121, hidden: false };
const handPost = { id: 'post_hand', session_id: '2026-11-07', line: 'Thank you all', line_ar: 'شكرًا لكم', riders: 138, rides: 140, shows_from: '2026-11-08', shows_until: '2026-11-13', created_at: '2026-11-08T08:30:00Z',
  auto: false, first_rides: null, leads: null, volunteers: null, prev_riders: null, hidden: false };
const numbers = {
  month: '2026-11-01', first: 20, back: 9, openers: 120, open_days: 300, members: 437, challenges: 150, picked: 60, met: 40, club_target: 446, club_n: 300,
  src: { tab: 60, dot: 20, rating: 10, booked: 5, wa: 3, push: 2, badge: 0, link: 0 },
  weeks: [
    { from: '2026-11-07', to: '2026-11-13', openers: 40, booked: 120, booked_openers: 30, back: 12 },
    { from: '2026-10-31', to: '2026-11-06', openers: 30, booked: 110, booked_openers: 20, back: 5 },
  ],
};
const hub_club_goals = [
  { month: '2026-10-01', target: 360, manual: false, created_at: '2026-10-01T00:00:00Z' },
  { month: '2026-11-01', target: 446, manual: false, created_at: '2026-11-01T00:00:00Z' },
  { month: '2027-01-01', target: 380, manual: true, created_at: '2026-11-10T00:00:00Z' },
];
const hub_ramadan = [{ year: 2027, starts_on: '2027-02-08', ends_on: '2027-03-09', confirmed: false }];

async function staff(page: Page, fx: Fixtures = {}) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions: [sat7], customers, queue_entries: [], bikes: [], staff_options: [],
    tags: [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: 'green', locked: true }], customer_tags: [],
    titles: [], customer_titles: [], rotm_rounds: [], hub_goals: [], squads: [], squad_members: [], hub_photos: [], member_welcome: [], badges: [],
    hub_posts: [autoPost, handPost], hub_club_goals, hub_ramadan, 'rpc:staff_hub_numbers': numbers, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
  await page.waitForFunction('S._acAt>0&&!S._acBusy&&!!S._ac');
}
const sub = (page: Page, name: RegExp) => page.locator('#tab-community .filter-pill', { hasText: name }).click();
type Sent = { method: string; url: string; body: Record<string, unknown> | null };
const writes = (page: Page, table: string) => {
  const out: Sent[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' || r.method() === 'OPTIONS' || !new URL(r.url()).pathname.endsWith('/rest/v1/' + table)) return;
    let b: unknown = null; try { b = r.postDataJSON(); } catch { /* none */ }
    out.push({ method: r.method(), url: decodeURIComponent(r.url()), body: (Array.isArray(b) ? b[0] : b) as Record<string, unknown> | null });
  });
  return out;
};
const shot = (page: Page, name: string) => process.env.REACH_SHOTS
  ? page.locator(name.startsWith('sess') ? '#sess-edit-form' : '#tab-community').screenshot({ path: `${process.env.REACH_SHOTS}/${name}.png` }) : Promise.resolve();

test.describe('@staff:community reach after launch', () => {
  test('the numbers: opens by entry point and the weekly funnel, with their shares', async ({ page }) => {
    await staff(page);
    await sub(page, /^Numbers/);
    const src = page.locator('#tab-community table.ac-rx-t').first();
    await expect(src.locator('thead')).toContainText('Entry point');
    await expect(src.locator('tbody tr')).toHaveCount(9); // the eight entry points and the total
    await expect(src.locator('tbody tr', { hasText: 'Community tab' })).toContainText('60%');
    await expect(src.locator('tbody tr', { hasText: 'WhatsApp link' })).toContainText('3');
    await expect(src.locator('tbody tr', { hasText: 'After a rating' })).toContainText('10%');
    await expect(src.locator('tbody tr.ac-rx-tot')).toContainText('100');
    const wk = page.locator('#tab-community table.ac-rx-t').nth(1);
    await expect(wk.locator('thead')).toContainText('Booked members who opened');
    const first = wk.locator('tbody tr').first();
    await expect(first).toContainText('30 (25%)'); // 30 of the 120 booked opened the tab
    await expect(first).toContainText('12 (40%)'); // 12 of the 30 who opened the week before came back
    await expect(wk.locator('tbody tr').nth(1).locator('td').last()).toHaveText('5'); // the oldest week has no week before it here
    await shot(page, 'numbers');
  });

  test('a database before the migration shows the numbers without the two tables', async ({ page }) => {
    await staff(page, { 'rpc:staff_hub_numbers': { ...numbers, src: undefined, weeks: undefined } });
    await sub(page, /^Numbers/);
    await expect(page.locator('#tab-community')).toContainText('120 / 437');
    await expect(page.locator('#tab-community table.ac-rx-t')).toHaveCount(0);
  });

  test('the automatic report is marked with its numbers, has no Delete, and is hidden or shown', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'hub_posts');
    await sub(page, /^Saturday report/);
    const row = page.locator('[data-post="post_auto_1107"]');
    await expect(row).toContainText('Automatic');
    await expect(row).toContainText('138 riders · 140 rides · 14 first Saturday rides · 6 ride leads · 11 volunteers · Week before: 121 riders');
    await expect(row.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await expect(page.locator('[data-post="post_hand"]').getByRole('button', { name: 'Delete' })).toHaveCount(1); // one staff wrote can still go
    await shot(page, 'report-list');
    await row.getByRole('button', { name: 'Hide' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0]).toMatchObject({ method: 'PATCH', body: { hidden: true } });
    expect(w[0].url).toContain('id=eq.post_auto_1107');
    await expect(row).toContainText('Hidden');
    await row.getByRole('button', { name: 'Show' }).click();
    await expect.poll(() => w.length).toBe(2);
    expect(w[1].body).toEqual({ hidden: false });
    await expect(row).not.toContainText('Hidden');
  });

  test('staff add a line in both languages and a photo with no people, which needs the rule ticked; the photo can come off', async ({ page }) => {
    await staff(page);
    await page.route(/\/rest\/v1\/hub_posts\?select=img/, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify([{ img: 'data:image/jpeg;base64,BBBB' }]) }));
    const w = writes(page, 'hub_posts');
    await sub(page, /^Saturday report/);
    const row = page.locator('[data-post="post_auto_1107"]');
    await row.getByRole('button', { name: 'Edit' }).click();
    const form = page.locator('[data-post-ed="post_auto_1107"]');
    await expect(form.locator('img.ac-img')).toHaveAttribute('src', 'data:image/jpeg;base64,BBBB'); // the photo it has, read alone
    await form.locator('#ac-e-en').fill('A cool morning on the Corniche.');
    await form.locator('#ac-e-ar').fill('صباح لطيف على الكورنيش.');
    await page.evaluate(`S._acRepImg='data:image/jpeg;base64,CCCC';renderCommunity()`);
    await expect(form.locator('#ac-e-rule')).toBeVisible();
    await expect(form).toContainText('This photo shows no people');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast-container')).toContainText('Tick the photo rule');
    expect(w).toHaveLength(0);
    await form.locator('#ac-e-rule').check();
    await shot(page, 'report-edit');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toEqual({ line: 'A cool morning on the Corniche.', line_ar: 'صباح لطيف على الكورنيش.', img: 'data:image/jpeg;base64,CCCC' });
    await expect(row).toContainText('A cool morning on the Corniche.');
    // the photo taken off: img null, the lines as they are
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(form.locator('#ac-e-en')).toHaveValue('A cool morning on the Corniche.');
    await form.getByRole('button', { name: 'Remove photo' }).click();
    await expect(form.locator('img.ac-img')).toHaveCount(0);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => w.length).toBe(2);
    expect(w[1].body).toEqual({ line: 'A cool morning on the Corniche.', line_ar: 'صباح لطيف على الكورنيش.', img: null });
  });

  test('Copy WhatsApp link copies the members\' tab with its source tag', async ({ page }) => {
    await staff(page);
    await page.evaluate(`window.__clip=null;navigator.clipboard.writeText=(v)=>{window.__clip=v;return Promise.resolve();}`);
    await sub(page, /^Saturday report/);
    await page.locator('#tab-community').getByRole('button', { name: 'Copy WhatsApp link' }).click();
    await expect.poll(() => page.evaluate('window.__clip')).toBe('https://experiences.micromobility.sa/members?src=wa-recap');
    await expect(page.locator('#toast-container')).toContainText('Link copied');
  });

  test('the club goal: each month says who set it; February is set by hand and a manual month is cleared', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'hub_club_goals');
    await sub(page, /^Club goal/);
    await expect(page.locator('[data-cgoal="2026-11-01"]')).toContainText('Target 446 · Sized by the app');
    await expect(page.locator('[data-cgoal="2027-01-01"]')).toContainText('Target 380 · Set by staff');
    await expect(page.locator('[data-cgoal="2026-10-01"] button')).toHaveCount(0); // a past month is not changed
    await expect(page.locator('[data-cgoal="2026-11-01"]').getByRole('button', { name: 'Clear' })).toHaveCount(0); // only a target set by hand is cleared
    await expect(page.locator('#ac-cg-month option')).toHaveCount(15);
    await expect(page.locator('#ac-cg-month option').first()).toHaveAttribute('value', '2026-11-01');
    await page.locator('#ac-cg-month').selectOption('2027-02-01');
    await page.locator('#ac-cg-target').fill('0');
    await page.locator('#ac-cg-form').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast-container')).toContainText('Pick this month or a later one');
    expect(w).toHaveLength(0);
    await page.locator('#ac-cg-target').fill('300');
    await page.locator('#ac-cg-form').getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0]).toMatchObject({ method: 'POST', body: { month: '2027-02-01', target: 300, manual: true } });
    expect(w[0].url).toContain('on_conflict=month');
    await expect(page.locator('[data-cgoal="2027-02-01"]')).toContainText('Target 300 · Set by staff');
    await shot(page, 'club-goal');
    // Change fills the form with that month
    await page.locator('[data-cgoal="2026-11-01"]').getByRole('button', { name: 'Change' }).click();
    await expect(page.locator('#ac-cg-month')).toHaveValue('2026-11-01');
    await expect(page.locator('#ac-cg-target')).toHaveValue('446');
    // Clear takes two taps and deletes only a row set by hand
    const clr = page.locator('[data-cgoal="2027-01-01"]').locator('.btn-red');
    await clr.click();
    expect(w).toHaveLength(1);
    await page.locator('[data-cgoal="2027-01-01"]').getByRole('button', { name: 'Tap again' }).click();
    await expect.poll(() => w.length).toBe(2);
    expect(w[1].method).toBe('DELETE');
    expect(w[1].url).toContain('month=eq.2027-01-01');
    expect(w[1].url).toContain('manual=eq.true');
    await expect(page.locator('[data-cgoal="2027-01-01"]')).toHaveCount(0);
  });

  test('Ramadan: 2027 is projected until staff confirm it; a wrong length is refused; the template follows the dates', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'hub_ramadan');
    await sub(page, /^Club goal/);
    const row = page.locator('[data-ram="2027"]');
    await expect(row).toContainText('30 days');
    await expect(row).toContainText('Projected, not confirmed');
    await row.getByRole('button', { name: 'Edit' }).click();
    const form = page.locator('[data-ram-ed="2027"]');
    await expect(form.locator('#ac-rm-from')).toHaveValue('2027-02-08');
    await form.locator('#ac-rm-to').fill('2027-03-12'); // 33 days
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast-container')).toContainText('29 or 30 days');
    expect(w).toHaveLength(0);
    await form.locator('#ac-rm-from').fill('2027-02-09');
    await form.locator('#ac-rm-to').fill('2027-03-09');
    await form.locator('#ac-rm-ok').check();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0]).toMatchObject({ method: 'POST', body: { year: 2027, starts_on: '2027-02-09', ends_on: '2027-03-09', confirmed: true } });
    expect(w[0].url).toContain('on_conflict=year');
    await expect(row).toContainText('29 days');
    await expect(row).toContainText('Confirmed');
    await expect(row).not.toContainText('Projected');
    await shot(page, 'ramadan');
    expect(await page.evaluate(`_acTplFill(AC_TEMPLATES.find(x=>x.id==='ramadan'),'2026-11-13')`)).toMatchObject({ from: '2027-02-09', to: '2027-03-09' });
    // a year added ahead
    await page.locator('#tab-community').getByRole('button', { name: 'Add a year' }).click();
    const add = page.locator('[data-ram-ed="0"]');
    await add.locator('#ac-rm-year').fill('2028');
    await add.locator('#ac-rm-from').fill('2028-01-28');
    await add.locator('#ac-rm-to').fill('2028-02-26');
    await add.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => w.length).toBe(2);
    expect(w[1].body).toEqual({ year: 2028, starts_on: '2028-01-28', ends_on: '2028-02-26', confirmed: false });
    await expect(page.locator('[data-ram="2028"]')).toContainText('Projected, not confirmed');
  });

  test('without the new tables the Club goal view says the database is not ready', async ({ page }) => {
    await staff(page);
    await page.evaluate(`S._ac.club=null;S._ac.ramadan=null;S._acTabV='club';renderCommunity()`);
    await expect(page.locator('#tab-community .empty-state', { hasText: 'not set up on the database' })).toHaveCount(2); // the goals and Ramadan
    await expect(page.locator('#ac-cg-form, [data-ram]')).toHaveCount(0);
  });
});

// ── the session editor ──────────────────────────────────────────────────────────────────────────
const SAT = '2099-10-24';
const ride = (extra: Record<string, unknown> = {}) => ({
  id: SAT, session_date: SAT, day: 'Saturday', status: 'open', capacity: 20, spots: 20, created_at: 1, event_kind: 'community',
  ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true, bike_slots: '{"_time":"06:00 - 06:30"}', meet_url: 'https://maps.app.goo.gl/meetHere123', ...extra,
});
async function editor(page: Page, sessions: unknown[]) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded&&allSessions().length===${sessions.length}`);
}
const sessPatches = (page: Page) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /\/rest\/v1\/sessions\?/.test(r.url())) { try { out.push(r.postDataJSON()); } catch { /* none */ } } });
  return out;
};

test.describe('@staff:sessions the meeting point and the ride status', () => {
  test('a coordinate is read from lat, lng and from Google and Apple map links, within range', async ({ page }) => {
    await editor(page, [ride()]);
    const parse = (v: string) => page.evaluate(`_meetCoordParse(${JSON.stringify(v)})`);
    expect(await parse('')).toBeNull();
    expect(await parse('21.5433, 39.1728')).toEqual({ lat: 21.5433, lng: 39.1728 });
    expect(await parse('21.5433 39.1728')).toEqual({ lat: 21.5433, lng: 39.1728 });
    expect(await parse('٢١٫٥٤٣٣، ٣٩٫١٧٢٨'.replace(/٫/g, '.'))).toEqual({ lat: 21.5433, lng: 39.1728 }); // Arabic digits and comma
    expect(await parse('https://www.google.com/maps/@21.5433,39.1728,15z')).toEqual({ lat: 21.5433, lng: 39.1728 });
    expect(await parse('https://www.google.com/maps/place/Corniche/@21.6,39.1,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d21.5433!4d39.1728')).toEqual({ lat: 21.5433, lng: 39.1728 }); // the pin, not the view
    expect(await parse('https://maps.google.com/?q=21.5433,39.1728')).toEqual({ lat: 21.5433, lng: 39.1728 });
    expect(await parse('https://www.google.com/maps/search/?api=1&query=21.5433%2C39.1728')).toEqual({ lat: 21.5433, lng: 39.1728 });
    expect(await parse('https://maps.apple.com/?q=Corniche&ll=21.5433,39.1728')).toEqual({ lat: 21.5433, lng: 39.1728 });
    expect(await parse('https://maps.apple.com/place?coordinate=21.5433,39.1728&name=Corniche')).toEqual({ lat: 21.5433, lng: 39.1728 });
    expect(await parse('21.12345678, 39.12345678')).toEqual({ lat: 21.123457, lng: 39.123457 });
    expect(await parse('https://maps.app.goo.gl/meetHere123')).toBe(false); // a short link carries no coordinate
    expect(await parse('95, 39')).toBe(false);
    expect(await parse('21, 190')).toBe(false);
    expect(await parse('0, 0')).toBe(false);
    expect(await parse('Corniche')).toBe(false);
  });

  test('the editor writes the meeting point by name and coordinate; the map link stays as it was', async ({ page }) => {
    await editor(page, [ride()]);
    const p = sessPatches(page);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SAT}')`);
    await expect(page.locator('#es-map')).toHaveValue('https://maps.app.goo.gl/meetHere123');
    await page.locator('#es-mname').fill('North Corniche, Gate 3');
    await page.locator('#es-mname-ar').fill('الكورنيش الشمالي، البوابة 3');
    await page.locator('#es-mcoord').fill('https://maps.app.goo.gl/meetHere123');
    await expect(page.locator('#es-mcoord-out')).toContainText('No coordinate found');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('#es-mcoord')).toBeFocused();
    expect(p).toHaveLength(0); // refused before anything is written
    await page.locator('#es-mcoord').fill('https://www.google.com/maps/@21.5433,39.1728,15z');
    await expect(page.locator('#es-mcoord-out')).toContainText('Coordinate: 21.5433, 39.1728');
    await expect(page.locator('#es-mcoord-out a')).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=21.5433%2C39.1728');
    await shot(page, 'sess-meet');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => p.length).toBe(1);
    expect(p[0]).toMatchObject({ meet_url: 'https://maps.app.goo.gl/meetHere123', meet_name: 'North Corniche, Gate 3', meet_name_ar: 'الكورنيش الشمالي، البوابة 3', meet_lat: 21.5433, meet_lng: 39.1728 });
    expect(p[0]).not.toHaveProperty('ride_status'); // left as it was: not sent
  });

  test('a stored point opens as typed; emptying the box clears both halves; nothing unchanged is sent', async ({ page }) => {
    await editor(page, [ride({ meet_name: 'Gate 3', meet_name_ar: 'البوابة 3', meet_lat: 21.5433, meet_lng: 39.1728, ride_status: null })]);
    const p = sessPatches(page);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SAT}')`);
    await expect(page.locator('#es-mname')).toHaveValue('Gate 3');
    await expect(page.locator('#es-mcoord')).toHaveValue('21.5433, 39.1728');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => p.length).toBe(1);
    for (const k of ['meet_name', 'meet_name_ar', 'meet_lat', 'meet_lng', 'ride_status']) expect(p[0]).not.toHaveProperty(k);
    await expect(page.locator('#sess-edit-form')).toHaveCount(0); // the save has finished and closed the editor
    await page.evaluate(`startEditSession('${SAT}')`);
    await page.locator('#es-mcoord').fill('');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => p.length).toBe(2);
    expect(p[1]).toMatchObject({ meet_lat: null, meet_lng: null });
    expect(p[1]).not.toHaveProperty('meet_name');
  });

  test('a ride status is set on an upcoming session, says what Cancel session is for, and goes back to normal', async ({ page }) => {
    await editor(page, [ride()]);
    const p = sessPatches(page);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SAT}')`);
    const grp = page.locator('.ss-rs [role="group"]');
    await expect(grp.locator('button')).toHaveText(['Normal', 'Start moved', 'Shortened', 'Cancelled']);
    await expect(grp.locator('[data-rs="normal"]')).toHaveAttribute('aria-pressed', 'true');
    await grp.locator('[data-rs="cancelled"]').click();
    await expect(page.locator('.ss-rs')).toContainText('Cancel session gives them back');
    await shot(page, 'sess-status');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => p.length).toBe(1);
    expect(p[0]).toMatchObject({ ride_status: 'cancelled', status: 'open' }); // the status for riders only: the session stays open
    await expect(page.locator('#sess-edit-form')).toHaveCount(0);
    await page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='${SAT}'?{...s,ride_status:'cancelled'}:s);startEditSession('${SAT}')`);
    await expect(page.locator('.ss-rs [data-rs="cancelled"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.ss-rs [data-rs="moved"]').click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => p.length).toBe(2);
    expect(p[1]).toMatchObject({ ride_status: 'moved' });
    await expect(page.locator('#sess-edit-form')).toHaveCount(0);
    await page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='${SAT}'?{...s,ride_status:'moved'}:s);startEditSession('${SAT}')`);
    await page.locator('.ss-rs [data-rs="normal"]').click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => p.length).toBe(3);
    expect(p[2]).toMatchObject({ ride_status: null });
  });

  test('a session already past shows no ride status; a circuit night has no meeting point boxes', async ({ page }) => {
    await editor(page, [ride({ id: '2020-01-04', session_date: '2020-01-04' }), { id: '2099-10-22', day: 'Thursday', session_date: '2099-10-22', capacity: 10, status: 'open', created_at: 2, ride_kind: 'jcc', bike_slots: '{"_time":"21:00 - 23:00","_total":10}' }]);
    await page.evaluate(`setStaffTab('sessions');startEditSession('2020-01-04')`);
    await expect(page.locator('#es-mname')).toBeVisible();
    await expect(page.locator('.ss-rs')).toHaveCount(0);
    await page.evaluate(`startEditSession('2099-10-22')`);
    await expect(page.locator('.ss-rs')).toHaveCount(1);
    await expect(page.locator('#es-mname, #es-mcoord')).toHaveCount(0);
  });
});

// ── the reminder sheet ──────────────────────────────────────────────────────────────────────────
test.describe('@staff:bookings a push reminder counts as the day before\'s', () => {
  test('a rider the server reminded by push is skipped by the WhatsApp run the day before, not two hours before', async ({ page }) => {
    const sessions = [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '19:00 - 21:00' }) }];
    const qe = (id: string, n: number, extra: Record<string, unknown> = {}) => ({ id, name: 'Rider ' + n, phone: '05000000' + n + n, session_id: 's1', session_day: 'Friday', session_date: '2099-01-09',
      queue_num: n, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-08T10:00:00Z', reminded_at: null, reminded_kind: null, ...extra });
    await stubSupabase(page, { sessions, bikes: [], customers: [], staff_options: [],
      queue_entries: [qe('e1', 1, { reminded_at: '2099-01-08T18:00:00Z', reminded_kind: 'push' }), qe('e2', 2), qe('e3', 3, { reminded_at: '2099-01-08T17:00:00Z', reminded_kind: '24h' })] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length===3`);
    await page.evaluate(`openRemindSheet('s1','24h')`);
    const dlg = page.locator('[role="dialog"][aria-labelledby="rem-title"]');
    await expect(dlg.locator('.rem-row').nth(0)).toContainText('Reminded 9 PM (Push, the evening before)');
    await expect(dlg.locator('.rem-row').nth(0)).toHaveClass(/done/);
    await expect(dlg).toContainText('3 riders booked · 1 to remind');
    await expect(dlg.getByRole('button', { name: 'Send to the 1 not reminded' })).toBeEnabled();
    await dlg.getByRole('button', { name: '2 hours before' }).click();
    await expect(dlg).toContainText('3 riders booked · 3 to remind');
  });
});
