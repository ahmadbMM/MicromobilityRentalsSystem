import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

declare const _langLoaded: (l: string) => boolean; // app global

// The desk's pass of the inline-style move (playwright.visual.config.ts says how to run it): the
// classic bike picker (renderModal) in each of its modes - waiting, paid, on the house and active
// riders, the price being edited, a bike picked and a column sorted, the other types shown, the
// filters, a search with no match, no bike free, the quick add-a-bike form; the check-in modal
// (renderCheckinModal) for a solo rider, a party at every step, a Scan several run, a no-show, a
// bike owner riding free, a free community ride, a swim with no bike, and its Bike field in every
// state (looking up, unknown with the offer to link a tag, available, out, chosen for another
// rider and held for another); the scanner (openScanModal) plain, with its switches on, with the
// Scan several list (and nothing left to check in), refusing a ticket for another day with "Make
// an exception", opened from a check-in and adding bookings to it; Bookings > Hand-over with
// riders and empty; and the sheet a tag tapped on a bike that is out opens. Every state is a
// screenshot (a dialog that scrolls, one for each screenful) and a hash of the computed style of
// every element on the page (cascade-audit.ts), in English and Arabic, at 1280x900 and 390x844,
// from fixed data on a frozen clock. The switches are pass2.visual.ts's: AUDIT=inline,
// AUDIT=class with AUDIT_CLASSES, MIN_CSS=1, CSS_DUMP. Take the baseline from the untouched
// build, run it twice (it must pass unchanged), then convert. The last test turns the policy on
// with style-src 'self' alone and draws the same screens: nothing in them may be refused.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
const TOMORROW = '2026-09-25';
const SNAPS = process.env.VISUAL_SNAPS || join(tmpdir(), 'mm-visual-snaps');
const CLASSES = process.env.AUDIT_CLASSES ? readFileSync(process.env.AUDIT_CLASSES, 'utf8').split(/\s+/).filter(Boolean) : [];
const ROOTS = ['#bike-modal', '#checkin-modal', '#scan-modal', '#ho-host', '#confirm-modal'];

type Row = Record<string, unknown>;
const js = (o: unknown) => JSON.stringify(o);
// Booking ids as the scanner reads them: MMC-<queue number>-<first six characters of the id>.
const ID = (n: number) => `${String(n).padStart(2, '0')}abcdef-0000-4000-8000-${String(n).padStart(12, '0')}`;
const R = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`r${i + 1}`, ID(i + 1)])) as Record<string, string>;
const sess = (id: string, date: string, o: Row) => ({ id, day: date === TODAY ? 'Thursday' : 'Friday', session_date: date, capacity: 12, status: 'open', location: 'JCC', created_at: 1, ...o });
const COMM = { event_kind: 'community', needs_approval: true };
const sessions = [
  sess('sJ', TODAY, { bike_slots: js({ _time: '21:00 - 23:00', _bikes: ['b01', 'b02', 'b05', 'b07'] }) }),
  sess('sL', TODAY, { bike_slots: null }),
  sess('sC', TODAY, { ...COMM, spots: 10, capacity: 10, bike_slots: js({ _time: '06:30 - 07:00' }) }),
  sess('sS', TODAY, { ...COMM, ride_kind: 'swim', paid_ride: true, spots: 8, capacity: 8, title: 'Pool Session', bike_slots: js({ _time: '07:00 - 08:00' }) }),
  sess('sN', TODAY, { ride_kind: 'snd96', capacity: 20, title: 'National Day Ride', bike_slots: js({ _time: '06:00 - 08:00', _total: 20 }) }),
  sess('sT', TOMORROW, { bike_slots: js({ _time: '21:00 - 23:00', _total: 12 }) }),
];
const bikes = [
  { id: 'b01', name: 'Road 1', type: 'Road', size: 'M', status: 'in-use', brand: 'Alvas', model: 'Climax', bike_number: 1, colors: ['#111', '#e33'], color_names: ['Black', 'Red'], groupset: 'Shimano 105', speeds: 22, wheel_size: '700c', brake_type: 'Disc', weight_kg: 8.4 },
  { id: 'b02', name: 'Hybrid 1', type: 'Hybrid', size: 'L', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 2, colors: ['#0a0'] },
  { id: 'b03', name: 'Mountain 1', type: 'Mountain', size: 'M', status: 'available', brand: 'Alvas', model: 'Strom M50', bike_number: 3, colors: ['#555'] },
  { id: 'b04', name: 'Road 2', type: 'Road', size: 'S', status: 'maintenance', brand: 'Alvas', model: 'DA54', bike_number: 4, colors: ['#c00'] },
  { id: 'b05', name: 'Road 3', type: 'Road', size: 'L', status: 'available', brand: 'Giant', model: 'Contend', bike_number: 5, groupset: 'Sora', speeds: 18, frame_type: 'Aluminium', color_names: ['Blue'] },
  { id: 'b06', name: 'Hybrid 2', type: 'Hybrid', size: 'M', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 6, colors: ['#00c', '#fff'] },
  { id: 'b07', name: 'Road 4', type: 'Road', size: 'S', status: 'available', bike_number: 7, colors: ['red;x'], weight_kg: 9 },
  { id: 'b08', name: 'Road 5', type: 'Road', size: 'M', status: 'held', brand: 'Alvas', model: 'DA54', bike_number: 8, colors: ['#333'] },
  { id: 'b09', name: 'Kids 1', type: 'Kids', size: 'XS', status: 'available', brand: 'Alvas', model: 'Beta', bike_number: 9, colors: ['#f90'] },
];
const customers = [
  { id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567', gender: 'female', birth_date: '1990-05-05', country: 'Saudi Arabia', city: 'Jeddah', height: 165, type_preference: 'Road', created_at: '2026-08-20T10:00:00Z' },
];
const at = (hm: string) => `${TODAY}T${hm}:00+03:00`;
const q = (k: string, n: number, sid: string, o: Row) => {
  const s = sessions.find((x) => x.id === sid)!;
  return {
    id: R[k], session_id: sid, session_day: s.day, session_date: s.session_date, queue_num: n, status: 'waiting', paid: false, price: 80,
    type_preference: 'Road', size: 'M', phone: '', walk_in: true, group_id: null, registered_at: '2026-09-15T10:00:00Z', ...o,
  };
};
const queue_entries = [
  q('r1', 1, 'sJ', { name: 'Sara Ali', customer_id: 'c1', phone: '0551234567', size: 'S', height: 165 }),
  q('r2', 2, 'sJ', { name: 'Omar Hassan', group_id: 'g1', paid: true, type_preference: 'Hybrid', height: 180 }),
  q('r3', 3, 'sJ', { name: 'Huda Noor', group_id: 'g1', status: 'active', paid: true, type_preference: 'Hybrid', checked_in_at: at('20:05') }),
  q('r4', 4, 'sJ', { name: 'Reem Saleh', group_id: 'g1', status: 'noshow', height: 170 }),
  q('r5', 5, 'sJ', { name: 'Tariq Fahd', group_id: 'g1' }),
  q('r6', 6, 'sJ', { name: 'Faisal Noor', status: 'active', paid: true, assigned_bike_id: 'b01', checked_in_at: at('19:50') }),
  q('r7', 7, 'sJ', { name: 'Jana Omar', status: 'active', paid: true, group_id: 'g2', group_name: 'Omar Family', type_preference: 'Hybrid', size: 'L', checked_in_at: at('20:10') }),
  q('r8', 8, 'sJ', { name: 'Hamad Ali', status: 'active', paid: true, type_preference: 'Mountain', size: 'L', height: 185, checked_in_at: at('20:20') }),
  q('r9', 9, 'sJ', { name: 'Rana Majed', status: 'waitlist', waitlist_num: 1, type_preference: 'Hybrid', size: null }),
  q('r10', 10, 'sL', { name: 'Noura Saad', paid: true, price: 0, type_preference: 'Any', height: 158 }),
  q('r11', 11, 'sJ', { name: 'Ali Hassan', status: 'noshow' }),
  q('r12', 12, 'sJ', { name: 'Majed Karim', type_preference: 'Hybrid', size: 'L', assigned_bike_id: 'b02' }),
  q('r13', 13, 'sS', { name: 'Lina Swim', price: 40, type_preference: 'Any' }),
  q('r14', 14, 'sC', { name: 'Dana Comm', price: 0, approval: 'approved', type_preference: 'Hybrid' }),
  q('r15', 15, 'sN', { name: 'Sami Nader', price: 60 }),
  q('r16', 16, 'sT', { name: 'Tala Tomorrow', type_preference: 'Hybrid' }),
];
const FIX = { sessions, bikes, customers, queue_entries, desk_waitlist: [] };

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
// No camera in a headless browser, and what it answers varies by machine: the scanner is told
// "denied", so its message is the same on every run.
const noCamera = (page: Page) => page.addInitScript(() => {
  const md = navigator.mediaDevices || ((navigator as unknown as { mediaDevices: object }).mediaDevices = {} as MediaDevices);
  (md as MediaDevices).getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  try { delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector; } catch { /* not there */ }
  (window as unknown as { jsQR: () => null }).jsQR = () => null; // no decoder to fetch
});
async function open(page: Page, lang: string, fx: Row = {}) {
  await page.clock.setFixedTime(NOW);
  await minCss(page);
  await stubSupabase(page, { ...FIX, ...fx });
  await unlockStaff(page);
  await noCamera(page);
  await page.addInitScript((l) => {
    localStorage.setItem('cq_lang', l);
    localStorage.setItem('cq_lang_pick', '1');
    localStorage.setItem('cq_scan_cont', '0');
    localStorage.setItem('cq_scan_multi', '0');
    localStorage.setItem('cq_scan_express', '0');
  }, lang);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, lang);
  await page.waitForFunction(`S.view==='staff'&&S.dataLoaded===true`);
  await page.waitForFunction(`getComputedStyle(document.getElementById('loading-screen')).display==='none'`);
  await page.evaluate(`window._tickRefreshLabel=function(){};window._sb=function(){return 'auto'}`);
  await page.evaluate(`S.staffTab='queue';S.queueView='bookings';renderStaffQueue();window.scrollTo(0,0)`);
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
async function hashes(page: Page, name: string, extra: Record<string, string> = {}) {
  const h = { ...await page.evaluate(styleHashes, { roots: ['body'], ignore: '^--bkm-', stripOrigin: true }), ...extra };
  if (process.env.CSS_DUMP) {
    mkdirSync(join(SNAPS, '_dump'), { recursive: true });
    writeFileSync(join(SNAPS, '_dump', `${name}-${Date.now()}.json`), JSON.stringify(await page.evaluate(styleOf, process.env.CSS_DUMP), null, 1));
  }
  expect.soft(JSON.stringify(h, null, 0).replace(/","/g, '",\n"')).toMatchSnapshot(name + '.css.txt');
  const mode = process.env.AUDIT;
  if (mode === 'inline' || mode === 'class') {
    const rows = await page.evaluate(cascadeAudit, { roots: ROOTS, classes: CLASSES, inline: mode === 'inline' });
    if (mode === 'inline') audits[name] = rows;
    else expect.soft(rows.filter((r) => r.hits.length), name).toEqual([]);
  }
}
async function snap(page: Page, name: string, full = false) {
  await expect.soft(page).toHaveScreenshot(name + '.png', { fullPage: full, timeout: 120000 });
  await quiet(page); // a capture flips (max-width:767px) and back, and Bookings redraws on that change
}
// One state: a screenshot of every screenful of the dialog's scrolling box (or of the viewport,
// or the whole page), then the style hashes, with how tall the box is so a change in length shows.
async function shot(page: Page, name: string, o: { box?: string; full?: boolean } = {}) {
  await quiet(page);
  await settle(page);
  if (!o.box) {
    await snap(page, name, !!o.full);
    await hashes(page, name);
    return;
  }
  const geo = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollTop = 0;
    return { sh: el.scrollHeight, ch: el.clientHeight };
  }, o.box);
  expect(geo, `${name}: ${o.box}`).not.toBeNull();
  const step = Math.max(1, geo!.ch - 60);
  const n = geo!.sh > geo!.ch ? Math.ceil((geo!.sh - geo!.ch) / step) + 1 : 1;
  for (let i = 0; i < n; i++) {
    if (i) {
      await page.evaluate(([s, top]) => { document.querySelector(s as string)!.scrollTop = top as number; }, [o.box, Math.min(i * step, geo!.sh - geo!.ch)]);
      await settle(page);
    }
    await snap(page, n > 1 ? `${name}-${i}` : name);
  }
  await page.evaluate((s) => { document.querySelector(s)!.scrollTop = 0; }, o.box);
  await hashes(page, name, { '(scroll)': `${geo!.sh}/${geo!.ch}` });
}
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  if (process.env.AUDIT !== 'inline' || !Object.keys(audits).length) return;
  mkdirSync(join(SNAPS, '_audit'), { recursive: true });
  writeFileSync(join(SNAPS, '_audit', info.title.replace(/\W+/g, '_') + '-' + info.project.name + '-' + info.workerIndex + '-' + Date.now() + '.json'), JSON.stringify(audits, null, 1));
  for (const k of Object.keys(audits)) delete audits[k];
});
// Each call draws a state and waits for the page to settle, so the dialog focus manager (which runs
// 40 ms after a dialog opens or closes, _syncModalFocus) has had its turn before the next call.
const draw = async (page: Page, code: string) => { await page.evaluate(code); await quiet(page); };
const BM = '#bike-modal .modal-box', CI = '#checkin-modal .modal-box';

test.describe.configure({ timeout: 1200000 }); // a loaded machine runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:checkin ${vpName}`, () => {
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`bike picker ${lang}`, async ({ page }) => {
        await open(page, lang);
        // a waiting Road rider who owes, on a session with its own fleet: size, fleet, reserved badges, bikes out
        await draw(page, `openModal('${R.r1}')`);
        await shot(page, `${P}-bm-waiting`, { box: BM });
        await page.evaluate(`document.querySelector('#bike-modal .modal-box table').parentElement.scrollLeft=document.dir==='rtl'?-1e6:1e6`);
        await shot(page, `${P}-bm-waiting-end`, { box: BM }); // the columns past the edge
        await draw(page, `pickBike('b07');S.modalSort='size';S.modalSortDir=-1;renderModal()`);
        await shot(page, `${P}-bm-picked-sorted`, { box: BM });
        await draw(page, `S.modalSort='brand';S.modalSortDir=1;S.modalShowAll=true;renderModal()`);
        await shot(page, `${P}-bm-showall`, { box: BM });
        await draw(page, `S.modalShowAll=false;S.modalSort='default';S._fOpen={mf:true};S.modalFilterSize='L';S.modalFilterBrand='Giant';renderModal()`);
        await shot(page, `${P}-bm-filters`, { box: BM });
        await draw(page, `S._fOpen={};S.modalFilterSize='all';S.modalFilterBrand='all';S.modalSearch='zzzz';renderModal()`);
        await shot(page, `${P}-bm-nomatch`, { box: BM });
        await draw(page, `S.modalSearch='';S.modalPriceEdit=true;renderModal()`);
        await shot(page, `${P}-bm-price-edit`, { box: BM });
        await draw(page, `S.modalPriceEdit=false;S.modalShowAddBike=true;S.modalAddBikeType='Hybrid';S.modalAddBikeSize='L';renderModal()`);
        await shot(page, `${P}-bm-addbike`, { box: BM });
        await draw(page, `S.modalShowAddBike=false;getBikes().forEach(b=>{b._st=b.status;if(b.status==='available')b.status='in-use'});renderModal()`);
        await shot(page, `${P}-bm-nofree`, { box: BM });
        await draw(page, `getBikes().forEach(b=>{b.status=b._st;delete b._st});closeModal()`);
        // on the house, a session with no fleet of its own, any type
        await draw(page, `openModal('${R.r10}')`);
        await shot(page, `${P}-bm-house`, { box: BM });
        await draw(page, `closeModal()`);
        // a rider on a bike already: Change bike, paid, the bike they have picked
        await draw(page, `openModal('${R.r6}')`);
        await shot(page, `${P}-bm-active`, { box: BM });
        await draw(page, `closeModal()`);
        // a waitlisted rider with no height; the other types with bikes free
        await draw(page, `openModal('${R.r9}')`);
        await shot(page, `${P}-bm-waitlist`, { box: BM });
        await draw(page, `closeModal()`);
      });

      test(`check-in ${lang}`, async ({ page }) => {
        await open(page, lang);
        const ci = (id: string, extra = '') => draw(page, `closeCheckinModal(true);S._ciDrafts={};S._ciBatch=null;showCheckinModal('${id}');${extra}`);
        await ci(R.r1);
        await shot(page, `${P}-ci-solo`, { box: CI });
        await draw(page, `S._ciPaid='pending';S._ciErr='Could not save: the booking changed on another desk.';renderCheckinModal()`);
        await shot(page, `${P}-ci-pending-err`, { box: CI });
        await draw(page, `S._ciErr=null;S._ciPaid='card';S._ciBikeCode='12';S._ciBikeMsg=t('ciBikeLooking');renderCheckinModal()`);
        await shot(page, `${P}-ci-bike-looking`, { box: CI });
        await draw(page, `S._ciBikeCode='04AABBCCDD';S._ciBikeMsg=t('nfcUnknownBike').replace('{0}','04AABBCCDD');S._ciLinkOffer={uid:'04AABBCCDD',bike:getBikes().find(b=>b.id==='b05')};renderCheckinModal()`);
        await shot(page, `${P}-ci-bike-unknown`, { box: CI });
        await draw(page, `S._ciLinkOffer=null;S._ciBikeMsg=null;S._ciBikeCode='5';S._ciBike={found:true,bike:getBikes().find(b=>b.id==='b05'),rented_to:null};renderCheckinModal()`);
        await shot(page, `${P}-ci-bike-ok`, { box: CI });
        await draw(page, `S._ciBikeCode='1';S._ciBike={found:true,bike:getBikes().find(b=>b.id==='b01'),rented_to:{name:'Faisal Noor',since:'${at('19:50')}'}};renderCheckinModal()`);
        await shot(page, `${P}-ci-bike-out`, { box: CI });
        await draw(page, `S._ciBikeCode='2';S._ciBike={found:true,bike:getBikes().find(b=>b.id==='b02'),rented_to:null};S._ciDrafts={'${R.r5}':{type:'Road',paid:'card',bike:{found:true,bike:getBikes().find(b=>b.id==='b02')},bikeCode:'2'}};renderCheckinModal()`);
        await shot(page, `${P}-ci-bike-dup-held`, { box: CI });
        // a party: the rider in the modal paid, one on a bike, one no-show, one still to come
        await ci(R.r2);
        await shot(page, `${P}-ci-party`, { box: CI });
        await draw(page, `S._ciDrafts={'${R.r5}':{type:'Road',paid:'card',bike:null,bikeCode:''}};renderCheckinModal()`);
        await shot(page, `${P}-ci-party-settled`, { box: CI });
        await ci(R.r4); // the no-show in the party
        await shot(page, `${P}-ci-noshow-party`, { box: CI });
        await ci(R.r11); // a no-show on their own
        await shot(page, `${P}-ci-noshow`, { box: CI });
        // Scan several's run: the waitlisted rider, type but no height
        await draw(page, `closeCheckinModal(true);S._ciDrafts={};S._ciBatch=['${R.r9}','${R.r1}'];showCheckinModal('${R.r9}')`);
        await shot(page, `${P}-ci-batch`, { box: CI });
        await ci(R.r15, `S._ciType='Own';renderCheckinModal()`); // a bike owner with no add-ons: free
        await shot(page, `${P}-ci-own-free`, { box: CI });
        await ci(R.r14); // a free community ride: no money, no payment
        await shot(page, `${P}-ci-free`, { box: CI });
        await ci(R.r13); // a swim: no bike
        await shot(page, `${P}-ci-swim`, { box: CI });
        await draw(page, `closeCheckinModal(true)`);
      });

      test(`scanner ${lang}`, async ({ page }) => {
        await open(page, lang);
        const cam = () => page.waitForFunction(`/\\S/.test((document.getElementById('scan-msg')||{}).textContent||'')`);
        const scanner = async (code: string) => { await draw(page, `closeScanModal();${code}`); await cam(); };
        await scanner(`openScanModal()`);
        await shot(page, `${P}-sc-plain`);
        await scanner(`_scanCont=true;_scanMulti=true;_scanExpress=true;_scanCount=3;openScanModal()`);
        await shot(page, `${P}-sc-switches`);
        await draw(page, `_scanExpress=false;_scanBatch=['${R.r1}','${R.r2}','${R.r9}'];_renderScanBatch()`);
        await shot(page, `${P}-sc-batch`);
        await draw(page, `_scanBatch=['${R.r6}'];_renderScanBatch()`);
        await shot(page, `${P}-sc-batch-none`); // nobody on the list left to check in
        await scanner(`_scanCont=false;_scanMulti=false;_scanCount=0;openScanModal()`);
        await draw(page, `_onScanPayload('MMC-16-16abcd')`); // tomorrow's ticket
        await page.waitForSelector('#scan-exception-btn');
        await shot(page, `${P}-sc-other-day`);
        // from inside a check-in: its bike's sticker, then Add a booking with a run under the camera
        await draw(page, `closeScanModal();showCheckinModal('${R.r1}')`);
        await scanner(`openScanModal()`);
        await shot(page, `${P}-sc-from-checkin`);
        await draw(page, `closeScanModal();closeCheckinModal(true);S._ciBatch=null;showCheckinModal('${R.r2}')`);
        await draw(page, `_ciAddOpenScanner()`);
        await cam();
        await shot(page, `${P}-sc-add-run`);
        await draw(page, `closeScanModal();closeCheckinModal(true)`);
      });

      test(`hand-over ${lang}`, async ({ page }) => {
        await open(page, lang);
        await draw(page, `S.queueView='handover';renderStaffQueue();window.scrollTo(0,0)`);
        await page.waitForSelector('#ho-host .ho-row');
        await shot(page, `${P}-ho-list`, { full: true });
        await draw(page, `S.sfSession='sL';renderStaffQueue();window.scrollTo(0,0)`);
        await page.waitForSelector('#ho-host .empty-state');
        await shot(page, `${P}-ho-empty`, { full: true });
        await draw(page, `S.sfSession='all';S.queueView='bookings';renderStaffQueue()`);
      });

      test(`tag tapped on a bike that is out ${lang}`, async ({ page }) => {
        await open(page, lang);
        await draw(page, `_rtTapSheet({found:true,bike:getBikes().find(b=>b.id==='b01')},getQueue().find(e=>e.id==='${R.r6}'))`);
        await page.waitForSelector('#confirm-modal .confirm-box');
        await shot(page, `${P}-rt-sheet`);
        await draw(page, `closeConfirm()`);
      });
    }
  });
}

// ── The strict policy ──────────────────────────────────────────────────────────────────────────
// The page is served with style-src 'self' alone (the policy the move is heading for), and every
// screen above is drawn again through function-form calls (a string-form evaluate is eval, which
// the policy refuses - tests/csp.spec.ts). A style attribute written inside these dialogs would be
// refused and reported at its element; none may be. Refusals elsewhere on the page are other
// areas' and are left to them; one whose element was already replaced by a repaint is reported at
// the document, with the first characters of the refused value ('report-sample'): CSP_LOG=1 prints
// them, to be read against what the pass removed.
type G = Record<string, unknown>;
declare const S: G & { view: string; dataLoaded: boolean };
declare const sb: unknown;
declare function getQueue(): G[];
declare function getBikes(): G[];
declare function renderStaffQueue(): void;
declare function openModal(id: string): void;
declare function renderModal(): void;
declare function pickBike(id: string): void;
declare function closeModal(): void;
declare function showCheckinModal(id: string): void;
declare function renderCheckinModal(): void;
declare function closeCheckinModal(noResume?: boolean): void;
declare function openScanModal(): void;
declare function closeScanModal(keep?: boolean): void;
declare function _renderScanBatch(): void;
declare function _onScanPayload(raw: string): void;
declare function _ciAddOpenScanner(): void;
declare function _rtTapSheet(d: G, e: G): void;
declare function closeConfirm(): void;
declare function t(k: string): string;
// the scanner's switches and list: let bindings of the app, set from the page below
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare let _scanCont: boolean, _scanMulti: boolean, _scanExpress: boolean, _scanCount: number, _scanBatch: string[];
type Cspv = { dir: string; sample: string; where: string };

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:checkin strict policy ${vpName}`, () => {
    test.use({ ...vp, bypassCSP: false });
    test(`nothing in these dialogs is refused under style-src 'self'`, async ({ page }) => {
      await page.clock.setFixedTime(NOW);
      let rewritten = false;
      await page.route((u) => u.pathname === '/', async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        const csp = headers['content-security-policy'] || '';
        headers['content-security-policy'] = csp.replace(/style-src 'self' 'unsafe-inline'/, "style-src 'self' 'report-sample'");
        rewritten = headers['content-security-policy'] !== csp;
        await route.fulfill({ response: res, headers });
      });
      await stubSupabase(page, FIX);
      await unlockStaff(page);
      await noCamera(page);
      await page.addInitScript((roots) => {
        const w = window as unknown as { __cspv: Cspv[] };
        w.__cspv = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          const el = e.target instanceof Element ? e.target : null;
          const host = el && el.closest(roots.join(','));
          w.__cspv.push({ dir: e.violatedDirective, sample: e.sample || '', where: host ? '#' + host.id : el ? el.tagName : 'document' });
        }, true);
        localStorage.setItem('cq_lang', 'en');
        localStorage.setItem('cq_lang_pick', '1');
        ['cq_scan_cont', 'cq_scan_multi', 'cq_scan_express'].forEach((k) => localStorage.setItem(k, '0'));
      }, ROOTS);
      await page.goto('/');
      expect(rewritten, 'the page came with the policy to tighten').toBe(true);
      await page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && S.view === 'staff' && !!S.dataLoaded);
      await page.evaluate(() => { S.staffTab = 'queue'; S.queueView = 'bookings'; renderStaffQueue(); });
      const steps: [string, (r: Record<string, string>) => void][] = [
        ['bike picker', (r) => { openModal(r.r1); }],
        ['picked, sorted, all types', () => { pickBike('b07'); S.modalSort = 'size'; S.modalSortDir = -1; S.modalShowAll = true; renderModal(); }],
        ['filters', () => { S.modalShowAll = false; S._fOpen = { mf: true }; S.modalFilterSize = 'L'; S.modalFilterBrand = 'Giant'; renderModal(); }],
        ['no match', () => { S._fOpen = {}; S.modalFilterSize = 'all'; S.modalFilterBrand = 'all'; S.modalSearch = 'zzzz'; renderModal(); }],
        ['price edit, add a bike', () => { S.modalSearch = ''; S.modalPriceEdit = true; S.modalShowAddBike = true; S.modalAddBikeType = 'Hybrid'; renderModal(); }],
        ['on the house', (r) => { closeModal(); openModal(r.r10); }],
        ['active', (r) => { closeModal(); openModal(r.r6); }],
        ['check-in solo', (r) => { closeModal(); showCheckinModal(r.r1); }],
        ['check-in error, looking up', () => { S._ciErr = 'x'; S._ciBikeCode = '12'; S._ciBikeMsg = t('ciBikeLooking'); renderCheckinModal(); }],
        ['check-in unknown tag', () => { S._ciBikeMsg = 'No bike'; S._ciLinkOffer = { uid: '04AABBCCDD', bike: getBikes().find((b) => b.id === 'b05') }; renderCheckinModal(); }],
        ['check-in bike out, held, chosen twice', (r) => { S._ciLinkOffer = null; S._ciBikeMsg = null; S._ciBike = { found: true, bike: getBikes().find((b) => b.id === 'b02'), rented_to: null }; S._ciDrafts = { [r.r5]: { type: 'Road', paid: 'card', bike: { found: true, bike: getBikes().find((b) => b.id === 'b02') } } }; renderCheckinModal(); }],
        ['check-in bike in use', () => { S._ciBike = { found: true, bike: getBikes().find((b) => b.id === 'b01'), rented_to: { name: 'F', since: null } }; renderCheckinModal(); }],
        ['check-in party', (r) => { closeCheckinModal(true); S._ciDrafts = {}; showCheckinModal(r.r2); }],
        ['check-in no-show', (r) => { closeCheckinModal(true); showCheckinModal(r.r4); }],
        ['check-in own free', (r) => { closeCheckinModal(true); showCheckinModal(r.r15); S._ciType = 'Own'; renderCheckinModal(); }],
        ['check-in swim', (r) => { closeCheckinModal(true); showCheckinModal(r.r13); }],
        ['scanner', () => { closeCheckinModal(true); _scanCont = true; _scanMulti = true; _scanExpress = true; _scanCount = 3; openScanModal(); }],
        ['scanner list', (r) => { _scanExpress = false; _scanBatch = [r.r1, r.r2, r.r9]; _renderScanBatch(); }],
        ['scanner other day', () => { closeScanModal(); _scanMulti = false; openScanModal(); _onScanPayload('MMC-16-16abcd'); }],
        ['scanner from a check-in, adding', (r) => { closeScanModal(); showCheckinModal(r.r2); _ciAddOpenScanner(); }],
        ['hand-over', () => { closeScanModal(); closeCheckinModal(true); S.queueView = 'handover'; renderStaffQueue(); }],
        ['tag on a bike that is out', (r) => { _rtTapSheet({ found: true, bike: getBikes().find((b) => b.id === 'b01') }, getQueue().find((e) => e.id === r.r6)!); }],
        ['closed', () => { closeConfirm(); }],
      ];
      const seen: Record<string, Cspv[]> = {};
      for (const [label, step] of steps) {
        await page.evaluate(step, R);
        await page.waitForTimeout(150);
        const v = await page.evaluate(() => (window as unknown as { __cspv: Cspv[] }).__cspv.splice(0));
        const mine = v.filter((x) => x.where !== 'document' && ROOTS.includes(x.where));
        if (mine.length) seen[label] = mine;
        if (process.env.CSP_LOG) console.log(label, JSON.stringify(v));
      }
      expect(seen).toEqual({});
      // The check is live: a style attribute written into one of these dialogs is refused and
      // reported at that dialog.
      await page.evaluate(() => { document.getElementById('scan-modal')!.insertAdjacentHTML('beforeend', '<i id="csp-probe" style="color:red"></i>'); });
      await page.waitForTimeout(150);
      const probe = await page.evaluate(() => (window as unknown as { __cspv: Cspv[] }).__cspv.splice(0));
      expect(probe.map((x) => x.where)).toContain('#scan-modal');
      await page.evaluate(() => { document.getElementById('csp-probe')!.remove(); });
    });
  });
}
