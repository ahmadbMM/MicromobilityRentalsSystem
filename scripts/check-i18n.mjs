// Checks that every language the site speaks carries every string, and nothing else - and that
// the code and the English pack agree on which strings exist.
// English and Arabic live inline in app.src.html (const LANG={...}); the other packs are
// i18n/<code>.json. The set of languages is read from LANGS in app.src.html, so adding a
// language there without a pack fails here, in CI, rather than falling back to English
// silently at runtime.
//
// Per language: no missing key, no extra key, no empty value, and the same {n}
// placeholders as English (a translation that drops {0} would print nothing where the
// number goes).
//
// Code vs `en` (2026-09-28):
//   - FAIL when a key the code asks for, t('key') / t("key"), is not defined in `en` (t() falls
//     back to printing the key itself, so the page would show "tabQeue" to a rider).
//   - WARN with the sorted list of `en` keys nothing references, so they can be pruned. A key is
//     referenced when a t('key') call names it, when any string literal in the code equals it
//     (the SECTION_KEY / NS_EV_NAME-style maps, {k:'tabQueue'}, are read through t(map[k])), or
//     when it starts with a prefix the code builds keys from: t('rateTag'+k), t(`frame${f}`) -
//     those prefixes are read off the t() calls themselves, plus DYNAMIC_KEYS below for the few
//     built away from the call.
//
// Usage: node scripts/check-i18n.mjs   (exit 1 on any problem)
import { readFileSync, existsSync } from 'node:fs';
import * as acorn from 'acorn';
import { resolveIncludes, mainScript, EMOJI_RE } from './split-staff.mjs';

const SRC = new URL('../app.src.html', import.meta.url);
const html = readFileSync(SRC, 'utf8');

/** The object or array literal at `marker` in `text`: its value and the span of its text. */
function objectAt(text, marker) {
  const start = text.indexOf(marker);
  if (start === -1) {
    console.error(`check-i18n: could not find \`${marker}\` in app.src.html`);
    process.exit(1);
  }
  // Scan from the opening bracket to its match, ignoring brackets inside string literals
  // (placeholders like '{0}' appear in values).
  const open = text[start + marker.length - 1];
  const close = open === '[' ? ']' : '}';
  let i = start + marker.length - 1;
  const objStart = i;
  let depth = 0;
  let quote = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    console.error(`check-i18n: unbalanced brackets while scanning ${marker}`);
    process.exit(1);
  }
  try {
    return { value: new Function(`return (${text.slice(objStart, i + 1)});`)(), start: objStart, end: i + 1 };
  } catch (e) {
    console.error(`check-i18n: failed to evaluate ${marker}:`, e.message);
    process.exit(1);
  }
}

const LANG = objectAt(html, 'const LANG={').value;
const LANGS = objectAt(html, 'const LANGS=[').value;
const codes = LANGS.map((l) => l.code);

for (const code of codes) {
  if (LANG[code]) continue;
  const file = new URL(`../i18n/${code}.json`, import.meta.url);
  if (!existsSync(file)) {
    console.error(`check-i18n: language "${code}" is in LANGS but has neither an inline block nor i18n/${code}.json`);
    process.exit(1);
  }
  LANG[code] = JSON.parse(readFileSync(file, 'utf8'));
}

const en = LANG.en;
const enKeys = Object.keys(en);
// The fill-ins a string carries: numbered ({0}) and named ({name}, {ref}, {n}...) alike - a translation
// that drops {name} prints the greeting without the rider's name, one that renames it prints "{nom}".
const holes = (v) => (String(v).match(/\{(?:\d+|[A-Za-z_]\w*)\}/g) || []).sort().join(' ');
// Keys whose braces are prose, not fill-ins: tplSub tells staff that "words in {braces}" are filled in,
// and each language names the braces in its own words.
const PROSE_BRACES = new Set(['tplSub']);

let failed = false;
for (const code of codes) {
  if (code === 'en') continue;
  const pack = LANG[code];
  const missing = enKeys.filter((k) => !(k in pack));
  const extra = Object.keys(pack).filter((k) => !(k in en));
  const empty = enKeys.filter((k) => k in pack && String(pack[k]).trim() === '' && String(en[k]).trim() !== '');
  // A plural form may leave out the count where the language says it in the word instead
  // (Arabic "رحلتان", two rides): for base_one/_two/... only a hole English lacks is an error.
  const plural = (k) => /_(zero|one|two|few|many|other)$/.test(k);
  const subset = (a, b) => { const B = String(b).split(' '); return !a || String(a).split(' ').every((h) => B.includes(h)); };
  const badHoles = enKeys.filter((k) => k in pack && !PROSE_BRACES.has(k) && (plural(k) ? !subset(holes(pack[k]), holes(en[k])) : holes(pack[k]) !== holes(en[k])));
  const report = (label, list) => {
    if (!list.length) return;
    failed = true;
    console.error(`check-i18n: ${code} ${label} ${list.length} key(s): ${list.slice(0, 40).join(', ')}${list.length > 40 ? ', …' : ''}`);
  };
  report('is missing', missing);
  report('has extra', extra);
  report('has empty values for', empty);
  report('has different {n}/{name} placeholders from English in', badHoles);
  // no emoji in any string (the owner, 2026-09-30): icons are drawn, messages are plain text. The
  // build's own list (EMOJI_RE): this one lacked the star and the circle (U+2B50, U+2B55), and the
  // build reads app.src.html only, so a pack carrying either passed both (2026-10-07).
  const emoji = Object.keys(pack).filter((k) => EMOJI_RE.test(String(pack[k]).replace(/[\u2713\u2715\u270E\u2605]/g, '')));
  report('has an emoji in', emoji);
}

// Two strings are used with their first character stripped by a regex, because the same key
// serves a button with a leading decoration and a plain label elsewhere. If a translation
// drops that decoration the strip silently does nothing and the badge keeps the symbol, which
// no placeholder rule would catch. Pin the prefixes here instead.
const DECORATED = [
  ['addWalkin', /^\+ /, '"+ " (stripped by /^\\+ / at the walk-in badge)'],
  ['showOtherTypes', /^[↓↑]\s*/, 'an arrow (stripped by /^[↓↑]\\s*/ )'],
];
for (const [key, re, what] of DECORATED) {
  for (const code of codes) {
    const v = LANG[code] && LANG[code][key];
    if (v == null) continue;
    if (!re.test(String(v))) {
      failed = true;
      console.error(`check-i18n: ${code} ${key} must start with ${what} — got ${JSON.stringify(String(v).slice(0, 24))}`);
    }
  }
}

// ── The code and `en` agree on which keys exist ──────────────────────────────────────────────
// The main script with includes inlined and the LANG object blanked (its own keys must not count
// as references), parsed so comments are out of the way: a commented-out t('oldKey') is not a use.
const resolved = await resolveIncludes(html);
const { code } = mainScript(resolved);
const langInCode = objectAt(code, 'const LANG={');
const codeNoLang = code.slice(0, langInCode.start) + '{}' + code.slice(langInCode.end);
let ast;
try {
  ast = acorn.parse(codeNoLang, { ecmaVersion: 'latest', sourceType: 'script' });
} catch (e) {
  console.error(`check-i18n: the main script does not parse: ${e.message}`);
  process.exit(1);
}

/** Keys built away from the t() call (a variable or a map filled by code holds the name). Regexes on the key. */
const DYNAMIC_KEYS = [
  /^ev[A-Z]\w*Name$/, // evJccName, evSatName, ...: NS_EV_NAME and the ride-kind fallbacks name them, some by ride kind at runtime
  /^bdg?[A-Z0-9]\w*[DA]$/, // bdFirstLapD, bdgMarshalA, ...: a badge's how-to and about lines, read as t(BD_SYS[slug][2]+'D'|'A')
  /^\w+_(zero|one|two|few|many|other)$/, // mrRides_one, ...: a count's plural forms, read by _tn(base, n) through Intl.PluralRules
];

const used = new Map(); // key -> number of t('key') calls
const prefixes = new Map(); // prefix -> how it was built, for the report
const literals = new Set(); // every string literal in the code
let dynamicCalls = 0;
const useKey = (k) => used.set(k, (used.get(k) || 0) + 1);
/** Classifies t()'s first argument; false when nothing about the key can be read from it. */
function readKeyArg(node) {
  switch (node.type) {
    case 'Literal':
      if (typeof node.value !== 'string') return false;
      if (node.value) useKey(node.value); // t(x||'') falls back to nothing: not a key
      return true;
    case 'TemplateLiteral': {
      const head = node.quasis[0].value.cooked || '';
      if (!node.expressions.length) { useKey(head); return true; }
      if (!head) return false;
      prefixes.set(head, 't(`' + head + '${…}`)'); return true;
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return false;
      let l = node;
      while (l.type === 'BinaryExpression' && l.operator === '+') l = l.left;
      if (l.type !== 'Literal' || typeof l.value !== 'string' || !l.value) return false;
      prefixes.set(l.value, `t('${l.value}'+…)`); return true;
    }
    case 'ConditionalExpression': {
      const a = readKeyArg(node.consequent), b = readKeyArg(node.alternate);
      return a && b;
    }
    case 'LogicalExpression': {
      const a = readKeyArg(node.left), b = readKeyArg(node.right);
      return a || b;
    }
    default:
      return false;
  }
}
(function walk(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') literals.add(node.value);
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 't' && node.arguments.length) {
    if (!readKeyArg(node.arguments[0])) dynamicCalls++;
  }
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c); }
    else if (v && typeof v.type === 'string') walk(v);
  }
})(ast);

// Markup can name a key too: <span data-group="snavRides"> is read through t(el.dataset.group). Every
// attribute value outside the inline scripts counts as a literal.
{
  const markup = resolved.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g, '');
  for (const m of markup.matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) for (const w of (m[1] ?? m[2]).split(/\s+/)) if (w) literals.add(w);
}

// ── The other message dictionaries ─────────────────────────────────────────────────────────────
// Outside LANG, the messages staff copy and send (birthday wishes, the workshop's and the shop's
// messages, the Saturday ride's...) live in objects keyed by language: {en:'...', ar:'...'} or
// {en:{hi:'...', ready:'...'}, ar:{...}}. The same rule holds there: every language's string carries
// the fill-ins English does, or the message goes out with "{name}" in it or without the name.
{
  const LANG_CODES = new Set(codes);
  const textOf = (n) => (n.type === 'Literal' && typeof n.value === 'string' ? n.value
    : n.type === 'TemplateLiteral' ? n.quasis.map((q) => q.value.cooked).join('') : null);
  const keyOf = (p) => (p.key.type === 'Identifier' ? p.key.name : p.key.value);
  const flat = (obj, pre, out) => {
    for (const p of obj.properties) {
      if (p.type !== 'Property' || p.computed) continue;
      if (p.value.type === 'ObjectExpression') flat(p.value, `${pre}${keyOf(p)}.`, out);
      else { const v = textOf(p.value); if (v != null) out[pre + keyOf(p)] = v; }
    }
    return out;
  };
  const bad = [];
  let dicts = 0;
  (function walk(node) {
    if (node.type === 'ObjectExpression') {
      const byLang = {};
      for (const p of node.properties) if (p.type === 'Property' && !p.computed && LANG_CODES.has(keyOf(p))) byLang[keyOf(p)] = p.value;
      if (byLang.en && Object.keys(byLang).length > 1) {
        dicts++;
        const en = byLang.en.type === 'ObjectExpression' ? flat(byLang.en, '', {}) : { '': textOf(byLang.en) };
        for (const [code, v] of Object.entries(byLang)) {
          if (code === 'en') continue;
          const tr = v.type === 'ObjectExpression' ? flat(v, '', {}) : { '': textOf(v) };
          for (const k of Object.keys(en)) {
            if (en[k] == null || tr[k] == null) continue;
            if (holes(tr[k]) !== holes(en[k])) bad.push(`${code}${k ? '.' + k : ''} [${holes(tr[k])}] vs en [${holes(en[k])}] in "${en[k].slice(0, 40).replace(/\n/g, ' ')}"`);
          }
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c); }
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);
  if (bad.length) {
    failed = true;
    console.error(`check-i18n: ${bad.length} message(s) in the per-language dictionaries outside LANG carry different {n}/{name} placeholders from English (${dicts} dictionaries read):\n  ${bad.slice(0, 40).join('\n  ')}`);
  }
}

const undefinedKeys = [...used.keys()].filter((k) => !(k in en)).sort();
if (undefinedKeys.length) {
  failed = true;
  console.error(`check-i18n: ${undefinedKeys.length} key(s) the code asks t() for are not defined in en (t() would print the key itself): ${undefinedKeys.map((k) => `${k} (${used.get(k)}×)`).join(', ')}`);
}

const prefixList = [...prefixes.keys()].sort();
const referenced = (k) => used.has(k) || literals.has(k) || prefixList.some((p) => k.startsWith(p)) || DYNAMIC_KEYS.some((re) => re.test(k));
const unused = enKeys.filter((k) => !referenced(k)).sort();
if (unused.length) {
  const rows = [];
  for (let i = 0; i < unused.length; i += 6) rows.push('  ' + unused.slice(i, i + 6).join(', '));
  console.warn(`check-i18n: WARNING - ${unused.length} en key(s) are defined but nothing in the code references them: no t('key'), no string literal equal to the key, and no dynamic prefix (${prefixList.join(', ')}). Prune them (from en, ar and every i18n/*.json) when sure, or add the prefix to DYNAMIC_KEYS in scripts/check-i18n.mjs if the code builds them:\n${rows.join('\n')}`);
}

if (failed) process.exit(1);
console.log(`check-i18n: OK — ${enKeys.length} keys, parity across ${codes.join('/')}; ${used.size} keys named by t() calls, ${prefixList.length} dynamic prefixes (${prefixList.join(', ')}), ${dynamicCalls} t() calls with a computed key, ${unused.length} unreferenced`);
