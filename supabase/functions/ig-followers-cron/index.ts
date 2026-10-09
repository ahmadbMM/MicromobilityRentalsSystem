// The hourly Instagram follower pass (pg_cron job mm-ig-followers, migration 20261009210000).
//
// functions/api/ig-followers.js counts riders when a staffer asks (the dialog's Check now, or the
// stale pass Community > Accounts nudges when it opens). This is the same stale pass without a
// staffer: pg_cron posts here every hour, and the counts stay fresh when nobody opens Accounts.
// The rules (who is due, the lookup, what a miss keeps) are copied from that file; change both.
//
// Deployed with verify_jwt off and its own check instead: the caller must send x-cron-secret, the
// vault secret ig_cron_secret, which only pg_cron reads (ig_cron_secret_ok() compares it). It
// writes with the project's service key, which the Edge runtime provides; Cloudflare never has one.
//
// Dormant until the Edge Function secrets IG_GRAPH_TOKEN and IG_USER_ID are set (the same values
// as the Cloudflare env vars; optional IG_GRAPH_VERSION, default v23.0).

const BATCH = 25;               // Instagram allows roughly 200 lookups an hour per token
const STALE_GAP_MIN = 20;       // a pass (this one or a staff device's) ran this recently: skip
const OK_DAYS = 7;
const MISS_DAYS = 30;
const ERROR_HOURS = 6;
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

const SUPA = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H: Record<string, string> = { apikey: KEY, 'Content-Type': 'application/json' };
if (KEY.startsWith('eyJ')) H.Authorization = `Bearer ${KEY}`; // a legacy JWT key; an sb_secret_ key goes in apikey only

type Row = { customer_id: string; handle: string; followers: number | null; source: string | null; counted_at: string | null; status: string; tried_at: string | null; updated_by: string | null };

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers as Record<string, string> || {}) } });

Deno.serve(async (req) => {
  const secret = req.headers.get('x-cron-secret') || '';
  const ok = secret && await rest('rpc/ig_cron_secret_ok', { method: 'POST', body: JSON.stringify({ p: secret }) })
    .then((r) => (r.ok ? r.json() : false)).catch(() => false);
  if (ok !== true) return json({ ok: false, error: 'forbidden' }, 403);

  const TOKEN = Deno.env.get('IG_GRAPH_TOKEN'), IGID = Deno.env.get('IG_USER_ID');
  if (!TOKEN || !IGID) return json({ ok: false, skipped: 'not configured' });

  // pg_net gives up waiting after a few seconds; the pass goes on after the answer.
  const pass = run(TOKEN, IGID).then((r) => console.log('ig-followers-cron', JSON.stringify(r)))
    .catch((e) => console.warn('ig-followers-cron failed', String(e?.message || e)));
  const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (rt?.waitUntil) { rt.waitUntil(pass); return json({ ok: true, started: true }, 202); }
  await pass;
  return json({ ok: true });
});

async function run(token: string, igId: string) {
  const last = await rest('customer_ig_followers?select=tried_at&tried_at=not.is.null&order=tried_at.desc&limit=1');
  const lr = last.ok ? await last.json() : [];
  if (lr[0] && Date.now() - Date.parse(lr[0].tried_at) < STALE_GAP_MIN * 60e3) return { checked: 0, reason: 'recent' };

  const [custs, rows] = await Promise.all([
    pagedAll('customers?select=id,socials&socials->>instagram=not.is.null&order=id'),
    pagedAll('customer_ig_followers?select=*&order=customer_id'),
  ]);
  if (!custs || !rows) return { checked: 0, error: 'lookup failed' };
  const byId = new Map((rows as Row[]).map((r) => [r.customer_id, r]));
  const now = Date.now();
  const wait = (r: Row) => (r.status === 'ok' ? OK_DAYS * 864e5 : r.status === 'unavailable' ? MISS_DAYS * 864e5 : ERROR_HOURS * 36e5);
  const when = (r?: Row) => (r && r.tried_at ? Date.parse(r.tried_at) : 0);
  const due = (custs as { id: string; socials: unknown }[])
    .map((c) => ({ id: c.id, handle: handleOf(c.socials), row: byId.get(c.id) }))
    .filter((x) => x.handle && (!x.row || x.row.handle !== x.handle || !x.row.tried_at || now - Date.parse(x.row.tried_at) > wait(x.row)))
    .sort((a, b) => when(a.row) - when(b.row))
    .slice(0, BATCH);

  let checked = 0, stopped: string | null = null;
  for (const x of due) {
    const got = await lookup(token, igId, x.handle);
    if ('stop' in got) { stopped = got.stop; break; }
    const at = new Date().toISOString();
    const same = x.row && x.row.handle === x.handle;
    const row: Row = got.ok
      ? { customer_id: x.id, handle: x.handle, followers: got.followers, source: 'auto', counted_at: at, status: 'ok', tried_at: at, updated_by: 'Instagram' }
      : same
        ? { ...x.row!, status: got.status, tried_at: at }
        : { customer_id: x.id, handle: x.handle, followers: null, source: null, counted_at: null, status: got.status, tried_at: at, updated_by: null };
    const w = await rest('customer_ig_followers?on_conflict=customer_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row),
    });
    if (w.ok) checked++;
  }
  return { checked, due: due.length, ...(stopped ? { stopped } : {}) };
}

function handleOf(s: unknown): string {
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
  const h = String((s && (s as Record<string, unknown>).instagram) || '').trim().replace(/^@+/, '');
  return HANDLE.test(h) ? h : '';
}

type Got = { ok: true; followers: number } | { ok: false; status: 'unavailable' | 'error' } | { stop: 'rate' | 'token' };

async function lookup(token: string, igId: string, handle: string): Promise<Got> {
  const ver = Deno.env.get('IG_GRAPH_VERSION') || 'v23.0';
  const fields = `business_discovery.username(${handle}){followers_count,username}`;
  let res: Response, data;
  try {
    res = await fetch(`https://graph.facebook.com/${ver}/${encodeURIComponent(igId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`);
    data = await res.json();
  } catch { return { ok: false, status: 'error' }; }
  const n = data?.business_discovery?.followers_count;
  if (res.ok && Number.isInteger(n)) return { ok: true, followers: n };
  const e = data?.error || {};
  if ([4, 17, 32, 613].includes(e.code)) return { stop: 'rate' };
  if (e.code === 190 || e.code === 10 || e.code === 200) return { stop: 'token' };
  if (e.code === 110 || e.code === 100 || e.error_subcode === 2207013) return { ok: false, status: 'unavailable' };
  return { ok: false, status: 'error' };
}

async function pagedAll(path: string) {
  const out: unknown[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await rest(path, { headers: { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
    if (!r.ok) return null;
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
