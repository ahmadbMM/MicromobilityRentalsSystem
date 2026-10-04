// Build the served index.html from the readable source app.src.html.
// Safe minification: removes comments + whitespace from the inline JS/CSS but does
// NOT mangle or compress — the app references global function names as strings
// inside onclick="fn()" template literals, so renaming identifiers would break it.
import { minify } from 'html-minifier-terser';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FILES as DIST_FILES, DIRS as DIST_DIRS } from './assemble-dist.mjs';
import { minify as terserMinify } from 'terser';
import CleanCSS from 'clean-css';
import {
  splitStaff, resolveIncludes, mainScript, staffOnlyLangKeys, customerCss, splitSections,
  checkHandlerNames, formatHandlerOffenders, checkBareWrites, formatBareWrites, checkSizeBudget, gzipBytes,
  checkCustomerColors, checkNoEmoji, includedFiles, checkPhoneRulesVersion, checkFieldNames, formatFieldNames,
} from './split-staff.mjs';

// Modularization foundation: logic can live in separate src/ files and be pulled in
// at build time via `<!--include:path/to/file.js-->` markers. Inlining (not ES-module
// importing) keeps the app's single global scope intact, so the onclick="fn()"
// name-by-string pattern in the templates keeps working — no runtime change, files
// just become editable in isolation. Extraction stays incremental and test-guarded
//. Only the built index.html is ever served, so the markers
// never reach a browser. (resolveIncludes lives in split-staff.mjs, shared with the checks.)

const raw = await readFile(new URL('../app.src.html', import.meta.url), 'utf8');
let src = await resolveIncludes(raw);

// ── Fail loudly on a JavaScript syntax error ────────────────────────────────
// html-minifier-terser does NOT throw when terser cannot parse an inline <script>; it
// leaves that block unminified and reports success. The only outward sign is the output
// barely shrinking, which is easy to miss — a broken build shipped this way twice. Parse
// every inline script first, so a syntax error stops the build with a real message.
for (const m of src.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (/type\s*=\s*["']?application\/(ld\+json|json)/i.test(m[1])) continue; // data, not code
  try {
    new Function(m[2]);
  } catch (e) {
    const line = src.slice(0, m.index).split('\n').length;
    throw new Error(`build: inline <script> starting at app.src.html:${line} has a syntax error — ${e.message}`);
  }
}

// ── Every handler names a global function ────────────────────────────────────
// data-on-<event> attributes carry ["name", ...args] and _onDispatch looks the name up as
// window[name] when the event fires; a misspelt name is a console warning at tap time, not
// an error at load. Read every static attribute, every _on('name', ...) call and every list in
// _on([...],[...]) against the top-level function declarations (see checkHandlerNames).
{
  const h = checkHandlerNames(raw, src);
  if (h.offenders.length) {
    throw new Error(`build: ${h.offenders.length} handler(s) name something that is not a top-level function (the dispatcher reads window[name]):\n${formatHandlerOffenders(h)}`);
  }
  console.log(`build: ${h.checked} handler names checked against ${h.declared} top-level functions (${h.dynamic} dynamic, left alone)`);
}

// ── A refused write is said, never swallowed (a WARNING for now) ─────────────
// Every sb.from('<table>').insert|update|delete|upsert(...) goes through _wr(...) or hands its
// result to _writeErr(...); a deliberately unchecked write carries `// fire-and-forget` on its
// line, and the logging tables are exempt. See checkBareWrites for the classification.
console.log(formatBareWrites(checkBareWrites(raw)));

// ── Translation packs: ship the language a visitor reads, not all three ──────
// LANG carries ~1,700 keys in two languages. Inline, that is ~190 KB gzipped of the
// ~300 KB page — and Arabic alone is 146 KB of it, because every glyph is multi-byte. A
// visitor reads ONE language, so English (the fallback t() falls through to) stays inline
// and the other packs become files fetched on demand.
//
// The extraction happens HERE rather than in the source: app.src.html keeps all three
// languages in one object, so translations stay editable side by side and check-i18n.mjs
// keeps parsing exactly what it always did.
const INLINE_LANG = 'en';
function langObjectText(text) {
  const at = text.indexOf('const LANG={');
  if (at === -1) throw new Error('build: could not find the LANG object');
  let i = text.indexOf('{', at), depth = 0, quote = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  return { start: text.indexOf('{', at), end: i + 1 };
}
const langSpan = langObjectText(src);
const LANG_ALL = new Function(`return (${src.slice(langSpan.start, langSpan.end)});`)();
// English and Arabic live inline in app.src.html. The other languages are plain JSON files
// under i18n/ (one per code, pretty-printed, one key per line) so a 2,000-string pack can be
// reviewed in a diff instead of buried in a 20,000-line HTML file. Merged here, they become
// packs exactly like Arabic: fetched on demand, versioned by content.
const i18nDir = new URL('../i18n/', import.meta.url);
for (const f of (await readdir(i18nDir)).filter((n) => /^[a-z]{2}\.json$/.test(n)).sort()) {
  const code = f.slice(0, 2);
  if (LANG_ALL[code]) throw new Error(`build: language "${code}" is defined both inline and in i18n/${f}`);
  LANG_ALL[code] = JSON.parse(await readFile(new URL(f, i18nDir), 'utf8'));
}
const packCodes = Object.keys(LANG_ALL).filter((c) => c !== INLINE_LANG);
// Rebuild the object with the fetched languages emptied — the runtime fills them in. English stays
// whole for the split below, which reads the page as it will run; the staff half's strings leave it
// after the split (see "Staff-only strings" further down), when it is known which code names what.
const langText = (en) => `{${Object.keys(LANG_ALL)
  .map((c) => (c === INLINE_LANG ? `${c}:${JSON.stringify(en)}` : `${c}:{}`))
  .join(',')}}`;
src = src.slice(0, langSpan.start) + langText(LANG_ALL[INLINE_LANG]) + src.slice(langSpan.end);

// The city-of-residence files (cities/, from scripts/build-cities.mjs) are served cache-first
// by the service worker like the packs, so the app asks for them with one hash of the whole
// folder: a refresh of the data moves it and every country is fetched afresh.
const citiesDir = new URL('../cities/', import.meta.url);
const citiesHasher = createHash('sha256');
for (const f of (await readdir(citiesDir)).filter((n) => /^[a-z]{2}\.json$/.test(n)).sort()) {
  citiesHasher.update(f).update(await readFile(new URL(f, citiesDir)));
}
if (!src.includes("const CITIES_V=''")) throw new Error('build: CITIES_V placeholder missing');
src = src.replace("const CITIES_V=''", `const CITIES_V='${citiesHasher.digest('hex').slice(0, 10)}'`);

// The bike pictures behind the "i" beside a type pill (assets/bikes/<type>.webp) are served
// cache-first too, so the app asks for them with one hash of the folder: a replaced picture moves.
// No folder, or no picture yet, stamps nothing and the sheet draws the bike glyph.
const bikesDir = new URL('../assets/bikes/', import.meta.url);
const bikesHasher = createHash('sha256');
let bikeFiles = [];
try { bikeFiles = (await readdir(bikesDir)).filter((n) => /^[a-z-]+\.webp$/.test(n)).sort(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
for (const f of bikeFiles) bikesHasher.update(f).update(await readFile(new URL(f, bikesDir)));
if (!src.includes("const BIKE_IMG_V=''")) throw new Error('build: BIKE_IMG_V placeholder missing');
src = src.replace("const BIKE_IMG_V=''", `const BIKE_IMG_V='${bikeFiles.length ? bikesHasher.digest('hex').slice(0, 10) : ''}'`);

// The print windows' stylesheets (report.css for every report _openReport writes, receipt.css for
// the till's receipt) are linked from windows written into about:blank, which run under the page's
// policy - no <style> there once style-src drops 'unsafe-inline'. They are asked for with their own
// content hash, so _headers can keep them a year and a change is a new URL. Stamped here, before
// the split, so whichever half a link lands in carries it (the receipt is in staff.js).
for (const [file, name] of [['report.css', 'REPORT_CSS_V'], ['receipt.css', 'RECEIPT_CSS_V']]) {
  const ph = `const ${name}=''`;
  if (!src.includes(ph)) throw new Error(`build: ${name} placeholder missing`);
  if (!DIST_FILES.includes(file)) throw new Error(`build: ${file} is linked by the print windows but scripts/assemble-dist.mjs does not ship it`);
  src = src.replace(ph, `const ${name}='${createHash('sha256').update(await readFile(new URL(`../${file}`, import.meta.url))).digest('hex').slice(0, 10)}'`);
}

// The public origin (site.config.json), read before the split: every half that ships carries it.
const site = JSON.parse(await readFile(new URL('../site.config.json', import.meta.url), 'utf8'));
const origin = String(site.origin || '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(origin)) {
  throw new Error(`build: site.config.json origin must be a bare origin, got ${JSON.stringify(site.origin)}`);
}

// ── The staff half, split off into staff.js (scripts/split-staff.mjs) ──────────
// A customer's phone used to download the whole app, two thirds of it staff-only. The main
// script is cut by what a customer's page can reach; the rest becomes staff.js, minified the same
// way (no compression, no top-level renaming: onclick="fn()" strings name functions), named by
// its own hash in the URL so a change is a new file, fetched by the loader the split writes into
// the customer half when a staffer enters.
// styles.css's own tag: the hash of the bytes that SHIP (see "Cache busting" below for why). It is
// taken here because the staff loader the split writes asks for the whole stylesheet by it.
const cssUrl = new URL('../styles.css', import.meta.url);
const cssSource = await readFile(cssUrl, 'utf8');
const cssHash = createHash('sha256').update(new CleanCSS({ level: 1 }).minify(cssSource).styles).digest('hex').slice(0, 10);
const split = splitStaff(src, '/staff.js?v=__STAFF_V__', `/styles.css?v=${cssHash}`);

// ── Every staff form field has a name a screen reader can say (a WARNING, 2026-10-04) ──────────
// A field with no <label for>, wrapping <label>, aria-label or aria-labelledby is read out as "edit
// text". The staff half's functions are the ones the check reads (see checkFieldNames).
console.log(formatFieldNames(checkFieldNames(raw, new Set([...split.staff.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])))));

// ── Staff-only strings leave the customer's page (2026-10-01) ─────────────────
// About two thirds of LANG's keys are words only staff screens say. A key that staff code names and
// the customer's page cannot (staffOnlyLangKeys in scripts/split-staff.mjs) goes: in English to the
// head of staff.js, in every other language to lang/staff-<code>.json, which the staff loader fetches
// beside staff.js. Everything else stays where it was: English inline, the rest in lang/<code>.json.
let custHtml = split.html;
const custLangSpan = langObjectText(custHtml);
const allKeys = [...new Set(Object.values(LANG_ALL).flatMap((o) => Object.keys(o)))];
const staffKeys = staffOnlyLangKeys(allKeys, custHtml.slice(0, custLangSpan.start) + custHtml.slice(custLangSpan.end), split.staff);
const langPart = (o, staff) => Object.fromEntries(Object.entries(o).filter(([k]) => staffKeys.has(k) === staff));
custHtml = custHtml.slice(0, custLangSpan.start) + langText(langPart(LANG_ALL[INLINE_LANG], false)) + custHtml.slice(custLangSpan.end);
const staffEn = langPart(LANG_ALL[INLINE_LANG], true);
split.staff = split.staff.replace(/^(\/\/[^\n]*\n)/, `$1Object.assign(LANG.en,${JSON.stringify(staffEn)}); // the staff screens' English (scripts/build-html.mjs)\n`);
if (!split.staff.includes('Object.assign(LANG.en,')) throw new Error('build: the staff English strings were not written into staff.js');
const langDir = new URL('../lang/', import.meta.url);
await mkdir(langDir, { recursive: true });
const packHash = {}, staffPackHash = {};
const writePack = async (name, obj) => {
  const json = JSON.stringify(obj);
  await writeFile(new URL(`${name}.json`, langDir), json);
  return createHash('sha256').update(json).digest('hex').slice(0, 10);
};
for (const code of packCodes) {
  packHash[code] = await writePack(code, langPart(LANG_ALL[code], false));
  const st = langPart(LANG_ALL[code], true);
  if (Object.keys(st).length) staffPackHash[code] = await writePack(`staff-${code}`, st); // staff-<code>: the middleware lets /lang/[a-z-]{2,8}.json through
}
// Each pack is versioned by its own content, so a translation change busts exactly that
// file. Three places need it: the loader, the <head> prefetch that starts before the
// loader exists, and the staff loader (its own packs).
const packMap = JSON.stringify(packHash);
if (!custHtml.includes('const LANG_PACKS={}')) throw new Error('build: LANG_PACKS placeholder missing');
custHtml = custHtml.replace('const LANG_PACKS={}', `const LANG_PACKS=${packMap}`);
// Without the stamp the prefetch asks for lang/<code>.json with no version, which the service
// worker then serves cache-first for as long as its cache lives: a stale pack, silently.
if (!custHtml.includes('<script>try{var _ql=')) throw new Error('build: the <head> language prefetch (__LANG_V) was not found');
custHtml = custHtml.replace('<script>try{var _ql=', `<script>window.__LANG_V=${packMap};try{var _ql=`);
if (!custHtml.includes('var STAFF_LANG_V={};')) throw new Error('build: the staff loader\'s STAFF_LANG_V placeholder is missing (scripts/split-staff.mjs)');
custHtml = custHtml.replace('var STAFF_LANG_V={};', `var STAFF_LANG_V=${JSON.stringify(staffPackHash)};`);
split.html = custHtml;
console.log(`build: extracted ${packCodes.join(', ')} to lang/ (${packCodes.length} packs); ${staffKeys.size} of ${allKeys.length} keys are staff-only (staff.js + lang/staff-<code>.json)`);
// compress stays off (2026-10-01, measured): with it on, app.js and staff.js shrank by under 1% once
// gzipped - the compressor's rewrites are mostly what gzip and brotli already fold away - so it buys
// nothing for the risk of its transforms.
const TERSER_OPTS = { compress: false, mangle: { toplevel: false }, format: { comments: false } };
// The staff half in parts (splitSections in scripts/split-staff.mjs): the desk's core stays staff.js,
// each section goes to staff-parts/<name>.js under its own hash, stamped into the core before the
// core's own hash is taken.
const sections = splitSections(split.staff);
const staffMin = await terserMinify(sections.core, TERSER_OPTS);
if (!staffMin.code) throw new Error('build: staff.js did not minify');
// fonts.css is asked for with its own hash (see below, for index.html); the print windows that link
// it (the reports and the till's receipt) are drawn by the staff half, so staff.js is stamped here,
// before its own hash is taken.
const fontsHash = createHash('sha256').update(await readFile(new URL('../fonts/fonts.css', import.meta.url))).digest('hex').slice(0, 10);
staffMin.code = staffMin.code.replace(/fonts\/fonts\.css(?:\?v=[a-z0-9]+)?(?=["'])/g, `fonts/fonts.css?v=${fontsHash}`)
  .split('__SITE_ORIGIN__').join(origin); // the staff half names the site too (CA_SITE and the like): never the placeholder
if (/fonts\/fonts\.css(?!\?v=[a-f0-9]{10}["'])/.test(staffMin.code)) throw new Error('build: a fonts.css reference in staff.js was left without its hash');
const partsDir = new URL('../staff-parts/', import.meta.url);
await rm(partsDir, { recursive: true, force: true });
await mkdir(partsDir, { recursive: true });
const staffParts = {}, staffPartsV = {};
for (const [name, code] of Object.entries(sections.parts)) {
  const min = await terserMinify(code, TERSER_OPTS);
  if (!min.code) throw new Error(`build: staff-parts/${name}.js did not minify`);
  const c = min.code.replace(/fonts\/fonts\.css(?:\?v=[a-z0-9]+)?(?=["'])/g, `fonts/fonts.css?v=${fontsHash}`).split('__SITE_ORIGIN__').join(origin);
  if (/fonts\/fonts\.css(?!\?v=[a-f0-9]{10}["'])/.test(c)) throw new Error(`build: a fonts.css reference in staff-parts/${name}.js was left without its hash`);
  staffParts[name] = c;
  staffPartsV[name] = createHash('sha256').update(c).digest('hex').slice(0, 10);
  await writeFile(new URL(`${name}.js`, partsDir), c);
}
if (!staffMin.code.includes('var STAFF_PARTS_V={};')) throw new Error('build: the staff parts loader placeholder (STAFF_PARTS_V) is missing');
staffMin.code = staffMin.code.replace('var STAFF_PARTS_V={};', `var STAFF_PARTS_V=${JSON.stringify(staffPartsV)};`);
// Everything a staff device runs, for the checks below that read the staff half's text.
const staffAll = staffMin.code + '\n' + Object.values(staffParts).join('\n');
const staffHash = createHash('sha256').update(staffMin.code).digest('hex').slice(0, 10);
src = split.html.replace('/staff.js?v=__STAFF_V__', `/staff.js?v=${staffHash}`);
await writeFile(new URL('../staff.js', import.meta.url), staffMin.code);
console.log(`build: staff parts -> ${Object.entries(staffParts).map(([n, c]) => `${n} ${Math.round(gzipBytes(c) / 1000)}`).join(', ')} KB gzipped; staff.js (the desk's core) ${Math.round(gzipBytes(staffMin.code) / 1000)} KB`);
console.log(`build: staff half -> staff.js ${split.report.staffBytes} -> ${staffMin.code.length} bytes (${split.report.staffStmts} statements, ${split.report.stubs.length} entry points); customer half ${split.report.customerBytes} bytes (${split.report.customerStmts} statements)`);


// ── The customer half, out of the page into app.js (2026-10-01) ─────────────
// It was inline: ~190 KB gzipped inside index.html, which is served max-age=0, so every deploy (several
// a day) sent every phone the whole script again, and an inline script gets none of the browser's
// compiled-code cache. As its own file, named by its hash, it is kept a year like staff.js and the
// page shrinks to its markup. A plain <script src> in the same place runs at the same moment the
// inline one did: before the deferred supabase-js, with the markup above it parsed.
const srcWithMain = src;
const main = mainScript(src);
const appMin = await terserMinify(main.code, TERSER_OPTS);
if (!appMin.code) throw new Error('build: app.js did not minify');
let appCode = appMin.code
  .replace(/fonts\/fonts\.css(?:\?v=[a-z0-9]+)?(?=["'])/g, `fonts/fonts.css?v=${fontsHash}`)
  .split('__SITE_ORIGIN__').join(origin);
if (/fonts\/fonts\.css(?!\?v=[a-f0-9]{10}["'])/.test(appCode)) throw new Error('build: a fonts.css reference in app.js was left without its hash');
const appHash = createHash('sha256').update(appCode).digest('hex').slice(0, 10);
await writeFile(new URL('../app.js', import.meta.url), appCode); // written here, as staff.js is: the service worker's precache list is checked against the tree below
const tagAt = main.open - '<script>'.length;
if (src.slice(tagAt, main.open) !== '<script>') throw new Error('build: the main script does not open with a bare <script>');
src = src.slice(0, tagAt) + `<script src="/app.js?v=${appHash}"></script>` + src.slice(main.close + '</script>'.length);

let out = await minify(src, {
  collapseWhitespace: true,
  conservativeCollapse: true, // keep a single space where text nodes need it (layout-safe)
  removeComments: true, // HTML comments
  minifyCSS: true, // inline <style>
  minifyJS: {
    // terser options: strip comments + whitespace. compress stays OFF (its dead-code
    // elimination would drop top-level functions that are only referenced by name inside
    // onclick="fn()" strings). mangle is scoped to LOCAL variables only — toplevel:false
    // preserves every global/function name the onclick-by-string pattern depends on, while
    // shortening in-function locals to shrink the parse.
    compress: false,
    mangle: { toplevel: false },
    format: { comments: false },
  },
  // leave attribute quoting / structure alone to avoid any behavioural surprises
  keepClosingSlash: true,
  removeAttributeQuotes: false,
});

// ── Cache busting, derived not hand-maintained ───────────────────────────────
// styles.css used to be pinned as `?v=NNN` in BOTH index.html and the service worker's
// precache list, bumped by hand. It drifted 78 commits once, and because the SW serves
// same-origin assets cache-first with no revalidation, returning users and installed
// PWAs kept an old stylesheet forever while the HTML updated around it — new markup,
// old CSS. The tag is now the stylesheet's own content hash, so it moves automatically
// whenever the file changes, and the SW cache name moves with it.
// The tag is the hash of the bytes that SHIP - the minified copy scripts/assemble-dist.mjs writes into
// dist/ (the same clean-css call, so the same bytes) - not of the source. Hashing the source left the
// tag unchanged when minification arrived (2026-09-27), and the edge, which keeps /styles.css for a
// year, went on serving the old copy under the same address. (cssHash is taken above the split.)
//
// Since 2026-10-01 the page links app.css, styles.css less every rule only the staff screens can
// match (customerCss in scripts/split-staff.mjs, read against the page and app.js as they ship), and
// the staff loader adds styles.css itself. app.css is written minified here, so the file in the repo
// is the file that ships and its tag is the hash of those bytes.
const appCssRes = customerCss(cssSource, out + '\n' + appCode, staffAll);
const appCss = new CleanCSS({ level: 1 }).minify(appCssRes.css);
if (appCss.errors.length) throw new Error(`build: app.css did not minify: ${appCss.errors.join('; ')}`);
const appCssHash = createHash('sha256').update(appCss.styles).digest('hex').slice(0, 10);
await writeFile(new URL('../app.css', import.meta.url), appCss.styles);
console.log(`build: app.css ${appCss.styles.length} bytes (${appCssRes.dropped} staff-only rules, ${appCssRes.droppedBytes} bytes of styles.css, left to the staff loader)`);
const beforeCss = out;
out = out.replace(/app\.css\?v=[a-z0-9]+/g, `app.css?v=${appCssHash}`);
if (out === beforeCss) throw new Error('build: the page links no app.css?v= to tag');
// fonts.css the same way. Its ?v= was bumped by hand, and the print windows (receipt, day sheet,
// billing report) asked for it with none: /fonts/ is cached as immutable for a year, so those
// windows could keep an old copy that long. Every reference now carries the file's own hash.
out = out.replace(/fonts\/fonts\.css(?:\?v=[a-z0-9]+)?(?=["'])/g, `fonts/fonts.css?v=${fontsHash}`);
if (/fonts\/fonts\.css(?!\?v=[a-f0-9]{10}["'])/.test(out)) throw new Error('build: a fonts.css reference was left without its hash');

// Keep the service worker's precache entry and cache name in lockstep.
//
// The cache name used to be the styles.css hash alone, but the cache also holds manifest.json
// and seven images, served cache-first with no revalidation. Shipping a new logo or icon
// without touching the stylesheet left the service worker byte-identical: no install event,
// no re-precache, no cache rotation, and returning visitors kept the old bytes for ever with
// no way out but an unrelated CSS edit. The name then became a hash of the precache list - but
// the worker serves EVERY same-origin file cache-first, not just the ones it precaches: the tag
// badges, the National Day marks, logo-mark-dark.png, the splash screens, fonts.css (whose ?v=
// was then bumped by hand; it is its content hash now, above) and phone-rules.json all sat outside it, and a new version of any of them
// alone stayed stale for good. So the name now covers every file the site ships (the same
// FILES/DIRS assemble-dist.mjs copies), less the ones that cannot go stale in that cache:
//   index.html      - rewritten by THIS build further down, and stale-while-revalidate with an
//                     etag check on every navigation anyway (hashing it would read the previous
//                     build's bytes and rotate one build late)
//   service-worker.js, _headers, _redirects - never served from the cache
//   robots.txt, sitemap.xml - rewritten further down by this build, and only crawlers read them
//   styles.css      - already in, through cssHash
//   functions/      - not static files
//   lang/, cities/  - asked for with their own content hash (?v=), so a change is a new URL
//   report.css, receipt.css - the same (and read by the print windows, which no worker controls)
// The list is read from disk, exactly what assemble-dist would copy, so a new asset counts the
// moment it is there - build, then commit, the usual order here. Dotfiles (.DS_Store and the
// like) and anything .gitignore'd are left out: they are on this machine only, and CI, whose
// checkout is the committed tree, has to rebuild the very same name.
const swUrl = new URL('../service-worker.js', import.meta.url);
let sw = await readFile(swUrl, 'utf8');
const swBefore = sw;
// The staff half rides in the shell on staff hosts (service-worker.js, STAFF_JS) under its own
// hash, stamped here before the precache list is checked below.
sw = sw.replace(/const STAFF_PARTS = \[[^\]]*\];/, `const STAFF_PARTS = ${JSON.stringify(Object.keys(staffPartsV).map((n) => `./staff-parts/${n}.js?v=${staffPartsV[n]}`))};`)
  .replace(/staff\.js\?v=[A-Za-z0-9_]+/g, `staff.js?v=${staffHash}`)
  .replace(/app\.js\?v=[A-Za-z0-9_]+/g, `app.js?v=${appHash}`)
  .replace(/app\.css\?v=[A-Za-z0-9_]+/g, `app.css?v=${appCssHash}`);
const NOT_CACHE_FIRST = new Set(['index.html', 'service-worker.js', '_headers', '_redirects', 'robots.txt', 'sitemap.xml', 'styles.css', 'staff.js', 'app.js', 'app.css', 'report.css', 'receipt.css']); // staff.js, app.js, app.css, report.css, receipt.css: asked for with their own hash (?v=), like the packs
const VERSIONED_DIRS = new Set(['functions', 'lang', 'cities', 'staff-parts']);
const shipped = (rel) => DIST_FILES.includes(rel) || DIST_DIRS.some((d) => rel.startsWith(d + '/'));
// Every file the worker precaches must also ship, or cache.addAll() rejects and the worker
// never installs in production. Checked here so it fails at build time, not at "Assemble dist".
const shellList = [...sw.matchAll(/'\.\/([^']+?)(?:\?v=[A-Za-z0-9_]+)?'/g)].map((m) => m[1]);
for (const rel of new Set(shellList)) {
  if (rel === '') continue;
  if (!shipped(rel)) throw new Error(`build: service-worker.js precaches ${rel}, which scripts/assemble-dist.mjs does not ship`);
  try { await readFile(new URL(`../${rel}`, import.meta.url)); }
  catch { throw new Error(`build: service-worker.js precaches ${rel}, which is not in the repo`); }
}
const rootDir = fileURLToPath(new URL('../', import.meta.url));
async function walk(rel) {
  const out = [];
  for (const d of await readdir(new URL(`../${rel}/`, import.meta.url), { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const child = `${rel}/${d.name}`;
    if (d.isDirectory()) out.push(...(await walk(child)));
    else if (d.isFile()) out.push(child);
  }
  return out;
}
let onDisk = DIST_FILES.filter((rel) => !rel.startsWith('.'));
for (const dir of DIST_DIRS) if (!VERSIONED_DIRS.has(dir)) onDisk.push(...(await walk(dir)));
// git check-ignore answers from the ignore rules, not from what is committed; without git (a
// tarball build) nothing is filtered, which is still the same answer CI would give.
const ign = spawnSync('git', ['check-ignore', '--stdin', '-z'], { cwd: rootDir, input: onDisk.join('\0'), encoding: 'utf8' });
if (ign.status === 0) { const ignored = new Set(ign.stdout.split('\0').filter(Boolean)); onDisk = onDisk.filter((rel) => !ignored.has(rel)); }
const cacheFirst = onDisk.filter((rel) => !NOT_CACHE_FIRST.has(rel)).sort();
// The versioned halves go into the name too: a deploy that changes only app.js still gets a fresh
// cache, and the copies of the last version go with the old one instead of piling up.
const shellHasher = createHash('sha256').update(cssHash).update(appHash).update(appCssHash).update(staffHash).update(JSON.stringify(staffPartsV));
for (const rel of cacheFirst) {
  let bytes;
  try { bytes = await readFile(new URL(`../${rel}`, import.meta.url)); }
  catch { throw new Error(`build: scripts/assemble-dist.mjs ships ${rel}, which is not in the repo`); }
  shellHasher.update(rel).update(bytes);
}
const shellHash = shellHasher.digest('hex').slice(0, 10);
sw = sw
  .replace(/styles\.css\?v=[a-z0-9]+/g, `styles.css?v=${cssHash}`)
  .replace(/const CACHE = '[^']*';/, `const CACHE = 'mmcq-${shellHash}';`);
if (!/const CACHE = 'mmcq-/.test(sw)) throw new Error('build: could not rewrite the SW cache name');
if (sw !== swBefore) await writeFile(swUrl, sw);

// ── Public origin, from one place ────────────────────────────────────────────
// The pages.dev host used to be typed into the canonical link, the OG/Twitter images, the
// JSON-LD, the sitemap and robots.txt independently, so moving to the custom domain meant
// finding every copy. app.src.html carries __SITE_ORIGIN__ and the two SEO files are
// rewritten here, all from site.config.json.
if (out.includes('__SITE_ORIGIN__')) out = out.split('__SITE_ORIGIN__').join(origin);
if (out.includes('__SITE_ORIGIN__')) throw new Error('build: site origin placeholder survived substitution');

// sitemap.xml: one entry per language, each declaring the others as alternates, so the
// Arabic and Spanish pages are discoverable rather than hidden behind localStorage.
const langs = Array.isArray(site.languages) && site.languages.length ? site.languages : ['en'];
const def = site.defaultLanguage || langs[0];
const alt = (l) => `      <xhtml:link rel="alternate" hreflang="${l}" href="${origin}/?lang=${l}"/>`;
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${langs.map((l) => `  <url>
    <loc>${origin}/${l === def ? '' : `?lang=${l}`}</loc>
${langs.map(alt).join('\n')}
      <xhtml:link rel="alternate" hreflang="x-default" href="${origin}/"/>
    <changefreq>weekly</changefreq>
    <priority>${l === def ? '1.0' : '0.9'}</priority>
  </url>`).join('\n')}
</urlset>
`;
await writeFile(new URL('../sitemap.xml', import.meta.url), sitemap);

const robotsUrl = new URL('../robots.txt', import.meta.url);
let robots = await readFile(robotsUrl, 'utf8');
const robotsBefore = robots;
robots = robots.replace(/^Sitemap: .*$/m, `Sitemap: ${origin}/sitemap.xml`);
if (!/^Sitemap: /m.test(robots)) throw new Error('build: robots.txt has no Sitemap line to rewrite');
if (robots !== robotsBefore) await writeFile(robotsUrl, robots);

// No build/tooling banner in the shipped file — index.html is public (View Source),
// so the "edit app.src.html, not index.html" rule lives in AGENTS.md / CLAUDE.md instead.
// Second guard, in case a future parser quirk slips past the check above: a real minify
// pass removes ~18% of this file. Anything under 5% means terser bailed out silently.
const shrink = 1 - (out.length + appCode.length) / srcWithMain.length;
if (shrink < 0.05) {
  throw new Error(`build: output shrank only ${(shrink * 100).toFixed(1)}% — terser almost certainly failed to parse an inline script`);
}

// The Content-Security-Policy allows no inline script (2026-09-27): handlers live in data-on-*
// attributes and the few inline <script> blocks are allowed by their SHA-256 hashes, which change
// with their bytes, so the policy line in _headers is written here from the built page (and the
// /staff/ stub). An on*="..." attribute anywhere in the shipped markup would be dead on the page
// - the build refuses it instead.
for (const [name, text] of [['index.html', out], ['app.js', appCode], ['staff.js', staffMin.code], ...Object.entries(staffParts).map(([n, c]) => [`staff-parts/${n}.js`, c])]) {
  const bad = text.match(/[\s`'"]on[a-z]+=["'][^"']{0,80}/); // any quote or backtick before it too: five handlers hid behind a template literal's backtick until 2026-09-28
  if (bad) throw new Error(`build: ${name} still carries an inline handler, which the policy would block: ${bad[0]}`);
  if (/javascript:/i.test(text)) throw new Error(`build: ${name} carries a javascript: URL, which the policy would block`);
}
// Since 2026-09-29 the policy has no style-src 'unsafe-inline' either: a style="..." in the markup or
// a template, or setAttribute('style'), is refused by the browser and would leave its element
// unstyled. Every look is a class (or a data-cssv value set through the CSSOM), and the build
// refuses an inline style the way it refuses an inline handler. The move there went area by area
// under a ceiling that only came down (1834 on 2026-09-28).
const STYLE_ATTRS_MAX = 0;
const styleAttrs = [out, appCode, staffAll].reduce((n, text) => n + (text.match(/[\s`'"(+]style=/g) || []).length + (text.match(/setAttribute\(\s*['"]style['"]/g) || []).length, 0);
if (styleAttrs > STYLE_ATTRS_MAX) throw new Error(`build: the page writes ${styleAttrs} inline style(s), which the policy (style-src without 'unsafe-inline') would refuse - write a class, or data-cssv for a run-time value, instead of style="..." or setAttribute('style')`);
const inlineHashes = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter((m) => !/\btype\s*=\s*["']?(?!(?:text\/javascript|module)["'\s>])/i.test(m[1]))
  .map((m) => createHash('sha256').update(m[2]).digest('base64'));
const staffStub = await readFile(new URL('../staff/index.html', import.meta.url), 'utf8');
const hashes = [...new Set([...inlineHashes(out), ...inlineHashes(staffStub)])];
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${hashes.map((h) => `'sha256-${h}'`).join(' ')} https://static.cloudflareinsights.com`,
  "style-src 'self' 'report-sample'", // 'report-sample': a refused style's first 40 characters come with its report
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://micromobility.sa https://*.supabase.co wss://*.supabase.co https://cloudflareinsights.com https://api.open-meteo.com https://archive-api.open-meteo.com",
  "media-src 'self' blob:", "worker-src 'self'", "manifest-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'",
  'upgrade-insecure-requests', 'report-uri /api/csp-report', 'report-to csp',
].join('; ');
const headersUrl = new URL('../_headers', import.meta.url);
let headers = await readFile(headersUrl, 'utf8');
const headersBefore = headers;
if (!/^  Content-Security-Policy: /m.test(headers)) throw new Error('build: _headers has no Content-Security-Policy line to rewrite');
headers = headers.replace(/^  Content-Security-Policy: .*$/m, `  Content-Security-Policy: ${CSP}`);
if (!/^  Reporting-Endpoints: /m.test(headers)) headers = headers.replace(/^(  Content-Security-Policy: .*)$/m, `$1\n  Reporting-Endpoints: csp="/api/csp-report"`);
// Early Hints (2026-10-01). Cloudflare Pages sends a page's Link headers as a 103 before the page
// itself, so the phone starts on the stylesheet, the script and the first font while the HTML is still
// on its way. It builds them from <link rel=preload> only when the tag carries nothing else, and ours
// need crossorigin or integrity, so the root's are written here, by hash, like the policy above.
const EARLY_FONT = '/fonts/SpaceGrotesk-var-latin.woff2';
if (!out.includes(`href="${EARLY_FONT}"`)) throw new Error(`build: the page no longer preloads ${EARLY_FONT} - update the Early Hints list`);
const early = `/\n  Link: </app.css?v=${appCssHash}>; rel=preload; as=style, </app.js?v=${appHash}>; rel=preload; as=script, <${EARLY_FONT}>; rel=preload; as=font; type="font/woff2"; crossorigin\n`;
const EARLY_RE = /^\/\n  Link: [^\n]*\n/m;
headers = EARLY_RE.test(headers) ? headers.replace(EARLY_RE, early) : headers.replace(/^(\/vendor\/\*\n)/m, `# The root page's Early Hints: written by scripts/build-html.mjs (the files' hashes change every build).\n${early}$1`);
if (!headers.includes(early)) throw new Error('build: could not write the Early Hints block into _headers');
if (headers !== headersBefore) await writeFile(headersUrl, headers);

// ── The customer system keeps its colours in its tokens (scripts/split-staff.mjs) ─────────────
{
  const cs = checkCustomerColors(await readFile(new URL('../styles.css', import.meta.url), 'utf8'));
  if (!cs.found) throw new Error('build: styles.css has no CUSTOMER SYSTEM block (its start and end banners are read by checkCustomerColors)');
  if (cs.offenders.length) {
    throw new Error(`build: a raw colour in the customer system (styles.css) - name it in the token list at the top of the block and use var(--name):\n${cs.offenders.map((o) => `  line ${o.line}: ${o.prop}: ${o.value}`).join('\n')}`);
  }
}

// ── No emoji anywhere in the source: icons are drawn (scripts/split-staff.mjs) ───────────────
{
  // app.src.html and every file it pulls in with <!--include:...-->, each with its own line numbers.
  for (const [file, text] of [['app.src.html', raw], ...await Promise.all(includedFiles(raw).map(async (f) => [f, await readFile(new URL(`../${f}`, import.meta.url), 'utf8')]))]) {
    const em = checkNoEmoji(text);
    if (em.length) throw new Error(`build: an emoji in ${file} - draw the icon instead (_cuIc for rider screens, _artIcon for staff) and keep message text plain:\n${em.slice(0, 20).map((e) => `  line ${e.line}: ${e.ch}  ${e.text}`).join('\n')}`);
  }
}

// ── The phone-number rules are asked for by their version (scripts/split-staff.mjs) ──────────────
{
  const pr = checkPhoneRulesVersion(raw, await readFile(new URL('../assets/phone-rules.json', import.meta.url), 'utf8'));
  if (pr) throw new Error(`build: ${pr}`);
}

// ── The download budget ──────────────────────────────────────────────────────
// What a customer's phone fetches (index.html) and what a staffer's adds (staff.js), gzipped as
// the edge sends them. A creeping regression fails the build here, with the numbers; the limits
// are SIZE_BUDGET_CUSTOMER_KB / SIZE_BUDGET_STAFF_KB in the environment or the defaults in
// scripts/split-staff.mjs (checked again by tests/build-checks.spec.ts against the committed files).
const budget = checkSizeBudget({ customer: gzipBytes(out) + gzipBytes(appCode), staff: gzipBytes(staffMin.code) + Object.values(staffParts).reduce((n, c) => n + gzipBytes(c), 0), core: gzipBytes(staffMin.code) });
console.log(`build: ${budget.text}`);
if (budget.over.length) {
  throw new Error(`build: over the size budget - ${budget.over.map((r) => `${r.half} half ${r.kb.toFixed(1)} KB gzipped > ${r.limitKb} KB`).join(', ')}. Trim what grew, or raise the budget deliberately (SIZE_BUDGET_*_KB, or the defaults in scripts/split-staff.mjs) and say why in the commit.`);
}

await writeFile(new URL('../index.html', import.meta.url), out);
console.log(`built index.html: ${out.length} bytes + app.js ${appCode.length} bytes (${(shrink * 100).toFixed(1)}% smaller than the source, app.js v=${appHash}, app.css v=${appCssHash}, ${hashes.length} inline scripts in the policy)`);
