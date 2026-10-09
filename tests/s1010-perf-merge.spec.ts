import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, staffReady, waitForSb } from './helpers/supabase';

// The 2026-10-09 performance round (P1-P4, P8, P10, P12, P14 of the staff deep research): realtime rows
// merged instead of reloaded (till sales, registrations), the light and full reloads reading less, the
// section lists by count, the booking entries kept when unchanged, the dialog watcher scoped, the token
// renewed only near expiry, and the boot snapshot leaving the bookings to IndexedDB.

const DAY = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); // tomorrow: a live ride
const fixtures = () => ({
  sessions: [{ id: DAY, session_date: DAY, day: 'Saturday', status: 'open', capacity: 20, created_at: 1 }],
  queue_entries: [
    { id: 'q1', session_id: DAY, session_day: 'Saturday', session_date: DAY, queue_num: 1, name: 'Lina Haddad', phone: '0550000001', type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: DAY + 'T10:00:00Z' },
    { id: 'q2', session_id: DAY, session_day: 'Saturday', session_date: DAY, queue_num: 2, name: 'Omar Saleh', phone: '0550000002', type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: DAY + 'T10:01:00Z' },
  ],
  cashier_sales: [{ id: 's1', session_id: DAY, name: 'Water', category: 'drinks', qty: 1, price: 5, pay: 'cash', created_at: DAY + 'T18:00:00Z', receipt_id: 'r1' }],
});

async function boot(page: Page, init: Record<string, string> = {}) {
  await stubSupabase(page, fixtures());
  await page.addInitScript((kv) => {
    localStorage.setItem('cq_staff', '1');
    localStorage.setItem('cq_op_name', 'Spec Staff');
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, init);
  await page.goto('/bookings');
  await staffReady(page);
  await waitForSb(page);
}
/** REST reads of `table` from now on. */
function reads(page: Page, table: string) {
  const urls: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) urls.push(decodeURIComponent(r.url())); });
  return urls;
}

test.describe('@staff:perf realtime merges and lighter reloads (2026-10-09)', () => {
  test('a till sale from another device is merged from its event: no reload of the sessions or the sales', async ({ page }) => {
    await boot(page);
    const sales = reads(page, 'cashier_sales'), ses = reads(page, 'sessions');
    await page.evaluate(`window.__noWiden=false`); // a real device: events merge (the suite pins state otherwise)
    const row = { id: 's2', session_id: DAY, name: 'Juice', category: 'drinks', qty: 2, price: 8, pay: 'card', created_at: DAY + 'T18:05:00Z', receipt_id: 'r2' };
    await page.evaluate((r) => _onRt({ table: 'cashier_sales', eventType: 'INSERT', new: r, old: {}, errors: null }), row);
    expect(await page.evaluate(`S.cashSales.map(r=>r.id).sort().join()`)).toBe('s1,s2');
    // voided elsewhere: it leaves the list, as a read leaves it out
    await page.evaluate((r) => _onRt({ table: 'cashier_sales', eventType: 'UPDATE', new: { ...r, voided_at: new Date().toISOString() }, old: {}, errors: null }), row);
    expect(await page.evaluate(`S.cashSales.map(r=>r.id).join()`)).toBe('s1');
    await page.evaluate(`_onRt({table:'cashier_sales',eventType:'DELETE',new:{},old:{id:'s1'},errors:null})`);
    expect(await page.evaluate(`S.cashSales.length`)).toBe(0);
    await page.waitForTimeout(700); // past the 350 ms reload debounce the old path took
    expect(sales).toEqual([]);
    expect(ses).toEqual([]);
  });

  test('a registration\'s event is merged by id, and ignored where the list was never loaded', async ({ page }) => {
    await boot(page);
    const regs = reads(page, 'rider_registrations');
    await page.evaluate(`S.ridersLoaded=false;S.riders=[]`);
    await page.evaluate(`_onRidersRt({table:'rider_registrations',eventType:'INSERT',new:{id:'r9',name:'Sara Ali'},old:{},errors:null})`);
    expect(await page.evaluate(`S.riders.length`)).toBe(0);
    await page.evaluate(`S.ridersLoaded=true;S.riders=[{id:'r1',name:'Old Name'}]`);
    await page.evaluate(`_onRidersRt({table:'rider_registrations',eventType:'UPDATE',new:{id:'r1',name:'New Name'},old:{},errors:null})`);
    await page.evaluate(`_onRidersRt({table:'rider_registrations',eventType:'INSERT',new:{id:'r2',name:'Sara Ali'},old:{},errors:null})`);
    expect(await page.evaluate(`S.riders.map(r=>r.id+':'+r.name).join()`)).toBe('r2:Sara Ali,r1:New Name');
    await page.evaluate(`_onRidersRt({table:'rider_registrations',eventType:'DELETE',new:{},old:{id:'r2'},errors:null})`);
    expect(await page.evaluate(`S.riders.map(r=>r.id).join()`)).toBe('r1');
    await page.waitForTimeout(700);
    expect(regs).toEqual([]);
  });

  test('a booking\'s row is laid in through the index, and a sync keeps the entries that did not move', async ({ page }) => {
    await boot(page);
    const same = await page.evaluate(`(()=>{
      const before=S.queue,q1=_qGet('q1');
      _rtMergeRow({table:'queue_entries',eventType:'UPDATE',new:{...${JSON.stringify(fixtures().queue_entries[1])},status:'active'},old:{},errors:null});
      return {newArray:S.queue!==before,len:S.queue.length,q2:_qGet('q2').status,q1Kept:_qGet('q1')===q1};
    })()`);
    expect(same).toEqual({ newArray: true, len: 2, q2: 'active', q1Kept: true });
    // _qEntries on a synced answer: the row that did not change keeps its entry object, the changed one is rebuilt
    const kept = await page.evaluate(`(()=>{
      const rows=${JSON.stringify(fixtures().queue_entries)};
      S.queue=_qEntries({data:rows,error:null,whole:true,changed:null});
      const a=_qGet('q1'),b=_qGet('q2');
      const rows2=[rows[0],{...rows[1],status:'noshow'}];
      const next=_qEntries({data:rows2,error:null,whole:true,changed:new Set(['q2'])});
      return {q1:next[0]===a,q2:next[1]!==b&&next[1].status==='noshow'};
    })()`);
    expect(kept).toEqual({ q1: true, q2: true });
    const edited = await page.evaluate(`(()=>{
      const rows=${JSON.stringify(fixtures().queue_entries)};
      S.queue=_qEntries({data:rows,error:null,whole:true,changed:null});
      const a=_qGet('q1');S.queue=_qEntries({data:rows,error:null,whole:true,changed:new Set()});
      const kept=_qGet('q1')===a; a.status='active'; // a change made on this device, not yet on the server
      S.queue=_qEntries({data:rows,error:null,whole:true,changed:new Set()});
      return {kept,rebuilt:_qGet('q1')!==a&&_qGet('q1').status==='waiting'};
    })()`);
    expect(edited).toEqual({ kept: true, rebuilt: true });
  });

  test('once the window is held, the light reload asks for recent nights and the live desk list; the full one for two months of sales', async ({ page }) => {
    await boot(page);
    const ses = reads(page, 'sessions'), dw = reads(page, 'desk_waitlist'), cs = reads(page, 'cashier_sales');
    await page.evaluate(`S._fullWindow=true;S.sessions=[{id:'old',session_date:'2020-01-01',status:'closed'},...S.sessions]`);
    await page.evaluate(`loadDataLight()`);
    expect(ses.length).toBe(1);
    expect(ses[0]).toMatch(/session_date=gte\.\d{4}-\d{2}-\d{2}/);
    expect(dw[0]).toMatch(/or=\(status\.eq\.waiting,created_at\.gte\.[^,]+,resolved_at\.gte\./); // _wlLightFetch (B9)
    // a night before the cut is kept as held
    expect(await page.evaluate(`S.sessions.some(s=>s.id==='old')&&S.sessions.some(s=>s.id===${JSON.stringify(DAY)})`)).toBe(true);
    // the full load: the year once, then two months laid over it
    cs.length = 0;
    await page.evaluate(`_csWholeAt=Date.now();S.cashSales=[{id:'ancient',created_at:'2020-01-01T00:00:00Z',price:1,qty:1}]`);
    await page.evaluate(`_optionalFetch()`);
    expect(cs.length).toBe(1);
    expect(cs[0]).toContain('select=id,session_id,');
    const cut = await page.evaluate(`_qWindowCut(QUEUE_BOOT_DAYS)`);
    expect(cs[0]).toContain(`created_at=gte.${cut}`);
    expect(await page.evaluate(`S.cashSales.map(r=>r.id).sort().join()`)).toBe('ancient,s1');
  });

  test('the section lists are checked only for the sections this account opens', async ({ page }) => {
    await boot(page, { cq_role: 'frontdesk' });
    const sm = reads(page, 'site_messages'), amb = reads(page, 'ambassadors'), vb = reads(page, 'vendor_bookings');
    await page.evaluate(`S._staffAuthed=true;_secPolls(true);_secPolls(false)`);
    await page.waitForTimeout(300);
    expect([...sm, ...amb, ...vb]).toEqual([]);
  });

  test('the staff token is renewed only near its expiry', async ({ page }) => {
    await boot(page);
    const n = await page.evaluate(`(async()=>{
      window.__noWiden=false;S._staffAuthed=true;let calls=0;
      sb.auth.refreshSession=async()=>{calls++;return{data:{},error:null};};
      sb.auth.getSession=async()=>({data:{session:{expires_at:Math.floor(Date.now()/1000)+3600}},error:null});
      await _staffKeepAlive();const far=calls;
      sb.auth.getSession=async()=>({data:{session:{expires_at:Math.floor(Date.now()/1000)+300}},error:null});
      await _staffKeepAlive();
      window.__noWiden=true;return [far,calls];
    })()`);
    expect(n).toEqual([0, 1]);
  });

  test('the dialog watcher runs for a dialog, not for a roster repaint', async ({ page }) => {
    await boot(page);
    await page.evaluate(`window.__mfN=0;const f=_syncModalFocus;window._syncModalFocus=function(){window.__mfN++;return f.apply(this,arguments);}`);
    await page.evaluate(`(()=>{const d=document.createElement('div');d.textContent='x';document.getElementById('view-staff').appendChild(d);})()`);
    await page.waitForTimeout(200);
    expect(await page.evaluate('window.__mfN')).toBe(0);
    await page.evaluate(`(()=>{const d=document.createElement('div');d.className='modal-backdrop';d.id='zz-m';document.body.appendChild(d);})()`);
    await expect.poll(() => page.evaluate('window.__mfN')).toBeGreaterThan(0);
    await page.evaluate(`document.getElementById('zz-m').remove()`);
  });

  test('a syncing device\'s boot snapshot leaves the bookings to IndexedDB and paints them from there', async ({ page }) => {
    await boot(page);
    const snap = await page.evaluate(`(()=>{_sync.q={rows:new Map([['q1',{}]])};_syncOff=false;_cacheFp=null;_cacheSave();const s=JSON.parse(localStorage.getItem('cq_snapshot'));delete _sync.q;return {qIdb:s.qIdb,hasQ:'q' in s};})()`);
    expect(snap).toEqual({ qIdb: 1, hasQ: false });
    const restored = await page.evaluate(`(async()=>{
      window._snapQueue=async()=>[entryFromDB(${JSON.stringify(fixtures().queue_entries[0])})];
      S.dataLoaded=false;S.queue=[];await _cacheRestore(()=>true);
      return S.queue.map(e=>e.id).join()+'|'+S._cacheOnly;
    })()`);
    expect(restored).toBe('q1|true');
  });
});

declare function _onRt(p: unknown): void;
