import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Review fixes of 2026-10-05 (sessions and promo codes): a session's date move runs once however
// often Save is tapped, and takes the invitations and badges of the ride with it (and back on
// Undo); Close out is never offered on a night still ahead, and on an approval ride settles only
// the riders selected; a promo code already on a booking keeps its discount once the code is
// spent; a code's text is refused when it exists; the promo and session-status notices are
// translated.

const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
async function staff(page: Page, fixtures: Record<string, unknown>) {
  await stubSupabase(page, { bikes: [], queue_entries: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0');
}
function writesTo(page: Page, table: string) {
  const w: { method: string; url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (['POST', 'PATCH', 'DELETE'].includes(r.method()) && new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) {
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* DELETE */ }
      w.push({ method: r.method(), url: decodeURIComponent(r.url()), body: Array.isArray(body) ? body[0] : body });
    }
  });
  return w;
}

const satRide = {
  id: '2099-02-06', day: 'Saturday', session_date: '2099-02-06', capacity: 25, status: 'open', created_at: '2099-01-01T00:00:00Z',
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 25, paid_ride: false,
  bike_slots: '{"_time":"06:00 - 06:30"}',
};

test.describe('@staff:sessions rb1 fixes (2026-10-05)', () => {
  test('a second tap on Save while a date move is on the wire moves the ride once', async ({ page }) => {
    await staff(page, { sessions: [satRide] });
    const sw = writesTo(page, 'sessions');
    await page.evaluate(`startEditSession('2099-02-06');S.editSessDate='2099-02-13';saveSessionEdit();saveSessionEdit()`);
    await expect.poll(() => sw.filter((w) => w.method === 'DELETE').length).toBe(1);
    await page.waitForFunction('S.editSessionId===null');
    await page.waitForTimeout(300);
    expect(sw.filter((w) => w.method === 'POST')).toHaveLength(1);           // one copy of the ride, no '<date>-2'
    expect(sw.filter((w) => w.method === 'POST')[0].body.id).toBe('2099-02-13');
  });

  test('a date move takes the invitations and badges of the ride along, and Undo brings them back', async ({ page }) => {
    await staff(page, { sessions: [satRide] });
    const ca = writesTo(page, 'community_applications'), cb = writesTo(page, 'customer_badges');
    await page.evaluate(`startEditSession('2099-02-06');S.editSessDate='2099-02-13';saveSessionEdit()`);
    await page.waitForFunction('S.editSessionId===null&&S.undoStack.length>0');
    await expect.poll(() => ca.length).toBe(1);
    expect(ca[0]).toMatchObject({ method: 'PATCH', body: { invited_session: '2099-02-13' } });
    expect(ca[0].url).toContain('invited_session=eq.2099-02-06');
    await expect.poll(() => cb.length).toBe(1);
    expect(cb[0]).toMatchObject({ method: 'PATCH', body: { session_id: '2099-02-13' } });
    expect(cb[0].url).toContain('session_id=eq.2099-02-06');

    await page.evaluate('doUndo()');
    await expect.poll(() => ca.length).toBe(2);
    expect(ca[1].body).toEqual({ invited_session: '2099-02-06' });
    expect(ca[1].url).toContain('invited_session=eq.2099-02-13');
    await expect.poll(() => cb.length).toBe(2);
    expect(cb[1].body).toEqual({ session_id: '2099-02-06' });
    expect(cb[1].url).toContain('session_id=eq.2099-02-13');
  });

  test('a database without the invitation column or the badges table still moves the ride, and says nothing', async ({ page }) => {
    await staff(page, { sessions: [satRide] });
    await page.route(/\/rest\/v1\/community_applications\?/, (r) => (r.request().method() === 'PATCH'
      ? r.fulfill({ status: 400, headers: head, body: JSON.stringify({ code: 'PGRST204', message: "Could not find the 'invited_session' column of 'community_applications' in the schema cache" }) })
      : r.fallback()));
    await page.route(/\/rest\/v1\/customer_badges\?/, (r) => (r.request().method() === 'PATCH'
      ? r.fulfill({ status: 404, headers: head, body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.customer_badges' in the schema cache" }) })
      : r.fallback()));
    const sw = writesTo(page, 'sessions');
    await page.evaluate(`startEditSession('2099-02-06');S.editSessDate='2099-02-13';saveSessionEdit()`);
    await expect.poll(() => sw.filter((w) => w.method === 'DELETE').length).toBe(1); // the old row goes as before
    await page.waitForFunction('S.editSessionId===null');
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
  });

  test('a refused invitation move is said, and the ride still moves', async ({ page }) => {
    await staff(page, { sessions: [satRide] });
    await page.route(/\/rest\/v1\/community_applications\?/, (r) => (r.request().method() === 'PATCH'
      ? r.fulfill({ status: 403, headers: head, body: JSON.stringify({ code: '42501', message: 'new row violates row-level security policy for table "community_applications"' }) })
      : r.fallback()));
    const sw = writesTo(page, 'sessions');
    await page.evaluate(`startEditSession('2099-02-06');S.editSessDate='2099-02-13';saveSessionEdit()`);
    await expect.poll(() => sw.filter((w) => w.method === 'DELETE').length).toBe(1);
    await expect(page.locator('#err-bar-el')).toBeVisible();
  });
});

// ── Close out: never a night still ahead; on an approval ride only the riders selected ────────
const OLD = '2020-02-01', FUT = '2099-09-09';
const closeSessions = [
  { id: OLD, session_date: OLD, day: 'Saturday', status: 'closed', capacity: 20, spots: 20, created_at: 1,
    event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false, bike_slots: '{"_time":"06:00 - 08:00"}' },
  { id: FUT, session_date: FUT, day: 'Tuesday', status: 'closed', capacity: 10, created_at: 2, bike_slots: '{"_time":"21:00 - 23:00","_total":10}' },
];
const q = (id: string, sid: string, n: number, x: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Saturday', session_date: sid, queue_num: n, name: 'Rider ' + id, phone: '0550000001',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 0, registered_at: '2020-01-30T10:00:00Z', ...x,
});
async function sessionsView(page: Page, queue_entries: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions: closeSessions, queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue()`);
}

test.describe('@staff:sessions rb1 close out (2026-10-05)', () => {
  test('a closed night still ahead offers no Close out, and closing it out does nothing', async ({ page }) => {
    await sessionsView(page, [q('f1', FUT, 1, { session_day: 'Tuesday' }), q('f2', FUT, 2, { session_day: 'Tuesday', status: 'active' })]);
    await page.evaluate(`selectSessionDetail('${FUT}')`);
    await expect(page.locator('#tab-queue .sess-detail-actions')).toBeVisible();
    await expect(page.locator('#tab-queue .sess-detail-actions')).not.toContainText('Close out');
    expect(await page.evaluate(`_coCount('${FUT}')`)).toBe(0);
    const p: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) p.push(r.url()); });
    await page.evaluate(`closeOutSession('${FUT}')`);
    await page.waitForTimeout(300);
    await expect(page.locator('.confirm-box')).toHaveCount(0);
    expect(p).toHaveLength(0);
  });

  test('on a Saturday ride only the riders selected are closed out: a pending request is no no-show', async ({ page }) => {
    await sessionsView(page, [
      q('ap', OLD, 1, { approval: 'approved' }),
      q('pe', OLD, 2, { approval: 'pending' }),
      q('rj', OLD, 3, { approval: 'rejected' }),
      q('in', OLD, 4, { approval: 'approved', checked_in_at: '2020-02-01T06:10:00Z' }),
    ]);
    await page.evaluate(`selectSessionDetail('${OLD}')`);
    await expect(page.locator('#tab-queue .sess-detail-actions')).toContainText('Close out (2)');
    expect(await page.evaluate(`_coCount('${OLD}')`)).toBe(2);
    const p: { url: string; body: string }[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) p.push({ url: decodeURIComponent(r.url()), body: r.postData() || '' }); });
    await page.evaluate(`closeOutSession('${OLD}')`);
    await page.locator('.confirm-box button').filter({ hasText: /close out/i }).click();
    await expect.poll(() => p.length).toBe(2);
    const ids = (u: string) => u.match(/id=in\.\(([^)]*)\)/)?.[1].split(',') ?? [];
    expect(ids(p.find((x) => /"status":"noshow"/.test(x.body))!.url)).toEqual(['ap']);
    expect(ids(p.find((x) => /"status":"done"/.test(x.body))!.url)).toEqual(['in']);
  });
});

// ── Promo codes ────────────────────────────────────────────────────────────────
const pSess = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' }];
const code = (over: Record<string, unknown> = {}) => ({ id: 'p1', code: 'TEN', kind: 'percent', value: 10, applies_to: null, active: true,
  expires_at: null, max_uses: null, uses: 0, customer_id: null, created_at: '2099-01-01', ...over });
const carrying = (id: string, over: Record<string, unknown> = {}) => ({
  id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 1, name: 'Rider ' + id, phone: '', customer_id: null,
  type_preference: 'Road', status: 'waiting', paid: false, price: 67.5, promo_code: 'TEN', registered_at: '2099-01-01T10:00:00Z', ...over,
});
function queuePatches(page: Page) {
  const out: Record<string, Record<string, unknown>> = {};
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      if (id) out[id] = r.postDataJSON();
    }
  });
  return out;
}

test.describe('@staff:sessions rb1 promo codes (2026-10-05)', () => {
  for (const spent of [{ max_uses: 1, uses: 1 }, { expires_at: '2020-01-01' }]) {
    test(`a rider already carrying a code keeps its discount once the code is ${spent.uses ? 'used up' : 'expired'}`, async ({ page }) => {
      await staff(page, { sessions: pSess, promo_codes: [code(spent)], queue_entries: [carrying('e1')] });
      const p = queuePatches(page);
      expect(await page.evaluate(`_syncPromoBookings('TEN')`)).toBe(0);
      await page.waitForTimeout(200);
      expect(p).toEqual({});
    });
  }

  test('a code switched off still takes its discount away', async ({ page }) => {
    await staff(page, { sessions: pSess, promo_codes: [code({ active: false })], queue_entries: [carrying('e1')] });
    const p = queuePatches(page);
    expect(await page.evaluate(`_syncPromoBookings('TEN')`)).toBe(1);
    await expect.poll(() => p.e1).toEqual({ price: 75 });
  });

  test('a code whose text exists already, in any case, is refused', async ({ page }) => {
    await staff(page, { sessions: pSess, promo_codes: [code({ code: 'SUMMER10' })] });
    const pw = writesTo(page, 'promo_codes');
    await page.evaluate(`S._pcCode='summer10';S._pcValue='10';addPromo()`);
    await expect(page.locator('#toast-container .toast').filter({ hasText: 'A code with this text already exists.' })).toBeVisible();
    await page.waitForTimeout(200);
    expect(pw).toHaveLength(0);
  });

  test('the notice for a database without the type column is in the staff member’s language', async ({ page }) => {
    await staff(page, { sessions: pSess, promo_codes: [] });
    let n = 0;
    await page.route(/\/rest\/v1\/promo_codes/, (r) => (r.request().method() === 'POST' && n++ === 0
      ? r.fulfill({ status: 400, headers: head, body: JSON.stringify({ code: 'PGRST204', message: "Could not find the 'applies_to' column of 'promo_codes' in the schema cache" }) })
      : r.fallback()));
    await page.evaluate(`setLang('ar')`);
    await page.evaluate(`S._pcCode='NEW5';S._pcValue='5';S._pcType='Road';addPromo()`);
    await expect(page.locator('#toast-container .toast').filter({ hasText: 'عمود النوع غير موجود' })).toBeVisible();
  });

  test('the Undo of a session status names the status in words', async ({ page }) => {
    await staff(page, { sessions: pSess });
    await page.evaluate(`toggleSession('s0','full')`);
    await page.waitForFunction('S.undoStack.length>0');
    const label = await page.evaluate('S.undoStack[S.undoStack.length-1].label') as string;
    expect(label).toContain('→ Fully Booked');
    expect(label).not.toMatch(/→ full$/);
  });
});
