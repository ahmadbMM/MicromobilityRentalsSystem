import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Node-side checks of the source and the built files: no browser, no server. They run the same
// functions the build runs (scripts/split-staff.mjs), so a regression is caught even when nobody ran
// `npm run build:html` - CI's stale-build check covers the generated files, this covers the rules.
// The module is an ES module outside the TypeScript program (tsconfig includes tests/ only), imported
// the way tests/pages-functions.spec.ts imports the wallet signer.

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
// The staff half's section files (staff-parts/, 2026-10-01), each with its own text.
const partFiles = () => readdirSync(resolve(ROOT, 'staff-parts')).filter((f) => f.endsWith('.js')).map((f) => `staff-parts/${f}`);
const staffAllText = () => [read('staff.js'), ...partFiles().map(read)].join('\n');

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
    bytes: { customer: number; staff: number; core?: number },
    env?: Record<string, string | undefined>,
  ): { rows: { half: string; bytes: number; kb: number; limitKb: number; over: boolean }[]; over: unknown[]; text: string };
  checkCustomerColors(css: string): { found: boolean; offenders: { prop: string; value: string; line: number }[] };
  checkNoEmoji(text: string): { line: number; ch: string; text: string }[];
  includedFiles(text: string): string[];
  checkPhoneRulesVersion(src: string, rulesJson: string): string | null;
  staffOnlyLangKeys(keys: string[], customerText: string, staffText: string): Set<string>;
  customerCss(css: string, customerText: string, staffText: string): { css: string; kept: number; dropped: number; droppedBytes: number };
  cssTokens(css: string): { kind: string; text: string }[];
  checkFieldNames(raw: string, only?: Set<string> | null): { total: number; named: number; unnamed: { line: number; tag: string; fn: string; text: string }[] };
  formatFieldNames(r: ReturnType<Checks['checkFieldNames']>, limit?: number): string;
};
const load = () => import('../scripts/split-staff.mjs' as string) as Promise<Checks>;

/** A page shaped like the app's: the main script follows the supabase-js tag and closes on its own line. */
const page = (script: string, markup = '') =>
  `<!doctype html><html><body>${markup}\n<script defer src="/vendor/supabase-js-0.js"></script>\n<script>\n${script}\n</script>\n</body></html>`;

test.describe('@build build checks', () => {
  test('the field-name check tells a named field from an unnamed one, and lists the unnamed', async () => {
    const { checkFieldNames, formatFieldNames } = await load();
    const script = [
      'function staffForm(){return`',
      '<label for="a">A</label><input id="a">',          // label for
      '<label>B <input type="text"></label>',             // wrapped
      '<input aria-label="${esc(t(\'c\'))}" type="number">', // aria-label, with a > inside ${}
      '<select aria-labelledby="x"></select>',
      '<input type="hidden" name="h"><button type="button">ok</button><input type="submit">',
      '<label>D</label><input id="d" placeholder="D">',   // a label that names nothing, a placeholder: unnamed
      '<textarea data-on-input="${_on(\'f\',x=>x>1)}"></textarea>', // unnamed
      '`;}',
      'function customerForm(){return`<input id="z">`;}',
    ].join('\n');
    const r = checkFieldNames(page(script), new Set(['staffForm']));
    expect(r.total).toBe(6);
    expect(r.unnamed.map((x) => x.tag)).toEqual(['input', 'textarea']);
    expect(r.unnamed.every((x) => x.fn === 'staffForm')).toBe(true);
    expect(formatFieldNames(r)).toContain('WARNING - 2 of 6 staff form field(s)');
    expect(checkFieldNames(page(script), null).unnamed.length, 'without a filter the customer field counts too').toBe(3);
  });

  test('every staff popup in app.src.html has a name (aria-label or aria-labelledby)', async () => {
    const raw = read('app.src.html');
    const unnamed = [...raw.matchAll(/<[a-z]+\b[^<>]*role="dialog"[^<>]*>/g)].map((m) => m[0]).filter((tag) => !/aria-label(?:ledby)?=/.test(tag));
    expect(unnamed).toEqual([]);
    // and each aria-labelledby points at an id that is written somewhere
    for (const m of raw.matchAll(/role="dialog"[^<>]*aria-labelledby="([\w-]+)"/g)) expect(raw.includes(`id="${m[1]}"`), m[1]).toBe(true);
  });

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

  test('no emoji in the files app.src.html includes either', async () => {
    const { checkNoEmoji, includedFiles } = await load();
    const files = includedFiles(read('app.src.html'));
    expect(files.length, 'the include markers were read').toBeGreaterThan(0);
    for (const f of files) expect(checkNoEmoji(read(f)), f).toEqual([]);
    expect(includedFiles('a<!--include:src/js/a.js-->b<!-- include: src/b.js -->')).toEqual(['src/js/a.js', 'src/b.js']);
  });

  test('the phone-number rules are asked for by the version the file carries', async () => {
    const { checkPhoneRulesVersion } = await load();
    expect(checkPhoneRulesVersion(read('app.src.html'), read('assets/phone-rules.json'))).toBeNull();
    expect(checkPhoneRulesVersion("const PHONE_RULES_V='1.0';", '{"v":"1.1","codes":{}}')).toContain("PHONE_RULES_V='1.0'");
    expect(checkPhoneRulesVersion('nothing here', '{"v":"1"}')).toContain('not found');
  });

  test('the staff half never ships the site-origin placeholder', () => {
    for (const f of ['index.html', 'app.js', 'staff.js', ...partFiles()]) expect(read(f).includes('__SITE_ORIGIN__'), f).toBe(false);
  });

  test('the two halves stay within the gzip budget', async () => {
    const { checkSizeBudget, gzipBytes } = await load();
    const bytes = {
      customer: gzipBytes(readFileSync(resolve(ROOT, 'index.html'))) + gzipBytes(readFileSync(resolve(ROOT, 'app.js'))),
      staff: gzipBytes(readFileSync(resolve(ROOT, 'staff.js'))) + partFiles().reduce((n, f) => n + gzipBytes(readFileSync(resolve(ROOT, f))), 0),
      core: gzipBytes(readFileSync(resolve(ROOT, 'staff.js'))),
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
  // the staff half counts as one: the print windows may sit in staff.js or in a section's part
  for (const [rel, text] of [['index.html', read('index.html')], ['app.js', read('app.js')], ['staff.js + staff-parts', staffAllText()]]) {
    const refs = text.match(/fonts\/fonts\.css[^"'`\s)]*/g) || [];
    if (rel !== 'app.js') expect(refs.length, rel).toBeGreaterThan(0); // the customer script links none since the print windows went to staff.js (2026-10-04)
    for (const r of refs) expect(r, rel).toMatch(/^fonts\/fonts\.css\?v=[a-f0-9]{10}$/);
  }
});

// ── What a customer's page carries (2026-10-01) ──────────────────────────────────────────────────
// The build moves the strings and the CSS rules only staff screens use out of the customer's files
// (staffOnlyLangKeys, customerCss in scripts/split-staff.mjs). Too much moved is a raw key or an
// unstyled element on a rider's screen, so the rules are pinned here, and the built files are
// checked against them.
test.describe('@build the customer page leaves the staff half\'s strings and styles out', () => {
  test('a key stays with the customer whenever the page could ask for it', async () => {
    const { staffOnlyLangKeys } = await load();
    const cust = "t('landTitle'); t('heard_'+x); t(`rateTag${y}`); t(n[2]+'D'); _tn('bikesCount',n); const L=['bdgWeek'];";
    const staff = "t('snavTeam'); t('heard_desk'); t('rateTagFun'); t('bdgWeekD'); t('bikesCount_one'); t('landTitle'); t('rowsN')";
    const keys = ['landTitle', 'heard_desk', 'rateTagFun', 'bdgWeekD', 'bikesCount_one', 'snavTeam', 'rowsN', 'nobodySaysThis'];
    expect([...staffOnlyLangKeys(keys, cust, staff)].sort()).toEqual(['rowsN', 'snavTeam']);
  });

  test('a rule leaves app.css only when every selector needs a class the customer page never writes', async () => {
    const { customerCss } = await load();
    const css = [
      '.shared{a:1}', '.st-only{a:2}', '.st-only,.shared{a:3}', 'body.view-staff .shared{a:4}',
      '.shared:not(.st-only){a:5}', '[class*="st-only"]{a:6}', '.cu-g-male{a:7}', '.chip-live{a:8}',
      '@media (max-width:9px){.st-only{a:9}}', '@media print{.st-only{a:10}.shared{a:11}}', '@font-face{font-family:x}',
    ].join('\n');
    const cust = "<b class='shared'></b> x.className='cu-g-'+g; y.className=`chip-${state}`; showView: document.body.classList.toggle('view-staff')";
    const staff = "'st-only cu-g-male chip-live shared view-staff'";
    const out = customerCss(css, cust, staff).css;
    for (const kept of ['{a:1}', '{a:3}', '{a:5}', '{a:6}', '{a:7}', '{a:8}', '{a:11}', '@font-face', '@media print']) expect(out, kept).toContain(kept);
    for (const gone of ['{a:2}', '{a:4}', '{a:9}', '{a:10}', 'max-width:9px']) expect(out, gone).not.toContain(gone);
  });

  test('app.css is styles.css with rules taken out, never added or reordered', async () => {
    const { cssTokens } = await load();
    // app.css is the build's clean-css pass over a filtered styles.css, so against the same pass over the
    // whole file every rule it keeps (with the @media around it) must be found, in the same order.
    const { default: CleanCSS } = (await import('clean-css' as string)) as { default: new (o: object) => { minify(css: string): { styles: string } } };
    const flat = (css: string, at = ''): string[] => cssTokens(css).flatMap((t) => {
      const tk = t as { kind: string; text: string; prelude?: string; body?: string | null };
      if (tk.kind === 'rule') return [at + tk.text];
      if (tk.kind === 'at' && tk.body != null && /^@(media|supports)/.test(tk.prelude || '')) return flat(tk.body, at + tk.prelude + '|');
      return [];
    });
    const full = flat(new CleanCSS({ level: 1 }).minify(read('styles.css')).styles);
    const cust = flat(read('app.css'));
    expect(cust.length).toBeGreaterThan(1000);
    expect(cust.length).toBeLessThan(full.length);
    let i = 0;
    const lost: string[] = [];
    for (const r of cust) { const j = full.indexOf(r, i); if (j < 0) lost.push(r.slice(0, 80)); else i = j + 1; }
    expect(lost.slice(0, 5)).toEqual([]);
  });

  test('no string the customer page names was moved to the staff packs', async () => {
    const { staffOnlyLangKeys } = await load();
    const app = read('app.js');
    // The LANG object, braces matched with strings minded (its strings hold braces of their own).
    const at = app.indexOf('{', app.indexOf('const LANG={'));
    let end = at, depth = 0, q = '';
    for (; end < app.length; end++) {
      const c = app[end];
      if (q) { if (c === '\\') end++; else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'" || c === '`') q = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    const LANG = new Function(`return (${app.slice(at, end + 1)});`)() as Record<string, Record<string, string>>;
    const custText = read('index.html') + app.slice(0, at) + app.slice(end + 1);
    const staffKeys = Object.keys(JSON.parse(read('lang/staff-ar.json')));
    expect(staffKeys.length).toBeGreaterThan(1000);
    // Every key the build moved still counts as staff-only against the files as they ship.
    const again = staffOnlyLangKeys(staffKeys, custText, staffAllText());
    expect(staffKeys.filter((k) => !again.has(k))).toEqual([]);
    // English keeps them in staff.js, and none of them is in the page's own English.
    expect(Object.keys(LANG.en).length).toBeGreaterThan(800);
    expect(staffKeys.filter((k) => k in LANG.en)).toEqual([]);
    expect(read('staff.js')).toContain('Object.assign(LANG.en,');
    // and the parts are whole: every section named in STAFF_PARTS has its file, and staff.js knows its hash
    const core = read('staff.js');
    for (const f of partFiles()) expect(core.includes(`"${f.slice('staff-parts/'.length, -3)}":"`), f).toBe(true);
  });
});

// ── Selectors that made every realtime repaint restyle the whole roster (2026-10-01) ─────────────
// Each party is its own <tbody> and each piece of the roster carries data-ck. A backward positional
// pseudo-class over the parties (:last-of-type, :nth-last-*) restyled every other party's cells when
// one was replaced (5,200 elements), and a :has() looking for [data-ck=...] sent Chrome over the
// whole page for every card. Traced with the invalidation tracking of a Chrome trace; see
// _qBulkSync in app.src.html and the .queue-table rules in styles.css.
test('@build no selector makes one roster row restyle the rest', () => {
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(css).not.toMatch(/tbody:(?:last-of-type|nth-last-child|nth-last-of-type|nth-of-type)/);
  expect(css).not.toMatch(/:has\([^)]*data-ck/);
});
