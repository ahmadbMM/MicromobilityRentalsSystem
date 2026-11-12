import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// A guest of Petromin's books at micromobility.sa/petromin with a MicroMobility account (the user, 2026-11-13:
// "ask them to create an account and go through the whole process"; petromin_guest_book, migration 20261113150000).
// The booking is the account's own, so it is among the account's bookings here like any other, on a night the
// account could not have booked from the app (it holds neither the Community tag nor the Petromin tag). The app
// offers that night to nobody without a tag: a guest books through the page each time. Supabase is stubbed.

const INV = 'https://abcd.supabase.co/storage/v1/object/public/photos/p/pminv-n1.webp';
const PW = '2099-10-14-pw';
const pw = {
  id: PW, session_date: '2099-10-14', day: 'Wednesday', status: 'open', capacity: 35, created_at: 1,
  event_kind: 'community', ride_kind: 'petromin', needs_approval: false, open_to_all: false, paid_ride: true,
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 35, _inv: INV }), location: 'JCC',
};
const jcc = { id: '2099-10-18', session_date: '2099-10-18', day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC' };
const mine = {
  id: 'g1aaaaaaaaaaaaaaaaaaaaaa', session_id: PW, session_day: 'Wednesday', session_date: '2099-10-14', queue_num: 7, waitlist_num: null,
  name: 'Omar Saleh', size: '', height: 175, type_preference: 'Hybrid', status: 'waiting', paid: false, price: 75, customer_id: 'c1',
  registered_at: '2099-10-01T10:00:00Z', walk_in: false, via: 'invite', invite_no: 'I-001', invite_company: 'Aramco Trading',
};

test.describe('@customer:petromin A guest booking made on the page', () => {
  test('is among the account\'s bookings, on a night the app does not offer the account', async ({ page }) => {
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));
    await stubSupabase(page, { sessions: [pw, jcc], bikes: [], queue_entries: [mine], 'rpc:community_member': false, 'rpc:petromin_member': false });
    await loginCustomer(page, { id: 'c1', name: 'Omar Saleh', birth_date: '1990-01-01' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`showView('customer');setCustTab('myrides')`);
    const card = page.locator('#tab-myrides .ticket-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Hybrid');
    // its own booking, not a place the desk added: the night's invitation is on the ticket for the gate
    await expect(page.locator('#tab-myrides .pminv-tk')).toHaveCount(1);
    // and the app still offers the account no Petromin night to book by itself
    await page.evaluate('goLanding()');
    await expect(page.locator('#land-events .landing-event-card.ev-jcc')).toBeVisible();
    await expect(page.locator('#land-events .landing-event-card.ev-petromin')).toHaveCount(0);
    expect(errs).toEqual([]);
  });
});
