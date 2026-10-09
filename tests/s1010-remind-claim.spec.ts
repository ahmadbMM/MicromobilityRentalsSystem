import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, waitForSb } from './helpers/supabase';

// A freed waitlist place, claimed by the rider (2026-10-09, R7): /?claim=<token> from the WhatsApp staff sent.
// customer_claim_get shows the ride and how long the offer holds; customer_claim_spot checks the window and
// the room on the server (20261009225000).
const token = 'cd'.repeat(16);
const offer = (extra: Record<string, unknown> = {}) => ({
  ok: true, status: 'open', expires_at: new Date(Date.now() + 25 * 60000).toISOString(), now: new Date().toISOString(),
  first_name: 'Sara', booking_status: 'waitlist', queue_num: 14,
  session: { id: 's1', date: '2099-01-09', time: '19:00 - 21:00', title: 'Corniche Night Ride', ride_kind: 'jcc' }, ...extra,
});
async function open(page: Page, fx: Record<string, unknown>, q = '') {
  await stubSupabase(page, { sessions: [], ...fx });
  await page.goto('/?claim=' + token + q);
  await waitForSb(page);
}

test.describe('@customer:claim waitlist place', () => {
  test('the page shows the ride and the time left; Claim books the place', async ({ page }) => {
    const calls: { name: string; body: unknown }[] = [];
    page.on('request', (r) => { const m = r.url().match(/\/rpc\/(customer_claim_\w+)/); if (m) calls.push({ name: m[1], body: r.postDataJSON() }); });
    await open(page, { 'rpc:customer_claim_get': offer(), 'rpc:customer_claim_spot': { ok: true, queue_num: 14 } });
    const box = page.locator('#wl-claim [role="dialog"]');
    await expect(box.locator('#wlc-title')).toHaveText('A place is free for you');
    await expect(box).toContainText('Corniche Night Ride');
    await expect(box.locator('#wlc-clock')).toHaveText(/^2[45]:\d\d$/);
    expect(new URL(page.url()).search).toBe(''); // the token comes off the address bar
    await box.getByRole('button', { name: 'Claim my place' }).click();
    await expect(box.locator('#wlc-title')).toHaveText('Your place is booked');
    expect(calls.find((c) => c.name === 'customer_claim_spot')!.body).toEqual({ p_token: token, p_decline: false });
    await expect(box.getByRole('link', { name: 'My Bookings' })).toHaveAttribute('href', '/my-bookings');
  });

  test("I can't come hands the place on", async ({ page }) => {
    await open(page, { 'rpc:customer_claim_get': offer(), 'rpc:customer_claim_spot': { ok: true, declined: true } });
    await page.getByRole('button', { name: "I can't come" }).click();
    await expect(page.locator('#wlc-title')).toHaveText('Thank you for telling us');
  });

  test('an offer that ran out says so, and a place taken first says so', async ({ page }) => {
    await open(page, { 'rpc:customer_claim_get': offer({ status: 'expired' }) });
    await expect(page.locator('#wlc-title')).toHaveText('This offer has ended');
    await expect(page.locator('#wl-claim')).toContainText('still on the waitlist');
  });

  test('a claim the server finds full keeps the rider on the waitlist', async ({ page }) => {
    await open(page, { 'rpc:customer_claim_get': offer(), 'rpc:customer_claim_spot': { ok: false, reason: 'FULL' } });
    await page.getByRole('button', { name: 'Claim my place' }).click();
    await expect(page.locator('#wl-claim')).toContainText('taken before you claimed it');
  });

  test('in Arabic the page reads right to left in Arabic', async ({ page }) => {
    await open(page, { 'rpc:customer_claim_get': offer() }, '&lang=ar');
    await expect(page.locator('#wlc-title')).toHaveText('يوجد مكان شاغر لك');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('before the database has the offers, the page offers a retry and nothing else', async ({ page }) => {
    await open(page, {});
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim my place' })).toHaveCount(0);
  });
});
