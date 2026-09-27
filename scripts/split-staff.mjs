// The staff half of the app, split off at build time (2026-09-27).
//
// One file serves customers and staff, and a customer's phone used to download all of it: 450 KB
// gzipped, of which about two thirds - the roster, check-in, sales, inventory, analytics, the
// website editor - is code only a staffer ever runs. This module cuts the built page's main script
// in two:
//
//   - the CUSTOMER half stays inline in index.html: every top-level statement a customer's page can
//     reach, found by walking references from the roots - the statements that run at load, the
//     on*="..." handlers in the page's own markup, the head's small scripts - through function
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
import * as acorn from 'acorn';

/** Functions the customer half calls into staff through. Add here when the build says so. */
export const STAFF_ENTRY = [
  'goStaff', 'openPinModal', '_staffHostGate', // the way in: these always fetch the staff half
  'setStaffTab', 'renderStaffTabs', '_renderStaffTab', '_bgRenderStaffTab',
  'renderStaffQueue', 'renderSessions', 'renderBikes', 'renderHistory', 'renderAnalytics', 'renderInventory',
  'renderCashier', 'renderCommunity', 'renderWebsite', 'renderCatalog', 'renderWorkshop', 'renderMessages',
  'renderAmbassadors', 'renderTeam', 'renderDashboard', 'renderLogs',
  'renderModal', 'renderCheckinModal', '_ntSync', '_tbRender',
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
  const tag = html.indexOf('<script defer src="/vendor/supabase-js');
  const open = html.indexOf('<script>', tag) + '<script>'.length;
  const close = html.indexOf('\n</script>', open) + 1;
  if (tag < 0 || open < '<script>'.length || close < 1) throw new Error('split-staff: the main script was not found');
  const code = html.slice(open, close);
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
  const notFn = stubbed.filter((n) => decl.get(n).node.type !== 'FunctionDeclaration');
  if (notFn.length) throw new Error(`split-staff: ${notFn.join(', ')} must be plain function declarations to be entry points`);
  const missing = STAFF_ENTRY.filter((n) => !decl.has(n));
  if (missing.length) throw new Error(`split-staff: STAFF_ENTRY names ${missing.join(', ')} do not exist`);

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
function _staffWanted(){try{if(S.view==='staff'||_isStaffHost()||localStorage.getItem('cq_staff')==='1'||sessionStorage.getItem('cq_staff_entry')==='1')return true;const q=new URLSearchParams(location.search);if(q.has('staff')||q.has('bike'))return true;const p=_parsePath(location.pathname);return !!(p&&p.view==='staff');}catch(e){return false;}}
function _loadStaff(){
  if(_staffP)return _staffP;
  _staffP=new Promise((res,rej)=>{const s=document.createElement('script');s.src=STAFF_JS;s.onload=()=>res();s.onerror=()=>{_staffP=null;rej(new Error('staff.js did not load'));};document.head.appendChild(s);});
  return _staffP;
}
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
