import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, rateGateOn, unlockStaff } from './helpers/supabase';

// A session with no bike says nothing about cycling (the owner, 2026-10-18: "make sure all non-cycling related
// sessions dont include anything about cycling anywhere especially in surveys registration etc."): a swim, a
// workshop, an event, a run and Victory Lap say session, participant and place, never ride, rider or bike.
const d = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const today = d(0);
const CYCLING = /\b(ride|rides|rider|riders|riding|bike|bikes|cycling|cyclist)\b/i;
const swim = (date: string) => ({ id: date, day: 'Friday', session_date: date, capacity: 20, status: 'open', created_at: 1, event_kind: 'community',
  ride_kind: 'swim', needs_approval: true, hide_queue: true, paid_ride: false, title: 'Pool morning', bike_slots: '{"_time":"07:00 - 08:30"}' });
const ev = (date: string) => ({ id: date + '-ev', day: 'Friday', session_date: date, capacity: 30, spots: 30, status: 'open', created_at: 1, event_kind: 'community',
  ride_kind: 'event', paid_ride: true, price: 40, open_to_all: true, needs_approval: false, hide_queue: true, title: 'Pottery class', bike_slots: '{"_time":"19:00 - 21:00"}' });
const row = (id: string, sid: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, name: 'Spec Rider', customer_id: 'c1', session_id: sid, session_day: 'Friday', session_date: date, queue_num: 1,
  status: 'done', paid: true, price: 0, checked_out_at: date + 'T11:00:00Z', registered_at: date + 'T10:00:00Z', ...extra,
});
const rateOpen = (page: Page) => page.evaluate(`!!S._rg&&document.getElementById('rate-modal').style.display==='block'`);
const qs = (page: Page) => page.locator('#rate-modal .rg-q').evaluateAll((els) => els.map((e) => e.id.replace('rgq-', '')));

async function bootCustomer(page: Page, sessions: unknown[], queue: unknown[], gate = true) {
  await stubSupabase(page, { sessions, queue_entries: queue, bikes: [], 'rpc:my_bookings': queue, 'rpc:customer_booking_update': true });
  if (gate) await rateGateOn(page);
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@customer:rating a bike-free session is rated as a session', () => {
  test('a swim: the title, the questions and the thanks say session, and nothing says ride or bike', async ({ page }) => {
    await bootCustomer(page, [swim(today)], [row('q1', today, today)]);
    await page.evaluate(`S.view='customer'; setCustTab('myrides')`);
    expect(await rateOpen(page)).toBe(true);
    const m = page.locator('#rate-modal');
    await expect(m.locator('#rate-title')).toHaveText('How was your session?');
    expect(await qs(page)).toEqual(['service', 'experience']);
    await expect(m).not.toContainText(CYCLING);
    await m.locator('#rgq-service .rg-b[data-v="10"]').click();
    await m.locator('#rgq-experience .rg-b[data-v="9"]').click();
    await m.locator('.pg-btn').click();
    await expect(page.locator('#toast, .toast').first()).toContainText('Thanks for rating your session.');
  });

  test('an event whose session is not loaded is still a session: its id says so, and no bike question comes', async ({ page }) => {
    await bootCustomer(page, [], [row('q1', today + '-ev', today)]);
    await page.evaluate(`S.view='customer'; setCustTab('myrides')`);
    expect(await rateOpen(page)).toBe(true);
    const m = page.locator('#rate-modal');
    expect(await qs(page)).toEqual(['service', 'experience']);
    await expect(m.locator('#rate-title')).toHaveText('How was your session?');
    await expect(m).not.toContainText(CYCLING);
  });

  test('a past swim ticket offers Rate your session, and the account page counts no ride for it', async ({ page }) => {
    await bootCustomer(page, [swim(d(-3))], [row('q1', d(-3), d(-3))], false);
    await page.evaluate(`goCustomer('myrides')`);
    const tab = page.locator('#tab-myrides');
    await expect(tab.locator('button', { hasText: 'Rate your session' })).toBeVisible();
    await expect(tab.locator('button', { hasText: 'Rate your ride' })).toHaveCount(0);
    await expect(tab.locator('.page-sub').first()).toHaveText('Your tickets for what’s ahead, and what you’ve done.');
    const counted = await page.evaluate(`(()=>{const all=getQueue().filter(e=>e.customerId==='c1');const b=_mrBadges(all,all.filter(_bdgRode),[],null);return{first:b.find(x=>x.s==='first_lap').on,stats:_myrStats(all.filter(e=>!_ncEntry(e)))};})()`);
    expect(counted).toEqual({ first: false, stats: '' });
  });
});

test.describe('@customer:reserve an event books participants, not riders', () => {
  test('the steps say session and participants, never ride, rider or bike', async ({ page }) => {
    const e = ev(d(4));
    await bootCustomer(page, [e], [], false);
    await page.evaluate(`S.selEvent='event';S.selSession=null;S.regStep=1;goCustomer('register')`);
    const reg = page.locator('#tab-register');
    await expect(reg.locator('.page-title')).toHaveText(/Your session|Choose your session/);
    await expect(reg.locator('.cu-step-lbl')).toHaveText('Session');
    await expect(reg).not.toContainText(CYCLING);
    await page.evaluate(`S.selSession=${JSON.stringify(e.id)};S.regQty=2;S.regStep=2;renderRegister()`);
    await expect(reg.locator('.page-title')).toHaveText('Who is coming');
    await expect(reg.locator('.cu-step-lbl')).toHaveText('Participants');
    await expect(reg.locator('.cu-rider-head').first()).toContainText('Participant');
    await expect(reg.locator('label[for="reg-rider-name-1"]')).toHaveText('Participant’s full name');
    await expect(reg.locator('#reg-qty-inc')).toHaveAttribute('aria-label', 'Increase number of places');
    await expect(reg).not.toContainText(CYCLING);
  });
});

test.describe('@customer:waiver the waiver of a bike-free session', () => {
  test('the review step and the desk-added pop-up name no ride, rider or bike, and the booking carries activity-2026-10-v3', async ({ page }) => {
    const e = ev(d(4));
    await bootCustomer(page, [e], [], false);
    await page.evaluate(`S.selEvent='event';S.selSession=${JSON.stringify(e.id)};S.regStep=3;goCustomer('register')`);
    const wv = page.locator('#reg-waiver');
    await expect(wv).toContainText('You cannot book any activity with MicroMobility until you have read and agreed to this waiver.');
    await expect(wv).not.toContainText(CYCLING);
    expect(await page.evaluate(`_waiverVersionFor(_sessGet(${JSON.stringify(e.id)}))`)).toBe('activity-2026-10-v3');
    await page.evaluate(`S._wg={sid:${JSON.stringify(e.id)}};renderWaiverGate()`);
    const gate = page.locator('#waiver-gate');
    await expect(gate.locator('#wg-sub')).toHaveText('Our team booked you on this session. Read its waiver and agree to it to continue.');
    await expect(gate).not.toContainText(CYCLING);
  });
});

test.describe('@customer:tickets a bike-free ticket', () => {
  test('a checked-in participant reads Checked in, not On Bike, and the landing card does not say on the bike', async ({ page }) => {
    await bootCustomer(page, [ev(today)], [row('q1', today + '-ev', today, { status: 'active', checked_out_at: null, checked_in_at: today + 'T07:05:00Z' })], false);
    await page.evaluate(`goCustomer('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card').first();
    await expect(tk.locator('.ticket-right .status-badge')).toHaveText('Checked in');
    await expect(tk).not.toContainText(/On Bike|on the bike/i);
    const card = await page.evaluate(`_todayCardHtml(S.loggedIn)`);
    expect(card).toContain('Checked in');
    expect(card).not.toMatch(/on the bike/i);
  });
});

test.describe('@staff:bookings a reminder for a bike-free session', () => {
  test('the 24 h reminder names the event and never says ride or rider', async ({ page }) => {
    const e = { ...ev('2099-01-09'), day: 'Friday' };
    const q = [{ id: 'e1', name: 'Sam Jones', phone: '0500000011', customer_id: 'c2', session_id: e.id, session_day: 'Friday', session_date: '2099-01-09',
      queue_num: 1, status: 'waiting', paid: false, price: 40, registered_at: '2099-01-08T10:00:00Z', reminded_at: null, reminded_kind: null }];
    await stubSupabase(page, { sessions: [e], queue_entries: q, bikes: [], customers: [{ id: 'c2', name: 'Sam Jones', phone: '0500000011', nationality: 'GB' }], staff_options: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length>0`);
    await page.evaluate(`window.__opened=[];window.open=(u)=>{window.__opened.push(String(u));return null;};`);
    await page.evaluate(`openRemindSheet(${JSON.stringify(e.id)},'24h')`);
    await page.locator('.rem-row').first().locator('.rem-send').click();
    await expect.poll(() => page.evaluate('window.__opened.length')).toBe(1);
    const text = decodeURIComponent(((await page.evaluate('window.__opened[0]')) as string).split('text=')[1]);
    expect(text).toContain('a reminder: Pottery class is on');
    expect(text).not.toMatch(/\b(ride|rider)\b/i);
  });
});
