import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The bike collection areas (2026-11-21, migration 20261121120000; the user: "put tv screens in both bike collection areas
// ... that in realtime shows checked in bookings, shows their booking number height bike type and bike size"). Bookings >
// Collection lists who is checked in and still waits for a bike, by area, with Handed; the check-in asks where a Kids or
// Any rider collects; TV screens pairs a TV; display.html is the TV. Invented riders only.

const DAY = '2026-11-15';
const SESSION = { id: DAY, session_date: DAY, day: 'Sunday', status: 'open', capacity: 40, created_at: 1, bike_slots: '{"_time":"18:30 - 21:00"}' };
const row = (id: string, n: number, name: string, x: Record<string, unknown> = {}) => ({
  id, session_id: DAY, session_day: 'Sunday', session_date: DAY, queue_num: n, name, phone: '0551234567', customer_id: null,
  group_id: null, status: 'active', paid: true, price: 57.5, walk_in: true, type_preference: 'Hybrid', size: 'M', height: 176,
  waiver_version: '2026-10-01', waiver_at: `${DAY}T10:00:00Z`, registered_at: `${DAY}T09:0${n % 10}:00Z`,
  checked_in_at: `${DAY}T14:4${n % 10}:00Z`, ...x,
});
const QUEUE = [
  row('r1aaaa11', 1, 'Road Rider', { type_preference: 'Road', height: 182 }),
  row('h2bbbb22', 2, 'Hill Rider', { type_preference: 'Mountain', height: 168 }),
  row('k3cccc33', 3, 'Kid Rider', { type_preference: 'Kids', height: 130 }),
  row('o4dddd44', 4, 'Own Rider', { type_preference: 'Own' }), // their own bike: never waits
  row('w5eeee55', 5, 'Late Rider', { status: 'waiting', checked_in_at: null, type_preference: 'Any', height: 175 }),
  row('d6ffff66', 6, 'Done Rider', { handed_at: `${DAY}T14:50:00Z`, handed_by: 'Huda' }),
];

// staff_collect_set answers with what it was asked to write (the real one returns the row's three columns).
async function echoCollect(page: Page, rows: Record<string, unknown>[]) {
  const calls: Record<string, unknown>[] = [];
  await page.route('**/rest/v1/rpc/staff_collect_set', async (route) => {
    const a = route.request().postDataJSON() as Record<string, unknown>;
    calls.push(a);
    const q = rows.find((r) => r.id === a.p_id) || {};
    // the row as the database now holds it, so the desk's re-read after the write reads it too
    if (a.p_area !== undefined && a.p_area !== null) q.collect_area = a.p_area || null;
    if (a.p_handed === true) { q.handed_at = `${DAY}T15:00:00Z`; q.handed_by = a.p_by ?? null; }
    if (a.p_handed === false) { q.handed_at = null; q.handed_by = null; }
    await route.fulfill({
      status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, collect_area: q.collect_area ?? null, handed_at: q.handed_at ?? null, handed_by: q.handed_by ?? null }),
    });
  });
  return calls;
}
async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(new Date(`${DAY}T18:00:00+03:00`));
  const rows = QUEUE.map((r) => ({ ...r })) as Record<string, unknown>[]; // this test's own copy, written by the echo
  await stubSupabase(page, { sessions: [SESSION], queue_entries: rows, bikes: [], ...fx });
  const calls = await echoCollect(page, rows);
  await unlockStaff(page);
  await page.addInitScript(() => localStorage.setItem('cq_co_area', 'all'));
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`setStaffTab('queue',{sid:'${DAY}'})`);
  return calls;
}
// Collection: a pill beside Bookings on a desk's screen; on a phone's roster, a tile in Desk tools (the fold budget).
async function goCollect(page: Page) {
  const pill = page.locator('#tab-queue .q-views .filter-pill', { hasText: 'Collection' });
  if (await pill.count()) await pill.click();
  else {
    await page.locator('#tab-queue .rq-hacts .sh-more').click();
    await page.getByRole('menuitem', { name: 'Collection' }).click();
  }
  await expect(page.locator('#co-host .page-title')).toHaveText('Collection');
}
const coRow = (page: Page, name: string) => page.locator('#co-host .co-row').filter({ hasText: name }).first();

test.describe('@staff:bookings collection areas', () => {
  test('Collection lists the riders waiting for a bike by area; Handed and Undo write through staff_collect_set', async ({ page }) => {
    const calls = await boot(page);
    await goCollect(page);
    // Road, Mountain and the Kids rider: not the bike owner, the late one or the one handed
    await expect(page.locator('#tab-queue .q-views .filter-pill', { hasText: 'Collection' })).toHaveText('Collection (3)');
    await expect(page.locator('#co-host .co-list').first().locator('.co-row')).toHaveCount(3);
    await expect(coRow(page, 'Road Rider')).toContainText('182 cm · Road · L');
    await expect(coRow(page, 'Hill Rider')).toContainText('Mountain · S');
    await expect(coRow(page, 'Kid Rider')).toContainText('Both TVs'); // a Kids booking nobody sent anywhere
    // this device stands at the Road area: the Road rider and the Kids one (on both TVs)
    await page.locator('#co-host .co-areas .filter-pill', { hasText: 'Road area' }).click();
    await expect(page.locator('#co-host .co-list').first().locator('.co-row')).toHaveCount(2);
    expect(await page.evaluate(`localStorage.getItem('cq_co_area')`)).toBe('road');
    await expect(coRow(page, 'Hill Rider')).toHaveCount(0);
    // Handed: off the list at once, into Handed recently
    await coRow(page, 'Road Rider').getByRole('button', { name: 'Handed' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_id: 'r1aaaa11', p_handed: true, p_by: 'Spec Staff' });
    await expect(page.locator('#co-host .co-list').first().locator('.co-row')).toHaveCount(1);
    const done = page.locator('#co-host .co-done .co-row').filter({ hasText: 'Road Rider' });
    await expect(done).toBeVisible();
    await done.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toMatchObject({ p_id: 'r1aaaa11', p_handed: false });
    await expect(coRow(page, 'Road Rider')).toBeVisible();
    // the Kids rider goes to the Hybrid/Mountain area: off this Road list
    await coRow(page, 'Kid Rider').getByRole('button', { name: 'To Hybrid/Mountain area' }).click();
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2]).toMatchObject({ p_id: 'k3cccc33', p_area: 'hm' });
    await expect(coRow(page, 'Kid Rider')).toHaveCount(0);
    await expect(page.locator('#toast-container .toast.error')).toHaveCount(0);
  });

  test('a refused Handed puts the rider back and says so; a database without the function says it is pending', async ({ page }) => {
    await boot(page, { 'rpc:staff_collect_set': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_collect_set' } } });
    await page.unroute('**/rest/v1/rpc/staff_collect_set'); // the fixture's answer, not the echo
    await goCollect(page);
    await coRow(page, 'Road Rider').getByRole('button', { name: 'Handed' }).click();
    await expect(page.locator('#toast-container .toast.error')).toBeVisible();
    await expect(coRow(page, 'Road Rider')).toBeVisible();
    expect(await page.evaluate(`_qGet('r1aaaa11').handedAt`)).toBeNull();
  });

  test('the check-in asks a Kids or Any rider\'s collection area and writes it at once; a Hybrid adult is not asked', async ({ page }) => {
    const calls = await boot(page);
    await page.evaluate(`showCheckinModal('w5eeee55')`);
    const field = page.getByRole('radiogroup', { name: 'Collection area' });
    await expect(field).toBeVisible();
    await expect(page.locator('#checkin-modal')).toContainText('Not chosen yet: the rider shows on both TVs.');
    await field.getByRole('radio', { name: 'Road area' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_id: 'w5eeee55', p_area: 'road' });
    await expect(field.getByRole('radio', { name: 'Road area' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#checkin-modal')).toContainText("The rider shows on this area's TV.");
    await page.evaluate(`closeCheckinModal()`);
    // a Hybrid booking at 176 cm collects in its own area: nothing to ask
    await page.evaluate(`_qGet('h2bbbb22').status='waiting';showCheckinModal('h2bbbb22')`);
    await expect(page.locator('#checkin-modal .modal-box')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Collection area' })).toHaveCount(0);
  });

  test('TV screens lists the paired TVs and pairs one with the code it shows', async ({ page }) => {
    await boot(page, { 'rpc:staff_screens': [{ id: '0f0e0d0c-0000-4000-8000-000000000001', area: 'road', session_id: null, label: 'Gate', paired_at: `${DAY}T12:00:00Z`, paired_by: 'Huda', last_seen_at: `${DAY}T14:59:30Z` }] });
    const paired: Record<string, unknown>[] = [];
    await page.route('**/rest/v1/rpc/staff_screen_pair', async (route) => {
      paired.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify(paired.length === 1 ? { ok: false, error: 'no_code' } : { ok: true, id: 'x' }) });
    });
    await goCollect(page);
    await page.locator('#co-host').getByRole('button', { name: 'TV screens' }).click();
    const sheet = page.getByRole('dialog', { name: 'TV screens' });
    await expect(sheet.locator('.tv-item')).toContainText('Gate · Road area');
    await expect(sheet.locator('.tv-item')).toContainText("All of today's sessions · Online");
    await sheet.getByLabel('Code on the TV').fill('12 34');
    await sheet.getByRole('button', { name: 'Pair a TV' }).click();
    await expect(sheet.locator('#tv-err')).toHaveText('Enter the 6 digits the TV shows.');
    await sheet.getByLabel('Code on the TV').fill('123 456');
    await sheet.getByLabel('Area').selectOption('road');
    await sheet.getByLabel('Name (optional)').fill('Road gate');
    await sheet.getByRole('button', { name: 'Pair a TV' }).click();
    await expect(sheet.locator('#tv-err')).toContainText('No TV is showing that code');
    await sheet.getByRole('button', { name: 'Pair a TV' }).click();
    await expect.poll(() => paired.length).toBe(2);
    expect(paired[1]).toMatchObject({ p_code: '123456', p_area: 'road', p_session_id: '', p_label: 'Road gate', p_by: 'Spec Staff' });
    await expect(page.locator('#toast-container .toast').filter({ hasText: 'TV paired' })).toBeAttached(); // a success toast is a quiet one
  });
});

// ── the TV itself ─────────────────────────────────────────────────────────────────────────────────────────────────────
type Feed = Record<string, unknown>;
async function tv(page: Page, feeds: Feed[]) {
  const asked: { fn: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  await page.route('**://*.supabase.co/**', async (route) => {
    const req: Request = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const fn = (new URL(req.url()).pathname.match(/rpc\/([^/]+)/) || [])[1] || '';
    asked.push({ fn, body: (req.postDataJSON() || {}) as Record<string, unknown> });
    const body = fn === 'screen_pair_start' ? { ok: true, token: 'tok-0123456789abcdef0123456789', code: '482913' } : feeds[Math.min(i++, feeds.length - 1)];
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  return asked;
}
const R = (n: number, name: string, x: Record<string, unknown> = {}) => ({ id: 'id' + n, n, name, h: 176, type: 'Hybrid', size: 'M', at: `${DAY}T14:4${n}:00Z`, pos: 1, of: 1, area: 'hm', sid: DAY, ...x });
const PAIRED = (rows: unknown[], etag: string) => ({ state: 'paired', etag, now: `${DAY}T15:00:00Z`, area: 'hm', label: null,
  sessions: [{ id: DAY, title: 'Sunday ride', title_ar: null, date: DAY, day: 'Sunday' }], chart: null, kids_max: 144, rows });

test.describe('@build the collection-area TV page', () => {
  test('a new TV shows a pairing code, then the riders of its area with their sizes, a new one marked', async ({ page }) => {
    const asked = await tv(page, [
      { state: 'pairing', code: '482913' },
      PAIRED([R(1, 'Sara', { pos: 1, of: 2 }), R(2, 'Omar', { type: 'Any', area: null, h: 172 }), R(3, 'Lina', { type: 'Kids', h: 130, area: 'hm' })], 'e1'),
      { state: 'same', etag: 'e1', now: `${DAY}T15:00:03Z` },
      PAIRED([R(1, 'Sara', { pos: 1, of: 2 }), R(2, 'Omar', { type: 'Any', area: null, h: 172 }), R(3, 'Lina', { type: 'Kids', h: 130, area: 'hm' }), R(4, 'Nour', { type: 'Mountain', h: 188 })], 'e2'),
    ]);
    await page.goto('/display.html');
    await expect(page.locator('.tv-code')).toHaveText('482 913');
    await expect(page.locator('.tv-pair h1')).toContainText('Pair this TV');
    expect(asked[0].fn).toBe('screen_pair_start');
    expect(await page.evaluate(`localStorage.getItem('mm_tv_token')`)).toBe('tok-0123456789abcdef0123456789');
    // paired: the Hybrid & Mountain area
    await expect(page.locator('.tv-area-en')).toHaveText('Hybrid & Mountain bikes', { timeout: 10000 });
    const card = (n: number) => page.locator('.tv-row').filter({ hasText: `#${n}` });
    await expect(page.locator('.tv-row')).toHaveCount(3);
    await expect(card(1)).toContainText('Sara1 of 2');
    await expect(card(1).locator('.tv-wait')).toHaveText('19 min'); // checked in 14:41, the database says 15:00
    await expect(card(1).locator('.tv-wait')).toHaveClass(/tv-late/); // 10 minutes and more turn amber
    await expect(card(1).locator('.tv-size')).toHaveText('M');
    await expect(card(2).locator('.tv-size')).toContainText('Road'); // an Any rider with no area: Road S and Hybrid M
    await expect(card(2).locator('.tv-size')).toContainText('S');
    await expect(card(2)).toContainText('Either area');
    await expect(card(3).locator('.tv-size')).toContainText('Kids');
    await expect(page.locator('.tv-row.tv-new')).toHaveCount(0); // the first paint marks nobody
    // the feed sends its etag back; the fourth rider arrives marked new
    await expect(card(4)).toBeVisible({ timeout: 10000 });
    await expect(card(4).locator('.tv-size')).toHaveText('L');
    await expect(card(4)).toHaveClass(/tv-new/);
    await expect(card(4)).toContainText('NEW');
    await expect(card(4).locator('.tv-wait')).toHaveText('Just now');
    const feeds = asked.filter((a) => a.fn === 'screen_feed');
    expect(feeds[0].body).toMatchObject({ p_token: 'tok-0123456789abcdef0123456789', p_etag: null });
    expect(feeds.some((f) => f.body.p_etag === 'e1')).toBe(true);
  });

  test('a party stays together under its first check-in, and a lost connection dims the list with its age', async ({ page }) => {
    let down = false;
    await tv(page, [
      { state: 'pairing', code: '482913' },
      PAIRED([R(1, 'Sara'), R(2, 'Faisal', { pos: 1, of: 3, g: 'aa11bb22' }), R(3, 'Lina'),
        R(4, 'Omar', { pos: 3, of: 3, g: 'aa11bb22', type: 'Kids', h: 130 }), R(5, 'Noura', { pos: 2, of: 3, g: 'aa11bb22' })], 'e1'),
    ]);
    await page.route('**/rpc/screen_feed', (route) => (down ? route.abort() : route.fallback()));
    await page.goto('/display.html');
    await expect(page.locator('.tv-row')).toHaveCount(5, { timeout: 10000 });
    await expect(page.locator('.tv-row .tv-name')).toHaveText(['Sara', 'Faisal', 'Noura', 'Omar', 'Lina']);
    await expect(page.locator('.tv-row.tv-pf')).toContainText('Faisal');
    await expect(page.locator('.tv-row.tv-pm')).toContainText('Noura');
    await expect(page.locator('.tv-row.tv-pl')).toContainText('Omar');
    await expect(page.locator('.tv-row').filter({ hasText: 'Omar' }).locator('.tv-size')).toContainText('Kids');
    await expect(page.locator('.tv-off')).toBeHidden();
    down = true;
    await expect(page.locator('body')).toHaveClass(/tv-offline/, { timeout: 30000 });
    await expect(page.locator('.tv-off')).toBeVisible();
    await expect(page.locator('.tv-off')).toContainText('may be out of date');
    await expect(page.locator('.tv-row')).toHaveCount(5); // the last list stays up, dimmed
  });

  test('an unpaired TV (unknown secret) starts pairing again', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mm_tv_token', 'tok-old-old-old-old-old-old-old'));
    const asked = await tv(page, [{ state: 'unknown' }, { state: 'pairing', code: '482913' }]);
    await page.goto('/display.html');
    await expect(page.locator('.tv-code')).toHaveText('482 913');
    expect(asked.map((a) => a.fn).slice(0, 2)).toEqual(['screen_feed', 'screen_pair_start']);
  });
});
