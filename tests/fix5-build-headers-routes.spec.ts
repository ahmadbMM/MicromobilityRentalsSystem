import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// What the build writes for Cloudflare (2026-10-05): the root page's Early Hints name only stable
// addresses, the policy's connect-src names the app's own Supabase project, and dist/_routes.json
// keeps static files off the middleware without letting anything past it that it must see.

const ROOT = resolve(__dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

test.describe('@build _headers', () => {
  test('the root page\'s Early Hints name the font only, never a hashed address Cloudflare would replay after a deploy', () => {
    const h = read('_headers');
    const block = h.match(/^\/\n {2}Link: ([^\n]*)\n/m);
    expect(block, 'the / rule with its Link header').not.toBeNull();
    expect(block![1]).toContain('</fonts/SpaceGrotesk-var-latin.woff2>; rel=preload; as=font');
    expect(block![1]).not.toMatch(/\?v=/);
    expect(block![1]).not.toMatch(/app\.(js|css)/);
  });

  test('connect-src names the project the app talks to, on https and wss, and no other Supabase host', () => {
    const ref = read('app.src.html').match(/const SUPABASE_URL\s*=\s*'https:\/\/([a-z0-9]+)\.supabase\.co'/)![1];
    const csp = read('_headers').match(/^ {2}Content-Security-Policy: (.*)$/m)![1];
    const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src '))!;
    const hosts = connect.split(/\s+/).slice(1);
    expect(hosts).toContain(`https://${ref}.supabase.co`);
    expect(hosts).toContain(`wss://${ref}.supabase.co`);
    expect(hosts.filter((x) => x.includes('supabase'))).toEqual([`https://${ref}.supabase.co`, `wss://${ref}.supabase.co`]);
  });
});

// Cloudflare's matching, as wrangler's pages-dev-util.ts writes it: "/x/*" is /x and all under it,
// "/x" is /x (and /x/), "*" anywhere else is any run of characters.
function ruleMatches(path: string, rule: string): boolean {
  let r: string;
  if (rule === '/' || rule === '/*') r = rule;
  else if (rule.endsWith('/*')) r = `${rule.slice(0, -2)}(/*)?`;
  else if (rule.endsWith('/')) r = `${rule.slice(0, -1)}(/)?`;
  else if (rule.endsWith('*')) r = rule;
  else r = `${rule}(/)?`;
  return new RegExp(`^${r.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`).test(path);
}
type Routes = { version: number; include: string[]; exclude: string[] };
const runsMiddleware = (r: Routes, path: string) => !r.exclude.some((x) => ruleMatches(path, x)) && r.include.some((x) => ruleMatches(path, x));
// The files under a directory as assemble-dist copies them (no dotfiles).
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name.startsWith('.')) continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel)); else out.push(rel);
  }
  return out;
}

test.describe('@build dist/_routes.json', () => {
  let routes: Routes;
  let onRequest: (ctx: unknown) => Promise<Response>;
  test.beforeAll(async () => {
    routes = (await import(pathToFileURL(join(ROOT, 'scripts/assemble-dist.mjs')).href)).routesJson();
    onRequest = (await import(pathToFileURL(join(ROOT, 'functions/_middleware.js')).href)).onRequest;
  });

  test('is a spec wrangler accepts', () => {
    expect(routes.version).toBe(1);
    expect(routes.include.length).toBeGreaterThan(0);
    const rules = [...routes.include, ...routes.exclude];
    expect(rules.length).toBeLessThanOrEqual(100);
    for (const x of rules) { expect(x.startsWith('/'), x).toBe(true); expect(x.length, x).toBeLessThanOrEqual(100); }
    for (const list of [routes.include, routes.exclude]) {
      for (const splat of list.filter((x) => x.endsWith('/*'))) {
        const stem = splat.slice(0, -1);
        expect(list.filter((x) => x !== splat && x.startsWith(stem)), `${splat} overlaps`).toEqual([]);
      }
    }
  });

  test('the middleware still runs for the pages, the app\'s addresses, /api, /staff and everything the denylist refuses', () => {
    for (const path of [
      '/', '/index.html', '/404.html', '/robots.txt', '/sitemap.xml', '/staff', '/staff/', '/staff/index.html',
      '/api/log-error', '/api/hold', '/api/wallet-pass', '/reserve', '/my-bookings', '/account', '/signup',
      '/bookings', '/bookings/waitlist', '/community/applications', '/website/bikes/fields', '/vendors/venues',
      '/package.json', '/AGENTS.md', '/app.src.html', '/functions/api/log-error.js', '/tests/x.png', '/scripts/serve.mjs',
      '/design_handoff_erp_reskin/a.html', '/.wrangler/state/v3/x.sqlite', '/.gitignore', '/x.sqlite-wal', '/no-such-page',
    ]) expect(runsMiddleware(routes, path), path).toBe(true);
  });

  test('every file it keeps off the middleware is one the middleware would have passed untouched, hold or not', async () => {
    const files: string[] = [];
    for (const rule of routes.exclude) {
      if (rule.endsWith('/*')) {
        const dir = rule.slice(1, -2);
        const under = walk(dir);
        expect(under.length, `${dir}/ ships files`).toBeGreaterThan(0);
        files.push(...under);
      } else {
        expect(statSync(join(ROOT, rule.slice(1))).isFile(), `${rule} is a file that ships`).toBe(true);
        files.push(rule.slice(1));
      }
    }
    expect(files.length).toBeGreaterThan(50);
    for (const rel of files) {
      const path = '/' + rel;
      expect(runsMiddleware(routes, path), path).toBe(false);
      for (const env of [{}, { MM_HOLD: 'on' }]) {
        const res = await onRequest({ request: new Request('https://site.test' + path, { headers: { 'sec-fetch-mode': 'no-cors' } }), env, next: () => new Response('asset') });
        expect(await res.text(), `${path} ${JSON.stringify(env)}`).toBe('asset');
      }
    }
  });
});
