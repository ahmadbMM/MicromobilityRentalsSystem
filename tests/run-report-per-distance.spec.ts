import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Run for Her's report builder (the owner, 2026-10-05: "in run for her session add the ability in report
// builder to print a report for each distance in separate"): the builder gives each distance a line of its
// own, Print and CSV, and that sheet carries that distance's runners alone, counted from 1, the distance
// in its title. A runner's sheet has no bike or height to show, takes no money, and a bike-type filter
// saved on a ride night does not empty it.

const RUN = '2099-10-17-rh';
const run = {
  id: RUN, session_date: '2099-10-17', day: 'Saturday', status: 'open', capacity: 80, created_at: 1,
  event_kind: 'community', ride_kind: 'runher', needs_approval: false, hide_queue: true, spots: 80, open_to_all: false,
  paid_ride: false, location: 'JYC', bike_slots: '{"_time":"06:00 - 06:30"}',
};
const jcc = { id: '2099-10-18', session_date: '2099-10-18', day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC' };
const row = (id: string, km: number | null, x: Record<string, unknown> = {}) => ({
  id, session_id: RUN, session_day: 'Saturday', session_date: '2099-10-17', queue_num: Number(id.slice(1)), name: 'Runner ' + id,
  phone: '055000000' + id.slice(1), type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0,
  registered_at: '2099-10-01T10:00:00Z', customer_id: 'c' + id, run_km: km, ...x,
});
const runners = [row('r1', 5, { status: 'active' }), row('r2', 3), row('r3', 5, { status: 'done' }), row('r4', null), row('r5', 3, { status: 'noshow' })];

async function boot(page: Page, sessId = RUN, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [run, jcc], bikes: [], queue_entries: [...runners, { ...row('j1', null), session_id: jcc.id, session_day: 'Sunday', session_date: jcc.session_date, type_preference: 'Hybrid', price: 75 }], ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${sessId}';renderStaffQueue();S._repOpts=null;showPrintReportOptions()`);
}
/** Every report the page opens, as written into its window. */
async function catchReports(page: Page) {
  await page.evaluate(`window.__rep=[];window.open=()=>{const w={document:{write:(h)=>{window.__rep.push(h);},close(){},querySelectorAll:()=>[],fonts:{ready:Promise.resolve()},images:[]},focus(){},print(){}};return w;}`);
}
/** Every CSV the page hands to the browser: its file name and its text. */
async function catchCsv(page: Page) {
  await page.evaluate(`window.__csv=[];const _B=window.Blob;window.Blob=function(p,o){window.__csv.push({text:p.join('')});return new _B(p,o);};
    URL.createObjectURL=()=>'blob:x';const _a=document.createElement.bind(document);
    document.createElement=(t)=>{const el=_a(t);if(t==='a')el.click=()=>{window.__csv[window.__csv.length-1].name=el.download;};return el;};`);
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');

test.describe('@staff:bookings Run for Her report per distance', () => {
  test('the builder has a line per distance with its runners counted, and no bike columns', async ({ page }) => {
    await boot(page);
    const m = page.locator('#print-opts-modal');
    await expect(m.locator('.rpt-km-row')).toHaveCount(3);
    await expect(m.locator('.rpt-km-row').nth(0)).toContainText('3 km');
    await expect(m.locator('.rpt-km-row .rpt-km-n')).toHaveText(['Runners: 2', 'Runners: 2', 'Runners: 1']);
    await expect(m.locator('.rpt-km-row').nth(2)).toContainText('No distance');
    // the distance is a column here, the bike and the height are not, nor is the bike type a filter
    await expect(m.locator('[data-rep="cols:km"]')).toBeVisible();
    await expect(m.locator('[data-rep="cols:bike"]')).toHaveCount(0);
    await expect(m.locator('[data-rep="cols:height"]')).toHaveCount(0);
    await expect(m.getByLabel('Bike type')).toHaveCount(0);
    // the counts follow the filters, and a distance with nobody left cannot be printed
    await m.getByLabel('Status').selectOption('waiting');
    await expect(m.locator('.rpt-km-row .rpt-km-n')).toHaveText(['Runners: 1', 'Runners: 0', 'Runners: 1']);
    await expect(m.locator('.rpt-km-row').nth(1).getByRole('button', { name: 'Print' })).toBeDisabled();
  });

  test('Print on a distance prints that distance alone, counted from 1, and the builder stays open', async ({ page }) => {
    await boot(page);
    await catchReports(page);
    const m = page.locator('#print-opts-modal');
    await m.locator('.rpt-km-row').nth(1).getByRole('button', { name: 'Print' }).click();
    const html = (await page.evaluate('window.__rep') as string[])[0];
    const body = text(html);
    expect(body).toContain('Run for Her · 5 km');
    expect(html).toContain('MM-RPT-991017-5K');
    expect(body).toContain('Runner r1');
    expect(body).toContain('Runner r3');
    expect(body).not.toMatch(/Runner r[245]\b/);
    // counted 1..2, a runner is checked in (not on a bike), no distance column on a one-distance sheet
    expect(html.match(/<td class="rp-seq">(\d+)<\/td>/g)).toEqual(['<td class="rp-seq">1</td>', '<td class="rp-seq">2</td>']);
    expect(body).toContain('Checked in');
    expect(body).not.toContain('On Bike');
    expect(html).not.toMatch(/<th>Distance<\/th>/);
    expect(html).not.toMatch(/<th>Bike<\/th>/);
    // no money on a free run: no Collected tile, no VAT line
    expect(body).toMatch(/2 Runners/);
    expect(body).not.toContain('Collected');
    expect(body).not.toContain('VAT');
    await expect(m.locator('.rpt-km-row')).toHaveCount(3);
    // the next distance is one tap away
    await m.locator('.rpt-km-row').nth(0).getByRole('button', { name: 'Print' }).click();
    const second = text((await page.evaluate('window.__rep') as string[])[1]);
    expect(second).toContain('Run for Her · 3 km');
    expect(second).toContain('Runner r2');
    expect(second).toContain('Runner r5');
    expect(second).not.toMatch(/Runner r[134]\b/);
  });

  test('the full report keeps every runner, with the distance column and a tile per distance', async ({ page }) => {
    await boot(page);
    await catchReports(page);
    await page.locator('#print-opts-modal').getByRole('button', { name: 'PDF / Print' }).click();
    const html = (await page.evaluate('window.__rep') as string[])[0];
    const body = text(html);
    expect(html).toMatch(/<th>Distance<\/th>/);
    expect(html).toContain('MM-RPT-991017<');
    for (const n of ['r1', 'r2', 'r3', 'r4', 'r5']) expect(body).toContain('Runner ' + n);
    expect(body).toMatch(/5 Runners/);
    expect(body).toMatch(/2 3 km/);
    expect(body).toMatch(/2 5 km/);
    expect(body).toMatch(/1 No distance/);
  });

  test('CSV on a distance exports that distance alone, named for it, free runners said free', async ({ page }) => {
    await boot(page);
    await catchCsv(page);
    await page.locator('#print-opts-modal .rpt-km-row').nth(0).getByRole('button', { name: 'CSV' }).click();
    const [csv] = await page.evaluate('window.__csv') as { name: string; text: string }[];
    expect(csv.name).toMatch(/_2099-10-17_3km\.csv$/);
    const lines = csv.text.replace(String.fromCharCode(0xfeff), '').split('\n');
    expect(lines[0]).not.toContain('Distance');
    expect(lines[0]).not.toContain('Bike');
    expect(lines.slice(1).map((l) => l.split(',')[2])).toEqual(['Runner r2', 'Runner r5']);
    expect(lines[1]).toContain('Free');
    expect(lines[1]).not.toContain('Pending');
  });

  test('a bike type saved on a ride night does not empty the run’s report', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cq_rep_opts', JSON.stringify({ fType: 'Hybrid' })));
    await boot(page);
    await expect(page.locator('#print-opts-modal .rpt-km-row .rpt-km-n')).toHaveText(['Runners: 2', 'Runners: 2', 'Runners: 1']);
  });

  test('a ride night’s builder has no distance lines and no distance column', async ({ page }) => {
    await boot(page, jcc.id);
    const m = page.locator('#print-opts-modal');
    await expect(m.locator('.modal-title')).toBeVisible();
    await expect(m.locator('.rpt-km-row')).toHaveCount(0);
    await expect(m.locator('[data-rep="cols:km"]')).toHaveCount(0);
    await expect(m.locator('[data-rep="cols:bike"]')).toBeVisible();
    await expect(m.getByLabel('Bike type')).toBeVisible();
  });

  // The race-day gaps (the owner, 2026-10-06: "fix them"): membership on the run's sheet, the emergency
  // contacts on paper, and the day sheet reading as a run.
  const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#00e585', locked: true }];
  const customer_tags = [{ customer_id: 'cr1', tag_id: 'tag_saturday', added_at: 1, expires_at: null, starts_at: null }];
  const members = async (page: Page) => page.evaluate(`(()=>{S.tags=${JSON.stringify(tags)};S.customerTags=${JSON.stringify(customer_tags)};S._repOpts=null;showPrintReportOptions();})()`);

  test('the run’s report prints Membership when it is ticked, and a ride night is not offered a column it ignores', async ({ page }) => {
    await boot(page, RUN, { tags, customer_tags });
    await members(page);
    await catchReports(page);
    await catchCsv(page);
    const m = page.locator('#print-opts-modal');
    await expect(m.locator('[data-rep="cols:member"]')).toHaveAttribute('aria-pressed', 'true');
    await m.locator('.rpt-km-row').nth(1).getByRole('button', { name: 'Print' }).click();
    const html = (await page.evaluate('window.__rep') as string[])[0];
    expect(html).toMatch(/<th>Membership<\/th>/);
    expect(text(html)).toMatch(/Runner r1 Member\b/);
    expect(text(html)).toMatch(/Runner r3 Non-member/);
    await m.locator('.rpt-km-row').nth(1).getByRole('button', { name: 'CSV' }).click();
    const [csv] = await page.evaluate('window.__csv') as { name: string; text: string }[];
    expect(csv.text.split('\n')[0]).toContain('Membership');
    expect(csv.text).toContain('Runner r1,Member');
    // Untick it and it is gone from the sheet.
    await m.locator('[data-rep="cols:member"]').click();
    await m.locator('.rpt-km-row').nth(1).getByRole('button', { name: 'Print' }).click();
    expect((await page.evaluate('window.__rep') as string[])[1]).not.toMatch(/<th>Membership<\/th>/);
    // A ride night's sheet never printed it: the builder no longer offers it there.
    await page.evaluate(`S.sfSession='${jcc.id}';showPrintReportOptions()`);
    await expect(m.locator('[data-rep="cols:member"]')).toHaveCount(0);
    await expect(m.locator('[data-rep="cols:em"]')).toHaveCount(0);
  });

  test('the emergency contact column: off at first, read once ticked, one line per runner', async ({ page }) => {
    const reads: string[] = [];
    page.on('request', (r) => { if (/\/rest\/v1\/customers\?.*emergency_name/.test(r.url())) reads.push(r.url()); });
    const customers = [
      { id: 'cr1', name: 'Runner r1', phone: '0550000001', emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' },
      { id: 'cr3', name: 'Runner r3', phone: '0550000003', emergency_name: null, emergency_phone: null, emergency_relation: null },
    ];
    await boot(page, RUN, { customers });
    await catchReports(page);
    await catchCsv(page);
    const m = page.locator('#print-opts-modal');
    const em = m.locator('[data-rep="cols:em"]');
    await expect(em).toHaveAttribute('aria-pressed', 'false');
    await m.locator('.rpt-km-row').nth(1).getByRole('button', { name: 'Print' }).click();
    expect((await page.evaluate('window.__rep') as string[])[0]).not.toContain('Emergency contact');
    expect(reads).toEqual([]); // nobody's contact is read until the column is asked for
    await em.click();
    await expect.poll(() => reads.length).toBe(1);
    await expect.poll(() => page.evaluate(`_repEmReady('${RUN}')`)).toBe(true);
    await m.locator('.rpt-km-row').nth(1).getByRole('button', { name: 'Print' }).click();
    const html = (await page.evaluate('window.__rep') as string[])[1];
    expect(html).toMatch(/<th>Emergency contact<\/th>/);
    const body = text(html);
    expect(body).toMatch(/Runner r1 .*Nora Haddad Brother or sister \+966551234567/);
    expect(body).toMatch(/Runner r3 Non-member — /); // no contact on record
    await m.locator('.rpt-km-row').nth(1).getByRole('button', { name: 'CSV' }).click();
    const [csv] = await page.evaluate('window.__csv') as { name: string; text: string }[];
    expect(csv.text).toContain('Nora Haddad · Brother or sister · +966551234567');
    // Printed before the read is in: the read comes first, then the sheet, with the contacts on it.
    await page.evaluate(`S._repEm=null;printSessionReport(5)`);
    await expect.poll(async () => (await page.evaluate('window.__rep') as string[]).length).toBe(3);
    expect((await page.evaluate('window.__rep') as string[])[2]).toContain('Nora Haddad');
  });

  test('the day sheet on race day: each runner’s distance, no bike column, a runner on the course checked in', async ({ page }) => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    const RH = `${today}-rh`;
    const r = (id: string, km: number | null, x: Record<string, unknown> = {}) => ({ ...row(id, km, x), session_id: RH, session_date: today });
    await stubSupabase(page, { sessions: [{ ...run, id: RH, session_date: today }], bikes: [], queue_entries: [r('r1', 5, { status: 'active' }), r('r2', 3), r('r4', null)] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await catchReports(page);
    await page.evaluate('printDaySheet()');
    const html = (await page.evaluate('window.__rep') as string[])[0];
    expect(html).toMatch(/<th>Distance<\/th>/);
    expect(html).not.toMatch(/<th>Bike Type<\/th>/);
    const body = text(html);
    expect(body).toContain('Runners: 3');
    expect(body).toMatch(/Runner r1 5 km Checked in/);
    expect(body).toMatch(/Runner r2 3 km /);
    expect(body).toMatch(/Runner r4 — /);
    expect(body).not.toContain('On Bike');
  });
});
