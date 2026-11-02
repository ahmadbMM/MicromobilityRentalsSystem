import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// micromobility.sa/experiences hands a rider over with ?ev=<event>&session=<id>: the booking app
// opens that event and that date exactly as tapping the card and the date would, and the
// parameters come off the address. A rider who is not signed in signs in first.

const fixtures = {
  sessions: [
    { id: '2099-01-09', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}' },
    { id: '2099-01-11', day: 'Sunday', session_date: '2099-01-11', capacity: 12, status: 'open', created_at: 2, bike_slots: '{"_time":"21:00 - 23:00"}' },
  ],
  bikes: [{ id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 }],
  queue_entries: [],
};

test('a signed-in rider lands on the event and the date the link names', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/?lang=en&ev=jcc&session=2099-01-11');
  await waitForSb(page);
  await page.waitForFunction(`S.view==='customer' && S.selSession==='2099-01-11'`);
  expect(await page.evaluate('S.selEvent')).toBe('jcc');
  expect(new URL(page.url()).search).toBe('?lang=en');
  expect(await page.evaluate(`sessionStorage.getItem('cq_open_event')`)).toBeNull();
});

test('a date that is not open opens the event alone', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/?ev=jcc&session=2099-02-02');
  await waitForSb(page);
  await page.waitForFunction(`S.view==='customer' && S.selEvent==='jcc'`);
  expect(await page.evaluate('S.selSession')).toBeNull();
});

test('an unknown event is ignored and the address is cleaned', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/?ev=evil&session=x');
  await waitForSb(page);
  expect(await page.evaluate('S.view')).toBe('landing');
  expect(new URL(page.url()).search).toBe('');
});

test('a signed-out visitor keeps the link for after signing in', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await page.goto('/?ev=jcc&session=2099-01-09');
  await waitForSb(page);
  expect(new URL(page.url()).search).toBe('');
  expect(JSON.parse(await page.evaluate(`sessionStorage.getItem('cq_open_event')`) as string)).toEqual({ ev: 'jcc', session: '2099-01-09' });
  expect(await page.evaluate('S.view')).toBe('landing');
  // signing in draws the event picker again, which opens the parked link
  await page.evaluate(`localStorage.setItem('cq_session', JSON.stringify({ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', session_token: 'tok-spec' })); S.loggedIn = getSession(); renderLandingAvail();`);
  await page.waitForFunction(`S.view==='customer' && S.selSession==='2099-01-09'`);
  expect(await page.evaluate(`sessionStorage.getItem('cq_open_event')`)).toBeNull();
});

// micromobility.sa/account's tickets send Reschedule and Cancel here with ?tab=bookings: the rider
// lands on Bookings, where those changes are made. Parked for after signing in, like an event.
test('?tab=bookings opens Bookings for a signed-in rider, and comes off the address', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/?lang=en&tab=bookings');
  await waitForSb(page);
  await page.waitForFunction(`S.view==='customer' && S.custTab==='myrides'`);
  expect(new URL(page.url()).search).toBe('?lang=en');
  expect(await page.evaluate(`sessionStorage.getItem('cq_open_tab')`)).toBeNull();
});

test('the newest link wins: ?tab=bookings drops an event link still waiting in the tab', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await page.goto('/?ev=jcc&session=2099-01-09');
  await waitForSb(page);
  expect(await page.evaluate(`sessionStorage.getItem('cq_open_event')`)).not.toBeNull();
  await page.goto('/?tab=bookings');
  await waitForSb(page);
  expect(await page.evaluate(`sessionStorage.getItem('cq_open_event')`)).toBeNull();
  expect(await page.evaluate(`sessionStorage.getItem('cq_open_tab')`)).toBe('myrides');
  await page.goto('/?ev=jcc&session=2099-01-09');                                        // and the other way round
  await waitForSb(page);
  expect(await page.evaluate(`sessionStorage.getItem('cq_open_tab')`)).toBeNull();
});

test('a parked link waits for the remembered session to be checked, and outlives a dead one', async ({ page }) => {
  await stubSupabase(page, { ...fixtures, 'rpc:customer_token_ok': false });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok-rotated' });
  await page.goto('/?lang=en&tab=bookings');
  await waitForSb(page);
  await page.waitForFunction(`!S.loggedIn && S.view==='landing'`);                      // signed out: the token was rotated away
  expect(await page.evaluate(`sessionStorage.getItem('cq_open_tab')`)).toBe('myrides');
  await page.evaluate(`localStorage.setItem('cq_session', JSON.stringify({ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', session_token: 'tok-new' })); S.loggedIn = getSession(); renderLandingAvail();`);
  await page.waitForFunction(`S.view==='customer' && S.custTab==='myrides'`);
});

test('?tab=bookings waits for a signed-out visitor to sign in', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await page.goto('/?tab=bookings');
  await waitForSb(page);
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate(`sessionStorage.getItem('cq_open_tab')`)).toBe('myrides');
  expect(await page.evaluate('S.view')).toBe('landing');
  await page.evaluate(`localStorage.setItem('cq_session', JSON.stringify({ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', session_token: 'tok-spec' })); S.loggedIn = getSession(); renderLandingAvail();`);
  await page.waitForFunction(`S.view==='customer' && S.custTab==='myrides'`);
  expect(await page.evaluate(`sessionStorage.getItem('cq_open_tab')`)).toBeNull();
});
