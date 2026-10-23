import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows, type Fixtures } from './helpers/supabase';

// Petromin Days (the owner, 2026-10-12): the Petromin tag lets its holder book the Petromin nights, and
// no other members-only ride, through a card of their own that only holders see. Community members
// keep finding the nights inside MicroMobility Experiences. An account holds the Community tag or the
// Petromin tag, never both: staff are told so in either direction. All Supabase traffic is stubbed.

const PW = '2099-10-14-pw';
const pw = {
  id: PW, session_date: '2099-10-14', day: 'Wednesday', status: 'open', capacity: 35, created_at: 1,
  event_kind: 'community', ride_kind: 'petromin', needs_approval: false, open_to_all: false, paid_ride: true,
  bike_slots: '{"_time":"21:00 - 23:00"}', location: 'JCC',
};
const sat = {
  id: '2099-10-17', session_date: '2099-10-17', day: 'Saturday', status: 'open', capacity: 40, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, open_to_all: false, bike_slots: '{"_time":"06:00 - 06:30"}',
};
const jcc = { id: '2099-10-18', session_date: '2099-10-18', day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC' };

async function custBoot(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [pw, sat, jcc], queue_entries: [], 'rpc:community_member': false, 'rpc:petromin_member': false, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Omar Saleh', birth_date: '1990-01-01' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}
const card = (page: Page) => page.locator('#land-events .landing-event-card.ev-petromin');

test.describe('@customer:petromin Petromin Days', () => {
  test('a rider without the Petromin tag never sees the card', async ({ page }) => {
    await custBoot(page);
    await expect(page.locator('#land-events .landing-event-card.ev-jcc')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('a holder sees the card, and it opens the Petromin nights alone', async ({ page }) => {
    await custBoot(page, { 'rpc:petromin_member': true });
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('.lec-title')).toHaveText('Petromin Days');
    await expect(card(page).locator('.lec-meta')).toContainText('Next ride');
    await expect(card(page).locator('.lec2-logo img')).toHaveAttribute('src', '/assets/petromin-logo.png');
    // it is the first card on the picker
    await expect(page.locator('#land-events .landing-events-grid .landing-event-card').first()).toHaveClass(/ev-petromin/);
    await card(page).click();
    await expect.poll(() => page.evaluate('S.selEvent')).toBe('petromin');
    const dates = page.locator('#tab-register .sess-card');
    await expect(dates).toHaveCount(1);
    await expect(dates.first()).toHaveAttribute('data-on-click', new RegExp(PW));
    // the holder is no community member, yet the night opens: the Petromin tag answers it
    await dates.first().click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(PW);
    await expect(page.locator('#confirm-modal .cm-box')).toHaveCount(0);
    expect(await page.evaluate(`_evOf(_sessDisp('${PW}'))`)).toBe('petromin');
  });

  test('a holder sees About this event under the card, with the Petromin nights in it', async ({ page }) => {
    await custBoot(page, { 'rpc:petromin_member': true, site_content: [] });
    const about = page.locator('#land-events .lec-about.ab-petromin');
    await expect(about).toHaveText('About this event');
    await about.click();
    const sheet = page.locator('#bike-info-modal');
    await expect(sheet).toContainText('Petromin Days');
    await expect(sheet).toContainText("Petromin's evening rides at the Jeddah Corniche Circuit");
    await expect(sheet).toContainText("Community members and Petromin's team");
  });

  test('a holder who is no community member confirms a Petromin booking (2026-10-12 fix)', async ({ page }) => {
    await custBoot(page, { 'rpc:petromin_member': true });
    const rows = await captureBookingRows(page);
    await card(page).click();
    await page.locator(`#tab-register .sess-card[data-on-click*="${PW}"]`).click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(PW);
    await page.evaluate(`S.regQty=1;S.regBikeHeights=[175];S.regBikeTypes=['Road'];S.regRiderNames=['Omar Saleh'];S.promoApplied=null;S.waiverOk=true;S._waiverSess=S.selSession;S._pmInvSeen=S.selSession;submitReg()`);
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: PW, type_preference: 'Road' });
    await expect(page.locator('#confirm-modal .cm-box')).toHaveCount(0); // never the members popup
  });

  test('a card painted before staff took the tag away says who the days are for', async ({ page }) => {
    await custBoot(page, { 'rpc:petromin_member': true });
    await expect(card(page)).toBeVisible();
    await page.evaluate(`S._pmMem.ok=false;S._pmMem.at=Date.now()`); // the cached yes is gone; the server now answers no
    await page.route('**/rest/v1/rpc/petromin_member', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: 'false' }));
    await page.evaluate(`selectEvent('petromin')`);
    await expect(page.locator('#toast-container')).toContainText("Petromin Days are for Petromin's team.");
    expect(await page.evaluate('S.view')).toBe('landing');
  });

  test('a community member keeps the Petromin nights inside MicroMobility Experiences', async ({ page }) => {
    await custBoot(page, { 'rpc:community_member': true });
    await expect(card(page)).toHaveCount(0);
    await page.locator('#land-events .landing-event-card.ev-community').click();
    await expect.poll(() => page.evaluate('S.selEvent')).toBe('community');
    await expect(page.locator(`#tab-register .sess-card[data-on-click*="${PW}"]`)).toHaveCount(1);
    expect(await page.evaluate(`_evOf(_sessDisp('${PW}'))`)).toBe('community');
  });
});

// ── Staff: the Community tag or the Petromin tag, never both ──────────────────────────────────────
const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false },
  { id: 'tag_petromin', slug: 'petromin', name: 'Petromin', color: '#d6202a', locked: true, auto_grant: false },
  { id: 'tag_vip', slug: 'vip', name: 'VIP', color: '#a67c00', locked: true, auto_grant: false },
];
const customers = [
  { id: 'c-mem', name: 'Member Rider', email: 'member.rider@gmail.com', phone: '+966551876301', gender: 'male', created_at: '2026-09-01T10:00:00Z' },
  { id: 'c-pm', name: 'Petromin Rider', email: 'petromin.rider@gmail.com', phone: '+966551876302', gender: 'male', created_at: '2026-09-01T10:00:00Z' },
  { id: 'c-none', name: 'Plain Rider', email: 'plain.rider@gmail.com', phone: '+966551876303', gender: 'male', created_at: '2026-09-01T10:00:00Z' },
];
const customer_tags = [
  { customer_id: 'c-mem', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 },
  { customer_id: 'c-pm', tag_id: 'tag_petromin', added_by: 'staff', added_at: 1 },
];
const apps = [{
  id: 'a-pm', status: 'pending', name: 'Petromin Rider', email: 'petromin.rider@gmail.com', phone: '+966551876302',
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12',
  gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
  customer_id: 'c-pm', existing_account: null, account_oauth: null, profession: 'Engineer', instagram: 'pm.r', linkedin: 'pm-r',
}];

async function staffBoot(page: Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags, customers, customer_tags, staff_options: [], community_applications: apps });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
}
const modal = (page: Page) => page.locator('#confirm-modal');

test.describe('@staff:tags The Petromin tag', () => {
  test('the chip is Petromin\'s logo on white, edged in Petromin red', async ({ page }) => {
    await staffBoot(page);
    const chip = page.locator('#am-cust-rows .am-chip.tag-brand', { has: page.locator('.tag-img-pm') }).first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveCSS('background-color', 'rgb(255, 255, 255)'); // white, so Petromin's red logo reads
    await expect(chip).toHaveCSS('border-top-color', 'rgb(214, 32, 42)'); // edged in #d6202a
    await expect(chip.locator('img.tag-img-pm')).toHaveAttribute('src', '/assets/petromin-logo.png');
    await expect(chip.locator('img.tag-img-pm')).toHaveAttribute('alt', 'Petromin');
    await expect(chip).toHaveAttribute('title', 'Petromin');
  });

  test('granting Petromin to a Community member, or Community to a Petromin holder, is an error', async ({ page }) => {
    await staffBoot(page);
    for (const [cid, tid] of [['c-mem', 'tag_petromin'], ['c-pm', 'tag_saturday']]) {
      await page.evaluate(`S._tg=null;closeConfirm();showTagGrantModal('${cid}','${tid}')`);
      await expect(modal(page).locator('.tag-rival-warn')).toContainText('Community tag or the Petromin tag, never both');
      await expect(modal(page).locator('[data-on-click*="saveTagGrant"]')).toBeDisabled();
      await page.evaluate('saveTagGrant()'); // forced past the button: still refused, nothing written
      await expect(page.locator('#toast-container')).toContainText('never both');
      expect(await page.evaluate(`S.customerTags.filter(ct=>ct.customer_id==='${cid}').length`)).toBe(1);
    }
    // any other tag, or either of the two on a plain account, goes through as before
    await page.evaluate(`S._tg=null;closeConfirm();showTagGrantModal('c-none','tag_petromin')`);
    await expect(modal(page).locator('.tag-rival-warn')).toHaveCount(0);
    await modal(page).locator('[data-on-click*="saveTagGrant"]').click();
    await expect(modal(page).locator('.confirm-box')).toHaveCount(0);
    expect(await page.evaluate(`S.customerTags.some(ct=>ct.customer_id==='c-none'&&ct.tag_id==='tag_petromin')`)).toBe(true);
    await page.evaluate(`showTagGrantModal('c-pm','tag_vip')`);
    await expect(modal(page).locator('.tag-rival-warn')).toHaveCount(0);
    await expect(modal(page).locator('[data-on-click*="saveTagGrant"]')).toBeEnabled();
  });

  test('approving a Petromin holder with the Community tag waits until one of the two is off', async ({ page }) => {
    await staffBoot(page);
    await page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
    await page.locator('.ca-row[data-app-id="a-pm"] .ca-approve').click();
    await expect(modal(page)).toContainText('Approve Petromin Rider?');
    await page.evaluate(`if(!S._caAp.tags.includes('tag_saturday')){S._caAp.tags.push('tag_saturday');_caApRender();}`); // Community ticked, as the admins' default has it
    await expect(modal(page).locator('.tag-rival-warn')).toContainText('never both');
    await expect(modal(page).locator('.ca-ap-go')).toBeDisabled();
    await modal(page).locator('[data-ca-tag="tag_saturday"]').click(); // Community off
    await expect(modal(page).locator('.tag-rival-warn')).toHaveCount(0);
    await expect(modal(page).locator('.ca-ap-go')).toBeEnabled();
  });
});
