import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Calling off a night used to mean closing the session and every rider finding out at the
// gate. The flow has two halves: telling everyone (a prefilled message, one wa.me link per
// rider, copy-all-numbers), then the bookkeeping — every live booking cancelled, stamped
// staff, guarded on current status, session closed, undoable. Moving a night is NOT this
// flow: the session date edit already carries bookings.

const FUT = '2099-06-06';
const sessions = [{ id: FUT, session_date: FUT, day: 'Saturday', status: 'open', capacity: 20, created_at: 1 }];
const e = (id: string, st: string, x: Record<string, unknown> = {}) => ({
  id, session_id: FUT, session_day: 'Saturday', session_date: FUT, queue_num: 1, name: 'R ' + id,
  phone: '05500000' + id.length, type_preference: 'Road', size: 'M', status: st, paid: false,
  price: 75, registered_at: '2099-01-01T10:00:00Z', ...x });

async function boot(page: import('@playwright/test').Page, rows: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries: rows, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue();selectSessionDetail('${FUT}')`);
  await page.waitForTimeout(250);
}

test('the button offers on a live future night, with the count', async ({ page }) => {
  await boot(page, [e('a', 'waiting'), e('b', 'waitlist', { queue_num: 2, waitlist_num: 1 }), e('c', 'done', { queue_num: 3 })]);
  await expect(page.locator('#tab-queue')).toContainText('Cancel the night (2)');   // done is already history
});

test('the modal carries the message, the links and the roll', async ({ page }) => {
  await boot(page, [e('a', 'waiting'), e('b', 'waiting', { queue_num: 2, phone: '0551234567' })]);
  await page.evaluate(`showCancelNight('${FUT}')`);
  const m = page.locator('#cancel-night-modal');
  await expect(m).toContainText('2 live booking');
  await expect(m.locator('#cn-msg')).toHaveValue(/cancelled/);
  const links = await m.locator('a[href^="https://wa.me/"]').count();
  expect(links).toBe(2);
  const href = await m.locator('a[href^="https://wa.me/"]').last().getAttribute('href');
  expect(href).toContain('966551234567');
  expect(decodeURIComponent(href!)).toContain('cancelled');            // the message rides in the link
});

test('confirming cancels the live rows guarded, stamps staff, closes the session', async ({ page }) => {
  await boot(page, [e('a', 'waiting'), e('w', 'waitlist', { queue_num: 2, waitlist_num: 1 })]);
  const patches: { url: string; body: string }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && /rest\/v1\/(queue_entries|sessions)/.test(r.url()))
      patches.push({ url: r.url(), body: r.postData() || '' });
  });
  await page.evaluate(`showCancelNight('${FUT}')`);
  await page.locator('#cancel-night-modal').getByRole('button', { name: /Cancel 2 booking/ }).click();
  await expect.poll(() => patches.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  const q = patches.find((p) => p.url.includes('queue_entries'))!;
  expect(q.body).toContain('"status":"cancelled"');
  expect(q.body).toContain('"cancelled_by":"staff"');
  expect(decodeURIComponent(q.url)).toContain('id=in.(a,w)');
  expect(decodeURIComponent(q.url)).toMatch(/status=in\./);            // guarded on current status
  const sess = patches.find((p) => p.url.includes('/sessions'))!;
  expect(sess.body).toContain('"status":"closed"');
});

test('a night already over offers Close out, not Cancel the night', async ({ page }) => {
  const OLD = '2020-01-01';
  await stubSupabase(page, {
    sessions: [{ id: OLD, session_date: OLD, day: 'Sunday', status: 'open', capacity: 10, created_at: 1 }],
    queue_entries: [{ ...e('a', 'waiting'), session_id: OLD, session_date: OLD }], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue();selectSessionDetail('${OLD}')`);
  await page.waitForTimeout(250);
  const txt = await page.evaluate(`document.getElementById('tab-queue').innerText`) as string;
  expect(txt).toContain('Close out');
  expect(txt).not.toContain('Cancel the night');
});
