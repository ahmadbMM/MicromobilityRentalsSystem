import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Ambassador applications from micromobility.sa/ambassadors land in the staff page (owner,
// 2026-09-24). Approving gives the ambassador a code (a promo code) and opens the welcome message;
// points come from the database; rewards asked for from the card are handed over here. Admin only.

const sessions = [{ id: '2099-05-05', day: 'Tuesday', session_date: '2099-05-05', capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}' }];
const amb = (o: Record<string, unknown>) => ({
  id: 5, created_at: '2099-05-01T09:30:00Z', name: 'Sara Ali', phone: '+966551234567', instagram: 'sara.rides', why: 'I lead the Sunday group ride.',
  lang: 'en', customer_id: null, status: 'pending', code: null, decided_at: null, staff_notes: null, updated_at: '2099-05-01T09:30:00Z', updated_by: 'website', ...o,
});

type Call = { url: string; body: unknown; method: string };
async function open(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions, queue_entries: [], bikes: [], ambassadors: [amb({})], ambassador_redemptions: [],
    'rpc:staff_ambassador_stats': [], 'rpc:staff_ambassador_set': { ok: true, code: 'SARA10', discount: 10 }, ...fixtures,
  });
  await unlockStaff(page);
  const calls: Call[] = [];
  page.on('request', r => {
    if (/\/rest\/v1\/(rpc\/staff_ambassador_set|ambassadors|ambassador_redemptions)(\?|$)/.test(r.url()) && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) {
      let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
      calls.push({ url: decodeURIComponent(r.url()), body, method: r.method() });
    }
  });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('ambassadors')`);
  return calls;
}
const panel = (page: Page) => page.locator('#tab-ambassadors');
const card = (page: Page, id: number) => page.locator(`.amb-row[data-amb-id="${id}"]`);
const dialog = (page: Page) => page.locator('#confirm-modal');

test('it sits under People with applications and rewards waiting; Front Desk does not have it', async ({ page }) => {
  await open(page, {
    ambassadors: [amb({}), amb({ id: 6, phone: '+966551234568', status: 'active', code: 'OMAR10', name: 'Omar Hassan' })],
    ambassador_redemptions: [{ id: 1, created_at: '2099-05-02T10:00:00Z', ambassador_id: 6, item: 'Store kit', points: 1000, status: 'requested', updated_at: '2099-05-02T10:00:00Z', updated_by: 'website' }],
  });
  const item = page.locator('#staff-tab-nav .tab-btn[data-stab="ambassadors"]');
  await expect(item).toHaveClass(/active/);
  await expect(item.locator('.tab-badge')).toHaveText('2');
  await expect(panel(page).locator('[data-amb-filter="pending"]')).toHaveText('To review (1)');
  await expect(panel(page).locator('[data-amb-filter="rewards"]')).toHaveText('Rewards asked (1)');
  await page.evaluate(`S.staffRole='frontdesk';renderStaffTabs();setStaffTab('ambassadors')`);
  await expect(item).toHaveCSS('display', 'none');
  expect(await page.evaluate('S.staffTab')).toBe('queue');
});

test('before the database update it says so, instead of failing', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await page.route(/\/rest\/v1\/ambassadors(\?|$)/, r => r.fulfill({
    status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.ambassadors' in the schema cache" }),
  }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('ambassadors')`);
  await expect(panel(page)).toContainText("isn't set up yet");
});

test('an application shows who applied and why, and the account with that mobile', async ({ page }) => {
  await open(page, { customers: [{ id: 'c9', name: 'Sara Ali', email: 'sara@example.test', phone: '0551234567' }] });
  const c = card(page, 5);
  await expect(c).toContainText('Sara Ali');
  await expect(c).toContainText('To review');
  await expect(c).toContainText('I lead the Sunday group ride.');
  await expect(c.locator('a[href="https://instagram.com/sara.rides"]')).toContainText('@sara.rides');
  await expect(c.locator('a[href="tel:+966551234567"]')).toBeVisible();
  await expect(c.locator('.ca-kv', { hasText: 'Account' })).toContainText('Sara Ali');
});

test('approving suggests a code, refuses a taken one, then opens the welcome message', async ({ page }) => {
  let approved = false;
  const calls = await open(page, { 'rpc:staff_ambassador_set': { ok: false, error: 'code_taken' } });
  await card(page, 5).getByRole('button', { name: 'Approve' }).click();
  await expect(dialog(page).locator('#amb-code')).toHaveValue('SARA10');
  await dialog(page).locator('#amb-code').fill('ab');
  await dialog(page).getByRole('button', { name: 'Approve' }).click();
  await expect(dialog(page).locator('#ws-dlg-err')).toHaveText('Use 3 to 20 letters and numbers.');
  await dialog(page).locator('#amb-code').fill('SARA10');
  await dialog(page).getByRole('button', { name: 'Approve' }).click();
  await expect(dialog(page).locator('#ws-dlg-err')).toHaveText('That code is already in use. Choose another.');
  // Now the database takes it.
  await page.route(/\/rest\/v1\/rpc\/staff_ambassador_set/, r => { approved = true; return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, code: 'SARA20', discount: 15 }) }); });
  await page.route(/\/rest\/v1\/ambassadors\?/, r => r.request().method() === 'GET'
    ? r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([amb(approved ? { status: 'active', code: 'SARA20' } : {})]) })
    : r.fallback());
  await dialog(page).locator('#amb-code').fill('SARA20');
  await dialog(page).getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => calls.filter(c => c.url.includes('staff_ambassador_set')).length).toBe(2);
  expect(calls.filter(c => c.url.includes('staff_ambassador_set'))[1].body).toEqual({ p_id: 5, p_status: 'active', p_code: 'SARA20', p_by: 'Spec Staff' });
  const text = dialog(page).locator('#amb-msg-text');
  await expect(text).toContainText('Hi Sara,');
  await expect(text).toContainText('Your code is SARA20.');
  await expect(text).toContainText('15% off');
  await expect(dialog(page).locator('a.amb-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/966551234567\?text=Hi%20Sara/);
});

test('a refusal of a row action (Reject) is said, not swallowed', async ({ page }) => {
  const calls = await open(page, { 'rpc:staff_ambassador_set': { ok: false, error: 'admin_only' } });
  await card(page, 5).getByRole('button', { name: 'Reject' }).click();
  await expect.poll(() => calls.filter(c => c.url.includes('staff_ambassador_set')).length).toBe(1);
  // no dialog is open for a row's buttons: it used to change nothing and say nothing
  await expect(page.locator('.toast').filter({ hasText: 'Admin only.' })).toBeVisible();
  await expect(card(page, 5)).toHaveAttribute('data-status', 'pending');
});

test('an active ambassador shows their points, and Pause switches the code off', async ({ page }) => {
  const calls = await open(page, {
    ambassadors: [amb({ status: 'active', code: 'SARA10' })],
    'rpc:staff_ambassador_stats': [{ id: 5, code_active: true, earned: 1100, pending: 100, uses: 12, season: 700, redeemed: 500, balance: 600, tier: 0, next: 2000 }],
  });
  await panel(page).locator('[data-amb-filter="active"]').click();
  const c = card(page, 5);
  await expect(c).toContainText('SARA10');
  await expect(c.locator('.ca-kv', { hasText: 'Points' })).toContainText('600 pts');
  await expect(c.locator('.ca-kv', { hasText: 'Earned' })).toContainText('1100 pts');
  await expect(c.locator('.ca-kv', { hasText: 'Uses' })).toContainText('12');
  await expect(c.locator('.ca-kv', { hasText: 'Tier' })).toContainText('Scout');
  await expect(c.locator('.ca-kv', { hasText: 'Code' })).toContainText('On');
  await c.getByRole('button', { name: 'Pause code' }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].body).toEqual({ p_id: 5, p_status: 'paused', p_code: null, p_by: 'Spec Staff' });
});

test('a reward asked for is handed over from the card', async ({ page }) => {
  const calls = await open(page, {
    ambassadors: [amb({ status: 'active', code: 'SARA10' })],
    ambassador_redemptions: [{ id: 3, created_at: '2099-05-02T10:00:00Z', ambassador_id: 5, item: 'Basic workshop service', points: 500, status: 'requested', updated_at: '2099-05-02T10:00:00Z', updated_by: 'website' }],
  });
  await panel(page).locator('[data-amb-filter="rewards"]').click();
  const red = card(page, 5).locator('.amb-red[data-red-id="3"]');
  await expect(red).toContainText('Basic workshop service');
  await expect(red).toContainText('500 pts');
  await red.getByRole('button', { name: 'Handed over' }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].method).toBe('PATCH');
  expect(calls[0].url).toContain('ambassador_redemptions');
  expect(calls[0].body).toEqual({ status: 'given', updated_by: 'Spec Staff' });
});

test('search finds an ambassador by code or a mobile typed the local way', async ({ page }) => {
  await open(page, { ambassadors: [amb({ status: 'active', code: 'SARA10' }), amb({ id: 6, name: 'Omar Hassan', phone: '+966500000006', status: 'active', code: 'OMAR10' })] });
  await panel(page).locator('[data-amb-filter="all"]').click();
  await expect(panel(page).locator('.amb-row')).toHaveCount(2);
  const fold = page.locator('[data-srch="amb"] .srch-btn');
  if (await fold.isVisible()) await fold.click();
  await page.locator('#amb-search-input').fill('omar10');
  await expect(panel(page).locator('.amb-row')).toHaveCount(1);
  await expect(card(page, 6)).toBeVisible();
  await page.locator('#amb-search-input').fill('0551234567');
  await expect(card(page, 5)).toBeVisible();
  await expect(panel(page).locator('.amb-row')).toHaveCount(1);
});

test('in Arabic the section reads right to left', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('cq_lang', 'ar'); localStorage.setItem('cq_lang_pick', '1'); } catch { /* */ } });
  await open(page);
  await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="ambassadors"] .snav-lbl')).toContainText('السفراء');
  await expect(card(page, 5)).toContainText('للمراجعة');
});
