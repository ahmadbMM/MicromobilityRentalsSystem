import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// 2026-10-09 (M12): the maintenance log on a bike's profile (bike_service_log) - what was done,
// parts from the stock (each a maintenance_part movement), labour, downtime, the mechanic and the
// bike's total - a service stamps the bike serviced, and service falls due by days as well as rides.

const BIKE = { id: 'b1', name: 'Road 012', bike_number: 12, type: 'Road', size: 'L', status: 'maintenance', retired_date: '2026-10-01', colors: [], color_names: [], last_serviced_at: null, in_service_date: '2026-09-01' };
const INV = [{ id: 'tube', name: 'Inner tube 700c', category: 'Accessory', qty: 8, price: 25, cost: 11.5, low_threshold: 2 }];
const LOG = [
  { id: 2, bike_id: 'b1', at: '2026-10-05T12:00:00+03:00', kind: 'repair', work: 'New rear brake pads', parts: [{ id: 'tube', name: 'Inner tube 700c', qty: 1, cost: 11.5 }], parts_cost: 11.5, labour_cost: 40, down_from: '2026-10-04T10:00:00+03:00', down_to: '2026-10-05T10:00:00+03:00', mechanic: 'Omar', by_name: 'Desk' },
  { id: 1, bike_id: 'b1', at: '2026-09-20T12:00:00+03:00', kind: 'inspection', work: 'Checked over', parts: [], parts_cost: 0, labour_cost: 0, down_from: null, down_to: null, mechanic: null, by_name: 'Desk' },
];

type Call = { kind: 'rpc' | 'write'; name: string; method: string; url: string; body: Record<string, unknown> | Record<string, unknown>[] };
async function open(page: Page, fixtures: Fixtures) {
  await stubSupabase(page, { bikes: [BIKE], inventory: INV, ...fixtures });
  await unlockStaff(page);
  const calls: Call[] = [];
  page.on('request', (r) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(r.method())) return;
    const rpc = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/), tbl = r.url().match(/\/rest\/v1\/([a-z_]+)(\?|$)/);
    let body = {}; try { body = r.postDataJSON(); } catch { /* none */ }
    if (rpc) calls.push({ kind: 'rpc', name: rpc[1], method: r.method(), url: r.url(), body });
    else if (tbl) calls.push({ kind: 'write', name: tbl[1], method: r.method(), url: decodeURIComponent(r.url()), body });
  });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getBikes().length>0 && (S.inventory||[]).length>0');
  return calls;
}

test.describe('@staff:bikes maintenance log', () => {
  test('the profile lists the log with the bike\'s total cost and downtime', async ({ page }) => {
    await open(page, { bike_service_log: LOG });
    await page.evaluate("openBikeProfile('b1')");
    const fl = page.locator('#bp-fleet');
    await expect(fl.locator('.flx-log')).toHaveCount(2);
    await expect(fl.locator('.flx-log').first()).toContainText('Repair');
    await expect(fl.locator('.flx-log').first()).toContainText('New rear brake pads');
    await expect(fl.locator('.flx-log').first()).toContainText('Inner tube 700c ×1');
    await expect(fl.locator('.flx-log').first()).toContainText('Omar');
    await expect(fl.locator('.flx-sum')).toContainText('51.5'); // 11.5 parts + 40 labour
    await expect(fl.locator('.flx-sum')).toContainText('24 h');
  });

  test('an entry with a part from stock: the log row, a maintenance_part movement, and the bike back in service', async ({ page }) => {
    const calls = await open(page, { 'rpc:staff_inventory_move': { ok: true, qty: 6, move_id: 77 } });
    await page.evaluate("openBikeProfile('b1')");
    await page.locator('#bp-fleet').getByRole('button', { name: /Add entry/ }).click();
    const d = page.locator('#confirm-modal .ws-dlg');
    await expect(d).toHaveAttribute('role', 'dialog');
    await d.locator('#svc-work').fill('Two new tubes, trued the rear wheel');
    await d.getByRole('button', { name: /Add part/ }).click();
    await d.locator('#svc-pi-0').selectOption('tube');
    await d.locator('#svc-pq-0').fill('2');
    await d.locator('#svc-labour').fill('35');
    await d.locator('#svc-mech').fill('Omar Al-Saud');
    await expect(d.locator('#svc-back')).toBeChecked(); // a bike in maintenance offers to go back
    await d.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => calls.find((c) => c.name === 'bike_service_log')?.body).toBeTruthy();
    const row = calls.find((c) => c.name === 'bike_service_log')!.body as Record<string, unknown>;
    expect(row).toMatchObject({ bike_id: 'b1', kind: 'service', work: 'Two new tubes, trued the rear wheel', parts_cost: 23, labour_cost: 35, mechanic: 'Omar Al Saud' });
    expect(row.parts).toEqual([{ id: 'tube', name: 'Inner tube 700c', qty: 2, cost: 11.5 }]);
    await expect.poll(() => calls.find((c) => c.name === 'staff_inventory_move')?.body).toMatchObject({ p_item: 'tube', p_delta: -2, p_reason: 'maintenance_part' });
    await expect.poll(() => calls.find((c) => c.name === 'bikes')?.body).toMatchObject({ status: 'available', retired_date: null });
    expect((calls.find((c) => c.name === 'bikes')!.body as Record<string, unknown>).last_serviced_at).toBeTruthy();
  });

  test('nothing done and no part is refused in the dialog', async ({ page }) => {
    const calls = await open(page, {});
    await page.evaluate("openBikeProfile('b1')");
    await page.locator('#bp-fleet').getByRole('button', { name: /Add entry/ }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#ws-dlg-err')).toContainText('Say what was done');
    expect(calls.filter((c) => c.name === 'bike_service_log')).toEqual([]);
  });

  test('service falls due by days as well as rides (service_every_days)', async ({ page }) => {
    const old = new Date(Date.now() - 40 * 864e5).toISOString();
    await open(page, { bikes: [{ ...BIKE, status: 'available', retired_date: null, last_serviced_at: old }], staff_options: [{ key: 'service_every_days', items: [30] }] });
    await page.evaluate("setStaffTab('inventory');setInvSection('bikes')");
    await expect(page.locator('.bk-attn-row[data-bike="b1"]')).toContainText('Service due · 40 days');
  });

  test('the maintenance report sums cost and downtime per bike', async ({ page }) => {
    await open(page, { bike_service_log: LOG });
    await page.evaluate("setStaffTab('inventory');setInvSection('bikes')");
    await page.getByRole('button', { name: 'Maintenance report' }).click();
    const d = page.locator('#confirm-modal .ws-dlg');
    await expect(d.locator('tbody tr')).toHaveCount(1);
    await expect(d.locator('tbody tr')).toContainText('Road 012');
    await expect(d.locator('tbody tr')).toContainText('51.5');
  });
});
