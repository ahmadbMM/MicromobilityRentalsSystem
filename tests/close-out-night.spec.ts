import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Nobody closes out a session by hand: by September, 1,776 bookings were still 'waiting' and
// 191 still 'active' on nights that ended in July. One button finishes the night the way it
// actually went — riders on a bike are returned, checked-in riders become done, no-arrivals
// become no-show — with guarded writes (a row another till already dealt with is not
// rewritten) and an undo. It is offered on tonight's session too, as the desk packs up.

const OLD = '2020-01-01';
const sessions = [
  { id: OLD, session_date: OLD, day: 'Sunday', status: 'closed', capacity: 10, created_at: 1 },
  { id: '2099-09-09', session_date: '2099-09-09', day: 'Future', status: 'open', capacity: 10, created_at: 2 },
];
const e = (id: string, sid: string, st: string, x: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: sid, queue_num: 1, name: 'R ' + id,
  phone: '0550000001', type_preference: 'Road', size: 'M', status: st, paid: true, price: 75,
  registered_at: '2020-01-01T10:00:00Z', ...x });

async function boot(page: import('@playwright/test').Page, queue_entries: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('sessions')`);
  await page.waitForTimeout(250);
}

function patches(page: import('@playwright/test').Page) {
  const out: { url: string; body: string }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) out.push({ url: r.url(), body: r.postData() || '' });
  });
  return out;
}

test('checked-in riders become done, no-arrivals become no-show, guarded', async ({ page }) => {
  await boot(page, [
    e('a', OLD, 'active', { checked_in_at: '2020-01-01T21:00:00Z' }),
    e('b', OLD, 'waiting', { checked_in_at: '2020-01-01T21:05:00Z', queue_num: 2 }),
    e('c', OLD, 'waiting', { queue_num: 3 }),
    e('w', OLD, 'waitlist', { queue_num: 4, waitlist_num: 1 }),
  ]);
  const p = patches(page);
  const returns: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/rpc/staff_return')) returns.push(JSON.parse(r.postData() || '{}').p_booking_id);
  });
  await page.evaluate(`closeOutSession('${OLD}')`);
  await page.locator('#desk-sheet .ck-go').click(); // the close-night checklist comes first (D10, 2026-11-11)
  await page.locator('.confirm-box button').filter({ hasText: /close out/i }).click();
  const ids = (u: string) => decodeURIComponent(u).match(/id=in\.\(([^)]*)\)/)?.[1].split(',') ?? [];
  await expect.poll(() => p.filter((x) => ids(x.url).length).length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  expect(returns).toEqual(['a']);                      // the rider on a bike is returned, as Return does
  const done = p.find((x) => /"status":"done"/.test(x.body) && ids(x.url).length)!;
  const ns = p.find((x) => /"status":"noshow"/.test(x.body))!;
  expect(ids(done.url)).toEqual(['b']);                // waiting-but-checked-in — they rode
  expect(done.url).toMatch(/status=eq\.waiting/);      // guarded on current status
  expect(ids(ns.url)).toEqual(['c']);                  // the waitlist row w is not touched
  expect(ns.url).toMatch(/status=eq\.waiting/);
});

test('the button appears only when the night is over AND rows are live', async ({ page }) => {
  await boot(page, [e('a', OLD, 'active'), e('f', '2099-09-09', 'waiting')]);
  // actions live in the detail pane, so look at each session's detail in turn
  await page.evaluate(`selectSessionDetail('${OLD}')`);
  await page.waitForTimeout(200);
  await expect(page.locator('#tab-sessions')).toContainText('Close out');
  await page.evaluate(`selectSessionDetail('2099-09-09')`);
  await page.waitForTimeout(200);
  const txt = await page.evaluate(`document.getElementById('tab-sessions').innerText`) as string;
  expect(txt).not.toContain('Close out');     // the future session offers nothing
});

test('a fully closed-out night offers nothing', async ({ page }) => {
  await boot(page, [e('a', OLD, 'done'), e('b', OLD, 'noshow', { queue_num: 2 })]);
  await page.evaluate(`selectSessionDetail('${OLD}')`);
  await page.waitForTimeout(200);
  const txt = await page.evaluate(`document.getElementById('tab-sessions').innerText`) as string;
  expect(txt).not.toContain('Close out');
});

test('tonight\'s session offers Close out too', async ({ page }) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  await stubSupabase(page, {
    sessions: [{ id: today, session_date: today, day: 'Tonight', status: 'open', capacity: 10, created_at: 1 }],
    queue_entries: [e('a', today, 'active'), e('c', today, 'waiting', { queue_num: 2 })], bikes: [],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('sessions');selectSessionDetail('${today}')`);
  await page.waitForTimeout(250);
  await page.locator('#tab-sessions .sess-detail-actions .sh-more').click(); // a tile in the detail's More (staff round s10)
  await expect(page.locator('.row-sheet')).toContainText('Close out (2)');
});
