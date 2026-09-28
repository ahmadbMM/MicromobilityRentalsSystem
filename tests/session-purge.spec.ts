import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Deleted Sessions can be emptied for good (the owner, 2026-09-28). Only a session nothing points
// at goes: queue_entries and cashier_sales carry session_id with no foreign key, so a session with
// a booking or a sale on record - cancelled or refunded included - stays where it is.

const del = (id: string) => ({ id, session_date: id, day: 'Wednesday', status: 'deleted', capacity: 12, title: 'Pool ' + id, created_at: 1 });
const LIVE = { id: '2099-06-06', session_date: '2099-06-06', day: 'Saturday', status: 'open', capacity: 20, created_at: 1 };

async function boot(page: Page, fx: Record<string, Record<string, unknown>[]>) {
  const deletes: string[] = [];
  await stubSupabase(page, { bikes: [], ...fx });
  // The stub counts a whole table whatever the filter: count what points at the one session asked.
  await page.route(/\/rest\/v1\/(queue_entries|cashier_sales|rider_registrations)\?.*session_id=eq\./, (r) => {
    if (r.request().method() !== 'HEAD') return r.fallback();
    const u = new URL(r.request().url());
    const tb = u.pathname.split('/').pop() as string;
    const sid = (u.searchParams.get('session_id') || '').replace(/^eq\./, '');
    const n = (fx[tb] || []).filter((x) => x.session_id === sid).length;
    return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', 'content-range': `*/${n}` }, body: '' });
  });
  // A DELETE answers with the rows it removed, and the next load no longer has them.
  await page.route(/\/rest\/v1\/sessions\?/, (r) => {
    if (r.request().method() !== 'DELETE') return r.fallback();
    const u = new URL(r.request().url());
    deletes.push(u.search);
    const id = (u.searchParams.get('id') || '').replace(/^eq\./, '');
    const i = fx.sessions.findIndex((x) => x.id === id && x.status === 'deleted');
    const gone = i < 0 ? [] : fx.sessions.splice(i, 1); // in place: the stub holds this same array
    return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(gone.map((x) => ({ id: x.id }))) });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';S.showDeletedSess=true;renderStaffQueue()`);
  return deletes;
}
const confirm = (page: Page, label: string) => page.locator('#confirm-modal button', { hasText: label }).click();

test('a deleted session with nothing on record is deleted for good', async ({ page }) => {
  const fx = { sessions: [LIVE, del('2026-10-01')], queue_entries: [] as Record<string, unknown>[] };
  const deletes = await boot(page, fx);
  const row = page.locator('#tab-queue tr', { hasText: 'Oct' });
  await expect(page.locator('#tab-queue')).not.toContainText('Delete all permanently'); // one session: the row's own button
  await row.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.locator('#confirm-modal')).toContainText('cannot be restored');
  await confirm(page, 'Delete permanently');
  await expect(page.locator('#toast-container')).toContainText('Session deleted permanently.');
  expect(deletes).toHaveLength(1);
  expect(deletes[0]).toContain('id=eq.2026-10-01');
  expect(deletes[0]).toContain('status=eq.deleted'); // a session restored meanwhile is left alone
  await expect(page.locator('#tab-queue')).not.toContainText('Deleted Sessions');
});

test('a session with a cancelled booking on record stays in Deleted Sessions', async ({ page }) => {
  const fx = { sessions: [LIVE, del('2026-10-08')], queue_entries: [{ id: 'q1', session_id: '2026-10-08', session_date: '2026-10-08', queue_num: 1, name: 'R', status: 'cancelled', price: 75 }] };
  const deletes = await boot(page, fx);
  await page.locator('#tab-queue tr', { hasText: 'Oct' }).getByRole('button', { name: 'Delete permanently' }).click();
  await confirm(page, 'Delete permanently');
  await expect(page.locator('#toast-container')).toContainText('Kept in Deleted Sessions');
  expect(deletes).toHaveLength(0);
  await expect(page.locator('#tab-queue')).toContainText('Deleted Sessions (1)');
});

test('Delete all removes every clean one and keeps the one with a sale', async ({ page }) => {
  const fx = {
    sessions: [LIVE, del('2026-10-01'), del('2026-10-08'), del('2026-10-15')],
    queue_entries: [] as Record<string, unknown>[],
    cashier_sales: [{ id: 'x1', session_id: '2026-10-15', item_name: 'Water', qty: 1, price: 5, pay: 'refunded', created_at: '2026-09-01T10:00:00Z' }],
  };
  const deletes = await boot(page, fx);
  await page.getByRole('button', { name: 'Delete all permanently' }).click();
  await expect(page.locator('#confirm-modal')).toContainText('All 3 deleted sessions');
  await confirm(page, 'Delete all permanently');
  await expect(page.locator('#toast-container')).toContainText('Sessions deleted permanently: 2.');
  await expect(page.locator('#toast-container')).toContainText('Kept in Deleted Sessions: 1');
  expect(deletes.map((q) => new URLSearchParams(q).get('id'))).toEqual(['eq.2026-10-01', 'eq.2026-10-08']);
  await expect(page.locator('#tab-queue')).toContainText('Deleted Sessions (1)');
});
