import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// History > Audit trail's free-text box (2026-10-09, migration 20261009206000): staff_audit_search looks inside the
// changed values and the record id on the server; before it exists only the rows the other filters read are searched.
const TOMORROW = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const NOW = new Date().toISOString();
const sessions = [{ id: 's0', day: 'Friday', session_date: TOMORROW, capacity: 12, status: 'open', created_at: 1 }];
const q1 = { id: 'q1', session_id: 's0', session_day: 'Friday', session_date: TOMORROW, queue_num: 7, name: 'Rider One', phone: '0500000001', status: 'waiting', paid: false, price: 75, type_preference: 'Road', registered_at: '2026-01-01T10:00:00Z' };
const audit = [
  { id: 9, at: NOW, actor: null, actor_email: null, tbl: 'queue_entries', row_id: 'q1', op: 'UPDATE', changed: { price: { old: 75, new: 0 } } },
  { id: 8, at: NOW, actor: null, actor_email: null, tbl: 'customers', row_id: 'c42', op: 'UPDATE', changed: { name: { old: 'Lina Hadad', new: 'Lina Haddad' } } },
];

async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [q1], bikes: [], audit_log: audit, 'rpc:staff_people': [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`S.staffRole='admin';setStaffTab('history');S.histView='audit';renderHistory()`);
  await expect(page.locator('#mny-host')).toContainText('Bookings');
}

test.describe('@staff:history audit trail text search', () => {
  test('the box asks the server with the other filters and lists what it answers', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await boot(page, { 'rpc:staff_audit_search': [audit[1]] });
    page.on('request', (r) => { if (r.url().includes('/rpc/staff_audit_search')) sent.push(r.postDataJSON()); });
    const box = page.locator('#aus-q');
    await expect(box).toHaveAttribute('aria-label', 'Search');
    await box.fill('haddad');
    await box.press('Enter');
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ p_q: 'haddad', p_limit: 100 });
    expect(sent[0].p_from).toBeTruthy();
    const host = page.locator('#mny-host');
    await expect(host.locator('.mny-au-row')).toHaveCount(1);
    await expect(host).toContainText('Lina Haddad');
    await expect(host.locator('.aus-local')).toHaveCount(0);
  });

  test('before the database update the rows read are searched here, and the page says so', async ({ page }) => {
    await boot(page);
    const box = page.locator('#aus-q');
    await box.fill('haddad');
    await box.press('Enter');
    const host = page.locator('#mny-host');
    await expect(host.locator('.aus-local')).toBeVisible();
    await expect(host.locator('.mny-au-row')).toHaveCount(1);
    await expect(host).toContainText('Lina Haddad');
  });
});
