import { test, expect, type Page, type Locator } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, loadStaffHalf } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

declare const _langLoaded: (l: string) => boolean; // app global

// The customer pages without inline styles (playwright.visual.config.ts says how to run it): the
// Sign in, Create account, Google completion and forgotten-password pages with their errors; the
// booking wizard from the session list (and the one-session card, no sessions, a load error) through
// the riders, the waiver and the review (add-ons, promo codes, the already-booked banner) to the
// tickets; My Bookings with every kind of card (a party, on a bike, the waitlist, a ride staff
// approve before and after the verdict, the National Day ride, past rides to rate); the rating
// dialog; the account page (the season figures, badges, profile, ride news, notifications,
// purchases, deletion) and a badge's popup; the Privacy Notice; the consent and forced-password
// popups; the booth and National Day popups; and the staff customer form's social fields. Every
// state is a screenshot and a hash of the computed style of every element on the page but the
// hidden staff half (the staff form: of its dialog) (cascade-audit.ts), in English and Arabic, at
// 1280x900 and 390x844, from fixed data on a frozen clock. The switches are pass3.visual.ts's:
// AUDIT=inline, AUDIT=class with AUDIT_CLASSES, MIN_CSS=1, CSS_DUMP; and STRICT=1 runs the
// strict-policy check instead of the shots, writing every refused inline style to VISUAL_SNAPS/_strict.

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
const COMM = { event_kind: 'community', needs_approval: true };
const sessions = [
  sess('2026-09-17', { status: 'closed' }),
  sess('2026-09-19', { status: 'closed', ...COMM, spots: 10, capacity: 10, hide_queue: false, bike_slots: js({ _time: '06:30 - 07:00' }) }),
  sess('2026-09-22', { status: 'closed' }),
  sess(TODAY, { bike_slots: js({ _time: '21:00 - 23:00', _total: 12, _collect: '20:15' }) }),
  sess('2026-09-25', { addons: js(['i1', 'i2', 'i3', 'i4']) }),
  sess('2026-09-26', { ...COMM, spots: 20, capacity: 20, hide_queue: false, title: 'Saturday Social Ride', meet_url: 'https://maps.example.test/a', bike_slots: js({ _time: '06:30 - 07:00' }) }),
  sess('2026-09-27', { status: 'full', addons: js(['i1']) }),
  sess('2026-09-28', { addons: js(['i3']) }),
  sess('2026-10-01', { ...COMM, ride_kind: 'workshop', spots: 12, capacity: 12, open_to_all: true, title: 'T100 Triathlon Prep', bike_slots: js({ _time: '18:00 - 20:00' }) }),
  sess('2026-10-02', { ride_kind: 'snd96', capacity: 20, title: 'National Day Ride', bike_slots: tot('06:00 - 08:00', 20, { _collect: '05:15' }) }),
  sess('2026-10-03', { ...COMM, ride_kind: 'event', spots: 30, capacity: 30, title: 'Bike Film Night', description: 'Short films about riding.', price: 25, open_to_all: true, bike_slots: js({ _time: '19:00 - 21:00' }) }),
];
const bikes = [
  { id: 'b01', name: 'Road 1', type: 'Road', size: 'M', status: 'in-use', brand: 'Alvas', model: 'Climax', groupset: 'Shimano 105', speeds: 22, bike_number: 1, colors: ['#111', '#e33'] },
  { id: 'b02', name: 'Hybrid 1', type: 'Hybrid', size: 'L', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 2 },
  { id: 'b03', name: 'Mountain 1', type: 'Mountain', size: 'M', status: 'available', brand: 'Alvas', model: 'Strom M50', bike_number: 3 },
];
const inventory = [
  { id: 'i1', name: 'Water', brand: 'Nova', category: 'Drinks', qty: 30, price: 5, addon: true, photo: '/icon-192.png' },
  { id: 'i2', name: 'Energy bar', category: 'Snacks', qty: 12, price: 8, addon: true, nutrition: { kcal: 210, protein_g: 10 } },
  { id: 'i3', name: 'Helmet rental', category: 'Gear', qty: 6, price: 15, addon: true },
  { id: 'i4', name: 'Gloves', brand: 'Grip', category: 'Gear', qty: 0, price: 20, addon: true },
];
const CUST = {
  id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '+966551234567', session_token: 'tok-spec', height: 165,
  gender: 'female', birth_date: '1990-05-05', country: 'Saudi Arabia', city: 'Jeddah', type_preference: 'Road',
  created_at: '2025-03-20T10:00:00Z', socials: { instagram: 'sara.rides', strava: '12345' },
};
const q = (id: string, n: number, sid: string, o: Row) => ({
  id, session_id: sid, session_day: dayOf(sid), session_date: sid, queue_num: n, status: 'waiting', paid: false, price: 80,
  type_preference: 'Hybrid', size: 'M', height: 165, registered_at: '2026-09-15T10:00:00Z', customer_id: 'c1', name: 'Sara Ali', ...o,
});
// The rider's own bookings (my_bookings): a party of three on Friday, on a bike tonight, waitlisted on
// Sunday, confirmed on the Saturday ride, under review at the workshop, the National Day ride (a party
// whose numbers are not consecutive), and past rides - done and paid, rated and not, a free Saturday.
const mine = [
  q('m1', 4, '2026-09-25', { paid: true, type_preference: 'Road', addons: js([{ id: 'i1', qty: 2 }, 'i3']) }),
  q('m2', 5, '2026-09-25', { name: 'Omar Ali', type_preference: 'Any', price: 57.5 }),
  q('m3', 6, '2026-09-25', { name: 'Lina Ali', type_preference: 'Kids', price: 0, paid: true, height: 120, addons: js(['i2']) }),
  q('m4', 1, TODAY, { status: 'active', paid: true, assigned_bike_id: 'b01', type_preference: 'Road', checked_in_at: '2026-09-24T18:05:00Z' }),
  q('m5', 9, '2026-09-27', { status: 'waitlist', waitlist_num: 2 }),
  q('m6', 3, '2026-09-26', { price: 0, approval: 'approved' }),
  q('m7', 2, '2026-10-01', { price: 0, approval: 'pending', type_preference: 'None' }),
  q('m8', 3, '2026-10-02', { price: 80 }),
  q('m9', 7, '2026-10-02', { name: 'Omar Ali', price: 80 }),
  q('p1', 2, '2026-09-22', { status: 'done', paid: true, type_preference: 'Road', assigned_bike_id: 'b01', ride_duration: 95, checked_in_at: '2026-09-22T18:05:00Z', checked_out_at: '2026-09-22T19:40:00Z', addons: js(['i1']) }),
  q('p2', 5, '2026-09-17', { status: 'done', paid: true, rating_exp: 9, rating_bike: 8, ride_duration: 60, checked_in_at: '2026-09-17T18:20:00Z', checked_out_at: '2026-09-17T19:20:00Z' }),
  q('p3', 1, '2026-09-19', { status: 'done', paid: false, price: 0, approval: 'approved', rating_exp: 10 }),
];
// Other riders on Friday, ahead of the party, so its cue says "in the queue"
const others = [1, 2, 3].map((n) => ({ id: 'o' + n, session_id: '2026-09-25', session_day: 'Friday', session_date: '2026-09-25', queue_num: n, status: 'waiting', type_preference: 'Hybrid', size: 'M' }));
const PRIV = '2026-09-28';
const FIX: Record<string, unknown> = {
  sessions, bikes, inventory, queue_entries: [...mine, ...others], // the open door the suite's stub takes (cq_secure_auth 0)
  'rpc:customer_profile': [{ ...CUST, nationality: 'SA' }],
  'rpc:customer_consents': { privacy_version: PRIV, privacy_at: '2026-09-22T10:00:00Z', ride_news: true, ride_news_at: '2026-09-22T10:00:00Z' },
  'rpc:customer_deletion_request': { requested_at: null },
  'rpc:customer_my_badges': [{ slug: 'marshal', icon: 'flag', color: 'green', name: 'Marshal', name_ar: 'مارشال', note: 'Thanks for leading the group', at: '2026-09-20T10:00:00Z' }],
  'rpc:community_member': true,
};

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

type Open = { lang: string; fx?: Record<string, unknown>; out?: boolean; path?: string; staff?: boolean };
async function minCss(page: Page) {
  if (!process.env.MIN_CSS) return;
  await page.route(/\/styles\.css/, async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, body: new CleanCSS({ level: 1 }).minify(await res.text()).styles });
  });
}
// STRICT=1: the page's Content-Security-Policy loses style-src 'unsafe-inline' (script-src gains
// 'unsafe-eval' for the harness's own string-form evaluate calls, which change nothing about styles),
// and every refused inline style is recorded with the element it sits on instead of a screenshot.
const STRICT = !!process.env.STRICT;
async function strictPolicy(page: Page) {
  await page.route((u) => u.hostname === '127.0.0.1' && (u.pathname === '/' || u.pathname === '/signup'), async (r) => {
    if (r.request().resourceType() !== 'document') return r.fallback();
    const res = await r.fetch();
    const h = { ...res.headers() };
    const k = Object.keys(h).find((x) => x.toLowerCase() === 'content-security-policy');
    if (k) h[k] = h[k].replace("style-src 'self' 'unsafe-inline'", "style-src 'self'").replace("script-src 'self'", "script-src 'self' 'unsafe-eval'");
    await r.fulfill({ response: res, headers: h });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __viol: string[] };
    w.__viol = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      const el = e.target as Element | null;
      const path: string[] = [];
      for (let n: Element | null = el && el.nodeType === 1 ? el : null; n && n !== document.body; n = n.parentElement) {
        path.unshift(n.id ? '#' + n.id : n.tagName.toLowerCase() + (n.classList.length ? '.' + [...n.classList].join('.') : ''));
        if (n.id) break;
      }
      w.__viol.push(`${e.violatedDirective} ${path.join(' > ') || String(e.target)} ${(el && el.getAttribute && el.getAttribute('style')) || ''}`);
    }, true);
  });
}
let STAFF_FORM = false;
async function open(page: Page, o: Open) {
  STAFF_FORM = !!o.staff;
  page.setDefaultTimeout(60000); // a state that never draws fails in a minute, not at the test's end
  await page.clock.setFixedTime(NOW);
  if (STRICT) await strictPolicy(page);
  await minCss(page);
  await stubSupabase(page, { ...FIX, ...(o.fx || {}) });
  if (o.staff) await unlockStaff(page);
  else if (!o.out) await loginCustomer(page, CUST);
  await page.addInitScript((lang) => {
    localStorage.setItem('cq_lang', lang);
    localStorage.setItem('cq_lang_pick', '1');
  }, o.lang);
  await page.goto(o.path || '/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, o.lang);
  await page.waitForFunction(`getComputedStyle(document.getElementById('loading-screen')).display==='none'`);
  // a scroll-into-view is instant, so a shot never catches one halfway; toasts never cover a shot
  await page.evaluate(`window._sb=function(){return 'auto'};window.toast=function(){}`);
  // The signed-out page is drawn at boot, sometimes before the web fonts are in: its country-code
  // select then keeps a text position one pixel off until it is drawn again. Draw it again (as a
  // language switch does) once the fonts are in, so every run shows the same page.
  if (o.out) await page.evaluate(`document.fonts.ready.then(()=>{if(document.querySelector('#auth-modal .auth-title'))renderAuthModal()})`);
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
const strictSeen: string[] = [];
async function shot(page: Page, name: string, o: { full?: boolean; el?: Locator } = {}) {
  await quiet(page);
  await settle(page);
  if (STRICT) {
    const v = await page.evaluate(() => (window as unknown as { __viol: string[] }).__viol.splice(0));
    strictSeen.push(...v.map((x) => name + ' | ' + x));
    return;
  }
  if (o.el) await expect.soft(o.el).toHaveScreenshot(name + '.png', { timeout: 30000 });
  else await expect.soft(page).toHaveScreenshot(name + '.png', { fullPage: o.full !== false, timeout: 30000 });
  await quiet(page);
  // On the customer pages the staff half sits hidden in the page and paints its own badges on its own
  // timers; it is left out (the staff customer form's test hashes its dialog).
  const roots = STAFF_FORM ? ['#new-acct-modal'] : await page.evaluate(() => [
    ...[...document.body.children].map((e, i) => (e.tagName === 'MAIN' ? '' : `body>:nth-child(${i + 1})`)),
    ...[...document.querySelector('body>main')!.children].map((e, i) => (e.id === 'view-staff' ? '' : `body>main>:nth-child(${i + 1})`)),
  ].filter(Boolean));
  const hashes = await page.evaluate(styleHashes, { roots, ignore: '^--cu-', stripOrigin: true }); // data-cssv's own properties (this pass's), and any port
  if (process.env.CSS_DUMP) {
    mkdirSync(join(SNAPS, '_dump'), { recursive: true });
    writeFileSync(join(SNAPS, '_dump', `${name}-${Date.now()}.json`), JSON.stringify(await page.evaluate(styleOf, process.env.CSS_DUMP), null, 1));
  }
  expect.soft(JSON.stringify(hashes, null, 0).replace(/","/g, '",\n"')).toMatchSnapshot(name + '.css.txt');
  const mode = process.env.AUDIT;
  if (mode === 'inline' || mode === 'class') {
    const rows = await page.evaluate(cascadeAudit, { roots: ['body'], classes: CLASSES, inline: mode === 'inline' });
    if (mode === 'inline') audits[name] = rows;
    else {
      const bad = rows.filter((r) => r.hits.length);
      if (bad.length) { mkdirSync(join(SNAPS, '_audit_class'), { recursive: true }); writeFileSync(join(SNAPS, '_audit_class', name + '.json'), JSON.stringify(bad, null, 1)); }
      expect.soft(bad, name).toEqual([]);
    }
  }
}
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  if (STRICT && strictSeen.length) {
    mkdirSync(join(SNAPS, '_strict'), { recursive: true });
    writeFileSync(join(SNAPS, '_strict', info.title.replace(/\W+/g, '_') + '-' + info.project.name + '-' + info.workerIndex + '-' + Date.now() + '.txt'), strictSeen.splice(0).join('\n'));
  }
  if (process.env.AUDIT !== 'inline' || !Object.keys(audits).length) return;
  mkdirSync(join(SNAPS, '_audit'), { recursive: true });
  writeFileSync(join(SNAPS, '_audit', info.title.replace(/\W+/g, '_') + '-' + info.project.name + '-' + info.workerIndex + '-' + Date.now() + '.json'), JSON.stringify(audits, null, 1));
  for (const k of Object.keys(audits)) delete audits[k];
});
// Each evaluate draws a state; the page goes back to the top so a full-page shot starts there.
const draw = (page: Page, code: string) => page.evaluate(code + ';window.scrollTo(0,0)');
const qrReady = (page: Page) => page.waitForFunction(`!!window.qrcode&&!document.querySelector('.qr-lazy')`);
// The wizard's state, from a clean start (regBookAnother's reset), then what each shot needs.
const REG0 = `S.lastTickets=[];S.selSession=null;S.regStep=1;S.regQty=1;S.regBikeSizes=[];S.regBikeHeights=[];S.regBikeTypes=[];S.regRiderNames=[];S.modifyEntryId=null;S._modKey=null;S._alreadyBookedSession=null;S.promoApplied=null;S._promoMsg='';S.regAddons=[];S.waiverOk=false;S._waiverSess=null;S._qtyCapNote=false;`;

test.describe.configure({ timeout: 300000 }); // a loaded machine runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:customer ${vpName}`, () => {
    test.use({ ...vp, bypassCSP: !STRICT });
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`sign in ${lang}`, async ({ page }) => {
        await open(page, { lang, out: true });
        await page.waitForFunction(`!!document.querySelector('#auth-modal .auth-title')`);
        await shot(page, `${P}-auth-login`);
        await draw(page, `S.rememberMe=true;renderAuthModal();authErr(t('errInvalidLogin')||'Wrong password')`);
        await shot(page, `${P}-auth-login-remember`);
        await draw(page, `toggleRememberMe()`); // the box un-ticked in place (CSSOM writes)
        await shot(page, `${P}-auth-login-untick`);
        await page.locator('#auth-modal button[data-on-click*="forgot"]').first().hover();
        await shot(page, `${P}-auth-forgot-hover`, { full: false });
        await page.mouse.move(0, 0);
        await draw(page, `window._isInAppBrowser=function(){return true};S.rememberMe=false;renderAuthModal()`);
        await shot(page, `${P}-auth-login-iab`);
      });

      test(`create account ${lang}`, async ({ page }) => {
        await open(page, { lang, out: true, path: '/signup' });
        await page.waitForFunction(`!!document.getElementById('a-first')`);
        await shot(page, `${P}-auth-signup`);
        await draw(page, `setSignupGender('male');toggleSignupAck()`);
        await shot(page, `${P}-auth-signup-male`);
        await draw(page, `setSignupGender('female');toggleSignupAck();toggleSignupRideNews();_fieldErr(document.getElementById('a-email'),t('errValidEmail'));_fieldErr(document.getElementById('a-phone'),t('errValidPhone'));_fieldErr(document.getElementById('a-height'),t('errValidHeightCm'))`);
        await shot(page, `${P}-auth-signup-errs`);
        await draw(page, `S.signupGender='female';S.signupAck=true;S.signupRideNews=true;renderAuthModal()`); // drawn with both ticked
        await shot(page, `${P}-auth-signup-ticked`);
        await draw(page, `S._pendingGoogle={name:'Sara Ali'};S.authMode='gcomplete';S.signupGender='male';S.signupAck=false;S.signupRideNews=false;renderAuthModal()`);
        await shot(page, `${P}-auth-gcomplete`);
        await draw(page, `S.authMode='forgot';S.forgotStep=1;S.forgotEmail='sara@example.test';renderAuthModal()`);
        await shot(page, `${P}-auth-forgot1`);
        await draw(page, `S.forgotStep=2;S.forgotVerified='pending';renderAuthModal()`);
        await shot(page, `${P}-auth-forgot2-pending`);
        await draw(page, `S.forgotVerified=true;renderAuthModal()`);
        await shot(page, `${P}-auth-forgot2-ok`);
      });

      test(`privacy, consent, password ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`showPrivacyNotice()`);
        await shot(page, `${P}-privacy`, { full: false });
        await page.evaluate(`closePrivacyNotice()`);
        await page.evaluate(`_consentAsk(true,true)`);
        await shot(page, `${P}-consent-both`, { full: false });
        await page.evaluate(`_consentAckMissing()`);
        await shot(page, `${P}-consent-missing`, { full: false });
        await page.evaluate(`_consentToggleAck();document.getElementById('rn-ask-err').textContent=t('errConnection')`);
        await shot(page, `${P}-consent-ticked`, { full: false });
        await page.evaluate(`document.getElementById('rn-ask').remove();_consentAsk(true,false)`);
        await shot(page, `${P}-consent-ack`, { full: false });
        await page.evaluate(`document.getElementById('rn-ask').remove();_consentAsk(false,true)`);
        await shot(page, `${P}-consent-news`, { full: false });
        await page.evaluate(`document.getElementById('rn-ask').remove();_pwdMustShow()`);
        await shot(page, `${P}-pwd-must`, { full: false });
        await page.evaluate(`document.getElementById('pm-err').textContent=t('errPasswordLen')`);
        await shot(page, `${P}-pwd-must-err`, { full: false });
        await page.evaluate(`document.getElementById('pwd-gate').remove();showBoothPopup()`);
        await shot(page, `${P}-booth`, { full: false });
        await page.evaluate(`S._popupHold&&clearTimeout(S._popupHold);S._popupHold=null;document.querySelector('#booth-popup .booth-popup-close').disabled=false;closeBoothPopup();showSnd96FormPopup(false)`);
        await shot(page, `${P}-snd96-popup`, { full: false });
        await page.evaluate(`S._popupHold&&clearTimeout(S._popupHold);S._popupHold=null;showSnd96FormPopup(true)`);
        await shot(page, `${P}-snd96-popup-own`, { full: false });
      });

      test(`wizard sessions ${lang}`, async ({ page }) => {
        await open(page, { lang });
        const R = `S.selEvent='jcc';${REG0}`;
        await draw(page, `${R}setCustTab('register')`);
        await page.waitForFunction(`!!document.querySelector('#tab-register .sess-card')`);
        await shot(page, `${P}-reg-sessions`);
        await draw(page, `S.selSession='2026-09-25';renderRegister()`);
        await shot(page, `${P}-reg-sessions-picked`);
        await draw(page, `_groupErr(document.getElementById('session-picker-wrap'),t('errSelectSession'))`);
        await shot(page, `${P}-reg-sessions-err`);
        await draw(page, `S.selEvent='community';${REG0}S.selSession='2026-09-26';S.sessions=S.sessions.map(s=>s.id==='2026-09-26'?{...s,status:'full'}:s);renderRegister()`);
        await shot(page, `${P}-reg-comm-full`);
        await draw(page, `S.selEvent='snd96';${REG0}renderRegister()`);
        await shot(page, `${P}-reg-sole`);
        await draw(page, `S.sessions=S.sessions.map(s=>s.id==='2026-10-02'?{...s,status:'full'}:s);renderRegister()`);
        await shot(page, `${P}-reg-sole-full`);
        await draw(page, `S.selEvent='jcc';${REG0}S._sessErr=null;S.sessions=S.sessions.filter(s=>s.ride_kind);renderRegister()`);
        await shot(page, `${P}-reg-none`);
        await draw(page, `S._sessErr='x';S.sessions=[];renderRegister()`);
        await shot(page, `${P}-reg-load-err`);
      });

      test(`wizard riders ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await draw(page, `S.selEvent='jcc';${REG0}S.selSession='2026-09-28';S.regStep=2;setCustTab('register')`);
        await page.waitForFunction(`!!document.querySelector('#tab-register .reg-stepper')`);
        await shot(page, `${P}-reg-riders1`);
        await draw(page, `S.regQty=3;ensureBikeSizes();S._qtyCapNote=true;S.regBikeTypes=['Road','Hybrid',''];S.regRiderNames=['Sara Ali','Omar Ali',''];S.regBikeHeights=['165','180',''];S.promoApplied={code:'SUMMER10',kind:'percent',value:10};renderRegister()`);
        await shot(page, `${P}-reg-riders3`);
        await draw(page, `_groupErr(document.getElementById('reg-type-wrap-2'),t('errSelectTypeGeneric'));_fieldErr(document.getElementById('reg-height-2'),t('errValidHeightCm'));_fieldErr(document.getElementById('reg-rider-name-2'),t('errEnterName'))`);
        await shot(page, `${P}-reg-riders-errs`);
        await draw(page, `S.promoApplied=null;S._promoMsg=t('promoInvalid')||'Invalid code';S.regQty=1;S.regBikeTypes=['Any'];renderRegister()`);
        await shot(page, `${P}-reg-riders-promo-bad`);
        // Modify: the rider's party on Friday (edits keep names of booked riders locked)
        await draw(page, `${REG0}S.selSession='2026-09-25';S.regStep=2;S._promoMsg='';renderRegister()`);
        await shot(page, `${P}-reg-modify`);
        await draw(page, `S.selEvent='community';${REG0}S.selSession='2026-09-26';S.regStep=2.5;renderRegister()`);
        await shot(page, `${P}-reg-waiver`);
        await draw(page, `toggleWaiver(true)`);
        await shot(page, `${P}-reg-waiver-ok`);
      });

      test(`wizard review ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await draw(page, `S.selEvent='jcc';${REG0}S.selSession='2026-09-28';S.regStep=3;S.regQty=2;ensureBikeSizes();S.regBikeTypes=['Road','Any'];S.regBikeHeights=['165',''];S.regRiderNames=['Sara Ali','Omar Ali'];setCustTab('register')`);
        await page.waitForFunction(`!!document.querySelector('#tab-register .form-section')`);
        await shot(page, `${P}-reg-review-one-cat`);
        await draw(page, `${REG0}S.selSession='2026-09-25';S.sessions=S.sessions.map(s=>s.id==='2026-09-25'?s:s);S.regStep=3;S.regQty=1;ensureBikeSizes();S.regBikeTypes=['Hybrid'];S.regAddons=[{id:'i1',qty:2},{id:'i3',qty:1}];S.promoApplied={code:'FLAT20',kind:'flat',value:20};_modEntries=function(){return[]};renderRegister()`);
        await shot(page, `${P}-reg-review-addons`);
        await draw(page, `S._alreadyBookedSession=S.selSession;renderRegister()`);
        await shot(page, `${P}-reg-review-already`);
        await draw(page, `S.selEvent='event';${REG0}S.selSession='2026-10-03';S.regStep=3;renderRegister()`);
        await shot(page, `${P}-reg-review-event`);
      });

      test(`wizard modify review ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await draw(page, `S.selEvent='jcc';${REG0}S.selSession='2026-09-25';S.regStep=3;setCustTab('register')`);
        await page.waitForFunction(`!!document.querySelector('#tab-register .form-section')`);
        await draw(page, `S._alreadyBookedSession=S.selSession;renderRegister()`);
        await shot(page, `${P}-reg-review-modify-already`);
      });

      test(`wizard tickets ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`_loadQrcode()`);
        const tk = (o: Row) => js({ id: 't' + Math.random().toString(36).slice(2, 6), queueNum: 7, name: 'Sara Ali', sessionId: '2026-09-28', sessionDay: 'Monday', sessionDate: '2026-09-28', status: 'waiting', ...o });
        await draw(page, `S.selEvent='jcc';${REG0}S.lastTickets=[${tk({ id: 'ta' })}];setCustTab('register')`);
        await qrReady(page);
        await shot(page, `${P}-reg-ticket`);
        await draw(page, `S.lastTickets=[${tk({ id: 'tb', queueNum: 8 })},${tk({ id: 'tc', queueNum: 9, name: 'Omar Ali', status: 'waitlist', waitlistNum: 3 })}];window._hasGWallet=function(){return true};renderRegister()`);
        await qrReady(page);
        await shot(page, `${P}-reg-tickets-two`);
        await draw(page, `S.lastTickets=[${tk({ id: 'td', sessionId: '2026-09-26', sessionDay: 'Saturday', sessionDate: '2026-09-26' })}];window._hasGWallet=function(){return false};window._hasWallet=function(){return true};window._walletOk=function(){return true};renderRegister()`);
        await qrReady(page);
        await shot(page, `${P}-reg-ticket-comm`);
        await draw(page, `S.lastTickets=[${tk({ id: 'te', sessionId: '2026-09-26', sessionDay: 'Saturday', sessionDate: '2026-09-26', status: 'waitlist' })}];renderRegister()`);
        await shot(page, `${P}-reg-ticket-comm-wl`);
        await draw(page, `S.lastTickets=[${tk({ id: 'tf', sessionId: '2026-10-02', sessionDay: 'Friday', sessionDate: '2026-10-02', status: 'waitlist', waitlistNum: 1 })}];S.selEvent='snd96';renderRegister()`);
        await qrReady(page);
        await shot(page, `${P}-reg-ticket-snd96`);
      });

      test(`tickets before the QR library ${lang}`, async ({ page }) => {
        // the library never arrives: the placeholder keeps its place (ticketQR's lazy span)
        await page.route(/\/vendor\/qrcode-generator/, (r) => r.abort());
        await open(page, { lang });
        await draw(page, `setCustTab('myrides')`);
        await page.waitForFunction(`!!document.querySelector('#tab-myrides .qr-lazy')`);
        await shot(page, `${P}-myrides-qr-lazy`);
        await draw(page, `S.selEvent='jcc';${REG0}S.lastTickets=[{id:'tz',queueNum:7,name:'Sara Ali',sessionId:'2026-09-28',sessionDay:'Monday',sessionDate:'2026-09-28',status:'waiting'}];setCustTab('register')`);
        await page.waitForFunction(`!!document.querySelector('#tab-register .qr-lazy')`);
        await shot(page, `${P}-reg-ticket-qr-lazy`);
      });

      test(`my bookings ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`_loadQrcode()`);
        await draw(page, `setCustTab('myrides')`);
        await page.waitForFunction(`!!document.querySelector('#tab-myrides .ticket-card')`);
        await qrReady(page);
        await shot(page, `${P}-myrides`);
        await draw(page, `window._hasWallet=function(){return true};renderMyRides()`);
        await qrReady(page);
        await shot(page, `${P}-myrides-wallet`);
        await draw(page, `window._hasWallet=function(){return false};window._hasGWallet=function(){return true};S.queue=S.queue.filter(e=>!['p1','p2','p3'].includes(e.id));renderMyRides()`);
        await qrReady(page);
        await shot(page, `${P}-myrides-nopast`);
      });

      test(`my bookings more ${lang}`, async ({ page }) => {
        // the Saturday ride before it is published, a first-in-line waiting rider, and no current rides
        await open(page, { lang, fx: {
          sessions: sessions.map((s) => (s.id === '2026-09-26' ? { ...s, hide_queue: true } : s)),
          queue_entries: [mine[0], mine[5], mine[6], ...mine.slice(9)],
        } });
        await page.evaluate(`_loadQrcode()`);
        await draw(page, `setCustTab('myrides')`);
        await page.waitForFunction(`!!document.querySelector('#tab-myrides .ticket-card')`);
        await qrReady(page);
        await shot(page, `${P}-myrides-review`);
        await draw(page, `S.queue=S.queue.filter(e=>e.customerId!=='c1'||['p1','p2','p3'].includes(e.id));renderMyRides()`);
        await shot(page, `${P}-myrides-nocurrent`);
        await draw(page, `S.queue=S.queue.filter(e=>e.customerId!=='c1');renderMyRides()`);
        await shot(page, `${P}-myrides-zero`);
      });

      test(`rate ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await draw(page, `setCustTab('myrides')`);
        await page.waitForFunction(`!!document.querySelector('#tab-myrides .ticket-card')`);
        await page.evaluate(`openRateModal('p1')`);
        await shot(page, `${P}-rate`, { full: false });
        await page.evaluate(`setRate('bike',7);setRate('exp',4);_rateTag('route');_rateTag('staff')`);
        await shot(page, `${P}-rate-picked`, { full: false });
        await page.locator('#rate-modal button[aria-label="9"]').first().hover();
        await shot(page, `${P}-rate-hover`, { full: false });
        await page.mouse.move(0, 0);
        await page.evaluate(`closeRateModal();openRateModal('p3',true)`);
        await shot(page, `${P}-rate-forced`, { full: false });
      });

      test(`account ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await draw(page, `setCustTab('account')`);
        await page.waitForFunction(`!!document.querySelector('#tab-account #acc-ride-news')&&!!document.querySelector('#tab-account #acc-delete')`);
        await page.evaluate(`document.getElementById('badge-pop')&&document.getElementById('badge-pop').remove()`);
        await shot(page, `${P}-account`);
        await draw(page, `S.loggedIn={...S.loggedIn,photo:'/icon-192.png',ride_news:false,deletion_requested_at:'2026-09-20T10:00:00Z'};window.pushSupported=function(){return true};S.cashSales=[{id:'x1',customer_id:'c1',name:'Water',qty:2,price:5,pay:'cash',created_at:'2026-09-22T19:00:00Z'},{id:'x2',customer_id:'c1',name:'A very long product name that has to be cut off at the end',qty:1,price:120,pay:'card',created_at:'2026-09-17T19:00:00Z'}];renderAccount()`);
        await shot(page, `${P}-account-full`);
        await draw(page, `window.pushPermission=function(){return 'denied'};S.cashSales=[];renderAccount()`);
        await shot(page, `${P}-account-push-blocked`);
        await page.evaluate(`_mrBadgeInfo(0,true)`);
        await shot(page, `${P}-badge-given`, { full: false });
        await page.evaluate(`document.getElementById('badge-pop').remove();_mrBadgeInfo(_mrBadgeList(S.loggedIn).length-1,false)`);
        await shot(page, `${P}-badge-locked`, { full: false });
        await page.evaluate(`document.getElementById('badge-pop').remove()`);
      });

      test(`account new rider ${lang}`, async ({ page }) => {
        // no rides, no socials, no next ride: the "book your next" card and a short profile
        await open(page, { lang, fx: { queue_entries: others, 'rpc:customer_my_badges': [], 'rpc:customer_profile': [{ id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567', session_token: 'tok-spec' }] } });
        await draw(page, `setCustTab('account')`);
        await page.waitForFunction(`!!document.querySelector('#tab-account #acc-ride-news')`);
        await shot(page, `${P}-account-new`);
      });

      test(`staff customer form ${lang}`, async ({ page }) => {
        // no stock: the Inventory item's count badge in the staff rail arrives on its own timer
        await open(page, { lang, staff: true, fx: { customers: [{ ...CUST, nationality: 'SA' }], inventory: [] } });
        await loadStaffHalf(page);
        await page.waitForFunction(`S.view==='staff'`);
        await page.evaluate(`showEditCustomerModal('c1')`);
        await page.waitForFunction(`!!document.getElementById('cf-soc-instagram')`);
        await page.evaluate(`_fieldErr(document.getElementById('cf-soc-strava'),t('errFieldRequired'))`);
        // the dialog alone: the Bookings page behind it keeps its own clock
        await shot(page, `${P}-staff-custform`, { el: page.locator('#new-acct-modal .modal-box') });
      });
    }
  });
}

