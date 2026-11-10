import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Staff edit a locker reservation (the user, 2026-11-10: "allow staff to edit a locker reservation and reschedule it or
// refund it and other options"; migration 20261110200000). The evening, the time, the locker, the name and the account
// go to staff_locker_edit; a dearer change puts the difference in the Sales cart linked to the rental; refunds go to the
// wallet through staff_locker_refund (admins); On the house is staff_locker_house; WhatsApp is a ready message; the till
// names the locker lines it rang up (staff_locker_paid). The money rules are the database's: this is what the screens
// ask and draw. All traffic stubbed; invented data.

const ksaDay = (n = 0) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const TODAY = ksaDay(0), LATER = ksaDay(3);
const jcc = (id: string, date: string, n: number) => ({ id, day: 'Tuesday', session_date: date, capacity: 40, status: 'open', created_at: n, lockers: true, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' });
const sessions = [jcc('s1', TODAY, 1), jcc('s4', LATER, 4)];
const customers = [
  { id: 'c1', name: 'Rana Rider', email: 'rana@example.test', phone: '+966500000021', height: 170, created_at: '2026-01-01T00:00:00Z' },
  { id: 'c2', name: 'Omar Other', email: 'omar@example.test', phone: '+966500000022', height: 180, created_at: '2026-01-02T00:00:00Z' },
];
const queue = [{ id: 'q1', session_id: 's1', session_day: 'Tuesday', session_date: TODAY, queue_num: 1, name: 'Rana Rider', customer_id: 'c1', phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 50, registered_at: '2026-11-09T10:00:00Z' }];
const lockers = ['1', '2', '3'].map((c) => ({ id: 'L' + c, code: c, status: 'available', note: '', created_at: '2026-11-09T09:00:00Z' }));
const rent = (id: string, x: Record<string, unknown>) => ({
  id, day: TODAY, period: 'early', booking_id: null, session_id: 's1', customer_id: null, name: '', locker_id: null, price: 10, on_bill: false,
  status: 'reserved', created_at: '2026-11-09T10:00:00Z', created_by: 'staff', pay: 'desk', receipt_id: null, house: false, refunded: 0, ...x,
});
const rentals = [
  rent('R1', { booking_id: 'q1', customer_id: 'c1', name: 'Rana Rider', on_bill: true, pay: null, period: 'late' }),
  rent('R6', { customer_id: 'c2', name: 'Omar Other', locker_id: 'L2' }),
];

function calls(page: Page) {
  const seen: { name: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (!m || r.method() !== 'POST') return;
    let body = {}; try { body = r.postDataJSON() || {}; } catch { /* none */ }
    seen.push({ name: m[1], body });
  });
  return seen;
}
const sent = (seen: { name: string; body: Record<string, unknown> }[], name: string) => seen.find((c) => c.name === name)?.body;
async function staff(page: Page, fx: Fixtures = {}, role = 'admin') {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions, customers, tags: [], customer_tags: [], queue_entries: queue, bikes: [], staff_options: [],
    'rpc:staff_operator_list': ops, lockers, locker_rentals: rentals, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded&&(S.customers||[]).length>0');
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='${role}';`);
  await page.evaluate(`setStaffTab('lockers');_lkView('reservations')`);
}
const row = (page: Page, name: string) => page.locator('#tab-lockers .lk-res-row', { hasText: name });
const dlg = (page: Page) => page.getByRole('dialog', { name: 'Locker reservation' });

test.describe('@staff:lockers staff edit a reservation', () => {
  test('a later time costs more: the change is sent, and the difference goes to the Sales cart for this rental', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_edit': { ok: true, id: 'R6', day: TODAY, period: 'both', status: 'reserved', code: '2', price: 15, pay: 'desk', due: 5, back: 0 } });
    await row(page, 'Omar Other').getByRole('button', { name: 'Edit' }).click();
    const d = dlg(page);
    await expect(d).toContainText('Omar Other');
    await d.getByRole('button', { name: /6 PM - 11 PM/ }).click();
    await d.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => sent(seen, 'staff_locker_edit')).toBeTruthy();
    expect(sent(seen, 'staff_locker_edit')).toMatchObject({ p_rental: 'R6', p_day: null, p_period: 'both', p_code: null, p_name: null, p_customer: null });
    await expect(page.locator('.toast.info').filter({ hasText: 'SAR 5 more to take: it is in the Sales cart' })).toBeVisible();
    const cart = await page.evaluate(`S._ctCart`) as { lk?: string; price: number; name: string }[];
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({ lk: 'R6', price: 5 });
    expect(cart[0].name).toContain('difference');
    await expect(dlg(page)).toHaveCount(0);
  });

  test('another evening, another locker, another account', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_edit': { ok: true, id: 'R6', day: LATER, period: 'early', status: 'reserved', code: '3', price: 10, due: 0, back: 0 } });
    await row(page, 'Omar Other').getByRole('button', { name: 'Edit' }).click();
    const d = dlg(page);
    // the evenings that offer lockers, from today on
    await d.getByLabel('Evening').selectOption(LATER);
    await d.getByRole('button', { name: 'Locker 3', exact: true }).click();
    await d.getByRole('button', { name: 'Change', exact: true }).click();
    await d.getByLabel('Account').fill('rana');
    await d.getByRole('button', { name: /Rana Rider/ }).click();
    await d.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => sent(seen, 'staff_locker_edit')).toBeTruthy();
    expect(sent(seen, 'staff_locker_edit')).toMatchObject({ p_rental: 'R6', p_day: LATER, p_period: null, p_code: '3', p_customer: 'c1', p_name: 'Rana Rider' });
    await expect(page.locator('#toast-container .toast').filter({ hasText: 'Locker reservation saved' })).toHaveCount(1); // a quiet one: said, not drawn
  });

  test('a ride\'s locker stays with its rider; a door taken that evening cannot be picked', async ({ page }) => {
    await staff(page, { locker_rentals: [...rentals, rent('R7', { customer_id: 'c2', name: 'Omar Other', locker_id: 'L3', period: 'late', status: 'in_use' })] });
    await row(page, 'Rana Rider').getByRole('button', { name: 'Edit' }).click();
    const d = dlg(page);
    await expect(d).toContainText("A ride's locker stays with its rider");
    await expect(d.getByLabel('Account')).toHaveCount(0);
    await expect(d.getByRole('button', { name: /^Locker 3/ })).toBeDisabled(); // R7 has it 9-11 PM
    await expect(d.getByRole('button', { name: 'Locker 1', exact: true })).toBeEnabled();
  });

  test('a change that gives money back is an admin\'s: the refusal is said in words', async ({ page }) => {
    await staff(page, { 'rpc:staff_locker_edit': { __rpcError: { status: 400, code: '42501', message: 'ADMIN_REFUND: 5' } } }, 'frontdesk');
    await row(page, 'Omar Other').getByRole('button', { name: 'Edit' }).click();
    await dlg(page).getByRole('button', { name: /9 PM - 11 PM/ }).click();
    await dlg(page).getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.locator('.toast.error').filter({ hasText: 'back to the wallet: an admin makes it' })).toBeVisible();
    await expect(dlg(page)).toBeVisible(); // nothing changed: the dialog stays
  });

  test('admins refund to the wallet, keeping it free or cancelling it; the reason is asked', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_refund': { ok: true, id: 'R6', amount: 10, balance: 10, kept: true } });
    await page.evaluate(`window._askMoneyReason=async()=>({v:'faulty',txt:'Faulty'})`);
    await row(page, 'Omar Other').getByRole('button', { name: 'Edit' }).click();
    await dlg(page).getByRole('button', { name: 'Refund to wallet, keep it free' }).click();
    await expect.poll(() => sent(seen, 'staff_locker_refund')).toBeTruthy();
    expect(sent(seen, 'staff_locker_refund')).toMatchObject({ p_rental: 'R6', p_keep: true, p_reason: 'faulty' });
    await expect(page.locator('.toast.info').filter({ hasText: 'SAR 10 refunded to the wallet' })).toBeVisible();
  });

  test('front desk sees no refund; On the house is sent with the operator', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_house': { ok: true, id: 'R6', price: 0 } }, 'frontdesk');
    await row(page, 'Omar Other').getByRole('button', { name: 'Edit' }).click();
    const d = dlg(page);
    await expect(d.getByRole('button', { name: /Refund to wallet/ })).toHaveCount(0);
    await d.getByRole('button', { name: 'On the house' }).click();
    await expect.poll(() => sent(seen, 'staff_locker_house')).toBeTruthy();
    expect(sent(seen, 'staff_locker_house')).toMatchObject({ p_rental: 'R6', p_on: true });
  });

  test('WhatsApp opens a ready message to the rider\'s phone, in English and Arabic', async ({ page }) => {
    await staff(page);
    await row(page, 'Omar Other').getByRole('button', { name: 'Edit' }).click();
    const wa = dlg(page).getByRole('link', { name: 'WhatsApp' });
    const href = await wa.getAttribute('href');
    expect(href).toContain('https://wa.me/966500000022?text=');
    const text = decodeURIComponent(String(href).split('text=')[1]);
    expect(text).toContain('your locker 2 is booked');
    expect(text).toContain('خزانتك 2');
  });

  test('a locker line rung up at the till is named to the database once the sale is stored', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_paid': { ok: true, linked: 1 }, cashier_sales: [] });
    await page.evaluate(`(async () => {
      _lkTill('c2', 'Omar Other', [{ p: 'early', code: '2', lk: 'R6' }], false);
      setStaffTab('cashier'); S._ctSession = 's1'; S._ctCustId = 'c2'; S._ctCust = 'Omar Other';
      await _ctRecord();
    })()`);
    await expect.poll(() => sent(seen, 'staff_locker_paid')).toBeTruthy();
    const links = (sent(seen, 'staff_locker_paid') as { p_links: { r: string; l: string }[] }).p_links;
    expect(links).toHaveLength(1);
    expect(links[0].r).toBe('R6');
    expect(links[0].l).toBeTruthy();
  });
});
