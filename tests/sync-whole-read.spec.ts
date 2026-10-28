import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A staff device with no copy of the bookings or the riders reads them whole, page by page, and keeps each page as it
// lands (2026-10-28). On the night of 2026-10-27 a staff phone read the year four times over in four minutes: every
// reload and every page lost as the phone went to the background began the year again, a failed page set the old whole
// read going beside a new one, and the roster waited for the whole year. What must hold: a slow device shows the live
// nights first and lays the year over them; a reload or a failed page goes on from the last page kept; nothing starts
// the old whole read beside it; the database's load never turns the sync off; the fortnightly whole read runs behind the
// screen; a failed read of the riders keeps the ones held.
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const json = (body: unknown, status = 200) => ({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const WHOLE = '2999-12-31T00:00:00Z';
const T1 = '2099-03-05T12:00:00+00:00', T2 = '2099-03-05T12:10:00+00:00', T3 = '2099-03-06T09:00:00+00:00';
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10); // as _qWindowCut counts
type Row = Record<string, unknown> & { id: string };
const row = (id: string, date: string): Row => ({
  id, session_id: date, session_day: 'Friday', session_date: date, queue_num: 1, name: 'R ' + id, phone: '', email: '', customer_id: null,
  group_id: null, status: 'waiting', paid: false, price: 30, walk_in: true, registered_at: '2026-01-01T10:00:00Z',
  type_preference: 'Road', size: 'M', purchases: null, addons: null, updated_at: '2026-01-01T10:00:00+00:00',
});
const many = (n: number, prefix: string, date: string) => Array.from({ length: n }, (_, i) => row(prefix + String(i).padStart(4, '0'), date));
type Call = { p_table: string; p_since: string | null; p_cut: string | null };
type Hook = (url: string) => Promise<'abort' | void> | 'abort' | void;

/** The table's page as PostgREST answers it: from the date asked, after the key asked, by key, up to the limit. */
function pageOf(all: Row[], u: string) {
  const url = new URL(u);
  const gte = (url.searchParams.get('session_date') || '').replace(/^gte\./, '');
  const after = (url.searchParams.get('id') || '').replace(/^gt\./, '');
  const lim = Number(url.searchParams.get('limit') || 1000);
  return all.filter((r) => (!gte || String(r.session_date) >= gte) && (!after || r.id > after)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, lim);
}
/** staff_sync and the tables' pages. The clock call answers `clocks` in turn per table; a delta answers `delta`. */
async function server(page: Page, q: Row[], o: { clocks?: string[]; delta?: (c: Call, n: number) => unknown; qPage?: Hook; cust?: Row[]; cPage?: Hook } = {}) {
  const calls: Call[] = [], qPages: string[] = [], cPages: string[] = [];
  const wholeN: Record<string, number> = {}, deltaN: Record<string, number> = {};
  await page.route('**/rest/v1/rpc/staff_sync', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const c = route.request().postDataJSON() as Call;
    calls.push(c);
    if (c.p_since === WHOLE) {
      const cl = o.clocks || [T1], n = (wholeN[c.p_table] = (wholeN[c.p_table] || 0) + 1);
      return route.fulfill(json({ now: cl[Math.min(n, cl.length) - 1], rows: [], deleted: [] }));
    }
    if (c.p_table !== 'queue_entries' || !o.delta) return route.fulfill(json({ now: c.p_since ? T2 : T1, rows: [], deleted: [] }));
    const b = o.delta(c, (deltaN[c.p_table] = (deltaN[c.p_table] || 0) + 1)) as { __status?: number };
    return route.fulfill(b && b.__status ? json({ ...b, __status: undefined }, b.__status) : json(b));
  });
  const pages = (table: string, all: () => Row[], seen: string[], hook?: Hook) => page.route(new RegExp(`/rest/v1/${table}\\?.*order=id\\.asc`), async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const u = route.request().url();
    seen.push(decodeURIComponent(u));
    if (hook && (await hook(decodeURIComponent(u))) === 'abort') return route.abort('failed').catch(() => {});
    return route.fulfill(json(pageOf(all(), u))).catch(() => {});
  });
  await pages('queue_entries', () => q, qPages, o.qPage);
  await pages('customers', () => o.cust || [], cPages, o.cPage);
  return { calls, qPages, cPages, clock: (t: string) => calls.filter((c) => c.p_table === t && c.p_since === WHOLE).length };
}
async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], ...fixtures });
}
async function open(page: Page) {
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
// The boot's own load runs before the spec signs the device in (no real Auth session under the stub).
const syncLoad = (page: Page) => page.evaluate(`(async()=>{S._staffAuthed=true;await loadData();})()`);
const count = (page: Page) => page.evaluate(`getQueue().length`) as Promise<number>;
const meta = (page: Page) => page.evaluate(`new Promise(res=>{const rq=indexedDB.open('mm-sync-2');rq.onsuccess=()=>{const db=rq.result;try{const g=db.transaction('meta').objectStore('meta').get('q');g.onsuccess=()=>{db.close();res(g.result||null);};}catch(e){db.close();res(null);}};rq.onerror=()=>res(null);})`) as Promise<{ fill?: { after: string | null }; fullAt?: number } | null>;
const yearPage = (u: string) => !u.includes('session_date=gte.' + day(-2)); // the live nights' read asks from two days back
const filled = (page: Page) => expect.poll(() => page.evaluate(`!_syncFillP.q`), { timeout: 20000 }).toBe(true);

test('@staff a slow device with no copy shows the live nights first, then lays the year over them', async ({ page }) => {
  await boot(page);
  const live = [row('L1', day(0)), row('L2', day(3))];
  let served = 0;
  const srv = await server(page, [...many(1500, 'o', day(-30)), ...live], {
    qPage: async (u) => { if (yearPage(u)) { await new Promise((r) => setTimeout(r, 3000)); served++; } },
  });
  await open(page);
  await syncLoad(page);
  expect(served).toBeLessThan(2); // answered before the year's two pages were in
  expect(await page.evaluate(`getQueue().map(e=>e.id).sort().join()`)).toBe('L1,L2');
  expect(srv.qPages.some((u) => u.includes('session_date=gte.' + day(-2)))).toBe(true);
  // the year lands behind the screen and a light reload lays it on (no reload asked for here)
  await page.evaluate(`window.__noWiden=false`);
  await expect.poll(() => count(page), { timeout: 20000 }).toBe(1502);
  await page.evaluate(`window.__noWiden=true`);
  expect(srv.clock('queue_entries')).toBe(1);
});

test('@staff a reload mid-read goes on from the last page kept, not from the start', async ({ page }) => {
  await boot(page);
  let hold = true, release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  const srv = await server(page, many(2500, 'r', day(-10)), {
    qPage: async (u) => { if (hold && u.includes('id=gt.r0999')) { await held; return 'abort'; } },
  });
  await open(page);
  await syncLoad(page); // the live nights (none here) after 2.5 s; the read stops at its second page
  await expect.poll(async () => (await meta(page))?.fill?.after, { timeout: 10000 }).toBe('r0999');
  const before = srv.qPages.length;
  await page.reload();
  hold = false; release();
  await waitForSb(page);
  await syncLoad(page);
  expect(await count(page)).toBe(2500);
  const after = srv.qPages.slice(before).filter(yearPage);
  expect(after[0]).toContain('id=gt.r0999'); // on from the page kept
  expect(after.some((u) => !u.includes('id=gt.'))).toBe(false); // the first page was not asked again
  expect(srv.clock('queue_entries')).toBe(1); // nor the clock: the read's own stands
  await expect.poll(async () => (await meta(page))?.fill === undefined && !!(await meta(page))?.fullAt).toBe(true); // whole now
});

test('@staff a page that keeps failing stops the read where it is: no old whole read beside it, and the next load goes on', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page);
  let fail = true;
  const srv = await server(page, many(1500, 'f', day(-10)), { qPage: (u) => (fail && u.includes('id=gt.f0999') ? 'abort' : undefined) });
  await open(page);
  const old: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && /\/rest\/v1\/queue_entries\?.*order=session_id/.test(r.url())) old.push(r.url()); });
  await syncLoad(page);
  await filled(page); // supabase-js asks a page lost to the network four times in all, then the read stops
  expect(srv.qPages.filter((u) => u.includes('id=gt.f0999')).length).toBe(4);
  expect(old).toEqual([]); // the old read of the whole year did not start beside it
  expect(await page.evaluate(`_syncOff`)).toBe(false);
  fail = false;
  await syncLoad(page);
  expect(await count(page)).toBe(1500);
  expect(srv.clock('queue_entries')).toBe(1);
  expect(old).toEqual([]);
});

test('@staff the database\'s load does not turn the sync off: a cancelled statement keeps what is held, and the next load asks again', async ({ page }) => {
  await boot(page);
  const srv = await server(page, [row('a1', day(1)), row('a2', day(1))], {
    delta: (c, n) => (n === 1 ? { __status: 500, code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null } : { now: T2, rows: [], deleted: [] }),
  });
  await open(page);
  await syncLoad(page); // whole
  await syncLoad(page); // the delta is cancelled
  expect(await count(page)).toBe(2);
  expect(await page.evaluate(`_syncOff`)).toBe(false);
  await page.evaluate(`_sbCoolUntil=0;_sbStrainN=0`);
  const asked = srv.calls.filter((c) => c.p_table === 'queue_entries').length;
  await syncLoad(page);
  expect(srv.calls.filter((c) => c.p_table === 'queue_entries').length).toBe(asked + 1);
  expect(srv.calls.filter((c) => c.p_table === 'queue_entries').pop()?.p_since).toBe('2099-03-05T11:55:00.000Z');
});

test('@staff a copy a fortnight old answers at once and is read whole again behind the screen', async ({ page }) => {
  await boot(page);
  let hold = false, release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  const srv = await server(page, [row('b1', day(-5)), row('b2', day(1))], {
    clocks: [T1, T3],
    qPage: async (u) => { if (hold && yearPage(u)) await held; },
  });
  await open(page);
  await syncLoad(page);
  await page.evaluate(`_sync.q.fullAt=Date.now()-15*864e5`);
  hold = true;
  await syncLoad(page); // answered from the copy and what changed, the year's pages still held
  expect(await count(page)).toBe(2);
  expect(srv.calls.filter((c) => c.p_table === 'queue_entries').map((c) => c.p_since).sort()).toEqual(['2099-03-05T11:55:00.000Z', WHOLE, WHOLE]); // what changed, and the clock of the read behind it
  hold = false; release();
  await expect.poll(() => page.evaluate(`_sync.q.wm`), { timeout: 10000 }).toBe(T3); // put in the copy's place
  expect(await page.evaluate(`Date.now()-_sync.q.fullAt<60000`)).toBe(true);
  await syncLoad(page);
  expect(srv.calls.filter((c) => c.p_table === 'queue_entries').pop()?.p_since).toBe('2099-03-06T08:55:00.000Z');
});

test('@staff a failed read of the riders keeps the ones held, never the old whole read, and the next load goes on', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page, { customers: [{ id: 'old', name: 'Read The Old Way', created_at: '2000-01-01' }] });
  let fail = true;
  const srv = await server(page, [], { cust: [{ id: 'c1', name: 'Ann Rider', created_at: '2026-01-01T00:00:00Z' }], cPage: () => (fail ? 'abort' : undefined) });
  await open(page);
  const old: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && /\/rest\/v1\/customers\?.*order=created_at/.test(r.url())) old.push(r.url()); });
  await page.evaluate(`(async()=>{S._staffAuthed=true;refDirty();await loadData();})()`);
  expect(srv.cPages.length).toBe(4); // supabase-js's four tries, then the read stops
  expect(old).toEqual([]);
  expect(await page.evaluate(`S.customers.map(c=>c.id).join()`)).toBe('old'); // what the device held before the sign-in
  expect(await page.evaluate(`_syncOff`)).toBe(false);
  fail = false;
  await page.evaluate(`(async()=>{refDirty();await loadData();})()`);
  expect(await page.evaluate(`S.customers.map(c=>c.id).join()`)).toBe('c1');
  expect(srv.clock('customers')).toBe(1);
});
