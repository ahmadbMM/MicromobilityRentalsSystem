import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Analytics numbers safe to decide on (the staff review, 2026-10-28, P14): each tile against its own target, prorated
// to the dates on show with the month's pace (S08-analytics-01); the organiser's money and the rides a company pays
// on its invoice out of Pending and the averages, Billed to companies its own figure (-02); rates over the sessions
// already held, the ones to come a line of their own (-04); a product filter and a By product table (-05); one
// occupancy (-10) and one ride (-18) on the Dashboard and in Analytics. State is set straight into S; every name and
// number is invented.

const ksa = (n = 0) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });

async function boot(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, fx);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffRole='admin'`);
}
type Data = { sessions: Record<string, unknown>[]; rows: Record<string, unknown>[]; cashSales?: Record<string, unknown>[]; riders?: Record<string, unknown>[]; setup?: string };
// Bookings go in in the database's shape, through entryFromDB, as the app reads them.
async function show(page: Page, d: Data, view = 'overview') {
  await page.evaluate(([d, view]) => {
    const g = (n: string) => (0, eval)(n);
    const S = g('S') as Record<string, unknown>, fromDB = g('entryFromDB') as (r: Record<string, unknown>) => unknown;
    S.sessions = d.sessions; S.cashSales = d.cashSales || []; S.customers = [];
    S.riders = d.riders || []; S.ridersLoaded = true;
    S.queue = d.rows.map((r) => fromDB({ session_day: 'Friday', status: 'done', paid: true, price: 100, type_preference: 'Road', name: 'Rider', registered_at: '2026-01-01T10:00:00Z', ...r }));
    S.analyticsRange = 'all'; S.anSession = 'all'; S.anKind = 'all';
    if (d.setup) g(d.setup);
    g('setStaffTab')('analytics'); g('setAnView')(view);
  }, [d, view] as const);
}
const sess = (id: string, date: string, o: Record<string, unknown> = {}) => ({ id, day: 'Friday', session_date: date, capacity: 10, status: 'closed', created_at: 1, ...o });
const tab = (page: Page) => page.locator('#tab-analytics');
const kpi = (page: Page, label: string) => tab(page).locator('.analytics-kpi-card', { has: page.locator('.analytics-kpi-label', { hasText: label }) });

test.describe('@staff:analytics b2-f numbers safe to decide on', () => {
  test.beforeEach(async ({ page }) => { await boot(page); });

  test('targets: each tile against its own, prorated to the dates on show, with no one-month floor', async ({ page }) => {
    const r = await page.evaluate(`(()=>{
      S.staffOptions={biz:{kpi_targets:{revenue:3100,till:620,rides:31,occupancy:80,sales:9999}}};S.anRevTarget=0;
      const w=['2026-10-01','2026-10-07'];
      const out={m7:_anYMonths(w[0],w[1]),yr:_anYMonths('2026-01-01','2026-12-31'),span:_anYMonths('2026-09-25','2026-10-05'),
        fares:_anTargetOf('revCollected',w),till:_anTargetOf('sales',w),rides:_anTargetOf('rides',w),occ:_anTargetOf('occ',w),none:_anTargetOf('avgSess',w)};
      S.staffOptions={biz:{kpi_targets:{sales:9999}}};
      out.tillFromMoneyIn=_anTargetOf('sales',w);out.faresFromMoneyIn=_anTargetOf('revCollected',w);
      S.anRevTarget=310;out.device=_anTargetOf('revCollected',w);
      return out;})()`) as Record<string, number>;
    expect(r.m7).toBeCloseTo(7 / 31, 6);
    expect(r.yr).toBeCloseTo(12, 6);
    expect(r.span).toBeCloseTo(6 / 30 + 5 / 31, 6);
    expect(r.fares).toBeCloseTo(700, 6); // a week on pace is 100% of its share, not 23% of a month
    expect(r.till).toBeCloseTo(140, 6);
    expect(r.rides).toBeCloseTo(7, 6);
    expect(r.occ).toBe(80); // a rate is the same over any span
    expect(r.none).toBe(0);
    expect(r.tillFromMoneyIn).toBe(0); // the till tile is never held against the money in
    expect(r.faresFromMoneyIn).toBe(0); // nor the fares: money in is the Dashboard's
    expect(r.device).toBeCloseTo(70, 6); // Growth's own target on this device, before the team has one
  });

  test('This Month: the share of the month\'s target and the pace; a tile with no target of its own has no pill', async ({ page }) => {
    const today = ksa(0), [y, m, d] = today.split('-').map(Number), dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    await show(page, {
      sessions: [sess('t1', today)],
      rows: [{ id: 'a', session_id: 't1', session_date: today, price: 100, pay_method: 'cash' }],
      cashSales: [{ id: 'x1', receipt_id: 'x1', session_id: 't1', name: 'Gel', category: 'Food', qty: 1, price: 30, pay: 'paid', created_at: new Date().toISOString() }],
      setup: "S.staffOptions={biz:{kpi_targets:{revenue:3100,sales:5000}}};S.anRevTarget=0;S.analyticsRange='month';",
    }, 'revenue');
    const collected = kpi(page, 'Collected').first();
    await expect(collected.locator('.an-tgt')).toHaveText(`${Math.round(100 / 3100 * 100)}% of target`);
    await expect(collected.locator('.an-pace')).toHaveText(`${Math.round(100 / (3100 * d / dim) * 100)}% of pace`);
    const till = kpi(page, 'Sales value');
    await expect(till.locator('.an-tgt')).toHaveCount(0); // money in (sales) is not the till's target
    await page.evaluate(`S.staffOptions={biz:{kpi_targets:{revenue:3100,till:62}}};renderAnalytics()`);
    await expect(kpi(page, 'Sales value').locator('.an-tgt')).toHaveText(`${Math.round(30 / 62 * 100)}% of target`); // the model key holds the targets
    await expect(kpi(page, 'Sales value').locator('.an-pace')).toHaveCount(1);
  });

  test('Settings > Business has the three money targets; Growth\'s Set target writes the ride fares one', async ({ page }) => {
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    page.on('request', (r) => { const mm = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (mm) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: mm[1], body }); } });
    await page.route('**/rest/v1/rpc/staff_set_biz', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kpi_targets: { revenue: 4000 } }) }));
    await page.evaluate(`S._staffAuthed=true;S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();setStaffTab('settings');setSettingsView('business')`);
    const card = page.locator('[data-biz-card="kpi"]');
    await expect(card.locator('label[for="biz-kpi_targets-revenue"]')).toHaveText('Ride fares (SAR)');
    await expect(card.locator('label[for="biz-kpi_targets-till"]')).toHaveText('Till sales (SAR)');
    await expect(card.locator('label[for="biz-kpi_targets-sales"]')).toHaveText('Money in (SAR)');
    await card.locator('#biz-kpi_targets-revenue').fill('4000');
    await card.locator('#biz-kpi_targets-till').fill('500');
    await card.locator('#biz-save-kpi').click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_set_biz').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_set_biz')!.body).toEqual({ p_patch: { kpi_targets: { revenue: 4000, till: 500 } } });
    // Growth's Set target: the ride fares target (it wrote sales, the money in)
    await page.evaluate(`S.staffOptions={biz:{kpi_targets:{sales:9000}}};_listOk.opts=true;_bizFromOpts();promptDialog=async()=>'5000';_anSetTarget()`);
    await expect.poll(() => calls.filter((c) => c.name === 'staff_set_biz').length).toBe(2);
    expect(calls.filter((c) => c.name === 'staff_set_biz')[1].body).toEqual({ p_patch: { kpi_targets: { sales: 9000, revenue: 5000 } } });
  });

  test('a target this device kept before the team had one becomes the team\'s ride fares target', async ({ page }) => {
    const calls: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/staff_set_biz')) { try { calls.push(r.postDataJSON()); } catch { /* none */ } } });
    await page.route('**/rest/v1/rpc/staff_set_biz', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kpi_targets: { revenue: 2500 } }) }));
    await page.evaluate(`localStorage.setItem('cq_an_rev_target','2500');localStorage.removeItem('cq_devopt_moved');S._staffAuthed=true;S.staffOptions={biz:{kpi_targets:{sales:9000}}};_listOk.opts=true;_devOptSync()`);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_patch: { kpi_targets: { sales: 9000, revenue: 2500 } } });
  });

  test('the Dashboard reads rides and occupancy as Analytics does, and the money against three targets', async ({ page }) => {
    const today = ksa(0);
    await show(page, {
      sessions: [sess('t1', today, { capacity: 4 })],
      rows: [
        { id: 'a', session_id: 't1', session_date: today, price: 100 },
        { id: 'b', session_id: 't1', session_date: today, price: 100 },
        { id: 'c', session_id: 't1', session_date: today, status: 'noshow', paid: false },
        { id: 'o', session_id: 't1', session_date: today, type_preference: 'Own', price: 0 }, // an own bike takes no place on the circuit
      ],
      cashSales: [{ id: 'x1', receipt_id: 'x1', session_id: 't1', name: 'Gel', category: 'Food', qty: 1, price: 30, pay: 'paid', created_at: new Date().toISOString() }],
      setup: "S.analyticsRange='month';",
    }, 'operations');
    const now = await page.evaluate(`_kpiNow()`) as Record<string, number>;
    expect(now).toMatchObject({ rides: 3, occupancy: 50, revenue: 200, till: 30, sales: 230 });
    await expect(kpi(page, 'Avg Occupancy').locator('.analytics-kpi-value')).toHaveText('50%'); // the same number, one definition
    await page.evaluate(`S.staffOptions={biz:{kpi_targets:{revenue:400,till:60,sales:1000,occupancy:80}}};setStaffTab('dashboard')`);
    const card = page.locator('.kpi-card');
    await expect(card.locator('[data-kpi]')).toHaveCount(4);
    await expect(card.locator('[data-kpi="revenue"] .kpi-top')).toContainText('Ride fares');
    await expect(card.locator('[data-kpi="revenue"] .kpi-top b')).toHaveText('SAR 200 / SAR 400');
    await expect(card.locator('[data-kpi="till"] .kpi-top b')).toHaveText('SAR 30 / SAR 60');
    await expect(card.locator('[data-kpi="sales"] .kpi-top')).toContainText('Money in');
    await expect(card.locator('[data-kpi="sales"] .kpi-top b')).toHaveText('SAR 230 / SAR 1,000');
    await expect(card.locator('[data-kpi="occupancy"] .kpi-top b')).toHaveText('50% / 80%');
  });

  test('the organiser\'s money and company-billed rides stay out of Pending and the averages', async ({ page }) => {
    const d = ksa(-3);
    await show(page, {
      sessions: [
        sess('c1', d),
        sess('v1', d, { ride_kind: 'vlap', event_kind: 'community', needs_approval: false, capacity: 100 }),
        sess('p1', d, { ride_kind: 'petromin', event_kind: 'community', needs_approval: false, capacity: 20 }),
      ],
      rows: [
        { id: 'a', session_id: 'c1', session_date: d, price: 100, pay_method: 'cash' },
        { id: 'b', session_id: 'c1', session_date: d, price: 100, paid: false },
        { id: 't1', session_id: 'v1', session_date: d, price: 150, pay_method: 'transfer' }, // paid to the race's organiser
        { id: 't2', session_id: 'v1', session_date: d, price: 150, paid: false }, // holds the organiser's ticket
        { id: 'e1', session_id: 'p1', session_date: d, price: 50, paid: false }, // a Petromin employee: on the company's invoice
        { id: 'e2', session_id: 'p1', session_date: d, price: 57.5, paid: false },
      ],
      riders: [{ id: 1, matched_entry_id: 'e1', company: 'Petromin', source: 'petromin', session_id: 'p1' }],
    }, 'revenue');
    await expect(kpi(page, 'Pending').first().locator('.analytics-kpi-value')).toContainText('SAR 158'); // 100 + 57.5, not 507.5
    await expect(kpi(page, 'Pending').first().locator('.analytics-kpi-sub')).toHaveText('2 unpaid rides');
    await expect(kpi(page, 'Billed to companies').locator('.analytics-kpi-value')).toContainText('SAR 50');
    await expect(kpi(page, 'Billed to companies').locator('.analytics-kpi-sub')).toHaveText('Rides on a company invoice: 1');
    await expect(kpi(page, 'Collected').first().locator('.analytics-kpi-sub')).toHaveText('39% collection rate'); // 100 of 257.5
    await expect(kpi(page, 'Avg / Session').locator('.analytics-kpi-value')).toContainText('SAR 103'); // our 307.5 over 3 sessions held
    const byDay = tab(page).locator('.chart-card', { hasText: 'Revenue by Day of Week' });
    await expect(byDay.locator('.analytics-bar-value')).toHaveCount(1);
    await expect(byDay.locator('.analytics-bar-value')).toContainText('SAR 100'); // the organiser's 150 is not ours
    await page.evaluate(`setAnView('overview')`);
    await expect(tab(page).locator('.hl-item', { hasText: 'Revenue per Ride' }).locator('.hl-value')).toContainText('SAR 76.88'); // 307.5 over our 4 rides
    // the month's forecast books no organiser money for the race still to come
    const fc = await page.evaluate(`(()=>{S.sessions=[{id:'u1',session_date:'2026-09-20',ride_kind:'vlap',event_kind:'community',capacity:50,status:'open'},{id:'u2',session_date:'2026-09-21',capacity:10,status:'open'}];
      return _anMonthForecast(S.sessions,[{id:'r1',sessionId:'u1',status:'waiting',paid:false,price:150},{id:'r2',sessionId:'u1',status:'waiting',paid:true,pay_method:'transfer',price:150},{id:'r3',sessionId:'u2',status:'waiting',paid:false,price:60}],new Date('2026-09-15T09:00:00Z'));})()`) as Record<string, number>;
    expect(fc.booked).toBe(3);
    expect(fc.bookedRev).toBe(60);
  });

  test('rates read the sessions held; the sessions to come are a line of their own', async ({ page }) => {
    const held = await page.evaluate(`(()=>{const td=todayStr(),y=_isoAddDays(td,-1),tm=_isoAddDays(td,1);
      return[_anYHeld({id:'a',session_date:y,status:'open'}),_anYHeld({id:'b',session_date:td,status:'open'}),_anYHeld({id:'c',session_date:td,status:'closed'}),
        _anYHeld({id:'d',session_date:tm,status:'closed'}),_anYHeld({id:'e',session_date:y,status:'closed',cancelled_at:'2026-01-01T00:00:00Z'}),_anYHeld({id:'f',session_date:y,status:'deleted'})];})()`);
    expect(held).toEqual([true, false, true, false, false, false]);
    const past = ksa(-3), next = ksa(3), today = ksa(0);
    await show(page, {
      sessions: [sess('h', past), sess('f', next, { status: 'open' }), sess('t', today, { status: 'open', capacity: 8 })],
      rows: [
        { id: 'h1', session_id: 'h', session_date: past }, { id: 'h2', session_id: 'h', session_date: past }, { id: 'h3', session_id: 'h', session_date: past },
        { id: 'h4', session_id: 'h', session_date: past, status: 'noshow', paid: false }, { id: 'h5', session_id: 'h', session_date: past, status: 'cancelled', paid: false },
        ...[1, 2, 3, 4].map((i) => ({ id: 'f' + i, session_id: 'f', session_date: next, status: 'waiting', paid: false })),
        { id: 'fx1', session_id: 'f', session_date: next, status: 'cancelled', paid: false }, { id: 'fx2', session_id: 'f', session_date: next, status: 'cancelled', paid: false },
        { id: 't1', session_id: 't', session_date: today, status: 'waiting', paid: false }, { id: 't2', session_id: 't', session_date: today, status: 'waiting', paid: false },
      ],
    }, 'operations');
    await expect(kpi(page, 'Sessions Held').locator('.analytics-kpi-value')).toHaveText('1');
    await expect(kpi(page, 'Avg Occupancy').locator('.analytics-kpi-value')).toHaveText('30%');
    await expect(kpi(page, 'No-Show Rate').locator('.analytics-kpi-value')).toHaveText('25%');
    await expect(kpi(page, 'Cancellation Rate').locator('.analytics-kpi-value')).toHaveText('20%'); // 1 of 5 on the night held, not 3 of 10
    await expect(kpi(page, 'Avg fill rate').locator('.analytics-kpi-value')).toHaveText('40%'); // 4 places booked of 10, the no-show too
    await expect(tab(page).locator('.an-up-line').first()).toHaveText('Sessions to come: 2, 6 of 18 places booked');
    await page.evaluate(`setAnView('ridership')`);
    await expect(kpi(page, 'Completion Rate').locator('.analytics-kpi-value')).toHaveText('75%');
    await page.evaluate(`setAnView('growth')`);
    const rows = tab(page).locator('.an-funnel-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Booked');
    await expect(rows.nth(0).locator('.an-funnel-head span').nth(1)).toHaveText('4'); // places taken on the night held
    await expect(rows.nth(3)).toContainText('Cancelled');
  });

  test('a product filter narrows every figure, and By product sets the products side by side', async ({ page }) => {
    const d = ksa(-4);
    const comm = { event_kind: 'community', needs_approval: false };
    await show(page, {
      sessions: [
        sess('j', d),
        sess('s', d, { event_kind: 'community', spots: 5, capacity: 40 }), // the Saturday ride: an approval ride, places are its spots
        sess('p', d, { ...comm, ride_kind: 'petromin' }),
        sess('w', d, { ...comm, ride_kind: 'swim' }),
        sess('k', d, { ...comm, ride_kind: 'workshop' }),
        sess('a', d, { ...comm, ride_kind: 'arena' }),
      ],
      rows: [
        { id: 'j1', session_id: 'j', session_date: d }, { id: 'j2', session_id: 'j', session_date: d },
        { id: 's1', session_id: 's', session_date: d, paid: false, price: 0, approval: 'approved' }, { id: 's2', session_id: 's', session_date: d, paid: false, price: 0, approval: 'approved' },
        { id: 's3', session_id: 's', session_date: d, paid: false, price: 0, type_preference: 'Own', approval: 'approved' }, // an own bike takes none of the spots
        { id: 'p1', session_id: 'p', session_date: d, price: 57.5 }, { id: 'p2', session_id: 'p', session_date: d, price: 57.5, type_preference: 'Own' }, // on Petromin it does
        { id: 'w1', session_id: 'w', session_date: d, price: 0, type_preference: 'Any' },
        { id: 'k1', session_id: 'k', session_date: d, price: 0, type_preference: 'Any' },
        { id: 'a1', session_id: 'a', session_date: d, price: 140, type_preference: 'Any', pay_method: 'cash' },
      ],
    }, 'overview');
    const opts = await page.evaluate(`[...document.querySelectorAll('#tab-analytics select.an-kind-sel option')].map(o=>o.value)`);
    expect(opts).toEqual(['all', 'jcc', 'sat', 'pm', 'swim', 'ws', 'ev']);
    const table = tab(page).locator('table.an-prod');
    await expect(table.locator('tbody tr')).toHaveCount(6);
    expect(await table.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-kind')))).toEqual(['jcc', 'sat', 'pm', 'swim', 'ws', 'ev']);
    await expect(table.locator('tr[data-kind="sat"] td').nth(2)).toHaveText('3'); // three rode
    await expect(table.locator('tr[data-kind="sat"] td').nth(3)).toHaveText('2 / 5 · 40%');
    await expect(table.locator('tr[data-kind="pm"] td').nth(3)).toHaveText('2 / 10 · 20%');
    await expect(table.locator('tr[data-kind="ev"] td').nth(0)).toHaveText('Events and races'); // the Arena race, by no name of its own
    await expect(table.locator('tr[data-kind="ev"] td').nth(5)).toHaveText('SAR 140'); // fares collected
    await expect(table.locator('tr[data-kind="pm"] td').nth(7)).toHaveText('SAR 57.50'); // our money per ride
    await expect(table.locator('tr[data-kind="pm"] td').nth(8)).toHaveText('SAR 115'); // and per session held
    await page.evaluate(`_anYKindSet('sat')`);
    await expect(tab(page).locator('.an-range-bar .result-count')).toHaveText('1 sessions held · 3 rides');
    expect(await page.evaluate(`[...document.querySelectorAll('#tab-analytics .an-range-bar select:not(.an-kind-sel) option')].map(o=>o.value)`)).toEqual(['all', 's']);
    await expect(table.locator('tbody tr')).toHaveCount(6); // By product still sets every product side by side
    await expect(tab(page).locator('table.an-prod tr.an-prod-on')).toHaveAttribute('data-kind', 'sat');
    expect(await page.evaluate(`S._anCsvRows.map(r=>r.product+':'+r.riders+':'+r.occupancy_pct)`)).toEqual(['Saturday ride:3:40']);
    await page.evaluate(`setAnView('months')`);
    await expect(page.locator('#an-mo-host .an-kind-note')).toHaveText('Months count every product together: the server adds them up as one.');
    await page.evaluate(`_anYKindSet('nope')`);
    expect(await page.evaluate('S.anKind')).toBe('all');
    await expect(page.locator('#an-mo-host .an-kind-note')).toHaveCount(0);
  });

  test('one ride and one occupancy: a paid ride before 12 August counts, the second ride tile is gone', async ({ page }) => {
    const r = await page.evaluate(`(()=>{const s={id:'x',session_date:'2026-09-01',capacity:3},pm={id:'y',session_date:'2026-09-01',capacity:3,ride_kind:'petromin',event_kind:'community',needs_approval:false};
      const rows=[{status:'done',typePreference:'Road'},{status:'active',typePreference:'Own'},{status:'done',typePreference:'Hybrid'},{status:'done',typePreference:'Road'},{status:'done',typePreference:'Road'}].map(e=>({...e,sessionDate:'2026-09-01'}));
      return[_anYUsed(s,rows),_anYUsed(pm,rows),_anYUsed(s,[{status:'noshow',sessionDate:'2026-09-01'},{status:'waiting',sessionDate:'2026-09-01'}]),_anYUsed(s,rows.slice(0,2))];})()`);
    expect(r).toEqual([3, 3, 0, 1]); // capped at the places; an own bike only on Petromin; a no-show used none
    await show(page, {
      sessions: [sess('old', '2026-07-01')],
      rows: [
        { id: 'o1', session_id: 'old', session_date: '2026-07-01', status: 'waiting', paid: true }, // paid, never checked in: a ride before the cutover
        { id: 'o2', session_id: 'old', session_date: '2026-07-01', status: 'done', paid: false }, // not one (the owner's rule)
      ],
    }, 'ridership');
    await expect(kpi(page, 'Number of Rides').locator('.analytics-kpi-value')).toHaveText('1');
    await expect(tab(page).locator('.analytics-kpi-label', { hasText: 'Completed Rides' })).toHaveCount(0);
    await page.evaluate(`setAnView('operations')`);
    await expect(tab(page).locator('table.analytics-trend-table[data-nosort] tbody tr').first().locator('td').nth(2)).toHaveText('1 / 10');
  });
});
