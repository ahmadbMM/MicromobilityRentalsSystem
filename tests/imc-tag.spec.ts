import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The IMC tag (the owner, 2026-11-13: "create a new tag call it IMC and let the attached logo to be what's inside the
// tag but only the image and IMC letters", then "and show the tag on their bookings"). IMC's arch and letters on a
// white chip edged in IMC blue, and the same logo after the holder's name on their bookings. Hiding the tag takes it
// off. All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const IMC_BLUE = 'rgb(14, 85, 146)';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const baseTags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#0c7a3d', locked: true, auto_grant: false },
  { id: 'tag_imc', slug: 'imc', name: 'IMC', color: '#0e5592', locked: true, auto_grant: false },
];
const cust = (id: string, name: string) => ({ id, name, email: id + '@example.test', phone: '05000000' + id.slice(1).padStart(2, '0'), height: 170, created_at: '2026-01-01T00:00:00Z' });
const customers = [cust('c1', 'Ida Imc'), cust('c2', 'Nora Nobody'), cust('c3', 'Lapsed Imc')];
const customer_tags = [
  { customer_id: 'c1', tag_id: 'tag_imc', added_by: 'staff', added_at: 1 },
  { customer_id: 'c3', tag_id: 'tag_imc', added_by: 'staff', added_at: 1, expires_at: 1000 },
];
const row = (n: number, cid: string, name: string) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-11-13T10:00:00Z',
});
const queue_entries = [row(1, 'c1', 'Ida Imc'), row(2, 'c2', 'Nora Nobody'), row(3, 'c3', 'Lapsed Imc')];

async function boot(page: Page, width = 1440, tags: Record<string, unknown>[] = baseTags) {
  await page.setViewportSize({ width, height: 1000 });
  await stubSupabase(page, { sessions, queue_entries, bikes: [], tags, customers, customer_tags, staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0&&(S.customerTags||[]).length>0');
}
const tr = (page: Page, id: string) => page.locator(`#tab-queue .queue-table tbody tr[data-id="${id}"]`);
const roster = (page: Page) => page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${LIVE}';S.sfShowFinished=true;renderStaffQueue()`);

test.describe('@staff:tags The IMC tag', () => {
  test('its chip is the IMC logo on white, edged in IMC blue, named by its title', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('customers');S.communityTab='accounts';renderCustomers()`);
    const chip = page.locator('#am-cust-rows .am-chip.tag-brand', { has: page.locator('img.tag-img-imc') }).first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(chip).toHaveCSS('border-top-color', IMC_BLUE);
    await expect(chip).toHaveAttribute('title', 'IMC');
    const img = chip.locator('img.tag-img-imc');
    await expect(img).toHaveAttribute('src', '/assets/tag-imc.png');
    await expect(img).toHaveAttribute('alt', 'IMC');
    // the file is there and it loads
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  });

  test('Bookings: the logo after a holder\'s name on the row and on the phone card, not after anyone else\'s', async ({ page }) => {
    await boot(page);
    await roster(page);
    const mk = tr(page, 'q1').locator('.imc-mk');
    await expect(mk).toHaveCount(1);
    await expect(mk).toHaveAttribute('title', 'IMC');
    await expect(mk).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(mk).toHaveCSS('border-top-color', IMC_BLUE);
    await expect(mk.locator('img')).toHaveAttribute('alt', 'IMC');
    await expect.poll(() => mk.locator('img').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
    await expect(tr(page, 'q2').locator('.imc-mk')).toHaveCount(0);
    // a grant that has run out is no longer marked
    await expect(tr(page, 'q3').locator('.imc-mk')).toHaveCount(0);
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/imc-roster.png` });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(`renderStaffQueue()`);
    await expect(page.locator('#tab-queue .queue-mobile-view .q-card[data-id="q1"] .imc-mk')).toHaveCount(1);
    await expect(page.locator('#tab-queue .queue-mobile-view .q-card[data-id="q2"] .imc-mk')).toHaveCount(0);
  });

  test('the printed sheets\' mark loads the logo from the site\'s own address', async ({ page }) => {
    await boot(page);
    const html: string = await page.evaluate(`_imcChip(getQueue().find(e=>e.id==='q1'))`);
    const origin: string = await page.evaluate('location.origin');
    expect(html).toContain('class="imc-mk"');
    expect(html).toContain(`src="${origin}/assets/tag-imc.png"`);
    expect(await page.evaluate(`_imcChip(getQueue().find(e=>e.id==='q2'))`)).toBe('');
  });

  test('hidden on the Tags page, it is off the bookings', async ({ page }) => {
    await boot(page, 1440, baseTags.map((t) => (t.id === 'tag_imc' ? { ...t, hidden_at: '2026-11-13T12:00:00Z', hidden_by: 'staff' } : t)));
    await roster(page);
    await expect(tr(page, 'q1')).toHaveCount(1);
    await expect(page.locator('#tab-queue .imc-mk')).toHaveCount(0);
  });
});
