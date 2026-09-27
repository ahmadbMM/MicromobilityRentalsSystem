import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// The Petromin Wednesday Ride: a SECOND community ride. It shares exactly one thing with the
// Saturday Social Ride — only riders holding the community tag may book it — and is an
// ordinary circuit session in every other respect: real prices, real queue numbers, a seat
// count that overflows to the waitlist, and groups. Everything the app used to key off the
// word "community" (free, solo, staff-approved, hidden numbers) is now keyed off the two
// things that actually vary: paid_ride and needs_approval.

const jcc = { id: 's1', day: 'Sunday', session_date: '2099-01-11', capacity: 12, status: 'open', created_at: 1, location: 'JCC' };
const sat = {
  id: '2099-01-10', day: 'Saturday', session_date: '2099-01-10', capacity: 20, status: 'open', created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', paid_ride: false,
  needs_approval: true, hide_queue: true, spots: 20, title: 'Saturday Social Ride',
};
const petromin = {
  id: '2099-01-13-pw', day: 'Wednesday', session_date: '2099-01-13', capacity: 10, status: 'open', created_at: 1,
  event_kind: 'community', ride_kind: 'petromin', paid_ride: true,
  needs_approval: false, hide_queue: false, spots: null, title: 'Petromin Wednesday Ride',
};
const bikes = [{ id: 'b1', name: 'B1', size: 'M', type: 'Road', status: 'available', rental_price: 75 }];
const fixtures = { sessions: [jcc, sat, petromin], bikes, queue_entries: [] };
const member = { ...fixtures, 'rpc:community_member': true };

async function bootMember(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { ...member, ...extra });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.selEvent='community';setCustTab('register')`);
}

/** Click a ride's card and wait for the (async, gate-checked) selection to land. */
async function pickRide(page: import('@playwright/test').Page, cls: string, id: string) {
  await page.locator(`.sess-card.${cls}`).click();
  await page.waitForFunction(`S.selSession===${JSON.stringify(id)}`);
}

test.describe('who may book it', () => {
  test('a non-member is stopped at the same members-only dialog', async ({ page }) => {
    await stubSupabase(page, fixtures); // no community_member fixture = not a member
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='community';setCustTab('register')`);

    await page.locator('.sess-card.ev-petromin').click();
    await expect(page.locator('#confirm-modal')).toContainText('Community members only');
    expect(await page.evaluate('S.selSession')).toBeNull();
  });

  test('a member gets straight in', async ({ page }) => {
    await bootMember(page);
    await pickRide(page, 'ev-petromin', '2099-01-13-pw');
    await expect(page.locator('#confirm-modal')).toBeHidden();
  });
});

test.describe('it behaves like a circuit session, not like the Saturday ride', () => {
  test('the rides card lists every non-JCC ride, each in its own colour', async ({ page }) => {
    await bootMember(page);
    await expect(page.locator('.sess-card')).toHaveCount(2);       // both community rides, no JCC
    await expect(page.locator('.sess-card.ev-saturday')).toHaveCount(1);
    await expect(page.locator('.sess-card.ev-petromin')).toHaveCount(1);
    await expect(page.locator('.sess-card.ev-petromin')).toContainText('Petromin Wednesday Ride');
    await expect(page.locator('.sess-card.ev-petromin')).not.toContainText(/gathering/i); // circuit-style time
    await expect(page.locator('.sess-card.ev-saturday')).toContainText(/gathering/i);     // the social ride keeps it
  });

  test('riders see a fare, not "Free" — and may book a group', async ({ page }) => {
    await bootMember(page);
    await pickRide(page, 'ev-petromin', '2099-01-13-pw');
    await page.evaluate(`S.regStep=2;renderRegister();setBikeType(0,'Road')`); // riders step: stepper + fare
    await expect(page.locator('.qty-stepper')).toBeVisible();
    await expect(page.locator('#price-preview-wrap')).toContainText('SAR 75');
    await expect(page.locator('#price-preview-wrap')).not.toContainText('Complimentary');
  });

  test('the Saturday ride shows no stepper and no fare', async ({ page }) => {
    await bootMember(page);
    await pickRide(page, 'ev-saturday', '2099-01-10');
    await page.evaluate(`S.regStep=2;renderRegister();setBikeType(0,'Road')`);
    await expect(page.locator('.qty-stepper')).toHaveCount(0);
    await expect(page.locator('#price-preview-wrap')).toContainText('Complimentary');
  });

  test('the Saturday ride still books one rider at a time', async ({ page }) => {
    await bootMember(page);
    await pickRide(page, 'ev-saturday', '2099-01-10');
    expect(await page.evaluate('S.regQty')).toBe(1);
    await page.evaluate('changeRegQty(1)');
    expect(await page.evaluate('S.regQty')).toBe(1); // pinned, whatever the stepper is told
  });

  test('a group of two books at the real price, with no approval attached', async ({ page }) => {
    await bootMember(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(
      `S.selSession='2099-01-13-pw'; S.regQty=2; S.regBikeHeights=[175,168]; S.regBikeTypes=['Road','Road'];
       S.regRiderNames=['Spec Rider','Friend']; S.promoApplied=null; S.waiverOk=true;submitReg();`,
    );
    await expect.poll(() => rows.length).toBe(2);
    expect(rows[0].price).toBe(75);
    expect(rows[1].price).toBe(75);
    expect(rows[0].approval ?? null).toBeNull(); // not a reservation awaiting staff
  });

  test('a Saturday booking is still complimentary and pending', async ({ page }) => {
    await bootMember(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(
      `S.selSession='2099-01-10'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Road'];
       S.regRiderNames=['Spec Rider']; S.promoApplied=null; S.waiverOk=true;submitReg();`,
    );
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].price).toBe(0);
    expect(rows[0].approval).toBe('pending');
  });

  test('a rider on their own bike pays nothing, on either ride', async ({ page }) => {
    await bootMember(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(
      `S.selSession='2099-01-13-pw'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Own'];
       S.regRiderNames=['Spec Rider']; S.promoApplied=null; S.waiverOk=true;submitReg();`,
    );
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].type_preference).toBe('Own');
    expect(rows[0].price).toBe(0);
  });

  test('the bike-type menu: Own on both rides, Road Carbon on Petromin only', async ({ page }) => {
    await bootMember(page);
    await pickRide(page, 'ev-petromin', '2099-01-13-pw');
    await page.evaluate(`S.regStep=2;renderRegister()`);
    const petro = await page.evaluate(`Array.from(document.querySelectorAll('[data-type-slot="0"]')).map(b=>b.dataset.type)`);
    expect(petro).toContain('Own');              // owners are welcome
    expect(petro).toContain('Road Carbon');      // carbon bikes go out on the Petromin ride (2026-09-21)
    await page.evaluate(`S.regStep=1;renderRegister()`); // back to the ride list
    await pickRide(page, 'ev-saturday', '2099-01-10');
    await page.evaluate(`S.regStep=2;renderRegister()`);
    const sat = await page.evaluate(`Array.from(document.querySelectorAll('[data-type-slot="0"]')).map(b=>b.dataset.type)`);
    expect(sat).toContain('Own');
    expect(sat).not.toContain('Road Carbon');     // ...but not on the social ride
    expect(await page.evaluate(`bikeTypeOpts(false,false)`)).toContain('Road Carbon'); // the circuit keeps them
    expect(await page.evaluate(`bikeTypeOpts(false,false)`)).not.toContain('Own');
  });

  test('carbon on the Petromin ride is booked as carbon at 250; the social ride still coerces it', async ({ page }) => {
    await bootMember(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(
      `S.selSession='2099-01-13-pw'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Road Carbon'];
       S.regRiderNames=['Spec Rider']; S.promoApplied=null; S.waiverOk=true;submitReg();`,
    );
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].type_preference).toBe('Road Carbon');
    expect(rows[0].price).toBe(250);
    // A stale client asking for carbon on the Saturday ride is still coerced (the DB trigger too).
    await page.evaluate(
      `S.selSession='2099-01-10'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Road Carbon'];
       S.regRiderNames=['Spec Rider']; S.promoApplied=null; S.regSubmitting=false; S.waiverOk=true;submitReg();`,
    );
    await expect.poll(() => rows.length).toBe(2);
    expect(rows[1].type_preference).not.toBe('Road Carbon');
  });

  test('a rider on their own bike takes a place here: a full ride waitlists them too', async ({ page }) => {
    // Petromin places are the track's, not the rack's. An owner pays nothing but still
    // fills one of the N places the venue admits, so a full ride sends them to the waitlist
    // exactly like a renter (the DB's _capacity_guard counts them the same way).
    const taken = Array.from({ length: 10 }, (_, i) => ({
      id: 'f' + i, session_id: '2099-01-13-pw', session_day: 'Wednesday', session_date: '2099-01-13',
      queue_num: i + 1, name: 'Rider ' + i, size: 'M', type_preference: 'Road', status: 'waiting',
      paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z',
    }));
    await bootMember(page, { queue_entries: taken });
    const rows = await captureBookingRows(page);
    await page.evaluate(
      `S.selSession='2099-01-13-pw'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Own'];
       S.regRiderNames=['Spec Rider']; S.promoApplied=null; S.waiverOk=true;submitReg();`,
    );
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].status).toBe('waitlist');
    expect(rows[0].price).toBe(0);
  });

  test('owners already on the ride count toward its places; on the Saturday ride they do not', async ({ page }) => {
    // 10 places, 7 renters and 3 owners: the meter reads 0 left, and the next renter is
    // waitlisted. The Saturday ride keeps the old rule — owners are invisible to its meter.
    const mk = (i: number, type: string, sid: string) => ({
      id: 'g' + i, session_id: sid, session_day: 'Wednesday', session_date: '2099-01-13',
      queue_num: i + 1, name: 'Rider ' + i, size: 'M', type_preference: type, status: 'waiting',
      paid: false, price: 0, registered_at: '2099-01-01T10:00:00Z', approval: 'approved',
    });
    const pw = Array.from({ length: 10 }, (_, i) => mk(i, i < 7 ? 'Road' : 'Own', '2099-01-13-pw'));
    const satRows = Array.from({ length: 3 }, (_, i) => mk(20 + i, 'Own', '2099-01-10'));
    await bootMember(page, { queue_entries: [...pw, ...satRows] });
    expect(await page.evaluate(`spotsLeft('2099-01-13-pw')`)).toBe(0);
    expect(await page.evaluate(`spotsLeft('2099-01-10')`)).toBe(20);
    const rows = await captureBookingRows(page);
    await page.evaluate(
      `S.selSession='2099-01-13-pw'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Road'];
       S.regRiderNames=['Spec Rider']; S.promoApplied=null; S.waiverOk=true;submitReg();`,
    );
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].status).toBe('waitlist');
  });

  // The member and one guest. Staff are exempt, so the desk can still seat a larger party.
  test('a party is capped at the member plus one — the stepper will not go past it', async ({ page }) => {
    await bootMember(page);
    await pickRide(page, 'ev-petromin', '2099-01-13-pw');
    await page.evaluate(`S.regStep=2;renderRegister()`);
    for (let i = 0; i < 8; i++) await page.evaluate('changeRegQty(1)');
    expect(await page.evaluate('S.regQty')).toBe(2);
    await expect(page.locator('.reg-row').first()).toContainText(/up to 2 riders/i);
  });

  test('a third rider is refused at submit, not quietly trimmed', async ({ page }) => {
    await bootMember(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(
      `S.selSession='2099-01-13-pw'; S.regQty=5; S.regBikeHeights=[175,175,175,175,175];
       S.regBikeTypes=['Road','Road','Road','Road','Road'];
       S.regRiderNames=['A','B','C','D','E']; S.promoApplied=null; S.waiverOk=true;submitReg();`,
    );
    await expect(page.locator('.toast')).toContainText(/up to 2 riders/i);
    expect(rows).toHaveLength(0);           // nothing was posted
    expect(await page.evaluate('S.regQty')).toBe(2);
  });

  test('the JCC stepper is not pinned to one: it goes up to the account\'s three', async ({ page }) => {
    await bootMember(page);
    await page.evaluate(`S.selEvent='jcc';setCustTab('register')`);
    await page.locator('.sess-card.ev-jcc').click();
    await page.waitForFunction(`S.selSession==='s1'`);
    for (let i = 0; i < 12; i++) await page.evaluate('changeRegQty(1)');
    expect(await page.evaluate('S.regQty')).toBe(3);   // three riders per account per session (jcc-rider-cap.spec)
  });

  test('a full seat count sends the next rider to the waitlist', async ({ page }) => {
    // 10 seats, 10 riders already on it: the client must not seat an 11th.
    const taken = Array.from({ length: 10 }, (_, i) => ({
      id: 'e' + i, session_id: '2099-01-13-pw', session_day: 'Wednesday', session_date: '2099-01-13',
      queue_num: i + 1, name: 'Rider ' + i, size: 'M', type_preference: 'Road', status: 'waiting',
      paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z',
    }));
    await bootMember(page, { queue_entries: taken });
    const rows = await captureBookingRows(page);
    await page.evaluate(
      `S.selSession='2099-01-13-pw'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Road'];
       S.regRiderNames=['Spec Rider']; S.promoApplied=null; S.waiverOk=true;submitReg();`,
    );
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].status).toBe('waitlist');
  });
});

test.describe('staff side', () => {
  test('a Petromin booking keeps its number and its money column', async ({ page }) => {
    const booking = {
      id: 'p1', session_id: '2099-01-13-pw', session_day: 'Wednesday', session_date: '2099-01-13',
      queue_num: 4, name: 'Spec Rider', size: 'M', type_preference: 'Road', status: 'waiting',
      paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z',
    };
    await stubSupabase(page, { ...fixtures, queue_entries: [booking] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.sfSession='2099-01-13-pw';renderStaffQueue()`);
    const html = await page.evaluate(`document.getElementById('tab-queue').innerHTML`) as string;
    expect(html).toContain('#4');                       // the number is real, not hidden
    expect(html).toContain('class="pay-toggle');       // and so is the fare (its pill holds Edit price too)
    expect(html).not.toContain('apprPendingChip');      // nothing to approve
  });

  test('staff editing a Petromin booking can pick Road Carbon; on the Saturday ride they cannot', async ({ page }) => {
    const petro = {
      id: 'p1', session_id: '2099-01-13-pw', session_day: 'Wednesday', session_date: '2099-01-13',
      queue_num: 4, name: 'Spec Rider', size: 'M', type_preference: 'Road', status: 'waiting',
      paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z',
    };
    const satBooking = { ...petro, id: 's1b', session_id: '2099-01-10', session_day: 'Saturday', session_date: '2099-01-10', queue_num: 1, price: 0, approval: 'approved' };
    await stubSupabase(page, { ...fixtures, queue_entries: [petro, satBooking] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const carbon = page.locator(`#booking-edit-modal button[data-on-click*="Road Carbon"]`);
    await page.evaluate(`showBookingEditModal('p1')`);
    await expect(carbon).toHaveCount(1);
    await page.evaluate(`closeBookingEditModal();showBookingEditModal('s1b')`);
    await expect(page.locator('#booking-edit-modal button[data-on-click*="_on_showBookingEditModal_1"]').first()).toBeVisible();
    await expect(carbon).toHaveCount(0);
  });

  test('creating one stamps the ride kind, the price rule and a date-proof id', async ({ page }) => {
    await stubSupabase(page, fixtures);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const writes: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST' && r.method() !== 'PATCH') return;
      if (!r.url().includes('/rest/v1/sessions')) return;
      const b = r.postDataJSON();
      (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => writes.push({ ...x, _url: r.url() }));
    });
    // Built from bikes, exactly like a circuit session: capacity is the composition's sum.
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='petromin';S.newSessTitle='Petromin Wednesday Ride';S.newSessMode='total';S.newSessTotal='10';renderSessions()`);
    await page.evaluate(`document.getElementById('ns-total').value='10';document.getElementById('ns-date').value='2099-01-13';addSession()`);

    await expect.poll(() => writes.length).toBeGreaterThan(1);
    const created = writes.find((w) => w.id);
    expect(created?.id).toBe('2099-01-13-pw'); // a circuit session may share the date
    expect(created?.capacity).toBe(10);        // from the bikes put out, not a typed seat count
    expect(JSON.parse(String(created?.bike_slots))._total).toBe(10);
    // the gate lands in two writes: the long-standing columns, then the newer pair
    const gate = Object.assign({}, ...writes.filter((w) => !w.id));
    expect(gate.ride_kind).toBe('petromin');
    expect(gate.paid_ride).toBe(true);
    expect(gate.needs_approval).toBe(false);  // no approval flow
    expect(gate.spots ?? null).toBeNull();    // no spot cap: capacity carries it
    expect(gate.hide_queue).toBe(false);      // numbers are visible
    expect(gate.event_kind).toBe('community'); // ...but the members gate still applies
    expect(gate.title).toBe('Petromin Wednesday Ride');
  });

  test('its form asks for bikes, not for a meeting point or a breakfast stop', async ({ page }) => {
    await stubSupabase(page, fixtures);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='petromin';renderSessions()`);
    await expect(page.locator('#ns-map')).toHaveCount(0);        // it meets at the circuit
    await expect(page.getByText(/gathering time/i)).toHaveCount(0); // a start-end window, as at the circuit
    await expect(page.getByText(/^time$/i).first()).toBeVisible();
    await expect(page.locator('#ns-spots')).toHaveCount(0);      // capacity comes from the bikes
    await expect(page.locator('#ns-title')).toBeVisible();       // but it is still named
    await expect(page.getByText(/bike fleet composition/i)).toBeVisible(); // the circuit's builder

    // the Saturday ride keeps both, since that is where they belong
    await page.evaluate(`S.newSessEvent='community';renderSessions()`);
    await expect(page.locator('#ns-map')).toBeVisible();
    await expect(page.locator('#ns-spots')).toBeVisible();
  });

  test('creating a Saturday ride is unchanged', async ({ page }) => {
    await stubSupabase(page, fixtures);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const writes: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST' && r.method() !== 'PATCH') return;
      if (!r.url().includes('/rest/v1/sessions')) return;
      const b = r.postDataJSON();
      (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => writes.push(x));
    });
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='community';S.newSessSpots='20';renderSessions()`);
    await page.evaluate(`document.getElementById('ns-date').value='2099-01-17';addSession()`);

    await expect.poll(() => writes.length).toBeGreaterThan(1);
    expect(writes.find((w) => w.id)?.id).toBe('2099-01-17'); // no suffix
    const gate = Object.assign({}, ...writes.filter((w) => !w.id));
    expect(gate.ride_kind).toBe('saturday');
    expect(gate.paid_ride).toBe(false);
    expect(gate.needs_approval).toBe(true);
    // Not named by staff, so no title is stored: each reader sees the default name in their
    // own language (_evName), never the staffer's.
    expect(gate.title).toBeNull();
    expect(await page.evaluate(`_evName({event_kind:'community',ride_kind:'saturday',title:null})`)).toBe('Saturday Social Ride');
  });
});

test.describe('a database that has not run the migration yet', () => {
  /** Refuses exactly the writes that touch the new columns, the way PostgREST would. */
  async function noNewColumns(page: import('@playwright/test').Page) {
    await page.route(/\/rest\/v1\/sessions/, async (route) => {
      const body = route.request().postData() || '';
      if (route.request().method() === 'PATCH' && body.includes('ride_kind')) {
        return route.fulfill({
          status: 400,
          headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
          body: JSON.stringify({ code: 'PGRST204', message: "Could not find the 'ride_kind' column of 'sessions'" }),
        });
      }
      return route.fallback();
    });
  }

  async function create(page: import('@playwright/test').Page, ev: string, date: string) {
    await stubSupabase(page, fixtures);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await noNewColumns(page);
    const writes: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (!r.url().includes('/rest/v1/sessions')) return;
      writes.push({ method: r.method(), body: r.postData() || '' });
    });
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='${ev}';S.newSessMode='total';S.newSessTotal='10';S.newSessSpots='20';renderSessions()`);
    await page.evaluate(`const _t=document.getElementById('ns-total');if(_t)_t.value='10';document.getElementById('ns-date').value='${date}';addSession()`);
    return writes;
  }

  test('a Saturday ride is still created — the older columns describe it completely', async ({ page }) => {
    const writes = await create(page, 'community', '2099-02-07');
    await expect.poll(() => writes.some((w) => w.method === 'POST')).toBe(true);
    // the session is NOT rolled back: no DELETE goes out
    await page.waitForTimeout(400);
    expect(writes.some((w) => w.method === 'DELETE')).toBe(false);
    await expect(page.locator('.toast')).not.toContainText(/ride_kind/i);
  });

  test('a Petromin ride refuses to be created half-made', async ({ page }) => {
    const writes = await create(page, 'petromin', '2099-02-11');
    // without paid_ride the ride would come back complimentary, so it is rolled back and said
    await expect.poll(() => writes.some((w) => w.method === 'DELETE')).toBe(true);
    await expect(page.locator('.toast')).toBeVisible();
  });
});

test('the landing card is an umbrella: the shared name, no per-ride blurb', async ({ page }) => {
  await stubSupabase(page, member);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
  const card = page.locator('#land-events .landing-event-card.ev-community');
  // renamed 2026-08-26: the umbrella now covers activities that are not rides at all
  await expect(card).toContainText('Micromobility Experiences');
  await expect(card.locator('.lec-meta')).toHaveCount(0); // the description is gone; the logo stays
  await expect(card.locator('img')).not.toHaveCount(0);
});

test.describe('a Petromin night at capacity', () => {
  // The fill rule marks a full night 'full', like every other ride. It used to write
  // 'closed' plus an _ac marker in the settings blob so it could tell its own close from a
  // person's, and the client carried a shim that read such a row as Fully Booked. Since
  // migration 20260916200000 nothing writes a marker and every one was cleared, so a
  // 'closed' Petromin night is a close a PERSON made, whatever the blob still says.
  const full = { ...petromin, status: 'full', bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 10 }) };
  const closed = { ...petromin, status: 'closed', bike_slots: JSON.stringify({ _ac: true, _time: '19:00 - 21:00', _total: 10 }) };

  test('a full night is still bookable, to the waitlist', async ({ page }) => {
    await stubSupabase(page, { ...member, sessions: [jcc, sat, full] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='community';setCustTab('register')`);
    await expect(page.locator('.sess-card.ev-petromin')).toBeVisible();
    const rows = await captureBookingRows(page);
    await page.evaluate(
      `S.selSession='2099-01-13-pw'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Road'];
       S.regRiderNames=['Spec Rider']; S.promoApplied=null; S.waiverOk=true;submitReg();`,
    );
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].status).toBe('waitlist');
  });

  test('a closed night is closed, marker or no marker, and customers do not see it', async ({ page }) => {
    await stubSupabase(page, { ...member, sessions: [jcc, sat, closed] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='community';setCustTab('register')`);
    await expect(page.locator('.sess-card.ev-petromin')).toHaveCount(0);
    expect(await page.evaluate(`_sessLive(allSessions().find(s=>s.id==='2099-01-13-pw'))`)).toBe(false);
    expect(await page.evaluate(`_sessFull(allSessions().find(s=>s.id==='2099-01-13-pw'))`)).toBe(false);
  });

  test('a person\'s Close writes the status and leaves the settings blob alone', async ({ page }) => {
    await stubSupabase(page, { ...fixtures, sessions: [jcc, sat, full] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /\/sessions/.test(r.url())) patches.push(JSON.parse(r.postData() || '{}')); });
    await page.evaluate(`toggleSession('2099-01-13-pw','closed')`);
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ status: 'closed' });
  });
});

// Hybrid, Mountain and Kids moved from 50 to 57.5. Petromin EMPLOYEES keep 50 - the riders who
// come through the company's registration form - and nobody else does: a rider who books the
// Petromin night on the website pays the standard fare like anywhere else. The database enforces
// it (_booking_fare); this covers the quote the desk sees, which has to agree with the row.
const fareOn = (sessionId: string, riders: unknown[]) => `(() => {
  S.riders = ${JSON.stringify(riders)};
  const e = { id: 'q1', sessionId: ${JSON.stringify(sessionId)} };
  return JSON.stringify(['Hybrid','Mountain','Kids','Any','Road'].reduce(
    (o,t) => (o[t] = priceForEntryType(e, t), o), {}));
})()`;
const standard = { Hybrid: 57.5, Mountain: 57.5, Kids: 57.5, Any: 57.5, Road: 75 };

test('only a registered employee rides a Petromin night at 50', async ({ page }) => {
  await stubSupabase(page, { sessions: [jcc, petromin], bikes });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);

  // A website booking on the Petromin night: no registration points at it.
  const website = JSON.parse(await page.evaluate<string>(fareOn('2099-01-13-pw', [])));
  expect(website).toEqual(standard);

  // The same booking once the employee's registration is linked to it.
  const employee = JSON.parse(await page.evaluate<string>(fareOn('2099-01-13-pw',
    [{ id: 1, matched_entry_id: 'q1', source: 'petromin' }])));
  expect(employee).toEqual({ Hybrid: 50, Mountain: 50, Kids: 50, Any: 50, Road: 75 });
});

// The employee fare belongs to the ride the form is for. A registration that matched the
// rider's booking on the circuit (rider_register looks there too) does not discount it.
test('a registration does not discount a booking on another ride', async ({ page }) => {
  await stubSupabase(page, { sessions: [jcc, sat, petromin], bikes });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const link = [{ id: 1, matched_entry_id: 'q1', source: 'petromin' }];
  expect(JSON.parse(await page.evaluate<string>(fareOn('s1', link)))).toEqual(standard);
  const social = JSON.parse(await page.evaluate<string>(fareOn('2099-01-10', link)));
  expect(social.Hybrid).toBe(57.5);
});
