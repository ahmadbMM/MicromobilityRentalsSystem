import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

declare const _langLoaded: (l: string) => boolean; // app globals
declare const S: Record<string, unknown>;
declare const sb: unknown;
declare const _lastLoadOk: boolean | undefined;
declare const _refsLoaded: boolean | undefined;
declare const getQueue: () => { id: string }[];

// The inline-style move for the desk's dialogs in Bookings (playwright.visual.config.ts says how
// to run it): the walk-in form, the booking editor, calling off a night, the rider's cancel reason
// and reschedule, the return sheet (one rider, with the payment question, several at once), the
// payment question at return, the price editor, the booking-number editor, the add-on picker, the
// desk's reset-a-password tool, the waitlist promotion nudge and the staff cancel confirm. Every
// state is a screenshot and a hash of the computed style of every element on the page
// (cascade-audit.ts), in English and Arabic, at 1280x900 and 390x844, from fixed data on a frozen
// clock. The switches are pass3.visual.ts's: AUDIT=inline, AUDIT=class with AUDIT_CLASSES,
// MIN_CSS=1, CSS_DUMP. The last test turns a strict style-src on and lists the style attributes
// the policy refuses inside these dialogs (it must find none).

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
  sess('2026-09-17', { status: 'closed' }),
  sess(TODAY, { addons: js(['i1', 'i2', 'i3', 'i4', 'i5']) }),
  sess('2026-09-26', {}),
  sess('2026-09-27', { event_kind: 'community', needs_approval: true, spots: 10, capacity: 10, bike_slots: js({ _time: '06:30 - 07:00' }) }),
  sess('2026-09-29', { capacity: 2, bike_slots: js({ _time: '21:00 - 23:00', _total: 2 }) }),
  sess('2026-10-01', { ride_kind: 'swim', event_kind: 'community', needs_approval: true, spots: 8, capacity: 8, title: 'Pool Session', bike_slots: js({ _time: '07:00 - 08:00' }) }),
];
const bikes = [
  { id: 'b01', name: 'Road 1', type: 'Road', size: 'M', status: 'in-use', bike_number: 1, colors: ['#111'] },
  { id: 'b02', name: 'Hybrid 1', type: 'Hybrid', size: 'L', status: 'in-use', bike_number: 2, colors: ['#0a0'] },
  { id: 'b03', name: 'Mountain 1', type: 'Mountain', size: 'M', status: 'in-use', bike_number: 3 },
  { id: 'b04', name: 'Road 2', type: 'Road', size: 'M', status: 'available', bike_number: 4 },
  { id: 'b05', name: 'Road 3', type: 'Road', size: 'L', status: 'available', bike_number: 5 },
  { id: 'b06', name: 'Kids 1', type: 'Kids', size: 'S', status: 'available', bike_number: 6, rental_price: 0 },
  { id: 'b07', name: 'Carbon 1', type: 'Road Carbon', size: 'M', status: 'available', bike_number: 7, rental_price: 250 },
];
const customers = [
  { id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567', height: 165, type_preference: 'Road', created_at: '2026-08-20T10:00:00Z' },
  { id: 'c2', name: 'Omar Hassan', email: 'omar@example.test', phone: '0551234568', height: 180, type_preference: 'Hybrid', created_at: '2025-01-05T10:00:00Z' },
  { id: 'c3', name: 'Salem Nasser', email: 'salem@example.test', phone: '0551234569', created_at: '2026-09-01T10:00:00Z' },
];
const q = (id: string, n: number, sid: string, o: Row) => ({
  id, session_id: sid, session_day: dayOf(sid), session_date: sid, queue_num: n, status: 'waiting', paid: false, price: 57.5,
  type_preference: 'Hybrid', size: 'M', height: 172, registered_at: '2026-09-15T10:00:00Z', ...o,
});
const queue_entries = [
  q('t1', 1, TODAY, { name: 'Sara Ali', customer_id: 'c1', phone: '0551234567', status: 'active', paid: true, price: 75, type_preference: 'Road', assigned_bike_id: 'b01', checked_in_at: '2026-09-24T17:05:00Z', addons: js([{ id: 'i1', qty: 2 }, { id: 'i4', qty: 1 }]) }),
  q('t2', 2, TODAY, { name: 'Omar Hassan', customer_id: 'c2', phone: '0551234568' }),
  q('t3a', 3, TODAY, { name: 'Huda Karim', phone: '0550000031', group_id: 'g3' }),
  q('t3b', 3, TODAY, { name: 'Reem Karim', group_id: 'g3', type_preference: 'Kids', size: 'S', height: 128 }),
  q('t4', 4, TODAY, { name: 'Tariq Salim with a rather long name', phone: '0550000004', status: 'active', assigned_bike_id: 'b02', type_preference: 'Hybrid', size: 'L', checked_in_at: '2026-09-24T17:10:00Z', addons: js([{ id: 'i2', qty: 1 }]) }),
  q('t5', 5, TODAY, { name: 'Jana Fahad', status: 'active', assigned_bike_id: 'b03', type_preference: 'Mountain', price: 42, checked_in_at: '2026-09-24T17:12:00Z' }),
  q('t6', 1, TODAY, { name: 'Walk-in Two', status: 'waitlist', waitlist_num: 1 }),
  q('t7', 6, TODAY, { name: 'Majed Omar', phone: '0550000007', status: 'active', paid: true, price: 0, type_preference: 'Kids', size: 'S', assigned_bike_id: 'b06', checked_in_at: '2026-09-24T17:15:00Z' }),
  q('t8', 7, TODAY, { name: 'Noura Saad', phone: '0551234567', paid: true, price: 57.5 }),
  q('f1', 1, '2026-09-29', { name: 'Full One' }),
  q('f2', 2, '2026-09-29', { name: 'Full Two' }),
  q('r1', 1, '2026-09-26', { name: 'Sara Ali', customer_id: 'c1', phone: '0551234567', type_preference: 'Road' }),
  q('a1', 1, '2026-09-27', { name: 'Lina Saleh', approval: 'approved', price: 0, phone: '0550000011' }),
  q('w1', 1, '2026-10-01', { name: 'Pool Rider', phone: '0550000012', status: 'active', price: 30, checked_in_at: '2026-09-24T17:20:00Z' }),
];
const inventory = [
  { id: 'i1', name: 'Water', brand: 'Nova', category: 'Drinks', qty: 30, price: 5, addon: true, photo: '/icon-192.png' },
  { id: 'i2', name: 'Energy bar with a name long enough to wrap', category: 'Snacks', qty: 3, price: 8, addon: true },
  { id: 'i3', name: 'Helmet rental', category: 'Gear', qty: 8, price: 15, addon: true, photo: '/icon-192.png' },
  { id: 'i4', name: 'Gloves', category: 'Gear', qty: 0, price: 20, addon: true },
  { id: 'i5', name: 'Iso drink', category: 'Drinks', qty: 0, price: 0, addon: true, nutrition: js({ kcal: 90, carbs_g: 22 }) },
];
const FIX = { sessions, bikes, customers, queue_entries, inventory };

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
type Open = { lang: string; fx?: Record<string, unknown>; customer?: boolean };
async function open(page: Page, o: Open) {
  await page.clock.setFixedTime(NOW);
  await minCss(page);
  await stubSupabase(page, { ...FIX, ...(o.fx || {}) });
  if (o.customer) await loginCustomer(page, { id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567' });
  else await unlockStaff(page);
  await page.addInitScript((lang) => {
    localStorage.setItem('cq_lang', lang);
    localStorage.setItem('cq_lang_pick', '1');
  }, o.lang);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, o.lang);
  if (!o.customer) await page.waitForFunction(`S.view==='staff'`);
  await page.waitForFunction(`getComputedStyle(document.getElementById('loading-screen')).display==='none'`);
  await page.evaluate(`window._tickRefreshLabel=function(){};window._sb=function(){return 'auto'}`);
  if (o.customer) {
    // The staff rail's hidden Inventory label counts sold-out stock when setLang draws it, which is
    // before or after the stock arrives depending on when the language pack does: draw it again
    // once everything is in, so every run hashes the same page.
    await page.evaluate(`S.loggedIn=getSession();setLang(document.documentElement.lang)`);
  }
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
// Every shot is of the viewport: the dialogs are fixed over the page. `roots` names what the
// inline audit lists (the dialog's host); the hashes always cover the whole page.
async function shot(page: Page, name: string, roots: string[]) {
  await quiet(page);
  await settle(page);
  await expect.soft(page).toHaveScreenshot(name + '.png', { fullPage: false, timeout: 30000 });
  await quiet(page);
  const hashes = await page.evaluate(styleHashes, { roots: ['body'], ignore: '^--dk-', stripOrigin: true });
  if (process.env.CSS_DUMP) {
    mkdirSync(join(SNAPS, '_dump'), { recursive: true });
    writeFileSync(join(SNAPS, '_dump', `${name}-${Date.now()}.json`), JSON.stringify(await page.evaluate(styleOf, process.env.CSS_DUMP), null, 1));
  }
  expect.soft(JSON.stringify(hashes, null, 0).replace(/","/g, '",\n"')).toMatchSnapshot(name + '.css.txt');
  const mode = process.env.AUDIT;
  if (mode === 'inline' || mode === 'class') {
    const rows = await page.evaluate(cascadeAudit, { roots: mode === 'inline' ? roots : ['body'], classes: CLASSES, inline: mode === 'inline' });
    if (mode === 'inline') audits[name] = rows;
    else expect.soft(rows.filter((r) => r.hits.length), name).toEqual([]);
  }
}
// A tall dialog on a phone: its lower half, scrolled inside the box (or the backdrop).
async function scrollDown(page: Page, host: string) {
  await page.evaluate((h) => {
    const root = document.querySelector(h);
    if (!root) return;
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))] as HTMLElement[]) if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = 1e6;
  }, host);
}
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  if (process.env.AUDIT !== 'inline' || !Object.keys(audits).length) return;
  mkdirSync(join(SNAPS, '_audit'), { recursive: true });
  writeFileSync(join(SNAPS, '_audit', info.title.replace(/\W+/g, '_') + '-' + info.project.name + '-' + info.workerIndex + '-' + Date.now() + '.json'), JSON.stringify(audits, null, 1));
  for (const k of Object.keys(audits)) delete audits[k];
});
const run = (page: Page, code: string) => page.evaluate(code);

test.describe.configure({ timeout: 300000 }); // a loaded machine runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:desk ${vpName}`, () => {
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`walk-in ${lang}`, async ({ page }) => {
        await open(page, { lang });
        const R = ['#walkin-modal'];
        await run(page, `S.sfSession=${js(TODAY)};showWalkinModal()`);
        await shot(page, `${P}-wi-new`, R);
        await run(page, `_wiRenderSuggest('Sa')`);
        await shot(page, `${P}-wi-suggest`, R);
        await run(page, `_wiPickCust('c1')`);
        await shot(page, `${P}-wi-account`, R); // the account's Road, painted by a re-render
        await run(page, `_wiSetType('Hybrid');document.getElementById('wi-height').value='185';_wiStockHint()`);
        await shot(page, `${P}-wi-type-set`, R); // the pills restyled in place, the stock hint coloured
        await run(page, `_wiSetType('Kids');document.getElementById('wi-height').value='120';_wiStockHint()`);
        await shot(page, `${P}-wi-nostock`, R);
        await run(page, `_wiAddRider();_wiAddRider()`);
        await shot(page, `${P}-wi-party`, R);
        await scrollDown(page, '#walkin-modal');
        await shot(page, `${P}-wi-party-end`, R);
        await run(page, `closeWalkinModal();S.sfSession=${js(TODAY)};showWalkinModal();saveWalkin()`);
        await shot(page, `${P}-wi-err`, R); // no name
        await run(page, `closeWalkinModal();S.sfSession='2026-09-27';S._wiType='Own';showWalkinModal()`);
        await shot(page, `${P}-wi-own`, R); // a ride that takes owners: one more pill
        await run(page, `closeWalkinModal()`);
      });

      test(`booking edit ${lang}`, async ({ page }) => {
        await open(page, { lang });
        const R = ['#booking-edit-modal'];
        await run(page, `showBookingEditModal('t2')`);
        await shot(page, `${P}-be-waiting`, R);
        await run(page, `_on_showBookingEditModal_1(null,null,'Road','t2')`);
        await shot(page, `${P}-be-type`, R);
        await run(page, `_beAddRider();_beAddRider()`);
        await shot(page, `${P}-be-riders`, R);
        await scrollDown(page, '#booking-edit-modal');
        await shot(page, `${P}-be-riders-end`, R);
        await run(page, `closeBookingEditModal();showBookingEditModal('t1')`);
        await shot(page, `${P}-be-active`, R); // the move note for a checked-in rider
        await run(page, `closeBookingEditModal();showBookingEditModal('t8')`);
        await shot(page, `${P}-be-paid`, R);
        await run(page, `closeBookingEditModal();showBookingEditModal('a1')`);
        await shot(page, `${P}-be-approval`, R); // an approval ride: no add-riders row
        await run(page, `closeBookingEditModal()`);
      });

      test(`cancel night ${lang}`, async ({ page }) => {
        await open(page, { lang });
        const R = ['#cancel-night-modal'];
        await run(page, `showCancelNight(${js(TODAY)})`);
        await shot(page, `${P}-cn`, R);
        await scrollDown(page, '#cancel-night-modal');
        await shot(page, `${P}-cn-end`, R);
        await run(page, `closeCancelNight()`);
      });

      test(`return ${lang}`, async ({ page }) => {
        await open(page, { lang });
        const R = ['#return-modal'];
        await run(page, `doReturn('t1')`);
        await shot(page, `${P}-rt-paid`, R);
        await run(page, `_retSetCond('damaged')`);
        await shot(page, `${P}-rt-damaged`, R);
        await run(page, `closeReturnModal();doReturn('t4')`);
        await shot(page, `${P}-rt-ask`, R); // the payment question on the same sheet
        await run(page, `_retSetPaid(true);_retSetCond('needs_check')`);
        await shot(page, `${P}-rt-ask-paid`, R);
        await run(page, `closeReturnModal();S._retId='t2';S._retPaid=false;S._retAsk=false;S._retCond='ok';S._retNotes='';renderReturnModal()`);
        await shot(page, `${P}-rt-nobike`, R); // no bike to name
        await run(page, `closeReturnModal();showBulkReturn(['t1','t4','t5'])`);
        await shot(page, `${P}-br-owe`, R);
        await run(page, `_brSetCond('t4','damaged');_brSetCond('t5','needs_check')`);
        await shot(page, `${P}-br-notes`, R);
        await run(page, `_brSetPay('paid')`);
        await shot(page, `${P}-br-paid`, R);
        await scrollDown(page, '#return-modal');
        await shot(page, `${P}-br-paid-end`, R);
        await run(page, `closeBulkReturn();showBulkReturn(['t1','t7'])`);
        await shot(page, `${P}-br-allpaid`, R);
        await run(page, `closeBulkReturn()`);
      });

      test(`return pay ${lang}`, async ({ page }) => {
        await open(page, { lang });
        const R = ['#return-pay-modal'];
        await run(page, `doReturn('w1')`); // a swim: nothing to inspect, the payment question alone
        await page.waitForFunction(`document.getElementById('return-pay-modal').style.display==='flex'`);
        await shot(page, `${P}-rp`, R);
        await run(page, `closeReturnPayModal();showReturnPayModal('t4')`);
        await shot(page, `${P}-rp-addons`, R);
        await run(page, `closeReturnPayModal()`);
      });

      test(`edit price ${lang}`, async ({ page }) => {
        await open(page, { lang });
        const R = ['#edit-price-modal'];
        await run(page, `showEditPriceModal('t1')`);
        await shot(page, `${P}-ep-addons`, R); // add-ons with steppers, the Road preset ticked
        await scrollDown(page, '#edit-price-modal');
        await shot(page, `${P}-ep-addons-end`, R);
        await run(page, `closeEditPriceModal();showEditPriceModal('t2')`);
        await shot(page, `${P}-ep-plain`, R); // no add-ons, the default fare ticked
        await run(page, `closeEditPriceModal();showEditPriceModal('t7')`);
        await shot(page, `${P}-ep-house`, R); // on the house: SAR 0 ticked
        await run(page, `closeEditPriceModal();showEditPriceModal('t5')`);
        await shot(page, `${P}-ep-custom`, R); // a figure no preset has
        await run(page, `closeEditPriceModal();showEditPriceModal('t4')`);
        await shot(page, `${P}-ep-custom-addons`, R);
        await page.locator('#ep-custom').focus();
        await shot(page, `${P}-ep-focus`, R);
        await run(page, `closeEditPriceModal()`);
      });

      test(`add-on picker ${lang}`, async ({ page }) => {
        await open(page, { lang });
        const R = ['#addon-picker-backdrop'];
        await run(page, `showAddonPicker('t1')`);
        await shot(page, `${P}-ap`, R); // held, low, plenty, out, out but held, free with nutrition
        await scrollDown(page, '#addon-picker-backdrop');
        await shot(page, `${P}-ap-end`, R);
        await run(page, `closeAddonPicker();showAddonPicker('t6')`);
        await shot(page, `${P}-ap-waitlist`, R);
        await run(page, `closeAddonPicker();showAddonPicker('r1')`);
        await shot(page, `${P}-ap-none`, R); // a session that sells nothing
        await run(page, `closeAddonPicker();_epOpenAddons('t4')`);
        await shot(page, `${P}-ap-from-price`, R);
        await run(page, `closeAddonPicker()`); // back to the price editor
        await shot(page, `${P}-ap-back`, ['#edit-price-modal']);
        await run(page, `closeEditPriceModal()`);
      });

      test(`booking number ${lang}`, async ({ page }) => {
        await open(page, { lang });
        const R = ['#qnum-edit-modal'];
        await run(page, `showEditQNumModal('t2')`);
        await page.waitForFunction(`document.activeElement&&document.activeElement.id==='qnum-inp'`);
        await shot(page, `${P}-qn`, R); // focused: the green border
        await run(page, `document.getElementById('qnum-inp').blur()`);
        await shot(page, `${P}-qn-blur`, R);
        await run(page, `closeEditQNumModal();showEditQNumModal('t3a')`);
        await page.waitForFunction(`document.activeElement&&document.activeElement.id==='qnum-inp'`);
        await shot(page, `${P}-qn-group`, R);
        await run(page, `closeEditQNumModal()`);
      });

      test(`cancel confirm and nudge ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await run(page, `_staffCancelConfirm(getQueue().find(e=>e.id==='t2'),()=>{})`);
        await shot(page, `${P}-cx`, ['#confirm-modal']);
        await run(page, `_cxPick('other')`);
        await shot(page, `${P}-cx-other`, ['#confirm-modal']);
        await run(page, `_cxPick('other')`);
        await shot(page, `${P}-cx-other-off`, ['#confirm-modal']);
        // the nudge takes itself away after 25 s; a slow shot must not race that, so its timer is not set
        const nudge = (o: string) => run(page, `(()=>{const st=window.setTimeout;window.setTimeout=(f,ms,...a)=>ms>=25000?0:st(f,ms,...a);try{_promoNudge(${o})}finally{window.setTimeout=st}})()`);
        await run(page, `closeConfirm()`);
        await nudge(`{name:'Sara Ali',phone:'0551234567'}`);
        await shot(page, `${P}-nudge`, ['#promo-nudge']);
        await nudge(`{name:'Tariq Salim with a rather long name that will not fit on one line',phone:'0550000004'}`);
        await shot(page, `${P}-nudge-long`, ['#promo-nudge']);
      });

      test(`reset password ${lang}`, async ({ page }) => {
        await open(page, { lang, fx: { customers: [customers[0]], 'rpc:staff_set_customer_password': true } });
        const R = ['#staff-reset-result'];
        await run(page, `S.showResetTool=true;renderStaffQueue();window.scrollTo(0,0)`);
        await page.waitForFunction(`!!document.getElementById('staff-reset-result')`);
        await run(page, `document.getElementById('staff-reset-email').value='not-an-address';staffResetPassword()`);
        await shot(page, `${P}-sr-err`, R);
        await run(page, `document.getElementById('staff-reset-email').value='sara@example.test';document.getElementById('staff-reset-pw').value='short';staffResetPassword()`);
        await shot(page, `${P}-sr-err-pw`, R);
        await run(page, `document.getElementById('staff-reset-pw').value='Newpass2026';staffResetPassword()`);
        await page.waitForFunction(`!!document.querySelector('#staff-reset-result strong')`);
        await shot(page, `${P}-sr-done`, R);
      });

      test(`reset password, no account ${lang}`, async ({ page }) => {
        await open(page, { lang, fx: { customers: [] } });
        await run(page, `S.showResetTool=true;renderStaffQueue();window.scrollTo(0,0)`);
        await page.waitForFunction(`!!document.getElementById('staff-reset-result')`);
        await run(page, `document.getElementById('staff-reset-email').value='nobody@example.test';document.getElementById('staff-reset-pw').value='Newpass2026';staffResetPassword()`);
        await page.waitForFunction(`!!document.querySelector('#staff-reset-result div')`);
        await shot(page, `${P}-sr-none`, ['#staff-reset-result']);
      });

      test(`rider cancel reason ${lang}`, async ({ page }) => {
        await open(page, { lang, customer: true });
        const R = ['#cancel-reason-modal'];
        await run(page, `showCancelReasonModal('r1')`);
        await shot(page, `${P}-cr`, R);
        await page.locator('#cancel-reason-modal .cancel-reason-opt').nth(1).hover();
        await shot(page, `${P}-cr-hover`, R); // the hover border, set by the mouseover handler
        await page.locator('#cancel-reason-modal .cancel-reason-opt').nth(1).click();
        await page.mouse.move(0, 0);
        await shot(page, `${P}-cr-picked`, R);
        await page.locator('#cancel-reason-modal .cancel-reason-opt').last().click();
        await page.mouse.move(0, 0);
        await shot(page, `${P}-cr-other`, R); // the text box shown
        await run(page, `closeCancelReasonModal()`);
      });

      test(`rider reschedule ${lang}`, async ({ page }) => {
        await open(page, { lang, customer: true });
        const R = ['#reschedule-modal'];
        await run(page, `showRescheduleModal('2026-09-26')`);
        await shot(page, `${P}-rs`, R); // tonight open, the 29th full
        await run(page, `closeRescheduleModal()`);
      });

      test(`rider reschedule, nothing to move to ${lang}`, async ({ page }) => {
        await open(page, { lang, customer: true, fx: { sessions: sessions.filter((s) => s.id === '2026-09-26' || s.id === '2026-09-17') } });
        await run(page, `showRescheduleModal('2026-09-26')`);
        await shot(page, `${P}-rs-none`, ['#reschedule-modal']);
        await run(page, `closeRescheduleModal()`);
      });
    }
  });
}

// ── The policy without 'unsafe-inline' for styles ─────────────────────────────────────────
// The page is served with style-src 'self' only, and every refused style attribute is listed
// with the element it was on. Other areas still write inline styles, so only a refusal on an
// element inside one of these dialogs counts. Function-form evaluate only (the string form is
// eval, which the policy forbids).
const HOSTS = ['#walkin-modal', '#booking-edit-modal', '#cancel-night-modal', '#cancel-reason-modal', '#reschedule-modal', '#return-modal',
  '#return-pay-modal', '#edit-price-modal', '#qnum-edit-modal', '#addon-picker-backdrop', '#staff-reset-result', '#promo-nudge', '#confirm-modal'];
type W = Window & { __v: { t: string; s: string; mine: boolean }[] } & Record<string, (...a: unknown[]) => unknown>;
test.describe('@visual:desk strict style-src', () => {
  test.use({ bypassCSP: false, viewport: { width: 1280, height: 900 } });
  for (const lang of ['en', 'ar']) {
    for (const who of ['staff', 'customer'] as const) {
      test(`no style attribute is refused inside the desk dialogs (${who}, ${lang})`, async ({ page }) => {
        await page.clock.setFixedTime(NOW);
        await page.route((u) => u.pathname === '/', async (r) => {
          const res = await r.fetch();
          const h = { ...res.headers() };
          const csp = h['content-security-policy'] || '';
          expect(csp).toMatch(/style-src 'self'/); expect(csp).not.toMatch(/style-src[^;]*'unsafe-inline'/); // Served this way since 2026-09-29: the page's own style-src has no 'unsafe-inline' left to take away.
          h['content-security-policy'] = csp.replace("style-src 'self' 'unsafe-inline'", "style-src 'self' 'report-sample'"); // the sample: what a refusal on no element was
          await r.fulfill({ response: res, headers: h });
        });
        await stubSupabase(page, { ...FIX, customers: [customers[0]], 'rpc:staff_set_customer_password': true }); // one account: the reset finds it
        if (who === 'customer') await loginCustomer(page, { id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567' });
        else await unlockStaff(page);
        await page.addInitScript(([l, hosts]) => {
          localStorage.setItem('cq_lang', l as string);
          localStorage.setItem('cq_lang_pick', '1');
          (window as unknown as W).__v = [];
          document.addEventListener('securitypolicyviolation', (e) => {
            if (!/^style-src/.test(e.violatedDirective)) return;
            const el = e.target instanceof Element ? e.target : null;
            const path = el ? (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' in ' + ((el.closest('[id]') || {}).id || '-') : String(e.target);
            (window as unknown as W).__v.push({ t: path, s: e.sample || '', mine: !!el && (hosts as string[]).some((h) => !!el.closest(h)) });
          }, true);
        }, [lang, HOSTS]);
        await page.goto('/');
        await page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && !!S.dataLoaded
          && (typeof _lastLoadOk === 'undefined' || _lastLoadOk === true) && (typeof _refsLoaded === 'undefined' || _refsLoaded === true), undefined, { timeout: 15000 });
        // Each step waits, so the refusals it causes are dispatched while its markup is still on the
        // page (a refusal whose element has gone by then is reported on the document instead).
        const call = async (fn: string, ...args: unknown[]) => {
          await page.evaluate(([f, a]) => { (window as unknown as W)[f as string](...(a as unknown[])); }, [fn, args] as const);
          await page.waitForTimeout(400);
        };
        if (who === 'customer') {
          await page.evaluate(() => { S.loggedIn = (window as unknown as W).getSession(); });
          await call('showCancelReasonModal', 'r1');
          await page.locator('#cancel-reason-modal .cancel-reason-opt').nth(1).hover();
          await page.locator('#cancel-reason-modal .cancel-reason-opt').nth(1).click();
          await page.locator('#cancel-reason-modal .cancel-reason-opt').last().click();
          await page.waitForTimeout(400);
          await call('closeCancelReasonModal');
          await call('showRescheduleModal', '2026-09-26');
          await call('closeRescheduleModal');
        } else {
          await page.waitForFunction(() => S.view === 'staff');
          await page.evaluate((d) => { S.sfSession = d; }, TODAY);
          await call('showWalkinModal');
          await call('_wiRenderSuggest', 'Sa');
          await call('_wiPickCust', 'c1');
          await call('_wiSetType', 'Kids');
          await call('_wiStockHint');
          await call('_wiAddRider');
          await call('saveWalkin'); // no name: the field's error
          await call('closeWalkinModal');
          for (const id of ['t2', 't1', 't8', 'a1']) { await call('showBookingEditModal', id); await call('_beAddRider'); await call('closeBookingEditModal'); }
          await call('showCancelNight', TODAY); await call('closeCancelNight');
          await call('doReturn', 't1'); await call('_retSetCond', 'damaged'); await call('closeReturnModal');
          await call('doReturn', 't4'); await call('_retSetPaid', true); await call('closeReturnModal');
          await call('showBulkReturn', ['t1', 't4', 't5']); await call('_brSetCond', 't4', 'damaged'); await call('_brSetPay', 'paid'); await call('closeBulkReturn');
          await call('showBulkReturn', ['t1', 't7']); await call('closeBulkReturn');
          await call('showReturnPayModal', 't4'); await call('closeReturnPayModal');
          for (const id of ['t1', 't2', 't7', 't5']) { await call('showEditPriceModal', id); await call('closeEditPriceModal'); }
          await call('showEditPriceModal', 't1'); await call('_epOpenAddons', 't1'); await call('closeAddonPicker'); await call('closeEditPriceModal');
          for (const id of ['t6', 'r1']) { await call('showAddonPicker', id); await call('closeAddonPicker'); }
          for (const id of ['t2', 't3a']) { await call('showEditQNumModal', id); await call('closeEditQNumModal'); }
          await page.evaluate(() => { (window as unknown as W)._staffCancelConfirm(getQueue().find((e) => e.id === 't2'), () => {}); });
          await page.waitForTimeout(400);
          await call('_cxPick', 'other'); await call('closeConfirm');
          await call('_promoNudge', { name: 'Sara Ali', phone: '0551234567' });
          await page.evaluate(() => { S.showResetTool = true; (window as unknown as W).renderStaffQueue(); });
          await page.evaluate(() => { (document.getElementById('staff-reset-email') as HTMLInputElement).value = 'x'; });
          await call('staffResetPassword');
          await page.evaluate(() => { (document.getElementById('staff-reset-email') as HTMLInputElement).value = 'sara@example.test'; (document.getElementById('staff-reset-pw') as HTMLInputElement).value = 'short'; });
          await call('staffResetPassword');
          await page.evaluate(() => { (document.getElementById('staff-reset-pw') as HTMLInputElement).value = 'Newpass2026'; });
          await call('staffResetPassword');
          await page.waitForFunction(() => !!document.querySelector('#staff-reset-result strong'));
          await page.waitForTimeout(400);
        }
        // a style attribute the policy must refuse, so a run that finds nothing says something
        await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<i id="dk-probe" style="color:red"></i>'));
        await page.waitForTimeout(400);
        const v = await page.evaluate(() => (window as unknown as W).__v);
        mkdirSync(join(SNAPS, '_strict'), { recursive: true });
        writeFileSync(join(SNAPS, '_strict', `${who}-${lang}.json`), JSON.stringify(v, null, 1));
        expect(v.map((x) => x.t), 'the probe was refused: the check is live').toContain('#dk-probe in dk-probe');
        expect(v.filter((x) => x.mine)).toEqual([]);
      });
    }
  }
});
