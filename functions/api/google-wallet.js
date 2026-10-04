// POST /api/google-wallet {customerId, token, bookingId, groupIds?} -> {ok, url}
// The rider's booking as a Google Wallet generic pass (2026-09-28), the Android half of the Apple
// pass in wallet-pass.js: the booking is read through the token-checked my_bookings RPC with the
// caller's own id and session token, so a rider can only ever hold a pass for their own booking,
// and the pass is a signed "save to wallet" JWT (RS256, the issuer's service account key) that
// carries the class and the object inline - Google creates both on save, so no REST call and no
// pre-made class are needed. The QR carries the same MMC- reference the desk scanner reads.
// GET /api/google-wallet?selftest signs a fixed payload and names the issuer, so a deploy is checked
// without a booking. Configuration (Pages env): GOOGLE_WALLET_ISSUER_ID, and the service account as
// either GOOGLE_WALLET_SA_JSON (the key file Google Cloud downloads, pasted whole) or
// GOOGLE_WALLET_SA_EMAIL + GOOGLE_WALLET_SA_KEY_PEM (its client_email and PKCS#8 private_key; the key
// may keep the file's escaped "\n" line breaks); optional SUPABASE_URL, SUPABASE_ANON_KEY (required).
// Without them the function answers 501 and the app hides its button.
const SUPA_DEFAULT = "https://qpffkzmsfyilicwcsszz.supabase.co";
const SAVE_URL = "https://pay.google.com/gp/v/save/";
const KIND_NAMES = { jcc: "Jeddah Corniche Circuit ride", saturday: "Saturday Social Ride", petromin: "Petromin ride", swim: "Swim session", workshop: "T100 Triathlon Prep", snd96: "Saudi National Day 96 Ride", event: "Event" };

function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
// The service account: the two separate settings win; otherwise they are read out of the key file.
function account(env) {
  let email = env.GOOGLE_WALLET_SA_EMAIL, pem = env.GOOGLE_WALLET_SA_KEY_PEM;
  if ((!email || !pem) && env.GOOGLE_WALLET_SA_JSON) {
    try { const j = JSON.parse(env.GOOGLE_WALLET_SA_JSON); email = email || j.client_email; pem = pem || j.private_key; } catch { /* not the key file */ }
  }
  return { email: email ? String(email).trim() : "", pem: pem || "" };
}
function configured(env) { const a = account(env); return !!(env.GOOGLE_WALLET_ISSUER_ID && a.email && a.pem); }
function missing(env) {
  const a = account(env), out = [];
  if (!env.GOOGLE_WALLET_ISSUER_ID) out.push("GOOGLE_WALLET_ISSUER_ID");
  if (!a.email || !a.pem) out.push(env.GOOGLE_WALLET_SA_JSON ? "GOOGLE_WALLET_SA_JSON (client_email and private_key)" : "GOOGLE_WALLET_SA_JSON (or GOOGLE_WALLET_SA_EMAIL + GOOGLE_WALLET_SA_KEY_PEM)");
  return out;
}
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function importKey(pem) {
  // A key copied out of the JSON file keeps its escaped line breaks ("\n") and maybe its quotes.
  const body = String(pem || "").replace(/\\n/g, "\n").replace(/^\s*"|"\s*$/g, "").replace(/-----(BEGIN|END)[A-Z ]*-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
async function signJwt(env, payload) {
  const key = await importKey(account(env).pem);
  const data = `${enc({ alg: "RS256", typ: "JWT" })}.${enc(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}
// The ride's clock, from bike_slots._time ("21:00 - 23:00"); null when the session carries none.
function rideTime(sess) {
  try { const t = JSON.parse(sess && sess.bike_slots || "{}")._time; return typeof t === "string" && /^\d{1,2}:\d{2}/.test(t) ? t : null; } catch { return null; }
}
function rideKind(sess) {
  const k = sess && sess.ride_kind;
  if (k === "snd96") return "snd96";
  if (!sess || sess.event_kind !== "community") return "jcc";
  return ["petromin", "swim", "workshop", "event"].includes(k) ? k : "saturday";
}
// The app's own tests (_isCommunity, _isApprovalRide, _commPublished), as the Apple pass reads them:
// the National Day ride left the community umbrella, and a ride staff approve is one whose
// needs_approval is anything but false.
function isCommunity(sess) { return !!sess && sess.event_kind === "community" && sess.ride_kind !== "snd96"; }
function isApproval(sess) { return isCommunity(sess) && sess.needs_approval !== false; }
function isPublished(sess) { return isCommunity(sess) && sess.hide_queue === false; }
// Rides that gather store "gathering - start" in _time and have no end (the app's KIND_TRAITS.gathering).
const GATHERS = { saturday: true, snd96: true };
// When the pass stops being a ticket: the ride's end on its own day (past midnight rolls into the
// next one), or the end of the ride's day when its clock has no end. A Jeddah time, +03:00.
function validUntil(b, sess) {
  const d = String(b.session_date || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!d) return null;
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim()); return m ? +m[1] * 60 + +m[2] : null; };
  const parts = String(rideTime(sess) || "").split("-").map((x) => x.trim()).filter(Boolean);
  const gathers = !!GATHERS[rideKind(sess)];
  let start = toMin(gathers ? parts[1] || parts[0] : parts[0]);
  if (gathers && start != null && toMin(parts[0]) != null && start < toMin(parts[0])) start += 1440;
  let end = gathers ? null : toMin(parts[1]);
  if (end != null && start != null && end <= start) end += 1440;
  if (end == null) end = Math.floor((start || 0) / 1440) * 1440 + 23 * 60 + 59;
  const t = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]) + end * 6e4);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}T${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:00+03:00`;
}
// A booking that is over, or was called off, is not a live ticket: Google shows it as such (the Apple
// pass is voided for the same statuses).
function passState(b) {
  const st = String(b.status || "");
  if (st === "done") return "COMPLETED";
  if (["cancelled", "noshow", "removed"].includes(st)) return "INACTIVE";
  return "ACTIVE";
}
const clean = (s, n) => String(s == null ? "" : s).replace(/\p{Cc}/gu, " ").trim().slice(0, n);
const idOk = (s) => /^[A-Za-z0-9._-]{1,64}$/.test(String(s || ""));

function passPayload(env, b, group, sess, approvalRide, origin) {
  const issuer = env.GOOGLE_WALLET_ISSUER_ID;
  const classId = `${issuer}.mm_ride`;
  const objectId = `${issuer}.mm_${String(b.id).replace(/[^A-Za-z0-9._-]/g, "")}`;
  const ref6 = String(b.id || "").slice(0, 6);
  const num = approvalRide ? null : b.queue_num;
  const ref = ["MMC", num != null ? String(num) : null, ref6].filter(Boolean).join("-");
  const kind = rideKind(sess);
  const name = clean(sess && sess.title, 60) || KIND_NAMES[kind] || KIND_NAMES.jcc;
  const when = [b.session_day, b.session_date].filter(Boolean).join(" ");
  const time = rideTime(sess);
  const until = validUntil(b, sess);
  const riders = group.map((r) => clean(r.name, 40)).filter(Boolean).join(", ");
  const bikes = [...new Set(group.map((r) => clean(r.type_preference, 20)).filter((x) => x && x !== "None" && x !== "Any"))].join(", ");
  const text = (id, header, body) => ({ id, header, body });
  const modules = [text("ref", "Reference", ref), text("when", "When", [when, time].filter(Boolean).join(" · ") || "-")];
  if (riders) modules.push(text("riders", group.length > 1 ? `Riders (${group.length})` : "Rider", riders));
  if (bikes) modules.push(text("bikes", "Bike", bikes));
  if (sess && sess.route_slug) modules.push(text("route", "Route", clean(sess.route_slug, 60)));
  return {
    genericClasses: [{ id: classId, classTemplateInfo: { cardTemplateOverride: { cardRowTemplateInfos: [
      { twoItems: { startItem: { firstValue: { fields: [{ fieldPath: "object.textModulesData['when']" }] } }, endItem: { firstValue: { fields: [{ fieldPath: "object.textModulesData['ref']" }] } } } },
    ] } } }],
    genericObjects: [{
      id: objectId, classId, state: passState(b),
      ...(until ? { validTimeInterval: { end: { date: until } } } : {}),
      cardTitle: { defaultValue: { language: "en", value: "MicroMobility" } },
      header: { defaultValue: { language: "en", value: name } },
      subheader: { defaultValue: { language: "en", value: [when, time].filter(Boolean).join(" · ") || "Booking" } },
      logo: { sourceUri: { uri: `${origin}/logo.png` }, contentDescription: { defaultValue: { language: "en", value: "MicroMobility" } } },
      hexBackgroundColor: "#0c7a3d",
      barcode: { type: "QR_CODE", value: ref, alternateText: ref },
      textModulesData: modules,
      linksModuleData: { uris: [{ uri: `${origin}/my-bookings`, description: "My bookings", id: "app" }] },
    }],
  };
}

// The Wallet REST API, for the update above: an OAuth token for the service account (a signed JWT
// grant, kept per isolate until shortly before it expires), then a PUT of the object. 404 means the
// rider never saved it - the save link creates it. Bounded, so a slow Google never holds the rider.
const OBJECTS_URL = "https://walletobjects.googleapis.com/walletobjects/v1/genericObject/";
let _token = null;
async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_token && _token.exp - 60 > now && _token.email === account(env).email) return _token.value;
  const assertion = await signJwt(env, { iss: account(env).email, scope: "https://www.googleapis.com/auth/wallet_object.issuer", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
    signal: globalThis.AbortSignal.timeout(4000),
  });
  if (!res.ok) return null;
  const j = await res.json();
  if (!j || !j.access_token) return null;
  _token = { value: j.access_token, exp: now + (Number(j.expires_in) || 3600), email: account(env).email };
  return _token.value;
}
async function updateObject(env, obj) {
  try {
    const token = await accessToken(env);
    if (!token) return;
    const res = await fetch(OBJECTS_URL + encodeURIComponent(obj.id), {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(obj), signal: globalThis.AbortSignal.timeout(4000),
    });
    if (!res.ok && res.status !== 404) console.warn("google-wallet: object update answered", res.status);
  } catch (e) {
    console.warn("google-wallet: object update failed", String((e && e.message) || e));
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!configured(env)) return json({ ok: false, skipped: "google wallet not configured" }, 501);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }
  const { customerId, token, bookingId } = body || {};
  if (!customerId || !token || !bookingId || !idOk(customerId) || !idOk(bookingId)) return json({ ok: false, error: "missing fields" }, 400);
  const groupIds = Array.isArray(body && body.groupIds) ? body.groupIds.filter((x) => typeof x === "string").slice(0, 50) : [];
  const SUPA = env.SUPABASE_URL || SUPA_DEFAULT, ANON = env.SUPABASE_ANON_KEY;
  if (!ANON) return json({ ok: false, error: "no anon key" }, 500);
  const hdr = { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" };
  const rpc = await fetch(`${SUPA}/rest/v1/rpc/my_bookings`, { method: "POST", headers: hdr, body: JSON.stringify({ p_id: customerId, p_token: token }) });
  if (!rpc.ok) return json({ ok: false, error: "lookup failed" }, 502);
  const rows = await rpc.json();
  const b = Array.isArray(rows) ? rows.find((r) => r.id === bookingId) : null;
  if (!b) return json({ ok: false, error: "not found" }, 404);
  const off = (r) => ["cancelled", "noshow", "removed"].includes(String(r.status || ""));
  let group = groupIds.length ? rows.filter((r) => groupIds.includes(r.id) && r.session_id === b.session_id && (r.id === b.id || !off(r))) : [b];
  if (!group.some((r) => r.id === b.id)) group = [b];
  let sess = null;
  if (b.session_id != null) {
    try {
      const sr = await fetch(`${SUPA}/rest/v1/rpc/list_sessions?id=eq.${encodeURIComponent(b.session_id)}`, { method: "POST", headers: hdr, body: JSON.stringify({ p_id: customerId, p_token: token }) });
      if (sr.ok) { const all = await sr.json(); if (Array.isArray(all)) sess = all.find((x) => x && x.id === b.session_id) || null; }
    } catch { /* the pass is still worth issuing without the clock */ }
  }
  // A ride staff approve: the pass is issued only to an approved rider, and without a number, as
  // the Apple pass and the app's own card hold that line.
  const approvalRide = sess ? isApproval(sess) : b.approval != null;
  if (approvalRide) {
    if (!sess) return json({ ok: false, error: "session unavailable" }, 503);
    // Approved AND the list published, as the app's _walletOk and the Apple pass hold it: until the
    // list goes out a rider's place is not theirs to know, let alone carry as a signed ticket.
    if (b.approval !== "approved" || !isPublished(sess)) return json({ ok: false, error: "not confirmed" }, 409);
    group = group.filter((r) => r.approval === "approved");
  }
  const origin = new URL(request.url).origin;
  try {
    const now = Math.floor(Date.now() / 1000);
    const payload = passPayload(env, b, group, sess, approvalRide, origin);
    const jwt = await signJwt(env, { iss: account(env).email, aud: "google", typ: "savetowallet", iat: now, origins: [origin], payload });
    // A save link creates the object only when it does not exist yet: a pass saved before, then
    // saved again after the time, the party or the booking's state moved, kept its first content.
    // So the object already in Google is brought up to date as well (best effort: a failure here
    // still hands the rider the link).
    await updateObject(env, payload.genericObjects[0]);
    return json({ ok: true, url: SAVE_URL + jwt });
  } catch (e) {
    console.error("google-wallet: sign failed", (e && e.stack) || e);
    return json({ ok: false, error: "sign failed" }, 500);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!new URL(request.url).searchParams.has("selftest")) return json({ ok: false, error: "POST a booking" }, 405);
  if (!configured(env)) return json({ ok: false, skipped: "google wallet not configured", missing: missing(env) }, 501);
  try {
    const jwt = await signJwt(env, { iss: account(env).email, aud: "google", typ: "savetowallet", iat: Math.floor(Date.now() / 1000), payload: { genericObjects: [] } });
    return json({ ok: true, issuer: env.GOOGLE_WALLET_ISSUER_ID, account: account(env).email, jwtLength: jwt.length });
  } catch (e) {
    console.error("google-wallet: selftest failed", (e && e.stack) || e);
    return json({ ok: false, error: "sign failed: " + String((e && e.message) || e) }, 500);
  }
}
