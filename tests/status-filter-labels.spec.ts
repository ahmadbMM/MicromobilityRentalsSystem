import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Bookings status filter should use the same wording as the stat boxes:
// Expected (waiting), On Bike (active), Completed (done).
test('status filter labels match the dashboard boxes', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }],
    queue_entries: [{ id: 'q1', name: 'R', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 1, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-09T10:00:00Z' }],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const opts = await page.evaluate(`[...document.querySelectorAll('#tab-queue .filter-select')].flatMap(s=>[...s.options].map(o=>o.textContent))`);
  const set = new Set(opts as string[]);
  expect(set.has('Expected')).toBe(true);   // was "Waiting"
  expect(set.has('Completed')).toBe(true);  // was "Done"
  expect(set.has('On Bike')).toBe(true);
  expect(set.has('Waiting')).toBe(false);   // old label gone
  expect(set.has('Done')).toBe(false);
  // filtering by value still works
  await page.evaluate(`setSfStatus('done')`);
  expect(await page.evaluate('S.sfStatus')).toBe('done');
});

// Reserved: a waiting rider with a bike held for them. Its own option in the status filter,
// its own badge and its own colour, apart from plain Waiting.
test('reserved is a status of its own: filter, badge, row colour', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }],
    bikes: [{ id: 'b1', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: [] }],
    queue_entries: [
      { id: 'q1', name: 'Plain Waiting', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 1, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-09T10:00:00Z', type_preference: 'Road', size: 'M' },
      { id: 'q2', name: 'Bike Held', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 2, status: 'waiting', paid: true, price: 30, registered_at: '2099-01-09T10:00:00Z', type_preference: 'Road', size: 'M', assigned_bike_id: 'b1' },
    ],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='s1';renderStaffQueue()`);
  const opts = await page.evaluate(`[...document.querySelectorAll('#tab-queue .filter-select')].flatMap(s=>[...s.options].map(o=>o.value))`) as string[];
  expect(opts).toContain('reserved');
  const held = page.locator('.queue-table tbody tr, .q-card').filter({ hasText: 'Bike Held' });
  await expect(held).toHaveClass(/row-reserved/);
  await expect(held.locator('.status-badge')).toHaveText('Reserved');
  const plain = page.locator('.queue-table tbody tr, .q-card').filter({ hasText: 'Plain Waiting' });
  await expect(plain).not.toHaveClass(/row-reserved/);
  await expect(plain.locator('.status-badge')).toHaveText('Waiting');
  await page.evaluate(`setSfStatus('reserved')`);
  await expect(page.locator('.queue-table tbody tr, .q-card').filter({ hasText: 'Plain Waiting' })).toHaveCount(0);
  await expect(page.locator('.queue-table tbody tr, .q-card').filter({ hasText: 'Bike Held' })).toHaveCount(1);
});

// To be reserved: a staff mark for a bike to be held, before one is chosen. Its own badge,
// colour and filter option; set and cleared from the row's ⋯ menu; a held bike clears it.
test('to be reserved: menu toggle, badge, filter, and a held bike clears it', async ({ page }) => {
  const rows: Record<string, unknown>[] = [
    { id: 'q1', name: 'Marked One', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 1, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-09T10:00:00Z', type_preference: 'Road', size: 'M', to_reserve: true },
    { id: 'q2', name: 'Plain Two', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 2, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-09T10:00:00Z', type_preference: 'Road', size: 'M' },
  ];
  await stubSupabase(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }],
    bikes: [{ id: 'b1', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: [] }],
    queue_entries: rows,
  });
  await page.route(/\/rest\/v1\/queue_entries\?.*id=eq\.(q1|q2)/, async (route) => {
    if (route.request().method() === 'PATCH') {
      const id = (route.request().url().match(/id=eq\.(q[12])/) || [])[1]; const b = JSON.parse(route.request().postData() || '{}');
      const r = rows.find(x => x.id === id)!; if ('to_reserve' in b) r.to_reserve = b.to_reserve; if ('assigned_bike_id' in b) r.assigned_bike_id = b.assigned_bike_id;
    }
    await route.fallback();
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='s1';renderStaffQueue()`);
  const marked = page.locator('.queue-table tbody tr, .q-card').filter({ hasText: 'Marked One' });
  await expect(marked).toHaveClass(/row-toreserve/);
  await expect(marked.locator('.status-badge')).toHaveText('To be reserved');
  expect(await page.evaluate(`((S._rowMenus||{})['q1']||[]).map(i=>i.run).join('|')`)).toContain("_toggleToReserve('q1')");
  expect(await page.evaluate(`[...document.querySelectorAll('#tab-queue .filter-select')].flatMap(s=>[...s.options].map(o=>o.value))`)).toContain('toreserve');
  // the plain rider gets marked from the menu
  await page.evaluate(`_toggleToReserve('q2')`);
  await expect(page.locator('.queue-table tbody tr, .q-card').filter({ hasText: 'Plain Two' }).locator('.status-badge')).toHaveText('To be reserved');
  // the filter shows only the marked ones
  await page.evaluate(`setSfStatus('toreserve')`);
  await expect(page.locator('.queue-table tbody tr:has(.rider-name), .q-card:has(.rider-name)')).toHaveCount(2);
  await page.evaluate(`setSfStatus('all')`);
  // holding a bike for the marked rider answers the mark: Reserved now, the flag cleared
  const patches: string[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && /id=eq\.q1/.test(r.url())) patches.push(r.postData() || ''); });
  await page.evaluate(`_reserveFromMenu('q1');reserveBike()`);
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  expect(JSON.parse(patches[0])).toEqual({ assigned_bike_id: 'b1', to_reserve: false });
  await expect(marked.locator('.status-badge')).toHaveText('Reserved');
});

