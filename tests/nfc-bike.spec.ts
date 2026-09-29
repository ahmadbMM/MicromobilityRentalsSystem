import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A bike's NFC tag (and its QR sticker) holds its page, https://micromobility.sa/bikes/42, which
// the website sends a staff phone on from to https://staff.micromobility.sa/?bike=42 (the phone
// carries the mm_staff_tap cookie this app writes). iOS opens it in
// Safari on tap; the app treats that URL as the "a bike arrived" event. Everything about it
// is staff-only: a device without a staff session lands on the sign-in with no bike on the
// page, in the URL or in a request. With a session and an open check-in the bike goes into
// that modal; with no open check-in the bike's own card opens; a bike out with a rider on the
// ride opens that rider's return.

const BIKE = {
  id: 'b1', name: 'Road 042', bike_number: 42, type: 'Road', size: 'M', status: 'available',
  colors: ['#000000'], color_names: ['Black'], frame_type: 'Carbon', groupset: 'Shimano 105', brand: 'Trek', model: 'Domane',
};
const ENTRY = {
  id: 'e1', session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 7,
  name: 'Rider Seven', phone: '', customer_id: null, group_id: null, status: 'waiting', paid: false,
  price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z', type_preference: 'Road', size: 'M',
};
const SESSION = { id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 };

function fixtures(over: Record<string, unknown> = {}) {
  return {
    queue_entries: [ENTRY], sessions: [SESSION], bikes: [BIKE],
    'rpc:staff_resolve_bike': { found: true, bike: { ...BIKE, tag_uid: '04A1B2C3D4E5F6' }, rented_to: null },
    'rpc:staff_checkin': { ok: true, noop: false, assignment_id: 'a1' },
    ...over,
  };
}

/** Every RPC the page called, by name, with the JSON it sent. */
function watchRpcs(page: Page) {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (!m || r.method() !== 'POST') return;
    let body: Record<string, unknown> = {};
    try { body = r.postDataJSON(); } catch { /* no body */ }
    calls.push({ name: m[1], body });
  });
  return calls;
}

test('no staff session: the sign-in, no bike anywhere, and the code is off the address bar', async ({ page }) => {
  await stubSupabase(page, fixtures());
  const rpcs = watchRpcs(page);
  await page.goto('/?bike=42');
  await waitForSb(page);

  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/view-staff/);
  expect(page.url()).not.toContain('bike=');
  await expect(page.locator('body')).not.toContainText('Road 042');
  expect(rpcs.filter((c) => c.name === 'staff_resolve_bike')).toHaveLength(0);
  // Parked for after sign-in, nowhere else.
  expect(await page.evaluate(() => sessionStorage.getItem('cq_pending_bike'))).toBe('42');
});

test('staff session, no open check-in: the bike card opens', async ({ page }) => {
  await stubSupabase(page, fixtures());
  await unlockStaff(page);
  const rpcs = watchRpcs(page);
  await page.goto('/?bike=42');
  await waitForSb(page);

  await expect(page.locator('#bike-profile-modal')).toHaveCSS('display', 'flex');
  await expect(page.locator('#bike-profile-modal')).toContainText('Road 042');
  expect(page.url()).not.toContain('bike=');
  await expect.poll(() => rpcs.find((c) => c.name === 'staff_resolve_bike')?.body).toEqual({ p_code: '42' });
  expect(await page.evaluate(() => sessionStorage.getItem('cq_pending_bike'))).toBeNull();
});

test('staff session with an open check-in: the modal reopens with the bike filled and Confirm focused, and Confirm calls staff_checkin', async ({ page }) => {
  await stubSupabase(page, fixtures());
  await unlockStaff(page);
  await page.addInitScript(() => {
    localStorage.setItem('mm_active_checkin', JSON.stringify({ entryId: 'e1', ref: '#7', openedAt: Date.now() }));
  });
  const rpcs = watchRpcs(page);
  await page.goto('/?bike=42');
  await waitForSb(page);

  const modal = page.locator('#checkin-modal');
  await expect(modal).toHaveCSS('display', 'flex');
  await expect(modal).toContainText('Rider Seven');
  await expect(modal.locator('#ci-bike')).toHaveValue('42');
  await expect(modal.locator('#ci-bike-spec')).toContainText('042');
  await expect(modal.locator('#ci-bike-spec')).toContainText('Carbon');
  await expect(modal).toContainText('You can confirm here');
  await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('ci-confirm');
  await expect(modal.locator('#ci-confirm')).toBeEnabled();

  await modal.locator('#ci-confirm').click();
  await expect.poll(() => rpcs.find((c) => c.name === 'staff_checkin')?.body).toEqual({ p_booking_id: 'e1', p_bike_id: 'b1' });
  await expect(modal).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mm_active_checkin'))).toBeNull();
});

test('a bike that is out disables Confirm and names who has it', async ({ page }) => {
  await stubSupabase(page, fixtures({
    'rpc:staff_resolve_bike': { found: true, bike: { ...BIKE, status: 'in-use' }, rented_to: { name: 'Someone Else', since: '2099-02-10T09:00:00Z' } },
  }));
  await unlockStaff(page);
  await page.addInitScript(() => {
    localStorage.setItem('mm_active_checkin', JSON.stringify({ entryId: 'e1', ref: '#7', openedAt: Date.now() }));
  });
  await page.goto('/?bike=42');
  await waitForSb(page);

  const modal = page.locator('#checkin-modal');
  await expect(modal).toHaveCSS('display', 'flex');
  await expect(modal.locator('#ci-bike-spec')).toContainText('Someone Else');
  await expect(modal.locator('#ci-confirm')).toBeDisabled();
});

test('a database without the RPC: the classic check-in write runs instead', async ({ page }) => {
  await stubSupabase(page, fixtures({
    'rpc:staff_checkin': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_checkin' } },
  }));
  await unlockStaff(page);
  await page.addInitScript(() => {
    localStorage.setItem('mm_active_checkin', JSON.stringify({ entryId: 'e1', ref: '#7', openedAt: Date.now() }));
  });
  const patched: Array<Record<string, unknown>> = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries') && r.url().includes('id=eq.e1')) {
      try { patched.push(r.postDataJSON()); } catch { /* not JSON */ }
    }
  });
  await page.goto('/?bike=42');
  await waitForSb(page);

  const modal = page.locator('#checkin-modal');
  await expect(modal.locator('#ci-confirm')).toBeEnabled();
  await modal.locator('#ci-confirm').click();
  await expect.poll(() => patched.some((p) => p.status === 'active' && p.assigned_bike_id === 'b1')).toBe(true);
  await expect(modal).toBeHidden();
});

test('the in-app scanner reads a bike sticker into the open modal, and an expired check-in is ignored', async ({ page }) => {
  await stubSupabase(page, fixtures());
  await unlockStaff(page);
  await page.addInitScript(() => {
    // 16 minutes old: past the 15-minute window, so /?bike= must NOT reopen it.
    localStorage.setItem('mm_active_checkin', JSON.stringify({ entryId: 'e1', ref: '#7', openedAt: Date.now() - 16 * 60 * 1000 }));
  });
  await page.goto('/?bike=42');
  await waitForSb(page);
  await expect(page.locator('#bike-profile-modal')).toHaveCSS('display', 'flex');
  await expect(page.locator('#checkin-modal')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('mm_active_checkin'))).toBeNull();

  // Now a real check-in is open; a sticker scanned through the camera path fills its field.
  // @ts-expect-error app globals
  await page.evaluate(() => { closeBikeProfile(); S.staffTab = 'queue'; renderStaffQueue(); showCheckinModal('e1'); });
  const modal = page.locator('#checkin-modal');
  await expect(modal).toHaveCSS('display', 'flex');
  await expect(modal.locator('#ci-bike')).toHaveValue('');
  // A payment already chosen must survive the arrival of the bike.
  await modal.getByRole('button', { name: '✓ Paid', exact: true }).click();
  // @ts-expect-error app globals
  await page.evaluate(() => _onScanPayload('https://micromobilityrentals.pages.dev/?bike=42'));
  await expect(modal.locator('#ci-bike')).toHaveValue('42');
  await expect(modal.locator('#ci-bike-spec')).toContainText('Shimano 105');
  expect(await page.evaluate('S._ciPaid')).toBe('card');
  // The QR the bike's edit form gives holds its page, micromobility.sa/bikes/42; older ones /b/42.
  for (const url of ['https://micromobility.sa/bikes/42', 'https://micromobility.sa/b/42/']) {
    await modal.locator('#ci-bike').fill('');
    // @ts-expect-error app globals
    await page.evaluate((u) => _onScanPayload(u), url);
    await expect(modal.locator('#ci-bike')).toHaveValue('42');
  }
  // A sticker that holds only the number works too, and the field has its own Scan button.
  await modal.locator('#ci-bike').fill('');
  // @ts-expect-error app globals
  await page.evaluate(() => _onScanPayload('42'));
  await expect(modal.locator('#ci-bike')).toHaveValue('42');
  await expect(modal.getByRole('button', { name: 'Scan sticker' })).toBeVisible();
});

test('the tag leaves a receipt: the bike, the booking, whether it matches, and Undo', async ({ page }) => {
  await stubSupabase(page, fixtures({ queue_entries: [{ ...ENTRY, type_preference: 'Hybrid' }] }));
  await unlockStaff(page);
  await page.addInitScript(() => {
    localStorage.setItem('mm_active_checkin', JSON.stringify({ entryId: 'e1', ref: '#7', openedAt: Date.now() }));
  });
  await page.goto('/?bike=42');
  await waitForSb(page);
  const rcpt = page.locator('#checkin-modal .ci-nfc-rcpt');
  await expect(rcpt).toContainText('Road 042');
  await expect(rcpt).toContainText('#42');
  await expect(rcpt).toContainText('#7 Rider Seven');
  await expect(rcpt).toHaveClass(/warn/);
  await expect(rcpt).toContainText('Booked Hybrid · M - this bike is Road · M');
  await rcpt.getByRole('button', { name: 'Undo' }).click();
  await expect(rcpt).toHaveCount(0);
  await expect(page.locator('#checkin-modal #ci-bike')).toHaveValue('');
  await expect(page.locator('.toast').last()).toContainText('Bike taken out of the check-in');
});

test('a bike that matches the booking says so', async ({ page }) => {
  await stubSupabase(page, fixtures());
  await unlockStaff(page);
  await page.addInitScript(() => {
    localStorage.setItem('mm_active_checkin', JSON.stringify({ entryId: 'e1', ref: '#7', openedAt: Date.now() }));
  });
  await page.goto('/?bike=42');
  await waitForSb(page);
  await expect(page.locator('#checkin-modal .ci-nfc-rcpt')).toContainText('Matches the booking');
});

test("a tag on a bike out with a rider on the ride opens that rider's return, ahead of a check-in open in another tab", async ({ page }) => {
  const RIDING = { ...ENTRY, id: 'e2', queue_num: 3, name: 'Riding Rana', status: 'active', assigned_bike_id: 'b1', paid: false, checked_in_at: '2099-02-10T09:00:00Z' };
  await stubSupabase(page, fixtures({
    queue_entries: [ENTRY, RIDING],
    bikes: [{ ...BIKE, status: 'in-use' }],
    'rpc:staff_resolve_bike': { found: true, bike: { ...BIKE, status: 'in-use' }, rented_to: { name: 'Riding Rana', since: '2099-02-10T09:00:00Z' } },
    'rpc:staff_return': { ok: true },
  }));
  await unlockStaff(page);
  await page.addInitScript(() => {
    localStorage.setItem('mm_active_checkin', JSON.stringify({ entryId: 'e1', ref: '#7', openedAt: Date.now() }));
  });
  const rpcs = watchRpcs(page);
  await page.goto('/?bike=42');
  await waitForSb(page);

  const m = page.locator('#return-modal');
  await expect(m).toHaveCSS('display', 'flex');
  await expect(m.locator('#ret-title')).toContainText('#3 Riding Rana');
  await expect(m).toContainText('Road 042');
  await expect(page.locator('#checkin-modal')).toBeHidden(); // the bike is not given to #7 while it is still out
  // The rider still owes: the payment is asked on the same sheet, with the condition and the notes.
  await expect(m).toContainText('Pending');
  await m.getByRole('button', { name: 'Damaged' }).click();
  await expect(m).toContainText('Goes to maintenance.');
  await m.locator('#ret-notes').fill('Chain snapped');
  await m.locator('#ret-confirm').click();
  await expect.poll(() => rpcs.find((c) => c.name === 'staff_return')?.body).toEqual({ p_booking_id: 'e2', p_return_condition: 'damaged', p_notes: 'Chain snapped' });
  await expect(m).toBeHidden();
});

test('the staff app marks this phone for the website on the live staff address, and signing out unmarks it', async ({ page }) => {
  await stubSupabase(page, fixtures());
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  // What it writes, by address: only staff.micromobility.sa can set a cookie the website reads.
  const cookieFor = (host: string, on: boolean) => page.evaluate(([h, o]) => {
    // @ts-expect-error app global
    return _staffTapCookieStr(h, o);
  }, [host, on] as const);
  expect(await cookieFor('staff.micromobility.sa', true)).toBe('mm_staff_tap=1; Domain=micromobility.sa; Path=/; Max-Age=2592000; Secure; SameSite=Lax');
  expect(await cookieFor('STAFF.micromobility.sa', false)).toBe('mm_staff_tap=; Domain=micromobility.sa; Path=/; Max-Age=0; Secure; SameSite=Lax');
  for (const host of ['localhost', 'staff.localhost', 'micromobilityrentals.pages.dev', 'micromobility.sa', 'staff.micromobility.sa.example.com', 'evilstaff.micromobility.sa']) {
    expect(await cookieFor(host, true)).toBe('');
  }
  // When it writes: each time the panel opens, and away on sign-out. This host cannot hold the
  // live cookie, so the spec stands in a local one to watch the two calls land.
  await page.evaluate(() => {
    // @ts-expect-error app global
    window._staffTapCookieStr = (_h: string, on: boolean) => `mm_staff_tap=${on ? '1' : ''}; Path=/; Max-Age=${on ? 60 : 0}`;
  });
  await page.evaluate('goStaff()');
  const tap = async () => (await page.context().cookies()).find((c) => c.name === 'mm_staff_tap')?.value;
  await expect.poll(tap).toBe('1');
  // lockStaff() ends on a navigation, which takes the evaluate's page with it.
  await page.evaluate('lockStaff()').catch(() => {});
  await expect.poll(tap).toBeUndefined();
});
