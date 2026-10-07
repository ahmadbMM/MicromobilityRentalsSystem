import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt of 2026-10-07 (Sessions and the group editor): a party moved to another ride takes that
// ride's type rules and fare, and a taken number is tried again; a clone carries no announce time
// typed into an earlier form; Undo of a session edit puts the date's description back; a location
// filter no session names any more stops filtering.

const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
async function staff(page: Page, fixtures: Record<string, unknown>) {
  await stubSupabase(page, { bikes: [], queue_entries: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0');
}
type W = { method: string; url: string; body: Record<string, unknown> };
function writesTo(page: Page, table: string) {
  const w: W[] = [];
  page.on('request', (r) => {
    if (['POST', 'PATCH'].includes(r.method()) && new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) {
      let body: Record<string, unknown> = {};
      try { const b = r.postDataJSON(); body = (Array.isArray(b) ? b[0] : b) || {}; } catch { /* not JSON */ }
      w.push({ method: r.method(), url: decodeURIComponent(r.url()), body });
    }
  });
  return w;
}
const jcc = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, day: 'Sunday', session_date: date, capacity: 20, status: 'open', created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...over,
});
const bk = (id: string, sid: string, date: string, n: number, over: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: date, queue_num: n, name: `Rider ${id}`, phone: `05500000${String(n).padStart(2, '0')}`,
  customer_id: null, type_preference: 'Road', size: 'M', height: 178, status: 'waiting', paid: false, price: 75,
  registered_at: '2099-01-01T10:00:00Z', ...over,
});
const patchOf = (w: W[], id: string) => w.filter((x) => x.method === 'PATCH' && x.url.includes(`id=eq.${id}`)).map((x) => x.body);

test.describe('@staff:bookings bughunt oct7 group move', () => {
  test('a party moved off a free ride onto a circuit night takes the night’s fare and a bike type', async ({ page }) => {
    const ws = jcc('w1', '2099-03-05', { day: 'Thursday', event_kind: 'community', ride_kind: 'workshop', needs_approval: false,
      paid_ride: false, open_to_all: true, spots: 20, bike_slots: '{"_time":"19:00 - 21:00"}' });
    const seat = (id: string, n: number) => bk(id, 'w1', '2099-03-05', n, { type_preference: 'None', size: '', height: null, price: 0,
      group_id: 'g1', group_name: 'Falcons', session_day: 'Thursday' });
    await staff(page, { sessions: [ws, jcc('j1', '2099-03-08')], queue_entries: [seat('e1', 1), seat('e2', 2)] });
    const qw = writesTo(page, 'queue_entries');
    await page.evaluate(`showGroupEditModal('e1')`);
    await expect(page.locator('#ge-sess')).toBeVisible();
    await page.selectOption('#ge-sess', 'j1');
    await page.evaluate('saveGroupEdit()');
    await expect.poll(() => qw.filter((x) => x.method === 'PATCH').length).toBe(2);
    for (const id of ['e1', 'e2']) expect(patchOf(qw, id)[0]).toMatchObject({ session_id: 'j1', type_preference: 'Any', price: 57.5 });
  });

  test('a number another desk took meanwhile is tried again with a fresh one', async ({ page }) => {
    const g = (id: string, n: number) => bk(id, 's0', '2099-03-01', n, { group_id: 'g1', group_name: 'Falcons' });
    const queue_entries: Record<string, unknown>[] = [g('e1', 1), g('e2', 2), bk('x1', 's1', '2099-03-08', 1)];
    await staff(page, { sessions: [jcc('s0', '2099-03-01'), jcc('s1', '2099-03-08')], queue_entries });
    let refused = false;
    await page.route(/\/rest\/v1\/queue_entries\?/, (r) => {
      if (r.request().method() !== 'PATCH' || refused) return r.fallback();
      refused = true; // another desk has just booked number 2 on that night
      queue_entries.push(bk('x2', 's1', '2099-03-08', 2));
      return r.fulfill({ status: 409, headers: head, body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint' }) });
    });
    const qw = writesTo(page, 'queue_entries');
    await page.evaluate(`showGroupEditModal('e1')`);
    await expect(page.locator('#ge-sess')).toBeVisible();
    await page.selectOption('#ge-sess', 's1');
    await page.evaluate('saveGroupEdit()');
    await expect.poll(() => patchOf(qw, 'e2').length).toBe(1);
    expect(patchOf(qw, 'e1').map((b) => b.queue_num)).toEqual([2, 3]);
    expect(patchOf(qw, 'e2')[0]).toMatchObject({ session_id: 's1', queue_num: 4 });
    await expect(page.locator('#err-bar-el')).toBeHidden();
  });
});

test.describe('@staff:sessions bughunt oct7 sessions', () => {
  test('a clone starts with no announce time, whatever an earlier form held', async ({ page }) => {
    const sat = jcc('sat1', '2099-03-07', { day: 'Saturday', event_kind: 'community', ride_kind: 'saturday', needs_approval: true,
      paid_ride: false, spots: 20, bike_slots: '{"_time":"06:00 - 08:00"}', reveal_at: '2099-03-06T17:00:00Z' });
    await staff(page, { sessions: [sat] });
    await page.evaluate(`setStaffTab('sessions');S.newSessReveal='2099-01-01T10:00';cloneSession('sat1')`);
    expect(await page.evaluate('S.newSessReveal')).toBe('');
    expect(await page.evaluate('S.newSessEvent')).toBe('community');
  });

  test('Undo of a session edit puts the date’s description back', async ({ page }) => {
    await staff(page, { sessions: [jcc('2099-02-06', '2099-02-06', { day: 'Friday', description: 'Old words' })] });
    const sw = writesTo(page, 'sessions');
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-02-06')`);
    await page.fill('#es-desc', 'New words');
    await page.evaluate('saveSessionEdit()');
    await page.waitForFunction('S.editSessionId===null');
    await expect.poll(() => sw.some((w) => w.body.description === 'New words')).toBe(true);
    await page.waitForFunction('S.undoStack.length>0');
    await page.evaluate('doUndo()');
    await expect.poll(() => sw.some((w) => w.body.description === 'Old words')).toBe(true);
  });

  test('a location filter no session names any more stops filtering', async ({ page }) => {
    await staff(page, { sessions: [jcc('2099-02-06', '2099-02-06', { day: 'Friday', location: 'JCC' })] });
    await page.evaluate(`setStaffTab('sessions');S.sessLocFilter='Nowhere';renderSessions()`);
    expect(await page.evaluate('S.sessLocFilter')).toBe('all');
    await expect(page.locator('.sess-lc')).toHaveCount(1);
  });
});
