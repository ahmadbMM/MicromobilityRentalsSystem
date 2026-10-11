import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Sort and filter inside every report (the owner, 2026-10-11: "make me be able to sort and filter whats
// inside all reports"): _openReport wires each table of the shell - a heading sorts, a filter line narrows
// - and the total and group rows stay put.

const body = `<table><thead><tr><th>Name</th><th>Paid</th></tr></thead><tbody>
  <tr class="rp-grp"><td colspan="2">Group A</td></tr>
  <tr><td>Cara</td><td>SAR 1,310.00</td></tr>
  <tr><td>alma</td><td>SAR 90.00</td></tr>
  <tr><td>Badr</td><td>—</td></tr>
  <tr class="rp-grp"><td colspan="2">Group B</td></tr>
  <tr><td>Dina</td><td>SAR 400.00</td></tr>
  <tr><td>Eyad</td><td>SAR 5.00</td></tr>
  <tr class="rp-b8"><td>Total</td><td>SAR 1,805.00</td></tr>
</tbody></table>
<table><thead><tr><th>Only</th></tr></thead><tbody><tr><td colspan="1">—</td></tr></tbody></table>`;

test.describe('@staff:reports sort and filter inside a report', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page, {});
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  });

  test('a heading sorts within each group, a filter narrows, totals stay and the sheet says so', async ({ page }) => {
    const [pop] = await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate(`_openReport(_reportShell({kind:'Test',title:'Test',body:${JSON.stringify(body)}}))`),
    ]);
    const names = () => pop.locator('table').first().locator('tbody tr:not(.rp-hide)').evaluateAll(rs => rs.map(r => [...(r as HTMLTableRowElement).cells].map(c => (c.textContent || '').trim()).join(' ')));
    await expect(pop.locator('.rp-tools')).toHaveCount(1); // five rows: a filter line; the one-row table gets none
    await expect(pop.locator('.rp-cnt')).toHaveText('5 rows');

    // the money column sorts as numbers, blanks last, each group on its own; the total stays at the end
    await pop.getByRole('button', { name: 'Paid' }).click();
    await expect(pop.locator('th').nth(1)).toHaveAttribute('aria-sort', 'ascending');
    expect(await names()).toEqual(['Group A', 'alma SAR 90.00', 'Cara SAR 1,310.00', 'Badr —', 'Group B', 'Eyad SAR 5.00', 'Dina SAR 400.00', 'Total SAR 1,805.00']);
    await pop.getByRole('button', { name: 'Paid' }).click();
    expect(await names()).toEqual(['Group A', 'Cara SAR 1,310.00', 'alma SAR 90.00', 'Badr —', 'Group B', 'Dina SAR 400.00', 'Eyad SAR 5.00', 'Total SAR 1,805.00']);
    await pop.getByRole('button', { name: 'Paid' }).click(); // third tap: the sheet's own order
    await expect(pop.locator('th').nth(1)).not.toHaveAttribute('aria-sort', /./);
    expect(await names()).toEqual(['Group A', 'Cara SAR 1,310.00', 'alma SAR 90.00', 'Badr —', 'Group B', 'Dina SAR 400.00', 'Eyad SAR 5.00', 'Total SAR 1,805.00']);

    // names sort as words, whatever the case
    await pop.getByRole('button', { name: 'Name' }).click();
    expect((await names()).slice(0, 4)).toEqual(['Group A', 'alma SAR 90.00', 'Badr —', 'Cara SAR 1,310.00']);

    // the filter: a group with nothing left goes, the total stays, the count and the paper note follow
    await pop.getByLabel('Filter rows').fill('dina');
    expect(await names()).toEqual(['Group B', 'Dina SAR 400.00', 'Total SAR 1,805.00']);
    await expect(pop.locator('.rp-cnt')).toHaveText('1 of 5 rows');
    await expect(pop.locator('.rp-fnote')).toHaveText('Filtered: “dina”, 1 of 5 rows. Totals count every row.');
    // in one column only: "SAR" is in every Paid cell, in no Name cell
    await pop.getByLabel('Filter rows').fill('sar');
    await expect(pop.locator('.rp-cnt')).toHaveText('4 of 5 rows');
    await pop.getByLabel('Look in').selectOption({ label: 'Name' });
    await expect(pop.locator('.rp-cnt')).toHaveText('0 of 5 rows');
    await pop.getByLabel('Filter rows').fill('');
    await expect(pop.locator('.rp-cnt')).toHaveText('5 rows');
    await expect(pop.locator('.rp-fnote')).toBeHidden();

  });

  test('on paper the filter line goes and a filtered table says so (report.css)', async () => {
    const css = readFileSync('report.css', 'utf8');
    const print = css.slice(css.indexOf('@media print{body'));
    expect(print).toMatch(/\.rp-tools\{display:none\}/);
    expect(print).toMatch(/\.rp-fnote:not\(\[hidden\]\)\{display:block\}/);
    expect(css).toMatch(/:root tr\.rp-hide\{display:none\}/);
  });

  test('the session report is wired: its headings are buttons', async ({ page }) => {
    const [pop] = await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate(`_openReport(_reportShell({kind:'K',title:'T',body:'<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>2</td><td>x</td></tr><tr><td>10</td><td>y</td></tr></tbody></table>'}))`),
    ]);
    await pop.getByRole('button', { name: 'A' }).click();
    await expect(pop.locator('tbody td:first-child')).toHaveText(['2', '10']); // 2 before 10: numbers, not words
    await expect(pop.locator('.rp-tools')).toHaveCount(0); // two rows: sorting only
  });
});
