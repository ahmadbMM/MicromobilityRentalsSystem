import { test, expect, type Page, type Locator } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

declare const _langLoaded: (l: string) => boolean; // app global

// Sales (the till) without inline styles (playwright.visual.config.ts says how to run it): the
// item picker at every level (the departments, All items, a department, the Protein Snacks group,
// a category, a custom item), the tiles (a photo or the category's name, selected, low and out of
// stock, no price, free), the cart (lines on every payment, the discount and the card split in SAR
// and in %, the MM Team picker), a customer typed, suggested and linked, the totals and the ledger
// (receipts paid with a card split, pending, the team's, on the house, discounted, refunded, a
// custom line, and the add-ons rung up on a booking), the outbox chip, the low-stock alert, an
// empty ledger and no sessions; the booking's cashier dialog, the receipt editor and the nutrition
// sheet (staff and customer); and the helpers drawn in other places - a thumbnail and the helmet
// icon in Inventory and the session form's add-ons, the grams badge in the add-on picker. Every
// state is a screenshot and a hash of the computed style of every element on the page
// (cascade-audit.ts), in English and Arabic, at 1280x900 and 390x844, from fixed data on a frozen
// clock. Switches as pass3.visual.ts: AUDIT=inline, AUDIT=class with AUDIT_CLASSES, MIN_CSS=1,
// CSS_DUMP. The last describe turns the policy on without style-src 'unsafe-inline' and checks
// nothing drawn here is refused.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
const SNAPS = process.env.VISUAL_SNAPS || join(tmpdir(), 'mm-visual-snaps');
const CLASSES = process.env.AUDIT_CLASSES ? readFileSync(process.env.AUDIT_CLASSES, 'utf8').split(/\s+/).filter(Boolean) : [];

type Row = Record<string, unknown>;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOf = (d: string) => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
const js = (o: unknown) => JSON.stringify(o);
const sess = (d: string, o: Row) => ({ id: d, day: dayOf(d), session_date: d, capacity: 12, status: 'open', location: 'JCC', bike_slots: js({ _time: '21:00 - 23:00', _total: 12 }), created_at: 1, ...o });
const sessions = [
  sess('2026-09-22', { status: 'closed' }),
  sess(TODAY, { addons: js(['i1', 'i2', 'i6', 'i8', 'i4']) }),
  sess('2026-09-26', { event_kind: 'community', needs_approval: true, spots: 10, capacity: 10, bike_slots: js({ _time: '06:30 - 07:00' }) }),
];
const customers = [
  { id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567', created_at: '2026-08-20T10:00:00Z' },
  { id: 'c2', name: 'Omar Hassan', email: 'omar@example.test', phone: '0551234568', created_at: '2025-01-05T10:00:00Z' },
  { id: 'c3', name: 'Cara Vale', phone: '0551234569', created_at: '2026-09-01T10:00:00Z' },
  { id: 'c4', name: 'Sami Noor', email: 'sami@example.test', created_at: '2026-09-10T10:00:00Z' },
];
const at = (hm: string) => `${TODAY}T${hm}:00+03:00`;
const purchases = [
  { id: 'i1', name: 'Vitamin Water', cat: 'Drinks', qty: 2, price: 10, pay: 'paid', at: at('20:05') },
  { id: 'i8', name: 'Aero Helmet', cat: 'Helmet', qty: 1, price: 15, pay: 'pending', at: at('20:06') },
  { name: 'Chain oil', cat: 'Other', qty: 1, price: 0, pay: 'house', at: at('20:07') },
  { id: 'i6', name: 'Energy Gel', cat: 'EnergyGels', qty: 1, price: 12, pay: 'team', team: 'Salem', at: at('20:08') },
];
const q = (id: string, n: number, o: Row) => ({
  id, session_id: TODAY, session_day: dayOf(TODAY), session_date: TODAY, queue_num: n, status: 'waiting', paid: false, price: 80,
  type_preference: 'Hybrid', size: 'M', height: 172, registered_at: '2026-09-15T10:00:00Z', ...o,
});
const queue_entries = [
  q('q1', 1, { name: 'Sara Ali', customer_id: 'c1', phone: '0551234567', status: 'active', paid: true, purchases: js(purchases), addons: js([{ id: 'i2', qty: 1 }]) }),
  q('q2', 2, { name: 'Omar Hassan', customer_id: 'c2', phone: '0551234568' }),
];
const FULL_NU = {
  serving: '500 ml bottle', kcal: 85, fat_g: 0, carbs_g: 21, sugar_g: 21, protein_g: 0, salt_g: 0.13, caffeine_mg: 0,
  micros: [{ n: 'Vitamin D', a: '7.5', u: 'µg', nrv: '150' }, { n: 'Zinc', a: '4.5', u: 'mg', nrv: '45' }, { n: 'Green tea extract', a: '20', u: 'mg', nrv: '' }],
  ingredients: 'Water, sugar, acid (citric acid), vitamins (C, E, niacin, B12), minerals (zinc, magnesium), natural flavouring.',
};
const inventory = [
  { id: 'i1', name: 'Vitamin Water', brand: 'Nova', category: 'Drinks', qty: 30, price: 10, photo: '/icon-192.png', volume_ml: 500, nutrition: js(FULL_NU) },
  { id: 'i2', name: 'Choc Cookie', brand: 'Fit', category: 'ProteinCookies', qty: 5, price: 8, low_threshold: 1, nutrition: js({ serving: '60 g', kcal: 220, protein_g: 20, carbs_g: 24 }) },
  { id: 'i3', name: 'Berry Gummy', category: 'ProteinGummies', qty: 1, price: 6, low_threshold: 2 },
  { id: 'i4', name: 'Banana Muffin', category: 'ProteinMuffins', qty: 0, price: 9 },
  { id: 'i5', name: 'Choco Bar', category: 'ProteinBars', qty: 10, price: 12 },
  { id: 'i6', name: 'Energy Gel', brand: 'HIGH5', category: 'EnergyGels', qty: 20, price: 12, photo: '/icon-192.png', nutrition: js({ protein_g: 0, carbs_g: 23 }) },
  { id: 'i7', name: 'Electrolyte Tab', category: 'ElectrolyteSachets', qty: 15, price: 5 },
  { id: 'i8', name: 'Aero Helmet', category: 'Helmet', qty: 4, price: 15 },
  { id: 'i9', name: 'Bottle cage', category: 'Accessory', qty: 7 },
  { id: 'i10', name: 'Spare tube', category: 'SparePart', qty: 3, low_threshold: 5, price: 0 },
  { id: 'i11', name: 'Hydration mix with a rather long product name', category: 'Drinks', qty: 8, price: 6, volume_ml: 750 },
];
const cs = (id: string, rid: string, hm: string, o: Row) => ({ id, receipt_id: rid, session_id: TODAY, created_at: at(hm), qty: 1, pay: 'paid', ...o });
const cashier_sales = [
  cs('cs1', 'r1', '20:10', { item_id: 'i1', name: 'Vitamin Water', category: 'Drinks', qty: 2, price: 10, customer_name: 'Sara Ali', customer_id: 'c1' }),
  cs('cs2', 'r1', '20:10', { item_id: 'i2', name: 'Choc Cookie', category: 'ProteinCookies', price: 8, customer_name: 'Sara Ali', customer_id: 'c1' }),
  cs('cs3', 'r1', '20:10', { name: 'card', category: '__cardmeta__', qty: 0, price: 15, customer_name: 'Sara Ali' }),
  cs('cs4', 'r2', '20:12', { item_id: 'i6', name: 'Energy Gel', category: 'EnergyGels', price: 12, pay: 'pending' }),
  cs('cs5', 'r3', '20:15', { item_id: 'i5', name: 'Choco Bar', category: 'ProteinBars', qty: 2, price: 12, pay: 'team', team_name: 'Salem' }),
  cs('cs6', 'r3', '20:15', { item_id: 'i10', name: 'Spare tube', category: 'SparePart', price: 0, pay: 'house' }),
  cs('cs7', 'r4', '20:18', { item_id: 'i7', name: 'Electrolyte Tab', category: 'ElectrolyteSachets', qty: 3, price: 5, customer_name: 'Cara Vale' }),
  cs('cs8', 'r4', '20:18', { name: 'Discount', category: '__discount__', price: -3, customer_name: 'Cara Vale' }),
  cs('cs9', 'r5', '20:20', { item_id: 'i8', name: 'Aero Helmet', category: 'Helmet', price: 15, pay: 'refunded', customer_name: 'Omar Hassan' }),
  cs('cs10', 'r6', '20:22', { name: 'Custom sticker', category: 'Other', price: 4 }),
];
const FIX = { sessions, customers, queue_entries, inventory, cashier_sales, team_members: [{ name: 'Salem' }, { name: 'Malik' }] };

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function settle(page: Page) {
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await document.fonts.ready;
    // lazy pictures (the tiles, the thumbnails) are made eager, so every run draws them loaded
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => { (i as HTMLImageElement).loading = 'eager'; });
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
    await document.fonts.ready;
  });
}

type Open = { lang: string; fx?: Record<string, unknown>; customer?: boolean };
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
  if (!o.customer) await unlockStaff(page);
  await page.addInitScript((lang) => {
    localStorage.setItem('cq_lang', lang);
    localStorage.setItem('cq_lang_pick', '1');
  }, o.lang);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, o.lang);
  if (!o.customer) await page.waitForFunction(`S.view==='staff'`);
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
  // A dialog's first control takes focus 40 ms after the last change (_syncModalFocus), and on a
  // loaded machine that lands before or after the capture: every shot is taken with nothing focused.
  await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; if (a && a !== document.body) a.blur(); });
  await quiet(page);
  await settle(page);
  if (o.el) await expect.soft(o.el).toHaveScreenshot(name + '.png', { timeout: 30000 });
  else await expect.soft(page).toHaveScreenshot(name + '.png', { fullPage: o.full !== false, timeout: 30000 });
  await quiet(page); // a capture flips (max-width:767px) and back; whatever redraws on that settles first
  const hashes = await page.evaluate(styleHashes, { roots: ['body'], ignore: '^--sl-', stripOrigin: true }); // data-cssv's own properties (this pass's), and any port
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
// A dialog that has just opened is drawn once more after the focus manager has been and gone, so
// no control carries a focus it was given and lost (a select's text then antialiases differently).
async function fresh(page: Page, open: string, redraw: string) {
  await page.evaluate(open);
  await quiet(page);
  await page.evaluate(`(document.activeElement&&document.activeElement!==document.body)&&document.activeElement.blur();${redraw}`);
}
// Each evaluate draws a state; the page goes back to the top so a full-page shot starts there.
const draw = (page: Page, code: string) => page.evaluate(code + ';window.scrollTo(0,0)');
const CT_READY = `!!document.querySelector('#tab-cashier .cashier-grid')`;
// the till's form, back to how a fresh Sales tab has it (the session stays tonight's)
const CT_RESET = `S._ctPickCat='';S._ctItem='';S._ctName='';S._ctCat='Helmet';S._ctQty='1';S._ctAmt='';S._ctPay='paid';S._ctTeam='';S._ctCart=[];S._ctCust='';S._ctCustId='';S._ctDisc='';S._ctDiscPct=false;S._ctCard='';S._ctCardPct=false;`;
const CART = js([
  { item_id: 'i1', name: 'Vitamin Water', cat: 'Drinks', qty: 2, price: 10, pay: 'paid', team: '' },
  { item_id: 'i8', name: 'Aero Helmet', cat: 'Helmet', qty: 1, price: 15, pay: 'pending', team: '' },
  { item_id: 'i5', name: 'Choco Bar', cat: 'ProteinBars', qty: 1, price: 12, pay: 'team', team: 'Salem' },
  { item_id: null, name: 'Custom sticker', cat: 'Other', qty: 1, price: 0, pay: 'house', team: '' },
]);
const HOUSE_CART = js([{ item_id: 'i9', name: 'Bottle cage', cat: 'Accessory', qty: 3, price: 0, pay: 'house', team: '' }]);

test.describe.configure({ timeout: 300000 }); // a loaded machine runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:sales ${vpName}`, () => {
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`till ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`window._outboxCount=function(){return 2}`); // two sales waiting for the connection
        await staffTab(page, 'cashier', CT_READY);
        await draw(page, `${CT_RESET}renderCashier()`);
        await shot(page, `${P}-ct-top`);
        await draw(page, `${CT_RESET}S._ctPickCat='__all__';S._ctItem='i1';renderCashier()`);
        await shot(page, `${P}-ct-all`);
        await draw(page, `${CT_RESET}S._ctPickCat='__sec__supp';renderCashier()`);
        await shot(page, `${P}-ct-supp`);
        await draw(page, `${CT_RESET}S._ctPickCat='__sec__equip';S._ctItem='i9';renderCashier()`);
        await shot(page, `${P}-ct-equip`);
        await draw(page, `${CT_RESET}S._ctPickCat='__grp__ProteinSnacks';renderCashier()`);
        await shot(page, `${P}-ct-group`);
        await draw(page, `${CT_RESET}S._ctPickCat='ProteinCookies';renderCashier()`);
        await shot(page, `${P}-ct-leaf`);
        await draw(page, `${CT_RESET}S._ctPickCat='Helmet';S._ctItem='__custom__';S._ctName='Bell';S._ctCat='EnergyGels';S._ctQty='3';S._ctAmt='7.5';S._ctPay='pending';renderCashier()`);
        await shot(page, `${P}-ct-custom`);
        await draw(page, `${CT_RESET}S._ctCart=${CART};S._ctCust='Sara Ali';S._ctCustId='c1';S._ctDisc='5';S._ctCard='10';S._ctPay='team';S._ctTeam='Salem';renderCashier()`);
        await shot(page, `${P}-ct-cart`);
        await draw(page, `${CT_RESET}S._ctCart=${CART};S._ctDisc='10';S._ctDiscPct=true;S._ctCard='50';S._ctCardPct=true;S._ctPay='team';S._ctTeam='Guest Rider';renderCashier()`);
        await shot(page, `${P}-ct-cart-pct`); // a team name not on the roster, percentages
        await draw(page, `${CT_RESET}S._ctCart=${HOUSE_CART};S._ctPay='house';S._ctAmt='0';renderCashier()`);
        await shot(page, `${P}-ct-cart-house`); // nothing paid: no card split
        await draw(page, `${CT_RESET}renderCashier();_ctCustSuggest(true)`);
        await shot(page, `${P}-ct-suggest-recent`);
        await draw(page, `S._ctCust='sa';_ctCustSuggest()`);
        await shot(page, `${P}-ct-suggest-typed`);
        await draw(page, `S._ctCust='zzzz';_ctCustSuggest()`);
        await shot(page, `${P}-ct-suggest-none`);
        await draw(page, `window._outboxCount=function(){return 0};${CT_RESET}S._ctSession='2026-09-22';renderCashier()`);
        await shot(page, `${P}-ct-empty-ledger`);
      });

      test(`till without sessions ${lang}`, async ({ page }) => {
        await open(page, { lang, fx: { sessions: [], queue_entries: [], cashier_sales: [] } });
        await staffTab(page, 'cashier', `!!document.querySelector('#tab-cashier .empty-state')`);
        await shot(page, `${P}-ct-nosessions`);
      });

      test(`till dialogs ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await staffTab(page, 'cashier', CT_READY);
        await fresh(page, `showCashierModal('q1')`, `renderCashierModal()`);
        await shot(page, `${P}-cm-lines`, { full: false });
        await draw(page, `S._cashItem='__custom__';S._cashName='Bell';S._cashPay='team';S._cashTeam='Salem';renderCashierModal()`);
        await shot(page, `${P}-cm-custom-team`, { full: false });
        await draw(page, `S._cashItem='i6';S._cashPay='pending';S._cashTeam='Guest Rider';renderCashierModal()`);
        await shot(page, `${P}-cm-pending`, { full: false });
        await draw(page, `S._cashPay='team';renderCashierModal()`);
        await shot(page, `${P}-cm-team-guest`, { full: false }); // a team name not on the roster
        await fresh(page, `closeCashierModal();showCashierModal('q2');S._cashPay='house'`, `renderCashierModal()`);
        await shot(page, `${P}-cm-empty`, { full: false });
        await page.evaluate(`closeCashierModal()`);
        await fresh(page, `showReceiptEdit('r1')`, `renderReceiptEdit()`);
        await shot(page, `${P}-re-r1`, { full: false });
        await page.evaluate(`_reSet(0,'pay','house');_reSet(1,'pay','team');_reSetSilent(1,'team_name','Salem');renderReceiptEdit()`);
        await shot(page, `${P}-re-house-team`, { full: false });
        await fresh(page, `closeReceiptEdit();showReceiptEdit('r3')`, `renderReceiptEdit()`);
        await shot(page, `${P}-re-r3`, { full: false });
        await page.evaluate(`closeReceiptEdit();showNutrition('i1')`);
        await shot(page, `${P}-nu-full`, { full: false });
        await page.evaluate(`closeNutrition();showNutrition('i6')`);
        await shot(page, `${P}-nu-min`, { full: false });
        await page.evaluate(`closeNutrition();showNutrition('i2')`);
        await shot(page, `${P}-nu-serving`, { full: false });
        await page.evaluate(`closeNutrition()`);
      });

      test(`nutrition on the customer page ${lang}`, async ({ page }) => {
        await open(page, { lang, customer: true });
        await page.evaluate(`S.inventory=${js(inventory)};showNutrition('i1')`);
        await shot(page, `${P}-nu-customer`, { full: false });
      });

      test(`helpers elsewhere ${lang}`, async ({ page }) => {
        await open(page, { lang });
        // the grams badge on the add-on picker's cards (a protein snack, an energy gel)
        await page.evaluate(`showAddonPicker('q1')`);
        await page.waitForFunction(`!!document.querySelector('#addon-picker-backdrop .modal-box')`);
        await shot(page, `${P}-ap-macro`, { full: false });
        await page.evaluate(`closeAddonPicker()`);
        // Inventory: the reorder card's thumbnails (a photo, the helmet, none) and the helmet card
        await page.evaluate(`S.invSection='equipment'`);
        await staffTab(page, 'inventory', `!!document.querySelector('#tab-inventory .bike-grid-card')`);
        await draw(page, `S.invSection='equipment';renderInventory()`);
        await shot(page, `${P}-inv-equip`);
        await draw(page, `S.invSection='supplements';renderInventory()`);
        await shot(page, `${P}-inv-supp`);
        // the new-session form's add-on list, where an item without a photo shows the helmet
        await staffTab(page, 'sessions', `!!document.querySelector('#sess-host .sess-twopane')&&S._bw!==undefined&&!S._bwBusy`);
        await draw(page, `S.newSessDate='2026-10-08';S.newSessEvent='jcc';S.newSessMode='total';S.newSessTotal='10';S.newSessAddons=['i8'];S.showAddSession=true;S.editSessionId=null;renderSessions()`);
        await shot(page, `${P}-ss-addons`, { el: page.locator('#sess-add-form') });
      });
    }
  });
}

// The policy without style-src 'unsafe-inline', as it will be: nothing the till and its dialogs
// draw may be refused. Function-form calls only (a string evaluate is eval, which the policy
// forbids). An inline style the policy refuses stays in the DOM as an attribute that sets nothing
// (el.style is empty), so every element of the area with a style attribute and no declarations is
// listed as well as the violations reported from inside it.
declare const S: Record<string, unknown> & { dataLoaded: boolean; view: string };
declare const sb: unknown;
declare function setStaffTab(tab: string): void;
declare function renderCashier(): void;
declare function renderCashierModal(): void;
declare function showCashierModal(id: string): void;
declare function closeCashierModal(): void;
declare function showReceiptEdit(key: string): void;
declare function closeReceiptEdit(): void;
declare function _reSet(i: number, k: string, v: string): void;
declare function showNutrition(id: string): void;
declare function closeNutrition(): void;
declare function _ctCustSuggest(focus?: boolean): void;
declare function _itemThumb(id: string, size: number): string;
declare function _itemIcon(it: unknown): string;
declare function _macroBadge(it: unknown, size: number): string;
declare function _salesArt(cat: string, h?: number): string;
declare function _cashPayBadge(pay: string, team?: string): string;
declare function showAddonPicker(id: string): void;
declare function closeAddonPicker(): void;
declare function renderInventory(): void;
declare function renderSessions(): void;
type W = Window & { __cspv: { dir: string; sample: string; where: string }[]; _outboxCount: () => number };
// The till and its three dialogs are drawn by this area alone; the helpers it lends to other
// sections (a thumbnail, the helmet icon, the grams badge, a category's art, a payment's ink) are
// checked in a probe of their own, since those sections carry other areas' markup.
const AREA = ['#tab-cashier', '#cashier-modal', '#receipt-edit-modal', '#nutrition-modal-backdrop', '#sl-probe'];

test.describe('@visual:sales strict style-src', () => {
  test.use({ bypassCSP: false, ...VIEWPORTS.desktop });
  test('nothing in Sales, its dialogs or its helpers is refused', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, FIX);
    await unlockStaff(page);
    await page.route(() => true, async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const res = await route.fetch();
      const headers = res.headers();
      const csp = headers['content-security-policy'] || '';
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      headers['content-security-policy'] = csp.replace("style-src 'self' 'unsafe-inline'", "style-src 'self' 'report-sample'");
      await route.fulfill({ response: res, headers });
    });
    await page.addInitScript((area) => {
      (window as unknown as W).__cspv = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        const t = e.target as Element | Document;
        const el = t && (t as Element).closest ? (t as Element) : null;
        let where = el ? (area.find((a) => el.closest(a)) || 'elsewhere') : 'document';
        if (where === 'elsewhere' && el && [...el.classList].some((c) => c.startsWith('sl-'))) where = '.sl-*';
        (window as unknown as W).__cspv.push({ dir: e.violatedDirective, sample: e.sample || '', where });
      }, true);
    }, AREA);
    await page.goto('/');
    await page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && !!S.dataLoaded && S.view === 'staff');
    const refused = () => page.evaluate((area) => {
      const out: string[] = [];
      const check = (a: string, el: HTMLElement) => {
        const attr = el.getAttribute('style');
        if (attr && attr.trim() && el.style && el.style.length === 0) out.push(`${a}: <${el.tagName.toLowerCase()} class="${el.getAttribute('class') || ''}" style="${attr.slice(0, 60)}">`);
      };
      for (const a of area) for (const top of Array.from(document.querySelectorAll(a))) {
        for (const el of [top, ...Array.from(top.querySelectorAll('[style]'))] as HTMLElement[]) check(a, el);
      }
      // this area's classes wherever they are drawn (the add-on picker, Inventory, the session form)
      for (const el of Array.from(document.querySelectorAll('[class]')) as HTMLElement[]) if ([...el.classList].some((c) => c.startsWith('sl-'))) check('.sl-*', el);
      return out;
    }, AREA);
    const mine = async (label: string) => {
      await page.waitForTimeout(150);
      const v = (await page.evaluate(() => (window as unknown as W).__cspv.splice(0))).filter((x) => x.where !== 'elsewhere' && x.where !== 'document');
      expect.soft(v, label + ' (violations inside the area)').toEqual([]);
      expect.soft(await refused(), label + ' (style attributes the policy dropped)').toEqual([]);
    };
    const steps: [string, (cart: string) => void][] = [
      ['till', () => { (window as unknown as W)._outboxCount = () => 2; setStaffTab('cashier'); }],
      ['all items', () => { S._ctPickCat = '__all__'; S._ctItem = 'i1'; renderCashier(); }],
      ['department', () => { S._ctPickCat = '__sec__supp'; renderCashier(); }],
      ['group', () => { S._ctPickCat = '__grp__ProteinSnacks'; renderCashier(); }],
      ['category + custom', () => { S._ctPickCat = 'ProteinCookies'; S._ctItem = '__custom__'; renderCashier(); }],
      ['cart', (cart) => {
        S._ctCart = JSON.parse(cart); S._ctCust = 'Sara Ali'; S._ctCustId = 'c1'; S._ctDisc = '5'; S._ctCard = '10'; S._ctPay = 'team'; S._ctTeam = 'Guest Rider'; renderCashier();
      }],
      ['suggestions', () => { S._ctCust = ''; S._ctCustId = ''; renderCashier(); _ctCustSuggest(true); }],
      ['cashier dialog', () => { showCashierModal('q1'); }],
      ['cashier dialog, custom team', () => { S._cashItem = '__custom__'; S._cashPay = 'team'; renderCashierModal(); }],
      ['cashier dialog, empty', () => { closeCashierModal(); showCashierModal('q2'); }],
      ['receipt editor', () => { closeCashierModal(); showReceiptEdit('r1'); _reSet(0, 'pay', 'house'); _reSet(1, 'pay', 'team'); }],
      ['nutrition', () => { closeReceiptEdit(); showNutrition('i1'); }],
      ['helpers', () => {
        closeNutrition();
        const inv = S.inventory as { id: string }[], it = (id: string) => inv.find((x) => x.id === id);
        const d = document.createElement('div'); d.id = 'sl-probe';
        d.innerHTML = [_itemThumb('i1', 32), _itemThumb('i8', 28), _itemThumb('i9', 22), `<div>${_itemIcon(it('i8'))}</div>`,
          `<div>${_macroBadge(it('i2'), 38)}${_macroBadge(it('i6'), 38)}${_macroBadge(it('i2'), 0)}</div>`,
          _salesArt('drinks'), _salesArt('ProteinCookies', 80), _salesArt('whatever'),
          ...['paid', 'pending', 'house', 'team'].map((p) => _cashPayBadge(p, 'Salem'))].join('');
        document.body.appendChild(d);
      }],
      ['helpers drawn in place', () => { // the add-on picker, Inventory and the session form: only this area's classes are checked there
        document.getElementById('sl-probe')?.remove();
        showAddonPicker('q1');
      }],
      ['inventory', () => { closeAddonPicker(); S.invSection = 'equipment'; setStaffTab('inventory'); renderInventory(); }],
      ['session add-ons', () => {
        setStaffTab('sessions'); Object.assign(S, { newSessDate: '2026-10-08', newSessEvent: 'jcc', newSessMode: 'total', newSessTotal: '10', newSessAddons: ['i8'], showAddSession: true, editSessionId: null }); renderSessions();
      }],
    ];
    for (const [label, step] of steps) {
      await page.evaluate(step, CART);
      await mine(label);
    }
  });
});
