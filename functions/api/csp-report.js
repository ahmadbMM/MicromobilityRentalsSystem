// Where the browser reports a Content-Security-Policy violation (report-uri / report-to in
// _headers). A violation on this site means a handler or a script the policy does not allow:
// since 2026-09-27 the policy has no 'unsafe-inline' for scripts, so an onclick attribute that
// slipped back in would land here, silently dead on the page otherwise.
//
// Each report is logged (Cloudflare's function logs) and, when DISCORD_WEBHOOK is set, pinged
// the way /api/log-error pings: throttled per sender and per minute, everything truncated and
// neutralised. Both report formats browsers send are read: the older application/csp-report
// object and the Reporting API's application/reports+json list. The answer is always 204.
//
// Since 2026-10-05 it hears only the site's own pages (a browser sends Sec-Fetch-Site: same-origin,
// or an Origin, with a report to the page's own host); it reads a body no further than MAX_BODY (the
// Reporting API sends several reports in one body, each carrying the whole policy, about 1.3 KB, and
// only the first five are read); the same violation (directive, what was blocked, where, the sample;
// not the page it was on) is pinged once per SAME_MS; and its budget is smaller than log-error's:
// both ping the same webhook, which Discord rate-limits as one, so a burst of CSP reports gives way
// to a real error alert.
const MAX_BODY = 64 * 1024;
const PER_SENDER_MS = 60000;
const BUDGET_PER_MIN = 2;
const SAME_MS = 10 * 60000;
const _lastBySender = new Map();
const _lastBySig = new Map();
let _window = 0, _spent = 0;

export async function onRequestPost(context) {
  const { request, env } = context;
  const self = new URL(request.url).origin;
  if (!(request.headers.get('sec-fetch-site') === 'same-origin' || request.headers.get('origin') === self)) return new Response(null, { status: 204 });
  const text = await readCapped(request, MAX_BODY);
  if (text == null) { console.warn(`csp-report: a body over ${MAX_BODY} bytes, not read`); return new Response(null, { status: 204 }); }
  let body;
  try { body = JSON.parse(text); } catch { return new Response(null, { status: 204 }); }
  const reports = Array.isArray(body) ? body.map((r) => (r && r.body) || r) : [(body && body['csp-report']) || body];
  const lines = [], sigs = [];
  for (const r of reports.slice(0, 5)) {
    if (!r || typeof r !== 'object') continue;
    const get = (...keys) => { for (const k of keys) if (r[k] != null && r[k] !== '') return clean(r[k], 200); return ''; };
    const directive = get('effectiveDirective', 'effective-directive', 'violatedDirective', 'violated-directive');
    const blocked = get('blockedURL', 'blocked-uri');
    const at = get('sourceFile', 'source-file');
    const line = get('lineNumber', 'line-number');
    const sample = get('sample', 'script-sample');
    const page = get('documentURL', 'document-uri');
    if (!directive && !blocked) continue;
    if (/^(chrome|moz|safari(-web)?)-extension:/.test(at) || /^(chrome|moz|safari(-web)?)-extension:/.test(blocked)) continue; // a browser extension's own injection, not the page's
    if (/connect\.facebook\.net\//.test(blocked) || /^iabjs/.test(at)) continue; // Instagram's / Facebook's in-app browser injecting Meta's scripts, not the page's
    lines.push(`${directive || '?'} blocked ${blocked || '(inline)'}${at ? ` at ${at}:${line}` : ''}${sample ? ` sample: ${sample}` : ''}${page ? ` on ${page}` : ''}`);
    sigs.push(`${directive}|${blocked}|${at}|${sample}`);
  }
  if (!lines.length) return new Response(null, { status: 204 });
  console.warn('csp-report: ' + lines.join(' | '));

  if (env.DISCORD_WEBHOOK) {
    const now = Date.now();
    const who = request.headers.get('cf-connecting-ip') || 'unknown';
    const sig = sigs.join('\n');
    if (now - (_lastBySig.get(sig) || 0) >= SAME_MS && now - (_lastBySender.get(who) || 0) >= PER_SENDER_MS) {
      if (now - _window >= 60000) { _window = now; _spent = 0; }
      if (_spent < BUDGET_PER_MIN) {
        _spent++;
        _lastBySender.set(who, now);
        _lastBySig.set(sig, now);
        for (const [m, ms] of [[_lastBySender, PER_SENDER_MS], [_lastBySig, SAME_MS]]) if (m.size > 500) for (const [k, t] of m) if (now - t >= ms) m.delete(k);
        const content = `🛡️ **MicroMobility CSP violation**\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n**ua:** \`${clean(request.headers.get('user-agent'), 160)}\``;
        try {
          await fetch(env.DISCORD_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content.slice(0, 1900), username: 'MicroMobility', allowed_mentions: { parse: [] } }),
          });
        } catch { /* reporting must never fail the page */ }
      }
    }
  }
  return new Response(null, { status: 204 });
}

// The body as text, read no further than max bytes; null when it is bigger (as in log-error.js).
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

// Truncated, with the two characters that carry Discord markup neutralised (see log-error.js).
function clean(v, max) {
  return String(v == null ? '' : v).slice(0, max).replace(/`/g, "'").replace(/@/g, '@​');
}
