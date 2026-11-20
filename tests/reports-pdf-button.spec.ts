import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Reports > PDF beside each Open (the user, 2026-11-20: "in reports page add a download pdf button besides each
// open button"). A card whose report is drawn at once saves it as a PDF on a hidden sheet, never shown; a card that opens a
// builder or the report's own section saves the report made there; Open still shows its report.

const json = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
const D = '2099-02-08';
const sessions = [{ id: 's0', day: 'Sunday', session_date: D, capacity: 12, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null }];
const queue_entries = [
  { id: 'e1', session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: 4, name: 'Card Rider', phone: '0500000004', customer_id: null,
    type_preference: 'Hybrid', registered_at: '2099-01-01T10:00:00Z', status: 'done', paid: true, price: 1000, pay_method: 'card' },
];
const SAT = {
  generated_at: '2099-02-10T08:00:00Z',
  summary: { attendances: 315, checked_in: 300, not_checked_in: 15, unique_riders: 200, first_ride: '2099-01-03', rides_held: 2, avg_per_ride: 157.5,
    best_count: 180, best_date: '2099-01-10', last_count: 135, last_date: '2099-01-17', repeat_riders: 80, repeat_pct: 40, no_shows: 10, show_rate: 90 },
  rides: [
    { date: '2099-01-10', state: 'held', attended: 180, checked_in: 175, not_checked_in: 5, first_timers: 100, returning: 80, no_shows: 4, cancelled: 3, requests: 0, capacity: 200 },
    { date: '2099-01-17', state: 'held', attended: 135, checked_in: 125, not_checked_in: 10, first_timers: 100, returning: 35, no_shows: 6, cancelled: 2, requests: 0, capacity: 200 },
  ],
  frequency: [{ lo: 1, hi: 1, riders: 120, attendances: 120 }],
  mix: [{ dimension: 'gender', label: 'female', value: 110, pct: 55 }],
};

async function boot(page: Page) {
  const vias: string[] = [];
  await stubSupabase(page, { sessions, queue_entries });
  await page.route(/\/rest\/v1\/rpc\/staff_saturday_ride_report/, (r) => r.fulfill({ status: 200, headers: json, body: JSON.stringify(SAT) }));
  await page.route(/\/rest\/v1\/rpc\/report_log_add/, (r) => {
    vias.push((r.request().postDataJSON() || {}).p_via);
    return r.fulfill({ status: 200, headers: json, body: JSON.stringify({ id: 7, no: 'MM-RPT-2099-00007' }) });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  // the viewer is never seen while a PDF is made: any moment it is shown is kept
  await page.evaluate(`(()=>{window.__shown=0;new MutationObserver(()=>{const m=document.getElementById('rx-modal');if(m&&!m.hidden&&!m.classList.contains('rx-bg'))window.__shown=1;}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','class']});})()`);
  await page.evaluate(`setStaffTab('reports')`);
  return vias;
}
const card = (page: Page, id: string) => page.locator(`#tab-reports .rp2-card[data-rp2="${id}"]`);
async function isPdf(path: string | null) {
  expect(path).toBeTruthy();
  return readFileSync(path as string).subarray(0, 5).toString('latin1');
}

test.describe('@staff:reports PDF beside Open', () => {
  test('every card has PDF beside Open, and it is off where Open is off', async ({ page }) => {
    await boot(page);
    const cards = page.locator('#tab-reports .rp2-card');
    await expect(cards.first()).toBeVisible();
    const n = await cards.count();
    expect(n).toBeGreaterThan(10);
    await expect(page.locator('#tab-reports .rp2-card .rp2-acts .rp2-go + .rp2-pdf')).toHaveCount(n);
    await expect(card(page, 'satride').locator('.rp2-pdf')).toHaveText('PDF');
    // a card with no session to pick (no Victory Lap race here): both off
    await expect(card(page, 'vl').locator('.rp2-go')).toBeDisabled();
    await expect(card(page, 'vl').locator('.rp2-pdf')).toBeDisabled();
  });

  test('a report drawn at once is saved as a PDF, with its number, and the viewer is never shown', async ({ page }) => {
    const vias = await boot(page);
    const dl = page.waitForEvent('download');
    await card(page, 'satride').locator('.rp2-pdf').click();
    const d = await dl;
    expect(d.suggestedFilename()).toMatch(/MM-RPT-2099-00007\.pdf$/);
    expect(await isPdf(await d.path())).toBe('%PDF-');
    expect(vias).toEqual(['pdf']);
    await expect(page.locator('#rx-modal')).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/\brx-open\b/);
    await expect(card(page, 'satride').locator('.rp2-pdf')).toBeEnabled();
    expect(await page.evaluate('window.__shown')).toBe(0);
    expect(await page.evaluate('S._rxAuto')).toBeNull();
    // Open still shows the report on the viewer, and saves nothing
    let saved = 0;
    page.on('download', () => { saved++; });
    await card(page, 'satride').locator('.rp2-go').click();
    await expect(page.locator('#rx-modal')).toBeVisible();
    await expect(page.locator('#rx-modal')).not.toHaveClass(/rx-bg/);
    await page.waitForTimeout(400);
    expect(saved).toBe(0);
  });

  test('a card that opens a builder: the report made there is saved as a PDF; Open shows it', async ({ page }) => {
    const vias = await boot(page);
    await card(page, 'session').locator('select').selectOption('s0');
    await card(page, 'session').locator('.rp2-pdf').click();
    await expect(page.locator('#toast-container .toast').last()).toContainText('Make the report as usual and it downloads as a PDF.');
    const go = page.locator('#print-opts-modal .rpt-acts .btn-primary');
    await expect(go).toBeVisible();
    const dl = page.waitForEvent('download');
    await go.click();
    expect(await isPdf(await (await dl).path())).toBe('%PDF-');
    expect(vias).toEqual(['pdf']);
    await expect(page.locator('#rx-modal')).toBeHidden();
    expect(await page.evaluate('window.__shown')).toBe(0);
    // the same card's Open: the builder, then the report on the viewer
    await page.evaluate(`setStaffTab('reports')`);
    await card(page, 'session').locator('select').selectOption('s0');
    await card(page, 'session').locator('.rp2-go').click();
    await page.locator('#print-opts-modal .rpt-acts .btn-primary').click();
    await expect(page.locator('#rx-modal')).toBeVisible();
    await expect(page.locator('#rx-modal')).not.toHaveClass(/rx-bg/);
  });

  test('a PDF waiting for a report is dropped by another section, by Open, and soon after its builder is cancelled', async ({ page }) => {
    await boot(page);
    // the close-out is made in the Cash register: the wait goes with the staffer leaving it
    await card(page, 'close').locator('.rp2-pdf').click();
    expect(await page.evaluate('S.staffTab')).toBe('cashier');
    expect(await page.evaluate('S._rxAuto&&S._rxAuto.tab')).toBe('cashier');
    await page.evaluate(`setStaffTab('sessions')`);
    expect(await page.evaluate('S._rxAuto')).toBeNull();
    // Open on any card after PDF: no report is saved by surprise
    await page.evaluate(`setStaffTab('reports')`);
    await card(page, 'acc').locator('.rp2-pdf').click();
    expect(await page.evaluate('!!S._rxAuto')).toBe(true);
    await page.evaluate('_closePrintOpts()'); // Cancel: thirty seconds left at most
    expect(await page.evaluate('S._rxAuto.until-Date.now()')).toBeLessThanOrEqual(30000);
    await card(page, 'acc').locator('.rp2-go').click();
    expect(await page.evaluate('S._rxAuto')).toBeNull();
  });

  test('in Urdu, Hindi, Nepali and Bengali the sheet is shown for the browser\'s own Save as PDF', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.lang='ur'`);
    await page.evaluate(`window.__pr=0;const _o=HTMLIFrameElement.prototype.addEventListener;HTMLIFrameElement.prototype.addEventListener=function(t,f,o){if(t==='load'&&this.classList.contains('rx-frame'))return _o.call(this,t,function(e){try{this.contentWindow.print=()=>{window.__pr++;};}catch(_){}return f.call(this,e);},o);return _o.call(this,t,f,o);}`);
    await card(page, 'satride').locator('.rp2-pdf').click();
    await expect.poll(() => page.evaluate('window.__pr')).toBe(1);
    await expect(page.locator('#rx-modal')).toBeVisible();
    await expect(page.locator('#rx-modal')).not.toHaveClass(/rx-bg/);
    await expect(card(page, 'satride').locator('.rp2-pdf')).toBeEnabled();
  });
});
