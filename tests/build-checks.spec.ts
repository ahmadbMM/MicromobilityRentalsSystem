import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Node-side checks of the source and the built files: no browser, no server. They run the same
// functions the build runs (scripts/split-staff.mjs), so a regression is caught even when nobody ran
// `npm run build:html` - CI's stale-build check covers the generated files, this covers the rules.
// The module is an ES module outside the TypeScript program (tsconfig includes tests/ only), imported
// the way tests/pages-functions.spec.ts imports the wallet signer.

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

type Offender = { name: string; line: number; how: string; why: string; text: string };
type WriteSite = { table: string; op: string; line: number; text: string };
type Checks = {
  STAFF_ENTRY: string[];
  SIZE_BUDGET_DEFAULT_KB: { customer: number; staff: number };
  FIRE_AND_FORGET: string;
  resolveIncludes(text: string, root?: URL): Promise<string>;
  globalFunctionNames(html: string): Set<string>;
  checkHandlerNames(raw: string, resolved?: string): { offenders: Offender[]; checked: number; dynamic: number; declared: number };
  formatHandlerOffenders(r: { offenders: Offender[] }): string;
  checkBareWrites(raw: string): { total: number; checked: number; log: number; marker: number; returned: WriteSite[]; self: WriteSite[]; bare: WriteSite[] };
  formatBareWrites(r: ReturnType<Checks['checkBareWrites']>, limit?: number): string;
  gzipBytes(text: string | Buffer): number;
  checkSizeBudget(
    bytes: { customer: number; staff: number },
    env?: Record<string, string | undefined>,
  ): { rows: { half: string; bytes: number; kb: number; limitKb: number; over: boolean }[]; over: unknown[]; text: string };
  checkCustomerColors(css: string): { found: boolean; offenders: { prop: string; value: string; line: number }[] };
  checkNoEmoji(text: string): { line: number; ch: string; text: string }[];
};
const load = () => import('../scripts/split-staff.mjs' as string) as Promise<Checks>;

/** A page shaped like the app's: the main script follows the supabase-js tag and closes on its own line. */
const page = (script: string, markup = '') =>
  `<!doctype html><html><body>${markup}\n<script defer src="/vendor/supabase-js-0.js"></script>\n<script>\n${script}\n</script>\n</body></html>`;

test.describe('@build build checks', () => {
  test('every handler in app.src.html names a top-level function', async () => {
    const { checkHandlerNames, formatHandlerOffenders, resolveIncludes } = await load();
    const raw = read('app.src.html');
    const r = checkHandlerNames(raw, await resolveIncludes(raw, new URL(`file://${ROOT}/`)));
    expect(r.checked, 'the check read the handlers').toBeGreaterThan(500);
    expect(r.declared, 'the check read the declarations').toBeGreaterThan(500);
    expect(r.offenders, formatHandlerOffenders(r)).toEqual([]);
  });

  test('the handler check catches a misspelt name in every place a name is written', async () => {
    const { checkHandlerNames } = await load();
    const script = [
      "const _ON_TYPES=['click','input','change'];",
      'function esc(s){return s}',
      'function _on(...spec){return esc(JSON.stringify(spec));}',
      'function good(){} function alsoGood(){} function _on_backdropOnly(){} function closeIt(){}',
      'function render(cond){return `<b data-on-click="${_on(\'good\',1)}" data-on-input="${_on(cond?\'alsoGood\':\'nope1\')}"></b>'
        + '<i data-on-click="${_on([\'good\'],[\'nope2\',2])}"></i>'
        + '<u data-on-click="${_on(\'_on_backdropOnly\',_EV,_EL,\'nope3\')}" data-on-change="${_on(\'_on_backdropOnly\',_EV,_EL,\'closeIt\')}"></u>'
        + '<s data-on-click="${_on(dynamicName, 1)}"></s>`;}',
      "function concat(){return '<a data-on-click=\"'+_on('good')+'\"></a>';}",
      "// _on('inAComment') and data-on-click='[\"inAComment\"]' are not handlers",
    ].join('\n');
    const markup = '<button data-on-click=\'["good"]\'></button><button data-on-click=\'["nope4"]\'></button>'
      + '<button data-on-focus=\'["good"]\'></button><button data-on-click=\'not json\'></button>'
      + '<button data-on-click=\'[["good"],["nope5",true]]\'></button><!-- <button data-on-click=\'["inAComment"]\'></button> -->';
    const r = checkHandlerNames(page(script, markup));
    expect(r.offenders.map((o) => o.name).sort()).toEqual(['focus', 'nope1', 'nope2', 'nope3', 'nope4', 'nope5', 'not json'].sort());
    expect(r.offenders.find((o) => o.name === 'focus')?.why).toContain('_ON_TYPES');
    expect(r.offenders.find((o) => o.name === 'not json')?.why).toContain('JSON');
    expect(r.offenders.find((o) => o.name === 'nope3')?.how).toContain('_on_backdropOnly');
    expect(r.dynamic, 'a variable as the name is left alone').toBe(1);
    for (const o of r.offenders) expect(o.line, o.name).toBeGreaterThan(0);
  });

  test('every STAFF_ENTRY name is a plain top-level function declaration', async () => {
    const { STAFF_ENTRY, globalFunctionNames, resolveIncludes } = await load();
    const declared = globalFunctionNames(await resolveIncludes(read('app.src.html'), new URL(`file://${ROOT}/`)));
    expect(STAFF_ENTRY.filter((n) => !declared.has(n))).toEqual([]);
  });

  test('the write check tells a checked write from a bare one', async () => {
    const { checkBareWrites, formatBareWrites, FIRE_AND_FORGET } = await load();
    const script = [
      "async function a(){ await _wr(sb.from('t1').update({x:1}).eq('id',1),'ctx'); }",
      "async function b(){ const res=await sb.from('t2').insert({}); if(_writeErr(res,'ctx'))return; }",
      "async function c(){ try{await sb.from('t3').delete().eq('id',1);}catch(e){} }",
      `async function d(){ await sb.from('t4').update({}).eq('id',1); } ${FIRE_AND_FORGET}: a best-effort touch`,
      "function e(){ sb.from('staff_actions').insert({}).then(()=>{}); }",
      "async function f(){ const{error}=await sb.from('t5').update({}); if(error)return; }",
      "async function g(){ const calls=[]; [1,2].forEach(i=>calls.push(sb.from('t6').update({i}).eq('id',i))); const res=await Promise.all(calls); if(_writeErr(res,'ctx'))return; }",
      "async function h(){ return sb.from('t7').update({}).eq('id',1); }",
      "async function i(){ await Promise.all([1].map(x=>sb.from('t8').delete().eq('id',x))).catch(()=>{}); }",
      "async function j(){ let q=sb.from('t9').update({}).eq('id',1); q=q.select('id'); const r=await q; if(_writeErr(r,'ctx'))return; }",
      "// sb.from('t10').update({}) in a comment is not a write",
    ].join('\n');
    const r = checkBareWrites(page(script));
    expect(r.total).toBe(10);
    expect(r.checked, 'a, b, g and j').toBe(4);
    expect(r.bare.map((w) => w.table).sort()).toEqual(['t3', 't8']);
    expect(r.self.map((w) => w.table)).toEqual(['t5']);
    expect(r.marker).toBe(1);
    expect(r.log).toBe(1);
    expect(r.returned.map((w) => w.table)).toEqual(['t7']);
    const text = formatBareWrites(r);
    expect(text).toContain('WARNING');
    expect(text).toContain(FIRE_AND_FORGET);
    expect(text).toContain('t3.delete');
    expect(formatBareWrites({ ...r, bare: [], self: [] })).not.toContain('WARNING');
  });

  test('the write check reads app.src.html (a warning, not a gate)', async () => {
    const { checkBareWrites, formatBareWrites } = await load();
    const r = checkBareWrites(read('app.src.html'));
    expect(r.total).toBeGreaterThan(100);
    expect(r.checked).toBeGreaterThan(50);
    test.info().annotations.push({ type: 'bare writes', description: formatBareWrites(r, 0).split('\n')[0] });
  });

  test('the customer system keeps its colours in its tokens', async () => {
    const { checkCustomerColors } = await load();
    const r = checkCustomerColors(read('styles.css'));
    expect(r.found).toBe(true);
    expect(r.offenders).toEqual([]);
    const css = [
      '/* CUSTOMER SYSTEM (2026-09-30) - a raw #abc in a comment is fine */',
      'body:not(.view-staff){--ink:#1A1919;--scrim:rgba(0,0,0,.5);}',
      'body:not(.view-staff) .x{color:#123456;background:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.2);}',
      '/* END CUSTOMER SYSTEM */',
      '.after{color:#fff;}',
    ].join('\n');
    const bad = checkCustomerColors(css);
    expect(bad.offenders.map((o) => o.prop)).toEqual(['color', 'box-shadow']);
    expect(bad.offenders.every((o) => o.line === 3)).toBe(true);
    expect(checkCustomerColors('.no-block{color:#fff}').found).toBe(false);
  });

  test('no emoji anywhere in the source: icons are drawn', async () => {
    const { checkNoEmoji } = await load();
    expect(checkNoEmoji(read('app.src.html'))).toEqual([]);
    const found = checkNoEmoji(['const a = "Paid \u2713";', "toast('Happy birthday \u{1F382}');", '// a comment \u{1F6B2}', 'ok \u2605 \u2715']
      .join('\n'));
    expect(found.map((f) => f.line)).toEqual([2, 3]);
  });

  test('the two halves stay within the gzip budget', async () => {
    const { checkSizeBudget, gzipBytes } = await load();
    const bytes = {
      customer: gzipBytes(readFileSync(resolve(ROOT, 'index.html'))),
      staff: gzipBytes(readFileSync(resolve(ROOT, 'staff.js'))),
    };
    const r = checkSizeBudget(bytes, process.env);
    test.info().annotations.push({ type: 'size', description: r.text });
    expect(r.over, r.text).toEqual([]);
  });

  test('the budget is read from the environment and says what is over', async () => {
    const { checkSizeBudget, SIZE_BUDGET_DEFAULT_KB } = await load();
    const big = { customer: (SIZE_BUDGET_DEFAULT_KB.customer + 1) * 1000, staff: 1000 };
    const r = checkSizeBudget(big, {});
    expect(r.over.map((x) => (x as { half: string }).half)).toEqual(['customer']);
    expect(r.text).toContain('OVER');
    expect(checkSizeBudget(big, { SIZE_BUDGET_CUSTOMER_KB: String(SIZE_BUDGET_DEFAULT_KB.customer + 2) }).over).toEqual([]);
    expect(checkSizeBudget({ customer: 1000, staff: 2000 }, { SIZE_BUDGET_STAFF_KB: '1' }).over.map((x) => (x as { half: string }).half)).toEqual(['staff']);
    expect(() => checkSizeBudget(big, { SIZE_BUDGET_STAFF_KB: 'lots' })).toThrow(/SIZE_BUDGET_STAFF_KB/);
  });
});

test('every fonts.css the built halves ask for carries the file\'s hash: the print windows are drawn by staff.js', () => {
  // /fonts/ is cached as immutable for a year, so a link without the hash could keep an old copy that
  // long; the report and receipt windows' links live in the staff half, which the build once skipped.
  for (const rel of ['index.html', 'staff.js']) {
    const refs = read(rel).match(/fonts\/fonts\.css[^"'`\s)]*/g) || [];
    expect(refs.length, rel).toBeGreaterThan(0);
    for (const r of refs) expect(r, rel).toMatch(/^fonts\/fonts\.css\?v=[a-f0-9]{10}$/);
  }
});
