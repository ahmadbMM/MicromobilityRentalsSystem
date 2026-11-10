// Every confirmDialog({...}) and askConfirm({...}) call names its confirm button's style (staff round s10, 2026-11-10).
// confirmDialog used to paint the confirm button red unless the caller passed a class, so a harmless "Save changes?" that
// forgot one asked like a delete. The default is the neutral btn-primary now, and each call says what it means: a
// destructive ask (delete, remove, cancel a booking, leave without saving) passes confirmClass:'btn-red', any other
// passes 'btn-primary' (or another class). A call without confirmClass, or whose argument is not an object literal the
// check can read, fails the build.
//
// Usage: node scripts/check-confirm-class.mjs   (exit 1 on any offender); the build runs it too (build-html.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { mainScript, stripIncludes } from './split-staff.mjs';

const NAMES = new Set(['confirmDialog', 'askConfirm']);

/** The calls in `code` (a script) that name no confirmClass: [{name, line}] (line within the script). */
export function confirmClassOffenders(code) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const out = [];
  let calls = 0;
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && NAMES.has(n.callee.name)) {
      calls++;
      const a = n.arguments[0];
      // an object literal naming confirmClass, or a ?: between two such literals
      const named = (o) => !!o && (o.type === 'ConditionalExpression' ? named(o.consequent) && named(o.alternate)
        : o.type === 'ObjectExpression' && o.properties.some((p) => p.type === 'Property' && !p.computed
          && ((p.key.type === 'Identifier' && p.key.name === 'confirmClass') || (p.key.type === 'Literal' && p.key.value === 'confirmClass'))));
      const ok = named(a);
      // askConfirm hands its own confirmClass on to confirmDialog: that one call is the plumbing, not a caller.
      const plumbing = a && a.type === 'ObjectExpression' && a.properties.some((p) => p.type === 'Property' && p.shorthand && p.key.name === 'confirmClass');
      if (!ok && !plumbing) out.push({ name: n.callee.name, line: n.loc.start.line });
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);
  return { calls, offenders: out };
}

/** Reads app.src.html and checks its main script; lines are app.src.html's own. */
export function checkConfirmClass(html) {
  const text = stripIncludes(html);
  const { code, open } = mainScript(text);
  const base = text.slice(0, open).split('\n').length - 1;
  const r = confirmClassOffenders(code);
  return { calls: r.calls, offenders: r.offenders.map((o) => ({ ...o, line: o.line + base })) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = checkConfirmClass(readFileSync(new URL('../app.src.html', import.meta.url), 'utf8'));
  if (r.offenders.length) {
    console.error(`check-confirm-class: ${r.offenders.length} confirmDialog/askConfirm call(s) name no confirmClass. Pass confirmClass:'btn-red' for a destructive ask, 'btn-primary' otherwise:\n${r.offenders.map((o) => `  app.src.html:${o.line} ${o.name}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`check-confirm-class: OK, ${r.calls} confirmDialog/askConfirm calls each name their confirm button's class`);
}
