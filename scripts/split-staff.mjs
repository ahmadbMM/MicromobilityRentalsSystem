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
  'renderVolunteers', '_vsfMount', '_vsfSave', '_cfVolMount', // 2026-11-05: the Volunteers section, and the two forms that ask for its block
  '_lkAdFill', // 2026-11-10: the booking's Locker card in the add-on picker (the picker is in the customer half)
  'setStaffTab', 'renderStaffTabs', '_renderStaffTab', '_bgRenderStaffTab',
  'renderStaffQueue', 'renderSessions', 'renderBikes', 'renderHistory', 'renderAnalytics', 'setAnView', 'renderInventory',
  'renderCashier', 'renderCommunity', 'renderCustomers', 'renderBadgeRequests', 'renderWebsite', 'renderCatalog', 'renderWorkshop', 'renderMessages',
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
  '_lkRt', '_onRidersRt', '_kbCheckInNext', '_opgKey', 'showEditPriceModal',
  '_opGateRender', // the operator keypad's drawing (2026-11-10): only a staff device opens the keypad, and by then staff.js is in; 1.3 KB gzipped off every rider's page
  '_idleStaff', // the idle clock (2026-10-04): started by the operator gate's check, which showView runs
  'lockStaff', // the top bar's lock (drawn by customer-half code): its sign-out settles the outboxes and asks first
  '_vendorLatePoll', // the bell's late cancels by venues (2026-10-04): the vendor poll and the bell's opening fetch them
  '_bizFromOpts', // the business settings (2026-10-09): applied when the staff lists arrive, which customer-half code fetches
  '_snapQueue', // the boot snapshot's bookings from the sync copy (2026-10-09): awaited by the boot; a customer's page gets nothing
  // A signed-in staff device's copy of the bookings and the riders (2026-10-28: the whole read kept page by page took the
  // customer half to 254.8 of 256 KB). Its callers await what it answers: on a staff device staff.js is in before the
  // first data load, and a customer's page never asks (its reads are the public ones); a stub's undefined reads as "no
  // sync", and the old reads answer.
  '_syncFetch',
  '_askCount', // Ask's answers waiting for approval, on the rail (2026-11-13): asked by _secPolls too; only ever on a staff page
  '_stoCounts', // the Store's and Payments' numbers on the rail (2026-11-10): asked by _secPolls, which the customer half holds; only ever on a staff page
  '_brLoad', // the Workshop's bike reports (new features build F15, 2026-11-13): read beside the requests by _wsLoad and _wsPoll, which the customer half holds; only ever on a staff page
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
  // The staff sections' own addresses, read off STAFF_PATHS (and the two older names _parsePath still takes): the early
  // load at the top of the script runs before that const and SIGNUP_PATH exist, where _parsePath throws (bug hunt 2026-11-11).
  const spDecl = decl.get('STAFF_PATHS');
  const spInit = spDecl && spDecl.node.type === 'VariableDeclaration' ? (spDecl.node.declarations.find((d) => d.id.name === 'STAFF_PATHS') || {}).init : null;
  if (!spInit || spInit.type !== 'ObjectExpression') throw new Error('split-staff: STAFF_PATHS (the staff sections\' paths) was not found as an object literal');
  const staffSegs = [...new Set([...spInit.properties.map((p) => (p.value && p.value.type === 'Literal' ? String(p.value.value).split('/')[0] : '')), 'community', 'customers'].filter(Boolean))];
  const staffPathRe = `^/(?:${staffSegs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:/|$)`;
  // A stub whose name the loaded file did not replace (a deploy moved or renamed it, and the server
  // answers any ?v= with today's file) called itself on the cached resolved promise forever and froze
  // the tab: it now throws once instead (bug hunt 2026-10-28).
  // Each stand-in knows itself by _stubC, set as this block runs, not by what its name holds when it is
  // called: a reference kept before staff.js arrived (the rider_registrations realtime handler, a _debRender
  // callback) and called after it read the real function as itself and threw. Called once its name holds
  // something else (the real function, or a part's stand-in), it hands over at once (bug hunt 2026-11-10).
  const go = (n, f) => `()=>{if(${n}===m)throw new Error('${n} missing from ${f} - reload the page');return ${n}(...a);}`;
  const own = (n) => `const m=_stubC.${n};if(${n}!==m)return ${n}(...a);`;
  // A way in whose staff half did not come down (a timeout, offline before the service worker holds it) did nothing and
  // said nothing: its callers use it for the effect alone, so the rejection reached only the global log (bug hunt
  // 2026-11-11). Only the download's failure is taken here; an error of the real function goes on as before.
  const stubs = stubbed.map((n) => ALWAYS_LOAD.has(n)
    ? `function ${n}(...a){${own(n)}return _loadStaff().then(${go(n, 'staff.js')},e=>_staffLoadFailed(e,()=>${n}(...a)));}`
    : `function ${n}(...a){${own(n)}if(_staffWanted())return _loadStaff().then(${go(n, 'staff.js')});}`).join('\n')
    + `\nvar _stubC={${stubbed.map((n) => `${n}:${n}`).join(',')}};`;
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
var STAFF_PATH_RE=new RegExp(${JSON.stringify(staffPathRe)},'i'); // the staff sections' paths (STAFF_PATHS), for the test below
var STAFF_LANG_V={}; // the build stamps {code:contentHash} of lang/staff-<code>.json
var LANG_STAFF={},_staffLangP={},_staffLangGot={};
// The stored marks and the address first, S.view last: this runs at the top of the script too
// (the early load below), before S exists, and the try answers false only when nothing else did.
// A staff section's path is matched by STAFF_PATH_RE first: _parsePath reads consts that do not exist
// yet up there, so it threw and every staff path answered false there. ?locker is a locker's tag, as
// the head's test (_stw) has it.
function _staffWanted(){try{if(localStorage.getItem('cq_staff')==='1'||sessionStorage.getItem('cq_staff_entry')==='1'||_isStaffHost())return true;const q=new URLSearchParams(location.search);if(q.has('staff')||q.has('bike')||q.has('locker'))return true;if(STAFF_PATH_RE.test(location.pathname))return true;const p=_parsePath(location.pathname);if(p&&p.view==='staff')return true;return S.view==='staff';}catch(e){return false;}}
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
  // The page's <head> already wrote styles.css on a device it took for staff (2026-10-09), and app.css
  // not at all: a script runs only once the stylesheets above it are in, so the link has its sheet.
  const own=document.querySelector('link[data-staff-css]');
  if(own&&own.sheet)return(_staffCssP=Promise.resolve());
  if(own)try{own.remove();}catch(e){} // it failed: ask again below
  _staffCssP=new Promise((res,rej)=>{
    const l=document.createElement('link');let done=false;
    const fail=why=>{if(done)return;done=true;_staffCssP=null;try{l.remove();}catch(e){}_staffCssFallback();rej(new Error(why));};
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
// styles.css did not come (bug hunt 2026-11-11). A page whose head wrote styles.css alone was left with no stylesheet,
// and once staff.js is in, no stub calls _loadStaff again, so nothing ever asked for it again. app.css comes back at once
// (every customer screen's rules and most of the staff ones; styles.css switches it off when it arrives), and styles.css
// is asked for again a few times, sooner when the connection returns.
var _staffCssRetry=0,_staffCssTries=0;
function _appCssHref(){try{for(const n of document.querySelectorAll('noscript')){const m=/\\/app\\.css\\?v=[\\w-]+/.exec(n.textContent||'');if(m)return m[0];}}catch(e){}return'/app.css';} // the head's own tag, with its version
function _staffCssFallback(){
  try{if(!document.querySelector('link[rel="stylesheet"][href^="/app.css"]')){const a=document.createElement('link');a.rel='stylesheet';a.href=_appCssHref();document.head.appendChild(a);}}catch(e){}
  if(_staffCssRetry||_staffCssTries>=5)return;
  _staffCssTries++;
  const again=()=>{if(!_staffCssRetry)return;clearTimeout(_staffCssRetry);_staffCssRetry=0;try{window.removeEventListener('online',again);}catch(e){}_loadStaffCss().catch(()=>{});};
  _staffCssRetry=setTimeout(again,15000*_staffCssTries);try{window.addEventListener('online',again);}catch(e){}
}
// The language on screen: S when it exists, else what the head's early script chose (S is still in
// its temporal dead zone at the top of the script, where typeof throws too - hence the try).
function _staffLangCode(){try{if(S&&S.lang)return S.lang;}catch(e){}return window.__langPackCode||'en';}
function _staffLangReady(c){return !c||c==='en'||((!STAFF_LANG_V[c]||!!_staffLangGot[c])&&(typeof _partLangsReady!=='function'||_partLangsReady(c)));} // the parts' strings too, once staff.js is here (2026-10-09)
// Never rejects: a pack that did not arrive leaves t() answering in English, as the customer packs do.
function _loadStaffLang(c){
  if(_staffLangReady(c))return Promise.resolve();
  if(!_staffLangGot[c]&&STAFF_LANG_V[c]&&!_staffLangP[c])_staffLangP[c]=fetch('/lang/staff-'+c+'.json?v='+STAFF_LANG_V[c]).then(r=>r.ok?r.json():null).then(d=>{if(d&&typeof d==='object'){LANG_STAFF[c]=Object.assign(LANG_STAFF[c]||{},d);_staffLangGot[c]=true;}else delete _staffLangP[c];}).catch(()=>{delete _staffLangP[c];});
  return Promise.all([_staffLangP[c],typeof _loadPartLangs==='function'?_loadPartLangs(c):null]).then(()=>{});
}
function _loadStaff(){
  if(_staffP)return _staffP;
  // window.__staffPartsNow (set by the test suite's stubs): the staff half's parts come before the
  // promise resolves, so a spec may call a section's functions at once. Anywhere else they follow the
  // desk's first paint on their own (splitSections).
  // A stylesheet that did not come is not a failed load (bug hunt 2026-11-11): the real functions are in once staff.js
  // is, and _staffCssFallback above keeps the page styled and asks again.
  _staffP=Promise.all([_loadStaffJs(),_loadStaffCss().catch(e=>{try{_logError((e&&e.message)||'styles.css did not load','staff-css',true);}catch(_){}}),_loadStaffLang(_staffLangCode())]).then(()=>{if(window.__staffPartsNow&&typeof _loadStaffParts==='function')return _loadStaffParts();},e=>{_staffP=null;throw e;});
  return _staffP;
}
// What a way in says when the staff half could not be fetched: the error bar, whose Try again calls the
// same way in again with the same arguments (bug hunt 2026-11-11).
function _staffLoadFailed(e,again){try{_logError((e&&e.message)||String(e||'staff.js did not load'),'staff-load',true);}catch(_){}try{errorBar(t('mbErr'),again);}catch(_){}}
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

// ── Which file of the staff half carries each staff string (2026-10-09) ────────────────────────
// The staff strings used to ride whole in the desk's core (English in staff.js, the rest in
// lang/staff-<code>.json): some 20 KB gzipped of words only Analytics, Community, the till or the
// website editor say, parsed on every boot. A staff key now goes with the part that names it when
// the core cannot ask for it - not as a word, not through a prefix or suffix it builds keys from,
// and not as one of DYNAMIC_KEYS (keys built away from any t() call, which stay in the core
// whoever names them). A key two parts name stays in the core too. English rides in the part's own file,
// the other languages in lang/staff-<part>-<code>.json, fetched with the part.
/** Keys built away from the t() call (a variable or a map filled by code holds the name). Regexes on the key. */
export const DYNAMIC_KEYS = [
  /^ev[A-Z]\w*Name$/, // evJccName, evSatName, ...: NS_EV_NAME and the ride-kind fallbacks name them, some by ride kind at runtime
  /^bdg?[A-Z0-9]\w*[DA]$/, // bdFirstLapD, bdgMarshalA, ...: a badge's how-to and about lines, read as t(BD_SYS[slug][2]+'D'|'A')
  /^\w+_(zero|one|two|few|many|other)$/, // mrRides_one, ...: a count's plural forms, read by _tn(base, n) through Intl.PluralRules
  /^pii(Via|Fld)_\w+$/, // piiVia_reveal, piiFld_phone: the core's look log (_piiLog, _piiExport) names them by the way and the field
];
/**
 * @param staffKeys the keys staffOnlyLangKeys gave the staff half
 * @param coreText the desk's core (staff.js) as splitSections cut it
 * @param partTexts {name: code} of every staff part
 * @returns {{ core: Set<string>, parts: Record<string, Set<string>> }}
 */
export function partLangKeys(staffKeys, coreText, partTexts, dynamic = DYNAMIC_KEYS, up = STAFF_PART_UP) {
  const core = langKeyParts(coreText), fam = famOf(up);
  const parts = Object.entries(partTexts).map(([n, text]) => [n, langKeyParts(text)]);
  const out = { core: new Set(), parts: Object.fromEntries(parts.map(([n]) => [n, new Set()])) };
  for (const k of staffKeys) {
    if (dynamic.some((re) => re.test(k)) || namesKey(core, k)) { out.core.add(k); continue; }
    // One part only: a key two parts share stays in the core (copied into both it cost the staff
    // half ~7 KB gzipped for ~5 KB off the core, measured 2026-10-09).
    // A part and the parts inside it (STAFF_PART_UP) are one owner: the key rides with the outer part, which has always come first.
    const owners = parts.filter(([, pp]) => namesKey(pp, k)).map(([n]) => n);
    const fams = [...new Set(owners.map(fam))];
    if (fams.length !== 1) { out.core.add(k); continue; }
    out.parts[owners.length === 1 ? owners[0] : fams[0]].add(k);
  }
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
/** The test customerCss puts to a selector: true when only the staff screens can match it (scripts/check-staff-css.mjs uses it too). */
export function staffSelTest(customerText, staffText, scope = STAFF_SCOPE) {
  const cust = classParts(customerText), staffWords = new Set(staffText.match(/-?[A-Za-z_][\w-]*/g) || []);
  const staffOnly = (n) => scope.has(n) || (staffWords.has(n) && !classOnPage(cust, n));
  return (sel) => requiredNames(sel).some(staffOnly);
}
export function customerCss(css, customerText, staffText, scope = STAFF_SCOPE) {
  const staffSel = staffSelTest(customerText, staffText, scope);
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

// A phone has no pointer to rest on anything: a tap leaves :hover stuck on the button until the next tap
// elsewhere, so a pressed card stays tinted and a lifted button stays lifted (2026-10-10, the "less AIsh"
// pass). Every rider rule written with :hover is moved under @media (hover:hover) and (pointer:fine) as
// app.css is built; the source keeps writing :hover as it always has. A selector list that mixes hover and
// non-hover selectors is split, so the non-hover half still applies everywhere.
export const HOVER_MEDIA = '@media (hover:hover) and (pointer:fine)';
export function gateHover(css) {
  const GROUP = /^@(?:media|supports|layer|container|document)\b/i;
  let gated = 0;
  function walk(text) {
    let out = '';
    for (const t of cssTokens(text)) {
      if (t.kind === 'rule' && /:hover\b/.test(t.prelude)) {
        const sels = splitSelectors(t.prelude), hov = sels.filter((x) => /:hover\b/.test(x)), rest = sels.filter((x) => !/:hover\b/.test(x));
        if (rest.length) out += `${rest.join(',')}{${t.body}}`;
        out += `${HOVER_MEDIA}{${hov.join(',')}{${t.body}}}`; gated++;
      } else if (t.kind === 'at' && t.body !== null && GROUP.test(t.prelude) && !t.prelude.includes('hover:hover')) {
        out += t.open + walk(t.body) + '}';
      } else out += t.text;
    }
    return out;
  }
  return { css: walk(css), gated };
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
// Customers (its own section since 2026-10-07) is drawn by Community's code, so both are one part; Badge requests (its own
// section since 2026-11-08) gives and reads the badges with Community's badge code, so it is in that part too. _bdgStrips (2026-10-09):
// an account's badges in the history window and the editor, which are core, drawn by the badges code Community holds.
export const STAFF_PARTS = {
  analytics: ['renderAnalytics'], community: ['renderCommunity', 'renderCustomers', '_ahActShow', '_bdgStrips', '_bqLoad', '_n6qTlShow', '_n6pAhLoad', 'renderBadgeRequests'], bikes: ['renderBikes'], cashier: ['renderCashier', '_eonOpen', '_ctBook', '_ctBooked'],
  catalog: ['renderCatalog', '_catUploadImage', '_catStorageRemove', '_catUploadToast'], inventory: ['renderInventory', '_invMove', '_invSetCount'], website: ['renderWebsite', '_webLoad', '_webRestore'], history: ['renderHistory'],
  wallet: ['_cwOpen', '_cwDeskPay', '_cwDeskRefund'], // 2026-11-02: an account's wallet, and the desk paying from it or refunding into it
  workshop: ['renderWorkshop'], ambassadors: ['renderAmbassadors'], messages: ['renderMessages'],
  volunteers: ['renderVolunteers', '_vsfMount', '_vsfSave', '_vsfCheck', '_cfVolMount'], // 2026-11-05: the section, the switch in the session form, the hours in the account editor; 2026-11-11: the switch's check before a session form writes
  vendors: ['renderVendors'], // 2026-10-03: Vendors, admins only
  sessions: ['renderSessions'], // 2026-11-06: the Sessions section (its own since then), admins only; its forms, figures, table and Customize
  // 2026-11-10 (s10, item 10): cashier's _ctBook/_ctBooked, the till's receipt write, which the lockers part's Hand the keys sheet
  // (moved out of the core then, a stand-in left for a QR read and _lkRepaint) books a desk-paid locker through
  lockers: ['renderLockers', '_lkEdOpen', '_lkAssignOpen', '_lkAsRepaint', '_lkAsTag', '_lkHandOpen', '_lkHandDraw'], // 2026-11-09: the Lockers section (the board, reservations, units, history); the sheet, the check-in line and tag taps stay in the core; 2026-11-10: a reservation's edit dialog (refund, on the house, WhatsApp), which the core's sheet opens; 2026-11-10: Assign a locker (a booking's menu), with what the core tells it - a read landed, a tag tapped while it is open
  ask: ['renderAsk'], // 2026-11-13: Ask (/ask) - the pages, a page's setup, answers and results; the rail's number stays in the core
  store: ['renderStore', 'renderPayments', '_payRfOpen'], // 2026-11-10: the Store (orders, products) and Payments (online payments, refunds owed, settings) sections, and the refund dialog a booking's pay menu opens; the rail's probe and counts stay in the core
  sela: ['printSelaReport', 'exportSelaXlsx'], // 2026-10-08: Run for Her's report for Sela (print + .xlsx), read at each tap
  vlap: ['_vlStaffOpen', '_vlAthleteEdit', '_vlPairOpen', '_vlCfgOpen', 'printKaminReport', 'exportKaminXlsx', '_vrbOpen', '_prbOpen', 'printVlReceipts'], // 2026-10-17: Victory Lap - athletes and teams, an athlete's race, pairing, the race's settings, the report for Kamin Sports; 2026-10-23: the report builder, and the partner (Defe) report builder beside it, which shares its workbook writer
  // _ahActShow (community): a customer's own activity in their profile; imports: partner companies' employee lists (2026-10-09)
  imports: ['openRosterImport'],
  team: ['renderTeam', '_ptcOpen'], settings: ['renderSettings', '_gsOpen', 'renderDashboard', '_waLog'], // 2026-10-02: the account's Settings page, and Team with it, out of the desk's core; 2026-11-08: the part-timers' hours asked at a JCC or Petromin close-out; 2026-11-10 (staff round s10): the Ctrl K bar and the Dashboard ride in Settings' part, which every account fetches (Settings is always open): out of the desk's core without a file of their own; 2026-11-11 (s10b, extras): _waLog, the WhatsApp line in the shared log a wa.me tap writes (the core's _waTap hears every tap), and the search operators' parser (_sqParse, which the core's matchers ask for by a built name)
  // 2026-10-09: the fleet's condition (the check after a return, incidents, the maintenance log and its report)
  fleet: ['_bpFleetFill', '_fleetAfterReturn', '_bkCheckClear', '_fleetReport', '_retPhotoPick'],
  // 2026-10-09: the audit trail, void/refund reasons, the till, the exceptions and Team reports
  // (with the Action Log, which shares the account names and the record links with them)
  money: ['renderMoneyView', 'openAuditPanel', 'recordDrawerCount', 'renderTeamReport', '_askMoneyReason', 'renderLogs'],
  // 2026-10-09 (round 2): the desk note's editor, My shift, joining and leaving a party; 2026-11-10 (s10, D2): Check in all paid
// 2026-11-11 (s10 second batch, D10): the night checklists (_ckOpen: the opening and close-night lists, the Dashboard's prompt and
// Settings' editor by a built name through _s10W, another desk's tick through setupRefRealtime)
// 2026-11-10 (staff round s10): the night's Close out (its dialog and its one-call write, staff_close_out) and the menu's
// No-show question, out of the desk's core, which the round's bulk writes had taken to its budget
  desk: ['_deskNoteEdit', '_myShiftOpen', '_partyJoin', '_partyLeave', '_n6cPrepOpen', '_n6cFtOpen', '_tcOpen', 'closeOutSession', 'confirmNoShow', '_ciAllPaid', '_sntLoad', '_sntOpen', '_incLoad', '_incOpen', '_incHist', '_ckOpen'], // 2026-11-07: the bike prep sheet and the first-timers to follow up; 2026-11-10: Booking card (a booking's ticket as its rider sees it, and its picture); 2026-11-10 (round s10): the handover notes' read and pop-up, Record incident, History > Incidents
  // 2026-10-10: the desk outbox's store (IndexedDB), its replay and the unsynced list (the list, the overlay and the chip stay in the core)
  deskq: ['_dqEnqueue', '_dqFlush', '_dqBoot', '_dqOpen'],
  // 2026-10-09: the self-service kiosk (a desk tablet in kiosk mode), and the deposit ledger's writes and settle dialog
  kiosk: ['_kioskOpen'], deposits: ['_depTake', '_depSettle', '_depSettleOpen'],
  // 2026-10-09 (R7): ride reminders on WhatsApp and who a freed waitlist place goes to (staff pick or a timed offer)
  // 2026-11-04: and telling the riders a freed place went to (its list and row chip stay in the core; its words in all ten languages here)
  remind: ['openRemindSheet', 'openWlOffers', '_ptOpen'],
  // 2026-11-11 (staff round s10, item 47): People's rarely opened views, out of the community part, each set fetched the
  // first time one of its views is opened (STAFF_PART_TABS: none), and inside community (STAFF_PART_UP): Applications
  // (community and learning to ride) in one; in the other Recognition (badges, titles, the members' page), Birthdays (and
  // its printed week), Referrals, Tags, Duplicates, the customers' activity log, the account report (its builder and the
  // default print) and the actions on a group of accounts (openSegmentActions, from the selection and the report).
  peopleapps: ['_commApplications', '_learnApplications', '_commMentors'], // + People > Mentorship (2026-11-13)
  peoplemore: ['_commBadges', '_commTitles', '_commActivities', '_commBirthdays', '_refRpHtml', '_commTags', '_commDuplicates',
    'renderCustActivity', 'showAccountReportOptions', 'printDefaultAccountReport', 'openSegmentActions',
    '_commCompanies'], // 2026-11-13 (F26): Recognition > Company challenges (the list, a challenge's dialog, who joined)
  // 2026-11-11 (item 47): a session's report - its options dialog and the sheets it prints or saves (the report, its CSV, the
  // breakfast report, the Saturday roster) - out of the desk's core: ~9 KB gzipped no desk parsed before its first paint.
  // The day sheet and the close-out stay in the core.
  sessreport: ['showPrintReportOptions'],
  // 2026-11-13 (the reports rework): the report viewer (S1) - a report on a sheet over the site, its number, Excel, CSV and PDF -
  // fetched the first time a report opens; _reportShell and _openReport stay in the core with the sections that call them.
  reports: ['_rxView', 'renderReports'],
  // 2026-11-11 (staff round s10, D11): the Door role's locked scan screen (a Door account signs in to it; nobody else fetches it)
  door: ['_doorEnter', '_doorPaint', '_doorScanned'],
};
// ── Parts inside a part (2026-11-11, staff round s10 item 47) ─────────────────────────────────────
// People's code was a quarter of every part (community: 474 KB raw, 135 KB gzipped), all of it fetched to
// open the Accounts list. Its rarely opened views are parts of their own now, each fetched the first time
// it is opened. A part named here only ever runs after its parent part: its loader fetches the parent
// first (_loadStaffPart), so what the child and its parent both reach - or two children of one parent -
// stays in the PARENT instead of going back to the core (cut as plain parts, the views shared some 36 KB
// gzipped of helpers with Accounts, and the core would have grown by that). One level only.
// The view renderers People calls for their markup are entry points like any other: until the part has
// come their stand-in answers a promise, so _renderPeople draws a short loading line (_pplPartHtml) and
// paints again once it has come.
export const STAFF_PART_UP = {
  peopleapps: 'community', peoplemore: 'community',
};
// The parent's own family name: a part, or the part it lives inside.
const famOf = (up) => (p) => up[p] || p;
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
export function splitSections(code, parts = STAFF_PARTS, roots = STAFF_ENTRY, up = STAFF_PART_UP) {
  const { stmts, decl } = refsOf(code);
  for (const [c, p] of Object.entries(up)) {
    if (!parts[c] || !parts[p]) throw new Error(`split-staff: STAFF_PART_UP names ${parts[c] ? p : c}, which is not a staff part`);
    if (up[p]) throw new Error(`split-staff: staff part ${p} is inside ${up[p]} and cannot hold ${c}: one level only`);
  }
  const fam = famOf(up);
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
    const by = new Map();
    for (const [p, fns] of Object.entries(parts)) {
      own[p] = reach(fns, core, new Set([...allEntries].filter((f) => entries.get(f) !== p)));
      for (const st of own[p]) (by.get(st) || by.set(st, new Set()).get(st)).add(p);
    }
    // What a part and the parts inside it reach (or two parts inside one) goes to that part: they run only after it.
    for (const [st, ps] of by) {
      if (ps.size < 2) continue;
      const fs = new Set([...ps].map(fam));
      if (fs.size !== 1) continue;
      const f = [...fs][0];
      for (const p of ps) own[p].delete(st);
      own[f].add(st); by.set(st, new Set([f]));
    }
    const count = new Map([...by].map(([st, ps]) => [st, ps.size]));
    // A statement nothing reaches by name (a bell kind the desk calls through a list of names, as
    // _r7Bell -> _remDue) stays in the core, so whatever it calls must be there too: _remTargets went to
    // the reminders part and every bell paint threw "_remTargets is not defined" (2026-10-14).
    const owned = new Set(Object.values(own).flatMap((s) => [...s]));
    const orphans = stmts.filter((st) => !core.has(st) && !owned.has(st));
    const pulled = reach(orphans.flatMap((st) => st.names), core, allEntries);
    const shared = [...count].filter(([, c]) => c > 1).map(([st]) => st).concat([...pulled].filter((st) => owned.has(st)));
    orphans.forEach((st) => core.add(st));
    if (!shared.length) break;
    // shared statements join the core, with everything they reach that is not a section's way in
    const more = reach(shared.flatMap((st) => st.names), core, allEntries);
    shared.forEach((st) => core.add(st)); more.forEach((st) => core.add(st));
  }
  const inPart = new Map();
  for (const [p, set] of Object.entries(own)) for (const st of set) inPart.set(st, p);
  const text = (arr) => arr.map((st) => code.slice(st.node.start, st.node.end)).join('\n');
  // Same guard as the customer stubs: a part that loaded without f (an older core fetching a newer
  // part after a deploy) must not leave the stub calling itself forever (bug hunt 2026-10-28).
  // and, as there, each stand-in knows itself by _stubP, so a kept reference called after its part arrived hands over (2026-11-10)
  // One body for every stand-in, _partGo, which reads the name off window (a script's top-level function is a property of
  // it): the ~100 stand-ins each wrote that body out, 2.5 KB gzipped of the desk's core (2026-11-11, item 47).
  const stubs = `function _partGo(f,p,a){const m=_stubP[f];if(window[f]!==m)return window[f](...a);return _loadStaffPart(p).then(()=>{if(window[f]===m)throw new Error(f+' missing from staff part '+p+' - reload the page');return window[f](...a);});}\n`
    + [...entries].map(([f, p]) => `function ${f}(...a){return _partGo(${JSON.stringify(f)},${JSON.stringify(p)},a);}`).join('\n')
    + `\nvar _stubP={${[...entries].map(([f]) => `${f}:${f}`).join(',')}};`;
  const loader = `
// ── The staff half's parts (generated by scripts/split-staff.mjs; do not edit here) ──────────────
// A section's code is in staff-parts/<name>.js; the stand-ins below fetch it and run the real function,
// whose declaration replaces the stand-in. Once the desk has painted, the parts this account can open
// are fetched (_staffPartWanted, 2026-10-09: a desk account no longer runs Analytics, the website
// editor or Vendors on every boot); any other part comes the first time something asks for it.
// A part's strings in the language on screen come with it (lang/staff-<part>-<code>.json; English
// rides inside the part).
var STAFF_PARTS_V={}; // the build stamps {name:contentHash}
var STAFF_PART_LANG_V={}; // the build stamps {name:{code:contentHash}}
var STAFF_PART_UP=${JSON.stringify(Object.fromEntries(Object.entries(up).filter(([c]) => parts[c])))}; // a part inside another: {part:theOther} (STAFF_PART_UP in scripts/split-staff.mjs)
var _staffPartP={},_staffPartsAll=null,_staffPartsDone=false,_staffPartsIdle=false,_partLangP={},_partLangGot={};
// Never rejects: a pack that did not arrive leaves t() answering in English, as the core's packs do.
function _loadPartLang(n,c){
  const v=STAFF_PART_LANG_V[n]&&STAFF_PART_LANG_V[n][c];
  if(!c||c==='en'||!v||_partLangGot[n+':'+c])return Promise.resolve();
  const k=n+':'+c;
  if(!_partLangP[k])_partLangP[k]=fetch('/lang/staff-'+n+'-'+c+'.json?v='+v).then(r=>r.ok?r.json():null).then(d=>{if(d&&typeof d==='object'){LANG_STAFF[c]=Object.assign(LANG_STAFF[c]||{},d);_partLangGot[k]=true;}delete _partLangP[k];}).catch(()=>{delete _partLangP[k];});
  return _partLangP[k];
}
// The strings of every part already asked for, in language c (a language chosen after they came).
function _loadPartLangs(c){return Promise.all(Object.keys(_staffPartP).map(n=>_loadPartLang(n,c)));}
function _partLangsReady(c){return Object.keys(_staffPartP).every(n=>!c||c==='en'||!(STAFF_PART_LANG_V[n]&&STAFF_PART_LANG_V[n][c])||!!_partLangGot[n+':'+c]);}
function _loadStaffPart(n){
  if(_staffPartP[n])return _staffPartP[n];
  // A part inside another (STAFF_PART_UP, 2026-11-11) runs after it: the other comes first, and a failed one lets a later call try again.
  const up=STAFF_PART_UP[n];
  const code=(up?_loadStaffPart(up):Promise.resolve()).then(()=>new Promise((res,rej)=>{
    const s=document.createElement('script');let done=false;
    const fail=why=>{if(done)return;done=true;delete _staffPartP[n];try{s.remove();}catch(e){}rej(new Error(why));};
    const tm=setTimeout(()=>fail('staff part '+n+' did not load in 30 s'),30000);
    s.src='/staff-parts/'+n+'.js?v='+STAFF_PARTS_V[n];s.onload=()=>{if(done)return;done=true;clearTimeout(tm);res();};s.onerror=()=>{clearTimeout(tm);fail('staff part '+n+' did not load');};
    document.head.appendChild(s);
  }),e=>{delete _staffPartP[n];throw e;});
  _staffPartP[n]=Promise.all([code,_loadPartLang(n,_staffLangCode())]).then(()=>{});
  return _staffPartP[n];
}
function _loadStaffParts(){
  if(_staffPartsAll)return _staffPartsAll;
  _staffPartsAll=Promise.all(Object.keys(STAFF_PARTS_V).map(_loadStaffPart)).then(()=>{_staffPartsDone=true;},e=>{_staffPartsAll=null;throw e;});
  return _staffPartsAll;
}
// The parts this account can open (the app's _staffPartWanted; every part where it is missing).
function _loadStaffPartsWanted(){
  if(_staffPartsDone)return Promise.resolve();
  const want=Object.keys(STAFF_PARTS_V).filter(n=>{try{return typeof _staffPartWanted!=='function'||_staffPartWanted(n);}catch(e){return true;}});
  return Promise.all(want.map(n=>_loadStaffPart(n).catch(()=>{}))).then(()=>{if(Object.keys(STAFF_PARTS_V).every(n=>_staffPartP[n]))return _loadStaffParts();});
}
function _staffPartsReady(){return _staffPartsDone;}
try{(window.requestIdleCallback||(f=>setTimeout(f,1200)))(()=>{_staffPartsIdle=true;_loadStaffPartsWanted().catch(()=>{});},{timeout:3000});}catch(e){}
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
// Round 2 (2026-10-09/10, s1010-int, after the perf branch): the staff strings only one part says live in that part
// (partLangKeys) and each account loads only its sections' parts; with the round's features (desk notes, My shift,
// the desk outbox, the kiosk, deposits, house rides, reminders...) measured here at customer 224.1, staff 577.1 and
// core 259.0 KB local. Limits: customer +2, staff +5, core +6 (rounded up). New staff code goes in a part.
// With R7 merged (ride reminders, waitlist offers: the 'remind' part ~9 KB, the rider's /?claim= page ~1.5 KB on the
// customer half) measured 225.8 / 588.2 / 260.8 KB local; the same margins give 228 / 594 / 267.
// With R6 merged (personal data masked until shown: the mask and its look log in the core, ~2.6 KB, since every roster
// row draws through them; History > Data access in the money part) measured 226.4 / 592.8 / 265.3; the same margins give 229 / 598 / 272.
// Staff 598 -> 602 (2026-10-10): Instagram followers on the reports (column, total, average, the builders' line) and
// against the community's average on the accounts lists and the applications' cards, with the members' Instagram ask:
// 596.3 KB here was 599.0 on the runner; +4 restores the margin.
// Customer 229 -> 232 (2026-10-10, the "less AIsh" second pass): the session picker's day headings, the empty My
// Bookings' next ride, the account's sentences in place of its meters: 227.3 KB here, about 228.7 on the runner; +3
// restores the margin.
// staff 606 -> 612 (2026-10-11): sort and filter inside every report (_rpLive) took the last of it, and CI's
// gzip reads ~3 KB more than a Mac's (604.7 here, 607.5 there).
// Customer 232 -> 235 (2026-10-12): Petromin Days, the Petromin tag holders' card and its check (petromin_member):
// 230.9 KB here, about 232.2 on the runner; +3 restores the margin.
// Staff 612 -> 616, core 272 -> 276 (2026-10-14, the bug hunt): ~30 workers' guards and fixes, and the split now keeps in
// the core what core code reached only by name calls (_remTargets, _socLinkHtml, _sessRawTime sat in parts and threw):
// core 271.4 / staff 607.7 here, ~272.7 / ~610 on the runner; +4 each restores the margin.
// Customer 235 -> 238, staff 616 -> 620, core 276 -> 279 (2026-10-17, Defe's places on the Saturday ride): the partner
// ticket line, the members' own-bike limit, ?signin=, the partner chip, filter, report column and Bookings panel:
// customer 233.6 / staff 610.7 / core 274.2 here, 235.0 / 613.3 / 275.3 on the runner; +3 / +4 / +3 restores the margin.
// Customer 247 -> 250 (2026-10-18, the DEFE 5KM Run): its date card, the runner step's filled-in details, the
// "registered for the race?" question and its strings: 245.8 KB here, about 247.1 on the runner; +3 restores the margin.
// Staff 628 -> 632, core 281 -> 284 (2026-10-23, Defe's several codes with their own places): the codes list in the
// Bookings partner panel, its add/remove/save and strings: staff 625.3 / core 279.1 here, 628.0 / ~280.5 on the
// runner (ca0c85b2 was refused at 628.0); +4 / +3 restores the margin.
// Staff 632 -> 634 (2026-10-23, Last login on every account row and as a sort): ~0.7 KB more; +2 keeps the margin.
// Staff 634 -> 641 (2026-10-23, the Victory Lap report builder in the vlap part): ~0.8 KB more; 634.8 here but 637.6 on the
// runner (0e11bb37 was refused at 637), so +7 restores the margin.
// Customer 253 -> 256 (2026-10-23, Petromin's invitation per night): its pop-up before booking, the ticket block and
// strings, on top of Victory Lap's ticket question: 251.9 KB here, 253.5 on the runner (a89901fd was refused); +3
// restores the margin.
// Staff 641 -> 645, core 284 -> 288 (2026-10-23, names for Defe's codes and more Bookings filters and sorts): code, shirt,
// ride group, gender, age, nationality and special needs filters, a Sort by list, and their strings: staff 638.0 / core
// 284.2 here, about +3 / +1.5 on the runner; +4 / +4 restores the margin.
// Staff 645 -> 650 (2026-10-23, the partner (Defe) report builder in the vlap part, 43 strings in each language; the vlap
// part's strings now ride in lang/staff-vlap-<code>.json): about +5.8 KB here, so ~646.5 on the runner; the core gains
// ~0.2 and keeps 288.
// Staff 650 -> 655, core 288 -> 291 (2026-10-23, staff comments on bookings and applications: the thread, the roster's
// mark, the menu row and the cards' line, in the desk core because the roster names them): staff 648.4 / core 287.0 here,
// 650.3 / 288.1 on the runner (23094324 was refused); +5 / +3 restores the margin.
// Staff 655 -> 661 (2026-10-25, Applications: what changed on each pending card, its checks, and Invite / Ask for changes
// on several at once with one sheet of messages, in the community part with 36 strings): staff 657.0 here, so ~659 on the
// runner; the core stays 289.0. +6 restores the margin.
// Staff 661 -> 665, core 291 -> 294 (2026-10-27, the staff panel tidy: one opening for every section, the Bookings figures
// bar and the views under each view's title in the desk core, folded table columns with two sort buttons, Analytics' two
// named rows, the waitlist's fixed slots, the Team report's date guard): staff 657.6 / core 289.3 here, ~659.8 / ~290.6 on
// the runner, inside the 2.5 KB the runner can add; +4 / +3 restores the margin.
// Staff 665 -> 668, core 294 -> 297 (2026-10-28, a staff device's copy of the bookings and the riders moved out of the
// customer half: _syncFetch became an entry point, and the copy - now read whole page by page and kept as it comes - went
// with it into the desk core): customer 254.8 -> 252.8 KB here (0.8 below where it stood before the change), core 291.0 ->
// 293.3 and staff 659.5 -> 661.7 here, ~294.6 / ~663.9 on the runner; a staff device downloads what it did. +3 / +3
// restores the margin.
// Customer 256 -> 258, staff 672 -> 676, core 300 -> 305 (2026-10-28, the staff review's first batch: Close out's paid list,
// early warning and Close's question, the bell's open-nights kind (its NT_KINDS entry and item hook ride in the customer
// half), one card/cash/not-recorded split for every money screen, the Petromin billing period and its rides still out, the
// sticky check-in footer, the search fold with its another-night line, and the walk-in's picked bike type): customer 253.9,
// staff 668.9, core 301.2 here, about 255.3 / 671.0 / 302.5 on the runner; +2 / +4 / +5 restores the margin.
// Customer 258 -> 261 (2026-10-28, the Arena Heros Hybrid Race: its card, its athlete step, its ticket lines and Change
// details, its share-gate words, the privacy notice's rows and 27 strings, all on a rider's page): customer 253.9 -> 257.7 KB
// here, about 259.1 on the runner; +3 restores the margin (staff 670.8, core 301.6 here, inside theirs).
// Staff 676 -> 683, core 305 -> 310 (2026-10-29, the staff review's second batch: VIP, default payment and the walk-up
// house through the server's approval, the second tap on gender and tags, Team's PIN and the deposit's card slip; requests
// not approved kept out of every bulk path, one-tap return, the picker's drawer check-in, emergency contact and No waiver
// yet with the desk's waiver sheet, the places warning; Analytics' three targets, held sessions, billed to companies and
// the Product filter): staff 678.7, core 305.9 here, about 680.8 / 308.0 on the runner; +7 / +5 restores the margin
// (customer 257.7 here, inside its own).
// Staff 706 -> 708, core 316 -> 318: a blood night's filters and sorts (703.3 / 314.7 here; CI reads about 2.2 / 1.6 more).
// 2026-11-05: the Volunteers section, a part of its own, which only its accounts fetch: staff 708 -> 726; customer 275 -> 277 for My Account's volunteering card and the notice's two rows (CI reads about 2.2 / 1.6 more).
// 2026-11-11 staff round s10 (51 items: the desk's bulk writes in one call each and the walk-in in one dialog; one roster
// paint per frame and the row undo gone, an admin's check-in undo in History > Log; the Saturday confirm, Hand the keys'
// payment, Check in all paid and the docked check-in; section headers with More and Desk tools, People's and Sessions'
// Summary, the account window's side panel; one toolbar per office list, declared filters, saved views for more sections,
// People in groups, Team's search; the rail in six groups, the palette, the bell's office kinds, the Dashboard's office
// card and seven nights, the leave-without-saving guard; section rights, accessibility, Arabic rail labels; handover
// notes, incidents and places left by type): staff 936 -> 956, 952.3 KB measured after merging main's Community tab
// rebuild, volunteer enhancements and ticket on top (943.7 after the first merge; each builder alone sat at its budget; the parts carry what they could: close-out, the No-show question, Check in all paid, notes and incidents
// are in the desk part, so the core stays at 338.8, inside 346 unraised). Customer 323.8, inside 326.
// 2026-11-11, the community form rework (the rider password rule with its list of common passwords and one box with
// show/hide, the Privacy Notice's guardian row, the applications' parent or guardian line and the Form drop-off dialog):
// about +1.0 customer and +1.9 staff here; customer 326 -> 328 and staff 939 -> 943 keep the margin.
// 2026-11-11 staff round s10 second batch (D10 checklists, D11 door, per-type caps, follow-ups/WhatsApp log/search operators,
// People parts), merged with main again (sports in the account report builder, the community form rework): staff 956 -> 978,
// 974.5 KB measured + 3 (main alone sat at 943). The customer half (326.1, main's 328) and the desk core (329.1 / 346) are not raised;
// the core went down with People's and the session report's parts (item 47).
// Then staff 978 -> 982: CI reads the staff half about 4.4 KB over a local build (934.9 on 18937aa0 against 930.5 here), so
// 974.5 locally would read about 978.9 on the runner and fail the deploy; 982 keeps about 3 KB of room there.
// Then staff 982 -> 985 with main's account archive merged in (976.9 locally, about 981.3 on the runner).
// 2026-11-12, yoga (Hatha Yoga for Cyclists, a kind of its own inside MicroMobility Experiences: its date card, flow, ticket
// and Details): customer 327.5 here, about 329.5 on the runner (CI reads about 2.0 more); customer 330 -> 332 keeps the margin.
// 2026-11-13, the Farm House Night (a kind of its own inside MicroMobility Experiences: its rust date card with the fanned
// feathers, the family step, the farm skin, the ticket in cream and rust, the featured card): customer 356 -> 358 (353.6 locally,
// 355.7 on the runner); staff 1086 -> 1090 (the family's Approve, the Arrival and Dinner labels: 1081.1 locally, 1086.0 on the runner).
export const SIZE_BUDGET_DEFAULT_KB = { customer: 358, staff: 1090, core: 352 }; // 2026-11-14 customer 347 -> 356 and staff 1076 -> 1086 for the new features build of 2026-11-13/14 (16 items in one release: F1, F2, F3, F4, F10, F11, F12, F13, F15, F16, F19, F21, F23, F25, F26, F27, and the Privacy Notice rows for their data) on top of the staff's mentorship adds (7bb7e61a). Measured locally on the build rebased there: customer half 352.3 KB (main 342.9: the items' loaders, ticket and Account rows and their en/ar words, and the Privacy Notice rows; every item's own screen is one of nine lazy files outside the budget), staff half 1079.7 KB (main 1068.9: the roster marks, Workshop bike reports, learn-to-ride ticks, Helper path, circuit and company challenge editors, mostly in their parts), desk core 343.7 KB (main 341.6, under its 352). CI reads about 2.2 KB more on the customer half (354.5) and 4.6 KB more on the staff half (1084.3), which leaves about 1.5 and 1.7 KB; 2026-11-13 staff 1074 -> 1076 for staff adding mentors and offers by hand (People > Mentorship: Add a mentor, a mentor's Edit, Remove from the programme and Add again, Add an offer on a profile, with 22 words in ten languages): all of it in the peopleapps part (44.7 -> 46.5 KB gzipped), which only accounts opening People's Applications or Mentorship fetch; the staff half is 1068.5 KB locally and CI reads about 4.6 KB more, which would have left 0.9 KB under 1074; the core and the customer half did not move; 2026-11-13 customer 345 -> 347 for the Ironman 70.3 and 140.6 badges (their medals on a red ribbon, the ladder and six words in ten languages, +0.25 KB): the customer half is 342.6 KB locally and CI reads about 2 KB more, inside the 2.5 KB margin of 345; 2026-11-13 staff 1068 -> 1074 for the mentorship programme (People > Mentorship: the student profiles, the offers, proposing, the matches' check-ins, the registered mentors, the add and change dialog and Copy for WhatsApp, with 108 words in ten languages): all of it in the peopleapps part (37.8 -> 44.6 KB), which only accounts opening People's Applications or Mentorship fetch; the staff half is 1066.5 KB locally and CI reads about 4.6 KB more; the core moved 0.03 KB for the part's stand-in, the customer half 0.1 KB for the address; 2026-11-13 staff 1060 -> 1068 for Ask's stage 2 (the five more kinds' editors and results, a right answer where a kind takes one, the presenter's strip of a page staff lead, the board, Duplicate: all of it in the Ask part, 29.7 -> 37.0 KB, which only accounts opening People fetch; the staff half is 1059.7 KB locally and CI reads about 4.6 KB more; the desk core and the customer half did not move); 2026-11-13 staff 1050 -> 1060 for Ask's second pass (the look editor with its swatches and 22 small chart drawings, pictures, who else a page for accounts leaves out, blocked words, the Stats tab with one question group by group, older rounds, the answers read a page at a time: all of it in the Ask part, 17.7 -> 29.7 KB, which only accounts opening People fetch; on top of the Community reach build the staff half is 1052.4 KB locally and CI reads about 4.6 KB more; the core moved 0.2 KB for the open page in the address, the customer half not at all); 2026-11-13 customer 339 -> 345 for the Community tab reach on top of the reports rework (the dot and hub_pulse, the badge and rating pop-ups, the booked challenge, the ticket's ride status and meeting point, Remind me, the two push switches and the Home Screen steps: 341.3 KB locally, about 343.3 on the runner); 2026-11-13 staff 1024 -> 1050, core 346 -> 352 for the reports rework (the user's decision page: three report looks, the viewer inside the site with Print, PDF, Excel and CSV, report numbers and their history, the Reports section with the automatic and the monthly reports, one builder frame with saved setups and its preview, the chart kit and the tables lined up, their words in ten languages): on top of Ask the staff half is 1035.1 KB locally (about 1039.5 on the runner, which reads about 4.4 KB more), the core 341.3 KB, the customer half 334.8 KB. // 2026-11-13 staff 1006 -> 1024 for Ask (/ask: the pages, a page's setup, its answers and results, in a part of their own of 17.7 KB that only accounts opening People fetch; the staff half is 1016.6 KB locally and CI reads about 4.6 KB more; the core moved 0.6 KB for the rail's number, the customer half 0.1 KB for the rail entry and the address); 2026-11-13 customer 337 -> 339 for the Experiences theming picks on top of Featured (the card's marks and its place first, the list's band, kind switch, row tiles and motifs, the Saturday ride's number, sunrise and route, its dawn ticket, the kinds' drawings, with their words in ten languages): about +2.1 KB gzipped here (CI reads about 1.6 more than local). Before that, 2026-11-13 customer 334 -> 337 for Featured (a featured date leads MicroMobility Experiences under its own heading and shows as a card on the event picker; the switch on the session forms): 332.2 locally, 331.2 before; CI read main's customer half at 333.4 on e2187431 (about 2.2 more than here), so this would read about 334.4 there, and 337 keeps about 2.6 KB of room. Before that, 2026-11-12 staff 1001 -> 1006 for the influencer tag (549ae8a7: +0.6 KB; CI read 1001.6 against 997.0 locally, so main had sat at the line since the Petromin invitees and the Talent Scout / Swimming Instructor badges); 2026-11-12 staff 992 -> 1001 for the volunteer report builder (Volunteers > Shifts, Opportunities and an opportunity's menu: one opportunity or several, 44 columns in seven starting sets, six sections, 14 filters, 16 sorts and 8 groupings, PDF and Excel, with its words in ten languages): 994.6 locally, 985.8 before (CI reads about 4.4 more, which would be 999.0); _vrbXlsx moved from the vlap part into the desk core (+1.9 there, 333.9 locally) since two parts now call it. Before that, 2026-11-12 the 2026-11-11 bug hunt's fix round on top of staff round s10 and the yoga session (about 290 findings over the booking and staff app: guards, re-reads, refusals said in ten languages, the locker and till follow-ups): customer 332 -> 334 (330.4 locally, CI reads about 1.6 more), staff 985 -> 992 (985.5 locally, CI reads about 4.4 more); the core stays 346 (331.9 locally). Before that, 2026-11-12 customer 328 -> 330: CI read main's customer half at 328.3 on 0cbc90ad (staff round s10's merge, before this), red and undeployed, and a member's Saturday invite button under the Account tiles adds about 0.1 (326.4 locally; CI reads about 2.0 more, which would be 328.4). Before that, 2026-11-11 staff 936 -> 939 for sports in the account report builder (the Sports and Number of sports columns, Sports in numbers, each sport with its accounts, three charts, three filters and a sort, with their own paged read of the answers; 932.7 locally, 930.5 before; CI read 934.9 on 18937aa0, about 4.4 more, which would have been 937.1). Before that, 2026-11-11 staff 932 -> 936 for the Community tab rebuild's staff side (Activities' Saturday report with its photo and photo rule, Numbers, the challenge badge picker, with their words in ten languages; 929.0 locally, CI read 933.3 on 65cce59e, about 4.3 more). Before that, 2026-11-11 staff 931 -> 932 for the volunteer enhancements' staff side (927.6 local; CI reads ~2-3 KB more); My Bookings after the research round on top of the Reserve page research: customer 323 -> 326 (the cancelled rows, today's large code and the rider's wake lock, the Details fold, Share, the maps choice, the served calendar file, the offline dialog, the saved-copy mark and the View Transition, with their words in ten languages): 322.7 locally, 319.5 before (CI reads about 1.6 more, which would have been 324.3). Before that, 2026-11-11, the Reserve page research built on top of the Petromin form's steps (the owner's seven answers and the twenty rows: Join waitlist, Not sent yet, the booking window's countdown, the place gone question, Change on the review, the bar's total and Back, the promo link, radio groups, the step transitions, the funnel and Analytics > Reserve steps, with their words in ten languages): customer 319 -> 323 (319.5 locally, 316.3 before; CI reads about 1.6 more), staff 929 -> 931 (about 0.3 of it the Reserve steps card and its words; CI reads about 4.3 more). Before that, 2026-11-11, Form steps on the Petromin page (how far riders get on the micromobility.sa/petromin form: the funnel, the fields that stopped a Continue, the server's refusals, Find my booking, cancelling and languages, in the desk core with the page): staff 925 -> 929 (921.9 locally, 920.3 before; CI reads about 4.3 more, which would have been 926.2), core 343 -> 346 (342.0 locally, 340.4 before; CI reads about 1.8 more, which would have been 343.8). Before that, 2026-11-10, the bug hunt's round two (the follow-ups to its database fixes: the tag windows, the paid add-ons lock, the waiver per role, Cancel night's cancelled_at, the refund states, the bulk check-in's discard): staff 922 -> 925 (916.7 locally on top of the Booking card; CI reads about 4.3 more, which would have left 1 KB). Before that, 2026-11-10, Booking card on every booking's menu (the rider's ticket drawn in a frame of its own, its picture to share, save or copy; in the desk part, so the core moves 0.3): staff 919 -> 922 (916.2 locally, 911.8 before; CI reads about 4.3 more, which would have been 920.5). Before that, 2026-11-10, the bug hunt's fix round on top of the account menu (the 2026-11-10 bug hunt's findings over the booking and staff app: the guards, re-reads, undo paths, refusals said and their words in ten languages, and the stand-ins that know themselves): customer 316 -> 319 (315.2 locally, 311.6 before, about 0.8 of it the stand-ins' own map; CI reads about 1.6 more), staff 904 -> 919 (911.3 locally; CI reads about 4.3 more), core 337 -> 343 (338.7 locally; CI reads about 1.8 more). Before that, 2026-11-10, the account menu: customer 312 -> 316 (the rider's Account part as a menu and its pages: the profile card above the switch, the wallet and Invite tiles, rows that say their value or what they lack, thirteen pages with a Save each, the discard question and the side-by-side wide layout, with their words in ten languages): 311.6 locally, 307.8 before (CI reads about 1.6 more, which would have been 313.2). Before that, 2026-11-10, staff 901 -> 904: Assign a locker redrawn (the times as cards, the cabinet's doors, one action, Unassign; moved from the core into the Lockers part, which only the accounts with Lockers fetch at boot): 896.8 locally, 893.9 before (CI reads about 4.3 more, which would have been 901.1); the core went down. Before that, 2026-11-10, the sport question: customer 306 -> 312 ("Do you compete in a sport", Yes / No, the 74 Saudi sports federations and committees by name in English and Arabic, Other with its box and the sports staff add; the Community check-up's pop-up, My Account's card and the notice's row): 307.8 locally, 303.3 before (CI reads about 1.6 more); staff 897 -> 901 for Analytics > Sports we have (figures, eleven charts, the riding table, Add to the list, two CSVs): 893.9 locally, 888.6 before (CI reads about 4.3 more); core 336 -> 337 for the account editor's sport answer on top of the locker card below (CI reads about 1.8 more). Before that, 2026-11-10, core 335 -> 336: the booking's Locker card in its Add-ons dialog with Unassign (332.8 locally, 332.1 before; CI reads ~1.8 more, which would have been 334.6). Before that, 2026-11-10, staff 893 -> 897: staff edit, move, refund and free a locker reservation (the Lockers part, +4 KB with its words; CI reads ~4.3 more than local on the staff half). Before that: 2026-11-10, core 333 -> 335: one staff order for every session list, the five extras and the roster's and Dashboard's marks (+0.5 KB; CI reads ~1.8 more than local in the core). Before that, staff 869 -> 893 and core 331 -> 333: the Store and Payments sections (online payments and the store, staging first; +24 / +2 as measured on their branch), on top of: staff 865 -> 869 and core 327 -> 331: the session picker, marks and labels every staff list shares (+2.8 KB in the core; CI reads ~1.8 more there); before that, staff 859 -> 865 for lockers round two (b83034b1, which CI measured at 853.2 against 853) read 855.0 here and went over 859 on the runner; 865 leaves the runner's few KB over local. 2026-11-10, customer 304 -> 306: the locker terms in a pop-up on the review (English and Arabic, the website's Terms page is not open yet), with the desk card, Change and the ticket's own-locker line (303.3 locally, 301.1 before round two; CI reads about 1.6 more). Lockers round two (the owner's staff list 1-6: scan a rider's show-at-desk QR to hand the keys, tonight's arrivals, the end of the night and its close-out line, the report, items left behind, the maintenance log; and the rider's desk card, Change and terms line): staff 853 -> 859 (854.2 locally, 848.3 before; CI reads about 3.7 more), core 325 -> 327 (323.4 locally, 322.2 before: the hand-keys dialog and the end of the night ride with the scanner and the close-out; CI reads about 1.6 more); the customer half stays 304 (301.9 locally). Before that, 2026-11-09, Assign a locker on every booking's menu and its dialog, the review's waiver sentence and I agree: staff 851 -> 853 (847.4 locally on top of the Volunteers rework, about 1.1 of it this; CI reads about 3.7 more, which would have been 851.1). Before that, 2026-11-09, the volunteer rework on top of lockers and the move: the staff Volunteers section rebuilt (Applications, the team lead, rewards on each row and under Hours and rewards) and the VL- code kind for riders; 300.0 / 846.3 locally (CI reads about 1.6 / 3.7 more). Before that, 2026-11-09, the move to experiences.micromobility.sa (the page's first script takes in what a former address handed over; the live hosts read from site.config.json): customer 302 -> 303 (about 0.4 of it this, on top of lockers; CI reads about 1.6 more). Before that, 2026-11-09, lockers (the review's Locker block, a ticket's Locker lines, ?locker= tag taps; the desk's Locker line at check-in, a locker's sheet, renting to a walk-up, and the Lockers section in its own part): customer 299 -> 302 (299.2 locally, 296.8 before; CI reads about 1.6 more), staff 834 -> 844 (838.8 locally, 827.2 before; CI reads about 3.7 more); the core stays 325 (320.3 locally). Before that, 2026-11-09, Add a booking takes a booking by its number or name again (the box under the scanner's run): staff 832 -> 834 (827.1 locally, about 0.6 of it this; CI reads about 3.7 more). Before that, 2026-11-08, badge requests' second round (the Badge requests section with its pills, search and filters; Give and Decline clear the proof): staff 829 -> 832 (824.9 locally, about 1.0 of it this; CI read 827.6 on 4904aac2, about 3.7 over local). Before that, 2026-11-08, referrals' friend half and the code each booking used (the friend's own code on the event picker, the Invite card and the bike step, where it comes off by itself; the code kinds' marks, chips and names; the ticket's code line): customer 296 -> 299 (295.4 locally, 292.6 before; CI read 297.0 on 7cf0cad8, about 1.6 more). Before that, 2026-11-08, the part-timers' hours at a JCC or Petromin close-out: staff 826 -> 829 (822.8 locally on top of badge requests; CI reads about 3.3 more, which would have been 826.1). Before that, 2026-11-08, badge requests (the rider's Request a badge button, the popup's request line and its dialog with a comment and a picture or PDF proof, the notice's row; staff's requests in People > Badges): customer 294 -> 296 (292.5 locally, 289.7 before; CI reads about 1.6 more), staff 824 -> 826 (819.3 locally, 817.1 before; CI reads about 3.3 more). Before that, 2026-11-08, the referral extras (the free ride said once on the device and its last days, the Recruiter badge and the fifth friend's bonus, the device check, People > Referrals): customer 292 -> 294 (289.6 locally, 288.2 before; CI reads about 1.6 more), staff 819 -> 824 (815.8 locally on top of the Bookings roster's round two, about 1.7 of it these extras; CI reads about 3.3 more). Before that, 2026-11-08, rider round two (the home band and greeting, the day switch, the booked moment, the radio cancel dialog, the two bars that read what is under them; about 2.4 KB gzipped): customer 290 -> 292, 288.2 locally with the Saturday ride codes, CI reads about 1.6 more (291 would leave 1.2 KB). 2026-11-08, the Saturday ride codes (their Bookings summary, the Edit codes dialog, the Ride code filter and column): staff 815 -> 819 (811.1 locally with referrals, CI reads about 3.3 more). Before that, 2026-11-08, referrals (the Invite friends card, ?ref= links and the referral free rides beside the blood ones; the account window's Referral section and Settings' Referrals card): customer 287 -> 290 (285.2 locally, 282.8 before; CI reads about 1.6 more), staff 811 -> 815 (806.1 locally, 804.2 before; CI reads about 3.3 more). Before that, 2026-11-07, the staff review of 2026-11-06 (98 items over Bookings, Sessions, People, Volunteers and the shell): customer 282 -> 287 (282.8 locally, CI reads about 1.6 more), staff 748 -> 811 (803.4 locally, CI reads about 3.3 more); the core stays 325 (317.9 locally: the account window's profile pieces ride in the People part, by name). Before that, staff 748 -> 754: Bookings from the 2026-11-06 staff review (offline times, who checked in and out, who has a rider open, Owing, scan to return; 746.1 locally, CI reads about 3.3 more). staff 742 -> 748: Sessions became a section of its own (figures, table, filters, Customize, bulk changes, CSVs) in its own part, 744.0 locally (CI reads about 3.3 more); the desk core fell from 322.6 to 289.4 with renderSessions out of it. customer 280 -> 282: the Blood Donation free ride code on the event picker and its Redeem box (e08aaa2c measured 280.7 on the runner, 279.1 locally, CI reads about 1.6 more). staff 738 -> 742: 533ce4f9 measured 738.7 on the runner (735.4 locally, so CI now reads about 3.3 more), main went red. staff 733 -> 738: Volunteers > Shifts, a session's volunteers run like Bookings (734.3 locally). staff 730 -> 733, core 322 -> 325: staff add a donor or visitor by hand on a Blood Donation session (727.8 / 321.3 locally, CI reads about 2.2 / 1.6 more). staff 728 -> 730, core 320 -> 322: the staff's editor for a Blood Donation registration (725.0 / 318.6 locally, CI reads about 2.2 / 1.6 more). Before that, customer 277 -> 280, staff 726 -> 728, core 318 -> 320: the Blood Donation event's donor or visitor question, its club or community question and forced pop-up, the role on the staff list (276.4 / 722.7 / 316.3 locally, CI reads about 1.6 / 2.2 / 1.6 more). Before that, staff 702 -> 706: the Challenges tips and telling every rider moved up (699.7 locally, CI reads about 2.2 more). Before that, staff 698 -> 702, core 313 -> 316: the staff review's leftovers, built 2026-11-04 (694.3 and 311.1 locally before the sessions part; CI reads about 2.2 and 1.3 more). Before that, customer -> 275, core 311 -> 313: the Blood Donation event, its poster kept out in assets/blood-info.json (271.4 and 310.0 here, the runner read 273.0 and 311.6); staff 695 -> 698: the wallet at the Sales till (2026-11-03; 691.8 here, the runner reads about 3.4 more). Before: customer 266 -> 268, staff 691 -> 695: the Community page's activities, their staff screens and the runner's 1-2 KB over local (2026-11-03); // customer 263 -> 266, staff 687 -> 691, core 310 -> 311 (the runner reads 1-2 KB over local): member titles and the Community page in ten languages (2026-11-02); // customer 261 -> 263: the Arena race's transfer and its nine languages (2026-11-02; 259.8 local, ~261.1 on the runner); staff 683 -> 687: the Arena race's receipts on the staff side measured 683.3 on the runner (679.8 local)
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
// raw values; everything else says var(--name). Since round two (2026-11-08) the wider colour
// functions are refused too: oklch(), oklab(), lab(), lch(), hwb() and color() (not color-mix(),
// which mixes tokens).
export const CUSTOMER_SYSTEM_START = 'CUSTOMER SYSTEM (2026-09-30)';
export const CUSTOMER_SYSTEM_END = 'END CUSTOMER SYSTEM';
const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(/;
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
    if (RAW_COLOUR.test(value)) {
      offenders.push({ prop, value: value.trim(), line: firstLine + block.slice(0, m.index).split('\n').length - 1 });
    }
  }
  return { found: true, offenders };
}

// ── The kinds' colour sets (2026-11-13, the owner's pick C1 on the Experiences theming page) ──────────────────────
// Each kind's set lives in the customer system's tokens: --k-<kind> (its accent, read as text on white), --k-<kind>-tint
// and --k-<kind>-ink (the text and marks drawn on that tint). Both pairs must reach 4.5:1 (WCAG 2.2 AA, small text), so a
// colour picked by eye cannot slip under it. Answers the sets found and the pairs that fall short.
const relLum = (hex) => {
  const h = hex.replace('#', ''), v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
export const contrastRatio = (a, b) => { const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export function checkKindContrast(css) {
  const a = css.indexOf(CUSTOMER_SYSTEM_START);
  const b = a < 0 ? -1 : css.indexOf(CUSTOMER_SYSTEM_END, a);
  const block = a < 0 || b < 0 ? '' : css.slice(a, b);
  const tok = {};
  for (const m of block.matchAll(/--k-([a-z]+)(-tint|-ink)?\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)) tok[m[1] + (m[2] || '')] = m[3];
  const kinds = Object.keys(tok).filter((k) => !k.includes('-'));
  const short = [];
  for (const k of kinds) {
    const pairs = [[`--k-${k} on white`, tok[k], '#FFFFFF'], [`--k-${k}-ink on --k-${k}-tint`, tok[`${k}-ink`], tok[`${k}-tint`]]];
    for (const [what, fg, bg] of pairs) {
      if (!fg || !bg) { short.push({ what, ratio: 0, why: 'missing' }); continue; }
      const r = contrastRatio(fg, bg);
      if (r < 4.5) short.push({ what, ratio: Math.round(r * 100) / 100 });
    }
  }
  return { kinds, short };
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
