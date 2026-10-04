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

// A staff account may send this many notifications in this many minutes (counted in staff_actions).
const PUSH_LIMIT = 30;
const PUSH_WINDOW_MIN = 10;

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

  // Who is sending: the staff account behind the token. Every send is written to staff_actions
  // (the audit trail staff read in History > Log) with the service key, and the same rows are
  // the rate limit: a staff account may send PUSH_LIMIT notifications per PUSH_WINDOW_MIN
  // minutes. A counter in this isolate would not do: Workers run many isolates and drop them at
  // will, so the count lives in the database the sends are recorded in.
  const meRes = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${staffToken}` } });
  const me = meRes.ok ? await meRes.json().catch(() => null) : null;
  const uid = me && typeof me.id === 'string' ? me.id : '';
  if (!/^[0-9a-f-]{36}$/i.test(uid)) return json({ ok: false, error: 'not staff' }, 403);
  const since = new Date(Date.now() - PUSH_WINDOW_MIN * 60000).toISOString();
  const countRes = await fetch(
    `${SUPA}/rest/v1/staff_actions?user_id=eq.${uid}&action=like.${encodeURIComponent('push:*')}&at_server=gte.${encodeURIComponent(since)}&select=id`,
    { method: 'HEAD', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact' } },
  );
  const range = countRes.ok ? countRes.headers.get('content-range') || '' : '';
  const used = Number((range.split('/')[1]) || 'NaN');
  if (!Number.isFinite(used)) return json({ ok: false, error: 'rate check failed' }, 503); // refused rather than unmetered
  if (used >= PUSH_LIMIT) return json({ ok: false, error: 'rate limited', limit: PUSH_LIMIT, minutes: PUSH_WINDOW_MIN }, 429);

  // Service-role read: push_subscriptions is not readable with the anon key.
  const subsRes = await fetch(
    `${SUPA}/rest/v1/push_subscriptions?customer_id=eq.${encodeURIComponent(customerId)}&select=*`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
  );
  if (!subsRes.ok) return json({ ok: false, error: 'lookup failed' }, 502);
  const subs = await subsRes.json();
  if (!Array.isArray(subs) || !subs.length) return json({ ok: true, sent: 0, reason: 'no subscriptions' });

  const origin = new URL(request.url).origin;
  // The record first: a send that is not on record is not sent.
  const logRes = await fetch(`${SUPA}/rest/v1/staff_actions`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      at: new Date().toISOString(), user_id: uid, view: 'push',
      action: `push: ${String(title).slice(0, 120)} -> ${String(customerId).slice(0, 64)}`.slice(0, 300),
    }),
  });
  if (!logRes.ok) return json({ ok: false, error: 'audit failed' }, 502);
  const payload = JSON.stringify({
    title: String(title).slice(0, 120),
    body: String(message || '').slice(0, 300),
    url: safeUrl(url, origin),
    tag: String(tag || 'mm-general').replace(/[^\w.:-]/g, '').slice(0, 64) || 'mm-general',
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

// Where a notification may lead: an address on this site only, at most 500 characters - the
// payload has to fit one 4 KB record, and a tap must never open someone else's page. The value is
// resolved against this origin and must stay on it over https; what is sent is the path, query and
// hash alone (the service worker resolves it against its own origin), else './'.
function safeUrl(u, origin) {
  const s = String(u || '').trim();
  if (!s || s.length > 500) return './';
  let base;
  try { base = new URL(origin); } catch { return './'; }
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') return './';
  try {
    const x = new URL(s, base.origin + '/');
    if (x.origin !== base.origin) return './';
    if (x.protocol !== base.protocol) return './';
    return (x.pathname + x.search + x.hash) || './';
  } catch { return './'; }
}

// The push services browsers subscribe with. The endpoint is whatever a rider's browser registered
// (customer_push_subscribe), so it is a URL from outside: anything else is never POSTed to - this
// function would otherwise send a signed request wherever a rider pointed it.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
function pushEndpointOk(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

async function sendOne(sub, payload, vapidPub, vapidPriv, env) {
  try {
    const endpoint = sub.endpoint;
    if (!pushEndpointOk(endpoint)) return { ok: false, endpoint, error: 'endpoint not a known push service' };
    if (new TextEncoder().encode(payload).length > 3800) return { ok: false, endpoint, error: 'payload too large' };
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
