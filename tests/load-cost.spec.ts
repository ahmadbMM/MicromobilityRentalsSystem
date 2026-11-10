import { test, expect } from '@playwright/test';
import { stubSupabase, stubRealtime, unlockStaff, waitForSb } from './helpers/supabase';

// Every staff write ends in loadData(), and loadData used to refetch EVERYTHING — including
// customers and customer_tags, ~4,300 rows on the live database, as four fetches that awaited
// one another. Eight round trips at a measured ~250ms, added to closing a session: an action
// that cannot have changed any of them.
//
// Reference data now loads once and reloads only when something touches it. What must hold:
// it still loads, a repeat load does not refetch it, and a write to it makes the next load do so.

const S1 = '2099-12-01';
const sessions = [{ id: S1, session_date: S1, day: 'Tuesday', status: 'open', capacity: 10, created_at: 1 }];
const REF = ['customers', 'tags', 'customer_tags', 'breakfast_spots'];

/** GET counts per table, from the moment it is installed. */
function counter(page: import('@playwright/test').Page) {
  const hits: Record<string, number> = {};
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/([a-z_]+)/);
    if (m && r.method() === 'GET') hits[m[1]] = (hits[m[1]] || 0) + 1;
  });
  return hits;
}

async function bootStaff(page: import('@playwright/test').Page) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], customers: [], tags: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
}

test('boot still loads the reference data', async ({ page }) => {
  const hits = counter(page);
  await bootStaff(page);
  await page.waitForTimeout(500);
  for (const t of REF) expect(hits[t] || 0, `${t} on boot`).toBeGreaterThan(0);
});

test('a second load does not refetch it', async ({ page }) => {
  await bootStaff(page);
  await page.waitForTimeout(400);
  const hits = counter(page);            // installed AFTER boot, so it sees only the reload
  await page.evaluate(`loadData()`);
  await page.waitForTimeout(400);
  for (const t of REF) expect(hits[t] || 0, `${t} on reload`).toBe(0);
  expect(hits['queue_entries'] || 0, 'the live queue still reloads').toBeGreaterThan(0);
});

test('a write to a reference table makes the next load refetch it', async ({ page }) => {
  await bootStaff(page);
  await page.waitForTimeout(400);
  const hits = counter(page);
  await page.evaluate(`sb.from('customers').update({height:180}).eq('id','c1')`);
  await page.evaluate(`loadData()`);
  await page.waitForTimeout(500);
  expect(hits['customers'] || 0).toBeGreaterThan(0);
});

test('the stale copy is picked up without a write, so another till is not invisible forever', async ({ page }) => {
  await bootStaff(page);
  await page.waitForTimeout(400);
  const hits = counter(page);
  await page.evaluate(`_refAt = Date.now() - (6*60*1000)`);   // older than the TTL
  await page.evaluate(`loadData()`);
  await page.waitForTimeout(500);
  expect(hits['customers'] || 0).toBeGreaterThan(0);
});

// A burst of actions used to stack one full reload each, all refetching the same rows.
// They are coalesced -- but NOT by handing a late caller the load already in flight. That
// fetch left before whatever they just wrote, so answering with it renders their own change
// away until the next poll. Everyone who arrives mid-flight shares ONE follow-up instead:
// bounded at two round trips for a burst of any size, and never stale.
test('a burst of loads is bounded, not one fetch each', async ({ page }) => {
  await bootStaff(page);
  await page.waitForTimeout(400);
  await page.route('**/rest/v1/queue_entries*', async (route) => {
    await new Promise((r) => setTimeout(r, 250));      // real latency, or no burst can form
    await route.fallback();                            // to the stub, not to the network
  });
  const hits = counter(page);
  await page.evaluate(`Promise.all([loadData(),loadData(),loadData(),loadData(),loadData()])`);
  await page.waitForTimeout(900);
  expect(hits['queue_entries'] || 0).toBeGreaterThan(0);
  expect(hits['queue_entries'] || 0).toBeLessThanOrEqual(2);   // five callers, at most two fetches
});

test('a load issued mid-flight is answered by a FRESH fetch, not the one already running', async ({ page }) => {
  await bootStaff(page);
  await page.waitForTimeout(400);
  await page.route('**/rest/v1/queue_entries*', async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.fallback();
  });
  const hits = counter(page);
  // stands in for: a staff write lands while the 30s poll's load is already in the air
  await page.evaluate(
    `(async()=>{const a=loadData();await new Promise(r=>setTimeout(r,60));const b=loadData();await Promise.all([a,b]);})()`);
  await page.waitForTimeout(900);
  expect(hits['queue_entries'] || 0).toBeGreaterThanOrEqual(2);
});

test('the light load coalesces the same way', async ({ page }) => {
  await bootStaff(page);
  await page.waitForTimeout(400);
  await page.route('**/rest/v1/queue_entries*', async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.fallback();
  });
  const hits = counter(page);
  await page.evaluate(
    `(async()=>{const a=loadDataLight();await new Promise(r=>setTimeout(r,60));const b=loadDataLight();await Promise.all([a,b]);})()`);
  await page.waitForTimeout(900);
  expect(hits['queue_entries'] || 0).toBeGreaterThanOrEqual(2);
});

// The 30s poll used to rebuild the roster whether or not anything had moved, landing in the
// middle of whatever staff were doing.
test('a poll that changed nothing does not rebuild the screen', async ({ page }) => {
  await bootStaff(page);
  // the fetch is pinned so the poll cannot reload state out from under the assertions;
  // what is under test is the decision to re-render, not the fetch
  await page.evaluate(`S.view='staff';S.staffTab='queue';window.__noWiden=false;
    loadDataLight=async()=>{};
    window.__renders=0;const _r=renderStaffQueue;renderStaffQueue=function(){window.__renders++;return _r.apply(null,arguments);}`);
  await page.evaluate(`_autoRefresh(false)`);      // first pass records the fingerprint
  await page.evaluate(`_autoRefresh(false)`);
  await page.evaluate(`_autoRefresh(false)`);
  // a poll's repaint is one paint in the next frame since staff round s10 (_qPaintSoon)
  const frame = () => page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(0))))');
  await frame();
  expect(await page.evaluate('window.__renders')).toBe(1);
  // but a real change still paints
  await page.evaluate(`S.queue=[...(S.queue||[]),{id:'x1',status:'waiting',queueNum:99,sessionId:'${S1}'}];_autoRefresh(false)`);
  await frame();
  expect(await page.evaluate('window.__renders')).toBe(2);
});

// Egress. The free plan allows 5 GB a month and the project went over: the staff queue reload
// asked for the whole window (5,098 rows, ~4 MB of JSON) after every write, on every poll and
// every time a booth phone woke, and every spec held a live realtime socket to production.

const cutFor = (days: number) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

/** The session_date cut of every queue_entries GET, from the moment it is installed. */
function queueCuts(page: import('@playwright/test').Page) {
  const cuts: string[] = [];
  page.on('request', (r) => {
    const m = decodeURIComponent(r.url()).match(/\/rest\/v1\/queue_entries\?.*session_date=gte\.([0-9-]+)/);
    if (m && r.method() === 'GET') cuts.push(m[1]);
  });
  return cuts;
}

test('once the whole window is held, a staff reload asks for the live nights only', async ({ page }) => {
  await bootStaff(page);
  await page.waitForTimeout(400);
  const cuts = queueCuts(page);
  await page.evaluate(`S._fullWindow = true; _qWholeAt = 0`);
  await page.evaluate(`loadData()`);                                   // the whole window, once
  await page.evaluate(`loadData()`);                                   // then the live nights
  await page.evaluate(`loadDataLight()`);                              // the light reload too
  await page.evaluate(`(_qWholeAt = Date.now() - 31*60*1000, loadDataLight())`);
  expect(cuts).toEqual([cutFor(365), cutFor(2), cutFor(2), cutFor(365)]);  // and the whole again when due
});

test('a live reload keeps the older rows and drops a live one deleted elsewhere', async ({ page }) => {
  await bootStaff(page);
  const out = await page.evaluate(`(S.queue = [
      { id: 'old', sessionDate: '2000-01-01', name: 'kept' },
      { id: 'gone', sessionDate: '2999-01-01', name: 'deleted elsewhere' },
      { id: 'live', sessionDate: '2999-01-01', name: 'before' },
    ], _qMerge([{ id: 'live', sessionDate: '2999-01-01', name: 'after' }], '2999-01-01').map((e) => e.id + ':' + e.name))`);
  expect(out).toEqual(['old:kept', 'live:after']);
});

test('a device that has not taken the whole window takes it on its next reload', async ({ page }) => {
  await bootStaff(page);
  await page.waitForTimeout(400);
  const cuts = queueCuts(page);
  await page.evaluate(`S._fullWindow = true; _qWholeAt = Date.now()`);
  await page.evaluate(`loadData()`);
  await page.evaluate(`_qWholeAt = 0`);                                // e.g. a load went down the customer branch
  await page.evaluate(`loadData()`);
  expect(cuts).toEqual([cutFor(2), cutFor(365)]);
});

test('realtime joins through the local stub, never the real project', async ({ page }) => {
  await bootStaff(page);
  await expect.poll(() => page.evaluate('!!S._rtConnected'), { timeout: 8000 }).toBe(true);
});

// Rider changes reach the desk the moment they happen, on the private staff-ref channel, fed by
// a trigger (20260921160000). The whole list comes down only as a half-hour backstop then.

async function refLive(page: import('@playwright/test').Page) {
  await page.evaluate(`S._staffAuthed = true; setupRefRealtime()`);
  await page.waitForFunction('_refLive === true', null, { timeout: 8000 });
}

test('a rider change from another device lands on the desk at once, with no fetch', async ({ page }) => {
  const c1 = { id: 'c1', name: 'First', phone: '0500', created_at: '2026-01-01T00:00:00+00:00' };
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], customers: [c1], tags: [] });
  const rt = await stubRealtime(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true && (S.customers||[]).length===1`);
  await refLive(page);
  expect(await page.evaluate(`[_refCh.topic, _refCh.params.config.private]`)).toEqual(['realtime:staff-ref', true]);
  const hits = counter(page);
  const ids = () => page.evaluate(`S.customers.map((c) => c.id + ':' + (c.phone || '')).join(',')`);
  const links = () => page.evaluate(`(S.customerTags || []).map((x) => x.customer_id + '/' + x.tag_id + (x.note ? ':' + x.note : '')).join(',')`);

  rt.broadcast('realtime:staff-ref', 'customers', { op: 'INSERT', id: 'c2', row: { id: 'c2', name: 'Just Signed Up' } });
  rt.broadcast('realtime:staff-ref', 'customers', { op: 'UPDATE', id: 'c1', row: { id: 'c1', name: 'First', phone: '0555' } });
  rt.broadcast('realtime:staff-ref', 'customer_tags', { op: 'INSERT', row: { customer_id: 'c2', tag_id: 't1' } });
  rt.broadcast('realtime:staff-ref', 'tags', { op: 'INSERT', id: 't1', row: { id: 't1', name: 'VIP' } });
  await expect.poll(ids).toBe('c1:0555,c2:');
  await expect.poll(links).toBe('c2/t1');
  expect(await page.evaluate(`S.tags.map((t) => t.name)`)).toEqual(['VIP']);

  rt.broadcast('realtime:staff-ref', 'customer_tags', { op: 'UPDATE', old: { customer_id: 'c2', tag_id: 't1' }, row: { customer_id: 'c2', tag_id: 't1', note: 'hi' } });
  await expect.poll(links).toBe('c2/t1:hi');
  rt.broadcast('realtime:staff-ref', 'customer_tags', { op: 'DELETE', old: { customer_id: 'c2', tag_id: 't1' }, row: null });
  rt.broadcast('realtime:staff-ref', 'customers', { op: 'DELETE', id: 'c2', row: null });
  await expect.poll(ids).toBe('c1:0555');
  await expect.poll(links).toBe('');
  for (const t of REF) expect(hits[t] || 0, `${t} fetched`).toBe(0);
});

test('while the channel is up the list is refetched every half hour, otherwise every five minutes', async ({ page }) => {
  await bootStaff(page);
  await refLive(page);
  expect(await page.evaluate(`_refDirty = false; _refByStaff = true; _refAt = Date.now() - 6*60*1000; _refNeeded()`)).toBe(false);
  expect(await page.evaluate(`_refAt = Date.now() - 31*60*1000; _refNeeded()`)).toBe(true);
  // a list read before staff auth came back empty under RLS: it keeps the five minutes
  expect(await page.evaluate(`_refByStaff = false; _refAt = Date.now() - 6*60*1000; _refNeeded()`)).toBe(true);
  // and so does a device whose channel is down
  expect(await page.evaluate(`_refByStaff = true; _refLive = false; _refNeeded()`)).toBe(true);
});

test('a rejoin after a drop refetches the list, since the gap was missed; a repeat auth restore does not rejoin', async ({ page }) => {
  await bootStaff(page);
  await refLive(page);
  expect(await page.evaluate(`_refDirty = false; window.__ch = _refCh; setupRefRealtime(); window.__ch === _refCh && !_refDirty`)).toBe(true);
  await page.evaluate(`setupRefRealtime(true)`);          // what the retry timer does after a drop
  await page.waitForFunction('_refDirty === true && _refLive === true', null, { timeout: 8000 });
});

test('signing out leaves the staff channel; a device that is not staff never joins it', async ({ page }) => {
  await bootStaff(page);
  await refLive(page);
  await page.evaluate(`staffAuthSignOut()`);
  expect(await page.evaluate(`[_refCh === null, _refLive]`)).toEqual([true, false]);
  expect(await page.evaluate(`S._staffAuthed = false; setupRefRealtime(); _refCh === null`)).toBe(true);
});
