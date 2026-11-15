import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The food worker tag (the user, 2026-11-15: "add a new food worker tag that looks the same as food blogger but has a
// worker between the fork and knife, but use a different color"). The food blogger tag in everything, drawn as a
// worker between the fork and knife, white on chocolate brown: the mark after the holder's name on their bookings and
// beside the account's name, a brown band on their Bookings row, a Food worker filter and report counts. A food blogger
// or an influencer who also works with food keeps their own band; both marks show. Hiding the tag takes all of it off.
// All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const BROWN = 'rgb(138, 75, 31)';
const PURPLE = 'rgb(111, 45, 189)';
const MAGENTA = 'rgb(194, 37, 92)';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const baseTags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#0c7a3d', locked: true, auto_grant: false },
  { id: 'tag_influencer', slug: 'influencer', name: 'Influencer', color: '#c2255c', locked: true, auto_grant: false },
  { id: 'tag_food_blogger', slug: 'food_blogger', name: 'Food blogger', color: '#6f2dbd', locked: true, auto_grant: false },
  { id: 'tag_food_worker', slug: 'food_worker', name: 'Food worker', color: '#8a4b1f', locked: true, auto_grant: false },
];
const cust = (id: string, name: string) => ({ id, name, email: id + '@example.test', phone: '05000000' + id.slice(1).padStart(2, '0'), height: 170, created_at: '2026-01-01T00:00:00Z' });
const customers = [cust('c1', 'Wes Worker Member'), cust('c2', 'Carl Community'), cust('c3', 'Walt Worker'), cust('c4', 'Nora Nobody'), cust('c5', 'Iris Both'), cust('c6', 'Bea Blogger')];
const ct = (customer_id: string, tag_id: string) => ({ customer_id, tag_id, added_by: 'staff', added_at: 1 });
const customer_tags = [
  ct('c1', 'tag_saturday'), ct('c1', 'tag_food_worker'),
  ct('c2', 'tag_saturday'),
  ct('c3', 'tag_food_worker'),
  ct('c5', 'tag_influencer'), ct('c5', 'tag_food_worker'),
  ct('c6', 'tag_food_blogger'), ct('c6', 'tag_food_worker'),
];
const row = (n: number, cid: string, name: string) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-11-15T10:00:00Z',
});
const queue_entries = customers.map((c, i) => row(i + 1, c.id, c.name));

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
const accounts = (page: Page) => page.evaluate(`setStaffTab('customers');S.communityTab='accounts';renderCustomers()`);

test.describe('@staff:tags The food worker tag', () => {
  test('its chip is the drawn worker between the fork and knife, white on brown, named by its title', async ({ page }) => {
    await boot(page);
    await accounts(page);
    const chip = page.locator('#am-cust-rows .am-chip.tag-brand', { has: page.locator('.tag-svg-fwk') }).first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveCSS('background-color', BROWN);
    await expect(chip).toHaveAttribute('title', 'Food worker');
    await expect(chip.locator('svg.fwk-ico')).toHaveCount(1);
    await expect(chip.locator('svg.fwk-ico circle')).toHaveCount(1);
    await expect(chip).not.toContainText('Food worker');
  });

  test('Accounts: the mark beside a holder\'s name, and on the account page\'s title', async ({ page }) => {
    await boot(page);
    await accounts(page);
    const nameRow = (name: string) => page.locator('#am-cust-rows .am-cust', { has: page.locator('.am-cust-name', { hasText: name }) });
    await expect(nameRow('Walt Worker').locator('.am-c-nm .food-nm .fwk-mk')).toHaveCount(1);
    await expect(nameRow('Walt Worker').locator('.fwk-mk')).toHaveAttribute('title', 'Food worker');
    await expect(nameRow('Walt Worker').locator('.fwk-mk')).toHaveCSS('background-color', BROWN);
    await expect(nameRow('Walt Worker').locator('.food-mk')).toHaveCount(0);
    await expect(nameRow('Nora Nobody').locator('.fwk-mk')).toHaveCount(0);
    await expect(nameRow('Carl Community').locator('.fwk-mk')).toHaveCount(0);
    // a food blogger who also works with food: both marks beside the name, the blogger's first
    await expect(nameRow('Bea Blogger').locator('.food-nm .food-mk + .fwk-mk')).toHaveCount(1);
    // the mark sits on the name's line, after it
    const nb = await nameRow('Walt Worker').locator('.am-cust-name').boundingBox();
    const mb = await nameRow('Walt Worker').locator('.fwk-mk').boundingBox();
    expect(nb && mb && Math.abs(nb.y + nb.height / 2 - (mb.y + mb.height / 2)) < 6).toBe(true);
    expect(nb && mb && mb.x >= nb.x + nb.width - 1).toBe(true);
    if (process.env.SHOT_DIR) await nameRow('Bea Blogger').screenshot({ path: `${process.env.SHOT_DIR}/fwk-account-row.png` });
    await page.evaluate(`openAccountHistory('c3')`);
    await expect(page.locator('#ah-title .fwk-mk')).toHaveCount(1);
    await page.evaluate(`closeCustomerProfile()`);
    await page.evaluate(`openAccountHistory('c4')`);
    await expect(page.locator('#ah-title')).toBeVisible();
    await expect(page.locator('#ah-title .fwk-mk')).toHaveCount(0);
  });

  test('Bookings: the mark after a holder\'s name and a brown band down the row, inside a member\'s green', async ({ page }) => {
    await boot(page);
    await roster(page);
    await expect(tr(page, 'q3')).toHaveClass(/\bfwk-row\b/);
    await expect(tr(page, 'q1')).toHaveClass(/\bfwk-row\b/);
    await expect(tr(page, 'q2')).not.toHaveClass(/\bfwk-row\b/);
    await expect(tr(page, 'q4')).not.toHaveClass(/\bfwk-row\b/);
    await expect(tr(page, 'q3').locator('.fwk-mk')).toHaveAttribute('title', 'Food worker');
    await expect(tr(page, 'q1').locator('.fwk-mk')).toHaveCount(1);
    await expect(tr(page, 'q2').locator('.fwk-mk')).toHaveCount(0);
    await expect(tr(page, 'q4').locator('.fwk-mk')).toHaveCount(0);
    const sh = (id: string) => tr(page, id).locator('td').first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(await sh('q3')).toContain(BROWN);
    const both = await sh('q1');
    expect(both).toContain('rgb(12, 122, 61)');
    expect(both).toContain(BROWN);
    expect(both.indexOf('rgb(12, 122, 61)')).toBeLessThan(both.indexOf(BROWN));
    // an influencer keeps the magenta band and a food blogger the purple; both marks show
    const inf = await sh('q5');
    expect(inf).toContain(MAGENTA);
    expect(inf).not.toContain(BROWN);
    await expect(tr(page, 'q5').locator('.inf-mk + .fwk-mk')).toHaveCount(1);
    const fb = await sh('q6');
    expect(fb).toContain(PURPLE);
    expect(fb).not.toContain(BROWN);
    await expect(tr(page, 'q6').locator('.food-mk + .fwk-mk')).toHaveCount(1);
    await expect(tr(page, 'q6').locator('.rider-name').first()).toHaveCSS('color', PURPLE);
    // the name turns brown
    await expect(tr(page, 'q3').locator('.rider-name').first()).toHaveCSS('color', BROWN);
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/fwk-roster.png` });
    // the phone cards too
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(`renderStaffQueue()`);
    const card = page.locator('#tab-queue .queue-mobile-view .q-card[data-id="q3"]');
    await expect(card).toHaveClass(/\bfwk-row\b/);
    await expect(card.locator('.fwk-mk')).toHaveCount(1);
    expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(BROWN);
  });

  test('the Food worker filter on Bookings and on People', async ({ page }) => {
    await boot(page);
    await roster(page);
    await page.evaluate(`S.sfFwk='yes';renderStaffQueue()`);
    for (const id of ['q1', 'q3', 'q5', 'q6']) await expect(tr(page, id)).toHaveCount(1);
    for (const id of ['q2', 'q4']) await expect(tr(page, id)).toHaveCount(0);
    await page.evaluate(`S.sfFwk='no';renderStaffQueue()`);
    await expect(tr(page, 'q3')).toHaveCount(0);
    await expect(tr(page, 'q4')).toHaveCount(1);
    const pick: string[] = await page.evaluate(`(()=>{const d=_amDefs(true).find(x=>x[0]==='amFwk');return S.customers.filter(c=>d[3](c,'yes')).map(c=>c.id);})()`);
    expect(pick.sort()).toEqual(['c1', 'c3', 'c5', 'c6']);
  });

  test('the reports count holders: the account report\'s section and column, the session sheet\'s tile', async ({ page }) => {
    await boot(page);
    const html: string = await page.evaluate(`_accReportHtml()`);
    expect(html).toContain('<h2>Food worker</h2>');
    expect(await page.evaluate(`_accSnParts(_accRows(),_fwkCid)`)).toEqual({ n: 4, pct: '66.7%', cm: [1, 2, '50%'], cu: [3, 4, '75%'] });
    expect(await page.evaluate(`_ACC_COLS.some(c=>c.k==='fwork')&&_ACC_SECTIONS.some(c=>c.k==='fwork')`)).toBe(true);
    const tile: string = await page.evaluate(`_fwkTile(getQueue())`);
    expect(tile).toContain('Food worker');
    expect(tile).toContain('67%');
    // and the printed rosters carry the mark
    expect(await page.evaluate(`_fwkChip(getQueue().find(e=>e.id==='q3'))`)).toContain('fwk-ico');
  });

  test('hidden on the Tags page, it is off the roster, the accounts, the filters and the reports', async ({ page }) => {
    await boot(page, 1440, baseTags.map((t) => (t.id === 'tag_food_worker' ? { ...t, hidden_at: '2026-11-15T12:00:00Z', hidden_by: 'staff' } : t)));
    await roster(page);
    await expect(tr(page, 'q3')).toHaveCount(1);
    await expect(tr(page, 'q3')).not.toHaveClass(/\bfwk-row\b/);
    await expect(page.locator('#tab-queue .fwk-mk')).toHaveCount(0);
    // the food blogger's own mark stays
    await expect(tr(page, 'q6').locator('.food-mk')).toHaveCount(1);
    await accounts(page);
    await expect(page.locator('#am-cust-rows .am-cust-name', { hasText: 'Walt Worker' })).toHaveCount(1);
    await expect(page.locator('#am-cust-rows .fwk-mk')).toHaveCount(0);
    expect(await page.evaluate(`_amDefs(true).some(x=>x[0]==='amFwk')`)).toBe(false);
    expect(await page.evaluate(`_fwkTile(getQueue())`)).toBe('');
    expect(await page.evaluate(`_accReportHtml()`)).not.toContain('<h2>Food worker</h2>');
  });
});
