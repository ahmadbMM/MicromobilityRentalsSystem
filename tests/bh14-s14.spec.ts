import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Bug hunt 2026-10-14 (s14): a part added to a workshop job with no final price yet adds to the
// estimate, not to 0; a ride time is not measured from 1970 when the check-in time is missing.

const job = (o: Record<string, unknown> = {}) => ({
  id: 42, created_at: '2026-10-01T09:30:00Z', customer_id: null, name: 'Sara Ali', phone: '+966551234567', email: null,
  service: 'full-service', service_label: 'Full service', price_quoted: 409, parts: [], lane: 'dropoff', pickup_address: null,
  preferred_date: null, preferred_time: null, bike: null, notes: null, lang: 'en', status: 'in_workshop', scheduled_for: null,
  price_final: null, staff_notes: null, updated_at: '2026-10-03T09:30:00Z', updated_by: 'Desk', mechanic: null, parts_used: [],
  paid_at: null, paid_receipt: null, ...o,
});
type Call = { name: string; body: unknown };
async function open(page: Page, fixtures: Fixtures = {}) {
  await stubSupabase(page, { workshop_jobs: [job()], workshop_job_events: [], inventory: [{ id: 'pads', name: 'Brake pads', category: 'Accessory', qty: 5, price: 60, cost: 25, low_threshold: 1 }], ...fixtures });
  await unlockStaff(page);
  const calls: Call[] = [];
  page.on('request', (r) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(r.method())) return;
    const m = r.url().match(/\/rest\/v1\/(?:rpc\/)?([a-z_]+)(\?|$)/);
    let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
    if (m) calls.push({ name: m[1], body });
  });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.inventory||[]).length>0');
  await page.evaluate("setStaffTab('workshop')");
  await page.waitForFunction('!!(S._ws&&S._ws.jobs)');
  await page.evaluate("_wsSetFilter('all')");
  return calls;
}

test.describe('@bh14 s14 workshop and riders', () => {
  test('a part on a job with no final price adds to the estimate', async ({ page }) => {
    const calls = await open(page, { 'rpc:staff_inventory_move': { ok: true, qty: 3, move_id: 12 } });
    await page.locator('.ws-row[data-ws-id="42"]').getByRole('button', { name: 'Add part' }).click();
    const d = page.locator('#confirm-modal .ws-dlg');
    await d.locator('#ws-pi').selectOption('pads');
    await d.locator('#ws-pq').fill('2');
    await d.getByRole('button', { name: 'Add part' }).click();
    await expect.poll(() => calls.find((c) => c.name === 'workshop_jobs')?.body).toMatchObject({ price_final: 529 });
  });

  test('a ride time needs both times', async ({ page }) => {
    await open(page);
    expect(await page.evaluate("_riderDur(null,'2026-10-14T18:00:00Z')")).toBe('');
    expect(await page.evaluate("_riderDur('2026-10-14T16:25:00Z','2026-10-14T18:00:00Z')")).toContain('35');
  });
});
