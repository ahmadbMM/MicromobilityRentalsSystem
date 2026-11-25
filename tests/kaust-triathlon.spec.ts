import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// KAUST Triathlon (the user, 2026-11-22): a featured date inside MicroMobility Experiences that every rider sees. A community
// member books a free place in the group and picks a race; then "Have you registered through the registration website?" asks
// at once and on every visit until Yes. Anyone else is sent to the race's registration website. "Red Sea Dawn" look.

const KT = '2099-12-04-kt';
const REG = 'https://rec.coastline-fm.com/events/kaust-triathlon-2026/register';
const ktri = {
  id: KT, session_date: '2099-12-04', day: 'Friday', status: 'open', capacity: 50, created_at: 1,
  event_kind: 'community', ride_kind: 'ktri', needs_approval: false, hide_queue: true, spots: 50, open_to_all: false,
  paid_ride: false, location: 'KAUST Urban Beach', meet_url: 'https://www.google.com/maps/search/?api=1&query=KAUST+Urban+Beach',
  bike_slots: '{"_time":"06:00 - 11:00"}',
};
const sat = {
  id: '2099-12-05-2', session_date: '2099-12-05', day: 'Saturday', status: 'open', capacity: 120, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 120, open_to_all: false,
  bike_slots: '{"_time":"05:45 - 06:15"}',
};

async function custBoot(page: Page, fx: Record<string, unknown> = {}, member = true) {
  await stubSupabase(page, { sessions: [ktri, sat], queue_entries: [], 'rpc:community_member': member, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}

test.describe('@customer:ktri KAUST Triathlon', () => {
  test('a bike-free kind of its own, featured, its Details shown to everyone', async ({ page }) => {
    await custBoot(page, {}, false);
    const k = await page.evaluate(`(()=>{const s=allSessions().find(x=>x.id==='${KT}');
      return {kind:_rideKind(s),bike:_needsBike(s),approval:_isApprovalRide(s),free:_isFreeRide(s),waiver:_waiverKind(s),nc:_ncEntry({sessionId:'2099-12-11-kt'}),feat:_featured(s),info:_infoShowSess(s),reg:_isRaceRegSess(s),steps:_regSteps(s)};})()`);
    expect(k).toEqual({ kind: 'ktri', bike: false, approval: false, free: true, waiver: 'activity', nc: true, feat: true, info: true, reg: true, steps: [1, 2, 3] });
  });

  test('a rider who is not a member sees the card and is sent to the registration website', async ({ page }) => {
    await custBoot(page, {}, false);
    await page.evaluate(`window.__opened=[];window.open=(u)=>{window.__opened.push(u);return {opener:1};}`);
    // the Experiences list is the members'; the event picker's featured card is everyone's
    const card = page.locator('#landing .feat-card.feat-kt, .feat-card.feat-kt').first();
    await expect(card).toBeVisible();
    await expect(card.locator('.kt-k')).toHaveText('KAUST');
    await expect(card).toContainText('Register on the race website');
    await card.click();
    await expect.poll(() => page.evaluate('window.__opened')).toEqual([REG]);
    expect(await page.evaluate('S.selSession')).toBeNull();
    // a browser that refuses the tab: the pop-up holds the link
    await page.evaluate(`window.open=()=>null`);
    await card.click();
    await expect(page.locator('#confirm-modal .kt-out .kt-out-go')).toHaveAttribute('href', REG);
  });

  test('a member books: the race step, the KAUST skin, then "Have you registered?" with the link', async ({ page }) => {
    const sent: { u: string; b: unknown }[] = [];
    page.on('request', (r) => { const m = /rpc\/(customer_set_tri_race|customer_set_race_reg)/.exec(r.url()); if (m) sent.push({ u: m[1], b: r.postDataJSON() }); });
    await custBoot(page, { 'rpc:customer_set_tri_race': true, 'rpc:customer_set_race_reg': true });
    const rows = await captureBookingRows(page);
    await page.evaluate(`selectEvent('community')`);
    await page.locator('#tab-register .sess-card.kt-card').click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(KT);
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(2);
    await expect(page.locator('body')).toHaveClass(/\bktri-skin\b/);
    await expect(page.locator('#tab-register .kt-flow-head')).toContainText('KAUST');
    // no race picked: not on to the review
    await page.locator('#kt-next').click();
    expect(await page.evaluate('S.regStep')).toBe(2);
    await expect(page.locator('#tab-register .kt-race')).toHaveCount(5);
    await page.locator('#tab-register .kt-race[data-race="spr"]').click();
    await expect(page.locator('#tab-register .kt-race[data-race="spr"]')).toHaveAttribute('aria-checked', 'true');
    // the bike: asked, and the promise to register on the race's site is required
    await page.locator('#kt-next').click();
    expect(await page.evaluate('S.regStep')).toBe(2);
    await page.locator('#tab-register .kt-bk[data-bike="own"]').click();
    await expect(page.locator('#tab-register .kt-types')).toHaveCount(0);
    await page.locator('#kt-next').click();
    expect(await page.evaluate('S.regStep')).toBe(2);
    await page.locator('#kt-must').check();
    await page.locator('#kt-next').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(3);
    await expect(page.locator('#tab-register')).toContainText('Sprint');
    await expect(page.locator('#tab-register')).not.toContainText('Bike Type');
    await page.locator('#reg-waiver-cb').check();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: KT, type_preference: 'Own', price: 0 });
    await expect.poll(() => sent.filter((x) => x.u === 'customer_set_tri_race').length).toBe(1);
    expect(sent.find((x) => x.u === 'customer_set_tri_race')!.b).toMatchObject({ p_id: 'c1', p_race: 'spr' });
    // the last step: the pop-up, No shows the registration website
    const gate = page.locator('#race-gate .rr-box.kt-gate');
    await expect(gate).toBeVisible();
    await expect(gate.locator('#rr-title')).toHaveText('Have you registered through the KAUST Triathlon registration website?');
    await expect(gate.locator('a.kt-reg-link')).toHaveAttribute('href', REG);
    await gate.locator('.defe-reg-yn .toggle-btn').nth(1).click();
    // No keeps it open: no Done, the registration is required
    await expect(gate.locator('.pg-btn')).toHaveCount(0);
    await expect(gate).toContainText('required');
    await expect.poll(() => sent.filter((x) => x.u === 'customer_set_race_reg').length).toBe(1);
    expect(sent.find((x) => x.u === 'customer_set_race_reg')!.b).toMatchObject({ p_answer: 'no' });
  });

  test('My Bookings: the ticket in its colours, the race, and the question again on the next visit', async ({ page }) => {
    const mine = { id: 'q1', session_id: KT, session_day: 'Friday', session_date: '2099-12-04', queue_num: 4, name: 'Sara Haddad',
      phone: '+966500000001', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0,
      registered_at: '2099-11-22T10:00:00Z', customer_id: 'c1', tri_race: 'oly', race_reg: null };
    await custBoot(page, { 'rpc:my_bookings': [mine], queue_entries: [mine] });
    await expect(page.locator('#race-gate .rr-box.kt-gate')).toBeVisible();
    await page.locator('#race-gate .defe-reg-yn .toggle-btn').first().click().catch(() => {});
    await page.evaluate(`S._xg=null;renderRaceGate();setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card').first();
    await expect(tk).toHaveClass(/\bth-ktri\b/);
    await expect(tk.locator('.kt-know')).toContainText('Olympic');
    await expect(tk.locator('.kt-know')).toContainText('6:30 AM');
    await expect(tk.locator('.kt-know')).toContainText('KAUST Urban Beach');
    await expect(tk).not.toContainText(/\bbike rental\b/i);
  });
});

test.describe('@customer:ktri KAUST Triathlon open to everyone', () => {
  test('a rider who is not a member books it from the featured card, and sees only that date in Experiences', async ({ page }) => {
    await stubSupabase(page, { sessions: [{ ...ktri, open_to_all: true }, sat], queue_entries: [], 'rpc:community_member': false });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`window.__opened=[];window.open=(u)=>{window.__opened.push(u);return {opener:1};};goLanding()`);
    const feat = page.locator('.feat-card.feat-kt').first();
    await expect(feat).toContainText('Book your place in our group');
    await feat.click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(KT);
    expect(await page.evaluate('window.__opened')).toEqual([]);
    await expect(page.locator('#tab-register .sess-card')).toHaveCount(1);
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(2);
    await page.locator('#tab-register .kt-race[data-race="oly"]').click();
    await expect(page.locator('#tab-register .kt-know')).not.toContainText('Sharafeyah branch');
    await page.locator('#tab-register .kt-bk[data-bike="rent"]').click();
    await expect(page.locator('#tab-register .kt-know')).toContainText('Sharafeyah branch');
    // Road Carbon is rented too, at its own price (the user, 2026-11-25: "in kaust triathlon bike rentals include road carbon option")
    await expect(page.locator('#tab-register .kt-types .toggle-btn[data-ty="Road Carbon"]')).toContainText('250');
    expect(await page.evaluate(`_noCarbon(allSessions().find(x=>x.id==='${KT}'))`)).toBe(false);
    await page.locator('#tab-register .kt-types .toggle-btn[data-ty="Road"]').click();
    await page.locator('#kt-h').fill('178');
    await page.locator('#kt-must').check();
    await page.locator('#kt-next').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(3);
    expect(await page.evaluate('_ktBikeOf()')).toMatchObject({ type: 'Road', h: 178 });
    // Future Champs is a run: no bike asked
    expect(await page.evaluate(`(S.regTriRace='champs',[_ktBikeAsk(),_ktBikeOf().type])`)).toEqual([false, 'None']);
  });
});

test.describe('@staff:sessions KAUST Triathlon', () => {
  test('the new session form offers it: 50 places, its own id, its short name', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [ktri, sat], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await page.locator('#tab-sessions .ev-pick.ev-ktri').click();
    await expect(page.locator('#tab-sessions .ev-pick.ev-ktri')).toHaveText('KAUST Triathlon');
    await expect(page.locator('#ns-spots')).toHaveValue('50');
    expect(await page.evaluate(`[_nsComm(),_nsSeats(),_nsKind(),_sessIdSuffix('ktri')]`)).toEqual([true, true, 'ktri', '-kt']);
    expect(await page.evaluate(`_sessShort(allSessions().find(x=>x.id==='${KT}'))`)).toBe('Triathlon');
    expect(await page.evaluate(`_sfTheme(allSessions().find(x=>x.id==='${KT}'))`)).toBe('ktri');
  });
  // the user, 2026-11-23: "in kaust bookings in staff panel show the type of race in the vertical page of the phone screen"
  test('Bookings on a portrait phone: each card shows the race', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const row = (id: string, race: string | null, n: number) => ({ id, session_id: KT, session_day: 'Friday', session_date: '2099-12-04',
      queue_num: n, name: 'Rider ' + n, phone: '+96650000000' + n, type_preference: 'None', size: '', status: 'waiting', paid: false,
      price: 0, registered_at: '2099-11-22T10:00:00Z', tri_race: race, race_reg: 'yes' });
    await stubSupabase(page, { sessions: [ktri, sat], bikes: [], queue_entries: [row('q1', 'oly', 1), row('q2', null, 2)] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${KT}';renderStaffQueue()`);
    const card = (id: string) => page.locator(`#tab-queue .queue-mobile-view .q-card[data-id="${id}"]`);
    await expect(card('q1').locator('.rq-csub .kt-race-chip')).toContainText('Olympic');
    await expect(card('q2').locator('.kt-race-chip')).toHaveCount(0);
  });
});
