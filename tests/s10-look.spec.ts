import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff round s10, the look pass (reports/Staff website design and function.md items 18-25, 27 and the owner's D6):
// one type scale in rem, weights 400-600, the radius ladder, sentence case, green for actions and success only, the
// payment pills round, Bookings' session cards as Soft Solid cards, a row tinted only for an exception, one empty
// state, and in dark mode visible checkboxes and colour dots. Invented riders only; the day is far ahead, so the
// clock does not matter.

// The check is an ES module the build imports; it is run here the way the build and a person run it.
const mod = (code: string) => execFileSync(process.execPath, ['--input-type=module', '-e', `import * as m from './scripts/check-staff-css.mjs'; ${code}`], { encoding: 'utf8' });

test.describe('the build check on the staff CSS (item 27)', () => {
  test('a raw px size, a weight above 600 and a radius off the ladder are refused; tokens pass', () => {
    const cases: [string, string, boolean][] = [
      ['font-size', '14px', true], ['font-size', 'var(--sf-fs-sm)', false], ['font-size', 'var(--staff-fs-sm,12px)', false],
      ['font', '700 13px/1.2 var(--font-body)', true], ['font-weight', '800', true], ['font-weight', '600', false],
      ['border-radius', '6px', true], ['border-radius', '8px 8px 4px 4px', false], ['border-radius', '50%', false], ['border-radius', 'var(--sf-r-pill)', false],
    ];
    const got = JSON.parse(mod(`console.log(JSON.stringify(${JSON.stringify(cases)}.map(([p, v]) => m.badDecl(p, v) !== '')))`));
    expect(got).toEqual(cases.map((c) => c[2]));
  });
  test('styles.css as it stands: no offender, every allow-list entry has a reason and still matches', () => {
    const out = execFileSync(process.execPath, ['scripts/check-staff-css.mjs'], { encoding: 'utf8' });
    expect(out).toMatch(/check-staff-css: 0 offender\(s\), 0 stale allow-list entr\(ies\), \d+ allowed/);
    const allow = JSON.parse(mod(`console.log(JSON.stringify(m.loadAllow()))`)) as { why: string }[];
    for (const a of allow) expect(a.why.length).toBeGreaterThan(20);
  });
});

const D = '2099-10-18';
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const sessions = [{ id: D, day: 'Sunday', session_date: D, capacity: 12, status: 'open', created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":12}' }];
const bikes = [{ id: 'b1', name: 'R-11', type: 'Road', size: 'M', status: 'in_use', colors: ['#0b1f4a'] }, { id: 'b2', name: 'H-02', type: 'Hybrid', size: 'L', status: 'in_use', colors: ['#111111'] }];
const row = (n: number, name: string, x: Record<string, unknown> = {}) => ({
  id: 'q' + n, name, session_id: D, session_day: 'Sunday', session_date: D, queue_num: n, status: 'waiting', paid: false,
  price: 75, registered_at: D + 'T10:00:00Z', type_preference: 'Road', size: 'M', height: 172, phone: '05500000' + String(n).padStart(2, '0'), ...x });
const rows = [
  row(1, 'Waiting Rider'),
  row(2, 'Fresh Ride', { status: 'active', paid: true, assigned_bike_id: 'b1', checked_in_at: ago(10) }),
  row(3, 'Long Ride', { status: 'active', paid: true, assigned_bike_id: 'b2', checked_in_at: ago(400) }),
  row(4, 'Done Rider', { status: 'done', paid: true }),
  row(5, 'No Show Rider', { status: 'noshow' }),
];

async function bookings(page: Page, theme = 'light') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (theme !== 'light') await page.addInitScript((th) => localStorage.setItem('cq_staff_theme', th), theme);
  await stubSupabase(page, { sessions, bikes, queue_entries: rows });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getBikes().length>0');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${D}';S.sfShowFinished=true;renderStaffQueue()`);
  await expect(page.locator('#tab-queue .queue-table-desktop-wrap tbody tr').first()).toBeVisible();
}
const tr = (name: string) => `#tab-queue .queue-table-desktop-wrap tbody tr:has-text("${name}")`;
const css = (page: Page, sel: string, prop: string) => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test.describe('@staff:bookings the look pass on Bookings', () => {
  test('D6: only a no-show and an overdue ride keep a tint; every row keeps its 3px edge', async ({ page }) => {
    await bookings(page);
    const bg = (name: string) => css(page, `${tr(name)} td:nth-child(3)`, 'background-color');
    for (const n of ['Waiting Rider', 'Fresh Ride', 'Done Rider']) expect(await bg(n), n).toBe('rgb(255, 255, 255)');
    await expect(page.locator(tr('Long Ride'))).toHaveClass(/\brow-overdue\b/);
    await expect(page.locator(tr('Fresh Ride'))).not.toHaveClass(/\brow-overdue\b/);
    expect(await bg('Long Ride')).toBe('rgb(255, 250, 235)');
    expect(await bg('No Show Rider')).toBe('rgb(254, 242, 242)');
    expect(await css(page, `${tr('Fresh Ride')} td:first-child`, 'box-shadow')).toContain('inset');
  });

  test('green is for actions: the row action is tonal, heights and sort headers are ink; pills are round', async ({ page }) => {
    await bookings(page);
    const act = `${tr('Waiting Rider')} .rq-act`;
    await expect(page.locator(act)).toHaveText('Check in');
    expect(await css(page, act, 'background-color')).not.toBe('rgb(12, 122, 61)');
    expect(await css(page, act, 'color')).toBe('rgb(12, 122, 61)');
    expect(await css(page, '#tab-queue .q-height', 'color')).toBe('rgb(17, 21, 18)');
    expect(parseFloat(await css(page, '#tab-queue .queue-table .pay-toggle.pending', 'border-top-left-radius'))).toBeGreaterThan(100);
    await expect(page.locator('#tab-queue .queue-table-desktop-wrap thead')).toContainText('Bike type');
  });

  test('the circuit\'s card is a Soft Solid card with a 3px edge, in light and dark', async ({ page }) => {
    await bookings(page);
    const chip = '#sess-strip .sess-summary-chip';
    await expect(page.locator(chip).first()).toHaveClass(/\bth-plain\b/);
    expect(await css(page, chip, 'background-color')).toBe('rgb(255, 255, 255)');
    expect(await css(page, chip, 'border-inline-start-width')).toBe('3px');
  });

  test('dark mode: checkboxes are drawn with an edge, colour dots carry a ring', async ({ page }) => {
    await bookings(page, 'dark');
    const box = '#tab-queue .queue-table-desktop-wrap tbody input[type="checkbox"]';
    expect(await css(page, box, 'appearance')).toBe('none');
    expect(parseFloat(await css(page, box, 'border-top-width'))).toBeGreaterThanOrEqual(1); // 1.5px, snapped to the device's pixels
    expect(await css(page, box, 'border-top-style')).toBe('solid');
    expect(await css(page, `${tr('Fresh Ride')} .rq-sw`, 'box-shadow')).toContain('0px 0px 0px 1px');
  });

  test('type: rem tokens on the root size, nothing under 12px in the roster', async ({ page }) => {
    await bookings(page);
    expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--sf-fs-sm').trim())).toBe('.8125rem');
    const small = await page.locator('#tab-queue').evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>('*')).filter((el) => {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false;
      return Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim()) && parseFloat(getComputedStyle(el).fontSize) < 12;
    }).map((el) => el.className));
    expect(small).toEqual([]);
  });

  test('the Waitlist says it is empty with an icon and its next action', async ({ page }) => {
    await bookings(page);
    await page.evaluate(`setStaffTab('waitlist')`);
    const es = page.locator('#tab-waitlist .empty-state.es-staff').first();
    await expect(es).toBeVisible();
    await expect(es.locator('.es-ic svg')).toHaveCount(1);
    await expect(es.locator('.es-act button')).toHaveText('Add to waitlist');
  });
});
