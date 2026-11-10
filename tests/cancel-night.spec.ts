import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Calling off a night used to mean closing the session and every rider finding out at the
// gate. The flow has two halves: telling everyone (a prefilled message, one wa.me link per
// rider, copy-all-numbers), then the bookkeeping — every live booking cancelled, stamped
// staff, guarded on current status, session closed, undoable. Moving a night is NOT this
// flow: the session date edit already carries bookings.

const FUT = '2099-06-06';
const sessions = [{ id: FUT, session_date: FUT, day: 'Saturday', status: 'open', capacity: 20, created_at: 1 }];
const e = (id: string, st: string, x: Record<string, unknown> = {}) => ({
  id, session_id: FUT, session_day: 'Saturday', session_date: FUT, queue_num: 1, name: 'R ' + id,
  phone: '05500000' + id.length, type_preference: 'Road', size: 'M', status: st, paid: false,
  price: 75, registered_at: '2099-01-01T10:00:00Z', ...x });

async function boot(page: import('@playwright/test').Page, rows: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries: rows, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('sessions');selectSessionDetail('${FUT}')`);
  await page.waitForTimeout(250);
}

test('@staff:sessions the button offers on a live future night, with the count', async ({ page }) => {
  await boot(page, [e('a', 'waiting'), e('b', 'waitlist', { queue_num: 2, waitlist_num: 1 }), e('c', 'done', { queue_num: 3 })]);
  await expect(page.locator('#tab-sessions')).toContainText('Cancel session (2)');   // done is already history
});

test('the modal carries the message, the links and the roll', async ({ page }) => {
  await boot(page, [e('a', 'waiting'), e('b', 'waiting', { queue_num: 2, phone: '0551234567' })]);
  await page.evaluate(`showCancelNight('${FUT}')`);
  const m = page.locator('#cancel-night-modal');
  await expect(m).toContainText('2 live booking');
  await expect(m.locator('#cn-msg')).toHaveValue(/cancelled/);
  const links = await m.locator('a[href^="https://wa.me/"]').count();
  expect(links).toBe(2);
  const href = await m.locator('a[href^="https://wa.me/"]').last().getAttribute('href');
  expect(href).toContain('966551234567');
  expect(decodeURIComponent(href!)).toContain('cancelled');            // the message rides in the link
});

test('confirming cancels the live rows guarded, stamps staff, closes the session', async ({ page }) => {
  await boot(page, [e('a', 'waiting'), e('w', 'waitlist', { queue_num: 2, waitlist_num: 1 })]);
  const patches: { url: string; body: string }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && /rest\/v1\/(queue_entries|sessions)/.test(r.url()))
      patches.push({ url: r.url(), body: r.postData() || '' });
  });
  await page.evaluate(`showCancelNight('${FUT}')`);
  await page.locator('#cancel-night-modal').getByRole('button', { name: /Cancel 2 booking/ }).click();
  await expect.poll(() => patches.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  const q = patches.find((p) => p.url.includes('queue_entries'))!;
  expect(q.body).toContain('"status":"cancelled"');
  expect(q.body).toContain('"cancelled_by":"staff"');
  expect(decodeURIComponent(q.url)).toContain('id=in.(a,w)');
  expect(decodeURIComponent(q.url)).toMatch(/status=in\./);            // guarded on current status
  const sess = patches.find((p) => p.url.includes('/sessions'))!;
  expect(sess.body).toContain('"status":"closed"');
});

test('a night already over offers Close out, not Cancel session', async ({ page }) => {
  const OLD = '2020-01-01';
  await stubSupabase(page, {
    sessions: [{ id: OLD, session_date: OLD, day: 'Sunday', status: 'open', capacity: 10, created_at: 1 }],
    queue_entries: [{ ...e('a', 'waiting'), session_id: OLD, session_date: OLD }], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('sessions');selectSessionDetail('${OLD}')`);
  await page.waitForTimeout(250);
  const txt = await page.evaluate(`document.getElementById('tab-sessions').innerText`) as string;
  expect(txt).toContain('Close out');
  expect(txt).not.toContain('Cancel session');
});

// Cancel session (the user, 2026-11-10: "allow staff to cancel a session even if it had bookings in it, return all money
// to customers and return all codes used and free rides used to them"). staff_cancel_session does it on the server; the
// sheet shows the money rider by rider (Back how paid by default, the wallet an admin's pick), the codes going back, a
// reason, and afterwards what is left to give back by hand.
const cust = { id: 'cu1', name: 'R a', phone: '0550000001' };
test('@staff:sessions the sheet shows the money and the codes, Back how paid by default', async ({ page }) => {
  await boot(page, [
    e('a', 'waiting', { paid: true, pay_method: 'card', customer_id: 'cu1' }),
    e('b', 'waiting', { queue_num: 2, paid: true, pay_method: 'cash' }),                      // a walk-in: no wallet to pick
    e('c', 'waiting', { queue_num: 3, wallet_paid: 20, customer_id: 'cu1' }),                 // the wallet's own part
    e('d', 'waitlist', { queue_num: 4, waitlist_num: 1, promo_code: 'BD-1234ABCD' }),
    e('x', 'cancelled', { queue_num: 5, paid: true, pay_method: 'card', name: 'Earlier' }),    // cancelled before, still paid
  ]);
  await page.evaluate(`S._cwOff=false;isAdmin=()=>true`);
  await page.evaluate(`showCancelNight('${FUT}')`);
  const m = page.locator('#cancel-night-modal');
  await expect(m).toContainText('Money back');
  await expect(m.locator('.dk-cn-mrow')).toHaveCount(3);                                   // a, b and the earlier one
  await expect(m.locator('.dk-cn-mrow', { hasText: 'R a' }).getByRole('button', { name: 'Back how paid' })).toHaveAttribute('aria-pressed', 'true');
  await expect(m.locator('.dk-cn-mrow', { hasText: 'R b' }).getByRole('button')).toHaveCount(0);
  await expect(m.locator('.dk-cn-mrow', { hasText: 'Earlier' })).toContainText('cancelled before');
  await expect(m).toContainText('from the wallet goes back to it by itself');
  await expect(m).toContainText('1 code(s) go back to their owners');
  await expect(m.locator('#cn-sum')).toContainText(/By hand: .*225.* Into wallets: .*0/);
  await m.locator('.dk-cn-mrow', { hasText: 'R a' }).getByRole('button', { name: 'Wallet' }).click();
  await expect(m.locator('#cn-sum')).toContainText(/By hand: .*150.* Into wallets: .*75/);
});

test('@staff:sessions confirming asks the server once, with the wallet picks and the reason, then lists the refunds by hand', async ({ page }) => {
  const answer = { ok: true, id: FUT, cancelled: 2, rows: [{ id: 'a', was: 'waiting' }, { id: 'b', was: 'waiting' }],
    total: 150, to_wallet: 75, wallet: [{ id: 'a', customer: 'cu1', amount: 75, card: 75, method: 'card' }],
    by_hand: [{ id: 'b', name: 'R b', phone: '0550000002', amount: 75, card: 0, method: 'cash', was: 'waiting' }],
    wallet_back: 0, online: 0, organiser: 0, codes: 1, extended: [{ code: 'BD-1234ABCD', expires_at: '2099-01-15' }], bikes: [], previous_status: 'open' };
  await stubSupabase(page, { sessions, queue_entries: [e('a', 'waiting', { paid: true, pay_method: 'card', customer_id: 'cu1' }),
    e('b', 'waiting', { queue_num: 2, paid: true, pay_method: 'cash', phone: '0550000002' })], bikes: [], customers: [cust], 'rpc:staff_cancel_session': answer });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`S._cwOff=false;isAdmin=()=>true;setStaffTab('sessions');selectSessionDetail('${FUT}')`);
  const sent: Record<string, unknown>[] = [];
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/rpc/staff_cancel_session')) sent.push(r.postDataJSON());
    if (r.method() === 'PATCH' && /rest\/v1\/queue_entries/.test(r.url())) writes.push(r.url());
  });
  await page.evaluate(`showCancelNight('${FUT}')`);
  const m = page.locator('#cancel-night-modal');
  await m.locator('.dk-cn-mrow', { hasText: 'R a' }).getByRole('button', { name: 'Wallet' }).click();
  await m.locator('#cn-why').fill('Rain');
  await m.getByRole('button', { name: /Cancel 2 booking/ }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ p_id: FUT, p_reason: 'Rain', p_wallet: ['a'], p_op: 'Spec Staff' });
  const res = page.locator('#mny-modal');
  await expect(res).toContainText('Give back by hand');
  await expect(res.locator('.cn-res-hand li')).toHaveCount(1);
  await expect(res.locator('.cn-res-hand li')).toContainText('R b');
  await expect(res.locator('.cn-res-hand li')).toContainText('Cash');
  await expect(res).toContainText('into 1 wallet(s)');
  await expect(res).toContainText('1 code(s) given back');
  await expect(res).toContainText('now end on');
  expect(writes).toEqual([]);                                                               // the server cancelled them, not the page
  expect(await page.evaluate(`S.undoStack?S.undoStack.length:0`)).toBe(0);                  // money given back is not undone from here
});

test('@staff:sessions a closed session still ahead can be cancelled; Delete with bookings opens Cancel session', async ({ page }) => {
  const closed = [{ ...sessions[0], status: 'closed' }];
  await stubSupabase(page, { sessions: closed, queue_entries: [e('a', 'waiting')], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`isAdmin=()=>true;setStaffTab('sessions');selectSessionDetail('${FUT}')`);
  await page.waitForTimeout(250);
  await expect(page.locator('#tab-sessions')).toContainText('Cancel session (1)');
  await page.evaluate(`deleteSession('${FUT}')`);
  await expect(page.locator('#cancel-night-modal')).toBeVisible();
  await expect(page.locator('#cancel-night-modal')).toContainText('Cancel session');
});

test('@staff:sessions a session called off shows Cancelled, and offers no second cancel', async ({ page }) => {
  const off = [{ ...sessions[0], status: 'closed', cancelled_at: '2099-06-01T10:00:00Z' }];
  await stubSupabase(page, { sessions: off, queue_entries: [e('a', 'waiting')], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('sessions');selectSessionDetail('${FUT}')`);
  await page.waitForTimeout(250);
  await expect(page.locator('#tab-sessions .ss-cancelled').first()).toContainText('Cancelled');
  await expect(page.locator('#tab-sessions')).not.toContainText('Cancel session');
});
