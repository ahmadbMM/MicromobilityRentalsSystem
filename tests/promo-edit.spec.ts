import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// An admin edits a promo code in place (2026-10-11): Edit fills the add form with the code, the
// text stays fixed (bookings carry the code by its text), and Save Changes writes every field, so a
// cleared limit comes off. Cancel leaves the form empty and the code untouched.
const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const promo_codes = [{
  id: 'p1', code: 'SUMMER10', kind: 'percent', value: 10, active: true, applies_to: null,
  expires_at: '2099-12-31', max_uses: 5, uses: 2, customer_id: null, created_at: '2099-01-01',
}];

test.describe('@staff:sessions promo code edit', () => {
  test('Edit fills the form, keeps the text, and Save Changes updates the code', async ({ page }) => {
    await stubSupabase(page, { sessions, promo_codes, queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const patches: Record<string, unknown>[] = [];
    let posts = 0;
    page.on('request', (r) => {
      if (!r.url().includes('/rest/v1/promo_codes')) return;
      if (r.method() === 'PATCH') { try { patches.push(r.postDataJSON()); } catch { /* */ } }
      if (r.method() === 'POST') posts++;
    });
    await page.evaluate(`setStaffTab('sessions')`);
    const row = page.locator('.pc-wrap tbody tr', { hasText: 'SUMMER10' });
    await row.getByRole('button', { name: 'Edit' }).click();

    await expect(page.locator('#pc-code')).toHaveValue('SUMMER10');
    await expect(page.locator('#pc-code')).toHaveAttribute('readonly', '');
    await expect(page.locator('#pc-value')).toHaveValue('10');
    await expect(page.locator('#pc-max')).toHaveValue('5');
    await expect(page.locator('#pc-expires')).toHaveValue('2099-12-31');
    await expect(row).toHaveAttribute('aria-current', 'true');

    await page.locator('#pc-value').fill('20');
    await page.locator('#pc-max').fill('');
    await page.locator('.pc-form').getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ kind: 'percent', value: 20, applies_to: null, expires_at: '2099-12-31', max_uses: null, customer_id: null });
    expect(posts).toBe(0); // an edit is not a second code
    // back to an empty add form
    await expect(page.locator('#pc-code')).toHaveValue('');
    await expect(page.locator('.pc-form').getByRole('button', { name: '+ Add code' })).toBeVisible();
  });

  test('Cancel leaves the code as it was', async ({ page }) => {
    await stubSupabase(page, { sessions, promo_codes, queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    let writes = 0;
    page.on('request', (r) => { if (r.url().includes('/rest/v1/promo_codes') && r.method() !== 'GET') writes++; });
    await page.evaluate(`setStaffTab('sessions')`);
    await page.locator('.pc-wrap tbody tr', { hasText: 'SUMMER10' }).getByRole('button', { name: 'Edit' }).click();
    await page.locator('#pc-value').fill('50');
    await page.locator('.pc-form').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#pc-code')).toHaveValue('');
    await expect(page.locator('#pc-code')).not.toHaveAttribute('readonly', '');
    expect(writes).toBe(0);
  });
});
