import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// Victory Lap by Fitness Empire (the owner, 2026-10-14 and 2026-10-17): a hybrid fitness race run by Kamin
// Sports. Its card (D) shows to every signed-in rider, without a price; Community members and Victory Lap
// tag holders book it (vlap_member). Five races, four divisions, 150 SAR per athlete, a T-shirt size and an
// optional 5 km time, 16 and over, the agreement to share with Kamin Sports, Doubles teams joined by a code,
// one Singles and one Doubles place per account, and staff who manage every part of it.

const VL = '2099-10-26-vl';
const PNG_S = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
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
    await expect(page.locator('#tab-register')).toContainText('tell us whether you already have a ticket');
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
    expect(html).toContain('Do you already have a ticket, or would you like to buy one?');
    expect(html).toContain('Change details');
  });

  // The owner, 2026-10-23: once booked, "Do you already have a ticket, or would you like to buy one?" before the
  // booking card. Buying shows the organiser's bank details and letter and takes a picture of the transfer receipt.
  async function bookSingles(page: Page) {
    await toStep2(page);
    await page.locator('#vl-race-wrap .vl-race').first().click();
    await page.locator('#vl-div-wrap .vl-div').first().click();
    await page.locator('#vl-shirt-wrap .toggle-btn', { hasText: /^M$/ }).click();
    await page.locator('#vl-next').click();
    await page.locator('#share-gate .wg-cb').check();
    await page.locator('#share-gate .pg-btn').click();
    await page.locator('#reg-waiver-cb').check();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
  }
  const PNG = Buffer.from(PNG_S, 'base64');

  test('after booking: buying a ticket shows the bank details and the letter, and the receipt waits for staff to check it', async ({ page }) => {
    await custBoot(page, { 'rpc:customer_vl_ticket': true });
    const rows = await captureBookingRows(page);
    const calls: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/customer_vl_ticket')) calls.push(r.postDataJSON()); });
    await bookSingles(page);
    await expect.poll(() => rows.length).toBe(1);
    const g = page.locator('#vl-ticket-gate');
    await expect(g).toContainText('Do you already have a ticket, or would you like to buy one?');
    await expect(g.locator('.vt-x')).toHaveCount(0); // the booking just made: answer first
    await g.locator('.vt-yn .toggle-btn').nth(1).click();
    await expect(g).toContainText('SA73 2000 0003 0002 7515 9940');
    await expect(g).toContainText('Sports Fitness Unit Company');
    await expect(g).toContainText('Riyad Bank');
    await expect(g).toContainText('150');
    await expect(g.locator('a.vt-pdf')).toHaveAttribute('href', '/assets/victory-lap-bank-letter.pdf');
    await expect(g.locator('.pg-btn')).toBeDisabled();
    await g.locator('input[type=file]').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: PNG });
    await expect(g.locator('img.vt-prev')).toBeVisible();
    await g.locator('.pg-btn').click();
    await expect(g.locator('.vt-box')).toHaveCount(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ p_id: 'c1', p_answer: 'buy' });
    expect(String(calls[0].p_img)).toMatch(/^data:image\/jpeg;base64,/);
    await expect(page.locator('#tab-register')).toContainText('Receipt sent. Our team will check it and confirm your ticket.');
    await expect(page.locator('#tab-register')).not.toContainText('Your ticket is paid');
  });

  test('after booking: "I already have a ticket" asks nothing more; an older place asks on its ticket only', async ({ page }) => {
    const old = row('m3', { race: 'ws', div: 'so', shirt: 'M' }, { customer_id: 'c1', name: 'Sara Haddad' });
    await custBoot(page, { 'rpc:customer_vl_ticket': true, queue_entries: [old], 'rpc:my_bookings': [old] });
    await expect(page.locator('#vl-ticket-gate .vt-box')).toHaveCount(0); // a place booked before this is not asked by a pop-up
    const html = await page.evaluate(`renderBookingTicket([getQueue().find(e=>e.id==='m3')],{actions:true})`);
    expect(html).toContain('I already have a ticket');
    await page.evaluate(`_vtAsk('m3',true)`);
    const g = page.locator('#vl-ticket-gate');
    await g.locator('.vt-yn .toggle-btn', { hasText: 'I already have a ticket' }).click();
    await expect(g.locator('.vt-box')).toHaveCount(0);
    expect(await page.evaluate(`renderBookingTicket([getQueue().find(e=>e.id==='m3')],{actions:true})`)).toContain('You have a ticket for the race.');
    // a place staff marked paid asks nothing
    const paid = await page.evaluate(`renderBookingTicket([entryFromDB(${JSON.stringify({ ...old, id: 'm4', paid: true })})],{actions:true})`);
    expect(paid).not.toContain('would you like to buy one');
  });

  // Staff confirm each receipt (the owner, 2026-10-24): sent, the ticket says it waits for them; confirmed, it is paid.
  test('a receipt sent waits for staff on the ticket, and a confirmed one says the ticket is paid', async ({ page }) => {
    const sent = row('m6', { race: 'ws', div: 'so', shirt: 'M' }, { customer_id: 'c1', name: 'Sara Haddad', vl_ticket: 'buy', vl_receipt_at: '2099-10-20T10:00:00Z' });
    await custBoot(page, { 'rpc:customer_vl_ticket': true, queue_entries: [sent], 'rpc:my_bookings': [sent] });
    const html = await page.evaluate(`renderBookingTicket([getQueue().find(e=>e.id==='m6')],{actions:true})`);
    expect(html).toContain('Receipt sent. Our team will check it and confirm your ticket.');
    expect(html).not.toContain('Your ticket is paid');
    const paid = await page.evaluate(`renderBookingTicket([entryFromDB(${JSON.stringify({ ...sent, id: 'm7', paid: true, pay_method: 'transfer' })})],{actions:true})`);
    expect(paid).toContain('Receipt confirmed. Your ticket is paid.');
  });

  test('a database without the ticket question lets the athlete through: the pop-up steps aside', async ({ page }) => {
    const old = row('m5', { race: 'ws', div: 'so', shirt: 'M' }, { customer_id: 'c1', name: 'Sara Haddad' });
    await custBoot(page, { queue_entries: [old], 'rpc:my_bookings': [old],
      'rpc:customer_vl_ticket': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_vl_ticket in the schema cache' } } });
    await page.evaluate(`_vtAsk('m5',true)`);
    const g = page.locator('#vl-ticket-gate');
    await g.locator('.vt-yn .toggle-btn').first().click();
    await expect(g.locator('.vt-box')).toHaveCount(0);
    expect(await page.evaluate(`renderBookingTicket([getQueue().find(e=>e.id==='m5')],{actions:true})`)).not.toContain('vt-tk');
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
    const medal = await page.evaluate(`_bdgMedal('lapring','vlap')`) as string;
    expect(medal).toContain('bdg-sp');
    // black and white (the owner, 2026-10-27): grey into black, no purple left
    for (const c of ['#bdbdbd', '#333333', '#000000']) expect(medal).toContain(c);
    expect(medal).not.toMatch(/#b9a6ff|#5b3fd6|#1b1236|#140c2e/);
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
  test('the roster says each athlete’s ticket, and a paid one opens its receipt', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [vl, jcc], bikes: [], queue_entries: [
      row('q1', { race: 'ws', div: 'so', shirt: 'M' }, { vl_ticket: 'buy', vl_receipt_at: '2099-10-20T10:00:00Z', paid: true, pay_method: 'transfer' }),
      row('q2', { race: 'ms', div: 'op', shirt: 'L' }, { vl_ticket: 'have' }),
      row('q3', { race: 'ms', div: 'el', shirt: 'L' }),
    ], vl_receipts: [{ entry_id: 'q1', img: 'data:image/png;base64,' + PNG_S }] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${VL}';renderStaffQueue()`);
    const cells: string[] = await page.evaluate(`['q1','q2','q3'].map(id=>_vtStaffChip(getQueue().find(e=>e.id===id)))`);
    expect(cells[0]).toContain('Paid by transfer');
    expect(cells[1]).toContain('Has a ticket');
    expect(cells[2]).toContain('Not answered');
    await page.evaluate(`_vtRcptOpen('q1')`);
    await expect(page.locator('#vl-staff-host img.vt-rc-img')).toBeVisible();
  });
  // Staff confirm each receipt (the owner, 2026-10-24): the roster says a receipt is still to check, and its
  // viewer confirms it or, asked a second time, sends it back (staff_vl_receipt).
  test('a receipt waits for staff: Confirm marks it paid by transfer, Not valid asks again and sends it back', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions: [vl, jcc], bikes: [], queue_entries: [
      row('q4', { race: 'ws', div: 'so', shirt: 'M' }, { vl_ticket: 'buy', vl_receipt_at: '2099-10-20T10:00:00Z' }),
      row('q5', { race: 'ms', div: 'op', shirt: 'L' }, { vl_ticket: 'buy', vl_receipt_at: '2099-10-20T11:00:00Z' }),
    ] });
    // the receipt viewer reads one picture by booking (the shared stub returns every row of a table)
    await page.route(/\/rest\/v1\/vl_receipts/, (r) => {
      const id = (new URL(r.request().url()).searchParams.get('entry_id') || '').replace(/^eq\./, '');
      const pic = ['q4', 'q5'].includes(id) ? { img: 'data:image/png;base64,' + PNG_S } : null;
      return r.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(pic) });
    });
    const calls: Record<string, unknown>[] = [];
    let answer = 'confirmed';
    await page.route(/\/rpc\/staff_vl_receipt/, async (r) => {
      calls.push(r.request().postDataJSON());
      return r.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${VL}';renderStaffQueue()`);
    expect(await page.evaluate(`_vtStaffChip(getQueue().find(e=>e.id==='q4'))`)).toContain('Receipt to check');
    const host = page.locator('#vl-staff-host');
    await page.evaluate(`_vtRcptOpen('q4')`);
    await host.getByRole('button', { name: 'Confirm receipt' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_entry_id: 'q4', p_ok: true });
    await expect(page.locator('.toast').filter({ hasText: 'Receipt confirmed. The place is paid by transfer.' })).toBeAttached(); // staff success toasts are quiet
    answer = 'returned';
    await page.evaluate(`_vtRcptOpen('q5')`);
    await host.getByRole('button', { name: 'Not valid' }).click();
    await expect(host).toContainText('Send this receipt back?');
    expect(calls).toHaveLength(1); // nothing sent until it is asked twice
    await host.getByRole('button', { name: 'Send back' }).click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toEqual({ p_entry_id: 'q5', p_ok: false });
    await expect(page.locator('.toast').filter({ hasText: 'Receipt sent back. The athlete is asked to upload it again.' })).toBeAttached(); // staff success toasts are quiet
  });
  // The report builder (the owner, 2026-10-23): columns, filters, sorts and groups, and whatever is picked a
  // Doubles team prints and exports as one unit - its partners together under the team, far apart as their
  // numbers are.
  test('the report builder keeps Doubles partners together in the PDF and in Excel, under any sort or filter', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const q = [
      row('r1', { race: 'xd', div: 'op', shirt: 'M', team: 'VL-AAAA' }),
      row('r2', { race: 'ws', div: 'so', shirt: 'S' }),
      row('r3', { race: 'md', div: 'el', shirt: 'L', pair: true }),
      row('r4', { race: 'wd', div: 'so', shirt: 'M', team: 'VL-BBBB' }),
      row('r5', { race: 'xd', div: 'op', shirt: 'XL', team: 'VL-AAAA' }),
    ];
    const cust = q.map((r, i) => ({ id: r.customer_id, name: r.name, email: r.id + '@example.com', phone: r.phone, birth_date: '1990-01-0' + (i + 1), gender: ['female', 'female', 'male', 'female', 'male'][i] }));
    await stubSupabase(page, { sessions: [vl, jcc], bikes: [], queue_entries: q, customers: cust });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`localStorage.removeItem('cq_vl_rep_opts');S._vrbO=null;setStaffTab('queue');S.queueView='bookings';S.sfSession='${VL}';renderStaffQueue()`);
    await page.locator('#tab-queue .vl-staff-bar .btn-sm', { hasText: 'Report builder' }).click();
    const m = page.locator('#print-opts-modal');
    await expect(m.locator('#dlgt-vrb')).toHaveText('Victory Lap report');
    await expect(m.locator('#vrb-count')).toContainText('On the report: 5 / 5');
    await expect(m.locator('#vrb-count')).toContainText('Teams: 2');
    // the order on the sheet: Singles, then who wants a partner, then each team with both partners together
    const names = (o: string) => page.evaluate(`(async()=>{const d=await _vrbLoad('${VL}',true);const b=_vrbBuild(d,{..._vrbDefaults(),...${o}});return b.rows.map(r=>r.e.id).join(',');})()`);
    expect(await names('{}')).toBe('r2,r3,r1,r5,r4');
    expect(await names('{sort:"nameZ"}')).toBe('r2,r3,r4,r1,r5');
    expect(await names('{group:"race"}')).toBe('r2,r4,r3,r1,r5');
    // a filter that keeps one partner brings the other along, unless that is unticked
    expect(await names('{fGender:"female",fRace:"xd"}')).toBe('r1,r5');
    expect(await names('{fGender:"female",fRace:"xd",flags:{withMate:0}}')).toBe('r1');
    await m.locator('select[aria-label="Race"]').selectOption('doubles');
    await expect(m.locator('#vrb-count')).toContainText('On the report: 4 / 5');
    await m.locator('select[aria-label="Race"]').selectOption('all');
    // the PDF: the team heading line, then its two partners
    const [pop] = await Promise.all([page.waitForEvent('popup'), m.locator('.rpt-acts .btn-primary').click()]);
    await pop.waitForLoadState();
    await pop.locator('table tbody tr').first().waitFor(); // the report is written into the window after it opens
    const lines: string[] = await pop.evaluate(() => [...[...document.querySelectorAll('table')].pop()!.querySelectorAll('tbody tr')]
      .map((r) => (r.classList.contains('rp-team') ? 'T:' : '') + [...r.querySelectorAll('td')].map((c) => (c.textContent || '').trim()).join('|')));
    const ix = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(lines[ix('VL-AAAA')]).toMatch(/^T:Doubles team VL-AAAA · Mixed Doubles/);
    const num = (n: string) => lines.findIndex((l) => l.split('|')[1] === n); // a row reads "<No.>|#<number>|<status>|<name>|..."
    expect(num('#1')).toBe(ix('VL-AAAA') + 1);
    expect(num('#5')).toBe(ix('VL-AAAA') + 2);
    expect(num('#4')).toBe(ix('VL-BBBB') + 1);
    expect(lines[ix('VL-BBBB')]).toContain('Waiting for partner');
    await pop.close();
    // Excel: Athletes, Teams, Still need a partner and Summary; in the athletes sheet r5 follows r1
    const [dl] = await Promise.all([page.waitForEvent('download'), m.locator('.rpt-acts .btn-secondary', { hasText: 'Excel' }).click()]);
    const buf = readFileSync((await dl.path())!).toString('utf8');
    expect(dl.suggestedFilename()).toBe('victory-lap_2099-10-26_kamin.xlsx');
    for (const n of ['Athletes', 'Teams', 'Still need a partner', 'Summary']) expect(buf).toContain(`name="${n}"`);
    const s1 = buf.slice(buf.indexOf('<worksheet'), buf.indexOf('</worksheet>'));
    const at = (x: string) => s1.indexOf(x);
    expect(at('Athlete r2')).toBeLessThan(at('Athlete r1'));
    expect(at('Athlete r1')).toBeLessThan(at('Athlete r5'));
    expect(at('Athlete r5')).toBeLessThan(at('Athlete r4'));
  });
  // Doubles read as one everywhere (the owner, 2026-10-25): on the roster and in Athletes and teams the partners
  // sit together under one frame whatever their numbers; staff upload a receipt; the receipts PDF carries it.
  test('Doubles partners sit together with a Doubles team mark; staff upload a receipt; the receipts PDF prints it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const q = [
      row('r1', { race: 'xd', div: 'op', shirt: 'M', team: 'VL-AAAA' }),
      row('r2', { race: 'ws', div: 'so', shirt: 'S' }, { vl_ticket: 'buy', vl_receipt_at: '2099-10-20T10:00:00Z', paid: true, pay_method: 'transfer' }),
      row('r3', { race: 'xd', div: 'op', shirt: 'XL', team: 'VL-AAAA' }),
    ];
    const pic = 'data:image/png;base64,' + PNG_S;
    await stubSupabase(page, { sessions: [vl, jcc], bikes: [], queue_entries: q, customers: q.map((r) => ({ id: r.customer_id, name: r.name, phone: r.phone })) });
    await page.route(/\/rest\/v1\/vl_receipts/, (r) => {
      const u = new URL(r.request().url()), one = u.searchParams.get('entry_id') || '';
      const body = one.startsWith('in.') ? [{ entry_id: 'r2', img: pic }] : one === 'eq.r2' ? { img: pic } : null;
      return r.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    });
    const puts: Record<string, string>[] = [];
    await page.route(/\/rpc\/staff_vl_receipt_put/, async (r) => {
      puts.push(r.request().postDataJSON());
      return r.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '"confirmed"' });
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${VL}';renderStaffQueue()`);
    const tq = page.locator('#tab-queue');
    await expect(tq.locator('.queue-table tbody tr[data-id]')).toHaveCount(3);
    expect(await tq.locator('.queue-table tbody tr[data-id]').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-id')))).toEqual(['r1', 'r3', 'r2']);
    await expect(tq.locator('tr[data-id="r1"]')).toHaveClass(/vl-dbl-t/);
    await expect(tq.locator('tr[data-id="r3"]')).toHaveClass(/vl-dbl-b/);
    await expect(tq.locator('tr[data-id="r2"]')).not.toHaveClass(/vl-dbl/);
    await expect(tq.locator('tr[data-id="r1"] .vl-dbl-chip')).toHaveText('Doubles team');
    // Athletes and teams: the same order and mark
    await page.evaluate(`_vlStaffOpen('${VL}')`);
    const host = page.locator('#vl-staff-host');
    expect(await host.locator('.vl-st-table tbody tr').evaluateAll((rs) => rs.map((r) => r.querySelector('td')!.textContent))).toEqual(['#1', '#3', '#2']);
    await expect(host.locator('.vl-st-table tbody tr.vl-dbl')).toHaveCount(2);
    // staff upload r1's receipt from the roster chip: the place is paid by transfer
    await page.evaluate(`_vlClose();_vtRcptOpen('r1')`);
    await host.locator('.vt-pick input[type=file]').setInputFiles({ name: 'r.png', mimeType: 'image/png', buffer: Buffer.from(PNG_S, 'base64') });
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0].p_entry_id).toBe('r1');
    expect(puts[0].p_img).toMatch(/^data:image\/jpeg;base64,/);
    await expect(page.locator('.toast').filter({ hasText: 'Receipt saved. The place is paid by transfer.' })).toBeAttached();
    // the receipts PDF: a team block with both partners, r2's picture on its card
    await page.evaluate(`_vlClose()`);
    const [pop] = await Promise.all([page.waitForEvent('popup'), tq.locator('.vl-staff-bar .btn-sm', { hasText: 'PDF with receipts' }).click()]);
    await pop.waitForLoadState();
    await pop.locator('.vrc-card').first().waitFor();
    await expect(pop.locator('.vrc-team')).toHaveCount(1);
    await expect(pop.locator('.vrc-team-h')).toContainText('Doubles team VL-AAAA');
    await expect(pop.locator('.vrc-team .vrc-card')).toHaveCount(2);
    await expect(pop.locator('.vrc-solo .vrc-card img.vrc-img')).toHaveCount(1);
    await expect(pop.locator('.vrc-solo')).toContainText('Athlete r2');
    await pop.close();
  });
});
