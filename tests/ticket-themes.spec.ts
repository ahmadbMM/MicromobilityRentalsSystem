import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Every ticket in its event's colours (the owner, 2026-10-06: "make all booking cards themed the same way the
// event card is themed", the whole card): My Bookings' tickets wear their event-picker card's look and mark in
// every state - the circuit's navy and chevrons, MicroMobility Experiences' white and pattern, Run for Her's
// blush, events' violet - and National Day keeps the green skin it had.

const S = (id: string, x: Record<string, unknown>) => ({ id, session_date: id.slice(0, 10), day: 'Saturday', status: 'open', capacity: 80, spots: 80, created_at: 1, bike_slots: '{"_time":"06:00 - 06:30"}', ...x });
const B = (id: string, sid: string, x: Record<string, unknown> = {}) => ({ id, name: 'Sara Haddad', customer_id: 'c1', session_id: sid, session_day: 'Saturday', session_date: sid.slice(0, 10), queue_num: 7, status: 'waiting', paid: false, price: 75, registered_at: '2099-10-01T10:00:00Z', type_preference: 'Road', ...x });
const sessions = [
  S('2099-10-17-rh', { event_kind: 'community', ride_kind: 'runher', location: 'JYC', needs_approval: false, hide_queue: true }),
  S('2099-10-20-ev', { event_kind: 'community', ride_kind: 'event', open_to_all: true, needs_approval: false, paid_ride: true, price: 50, hide_queue: true }),
  S('2099-10-21', { event_kind: null, ride_kind: null, bike_slots: '{"_time":"21:00 - 23:00"}' }),
  S('2099-10-24', { event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: false }),
  S('2099-10-28', { event_kind: null, ride_kind: null, bike_slots: '{"_time":"21:00 - 23:00"}' }),
  S('2099-10-29-sw', { event_kind: 'community', ride_kind: 'swim', needs_approval: true, hide_queue: true }),
];
const bookings = [
  B('r1', '2099-10-17-rh', { type_preference: 'None', run_km: 5, price: 0, queue_num: 12 }),
  B('e1', '2099-10-20-ev', { price: 50 }),
  B('j1', '2099-10-21'),
  B('s1', '2099-10-24', { approval: 'approved', price: 0 }),
  B('w1', '2099-10-28', { status: 'waitlist', waitlist_num: 2 }),
  B('p1', '2099-10-29-sw', { approval: 'pending', price: 0, type_preference: 'None' }),
];

test.describe('@customer:tickets every ticket in its event’s colours', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 1200 });
    await stubSupabase(page, { sessions, queue_entries: bookings, 'rpc:my_bookings': bookings, 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`goCustomer('myrides')`);
    await expect(page.locator('#tab-myrides .ticket-card')).toHaveCount(6);
  });

  test('each card takes its event card’s theme and mark, whatever its state', async ({ page }) => {
    const look = await page.evaluate(() => [...document.querySelectorAll('#tab-myrides .ticket-card')].map((c) => {
      const cs = getComputedStyle(c), img = c.querySelector('.tk-logo img') as HTMLImageElement | null;
      const th = (/\bth-(\w+)/.exec(c.className) || [])[1] || '';
      const st = (/\btk-(live|wl|past)\b/.exec(c.className) || [])[1] || 'paper';
      return { kind: (/\bev-(\w+)/.exec(c.className) || [])[1], th, st, bg: cs.backgroundColor, img: cs.backgroundImage, border: cs.borderTopStyle, mark: img ? new URL(img.src).pathname : '' };
    }));
    const by = Object.fromEntries(look.map((x) => [x.kind + (x.st === 'wl' ? '-wl' : ''), x]));
    // the circuit: navy with the chevrons, the white JCC mark; its waitlist ticket too, with the dashed edge
    expect(by.jcc).toMatchObject({ th: 'jcc', st: 'live', bg: 'rgb(6, 52, 111)', mark: '/jcc-white.webp' });
    expect(by.jcc.img).toContain('linear-gradient');
    expect(by['jcc-wl']).toMatchObject({ th: 'jcc', bg: 'rgb(6, 52, 111)', border: 'dashed' });
    // MicroMobility Experiences: the Saturday ride and the pool (a reservation staff have not confirmed yet)
    expect(by.saturday).toMatchObject({ th: 'comm', bg: 'rgb(255, 255, 255)', mark: '/logo-dark.webp' });
    expect(by.saturday.img).toContain('mm-pattern');
    expect(by.swim).toMatchObject({ th: 'comm', st: 'paper', bg: 'rgb(255, 255, 255)' });
    expect(by.swim.img).toContain('mm-pattern');
    // Run for Her: blush, the partners' marks; events: the violet wash
    expect(by.runher).toMatchObject({ th: 'runher', bg: 'rgb(255, 255, 255)', mark: '/assets/runher-partners.webp' });
    expect(by.runher.img).toContain('radial-gradient');
    expect(by.event).toMatchObject({ th: 'event', mark: '/logo-dark.webp' });
    expect(by.event.img).toContain('124, 58, 237');
  });

  test('the number wears the event’s accent and the text stays readable on each card', async ({ page }) => {
    const ink = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#tab-myrides .ticket-card.tk-live')].map((c) => {
      const th = (/\bth-(\w+)/.exec(c.className) || [])[1];
      const num = c.querySelector('.ticket-num') as HTMLElement, lbl = c.querySelector('.ticket-num-label, .cu-tk-sec') as HTMLElement;
      return [th, { num: getComputedStyle(num).color, label: lbl ? getComputedStyle(lbl).color : '' }];
    })));
    expect(ink.jcc.num).toBe('rgb(159, 213, 238)');
    expect(ink.runher.num).toBe('rgb(194, 65, 110)');
    expect(ink.event.num).toBe('rgb(109, 40, 217)');
    expect(ink.comm.num).toBe('rgb(7, 122, 75)');
    // labels: white-ish on the navy, ink on the white cards (never the night ticket's pale ink on white)
    expect(ink.jcc.label).toMatch(/^rgba\(255, 255, 255/);
    expect(ink.event.label).toMatch(/^rgba\(26, 25, 25/);
  });

  test('the National Day ticket keeps its own green skin', async ({ page }) => {
    expect(await page.evaluate(`_tkThemeCls({id:'x',session_date:'2099-09-23',ride_kind:'snd96'})`)).toBe('');
    expect(await page.evaluate(`_tkThemeCls({id:'x',session_date:'2099-09-23',event_kind:'community',ride_kind:'petromin'})`)).toBe(' tk-th th-comm');
  });
});
