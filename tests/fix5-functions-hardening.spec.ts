import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

// The public Pages Functions, hardened 2026-10-05: the error and CSP pings cannot be flooded into
// silence, the Instagram pass stays inside Cloudflare's subrequest limit, and the wallet selftests
// answer { ok } alone, at most six times a minute per isolate. Called directly, the way Cloudflare
// does, with the network stubbed. Each load is a fresh copy of the module (a data: URL, as in
// pages-functions.spec.ts: Playwright keeps one instance per file path, whatever the query), so a
// test's throttles start empty and are its own.

type Ctx = { request: Request; env?: Record<string, string> };
type Fn = (ctx: Ctx) => Promise<Response>;
let seq = 0;
async function load(rel: string, name: string): Promise<Fn> {
  const src = readFileSync(resolve(__dirname, '..', rel), 'utf8') + `\n// copy ${++seq} ${Math.random()}`; // unique: Node keeps a data: module per URL
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  return mod[name] as Fn;
}
// Runs fn with console.log/warn/error caught, so the function's log can be read and stays out of the report.
async function quiet<T>(fn: () => Promise<T>): Promise<{ out: T; logged: string }> {
  const logged: string[] = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try { return { out: await fn(), logged: logged.join('\n') }; } finally { Object.assign(console, real); }
}
const realFetch = globalThis.fetch;
const SITE = 'https://site.test';

test.describe('@staff:security the error ping cannot be flooded into silence', () => {
  let sent: string[] = [];
  test.beforeEach(() => {
    sent = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body)).content); return new Response('{}'); }) as typeof fetch;
  });
  test.afterEach(() => { globalThis.fetch = realFetch; });
  const env = { DISCORD_WEBHOOK: 'https://discord.test/hook' };
  const ping = (fn: Fn, body: unknown, ip: string) => fn({
    request: new Request(SITE + '/api/log-error', { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE, 'cf-connecting-ip': ip }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    env,
  });

  test('a body over 8 KB is refused unread; CI\'s probe still gets a JSON answer with "ok"', async () => {
    const fn = await load('functions/api/log-error.js', 'onRequestPost');
    const big = await ping(fn, { msg: 'x'.repeat(9000) }, '198.51.100.10');
    expect(big.status).toBe(413);
    expect(await big.json()).toHaveProperty('ok', false);
    expect(sent).toEqual([]);
    // .github/workflows/ci.yml posts {} with no Origin, configured or not, and reads "ok" in the body
    for (const e of [env, {}]) {
      const probe = await fn({ request: new Request(SITE + '/api/log-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env: e });
      expect(await probe.text()).toContain('"ok":');
    }
  });

  test('the same message from the same place is one alert, from however many phones', async () => {
    const fn = await load('functions/api/log-error.js', 'onRequestPost');
    const err = { msg: 'TypeError: x is undefined', src: SITE + '/app.js?v=1:1' };
    expect(await (await ping(fn, err, '198.51.100.11')).json()).toEqual({ ok: true });
    expect(await (await ping(fn, err, '198.51.100.12')).json()).toMatchObject({ ok: false, skipped: 'repeat' });
    expect(await (await ping(fn, { ...err, msg: 'TypeError: y is undefined' }, '198.51.100.13')).json()).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
  });

  test('junk in another shape spends the shared budget, never the app\'s own', async () => {
    const fn = await load('functions/api/log-error.js', 'onRequestPost');
    for (let i = 0; i < 6; i++) await ping(fn, { msg: 'junk ' + i, src: 'not the app' }, `198.51.100.${30 + i}`);
    expect(sent).toHaveLength(3); // the shared budget for the minute
    // what the app sends: a tag, or file:line of its own script
    expect(await (await ping(fn, { msg: 'Payment failed', src: 'catalog' }, '203.0.113.50')).json()).toEqual({ ok: true });
    expect(await (await ping(fn, { msg: 'Boom', src: SITE + '/staff.js?v=abc:1' }, '203.0.113.51')).json()).toEqual({ ok: true });
    expect(sent.slice(3).map((s) => s.includes('Payment failed') || s.includes('Boom'))).toEqual([true, true]);
    expect(await (await ping(fn, { msg: 'more junk', src: 'not the app' }, '198.51.100.99')).json()).toMatchObject({ skipped: 'throttled' });
  });
});

test.describe('@staff:security the CSP report endpoint hears only the site', () => {
  let pings: string[] = [];
  test.beforeEach(() => {
    pings = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { pings.push(JSON.parse(String(init?.body)).content); return new Response('{}'); }) as typeof fetch;
  });
  test.afterEach(() => { globalThis.fetch = realFetch; });
  const env = { DISCORD_WEBHOOK: 'https://discord.test/hook' };
  const report = (r: Record<string, string>, headers: Record<string, string>) => new Request(SITE + '/api/csp-report', {
    method: 'POST',
    headers: { 'content-type': 'application/csp-report', 'cf-connecting-ip': String(Math.random()), ...headers },
    body: JSON.stringify({ 'csp-report': { 'document-uri': SITE + '/', 'effective-directive': 'style-src-attr', 'blocked-uri': 'inline', 'script-sample': 'color:red', ...r } }),
  });

  test('a report from anywhere but the site\'s own pages is dropped; Sec-Fetch-Site or Origin says it is ours', async () => {
    const fn = await load('functions/api/csp-report.js', 'onRequestPost');
    await quiet(async () => {
      for (const h of <Record<string, string>[]>[{}, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' }, { origin: 'https://evil.test' }]) {
        expect((await fn({ request: report({}, h), env })).status).toBe(204);
      }
    });
    expect(pings).toEqual([]);
    await quiet(() => fn({ request: report({ 'script-sample': 'a' }, { origin: SITE }), env }));
    await quiet(() => fn({ request: report({ 'script-sample': 'b' }, { 'sec-fetch-site': 'same-origin' }), env }));
    expect(pings).toHaveLength(2);
  });

  test('the same violation is one alert on whichever page, and a body over the cap is not read', async () => {
    const fn = await load('functions/api/csp-report.js', 'onRequestPost');
    const same = { 'sec-fetch-site': 'same-origin' };
    await quiet(async () => {
      await fn({ request: report({ 'document-uri': SITE + '/' }, same), env });
      await fn({ request: report({ 'document-uri': SITE + '/bookings' }, same), env });
    });
    expect(pings).toHaveLength(1);
    // the Reporting API's list, 100 reports each carrying a long policy: over 64 KB
    const many = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ type: 'csp-violation', body: { effectiveDirective: 'script-src-elem', blockedURL: 'https://cdn.test/' + i + '.js', originalPolicy: 'x'.repeat(1000) } })));
    const { out, logged } = await quiet(() => fn({ request: new Request(SITE + '/api/csp-report', { method: 'POST', headers: { 'content-type': 'application/reports+json', ...same }, body: many }), env }));
    expect(out.status).toBe(204);
    expect(logged).toContain('not read');
    expect(pings).toHaveLength(1);
  });
});

test.describe('@staff:security the Instagram pass and Cloudflare\'s subrequest limit', () => {
  test.afterEach(() => { globalThis.fetch = realFetch; });
  const env = { IG_GRAPH_TOKEN: 'tok', IG_USER_ID: '1', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' };

  async function pass(throwOnSave = 0) {
    const handles = Array.from({ length: 40 }, (_, i) => `rider_${i}`);
    let calls = 0, saves = 0;
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      calls++;
      const url = decodeURIComponent(String(u));
      if (url.includes('/rpc/is_staff')) return new Response('true');
      if (url.includes('customer_ig_followers?select=tried_at')) return new Response('[]');
      if (url.includes('/rest/v1/customers?')) return new Response(JSON.stringify(handles.map((h) => ({ id: h, socials: { instagram: h } }))));
      if (url.includes('customer_ig_followers?select=*')) return new Response('[]');
      if (url.includes('business_discovery')) return new Response(JSON.stringify({ business_discovery: { followers_count: 10 } }));
      if (url.includes('customer_ig_followers?on_conflict')) {
        if (++saves === throwOnSave) throw new Error('Too many subrequests.');
        return new Response(JSON.stringify([JSON.parse(String(init?.body))]));
      }
      return new Response('[]');
    }) as typeof fetch;
    const fn = await load('functions/api/ig-followers.js', 'onRequestPost');
    const { out } = await quiet(() => fn({ request: new Request(SITE + '/api/ig-followers', { method: 'POST', body: JSON.stringify({ staffToken: 'st', stale: true }) }), env }));
    return { status: out.status, body: await out.json(), calls };
  }

  test('a stale pass makes at most 48 subrequests (the free plan allows 50)', async () => {
    const r = await pass();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, checked: 22 });
    expect(r.calls).toBeLessThanOrEqual(48);
  });

  test('a subrequest that throws ends the pass with what was counted, not a 500', async () => {
    const r = await pass(5);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, stopped: 'error', checked: 4 });
    expect(r.body.results.map((x: { customer_id: string }) => x.customer_id)).toEqual(['rider_0', 'rider_1', 'rider_2', 'rider_3']);
  });
});

test.describe('@staff:security the wallet selftests', () => {
  test.afterEach(() => { globalThis.fetch = realFetch; });
  const FIX = resolve(__dirname, 'fixtures', 'wallet');

  test('Apple: answers { ok } alone, at most six times a minute per isolate', async () => {
    const wwdrDer = new Uint8Array(readFileSync(resolve(FIX, 'test-ca.der')));
    globalThis.fetch = (async () => new Response(wwdrDer)) as typeof fetch;
    const env = { APPLE_PASS_CERT_PEM: readFileSync(resolve(FIX, 'test-pass-cert.pem'), 'utf8'), APPLE_PASS_KEY_PEM: readFileSync(resolve(FIX, 'test-pass-key.pem'), 'utf8'), APPLE_PASS_TYPE_ID: 'pass.test', APPLE_TEAM_ID: 'TEAM' };
    const get = await load('functions/api/wallet-pass.js', 'onRequestGet');
    const { out } = await quiet(async () => {
      const answers: [number, unknown][] = [];
      for (let i = 0; i < 7; i++) { const r = await get({ request: new Request(SITE + '/api/wallet-pass?selftest'), env }); answers.push([r.status, await r.json()]); }
      return answers;
    });
    expect(out.slice(0, 6)).toEqual(Array(6).fill([200, { ok: true }]));
    expect(out[6]).toEqual([429, { ok: false, error: 'rate limited' }]);
  });

  test('Google: answers { ok } alone, at most six times a minute per isolate', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const env = { GOOGLE_WALLET_ISSUER_ID: '3388000000000000001', GOOGLE_WALLET_SA_EMAIL: 'wallet@mm-test.iam.gserviceaccount.com', GOOGLE_WALLET_SA_KEY_PEM: privateKey };
    const get = await load('functions/api/google-wallet.js', 'onRequestGet');
    const { out } = await quiet(async () => {
      const answers: [number, unknown][] = [];
      for (let i = 0; i < 7; i++) { const r = await get({ request: new Request(SITE + '/api/google-wallet?selftest'), env }); answers.push([r.status, await r.json()]); }
      return answers;
    });
    expect(out.slice(0, 6)).toEqual(Array(6).fill([200, { ok: true }]));
    expect(out[6]).toEqual([429, { ok: false, error: 'rate limited' }]);
  });
});
