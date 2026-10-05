import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Messages from micromobility.sa - business enquiries, Help centre questions and job applications - land in the
// staff page (owner, 2026-09-24). Staff reply on WhatsApp or by email (the message is marked as
// replied), keep notes and close it. Admin only.

const sessions = [{ id: '2099-05-05', day: 'Tuesday', session_date: '2099-05-05', capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}' }];
const msg = (o: Record<string, unknown>) => ({
  id: 7, created_at: '2099-05-01T09:30:00Z', kind: 'business', topic: 'fleet-programmes', name: 'Omar Hassan', company: 'Red Sea Hotels',
  email: 'omar@example.test', phone: '+966551234567', message: 'We need 20 bikes\nfor our guests.', lang: 'en', customer_id: null,
  status: 'new', staff_notes: null, updated_at: '2099-05-01T09:30:00Z', updated_by: 'website', ...o,
});

type Write = { method: string; url: string; body: unknown };
async function open(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], site_messages: [msg({})], ...fixtures });
  await unlockStaff(page);
  const writes: Write[] = [];
  page.on('request', r => {
    if (/\/rest\/v1\/site_messages(\?|$)/.test(r.url()) && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) {
      let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
      writes.push({ method: r.method(), url: decodeURIComponent(r.url()), body });
    }
  });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('messages')`);
  return writes;
}
const panel = (page: Page) => page.locator('#tab-messages');
const card = (page: Page, id: number) => page.locator(`.sm-row[data-sm-id="${id}"]`);
const dialog = (page: Page) => page.locator('#confirm-modal');

test('it sits under Website with the count of new messages; Front Desk does not have it', async ({ page }) => {
  await open(page, { site_messages: [msg({}), msg({ id: 8, kind: 'help', topic: 'warranty' }), msg({ id: 9, status: 'closed' })] });
  const item = page.locator('#staff-tab-nav .tab-btn[data-stab="messages"]');
  await expect(item).toHaveClass(/active/);
  await expect(item.locator('.tab-badge')).toHaveText('2');
  await expect(panel(page).locator('[data-sm-filter="new"]')).toHaveText('New (2)');
  await expect(panel(page).locator('[data-sm-filter="closed"]')).toHaveText('Closed (1)');
  await page.evaluate(`S.staffRole='frontdesk';renderStaffTabs();setStaffTab('messages')`);
  await expect(item).toHaveCSS('display', 'none');
  expect(await page.evaluate('S.staffTab')).toBe('queue');
});

test('before the database update it says so, instead of failing', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await page.route(/\/rest\/v1\/site_messages(\?|$)/, r => r.fulfill({
    status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.site_messages' in the schema cache" }),
  }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('messages')`);
  await expect(panel(page)).toContainText("aren't set up yet");
});

test('a message shows who sent it, what about, the text, and the account', async ({ page }) => {
  await open(page, { customers: [{ id: 'c9', name: 'Omar Hassan', email: 'omar@example.test', phone: '0551234567' }] });
  const c = card(page, 7);
  await expect(c).toContainText('M-0007');
  await expect(c).toContainText('Omar Hassan');
  await expect(c).toContainText('Red Sea Hotels');
  await expect(c).toContainText('Business enquiry');
  await expect(c).toContainText('Fleet programmes');
  await expect(c.locator('.sm-text')).toHaveText('We need 20 bikes\nfor our guests.');
  await expect(c.locator('a[href="mailto:omar@example.test"]')).toBeVisible();
  await expect(c.locator('a[href="tel:+966551234567"]')).toBeVisible();
  await expect(c.locator('.ca-kv', { hasText: 'Account' })).toContainText('Omar Hassan');
});

test('Reply opens a frame in the sender\'s language; sending it marks the message replied', async ({ page }) => {
  const writes = await open(page, { site_messages: [msg({ lang: 'ar', name: 'سارة علي', kind: 'help', topic: 'warranty', company: null })] });
  await expect(card(page, 7)).toContainText('Warranty');
  await card(page, 7).getByRole('button', { name: 'Reply', exact: true }).click();
  const text = dialog(page).locator('#sm-reply-text');
  await expect(text).toHaveValue(/^مرحباً سارة،/);
  await expect(text).toHaveValue(/M-0007/);
  await expect(dialog(page).locator('#sm-reply-lang')).toHaveValue('ar');
  await text.fill('Hi Sara,\n\nYes, wheels are not covered.\n\nMicromobility team');
  await expect(dialog(page).locator('a.sm-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/966551234567\?text=Hi%20Sara%2C%0A%0AYes%2C%20wheels/);
  await expect(dialog(page).locator('a.sm-mail')).toHaveAttribute('href', /^mailto:omar%40example\.test\?subject=/);
  // Following the link opens WhatsApp in a new tab; the page marks the message replied.
  const popup = page.waitForEvent('popup').catch(() => null);
  await dialog(page).locator('a.sm-wa').click();
  await popup;
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].method).toBe('PATCH');
  expect(writes[0].url).toContain('id=eq.7');
  expect(writes[0].body).toEqual({ status: 'replied', updated_by: 'Spec Staff' });
});

test('switching the reply language swaps an untouched frame', async ({ page }) => {
  await open(page);
  await card(page, 7).getByRole('button', { name: 'Reply', exact: true }).click();
  const text = dialog(page).locator('#sm-reply-text');
  await expect(text).toHaveValue(/^Hi Omar,/);
  await dialog(page).locator('#sm-reply-lang').selectOption('ar');
  await expect(text).toHaveValue(/^مرحباً Omar،/);
  await expect(text).toHaveAttribute('dir', 'rtl');
});

test('Mark replied, Close and Reopen move the message', async ({ page }) => {
  const writes = await open(page);
  await card(page, 7).getByRole('button', { name: 'Mark replied' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual({ status: 'replied', updated_by: 'Spec Staff' });
  await panel(page).locator('[data-sm-filter="replied"]').click();
  await card(page, 7).getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].body).toEqual({ status: 'closed', updated_by: 'Spec Staff' });
  await panel(page).locator('[data-sm-filter="closed"]').click();
  await card(page, 7).getByRole('button', { name: 'Reopen' }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2].body).toEqual({ status: 'new', updated_by: 'Spec Staff' });
});

test('notes are saved, and admins can delete spam', async ({ page }) => {
  const writes = await open(page);
  await card(page, 7).getByRole('button', { name: 'Notes' }).click();
  await expect(dialog(page).locator('.sm-delete')).toBeVisible();
  await dialog(page).locator('#sm-n').fill('Called back, sending a quote Sunday');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual({ staff_notes: 'Called back, sending a quote Sunday', updated_by: 'Spec Staff' });
  await expect(card(page, 7)).toContainText('Called back, sending a quote Sunday');
  // Delete: the stub answers a DELETE with no rows, so answer it the way the database does.
  await page.route(/\/rest\/v1\/site_messages\?id=eq\.7/, r => r.request().method() === 'DELETE'
    ? r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ id: 7 }]) })
    : r.fallback());
  await card(page, 7).getByRole('button', { name: 'Notes' }).click();
  await dialog(page).locator('.sm-delete').click();
  await dialog(page).getByRole('button', { name: 'Delete message' }).click();
  await expect(card(page, 7)).toHaveCount(0);
  await expect(page.locator('.toast').last()).toContainText('M-0007 deleted');
});

test('the From filter and search narrow the list', async ({ page }) => {
  await open(page, { site_messages: [msg({}), msg({ id: 8, kind: 'help', topic: 'faq', name: 'Sara Ali', company: null, email: 'sara@example.test', phone: null, message: 'Where are you?' })] });
  await expect(panel(page).locator('.sm-row')).toHaveCount(2);
  await panel(page).locator('.filter-toggle').click();
  await page.locator('#sm-kind').selectOption('help');
  await expect(panel(page).locator('.sm-row')).toHaveCount(1);
  await expect(card(page, 8)).toBeVisible();
  await page.locator('#sm-kind').selectOption('all');
  const fold = page.locator('[data-srch="sm"] .srch-btn');
  if (await fold.isVisible()) await fold.click();
  await page.locator('#sm-search-input').fill('0551234567');
  await expect(panel(page).locator('.sm-row')).toHaveCount(1);
  await expect(card(page, 7)).toBeVisible();
  await page.locator('#sm-search-input').fill('red sea');
  await expect(card(page, 7)).toBeVisible();
  await page.locator('#sm-search-input').fill('m8');
  await expect(card(page, 8)).toBeVisible();
  await expect(panel(page).locator('.sm-row')).toHaveCount(1);
});

test('job applications from About arrive as their own kind, with the role', async ({ page }) => {
  await open(page, { site_messages: [msg({}),
    msg({ id: 10, kind: 'jobs', topic: 'ride-captain', name: 'Sara Ali', company: null, message: 'Three years leading group rides.' }),
    msg({ id: 11, kind: 'jobs', topic: 'general', name: 'Omar Said', company: null, message: 'Any role in the workshop.' })] });
  await expect(card(page, 10)).toContainText('Job application');
  await expect(card(page, 10)).toContainText('Ride captain');
  await expect(card(page, 11)).toContainText('Any role');
  await panel(page).locator('.filter-toggle').click();
  await page.locator('#sm-kind').selectOption('jobs');
  await expect(panel(page).locator('.sm-row')).toHaveCount(2);
  await expect(card(page, 7)).toHaveCount(0);
});

test('a failed save says so and leaves the message as it was', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], site_messages: [msg({})] }, { table: 'site_messages', status: 403, once: true });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('messages')`);
  await card(page, 7).getByRole('button', { name: 'Mark replied' }).click();
  await expect(page.locator('#err-bar-el')).toContainText('did not save'); // the error bar, like every refused write
  await expect(card(page, 7)).toContainText('New');
});

test('in Arabic the section reads right to left', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('cq_lang', 'ar'); localStorage.setItem('cq_lang_pick', '1'); } catch { /* */ } });
  await open(page);
  await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="messages"] .snav-lbl')).toContainText('الرسائل');
  await expect(panel(page)).toContainText('رسائل micromobility.sa');
  await expect(card(page, 7)).toContainText('طلب شركات');
});
