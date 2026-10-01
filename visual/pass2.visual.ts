import { test, expect, type Page, type Locator } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from '../tests/helpers/supabase';
import { cascadeAudit, styleHashes, styleOf, type AuditRow } from './cascade-audit';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error clean-css ships no type declarations
import CleanCSS from 'clean-css';

declare const _langLoaded: (l: string) => boolean; // app global

// The second pass of the inline-style move (playwright.visual.config.ts says how to run it):
// Workshop, Messages and Ambassadors with their dialogs; Team, the team roster, the staff sign-in,
// the operator gate and the password change; the shared chrome (the top bar in every state, the
// confirm and prompt dialogs, the booth pop-up, the page without scripts) and the icons of
// _artIcon in four places; and the two report builders. Every state is a screenshot and a hash of
// the computed style of every element on the page (cascade-audit.ts), in English and Arabic, at
// 1280x900 and 390x844, from fixed data on a frozen clock.
//   AUDIT=inline  writes, per test, the rules that compete with each inline style (the baseline)
//   MIN_CSS=1     serves styles.css minified the way dist/ serves it (scripts/assemble-dist.mjs), so a
//                 value the minifier rewrites is compared as production draws it
//   AUDIT=class AUDIT_CLASSES=<file of class names, one a line>
//                 fails on a rule that would overrule one of those classes where it replaced an inline style
//   CSS_DUMP=<selector, or a key of a .css.txt file>   writes that element's computed style in full,
//                 per state, to <VISUAL_SNAPS>/_dump: what to diff when a hash differs
// Take the baseline from the untouched build, run it twice (it must pass unchanged), then convert.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
const SNAPS = process.env.VISUAL_SNAPS || join(tmpdir(), 'mm-visual-snaps');
// The classes the pass wrote (its rules in styles.css): the class audit checks the elements carrying them.
const CLASSES = process.env.AUDIT_CLASSES ? readFileSync(process.env.AUDIT_CLASSES, 'utf8').split(/\s+/).filter(Boolean) : [];

const slots = (t: string) => JSON.stringify({ _time: t, _total: 12 });
const sessions = [
  { id: '2026-09-22', day: 'Tuesday', session_date: '2026-09-22', capacity: 12, status: 'closed', location: 'JCC', bike_slots: slots('17:00 - 19:00'), created_at: 1 },
  { id: TODAY, day: 'Thursday', session_date: TODAY, capacity: 12, status: 'open', location: 'JCC', bike_slots: slots('21:00 - 23:00'), created_at: 2 },
  { id: '2026-09-26', day: 'Saturday', session_date: '2026-09-26', capacity: 12, status: 'open', location: 'JCC', bike_slots: slots('21:00 - 23:00'), created_at: 3 },
];
const bikes = [
  { id: 'b01', name: 'Road 1', type: 'Road', size: 'M', status: 'in-use', brand: 'Alvas', model: 'Climax', bike_number: 1, colors: ['#111'] },
  { id: 'b02', name: 'Hybrid 1', type: 'Hybrid', size: 'L', status: 'available', brand: 'Alvas', model: 'Cross 21S', bike_number: 2, colors: ['#0a0'] },
  { id: 'b03', name: 'Mountain 1', type: 'Mountain', size: 'M', status: 'available', brand: 'Alvas', model: 'Strom M50', bike_number: 3, colors: ['#555'] },
];
const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#00e585', locked: true },
  { id: 'tag_vip', slug: 'vip', name: 'VIP', color: '#ff0000' },
];
const customer_tags = [
  { customer_id: 'c1', tag_id: 'tag_saturday', added_at: NOW - 30 * 864e5, expires_at: null, starts_at: null },
  { customer_id: 'c3', tag_id: 'tag_vip', added_at: NOW - 5 * 864e5, expires_at: null, starts_at: null },
];
const customers = [
  { id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567', gender: 'female', birth_date: '1990-05-05', country: 'Saudi Arabia', nationality: 'Saudi Arabia', city: 'Jeddah', height: 165, type_preference: 'Road', created_at: '2026-08-20T10:00:00Z', default_pay: 'normal' },
  { id: 'c2', name: 'Omar Hassan', email: 'omar@example.test', phone: '0551234568', gender: 'male', birth_date: '2010-01-01', country: 'Saudi Arabia', nationality: 'Egypt', city: 'Riyadh', height: 180, type_preference: 'Hybrid', created_at: '2025-01-05T10:00:00Z', default_pay: 'house' },
  { id: 'c3', name: 'Cara Vale', email: 'cara@example.test', phone: '0551234569', gender: 'female', birth_date: '1975-01-01', country: 'United Kingdom', nationality: 'United Kingdom', city: 'London', height: 170, type_preference: 'Mountain', created_at: '2026-09-01T10:00:00Z', default_pay: 'normal' },
  { id: 'c4', name: 'Dan Reyes', email: 'dan@example.test', phone: '0551234570', gender: 'male', birth_date: '', country: '', city: 'Jeddah', height: null, type_preference: 'Any', created_at: '2026-07-01T10:00:00Z' },
];
const q = (id: string, n: number, o: Record<string, unknown>) => ({
  id, session_id: TODAY, session_day: 'Thursday', session_date: TODAY, queue_num: n, status: 'waiting', paid: false, price: 80,
  type_preference: 'Hybrid', size: 'M', height: 172, registered_at: '2026-09-22T10:00:00Z', ...o,
});
const queue_entries = [
  q('q1', 1, { name: 'Sara Ali', customer_id: 'c1', phone: '0551234567', status: 'active', paid: true, assigned_bike_id: 'b01', type_preference: 'Road', checked_in_at: '2026-09-24T18:05:00Z' }),
  q('q2', 2, { name: 'Omar Hassan', customer_id: 'c2', phone: '0551234568' }),
  q('q3', 3, { name: 'Cara Vale', customer_id: 'c3', phone: '0551234569', paid: true, type_preference: 'Mountain' }),
  q('q4', 4, { name: 'Walk-in Rider', status: 'done', paid: true, session_id: '2026-09-22', session_date: '2026-09-22', session_day: 'Tuesday', ride_duration: 45 }),
];
const job = (id: number, o: Record<string, unknown>) => ({
  id, created_at: '2026-09-20T09:30:00Z', customer_id: null, name: 'Sara Ali', phone: '+966551234567', email: null,
  service: 'full-service', service_label: 'Full service', price_quoted: 409, parts: [{ id: 'new-brake-pads', label: 'New brake pads', price: 60 }],
  lane: 'dropoff', pickup_address: null, preferred_date: '2026-09-26', preferred_time: '17:00', bike: 'ALVAS DA54 AL',
  notes: 'Brakes squeal at speed', lang: 'en', status: 'new', scheduled_for: null, price_final: null, staff_notes: null,
  updated_at: '2026-09-20T09:30:00Z', updated_by: 'website', ...o,
});
const workshop_jobs = [
  job(41, {}),
  job(42, { name: 'Omar Hassan', phone: '+966551234568', status: 'confirmed', scheduled_for: '2026-09-26T14:00:00Z', lang: 'ar', updated_at: '2026-09-21T10:00:00Z', updated_by: 'Spec Staff' }),
  job(43, { name: 'Lina Saleh', phone: '+966550000003', status: 'in_workshop', lane: 'pickup', pickup_address: 'Al Rawdah, Jeddah', staff_notes: 'Chain worn, replace', price_final: 349, updated_at: '2026-09-22T08:00:00Z', updated_by: 'Spec Staff' }),
  job(44, { name: 'Faisal Noor', phone: '+966550000004', status: 'awaiting_parts', parts: [], notes: null, updated_at: '2026-09-22T09:00:00Z', updated_by: 'Spec Staff' }),
  job(45, { name: 'Reem Adel', phone: '+966550000005', status: 'ready', price_final: 449, lane: 'wait', updated_at: '2026-09-23T09:00:00Z', updated_by: 'Spec Staff' }),
  job(46, { name: 'Tariq Omar', phone: '+966550000006', status: 'completed', updated_at: '2026-09-23T12:00:00Z', updated_by: 'Spec Staff' }),
  job(47, { name: 'Huda Sami', phone: '+966550000007', status: 'cancelled', updated_at: '2026-09-23T13:00:00Z', updated_by: 'Spec Staff' }),
];
const workshop_job_events = [
  { job_id: 43, at: '2026-09-20T09:30:00Z', status: 'new', note: 'requested', by: 'website' },
  { job_id: 43, at: '2026-09-21T10:00:00Z', status: 'confirmed', note: 'scheduled 2026-09-26 17:00', by: 'Spec Staff' },
  { job_id: 43, at: '2026-09-22T08:00:00Z', status: 'in_workshop', note: 'price 349.00', by: 'Spec Staff' },
];
const msg = (id: number, o: Record<string, unknown>) => ({
  id, created_at: '2026-09-22T09:30:00Z', kind: 'business', topic: 'fleet-programmes', name: 'Omar Hassan', company: 'Red Sea Hotels',
  email: 'omar@example.test', phone: '+966551234568', message: 'We need 20 bikes\nfor our guests.', lang: 'en', customer_id: null,
  status: 'new', staff_notes: null, updated_at: '2026-09-22T09:30:00Z', updated_by: 'website', ...o,
});
const site_messages = [
  msg(7, {}),
  msg(8, { kind: 'help', topic: 'warranty', company: null, name: 'Lina Saleh', phone: null, email: 'lina@example.test', message: 'My bike clicks when I change gear. Is that covered?', status: 'replied', updated_at: '2026-09-23T09:30:00Z', updated_by: 'Spec Staff' }),
  msg(9, { kind: 'jobs', topic: 'general', company: null, name: 'Faisal Noor', email: null, phone: '+966550000004', message: 'أرغب في الانضمام إلى فريقكم.', lang: 'ar', status: 'closed', staff_notes: 'Called back on Tuesday', updated_at: '2026-09-23T10:30:00Z', updated_by: 'Spec Staff' }),
];
const amb = (id: number, o: Record<string, unknown>) => ({
  id, created_at: '2026-09-15T09:30:00Z', name: 'Sara Ali', phone: '+966551234567', instagram: 'sara.rides', why: 'I lead the Sunday group ride.',
  lang: 'en', customer_id: null, status: 'pending', code: null, decided_at: null, staff_notes: null, updated_at: '2026-09-15T09:30:00Z', updated_by: 'website', ...o,
});
const ambassadors = [
  amb(5, {}),
  amb(6, { name: 'Omar Hassan', phone: '+966551234568', status: 'active', code: 'OMAR10', staff_notes: 'Great reach on Instagram', updated_at: '2026-09-18T09:30:00Z', updated_by: 'Spec Staff' }),
  amb(7, { name: 'Reem Adel', phone: '+966550000005', instagram: null, status: 'paused', code: 'REEM10', lang: 'ar', updated_at: '2026-09-19T09:30:00Z', updated_by: 'Spec Staff' }),
  amb(8, { name: 'Tariq Omar', phone: '+966550000006', why: null, status: 'rejected', updated_at: '2026-09-20T09:30:00Z', updated_by: 'Spec Staff' }),
];
const ambassador_redemptions = [
  { id: 1, created_at: '2026-09-20T10:00:00Z', ambassador_id: 6, item: 'Store kit', points: 1000, status: 'requested', updated_at: '2026-09-20T10:00:00Z', updated_by: 'website' },
];
const team = [
  { user_id: '11111111-1111-1111-1111-111111111111', email: 'owner@example.com', role: 'admin', modules_view: null, modules_edit: null, is_me: true },
  { user_id: '22222222-2222-2222-2222-222222222222', email: 'desk@example.com', role: 'frontdesk', modules_view: ['queue', 'cashier'], modules_edit: ['queue'], is_me: false },
];
const FIX = {
  sessions, bikes, customers, tags, customer_tags, queue_entries, workshop_jobs, workshop_job_events, site_messages, ambassadors, ambassador_redemptions,
  'rpc:staff_ambassador_stats': [{ id: 6, balance: 1250, earned: 1500, pending: 2, uses: 14, tier: 1, code_active: true }, { id: 7, balance: 300, earned: 300, pending: 0, uses: 3, tier: 0, code_active: false }],
  'rpc:staff_operator_list': [{ name: 'Malik', has_pin: false }, { name: 'Salem', has_pin: true }],
  'rpc:staff_team_list': team,
};

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function settle(page: Page) {
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await document.fonts.ready;
    await Promise.all([...document.images].filter((i) => !i.complete && i.loading !== 'lazy').map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // a transition under way (the close button's colour on hover) is waited for, not caught halfway
    await Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
    await document.fonts.ready;
  });
}

type Open = { lang: string; staff?: boolean; cust?: Record<string, unknown> | null; fx?: Record<string, unknown> };
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
  if (o.staff) await unlockStaff(page);
  if (o.cust) await loginCustomer(page, o.cust);
  await page.addInitScript((lang) => {
    localStorage.setItem('cq_lang', lang);
    localStorage.setItem('cq_lang_pick', '1');
  }, o.lang);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction((l) => typeof _langLoaded === 'function' && _langLoaded(l) && document.documentElement.lang === l, o.lang);
  if (o.staff) await page.waitForFunction(`S.view==='staff'`);
  // Two things that move on their own: the loading screen's fade, and the Bookings refresh label,
  // which says "just now" or "Live" depending on when the realtime join and the 5-second tick land.
  await page.waitForFunction(`getComputedStyle(document.getElementById('loading-screen')).display==='none'`);
  await page.evaluate(`window._tickRefreshLabel=function(){}`);
}
// Waits until nothing in the page has changed for a quarter of a second (the dialog focus manager
// acts 40 ms after the last change; a list read lands a moment after its request).
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

// One state: the screenshot (the page, or the viewport for an overlay that scrolls inside
// itself), the computed-style hashes of the whole body, and under AUDIT the cascade check.
const audits: Record<string, AuditRow[]> = {};
async function shot(page: Page, name: string, o: { full?: boolean; el?: Locator; roots?: string[] } = {}) {
  await quiet(page);
  await settle(page);
  if (o.el) await expect.soft(o.el).toHaveScreenshot(name + '.png');
  else await expect.soft(page).toHaveScreenshot(name + '.png', { fullPage: o.full !== false });
  // stripOrigin: the loading mark's mask-image resolves to http://127.0.0.1:<VIS_PORT>/..., and a
  // baseline taken on another port failed on every shot (2026-10-01).
  const hashes = await page.evaluate(styleHashes, { roots: ['body'], stripOrigin: true });
  if (process.env.CSS_DUMP) { // one element's computed style in full, to read when its hash differs
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
  const n = await page.evaluate((s) => { const b = document.querySelector(s); if (!b) return 1; b.scrollTop = 0; return Math.max(1, Math.ceil((b.scrollHeight - b.clientHeight) / Math.max(1, Math.floor(b.clientHeight * 0.8))) + 1); }, box);
  for (let i = 0; i < n; i++) {
    await page.evaluate(([s, k]) => { const b = document.querySelector(s as string); if (b) b.scrollTop = Math.floor(b.clientHeight * 0.8) * (k as number); }, [box, i]);
    await shot(page, `${name}-${i}`, { full: false });
  }
  await page.evaluate((s) => { const b = document.querySelector(s); if (b) b.scrollTop = 0; }, box);
}
const staffTab = async (page: Page, tab: string, ready: string) => {
  await page.evaluate(`setStaffTab('${tab}');window.scrollTo(0,0)`);
  await page.waitForFunction(ready);
};

test.describe.configure({ timeout: 300000 }); // a loaded machine (a virus scanner, a parallel suite) runs these slowly, not differently
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`@visual:pass2 ${vpName}`, () => {
    test.use(vp);
    for (const lang of ['en', 'ar']) {
      const P = `${vpName}-${lang}`;

      test(`workshop ${lang}`, async ({ page }) => {
        await open(page, { lang, staff: true });
        await staffTab(page, 'workshop', `!!(S._ws&&S._ws.jobs)`);
        await page.evaluate(`_ws().filter='all';renderWorkshop()`);
        await shot(page, `${P}-ws-list`);
        await page.evaluate(`_wsHist(43)`);
        await page.waitForFunction(`Array.isArray(_ws().events[43])`);
        await page.evaluate(`window.scrollTo(0,0)`);
        await shot(page, `${P}-ws-list-hist`);
        await page.evaluate(`_ws().q='Lina';renderWorkshop(true)`);
        await shot(page, `${P}-ws-list-search`);
        await page.evaluate(`_ws().q='';_ws().filter='new';renderWorkshop()`);
        for (const [k, js] of [['sched', '_wsSchedule(41)'], ['resched', '_wsSchedule(42)'], ['ready', '_wsReady(43)'], ['edit', '_wsEdit(44)'], ['msg', '_wsMsgOpen(42)']]) {
          await page.evaluate(js);
          await page.waitForTimeout(120);
          await shot(page, `${P}-ws-dlg-${k}`, { full: false });
          if (k === 'edit') { await page.evaluate(`_wsDlgErr('wsSchedErr')`); await shot(page, `${P}-ws-dlg-edit-err`, { full: false }); }
          await page.evaluate(`closeConfirm()`);
        }
        await page.evaluate(`const W=_ws();W.jobs=null;W.err=true;W.busy=false;W.missing=false;renderWorkshop()`);
        await shot(page, `${P}-ws-err`);
      });

      test(`messages ${lang}`, async ({ page }) => {
        await open(page, { lang, staff: true });
        await staffTab(page, 'messages', `!!(S._sm&&S._sm.rows)`);
        await page.evaluate(`_sm().filter='all';renderMessages()`);
        await shot(page, `${P}-sm-list`);
        for (const [k, js] of [['reply', '_smReply(7)'], ['reply-ar', '_smReply(9)'], ['notes', '_smNotes(9)']]) {
          await page.evaluate(js);
          await page.waitForTimeout(120);
          await shot(page, `${P}-sm-dlg-${k}`, { full: false });
          await page.evaluate(`closeConfirm()`);
        }
        await page.evaluate(`const W=_sm();W.rows=null;W.err=true;W.busy=false;W.missing=false;renderMessages()`);
        await shot(page, `${P}-sm-err`);
      });

      test(`ambassadors ${lang}`, async ({ page }) => {
        await open(page, { lang, staff: true });
        await staffTab(page, 'ambassadors', `!!(S._amb&&S._amb.rows)`);
        await page.evaluate(`_amb().filter='all';renderAmbassadors()`);
        await shot(page, `${P}-amb-list`);
        for (const [k, js] of [['approve', '_ambApprove(5)'], ['notes', '_ambNotes(6)'], ['msg', `_ambMsgOpen(6,'welcome')`], ['msg-reject', `_ambMsgOpen(8,'reject')`]]) {
          await page.evaluate(js);
          await page.waitForTimeout(120);
          await shot(page, `${P}-amb-dlg-${k}`, { full: false });
          await page.evaluate(`closeConfirm()`);
        }
        await page.evaluate(`const W=_amb();W.rows=null;W.err=true;W.busy=false;W.missing=false;renderAmbassadors()`);
        await shot(page, `${P}-amb-err`);
      });

      test(`team and sign-in ${lang}`, async ({ page }) => {
        await open(page, { lang, staff: true });
        await staffTab(page, 'team', `!!(S._tm&&S._tm.ops&&document.querySelector('#tab-team .tm-acct'))`);
        await shot(page, `${P}-tm-section`);
        await page.evaluate(`S.teamMembers=['Ali Alotaibi','Dana Alshehri','Malik'];showTeamManager()`);
        await shot(page, `${P}-tm-roster`, { full: false });
        await page.evaluate(`closeTeamManager();S.teamMembers=[];showTeamManager()`);
        await shot(page, `${P}-tm-roster-empty`, { full: false });
        await page.evaluate(`closeTeamManager()`);
        // the operator gate: the names, the keypad, an approval, a typed name, a failed read, the wait
        const gate = (g: string) => `S._opg=Object.assign({switching:true,list:[{name:'Malik',has_pin:false},{name:'Salem',has_pin:true}],missing:false,pick:null,digits:'',msg:'',busy:false,shake:false,err:false},${g});document.getElementById('op-gate-modal').style.display='flex';_opGateRender()`;
        for (const [k, g] of [
          ['names', '{}'], ['first', '{switching:false}'], ['keypad', `{pick:'Salem',digits:'12',msg:'Wrong PIN. 4 tries left.'}`],
          ['approve', `{pick:'Salem',digits:'',approve:{what:'Refund',res:()=>{}}}`], ['typed', `{list:null,missing:true}`],
          ['typed-first', `{list:[{name:'Malik',has_pin:false}],switching:false}`], ['err', `{list:null,err:true}`], ['loading', `{list:undefined}`],
        ]) {
          await page.evaluate(gate(g));
          await shot(page, `${P}-opg-${k}`, { full: false });
          await page.evaluate(`S._opg=null;const m=document.getElementById('op-gate-modal');m.style.display='none';m.innerHTML=''`);
        }
        // the password change: optional, then required, then with its error
        await page.evaluate(`S._staffAuthed=true;openStaffPwdModal(false)`);
        await page.waitForTimeout(120);
        await shot(page, `${P}-pwd`, { full: false });
        await page.evaluate(`_staffPwdSubmit()`);
        await shot(page, `${P}-pwd-err`, { full: false });
        await page.evaluate(`document.getElementById('staff-pwd-modal').remove();openStaffPwdModal(true)`);
        await page.waitForTimeout(120);
        await shot(page, `${P}-pwd-must`, { full: false });
      });

      test(`staff sign-in and customer chrome ${lang}`, async ({ page }) => {
        await open(page, { lang });
        await shot(page, `${P}-landing`);
        await shot(page, `${P}-topbar-landing`, { el: page.locator('#topbar') });
        await page.evaluate(`openPinModal()`);
        await page.waitForTimeout(120);
        await shot(page, `${P}-signin`, { full: false });
        await page.evaluate(`_staffAuthSubmit()`);
        await shot(page, `${P}-signin-err`, { full: false });
        await page.evaluate(`closePinModal()`);
        await page.evaluate(`_showPopup('Payment at the Booth','Pay at the booth when you arrive.','Bikes are handed out first come, first served.')`);
        await shot(page, `${P}-booth`, { full: false });
        await page.evaluate(`closeBoothPopup()`);
        await page.evaluate(`confirmDialog({title:'Cancel booking',body:'#3 - Sara Ali',confirmLabel:'Cancel booking',confirmClass:'btn-red',onConfirm:()=>{}})`);
        await shot(page, `${P}-confirm-cust`, { full: false });
        await page.evaluate(`closeConfirm()`);
        await page.evaluate(`goCustomer('myrides')`);
        await page.waitForTimeout(150);
        await shot(page, `${P}-topbar-cust-out`, { el: page.locator('#topbar') });
      });

      test(`top bar ${lang}`, async ({ page }) => {
        await open(page, { lang, cust: { id: 'c1', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567' } });
        await shot(page, `${P}-topbar-picker`, { el: page.locator('#topbar') });
        await page.evaluate(`goCustomer('myrides')`);
        await page.waitForTimeout(150);
        await shot(page, `${P}-topbar-cust`, { el: page.locator('#topbar') });
        await page.evaluate(`const c=getSession();c.photo='/icon-192.png';S.loggedIn=c;renderTopbarRight()`);
        await shot(page, `${P}-topbar-cust-photo`, { el: page.locator('#topbar') });
        await page.evaluate(`goLanding()`);
        await page.waitForTimeout(150);
        await page.evaluate(`renderTopbarRight()`);
        await shot(page, `${P}-topbar-picker-photo`, { el: page.locator('#topbar') });
      });

      test(`staff chrome and icons ${lang}`, async ({ page }) => {
        await open(page, { lang, staff: true });
        await page.evaluate(`window.scrollTo(0,0)`);
        await shot(page, `${P}-bookings`);
        await shot(page, `${P}-topbar-staff`, { el: page.locator('#topbar') });
        await page.evaluate(`S._staffAuthed=true;S.undoStack.push({label:'Checked in #3 Cara Vale',fn:()=>{}});renderTopbarRight()`);
        await shot(page, `${P}-topbar-staff-undo`, { el: page.locator('#topbar') });
        await page.evaluate(`confirmDialog({title:'Remove rider',body:'#3 - Cara Vale',confirmLabel:'Remove',confirmClass:'btn-red',onConfirm:()=>{}})`);
        await shot(page, `${P}-confirm`, { full: false });
        await page.evaluate(`closeConfirm();confirmDialog({title:'Delete for good?',confirmLabel:'Delete',onConfirm:()=>{}})`);
        await shot(page, `${P}-confirm-nobody`, { full: false });
        await page.evaluate(`closeConfirm();void askConfirm({title:'Close the session?',body:'Nobody else can book it.',confirmLabel:'Close',confirmClass:'btn-primary'})`);
        await shot(page, `${P}-confirm-ask`, { full: false });
        await page.evaluate(`closeConfirm();void promptDialog({title:'PIN for Salem',numeric:true})`);
        await page.waitForTimeout(120);
        await shot(page, `${P}-prompt`, { full: false });
        await page.evaluate(`_promptDone(null);void promptDialog({title:'Rename',body:'The name staff see on the roster.',value:'Sara Ali',placeholder:'Name',confirmLabel:'Rename'})`);
        await page.waitForTimeout(120);
        await shot(page, `${P}-prompt-body`, { full: false });
        await page.evaluate(`_promptDone(null);confirmDialog({title:'Remove rider',body:'#3 - Cara Vale',confirmLabel:'Remove',onConfirm:()=>{}})`);
        await quiet(page); // the focus manager moves focus into the dialog 40 ms after it draws: before the pointer arrives, every time
        await page.locator('#confirm-modal .confirm-box button[aria-label]').first().hover();
        await shot(page, `${P}-confirm-hover`, { full: false });
      });

      test(`report builders ${lang}`, async ({ page }) => {
        await open(page, { lang, staff: true });
        await page.waitForFunction(`getCustomers().length===4`);
        await page.evaluate(`localStorage.removeItem('cq_rep_opts');S._repOpts=null;showPrintReportOptions()`);
        await shotScroll(page, `${P}-rpt-session`, '#print-opts-modal .modal-box');
        await page.evaluate(`_repToggle('cols','phone');_repToggle('cols','name')`);
        await shotScroll(page, `${P}-rpt-session-toggled`, '#print-opts-modal .modal-box');
        await page.evaluate(`_closePrintOpts();localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null;setStaffTab('community');S.communityTab='accounts';renderCommunity();showAccountReportOptions()`);
        await shotScroll(page, `${P}-rpt-acct`, '#print-opts-modal .modal-box');
        await page.evaluate(`_accSet('fTag','tag_saturday');_accToggle('chartsOn','nationality');_accToggle('cols','email')`);
        await shotScroll(page, `${P}-rpt-acct-picked`, '#print-opts-modal .modal-box');
        await page.evaluate(`showAccountReportOptions()`);
        await shotScroll(page, `${P}-rpt-acct-redrawn`, '#print-opts-modal .modal-box');
      });
    }

    test(`no scripts`, async ({ browser }) => {
      const ctx = await browser.newContext({ ...vp, javaScriptEnabled: false, colorScheme: 'light', locale: 'en-US', timezoneId: 'Asia/Riyadh', baseURL: test.info().project.use.baseURL });
      const page = await ctx.newPage();
      // The loading screen stays up without scripts and covers the first screenful; the text under
      // it is the point here. Nothing can be injected into a page without scripts, so the sheet says it.
      await page.route(/\/styles\.css/, async (r) => {
        const res = await r.fetch();
        const css = process.env.MIN_CSS ? new CleanCSS({ level: 1 }).minify(await res.text()).styles : await res.text();
        await r.fulfill({ response: res, body: css + '\n#loading-screen{display:none!important}' });
      });
      await page.goto('/');
      await expect.soft(page).toHaveScreenshot(`${vpName}-noscript.png`, { fullPage: true });
      await ctx.close();
    });
  });
}
