import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// A partner company's employee list (2026-10-09, M20): an admin imports the company's CSV on the Petromin page,
// sees each row checked first (new, update, repeated, error), and the Petromin page then says beside each
// registration whether its employee id is on the company's list (corporate_roster, migration 20261009182000).
// And a customer's own activity in their profile, read from the server for that account alone (M21).
const ksaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const NIGHT = addDays(ksaToday(), 1) + '-pw';
const sessions = [{ id: NIGHT, day: 'Wednesday', session_date: addDays(ksaToday(), 1), capacity: 35, status: 'open', ride_kind: 'petromin', bike_slots: '{"_time":"19:00 - 21:00"}' }];
const corporate_roster = [
  { company: 'Petromin', employee_id: 'P100', name: 'Ahmed Ali', active: true },
  { company: 'Petromin', employee_id: 'P200', name: 'Khalid Omar', active: false },
];
const rider_registrations = [
  { id: 1, badge: 'P100', company: 'Petromin', name: 'Ahmed Ali', session_id: NIGHT, booking_no: 'P-001', party_no: 1, updated_at: '2026-10-09T10:00:00Z' },
  { id: 2, badge: 'P200', company: 'Petromin', name: 'Khalid Omar', session_id: NIGHT, booking_no: 'P-002', party_no: 1, updated_at: '2026-10-09T10:01:00Z' },
  { id: 3, badge: 'P999', company: 'Petromin', name: 'Nobody Known', session_id: NIGHT, booking_no: 'P-003', party_no: 1, updated_at: '2026-10-09T10:02:00Z' },
];

async function boot(page: Page, fx: Fixtures) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], staff_options: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@staff:bookings employee lists', () => {
  test('each registration says whether its employee id is on the company list', async ({ page }) => {
    await boot(page, { corporate_roster, rider_registrations });
    await page.evaluate(`setStaffTab('queue');S.queueView='petromin';S.ridersSession='all';renderStaffQueue();renderRiders()`);
    const host = page.locator('#pm-host');
    await expect(host.locator('.iv-roster')).toHaveCount(3);
    await expect(host.locator('tr', { hasText: 'Ahmed Ali' }).locator('.iv-roster')).toHaveText('On the list');
    await expect(host.locator('tr', { hasText: 'Khalid Omar' }).locator('.iv-roster')).toHaveText('Left the list');
    await expect(host.locator('tr', { hasText: 'Nobody Known' }).locator('.iv-roster')).toHaveText('Not on the list');
  });

  test('an import is checked row by row before anything is written, then sent in one call', async ({ page }) => {
    const sent: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/staff_roster_import')) sent.push(r.postData() || ''); });
    await boot(page, { corporate_roster, rider_registrations, 'rpc:staff_roster_import': { added: 2, updated: 1, deactivated: 0, skipped: 0 } });
    await page.evaluate(`setStaffTab('queue');S.queueView='petromin';renderStaffQueue();renderRiders()`);
    await page.locator('#pm-host button', { hasText: 'Import employees' }).click();
    await expect(page.locator('#confirm-modal .rim-dlg')).toBeVisible();
    const csv = ['Employee ID,Name,Mobile,Company', 'P100,Ahmed Ali,0551234567,Petromin', 'P300,Mona-Saad,0557654321,Petromin', 'P300,Mona Saad,,Petromin',
      ',No Id,,Petromin', 'P400,R2 D2,,Petromin', 'P500,Other Person,,Petrolube', 'P600,Fahad Noor,,'].join('\n');
    await page.locator('#confirm-modal input[type=file]').setInputFiles({ name: 'petromin.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.locator('#confirm-modal .rim-sum')).toHaveText('2 new · 1 updates · 1 repeated · 3 errors');
    await expect(page.locator('#confirm-modal tr.rim-err')).toHaveCount(3);
    await expect(page.locator('#confirm-modal tr', { hasText: 'Mona Saad' }).first()).toContainText('New'); // the hyphen is a space: letters and spaces only
    await page.locator('#confirm-modal button', { hasText: 'Import 3' }).click();
    await expect.poll(() => sent.length).toBe(1);
    const body = JSON.parse(sent[0]);
    expect(body.p_company).toBe('Petromin');
    expect(body.p_replace).toBe(false);
    expect(body.p_rows.map((r: { employee_id: string }) => r.employee_id)).toEqual(['P100', 'P300', 'P600']);
    await expect(page.locator('#confirm-modal .rim-dlg')).toHaveCount(0);
  });

  test('without the function the import says the database update is pending', async ({ page }) => {
    await boot(page, { corporate_roster, rider_registrations });
    await page.evaluate(`setStaffTab('queue');S.queueView='petromin';renderStaffQueue();renderRiders();openRosterImport()`);
    await page.locator('#confirm-modal input[type=file]').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from('Employee ID,Name\nP700,Huda Ali') });
    await page.locator('#confirm-modal button', { hasText: 'Import 1' }).click();
    await expect(page.locator('#confirm-modal')).toContainText('Waiting for the database update.');
  });
});

test.describe('@staff:customers activity in the profile', () => {
  const customers = [{ id: 'c1', name: 'Lina Haddad', email: 'lina@example.com', phone: '0551876215', created_at: '2026-06-10T09:00:00Z' }];
  const customer_activity = [
    { id: 9, at: new Date(Date.now() - 60e3).toISOString(), customer_id: 'c1', who: 'Lina Haddad', action: 'signin', origin: 'micromobility.sa', detail: {} },
    { id: 8, at: new Date(Date.now() - 120e3).toISOString(), customer_id: 'c1', who: 'Lina Haddad', action: 'ride_news', origin: 'micromobility.sa', detail: { on: true } },
  ];
  test('the profile reads that customer\'s own lines from the server and links to the full list', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/customer_activity')) asked.push(r.url()); });
    await boot(page, { customers, customer_activity, tags: [], customer_tags: [] });
    await page.evaluate(`openAccountHistory('c1')`);
    await page.locator('#cust-modal button', { hasText: 'Show their activity' }).click();
    await expect(page.locator('#ah-act .ca-row')).toHaveCount(2);
    await expect(page.locator('#ah-act')).toContainText('Signed in');
    const u = new URL(asked[asked.length - 1]);
    expect(u.searchParams.get('customer_id')).toBe('eq.c1');
    expect(u.searchParams.get('limit')).toBe('20');
    // a redraw of the profile keeps the lines
    await page.evaluate(`_ahRender(true)`);
    await expect(page.locator('#ah-act .ca-row')).toHaveCount(2);
    await page.locator('#ah-act button', { hasText: 'See all in Customer activity' }).click();
    await page.waitForFunction(`S.staffTab==='customers'&&S.customersTab==='activity'`);
    await expect.poll(() => asked.some((x) => decodeURIComponent(x).includes('customer_id=in.(c1)'))).toBe(true);
  });

  test('Customer activity asks the server for a date range', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/customer_activity')) asked.push(decodeURIComponent(r.url())); });
    await boot(page, { customers, customer_activity, tags: [], customer_tags: [] });
    await page.evaluate(`S._cactDay='range';S._cactFrom='2026-10-01';S._cactTo='2026-10-05';setStaffTab('customers');setCustomersTab('activity')`);
    await expect.poll(() => asked.some((x) => x.includes('at=gte.2026-10-01T00:00:00+03:00') && x.includes('at=lt.2026-10-06T00:00:00+03:00'))).toBe(true);
  });
});
