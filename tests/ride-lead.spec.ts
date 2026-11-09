import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Ride lead (2026-11-06, the owner: "assign ride lead on customers that already have a bookings so it counts towards
// their account"; picked "Lead tally + Marshal badge", set from the booking on Bookings): queue_entries.led_at
// (20261106130000). Staff mark it from the booking's menu, asked first; a night led counts once the rider is checked
// in: "Rides led" on the account, and the Marshal ladder (1 / 10 / 25 / 50 / 100) earned from that count.

const sess = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, day: 'Sunday', session_date: date, capacity: 40, status: 'open', created_at: 1, location: 'JCC',
  bike_slots: '{"_time":"21:00 - 23:00","_total":40}', ...over,
});
const bk = (id: string, sid: string, date: string, n: number, over: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: date, queue_num: n, name: `Rider ${id}`,
  phone: `05500000${String(n).padStart(2, '0')}`, customer_id: null, type_preference: 'Road', size: 'M', height: 178,
  status: 'waiting', paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z', ...over,
});

test.describe('@customer:account Ride lead', () => {
  const marshal = { id: 'bd_marshal', slug: 'marshal', icon: 'shield', color: 'orange', name: 'Marshal', system: true, auto: false, retired: false, sort: 10 };
  async function rider(page: Page, rows: Record<string, unknown>[]) {
    await stubSupabase(page, { queue_entries: rows, 'rpc:my_bookings': rows, 'rpc:badge_catalog': [marshal] });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account','stats')`); // the season is the account's Stats part (2026-11-09)
  }

  test('nights led and checked in count: Rides led and the Marshal badge; not checked in, or not led, do not', async ({ page }) => {
    const L = '2099-01-01T18:00:00Z';
    await rider(page, [
      bk('a', '2020-01-05', '2020-01-05', 1, { customer_id: 'c1', status: 'done', paid: true, led_at: L }),
      bk('b', '2020-01-12', '2020-01-12', 1, { customer_id: 'c1', status: 'done', paid: true, led_at: L }),
      bk('c', '2020-01-19', '2020-01-19', 1, { customer_id: 'c1', status: 'noshow', led_at: L }),
      bk('d', '2020-01-26', '2020-01-26', 1, { customer_id: 'c1', status: 'done', paid: true }),
    ]);
    await expect(page.locator('#tab-account .mr-season')).toContainText('Rides led: 2');
    expect(await page.evaluate(`_ledN(getQueue())`)).toBe(2);
    const pop = page.locator('#badge-pop');
    if (await pop.isVisible()) await pop.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#tab-account .mr-badges .mr-badge', { hasText: 'Marshal' })).toHaveCount(1);
  });

  test('no nights led: no Rides led line and no Marshal badge earned', async ({ page }) => {
    await rider(page, [bk('d', '2020-01-26', '2020-01-26', 1, { customer_id: 'c1', status: 'done', paid: true })]);
    await expect(page.locator('#tab-account .mr-season')).toBeVisible();
    await expect(page.locator('#tab-account .mr-season')).not.toContainText('Rides led');
    expect(await page.evaluate(`_mrBadges(getQueue(),getQueue(),[],null).filter(r=>r.s==='marshal').map(r=>[r.on,r.p])`)).toEqual([[false, '0/1']]);
  });
});

test.describe('@staff:bookings Ride lead', () => {
  test('the booking menu marks a rider as the ride lead, asked first, and can take it back', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const D = new Date(Date.now() + 3 * 3600e3 + 864e5).toISOString().slice(0, 10);
    const rows = [bk('r1', 's1', D, 1, { customer_id: 'c1' }), bk('r2', 's1', D, 2)];
    await stubSupabase(page, { sessions: [sess('s1', D)], bikes: [], queue_entries: rows, customers: [] });
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && /\/rest\/v1\/queue_entries/.test(r.url()) && /led_at/.test(r.postData() || '')) patches.push(r.postDataJSON());
    });
    // The stub echoes writes without keeping them: the reload after a save reads the mark as saved.
    await page.route(/\/rest\/v1\/queue_entries/, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const led = patches.length ? patches[patches.length - 1].led_at : null;
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify(rows.map((x) => (x.id === 'r1' ? { ...x, led_at: led } : x))) });
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='s1';renderStaffQueue()`);
    // offered on the booking with an account only: it counts on that account
    const labels = (id: string) => page.evaluate(`((S._rowMenus||{})['${id}']||[]).map(x=>x.label.replace(/<[^>]*>/g,'').trim())`);
    await expect.poll(() => labels('r1')).toContain('Mark as ride lead');
    expect(await labels('r2')).not.toContain('Mark as ride lead');

    const ask = page.locator('#confirm-modal');
    void page.evaluate(`void _leadToggle('r1')`).catch(() => {});
    await expect(ask).toContainText('Is Rider r1 leading this ride?');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(100);
    expect(patches).toEqual([]);

    void page.evaluate(`void _leadToggle('r1')`).catch(() => {});
    await ask.getByRole('button', { name: 'Mark as ride lead' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(String(patches[0].led_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    await expect(page.locator('#tab-queue .lead-mk')).toHaveCount(1);
    await expect.poll(() => labels('r1')).toContain('Not the ride lead');

    void page.evaluate(`void _leadToggle('r1')`).catch(() => {});
    await expect(ask).toContainText('Take back ride lead from Rider r1?');
    await ask.getByRole('button', { name: 'Not the ride lead' }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toEqual({ led_at: null });
  });
});
