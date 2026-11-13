import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Full, no waitlist (the user, 2026-11-13: "add an option to show that a session is fully booked see you on the next
// session/saturday without hiding the session so people don't think it has cancelled"): a closed session staff marked
// bike_slots._fbk stays on the riders' list, said Fully booked with where to go next, and nothing on it can be picked.

const NOW = new Date('2099-11-10T09:00:00+03:00');
const SAT = '2099-11-14-2';
const SAT2 = '2099-11-21-2';
const JCC = '2099-11-17';
const comm = { created_at: 1, event_kind: 'community', open_to_all: false };
const sat = {
  ...comm,
  id: SAT,
  status: 'closed',
  session_date: '2099-11-14',
  day: 'Saturday',
  capacity: 120,
  ride_kind: 'saturday',
  needs_approval: true,
  hide_queue: true,
  spots: 120,
  bike_slots: '{"_time":"05:45 - 06:15","_fbk":1}',
};
const sat2 = { ...sat, id: SAT2, session_date: '2099-11-21', status: 'open', bike_slots: '{"_time":"05:45 - 06:15"}' };
const jcc = {
  id: JCC,
  session_date: '2099-11-17',
  day: 'Tuesday',
  status: 'closed',
  capacity: 40,
  created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":40,"_fbk":1}',
};

async function custBoot(page: Page, sessions: Record<string, unknown>[], rows: Record<string, unknown>[] = [], lang = '') {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, queue_entries: rows, 'rpc:my_bookings': rows, 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/' + (lang ? `?lang=${lang}` : ''));
  await waitForSb(page);
  await page.evaluate('goLanding()');
}
const card = (page: Page, id: string) => page.locator(`#tab-register [data-session="${id}"]`);

test.describe('@customer:full-no-waitlist a session closed as full stays on the list', () => {
  test('the Saturday ride says Fully booked and see you next Saturday, and cannot be picked', async ({ page }) => {
    await custBoot(page, [sat, sat2]);
    await page.evaluate(`selectEvent('community')`);
    const c = card(page, SAT);
    await expect(c).toBeVisible();
    await expect(c).toHaveClass(/sess-card-fbk/);
    await expect(c).toHaveAttribute('aria-disabled', 'true');
    await expect(c.locator('.spots-red')).toHaveText('Fully booked');
    await expect(c.locator('.sess-fbk-l')).toHaveText('See you next Saturday');
    // not one of the radios, and a tap does nothing
    await expect(page.locator(`#tab-register [id="sc-${SAT}"]`)).toHaveCount(0);
    await c.click({ force: true });
    expect(await page.evaluate('S.selSession')).toBe(null);
    // the next Saturday is there to book as before, and holds the tab stop
    await expect(page.locator(`#tab-register [id="sc-${SAT2}"]`)).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#tab-register .mm-reg-foot')).toHaveCount(1);
    // full strength: it must not look called off
    expect(await c.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
  });

  test('a plain close, a night called off, a draft and a past date are not shown', async ({ page }) => {
    const plain = { ...sat2, id: '2099-11-28-2', session_date: '2099-11-28', status: 'closed' };
    const off = { ...sat, id: '2099-12-05-2', session_date: '2099-12-05', cancelled_at: '2099-11-09T10:00:00Z' };
    const draft = { ...sat, id: '2099-12-12-2', session_date: '2099-12-12', draft: true };
    const past = { ...sat, id: '2099-11-07-2', session_date: '2099-11-07' };
    await custBoot(page, [sat, plain, off, draft, past]);
    await page.evaluate(`selectEvent('community')`);
    await expect(card(page, SAT)).toBeVisible();
    for (const s of [plain, off, draft, past]) await expect(page.locator(`#tab-register [data-session="${s.id}"],#tab-register [id="sc-${s.id}"]`)).toHaveCount(0);
    // only full dates: nothing to continue with
    await expect(page.locator('#tab-register .mm-reg-foot')).toHaveCount(0);
    // the Experiences card keeps the Saturday mark
    await page.evaluate('goLanding()');
    await expect(page.locator('#land-events .lec-marks .ev-saturday')).toHaveCount(1);
  });

  test('another session says see you at the next session; Details says Fully booked', async ({ page }) => {
    await custBoot(page, [jcc]);
    await page.evaluate(`selectEvent('jcc')`);
    const c = card(page, JCC);
    await expect(c.locator('.spots-red')).toHaveText('Fully booked');
    await expect(c.locator('.sess-fbk-l')).toHaveText('See you at the next session');
    const facts = (await page.evaluate(`_infoFacts(_sessGet('${JCC}'),false).map(r=>r.join(': '))`)) as string[];
    expect(facts).toContain('Places: Fully booked');
  });

  test('a rider holding a place on it sees their place, not the see-you line', async ({ page }) => {
    const row = {
      id: 'b1', session_id: JCC, session_day: 'Tuesday', session_date: '2099-11-17', queue_num: 1, name: 'Sara Haddad',
      phone: '', status: 'waiting', customer_id: 'c1', price: 0, registered_at: '2099-11-01T10:00:00Z',
    };
    await custBoot(page, [jcc], [row]);
    await page.evaluate(`selectEvent('jcc')`);
    const c = card(page, JCC);
    await expect(c.locator('.spots-held')).toHaveText('Booked');
    await expect(c.locator('.sess-fbk-l')).toHaveCount(0);
    await expect(c.locator('.spots-red')).toHaveCount(0);
  });

  test('in Arabic', async ({ page }) => {
    await custBoot(page, [sat], [], 'ar');
    await page.evaluate(`selectEvent('community')`);
    const c = card(page, SAT);
    await expect(c.locator('.spots-red')).toHaveText('محجوز بالكامل');
    await expect(c.locator('.sess-fbk-l')).toHaveText('نراك السبت القادم');
  });
});

// ── Staff ──
const D1 = '2099-03-06';
const ride = (over: Record<string, unknown> = {}) => ({
  id: `${D1}-s`, day: 'Friday', session_date: D1, capacity: 40, status: 'open', created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false, spots: 40,
  bike_slots: '{"_time":"05:30 - 06:00","_wl":{"m":"count","v":7}}', ...over,
});
async function staff(page: Page, sessions: Record<string, unknown>[]) {
  await page.clock.setFixedTime(new Date('2099-03-01T09:00:00+03:00'));
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], promo_codes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('sessions')`);
  await page.waitForFunction('S.dataLoaded');
}
function patches(page: Page) {
  const l: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'PATCH' || !/\/rest\/v1\/sessions\b/.test(r.url())) return;
    try { l.push(r.postDataJSON() || {}); } catch { /* none */ }
  });
  return l;
}
const slotsOf = (b: Record<string, unknown>) => JSON.parse(String(b.bike_slots)) as Record<string, unknown>;

test.describe('@staff:full-no-waitlist the Sessions controls', () => {
  test('an open session offers Full, no waitlist: closed, marked, its other settings kept; undo puts it back', async ({ page }) => {
    await staff(page, [ride()]);
    const l = patches(page);
    await page.evaluate(`S.selSessionDetail='${D1}-s';renderSessions()`);
    await page.getByRole('button', { name: 'More actions' }).click();
    const btn = page.getByRole('menuitem', { name: 'Full, no waitlist', exact: true });
    await expect(btn).toBeVisible();
    await btn.click();
    await expect.poll(() => l.length).toBeGreaterThan(0);
    expect(l[0].status).toBe('closed');
    expect(slotsOf(l[0])).toEqual({ _time: '05:30 - 06:00', _wl: { m: 'count', v: 7 }, _fbk: 1 });
    await expect(page.locator('.toast').last()).toContainText('Riders see it as fully booked');
    await page.evaluate('doUndo()');
    await expect.poll(() => l.length).toBeGreaterThan(1);
    expect(l[1].status).toBe('open');
    expect(slotsOf(l[1])).toEqual({ _time: '05:30 - 06:00', _wl: { m: 'count', v: 7 } });
  });

  test('a full session shows its badge; Re-open and Close both take the mark off', async ({ page }) => {
    const fb = ride({ status: 'closed', bike_slots: '{"_time":"05:30 - 06:00","_fbk":1}' });
    await staff(page, [fb]);
    expect(await page.evaluate(`_ssStatusBadge(_sessGet('${D1}-s'))`)).toContain('Full, no waitlist');
    const l = patches(page);
    await page.evaluate(`toggleSession('${D1}-s','open')`);
    await expect.poll(() => l.length).toBe(1);
    expect(l[0].status).toBe('open');
    expect(slotsOf(l[0])).toEqual({ _time: '05:30 - 06:00' });
    await page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='${D1}-s'?${JSON.stringify(fb)}:s);toggleSession('${D1}-s','closed')`);
    await expect.poll(() => l.length).toBe(2);
    expect(l[1].status).toBe('closed');
    expect(slotsOf(l[1])).toEqual({ _time: '05:30 - 06:00' });
    // Open or Full Booked that leaves no mark writes the status alone, as before
    await page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='${D1}-s'?${JSON.stringify(ride())}:s);toggleSession('${D1}-s','full')`);
    await expect.poll(() => l.length).toBe(3);
    expect(l[2]).toEqual({ status: 'full' });
  });

  test('a closed session still ahead offers it; one called off or past does not', async ({ page }) => {
    const ahead = ride({ status: 'closed' });
    await staff(page, [ahead]);
    const more = async () => {
      await page.evaluate(`S.selSessionDetail='${D1}-s';renderSessions()`);
      await page.getByRole('button', { name: 'More actions' }).click();
    };
    await more();
    await expect(page.getByRole('menuitem', { name: 'Full, no waitlist', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.evaluate(`S.sessions=S.sessions.map(s=>({...s,cancelled_at:'2099-02-28T10:00:00Z'}))`);
    await more();
    await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Full, no waitlist', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.evaluate(`S.sessions=S.sessions.map(s=>({...s,cancelled_at:null,session_date:'2099-02-27',id:'${D1}-s'}))`);
    await more();
    await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Full, no waitlist', exact: true })).toHaveCount(0);
  });

  test('the edit form holds it as a status: opens on it and saves it', async ({ page }) => {
    await staff(page, [ride({ status: 'closed', bike_slots: '{"_time":"05:30 - 06:00","_fbk":1}' })]);
    const l = patches(page);
    await page.evaluate(`startEditSession('${D1}-s');renderSessions()`);
    expect(await page.evaluate('S.editSessStatus')).toBe('fbk');
    await expect(page.locator('.toggle-btn.active', { hasText: 'Full, no waitlist' })).toHaveCount(1);
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => l.length).toBeGreaterThan(0);
    expect(l[0].status).toBe('closed');
    expect(slotsOf(l[0])._fbk).toBe(1);
    // and Open on the form takes it off
    await page.evaluate(`startEditSession('${D1}-s');S.editSessStatus='open';_saveSessionEdit()`);
    await expect.poll(() => l.length).toBeGreaterThan(1);
    expect(l[1].status).toBe('open');
    expect(slotsOf(l[1])._fbk).toBeUndefined();
  });

  test('a copied week starts closed and unseen, never full', async ({ page }) => {
    const fb = ride({ status: 'closed', bike_slots: '{"_time":"05:30 - 06:00","_fbk":1}' });
    await staff(page, [fb]);
    const row = (await page.evaluate(`_n6sCopyRow(_sessGet('${D1}-s'),7)`)) as Record<string, unknown>;
    expect(row.status).toBe('closed');
    expect(slotsOf(row)._fbk).toBeUndefined();
    expect(await page.evaluate(`(parseSlots(_sessGet('${D1}-s').bike_slots)||{})._fbk`)).toBe(1); // the original keeps its own
  });
});
