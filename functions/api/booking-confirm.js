// Sends a booking-confirmation email via Brevo (free tier, 300/day). Activates only
// when BREVO_API_KEY + BREVO_SENDER are set as Cloudflare Pages env vars; until then
// it's a no-op so calling it is always safe.
//
// Abuse-safe: it does NOT trust a client-supplied email. It re-reads the booking
// through the my_bookings RPC using the caller's own customer id + session token, so
// it only ever emails the address stored on a booking the caller actually owns.
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER) {
    return json({ ok: false, skipped: 'not configured' }); // no-op until keys are set
  }
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad body' }, 400); }
  const { customerId, token, bookingId } = body || {};
  if (!customerId || !token || !bookingId) return json({ ok: false, error: 'missing fields' }, 400);

  const SUPA = env.SUPABASE_URL || 'https://qpffkzmsfyilicwcsszz.supabase.co';
  const ANON = env.SUPABASE_ANON_KEY;
  if (!ANON) return json({ ok: false, error: 'no anon key' }, 500);

  // Verify ownership + fetch the real booking via the token-checked RPC.
  const rpc = await fetch(`${SUPA}/rest/v1/rpc/my_bookings`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_id: customerId, p_token: token }),
  });
  if (!rpc.ok) return json({ ok: false, error: 'lookup failed' }, 502);
  const rows = await rpc.json();
  const b = Array.isArray(rows) ? rows.find((r) => r.id === bookingId) : null;
  if (!b || !b.email) return json({ ok: false, error: 'not found' }, 404);

  const when = `${b.session_day || ''} ${b.session_date || ''}`.trim();
  const send = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'MicroMobility', email: env.BREVO_SENDER },
      to: [{ email: b.email, name: b.name || undefined }],
      subject: `Booking confirmed — #${b.queue_num}`,
      htmlContent:
        `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">` +
        `<h2 style="color:#0a7">MicroMobility — booking confirmed 🚲</h2>` +
        `<p>Hi ${escapeHtml(b.name || 'there')}, your bicycle rental is booked.</p>` +
        `<p><b>Booking #${escapeHtml(String(b.queue_num))}</b><br>${escapeHtml(when)}</p>` +
        `<p>See you at the Jeddah Corniche Circuit!</p></div>`,
    }),
  });
  return json({ ok: send.ok });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
