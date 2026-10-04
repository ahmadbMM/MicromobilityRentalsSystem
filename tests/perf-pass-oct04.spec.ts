import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The 2026-10-04 performance pass changed HOW several screens work their numbers out, never WHAT
// they show: Analytics is built once per state of its data and draws only the sub-view on show,
// the sale lines are indexed per paint, the roster sorts on keys worked out once, the searches
// repaint when typing pauses, a burst of background repaints of a heavy tab is one repaint, and
// the delta sync keeps the bookings that did not change and stores its copy per row.
// These cases pin the behaviour down.

const ksaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@staff:perf Analytics built once, the view on show drawn', () => {
  const past = addDays(ksaToday(), -10), past2 = addDays(ksaToday(), -3);
  const sessions = [
    { id: 's1', day: 'Friday', session_date: past, capacity: 10, status: 'closed' },
    { id: 's2', day: 'Monday', session_date: past2, capacity: 10, status: 'closed' },
  ];
  const rows = [
    { id: 'r1', session_id: 's1', customer_id: 'c1', name: 'Ann', price: 100, paid: true, purchases: JSON.stringify([{ name: 'Water', cat: 'Drinks', qty: 2, price: 5, pay: 'paid' }]) },
    { id: 'r2', session_id: 's1', customer_id: 'c2', name: 'Bo', price: 100, paid: false },
    { id: 'r3', session_id: 's2', customer_id: 'c1', name: 'Ann', price: 80, paid: true },
    { id: 'r4', session_id: 's2', customer_id: 'c3', name: 'Cy', price: 80, paid: true, status: 'noshow' },
  ];
  const cashSales = [
    { id: 'x1', session_id: 's1', name: 'Gel', category: 'Drinks', qty: 1, price: 15, pay: 'paid', receipt_id: 'rc1' },
    { id: 'x2', session_id: 's2', name: 'Water', category: 'Drinks', qty: 3, price: 5, pay: 'paid', receipt_id: 'rc2' },
    { id: 'x3', session_id: 's2', name: 'Gel', category: 'Drinks', qty: 1, price: 15, pay: 'refunded', receipt_id: 'rc3' },
  ];
  async function render(page: Page) {
    await page.evaluate(async (d) => {
      // @ts-expect-error app globals
      S.sessions = d.sessions; S.cashSales = d.cashSales; S.queue = d.rows.map((r) => entryFromDB({ session_day: 'Friday', status: 'done', type_preference: 'Road', registered_at: '2026-01-01T10:00:00Z', ...r }));
      // @ts-expect-error app globals
      S.analyticsRange = 'all'; S.anSession = 'all'; S.anView = 'revenue'; setStaffTab('analytics'); await renderAnalytics();
    }, { sessions, rows, cashSales });
    await expect(page.locator('#tab-analytics .an-nav-btn.active')).toHaveAttribute('data-anview', 'revenue');
  }

  test('the numbers are the same as summed by hand, and a repaint with nothing moved rebuilds nothing', async ({ page }) => {
    await boot(page);
    await render(page);
    const tab = page.locator('#tab-analytics');
    // Paid fares 100 + 80 + 80 (the paid no-show's money is in the drawer) = 260; 100 still owed.
    const digest = await page.evaluate(`S._anDigestText`) as string;
    expect(digest).toContain('SAR 260');
    expect(digest).toContain('+SAR 100');
    // Top sellers: Water 2 at the desk + 3 at the till = 5 units; Gel 1 (the refunded one is out).
    const seller = tab.locator('.analytics-bar-label.an-minw120');
    await expect(seller).toHaveText(['Water', 'Gel']);
    await expect(tab.locator('.analytics-bar-value').filter({ hasText: 'SAR 25' }).first()).toBeVisible();
    // Nothing moved: the page standing is the page drawn before.
    await page.evaluate(`document.querySelector('#tab-analytics').firstElementChild.dataset.witness='1'`);
    await page.evaluate(`renderAnalytics()`);
    expect(await page.evaluate(`document.querySelector('#tab-analytics').firstElementChild.dataset.witness||''`)).toBe('1');
    // A booking edited in place (a desk action paints before the reload) is a change.
    await page.evaluate(`getQueue().find(e=>e.id==='r2').paid=true;renderAnalytics()`);
    expect(await page.evaluate(`document.querySelector('#tab-analytics').firstElementChild.dataset.witness||''`)).toBe('');
    expect(await page.evaluate(`S._anDigestText`)).toContain('SAR 360');
  });

  test('only the sub-view on show is in the page; the others are drawn when picked, and keep their anchors', async ({ page }) => {
    await boot(page);
    await render(page);
    const tab = page.locator('#tab-analytics');
    for (const v of ['overview', 'revenue', 'ridership', 'operations', 'fleet', 'ratings', 'customers', 'growth'])
      await expect(tab.locator(`:scope > .an-anchor[data-anview="${v}"]`).first()).toBeAttached();
    // Growth is computed only when it is picked.
    await expect(tab.getByText('Retention curve')).toHaveCount(0);
    const before = await page.evaluate(`document.querySelectorAll('#tab-analytics *').length`) as number;
    await page.evaluate(`setAnView('growth')`);
    await expect(tab.locator('.an-nav-btn.active')).toHaveAttribute('data-anview', 'growth');
    expect(await page.evaluate(`document.querySelectorAll('#tab-analytics *').length`) as number).toBeGreaterThan(before);
    // Back to Revenue: what was drawn stays, hidden; the Revenue cards show again.
    await page.evaluate(`setAnView('revenue')`);
    await expect(tab.locator('.analytics-bar-label.an-minw120').first()).toBeVisible();
    // A change of range builds the page again, with the view kept.
    await page.evaluate(`setAnRange('year')`);
    await expect(tab.locator('.an-nav-btn.active')).toHaveAttribute('data-anview', 'revenue');
  });
});

test.describe('@staff:perf the roster sorts and the searches', () => {
  const d = ksaToday();
  const sat = { id: 'sat', day: 'Saturday', session_date: d, capacity: 20, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', needs_approval: true, start_time: '00:00', end_time: '23:59' };
  const jcc = { id: 'jcc', day: 'Friday', session_date: d, capacity: 20, status: 'open', created_at: 2, start_time: '00:00', end_time: '23:59' };
  const q = (id: string, sid: string, qn: number, name: string, phone: string, cust: string | null, extra: Record<string, unknown> = {}) => ({
    id, session_id: sid, session_day: 'Friday', session_date: d, queue_num: qn, name, phone, customer_id: cust, status: 'waiting',
    paid: false, price: 30, type_preference: 'Road', registered_at: `2099-01-01T10:0${qn}:00Z`, ...extra });
  const queue = [
    q('a', 'jcc', 1, 'zed Rider', '0500000003', 'c1'), q('b', 'jcc', 2, 'Ánna Rider', '', 'c2'), q('c', 'jcc', 3, 'bob Rider', '0500000001', null),
    q('s1', 'sat', 1, 'Member One', '0500000011', 'm1', { approval: 'approved' }), q('s2', 'sat', 2, 'Guest Two', '0500000012', 'g2', { approval: 'approved' }),
    q('s3', 'sat', 3, 'Member Three', '0500000013', 'm3', { approval: 'approved' }),
  ];
  const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#00e585', locked: true }];
  const customer_tags = [
    { customer_id: 'm1', tag_id: 'tag_saturday', added_at: 1, expires_at: null, starts_at: null },
    { customer_id: 'm3', tag_id: 'tag_saturday', added_at: 1, expires_at: null, starts_at: null },
  ];
  const customers = [{ id: 'c2', name: 'Ánna Rider', phone: '0500000002', email: 'a@x.test', created_at: '2099-01-01' }];
  const order = (page: Page) => page.evaluate(`S._qOrder.join()`);

  test('name, phone and member sorts keep the order they always had', async ({ page }) => {
    await boot(page, { sessions: [sat, jcc], queue_entries: queue, tags, customer_tags, customers });
    await page.evaluate(`(()=>{S.customers=${JSON.stringify(customers)};S.tags=${JSON.stringify(tags)};S.customerTags=${JSON.stringify(customer_tags)};setStaffTab('queue');S.queueView='bookings';S.sfSession='jcc';S.sfStatus='all';S.sfSortDir=1;S.sfSort='name';renderStaffQueue();})()`);
    // Locale order, as localeCompare gives it: case and accents do not split the names.
    expect(await order(page)).toBe('b,c,a');
    // A booking without a phone sorts by its account's phone.
    await page.evaluate(`S.sfSort='phone';renderStaffQueue()`);
    expect(await order(page)).toBe('c,b,a');
    await page.evaluate(`S.sfSortDir=-1;renderStaffQueue()`);
    expect(await order(page)).toBe('a,b,c');
    // On the approval ride, members after guests going up, before them going down.
    await page.evaluate(`S.sfSession='sat';S.sfSort='member';S.sfSortDir=1;renderStaffQueue()`);
    expect(await order(page)).toBe('s2,s1,s3');
    await page.evaluate(`S.sfSortDir=-1;renderStaffQueue()`);
    expect((await order(page) as string).split(',').slice(0, 2).sort().join()).toBe('s1,s3');
    // The member filter reads the same tag rows.
    await page.evaluate(`S.sfMember='yes';renderStaffQueue()`);
    expect((await order(page) as string).split(',').sort().join()).toBe('s1,s3');
  });

  test('the Riders search repaints once typing pauses, finds the same rows, and keeps parties whole', async ({ page }) => {
    await boot(page, { sessions: [jcc], queue_entries: [] });
    const riders = [
      { id: 'r1', session_id: 'jcc', booking_no: 'P-001', party_no: 1, badge: 'B1', name: 'Emp One', phone: '0555000001', company: 'Petromin', type_preference: 'Road', height: 170 },
      { id: 'r2', session_id: 'jcc', booking_no: 'P-001', party_no: 2, badge: 'B1', name: 'Kid One', phone: '', company: 'Petromin', type_preference: 'Road', height: 120 },
      { id: 'r3', session_id: 'jcc', booking_no: 'P-002', party_no: 1, badge: 'B2', name: 'Emp Two', phone: '0555000002', company: 'Petrolube', type_preference: 'Road', height: 175 },
    ];
    await page.evaluate(`(()=>{S.riders=${JSON.stringify(riders)};S.ridersLoaded=true;setStaffTab('queue');S.queueView='petromin';S.ridersSession='all';S.ridersSearch='';renderStaffQueue();})()`);
    const rowsSel = '#riders-results tbody tr';
    await expect(page.locator(rowsSel)).toHaveCount(2); // P-001 folded, P-002
    await page.evaluate(`setRidersSearch('one')`);
    expect(await page.evaluate(`S.ridersSearch`)).toBe('one');
    await expect(page.locator(rowsSel)).toHaveCount(2); // a search opens the party: both of P-001
    await expect(page.locator('#riders-results')).toContainText('1 of 2');
    await expect(page.locator('#riders-results')).toContainText('2 of 2');
    await page.evaluate(`setRidersSearch('two')`);
    await expect(page.locator(rowsSel)).toHaveCount(1);
    await expect(page.locator('#riders-results')).toContainText('Emp Two');
  });
});

test.describe('@staff:perf background repaints', () => {
  test('a heavy tab takes a burst of background repaints as one, and the last one lands', async ({ page }) => {
    await boot(page, { queue_entries: [], sessions: [] });
    await page.evaluate(`setStaffTab('history')`);
    await page.locator('#tab-history .page-title').first().waitFor();
    const witness = () => page.evaluate(`document.querySelector('#tab-history').firstElementChild.dataset.witness||''`);
    await page.evaluate(`_bgAt.history=0;_bgRenderStaffTab()`); // nothing painted lately: it paints at once
    await page.evaluate(`document.querySelector('#tab-history').firstElementChild.dataset.witness='1'`);
    await page.evaluate(`_bgRenderStaffTab();_bgRenderStaffTab()`); // two more inside the 2.5 s: held back
    expect(await witness()).toBe('1');
    await expect.poll(witness, { timeout: 8000 }).toBe(''); // and then painted, once
  });
});

// ── The delta sync ────────────────────────────────────────────────────────────────────────────
const SID = '2099-03-06';
const syncSessions = [{ id: SID, day: 'Friday', session_date: SID, capacity: 12, status: 'open', created_at: 1 }];
const row = (id: string, qn: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: SID, session_day: 'Friday', session_date: SID, queue_num: qn, name, phone: '', email: '', customer_id: null,
  group_id: null, status: 'waiting', paid: false, price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z',
  type_preference: 'Road', size: 'M', purchases: null, addons: null, updated_at: '2099-03-01T10:00:00+00:00', ...extra,
});
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const T1 = '2099-03-05T12:00:00+00:00', T2 = '2099-03-05T12:10:00+00:00';
const empty = (now: string) => ({ now, rows: [], deleted: [] });
async function syncBoot(page: Page, answer: (table: string, n: number) => unknown) {
  await stubSupabase(page, { sessions: syncSessions, queue_entries: [] });
  const n: Record<string, number> = {};
  await page.route('**/rest/v1/rpc/staff_sync', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const c = route.request().postDataJSON() as { p_table: string };
    n[c.p_table] = (n[c.p_table] || 0) + 1;
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(answer(c.p_table, n[c.p_table])) });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
const syncLoad = (page: Page) => page.evaluate(`(async()=>{S._staffAuthed=true;await loadData();})()`);

test.describe('@staff:perf the delta sync keeps what did not change', () => {
  test('a booking the answer did not bring keeps its entry; a changed one, or one edited here, is built again', async ({ page }) => {
    await syncBoot(page, (t, n) => {
      if (t !== 'queue_entries') return empty(T1);
      if (n === 1) return { now: T1, rows: [row('e1', 1, 'Ann'), row('e2', 2, 'Bo'), row('e3', 3, 'Cy')], deleted: [] };
      return { now: T2, rows: [row('e2', 2, 'Bo', { status: 'active', updated_at: '2099-03-05T12:08:00+00:00' })], deleted: [] };
    });
    await syncLoad(page);
    await page.evaluate(`(()=>{window.__e1=getQueue().find(e=>e.id==='e1');window.__e2=getQueue().find(e=>e.id==='e2');window.__e3=getQueue().find(e=>e.id==='e3');window.__arr=S.queue;
      window.__e3.status='active';})()`); // a desk action painted e3 before its write came back
    await syncLoad(page);
    const out = await page.evaluate(`(()=>{const g=id=>getQueue().find(e=>e.id===id);return{same1:g('e1')===window.__e1,same2:g('e2')===window.__e2,st2:g('e2').status,same3:g('e3')===window.__e3,st3:g('e3').status,newArr:S.queue!==window.__arr};})()`);
    expect(out).toEqual({ same1: true, same2: false, st2: 'active', same3: false, st3: 'waiting', newArr: true });
  });

  test('the copy is kept one record per row, and the first layout\'s copy is read whole once and deleted', async ({ page }) => {
    test.setTimeout(60000);
    await syncBoot(page, (t, n) => {
      if (t !== 'queue_entries') return empty(T1);
      if (n === 1) return { now: T1, rows: [row('e1', 1, 'Ann'), row('e2', 2, 'Bo')], deleted: [] };
      return n === 2 ? { now: T2, rows: [row('e1', 1, 'Ann'), row('e2', 2, 'Bo')], deleted: [] } : empty(T2);
    });
    await syncLoad(page);
    const stored = () => page.evaluate(`new Promise(res=>{const rq=indexedDB.open('mm-sync-2');rq.onsuccess=()=>{const db=rq.result;if(!db.objectStoreNames.contains('q')){db.close();return res(-1);}const c=db.transaction('q').objectStore('q').count();c.onsuccess=()=>{db.close();res(c.result);};};})`);
    await expect.poll(stored, { timeout: 10000 }).toBe(2); // written 1.5 s after the change, one record per row

    // A device that still holds the first layout ('mm-sync', the whole list in one record): its
    // copy is not used, the list is read whole once, and the old database (riders' details) goes.
    await page.evaluate(`(async()=>{await _syncDrop();await new Promise(res=>{const rq=indexedDB.open('mm-sync',1);rq.onupgradeneeded=()=>rq.result.createObjectStore('sets');
      rq.onsuccess=()=>{const db=rq.result;const tx=db.transaction('sets','readwrite');tx.objectStore('sets').put({v:SYNC_V,url:SUPABASE_URL,wm:'${T1}',fullAt:Date.now(),rows:[${JSON.stringify(row('old1', 1, 'Old Ann'))}]},'q');tx.oncomplete=()=>{db.close();res();};};});})()`);
    const calls: { p_since: string | null }[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/staff_sync') && r.method() === 'POST') { const b = r.postDataJSON(); if (b.p_table === 'queue_entries') calls.push(b); } });
    await page.reload();
    await waitForSb(page);
    await syncLoad(page);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1].p_since).toBeNull();
    expect(await page.evaluate(`getQueue().map(e=>e.id).sort().join()`)).toBe('e1,e2');
    await expect.poll(stored, { timeout: 10000 }).toBe(2);
    await expect.poll(() => page.evaluate(`indexedDB.databases().then(l=>l.some(d=>d.name==='mm-sync'))`), { timeout: 10000 }).toBe(false);
  });
});
