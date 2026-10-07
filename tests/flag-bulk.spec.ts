import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bulk flagging (2026-10-07: "add a bulk flagging and select all flagging method to save time"): the Accounts list's
// Select mode ticks many riders and asks them all at once, and the flag dialog's Select all ticks every field.
// A bulk ask ADDS to what each rider is already asked; it never replaces another desk's request.

const customers = [
  { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', created_at: '2026-01-03T00:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar@example.com', phone: '+966500000002', fix_fields: ['phone'], created_at: '2026-01-02T00:00:00Z' },
  { id: 'c3', name: 'Lina Aziz', email: 'lina@example.com', phone: '+966500000003', created_at: '2026-01-01T00:00:00Z' },
];

test.describe('@staff:community bulk flagging', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, customer_flags: [], tags: [], customer_tags: [],
      'rpc:staff_flag_customer': { id: 1, status: 'pending' } });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
  });

  test('Select all in the dialog ticks every field, and again clears them', async ({ page }) => {
    await page.evaluate(`showFlagFieldsModal('c1')`);
    const dlg = page.locator('#confirm-modal .fl-box');
    const total = await dlg.locator('.fl-row').count();
    await dlg.locator('#fl-all').click();
    await expect(dlg.locator('.fl-row[aria-pressed="true"]')).toHaveCount(total);
    await expect(dlg.locator('#fl-send')).toContainText(`(${total})`);
    await expect(dlg.locator('#fl-all')).toHaveText('Clear all');
    await dlg.locator('#fl-all').click();
    await expect(dlg.locator('.fl-row[aria-pressed="true"]')).toHaveCount(0);
    await expect(dlg.locator('#fl-send')).toBeDisabled();
  });

  test('Select mode flags many accounts at once, adding to what each is asked', async ({ page }) => {
    const calls: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/staff_flag_customer/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });
    await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
    await page.evaluate(`_amSelMode()`);
    const bar = page.locator('#am-sel-bar');
    await expect(bar.locator('.am-selgo')).toBeDisabled();
    await page.locator('.am-row[data-cust="c2"] .am-sel').click();
    await expect(page.locator('.am-row[data-cust="c2"] .am-sel')).toHaveAttribute('aria-pressed', 'true');
    await expect(bar.locator('.am-seln')).toHaveText('Selected: 1');
    await bar.getByRole('button', { name: 'Select all (3)' }).click();
    await expect(bar.locator('.am-seln')).toHaveText('Selected: 3');
    await expect(page.locator('#am-cust-rows .am-sel[aria-pressed="true"]')).toHaveCount(3);
    await bar.locator('.am-selgo').click();
    const dlg = page.locator('#confirm-modal .fl-box');
    await expect(dlg.locator('.fl-sub')).toContainText('Accounts selected: 3');
    await dlg.locator('.fl-row[data-flag="email"]').click();
    await dlg.locator('#fl-send').click();
    await expect.poll(() => calls.length).toBe(3);
    const byId = Object.fromEntries(calls.map((c) => [c.p_customer_id, c.p_fields]));
    expect(byId).toEqual({ c1: ['email'], c2: ['email', 'phone'], c3: ['email'] });
    await expect(page.locator('#confirm-modal .fl-box')).toHaveCount(0);
    expect(await page.evaluate('S.amSel')).toBeNull();
  });
});
