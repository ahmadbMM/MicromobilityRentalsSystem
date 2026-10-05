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

async function boot(page: Page, sessId = RUN) {
  await stubSupabase(page, { sessions: [run, jcc], bikes: [], queue_entries: [...runners, { ...row('j1', null), session_id: jcc.id, session_day: 'Sunday', session_date: jcc.session_date, type_preference: 'Hybrid', price: 75 }] });
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
});
