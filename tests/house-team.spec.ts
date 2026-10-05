import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, checkinAsRow } from './helpers/supabase';

const fixtures = {
  sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }],
  bikes: [{ id: 'b1', name: 'Bike 1', size: 'M', type: 'Hybrid', status: 'available', rental_price: 50 }],
  queue_entries: [
    { id: 'qh', name: 'House Guest', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09',
      queue_num: 1, status: 'waiting', paid: true, price: 0, registered_at: '2099-01-09T10:00:00Z' }, // on the house
    { id: 'qp', name: 'Normal Rider', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09',
      queue_num: 2, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-09T10:01:00Z' },
  ],
  inventory: [{ id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 5, price: 8, low_threshold: 1 }],
};

// The picker's check-in is one staff_checkin call since 2026-10-05 (the direct writes are its
// fallback): checkinAsRow reads that call as the row it writes; a PATCH with the status covers the fallback.
function checkinRows(page: Page) {
  const rows: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    const row = checkinAsRow(r); if (row) { rows.push(row); return; }
    if (r.method() !== 'PATCH' || !/\/rest\/v1\/queue_entries/.test(r.url())) return;
    try { const b = r.postDataJSON(); if (b && b.status === 'active') rows.push(b); } catch { /* not JSON */ }
  });
  return rows;
}

test('checking in an on-the-house booking keeps it on the house (no reprice in the check-in)', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const patches = checkinRows(page);
  await page.evaluate(`openModal('qh'); S.modalBikes=['b1'];`);
  await page.evaluate('confirmAssign()');
  await expect.poll(() => patches.some((p) => p.status === 'active')).toBe(true);
  const checkin = patches.find((p) => p.status === 'active')!;
  expect(checkin.assigned_bike_id).toBe('b1');
  expect('price' in checkin).toBe(false); // was price:50 — flipped the house ride to a paid one
});

test('a normal booking still gets repriced from the assigned bike at check-in', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const patches = checkinRows(page);
  await page.evaluate(`openModal('qp'); S.modalBikes=['b1'];`);
  await page.evaluate('confirmAssign()');
  await expect.poll(() => patches.some((p) => p.status === 'active')).toBe(true);
  expect(patches.find((p) => p.status === 'active')!.price).toBe(57.5); // Hybrid's fare
});

test('MM Team sale lines carry no customer name (paid lines keep it)', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const inserts: Record<string, unknown>[] = [];
  await page.route(/\/rest\/v1\/cashier_sales/, async (route) => {
    if (route.request().method() === 'POST') {
      const b = route.request().postDataJSON();
      (Array.isArray(b) ? b : [b]).forEach((r: Record<string, unknown>) => inserts.push(r));
    }
    await route.fulfill({ status: 201, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' });
  });
  await page.evaluate(`
    S._ctSession='s1'; S._ctCust='Walk-up Wally';
    S._ctCart=[
      {item_id:'i1',name:'Gel',cat:'EnergyGels',qty:1,price:8,pay:'team',team:'Salem'},
      {item_id:'i1',name:'Gel',cat:'EnergyGels',qty:1,price:8,pay:'paid',team:''},
    ];
    _ctRecord();
  `);
  await expect.poll(() => inserts.length).toBeGreaterThanOrEqual(2);
  const team = inserts.find((r) => r.pay === 'team')!;
  const paid = inserts.find((r) => r.pay === 'paid')!;
  expect(team.customer_name).toBeNull();          // team consumption isn't a customer sale
  expect(team.team_name).toBe('Salem');
  expect(paid.customer_name).toBe('Walk-up Wally'); // normal lines keep the customer
});

test('a refunded receipt with a discount reports the NET amount refunded', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const out = await page.evaluate(`_salesTotals([
    { name:'Gel',  cat:'EnergyGels',   qty:2, price:10, pay:'refunded' },
    { name:'Disc', cat:'__discount__', qty:1, price:-5, pay:'refunded' },
    { name:'Gel',  cat:'EnergyGels',   qty:1, price:10, pay:'paid' },
  ])`) as { refunded: number; collected: number };
  expect(out.refunded).toBe(15); // 20 - 5 discount — Math.abs used to report 25
  expect(out.collected).toBe(10); // the live line is untouched
});

test('cancelled/no-show bookings do not count their add-ons as sold units', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const out = await page.evaluate(`(()=>{
    S.queue=[
      {id:'a',sessionId:'s1',status:'done',     addons:[{id:'i1',qty:2}]},
      {id:'b',sessionId:'s1',status:'waiting',  addons:[{id:'i1',qty:1}]},
      {id:'c',sessionId:'s1',status:'cancelled',addons:[{id:'i1',qty:5}]},
      {id:'d',sessionId:'s1',status:'noshow',   addons:[{id:'i1',qty:4}]},
    ];
    return _itemSoldUnits();
  })()`) as Record<string, number>;
  expect(out.i1).toBe(3); // done 2 + waiting 1; the restocked 9 from cancelled/noshow no longer inflate reorders
});
