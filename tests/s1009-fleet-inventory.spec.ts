import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// 2026-10-09 (M9, M20): stock movements with a reason (inventory_moves through staff_inventory_move,
// _set_count and _receive), stock in at a unit cost with supplier and expiry, an "Expiring soon" list,
// the stock value by category, the stock list as CSV and a CSV import, and the reorder rule from the
// business settings. A database before migration 20261009170000 moves the count alone, as before.

const INV = [
  { id: 'gel', name: 'Energy gel', brand: 'Maurten', category: 'EnergyGels', qty: 10, price: 12, cost: 6, low_threshold: 4 },
  { id: 'bar', name: 'Protein bar', brand: 'Grenade', category: 'ProteinCookies', qty: 2, price: 9, cost: null, low_threshold: 5 },
];
type Call = { name: string; method: string; url: string; body: Record<string, unknown> };
async function open(page: Page, fixtures: Fixtures = {}) {
  await stubSupabase(page, { inventory: INV, ...fixtures });
  await unlockStaff(page);
  const calls: Call[] = [];
  page.on('request', (r) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(r.method())) return;
    const m = r.url().match(/\/rest\/v1\/(?:rpc\/)?([a-z_]+)(\?|$)/);
    let body = {}; try { body = r.postDataJSON(); } catch { /* none */ }
    if (m) calls.push({ name: m[1], method: r.method(), url: decodeURIComponent(r.url()), body });
  });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.inventory||[]).length>1');
  await page.evaluate("S.invView='table';setStaffTab('inventory');setInvSection('supplements')");
  return calls;
}
const EXTRAS = [{ id: 'gel', cost: 6, supplier: 'Desert Sports', expires_on: '2026-01-01' }, { id: 'bar', cost: null, supplier: null, expires_on: null }];

test.describe('@staff:inventory stock movements', () => {
  test('a + tap is a movement; the reason chips then say why', async ({ page }) => {
    const calls = await open(page, { 'rpc:staff_inventory_move': { ok: true, qty: 11, move_id: 501 } });
    await page.evaluate("adjInv('gel',1)");
    await expect.poll(() => calls.find((c) => c.name === 'staff_inventory_move')?.body).toMatchObject({ p_item: 'gel', p_delta: 1, p_reason: 'correction', p_by: 'Spec Staff' });
    const chips = page.locator('.flx-why');
    await expect(chips).toContainText('+1 - why?');
    await chips.getByRole('button', { name: 'Received' }).click();
    await expect.poll(() => calls.find((c) => c.name === 'inventory_moves')?.body).toEqual({ reason: 'received' });
    expect(calls.find((c) => c.name === 'inventory_moves')!.url).toContain('id=in.(501)');
    await expect(page.locator('.flx-why')).toHaveCount(0);
    expect(calls.filter((c) => c.name === 'inventory' && c.method === 'PATCH')).toEqual([]); // the function moved the count
  });

  test('before the migration a tap moves the count alone, read-and-compare, and asks nothing', async ({ page }) => {
    const calls = await open(page);
    await page.evaluate("adjInv('gel',-1)");
    await expect.poll(() => calls.find((c) => c.name === 'inventory' && c.method === 'PATCH')?.body).toMatchObject({ qty: 9 });
    await expect(page.locator('.flx-why')).toHaveCount(0);
  });

  test('a stock-take count goes through staff_inventory_set_count', async ({ page }) => {
    const calls = await open(page, { 'rpc:staff_inventory_set_count': { ok: true, qty: 7, was: 10, move_id: 9 } });
    await page.evaluate("toggleStockTake();S.invCounts={gel:'7'};applyStockTake()");
    await page.locator('#confirm-modal .btn-green').click();
    await expect.poll(() => calls.find((c) => c.name === 'staff_inventory_set_count')?.body).toMatchObject({ p_item: 'gel', p_count: 7 });
    expect(calls.filter((c) => c.name === 'inventory' && c.method === 'PATCH')).toEqual([]);
  });

  test('Receive: quantity, unit cost, supplier and expiry in one call', async ({ page }) => {
    const calls = await open(page, { 'rpc:staff_inventory_extras': EXTRAS, 'rpc:staff_inventory_receive': { ok: true, qty: 22, cost: 6.55, expires_on: '2026-01-01', move_id: 3 } });
    await expect(page.locator('#tab-inventory').getByRole('button', { name: 'History' }).first()).toBeVisible(); // the movements table is there
    await page.evaluate("_invRecvOpen('gel')");
    const d = page.locator('#confirm-modal .ws-dlg');
    await expect(d.locator('#rcv-s')).toHaveValue('Desert Sports');
    await d.locator('#rcv-q').fill('12');
    await d.locator('#rcv-c').fill('7');
    await d.locator('#rcv-e').fill('2027-03-31');
    await d.getByRole('button', { name: 'Receive stock' }).click();
    await expect.poll(() => calls.find((c) => c.name === 'staff_inventory_receive')?.body).toMatchObject({ p_item: 'gel', p_qty: 12, p_unit_cost: 7, p_supplier: 'Desert Sports', p_expires_on: '2027-03-31' });
    await expect.poll(() => page.evaluate("S.inventory.find(i=>i.id==='gel').cost")).toBe(6.55);
  });

  test('Receive on an older database: the count as a movement and the cost as a weighted average', async ({ page }) => {
    const calls = await open(page);
    await page.evaluate("_invRecvOpen('gel')");
    const d = page.locator('#confirm-modal .ws-dlg');
    await expect(d.locator('#rcv-s')).toHaveCount(0); // no supplier column yet
    await d.locator('#rcv-q').fill('10');
    await d.locator('#rcv-c').fill('8');
    await d.getByRole('button', { name: 'Receive stock' }).click();
    // 10 on the shelf at 6 + 10 in at 8 = 7 each
    await expect.poll(() => calls.filter((c) => c.name === 'inventory' && c.method === 'PATCH').map((c) => c.body)).toEqual([expect.objectContaining({ qty: 20 }), { cost: 7 }]);
  });

  test('Expiring soon lists what is past or near its date, and takes expired stock off as a movement', async ({ page }) => {
    const calls = await open(page, { 'rpc:staff_inventory_extras': EXTRAS, 'rpc:staff_inventory_move': { ok: true, qty: 0, move_id: 8 } });
    const card = page.locator('.flx-exp');
    await expect(card).toContainText('Energy gel');
    await expect(card).toContainText('Expired');
    await card.getByRole('button', { name: 'Remove expired' }).click();
    await page.locator('#confirm-modal .btn-red').click();
    await expect.poll(() => calls.find((c) => c.name === 'staff_inventory_move')?.body).toMatchObject({ p_item: 'gel', p_delta: -10, p_reason: 'expired' });
  });

  test('the reorder rule follows the business settings', async ({ page }) => {
    await open(page, { staff_options: [{ key: 'biz', items: { reorder_mult: 3, reorder_min: 2 } }] });
    // bar: 2 on the shelf, low at 5: max(5x3, 0 sold, 2) - 2 = 13
    expect(await page.evaluate("_invReorderNeed(2,5,0)")).toBe(13);
    await expect(page.locator('.iv-ro')).toContainText('+13');
  });
});

test.describe('@staff:inventory value, CSV out and in', () => {
  test('the stock value adds qty x cost by category and says what has no cost', async ({ page }) => {
    await open(page);
    await page.locator('#tab-inventory').getByRole('button', { name: 'Stock value' }).click();
    const d = page.locator('#confirm-modal .ws-dlg');
    await expect(d.locator('.flx-sum')).toContainText('60'); // 10 x 6
    await expect(d.locator('.flx-sum')).toContainText('1 item(s) on the shelf have no cost');
    const dl = page.waitForEvent('download');
    await d.getByRole('button', { name: /Export CSV/ }).click();
    const file = await dl;
    const text = await (await file.createReadStream()).toArray().then((b) => Buffer.concat(b as Buffer[]).toString('utf8'));
    expect(text).toContain('name,brand,category,qty,low_threshold,price,cost,supplier,expires_on,value');
    expect(text).toContain('Energy gel,Maurten,EnergyGels,10,4,12,6,,,60');
  });

  test('a CSV import updates a known item (price, and the count as a stock-take) and adds a new one', async ({ page }) => {
    const calls = await open(page);
    const csv = 'name,brand,qty,price,cost\nEnergy gel,Maurten,15,13,6.5\nElectrolyte tab,,20,8,3\n,,1,1,1\n';
    await page.locator('#tab-inventory input[type=file][accept*=csv]').setInputFiles({ name: 'stock.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    const d = page.locator('#confirm-modal');
    await expect(d).toContainText('Update');
    await expect(d).toContainText('New item');
    await expect(d).toContainText('No name');
    await d.locator('.btn-green').click();
    await expect.poll(() => calls.filter((c) => c.name === 'inventory').length).toBe(3);
    const w = calls.filter((c) => c.name === 'inventory');
    expect(w[0]).toMatchObject({ method: 'PATCH', body: { price: 13, cost: 6.5 } });
    expect(w[1]).toMatchObject({ method: 'PATCH', body: expect.objectContaining({ qty: 15 }) }); // the count, as a stock-take
    expect(w[2]).toMatchObject({ method: 'POST', body: expect.objectContaining({ name: 'Electrolyte tab', qty: 20, price: 8, cost: 3, category: 'Other' }) });
  });
});
