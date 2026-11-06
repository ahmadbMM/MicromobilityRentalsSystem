import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The desk's second round (2026-11-07, the staff review of 2026-11-06): BK10 the pace line, BK11 the marked row's
// keys, BK12 back to search after a check-in, BK13 "Running late?", BK14 places left on the ride chips, OT04 the
// bike prep sheet, OT06 first ride and the first-timers, OT08 check-in states (queue_entries.staff_state /
// late_msg_at, migration 20261107101000).

const ksaDay = (ms: number) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const TODAY = ksaDay(Date.now());
const sess = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, day: 'Sunday', session_date: date, capacity: 40, status: 'open', created_at: 1, location: 'JCC',
  bike_slots: '{"_time":"00:00 - 23:59","_total":40}', ...over,
});
const bk = (id: string, sid: string, date: string, n: number, over: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: date, queue_num: n, name: `Rider ${id}`,
  phone: `05500000${String(n).padStart(2, '0')}`, customer_id: null, type_preference: 'Road', size: 'M', height: 178,
  status: 'waiting', paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z', staff_state: null, late_msg_at: null, ...over,
});

async function desk(page: Page, sessions: Record<string, unknown>[], rows: Record<string, unknown>[], sid = 's1') {
  await page.setViewportSize({ width: 1280, height: 900 });
  await stubSupabase(page, { sessions, bikes: [], queue_entries: rows, customers: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${sid}';renderStaffQueue()`);
}
const patchesOf = (page: Page, col: string) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && /\/rest\/v1\/queue_entries/.test(r.url()) && (r.postData() || '').includes(col)) out.push(r.postDataJSON());
  });
  return out;
};

test.describe('@staff:bookings The desk, second round', () => {
  test('ride chips say the places left and the waitlist; the pace line counts the last 15 minutes and who has not arrived', async ({ page }) => {
    const now = new Date().toISOString();
    await desk(page, [sess('s1', TODAY)], [
      bk('a', 's1', TODAY, 1, { status: 'active', checked_in_at: now }),
      bk('b', 's1', TODAY, 2),
      bk('c', 's1', TODAY, 3),
      bk('w', 's1', TODAY, 4, { status: 'waitlist', waitlist_num: 1 }),
    ]);
    const chip = page.locator('#sess-strip .sess-summary-chip').first();
    await expect(chip.locator('.n6c-left')).toContainText('37 left');
    await expect(chip.locator('.n6c-left')).toContainText('W 1');
    const pace = page.locator('#tab-queue .n6c-pace');
    await expect(pace).toContainText('Last 15 min: 1 in, 0 back');
    await expect(pace).toContainText('2 not arrived');
    await expect(pace).toContainText('Ride started');
  });

  test('First ride on a rider with no earlier ride; the bike prep sheet counts bikes by type and size; first-timers are listed', async ({ page }) => {
    const old = ksaDay(Date.now() - 30 * 864e5), older = ksaDay(Date.now() - 60 * 864e5), D = ksaDay(Date.now() + 864e5);
    await desk(page, [sess('s1', D), sess('p1', older, { status: 'closed' }), sess('p2', old, { status: 'closed' })], [
      bk('r1', 's1', D, 1, { customer_id: 'c1', height: 178 }),
      bk('r2', 's1', D, 2, { customer_id: 'c2', height: 165 }),
      bk('r3', 's1', D, 3, { customer_id: 'c4', height: 178, type_preference: 'Hybrid' }),
      bk('r4', 's1', D, 4, { height: null, size: null }),
      bk('r5', 's1', D, 5, { type_preference: 'Own' }),
      bk('h1', 'p1', older, 1, { customer_id: 'c1', status: 'done', paid: true }),
      bk('h2', 'p2', old, 1, { customer_id: 'c3', name: 'Lina First', status: 'done', paid: true }),
    ]);
    const first = page.locator('#tab-queue .n6c-first');
    await expect(first).toHaveCount(2); // r2 and r3 (r1 rode before; r4 has no account)
    await expect(page.locator('#tab-queue tr[data-id="r1"] .n6c-first')).toHaveCount(0);

    await page.locator('#tab-queue .n6c-prep-btn').click();
    const dlg = page.locator('#confirm-modal');
    await expect(dlg).toContainText('Bike prep');
    const rows = await dlg.locator('table.n6c-prep tbody tr').allInnerTexts();
    expect(rows.join('|')).toMatch(/Road[^|]*\b1\b[^|]*\b1\b/); // a Road S and a Road M (and one with no height)
    await expect(dlg.locator('table.n6c-prep tbody tr')).toHaveCount(2); // Road, Hybrid; the own bike is not counted
    await expect(dlg.locator('thead')).toContainText('No height');
    await dlg.getByRole('button', { name: 'Close' }).last().click();

    await page.locator('#tab-queue .n6c-ft-btn').click();
    await expect(dlg).toContainText('First-timers with no second booking (1)');
    await expect(dlg.locator('.n6c-ft-row')).toContainText('Lina First');
  });

  test('a check-in state is set from the booking menu and shows over the status', async ({ page }) => {
    const D = ksaDay(Date.now() + 864e5);
    const rows: Record<string, unknown>[] = [bk('r1', 's1', D, 1)];
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && /\/rest\/v1\/queue_entries/.test(r.url()) && (r.postData() || '').includes('staff_state')) { patches.push(r.postDataJSON()); rows[0].staff_state = r.postDataJSON().staff_state; }
    });
    // The stub echoes writes without keeping them: the reload after a save reads the state as saved.
    await page.route(/\/rest\/v1\/queue_entries/, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const st = patches.length ? patches[patches.length - 1].staff_state : null;
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify(rows.map((x) => ({ ...x, staff_state: st }))) });
    });
    await desk(page, [sess('s1', D)], rows);
    const labels = () => page.evaluate(`((S._rowMenus||{})['r1']||[]).map(x=>x.label.replace(/<[^>]*>/g,'').trim())`);
    await expect.poll(labels).toContain('Check-in state');
    void page.evaluate(`_n6cStOpen('r1')`);
    const dlg = page.locator('#confirm-modal');
    await expect(dlg).toContainText('Check-in state: Rider r1');
    await dlg.getByRole('button', { name: /Late, on the way/ }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ staff_state: 'late' });
    await expect(page.locator('#tab-queue tr[data-id="r1"] .n6c-st')).toHaveText('Late, on the way');
  });

  test('Running late? goes to riders not here once the ride began; Close out names them "messaged, no reply"', async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as { open: unknown }).open = () => null; });
    await desk(page, [sess('s1', TODAY)], [bk('r1', 's1', TODAY, 1), bk('r2', 's1', TODAY, 2, { status: 'active', checked_in_at: new Date().toISOString() })]);
    const patches = patchesOf(page, 'late_msg_at');
    await page.evaluate(`openRemindSheet('s1','late')`);
    const dlg = page.locator('#confirm-modal');
    await expect(dlg.locator('.rem-row')).toHaveCount(1);
    await expect(dlg.locator('.rem-row')).toContainText('Rider r1');
    await dlg.locator('.rem-send').click();
    await expect.poll(() => patches.length).toBe(1);
    expect(Object.keys(patches[0])).toEqual(['late_msg_at']);
    await page.evaluate(`_remClose()`);
    await page.evaluate(`(()=>{const e=_qGet('r1');e.lateMsgAt=e.lateMsgAt||new Date().toISOString();})()`);
    void page.evaluate(`closeOutSession('s1')`);
    await expect(dlg.locator('.n6c-co')).toContainText('Rider r1');
    await expect(dlg.locator('.n6c-co')).toContainText('no reply');
  });

  test('keys on the marked row: X asks before a no-show, Enter returns a rider on a bike; search takes the cursor back', async ({ page }) => {
    const D = ksaDay(Date.now() + 864e5);
    await desk(page, [sess('s1', D)], [bk('r1', 's1', D, 1, { status: 'active', checked_in_at: new Date().toISOString() }), bk('r2', 's1', D, 2)]);
    await page.evaluate(`window.__ret=null;window.doReturn=id=>{window.__ret=id;}`);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.evaluate(`document.activeElement&&document.activeElement.blur&&document.activeElement.blur()`);
    await page.keyboard.press('j');
    await expect.poll(() => page.evaluate('S._kbRowId')).toBe('r1');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate('window.__ret')).toBe('r1');
    await page.keyboard.press('j');
    await expect.poll(() => page.evaluate('S._kbRowId')).toBe('r2');
    await page.keyboard.press('x');
    const dlg = page.locator('#confirm-modal');
    await expect(dlg).toContainText('Mark #2 Rider r2 as a no-show?');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(`_qGet('r2').status`)).toBe('waiting');

    await page.evaluate(`S.sfSearch='Rider';renderStaffQueue();_n6cSearchBack()`);
    await expect.poll(() => page.evaluate(`document.activeElement&&document.activeElement.id`)).toBe('sf-search-input');
  });
});
