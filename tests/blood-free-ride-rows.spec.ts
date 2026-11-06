import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Blood Donation free rides on Bookings (the owner, 2026-11-06: "in the staff bookings table show the bookings that
// are because of the free ride code used make it themed in red for the blood donation event"). A booking made with a
// BD- code wears a red band down its start edge, a red tint, a red name and a red drop after the name, on the table and the phone cards; any other
// code, or none, does not. All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const row = (n: number, name: string, x: Record<string, unknown> = {}) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: null, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 0, registered_at: '2026-11-06T10:00:00Z', ...x,
});
const queue_entries = [
  row(1, 'Dana Donor', { promo_code: 'BD-1A2B3C4D' }),
  row(2, 'Vic Visitor', { promo_code: 'bd-99887766', status: 'active' }),
  row(3, 'Pat Promo', { promo_code: 'SUMMER10', price: 68 }),
  row(4, 'Nora Nobody', { price: 75 }),
];

async function boot(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 1000 });
  await stubSupabase(page, { sessions, queue_entries, bikes: [], staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${LIVE}';S.sfShowFinished=true;renderStaffQueue()`);
}
const tr = (page: Page, id: string) => page.locator(`#tab-queue .queue-table tbody tr[data-id="${id}"]`);

test.describe('@staff Blood Donation free rides on Bookings', () => {
  test('a booking made with a BD- code is red on the table and the phone cards; other codes are not', async ({ page }) => {
    await boot(page);
    await expect(tr(page, 'q1')).toHaveClass(/\bbdf-row\b/);
    await expect(tr(page, 'q2')).toHaveClass(/\bbdf-row\b/);
    await expect(tr(page, 'q3')).not.toHaveClass(/\bbdf-row\b/);
    await expect(tr(page, 'q4')).not.toHaveClass(/\bbdf-row\b/);
    const mk = tr(page, 'q1').locator('.bdf-mk');
    await expect(mk).toHaveAttribute('title', 'Free ride code · BD-1A2B3C4D');
    await expect(mk).toHaveCSS('background-color', 'rgb(200, 16, 46)');
    await expect(tr(page, 'q3').locator('.bdf-mk')).toHaveCount(0);
    await expect(tr(page, 'q1').locator('.rider-name').first()).toHaveCSS('color', 'rgb(165, 13, 38)');
    const bg = await tr(page, 'q1').locator('td').nth(1).evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bg).toContain('rgba(200, 16, 46, 0.2)');
    // the red band down the start edge
    const sh = await tr(page, 'q1').locator('td').first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(sh).toContain('rgb(200, 16, 46)');
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/bdf-roster.png` });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(`renderStaffQueue()`);
    const card = page.locator('#tab-queue .queue-mobile-view .q-card[data-id="q1"]');
    await expect(card).toHaveClass(/\bbdf-row\b/);
    await expect(card.locator('.bdf-mk')).toHaveCount(1);
    await expect(page.locator('#tab-queue .queue-mobile-view .q-card[data-id="q4"]')).not.toHaveClass(/\bbdf-row\b/);
  });
});
