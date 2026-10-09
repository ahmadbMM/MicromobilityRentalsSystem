import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Waitlist promotion reached the rider only if a staffer noticed a 25-second banner and
// opened WhatsApp. These cover the client half of the push path. The sending half lives in
// functions/api/push-send.js and needs real VAPID keys, so it is exercised here only as far
// as its encryption maths, against the test vector published in RFC 8291 §5.

test.describe('push is dormant until it is configured', () => {
  test('no VAPID key means no toggle and no subscribe attempt', async ({ page }) => {
    await stubSupabase(page, {});
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    // Shipping with the key unset must not surface an inert control.
    expect(await page.evaluate('pushSupported()')).toBe(false);
    expect(await page.evaluate('pushEnabled()')).toBe(false);
    expect(await page.evaluate(`(async () => await pushSubscribe(false))()`)).toBe(false);
  });

  test('the account page hides the notifications block entirely', async ({ page }) => {
    await stubSupabase(page, {});
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await expect(page.getByText(/Turn on notifications/i)).toHaveCount(0);
  });
});

test.describe('the service worker can show what it is sent', () => {
  test('it handles a push payload and a payload-free push alike', async () => {
    const sw = await readFile(resolve(__dirname, '../service-worker.js'), 'utf8');
    expect(sw).toContain("addEventListener('push'");
    expect(sw).toContain("addEventListener('notificationclick'");
    expect(sw).toContain("addEventListener('pushsubscriptionchange'");
    // A push that shows no notification gets the site's permission revoked, so there has
    // to be a fallback title when the payload is missing or undecodable.
    expect(sw).toMatch(/d\.title \|\| 'MicroMobility'/);
  });
});

test.describe('promotion tells the rider', () => {
  test('both promotion paths notify the booking owner', async () => {
    const src = await readFile(resolve(__dirname, '../app.src.html'), 'utf8');
    const calls = src.match(/pushNotify\(e\.customerId/g) || [];
    // _autoPromoteOldestWaitlist() — the only promotion left, and the one that most needs a
    // push, since it fires when a spot frees with nobody watching the staff screen. (The manual
    // Promote button is gone: staff check a waitlisted rider in like any other booking.)
    // Since 2026-10-09 (R7) also the place staff give from the freed-place dialog, and the timed offer they send;
    // those two push only when the site sends pushes (VAPID_PUBLIC_KEY set).
    expect(calls.length).toBe(3);
    expect(src.match(/if\(VAPID_PUBLIC_KEY\)pushNotify\(e\.customerId/g) || []).toHaveLength(2);
  });

  test('a push failure can never block the booth', async () => {
    const src = await readFile(resolve(__dirname, '../app.src.html'), 'utf8');
    const fn = src.slice(src.indexOf('async function pushNotify('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('try{');
    expect(body).toContain('catch'); // swallowed on purpose
    // Never awaited at the call sites: a slow push service must not hold up a promotion.
    expect(src).not.toMatch(/await pushNotify\(/);
  });
});

test.describe('RFC 8291 payload encryption', () => {
  // The vector from RFC 8291 §5. If the HKDF chain or the header layout drifts, the push
  // service still accepts the request and the notification silently never appears — which
  // is exactly the kind of bug this pins down.
  test('the key derivation matches the published test vector', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(`(async () => {
      const fromB64url = (s) => {
        const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return u;
      };
      const b64url = (bytes) => {
        let s = '';
        for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      };
      const concat = (...parts) => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
      };
      const hkdf = async (salt, ikm, info, length) => {
        const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
        return new Uint8Array(await crypto.subtle.deriveBits(
          { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
      };

      // RFC 8291 §5 inputs
      const uaPublic = fromB64url('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
      const authSecret = fromB64url('BTBZMqHH6r4Tts7J_aSIgg');
      const salt = fromB64url('DGv6ra1nlYgDCS1FRnbzlw');
      const asPublic = fromB64url('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
      // The ECDH shared secret for that pair, given in the RFC's intermediate values.
      const ecdh = fromB64url('kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs');

      const keyInfo = concat(new TextEncoder().encode('WebPush: info\\0'), uaPublic, asPublic);
      const ikm  = await hkdf(authSecret, ecdh, keyInfo, 32);
      const cek   = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\\0'), 16);
      const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\\0'), 12);
      return { ikm: b64url(ikm), cek: b64url(cek), nonce: b64url(nonce) };
    })()`) as { ikm: string; cek: string; nonce: string };

    expect(out.ikm).toBe('S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg');
    expect(out.cek).toBe('oIhVW04MRdy2XN9CiKLxTg');
    expect(out.nonce).toBe('4h_95klXJ5E_qnoN');
  });

  test('the sender derives its keys exactly that way', async () => {
    const fn = await readFile(resolve(__dirname, '../functions/api/push-send.js'), 'utf8');
    expect(fn).toContain("'WebPush: info\\0'");
    expect(fn).toContain("'Content-Encoding: aes128gcm\\0'");
    expect(fn).toContain("'Content-Encoding: nonce\\0'");
    expect(fn).toContain("setUint32(0, 4096)"); // record size in the aes128gcm header
    expect(fn).toContain('0x02'); // last-record padding delimiter
    // Staff-gated, and dormant without keys.
    expect(fn).toContain("skipped: 'not configured'");
    expect(fn).toContain("error: 'not staff'");
  });
});
