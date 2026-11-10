import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The new Growth analytics view: funnel, demand heatmap, retail attach, run-rate forecast, RFM.
// The maths live in pure helpers so they're unit-testable without the full render.

test.describe('analytics growth', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  });

  test('pure helpers compute funnel / attach / forecast / RFM / wa digits', async ({ page }) => {
    const out = await page.evaluate(() => {
      const entries = [
        { status: 'done', checkedInAt: '2099-01-09T10:00:00Z', paid: true, price: 30 },
        { status: 'done', checkedInAt: '2099-01-09T11:00:00Z', paid: false, price: 30 },
        { status: 'active', checkedInAt: '2099-01-09T12:00:00Z' },
        { status: 'waiting' },
        { status: 'noshow' },
      ];
      return {
        // @ts-expect-error app globals
        funnel: _anFunnelCounts(entries),
        // @ts-expect-error app globals
        heatHours: _anHeatGrid(entries).hours,
        // @ts-expect-error app globals
        attach: _anAttachStats(entries.filter((e) => e.status === 'done')),
        // @ts-expect-error app globals
        rfmChamp: _anRFMSegment(5, 4),
        // @ts-expect-error app globals
        rfmAtRisk: _anRFMSegment(45, 3),
        // @ts-expect-error app globals
        rfmLost: _anRFMSegment(120, 2),
        // @ts-expect-error app globals
        rfmNew: _anRFMSegment(3, 1),
        // @ts-expect-error app globals
        wa: _waDigits('+966 56 123 4567'),
      };
    });
    expect(out.funnel).toEqual({ booked: 5, checkedIn: 3, completed: 2 }); // active counts as checked-in
    expect(out.heatHours.length).toBeGreaterThan(0);
    expect(out.attach.attachPct).toBe(0); // stub returns no add-ons
    expect(out.rfmChamp).toBe('champions');
    expect(out.rfmAtRisk).toBe('atrisk');
    expect(out.rfmLost).toBe('lost');
    expect(out.rfmNew).toBe('newbie');
    expect(out.wa).toBe('966561234567');
  });

  test('market-basket counts product pairs sharing a receipt', async ({ page }) => {
    const pairs = await page.evaluate(() => {
      const receipts = [
        ['Gel', 'Electrolyte', 'Water'],
        ['Gel', 'Electrolyte'],
        ['Gel', 'Bar'],
        ['Water'], // single-item: no pairs
      ];
      // @ts-expect-error app globals
      return _anBasketPairs(receipts);
    });
    const top = pairs.find((p: { pair: string }) => p.pair === 'Electrolyte + Gel');
    expect(top).toBeTruthy();
    expect(top.count).toBe(2); // Gel+Electrolyte appears on 2 receipts
    expect(pairs.every((p: { count: number }) => p.count >= 1)).toBe(true);
  });

  test('retention curve and LTV-by-cohort compute from ride journeys', async ({ page }) => {
    const out = await page.evaluate(() => {
      const day = 86400000; const now = Date.now();
      const ride = (cid: string, daysAgo: number, paid = true, price = 30) => ({
        status: 'done', customerId: cid, paid, price,
        checkedInAt: new Date(now - daysAgo * day).toISOString(),
      });
      const entries = [
        ride('c1', 100), ride('c1', 96), // first ride 100d ago, returned within 7d → counts for 7/30/90
        ride('c2', 100),                 // one ride only, never returned
        ride('c3', 3),                   // too recent to be eligible for any window
      ];
      // @ts-expect-error app globals
      return { ret: _anRetentionCurve(entries, now), ltv: _anLTVByCohort(entries) };
    });
    // c1 & c2 eligible for all windows (first ride 100d ago); only c1 returned
    expect(out.ret['7'].eligible).toBe(2);
    expect(out.ret['7'].returned).toBe(1);
    expect(out.ret['7'].pct).toBe(50);
    expect(out.ret['90'].eligible).toBe(2);
    // LTV cohorts exist and carry average spend
    expect(Array.isArray(out.ltv)).toBe(true);
    expect(out.ltv.reduce((s: number, r: { customers: number }) => s + r.customers, 0)).toBe(3);
  });

  test('a group booking counts as one visit per customer, not one per rider', async ({ page }) => {
    const out = await page.evaluate(() => {
      const day = 86400000, now = Date.now();
      const e = (sid: string, daysAgo: number, extra = 0) => ({
        status: 'done', customerId: 'sara', paid: true, price: 30,
        sessionId: sid, checkedInAt: new Date(now - daysAgo * day + extra).toISOString(),
      });
      // Sara books 5 riders for ONE session, then rides one more session herself later.
      const entries = [e('s1', 40, 0), e('s1', 40, 60000), e('s1', 40, 120000), e('s1', 40, 180000), e('s1', 40, 240000), e('s2', 10)];
      // @ts-expect-error app globals
      const j = _anCustJourneys(entries);
      // @ts-expect-error app globals
      const ret = _anRetentionCurve(entries, now);
      return { visits: j.sara.times.length, spend: j.sara.spend, ret30: ret['30'] };
    });
    expect(out.visits).toBe(2); // s1 (the whole group) + s2 = 2 visits, NOT 6
    expect(out.spend).toBe(180); // all 6 rider-fees still count toward what she paid
    // She rode s1 (40d ago) then s2 (10d ago) → returned within 30 days of her first visit
    expect(out.ret30.eligible).toBe(1);
    expect(out.ret30.returned).toBe(1);
  });

  test('the month forecast projects from pace so far', async ({ page }) => {
    const out = await page.evaluate(() => {
      const now = new Date();
      // The forecast reads the KSA calendar month, so the fixture does too (a device clock in
      // another zone can sit in a different month for a few hours around midnight).
      const iso = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }).slice(0, 7) + '-15';
      const sess = [{ id: 's1', session_date: iso }];
      const q = [
        { sessionId: 's1', status: 'done', paid: true, price: 30 },
        { sessionId: 's1', status: 'done', paid: true, price: 30 },
      ];
      // @ts-expect-error app globals
      return _anMonthForecast(sess, q, now);
    });
    expect(out.rides).toBe(2);
    expect(out.rev).toBe(60);
    expect(out.projRides).toBeGreaterThanOrEqual(out.rides); // projection never below actual
    expect(out.days).toBeGreaterThanOrEqual(28);
  });

  test('rendering stashes per-session CSV rows and the export builds valid CSV', async ({ page }) => {
    const csv = await page.evaluate(() => {
      // @ts-expect-error app globals
      S.view = 'staff'; S.staffTab = 'analytics'; renderAnalytics();
      const rows = S._anCsvRows;
      // build the CSV text the same way _anExportCSV does, without triggering a download
      const head = rows.length ? Object.keys(rows[0]) : [];
      // @ts-expect-error app globals
      const body = rows.map((r) => head.map((k) => _anCsvCell(r[k])).join(',')).join('\n');
      // @ts-expect-error app globals
      return { rowsIsArray: Array.isArray(rows), header: head.join(','), body, quote: _anCsvCell('a,"b"') };
    });
    expect(csv.rowsIsArray).toBe(true);
    expect(csv.quote).toBe('"a,""b"""'); // CSV quoting/escaping is correct
  });

  test('gross margin nets revenue against mapped item costs', async ({ page }) => {
    const out = await page.evaluate(() => {
      const cost = { i1: 4, i2: 6 };
      const lines = [
        { item_id: 'i1', qty: 2, price: 10, pay: 'paid', cat: 'Drinks' }, // rev 20, cogs 8
        { item_id: 'i2', qty: 1, price: 12, pay: 'paid', cat: 'Bars' },     // rev 12, cogs 6
        { item_id: 'i1', qty: 1, price: 10, pay: 'refunded', cat: 'Drinks' }, // refunded → ignored
        { item_id: null, qty: 1, price: -5, pay: 'paid', cat: '__discount__' }, // discount → rev -5, as the till counts it
        { item_id: 'i1', qty: 1, price: 10, pay: 'team', cat: 'Drinks' },     // MM Team account → no rev, cogs 4
      ];
      // @ts-expect-error app globals
      const m = _anMargin(lines, cost);
      // @ts-expect-error app globals
      const none = _anMargin([{ item_id: 'x', qty: 1, price: 10, cat: 'Drinks' }], {});
      return { m, noCost: none.haveCost };
    });
    expect(out.m.rev).toBe(27); // 20 + 12 - 5
    expect(out.m.cogs).toBe(18); // 8 + 6 + 4
    expect(out.m.profit).toBe(9);
    expect(out.m.marginPct).toBe(33); // 9/27 ≈ 33%
    expect(out.m.haveCost).toBe(true);
    expect(out.noCost).toBe(false); // no cost mapped → card stays hidden
  });

  test('Pearson correlation is +1 / -1 / ~0 for the classic cases', async ({ page }) => {
    const out = await page.evaluate(() => ({
      // @ts-expect-error app globals
      up: _anCorrelation([1, 2, 3, 4], [2, 4, 6, 8]),
      // @ts-expect-error app globals
      down: _anCorrelation([1, 2, 3, 4], [8, 6, 4, 2]),
      // @ts-expect-error app globals
      flat: _anCorrelation([1, 2, 3, 4], [5, 5, 5, 5]),
    }));
    expect(out.up).toBeCloseTo(1, 5);
    expect(out.down).toBeCloseTo(-1, 5);
    expect(out.flat).toBe(0);
  });

  test('sparkline builds an SVG polyline (and is empty for <2 points)', async ({ page }) => {
    const out = await page.evaluate(() => ({
      // @ts-expect-error app globals
      line: _anSparkline([1, 3, 2, 5, 4], 'var(--green)'),
      // @ts-expect-error app globals
      empty: _anSparkline([7]),
    }));
    expect(out.line).toContain('<svg');
    expect(out.line).toContain('<polyline');
    expect(out.empty).toBe('');
  });

  test('the Growth view renders with no console errors', async ({ page }) => {
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.evaluate(() => {
      // @ts-expect-error app globals
      S.view = 'staff'; S.staffTab = 'analytics'; renderAnalytics();
      // @ts-expect-error app globals
      setAnView('growth');
    });
    const html = await page.locator('#tab-analytics').innerHTML();
    expect(html).toContain('data-anview="growth"');
    expect(errs, errs.join('\n')).toEqual([]);
  });
});
