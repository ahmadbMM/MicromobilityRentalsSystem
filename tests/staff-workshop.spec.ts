import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Workshop requests from micromobility.sa/workshop land in the staff page (owner, 2026-09-24).
// Staff confirm each one with a day and time, move the bike through the stages the customer
// follows with their reference, set the final price, and message the customer in the language
// they used on the website.

const sessions = [{ id: '2099-05-05', day: 'Tuesday', session_date: '2099-05-05', capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}' }];
const job = (o: Record<string, unknown>) => ({
  id: 42, created_at: '2099-05-01T09:30:00Z', customer_id: null, name: 'Sara Ali', phone: '+966551234567', email: null,
  service: 'full-service', service_label: 'Full service', price_quoted: 409, parts: [{ id: 'new-brake-pads', label: 'New brake pads', price: 60 }],
  lane: 'dropoff', pickup_address: null, preferred_date: '2099-05-06', preferred_time: '17:00', bike: 'ALVAS DA54 AL',
  notes: 'Brakes squeal at speed', lang: 'en', status: 'new', scheduled_for: null, price_final: null, staff_notes: null,
  updated_at: '2099-05-01T09:30:00Z', updated_by: 'website', ...o,
});

type Write = { method: string; url: string; body: unknown };
async function open(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], workshop_jobs: [job({})], workshop_job_events: [], ...fixtures });
  await unlockStaff(page);
  const writes: Write[] = [];
  page.on('request', r => {
    if (/\/rest\/v1\/workshop_jobs(\?|$)/.test(r.url()) && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) {
      let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
      writes.push({ method: r.method(), url: decodeURIComponent(r.url()), body });
    }
  });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('workshop')`);
  return writes;
}
const panel = (page: Page) => page.locator('#tab-workshop');
const card = (page: Page, id: number) => page.locator(`.ws-row[data-ws-id="${id}"]`);
const dialog = (page: Page) => page.locator('#confirm-modal');

test('it sits under Commerce with the count of new requests, and Front Desk has it too', async ({ page }) => {
  await open(page, { workshop_jobs: [job({}), job({ id: 43 }), job({ id: 44, status: 'confirmed' })] });
  const item = page.locator('#staff-tab-nav .tab-btn[data-stab="workshop"]');
  await expect(item).toHaveClass(/active/);
  await expect(item.locator('.tab-badge')).toHaveText('2');
  await expect(panel(page).locator('[data-ws-filter="new"]')).toHaveText('New (2)');
  await expect(panel(page).locator('[data-ws-filter="booked"]')).toHaveText('Booked (1)');
  await page.evaluate(`S.staffRole='frontdesk';renderStaffTabs();setStaffTab('workshop')`);
  await expect(item).not.toHaveCSS('display', 'none'); // on a phone the rail itself waits behind the burger
  expect(await page.evaluate('S.staffTab')).toBe('workshop');
});

test('before the database update it says so, instead of failing', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await page.route(/\/rest\/v1\/workshop_jobs(\?|$)/, r => r.fulfill({
    status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.workshop_jobs' in the schema cache" }),
  }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('workshop')`);
  await expect(panel(page)).toContainText("isn't set up yet");
});

test('a new request shows what the customer sent, and the account with that mobile', async ({ page }) => {
  await open(page, { customers: [{ id: 'c9', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567' }] });
  const c = card(page, 42);
  await expect(c).toContainText('W-0042');
  await expect(c).toContainText('Sara Ali');
  await expect(c).toContainText('New request');
  await expect(c).toContainText('Full service');
  await expect(c).toContainText('Drop off');
  await expect(c).toContainText('17:00');
  await expect(c).toContainText('+966551234567');
  await expect(c).toContainText('ALVAS DA54 AL');
  await expect(c).toContainText('New brake pads (SAR 60)');
  await expect(c).toContainText('Brakes squeal at speed');
  await expect(c).toContainText('SAR 409');
  await expect(c.locator('.ca-kv', { hasText: 'Account' })).toContainText('Sara Ali');
});

test('confirming sets the day and time, signs it, and offers the confirmation message', async ({ page }) => {
  const writes = await open(page);
  await card(page, 42).getByRole('button', { name: 'Confirm booking' }).click();
  await expect(dialog(page).locator('#ws-d')).toHaveValue('2099-05-06');
  await expect(dialog(page).locator('#ws-t')).toHaveValue('17:00');
  await dialog(page).locator('#ws-t').fill('18:30');
  await dialog(page).getByRole('button', { name: 'Confirm booking' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].method).toBe('PATCH');
  expect(writes[0].url).toContain('id=eq.42');
  expect(writes[0].body).toEqual({ scheduled_for: '2099-05-06T18:30:00+03:00', status: 'confirmed', updated_by: 'Spec Staff' });
  // The message, in the language the customer used, ready for WhatsApp.
  const text = dialog(page).locator('#ws-msg-text');
  await expect(text).toContainText('Hi Sara,');
  await expect(text).toContainText('Your bike service W-0042 (Full service) is booked for');
  await expect(text).toContainText('6 May');
  await expect(text).toContainText('18:30');
  await expect(dialog(page).locator('a.ws-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/966551234567\?text=Hi%20Sara/);
  await dialog(page).locator('#ws-msg-lang').selectOption('ar');
  await expect(text).toContainText('مرحباً Sara،');
  await expect(text).toHaveAttribute('dir', 'rtl');
});

test('a day without a time is refused', async ({ page }) => {
  const writes = await open(page);
  await card(page, 42).getByRole('button', { name: 'Confirm booking' }).click();
  await dialog(page).locator('#ws-t').fill('');
  await dialog(page).getByRole('button', { name: 'Confirm booking' }).click();
  await expect(dialog(page).locator('#ws-dlg-err')).toHaveText('Pick both the day and the time.');
  expect(writes).toHaveLength(0);
});

test('the bike moves through the stages, and Ready sets the price the customer sees', async ({ page }) => {
  const writes = await open(page, { workshop_jobs: [job({ status: 'confirmed', scheduled_for: '2099-05-06T14:00:00Z' })] });
  await panel(page).locator('[data-ws-filter="booked"]').click();
  await card(page, 42).getByRole('button', { name: 'Bike is in' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual({ status: 'in_workshop', updated_by: 'Spec Staff' });
  await panel(page).locator('[data-ws-filter="shop"]').click();
  await card(page, 42).getByRole('button', { name: 'Ready for pickup' }).click();
  await expect(dialog(page).locator('#ws-p')).toHaveValue('409');
  await dialog(page).locator('#ws-p').fill('385');
  await dialog(page).getByRole('button', { name: 'Mark ready' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].body).toEqual({ status: 'ready', price_final: 385, updated_by: 'Spec Staff' });
  await expect(dialog(page).locator('#ws-msg-text')).toContainText('your bike (W-0042) is ready for pickup. The total is SAR 385.');
});

test('a price out of range is refused', async ({ page }) => {
  const writes = await open(page, { workshop_jobs: [job({ status: 'in_workshop' })] });
  await panel(page).locator('[data-ws-filter="shop"]').click();
  await card(page, 42).getByRole('button', { name: 'Ready for pickup' }).click();
  await dialog(page).locator('#ws-p').fill('-5');
  await dialog(page).getByRole('button', { name: 'Mark ready' }).click();
  await expect(dialog(page).locator('#ws-dlg-err')).toContainText('from 0 to 100,000');
  expect(writes).toHaveLength(0);
});

test('Edit keeps staff notes and can clear the time', async ({ page }) => {
  const writes = await open(page, { workshop_jobs: [job({ status: 'confirmed', scheduled_for: '2099-05-06T14:00:00Z' })] });
  await panel(page).locator('[data-ws-filter="booked"]').click();
  await card(page, 42).getByRole('button', { name: 'Edit' }).click();
  await expect(dialog(page).locator('#ws-d')).toHaveValue('2099-05-06');
  await expect(dialog(page).locator('#ws-t')).toHaveValue('17:00'); // 14:00 UTC is 17:00 in Riyadh
  await expect(dialog(page).locator('.ws-delete')).toBeVisible(); // admins may delete spam
  await dialog(page).locator('#ws-d').fill('');
  await dialog(page).locator('#ws-t').fill('');
  await dialog(page).locator('#ws-n').fill('Customer will bring the old chain');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual({ scheduled_for: null, staff_notes: 'Customer will bring the old chain', updated_by: 'Spec Staff' });
});

test('Front Desk cannot delete a request', async ({ page }) => {
  await open(page);
  await page.evaluate(`S.staffRole='frontdesk';renderStaffTabs();setStaffTab('workshop')`);
  await card(page, 42).getByRole('button', { name: 'Edit' }).click();
  await expect(dialog(page).locator('#ws-st')).toBeVisible();
  await expect(dialog(page).locator('.ws-delete')).toHaveCount(0);
});

test('cancelling asks first, then offers the message', async ({ page }) => {
  const writes = await open(page, { workshop_jobs: [job({ lang: 'ar', name: 'سارة علي', service_label: 'صيانة شاملة' })] });
  await card(page, 42).getByRole('button', { name: 'Cancel request' }).click();
  await dialog(page).getByRole('button', { name: 'Cancel request' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual({ status: 'cancelled', updated_by: 'Spec Staff' });
  await expect(dialog(page).locator('#ws-msg-text')).toContainText('تم إلغاء طلب الصيانة W-0042');
  await expect(dialog(page).locator('#ws-msg-lang')).toHaveValue('ar');
});

test('search finds a request by its reference or a mobile typed the local way', async ({ page }) => {
  await open(page, { workshop_jobs: [job({}), job({ id: 7, name: 'Omar Hassan', phone: '+966500000007', status: 'completed' })] });
  await panel(page).locator('[data-ws-filter="all"]').click();
  await expect(panel(page).locator('.ws-row')).toHaveCount(2);
  const fold = page.locator('[data-srch="ws"] .srch-btn'); // a phone folds the search into a button
  if (await fold.isVisible()) await fold.click();
  await page.locator('#ws-search-input').fill('0551234567');
  await expect(panel(page).locator('.ws-row')).toHaveCount(1);
  await expect(card(page, 42)).toBeVisible();
  await page.locator('#ws-search-input').fill('w7');
  await expect(panel(page).locator('.ws-row')).toHaveCount(1);
  await expect(card(page, 7)).toBeVisible();
  await page.locator('#ws-search-input').fill('nobody');
  await expect(panel(page)).toContainText('No request matches your search.');
});

test('History reads the database log in the viewer\'s words', async ({ page }) => {
  await open(page, {
    workshop_jobs: [job({ status: 'confirmed', scheduled_for: '2099-05-06T14:00:00Z' })],
    workshop_job_events: [
      { at: '2099-05-01T09:30:00Z', status: 'new', note: 'requested', by: 'website' },
      { at: '2099-05-01T11:00:00Z', status: 'confirmed', note: 'scheduled 2099-05-06 17:00', by: 'Malik' },
    ],
  });
  await panel(page).locator('[data-ws-filter="booked"]').click();
  await card(page, 42).getByRole('button', { name: 'History' }).click();
  const hist = card(page, 42).locator('.ws-hist');
  await expect(hist).toContainText('Sent from the website');
  await expect(hist).toContainText('Time set to 2099-05-06 17:00');
  await expect(hist).toContainText('by Malik');
  await card(page, 42).getByRole('button', { name: 'Hide history' }).click();
  await expect(hist).toHaveCount(0);
});

test('a failed save says so and leaves the request as it was', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], workshop_jobs: [job({ status: 'confirmed' })] }, { table: 'workshop_jobs', status: 403, once: true });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('workshop')`);
  await panel(page).locator('[data-ws-filter="booked"]').click();
  await card(page, 42).getByRole('button', { name: 'Bike is in' }).click();
  await expect(page.locator('#err-bar-el')).toContainText('did not save'); // the error bar, like every refused write
  await expect(card(page, 42)).toContainText('Booked');
});

test('in Arabic the section reads right to left', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('cq_lang', 'ar'); localStorage.setItem('cq_lang_pick', '1'); } catch { /* */ } });
  await open(page);
  await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="workshop"] .snav-lbl')).toContainText('الورشة');
  await expect(panel(page)).toContainText('طلبات الورشة');
  await expect(card(page, 42)).toContainText('طلب جديد');
});
