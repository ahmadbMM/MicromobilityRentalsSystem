// Counts a rider's Instagram followers for staff (customer_ig_followers, migration 20261003220000).
//
// Instagram only tells one business account about another through the Graph API's Business
// Discovery: our own @micromobilitysa (a Business account linked to a Facebook Page) looks a handle
// up and gets its followers_count. It answers for Business and Creator accounts only; a personal
// or unknown handle comes back as an error, which is stored as status 'unavailable' (staff may
// type the number by hand for those, and that number is kept).
//
// Activates only when IG_GRAPH_TOKEN (a long-lived token with instagram_basic +
// instagram_manage_insights + pages_read_engagement) and IG_USER_ID (our Instagram business
// account's id) are set as Cloudflare Pages env vars; until then it answers { skipped } and the app
// shows only typed numbers - the same dormant-until-configured pattern as push-send.js.
//
// Staff-only: every call carries a staff Supabase access token, checked with is_staff(), and every
// read and write goes through PostgREST with THAT token, so RLS decides exactly as it does for the
// staff app. No service key.
//
// Body: { staffToken, customerIds: [id, ...] }  - count these accounts now (at most 10)
//       { staffToken, stale: true }              - count up to BATCH accounts that are due
// A stale pass counts whoever is due: a staff device asks for one when Community > Accounts opens
// (at most every few hours), and the server refuses a second pass within STALE_GAP_MIN of the last
// one, however many devices ask. The same pass also runs every hour without a staffer, from the
// Edge Function supabase/functions/ig-followers-cron (pg_cron, 20261009210000); change both.

// Cloudflare's free plan allows 50 subrequests per call, and every fetch here is one: four reads (the
// staff check, the last pass, the riders, their rows), then a lookup and a save per account. A batch of
// 25 made 54, and the call died with nothing saved (2026-10-05): 4 + 2 x 22 = 48 leaves room. A read
// that pages past 1000 rows costs one more, so the loop also stops at SUBREQ_MAX and leaves the rest
// for the next pass.
const BATCH = 22;               // Instagram allows roughly 200 lookups an hour per token
const SUBREQ_MAX = 48;
const STALE_GAP_MIN = 20;
const OK_DAYS = 7;              // a counted account is counted again after a week
const MISS_DAYS = 30;           // a personal/unknown one is tried again after a month
const ERROR_HOURS = 6;          // a lookup that failed (network, an outage, an error we do not know) soon
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

export async function onRequestPost(context) {
  const { request, env } = context;
  const TOKEN = env.IG_GRAPH_TOKEN, IGID = env.IG_USER_ID;
  if (!TOKEN || !IGID) return json({ ok: false, skipped: 'not configured' });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad body' }, 400); }
  const { staffToken, customerIds, stale } = body || {};
  if (!staffToken || (!stale && !Array.isArray(customerIds))) return json({ ok: false, error: 'missing fields' }, 400);

  const SUPA = env.SUPABASE_URL || 'https://qpffkzmsfyilicwcsszz.supabase.co';
  const ANON = env.SUPABASE_ANON_KEY;
  if (!ANON) return json({ ok: false, error: 'no anon key' }, 500);
  const H = { apikey: ANON, Authorization: `Bearer ${staffToken}`, 'Content-Type': 'application/json' };
  let sub = 0; // the subrequests this call has made (see SUBREQ_MAX)
  const call = (url, init) => { sub++; return fetch(url, init); };

  const who = await call(`${SUPA}/rest/v1/rpc/is_staff`, { method: 'POST', headers: H, body: '{}' });
  if (!who.ok || (await who.json()) !== true) return json({ ok: false, error: 'not staff' }, 403);

  const rest = (path, init) => call(`${SUPA}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init && init.headers) } });

  // Who to count: [{ id, handle, row }] where row is the account's current customer_ig_followers row.
  let due;
  if (stale) {
    const last = await rest('customer_ig_followers?select=tried_at&tried_at=not.is.null&order=tried_at.desc&limit=1');
    const lr = last.ok ? await last.json() : [];
    if (lr[0] && Date.now() - Date.parse(lr[0].tried_at) < STALE_GAP_MIN * 60e3) return json({ ok: true, checked: 0, reason: 'recent' });
    const [custs, rows] = await Promise.all([
      pagedAll(rest, 'customers?select=id,socials&socials->>instagram=not.is.null&order=id'),
      pagedAll(rest, 'customer_ig_followers?select=*&order=customer_id'),
    ]);
    if (!custs || !rows) return json({ ok: false, error: 'lookup failed' }, 502);
    const byId = new Map(rows.map((r) => [r.customer_id, r]));
    const now = Date.now();
    // Only an account Instagram said it will not describe waits the month: a failed lookup says
    // nothing about the account, and parking it for 30 days left counted riders uncounted for weeks.
    const wait = (r) => (r.status === 'ok' ? OK_DAYS * 864e5 : r.status === 'unavailable' ? MISS_DAYS * 864e5 : ERROR_HOURS * 36e5);
    due = custs.map((c) => ({ id: c.id, handle: handleOf(c), row: byId.get(c.id) }))
      .filter((x) => x.handle && (!x.row || x.row.handle !== x.handle || !x.row.tried_at || now - Date.parse(x.row.tried_at) > wait(x.row)))
      // never tried first, then the longest ago
      .sort((a, b) => (a.row && a.row.tried_at ? Date.parse(a.row.tried_at) : 0) - (b.row && b.row.tried_at ? Date.parse(b.row.tried_at) : 0))
      .slice(0, BATCH);
  } else {
    const ids = [...new Set(customerIds.map(String))].slice(0, 10);
    if (!ids.length) return json({ ok: true, checked: 0, results: [] });
    const list = ids.map((i) => `"${i.replace(/["\\]/g, '')}"`).join(',');
    const [cr, rr] = await Promise.all([
      rest(`customers?select=id,socials&id=in.(${encodeURIComponent(list)})`),
      rest(`customer_ig_followers?select=*&customer_id=in.(${encodeURIComponent(list)})`),
    ]);
    if (!cr.ok || !rr.ok) return json({ ok: false, error: 'lookup failed' }, 502);
    const rows = await rr.json();
    const byId = new Map(rows.map((r) => [r.customer_id, r]));
    due = (await cr.json()).map((c) => ({ id: c.id, handle: handleOf(c), row: byId.get(c.id) })).filter((x) => x.handle);
  }

  const results = [];
  let stop = null;
  for (const x of due) {
    if (sub + 2 > SUBREQ_MAX) break; // no room for this account's lookup and save: it waits for the next pass
    // A subrequest that throws (the network, or Cloudflare refusing one more) ends the pass with what
    // was counted so far, instead of a 500 that threw those counts away too (2026-10-05).
    try {
      const got = await lookup(env, TOKEN, IGID, x.handle, call);
      if (got.stop) { stop = got.stop; break; } // rate limit or a dead token: the rest wait for next time
      const at = new Date().toISOString();
      const same = x.row && x.row.handle === x.handle;
      // A count replaces whatever was there. A miss keeps a number staff typed for the same handle,
      // and clears a number that belonged to the rider's old handle.
      const row = got.ok
        ? { customer_id: x.id, handle: x.handle, followers: got.followers, source: 'auto', counted_at: at, status: 'ok', tried_at: at, updated_by: 'Instagram' }
        : same
          ? { customer_id: x.id, handle: x.handle, followers: x.row.followers, source: x.row.source, counted_at: x.row.counted_at, status: got.status, tried_at: at, updated_by: x.row.updated_by }
          : { customer_id: x.id, handle: x.handle, followers: null, source: null, counted_at: null, status: got.status, tried_at: at, updated_by: null };
      const w = await rest('customer_ig_followers?on_conflict=customer_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row),
      });
      const saved = w.ok ? (await w.json())[0] : null;
      results.push(saved || { ...row, error: 'save failed' });
    } catch (e) {
      console.warn('ig-followers: pass cut short', String((e && e.message) || e));
      stop = 'error';
      break;
    }
  }
  // 'error' also sets error, so the staff dialog's single check says the connection failed.
  return json({ ok: !stop, checked: results.length, results, ...(stop ? { stopped: stop } : {}), ...(stop === 'error' ? { error: 'interrupted' } : {}) });
}

function handleOf(c) {
  let s = c && c.socials;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
  const h = String((s && s.instagram) || '').trim().replace(/^@+/, '');
  return HANDLE.test(h) ? h : '';
}

// One Business Discovery lookup. { ok, followers } | { ok:false, status } | { stop: 'rate'|'token'|'error' }
// `call` is the caller's counted fetch (SUBREQ_MAX).
async function lookup(env, token, igId, handle, call = fetch) {
  const ver = env.IG_GRAPH_VERSION || 'v23.0';
  const fields = `business_discovery.username(${handle}){followers_count,username}`;
  let res, data;
  try {
    res = await call(`https://graph.facebook.com/${ver}/${encodeURIComponent(igId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`);
    data = await res.json();
  } catch { return { ok: false, status: 'error' }; }
  const n = data && data.business_discovery && data.business_discovery.followers_count;
  if (res.ok && Number.isInteger(n)) return { ok: true, followers: n };
  const e = (data && data.error) || {};
  if ([4, 17, 32, 613].includes(e.code)) return { stop: 'rate' };
  if (e.code === 190 || e.code === 10 || e.code === 200) return { stop: 'token' };
  // 110 / 100 with subcode 2207013: no such account, or a personal one Instagram will not describe
  if (e.code === 110 || e.code === 100 || e.error_subcode === 2207013) return { ok: false, status: 'unavailable' };
  return { ok: false, status: 'error' };
}

// Every row of a PostgREST read, 1000 at a time (the API's row cap).
async function pagedAll(rest, path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await rest(path, { headers: { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
    if (!r.ok) return null;
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
