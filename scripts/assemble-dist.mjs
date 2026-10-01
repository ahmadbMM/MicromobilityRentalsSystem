// Assembles dist/ as the exact set of files the production site serves, so the
// CI gated deploy (wrangler pages deploy dist) ships the SAME thing Cloudflare's
// git integration serves from the repo root — no more, no less.
//
// Run AFTER build:html (which regenerates index.html from app.src.html). Internal
// files (app.src.html, *.sql, *.md, tests/, scripts/, configs) are deliberately
// NOT copied, so the deployed artifact can't leak them even without the middleware.
import { rm, mkdir, copyFile, cp, access, readFile, writeFile } from 'node:fs/promises';
import CleanCSS from 'clean-css';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

// Files copied verbatim from repo root. Exported: scripts/build-html.mjs hashes what the service
// worker serves cache-first into its cache name from these same two lists, so the site that
// ships and the files the worker's cache name covers cannot drift apart.
export const FILES = [
  'index.html', 'app.js', 'app.css', 'styles.css', 'staff.js', 'service-worker.js', 'manifest.json', '404.html', // app.js, app.css: the customer half and its stylesheet, written minified by build-html
  'report.css', 'receipt.css', // the print windows' stylesheets (_reportShell, _ctPrintReceipt)
  '404.css', // the 404 page's
  '_headers', '_redirects',
  'robots.txt', 'sitemap.xml',
  'brand.png', 'hero.webp', 'icon-192.png', 'icon-512.png', 'logo.png', 'apple-touch-icon.png',
  'favicon.png', // the tab icon, shared with the partner form and the new site
  // referenced by the app + service-worker SHELL — missing any of these breaks cache.addAll on install
  'jcc.png', 'jcc-white.png', 'logo-dark.png', 'logo-mark-dark.png', 'og-image.png',
  // the same logos as lossless WebP, which the page itself uses (2026-10-01); the PNGs stay for links from elsewhere
  'logo.webp', 'logo-dark.webp', 'logo-mark-dark.webp', 'jcc.webp', 'jcc-white.webp',
];
// Directories copied recursively (functions/ MUST be inside dist for Pages Functions;
// vendor/ holds the self-hosted libraries; splash/ holds the iOS PWA launch screens).
// lang/ holds the build-generated translation packs the app fetches at runtime.
// assets/ holds the brand mark the loading state masks. cities/ holds one city list per
// country for the city-of-residence picker (scripts/build-cities.mjs).
export const DIRS = ['functions', 'staff', 'staff-parts', 'vendor', 'splash', 'fonts', 'lang', 'assets', 'cities']; // staff-parts: the staff half's sections, written by build-html

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  for (const f of FILES) {
    const src = join(root, f);
    if (!(await exists(src))) throw new Error(`assemble-dist: required file missing: ${f}`);
    await copyFile(src, join(dist, f));
  }
  // The stylesheet ships minified: 396 KB in the repo, and it blocks the first paint. The source
  // stays readable; only the copy in dist/ is squeezed (level 1: whitespace and comments, no rule
  // merging, so what the browser applies is the same). Its ?v= hash is of the source, so a change
  // still renames the URL (scripts/build-html.mjs).
  const css = new CleanCSS({ level: 1 }).minify(await readFile(join(root, 'styles.css'), 'utf8'));
  if (css.errors.length) throw new Error(`assemble-dist: styles.css did not minify: ${css.errors.join('; ')}`);
  await writeFile(join(dist, 'styles.css'), css.styles);
  console.log(`assemble-dist: styles.css ${css.stats.originalSize} -> ${css.stats.minifiedSize} bytes`);
  for (const d of DIRS) {
    const src = join(root, d);
    if (!(await exists(src))) { console.warn(`assemble-dist: skipping missing dir ${d}/`); continue; }
    await cp(src, join(dist, d), { recursive: true });
  }
  console.log(`assemble-dist: wrote dist/ (${FILES.length} files + ${DIRS.length} dirs)`);
}

// Only when run as a script; importing the lists must not rebuild dist/.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
