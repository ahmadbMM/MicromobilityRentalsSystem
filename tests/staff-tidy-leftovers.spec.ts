import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, staffReady } from './helpers/supabase';

// The staff panel tidy's five leftovers (2026-10-27, "fix them"): a figure alone on a row at some widths, the
// roster's Manage booking column off a tablet's screen, pinned cells that did not take their row's colour, an old
// right-to-left rule that flipped every row's buttons back to the English order, and two pickers both called
// Session on the Petromin page on a phone.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24', PM = '2026-09-27', PM2 = '2026-09-20';
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOf = (d: string) => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
const sess = (d: string, o: Record<string, unknown> = {}) => ({ id: d, day: dayOf(d), session_date: d, capacity: 40, status: 'open', location: 'JCC', bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }), created_at: 1, ...o });
const PMO = { event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: true, title: 'Petromin Night', spots: 20 };
const sessions = [sess(TODAY), sess(PM, PMO), sess(PM2, { ...PMO, status: 'closed' })];
const q = (n: number, o: Record<string, unknown>) => ({
  id: 'q' + n, session_id: TODAY, session_day: dayOf(TODAY), session_date: TODAY, queue_num: n, name: 'Rider ' + n, status: 'waiting', paid: false,
  price: 80, type_preference: 'Hybrid', size: 'M', height: 172, phone: '05500000' + String(n).padStart(2, '0'), registered_at: '2026-09-15T10:00:00Z', ...o,
});
const queue_entries = [
  q(1, { status: 'active', paid: true, assigned_bike_id: 'b1', checked_in_at: '2026-09-24T16:30:00Z' }),
  q(2, { status: 'done', paid: true, ride_duration: 60 }),
  q(3, { status: 'noshow' }),
  q(4, { status: 'done', paid: false, ride_duration: 45 }),
  ...Array.from({ length: 12 }, (_, i) => q(i + 5, {})),
];
const bikes = [
  { id: 'b1', name: 'Road 1', type: 'Road', size: 'M', status: 'in-use', brand: 'Alvas', model: 'Climax', bike_number: 1 },
  { id: 'b2', name: 'Hybrid 1', type: 'Hybrid', size: 'L', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 2 },
  { id: 'b3', name: 'Road 2', type: 'Road', size: 'S', status: 'available', brand: 'Alvas', model: 'DA54', bike_number: 3 },
  { id: 'b4', name: 'Hybrid 2', type: 'Hybrid', size: 'M', status: 'in-use', brand: 'Giant', model: 'Contend', bike_number: 4 },
];
const reg = (id: number, sid: string, no: string) => ({
  id, session_id: sid, booking_no: no, badge: 'B' + id, name: 'Form Rider ' + id, phone: '+96650000000' + id, type_preference: 'Hybrid', source: 'petromin', company: 'Petromin',
  created_at: '2026-09-19T09:00:00Z', updated_at: '2026-09-19T09:00:00Z', height: 175, party_no: 1, submissions: 1, match_kind: 'none', matched_entry_id: null,
  matched_customer_id: null, checked_in_at: null, checked_out_at: null, price: 50,
});
const rider_registrations = [reg(1, PM, 'P-001'), reg(2, PM, 'P-002'), reg(3, PM2, 'P-001')];
const promo_codes = [
  { id: 'pc1', code: 'SUMMER10', kind: 'pct', value: 10, active: true, created_at: '2026-09-01T10:00:00Z' },
  { id: 'pc2', code: 'FLAT20', kind: 'flat', value: 20, active: true, created_at: '2026-09-01T10:00:00Z' },
];

async function staffAt(page: Page, width: number, height: number, o: { lang?: string; dark?: boolean } = {}) {
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, queue_entries, bikes, rider_registrations, promo_codes });
  await unlockStaff(page);
  await page.addInitScript(([lang, dark]) => {
    localStorage.setItem('cq_lang', lang as string); localStorage.setItem('cq_lang_pick', '1');
    if (dark === '1') localStorage.setItem('cq_staff_theme', 'dark');
  }, [o.lang || 'en', o.dark ? '1' : '0']);
  await page.goto('/');
  await waitForSb(page);
  await staffReady(page);
}

/** Each figure grid's rows, as counts: [3, 2, 2] is three figures, then two, then two. */
const figureRows = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.dash-kpis,.stats-row')]
  .filter((g) => (g as HTMLElement).offsetParent)
  .map((g) => {
    const rows: number[] = []; let top = -1;
    for (const k of [...g.children]) {
      const y = Math.round(k.getBoundingClientRect().top);
      if (Math.abs(y - top) > 2) { rows.push(0); top = y; }
      rows[rows.length - 1]++;
    }
    const gr = g.getBoundingClientRect();
    const inside = [...g.children].every((k) => { const r = k.getBoundingClientRect(); return r.left >= gr.left - 1 && r.right <= gr.right + 1; });
    return { rows, inside };
  }));

for (const [tab, width] of [['community', 820], ['community', 1180], ['dashboard', 1024], ['dashboard', 390], ['inventory', 390]] as const) {
  test(`@staff the ${tab} figures leave none alone on a row at ${width}px`, async ({ page }) => {
    await staffAt(page, width, 900);
    await page.evaluate(`setStaffTab(${JSON.stringify(tab)})${tab === 'community' ? ";setCommTab('summary')" : ''}`); // People's figures are its Summary (staff round s10)
    await expect(page.locator(`#tab-${tab} :is(.dash-kpis,.stats-row)`).first()).toBeVisible();
    await expect(page.locator(`#tab-${tab} :is(.dash-kpis,.stats-row).fig-fit`).first()).toBeVisible();
    const grids = await figureRows(page);
    expect(grids.length).toBeGreaterThan(0);
    for (const g of grids) {
      if (g.rows.length > 1) expect(g.rows, JSON.stringify(g.rows)).not.toContain(1);
      expect(g.inside).toBe(true);
    }
  });
}

test('@staff the figures lay out again when the room changes', async ({ page }) => {
  await staffAt(page, 1280, 900);
  await page.evaluate(`setStaffTab('customers');setCommTab('summary')`); // People's figures are its Summary (staff round s10)
  await expect(page.locator('#tab-community .dash-kpis.fig-fit').first()).toBeVisible(); // the overview's figures; the stage tiles below them are a second row (2026-11-06, PP08)
  const wide = (await figureRows(page))[0].rows.length; // People's fifteen figures: two rows on a laptop
  expect((await figureRows(page))[0].rows).not.toContain(1);
  await page.setViewportSize({ width: 820, height: 900 });
  await expect.poll(async () => (await figureRows(page))[0].rows.length).toBeGreaterThan(wide);
  expect((await figureRows(page))[0].rows).not.toContain(1);
});

for (const lang of ['en', 'ar']) {
  for (const width of [820, 1100]) {
    test(`@staff:bookings at ${width}px (${lang}) Manage booking stays pinned at the roster's end, so every Check In is on screen`, async ({ page }) => {
      await staffAt(page, width, 900, { lang });
      // the text one size up (Settings > This device), so this small night's roster is as wide as a busy one's
      await page.evaluate(`localStorage.setItem('cq_text_size','115');_uiApply();setStaffTab('queue');S.queueView='bookings';S.sfSession='${TODAY}';renderStaffQueue()`);
      const wrap = page.locator('#tab-queue .queue-table-desktop-wrap');
      await expect(wrap).toBeVisible();
      expect(await wrap.evaluate((w) => w.scrollWidth - w.clientWidth)).toBeGreaterThan(40); // it really scrolls in its box
      const seen = () => page.evaluate(() => {
        const w = document.querySelector('#tab-queue .queue-table-desktop-wrap') as HTMLElement, wr = w.getBoundingClientRect();
        return [...w.querySelectorAll('tbody td.rq-mng .btn-green')].slice(0, 8).map((b) => {
          const r = b.getBoundingClientRect();
          return { x: r.left, inside: r.left >= wr.left - 1 && r.right <= wr.right + 1 };
        });
      });
      const before = await seen();
      expect(before.length).toBeGreaterThan(5);
      for (const b of before) expect(b.inside).toBe(true);
      // scrolled to the far end, the buttons stay where they were, to within a pixel: under the larger text the scroll
      // offset is fractional (82.6px at 820), so the pinned edge can land a fraction of a pixel away (0.3px)
      await wrap.evaluate((w) => { const d = w.scrollWidth - w.clientWidth; w.scrollLeft = getComputedStyle(w).direction === 'rtl' ? -d : d; });
      await page.waitForTimeout(50);
      const after = await seen();
      expect(after.length).toBe(before.length);
      after.forEach((b, i) => expect(Math.abs(b.x - before[i].x), `row ${i}: ${before[i].x} -> ${b.x}`).toBeLessThan(1));
    });
  }

  // From 1280px the roster's box does not scroll (its header sticks to the page), so a table wider than the box hangs out
  // of it: 30px in light and dark, 54px in booth, where Return Bike went off the screen and the page scrolled sideways
  // (2026-11-08, after the Soft Solid look's wider IBM Plex Sans). Booth is the widest: bigger status words, 2px rings.
  // The night holds what sets the columns' widths: a party still paying (Mark paid), a bike to reserve, the waitlist,
  // an owner's bike and a ride on the house.
  test(`@staff:bookings at 1280px in booth (${lang}) the roster stays inside its box and the page does not scroll sideways`, async ({ page }) => {
    const G = { group_id: 'g1', group_name: 'Tamer Group of Friends', group_contact: 'Tamer Aziz', group_phone: '0551112222' };
    const night = [
      q(1, { status: 'active', paid: true, assigned_bike_id: 'b1', checked_in_at: '2026-09-24T16:30:00Z' }),
      q(2, { walk_in: true, to_reserve: true, type_preference: 'Road' }),
      q(3, { status: 'waitlist', waitlist_num: 1 }),
      q(4, { ...G, status: 'active', paid: true, assigned_bike_id: 'b4', type_preference: 'Mountain', checked_in_at: '2026-09-24T17:00:00Z' }),
      q(5, { ...G, paid: true, type_preference: 'Road' }),
      q(6, { ...G, type_preference: 'Kids', size: 'XS', height: 120, price: 40 }),
      q(7, { type_preference: 'Own', price: 0 }),
      q(8, { paid: true, price: 0 }),
      q(9, {}),
    ];
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, { sessions, queue_entries: night, bikes });
    await unlockStaff(page);
    await page.addInitScript((l) => {
      localStorage.setItem('cq_lang', l); localStorage.setItem('cq_lang_pick', '1'); localStorage.setItem('cq_staff_theme', 'booth');
    }, lang);
    await page.goto('/');
    await waitForSb(page);
    await staffReady(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${TODAY}';renderStaffQueue()`);
    const wrap = page.locator('#tab-queue .queue-table-desktop-wrap');
    // the party still paying: its row's one action is Check in (2) since round two (2026-11-08), Mark paid in its ⋯ menu
    await expect(wrap.locator('tr.party-row td.rq-mng .rq-act')).toHaveText(/\(2\)$/);
    expect(await page.evaluate(`Object.entries(S._rowMenus).some(([k,v])=>k.startsWith('party:')&&v.some(i=>/^groupMarkPaid/.test(i.run)))`)).toBe(true);
    await expect(wrap.locator('.status-badge.st-toreserve')).toHaveCount(1);
    const fit = await wrap.evaluate((w) => {
      const wr = w.getBoundingClientRect(), tr = (w.querySelector('table') as HTMLElement).getBoundingClientRect();
      const acts = [...w.querySelectorAll('td.rq-mng :is(button,label)')].map((b) => b.getBoundingClientRect());
      return { scrolls: getComputedStyle(w).overflowX, start: tr.left - wr.left, end: wr.right - tr.right, page: document.documentElement.scrollWidth - innerWidth,
        actsOut: acts.filter((r) => r.left < wr.left - 1 || r.right > wr.right + 1).length, acts: acts.length };
    });
    expect(fit.scrolls).toBe('visible'); // the header still sticks to the page here
    expect(fit.acts).toBeGreaterThan(5);
    expect(fit, JSON.stringify(fit)).toMatchObject({ actsOut: 0 });
    expect(fit.start).toBeGreaterThanOrEqual(-1);
    expect(fit.end).toBeGreaterThanOrEqual(-1);
    expect(fit.page).toBeLessThanOrEqual(0);
  });
}

test('@staff a pinned cell takes its row\'s colour: the fleet\'s state and the stripe reach Manage bike and Manage Record', async ({ page }) => {
  await staffAt(page, 1024, 900);
  await page.evaluate(`setStaffTab('inventory')`);
  await expect(page.locator('#tab-bikes .bk-table tbody tr').first()).toBeVisible();
  const fleet = await page.evaluate(() => [...document.querySelectorAll('#tab-bikes .bk-table tbody tr')].map((tr) => {
    const tds = [...tr.children] as HTMLElement[], cs = (el: HTMLElement) => getComputedStyle(el);
    // the stripe counts rows within each table (one per bike type)
    return { inUse: tr.classList.contains('flt-bg-blue'), odd: [...tr.parentElement!.children].indexOf(tr) % 2 === 0, last: cs(tds[tds.length - 1]).backgroundColor, lastImg: cs(tds[tds.length - 1]).backgroundImage,
      firstImg: cs(tds[0]).backgroundImage, mid: cs(tds[2]).backgroundColor, lastPos: cs(tds[tds.length - 1]).position };
  }));
  expect(fleet.some((r) => r.inUse)).toBe(true);
  for (const r of fleet) {
    expect(r.lastPos).toBe('sticky');
    if (r.inUse) { expect(r.lastImg).toContain('linear-gradient'); expect(r.firstImg).toContain('linear-gradient'); }
    // Soft Solid (2026-11-06): rows are divided by lines, not zebra stripes; the pinned cell stays a solid card
    if (!r.inUse) expect(r.last).toBe('rgb(255, 255, 255)');
  }
  await page.evaluate(`setStaffTab('history')`);
  await expect(page.locator('#tab-history tbody td.hist-act').first()).toBeVisible();
  const hist = await page.evaluate(() => [...document.querySelectorAll('#tab-history .queue-table tbody tr')].slice(0, 4).map((tr) => {
    const act = tr.querySelector('td.hist-act') as HTMLElement, mid = tr.children[2] as HTMLElement;
    return [getComputedStyle(act).backgroundColor, getComputedStyle(mid).backgroundColor];
  }));
  expect(hist.length).toBeGreaterThan(1);
  expect(hist[0][0]).toBe('rgb(255, 255, 255)'); // Manage Record pinned on a solid card (no zebra since Soft Solid)
});

test('@staff on the dark desk a pinned booking number is solid on a striped row, so nothing shows through it', async ({ page }) => {
  await staffAt(page, 1024, 900, { dark: true });
  await page.evaluate(`setStaffTab('history')`);
  await expect(page.locator('#tab-history tbody tr').first()).toBeVisible();
  const fills = await page.evaluate(() => [...document.querySelectorAll('#tab-history .queue-table tbody tr')].slice(0, 4)
    .map((tr) => getComputedStyle(tr.children[0]).backgroundColor));
  for (const f of fills) expect(f).not.toMatch(/rgba\(\d+, \d+, \d+, 0(\.\d+)?\)|transparent|\/ 0(\.\d+)?\)/);
});

test('@staff in Arabic a row\'s buttons read right to left, the first under the column\'s heading', async ({ page }) => {
  await staffAt(page, 1280, 900, { lang: 'ar' });
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue()`);
  const cell = page.locator('.pc-wrap .actions-cell').first(); // the promo codes: Edit, Delete
  await expect(cell).toBeVisible();
  const xs = await cell.evaluate((c) => [...c.children].map((k) => k.getBoundingClientRect().left));
  expect(xs.length).toBe(2);
  expect(xs[0]).toBeGreaterThan(xs[1]); // Edit to the right of Delete, as English has it to the left
  expect(await cell.evaluate((c) => getComputedStyle(c).flexDirection)).toBe('row');
});

test('@staff:bookings on a phone the Petromin page has one Session picker, and it reaches every night', async ({ page }) => {
  await staffAt(page, 390, 844);
  await page.evaluate(`setStaffTab('queue');openPetrominPage('${PM}')`);
  await expect(page.locator('#pm-host tbody tr')).toHaveCount(2);
  const pickers = page.locator('#tab-queue select[aria-label="Session"]').filter({ visible: true });
  await expect(pickers).toHaveCount(1);
  const pick = pickers.first();
  await expect(pick).toHaveValue('pm:' + PM);
  await expect(pick.locator('option[value="pm:all"]')).toHaveCount(1);
  await expect(pick.locator(`option[value="pm:${PM2}"]`)).toHaveCount(1); // a closed night with registrations
  await pick.selectOption('pm:all');
  await expect(page.locator('#pm-host tbody tr')).toHaveCount(3);
  expect(await page.evaluate('[S.queueView,S.ridersSession]')).toEqual(['petromin', 'all']);
  await pick.selectOption('pm:' + PM2);
  await expect(page.locator('#pm-host tbody tr')).toHaveCount(1);
  // the page's buttons are equal cells, as the Bookings header's are
  expect(await page.locator('#pm-host .iv-pm-btns').evaluate((e) => getComputedStyle(e).display)).toBe('grid');
});

test('@staff:bookings on a desk the Petromin page keeps its own night picker beside the search', async ({ page }) => {
  await staffAt(page, 1280, 900);
  await page.evaluate(`setStaffTab('queue');openPetrominPage('${PM}')`);
  await expect(page.locator('#pm-host .filter-bar .filter-sess select')).toBeVisible();
  await expect(page.locator('#tab-queue .sess-bar-mobile select')).toBeHidden();
});
