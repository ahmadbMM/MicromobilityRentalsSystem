import { test, expect } from '@playwright/test';
import { freshModule } from './helpers/fresh-module';
import { generateKeyPairSync } from 'node:crypto';

// Pages Functions found wrong in the 2026-10-07 review, called the way Cloudflare calls them.
type Ctx = { request: Request; env?: Record<string, string>; next?: () => Response };
type Fn = (ctx: Ctx) => Promise<Response>;
const load = async (rel: string, name: string) => (await freshModule(rel))[name] as Fn;

test.describe('@build platform fixes (2026-10-07)', () => {
  test('the live host sends a staff address with a letter past Latin-1 on, encoded, never a 500', async () => {
    const onRequest = await load('functions/_middleware.js', 'onRequest');
    // %D9%85 is an Arabic letter: decoded, it reached the Location header and the Response threw.
    const res = await onRequest({ request: new Request('https://micromobilityrentals.pages.dev/bookings/%D9%85?session=4'), next: () => new Response('asset') });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://staff.micromobility.sa/bookings/%D9%85?session=4');
    const plain = await onRequest({ request: new Request('https://micromobilityrentals.pages.dev/bookings/waitlist/'), next: () => new Response('asset') });
    expect(plain.headers.get('location')).toBe('https://staff.micromobility.sa/bookings/waitlist');
  });

  test('an untitled Run for Her pass in Google Wallet is named Run for Her, not the Saturday ride', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const keyFile = JSON.stringify({ type: 'service_account', private_key: privateKey, client_email: 'wallet@mm-test.iam.gserviceaccount.com' });
    const booking = { id: 'run123456', session_id: 'r1', session_date: '2026-10-10', session_day: 'Saturday', queue_num: 3, name: 'Runner', status: 'waiting', approval: 'approved', run_km: 5 };
    const sess = { id: 'r1', event_kind: 'community', ride_kind: 'runher', title: null, needs_approval: true, hide_queue: false, bike_slots: JSON.stringify({ _time: '06:00 - 06:30' }) };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes('/rpc/my_bookings')) return new Response(JSON.stringify([booking]));
      if (url.includes('/rpc/list_sessions')) return new Response(JSON.stringify([sess]));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    try {
      const post = await load('functions/api/google-wallet.js', 'onRequestPost');
      const res = await post({
        request: new Request('https://site.test/api/google-wallet', { method: 'POST', body: JSON.stringify({ customerId: 'c1', token: 't', bookingId: booking.id }) }),
        env: { GOOGLE_WALLET_ISSUER_ID: '3388000000000000001', GOOGLE_WALLET_SA_JSON: keyFile, SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' },
      });
      expect(res.status).toBe(200);
      const { url } = await res.json();
      const payload = JSON.parse(Buffer.from(url.split('/save/')[1].split('.')[1], 'base64url').toString('utf8'));
      const obj = payload.payload.genericObjects[0];
      expect(obj.header.defaultValue.value).toBe('Run for Her');
      // it gathers, as the Apple pass reads it: no end on the clock, so the pass runs to the end of the day
      expect(obj.validTimeInterval).toEqual({ end: { date: '2026-10-10T23:59:00+03:00' } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
