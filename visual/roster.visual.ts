import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

declare const _langLoaded: (l: string) => boolean; // app globals
declare const S: Record<string, unknown> & { view: string; dataLoaded: boolean };
declare const sb: unknown;
declare const _lastLoadOk: boolean | undefined;
declare const _refsLoaded: boolean | undefined;
declare function renderStaffQueue(): void;
declare function setStaffTab(tab: string): void;
declare function showWlAddModal(): void;
declare function closeWlAddModal(): void;

// The roster pass of the inline-style move (playwright.visual.config.ts says how to run it): the
// staff Bookings roster - the view pills, the header (the print button, the day sheet, the reset
// tool, the approval ride's bulk approve and publish), the session strip with its fill bars, the
// forecast and the Petromin chip, the stat chips and the overdue banner, the cancellation log, the
// table rows in every state (waiting, reserved, to reserve, waitlisted, on a bike with one bike or
// two and on time or overdue, done, no-show, cancelled, a party folded and open, a flash in each
// colour, an approval ride's pending, rejected and approved rows, a Petromin night, a workshop,
// kids, own bike, on the house, a duplicate phone, the no-show flags), the selection bar, the empty
// roster, the all-sessions view with its headers and Show more, the phone cards for the same; the
// Staff List (managed waitlist) with walk-ups, parked bookings, a party, its picker and empty
// states, and its Add dialog; and History's rows, which draw the same contact cell and no-show
// flag. Every state is a screenshot and a hash of the computed style of every element on the page
// (cascade-audit.ts), in English and Arabic, at 1280x900 and 390x844, from fixed data on a frozen
// clock. The switches are pass2.visual.ts's: AUDIT=inline, AUDIT=class with AUDIT_CLASSES,
// MIN_CSS=1, CSS_DUMP; RQ_COVER=1 writes the rq- classes each state draws to <VISUAL_SNAPS>/_cover.
// The last test turns the real policy on with style-src 'self' (no 'unsafe-inline') and fails on
// any refused style attribute drawn by this area.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
const FRI = '2026-09-25', SAT = '2026-09-26', PM = '2026-09-27', WS = '2026-09-28', PAST = '2026-09-17';
const SNAPS = process.env.VISUAL_SNAPS || join(tmpdir(), 'mm-visual-snaps');
const CLASSES = process.env.AUDIT_CLASSES ? readFileSync(process.env.AUDIT_CLASSES, 'utf8').split(/\s+/).filter(Boolean) : [];

type Row = Record<string, unknown>;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOf = (d: string) => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
const js = (o: unknown) => JSON.stringify(o);
const tot = (time: string, n: number, extra: Row = {}) => js({ _time: time, _total: n, ...extra });
const sess = (d: string, o: Row) => ({ id: d, day: dayOf(d), session_date: d, capacity: 12, status: 'open', location: 'JCC', bike_slots: tot('21:00 - 23:00', 12), created_at: 1, ...o });
const COMM = { event_kind: 'community' };
const sessions = [
  sess(PAST, { status: 'closed' }),
  sess(TODAY, { capacity: 40, bike_slots: tot('21:00 - 23:00', 40), addons: js(['i1', 'i2']) }),
  sess(FRI, { capacity: 6, bike_slots: tot('19:00 - 21:00', 6) }), // 5 of 6: the amber bar
  sess(SAT, { ...COMM, needs_approval: true, spots: 20, capacity: 20, bike_slots: js({ _time: '06:30 - 07:00' }) }),
  sess(PM, { ...COMM, ride_kind: 'petromin', paid_ride: true, needs_approval: true, title: 'Petromin Night', spots: 2, capacity: 2, bike_slots: tot('20:00 - 22:00', 2) }), // full: the red bar
  sess(WS, { ...COMM, ride_kind: 'workshop', needs_approval: true, spots: 12, capacity: 12, title: 'T100 Triathlon Prep', bike_slots: js({ _time: '18:00 - 20:00' }) }),
];
const bikes = [
  { id: 'b01', name: 'Road 1', type: 'Road', size: 'M', status: 'in-use', brand: 'Alvas', model: 'Climax', bike_number: 1, colors: ['#111111', '#ee3333'] },
  { id: 'b02', name: 'Hybrid 1', type: 'Hybrid', size: 'L', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 2, colors: ['#00aa00'] },
  { id: 'b03', name: 'Mountain 1', type: 'Mountain', size: 'M', status: 'in-use', brand: 'Alvas', model: 'Strom M50', bike_number: 3, colors: ['#555555'] },
  { id: 'b04', name: 'Road 2', type: 'Road', size: 'S', status: 'maintenance', brand: 'Alvas', model: 'DA54', bike_number: 4, colors: ['#cc0000'] },
  { id: 'b05', name: 'Kids 1', type: 'Kids', size: 'XS', status: 'in-use', brand: 'Alvas', model: 'Beta', bike_number: 5 },
  { id: 'b06', name: 'Hybrid 2', type: 'Hybrid', size: 'M', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 6, colors: ['#0000cc', '#ffffff'] },
  { id: 'b07', name: 'Road 3', type: 'Road', size: 'L', status: 'in-use', brand: 'Giant', model: 'Contend', bike_number: 7, colors: ['#222288'] },
];
const cust = (id: string, name: string, phone: string, o: Row = {}) => ({ id, name, email: id + '@example.test', phone, gender: 'female', birth_date: '1990-05-05', country: 'Saudi Arabia', city: 'Jeddah', height: 170, type_preference: 'Road', created_at: '2026-08-20T10:00:00Z', ...o });
const customers = [
  cust('c1', 'Sara Ali', '0551234567', { height: 165 }),
  cust('c2', 'Omar Hassan', '0551234568', { gender: 'male', height: 180 }),
  cust('c3', 'Cara Vale', '0551234569'),
  cust('c4', 'Majed Rider', '0551234570', { gender: 'male' }),
  cust('c5', 'Dana Reyes', '0551234571'),
];
const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#00e585', locked: true }];
const customer_tags = [{ customer_id: 'c1', tag_id: 'tag_saturday', added_at: NOW - 30 * 864e5, expires_at: null, starts_at: null }];
const q = (id: string, n: number, sid: string, o: Row) => ({
  id, session_id: sid, session_day: dayOf(sid), session_date: sid, queue_num: n, status: 'waiting', paid: false, price: 80,
  type_preference: 'Hybrid', size: 'M', height: 172, phone: '05500000' + String(n).padStart(2, '0'), registered_at: '2026-09-15T10:00:00Z', ...o,
});
const G1 = { group_id: 'g1', group_name: 'Tamer Group of Friends', group_contact: 'Tamer Aziz the organiser', group_phone: '0551112222' };
const queue_entries = [
  // Past nights: the no-shows behind the flags (Cara three, Dana two) and a ride each
  ...[1, 2, 3].map((i) => q('pc' + i, 10 + i, PAST, { name: 'Cara Vale', customer_id: 'c3', status: 'noshow', registered_at: `2026-09-1${i}T10:00:00Z` })),
  ...[1, 2].map((i) => q('pd' + i, 20 + i, PAST, { name: 'Dana Reyes', customer_id: 'c5', phone: '0551234571', status: 'noshow', registered_at: `2026-09-1${i}T11:00:00Z` })),
  q('pd3', 23, PAST, { name: 'Dana Reyes', customer_id: 'c5', phone: '0551234571', status: 'done', paid: true, registered_at: '2026-09-14T11:00:00Z' }),
  // Tonight
  q('t01', 1, TODAY, { name: 'Sara Ali', customer_id: 'c1', phone: '0551234567', status: 'active', paid: true, assigned_bike_id: 'b01', type_preference: 'Road', height: 165, checked_in_at: '2026-09-24T15:00:00Z' }), // overdue
  q('t02', 2, TODAY, { name: 'Omar Hassan', customer_id: 'c2', phone: '0551234568', height: 180, addons: js([{ id: 'i1', qty: 2 }, 'i2']) }),
  q('t03', 3, TODAY, { name: 'Walk-in Rider', walk_in: true, to_reserve: true, type_preference: 'Road' }),
  q('t04', 4, TODAY, { name: 'Reem Salem', assigned_bike_id: 'b02', paid: true }), // a bike held for her
  q('t05', 5, TODAY, { name: 'Tariq Noor', status: 'waitlist', waitlist_num: 1 }),
  q('t06', 6, TODAY, { ...G1, name: 'Tamer Aziz', status: 'active', paid: true, assigned_bike_id: js(['b03', 'b07']), type_preference: 'Mountain', checked_in_at: '2026-09-24T17:00:00Z' }),
  q('t07', 7, TODAY, { ...G1, name: 'Layla Aziz', paid: true, type_preference: 'Road', height: 160 }),
  q('t08', 8, TODAY, { ...G1, name: 'Zaid Aziz', type_preference: 'Kids', size: 'XS', height: 120, price: 40, addons: js(['i1']) }),
  q('t09', 9, TODAY, { name: 'Cara Vale', customer_id: 'c3', phone: '0551234569' }),
  q('t10', 10, TODAY, { name: 'Cara Junior', customer_id: 'c3', phone: '', type_preference: 'Kids', size: 'XS', height: 118, price: 40 }),
  q('t11', 11, TODAY, { name: 'Jana Rider', phone: '0551234568' }), // Omar's phone on another booking
  q('t12', 12, TODAY, { name: 'Hamad Own', type_preference: 'Own', price: 0 }),
  q('t13', 13, TODAY, { name: 'Rana House', paid: true, price: 0 }),
  q('t14', 14, TODAY, { name: 'Majed Rider', customer_id: 'c4', phone: null }), // the account's phone stands in
  q('t15', 15, TODAY, { name: 'Faisal Kid', status: 'active', paid: false, assigned_bike_id: 'b05', type_preference: 'Kids', size: 'XS', height: 125, price: 40, checked_in_at: '2026-09-24T17:10:00Z' }),
  q('t16', 16, TODAY, { name: 'Noura Done', status: 'done', paid: true, ride_duration: 80, checked_in_at: '2026-09-24T15:30:00Z', checked_out_at: '2026-09-24T16:50:00Z' }),
  q('t17', 17, TODAY, { name: 'Ali Done', status: 'done', paid: false, ride_duration: 60 }),
  q('t18', 18, TODAY, { name: 'Huda Noshow', status: 'noshow' }),
  q('t19', 19, TODAY, { name: 'Lina Cancelled', status: 'cancelled', cancelled_by: 'customer', cancel_reason: 'weather' }),
  q('t20', 20, TODAY, { name: 'Salem Other', status: 'cancelled', cancelled_by: 'customer', cancel_reason: 'other', cancel_note: 'Flat tyre on my car' }),
  // Friday: five of six places
  ...[1, 2, 3, 4, 5].map((i) => q('f' + i, i, FRI, { name: 'Friday Rider ' + i })),
  // The Saturday approval ride (free): approved, pending, rejected, waitlisted, a party, own bike
  q('s1', 1, SAT, { name: 'Sara Ali', customer_id: 'c1', phone: '0551234567', approval: 'approved', price: 0, registered_at: '2026-09-20T08:01:00Z' }),
  q('s2', 2, SAT, { name: 'Dana Reyes', customer_id: 'c5', phone: '0551234571', approval: 'pending', price: 0, registered_at: '2026-09-20T08:05:00Z' }),
  q('s3', 3, SAT, { name: 'Rejected Rider', approval: 'rejected', price: 0, registered_at: '2026-09-20T08:09:00Z' }),
  q('s4', 4, SAT, { name: 'Waiting List', status: 'waitlist', waitlist_num: 1, approval: 'pending', price: 0, registered_at: '2026-09-20T08:15:00Z' }),
  q('s5', 5, SAT, { group_id: 'g2', group_name: 'Sat Pair', name: 'Pair One', approval: 'approved', price: 0, registered_at: '2026-09-20T08:20:00Z' }),
  q('s6', 6, SAT, { group_id: 'g2', group_name: 'Sat Pair', name: 'Pair Two', approval: 'approved', price: 0, registered_at: '2026-09-20T08:21:00Z' }),
  q('s7', 7, SAT, { name: 'Own Bike Rider', approval: 'approved', type_preference: 'Own', price: 0, registered_at: '2026-09-20T08:30:00Z' }),
  // The Petromin night (paid), full
  q('p1', 1, PM, { name: 'Petro One', approval: 'approved', price: 50, paid: true }),
  q('p2', 2, PM, { name: 'Petro Two', approval: 'approved', price: 50 }),
  // The workshop
  q('w1', 1, WS, { name: 'Workshop Rider', approval: 'approved', price: 0 }),
];
const inventory = [
  { id: 'i1', name: 'Water', brand: 'Nova', category: 'Drinks', qty: 30, price: 5, addon: true },
  { id: 'i2', name: 'Energy bar', category: 'Snacks', qty: 12, price: 8, addon: true },
];
const reg = (id: number, no: string, name: string, o: Row = {}) => ({
  id, session_id: PM, booking_no: no, badge: 'B' + id, name, phone: '+96650000000' + id, type_preference: 'Hybrid', source: 'petromin', company: 'Petromin',
  created_at: '2026-09-20T09:00:00Z', updated_at: '2026-09-20T09:00:00Z', height: 175, party_no: 1, submissions: 1, match_kind: 'none', matched_entry_id: null,
  matched_customer_id: null, checked_in_at: null, checked_out_at: null, price: 50, ...o,
});
const rider_registrations = [
  reg(1, 'P-001', 'Form Rider One', { checked_in_at: '2026-09-24T16:00:00Z' }),
  reg(2, 'P-002', 'Form Rider Two', { checked_in_at: '2026-09-24T15:00:00Z', checked_out_at: '2026-09-24T16:30:00Z' }),
  reg(3, 'P-003', 'Form Rider Three'),
];
const dw = (id: string, o: Row) => ({ id, kind: 'managed', status: 'waiting', paid: false, created_at: '2026-09-24T16:00:00Z', ...o });
const desk_waitlist = [
  dw('d1', { name: 'Walk Up One', phone: '0557776666', bike_type: 'Road', sort_order: 1 }),
  dw('d2', { name: 'Tariq Noor', booking_id: 't05', bike_type: 'Hybrid', sort_order: 2 }),
  dw('d3', { name: 'Walk-in Rider', booking_id: 't03', bike_type: 'Road', sort_order: 3 }),
  dw('d4', { name: 'Cara Vale', booking_id: 't09', bike_type: 'Hybrid', sort_order: 4 }),
  dw('d5', { name: 'Cara Junior', booking_id: 't10', bike_type: 'Kids', sort_order: 5 }),
  dw('d6', { name: 'Walk Up Two', bike_type: 'Hybrid', paid: true, price: 0, sort_order: 6 }),
];
const FIX = { sessions, bikes, customers, tags, customer_tags, queue_entries, inventory, rider_registrations, desk_waitlist };
// The strip's forecast, from the cache the app reads first (fresh: the clock is frozen at NOW)
const WX = { at: NOW, d: { [TODAY]: { t: 43, w: 12 }, [FRI]: { t: 35, w: 31 }, [SAT]: { t: 33, w: 10 }, [PM]: { t: 38, w: 20 } } };

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function settle(page: Page) {
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await document.fonts.ready;
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => { (i as HTMLImageElement).loading = 'eager'; });
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
    await document.fonts.ready;
  });
}
async function minCss(page: Page) {
  if (!process.env.MIN_CSS) return;
  await page.route(/\/styles\.css/, async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, body: new CleanCSS({ level: 1 }).minify(await res.text()).styles });
  });
}
type Open = { lang: string; fx?: Record<string, unknown> };
async function open(page: Page, o: Open) {
  await page.clock.setFixedTime(NOW);
  await minCss(page);
  await stubSupabase(page, { ...FIX, ...(o.fx || {}) });
  await unlockStaff(page);
  await page.addInitScript(([lang, wx]) => {
    localStorage.setItem('cq_lang', lang as string);
    localStorage.setItem('cq_lang_pick', '1');
    localStorage.setItem('cq_weather_fc', wx as string);
    try { sessionStorage.removeItem('cq_queue_view'); } catch { /* none */ }
  }, [o.lang, js(WX)]);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, o.lang);
  await page.waitForFunction(`S.view==='staff'`);
  await page.waitForFunction(`getComputedStyle(document.getElementById('loading-screen')).display==='none'`);
  // the refresh label moves on its own; a scroll-into-view is instant, so a shot never catches one halfway
  await page.evaluate(`window._tickRefreshLabel=function(){};window._sb=function(){return 'auto'}`);
}
async function quiet(page: Page) {
  await page.evaluate(() => new Promise<void>((res) => {
    let t = 0;
    const done = () => { obs.disconnect(); res(); };
    const obs = new MutationObserver(() => { clearTimeout(t); t = window.setTimeout(done, 250); });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    t = window.setTimeout(done, 250);
    window.setTimeout(done, 3000);
  }));
}

const audits: Record<string, AuditRow[]> = {};
async function shot(page: Page, name: string, o: { full?: boolean } = {}) {
  await quiet(page);
  await settle(page);
  await expect.soft(page).toHaveScreenshot(name + '.png', { fullPage: o.full !== false, timeout: 30000 });
  // Taking the screenshot flips (max-width:767px) and back for a moment, and Bookings redraws on
  // that change (renderStaffQueue); the sortable headers arrive 80 ms after a redraw. Wait again.
  await quiet(page);
  const hashes = await page.evaluate(styleHashes, { roots: ['body'], ignore: '^--rq-', stripOrigin: true }); // this pass's data-cssv properties, and any port
  if (process.env.CSS_DUMP) {
    mkdirSync(join(SNAPS, '_dump'), { recursive: true });
    writeFileSync(join(SNAPS, '_dump', `${name}-${Date.now()}.json`), JSON.stringify(await page.evaluate(styleOf, process.env.CSS_DUMP), null, 1));
  }
  expect.soft(JSON.stringify(hashes, null, 0).replace(/","/g, '",\n"')).toMatchSnapshot(name + '.css.txt');
  if (process.env.RQ_COVER) { // which of this pass's classes each state draws (to show every one is covered)
    mkdirSync(join(SNAPS, '_cover'), { recursive: true });
    writeFileSync(join(SNAPS, '_cover', name + '.txt'), (await page.evaluate(() => [...new Set([...document.querySelectorAll('[class*="rq-"]')].flatMap((e) => [...e.classList].filter((c) => c.startsWith('rq-'))))].join('\n'))));
  }
  const mode = process.env.AUDIT;
  if (mode === 'inline' || mode === 'class') {
    const rows = await page.evaluate(cascadeAudit, { roots: ['body'], classes: CLASSES, inline: mode === 'inline' });
    if (mode === 'inline') audits[name] = rows;
    else expect.soft(rows.filter((r) => r.hits.length), name).toEqual([]);
  }
}
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  if (process.env.AUDIT !== 'inline' || !Object.keys(audits).length) return;
  mkdirSync(join(SNAPS, '_audit'), { recursive: true });
  writeFileSync(join(SNAPS, '_audit', info.title.replace(/\W+/g, '_') + '-' + info.project.name + '-' + info.workerIndex + '-' + Date.now() + '.json'), JSON.stringify(audits, null, 1));
  for (const k of Object.keys(audits)) delete audits[k];
});
// Each evaluate draws a state; the page goes back to the top so a full-page shot starts there.
const draw = (page: Page, code: string) => page.evaluate(code + ';window.scrollTo(0,0)');
const Q = (sid: string, extra = '') => `S.queueView='bookings';S.sfSession='${sid}';S._sfPicked=true;S._sfDefaulted=true;S.sfStatus='all';S.sfSearch='';S.sfSelected=[];S._partyOpen=new Set();S._partyExpandAll=false;S.sfShowFinished=false;S.cancellationLog=[];S.showResetTool=false;S.queueDensity='comfortable';S._flashId=null;S.sfLimit=150;${extra}renderStaffQueue()`;
const toQueue = async (page: Page) => {
  await page.evaluate(`setStaffTab('queue')`);
  await page.waitForFunction(`!!document.getElementById('q-results')&&S.ridersLoaded===true`);
};
const PARTIES = `new Set(['g:g1|${TODAY}','c:c3|${TODAY}'])`;

test.describe.configure({ timeout: 300000 }); // a loaded machine runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:roster ${vpName}`, () => {
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`tonight ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await toQueue(page);
        await draw(page, Q(TODAY));
        await shot(page, `${P}-rq-tonight`);
        await draw(page, Q(TODAY, `S._partyOpen=${PARTIES};`));
        await shot(page, `${P}-rq-parties-open`);
        await draw(page, Q(TODAY, `S._partyExpandAll=true;S.sfShowFinished=true;`));
        await shot(page, `${P}-rq-expand-all-finished`);
        await draw(page, Q(TODAY, `S.sfStatus='cancelled';`));
        await shot(page, `${P}-rq-cancelled`);
        await draw(page, Q(TODAY, `S.sfSelected=['t02','t15','t07'];`));
        await shot(page, `${P}-rq-selected`, { full: false });
        await draw(page, Q(TODAY, `S.cancellationLog=[{entryId:'t19',queueNum:19,name:'Lina Cancelled',session:'Thursday 24 Sep',reason:'The weather (heat, wind or dust)',timestamp:${NOW - 60000}},{entryId:'t20',queueNum:20,name:'Salem Other',session:'Thursday 24 Sep',timestamp:${NOW - 120000}}];S.showResetTool=true;`));
        await shot(page, `${P}-rq-cancel-log-reset`);
        await draw(page, Q(TODAY, `S.sfSearch='zzzz';`));
        await shot(page, `${P}-rq-empty`);
        if (vpName === 'desktop') {
          await draw(page, Q(TODAY, `S.queueDensity='compact';S._partyOpen=${PARTIES};`));
          await shot(page, `${P}-rq-compact`);
          await draw(page, Q(TODAY));
          await quiet(page);
          await page.locator('#q-results a[href^="tel:"]').first().hover();
          await shot(page, `${P}-rq-hover-tel`, { full: false });
          await page.locator('#tab-queue [data-on-click*="showPrintReportOptions"]').hover();
          await shot(page, `${P}-rq-hover-print`, { full: false });
          await page.mouse.move(0, 0);
          await shot(page, `${P}-rq-hover-out`, { full: false }); // mouseout wrote the CSSOM values back
          for (const [c, id] of [['orange', 't02'], ['blue', 't07'], ['green', 't15']] as const) {
            await draw(page, Q(TODAY, `S._partyOpen=${PARTIES};S._flashId='${id}';S._flashColor='${c}';`));
            await shot(page, `${P}-rq-flash-${c}`, { full: false });
          }
        }
        // A stat chip in a colour the roster never passes (the green ones drawn blue): its fallback
        await draw(page, `window._statChip0=window._statChip0||_statChip;window._statChip=(n,l,c,...r)=>_statChip0(n,l,c==='var(--green)'?'var(--blue)':c,...r);` + Q(TODAY));
        await shot(page, `${P}-rq-chip-colour`, { full: false });
      });

      test(`all sessions ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await toQueue(page);
        await draw(page, Q('all'));
        await shot(page, `${P}-rq-all`);
        await draw(page, Q('all', `S.sfLimit=4;`));
        await shot(page, `${P}-rq-all-more`);
      });

      test(`approval ride ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await toQueue(page);
        await draw(page, Q(SAT));
        await shot(page, `${P}-rq-appr`);
        await draw(page, `allSessions().find(s=>s.id==='${SAT}').hide_queue=false;` + Q(SAT));
        await shot(page, `${P}-rq-appr-published`);
      });

      test(`petromin and workshop ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await toQueue(page);
        await draw(page, Q(PM));
        await shot(page, `${P}-rq-pm`);
        await draw(page, Q(WS));
        await shot(page, `${P}-rq-ws`);
        await draw(page, Q(FRI));
        await shot(page, `${P}-rq-fri`);
        await draw(page, `S.queueView='petromin';S.ridersSession='${PM}';renderStaffQueue()`);
        await page.waitForFunction(`!!document.querySelector('#pm-host')`);
        await shot(page, `${P}-rq-pm-page`);
      });

      test(`staff list ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await toQueue(page);
        await draw(page, `S.queueView='managed';S._mwSess='all';S._mwQ='';S._mwShowAll=false;renderStaffQueue()`);
        await page.waitForFunction(`!!document.getElementById('mw-list')`);
        await shot(page, `${P}-mw-list`);
        await draw(page, `S._mwShowAll=true;renderStaffQueue()`);
        await shot(page, `${P}-mw-browse`);
        await draw(page, `S._mwShowAll=false;S._mwSess='${SAT}';renderStaffQueue()`);
        await shot(page, `${P}-mw-empty-sess`);
        await draw(page, `S._mwSess='all';S.deskWaitlist=[];renderStaffQueue()`);
        await shot(page, `${P}-mw-empty`);
        // a folded-in row (_virtual) makes its card undraggable
        await draw(page, `S.deskWaitlist=[{id:'v1',kind:'managed',status:'waiting',name:'Tariq Noor',booking_id:'t05',bike_type:'Hybrid',paid:false,_virtual:true,created_at:'2026-09-24T16:00:00Z'}];renderStaffQueue()`);
        await shot(page, `${P}-mw-virtual`);
        await page.evaluate(`S._wlType='Any';S._wlExtra=[];showWlAddModal()`);
        await shot(page, `${P}-wl-add`, { full: false });
        await page.evaluate(`S._wlType='Road';S._wlExtra=[{name:'Second Rider',type:'Road'},{name:'',type:'Any'}];showWlAddModal()`);
        await shot(page, `${P}-wl-add-extra`, { full: false });
        await page.evaluate(`closeWlAddModal()`);
      });

      test(`history rows ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`setStaffTab('history')`);
        await page.waitForFunction(`!!document.querySelector('#tab-history .queue-table')`);
        await draw(page, `renderHistory()`);
        await shot(page, `${P}-rq-history`);
      });
    }
  });
}

// ── The strict policy ────────────────────────────────────────────────────────────────────────
// The page's own policy with style-src 'self' (no 'unsafe-inline'; 'report-sample' only names the
// refused text): every screen above, drawn with function-form calls (a string-form evaluate is
// eval, which the policy forbids), and no style attribute refused inside this area.
type W = Window & { __cspv: { dir: string; sample: string; where: string; html: string }[] };
test.describe('@visual:roster strict policy', () => {
  test.use({ bypassCSP: false, viewport: { width: 1280, height: 900 } });
  for (const phone of [false, true]) test(`nothing this area draws is refused${phone ? ' (phone)' : ''}`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.setFixedTime(NOW);
    await page.route((u) => u.pathname === '/' || u.pathname === '/index.html', async (r) => {
      const res = await r.fetch();
      const h = { ...res.headers() };
      const csp = h['content-security-policy'] || '';
      expect(csp).toMatch(/style-src 'self'/); expect(csp).not.toMatch(/style-src[^;]*'unsafe-inline'/); // Served this way since 2026-09-29: the page's own style-src has no 'unsafe-inline' left to take away.
      h['content-security-policy'] = csp.replace("style-src 'self' 'unsafe-inline'", "style-src 'self' 'report-sample'");
      await r.fulfill({ response: res, headers: h });
    });
    await page.addInitScript((wx) => {
      localStorage.setItem('cq_weather_fc', wx);
      (window as unknown as W).__cspv = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        const el = e.target instanceof Element ? e.target : null;
        const hosts = el ? [...(function* () { for (let n: Element | null = el; n; n = n.parentElement) if (n.id) yield n.id; })()].join('<') : '(document)';
        (window as unknown as W).__cspv.push({ dir: e.violatedDirective, sample: e.sample || '', where: hosts, html: el ? el.outerHTML.slice(0, 160) : '' });
      }, true);
    }, js(WX));
    await stubSupabase(page, FIX);
    await unlockStaff(page);
    await page.goto('/');
    await page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && !!S.dataLoaded
      && (typeof _lastLoadOk === 'undefined' || _lastLoadOk === true) && (typeof _refsLoaded === 'undefined' || _refsLoaded === true), undefined, { timeout: 15000 });
    await page.waitForFunction(() => S.view === 'staff' && S.ridersLoaded === true);
    await page.evaluate(() => { setStaffTab('queue'); });
    await page.waitForFunction(() => !!document.getElementById('q-results'));
    const reset = { queueView: 'bookings', _sfPicked: true, _sfDefaulted: true, sfStatus: 'all', sfSearch: '', sfSelected: [], _partyExpandAll: false, sfShowFinished: false, cancellationLog: [], showResetTool: false, queueDensity: 'comfortable', _flashId: null, sfLimit: 150 };
    const states: Record<string, unknown>[] = [
      { sfSession: TODAY }, { sfSession: TODAY, _partyOpenAll: true }, { sfSession: TODAY, _partyExpandAll: true, sfShowFinished: true },
      { sfSession: TODAY, sfStatus: 'cancelled' }, { sfSession: TODAY, sfSelected: ['t02', 't15', 't07'] },
      { sfSession: TODAY, showResetTool: true, cancellationLog: [{ entryId: 't19', queueNum: 19, name: 'Lina Cancelled', session: 'x', reason: 'Weather', timestamp: NOW - 60000 }, { entryId: 't20', queueNum: 20, name: 'Salem Other', session: 'x', timestamp: NOW - 60000 }] },
      { sfSession: TODAY, sfSearch: 'zzzz' }, { sfSession: TODAY, queueDensity: 'compact', _partyExpandAll: true },
      { sfSession: TODAY, _flashId: 't02', _flashColor: 'orange' }, { sfSession: TODAY, _partyExpandAll: true, _flashId: 't07', _flashColor: 'blue' },
      { sfSession: 'all' }, { sfSession: 'all', sfLimit: 4 }, { sfSession: SAT }, { sfSession: PM }, { sfSession: WS }, { sfSession: FRI },
    ];
    for (const st of states) {
      await page.evaluate(([r, s]) => {
        const o = { ...r, ...s } as Record<string, unknown>;
        if (o._partyOpenAll) { delete o._partyOpenAll; o._partyOpen = new Set(['g:g1|2026-09-24', 'c:c3|2026-09-24']); } else o._partyOpen = new Set();
        Object.assign(S, o);
        renderStaffQueue();
      }, [reset, st] as const);
      await page.waitForTimeout(120);
    }
    await page.evaluate((sid) => { const s = (S.sessions as { id: string; hide_queue?: boolean }[]).find((x) => x.id === sid); if (s) s.hide_queue = false; S.sfSession = sid; renderStaffQueue(); }, SAT);
    await page.waitForTimeout(120);
    await page.evaluate((sid) => { Object.assign(S, { queueView: 'petromin', ridersSession: sid }); renderStaffQueue(); }, PM);
    await page.waitForTimeout(200);
    for (const st of [{ _mwSess: 'all', _mwShowAll: false }, { _mwShowAll: true }, { _mwShowAll: false, _mwSess: SAT }]) {
      await page.evaluate((s) => { Object.assign(S, { queueView: 'managed' }, s); renderStaffQueue(); }, st);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => { Object.assign(S, { _wlType: 'Road', _wlExtra: [{ name: 'Second Rider', type: 'Road' }] }); showWlAddModal(); });
    await page.waitForTimeout(120);
    await page.evaluate(() => { closeWlAddModal(); setStaffTab('history'); });
    await page.waitForFunction(() => !!document.querySelector('#tab-history .queue-table'));
    await page.waitForTimeout(200);
    const all = await page.evaluate(() => (window as unknown as W).__cspv.slice());
    const style = all.filter((v) => /^style-src/.test(v.dir));
    // This area: the roster's shell and rows, the Staff List, its Add dialog, and History's rows (whose
    // contact cell and no-show flag are drawn here). The Petromin page's own list (#pm-host) is not.
    const mine = style.filter((v) => /(^|<)(tab-queue|wl-add-modal|tab-history)(<|$)/.test(v.where) && !/(^|<)(pm-host|ho-host|sess-host)(<|$)/.test(v.where));
    mkdirSync(join(SNAPS, '_csp'), { recursive: true });
    writeFileSync(join(SNAPS, '_csp', `strict${phone ? '-phone' : ''}-${Date.now()}.json`), JSON.stringify({ mine, other: style.filter((v) => !mine.includes(v)) }, null, 1));
    expect(mine).toEqual([]);
  });
});
