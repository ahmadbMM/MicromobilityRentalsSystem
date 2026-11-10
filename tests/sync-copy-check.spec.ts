import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A staff device's copy of the riders that is short of the server is read whole again (2026-11-10). A staff iPhone
// held 105 of the 4,487 riders as if that were all of them, and Accounts said 105: a whole read lands page by page,
// a page IndexedDB did not take left the store without it, and a later save of a few changed rows wrote the clock that
// called the copy whole. What must hold: a copy read off the disk is counted against the server once, and a short one
// is thrown away and read whole behind the screen; a whole copy is not read again; and a page the store refused is
// written again with the whole copy, so the disk never holds less than the device showed.
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' };
const json = (body: unknown) => ({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const WHOLE = '2999-12-31T00:00:00Z';
const T1 = '2099-03-05T12:00:00+00:00', T2 = '2099-03-05T12:10:00+00:00';
const N = 30;
const riders = Array.from({ length: N }, (_, i) => ({ id: 'c' + String(i).padStart(3, '0'), name: 'Rider ' + String.fromCharCode(65 + (i % 26)), created_at: '2026-01-01T00:00:00Z', updated_at: T1 }));

/** staff_sync (a clock for a whole read, nothing changed otherwise), the riders' pages by key, and their count. */
async function server(page: Page) {
  const clocks: string[] = [], heads: string[] = [];
  await page.route('**/rest/v1/rpc/staff_sync', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const c = route.request().postDataJSON() as { p_table: string; p_since: string | null };
    if (c.p_since === WHOLE) clocks.push(c.p_table);
    return route.fulfill(json({ now: c.p_since === WHOLE || !c.p_since ? T1 : T2, rows: [], deleted: [] }));
  });
  await page.route(/\/rest\/v1\/customers\?/, async (route: Route) => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    if (req.method() === 'HEAD') {
      heads.push(url.search);
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json', 'content-range': `*/${N}` }, body: '' });
    }
    if (!url.searchParams.get('order')?.startsWith('id.')) return route.fallback();
    const after = (url.searchParams.get('id') || '').replace(/^gt\./, '');
    const lim = Number(url.searchParams.get('limit') || 1000);
    return route.fulfill(json(riders.filter((r) => !after || r.id > after).slice(0, lim)));
  });
  return { wholeReads: () => clocks.filter((t) => t === 'customers').length, heads };
}
async function open(page: Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [] });
  const srv = await server(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  return srv;
}
const syncLoad = (page: Page) => page.evaluate(`(async()=>{S._staffAuthed=true;await loadData();})()`);
const held = (page: Page) => page.evaluate(`(S.customers||[]).length`) as Promise<number>;
/** The riders' copy on the disk: its meta and how many rows the store holds. */
const disk = (page: Page) => page.evaluate(`new Promise(res=>{const rq=indexedDB.open('mm-sync-2');rq.onsuccess=()=>{const db=rq.result;try{const tx=db.transaction(['meta','c']);const m=tx.objectStore('meta').get('c'),n=tx.objectStore('c').count();tx.oncomplete=()=>{db.close();res({meta:m.result||null,rows:n.result});};}catch(e){db.close();res(null);}};rq.onerror=()=>res(null);})`) as Promise<{ meta: { fill?: unknown; fullAt?: number } | null; rows: number } | null>;
const whole = (page: Page) => expect.poll(async () => { const d = await disk(page); return !!d && !!d.meta && !d.meta.fill && !!d.meta.fullAt && d.rows; }, { timeout: 10000 });

test('@staff a copy of the riders short of the server is read whole again; a whole one is not', async ({ page }) => {
  const srv = await open(page);
  await syncLoad(page);
  expect(await held(page)).toBe(N);
  await whole(page).toBe(N);
  // The store loses all but five rows; its meta still calls it whole (what the iPhone held).
  await page.evaluate(`new Promise(res=>{const rq=indexedDB.open('mm-sync-2');rq.onsuccess=()=>{const db=rq.result;const tx=db.transaction('c','readwrite');const s=tx.objectStore('c');${JSON.stringify(riders.slice(5).map((r) => r.id))}.forEach(k=>s.delete(k));tx.oncomplete=()=>{db.close();res(true);};};})`);
  await page.reload();
  await waitForSb(page);
  await syncLoad(page);
  await expect.poll(() => held(page), { timeout: 15000 }).toBe(N); // counted, found short, read whole behind the screen
  expect(srv.wholeReads()).toBe(2);
  expect(srv.heads.length).toBe(1);
  await whole(page).toBe(N); // and the disk holds them all again

  await page.reload();
  await waitForSb(page);
  await syncLoad(page);
  await expect.poll(() => srv.heads.length).toBe(2); // counted once more at this copy's first answer
  await page.waitForTimeout(500);
  expect(await held(page)).toBe(N);
  expect(srv.wholeReads()).toBe(2); // whole: not read again
});

test('@staff pages the store refused are written again with the whole copy', async ({ page }) => {
  const srv = await open(page);
  // Every write of the riders' copy is refused while the whole read comes in (Safari's lost connection to the store).
  await page.evaluate(`window.__idbDo=_idbDo;window._idbDo=(mode,stores,fn)=>stores.includes('c')?Promise.resolve(null):window.__idbDo(mode,stores,fn)`);
  await syncLoad(page);
  expect(await held(page)).toBe(N);
  await page.evaluate(`window._idbDo=window.__idbDo`);
  await whole(page).toBe(N); // the save after the read writes every row, not only the rows that change later
  await page.reload();
  await waitForSb(page);
  await syncLoad(page);
  expect(await held(page)).toBe(N);
  expect(srv.wholeReads()).toBe(1); // the copy on the disk answered
});
