import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// What a customer's open page costs the database. It used to join seven tables on the live
// channel (five of them staff-only, which never brought it an event but were still checked
// against every change), reload on every bike change at the desk, and ask for the staff-only
// lists on every load. The edge logs of 2026-09-24 show one phone reading the ride list 29
// times in 24 seconds.
const SID = '2099-04-03';
const sessions = [{ id: SID, day: 'Friday', session_date: SID, capacity: 12, status: 'open', created_at: 1 }];

/** The live channel's postgres_changes tables, per join, answered like stubRealtime does. */
async function captureJoins(page: Page) {
  const joins: { topic: string; tables: string[] }[] = [];
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    ws.onMessage((raw) => {
      let m: unknown;
      try { m = JSON.parse(String(raw)); } catch { return; }
      const arr = Array.isArray(m);
      const o = m as { join_ref?: unknown; ref?: unknown; topic?: unknown; event?: unknown; payload?: { config?: { postgres_changes?: { table: string }[] } } };
      const [join_ref, ref, topic, event, payload] = arr ? (m as unknown[]) as [unknown, unknown, unknown, unknown, typeof o.payload] : [o.join_ref, o.ref, o.topic, o.event, o.payload];
      if (ref == null) return;
      const bindings = event === 'phx_join' ? (payload?.config?.postgres_changes || []) : [];
      if (event === 'phx_join') joins.push({ topic: String(topic), tables: bindings.map((b) => b.table).sort() });
      const reply = { status: 'ok', response: event === 'phx_join' ? { postgres_changes: bindings.map((b, i) => ({ ...b, id: i + 1 })) } : {} };
      ws.send(JSON.stringify(arr ? [join_ref, ref, topic, 'phx_reply', reply] : { join_ref, ref, topic, event: 'phx_reply', payload: reply }));
    });
  });
  return joins;
}
const live = (joins: { topic: string; tables: string[] }[]) => joins.filter((j) => j.topic === 'realtime:mmcq-live').pop();

test("a customer's page joins the two tables its screens draw from; a staff device all nine", async ({ page, browser }) => {
  await stubSupabase(page, { sessions });
  const joins = await captureJoins(page);
  await page.goto('/');
  await waitForSb(page);
  await expect.poll(() => live(joins)?.tables.join()).toBe('bikes,sessions');

  const ctx = await browser.newContext();
  const staff = await ctx.newPage();
  await stubSupabase(staff, { sessions });
  const sj = await captureJoins(staff);
  await unlockStaff(staff);
  await staff.goto('/');
  await waitForSb(staff);
  await expect.poll(() => live(sj)?.tables.join())
    .toBe('bikes,cashier_sales,desk_waitlist,inventory,locker_rentals,lockers,queue_entries,rider_registrations,sessions'); // the lockers' two since 2026-11-09
  await ctx.close();
});

test('a customer device unlocked for staff rejoins with the staff tables', async ({ page }) => {
  await stubSupabase(page, { sessions });
  const joins = await captureJoins(page);
  await page.goto('/');
  await waitForSb(page);
  await expect.poll(() => live(joins)?.tables.join()).toBe('bikes,sessions');
  await page.evaluate(`goStaff()`);
  await expect.poll(() => live(joins)?.tables.length).toBe(9); // the lockers' two since 2026-11-09
});

test("a burst of events reloads a customer's page once, and leaves one reload for later", async ({ page }) => {
  await stubSupabase(page, { sessions });
  await page.goto('/');
  await waitForSb(page);
  const reads: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/rpc/list_sessions')) reads.push(r.url()); });
  await page.evaluate("window.__noWiden=false; S.view='landing'");
  for (let i = 0; i < 3; i++) {
    await page.evaluate(`_onRt({table:'sessions',eventType:'UPDATE',new:{id:'${SID}'},old:{id:'${SID}'}})`);
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(1500);
  expect(reads).toHaveLength(1);
  expect(await page.evaluate('_rtCustT!==null')).toBe(true); // the burst's last word is still coming
});

test("a bike change at the desk reloads nothing on a customer's page outside My Rides", async ({ page }) => {
  await stubSupabase(page, { sessions, bikes: [{ id: 'b1', name: 'B1', status: 'available', type: 'Road', size: 'M' }] });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  const reads: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/')) reads.push(r.url()); });
  await page.evaluate("window.__noWiden=false; S.view='customer'; S.custTab='register'");
  await page.evaluate("_onRt({table:'bikes',eventType:'UPDATE',new:{id:'b1',status:'active'},old:{id:'b1'}})");
  await page.waitForTimeout(1200);
  expect(reads).toEqual([]);
});

test("a customer's device in secure mode asks for none of the staff-only lists", async ({ page }) => {
  await stubSupabase(page, { sessions });
  await page.addInitScript(() => localStorage.setItem('cq_secure_auth', '1'));
  await loginCustomer(page);
  const gets: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/')) gets.push(decodeURIComponent(r.url())); });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForTimeout(800);
  await page.evaluate(`loadDataLight()`);
  await page.waitForTimeout(500);
  for (const t of ['cashier_sales', 'desk_waitlist', 'promo_codes', 'team_members']) {
    expect(gets.filter((u) => u.includes(`/rest/v1/${t}`)), t).toEqual([]);
  }
  expect(gets.filter((u) => u.includes('select=card_amount'))).toEqual([]);
  expect(gets.some((u) => u.includes('/rest/v1/queue_public'))).toBe(true); // it still reads what it draws
});

test('a staff device still reads them', async ({ page }) => {
  await stubSupabase(page, { sessions });
  await unlockStaff(page);
  const gets: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/')) gets.push(r.url()); });
  await page.goto('/');
  await waitForSb(page);
  for (const t of ['cashier_sales', 'desk_waitlist', 'promo_codes', 'team_members']) {
    expect(gets.some((u) => u.includes(`/rest/v1/${t}`)), t).toBe(true);
  }
});
