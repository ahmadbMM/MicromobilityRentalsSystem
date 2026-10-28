import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The staff panel review, batch 1 (2026-10-28), builder B: money by how it was taken (P03) and Petromin billing
// that follows the bookings (P02), plus two till fixes handed over (js23-3, js23-5).
//   S10-money-01 / S13-open-items-05  a paid booking with no method is "Method not recorded", never drawer cash:
//                                      the close-out, the night's summary and the till (_mnySplit)
//   S04-core4-06                       the session report: Collected with add-ons, card, cash, not recorded
//   S08-analytics-03                   Analytics' payments and the server snapshots' "not recorded"
//   S05-core5-08                       a sale rung up on a booking records Card or Cash
//   S05-core5-03 / S13-open-items-04   the Billing report's period (night, all, a month) and its rides still out,
//                                      returned with one tap through the Petromin page's own Return
//   js23-3 / js23-5                    the shop till of any day; a closed till's Z-report prints what was stored

const D = '2099-02-08';
const sessions = [{ id: 's0', day: 'Sunday', session_date: D, capacity: 20, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null }];
const qe = (id: string, num: number, name: string, extra: Record<string, unknown>) => ({
  id, session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: num, name, phone: `05000000${num}`, customer_id: null,
  type_preference: 'Hybrid', registered_at: '2099-01-01T10:00:00Z', status: 'done', ...extra,
});
// 95 by card (75 + a 20 add-on), 57.5 cash, 100 split (60 card / 40 cash), 50 paid with no method, 150 paid to the
// organiser (none of ours), 57.5 still owed: card 155, cash 97.5, not recorded 50; collected 302.5 with the add-on.
const inventory = [{ id: 'a1', name: 'Gloves', category: 'Gloves', price: 20, qty: 10 }];
const money = [
  qe('e1', 1, 'Card Rider', { paid: true, price: 75, pay_method: 'card', addons: JSON.stringify([{ id: 'a1', qty: 1, p: 20 }]) }),
  qe('e2', 2, 'Cash Rider', { paid: true, price: 57.5, pay_method: 'cash' }),
  qe('e3', 3, 'Split Rider', { paid: true, price: 100, pay_method: 'split', card_amount: 60 }),
  qe('e4', 4, 'No Method Rider', { paid: true, price: 50 }),
  qe('e5', 5, 'Organiser Paid', { paid: true, price: 150, pay_method: 'transfer' }),
  qe('e6', 6, 'Owes Still', { paid: false, price: 57.5 }),
];

async function boot(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions, queue_entries: money, inventory, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`localStorage.setItem('cq_op_name','Spec Staff');S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();`);
}
/** A report window's HTML, captured instead of opened. */
async function printed(page: Page, call: string) {
  return page.evaluate(`(async () => {
    let cap = '';
    const orig = window.open;
    window.open = () => ({ closed: false, document: { write: (h) => { cap += h; }, close() {}, querySelectorAll: () => [], querySelector: () => null }, focus() {}, print() {}, close() {} });
    try { await (${call}); } finally { window.open = orig; }
    return cap;
  })()`) as Promise<string>;
}
const writes = (page: Page, table: string) => {
  const out: { method: string; body: unknown; url: string }[] = [];
  page.on('request', (r) => {
    if (['PATCH', 'POST'].includes(r.method()) && r.url().includes(`/rest/v1/${table}`)) {
      let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
      out.push({ method: r.method(), body, url: r.url() });
    }
  });
  return out;
};

test.describe('@staff:money b1 B: money by how it was taken', () => {
  test('one split: card, cash recorded as cash, Method not recorded; the organiser\'s money in none', async ({ page }) => {
    await boot(page);
    await page.waitForFunction(`getQueue().length===6`);
    const got = await page.evaluate(`(() => {
      const q = getQueue().filter((e) => e.paid && e.status !== 'cancelled' && e.status !== 'removed');
      return { sum: _mnySum(q), one: _mnySplit(_qGet('e4')), org: _mnySplit(_qGet('e5')) };
    })()`);
    expect(got).toEqual({ sum: { card: 155, cash: 97.5, unknown: 50 }, one: { card: 0, cash: 0, unknown: 50 }, org: { card: 0, cash: 0, unknown: 0 } });
  });

  test('the close-out prints not recorded apart, never as cash, and the balance check calls it unaccounted', async ({ page }) => {
    await boot(page);
    await page.waitForFunction(`getQueue().length===6`);
    const html = await printed(page, `(S._ctSession='s0', printCloseout())`);
    expect(html).toContain('Method not recorded');
    expect(html).toContain('SAR 97.50'); // the cash recorded as cash (57.5 + the split's 40)
    expect(html).toContain('SAR 155.00'); // card, add-on included
    expect(html).not.toContain('SAR 147.50'); // what "collected minus card" called cash
    expect(html).toMatch(/Unaccounted<\/span><span><bdi>SAR 50\.00/);
  });

  test('the night\'s summary and the till leave it out of cash and show it in the warning colour', async ({ page }) => {
    await boot(page, { till_sessions: [{ id: 't1', day: D, session_id: 's0', float: 100, opened_at: `${D}T15:00:00Z`, opened_by_name: 'Spec Staff', closed_at: null }], till_counts: [] });
    await page.waitForFunction(`getQueue().length===6`);
    const m = await page.evaluate(`(() => { const m = _eonModel('s0'), k = _tillTake(_tillCtx('s0')); return { card: m.card, cash: m.cash, unknown: m.unknown, tCash: k.cash, tCard: k.card, tUnk: k.unk }; })()`);
    expect(m).toEqual({ card: 155, cash: 97.5, unknown: 50, tCash: 97.5, tCard: 155, tUnk: 50 });
    await page.evaluate(`_eonOpen('s0',{})`);
    const row = page.locator('#eon-modal .eon-row.eon-warn');
    await expect(row).toContainText('Method not recorded');
    await expect(row).toContainText('SAR 50');
    await page.evaluate(`_eonClose()`);
    await page.evaluate(`recordDrawerCount('s0')`);
    const dlg = page.getByRole('dialog', { name: /^Till/ });
    await expect(dlg.locator('dd.mny-over')).toContainText('SAR 50');
    await expect(dlg.locator('dt.mny-over')).toHaveText('Method not recorded');
    await expect(dlg).toContainText('SAR 197.50'); // expected: the float + the cash recorded as cash only
  });

  test('the session report: Collected with add-ons, VAT on it, a not-recorded tile and payment cell', async ({ page }) => {
    await boot(page);
    await page.waitForFunction(`getQueue().length===6`);
    const html = await printed(page, `(S.sfSession='s0', S._repOpts=_repDefaults(), printSessionReport())`);
    expect(html).toMatch(/SAR 302\.50<\/bdi><\/span><span class="total-lbl">Collected/);
    expect(html).toMatch(/SAR 155\.00<\/bdi><\/span><span class="total-lbl">Card/);
    expect(html).toMatch(/SAR 97\.50<\/bdi><\/span><span class="total-lbl">Cash/);
    expect(html).toMatch(/total-num rp-amber"><bdi>SAR 50\.00<\/bdi><\/span><span class="total-lbl rp-amber">Method not recorded/);
    expect(html).toContain('SAR 39.46'); // 15% VAT inside 302.50
    // the row paid with no method says so; the cash rider still says Cash
    expect(html).toMatch(/No Method Rider[\s\S]*?<span class="rp-pm"><span class="rp-amber">Method not recorded<\/span><\/span>/);
    expect(html).toMatch(/Cash Rider[\s\S]*?<span class="rp-pm">Cash<\/span>/);
  });

  test('Analytics: a Method not recorded card beside cash and card, the card share of everything taken', async ({ page }) => {
    await boot(page);
    await page.waitForFunction(`getQueue().length===6`);
    await page.evaluate(`S.view='staff';S.staffTab='analytics';S.analyticsRange='all';S.anSession='all';S.anView='revenue';renderAnalytics()`);
    const card = (label: string) => page.locator('#tab-analytics .analytics-kpi-card', { has: page.locator('.analytics-kpi-label', { hasText: label }) });
    await expect(card('Method not recorded').locator('.analytics-kpi-value')).toHaveText('SAR 50');
    await expect(card('Cash collected').locator('.analytics-kpi-value')).toHaveText('SAR 98'); // 97.5, whole riyals here
    await expect(card('Card collected').locator('.analytics-kpi-sub')).toContainText('51%'); // 155 of 303
  });

  test('Analytics > Reports: the server\'s fares less card less cash is Method not recorded; an older snapshot shows none', async ({ page }) => {
    const totals = { rides: 20, riders: 18, rev_rides: 1300, rev_card: 800, rev_cash: 300, rev_sales: 100, sales_card: 40, sales_cash: 60, pending: 0, noshows: 1, cancellations: 0 };
    const snaps = [
      { id: 2, kind: 'weekly_kpi', period_from: '2099-02-01', period_to: '2099-02-07', created_at: '2099-02-08T05:00:00Z',
        data: { totals, prev: totals, last_year: {}, occupancy: 60, by_day: [{ date: '2099-02-05', rides: 20, fares: 1300, fares_card: 800, fares_cash: 300, sales: 100, sales_card: 40, sales_cash: 60 }] } },
      { id: 1, kind: 'daily_closeout', period_from: '2099-01-31', period_to: '2099-01-31', created_at: '2099-02-01T01:00:00Z',
        data: { totals: { ...totals, rev_cash: 500 }, sessions: [], till: { paid: 100, house: 0, team: 0, refunded: 0, voided: 0, discount: 0 } } },
    ];
    await boot(page, { report_snapshots: snaps });
    await page.evaluate(`window.__wa=[];window.open=(u)=>{window.__wa.push(String(u));return null;};setStaffTab('analytics');setAnView('reports')`);
    const items = page.locator('#an-rp-host .rpi-item');
    await expect(items).toHaveCount(2);
    await items.nth(0).locator('.rpi-open').click();
    const warn = items.nth(0).locator('.rpi-line.rpi-warn');
    await expect(warn).toContainText('Method not recorded');
    await expect(warn).toContainText('SAR 200');
    await expect(items.nth(0).locator('table.rpi-days th.rpi-warn')).toHaveText('Method not recorded');
    await expect(items.nth(0).locator('table.rpi-days td.rpi-warn')).toContainText('SAR 200');
    await items.nth(0).locator('button', { hasText: 'WhatsApp' }).click();
    expect(decodeURIComponent((await page.evaluate('window.__wa') as string[])[0])).toContain('Method not recorded: SAR 200');
    await items.nth(1).locator('.rpi-open').click(); // cash was the rest before 20261028140000: nothing not recorded
    await expect(items.nth(1).locator('.rpi-line.rpi-warn')).toHaveCount(0);
  });

  test('a sale on a booking records Card or Cash, and the till and the Sales tab split by it', async ({ page }) => {
    await boot(page, { queue_entries: [qe('q1', 1, 'Buyer', { status: 'active', paid: true, price: 75, pay_method: 'card' })] });
    await page.waitForFunction(`getQueue().length===1`);
    const sent = writes(page, 'queue_entries');
    await page.evaluate(`showCashierModal('q1')`);
    const modal = page.locator('#cashier-modal');
    await expect(modal.locator('.sl-pay.sl-pay-on')).toHaveText('Card'); // Card first, as rentals
    await expect(modal.locator('.sl-pays .sl-pay')).toHaveText(['Card', 'Cash', 'Pending', 'On the house', 'MM Team']);
    await page.evaluate(`S._cashItem='__custom__';S._cashName='Water';S._cashAmt='12';`);
    await modal.getByRole('button', { name: 'Cash', exact: true }).click();
    await expect(modal.locator('.sl-pay.sl-pay-on')).toHaveText('Cash');
    await page.evaluate(`_cashAddLine()`);
    await expect.poll(() => sent.length).toBe(1);
    await page.evaluate(`S._cashPay='card';S._cashItem='__custom__';S._cashName='Gel';S._cashAmt='8';_cashAddLine()`);
    await expect.poll(() => sent.length).toBe(2);
    const last = JSON.parse(String((sent[1].body as Record<string, unknown>).purchases)) as Record<string, unknown>[];
    expect(last.map((l) => [l.name, l.pay, l.method])).toEqual([['Water', 'paid', 'cash'], ['Gel', 'paid', 'card']]);
    await expect(modal).toContainText('Paid · Cash');
    await expect(modal).toContainText('Paid · Card');
    const take = await page.evaluate(`_tillTake(_tillCtx('s0'))`) as { cash: number; card: number };
    expect(take).toMatchObject({ cash: 12, card: 83 }); // the 75 rental and the gel by card, the water in the drawer
    await page.evaluate(`closeCashierModal();setStaffTab('cashier');S._ctSession='s0';renderCashier()`);
    await expect(page.locator('#tab-cashier .sl-cc')).toContainText('Card: SAR 8');
    await expect(page.locator('#tab-cashier .sl-cc')).toContainText('Cash: SAR 12');
  });
});

// The Petromin page's Billing report (S05-core5-03, S13-open-items-04): a period of a night, all nights or one month,
// and the period's rides still out - checked in and never returned there, or returned on Bookings only - with one
// tap that returns them through the page's own Return.
const J = '2099-01-14-pw', F = '2099-02-11-pw';
const pmSessions = [J, F].map((id, i) => ({ id, day: 'Wednesday', session_date: id.slice(0, 10), capacity: 35, status: 'open', created_at: i + 1,
  bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }), event_kind: 'community', ride_kind: 'petromin', paid_ride: true, title: "Petromin's Wednesdays" }));
const pq = (id: string, status: string) => ({ id, session_id: F, session_day: 'Wednesday', session_date: F.slice(0, 10), queue_num: 1, name: 'Booked ' + id,
  phone: '0551112222', customer_id: null, status, paid: false, price: 50, type_preference: 'Hybrid', registered_at: '2099-01-01T10:00:00Z' });
const reg = (id: number, sid: string, co: string, extra: Record<string, unknown>) => ({
  id, source: 'petromin', session_id: sid, booking_no: `P-00${id}`, party_no: 1, badge: `B-${id}`, name: `Rider ${id}`, phone: '+966500000011', company: co,
  height: 175, type_preference: 'Hybrid', matched_entry_id: null, matched_customer_id: null, match_kind: 'none', submissions: 1, price: 50,
  checked_in_at: null, checked_in_by: null, checked_out_at: null, checked_out_by: null, created_at: '2099-01-10T09:00:00Z', updated_at: '2099-01-10T09:00:00Z', ...extra,
});
const regs = [
  reg(1, J, 'Petromin', { checked_in_at: '2099-01-14T16:00:00Z', checked_out_at: '2099-01-14T17:00:00Z' }),
  reg(2, F, 'Petromin', { checked_in_at: '2099-02-11T16:00:00Z', checked_out_at: '2099-02-11T17:00:00Z' }),
  reg(3, F, 'Petromin', { checked_in_at: '2099-02-11T16:05:00Z', matched_entry_id: 'qa', price: null }), // on a bike, never returned
  reg(4, F, 'Petrolube', { matched_entry_id: 'qd', price: null }), // returned on Bookings only: no stamp here
  reg(5, F, 'Petromin', { matched_entry_id: 'qw', price: null }), // not arrived
];

async function billing(page: Page, night = 'all') {
  await stubSupabase(page, { sessions: pmSessions, queue_entries: [pq('qa', 'active'), pq('qd', 'done'), pq('qw', 'waiting')], rider_registrations: regs, 'rpc:staff_return': { ok: true } });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`(async()=>{localStorage.setItem('cq_op_name','Spec Staff');S._staffAuthed=true;await loadData();await loadRiders();setStaffTab('riders');S.ridersSession=${JSON.stringify(night)};openRidersReport();})()`);
  await expect(page.locator('#rider-report-modal .modal-box')).toBeVisible();
}
const co = (page: Page, name: string) => page.locator(`#rider-report-modal .rider-rep-co[data-co="${name}"]`);

test.describe('@staff:petromin b1 B: the Billing report\'s period and its rides still out', () => {
  test('the period: all nights, one month, the night picked; the CSV is named for it', async ({ page }) => {
    await billing(page);
    const sel = page.locator('#rider-report-modal .rp-scope select');
    await expect(sel).toHaveValue('all');
    await expect(sel.locator('option')).toHaveText(['All', /2099/, /2099/]); // the two months, the latest first
    await expect(co(page, 'Petromin')).toContainText('Completed rides: 2');
    await sel.selectOption('2099-01');
    await expect(co(page, 'Petromin')).toContainText('Completed rides: 1');
    await expect(page.locator('#rider-report-modal .modal-title')).toContainText('2099');
    await expect(page.locator('#rider-rep-out')).toHaveCount(0); // January has nothing out
    const [file] = await Promise.all([page.waitForEvent('download'), co(page, 'Petromin').locator('button', { hasText: 'CSV' }).click()]);
    expect(file.suggestedFilename()).toBe('petromin-report-2099-01.csv');
    // the night on the page: offered first, and the report opens on it
    await page.evaluate(`closeRidersReport();S.ridersSession=${JSON.stringify(F)};openRidersReport()`);
    await expect(sel).toHaveValue('night');
    await expect(co(page, 'Petromin')).toContainText('Completed rides: 1');
  });

  test('the rides still out are named, and Return them stamps each through the page\'s own Return', async ({ page }) => {
    await billing(page, F);
    const sent = writes(page, 'rider_registrations');
    const rpc: string[] = [];
    page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) rpc.push(m[1]); });
    const out = page.locator('#rider-rep-out');
    await expect(out).toContainText('2 checked in and not returned');
    await out.getByRole('button', { name: 'Return them' }).click();
    const confirm = page.locator('#confirm-modal .confirm-box');
    await expect(confirm).toContainText('Return these riders (2)?');
    await expect(confirm).toContainText('Rider 3');
    await expect(confirm).toContainText('Rider 4');
    await confirm.getByRole('button', { name: 'Return all' }).click();
    await expect.poll(() => sent.filter((s) => s.method === 'PATCH').length).toBe(2);
    for (const s of sent) expect(s.body).toMatchObject({ checked_out_at: expect.any(String), checked_out_by: 'Spec Staff' });
    expect(sent.map((s) => decodeURIComponent(s.url).match(/id=eq\.(\d+)/)?.[1]).sort()).toEqual(['3', '4']);
    await expect.poll(() => rpc.filter((n) => n === 'staff_return').length).toBe(1); // the booking on a bike is returned; the done one is left
    await expect(out).toHaveCount(0);
    await expect(co(page, 'Petromin')).toContainText('Completed rides: 2');
    await expect(co(page, 'Petrolube')).toContainText('Completed rides: 1');
  });
});

// js23-3: the shop's till is the newest open one whatever its day, counted on its own day's takings.
// js23-5: a closed till's Z-report prints what was stored at its close, not what this device works out today.
const ksaDay = (daysAgo: number) => new Date(Date.now() + 3 * 3600e3 - daysAgo * 864e5).toISOString().slice(0, 10);

test.describe('@staff:sales b1 B: the till handed over', () => {
  test('a shop till opened on an earlier day is found, named with its day and counted on that day\'s sales', async ({ page }) => {
    const day = ksaDay(3);
    await stubSupabase(page, {
      sessions: [], queue_entries: [], inventory: [], till_counts: [],
      till_sessions: [{ id: 't9', day, session_id: null, float: 50, opened_at: `${day}T19:00:00Z`, opened_by_name: 'Spec Staff', closed_at: null }],
      cashier_sales: [{ id: 'cs1', receipt_id: 'r1', session_id: null, item_id: null, name: 'Water', category: 'drinks', qty: 1, price: 20, pay: 'paid', created_at: `${day}T12:00:00.000Z` }],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const urls: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/till_sessions')) urls.push(decodeURIComponent(r.url())); });
    await page.evaluate(`recordDrawerCount('__shop__')`);
    const dlg = page.getByRole('dialog', { name: /^Till/ });
    await expect(dlg).toContainText('SAR 70'); // the float + that day's sale
    expect(await page.evaluate(`S._till.c.day`)).toBe(day);
    const q = urls.find((u) => u.includes('closed_at=is.null'))!;
    expect(q).toContain('session_id=is.null');
    expect(q).not.toContain('day=eq.');
  });

  test('a closed till\'s Z-report prints its stored cash and card, whatever the bookings say now', async ({ page }) => {
    await boot(page, { till_counts: [], till_sessions: [] });
    await page.waitForFunction(`getQueue().length===6`);
    const html = await printed(page, `(async () => {
      await Promise.resolve(renderMoneyView('none'));
      S._tillH = { from: '2099-02-01', to: '2099-02-28', busy: false, err: null, key: '', rows: [{ id: 'tz', session_id: 's0', day: '${D}', float: 100,
        opened_at: '${D}T15:00:00Z', opened_by_name: 'Spec Staff', closed_at: '${D}T21:00:00Z', closed_by_name: 'Spec Staff',
        expected_cash: 160, counted_cash: 160, card_expected: 75, card_terminal_total: 75 }] };
      await _tillZ('tz');
    })()`);
    expect(html).toMatch(/SAR 60\.00<\/bdi><\/span><span class="total-lbl">Cash taken/); // 160 expected - 100 float
    expect(html).toMatch(/SAR 75\.00<\/bdi><\/span><span class="total-lbl">Card taken/);
    expect(html).not.toContain('SAR 97.50'); // what the bookings on this device would make of it today
  });
});
