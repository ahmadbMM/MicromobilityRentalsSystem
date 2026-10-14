import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, staffReady } from './helpers/supabase';

// Stylesheet slips found by the 2026-10-14 review:
// - in every sortable report table (_rpLive) the zebra stripe outranked the waitlist shading (Report for Sela), the
//   group heading rows (ratings) and the total row (billing): every other one of them printed plain;
// - the nationality report's people lists kept their rule and indent on the left in Arabic;
// - the report's and the receipt's Print button and the report's filter boxes still had round corners;
// - data-theme="dark" sits on every page, so rules keyed on it as "the dark theme" painted the Instagram triangle in
//   its dark-theme ink on the staff paper too, and left the roster's ⋯ tile without its card fill;
// - on a 360px phone the Analytics title's third button ran off the screen;
// - in Arabic the ticket's date column kept its words right-aligned inside its end (left) column.

const S = (id: string, x: Record<string, unknown> = {}) => ({ id, session_date: id.slice(0, 10), day: 'Saturday', status: 'open', capacity: 80, spots: 80, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}', event_kind: null, ride_kind: null, ...x });
const B = (id: string, sid: string, x: Record<string, unknown> = {}) => ({ id, name: 'Sara Haddad', customer_id: 'c1', session_id: sid, session_day: 'Saturday', session_date: sid.slice(0, 10), queue_num: 7, status: 'waiting', paid: false, price: 75, registered_at: '2026-08-01T10:00:00Z', type_preference: 'Road', height: 170, ...x });

async function reportPage(page: Page, dir: 'ltr' | 'rtl', body: string) {
  await page.goto('/404.css'); // any same-origin address, so the stylesheet loads by path
  await page.setContent(`<!doctype html><html dir="${dir}"><head><link rel="stylesheet" href="/report.css"></head><body>${body}</body></html>`);
  await page.waitForFunction(() => [...document.styleSheets].some((s) => { try { return s.cssRules.length > 0; } catch { return false; } }));
}

test.describe('@bh14 stylesheet', () => {
  test('a sortable report keeps the waitlist, group and total rows shaded on striped rows', async ({ page }) => {
    const row = (cls: string, cells: string) => `<tr class="${cls}">${cells}</tr>`;
    await reportPage(page, 'ltr', `<table class="rp-live"><thead><tr><th>a</th><th>b</th></tr></thead><tbody>
      ${row('rp-grp rp-odd', '<td colspan="2">Group</td>')}
      ${row('rp-wl rp-odd', '<td>1</td><td>x</td>')}
      ${row('rp-odd', '<td class="rp-tot">t</td><td class="rp-tot">9</td>')}
      ${row('rp-odd', '<td>plain</td><td>y</td>')}</tbody></table>`);
    const bg = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await bg('tr.rp-wl td')).toBe('rgb(254, 243, 199)');
    expect(await bg('tr.rp-grp td')).toBe('rgb(238, 243, 239)');
    expect(await bg('td.rp-tot')).toBe('rgb(242, 246, 242)');
    expect(await bg('tbody tr:last-child td')).toBe('rgb(250, 252, 250)'); // the stripe itself is untouched
  });

  test('Arabic report: a nationality’s people list is ruled on the start (right) edge', async ({ page }) => {
    await reportPage(page, 'rtl', '<ul class="rp-natppl"><li>Sara</li></ul>');
    const cs = await page.locator('.rp-natppl').evaluate((el) => { const c = getComputedStyle(el); return { r: c.borderRightWidth, l: c.borderLeftWidth, pr: c.paddingRight, pl: c.paddingLeft }; });
    expect(cs).toEqual({ r: '2px', l: '0px', pr: '10px', pl: '0px' });
  });

  test('the report’s and the receipt’s buttons and boxes are square-cornered', async ({ page }) => {
    await reportPage(page, 'ltr', '<button class="rep-print">Print</button><input class="rp-q"><select class="rp-in"></select>');
    for (const sel of ['.rep-print', '.rp-q', '.rp-in']) expect(await page.locator(sel).evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('0px');
    await page.setContent('<!doctype html><html><head><link rel="stylesheet" href="/receipt.css"></head><body><button class="rp-rbtn">Print</button></body></html>');
    await expect.poll(() => page.locator('.rp-rbtn').evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('0px');
  });

  test('staff paper: the Instagram triangle keeps its paper ink and the roster’s ⋯ tile its card fill', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await unlockStaff(page);
    await stubSupabase(page, { sessions: [S('2099-10-21')], queue_entries: [B('j1', '2099-10-21')] });
    await page.goto('/');
    await waitForSb(page);
    await staffReady(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='2099-10-21';renderStaffQueue()`);
    const more = page.locator('#tab-queue .queue-table .actions-cell > .rq-more').first();
    await expect(more).toBeVisible();
    expect(await more.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    const arw = await page.evaluate(() => {
      const s = document.createElement('span'); s.className = 'ig-chip ig-tone'; s.style.setProperty('--igh', '50'); s.style.setProperty('--iga', '.2');
      const a = document.createElement('span'); a.className = 'ig-arw'; a.textContent = 'x'; s.appendChild(a); document.body.appendChild(s);
      return getComputedStyle(a).color;
    });
    expect(arw).toBe('rgb(138, 117, 15)'); // hsl(50 80% 30%), the paper ink - not the dark theme's 62% lightness
  });

  test('360px phone: every Analytics title button stays on the screen', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await unlockStaff(page);
    await stubSupabase(page, { sessions: [S('2099-10-21')], queue_entries: [B('j1', '2099-10-21')] });
    await page.goto('/');
    await waitForSb(page);
    await staffReady(page);
    await page.evaluate(`setStaffTab('analytics')`);
    const btns = page.locator('#tab-analytics .an-title-btns > button');
    await expect(btns.first()).toBeVisible();
    const out = await btns.evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).length);
    expect(out).toBe(0);
  });

  test('Arabic ticket: the date column’s words sit on its end edge', async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('cq_lang', 'ar'); localStorage.setItem('cq_lang_pick', '1'); });
    await page.setViewportSize({ width: 400, height: 1000 });
    const bookings = [B('j1', '2099-10-21')];
    await stubSupabase(page, { sessions: [S('2099-10-21')], queue_entries: bookings, 'rpc:my_bookings': bookings });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', birth_date: '1995-05-05', nationality: 'SA', country: 'SA' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`goCustomer('myrides')`);
    const when = page.locator('#tab-myrides .cu-tk-when').first();
    await expect(when).toBeVisible();
    expect(await when.evaluate((el) => getComputedStyle(el).textAlign)).toBe('end');
  });
});
