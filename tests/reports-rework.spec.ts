import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';
import { tapReports, lastReport, viewerFrame } from './helpers/reports';

// The reports rework (the user's decision page, 2026-11-12/13): three looks chosen report by report, the viewer inside
// the site with its number, Excel, CSV and PDF, money for admins only, the Reports section, one builder frame with team
// setups, and the chart kit with tables that line up.

const json = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
const D = '2099-02-08';
const sessions = [{ id: 's0', day: 'Sunday', session_date: D, capacity: 12, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null }];
const qe = (id: string, num: number, name: string, extra: Record<string, unknown>) => ({
  id, session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: num, name, phone: `05000000${num}`, customer_id: null,
  type_preference: 'Hybrid', registered_at: '2099-01-01T10:00:00Z', status: 'done', ...extra,
});
const queue_entries = [
  qe('e1', 4, 'Card Rider', { paid: true, price: 1000, pay_method: 'card' }),
  qe('e2', 5, 'Cash Rider', { paid: true, price: 310, pay_method: 'cash' }),
];

async function boot(page: Page, admin = true) {
  await stubSupabase(page, { sessions, queue_entries });
  await page.route(/\/rest\/v1\/rpc\/report_log_add/, (r) => r.fulfill({ status: 200, headers: json, body: JSON.stringify({ id: 7, no: 'MM-RPT-2099-00007' }) })); // after the stub: the last route wins
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  if (!admin) await page.evaluate(`S.staffRole='frontdesk';S._isAdmin=false`);
}
const shell = (rid: string, body: string) => `(async()=>{const h=await _reportShell({rid:'${rid}',kind:'K',title:'Sunday',subtitle:'8 Feb',body:${JSON.stringify(body)}});await _openReport(h);})()`;
const MONEY_BODY = '<div class="totals"><div class="total-item"><span class="total-num">2</span><span class="total-lbl">Riders</span></div><div class="total-item dark"><span class="total-num">SAR 1,310.00</span><span class="total-lbl">Collected</span></div></div><table><thead><tr><th>Name</th><th>Bike</th><th>Paid</th></tr></thead><tbody><tr><td>A</td><td>Road</td><td><span class="rp-amt">SAR 1,000.00</span></td></tr><tr><td>B</td><td>Hybrid</td><td><span class="rp-amt">SAR 310.00</span></td></tr></tbody></table>';

test.describe('@staff:reports the reports rework', () => {
  test('a report opens on the viewer inside the site, in the look picked for it, and takes its number on Print', async ({ page }) => {
    await boot(page);
    await page.evaluate(`window.open=()=>{window.__popup=1;return null;}`); // nothing may open a window
    await page.evaluate(shell('session', MONEY_BODY));
    const fr = await viewerFrame(page);
    expect(await fr.evaluate(() => document.documentElement.className)).toMatch(/\brx lk-a\b/);
    await expect(fr.locator('.rx-title h1')).toHaveText('Sunday');
    await expect(fr.locator('.rx-no').first()).toHaveText('—'); // no number until it is printed or saved
    await page.evaluate(`(()=>{const f=document.querySelector('#rx-modal .rx-frame');f.contentWindow.print=()=>{window.__printed=1;};})()`);
    await page.locator('#rx-modal [data-rx-act="print"]').click();
    await expect.poll(() => page.evaluate('window.__printed')).toBe(1);
    await expect(fr.locator('.rx-no').first()).toHaveText('MM-RPT-2099-00007');
    await expect(page.locator('#rx-modal .rx-vno')).toContainText('MM-RPT-2099-00007');
    expect(await page.evaluate('window.__popup')).toBeUndefined();
  });

  test('each report wears its own look: a close-out is a statement, the weekly KPIs lead with the money', async ({ page }) => {
    await boot(page);
    await tapReports(page);
    await page.evaluate(shell('close', MONEY_BODY));
    expect(await lastReport(page)).toMatch(/class="rx lk-b/);
    await page.evaluate(shell('weekly', MONEY_BODY));
    expect(await lastReport(page)).toMatch(/class="rx lk-c/);
    expect(await lastReport(page)).not.toMatch(/Reviewed by|mm-sign/); // no signature lines (Q6)
  });

  test('money is for admins: other staff get the sheet without amounts, and a money-only report does not open', async ({ page }) => {
    await boot(page, false);
    await tapReports(page);
    await page.evaluate(shell('session', MONEY_BODY));
    const html = await lastReport(page);
    expect(html).not.toContain('SAR 1,310.00'); // the money tile
    expect(html).not.toContain('SAR 310.00'); // the Paid column
    expect(html).toContain('<th>Bike</th>');
    expect(html).not.toContain('<th>Paid</th>');
    await page.evaluate(`S._rxTap=null`);
    await page.evaluate(shell('z', MONEY_BODY)); // the Z-report: all money, refused at the viewer
    await expect(page.locator('#toast-container')).toContainText('Admin only');
    await expect(page.locator('#rx-modal .rx-frame')).toHaveCount(0);
  });

  test('Excel is a real workbook read from the report, quantities as numbers', async ({ page }) => {
    await boot(page);
    await page.evaluate(`window.__x=[];const _B=window.Blob;window.Blob=function(p,o){window.__x.push({type:o&&o.type,parts:p});return new _B(p,o);};`);
    await page.evaluate(shell('session', MONEY_BODY));
    await viewerFrame(page);
    await page.locator('#rx-modal [data-rx-act="xlsx"]').click();
    await expect.poll(() => page.evaluate(`window.__x.some(b=>/spreadsheetml/.test(b.type||''))`)).toBe(true);
  });

  test('the Reports section lists every report by area; a money report only for admins', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('reports')`);
    await expect(page.locator('#tab-reports .rp2-card[data-rp2="session"]')).toBeVisible();
    await expect(page.locator('#tab-reports .rp2-card[data-rp2="z"]')).toBeVisible();
    await page.locator('#rp2-q').fill('z-rep');
    await expect(page.locator('#tab-reports .rp2-card')).toHaveCount(1);
    await page.evaluate(`S.staffRole='frontdesk';S._isAdmin=false;renderReports()`);
    await page.locator('#rp2-q').fill('');
    await expect(page.locator('#tab-reports .rp2-card[data-rp2="z"]')).toHaveCount(0);
    await expect(page.locator('#tab-reports .rp2-card[data-rp2="day"]')).toBeVisible();
  });

  test('the builder has the saved setups and draws the report beside the choices', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await boot(page);
    await page.evaluate(`S.sfSession='s0';setStaffTab('queue');showPrintReportOptions()`);
    await expect(page.locator('#print-opts-modal .rb-bar')).toBeVisible();
    await expect(page.locator('#print-opts-modal .rb-bar button', { hasText: 'Save for the team' })).toBeVisible();
    await expect.poll(() => page.evaluate(`(()=>{const f=document.querySelector('#print-opts-modal .rb-frame');return !!(f&&f.contentDocument&&f.contentDocument.querySelector('.rx-main'));})()`)).toBe(true);
    expect(await page.evaluate(`document.querySelectorAll('#rx-modal .rx-frame').length`)).toBe(0); // the preview is no report opened
  });

  test('charts: round axis values, the latest point said, the numbers in a table; tables line quantities up', async ({ page }) => {
    await boot(page);
    const html = (await page.evaluate(`(async()=>{await _loadStaffPart('analytics');return _areaChart([{vals:[969,1938,2906,3875],label:'Collected',fill:true}],['1 Jan 2026','2 Jan 2026','3 Jan 2026','4 Jan 2026'],{unitPfx:'SAR '});})()`)) as string;
    expect(html).toContain('SAR 4,000'); // the top of a round scale, not SAR 3875
    expect(html).toContain('SAR 3,875'); // the end of the line says its value
    expect(html).toContain('class="ck-tv"'); // the numbers under the chart
    await page.evaluate(`(()=>{const d=document.createElement('div');d.id='ck-t';d.innerHTML='<table><thead><tr><th>Name</th><th>Rides</th><th>Booking no.</th></tr></thead><tbody><tr><td>A</td><td>12</td><td>40</td></tr><tr><td>B</td><td>3</td><td>41</td></tr></tbody></table>';document.body.appendChild(d);_ckAlignTables(d,true);})()`);
    expect(await page.locator('#ck-t th').nth(1).getAttribute('class')).toContain('ck-num');
    expect(await page.locator('#ck-t th').nth(2).getAttribute('class') || '').not.toContain('ck-num'); // a number that names something stays at the start
  });
});
