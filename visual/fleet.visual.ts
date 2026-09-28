import { test, expect, type Page, type Locator } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

declare const _langLoaded: (l: string) => boolean; // app global

// The fleet's pass of the inline-style move (playwright.visual.config.ts says how to run it):
// Inventory > Bikes - the list as a table and as cards, with bikes of every status (available, on a
// ride with and without a rider, in maintenance, missing, retired), rows selected with the bulk bar,
// sorting, the filters, a filter that finds nothing, the folded section of bikes out of the pool,
// and an empty fleet; the add form in every shape (number taken, a custom name, one to four
// colours and their preview, a photo, a brand or groupset being typed, a custom price, the price as
// front desk sees it), the edit form (the bike's /bikes page with its QR and the private details,
// and a retired bike's end date) and a clone; the CSV import preview with good and bad rows; the
// bike's profile (rides, feedback, service due or not, nothing yet); and the option-list editor.
// Every state is a screenshot and a hash of the computed style of every element on the page
// (cascade-audit.ts), in English and Arabic, at 1280x900 and 390x844, from fixed data on a frozen
// clock. The switches are pass2.visual.ts's: AUDIT=inline, AUDIT=class with AUDIT_CLASSES,
// MIN_CSS=1 (the minifier rewrites rules outside the fleet too, so that run needs a baseline of its
// own, taken with MIN_CSS=1 in another VISUAL_SNAPS), CSS_DUMP. The last test turns the policy on
// with style-src 'self' alone and asserts that nothing drawn in the fleet's hosts trips it
// (CSP_LOG=1 prints every violation it saw, the ones outside the fleet included).

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
const SNAPS = process.env.VISUAL_SNAPS || join(tmpdir(), 'mm-visual-snaps');
const CLASSES = process.env.AUDIT_CLASSES ? readFileSync(process.env.AUDIT_CLASSES, 'utf8').split(/\s+/).filter(Boolean) : [];

type Row = Record<string, unknown>;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOf = (d: string) => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
const js = (o: unknown) => JSON.stringify(o);
const sess = (d: string, o: Row = {}) => ({ id: d, day: dayOf(d), session_date: d, capacity: 12, status: 'open', location: 'JCC', bike_slots: js({ _time: '21:00 - 23:00', _total: 12 }), created_at: 1, ...o });
const sessions = [sess('2026-09-10', { status: 'closed' }), sess('2026-09-15', { status: 'closed' }), sess('2026-09-17', { status: 'closed' }), sess('2026-09-22', { status: 'closed' }), sess(TODAY)];
const PHOTO = '/icon-192.png';
const bikes = [
  { id: 'b01', name: 'Road 1', type: 'Road', size: 'M', status: 'in-use', brand: 'Alvas', model: 'Climax', groupset: 'Shimano 105', speeds: 22, rental_price: 95, bike_number: 1,
    colors: ['#111111', '#ee3333'], color_names: ['Black', 'Red'], photo: PHOTO, wheel_size: '700c', brake_type: 'Disc', weight_kg: 9.4, frame_type: 'Carbon', in_service_date: '2025-02-01' },
  { id: 'b02', name: 'Hybrid 1', type: 'Hybrid', size: 'L', status: 'available', brand: 'Alvas', model: 'Cross 21S', groupset: 'Shimano Altus', speeds: 21, rental_price: 75, bike_number: 2,
    colors: ['#00aa00'], color_names: ['Green'], frame_type: 'Aluminum', last_serviced_at: '2026-09-12T08:00:00Z', in_service_date: '2025-05-01' },
  { id: 'b03', name: 'Mountain 1', type: 'Mountain', size: 'M', status: 'available', brand: 'Alvas', model: 'Strom M50', bike_number: 3, frame_type: 'Aluminum' },
  { id: 'b04', name: 'Road 2', type: 'Road', size: 'S', status: 'maintenance', brand: 'Alvas', model: 'DA54', bike_number: 4, colors: ['#cc0000'], retired_date: '2026-09-20', in_service_date: '2025-01-10', photo: PHOTO },
  { id: 'b05', name: 'Road 3', type: 'Road', size: 'L', status: 'available', brand: 'Giant', model: 'Contend', rental_price: 57.5, bike_number: 5, colors: ['#3366ff'], color_names: ['A very long colour name'] },
  { id: 'b06', name: 'Kids 1', type: 'Kids', size: 'XS', status: 'available', bike_number: 6, colors: ['#0000cc', '#ffffff', '#ffcc00'], color_names: ['Blue', '', 'Yellow'], speeds: 1 },
  { id: 'b07', name: 'Hybrid 2', type: 'Hybrid', size: 'M', status: 'in-use', brand: 'Alvas', model: 'Cross 21S', bike_number: 7, colors: ['#888888'] },
  { id: 'b08', name: 'Road 4', type: 'Road', size: 'M', status: 'missing', brand: 'Giant', bike_number: 8, retired_date: '2026-09-18', in_service_date: '2024-11-01', photo: PHOTO },
  { id: 'b09', name: 'Mountain 2', type: 'Mountain', size: 'L', status: 'retired', bike_number: 9, retired_date: '2026-06-01', in_service_date: '2024-03-01', colors: ['#555555'] },
];
const q = (id: string, n: number, sid: string, o: Row) => ({
  id, session_id: sid, session_day: dayOf(sid), session_date: sid, queue_num: n, status: 'done', paid: true, price: 95,
  type_preference: 'Road', size: 'M', height: 172, registered_at: sid + 'T10:00:00Z', ...o,
});
const queue_entries = [
  q('t1', 1, TODAY, { name: 'Sara Ali', status: 'active', assigned_bike_id: 'b01', checked_in_at: '2026-09-24T16:48:00Z', phone: '0551234567' }),
  q('d1', 3, '2026-09-10', { name: 'Omar Hassan', assigned_bike_id: 'b01', rating_bike: 9, feedback: 'Smooth gears, great ride.' }),
  q('d2', 5, '2026-09-15', { name: 'Cara Vale', assigned_bike_id: 'b01', paid: false, price: 75, feedback: 'The seat was a little loose.', rating_bike: 6 }),
  q('d3', 2, '2026-09-17', { name: 'Dana Reyes with a long name that runs on', assigned_bike_id: 'b01' }),
  q('d4', 4, '2026-09-22', { name: 'Faisal Noor', assigned_bike_id: 'b02', type_preference: 'Hybrid', rating_bike: 8 }),
];
const staff_options = [
  { key: 'service_every', items: [3] },
  { key: 'bike_brands', items: [{ name: 'Alvas', models: ['Climax', 'Cross 21S', 'DA54', 'Strom M50'] }, { name: 'Giant', models: ['Contend'] }] },
  { key: 'bike_groupsets', items: ['Shimano 105', 'Shimano Altus'] },
];
const PRIV = { id: 'b02', tag_uid: '04A1B2C3', serial_number: 'SN-0002', model_year: 2025, pedal_type: 'Flat', condition: 'Good', notes: 'Squeaky rear brake' };
const FIX = { sessions, bikes, queue_entries, staff_options, 'rpc:staff_bike_private': [PRIV] };

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
  await page.addInitScript(([lang, now]) => {
    localStorage.setItem('cq_lang', lang as string);
    localStorage.setItem('cq_lang_pick', '1');
    localStorage.setItem('cq_ct_t1', String((now as number) - 42 * 60000)); // Sara has been out 42 minutes
  }, [o.lang, NOW]);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, o.lang);
  await page.waitForFunction(`S.view==='staff'`);
  await page.waitForFunction(`getComputedStyle(document.getElementById('loading-screen')).display==='none'`);
  // the refresh label moves on its own; a scroll-into-view is instant; the form's own scroll-and-focus
  // (a timer) is left out so every shot starts from the same place
  await page.evaluate(`window._tickRefreshLabel=function(){};window._sb=function(){return 'auto'};window._scrollToBikeForm=function(){}`);
  await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';renderInventory();window.scrollTo(0,0)`);
  await page.waitForFunction(`!!document.querySelector('#tab-bikes .stats-row')`);
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
  await quiet(page);
  const hashes = await page.evaluate(styleHashes, { roots: ['body'], ignore: '^--flt-', stripOrigin: true }); // data-cssv's own properties, and any port
  if (process.env.CSS_DUMP) {
    mkdirSync(join(SNAPS, '_dump'), { recursive: true });
    writeFileSync(join(SNAPS, '_dump', `${name}-${Date.now()}.json`), JSON.stringify(await page.evaluate(styleOf, process.env.CSS_DUMP), null, 1));
  }
  expect.soft(JSON.stringify(hashes, null, 0).replace(/","/g, '",\n"')).toMatchSnapshot(name + '.css.txt');
  const mode = process.env.AUDIT;
  if (mode === 'inline' || mode === 'class') {
    const rows = await page.evaluate(cascadeAudit, { roots: o.roots || ['#tab-bikes', '#bike-profile-modal', '#optlist-modal', '#confirm-modal'], classes: CLASSES, inline: mode === 'inline' });
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
// The form's fields as a fresh Add leaves them, with the number fixed (the next free one is 10).
const FRESH = `_resetBikeForm();S.showAddBike=true;S.addBikeType='Road';S._bkNumber='10';S._bkStartDate='${TODAY}';`;
const CSV_MIXED = 'number,type,size,brand,model,status\n10,Road,M,Alvas,Climax,\n11,Hybrid,L,,,available\n2,Road,M,Giant,,\nx,Scooter,Q,,,broken\n';
const CSV_BAD = 'number,type,size\n1,Road,M\n0,Bus,M\n';
// Every bikes table scrolled to its far end (the start in Arabic is the right-hand side), the first
// one at the top of the window: a full-page capture resizes the page and the tables scroll back, so
// these are shots of the window.
const END = `document.querySelectorAll('#tab-bikes .table-wrapper').forEach(w=>{w.scrollLeft=document.dir==='rtl'?-1e6:1e6});document.querySelector('#tab-bikes .table-wrapper').scrollIntoView({block:'start'})`;

test.describe.configure({ timeout: 300000 }); // a loaded machine runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:fleet ${vpName}`, () => {
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`fleet list ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await shot(page, `${P}-flt-table`);
        await page.evaluate(END);
        await shot(page, `${P}-flt-table-end`, { full: false }); // the columns past the edge: colours, status, rider, the buttons
        await draw(page, `S.bkSelected=['b02','b01','b07'];S.bkSortCol='status';S.bkSortDir=-1;renderBikes()`);
        await shot(page, `${P}-flt-table-sel`);
        await page.evaluate(END);
        await shot(page, `${P}-flt-table-sel-end`, { full: false });
        await draw(page, `S.bkSelected=[];S.bkSortCol='name';S.bkSortDir=1;S.bkShowRetired=true;renderBikes()`);
        await shot(page, `${P}-flt-table-out`);
        await draw(page, `S.bkView='grid';renderBikes()`);
        await shot(page, `${P}-flt-grid`);
        await draw(page, `S.bkShowRetired=false;renderBikes()`);
        await quiet(page);
        await page.locator('#tab-bikes .bike-grid-card').first().hover();
        await shot(page, `${P}-flt-grid-hover`, { full: false });
        await page.locator('#tab-bikes #bk-results > div:last-child > button').hover();
        await shot(page, `${P}-flt-out-hover`, { full: false }); // the folded section's own hover, set by its handler
        await page.mouse.move(0, 0);
        await draw(page, `S.bkStatus='maintenance';S._fOpen={bk:true};renderBikes()`);
        await shot(page, `${P}-flt-grid-maint`);
        await draw(page, `S.bkView='table';renderBikes()`);
        await shot(page, `${P}-flt-table-maint`);
        await page.evaluate(END);
        await shot(page, `${P}-flt-table-maint-end`, { full: false });
        await draw(page, `S.bkStatus='all';S.bkSize='XL';S.bkSearch='zzz';S._fOpen={};renderBikes()`);
        await shot(page, `${P}-flt-table-none`);
        await draw(page, `S.bkView='grid';renderBikes()`);
        await shot(page, `${P}-flt-grid-none`);
      });

      test(`fleet empty ${lang}`, async ({ page }) => {
        await open(page, { lang, fx: { bikes: [], queue_entries: [] } });
        await shot(page, `${P}-flt-empty`);
      });

      test(`fleet form ${lang}`, async ({ page }) => {
        await open(page, { lang });
        const form = page.locator('#bk-add-form');
        await draw(page, `${FRESH}renderBikes()`);
        await shot(page, `${P}-flt-add`, { el: form });
        await draw(page, `${FRESH}S._bkNumber='2';S._bkNameCustom=true;S._bkName='My own name';S.addBikeColors=['#111111','#ee3333','#00aa00','#3366ff'];S.addBikeColorNames=['Black','Red','','Blue'];S._bkPhoto='${PHOTO}';S._bkBrand='Alvas';S._bkModel='Climax';S._bkGroupsetAdd=true;S._bkGroupset='Sram';S._bkRentalPrice='123';S._bkWeight='9.5';S._bkSpeeds='22';renderBikes()`);
        await shot(page, `${P}-flt-add-rich`, { el: form });
        await draw(page, `${FRESH}S._bkBrandAdd=true;S._bkBrand='New';S.addBikeColors=['#111111','#ee3333'];S.addBikeColorNames=['',''];S._bkRentalPrice='95';renderBikes()`);
        await shot(page, `${P}-flt-add-brand`, { el: form });
        await page.evaluate(`S.addBikeColors=['#ffcc00','#0000cc','#ffffff'];updateColorPreview()`);
        await shot(page, `${P}-flt-add-colors`, { el: form });
        await draw(page, `${FRESH}S.staffRole='frontdesk';S._bkRentalPrice='95';renderBikes()`);
        await shot(page, `${P}-flt-add-desk`, { el: form });
        await draw(page, `${FRESH}S._bkRentalPrice='';renderBikes()`);
        await shot(page, `${P}-flt-add-desk-none`, { el: form });
        await draw(page, `S.staffRole='admin';cancelBikeForm();startEdit('b02')`);
        await page.waitForFunction(`!!document.querySelector('#bk-add-form .bk-page-qr svg')&&S._bkPriv&&!S._bkPriv.loading`);
        await shot(page, `${P}-flt-edit`, { el: form });
        await draw(page, `cancelBikeForm();startEdit('b09')`);
        await page.waitForFunction(`S._bkPriv&&!S._bkPriv.loading`);
        await shot(page, `${P}-flt-edit-retired`, { el: form });
        await draw(page, `cancelBikeForm();startClone('b01')`);
        await shot(page, `${P}-flt-clone`, { el: form });
        await draw(page, `cancelBikeForm()`);
        await shot(page, `${P}-flt-closed`, { full: false });
      });

      test(`fleet import ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`_bkCsvPreview(${js(CSV_MIXED)})`);
        await shot(page, `${P}-flt-csv`, { full: false });
        await page.evaluate(`closeConfirm();_bkCsvPreview(${js(CSV_BAD)})`);
        await shot(page, `${P}-flt-csv-bad`, { full: false });
        await page.evaluate(`closeConfirm()`);
      });

      test(`bike profile ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`openBikeProfile('b01')`);
        await shot(page, `${P}-flt-prof`, { full: false });
        await page.evaluate(`document.querySelector('#bike-profile-modal .modal-box').scrollTop=1e6`);
        await shot(page, `${P}-flt-prof-end`, { full: false });
        await page.evaluate(`closeBikeProfile();openBikeProfile('b02')`);
        await shot(page, `${P}-flt-prof-ok`, { full: false });
        await page.evaluate(`closeBikeProfile();openBikeProfile('b03')`);
        await shot(page, `${P}-flt-prof-none`, { full: false });
        await page.evaluate(`closeBikeProfile()`);
      });

      test(`option lists ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await draw(page, `${FRESH}S._bkBrand='Alvas';renderBikes()`);
        await page.evaluate(`showOptListModal('models')`);
        await shot(page, `${P}-flt-opt`, { full: false });
        await page.evaluate(`closeOptListModal();showOptListModal('frames')`);
        await shot(page, `${P}-flt-opt-frames`, { full: false });
        await page.evaluate(`closeOptListModal();S.staffOptions={...S.staffOptions,bike_groupsets:[]};showOptListModal('groupsets')`);
        await page.evaluate(`S._optEdit.items=[];S._optEdit.add='Shimano';renderOptListModal()`);
        await shot(page, `${P}-flt-opt-empty`, { full: false });
        await page.evaluate(`closeOptListModal()`);
      });
    }
  });
}

// ── The policy without 'unsafe-inline' for styles ─────────────────────────────────────────────
// The page's own policy, with style-src 'self' alone: every screen above is opened and each
// violation's element is named. None may come from the fleet's markup (#tab-bikes, the profile,
// the option-list editor, the import preview). Function-form evaluate only: the string form is
// eval, which the policy forbids (tests/csp.spec.ts).
type Win = Window & { __flt: string[] };
declare const S: Record<string, unknown>;
declare function setStaffTab(t: string): void;
declare function renderInventory(): void;
declare function renderBikes(): void;
declare function startEdit(id: string): void;
declare function startClone(id: string): void;
declare function cancelBikeForm(): void;
declare function _resetBikeForm(): void;
declare function updateColorPreview(): void;
declare function openBikeProfile(id: string): void;
declare function closeBikeProfile(): void;
declare function showOptListModal(k: string): void;
declare function closeOptListModal(): void;
declare function _bkCsvPreview(t: string): void;
declare function closeConfirm(): void;
test.describe('@visual:fleet strict style policy', () => {
  test.use({ bypassCSP: false, ...VIEWPORTS.desktop });
  test('nothing the fleet draws trips style-src without unsafe-inline', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, FIX);
    await unlockStaff(page);
    await page.route((u) => u.pathname === '/', async (r) => {
      const res = await r.fetch();
      const headers = { ...res.headers() };
      headers['content-security-policy'] = (headers['content-security-policy'] || '').replace("style-src 'self' 'unsafe-inline'", "style-src 'self'");
      expect(headers['content-security-policy']).toContain("style-src 'self';");
      await r.fulfill({ response: res, headers });
    });
    await page.addInitScript(() => {
      (window as unknown as Win).__flt = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        const where = (n: unknown): string => {
          const el = n instanceof Element ? n : null;
          if (!el) return '(document)';
          const hosts = ['#tab-bikes', '#bike-profile-modal', '#optlist-modal', '#confirm-modal'];
          const host = hosts.find((h) => el.closest(h));
          return (host || 'outside') + ' ' + el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).join('.') : '');
        };
        (window as unknown as Win).__flt.push(`${e.violatedDirective} ${where(e.target)} ${e.sample || ''}`);
      }, true);
    });
    await page.goto('/');
    await page.waitForFunction(() => typeof S !== 'undefined' && !!S.dataLoaded && S.view === 'staff');
    const mark = () => page.evaluate(() => { (window as unknown as Win).__flt = []; });
    const take = () => page.evaluate(() => (window as unknown as Win).__flt.slice());
    const found: string[] = [];
    const run = async (label: string, fn: () => void) => {
      await mark();
      await page.evaluate(fn);
      await page.waitForTimeout(300);
      for (const v of await take()) found.push(label + ': ' + v);
    };
    await run('list', () => { setStaffTab('inventory'); S.invSection = 'bikes'; renderInventory(); });
    await run('selected', () => { S.bkSelected = ['b02', 'b01', 'b07']; S.bkSortCol = 'status'; S.bkSortDir = -1; S.bkShowRetired = true; renderBikes(); });
    await run('grid', () => { S.bkView = 'grid'; renderBikes(); });
    await run('grid maint', () => { S.bkStatus = 'maintenance'; S._fOpen = { bk: true }; renderBikes(); });
    await run('table maint', () => { S.bkView = 'table'; renderBikes(); });
    await run('none', () => { S.bkStatus = 'all'; S.bkSize = 'XL'; S.bkSearch = 'zzz'; renderBikes(); S.bkView = 'grid'; renderBikes(); });
    await run('reset', () => { S.bkSize = 'all'; S.bkSearch = ''; S.bkView = 'table'; renderBikes(); });
    await run('add', () => {
      _resetBikeForm(); S.showAddBike = true; S.addBikeType = 'Road'; S._bkNumber = '2'; S._bkNameCustom = true; S._bkName = 'Mine';
      S.addBikeColors = ['#111111', '#ee3333', '#00aa00', '#3366ff']; S.addBikeColorNames = ['a', '', 'b', 'c']; S._bkPhoto = '/icon-192.png';
      S._bkBrand = 'Alvas'; S._bkModel = 'Climax'; S._bkGroupsetAdd = true; S._bkRentalPrice = '123'; renderBikes();
      S.addBikeColors = ['#ffcc00']; updateColorPreview();
    });
    await run('desk', () => { S.staffRole = 'frontdesk'; S._bkRentalPrice = '95'; renderBikes(); S.staffRole = 'admin'; });
    await run('edit', () => { cancelBikeForm(); startEdit('b02'); });
    await page.waitForTimeout(500);
    await run('edit retired', () => { cancelBikeForm(); startEdit('b09'); });
    await run('clone', () => { cancelBikeForm(); startClone('b01'); });
    await run('profile', () => { cancelBikeForm(); openBikeProfile('b01'); closeBikeProfile(); openBikeProfile('b02'); closeBikeProfile(); openBikeProfile('b03'); closeBikeProfile(); });
    await run('options', () => { _resetBikeForm(); S.showAddBike = true; S._bkBrand = 'Alvas'; renderBikes(); showOptListModal('models'); closeOptListModal(); showOptListModal('frames'); closeOptListModal(); });
    await run('import', () => { _bkCsvPreview('number,type,size\n10,Road,M\nx,Bus,Q\n'); closeConfirm(); });
    await run('empty', () => { (S as { bikes: unknown[] }).bikes = []; renderBikes(); });
    const mine = found.filter((v) => !/ outside | \(document\) /.test(v));
    if (process.env.CSP_LOG) console.log(found.join('\n'));
    expect(mine).toEqual([]);
  });
});
