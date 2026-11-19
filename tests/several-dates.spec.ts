import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// "Book several dates at once" (the user, 2026-11-19, item 7: "In the calendar view, a rider ticks several circuit nights
// (or dates of one event), then goes through one review, one waiver and one Confirm. Each date still becomes its own
// ticket."). Step one's Several dates switch turns the circuit's rows into checkboxes (eight at most, only dates bookable
// now); the riders step and the review are shared; Confirm makes one customer_create_booking call per date; dates that
// fail are named in a pop-up while the others stand.

const day = (n: number) => `2099-03-${String(n).padStart(2, '0')}`;
const night = (n: number, extra: Record<string, unknown> = {}) => ({
  id: day(n), session_date: day(n), day: 'Sunday', status: 'open', capacity: 12, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":12}', ...extra,
});
const N = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => night(n));
const mine = (id: string, sid: string) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: sid, queue_num: 1, name: 'Spec Rider', phone: '0500000001',
  customer_id: 'c1', type_preference: 'Road', height: 175, status: 'waiting', paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z',
});

async function open(page: Page, sessions: Record<string, unknown>[] = N.slice(0, 4), rows: Record<string, unknown>[] = [], lang = '') {
  const fx: Record<string, unknown> = { sessions, 'rpc:list_sessions': sessions, queue_entries: rows, 'rpc:my_bookings': rows };
  await stubSupabase(page, fx);
  await loginCustomer(page, { height: 175, type_preference: 'Road', nationality: 'SA', birth_date: '1990-01-01' });
  await page.goto('/' + (lang ? `?lang=${lang}` : ''));
  await waitForSb(page);
  await page.evaluate(`S.lastTickets=[];S.selEvent='jcc';S.selSession=null;S._mdt=null;S.regStep=1;S.regView='list';setCustTab('register')`);
  return fx;
}
const sw = (page: Page) => page.locator('#mdt-sw');
const row = (page: Page, n: number) => page.locator(`#tab-register [id="sc-${day(n)}"]`);
const creates = (page: Page) => {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/rpc/customer_create_booking')) calls.push(r.postDataJSON()); });
  return calls;
};
const toReview = `S.regQty=2;S.regBikeHeights=['175','150'];S.regBikeTypes=['Road','Road'];S.regRiderNames=['Spec Rider','Second Rider'];S.regStep=3;renderRegister()`;
const confirmBtn = (page: Page) => page.locator('#tab-register .mm-reg-foot .btn-primary');

test.describe('@customer:reserve several dates at once', () => {
  test('the switch shows for two bookable dates or more, and turns the rows into checkboxes', async ({ page }) => {
    await open(page);
    await expect(sw(page)).toHaveText('Several dates');
    await expect(sw(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(row(page, 1)).toHaveAttribute('role', 'radio');
    await sw(page).click();
    await expect(sw(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tab-register .session-cards-grid')).toHaveAttribute('role', 'group');
    await expect(row(page, 1)).toHaveAttribute('role', 'checkbox');
    await row(page, 3).click();
    await row(page, 1).click();
    await expect(row(page, 3)).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, 1)).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, 2)).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate('S.selSession')).toBe(day(3)); // the first ticked is the ride the steps read
    await expect(page.locator('#tab-register .reg-foot-sum')).toHaveText('2 dates');
    // a tap takes a tick back off
    await row(page, 1).click();
    await expect(row(page, 1)).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#tab-register .reg-foot-sum')).not.toHaveText('1 date'); // one date is a single booking
    // off again: the first ticked stays the single pick
    await row(page, 2).click();
    await sw(page).click();
    expect(await page.evaluate('[S._mdt,S.selSession]')).toEqual([null, day(3)]);
    await expect(row(page, 3)).toHaveAttribute('role', 'radio');
    await expect(row(page, 3)).toHaveAttribute('aria-checked', 'true');
  });

  test('no switch with one bookable date; a date full, booked or with no place left cannot be ticked', async ({ page }) => {
    await open(page, [night(1), night(2, { status: 'full' }), night(3)], [mine('m1', day(3))]);
    await expect(sw(page)).toHaveCount(0); // one date the rider could book now
    await open(page, [night(1), night(2, { status: 'full' }), night(3), night(4), night(5, { capacity: 1 })], [mine('m1', day(3)), { ...mine('o1', day(5)), customer_id: 'c9', name: 'Other Rider' }]);
    await sw(page).click();
    for (const n of [2, 3, 5]) {
      await expect(row(page, n)).toHaveAttribute('aria-disabled', 'true');
      await row(page, n).click({ force: true });
      await expect(row(page, n)).toHaveAttribute('aria-checked', 'false');
    }
    await row(page, 4).click();
    await expect(row(page, 4)).toHaveAttribute('aria-checked', 'true');
  });

  test('eight dates at most', async ({ page }) => {
    await open(page, N);
    await sw(page).click();
    for (let n = 1; n <= 8; n++) await row(page, n).click();
    await expect(page.locator('#tab-register .reg-foot-sum')).toHaveText('8 dates');
    await expect(row(page, 9)).toHaveAttribute('aria-disabled', 'true');
    await row(page, 9).click({ force: true });
    expect(await page.evaluate('S._mdt.length')).toBe(8);
    await row(page, 8).click(); // one off, and the ninth can be ticked
    await row(page, 9).click();
    await expect(row(page, 9)).toHaveAttribute('aria-checked', 'true');
  });

  test('arrow keys move along the dates and Space ticks, with one tab stop', async ({ page }) => {
    await open(page);
    await sw(page).click();
    await expect(page.locator('#tab-register [role="checkbox"][tabindex="0"]')).toHaveCount(1);
    await row(page, 1).focus();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 2)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(row(page, 2)).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, 2)).toBeFocused();
    await expect(row(page, 1)).toHaveAttribute('aria-checked', 'false');
  });

  test('the calendar view ticks too, and marks the days ticked', async ({ page }) => {
    await open(page);
    await page.evaluate(`_rcView('cal')`);
    await sw(page).click();
    await page.locator(`#tab-register [id="rc-d-${day(2)}"]`).click();
    await row(page, 2).click();
    await page.locator(`#tab-register [id="rc-d-${day(4)}"]`).click();
    await row(page, 4).click();
    expect(await page.evaluate('S._mdt')).toEqual([day(2), day(4)]);
    await expect(page.locator(`#tab-register [id="rc-d-${day(2)}"]`)).toHaveClass(/\bsel\b/);
    await expect(page.locator(`#tab-register [id="rc-d-${day(4)}"]`)).toHaveClass(/\bsel\b/);
    await expect(page.locator(`#tab-register [id="rc-d-${day(3)}"]`)).not.toHaveClass(/\bsel\b/);
    await expect(page.locator('#tab-register .reg-foot-sum')).toHaveText('2 dates');
  });

  test('one review lists each date with its price and the total; one waiver; one call per date, each asking for a place', async ({ page }) => {
    await open(page);
    const sent = creates(page);
    await sw(page).click();
    for (const n of [3, 1, 2]) await row(page, n).click();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click(); // Continue to the riders step
    expect(await page.evaluate('S.regStep')).toBe(2);
    await page.evaluate(toReview);
    const list = page.locator('#tab-register .cu-rv-head .mdt-rv li');
    await expect(page.locator('#tab-register .reg-side .mdt-rv li')).toHaveCount(3); // the wide screen's summary lists them too
    await expect(list).toHaveCount(3);
    await expect(list.first()).toContainText(await page.evaluate(`shortDate('${day(1)}')`) as string); // in date order
    for (let i = 0; i < 3; i++) await expect(list.nth(i)).toContainText('150');
    await expect(page.locator('#tab-register .cu-sum-total')).toContainText('450');
    await expect(page.locator('#tab-register .cu-promo-link')).toHaveCount(0); // no code in this mode
    await expect(page.locator('#reg-waiver-cb')).toHaveCount(1);
    await expect(confirmBtn(page)).toBeDisabled();
    await page.locator('#reg-waiver-cb').check();
    await expect(confirmBtn(page)).toHaveText(/Book .*450/);
    // Change goes back to step one
    await page.locator('#tab-register .cu-rv-head .cu-rv-chg').click();
    expect(await page.evaluate('S.regStep')).toBe(1);
    await page.evaluate('regNextFromSession()');
    expect(await page.evaluate('S.regStep')).toBe(3);
    await confirmBtn(page).click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent.map((c) => (c.p_entries as Record<string, unknown>[])[0].session_id)).toEqual([day(1), day(2), day(3)]);
    for (const c of sent) {
      const e = c.p_entries as Record<string, unknown>[];
      expect(e).toHaveLength(2);
      expect(e.every((r) => r.seat_only === true && r.status === 'waiting' && typeof r.waiver_version === 'string')).toBe(true);
    }
    // the booked moment: how many, and the way to the tickets
    await expect(page.locator('#tab-register .bk-ok-t')).toHaveText('3 dates booked');
    await expect(page.locator('#tab-register .ticket-card')).toHaveCount(0);
    await page.locator('#tab-register .bk-ok-btns .btn-primary').click();
    expect(await page.evaluate('S.custTab')).toBe('myrides');
  });

  test('a date that fails is named in a pop-up with its reason; the others stand', async ({ page }) => {
    await open(page);
    await page.route(/\/rest\/v1\/rpc\/customer_create_booking/, async (route: Route) => {
      const head = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: head });
      const e = (route.request().postDataJSON().p_entries || []) as Record<string, unknown>[];
      if (e[0].session_id === day(2)) return route.fulfill({ status: 400, headers: head, body: JSON.stringify({ code: 'P0001', message: 'PLACE_GONE', details: null, hint: null }) });
      return route.fulfill({ status: 200, headers: head, body: JSON.stringify(e.map((r) => ({ id: r.id, queue_num: r.queue_num, status: r.status, waitlist_num: null, price: r.price }))) });
    });
    const sent = creates(page);
    await page.evaluate(`S._mdt=['${day(1)}','${day(2)}','${day(3)}'];S.selSession='${day(1)}';S.waiverOk=true;S._waiverSess='${day(1)}';${toReview}`);
    await page.evaluate('submitReg()');
    await expect.poll(() => sent.length).toBe(3);
    const dlg = page.locator('.mdt-dlg');
    await expect(dlg).toBeVisible();
    await expect(dlg).toHaveAttribute('role', 'alertdialog');
    await expect(dlg.locator('.modal-title')).toHaveText('These dates were not booked');
    await expect(dlg.locator('li')).toHaveCount(1);
    await expect(dlg.locator('li')).toContainText(await page.evaluate(`shortDate('${day(2)}')`) as string);
    await expect(dlg.locator('li')).toContainText('No places left');
    await expect(page.locator('#tab-register .bk-ok-t')).toHaveText('2 dates booked');
    await dlg.getByRole('button', { name: 'Close' }).click();
    await expect(dlg).toHaveCount(0);
  });

  test('a single booking ends the switch; Edit then Save comes back to step one with it off; stale ticks go', async ({ page }) => {
    const fx = await open(page, N.slice(0, 4), [mine('h1', day(1))]);
    fx['rpc:customer_booking_update'] = true;
    await sw(page).click();
    await row(page, 2).click();
    await page.evaluate(`S.regQty=1;S.regBikeHeights=['175'];S.regBikeTypes=['Road'];S.waiverOk=true;S._waiverSess='${day(2)}';S.regStep=3;renderRegister()`);
    await page.evaluate('submitReg()');
    await expect(page.locator('#tab-register .bk-ok-t')).toBeVisible();
    expect(await page.evaluate('S._mdt')).toBeNull(); // one date booked through the single path: the ticks are gone
    // My Bookings' Edit on the held night, Save from the review: back on step one, the switch off, the rows radios
    await page.evaluate(`_on_renderBookingTicket_1(null,null,'jcc','${day(1)}')`);
    await expect.poll(() => page.evaluate('S.modifyEntryId')).toBe('h1');
    await page.evaluate('S.regStep=3;renderRegister()');
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click(); // Update booking
    await expect.poll(() => page.evaluate('S.regStep')).toBe(1);
    expect(await page.evaluate('S._mdt')).toBeNull();
    await page.locator('#tab-register .cu-w100-mt18').click(); // the updated ticket's Book another ride: step one
    await expect(sw(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(row(page, 3)).toHaveAttribute('role', 'radio');
    // ticks left over that are no longer bookable (the held night) go, and the first one left is the ride read
    await page.evaluate(`S.lastTickets=[];S.selSession=null;S._mdt=['${day(1)}','${day(3)}','${day(4)}'];S.regStep=1;renderRegister()`);
    expect(await page.evaluate('[S._mdt,S.selSession,S.modifyEntryId]')).toEqual([[day(3), day(4)], day(3), null]);
  });

  test('details the account owes, refused on later dates, open their request; saving it books those dates again', async ({ page }) => {
    const fx = await open(page);
    fx['rpc:customer_fix_fields'] = [];
    fx['rpc:customer_fix_save'] = [];
    fx['rpc:customer_profile'] = [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', nationality: 'Jordan', gender: 'male', birth_date: '1990-01-01' }];
    let refuse = true;
    await page.route(/\/rest\/v1\/rpc\/customer_create_booking/, async (route: Route) => {
      const head = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: head });
      const e = (route.request().postDataJSON().p_entries || []) as Record<string, unknown>[];
      if (refuse && e[0].session_id !== day(1)) return route.fulfill({ status: 400, headers: head, body: JSON.stringify({ code: 'P0001', message: 'FIX_FIRST', details: null, hint: null }) });
      return route.fulfill({ status: 200, headers: head, body: JSON.stringify(e.map((r) => ({ id: r.id, queue_num: r.queue_num, status: r.status, waitlist_num: null, price: r.price }))) });
    });
    const sent = creates(page);
    await page.evaluate(`S._mdt=['${day(1)}','${day(2)}','${day(3)}'];S.selSession='${day(1)}';S.waiverOk=true;S._waiverSess='${day(1)}';${toReview}`);
    fx['rpc:customer_fix_fields'] = ['email']; // the server knows of it from here on
    await page.evaluate('submitReg()');
    await expect.poll(() => sent.length).toBe(3);
    await expect(page.locator('#fix-gate .fx-item[data-fx="email"]')).toBeVisible(); // the request, not a sentence
    await expect(page.locator('.mdt-dlg')).toHaveCount(0); // nothing else failed: no list of dates
    await expect(page.locator('#tab-register .bk-ok-t')).toBeVisible(); // the first date stands
    refuse = false;
    fx['rpc:customer_fix_fields'] = [];
    await page.fill('#fx-email', 'new@example.com');
    await page.click('#fx-save');
    await expect.poll(() => sent.length).toBe(5);
    expect(sent.slice(3).map((c) => (c.p_entries as Record<string, unknown>[])[0].session_id)).toEqual([day(2), day(3)]); // those two only
    expect((sent[3].p_entries as Record<string, unknown>[]).map((r) => r.name)).toEqual(['Spec Rider', 'Second Rider']); // the same riders
    await expect(page.locator('#tab-register .bk-ok-t')).toHaveText('2 dates booked');
  });

  test('offline it stops in the centred dialog before anything is sent', async ({ page }) => {
    await open(page);
    const sent = creates(page);
    await page.evaluate(`S._mdt=['${day(1)}','${day(2)}'];S.selSession='${day(1)}';S.waiverOk=true;S._waiverSess='${day(1)}';${toReview}`);
    await page.evaluate(`Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });submitReg()`);
    await expect(page.locator('#confirm-modal .confirm-box')).toBeVisible();
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(0);
  });

  test('Arabic', async ({ page }) => {
    await open(page, N.slice(0, 4), [], 'ar');
    await expect(sw(page)).toHaveText('عدة تواريخ');
    await sw(page).click();
    await row(page, 1).click();
    await row(page, 2).click();
    await expect(page.locator('#tab-register .reg-foot-sum')).toHaveText('تاريخان');
    await row(page, 3).click();
    await expect(page.locator('#tab-register .reg-foot-sum')).toHaveText('3 تواريخ');
  });
});
