import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Close one bike type instead of the whole session (the owner, 2026-11-03: "add an option to close a specific bike
// type for reservation instead of closing the whole session"; sessions.closed_types, _type_closed_guard, 20261103210000).
// A rider sees the type greyed and saying Closed, cannot pick it by any door, and keeps a booking already made on it;
// staff close and reopen it from the session's detail. All Supabase traffic is stubbed: the database's own refusal is
// covered here as the answer it gives.

const night = (id: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Tuesday', session_date: id, capacity: 20, spots: 20, status: 'open', created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...extra,
});
const OPEN = '2099-03-03', SHUT = '2099-03-10';
const pill = (page: Page, ty: string, slot = 0) => page.locator(`#tab-register [data-type-slot="${slot}"][data-type="${ty}"]`);
const errToast = (page: Page) => page.locator('#toast-container .toast.error');

async function rider(page: Page, fx: Fixtures = {}, cust: Record<string, unknown> = {}) {
  const sessions = [night(OPEN), night(SHUT, { closed_types: ['Road'] })];
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [], ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175, ...cust });
  await page.goto('/');
  await waitForSb(page);
}
const atRiders = (sid: string) => `S.lastTickets=[];S.selEvent='jcc';S.selSession='${sid}';S.regStep=2;setCustTab('register')`;
function rpcCalls(page: Page, name: string) {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(`/rest/v1/rpc/${name}`)) calls.push(r.postDataJSON());
  });
  return calls;
}

test.describe('@customer:reserve a closed bike type', () => {
  test('stays on the list greyed and saying Closed, and cannot be picked', async ({ page }) => {
    await rider(page);
    await page.evaluate(atRiders(SHUT));
    await expect(pill(page, 'Road')).toBeDisabled();
    await expect(pill(page, 'Road')).toContainText('Closed');
    await expect(pill(page, 'Road')).not.toContainText('75');
    await expect(pill(page, 'Hybrid')).toBeEnabled();
    await expect(pill(page, 'Hybrid')).toContainText('57.5');
    await page.evaluate(`setBikeType(0,'Road')`);
    expect(await page.evaluate('S.regBikeTypes[0]||null')).toBe(null);
    await page.evaluate(`setBikeType(0,'Hybrid')`);
    expect(await page.evaluate('S.regBikeTypes[0]')).toBe('Hybrid');
  });

  test('its "i" still describes the bike, without a Choose; an open type keeps its Choose', async ({ page }) => {
    await rider(page);
    await page.evaluate(atRiders(SHUT));
    const pick = page.locator('#bike-info-modal').getByRole('button', { name: 'Choose' });
    await page.locator('#tab-register .type-pick:has([data-type="Road"]) .type-info-btn').click();
    await expect(page.locator('#bike-info-modal .bike-info-box')).toBeVisible();
    await expect(pick).toHaveCount(0);
    await page.evaluate('closeBikeInfo()');
    await page.locator('#tab-register .type-pick:has([data-type="Hybrid"]) .type-info-btn').click();
    await expect(pick).toBeVisible();
  });

  test('another session of the same rider is not touched', async ({ page }) => {
    await rider(page);
    await page.evaluate(atRiders(OPEN));
    await expect(pill(page, 'Road')).toBeEnabled();
    await expect(pill(page, 'Road')).toContainText('75');
  });

  test('a saved preference for it is not seeded, and a pick carried from another ride is asked again', async ({ page }) => {
    await rider(page, {}, { type_preference: 'Road' });
    await page.evaluate(`S.regBikeTypes=['Road'];${atRiders(SHUT)}`);
    await expect(pill(page, 'Road')).toBeDisabled();
    expect(await page.evaluate('S.regBikeTypes[0]||null')).toBe(null);
    await expect(page.locator('#tab-register .toggle-btn.active[data-type-slot="0"]')).toHaveCount(0);
  });

  test('"Book my usual" stops on the riders step rather than a review of a closed bike', async ({ page }) => {
    const sessions = [night(SHUT, { closed_types: ['Hybrid'] })];
    await rider(page, { sessions, 'rpc:list_sessions': sessions }, { type_preference: 'Hybrid' });
    await page.evaluate('bookMyUsual()');
    expect(await page.evaluate('S.selSession')).toBe(SHUT);
    expect(await page.evaluate('S.regStep')).toBe(2);
    expect(await page.evaluate('S.regBikeTypes[0]||null')).toBe(null);
  });

  test('the "from" price is the cheapest type still open', async ({ page }) => {
    await rider(page);
    const from = (closed: string[]) => page.evaluate(`_sessFromPrice({id:'x',status:'open',closed_types:${JSON.stringify(closed)}})`);
    expect(await from([])).toContain('57.5');
    expect(await from(['Hybrid'])).toContain('57.5');                    // Mountain and Kids are still that price
    expect(await from(['Hybrid', 'Mountain', 'Kids'])).toContain('75');  // only Road and Road Carbon are left
    expect(await from(['Hybrid', 'Mountain', 'Kids'])).not.toContain('57.5');
  });

  test('the price shown before a type is picked leaves out what is closed', async ({ page }) => {
    await rider(page);
    const range = (closed: string[]) => page.evaluate(`_regRange({id:'x',status:'open',closed_types:${JSON.stringify(closed)}},'Any')`);
    expect(await range([])).toEqual([57.5, 75]);                                    // nothing closed: Any's range, as ever
    expect(await range(['Road'])).toEqual([57.5, 57.5]);                            // the 75 was Road's
    expect(await range(['Hybrid', 'Mountain', 'Kids'])).toEqual([75, 75]);          // only Road (and Carbon) left
    expect(await range(['Road', 'Hybrid', 'Mountain', 'Kids'])).toEqual([250, 250]); // only Carbon left
    expect(await page.evaluate(`_regRange({closed_types:['Road']},'Road Carbon')`)).toEqual([250, 250]); // a picked type is its own price
    // and on the screen
    await page.evaluate(atRiders(SHUT));
    await expect(page.locator('#reg-foot-tot')).toBeEmpty(); // no range before a pick (2026-11-10, row 9): the pills carry the prices
    await page.evaluate(`setBikeType(0,'Hybrid')`);
    await expect(page.locator('#reg-foot-tot')).toContainText('57.50');
  });

  test('a booking is sent with the open type picked', async ({ page }) => {
    await rider(page, { 'rpc:customer_create_booking': [{ id: 'n1', queue_num: 1, status: 'waiting', waitlist_num: null, price: 57.5 }] });
    const booked = rpcCalls(page, 'customer_create_booking');
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${SHUT}';S.regQty=1;S.regBikeHeights=['175'];S.regBikeTypes=['Hybrid'];S.regRiderNames=['Spec Rider'];S.waiverOk=true;S.regStep=3;renderRegister()`);
    await page.evaluate('submitReg()');
    await expect.poll(() => booked.length).toBe(1);
    expect((booked[0].p_entries as { type_preference: string }[])[0].type_preference).toBe('Hybrid');
  });

  test('the server refusing it is said in words and goes back to the riders step', async ({ page }) => {
    await rider(page, { 'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'TYPE_CLOSED', details: 'Road' } } });
    // the page has not heard yet: it still shows Road open on this ride
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${OPEN}';S.regQty=1;S.regBikeHeights=['175'];S.regBikeTypes=['Road'];S.regRiderNames=['Spec Rider'];S.waiverOk=true;S.regStep=3;renderRegister()`);
    await page.evaluate('submitReg()');
    await expect(errToast(page)).toContainText('That bike type is closed for this session');
    await expect(page.locator('#toast-container')).not.toContainText('TYPE_CLOSED');
    await expect.poll(() => page.evaluate('S.regStep')).toBe(2);
  });
});

test.describe('@customer:reserve a booking already made on a closed type', () => {
  const row = (id: string, qn: number, name: string, ty: string, sid = SHUT) => ({
    id, session_id: sid, session_day: 'Tuesday', session_date: sid, queue_num: qn, name, phone: '0500000001',
    customer_id: 'c1', type_preference: ty, height: 175, size: 'M', status: 'waiting', paid: false,
    price: ty === 'Road' ? 75 : 57.5, registered_at: '2099-01-01T10:00:00Z',
  });

  test('keeps its type on an edit, and can change away and back; a new rider cannot take it', async ({ page }) => {
    await rider(page, { queue_entries: [row('q1', 1, 'Spec Rider', 'Road')], 'rpc:customer_booking_update': true });
    await page.evaluate(atRiders(SHUT));
    await expect.poll(() => page.evaluate('S.modifyEntryId')).toBe('q1');
    await expect(pill(page, 'Road')).toBeEnabled();
    await expect(pill(page, 'Road')).not.toContainText('Closed');
    expect(await page.evaluate('S.regBikeTypes[0]')).toBe('Road');
    await page.evaluate(`setBikeType(0,'Hybrid')`);
    expect(await page.evaluate('S.regBikeTypes[0]')).toBe('Hybrid');
    await page.evaluate(`setBikeType(0,'Road')`);
    expect(await page.evaluate('S.regBikeTypes[0]')).toBe('Road');
    // the rider added on this edit has no row to keep
    expect(await page.evaluate(`_regTypeShut(_sessDisp('${SHUT}'),'Road',0)`)).toBe(false);
    expect(await page.evaluate(`_regTypeShut(_sessDisp('${SHUT}'),'Road',1)`)).toBe(true);
  });

  test('another type the booking does not hold stays closed on the edit', async ({ page }) => {
    await rider(page, { queue_entries: [row('q1', 1, 'Spec Rider', 'Hybrid')] });
    await page.evaluate(atRiders(SHUT));
    await expect.poll(() => page.evaluate('S.modifyEntryId')).toBe('q1');
    await expect(pill(page, 'Road')).toBeDisabled();
    await expect(pill(page, 'Hybrid')).toBeEnabled();
  });

  test('moving to a date where it is closed is refused before anyone moves', async ({ page }) => {
    await rider(page, { queue_entries: [row('q1', 1, 'Spec Rider', 'Road', OPEN), row('q2', 2, 'Sara Friend', 'Hybrid', OPEN)], 'rpc:customer_booking_update': true });
    const moves = rpcCalls(page, 'customer_booking_update');
    await page.evaluate(`rescheduleBooking('${OPEN}','${SHUT}')`);
    await expect(errToast(page)).toContainText('Your bike type is closed on that date');
    await page.waitForTimeout(200);
    expect(moves).toHaveLength(0); // Hybrid is open there, and the party is not split
  });

  test('the server refusing a move is said in words', async ({ page }) => {
    await rider(page, {
      queue_entries: [row('q1', 1, 'Spec Rider', 'Road', SHUT)],
      'rpc:customer_booking_update': { __rpcError: { status: 400, code: 'P0001', message: 'TYPE_CLOSED', details: 'Road' } },
    });
    await page.evaluate(`rescheduleBooking('${SHUT}','${OPEN}')`); // this page has not heard Road closed there
    await expect(errToast(page)).toContainText('Your bike type is closed on that date');
  });
});

test.describe('@staff:sessions closing a bike type', () => {
  const dlg = (page: Page) => page.locator('#tc-box');
  const typeBtn = (page: Page, name: string) => dlg(page).getByRole('button', { name, exact: true });
  const openBtn = (page: Page) => page.locator('.sess-detail-actions').getByRole('button', { name: /^Close bike types/ });

  async function staff(page: Page, sessions: Record<string, unknown>[], failWrite?: Parameters<typeof stubSupabase>[2]) {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] }, failWrite);
    await unlockStaff(page);
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && /\/rest\/v1\/sessions(\?|$)/.test(r.url())) patches.push(r.postDataJSON());
    });
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('allSessions().length>0');
    return patches;
  }
  const detail = (page: Page, id: string) => page.evaluate(`setStaffTab('sessions');selectSessionDetail('${id}')`);

  test('a type is closed from the session and the save says so to the database; Undo opens it again', async ({ page }) => {
    const patches = await staff(page, [night(OPEN)]);
    await detail(page, OPEN);
    await openBtn(page).click();
    await expect(dlg(page)).toBeVisible();
    await expect(typeBtn(page, 'Road')).toHaveAttribute('aria-pressed', 'false');
    await typeBtn(page, 'Road').click();
    await expect(typeBtn(page, 'Road')).toHaveAttribute('aria-pressed', 'true');
    await expect(typeBtn(page, 'Road')).toHaveClass(/active/);
    await expect(typeBtn(page, 'Road').locator('.tc-state')).toHaveText('Closed'); // said in words, not by colour alone
    await expect(typeBtn(page, 'Hybrid').locator('.tc-state')).toBeHidden();
    await dlg(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dlg(page)).toHaveCount(0);
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ closed_types: ['Road'] });
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
    await page.locator('#topbar-right .undo-btn').click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toEqual({ closed_types: [] });
  });

  test('the session never loses its status or anything else on the way', async ({ page }) => {
    const patches = await staff(page, [night(OPEN, { closed_types: ['Kids'] })]);
    await detail(page, OPEN);
    await openBtn(page).click();
    await typeBtn(page, 'Kids').click();
    await dlg(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(Object.keys(patches[0])).toEqual(['closed_types']);
    expect(patches[0]).toEqual({ closed_types: [] });
  });

  test('the list and the detail name what is closed, and the dialog opens on it', async ({ page }) => {
    await staff(page, [night(OPEN, { closed_types: ['Kids', 'Road'] })]);
    await detail(page, OPEN);
    await expect(page.locator('.sess-detail-tc')).toHaveText('Bike types closed: Kids, Road');
    await expect(page.locator(`.sess-lc .sess-lc-tc`)).toHaveText('Bike types closed: Kids, Road');
    await expect(openBtn(page)).toHaveText('Close bike types (2)');
    await openBtn(page).click();
    await expect(typeBtn(page, 'Kids')).toHaveAttribute('aria-pressed', 'true');
    await expect(typeBtn(page, 'Road')).toHaveAttribute('aria-pressed', 'true');
    await expect(typeBtn(page, 'Hybrid')).toHaveAttribute('aria-pressed', 'false');
  });

  test('the dialog lists what this session offers: Any never, Own and Carbon by the ride', async ({ page }) => {
    const SAT = '2099-03-07';
    await staff(page, [night(OPEN), night(SAT, { day: 'Saturday', event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true })]);
    await detail(page, OPEN);
    await openBtn(page).click();
    await expect(typeBtn(page, 'Road Carbon')).toBeVisible();
    await expect(typeBtn(page, 'Any')).toHaveCount(0);
    await expect(dlg(page).locator('.toggle-btn')).toHaveCount(5); // Road, Hybrid, Mountain, Kids, Road Carbon
    await page.evaluate('closeConfirm()');
    await detail(page, SAT);
    await openBtn(page).click();
    await expect(typeBtn(page, 'Road Carbon')).toHaveCount(0);
    await expect(dlg(page).locator('.toggle-btn')).toHaveCount(5); // Road, Hybrid, Mountain, Kids and the rider's own
  });

  test('the last open type stays open: that is the session\'s own Close', async ({ page }) => {
    const patches = await staff(page, [night(OPEN)]);
    await detail(page, OPEN);
    await openBtn(page).click();
    const save = dlg(page).getByRole('button', { name: 'Save', exact: true });
    await expect(page.locator('#tc-last')).toBeHidden();
    for (const ty of ['Road', 'Hybrid', 'Mountain', 'Kids']) await typeBtn(page, ty).click();
    await expect(save).toBeEnabled();
    await typeBtn(page, 'Road Carbon').click();
    await expect(save).toBeDisabled();
    await expect(page.locator('#tc-last')).toBeVisible();
    await expect(page.locator('#tc-last')).toContainText('close the session');
    await page.evaluate('saveTypeClose()'); // the button aside
    expect(patches).toHaveLength(0);
    await typeBtn(page, 'Kids').click();
    await expect(save).toBeEnabled();
    await expect(page.locator('#tc-last')).toBeHidden();
  });

  test('saving with nothing changed writes nothing, and Cancel, the X and Escape leave it alone', async ({ page }) => {
    const patches = await staff(page, [night(OPEN, { closed_types: ['Kids'] })]);
    await detail(page, OPEN);
    await openBtn(page).click();
    await dlg(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dlg(page)).toHaveCount(0);
    await openBtn(page).click();
    await typeBtn(page, 'Road').click();
    await dlg(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dlg(page)).toHaveCount(0);
    await openBtn(page).click();
    await expect(typeBtn(page, 'Road')).toHaveAttribute('aria-pressed', 'false'); // the abandoned tap did not stay
    await page.keyboard.press('Escape');
    await expect(dlg(page)).toHaveCount(0);
    await page.waitForTimeout(150);
    expect(patches).toHaveLength(0);
  });

  test('a refused write is said, and nothing is offered to undo', async ({ page }) => {
    await staff(page, [night(OPEN)], { table: 'sessions', methods: ['PATCH'] });
    await detail(page, OPEN);
    await openBtn(page).click();
    await typeBtn(page, 'Road').click();
    await dlg(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await expect(page.locator('#topbar-right .undo-btn')).toHaveCount(0);
  });

  test('a session with no bikes, a closed one and a past one do not offer it', async ({ page }) => {
    const POOL = '2099-03-05', CLOSED = '2099-03-12', PAST = '2020-03-03';
    await staff(page, [
      night(OPEN),
      night(POOL, { event_kind: 'community', ride_kind: 'swim', needs_approval: true, hide_queue: true, title: 'Pool' }),
      night(CLOSED, { status: 'closed', closed_types: ['Road'] }),
      night(PAST),
    ]);
    await detail(page, OPEN);
    await expect(openBtn(page)).toBeVisible();
    await detail(page, POOL);
    await expect(openBtn(page)).toHaveCount(0);
    await detail(page, CLOSED);
    await expect(openBtn(page)).toHaveCount(0);
    await expect(page.locator('.sess-detail-tc')).toHaveCount(0); // a closed session is closed whatever its types
    await detail(page, PAST);
    await expect(openBtn(page)).toHaveCount(0);
  });

  test('a clone starts with every type open', async ({ page }) => {
    await staff(page, [night(OPEN, { closed_types: ['Road'] })]);
    const posts: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST' || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
      const b = r.postDataJSON(); posts.push(...(Array.isArray(b) ? b : [b]));
    });
    await page.evaluate(`setStaffTab('sessions');cloneSession('${OPEN}')`);
    await page.locator('#ns-date').fill('2099-04-07');
    await page.evaluate('addSession()');
    await expect.poll(() => posts.length).toBeGreaterThan(0);
    expect(posts[0]).not.toHaveProperty('closed_types');
  });

  test('the kiosk does not offer it', async ({ page }) => {
    await staff(page, [night(OPEN, { closed_types: ['Road'] })]);
    await page.evaluate(`typeof _loadStaffParts==='function'?_loadStaffParts():null`);
    const types = await page.evaluate(`_koTypes(_sessGet('${OPEN}'))`) as string[];
    expect(types).not.toContain('Road');
    expect(types).toContain('Hybrid');
  });
});
