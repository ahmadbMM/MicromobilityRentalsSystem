import { test, expect, type Page, type Locator } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

declare const _langLoaded: (l: string) => boolean; // app global

// The third pass of the inline-style move (playwright.visual.config.ts says how to run it):
// History with its rides list, filters, selection, its own log panel and the receipt dialog; the
// Log view; Sessions - the list and its detail, the deleted group, the month view, the new-session
// form for every ride kind and bike mode, the templates, the edit form for every kind, the booking
// window card and the promo codes; the Dashboard with data and empty; and the undo-code dialog in
// each of its states. Every state is a screenshot and a hash of the computed style of every element
// on the page (cascade-audit.ts), in English and Arabic, at 1280x900 and 390x844, from fixed data
// on a frozen clock. The switches are pass2.visual.ts's: AUDIT=inline, AUDIT=class with
// AUDIT_CLASSES, MIN_CSS=1, CSS_DUMP. Take the baseline from the untouched build, run it twice (it
// must pass unchanged), then convert.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
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
  sess('2026-09-10', { status: 'deleted', bike_slots: tot('21:00 - 23:00', 10) }),
  sess('2026-09-12', { status: 'deleted', bike_slots: js({ _time: '17:00 - 19:00', Road: { XS: 0, S: 1, M: 2, L: 0, XL: 0 }, Hybrid: { XS: 0, S: 0, M: 1, L: 1, XL: 0 } }) }),
  sess('2026-09-17', { status: 'closed' }),
  sess('2026-09-19', { status: 'closed', ...COMM, needs_approval: true, spots: 10, capacity: 10, bike_slots: js({ _time: '06:30 - 07:00' }) }),
  sess('2026-09-22', { status: 'closed', bike_slots: js({ _time: '17:00 - 19:00', _collect: '16:20', Road: { XS: 0, S: 1, M: 2, L: 1, XL: 0 }, Hybrid: { XS: 0, S: 0, M: 2, L: 1, XL: 0 }, Mountain: { XS: 0, S: 0, M: 0, L: 0, XL: 0 }, Kids: { XS: 1, S: 0, M: 0, L: 0, XL: 0 } }) }),
  sess(TODAY, { capacity: 4, bike_slots: js({ _time: '21:00 - 23:00', _bikes: ['b01', 'b02', 'b03', 'b05'], _wl: { m: 'count', v: 3 } }), addons: js(['i1']) }),
  sess('2026-09-26', { status: 'full', ...COMM, needs_approval: true, spots: 10, capacity: 10, bike_slots: js({ _time: '06:30 - 07:00' }), meet_url: 'https://maps.example.test/a', breakfast_name: 'Cafe Sea', breakfast_url: 'https://example.test/cafe', addons: js(['i1', 'i2']) }),
  sess('2026-09-27', { ...COMM, ride_kind: 'petromin', paid_ride: true, needs_approval: true, title: 'Petromin Night', spots: 2, capacity: 2, bike_slots: tot('20:00 - 22:00', 2) }),
  sess('2026-09-30', { status: 'closed', ...COMM, ride_kind: 'swim', needs_approval: true, spots: 8, capacity: 8, title: 'Pool Session', bike_slots: js({ _time: '07:00 - 08:00' }) }),
  sess('2026-10-01', { ...COMM, ride_kind: 'workshop', needs_approval: true, spots: 12, capacity: 12, bike_slots: js({ _time: '18:00 - 20:00' }) }),
  sess('2026-10-02', { ride_kind: 'snd96', capacity: 20, title: 'National Day Ride', bike_slots: tot('06:00 - 08:00', 20, { _collect: '05:15' }) }),
  sess('2026-10-03', { ...COMM, ride_kind: 'event', needs_approval: true, spots: 30, capacity: 30, title: 'Bike Film Night', description: 'Short films about riding.', price: 25, open_to_all: true, bike_slots: js({ _time: '19:00 - 21:00' }) }),
];
const bikes = [
  { id: 'b01', name: 'Road 1', type: 'Road', size: 'M', status: 'in-use', brand: 'Alvas', model: 'Climax', bike_number: 1, colors: ['#111', '#e33'] },
  { id: 'b02', name: 'Hybrid 1', type: 'Hybrid', size: 'L', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 2, colors: ['#0a0'] },
  { id: 'b03', name: 'Mountain 1', type: 'Mountain', size: 'M', status: 'available', brand: 'Alvas', model: 'Strom M50', bike_number: 3, colors: ['#555'] },
  { id: 'b04', name: 'Road 2', type: 'Road', size: 'S', status: 'maintenance', brand: 'Alvas', model: 'DA54', bike_number: 4, colors: ['#c00'] },
  { id: 'b05', name: 'Road 3', type: 'Road', size: 'L', status: 'available', brand: 'Giant', model: 'Contend', bike_number: 5 },
  { id: 'b06', name: 'Hybrid 2', type: 'Hybrid', size: 'M', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 6, colors: ['#00c', '#fff'] },
];
const customers = [
  { id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567', gender: 'female', birth_date: '1990-05-05', country: 'Saudi Arabia', city: 'Jeddah', height: 165, type_preference: 'Road', created_at: '2026-08-20T10:00:00Z' },
  { id: 'c2', name: 'Omar Hassan', email: 'omar@example.test', phone: '0551234568', gender: 'male', birth_date: '1988-01-01', country: 'Saudi Arabia', city: 'Riyadh', height: 180, type_preference: 'Hybrid', created_at: '2025-01-05T10:00:00Z' },
  { id: 'c3', name: 'Cara Vale', email: 'cara@example.test', phone: '0551234569', gender: 'female', birth_date: '1975-01-01', country: 'United Kingdom', city: 'London', height: 170, type_preference: 'Mountain', created_at: '2026-09-01T10:00:00Z' },
];
const q = (id: string, n: number, sid: string, o: Row) => ({
  id, session_id: sid, session_day: dayOf(sid), session_date: sid, queue_num: n, status: 'waiting', paid: false, price: 80,
  type_preference: 'Hybrid', size: 'M', height: 172, registered_at: '2026-09-15T10:00:00Z', ...o,
});
const queue_entries = [
  // History: every status, paid and pending, on the house, walk-in, no email, a free community ride
  q('h1', 1, '2026-09-17', { name: 'Sara Ali', customer_id: 'c1', email: 'sara@example.test', phone: '0551234567', status: 'done', paid: true, assigned_bike_id: 'b01', type_preference: 'Road', height: 165, checked_in_at: '2026-09-17T18:05:00Z', checked_out_at: '2026-09-17T19:40:00Z', ride_duration: 95, registered_at: '2026-09-14T09:00:00Z' }),
  q('h2', 2, '2026-09-17', { name: 'Walk-in Rider', email: 'walkin@example.test', phone: '0550000002', status: 'done', paid: false, walk_in: true, ride_duration: 60, checked_in_at: '2026-09-17T18:20:00Z', registered_at: '2026-09-17T18:00:00Z' }),
  q('h3', 3, '2026-09-22', { name: 'Omar Hassan', customer_id: 'c2', phone: '0551234568', status: 'noshow', registered_at: '2026-09-20T09:00:00Z' }),
  q('h4', 4, '2026-09-22', { name: 'Cara Vale', customer_id: 'c3', email: 'cara@example.test', phone: '0551234569', status: 'cancelled', cancelled_by: 'customer', type_preference: 'Mountain', registered_at: '2026-09-19T09:00:00Z' }),
  q('h5', 5, '2026-09-22', { name: 'Dana Reyes', phone: '0550000005', status: 'removed', removed_from: 'waiting', registered_at: '2026-09-21T09:00:00Z' }),
  q('h6', 6, '2026-09-22', { name: 'Faisal Noor', email: 'faisal@example.test', phone: '0550000006', status: 'done', paid: true, price: 0, assigned_bike_id: 'b06', ride_duration: 110, registered_at: '2026-09-22T08:00:00Z' }),
  q('h7', 1, '2026-09-19', { name: 'Lina Saleh', email: 'lina@example.test', phone: '0550000007', status: 'done', paid: false, price: 0, approval: 'approved', registered_at: '2026-09-18T08:00:00Z' }),
  // Tonight (50 % booked), the Saturday ride (90 %), the Petromin night (100 %)
  q('t1', 1, TODAY, { name: 'Sara Ali', customer_id: 'c1', phone: '0551234567', status: 'active', paid: true, assigned_bike_id: 'b01', type_preference: 'Road', checked_in_at: '2026-09-24T18:05:00Z' }),
  q('t2', 2, TODAY, { name: 'Omar Hassan', customer_id: 'c2', phone: '0551234568' }),
  q('t3', 3, TODAY, { name: 'Walk-in Two', status: 'waitlist', waitlist_num: 1 }),
  ...Array.from({ length: 9 }, (_, i) => q('s' + i, i + 1, '2026-09-26', { name: ['Huda', 'Reem', 'Tariq', 'Jana', 'Hamad', 'Rana', 'Majed', 'Noura', 'Ali'][i] + ' Rider', approval: 'approved', paid: false, price: 0 })),
  q('p1', 1, '2026-09-27', { name: 'Petro One', approval: 'approved' }),
  q('p2', 2, '2026-09-27', { name: 'Petro Two', approval: 'approved' }),
];
const inventory = [
  { id: 'i1', name: 'Water', brand: 'Nova', category: 'Drinks', qty: 30, price: 5, addon: true, photo: '/icon-192.png' },
  { id: 'i2', name: 'Energy bar', category: 'Snacks', qty: 12, price: 8, addon: true },
  { id: 'i3', name: 'Helmet rental', category: 'Gear', qty: 6, price: 15, addon: true },
  { id: 'i4', name: 'Gloves', category: 'Gear', qty: 0, price: 20, addon: true },
];
const promo_codes = [
  { id: 'p1', code: 'SUMMER10', kind: 'percent', value: 10, active: true, created_at: '2026-06-01T09:00:00Z' },
  { id: 'p2', code: 'FLAT20', kind: 'flat', value: 20, active: false, applies_to: 'Road', created_at: '2026-06-02T09:00:00Z' },
  { id: 'p3', code: 'OLD5', kind: 'percent', value: 5, active: true, expires_at: '2026-09-01', created_at: '2026-05-01T09:00:00Z' },
  { id: 'p4', code: 'ONCE', kind: 'flat', value: 15, active: true, max_uses: 1, uses: 1, created_at: '2026-07-01T09:00:00Z' },
  { id: 'p5', code: 'SARA50', kind: 'percent', value: 50, active: true, customer_id: 'c1', max_uses: 3, uses: 1, expires_at: '2026-12-31', created_at: '2026-08-01T09:00:00Z' },
];
const at = (d: string, hm: string) => `${d}T${hm}:00+03:00`;
const staff_actions = [
  { at: at(TODAY, '20:10'), action: 'Marked paid #2 Omar Hassan', who: 'Malik' },
  { at: at(TODAY, '19:55'), action: 'Checked in #1 Sara Ali', who: 'Spec Staff' },
  { at: at(TODAY, '19:40'), action: 'Bike Road 2 to maintenance', who: 'Salem' },
  { at: at(TODAY, '19:30'), action: 'Stock adjusted: Water +5', who: 'Staff' },
  { at: at(TODAY, '19:00'), action: 'Staff login', who: 'Malik' },
  { at: at(TODAY, '18:45'), action: 'Exported the day sheet with a rather long description that has to be cut off at the end of the line', who: 'Guest' },
  { at: at('2026-09-23', '21:15'), action: 'Cancelled #4 Cara Vale', who: 'Salem' },
  { at: at('2026-09-23', '20:00'), action: 'Refund SAR 80 #3', who: 'Malik' },
  { at: at('2026-09-20', '09:30'), action: 'Session 2026-09-26 created', who: 'Malik' },
];
const staff_options = [{
  key: 'session_templates', items: [
    { id: 'tplA', label: 'Thu night', form: { newSessEvent: 'jcc', newSessStartTime: '20:00', newSessEndTime: '22:30', newSessMode: 'total', newSessTotal: '15', newSessAddons: [], newSessWlMode: 'count', newSessWlVal: '' } },
    { id: 'tplB', label: 'Saturday social', form: { newSessEvent: 'community', newSessStartTime: '06:30', newSessEndTime: '07:00', newSessSpots: '25' } },
  ],
}];
const FIX = {
  sessions, bikes, customers, queue_entries, inventory, promo_codes, staff_actions, staff_options,
  breakfast_spots: [{ id: 'bf1', name: 'Cafe Sea', url: 'https://example.test/cafe' }, { id: 'bf2', name: 'Bakery Corner', url: null }],
  site_content: [{ key: 'booking.window', value: { days: 7, at: '09:00' } }],
};

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function settle(page: Page) {
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await document.fonts.ready;
    // lazy pictures (the add-on cards) are made eager, so every run draws them loaded
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => { (i as HTMLImageElement).loading = 'eager'; });
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
    await document.fonts.ready;
  });
}

type Open = { lang: string; fx?: Record<string, unknown> };
async function minCss(page: Page) {
  if (!process.env.MIN_CSS) return;
  await page.route(/\/styles\.css/, async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, body: new CleanCSS({ level: 1 }).minify(await res.text()).styles });
  });
}
async function open(page: Page, o: Open) {
  await page.clock.setFixedTime(NOW);
  await minCss(page);
  await stubSupabase(page, { ...FIX, ...(o.fx || {}) });
  await unlockStaff(page);
  await page.addInitScript((lang) => {
    localStorage.setItem('cq_lang', lang);
    localStorage.setItem('cq_lang_pick', '1');
  }, o.lang);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, o.lang);
  await page.waitForFunction(`S.view==='staff'`);
  await page.waitForFunction(`getComputedStyle(document.getElementById('loading-screen')).display==='none'`);
  // the Bookings refresh label moves on its own; a scroll-into-view is instant, so a shot never catches one halfway
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
async function shot(page: Page, name: string, o: { full?: boolean; el?: Locator; roots?: string[] } = {}) {
  await quiet(page);
  await settle(page);
  // A screenshot is taken until two in a row agree; a long phone page on a loaded machine needs more
  // than the default five seconds for that (each capture also sets off the redraw described below).
  if (o.el) await expect.soft(o.el).toHaveScreenshot(name + '.png', { timeout: 30000 });
  else await expect.soft(page).toHaveScreenshot(name + '.png', { fullPage: o.full !== false, timeout: 30000 });
  // Taking the screenshot flips (max-width:767px) and back for a moment, and Bookings redraws on
  // that change (renderStaffQueue); the sortable headers arrive 80 ms after a redraw. Wait again.
  await quiet(page);
  const hashes = await page.evaluate(styleHashes, { roots: ['body'], ignore: '^--(ss|hist)-', stripOrigin: true }); // data-cssv's own properties (this pass's), and any port
  if (process.env.CSS_DUMP) {
    mkdirSync(join(SNAPS, '_dump'), { recursive: true });
    writeFileSync(join(SNAPS, '_dump', `${name}-${Date.now()}.json`), JSON.stringify(await page.evaluate(styleOf, process.env.CSS_DUMP), null, 1));
  }
  expect.soft(JSON.stringify(hashes, null, 0).replace(/","/g, '",\n"')).toMatchSnapshot(name + '.css.txt');
  const mode = process.env.AUDIT;
  if (mode === 'inline' || mode === 'class') {
    const rows = await page.evaluate(cascadeAudit, { roots: o.roots || ['body'], classes: CLASSES, inline: mode === 'inline' });
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
const staffTab = async (page: Page, tab: string, ready: string) => {
  await page.evaluate(`setStaffTab('${tab}');window.scrollTo(0,0)`);
  await page.waitForFunction(ready);
};
const SESS_READY = `!!document.querySelector('#sess-host .sess-twopane')&&S._bw!==undefined&&!S._bwBusy`;
// Each evaluate draws a state; the page goes back to the top so a full-page shot starts there.
const draw = (page: Page, code: string) => page.evaluate(code + ';window.scrollTo(0,0)');

test.describe.configure({ timeout: 300000 }); // a loaded machine runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:pass3 ${vpName}`, () => {
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`history ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`S.histLog=[
          {id:'l1',action:t('histRemoved'),entryId:'h5',name:'Dana Reyes',queueNum:5,session:'Tuesday 22 Sep',time:'20:12',undoFn:()=>{},undone:false},
          {id:'l2',action:'Restored',entryId:'h4',name:'Cara Vale with a long name that runs on and on',queueNum:4,session:'Tuesday 22 Sep',time:'20:05',undoFn:()=>{},undone:true},
          {id:'l3',action:'Marked paid',entryId:'h1',name:'Sara Ali',queueNum:1,session:'Thursday 17 Sep',time:'19:58',undoFn:null,undone:false}]`);
        await staffTab(page, 'history', `!!document.querySelector('#tab-history .queue-table')`);
        await shot(page, `${P}-hist-rides`);
        await page.evaluate(`document.querySelector('#hist-results .table-wrapper').scrollLeft=document.dir==='rtl'?-1e6:1e6`);
        await shot(page, `${P}-hist-rides-end`); // the columns past the right-hand edge
        await draw(page, `toggleHistSelect('h2')`);
        await shot(page, `${P}-hist-selected`);
        await draw(page, `S.showHistLog=true;renderHistory()`);
        await shot(page, `${P}-hist-logpanel`);
        await draw(page, `S.histLog=[];renderHistory()`);
        await shot(page, `${P}-hist-logpanel-empty`);
        await draw(page, `S.showHistLog=false;S.histSelected=[];S.histLimit=2;renderHistory()`);
        await shot(page, `${P}-hist-more`);
        await draw(page, `S.histLimit=60;S._fOpen={hist:true};S.histStatus='done';renderHistory()`);
        await shot(page, `${P}-hist-filters`);
        await draw(page, `S._fOpen={};S.histStatus='all';S.histSearch='zzzz';renderHistory()`);
        await shot(page, `${P}-hist-empty`);
        await draw(page, `S.histSearch='';renderHistory()`);
        await quiet(page);
        await page.locator('#tab-history [data-on-click*="showEditPriceModal"]').first().hover();
        await shot(page, `${P}-hist-pencil-hover`, { full: false });
        await page.mouse.move(0, 0);
        await page.evaluate(`showReceipt('h1')`);
        await shot(page, `${P}-hist-receipt`, { full: false });
        await page.evaluate(`closeReceipt()`);
      });

      test(`log ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`S.actionLog=[{id:'a1',label:'Marked paid #2 Omar Hassan',fn:()=>{},timestamp:Date.parse('${at(TODAY, '20:10')}'),undone:false},
          {id:'a2',label:'Checked in #1 Sara Ali',fn:()=>{},timestamp:Date.parse('${at(TODAY, '19:55')}'),undone:true}];S.histView='log'`);
        await staffTab(page, 'history', `!!document.querySelector('#hist-log-host h3')&&Array.isArray(S._dbLog)`);
        await shot(page, `${P}-log-list`);
        await draw(page, `S._fOpen={log:true};renderLogs()`);
        await shot(page, `${P}-log-filters`);
        await draw(page, `S._fOpen={};S._logCat='pay';S._logOp='Malik';renderLogs()`);
        await shot(page, `${P}-log-filtered`);
        await draw(page, `S._logCat='all';S._logOp='all';S._logSearch='zzzz';renderLogs()`);
        await shot(page, `${P}-log-empty`);
        await draw(page, `S._logSearch='';S._dbLog=[];S._dbLogAt=Date.now();S.fullLog=[];renderLogs()`);
        await shot(page, `${P}-log-none`);
      });

      test(`sessions ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await staffTab(page, 'sessions', SESS_READY);
        await draw(page, `renderSessions()`);
        await shot(page, `${P}-ss-list`);
        await page.evaluate(`document.querySelector('#sess-host .sess-list-scroll').scrollTop=1e6`);
        await shot(page, `${P}-ss-list-end`); // the closed sessions, below the live ones in the pane
        await draw(page, `selectSessionDetail('${TODAY}')`);
        await shot(page, `${P}-ss-detail`);
        await draw(page, `selectSessionDetail('2026-10-01')`);
        await shot(page, `${P}-ss-detail-none`);
        await draw(page, `selectSessionDetail(null);S.showDeletedSess=true;renderSessions()`);
        await shot(page, `${P}-ss-deleted`);
        await draw(page, `S.showDeletedSess=false;S.sessView='cal';renderSessions()`);
        await shot(page, `${P}-ss-cal`);
        await draw(page, `_calMove(1)`);
        await shot(page, `${P}-ss-cal-next`);
        await draw(page, `S._calYm=null;S.sessView='list';S.sessStatusFilter='deleted';renderSessions()`);
        await shot(page, `${P}-ss-list-none`);
        await draw(page, `S.sessStatusFilter='all';S._bw=null;S._bwDays=undefined;S._bwAt=undefined;S.promoCodes=[];S._pcCode='WINTER';S._pcKind='flat';S._pcValue='15';S._pcType='Road';S._pcExpires='2026-12-01';S._pcMax='5';S._pcCust='Sara Ali';renderSessions()`);
        await shot(page, `${P}-ss-bw-pc-empty`);
      });

      test(`new session ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await staffTab(page, 'sessions', SESS_READY);
        const form = page.locator('#sess-add-form');
        const reset = `S.newSessDate='2026-10-08';S.newSessRepeat='1';S.newSessDays=[];S.newSessTitle='';S.newSessSpots='';S.newSessMapUrl='';S.newSessBfSel='';S.newSessAddons=[];S.newSessAssignedIds=[];S.newSessWlMode='count';S.newSessWlVal='';S.newSessRoute='';S.newSessDesc='';S.newSessPrice='';S.newSessOpenAll=true;S._routes=[];S.newSessTypeSizes={Road:_emptySizes(),Hybrid:_emptySizes(),Mountain:_emptySizes(),Kids:_emptySizes()};S.showAddSession=true;S.editSessionId=null;`;
        await draw(page, `${reset}S.newSessEvent='jcc';S.newSessMode='total';S.newSessTotal='10';renderSessions()`);
        await shot(page, `${P}-ns-jcc-total`);
        await draw(page, `${reset}S._routes=[{slug:'corniche',name:'Corniche loop',km:'12'}];S.newSessRoute='corniche';S.newSessEvent='jcc';S.newSessMode='counts';S.newSessTypeSizes.Road.M=3;S.newSessTypeSizes.Road.L=1;S.newSessTypeSizes.Kids.S=2;S.newSessDays=[1,4];S.newSessRepeat='4';S.newSessWlMode='pct';S.newSessWlVal='20';renderSessions()`);
        await shot(page, `${P}-ns-jcc-counts`, { el: form });
        await draw(page, `${reset}S.newSessEvent='jcc';S.newSessMode='fleet';S.newSessAssignedIds=['b02','b05'];S.newSessAddons=['i1'];renderSessions()`);
        await shot(page, `${P}-ns-jcc-fleet`, { el: form });
        await draw(page, `${reset}S.newSessEvent='jcc';S.newSessMode='fleet';S.newSessAssignedIds=['b02','b03','b05','b06'];S.newSessAddons=['i1','i2','i3'];renderSessions()`);
        await shot(page, `${P}-ns-jcc-fleet-all`, { el: form });
        await draw(page, `${reset}S.newSessEvent='community';S.newSessSpots='25';S.newSessMapUrl='https://maps.example.test/b';S.newSessBfSel='__new';S.newSessBfName='New Cafe';S.newSessBfUrl='https://example.test/new';renderSessions()`);
        await shot(page, `${P}-ns-community`, { el: form });
        await draw(page, `${reset}S.newSessEvent='petromin';S.newSessMode='counts';S.newSessCollect='19:15';renderSessions()`);
        await shot(page, `${P}-ns-petromin`, { el: form });
        await draw(page, `${reset}S.newSessEvent='swim';renderSessions()`);
        await shot(page, `${P}-ns-swim`, { el: form });
        await draw(page, `${reset}S.newSessEvent='workshop';S.newSessTitle='Triathlon Prep';renderSessions()`);
        await shot(page, `${P}-ns-workshop`, { el: form });
        await draw(page, `${reset}S.newSessEvent='snd96';S.newSessMode='total';renderSessions()`);
        await shot(page, `${P}-ns-snd96`, { el: form });
        await draw(page, `${reset}S.newSessEvent='event';S.newSessDesc='An evening of films.';S.newSessPrice='25';S.newSessOpenAll=false;renderSessions()`);
        await shot(page, `${P}-ns-event`, { el: form });
        await draw(page, `${reset}S.staffOptions={...S.staffOptions,session_templates:[]};S.newSessEvent='jcc';S.newSessMode='total';renderSessions()`);
        await shot(page, `${P}-ns-tpl-none`, { el: form });
      });

      test(`edit session ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await staffTab(page, 'sessions', SESS_READY);
        const form = page.locator('#sess-edit-form');
        for (const [k, id, extra] of [
          ['jcc-fleet', TODAY, ''], ['jcc-fleet-counts', TODAY, `S.editSessMode='counts';S.editSessTypeSizes.Hybrid.L=2;`], ['jcc-fleet-total', TODAY, `S.editSessMode='total';`],
          ['jcc-counts', '2026-09-22', ''], ['community', '2026-09-26', ''], ['community-newbf', '2026-09-26', `S.editSessBfSel='__new';S.editSessWlMode='pct';S.editSessWlVal='10';`],
          ['petromin', '2026-09-27', ''], ['swim', '2026-09-30', ''], ['workshop', '2026-10-01', ''], ['snd96', '2026-10-02', ''], ['event', '2026-10-03', ''],
        ] as const) {
          await draw(page, `startEditSession('${id}');${extra}renderSessions()`);
          await shot(page, `${P}-es-${k}`, { el: form });
        }
        await draw(page, `S.editSessionId=null;renderSessions()`);
      });

      test(`dashboard ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await staffTab(page, 'dashboard', `!!document.querySelector('#tab-dashboard .dash-kpis')`);
        await shot(page, `${P}-dash`);
      });

      test(`dashboard empty ${lang}`, async ({ page }) => {
        await open(page, { lang, fx: { sessions: sessions.filter((s) => s.id !== TODAY), queue_entries: [], staff_actions: [] } });
        await page.evaluate(`S.fullLog=[]`);
        await staffTab(page, 'dashboard', `!!document.querySelector('#tab-dashboard .dash-kpis')`);
        await draw(page, `renderDashboard()`);
        await shot(page, `${P}-dash-empty`);
      });

      test(`undo confirm ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`void _undoAuth(${js('Checked in #3 Cara Vale')},true)`);
        await page.waitForFunction(`!!document.querySelector('#confirm-modal .confirm-box')`);
        await shot(page, `${P}-uc-absent`, { full: false });
        await page.evaluate(`closeConfirm()`);
      });
    }
  });
}
