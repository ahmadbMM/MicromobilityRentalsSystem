import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// Tee Painting Workshop (the user, 2026-11-23): drawing and colouring on MicroMobility T-shirts, a featured date inside
// MicroMobility Experiences for community members alone. 130 SAR per person (the way to pay is announced later, so nothing
// says how), one place each, first come first served, a start and an end, no bike. Its own look, "Paint Splash".

const TP = '2099-11-28-tp';
const MAP = 'https://maps.app.goo.gl/PrRpv2rXTSKH7meJ8';
const paint = {
  id: TP, session_date: '2099-11-28', day: 'Saturday', status: 'open', capacity: 20, created_at: 1,
  event_kind: 'community', ride_kind: 'paint', needs_approval: false, hide_queue: true, spots: 20, open_to_all: false,
  paid_ride: true, price: 130, location: 'Red Mug Caffe', meet_name: 'Red Mug Caffe', meet_url: MAP, bike_slots: '{"_time":"15:00 - 18:00"}',
};
const sat = {
  id: '2099-11-28-2', session_date: '2099-11-28', day: 'Saturday', status: 'open', capacity: 120, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 120, open_to_all: false,
  bike_slots: '{"_time":"05:45 - 06:15"}',
};

async function custBoot(page: Page, fx: Record<string, unknown> = {}, member = true) {
  await stubSupabase(page, { sessions: [paint, sat], queue_entries: [], 'rpc:community_member': member, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}

test.describe('@customer:paint Tee Painting Workshop', () => {
  test('a paid, bike-free kind of its own, featured, told apart by its id', async ({ page }) => {
    await custBoot(page);
    const k = await page.evaluate(`(()=>{const s=allSessions().find(x=>x.id==='${TP}');
      return {kind:_rideKind(s),bike:_needsBike(s),approval:_isApprovalRide(s),free:_isFreeRide(s),waiver:_waiverKind(s),
        nc:_ncEntry({sessionId:'2099-12-05-tp'}),feat:_featured(s),steps:_regSteps(s),seat:_evSeatPrice(s)};})()`);
    expect(k).toEqual({ kind: 'paint', bike: false, approval: false, free: false, waiver: 'activity', nc: true, feat: true, steps: [1, 3], seat: 130 });
  });

  test('its date card sits inside Experiences in its own colours, with its price', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`selectEvent('community')`);
    const card = page.locator('#tab-register .sess-card.tp-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.tp-card-title')).toHaveText('Tee Painting Workshop');
    await expect(card.locator('.tp-card-meta')).toContainText('3 PM - 6 PM');
    await expect(card.locator('.tp-card-meta')).toContainText('Red Mug Caffe');
    await expect(card.locator('.tp-card-price')).toContainText('130');
    await expect(card.locator('img.tp-card-mark')).toHaveAttribute('src', '/assets/paint-mark.svg');
    await expect(card.locator('svg.tp-scene')).toHaveCount(1);
    await expect(card).not.toContainText(/ride|bike/i);
    // featured: it leads the list under its heading
    await expect(page.locator('#tab-register .sess-feat .tp-card')).toHaveCount(1);
    // the card stays inside the list at a phone's width
    await page.setViewportSize({ width: 320, height: 700 });
    const [c, w] = await Promise.all([card.boundingBox(), page.locator('#tab-register').boundingBox()]);
    expect(c && w && c.x >= w.x - 0.5 && c.x + c.width <= w.x + w.width + 0.5).toBeTruthy();
  });

  test('the event picker features it for a member, never for anyone else', async ({ page }) => {
    await custBoot(page);
    const card = page.locator('#land-events .feat-card.feat-tp');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.feat-name')).toHaveText('Tee Painting Workshop');
    await expect(card.locator('.feat-meta').first()).toContainText('3 PM - 6 PM');
    await expect(card.locator('.feat-foot')).toContainText('Red Mug Caffe');
    await expect(card.locator('.feat-foot')).toContainText('130');
    await card.click();
    await expect.poll(() => page.evaluate('[S.selEvent,S.selSession]')).toEqual(['community', TP]);
  });

  test('a rider who is not a member does not see it', async ({ page }) => {
    await custBoot(page, {}, false);
    await expect(page.locator('#land-events .landing-events-grid')).toBeVisible();
    await expect(page.locator('#land-events .feat-card.feat-tp')).toHaveCount(0);
    expect(await page.evaluate(`_infoShowSess(allSessions().find(x=>x.id==='${TP}'))`)).toBe(false);
  });

  test('Details: the price, what it is, and the venue’s own map', async ({ page }) => {
    await custBoot(page);
    await page.evaluate(`showSessInfo('${TP}')`);
    const box = page.locator('#bike-info-modal .ev-info');
    await expect(box).toContainText('Tee Painting Workshop');
    await expect(box.locator('.ev-info-text')).toContainText('3 PM to 6 PM');
    await expect(box.locator('.ev-info-facts')).toContainText('130');
    await expect(box.locator('.ev-info-facts')).toContainText('Paint and colour your own MicroMobility T-shirt');
    await expect(box.locator('.ev-info-facts')).toContainText('Red Mug Caffe');
    await expect(box.locator('.ev-info-facts a')).toHaveAttribute('href', MAP);
  });

  test('booking: the review in the paint skin at 130, one place, no bike, no way to pay told', async ({ page }) => {
    await custBoot(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(`selectEvent('community')`);
    await page.locator('#tab-register .sess-card.tp-card').click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(TP);
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(3);
    await expect(page.locator('body')).toHaveClass(/\bpaint-skin\b/);
    await expect(page.locator('#tab-register .tp-flow-head')).toContainText('Tee Painting Workshop');
    await expect(page.locator('#reg-side-sum')).toContainText('130');
    await expect(page.locator('#tab-register')).not.toContainText('Bike Type');
    await page.locator('#reg-waiver-cb').check();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: TP, type_preference: 'None', price: 130 });
    const tk = page.locator('#tab-register .ticket-card').first();
    await expect(tk).toHaveClass(/\bth-paint\b/);
    await expect(tk.locator('.tk-logo-paint')).toHaveAttribute('src', '/assets/paint-mark.svg');
    await expect(page.locator('#tab-register')).not.toContainText(/booth/i);
    await page.evaluate(`setCustTab('myrides')`);
    await expect(page.locator('body')).not.toHaveClass(/\bpaint-skin\b/);
  });

  test('My Bookings: the ticket in its colours says where, when and what, the price, and Pending, never how to pay', async ({ page }) => {
    const mine = { id: 'q1', session_id: TP, session_day: 'Saturday', session_date: '2099-11-28', queue_num: 4, name: 'Sara Haddad',
      phone: '+966500000001', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 130,
      registered_at: '2099-11-23T10:00:00Z', customer_id: 'c1' };
    await custBoot(page, { 'rpc:my_bookings': [mine], queue_entries: [mine] });
    await page.evaluate(`setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card').first();
    await expect(tk).toHaveClass(/\bth-paint\b/);
    await expect(tk.locator('.tp-know')).toContainText('Red Mug Caffe');
    await expect(tk.locator('.tp-know')).toContainText('3 PM - 6 PM');
    await expect(tk.locator('.tp-know')).toContainText('Paint and colour your own MicroMobility T-shirt');
    await expect(tk.locator('.cu-tr-money')).toContainText('130');
    await expect(tk.locator('.cu-pay-due')).toHaveText('Pending');
    await expect(tk).not.toContainText(/booth/i);
    await expect(tk).not.toContainText(/\bbike\b/i);
    await expect(tk.locator('a.cu-tk-dir')).toHaveAttribute('href', MAP);
  });
});

test.describe('@staff:sessions Tee Painting Workshop', () => {
  test('the new session form offers it: members only, 20 places, 3 to 6 PM, 130 per person, its own id', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [sat], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await page.locator('#tab-sessions .ev-pick.ev-paint').click();
    await expect(page.locator('#tab-sessions .ev-pick.ev-paint')).toHaveText('Tee Painting Workshop');
    await expect(page.locator('#tab-sessions .ss-hint', { hasText: 'Tee painting' })).toContainText('first come first served');
    await expect(page.locator('#ns-spots')).toHaveValue('20');
    await expect(page.locator('#ns-price')).toHaveValue('130');
    await expect(page.locator('#ns-title')).toHaveValue('Tee Painting Workshop');
    expect(await page.evaluate(`[S.newSessStartTime,S.newSessEndTime]`)).toEqual(['15:00', '18:00']);
    expect(await page.evaluate(`[_nsComm(),_nsSeats(),_nsTwoTimes(),_nsKind(),_sessIdSuffix('paint')]`)).toEqual([true, true, true, 'paint', '-tp']);
  });

  test('its mark, short name and colours in staff lists, one place per booking, and its announcement', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [paint, sat], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const s = `allSessions().find(x=>x.id==='${TP}')`;
    expect(await page.evaluate(`[_sessShort(${s}),_sfTheme(${s}),KIND_IC.paint,SESS_MK_IC.paint,_editSeats(${s}),_noGroupAdd(${s})]`)).toEqual(['Painting', 'paint', 'brush', 'brush', true, true]);
    expect(await page.evaluate(`[ANN_TYPES.some(x=>x[0]==='paint'),ANN_HAS.includes('ann_paint')]`)).toEqual([true, true]);
  });
});

// The Tee Painting Workshop badge (the user, 2026-11-24: "create a badge for it"): the workshop's tee with a brush stroke
// and paint drops on its own medal, sunflower into red into navy, for the member checked in on a paint session (on site
// or checked out). Shown only to those who hold it.
test.describe('@customer:paint The Tee Painting Workshop badge', () => {
  const row = (x: Record<string, unknown>) => ({ id: 'q1', session_id: TP, session_day: 'Saturday', session_date: '2099-11-28', queue_num: 3, name: 'Sara Haddad', phone: '+966500000001', type_preference: 'None', size: '', status: 'active', paid: true, price: 130, registered_at: '2099-11-24T10:00:00Z', customer_id: 'c1', ...x });
  async function rider(page: Page, x: Record<string, unknown>, sessions: unknown[] = [paint, sat]) {
    const r = row(x);
    await stubSupabase(page, {
      sessions, queue_entries: [r], 'rpc:my_bookings': [r], 'rpc:community_member': true,
      'rpc:customer_profile': [{ id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', birth_date: '1995-05-05', height: 165, type_preference: 'Any', nationality: 'Saudi Arabia' }],
      'rpc:customer_update_profile': true,
      'rpc:customer_emergency': [{ emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' }],
    });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
  }

  test('checked in at the workshop: the painted tee on the paint medal, once with a pop-up', async ({ page }) => {
    await rider(page, {});
    const pop = page.locator('#badge-pop');
    await expect(pop).toContainText('Tee Painting Workshop');
    await expect(pop).toContainText('Come to one of our tee painting workshops.');
    await expect(pop.locator('svg.bdg-m.bdg-sp')).toHaveCount(1);
    await expect(pop.locator('.sp-paint')).not.toHaveCount(0);
    await pop.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#tab-account .mr-badges .mr-badge.sp-paint', { hasText: 'Tee Painting Workshop' })).toHaveCount(1);
    expect(await page.evaluate(`[BD_SYS.tee_painting,!!BDG_GLYPH.tee,BDG_HELD_ONLY.has('tee_painting'),BDG_CHEER.tee_painting]`)).toEqual([['tee', 'paint', 'bdgTeePaint'], true, true, 'cq_bdg_tpw_']);
  });

  for (const [what, x, ses] of [
    ['checked out', { status: 'done' }, undefined],
    ['a workshop over that the device no longer lists (read from the id)', { status: 'done', session_id: '2099-10-17-tp', session_date: '2099-10-17' }, [sat]],
  ] as const) {
    test(`${what} earns it too`, async ({ page }) => {
      await rider(page, x, ses ? [...ses] : undefined);
      await expect(page.locator('#badge-pop')).toContainText('Tee Painting Workshop');
    });
  }

  for (const [what, x] of [
    ['a place still waiting', { status: 'waiting' }],
    ['a booking called off', { status: 'cancelled' }],
    ['a member who never came', { status: 'noshow' }],
    ['a Saturday ride ridden', { status: 'done', session_id: '2099-11-28-2', session_date: '2099-11-28', type_preference: 'Road', price: 0 }],
  ] as const) {
    test(`${what} does not get it, not even to earn`, async ({ page }) => {
      await rider(page, x);
      await expect(page.locator('#mr-badges-host')).toHaveCount(1);
      await page.evaluate(`_mrBadgesMore()`);
      await expect(page.locator('#tab-account .mr-badge', { hasText: 'Tee Painting Workshop' })).toHaveCount(0);
    });
  }

  test('the Arabic page names it as the workshop is named', async ({ page }) => {
    await rider(page, { status: 'done' });
    await page.locator('#badge-pop').getByRole('button', { name: 'Close' }).click();
    await page.evaluate(`setLang('ar')`);
    await expect(page.locator('#tab-account .mr-badges .mr-badge.sp-paint')).toContainText('ورشة الرسم على التيشيرت'); // the Arabic pack arrives, then the page repaints
    expect(await page.evaluate(`[t('bdgTeePaintD'),_bdgName({system:true,slug:'tee_painting'})]`)).toEqual(['احضر ورشة الرسم على التيشيرت معنا.', 'ورشة الرسم على التيشيرت']);
  });

  test('every language has it, and the migration adds it for holders only', async () => {
    for (const code of ['es', 'fr', 'hi', 'ur', 'bn', 'ne', 'pt', 'tl', 'ms']) {
      const pack = JSON.parse(readFileSync(`i18n/${code}.json`, 'utf8')) as Record<string, string>;
      for (const k of ['bdgTeePaint', 'bdgTeePaintD', 'bdgTeePaintA']) expect(pack[k], `${code} ${k}`).toBeTruthy();
    }
    const sql = readFileSync('supabase/migrations/20261124100000_tee_painting_badge.sql', 'utf8');
    expect(sql).toMatch(/'bd_tee_painting', 'tee_painting', 'tee', 'red'.*true, true, 94, true\)/);
    expect(sql).toContain("values ('20261124100000', 'tee_painting_badge')");
  });
});
