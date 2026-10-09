import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Front desk 2026-10-09 (s1009-desk): Close out asks about each bike still out (B1) - ticked back, Damaged
// or Missing; a bike left unmarked stays out with its rider - and ends in the night's summary (D12): riders
// done and no-shows, money by method, who still owes, damaged / missing / still-out bikes, Count the drawer
// and Print. Invented riders and bikes only.

type Row = Record<string, unknown>;
const OLD = '2020-02-02';
const sessions = [{ id: OLD, session_date: OLD, day: 'Sunday', status: 'closed', capacity: 10, created_at: 1 }];
const row = (id: string, num: number, status: string, x: Row = {}): Row => ({
  id, session_id: OLD, session_day: 'Sunday', session_date: OLD, queue_num: num, name: 'Rider ' + id.toUpperCase(),
  phone: '', customer_id: null, group_id: null, status, paid: true, price: 57.5, pay_method: 'card', walk_in: true,
  registered_at: `2020-01-01T10:0${num}:00Z`, type_preference: 'Road', size: 'M', ...x,
});
const bike = (id: string, n: number, status: string): Row => ({ id, name: 'Road ' + n, bike_number: n, type: 'Road', size: 'M', status, colors: [], color_names: [] });

function matches(r: Row, params: URLSearchParams) {
  for (const [k, v] of params) {
    const m = v.match(/^(eq|in|is)\.(.*)$/);
    if (!m || ['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const s = r[k] == null ? 'null' : String(r[k]);
    if (m[1] === 'eq' && s !== m[2]) return false;
    if (m[1] === 'is' && !(m[2] === 'null' ? r[k] == null : s === m[2])) return false;
    if (m[1] === 'in' && !m[2].replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')).includes(s)) return false;
  }
  return true;
}

async function boot(page: Page, q: Row[], bikes: Row[]) {
  await stubSupabase(page, { sessions, bikes });
  const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  const tables: Record<string, Row[]> = { queue_entries: q, bikes };
  const writes: { table: string; body: Row; url: string }[] = [];
  await page.route(/\/rest\/v1\/(queue_entries|bikes)(\?|$)/, async (route) => {
    const req = route.request(), url = new URL(req.url()), table = url.pathname.split('/').pop() as string, rows = tables[table];
    if (req.method() === 'GET') return route.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${rows.length}/${rows.length}` }, body: JSON.stringify(rows) });
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Row, hit = rows.filter((r) => matches(r, url.searchParams));
      hit.forEach((r) => Object.assign(r, body));
      writes.push({ table, body, url: decodeURIComponent(req.url()) });
      return route.fulfill({ status: 200, headers: head, body: JSON.stringify(hit) });
    }
    return route.fallback();
  });
  const returns: Row[] = [];
  await page.route(/\/rest\/v1\/rpc\/staff_return/, (r) => {
    const b = r.request().postDataJSON() as Row;
    returns.push(b);
    const e = q.find((x) => x.id === b.p_booking_id);
    if (e) { e.status = 'done'; bikes.filter((x) => x.id === e.assigned_bike_id).forEach((x) => { x.status = b.p_return_condition === 'damaged' ? 'maintenance' : 'available'; }); }
    return r.fulfill({ status: 200, headers: head, body: JSON.stringify({ ok: true, noop: false, bikes_freed: 1 }) });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  return { writes, returns };
}

test.describe('@staff:bookings s1009 desk: close out', () => {
  test('B1 + D12: only ticked bikes come back; an unmarked one stays out; the summary follows', async ({ page }) => {
    const q = [
      row('a', 1, 'active', { assigned_bike_id: 'b1', checked_in_at: '2020-02-02T18:00:00Z' }),
      row('b', 2, 'active', { assigned_bike_id: 'b2', checked_in_at: '2020-02-02T18:00:00Z' }),
      row('c', 3, 'waiting', { checked_in_at: '2020-02-02T18:05:00Z', paid: false, pay_method: null }),
      row('n', 4, 'waiting'),
    ];
    const bikes = [bike('b1', 1, 'in-use'), bike('b2', 2, 'in-use')];
    const { returns } = await boot(page, q, bikes);
    await page.evaluate(`closeOutSession('${OLD}')`);
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box.locator('.co-bike')).toHaveCount(2);
    await expect(box).toContainText('Bikes still out (2)');
    await box.locator('.co-bike').filter({ hasText: '#001' }).locator('.co-mk-ok').click();
    await expect(box.locator('.co-bike').filter({ hasText: '#001' }).locator('.co-mk-ok')).toHaveAttribute('aria-pressed', 'true');
    await box.getByRole('button', { name: /^close out$/i }).click();
    await expect.poll(() => returns.length).toBe(1);
    expect(returns[0]).toMatchObject({ p_booking_id: 'a', p_return_condition: 'ok' });
    await expect.poll(() => q[3].status).toBe('noshow');
    expect(q[1].status).toBe('active');   // bike 002 was not marked: still out with its rider
    expect(bikes[1].status).toBe('in-use');
    // the summary, centred, in its own host
    const sum = page.locator('#eon-modal [role="dialog"]');
    await expect(sum).toBeVisible();
    await expect(sum).toContainText('Night summary');
    await expect(sum).toContainText('Bikes still out');
    await expect(sum).toContainText('#002');
    await expect(sum).toContainText('Still owing');
    await expect(sum).toContainText('Rider C');
    await expect(sum).toContainText('Card');
    // Count the drawer opens the till's count over it
    await sum.locator('#eon-count').click();
    await expect(page.locator('#confirm-modal')).toContainText(/drawer/i);
  });

  test('B1: Damaged returns as damaged, Missing takes the bike out of the pool; Print opens the close-out report', async ({ page }) => {
    const q = [
      row('a', 1, 'active', { assigned_bike_id: 'b1' }),
      row('b', 2, 'active', { assigned_bike_id: 'b2' }),
    ];
    const bikes = [bike('b1', 1, 'in-use'), bike('b2', 2, 'in-use')];
    const { returns, writes } = await boot(page, q, bikes);
    await page.evaluate(`closeOutSession('${OLD}')`);
    const box = page.locator('#confirm-modal .confirm-box');
    await box.locator('.co-bike').filter({ hasText: '#001' }).locator('.co-mk-damaged').click();
    await box.locator('.co-bike').filter({ hasText: '#002' }).locator('.co-mk-missing').click();
    await box.getByRole('button', { name: /^close out$/i }).click();
    await expect.poll(() => returns.length).toBe(2);
    expect(returns.find((r) => r.p_booking_id === 'a')).toMatchObject({ p_return_condition: 'damaged' });
    expect(returns.find((r) => r.p_booking_id === 'b')).toMatchObject({ p_return_condition: 'needs_check' });
    await expect.poll(() => writes.some((w) => w.table === 'bikes' && w.body.status === 'missing' && w.url.includes('id=eq.b2'))).toBe(true);
    expect(bikes[1].status).toBe('missing');
    const sum = page.locator('#eon-modal [role="dialog"]');
    await expect(sum).toContainText('Damaged bikes');
    await expect(sum).toContainText('Missing bikes');
    const printed = await page.evaluate(`(()=>{let cap='';const o=window.open;window.open=()=>({document:{write:(h)=>{cap=h;},close(){}},focus(){},print(){}});try{_eonPrint();}finally{window.open=o;}return cap.length>0;})()`);
    expect(printed).toBe(true);
  });
});
