import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-18: "in the filters for customers and community members add a filter that says flagged and
// what is flagged and allow multi select". The Filter button's Flagged fold ticks one field or several (or Any
// field); an account shows when staff asked it to correct any picked field.

const customers = [
  { id: 'c1', name: 'Huda Saleh', email: 'huda@example.test', phone: '+966551230001', fix_fields: ['name', 'phone'], created_at: '2026-01-05T10:00:00Z' },
  { id: 'c2', name: 'Karim Mansour', email: 'karim@example.test', phone: '+966551230002', fix_fields: ['photo'], created_at: '2026-02-05T10:00:00Z' },
  { id: 'c3', name: 'Zaid Newcomer', email: 'zaid@example.test', phone: '+966551230003', fix_fields: [], created_at: '2026-09-05T10:00:00Z' },
];
const sessions = [
  { id: '2026-08-25', day: 'Tuesday', session_date: '2026-08-25', capacity: 12, status: 'closed', created_at: 2, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' },
];
const queue_entries = [{ id: 'q1', customer_id: 'c1', session_id: '2026-08-25', session_day: 'Tuesday', session_date: '2026-08-25', queue_num: 1, name: 'c1', type_preference: 'Road', size: 'M', status: 'done', paid: true, price: 75, registered_at: '2026-08-01T10:00:00Z' }];
const tags = [{ id: 'tag_saturday', name: 'Community', color: '#0c7a3d', locked: true, auto_grant: false }];
const customer_tags = ['c1', 'c2', 'c3'].map((id) => ({ customer_id: id, tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 }));

async function open(page: Page, sec: 'customers' | 'community') {
  await stubSupabase(page, { sessions, queue_entries, bikes: [], customers, tags, customer_tags, customer_flags: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0&&(S.queue||[]).length>0');
  await page.evaluate(sec === 'customers'
    ? `setStaffTab('customers');S.customersTab='accounts';renderCustomers()`
    : `setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
  await page.locator('[aria-controls="fm-am"]').click();
}
const rows = (page: Page) => page.locator('#am-cust-rows .am-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-cust')));

test.describe('@staff:flagged filter', () => {
  for (const sec of ['customers', 'community'] as const) {
    test(`${sec}: Flagged takes several fields, stays open while ticking, Reset clears it`, async ({ page }) => {
      await open(page, sec);
      const fold = page.locator('#fm-am details.filter-multi');
      await expect(fold.locator('summary')).toHaveText('All');
      await fold.locator('summary').click();
      const box = (v: string) => fold.locator(`input[value="${v}"]`);
      await box('phone').check();
      expect(await rows(page)).toEqual(['c1']);
      await expect(fold).toHaveAttribute('open', '');
      await box('photo').check();
      expect(await rows(page)).toEqual(['c2', 'c1']);
      await expect(fold.locator('summary')).toHaveText('Phone Number, Profile photo');
      await expect(page.locator('[aria-controls="fm-am"]')).toContainText('(1)');
      await box('phone').uncheck();
      expect(await rows(page)).toEqual(['c2']);
      await box('photo').uncheck();
      expect(await rows(page)).toEqual(['c3', 'c2', 'c1']);
      await box('any').check();
      expect(await rows(page)).toEqual(['c2', 'c1']);
      await page.locator('#fm-am .am-reset').click();
      expect(await rows(page)).toEqual(['c3', 'c2', 'c1']);
      await expect(page.locator('#fm-am details.filter-multi summary')).toHaveText('All');
    });
  }
});
