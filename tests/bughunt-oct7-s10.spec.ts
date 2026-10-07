import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07 (desk actions, reports): a party's no-show undone onto a night that filled
// meanwhile, a re-opened ride's check-out stamp, the waitlist status in exports, and the breakfast
// report's venue in the reader's language. Invented riders only.

type Row = Record<string, unknown>;

function matches(row: Row, params: URLSearchParams) {
  for (const [k, v] of params) {
    const m = v.match(/^(eq|neq|in|is)\.(.*)$/);
    if (!m || ['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const val = row[k];
    const s = val == null ? 'null' : String(val);
    if (m[1] === 'eq' && s !== m[2]) return false;
    if (m[1] === 'neq' && s === m[2]) return false;
    if (m[1] === 'is' && !(m[2] === 'null' ? val == null : s === m[2])) return false;
    if (m[1] === 'in' && !m[2].replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')).includes(s)) return false;
  }
  return true;
}

/** queue_entries and bikes held in memory: GET returns them, PATCH applies to the rows its filters match. */
async function statefulTables(page: Page, tables: Record<string, Row[]>) {
  const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  await page.route(/\/rest\/v1\/(queue_entries|bikes)(\?|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const table = url.pathname.split('/').pop() as string;
    const rows = tables[table];
    if (!rows || req.method() === 'OPTIONS') return route.fallback();
    if (req.method() === 'GET' || req.method() === 'HEAD') {
      return route.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${rows.length}/${rows.length}` }, body: JSON.stringify(rows) });
    }
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Row;
      const hit = rows.filter((r) => matches(r, url.searchParams));
      hit.forEach((r) => Object.assign(r, body));
      return route.fulfill({ status: 200, headers: head, body: JSON.stringify(hit) });
    }
    return route.fallback();
  });
}

const SID = '2099-04-04';
const sessions = [{ id: SID, session_date: SID, day: 'Saturday', status: 'open', capacity: 2, created_at: 1 }];
let n = 0;
const row = (id: string, status: string, x: Row = {}): Row => ({
  id, session_id: SID, session_day: 'Saturday', session_date: SID, queue_num: ++n, name: 'Rider ' + id, phone: '',
  type_preference: 'Road', size: 'M', status, paid: false, price: 75, registered_at: `2099-01-01T10:0${n % 10}:00Z`, ...x,
});
const bike = (id: string, status: string): Row => ({ id, name: 'Bike ' + id, type: 'Road', size: 'M', status, colors: [], color_names: [] });

async function boot(page: Page, q: Row[], bikes: Row[] = []) {
  await stubSupabase(page, { sessions });
  await statefulTables(page, { queue_entries: q, bikes });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
}
const undoTop = async (page: Page) => {
  await page.waitForFunction('S.undoStack.length>0');
  return page.evaluate('S.undoStack[S.undoStack.length-1].fn()');
};

test.describe('@staff:bookings bug hunt 2026-10-07 (s10)', () => {
  test('undoing a party no-show on a night that filled meanwhile seats only as many as there is room for', async ({ page }) => {
    const q = [row('A', 'waiting'), row('B', 'waiting')];
    await boot(page, q);
    await page.evaluate(`_noShowMany(['A','B'])`);
    await expect.poll(() => q.map((r) => r.status).join()).toBe('noshow,noshow');
    q.push(row('C', 'waiting'));                                  // a walk-in took one of the two places
    await page.evaluate('loadData()');
    await page.waitForFunction(`getQueue().some(e=>e.id==='C')`);
    await undoTop(page);
    expect(q[0].status).toBe('waiting');                          // the one free place
    expect(q[1].status).toBe('waitlist');                         // not a third rider on a two-place night
    expect(q[1].waitlist_num).toBeTruthy();
  });

  test('re-opening a finished ride clears its check-out stamp, and the undo puts it back', async ({ page }) => {
    const OUT = '2099-04-04T19:30:00.000Z';
    const q = [row('D', 'done', { assigned_bike_id: 'b5', paid: true, checked_in_at: '2099-04-04T18:00:00.000Z', checked_out_at: OUT })];
    const bikes = [bike('b5', 'available')];
    await boot(page, q, bikes);
    await page.evaluate(`doReopen('D')`);
    await expect.poll(() => q[0].status).toBe('active');
    expect(q[0].checked_out_at).toBeNull();                       // a rider on a bike has no "Out" time
    await undoTop(page);
    expect(q[0].status).toBe('done');
    expect(q[0].checked_out_at).toBe(OUT);
  });

  test('exports name the waitlist status in the reader\'s language', async ({ page }) => {
    await boot(page, [row('E', 'waitlist', { waitlist_num: 1 })]);
    expect(await page.evaluate(`reportStatusLabel('waitlist')`)).toBe(await page.evaluate(`t('statusWaitlist')`));
    expect(await page.evaluate(`reportStatusLabel('waitlist')`)).not.toBe('waitlist');
  });
});

test.describe('@staff:bookings breakfast report venue (s10)', () => {
  const D = new Date(Date.now() - 2 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  test('the breakfast report names the venue in the reader\'s language', async ({ page }) => {
    await stubSupabase(page, {
      sessions: [{ id: 'satx', day: 'Saturday', session_date: D, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday',
        title: 'Saturday Social Ride', breakfast_name: 'Sample Cafe', breakfast_name_ar: 'مقهى تجريبي' }],
      queue_entries: [{ id: 'x1', session_id: 'satx', session_day: 'Saturday', session_date: D, queue_num: 1, name: 'Sample Rider', phone: '',
        type_preference: 'Road', registered_at: D + 'T05:00:00Z', status: 'done', paid: true, price: 0,
        rating_detail: { form: 'social', s: { ride: 9, breakfast: 8, overall: 9 }, why: {} } }],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S.dataLoaded&&getQueue().length===1`);
    const html = await page.evaluate(`(() => {
      S.lang='ar';S.sfSession='satx';let out='';const o=window.open;
      window.open = () => ({ document: { write: (h) => { out = h; }, close() {}, querySelectorAll: () => [] }, focus() {}, print() {} });
      try{printBreakfastReport();}finally{window.open=o;}
      return out;
    })()`) as string;
    expect(html).toContain('مقهى تجريبي');
    expect(html).not.toContain('Sample Cafe');
  });
});
