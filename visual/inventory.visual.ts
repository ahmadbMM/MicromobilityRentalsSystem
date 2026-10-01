import { test, expect, type Page, type Locator } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

declare const _langLoaded: (l: string) => boolean; // app global
// The app's globals, for the function-form calls of the strict-policy check (const/let bindings are not window properties).
declare const S: Record<string, unknown>;
declare const sb: unknown;
declare const _lastLoadOk: boolean | undefined;
declare const _refsLoaded: boolean | undefined;
declare function setStaffTab(tab: string): void;
declare function renderInventory(): void;
declare function toggleAddInv(): void;
declare function startInvEdit(id: string): void;
declare function renderRiders(): void;
declare function openRiderModal(id: number): void;
declare function closeRiderModal(): void;
declare function showRiderWalkin(): void;
declare function showRiderEdit(id: number): void;
declare function renderRiderWalkin(): void;
declare function closeRiderWalkin(): void;
declare function _showCustomPriceModal(): void;

// The inventory pass of the inline-style move (playwright.visual.config.ts says how to run it):
// Inventory's Equipment and Supplements sections (not Bikes) - the grid and the table, the
// category and Protein Snacks headings, the reorder card, the stock take, the search, sort and
// filters, the empty list, the add and edit forms with every dropdown in its add-your-own mode,
// the Free price, a photo and the nutrition facts - and the custom rental price dialog; and the
// Petromin page in Bookings (renderRiders) - single riders in every desk state, Petromin and
// Petrolube, a folded party and an open one, every night, the filters, nothing found - with the
// booking pop-up (_renderRiderModal) and the walk-in / edit form (renderRiderWalkin) in each of
// their states. Every state is a screenshot and a hash of the computed style of every element on
// the page (cascade-audit.ts), in English and Arabic, at 1280x900 and 390x844, from fixed data on
// a frozen clock. The switches are pass2.visual.ts's: AUDIT=inline, AUDIT=class with
// AUDIT_CLASSES, MIN_CSS=1, CSS_DUMP. MIN_CSS=1 compares against a baseline of its own, taken from
// the untouched build with MIN_CSS=1 into another VISUAL_SNAPS (the minifier changes rules outside
// this pass too). The last test (--grep strict) turns the policy's style-src 'unsafe-inline' off and
// walks the same screens: nothing these functions write may be refused.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
const PAST = '2026-09-17';
const SNAPS = process.env.VISUAL_SNAPS || join(tmpdir(), 'mm-visual-snaps');
const CLASSES = process.env.AUDIT_CLASSES ? readFileSync(process.env.AUDIT_CLASSES, 'utf8').split(/\s+/).filter(Boolean) : [];

type Row = Record<string, unknown>;
const js = (o: unknown) => JSON.stringify(o);
const tot = (time: string, n: number) => js({ _time: time, _total: n });
const PM = TODAY + '-pm', PM0 = PAST + '-pm';
const pmSess = (id: string, d: string, o: Row) => ({
  id, day: 'Thursday', session_date: d, capacity: 30, status: 'open', location: 'JCC', created_at: 1, event_kind: 'community',
  ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false, title: 'Petromin Night', bike_slots: tot('21:00 - 23:00', 30), ...o,
});
const sessions = [
  pmSess(PM0, PAST, { status: 'closed', bike_slots: tot('19:00 - 21:00', 30) }),
  { id: TODAY, day: 'Thursday', session_date: TODAY, capacity: 12, status: 'open', location: 'JCC', bike_slots: tot('21:00 - 23:00', 12), created_at: 2 },
  pmSess(PM, TODAY, { created_at: 3 }),
];
const at = (hm: string, d = TODAY) => `${d}T${hm}:00+03:00`;
let rid = 0;
const reg = (o: Row) => ({
  id: ++rid, source: 'petromin', session_id: PM, created_at: at('09:00'), updated_at: at('09:00'), price: null, company: 'Petromin',
  checked_in_at: null, checked_out_at: null, checked_in_by: null, checked_out_by: null, submissions: 1, party_no: 1,
  matched_entry_id: null, matched_customer_id: null, match_kind: 'none', ...o,
});
const rider_registrations = [
  reg({ booking_no: 'P-001', badge: 'A-12', name: 'Amal Waiting', phone: '+966500000001', height: 170, type_preference: 'Hybrid' }), // 1
  reg({ booking_no: 'P-002', badge: 'B-34', company: 'Petrolube', name: 'Bader Riding', phone: '+966500000002', height: 180, type_preference: 'Road', submissions: 2, checked_in_at: at('20:05'), checked_in_by: 'Desk One' }), // 2
  reg({ booking_no: 'P-003', badge: 'C-56', name: 'Cara Returned', phone: '+966500000003', height: 160, type_preference: 'Mountain', checked_in_at: at('19:10'), checked_out_at: at('20:25'), checked_in_by: 'Desk One', checked_out_by: 'Desk Two' }), // 3
  // a party of three, folded: the employee waiting, one companion out, one back
  reg({ booking_no: 'P-004', badge: 'D-78', name: 'Dana Lead', phone: '+966500000004', height: 175, type_preference: 'Hybrid' }), // 4
  reg({ booking_no: 'P-004', badge: 'D-78', party_no: 2, name: 'Dana Second', phone: null, height: 150, type_preference: 'Mountain', checked_in_at: at('20:00'), checked_in_by: 'Desk One' }), // 5
  reg({ booking_no: 'P-004', badge: 'D-78', party_no: 3, name: 'Dana Third', phone: null, height: 140, type_preference: 'Road', checked_in_at: at('19:30'), checked_out_at: at('20:15'), checked_in_by: 'Desk One', checked_out_by: 'Desk One' }), // 6
  // a party of two, opened: the employee out, the companion waiting
  reg({ booking_no: 'P-005', badge: 'E-90', company: 'Petrolube', name: 'Eman Lead', phone: '+966500000005', height: 165, type_preference: 'Road', checked_in_at: at('20:10'), checked_in_by: 'Desk Two', submissions: 3 }), // 7
  reg({ booking_no: 'P-005', badge: 'E-90', company: 'Petrolube', party_no: 2, name: 'Eman Second', phone: null, height: 120, type_preference: 'Hybrid' }), // 8
  // no phone, no height, no company
  reg({ booking_no: 'P-006', badge: 'F-11', company: null, name: 'Fahad Plain', phone: null, height: null, type_preference: 'Road' }), // 9
  // last week's night, and a registration from before rides had sessions
  reg({ booking_no: 'P-001', badge: 'G-22', session_id: PM0, name: 'Ghada Last Week', phone: '+966500000007', height: 168, type_preference: 'Hybrid', checked_in_at: at('19:05', PAST), checked_out_at: at('20:40', PAST), checked_in_by: 'Desk One', checked_out_by: 'Desk Two' }), // 10
  reg({ booking_no: 'P-009', badge: 'H-33', session_id: null, name: 'Hind No Night', phone: '+966500000008', height: 158, type_preference: 'Mountain' }), // 11
];
const NU = { serving: '1 bar (60 g)', kcal: 210, fat_g: 7, carbs_g: 20, protein_g: 20, ingredients: 'Whey, oats' };
const inventory = [
  // Equipment: Helmet (a photo, free, low; out; in) and a custom category
  { id: 'e1', name: 'Road Helmet', brand: 'Kask', category: 'Helmet', qty: 2, low_threshold: 3, price: 0, photo: '/icon-192.png' },
  { id: 'e2', name: 'Kids Helmet', brand: 'Giro', category: 'Helmet', qty: 0, low_threshold: 1, price: 45 },
  { id: 'e3', name: 'Commuter Helmet', category: 'Helmet', qty: 9, low_threshold: 2, price: 60 },
  { id: 'e4', name: 'Bottle Cage', brand: 'Elite', category: 'Accessory', qty: 14, low_threshold: 4, price: 25 },
  // Supplements: Protein Snacks in two types, sachets, gels, a drink with its volume
  { id: 's1', name: 'Protein Cookie', brand: 'Grenade', flavour: 'Chocolate', category: 'ProteinCookies', qty: 12, low_threshold: 4, price: 12, nutrition: NU, photo: '/icon-192.png' },
  { id: 's2', name: 'Protein Bar', brand: 'Grenade', flavour: 'Caramel', category: 'ProteinBars', qty: 3, low_threshold: 4, price: 14 },
  { id: 's3', name: 'Electrolyte Sachet', brand: 'Nuun', flavour: 'Lemon', category: 'ElectrolyteSachets', qty: 0, low_threshold: 5, price: 6 },
  { id: 's4', name: 'Energy Gel', brand: 'Maurten', category: 'EnergyGels', qty: 20, low_threshold: 5, price: 15 },
  { id: 's5', name: 'Sparkling Water', brand: 'Nova', flavour: 'Lime', category: 'Drinks', qty: 30, low_threshold: 6, price: 5, volume_ml: 330 },
];
const cashier_sales = [
  { id: 1, item_id: 'e1', qty: 3, pay: 'paid', category: 'Helmet', price: 0, created_at: at('19:00'), session_id: TODAY },
  { id: 2, item_id: 's3', qty: 7, pay: 'paid', category: 'ElectrolyteSachets', price: 6, created_at: at('19:10'), session_id: TODAY },
];
const FIX = { sessions, rider_registrations, inventory, cashier_sales, queue_entries: [], bikes: [] };

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function settle(page: Page) {
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await document.fonts.ready;
    // lazy pictures (the item cards) are made eager, so every run draws them loaded
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
  // the Bookings refresh label moves on its own; a scroll-into-view is instant, so a shot never catches one halfway.
  // An admin sees every button these pages draw (Delete, the billing report).
  await page.evaluate(`window._tickRefreshLabel=function(){};window._sb=function(){return 'auto'};S.staffRole='admin'`);
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
  if (o.el) await expect.soft(o.el).toHaveScreenshot(name + '.png', { timeout: 30000 });
  else await expect.soft(page).toHaveScreenshot(name + '.png', { fullPage: o.full !== false, timeout: 30000 });
  // Taking the screenshot flips (max-width:767px) and back for a moment, and Bookings redraws on
  // that change (the Petromin page with it). Wait again.
  await quiet(page);
  const hashes = await page.evaluate(styleHashes, { roots: ['body'], ignore: '^--iv-', stripOrigin: true });
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
// A dialog taller than the screen scrolls inside itself: one viewport shot per screenful.
async function shotScroll(page: Page, name: string, box: string) {
  await quiet(page);
  const n = await page.evaluate((s) => { const b = document.querySelector(s); if (!b) return 1; b.scrollTop = 0; return Math.max(1, Math.ceil((b.scrollHeight - b.clientHeight) / Math.max(1, Math.floor(b.clientHeight * 0.8))) + 1); }, box);
  for (let i = 0; i < n; i++) {
    await page.evaluate(([s, k]) => { const b = document.querySelector(s as string); if (b) b.scrollTop = Math.floor(b.clientHeight * 0.8) * (k as number); }, [box, i]);
    await shot(page, `${name}-${i}`, { full: false });
  }
}
// Each evaluate draws a state; the page goes back to the top so a full-page shot starts there.
const draw = (page: Page, code: string) => page.evaluate(code + ';window.scrollTo(0,0)');
const INV_READY = `!!document.querySelector('#tab-inventory .inv-content')`;
const WALKIN = '#rider-walkin-modal .modal-box';
const CLOSED = `(typeof _modalWasOpen==='undefined'||!_modalWasOpen)&&document.activeElement===document.body`;
const PM_READY = `!!document.querySelector('#pm-host #riders-results tbody tr')&&S.ridersLoaded`;
// A section with its list controls reset (no form, no stock take, no search, sort or filter), so each state starts from the same place.
const invSec = (sec: string) => `S.invSection='${sec}';S.showAddInv=false;S.editInvId=null;S.invCount=false;S.invCounts={};S.invSearch='';S.invSort='cat';S.invStock='all';S.invBrand='all';S._fOpen={};`;

test.describe.configure({ timeout: 300000 }); // a loaded machine runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:inventory ${vpName}`, () => {
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`inventory lists ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`S.invSection='equipment';S.invView='grid';setStaffTab('inventory')`);
        await page.waitForFunction(INV_READY);
        for (const sec of ['equipment', 'supplements']) {
          const k = sec.slice(0, 5);
          await draw(page, `${invSec(sec)}S.invView='grid';renderInventory()`);
          await shot(page, `${P}-iv-${k}-grid`);
          await draw(page, `S.invView='table';renderInventory()`);
          await shot(page, `${P}-iv-${k}-table`);
          await draw(page, `S.invCount=true;S.invCounts={${sec === 'equipment' ? `e1:'5',e3:'9'` : `s1:'10',s4:'20'`}};renderInventory()`);
          await shot(page, `${P}-iv-${k}-count-table`);
          await draw(page, `S.invView='grid';renderInventory()`);
          await shot(page, `${P}-iv-${k}-count-grid`);
          await draw(page, `S.invCount=false;S.invCounts={};S.invSort='name';S._fOpen={inv:true};S.invStock='all';renderInventory()`);
          await shot(page, `${P}-iv-${k}-sorted-filters`);
          await draw(page, `S._fOpen={};S.invSort='cat';S.invSearch='zzzz';renderInventory()`);
          await shot(page, `${P}-iv-${k}-none`);
        }
        await draw(page, `${invSec('supplements')}S.invView='table';S.invSearch='protein';renderInventory()`);
        await shot(page, `${P}-iv-supp-search`); // a flat list, not grouped
        // a section with no items at all, and one whose items are all in stock (no reorder card)
        await draw(page, `${invSec('equipment')}S.invView='grid';S.inventory=S.inventory.filter(i=>i.id!=='e1'&&i.id!=='e2');renderInventory()`);
        await shot(page, `${P}-iv-equip-no-reorder`);
        await draw(page, `S.inventory=S.inventory.filter(i=>/^s/.test(i.id));renderInventory()`);
        await shot(page, `${P}-iv-equip-empty`);
        // the grid card's border under the pointer (the inline colour beat .bike-grid-card:hover)
        await draw(page, `${invSec('supplements')}S.invView='grid';renderInventory()`);
        await quiet(page);
        await page.locator('#tab-inventory .bike-grid-card').first().hover();
        await shot(page, `${P}-iv-card-hover`, { full: false });
        await page.mouse.move(0, 0);
      });

      test(`inventory forms ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`S.invSection='equipment';S.invView='grid';setStaffTab('inventory')`);
        await page.waitForFunction(INV_READY);
        const form = page.locator('#tab-inventory .inline-form');
        await draw(page, `${invSec('equipment')}toggleAddInv()`);
        await shot(page, `${P}-iv-add-equip`, { el: form });
        await draw(page, `S._invName='Aero Helmet';S._invQty='4';S._invLow='1';S._invFree=true;S._invPhoto='/icon-192.png';S._invBrandAdd=true;S._invBrand='__pending__';renderInventory()`);
        await shot(page, `${P}-iv-add-equip-free-photo`, { el: form });
        await draw(page, `S._invBrandAdd=false;S._invBrand='';S._invCatAdd=true;S._invCat='__pending__';S._invFree=false;S._invPrice='55';renderInventory()`);
        await shot(page, `${P}-iv-add-equip-newcat`, { el: form });
        await draw(page, `startInvEdit('e1')`);
        await shot(page, `${P}-iv-edit-equip`);
        await draw(page, `${invSec('supplements')}toggleAddInv()`);
        await shot(page, `${P}-iv-add-supp`, { el: form });
        await draw(page, `S._invCat='Drinks';S._invNutriOpen=true;renderInventory()`);
        await shot(page, `${P}-iv-add-supp-drink-nutri`, { el: form });
        await draw(page, `S._invCat='ProteinSnacks';S._invSubtypeAdd=true;S._invSubtype='__pending__';S._invFlavAdd=true;S._invFlav='__pending__';S._invNutri={serving:'1 bar',kcal:'200',protein_g:'20',micros:[{n:'Vitamin C',a:40,u:'mg',nrv:50},{n:'',a:null,u:'',nrv:null}],ingredients:'Oats, whey'};renderInventory()`);
        await shot(page, `${P}-iv-add-supp-protein-micros`, { el: form });
        await draw(page, `startInvEdit('s1')`);
        await shot(page, `${P}-iv-edit-supp`);
        await draw(page, `S._invNutriOpen=true;renderInventory()`);
        await shot(page, `${P}-iv-edit-supp-nutri`, { el: form });
      });

      test(`custom price ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`S.invSection='equipment';S.invView='grid';setStaffTab('inventory')`);
        await page.waitForFunction(INV_READY);
        await page.evaluate(`_showCustomPriceModal()`);
        await page.waitForFunction(`document.activeElement&&document.activeElement.id==='custom-price-inp'`);
        await shot(page, `${P}-iv-price`, { full: false });
        await page.evaluate(`document.getElementById('custom-price-inp').blur()`);
        await page.locator('#confirm-modal .confirm-box button').first().hover();
        await shot(page, `${P}-iv-price-hover`, { full: false });
        await page.mouse.move(0, 0);
      });

      test(`petromin page ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`setStaffTab('riders')`);
        await page.waitForFunction(PM_READY);
        await draw(page, `S._riderPartyOpen=new Set(['${PM}|P-005']);renderRiders()`);
        await shot(page, `${P}-pm-list`);
        await page.evaluate(`(()=>{const w=document.querySelector('#pm-host .table-wrapper');if(w)w.scrollLeft=document.dir==='rtl'?-1e6:1e6})()`);
        await shot(page, `${P}-pm-list-end`); // the columns past the edge
        await draw(page, `S._riderPartyOpen=new Set(['${PM}|P-004']);renderRiders()`);
        await shot(page, `${P}-pm-party3-open`);
        await draw(page, `S._riderPartyOpen=new Set();S.ridersSession='all';renderRiders()`);
        await shot(page, `${P}-pm-all-nights`);
        await draw(page, `S.ridersSession='${PM}';S._fOpen={riders:true};S.ridersCompany='Petrolube';renderRiders()`);
        await shot(page, `${P}-pm-filters`);
        await draw(page, `S._fOpen={};S.ridersCompany='all';S.ridersFilter='returned';S.ridersSearch='Dana';renderRiders()`);
        await shot(page, `${P}-pm-search`); // a search opens every party
        await draw(page, `S.ridersFilter='all';S.ridersSearch='zzzz';renderRiders()`);
        await shot(page, `${P}-pm-none`);
        await draw(page, `S.ridersSearch='';renderRiders()`);
      });

      test(`rider pop-up ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`setStaffTab('riders')`);
        await page.waitForFunction(PM_READY);
        for (const [k, id] of [['waiting', 1], ['riding', 2], ['returned', 3], ['party-lead', 4], ['party-second', 5], ['party-third', 6], ['party2-lead', 7], ['plain', 9], ['no-night', 11]] as const) {
          await page.evaluate(`openRiderModal(${id})`);
          // the dialog focus manager puts focus on its first control 40 ms after it opens
          await page.waitForFunction(`!!document.querySelector('#rider-modal .modal-box')&&document.getElementById('rider-modal').contains(document.activeElement)`);
          await shotScroll(page, `${P}-pm-modal-${k}`, '#rider-modal .modal-box');
          await page.evaluate(`closeRiderModal()`);
          await page.waitForFunction(CLOSED); // so the next one opens as a new dialog, not as this one redrawn
        }
      });

      test(`walk-in form ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`setStaffTab('riders')`);
        await page.waitForFunction(PM_READY);
        await page.evaluate(`showRiderWalkin()`);
        await page.waitForFunction(`document.activeElement&&document.activeElement.id==='rw-badge'`);
        await shotScroll(page, `${P}-rw-new`, WALKIN);
        await page.evaluate(`Object.assign(S._rw,{company:'Petromin',type:'Hybrid',badge:'Z-99',name:'Zaid New',phone:'500000009',height:'172',riders:[{name:'Zaid Two',height:'150',type:'Road'},{name:'',height:'',type:''}]});renderRiderWalkin()`);
        await shotScroll(page, `${P}-rw-new-riders`, WALKIN);
        await page.evaluate(`Object.assign(S._rw,{err:'Pick a bike type',company:'Petrolube'});renderRiderWalkin()`);
        await shotScroll(page, `${P}-rw-new-err`, WALKIN);
        await page.evaluate(`Object.assign(S._rw,{err:'',dup:{queueNum:4,name:'Amal Waiting'}});renderRiderWalkin()`);
        await shotScroll(page, `${P}-rw-new-dup`, WALKIN);
        await page.evaluate(`Object.assign(S._rw,{dup:null,retry:true,saving:true,err:'Saved, but the booking did not go through',riders:[{name:'A',height:'150',type:'Road'},{name:'B',height:'',type:'Hybrid',locked:true},{name:'C',height:'130',type:''},{name:'D',height:'',type:'Mountain'}]});renderRiderWalkin()`);
        await shotScroll(page, `${P}-rw-new-four-retry`, WALKIN);
        await page.evaluate(`closeRiderWalkin()`);
        await page.waitForFunction(CLOSED);
        await page.evaluate(`showRiderEdit(4)`);
        await page.waitForFunction(`document.activeElement&&document.activeElement.id==='rw-name'`);
        await shotScroll(page, `${P}-rw-edit-party`, WALKIN);
        await page.evaluate(`closeRiderWalkin()`);
        await page.waitForFunction(CLOSED);
        await page.evaluate(`showRiderEdit(11)`);
        await page.waitForFunction(`document.activeElement&&document.activeElement.id==='rw-name'`);
        await shotScroll(page, `${P}-rw-edit-no-night`, WALKIN);
        await page.evaluate(`closeRiderWalkin()`);
      });
    }
  });
}

type Cspv = { dir: string; sample: string; el: string; roots: string[]; foreign: string };
// The policy without style-src 'unsafe-inline': the same screens, driven with function-form calls
// only (a string-form evaluate is eval, which the policy refuses - tests/csp.spec.ts). A refused
// inline style is reported with its element; none may come from the markup these functions write.
// The helpers they call that belong to other areas (_itemThumb, the helmet drawing of _itemIcon)
// are named in <VISUAL_SNAPS>/_strict/violations.json, not counted, while their areas are still to move.
test.describe('@visual:inventory strict policy', () => {
  test.use({ ...VIEWPORTS.desktop, bypassCSP: false });
  test('nothing these screens write is refused without style-src unsafe-inline', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await page.route((u) => u.pathname === '/' || u.pathname === '/index.html', async (r) => {
      const res = await r.fetch();
      const h = { ...res.headers() };
      h['content-security-policy'] = (h['content-security-policy'] || '').replace("style-src 'self' 'unsafe-inline'", "style-src 'self'");
      expect(h['content-security-policy']).toMatch(/style-src 'self'/); expect(h['content-security-policy']).not.toMatch(/style-src[^;]*'unsafe-inline'/); // Served this way since 2026-09-29 ('report-sample' names a refused style in its report).
      await r.fulfill({ response: res, headers: h });
    });
    await stubSupabase(page, FIX);
    await unlockStaff(page);
    await page.addInitScript(() => {
      localStorage.setItem('cq_lang', 'en'); localStorage.setItem('cq_lang_pick', '1');
      const w = window as unknown as { __cspv: Cspv[]; __ivForeign: (el: Element) => string };
      w.__cspv = [];
      // What another area's helper wrote inside these screens: _itemThumb's picture or icon tile in
      // a reorder row, and the helmet drawing of _itemIcon (_CAT_ICON_SVG) in a card or that tile.
      w.__ivForeign = (el) => {
        const p = el.parentElement;
        if (p && p.classList.contains('iv-ro-row')) return '_itemThumb';
        if (el.tagName.toLowerCase() === 'svg' && (el.closest('.iv-cph') || (p && p.parentElement && p.parentElement.classList.contains('iv-ro-row')))) return '_itemIcon';
        return '';
      };
      document.addEventListener('securitypolicyviolation', (e) => {
        const el = e.target instanceof Element ? e.target : null;
        const roots = ['#tab-inventory', '#pm-host', '#rider-modal', '#rider-walkin-modal', '#confirm-modal'].filter((s) => el && el.closest(s));
        w.__cspv.push({ dir: e.violatedDirective, sample: e.sample || '', el: el ? el.outerHTML.slice(0, 160) : String(e.target), roots, foreign: el ? w.__ivForeign(el) : '' });
      }, true);
    });
    await page.goto('/');
    await page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && !!S.dataLoaded
      && (typeof _lastLoadOk === 'undefined' || _lastLoadOk === true) && (typeof _refsLoaded === 'undefined' || _refsLoaded === true), undefined, { timeout: 15000 });
    await page.waitForFunction(() => S.view === 'staff');
    await page.evaluate(() => { S.staffRole = 'admin'; });
    // Every element these screens drew whose style attribute the policy refused: the attribute is
    // there, its declarations are not (a CSSOM write, which the policy allows, leaves them in).
    const refused = () => page.evaluate(() => {
      const w = window as unknown as { __ivForeign: (el: Element) => string };
      const out: { el: string; foreign: string }[] = [];
      for (const root of ['#tab-inventory', '#pm-host', '#rider-modal', '#rider-walkin-modal', '#confirm-modal']) {
        for (const el of Array.from(document.querySelectorAll(root + ' [style]'))) {
          const a = (el.getAttribute('style') || '').trim();
          if (a && !(el as HTMLElement).style.cssText) out.push({ el: root + ' ' + el.outerHTML.slice(0, 200), foreign: w.__ivForeign(el) });
        }
      }
      return out;
    });
    const seen = new Set<string>(), foreign = new Set<string>();
    const step = async (what: string, fn: () => Promise<unknown>) => {
      await fn();
      await quiet(page);
      for (const r of await refused()) (r.foreign ? foreign : seen).add(what + ': ' + (r.foreign ? r.foreign + ' ' : '') + r.el);
    };
    await step('equipment grid', () => page.evaluate(() => { S.invSection = 'equipment'; S.invView = 'grid'; setStaffTab('inventory'); }));
    await step('equipment table + count', () => page.evaluate(() => { S.invView = 'table'; S.invCount = true; S.invCounts = { e1: '5' }; renderInventory(); }));
    await step('equipment filters', () => page.evaluate(() => { S.invCount = false; S._fOpen = { inv: true }; S.invSort = 'name'; renderInventory(); }));
    await step('equipment none', () => page.evaluate(() => { S._fOpen = {}; S.invSearch = 'zzzz'; renderInventory(); }));
    await step('supplements grid + count', () => page.evaluate(() => { S.invSearch = ''; S.invSort = 'cat'; S.invSection = 'supplements'; S.invView = 'grid'; S.invCount = true; S.invCounts = { s1: '1' }; renderInventory(); }));
    await step('supplements table', () => page.evaluate(() => { S.invCount = false; S.invView = 'table'; renderInventory(); }));
    await step('add equipment, free, photo, new brand', () => page.evaluate(() => { S.invSection = 'equipment'; toggleAddInv(); S._invFree = true; S._invPhoto = '/icon-192.png'; S._invBrandAdd = true; S._invBrand = '__pending__'; renderInventory(); }));
    await step('add supplement, nutrition, micros', () => page.evaluate(() => { S.invSection = 'supplements'; toggleAddInv(); S._invCat = 'Drinks'; S._invNutriOpen = true; S._invFlavAdd = true; S._invFlav = '__pending__'; S._invNutri = { micros: [{ n: 'Iron', a: 1, u: 'mg', nrv: 5 }] }; renderInventory(); }));
    await step('protein type', () => page.evaluate(() => { S._invCat = 'ProteinSnacks'; S._invSubtypeAdd = true; S._invSubtype = '__pending__'; renderInventory(); }));
    await step('edit', () => page.evaluate(() => startInvEdit('s1')));
    await step('custom price', () => page.evaluate(() => _showCustomPriceModal()));
    await page.evaluate(() => { const m = document.getElementById('confirm-modal')!; m.style.display = 'none'; m.innerHTML = ''; });
    await step('petromin page', () => page.evaluate((k) => { S._riderPartyOpen = new Set([k]); setStaffTab('riders'); }, PM + '|P-005'));
    await page.waitForFunction(() => !!S.ridersLoaded && !!document.querySelector('#pm-host #riders-results tbody tr'));
    await step('petromin page, all nights, filters', () => page.evaluate(() => { S.ridersSession = 'all'; S._fOpen = { riders: true }; renderRiders(); }));
    await step('petromin page, none', () => page.evaluate(() => { S._fOpen = {}; S.ridersSearch = 'zzzz'; renderRiders(); }));
    await page.evaluate(() => { S.ridersSearch = ''; renderRiders(); });
    for (const id of [1, 2, 3, 4, 5, 7, 11]) {
      await step('pop-up ' + id, () => page.evaluate((i) => openRiderModal(i), id));
      await page.evaluate(() => closeRiderModal());
    }
    await step('walk-in', () => page.evaluate(() => { showRiderWalkin(); Object.assign(S._rw as object, { company: 'Petromin', type: 'Road', err: 'x', riders: [{ name: 'A', height: '', type: '' }] }); renderRiderWalkin(); }));
    await step('walk-in dup', () => page.evaluate(() => { Object.assign(S._rw as object, { err: '', dup: { queueNum: 2, name: 'B' } }); renderRiderWalkin(); }));
    await page.evaluate(() => closeRiderWalkin());
    await step('edit a party', () => page.evaluate(() => showRiderEdit(4)));
    // Proof the page runs under the stricter policy: a style written on purpose, outside these screens,
    // is refused. (It used to be proved by the page's own leftovers; since 2026-09-29 there are none.)
    await page.evaluate(() => { const p = document.createElement('div'); p.setAttribute('style', 'color:red'); document.body.appendChild(p); });
    await page.waitForTimeout(150);
    const v = await page.evaluate(() => (window as unknown as { __cspv: Cspv[] }).__cspv);
    const mine = v.filter((x) => x.roots.length && !x.foreign);
    mkdirSync(join(SNAPS, '_strict'), { recursive: true });
    writeFileSync(join(SNAPS, '_strict', 'violations.json'), JSON.stringify({ refused: [...seen], foreign: [...foreign], events: v }, null, 1));
    // The page does run under the stricter policy: the probe above was refused.
    expect(v.some((x) => /style-src/.test(x.dir))).toBe(true);
    expect.soft(mine.map((x) => x.el)).toEqual([]);
    expect.soft([...seen]).toEqual([]);
  });
});
