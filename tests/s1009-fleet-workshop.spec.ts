import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// 2026-10-09 (M13): Take payment puts a workshop job's price into the till on the cashier path
// (category workshop, receipt ws.<job>.*), parts come from the stock (workshop_part movements), a
// mechanic is set per job, a report gives open jobs, turnaround and parts waits, and Analytics
// shows the workshop's takings.

const job = (o: Record<string, unknown> = {}) => ({
  id: 42, created_at: '2026-10-01T09:30:00Z', customer_id: null, name: 'Sara Ali', phone: '+966551234567', email: null,
  service: 'full-service', service_label: 'Full service', price_quoted: 409, parts: [], lane: 'dropoff', pickup_address: null,
  preferred_date: null, preferred_time: null, bike: null, notes: null, lang: 'en', status: 'ready', scheduled_for: null,
  price_final: 350, staff_notes: null, updated_at: '2026-10-03T09:30:00Z', updated_by: 'Desk', mechanic: null, parts_used: [],
  paid_at: null, paid_receipt: null, ...o,
});
type Call = { name: string; method: string; url: string; body: unknown };
async function open(page: Page, fixtures: Fixtures = {}) {
  await stubSupabase(page, { workshop_jobs: [job()], workshop_job_events: [], inventory: [{ id: 'pads', name: 'Brake pads', category: 'Accessory', qty: 5, price: 60, cost: 25, low_threshold: 1 }], ...fixtures });
  await unlockStaff(page);
  const calls: Call[] = [];
  page.on('request', (r) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(r.method())) return;
    const m = r.url().match(/\/rest\/v1\/(?:rpc\/)?([a-z_]+)(\?|$)/);
    let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
    if (m) calls.push({ name: m[1], method: r.method(), url: decodeURIComponent(r.url()), body });
  });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.inventory||[]).length>0');
  await page.evaluate("setStaffTab('workshop')");
  await page.waitForFunction("!!(S._ws&&S._ws.jobs)");
  await page.evaluate("_wsSetFilter('all')");
  return calls;
}
const row = (page: Page) => page.locator('.ws-row[data-ws-id="42"]');

test.describe('@staff:workshop money, parts and mechanic', () => {
  test('Take payment rings the final price into the till as a workshop sale and marks the job paid', async ({ page }) => {
    const calls = await open(page);
    await row(page).getByRole('button', { name: 'Take payment' }).click();
    const d = page.locator('#confirm-modal .ws-dlg');
    await expect(d.locator('#ws-pa')).toHaveValue('350');
    await d.locator('#ws-pm').selectOption('card');
    await d.getByRole('button', { name: 'Take payment' }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'cashier_sales').length).toBe(2);
    const sale = calls.map((c) => c.body as Record<string, unknown>).find((b) => b && b.category === 'workshop')!;
    expect(sale).toMatchObject({ category: 'workshop', qty: 1, price: 350, pay: 'paid', customer_name: 'Sara Ali' });
    expect(String(sale.receipt_id)).toMatch(/^ws\.42\./);
    expect(calls.map((c) => c.body as Record<string, unknown>).find((b) => b && b.category === '__cardmeta__')).toMatchObject({ price: 350 });
    await expect.poll(() => (calls.find((c) => c.name === 'workshop_jobs')?.body as Record<string, unknown>)?.paid_receipt).toBe(sale.receipt_id);
    await expect(row(page).getByRole('button', { name: 'Take payment' })).toHaveCount(0);
  });

  test('a part from stock is a workshop_part movement and adds its price', async ({ page }) => {
    const calls = await open(page, { 'rpc:staff_inventory_move': { ok: true, qty: 3, move_id: 12 } });
    await row(page).getByRole('button', { name: 'Add part' }).click();
    const d = page.locator('#confirm-modal .ws-dlg');
    await d.locator('#ws-pi').selectOption('pads');
    await d.locator('#ws-pq').fill('2');
    await d.getByRole('button', { name: 'Add part' }).click();
    await expect.poll(() => calls.find((c) => c.name === 'staff_inventory_move')?.body).toMatchObject({ p_item: 'pads', p_delta: -2, p_reason: 'workshop_part', p_ref: 'ws:42' });
    await expect.poll(() => calls.find((c) => c.name === 'workshop_jobs')?.body).toMatchObject({ price_final: 470, parts_used: [{ id: 'pads', name: 'Brake pads', qty: 2, cost: 25, price: 60 }] });
  });

  test('the mechanic is saved as letters and spaces', async ({ page }) => {
    const calls = await open(page);
    await row(page).getByRole('button', { name: 'Mechanic' }).click();
    await page.locator('#ws-me').fill('Omar Al-Saud');
    await page.locator('#confirm-modal .ws-dlg').getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => calls.find((c) => c.name === 'workshop_jobs')?.body).toMatchObject({ mechanic: 'Omar Al Saud' });
  });

  test('the report gives open jobs, the average turnaround and how long parts have been awaited', async ({ page }) => {
    await open(page, {
      workshop_jobs: [job({ id: 42, status: 'completed' }), job({ id: 43, status: 'awaiting_parts', created_at: '2026-10-02T09:00:00Z' })],
      workshop_job_events: [{ job_id: 42, at: '2026-10-04T09:30:00Z', status: 'completed' }],
    });
    await page.getByRole('button', { name: 'Reports' }).click();
    const d = page.locator('#confirm-modal .ws-dlg');
    await expect(d.locator('.flx-sum')).toContainText('3 days');
    await expect(d).toContainText('W-0043');
  });

  test('Analytics shows the workshop takings', async ({ page }) => {
    const day = new Date(Date.now() - 864e5 + 3 * 3600e3).toISOString().slice(0, 10);
    await open(page, {
      sessions: [{ id: 's1', day: 'Friday', session_date: day, capacity: 12, status: 'open', created_at: 1 }],
      queue_entries: [{ id: 'q1', session_id: 's1', session_day: 'Friday', session_date: day, queue_num: 1, name: 'Rider One', status: 'done', paid: true, price: 30, registered_at: `${day}T10:00:00Z`, type_preference: 'Road', size: 'M' }],
      cashier_sales: [{ id: 'x1', receipt_id: 'ws.42.ab', session_id: null, name: 'Workshop W-0042', category: 'workshop', qty: 1, price: 350, pay: 'paid', created_at: new Date().toISOString() }],
    });
    await page.waitForFunction("(S.cashSales||[]).length>0");
    await page.evaluate("setStaffTab('analytics');setAnView('revenue')");
    await expect(page.locator('.an-ws-card')).toContainText('350');
  });

  test('a database without the new columns: the list still loads, without the mechanic and parts buttons', async ({ page }) => {
    await stubSupabase(page, { workshop_jobs: [job()], inventory: [] });
    await page.route(/\/rest\/v1\/workshop_jobs\?.*mechanic/, (r) => r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42703', message: 'column workshop_jobs.mechanic does not exist' }) }));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate("setStaffTab('workshop');_wsSetFilter('all')");
    await expect(row(page)).toBeVisible();
    await expect(row(page).getByRole('button', { name: 'Mechanic' })).toHaveCount(0);
    await expect(row(page).getByRole('button', { name: 'Take payment' })).toHaveCount(1);
  });
});
