import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A signed-in staff device keeps its own copy of the bookings, the riders and the rider tags
// (IndexedDB) and asks staff_sync (migration 20260924230000) for what changed since it last
// looked. Every open used to read the whole year of bookings and the whole rider list; measured
// on 2026-09-24 that was most of the project's egress. What must hold: the first read is whole,
// the next ones ask from the server's clock less five minutes, changed rows replace and deleted
// keys drop, the copy survives a reload and leaves with the account, and a database without the
// function keeps the old reads.
const SID = '2099-03-06';
const sessions = [{ id: SID, day: 'Friday', session_date: SID, capacity: 12, status: 'open', created_at: 1 }];
const row = (id: string, qn: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: SID, session_day: 'Friday', session_date: SID, queue_num: qn, name, phone: '', email: '', customer_id: null,
  group_id: null, status: 'waiting', paid: false, price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z',
  type_preference: 'Road', size: 'M', purchases: null, addons: null, updated_at: '2099-03-01T10:00:00+00:00', ...extra,
});
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const T1 = '2099-03-05T12:00:00+00:00';
const T2 = '2099-03-05T12:10:00+00:00';
const empty = (now: string) => ({ now, rows: [], deleted: [] });

type Call = { p_table: string; p_since: string | null; p_cut: string | null };
// A whole read (2026-10-27) asks staff_sync for its clock alone - what changed after the far future - and then reads
// the bookings and the riders from their tables in pages of 1,000 by key; the tags stay one staff_sync call.
const WHOLE = '2999-12-31T00:00:00Z';
/** Answers staff_sync from the spec: `answer` gets each call and returns its body, the whole list for a whole read.
 *  A whole read's rows are then what the table's pages answer (order=id.asc), and the clock call itself brings none. */
async function syncServer(page: Page, answer: (c: Call, n: number) => unknown) {
  const calls: Call[] = [];
  const table: Record<string, unknown[]> = {};
  await page.route('**/rest/v1/rpc/staff_sync', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const c = route.request().postDataJSON() as Call;
    calls.push(c);
    const n = calls.filter((x) => x.p_table === c.p_table).length;
    let body = answer(c, n) as { now?: string; rows?: unknown[]; deleted?: unknown[] } | null;
    if (c.p_since === WHOLE && c.p_table !== 'customer_tags' && body && Array.isArray(body.rows)) { table[c.p_table] = body.rows; body = { ...body, rows: [], deleted: [] }; }
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  await page.route(/\/rest\/v1\/(queue_entries|customers)\?.*order=id\.asc/, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const t = (/\/rest\/v1\/([a-z_]+)\?/.exec(route.request().url()) || [])[1] || '';
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(table[t] || []) });
  });
  return calls;
}
const qCalls = (calls: Call[]) => calls.filter((c) => c.p_table === 'queue_entries');
// The boot's own load runs before the spec can sign the device in (there is no real Auth
// session under the stub); every sync read is driven from here, as staffAuthRestore would.
const syncLoad = (page: Page) => page.evaluate(`(async()=>{S._staffAuthed=true;await loadData();})()`);
const ids = (page: Page) => page.evaluate(`getQueue().map(e=>e.id).sort().join()`);

/** Boots an unlocked staff device. `answer` (optional) is installed after the stub, because
 *  Playwright asks the newest route first. Returns the staff_sync calls. */
async function bootStaff(page: Page, answer?: (c: Call, n: number) => unknown, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [row('fromTable', 9, 'Read the old way')], ...fixtures });
  const calls = answer ? await syncServer(page, answer) : [];
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  return calls;
}

test('a signed-in staff device reads the year whole once, in pages, on the server\'s clock', async ({ page }) => {
  const calls = await bootStaff(page, (c) => c.p_table === 'queue_entries'
    ? { now: T1, rows: [row('e1', 1, 'Ann'), row('e2', 2, 'Bo')], deleted: [] }
    : empty(T1));
  expect(await ids(page)).toBe('fromTable'); // before the sign-in the old read stands
  const reads: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/queue_entries?select=*')) reads.push(r.url()); });
  await syncLoad(page);
  expect(await ids(page)).toBe('e1,e2'); // the whole list: the row read the old way is gone
  const q = qCalls(calls);
  expect(q).toHaveLength(1);
  expect(q[0].p_since).toBe(WHOLE); // the clock alone: the rows come from the table's pages, no one document of a year
  expect(q[0].p_cut).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(reads).toHaveLength(1); // one page (fewer than 1,000 rows), by key, from the cut on
  expect(reads[0]).toContain('order=id.asc');
  expect(decodeURIComponent(reads[0])).toContain('session_date=gte.' + q[0].p_cut);
});

test('the next read asks from the server clock less five minutes; changed rows replace, deleted ones drop', async ({ page }) => {
  const calls = await bootStaff(page, (c, n) => {
    if (c.p_table !== 'queue_entries') return empty(T1);
    if (n === 1) return { now: T1, rows: [row('e1', 1, 'Ann'), row('e2', 2, 'Bo')], deleted: [] };
    return {
      now: T2,
      rows: [row('e2', 2, 'Bo', { status: 'active', updated_at: '2099-03-05T12:08:00+00:00' }), row('e3', 3, 'Cy', { updated_at: '2099-03-05T12:09:00+00:00' })],
      deleted: [{ id: 'e1', at: '2099-03-05T12:07:00+00:00' }],
    };
  });
  await syncLoad(page);
  await syncLoad(page);
  const q = qCalls(calls);
  expect(q).toHaveLength(2);
  expect(q[1].p_since).toBe('2099-03-05T11:55:00.000Z');
  expect(await ids(page)).toBe('e2,e3');
  expect(await page.evaluate(`getQueue().find(e=>e.id==='e2').status`)).toBe('active');
});

test('a key deleted and then used again stays: the row stamped after the delete is the one that exists', async ({ page }) => {
  await bootStaff(page, (c, n) => {
    if (c.p_table !== 'queue_entries') return empty(T1);
    if (n === 1) return { now: T1, rows: [row('e1', 1, 'Ann')], deleted: [] };
    return { now: T2, rows: [row('e1', 1, 'Ann again', { updated_at: '2099-03-05T12:09:00+00:00' })], deleted: [{ id: 'e1', at: '2099-03-05T12:05:00+00:00' }] };
  });
  await syncLoad(page);
  await syncLoad(page);
  expect(await page.evaluate(`getQueue().map(e=>e.name).join()`)).toBe('Ann again');
});

test('the copy survives a reload, and signing out takes it away', async ({ page }) => {
  const calls = await bootStaff(page, (c, n) => {
    if (c.p_table !== 'queue_entries') return empty(T2);
    if (n === 1) return { now: T1, rows: [row('e1', 1, 'Ann'), row('e2', 2, 'Bo')], deleted: [] };
    if (n === 2) return { now: T2, rows: [row('e3', 3, 'Cy', { updated_at: '2099-03-05T12:09:00+00:00' })], deleted: [] };
    return empty(T2);
  });
  await syncLoad(page);
  await syncLoad(page);
  await page.waitForTimeout(2200); // the copy is written 1.5s after the last change
  await page.reload();
  await waitForSb(page);
  await syncLoad(page);
  let q = qCalls(calls);
  expect(q).toHaveLength(3);
  expect(q[2].p_since).toBe('2099-03-05T12:05:00.000Z'); // the copy's clock, not a whole read
  expect(await ids(page)).toBe('e1,e2,e3');             // and its rows, with nothing new from the server

  await page.evaluate(`staffAuthSignOut()`);
  await page.waitForTimeout(300);
  await page.reload();
  await waitForSb(page);
  await syncLoad(page);
  q = qCalls(calls);
  expect(q).toHaveLength(4);
  expect(q[3].p_since).toBe(WHOLE); // no copy left: read whole
});

test('the riders and their tags come through the same sync, deleted tag links included', async ({ page }) => {
  const cust = { id: 'c1', name: 'Ann Rider', email: 'ann@example.com', phone: '0500000001', created_at: '2099-01-01T00:00:00Z', updated_at: T1 };
  const link = { customer_id: 'c1', tag_id: 'tag_saturday', added_by: 'x', added_at: 1, note: null, starts_at: null, expires_at: null, updated_at: T1 };
  const calls = await bootStaff(page, (c, n) => {
    if (c.p_table === 'customers') return n === 1 ? { now: T1, rows: [cust], deleted: [] } : empty(T2);
    if (c.p_table === 'customer_tags') return n === 1 ? { now: T1, rows: [link], deleted: [] } : { now: T2, rows: [], deleted: [{ id: 'c1|tag_saturday', at: '2099-03-05T12:06:00+00:00' }] };
    return empty(T1);
  }, { customers: [{ id: 'old', name: 'Read The Old Way', created_at: '2000-01-01' }] });
  await page.evaluate(`(async()=>{S._staffAuthed=true;refDirty();await loadData();})()`);
  expect(await page.evaluate(`S.customers.map(c=>c.id).join()`)).toBe('c1');
  expect(await page.evaluate(`S.customerTags.length`)).toBe(1);
  await page.evaluate(`(async()=>{refDirty();await loadData();})()`);
  expect(await page.evaluate(`S.customerTags.length`)).toBe(0);
  expect(calls.filter((c) => c.p_table === 'customer_tags')[1].p_since).toBe('2099-03-05T11:55:00.000Z');
});

test('a database without staff_sync keeps the old reads, and stops asking', async ({ page }) => {
  await bootStaff(page, undefined, {
    'rpc:staff_sync': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_sync in the schema cache' } },
  });
  const syncs: string[] = [];
  const reads: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/rpc/staff_sync')) syncs.push(r.url());
    if (r.method() === 'GET' && r.url().includes('/rest/v1/queue_entries?select=*')) reads.push(r.url());
  });
  await syncLoad(page);
  expect(await ids(page)).toBe('fromTable');
  expect(reads.length).toBeGreaterThan(0);
  const asked = syncs.length;
  expect(asked).toBeGreaterThan(0);
  await syncLoad(page);
  expect(syncs.length).toBe(asked); // turned off for the page's life after the first answer
});

test('a staff_sync that fails on its own hands over to the old reads, and stops asking', async ({ page }) => {
  // 2026-09-25: a column grant the function lacked refused every call, and the desk opened with
  // no riders - the account report found nobody. The riders must still come, the old way.
  await bootStaff(page, undefined, {
    customers: [{ id: 'old', name: 'Read The Old Way', created_at: '2000-01-01' }],
    'rpc:staff_sync': { __rpcError: { status: 403, code: '42501', message: 'permission denied for table customers' } },
  });
  const syncs: string[] = [];
  const reads: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/rpc/staff_sync')) syncs.push(r.url());
    if (r.method() === 'GET' && r.url().includes('/rest/v1/customers?')) reads.push(r.url());
  });
  await page.evaluate(`(async()=>{S._staffAuthed=true;refDirty();await loadData();})()`);
  expect(await page.evaluate(`S.customers.map(c=>c.id).join()`)).toBe('old');
  expect(reads.length).toBeGreaterThan(0);
  const asked = syncs.length;
  expect(asked).toBeGreaterThan(0);
  await page.evaluate(`(async()=>{refDirty();await loadData();})()`);
  expect(syncs.length).toBe(asked);
});

test('a staff session the server refuses keeps what the device holds, and asks again next time', async ({ page }) => {
  await bootStaff(page, undefined, {
    'rpc:staff_sync': { __rpcError: { status: 403, code: '42501', message: 'STAFF_ONLY' } },
  });
  const syncs: string[] = [];
  const reads: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/rpc/staff_sync')) syncs.push(r.url());
    if (r.method() === 'GET' && r.url().includes('/rest/v1/customers?')) reads.push(r.url());
  });
  await page.evaluate(`(async()=>{S._staffAuthed=true;refDirty();await loadData();})()`);
  expect(reads).toEqual([]); // RLS would answer an empty list; the device keeps its own
  const asked = syncs.length;
  expect(asked).toBeGreaterThan(0);
  await page.evaluate(`(async()=>{refDirty();await loadData();})()`);
  expect(syncs.length).toBeGreaterThan(asked);
});
