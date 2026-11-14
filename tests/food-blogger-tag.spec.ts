import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The food blogger tag (the owner, 2026-11-14: "create a new food bloggers tag give me options to the design and show
// the tag besides the name of the account and bookings"). The owner's picks: a white fork and knife on aubergine
// purple; the mark after the holder's name on their bookings (on screen and on the printed sheets) and beside the
// account's name; a Food blogger filter and report counts; and a purple band on their Bookings row. Staff only, like
// the influencer tag. Hiding the tag takes all of it off. All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const PURPLE = 'rgb(111, 45, 189)';
const MAGENTA = 'rgb(194, 37, 92)';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const baseTags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#0c7a3d', locked: true, auto_grant: false },
  { id: 'tag_influencer', slug: 'influencer', name: 'Influencer', color: '#c2255c', locked: true, auto_grant: false },
  { id: 'tag_food_blogger', slug: 'food_blogger', name: 'Food blogger', color: '#6f2dbd', locked: true, auto_grant: false },
];
const cust = (id: string, name: string) => ({ id, name, email: id + '@example.test', phone: '05000000' + id.slice(1).padStart(2, '0'), height: 170, created_at: '2026-01-01T00:00:00Z' });
const customers = [cust('c1', 'Fay Food Member'), cust('c2', 'Carl Community'), cust('c3', 'Fred Food'), cust('c4', 'Nora Nobody'), cust('c5', 'Iris Both')];
const customer_tags = [
  { customer_id: 'c1', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 },
  { customer_id: 'c1', tag_id: 'tag_food_blogger', added_by: 'staff', added_at: 1 },
  { customer_id: 'c2', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 },
  { customer_id: 'c3', tag_id: 'tag_food_blogger', added_by: 'staff', added_at: 1 },
  { customer_id: 'c5', tag_id: 'tag_influencer', added_by: 'staff', added_at: 1 },
  { customer_id: 'c5', tag_id: 'tag_food_blogger', added_by: 'staff', added_at: 1 },
];
const row = (n: number, cid: string, name: string, x: Record<string, unknown> = {}) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-11-14T10:00:00Z', ...x,
});
const queue_entries = [row(1, 'c1', 'Fay Food Member'), row(2, 'c2', 'Carl Community'), row(3, 'c3', 'Fred Food'), row(4, 'c4', 'Nora Nobody'), row(5, 'c5', 'Iris Both')];

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

test.describe('@staff:tags The food blogger tag', () => {
  test('its chip is the drawn fork and knife, white on purple, named by its title', async ({ page }) => {
    await boot(page);
    await accounts(page);
    const chip = page.locator('#am-cust-rows .am-chip.tag-brand', { has: page.locator('.tag-svg-food') }).first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveCSS('background-color', PURPLE);
    await expect(chip).toHaveAttribute('title', 'Food blogger');
    await expect(chip.locator('svg.food-ico')).toHaveCount(1);
    await expect(chip).not.toContainText('Food blogger');
  });

  test('Accounts: the mark beside a holder\'s name, and on the account page\'s title', async ({ page }) => {
    await boot(page);
    await accounts(page);
    const nameRow = (name: string) => page.locator('#am-cust-rows .am-cust', { has: page.locator('.am-cust-name', { hasText: name }) });
    await expect(nameRow('Fred Food').locator('.am-c-nm .food-nm .food-mk')).toHaveCount(1);
    await expect(nameRow('Fred Food').locator('.food-mk')).toHaveAttribute('title', 'Food blogger');
    await expect(nameRow('Fred Food').locator('.food-mk')).toHaveCSS('background-color', PURPLE);
    await expect(nameRow('Nora Nobody').locator('.food-mk')).toHaveCount(0);
    await expect(nameRow('Carl Community').locator('.food-mk')).toHaveCount(0);
    // the mark sits on the name's line, after it
    const nb = await nameRow('Fred Food').locator('.am-cust-name').boundingBox();
    const mb = await nameRow('Fred Food').locator('.food-mk').boundingBox();
    expect(nb && mb && Math.abs(nb.y + nb.height / 2 - (mb.y + mb.height / 2)) < 6).toBe(true);
    expect(nb && mb && mb.x >= nb.x + nb.width - 1).toBe(true);
    if (process.env.SHOT_DIR) await nameRow('Fred Food').screenshot({ path: `${process.env.SHOT_DIR}/food-account-row.png` });
    await page.evaluate(`openAccountHistory('c3')`);
    await expect(page.locator('#ah-title .food-mk')).toHaveCount(1);
    await page.evaluate(`closeCustomerProfile()`);
    await page.evaluate(`openAccountHistory('c4')`);
    await expect(page.locator('#ah-title')).toBeVisible();
    await expect(page.locator('#ah-title .food-mk')).toHaveCount(0);
  });

  test('Bookings: the fork and knife after a holder\'s name and a purple band down the row, inside a member\'s green', async ({ page }) => {
    await boot(page);
    await roster(page);
    await expect(tr(page, 'q3')).toHaveClass(/\bfood-row\b/);
    await expect(tr(page, 'q1')).toHaveClass(/\bfood-row\b/);
    await expect(tr(page, 'q2')).not.toHaveClass(/\bfood-row\b/);
    await expect(tr(page, 'q4')).not.toHaveClass(/\bfood-row\b/);
    await expect(tr(page, 'q3').locator('.food-mk')).toHaveAttribute('title', 'Food blogger');
    await expect(tr(page, 'q1').locator('.food-mk')).toHaveCount(1);
    await expect(tr(page, 'q2').locator('.food-mk')).toHaveCount(0);
    await expect(tr(page, 'q4').locator('.food-mk')).toHaveCount(0);
    const sh = (id: string) => tr(page, id).locator('td').first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(await sh('q3')).toContain(PURPLE);
    const both = await sh('q1');
    expect(both).toContain('rgb(12, 122, 61)');
    expect(both).toContain(PURPLE);
    expect(both.indexOf('rgb(12, 122, 61)')).toBeLessThan(both.indexOf(PURPLE));
    // an influencer who also blogs keeps the magenta band, and both marks show (the influencer's first)
    const inf = await sh('q5');
    expect(inf).toContain(MAGENTA);
    expect(inf).not.toContain(PURPLE);
    await expect(tr(page, 'q5').locator('.inf-mk + .food-mk')).toHaveCount(1);
    // the name turns purple
    await expect(tr(page, 'q3').locator('.rider-name').first()).toHaveCSS('color', PURPLE);
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/food-roster.png` });
    // the phone cards too
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(`renderStaffQueue()`);
    const card = page.locator('#tab-queue .queue-mobile-view .q-card[data-id="q3"]');
    await expect(card).toHaveClass(/\bfood-row\b/);
    await expect(card.locator('.food-mk')).toHaveCount(1);
    expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(PURPLE);
  });

  test('the Food blogger filter on Bookings and on People', async ({ page }) => {
    await boot(page);
    await roster(page);
    await page.evaluate(`S.sfFood='yes';renderStaffQueue()`);
    await expect(tr(page, 'q1')).toHaveCount(1);
    await expect(tr(page, 'q3')).toHaveCount(1);
    await expect(tr(page, 'q5')).toHaveCount(1);
    await expect(tr(page, 'q2')).toHaveCount(0);
    await expect(tr(page, 'q4')).toHaveCount(0);
    await page.evaluate(`S.sfFood='no';renderStaffQueue()`);
    await expect(tr(page, 'q3')).toHaveCount(0);
    await expect(tr(page, 'q4')).toHaveCount(1);
    const pick: string[] = await page.evaluate(`(()=>{const d=_amDefs(true).find(x=>x[0]==='amFood');return S.customers.filter(c=>d[3](c,'yes')).map(c=>c.id);})()`);
    expect(pick.sort()).toEqual(['c1', 'c3', 'c5']);
  });

  test('the reports count holders: the account report\'s section and column, the session sheet\'s tile', async ({ page }) => {
    await boot(page);
    const html: string = await page.evaluate(`_accReportHtml()`);
    expect(html).toContain('<h2>Food blogger</h2>');
    expect(html).toContain('Community members: 1 of 2');
    expect(html).toContain('Other customers: 2 of 3');
    expect(await page.evaluate(`_accSnParts(_accRows(),_foodCid)`)).toEqual({ n: 3, pct: '60%', cm: [1, 2, '50%'], cu: [2, 3, '66.7%'] });
    expect(await page.evaluate(`_ACC_COLS.some(c=>c.k==='fblog')&&_ACC_SECTIONS.some(c=>c.k==='fblog')`)).toBe(true);
    const tile: string = await page.evaluate(`_foodTile(getQueue())`);
    expect(tile).toContain('Food blogger');
    expect(tile).toContain('60%');
    // and the printed rosters carry the mark
    expect(await page.evaluate(`_foodChip(getQueue().find(e=>e.id==='q3'))`)).toContain('food-ico');
  });

  test('hidden on the Tags page, it is off the roster, the accounts, the filters and the reports', async ({ page }) => {
    await boot(page, 1440, baseTags.map((t) => (t.id === 'tag_food_blogger' ? { ...t, hidden_at: '2026-11-14T12:00:00Z', hidden_by: 'staff' } : t)));
    await roster(page);
    await expect(tr(page, 'q3')).toHaveCount(1);
    await expect(tr(page, 'q3')).not.toHaveClass(/\bfood-row\b/);
    await expect(page.locator('#tab-queue .food-mk')).toHaveCount(0);
    await accounts(page);
    await expect(page.locator('#am-cust-rows .am-cust-name', { hasText: 'Fred Food' })).toHaveCount(1);
    await expect(page.locator('#am-cust-rows .food-mk')).toHaveCount(0);
    expect(await page.evaluate(`_amDefs(true).some(x=>x[0]==='amFood')`)).toBe(false);
    expect(await page.evaluate(`_foodTile(getQueue())`)).toBe('');
    expect(await page.evaluate(`_accReportHtml()`)).not.toContain('<h2>Food blogger</h2>');
  });
});
