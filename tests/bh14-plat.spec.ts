import { test, expect } from '@playwright/test';
import { freshModule } from './helpers/fresh-module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

// Bug hunt 2026-10-14 (platform): the Apple Wallet pass said things the app's own ticket does not.
type Fn = (ctx: { request: Request; env?: Record<string, string> }) => Promise<Response>;
type Field = { key: string; label: string; value: string };

test.describe('@bh14 the Apple Wallet pass says only what the ride has', () => {
  const FIX = resolve(__dirname, 'fixtures', 'wallet');
  const p12b64 = readFileSync(resolve(FIX, 'test-pass.p12')).toString('base64');
  const wwdrDer = new Uint8Array(readFileSync(resolve(FIX, 'test-ca.der')));
  const booking = { id: 'abcdef123456', session_id: 's1', session_date: '2026-09-23', session_day: 'Wednesday', queue_num: 7, name: 'Rider', status: 'waiting', approval: null as string | null, price: 50 as number | null, paid: false, type_preference: 'Hybrid' };
  const circuit = { id: 's1', event_kind: 'rental', ride_kind: null as string | null, bike_slots: JSON.stringify({ _time: '21:00 - 23:00' }), meet_url: null, needs_approval: false, hide_queue: false, paid_ride: false };
  const comm = (k: string, x: Record<string, unknown> = {}) => ({ ...circuit, event_kind: 'community', ride_kind: k, ...x });
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });

  async function pass(b: typeof booking, sess: Record<string, unknown>) {
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes('/rpc/my_bookings')) return new Response(JSON.stringify([b]));
      if (url.includes('/rpc/list_sessions')) return new Response(JSON.stringify([sess]));
      if (url.includes('apple.com')) return new Response(wwdrDer);
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const post = (await freshModule('functions/api/wallet-pass.js')).onRequestPost as Fn;
    const res = await post({
      request: new Request('https://site.test/api/wallet-pass', { method: 'POST', body: JSON.stringify({ customerId: 'c1', token: 't', bookingId: b.id }) }),
      env: { APPLE_PASS_P12_BASE64: p12b64, APPLE_PASS_P12_PASSWORD: 'secret123', APPLE_PASS_TYPE_ID: 'pass.test', APPLE_TEAM_ID: 'TEAM', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' },
    });
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.pkpass');
    const json = JSON.parse(strFromU8(unzipSync(new Uint8Array(await res.arrayBuffer()))['pass.json']));
    const all: Field[] = ['secondaryFields', 'auxiliaryFields', 'backFields'].flatMap((k) => json.eventTicket[k]);
    return { json, field: (key: string) => all.find((f) => f.key === key) };
  }

  test('a pool session has no bike collection, no "BIKE: None" and no first-come bikes line', async () => {
    const swim = await pass({ ...booking, type_preference: 'None', price: 30 }, comm('swim', { paid_ride: true }));
    expect(swim.field('collect')).toBeUndefined();
    expect(swim.field('collect_b')).toBeUndefined();
    expect(swim.field('bike')).toBeUndefined();
    expect(swim.field('start')).toMatchObject({ label: 'STARTS', value: '9:00 PM' });
    expect(swim.field('help')!.value).toBe('Show this pass on arrival.');
    expect(swim.json.relevantDate).toBe('2026-09-23T21:00:00+03:00');
    // the circuit keeps its collection time, its bike and its line about bikes
    const jcc = await pass(booking, circuit);
    expect(jcc.field('collect')).toMatchObject({ label: 'BIKE COLLECTION', value: '8:15 PM' });
    expect(jcc.field('collect_b')!.label).toBe('Collect your bike');
    expect(jcc.field('bike')!.value).toBe('Hybrid');
    expect(jcc.field('help')!.value).toContain('Bikes are assigned');
  });

  test('a ride that gathers says gathering on the back too', async () => {
    const sat = await pass({ ...booking, approval: 'approved' }, comm('saturday', { needs_approval: true, bike_slots: JSON.stringify({ _time: '06:30 - 07:00' }) }));
    expect(sat.field('collect')!.label).toBe('GATHERING TIME');
    expect(sat.field('collect_b')).toMatchObject({ label: 'Gathering', value: 'From 6:30 AM · the ride leaves at 7:00 AM' });
  });

  test('"Pay at the booth" only when something is owed', async () => {
    expect((await pass(booking, circuit)).field('pay')).toBeDefined();
    expect((await pass({ ...booking, paid: true }, circuit)).field('pay')).toBeUndefined();
    expect((await pass({ ...booking, price: 0 }, circuit)).field('pay')).toBeUndefined();
    expect((await pass({ ...booking, approval: 'approved' }, comm('saturday', { needs_approval: true }))).field('pay')).toBeUndefined(); // free ride
    expect((await pass({ ...booking, type_preference: 'None', price: 30 }, comm('swim', { paid_ride: true }))).field('pay')).toBeDefined();
  });

  test('a staff-only Any type is not printed as the bike', async () => {
    expect((await pass({ ...booking, type_preference: 'Any' }, circuit)).field('bike')).toBeUndefined();
  });
});

// The worker carried every older ?v= of every file into each new cache (2026-10-10 carryOver), so app.js,
// staff.js, the staff parts and the packs of every deploy piled up on a device for good.
test.describe('@bh14 the worker carries one copy of a file across an update', () => {
  test.use({ serviceWorkers: 'allow' });
  test('a file this version precached takes nothing old; of anything else only the newest copy comes', async ({ page }) => {
    const { createServer } = await import('node:http');
    const { readFile } = await import('node:fs/promises');
    const { join, extname } = await import('node:path');
    const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
    const root = process.cwd();
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
      const file = join(root, path === '/' ? '/index.html' : path);
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      readFile(file).then((body) => { res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(body); }, () => { res.writeHead(404); res.end('not found'); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    await page.route(/supabase\.co|open-meteo\.com|cloudflareinsights\.com/, (r) => r.abort());
    try {
      await page.goto(url + 'robots.txt');
      await page.evaluate(() => Promise.all([
        caches.open('mmcq-oldversion1').then((c) => Promise.all([
          c.put('/app.js?v=0000000000', new Response('old app')),
          c.put('/lang/fr.json?v=aaaaaaaaaa', new Response('{"old":1}', { headers: { date: 'Mon, 05 Oct 2026 10:00:00 GMT' } })),
        ])),
        caches.open('mmcq-oldversion2').then((c) => Promise.all([
          c.put('/lang/fr.json?v=bbbbbbbbbb', new Response('{"new":1}', { headers: { date: 'Sat, 10 Oct 2026 10:00:00 GMT' } })),
          c.put('/vendor/jsqr-1.4.0.min.js', new Response('/* kept */')),
        ])),
      ]));
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
      const read = () => page.evaluate(async () => {
        const keys = await caches.keys();
        const name = keys.find((k) => k.startsWith('mmcq-') && !k.startsWith('mmcq-oldversion')) || '';
        const c = await caches.open(name);
        const has = async (u: string) => !!(await c.match(u));
        return { oldApp: await has('/app.js?v=0000000000'), frOld: await has('/lang/fr.json?v=aaaaaaaaaa'), frNew: await has('/lang/fr.json?v=bbbbbbbbbb'), scanner: await has('/vendor/jsqr-1.4.0.min.js') };
      });
      await expect.poll(async () => { try { return await read(); } catch { return null; } }, { timeout: 10000 })
        .toEqual({ oldApp: false, frOld: false, frNew: true, scanner: true });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
