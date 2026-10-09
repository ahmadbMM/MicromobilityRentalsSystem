import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Community > Accounts, 2026-09-22: one line per rider on an iPad or a laptop, where there is
// room for it; on a phone each rider is a card that shows the whole email and phone and every
// button, instead of a squeezed line with the email clipped.

const customers = [
  { id: 'c1', name: 'Sara Ali', email: 'sara.ali@gmail.com', phone: '+966561111111', created_at: '2026-01-05T10:00:00Z', gender: 'female' },
  { id: 'c2', name: 'Omar Al Harbi', email: 'omar.harbi@outlook.com', phone: '+966562222222', created_at: '2026-02-05T10:00:00Z', gender: 'male' },
];
type P = import('@playwright/test').Page;
async function accounts(page: P) {
  await stubSupabase(page, { sessions: [], queue_entries: [], customers, tags: [], customer_tags: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('customers');setCustomersTab('accounts')`);
  await expect(page.locator('#am-cust-rows .am-cust')).toHaveCount(2);
}
const row = (page: P) => page.locator('.am-row[data-cust="c1"] .am-cust');

test.describe('on a laptop or iPad', () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test('each rider is one line: name and contact beside the buttons', async ({ page }) => {
    await accounts(page);
    const box = await row(page).boundingBox();
    const actions = await row(page).locator('.am-cust-actions').boundingBox();
    const main = await row(page).locator('.am-cust-main').boundingBox();
    expect(box!.height).toBeLessThan(140);                    // a line, not a card
    expect(actions!.x).toBeGreaterThan(main!.x + main!.width - 1); // buttons sit after the details
    await expect(row(page).locator('.am-btn-lbl').first()).toBeHidden(); // icons carry no words here
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('each rider is a card with the whole contact and every button', async ({ page }) => {
    await accounts(page);
    const main = await row(page).locator('.am-cust-main').boundingBox();
    const actions = await row(page).locator('.am-cust-actions').boundingBox();
    expect(actions!.y).toBeGreaterThan(main!.y + main!.height - 1);   // buttons under the details
    // the email and phone read in full — no clipping
    const contact = row(page).locator('.am-cust-contact');
    await expect(contact).toContainText('sara.ali@gmail.com');
    expect(await contact.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    // all five buttons, each with its name on it
    const btns = row(page).locator('.am-cust-actions .btn-sm');
    await expect(btns).toHaveCount(5);
    for (const name of ['Ask to correct', 'Bookings & history', 'Save contact', 'Edit', 'Tags']) {
      await expect(row(page).locator('.am-cust-actions').getByText(name, { exact: true })).toBeVisible();
    }
    // and each button's words stay inside it
    for (const b of await btns.all()) {
      expect(await b.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    }
  });
});
