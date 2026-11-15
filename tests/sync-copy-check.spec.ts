import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A staff device's copy of the riders that is short of the server is read whole again (2026-11-10). A staff iPhone
// held 105 of the 4,487 riders as if that were all of them, and Accounts said 105: a whole read lands page by page,
// a page IndexedDB did not take left the store without it, and a later save of a few changed rows wrote the clock that
// called the copy whole. What must hold: a copy read off the disk is counted against the server once, and a short one
// is thrown away and read whole behind the screen; a whole copy is not read again; and a page the store refused is
// written again with the whole copy, so the disk never holds less than the device showed.
// 2026-11-15, the second time (a staff device showed 379 of 4,583 accounts, the user: "make sure this error doesn't
// occur again because this is not the first time"): a copy on the disk that never finished a whole read is no copy; a
// save queued before a whole read began does not write the clock over the part-read store; and the count is taken
// again every ten minutes and at Sync now, so a copy that goes short in a page's life is found and read whole.
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

const meta = (page: Page) => disk(page).then((d) => d && d.meta) as Promise<{ fill?: unknown; fullAt?: number; wm?: string } | null>;

test('@staff a copy on the disk that never finished a whole read is read whole, whatever the count says', async ({ page }) => {
  const srv = await open(page);
  await syncLoad(page);
  await whole(page).toBe(N);
  // Five rows left and a meta with the clock but neither the fill nor the time of a whole read: what a save that ran
  // during a whole read left on the device.
  await page.evaluate(`new Promise(res=>{const rq=indexedDB.open('mm-sync-2');rq.onsuccess=()=>{const db=rq.result;const tx=db.transaction(['meta','c'],'readwrite');const m=tx.objectStore('meta'),s=tx.objectStore('c');${JSON.stringify(riders.slice(5).map((r) => r.id))}.forEach(k=>s.delete(k));const g=m.get('c');g.onsuccess=()=>{const v={...g.result};delete v.fullAt;delete v.fill;m.put(v,'c');};tx.oncomplete=()=>{db.close();res(true);};};})`);
  await page.reload();
  // the count agrees with the five (so only the rule on the meta can catch it)
  await page.route(/\/rest\/v1\/customers\?/, (route: Route) => route.request().method() === 'HEAD'
    ? route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json', 'content-range': '*/5' }, body: '' })
    : route.fallback());
  await waitForSb(page);
  await syncLoad(page);
  await expect.poll(() => held(page), { timeout: 15000 }).toBe(N);
  expect(srv.wholeReads()).toBe(2);
  await whole(page).toBe(N);
});

test('@staff a save queued before a whole read begins does not call the part-read copy whole', async ({ page }) => {
  await open(page);
  await syncLoad(page);
  await whole(page).toBe(N);
  const before = await meta(page);
  expect(before && before.fullAt).toBeTruthy();
  // A sync answer queues a save; before it fires, a whole read begins (its first pages in, the rest to come).
  await page.evaluate(`(()=>{const st=_sync.c;_syncSave('c');_sync.c={...st,rows:new Map([...st.rows].slice(0,5)),list:null,fill:{wm:st.wm,after:'c004',at:Date.now()},fullAt:0,all:false,dirty:new Set(),gone:new Set()};})()`);
  await page.waitForTimeout(2200); // past the save's 1.5 s
  const after = await meta(page);
  expect(after && after.fullAt).toBe(before && before.fullAt); // the whole copy's meta stands: no clock without the fill over it
});

test('@staff a copy that goes short in the page\'s life is found at the ten-minute count and at Sync now', async ({ page }) => {
  const srv = await open(page);
  await syncLoad(page);
  expect(await held(page)).toBe(N);
  const h0 = srv.heads.length;
  const shorten = `(()=>{const st=_sync.c;[...st.rows.keys()].slice(5).forEach(k=>st.rows.delete(k));st.list=null;})()`;
  // within ten minutes of the whole read: not counted
  await page.evaluate(shorten);
  await page.evaluate(`(async()=>{refDirty();await _refFetch();})()`);
  expect(await held(page)).toBe(5);
  expect(srv.heads.length).toBe(h0);
  // ten minutes on: counted, found short, read whole
  await page.evaluate(`(async()=>{_syncCheckAt.c=Date.now()-11*60*1000;refDirty();await _refFetch();})()`);
  await expect.poll(() => held(page), { timeout: 15000 }).toBe(N);
  expect(srv.heads.length).toBe(h0 + 1);
  expect(srv.wholeReads()).toBe(2);
  // short again: Sync now counts it at once, even inside the half hour after the last fix
  await page.evaluate(shorten);
  await page.evaluate(`(async()=>{refDirty();await _refFetch();})()`);
  expect(await held(page)).toBe(5);
  await page.evaluate(`_syncNow()`);
  await expect.poll(() => held(page), { timeout: 15000 }).toBe(N);
  expect(srv.wholeReads()).toBe(3);
  await whole(page).toBe(N);
});
