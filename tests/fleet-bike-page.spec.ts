import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A fleet bike's page and its private details (owner, 2026-09-28). The edit form shows the page
// the bike's sticker opens - micromobility.sa/bikes/<number>, never the old /b/<number> - with its
// QR, to write onto an NFC tag or print; and the columns only staff may read (tag, serial number,
// model year, pedals, condition, notes), read through staff_bike_private and written only when
// they change, so a failed read never blanks them.

const BIKE = {
  id: 'b1', name: 'R-AL-0007-M', size: 'M', type: 'Road', status: 'available', colors: ['#03ff89'], color_names: [''],
  frame_type: 'Aluminum', bike_number: 7, brand: 'TREK', wheel_size: '700c', brake_type: 'Disc', weight_kg: 9.4,
  last_serviced_at: '2099-01-01T08:00:00Z', in_service_date: '2023-01-05',
};
const PRIV = { id: 'b1', tag_uid: '04A1B2C3', serial_number: 'SN-0007', model_year: 2025, wheel_size: '700c', brake_type: 'Disc', pedal_type: 'Flat', condition: 'Good', notes: 'Squeaky rear brake' };
type P = import('@playwright/test').Page;
type W = { method: string; body: Record<string, unknown> };

async function boot(page: P, extra: Record<string, unknown> = {}, answer?: (w: W) => { status: number; body: unknown } | null) {
  await stubSupabase(page, { bikes: [BIKE], 'rpc:staff_bike_private': [PRIV], ...extra });
  const writes: W[] = [];
  const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  await page.route(/\/rest\/v1\/bikes/, async (route) => {
    const req = route.request();
    if (req.method() === 'GET' || req.method() === 'OPTIONS') return route.fallback();
    let body: Record<string, unknown> = {};
    try { const b = req.postDataJSON(); body = Array.isArray(b) ? b[0] : b; } catch { /* no body */ }
    const w = { method: req.method(), body };
    writes.push(w);
    const a = answer && answer(w);
    if (a) return route.fulfill({ status: a.status, headers: head, body: JSON.stringify(a.body) });
    return route.fallback();
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';renderInventory();renderBikes()`);
  return writes;
}
const first = (w: W[], m: string) => w.find((x) => x.method === m && !('photo' in x.body && Object.keys(x.body).length === 1));

test.describe('@staff:fleet a bike\'s page and private details', () => {
  test('the edit form shows the bike\'s /bikes page with its QR, and reads its private details', async ({ page }) => {
    await boot(page);
    await page.evaluate(`startEdit('b1')`);
    const box = page.locator('#bk-add-form .bk-page');
    await expect(box.locator('.bk-page-url')).toHaveText('micromobility.sa/bikes/7');
    await expect(box.locator('.bk-page-url')).toHaveAttribute('href', 'https://micromobility.sa/bikes/7');
    await expect(box.locator('svg')).toHaveCount(1);
    await expect(page.locator('#bk-add-form')).not.toContainText('/b/7');
    for (const [id, v] of [['#bk-serial', 'SN-0007'], ['#bk-tag', '04A1B2C3'], ['#bk-year', '2025'], ['#bk-pedal', 'Flat'], ['#bk-cond', 'Good'], ['#bk-notes', 'Squeaky rear brake']]) {
      await expect(page.locator(id)).toHaveValue(v);
    }
    // the QR downloads as a file named after the bike
    const dl = page.waitForEvent('download');
    await box.locator('.bk-page-qrdl').click();
    expect((await dl).suggestedFilename()).toBe('bike-7-qr.svg');
    // a new bike has no page yet (no saved number), but has the private fields
    await page.evaluate(`cancelBikeForm();startClone('b1')`);
    await expect(page.locator('#bk-add-form .bk-page')).toHaveCount(0);
    await expect(page.locator('#bk-serial')).toHaveValue('');
  });

  test('a save writes only the private details that changed, and the undo puts them back', async ({ page }) => {
    const writes = await boot(page);
    await page.evaluate(`startEdit('b1')`);
    await expect(page.locator('#bk-serial')).toHaveValue('SN-0007');
    await page.locator('#bk-serial').fill('SN-0007-B');
    await page.locator('#bk-notes').fill('New rear pads fitted');
    await page.evaluate(`saveBikeEdit()`);
    await expect.poll(() => writes.filter((w) => w.method === 'PATCH').length).toBeGreaterThan(0);
    const patch = first(writes, 'PATCH')!.body;
    expect(patch.serial_number).toBe('SN-0007-B');
    expect(patch.notes).toBe('New rear pads fitted');
    for (const col of ['tag_uid', 'model_year', 'pedal_type', 'condition']) expect(col in patch).toBe(false);
    await page.locator('#topbar-right .undo-btn').click();
    await expect.poll(() => writes.filter((w) => w.method === 'PATCH' && w.body.serial_number === 'SN-0007').length).toBe(1);
    const undo = writes.find((w) => w.method === 'PATCH' && w.body.serial_number === 'SN-0007')!.body;
    expect(undo.notes).toBe('Squeaky rear brake');
  });

  test('when the private details cannot be read, only what is typed is written', async ({ page }) => {
    const writes = await boot(page, { 'rpc:staff_bike_private': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    await page.evaluate(`startEdit('b1')`);
    await expect(page.locator('#bk-add-form .bk-priv-err')).toBeVisible();
    await page.locator('#bk-cond').fill('Needs a service');
    await page.evaluate(`saveBikeEdit()`);
    await expect.poll(() => writes.filter((w) => w.method === 'PATCH').length).toBeGreaterThan(0);
    const patch = first(writes, 'PATCH')!.body;
    expect(patch.condition).toBe('Needs a service');
    for (const col of ['serial_number', 'tag_uid', 'model_year', 'pedal_type', 'notes']) expect(col in patch).toBe(false);
  });

  test('a new bike carries its private details; a tag already on another bike is said so', async ({ page }) => {
    const writes = await boot(page, {}, (w) => (w.method === 'POST' && w.body.tag_uid === '04FFEE11'
      ? { status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint "bikes_tag_uid_uniq"', details: 'Key (tag_uid)=(04FFEE11) already exists.' } }
      : null));
    await page.evaluate(`startClone('b1')`);
    await page.locator('#bk-serial').fill(' SN-0008 ');
    await page.locator('#bk-tag').fill('04 ff ee 11');
    await page.locator('#bk-year').fill('2026');
    await page.evaluate(`addBike()`);
    await expect(page.locator('.toast', { hasText: 'That NFC tag is already on another bike.' })).toBeVisible();
    const post = first(writes, 'POST')!.body;
    expect(post).toMatchObject({ bike_number: 8, serial_number: 'SN-0008', tag_uid: '04FFEE11', model_year: 2026 });
    expect('notes' in post).toBe(false);
    await expect(page.locator('#bk-add-form')).toBeVisible(); // the form stays up to fix the tag
  });
});
