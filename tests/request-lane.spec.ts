import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The database's web layer has ten connections for every phone and tablet together (2026-10-27: at the evening rush a
// six-row price list took 10 s, the bikes 27 s, and the database restarted). A page keeps at most four reads on the wire
// and queues the rest, the first screen's reads first; saves never wait; the same read sent at the same moment is asked
// once; a server answering with its overload signs holds the background reloads; a list read whole comes in pages of
// 1,000 by key, on the server's clock, never as one document that can run past the 8 s limit.

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const SID = '2099-03-06';
const sessions = [{ id: SID, day: 'Friday', session_date: SID, capacity: 12, status: 'open', created_at: 1 }];

async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], tags: [{ id: 't1', name: 'Community' }], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForTimeout(300); // the boot's own reads are done
}

/** Holds every GET of a table for `ms` and records how many are on the wire at once, in the order they left. */
async function slowReads(page: Page, ms: number) {
  const st = { now: 0, max: 0, order: [] as string[] };
  await page.route(/\/rest\/v1\/(?!rpc\/)[a-z_]+\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const u = new URL(route.request().url());
    st.now++; st.max = Math.max(st.max, st.now);
    st.order.push(u.pathname.split('/').pop() + ' ' + (u.searchParams.get('x') || ''));
    await new Promise((r) => setTimeout(r, ms));
    st.now--;
    return route.fallback();
  });
  return st;
}

test('@staff a page keeps at most four reads on the wire', async ({ page }) => {
  await boot(page);
  const st = await slowReads(page, 300);
  await page.evaluate(`Promise.all(Array.from({length:10},(_,i)=>sb.from('tags').select('*').eq('x',String(i))))`);
  expect(st.order).toHaveLength(10);
  expect(st.max).toBe(4);
});

test('@staff the first screen\'s reads leave before the rest, even asked after them', async ({ page }) => {
  await boot(page);
  const st = await slowReads(page, 250);
  await page.evaluate(`(()=>{for(let i=0;i<6;i++)sb.from('tags').select('*').eq('x',String(i)).then(()=>{});sb.from('sessions').select('*').eq('x','s').then(()=>{});})()`);
  await expect.poll(() => st.order.length).toBe(7);
  expect(st.order.indexOf('sessions eq.s')).toBe(4); // after the four that took the lane, ahead of the two queued before it
});

test('@staff a save never waits behind the reads', async ({ page }) => {
  await boot(page);
  await slowReads(page, 600);
  await page.evaluate(`(()=>{for(let i=0;i<8;i++)sb.from('tags').select('*').eq('x',String(i)).then(()=>{});})()`);
  const ms = await page.evaluate(`(async()=>{const t=Date.now();await sb.from('tags').update({name:'Q'}).eq('id','t1');return Date.now()-t;})()`);
  expect(ms).toBeLessThan(500); // eight reads of 600 ms in a lane of four would hold it 1.2 s
});

test('@staff the same read sent twice at the same moment is asked once, and both callers get it', async ({ page }) => {
  await boot(page);
  let n = 0;
  page.on('request', (r) => { if (r.url().includes('/rest/v1/ride_prices') && r.url().includes('x=eq.d')) n++; });
  const got = await page.evaluate(`Promise.all([sb.from('ride_prices').select('*').eq('x','d'),sb.from('ride_prices').select('*').eq('x','d')]).then(a=>a.map(r=>!r.error&&Array.isArray(r.data)))`);
  expect(got).toEqual([true, true]);
  expect(n).toBe(1);
  // after a save, a read is asked again rather than handed the answer from before it
  await page.evaluate(`sb.from('tags').update({name:'Q'}).eq('id','t1')`);
  await page.evaluate(`sb.from('ride_prices').select('*').eq('x','d')`);
  expect(n).toBe(2);
});

test('@staff a server answering with its overload signs holds the background reloads', async ({ page }) => {
  await boot(page);
  await page.route(/\/rest\/v1\/tags\?.*x=eq\.boom/, (r) => r.fulfill({ status: 500, headers: { ...cors, 'content-type': 'application/json' },
    body: JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }) }));
  expect(await page.evaluate(`_sbCooling()`)).toBe(false);
  await page.evaluate(`sb.from('tags').select('*').eq('x','boom')`);
  await expect.poll(() => page.evaluate(`_sbCooling()`)).toBe(true);
  let reads = 0;
  page.on('request', (r) => { if (r.url().includes('/rest/v1/sessions')) reads++; });
  const held = await page.evaluate(`(()=>{window.__noWiden=false;S.view='staff';_autoRefresh(false);const h=!!_sbLaterT;window.__noWiden=true;return h;})()`);
  expect(held).toBe(true); // one reload waits for the strain to ease
  await page.waitForTimeout(400);
  expect(reads).toBe(0);
  await page.evaluate(`clearTimeout(_sbLaterT);_sbLaterT=null;_sbCoolUntil=0;_sbStrainN=0`);
});

test('@staff a list read whole comes in pages by key on the server\'s clock, however long', async ({ page }) => {
  await boot(page);
  const clock: { p_since: string | null }[] = [];
  await page.route('**/rest/v1/rpc/staff_sync', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const c = route.request().postDataJSON() as { p_table: string; p_since: string | null };
    if (c.p_table === 'queue_entries') clock.push(c);
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ now: '2099-03-05T12:00:00+00:00', rows: [], deleted: [] }) });
  });
  const pages: string[] = [];
  const row = (i: number) => ({ id: 'q' + String(i).padStart(4, '0'), session_id: SID, session_day: 'Friday', session_date: SID, queue_num: i + 1, name: 'R' + i,
    status: 'waiting', paid: false, price: 30, registered_at: '2099-01-01T10:00:00Z', type_preference: 'Road', updated_at: '2099-03-01T10:00:00+00:00' });
  await page.route(/\/rest\/v1\/queue_entries\?.*order=id\.asc/, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const u = decodeURIComponent(route.request().url());
    pages.push(u);
    const after = /id=gt\.(q\d+)/.exec(u);
    const body = after ? [1000, 1001, 1002].map(row) : Array.from({ length: 1000 }, (_, i) => row(i));
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  await page.evaluate(`(async()=>{S._staffAuthed=true;await loadData();})()`);
  expect(clock[0].p_since).toBe('2999-12-31T00:00:00Z'); // the clock alone, no year in one document
  expect(pages).toHaveLength(2);
  expect(pages[1]).toContain('id=gt.q0999');
  expect(await page.evaluate(`getQueue().length`)).toBe(1003);
});

test('@staff the sales column checks are asked once, then remembered on the device', async ({ page }) => {
  let n = 0;
  page.on('request', (r) => { if (/\/rest\/v1\/cashier_sales\?select=(customer_id|sold_by_name)&limit=1/.test(r.url())) n++; });
  await boot(page);
  await expect.poll(() => n).toBe(2);
  await page.reload();
  await waitForSb(page);
  await page.waitForTimeout(500);
  expect(n).toBe(2);
});
