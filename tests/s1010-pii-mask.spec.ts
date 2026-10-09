import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Personal data hidden until shown (PDPL Art. 19, migration 20261009220000): phones, emails and birth dates
// read masked on staff screens; a tap on the masked value shows that record's data and records the look
// once (staff_pii_reveal); calling or WhatsApp works without the tap and is recorded; the account editor
// shows everything and records an edit. Invented riders only.

const SID = 's0';
const SESSION = { id: SID, day: 'Friday', session_date: '2099-02-10', capacity: 5, status: 'open', created_at: 1 };
const CUST = { id: 'c1', name: 'Hidden Huda', phone: '0551234567', email: 'huda@example.com', birth_date: '1990-04-02', gender: 'female', created_at: '2026-01-01T00:00:00Z' };
const row = (id: string, num: number, x: Record<string, unknown> = {}) => ({
  id, session_id: SID, session_day: 'Friday', session_date: '2099-02-10', queue_num: num, name: 'Rider ' + id.toUpperCase(),
  phone: '', customer_id: null, group_id: null, status: 'waiting', paid: true, price: 57.5, walk_in: false,
  registered_at: `2099-01-01T10:0${num}:00Z`, type_preference: 'Road', size: 'M', ...x,
});
const ROWS = [
  row('a', 1, { name: 'Hidden Huda', phone: '0551234567', customer_id: 'c1' }),
  row('b', 2, { name: 'Other Omar', phone: '0559876543' }),
];
type Call = { name: string; body: Record<string, unknown> };
function rpcs(page: Page) {
  const calls: Call[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); } });
  return calls;
}
async function boot(page: Page, x: Record<string, unknown> = {}) {
  await stubSupabase(page, { queue_entries: ROWS, sessions: [SESSION], bikes: [], customers: [CUST], 'rpc:staff_pii_reveal': true, ...x });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('${SID}')`);
}
const roster = (page: Page) => page.locator('.queue-table tbody tr, .q-card');

test.describe('@staff:bookings s1010 personal data', () => {
  // The phone card shows no number at all (Call and WhatsApp only); the table is where numbers are read.
  test.beforeEach(({ page: _p }, info) => { test.skip(info.project.name === 'mobile' && !/WhatsApp still/.test(info.title), 'no number on the phone card'); });
  test('the roster shows phones masked, with an accessible name, and no full number in the text', async ({ page }) => {
    await boot(page);
    const huda = roster(page).filter({ hasText: 'Hidden Huda' }).first();
    const m = huda.locator('.pii-m').first();
    await expect(m).toHaveText('05•• ••• 567');
    await expect(m).toHaveAttribute('aria-label', 'Hidden phone number. Tap to show');
    await expect(huda).not.toContainText('0551234567');
    await expect(huda).not.toContainText('55 123 4567');
  });

  test('a tap shows that record only, and the look is recorded once per record for the page', async ({ page }) => {
    await boot(page);
    const calls = rpcs(page);
    const huda = roster(page).filter({ hasText: 'Hidden Huda' }).first();
    await huda.locator('.pii-m').first().click();
    await expect(huda).toContainText('0551234567');
    await expect(roster(page).filter({ hasText: 'Other Omar' }).first().locator('.pii-m')).toHaveCount(1); // the other rider stays hidden
    await expect.poll(() => calls.filter((c) => c.name === 'staff_pii_reveal').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_pii_reveal')!.body).toMatchObject({ p_customer: 'c1', p_booking: 'a', p_via: 'reveal', p_fields: ['phone'] });
    // a repaint keeps it shown, and nothing more is recorded for it
    await page.evaluate('renderStaffQueue()');
    await expect(roster(page).filter({ hasText: 'Hidden Huda' }).first()).toContainText('0551234567');
    await page.evaluate(`_piiReveal(null,'c1','a')`);
    await page.waitForTimeout(300);
    expect(calls.filter((c) => c.name === 'staff_pii_reveal')).toHaveLength(1);
  });

  test('WhatsApp still reaches the full number without a tap, and is recorded', async ({ page }) => {
    await boot(page);
    const calls = rpcs(page);
    const omar = roster(page).filter({ hasText: 'Other Omar' }).first();
    const wa = omar.locator('a[href^="https://wa.me/"]').first();
    await expect(wa).toHaveAttribute('href', /^https:\/\/wa\.me\/966559876543/);
    await wa.click({ modifiers: [] }).catch(() => { /* a new tab the stub answers */ });
    await expect.poll(() => calls.filter((c) => c.name === 'staff_pii_reveal').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_pii_reveal')!.body).toMatchObject({ p_booking: 'b', p_via: 'whatsapp', p_fields: ['phone'] });
    await expect(omar).not.toContainText('0559876543'); // the screen stays masked
  });

  test('the account editor shows the values and records an edit; the account then reads unmasked', async ({ page }) => {
    await boot(page);
    const calls = rpcs(page);
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(page.locator('#cf-email')).toHaveValue('huda@example.com');
    await expect.poll(() => calls.filter((c) => c.name === 'staff_pii_reveal').length).toBe(1);
    const b = calls.find((c) => c.name === 'staff_pii_reveal')!.body;
    expect(b).toMatchObject({ p_customer: 'c1', p_via: 'edit' });
    expect(b.p_fields).toEqual(expect.arrayContaining(['phone', 'email', 'birth_date']));
    await page.evaluate('closeCustFormModal();renderStaffQueue()');
    await expect(roster(page).filter({ hasText: 'Hidden Huda' }).first()).toContainText('0551234567');
  });

  test('the account window masks email and phone; Settings pii_mask off shows everything', async ({ page }) => {
    await boot(page);
    await page.evaluate(`openAccountHistory('c1')`);
    const sub = page.locator('#cust-modal .modal-sub');
    await expect(sub.locator('.pii-m')).toHaveCount(2);
    await expect(sub).toContainText('h•••@example.com');
    await expect(sub).not.toContainText('huda@example.com');
    await page.evaluate(`closeCustomerProfile();S.staffOptions={...(S.staffOptions||{}),biz:{pii_mask:false}};renderStaffQueue()`);
    await expect(roster(page).filter({ hasText: 'Other Omar' }).first()).toContainText('0559876543');
    await expect(page.locator('.pii-m')).toHaveCount(0);
  });

  test('an account with can_see_pii_unmasked sees no mask; before the database update a look goes to the Action Log', async ({ page }) => {
    await boot(page, { 'rpc:staff_pii_reveal': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_pii_reveal in the schema cache' } } });
    const posts: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/staff_actions')) { try { posts.push(r.postDataJSON()); } catch { /* none */ } } });
    await roster(page).filter({ hasText: 'Other Omar' }).first().locator('.pii-m').click();
    await expect.poll(() => posts.filter((p) => /Personal data/.test(String((p as { action?: string }).action || JSON.stringify(p)))).length).toBeGreaterThan(0);
    await page.evaluate(`S._myCaps={can_see_pii_unmasked:true};S._piiOpen=new Set();renderStaffQueue()`);
    await expect(page.locator('.pii-m')).toHaveCount(0);
  });
});
