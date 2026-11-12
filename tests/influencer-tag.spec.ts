import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The influencer tag (the owner, 2026-11-12: "create a new influencer tag that is given manually by staff"). The
// owner's picks: a white megaphone on magenta; seen by staff only; the mark after the holder's name on screen and on
// the printed sheets; an Influencer filter and report counts; and a magenta band on their Bookings row. Nothing else
// changes for the rider. Hiding the tag takes all of it off. All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const MAGENTA = 'rgb(194, 37, 92)';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const baseTags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#0c7a3d', locked: true, auto_grant: false },
  { id: 'tag_influencer', slug: 'influencer', name: 'Influencer', color: '#c2255c', locked: true, auto_grant: false },
];
const cust = (id: string, name: string) => ({ id, name, email: id + '@example.test', phone: '05000000' + id.slice(1).padStart(2, '0'), height: 170, created_at: '2026-01-01T00:00:00Z' });
const customers = [cust('c1', 'Iris Influencer Member'), cust('c2', 'Carl Community'), cust('c3', 'Ivan Influencer'), cust('c4', 'Nora Nobody')];
const customer_tags = [
  { customer_id: 'c1', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 },
  { customer_id: 'c1', tag_id: 'tag_influencer', added_by: 'staff', added_at: 1 },
  { customer_id: 'c2', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 },
  { customer_id: 'c3', tag_id: 'tag_influencer', added_by: 'staff', added_at: 1 },
];
const row = (n: number, cid: string, name: string, x: Record<string, unknown> = {}) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-11-12T10:00:00Z', ...x,
});
const queue_entries = [row(1, 'c1', 'Iris Influencer Member'), row(2, 'c2', 'Carl Community'), row(3, 'c3', 'Ivan Influencer'), row(4, 'c4', 'Nora Nobody')];

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

test.describe('@staff:tags The influencer tag', () => {
  test('its chip is the drawn megaphone, white on magenta, named by its title', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('customers');S.communityTab='accounts';renderCustomers()`);
    const chip = page.locator('#am-cust-rows .am-chip.tag-brand', { has: page.locator('.tag-svg-inf') }).first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveCSS('background-color', MAGENTA);
    await expect(chip).toHaveAttribute('title', 'Influencer');
    await expect(chip.locator('svg.inf-ico')).toHaveCount(1);
    await expect(chip).not.toContainText('Influencer');
  });

  test('Bookings: the megaphone after a holder\'s name and a magenta band down the row, inside a member\'s green', async ({ page }) => {
    await boot(page);
    await roster(page);
    await expect(tr(page, 'q3')).toHaveClass(/\binf-row\b/);
    await expect(tr(page, 'q1')).toHaveClass(/\binf-row\b/);
    await expect(tr(page, 'q2')).not.toHaveClass(/\binf-row\b/);
    await expect(tr(page, 'q4')).not.toHaveClass(/\binf-row\b/);
    await expect(tr(page, 'q3').locator('.inf-mk')).toHaveAttribute('title', 'Influencer');
    await expect(tr(page, 'q1').locator('.inf-mk')).toHaveCount(1);
    await expect(tr(page, 'q2').locator('.inf-mk')).toHaveCount(0);
    await expect(tr(page, 'q4').locator('.inf-mk')).toHaveCount(0);
    const sh = (id: string) => tr(page, id).locator('td').first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(await sh('q3')).toContain(MAGENTA);
    // a member who is also an influencer: the community's green outside, the magenta inside
    const both = await sh('q1');
    expect(both).toContain('rgb(12, 122, 61)');
    expect(both).toContain(MAGENTA);
    expect(both.indexOf('rgb(12, 122, 61)')).toBeLessThan(both.indexOf(MAGENTA));
    // the name turns magenta, unless the community's green dresses it
    await expect(tr(page, 'q3').locator('.rider-name').first()).toHaveCSS('color', 'rgb(166, 30, 77)');
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/inf-roster.png` });
    // the phone cards too
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(`renderStaffQueue()`);
    const card = page.locator('#tab-queue .queue-mobile-view .q-card[data-id="q3"]');
    await expect(card).toHaveClass(/\binf-row\b/);
    await expect(card.locator('.inf-mk')).toHaveCount(1);
    expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(MAGENTA);
  });

  test('the Influencer filter on Bookings and on People', async ({ page }) => {
    await boot(page);
    await roster(page);
    await page.evaluate(`S.sfInf='yes';renderStaffQueue()`);
    await expect(tr(page, 'q1')).toHaveCount(1);
    await expect(tr(page, 'q3')).toHaveCount(1);
    await expect(tr(page, 'q2')).toHaveCount(0);
    await expect(tr(page, 'q4')).toHaveCount(0);
    await page.evaluate(`S.sfInf='no';renderStaffQueue()`);
    await expect(tr(page, 'q3')).toHaveCount(0);
    await expect(tr(page, 'q4')).toHaveCount(1);
    const pick: string[] = await page.evaluate(`(()=>{const d=_amDefs(true).find(x=>x[0]==='amInf');return S.customers.filter(c=>d[3](c,'yes')).map(c=>c.id);})()`);
    expect(pick.sort()).toEqual(['c1', 'c3']);
  });

  test('the reports count holders: the account report\'s section and column, the session sheet\'s tile', async ({ page }) => {
    await boot(page);
    const html: string = await page.evaluate(`_accReportHtml()`);
    expect(html).toContain('<h2>Influencer</h2>');
    expect(html).toContain('Community members: 1 of 2');
    expect(html).toContain('Other customers: 1 of 2');
    expect(await page.evaluate(`_accSnParts(_accRows(),_infCid)`)).toEqual({ n: 2, pct: '50%', cm: [1, 2, '50%'], cu: [1, 2, '50%'] });
    expect(await page.evaluate(`_ACC_COLS.some(c=>c.k==='infl')&&_ACC_SECTIONS.some(c=>c.k==='infl')`)).toBe(true);
    const tile: string = await page.evaluate(`_infTile(getQueue())`);
    expect(tile).toContain('Influencer');
    expect(tile).toContain('50%');
    // and the printed rosters carry the mark
    expect(await page.evaluate(`_infChip(getQueue().find(e=>e.id==='q3'))`)).toContain('inf-ico');
    if (process.env.SHOT_DIR) {
      await page.setContent(html);
      await page.screenshot({ path: `${process.env.SHOT_DIR}/inf-report.png`, fullPage: true });
    }
  });

  test('hidden on the Tags page, it is off the roster, the filters and the reports', async ({ page }) => {
    await boot(page, 1440, baseTags.map((t) => (t.id === 'tag_influencer' ? { ...t, hidden_at: '2026-11-12T12:00:00Z', hidden_by: 'staff' } : t)));
    await roster(page);
    await expect(tr(page, 'q3')).toHaveCount(1);
    await expect(tr(page, 'q3')).not.toHaveClass(/\binf-row\b/);
    await expect(page.locator('#tab-queue .inf-mk')).toHaveCount(0);
    expect(await page.evaluate(`_amDefs(true).some(x=>x[0]==='amInf')`)).toBe(false);
    expect(await page.evaluate(`_infTile(getQueue())`)).toBe('');
    expect(await page.evaluate(`_accReportHtml()`)).not.toContain('<h2>Influencer</h2>');
  });
});
