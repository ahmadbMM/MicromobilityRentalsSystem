// A booking's calendar file, served (2026-11-10, the Bookings page research). An iPhone or iPad opens a real
// text/calendar answer with Add to Calendar; a file built inside the page did nothing in a Home Screen web app.
//
// The booking app posts a form (downloadBookingICS in app.src.html): the rider's id and session token, the booking,
// and the event's words in the rider's language. The words come from the page because the page is what speaks ten
// languages; what makes them safe to serve from this address is the check below: the token must be the rider's and
// the booking theirs and still standing (my_bookings), and its day must be the event's day. Nobody can have this
// address hand out text they wrote unless they are signed in as the rider it is about.
//
// The event's UID is the booking's, so adding it again changes the event a calendar already holds instead of
// copying it, and SEQUENCE grows with each export. _icsBody in app.src.html writes the same lines for the file the
// page saves itself: keep the two in step.

const LIVE = new Set(['waiting', 'waitlist', 'active']);
const STAMP = /^\d{8}T\d{6}Z$/;

export async function onRequestPost(context) {
  const { request, env } = context;
  let form;
  try { form = await request.formData(); } catch { return text('Bad request', 400); }
  const f = (k, max) => String(form.get(k) || '').slice(0, max);
  const c = f('c', 64), k = f('k', 256), b = f('b', 64);
  const st = f('st', 16), en = f('en', 16);
  if (!c || !k || !/^[\w-]{1,64}$/.test(b) || !STAMP.test(st) || !STAMP.test(en) || en <= st) return text('Bad request', 400);

  const SUPA = env.SUPABASE_URL || 'https://qpffkzmsfyilicwcsszz.supabase.co';
  const ANON = env.SUPABASE_ANON_KEY;
  if (!ANON) return text('Not configured', 501);
  let rows;
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/my_bookings`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: c, p_token: k }),
    });
    if (!r.ok) return text('Lookup failed', 502);
    rows = await r.json();
  } catch { return text('Lookup failed', 502); }
  const row = Array.isArray(rows) ? rows.find((x) => x && x.id === b) : null;
  if (!row || !LIVE.has(row.status)) return text('This booking is not on your account.', 404);
  // The event starts on the booking's day in Jeddah (UTC+3, no clock changes): a start written in UTC can be the
  // evening before, and a night past midnight ends the next day.
  const day = String(row.session_date || row.session_id || '').slice(0, 10);
  const startMs = Date.UTC(+st.slice(0, 4), +st.slice(4, 6) - 1, +st.slice(6, 8), +st.slice(9, 11), +st.slice(11, 13)) + 3 * 36e5;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(startMs).toISOString().slice(0, 10) !== day) return text('Bad request', 400);

  const origin = new URL(request.url).origin;
  const body = icsBody({
    uid: `booking-${b}@micromobility.sa`, st, en,
    ti: f('ti', 200) || 'MicroMobility', lo: f('lo', 300), de: f('de', 600), al: f('al', 200),
    url: `${origin}/my-bookings`,
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `inline; filename="micromobility-${day.replace(/-/g, '')}.ics"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function icsBody(ev) {
  // RFC 5545 text: backslash, comma and semicolon escaped, a new line written as \n; no control characters.
  const esc = (s) => [...String(s).replace(/\r\n?/g, '\n')].filter((ch) => { const c = ch.charCodeAt(0); return c === 10 || (c >= 32 && c !== 127); }).join('')
    .replace(/[\\,;]/g, (x) => '\\' + x).replace(/\n/g, '\\n');
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MicroMobility//Bookings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${ev.uid}`, `SEQUENCE:${Math.floor(Date.now() / 1000)}`, `DTSTAMP:${now}`,
    `DTSTART:${ev.st}`, `DTEND:${ev.en}`,
    `SUMMARY:${esc(ev.ti)}`,
    ...(ev.lo ? [`LOCATION:${esc(ev.lo)}`] : []),
    `DESCRIPTION:${esc(ev.de)}`,
    `URL:${ev.url}`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${esc(ev.al || ev.ti)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

function text(msg, status) {
  return new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
