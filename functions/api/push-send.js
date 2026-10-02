// Sends a Web Push notification to a rider's registered browsers.
//
// Activates only when VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY + SUPABASE_SERVICE_KEY are set
// as Cloudflare Pages env vars; until then it is a no-op, so calling it is always safe —
// the same dormant-until-configured pattern as booking-confirm.js.
//
// This implements RFC 8291 (aes128gcm payload encryption) and RFC 8292 (VAPID) directly
// against WebCrypto, because Workers cannot use the Node web-push library. The parts worth
// knowing when reading it:
//   • VAPID is an ES256 JWT proving WE sent this, signed with the private key whose public
//     half the browser saw at subscribe() time.
//   • The payload is encrypted to the SUBSCRIPTION's key, not ours: we generate a throwaway
//     ECDH pair per message, derive a shared secret with the browser's p256dh key, mix in
//     its auth secret and a random salt via HKDF, and AES-GCM the padded plaintext.
//   • The push service never sees the plaintext. It only routes the ciphertext.
//
// Only staff may call it: the body carries a staff Supabase access token, which is verified
// against the staff table before anything is sent. Otherwise anyone could push arbitrary
// text to every rider who ever enabled notifications.

export async function onRequestPost(context) {
  const { request, env } = context;
  const PUB = env.VAPID_PUBLIC_KEY, PRIV = env.VAPID_PRIVATE_KEY;
  const SERVICE = env.SUPABASE_SERVICE_KEY;
  if (!PUB || !PRIV || !SERVICE) return json({ ok: false, skipped: 'not configured' });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad body' }, 400); }
  const { staffToken, customerId, title, message, url, tag } = body || {};
  if (!staffToken || !customerId || !title) return json({ ok: false, error: 'missing fields' }, 400);

  const SUPA = env.SUPABASE_URL || 'https://qpffkzmsfyilicwcsszz.supabase.co';
  const ANON = env.SUPABASE_ANON_KEY;
  if (!ANON) return json({ ok: false, error: 'no anon key' }, 500);

  // Staff-only. A valid Supabase Auth session is not enough — it must be a session that
  // is_staff() would accept, which is what asking for the staff row proves.
  const who = await fetch(`${SUPA}/rest/v1/rpc/is_staff`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${staffToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!who.ok || (await who.json()) !== true) return json({ ok: false, error: 'not staff' }, 403);

  // Service-role read: push_subscriptions is not readable with the anon key.
  const subsRes = await fetch(
    `${SUPA}/rest/v1/push_subscriptions?customer_id=eq.${encodeURIComponent(customerId)}&select=*`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
  );
  if (!subsRes.ok) return json({ ok: false, error: 'lookup failed' }, 502);
  const subs = await subsRes.json();
  if (!Array.isArray(subs) || !subs.length) return json({ ok: true, sent: 0, reason: 'no subscriptions' });

  const payload = JSON.stringify({
    title: String(title).slice(0, 120),
    body: String(message || '').slice(0, 300),
    url: url || './',
    tag: tag || 'mm-general',
  });

  const results = await Promise.all(subs.map((s) => sendOne(s, payload, PUB, PRIV, env)));
  const sent = results.filter((r) => r.ok).length;

  // Clean up endpoints the push service says are gone. Leaving them behind means every
  // future send does pointless work and the failure count is meaningless.
  const dead = results.filter((r) => r.gone).map((r) => r.endpoint);
  if (dead.length) {
    await Promise.all(dead.map((ep) => fetch(
      `${SUPA}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(ep)}`,
      { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
    ).catch(() => {})));
  }

  return json({ ok: true, sent, total: subs.length, removed: dead.length });
}

async function sendOne(sub, payload, vapidPub, vapidPriv, env) {
  try {
    const endpoint = sub.endpoint;
    const audience = new URL(endpoint).origin;
    const jwt = await vapidJwt(audience, vapidPriv, env.VAPID_SUBJECT || 'mailto:info@micromobility.sa');
    const encrypted = await encryptPayload(payload, sub.p256dh, sub.auth);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400', // a day: a waitlist promotion is worth delivering to a phone that was off
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: `vapid t=${jwt}, k=${vapidPub}`,
        Urgency: 'high',
      },
      body: encrypted,
    });
    // 404/410 mean the browser dropped the subscription — it will never work again.
    if (res.status === 404 || res.status === 410) return { ok: false, gone: true, endpoint };
    return { ok: res.ok, endpoint, status: res.status };
  } catch (e) {
    return { ok: false, endpoint: sub.endpoint, error: String(e && e.message) };
  }
}

// ── RFC 8292: the VAPID JWT ──────────────────────────────────────────────────
async function vapidJwt(audience, privB64, subject) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, // spec caps this at 24h
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    'pkcs8', fromB64url(privB64),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// ── RFC 8291: aes128gcm payload encryption ───────────────────────────────────
async function encryptPayload(plaintext, p256dhB64, authB64) {
  const clientPub = fromB64url(p256dhB64);   // the browser's public key, uncompressed P-256
  const authSecret = fromB64url(authB64);    // 16 random bytes the browser chose
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // A throwaway keypair for THIS message. Reusing one across messages would let the push
  // service correlate them, and is explicitly discouraged by the spec.
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  const clientKey = await crypto.subtle.importKey(
    'raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey }, eph.privateKey, 256,
  ));

  // PRK: the shared secret, keyed by the auth secret, with the two public keys bound in so
  // the key cannot be reused against a different pair.
  const keyInfo = concat(
    new TextEncoder().encode('WebPush: info\0'),
    clientPub,
    ephPubRaw,
  );
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  // The record is padded with a single 0x02 delimiter (last-record marker).
  const data = concat(new TextEncoder().encode(plaintext), new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, data,
  ));

  // aes128gcm header: salt(16) ‖ record size(4, big-endian) ‖ key id length(1) ‖ key id
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([ephPubRaw.length]), ephPubRaw, ct);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8,
  );
  return new Uint8Array(bits);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
