// Generates a signed Apple Wallet pass (.pkpass) for a booking: POST /api/wallet-pass.
//
// THE SOURCE. functions/api/wallet-pass.js is built from this file, pass-images.js and sign.js by
// `npm run build:wallet` (esbuild) and committed; CI refuses a stale build. Until 2026-09-27 the
// bundle had been hand-edited for months and this file was behind it; the bundle's own code was
// brought back here, and node-forge (1.1 MB of it, with three open advisories) went: WebCrypto
// signs and hashes, sign.js reads the credentials and writes the CMS signature.
//
// Activates only when the Pass Type certificate is configured as Cloudflare Pages env vars;
// until then it returns 501 and the client hides the "Add to Apple Wallet" button.
//
// Credentials, either form (encrypted env vars):
//   APPLE_PASS_CERT_PEM + APPLE_PASS_KEY_PEM   - the certificate and its PKCS#8 (or PKCS#1) key as
//                                               PEM (APPLE_PASS_KEY_PASSWORD if the key PEM is
//                                               encrypted). Opens in a millisecond; preferred.
//   APPLE_PASS_P12_BASE64 + APPLE_PASS_P12_PASSWORD - the .p12 as Keychain Access exports it,
//                                               base64. Keychain's ciphers (3DES, RC2-40, the
//                                               SHA-1 KDF) take ~1 s to open on a cold start.
//   To convert:  openssl pkcs12 -in pass.p12 -nokeys -clcerts | openssl x509        (the cert PEM)
//                openssl pkcs12 -in pass.p12 -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt  (the key PEM)
//   APPLE_PASS_TYPE_ID      - e.g. pass.sa.micromobility.booking
//   APPLE_TEAM_ID           - the Apple team id
//   SUPABASE_URL / SUPABASE_ANON_KEY - already set for the other functions
//
// GET /api/wallet-pass?selftest signs a fixed manifest and answers { ok }, so a deploy can be
// checked without a booking. Since 2026-10-05 the certificate it used (where it was read from, its
// name and expiry) goes to the function's log, not into the public answer, and the signature is no
// longer handed out; a per-isolate limit keeps the signing from being run in a loop.
//
// Security: never trusts client-supplied booking data. It re-reads the booking through the
// token-checked my_bookings RPC using the caller's own customer id + session token, so a user
// can only ever mint a pass for a booking they actually own.

import { zipSync } from 'fflate';
import { PASS_IMAGES, RIDE_IMAGES } from './pass-images.js';
import { b64ToBytes, certPemToDer, importSigner, keyPemToPkcs8, openP12, sha1hex, signDetached } from './sign.js';

const SUPA_DEFAULT = "https://qpffkzmsfyilicwcsszz.supabase.co";
const DIRECTIONS = "https://maps.app.goo.gl/zJLjmiaJgfJDKQwY7";
export async function onRequestPost(context) {
  const { request, env } = context;
  const passTypeId = env.APPLE_PASS_TYPE_ID;
  const teamId = env.APPLE_TEAM_ID;
  if (!configured(env) || !passTypeId || !teamId) {
    return json({ ok: false, skipped: "wallet not configured" }, 501);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad body" }, 400);
  }
  const { customerId, token, bookingId } = body || {};
  if (!customerId || !token || !bookingId) return json({ ok: false, error: "missing fields" }, 400);
  const groupIds = Array.isArray(body && body.groupIds) ? body.groupIds.filter((x2) => typeof x2 === "string").slice(0, 50) : [];
  const SUPA = env.SUPABASE_URL || SUPA_DEFAULT;
  const ANON = env.SUPABASE_ANON_KEY;
  if (!ANON) return json({ ok: false, error: "no anon key" }, 500);
  const rpc = await fetch(`${SUPA}/rest/v1/rpc/my_bookings`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_id: customerId, p_token: token })
  });
  if (!rpc.ok) return json({ ok: false, error: "lookup failed" }, 502);
  const rows = await rpc.json();
  const b = Array.isArray(rows) ? rows.find((r) => r.id === bookingId) : null;
  if (!b) return json({ ok: false, error: "not found" }, 404);
  // The party is the rider's own bookings on THIS ride that are still live: the ids come from the
  // device, and a stale or edited list put another night's booking, or a cancelled one, on the
  // pass - in its rider count, its bike types and its price.
  const _off = (r) => ["cancelled", "noshow", "removed"].includes(String(r.status || ""));
  let group = groupIds.length ? rows.filter((r) => groupIds.includes(r.id) && r.session_id === b.session_id && (r.id === b.id || !_off(r))) : [b];
  if (!group.some((r) => r.id === b.id)) group = [b];
  // The booking rows carry no session times - queue_entries holds the date and the day, not
  // the clock - so the pass had none, and every pass expired at midnight. Read the session
  // itself, through the same door the rider's own app uses: list_sessions answers with what
  // THIS customer may see, so a tag-gated ride still resolves and nothing else leaks.
  // PostgREST filters a set-returning RPC like a table, so asking for the one id brings back
  // that row alone instead of every session ever run - egress is metered, and a pass needs one.
  // The find() below still picks by id, so the answer is right even if the filter were ignored.
  let sess = null;
  if (b.session_id != null) {
    try {
      const sr = await fetch(`${SUPA}/rest/v1/rpc/list_sessions?id=eq.${encodeURIComponent(b.session_id)}`, {
        method: "POST",
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_id: customerId, p_token: token })
      });
      if (sr.ok) {
        const all = await sr.json();
        if (Array.isArray(all)) sess = all.find((x) => x && x.id === b.session_id) || null;
      }
    } catch (e) { /* the pass is still worth issuing without it */ }
  }
  // A ride staff approve: the app offers the pass only once the rider is approved AND the list
  // is published (_walletOk), and its QR carries no queue number (bookingRef). The server has to
  // hold the same line, or a rider asking here directly gets a signed ticket - queue number and
  // all - for a place they have not been given. A booking that carries an approval state but
  // whose session could not be read cannot be checked, so it is not issued either.
  const approvalRide = sess ? _isApprovalRide(sess) : b.approval != null;
  if (approvalRide) {
    if (!sess) return json({ ok: false, error: "session unavailable" }, 503);
    // A partner's booking (queue_entries.partner, partner_book, 20261017120000) is confirmed when it
    // is made: it needs no Publish (the owner, 2026-10-17).
    if (b.approval !== "approved" || !(_commPublished(sess) || b.partner)) return json({ ok: false, error: "not confirmed" }, 409);
    group = group.filter((r) => r.approval === "approved");
  }
  // The add-ons are read here, off the bookings themselves and the shop's own prices: the list the
  // device sends (body.addons) is ignored, or a rider could print any add-on and any TOTAL on a
  // signed pass. When they cannot be read, the pass names none and shows no TOTAL rather than a
  // wrong one.
  const { addons, known: addonsKnown } = await _serverAddons(SUPA, ANON, group);
  try {
    const pkpass = await buildPkpass(b, { signer: await getSigner(env), passTypeId, teamId, addons, addonsKnown, group, sess, approvalRide });
    return new Response(pkpass, {
      headers: {
        "Content-Type": "application/vnd.apple.pkpass",
        // Named by the booking ref, not the queue number: on a ride staff approve the number is
        // never the rider's to see, and a file name is somewhere they would see it.
        "Content-Disposition": `attachment; filename="booking-${String(b.id || "").slice(0, 6)}.pkpass"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (e) {
    // The detail (a p12 password, a failed certificate fetch) is for the logs, not the rider's toast.
    console.error("wallet-pass: sign failed", (e && e.stack) || e);
    return json({ ok: false, error: "sign failed" }, 500);
  }
}
async function buildPkpass(b, cfg) {
  const group = Array.isArray(cfg.group) && cfg.group.length ? cfg.group : [b];
  const single = group.length === 1;
  const ref6 = b.id ? String(b.id).slice(0, 6) : "";
  const sess = cfg.sess || null;
  const ride = _rideOf(sess);
  const skin = RIDES[ride] || RIDES.jcc;
  // A ride staff approve never shows a rider their place in the order - not on the app's card,
  // not in its QR code - and the pass is the same ticket. It names the ride where the number
  // goes, and its code carries the ref alone (the desk scanner reads both forms, like the app's
  // bookingRef). Without the session to ask, a booking that carries an approval verdict is
  // taken to be one of those rides: hiding a number wrongly costs less than showing one.
  // onRequestPost has already decided (cfg.approvalRide, from _isApprovalRide) when it could.
  const approvalNoNum = cfg.approvalRide != null ? !!cfg.approvalRide : sess
    ? sess.event_kind === "community" && sess.ride_kind !== "snd96" && sess.needs_approval !== false
    : b.approval != null && b.approval !== "";
  // A Saturday Social Ride's list once it is published (the owner, 2026-10-25; the app's _satNumOk): a rider
  // on it sees the booking number, as on the app's card. The code keeps carrying the ref alone, as bookingRef.
  const satNum = approvalNoNum && ride === "saturday" && _commPublished(sess) && group.every((r) => r.approval === "approved" && !r.partner && r.status !== "waitlist");
  const hideNum = approvalNoNum && !satNum;
  const primaryNum = !approvalNoNum && b.queue_num != null ? String(b.queue_num) : "";
  const barcodeMsg = ["MMC", primaryNum, ref6].filter(Boolean).join("-");
  const nums = group.map((r) => r.queue_num != null ? Number(r.queue_num) : null).filter((n) => n != null).sort((a, c) => a - c);
  const when = `${b.session_day || ""} ${b.session_date || ""}`.trim();
  const shortWhen = _shortWhen(b.session_day, b.session_date);
  const clock = _sessTimes(sess);
  const collectStr = clock ? _hhmm(clock.collectMin) : "";
  const startStr = clock ? _hhmm(clock.startMin) : "";
  // an event names the place staff gave it (sessions.location), else the circuit; every other ride its skin's
  // (the Victory Lap and the DEFE run too, when staff gave one: they are races, not rides)
  const _loc = String((sess && sess.location) || "").trim();
  const _locName = { JCC: "Jeddah Corniche Circuit", JYC: "Jeddah Yacht Club" }[_loc] || _loc;
  const venue = ride === "event" ? _locName || "Jeddah Corniche Circuit" : (ride === "vlap" || ride === "defe5k") && _locName ? _locName : skin.venue;
  const rideName = (sess && sess.title) || skin.venue;
  const numsDisplay = hideNum ? rideName : _numsDisplay(nums) || (b.queue_num != null ? `#${b.queue_num}` : rideName);
  const time = _sessClock(sess) || b.session_time || "";
  const dates = _sessionDates(b, clock);
  // A booking that is over, or was called off, must not read as a live ticket. Apple cannot
  // take a pass off a phone - only the rider can delete one - but a pass built for a booking
  // that is no longer live is marked void, so it shows as void rather than as a ticket.
  const dead = ["done", "cancelled", "noshow", "removed"].includes(String(b.status || ""));
  // A run has runners, a start and a distance (queue_entries.run_km), not riders and a bike; the
  // Victory Lap has athletes (the app's vlNumLabel), and every other session with no bike has
  // participants: nothing on a session that is not a bike ride talks about riding or a bike
  // (the owner, 2026-10-18: "make sure all non-cycling related sessions dont include anything about
  // cycling anywhere").
  const isRun = ride === "runher" || ride === "defe5k";
  const isRace = ride === "vlap";
  const bikeRide = _needsBike(ride);
  const who = _people(ride);
  const ridersValue = single ? b.name || "" : `${group.length} ${who.many.toLowerCase()}`;
  // A ride with no bike (the pool, T100, an event) books its seats as type 'None', and 'Any' is a
  // staff-only choice: neither is a bike to print ("BIKE: None" on a pool session's pass). The Google
  // pass leaves both out the same way.
  const types = !bikeRide ? [] : [...new Set(group.map((r) => _bikeLabel(r.type_preference)).filter((x) => x && x !== "None" && x !== "Any"))];
  const bikeType = types.length === 1 ? types[0] : types.length > 1 ? "Mixed" : "";
  const addons = Array.isArray(cfg.addons) ? cfg.addons : [];
  const rentalSum = group.reduce((s, r) => s + (r.price != null && r.price !== "" && !Number.isNaN(+r.price) ? +r.price : 0), 0);
  const addonSum = addons.reduce((s, a) => s + (Number(a.p) || 0), 0);
  const grand = Math.round((rentalSum + addonSum) * 100) / 100;
  const priceStr = cfg.addonsKnown !== false && (rentalSum || addonSum) ? `SAR ${grand}` : "";
  // "Pay at the booth" only where something is owed, as the app's ticket says it: not on a free ride
  // (a community ride without paid_ride - the owner, 2026-10-06), not once every booking is paid, and
  // not when every price is a known zero with no add-ons.
  const freeRide = !!sess && _isCommunity(sess) && !sess.paid_ride;
  const allPaid = group.every((r) => r.paid === true);
  const zero = cfg.addonsKnown !== false && !addonSum && group.every((r) => r.price != null && r.price !== "" && +r.price === 0);
  const owes = !freeRide && !allPaid && !zero;
  // The queue number leads. It is what the desk asks for and what the rider has to read out,
  // so it takes the biggest line on the pass, and the name it belongs to keeps the other half:
  // the desk reads a number and a person off one line. The two clock times sit together below,
  // where collection followed by departure reads as one sequence rather than as two starts.
  const primary = [];
  primary.push({ key: "queue", label: hideNum ? _whatLabel(ride) : satNum ? (single ? "BOOKING NO." : "BOOKING NUMBERS") : isRun ? "RUNNER NO." : isRace ? "ATHLETE NO." : single ? "QUEUE" : "QUEUE NUMBERS", value: numsDisplay });
  if (ridersValue) primary.push({ key: "riders", label: (single ? who.one : who.many).toUpperCase(), value: ridersValue });
  const secondary = [];
  // A ride that gathers has no bikes to collect: that time is when to turn up.
  if (collectStr) secondary.push({
    key: "collect",
    label: _gathersTime(sess) ? "GATHERING TIME" : bikeRide ? "BIKE COLLECTION" : "ARRIVE BY",
    value: collectStr,
  });
  if (startStr) secondary.push({ key: "start", label: isRun ? "RUN STARTS" : isRace ? "RACE STARTS" : bikeRide ? "RIDE STARTS" : "STARTS", value: startStr });
  const auxiliary = [];
  if (bikeType) auxiliary.push({ key: "bike", label: "BIKE", value: bikeType });
  if (isRun && (b.run_km === 3 || b.run_km === 5)) auxiliary.push({ key: "distance", label: "DISTANCE", value: `${b.run_km} km` });
  if (priceStr) auxiliary.push({ key: "total", label: "TOTAL", value: priceStr });
  const ridersBack = single ? [] : [{
    key: "riders_list",
    label: who.many,
    value: group.slice().sort((a, c) => (a.queue_num || 0) - (c.queue_num || 0)).map((r) => {
      const bike = bikeRide ? _bikeLabel(r.type_preference) : "";
      return `${hideNum || r.queue_num == null ? "" : `#${r.queue_num} `}${r.name || ""}${bike && bike !== "None" && bike !== "Any" ? " - " + bike : ""}`.trim();
    }).join("\n")
  }];
  const addonsBack = addons.length ? [{ key: "addons", label: "Add-ons", value: addons.map((a) => `${a.n}${a.q > 1 ? " x" + a.q : ""} - SAR ${a.p}`).join("\n") }] : [];
  // A Saturday ride whose breakfast spot is told at a time staff chose (sessions.reveal_at, 2026-10-06): its
  // meeting point shows at once (20261006170000). A row that came without it while held (a database before
  // that) would read as the circuit here, so the pass then leaves the directions and the place out.
  const meetHeld = !!_revealAhead(sess) && !/^https:\/\//.test(String((sess && sess.meet_url) || ""));
  const meetUrl = meetHeld ? "" : _meetUrl(sess);
  const place = meetHeld ? null : _meetPlace(sess, bikeRide);
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    serialNumber: String(b.id),
    organizationName: "MicroMobility Rentals",
    description: hideNum ? `Booking - ${rideName}` : `Booking ${numsDisplay} - ${rideName}`,
    foregroundColor: skin.fg || "rgb(242,245,242)",
    backgroundColor: skin.bg,
    labelColor: skin.label,
    sharingProhibited: true,
    // Surface on the lock screen when bikes start going out, and expire when the night ends:
    // an expired pass leaves the stack and files itself away on its own.
    ...dates ? { relevantDate: dates.collect || dates.start, expirationDate: dates.end } : {},
    ...dead ? { voided: true } : {},
    barcodes: [{ format: "PKBarcodeFormatQR", message: barcodeMsg, messageEncoding: "iso-8859-1", altText: numsDisplay }],
    // keep the legacy single-barcode field too for older iOS
    barcode: { format: "PKBarcodeFormatQR", message: barcodeMsg, messageEncoding: "iso-8859-1", altText: numsDisplay },
    // Lock-screen relevance at the place the ride actually meets. Only the circuit's own meeting
    // point, or a custom one whose link carries coordinates, can be placed; a ride that meets
    // somewhere the pass cannot pin gets no location rather than the circuit's.
    ...place ? { locations: [{ latitude: place.lat, longitude: place.lng, relevantText: place.text }] } : {},
    // Semantic tags let iOS drive Live Activities, lock-screen relevance and the event guide.
    semantics: {
      eventName: rideName,
      venueName: venue,
      ...place ? { venueLocation: { latitude: place.lat, longitude: place.lng } } : {},
      eventType: "PKEventTypeGeneric",
      ...dates ? { eventStartDate: dates.start, eventEndDate: dates.end } : {}
    },
    eventTicket: {
      // Header is the ONLY field visible when the pass is collapsed in the stack — put the
      // most useful glance value (the date) here so a rider can find this pass among others.
      headerFields: [{ key: "date", label: "SESSION", value: shortWhen || "Circuit" }],
      primaryFields: primary,
      secondaryFields: secondary,
      auxiliaryFields: auxiliary,
      backFields: [
        { key: "when", label: "Session", value: `${when}${time ? " \xB7 " + time : ""}`.trim() },
        // A ride that gathers has no bike to collect (the front says GATHERING TIME): the back says so too.
        ...collectStr ? [{ key: "collect_b", label: _gathersTime(sess) ? "Gathering" : bikeRide ? "Collect your bike" : "Arrive", value: `From ${collectStr}${startStr ? ` \xB7 ${isRun ? "the run starts" : isRace ? "the race starts" : bikeRide ? "the ride leaves" : "it starts"} at ${startStr}` : ""}` }] : [],
        { key: "venue", label: "Venue", value: venue },
        // Wallet reads link markup only in attributedValue; in value it printed the raw <a> tag.
        ...meetHeld ? [] : [{ key: "directions", label: "Directions", value: meetUrl, attributedValue: `<a href="${_attr(meetUrl)}">Open in Maps</a>` }],
        ...ridersBack,
        ...addonsBack,
        ...owes ? [{ key: "pay", label: "Payment", value: "Pay at the booth \u2014 cash, mada or STC Pay." }] : [],
        { key: "help", label: "Good to know", value: bikeRide ? "Show this pass on arrival. Bikes are assigned first come, first served, so arrive a little early to get the type you picked." : "Show this pass on arrival." },
        { key: "ref", label: "Reference", value: barcodeMsg }
      ]
    }
  };
  const files = {};
  files["pass.json"] = strBytes(JSON.stringify(pass));
  // A ride with art of its own replaces only the files it names; the icon stays MicroMobility.
  const art = { ...PASS_IMAGES, ...(RIDE_IMAGES[ride] || {}) };
  for (const [name, b64] of Object.entries(art)) files[name] = b64Bytes(b64);
  const manifest = {};
  for (const [name, bytes] of Object.entries(files)) manifest[name] = await sha1hex(bytes);
  const manifestStr = JSON.stringify(manifest);
  files["manifest.json"] = strBytes(manifestStr);
  files["signature"] = await signDetached(cfg.signer, strBytes(manifestStr), [await getWWDR()]);
  return zipSync(files, { level: 6 });
}
function _numsDisplay(nums) {
  if (!nums || !nums.length) return "";
  if (nums.length === 1) return `#${nums[0]}`;
  const consecutive = nums.every((n, i2) => i2 === 0 || n === nums[i2 - 1] + 1);
  if (consecutive) return `#${nums[0]}-#${nums[nums.length - 1]}`;
  return nums.map((n) => `#${n}`).join(", ");
}
function _shortWhen(day, date) {
  const d = String(day || "").trim().slice(0, 3);
  const dt = String(date || "").trim().replace(/\s*\d{4}\s*$/, "");
  return `${d} ${dt}`.trim();
}
const _MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function _meetUrl(sess) {
  const u = sess && sess.meet_url ? String(sess.meet_url) : "";
  return /^https:\/\//.test(u) ? u : DIRECTIONS;
}
// When a ride's breakfast spot is told, in Riyadh time ("Fri 9 Oct, 8:00 pm"), while that is still ahead;
// "" when it is told already or the ride holds nothing back.
function _revealAhead(sess) {
  const r = Date.parse((sess && sess.reveal_at) || "");
  if (!(r > Date.now())) return "";
  try {
    return new Date(r).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
  } catch (e) { return "soon"; }
}
const CIRCUIT = { lat: 21.6266, lng: 39.1099, text: "Your ride is nearby - the Circuit is just ahead" };
// A session with no bike is not "your ride" (the owner, 2026-10-18).
const CIRCUIT_ANY = { ...CIRCUIT, text: "The Circuit is just ahead" };
// Where the ride meets, as coordinates. No link of its own means the circuit (the directions
// link is the circuit's too). A link of its own is placed only when it spells out coordinates
// (".../@21.5,39.1,17z", "?q=21.5,39.1", "?query=..." and the like); a short maps.app.goo.gl
// link does not, and then there is no place rather than the wrong one.
function _meetPlace(sess, bikeRide = true) {
  const u = _meetUrl(sess);
  if (u === DIRECTIONS) return bikeRide ? CIRCUIT : CIRCUIT_ANY;
  let s = u;
  try { s = decodeURIComponent(u); } catch (e) { /* keep the raw link */ }
  const m = s.match(/@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/) || s.match(/[?&](?:q|query|ll|destination|daddr)=(?:loc:)?(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return null;
  return { lat, lng, text: bikeRide ? "Your ride's meeting point is nearby" : "Your meeting point is nearby" };
}
function _attr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// The app's own tests (_isCommunity, _isApprovalRide, _commPublished), read off the same row.
function _isCommunity(s) {
  return !!s && s.event_kind === "community" && s.ride_kind !== "snd96";
}
function _isApprovalRide(s) {
  return _isCommunity(s) && s.needs_approval !== false;
}
function _commPublished(s) {
  return _isCommunity(s) && s.hide_queue === false;
}
function _sessionDates(b, clock) {
  try {
    // queue_entries stores the date as plain ISO, so that is the form to read first. The
    // long form ("23 Sep 2026") is still accepted for anything that hands one over. Matching
    // only the long form meant no date ever parsed: every pass was built without a
    // relevantDate and without an expirationDate, so none of them surfaced on the lock screen
    // when the ride came round, and none of them ever went stale.
    const _raw = String(b.session_date || "");
    const _iso = _raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    const md = _iso ? null : _raw.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
    if (!_iso && !md) return null;
    const mo = _iso ? +_iso[2] : _MONTHS[md[2].slice(0, 3).toLowerCase()];
    if (!mo) return null;
    const day = _iso ? +_iso[3] : +md[1], year = _iso ? +_iso[1] : +md[3];
    const p2 = (n) => String(n).padStart(2, "0");
    // Minutes from the start of the session's own day, as a Jeddah timestamp. Counting past 24:00
    // rolls into the next day, so a ride that ends at or after midnight ends the day after.
    const at = (min) => {
      const t = new Date(Date.UTC(year, mo - 1, day) + min * 6e4);
      return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}T${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:00+03:00`;
    };
    const endOfDay = (min) => Math.floor(min / 1440) * 1440 + 23 * 60 + 59;
    const parseT = (s) => {
      const t = s.match(/(\d{1,2})(?::(\d{2}))?\s*([AaPp])/);
      let h = +t[1];
      const min = t[2] ? +t[2] : 0;
      const pm = /p/i.test(t[3]);
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      return h * 60 + min;
    };
    if (clock) {
      return {
        collect: clock.collectMin != null ? at(clock.collectMin) : null,
        start: at(clock.startMin),
        // A ride with no end on its clock (the ones staff approve) runs out at the end of its day.
        end: at(clock.endMin != null ? clock.endMin : endOfDay(clock.startMin))
      };
    }
    const times = String(b.session_time || "").match(/\d{1,2}(?::\d{2})?\s*[AaPp][Mm]/g) || [];
    const startMin = times.length ? parseT(times[0]) : 0;
    let endMin = times.length >= 2 ? parseT(times[times.length - 1]) : endOfDay(startMin);
    if (times.length >= 2 && endMin <= startMin) endMin += 1440; // "9:00 PM - 12:30 AM"
    return { collect: null, start: at(startMin), end: at(endMin) };
  } catch (e) {
    return null;
  }
}
// A booking's add-ons as queue_entries.addons stores them: a JSON list of item ids or {id, qty}.
function _entryAddons(raw) {
  let list;
  try { list = Array.isArray(raw) ? raw : raw ? JSON.parse(raw) : []; } catch (e) { return null; }
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const a of list) {
    const id = a && typeof a === "object" ? a.id : a;
    const qty = a && typeof a === "object" ? Math.max(1, Number(a.qty) || 1) : 1;
    if (id != null && id !== "") out.push({ id: String(id), qty });
  }
  return out;
}
// The party's add-ons, named and priced from the inventory (readable with the anon key, as the app
// reads it): {addons: [{n, q, p}], known}. known is false when they could not all be read.
async function _serverAddons(SUPA, ANON, group) {
  const want = new Map();
  for (const r of group) {
    const list = _entryAddons(r.addons);
    if (!list) return { addons: [], known: false };
    for (const a of list) want.set(a.id, (want.get(a.id) || 0) + a.qty);
  }
  if (!want.size) return { addons: [], known: true };
  try {
    const ids = [...want.keys()].slice(0, 50).map((i) => `"${i.replace(/["\\]/g, "")}"`).join(",");
    const res = await fetch(`${SUPA}/rest/v1/inventory?select=id,name,price&id=in.(${encodeURIComponent(ids)})`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` }
    });
    if (!res.ok) return { addons: [], known: false };
    const rows = await res.json();
    const by = new Map((Array.isArray(rows) ? rows : []).map((x) => [String(x.id), x]));
    const out = [];
    for (const [id, q] of want) {
      const it = by.get(id);
      if (!it) return { addons: [], known: false };
      const price = it.price != null && !Number.isNaN(+it.price) ? +it.price : 0;
      out.push({ n: it.name || id, q, p: Math.round(price * q * 100) / 100 });
    }
    return { addons: _cleanAddons(out), known: true };
  } catch (e) {
    return { addons: [], known: false };
  }
}
function _cleanAddons(a) {
  if (!Array.isArray(a)) return [];
  return a.slice(0, 20).map((x2) => ({
    n: String(x2 && x2.n || "").replace(/\s+/g, " ").trim().slice(0, 60),
    q: Math.max(1, Math.min(99, parseInt(x2 && x2.q, 10) || 1)),
    p: Math.max(0, Math.min(1e5, Math.round((Number(x2 && x2.p) || 0) * 100) / 100))
  })).filter((x2) => x2.n);
}
// What the rider needs to know about when: the moment bikes start going out, and the moment
// the ride leaves. A ride staff approve stores its clock as "gathering - start", so both
// numbers are already there and both are read straight off it. Every other ride stores
// "start - end": the ride leaves at the first, and bikes go out 45 minutes before it, which
// is a quarter past eight for the nine o'clock circuit sessions.
const COLLECT_BEFORE_MIN = 45;
function _sessTimes(sess) {
  const raw = _sessClock(sess);
  const parts = String(raw).split("-").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 1) return null;
  const approval = _gathersTime(sess);
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  let startMin = toMin(approval ? parts[1] || parts[0] : parts[0]);
  if (startMin == null) return null;
  // Staff set the collection time on the session itself. A ride they approve keeps its
  // gathering time as that moment; anything with no time set falls back to three quarters
  // of an hour before the ride leaves.
  // A ride with no bike to hand out and no gathering (the pool, T100, an event) has no such moment at
  // all: the app's ticket shows none (_needsBike), and the pass printed BIKE COLLECTION 45 minutes before a
  // swim.
  const set = toMin(_sessSlot(sess, "_collect"));
  const collectMin = approval ? toMin(parts[0]) : !_needsBike(_rideOf(sess)) ? null : (set != null ? set : Math.max(0, startMin - COLLECT_BEFORE_MIN));
  // Gathering before midnight for a ride that leaves after it: the ride leaves the next day.
  if (approval && collectMin != null && startMin < collectMin) startMin += 1440;
  let endMin = approval ? null : toMin(parts[1] || "");
  // A ride that runs past midnight ("21:00 - 00:30") ends the next day. Read as the same day,
  // its end fell before its start, and the pass expired on the morning of the ride.
  if (endMin != null && endMin <= startMin) endMin += 1440;
  return { collectMin, startMin, endMin };
}
function _sessSlot(sess, key) {
  try {
    const slots = sess && sess.bike_slots ? JSON.parse(sess.bike_slots) : null;
    return (slots && slots[key]) || "";
  } catch (e) { return ""; }
}
function _sessClock(sess) {
  try {
    const slots = sess && sess.bike_slots ? JSON.parse(sess.bike_slots) : null;
    return (slots && slots._time) || "";
  } catch (e) { return ""; }
}
// Does this ride's _time read as "gather, then set off", or as a plain "starts - ends"?
// It used to be inferred from community + needs_approval, which is true of the pool session
// and the T100 prep as well - and those do NOT gather. Their _time is an ordinary start-end
// window, so the pass printed the session's END as the moment the ride leaves, and dropped
// the end time entirely, leaving the pass live for hours after the session was over.
// The app keys this off KIND_TRAITS.gathering; this is the same table.
// The Victory Lap gathers (doors open, then the first heat); the DEFE run does not.
const GATHERS = { saturday: true, snd96: true, runher: true, vlap: true, petromin: false, swim: false, workshop: false, jcc: false, defe5k: false };
// The kinds that hand out no bike (the app's KIND_TRAITS bike:false).
const NO_BIKE = { swim: true, workshop: true, event: true, runher: true, vlap: true, defe5k: true };
// Who a booking is for, by kind: riders only where there is a bike.
function _people(ride) {
  if (ride === "runher" || ride === "defe5k") return { one: "Runner", many: "Runners" };
  if (ride === "vlap") return { one: "Athlete", many: "Athletes" };
  return _needsBike(ride) ? { one: "Rider", many: "Riders" } : { one: "Participant", many: "Participants" };
}
// What the booking is for, where a ride staff approve shows no number.
function _whatLabel(ride) {
  if (_needsBike(ride)) return "RIDE";
  if (ride === "runher" || ride === "defe5k") return "RUN";
  if (ride === "vlap") return "RACE";
  return ride === "event" ? "EVENT" : "SESSION";
}
function _needsBike(ride) {
  return !NO_BIKE[ride];
}
function _gathersTime(sess) {
  // Needing staff approval is NOT what makes a ride gather: the National Day ride gathers
  // and is open to all. The ride kind decides, exactly as KIND_TRAITS does in the app — and
  // the kind alone, because the National Day ride is no longer under the community umbrella.
  return !!sess && GATHERS[_rideOf(sess)] === true;
}
// Each ride is told apart in a crowded Wallet by its own colour, and named by its own words.
// Each pass in its event-picker card's colours (the owner, 2026-10-06: "make sure that the apple pass booking cards
// are themed the same way the event picker card is themed"), with its card's art (pass-images.js RIDE_IMAGES):
// fg the text, label the field labels. MicroMobility Experiences' rides (the Saturday ride, the pool, T100) are
// white with ink and the brand's green (its labels darkened to read on white, 5.4:1); Run for Her white with its
// navy ink and pink (4.9:1); an event white with the violet (7:1); the circuit its navy. Petromin keeps the
// company's own red and National Day its green, as before.
const EXP = { bg: "rgb(255,255,255)", fg: "rgb(26,25,25)", label: "rgb(7,122,75)" };
const RIDES = {
  saturday: { ...EXP, venue: "Saturday Social Ride" },
  // The one ride that does not take the near-black field the others use: a dark maroon read
  // as muddy brown rather than as a colour, and the salmon labels on it looked washed out.
  // Petromin commits to its red instead - the same rgb(163,59,46) the app tints this ride
  // with everywhere else - with a pale warm tint for the labels. Both clear AA against the
  // near-white foreground (5.9:1) and the field (4.9:1); do not darken the label towards
  // salmon again, it drops to 2.7:1.
  petromin: { bg: "rgb(163,59,46)", label: "rgb(255,214,203)", venue: "Petromin Wednesday Ride" },
  // the pool (2026-10-12): its ticket's pool blue on the labels (5.6:1 on white)
  swim:     { ...EXP, label: "rgb(11,111,164)", venue: "Triathlon Pool Session" },
  workshop: { ...EXP, venue: "T100 Triathlon Prep" },
  // Saudi National Day 96 - the guideline's deep green field, with the lime tint on labels.
  snd96:    { bg: "rgb(0,38,40)",  label: "rgb(140,220,70)", venue: "Jeddah Corniche Circuit" },
  runher:   { bg: "rgb(255,255,255)", fg: "rgb(20,48,77)", label: "rgb(194,65,110)", venue: "Run for Her" },
  event:    { bg: "rgb(255,255,255)", fg: "rgb(26,25,25)", label: "rgb(109,40,217)", venue: "MicroMobility Event" },
  // the tickets' own inks (styles.css th-vlap, th-defe5k)
  vlap:     { bg: "rgb(255,255,255)", fg: "rgb(13,13,13)", label: "rgb(91,63,214)", venue: "Victory Lap" },
  defe5k:   { bg: "rgb(255,255,255)", fg: "rgb(59,19,40)", label: "rgb(162,43,99)", venue: "DEFE 5KM Run" },
  // The circuit's own card colours: the navy field it is drawn on, white type, and the pale cyan its
  // meta line uses. Both clear AA.
  jcc:      { bg: "rgb(6,52,111)", fg: "rgb(255,255,255)", label: "rgb(159,213,238)", venue: "Jeddah Corniche Circuit" }
};
function _rideOf(sess) {
  if (!sess) return "jcc";
  // The National Day ride is a circuit night that is still itself: it left the umbrella, so
  // asking the umbrella first answered "jcc" and the pass came out in the circuit's black,
  // printed the gathering time as RIDE STARTS and invented a bike collection 45 minutes
  // before it. Its kind is read first, exactly as _rideKind does in the app.
  if (sess.ride_kind === "snd96") return "snd96";
  if (sess.event_kind !== "community") return "jcc";
  const k = sess.ride_kind;
  return k === "petromin" || k === "swim" || k === "workshop" || k === "runher" || k === "event" || k === "vlap" || k === "defe5k" ? k : "saturday";
}
function _hhmm(min) {
  if (min == null) return "";
  const h24 = Math.floor(min / 60) % 24, m = min % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}
function _bikeLabel(t) {
  const k = String(t || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  const map = {
    road: "Road",
    hybrid: "Hybrid",
    mountain: "Mountain",
    gravel: "Gravel",
    any: "Any",
    roadcarbon: "Road Carbon"
  };
  if (map[k]) return map[k];
  const s = String(t || "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}
// Apple's WWDR intermediate (G4), the second certificate in every pass signature. Fetched once per
// isolate, as DER, from Apple.
let _wwdr = null;
async function getWWDR() {
  if (_wwdr) return _wwdr;
  const res = await fetch("https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer");
  if (!res.ok) throw new Error("WWDR fetch failed");
  _wwdr = new Uint8Array(await res.arrayBuffer());
  return _wwdr;
}
const configured = (env) => !!((env.APPLE_PASS_CERT_PEM && env.APPLE_PASS_KEY_PEM) || env.APPLE_PASS_P12_BASE64);
// The signing key and certificate, opened once per isolate for a given set of credentials (a
// failure is not kept, so a corrected secret takes effect on the next request).
const _signers = new Map();
function getSigner(env) {
  const key = env.APPLE_PASS_CERT_PEM && env.APPLE_PASS_KEY_PEM
    ? `pem:${env.APPLE_PASS_CERT_PEM}\n${env.APPLE_PASS_KEY_PEM}\n${env.APPLE_PASS_KEY_PASSWORD || ""}`
    : `p12:${env.APPLE_PASS_P12_BASE64}\n${env.APPLE_PASS_P12_PASSWORD || ""}`;
  let p = _signers.get(key);
  if (!p) { p = loadSigner(env).catch((e) => { _signers.delete(key); throw e; }); _signers.set(key, p); }
  return p;
}
async function loadSigner(env) {
  if (env.APPLE_PASS_CERT_PEM && env.APPLE_PASS_KEY_PEM) {
    const s = await importSigner(certPemToDer(env.APPLE_PASS_CERT_PEM), await keyPemToPkcs8(env.APPLE_PASS_KEY_PEM, env.APPLE_PASS_KEY_PASSWORD || ""));
    s.source = "pem";
    return s;
  }
  const p12 = await openP12(b64ToBytes(env.APPLE_PASS_P12_BASE64), env.APPLE_PASS_P12_PASSWORD || "");
  const s = await importSigner(p12.cert, p12.keyPkcs8);
  s.source = "p12 (" + p12.how + ")";
  return s;
}
// GET ?selftest: a signature over a fixed manifest, answered as { ok } alone (2026-10-05: the answer
// is public; the certificate that made it is logged instead). At most SELFTEST_PER_MIN a minute per
// isolate: each is an RSA signature, and on a cold start a Keychain .p12 that takes a second to open.
const SELFTEST_MANIFEST = '{"pass.json":"da39a3ee5e6b4b0d3255bfef95601890afd80709"}';
const SELFTEST_PER_MIN = 6;
let _stWindow = 0, _stSpent = 0;
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!new URL(request.url).searchParams.has("selftest")) return json({ ok: false, error: "POST a booking" }, 405);
  if (!configured(env) || !env.APPLE_PASS_TYPE_ID || !env.APPLE_TEAM_ID) return json({ ok: false, skipped: "wallet not configured" }, 501);
  const now = Date.now();
  if (now - _stWindow >= 60000) { _stWindow = now; _stSpent = 0; }
  if (++_stSpent > SELFTEST_PER_MIN) return json({ ok: false, error: "rate limited" }, 429);
  try {
    const signer = await getSigner(env);
    const wwdr = await getWWDR();
    const signature = await signDetached(signer, strBytes(SELFTEST_MANIFEST), [wwdr]);
    if (!signature || !signature.length) throw new Error("empty signature");
    console.log("wallet-pass: selftest signed", JSON.stringify({ source: signer.source, subject: signer.info.subject, issuer: signer.info.issuerName, notAfter: signer.info.notAfter }));
    return json({ ok: true });
  } catch (e) {
    console.error("wallet-pass: selftest failed", (e && e.stack) || e);
    return json({ ok: false, error: "sign failed" }, 500);
  }
}
function strBytes(s) {
  return new TextEncoder().encode(s);
}
function b64Bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i2 = 0; i2 < bin.length; i2++) out[i2] = bin.charCodeAt(i2);
  return out;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
