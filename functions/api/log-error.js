// Forwards a client-side error to a Discord webhook so the operator is alerted
// proactively (errors are always logged to the DB regardless; this is just the ping).
// Activates only when DISCORD_WEBHOOK is set as a Cloudflare Pages env var; until then
// it's a no-op so calling it is always safe.
//
// Best-effort abuse guard: the endpoint is public, so
//   • only the site's own pages are forwarded (a browser always sends Origin on a POST);
//   • the body is read no further than MAX_BODY: the app's own report is well under 1 KB, and a
//     bigger one is refused before any of it is parsed (2026-10-05);
//   • payloads are hard-truncated, and nothing in them can ping anyone or break out of the
//     code blocks: backticks and @ are neutralised, and allowed_mentions turns mentions off;
//   • the same message from the same place is pinged once per SAME_MSG_MS: a loop on one phone,
//     or one bad deploy on every phone, is one alert rather than a stream (2026-10-05);
//   • the throttle is per sender (~1 per minute per IP), not one timestamp for everybody. A single
//     global slot let anyone who posted junk every 30 s swallow every real alert behind it.
//     A small shared budget per minute still caps the channel if many senders pile in;
//   • a report shaped like the app's own (its src one of the app's tags, or a file on this site)
//     may also spend a budget of its own, so junk in any other shape can use up the shared one
//     but never silence a real alert (2026-10-05).
// All per isolate; Discord's own webhook rate-limit (429) is the backstop, and all failures
// are swallowed.
const MAX_BODY = 8 * 1024;
const PER_SENDER_MS = 60000;
const BUDGET_PER_MIN = 3;
const APP_BUDGET_PER_MIN = 3;
const SAME_MSG_MS = 10 * 60000;
const _lastBySender = new Map();
const _lastByMsg = new Map();
let _window = 0, _spent = 0, _appSpent = 0;

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DISCORD_WEBHOOK) return json({ ok: false, skipped: 'not configured' });

  const self = new URL(request.url).origin;
  if (request.headers.get('origin') !== self) return json({ ok: false, skipped: 'foreign origin' }, 403);

  const text = await readCapped(request, MAX_BODY);
  if (text == null) return json({ ok: false, error: 'too big' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'bad body' }, 400); }
  const msg = clean(body && body.msg, 400);
  const src = clean(body && body.src, 200);
  const ua = clean(body && body.ua, 160);
  if (!msg) return json({ ok: false, error: 'no message' }, 400);

  const now = Date.now();
  const sig = msg + '\n' + src;
  if (now - (_lastByMsg.get(sig) || 0) < SAME_MSG_MS) return json({ ok: false, skipped: 'repeat' });
  const who = request.headers.get('cf-connecting-ip') || 'unknown';
  if (now - (_lastBySender.get(who) || 0) < PER_SENDER_MS) return json({ ok: false, skipped: 'throttled' });
  if (now - _window >= 60000) { _window = now; _spent = 0; _appSpent = 0; }
  // The app sends a tag ('auth', 'promise', 'catalog'...), file:line of a script on this site, or ':'.
  const appShaped = /^(?:[a-z][a-z-]{1,23}|:\d*)$/.test(src) || src.startsWith(self + '/');
  if (_spent < BUDGET_PER_MIN) _spent++;
  else if (appShaped && _appSpent < APP_BUDGET_PER_MIN) _appSpent++;
  else return json({ ok: false, skipped: 'throttled' });
  _lastBySender.set(who, now);
  _lastByMsg.set(sig, now);
  prune(_lastBySender, now, PER_SENDER_MS);
  prune(_lastByMsg, now, SAME_MSG_MS);

  const content =
    `🚨 **MicroMobility error**\n\`\`\`\n${msg}\n\`\`\`` +
    (src ? `\n**at:** \`${src}\`` : '') +
    (ua ? `\n**ua:** \`${ua}\`` : '');

  try {
    await fetch(env.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900), username: 'MicroMobility', allowed_mentions: { parse: [] } }),
    });
  } catch { /* swallow — alerting must never break the app */ }
  return json({ ok: true });
}

// Truncated, with the two characters that carry Discord markup neutralised: a backtick could
// close the code block around the text, and @everyone / <@id> would ping the channel. A zero-width
// space after @ keeps an email address readable while breaking any mention.
function clean(v, max) {
  return String(v || '').slice(0, max).replace(/`/g, "'").replace(/@/g, '@​');
}

// The body as text, read no further than max bytes; null when it is bigger (2026-10-05).
async function readCapped(request, max) {
  if (Number(request.headers.get('content-length')) > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

// Senders and messages are kept only while they still throttle anything.
function prune(map, now, ms) {
  if (map.size > 500) for (const [k, t] of map) if (now - t >= ms) map.delete(k);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
