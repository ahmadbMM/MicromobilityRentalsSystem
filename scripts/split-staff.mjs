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
  'renderStaffQueue', 'renderSessions', 'renderBikes', 'renderHistory', 'renderAnalytics', 'renderInventory',
  'renderCashier', 'renderCommunity', 'renderWebsite', 'renderCatalog', 'renderWorkshop', 'renderMessages',
  'renderAmbassadors', 'renderTeam', 'renderDashboard', 'renderLogs',
  'renderModal', 'renderCheckinModal', '_ntSync', '_tbRender',
  'doUndo', '_ucPrompt', // the topbar's Undo and the admin's undo-code question (2026-09-28)
  '_tpMsgOpen', // the account editor's temporary-password message (2026-09-29): its save is customer-half code
  // The staff top bar's search (2026-09-29): Ctrl/Cmd+K is listened for at load, and through the
  // search every account's history and the whole account editor were reached from the customer
  // half - about 116 statements a customer's page carried and could never run (the listener
  // answers only in the staff view, where staff.js is loaded).
  '_gsOpen',
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
 * passes a placeholder and replaces it.
 */
export function splitStaff(html, staffUrl) {
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
var _staffP=null;
var STAFF_JS=${JSON.stringify(staffUrl)}; // var, and this block leads the script: the boot calls _loadStaff before the script has finished running
// The stored marks and the address first, S.view last: this runs at the top of the script too
// (the early load below), before S exists, and the try answers false only when nothing else did.
function _staffWanted(){try{if(localStorage.getItem('cq_staff')==='1'||sessionStorage.getItem('cq_staff_entry')==='1'||_isStaffHost())return true;const q=new URLSearchParams(location.search);if(q.has('staff')||q.has('bike'))return true;const p=_parsePath(location.pathname);if(p&&p.view==='staff')return true;return S.view==='staff';}catch(e){return false;}}
// A script that neither loads nor errors (a proxy that swallows it, a tab frozen mid-download)
// used to hold the boot forever: after 30 s the promise rejects and a later call may try again.
function _loadStaff(){
  if(_staffP)return _staffP;
  _staffP=new Promise((res,rej)=>{
    const s=document.createElement('script');let done=false;
    const fail=why=>{if(done)return;done=true;_staffP=null;try{s.remove();}catch(e){}rej(new Error(why));};
    const tm=setTimeout(()=>fail('staff.js did not load in 30 s'),30000);
    s.src=STAFF_JS;s.onload=()=>{if(done)return;done=true;clearTimeout(tm);res();};s.onerror=()=>{clearTimeout(tm);fail('staff.js did not load');};
    document.head.appendChild(s);
  });
  return _staffP;
}
// A staff device starts the download here, at the top of the script, instead of after the whole
// customer half has parsed and run to the boot: the two files come down side by side.
try{if(_staffWanted())_loadStaff().catch(()=>{});}catch(e){}
${stubs}
`;
  const customerCode = loader + '\n' + text(customer); // the loader first: the boot, further down, awaits it before the script has finished
  const staffCode = '// The staff half of the booking app: generated by scripts/split-staff.mjs from app.src.html, never edited by hand.\n' + text(staff) + '\n';
  return {
    html: html.slice(0, open) + '\n' + customerCode + html.slice(close),
    staff: staffCode,
    report: { customerBytes: customerCode.length, staffBytes: staffCode.length, customerStmts: customer.length, staffStmts: staff.length, stubs: stubbed },
  };
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
export const SIZE_BUDGET_DEFAULT_KB = { customer: 250, staff: 270 };
export const SIZE_BUDGET_ENV = { customer: 'SIZE_BUDGET_CUSTOMER_KB', staff: 'SIZE_BUDGET_STAFF_KB' };

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
  const rows = ['customer', 'staff'].map((half) => {
    const raw = env[SIZE_BUDGET_ENV[half]];
    const limitKb = raw === undefined || raw === '' ? SIZE_BUDGET_DEFAULT_KB[half] : Number(raw);
    if (!Number.isFinite(limitKb) || limitKb <= 0) throw new Error(`build: ${SIZE_BUDGET_ENV[half]}=${JSON.stringify(raw)} is not a size in KB`);
    const b = bytes[half];
    if (!Number.isFinite(b)) throw new Error(`build: no byte count for the ${half} half`);
    return { half, bytes: b, kb: b / 1000, limitKb, over: b > limitKb * 1000 };
  });
  const label = { customer: 'customer half (index.html)', staff: 'staff half (staff.js)' };
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
