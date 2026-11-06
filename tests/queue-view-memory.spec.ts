import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Opening the queue always lands on the current session: tonight's while it is live, else the
// latest ride up to today, else the next live one. A refresh brings back the view and the status
// filter, but not the session.
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const S2 = '2099-01-20';
const sessions = [
  { id: today, day: 'Today', session_date: today, capacity: 20, status: 'open', created_at: 1 },
  { id: S2, day: 'Tuesday', session_date: S2, capacity: 20, status: 'open', created_at: 2 },
];

async function openStaff(page: Page, fixture: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions: fixture, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');renderStaffQueue()`);
}

test('a refresh comes back to the current session, keeping the view and status filter', async ({ page }) => {
  await openStaff(page, sessions);
  expect(await page.evaluate('S.sfSession')).toBe(today);                       // tonight by default
  await page.evaluate(`setSfSession('${S2}');S.queueView='managed';renderStaffQueue();setSfStatus('waiting')`);
  await page.reload();
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');renderStaffQueue()`);
  expect(await page.evaluate('[S.sfSession, S.queueView, S.sfStatus]')).toEqual([today, 'managed', 'waiting']);
});

test('a session saved by an older build is ignored', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('cq_queue_view', JSON.stringify({ sfSession: 'gone-2050-01-01', queueView: 'bookings', sfStatus: 'all' })));
  await openStaff(page, sessions);
  expect(await page.evaluate('S.sfSession')).toBe(today);
});

test('a pick holds while on the queue, and leaving and coming back resets it', async ({ page }) => {
  await openStaff(page, sessions);
  await page.evaluate(`setSfSession('${S2}')`);
  await page.evaluate(`renderStaffQueue();setStaffTab('queue')`);                 // repaints and a re-tap keep it
  expect(await page.evaluate('S.sfSession')).toBe(S2);
  await page.evaluate(`setStaffTab('cashier');setStaffTab('queue')`);
  expect(await page.evaluate('S.sfSession')).toBe(today);
});

test('no ride tonight: the latest ride up to today, even closed, not the next open one', async ({ page }) => {
  const past = [
    { id: daysAgo(8), day: 'Sunday', session_date: daysAgo(8), capacity: 20, status: 'closed', created_at: 1 },
    { id: daysAgo(1), day: 'Monday', session_date: daysAgo(1), capacity: 20, status: 'closed', created_at: 2 },
    { id: S2, day: 'Tuesday', session_date: S2, capacity: 20, status: 'open', created_at: 3 },
  ];
  await openStaff(page, past);
  expect(await page.evaluate('S.sfSession')).toBe(daysAgo(1));
});

test('nothing has run yet: the next live ride; no rides at all: All sessions', async ({ page }) => {
  await openStaff(page, [
    { id: '2099-02-03', day: 'Tuesday', session_date: '2099-02-03', capacity: 20, status: 'open', created_at: 2 },
    { id: S2, day: 'Tuesday', session_date: S2, capacity: 20, status: 'open', created_at: 1 },
  ]);
  expect(await page.evaluate('S.sfSession')).toBe(S2);
  expect(await page.evaluate(`S.sessions=[];_currentSessId()`)).toBe('all');
});

test('tonight\'s closed ride still beats an earlier one; a deleted one never counts', async ({ page }) => {
  await openStaff(page, [
    { id: daysAgo(2), day: 'Sunday', session_date: daysAgo(2), capacity: 20, status: 'closed', created_at: 1 },
    { id: today, day: 'Today', session_date: today, capacity: 20, status: 'closed', created_at: 2 },
    { id: today + '-x', day: 'Today', session_date: today, capacity: 20, status: 'deleted', created_at: 3 },
  ]);
  expect(await page.evaluate('S.sfSession')).toBe(today);
});
