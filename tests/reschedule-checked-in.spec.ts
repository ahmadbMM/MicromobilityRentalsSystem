import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A booking can be moved to another ride whatever its state (2026-09-28). A checked-in rider is
// taken off their bike first - the Undo check-in write: the row guarded on still being on the
// bike, the bike back on the rack - and lands in line on the new ride; what they paid stays paid
// at its price. Reschedule sits in the row menu of every open booking and opens the editor on
// its Session field. Undo puts the rider back on the old ride, then back on the bike.
const D0 = '2099-02-08', D1 = '2099-02-15';
const sess = (id: string, date: string) => ({
  id, day: 'Sunday', session_date: date, capacity: 9, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 9 }), location: 'JCC', addons: null,
});
const sessions = [sess('s0', D0), sess('s1', D1)];
const bikes = [{ id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'in-use', rental_price: 57.5 }];
const rider = (id: string, qn: number, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Sunday', session_date: D0, queue_num: qn, name: `Rider ${id}`,
  type_preference: 'Hybrid', size: 'M', status, paid: false, price: 30, registered_at: '2099-01-01T10:00:00Z', ...extra,
});
const MOVER = 'mover';
const rows = () => [
  rider(MOVER, 1, 'active', { paid: true, assigned_bike_id: 'b1', checked_in_at: '2099-02-08T18:00:00Z' }),
  rider('w2', 2, 'waiting', { paid: true }),
];

async function boot(page: Page) {
  const q = rows();
  await stubSupabase(page, { sessions, bikes, queue_entries: q });
  // The stub echoes writes without keeping them: keep them, as the database would, so the reload
  // after a save reads the row where it was moved to.
  await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
    const r = route.request();
    if (r.method() === 'PATCH') {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      const row = q.find((x) => x.id === id);
      if (row) Object.assign(row, body);
    }
    return route.fallback();
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
}
function watchWrites(page: Page) {
  const writes: Array<{ table: string; url: string; body: Record<string, unknown> }> = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/(queue_entries|bikes)\b/);
    if (r.method() === 'PATCH' && m) {
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      writes.push({ table: m[1], url: r.url(), body });
    }
  });
  return writes;
}

test('a checked-in, paid rider is moved: off the bike, in line on the new ride, still paid at their price - and Undo brings them back', async ({ page }) => {
  await boot(page);
  const writes = watchWrites(page);
  await page.evaluate(`showBookingEditModal('${MOVER}')`);
  const modal = page.locator('#booking-edit-modal [role="dialog"]');
  await expect(modal.locator('#be-sess')).toBeVisible(); // used to be hidden for a checked-in rider
  await expect(modal.locator('#be-move-note')).toContainText('takes them off their bike');
  await page.evaluate(`document.getElementById('be-sess').value='s1';saveBookingEdit()`);
  await expect(page.locator('#topbar-right .undo-btn')).toBeVisible(); // an undoable edit: the topbar's Undo, no bar

  const q = writes.filter((w) => w.table === 'queue_entries');
  // Off the bike first, guarded on still being on it; the bike back on the rack; the stamp
  // cleared; then the move, as a waiting rider with a fresh number - and never a price or paid.
  expect(q[0].url).toContain('status=eq.active');
  expect(q[0].body).toEqual({ status: 'waiting', assigned_bike_id: null });
  expect(writes.find((w) => w.table === 'bikes')?.body).toEqual({ status: 'available' });
  expect(q.some((w) => 'checked_in_at' in w.body && w.body.checked_in_at === null)).toBe(true);
  const move = q.find((w) => w.body.session_id === 's1');
  expect(move?.body).toMatchObject({ status: 'waiting', session_date: D1 });
  expect(typeof move?.body.queue_num).toBe('number');
  expect(q.some((w) => 'price' in w.body || 'paid' in w.body)).toBe(false);
  const after = await page.evaluate(`(()=>{const e=getQueue().find(x=>x.id==='${MOVER}');return {s:e.sessionId,st:e.status,p:e.paid,pr:e.price};})()`);
  expect(after).toEqual({ s: 's1', st: 'waiting', p: true, pr: 30 });

  await page.locator('#topbar-right .undo-btn').click();
  const qe = () => writes.filter((w) => w.table === 'queue_entries');
  await expect.poll(() => qe().some((w) => w.body.session_id === 's0' && w.body.status === 'waiting')).toBe(true); // back on the old ride, in line
  await expect.poll(() => qe().some((w) => w.body.status === 'active' && w.body.assigned_bike_id === 'b1')).toBe(true); // then back on the bike
});

test('Reschedule is in the row menu of a checked-in rider and opens the editor on the Session field', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='s0';renderStaffQueue()`);
  await page.waitForTimeout(250);
  const row = page.locator('#tab-queue').locator('tr, .q-card').filter({ hasText: 'Rider mover' }).filter({ visible: true }).first();
  await row.getByRole('button', { name: /More actions/ }).click();
  await page.waitForTimeout(150); // let the just-positioned menu settle before clicking into it
  const menu = page.locator('.pay-menu-popup');
  await expect(menu.getByRole('menuitem', { name: /Undo Check-in/i })).toBeVisible(); // the checked-in row's menu
  await menu.getByRole('menuitem', { name: 'Reschedule' }).click();
  await expect.poll(() => page.evaluate('S._beId')).toBe(MOVER);
  await expect.poll(() => page.evaluate('document.activeElement&&document.activeElement.id')).toBe('be-sess');
});

test('a paid rider still in line is told their payment travels with them', async ({ page }) => {
  await boot(page);
  await page.evaluate(`showBookingEditModal('w2')`);
  const modal = page.locator('#booking-edit-modal [role="dialog"]');
  await expect(modal.locator('#be-sess')).toBeVisible();
  await expect(modal.locator('#be-move-note')).toHaveText('What they paid stays paid on the new ride.');
});
