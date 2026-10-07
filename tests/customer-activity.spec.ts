import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Customers > Activity (/customers/activity; History's until 2026-10-07): what customers did on the booking app, the
// website and the forms. The database writes the lines (customer_activity, migration
// 20261004160000); the staff page only reads them, newest first, and says each one in words.

const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const T1 = day(3);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', created_at: '2026-06-10T09:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', created_at: '2026-06-11T09:00:00Z' },
];
const customer_activity = [
  { id: 5, at: ago(60e3), customer_id: 'c1', who: 'Lina Haddad', action: 'cancel', origin: 'book.micromobility.sa',
    detail: { sid: T1, date: T1, rider: 'Lina Haddad', status: 'cancelled', reason: 'other', note: 'Traffic' } },
  { id: 4, at: ago(120e3), customer_id: 'c1', who: 'Lina Haddad', action: 'book', origin: 'micromobility.sa',
    detail: { sid: T1, date: T1, title: 'Night ride', rider: 'Maya Haddad', bike: 'Kids', status: 'waiting' } },
  { id: 3, at: ago(180e3), customer_id: 'c1', who: 'Lina Haddad', action: 'signin', origin: 'book.micromobility.sa', detail: {} },
  { id: 2, at: ago(240e3), customer_id: 'c2', who: 'Omar Saleh', action: 'profile', origin: 'server',
    detail: { fields: ['city', 'phone'], ch: { city: [null, 'Jeddah'], phone: ['+966551876216', '+966551876299'] } } },
  { id: 1, at: ago(2 * 864e5), customer_id: null, who: 'Walk Person', action: 'apply_community', origin: null,
    detail: { email: 'walk.person@gmail.com' } },
];

async function staff(page: Page, path = '/') {
  await stubSupabase(page, { customers, customer_activity, sessions: [], queue_entries: [], bikes: [], tags: [], customer_tags: [], staff_options: [] });
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
}
const rows = (page: Page) => page.locator('#cact-host .ca-row');
const at = (page: Page) => new URL(page.url()).pathname;

test.describe('@staff:customers customer activity', () => {
  test('History shows what customers did, in words, newest first, and the name opens the account', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/customer_activity')) asked.push(r.url()); });
    await staff(page);
    await page.evaluate(`setStaffTab('customers')`);
    await page.locator('#tab-customers .filter-pill', { hasText: 'Activity' }).click();
    expect(at(page)).toBe('/customers/activity');
    await expect(rows(page)).toHaveCount(5);
    // Newest first, read as sentences with what they touched.
    await expect(rows(page).nth(0)).toContainText('Cancelled a booking');
    await expect(rows(page).nth(0)).toContainText('Other: “Traffic”');
    await expect(rows(page).nth(1)).toContainText('Booked a ride');
    await expect(rows(page).nth(1)).toContainText('Night ride');
    await expect(rows(page).nth(1)).toContainText('Maya Haddad'); // the rider, when not the account holder
    await expect(rows(page).nth(2)).toContainText('Signed in');
    await expect(rows(page).nth(3)).toContainText('Edited account details');
    await expect(rows(page).nth(3)).toContainText('city: — → Jeddah');
    await expect(rows(page).nth(4)).toContainText('Applied to the community');
    await expect(rows(page).nth(4)).toContainText('walk.person@gmail.com'); // no account: how to reach them
    // The newest page is asked for, newest first, and only the columns drawn.
    expect(asked.length).toBeGreaterThan(0);
    const u = new URL(asked[0]);
    expect(u.searchParams.get('order')).toBe('at.desc,id.desc'); // then by id: lines sharing one time keep their order across pages (2026-10-05)
    expect(u.searchParams.get('limit')).toBe('300');
    expect(u.searchParams.get('select')).toBe('id,at,customer_id,who,action,detail,origin');

    // A category keeps only its own lines.
    await page.locator('#cact-host .filter-pill', { hasText: 'Bookings' }).click();
    await expect(rows(page)).toHaveCount(2);
    await page.locator('#cact-host .filter-pill', { hasText: 'Access' }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Signed in');
    await page.locator('#cact-host .filter-pill', { hasText: 'All' }).first().click();
    await expect(rows(page)).toHaveCount(5);

    // The search reads the name, the words and the details.
    await page.evaluate(`S._srchOpen=Object.assign(S._srchOpen||{},{cact:true});renderCustActivity()`);
    await page.fill('#cact-search', 'omar');
    await expect(rows(page)).toHaveCount(1);
    await page.fill('#cact-search', 'night ride');
    await expect(rows(page)).toHaveCount(1);
    await page.fill('#cact-search', '');
    await expect(rows(page)).toHaveCount(5);

    // The name opens that account's bookings and history.
    await rows(page).nth(3).locator('.ca-who').click();
    await expect(page.locator('#cust-modal .modal-box')).toBeVisible();
    await expect(page.locator('#cust-modal')).toContainText('Omar Saleh');
  });

  test('its address opens the view, the old History address follows it, and History keeps the Action Log', async ({ page }) => {
    await staff(page, '/history/customers');
    await page.waitForFunction(`S.staffTab==='customers'&&S.customersTab==='activity'`);
    expect(at(page)).toBe('/customers/activity');
    await expect(rows(page)).toHaveCount(5);
    await page.evaluate(`setStaffTab('history')`);
    await expect(page.locator('#tab-history .filter-pill', { hasText: 'Customer activity' })).toHaveCount(0);
    await page.locator('#tab-history .filter-pill', { hasText: 'Action Log' }).click();
    expect(at(page)).toBe('/history/log');
    await expect(page.locator('#hist-log-host .lg-h3')).toHaveText('Action Log');
  });

  test('a refused read leaves the view empty and says so, without asking again in a loop', async ({ page }) => {
    await staff(page);
    let n = 0;
    await page.route(/\/rest\/v1\/customer_activity/, (r) => {
      n++;
      return r.fulfill({ status: 401, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42501', message: 'permission denied' }) });
    });
    await page.evaluate(`setStaffTab('customers');setCustomersTab('activity')`);
    await expect(page.locator('#cact-host .lg-empty')).toHaveText('No customer activity yet');
    await page.waitForTimeout(600);
    await page.evaluate(`renderHistory();renderHistory()`);
    await page.waitForTimeout(300);
    expect(n).toBe(1);
  });
});
