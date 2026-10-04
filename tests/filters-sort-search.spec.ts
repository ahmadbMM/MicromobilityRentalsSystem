import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff views, 2026-09-22: every view's filter dropdowns sit behind one Filter button; on a phone
// a page's search bar is a search button until tapped; every search finds a phone typed the way
// a rider says it (05x for +9665x and back); every table sorts by any column; and the Petromin
// list reads first booking to last, P-001 upward, a night at a time.

const ksa = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const TODAY = ksa(new Date());
const SESS = `${TODAY}-a`;
const sessions = [{ id: SESS, day: 'Friday', session_date: TODAY, capacity: 12, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '19:00 - 23:00' }) }];
const row = (id: string, n: number, name: string, phone: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: SESS, session_day: 'Friday', session_date: TODAY, queue_num: n, name, phone, email: '',
  type_preference: 'Hybrid', size: 'M', status: 'waiting', paid: false, price: 60, registered_at: `${TODAY}T10:0${n}:00Z`, ...extra,
});
const queue_entries = [
  row('q1', 1, 'Intl Rider', '+966564221234'),
  row('q2', 2, 'Local Rider', '0551112222'),
  row('q3', 3, 'Done Rider', '+966577778888', { status: 'done', paid: true }),
];

type P = import('@playwright/test').Page;
async function boot(page: P, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
const rendered = (page: P, id: string) => page.evaluate(`document.getElementById('${id}').innerText`) as Promise<string>;

test('History: the dropdowns open under the Filter button, named, and the button counts what is on', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffTab('history')`);
  const panel = page.locator('#fm-hist');
  await expect(panel).toBeHidden();
  const btn = page.locator('#tab-history .filter-toggle');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('.filter-field-lbl')).toHaveText(['Status', 'Pay', 'Type', 'Size', 'Range']);
  // the session picker is the view's context: it stands in the bar, never behind the button
  await expect(page.locator('#tab-history .filter-sess select')).toBeVisible();
  await panel.locator('select').first().selectOption('done');
  // the re-render keeps the panel open and the button now says one filter is on
  await expect(page.locator('#fm-hist')).toBeVisible();
  await expect(page.locator('#tab-history .filter-toggle')).toContainText('(1)');
});

test('every search finds a phone typed as 05x, 5x or +966 5x, and a name search never matches digits', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffTab('queue')`);
  for (const q of ['0564', '0564 221', '564221', '+966564', '00966564']) {
    await page.evaluate(`setSfSearch(${JSON.stringify(q)})`);
    await expect.poll(async () => { const t = await rendered(page, 'q-results'); return t.includes('Intl Rider') && !t.includes('Local Rider'); }, { message: q }).toBe(true);
  }
  // and the other way: a number saved as 05x is found from +966 5x
  await page.evaluate(`setSfSearch('+96655111')`);
  await expect.poll(async () => { const t = await rendered(page, 'q-results'); return t.includes('Local Rider') && !t.includes('Intl Rider'); }).toBe(true);
  expect(await page.evaluate(`_phoneHit('+966564221234','ahmed')`)).toBe(false);
  expect(await page.evaluate(`_phoneHit('+201001234567','0100123')`)).toBe(true);
  expect(await page.evaluate(`_phoneHit('+966564221234','٠٥٦٤')`)).toBe(true);
});

test('a plain table sorts by any column it shows, reverses on a second tap, and keeps the order through a re-render', async ({ page }) => {
  await boot(page, {
    inventory: [
      { id: 'i1', name: 'Bravo Gel', category: 'EnergyGels', qty: 5, price: 12, low_threshold: 1 },
      { id: 'i2', name: 'Alpha Bar', category: 'EnergyGels', qty: 30, price: 8, low_threshold: 1 },
      { id: 'i3', name: 'Charlie Drink', category: 'EnergyGels', qty: 12, price: 20, low_threshold: 1 },
    ],
  });
  await page.evaluate(`setStaffTab('inventory');S.invSection='supplements';S.invSort='name';S.invView='table';renderInventory()`);
  const table = page.locator('#tab-inventory table').first();
  await expect(table.locator('tbody tr')).toHaveCount(3);
  const head = table.locator('thead th.th-sort');
  await expect(head.first()).toBeVisible();
  const col = await table.locator('thead th').evaluateAll((ths) => ths.findIndex((th) => /in stock/i.test(th.textContent || '')));
  expect(col).toBeGreaterThan(-1);
  const qty = () => table.locator('tbody tr').evaluateAll((trs, c) => trs.map((tr) => (tr as HTMLTableRowElement).cells[c as number].dataset.sort!), col);
  await table.locator('thead th').nth(col).click();
  await expect(table.locator('thead th').nth(col)).toHaveAttribute('aria-sort', 'ascending');
  expect(await qty()).toEqual(['5', '12', '30']);
  await table.locator('thead th').nth(col).click();
  await expect(table.locator('thead th').nth(col)).toHaveAttribute('aria-sort', 'descending');
  expect(await qty()).toEqual(['30', '12', '5']);
  await page.evaluate(`renderInventory()`);
  await expect.poll(qty).toEqual(['30', '12', '5']);
});

test('a table that sorts itself (its headers carry a data-on-click) is left to its own sort', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffTab('inventory')`);
  await page.evaluate(`(()=>{const d=document.createElement('div');d.id='ts-probe';d.innerHTML='<table><thead><tr><th data-on-click=\\'["setSfSort","name"]\\'>Name</th><th>Qty</th></tr></thead><tbody><tr><td>B</td><td>2</td></tr><tr><td>A</td><td>1</td></tr></tbody></table><table id="ts-plain"><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>B</td><td>2</td></tr><tr><td>A</td><td>1</td></tr></tbody></table>';document.querySelector('main').appendChild(d);_mountTableSorts();})()`);
  await expect(page.locator('#ts-probe table').first().locator('th.th-sort')).toHaveCount(0);
  await expect(page.locator('#ts-plain th.th-sort')).toHaveCount(2);
});

test('Petromin: P-001 upward by default, any column on a tap, and two nights\' P-001 stay two bookings', async ({ page }) => {
  const S2 = `${TODAY}-pm`, OLD = '2020-01-01-pm';
  const pm = (id: string, extra: Record<string, unknown> = {}) => ({ id: `${id}-s`, day: 'Wednesday', session_date: id.slice(0, 10), capacity: 35, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '19:00 - 21:00' }), ride_kind: 'petromin', event_kind: 'community', paid_ride: true, ...extra });
  const base = { source: 'petromin', updated_at: '2099-02-08T09:00:00Z', created_at: '2099-02-08T09:00:00Z', height: 170, type_preference: 'Hybrid', company: 'Petromin', submissions: 1, checked_in_at: null, checked_out_at: null, match_kind: 'none' };
  const reg = (id: number, sid: string, no: string, name: string, extra: Record<string, unknown> = {}) => ({ ...base, id, session_id: sid, booking_no: no, party_no: 1, badge: `B${id}`, name, phone: `+96650000000${id}`, ...extra });
  await boot(page, {
    sessions: [...sessions, { ...pm(S2), id: S2 }, { ...pm(OLD), id: OLD, status: 'closed' }],
    rider_registrations: [
      reg(1, S2, 'P-003', 'Third Tonight', { updated_at: '2099-02-08T12:00:00Z' }),
      reg(2, S2, 'P-001', 'First Tonight', { updated_at: '2099-02-08T09:00:00Z' }),
      reg(3, S2, 'P-010', 'Tenth Tonight', { updated_at: '2099-02-08T13:00:00Z', height: 150 }),
      reg(4, S2, 'P-002', 'Second Tonight', { updated_at: '2099-02-08T10:00:00Z', height: 190 }),
      reg(5, OLD, 'P-001', 'First Old Night'),
    ],
  });
  await page.evaluate(`S.ridersSession=${JSON.stringify(S2)};setStaffTab('riders')`);
  const names = () => page.locator('#riders-results tbody tr td:nth-child(3)').evaluateAll((tds) => tds.map((td) => td.textContent!.trim().split('+')[0].trim()));
  await expect.poll(names).toEqual(['First Tonight', 'Second Tonight', 'Third Tonight', 'Tenth Tonight']);
  await page.locator('#riders-results thead th', { hasText: 'Height' }).click();
  await expect.poll(names).toEqual(['Tenth Tonight', 'First Tonight', 'Third Tonight', 'Second Tonight']);
  // every night: the latest night leads, and each night's P-001 is its own booking
  await page.evaluate(`S.ridersSort='no';S.ridersSortDir=1;S.ridersSession='all';renderRiders()`);
  await expect.poll(names).toEqual(['First Tonight', 'Second Tonight', 'Third Tonight', 'Tenth Tonight', 'First Old Night']);
  expect(await page.evaluate(`_riderParty(S.riders.find(r=>r.id===2)).length`)).toBe(1);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the search bar is a search button that opens where it stands and folds back on ×', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('history')`);
    const wrap = page.locator('[data-srch="hist"]');
    const input = page.locator('#hist-search-input');
    await expect(input).toBeHidden();
    await wrap.locator('.srch-btn').click();
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill('0577');
    await expect.poll(() => rendered(page, 'hist-results')).toContain('Done Rider');
    await wrap.locator('.search-clear').click();
    await expect(input).toBeHidden();
    await expect(wrap.locator('.srch-btn')).toBeVisible();
    expect(await page.evaluate(`S.histSearch`)).toBe('');
  });
});

// What is typed starts clear of the search icon and stops short of the × (the owner, 2026-09-30:
// "the name or text typed in the search bar overlaps with the search icon"): the staff form-field
// padding reached the searches written type="text" and the text ran under the icon.
const searchGaps = (id: string) => {
  const inp = document.getElementById(id) as HTMLInputElement, w = inp.parentElement as HTMLElement;
  const cs = getComputedStyle(inp), r = inp.getBoundingClientRect();
  const ic = (w.querySelector(':scope>svg') as Element).getBoundingClientRect();
  const x = (w.querySelector('.search-clear') as Element).getBoundingClientRect();
  const start = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  const end = r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
  return cs.direction === 'rtl' ? { icon: ic.left - end, x: start - x.right } : { icon: start - ic.right, x: x.left - end };
};
for (const lang of ['en', 'ar']) {
  test(`a search's text keeps clear of its icon and its × (${lang})`, async ({ page }) => {
    if (lang === 'ar') await page.addInitScript(() => { localStorage.setItem('cq_lang', 'ar'); localStorage.setItem('cq_lang_pick', '1'); });
    await boot(page, { customers: [{ id: 'c1', name: 'Intl Rider', email: 'i@x.sa', phone: '+966564221234', created_at: '2026-09-01T00:00:00Z' }], community_applications: [] });
    for (const [open, id] of [
      [`setStaffTab('community');setCommTab('accounts')`, 'am-search'],
      [`setStaffTab('community');setCommTab('applications')`, 'ca-q'],
      [`setStaffTab('inventory')`, 'bk-search-input'],
      [`setStaffTab('queue')`, 'sf-search-input'],
    ]) {
      await page.evaluate(open);
      const wrap = page.locator(`#${id}`).locator('xpath=..');
      const fold = wrap.locator('.srch-btn');
      if (await fold.isVisible()) await fold.click(); // a phone folds the search into a button
      await page.locator(`#${id}`).fill('Mohammed Abdulrahman');
      await expect(wrap.locator('.search-clear')).toBeVisible();
      const g = await page.evaluate(searchGaps, id);
      expect(g.icon, id).toBeGreaterThanOrEqual(4);
      expect(g.x, id).toBeGreaterThanOrEqual(0);
    }
  });
}
