import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The special needs tag (the owner, 2026-10-23): "add a new tag for special needs and make its logo a man on a
// wheelchair, i want use this info when printing reports to know the number and percentage of special needs in our
// customer and community ... i want community members to have their bookings themed in a different way in bookings
// page so staff can recognize them from other customers". The tag's chip is the drawn figure, white on orange; a
// holder's booking carries the mark after the name; the account report counts holders among everyone listed, the
// community's members and the other customers; a community member's booking wears a green band and the
// community's mark on the Bookings page. All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#0c7a3d', locked: true, auto_grant: false },
  { id: 'tag_special_needs', slug: 'special_needs', name: 'Special needs', color: '#e8590c', locked: true, auto_grant: false },
];
const cust = (id: string, name: string) => ({ id, name, email: id + '@example.test', phone: '05000000' + id.slice(1).padStart(2, '0'), height: 170, created_at: '2026-01-01T00:00:00Z' });
const customers = [cust('c1', 'Cora Community Wheel'), cust('c2', 'Carl Community'), cust('c3', 'Sara Wheel'), cust('c4', 'Nora Nobody')];
const customer_tags = [
  { customer_id: 'c1', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 },
  { customer_id: 'c1', tag_id: 'tag_special_needs', added_by: 'staff', added_at: 1 },
  { customer_id: 'c2', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 },
  { customer_id: 'c3', tag_id: 'tag_special_needs', added_by: 'staff', added_at: 1 },
];
const row = (n: number, cid: string, name: string, x: Record<string, unknown> = {}) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-10-20T10:00:00Z', ...x,
});
const queue_entries = [row(1, 'c1', 'Cora Community Wheel'), row(2, 'c2', 'Carl Community', { status: 'active' }), row(3, 'c3', 'Sara Wheel'), row(4, 'c4', 'Nora Nobody')];

async function boot(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 1000 });
  await stubSupabase(page, { sessions, queue_entries, bikes: [], tags, customers, customer_tags, staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0&&(S.customerTags||[]).length>0');
}
const tr = (page: Page, id: string) => page.locator(`#tab-queue .queue-table tbody tr[data-id="${id}"]`);

test.describe('@staff:tags The special needs tag', () => {
  test('its chip is the drawn wheelchair, white on orange, named by its title', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
    const chip = page.locator('#am-cust-rows .am-chip.tag-brand', { has: page.locator('.tag-svg-sn') }).first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveCSS('background-color', 'rgb(232, 89, 12)');
    await expect(chip).toHaveAttribute('title', 'Special needs');
    await expect(chip.locator('svg.sn-ico')).toHaveCount(1);
    await expect(chip).not.toContainText('Special needs');
  });

  test('Bookings: the wheelchair after a holder\'s name; a community member\'s row wears the green band and the mark', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${LIVE}';S.sfShowFinished=true;renderStaffQueue()`);
    await expect(tr(page, 'q1')).toHaveClass(/\bcm-row-mark\b/);
    await expect(tr(page, 'q2')).toHaveClass(/\bcm-row-mark\b/);
    await expect(tr(page, 'q3')).not.toHaveClass(/\bcm-row-mark\b/);
    await expect(tr(page, 'q4')).not.toHaveClass(/\bcm-row-mark\b/);
    await expect(tr(page, 'q1').locator('.cm-mk')).toHaveCount(1);
    await expect(tr(page, 'q4').locator('.cm-mk, .sn-mk')).toHaveCount(0);
    await expect(tr(page, 'q1').locator('.sn-mk')).toHaveAttribute('title', 'Special needs');
    await expect(tr(page, 'q3').locator('.sn-mk')).toHaveCount(1);
    await expect(tr(page, 'q2').locator('.sn-mk')).toHaveCount(0);
    // the band sits outside the status edge, in the community's green
    const sh = await tr(page, 'q2').locator('td').first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(sh).toContain('rgb(12, 122, 61)');
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/sn-roster.png` });
    // the phone cards too
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(`renderStaffQueue()`);
    const card = page.locator('#tab-queue .queue-mobile-view .q-card[data-id="q1"]');
    await expect(card).toHaveClass(/\bcm-row-mark\b/);
    await expect(card.locator('.sn-mk')).toHaveCount(1);
  });

  test('the account report counts holders among everyone listed, the community and the other customers', async ({ page }) => {
    await boot(page);
    const html: string = await page.evaluate(`_accReportHtml()`);
    expect(html).toContain('Special needs');
    expect(html).toContain('Community members: 1 of 2');
    expect(html).toContain('Other customers: 1 of 2');
    expect(html).toMatch(/total-num">50%<\/span><span class="total-lbl">of the accounts listed/);
    const parts = await page.evaluate(`_accSnParts(_accRows())`);
    expect(parts).toEqual({ n: 2, pct: '50%', cm: [1, 2, '50%'], cu: [1, 2, '50%'] });
    // the filter, in the accounts list and the builder
    const pick: string[] = await page.evaluate(`(()=>{const d=_amDefs(true).find(x=>x[0]==='amSn');return S.customers.filter(c=>d[3](c,'yes')).map(c=>c.id);})()`);
    expect(pick.sort()).toEqual(['c1', 'c3']);
    // the session sheet's tile
    expect(await page.evaluate(`_snTile(getQueue())`)).toContain('50%');
    if (process.env.SHOT_DIR) {
      await page.setContent(html);
      await page.screenshot({ path: `${process.env.SHOT_DIR}/sn-report.png`, fullPage: true });
    }
  });

  test('the bell rings when a holder books a ride still to come, and opens Bookings on it', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cq_nt_read2', JSON.stringify({ sneeds: [] })));
    await boot(page);
    await page.waitForFunction('(S.queue||[]).length>0');
    const items: { id: string; txt: string }[] = await page.evaluate(`_ntItems().filter(x=>x.k==='sneeds').map(x=>({id:x.id,txt:x.txt}))`);
    expect(items.map((x) => x.id).sort()).toEqual(['sn:q1', 'sn:q3']);
    expect(items.find((x) => x.id === 'sn:q3')!.txt).toContain('Sara Wheel has special needs and booked');
    // on the Settings page's list of bell kinds
    expect(await page.evaluate(`NT_KINDS.some(k=>k[0]==='sneeds')`)).toBe(true);
    await page.evaluate(`_snBellGo()`);
    expect(await page.evaluate(`S.staffTab+'|'+S.sfSession`)).toBe(`queue|${LIVE}`);
  });

  test('Analytics > Customers: holders, their rides against everyone else, month by month', async ({ page }) => {
    await boot(page);
    const html: string = await page.evaluate(`_anSnCard(getQueue().map(e=>e.id==='q3'?{...e,status:'done'}:e.id==='q4'?{...e,status:'done'}:e))`);
    expect(html).toContain('Riders with special needs');
    expect(html).toContain('1 in the community'); // c1 of the two holders
    expect(html).toContain('50% of all rides'); // Sara's ride of the two completed
    expect(html).toContain('Mar 99');
    expect(await page.evaluate(`(S.tags=S.tags.filter(x=>x.id!=='tag_special_needs'),_anSnCard(getQueue()))`)).toBe('');
  });
});

