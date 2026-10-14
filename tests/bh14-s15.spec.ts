import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-14 (s15): History's bulk "mark paid" sent twice on a double tap, a second
// nutrition label stacked on the first, and the booking's cashier dialog voided a sale on a bare
// yes or no with a log line no report read as a void.

const ksa = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const TOMORROW = ksa(new Date(Date.now() + 864e5));
const SID = `${TOMORROW}-a`;
const sessions = [{ id: SID, day: 'Friday', session_date: TOMORROW, capacity: 12, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '19:00 - 21:00' }) }];
const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: SID, session_day: 'Friday', session_date: TOMORROW, queue_num: 1, name, phone: '0500000001', email: '',
  type_preference: 'Hybrid', size: 'M', status: 'done', paid: false, price: 60, registered_at: `${TOMORROW}T10:00:00Z`, ...extra,
});
const inventory = [{ id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 10, price: 12, low_threshold: 1, nutrition: JSON.stringify({ kcal: 90, carbs_g: 22 }) }];
type P = import('@playwright/test').Page;

async function boot(page: P, fx: Record<string, unknown>) {
  await stubSupabase(page, { sessions, inventory, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
}

test.describe('@bh14 s15', () => {
  test('a double tap on "mark selected paid" sends the batch once', async ({ page }) => {
    await boot(page, { queue_entries: [row('h1', 'Owing One'), row('h2', 'Owing Two')] });
    const writes: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /queue_entries/.test(r.url())) writes.push(r.url()); });
    await page.evaluate(`setStaffTab('history');renderHistory();S.histSelected=['h1','h2'];void bulkHistMarkPaid();void bulkHistMarkPaid();`);
    await expect.poll(() => writes.length).toBe(2);
    await page.waitForTimeout(300);
    expect(writes.length).toBe(2); // one per booking, not four
    expect(await page.evaluate(`S._histPaying`)).toBe(false);
  });

  test('opening a nutrition label twice shows one label', async ({ page }) => {
    await boot(page, { queue_entries: [row('h1', 'Anyone')] });
    await page.evaluate(`showNutrition('i1');showNutrition('i1');`);
    expect(await page.locator('#nutrition-modal-backdrop').count()).toBe(1);
    await page.evaluate(`closeNutrition()`);
    expect(await page.locator('#nutrition-modal-backdrop').count()).toBe(0);
  });

  test("the booking's cashier dialog asks why before voiding, and logs the void with its reason", async ({ page }) => {
    const sale = { id: 'i1', name: 'Gel', cat: 'EnergyGels', qty: 1, price: 12, pay: 'paid', at: `${TOMORROW}T11:00:00Z` };
    await boot(page, { queue_entries: [row('q1', 'Counter Rider', { status: 'active', purchases: JSON.stringify([sale]) })] });
    await page.evaluate(`S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();showCashierModal('q1');void _cashVoid(0);`);
    await expect(page.locator('#mny-modal [role="dialog"]')).toBeVisible();
    expect(await page.evaluate(`entryPurchases(getQueue().find(e=>e.id==='q1')).length`)).toBe(1); // nothing yet
    await page.locator('#mny-modal .mny-chip').first().click();
    await page.locator('#mny-mr-go').click();
    await expect.poll(() => page.evaluate(`entryPurchases(getQueue().find(e=>e.id==='q1')).length`)).toBe(0);
    const reason = await page.evaluate(`_moneyReasonText(MR_CODES.void[0])`);
    await expect.poll(() => page.evaluate(`S.fullLog.some(l=>l.label.includes(t('cashVoid'))&&l.label.includes(${JSON.stringify(reason)}))`)).toBe(true);
  });
});
