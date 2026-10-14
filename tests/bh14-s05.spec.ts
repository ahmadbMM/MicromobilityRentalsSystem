import { test, expect } from '@playwright/test';
import { stubSupabase, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-14 (s05): the page behind the forced pop-ups stays still while another one is still up.
const token = 'ef'.repeat(16);
const offer = {
  ok: true, status: 'open', expires_at: new Date(Date.now() + 25 * 60000).toISOString(),
  first_name: 'Sara', booking_status: 'waitlist', queue_num: 14,
  session: { id: 's1', date: '2099-01-09', time: '19:00 - 21:00', title: 'Corniche Night Ride', ride_kind: 'jcc' },
};

test.describe('@bh14 s05', () => {
  test('closing one forced page leaves the page still while another is up', async ({ page }) => {
    await stubSupabase(page, { sessions: [], 'rpc:customer_claim_get': offer });
    await page.goto('/?claim=' + token);
    await waitForSb(page);
    await expect(page.locator('#wlc-title')).toHaveText('A place is free for you');
    await page.evaluate('S._afx = { state: "loading" }; _wlcClose();'); // an applicant's page still up underneath
    await expect(page.locator('body')).toHaveClass(/fix-open/);
    await page.evaluate('S._afx = null; _fixOpenSync();');
    await expect(page.locator('body')).not.toHaveClass(/fix-open/);
  });
});
