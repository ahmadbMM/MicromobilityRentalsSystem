// Where the browser reports a Content-Security-Policy violation (report-uri / report-to in
// _headers). A violation on this site means a handler or a script the policy does not allow:
// since 2026-09-27 the policy has no 'unsafe-inline' for scripts, so an onclick attribute that
// slipped back in would land here, silently dead on the page otherwise.
//
// Each report is logged (Cloudflare's function logs) and, when DISCORD_WEBHOOK is set, pinged
// the way /api/log-error pings: throttled per sender and per minute, everything truncated and
// neutralised. Both report formats browsers send are read: the older application/csp-report
// object and the Reporting API's application/reports+json list. The answer is always 204.
const PER_SENDER_MS = 30000;
const BUDGET_PER_MIN = 4;
const _lastBySender = new Map();
let _window = 0, _spent = 0;

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch { return new Response(null, { status: 204 }); }
  const reports = Array.isArray(body) ? body.map((r) => (r && r.body) || r) : [(body && body['csp-report']) || body];
  const lines = [];
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
  }
  if (!lines.length) return new Response(null, { status: 204 });
  console.warn('csp-report: ' + lines.join(' | '));

  if (env.DISCORD_WEBHOOK) {
    const now = Date.now();
    const who = request.headers.get('cf-connecting-ip') || 'unknown';
    if (now - (_lastBySender.get(who) || 0) >= PER_SENDER_MS) {
      if (now - _window >= 60000) { _window = now; _spent = 0; }
      if (_spent < BUDGET_PER_MIN) {
        _spent++;
        _lastBySender.set(who, now);
        if (_lastBySender.size > 500) for (const [k, t] of _lastBySender) if (now - t >= PER_SENDER_MS) _lastBySender.delete(k);
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

// Truncated, with the two characters that carry Discord markup neutralised (see log-error.js).
function clean(v, max) {
  return String(v == null ? '' : v).slice(0, max).replace(/`/g, "'").replace(/@/g, '@​');
}
