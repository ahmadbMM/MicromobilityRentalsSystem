import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// Bug hunt 2026-10-07 (booking pay cells to the ticket's logo): the fixes that a spec can hold.

type Page = import('@playwright/test').Page;
const D = '2099-02-08';
const S1 = '2099-02-01';

test.describe('@staff:bookings the desk', () => {
  const sessions = [{ id: 's0', day: 'Sunday', session_date: D, capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null }];
  const qe = (id: string, num: number, extra: Record<string, unknown>) => ({
    id, session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: num, name: `Rider ${num}`,
    phone: `05000000${num}`, type_preference: 'Hybrid', registered_at: '2099-01-01T10:00:00Z', paid: false, price: 60, ...extra,
  });
  const queue_entries = [
    qe('e1', 1, { status: 'waiting', customer_id: 'cp' }),
    qe('e2', 2, { status: 'waiting', customer_id: 'cp' }),
  ];
  const desk_waitlist = [
    { id: 'w1', name: 'Rider 1', status: 'waiting', booking_id: 'e1', kind: 'managed', created_at: '2099-01-01T10:00:00Z' },
    { id: 'w2', name: 'Rider 2', status: 'waiting', booking_id: 'e2', kind: 'managed', created_at: '2099-01-01T10:00:01Z' },
  ];
  async function boot(page: Page) {
    await stubSupabase(page, { sessions, queue_entries, desk_waitlist });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goStaff()');
  }

  test('a role without Bookings is not offered bookings in the search or the bell', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`S.staffRole='admin';_gsHits('Rider').map(h=>h.k)`)).toContain('gsKindBooking');
    expect(await page.evaluate(`_ntKindsNow().some(x=>x.k==='long')`)).toBe(true);
    // a mechanic's sections are Inventory and Workshop: a booking picked there led to nothing
    expect(await page.evaluate(`S.staffRole='mechanic';_gsHits('Rider').map(h=>h.k)`)).not.toContain('gsKindBooking');
    expect(await page.evaluate(`_ntKindsNow().some(x=>x.k==='long')`)).toBe(false);
  });

  test('a walk-up handed a bike is never booked onto a ride without bikes, nor shown a bike type there', async ({ page }) => {
    const run = { id: `${D}-rh`, session_date: D, day: 'Sunday', status: 'open', capacity: 80, created_at: 2, event_kind: 'community',
      ride_kind: 'runher', needs_approval: false, paid_ride: false, location: 'JYC', bike_slots: '{"_time":"06:00 - 06:30"}' };
    await stubSupabase(page, { sessions: [...sessions, run], queue_entries: [qe('r1', 1, { status: 'waitlist', session_id: run.id, type_preference: 'None', waitlist_num: 1 })],
      desk_waitlist: [{ id: 'wr', name: 'Rider 1', status: 'waiting', booking_id: 'r1', kind: 'managed', created_at: '2099-01-01T10:00:00Z' }] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goStaff()');
    expect(await page.evaluate('_wlOpenSess().map(s=>s.id)')).toEqual(['s0']);
    expect(await page.evaluate(`_mwTypeCell(_wlRowById('wr'),_qGet('r1'))`)).toBe('');
  });

  test('a party checked in from the Staff List can be undone, like the roster\'s bulk check-in', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.staffRole='admin';mwPartyCheckin('w1')`);
    await expect.poll(() => page.evaluate(`(S.undoStack[S.undoStack.length-1]||{}).label||''`)).toMatch(/Undo Check-in · 2/);
  });
});

test.describe('@customer:reserve the booking form', () => {
  const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 10, created_at: 1,
    bike_slots: '{"_time":"21:00 - 23:00","_total":10}', addons: ['inv1'] }];
  const WATER = { id: 'inv1', name: 'Water', qty: 50, price: 5, category: 'Beverages' };
  async function boot(page: Page) {
    await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [], inventory: [WATER] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await waitForSb(page);
  }

  test('co-riders are booked under the names the review showed', async ({ page }) => {
    await boot(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(`S.selEvent='jcc';S.selSession='${S1}';S.regQty=2;S.regBikeHeights=['175','170'];S.regBikeTypes=['Road','Road'];
      S.regRiderNames=['spec rider','friend  two'];S.promoApplied=null;S.waiverOk=true;S._waiverSess='${S1}';submitReg()`);
    await expect.poll(() => rows.length).toBe(2);
    expect(rows.map((r) => r.name)).toEqual(['Spec Rider', 'Friend Two']);
  });

  test('an add-on\'s "+" stops at 20, where the booking stops counting', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.inventory=[{id:'inv1',name:'Water',qty:50,price:5,category:'Beverages'}];
      S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';S.regQty=1;S.regBikeHeights=['175'];S.regBikeTypes=['Road'];
      S.regRiderNames=[undefined];S.regAddons=[{id:'inv1',qty:19}];S.regStep=3;renderRegister()`);
    await expect(page.locator('#reg-ad-inc-inv1')).toBeEnabled();
    await page.evaluate(`_setRegAddonQty('inv1',1)`);
    await expect(page.locator('#reg-ad-inc-inv1')).toBeDisabled();
  });
});
