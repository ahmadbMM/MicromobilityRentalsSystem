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
