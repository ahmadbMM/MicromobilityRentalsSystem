import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb, staffReady } from './helpers/supabase';

// Round two outside the roster (the user's picks of 2026-11-08): the sidebar quieter than the page, the Dashboard's one
// main figure, dialogs that name their action and never grey Submit out in advance, and the staff side of the screen
// check (the phone shell, Sessions, Analytics, the Arabic "#2", the printed reports, the plum in place of the violet).

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh (the clock is frozen)
const TODAY = '2026-09-24', LAST = '2026-09-17', FRI = '2026-09-25';
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const sess = (d: string, o: Record<string, unknown> = {}) => ({ id: d, session_date: d, day: DOW[new Date(d + 'T12:00:00Z').getUTCDay()], status: 'open', capacity: 40,
  created_at: 1, location: 'JCC', bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }), ...o });
const row = (id: string, n: number, name: string, o: Record<string, unknown> = {}) => ({ id, session_id: TODAY, session_day: 'Thursday', session_date: TODAY,
  queue_num: n, name, phone: '05500000' + String(n).padStart(2, '0'), type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75,
  registered_at: '2026-09-20T10:00:00Z', ...o });
const sessions = [
  sess(TODAY), sess(LAST, { status: 'closed' }),
  sess(FRI, { event_kind: 'community', ride_kind: 'event', title: 'Bike maintenance class', paid_ride: true, price: 40, open_to_all: true, spots: 30, capacity: 30,
    bike_slots: JSON.stringify({ _time: '19:00 - 21:00' }) }),
];
const today = [
  row('e1', 1, 'Amal Saad'),
  row('e2', 2, 'Badr Omar', { status: 'active', paid: true, checked_in_at: '2026-09-24T14:00:00Z' }), // out three and a half hours
  row('e3', 3, 'Dana Faisal', { status: 'done', paid: true }),
  row('e4', 4, 'Eid Nasser', { status: 'active', checked_in_at: '2026-09-24T17:00:00Z' }), // on a bike, not paid: owes 75
  row('e5', 5, 'Fay Held', { reserved: true, reserved_bike_no: 7 }),
];
const lastWeek = [row('l1', 1, 'Last Week', { session_id: LAST, session_date: LAST, status: 'done', paid: true, price: 90 })];
const bikes = [
  { id: 'b1', name: 'Road 1', bike_number: 1, type: 'Road', size: 'M', status: 'available', colors: [] },
  { id: 'b2', name: 'Road 2', bike_number: 2, type: 'Road', size: 'M', status: 'in-use', colors: [] },
  { id: 'b3', name: 'Road 3', bike_number: 3, type: 'Road', size: 'M', status: 'retired', colors: [] },
];

async function staff(page: Page, o: { lang?: string; theme?: string; w?: number; h?: number; rows?: unknown[] } = {}) {
  await page.setViewportSize({ width: o.w || 1280, height: o.h || 900 });
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, bikes, queue_entries: o.rows || [...today, ...lastWeek] } as never);
  await unlockStaff(page);
  await page.addInitScript(([l, th]) => {
    if (l) { localStorage.setItem('cq_lang', l); localStorage.setItem('cq_lang_pick', '1'); }
    if (th === 'dark') localStorage.setItem('cq_staff_theme', 'dark');
    if (th === 'booth') localStorage.setItem('cq_booth', '1');
  }, [o.lang || '', o.theme || '']);
  await page.goto('/');
  await waitForSb(page);
  await staffReady(page);
  if (o.lang) await page.waitForFunction((l) => document.documentElement.lang === l, o.lang);
}
const css = (page: Page, sel: string, prop: string) => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p).trim(), prop);
const lum = (rgb: string) => { const [r, g, b] = rgb.match(/[\d.]+/g)!.map(Number).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

test.describe('@staff:shell round two outside the roster', () => {
  test('the Dashboard leads with today’s riders against today’s places, its parts in one bar and a key', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('dashboard')`);
    const tab = page.locator('#tab-dashboard'), hero = tab.locator('.dash-hero');
    const taken = await page.evaluate(`_placesTaken(_sessGet('${TODAY}'))`);
    await expect(hero.locator('.dash-hero-n strong')).toHaveText(String(taken));
    await expect(hero.locator('.dash-hero-n span')).toHaveText('of 40 places');
    // the bar: on bikes, done, waiting, as shares of the places (2, 1 and 2 of 40), drawn through data-cssv
    expect(await hero.locator('.dash-bar i').evaluateAll((is) => is.map((i) => `${i.className}:${(i as HTMLElement).style.getPropertyValue('--w')}`)))
      .toEqual(['db-on:5.00%', 'db-done:2.50%', 'db-wait:5.00%']);
    await expect(hero.locator('.dash-leg > span')).toHaveText([/On bikes now\s*2/, /Rides done today\s*1/, /Waiting\s*2/, new RegExp(`Places free\\s*${40 - Number(taken)}`)]);
    // three figures that support it, each with its line of context
    const k2 = (l: string) => tab.locator('.dash-k2', { hasText: l });
    await expect(k2('Collected today').locator('em')).toHaveText('Same day last week: SAR 90');
    await expect(k2('Available bikes').locator('strong')).toHaveText('1');
    await expect(k2('Available bikes').locator('em')).toHaveText('of 2 in the fleet'); // the retired bike is out of the fleet
    await expect(k2('Open sessions').locator('em')).toHaveText('Next: 21:00');
    // alerts: a mark, the words without the count, the count in a badge; the way on is kept
    const long = tab.locator('.dash-alert', { hasText: 'Rides past 2 hours' });
    await expect(long.locator('svg.art-ic')).toHaveCount(1);
    await expect(long.locator('.dash-n')).toHaveText('1');
    await expect(long.locator('.dash-row-main')).toHaveText('Rides past 2 hours');
    // one row's cards are one height, and an odd last card takes the whole row
    const rows = await tab.locator('.dash-grid > .dash-card').evaluateAll((cs) => {
      const by: Record<string, number[]> = {};
      cs.forEach((c) => { const r = c.getBoundingClientRect(); (by[Math.round(r.top)] ||= []).push(Math.round(r.height)); });
      return Object.values(by);
    });
    for (const hs of rows) expect(new Set(hs).size, JSON.stringify(rows)).toBe(1);
    const last = tab.locator('.dash-grid > .dash-card').last();
    if ((await tab.locator('.dash-grid > .dash-card').count()) % 2) {
      await expect(last).toHaveClass(/\bdash-wide\b/);
      expect(Math.round((await last.boundingBox())!.width)).toBe(Math.round((await tab.locator('.dash-grid').boundingBox())!.width));
    }
    await hero.click();
    expect(await page.evaluate('S.staffTab')).toBe('queue');
  });

  test('without last week on the device, the money figure says what tonight’s riders still owe', async ({ page }) => {
    await staff(page, { rows: today });
    await page.evaluate(`setStaffTab('dashboard')`);
    await expect(page.locator('#tab-dashboard .dash-k2', { hasText: 'Collected today' }).locator('em')).toHaveText('Owing SAR 75');
  });

  test('dialogs name their action, keep the way out named, and pick no reason for you', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('queue');S.sfSession='${TODAY}';renderStaffQueue()`);
    await page.evaluate(`staffCancelEntry('e1')`);
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box.locator('.chrome-dact button')).toHaveText(['Keep booking', 'Cancel booking']);
    await expect(box.locator('[aria-pressed="true"]')).toHaveCount(0); // no reason picked in advance
    expect(await box.evaluate((el) => getComputedStyle(el).width)).toBe('480px'); // the default dialog width (the box itself, not its entry scale)
    await box.getByRole('button', { name: 'Keep booking' }).click();
    await expect(box).toHaveCount(0);
    expect(await page.evaluate(`_qGet('e1').status`)).toBe('waiting');
    // any confirm can name its way out
    void page.evaluate(`askConfirm({title:'Move the ride?',confirmLabel:'Move ride',cancelLabel:'Keep it here'})`);
    await expect(page.locator('#confirm-modal .chrome-dact button')).toHaveText(['Keep it here', 'Move ride']);
    await page.evaluate(`closeConfirm()`);
  });

  test('the void and refund reason: Submit is never greyed out; a missing answer is said when tapped or when the note is left', async ({ page }) => {
    await staff(page);
    void page.evaluate(`_askMoneyReason('refund','Water x2',false)`);
    const m = page.locator('#mny-modal');
    const go = m.locator('#mny-mr-go');
    await expect(go).toBeEnabled();
    await go.click();
    await expect(m.locator('.mny-err')).toHaveText('Choose a reason above.');
    await m.locator('.mny-chip', { hasText: 'Other' }).click();
    await expect(m.locator('.mny-err')).toBeHidden();
    const note = m.locator('#mny-mr-note');
    await note.focus();
    await note.blur(); // left empty: said now, not on a key press
    await expect(m.locator('.mny-err')).toHaveText('Write the reason in the box above.');
    await note.focus();
    await page.keyboard.type('Wrong item');
    await expect(m.locator('.mny-err')).toBeVisible(); // typing alone says nothing new
    await go.click(); // straight from the note: leaving it clears the message in place, so the tap is not lost
    await expect(m.locator('.mny-box')).toHaveCount(0);
  });

  test('the brand’s plum stands where the framework violet was: the reserved state and the events, light and dark', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('queue');S.sfSession='${TODAY}';renderStaffQueue()`);
    const held = '#tab-queue .queue-table-desktop-wrap tbody tr.row-reserved';
    await expect(page.locator(held)).toHaveCount(1);
    expect(await css(page, held, '--rs-edge')).toBe('#8c3b6e');
    expect(await css(page, `${held} .status-badge.st-reserved`, 'background-color')).toBe('rgb(246, 235, 242)');
    expect(await css(page, `${held} .status-badge.st-reserved`, 'color')).toBe('rgb(110, 44, 86)');
    await page.evaluate(`setStaffTab('sessions');S.sessView='list';renderSessions()`);
    const ev = `#tab-sessions .sess-lc.ev-event`;
    await expect(page.locator(ev)).toHaveCount(1);
    expect(await css(page, `${ev} .smk`, 'color')).toBe('rgb(140, 59, 110)'); // the event's mark (2026-11-10: the list is an agenda)
    // no staff rule paints the violet any more; the printed reports' violet ink is the plum too
    const staffViolet = readFileSync('styles.css', 'utf8').split('\n').filter((l) => /view-staff/.test(l) && /#7c3aed|124,\s*58,\s*237|#a78bfa|#c4b5fd|#5b21b6|#ede9fe|#6d28d9/i.test(l));
    expect(staffViolet).toEqual([]);
    expect(readFileSync('report.css', 'utf8')).toMatch(/\.rp-violet\{color:#8c3b6e\}/);
  });

  test('dark: the plum lifted to read on the dark cards', async ({ page }) => {
    await staff(page, { theme: 'dark' });
    await page.evaluate(`setStaffTab('queue');S.sfSession='${TODAY}';renderStaffQueue()`);
    const held = '#tab-queue .queue-table-desktop-wrap tbody tr.row-reserved';
    expect(await css(page, held, '--rs-edge')).toBe('#d98bbb');
    expect(await css(page, `${held} .status-badge.st-reserved`, 'color')).toBe('rgb(232, 166, 207)');
  });

  for (const theme of ['light', 'dark', 'booth']) {
    test(`the sidebar is quieter than the page (${theme}): the current section the one card on it, the other icons at 62%`, async ({ page }) => {
      await staff(page, { theme });
      await page.evaluate(`setStaffTab('dashboard')`);
      const nav = await css(page, '#staff-tab-nav', 'background-color'), pageBg = await css(page, 'body', 'background-color');
      if (theme === 'dark') expect(lum(nav)).toBeLessThan(lum(pageBg)); // a step darker than the content
      else expect(nav).toBe(theme === 'booth' ? 'rgb(242, 242, 242)' : 'rgb(237, 237, 232)');
      const active = '#staff-tab-nav .tab-btn.active';
      // the item eases into its colours (140ms): read them once it has
      if (theme !== 'dark') await expect.poll(() => css(page, active, 'background-color')).toBe('rgb(255, 255, 255)');
      await expect.poll(() => css(page, active, 'box-shadow')).toContain(theme === 'booth' ? '0px 0px 0px 2px' : '0px 0px 0px 1px');
      expect(await css(page, `${active} .snav-ico`, 'opacity')).toBe('1');
      expect(await css(page, '#staff-tab-nav .tab-btn:not(.active) .snav-ico', 'opacity')).toBe('0.62');
      expect(await css(page, '#staff-tab-nav .snav-group', 'text-transform')).toBe('none');
    });
  }

  test('phone: the sections button sits in the top bar, the bottom bar follows the light theme, More is the one lit tab while the menu is open', async ({ page }) => {
    await staff(page, { w: 390, h: 844 });
    await page.evaluate(`setStaffTab('queue')`);
    const bar = (await page.locator('#topbar').boundingBox())!, burger = (await page.locator('#snav-burger').boundingBox())!;
    expect(burger.y).toBeGreaterThanOrEqual(bar.y - 1);
    expect(burger.y + burger.height).toBeLessThanOrEqual(bar.y + bar.height + 1);
    expect(await css(page, '#staff-tabbar', 'background-color')).toBe('rgb(255, 255, 255)');
    await page.locator('#snav-burger').click();
    await expect(page.locator('#staff-tab-nav')).toBeVisible();
    const navTop = (await page.locator('#staff-tab-nav').boundingBox())!.y;
    expect(Math.abs(navTop - (bar.y + bar.height))).toBeLessThanOrEqual(1); // under the bar, no empty band above it
    await expect(page.locator('#staff-tabbar .tb-btn.active')).toHaveCount(1);
    await expect(page.locator('#staff-tabbar .tb-btn.active')).toHaveClass(/\btb-more\b/);
    await expect(page.locator('#staff-tabbar .tb-btn[data-tb="queue"]')).toHaveAttribute('aria-current', 'page');
  });

  test('Sessions and Analytics: the layout switch in the staff face, chips in sentence case on a pill, labels untracked, each date under its label', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('sessions');S.sessView='list';renderSessions()`);
    expect(await css(page, '#tab-sessions .view-toggle-btn', 'font-family')).toContain('IBM Plex Sans');
    // the agenda's day headings (2026-11-10, in place of the cards' event chips): sentence case, untracked
    expect(await css(page, '#tab-sessions .ss-day-h', 'text-transform')).toBe('none');
    expect(await css(page, '#tab-sessions .ss-day-h', 'letter-spacing')).toBe('normal');
    await page.evaluate(`setStaffTab('analytics');setAnRange('daterange')`);
    const t = page.locator('#tab-analytics');
    await expect(t.locator('.an-range-label').first()).toBeVisible();
    expect(await css(page, '#tab-analytics .an-range-label', 'letter-spacing')).toBe('normal');
    const flds = t.locator('.an-range-bar label.an-fld');
    await expect(flds).toHaveCount(4);
    await expect(flds.locator('> span:not(.spk)')).toHaveText(['From', 'To', 'Session', 'Product']); // .spk: the session picker
    const tops = await t.locator('.an-range-bar .an-date').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops[0]).toBe(tops[1]); // From and To on one line
  });

  test('Arabic: the booking number in a check-in title reads #1, isolated from the words around it', async ({ page }) => {
    await staff(page, { lang: 'ar' });
    await page.evaluate(`setStaffTab('queue');S.sfSession='${TODAY}';renderStaffQueue();showCheckinModal('e1')`);
    await expect(page.locator('#dlgt-checkin bdi[dir="ltr"]')).toHaveText('#1');
  });

  test('the printed report and the receipt: Plex, sentence case, soft heads, rounded screen controls; paper stays light', async ({ page }) => {
    await page.goto('/404.css');
    await page.setContent('<!doctype html><html><head><link rel="stylesheet" href="/report.css"></head><body><div class="mm-banner">B</div><div class="totals"><div class="total-item"><span class="total-num">1</span><span class="total-lbl">Total riders</span></div></div><h2>Sales</h2><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table><button class="rep-print">Print</button></body></html>', { waitUntil: 'load' });
    await page.waitForFunction(() => [...document.styleSheets].some((s) => { try { return s.cssRules.length > 0; } catch { return false; } }));
    expect(await css(page, 'body', 'font-family')).toContain('IBM Plex Sans');
    for (const sel of ['th', 'h2', '.total-lbl']) {
      expect(await css(page, sel, 'text-transform'), sel).toBe('none');
      expect(await css(page, sel, 'letter-spacing'), sel).toBe('normal');
    }
    expect(await css(page, 'th', 'background-color')).toBe('rgb(244, 244, 240)');
    expect(await css(page, 'h2', 'border-left-width')).toBe('0px');
    expect(await css(page, '.mm-banner', 'background-color')).toBe('rgb(22, 25, 29)');
    expect(await css(page, '.rep-print', 'border-top-left-radius')).toBe('8px');
    await page.emulateMedia({ media: 'print' });
    expect(await css(page, '.mm-banner', 'background-color')).toBe('rgb(255, 255, 255)'); // the light print style stays
    await page.emulateMedia({ media: 'screen' });
    await page.setContent('<!doctype html><html><head><link rel="stylesheet" href="/receipt.css"></head><body><div class="mm-banner"><span class="doc">Simplified tax invoice</span></div><div class="tot"><span>Total</span><span>SAR 18</span></div></body></html>', { waitUntil: 'load' });
    await expect.poll(() => css(page, 'body', 'font-family')).toContain('IBM Plex Sans');
    expect(await css(page, '.mm-banner .doc', 'text-transform')).toBe('none');
    expect(await css(page, '.tot', 'background-color')).toBe('rgb(22, 25, 29)');
  });
});
