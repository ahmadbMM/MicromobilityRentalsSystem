// The staff half of the app, split off at build time (2026-09-27).
//
// One file serves customers and staff, and a customer's phone used to download all of it: 450 KB
// gzipped, of which about two thirds - the roster, check-in, sales, inventory, analytics, the
// website editor - is code only a staffer ever runs. This module cuts the built page's main script
// in two:
//
//   - the CUSTOMER half stays inline in index.html: every top-level statement a customer's page can
//     reach, found by walking references from the roots - the statements that run at load, the
//     on*="..." (now data-on-*) handlers in the page's own markup, the head's small scripts - through function
//     bodies, template strings and handler strings (onclick="fn()" names a function by its name);
//   - the STAFF half goes to staff.js, fetched the moment a staffer enters (goStaff, the sign-in,
//     the staff address) and cached by the service worker like any versioned file.
//
// The two halves meet at the entry points below (STAFF_ENTRY): functions the customer half calls
// but that belong to staff - goStaff itself, the sign-in, the section renderers a background
// refresh or a realtime event repaints. The walk stops at them, and the customer half gets a stub
// for each: on a staff device it fetches staff.js and then runs the real function (whose
// declaration replaces the stub); on a customer's page it does nothing, because there is no staff
// page to draw. Every entry point is called for its effect, never for a value - a stub answers a
// promise, so one that had to return a value would break its caller.
//
// The build refuses two things, loudly: a customer-half reference to a staff-half name that is not
// an entry point (a stub would hide a ReferenceError until a customer hit it), and an entry point
// that is not a plain function declaration (only those can be replaced when staff.js loads).
//
// The second half of this file holds the build CHECKS (handler names, bare writes, the size budget)
// and the helpers they share with the build. They live here and not in build-html.mjs because that
// script runs on import; these are plain exports the build calls and tests/build-checks.spec.ts
// imports, so the checks guard the source even when nobody runs the build.
import * as acorn from 'acorn';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

/** Functions the customer half calls into staff through. Add here when the build says so. */
export const STAFF_ENTRY = [
  'goStaff', 'openPinModal', '_staffHostGate', // the way in: these always fetch the staff half
  'setStaffTab', 'renderStaffTabs', '_renderStaffTab', '_bgRenderStaffTab',
  'renderStaffQueue', 'renderSessions', 'renderBikes', 'renderHistory', 'renderAnalytics', 'setAnView', 'renderInventory',
  'renderCashier', 'renderCommunity', 'renderCustomers', 'renderWebsite', 'renderCatalog', 'renderWorkshop', 'renderMessages',
  'renderAmbassadors', 'renderVendors', 'renderTeam', 'renderDashboard', 'renderLogs',
  'renderModal', 'renderCheckinModal', '_ntSync', '_tbRender',
  'doUndo', // the topbar's Undo (2026-09-28)
  '_retBackFromTill', // the till closed from a return: the return sheet comes back (2026-10-09, D7; closeCashierModal is customer-half code)
  '_tpMsgOpen', // the account editor's temporary-password message (2026-09-29): its save is customer-half code
  // The staff top bar's search (2026-09-29): Ctrl/Cmd+K is listened for at load, and through the
  // search every account's history and the whole account editor were reached from the customer
  // half - about 116 statements a customer's page carried and could never run (the listener
  // answers only in the staff view, where staff.js is loaded).
  '_gsOpen',
  '_kbStaff', // the walk-in / scan / shortcut-list keys (2026-10-03), listened for at load like Ctrl/Cmd+K
  // Staff-only hooks the customer half named, each pulling a staff chain into every customer's page
  // (2026-10-04, the customer half was at 231.9 of 232 KB on the runner): the riders table's realtime
  // handler (riders list -> scanner -> check-in, return, cashier, hand-over), the N shortcut (check-in
  // and the riders report), the operator gate's keypad, and the add-on picker's way into the price editor.
  '_onRidersRt', '_kbCheckInNext', '_opgKey', 'showEditPriceModal',
  '_idleStaff', // the idle clock (2026-10-04): started by the operator gate's check, which showView runs
  'lockStaff', // the top bar's lock (drawn by customer-half code): its sign-out settles the outboxes and asks first
  '_vendorLatePoll', // the bell's late cancels by venues (2026-10-04): the vendor poll and the bell's opening fetch them
  '_bizFromOpts', // the business settings (2026-10-09): applied when the staff lists arrive, which customer-half code fetches
];
/** Entry points that fetch the staff half whatever the page's state: entering staff is the point. */
const ALWAYS_LOAD = new Set(['goStaff', 'openPinModal', '_staffHostGate']);

const PURE = new Set(['ObjectExpression', 'ArrayExpression', 'Literal', 'ArrowFunctionExpression', 'FunctionExpression', 'TemplateLiteral']);
const WORD = /[A-Za-z_$][\w$]*/g;

/**
 * Splits the main script of an assembled page. `html` is the whole document (includes resolved,
 * translation packs extracted); the main script is the one after the supabase-js tag, closed by a
 * </script> alone on its line (the report templates carry </script> inside strings).
 * Returns the page with the customer half (plus the stubs and loader) and the staff half's code.
 * `staffUrl` is what the loader fetches; the caller knows the hash only after minifying, so it
 * passes a placeholder and replaces it. `staffCssUrl` is the whole stylesheet a staff device adds
 * (empty: none).
 */
export function splitStaff(html, staffUrl, staffCssUrl = '') {
  const { code, open, close } = mainScript(html);
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });

  const decl = new Map(); const stmts = [];
  ast.body.forEach((node, idx) => {
    let names = [];
    if (node.type === 'FunctionDeclaration') names = [node.id.name];
    else if (node.type === 'VariableDeclaration') names = node.declarations.flatMap((d) => (d.id.type === 'Identifier' ? [d.id.name] : []));
    const st = { idx, node, names, refs: new Set() };
    stmts.push(st);
    for (const n of names) decl.set(n, st);
  });
  const topNames = new Set(decl.keys());
  const wordsOf = (text, out) => { for (const w of text.match(WORD) || []) if (topNames.has(w)) out.add(w); };
  function walk(node, parent, key, out) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier') {
      const isProp = parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand)
        || (parent.type === 'MethodDefinition' && key === 'key'));
      if (!isProp && topNames.has(node.name)) out.add(node.name);
      return;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') { wordsOf(node.value, out); return; }
    if (node.type === 'TemplateElement') { wordsOf(node.value.cooked || node.value.raw || '', out); return; }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, node, k, out));
      else if (v && typeof v.type === 'string') walk(v, node, k, out);
    }
  }
  for (const st of stmts) walk(st.node, null, null, st.refs);

  // Roots: what runs at load, and what the page's own markup and other scripts name.
  const outside = html.slice(0, open) + html.slice(close);
  const roots = new Set();
  for (const m of outside.matchAll(/\son[a-z]+="([^"]*)"/g)) wordsOf(m[1], roots);
  // Handlers live in data-on-<event> attributes since 2026-09-27 (the CSP allows no inline script):
  // JSON naming a global function - a word like any other to this walk.
  for (const m of outside.matchAll(/\sdata-on-[a-z]+=(?:"([^"]*)"|'([^']*)')/g)) wordsOf(m[1] ?? m[2], roots);
  for (const m of outside.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) wordsOf(m[1], roots);
  const bootStmts = stmts.filter((st) => st.node.type !== 'FunctionDeclaration'
    && !(st.node.type === 'VariableDeclaration' && st.node.declarations.every((d) => !d.init || PURE.has(d.init.type))));

  const cut = new Set(STAFF_ENTRY);
  const reached = new Set(); const queue = [];
  const reach = (n) => { if (cut.has(n) || !decl.has(n)) return; const st = decl.get(n); if (!reached.has(st)) { reached.add(st); queue.push(st); } };
  for (const st of bootStmts) { reached.add(st); queue.push(st); }
  roots.forEach(reach);
  while (queue.length) { const st = queue.pop(); for (const r of st.refs) reach(r); }

  const customer = stmts.filter((st) => reached.has(st));
  const staff = stmts.filter((st) => !reached.has(st));
  const customerNames = new Set(customer.flatMap((st) => st.names));
  const staffNames = new Set(staff.flatMap((st) => st.names));
  const bridges = new Set();
  for (const st of customer) for (const r of st.refs) if (staffNames.has(r) && !customerNames.has(r)) bridges.add(r);
  for (const r of roots) if (staffNames.has(r) && !customerNames.has(r)) bridges.add(r);
  const notEntry = [...bridges].filter((b) => !cut.has(b));
  if (notEntry.length) throw new Error(`split-staff: customer code reaches staff code through ${notEntry.join(', ')} - add to STAFF_ENTRY (an effect-only function) or move the reference`);
  const stubbed = STAFF_ENTRY.filter((n) => staffNames.has(n));
  // Every entry point, stubbed or not: one that stays in the customer half today may move
  // tomorrow, and only a plain function declaration can be replaced when staff.js loads.
  const missing = STAFF_ENTRY.filter((n) => !decl.has(n));
  if (missing.length) throw new Error(`split-staff: STAFF_ENTRY names ${missing.join(', ')} do not exist`);
  const notFn = STAFF_ENTRY.filter((n) => decl.get(n).node.type !== 'FunctionDeclaration');
  if (notFn.length) throw new Error(`split-staff: ${notFn.join(', ')} must be plain function declarations to be entry points`);

  const text = (arr) => arr.map((st) => code.slice(st.node.start, st.node.end)).join('\n');
  const stubs = stubbed.map((n) => ALWAYS_LOAD.has(n)
    ? `function ${n}(...a){return _loadStaff().then(()=>${n}(...a));}`
    : `function ${n}(...a){if(_staffWanted())return _loadStaff().then(()=>${n}(...a));}`).join('\n');
  const loader = `
// ── The staff half of the app (generated by scripts/split-staff.mjs; do not edit here) ─────────
// Everything only staff reach lives in ${staffUrl.replace(/\?.*$/, '')}, fetched when a staffer enters and cached
// like any versioned file. The names below stand in for it until then: the real declarations
// replace them when the file has loaded. This block leads the script because the boot, further
// down, awaits _loadStaff before the script has finished running.
// Three things come down side by side (2026-10-01): the code, the whole stylesheet (the customer
// page links app.css, styles.css less every rule only staff screens can match; the staff screens
// get the file they were written against, and app.css is switched off under it), and the staff
// strings of the language on screen (lang/staff-<code>.json into LANG_STAFF; English ships inside
// staff.js). Each is kept once it has arrived, so a retry never runs staff.js a second time.
var _staffP=null,_staffJsP=null,_staffCssP=null;
var STAFF_JS=${JSON.stringify(staffUrl)}; // var, and this block leads the script: the boot calls _loadStaff before the script has finished running
var STAFF_CSS=${JSON.stringify(staffCssUrl || '')};
var STAFF_LANG_V={}; // the build stamps {code:contentHash} of lang/staff-<code>.json
var LANG_STAFF={},_staffLangP={};
// The stored marks and the address first, S.view last: this runs at the top of the script too
// (the early load below), before S exists, and the try answers false only when nothing else did.
function _staffWanted(){try{if(localStorage.getItem('cq_staff')==='1'||sessionStorage.getItem('cq_staff_entry')==='1'||_isStaffHost())return true;const q=new URLSearchParams(location.search);if(q.has('staff')||q.has('bike'))return true;const p=_parsePath(location.pathname);if(p&&p.view==='staff')return true;return S.view==='staff';}catch(e){return false;}}
// A script that neither loads nor errors (a proxy that swallows it, a tab frozen mid-download)
// used to hold the boot forever: after 30 s the promise rejects and a later call may try again.
function _loadStaffJs(){
  if(_staffJsP)return _staffJsP;
  _staffJsP=new Promise((res,rej)=>{
    const s=document.createElement('script');let done=false;
    const fail=why=>{if(done)return;done=true;_staffJsP=null;try{s.remove();}catch(e){}rej(new Error(why));};
    const tm=setTimeout(()=>fail('staff.js did not load in 30 s'),30000);
    s.src=STAFF_JS;s.onload=()=>{if(done)return;done=true;clearTimeout(tm);res();};s.onerror=()=>{clearTimeout(tm);fail('staff.js did not load');};
    document.head.appendChild(s);
  });
  return _staffJsP;
}
function _loadStaffCss(){
  if(_staffCssP)return _staffCssP;
  if(!STAFF_CSS)return(_staffCssP=Promise.resolve());
  _staffCssP=new Promise((res,rej)=>{
    const l=document.createElement('link');let done=false;
    const fail=why=>{if(done)return;done=true;_staffCssP=null;try{l.remove();}catch(e){}rej(new Error(why));};
    const tm=setTimeout(()=>fail('styles.css did not load in 30 s'),30000);
    l.rel='stylesheet';l.href=STAFF_CSS;l.setAttribute('data-staff-css','');
    // styles.css holds every rule app.css does, in the same order: switching app.css off leaves the
    // cascade exactly as it was when one file served both, and spares matching each rule twice.
    l.onload=()=>{if(done)return;done=true;clearTimeout(tm);try{document.querySelectorAll('link[rel="stylesheet"][href^="/app.css"]').forEach(c=>{c.disabled=true;});}catch(e){}res();};
    l.onerror=()=>{clearTimeout(tm);fail('styles.css did not load');};
    document.head.appendChild(l);
  });
  return _staffCssP;
}
// The language on screen: S when it exists, else what the head's early script chose (S is still in
// its temporal dead zone at the top of the script, where typeof throws too - hence the try).
function _staffLangCode(){try{if(S&&S.lang)return S.lang;}catch(e){}return window.__langPackCode||'en';}
function _staffLangReady(c){return !c||c==='en'||!STAFF_LANG_V[c]||!!LANG_STAFF[c];}
// Never rejects: a pack that did not arrive leaves t() answering in English, as the customer packs do.
function _loadStaffLang(c){
  if(_staffLangReady(c))return Promise.resolve();
  if(!_staffLangP[c])_staffLangP[c]=fetch('/lang/staff-'+c+'.json?v='+STAFF_LANG_V[c]).then(r=>r.ok?r.json():null).then(d=>{if(d&&typeof d==='object')LANG_STAFF[c]=d;else delete _staffLangP[c];}).catch(()=>{delete _staffLangP[c];});
  return _staffLangP[c];
}
function _loadStaff(){
  if(_staffP)return _staffP;
  // window.__staffPartsNow (set by the test suite's stubs): the staff half's parts come before the
  // promise resolves, so a spec may call a section's functions at once. Anywhere else they follow the
  // desk's first paint on their own (splitSections).
  _staffP=Promise.all([_loadStaffJs(),_loadStaffCss(),_loadStaffLang(_staffLangCode())]).then(()=>{if(window.__staffPartsNow&&typeof _loadStaffParts==='function')return _loadStaffParts();},e=>{_staffP=null;throw e;});
  return _staffP;
}
// A staff device starts the download here, at the top of the script, instead of after the whole
// customer half has parsed and run to the boot: the files come down side by side.
try{if(_staffWanted())_loadStaff().catch(()=>{});}catch(e){}
${stubs}
`;
  const customerCode = loader + '\n' + text(customer); // the loader first: the boot, further down, awaits it before the script has finished
  const staffCode = '// The staff half of the booking app: generated by scripts/split-staff.mjs from app.src.html, never edited by hand.\n' + text(staff) + '\n';
  return {
    html: html.slice(0, open) + '\n' + customerCode + '\n' + html.slice(close), // the </script> alone on its line again: mainScript finds it (build-html moves it to app.js)
    staff: staffCode,
    report: { customerBytes: customerCode.length, staffBytes: staffCode.length, customerStmts: customer.length, staffStmts: staff.length, stubs: stubbed },
  };
}

// ── Which translation keys a customer's page needs (2026-10-01) ────────────────────────────────
// Two thirds of LANG's ~3,100 keys are words only the staff screens say, and every rider downloaded
// them: in the inline English and again in each language pack. A key goes to the staff half only
// when staff code names it and nothing on the customer's page can: the customer page names it
// nowhere as a word, and no key the page builds at run time can be it - a plural form (base_one,
// base_other: _tn), a literal prefix the page concatenates ('heard_'+x, \`rateTag\${x}\`) or a
// literal suffix it appends to a word it does name (n[2]+'D'). A key no code names at all stays
// with the customer: nothing proves it is staff's. Too little moved is a few bytes; too much is a
// raw key on a rider's screen.
export const PLURAL_RE = /^(.+)_(?:zero|one|two|few|many|other)$/;
const IDENT_WORD = /[A-Za-z_$][\w$]*/g;
export function langKeyParts(text) {
  const words = new Set(text.match(IDENT_WORD) || []);
  const prefixes = new Set(), suffixes = new Set();
  for (const m of text.matchAll(/(['"`])([A-Za-z_$][\w$]*)\1\s*\+/g)) prefixes.add(m[2]);
  for (const m of text.matchAll(/`([A-Za-z_$][\w$]*)\$\{/g)) prefixes.add(m[1]);
  for (const m of text.matchAll(/\+\s*(['"`])([A-Za-z_$][\w$]*)\1/g)) suffixes.add(m[2]);
  for (const m of text.matchAll(/\}([A-Za-z_$][\w$]*)`/g)) suffixes.add(m[1]);
  return { words, prefixes: [...prefixes], suffixes: [...suffixes] };
}
/** Could the page whose text gave `parts` ask for `key`? */
export function namesKey(parts, key) {
  if (parts.words.has(key)) return true;
  const pl = key.match(PLURAL_RE);
  if (pl && parts.words.has(pl[1])) return true;
  if (parts.prefixes.some((p) => key.length > p.length && key.startsWith(p))) return true;
  if (parts.suffixes.some((x) => key.length > x.length && key.endsWith(x) && parts.words.has(key.slice(0, -x.length)))) return true;
  return false;
}
/**
 * @param keys every key of LANG (English's are the full set)
 * @param customerText the customer's page as it ships, the LANG object itself left out
 * @param staffText the staff half's code
 * @returns {Set<string>} the keys that go to the staff half
 */
export function staffOnlyLangKeys(keys, customerText, staffText) {
  const cust = langKeyParts(customerText), staff = langKeyParts(staffText);
  const out = new Set();
  for (const k of keys) if (!namesKey(cust, k) && namesKey(staff, k)) out.add(k);
  return out;
}

// ── The customer's stylesheet (2026-10-01) ─────────────────────────────────────────────────────
// styles.css serves both halves, and it blocks a rider's first paint: about half of it is the staff
// screens'. app.css is styles.css less every rule no customer page can match - a rule goes when each
// of its selectors needs an element carrying a class or id that staff code writes and the customer's
// page never does (not as a word anywhere on it, not through a prefix or suffix it concatenates).
// Tokens under :not()/:is()/:where() and inside [attribute] brackets do not count: they do not make
// an element necessary. Everything else keeps its place, so the order of what stays is the order
// of styles.css, and a staff device loads the whole styles.css over it (see the loader above).

/** Top-level CSS tokens: rules, at-rules (with their body, or none), comments and whitespace. Joined, they give the input back. */
export function cssTokens(s) {
  const out = []; let i = 0;
  const skipComment = (j) => { const e = s.indexOf('*/', j + 2); return e < 0 ? s.length : e + 2; };
  while (i < s.length) {
    const st = i;
    if (/\s/.test(s[i])) { while (i < s.length && /\s/.test(s[i])) i++; out.push({ kind: 'ws', text: s.slice(st, i) }); continue; }
    if (s.startsWith('/*', i)) { i = skipComment(i); out.push({ kind: 'comment', text: s.slice(st, i) }); continue; }
    let q = null;
    while (i < s.length) {
      const c = s[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; i++; continue; }
      if (c === '"' || c === "'") { q = c; i++; continue; }
      if (s.startsWith('/*', i)) { i = skipComment(i); continue; }
      if (c === '{' || c === ';' || c === '}') break;
      i++;
    }
    if (i >= s.length || s[i] === '}') { if (s[i] === '}') i++; out.push({ kind: 'junk', text: s.slice(st, i) }); continue; }
    if (s[i] === ';') { i++; out.push({ kind: 'at', text: s.slice(st, i), prelude: s.slice(st, i - 1).trim(), body: null }); continue; }
    const prelude = s.slice(st, i).trim(); const bodyStart = i + 1; let d = 0; q = null;
    for (; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (s.startsWith('/*', i)) { i = skipComment(i) - 1; continue; }
      if (c === '{') d++;
      else if (c === '}' && --d === 0) { i++; break; }
    }
    out.push({ kind: prelude.startsWith('@') ? 'at' : 'rule', text: s.slice(st, i), prelude, body: s.slice(bodyStart, i - 1), open: s.slice(st, bodyStart) });
  }
  return out;
}
/** A selector list's selectors (commas inside brackets or parentheses do not split). */
export function splitSelectors(p) {
  const r = []; let d = 0, cur = '';
  for (const c of p.replace(/\/\*[\s\S]*?\*\//g, '')) { if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--; if (c === ',' && !d) { r.push(cur.trim()); cur = ''; } else cur += c; }
  r.push(cur.trim());
  return r;
}
/** The classes and ids an element must carry for `sel` to match (brackets and :not/:is/:where left out). */
export function requiredNames(sel) {
  let s = sel.replace(/\[[^\]]*\]/g, '');
  for (let k = 0; k < 20 && /:(?:not|is|where|matches|-webkit-any)\(/.test(s); k++) s = s.replace(/:(?:not|is|where|matches|-webkit-any)\((?:[^()]|\([^()]*\))*\)/g, '');
  return [...s.matchAll(/[.#](-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]);
}
// A class prefix is one that ends in a dash or underscore (c-, cu-g-) or runs four letters or more:
// shorter ones are the minified page's own variable names in front of a template's \${ (f\${, d\${).
const classPrefix = (p) => /[-_]$/.test(p) ? p.length >= 2 : p.length >= 4;
function classParts(text) {
  const words = new Set(text.match(/-?[A-Za-z_][\w-]*/g) || []);
  const prefixes = new Set(), suffixes = new Set();
  for (const m of text.matchAll(/(-?[A-Za-z_][\w-]*)\$\{/g)) if (classPrefix(m[1])) prefixes.add(m[1]); // `bdg-m c-${colour}`
  for (const m of text.matchAll(/(-?[A-Za-z_][\w-]*)(['"`])\s*\+/g)) if (classPrefix(m[1])) prefixes.add(m[1]); // 'cu-g-'+g
  for (const m of text.matchAll(/\}(-?[\w-]+)/g)) suffixes.add(m[1]); // `${state}-chip`
  for (const m of text.matchAll(/\+\s*(['"`])(-?[\w-]+)/g)) suffixes.add(m[2]); // x+'-chip'
  return { words, prefixes: [...prefixes], suffixes: [...suffixes] };
}
function classOnPage(parts, n) {
  if (parts.words.has(n)) return true;
  if (parts.prefixes.some((p) => n.length > p.length && n.startsWith(p))) return true;
  if (parts.suffixes.some((x) => n.length > x.length && n.endsWith(x) && parts.words.has(n.slice(0, -x.length)))) return true;
  return false;
}
/**
 * @param css styles.css as written
 * @param customerText everything a customer's page carries (index.html and app.js)
 * @param staffText staff.js
 * @param scope classes to treat as staff-only however the page names them (STAFF_SCOPE)
 * @returns {{ css: string, kept: number, dropped: number, droppedBytes: number, droppedSelectors: string[] }}
 */
// Classes the customer's page does write, but only once staff.js and styles.css are there: showView
// puts view-staff on <body> in the staff view, which is entered through goStaff (staff code) or by
// the boot after it has awaited _loadStaff.
export const STAFF_SCOPE = new Set(['view-staff']);
export function customerCss(css, customerText, staffText, scope = STAFF_SCOPE) {
  const cust = classParts(customerText), staffWords = new Set(staffText.match(/-?[A-Za-z_][\w-]*/g) || []);
  const staffOnly = (n) => scope.has(n) || (staffWords.has(n) && !classOnPage(cust, n));
  const staffSel = (sel) => requiredNames(sel).some(staffOnly);
  let kept = 0, dropped = 0, droppedBytes = 0;
  const droppedSelectors = [];
  const GROUP = /^@(?:media|supports|layer|container|document)\b/i;
  function filter(text) {
    let out = '';
    for (const t of cssTokens(text)) {
      if (t.kind === 'rule') {
        const sels = splitSelectors(t.prelude);
        if (sels.every(staffSel)) { dropped++; droppedBytes += t.text.length; droppedSelectors.push(...sels); continue; }
        kept++; out += t.text;
      } else if (t.kind === 'at' && t.body !== null && GROUP.test(t.prelude)) {
        const inner = filter(t.body);
        if (!inner.trim() || /^\s*(?:\/\*[\s\S]*?\*\/\s*)*$/.test(inner)) continue; // nothing left inside
        out += t.open + inner + '}';
      } else out += t.text;
    }
    return out;
  }
  return { css: filter(css), kept, dropped, droppedBytes, droppedSelectors };
}

// ── The staff half in parts (2026-10-01) ────────────────────────────────────────────────────────
// A booth tablet parsed all of staff.js (297 KB gzipped) before it could draw the Bookings screen,
// though about half of it is sections the desk does not open at boot: Analytics, Community, the
// inventory and the bikes, the till, the website editor... Each section's renderer is cut here the
// way the customer half is cut from the staff half: what is reachable from it and from nothing else
// goes to staff-parts/<name>.js, and staff.js keeps a stand-in that fetches the part and runs the
// real function. A statement two parts share goes back to staff.js (and with it, until nothing
// changes, whatever it reaches), so staff.js never calls into a part except through a stand-in.
// Every part is fetched as soon as the desk has painted, so a section is there before it is opened.
// Customers (its own section since 2026-10-07) is drawn by Community's code, so both are one part. _bdgStrips (2026-10-09):
// an account's badges in the history window and the editor, which are core, drawn by the badges code Community holds.
export const STAFF_PARTS = {
  analytics: ['renderAnalytics'], community: ['renderCommunity', 'renderCustomers', '_ahActShow', '_bdgStrips'], bikes: ['renderBikes'], cashier: ['renderCashier', '_eonOpen'],
  catalog: ['renderCatalog'], inventory: ['renderInventory', '_invMove', '_invSetCount'], website: ['renderWebsite'], history: ['renderHistory'],
  workshop: ['renderWorkshop'], ambassadors: ['renderAmbassadors'], messages: ['renderMessages'],
  vendors: ['renderVendors'], // 2026-10-03: Vendors, admins only
  sela: ['printSelaReport', 'exportSelaXlsx'], // 2026-10-08: Run for Her's report for Sela (print + .xlsx), read at each tap
  // _ahActShow (community): a customer's own activity in their profile; imports: partner companies' employee lists (2026-10-09)
  imports: ['openRosterImport'],
  team: ['renderTeam'], settings: ['renderSettings'], // 2026-10-02: the account's Settings page, and Team with it, out of the desk's core
  // 2026-10-09: the fleet's condition (the check after a return, incidents, the maintenance log and its report)
  fleet: ['_bpFleetFill', '_fleetAfterReturn', '_bkCheckClear', '_fleetReport', '_retPhotoPick'],
  // 2026-10-09: the audit trail, void/refund reasons, the till, the exceptions and Team reports
  // (with the Action Log, which shares the account names and the record links with them)
  money: ['renderMoneyView', 'openAuditPanel', 'recordDrawerCount', 'renderTeamReport', '_askMoneyReason', 'renderLogs'],
  // 2026-10-09 (round 2): the desk note's editor, My shift, joining and leaving a party
  desk: ['_deskNoteEdit', '_myShiftOpen', '_partyJoin', '_partyLeave'],
  // 2026-10-10: the desk outbox's store (IndexedDB), its replay and the unsynced list (the list, the overlay and the chip stay in the core)
  deskq: ['_dqEnqueue', '_dqFlush', '_dqBoot', '_dqOpen'],
};
function refsOf(code) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  const decl = new Map(); const stmts = [];
  ast.body.forEach((node, idx) => {
    let names = [];
    if (node.type === 'FunctionDeclaration') names = [node.id.name];
    else if (node.type === 'VariableDeclaration') names = node.declarations.flatMap((d) => (d.id.type === 'Identifier' ? [d.id.name] : []));
    const st = { idx, node, names, refs: new Set() };
    stmts.push(st); for (const n of names) decl.set(n, st);
  });
  const top = new Set(decl.keys());
  const words = (t, out) => { for (const w of t.match(WORD) || []) if (top.has(w)) out.add(w); };
  function walk(node, parent, key, out) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier') {
      const isProp = parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) || (parent.type === 'MethodDefinition' && key === 'key'));
      if (!isProp && top.has(node.name)) out.add(node.name);
      return;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') { words(node.value, out); return; }
    if (node.type === 'TemplateElement') { words(node.value.cooked || node.value.raw || '', out); return; }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, node, k, out));
      else if (v && typeof v.type === 'string') walk(v, node, k, out);
    }
  }
  for (const st of stmts) walk(st.node, null, null, st.refs);
  return { stmts, decl };
}
/**
 * @param code the staff half's source (before minifying)
 * @returns {{ core: string, parts: Record<string,string>, report: Record<string, number> }}
 */
export function splitSections(code, parts = STAFF_PARTS, roots = STAFF_ENTRY) {
  const { stmts, decl } = refsOf(code);
  const entries = new Map();
  for (const [p, fns] of Object.entries(parts)) for (const f of fns) {
    const st = decl.get(f);
    if (!st) throw new Error(`split-staff: staff part ${p} names ${f}, which is not in the staff half`);
    if (st.node.type !== 'FunctionDeclaration') throw new Error(`split-staff: ${f} must be a plain function declaration to start a staff part`);
    entries.set(f, p);
  }
  const reach = (from, core, cut) => {
    const seen = new Set(); const q = [];
    const add = (n) => { if (cut.has(n)) return; const st = decl.get(n); if (st && !seen.has(st) && !(core && core.has(st))) { seen.add(st); q.push(st); } };
    from.forEach(add);
    while (q.length) { const st = q.pop(); for (const r of st.refs) add(r); }
    return seen;
  };
  const boot = stmts.filter((st) => st.node.type !== 'FunctionDeclaration'
    && !(st.node.type === 'VariableDeclaration' && st.node.declarations.every((d) => !d.init || PURE.has(d.init.type))));
  const allEntries = new Set(entries.keys());
  // What the desk reaches without opening a section: the ways in from the customer half (less the
  // sections' own renderers) and every statement that runs when the file loads.
  let coreRoots = [...roots.filter((n) => decl.has(n) && !allEntries.has(n)), ...boot.flatMap((st) => st.names)];
  let core = reach(coreRoots, null, allEntries);
  boot.forEach((st) => core.add(st));
  let own = {};
  for (let round = 0; round < 50; round++) {
    own = {};
    const count = new Map();
    for (const [p, fns] of Object.entries(parts)) {
      own[p] = reach(fns, core, new Set([...allEntries].filter((f) => entries.get(f) !== p)));
      for (const st of own[p]) count.set(st, (count.get(st) || 0) + 1);
    }
    const shared = [...count].filter(([, c]) => c > 1).map(([st]) => st);
    if (!shared.length) break;
    // shared statements join the core, with everything they reach that is not a section's way in
    const more = reach(shared.flatMap((st) => st.names), core, allEntries);
    shared.forEach((st) => core.add(st)); more.forEach((st) => core.add(st));
  }
  const inPart = new Map();
  for (const [p, set] of Object.entries(own)) for (const st of set) inPart.set(st, p);
  const text = (arr) => arr.map((st) => code.slice(st.node.start, st.node.end)).join('\n');
  const stubs = [...entries].map(([f, p]) => `function ${f}(...a){return _loadStaffPart(${JSON.stringify(p)}).then(()=>${f}(...a));}`).join('\n');
  const loader = `
// ── The staff half's parts (generated by scripts/split-staff.mjs; do not edit here) ──────────────
// A section's code is in staff-parts/<name>.js; the stand-ins below fetch it and run the real function,
// whose declaration replaces the stand-in. Every part is fetched once the desk has painted.
var STAFF_PARTS_V={}; // the build stamps {name:contentHash}
var _staffPartP={},_staffPartsAll=null,_staffPartsDone=false;
function _loadStaffPart(n){
  if(_staffPartP[n])return _staffPartP[n];
  _staffPartP[n]=new Promise((res,rej)=>{
    const s=document.createElement('script');let done=false;
    const fail=why=>{if(done)return;done=true;delete _staffPartP[n];try{s.remove();}catch(e){}rej(new Error(why));};
    const tm=setTimeout(()=>fail('staff part '+n+' did not load in 30 s'),30000);
    s.src='/staff-parts/'+n+'.js?v='+STAFF_PARTS_V[n];s.onload=()=>{if(done)return;done=true;clearTimeout(tm);res();};s.onerror=()=>{clearTimeout(tm);fail('staff part '+n+' did not load');};
    document.head.appendChild(s);
  });
  return _staffPartP[n];
}
function _loadStaffParts(){
  if(_staffPartsAll)return _staffPartsAll;
  _staffPartsAll=Promise.all(Object.keys(STAFF_PARTS_V).map(_loadStaffPart)).then(()=>{_staffPartsDone=true;},e=>{_staffPartsAll=null;throw e;});
  return _staffPartsAll;
}
function _staffPartsReady(){return _staffPartsDone;}
try{(window.requestIdleCallback||(f=>setTimeout(f,1200)))(()=>{_loadStaffParts().catch(()=>{});},{timeout:3000});}catch(e){}
${stubs}
`;
  const coreStmts = stmts.filter((st) => !inPart.has(st));
  const head = code.match(/^(\/\/[^\n]*\n)?/)[0];
  const out = { core: head + loader + '\n' + text(coreStmts) + '\n', parts: {}, report: { core: coreStmts.length } };
  for (const p of Object.keys(parts)) {
    const list = stmts.filter((st) => inPart.get(st) === p);
    out.parts[p] = `// A part of the staff half (${p}): generated by scripts/split-staff.mjs from app.src.html, never edited by hand.\n` + text(list) + '\n';
    out.report[p] = list.length;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Shared helpers: the source as the build sees it
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const INCLUDE_RE = /<!--\s*include:\s*([^\s]+?)\s*-->/g;

/**
 * Inlines the `<!--include:path-->` markers (paths relative to the repo root). Inlining, not ES
 * importing, keeps the app's single global scope, so handlers named by string keep working.
 */
export async function resolveIncludes(text, root = new URL('../', import.meta.url)) {
  const parts = [];
  let last = 0, m;
  const re = new RegExp(INCLUDE_RE.source, 'g');
  while ((m = re.exec(text))) {
    parts.push(text.slice(last, m.index));
    const body = await readFile(new URL(m[1], root), 'utf8');
    parts.push(body.replace(/^\s*\/\/\s*@ts-check\s*$/m, '')); // strip the dev-only type-check pragma
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.join('');
}

/** The files the `<!--include:path-->` markers pull in (paths relative to the repo root), in order. */
export function includedFiles(text) {
  return [...text.matchAll(new RegExp(INCLUDE_RE.source, 'g'))].map((m) => m[1]);
}

/** Blanks the include markers instead, so the raw source parses and keeps its own line numbers. */
export function stripIncludes(text) {
  return text.replace(new RegExp(INCLUDE_RE.source, 'g'), '');
}

/** The app's main script: the one after the supabase-js tag, closed by a </script> alone on its line. */
export function mainScript(html) {
  const tag = html.indexOf('<script defer src="/vendor/supabase-js');
  const open = html.indexOf('<script>', tag) + '<script>'.length;
  const close = html.indexOf('\n</script>', open) + 1;
  if (tag < 0 || open < '<script>'.length || close < 1) throw new Error('split-staff: the main script was not found');
  return { code: html.slice(open, close), open, close };
}

const SCRIPT_RE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
const NOT_JS_TYPE = /\btype\s*=\s*["']?(?!(?:text\/javascript|module)["'\s>])/i;

/** Every inline <script> that is code (not JSON-LD or a data block), with its offset in the page. */
export function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    if (NOT_JS_TYPE.test(m[1])) continue;
    out.push({ attrs: m[1], code: m[2], start: m.index + m[0].indexOf('>') + 1 });
  }
  return out;
}

/** Parses every inline script once: the AST, the comments, and the document offset of each. */
function parsedScripts(html) {
  return inlineScripts(html).map((s) => {
    const comments = [];
    let ast;
    try {
      ast = acorn.parse(s.code, { ecmaVersion: 'latest', sourceType: 'script', onComment: comments });
    } catch (e) {
      const line = html.slice(0, s.start).split('\n').length;
      throw new Error(`inline <script> at line ${line} does not parse: ${e.message}`);
    }
    return { ...s, ast, comments };
  });
}

/** Names the dispatcher can reach as window[name]: top-level `function name(` declarations of every inline script. */
export function globalFunctionNames(html) {
  const names = new Set();
  for (const s of parsedScripts(html)) for (const n of s.ast.body) if (n.type === 'FunctionDeclaration') names.add(n.id.name);
  return names;
}

/** pos -> 1-based line number, in O(log n) after one pass. */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/** The line a position sits on, trimmed to fit a report. */
function lineText(text, pos, max = 120) {
  const a = text.lastIndexOf('\n', pos - 1) + 1;
  let b = text.indexOf('\n', pos);
  if (b < 0) b = text.length;
  const s = text.slice(a, b).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Comment ranges of the whole page: JS comments (from acorn) in every inline script, HTML comments outside them. */
function commentRanges(html, scripts) {
  const ranges = [];
  for (const s of scripts) for (const c of s.comments) ranges.push([s.start + c.start, s.start + c.end]);
  const inScript = (pos) => scripts.some((s) => pos >= s.start && pos < s.start + s.code.length);
  for (const m of html.matchAll(/<!--[\s\S]*?-->/g)) if (!inScript(m.index)) ranges.push([m.index, m.index + m[0].length]);
  ranges.sort((a, b) => a[0] - b[0]);
  return (pos) => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid][1] <= pos) lo = mid + 1;
      else if (ranges[mid][0] > pos) hi = mid - 1;
      else return true;
    }
    return false;
  };
}

/** The text between the ( at `open` and its matching ), minding strings, template literals and comments; null when unbalanced. */
export function balancedArgs(text, open) {
  const stack = ['p'];
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i], top = stack[stack.length - 1];
    if (top === 't') {
      if (c === '\\') { i++; continue; }
      if (c === '`') { stack.pop(); continue; }
      if (c === '$' && text[i + 1] === '{') { stack.push('e'); i++; }
      continue;
    }
    if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) { if (text[i] === '\\') i++; else if (text[i] === '\n') return null; }
      continue;
    }
    if (c === '`') { stack.push('t'); continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) return null; i = e + 1; continue; }
    if (c === '(') stack.push('p');
    else if (c === '[') stack.push('b');
    else if (c === '{') stack.push('c');
    else if (c === ')' || c === ']' || c === '}') {
      if (top === 'e' && c === '}') { stack.pop(); continue; }
      if (top !== (c === ')' ? 'p' : c === ']' ? 'b' : 'c')) return null;
      stack.pop();
      if (!stack.length) return text.slice(open + 1, i);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Check 1: every handler names a global function
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Markup says what an event does in a data-on-<event> attribute holding JSON, ["name", ...args],
// and _onDispatch looks the name up as window[name] at the time of the event. A misspelt name is
// therefore not a build error and not a ReferenceError at load: it is a console warning when a
// staffer taps the button, and nothing happens. This reads every static attribute, every
// _on('name', ...) / _on("name", ...) call (the first argument may be a ternary of literals; a
// variable or spread is dynamic and left alone) and every ['name', ...] in an _on([...],[...]) list,
// and refuses a name that is not a top-level `function name(` declaration of an inline script.

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The names a handler expression can resolve to: a literal, or the branches of a ternary of literals. Anything else is dynamic (empty). */
function literalNames(node) {
  if (!node) return [];
  if (node.type === 'Literal' && typeof node.value === 'string') return [node.value];
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return [node.quasis[0].value.cooked];
  if (node.type === 'ConditionalExpression') return [...literalNames(node.consequent), ...literalNames(node.alternate)];
  if (node.type === 'LogicalExpression') return [...literalNames(node.left), ...literalNames(node.right)];
  return [];
}

/** The event types the dispatcher listens for (`const _ON_TYPES=[...]` in the source), or null when the list is not found. */
function dispatchedEvents(html) {
  const m = html.match(/const _ON_TYPES=(\[[^\]]*\]);/);
  if (!m) return null;
  try { return new Set(new Function(`return ${m[1]};`)()); } catch { return null; }
}

/**
 * @param rawHtml the source as written (line numbers are reported against it)
 * @param resolvedHtml the source with includes inlined (where the declarations are read); defaults to rawHtml
 * @returns {{ offenders: {name:string,line:number,how:string,why:string,text:string}[], checked: number, dynamic: number, declared: number }}
 */
export function checkHandlerNames(rawHtml, resolvedHtml = rawHtml) {
  const declared = globalFunctionNames(resolvedHtml);
  const html = stripIncludes(rawHtml);
  const scripts = parsedScripts(html);
  const inComment = commentRanges(html, scripts);
  const lineOf = lineIndex(html);
  const events = dispatchedEvents(html);
  const offenders = [];
  let checked = 0, dynamic = 0;
  const check = (name, pos, how) => {
    checked++;
    const why = typeof name !== 'string' ? 'the handler is not a string' : !IDENT.test(name) ? 'not a function name' : !declared.has(name) ? 'no top-level function of that name' : null;
    if (why) offenders.push({ name: String(name), line: lineOf(pos), how, why, text: lineText(html, pos) });
  };

  // _on(...) calls, wherever they are written (mostly inside template literals).
  for (const m of html.matchAll(/\b_on\(/g)) {
    if (inComment(m.index) || html.slice(m.index - 9, m.index) === 'function ') continue; // a comment, or its own declaration
    let expr;
    try { expr = acorn.parseExpressionAt(html, m.index, { ecmaVersion: 'latest' }); } catch { expr = null; }
    // The call may be the left side of a longer expression ('...'+_on(...)+'...'): find it.
    let call = null;
    (function find(n) {
      if (!n || call || typeof n.type !== 'string') return;
      if (n.type === 'CallExpression' && n.start === m.index && n.callee.type === 'Identifier' && n.callee.name === '_on') { call = n; return; }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (Array.isArray(v)) v.forEach(find); else if (v && typeof v.type === 'string') find(v);
      }
    })(expr);
    if (!call) {
      offenders.push({ name: '?', line: lineOf(m.index), how: '_on(...)', why: 'the call could not be read', text: lineText(html, m.index) });
      continue;
    }
    const args = call.arguments;
    if (!args.length) continue; // _on() with nothing: writes "[]", a no-op
    if (args[0].type === 'ArrayExpression') {
      // _on(['a', 1], ['b']): several calls in a row, each list's first element is a name.
      for (const a of args) {
        if (a.type !== 'ArrayExpression' || !a.elements.length) { dynamic++; continue; }
        const names = literalNames(a.elements[0]);
        if (!names.length) { dynamic++; continue; }
        for (const n of names) check(n, a.start, "_on(['name', ...], ...)");
      }
      continue;
    }
    const names = literalNames(args[0]);
    if (!names.length) { dynamic++; continue; }
    for (const n of names) check(n, call.start, "_on('name', ...)");
    // _on('_on_backdropOnly', _EV, _EL, 'closeX'): the fourth argument names the function that closes.
    if (names.length === 1 && names[0] === '_on_backdropOnly' && args[3]) for (const n of literalNames(args[3])) check(n, args[3].start, "_on('_on_backdropOnly', _EV, _EL, 'name')");
  }

  // Static attributes: the JSON as written, in a single-quoted (or double-quoted) attribute.
  for (const m of html.matchAll(/\sdata-on-([a-z]+)=(?:'([^']*)'|"([^"]*)")/g)) {
    if (inComment(m.index)) continue;
    const pos = m.index + 1;
    if (events && !events.has(m[1])) offenders.push({ name: m[1], line: lineOf(pos), how: `data-on-${m[1]}`, why: 'no document listener for this event type (_ON_TYPES)', text: lineText(html, pos) });
    const v = m[2] ?? m[3];
    if (v.includes('${') || v.includes('_on(')) continue; // written by a template or by concatenation: its _on(...) call is checked above
    let steps;
    try { steps = JSON.parse(v); } catch { steps = undefined; }
    if (!Array.isArray(steps) || !steps.length) {
      offenders.push({ name: v.slice(0, 40), line: lineOf(pos), how: `data-on-${m[1]}='...'`, why: 'not a JSON list ["name", ...args]', text: lineText(html, pos) });
      continue;
    }
    for (const st of Array.isArray(steps[0]) ? steps : [steps]) check(Array.isArray(st) ? st[0] : st, pos, `data-on-${m[1]}='["name", ...]'`);
  }
  return { offenders, checked, dynamic, declared: declared.size };
}

/** One line per offender, for the build's error message. */
export function formatHandlerOffenders(result) {
  return result.offenders.map((o) => `  app.src.html:${o.line}  ${o.how}  "${o.name}" - ${o.why}\n      ${o.text}`).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Check 2: a refused write is said, never swallowed
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// supabase-js answers {error}; it does not throw. A write whose result nobody reads is a Saved
// toast over a failed save. The rule (AGENTS.md): every sb.from('<table>').insert|update|delete|
// upsert(...) goes through `await _wr(promise, ctx)` or hands its result to `_writeErr(res, ctx)`.
// Only logging (staff_actions, error_log) is exempt by table; anything else that is deliberately
// unchecked - a rollback compensation, a best-effort touch - carries the marker comment
// `// fire-and-forget` on the line of the write (or on the first line of its statement).
//
// This is a WARNING for now, not a failure: the 2026-09-27 review left a tail of writes that read
// `.error` themselves or return the write to a caller that checks it, and those are reported apart
// so the list can be worked down.

export const WRITE_OPS = new Set(['insert', 'update', 'delete', 'upsert']);
export const LOG_TABLES = new Set(['staff_actions', 'error_log']);
export const FIRE_AND_FORGET = '// fire-and-forget';
const CHECKERS = new Set(['_wr', '_writeErr']);

const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
const isStmt = (n) => (/Statement$/.test(n.type) || n.type === 'VariableDeclaration');
const patternHasError = (p) => p.type === 'ObjectPattern' && p.properties.some((q) => q.type === 'Property' && q.key.type === 'Identifier' && q.key.name === 'error');

function isSbWrite(n) {
  if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.computed) return false;
  if (!WRITE_OPS.has(n.callee.property.name)) return false;
  const from = n.callee.object;
  return from.type === 'CallExpression' && from.callee.type === 'MemberExpression' && !from.callee.computed
    && from.callee.object.type === 'Identifier' && from.callee.object.name === 'sb' && from.callee.property.name === 'from'
    && from.arguments.length > 0 && from.arguments[0].type === 'Literal' && typeof from.arguments[0].value === 'string';
}

/** Does a `_wr(` / `_writeErr(` call in `text` take `name` among its arguments? */
function passedToChecker(text, name) {
  const word = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
  for (const m of text.matchAll(/\b(_wr|_writeErr)\(/g)) {
    const args = balancedArgs(text, m.index + m[0].length - 1);
    if (args !== null && word.test(args)) return true;
  }
  return false;
}

/**
 * @param rawHtml the source as written
 * @returns {{ total:number, checked:number, log:number, marker:number, returned:{}[], self:{}[], bare:{}[] }}
 *   bare: the result is dropped; self: the code reads .error itself instead of _writeErr; returned: the write is the
 *   return value of a named function (its callers are responsible). Each entry: {table, op, line, text}.
 */
export function checkBareWrites(rawHtml) {
  const html = stripIncludes(rawHtml);
  const { code, open } = mainScript(html);
  const comments = [];
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', onComment: comments });
  const lineOf = lineIndex(html);
  const markerLines = new Set(comments.filter((c) => c.value.includes('fire-and-forget')).map((c) => lineOf(open + c.start)));

  const found = [];
  const anc = [];
  (function walk(node) {
    if (isSbWrite(node)) found.push({ node, ancestors: anc.slice() });
    anc.push(node);
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c); }
      else if (v && typeof v.type === 'string') walk(v);
    }
    anc.pop();
  })(ast);

  const out = { total: found.length, checked: 0, log: 0, marker: 0, returned: [], self: [], bare: [] };
  for (const w of found) {
    const table = w.node.callee.object.arguments[0].value, op = w.node.callee.property.name;
    const line = lineOf(open + w.node.start);
    const rec = { table, op, line, text: lineText(html, open + w.node.start) };
    if (LOG_TABLES.has(table)) { out.log++; continue; }

    const a = w.ancestors;
    let kind = null, binding = null, self = false, child = w.node, stopAt = a.length;
    for (let i = a.length - 1; i >= 0; i--) {
      const n = a[i];
      stopAt = i;
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && CHECKERS.has(n.callee.name)) { kind = 'checked'; break; }
      if (n.type === 'VariableDeclarator') {
        if (n.id.type === 'Identifier') binding = n.id.name; else if (patternHasError(n.id)) self = true;
        break;
      }
      if (n.type === 'AssignmentExpression') {
        if (n.left.type === 'Identifier') binding = n.left.name; else if (patternHasError(n.left)) self = true;
        break;
      }
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.name === 'push'
        && n.callee.object.type === 'Identifier' && n.arguments.includes(child)) { binding = n.callee.object.name; break; }
      // Returned from a function: a callback (map/then) hands the value on to its caller's expression, so keep
      // climbing from there; a named or assigned function leaves the check to whoever calls it.
      const returnsIt = n.type === 'ReturnStatement' || (isFn(n) && n.expression && n.body === child);
      if (returnsIt) {
        let f = i;
        while (f >= 0 && !isFn(a[f])) f--;
        if (f < 0) { kind = 'bare'; break; }
        const parent = a[f - 1];
        if (parent && parent.type === 'CallExpression' && parent.arguments.includes(a[f])) { child = a[f]; i = f; continue; }
        kind = 'returned'; break;
      }
      if (isFn(n) || isStmt(n)) {
        if ((n.type === 'IfStatement' || n.type === 'ConditionalExpression') && n.test === child) self = true; // if((await sb...).error)
        break;
      }
      child = n;
    }

    if (!kind && binding) {
      // From the statement that binds it to the end of the function it lives in - past any callback
      // (a forEach that pushes into `calls` is read by the function around it): is the name, or a
      // one-hop alias of it, handed to _wr/_writeErr afterwards?
      let s = stopAt; while (s >= 0 && !isStmt(a[s])) s--;
      let f = stopAt;
      while (f >= 0 && !(isFn(a[f]) && !(a[f - 1] && a[f - 1].type === 'CallExpression' && a[f - 1].arguments.includes(a[f])))) f--;
      const stmt = s >= 0 ? a[s] : null, scope = f >= 0 ? a[f] : ast;
      const after = code.slice(stmt ? stmt.end : w.node.end, scope.end);
      const name = binding.replace(/\$/g, '\\$');
      const aliases = [
        `\\b([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+(?:Promise\\.all\\(\\s*)?${name}\\b`, // const res = await Promise.all(calls); const r = await q.select()
        `\\b([A-Za-z_$][\\w$]*)\\.push\\(\\s*${name}\\s*\\)`, // res.push(u)
        `\\bfor\\s*\\(\\s*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${name}\\b`, // for (const r of results)
      ].flatMap((re) => [...after.matchAll(new RegExp(re, 'g'))].map((x) => x[1]));
      if ([binding, ...aliases].some((n) => passedToChecker(after, n))) kind = 'checked';
      else if ([binding, ...aliases].some((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b[^;\\n]{0,48}\\.error\\b`).test(after))) self = true; // res.forEach(({b,r})=>{if(r&&!r.error
    }
    if (!kind) kind = self ? 'self' : 'bare';
    if ((kind === 'bare' || kind === 'self')) {
      let s = stopAt; while (s >= 0 && !isStmt(a[s])) s--;
      const stmtLine = s >= 0 ? lineOf(open + a[s].start) : line;
      if (markerLines.has(line) || markerLines.has(stmtLine)) kind = 'marker';
    }
    if (kind === 'checked') out.checked++;
    else if (kind === 'marker') out.marker++;
    else out[kind].push(rec);
  }
  return out;
}

/** The build's warning text: counts, the convention, and the first `limit` locations (bare first, then self-checked). */
export function formatBareWrites(r, limit = 20) {
  const flagged = r.bare.length + r.self.length;
  if (!flagged) return `build: every database write is checked (${r.checked} through _wr/_writeErr, ${r.marker} marked ${FIRE_AND_FORGET}, ${r.log} logging, ${r.returned.length} returned to a checking caller)`;
  const list = [...r.bare.map((x) => ({ ...x, tag: 'bare' })), ...r.self.map((x) => ({ ...x, tag: 'reads .error itself' }))];
  const lines = list.slice(0, limit).map((x) => `  app.src.html:${x.line}  ${x.table}.${x.op}  [${x.tag}]  ${x.text}`);
  return [
    `build: WARNING - ${flagged} database write(s) in app.src.html are neither wrapped in _wr(...) nor handed to _writeErr(...): `
      + `${r.bare.length} drop the result, ${r.self.length} read .error themselves `
      + `(${r.checked} are checked, ${r.returned.length} return the write to a caller, ${r.log} write a log table, ${r.marker} carry the marker).`,
    `  A write that is deliberately unchecked (a rollback, a best-effort touch) says so with the comment ${FIRE_AND_FORGET} on its line;`,
    `  the tables ${[...LOG_TABLES].join(' and ')} need no marker. Everything else belongs in await _wr(promise, ctx) or if(_writeErr(res, ctx))return.`,
    `  First ${Math.min(limit, list.length)} of ${list.length}:`,
    ...lines,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Check 2b: every form field has a name a screen reader can say (a WARNING, 2026-10-04)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// An <input>, <select> or <textarea> written in the source - static markup or a template - is named
// when it carries aria-label / aria-labelledby / title, sits inside an open <label>, or has an id that
// some <label for="..."> in the source names (compared as written, so for="${id}" matches id="${id}").
// A placeholder is not a name. Hidden inputs and the button kinds are skipped, and so is a tag named
// in a comment ("the group that is not an <input>"). The tag is read up to its own '>', skipping ${...}
// (a template expression may hold '>' or '=>').
// The build reads each half on its own (2026-10-05): the staff half's functions (a Set of their names),
// then the customer half, { except: <the same Set> } - every other function and the page's static markup.
const FIELD_SKIP_TYPES = /\btype\s*=\s*["']?(hidden|submit|button|reset|image)\b/i;
function tagEnd(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (depth) { if (c === '{') depth++; else if (c === '}') depth--; continue; }
    if (c === '$' && text[i + 1] === '{') { depth = 1; i++; continue; }
    if (c === '>') return i;
  }
  return -1;
}
/**
 * @param {string} rawHtml app.src.html as written
 * @param {Set<string>|{except:Set<string>}|null} scope the top-level function names to report (the staff
 *   half's); { except: names } for everything else (the customer half: its functions and the static markup);
 *   or null for all
 * @returns {{ half:string, total:number, named:number, unnamed:{ line:number, tag:string, fn:string, text:string }[] }}
 */
export function checkFieldNames(rawHtml, scope = null) {
  const html = stripIncludes(rawHtml);
  const lineOf = lineIndex(html);
  const inComment = commentRanges(html, parsedScripts(html));
  const fors = new Set([...html.matchAll(/\bfor\s*=\s*"([^"]+)"|\bfor\s*=\s*'([^']+)'/g)].map((m) => m[1] || m[2]));
  // The top-level function each position falls in: declarations start at the beginning of a line.
  const fnStarts = [...html.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => [m.index, m[1]]);
  const fnAt = (pos) => { let lo = 0, hi = fnStarts.length - 1, f = ''; while (lo <= hi) { const mid = (lo + hi) >> 1; if (fnStarts[mid][0] <= pos) { f = fnStarts[mid][1]; lo = mid + 1; } else hi = mid - 1; } return f; };
  const { open, close } = mainScript(html);
  const only = scope instanceof Set ? scope : null, except = scope && !only && scope.except instanceof Set ? scope.except : null;
  const out = { half: only ? 'staff' : except ? 'customer' : 'all', total: 0, named: 0, unnamed: [] };
  for (const m of html.matchAll(/<(input|select|textarea)\b/gi)) {
    if (inComment(m.index)) continue;
    const end = tagEnd(html, m.index + m[0].length);
    if (end < 0) continue;
    const tag = html.slice(m.index, end + 1);
    if (FIELD_SKIP_TYPES.test(tag)) continue;
    const inScript = m.index > open && m.index < close;
    const fn = inScript ? fnAt(m.index) : '';
    if (only && inScript && !only.has(fn)) continue;
    if (only && !inScript) continue; // static markup is the customer's page and the shells
    if (except && inScript && except.has(fn)) continue;
    out.total++;
    const idm = tag.match(/\bid\s*=\s*"([^"]+)"|\bid\s*=\s*'([^']+)'/);
    const id = idm && (idm[1] || idm[2]);
    const before = html.slice(Math.max(0, m.index - 600), m.index);
    const wrapped = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
    if (/\baria-label(?:ledby)?\s*=|\btitle\s*=/i.test(tag) || wrapped || (id && fors.has(id))) { out.named++; continue; }
    out.unnamed.push({ line: lineOf(m.index), tag: m[1].toLowerCase(), fn, text: tag.replace(/\s+/g, ' ').slice(0, 110) });
  }
  return out;
}
export function formatFieldNames(r, limit = 20) {
  const half = r.half === 'customer' ? 'customer ' : r.half === 'all' ? '' : 'staff '; // a result from before `half` was the staff half's
  if (!r.unnamed.length) return `build: every ${half}form field has an accessible name (${r.total} checked)`;
  return [
    `build: WARNING - ${r.unnamed.length} of ${r.total} ${half}form field(s) have no accessible name `
      + '(no <label for>, no wrapping <label>, no aria-label/aria-labelledby/title; a placeholder is not a name).',
    `  First ${Math.min(limit, r.unnamed.length)} of ${r.unnamed.length}:`,
    ...r.unnamed.slice(0, limit).map((x) => `  app.src.html:${x.line}  <${x.tag}> in ${x.fn || '(markup)'}  ${x.text}`),
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Check 3: the two halves stay within their download budget
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The split exists so a customer's phone downloads a quarter of what it used to. A budget on the
// gzipped size of each half turns a creeping regression into a red build. KB here is 1000 bytes.
// SIZE_BUDGET_CUSTOMER_KB and SIZE_BUDGET_STAFF_KB in the environment move the limits (a deliberate
// step up is a one-line change to the defaults below, with the reason in the commit).

// 2026-09-29: customer 260 -> 250, staff 250 -> 270. Making _gsOpen an entry point moved the account
// history and the account editor (about 19 KB) out of the customer half into staff.js; a staff device
// downloads the same total as before, a customer's phone 19 KB less, and the customer budget comes
// down so that saving is kept.
// 2026-09-30: staff 270 -> 275. The application messages in ten languages (the ride list, the
// Instagram line) took the staff half to 270.3 KB; only staff devices download it, and the customer
// budget stays where it was.
// 2026-10-01: customer 250 -> 225, staff 275 -> 300. The strings only staff screens say (1,913 of 3,122
// keys) left the customer's page: their English now heads staff.js (+26.5 KB there), the rest went to
// lang/staff-<code>.json. The customer half (now index.html + app.js, the script having moved out of
// the page) fell from 243.5 to 219.3 KB; a staff device downloads what it did.
// Later on 2026-10-01: staff 300 -> 315, and a third row, core 165. The staff half became staff.js (the
// desk's core, what a booth tablet parses before it draws) and twelve section parts fetched after the
// first paint: the same code, but thirteen gzip streams instead of one cost ~15 KB more in all. The
// core, 158 KB where the whole half was 297, keeps its own budget so the saving stays.
// 2026-10-02: staff 315 -> 318. The Saturday ride's three messages (_rmRender) are the owner's
// wording, two of them long (~1.6 KB gzipped); only staff devices download them.
// Later on 2026-10-02: customer 225 -> 227. The Saturday ride's group step (the two pills, their
// sheet and its strings, ~1 KB gzipped) is the rider's own. CI's gzip also reads ~1.3 KB more than a
// Mac's for the same file, so a local build at 224.1 was 225.4 on the runner: leave that much room.
// Staff 318 -> 320 for the same gap (316.2 here, 317.7 on the runner).
// Staff 320 -> 324 (2026-10-02): the Settings page, and Team and Settings as parts of their own, which
// took the desk's core from 164.9 to 160.9 KB but cost two more gzip streams in the half's total.
// Core 165 -> 170 (2026-10-02): the message templates' editor builds each message's built-in text from
// the same dictionaries the Community, Workshop, Messages and Ambassadors parts use (ten languages each),
// so they are shared and live in the core (160.9 -> 167.1 KB here, ~1.5 KB more on the runner).
// Customer 227 -> 228 and staff 324 -> 326 the same day, for the templates' fill-in code (0.3 and
// 2 KB here) and the runner's larger gzip readings.
// Core 170 -> 174, staff 326 -> 330 (2026-10-02): the Saturday ride's three messages in Arabic (~3 KB
// gzipped), which the bookings rows' envelope opens, so they belong to the core.
// Customer 228 -> 231 (2026-10-03): My Account's change-password dialog and the rider's own purchases
// (customer_change_password, customer_purchases; ~2 KB gzipped, the owner's request) are the rider's
// own page. 227.6 KB here is ~228.9 on the runner, over 228: leave the runner's margin.
// Staff 330 -> 344, core 174 -> 176 (2026-10-03): Vendors, a section of its own (the vendors part, 12 KB
// gzipped) whose 169 English strings ride in the core with every staff string (173.1 KB here, ~1.3 KB
// more on the runner).
// Staff 344 -> 346 (2026-10-03): Vendors' Feedback tab (the vendors part 12 -> 14 KB); 343.5 KB here is
// ~344.8 on the runner, over 344.
// Staff 346 -> 348 (2026-10-03): riders' breakfast ratings shared with the vendor (the vendors part 14 ->
// 16 KB, 17 strings); 346.0 KB here is ~347.3 on the runner.
// Customer 231 -> 232 (2026-10-03): the Privacy Notice names the breakfast venues that may receive riders'
// breakfast ratings (EN + AR rows, notice 2026-10-03); 229.7 KB here is ~231.0 on the runner.
// Staff 348 -> 350 (2026-10-03): Instagram follower counts on Accounts (chip + dialog, 18 strings);
// 348.4 KB here is ~349.7 on the runner.
// Staff 350 -> 352 (2026-10-03): the staff UI pass (roster fits a laptop, fleet row menu, one money and
// places rule for Dashboard + Analytics, the keyboard-shortcut list); 349.1 KB here is ~350.7 on the runner.
// Customer 232 -> 190, staff 352 -> 398, core 176 -> 222 (2026-10-04): _onRidersRt, _kbCheckInNext, _opgKey and
// showEditPriceModal became entry points, and ~45 KB of staff code the customer half carried (the riders list,
// scanner, check-in, return, cashier, hand-over, riders report, operator gate) moved to staff.js. Here: customer
// 185.5, staff 392.4, core 218.1 (the runner reads ~1.2 / ~1.6 / ~0.8 more). The customer budget is lowered to
// keep the win.
// Staff 398 -> 400 (2026-10-04): invited riders' three lists and Revoke invitation, and a priority on each
// learn-to-ride sign-up (the community part 47.1 -> 48.8 KB, 17 strings); 396.0 KB here is ~398.2 on the runner
// (it read 2.0 more than here for 1c230561).
// Staff 400 -> 404 (2026-10-04): History > Customer activity (renderCustActivity in the history part, 36 strings);
// 399.2 KB here is ~401.4 on the runner (it read 2.2 more than here for 9e45176b: 394.1 here, 396.3 there).
// Customer 190 -> 191, staff 404 -> 412, core 222 -> 227 (2026-10-04, the audit's "fix them all"): the staff security
// pass (idle lock, sign-out wipe, one-call check-in, exports helper), the vendor staff side (Tell the venue, late
// cancels), desk speed (scanner banner and tones, Open the next rider, Not here yet, wake lock, booth mode), the
// accessibility pass (named popups, focus restore, field names) and the performance pass (indexes, Analytics memo,
// per-row sync). Here, merged with main: customer 188.2, staff 407.3, core 224.2 (the runner reads ~1.3 / ~2.2 / ~0.8 more). The
// customer half keeps a 1 KB margin over the runner's reading so a tenth of a KB cannot turn CI red.
// Customer 191 -> 193 (2026-10-05): the rider's waiver step on the ticket for riders staff added (renderWaiverGate,
// acceptWaiverGate, _pendingWaiver; ~2 KB, customer code by design) merged with the audit; 190.1 KB here is ~191.4 on
// the runner, over 191.
// Staff 412 -> 418 (2026-10-05): ratings as pictures to share in Analytics > All ratings (_rsDraw draws each rating
// on a canvas; Select, the share dialog, 24 strings; the analytics part +4.8 KB); 413.1 KB here is ~415.3 on the runner.
// Customer 193 -> 198, staff 418 -> 424, core 227 -> 231 (2026-10-05, the full bug audit's fixes, ~150 across the
// app): waitlist places from customer_waitlist_ranks, the profile/correction gates' refusals, translated page names
// and spotsLeft plurals, booking-form focus and hidden types, offline parties in one write, the language-pack retry
// (customer); guarded approvals/removes/undos, the picker's staff_checkin, the sales outbox (updates, stock, PIN),
// party moves through staff_rider_party_move, on-the-house totals, the WhatsApp link from staff_options (staff).
// Here: customer 195.3, staff 419.9, core 228.4; the runner reads ~1.3 / ~2.2 / ~1.3 more, so each keeps ~1.4 KB.
// Customer 198 -> 206, staff 424 -> 428, core 231 -> 235 (2026-10-05, Run for Her): the event's card, the runner step
// (distance, the account details race day needs, the emergency contact, 18 and over), the emergency contact on My
// Account, the ticket's distance and meeting point, the pink ribbon badge and 42 strings (customer); the roster's
// distance column, filter and split, the runner's Finished and emergency contact, the distance in Add rider / walk-in /
// booking editor, the account editor's emergency contact and the Run for Her session form (staff).
// Here, on 0969444c: customer 202.0, staff 422.4, core 230.9; the runner reads ~1.3 / ~2.2 / ~1.3 more.
// Customer 206 -> 208 (2026-10-05): "About this event" under the event cards and "Details" under each date (the
// owner's 1B/2B/3B: a short description, the live facts and a book button in one sheet; members-only events show it
// to members only), the site's own words read from site_content, and 29 strings; 205.2 KB here is ~206.5 on the runner.
// Staff 428 -> 440, core 235 -> 240 (2026-10-05): the ratings reports in Analytics > Ratings (the owner: "import all
// the ratings in one report with anonymous names and only the breakfast part for the restaurants ... make a reports
// builder that includes a lot of customization"): the restaurant's anonymous breakfast report over any dates and the
// team's builder (filters, questions, columns, sections and their charts, names, order; print and CSV) in the analytics
// part (+9 KB, loaded after the desk paints); in the core, its 78 strings, the account report's chart drawer it now
// shares, and editing and removing a saved breakfast spot from the ride forms (13 strings).
// Here, on ae320241: staff 436.1, core 236.7; the runner reads ~2.2 / ~1.3 more, so each keeps ~1.7 / ~2.0 KB.
// Staff 440 -> 443 (2026-10-06): the staff half read ~439.5 of 440 on the runner after 813a8e5d (Run for Her's
// race-day paperwork), so any staff change failed the build step. With "no Mark paid on a free ride" (the bulk bar,
// the bulk action, the return's payment question, the bike pop-up's payment line; +0.1 KB) it is 437.5 here, ~439.6
// on the runner; 443 keeps ~3.4 KB.
// Customer 208 -> 211 (2026-10-06): staff can flag every field of an account, so the rider's correction page
// answers nine more (the bike type, profession, company, how they heard of us, each social handle, the emergency
// contact) with "I don't have one" for the optional ones; 207.2 KB here is ~208.6 on the runner.
// Staff 443 -> 445, core 240 -> 242 (2026-10-06): the Saturday ride's meeting point and breakfast spot told at a
// time staff choose (sessions.reveal_at): the "announce at" box on the new-session form and the editor, its checks,
// the Sessions card's mark and 8 strings (+1.0 KB each); the riders' "announced <time>" lines and the read at the
// time add +0.8 KB to the customer half, inside 211. Here, on 7a4e8185: customer 208.0, staff 440.1, core 238.9; the
// runner reads ~1.3 / ~2.2 / ~1.3 more, which left the staff half 0.7 KB and the core 0.2.
// Customer 211 -> 213 (2026-10-06): a Run for Her runner agrees before their details go to Sela and JYC (the owner:
// "force them to approve it"): the page asked on the runner step and on the next visit of anyone booked before or
// added at the desk, its 10 strings in each language, and the Privacy Notice's new rows in English and Arabic
// (+1.5 KB). Here, on 8e3c6869: customer 208.1 -> 209.6, ~211.0 on the runner.
// Core 242 -> 244 (2026-10-07): Reserve bike reserves with no bike chosen, and the picker takes a bike's number
// (the owner: "change the reserve bike to not force the staff to choose a bike and add a bike number option when
// choosing a bike"), with 4 strings in each language (+0.9 KB). Here, on 01c23a1d: core 238.9 -> 239.8, ~241.1 on
// the runner, 0.9 KB under 242; staff 441.0 (~443.2 on the runner) stays inside 445.
// Customer 213 -> 215, staff 445 -> 448, core 244 -> 246 (2026-10-07, on top of the Reserve change above): the line-by-line bug hunt's fixes across the
// whole app (one-at-a-time guards on double taps, Riyadh days for UTC stamps, Arabic-keyboard digits, a party moved
// under the new ride's fare, the light reload keeping riders' names, the check-in's pending bike lookup...). Here,
// on 01c23a1d + the hunt: customer 209.6 -> 210.2, staff 440.1 -> 442.0, core 238.9 -> 240.0; the runner reads
// ~1.4 / ~2.2 / ~1.3 more, which left 0.8 KB on the staff half and 0.7 on the core.
// Customer 215 -> 217, staff 448 -> 450 (2026-10-07): a second, optional emergency contact (the owner: "add a second
// optional emergency contact field show it in the customer my account field and allow the staff to flag it"): My
// Account's Add / Change / Remove and the correction page's answer, the account editor's second fieldset, the row
// menu's second card and the flag dialog's database check, 4 strings in each language. Here, on eaf80c7a (WhatsApp on
// My Account) + it: customer 212.9, staff 445.1, core 242.1, ~214.3 / ~447.3 / ~243.4 on the runner, which left the
// customer and the staff half 0.7 KB each; 217 / 450 keep ~2.7.
// Staff 450 -> 453 (2026-10-07): Customers and Community as two sections (the owner: "make a separate customer
// management/dashboard page and a separate community management dashboard page"), each with an overview, Community's
// Tags page with its holders, the leaderboard and statistics as Analytics views, and 29 strings in each language
// (+2.0 KB on the staff half; the core stays within 246).
// Staff 453 -> 460, core 246 -> 250 (2026-10-07): Applications made the admins' own (the owner: "add more
// customization in it"): sort, card details, saved views, approving or rejecting several at once, default tags and
// rules, the messages in every language and the form's questions, with 47 strings in each language. The code is in
// the community part; the English strings sit in the core. Here, on f24d9da5: staff 449.2 -> 455.6 (~457.8 on
// the runner), core 243.1 -> 247.2 (~248.5).
// Customer 217 -> 218 (2026-10-07): the first emergency contact required on Create account (its boxes, the second
// behind its button) and the check-up's own words; 214.6 local, ~216.0 on the runner. Staff 460 -> 461 the same day:
// the Riders pop-up's emergency contacts on top of Applications.
// Staff 461 -> 464, core 250 -> 253 (2026-10-07, on top of the above): the owner's decisions on the bug hunt's
// questions - Undo check-in puts a rider who came off the waitlist back onto it (every check-in path keeps what
// leaving the waitlist did), a party or booking moved onto Run for Her is asked its distance and age, a ride moved
// to another date takes its announce time along, deleting a tag and resetting or deactivating a venue login ask
// first, and 7 strings in each language (~+1.5 KB staff, ~+1.3 KB core).
// Staff 464 -> 466 (2026-10-07, on top of the above): every filter on both Applications lists (and
// Learn to ride's sort; the community list's Sort gains money spent, height, times sent and decided), and money spent
// as a filter and a sort on every list of accounts (Accounts, the account report, Applications, Flagged, Birthdays),
// 38 strings in each language; the owner asked for both. Here, on f89b9b24
// + it: staff 461.4, core 249.1 (~463.5 / ~250.4 on the runner); the core stays within 253.
// Staff 466 -> 475, core 253 -> 254 (2026-10-07): Team > Part-timers (the owner: "create me a part timers logging
// system ... give me the total for a date range or a number of sessions i choose from the calendar view or list", then
// "1 do it, 2 do a, 3 admins only, 4 rate for each kind of work"): the front desk's part-timers as staff accounts,
// kinds of work with their rates, hours per day and ride, what we owe over a range or picked rides, Mark as paid,
// payments with undo, pay slips and statements, 88 strings in each language (the Team part; the English strings sit
// in the core). Here, on d5c7f43e: staff 471.8 (~474.0 on the runner), core 251.1 (~252.4).
// Staff 475 -> 478 (2026-10-07): no Walk-in on the pool session, a Saturday ride or Run for Her, no Add rider on
// Petromin or a circuit night (+0.1 KB); the staff half was at 472.0 here (~474.2 on the runner), inside 2.5 KB of 475.
// Customer 218 -> 219, staff 478 -> 480 (2026-10-08): the three T100 race badges (T100 / T50 / T25, the owner: "do
// badges for completing the t100 races that will take place in jeddah"), their drawings and 9 strings in each
// language. main was already at 216.8 / 477.2 on the runner; here 215.9 / 475.3 local.
// Customer 219 -> 221, staff 480 -> 498, core 254 -> 262 (2026-10-09, branch s1009-settings): Settings > Business and
// > Pricing (the hard-coded values and fares an admin now changes, with the riders' public copy and fares read at boot),
// saved views on six lists, Team accounts (invite, disable, temporary password, presets, caps), approvals, retention
// and the KPI card, 171 strings in each language (the English sit in the core). Here: customer 218.2, staff 493.1,
// core 258.8 local (main was 216.3 / ~477 / 251.2).
// Staff 480 -> 496, core 254 -> 257 (2026-10-09, builder S4): fleet condition (the check after a return,
// incidents, the maintenance log), stock movements (receive at cost, reasons, history, value, CSV import) and
// the workshop's payment, parts and reports - mostly in the fleet / inventory / workshop parts, but 145 strings in
// each language whose English sits in the core (~2 KB gz). Here: staff 492.0, core 254.2 local.
// Staff 480 -> 484, core 254 -> 257 (2026-10-09): personal customisation (Start on, the phone tab bar, filters kept per
// section and synced, text size, density, the bell's read state on the account, templates in every language) and 18
// strings in each language; here 480.2 / 253.8 local.
// Staff 480 -> 494, core 254 -> 257 (2026-10-09, builder S5): Analytics months / reports inbox / year-on-year, acting on a
// selection, the employee-list import and a customer's own activity, 111 strings in each language (English in the core).
// Staff 480 -> 498, core 254 -> 257 (2026-10-09): the money controls (audit trail panel and search, void/refund reasons,
// the till with its Z-report, the exceptions and Team reports; staff part "money", 16 KB) and their ~125 strings, which
// sit in the core with every staff string. Here 491.9 / 253.0 local, from 476.7 / 251.2.
// Staff 480 -> 486, core 254 -> 259 (2026-10-09, s1009-desk): the front desk round (local bike numbers, the
// type/size warning, Sending and the failed check-in bar, single check-in Undo, bulk No-show, the live count,
// desk keys, Close out's per-bike marks, the Petromin bike) and 33 strings in each language; the night's
// summary went to the cashier part. Here 255.0 core / 481.6 staff local (~2 KB more on the runner).
// Staff 480 -> 483, core 254 -> 255 (2026-10-09): the accessibility and consistency pass (theme choice, shortcut
// switch, named buttons and toggle states, sortable headers as buttons, captions, 17 strings in each language);
// here staff 479.2, core 252.3 local (~481 / ~253.6 on the runner), inside 2.5 KB of the old limits.
export const SIZE_BUDGET_DEFAULT_KB = { customer: 224, staff: 560, core: 280 };
export const SIZE_BUDGET_ENV = { customer: 'SIZE_BUDGET_CUSTOMER_KB', staff: 'SIZE_BUDGET_STAFF_KB', core: 'SIZE_BUDGET_CORE_KB' };

/** Bytes of the gzipped text, as zlib compresses it at its default level. */
export function gzipBytes(text) {
  return gzipSync(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8')).length;
}

/**
 * @param bytes {{customer:number, staff:number}} gzipped byte counts of index.html and staff.js
 * @param env the environment to read the limits from (process.env in the build)
 * @returns {{ rows: {half:string,bytes:number,kb:number,limitKb:number,over:boolean}[], over: {}[], text: string }}
 */
export function checkSizeBudget(bytes, env = process.env) {
  const rows = ['customer', 'staff', 'core'].filter((half) => half !== 'core' || bytes.core !== undefined).map((half) => {
    const raw = env[SIZE_BUDGET_ENV[half]];
    const limitKb = raw === undefined || raw === '' ? SIZE_BUDGET_DEFAULT_KB[half] : Number(raw);
    if (!Number.isFinite(limitKb) || limitKb <= 0) throw new Error(`build: ${SIZE_BUDGET_ENV[half]}=${JSON.stringify(raw)} is not a size in KB`);
    const b = bytes[half];
    if (!Number.isFinite(b)) throw new Error(`build: no byte count for the ${half} half`);
    return { half, bytes: b, kb: b / 1000, limitKb, over: b > limitKb * 1000 };
  });
  const label = { customer: 'customer half (index.html + app.js)', staff: 'staff half (staff.js + staff-parts)', core: 'desk core (staff.js)' };
  const text = rows.map((r) => `${label[r.half]} ${r.kb.toFixed(1)} KB gzipped, budget ${r.limitKb} KB${r.over ? ' - OVER' : ''}`).join('; ');
  return { rows, over: rows.filter((r) => r.over), text };
}

// ── The customer system's colours (2026-09-30) ─────────────────────────────────────────────────
// styles.css ends with the CUSTOMER SYSTEM block, the one set of rules every rider screen answers to.
// Its colours live in its token list. A raw #hex, rgb() or hsl() in any other declaration inside the
// block is how the sprawl came back last time (five stacked reskins, 22 text colours on nine
// screens), so the build refuses it. Custom properties (--name: #hex) are the tokens and may hold
// raw values; everything else says var(--name).
export const CUSTOMER_SYSTEM_START = 'CUSTOMER SYSTEM (2026-09-30)';
export const CUSTOMER_SYSTEM_END = 'END CUSTOMER SYSTEM';
export function checkCustomerColors(css) {
  const a = css.indexOf(CUSTOMER_SYSTEM_START);
  const b = a < 0 ? -1 : css.indexOf(CUSTOMER_SYSTEM_END, a);
  if (a < 0 || b < 0) return { found: false, offenders: [] };
  const firstLine = css.slice(0, a).split('\n').length;
  // comments keep their line breaks so the line numbers stay true
  const block = css.slice(a, b).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const offenders = [];
  const re = /([-\w]+)\s*:\s*([^;{}]+)/g;
  let m;
  while ((m = re.exec(block))) {
    const [, prop, value] = m;
    if (prop.startsWith('--')) continue;
    if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value)) {
      offenders.push({ prop, value: value.trim(), line: firstLine + block.slice(0, m.index).split('\n').length - 1 });
    }
  }
  return { found: true, offenders };
}

// ── No emoji (the owner, 2026-09-30: "use no emojis always create your own icons") ─────────────
// An icon is drawn (the rider's _CU set, the staff's _ART set); an emoji or a pictograph standing
// in for one is refused anywhere in the source, message templates and comments included.
export const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B50}\u{2B55}\u{FE0F}]/u;
// typographic marks that are not emoji and are allowed: ✓ ✕ ✎ ★ (staff tables still print them)
const EMOJI_OK = new Set(['\u2713', '\u2715', '\u270E', '\u2605']);
export function checkNoEmoji(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    for (const ch of l.match(new RegExp(EMOJI_RE.source, 'gu')) || []) if (!EMOJI_OK.has(ch)) { out.push({ line: i + 1, ch, text: l.trim().slice(0, 120) }); break; }
  });
  return out;
}

// ── The phone-number rules' version (2026-10-04) ───────────────────────────────────────────────
// The app asks for assets/phone-rules.json?v=PHONE_RULES_V, and /assets/* is kept a week by the
// browser (and served cache-first by the worker for a ?v= address): rules rebuilt without moving the
// version reached nobody for up to a week. The file carries the version it was built from ("v"),
// so the two have to agree. Answers an error message, or null.
export function checkPhoneRulesVersion(src, rulesJson) {
  const m = src.match(/const PHONE_RULES_V='([^']*)'/);
  if (!m) return 'PHONE_RULES_V was not found in app.src.html';
  let v;
  try { v = JSON.parse(rulesJson).v; } catch { return 'assets/phone-rules.json does not parse'; }
  if (String(v) !== m[1]) return `assets/phone-rules.json is version ${JSON.stringify(v)} but app.src.html asks for PHONE_RULES_V='${m[1]}' - set PHONE_RULES_V to the file's version so the new rules are fetched`;
  return null;
}
