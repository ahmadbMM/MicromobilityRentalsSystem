import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Desk fixes from the 2026-10-03 review of the roster's actions: "Customer showed" on a full
// night, the wedge scanner's same-day rule, the PIN check when the operator list will not load,
// bulk Paid and bulk Approve counting only what landed, the reset tool's escaping, and the
// account report's "on the house" filter agreeing with its own Pay column.

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

/** queue_entries held in memory: GET returns them, PATCH applies to the rows its filters match
 *  and answers with exactly those. `refuse` answers a PATCH with an RLS error. */
async function statefulQueue(page: Page, rows: Row[], refuse?: (body: Row) => boolean) {
  const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  await page.route(/\/rest\/v1\/queue_entries(\?|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'GET' || req.method() === 'HEAD') {
      return route.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${rows.length}/${rows.length}` }, body: JSON.stringify(rows) });
    }
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Row;
      const hit = rows.filter((r) => matches(r, url.searchParams));
      if (refuse && refuse(body)) {
        return route.fulfill({ status: 403, headers: head, body: JSON.stringify({ code: '42501', message: 'new row violates row-level security policy' }) });
      }
      hit.forEach((r) => Object.assign(r, body));
      return route.fulfill({ status: 200, headers: head, body: JSON.stringify(hit) });
    }
    return route.fallback();
  });
}

const SID = '2099-03-03';
const nightSessions = [{ id: SID, session_date: SID, day: 'Tuesday', status: 'open', capacity: 2, created_at: 1 }];
let n = 0;
const row = (id: string, status: string, x: Row = {}): Row => ({
  id, session_id: SID, session_day: 'Tuesday', session_date: SID, queue_num: ++n, name: 'R ' + id, phone: '',
  type_preference: 'Road', size: 'M', status, paid: false, price: 75, registered_at: `2099-01-01T10:0${n % 10}:00Z`, ...x,
});

async function boot(page: Page, q: Row[], opts: { sessions?: Row[]; refuse?: (b: Row) => boolean; extra?: Record<string, unknown> } = {}) {
  await stubSupabase(page, { sessions: opts.sessions || nightSessions, ...(opts.extra || {}) });
  await statefulQueue(page, q, opts.refuse);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
}

test('"Customer showed" on a full night asks before over-filling it', async ({ page }) => {
  const q = [row('N', 'noshow'), row('A', 'waiting'), row('B', 'waiting')]; // two places, both held
  await boot(page, q);
  const confirm = page.locator('#confirm-modal');
  const first = page.evaluate(`doUndoNoShow('N')`);
  await expect(confirm).toContainText('Session is full');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await first;
  expect(q[0].status).toBe('noshow');                            // declined: nobody over the count

  const second = page.evaluate(`doUndoNoShow('N')`);
  await confirm.getByRole('button', { name: 'Restore' }).click();
  await second;
  expect(q[0].status).toBe('waiting');                           // staff chose to take them anyway
});

test('a wedge scan of another night\'s ticket asks before opening check-in', async ({ page }) => {
  const q = [row('T', 'waiting', { queue_num: 77 })];               // 2099: not today
  await boot(page, q);
  await page.evaluate(`S.sfSearch='77';sfSearchEnter()`);
  const confirm = page.locator('#confirm-modal');
  await expect(confirm).toContainText('not today');
  expect(await page.evaluate('S._ciId||null')).toBeNull();      // nothing opened on its own
  await confirm.getByRole('button', { name: 'Make an exception' }).click();
  await expect.poll(() => page.evaluate('S._ciId')).toBe('T');
});

test('the PIN check refuses when the operator list will not load and none is held', async ({ page }) => {
  await boot(page, [row('A', 'waiting')]);
  await page.route(/\/rest\/v1\/rpc\/staff_operator_list/, (r) => r.fulfill({
    status: 500, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout' }),
  }));
  const r = await page.evaluate(`(async()=>{
    S._opPins=undefined;const none=await _pinApprove('x');
    S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=0;const stale=await _pinApprove('x');
    return {none,stale};})()`);
  expect(r).toEqual({ none: false, stale: true });               // no list: refused; a held one still answers
});

test('the PIN check lets a database with no PINs through', async ({ page }) => {
  await boot(page, [row('A', 'waiting')], { extra: { 'rpc:staff_operator_list': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_operator_list' } } } });
  expect(await page.evaluate(`(async()=>{S._opPins=undefined;return await _pinApprove('x');})()`)).toBe(true);
});

test('bulk Paid refused part-way still logs and undoes the rows that did flip', async ({ page }) => {
  const q = [row('A', 'waiting', { price: 75 }), row('Z', 'waiting', { price: 0 })]; // Z's incidental 0 sends a price
  await boot(page, q, { refuse: (b) => 'price' in b && b.paid === true });
  await page.evaluate(`S.sfSelected=['A','Z'];bulkSfPaid()`);
  await expect.poll(() => q[0].paid).toBe(true);
  expect(q[1].paid).toBe(false);
  await page.waitForFunction('S.undoStack.length===1');
  await page.evaluate('S.undoStack[0].fn()');
  await expect.poll(() => q[0].paid).toBe(false);                // the row that flipped goes back
});

test('bulk Approve counts only the requests it approved', async ({ page }) => {
  const sat = [{ id: SID, session_date: SID, day: 'Saturday', status: 'open', capacity: 20, spots: 20, created_at: 1, event_kind: 'community', ride_kind: 'saturday', needs_approval: true, paid_ride: false }];
  const q = [row('P1', 'waiting', { approval: 'pending', price: 0 }), row('P2', 'waiting', { approval: 'pending', price: 0 })];
  await boot(page, q, { sessions: sat });
  q[1].approval = 'rejected';                                     // another till decided P2 meanwhile
  await page.evaluate(`S.sfSession='${SID}';bulkApprovePending()`);
  await page.locator('#confirm-modal').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#toast-container')).toContainText('1 request(s) approved');
  expect(q[1].approval).toBe('rejected');
});

test('the password reset tool prints a server message as text', async ({ page }) => {
  await boot(page, [row('A', 'waiting')]);
  await page.route(/\/rest\/v1\/customers\?/, (r) => r.fulfill({
    status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'XX000', message: '<img src=x id=pwn>' }),
  }));
  await page.evaluate(`S.showResetTool=true;renderStaffQueue()`);
  await page.fill('#staff-reset-email', 'someone@example.test');
  await page.fill('#staff-reset-pw', 'Abcdefg1');
  await page.evaluate('staffResetPassword()');
  await expect(page.locator('#staff-reset-result')).toContainText('<img src=x id=pwn>');
  expect(await page.locator('#pwn').count()).toBe(0);
});

test('the account report\'s "on the house" filter counts a VIP as its Pay column does', async ({ page }) => {
  await boot(page, [row('A', 'waiting')]);
  const r = await page.evaluate(`(()=>{
    S.tags=[{id:'tag_vip',slug:'vip',name:'VIP',color:'#ff0000'}];
    S.customers=[{id:'v1',name:'Vip Rider',default_pay:'normal'},{id:'h1',name:'House Rider',default_pay:'house'},{id:'n1',name:'Plain Rider',default_pay:'normal'}];
    S.customerTags=[{customer_id:'v1',tag_id:'tag_vip',added_at:Date.now()-1000,expires_at:null,starts_at:null}];
    const o=_accOpts();o.fTag='all';
    o.fPay='house';const house=_accRows().map(x=>x.c.id).sort();
    o.fPay='normal';const normal=_accRows().map(x=>x.c.id);
    o.fPay='all';return {house,normal};})()`);
  expect(r).toEqual({ house: ['h1', 'v1'], normal: ['n1'] });
});
