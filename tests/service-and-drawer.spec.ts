import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The last two genuinely-missing items from the staff list. The fleet always recorded every
// ride; last_serviced_at is the one fact that turns that history into "due or not". And the
// closeout always computed what SHOULD be in the drawer; the count records what actually was,
// into the shared audit log, because a number nobody writes down is one nobody can ask about.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];
const ride = (n: number, x: Record<string, unknown> = {}) => ({
  id: 'r' + n, session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: n,
  name: 'Rider ' + n, phone: '0550000001', type_preference: 'Road', size: 'M', status: 'done',
  paid: true, price: 75, assigned_bike_id: 'b1',
  // one minute apart from 11:00 — template-built hours past 9 make invalid dates
  registered_at: new Date(Date.parse('2099-01-01T11:00:00Z') + n * 60000).toISOString(), ...x });

test('rides-since counts from the service stamp, and flags past the threshold', async ({ page }) => {
  const rides = Array.from({ length: 31 }, (_, i) => ride(i + 1));
  await stubSupabase(page, { sessions, queue_entries: rides, bikes: [
    { id: 'b1', name: 'R-01', type: 'Road', size: 'M', status: 'available', colors: [], last_serviced_at: '2099-01-01T10:30:00Z' }] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getBikes().length>0`);
  await page.evaluate(`openBikeProfile('b1')`);
  const m = page.locator('#bike-profile-modal');
  await expect(m).toContainText('Rides since service');
  // all 31 rides registered after 10:30 → over the 30-ride threshold → amber flag
  await expect(m.locator('.flt-svcn-due')).toHaveText('31');
  await expect(m.locator('.flt-svcn-due .art-warn')).toHaveCount(1); // the drawn warning mark
  await expect(m).toContainText('Mark serviced');
});

// The fleet was re-added from scratch in Sep 2026, so a bike never serviced counts every ride
// it has done (it used to read "not tracked" while the old fleet predated the service stamp).
test('never-serviced counts every ride and says so, flagged only past the threshold', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [ride(1)], bikes: [
    { id: 'b1', name: 'R-01', type: 'Road', size: 'M', status: 'available', colors: [] }] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getBikes().length>0`);
  await page.evaluate(`openBikeProfile('b1')`);
  const m = page.locator('#bike-profile-modal');
  const tile = m.getByText('Rides since service').locator('..');
  await expect(tile).toContainText('1');
  await expect(tile).toContainText('Never serviced');
  await expect(m.locator('.art-warn')).toHaveCount(0);
});

test('Mark serviced writes the stamp', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [ride(1)], bikes: [
    { id: 'b1', name: 'R-01', type: 'Road', size: 'M', status: 'available', colors: [] }] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getBikes().length>0`);
  const patches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/bikes')) patches.push(r.postData() || '');
  });
  await page.evaluate(`openBikeProfile('b1')`);
  await page.locator('#bike-profile-modal').getByRole('button', { name: /Mark serviced/ }).click();
  await expect.poll(() => patches.some((b) => b.includes('last_serviced_at')), { timeout: 5000 }).toBe(true);
});

test('the drawer count records expected vs counted into the log', async ({ page }) => {
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [
    ride(1, { pay_method: 'card' }),          // 75 by card — not in the drawer
    ride(2),                                  // 75 cash
    ride(3, { paid: false, status: 'active' }) // pending — not collected
  ] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('cashier');S._ctSession='${S1}';renderCashier()`);
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Till', exact: true }).click(); // no till tables in this stub: the count goes to the log as before
  const box = page.locator('.confirm-box').filter({ hasText: /Expected cash/ });
  await expect(box).toContainText('SAR 75');
  await box.locator('input').fill('70');
  await box.getByRole('button').last().click();
  await page.waitForTimeout(300);
  const logged = await page.evaluate(`JSON.stringify((S.fullLog||[]).slice(-3).map(l=>l.label))`) as string;
  expect(logged).toContain('Drawer count');
  expect(logged).toContain('expected 75');
  expect(logged).toContain('counted 70');
  expect(logged).toContain('-5');
});
