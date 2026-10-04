import type { Page, WebSocketRoute } from '@playwright/test';

// Table rows are arrays; 'rpc:<name>' is the RPC's return; 'auth:token' is a
// Supabase Auth session object — so values are broader than arrays.
export type Fixtures = Record<string, unknown>;

/** A write failure the stub should inject, so specs can reach the error branches.
 *  `table` limits it to one table (default: every write); `methods` to POST/PATCH/DELETE.
 *  `once` fails the first matching write only, which is how you test a retry succeeding. */
export type FailWrite = {
  table?: string;
  methods?: string[];
  once?: boolean;
  status?: number;
  code?: string;
  message?: string;
};

/** RPCs a spec must opt into: see the stub's answer for them below. */
const NOT_YET_IN_DB = new Set(['customer_set_height', 'customer_set_birth_nat',
  // The staff guardrails of 20260928200000: the page takes the plain writes when these are absent,
  // which is what most specs exercise; tests/staff-guardrails.spec.ts stubs them by name.
  'staff_pin_approve', 'staff_void_receipt', 'staff_refund_receipt', 'staff_set_price', 'staff_delete_session', 'staff_delete_bike',
  // The undo codes of 20260928234500: without them an admin's undo goes through as it used to;
  // tests/undo-codes.spec.ts stubs them by name.
  'staff_undo_code_state', 'staff_set_undo_code', 'staff_check_undo_code',
  // One number on several accounts (20260930180000): without it the account editor refuses a
  // number another account has, as it used to; tests/shared-phone.spec.ts stubs it by name.
  'staff_phone_accounts']);

// Intercepts every request to *.supabase.co so tests never touch the real
// database. GETs return the fixture rows for the table (default: empty),
// writes are echoed back as if they succeeded. RPCs answer with the fixture
// under 'rpc:<name>'; Auth password sign-in answers with 'auth:token'.
export async function stubSupabase(page: Page, fixtures: Fixtures = {}, failWrite?: FailWrite) {
  const ciDone = new Map<string, Record<string, unknown>>(); // bookings staff_checkin checked in, by id
  let failsLeft = failWrite ? (failWrite.once ? 1 : Infinity) : 0;
  // SECURE_AUTH defaults ON in production; pin open mode for the stubbed suite
  // unless a spec explicitly opts into secure mode after this (secureOn sets '1').
  await page.addInitScript(() => localStorage.setItem('cq_secure_auth', '0'));
  // Disable the boot's background "widen" refresh so it can't overwrite state a test sets.
  await page.addInitScript(() => { (window as unknown as { __noWiden?: boolean }).__noWiden = true; });
  // The staff half's sections (staff-parts/) load with it, so a spec may call their functions at once;
  // tests/staff-parts.spec.ts covers the way they arrive on a real device (after the first paint).
  await page.addInitScript(() => { (window as unknown as { __staffPartsNow?: boolean }).__staffPartsNow = true; });
  // Nothing in the app should FETCH these: wa.me and maps links are places a person is sent,
  // not resources a page loads. Chromium preconnects to them anyway when it renders the
  // links, and wa.me answers 429 once a machine has run the suite enough times in a day —
  // which the console-error specs then report as an app failure. Cut them off so a run says
  // something about this code and nothing about the network it happens to be on.
  // Answered, not aborted: an abort surfaces as net::ERR_FAILED, which the console-error
  // specs report just as loudly as the 429 this is here to prevent.
  // api.open-meteo.com too: the weather chip really does fetch it, and a run that reaches the
  // internet fails the console-error specs the moment that host is slow, down or rate-limited.
  // An empty forecast is a shape the chip already handles (it renders nothing). A spec that
  // wants a REAL forecast registers its own route AFTER this call, and Playwright consults
  // the most recently registered handler first, so that one wins.
  await page.route(/api\.open-meteo\.com/, (r) => r.fulfill({
    status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ daily: { time: [], temperature_2m_max: [] } }),
  }));
  await page.route(/(^|\.)wa\.me\/|cloudflareinsights\.com|maps\.app\.goo\.gl/,
    (r) => r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' }));
  await stubRealtime(page);
  // The staff page's Website editor reads micromobility.sa/api/site-schema. The suite never
  // depends on the live site: it answers 404 here, and a spec that needs the schema registers
  // its own route after this call (Playwright consults the newest route first).
  await page.route(/^https:\/\/micromobility\.sa\//, (r) => r.fulfill({ status: 404, body: '' }));
  await page.route('**://*.supabase.co/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();

    if (method === 'OPTIONS') {
      return route.fulfill({ status: 200, headers: cors() });
    }

    const rpc = url.pathname.match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (rpc) {
      let body = (fixtures as Record<string, unknown>)[`rpc:${rpc[1]}`];
      // Functions that migration 20260922150000 adds. A spec that does not provide one gets
      // the answer a database without it gives (PGRST202), so every other spec runs the
      // client's fallback, which is also what production runs until the migration is applied.
      // A spec that covers the new path stubs `rpc:<name>` itself.
      if (body === undefined && NOT_YET_IN_DB.has(rpc[1])) {
        body = { __rpcError: { status: 404, code: 'PGRST202', message: `Could not find the function public.${rpc[1]} in the schema cache` } };
      }
      // An `rpc:<name>` fixture of { __rpcError: {...} } answers with a PostgREST error
      // instead of rows. Needed to cover the two branches a client has to tell apart: a
      // function that is missing (fall back) and one that refused (surface it). `details`
      // is Postgres's DETAIL, where a refusal can carry its code.
      if (body && typeof body === 'object' && '__rpcError' in (body as Record<string, unknown>)) {
        const e = (body as { __rpcError: Record<string, unknown> }).__rpcError;
        return route.fulfill({
          status: Number(e.status) || 404,
          headers: { ...cors(), 'content-type': 'application/json' },
          body: JSON.stringify({ code: e.code, message: e.message, details: e.details ?? null, hint: e.hint ?? null }),
        });
      }
      // list_sessions is how customers read sessions since tag-gated events: the real RPC
      // returns the sessions table (public rows + tagged ones), so default it to the
      // sessions fixture unless a spec overrides it explicitly.
      if (body === undefined && rpc[1] === 'list_sessions') body = fixtures['sessions'] || [];
      // The desk's one-call functions (production since 2026-09; the page no longer carries the
      // multi-write fallbacks, 2026-10-04): answered as the server would, from the fixtures.
      // staff_checkin with no bike claims the booking's reserved bike(s) when every one is
      // available in the fixture (a bike the fixture lacks counts as available), else drops them.
      if (body === undefined && rpc[1] === 'staff_checkin') {
        let sent: { p_booking_id?: string; p_bike_id?: string | null; p_paid?: boolean | null; p_price?: number | null; p_pay_method?: string | null } = {};
        try { sent = req.postDataJSON(); } catch { /* no body */ }
        // The real function checks the booking in, so a later read of the row says so (2026-10-04: a
        // read after the one-call check-in got the fixture's 'waiting' back and the desk re-offered the rider).
        // Kept per stub (ciDone), never written into the spec's fixtures: those objects are shared by
        // the tests of a file, and a rider checked in by one test must not arrive checked in at the next.
        const ciRow = ((fixtures['queue_entries'] || []) as Record<string, unknown>[]).find((r) => r.id === sent.p_booking_id);
        const ciNow = { ...(ciRow || {}), ...(ciDone.get(String(sent.p_booking_id)) || {}) };
        if (ciRow && (ciNow.status === 'waiting' || ciNow.status === 'waitlist')) {
          const patch: Record<string, unknown> = { status: 'active', checked_in_at: new Date().toISOString() };
          if (sent.p_bike_id) patch.assigned_bike_id = sent.p_bike_id;
          if (sent.p_paid != null) patch.paid = sent.p_paid;
          if (sent.p_price != null) patch.price = sent.p_price;
          if (sent.p_pay_method != null) patch.pay_method = sent.p_pay_method || null;
          ciDone.set(String(sent.p_booking_id), patch);
        }
        if (sent.p_bike_id) body = { ok: true, noop: false, assignment_id: 'a-stub', bikes: [sent.p_bike_id], reservation_dropped: false };
        else {
          const row = ((fixtures['queue_entries'] || []) as Record<string, unknown>[]).find((r) => r.id === sent.p_booking_id) || {};
          const raw = String(row.assigned_bike_id || '').trim();
          let ids: string[] = [];
          if (raw.startsWith('[')) { try { ids = (JSON.parse(raw) as unknown[]).map(String); } catch { ids = [raw]; } } else if (raw) ids = [raw];
          const bikes = (fixtures['bikes'] || []) as Record<string, unknown>[];
          const ok = ids.every((id) => { const b = bikes.find((x) => x.id === id); return !b || b.status === 'available'; });
          body = { ok: true, noop: false, assignment_id: ids.length && ok ? 'a-stub' : null, bikes: ok ? ids : [], reservation_dropped: !ok };
        }
      }
      if (body === undefined && rpc[1] === 'staff_return') body = { ok: true, noop: false, bikes_freed: 1 };
      if (body === undefined && rpc[1] === 'staff_swap_bike') body = { ok: true, noop: false, assignment_id: 'a-stub' };
      if (body === undefined && rpc[1] === 'staff_purge_session') body = { ok: true, purged: true };
      if (body === undefined && rpc[1] === 'staff_delete_customer') body = { ok: true, bookings: 0, sales: 0, tags: 0, push_subscriptions: 0, flags: 0, rider_links: 0 };
      // Customer bookings go through customer_create_booking, which returns one row per
      // rider. Left to the generic `[]` default it would read as a refusal and every spec
      // that books through the UI would fail, so echo the rows back the way the real
      // function does. A spec that cares about the server overriding the client's guess
      // stubs `rpc:customer_create_booking` explicitly.
      if (body === undefined && rpc[1] === 'customer_create_booking') {
        let sent: { p_entries?: Record<string, unknown>[] } = {};
        try { sent = req.postDataJSON(); } catch { /* no body */ }
        body = (sent?.p_entries ?? []).map((r) => ({
          id: r.id, queue_num: r.queue_num, status: r.status,
          waitlist_num: r.waitlist_num ?? null, price: r.price,
        }));
      }
      return route.fulfill({
        status: 200,
        headers: { ...cors(), 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? [] : body),
      });
    }

    if (url.pathname.includes('/auth/v1/token')) {
      const session = (fixtures as Record<string, unknown>)['auth:token'];
      return session
        ? route.fulfill({ status: 200, headers: { ...cors(), 'content-type': 'application/json' }, body: JSON.stringify(session) })
        : route.fulfill({ status: 400, headers: { ...cors(), 'content-type': 'application/json' }, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }) });
    }
    if (url.pathname.includes('/auth/v1/')) {
      return route.fulfill({ status: 200, headers: { ...cors(), 'content-type': 'application/json' }, body: '{}' });
    }

    const m = url.pathname.match(/\/rest\/v1\/([^/?]+)/);
    const table = m ? m[1] : null;

    if (method === 'GET' || method === 'HEAD') {
      const rows0 = ((table && fixtures[table]) || []) as unknown[];
      // what staff_checkin did in this stub, read back as the server would show it
      const rows = table === 'queue_entries' && ciDone.size
        ? rows0.map((r) => { const o = r as Record<string, unknown>; const p = ciDone.get(String(o.id)); return p ? { ...o, ...p } : r; })
        : rows0;
      return route.fulfill({
        status: 200,
        headers: { ...cors(), 'content-type': 'application/json', 'content-range': `0-${rows.length}/${rows.length}` },
        body: JSON.stringify(rows),
      });
    }

    // Injected write failure. Without this the stub answers 2xx to every write, so ~60% of
    // the app's save paths — the ones with no error check — look identical to working code
    // in the suite, and RLS denials are unreachable in a test.
    if (
      failWrite && failsLeft > 0 &&
      (!failWrite.table || failWrite.table === table) &&
      (!failWrite.methods || failWrite.methods.includes(method))
    ) {
      failsLeft--;
      return route.fulfill({
        status: failWrite.status ?? 403,
        headers: { ...cors(), 'content-type': 'application/json' },
        body: JSON.stringify({
          code: failWrite.code ?? '42501',
          message: failWrite.message ?? 'new row violates row-level security policy',
        }),
      });
    }

    // POST/PATCH/DELETE: pretend it worked, echo the payload back.
    let body: unknown = [];
    try {
      const sent = req.postDataJSON();
      body = Array.isArray(sent) ? sent : [sent];
    } catch { /* non-JSON body */ }
    return route.fulfill({
      status: method === 'POST' ? 201 : 200,
      headers: { ...cors(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  });
}

type PhxMsg = { join_ref?: unknown; ref?: unknown; topic?: unknown; event?: unknown; payload?: { config?: { postgres_changes?: Record<string, unknown>[] } } };

/** Answers the realtime websocket here, so no spec ever opens one to the real project.
 *
 *  page.route() never sees a websocket: every spec used to hold a live socket to production
 *  for as long as it ran. That was ~770 connections per CI run and 93,000 in one day, counted
 *  against the project's egress allowance. Every join and heartbeat is acknowledged, so the
 *  channel still reports SUBSCRIBED, and no event ever arrives unless a spec sends one with
 *  the returned broadcast(). Both wire formats are answered: the array one (vsn 2.0.0) and
 *  the object one (1.0.0). A spec that needs broadcast() calls this again after stubSupabase:
 *  the newest route answers the page's socket. */
export async function stubRealtime(page: Page) {
  const joined: { ws: WebSocketRoute; topic: string; joinRef: unknown; asArray: boolean }[] = [];
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    ws.onMessage((raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(raw)); } catch { return; }
      const asArray = Array.isArray(parsed);
      const m: PhxMsg = asArray
        ? (() => { const [join_ref, ref, topic, event, payload] = parsed as unknown[]; return { join_ref, ref, topic, event, payload } as PhxMsg; })()
        : parsed as PhxMsg;
      if (m.ref == null) return;
      if (m.event === 'phx_join') joined.push({ ws, topic: String(m.topic), joinRef: m.join_ref, asArray });
      // The client checks that the server echoes each postgres_changes binding, with an id.
      const bindings = m.event === 'phx_join' ? (m.payload?.config?.postgres_changes || []) : [];
      const reply = { status: 'ok', response: m.event === 'phx_join' ? { postgres_changes: bindings.map((b, i) => ({ ...b, id: i + 1 })) } : {} };
      ws.send(JSON.stringify(asArray
        ? [m.join_ref, m.ref, m.topic, 'phx_reply', reply]
        : { join_ref: m.join_ref, ref: m.ref, topic: m.topic, event: 'phx_reply', payload: reply }));
    });
  });
  return {
    /** Pushes a broadcast, as the server would, to every socket that joined `topic`
     *  (the channel name with its prefix, e.g. 'realtime:staff-ref'). */
    broadcast(topic: string, event: string, payload: unknown) {
      for (const j of joined.filter((x) => x.topic === topic)) {
        const body = { type: 'broadcast', event, payload };
        j.ws.send(JSON.stringify(j.asArray
          ? [j.joinRef, null, topic, 'broadcast', body]
          : { join_ref: j.joinRef, ref: null, topic, event: 'broadcast', payload: body }));
      }
    },
  };
}

/** The booking rows the client sent, whichever door it used.
 *
 *  Customer bookings go through the customer_create_booking RPC (so the row can come back
 *  without SELECT on queue_entries); staff paths still insert directly. Specs care about
 *  what was sent, not which transport carried it, so this captures both and answers with
 *  rows shaped the way each caller expects.
 *
 *  Pass `rpcMissing` to simulate a database that predates the RPC, which must make the
 *  client fall back to a direct insert. */
export async function captureBookingRows(page: Page, opts: { rpcMissing?: boolean } = {}) {
  const rows: Record<string, unknown>[] = [];
  const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

  await page.route(/\/rest\/v1\/rpc\/customer_create_booking/, async (route) => {
    if (opts.rpcMissing) {
      return route.fulfill({
        status: 404, headers: head,
        body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.customer_create_booking' }),
      });
    }
    const sent = route.request().postDataJSON() as { p_entries?: Record<string, unknown>[] };
    const entries = sent?.p_entries ?? [];
    entries.forEach((r) => rows.push(r));
    // Echo the shape the real RPC returns, so the client's queue-number sync has something
    // to read back. queue_num is passed through rather than invented, since specs assert it.
    return route.fulfill({
      status: 200, headers: head,
      body: JSON.stringify(entries.map((r) => ({
        id: r.id, queue_num: r.queue_num, status: r.status,
        waitlist_num: r.waitlist_num ?? null, price: r.price,
      }))),
    });
  });

  await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
    // Writes are what this helper is for. A READ has to fall through to stubSupabase and
    // come back with the fixture rows: answering it with [] here told the app the session
    // was empty, so any code that checks the server before writing - the desk walk-in's
    // duplicate check - saw nothing and wrote anyway, and the spec could not tell that
    // apart from a real bug. fallback(), not continue(): continue() goes to the network.
    if (route.request().method() !== 'POST') return route.fallback();
    const b = route.request().postDataJSON();
    (Array.isArray(b) ? b : [b]).forEach((r: Record<string, unknown>) => rows.push(r));
    return route.fulfill({ status: 201, headers: head, body: '[]' });
  });

  return rows;
}

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
}

// Unlocks the staff panel locally, exactly like a successful PIN entry does.
// Also names the operator: the op-gate modal blocks the staff view until a name is set
// (every logged action carries who did it), and specs act as "Spec Staff".
export async function unlockStaff(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('cq_staff', '1');
    localStorage.setItem('cq_op_name', 'Spec Staff');
  });
}

// Signs a customer in locally, exactly like a remembered login session does.
// session_token is required: customer flows always use the token RPCs (CUST_RPC), and a
// remembered session without a token is dropped at getSession() to force a fresh login.
export async function loginCustomer(page: Page, cust: Record<string, unknown> = {}) {
  const c = { id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', session_token: 'tok-spec', ...cust };
  await page.addInitScript((session) => localStorage.setItem('cq_session', session), JSON.stringify(c));
}

// Wait until the app is ready: the Supabase client (sb) is built AND a data load has
// FULLY completed. loadData() flips S.dataLoaded (first paint) before it fetches the
// trailing cashier_sales, so waiting on dataLoaded alone lets a test inject state that the
// late fetch then clobbers. _lastLoadOk is set only after the whole load finishes, so it's
// the race-free signal. (Falls back to dataLoaded if _lastLoadOk isn't defined.)
export async function waitForSb(page: Page) {
  await page.waitForFunction(
    'typeof sb !== "undefined" && !!sb && typeof S !== "undefined" && !!S.dataLoaded' +
      ' && (typeof _lastLoadOk === "undefined" || _lastLoadOk === true)' +
      ' && (typeof _refsLoaded === "undefined" || _refsLoaded === true)', // the lists that stream in behind the first paint
    undefined,
    { timeout: 10000 },
  );
}

/** The staff panel is up and usable.
 *  On a phone the sections live behind a burger, so the rail itself is display:none until it
 *  is opened — waiting on the rail there waits for ever. Wait for whichever of the two this
 *  viewport actually shows. */
export async function staffReady(page: Page) {
  await page.locator('#snav-burger, #staff-tab-nav').filter({ visible: true }).first().waitFor();
}

/** Go to a staff section the way a person would, on either viewport. */
export async function goStaffTab(page: Page, tab: string) {
  await staffReady(page); // straight after goto the burger may not be painted yet, and a phone would skip it
  const burger = page.locator('#snav-burger');
  if (await burger.isVisible()) await burger.click();
  await page.locator(`#staff-tab-nav .tab-btn[data-stab="${tab}"]`).click();
}

/** The staff half of the app (staff.js, split off at build time - scripts/split-staff.mjs) is
 *  fetched only when a staffer enters. A spec that calls a staff-side helper straight from the page
 *  context on a customer's page asks for it first; on a staff device the boot already did. */
export async function loadStaffHalf(page: Page) {
  await page.evaluate(`typeof _loadStaff==='function'?_loadStaff():null`);
}

/** A check-in is one staff_checkin call carrying the payment (2026-10-04). Specs that watch the
 *  booking's PATCHes read that call as the row it writes: status active plus whatever it sets. */
export function checkinAsRow(r: { url(): string; postDataJSON(): unknown }, id?: string): Record<string, unknown> | null {
  if (!r.url().includes('/rest/v1/rpc/staff_checkin')) return null;
  let b: Record<string, unknown>;
  try { b = (r.postDataJSON() || {}) as Record<string, unknown>; } catch { return null; }
  if (id && b.p_booking_id !== id) return null;
  const row: Record<string, unknown> = { status: 'active', id: b.p_booking_id };
  if (b.p_bike_id) row.assigned_bike_id = b.p_bike_id;
  if (b.p_paid !== undefined) row.paid = b.p_paid;
  if (b.p_price !== undefined) row.price = b.p_price;
  if (b.p_type !== undefined) row.type_preference = b.p_type;
  if (b.p_ride_group !== undefined) row.ride_group = b.p_ride_group || null;
  if (b.p_pay_method !== undefined) { row.pay_method = b.p_pay_method || null; row.card_amount = b.p_card_amount ?? null; }
  return row;
}
