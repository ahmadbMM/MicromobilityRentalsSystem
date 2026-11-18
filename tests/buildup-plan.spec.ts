import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Build-up plan (the user, 2026-11-18: "When a member books a big event (T100, Victory Lap and the like), the tab counts
// down the Saturdays left and suggests which ones to book. It ticks each one off once they've ridden it. It builds on Plan
// my Saturdays."). Staff mark the event with the session forms' Build-up plan switch (bike_slots._bup 1; never on a
// Saturday ride). On the Community tab, right after the hero, the member's nearest place held on a marked date still to
// come gets a card, until the last Saturday before it has passed: the event's title and date, the Saturdays to go, and one row per Saturday from the later of the
// booking's day and eight weeks before the event (Done, gone and dimmed, Booked, Book, Not open yet, ...). Everything
// comes from what the page already holds: no read of its own. All Supabase traffic is stubbed.

const EV = 'vl-1'; // Friday 18 December 2099
const absent = (fn: string) => ({ __rpcError: { status: 404, code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } });
const slot = (x: Record<string, unknown> = {}) => JSON.stringify({ _time: '06:00 - 06:30', _total: 40, ...x });
const sat = (date: string, o: Record<string, unknown> = {}) => ({ id: date, day: 'Saturday', session_date: date, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: slot(), ...o });
const event = (o: Record<string, unknown> = {}) => ({
  id: EV, day: 'Friday', session_date: '2099-12-18', capacity: 200, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'vlap',
  paid_ride: true, title: 'Victory Lap Spec', title_ar: 'فكتوري لاب تجربة', bike_slots: JSON.stringify({ _time: '16:00 - 17:00', _bup: 1 }), ...o,
});
const bk = (id: string, sid: string, date: string, status: string, o: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_date: date, session_day: 'Saturday', customer_id: 'c1', name: 'Spec Member', queue_num: 3, status, paid: true, price: 0,
  type_preference: 'Hybrid', registered_at: '2099-09-20T10:00:00Z', ...o,
});
// The record: Saturday rides done on 24 Oct and 7 Nov, checked in on 21 Nov (never marked done), a no-show on 14 Nov,
// a place held on 28 Nov; 5 Dec is open to book; 12 Dec has no ride yet. The event booked on 1 October.
const SESS = [
  sat('2099-10-24', { status: 'closed' }), sat('2099-10-31', { status: 'closed' }), sat('2099-11-07', { status: 'closed' }),
  sat('2099-11-14', { status: 'closed' }), sat('2099-11-21', { status: 'closed' }), sat('2099-11-28'), sat('2099-12-05'), event(),
];
const ROWS = [
  bk('b0', '2099-10-24', '2099-10-24', 'done'), bk('b1', '2099-11-07', '2099-11-07', 'done'), bk('b2', '2099-11-14', '2099-11-14', 'noshow'),
  bk('b3', '2099-11-21', '2099-11-21', 'active'), bk('b4', '2099-11-28', '2099-11-28', 'waiting'),
  bk('e1', EV, '2099-12-18', 'waiting', { session_day: 'Friday', registered_at: '2099-10-01T09:00:00Z', price: 150 }),
];
const feed = (today: string) => ({
  ok: true, today, me: { kind: 'level', target: 3, n: 1, ends_on: today.slice(0, 8) + '28', sats: 4, levels: [2, 3, 4], chosen: true },
  club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null,
});

async function member(page: Page, o: { at?: string; sessions?: Record<string, unknown>[]; rows?: Record<string, unknown>[]; lang?: string; gender?: string; fx?: Fixtures } = {}) {
  const at = o.at || '2099-11-25T18:00:00+03:00', sessions = o.sessions || SESS, rows = o.rows || ROWS;
  await page.clock.setFixedTime(new Date(at));
  await stubSupabase(page, {
    sessions, 'rpc:list_sessions': sessions, customers: [], queue_entries: rows, 'rpc:my_bookings': rows, bikes: [],
    'rpc:community_member': true, 'rpc:hub_feed': feed(at.slice(0, 10)), 'rpc:hub_plan': absent('hub_plan'), ...(o.fx || {}),
  });
  await loginCustomer(page, { id: 'c1', name: 'Spec Member', gender: o.gender || 'male', birth_date: '1990-01-01' });
  await page.goto('/' + (o.lang ? `?lang=${o.lang}` : ''));
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
}
const card = (page: Page) => page.locator('#hub-body .hub-bup');
const rowTexts = (page: Page) => card(page).locator('.hub-bup-r').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));

test.describe('@customer:members Build-up plan', () => {
  test('the card: right after the hero, the event by its own name, the Saturdays to go and one row per Saturday', async ({ page }) => {
    const reads: string[] = [];
    page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rpc\/(\w+)/); if (m) reads.push(m[1]!); });
    await member(page);
    await expect(card(page)).toBeVisible();
    await expect(page.locator('#hub-body .hub-hero + .hub-bup')).toHaveCount(1); // right after the next-session hero
    await expect(card(page).locator('.hub-k')).toHaveText('Build-up plan');
    await expect(card(page).locator('.hub-name')).toHaveText('Victory Lap Spec');
    await expect(card(page).locator('.hub-bup-w')).toHaveText('18 Dec 2099');
    await expect(card(page).locator('.hub-bup-n')).toHaveText('3 Saturdays to go'); // 28 Nov, 5 Dec, 12 Dec
    // eight weeks before the event (it was booked earlier than that): 24 Oct to 12 Dec
    expect(await rowTexts(page)).toEqual([
      '24 Oct Done', '31 Oct', '7 Nov Done', '14 Nov', '21 Nov Done', '28 Nov Booked', '5 Dec Book', '12 Dec Not open yet',
    ]);
    await expect(card(page).locator('.hub-bup-r.done .cu-ic')).toHaveCount(3); // a tick on each
    await expect(card(page).locator('.hub-bup-r.past')).toHaveCount(2); // gone and not ridden: the date alone, dimmed
    await expect(card(page).locator('.hub-bup-l')).toHaveAttribute('aria-label', 'Saturday rides');
    // the card's own words never call the event a ride (it may be a run or a race)
    expect(await card(page).innerText()).not.toMatch(/\bride|\bbike/i);
    // no read of its own
    expect(reads.filter((f) => /bup|build/i.test(f))).toEqual([]);
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
  });

  test('Book opens Reserve on that Saturday, as the hero\'s Book does', async ({ page }) => {
    await member(page);
    await card(page).locator('.hub-bup-r', { hasText: '5 Dec' }).getByRole('button', { name: 'Book' }).click();
    await expect.poll(() => page.evaluate('[S.custTab,S.selSession,S.selEvent]')).toEqual(['register', '2099-12-05', 'community']);
  });

  test('the rows start on the booking\'s day when it was made inside the eight weeks', async ({ page }) => {
    const rows = ROWS.map((r) => (r.id === 'e1' ? { ...r, registered_at: '2099-11-10T21:30:00Z' } : r)); // 11 Nov in Riyadh
    await member(page, { rows });
    expect(await rowTexts(page)).toEqual(['14 Nov', '21 Nov Done', '28 Nov Booked', '5 Dec Book', '12 Dec Not open yet']);
  });

  test('a Saturday on the waitlist, one fully booked, one called off, one not open to book and one for women only', async ({ page }) => {
    const sessions = [
      sat('2099-11-28', { status: 'full' }), sat('2099-12-05', { status: 'closed', bike_slots: slot({ _fbk: 1 }) }),
      sat('2099-12-12', { status: 'closed', cancelled_at: '2099-11-20T10:00:00Z' }), event({ session_date: '2099-12-25', day: 'Friday' }),
      sat('2099-12-19', { status: 'closed' }), sat('2099-12-19-w', { session_date: '2099-12-19', gender_only: 'female', bike_slots: slot() }),
      sat('2099-11-21', { status: 'closed' }),
    ];
    const rows = [bk('w1', '2099-11-28', '2099-11-28', 'waitlist'), bk('e1', EV, '2099-12-25', 'waiting', { registered_at: '2099-11-20T09:00:00Z' })];
    await member(page, { sessions, rows });
    await expect(card(page).locator('.hub-bup-n')).toHaveText('4 Saturdays to go');
    expect(await rowTexts(page)).toEqual(['21 Nov', '28 Nov On the waitlist', '5 Dec Fully booked', '12 Dec Cancelled', '19 Dec Not open yet']);
    await expect(card(page).getByRole('button')).toHaveCount(0);
  });

  test('today\'s Saturday counts as one to go, and a finished one today is Done', async ({ page }) => {
    const rows = [...ROWS.filter((r) => r.id !== 'b4'), bk('b4', '2099-11-28', '2099-11-28', 'done')];
    await member(page, { at: '2099-11-28T09:00:00+03:00', rows });
    await expect(card(page).locator('.hub-bup-n')).toHaveText('3 Saturdays to go');
    await expect(card(page).locator('.hub-bup-r').filter({ hasText: '28 Nov' })).toHaveText(/28 Nov\s*Done/);
  });

  test('one Saturday to go is said in the singular, in Arabic too', async ({ page }) => {
    await member(page, { at: '2099-12-11T09:00:00+03:00', lang: 'ar' }); // 7 days before: only 12 Dec is left
    await expect(card(page).locator('.hub-k')).toHaveText('خطة الاستعداد');
    await expect(card(page).locator('.hub-name')).toHaveText('فكتوري لاب تجربة');
    await expect(card(page).locator('.hub-bup-n')).toHaveText('يتبقى سبت واحد');
  });

  test('the count in Arabic', async ({ page }) => {
    await member(page, { lang: 'ar' });
    await expect(card(page).locator('.hub-bup-n')).toHaveText('أيام السبت المتبقية: 3');
  });

  for (const [what, o] of [
    ['a date without the Build-up plan', { sessions: SESS.map((s) => (s.id === EV ? event({ bike_slots: JSON.stringify({ _time: '16:00 - 17:00' }) }) : s)) }],
    ['no Saturday left before the event (Sunday before a Friday event)', { at: '2099-12-13T09:00:00+03:00' }],
    ['the event started', { at: '2099-12-18T18:00:00+03:00' }],
    ['the booking cancelled', { rows: ROWS.map((r) => (r.id === 'e1' ? { ...r, status: 'cancelled' } : r)) }],
    ['the booking on the waitlist', { rows: ROWS.map((r) => (r.id === 'e1' ? { ...r, status: 'waitlist' } : r)) }],
    ['the event called off', { sessions: SESS.map((s) => (s.id === EV ? event({ cancelled_at: '2099-11-20T10:00:00Z', status: 'closed' }) : s)) }],
    ['a Saturday ride carrying the mark', { sessions: SESS.map((s) => (s.id === EV ? sat('2099-12-19', { id: EV, bike_slots: slot({ _bup: 1 }) }) : s)) }],
  ] as const) {
    test(`no card: ${what}`, async ({ page }) => {
      await member(page, o as Parameters<typeof member>[1]);
      await expect(page.locator('#hub-body .hub-card').first()).toBeVisible();
      await expect(card(page)).toHaveCount(0);
    });
  }

  test('a Friday event six days ahead: the card stays, with that Saturday the one to go', async ({ page }) => {
    await member(page, { at: '2099-12-12T07:00:00+03:00' }); // Saturday 12 December; the event is Friday 18 December
    await expect(card(page).locator('.hub-bup-n')).toHaveText('1 Saturday to go');
    expect((await rowTexts(page)).slice(-2)).toEqual(['5 Dec', '12 Dec Not open yet']);
  });

  test('a Sunday event two days ahead: the next day\'s Saturday is on the card, bookable', async ({ page }) => {
    const sessions = [...SESS.filter((s) => s.id !== EV), sat('2099-12-19'), event({ session_date: '2099-12-20', day: 'Sunday' })];
    const rows = ROWS.map((r) => (r.id === 'e1' ? { ...r, session_date: '2099-12-20', session_day: 'Sunday' } : r));
    await member(page, { at: '2099-12-18T10:00:00+03:00', sessions, rows });
    await expect(card(page).locator('.hub-bup-n')).toHaveText('1 Saturday to go');
    await expect(card(page).locator('.hub-bup-r').last()).toHaveText(/19 Dec\s*Book/);
    await card(page).locator('.hub-bup-r').last().getByRole('button', { name: 'Book' }).click();
    await expect.poll(() => page.evaluate('[S.custTab,S.selSession]')).toEqual(['register', '2099-12-19']);
  });

  test('the nearest marked event still to come is the one planned for', async ({ page }) => {
    const sessions = [...SESS, event({ id: 'rh-1', session_date: '2100-01-08', ride_kind: 'runher', title: 'Later Run Spec' })];
    const rows = [...ROWS, bk('e2', 'rh-1', '2100-01-08', 'waiting', { registered_at: '2099-10-01T09:00:00Z' })];
    await member(page, { at: '2099-12-11T00:10:00+03:00', sessions, rows });
    await expect(card(page)).toHaveCount(1);
    await expect(card(page).locator('.hub-name')).toHaveText('Victory Lap Spec');
  });
});

test.describe('@staff:sessions Build-up plan switch', () => {
  const FARM = '2099-11-19-fh';
  const farm = {
    id: FARM, session_date: '2099-11-19', day: 'Thursday', status: 'open', capacity: 130, created_at: 1, event_kind: 'community', ride_kind: 'farm',
    needs_approval: true, hide_queue: true, spots: 130, open_to_all: false, paid_ride: false, title: 'Farm Spec Night', location: 'Farm Spec',
    bike_slots: '{"_time":"16:30 - 20:30","_total":130}',
  };
  const satS = sat('2099-11-21', { bike_slots: slot() });
  async function staffBoot(page: Page, sessions: Record<string, unknown>[]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await page.route(/\/rest\/v1\/sessions\?/, async (r) => {
      if (r.request().method() !== 'PATCH') return r.fallback();
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'x' }]) });
    });
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'PATCH' || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
      try { const b = r.postDataJSON(); patches.push(Array.isArray(b) ? b[0] : b); } catch { /* none */ }
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S.dataLoaded&&allSessions().length===${sessions.length}`);
    return patches;
  }
  const slotsOf = (p: Record<string, unknown>) => JSON.parse(String(p.bike_slots)) as Record<string, unknown>;
  const withBup = (s: Record<string, unknown>) => ({ ...s, bike_slots: JSON.stringify({ ...JSON.parse(String(s.bike_slots)), _bup: 1 }) });

  test('the edit form opens on what the date has, stores it, keeps it through a save and takes it off', async ({ page }) => {
    const patches = await staffBoot(page, [farm, satS]);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${FARM}')`);
    await expect(page.locator('#sess-edit-form')).toBeVisible();
    await expect(page.locator('#es-bup')).not.toBeChecked();
    await expect(page.locator('label:has(#es-bup)')).toContainText('Build-up plan');
    await page.locator('#es-bup').check();
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(1);
    expect(slotsOf(patches[0]!)).toMatchObject({ _time: '16:30 - 20:30', _bup: 1 });
  });

  test('a date that has it keeps it when saved untouched, and loses it once switched off', async ({ page }) => {
    const patches = await staffBoot(page, [withBup(farm), satS]);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${FARM}')`);
    await expect(page.locator('#es-bup')).toBeChecked();
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(1);
    expect(slotsOf(patches[0]!)._bup).toBe(1);
    await page.evaluate(`startEditSession('${FARM}')`);
    await page.locator('#es-bup').uncheck();
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(2);
    expect('_bup' in slotsOf(patches[1]!)).toBe(false);
  });

  test('never on the Saturday ride: neither form offers it', async ({ page }) => {
    await staffBoot(page, [farm, satS]);
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-11-21')`);
    await expect(page.locator('#sess-edit-form')).toBeVisible();
    await expect(page.locator('#es-few')).toHaveCount(1);
    await expect(page.locator('#es-bup')).toHaveCount(0);
    await page.evaluate(`S.editSessionId=null;S.showAddSession=true;S.newSessEvent='community';renderSessions()`);
    await expect(page.locator('#ns-few')).toHaveCount(1);
    await expect(page.locator('#ns-bup')).toHaveCount(0);
    await page.evaluate(`S.newSessBup=true`); // even a state left on from another kind stores nothing on a Saturday ride
    expect(await page.evaluate(`'_bup' in _nsSlots('06:00 - 06:30','').slots`)).toBe(false);
  });

  test('the new form starts off and stores it once switched on; a reset, a copy and the agenda', async ({ page }) => {
    await staffBoot(page, [withBup(farm), satS]);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await page.locator('#tab-sessions .ev-pick.ev-farm').click();
    await expect(page.locator('#ns-bup')).not.toBeChecked();
    expect(await page.evaluate(`'_bup' in _nsSlots('16:30 - 20:30','').slots`)).toBe(false);
    await page.locator('#ns-bup').check();
    expect(await page.evaluate(`_nsSlots('16:30 - 20:30','').slots._bup`)).toBe(1);
    await page.evaluate(`_n6sFormReset();renderSessions()`);
    await expect(page.locator('#ns-bup')).not.toBeChecked();
    // a copied week starts without it
    const row = (await page.evaluate(`_n6sCopyRow(_sessGet('${FARM}'),7)`)) as Record<string, unknown>;
    expect('_bup' in slotsOf(row)).toBe(false);
    // the Sessions agenda marks a date that has it
    expect(await page.evaluate(`[_sessExtrasHtml(_sessGet('${FARM}'),{feat:true}).includes('ssx-bup'),_sessExtrasHtml(_sessGet('2099-11-21'),{feat:true}).includes('ssx-bup')]`)).toEqual([true, false]);
  });
});
