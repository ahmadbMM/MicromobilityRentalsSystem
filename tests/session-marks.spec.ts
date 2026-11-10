import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Telling sessions apart on the staff side (the user's picks on the decision page, 2026-11-10): one mark (what
// you do on it, in the kind's colour), one name (the circuit's too) and one short line of words for a session
// wherever staff meet one - "Pool, men · Thu 5 Mar · 6 PM", Today and Tomorrow in words; every session dropdown
// opens one picker with a heading for each day; the Sessions list is an agenda; an untitled Petromin night is
// "Petromin night". The clock is fixed, so Today is the same day on every machine. All Supabase traffic is stubbed.

const TODAY = '2099-03-03';
const night = (id: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Tuesday', session_date: id.slice(0, 10), capacity: 20, status: 'open', created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...extra,
});
const comm = { event_kind: 'community', needs_approval: true, hide_queue: true, spots: 20 };
const pw = { event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false, bike_slots: '{"_time":"19:00 - 21:00","_total":30}' };
const sessions = [
  night(TODAY),
  night('2099-03-04-pw', { day: 'Wednesday', ...pw }),
  night('2099-03-05', { day: 'Thursday', ...comm, ride_kind: 'swim', gender_only: 'male', title: 'Triathlon Pool Session', bike_slots: '{"_time":"18:00 - 19:00"}' }),
  night('2099-03-07', { day: 'Saturday', ...comm, ride_kind: 'saturday', bike_slots: '{"_time":"05:45 - 06:15"}' }),
  night('2099-03-07-2', { day: 'Saturday', ...comm, ride_kind: 'swim', gender_only: 'female', bike_slots: '{"_time":"11:30 - 12:45"}' }),
  night('2099-03-09-pw', { day: 'Monday', ...pw, title: "Petromin's Circuit Night" }),
];

async function boot(page: Page, fx: Fixtures = {}) {
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+03:00`));
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], tags: [], customer_tags: [], customers: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0');
}
const label = (page: Page, id: string) => page.evaluate(`_sessLabel(_sessGet(${JSON.stringify(id)}))`);

test.describe('@staff:sessions telling sessions apart', () => {
  test('one line of words names a session the same way everywhere', async ({ page }) => {
    await boot(page);
    expect(await label(page, TODAY)).toBe('Circuit · Today · 9 PM');
    expect(await label(page, '2099-03-04-pw')).toBe('Petromin · Tomorrow · 7 PM');
    expect(await label(page, '2099-03-05')).toMatch(/^Pool, men · Thu 5 Mar( 2099)? · 6 PM$/);
    expect(await label(page, '2099-03-07')).toMatch(/^Saturday ride · Sat 7 Mar( 2099)? · 5:45 AM$/);
    expect(await label(page, '2099-03-07-2')).toMatch(/^Pool, women · Sat 7 Mar( 2099)? · 11:30 AM$/);
    // a title staff gave is the session's own name; a stock one gives way to the kind's short word
    expect(await label(page, '2099-03-09-pw')).toMatch(/^Petromin's Circuit Night · Mon 9 Mar/);
    // an untitled Petromin night is a Petromin night whatever the weekday, and the circuit has a name
    expect(await page.evaluate(`_evName(_sessGet('2099-03-04-pw'))`)).toBe('Petromin night');
    expect(await page.evaluate(`_evName(_sessGet('${TODAY}'))`)).toBe('Jeddah Corniche Circuit');
  });

  test('a session dropdown opens the picker: a heading for each day, marks, search and keys', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue');S.sfSession='${TODAY}';showWalkinModal()`);
    const btn = page.locator('#wi-sess-spk');
    await expect(btn).toContainText('Circuit · Today · 9 PM');
    await expect(btn.locator('.smk.ev-jcc')).toHaveCount(1);
    // the dropdown itself stays for its handler, out of sight and out of the tab order
    await expect(page.locator('#wi-sess')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#wi-sess')).toHaveAttribute('tabindex', '-1');
    await btn.click();
    const dlg = page.locator('#spk-pop [role="dialog"]');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#spk-t')).toHaveText('Session');
    // the walk-in's own sessions (the circuit and Petromin nights), a heading for each day
    await expect(dlg.locator('.spk-gh')).toHaveText([/^Today · Tue 3 Mar/, /^Tomorrow · Wed 4 Mar/, /^Mon 9 Mar/]);
    await expect(dlg.locator('.spk-row')).toHaveCount(3);
    await expect(dlg.locator('.spk-row[aria-current="true"]')).toContainText('Jeddah Corniche Circuit');
    await expect(dlg.locator('.spk-row').nth(1).locator('.smk.ev-petromin')).toHaveCount(1);
    await expect(dlg.locator('.spk-row').nth(1)).toContainText('Petromin night');
    await expect(dlg.locator('.spk-row').nth(1)).toContainText('7 PM - 9 PM');
    // the search keeps what matches; Down from it reaches the first row, Enter picks it
    await dlg.locator('#spk-q').fill('petromin');
    await expect(dlg.locator('.spk-row')).toHaveCount(2);
    await dlg.locator('#spk-q').focus();
    await page.keyboard.press('ArrowDown');
    await expect(dlg.locator('.spk-row').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#spk-pop')).toHaveCount(0);
    await expect(page.locator('#wi-sess')).toHaveValue('2099-03-04-pw');
    await expect(page.locator('#wi-sess-spk')).toContainText('Petromin · Tomorrow · 7 PM');
    await expect(page.locator('#wi-sess-spk')).toBeFocused();
    // Escape closes and gives the focus back; nothing changes
    await page.locator('#wi-sess-spk').click();
    await expect(page.locator('#spk-pop [role="dialog"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#spk-pop')).toHaveCount(0);
    await expect(page.locator('#wi-sess-spk')).toBeFocused();
    await expect(page.locator('#wi-sess')).toHaveValue('2099-03-04-pw');
    // a search that matches nothing says so
    await page.locator('#wi-sess-spk').click();
    await page.locator('#spk-q').fill('zzz');
    await expect(page.locator('#spk-pop .spk-none')).toHaveText('No session matches.');
  });

  test('a dropdown changed without the picker still shows its pick on the button', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue');S.sfSession='2099-03-04-pw';showWalkinModal()`);
    await expect(page.locator('#wi-sess-spk')).toContainText('Petromin · Tomorrow');
    await page.locator('#wi-sess').selectOption(TODAY);
    await expect(page.locator('#wi-sess-spk')).toContainText('Circuit · Today · 9 PM');
  });

  test('the Sessions list is an agenda: a heading for each day, one line per session with its mark', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page);
    await page.evaluate(`setStaffTab('sessions');S.sessView='list';S.sessGroup='none';renderSessions()`);
    const heads = page.locator('#tab-sessions .ss-day-h');
    await expect(heads).toHaveCount(5);
    await expect(heads.first()).toHaveText(/^Today · Tue 3 Mar/);
    await expect(heads.first()).toHaveClass(/\bss-day-today\b/);
    await expect(heads.nth(1)).toHaveText(/^Tomorrow · Wed 4 Mar/);
    const rows = page.locator('#tab-sessions .sess-lc.sess-ag');
    await expect(rows).toHaveCount(6);
    await expect(rows.first().locator('.sess-ag-t')).toHaveText('9 PM');
    await expect(rows.first().locator('.sess-ag-nm')).toHaveText('Jeddah Corniche Circuit');
    await expect(rows.locator('.smk')).toHaveCount(6);
    // the two sessions of Saturday sit together under its heading, the pool's with who it is for
    const sat = page.locator('#tab-sessions .ss-day-h', { hasText: 'Sat 7 Mar' });
    await expect(sat).toHaveCount(1);
    await expect(page.locator('#tab-sessions .sess-lc', { hasText: '11:30 AM' }).locator('.sg-chip.sg-female')).toHaveText('Women only');
    // the detail pane names the session with its mark
    await page.evaluate(`selectSessionDetail('2099-03-05')`);
    await expect(page.locator('.sess-detail-nm')).toContainText('Triathlon Pool Session');
    await expect(page.locator('.sess-detail-nm .smk.ev-swim')).toHaveCount(1);
    // another grouping chosen in Customize still wins, and then each line carries its day
    await page.evaluate(`S.sessGroup='kind';renderSessions()`);
    await expect(page.locator('#tab-sessions .ss-day-h')).toHaveCount(0);
    await expect(rows.first().locator('.sess-ag-t')).toContainText('·');
  });

  test('each Bookings card leads with the mark and the name, Today and Tomorrow in words', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${TODAY}';renderStaffQueue()`);
    const chip = (id: string) => page.locator(`#sess-strip .sess-summary-chip[data-on-click*='"setSfSession","${id}"']`);
    await expect(chip(TODAY).locator('.smk.ev-jcc')).toHaveCount(1);
    await expect(chip(TODAY).locator('.sess-chip-event')).toHaveText('Jeddah Corniche Circuit');
    await expect(chip(TODAY).locator('.sess-chip-date')).toContainText('Today');
    await expect(chip('2099-03-04-pw').locator('.sess-chip-date')).toContainText('Tomorrow');
    await expect(chip('2099-03-05').locator('.sess-chip-date')).toContainText('Thu 5 Mar');
  });
});

// The order every staff list keeps (the user, 2026-11-10): today and the coming sessions first, open and closed
// alike, soonest at the top; then the past, the most recent first; open in green and closed in grey. And the five
// extras each session row carries, and the places that named a session their own way until then.
const ORDER = ['2099-03-03', '2099-03-04', '2099-03-05-pw', '2099-03-01', '2099-02-28-pw', '2099-02-24'];
const ordered = [
  night('2099-02-24', { status: 'closed' }),
  night('2099-02-28-pw', { day: 'Saturday', ...pw, status: 'closed' }),
  night('2099-03-01', { day: 'Sunday' }), // left open in the past
  night(TODAY, { location: 'JCC', series_id: 's1' }),
  night('2099-03-04', { day: 'Wednesday', status: 'closed', series_id: 's1' }),
  night('2099-03-05-pw', { day: 'Thursday', ...pw }),
];
const q = (id: string, sid: string, status: string) => ({ id, session_id: sid, session_day: 'Tuesday', session_date: sid.slice(0, 10), queue_num: 1,
  name: 'Rider ' + id, type_preference: 'Road', size: 'M', status, paid: false, price: 50, registered_at: '2099-01-01T10:00:00Z' });

test.describe('@staff:sessions sessions in order and in colour', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, { sessions: ordered, queue_entries: [q('w1', '2099-03-05-pw', 'waitlist'), q('o1', '2099-03-01', 'waiting'), q('t1', TODAY, 'waiting')] });
  });

  test('today on in date order, open and closed alike, then the past latest first', async ({ page }) => {
    expect(await page.evaluate(`allSessions().sort(_sessOrder).map(s=>s.id)`)).toEqual(ORDER);
    await page.evaluate(`setStaffTab('sessions');S.sessView='list';S.sessGroup='none';renderSessions()`);
    const rows = page.locator('#tab-sessions .sess-lc.sess-ag');
    expect(await rows.evaluateAll((els) => els.map((e) => (e.getAttribute('data-on-click') || '').match(/"(2099[^"]+)"/)?.[1]))).toEqual(ORDER);
    // the past has a heading of its own, right before its first day
    await expect(page.locator('#tab-sessions .ss-past-h')).toHaveText('Past');
    // open green, closed grey: the row's edge and its badge
    await expect(rows.nth(0)).toHaveClass(/\bst-open\b/);
    await expect(rows.nth(1)).toHaveClass(/\bst-closed\b/);
    const edge = (i: number) => rows.nth(i).evaluate((e) => getComputedStyle(e).borderInlineStartColor);
    expect(await edge(0)).not.toBe(await edge(1));
    await expect(rows.nth(0).locator('.badge-open')).toHaveCount(1);
    await expect(rows.nth(1).locator('.badge-closed')).toHaveCount(1);
  });

  test('the picker keeps the same order, says where the past begins and shows each status', async ({ page }) => {
    await page.evaluate(`setStaffTab('queue');S.sfSession='all';showWalkinModal()`);
    // with every session on the desk, the walk-in starts on the first one still taking bookings: tonight
    await expect(page.locator('#wi-sess')).toHaveValue(TODAY);
    await page.locator('#wi-sess-spk').click();
    const dlg = page.locator('#spk-pop [role="dialog"]');
    expect(await dlg.locator('.spk-row').evaluateAll((els) => els.map((e) => (e.getAttribute('data-on-click') || '').match(/"(2099[^"]+)"/)?.[1]))).toEqual(ORDER);
    await expect(dlg.locator('.spk-gh-past')).toHaveText('Past');
    await expect(dlg.locator('.spk-row').nth(0).locator('.badge-open')).toHaveCount(1);
    await expect(dlg.locator('.spk-row').nth(1).locator('.badge-closed')).toHaveCount(1);
    // no session code any more (2026-11-10, the user: "remove session codes"): a code finds nothing
    await expect(dlg.locator('.ssx-code')).toHaveCount(0);
    await dlg.locator('#spk-q').fill('PM-0305');
    await expect(dlg.locator('.spk-row')).toHaveCount(0);
  });

  test('each row carries the places left, the waitlist, the meeting place and its place in a series, and no code', async ({ page }) => {
    await page.evaluate(`setStaffTab('sessions');S.sessView='list';S.sessGroup='none';renderSessions()`);
    const row = (id: string) => page.locator(`#tab-sessions .sess-lc[data-on-click*='"${id}"']`);
    await expect(page.locator('#tab-sessions .ssx-code')).toHaveCount(0);
    await expect(row(TODAY).locator('.ssx-place')).toHaveText('JCC');
    await expect(row(TODAY).locator('.ssx-ser')).toHaveText('1 of 2');
    await expect(row('2099-03-04').locator('.ssx-ser')).toHaveText('2 of 2');
    await expect(row(TODAY).locator('.ssx-left')).toHaveText('19 left');
    await expect(row('2099-03-05-pw').locator('.ssx-wl')).toHaveText('1 on waitlist');
    await expect(row('2099-02-24').locator('.ssx-left')).toHaveCount(0); // a past night has no places to offer
    // the Bookings cards, four short lines (2026-11-10): the status on the name's line, the place after the time,
    // the places left and the waitlist ("W 1", said once) beside the fill bar
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${TODAY}';renderStaffQueue()`);
    const card = (id: string) => page.locator(`#sess-strip .sess-bar-desktop .sess-summary-chip[data-on-click*='"${id}"']`);
    await expect(card(TODAY).locator('.sess-chip-top .sess-chip-badge .badge-open')).toHaveCount(1);
    await expect(card(TODAY).locator('.sess-chip-date .ssx-place')).toHaveText('JCC');
    await expect(card(TODAY).locator('.sess-chip-date .ssx-ser')).toHaveText('1 of 2');
    await expect(card('2099-03-05-pw').locator('.sess-chip-foot .n6c-left')).toHaveText(/W 1/);
    await expect(card('2099-03-05-pw').locator('.ssx-wl')).toHaveCount(0);
    await expect(page.locator('#sess-strip .ssx-code')).toHaveCount(0);
    expect((await card(TODAY).boundingBox())!.height).toBeLessThan(100);
  });

  test('the roster with every session, the Dashboard and the scanner name a session the same way', async ({ page }) => {
    // Bookings with every session listed: each session's heading has its mark and its name
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='all';S.sfShowFinished=true;renderStaffQueue()`);
    const hdr = page.locator(`tr.sess-group-hdr`, { hasText: 'Today' });
    await expect(hdr).toContainText('Jeddah Corniche Circuit');
    await expect(hdr.locator('.smk.ev-jcc')).toHaveCount(1);
    // the Dashboard: today's sessions with their mark and status in green, the next one by its label, the night to close out by name
    await page.evaluate(`setStaffTab('dashboard')`);
    const today = page.locator('#tab-dashboard .dash-row', { hasText: 'Jeddah Corniche Circuit' }).first();
    await expect(today.locator('.smk.ev-jcc')).toHaveCount(1);
    await expect(today.locator('.dash-st.st-open')).toHaveCount(1);
    await expect(page.locator('#tab-dashboard')).toContainText('Next: Circuit · Today · 9 PM');
    await expect(page.locator('#tab-dashboard .dash-row', { hasText: /Sun 1 Mar|1 Mar/ })).toContainText('Jeddah Corniche Circuit');
    // the calendar: each cell's edge says open or closed, its mark says the kind
    await page.evaluate(`setStaffTab('sessions');S.sessView='cal';renderSessions()`);
    await expect(page.locator('.cal-sess.st-open .smk.ev-jcc').first()).toBeVisible();
    await expect(page.locator('.cal-sess.st-closed')).not.toHaveCount(0);
    const calEdge = (sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).borderInlineStartColor);
    expect(await calEdge('.cal-sess.st-open')).not.toBe(await calEdge('.cal-sess.st-closed'));
    // the scanner's "this ticket is for another day" names the session by its short name, its date and its times
    // (the message says how far off it is itself)
    expect(await page.evaluate(`_scanSessLabel(_sessDisp('2099-03-04'))`)).toMatch(/^Circuit · Wed 4 Mar( 2099)? · 9 PM - 11 PM$/);
  });
});
