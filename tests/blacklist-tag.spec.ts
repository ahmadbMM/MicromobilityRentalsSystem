import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The blacklist tag: black, the white mark struck through, on an account that is not fit to be in
// the community. The Community grant and an application's approval point it out, and granting it to
// a member offers to take the Community tag away. All Supabase traffic is stubbed.

const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false },
  { id: 'tag_blacklist', slug: 'blacklist', name: 'Blacklist', color: '#0b0b0b', locked: true, auto_grant: false },
];
const customers = [
  { id: 'c-ban', name: 'Banned Rider', email: 'banned.rider@gmail.com', phone: '+966551876300', gender: 'male', created_at: '2026-09-01T10:00:00Z' },
  { id: 'c-mem', name: 'Member Rider', email: 'member.rider@gmail.com', phone: '+966551876301', gender: 'male', created_at: '2026-09-01T10:00:00Z' },
];
const customer_tags = [
  { customer_id: 'c-ban', tag_id: 'tag_blacklist', added_by: 'staff', added_at: 1 },
  { customer_id: 'c-mem', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 },
];
const appBase = {
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12',
  gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
  customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect',
};
const apps = [
  { ...appBase, id: 'a-ban', status: 'pending', name: 'Banned Rider', email: 'banned.rider@gmail.com', phone: '+966551876300', instagram: 'banned.r', linkedin: 'banned-r' },
  { ...appBase, id: 'a-new', status: 'pending', name: 'Fresh Face', email: 'fresh.face@gmail.com', phone: '+966551876302', instagram: 'fresh.f', linkedin: 'fresh-f' },
];

async function boot(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags, customers, customer_tags, staff_options: [], community_applications: apps, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
const accounts = (page: Page) => page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
const applications = (page: Page) => page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
const modal = (page: Page) => page.locator('#confirm-modal');

test('the chip is black and wears the white mark struck through, and nothing else', async ({ page }) => {
  await boot(page);
  await accounts(page);
  const chip = page.locator('#am-cust-rows .am-chip.tag-ban').first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('style', /background:#0b0b0b/);
  await expect(chip).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(chip.locator('.tag-banned .tag-logo-mm')).toHaveCount(1);
  await expect(chip.locator('.tag-banned .tag-ban-sign')).toHaveCount(1);
  await expect(chip).not.toContainText('Blacklist'); // the mark alone, as the other brand chips; the name is the title
  await expect(chip).toHaveAttribute('title', 'Blacklist');
  // The Community chip is as it was: its mark alone, no ring, no name.
  const comm = page.locator('#am-cust-rows .am-chip.tag-brand:not(.tag-ban)').first();
  await expect(comm).toBeVisible();
  await expect(comm.locator('.tag-ban-sign')).toHaveCount(0);
  await expect(comm).not.toContainText('Community');
  // The tag manager lists it as a locked tag: Edit, no Delete.
  const row = page.locator('.am-tag-row', { has: page.locator('.am-chip.tag-ban') });
  await expect(row).toContainText('1 holders');
  await expect(row.locator('button', { hasText: 'Delete' })).toHaveCount(0);
});

test('granting Community to a blacklisted account warns; blacklisting a member offers to drop Community', async ({ page }) => {
  await boot(page);
  await accounts(page);
  await page.evaluate(`showTagGrantModal('c-ban','tag_saturday')`);
  await expect(modal(page).locator('.tag-ban-warn')).toContainText('not fit for the community');
  await expect(modal(page).locator('.tag-ban-warn .tag-banned')).toHaveCount(1);
  await expect(modal(page).locator('.tag-ban-opt')).toHaveCount(0);

  await page.evaluate(`S._tg=null;closeConfirm();showTagGrantModal('c-mem','tag_blacklist')`);
  await expect(modal(page).locator('.tag-ban-warn')).toHaveCount(0);
  const box = modal(page).locator('.tag-ban-opt input');
  await expect(box).toBeChecked();
  await modal(page).locator('[data-on-click*="saveTagGrant"]').click();
  await expect(modal(page).locator('.confirm-box')).toHaveCount(0);
  expect(await page.evaluate(`S.customerTags.filter(ct=>ct.customer_id==='c-mem').map(ct=>ct.tag_id).sort()`)).toEqual(['tag_blacklist']);

  // Unticked, the Community tag stays beside the blacklist.
  await page.evaluate(`S.customerTags=S.customerTags.filter(ct=>ct.customer_id!=='c-mem').concat([{customer_id:'c-mem',tag_id:'tag_saturday',added_by:'staff',added_at:1}]);showTagGrantModal('c-mem','tag_blacklist')`);
  await modal(page).locator('.tag-ban-opt input').uncheck();
  await expect(modal(page).locator('.tag-ban-opt input')).not.toBeChecked();
  await modal(page).locator('[data-on-click*="saveTagGrant"]').click();
  await expect(modal(page).locator('.confirm-box')).toHaveCount(0);
  expect(await page.evaluate(`S.customerTags.filter(ct=>ct.customer_id==='c-mem').map(ct=>ct.tag_id).sort()`)).toEqual(['tag_blacklist', 'tag_saturday']);

  // A plain tag on a plain account: neither the warning nor the box.
  await page.evaluate(`showTagGrantModal('c-ban','tag_blacklist')`);
  await expect(modal(page).locator('.confirm-box')).toBeVisible();
  await expect(modal(page).locator('.tag-ban-warn, .tag-ban-opt')).toHaveCount(0);
});

test('approving an application from a blacklisted account says so and turns Approve red; a fresh one does not', async ({ page }) => {
  await boot(page);
  await applications(page);
  const row = (id: string) => page.locator(`.ca-row[data-app-id="${id}"]`);
  await row('a-ban').locator('.ca-approve').click();
  await expect(modal(page)).toContainText('Approve Banned Rider?');
  await expect(modal(page).locator('.tag-ban-warn')).toContainText('not fit for the community');
  await expect(modal(page).locator('button.btn-red', { hasText: 'Approve' })).toHaveCount(1);
  await modal(page).locator('button', { hasText: 'Cancel' }).click();
  await expect(modal(page).locator('.confirm-box')).toHaveCount(0);

  await row('a-new').locator('.ca-approve').click();
  await expect(modal(page)).toContainText('Approve Fresh Face?');
  await expect(modal(page).locator('.tag-ban-warn')).toHaveCount(0);
  await expect(modal(page).locator('button.btn-primary', { hasText: 'Approve' })).toHaveCount(1);
});
