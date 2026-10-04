import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// "To staff list" (mwFromBooking) used to accept ONLY waitlisted bookings and return in
// silence for anything else — so on a normal queued booking the action simply did nothing
// and read as broken. It now takes any booking that has not ridden yet, and says why when
// it refuses. The insert itself is RLS-gated on is_staff(), so a device whose Auth session
// has lapsed gets a denial — which the error bar now reports rather than swallowing.

const D = '2099-02-08';
const sessions = [{
  id: 's0', day: 'Sunday', session_date: D, capacity: 9, status: 'open',
  created_at: 1, bike_slots: null, location: 'JCC', addons: null,
}];
const qe = (id: string, num: number, extra: Record<string, unknown>) => ({
  id, session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: num,
  name: `Rider ${num}`, phone: `05000000${num}`, customer_id: null,
  type_preference: 'Hybrid', registered_at: '2099-01-01T10:00:00Z', ...extra,
});
const queue_entries = [
  qe('e-wait', 1, { status: 'waiting', paid: false, price: 60 }),
  qe('e-wl', 2, { status: 'waitlist', paid: false, price: 60, waitlist_num: 1 }),
  qe('e-done', 3, { status: 'done', paid: true, price: 60 }),
];

async function boot(page: import('@playwright/test').Page, failWrite?: Parameters<typeof stubSupabase>[2]) {
  await stubSupabase(page, { sessions, queue_entries, desk_waitlist: [] }, failWrite);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

/** Rows the client tried to add to the staff list. */
function watchInserts(page: import('@playwright/test').Page) {
  const rows: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rest/v1/desk_waitlist')) {
      const b = r.postDataJSON();
      (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => rows.push(x));
    }
  });
  return rows;
}

test.describe('adding a booking to the staff list', () => {
  test('a plain queued booking can be added — it used to do nothing at all', async ({ page }) => {
    await boot(page);
    const rows = watchInserts(page);
    await page.evaluate(`mwFromBooking('e-wait')`);
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].booking_id).toBe('e-wait');
    expect(rows[0].kind).toBe('managed');
  });

  test('a waitlisted booking still works, as before', async ({ page }) => {
    await boot(page);
    const rows = watchInserts(page);
    await page.evaluate(`mwFromBooking('e-wl')`);
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].booking_id).toBe('e-wl');
  });

  test('a booking that already rode is refused out loud, not silently', async ({ page }) => {
    await boot(page);
    const rows = watchInserts(page);
    await page.evaluate(`mwFromBooking('e-done')`);
    await expect(page.locator('.toast')).toContainText(/staff list/i);
    expect(rows).toHaveLength(0);
  });

  test('adding the same booking twice is refused', async ({ page }) => {
    await boot(page);
    const rows = watchInserts(page);
    await page.evaluate(`(async () => { await mwFromBooking('e-wait'); await mwFromBooking('e-wait'); })()`);
    await expect.poll(() => rows.length).toBe(1); // the second attempt never reaches the server
  });

  test('an RLS denial is reported instead of looking like nothing happened', async ({ page }) => {
    // What a staff device with a lapsed Auth session hits: the policy is is_staff().
    await boot(page, { table: 'desk_waitlist' });
    await page.evaluate(`mwFromBooking('e-wait')`);
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await expect(page.locator('#err-bar-el')).toContainText(/session may have expired/i);
  });

  test('the button is offered on queued rows, not only waitlisted ones', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue')`);
    await page.waitForTimeout(300);
    // "To staff list" folded into the row's ⋯ menu; the offer now lives in the menu registry
    const runs = await page.evaluate(
      `JSON.stringify(Object.fromEntries(Object.entries(S._rowMenus||{}).map(([k,v])=>[k,v.map(i=>i.run).join('|')])))`) as string;
    expect(JSON.parse(runs)['e-wait']).toContain(`mwFromBooking('e-wait')`);
    expect(JSON.parse(runs)['e-wl']).toContain(`mwFromBooking('e-wl')`);
  });
});

// The section could only take a hand-typed name: everything staff wanted to park there —
// a queued booking, a waitlisted one, a regular who walked in — had to be retyped. The
// name field is now a search over all three, and the browse button lists every addable
// booking without typing anything.

const customers = [
  { id: 'c1', name: 'Salma Nour', phone: '0551112222', type_preference: 'Road', created_at: 1 },
  { id: 'c2', name: 'Rider 1', phone: '050000001', type_preference: 'Hybrid', created_at: 2 },
];

async function openStaffList(page: import('@playwright/test').Page) {
  await page.evaluate(`(()=>{ setStaffTab('queue'); S.queueView='managed'; renderStaffQueue(); })()`);
  await page.locator('#mw-name').waitFor();
}

test.describe('finding riders to put on the staff list', () => {
  async function bootWithCustomers(page: import('@playwright/test').Page) {
    await stubSupabase(page, { sessions, queue_entries, desk_waitlist: [], customers });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await openStaffList(page);
  }

  test('browse lists every addable booking, waitlisted ones first', async ({ page }) => {
    await bootWithCustomers(page);
    await page.locator('#mw-browse').click();
    const rows = page.locator('#mw-suggest .mw-sug');
    await expect(rows).toHaveCount(2);          // the booking that already rode is not offered
    await expect(rows.first()).toContainText('Rider 2'); // waitlisted before queued
    await expect(rows.nth(1)).toContainText('Rider 1');
  });

  test('picking from the picker parks the booking, and browsing stays open', async ({ page }) => {
    await bootWithCustomers(page);
    const rows = watchInserts(page);
    await page.locator('#mw-browse').click();
    await page.locator('#mw-suggest .mw-sug').first().click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].booking_id).toBe('e-wl');
    // still open for the next pick, minus the one just added
    await expect(page.locator('#mw-suggest .mw-sug')).toHaveCount(1);
  });

  test('typing a name searches bookings; a customer with no booking is offered too', async ({ page }) => {
    await bootWithCustomers(page);
    await page.locator('#mw-name').fill('Salma');
    const rows = page.locator('#mw-suggest .mw-sug');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Salma Nour');
    // a customer who is already on the queue is offered as the booking, not twice
    await page.locator('#mw-name').fill('Rider 1');
    await expect(page.locator('#mw-suggest .mw-sug')).toHaveCount(1);
    await expect(page.locator('#mw-suggest .mw-sug')).toContainText('#1');
  });

  test('adding a customer writes a walk-up style row, not a linked booking', async ({ page }) => {
    await bootWithCustomers(page);
    const rows = watchInserts(page);
    await page.locator('#mw-name').fill('Salma');
    await page.locator('#mw-suggest .mw-sug').first().click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].name).toBe('Salma Nour');
    expect(rows[0].kind).toBe('managed');
    expect(rows[0].booking_id).toBeUndefined();
    expect(rows[0].bike_type).toBe('Road');
    await expect(page.locator('#mw-name')).toHaveValue(''); // search resets for the next rider
  });

  test('nothing to add says so instead of showing an empty box', async ({ page }) => {
    await bootWithCustomers(page);
    await page.locator('#mw-name').fill('zzzz');
    await expect(page.locator('#mw-suggest .mw-sug-empty')).toBeVisible();
  });

  test('a booking already on the list is not offered again', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, customers,
      desk_waitlist: [{ id: 'w1', name: 'Rider 2', phone: '05000002', bike_type: 'Hybrid',
        status: 'waiting', kind: 'managed', sort_order: 1, booking_id: 'e-wl', created_at: '2099-01-01T10:00:00Z' }],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await openStaffList(page);
    await page.locator('#mw-browse').click();
    const rows = page.locator('#mw-suggest .mw-sug');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Rider 1');
  });
});

// A parked booking is still a booking. It used to offer a single Promote button, so anything
// real — check in, take payment, mark a no-show, edit — meant leaving the list for the queue.
// The rows now carry the roster's own controls, from the same builder the queue uses.

test.describe('a parked booking carries the roster controls', () => {
  const bookings = [
    qe('e-wait', 1, { status: 'waiting', paid: false, price: 60 }),
    qe('e-wl', 2, { status: 'waitlist', paid: false, price: 60, waitlist_num: 1 }),
    qe('e-done', 3, { status: 'done', paid: true, price: 60 }),
  ];
  const park = (id: string, name: string, booking: string) => ({
    id, name, phone: '0500000000', bike_type: 'Road', status: 'waiting', kind: 'managed',
    sort_order: 1, booking_id: booking, created_at: '2099-01-01T11:00:00Z',
  });

  async function openList(page: import('@playwright/test').Page, desk: Record<string, unknown>[]) {
    await stubSupabase(page, { sessions, queue_entries: bookings, desk_waitlist: desk });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
    return page.evaluate(`document.getElementById('mw-host').innerHTML`) as Promise<string>;
  }

  test('a waitlisted one gets check-in, payment and the rest — and no Promote', async ({ page }) => {
    const html = await openList(page, [park('m1', 'Rider 2', 'e-wl')]);
    expect(html).toContain(`[&quot;showCheckinModal&quot;,&quot;e-wl&quot;]`);   // checks in THAT booking — stays large (ids reach the handler specs JSON-encoded)
    expect(html).toMatch(/pay-toggle[^>]*&quot;e-wl&quot;/);                      // payment, as on the queue page
    // the price is edited from the payment pill's menu (queue-pass2.spec.ts), not a button of its own
    // no-show, edit and cancel folded into the ⋯ menu
    const menu = await page.evaluate(`((S._rowMenus||{})['e-wl']||[]).map(i=>i.run).join('|')`) as string;
    expect(menu).toContain(`confirmNoShow('e-wl')`);
    expect(menu).toContain(`showBookingEditModal('e-wl')`);
    expect(menu).toContain(`staffCancelEntry('e-wl')`);
    expect(html).not.toContain('promoteWaitlist');        // Promote is gone from the app
    expect(html).not.toContain('mwFromBooking');          // it is already on the list
    expect(menu).not.toContain('mwFromBooking');          // not in the menu either
  });

  test('a queued one gets the same set', async ({ page }) => {
    const html = await openList(page, [park('m2', 'Rider 1', 'e-wait')]);
    expect(html).toContain(`[&quot;showCheckinModal&quot;,&quot;e-wait&quot;]`);
    expect(html).toMatch(/pay-toggle[^>]*&quot;e-wait&quot;/);
  });

  test('a spent booking keeps only the list-side Remove', async ({ page }) => {
    const html = await openList(page, [park('m3', 'Rider 3', 'e-done')]);
    expect(html).not.toContain(`showCheckinModal(&quot;e-done&quot;)`);
    expect(html).not.toContain(`doReopen(&quot;e-done&quot;)`);     // no second, different Remove either
    expect(html).toContain('resolveDeskWaitlist');        // off the list, not out of the booking
  });
});

// Riders arrive as parties. Adding four of them one at a time — and then dragging their four
// positions back together — was the work this section exists to save, so a party is offered,
// parked, ordered and removed as ONE entry, while each rider keeps their own controls.

test.describe('parties, not single riders', () => {
  const party = (id: string, n: number, name: string) => qe(id, n, {
    status: 'waiting', paid: false, price: 60, group_id: 'grp1', group_name: 'Tamer Group', name,
  });
  const withParty = {
    sessions,
    queue_entries: [party('g1', 11, 'Tamer A'), party('g2', 12, 'Tamer B'), party('g3', 13, 'Tamer C'),
      qe('s1', 14, { status: 'waiting', paid: false, price: 60 })],
    desk_waitlist: [],
  };

  async function open(page: import('@playwright/test').Page) {
    await stubSupabase(page, withParty);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
  }

  test('the picker offers the party as one line, with its size', async ({ page }) => {
    await open(page);
    await page.locator('#mw-browse').click();
    const rows = page.locator('#mw-suggest .mw-sug');
    await expect(rows).toHaveCount(2);                       // the party + the solo rider
    await expect(rows.first()).toContainText('Tamer Group');
    await expect(rows.first()).toContainText('3 riders');
  });

  test('picking it parks all three in one write, consecutively', async ({ page }) => {
    await open(page);
    const rows = watchInserts(page);
    await page.locator('#mw-browse').click();
    await page.locator('#mw-suggest .mw-sug').first().click();
    await expect.poll(() => rows.length).toBe(3);
    expect(rows.map((r) => r.booking_id).sort()).toEqual(['g1', 'g2', 'g3']);
    const orders = rows.map((r) => Number(r.sort_order)).sort((a, b) => a - b);
    expect(orders[1]).toBe(orders[0] + 1);                   // no gaps: the party stays together
    expect(orders[2]).toBe(orders[1] + 1);
  });

  test('parking ONE rider from the roster takes their whole party', async ({ page }) => {
    await open(page);
    const rows = watchInserts(page);
    await page.evaluate(`mwFromBooking('g2')`);
    await expect.poll(() => rows.length).toBe(3);
  });

  test('the list shows one card for the party, each rider with their own controls', async ({ page }) => {
    await open(page);
    await page.evaluate(`mwFromBooking('g1')`);
    await expect.poll(async () => page.locator('#mw-host .q-card').count()).toBe(1);
    const card = page.locator('#mw-host .q-card').first();
    await expect(card).toContainText('Tamer Group');
    await expect(card).toContainText('3 riders');
    await expect(card.locator('input[type="number"]')).toHaveCount(1); // ONE position, for the party
    const html = await card.innerHTML();
    for (const id of ['g1', 'g2', 'g3']) expect(html).toContain(`[&quot;showCheckinModal&quot;,&quot;${id}&quot;]`);
  });

  test('a position typed against the party moves every rider in it', async ({ page }) => {
    await open(page);
    await page.evaluate(`(async()=>{ await mwFromBooking('s1'); await mwFromBooking('g1'); })()`);
    await expect.poll(async () => page.locator('#mw-host .q-card').count()).toBe(2);
    // party is second; send it to position 1
    const partyRow = await page.evaluate(`_mwGroups()[1][0].id`);
    await page.evaluate(`mwSetPos('${partyRow}',1)`);
    await expect.poll(async () => (await page.locator('#mw-host .q-card').first().textContent()) || '')
      .toContain('Tamer Group');
    // and they are still one contiguous block, in order
    const orders = await page.evaluate(`_mwGroups().map(g=>g.map(w=>w.sort_order))`) as number[][];
    expect(orders[0].length).toBe(3);
    expect(orders[0][1]).toBe(orders[0][0] + 1);
    expect(orders[0][2]).toBe(orders[0][1] + 1);
  });
});

// "The four of them are here" is one action to a person at the booth, not four.
test.describe('party-level actions', () => {
  const party = (id: string, n: number, name: string, extra: Record<string, unknown> = {}) =>
    qe(id, n, { status: 'waiting', paid: false, price: 60, group_id: 'grp1', group_name: 'Tamer Group', name, ...extra });

  async function openWithParty(page: import('@playwright/test').Page) {
    await stubSupabase(page, {
      sessions,
      queue_entries: [party('g1', 11, 'Tamer A'), party('g2', 12, 'Tamer B'), party('g3', 13, 'Tamer C')],
      desk_waitlist: [],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
    await page.evaluate(`mwFromBooking('g1')`);
    await expect.poll(async () => page.locator('#mw-host .q-card').count()).toBe(1);
  }

  /** Every PATCH the client sends to queue_entries, with its body. */
  function watchPatches(page: import('@playwright/test').Page) {
    const out: { url: string; body: string }[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/rest/v1/rpc/staff_checkin')) { const b = JSON.parse(r.postData() || '{}'); out.push({ url: `id=eq.${b.p_booking_id}`, body: '{"status":"active"}' }); return; } // one staff_checkin call (2026-10-04)
      if (r.method() !== 'PATCH' || !r.url().includes('/rest/v1/queue_entries')) return;
      out.push({ url: r.url(), body: r.postData() || '' });
    });
    return out;
  }

  test('checks the whole party in at once', async ({ page }) => {
    await openWithParty(page);
    const patches = watchPatches(page);
    await page.locator('#mw-host').getByRole('button', { name: /Check In \(3\)/i }).click();
    await expect.poll(() => patches.filter((p) => p.body.includes('"status":"active"')).length).toBe(3);
  });

  test('settles the whole party at once', async ({ page }) => {
    await openWithParty(page);
    const patches = watchPatches(page);
    await page.locator('#mw-host').getByRole('button', { name: /Paid \(3\)/i }).click();
    await expect.poll(() => patches.filter((p) => p.body.includes('"paid":true')).length).toBe(3);
  });

  test('a party already settled is not asked to pay again', async ({ page }) => {
    await stubSupabase(page, {
      sessions,
      queue_entries: [party('g1', 11, 'Tamer A', { paid: true }), party('g2', 12, 'Tamer B', { paid: true })],
      desk_waitlist: [],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue();mwFromBooking('g1')`);
    await expect.poll(async () => page.locator('#mw-host .q-card').count()).toBe(1);
    await expect(page.locator('#mw-host').getByRole('button', { name: /Paid \(/i })).toHaveCount(0);
    await expect(page.locator('#mw-host').getByRole('button', { name: /Check In \(2\)/i })).toHaveCount(1);
  });
});

// A rider at the desk says a number — "I'm forty-two" — so the number is the fastest thing
// to type, and typing it should be the whole interaction: digits, Enter, parked.
test.describe('finding a booking by its number', () => {
  const many = [
    qe('e4', 4, { status: 'waiting', paid: false, price: 60, name: 'Four Rider' }),
    qe('e41', 41, { status: 'waiting', paid: false, price: 60, name: 'Forty One' }),
    qe('e42', 42, { status: 'waiting', paid: false, price: 60, name: 'Forty Two' }),
    qe('w7', 7, { status: 'waitlist', paid: false, price: 60, waitlist_num: 3, name: 'Waitlisted One' }),
  ];

  async function open(page: import('@playwright/test').Page) {
    await stubSupabase(page, { sessions, queue_entries: many, desk_waitlist: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
  }

  test('digits match from the first one, with the exact number on top', async ({ page }) => {
    await open(page);
    await page.locator('#mw-name').fill('4');
    const rows = page.locator('#mw-suggest .mw-sug');
    await expect(rows).toHaveCount(3);                       // #4, #41, #42 — not just an exact hit
    await expect(rows.first()).toContainText('Four Rider');  // ...and the full match leads
    await page.locator('#mw-name').fill('42');
    await expect(page.locator('#mw-suggest .mw-sug')).toHaveCount(1);
    await expect(page.locator('#mw-suggest .mw-sug').first()).toContainText('Forty Two');
  });

  test('a # prefix works, and W finds the waitlist position', async ({ page }) => {
    await open(page);
    await page.locator('#mw-name').fill('#41');
    await expect(page.locator('#mw-suggest .mw-sug').first()).toContainText('Forty One');
    await page.locator('#mw-name').fill('W3');
    await expect(page.locator('#mw-suggest .mw-sug').first()).toContainText('Waitlisted One');
  });

  test('Enter parks the top match instead of inventing a rider called "42"', async ({ page }) => {
    await open(page);
    const rows = watchInserts(page);
    await page.locator('#mw-name').fill('42');
    await page.locator('#mw-name').press('Enter');
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].booking_id).toBe('e42');       // the booking, not a walk-up row
    expect(rows[0].name).toBe('Forty Two');
  });

  test('Enter on a name nobody has still adds it by hand', async ({ page }) => {
    await open(page);
    const rows = watchInserts(page);
    await page.locator('#mw-name').fill('Walk Up Guest');
    await expect(page.locator('#mw-suggest .mw-sug')).toHaveCount(0);
    await page.locator('#mw-name').press('Enter');
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].name).toBe('Walk Up Guest');
    expect(rows[0].booking_id ?? null).toBeNull();
  });
});

// A booth works one ride at a time. The session picker aims the whole screen at that ride:
// which parked riders are listed, and which bookings the search and browse list can offer.
test.describe('the session picker', () => {
  const other = {
    id: '2099-02-09', day: 'Monday', session_date: '2099-02-09', capacity: 9, status: 'open',
    created_at: 2, bike_slots: null, location: 'JCC', addons: null,
  };
  const otherBooking = {
    id: 'o1', session_id: other.id, session_day: 'Monday', session_date: other.session_date,
    queue_num: 7, name: 'Other Session Rider', phone: '0509999999', customer_id: null,
    type_preference: 'Road', status: 'waiting', paid: false, price: 60,
    registered_at: '2099-01-01T10:00:00Z',
  };

  // A night that closed with bookings nobody rode: those are parkable too (2026-09-23).
  const shut = {
    id: '2099-02-07', day: 'Saturday', session_date: '2099-02-07', capacity: 9, status: 'closed',
    created_at: 3, bike_slots: null, location: 'JCC', addons: null,
  };
  const shutBooking = {
    id: 'sh1', session_id: shut.id, session_day: 'Saturday', session_date: shut.session_date,
    queue_num: 3, name: 'Closed Night Rider', phone: '0508888888', customer_id: null,
    type_preference: 'Road', status: 'waiting', paid: false, price: 60,
    registered_at: '2099-01-01T10:00:00Z',
  };

  async function open(page: import('@playwright/test').Page) {
    await stubSupabase(page, {
      sessions: [...sessions, other, shut],
      queue_entries: [...queue_entries, otherBooking, shutBooking],
      desk_waitlist: [],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
  }

  test('offers every session taking bookings, plus All Sessions', async ({ page }) => {
    await open(page);
    const opts = await page.evaluate(`Array.from(document.getElementById('mw-sess').options).map(o=>o.value)`) as string[];
    expect(opts[0]).toBe('all');
    expect(opts).toContain('s0');
    expect(opts).toContain('2099-02-09');
    expect(opts).toContain('2099-02-07');            // closed, but it still holds an unridden booking
  });

  test('a booking left on a closed night can still be parked from that night', async ({ page }) => {
    await open(page);
    await page.evaluate(`mwSetSess('2099-02-07')`);
    await page.evaluate(`S._mwQ='Closed';_mwRenderSuggest()`);
    await expect(page.locator('#mw-suggest')).toContainText('Closed Night Rider');
    await page.evaluate(`mwFromBooking('sh1')`);
    await expect.poll(async () => page.locator('#mw-host .q-card').count()).toBe(1);
    await expect(page.locator('#mw-host')).toContainText('Closed Night Rider');
  });

  test('narrows the list to that session, and says so when it empties', async ({ page }) => {
    await open(page);
    await page.evaluate(`(async()=>{await mwFromBooking('e-wait');await mwFromBooking('o1');})()`);
    // two cards: the two just parked. 'e-wl' - a booking the capacity rule waitlisted - is not
    // copied here; the staff list holds only what staff put on it (since 2026-09-16).
    await expect.poll(async () => page.locator('#mw-host .q-card').count()).toBe(2);

    await page.evaluate(`mwSetSess('2099-02-09')`);
    await expect.poll(async () => page.locator('#mw-host .q-card').count()).toBe(1);
    await expect(page.locator('#mw-host .q-card')).toContainText('Other Session Rider');

    await page.evaluate(`mwSetSess('s0')`);
    await expect(page.locator('#mw-host .q-card')).toHaveCount(1);
    await expect(page.locator('#mw-host .q-card')).toContainText('Rider 1');
  });

  test('scopes what can be ADDED, so the wrong ride cannot be parked by mistake', async ({ page }) => {
    await open(page);
    await page.evaluate(`mwSetSess('2099-02-09')`);
    await page.locator('#mw-browse').click();
    const rows = page.locator('#mw-suggest .mw-sug');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Other Session Rider');

    // Changing the session rebuilds the OPEN picker in place — no second click, and no
    // stale list of the previous ride's riders left on screen.
    await page.evaluate(`mwSetSess('all')`);
    await expect(page.locator('#mw-suggest .mw-sug')).toHaveCount(4); // every night's unridden bookings, the closed one's too
  });

  test('a walk-up row belongs to no session, so it never hides behind the filter', async ({ page }) => {
    // Someone standing at the desk with no booking is not "on" any ride. Filtering them out
    // of every session view would lose them while their rider is still waiting.
    await open(page);
    await page.evaluate(`S._mwQ='';document.getElementById('mw-name').value='Walk Up';addManagedWl()`);
    await expect.poll(async () => page.locator('#mw-host .q-card').count()).toBe(1); // the walk-up alone: waitlisted bookings are not copied here
    await page.evaluate(`mwSetSess('2099-02-09')`);
    await expect(page.locator('#mw-host .q-card')).toContainText('Walk Up');
  });
});

// A list of people waiting said nothing about what they were waiting FOR: the quick-add could
// only record 'Any' and nothing could change it afterwards. The type now sits on the row, and
// what it writes depends on whether the row carries a booking.
test.describe('choosing the bike type', () => {
  async function openWith(page: import('@playwright/test').Page, desk: Record<string, unknown>[], q = queue_entries) {
    await stubSupabase(page, {
      sessions, queue_entries: q, desk_waitlist: desk,
      bikes: [
        { id: 'b1', name: 'R1', size: 'M', type: 'Road', status: 'available', rental_price: 75 },
        { id: 'b2', name: 'R2', size: 'M', type: 'Road', status: 'available', rental_price: 75 },
        { id: 'b3', name: 'H1', size: 'M', type: 'Hybrid', status: 'in-use', rental_price: 60 },
      ],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`(S.deskWaitlist||[]).length>0||true`);
    await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
  }
  const walkup = {
    id: 'm1', name: 'Walk Up', phone: '0500000000', bike_type: 'Any', status: 'waiting',
    kind: 'managed', sort_order: 1, booking_id: null, created_at: '2099-01-01T11:00:00Z',
  };
  const linked = { ...walkup, id: 'm2', name: 'Rider 1', booking_id: 'e-wait' };

  test('a walk-up row records the choice on the list itself', async ({ page }) => {
    await openWith(page, [walkup]);
    const writes: { table: string; body: string }[] = [];
    page.on('request', (r) => {
      const m = r.url().match(/\/rest\/v1\/([^/?]+)/);
      if (m && r.method() === 'PATCH') writes.push({ table: m[1], body: r.postData() || '' });
    });
    await page.locator('#mw-host .mw-type').first().selectOption('Road');
    await expect.poll(() => writes.some((w) => w.table === 'desk_waitlist' && /"bike_type":"Road"/.test(w.body))).toBe(true);
    expect(writes.some((w) => w.table === 'queue_entries')).toBe(false); // there is no booking to touch
  });

  test('a parked BOOKING gets it written where the rest of the app reads it', async ({ page }) => {
    // 57.5 is the canonical Hybrid fare, so this booking is still "as priced by the app" — a
    // row at some other figure would read as hand-edited and must NOT reprice, which is the
    // only case the type change is allowed to reprice.
    await openWith(page, [linked], [qe('e-wait', 1, { status: 'waiting', paid: false, price: 57.5 })]);
    const writes: { table: string; body: string }[] = [];
    page.on('request', (r) => {
      const m = r.url().match(/\/rest\/v1\/([^/?]+)/);
      if (m && r.method() === 'PATCH') writes.push({ table: m[1], body: r.postData() || '' });
    });
    await page.locator('#mw-host .mw-type').first().selectOption('Road');
    // the booking is the source of truth for the roster, the ticket and check-in
    await expect.poll(() => writes.some((w) => w.table === 'queue_entries' && /"type_preference":"Road"/.test(w.body))).toBe(true);
    // ...and it reprices, because this row is unpaid and still at the canonical fare
    expect(writes.some((w) => w.table === 'queue_entries' && /"price":75/.test(w.body))).toBe(true);
    // the list row mirrors it so the two screens cannot disagree
    await expect.poll(() => writes.some((w) => w.table === 'desk_waitlist' && /"bike_type":"Road"/.test(w.body))).toBe(true);
  });

  test('a fare staff already settled is not rewritten by a type change', async ({ page }) => {
    await openWith(page, [{ ...linked, id: 'm3' }], [
      qe('e-wait', 1, { status: 'waiting', paid: true, price: 40 }), // paid, and at a hand-set price
    ]);
    const writes: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('queue_entries')) writes.push(r.postData() || ''); });
    await page.locator('#mw-host .mw-type').first().selectOption('Road');
    await expect.poll(() => writes.some((b) => /"type_preference":"Road"/.test(b))).toBe(true);
    expect(writes.some((b) => /"price"/.test(b))).toBe(false);
  });

  test('the row says how many of that type are free', async ({ page }) => {
    await openWith(page, [{ ...walkup, bike_type: 'Road' }]);
    await expect(page.locator('#mw-host')).toContainText('2'); // two Road bikes available
  });
});

// A parked booking can grow into a group from the list itself. The riders are added by the
// booking editor — one code path, one set of rules — and the half that was missing is that
// they also join the party ON the list: leave them off and staff hand out bikes from a list
// that is short by two, with nothing on screen saying so.
test.describe('growing a parked booking', () => {
  const parked = {
    id: 'm1', name: 'Rider 1', phone: '0500000001', bike_type: 'Hybrid', status: 'waiting',
    kind: 'managed', sort_order: 1, booking_id: 'e-wait', created_at: '2099-01-01T11:00:00Z',
  };

  async function open(page: import('@playwright/test').Page, desk = [parked]) {
    await stubSupabase(page, { sessions, queue_entries, desk_waitlist: desk, bikes: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length>0`);
    await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
  }

  test('the row offers it, and opens the editor ready to type a name', async ({ page }) => {
    await open(page);
    await page.locator('#mw-host').getByRole('button', { name: /Add rider/i }).first().click();
    await expect(page.locator('#be-nr-name-0')).toBeVisible();
  });

  test('riders added to a parked booking are parked with it', async ({ page }) => {
    await open(page);
    const inserts: { table: string; body: string }[] = [];
    page.on('request', (r) => {
      const m = r.url().match(/\/rest\/v1\/([^/?]+)/);
      if (m && r.method() === 'POST') inserts.push({ table: m[1], body: r.postData() || '' });
    });
    await page.evaluate(`(async()=>{ showBookingEditModal('e-wait'); _beAddRider();
      document.getElementById('be-nr-name-0').value='Second Rider'; await saveBookingEdit(); })()`);

    // the rider joins the booking...
    await expect.poll(() => inserts.some((i) => i.table === 'queue_entries' && /Second Rider/.test(i.body))).toBe(true);
    // ...and the Staff List, linked to the NEW booking row rather than the original
    await expect.poll(() => inserts.some((i) => i.table === 'desk_waitlist' && /Second Rider/.test(i.body))).toBe(true);
    const dw = inserts.find((i) => i.table === 'desk_waitlist');
    expect(dw && /"kind":"managed"/.test(dw.body)).toBe(true);
    expect(dw && /"booking_id":"e-wait"/.test(dw.body)).toBe(false);
  });

  test('a booking nobody parked stays off the list when it grows', async ({ page }) => {
    await open(page, []);                       // nothing on the Staff List
    const inserts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('desk_waitlist')) inserts.push(r.url()); });
    await page.evaluate(`(async()=>{ showBookingEditModal('e-wait'); _beAddRider();
      document.getElementById('be-nr-name-0').value='Second Rider'; await saveBookingEdit(); })()`);
    await page.waitForTimeout(500);
    expect(inserts).toEqual([]);                 // adding riders does not park anyone by itself
  });

  test('an approval ride is never offered it — one rider per member', async ({ page }) => {
    const sat = {
      id: 'sat1', day: 'Saturday', session_date: '2099-02-14', capacity: 20, status: 'open',
      created_at: 2, event_kind: 'community', ride_kind: 'saturday', paid_ride: false,
      needs_approval: true, hide_queue: true, spots: 20, title: 'Saturday Social Ride',
    };
    const satBooking = {
      id: 'sb1', session_id: 'sat1', session_day: 'Saturday', session_date: '2099-02-14',
      queue_num: 1, name: 'Member', phone: '0500000009', size: 'M', type_preference: 'Road',
      status: 'waiting', paid: false, price: 0, approval: 'approved', registered_at: '2099-01-01T10:00:00Z',
    };
    await stubSupabase(page, {
      sessions: [...sessions, sat], queue_entries: [satBooking], bikes: [],
      desk_waitlist: [{ ...parked, id: 'm9', booking_id: 'sb1', name: 'Member' }],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length>0`);
    await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
    await expect(page.locator('#mw-host').getByRole('button', { name: /Add rider/i })).toHaveCount(0);
  });
});
