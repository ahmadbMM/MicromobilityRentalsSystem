import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-14 (s04): the forgot-password screen's number, a Petromin night's rider cap
// for an account already holding a seat, and the old direct-table sign-in being gone.

test.describe('bh14 s04 @bh14', () => {
  test('the forgot-password screen shows the number its WhatsApp link goes to, not the business line', async ({ page }) => {
    await stubSupabase(page, {});
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('openAuthModal();switchAuthMode("forgot")');
    await expect(page.locator('#auth-modal a[href^="https://wa.me/966579543977?"]')).toHaveCount(1);
    await expect(page.locator('#auth-modal')).toContainText('+966 57 954 3977');
    await expect(page.locator('#auth-modal')).not.toContainText('56 666 8818');
  });

  test('a Petromin night offers only the seats the account has left', async ({ page }) => {
    const petromin = {
      id: '2099-01-13-pw', day: 'Wednesday', session_date: '2099-01-13', capacity: 10, status: 'open', created_at: 1,
      event_kind: 'community', ride_kind: 'petromin', paid_ride: true,
      needs_approval: false, hide_queue: false, spots: null, title: 'Petromin Wednesday Ride',
    };
    await stubSupabase(page, { sessions: [petromin], bikes: [], queue_entries: [], 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await waitForSb(page);
    const s = '_sessGet("2099-01-13-pw")';
    expect(await page.evaluate(`_maxRiders(${s})`)).toBe(2);
    await page.evaluate(`S.queue=[{id:'q1',customerId:'c1',sessionId:'2099-01-13-pw',status:'waiting',name:'Spec Rider',queueNum:1,typePreference:'Road'}]`);
    expect(await page.evaluate(`_maxRiders(${s})`)).toBe(1);
    // Changing that booking: its own waiting row is the quantity on screen, so both seats are offered.
    await page.evaluate(`S.modifyEntryId='q1'`);
    expect(await page.evaluate(`_maxRiders(${s})`)).toBe(2);
  });

  test('a refused sign-in never falls back to reading the customers table', async ({ page }) => {
    await stubSupabase(page, { 'rpc:customer_login': [] });
    const direct: string[] = [];
    page.on('request', (r) => { if (/\/rest\/v1\/customers\?/.test(r.url())) direct.push(r.url()); });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('openAuthModal()');
    await page.fill('#a-identifier', 'x@y.com');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.evaluate('doLogin()');
    await expect(page.locator('#auth-err')).not.toBeEmpty();
    expect(direct).toEqual([]);
  });
});
