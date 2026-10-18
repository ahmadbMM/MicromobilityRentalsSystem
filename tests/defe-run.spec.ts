import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// The DEFE 5KM Run (the owner, 2026-10-18): Defe's breast-cancer 5 km race at the Jeddah Corniche Circuit,
// a date inside MicroMobility Experiences for community members. The runner step shows every detail the
// account holds, filled in and free to change, and asks for what is missing; the place is booked, then the
// rider is asked whether they registered for the race through Defe (No shows the link and the MICRO50 code).

const DF = '2099-10-22-df';
const defe = {
  id: DF, session_date: '2099-10-22', day: 'Thursday', status: 'open', capacity: 300, created_at: 1,
  event_kind: 'community', ride_kind: 'defe5k', needs_approval: false, hide_queue: true, spots: 300, open_to_all: false,
  paid_ride: false, location: 'JCC', meet_url: 'https://maps.app.goo.gl/aWjWgoxHX1W28JB26', bike_slots: '{"_time":"19:00"}',
};
const sat = {
  id: '2099-10-24', session_date: '2099-10-24', day: 'Saturday', status: 'open', capacity: 120, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 120, open_to_all: false,
  bike_slots: '{"_time":"06:00 - 06:30"}',
};
const profile = (x: Record<string, unknown> = {}) => [{ id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', birth_date: '1995-05-05', height: 165, type_preference: 'Any', nationality: 'SA', ...x }];
const contact = [{ emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' }];
const noContact = [{ emergency_name: null, emergency_phone: null, emergency_relation: null }];

async function custBoot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [defe, sat], queue_entries: [], 'rpc:community_member': true, 'rpc:customer_profile': profile(), 'rpc:customer_emergency': contact, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}
async function openDefe(page: Page) {
  await page.evaluate(`selectEvent('community')`);
  const card = page.locator('#tab-register .sess-card.defe-card');
  await expect(card).toBeVisible();
  await card.click();
  await expect.poll(() => page.evaluate('S.selSession')).toBe(DF);
  await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
}

test.describe('@customer:defe DEFE 5KM Run', () => {
  test('its date card sits inside Experiences in Defe’s colours', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`selectEvent('community')`);
    const card = page.locator('#tab-register .sess-card.defe-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.defe-card-title')).toHaveText('DEFE 5KM Run');
    await expect(card.locator('.defe-card-meta')).toContainText('7 PM');
    await expect(card.locator('.defe-card-meta')).toContainText('5 km');
    await expect(card.locator('.defe-card-meta')).toContainText('Jeddah Corniche Circuit');
    await expect(card.locator('.defe-card-cause')).toContainText('Breast cancer awareness');
    await expect(card.locator('img.defe-card-logo')).toHaveAttribute('src', '/assets/defe-logo.svg');
    // the Saturday ride beside it keeps its own card
    await expect(page.locator('#tab-register .sess-card:not(.defe-card)')).toHaveCount(1);
    // the card stays inside the list at a phone's width
    await page.setViewportSize({ width: 320, height: 700 });
    const [c, w] = await Promise.all([card.boundingBox(), page.locator('#tab-register').boundingBox()]);
    expect(c && w && c.x >= w.x - 0.5 && c.x + c.width <= w.x + w.width + 0.5).toBeTruthy();
  });

  test('the runner step shows every detail filled in, saves only what changed, and asks about the race after booking', async ({ page }) => {
    const sent: { u: string; b: Record<string, unknown> }[] = [];
    page.on('request', (r) => { const m = /rpc\/(customer_set_emergency|customer_update_profile|customer_set_race_reg)/.exec(r.url()); if (m) sent.push({ u: m[1], b: r.postDataJSON() }); });
    await custBoot(page, { 'rpc:customer_update_profile': true, 'rpc:customer_set_race_reg': true });
    const rows = await captureBookingRows(page);
    await openDefe(page);
    // Defe's look from the runner step on
    await expect(page.locator('body')).toHaveClass(/\bdefe5k\b/);
    await expect(page.locator('#tab-register .defe-flow-head')).toContainText('DEFE 5KM Run');
    // when the kits go out, and the one distance
    await expect(page.locator('#tab-register .defe-when')).toContainText('Jeddah Park');
    await expect(page.locator('#tab-register .defe-when')).toContainText('Jeddah Corniche Circuit');
    await expect(page.locator('#run-km-wrap')).toHaveCount(0);
    await expect(page.locator('#tab-register .run-km-chip.defe-km')).toHaveText('5 km');
    // everything the account holds, filled in
    await expect(page.locator('#run-first')).toHaveValue('Sara');
    await expect(page.locator('#run-last')).toHaveValue('Haddad');
    await expect(page.locator('#run-email')).toHaveValue('sara@example.com');
    await expect(page.locator('#run-dob')).toHaveValue('1995-05-05');
    await expect(page.locator('.run-em-card')).toContainText('Nora Haddad');
    // no age note: the run has no age rule
    await expect(page.locator('#tab-register .run-adult')).toHaveCount(0);
    // the runner changes the email only
    await page.fill('#run-email', 'sara.h@example.com');
    await page.locator('#run-next').click();
    // no share gate: the review with the waiver
    await expect(page.locator('#reg-waiver-cb')).toBeVisible();
    await expect(page.locator('#share-gate .sg-box')).toHaveCount(0);
    expect(sent.map((x) => x.u)).toEqual(['customer_update_profile']);
    expect(sent[0].b).toMatchObject({ p_name: 'Sara Haddad', p_email: 'sara.h@example.com', p_birth_date: '1995-05-05' });
    await page.locator('#reg-waiver-cb').check();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: DF, run_km: 5, type_preference: 'None', price: 0 });
    expect(rows[0].share_ok).toBeFalsy();
    // booked first, then the question: a centred pop-up that cannot be closed (2026-10-18)
    const q = page.locator("#race-gate .rr-box");
    await expect(q.locator("#rr-title")).toHaveText("Have you registered for the race?");
    await expect(page.locator("#tab-register .ticket-card")).toContainText("Runner number");
    await page.keyboard.press("Escape");
    await expect(q).toBeVisible();
    await expect(q.locator(".defe-reg-link")).toHaveCount(0);
    await q.getByRole("button", { name: "No" }).click();
    const link = q.locator(".defe-reg-link");
    await expect(link).toHaveText("Register for the race");
    await expect(q.locator(".defe-reg-code")).toHaveText("Use discount code MICRO50 for 50% off, for the first 50 members.");
    await expect(q.locator(".defe-reg-code strong")).toHaveText("MICRO50");
    await expect(link).toHaveAttribute("href", "https://in.njuko.com/defe5k?utm_id=97760_v0_s00_e0_tv5");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect.poll(() => sent.filter((x) => x.u === "customer_set_race_reg").length).toBe(1);
    expect(sent.find((x) => x.u === "customer_set_race_reg")!.b).toMatchObject({ p_id: "c1", p_answer: "no" });
    // Done lets the No through for this visit; the ticket keeps the code and the link
    await q.getByRole("button", { name: "Done" }).click();
    await expect(page.locator("#race-gate .rr-box")).toHaveCount(0);
    await expect(page.locator("#tab-register .defe-reg-link")).toBeVisible();
    // Change opens the pop-up again; Yes saves and closes it
    await page.locator("#tab-register .defe-reg").getByRole("button", { name: "Change" }).click();
    await page.locator("#race-gate .rr-box").getByRole("button", { name: "Yes" }).click();
    await expect(page.locator("#race-gate .rr-box")).toHaveCount(0);
    await expect(page.locator("#tab-register .defe-reg-done")).toContainText("registered for the race");
    await expect(page.locator("#tab-register .defe-reg-link")).toHaveCount(0);
  });

  test('a missing emergency contact and birth date are asked for', async ({ page }) => {
    await custBoot(page, { 'rpc:customer_profile': profile({ birth_date: null }), 'rpc:customer_emergency': noContact });
    await openDefe(page);
    await expect(page.locator('#run-em-name')).toBeVisible();
    await expect(page.locator('#run-dob')).toHaveValue('');
    await page.locator('#run-next').click();
    await expect(page.locator('#reg-waiver-cb')).toHaveCount(0);
  });

  test('a booked place with no answer asks in the pop-up on opening the app', async ({ page }) => {
    const mine = { id: 'q1', session_id: DF, session_day: 'Thursday', session_date: '2099-10-22', queue_num: 4, name: 'Sara Haddad',
      phone: '+966500000001', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, run_km: 5,
      registered_at: '2099-10-18T10:00:00Z', customer_id: 'c1', race_reg: null };
    await custBoot(page, { 'rpc:my_bookings': [mine], queue_entries: [mine] });
    await page.evaluate(`setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card').first();
    await expect(page.locator('#race-gate .rr-box #rr-title')).toHaveText('Have you registered for the race?');
    await expect(tk.locator('.defe-reg')).toHaveCount(0);
    await expect(tk.locator('.defe-when')).toContainText('Jeddah Park');
    await expect(tk).toContainText('Runner number');
  });

  test('the finisher’s badge: Defe’s ribbon, shown once the run is finished', async ({ page }) => {
    await custBoot(page);
    const slugs = (st: string) => page.evaluate(([s, sid]) => {
      const e = [{ id: 'x', sessionId: sid, sessionDate: '2099-10-22', status: s, paid: false, price: 0, customerId: 'c1', queueNum: 3 }];
      return (window as unknown as { _mrBadges: (a: unknown[], b: unknown[]) => { s: string; on: boolean; hide?: boolean }[] })._mrBadges(e, s === 'done' ? e : [])
        .filter((b) => b.s === 'defe_5k').map((b) => ({ on: b.on, hide: !!b.hide }));
    }, [st, DF]);
    expect(await slugs('active')).toEqual([{ on: false, hide: true }]);
    expect(await slugs('done')).toEqual([{ on: true, hide: true }]);
    const medal = await page.evaluate(`_bdgMedal('defe','defe')`);
    expect(medal).toContain('bdg-sp');
    expect(medal).toContain('class="rb');
  });
});

test.describe('@staff:bookings DEFE 5KM Run', () => {
  test('Bookings shows each runner’s 5 km and whether they registered for the race', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = (id: string, rr: string | null) => ({
      id, session_id: DF, session_day: 'Thursday', session_date: '2099-10-22', queue_num: Number(id.slice(1)), name: 'Runner ' + id,
      phone: '055000000' + id.slice(1), type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0,
      registered_at: '2099-10-18T10:00:00Z', customer_id: 'c' + id, run_km: 5, race_reg: rr,
    });
    await stubSupabase(page, { sessions: [defe, sat], bikes: [], queue_entries: [row('r1', 'yes'), row('r2', 'no'), row('r3', null)] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${DF}';renderStaffQueue()`);
    const tq = page.locator('#tab-queue');
    await expect(tq.locator('.queue-table tbody .rr-chip')).toHaveText(['Registered', 'Not registered']);
    await expect(tq.locator('.queue-table tbody .run-km-chip').first()).toHaveText('5 km');
  });
});
