import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, stubRealtime, loginCustomer, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The Store and Experiences build (the user, 2026-11-18: "do all"), the booking app's half (B10):
// - EM04-B mirrored into the Reserve flow's Continue bar: shown only with a date to choose, opaque paper, hidden while the
//   keyboard is up, the page's scroll padding following the bar's own height, the last button naming the amount ("Book"
//   alone on a free ride), Back kept inside it;
// - EF23 test rides: a kind of its own (never read as a Saturday ride), reached by the website's link, made by staff where
//   the database has the store;
// - the staff screens: Payments > Experiences (lesson packs, gifts and packs sold, the xp.* settings), the payment kind xp,
//   the early-bird mark on a booking, and "Store order to hand over" in the check-in drawer (N15).
// All Supabase traffic stubbed; invented data only.

const OPEN = '2099-02-01', FULL = '2099-02-03', SAT = '2099-02-06', TR = '2099-02-08-tr';
const night = (id: string, day: string, extra: Record<string, unknown> = {}) => ({
  id, session_date: id.slice(0, 10), day, status: 'open', capacity: 10, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":10}', ...extra,
});
const sat = night(SAT, 'Saturday', { event_kind: 'community', ride_kind: 'saturday', needs_approval: true, bike_slots: '{"_time":"06:00 - 08:00","_total":10}' });
const testRide = night(TR, 'Monday', { event_kind: 'community', ride_kind: 'testride', open_to_all: true, needs_approval: false, bike_slots: '{"_time":"17:00 - 18:00","_total":6}' });
const sessions = [night(OPEN, 'Sunday'), night(FULL, 'Tuesday', { status: 'full' }), sat, testRide];

async function rider(page: Page, lang: 'en' | 'ar') {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
  if (lang === 'ar') await page.addInitScript(() => localStorage.setItem('cq_lang', 'ar'));
  await page.goto('/');
  await waitForSb(page);
}
const at = (sid: string, step: number, ev = 'jcc', extra = '') => `S.lastTickets=[];S.selEvent='${ev}';goCustomer('register');S.selSession='${sid}';S.regQty=1;
  S.regBikeHeights=['175'];S.regBikeTypes=['Road'];S.regRiderNames=['Spec Rider'];S.promoApplied=null;S.regStep=${step};${extra}renderRegister();`;
const bar = (page: Page) => page.locator('#tab-register .mm-reg-foot');
const WORDS = {
  en: { book: 'Book', wl: 'Join waitlist', back: 'Back', opens: 'Booking opens' },
  ar: { book: 'احجز', wl: 'انضم إلى قائمة الانتظار', back: 'رجوع', opens: 'يفتح الحجز' },
};

for (const lang of ['en', 'ar'] as const) {
  test.describe(`@customer:reserve the Continue bar on a phone (EM04-B, ${lang})`, () => {
    test('no bar while nothing can be chosen; with a date, Continue rests until a pick; opaque, fixed, hidden with the keyboard', async ({ page }) => {
      await rider(page, lang);
      const W = WORDS[lang];
      // every date's booking window still shut: the cards say when it opens, and no bar holds a dead Continue
      await page.evaluate(`S._bw={days:400,at:null};S.lastTickets=[];S.selEvent='jcc';S.selSession=null;S.regStep=1;goCustomer('register');renderRegister();`);
      await expect(page.locator('#tab-register .sess-card-soon').first()).toContainText(W.opens);
      await expect(bar(page)).toHaveCount(0);
      // the windows open: the bar, its Continue resting until a date is picked
      await page.evaluate(`S._bw={days:null,at:null};renderRegister();`);
      await expect(bar(page)).toBeVisible();
      await expect(bar(page).locator('.btn-primary')).toBeDisabled();
      const look = await bar(page).evaluate((el) => { const c = getComputedStyle(el); return { pos: c.position, bg: c.backgroundColor, bf: c.backdropFilter || 'none' }; });
      expect(look.pos).toBe('fixed');
      expect(look.bg).toMatch(/^rgb\(/); // opaque paper: no alpha channel
      expect(look.bf).toBe('none');
      await page.locator('#tab-register .sess-card').first().click();
      await expect(bar(page).locator('.btn-primary')).toBeEnabled();
      // the page keeps the bar's own height (+20px) clear under a focused field
      await expect.poll(() => page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--reg-foot-h').trim()`))
        .toBe(`${await bar(page).evaluate((el) => (el as HTMLElement).offsetHeight)}px`);
      const pad = await page.evaluate(`parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom)`);
      expect(pad).toBe(await bar(page).evaluate((el) => (el as HTMLElement).offsetHeight + 20));
      // the keyboard up: the bar goes; the state is read again as the focus moves (no keyboard here, so a field's focus ends it)
      await page.evaluate(`document.documentElement.classList.add('kb-open')`);
      await expect(bar(page)).toBeHidden();
      await page.evaluate(at(OPEN, 2));
      await page.evaluate(`document.documentElement.classList.add('kb-open')`);
      await expect(bar(page)).toBeHidden();
      await page.locator('#reg-height-0').focus();
      await expect.poll(() => page.evaluate(`document.documentElement.classList.contains('kb-open')`)).toBe(false);
      await expect(bar(page)).toBeVisible();
      await expect(bar(page).locator('.btn-secondary')).toHaveText(W.back); // Back stays inside the bar
    });

    test('the last button names the amount, says Book alone on a free ride and Join waitlist on a full night', async ({ page }) => {
      await rider(page, lang);
      const W = WORDS[lang];
      const go = bar(page).locator('.btn-primary');
      await page.evaluate(at(OPEN, 3, 'jcc', 'S.waiverOk=true;S._waiverSess=S.selSession;'));
      await expect(go).toHaveText(new RegExp(`^${W.book} .*75`));
      await expect(go).toBeEnabled();
      await expect(bar(page).locator('.btn-secondary')).toHaveText(W.back);
      await page.evaluate(at(FULL, 3, 'jcc', 'S.waiverOk=true;S._waiverSess=S.selSession;'));
      await expect(go).toHaveText(W.wl);
      await page.evaluate(at(SAT, 3, 'community', 'S.waiverOk=true;S._waiverSess=S.selSession;'));
      await expect(go).toHaveText(W.book); // free: no amount
      // the waiver not ticked yet: the button rests (unchanged)
      await page.evaluate(at(OPEN, 3, 'jcc', 'S.waiverOk=false;'));
      await expect(go).toBeDisabled();
    });
  });
}

test.describe('@customer:reserve test rides (EF23)', () => {
  test('a test ride is a kind of its own: never a Saturday ride, off the Experiences list, opened by the website\'s link', async ({ page }) => {
    await rider(page, 'en');
    const k = await page.evaluate(`(()=>{const s=_sessDisp('${TR}');return[_rideKind(s),_evMatch(s,'community'),_evMatch(s,'testride'),_evOf(s),_needsBike(s),_isFreeRide(s),_evName(s),_hasBreakfast(s)];})()`);
    expect(k).toEqual(['testride', false, true, 'testride', true, true, 'Test ride', false]);
    await page.evaluate(`selectEvent('testride')`);
    await expect.poll(() => page.evaluate('S.selEvent')).toBe('testride');
    await expect(page.locator('#tab-register .sess-card')).toHaveCount(1);
    await page.locator('#tab-register .sess-card').click();
    await expect(bar(page).locator('.btn-primary')).toBeEnabled();
    // the website hands a rider over with ?ev=testride&session=<id>: parked for the event picker
    const page2 = await page.context().newPage();
    await stubSupabase(page2, { sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [] });
    await page2.goto(`/?ev=testride&session=${TR}`);
    await waitForSb(page2);
    await expect.poll(() => page2.evaluate(`S.selEvent==='testride'?S.selSession:JSON.parse(sessionStorage.getItem('cq_open_event')||'null')`))
      .toEqual(expect.anything());
    const parked = await page2.evaluate(`S.selEvent==='testride'?{ev:S.selEvent,session:S.selSession}:JSON.parse(sessionStorage.getItem('cq_open_event')||'null')`);
    expect(parked).toEqual({ ev: 'testride', session: TR });
  });
});

// ── Staff ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const NOW = '2026-11-18T09:00:00Z';
function rpcCalls(page: Page) {
  const seen: { name: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (!m || r.method() !== 'POST') return;
    let body = {}; try { body = r.postDataJSON() || {}; } catch { /* none */ }
    seen.push({ name: m[1], body });
  });
  return seen;
}
function writes(page: Page, table: string) {
  const seen: { method: string; body: unknown }[] = [];
  page.on('request', (r) => {
    if (!r.url().includes(`/rest/v1/${table}`) || !['POST', 'PATCH', 'DELETE'].includes(r.method())) return;
    let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
    seen.push({ method: r.method(), body });
  });
  return seen;
}
async function staff(page: Page, fx: Fixtures = {}, url = '/?staff') {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await page.setViewportSize({ width: 1280, height: 900 });
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [], staff_options: [], 'rpc:staff_operator_list': ops, ...fx });
  await unlockStaff(page);
  await page.goto(url);
  await waitForSb(page);
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='admin';renderStaffTabs();`);
}
const packs = [{ id: 'pk1', kind: 'jcc', title_en: 'Four circuit nights', title_ar: 'أربع ليالٍ في الحلبة', lessons: 4, price: 600, bike_type: 'Road', months: 6, active: true, sold: 2, created_at: NOW }];
const sold = [
  { id: 'x1', what: 'gift', customer_id: 'c1', customer: 'Huda Buyer', kind: 'jcc', bike_type: 'Hybrid', lessons: 1, amount: 75, for_name: 'Sara', note: null, status: 'paid',
    code: 'GF-AB12CD34', payment_id: 'p1', expires_on: '2027-11-18', created_at: NOW, paid_at: NOW, uses: 0, max_uses: 1, active: true },
  { id: 'x2', what: 'pack', customer_id: 'c2', customer: 'Omar Pack', kind: 'jcc', bike_type: 'Road', lessons: 4, amount: 600, for_name: null, note: null, status: 'paid',
    code: 'PK-ZZ99YY88', payment_id: 'p2', expires_on: '2027-05-18', created_at: NOW, paid_at: NOW, uses: 1, max_uses: 4, active: true },
  { id: 'x3', what: 'gift', customer_id: 'c1', customer: 'Huda Buyer', kind: 'jcc', bike_type: 'Road', lessons: 1, amount: 75, for_name: null, note: null, status: 'void',
    code: 'GF-VOID0000', payment_id: 'p3', expires_on: '2027-11-18', created_at: NOW, paid_at: NOW, uses: 0, max_uses: 1, active: false },
];

test.describe('@staff:payments Payments > Experiences (EF20, EF21, B6\'s settings)', () => {
  test('the packs and what was sold; a pack made with its checks; Experiences as a payment\'s kind', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { 'rpc:staff_store_ready': true, 'rpc:staff_xp_packs': packs, 'rpc:staff_xp_purchases': sold, site_content: [],
      'rpc:staff_xp_pack_save': { ...packs[0], id: 'pk2', title_en: 'Four pool mornings', kind: 'swim', bike_type: null, price: 400 },
      'rpc:staff_payments': [{ id: 'p1', kind: 'xp', ref: 'x1', refs: ['x1'], amount: 75, status: 'paid', description: 'Gift ride · Hybrid', customer: 'Huda Buyer', customer_id: 'c1', paid_at: NOW, created_at: NOW, refunds: [], refunded: 0 }],
      payment_refunds: [] });
    await page.evaluate(`S.payView='xp';setStaffTab('payments')`);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/payments/experiences');
    const sec = page.locator('#tab-payments');
    await expect(sec.locator('.filter-pill[aria-pressed="true"]')).toHaveText('Experiences');
    const pk = sec.locator('.xp-row', { hasText: 'Four circuit nights' });
    await expect(pk).toContainText('4 sessions');
    await expect(pk).toContainText('SAR 600');
    await expect(pk).toContainText('2 sold');
    await expect(pk).toContainText('Active');
    await expect(sec.locator('.xp-row', { hasText: 'GF-AB12CD34' })).toContainText('Used 0 of 1');
    await expect(sec.locator('.xp-row', { hasText: 'GF-AB12CD34' })).toContainText('For Sara');
    await expect(sec.locator('.xp-row', { hasText: 'PK-ZZ99YY88' })).toContainText('Used 1 of 4');
    await expect(sec.locator('.xp-row', { hasText: 'GF-VOID0000' })).toContainText('Void');
    // a new pack: the name and the ranges are checked before anything is sent
    await sec.locator('.pay-set-add', { hasText: 'New pack' }).click();
    const dlg = page.locator('#xp-pk [role="dialog"]');
    await expect(dlg).toBeVisible();
    await expect(dlg).toHaveAttribute('aria-labelledby', 'xp-pk-t');
    await dlg.locator('#xp-pk-go').click();
    await expect(dlg.locator('.sto-err')).toHaveText('Give the pack a name in English.');
    await dlg.locator('#xp-pk-k').selectOption('swim');
    await dlg.locator('#xp-pk-en').fill('Four pool mornings');
    await dlg.locator('#xp-pk-n').fill('30');
    await dlg.locator('#xp-pk-p').fill('400');
    await dlg.locator('#xp-pk-go').click();
    await expect(dlg.locator('.sto-err')).toContainText('from 2 to 20');
    expect(seen.filter((c) => c.name === 'staff_xp_pack_save')).toHaveLength(0);
    await dlg.locator('#xp-pk-n').fill('4');
    await expect(dlg.locator('#xp-pk-ty option')).not.toContainText(['Any']); // no "Any" bike type on a pack
    await dlg.locator('#xp-pk-go').click();
    await expect(dlg).toHaveCount(0);
    expect(seen.find((c) => c.name === 'staff_xp_pack_save')!.body).toEqual({ p_pack: { id: null, kind: 'swim', title_en: 'Four pool mornings', title_ar: null,
      lessons: 4, price: 400, bike_type: null, months: 6, active: true } });
    await expect(sec.locator('.xp-row', { hasText: 'Four pool mornings' })).toBeVisible();
    await expect(page.locator('#toast-container')).toContainText('Pack saved');
    // the payments list names the kind, and its filter offers it
    await sec.locator('.pay-views .filter-pill').first().click(); // Payments
    await expect(sec.locator('.pay-row', { hasText: 'Gift ride' })).toContainText('Experiences');
    expect(await page.evaluate(`[...document.querySelectorAll('#pay-kind option')].map(o=>o.value)`)).toContain('xp');
  });

  test('a refused save is said in the pop-up, which stays open', async ({ page }) => {
    await staff(page, { 'rpc:staff_store_ready': true, 'rpc:staff_xp_packs': packs, 'rpc:staff_xp_purchases': [], site_content: [],
      'rpc:staff_xp_pack_save': { __rpcError: { status: 403, code: '42501', message: 'ADMIN_ONLY' } } });
    await page.evaluate(`S.payView='xp';setStaffTab('payments')`);
    await page.locator('#tab-payments .xp-row', { hasText: 'Four circuit nights' }).getByRole('button', { name: 'Edit' }).click();
    const dlg = page.locator('#xp-pk [role="dialog"]');
    await expect(dlg.locator('#xp-pk-en')).toHaveValue('Four circuit nights');
    await expect(dlg.locator('#xp-pk-ty')).toHaveValue('Road');
    await dlg.locator('#xp-pk-go').click();
    await expect(dlg.locator('.sto-err')).toHaveText('Admin only.');
    await expect(dlg).toBeVisible();
  });

  test('the xp.* settings: the early bird refused without the discount licence, the rest written as the Website editor writes', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { 'rpc:staff_store_ready': true, 'rpc:staff_xp_packs': [], 'rpc:staff_xp_purchases': [],
      site_content: [{ key: 'xp.general.weatherDays', value: 5, updated_at: NOW }] });
    await page.evaluate(`S.payView='xp';setStaffTab('payments')`);
    const sec = page.locator('#tab-payments');
    await expect(sec.locator('#xs-wx')).toHaveValue('5');
    await expect(sec.locator('#xs-priv')).toBeChecked(); // the website's defaults: private requests and calendars on, test rides off
    await expect(sec.locator('#xs-cal')).toBeChecked();
    await expect(sec.locator('#xs-test')).not.toBeChecked();
    await expect(sec.locator('#xs-ebk-jcc')).toBeChecked();
    await sec.locator('#xs-eb').check();
    await sec.locator('#xs-save').click();
    await expect(page.locator('#toast-container')).toContainText('discount licence');
    expect(sc).toHaveLength(0);
    await sec.locator('#xs-eb').uncheck();
    await sec.locator('#xs-gift').check();
    await sec.locator('#xs-test').check();
    await sec.locator('#xs-wx').fill('3');
    await sec.locator('#xs-kitn').fill('Garmin-Varia, x y z w');
    await sec.locator('#xs-save').click();
    await expect(page.locator('#toast-container')).toContainText('Up to 3 product addresses');
    await sec.locator('#xs-kitn').fill('garmin-varia, front-light');
    await sec.locator('#xs-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    const by = Object.fromEntries((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(by).toEqual({ 'xp.gifts': { on: true }, 'xp.kit': { night: ['garmin-varia', 'front-light'], saturday: [] },
      'xp.general.testRides': true, 'xp.general.weatherDays': 3 });
  });

  test('a database without the Experiences functions says so', async ({ page }) => {
    await staff(page, { 'rpc:staff_store_ready': true, site_content: [],
      'rpc:staff_xp_packs': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_xp_packs in the schema cache' } } });
    await page.evaluate(`S.payView='xp';setStaffTab('payments')`);
    await expect(page.locator('#tab-payments')).toContainText('The online store is not set up on this database yet');
  });
});

test.describe('@staff:bookings the early bird and the store order handed over at the session (EF29, N15)', () => {
  const DAY = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const s1 = { id: 's1', day: 'Tuesday', session_date: DAY, capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' };
  const bk = (id: string, n: number, x: Record<string, unknown> = {}) => ({ id, session_id: 's1', session_day: 'Tuesday', session_date: DAY, queue_num: n, name: 'Rider ' + n,
    customer_id: 'c' + n, phone: '0500000000', type_preference: 'Road', height: 175, status: 'waiting', paid: false, price: 67.5, registered_at: NOW, ...x });
  const queue = [bk('q1', 1, { xp_early: 10 }), bk('q2', 2)];
  const hand = [{ id: 'o42', no: 1042, status: 'ready', entry: 'q1', name: 'Rider 1', phone: '966500000000', items: [{ name: 'Water bottle', variant: '750 ml', qty: 2 }, { name: 'Bell', variant: null, qty: 1 }] }];
  async function desk(page: Page, fx: Fixtures) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [s1], queue_entries: queue, bikes: [], customers: [], ...fx });
    await stubRealtime(page);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');setSfSession('s1')`);
  }
  const drawer = (page: Page) => page.locator('#checkin-modal [role="dialog"]');

  test('a booking priced early says so on its row', async ({ page }) => {
    await desk(page, {});
    const row = page.locator('.queue-table tbody tr, .q-card').filter({ hasText: 'Rider 1' }).first();
    await expect(row.locator('.xpe-badge')).toHaveText('Early bird −10%');
    await expect(page.locator('.queue-table tbody tr, .q-card').filter({ hasText: 'Rider 2' }).first().locator('.xpe-badge')).toHaveCount(0);
  });

  test('the check-in drawer names the store order to hand over to this rider, and Handed over marks it delivered', async ({ page }) => {
    const seen = rpcCalls(page);
    await desk(page, { 'rpc:staff_store_ready': true, 'rpc:staff_store_session_handovers': hand, 'rpc:staff_store_order_set': { id: 'o42', status: 'delivered' } });
    await expect.poll(() => page.evaluate('S._storeReady')).toBe(true);
    await page.evaluate(`showCheckinModal('q1')`);
    const box = drawer(page).locator('.sxh');
    await expect(box).toBeVisible();
    await expect(box).toContainText('Store order to hand over');
    await expect(box).toContainText('MM-1042');
    await expect(box).toContainText('2 × Water bottle · 750 ml, Bell');
    expect(seen.find((c) => c.name === 'staff_store_session_handovers')!.body).toEqual({ p_session: 's1' });
    await box.getByRole('button', { name: 'Handed over' }).click();
    await expect(drawer(page).locator('.sxh')).toHaveCount(0);
    expect(seen.find((c) => c.name === 'staff_store_order_set')!.body).toMatchObject({ p_order: 'o42', p_status: 'delivered' });
    await expect(page.locator('#toast-container')).toContainText('MM-1042 handed over');
    // another rider's drawer: nothing of this order
    await page.evaluate(`closeCheckinModal();showCheckinModal('q2')`);
    await expect(drawer(page)).toContainText('Rider 2');
    await expect(drawer(page).locator('.sxh')).toHaveCount(0);
  });

  test('a refusal is said and the order stays; without the store (production) nothing is asked', async ({ page }) => {
    const seen = rpcCalls(page);
    await desk(page, { 'rpc:staff_store_ready': true, 'rpc:staff_store_session_handovers': hand,
      'rpc:staff_store_order_set': { __rpcError: { status: 400, code: 'P0001', message: 'STORE_STATE: delivered' } } });
    await expect.poll(() => page.evaluate('S._storeReady')).toBe(true);
    await page.evaluate(`showCheckinModal('q1')`);
    await drawer(page).locator('.sxh').getByRole('button', { name: 'Handed over' }).click();
    await expect(page.locator('#toast-container .toast.error')).toBeVisible();
    await expect(drawer(page).locator('.sxh')).toContainText('MM-1042');
    const p2 = await page.context().newPage();
    const seen2 = rpcCalls(p2);
    await desk(p2, { 'rpc:staff_store_session_handovers': hand });
    await expect.poll(() => p2.evaluate('S._storeReady')).toBe(false);
    await p2.evaluate(`showCheckinModal('q1')`);
    await expect(p2.locator('#checkin-modal [role="dialog"]')).toContainText('Rider 1');
    await expect(p2.locator('#checkin-modal .sxh')).toHaveCount(0);
    expect(seen2.filter((c) => c.name === 'staff_store_session_handovers')).toHaveLength(0);
    expect(seen.filter((c) => c.name === 'staff_store_session_handovers').length).toBeGreaterThan(0);
  });
});

test.describe('@staff:sessions test rides (EF23)', () => {
  test('offered only where the database has the store; made open to everyone, free, first come first served, -tr', async ({ page }) => {
    const d9 = new Date(Date.now() + 9 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    await staff(page, { sessions: [night(OPEN, 'Sunday')] }, '/');
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await expect(page.locator('#tab-sessions .ev-pick.ev-jcc')).toBeVisible();
    await expect(page.locator('#tab-sessions .ev-pick.ev-testride')).toHaveCount(0); // production: no store, no test rides
    const hints = await page.locator('#tab-sessions .ss-hint').count(); // the circuit's form: no kind hint
    await page.evaluate(`S._storeReady=true;renderSessions()`);
    const posts: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/sessions') && r.method() === 'POST') { try { posts.push(r.postDataJSON()); } catch { /* */ } } });
    await page.locator('#tab-sessions .ev-pick.ev-testride').click();
    await expect(page.locator('#tab-sessions .ev-pick.ev-testride')).toHaveText('Test ride');
    await expect(page.locator('#tab-sessions .ss-hint')).toHaveCount(hints); // no hint line of its own (not the Saturday ride's)
    expect(await page.evaluate(`[_nsComm(),_nsSeats(),_sessIdSuffix('testride')]`)).toEqual([true, true, '-tr']);
    await page.locator('#ns-date').fill(d9);
    await page.locator('#ns-start').fill('17:00');
    await page.locator('#ns-end').fill('18:00');
    await page.evaluate(`addSession()`);
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ id: d9 + '-tr', event_kind: 'community', ride_kind: 'testride', open_to_all: true, paid_ride: false, needs_approval: false, title: null });
  });
});

// ── B10 follow-up: the passkeys' staff side (N06; B7, migration 20261119300100, switch account.passkeys OFF) ─────────────
test.describe('@staff:people passkeys on the account window, the switch, the activity words (N06)', () => {
  const cust = { id: 'cust-pk', name: 'Lina Key', phone: '+966500000077', email: 'lina@example.test', created_at: '2026-01-01T00:00:00Z' };
  const items = [
    { id: '11111111-1111-4111-8111-111111111111', label: 'icloud', created_at: '2026-11-01T10:00:00Z', last_used_at: '2026-11-17T10:00:00Z', backed_up: true, counter_flag_at: null, live: true },
    { id: '22222222-2222-4222-8222-222222222222', label: 'android', created_at: '2026-11-05T10:00:00Z', last_used_at: null, backed_up: false, counter_flag_at: '2026-11-16T10:00:00Z', live: false },
  ];
  const win = (page: Page) => page.locator('#cust-modal');

  test('the account window lists the passkeys with their marks; Remove one and Remove all, each asked first', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { customers: [cust], 'rpc:staff_store_ready': true, 'rpc:staff_passkeys': { on: false, items }, 'rpc:staff_passkey_remove': { removed: 1 } });
    await expect.poll(() => page.evaluate('S._storeReady')).toBe(true);
    await page.evaluate(`openAccountHistory('cust-pk')`);
    const sec = win(page).locator('.pk-ah');
    await expect(sec).toContainText('Passkeys');
    await expect(sec.locator('.pk-li')).toHaveCount(2);
    const one = sec.locator('.pk-li').nth(0), two = sec.locator('.pk-li').nth(1);
    await expect(one).toContainText('iCloud Keychain');
    await expect(one).toContainText('Synced');
    await expect(one).toContainText('Last used');
    await expect(two).toContainText('Android phone');
    await expect(two.locator('.pk-warn')).toContainText('Possible copy'); // counter_flag_at
    await expect(two).toContainText('Signed out');                        // live false
    expect(seen.find((c) => c.name === 'staff_passkeys')!.body).toEqual({ p_customer: 'cust-pk' });
    // Remove one: asked in a centred pop-up, then the one passkey
    await one.getByRole('button', { name: 'Remove', exact: true }).click();
    const dlg = page.locator('#confirm-modal [role="dialog"], .modal-backdrop [role="dialog"]').filter({ hasText: 'Remove the passkey iCloud Keychain?' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_passkey_remove').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_passkey_remove')!.body).toEqual({ p_customer: 'cust-pk', p_passkey: items[0].id });
    await expect(page.locator('#toast-container')).toContainText('Passkeys removed: 1');
    // Remove all: every passkey of the account (p_passkey null)
    await sec.locator('.pk-all').click();
    const all = page.locator('[role="dialog"]').filter({ hasText: 'Remove all 2 passkeys of Lina Key?' });
    await expect(all).toBeVisible();
    await all.getByRole('button', { name: 'Remove all' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_passkey_remove').length).toBe(2);
    expect(seen.filter((c) => c.name === 'staff_passkey_remove')[1].body).toEqual({ p_customer: 'cust-pk', p_passkey: null });
  });

  test('a refused removal is said; without the store (production) nothing is asked; a database without passkeys is not asked again', async ({ page }) => {
    await staff(page, { customers: [cust], 'rpc:staff_store_ready': true, 'rpc:staff_passkeys': { on: true, items: [items[0]] },
      'rpc:staff_passkey_remove': { __rpcError: { status: 403, code: '42501', message: 'STAFF_ONLY' } } });
    await expect.poll(() => page.evaluate('S._storeReady')).toBe(true);
    await page.evaluate(`openAccountHistory('cust-pk')`);
    await win(page).locator('.pk-li').getByRole('button', { name: 'Remove', exact: true }).click();
    await page.locator('[role="dialog"]').filter({ hasText: 'Remove the passkey' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('#toast-container .toast.error')).toBeVisible();
    await expect(win(page).locator('.pk-li')).toHaveCount(1);
    // production: no staff_store_ready, so no staff_passkeys either
    const p2 = await page.context().newPage();
    const seen2 = rpcCalls(p2);
    await staff(p2, { customers: [cust], 'rpc:staff_passkeys': { on: true, items } });
    await expect.poll(() => p2.evaluate('S._storeReady')).toBe(false);
    await p2.evaluate(`openAccountHistory('cust-pk')`);
    await expect(p2.locator('#cust-modal')).toContainText('Lina Key');
    await expect(p2.locator('#cust-modal .pk-ah')).toHaveCount(0);
    expect(seen2.filter((c) => c.name === 'staff_passkeys')).toHaveLength(0);
    // the store but not the passkeys (404): no section, and the next window does not ask again
    const p3 = await page.context().newPage();
    const seen3 = rpcCalls(p3);
    await staff(p3, { customers: [cust, { ...cust, id: 'cust-pk2', name: 'Omar Key' }], 'rpc:staff_store_ready': true,
      'rpc:staff_passkeys': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_passkeys in the schema cache' } } });
    await expect.poll(() => p3.evaluate('S._storeReady')).toBe(true);
    await p3.evaluate(`openAccountHistory('cust-pk')`);
    await expect.poll(() => p3.evaluate('!!(S._pkO&&S._pkO.gone)')).toBe(true);
    await p3.evaluate(`closeCustomerProfile();openAccountHistory('cust-pk2')`);
    await expect(p3.locator('#cust-modal')).toContainText('Omar Key');
    await expect(p3.locator('#cust-modal .pk-ah')).toHaveCount(0);
    expect(seen3.filter((c) => c.name === 'staff_passkeys')).toHaveLength(1);
  });

  test('the Website section switches passkey sign-in (account.passkeys) where the database has it; the activity says passkeys', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { 'rpc:staff_store_ready': true, 'rpc:staff_passkeys': { on: false, items: [] }, site_content: [{ key: 'account.passkeys', value: { on: false }, updated_at: NOW }] });
    await expect.poll(() => page.evaluate('S._storeReady')).toBe(true);
    await page.evaluate(`setStaffTab('website')`);
    const sw = page.locator('#web-pk-switch');
    await expect(sw).toBeVisible();
    await expect(sw).not.toBeChecked();
    await sw.check();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    expect(sc[0].body).toEqual([expect.objectContaining({ key: 'account.passkeys', value: { on: true } })]);
    await expect(page.locator('#toast-container')).toContainText('Passkey sign-in turned on');
    // the customer activity's words (the database writes the lines: B7's _passkey_log)
    await page.evaluate(`typeof _cactDetail==='function'||_n6pAhLoad()`);
    await page.waitForFunction(`typeof _cactDetail==='function'`);
    expect(await page.evaluate(`[_cactLabel({action:'passkey_add'}),_cactDetail({action:'passkey_add',detail:{label:'google'}}),_cactLabel({action:'passkey_remove'}),
      _cactDetail({action:'passkey_remove',detail:{by:'staff',n:2}}),_cactDetail({action:'signin',detail:{passkey:true}}),_CACT_CAT.passkey_add]`))
      .toEqual(['Added a passkey', 'Google Password Manager', 'Removed a passkey', 'by staff ×2', 'with a passkey', 'auth']);
    // production: no card at all
    const p2 = await page.context().newPage();
    await staff(p2, { 'rpc:staff_passkeys': { on: true, items: [] }, site_content: [] });
    await expect.poll(() => p2.evaluate('S._storeReady')).toBe(false);
    await p2.evaluate(`setStaffTab('website')`);
    await expect(p2.locator('#tab-website .page-title')).toBeVisible();
    await expect(p2.locator('#web-pk-switch')).toHaveCount(0);
  });
});
