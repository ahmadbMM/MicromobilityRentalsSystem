// Build the served index.html from the readable source app.src.html.
// Safe minification: removes comments + whitespace from the inline JS/CSS but does
// NOT mangle or compress — the app references global function names as strings
// inside onclick="fn()" template literals, so renaming identifiers would break it.
import { minify } from 'html-minifier-terser';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FILES as DIST_FILES, DIRS as DIST_DIRS } from './assemble-dist.mjs';
import { minify as terserMinify } from 'terser';
import { splitStaff } from './split-staff.mjs';

// Modularization foundation: logic can live in separate src/ files and be pulled in
// at build time via `<!--include:path/to/file.js-->` markers. Inlining (not ES-module
// importing) keeps the app's single global scope intact, so the onclick="fn()"
// name-by-string pattern in the templates keeps working — no runtime change, files
// just become editable in isolation. Extraction stays incremental and test-guarded
//. Only the built index.html is ever served, so the markers
// never reach a browser.
async function resolveIncludes(text) {
  const RE = /<!--\s*include:\s*([^\s]+?)\s*-->/g;
  const parts = [];
  let last = 0, m;
  while ((m = RE.exec(text))) {
    parts.push(text.slice(last, m.index));
    const body = await readFile(new URL('../' + m[1], import.meta.url), 'utf8');
    parts.push(body.replace(/^\s*\/\/\s*@ts-check\s*$/m, '')); // strip the dev-only type-check pragma
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.join('');
}

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
const langDir = new URL('../lang/', import.meta.url);
await mkdir(langDir, { recursive: true });
const packHash = {};
for (const code of packCodes) {
  const json = JSON.stringify(LANG_ALL[code]);
  packHash[code] = createHash('sha256').update(json).digest('hex').slice(0, 10);
  await writeFile(new URL(`${code}.json`, langDir), json);
}
// Rebuild the object with the fetched languages emptied — the runtime fills them in.
const trimmedLang = `{${Object.keys(LANG_ALL)
  .map((c) => (c === INLINE_LANG ? `${c}:${JSON.stringify(LANG_ALL[c])}` : `${c}:{}`))
  .join(',')}}`;
src = src.slice(0, langSpan.start) + trimmedLang + src.slice(langSpan.end);
// Each pack is versioned by its own content, so a translation change busts exactly that
// file. Two places need it: the loader, and the <head> prefetch that starts before the
// loader exists.
const packMap = JSON.stringify(packHash);
if (!src.includes('const LANG_PACKS={}')) throw new Error('build: LANG_PACKS placeholder missing');
src = src.replace('const LANG_PACKS={}', `const LANG_PACKS=${packMap}`);
// Without the stamp the prefetch asks for lang/<code>.json with no version, which the service
// worker then serves cache-first for as long as its cache lives: a stale pack, silently.
if (!src.includes('<script>try{var _ql=')) throw new Error('build: the <head> language prefetch (__LANG_V) was not found');
src = src.replace('<script>try{var _ql=', `<script>window.__LANG_V=${packMap};try{var _ql=`);
console.log(`build: extracted ${packCodes.join(', ')} to lang/ (${packCodes.length} packs)`);

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

// ── The staff half, split off into staff.js (scripts/split-staff.mjs) ──────────
// A customer's phone used to download the whole app, two thirds of it staff-only. The main
// script is cut by what a customer's page can reach; the rest becomes staff.js, minified the same
// way (no compression, no top-level renaming: onclick="fn()" strings name functions), named by
// its own hash in the URL so a change is a new file, fetched by the loader the split writes into
// the customer half when a staffer enters.
const split = splitStaff(src, '/staff.js?v=__STAFF_V__');
const staffMin = await terserMinify(split.staff, { compress: false, mangle: { toplevel: false }, format: { comments: false } });
if (!staffMin.code) throw new Error('build: staff.js did not minify');
const staffHash = createHash('sha256').update(staffMin.code).digest('hex').slice(0, 10);
src = split.html.replace('/staff.js?v=__STAFF_V__', `/staff.js?v=${staffHash}`);
await writeFile(new URL('../staff.js', import.meta.url), staffMin.code);
console.log(`build: staff half -> staff.js ${split.report.staffBytes} -> ${staffMin.code.length} bytes (${split.report.staffStmts} statements, ${split.report.stubs.length} entry points); customer half ${split.report.customerBytes} bytes (${split.report.customerStmts} statements)`);

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
const cssUrl = new URL('../styles.css', import.meta.url);
const cssHash = createHash('sha256').update(await readFile(cssUrl)).digest('hex').slice(0, 10);
const beforeCss = out;
out = out.replace(/styles\.css\?v=[a-z0-9]+/g, `styles.css?v=${cssHash}`);
if (out === beforeCss && /styles\.css\?v=/.test(beforeCss)) {
  throw new Error('build: styles.css cache tag present but not rewritten');
}
// fonts.css the same way. Its ?v= was bumped by hand, and the print windows (receipt, day sheet,
// billing report) asked for it with none: /fonts/ is cached as immutable for a year, so those
// windows could keep an old copy that long. Every reference now carries the file's own hash.
const fontsHash = createHash('sha256').update(await readFile(new URL('../fonts/fonts.css', import.meta.url))).digest('hex').slice(0, 10);
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
// The list is read from disk, exactly what assemble-dist would copy, so a new asset counts the
// moment it is there - build, then commit, the usual order here. Dotfiles (.DS_Store and the
// like) and anything .gitignore'd are left out: they are on this machine only, and CI, whose
// checkout is the committed tree, has to rebuild the very same name.
const swUrl = new URL('../service-worker.js', import.meta.url);
let sw = await readFile(swUrl, 'utf8');
const swBefore = sw;
const NOT_CACHE_FIRST = new Set(['index.html', 'service-worker.js', '_headers', '_redirects', 'robots.txt', 'sitemap.xml', 'styles.css', 'staff.js']); // staff.js: asked for with its own hash (?v=), like the packs
const VERSIONED_DIRS = new Set(['functions', 'lang', 'cities']);
const shipped = (rel) => DIST_FILES.includes(rel) || DIST_DIRS.some((d) => rel.startsWith(d + '/'));
// Every file the worker precaches must also ship, or cache.addAll() rejects and the worker
// never installs in production. Checked here so it fails at build time, not at "Assemble dist".
const shellList = [...sw.matchAll(/'\.\/([^']+?)(?:\?v=[a-z0-9]+)?'/g)].map((m) => m[1]);
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
const shellHasher = createHash('sha256').update(cssHash);
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
const site = JSON.parse(await readFile(new URL('../site.config.json', import.meta.url), 'utf8'));
const origin = String(site.origin || '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(origin)) {
  throw new Error(`build: site.config.json origin must be a bare origin, got ${JSON.stringify(site.origin)}`);
}
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
const shrink = 1 - out.length / src.length;
if (shrink < 0.05) {
  throw new Error(`build: output shrank only ${(shrink * 100).toFixed(1)}% — terser almost certainly failed to parse an inline script`);
}

await writeFile(new URL('../index.html', import.meta.url), out);
console.log(`built index.html: ${src.length} -> ${out.length} bytes (${(shrink * 100).toFixed(1)}% smaller, assets v=${cssHash})`);
