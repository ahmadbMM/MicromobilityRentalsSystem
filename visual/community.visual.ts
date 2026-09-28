import { test, expect, type Page, type Locator } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, loginCustomer } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

declare const _langLoaded: (l: string) => boolean; // app global
// The app's let/const globals, which are not window properties (the strict-policy check reads them in function form).
declare const S: Record<string, unknown> & { dataLoaded?: boolean; customers?: unknown[] };
declare const sb: unknown;

// Community without inline styles (playwright.visual.config.ts says how to run it): the staff
// Community section - the leaderboard and the statistics, Accounts with its tag manager, tag
// picker, filters and tag editor, Flagged, Birthdays, Applications (community and learning to
// ride) with their message and scheduling dialogs, Duplicates and the merge dialog - the account
// editor and its dialogs (ride news, delete, flag fields, tag grant), a tag chip in the account
// history, the add-to-a-community-ride dialog, the JCC group and group edit dialogs, and on the
// customer's side the members-only and turned-down dialogs and a community ride's breakfast spot on
// My Bookings. Every state is a screenshot and a hash of the computed style of every element on the
// page (cascade-audit.ts), in English and Arabic, at 1280x900 and 390x844, from fixed data on a
// frozen clock. The switches are pass3's: AUDIT=inline, AUDIT=class with AUDIT_CLASSES, MIN_CSS=1,
// CSS_DUMP; STRICT=1 runs only the strict-policy check at the end.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
const DAY = 864e5;
const SNAPS = process.env.VISUAL_SNAPS || join(tmpdir(), 'mm-visual-snaps');
const CLASSES = process.env.AUDIT_CLASSES ? readFileSync(process.env.AUDIT_CLASSES, 'utf8').split(/\s+/).filter(Boolean) : [];

type Row = Record<string, unknown>;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOf = (d: string) => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
const js = (o: unknown) => JSON.stringify(o);
const sess = (d: string, o: Row = {}) => ({ id: d, day: dayOf(d), session_date: d, capacity: 12, status: 'closed', location: 'JCC', bike_slots: js({ _time: '21:00 - 23:00', _total: 12 }), created_at: 1, ...o });
const COMM = { event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false };

// ── Sessions: the past nights the leaderboard counts, and the rides to come ──
const PAST = ['2026-08-06', '2026-08-13', '2026-08-20', '2026-08-27', '2026-09-03', '2026-09-10', '2026-09-17', '2026-09-22'];
const sessions = [
  ...PAST.map((d) => sess(d)),
  sess(TODAY, { status: 'open', capacity: 12 }),
  sess('2026-09-26', { ...COMM, status: 'full', spots: 3, capacity: 3, title: 'Saturday Social Ride', bike_slots: js({ _time: '06:30 - 07:00' }), breakfast_name: 'Cafe Sea', breakfast_url: 'https://maps.example.test/cafe' }),
  sess('2026-09-27', { status: 'open' }),
  sess('2026-10-01', { status: 'open', capacity: 20 }),
  sess('2026-10-03', { ...COMM, status: 'open', spots: 25, capacity: 25, title: 'Dawn Ride', bike_slots: js({ _time: '06:00 - 06:30' }) }),
  sess('2026-10-08', { status: 'open' }),
  sess('2026-10-10', { status: 'open' }),
];

// ── Riders ──
const C = (id: string, name: string, o: Row = {}) => ({ id, name, email: name.toLowerCase().replace(/\s+/g, '.') + '@example.test', phone: '', gender: 'male', created_at: '2026-01-05T10:00:00Z', ...o });
const customers = [
  C('c1', 'Amal Top', { phone: '+966551230001', gender: 'female', birth_date: '1990-09-24', heard_from: 'instagram', ride_news: true, ride_news_at: '2026-09-01T09:00:00Z', default_pay: 'house', height: 165, country: 'SA', nationality: 'SA', type_preference: 'Road' }),
  C('c2', 'Badr Next', { phone: '+966551230002', gender: null, birth_date: '1988-01-01', deletion_requested_at: '2026-09-20T09:00:00Z', fix_fields: ['name', 'email'] }),
  C('c3', 'Cara Vale', { phone: '+966551230003', gender: 'female', birth_date: '1985-09-20', height: 170 }),
  C('c4', 'Dana Reyes', { phone: '+966551230004', gender: 'female' }),
  C('c5', 'Eman Saleh', { phone: '+966551230005', gender: 'female', birth_date: '2000-09-27' }),
  C('c6', 'Faisal Noor', { phone: '+966551230006', birth_date: '1976-10-15' }),
  C('c7', 'Ghada Omar', { phone: '', gender: 'female', birth_date: '1996-02-29' }),
  C('c8', 'Hamad Ali', { phone: '+966551230008', birth_date: '2010-12-01' }),
  C('c10', 'Amal Top', { phone: '0551230001', email: 'amal.second@example.test', created_at: '2026-06-01T10:00:00Z' }), // the same phone as c1
  C('c11', 'Jana Kareem', { phone: '+966551230011', birth_date: '1992-04-04' }),
  C('c12', 'Jana Kareem', { phone: '+966551230012', birth_date: '1992-04-04', email: '' }), // the same name and birth date
];
const tags = [
  { id: 'tag_jcc', name: 'Jeddah Corniche Circuit', slug: 'jcc', color: '#00e585', locked: true, auto_grant: true },
  { id: 'tag_saturday', name: 'Community', slug: 'saturday', color: '#4aa8f8', locked: true, auto_grant: false },
  { id: 'tag_blacklist', name: 'Blacklist', slug: 'blacklist', color: '#0b0b0b', locked: true, auto_grant: false },
  { id: 'tag_vip', name: 'VIP riders', slug: 'vip', color: '#e5a100', description: 'Friends of the club' },
  { id: 'tag_kids', name: 'Kids club', slug: 'kids', color: '#8e44ad' },
];
const ct = (cid: string, tid: string, o: Row = {}) => ({ customer_id: cid, tag_id: tid, added_by: 'staff', added_at: 1, ...o });
const customer_tags = [
  ct('c1', 'tag_saturday'), ct('c1', 'tag_jcc'), ct('c1', 'tag_vip', { starts_at: NOW - 5 * DAY, expires_at: NOW + 20 * DAY }),
  ct('c2', 'tag_blacklist'), ct('c2', 'tag_kids', { starts_at: NOW - 40 * DAY, expires_at: NOW - 10 * DAY }),
  ct('c3', 'tag_saturday'), ct('c3', 'tag_vip', { starts_at: NOW + 3 * DAY, expires_at: NOW + 30 * DAY }),
  ct('c4', 'tag_saturday'), ct('c5', 'tag_saturday'), ct('c6', 'tag_saturday'), ct('c7', 'tag_saturday'), ct('c8', 'tag_saturday'),
];

// ── Bookings: done and paid rides for the leaderboard; tonight's groups; a rider's upcoming ride ──
let qn = 0;
const q = (id: string, d: string, o: Row) => ({
  id, session_id: d, session_day: dayOf(d), session_date: d, queue_num: ++qn, status: 'done', paid: true, price: 80,
  type_preference: 'Hybrid', size: 'M', height: 172, registered_at: d + 'T10:00:00Z', ride_duration: 60, ...o,
});
const rides = (cid: string, name: string, aug: number, sep: number) => [
  ...Array.from({ length: aug }, (_, i) => q(`${cid}-a${i}`, PAST[i % 4], { customer_id: cid, name, ride_duration: 50 + i })),
  ...Array.from({ length: sep }, (_, i) => q(`${cid}-s${i}`, PAST[4 + (3 - (i % 4))], { customer_id: cid, name, ride_duration: 70 + i })),
];
const queue_entries = [
  ...rides('c1', 'Amal Top', 6, 6), ...rides('c2', 'Badr Next', 5, 4), ...rides('c3', 'Cara Vale', 1, 7),
  ...rides('c4', 'Dana Reyes', 4, 0), ...rides('c5', 'Eman Saleh', 0, 2), ...rides('c6', 'Faisal Noor', 2, 2),
  ...rides('c7', 'Ghada Omar', 3, 1), ...rides('c8', 'Hamad Ali', 0, 1),
  q('w1', '2026-09-22', { name: 'Walk In Guest', walk_in: true }),
  // tonight: a party of three waiting, a party of two with one rider on a bike
  q('g1a', TODAY, { status: 'waiting', paid: false, name: 'Tamer Group 1', group_id: 'g1', group_name: 'Tamer Group', group_contact: 'Tamer', group_phone: '0551112222', phone: '0551112222' }),
  q('g1b', TODAY, { status: 'waiting', paid: false, name: 'Tamer Group 2', group_id: 'g1', group_name: 'Tamer Group', phone: '0551113333', type_preference: 'Road' }),
  q('g1c', TODAY, { status: 'waiting', paid: false, name: 'Tamer Group 3', group_id: 'g1', group_name: 'Tamer Group', height: null }),
  q('g2a', TODAY, { status: 'active', paid: true, name: 'Lina Group 1', group_id: 'g2', group_name: 'Lina Group' }),
  q('g2b', TODAY, { status: 'waiting', paid: false, name: 'Lina Group 2', group_id: 'g2', group_name: 'Lina Group' }),
  // the Saturday ride (full): a community party, and Eman three days from her birthday
  q('g3a', '2026-09-26', { status: 'waiting', paid: false, price: 0, approval: 'approved', name: 'Cara Vale', customer_id: 'c3', group_id: 'g3' }),
  q('g3b', '2026-09-26', { status: 'waiting', paid: false, price: 0, approval: 'approved', name: 'Cara Friend', customer_id: 'c3', group_id: 'g3' }),
  q('e5', '2026-09-26', { status: 'waiting', paid: false, price: 0, approval: 'approved', name: 'Eman Saleh', customer_id: 'c5' }),
];

// ── Flagged, applications, learning to ride, merges ──
const PHOTO = 'https://img.example.test/p1.png';
const customer_flags = [
  { id: 'f1', customer_id: 'c2', fields: ['name', 'email'], status: 'pending', flagged_by: 'Desk A', flagged_at: '2026-09-20T10:00:00Z', answered_at: null, changes: {} },
  { id: 'f2', customer_id: 'c1', fields: ['name', 'height', 'photo'], status: 'answered', flagged_by: 'Desk B', flagged_at: '2026-09-18T10:00:00Z', answered_at: '2026-09-19T09:00:00Z',
    changes: { name: { before: 'Amal T', after: 'Amal Top' }, height: { before: null, after: 165 }, photo: { before: PHOTO, after: 'data:,x' } } },
  { id: 'f3', customer_id: 'c3', fields: ['email'], status: 'withdrawn', flagged_by: null, flagged_at: '2026-09-16T10:00:00Z', answered_at: '2026-09-17T10:00:00Z', changes: {} },
];
const appBase = {
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12',
  gender: 'male', nationality: 'EG', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
  customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect',
};
const community_applications = [
  { ...appBase, id: 'a1', status: 'pending', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', instagram: 'karim.rides', linkedin: 'karim-mansour' },
  { ...appBase, id: 'a2', status: 'pending', name: 'Amal Top', email: 'amal.top@example.test', phone: '+966551230001', gender: 'female', lang: 'ar', submissions: 2, heard_from: 'friend', created_at: '2026-09-21T08:00:00Z' },
  { ...appBase, id: 'a3', status: 'approved', name: 'Cara Vale', email: 'cara.vale@example.test', phone: '+966551230003', existing_account: true, customer_id: 'c3', decided_at: '2026-09-22T09:00:00Z', decided_by: 'Desk A' },
  { ...appBase, id: 'a4', status: 'approved', name: 'Nour Fahad', email: 'nour.fahad@gmail.com', phone: '+966554445566', existing_account: false, customer_id: 'c8', decided_at: '2026-09-22T10:00:00Z' },
  { ...appBase, id: 'a5', status: 'rejected', name: 'Old Applicant', email: 'old.applicant@gmail.com', phone: '+966553579024', bike_type: 'Mountain', decided_at: '2026-09-20T08:00:00Z', decided_by: 'Desk B' },
];
const laBase = {
  created_at: '2026-09-23T08:00:00Z', updated_at: '2026-09-23T08:00:00Z', submissions: 1, for_whom: 'self', learner_name: null,
  learner_gender: 'female', learner_height: 162, level: 'never', notes: '', lang: 'en',
  lesson_at: null, lesson_place: null, decided_at: null, decided_by: null, customer_id: null, existing_account: null, account_oauth: null,
};
const learn_applications = [
  { ...laBase, id: 'l1', status: 'pending', name: 'Nadia Omar', email: 'nadia.omar@gmail.com', phone: '+966552220001', learner_age: 34, notes: 'A bit nervous around traffic' },
  { ...laBase, id: 'l2', status: 'pending', for_whom: 'child', name: 'Amal Top', email: 'amal.top@example.test', phone: '+966551230001', learner_name: 'Sara', learner_age: 7, learner_height: 120, level: 'tried', lang: 'ar', submissions: 2 },
  { ...laBase, id: 'l3', status: 'scheduled', name: 'Omar Farouk', email: 'omar.farouk@gmail.com', phone: '+966553330002', learner_age: 41, learner_gender: 'male', learner_height: 180, level: 'refresh',
    lesson_at: '2026-10-04T15:00:00Z', lesson_place: 'JCC', decided_at: '2026-09-23T09:00:00Z', decided_by: 'Desk A', customer_id: 'c6', existing_account: false, account_oauth: false },
  { ...laBase, id: 'l4', status: 'done', name: 'Rana Done', email: 'rana.done@gmail.com', phone: '+966554440009', learner_age: 22, lesson_at: '2026-09-20T15:00:00Z', lesson_place: 'Corniche', decided_at: '2026-09-21T09:00:00Z', customer_id: 'c4', existing_account: true },
  { ...laBase, id: 'l5', status: 'cancelled', name: 'Old Learner', email: 'old.learner@gmail.com', phone: '+966554440003', learner_age: 29, decided_at: '2026-09-22T09:00:00Z', decided_by: 'Desk B' },
];
const customer_merges = [
  { id: 7, keep_id: 'c4', drop_id: 'c99', keep_name: 'Dana Reyes', drop_name: 'Dana R', merged_at: '2026-09-21T11:00:00Z', merged_by: 'Malik' },
  { id: 6, keep_id: 'c6', drop_id: 'c98', keep_name: 'Faisal Noor', drop_name: 'F Noor', merged_at: '2026-09-15T11:00:00Z', merged_by: null },
];
const FIX = { sessions, customers, tags, customer_tags, queue_entries, customer_flags, community_applications, learn_applications, customer_merges, bikes: [], staff_options: [] };

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function settle(page: Page) {
  await page.evaluate(async () => {
    // A search field's clear button is mounted 60 ms after the page stops changing (_mountSearchClears);
    // mount it now, so a shot never races it.
    const w = window as unknown as { _mountSearchClears?: () => void };
    if (typeof w._mountSearchClears === 'function') w._mountSearchClears();
    void document.body.offsetHeight;
    await document.fonts.ready;
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
  // a rider's photo (Flagged shows the one they replaced): the site's icon, so every run draws it the same
  const icon = readFileSync(join(__dirname, '..', 'icon-192.png'));
  await page.route(/img\.example\.test/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: icon }));
  if (o.customer) await loginCustomer(page, { id: 'c1', name: 'Amal Top', email: 'amal.top@example.test', phone: '+966551230001' });
  else await unlockStaff(page);
  await page.addInitScript((lang) => {
    localStorage.setItem('cq_lang', lang);
    localStorage.setItem('cq_lang_pick', '1');
  }, o.lang);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, o.lang);
  if (!o.customer) {
    await page.waitForFunction(`S.view==='staff'&&(S.customers||[]).length>=${((o.fx || FIX) as { customers?: unknown[] }).customers?.length ?? customers.length}`);
    await page.evaluate(`window._tickRefreshLabel=function(){};window._sb=function(){return 'auto'}`);
  }
  await page.waitForFunction(`getComputedStyle(document.getElementById('loading-screen')).display==='none'`);
}
async function quiet(page: Page) {
  await page.evaluate(() => new Promise<void>((res) => {
    let t = 0;
    const done = () => { obs.disconnect(); res(); };
    const obs = new MutationObserver(() => { clearTimeout(t); t = window.setTimeout(done, 250); });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    t = window.setTimeout(done, 250);
    window.setTimeout(done, 8000); // a loaded machine keeps a page busy for longer
  }));
}

const audits: Record<string, AuditRow[]> = {};
async function shot(page: Page, name: string, o: { full?: boolean; el?: Locator; roots?: string[] } = {}) {
  await quiet(page);
  await settle(page);
  if (o.el) await expect.soft(o.el).toHaveScreenshot(name + '.png', { timeout: 30000 });
  else await expect.soft(page).toHaveScreenshot(name + '.png', { fullPage: o.full !== false, timeout: 30000 });
  await quiet(page);
  await page.evaluate(() => { const w = window as unknown as { _mountSearchClears?: () => void }; if (typeof w._mountSearchClears === 'function') w._mountSearchClears(); });
  // data-cssv's own properties (this pass's --cmy-*) are left out; what they decide is hashed where it lands
  const hashes = await page.evaluate(styleHashes, { roots: ['body'], ignore: '^--cmy-', stripOrigin: true });
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
// Each evaluate draws a state; the page goes back to the top so a full-page shot starts there.
const draw = (page: Page, code: string) => page.evaluate(code + ';window.scrollTo(0,0)');
const comm = async (page: Page, sub: string, ready: string) => {
  await draw(page, `setStaffTab('community');setCommTab('${sub}')`);
  await page.waitForFunction(ready);
};
// A dialog, drawn over the page: what the viewport shows.
const dlg = (page: Page, name: string) => shot(page, name, { full: false });

const STRICT = !!process.env.STRICT;
test.describe.configure({ timeout: 900000 }); // a loaded machine runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:community ${vpName}`, () => {
    test.skip(STRICT);
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`board ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await comm(page, 'leaderboard', `!!document.querySelector('#tab-community #lb-search')`);
        await shot(page, `${P}-lb-all`);
        await draw(page, `setLb('lbWindow','month')`);
        await shot(page, `${P}-lb-month`);
        await draw(page, `S.lbMetric='duration';setLb('lbWindow','week')`);
        await shot(page, `${P}-lb-week-duration`);
        await draw(page, `S.lbMetric='count';S.lbWindow='all';S.lbScope='rider';S.lbSearch='a';renderCommunity()`);
        await shot(page, `${P}-lb-search`);
        await draw(page, `S.lbSearch='zzzz';renderCommunity()`);
        await shot(page, `${P}-lb-search-none`);
        await draw(page, `S.lbSearch='';S.lbScope='owner';setCommTab('stats')`);
        await shot(page, `${P}-stats`);
      });

      test(`board top tier and empty ${lang}`, async ({ page }) => {
        // one rider past the last tier: the spotlight has no progress bar
        const many = Array.from({ length: 52 }, (_, i) => q('m' + i, PAST[i % 8], { customer_id: 'c1', name: 'Amal Top' }));
        await open(page, { lang, fx: { queue_entries: many } });
        await comm(page, 'leaderboard', `!!document.querySelector('#tab-community .form-title')`);
        await shot(page, `${P}-lb-maxtier`);
        await draw(page, `S.queue=[];S.lbWindow='week';renderCommunity()`);
        await shot(page, `${P}-lb-empty`);
      });

      test(`stats empty ${lang}`, async ({ page }) => {
        await open(page, { lang, fx: { queue_entries: [], sessions: sessions.filter((s) => s.id < TODAY) } });
        await comm(page, 'stats', `!!document.querySelector('#tab-community .analytics-kpi-grid')`);
        await shot(page, `${P}-stats-empty`);
      });

      test(`accounts ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await comm(page, 'accounts', `!!document.querySelector('#tab-community #am-cust-rows .am-row')`);
        await shot(page, `${P}-am-list`);
        await draw(page, `S.tagCustId='c1';renderCommunity()`);
        await shot(page, `${P}-am-picker`);
        await draw(page, `S.tagCustId=null;S._fOpen={am:true};S.amMissing=true;S.amSuspect=true;renderCommunity()`);
        await shot(page, `${P}-am-filters`);
        await draw(page, `S._fOpen={};S.amMissing=false;S.amSuspect=false;S.amDelReq=true;S.amFixing=true;renderCommunity()`);
        await shot(page, `${P}-am-delreq`);
        await draw(page, `S.amDelReq=false;S.amFixing=false;S.amTagFilter='tag_vip';openTagEdit('')`);
        await shot(page, `${P}-am-tag-new`);
        await draw(page, `S.amTagFilter='';openTagEdit('tag_vip')`);
        await shot(page, `${P}-am-tag-edit`);
        await draw(page, `S.tagEdit=null;S.amSearch='zzzz';renderCommunity()`);
        await shot(page, `${P}-am-nomatch`);
        await draw(page, `S.amSearch='';renderCommunity()`);
        await page.evaluate(`openAccountHistory('c1')`);
        await page.waitForFunction(`!!document.querySelector('#cust-modal .am-chips')`);
        await dlg(page, `${P}-am-history-chips`);
      });

      test(`accounts without tags ${lang}`, async ({ page }) => {
        await open(page, { lang, fx: { tags: [], customer_tags: [], customers: [] } });
        await comm(page, 'accounts', `!!document.querySelector('#tab-community #am-cust-rows .empty-state')`);
        await shot(page, `${P}-am-empty`);
      });

      test(`show more ${lang}`, async ({ page }) => {
        // past a page of accounts (60) and of birthdays (300)
        const lots = Array.from({ length: 305 }, (_, i) => C('x' + i, 'Rider ' + String(i).padStart(3, '0'), { phone: '+9665520' + String(10000 + i), birth_date: `19${70 + (i % 30)}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` }));
        await open(page, { lang, fx: { customers: lots, customer_tags: lots.map((c) => ct(c.id, 'tag_saturday')), queue_entries: [] } });
        await comm(page, 'accounts', `document.querySelectorAll('#tab-community #am-cust-rows .am-row').length===60`);
        const more = page.locator('#am-cust-rows > div:last-child');
        await more.scrollIntoViewIfNeeded();
        await shot(page, `${P}-am-more`, { el: more });
        await comm(page, 'birthdays', `!!document.querySelector('#tab-community #bd-list .bd-table')`);
        const bdMore = page.locator('#bd-list > div:last-child');
        await bdMore.scrollIntoViewIfNeeded();
        await shot(page, `${P}-bd-more`, { el: bdMore });
      });

      test(`flagged ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await comm(page, 'flagged', `document.querySelectorAll('#tab-community .flg-row').length===3`);
        await shot(page, `${P}-flg-all`);
        await draw(page, `S._flagFilter='withdrawn';S._flags=S._flags.filter(r=>r.status!=='withdrawn');renderCommunity()`);
        await shot(page, `${P}-flg-empty`);
        await draw(page, `S._flagFilter='all';S._flags=null;S._flagsErr=true;S._flagsBusy=false;renderCommunity()`);
        await shot(page, `${P}-flg-err`);
      });

      test(`birthdays ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await comm(page, 'birthdays', `!!document.querySelector('#tab-community .bd-hero')&&!!document.querySelector('#bd-list .bd-table')`);
        await shot(page, `${P}-bd-main`);
        await draw(page, `S._fOpen={bd:true};_bdSetMonth(9)`);
        await shot(page, `${P}-bd-month-filters`);
        await draw(page, `S._fOpen={};S._bdMonth=0;S._bdQ='zzzz';renderCommunity()`);
        await shot(page, `${P}-bd-nomatch`);
      });

      test(`applications ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await comm(page, 'applications', `document.querySelectorAll('#tab-community .ca-row').length===2`);
        await shot(page, `${P}-ca-pending`);
        await draw(page, `S._caFilter='approved';renderCommunity()`);
        await shot(page, `${P}-ca-approved`);
        await draw(page, `S._caFilter='rejected';renderCommunity()`);
        await shot(page, `${P}-ca-rejected`);
        await draw(page, `S._caApps.push({...S._caApps[4],id:'a6',status:'odd',name:'Odd Status'});S._caFilter='odd';renderCommunity()`);
        await shot(page, `${P}-ca-odd`);
        await page.evaluate(`_caMsgShow(_caFind('a4'),'new',{name:'Nour Fahad',password:'Bike42xy'})`);
        await dlg(page, `${P}-ca-msg`);
        await page.evaluate(`_caMsgClose()`);
        await draw(page, `S._caApps=null;S._caErr=true;S._caBusy=false;S._caFilter='pending';renderCommunity()`);
        await shot(page, `${P}-ca-err`);
      });

      test(`learning to ride ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await comm(page, 'learning', `document.querySelectorAll('#tab-community .la-row').length===2`);
        await shot(page, `${P}-la-pending`);
        for (const st of ['scheduled', 'done', 'cancelled']) {
          await draw(page, `S._laFilter='${st}';renderCommunity()`);
          await shot(page, `${P}-la-${st}`);
        }
        await page.evaluate(`_laSchedule('l1')`);
        await dlg(page, `${P}-la-sched`);
        await page.evaluate(`closeConfirm();_laSchedule('l3')`);
        await dlg(page, `${P}-la-resched`);
        await page.evaluate(`closeConfirm();_laMsgShow(_laFind('l3'),'made',{password:'Ride77ab'})`);
        await dlg(page, `${P}-la-msg`);
        await page.evaluate(`_laMsgClose()`);
        await draw(page, `S._laApps=null;S._laErr=true;S._laBusy=false;S._laFilter='pending';renderCommunity()`);
        await shot(page, `${P}-la-err`);
      });

      test(`duplicates ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await comm(page, 'duplicates', `!!document.querySelector('#tab-community .mg-group')&&!!document.querySelector('#tab-community .mg-recent')`);
        await shot(page, `${P}-mg-main`);
        await draw(page, `S._mgQa='Ha';S._mgB='c6';renderCommunity()`);
        await shot(page, `${P}-mg-pick`);
        await page.evaluate(`_mgOpen('c1','c10')`);
        await dlg(page, `${P}-mg-dialog`);
        await page.evaluate(`closeConfirm()`);
        await draw(page, `S._mgQa='';S._mgB=null;S._mgRows=[];S.customers=S.customers.filter(c=>!['c10','c12'].includes(c.id));renderCommunity()`);
        await shot(page, `${P}-mg-none`);
      });

      test(`account editor ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await comm(page, 'accounts', `!!document.querySelector('#tab-community #am-cust-rows .am-row')`);
        const bottom = `document.querySelector('#new-acct-modal .modal-box').scrollTop=1e6`;
        await page.evaluate(`showNewAcctModal()`);
        await dlg(page, `${P}-cf-create`);
        await page.evaluate(bottom);
        await dlg(page, `${P}-cf-create-end`);
        await page.evaluate(`showEditCustomerModal('c1')`); // ride news given, on the house, tags
        await dlg(page, `${P}-cf-edit`);
        await page.evaluate(bottom);
        await dlg(page, `${P}-cf-edit-end`);
        await page.evaluate(`showEditCustomerModal('c2')`); // no gender, flagged, a lapsed tag, no ride news
        await dlg(page, `${P}-cf-edit2`);
        await page.evaluate(bottom);
        await dlg(page, `${P}-cf-edit2-end`);
        await page.evaluate(`showEditCustomerModal('c4')`); // no tags
        await page.evaluate(bottom);
        await dlg(page, `${P}-cf-edit3-end`);
        await page.evaluate(`const s=document.getElementById('cf-defpay');s.value='house';s.dispatchEvent(new Event('change',{bubbles:true}))`);
        await page.evaluate(bottom);
        await dlg(page, `${P}-cf-edit3-house`);
        await page.evaluate(`deleteCustomerAccount('c4')`);
        await dlg(page, `${P}-cf-delete`);
        await page.evaluate(`closeConfirm();closeCustFormModal()`);
      });

      test(`flag and tag dialogs ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await comm(page, 'accounts', `!!document.querySelector('#tab-community #am-cust-rows .am-row')`);
        await page.evaluate(`showFlagFieldsModal('c2')`); // had a request: Clear shows
        await dlg(page, `${P}-fl-had`);
        await page.evaluate(`_flagClose();showFlagFieldsModal('c4')`);
        await dlg(page, `${P}-fl-new`);
        await page.evaluate(`_flagClose();showTagGrantModal('c4','tag_vip')`);
        await dlg(page, `${P}-tg-perm`);
        await page.evaluate(`_tgSet('kind','temp')`);
        await dlg(page, `${P}-tg-temp-dur`);
        await page.evaluate(`_tgSet('mode','dates')`);
        await dlg(page, `${P}-tg-temp-dates-today`);
        await page.evaluate(`S._tg.end='2026-10-30';_tgSet('today',false)`);
        await dlg(page, `${P}-tg-temp-dates`);
        await page.evaluate(`closeConfirm();showTagGrantModal('c1','tag_blacklist')`);
        await dlg(page, `${P}-tg-blacklist`);
        await page.evaluate(`closeConfirm();showTagGrantModal('c2','tag_saturday')`);
        await dlg(page, `${P}-tg-banned`);
        await page.evaluate(`S._tg=null;closeConfirm()`);
      });

      test(`add to a ride ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`S.sfSession='2026-09-26';showCommAddModal(false)`); // an approval ride, full: Waiting, own bikes
        await page.waitForFunction(`!!document.querySelector('#comm-add-modal #ca-rows')`);
        await dlg(page, `${P}-ca-add`);
        await page.evaluate(`_on_caPick('c1');_on_caDest('waiting');_on_caOwn(true);renderCommAddModal()`);
        await dlg(page, `${P}-ca-add-picked`);
        await page.evaluate(`_on_caGroup(true);_caToggleSel('c1');_caToggleSel('c3')`);
        await dlg(page, `${P}-ca-add-group`);
        await page.evaluate(`S._caSearch='zzzz';document.getElementById('ca-search').value='zzzz';renderCommAddModal()`);
        await dlg(page, `${P}-ca-add-nomatch`);
        await page.evaluate(`closeCommAddModal();S.sfSession='${TODAY}';showCommAddModal(false)`); // a circuit night: no Waiting, no own bikes
        await page.waitForFunction(`!!document.querySelector('#comm-add-modal #ca-rows')`);
        await dlg(page, `${P}-ca-add-jcc`);
        await page.evaluate(`closeCommAddModal()`);
      });

      test(`group dialogs ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await page.evaluate(`S.sfSession='${TODAY}';showJccGroupModal()`);
        await page.waitForFunction(`!!document.querySelector('#jcc-group-modal #jg-name')`);
        await dlg(page, `${P}-jg-two`);
        await page.evaluate(`_jgAddRider()`);
        await page.evaluate(`document.querySelector('#jcc-group-modal .modal-box').scrollTop=1e6`);
        await dlg(page, `${P}-jg-three`);
        await page.evaluate(`closeJccGroupModal();S._jgRiders=[{name:'Solo',height:'170',type:'Road'}];showJccGroupModal()`);
        await dlg(page, `${P}-jg-one`);
        await page.evaluate(`closeJccGroupModal();showGroupEditModal('g1a')`);
        await dlg(page, `${P}-ge-move`);
        await page.evaluate(`closeGroupEditModal();showGroupEditModal('g2b')`);
        await dlg(page, `${P}-ge-onbike`);
        await page.evaluate(`closeGroupEditModal();showGroupEditModal('g3a')`);
        await dlg(page, `${P}-ge-comm`);
        await page.evaluate(`closeGroupEditModal()`);
      });

      test(`customer ${lang}`, async ({ page }) => {
        const mine = [
          q('k1', '2026-09-26', { status: 'waiting', paid: false, price: 0, approval: 'approved', name: 'Amal Top', customer_id: 'c1' }),
          q('k2', '2026-10-03', { status: 'waiting', paid: false, price: 0, approval: 'pending', name: 'Amal Top', customer_id: 'c1' }),
          q('k3', '2026-10-10', { status: 'waiting', paid: false, price: 0, approval: 'approved', name: 'Amal Top', customer_id: 'c1' }),
        ];
        const cs = [
          ...sessions.filter((s) => !['2026-10-03', '2026-10-10'].includes(s.id)),
          sess('2026-10-03', { ...COMM, status: 'open', spots: 25, capacity: 25, title: 'Dawn Ride', bike_slots: js({ _time: '06:00 - 06:30' }), breakfast_name: 'Bakery Corner' }), // a name, no link
          sess('2026-10-10', { ...COMM, status: 'open', spots: 25, capacity: 25, title: 'Harbour Ride', bike_slots: js({ _time: '06:00 - 06:30' }), breakfast_url: 'https://maps.example.test/harbour' }), // a link, no name
        ];
        await open(page, { lang, customer: true, fx: { sessions: cs, queue_entries: mine, 'rpc:community_member': true } });
        await page.evaluate(`showView('customer');setCustTab('myrides')`);
        await page.waitForFunction(`document.querySelectorAll('#tab-myrides .ticket-card').length===3`);
        await shot(page, `${P}-cust-tickets`);
        await page.evaluate(`showCommMembersModal()`);
        await dlg(page, `${P}-cust-members`);
        await page.evaluate(`closeConfirm();showRejectedModal(allSessions().find(s=>s.id==='2026-10-03'))`);
        await dlg(page, `${P}-cust-rejected`);
        await page.evaluate(`closeConfirm();showRejectedModal(null)`);
        await dlg(page, `${P}-cust-rejected-nosess`);
        await page.evaluate(`closeConfirm()`);
      });
    }
  });
}

// ── The strict policy: style-src without 'unsafe-inline', as the page will be served once every
// area has moved. Nothing this pass draws may trip it (other areas may, until they move). ──
test.describe('@visual:community strict policy', () => {
  test.skip(!STRICT);
  test.use({ bypassCSP: false, ...VIEWPORTS.desktop });
  type V = { d: string; el: string; sample: string; style: string };
  type W = Window & { __cspv: V[] } & Record<string, (...a: unknown[]) => unknown>;
  const run = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as unknown as W)[f as string](...(a as unknown[])), [fn, args] as const);
  const setS = (page: Page, o: Record<string, unknown>) => page.evaluate((x) => { Object.assign(S, x); }, o);
  async function strictOpen(page: Page, customer: boolean, fx: Record<string, unknown> = {}) {
    await page.clock.setFixedTime(NOW);
    await page.addInitScript(() => {
      (window as unknown as W).__cspv = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        const t = e.target as Element | null;
        const path: string[] = [];
        for (let n: Element | null = t && t.nodeType === 1 ? t : null; n; n = n.parentElement) path.unshift(n.id ? '#' + n.id : n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).join('.') : ''));
        (window as unknown as W).__cspv.push({ d: e.violatedDirective, el: path.join(' > '), sample: e.sample || '', style: (t && t.nodeType === 1 && t.getAttribute('style')) || '' });
      });
    });
    await stubSupabase(page, { ...FIX, ...fx });
    // the page itself: its policy loses 'unsafe-inline' for styles (everything else falls through to the stub)
    await page.route('**/*', async (r) => {
      if (r.request().resourceType() !== 'document') return r.fallback();
      const res = await r.fetch();
      const h = { ...res.headers() };
      h['content-security-policy'] = (h['content-security-policy'] || '').replace("style-src 'self' 'unsafe-inline'", "style-src 'self'");
      await r.fulfill({ response: res, headers: h });
    });
    if (customer) await loginCustomer(page, { id: 'c1', name: 'Amal Top', email: 'amal.top@example.test', phone: '+966551230001' });
    else await unlockStaff(page);
    const res = await page.goto('/');
    expect(res!.headers()['content-security-policy'] || '').not.toContain("'unsafe-inline'");
    await page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && !!S.dataLoaded, undefined, { timeout: 30000 });
    await page.waitForTimeout(500);
  }
  // Every refusal inside the roots this pass draws into is written out with the refused style
  // (other areas' helpers draw inside them - a date field, the socials, a ticket card - until they
  // move too); one on an element that carries a cmy- class itself fails.
  const roots = /#tab-community|#new-acct-modal|#confirm-modal|#comm-add-modal|#jcc-group-modal|#group-edit-modal|#cust-modal|#tab-myrides/;
  const seen: Record<string, V[]> = {};
  const report = async (page: Page, what: string) => {
    const v = await page.evaluate(() => (window as unknown as W).__cspv.splice(0));
    const inArea = v.filter((x) => roots.test(x.el));
    if (inArea.length) seen[what] = inArea;
    expect.soft(inArea.filter((x) => /\.cmy-/.test(x.el.split(' > ').pop() || '')), what).toEqual([]);
  };
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, info) => {
    mkdirSync(join(SNAPS, '_strict'), { recursive: true });
    writeFileSync(join(SNAPS, '_strict', info.title.replace(/\W+/g, '_') + '.json'), JSON.stringify(seen, null, 1));
    for (const k of Object.keys(seen)) delete seen[k];
  });

  test('staff: every Community view and dialog trips nothing', async ({ page }) => {
    await strictOpen(page, false);
    await page.waitForFunction(() => (S.customers || []).length > 0);
    await report(page, 'boot');
    for (const sub of ['leaderboard', 'stats', 'accounts', 'flagged', 'birthdays', 'applications', 'learning', 'duplicates']) {
      await run(page, 'setStaffTab', 'community');
      await run(page, 'setCommTab', sub);
      await page.waitForTimeout(700);
      await report(page, sub);
    }
    await run(page, 'setCommTab', 'leaderboard'); await run(page, 'setLb', 'lbWindow', 'month'); await page.waitForTimeout(300); await report(page, 'lb month');
    await setS(page, { lbSearch: 'a' }); await run(page, 'renderCommunity'); await report(page, 'lb search');
    await setS(page, { lbSearch: '' });
    await run(page, 'setCommTab', 'accounts');
    await setS(page, { tagCustId: 'c1', _fOpen: { am: true }, amMissing: true, amSuspect: true }); await run(page, 'renderCommunity'); await report(page, 'am picker');
    await setS(page, { tagCustId: null, _fOpen: {}, amMissing: false, amSuspect: false, amDelReq: true }); await run(page, 'renderCommunity'); await report(page, 'am delreq');
    await setS(page, { amDelReq: false }); await run(page, 'openTagEdit', 'tag_vip'); await report(page, 'tag edit');
    await setS(page, { tagEdit: null }); await run(page, 'renderCommunity');
    await run(page, 'openAccountHistory', 'c1'); await page.waitForTimeout(500); await report(page, 'history');
    await run(page, 'showNewAcctModal'); await report(page, 'cf create');
    await run(page, 'showEditCustomerModal', 'c1'); await report(page, 'cf edit');
    await run(page, 'showEditCustomerModal', 'c2'); await report(page, 'cf edit 2');
    await run(page, 'showEditCustomerModal', 'c4'); await report(page, 'cf edit 3');
    await run(page, 'deleteCustomerAccount', 'c4'); await report(page, 'delete'); await run(page, 'closeConfirm'); await run(page, 'closeCustFormModal');
    await run(page, 'showFlagFieldsModal', 'c2'); await report(page, 'flag'); await run(page, '_flagClose');
    await run(page, 'showTagGrantModal', 'c4', 'tag_vip'); await run(page, '_tgSet', 'kind', 'temp'); await report(page, 'tg dur');
    await run(page, '_tgSet', 'mode', 'dates'); await report(page, 'tg dates'); await run(page, '_tgSet', 'today', false); await report(page, 'tg dates 2');
    await run(page, 'closeConfirm');
    await run(page, 'showTagGrantModal', 'c1', 'tag_blacklist'); await report(page, 'tg ban'); await run(page, 'closeConfirm');
    await run(page, 'setCommTab', 'applications'); await page.waitForTimeout(300);
    await run(page, '_caMsgShow', await page.evaluate(() => ((window as unknown as W)._caFind as (i: string) => unknown)('a4')), 'new', { name: 'Nour Fahad', password: 'Bike42xy' }); await report(page, 'ca msg'); await run(page, '_caMsgClose');
    await run(page, 'setCommTab', 'learning'); await page.waitForTimeout(300);
    await run(page, '_laSchedule', 'l1'); await report(page, 'la sched'); await run(page, 'closeConfirm');
    await run(page, '_laMsgShow', await page.evaluate(() => ((window as unknown as W)._laFind as (i: string) => unknown)('l3')), 'made', { password: 'Ride77ab' }); await report(page, 'la msg'); await run(page, '_laMsgClose');
    await run(page, 'setCommTab', 'duplicates'); await setS(page, { _mgQa: 'Ha', _mgB: 'c6' }); await run(page, 'renderCommunity'); await report(page, 'mg pick');
    await run(page, '_mgOpen', 'c1', 'c10'); await report(page, 'mg dialog'); await run(page, 'closeConfirm');
    await setS(page, { sfSession: '2026-09-26' }); await run(page, 'showCommAddModal', false); await run(page, '_on_caPick', 'c1'); await run(page, '_on_caOwn', true); await run(page, 'renderCommAddModal'); await report(page, 'ca add');
    await run(page, '_on_caGroup', true); await run(page, '_caToggleSel', 'c1'); await report(page, 'ca add group'); await run(page, 'closeCommAddModal');
    await setS(page, { sfSession: TODAY }); await run(page, 'showJccGroupModal'); await report(page, 'jg'); await run(page, 'closeJccGroupModal');
    for (const id of ['g1a', 'g2b', 'g3a']) { await run(page, 'showGroupEditModal', id); await report(page, 'ge ' + id); await run(page, 'closeGroupEditModal'); }
  });

  test('customer: the community dialogs and the breakfast spot trip nothing', async ({ page }) => {
    const mine2 = [q('k1', '2026-09-26', { status: 'waiting', paid: false, price: 0, approval: 'approved', name: 'Amal Top', customer_id: 'c1' })];
    await strictOpen(page, true, { queue_entries: mine2, 'rpc:community_member': true });
    await run(page, 'showView', 'customer'); await run(page, 'setCustTab', 'myrides');
    await page.waitForSelector('#tab-myrides .ticket-card');
    await report(page, 'my bookings');
    await run(page, 'showCommMembersModal'); await report(page, 'members'); await run(page, 'closeConfirm');
    await run(page, 'showRejectedModal', null); await report(page, 'rejected'); await run(page, 'closeConfirm');
  });
});
