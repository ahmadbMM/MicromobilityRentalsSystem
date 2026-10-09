import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// 2026-10-09 (M10/M11): a bike returned "Needs a check" waits in status 'check' - nothing hands it
// out until staff clear it - and its profile lists the incidents the returns recorded (condition,
// notes, rider, who returned it, the photo). With the business setting "Every returned bike needs a
// check" an OK return holds the bike too. A database before migration 20261009170000 frees the bike,
// so the desk holds it itself; one after it answers held:true and the desk writes nothing more.

const tomorrow = new Date(Date.now() + 864e5 + 3 * 3600e3).toISOString().slice(0, 10);
const BIKE = { id: 'b1', name: 'Hybrid 007', bike_number: 7, type: 'Hybrid', size: 'M', status: 'in-use', colors: [], color_names: [] };
const SESSION = { id: 's1', day: 'Friday', session_date: tomorrow, capacity: 12, status: 'open', created_at: 1 };
const ENTRY = {
  id: 'e1', session_id: 's1', session_day: 'Friday', session_date: tomorrow, queue_num: 3, name: 'Rider Three', phone: '',
  customer_id: null, group_id: null, status: 'active', paid: true, price: 30, walk_in: true, registered_at: `${tomorrow}T10:00:00Z`,
  type_preference: 'Hybrid', size: 'M', assigned_bike_id: 'b1', checked_in_at: `${tomorrow}T09:00:00Z`,
};
const base: Fixtures = { queue_entries: [ENTRY], sessions: [SESSION], bikes: [BIKE], 'rpc:staff_return': { ok: true, noop: false, bikes_freed: 1 } };

type Write = { method: string; table: string; url: string; body: unknown };
async function open(page: Page, fixtures: Fixtures) {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  const writes: Write[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/([a-z_]+)(\?|$)/);
    if (m && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) {
      let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
      writes.push({ method: r.method(), table: m[1], url: decodeURIComponent(r.url()), body });
    }
  });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0 && getBikes().length>0');
  return writes;
}

test.describe('@staff:bikes needs-a-check after a return', () => {
  test('Needs a check: the sheet offers a photo, and an older database\'s freed bike is held for its check', async ({ page }) => {
    const writes = await open(page, base);
    await page.evaluate("doReturn('e1')");
    const m = page.locator('#return-modal');
    await expect(m.locator('#ret-photo-lbl')).toHaveCount(0); // OK: no photo field
    await m.getByRole('button', { name: 'Needs a check' }).click();
    await expect(m.locator('#ret-photo-lbl')).toHaveText(/Photo/);
    await expect(m.locator('#ret-hint')).toContainText('waits for a check');
    await m.locator('#ret-notes').fill('Rear brake soft');
    await m.locator('#ret-confirm').click();
    await expect.poll(() => writes.find((w) => w.table === 'bikes' && w.method === 'PATCH')?.body).toEqual({ status: 'check' });
    const w = writes.find((x) => x.table === 'bikes')!;
    expect(w.url).toContain('status=eq.available'); // never over a bike someone already took
    expect(writes.find((x) => x.table === 'bike_assignments')?.body).toEqual({ return_by_name: 'Spec Staff' });
  });

  test('a migrated database holds the bike itself (held:true): the desk writes no bike', async ({ page }) => {
    const writes = await open(page, { ...base, 'rpc:staff_return': { ok: true, noop: false, bikes_freed: 1, held: true, bike_status: 'check' } });
    await page.evaluate("doReturn('e1')");
    await page.locator('#return-modal').getByRole('button', { name: 'Needs a check' }).click();
    await page.locator('#ret-confirm').click();
    await expect.poll(() => page.evaluate("getQueue().find(e=>e.id==='e1').status")).toBe('done');
    await expect.poll(() => writes.filter((w) => w.table === 'bike_assignments').length).toBe(1); // the operator, after the answer
    expect(writes.filter((w) => w.table === 'bikes')).toEqual([]);
  });

  test('"Every returned bike needs a check": an OK return holds the bike too; without it nothing is held', async ({ page }) => {
    const writes = await open(page, { ...base, staff_options: [{ key: 'biz', items: { return_check_all: true } }] });
    await page.evaluate("doReturn('e1')");
    await page.locator('#ret-confirm').click();
    await expect.poll(() => writes.find((w) => w.table === 'bikes')?.body).toEqual({ status: 'check' });
    expect(writes.find((w) => w.table === 'bike_assignments')).toBeUndefined(); // an OK return stamps nothing on the assignment
  });

  test('without the setting an OK return writes nothing around staff_return', async ({ page }) => {
    const writes = await open(page, base);
    await page.evaluate("doReturn('e1')");
    await page.locator('#ret-confirm').click();
    await expect.poll(() => page.evaluate("getQueue().find(e=>e.id==='e1').status")).toBe('done');
    await page.waitForTimeout(300);
    expect(writes.filter((w) => w.table === 'bikes' || w.table === 'bike_assignments')).toEqual([]);
  });

  test('a bike on check is not handed out: the check-in says why, and Needs attention clears it', async ({ page }) => {
    const writes = await open(page, { ...base, bikes: [{ ...BIKE, status: 'check' }], queue_entries: [{ ...ENTRY, status: 'waiting', assigned_bike_id: null }] });
    expect(await page.evaluate("_ciBikeStatusText({bike:getBikes()[0]})")).toBe('Needs a check first');
    expect(await page.evaluate("_bkStatusLabel(getBikes()[0])")).toBe('Needs check');
    await page.evaluate("setStaffTab('inventory');setInvSection('bikes')");
    const attn = page.locator('.bk-attn-row[data-bike="b1"]');
    await expect(attn).toContainText('Needs a check');
    await attn.getByRole('button', { name: 'Checked, OK' }).click();
    await expect.poll(() => writes.find((w) => w.table === 'bikes')?.body).toEqual({ status: 'available' });
    expect(writes.find((w) => w.table === 'bikes')!.url).toContain('status=eq.check');
    await expect.poll(() => page.evaluate("getBikes()[0].status")).toBe('available');
  });

  test('Send to maintenance dates it today', async ({ page }) => {
    const writes = await open(page, { ...base, bikes: [{ ...BIKE, status: 'check' }], queue_entries: [{ ...ENTRY, status: 'waiting', assigned_bike_id: null }] });
    await page.evaluate("setStaffTab('inventory');setInvSection('bikes')");
    await page.locator('.bk-attn-row[data-bike="b1"]').getByRole('button', { name: 'Send to maintenance' }).click();
    await expect.poll(() => (writes.find((w) => w.table === 'bikes')?.body as Record<string, unknown>)?.status).toBe('maintenance');
    expect((writes.find((w) => w.table === 'bikes')!.body as Record<string, unknown>).retired_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

test.describe('@staff:bikes incidents on the bike profile', () => {
  test('the profile lists the returns that needed a look, with the rider, who returned it and the photo', async ({ page }) => {
    await open(page, {
      ...base, bikes: [{ ...BIKE, status: 'check' }], queue_entries: [{ ...ENTRY, status: 'done' }],
      bike_assignments: [
        { booking_id: 'e1', returned_at: '2026-10-08T19:30:00Z', return_condition: 'needs_check', return_notes: 'Chain skips in 3rd', return_photo: 'https://example.supabase.co/storage/v1/object/public/photos/p/x.jpg', return_by_name: 'Desk Lead' },
      ],
    });
    await page.evaluate("openBikeProfile('b1')");
    const card = page.locator('#bike-profile-modal');
    await expect(card.locator('.flx-check')).toContainText('needs a check');
    await expect(card.locator('.flx-check')).toContainText('Chain skips in 3rd');
    const inc = card.locator('.flx-inc').first();
    await expect(inc).toContainText('Needs a check');
    await expect(inc).toContainText('#3 Rider Three');
    await expect(inc).toContainText('returned by Desk Lead');
    await expect(inc.locator('img')).toHaveAttribute('src', /photos\/p\/x\.jpg$/);
  });

  test('before the migration the log says it is waiting for the database update', async ({ page }) => {
    await stubSupabase(page, base);
    await page.route(/\/rest\/v1\/bike_service_log/, (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.bike_service_log' in the schema cache" }) }));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getBikes().length>0');
    await page.evaluate("openBikeProfile('b1')");
    await expect(page.locator('#bp-fleet')).toContainText('Waiting for the database update');
    await expect(page.locator('#bp-fleet').getByRole('button', { name: /Add entry/ })).toHaveCount(0);
  });
});
