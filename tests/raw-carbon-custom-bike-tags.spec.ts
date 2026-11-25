import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Raw carbon bike and Customized bike tags (the user, 2026-11-25: "add a new Raw Carbon tag and Customized Bike
// tag, show me multiple options", then their picks): Raw carbon bike the word RAW on a carbon-weave chip in carbon
// black, Customized bike a wrench and the word CUSTOM on workshop orange. Shown where the Doctor and PIF tags show: the
// mark after the holder's name on bookings and beside the account's name, the band (the name keeps its own colour),
// filters and report counts, never on the printed sheets. All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const CARBON = 'rgb(36, 40, 47)';
const ORANGE = 'rgb(217, 72, 15)';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const tag = (id: string, slug: string, name: string, color: string, description: string | null) => ({ id, slug, name, color, description, locked: true, auto_grant: false });
const tags = [
  tag('tag_saturday', 'saturday', 'Community', '#0c7a3d', 'Marks Saturday Social Ride regulars.'),
  tag('tag_doctor', 'doctor', 'Medical doctor', '#1971c2', 'A medical doctor.'),
  tag('tag_raw_carbon', 'raw_carbon', 'Raw carbon bike', '#24282f', 'Rides their own raw carbon bike.'),
  tag('tag_custom_bike', 'custom_bike', 'Customized bike', '#d9480f', 'Has a bike we built or changed for them.'),
];
const cust = (id: string, name: string) => ({ id, name, email: id + '@example.test', phone: '05000000' + id.slice(1).padStart(2, '0'), height: 170, created_at: '2026-01-01T00:00:00Z' });
const customers = [cust('c1', 'Rami Raw'), cust('c2', 'Cara Custom'), cust('c3', 'Bea Both'), cust('c4', 'Nora Nobody')];
const ct = (customer_id: string, tag_id: string) => ({ customer_id, tag_id, added_by: 'staff', added_at: 1, note: null });
const customer_tags = [ct('c1', 'tag_raw_carbon'), ct('c2', 'tag_custom_bike'), ct('c3', 'tag_raw_carbon'), ct('c3', 'tag_custom_bike')];
const row = (n: number, cid: string, name: string) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-11-25T10:00:00Z',
});
const queue_entries = customers.map((c, i) => row(i + 1, c.id, c.name));

async function boot(page: Page, width = 1440) {
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
const sh = (page: Page, id: string) => tr(page, id).locator('td').first().evaluate((el) => getComputedStyle(el).boxShadow);
const nameRow = (page: Page, name: string) => page.locator('#am-cust-rows .am-cust', { has: page.locator('.am-cust-name', { hasText: name }) });

test.describe('@staff:tags The Raw carbon bike and Customized bike tags', () => {
  test('their chips: RAW on carbon black, the wrench and CUSTOM on orange', async ({ page }) => {
    await boot(page);
    await accounts(page);
    const raw = nameRow(page, 'Rami Raw').locator('.am-chip.tag-brand', { has: page.locator('.tag-svg-rcb') });
    await expect(raw).toHaveCount(1);
    await expect(raw).toHaveCSS('background-color', CARBON);
    await expect(raw).toHaveAttribute('title', 'Raw carbon bike');
    await expect(raw.locator('.pro-wd')).toHaveText('RAW');
    const cb = nameRow(page, 'Cara Custom').locator('.am-chip.tag-brand', { has: page.locator('.tag-svg-cub') });
    await expect(cb).toHaveCSS('background-color', ORANGE);
    await expect(cb.locator('svg.cub-ico')).toHaveCount(1);
    await expect(cb.locator('.pro-wd')).toHaveText('CUSTOM');
  });

  test('beside the account\'s name on Accounts and on the account page', async ({ page }) => {
    await boot(page);
    await accounts(page);
    await expect(nameRow(page, 'Rami Raw').locator('.am-c-nm .rcb-mk')).toHaveCount(1);
    await expect(nameRow(page, 'Cara Custom').locator('.am-c-nm .cub-mk')).toHaveCount(1);
    await expect(nameRow(page, 'Bea Both').locator('.am-c-nm .rcb-mk + .cub-mk')).toHaveCount(1);
    await expect(nameRow(page, 'Nora Nobody').locator('.am-c-nm .pro-mk')).toHaveCount(0);
    await page.evaluate(`openAccountHistory('c1')`);
    await expect(page.locator('#ah-title .rcb-mk')).toHaveAttribute('title', 'Raw carbon bike');
  });

  test('Bookings: the mark after the name and the band; the name keeps its own colour', async ({ page }) => {
    await boot(page);
    await roster(page);
    const plain = await tr(page, 'q4').locator('.rider-name').first().evaluate((el) => getComputedStyle(el).color);
    await expect(tr(page, 'q1')).toHaveClass(/\bpro-row\b.*\brcb-row\b.*\bpro-nt\b/);
    const mk = tr(page, 'q1').locator('.rcb-mk');
    await expect(mk).toHaveAttribute('title', 'Raw carbon bike');
    await expect(mk).toHaveCSS('background-color', CARBON);
    expect(await mk.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('repeating-linear-gradient');
    expect(await sh(page, 'q1')).toContain(CARBON);
    await expect(tr(page, 'q1').locator('.rider-name').first()).toHaveCSS('color', plain);
    await expect(tr(page, 'q2').locator('.cub-mk')).toHaveCSS('background-color', ORANGE);
    await expect(tr(page, 'q2').locator('.cub-mk')).toHaveText('CUSTOM');
    expect(await sh(page, 'q2')).toContain(ORANGE);
    await expect(tr(page, 'q2').locator('.rider-name').first()).toHaveCSS('color', plain);
    await expect(tr(page, 'q3').locator('.rcb-mk + .cub-mk')).toHaveCount(1);
    await expect(tr(page, 'q4').locator('.pro-mk')).toHaveCount(0);
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/rc-cb-roster.png` });
  });

  test('the dark theme: a lighter band for the carbon tag, and an edge on its chip', async ({ page }) => {
    await boot(page);
    await page.evaluate(`document.documentElement.setAttribute('data-staff-theme','dark')`);
    await roster(page);
    expect(await sh(page, 'q1')).toContain('rgb(138, 147, 158)');
    expect(await tr(page, 'q1').locator('.rcb-mk').evaluate((el) => getComputedStyle(el).boxShadow)).toContain('inset');
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/rc-cb-roster-dark.png` });
  });

  test('off the printed sheets, still counted, filtered and in the account report', async ({ page }) => {
    await boot(page);
    const printed: string = await page.evaluate(`_proChips(getQueue().find(e=>e.id==='q3'),1)`);
    expect(printed).not.toContain('rcb-mk');
    expect(printed).not.toContain('cub-mk');
    const tiles: string = await page.evaluate(`_proTiles(getQueue())`);
    expect(tiles).toContain('Raw carbon bike');
    expect(tiles).toContain('Customized bike');
    const pick = (k: string, v: string): Promise<string[]> => page.evaluate(`(()=>{const d=_amDefs(true).find(x=>x[0]==='${k}');return S.customers.filter(c=>d[3](c,${JSON.stringify(v)})).map(c=>c.id).sort();})()`);
    expect(await pick('amRcb', 'yes')).toEqual(['c1', 'c3']);
    expect(await pick('amCub', 'yes')).toEqual(['c2', 'c3']);
    expect(await pick('amCub', 'no')).toEqual(['c1', 'c4']);
    await roster(page);
    await page.evaluate(`S.sfRcb='yes';renderStaffQueue()`);
    await expect(tr(page, 'q1')).toHaveCount(1);
    await expect(tr(page, 'q2')).toHaveCount(0);
    const html: string = await page.evaluate(`_accReportHtml()`);
    expect(html).toContain('<h2>Raw carbon bike</h2>');
    expect(html).toContain('<h2>Customized bike</h2>');
  });

  test('every language names them; the chip words stay as marks', async ({ page }) => {
    const codes = ['ar', 'bn', 'es', 'fr', 'hi', 'ms', 'ne', 'pt', 'tl', 'ur'];
    for (const c of codes) {
      const pack = JSON.parse(readFileSync(`lang/${c}.json`, 'utf8'));
      expect(pack.rcbLabel, c).toBeTruthy();
      expect(pack.cubLabel, c).toBeTruthy();
    }
    expect(JSON.parse(readFileSync('lang/ar.json', 'utf8')).rcbLabel).toBe('دراجة كربون خام');
    await boot(page);
    expect(await page.evaluate(`_proFace(PRO_TAGS.find(p=>p.k==='rcb'))`)).toBe('<span class="pro-wd">RAW</span>');
  });
});
