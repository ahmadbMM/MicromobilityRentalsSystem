#!/usr/bin/env node
// The booking and staff app's STAGING COPY (2026-11-10, STAGING.md section 2).
//
// The same code as production, pointed at the staging database (Supabase jkfhiszcnuvoftvkzaye) and the staging website
// (staging.micromobility.sa), served from its own Cloudflare Pages project (micromobility-staff-staging), so staff can
// try the store's fulfilment and refunds without touching live. Nothing here changes the repository: the tree is copied
// to a temporary folder, rewritten there and built there with the ordinary build (scripts/build-html.mjs, which writes
// the policy, the worker's stamps and the middleware's hosts from what it reads), then assembled
// (scripts/assemble-dist.mjs) and checked.
//
//   STAGING_SUPABASE_ANON_KEY=<the staging project's anon key> node scripts/staging-build.mjs [--out dist-staging]
//       [--origin https://micromobility-staff-staging.pages.dev] [--keep]
//
// What it rewrites in the copy:
//   - every name of the production project (SUPABASE_URL, the preconnect link, the functions' fallbacks) -> staging's,
//     and SUPABASE_KEY -> the staging anon key (CI reads it from the repository variable STAGING_SUPABASE_ANON_KEY);
//   - site.config.json: origin -> the staging Pages address, no former addresses;
//   - STAFF_ORIGIN (app and middleware) -> the same address, so staff paths stay on it (the app and the middleware send
//     nothing on to a staff address that is their own);
//   - https://micromobility.sa -> https://staging.micromobility.sa (the website editor, links, and PAY_WEB, the website
//     whose server sends a card refund), which the build then names in the policy's connect-src;
//   - "[Staging] " before every title, noindex on every answer (the middleware treats every request as the staff host's)
//     and a robots.txt that shuts every crawler out.
// The result is checked: no production project name, no production address left (a listed few may stay, see ALLOWED).
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROD_REF = 'qpffkzmsfyilicwcsszz';
export const STAGING_REF = 'jkfhiszcnuvoftvkzaye';
export const STAGING_WEB = 'https://staging.micromobility.sa';
export const DEFAULT_ORIGIN = 'https://micromobility-staff-staging.pages.dev';
// Production addresses that must not survive in the staging copy (each a whole host).
export const PROD_HOSTS = ['micromobility.sa', 'experiences.micromobility.sa', 'staff.micromobility.sa', 'micromobilityrentals.pages.dev'];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const say = (m) => console.log(`staging-build: ${m}`);
const fail = (m) => { console.error(`staging-build: ${m}`); process.exit(1); };

// The anon key: a Supabase JWT whose ref is the staging project's (a production key here would point every staging
// page at nothing it may read, and is refused), or one of the newer publishable keys.
export function checkKey(key) {
  if (!key) return 'STAGING_SUPABASE_ANON_KEY is not set (the staging project\'s anon key, Supabase > Project settings > API)';
  if (/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)) return '';
  const p = key.split('.');
  if (p.length !== 3) return 'STAGING_SUPABASE_ANON_KEY is not a Supabase key';
  let claims;
  try { claims = JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return 'STAGING_SUPABASE_ANON_KEY is not a Supabase key'; }
  if (claims.ref !== STAGING_REF) return `STAGING_SUPABASE_ANON_KEY is for project ${claims.ref || '?'}, not staging (${STAGING_REF})`;
  if (claims.role !== 'anon') return `STAGING_SUPABASE_ANON_KEY is the ${claims.role || '?'} key: give the anon key`;
  return '';
}

// One rewrite that must happen: the text, or the build stops (a source that moved on would otherwise ship production).
function must(text, from, to, what, all = false) {
  const hit = typeof from === 'string' ? text.includes(from) : from.test(text);
  if (!hit) fail(`could not rewrite ${what} - has the source changed? (scripts/staging-build.mjs)`);
  if (typeof from === 'string') return all ? text.split(from).join(to) : text.replace(from, to);
  return text.replace(from, to);
}
// https://micromobility.sa as a whole origin (not staging.micromobility.sa, not micromobility.sa.example).
const PROD_WEB_RE = /https:\/\/micromobility\.sa(?![A-Za-z0-9.-])/g;

export function rewriteApp(src, { key, origin }) {
  let s = src;
  s = must(s, PROD_REF, STAGING_REF, 'the production project name', true);
  s = must(s, /const SUPABASE_KEY\s*=\s*'[^']*'/, `const SUPABASE_KEY  = '${key}'`, 'SUPABASE_KEY');
  s = must(s, /const STAFF_ORIGIN='https:\/\/staff\.micromobility\.sa'/, `const STAFF_ORIGIN='${origin}'`, 'STAFF_ORIGIN');
  s = s.replace(PROD_WEB_RE, STAGING_WEB);
  s = must(s, /<title>([^<]*)<\/title>/, '<title>[Staging] $1</title>', 'the page title');
  s = must(s, "function _pageTitle(){const b=t(", "function _pageTitle(){const b='[Staging] '+t(", '_pageTitle');
  s = must(s, /<meta charset="utf-8">/i, '<meta charset="utf-8">\n  <meta name="robots" content="noindex, nofollow">', 'the head (noindex)');
  return s;
}
export function rewriteMiddleware(src, { origin }) {
  let s = src;
  s = must(s, "const STAFF_ORIGIN = 'https://staff.micromobility.sa';", `const STAFF_ORIGIN = '${origin}';`, "the middleware's STAFF_ORIGIN");
  // every answer noindex and robots.txt closed, as the staff host's are
  s = must(s, 'const staffHost = /^staff\\./i.test(new URL(context.request.url).hostname);', 'const staffHost = true; // the staging copy: nothing here is for search engines', "the middleware's staff host test");
  return s;
}

async function listFiles(dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...await listFiles(p)); else out.push(p);
  }
  return out;
}
const TEXT = /\.(?:html|js|mjs|json|css|txt|xml|webmanifest|svg)$|(?:^|\/)_headers$|(?:^|\/)_redirects$/;
// What may still name production in the built copy: nothing that is fetched or linked to as an address.
export const ALLOWED = [];

export async function scan(dir) {
  const hits = [];
  const hostRe = new RegExp(`(?:https?://|wss://|//)(?:${PROD_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})(?![A-Za-z0-9.-])`, 'g');
  for (const f of await listFiles(dir)) {
    const rel = relative(dir, f);
    if (!TEXT.test(rel)) continue;
    const text = await readFile(f, 'utf8');
    for (const m of text.matchAll(new RegExp(PROD_REF, 'g'))) hits.push({ file: rel, what: PROD_REF, at: text.slice(Math.max(0, m.index - 40), m.index + 40) });
    for (const m of text.matchAll(hostRe)) hits.push({ file: rel, what: m[0], at: text.slice(Math.max(0, m.index - 40), m.index + 60) });
  }
  return hits.filter((h) => !ALLOWED.some((a) => a.file === h.file && h.at.includes(a.near)));
}

async function main() {
  const key = process.env.STAGING_SUPABASE_ANON_KEY || '';
  const bad = checkKey(key);
  if (bad) fail(bad);
  const origin = String(arg('--origin') || process.env.STAFF_STAGING_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin) || PROD_HOSTS.some((h) => origin === 'https://' + h)) fail(`--origin must be a bare https origin that is not production's, got ${origin}`);
  const out = resolve(root, arg('--out') || 'dist-staging');
  const work = await mkdtemp(join(tmpdir(), 'mm-staging-'));
  say(`copying the tree to ${work}`);
  // the files git knows (tracked, and new ones not ignored): what CI checks out, plus a local run's work in progress
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  for (const f of files) {
    const from = join(root, f);
    try { if (!(await stat(from)).isFile()) continue; } catch { continue; } // deleted in the working tree
    await mkdir(dirname(join(work, f)), { recursive: true });
    await cp(from, join(work, f));
  }
  await symlink(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');

  const appPath = join(work, 'app.src.html');
  await writeFile(appPath, rewriteApp(await readFile(appPath, 'utf8'), { key, origin }));
  const cfgPath = join(work, 'site.config.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  cfg.origin = origin; cfg.formerOrigins = [];
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  const mwPath = join(work, 'functions', '_middleware.js');
  await writeFile(mwPath, rewriteMiddleware(await readFile(mwPath, 'utf8'), { origin }));

  say('building (scripts/build-html.mjs, scripts/assemble-dist.mjs)');
  execFileSync(process.execPath, ['scripts/build-html.mjs'], { cwd: work, stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/assemble-dist.mjs'], { cwd: work, stdio: 'inherit' });
  const dist = join(work, 'dist');

  // The Pages Functions fall back to production's project when the Pages project has no SUPABASE_URL of its own.
  for (const f of await listFiles(join(dist, 'functions'))) {
    if (!/\.js$/.test(f)) continue;
    const t = await readFile(f, 'utf8');
    if (t.includes(PROD_REF)) await writeFile(f, t.split(PROD_REF).join(STAGING_REF));
  }
  // Every crawler shut out, every static file noindex too (the middleware does the rest).
  await writeFile(join(dist, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  const hp = join(dist, '_headers');
  await writeFile(hp, (await readFile(hp, 'utf8')).replace(/\s*$/, '\n') + '\n# The staging copy (scripts/staging-build.mjs): nothing here is for search engines.\n/*\n  X-Robots-Tag: noindex, nofollow\n');
  // The worker keeps the staff half for this host too: it is a staff copy, not the live customer address.
  const swp = join(dist, 'service-worker.js');
  const sw = await readFile(swp, 'utf8');
  const swLive = /const LIVE_CUSTOMER_HOST = self\.location\.hostname === '[^']*';/;
  if (!swLive.test(sw)) fail("could not rewrite the worker's LIVE_CUSTOMER_HOST - has service-worker.js changed?");
  await writeFile(swp, sw.replace(swLive, 'const LIVE_CUSTOMER_HOST = false; // the staging copy serves staff'));

  const hits = await scan(dist);
  if (hits.length) {
    for (const h of hits.slice(0, 40)) console.error(`  ${h.file}: ${h.what} ... ${h.at.replace(/\s+/g, ' ')}`);
    fail(`${hits.length} production name(s) or address(es) left in the staging copy`);
  }
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  if (!html.includes(`https://${STAGING_REF}.supabase.co`)) fail('the built page does not name the staging project');
  const headers = await readFile(hp, 'utf8');
  if (!headers.includes(`https://${STAGING_REF}.supabase.co`) || !headers.includes(STAGING_WEB)) fail("the policy's connect-src does not name the staging project and website");

  await rm(out, { recursive: true, force: true });
  await mkdir(dirname(out), { recursive: true });
  await cp(dist, out, { recursive: true });
  say(`wrote ${relative(root, out) || out} for ${origin} (project ${STAGING_REF}, website ${STAGING_WEB}); no production name left`);
  if (args.includes('--keep')) say(`the work tree is kept at ${work}`); else await rm(work, { recursive: true, force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
