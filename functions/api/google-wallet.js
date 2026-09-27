// POST /api/google-wallet {customerId, token, bookingId, groupIds?} -> {ok, url}
// The rider's booking as a Google Wallet generic pass (2026-09-28), the Android half of the Apple
// pass in wallet-pass.js: the booking is read through the token-checked my_bookings RPC with the
// caller's own id and session token, so a rider can only ever hold a pass for their own booking,
// and the pass is a signed "save to wallet" JWT (RS256, the issuer's service account key) that
// carries the class and the object inline - Google creates both on save, so no REST call and no
// pre-made class are needed. The QR carries the same MMC- reference the desk scanner reads.
// GET /api/google-wallet?selftest signs a fixed payload and names the issuer, so a deploy is checked
// without a booking. Configuration (Pages env): GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SA_EMAIL,
// GOOGLE_WALLET_SA_KEY_PEM (the service account's PKCS#8 private key), optional SUPABASE_URL,
// SUPABASE_ANON_KEY (required). Without them the function answers 501 and the app hides its button.
const SUPA_DEFAULT = "https://amyqxovbnlreassrqihr.supabase.co";
const SAVE_URL = "https://pay.google.com/gp/v/save/";
const KIND_NAMES = { jcc: "Jeddah Corniche Circuit ride", saturday: "Saturday Social Ride", petromin: "Petromin ride", swim: "Swim session", workshop: "T100 Triathlon Prep", snd96: "Saudi National Day 96 Ride", event: "Event" };

function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function configured(env) { return !!(env.GOOGLE_WALLET_ISSUER_ID && env.GOOGLE_WALLET_SA_EMAIL && env.GOOGLE_WALLET_SA_KEY_PEM); }
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function importKey(pem) {
  const body = String(pem || "").replace(/-----(BEGIN|END)[A-Z ]*-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
async function signJwt(env, payload) {
  const key = await importKey(env.GOOGLE_WALLET_SA_KEY_PEM);
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
function isApproval(sess) { return !!(sess && sess.event_kind === "community" && sess.needs_approval); }
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
      id: objectId, classId, state: "ACTIVE",
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
    if (b.approval !== "approved") return json({ ok: false, error: "not confirmed" }, 409);
    group = group.filter((r) => r.approval === "approved");
  }
  const origin = new URL(request.url).origin;
  try {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(env, { iss: env.GOOGLE_WALLET_SA_EMAIL, aud: "google", typ: "savetowallet", iat: now, origins: [origin], payload: passPayload(env, b, group, sess, approvalRide, origin) });
    return json({ ok: true, url: SAVE_URL + jwt });
  } catch (e) {
    console.error("google-wallet: sign failed", (e && e.stack) || e);
    return json({ ok: false, error: "sign failed" }, 500);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!new URL(request.url).searchParams.has("selftest")) return json({ ok: false, error: "POST a booking" }, 405);
  if (!configured(env)) return json({ ok: false, skipped: "google wallet not configured", missing: ["GOOGLE_WALLET_ISSUER_ID", "GOOGLE_WALLET_SA_EMAIL", "GOOGLE_WALLET_SA_KEY_PEM"].filter((k) => !env[k]) }, 501);
  try {
    const jwt = await signJwt(env, { iss: env.GOOGLE_WALLET_SA_EMAIL, aud: "google", typ: "savetowallet", iat: Math.floor(Date.now() / 1000), payload: { genericObjects: [] } });
    return json({ ok: true, issuer: env.GOOGLE_WALLET_ISSUER_ID, account: env.GOOGLE_WALLET_SA_EMAIL, jwtLength: jwt.length });
  } catch (e) {
    console.error("google-wallet: selftest failed", (e && e.stack) || e);
    return json({ ok: false, error: "sign failed: " + String((e && e.message) || e) }, 500);
  }
}
