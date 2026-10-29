import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// The Arena Heros Hybrid Race (the owner, 2026-10-28): Victory Lap's machinery for a second race kind, 'arena'.
// Community members only, teams of two (two men or two women) and nothing else, Open or Elite, 140 SAR per
// athlete with the medals, Gymnation on Tahlia Street. The athlete step asks, prefilled from the account, the
// first and last name, email, mobile, gender (the race follows it), Open or Elite with the organisers' guide and
// the team; then the consent to share with WeSportify, Mile and Gymnation. Codes are AH-XXXX. How to pay is
// announced later; staff mark places paid. Staff get Victory Lap's tools, with a report set for the organisers.

const AH = '2099-11-06-ah';
const MAP = 'https://www.google.com/maps/search/?api=1&query=Gymnation%20Tahlia%20Street%20Jeddah';
const ah = {
  id: AH, session_date: '2099-11-06', day: 'Friday', status: 'open', capacity: 100, created_at: 1,
  event_kind: 'community', ride_kind: 'arena', needs_approval: false, hide_queue: true, spots: 100, open_to_all: false,
  paid_ride: true, price: 140, location: 'Gymnation, Tahlia Street', meet_url: MAP, bike_slots: '{"_time":"06:00 - 20:00"}',
  vl: { races: ['wd', 'md'], divs: ['op', 'el'], pair: true },
};
const jcc = { id: '2099-11-07', session_date: '2099-11-07', day: 'Saturday', status: 'open', capacity: 12, created_at: 1, location: 'JCC' };
const profile = (x: Record<string, unknown> = {}) => [{ id: 'c1', name: 'Sara Nabil Haddad', email: 'sara@example.com', phone: '+966500000001', birth_date: '1995-05-05', height: 165, type_preference: 'Any', nationality: 'SA', gender: 'female', ...x }];
const contact = [{ emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' }];
const row = (id: string, v: Record<string, unknown> | null, x: Record<string, unknown> = {}) => ({
  id, session_id: AH, session_day: 'Friday', session_date: '2099-11-06', queue_num: Number(id.slice(1)), name: 'Athlete ' + id,
  phone: '055000000' + id.slice(1), type_preference: 'None', size: '', status: 'waiting', paid: false, price: 140,
  registered_at: '2099-10-29T10:00:00Z', customer_id: 'c' + id, vl: v, ...x,
});
const JSON_HDR = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

async function custBoot(page: Page, fx: Record<string, unknown> = {}, cust: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [ah, jcc], queue_entries: [], 'rpc:community_member': true,
    'rpc:customer_profile': profile(), 'rpc:customer_emergency': contact, 'rpc:customer_set_gender': true, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Nabil Haddad', birth_date: '1995-05-05', gender: 'female', ...cust });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}
async function toStep2(page: Page) {
  await page.locator('#land-events .landing-event-card.ev-arena').click();
  await expect.poll(() => page.evaluate('S.selSession')).toBe(AH);
  await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
  await expect(page.locator('#ar-first')).toBeVisible();
}
/** Agree on the share gate, tick the waiver and book. */
async function agreeAndBook(page: Page) {
  const sg = page.locator('#share-gate');
  await sg.locator('.wg-cb').check();
  await sg.locator('.pg-btn').click();
  await page.locator('#reg-waiver-cb').check();
  await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
}
/** Records every body sent to one RPC and answers it. */
async function captureRpc(page: Page, fn: string, answer: unknown) {
  const calls: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route) => {
    try { calls.push(route.request().postDataJSON()); } catch { calls.push({}); }
    return route.fulfill({ status: 200, headers: JSON_HDR, body: JSON.stringify(answer) });
  });
  return calls;
}

test.describe('@customer:arena Arena Heros Hybrid Race', () => {
  test('a member sees the card (the wordmark, the day, the hours, Gymnation) and its Details: teams of two, Open or Elite, 140 per athlete', async ({ page }) => {
    await custBoot(page);
    const card = page.locator('#land-events .landing-event-card.ev-arena');
    await expect(card).toBeVisible();
    await expect(card.locator('.ar-mark')).toContainText('ARENA HEROS');
    await expect(card.locator('.lec-title')).toHaveText('Arena Heros Hybrid Race');
    await expect(card.locator('.ar-meta')).toContainText('6 AM - 8 PM');
    await expect(card.locator('.ar-meta')).toContainText('Gymnation, Tahlia Street');
    await expect(card.locator('.ar-sub')).toContainText('Teams of 2');
    await expect(card).not.toContainText('140');
    // About this event, for members
    const about = page.locator('.lec-about.ab-arena');
    await expect(about).toBeVisible();
    await about.click();
    const sheet = page.locator('#bike-info-modal');
    await expect(sheet).toContainText('WeSportify, Mile and Gymnation');
    await expect(sheet).toContainText('Teams of two (two men or two women) · 7 stations · medals included');
    await expect(sheet.locator('a[href="https://www.instagram.com/p/Dd1Lc87CJrq/"]')).toHaveCount(1);
    const facts: string[] = await page.evaluate(`_infoFacts(_sessGet('${AH}')).map(r=>r[0]+'|'+r[1].replace(/<[^>]+>/g,''))`);
    expect(facts.find((r) => r.startsWith('Who'))).toBe('Who|Community members, in teams of two');
    expect(facts.find((r) => r.startsWith('Price'))).toMatch(/140.*per athlete, medals included/);
    expect(facts.find((r) => r.startsWith('Divisions'))).toBe('Divisions|Open · Elite');
    expect(facts.find((r) => r.startsWith('Where'))).toContain('Gymnation, Tahlia Street');
    // the date's own Details: the hours with a break for prayer, the heat times from the organisers
    expect(await page.evaluate(`_infoFill(_infoText(INFO_DT.arena),_sessGet('${AH}'))`)).toBe('The race runs from 6 AM to 8 PM, with a break for prayer. The organisers give each team its heat time before race day.');
    // it is never a ride: no bike words, booked outside the booking window, no wallet pass
    expect(await page.evaluate(`(()=>{const s=_sessGet('${AH}');return [_noCycle(s),_ncEntry({sessionId:'2099-11-06-ah'}),_bwOpensOn(s),_walletOk(s,[]),_isRace(s),_evSeatPrice(s)];})()`))
      .toEqual([true, true, null, false, true, 140]);
  });

  test('a rider who is not a Community member gets the members popup, and no About link', async ({ page }) => {
    await custBoot(page, { 'rpc:community_member': false });
    const card = page.locator('#land-events .landing-event-card.ev-arena');
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator('#confirm-modal')).toContainText('Community members only');
    expect(await page.evaluate('S.view')).toBe('landing');
    await expect(page.locator('.lec-about.ab-arena')).toHaveCount(0);
  });

  test('the athlete step is prefilled from the account and editable; Open or Elite with the guide; a new team; the consent; the booking carries it all', async ({ page }) => {
    await custBoot(page);
    const rows = await captureBookingRows(page);
    await toStep2(page);
    // prefilled: the account's one name split, its email, its mobile with the country code, its gender
    await expect(page.locator('#ar-first')).toHaveValue('Sara');
    await expect(page.locator('#ar-last')).toHaveValue('Nabil Haddad');
    await expect(page.locator('#ar-email')).toHaveValue('sara@example.com');
    await expect(page.locator('#ar-cc')).toHaveValue('+966');
    await expect(page.locator('#ar-phone')).toHaveValue('500000001');
    await expect(page.locator('#vl-g-wrap .toggle-btn.active')).toHaveText('Female');
    await expect(page.locator('#vl-g-wrap .run-sub')).toHaveText('Women’s Doubles');
    // no race to pick, no T-shirt, no 5 km time, no age line
    await expect(page.locator('#vl-race-wrap')).toHaveCount(0);
    await expect(page.locator('#vl-shirt-wrap')).toHaveCount(0);
    await expect(page.locator('.vl-t5')).toHaveCount(0);
    await expect(page.locator('.vl-panel .run-adult')).toContainText('Teams of two only: two men or two women.');
    // Open or Elite, each with the organisers' guide, and the note with the race details
    const divs = page.locator('#vl-div-wrap .vl-div');
    await expect(divs).toHaveCount(2);
    await expect(divs.nth(0)).toContainText('Open');
    await expect(divs.nth(0)).toContainText('Intermediate');
    await expect(divs.nth(0)).toContainText('Reduced loads, distances or volume');
    await expect(divs.nth(1)).toContainText('Elite');
    await expect(divs.nth(1)).toContainText('Full prescribed loads, distances and volume');
    await expect(page.locator('#vl-div-wrap')).toContainText('Head Judge');
    await expect(page.locator('#vl-div-wrap a[href="https://www.instagram.com/p/Dd1Lc87CJrq/"]')).toHaveCount(1);
    // the team: start one, join with a code, or find me a partner
    await expect(page.locator('#vl-team-wrap .toggle-btn')).toHaveText(['Start a team', 'Join with a code', 'Find me a partner']);
    // a box left wrong is said where it is
    await page.fill('#ar-email', 'sara-at-example');
    await page.locator('#vl-next').click();
    await expect(page.locator('#ar-email + .field-err, #ar-email ~ .field-err').first()).toContainText('doesn’t look right');
    await page.fill('#ar-email', 'sara.h@example.com');
    await page.locator('#vl-next').click();
    await expect(page.locator('#vl-div-wrap .field-err')).toContainText('Pick a division.');
    await divs.nth(1).click();
    // edited: the race gets these, the account keeps its own
    await page.fill('#ar-first', 'Sarah');
    await page.fill('#ar-phone', '0512345678');
    await page.locator('#vl-next').click();
    await expect(page.locator('#share-gate .sg-box')).toBeVisible();
    await agreeAndBook(page);
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: AH, type_preference: 'None', price: 140, share_ok: true, name: 'Sara Nabil Haddad' });
    expect(rows[0].vl).toEqual({ race: 'wd', div: 'el', first: 'Sarah', last: 'Nabil Haddad', email: 'sara.h@example.com', phone: '+966512345678' });
  });

  test('the consent names WeSportify, Mile and Gymnation and what goes to them, and nothing is booked without it', async ({ page }) => {
    await custBoot(page);
    const rows = await captureBookingRows(page);
    await toStep2(page);
    await page.locator('#vl-div-wrap .vl-div').first().click();
    await page.locator('#vl-next').click();
    const sg = page.locator('#share-gate');
    await expect(sg).toContainText('its organisers, WeSportify, Mile and Gymnation');
    await expect(sg.locator('.sg-list li')).toHaveText(['First Name', 'Last Name', 'Email address', 'Mobile number', 'Gender', 'Division', 'Your team and its code']);
    await expect(sg).toContainText('I agree to MicroMobility sharing these details with WeSportify, Mile and Gymnation');
    await expect(sg).not.toContainText('Kamin');
    await expect(sg.locator('.pg-btn')).toBeDisabled();
    await sg.locator('.gate-out').click(); // Back
    await expect(sg.locator('.sg-box')).toHaveCount(0);
    expect(await page.evaluate('S.regStep')).toBe(2);
    // the review refuses a booking that skipped the step
    expect(await page.evaluate(`(S.regStep=3,validateRegInputs())`)).toBe(false);
    await expect(sg.locator('.sg-box')).toBeVisible();
    expect(rows.length).toBe(0);
  });

  test('a man on an account with no gender: he says it, the race is the men’s, and it is saved on the account', async ({ page }) => {
    await custBoot(page, { 'rpc:customer_profile': profile({ name: 'Omar Saleh', gender: null }) }, { name: 'Omar Saleh', gender: null });
    const rows = await captureBookingRows(page);
    const sets = await captureRpc(page, 'customer_set_gender', true);
    await toStep2(page);
    await expect(page.locator('#vl-g-wrap .toggle-btn.active')).toHaveCount(0);
    await expect(page.locator('#vl-g-wrap .run-sub')).toContainText('Teams are two women or two men');
    await page.locator('#vl-div-wrap .vl-div').first().click();
    await page.locator('#vl-next').click();
    await expect(page.locator('#vl-g-wrap .field-err')).toContainText('Choose your gender.');
    await page.locator('#vl-g-wrap .toggle-btn', { hasText: /^Male$/ }).click();
    await expect(page.locator('#vl-g-wrap .run-sub')).toHaveText('Men’s Doubles');
    await page.locator('#vl-div-wrap .vl-div').first().click();
    await page.locator('#vl-team-wrap .toggle-btn', { hasText: 'Find me a partner' }).click();
    await expect(page.locator('#vl-team-wrap .run-sub')).toContainText('pair you');
    await page.locator('#vl-next').click();
    await expect.poll(() => sets.length).toBe(1);
    expect(sets[0]).toMatchObject({ p_id: 'c1', p_gender: 'male' });
    await agreeAndBook(page);
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].vl).toMatchObject({ race: 'md', div: 'op', pair: true, first: 'Omar', last: 'Saleh' });
  });

  test('joining a partner’s team with an AH- code takes its division; a men’s team is refused to a woman', async ({ page }) => {
    await custBoot(page);
    const peeks = await captureRpc(page, 'vl_team_peek', [{ team: 'AH-4K7Q', race: 'wd', div: 'op', partner: 'Nora', need: 'female', is_full: false }]);
    const rows = await captureBookingRows(page);
    await toStep2(page);
    await page.locator('#vl-team-wrap .toggle-btn', { hasText: 'Join with a code' }).click();
    await expect(page.locator('#vl-code')).toHaveAttribute('placeholder', 'AH-XXXX');
    await expect(page.locator('#vl-div-wrap')).toContainText('You race in your team’s division.');
    await page.fill('#vl-code', 'ah 4k7q');
    await page.locator('#vl-team-wrap .vl-code-row .btn-secondary').click();
    await expect(page.locator('.vl-peek-ok')).toContainText('AH-4K7Q');
    await expect(page.locator('.vl-peek-ok')).toContainText('With Nora');
    expect(peeks[0]).toMatchObject({ p_session_id: AH, p_code: 'AH-4K7Q' });
    await expect(page.locator('#vl-div-wrap .vl-locked')).toHaveText('Open');
    await page.locator('#vl-next').click();
    await agreeAndBook(page);
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].vl).toEqual({ join: 'AH-4K7Q', race: 'wd', div: 'op', first: 'Sara', last: 'Nabil Haddad', email: 'sara@example.com', phone: '+966500000001' });
    // a code as typed reads with the race's own prefix, and a short one is said with the race's own example
    expect(await page.evaluate(`[_vlCode('ah4k7q','AH'),_vlCode('4K7Q','AH'),_vlCode('vl-4k7q'),t('arCodeBad')]`))
      .toEqual(['AH-4K7Q', 'AH-4K7Q', 'VL-4K7Q', 'Enter the code as your partner sent it, like AH-4K7Q.']);
  });

  test('the ticket: the team code, the division, the details sent, how to pay; no ticket question; the details can be changed', async ({ page }) => {
    const mine = row('m1', { race: 'wd', div: 'el', team: 'AH-AB23', first: 'Sara', last: 'Haddad', email: 'sara@example.com', phone: '+966500000001' },
      { customer_id: 'c1', name: 'Sara Nabil Haddad', data_share_at: '2099-10-29T10:00:00Z' });
    await custBoot(page, { queue_entries: [mine], 'rpc:my_bookings': [mine], 'rpc:customer_vl_teams': [] });
    const html = await page.evaluate(`renderBookingTicket([getQueue().find(e=>e.id==='m1')],{actions:true})`) as string;
    expect(html).toContain('th-arena');
    expect(html).toContain('ARENA HEROS');
    expect(html).toContain('Athlete number');
    expect(html).toContain('AH-AB23');
    expect(html).toContain('Waiting for your partner');
    expect(html).toContain('Elite');
    expect(html).not.toContain('6.1 km');
    expect(html).toContain('How to pay will be announced.');
    expect(html).toContain('Change details');
    expect(html).not.toContain('vt-tk');
    expect(html).not.toContain('buy one');
    expect(html).not.toContain('Pay at the booth');
    // staff's own payment line wins once they set one
    const said = await page.evaluate(`(()=>{const s=_sessGet('${AH}');s.vl={...s.vl,pay:{en:'Pay at Gymnation on race day.'}};return renderBookingTicket([getQueue().find(e=>e.id==='m1')],{actions:true});})()`) as string;
    expect(said).toContain('Pay at Gymnation on race day.');
    // Change details: the name, email and mobile as entered, and the division while alone in the team
    const upd = await captureRpc(page, 'customer_vl_update', true);
    await page.evaluate(`_vlEditOpen('m1')`);
    const box = page.locator('#confirm-modal .vl-ed-box');
    await expect(box.locator('#vl-ed-first')).toHaveValue('Sara');
    await expect(box.locator('#vl-ed-phone')).toHaveValue('500000001');
    await expect(box.locator('.vl-div')).toHaveCount(2);
    await expect(box.locator('#vl-ed-shirt')).toHaveCount(0);
    await box.locator('#vl-ed-email').fill('sara.new@example.com');
    await box.locator('.vl-div', { hasText: 'Open' }).click();
    await box.locator('.btn-primary').click();
    await expect.poll(() => upd.length).toBe(1);
    expect(upd[0]).toMatchObject({ p_entry_id: 'm1', p_patch: { div: 'op', email: 'sara.new@example.com' } });
    expect(Object.keys(upd[0].p_patch as Record<string, unknown>).sort()).toEqual(['div', 'email']);
  });

  test('a refusal from the database is said in the rider’s words', async ({ page }) => {
    await custBoot(page);
    const said = await page.evaluate(`(()=>{const out=[];const t0=window.toast;window.toast=(m)=>out.push(m);
      _bookRefused({message:'x',details:'VL_ONE_EACH'},_sessGet('${AH}'));
      _bookRefused({message:'This team is complete.',details:'VL_TEAM_FULL'},_sessGet('${AH}'));window.toast=t0;return out;})()`);
    expect(said).toEqual(['You already have a place in the Arena Heros Hybrid Race.', 'This team already has two athletes.']);
  });
});

test.describe('@staff:bookings Arena Heros Hybrid Race', () => {
  async function staffBoot(page: Page, q: Record<string, unknown>[], fx: Record<string, unknown> = {}) {
    await stubSupabase(page, { sessions: [ah, jcc], bikes: [], queue_entries: q, ...fx });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${AH}';renderStaffQueue()`);
  }
  const det = (f: string, l: string) => ({ first: f, last: l, email: f.toLowerCase() + '@example.com', phone: '+96650000000' + f.length });

  test('the new-session form has an Arena Heros kind: 140 per athlete, 100 places, members only, at Gymnation', async ({ page }) => {
    const d = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    await stubSupabase(page, { sessions: [jcc], queue_entries: [], bikes: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    const posts: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/sessions') && r.method() === 'POST') { try { posts.push(r.postDataJSON()); } catch { /* */ } } });
    await page.locator('#sess-host .ev-pick.ev-arena').click();
    await expect(page.locator('#sess-host .ev-pick.ev-arena')).toHaveText('Arena Heros Hybrid Race');
    await expect(page.locator('#sess-host .ss-hint', { hasText: 'Arena' })).toContainText('WeSportify, Mile and Gymnation');
    await expect(page.locator('#ns-title')).toHaveValue('Arena Heros Hybrid Race');
    await expect(page.locator('#ns-price')).toHaveValue('140');
    await expect(page.locator('#ns-spots')).toHaveValue('100');
    await expect(page.locator('#ns-map')).toHaveValue(MAP);
    await page.locator('#ns-date').fill(d(9));
    await page.locator('#ns-start').fill('06:00');
    await page.locator('#ns-end').fill('20:00');
    await page.evaluate(`addSession()`);
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ id: d(9) + '-ah', capacity: 100, spots: 100, status: 'closed', event_kind: 'community', ride_kind: 'arena',
      open_to_all: false, paid_ride: true, price: 140, needs_approval: false, hide_queue: true, title: null, location: 'Gymnation, Tahlia Street',
      meet_url: MAP, bike_slots: '{"_time":"06:00 - 20:00"}' });
  });

  test('the roster’s Race column and split, Athletes and teams with the details sent, no ticket or receipt tools', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await staffBoot(page, [
      row('r1', { race: 'wd', div: 'op', team: 'AH-AAAA', ...det('Sara', 'Haddad') }),
      row('r2', { race: 'wd', div: 'op', team: 'AH-AAAA', ...det('Nora', 'Saleh') }),
      row('r3', { race: 'md', div: 'el', pair: true, ...det('Omar', 'Ali') }),
      row('r4', { race: 'md', div: 'el', team: 'AH-BBBB', ...det('Fahad', 'Nasser') }),
    ]);
    const tq = page.locator('#tab-queue');
    await expect(tq.locator('.queue-table thead')).toContainText('Race');
    await expect(tq.locator('tr[data-id="r1"]')).toContainText('Women’s Doubles · Open');
    await expect(tq.locator('tr[data-id="r1"]')).toContainText('AH-AAAA');
    await expect(tq.locator('tr[data-id="r1"]')).toContainText('Athlete r2');
    await expect(tq.locator('tr[data-id="r1"] .vt-chip')).toHaveCount(0);
    await expect(tq.locator('.vl-split .run-split-b')).toHaveText([/Women’s Doubles\s*2/, /Men’s Doubles\s*2/, /Wants a partner\s*1/, /Waiting for partner\s*1/]);
    const bar = tq.locator('.vl-staff-bar');
    await expect(bar.locator('.btn-sm')).toHaveText([/Athletes and teams/, /Race settings/, /Report builder/]);
    await bar.locator('.btn-sm', { hasText: 'Athletes and teams' }).click();
    const host = page.locator('#vl-staff-host');
    await expect(host.locator('.vl-st-table thead')).toContainText('Mobile number');
    await expect(host.locator('.vl-st-table thead')).not.toContainText('T-shirt');
    await expect(host.locator('.vl-st-table tbody tr')).toHaveCount(4);
    await expect(host.locator('.vl-st-table tbody')).toContainText('nora@example.com');
    await expect(host.locator('.vl-st-tile')).toHaveCount(2);
    // Race settings: the Arena race's races and divisions, its price, the organisers' list
    await host.locator('.vl-st-head .btn-sm', { hasText: 'Race settings' }).click();
    await expect(host.locator('.vl-cf-box .vl-cf-chk')).toHaveText([/Women’s Doubles/, /Men’s Doubles/, /^\s*Open$/, /^\s*Elite$/, /find them a partner/]);
    await expect(host.locator('#vl-cf-price')).toHaveValue('140');
    await expect(host.locator('.vl-cf-box')).toContainText('What is shared with the organisers');
    await expect(host.locator('.vl-cf-box')).not.toContainText('Kamin');
    // an athlete's race details: the details they entered, no T-shirt, no ticket
    await page.evaluate(`_vlAthleteEdit('r3')`);
    const ae = page.locator('#vl-staff-host .vl-ae-box');
    await expect(ae.locator('#vl-ae-first')).toHaveValue('Omar');
    await expect(ae.locator('#vl-ae-phone')).toHaveValue('+966500000004');
    await expect(ae.locator('#vl-ae-shirt')).toHaveCount(0);
    await expect(ae.locator('#vl-ae-tk')).toHaveCount(0);
    await expect(ae.locator('#vl-ae-race option')).toHaveText(['No race yet', 'Women’s Doubles', 'Men’s Doubles']);
  });

  test('the report builder opens on the organisers’ set: first and last name, email and mobile as entered, gender, division, team', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const q = [
      row('r1', { race: 'wd', div: 'op', team: 'AH-AAAA', ...det('Sarah', 'Haddad') }, { data_share_at: '2099-10-29T10:00:00Z' }),
      row('r2', { race: 'wd', div: 'op', team: 'AH-AAAA', ...det('Nora', 'Saleh') }, { data_share_at: '2099-10-29T10:00:00Z' }),
      row('r3', { race: 'md', div: 'el', pair: true, ...det('Omar', 'Ali') }, { data_share_at: '2099-10-29T10:00:00Z' }),
    ];
    const cust = q.map((r, i) => ({ id: r.customer_id, name: r.name, email: r.id + '@account.example', phone: r.phone, birth_date: '1990-01-0' + (i + 1), gender: ['female', 'female', 'male'][i] }));
    await staffBoot(page, q, { customers: cust });
    await page.evaluate(`localStorage.setItem('cq_vl_rep_opts',JSON.stringify({set:'kamin'}));S._vrbO=null;renderStaffQueue()`);
    await page.locator('#tab-queue .vl-staff-bar .btn-sm', { hasText: 'Report builder' }).click();
    const m = page.locator('#print-opts-modal');
    await expect(m.locator('#dlgt-vrb')).toHaveText('Arena Heros Hybrid Race · Report builder');
    await expect(m.locator('.rr-presets .btn-sm')).toHaveText(['Report for the organisers', 'Start list', 'Contacts', 'Payments']);
    await expect(m.locator('.rr-presets .btn-primary')).toHaveText('Report for the organisers');
    await expect(m).not.toContainText('T-shirt');
    await expect(m).not.toContainText('Receipts');
    await expect(m.locator('#vrb-count')).toContainText('On the report: 3 / 3');
    const sheet = await page.evaluate(`(async()=>{const d=await _vrbLoad('${AH}',true);const b=_vrbBuild(d,_vrbDefaults('org'));
      return {cols:b.cols.map(c=>c.k),rows:b.rows.map(r=>b.cols.map(c=>String(_vrbCell(c.k,r,b.units.find(u=>u.rows.includes(r))))).join('|'))};})()`) as { cols: string[]; rows: string[] };
    expect(sheet.cols).toEqual(['seq', 'num', 'status', 'first', 'last', 'gender', 'email', 'phone', 'race', 'div', 'team', 'mate', 'share']);
    // the one who wants a partner first, then the team together; the details as the athletes entered them
    expect(sheet.rows[0]).toBe('1|#3|Booked|Omar|Ali|Male|omar@example.com|+966500000004|Men’s Doubles|Elite||Wants a partner|Yes');
    expect(sheet.rows[1]).toBe('2|#1|Booked|Sarah|Haddad|Female|sarah@example.com|+966500000005|Women’s Doubles|Open|AH-AAAA|Athlete r2|Yes');
    expect(sheet.rows[2]).toContain('|Nora|Saleh|Female|nora@example.com|');
    // Excel: named for the race, the organisers' set
    const [dl] = await Promise.all([page.waitForEvent('download'), m.locator('.rpt-acts .btn-secondary', { hasText: 'Excel' }).click()]);
    expect(dl.suggestedFilename()).toBe('arena-heros_2099-11-06_org.xlsx');
    const buf = readFileSync((await dl.path())!).toString('utf8');
    expect(buf).toContain('sarah@example.com');
    expect(buf).not.toContain('r1@account.example');
  });
});
