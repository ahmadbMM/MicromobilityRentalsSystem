import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The part-timers' hours at a close-out (the owner, 2026-11-08: "when closing out a jcc or petromin session ask for
// part timers to add them their hours, to choose from them and their task and the number of hours and allow to add
// multiple part timers"). Close out on a JCC or Petromin session opens, over the night's summary, one line per
// part-timer: who, the kind of work and the hours; the lines are saved as entries on that session and its day, at the
// kind's rate. Other sessions, and accounts that are not admins, are not asked.

const JCC = '2020-01-01', PM = '2020-01-08-pw', SAT = '2020-01-04';
const JOUD = 'aaaaaaaa-0000-0000-0000-000000000001', ANMAR = 'aaaaaaaa-0000-0000-0000-000000000002', GONE = 'aaaaaaaa-0000-0000-0000-000000000003';
const slots = JSON.stringify({ _time: '19:00 - 22:00', _total: 10 });
const sessions = [
  { id: JCC, session_date: JCC, day: 'Wednesday', status: 'closed', capacity: 10, created_at: 1, bike_slots: slots },
  { id: PM, session_date: '2020-01-08', day: 'Wednesday', status: 'closed', capacity: 10, created_at: 2, bike_slots: slots, event_kind: 'community', ride_kind: 'petromin', needs_approval: false },
  { id: SAT, session_date: SAT, day: 'Saturday', status: 'closed', capacity: 10, created_at: 3, bike_slots: slots, event_kind: 'community', ride_kind: 'saturday', needs_approval: false },
];
const people = [
  { user_id: JOUD, name: 'Joud Part', active: true },
  { user_id: ANMAR, name: 'Anmar Part', active: true },
  { user_id: GONE, name: 'Gone Part', active: false },
];
const kinds = [
  { id: 1, name: 'Customers check-in', rate: 30, active: true },
  { id: 2, name: 'Bikes handling', rate: 25, active: true },
];
const e = (id: string, sid: string, date: string) => ({
  id, session_id: sid, session_day: 'Wednesday', session_date: date, queue_num: 1, name: 'R ' + id, phone: '0550000001',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: true, price: 75, approval: 'approved',
  registered_at: '2020-01-01T10:00:00Z', checked_in_at: date + 'T19:10:00Z' });

async function boot(page: Page, x: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions, bikes: [], part_timers: people, part_timer_kinds: kinds, part_timer_shifts: [],
    queue_entries: [e('j', JCC, JCC), e('p', PM, '2020-01-08'), e('s', SAT, SAT)], ...x,
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
}
function shiftPosts(page: Page) {
  const out: unknown[] = [];
  page.on('request', (r: Request) => {
    if (r.method() === 'POST' && r.url().includes('/rest/v1/part_timer_shifts')) out.push(r.postDataJSON());
  });
  return out;
}
async function closeOut(page: Page, sid: string) {
  await page.evaluate(`closeOutSession('${sid}')`);
  await page.locator('#confirm-modal .confirm-box button').filter({ hasText: /close out/i }).click();
  await expect(page.locator('#eon-modal .eon-box')).toBeVisible();
}
const dlg = (page: Page) => page.locator('#ptc-modal .ptc-box');

test.describe('@staff:bookings part-timers at close-out', () => {
  test('a JCC close-out asks for the part-timers and saves one entry per line at the kind\'s rate', async ({ page }) => {
    await boot(page);
    const sent = shiftPosts(page);
    await closeOut(page, JCC);
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page)).toContainText('Part-timers’ hours');
    await expect(dlg(page)).toContainText('7 PM'); // the night's one-line label (2026-11-10): its start in the reader's clock
    // the active part-timers only, and every active kind of work
    await expect(page.locator('#ptc-who-0 option')).toHaveText(['Choose a part-timer', 'Joud Part', 'Anmar Part']);
    await expect(page.locator('#ptc-kind-0 option')).toHaveText(['Choose the kind of work', 'Customers check-in', 'Bikes handling']);
    await page.locator('#ptc-who-0').selectOption(JOUD);
    await page.locator('#ptc-kind-0').selectOption('1');
    await page.locator('#ptc-h-0').fill('3');
    await dlg(page).getByRole('button', { name: /Add part-timer/ }).click();
    await page.locator('#ptc-who-1').selectOption(ANMAR);
    await page.locator('#ptc-kind-1').selectOption('2');
    await page.locator('#ptc-h-1').fill('2.5');
    await expect(page.locator('#ptc-total')).toHaveText('Total: 5.5 h · SAR 152.50');
    // the first line is still as typed after the redraw that added the second
    await expect(page.locator('#ptc-h-0')).toHaveValue('3');
    await dlg(page).getByRole('button', { name: 'Save hours' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual([
      { part_timer_id: JOUD, kind_id: 1, work_date: JCC, session_id: JCC, hours: 3, rate: 30, note: '' },
      { part_timer_id: ANMAR, kind_id: 2, work_date: JCC, session_id: JCC, hours: 2.5, rate: 25, note: '' },
    ]);
    await expect(dlg(page)).toHaveCount(0);
    await expect(page.locator('#eon-modal .eon-box')).toBeVisible(); // the night's summary is still there
  });

  test('a line begun must be whole; empty lines are ignored; Skip sends nothing and the summary asks again', async ({ page }) => {
    await boot(page);
    const sent = shiftPosts(page);
    await closeOut(page, JCC);
    await dlg(page).getByRole('button', { name: /Add part-timer/ }).click();
    await page.locator('#ptc-h-1').fill('4');
    await dlg(page).getByRole('button', { name: 'Save hours' }).click();
    await expect(dlg(page)).toContainText('Choose a part-timer.');
    await page.locator('#ptc-who-1').selectOption(ANMAR);
    await dlg(page).getByRole('button', { name: 'Save hours' }).click();
    await expect(dlg(page)).toContainText('Choose the kind of work.');
    await page.locator('#ptc-kind-1').selectOption('1');
    await page.locator('#ptc-h-1').fill('30');
    await dlg(page).getByRole('button', { name: 'Save hours' }).click();
    await expect(dlg(page)).toContainText('Hours must be more than 0 and no more than 24.');
    // the empty first line is removed; the backdrop does not close a dialog with hours typed in
    await dlg(page).locator('.ptc-row').first().getByRole('button', { name: 'Remove' }).click();
    await expect(dlg(page).locator('.ptc-row')).toHaveCount(1);
    await page.locator('#ptc-modal .modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(dlg(page)).toBeVisible();
    await dlg(page).getByRole('button', { name: 'Skip' }).click();
    await expect(dlg(page)).toHaveCount(0);
    expect(sent).toHaveLength(0);
    await page.locator('#eon-modal').getByRole('button', { name: 'Part-timers’ hours' }).click();
    await expect(dlg(page)).toBeVisible();
    await expect(page.locator('#ptc-h-0')).toHaveValue('');
  });

  test('hours already logged on the session are listed, and the same part-timer again is asked once', async ({ page }) => {
    await boot(page, {
      part_timer_shifts: [{ id: 7, part_timer_id: JOUD, work_date: JCC, session_id: JCC, kind_id: 2, hours: 4, rate: 25, amount: 100, note: '', payout_id: null }],
    });
    const sent = shiftPosts(page);
    await closeOut(page, JCC);
    await expect(dlg(page).locator('.ptc-had')).toContainText('Joud Part · Bikes handling 4 h');
    await page.locator('#ptc-who-0').selectOption(JOUD);
    await page.locator('#ptc-kind-0').selectOption('1');
    await page.locator('#ptc-h-0').fill('1');
    await dlg(page).getByRole('button', { name: 'Save hours' }).click();
    await expect(dlg(page).locator('.ptc-dup')).toHaveText('Joud Part already has hours on this session. Log these hours as well?');
    expect(sent).toHaveLength(0);
    await dlg(page).getByRole('button', { name: 'Log as well' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual([{ part_timer_id: JOUD, kind_id: 1, work_date: JCC, session_id: JCC, hours: 1, rate: 30, note: '' }]);
  });

  test('a Petromin night asks too, on its own day', async ({ page }) => {
    await boot(page);
    const sent = shiftPosts(page);
    await closeOut(page, PM);
    await page.locator('#ptc-who-0').selectOption(ANMAR);
    await page.locator('#ptc-kind-0').selectOption('2');
    await page.locator('#ptc-h-0').fill('5');
    await dlg(page).getByRole('button', { name: 'Save hours' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual([{ part_timer_id: ANMAR, kind_id: 2, work_date: '2020-01-08', session_id: PM, hours: 5, rate: 25, note: '' }]);
  });

  test('a Saturday ride is not asked, nor is an account that is not an admin', async ({ page }) => {
    await boot(page);
    await closeOut(page, SAT);
    await page.waitForTimeout(400);
    await expect(dlg(page)).toHaveCount(0);
    await expect(page.locator('#eon-modal').getByRole('button', { name: 'Part-timers’ hours' })).toHaveCount(0);
    await page.evaluate(`_eonClose();S.staffRole='frontdesk'`);
    await closeOut(page, JCC);
    await page.waitForTimeout(400);
    await expect(dlg(page)).toHaveCount(0);
  });
});
