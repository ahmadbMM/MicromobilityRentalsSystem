import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// Victory Lap by Fitness Empire (the owner, 2026-10-14 and 2026-10-17): a hybrid fitness race run by Kamin
// Sports. Its card (D) shows to every signed-in rider, without a price; Community members and Victory Lap
// tag holders book it (vlap_member). Five races, four divisions, 150 SAR per athlete, a T-shirt size and an
// optional 5 km time, 16 and over, the agreement to share with Kamin Sports, Doubles teams joined by a code,
// one Singles and one Doubles place per account, and staff who manage every part of it.

const VL = '2099-10-26-vl';
const vl = {
  id: VL, session_date: '2099-10-26', day: 'Monday', status: 'open', capacity: 500, created_at: 1,
  event_kind: 'community', ride_kind: 'vlap', needs_approval: false, hide_queue: true, spots: 500, open_to_all: false,
  paid_ride: true, price: 150, location: 'JCC', meet_url: 'https://maps.app.goo.gl/aWjWgoxHX1W28JB26', bike_slots: '{"_time":"16:30 - 17:15"}',
};
const jcc = { id: '2099-10-27', session_date: '2099-10-27', day: 'Tuesday', status: 'open', capacity: 12, created_at: 1, location: 'JCC' };
const profile = (x: Record<string, unknown> = {}) => [{ id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', birth_date: '1995-05-05', height: 165, type_preference: 'Any', nationality: 'SA', gender: 'female', ...x }];
const contact = [{ emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' }];
const row = (id: string, v: Record<string, unknown> | null, x: Record<string, unknown> = {}) => ({
  id, session_id: VL, session_day: 'Monday', session_date: '2099-10-26', queue_num: Number(id.slice(1)), name: 'Athlete ' + id,
  phone: '055000000' + id.slice(1), type_preference: 'None', size: '', status: 'waiting', paid: false, price: 150,
  registered_at: '2099-10-01T10:00:00Z', customer_id: 'c' + id, vl: v, ...x,
});

async function custBoot(page: Page, fx: Record<string, unknown> = {}, cust: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [vl, jcc], queue_entries: [], 'rpc:vlap_member': true, 'rpc:community_member': true,
    'rpc:customer_profile': profile(), 'rpc:customer_emergency': contact, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', birth_date: '1995-05-05', gender: 'female', ...cust });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}
async function toStep2(page: Page) {
  await page.locator('#land-events .landing-event-card.ev-vlap').click();
  await expect.poll(() => page.evaluate('S.selSession')).toBe(VL);
  await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
  await expect(page.locator('#vl-race-wrap')).toBeVisible();
}

test.describe('@customer:vlap Victory Lap', () => {
  test('the card shows to everyone without a price, and only Community or the tag get past it', async ({ page }) => {
    await custBoot(page, { 'rpc:vlap_member': false });
    const card = page.locator('#land-events .landing-event-card.ev-vlap');
    await expect(card).toBeVisible();
    await expect(card.locator('.vl-logo img')).toHaveAttribute('src', '/assets/victory-lap-dark.webp');
    await expect(card.locator('.vl-meta')).toContainText('4:30 PM');
    await expect(card).not.toContainText('SAR');
    await expect(card.locator('.vl-flag')).toHaveCount(1);
    await card.click();
    await expect(page.locator('#confirm-modal')).toContainText('Victory Lap is for our community');
    expect(await page.evaluate('S.view')).toBe('landing');
  });

  test('no number of places is ever said: Details say Available, a nearly full date no "places left"', async ({ page }) => {
    await custBoot(page);
    const facts: string[] = await page.evaluate(`(()=>{S.queue=[];const s=_sessGet('${VL}');s.spots=2;return _infoFacts(s).map(r=>r.join('|'))})()`);
    expect(facts.find((r) => r.startsWith('Places'))).toBe('Places|Available');
    await page.locator('#land-events .landing-event-card.ev-vlap').click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(VL);
    await expect(page.locator('#tab-register')).not.toContainText(/place(s)? left/i);
  });

  test('under 16 on race day is turned away at the card', async ({ page }) => {
    await custBoot(page, {}, { birth_date: '2085-01-01' });
    await page.locator('#land-events .landing-event-card.ev-vlap').click();
    await expect(page.locator('#confirm-modal')).toContainText('For athletes 16 and over');
  });

  test('a Singles place: race, division, T-shirt, the Kamin Sports agreement, 150 SAR, and the booking carries it all', async ({ page }) => {
    await custBoot(page);
    const rows = await captureBookingRows(page);
    await toStep2(page);
    // her gender is on file: the men's races are not offered
    await expect(page.locator('#vl-race-wrap .vl-race-n')).toHaveText(['Women’s Singles', 'Women’s Doubles', 'Mixed Doubles']);
    await expect(page.locator('#vl-g-wrap')).toHaveCount(0);
    await page.locator('#vl-next').click();
    await expect(page.locator('#vl-race-wrap .field-err')).toContainText('Pick a race.');
    await page.locator('#vl-race-wrap .vl-race').first().click();
    await expect(page.locator('#vl-team-wrap')).toHaveCount(0); // Singles: no team
    await expect(page.locator('#vl-div-wrap .vl-div')).toHaveCount(4);
    await expect(page.locator('#vl-div-wrap .vl-div').nth(2)).toContainText('6.1 km');
    await page.locator('#vl-div-wrap .vl-div').nth(2).click();
    await page.locator('#vl-next').click();
    await expect(page.locator('#vl-shirt-wrap .field-err')).toContainText('Pick a T-shirt size.');
    await page.locator('#vl-shirt-wrap .toggle-btn', { hasText: /^M$/ }).click();
    await page.locator('.vl-t5 .toggle-btn').first().click();
    await page.locator('#vl-next').click();
    const sg = page.locator('#share-gate');
    await expect(sg).toContainText('Kamin Sports');
    await expect(sg.locator('.sg-list li')).toHaveCount(8);
    await expect(sg).toContainText('Kamin Sports will confirm exactly which details they need');
    await sg.locator('.wg-cb').check();
    await sg.locator('.pg-btn').click();
    await expect(page.locator('#reg-waiver-cb')).toBeVisible();
    await expect(page.locator('#tab-register .vl-chip').first()).toContainText('Women’s Singles · Open');
    await expect(page.locator('#tab-register')).toContainText('How to pay will be announced soon');
    await page.locator('#reg-waiver-cb').check();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: VL, type_preference: 'None', price: 150, share_ok: true,
      vl: { race: 'ws', div: 'op', shirt: 'M', t5k: 'u20' } });
  });

  test('Doubles: joining a partner’s team takes its race and division', async ({ page }) => {
    await custBoot(page, { 'rpc:vl_team_peek': [{ team: 'VL-4K7Q', race: 'xd', div: 'el', partner: 'Omar', need: 'female', is_full: false }] });
    const rows = await captureBookingRows(page);
    await toStep2(page);
    await page.locator('#vl-race-wrap .vl-race', { hasText: 'Mixed Doubles' }).click();
    await expect(page.locator('#vl-team-wrap .toggle-btn')).toHaveText(['Start a team', 'Join with a code', 'Find me a partner']);
    await page.locator('#vl-team-wrap .toggle-btn', { hasText: 'Join with a code' }).click();
    await page.fill('#vl-code', 'vl 4k7q');
    await page.locator('#vl-team-wrap .btn-secondary').click();
    await expect(page.locator('.vl-peek-ok')).toContainText('VL-4K7Q');
    await expect(page.locator('.vl-peek-ok')).toContainText('With Omar');
    await expect(page.locator('#vl-div-wrap .vl-locked')).toContainText('Elite');
    await page.locator('#vl-shirt-wrap .toggle-btn', { hasText: /^S$/ }).click();
    await page.locator('#vl-next').click();
    await page.locator('#share-gate .wg-cb').check();
    await page.locator('#share-gate .pg-btn').click();
    await page.locator('#reg-waiver-cb').check();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].vl).toEqual({ join: 'VL-4K7Q', race: 'xd', div: 'el', shirt: 'S' });
  });

  test('one Singles and one Doubles: a Singles holder is offered Doubles only, and the ticket says the team', async ({ page }) => {
    const mine = row('m1', { race: 'ws', div: 'so', shirt: 'M' }, { customer_id: 'c1', name: 'Sara Haddad' });
    const team = row('m2', { race: 'wd', div: 'se', shirt: 'M', team: 'VL-AB23' }, { customer_id: 'c1', name: 'Sara Haddad', queue_num: 9 });
    await custBoot(page, { queue_entries: [mine], 'rpc:my_bookings': [mine] });
    await toStep2(page);
    await expect(page.locator('#vl-race-wrap .vl-race').first()).toBeDisabled();
    await expect(page.locator('#vl-race-wrap .vl-race').nth(1)).toBeEnabled();
    // the ticket of a Doubles place with no partner yet
    await page.evaluate(`S.queue=[...getQueue(),entryFromDB(${JSON.stringify(team)})];renderMyRides()`);
    const html = await page.evaluate(`renderBookingTicket([getQueue().find(e=>e.id==='m2')],{actions:true})`);
    expect(html).toContain('VL-AB23');
    expect(html).toContain('Waiting for your partner');
    expect(html).toContain('Send the code');
    expect(html).toContain('How to pay will be announced soon');
    expect(html).toContain('Change details');
  });

  test('a refusal from the database is said in the rider’s words', async ({ page }) => {
    await custBoot(page);
    const said = await page.evaluate(`(()=>{const out=[];const t0=window.toast;window.toast=(m)=>out.push(m);
      _bookRefused({message:'This team is complete.',details:'VL_TEAM_FULL'},_sessGet('${VL}'));
      _bookRefused({message:'x',details:'VL_ONE_EACH'},_sessGet('${VL}'));window.toast=t0;return out;})()`);
    expect(said).toEqual(['This team already has two athletes.', 'You already have this kind of place in Victory Lap. You can hold one Singles and one Doubles place.']);
  });

  test('the finisher’s badge comes with a booking that is done', async ({ page }) => {
    await custBoot(page);
    const on = async (st: string) => page.evaluate(([s, id]) => {
      const e = [{ id: 'x', sessionId: id, status: s, paid: false }];
      return (window as unknown as { _mrBadges: (a: unknown[], b: unknown[]) => { s: string; on: boolean }[] })._mrBadges(e, []).find((b) => b.s === 'victory_lap');
    }, [st, VL]);
    expect(await on('active')).toMatchObject({ on: false });
    expect(await on('done')).toMatchObject({ on: true });
    expect(await page.evaluate(`_bdgMedal('lapring','vlap')`)).toContain('bdg-sp');
  });
});

test.describe('@staff:bookings Victory Lap', () => {
  async function staffBoot(page: Page, q: Record<string, unknown>[]) {
    await stubSupabase(page, { sessions: [vl, jcc], bikes: [], queue_entries: q });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${VL}';renderStaffQueue()`);
  }

  test('the roster shows each athlete’s race and team, splits by it, and pairs two athletes into one team', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await staffBoot(page, [
      row('r1', { race: 'xd', div: 'op', shirt: 'L', team: 'VL-AAAA' }, { status: 'active' }),
      row('r2', { race: 'xd', div: 'op', shirt: 'S', team: 'VL-AAAA' }),
      row('r3', { race: 'md', div: 'el', shirt: 'XL', pair: true }),
      row('r4', { race: 'md', div: 'se', shirt: 'M', team: 'VL-BBBB' }),
      row('r5', { race: 'ws', div: 'so', shirt: 'XS' }),
    ]);
    const tq = page.locator('#tab-queue');
    await expect(tq.locator('.queue-table thead')).toContainText('Race');
    await expect(tq.locator('tr[data-id="r1"]')).toContainText('Mixed Doubles · Open');
    await expect(tq.locator('tr[data-id="r1"]')).toContainText('Athlete r2');
    await expect(tq.locator('tr[data-id="r1"]')).toContainText('Finished');
    await expect(tq.locator('.vl-split .run-split-b')).toHaveText([/Women’s Singles\s*1/, /Men’s Doubles\s*2/, /Mixed Doubles\s*2/, /Wants a partner\s*1/, /Waiting for partner\s*1/]);
    await tq.locator('.vl-split .run-split-b', { hasText: 'Wants a partner' }).click();
    await expect(tq.locator('.queue-table tbody tr[data-id]')).toHaveCount(1);
    await tq.locator('.vl-split .run-split-b', { hasText: 'Wants a partner' }).click();
    // pair r3 (wants a partner) with r4 (alone in VL-BBBB): r4's code is kept, both on one division
    const patches: { id: string; vl: Record<string, unknown> }[] = [];
    await page.route(/\/rest\/v1\/queue_entries\?/, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const id = /id=eq\.([^&]+)/.exec(route.request().url())?.[1] || '';
      const b = route.request().postDataJSON() as { vl: Record<string, unknown> };
      patches.push({ id, vl: b.vl });
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ id, vl: b.vl }]) });
    });
    await page.evaluate(`_vlPairOpen('r3')`);
    const box = page.locator('#vl-staff-host .vl-ae-box');
    await expect(box.locator('.vl-pr-row')).toHaveCount(1);
    await box.locator('.vl-pr-row').click();
    await box.locator('.btn-primary').click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches.map((p) => p.id)).toEqual(['r3', 'r4']);
    expect(patches[0].vl).toMatchObject({ race: 'md', div: 'el', team: 'VL-BBBB' });
    expect(patches[1].vl).toMatchObject({ race: 'md', div: 'el', team: 'VL-BBBB' });
  });

  test('athletes and teams, the race’s settings and the report for Kamin Sports open from the roster', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await staffBoot(page, [row('r1', { race: 'ws', div: 'so', shirt: 'M' }), row('r2', { race: 'wd', div: 'op', shirt: 'L', pair: true })]);
    await page.locator('#tab-queue .vl-staff-bar .btn-sm', { hasText: 'Athletes and teams' }).click();
    const host = page.locator('#vl-staff-host');
    await expect(host.locator('.vl-st-table tbody tr')).toHaveCount(2);
    await host.locator('.vl-st-tabs .filter-pill', { hasText: 'Partner requests' }).click();
    await expect(host.locator('.vl-st-table tbody tr')).toHaveCount(1);
    await host.locator('.vl-st-head .btn-sm', { hasText: 'Race settings' }).click();
    await expect(host.locator('.vl-cf-box')).toContainText('Races open to book');
    await expect(host.locator('#vl-cf-price')).toHaveValue('150');
    let saved: Record<string, unknown> | null = null;
    await page.route(/\/rest\/v1\/sessions\?/, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      saved = route.request().postDataJSON();
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' });
    });
    await host.locator('.vl-cf-chk', { hasText: 'Elite' }).last().locator('input').uncheck();
    await host.locator('#vl-cf-pay-en').fill('Pay at the venue on race day.');
    await host.locator('.vl-cf-box .btn-primary').click();
    await expect.poll(() => saved).not.toBeNull();
    expect(saved).toMatchObject({ price: 150, paid_ride: true, vl: { races: ['ws', 'ms', 'wd', 'md', 'xd'], divs: ['so', 'se', 'op'], pair: true, pay: { en: 'Pay at the venue on race day.' } } });
  });
});
