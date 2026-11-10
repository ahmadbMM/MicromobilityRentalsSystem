import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Community (Saturday) sessions are invite-only, solo, and approval-based — they must
// never appear as a reschedule target, or a multi-rider JCC group could be moved in past
// the members gate (the Lubna case). A DB update-trigger backstops this server-side.
test('customer reschedule never offers a community session as a target', async ({ page }) => {
  const sessions = [
    { id: 's-jcc1', day: 'Tuesday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 },
    { id: 's-jcc2', day: 'Friday', session_date: '2099-02-13', capacity: 12, status: 'open', created_at: 2 },
    { id: 's-sat', day: 'Saturday', session_date: '2099-02-14', capacity: 12, status: 'open', created_at: 3, event_kind: 'community', title: 'Saturday Social Ride' },
  ];
  const queue_entries = [{ id: 'e1', session_id: 's-jcc1', session_day: 'Tuesday', session_date: '2099-02-10', queue_num: 1, name: 'Spec Rider', phone: '0500000001', customer_id: 'c1', type_preference: 'Road', status: 'waiting', paid: false, price: 30, registered_at: '2099-01-01T10:00:00Z' }];
  await stubSupabase(page, { sessions, queue_entries });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(() => {
    // @ts-expect-error app globals
    S.loggedIn = getSession();
    // @ts-expect-error app globals
    showRescheduleModal('s-jcc1');
  });

  const modal = page.locator('#reschedule-modal');
  await expect(modal.getByText('Friday')).toBeVisible(); // the other JCC session is offered
  await expect(modal.locator('.dk-rs-opt', { hasText: 'Friday' })).toContainText('9 AM - 11 AM'); // with its times (2026-11-10)
  await expect(modal.getByText('Saturday')).toHaveCount(0); // the community ride never is
});
