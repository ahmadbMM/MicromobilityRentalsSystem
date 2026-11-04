import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The staff review's leftovers that need the database (20261104160000), marked Build now on 2026-10-28, built 2026-11-04:
// S02-core2-01 a ride's new date in one server transaction; S07-community2-16 badges and Instagram counts on the live channel.

const D1 = '2099-03-06', D2 = '2099-03-13';
const ride = { id: `${D1}-ev`, day: 'Saturday', session_date: D1, capacity: 30, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'event', needs_approval: false, hide_queue: true, paid_ride: true, price: 90, open_to_all: true, spots: 30, title: 'Spring Fair', bike_slots: '{"_time":"18:00 - 20:00"}' };

async function staff(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [ride], queue_entries: [], bikes: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue()`);
  await page.waitForFunction('S.dataLoaded');
}
type Sent = { method: string; url: string; body: Record<string, unknown> };
function sent(page: Page) {
  const list: Sent[] = [];
  page.on('request', (r) => {
    if (!r.url().includes('/rest/v1/') || r.method() === 'OPTIONS' || r.method() === 'GET') return;
    let body = {};
    try { body = r.postDataJSON() || {}; } catch { /* no body */ }
    list.push({ method: r.method(), url: r.url(), body });
  });
  return list;
}
const moves = (l: Sent[]) => l.filter((x) => x.url.includes('/rpc/staff_move_session'));
const on = (l: Sent[], table: string, method: string) => l.filter((x) => x.method === method && new RegExp(`/rest/v1/${table}\\b`).test(x.url));
const moveDate = (page: Page) => page.evaluate(`startEditSession('${ride.id}');S.editSessDate='${D2}';renderSessions();_saveSessionEdit()`);

test.describe('@staff:sessions a ride\'s new date', () => {
  test('goes to the server in one call, and the edit lands on the id it answers', async ({ page }) => {
    await staff(page, { 'rpc:staff_move_session': { ok: true, id: `${D2}-ev-2`, day: 'Saturday' } });
    const l = sent(page);
    await moveDate(page);
    await expect.poll(() => page.evaluate('S.editSessionId')).toBe(null);
    expect(moves(l).map((x) => x.body)).toEqual([{ p_from: ride.id, p_to_id: `${D2}-ev`, p_date: D2, p_exact: false }]);
    // the writes it replaces are not made
    expect(on(l, 'sessions', 'POST')).toHaveLength(0);
    expect(on(l, 'sessions', 'DELETE')).toHaveLength(0);
    expect(on(l, 'queue_entries', 'PATCH')).toHaveLength(0);
    expect(on(l, 'cashier_sales', 'PATCH')).toHaveLength(0);
    const p = on(l, 'sessions', 'PATCH');
    expect(p).toHaveLength(1);
    expect(p[0].url).toContain(`id=eq.${D2}-ev-2`);
    expect(p[0].body).toMatchObject({ session_date: D2 });
  });

  test('refused, nothing else is written and the form stays', async ({ page }) => {
    await staff(page, { 'rpc:staff_move_session': { __rpcError: { status: 403, code: '42501', message: 'STAFF_ONLY' } } });
    const l = sent(page);
    await moveDate(page);
    await expect(page.locator('#err-bar-el')).toBeVisible();
    expect(on(l, 'sessions', 'PATCH')).toHaveLength(0);
    expect(on(l, 'sessions', 'POST')).toHaveLength(0);
    expect(await page.evaluate('S.editSessionId')).toBe(ride.id);
  });

  test('what this device holds follows the ride', async ({ page }) => {
    await staff(page);
    const r = await page.evaluate(`(()=>{
      S.cashSales=[{id:'c',session_id:'a'}];S.riders=[{id:'r',session_id:'a'}];S._caApps=[{id:'x',invited_session:'a'}];S.custBadges=[{customer_id:'k',badge_id:'b',session_id:'a'},{customer_id:'k',badge_id:'z',session_id:'q'}];
      _sessMoveLocal('a','b');
      return [S.cashSales[0].session_id,S.riders[0].session_id,S._caApps[0].invited_session,S.custBadges.map(x=>x.session_id)];
    })()`);
    expect(r).toEqual(['b', 'b', 'b', ['b', 'q']]);
  });

  test('a database without the function keeps the writes it had', async ({ page }) => {
    await staff(page);
    const l = sent(page);
    await moveDate(page);
    await expect.poll(() => on(l, 'sessions', 'POST').length).toBe(1);
    await expect.poll(() => on(l, 'sessions', 'DELETE').length).toBe(1);
    expect(on(l, 'queue_entries', 'PATCH').length).toBeGreaterThan(0);
  });
});

test.describe('@staff:community badges and counts on the live channel', () => {
  test('a badge given, changed and taken back is held without a read', async ({ page }) => {
    await staff(page);
    const r = await page.evaluate(`(()=>{
      S.custBadges=[{customer_id:'k',badge_id:'old',session_id:'s'}];
      const a=_rtRefMerge('customer_badges',{op:'INSERT',row:{customer_id:'k',badge_id:'b',session_id:'s'}});
      const n1=S.custBadges.length;
      _rtRefMerge('customer_badges',{op:'UPDATE',row:{customer_id:'k',badge_id:'b',session_id:'t'},old:{customer_id:'k',badge_id:'b',session_id:'s'}});
      const moved=S.custBadges.find(x=>x.badge_id==='b').session_id,n2=S.custBadges.length;
      _rtRefMerge('customer_badges',{op:'DELETE',row:null,old:{customer_id:'k',badge_id:'b',session_id:'t'}});
      return [a,n1,moved,n2,S.custBadges.map(x=>x.badge_id)];
    })()`);
    expect(r).toEqual([true, 2, 't', 2, ['old']]);
  });

  test('an Instagram count follows; none held yet is left for the first read', async ({ page }) => {
    await staff(page);
    const r = await page.evaluate(`(()=>{
      S.igRows=null;
      const none=_rtRefMerge('customer_ig_followers',{op:'UPDATE',row:{customer_id:'k',followers:5}});
      S.igRows=new Map([['k',{customer_id:'k',followers:1}]]);
      _rtRefMerge('customer_ig_followers',{op:'UPDATE',row:{customer_id:'k',followers:7},old:{customer_id:'k',followers:1}});
      const up=S.igRows.get('k').followers;
      _rtRefMerge('customer_ig_followers',{op:'DELETE',row:null,old:{customer_id:'k'}});
      return [none,up,S.igRows.size];
    })()`);
    expect(r).toEqual([false, 7, 0]);
  });

  test('the whole read waits half an hour while the channel is up, five minutes when it is down', async ({ page }) => {
    await staff(page);
    expect(await page.evaluate(`(()=>{const w=_refLive;_refLive=true;const a=_rrTtl();_refLive=false;const b=_rrTtl();_refLive=w;return[a,b];})()`)).toEqual([1800000, 300000]);
  });
});

test.describe('@build the migration', () => {
  test('the move carries every table naming a ride, in one function that keeps its attributes', async () => {
    const fs = await import('node:fs');
    const sql = fs.readFileSync('supabase/migrations/20261104160000_staff_review_move_and_broadcast.sql', 'utf8');
    expect(sql).toMatch(/security definer\s+set search_path to 'public'/);
    expect(sql).toContain('revoke all on function public.staff_move_session(text, text, text, boolean) from public, anon;');
    for (const t of ['queue_entries', 'cashier_sales', 'community_applications', 'customer_badges', 'rider_registrations', 'session_partners', 'part_timer_shifts', 'till_sessions', 'deposits', 'waitlist_offers', 'wallet_ledger', 'member_kudos', 'live_positions', 'rider_night_counters']) {
      expect(sql, t).toMatch(new RegExp(`update ${t}\\b`));
    }
    expect(sql.indexOf('delete from sessions')).toBeGreaterThan(sql.indexOf('update rider_night_counters'));
  });
});
