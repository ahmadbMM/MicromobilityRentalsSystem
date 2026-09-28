import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from '../tests/helpers/supabase';

declare const _langLoaded: (l: string) => boolean; // app global

// Staff > Analytics, every sub-view, pixel for pixel (playwright.visual.config.ts says how to run it).
// The data is generated from a fixed seed and the clock is frozen, so two runs of the same build
// draw the same pixels; a difference is a difference in the page.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';

// mulberry32: a small seeded generator, so the fixture is the same on every run
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = seeded(20260924);
const pick = <T>(a: readonly T[]): T => a[Math.floor(R() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const chance = (p: number) => R() < p;

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOf = (d: string) => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

type Row = Record<string, unknown>;

const bikes: Row[] = [
  { id: 'b01', name: 'Road 1', type: 'Road', size: 'M', status: 'available', brand: 'Alvas', model: 'Climax', bike_number: 1, in_service_date: '2025-10-01', colors: ['#111'] },
  { id: 'b02', name: 'Road 2', type: 'Road', size: 'L', status: 'available', brand: 'Alvas', model: 'Climax', bike_number: 2, in_service_date: '2025-10-01', colors: ['#111'] },
  { id: 'b03', name: 'Road 3', type: 'Road', size: 'S', status: 'available', brand: 'Alvas', model: 'DA54', bike_number: 3, in_service_date: '2026-03-15', colors: ['#c00'] },
  { id: 'b04', name: 'Hybrid 1', type: 'Hybrid', size: 'M', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 4, in_service_date: '2025-10-01', colors: ['#0a0'] },
  { id: 'b05', name: 'Hybrid 2', type: 'Hybrid', size: 'L', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 5, colors: ['#0a0'] },
  { id: 'b06', name: 'Hybrid 3', type: 'Hybrid', size: 'M', status: 'available', brand: 'Trek', model: 'FX 2', bike_number: 6, colors: ['#00c'] },
  { id: 'b07', name: 'Mountain 1', type: 'Mountain', size: 'M', status: 'available', brand: 'Alvas', model: 'Strom M50', bike_number: 7, in_service_date: '2026-01-10', colors: ['#555'] },
  { id: 'b08', name: 'Mountain 2', type: 'Mountain', size: 'L', status: 'available', brand: 'Alvas', model: 'Strom M50', bike_number: 8, colors: ['#555'] },
  { id: 'b09', name: 'Road 4', type: 'Road', size: 'XL', status: 'available', brand: 'Giant', model: 'Contend', bike_number: 9, colors: ['#fff'] },
  { id: 'b10', name: 'Hybrid 4', type: 'Hybrid', size: 'S', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 10, colors: ['#0a0'] },
  { id: 'b11', name: 'Old Road', type: 'Road', size: 'M', status: 'retired', brand: 'Alvas', model: 'Climax', bike_number: 11, colors: ['#111'] },
];
const byType: Record<string, string[]> = { Road: ['b01', 'b02', 'b03', 'b09'], Hybrid: ['b04', 'b05', 'b06', 'b10'], Mountain: ['b07', 'b08'] };

const FIRST = ['Omar', 'Sara', 'Khalid', 'Lina', 'Faisal', 'Noura', 'Yousef', 'Reem', 'Majed', 'Huda', 'Tariq', 'Dana', 'Salem', 'Maha', 'Ali', 'Jana', 'Hamad', 'Rana'];
const LAST = ['Alharbi', 'Alqahtani', 'Alghamdi', 'Alzahrani', 'Alotaibi', 'Almutairi', 'Alshehri', 'Aldosari'];
const customers: Row[] = FIRST.map((f, i) => ({
  id: 'c' + String(i + 1).padStart(2, '0'),
  name: f + ' ' + LAST[i % LAST.length],
  phone: i % 5 === 4 ? null : '05' + String(50000000 + i * 1234567).slice(0, 8),
  email: f.toLowerCase() + '@example.com',
  created_at: ['2025-10-20', '2025-11-02', '2026-01-05', '2026-04-11', '2026-06-30', '2026-07-08', '2026-08-02', '2026-08-19', '2026-09-03'][i % 9] + 'T09:00:00Z',
  height: 150 + ((i * 7) % 45),
}));

const inventory: Row[] = [
  { id: 'i1', name: 'Energy Gel', brand: 'SiS', category: 'EnergyGels', qty: 40, price: 12, cost: 7, addon: true },
  { id: 'i2', name: 'Still Water', brand: 'VOSS', category: 'Drinks', qty: 60, price: 8, cost: 3, addon: true },
  { id: 'i3', name: 'Protein Bar', brand: 'Barebells', category: 'ProteinSnacks', qty: 25, price: 15, cost: 9, addon: true },
  { id: 'i4', name: 'Helmet', brand: '', category: 'Helmet', qty: 30, price: 10, addon: true },
];

// Past Friday nights (21:00-23:00) and Tuesday evenings (17:00-19:00), one Saturday social ride
// that staff approve, tonight's ride, and one ahead.
const PAST = ['2025-11-14', '2026-01-09', '2026-07-10', '2026-07-24', '2026-08-07', '2026-08-14', '2026-08-18', '2026-08-21', '2026-09-04', '2026-09-11', '2026-09-15', '2026-09-18', '2026-09-22'];
const slots = (d: string) => JSON.stringify({ _time: dayOf(d) === 'Tuesday' ? '17:00 - 19:00' : '21:00 - 23:00', _total: 12 });
const sessions: Row[] = [
  ...PAST.map((d) => ({ id: d, day: dayOf(d), session_date: d, capacity: d === '2026-09-18' ? 8 : 12, status: 'closed', location: 'JCC', bike_slots: slots(d), created_at: 1 })),
  { id: '2026-09-19-soc', day: 'Saturday', session_date: '2026-09-19', capacity: 20, spots: 20, status: 'closed', location: 'Corniche', event_kind: 'community', bike_slots: slots('2026-09-19'), created_at: 1 },
  { id: TODAY, day: dayOf(TODAY), session_date: TODAY, capacity: 12, status: 'open', location: 'JCC', bike_slots: slots(TODAY), created_at: 1 },
  { id: addDays(TODAY, 2), day: dayOf(addDays(TODAY, 2)), session_date: addDays(TODAY, 2), capacity: 12, status: 'open', location: 'JCC', bike_slots: slots(addDays(TODAY, 2)), created_at: 1 },
];

const FEEDBACK = ['Great route along the water, the pace suited everyone.', 'Gears slipped a little on the climb.', 'Staff were friendly and quick at check-in.', 'Too hot tonight, but fun.'];
const REASONS = ['plans', 'work', 'unwell', 'weather', 'other'];
const RATE = ['route', 'pace', 'bike', 'staff', 'safety', 'fun'];
const queue_entries: Row[] = [];
let n = 0;
function entry(sess: Row, over: Row): Row {
  n++;
  const d = String(sess.session_date);
  return {
    id: 'q' + String(n).padStart(4, '0'), session_id: sess.id, session_day: sess.day, session_date: d, queue_num: n,
    status: 'done', paid: true, price: 80, type_preference: 'Hybrid', registered_at: addDays(d, -3) + 'T10:00:00Z', ...over,
  };
}
for (const s of sessions) {
  const d = String(s.session_date);
  const isToday = d === TODAY, ahead = d > TODAY, social = s.event_kind === 'community';
  const count = ahead ? 7 : isToday ? 9 : social ? 12 : d === '2026-09-18' ? 9 : int(5, 11);
  const hourUtc = dayOf(d) === 'Tuesday' ? 14 : 18;
  for (let i = 0; i < count; i++) {
    const cust = chance(0.85) ? pick(customers) : null;
    const type = pick(['Road', 'Road', 'Hybrid', 'Hybrid', 'Hybrid', 'Mountain', 'Any'] as const);
    let status = ahead ? 'waiting' : isToday ? pick(['done', 'done', 'active', 'active', 'waiting'] as const)
      : pick(['done', 'done', 'done', 'done', 'done', 'done', 'noshow', 'cancelled', 'removed', 'done'] as const);
    if (d === '2026-09-18' && (status === 'cancelled' || status === 'removed')) status = 'done'; // the sold-out night
    const rode = status === 'done' || status === 'active';
    const bikeType = type === 'Any' ? pick(['Road', 'Hybrid', 'Mountain'] as const) : type;
    const bike = rode ? pick(byType[bikeType]) : null;
    const inAt = rode ? `${d}T${String(hourUtc).padStart(2, '0')}:${String(int(0, 40)).padStart(2, '0')}:00Z` : null;
    const dur = status === 'done' && chance(0.75) ? int(12, 95) : null;
    const rated = status === 'done' && chance(0.55);
    const low = bike === 'b03'; // one bike the riders do not like
    const o: Row = {
      name: cust ? cust.name : pick(['Walk-in Rider', 'Guest Rider', 'Visitor']), phone: cust ? cust.phone : null, customer_id: cust ? cust.id : null,
      status, type_preference: type, price: social ? 0 : pick([60, 80, 80, 100]),
      paid: social ? true : status === 'done' ? chance(0.85) : status === 'active' ? chance(0.7) : status === 'noshow' ? chance(0.4) : ahead ? chance(0.5) : false,
      height: chance(0.8) ? int(148, 198) : null,
      assigned_bike_id: bike, checked_in_at: inAt, ride_duration: dur,
      checked_out_at: status === 'done' && dur == null && chance(0.5) ? `${d}T${String(hourUtc + 1).padStart(2, '0')}:${String(int(0, 50)).padStart(2, '0')}:00Z` : null,
      rating_bike: rated ? (low ? int(2, 4) : int(5, 10)) : null, rating_exp: rated ? int(3, 10) : null,
      rating_tags: rated && chance(0.6) ? RATE.filter(() => chance(0.35)) : [],
      feedback: rated && chance(0.4) ? pick(FEEDBACK) : null,
      promo_code: chance(0.15) ? pick(['SUMMER10', 'RIDE20', 'WELCOME']) : null,
      addons: rode && chance(0.3) ? JSON.stringify([{ id: pick(['i1', 'i2', 'i3', 'i4']), qty: int(1, 2) }]) : null,
      purchases: rode && chance(0.15) ? JSON.stringify([{ id: 'i1', name: 'Energy Gel', cat: 'EnergyGels', qty: 1, price: 12, pay: chance(0.3) ? 'team' : 'paid', team: 'Ali Alotaibi' }]) : null,
      pay_method: chance(0.4) ? 'card' : 'cash',
      approval: social ? (chance(0.85) ? 'approved' : 'pending') : null,
    };
    if (status === 'cancelled') {
      o.cancel_reason = pick(REASONS);
      o.cancelled_by = chance(0.3) ? 'staff' : 'customer';
      if (o.cancel_reason === 'other') o.cancel_note = pick(['Car broke down', 'Family visit', 'Exams this week']);
    }
    queue_entries.push(entry(s, o));
  }
}
// Every bike has been out at least once, so the all-time idle list is empty.
for (const b of bikes.filter((x) => x.status !== 'retired')) {
  queue_entries.push(entry(sessions[2], { name: 'Omar Alharbi', customer_id: 'c01', phone: customers[0].phone, type_preference: b.type, assigned_bike_id: b.id, checked_in_at: '2026-01-09T18:05:00Z', ride_duration: 40, height: 176 }));
}

// Till receipts in September: pairs on one receipt, a card split, a team tab, a refund, a discount.
const cashier_sales: Row[] = [];
let k = 0;
const sale = (sid: string, rid: string, o: Row) => cashier_sales.push({ id: 'x' + ++k, receipt_id: rid, session_id: sid, qty: 1, pay: 'paid', created_at: sid + 'T19:00:00Z', ...o });
for (const sid of ['2026-09-04', '2026-09-11', '2026-09-15', '2026-09-18', '2026-09-22', TODAY]) {
  sale(sid, sid + '-a', { name: 'Energy Gel', category: 'EnergyGels', price: 12, qty: 2, item_id: 'i1' });
  sale(sid, sid + '-a', { name: 'Still Water', category: 'Drinks', price: 8, item_id: 'i2' });
  sale(sid, sid + '-a', { name: '', category: '__cardmeta__', price: 20, qty: 0 });
  sale(sid, sid + '-b', { name: 'Protein Bar', category: 'ProteinSnacks', price: 15, item_id: 'i3' });
  sale(sid, sid + '-b', { name: 'Still Water', category: 'Drinks', price: 8, item_id: 'i2' });
  sale(sid, sid + '-c', { name: 'Energy Gel', category: 'EnergyGels', price: 12, pay: 'pending', item_id: 'i1' });
}
sale('2026-09-11', 't1', { name: 'Protein Bar', category: 'ProteinSnacks', price: 15, pay: 'team', team_name: 'Ali Alotaibi', item_id: 'i3' });
sale('2026-09-18', 't2', { name: 'Still Water', category: 'Drinks', price: 8, qty: 3, pay: 'team', team_name: 'Dana Alshehri', item_id: 'i2' });
sale('2026-09-15', 'r1', { name: 'Energy Gel', category: 'EnergyGels', price: 12, pay: 'refunded', item_id: 'i1' });
sale('2026-09-22', 'd1', { name: 'Discount', category: '__discount__', price: -5 });

const FIX = { sessions, queue_entries, bikes, customers, inventory, cashier_sales, promo_codes: [{ id: 'p1', code: 'SUMMER10', kind: 'percent', value: 10, active: true }] };
const WEATHER = { at: NOW, w: Object.fromEntries([...PAST, '2026-09-19', TODAY].map((d, i) => [d, 31 + ((i * 7) % 11)])) };

const VIEWS = ['overview', 'revenue', 'ridership', 'operations', 'fleet', 'ratings', 'customers', 'growth'];
// all: every night; range: September so far (the date inputs, the arrows against the weeks before,
// the idle list); empty: a month with no rides (every empty state).
const SCENARIOS: Record<string, { setup: string; target: number }> = {
  all: { setup: "S.analyticsRange='all';", target: 5000 },
  range: { setup: "S.analyticsRange='daterange';S.analyticsDateFrom='2026-09-01';S.analyticsDateTo='2026-09-24';", target: 400 },
  empty: { setup: "S.analyticsRange='daterange';S.analyticsDateFrom='2026-06-01';S.analyticsDateTo='2026-06-30';", target: 0 },
};
const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function settle(page: Page) {
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await document.fonts.ready;
    // lazy images off screen never load: those are not waited for
    await Promise.all([...document.images].filter((i) => !i.complete && i.loading !== 'lazy').map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await document.fonts.ready;
  });
}

async function open(page: Page, lang: string, target: number) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, FIX);
  await unlockStaff(page);
  await page.addInitScript((a) => {
    localStorage.setItem('cq_lang', a.lang);
    localStorage.setItem('cq_lang_pick', '1');
    localStorage.setItem('cq_weather', JSON.stringify(a.weather));
    if (a.target) localStorage.setItem('cq_an_rev_target', String(a.target));
  }, { lang, weather: WEATHER, target });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, lang);
  // An off-screen .chart-card skips its paint (content-visibility:auto), and a full-page shot would
  // show its 240px placeholder. Drawn as it is on screen: layout, style and paint containment.
  await page.addStyleTag({ content: '.chart-card{content-visibility:visible!important;contain:layout style paint!important}' });
  await page.evaluate("setStaffTab('analytics')");
}

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:analytics ${vpName}`, () => {
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      for (const [sc, cfg] of Object.entries(SCENARIOS)) {
        test(`${sc} ${lang}`, async ({ page }) => {
          await open(page, lang, cfg.target);
          for (const v of VIEWS) {
            await page.evaluate(`${cfg.setup}S.anSession='all';S.anView='${v}';renderAnalytics();window.scrollTo(0,0);`);
            await settle(page);
            await expect.soft(page).toHaveScreenshot(`analytics-${vpName}-${lang}-${sc}-${v}.png`, { fullPage: true });
          }
        });
      }
    }
  });
}
