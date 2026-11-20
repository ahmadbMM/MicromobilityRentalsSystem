import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// When a booking was cancelled (the user, 2026-11-20: "whenever anyone cancels their booking show the time of
// cancellation too"): beside "Cancelled by ..." the server's own stamp (cancelled_at) reads "Cancelled: 15 Oct 2099,
// 14:32" (Riyadh time), on the staff roster and on the rider's own Bookings page. A row cancelled before the column
// existed has no stamp and says nothing more; a booking taken back off cancelled shows none either.

const J = '2099-10-18';
const sessions = [{ id: J, day: 'Sunday', session_date: J, capacity: 12, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' }];
const row = (n: number, name: string, x: Record<string, unknown> = {}) => ({
  id: 'q' + n, name, session_id: J, session_day: 'Sunday', session_date: J, queue_num: n, status: 'waiting', paid: false,
  price: 75, registered_at: J + 'T10:00:00Z', type_preference: 'Road', size: 'M', phone: '05500000' + String(n).padStart(2, '0'), ...x });

async function roster(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [
    row(1, 'Stamped Rider', { status: 'cancelled', cancelled_by: 'customer', cancelled_at: '2099-10-15T11:32:00Z' }),
    row(2, 'Old Cancel', { status: 'cancelled', cancelled_by: 'staff' }),                       // before the column
    row(3, 'Back Again', { cancelled_at: '2099-10-14T08:00:00Z' }),                             // restored: waiting again
    row(4, 'Earlier Party', { status: 'cancelled', cancelled_by: 'customer', cancelled_at: '2099-10-15T09:05:00Z' }),
  ] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length===4');
}

test.describe('@staff:bookings a cancellation says when', () => {
  test('the roster row shows the time beside the badge; no stamp, or not cancelled, shows none', async ({ page }) => {
    await roster(page);
    await page.evaluate(`S.sfStatus='cancelled';renderStaffQueue()`);
    const tr = (name: string) => page.locator(`#tab-queue .queue-table-desktop-wrap tbody tr:has-text("${name}")`);
    await expect(tr('Stamped Rider').locator('.status-badge.st-cancelled')).toHaveText('Cancelled by Customer');
    // short on the roster's narrow second line (the badge above says Cancelled), the whole stamp on hover
    await expect(tr('Stamped Rider').locator('.cx-at')).toHaveText('15 Oct, 14:32');
    await expect(tr('Stamped Rider').locator('.cx-at')).toHaveAttribute('title', 'Cancelled: 15 Oct 2099, 14:32');
    await expect(tr('Old Cancel').locator('.status-badge.st-cancelled')).toHaveCount(1);
    await expect(tr('Old Cancel').locator('.cx-at')).toHaveCount(0);
    const o = JSON.parse(await page.evaluate(`JSON.stringify({
      back: _cxAtTxt(getQueue().find(x=>x.id==='q3')),
      party: _cxAtTxt(getQueue().filter(x=>x.id==='q1'||x.id==='q4')),
      none: _cxAtTxt(null),
    })`) as string);
    expect(o.back).toBe('');
    expect(o.party).toBe('Cancelled: 15 Oct 2099, 14:32'); // a party says its latest cancel
    expect(o.none).toBe('');
  });
});

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const off = (n: number) => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const jcc = (id: string, date: string) => ({ id, day: 'Sunday', session_date: date, capacity: 20, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' });
const bk = (id: string, sid: string, date: string, o: Record<string, unknown> = {}) => ({ id, name: 'Spec Rider', customer_id: 'c1', session_id: sid, session_day: 'Sunday', session_date: date, queue_num: 1, status: 'cancelled', paid: false, price: 75, type_preference: 'Road', registered_at: '2026-01-01T10:00:00Z', ...o });

test.describe('@customer:bookings a cancellation says when', () => {
  test('the cancelled row on the Bookings page carries the time it was cancelled', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('cq_lang', 'en'); localStorage.setItem('cq_lang_pick', '1');
      (window as unknown as Record<string, unknown>).__noRateGate = true;
    });
    await stubSupabase(page, { bikes: [], sessions: [jcc('c3', off(3)), jcc('c4', off(4))], queue_entries: [
      bk('qa1234567', 'c3', off(3), { cancelled_by: 'customer', cancelled_at: '2026-11-20T11:32:00Z' }),
      bk('qb1234567', 'c4', off(4), { cancelled_by: 'staff' }),
    ], 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`goCustomer('myrides')`);
    const rows = page.locator('#tab-myrides .mr-cx');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Cancelled by you');
    await expect(rows.nth(0).locator('.mr-cx-at')).toHaveText('Cancelled: 20 Nov 2026, 14:32');
    await expect(rows.nth(1)).toContainText('Cancelled by us');
    await expect(rows.nth(1).locator('.mr-cx-at')).toHaveCount(0);
  });
});
