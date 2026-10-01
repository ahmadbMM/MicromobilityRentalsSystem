import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

// The printed documents (playwright.visual.config.ts says how to run it): every report window
// _openReport writes (the session report, the Saturday roster, the close-out, the day sheet, the
// account report with each kind of chart, the billing report, the heights report) and the till's
// receipt, each on screen and as it prints, in English and Arabic, in the window's own size and on
// a phone; and, drawn on the page, the billing report dialog and the new-build bar, and the 404 page.
// A window is a document of its own, written into about:blank: it inherits the page's policy and
// runs no script, so its print is stood in for (window.print is replaced on the window the page
// opens) and each shot waits for that print, which is when the page means the window to be ready.
// Every state is a screenshot, a hash of the computed style of every element (cascade-audit.ts,
// and the root element's own), and, for a window at the desktop size, the PDF Chromium prints
// from it (its bytes, less the two dates). The switches are pass3.visual.ts's: AUDIT=inline,
// AUDIT=class with AUDIT_CLASSES (in a window the audit reads the window's own style sheets), and
// MIN_CSS=1. The `strict` tests turn the policy on with style-src 'self' (no 'unsafe-inline') and
// list every style the windows, the dialog, the bar and the 404 page would have refused.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
const SNAPS = process.env.VISUAL_SNAPS || join(tmpdir(), 'mm-visual-snaps');
const CLASSES = process.env.AUDIT_CLASSES ? readFileSync(process.env.AUDIT_CLASSES, 'utf8').split(/\s+/).filter(Boolean) : [];

type Row = Record<string, unknown>;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOf = (d: string) => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
const js = (o: unknown) => JSON.stringify(o);
const tot = (time: string, n: number) => js({ _time: time, _total: n });
const at = (d: string, hm: string) => `${d}T${hm}:00+03:00`;
const sess = (d: string, o: Row) => ({ id: d, day: dayOf(d), session_date: d, capacity: 12, status: 'open', location: 'JCC', bike_slots: tot('21:00 - 23:00', 12), created_at: 1, ...o });
const COMM = { event_kind: 'community', needs_approval: true, spots: 10, capacity: 10, bike_slots: js({ _time: '06:30 - 07:00' }) };
const PETRO = { event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, title: 'Petromin Night', spots: 20, capacity: 20, bike_slots: tot('20:00 - 22:00', 20) };
const sessions = [
  sess('2026-09-17', { status: 'closed' }), // the heights report: riders with no height
  sess('2026-09-20', { status: 'closed', ...PETRO }), // billing: Petromin only
  sess('2026-09-22', { status: 'closed' }), // the heights report: heights in every range, a Kids bike
  sess(TODAY, { addons: js(['i1', 'i2']) }), // the session report, the close-out, the day sheet, the receipt
  sess('2026-09-26', { ...COMM }), // the Saturday roster
  sess('2026-09-27', { ...PETRO }), // billing: both companies and a ride with none
  sess('2026-10-01', {}), // a session report with nobody on it
  sess('2026-10-03', { ...COMM }), // a roster with nobody on it
];
const bikes = [
  { id: 'b01', name: 'Road 1', type: 'Road', size: 'M', status: 'in-use', brand: 'Alvas', model: 'Climax', bike_number: 1 },
  { id: 'b02', name: 'Hybrid 1', type: 'Hybrid', size: 'L', status: 'in-use', brand: 'Alvas', model: 'Cross 21S', bike_number: 2 },
  { id: 'b03', name: 'Mountain 1', type: 'Mountain', size: 'M', status: 'available', brand: 'Alvas', model: 'Strom M50', bike_number: 3 },
];
const customers = [
  { id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567', gender: 'female', birth_date: '1990-05-05', country: 'Saudi Arabia', nationality: 'Saudi Arabia', city: 'Jeddah', height: 165, type_preference: 'Road', created_at: '2026-08-20T10:00:00Z', default_pay: 'normal' },
  { id: 'c2', name: 'Omar Hassan', email: 'omar@example.test', phone: '0551234568', gender: 'male', birth_date: '1988-01-01', country: 'Saudi Arabia', nationality: 'Egypt', city: 'Riyadh', height: 180, type_preference: 'Hybrid', created_at: '2025-01-05T10:00:00Z', default_pay: 'normal' },
  { id: 'c3', name: 'Cara Vale', email: 'cara@example.test', phone: '0551234569', gender: 'female', birth_date: '1975-01-01', country: 'United Kingdom', nationality: 'United Kingdom', city: 'London', height: 170, type_preference: 'Mountain', created_at: '2026-09-01T10:00:00Z', default_pay: 'house' },
  { id: 'c4', name: 'Dan Noor', email: 'dan@example.test', phone: '0551234570', gender: 'male', birth_date: '2010-03-03', country: 'Saudi Arabia', nationality: 'Jordan', city: 'Jeddah', height: 150, type_preference: 'Kids', created_at: '2026-06-11T10:00:00Z', default_pay: 'normal' },
  { id: 'c5', name: 'Eman Saleh', email: 'eman@example.test', phone: '0551234571', gender: 'female', birth_date: '1999-07-07', country: 'Saudi Arabia', nationality: 'Saudi Arabia', city: 'Mecca', height: 160, type_preference: 'Road', created_at: '2026-04-02T10:00:00Z', default_pay: 'normal' },
  { id: 'c6', name: 'Fahad Omar', email: 'fahad@example.test', phone: '0551234572', gender: '', birth_date: '', country: '', nationality: '', city: '', height: null, type_preference: 'Any', created_at: '2025-11-20T10:00:00Z', default_pay: 'normal' },
];
const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#00e585', locked: true },
  { id: 'tag_vip', slug: 'vip', name: 'VIP', color: '#ff0000' },
];
const customer_tags = [
  { customer_id: 'c1', tag_id: 'tag_saturday', added_at: '2026-08-25T10:00:00Z', expires_at: null, starts_at: null },
  { customer_id: 'c3', tag_id: 'tag_vip', added_at: '2026-09-19T10:00:00Z', expires_at: null, starts_at: null },
  { customer_id: 'c5', tag_id: 'tag_saturday', added_at: '2026-09-01T10:00:00Z', expires_at: null, starts_at: null },
];
const q = (id: string, n: number, sid: string, o: Row) => ({
  id, session_id: sid, session_day: dayOf(sid), session_date: sid, queue_num: n, status: 'waiting', paid: false, price: 80,
  type_preference: 'Hybrid', size: 'M', height: 172, registered_at: '2026-09-15T10:00:00Z', ...o,
});
const queue_entries = [
  // tonight: every outcome, card, split and cash, add-ons paid and unpaid, a purchase on a booking
  q('j1', 1, TODAY, { name: 'Sara Ali', customer_id: 'c1', phone: '0551234567', status: 'done', paid: true, pay_method: 'card', assigned_bike_id: 'b01', type_preference: 'Road', height: 165, addons: js([{ id: 'i1', qty: 2 }]), purchases: js([{ name: 'Water', cat: 'Drinks', qty: 1, price: 5, pay: 'paid', id: 'i1' }]) }),
  q('j2', 2, TODAY, { name: 'Omar Hassan', customer_id: 'c2', phone: '0551234568', status: 'active', paid: true, pay_method: 'split', card_amount: 50, assigned_bike_id: 'b02', height: 180, checked_in_at: '2026-09-24T18:05:00Z' }),
  q('j3', 3, TODAY, { name: 'Cara Vale', customer_id: 'c3', phone: '0551234569', type_preference: 'Mountain', height: 170 }),
  q('j4', 4, TODAY, { name: 'Dana Reyes', phone: '0550000004', status: 'noshow', paid: true, pay_method: 'cash' }),
  q('j5', 5, TODAY, { name: 'Walk-in Rider', phone: '0550000005', status: 'done', price: 60, walk_in: true, height: null, addons: js([{ id: 'i2', qty: 1 }]) }),
  q('j6', 6, TODAY, { name: 'Faisal Noor', status: 'cancelled', paid: true }),
  q('j7', 7, TODAY, { name: 'Walk-in Two', status: 'waitlist', waitlist_num: 1 }),
  q('j8', 8, TODAY, { name: 'Kid Rider', status: 'done', paid: true, pay_method: 'cash', price: 40, type_preference: 'Kids', size: 'S', height: 120 }),
  // the heights report's other nights
  q('h1', 1, '2026-09-22', { name: 'Huda Rider', status: 'done', paid: true, type_preference: 'Road', height: 175, customer_id: 'c5' }),
  q('h2', 2, '2026-09-22', { name: 'Reem Rider', status: 'done', paid: true, type_preference: 'Mountain', height: 162 }),
  q('h3', 3, '2026-09-22', { name: 'Tariq Rider', status: 'done', paid: true, type_preference: 'Hybrid', height: 190, customer_id: 'c2' }),
  q('h4', 1, '2026-09-17', { name: 'No Height', status: 'done', paid: true, height: null, customer_id: 'c1' }),
  q('h5', 2, '2026-09-17', { name: 'Blank Height', status: 'done', paid: true, height: '' }),
  // the Saturday roster: approved, pending, on the waitlist
  q('s1', 1, '2026-09-26', { name: 'Jana Rider', customer_id: 'c1', phone: '0551234567', approval: 'approved', price: 0, height: 165, registered_at: '2026-09-20T08:00:00Z' }),
  q('s2', 2, '2026-09-26', { name: 'Hamad Rider', phone: '0550000012', approval: 'approved', price: 0, type_preference: 'Road', registered_at: '2026-09-20T09:00:00Z' }),
  q('s3', 3, '2026-09-26', { name: 'Rana Rider', approval: 'pending', price: 0, height: null, registered_at: '2026-09-21T09:00:00Z' }),
  q('s4', 4, '2026-09-26', { name: 'Majed Rider', customer_id: 'c2', status: 'waitlist', waitlist_num: 1, price: 0, registered_at: '2026-09-22T09:00:00Z' }),
];
const done = {
  source: 'petromin', created_at: '2026-09-27T09:00:00Z', updated_at: '2026-09-27T09:00:00Z', checked_in_at: '2026-09-27T17:05:00Z', checked_out_at: '2026-09-27T18:40:00Z',
  checked_in_by: 'Desk', checked_out_by: 'Desk', height: 170, phone: '+966500000001', submissions: 1, match_kind: 'none', matched_entry_id: null, matched_customer_id: null,
};
const rider_registrations = [
  { ...done, id: 1, session_id: '2026-09-27', booking_no: 'P-001', badge: 'A-1', company: 'Petromin', name: 'Min Road', type_preference: 'Road', price: 75 },
  { ...done, id: 2, session_id: '2026-09-27', booking_no: 'P-002', badge: 'A-2', company: 'Petromin', name: 'Min Hybrid', type_preference: 'Hybrid', price: 50 },
  { ...done, id: 3, session_id: '2026-09-27', booking_no: 'P-003', badge: 'A-3', company: 'Petromin', name: 'Min Old Fare', type_preference: 'Hybrid', price: 57.5 },
  { ...done, id: 4, session_id: '2026-09-27', booking_no: 'P-004', badge: 'A-4', company: 'Petromin', name: 'Min Mountain', type_preference: 'Mountain', price: 75 },
  { ...done, id: 5, session_id: '2026-09-27', booking_no: 'P-005', badge: 'B-1', company: 'Petrolube', name: 'Lube Hybrid', type_preference: 'Hybrid', price: 50 },
  { ...done, id: 6, session_id: '2026-09-27', booking_no: 'P-006', badge: 'C-1', company: null, name: 'No Company', type_preference: 'Hybrid', price: 50 },
  { ...done, id: 7, session_id: '2026-09-27', booking_no: 'P-007', badge: 'C-2', company: null, name: 'Nobody Either', type_preference: 'Road', price: 75 },
  { ...done, id: 8, session_id: '2026-09-27', booking_no: 'P-008', badge: 'A-5', company: 'Petromin', name: 'Still Riding', type_preference: 'Road', price: null, checked_out_at: null },
  { ...done, id: 9, session_id: '2026-09-20', booking_no: 'P-001', badge: 'A-1', company: 'Petromin', name: 'Earlier Night', type_preference: 'Road', price: 75, created_at: '2026-09-20T09:00:00Z', checked_in_at: '2026-09-20T17:05:00Z', checked_out_at: '2026-09-20T18:40:00Z' },
];
const inventory = [
  { id: 'i1', name: 'Water', brand: 'Nova', category: 'Drinks', qty: 30, price: 5, addon: true },
  { id: 'i2', name: 'Energy bar', category: 'Snacks', qty: 12, price: 8, addon: true },
  { id: 'i3', name: 'Helmet rental', category: 'Gear', qty: 6, price: 15, addon: true },
  { id: 'i4', name: 'Gloves', category: 'Gear', qty: 3, price: 20, addon: true },
];
// The till tonight, set on S.cashSales right before a print (the close-out and the receipt read it).
const sale = (id: string, rid: string, o: Row) => ({ id, receipt_id: rid, session_id: TODAY, qty: 1, created_at: at(TODAY, '20:05'), customer_name: 'Sara Ali', ...o });
const CASH_OK = [
  sale('x1', 'r1', { name: 'Water', category: 'Drinks', qty: 2, price: 5, pay: 'paid', item_id: 'i1' }),
  sale('x2', 'r1', { name: 'Energy bar', category: 'Snacks', price: 8, pay: 'paid', item_id: 'i2' }),
  sale('x3', 'r1', { name: 'Discount', category: '__discount__', price: -3, pay: 'paid' }),
  sale('x4', 'r1', { name: 'card', category: '__cardmeta__', qty: 0, price: 10, pay: 'paid' }),
  sale('x5', 'r2', { name: 'Helmet rental', category: 'Gear', price: 15, pay: 'house', item_id: 'i3', customer_name: null }),
  sale('x6', 'r3', { name: 'Gloves', category: 'Gear', price: 20, pay: 'team', team_name: 'Crew', item_id: 'i4' }),
  sale('x7', 'r4', { name: 'Energy bar', category: 'Snacks', price: 8, pay: 'pending', item_id: 'i2' }),
  sale('x8', 'r5', { name: 'Water', category: 'Drinks', price: 5, pay: 'refunded', item_id: 'i1' }),
];
// A paid line on a receipt that was partly refunded counts as collected but not as card or cash:
// the close-out says the drawer is out.
const CASH_OFF = [...CASH_OK, sale('x9', 'r5', { name: 'Energy bar', category: 'Snacks', price: 8, pay: 'paid', item_id: 'i2' })];
const FIX = { sessions, bikes, customers, tags, customer_tags, queue_entries, inventory, rider_registrations };

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function settle(page: Page) {
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await document.fonts.ready;
    // lazy pictures are made eager, so every run draws them loaded (and one below the fold is not waited for in vain)
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => { (i as HTMLImageElement).loading = 'eager'; });
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
    await new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 1000); }); // a window behind another gets no frames
    await Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
    await document.fonts.ready;
  });
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
async function minCss(page: Page) {
  if (!process.env.MIN_CSS) return;
  await page.route(/\/styles\.css/, async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, body: new CleanCSS({ level: 1 }).minify(await res.text()).styles });
  });
}

// Every window the page opens: its print is counted instead of shown, and the policy violations
// its document reports are kept on the page (listened for after the write, which is before any is
// dispatched: a violation event is a task of its own). Function form, so the strict tests can use it.
type Win = Window & { __printed: number; __popv: string[]; __atPrint?: { sheets: boolean; fonts: string; pictures: boolean } };
function watchWindows() {
  const page = window as unknown as Win;
  page.__popv = [];
  const open = window.open;
  window.open = function (...a: Parameters<typeof window.open>) {
    const w = open.apply(window, a) as Win | null;
    if (w && w.document) {
      w.__printed = 0;
      w.print = () => { // what the window holds when it prints: every sheet loaded, the fonts and the pictures in
        w.__printed++;
        try {
          const d = w.document;
          w.__atPrint = { sheets: [...d.querySelectorAll('link[rel="stylesheet"]')].every((l) => !!(l as HTMLLinkElement).sheet), fonts: d.fonts.status, pictures: [...d.images].every((i) => i.complete && i.naturalWidth > 0) };
        } catch { /* a closed window */ }
      };
      const d = w.document, write = d.write.bind(d);
      d.write = (...h: string[]) => {
        write(...h);
        d.addEventListener('securitypolicyviolation', (e) => {
          const el = e.target as Element | null;
          page.__popv.push(`${e.violatedDirective} <${el && el.nodeName ? el.nodeName.toLowerCase() : '?'}${el && (el as Element).className ? '.' + String((el as Element).className) : ''}> ${e.sample || ''}`);
        });
      };
    }
    return w;
  };
}

// While a window is open the page has no routes: with one in force, Playwright (1.63) leaves every
// request of an about:blank window it opens - its style sheets, its fonts, its logo - waiting for
// good. So the page's own fetches to another origin (Supabase above all) are held back meanwhile,
// never sent anywhere, and go out through the stub once its routes are back.
type Held = Window & { __holdNet: (on: boolean) => void };
function holdNet() {
  const f = window.fetch.bind(window);
  let gate: Promise<void> | null = null, lift: (() => void) | null = null;
  (window as unknown as Held).__holdNet = (on) => {
    if (on && !gate) gate = new Promise((r) => { lift = r; });
    else if (!on && gate && lift) { lift(); gate = null; }
  };
  window.fetch = (input, init) => {
    let cross = false;
    try { cross = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).origin !== location.origin; } catch { /* not a URL: left alone */ }
    return cross && gate ? gate.then(() => f(input, init)) : f(input, init);
  };
}
const stubs = new WeakMap<Page, Record<string, unknown>>();
async function stub(page: Page, fx: Record<string, unknown>) {
  stubs.set(page, fx);
  await minCss(page);
  await stubSupabase(page, fx);
}
async function withoutRoutes<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  await page.evaluate(() => (window as unknown as Held).__holdNet(true));
  await page.unrouteAll({ behavior: 'wait' });
  try { return await fn(); } finally {
    await stub(page, stubs.get(page) || FIX);
    await page.evaluate(() => (window as unknown as Held).__holdNet(false));
  }
}

type Open = { lang: string; fx?: Record<string, unknown>; customer?: boolean };
async function open(page: Page, o: Open) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(holdNet);
  await stub(page, { ...FIX, ...(o.fx || {}) });
  if (!o.customer) await unlockStaff(page);
  await page.addInitScript((lang) => {
    localStorage.setItem('cq_lang', lang);
    localStorage.setItem('cq_lang_pick', '1');
  }, o.lang);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, o.lang);
  await page.waitForFunction(o.customer ? `S.view==='landing'` : `S.view==='staff'`, undefined, { timeout: 30000 }); // signed out, a customer lands on the event picker
  await page.waitForFunction(`getComputedStyle(document.getElementById('loading-screen')).display==='none'`);
  await page.evaluate(`window._tickRefreshLabel=function(){};window._sb=function(){return 'auto'}`);
  await page.evaluate(watchWindows);
}
declare const _langLoaded: (l: string) => boolean; // app global

const audits: Record<string, AuditRow[]> = {};
async function audit(page: Page, name: string, roots: string[]) {
  const mode = process.env.AUDIT;
  if (mode !== 'inline' && mode !== 'class') return;
  const rows = await page.evaluate(cascadeAudit, { roots, classes: CLASSES, inline: mode === 'inline' });
  if (mode === 'inline') audits[name] = rows;
  else expect.soft(rows.filter((r) => r.hits.length), name).toEqual([]);
}
const snapHashes = (h: Record<string, string>, name: string) => expect.soft(JSON.stringify(h, null, 0).replace(/","/g, '",\n"')).toMatchSnapshot(name + '.css.txt');

// A document of its own (a window, the 404 page): the body's elements and the root element, whose
// style its own sheet decides too. The head is left out: its <style> becomes a <link> by design.
async function docHashes(page: Page) {
  const h = await page.evaluate(styleHashes, { roots: ['body'], ignore: '^--rp-', stripOrigin: true });
  const root = await page.evaluate(styleOf, 'html');
  delete root['(element)']; // its markup, head included
  return { ':root': createHash('md5').update(JSON.stringify(root)).digest('hex').slice(0, 8), ...h };
}

// cascadeAudit reads the sheets named styles.css. A document of its own has its own rules (a
// <style> before, a linked sheet after): they are copied into a blob named so, added last, once
// every shot is taken.
async function auditDoc(page: Page, name: string) {
  if (process.env.AUDIT !== 'inline' && process.env.AUDIT !== 'class') return;
  await page.evaluate(() => new Promise((res) => {
    const css = [...document.styleSheets].filter((s) => !/\/fonts\//.test(s.href || '')).map((s) => [...s.cssRules].map((r) => r.cssText).join('\n')).join('\n');
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = URL.createObjectURL(new Blob([css], { type: 'text/css' })) + '#/styles.css';
    l.onload = l.onerror = res;
    document.head.appendChild(l);
  }));
  await audit(page, name, ['body']);
}

// A state drawn on the page: a screenshot (the viewport, or one element) and every element's style.
async function shot(page: Page, name: string, o: { el?: string; roots?: string[] } = {}) {
  await quiet(page);
  await settle(page);
  if (o.el) await expect.soft(page.locator(o.el)).toHaveScreenshot(name + '.png', { timeout: 30000 });
  else await expect.soft(page).toHaveScreenshot(name + '.png', { timeout: 30000 });
  await quiet(page);
  snapHashes(await page.evaluate(styleHashes, { roots: ['body'], stripOrigin: true }), name);
  await audit(page, name, o.roots || ['body']);
}

// A window: open it, wait for its print, then the screen and the printed page, each a screenshot
// and every element's style (the root's too: the document's own sheet decides it), and the PDF.
async function win(page: Page, vpName: string, name: string, call: string) {
  await withoutRoutes(page, () => winShots(page, vpName, name, call));
}
async function winShots(page: Page, vpName: string, name: string, call: string) {
  const [pop] = await Promise.all([page.waitForEvent('popup'), page.evaluate(call)]);
  await pop.waitForFunction(() => (window as unknown as Win).__printed >= 1, undefined, { timeout: 30000 });
  if (vpName === 'phone') await pop.setViewportSize(VIEWPORTS.phone.viewport); // a phone opens it as a tab
  await pop.bringToFront();
  for (const media of ['screen', 'print'] as const) {
    await pop.emulateMedia({ media });
    await settle(pop);
    const n = media === 'print' ? name + '-print' : name;
    await expect.soft(pop).toHaveScreenshot(n + '.png', { fullPage: true, timeout: 30000 });
    snapHashes(await docHashes(pop), n);
  }
  if (vpName === 'desktop') {
    const pdf = (await pop.pdf({ printBackground: true, preferCSSPageSize: true })).toString('latin1').replace(/\/(CreationDate|ModDate) ?\([^)]*\)/g, '');
    expect.soft(`${createHash('md5').update(pdf).digest('hex')} ${(pdf.match(/\/Type ?\/Page\b/g) || []).length} pages\n`).toMatchSnapshot(name + '.pdf.txt');
  }
  await pop.emulateMedia({ media: 'screen' });
  await auditDoc(pop, name);
  await pop.close();
  await page.bringToFront();
}

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  if (process.env.AUDIT !== 'inline' || !Object.keys(audits).length) return;
  mkdirSync(join(SNAPS, '_audit'), { recursive: true });
  writeFileSync(join(SNAPS, '_audit', info.title.replace(/\W+/g, '_') + '-' + info.project.name + '-' + info.workerIndex + '-' + Date.now() + '.json'), JSON.stringify(audits, null, 1));
  for (const k of Object.keys(audits)) delete audits[k];
});

const ACC_ALL = `S._accOpts={..._accDefaults(),sections:{summary:1,natCount:1,tags:1},natTop:10,fPay:'normal',
  chartsOn:{tags:1,gender:1,age:1,city:1,country:1,nationality:1,type:1,joined:1,rides:1,active:1,active14:1,active30:1},
  charts:{tags:'donut',gender:'pie',age:'bar',city:'hbar',country:'table',nationality:'pie',type:'bar',joined:'line',rides:'bar',active:'hbar',active14:'donut',active30:'line'}};`;

test.describe.configure({ timeout: 300000 }); // a loaded machine runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:reports ${vpName}`, () => {
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`session reports and rosters ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`S.cashSales=${js(CASH_OK)}`);
        await win(page, vpName, `${P}-session`, `S.sfSession='${TODAY}';printSessionReport()`);
        await win(page, vpName, `${P}-session-empty`, `S.sfSession='2026-10-01';printSessionReport()`);
        await win(page, vpName, `${P}-roster`, `S.sfSession='2026-09-26';printSessionReport()`);
        await win(page, vpName, `${P}-roster-empty`, `S.sfSession='2026-10-03';printSessionReport()`);
        await win(page, vpName, `${P}-daysheet`, `_ws().jobs=[{name:'Tune for Sara',bike:'Road 1',service_label:'Tune-up',status:'in_workshop',scheduled_for:'${TODAY}'},{name:'Brakes',bike:'Hybrid 1',service:'brakes',status:'ready'}];printDaySheet()`);
      });

      test(`close-out and receipts ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await win(page, vpName, `${P}-closeout`, `S.cashSales=${js(CASH_OK)};S._ctSession='${TODAY}';printCloseout()`);
        await win(page, vpName, `${P}-closeout-off`, `S.cashSales=${js(CASH_OFF)};S._ctSession='${TODAY}';printCloseout()`);
        await win(page, vpName, `${P}-receipt`, `S.cashSales=${js(CASH_OK)};_ctPrintReceipt(S.cashSales.filter(r=>r.receipt_id==='r1'),'Sara Ali','${at(TODAY, '20:05')}')`);
        await win(page, vpName, `${P}-receipt-walkup`, `_ctPrintReceipt([{id:'y1',receipt_id:'y',session_id:null,name:'Helmet rental',category:'Gear',qty:1,price:15,pay:'paid'},{id:'y2',receipt_id:'y',session_id:null,name:'Water',category:'Drinks',qty:3,price:5,pay:'paid'}],'','${at(TODAY, '19:40')}')`);
      });

      test(`account reports ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await win(page, vpName, `${P}-accounts`, `${ACC_ALL}printAccountReport()`);
        // one account: a one-slice donut and pie are whole rings, the bars and lines one mark
        await win(page, vpName, `${P}-accounts-one`, `${ACC_ALL}S._accOpts.fPay='house';S._accOpts.sections={summary:0,natCount:1,tags:0};printAccountReport()`);
        // nobody on the list (the dialog's Print refuses; the sheet itself draws the empty row)
        await win(page, vpName, `${P}-accounts-empty`, `${ACC_ALL}S._accOpts.fTag='none';S._accOpts.fPay='house';_openReport(_accReportHtml(),1200,800)`);
      });

      test(`billing and heights reports ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`setStaffTab('riders')`);
        await page.waitForFunction(`(S.riders||[]).length===${rider_registrations.length}`);
        await win(page, vpName, `${P}-billing-petromin`, `S.ridersSession='all';printRidersReport('Petromin')`);
        await win(page, vpName, `${P}-billing-petrolube`, `S.ridersSession='all';printRidersReport('Petrolube')`);
        await win(page, vpName, `${P}-heights`, `S.analyticsRange='all';S.anSession='all';printHeightBikeReport()`);
      });

      test(`billing report dialog ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`setStaffTab('riders')`);
        await page.waitForFunction(`(S.riders||[]).length===${rider_registrations.length}`);
        await page.evaluate(`S.ridersSession='all';openRidersReport()`);
        await shot(page, `${P}-billing-dialog`, { roots: ['#rider-report-modal'] });
        await page.evaluate(`S.ridersSession='2026-09-20';_renderRidersReport()`); // Petrolube has nothing to bill, nothing lacks a company
        await shot(page, `${P}-billing-dialog-one`, { roots: ['#rider-report-modal'] });
        await page.evaluate(`closeRidersReport()`);
      });

      for (const customer of [false, true]) {
        test(`new-build bar ${customer ? 'customer' : 'staff'} ${lang}`, async ({ page }) => {
          await open(page, { lang, customer });
          await page.evaluate(() => {
            window.dispatchEvent(new Event('pointerdown')); // a person is using the page: the bar, not a reload
            navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'shell-updated' } }));
          });
          await page.locator('#upd-bar').waitFor();
          const n = `${P}-updbar-${customer ? 'customer' : 'staff'}`;
          await shot(page, n, { roots: ['#upd-bar'] });
          await page.locator('#upd-bar button').hover();
          await shot(page, n + '-hover', { el: '#upd-bar', roots: ['#upd-bar'] });
          await page.mouse.move(0, 0);
        });
      }
    }

    test('the 404 page', async ({ page }) => {
      await minCss(page);
      const res = await page.goto('/no-such-page/at-all');
      expect(res!.status()).toBe(404);
      await settle(page);
      await expect.soft(page).toHaveScreenshot(`${vpName}-404.png`, { timeout: 30000 });
      snapHashes(await docHashes(page), `${vpName}-404`);
      await page.locator('a').hover();
      await expect.soft(page).toHaveScreenshot(`${vpName}-404-hover.png`, { timeout: 30000 });
      snapHashes(await docHashes(page), `${vpName}-404-hover`);
      await auditDoc(page, `${vpName}-404`);
    });
  });
}

// ── When a window prints ──────────────────────────────────────────────────────────────────
// _printWhenReady on a document the test can slow down: an iframe's, whose requests go through the
// page's routes (a window's cannot, see withoutRoutes). The print waits for a slow sheet, prints after
// a failed one, and never goes before its floor.
test.describe('@visual:reports print timing', () => {
  test.use(VIEWPORTS.desktop);
  test('a window prints once its sheet has arrived, and never before the floor', async ({ page }) => {
    await stubSupabase(page, FIX);
    await unlockStaff(page);
    await page.route(/\/report\.css\?slow/, async (r) => { await new Promise((res) => setTimeout(res, 1500)); await r.continue(); });
    await page.route(/\/report\.css\?broken/, (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto('/');
    await waitForSb(page);
    const printAfter = async (href: string) => {
      const t0 = Date.now();
      const bg = await page.evaluate(`new Promise((res)=>{const f=document.createElement('iframe');document.body.appendChild(f);const d=f.contentDocument;d.open();
        d.write('<!doctype html><html><head>'+(${js(href)}?'<link rel="stylesheet" href="'+location.origin+${js(href)}+'">':'')+'</head><body><div class="mm-banner">x</div></body></html>');d.close();
        _printWhenReady({document:d,print(){res(getComputedStyle(d.querySelector('.mm-banner')).backgroundColor);f.remove();}},400);})`) as string;
      return { ms: Date.now() - t0, bg };
    };
    const slow = await printAfter('/report.css?slow=1');
    expect(slow.ms).toBeGreaterThanOrEqual(1500);
    expect(slow.bg).toBe('rgb(18, 48, 25)'); // styled when it prints
    const broken = await printAfter('/report.css?broken=1');
    expect(broken.ms).toBeGreaterThanOrEqual(400);
    expect(broken.ms).toBeLessThan(1500); // a sheet that fails does not hold the print
    const none = await printAfter('');
    expect(none.ms).toBeGreaterThanOrEqual(400);
    // a bare stand-in window (the specs') prints after the floor
    const t0 = Date.now();
    await page.evaluate(`new Promise((res)=>_printWhenReady({document:{},print:res},400))`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });
});

// ── The policy without 'unsafe-inline' ──────────────────────────────────────────────────────
// The server's policy, with style-src 'self' in place of style-src 'self' 'unsafe-inline' (and
// 'report-sample', so a refused style names itself). Every call is in function form: string-form
// evaluate is eval, which the page's policy forbids (tests/csp.spec.ts).
declare const S: Record<string, unknown>;
declare const sb: unknown;
declare const _lastLoadOk: boolean | undefined;
declare const _refsLoaded: boolean | undefined;
declare function printSessionReport(): void;
declare function printCloseout(): void;
declare function printDaySheet(): void;
declare function printAccountReport(): void;
declare function printRidersReport(co: string): void;
declare function printHeightBikeReport(): void;
declare function openRidersReport(): void;
declare function closeRidersReport(): void;
declare function setStaffTab(t: string): void;
declare function _ctPrintReceipt(rows: unknown[], cust: string, at: string): void;
declare function _accDefaults(): Record<string, unknown>;
declare function _ws(): { jobs: unknown[] };
async function strictPolicy(page: Page) {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const res = await route.fetch();
    const h = res.headers();
    const csp = h['content-security-policy'] || '';
    if (!/style-src 'self'/.test(csp) || /style-src[^;]*'unsafe-inline'/.test(csp)) throw new Error('the served policy has changed: ' + csp); // Served this way since 2026-09-29: the page's own style-src has no 'unsafe-inline' left to take away.
    h['content-security-policy'] = csp.replace("style-src 'self' 'unsafe-inline'", "style-src 'self' 'report-sample'");
    await route.fulfill({ response: res, headers: h });
  });
}
type PV = Window & { __pv: string[] };
const pageViolations = (page: Page) => page.addInitScript(() => {
  (window as unknown as PV).__pv = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    const el = e.target as Element | null;
    const where = el && el.closest ? (el.closest('#rider-report-modal, #upd-bar') ? 'mine' : 'other') : 'document';
    (window as unknown as PV).__pv.push(`${where} ${e.violatedDirective} <${el && el.nodeName ? el.nodeName.toLowerCase() : '?'}> ${e.sample || ''}`);
  });
});

test.describe('@visual:reports strict', () => {
  test.use({ bypassCSP: false, ...VIEWPORTS.desktop });
  for (const lang of ['en', 'ar']) {
    test(`no window, dialog or bar writes a style the policy refuses ${lang}`, async ({ page, context }) => {
      const opened: Page[] = [];
      const winConsole: string[] = [];
      context.on('page', (p) => { opened.push(p); p.on('console', (m) => { if (/Content Security Policy/.test(m.text())) winConsole.push(m.text().slice(0, 160)); }); });
      await page.clock.setFixedTime(NOW);
      await strictPolicy(page);
      await pageViolations(page);
      await page.addInitScript(holdNet);
      await stub(page, FIX);
      await unlockStaff(page);
      await page.addInitScript((l) => { localStorage.setItem('cq_lang', l); localStorage.setItem('cq_lang_pick', '1'); }, lang);
      await page.goto('/');
      await page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && !!S.dataLoaded
        && (typeof _lastLoadOk === 'undefined' || _lastLoadOk === true) && (typeof _refsLoaded === 'undefined' || _refsLoaded === true), undefined, { timeout: 15000 });
      await page.waitForFunction(() => S.view === 'staff' && document.documentElement.lang === document.documentElement.lang);
      await page.evaluate(watchWindows);
      const calls: [string, (a: { today: string; cash: unknown[]; off: unknown[] }) => void][] = [
        ['session', (a) => { S.cashSales = a.cash; S.sfSession = a.today; printSessionReport(); }],
        ['session-empty', () => { S.sfSession = '2026-10-01'; printSessionReport(); }],
        ['roster', () => { S.sfSession = '2026-09-26'; printSessionReport(); }],
        ['roster-empty', () => { S.sfSession = '2026-10-03'; printSessionReport(); }],
        ['daysheet', (a) => { _ws().jobs = [{ name: 'Tune', bike: 'Road 1', service_label: 'Tune-up', status: 'in_workshop', scheduled_for: a.today }]; printDaySheet(); }],
        ['closeout', (a) => { S.cashSales = a.cash; S._ctSession = a.today; printCloseout(); }],
        ['closeout-off', (a) => { S.cashSales = a.off; S._ctSession = a.today; printCloseout(); }],
        ['receipt', (a) => { _ctPrintReceipt((a.cash as { receipt_id: string }[]).filter((r) => r.receipt_id === 'r1'), 'Sara Ali', a.today + 'T20:05:00+03:00'); }],
        ['accounts', () => {
          S._accOpts = { ..._accDefaults(), sections: { summary: 1, natCount: 1, tags: 1 }, fPay: 'normal',
            chartsOn: { tags: 1, gender: 1, age: 1, city: 1, country: 1, nationality: 1, type: 1, joined: 1, rides: 1, active: 1, active14: 1, active30: 1 },
            charts: { tags: 'donut', gender: 'pie', age: 'bar', city: 'hbar', country: 'table', nationality: 'pie', type: 'bar', joined: 'line', rides: 'bar', active: 'hbar', active14: 'donut', active30: 'line' } };
          printAccountReport();
        }],
        ['heights', () => { S.analyticsRange = 'all'; S.anSession = 'all'; printHeightBikeReport(); }],
      ];
      const arg = { today: TODAY, cash: CASH_OK, off: CASH_OFF };
      // Each window: nothing refused, and its sheet did arrive (the banner wears its green).
      const check = (label: string, call: (a: typeof arg) => void) => withoutRoutes(page, async () => {
        const [pop] = await Promise.all([page.waitForEvent('popup'), page.evaluate(call, arg)]);
        await pop.waitForFunction(() => (window as unknown as Win).__printed >= 1, undefined, { timeout: 30000 });
        await pop.waitForTimeout(100);
        expect.soft(await page.evaluate(() => (window as unknown as Win).__popv.splice(0)), label).toEqual([]);
        expect.soft(await pop.evaluate(() => getComputedStyle(document.querySelector('.mm-banner')!).backgroundColor), label).toBe('rgb(18, 48, 25)');
        // the floor is timed in the print timing test (this page's clock is frozen)
        expect.soft(await pop.evaluate(() => (window as unknown as Win).__atPrint), label + ' printed').toEqual({ sheets: true, fonts: 'loaded', pictures: true });
        await pop.close();
      });
      for (const [label, call] of calls) await check(label, call);
      await page.evaluate(() => { setStaffTab('riders'); });
      await page.waitForFunction((n) => ((S.riders as unknown[]) || []).length === n, rider_registrations.length);
      await check('billing', () => { S.ridersSession = 'all'; printRidersReport('Petromin'); });
      // the dialog and the bar, on the page
      await page.evaluate(() => { openRidersReport(); });
      await page.locator('#rider-report-modal .modal-box').waitFor();
      await page.evaluate(() => {
        window.dispatchEvent(new Event('pointerdown'));
        navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'shell-updated' } }));
      });
      await page.locator('#upd-bar').waitFor();
      await page.waitForTimeout(200);
      expect.soft((await page.evaluate(() => (window as unknown as PV).__pv)).filter((v) => v.startsWith('mine')), 'dialog and bar').toEqual([]);
      await page.evaluate(() => { closeRidersReport(); });
      expect.soft(opened.length, 'windows opened').toBe(11);
      expect.soft(winConsole, 'the windows\' consoles').toEqual([]);
    });
  }

  test('the 404 page', async ({ page }) => {
    await strictPolicy(page);
    await pageViolations(page);
    const res = await page.goto('/no-such-page/at-all');
    expect(res!.status()).toBe(404);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as unknown as PV).__pv)).toEqual([]);
  });
});
