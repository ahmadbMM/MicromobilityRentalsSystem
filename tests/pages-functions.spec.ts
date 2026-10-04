import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';

// The Pages Functions never run under the suite's test server (python -m http.server), so a
// middleware rule that 404s an app asset, or a Wallet pass that is wrong on the phone, only ever
// showed in production. These call the functions directly, the way Cloudflare does, with the
// network stubbed. Each test imports a fresh copy (?n=) so module-level state does not leak.

type Ctx = { request: Request; env?: Record<string, string>; next?: () => Response };
type Fn = (ctx: Ctx) => Promise<Response>;
let seq = 0;
async function load(rel: string, name: string): Promise<Fn> {
  const url = pathToFileURL(resolve(__dirname, '..', rel)).href + '?n=' + ++seq;
  const mod = await import(url);
  return mod[name] as Fn;
}

test.describe('the middleware', () => {
  test('MM_HOLD=on answers pages with the hold page and /api with a 503; files and an unset hold pass', async () => {
    const onRequest = await load('functions/_middleware.js', 'onRequest');
    const req = (path: string, html = true) => new Request('https://site.test' + path, { headers: html ? { 'sec-fetch-mode': 'navigate' } : {} });
    const on = { MM_HOLD: 'on' };
    const page = await onRequest({ request: req('/bookings'), env: on, next: () => new Response('asset') });
    expect(page.status).toBe(503);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const body = await page.text();
    expect(body).toContain("We'll be back in a few minutes");
    expect(body).toContain('سنعود خلال دقائق');
    const api = await onRequest({ request: req('/api/booking-confirm', false), env: on, next: () => new Response('asset') });
    expect(api.status).toBe(503);
    const file = await onRequest({ request: req('/app.js', false), env: on, next: () => new Response('asset') });
    expect(await file.text()).toBe('asset');
    const off = await onRequest({ request: req('/'), env: {}, next: () => new Response('asset') });
    expect(await off.text()).toBe('asset');
  });

  test('MM_HOLD=on also answers the shell when the service worker refreshes it, marked so the worker can tell', async () => {
    // An installed device never navigates to the server: its worker serves the cached app and
    // refreshes it with a plain fetch of / - which used to get the real app back, hold or not.
    const onRequest = await load('functions/_middleware.js', 'onRequest');
    const on = { MM_HOLD: 'on' };
    for (const path of ['/', '/index.html', '/my-bookings', '/bookings/waitlist']) {
      const res = await onRequest({ request: new Request('https://site.test' + path), env: on, next: () => new Response('app') });
      expect(res.status, path).toBe(503);
      expect(res.headers.get('x-mm-hold'), path).toBe('1');
    }
    const api = await onRequest({ request: new Request('https://site.test/api/hold'), env: on, next: () => new Response('x') });
    expect(api.status).toBe(503);
    expect(api.headers.get('x-mm-hold')).toBe('1');
    for (const file of ['/app.js?v=1', '/styles.css', '/lang/ar.json'])
      expect(await (await onRequest({ request: new Request('https://site.test' + file), env: on, next: () => new Response('asset') })).text(), file).toBe('asset');
  });

  test('a control character in the address is a 404, never an exception', async () => {
    // Decoded, %0d%0a reached the Location header of the live host's staff redirect and the
    // Response constructor threw (a 500).
    const onRequest = await load('functions/_middleware.js', 'onRequest');
    for (const path of ['/bookings/%0d%0ax', '/bookings/a%0ab', '/x%00y'])
      expect((await onRequest({ request: new Request('https://micromobilityrentals.pages.dev' + path), next: () => new Response('asset') })).status, path).toBe(404);
    const ok = await onRequest({ request: new Request('https://micromobilityrentals.pages.dev/bookings/waitlist?session=4'), next: () => new Response('asset') });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('https://staff.micromobility.sa/bookings/waitlist?session=4');
  });

  const status = async (path: string) => {
    const onRequest = await load('functions/_middleware.js', 'onRequest');
    const res = await onRequest({ request: new Request('https://site.test' + path), next: () => new Response('asset') });
    return res.status;
  };

  test('serves the phone-number rules the "Looks off" check reads', async () => {
    // Blocked with the configs, production answered it 404 and every phone passed the check.
    expect(await status('/assets/phone-rules.json?v=1.13.13')).toBe(200);
    for (const ok of ['/', '/manifest.json', '/lang/ar.json', '/cities/sa.json', '/assets/tag-jcc.svg', '/staff/', '/.well-known/security.txt'])
      expect(await status(ok), ok).toBe(200);
  });

  test('still hides configs, sources and local databases, at any depth', async () => {
    for (const hidden of [
      '/assets/other.json', '/package.json', '/AGENTS.md', '/app.src.html', '/tests/x.png', '/scripts/deploy-now.sh',
      '/functions/api/wallet-pass.js', '/design_handoff_erp_reskin/a.html', '/.gitignore',
      '/visual/analytics.visual.ts', '/visual/x.png', '/playwright.visual.config.ts',
      // wrangler's dev state is tracked in git: the dotfile rule only read the LAST segment.
      '/.wrangler/state/v3/cache/miniflare-CacheObject/metadata.sqlite',
      '/.wrangler/state/v3/observability/x/metadata.sqlite-wal',
      '/assets/.cache/thing.png', '/data/app.db', '/x.sqlite-shm', '/%2Ewrangler/state/a.txt',
    ]) expect(await status(hidden), hidden).toBe(404);
  });
});

test.describe('the error ping to Discord', () => {
  const site = 'https://site.test';
  async function ping(onRequestPost: Fn, body: unknown, headers: Record<string, string> = {}) {
    return onRequestPost({
      request: new Request(site + '/api/log-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: site, 'cf-connecting-ip': '198.51.100.1', ...headers },
        body: JSON.stringify(body),
      }),
      env: { DISCORD_WEBHOOK: 'https://discord.test/hook' },
    });
  }
  let sent: { content: string; allowed_mentions?: { parse: string[] } }[] = [];
  const realFetch = globalThis.fetch;
  test.beforeEach(() => {
    sent = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return new Response('{}'); }) as typeof fetch;
  });
  test.afterEach(() => { globalThis.fetch = realFetch; });

  test('cannot ping the channel or break out of its code blocks', async () => {
    const post = await load('functions/api/log-error.js', 'onRequestPost');
    const res = await ping(post, { msg: 'boom\n```\n@everyone look', src: 'a`b', ua: '@here <@123>' });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].allowed_mentions).toEqual({ parse: [] });
    expect(sent[0].content).not.toMatch(/@(everyone|here)|<@123>/);
    expect(sent[0].content.match(/```/g)).toHaveLength(2); // only the block the function opens and closes
  });

  test('one sender posting junk does not silence another sender', async () => {
    const post = await load('functions/api/log-error.js', 'onRequestPost');
    // A sender of its own: the module's throttle outlives a test, and another test in this
    // worker may already have pinged from the default address.
    const junk = { 'cf-connecting-ip': '198.51.100.77' };
    await ping(post, { msg: 'junk' }, junk);
    expect(await (await ping(post, { msg: 'junk again' }, junk)).json()).toMatchObject({ skipped: 'throttled' });
    await ping(post, { msg: 'a real error' }, { 'cf-connecting-ip': '203.0.113.9' });
    expect(sent.map((s) => s.content.includes('a real error'))).toEqual([false, true]);
  });

  test('forwards nothing that did not come from the site itself', async () => {
    const post = await load('functions/api/log-error.js', 'onRequestPost');
    const res = await ping(post, { msg: 'x' }, { origin: 'https://evil.test' });
    expect(res.status).toBe(403);
    expect(await res.json()).toHaveProperty('ok', false); // still a function's JSON answer: CI's probe reads it
    expect(sent).toHaveLength(0);
  });
});

test.describe('the Apple Wallet pass', () => {
  // A throwaway signing identity, made with OpenSSL (tests/fixtures/wallet, password secret123): a
  // self-signed test CA standing in for Apple's WWDR certificate, a "Pass Type ID" certificate under
  // it, and the .p12 in the encoding Keychain Access still exports (3DES key, RC2-40 certificates,
  // SHA-1 MAC) - the one the signer has to open in production.
  const FIX = resolve(__dirname, 'fixtures', 'wallet');
  const p12b64 = readFileSync(resolve(FIX, 'test-pass.p12')).toString('base64');
  const wwdrDer = new Uint8Array(readFileSync(resolve(FIX, 'test-ca.der')));
  const PW = 'secret123';

  const booking = { id: 'abcdef123456', session_id: 's1', session_date: '2026-09-23', session_day: 'Wednesday', queue_num: 7, name: 'Rider', status: 'waiting', approval: null as string | null, price: 50 };
  const circuit = { id: 's1', event_kind: 'rental', ride_kind: null as string | null, bike_slots: JSON.stringify({ _time: '21:00 - 23:00' }), meet_url: null as string | null, needs_approval: false, hide_queue: false };
  const realFetch = globalThis.fetch;
  let sessionUrls: string[] = [];
  test.afterEach(() => { globalThis.fetch = realFetch; });

  async function pass(b: typeof booking, sess: Record<string, unknown> | null, pw = PW, party: { rows?: (typeof booking)[]; groupIds?: string[] } = {}) {
    sessionUrls = [];
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes('/rpc/my_bookings')) return new Response(JSON.stringify([b, ...(party.rows || [])]));
      if (url.includes('/rpc/list_sessions')) { sessionUrls.push(url); return new Response(JSON.stringify(sess ? [sess] : [])); }
      if (url.includes('apple.com')) return new Response(wwdrDer);
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const post = await load('functions/api/wallet-pass.js', 'onRequestPost');
    const res = await post({
      request: new Request('https://site.test/api/wallet-pass', { method: 'POST', body: JSON.stringify({ customerId: 'c1', token: 't', bookingId: b.id, ...(party.groupIds ? { groupIds: party.groupIds } : {}) }) }),
      env: { APPLE_PASS_P12_BASE64: p12b64, APPLE_PASS_P12_PASSWORD: pw, APPLE_PASS_TYPE_ID: 'pass.test', APPLE_TEAM_ID: 'TEAM', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' },
    });
    if (res.headers.get('content-type') !== 'application/vnd.apple.pkpass') return { status: res.status, body: await res.json(), json: null };
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    return { status: res.status, body: null, json: JSON.parse(strFromU8(files['pass.json'])) };
  }

  test('a ride that ends at midnight or later expires the next day, not before it starts', async () => {
    const { json } = await pass(booking, { ...circuit, bike_slots: JSON.stringify({ _time: '21:00 - 00:30' }) });
    expect(json.semantics.eventStartDate).toBe('2026-09-23T21:00:00+03:00');
    expect(json.expirationDate).toBe('2026-09-24T00:30:00+03:00');
    expect(json.relevantDate).toBe('2026-09-23T20:15:00+03:00');
    // Asking for the one session, not every session ever run.
    expect(sessionUrls[0]).toContain('/rpc/list_sessions?id=eq.s1');
  });

  test("a party pass counts the rider's live bookings on this ride only", async () => {
    const mate = { ...booking, id: 'mate01', queue_num: 8, name: 'Mate' };
    const gone = { ...booking, id: 'gone01', queue_num: 9, name: 'Gone', status: 'cancelled' };
    const other = { ...booking, id: 'othr01', session_id: 's2', queue_num: 3, name: 'Other night' };
    const { json } = await pass(booking, circuit, PW, { rows: [mate, gone, other], groupIds: [booking.id, mate.id, gone.id, other.id] });
    const riders = json.eventTicket.primaryFields.find((f: { key: string }) => f.key === 'riders');
    expect(riders.value).toBe('2 riders');
  });

  test('the directions link is a link, and the circuit is where the circuit ride meets', async () => {
    const { json } = await pass(booking, circuit);
    const dir = json.eventTicket.backFields.find((f: { key: string }) => f.key === 'directions');
    expect(dir.value).toMatch(/^https:\/\//);
    expect(dir.attributedValue).toBe(`<a href="${dir.value}">Open in Maps</a>`);
    expect(json.locations[0]).toMatchObject({ latitude: 21.6266, longitude: 39.1099 });
    expect(json.barcodes[0].message).toBe('MMC-7-abcdef');
  });

  test('a ride that meets elsewhere is placed there, or not at all', async () => {
    const pool = { ...circuit, event_kind: 'community', ride_kind: 'swim', needs_approval: false };
    const pinned = await pass(booking, { ...pool, meet_url: 'https://www.google.com/maps/place/Pool/@21.5433,39.1728,17z' });
    expect(pinned.json.locations[0]).toMatchObject({ latitude: 21.5433, longitude: 39.1728 });
    expect(pinned.json.locations[0].relevantText).not.toContain('Circuit');
    const short = await pass(booking, { ...pool, meet_url: 'https://maps.app.goo.gl/abc123' });
    expect(short.json.locations).toBeUndefined();
    expect(short.json.semantics.venueLocation).toBeUndefined();
  });

  test('a ride staff approve issues a pass only once approved and published, and never with its number in the QR', async () => {
    const sat = { ...circuit, event_kind: 'community', ride_kind: null, needs_approval: true, hide_queue: false, bike_slots: JSON.stringify({ _time: '05:30 - 06:00' }) };
    expect((await pass({ ...booking, approval: 'pending' }, sat)).status).toBe(409);
    expect((await pass({ ...booking, approval: 'approved' }, { ...sat, hide_queue: true })).status).toBe(409);
    expect((await pass({ ...booking, approval: 'approved' }, null)).status).toBe(503); // cannot be checked
    const ok = await pass({ ...booking, approval: 'approved' }, sat);
    expect(ok.status).toBe(200);
    expect(ok.json.barcodes[0].message).toBe('MMC-abcdef');
    expect(ok.json.barcode.message).toBe('MMC-abcdef');
  });

  test('add-ons and the TOTAL come from the booking and the shop, never from what the device sends', async () => {
    const withGel = { ...booking, addons: JSON.stringify([{ id: 'gel', qty: 2 }]) };
    const run = async (inventory: Response) => {
      globalThis.fetch = (async (u: string | URL | Request) => {
        const url = String(u);
        if (url.includes('/rpc/my_bookings')) return new Response(JSON.stringify([withGel]));
        if (url.includes('/rpc/list_sessions')) return new Response(JSON.stringify([circuit]));
        if (url.includes('/rest/v1/inventory')) return inventory;
        if (url.includes('apple.com')) return new Response(wwdrDer);
        return new Response('', { status: 404 });
      }) as typeof fetch;
      const post = await load('functions/api/wallet-pass.js', 'onRequestPost');
      const res = await post({
        request: new Request('https://site.test/api/wallet-pass', { method: 'POST', body: JSON.stringify({ customerId: 'c1', token: 't', bookingId: withGel.id, addons: [{ n: 'Gold bar', q: 1, p: 99999 }] }) }),
        env: { APPLE_PASS_P12_BASE64: p12b64, APPLE_PASS_P12_PASSWORD: PW, APPLE_PASS_TYPE_ID: 'pass.test', APPLE_TEAM_ID: 'TEAM', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' },
      });
      return JSON.parse(strFromU8(unzipSync(new Uint8Array(await res.arrayBuffer()))['pass.json']));
    };
    const json = await run(new Response(JSON.stringify([{ id: 'gel', name: 'Energy gel', price: 10 }])));
    const back = json.eventTicket.backFields.find((f: { key: string }) => f.key === 'addons');
    expect(back.value).toBe('Energy gel x2 - SAR 20');
    expect(JSON.stringify(json)).not.toContain('Gold bar');
    expect(json.eventTicket.auxiliaryFields.find((f: { key: string }) => f.key === 'total').value).toBe('SAR 70');
    // the shop could not be read: no add-ons named, and no TOTAL rather than a wrong one
    const blind = await run(new Response('', { status: 500 }));
    expect(blind.eventTicket.backFields.find((f: { key: string }) => f.key === 'addons')).toBeUndefined();
    expect(blind.eventTicket.auxiliaryFields.find((f: { key: string }) => f.key === 'total')).toBeUndefined();
  });

  test('a signing failure tells the rider nothing about the certificate', async () => {
    const res = await pass(booking, circuit, 'wrong password');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'sign failed' });
  });

  test('the signature is a detached CMS SignedData over manifest.json that the certificate verifies, carrying the WWDR one too', async () => {
    const W = await import('../scripts/wallet/sign.js' as string);
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes('/rpc/my_bookings')) return new Response(JSON.stringify([booking]));
      if (url.includes('/rpc/list_sessions')) return new Response(JSON.stringify([circuit]));
      return new Response(wwdrDer);
    }) as typeof fetch;
    const post = await load('functions/api/wallet-pass.js', 'onRequestPost');
    const res = await post({
      request: new Request('https://site.test/api/wallet-pass', { method: 'POST', body: JSON.stringify({ customerId: 'c1', token: 't', bookingId: booking.id }) }),
      env: { APPLE_PASS_P12_BASE64: p12b64, APPLE_PASS_P12_PASSWORD: PW, APPLE_PASS_TYPE_ID: 'pass.test', APPLE_TEAM_ID: 'TEAM', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' },
    });
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    for (const [name, sha] of Object.entries(manifest)) expect(await W.sha1hex(files[name])).toBe(sha); // every file is hashed
    const sig = files['signature'];
    const info = W.read(sig, 0), [ctOid, wrap] = W.kids(sig, info);
    expect(W.oidOf(sig, ctOid)).toBe('1.2.840.113549.1.7.2'); // signedData
    const sd = W.kids(sig, wrap)[0], [ver, algs, encap, certs, signers] = W.kids(sig, sd);
    expect(W.content(sig, ver)[0]).toBe(1);
    expect(W.oidOf(sig, W.kids(sig, W.kids(sig, algs)[0])[0])).toBe('2.16.840.1.101.3.4.2.1'); // sha256
    expect(W.kids(sig, encap)).toHaveLength(1); // detached: no eContent
    expect(W.kids(sig, certs)).toHaveLength(2); // the signer's certificate and the WWDR one
    const si = W.kids(sig, W.kids(sig, signers)[0]);
    const attrs = W.kids(sig, si[3]);
    const digestAttr = attrs.find((a: unknown) => W.oidOf(sig, W.kids(sig, a)[0]) === '1.2.840.113549.1.9.4');
    const carried = W.content(sig, W.kids(sig, W.kids(sig, digestAttr)[1])[0]); // Attribute { type, SET { OCTET STRING } }
    expect(W.hex(carried)).toBe(W.hex(await W.digest('SHA-256', files['manifest.json']))); // messageDigest is the manifest's
    // The RSA signature is over the attributes as a SET; the pass certificate's own key verifies it.
    const set = new Uint8Array(W.whole(sig, si[3])); set[0] = 0x31;
    const p12 = await W.openP12(new Uint8Array(Buffer.from(p12b64, 'base64')), PW);
    const tbs = W.kids(p12.cert, W.kids(p12.cert, W.read(p12.cert, 0))[0]);
    const spki = W.whole(p12.cert, tbs[tbs[0].tag === 0xa0 ? 6 : 5]);
    const pub = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, pub, W.content(sig, si[5]), set)).toBe(true);
  });

  test('PEM credentials sign the same pass, and ?selftest names the certificate without a booking', async () => {
    const env = { APPLE_PASS_CERT_PEM: readFileSync(resolve(FIX, 'test-pass-cert.pem'), 'utf8'), APPLE_PASS_KEY_PEM: readFileSync(resolve(FIX, 'test-pass-key.pem'), 'utf8'), APPLE_PASS_TYPE_ID: 'pass.test', APPLE_TEAM_ID: 'TEAM', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' };
    globalThis.fetch = (async () => new Response(wwdrDer)) as typeof fetch;
    const get = await load('functions/api/wallet-pass.js', 'onRequestGet');
    const res = await get({ request: new Request('https://site.test/api/wallet-pass?selftest'), env });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, source: 'pem', certificate: { subject: 'Pass Type ID: pass.test.wallet', issuer: 'Test Root CA' } });
    expect(j.signature.length).toBeGreaterThan(1000);
    expect((await get({ request: new Request('https://site.test/api/wallet-pass'), env })).status).toBe(405); // a plain GET is not a pass
    const off = await get({ request: new Request('https://site.test/api/wallet-pass?selftest'), env: {} });
    expect(off.status).toBe(501); // unconfigured says so
  });
});

test.describe('the Google Wallet pass', () => {
  // A throwaway service-account key, made fresh for each run; the signature is checked with its
  // public half. In production the key comes from the JSON file Google Cloud downloads, pasted whole
  // as GOOGLE_WALLET_SA_JSON, or as its two fields.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const EMAIL = 'wallet@mm-test.iam.gserviceaccount.com';
  const keyFile = JSON.stringify({ type: 'service_account', project_id: 'mm-test', private_key_id: 'k1', private_key: privateKey, client_email: EMAIL });
  const booking = { id: 'abcdef123456', session_id: 's1', session_date: '2026-09-23', session_day: 'Wednesday', queue_num: 7, name: 'Rider', status: 'waiting', approval: null as string | null, type_preference: 'Road' };
  const circuit = { id: 's1', event_kind: 'rental', ride_kind: null, bike_slots: JSON.stringify({ _time: '21:00 - 23:00' }), needs_approval: false };
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });

  const part = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  function verified(jwt: string) {
    const [h, p, sig] = jwt.split('.');
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'));
    return { ok, header: part(h), payload: part(p) };
  }
  async function selftest(env: Record<string, string>) {
    const get = await load('functions/api/google-wallet.js', 'onRequestGet');
    const res = await get({ request: new Request('https://site.test/api/google-wallet?selftest'), env });
    return { status: res.status, body: await res.json() };
  }

  test('?selftest signs with the whole key file, or with its two fields, escaped line breaks and all', async () => {
    const whole = await selftest({ GOOGLE_WALLET_ISSUER_ID: '3388000000000000001', GOOGLE_WALLET_SA_JSON: keyFile });
    expect(whole.status).toBe(200);
    expect(whole.body).toMatchObject({ ok: true, issuer: '3388000000000000001', account: EMAIL });
    // the key as it reads inside the file: one line with \n in it, even with its quotes
    const escaped = JSON.stringify(privateKey);
    for (const pem of [privateKey, escaped, escaped.slice(1, -1)]) {
      const r = await selftest({ GOOGLE_WALLET_ISSUER_ID: '3388000000000000001', GOOGLE_WALLET_SA_EMAIL: EMAIL, GOOGLE_WALLET_SA_KEY_PEM: pem });
      expect(r.body).toMatchObject({ ok: true, account: EMAIL });
    }
  });

  test('?selftest names what is missing, and a broken key says so without the key', async () => {
    const none = await selftest({});
    expect(none.status).toBe(501);
    expect(none.body.missing).toEqual(['GOOGLE_WALLET_ISSUER_ID', 'GOOGLE_WALLET_SA_JSON (or GOOGLE_WALLET_SA_EMAIL + GOOGLE_WALLET_SA_KEY_PEM)']);
    const noIssuer = await selftest({ GOOGLE_WALLET_SA_JSON: keyFile });
    expect(noIssuer.body.missing).toEqual(['GOOGLE_WALLET_ISSUER_ID']);
    const notAFile = await selftest({ GOOGLE_WALLET_ISSUER_ID: '1', GOOGLE_WALLET_SA_JSON: 'not json' });
    expect(notAFile.body.missing).toEqual(['GOOGLE_WALLET_SA_JSON (client_email and private_key)']);
    const bad = await selftest({ GOOGLE_WALLET_ISSUER_ID: '1', GOOGLE_WALLET_SA_EMAIL: EMAIL, GOOGLE_WALLET_SA_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' });
    expect(bad.status).toBe(500);
    expect(JSON.stringify(bad.body)).not.toContain('AAAA');
  });

  test('a booking becomes a signed save link carrying its ticket', async () => {
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes('/rpc/my_bookings')) return new Response(JSON.stringify([booking, { ...booking, id: 'mate01', queue_num: 8, name: 'Mate' }]));
      if (url.includes('/rpc/list_sessions')) return new Response(JSON.stringify([circuit]));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const post = await load('functions/api/google-wallet.js', 'onRequestPost');
    const res = await post({
      request: new Request('https://site.test/api/google-wallet', { method: 'POST', body: JSON.stringify({ customerId: 'c1', token: 't', bookingId: booking.id, groupIds: [booking.id, 'mate01'] }) }),
      env: { GOOGLE_WALLET_ISSUER_ID: '3388000000000000001', GOOGLE_WALLET_SA_JSON: keyFile, SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' },
    });
    expect(res.status).toBe(200);
    const { url } = await res.json();
    expect(url).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    const jwt = verified(url.split('/save/')[1]);
    expect(jwt.ok).toBe(true);
    expect(jwt.header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(jwt.payload).toMatchObject({ iss: EMAIL, aud: 'google', typ: 'savetowallet', origins: ['https://site.test'] });
    const obj = jwt.payload.payload.genericObjects[0];
    expect(obj.id).toBe('3388000000000000001.mm_abcdef123456');
    expect(obj.classId).toBe('3388000000000000001.mm_ride');
    expect(obj.barcode).toMatchObject({ type: 'QR_CODE', value: 'MMC-7-abcdef' });
    expect(obj.textModulesData.find((m: { id: string }) => m.id === 'riders')).toMatchObject({ header: 'Riders (2)', body: 'Rider, Mate' });
    expect(obj.logo.sourceUri.uri).toBe('https://site.test/logo.png');
  });

  async function gpass(b: typeof booking, sess: Record<string, unknown> | null, google?: (url: string, init?: RequestInit) => Response | null) {
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('/rpc/my_bookings')) return new Response(JSON.stringify([b]));
      if (url.includes('/rpc/list_sessions')) return new Response(JSON.stringify(sess ? [sess] : []));
      const g = google ? google(url, init) : null;
      return g || new Response('', { status: 404 });
    }) as typeof fetch;
    const post = await load('functions/api/google-wallet.js', 'onRequestPost');
    const res = await post({
      request: new Request('https://site.test/api/google-wallet', { method: 'POST', body: JSON.stringify({ customerId: 'c1', token: 't', bookingId: b.id }) }),
      env: { GOOGLE_WALLET_ISSUER_ID: '3388000000000000001', GOOGLE_WALLET_SA_JSON: keyFile, SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' },
    });
    const body = await res.json();
    return { status: res.status, obj: body.url ? verified(body.url.split('/save/')[1]).payload.payload.genericObjects[0] : null };
  }

  test('a ride staff approve: approved AND published, as the Apple pass and the app hold it', async () => {
    const sat = { ...circuit, event_kind: 'community', ride_kind: null, needs_approval: true, hide_queue: false, bike_slots: JSON.stringify({ _time: '05:30 - 06:00' }) };
    expect((await gpass({ ...booking, approval: 'pending' }, sat)).status).toBe(409);
    expect((await gpass({ ...booking, approval: 'approved' }, { ...sat, hide_queue: true })).status).toBe(409);
    const ok = await gpass({ ...booking, approval: 'approved' }, sat);
    expect(ok.status).toBe(200);
    expect(ok.obj.barcode.value).toBe('MMC-abcdef');
    // a gathering ride runs out at the end of its day
    expect(ok.obj.validTimeInterval).toEqual({ end: { date: '2026-09-23T23:59:00+03:00' } });
  });

  test('the pass runs out when the ride ends, and a booking that is over is not a live ticket', async () => {
    const live = await gpass(booking, { ...circuit, bike_slots: JSON.stringify({ _time: '21:00 - 00:30' }) });
    expect(live.obj.state).toBe('ACTIVE');
    expect(live.obj.validTimeInterval).toEqual({ end: { date: '2026-09-24T00:30:00+03:00' } });
    expect((await gpass({ ...booking, status: 'cancelled' }, circuit)).obj.state).toBe('INACTIVE');
    expect((await gpass({ ...booking, status: 'noshow' }, circuit)).obj.state).toBe('INACTIVE');
    expect((await gpass({ ...booking, status: 'done' }, circuit)).obj.state).toBe('COMPLETED');
  });

  test('a pass saved before is brought up to date in Google too, and a slow or failing Google never costs the link', async () => {
    const calls: { url: string; method?: string; body?: string; auth?: string }[] = [];
    const google = (url: string, init?: RequestInit) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) { calls.push({ url, body: String(init?.body) }); return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 })); }
      if (url.startsWith('https://walletobjects.googleapis.com/')) { calls.push({ url, method: init?.method, body: String(init?.body), auth: (init?.headers as Record<string, string>).Authorization }); return new Response('{}'); }
      return null;
    };
    const r = await gpass({ ...booking, status: 'cancelled' }, circuit, google);
    expect(r.status).toBe(200);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('https://walletobjects.googleapis.com/walletobjects/v1/genericObject/3388000000000000001.mm_abcdef123456');
    expect(put?.auth).toBe('Bearer tok');
    expect(JSON.parse(put!.body!).state).toBe('INACTIVE');
    const grant = new URLSearchParams(calls[0].body);
    expect(grant.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(verified(grant.get('assertion')!).payload).toMatchObject({ iss: EMAIL, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/wallet_object.issuer' });
    // Google refusing the update still hands the rider the save link
    const down = await gpass(booking, circuit, (url) => (url.includes('googleapis.com') ? new Response('', { status: 500 }) : null));
    expect(down.status).toBe(200);
  });
});

test.describe('the CSP report endpoint', () => {
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });
  const report = (r: Record<string, string>) => new Request('https://site.test/api/csp-report', { method: 'POST', headers: { 'content-type': 'application/csp-report', 'cf-connecting-ip': String(Math.random()) }, body: JSON.stringify({ 'csp-report': { 'document-uri': 'https://site.test/', ...r } }) });

  test('pings for the page\'s own violations, never for what an extension or an in-app browser injects', async () => {
    const pings: string[] = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { pings.push(JSON.parse(String(init?.body)).content); return new Response('{}'); }) as typeof fetch;
    const post = await load('functions/api/csp-report.js', 'onRequestPost');
    const env = { DISCORD_WEBHOOK: 'https://discord.test/hook' };
    for (const r of [
      { 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://connect.facebook.net/en_US/pcm.js', 'source-file': 'https://site.test/' },
      { 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://connect.facebook.net/en_US/promo.v2.js', 'source-file': 'iabjs' },
      { 'effective-directive': 'style-src-attr', 'blocked-uri': 'inline', 'source-file': 'chrome-extension://abc/content.js' },
    ]) expect((await post({ request: report(r), env })).status).toBe(204);
    expect(pings).toEqual([]);
    await post({ request: report({ 'effective-directive': 'style-src-attr', 'blocked-uri': 'inline', 'script-sample': 'color:red' }), env });
    expect(pings).toHaveLength(1);
    expect(pings[0]).toContain('style-src-attr blocked inline sample: color:red');
  });
});

test.describe('the contact card endpoint', () => {
  // An iPhone opens a vCard in Contacts only when the site serves it (functions/api/contact.js);
  // the staff page posts the card it built and gets the same bytes back as text/vcard.
  const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Rashid;Amal Al;;;\r\nFN:Amal Al Rashid\r\nTEL;TYPE=CELL:+966500000001\r\nEND:VCARD';
  const post = async (fields: Record<string, string>, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) => {
    const onRequestPost = await load('functions/api/contact.js', 'onRequestPost');
    return onRequestPost({
      request: new Request('https://site.test/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields),
      }),
    });
  };

  test('hands the card back inline as text/vcard, the shape Safari opens as a contact', async () => {
    const res = await post({ vcf: card, name: 'Amal Al Rashid' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/vcard; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="Amal Al Rashid\.vcf"; filename\*=UTF-8''Amal%20Al%20Rashid\.vcf$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(card);
  });

  test('an Arabic name is kept in filename*, with a plain stand-in for filename', async () => {
    const res = await post({ vcf: card, name: 'أمل الراشد' });
    const cd = res.headers.get('content-disposition') || '';
    expect(cd).toContain('filename="contact.vcf"');
    expect(cd).toContain("filename*=UTF-8''" + encodeURIComponent('أمل الراشد') + '.vcf');
  });

  test('answers only the site’s own pages', async () => {
    expect((await post({ vcf: card }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' })).status).toBe(403);
    expect((await post({ vcf: card }, {})).status).toBe(403);
    // Safari before Sec-Fetch-Site still sends Origin on a form POST.
    expect((await post({ vcf: card }, { origin: 'https://site.test' })).status).toBe(200);
  });

  test('refuses anything that is not a vCard, or too big to be one', async () => {
    expect((await post({ vcf: '<html><script>alert(1)</script></html>' })).status).toBe(400);
    expect((await post({ vcf: 'BEGIN:VCARD\r\nFN:' + 'x'.repeat(40000) + '\r\nEND:VCARD' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });
});

test.describe('@staff:security the push sender', () => {
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });

  test('sends only to the browsers\' own push services, and keeps the payload small and on this site', async () => {
    // A throwaway VAPID key and a subscriber key pair, made with WebCrypto as a browser would.
    const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const priv = Buffer.from(await crypto.subtle.exportKey('pkcs8', vapid.privateKey)).toString('base64url');
    const pub = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url');
    const sub = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', sub.publicKey)).toString('base64url');
    const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    const endpoints = ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QXyz', 'https://evil.example/hook', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'https://10.0.0.1/x'];
    const hits: string[] = [];
    const audit: string[] = [];
    let used = 0;
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('/rpc/is_staff')) return new Response('true');
      if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: '0f8fad5b-d9cb-469f-a165-70867728950e' }));
      if (url.includes('/rest/v1/staff_actions') && init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${used}` } });
      if (url.includes('/rest/v1/staff_actions')) { audit.push(String(init?.body || '')); used++; return new Response(null, { status: 201 }); }
      if (url.includes('/rest/v1/push_subscriptions')) return new Response(JSON.stringify(endpoints.map((endpoint) => ({ endpoint, p256dh, auth }))));
      hits.push(url);
      return new Response('', { status: 201 });
    }) as typeof fetch;
    const post = await load('functions/api/push-send.js', 'onRequestPost');
    const send = async (extra: Record<string, unknown>) => {
      hits.length = 0;
      const res = await post({
        request: new Request('https://site.test/api/push-send', { method: 'POST', body: JSON.stringify({ staffToken: 'st', customerId: 'c1', title: 'Hi', message: 'Your turn', ...extra }) }),
        env: { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' },
      });
      return res.json();
    };
    const r = await send({ url: '/my-bookings', tag: 'booking-q1' });
    expect(r).toMatchObject({ ok: true, sent: 2, total: 6 });
    expect(hits.sort()).toEqual(['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QXyz']);
    // a long address or a tag of any length cannot push the payload past one record
    const big = await send({ url: '/' + 'x'.repeat(5000), tag: 'y'.repeat(5000) });
    expect(big.sent).toBe(2);
    // every send is on record in staff_actions, under the sending account
    expect(audit).toHaveLength(2);
    expect(JSON.parse(audit[0])).toMatchObject({ user_id: '0f8fad5b-d9cb-469f-a165-70867728950e', view: 'push' });
    expect(JSON.parse(audit[0]).action).toMatch(/^push: Hi -> c1/);
    // thirty sends in ten minutes per account, counted from those rows
    used = 30;
    expect(await send({ url: '/' })).toMatchObject({ ok: false, error: 'rate limited' });
    expect(hits).toEqual([]);
  });

  test('a notification leads only to a page on this site, sent as its path', async () => {
    const src = readFileSync(resolve(__dirname, '../functions/api/push-send.js'), 'utf8');
    const body = src.slice(src.indexOf('function safeUrl('), src.indexOf('// The push services browsers subscribe with.'));
    const safeUrl = new Function(body + '; return safeUrl;')() as (u: string, o: string) => string;
    const o = 'https://site.test';
    expect(safeUrl('/my-bookings?x=1#t', o)).toBe('/my-bookings?x=1#t');
    expect(safeUrl('https://site.test/account', o)).toBe('/account');
    expect(safeUrl('./', o)).toBe('/');
    expect(safeUrl('', o)).toBe('./');
    expect(safeUrl('https://evil.test/x', o)).toBe('./');
    expect(safeUrl('//evil.test/x', o)).toBe('./');
    expect(safeUrl('/\\evil.test', o)).toBe('./');
    expect(safeUrl('http://site.test/x', o)).toBe('./');
    expect(safeUrl('javascript:alert(1)', o)).toBe('./');
    expect(safeUrl('/x', 'http://site.test')).toBe('./'); // never over plain http
  });
});

test.describe('the Instagram follower counts', () => {
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });

  test('a failed lookup is tried again within hours; only an account Instagram will not describe waits the month', async () => {
    const hours = (h: number) => new Date(Date.now() - h * 36e5).toISOString();
    const rows = [
      { customer_id: 'err7h', handle: 'err7h', status: 'error', tried_at: hours(7) },
      { customer_id: 'err1h', handle: 'err1h', status: 'error', tried_at: hours(1) },
      { customer_id: 'una10d', handle: 'una10d', status: 'unavailable', tried_at: hours(240) },
      { customer_id: 'ok3d', handle: 'ok3d', status: 'ok', followers: 5, tried_at: hours(72) },
    ];
    const looked: string[] = [];
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = decodeURIComponent(String(u));
      if (url.includes('/rpc/is_staff')) return new Response('true');
      if (url.includes('customer_ig_followers?select=tried_at')) return new Response('[]'); // no pass ran lately
      if (url.includes('/rest/v1/customers?')) return new Response(JSON.stringify(rows.map((r) => ({ id: r.customer_id, socials: { instagram: r.handle } }))));
      if (url.includes('customer_ig_followers?select=*')) return new Response(JSON.stringify(rows));
      const m = url.match(/business_discovery\.username\(([^)]+)\)/);
      if (m) { looked.push(m[1]); return new Response(JSON.stringify({ business_discovery: { followers_count: 10 } })); }
      return new Response('[{}]');
    }) as typeof fetch;
    const post = await load('functions/api/ig-followers.js', 'onRequestPost');
    const res = await post({
      request: new Request('https://site.test/api/ig-followers', { method: 'POST', body: JSON.stringify({ staffToken: 'st', stale: true }) }),
      env: { IG_GRAPH_TOKEN: 'tok', IG_USER_ID: '1', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' },
    });
    expect(res.status).toBe(200);
    expect(looked).toEqual(['err7h']);
  });
});
