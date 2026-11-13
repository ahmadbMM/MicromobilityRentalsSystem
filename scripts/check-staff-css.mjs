// The staff screens' type, weight and radius stay on their tokens (staff round s10, item 27, 2026-11-11).
// The Soft Solid tokens (styles.css, body.view-staff) set one type scale (--sf-fs-xs .. --sf-fs-2xl: 12 / 13 / 15 / 17 /
// 22 / 28px, in rem so a phone's text-size setting reaches them), weights 400 / 500 / 600 and the radius ladder
// 4 / 8 / 12 / 14 / 16 / pill. A sweep moved every staff rule onto them; this check keeps it there. In every rule only
// the staff screens can match (the same test that keeps those rules out of the customer's app.css, staffSelTest in
// scripts/split-staff.mjs) it fails on:
//   - a font-size (or a font shorthand) with a raw px length outside a var() (a token, or a token with a px fallback, passes);
//   - a font-weight above 600 (700, 800, 900, bold, bolder);
//   - a border-radius with a length off the ladder (0, 4, 8, 12, 14, 16 and 999px or more, 50% / 100%, var() pass).
// The few intentional exceptions are listed in scripts/staff-css-allow.json, each with its reason: { "sel": a piece of
// the selector, "prop", "value": the declared value, "why" }. An entry that no longer matches anything fails too, so the
// list never keeps an exception the CSS dropped.
//
// Usage: node scripts/check-staff-css.mjs [--stats]   (reads the built index.html, app.js, staff.js and staff-parts/;
// exit 1 on any offender). The build runs it on the texts it has just built (build-html.mjs).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cssTokens, splitSelectors, staffSelTest, requiredNames } from './split-staff.mjs';

const GROUP = /^@(?:media|supports|layer|container|document)\b/i;
// The staff view's own markup ships inside the customer's index.html (hidden), so staffSelTest alone calls a rule like
// `#tab-cashier .sl-lbl` shared. These hosts are only ever shown to staff: the section panels under #view-staff and the
// staff dialogs' hosts (the customer's page never opens them), so a selector that needs one is a staff rule too.
export const STAFF_HOSTS = new Set(['view-staff', 'tab-queue', 'tab-waitlist', 'tab-sessions', 'tab-lockers', 'tab-inventory', 'tab-cashier',
  'tab-store', 'tab-payments', 'tab-community', 'tab-customers', 'tab-badgereq', 'tab-ask', 'tab-analytics', 'tab-history', 'tab-website', 'tab-catalog',
  'tab-workshop', 'tab-messages', 'tab-ambassadors', 'tab-volunteers', 'tab-vendors', 'tab-team', 'tab-settings', 'tab-dashboard', 'tab-bikes',
  'pin-modal', 'bike-modal', 'checkin-modal', 'edit-price-modal', 'optlist-modal', 'return-pay-modal', 'return-modal', 'cust-modal',
  'bike-profile-modal', 'cashier-modal', 'receipt-edit-modal', 'team-mgr-modal', 'cancel-reason-modal', 'walkin-modal', 'op-gate-modal',
  'wl-add-modal', 'comm-add-modal', 'rider-walkin-modal', 'jcc-group-modal', 'group-edit-modal', 'new-acct-modal', 'booking-edit-modal',
  'booking-note-modal', 'print-opts-modal', 'qnum-edit-modal', 'reschedule-modal', 'scan-modal', 'rider-modal', 'rider-report-modal']);
/** staffSelTest, widened by STAFF_HOSTS. */
export function staffRuleTest(customerText, staffText) {
  const base = staffSelTest(customerText, staffText);
  return (sel) => base(sel) || requiredNames(sel).some((n) => STAFF_HOSTS.has(n));
}
const LADDER = new Set([0, 4, 8, 12, 14, 16]);

/** The declarations of a rule body: [{prop, value}] (semicolons inside brackets or strings do not split). */
export function declarations(body) {
  const out = []; let d = 0, q = null, cur = '';
  const push = () => { const i = cur.indexOf(':'); if (i > 0) out.push({ prop: cur.slice(0, i).trim().toLowerCase(), value: cur.slice(i + 1).trim() }); cur = ''; };
  for (const c of body.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (q) { if (c === q) q = null; cur += c; continue; }
    if (c === '"' || c === "'") q = c;
    if (c === '(') d++; else if (c === ')') d--;
    if (c === ';' && !d) push(); else cur += c;
  }
  push();
  return out;
}
/** A value with every var(...) taken out (its fallback is the token's, not a raw value). */
const noVars = (v) => { let s = v; for (let k = 0; k < 10 && /var\(/.test(s); k++) s = s.replace(/var\((?:[^()]|\([^()]*\))*\)/g, 'TOKEN'); return s; };
const val = (v) => v.replace(/\s*!important\s*$/i, '').trim();

/** What is wrong with one declaration, or '' when nothing is. */
export function badDecl(prop, value) {
  const v = noVars(val(value));
  if (prop === 'font-size') return /(?:^|[^\w.-])\d*\.?\d+px\b/.test(v) ? 'raw px font-size' : '';
  if (prop === 'font-weight') return /^(?:[7-9]\d\d|bold|bolder)$/i.test(v) ? 'weight above 600' : '';
  if (prop === 'font' && /(?:^|\s)(?:[7-9]00|bold|bolder)\s/i.test(v)) return 'weight above 600';
  if (prop === 'font' && /(?:^|[^\w.-])\d*\.?\d+px\b/.test(v)) return 'raw px font-size';
  if (/^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/.test(prop)) {
    for (const m of v.matchAll(/(-?\d*\.?\d+)(px|rem|em)\b/g)) {
      const px = Number(m[1]) * (m[2] === 'px' ? 1 : 16);
      if (!LADDER.has(px) && px < 999) return 'radius off the ladder';
    }
    return '';
  }
  return '';
}

/** Walk the staff-only rules of `css`: [{sel, prop, value, why}] for each declaration badDecl refuses. */
export function staffCssOffenders(css, isStaffSel) {
  const out = [];
  (function walk(text) {
    for (const t of cssTokens(text)) {
      if (t.kind === 'rule') {
        if (!splitSelectors(t.prelude).every(isStaffSel)) continue;
        for (const { prop, value } of declarations(t.body)) {
          const why = badDecl(prop, value);
          if (why) out.push({ sel: t.prelude.replace(/\s+/g, ' ').trim(), prop, value: val(value), why });
        }
      } else if (t.kind === 'at' && t.body !== null && GROUP.test(t.prelude)) walk(t.body);
    }
  })(css);
  return out;
}

/** The offenders the allow-list does not name, and the allow-list entries that name nothing. */
export function checkStaffCss(css, customerText, staffText, allow) {
  const all = staffCssOffenders(css, staffRuleTest(customerText, staffText));
  const used = new Set();
  const offenders = all.filter((o) => {
    const i = allow.findIndex((a) => a.prop === o.prop && a.value === o.value && o.sel.includes(a.sel));
    if (i >= 0) { used.add(i); return false; }
    return true;
  });
  const stale = allow.filter((_, i) => !used.has(i));
  return { offenders, stale, allowed: used.size };
}

export function loadAllow(url = new URL('./staff-css-allow.json', import.meta.url)) {
  const list = JSON.parse(readFileSync(url, 'utf8'));
  for (const a of list) if (!a.sel || !a.prop || !a.value || !a.why) throw new Error(`staff-css-allow.json: every entry names sel, prop, value and why: ${JSON.stringify(a)}`);
  return list;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../', import.meta.url);
  const rd = (p) => readFileSync(new URL(p, root), 'utf8');
  const parts = readdirSync(new URL('staff-parts/', root)).filter((f) => f.endsWith('.js')).map((f) => rd('staff-parts/' + f));
  const css = rd('styles.css'), cust = rd('index.html') + '\n' + rd('app.js'), staff = rd('staff.js') + '\n' + parts.join('\n');
  if (process.argv.includes('--stats')) {
    const isStaff = staffRuleTest(cust, staff); const n = { size: new Map(), weight: new Map(), radius: new Map() };
    (function walk(text) {
      for (const t of cssTokens(text)) {
        if (t.kind === 'rule' && splitSelectors(t.prelude).every(isStaff)) for (const { prop, value } of declarations(t.body)) {
          const k = prop === 'font-size' ? 'size' : prop === 'font-weight' ? 'weight' : /radius$/.test(prop) ? 'radius' : '';
          if (k) n[k].set(val(value), (n[k].get(val(value)) || 0) + 1);
        } else if (t.kind === 'at' && t.body !== null && GROUP.test(t.prelude)) walk(t.body);
      }
    })(css);
    for (const k of Object.keys(n)) console.log(k, [...n[k]].sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v} x${c}`).join(' | '));
  }
  const r = checkStaffCss(css, cust, staff, loadAllow());
  for (const o of r.offenders) console.log(`${o.why}: ${o.sel} { ${o.prop}: ${o.value} }`);
  for (const a of r.stale) console.log(`allow-list entry matches nothing: ${JSON.stringify(a)}`);
  console.log(`check-staff-css: ${r.offenders.length} offender(s), ${r.stale.length} stale allow-list entr(ies), ${r.allowed} allowed`);
  process.exit(r.offenders.length || r.stale.length ? 1 : 0);
}
