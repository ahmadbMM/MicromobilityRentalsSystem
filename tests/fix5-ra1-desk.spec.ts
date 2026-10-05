import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The desk's money, places, links and sorting (2026-10-05 review, slice ra1):
// - a row whose price is an incidental 0 falls back to the fare its RIDE charges: an event's seat
//   price, nothing on a free ride - an event seat ('None') used to fall through to 57.5;
// - taking the house terms away (default payment, VIP tag) re-prices by the same rule, loads the
//   Riders list for a Petromin employee's fare, and each write names the state it expects;
// - a waitlisted request on an approval ride holds no place;
// - a name alone links a walk-up to an account only when one account carries that name, and a
//   typed phone that matches nobody is not overruled by a namesake;
// - a date column sorts by date in every language, not by the day number.

const jcc = { id: '2099-03-01', day: 'Sunday', session_date: '2099-03-01', capacity: 12, status: 'open', created_at: 1, location: 'JCC' };
const ev = { id: 'ev1', day: 'Monday', session_date: '2099-03-02', capacity: 30, status: 'open', created_at: 1, location: 'JCC', event_kind: 'community', ride_kind: 'event', needs_approval: false, open_to_all: true, paid_ride: true, price: 30, title: 'Talk night' };
const pm = { id: 'pm1', day: 'Wednesday', session_date: '2099-03-04', capacity: 40, status: 'open', created_at: 1, location: 'JCC', event_kind: 'community', ride_kind: 'petromin', needs_approval: false, paid_ride: true, title: 'Petromin ride' };
const sat = { id: 'sat1', day: 'Saturday', session_date: '2099-03-07', capacity: 20, status: 'open', created_at: 1, location: 'JCC', event_kind: 'community', needs_approval: true, hide_queue: true, spots: 2, title: 'Saturday Social Ride' };
const row = (id: string, session: { id: string; day: string; session_date: string }, extra: Record<string, unknown> = {}) => ({
  id, session_id: session.id, session_day: session.day, session_date: session.session_date, queue_num: 1,
  name: 'Ana Rider', customer_id: 'c1', status: 'waiting', paid: true, price: 0, walk_in: false,
  type_preference: 'Road', registered_at: '2099-01-01T10:00:00Z', ...extra,
});
const customers = [
  { id: 'c1', name: 'Ana Rider', phone: '0500000001', default_pay: 'house', created_at: '2026-01-01' },
  { id: 'c2', name: 'Sara Ali', phone: '0500000002', created_at: '2026-01-01' },
  { id: 'c3', name: 'Sara Ali', phone: '0500000003', created_at: '2026-01-02' },
  { id: 'c4', name: 'Omar Unique', phone: '0500000004', created_at: '2026-01-01' },
];

async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions: [jcc, ev, pm, sat], bikes: [], customers,
    queue_entries: [
      row('e1', ev, { type_preference: 'None' }),
      row('j1', jcc),
      row('p1', pm, { type_preference: 'Hybrid' }),
      row('s1', sat, { type_preference: 'Any', paid: false, approval: 'approved' }),
    ],
    rider_registrations: [{ id: 1, matched_entry_id: 'p1', source: 'petromin', name: 'Ana Rider', updated_at: '2099-01-01T00:00:00Z' }],
    ...fx,
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
function patches(page: Page) {
  const out: { id: string; q: URLSearchParams; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'PATCH' || !r.url().includes('/rest/v1/queue_entries')) return;
    const u = new URL(r.url());
    out.push({ id: String(u.searchParams.get('id') || '').replace(/^eq\./, ''), q: u.searchParams, body: r.postDataJSON() });
  });
  return out;
}

test.describe('@staff:bookings fix5 ra1 fares', () => {
  test('an incidental 0 falls back to the ride’s fare: an event’s seat, nothing on a free ride', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`['e1','s1','j1'].map(id => _entryFallbackPrice(getQueue().find(e => e.id === id)))`)).toEqual([30, 0, 75]);
    // a seat whose event is not on the page is never charged a bike's fare
    expect(await page.evaluate(`_entryFallbackPrice({ id: 'zz', sessionId: 'gone', typePreference: 'None' })`)).toBe(0);
    // through the pay menu: on the house back to pending gives the seat its own price
    const sent = patches(page);
    await page.evaluate(`togglePayment('e1','pending')`);
    await expect.poll(() => sent.find((p) => p.id === 'e1' && 'price' in p.body)?.body).toEqual({ paid: false, price: 30 });
  });

  test('taking the house terms away re-prices each row at its ride’s fare, each write guarded', async ({ page }) => {
    await boot(page);
    const sent = patches(page);
    await page.evaluate(`S.ridersLoaded = false; S.riders = [];`);
    await page.evaluate(`_houseReprice('c1', ['Ana Rider'], () => true, () => false)`);
    const by = (id: string) => sent.find((p) => p.id === id);
    await expect.poll(() => sent.length).toBe(3);
    expect(by('e1')?.body).toEqual({ paid: false, price: 30 });  // the event's seat, not 57.5
    expect(by('j1')?.body).toEqual({ paid: false, price: 75 });  // a Road bike on the circuit
    expect(by('p1')?.body).toEqual({ paid: false, price: 50 });  // a Petromin employee: the Riders list was loaded first
    for (const p of sent) {
      expect(p.q.get('paid')).toBe('eq.true'); // only a row still on the house is changed
      expect(p.q.get('price')).toBe('eq.0');
    }
  });

  test('giving the house terms guards its writes too', async ({ page }) => {
    await boot(page, { queue_entries: [row('j2', jcc, { paid: false, price: 75 })] });
    const sent = patches(page);
    await page.evaluate(`_houseReprice('c1', ['Ana Rider'], () => false, () => true)`);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toEqual({ paid: true, price: 0 });
    expect(sent[0].q.get('paid')).toBe('eq.false');
  });
});

test.describe('@staff:bookings fix5 ra1 places and links', () => {
  test('on an approval ride a waitlisted request holds no place', async ({ page }) => {
    await boot(page, {
      queue_entries: [
        row('w1', sat, { status: 'waiting', approval: 'pending', paid: false, customer_id: 'c2' }),
        row('w2', sat, { status: 'waitlist', approval: 'pending', paid: false, customer_id: 'c3' }),
        row('w3', sat, { status: 'waitlist', approval: 'pending', paid: false, customer_id: 'c4' }),
      ],
    });
    expect(await page.evaluate(`spotsLeft('sat1')`)).toBe(1); // two places, one pending request
  });

  test('a name alone links only the one account carrying it; a typed phone that matches nobody is not overruled', async ({ page }) => {
    await boot(page);
    await page.waitForFunction('getCustomers().length > 0');
    const ids = await page.evaluate(`[
      _linkCustomer('Sara Ali', '', null),        // two accounts carry it
      _linkCustomer('omar unique', '', null),     // one does
      _linkCustomer('Omar Unique', '0500009999', null), // the phone typed is somebody else's number
      _linkCustomer('Omar', '0500000004', null),  // the phone decides
      _linkCustomer('Sara Ali', '0500000003', null),
    ].map(c => c ? c.id : null)`);
    expect(ids).toEqual([null, 'c4', null, 'c4', 'c3']);
  });
});

test.describe('@staff:bookings fix5 ra1 sorting', () => {
  test('a date column sorts by date in every language', async ({ page }) => {
    await boot(page);
    for (const lang of ['ar', 'tl', 'pt', 'en']) {
      const got = await page.evaluate(`(async () => {
        setLang('${lang}');
        const host = document.getElementById('tab-history');
        const days = ['2026-10-02', '2026-01-15', '2026-09-30', '2025-12-31'];
        host.innerHTML = '<table id="fx-t"><thead><tr><th>Day ${lang}</th><th>N</th></tr></thead><tbody>'
          + days.map((d, i) => '<tr><td>' + esc(dayLabel('Monday')) + ' ' + esc(shortDate(d)) + '</td><td>' + i + '</td></tr>').join('') + '</tbody></table>';
        _mountTableSorts();
        _tsClick(document.querySelector('#fx-t th'));
        return {
          got: [...document.querySelectorAll('#fx-t tbody tr td:first-child')].map(td => td.textContent),
          want: ['2025-12-31', '2026-01-15', '2026-09-30', '2026-10-02'].map(d => dayLabel('Monday') + ' ' + shortDate(d)),
        };
      })()`) as { got: string[]; want: string[] };
      expect(got.got, lang).toEqual(got.want);
    }
  });
});
