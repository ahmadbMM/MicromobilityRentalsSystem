import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, staffReady, loadStaffHalf } from './helpers/supabase';

// SECURE_AUTH mode (SECURITY-RUNBOOK.md): the app talks to token-checked RPCs
// and the no-PII queue_public view instead of the locked tables. The flag is
// enabled per-browser via localStorage so these specs run against the same
// index.html that serves open mode.

const secureOn = (page: import('@playwright/test').Page) =>
  page.addInitScript(() => localStorage.setItem('cq_secure_auth', '1'));

const openSession = {
  id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12,
  status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null,
};

test('customer login goes through the customer_login RPC', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [openSession],
    customers: [], // direct-table login would find nobody — only the RPC path can succeed
    'rpc:customer_login': [{
      id: 'c9', name: 'Secure Rider', email: 'secure@example.com', phone: '0500000009',
      height: 175, type_preference: 'Any', created_at: '2026-01-01T00:00:00Z',
      birth_date: null, country: null, city: null, photo: null, session_token: 'tok123',
    }],
  });
  await secureOn(page);
  await page.goto('/');
  await waitForSb(page);
  // Auth-first: a signed-out visitor's first page IS the sign-in screen — no click needed.
  await expect(page.locator('#a-identifier')).toBeVisible();
  await page.fill('#a-identifier', 'secure@example.com');
  await page.fill('#a-pwd', 'Passw0rdX');
  await page.evaluate(`doLogin()`);

  await expect.poll(() => page.evaluate(`S.loggedIn && S.loggedIn.name`)).toBe('Secure Rider');
  expect(await page.evaluate(`S.loggedIn.session_token`)).toBe('tok123');
});

test('customer reads merge queue_public with my_bookings and skip the locked table', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [openSession],
    queue_entries: [], // locked in secure mode — anything here must NOT be used
    queue_public: [
      { id: 'q-other-1', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 1, status: 'waiting', size: 'M', type_preference: 'Any', paid: false, price: 30, assigned_bike_id: null, walk_in: false, ride_duration: null },
      { id: 'q-other-2', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 2, status: 'waiting', size: 'L', type_preference: 'Road', paid: true, price: 35, assigned_bike_id: null, walk_in: false, ride_duration: null },
    ],
    'rpc:my_bookings': [
      { id: 'q-mine', name: 'Secure Rider', email: 'secure@example.com', phone: '0500000009', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 3, status: 'waiting', size: 'M', type_preference: 'Any', paid: false, price: 30, assigned_bike_id: null, walk_in: false, customer_id: 'c9', registered_at: '2026-01-01T10:00:00Z' },
    ],
  });
  await secureOn(page);
  await loginCustomer(page, { id: 'c9', name: 'Secure Rider', email: 'secure@example.com', session_token: 'tok123' });
  await page.goto('/');
  await waitForSb(page);

  // availability sees all three bookings (two public + own), PII-free for the others
  await expect.poll(() => page.evaluate(`S.queue.length`)).toBe(3);
  expect(await page.evaluate(`S.queue.filter(e => e.name).length`)).toBe(1); // only own row carries a name

  // My Rides renders the own booking from the RPC row (tab switch via app fn:
  // the top tab-nav is desktop-only, mobile uses the bottom nav). Re-render on
  // each poll so a one-off render before data settles doesn't flake under load.
  await expect(async () => {
    await page.evaluate(`setCustTab('myrides'); if (typeof renderMyRides === 'function') renderMyRides();`);
    await expect(page.locator('#tab-myrides')).toContainText('#3', { timeout: 1000 });
  }).toPass({ timeout: 8000 });
});

test('a stale staff unlock without an Auth session falls back to the PIN gate', async ({ page }) => {
  await stubSupabase(page, { sessions: [openSession] });
  await secureOn(page);
  await unlockStaff(page); // cq_staff=1 but no Supabase Auth session exists
  await page.goto('/');
  await waitForSb(page);

  await expect(page.locator('.auth-box')).toBeVisible(); // landed on the public sign-in page, not the staff panel
  expect(await page.evaluate(`localStorage.getItem('cq_staff')`)).toBeNull();
  expect(await page.evaluate(`S._staffAuthed === true`)).toBe(false);
});

test('customer writes route through the token RPCs when the table is locked', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [openSession],
    'rpc:customer_booking_update': true,
    'rpc:customer_shiftdown': true,
  });
  await secureOn(page);
  await loginCustomer(page, { id: 'c9', name: 'Secure Rider', session_token: 'tok123' });
  await page.goto('/');
  await waitForSb(page);

  const rpcCalls: string[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/(rpc\/[a-z_]+|queue_entries)/);
    if (m && ['PATCH', 'POST'].includes(r.method())) rpcCalls.push(`${r.method()} ${m[1]}`);
  });

  // an own-row update (cancel) must go to the RPC, not a direct table PATCH
  const res = await page.evaluate(`_ownEntryUpdate('q-mine', { status: 'cancelled', assigned_bike_id: null })`);
  expect(res).toEqual({ error: null });
  // Queue numbers never shift (gaps are kept), so _shiftDownAfter is a deliberate no-op: it must
  // make NO writes at all - not a direct table PATCH and not even the shiftdown RPC.
  await loadStaffHalf(page); // a staff helper on a customer's page: the staff half is fetched first (2026-10-04)
  await page.evaluate(`_shiftDownAfter('s1', 3)`);

  expect(rpcCalls.some((c) => c.includes('rpc/customer_booking_update'))).toBe(true);
  expect(rpcCalls.some((c) => c.includes('rpc/customer_shiftdown'))).toBe(false); // shifting removed
  expect(rpcCalls.some((c) => c.includes('queue_entries'))).toBe(false); // never touched the locked table directly
});

test('customer add-on stock change routes through the RPC, not a direct inventory write', async ({ page }) => {
  await stubSupabase(page, { sessions: [openSession], 'rpc:customer_addon_stock': true });
  await secureOn(page);
  await loginCustomer(page, { id: 'c9', name: 'Secure Rider', session_token: 'tok123' });
  await page.goto('/');
  await waitForSb(page);
  const calls: string[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/(rpc\/customer_addon_stock|inventory)/);
    if (m && ['PATCH', 'POST'].includes(r.method())) calls.push(m[1]);
  });
  await page.waitForFunction('S.dataLoaded === true'); // let boot's loadData settle so it can't reset S.inventory mid-test
  // set + adjust + read in one shot so a background refresh can't race the assertion
  const qty = await page.evaluate(`(async () => {
    S.inventory = [{ id: 'inv1', name: 'Gel', qty: 5 }];
    await _addonStockQ([{ id: 'inv1', qty: 2 }], -1);
    return (S.inventory.find(x => x.id === 'inv1') || {}).qty;
  })()`);
  await expect.poll(() => calls.some((c) => c.includes('rpc/customer_addon_stock'))).toBe(true);
  expect(calls.some((c) => c === 'inventory')).toBe(false);
  expect(qty).toBe(3); // local copy updated via the RPC path
});

test('staff/open mode still writes queue_entries directly (no RPC)', async ({ page }) => {
  await stubSupabase(page, { sessions: [openSession] }); // secure mode OFF
  await page.goto('/');
  await waitForSb(page);
  const seen: string[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/(rpc\/customer_booking_update|queue_entries)/);
    if (m && r.method() === 'PATCH') seen.push(m[1]);
  });
  const res = await page.evaluate(`_ownEntryUpdate('q1', { status: 'cancelled' })`);
  expect(res).not.toBeNull();
  expect(seen.some((c) => c === 'queue_entries')).toBe(true);
  expect(seen.some((c) => c.includes('rpc/'))).toBe(false);
});

test('staff sign in with a Supabase Auth account (no 4-digit PIN)', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [openSession],
    staff: [{ user_id: 'u-staff-1', role: 'admin' }],
    'auth:token': {
      access_token: 'fake-jwt', token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fake-refresh',
      user: { id: 'u-staff-1', aud: 'authenticated', role: 'authenticated', email: 'staff@example.com' },
    },
  });
  await secureOn(page);
  await page.goto('/?staff');

  // Secure mode goes straight to the staff Auth login — no 4-digit PIN stage.
  await expect(page.locator('#staff-auth-email')).toBeVisible();
  // Set values directly: Playwright's mobile-emulation fill mis-targets adjacent
  // email+password inputs (a real soft keyboard doesn't); we're testing submit.
  await page.evaluate(`
    document.getElementById('staff-auth-email').value = 'staff@example.com';
    document.getElementById('staff-auth-pwd').value = 'hunter2A1';
  `);
  await page.locator('#pin-modal .btn-primary').click();

  await staffReady(page);
  expect(await page.evaluate(`S._staffAuthed`)).toBe(true);
  expect(await page.evaluate(`S.staffRole`)).toBe('admin');
});

// The booth runs on wifi that drops. staffAuthRestore used to treat ANY failure as proof
// the session was gone and delete cq_staff, so a blip — or a phone that had been asleep
// long enough for the access token to lapse — sent staff back to the PIN gate mid-shift.
// A device that genuinely never signed in must still be turned away (the test above), but
// one that merely could not reach the server keeps its unlock and retries.

// These drive staffAuthRestore's decision directly by swapping sb.auth, rather than trying
// to coax supabase-js into a particular internal state — the branch under test is "what does
// this function conclude from a failed refresh", and that is exactly what is asserted.

test('a network failure during auth restore does not cost staff their unlock', async ({ page }) => {
  await stubSupabase(page, { sessions: [openSession] });
  await secureOn(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);

  const kept = await page.evaluate(`(async () => {
    localStorage.setItem('cq_staff', '1');           // as if boot had restored it
    sb.auth.getSession    = async () => ({ data: { session: null } });
    sb.auth.refreshSession = async () => { throw new TypeError('Failed to fetch'); };
    await staffAuthRestore();
    return { unlock: localStorage.getItem('cq_staff'), authed: S._staffAuthed === true };
  })()`) as { unlock: string | null; authed: boolean };

  expect(kept.unlock).toBe('1');   // the blip must not end the shift
  expect(kept.authed).toBe(false); // but nothing is claimed about being authed
});

test('a refresh that reports no session at all does return staff to the PIN gate', async ({ page }) => {
  await stubSupabase(page, { sessions: [openSession] });
  await secureOn(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);

  // A definite verdict, not a blip: this device holds no refresh token, so there is nothing
  // to restore and the unlock is stale. This is the case the test above must not weaken.
  const dropped = await page.evaluate(`(async () => {
    localStorage.setItem('cq_staff', '1');
    sb.auth.getSession    = async () => ({ data: { session: null } });
    sb.auth.refreshSession = async () => ({ data: { session: null }, error: { name: 'AuthSessionMissingError', message: 'Auth session missing!' } });
    await staffAuthRestore();
    return localStorage.getItem('cq_staff');
  })()`) as string | null;

  expect(dropped).toBeNull();
});

test('a lapsed access token is refreshed rather than treated as a sign-out', async ({ page }) => {
  await stubSupabase(page, { sessions: [openSession] });
  await secureOn(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);

  // The device was asleep past the token's lifetime — most of an evening at the booth.
  // The refresh succeeds, so the session is restored and the unlock never comes into question.
  const out = await page.evaluate(`(async () => {
    localStorage.setItem('cq_staff', '1');
    let asked = false;
    sb.auth.getSession    = async () => ({ data: { session: null } });
    sb.auth.refreshSession = async () => { asked = true; return { data: { session: { user: { id: 'staff-uid' } } }, error: null }; };
    const from = sb.from.bind(sb);
    sb.from = (t) => (t === 'staff'
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: 'staff-uid', role: 'admin', must_change_pwd: false }, error: null }) }) }) }
      : from(t));
    await staffAuthRestore();
    return { asked, unlock: localStorage.getItem('cq_staff'), authed: S._staffAuthed === true };
  })()`) as { asked: boolean; unlock: string | null; authed: boolean };

  expect(out.asked).toBe(true);  // it asked for a new token instead of giving up
  expect(out.unlock).toBe('1');
  expect(out.authed).toBe(true);
});
