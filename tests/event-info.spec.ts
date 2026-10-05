import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// "About this event" under the event cards and "Details" under each date (the owner, 2026-10-05: 1B, 2B,
// 3B): one sheet with a short description, the live facts and a book button. Public events show it to
// everyone; members-only events and dates show it to community members only. The words are staff's when
// the Website editor holds some (site_content), and a date can add its own line from the session form.

const RUN = '2099-10-17-rh';
const run = {
  id: RUN, session_date: '2099-10-17', day: 'Saturday', status: 'open', capacity: 80, created_at: 1,
  event_kind: 'community', ride_kind: 'runher', needs_approval: false, hide_queue: true, spots: 80, open_to_all: false,
  paid_ride: false, location: 'JYC', meet_url: 'https://maps.app.goo.gl/UYBngHt3YwpayVZo7?g_st=ac', bike_slots: '{"_time":"06:00 - 06:30"}',
};
const jcc = (id: string, day: string) => ({ id, session_date: id, day, status: 'open', capacity: 12, created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":12}' });
const sat = {
  id: '2099-10-24', session_date: '2099-10-24', day: 'Saturday', status: 'open', capacity: 20, spots: 20, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true,
  title: 'Saturday Social Ride', bike_slots: '{"_time":"06:00 - 06:30"}', description: 'Bring water and a spare tube.',
};
const ev = (id: string, title: string, openToAll: boolean) => ({
  id, session_date: id.slice(0, 10), day: 'Tuesday', status: 'open', capacity: 30, spots: 30, created_at: 1, event_kind: 'community',
  ride_kind: 'event', paid_ride: true, price: 40, open_to_all: openToAll, needs_approval: false, hide_queue: true, title,
  description: title + ': two hours on brakes and gears.', bike_slots: '{"_time":"19:00 - 21:00"}',
});
const SESSIONS = [run, jcc('2099-10-18', 'Sunday'), jcc('2099-10-20', 'Tuesday'), sat, ev('2099-10-27-ev', 'Bike maintenance class', true), ev('2099-10-28-ev', 'Members talk', false)];

async function custBoot(page: Page, member: boolean, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: SESSIONS, queue_entries: [], 'rpc:community_member': member, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', birth_date: '1995-05-05' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}
const sheet = (page: Page) => page.locator('#bike-info-modal .ev-info');
const fact = (page: Page, label: string) => sheet(page).locator('.ev-info-facts > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd');

test.describe('@customer:info About this event and Details', () => {
  test('public events show About this event to everyone, members-only ones to members only', async ({ page }) => {
    await custBoot(page, false);
    const about = page.locator('#land-events .lec-about');
    await expect(page.locator('#land-events .lec-about.ab-jcc')).toHaveText('About this event');
    await expect(page.locator('#land-events .lec-about.ab-event')).toBeVisible();
    // the members check has answered no: still no link on the members' cards
    await expect.poll(() => page.evaluate('!!(S._infoMem&&!S._infoMem.busy)')).toBe(true);
    await page.evaluate('renderLandingAvail()');
    await expect(page.locator('#land-events .lec-about.ab-community, #land-events .lec-about.ab-runher')).toHaveCount(0);
    expect(await about.count()).toBe(2);
    // the cards themselves still open, and the link is no button inside a button
    await expect(page.locator('#land-events .landing-event-card .lec-about')).toHaveCount(0);
  });

  test('the circuit sheet: its words, the live facts and Book this event', async ({ page }) => {
    await custBoot(page, false);
    await page.locator('#land-events .lec-about.ab-jcc').click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator('#ev-info-title')).toHaveText('Open Sports Day');
    await expect(sheet(page).locator('.ev-info-text')).toContainText('the Formula 1 track');
    await expect(fact(page, 'Who')).toHaveText('Everyone');
    await expect(fact(page, 'Next date')).toContainText('Sunday');
    await expect(fact(page, 'Next date')).toContainText('Collect bikes from');
    await expect(fact(page, 'Where').locator('a')).toHaveText('Map');
    await expect(fact(page, 'Places')).toContainText('12');
    await sheet(page).getByRole('button', { name: 'Book this event' }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(await page.evaluate('[S.view,S.custTab,S.selEvent]')).toEqual(['customer', 'register', 'jcc']);
  });

  test('members get the links on the members-only cards, and Run for Her says its own facts', async ({ page }) => {
    await custBoot(page, true);
    await expect(page.locator('#land-events .lec-about.ab-runher')).toBeVisible();
    await expect(page.locator('#land-events .lec-about.ab-community')).toBeVisible();
    const link = page.locator('#land-events .lec-about.ab-runher');
    await link.click();
    await expect(sheet(page).locator('#ev-info-title')).toHaveText('Run for Her');
    await expect(sheet(page).locator('.ev-info-text')).toContainText('Dr. Samir Abbas Hospital');
    await expect(fact(page, 'Who')).toHaveText('Community members, 18 and over');
    await expect(fact(page, 'Distance')).toHaveText('3 km · 5 km');
    await expect(fact(page, 'Where')).toContainText('Jeddah Yacht Club');
    await expect(fact(page, 'Where').locator('a')).toHaveAttribute('href', run.meet_url);
    await expect(fact(page, 'Price')).toHaveCount(1);
    await sheet(page).getByRole('button', { name: 'Close' }).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(link).toBeFocused();
    // the umbrella card: who may book and its next date (any of its rides), never one ride's price
    await page.locator('#land-events .lec-about.ab-community').click();
    await expect(fact(page, 'Who')).toHaveText('Community members');
    await expect(fact(page, 'Next date')).toContainText('Saturday Social Ride');
    await expect(fact(page, 'Price')).toHaveCount(0);
  });

  test('Details under each date: the date filled in, its own line, and Choose this date', async ({ page }) => {
    await custBoot(page, true);
    await page.evaluate(`selectEvent('jcc')`);
    const det = page.locator('#tab-register .sess-wrap .sess-about');
    await expect(det).toHaveCount(2);
    await det.first().click();
    await expect(sheet(page).locator('#ev-info-title')).toContainText('Sunday');
    const txt = sheet(page).locator('.ev-info-text');
    await expect(txt).toContainText('An evening on the circuit. Collect your bike from');
    await expect(txt).toContainText('the session runs 9 PM to 11 PM');
    await expect(txt).not.toContainText('{');
    await sheet(page).getByRole('button', { name: 'Choose this date' }).click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe('2099-10-18');
    // the Saturday ride: gather and start from the date, the date's own line under the words, no places on a ride staff approve
    await page.evaluate(`showSessInfo('${sat.id}')`);
    await expect(sheet(page).locator('.ev-info-text')).toContainText('We gather at 6 AM and set off at 6:30 AM');
    await expect(sheet(page).locator('.ev-info-extra')).toHaveText('Bring water and a spare tube.');
    await expect(fact(page, 'Places')).toHaveCount(0);
    // an event's date says the event's own description
    await page.evaluate(`showSessInfo('2099-10-27-ev')`);
    await expect(sheet(page).locator('.ev-info-text')).toHaveText('Bike maintenance class: two hours on brakes and gears.');
    await expect(sheet(page).locator('.ev-info-extra')).toHaveCount(0);
  });

  test('a rider outside the community gets Details on public dates only', async ({ page }) => {
    await custBoot(page, false);
    await page.evaluate(`selectEvent('event')`);
    await expect(page.locator('#tab-register .sess-card')).toHaveCount(2);
    await expect(page.locator('#tab-register .sess-about')).toHaveCount(1);
    // asked directly, a members-only date opens nothing
    await page.evaluate(`showSessInfo('2099-10-28-ev');showSessInfo('${sat.id}');showEventInfo('runher')`);
    await expect(sheet(page)).toHaveCount(0);
  });

  test('staff words from the Website editor win, in the rider’s language', async ({ page }) => {
    await custBoot(page, false, {
      site_content: [
        { key: 'experiences.events.jccAbout', value: { en: 'Staff words for the circuit.', ar: 'كلمات الفريق عن الحلبة.' } },
        { key: 'experiences.dates.aboutJcc', value: { en: 'Gates open at {collect}.', ar: 'تفتح البوابات {collect}.', fr: 'Ouverture des portes à {collect}.' } },
      ],
    });
    await page.locator('#land-events .lec-about.ab-jcc').click();
    await expect(sheet(page).locator('.ev-info-text')).toHaveText('Staff words for the circuit.');
    await sheet(page).getByRole('button', { name: 'Close' }).click();
    await page.evaluate(`setLang('fr')`);
    await expect.poll(() => page.evaluate(`t('infoAbout')`)).toBe('À propos de cet événement');
    // no French version of the event's words: staff's English, never the French of the words they replaced
    await page.evaluate(`showEventInfo('jcc')`);
    await expect(sheet(page).locator('.ev-info-text')).toHaveText('Staff words for the circuit.');
    await page.evaluate(`showSessInfo('2099-10-18')`);
    await expect(sheet(page).locator('.ev-info-text')).toContainText('Ouverture des portes à');
    await expect(sheet(page).locator('.ev-info-text')).not.toContainText('{');
    // an untouched field keeps this page's own French
    await page.evaluate(`showEventInfo('event')`);
    await expect(sheet(page).locator('.ev-info-text')).toContainText('Conférences, cours et festivals');
  });
});

test.describe('@staff:sessions a date’s own line', () => {
  function writes(page: Page, method: string) {
    const out: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== method || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
      try { const b = r.postDataJSON(); (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => out.push(x)); } catch { /* not JSON */ }
    });
    return out;
  }
  test('the session forms save a Description for any kind of date', async ({ page }) => {
    await stubSupabase(page, { sessions: [jcc('2099-03-10', 'Tuesday')] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const patches = writes(page, 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-03-10')`);
    await expect(page.locator('#es-desc')).toHaveValue('');
    await page.locator('#es-desc').fill('Bring lights for the ride home.');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => patches.filter((p) => 'description' in p).length).toBe(1);
    expect(patches.find((p) => 'description' in p)).toEqual({ description: 'Bring lights for the ride home.' });
    // the new-date form: the box is there for a circuit evening too, and its words go in with the row
    const rows = writes(page, 'POST');
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S._nsTplId=null;S.newSessEvent='jcc';S.newSessCollect='';S.newSessStartTime='21:00';S.newSessEndTime='23:00';S.newSessMode='total';S.newSessTotal=10;renderSessions()`);
    await expect(page.locator('#sess-add-form')).toContainText('An extra line in this date’s Details');
    await page.locator('#ns-date').fill('2099-03-03');
    await page.locator('#ns-desc').fill('Free coffee at the booth.');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].description).toBe('Free coffee at the booth.');
  });
});
