import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, goStaffTab } from './helpers/supabase';
import { readFileSync } from 'node:fs';

// Volunteers, the staff review of 2026-11-06 part 2 (migration 20261107131000): Message team, Invite, the application and
// availability, the certificate with a check code, one call for many, the shift outbox, the view with the account,
// Volunteers in Analytics. Every new function is absent in the stub unless a test names it (tests/helpers/supabase.ts).
const SID = '2099-11-05-bd'; // a Thursday
const session = { id: SID, session_date: '2099-11-05', day: 'Thursday', status: 'open', capacity: 500, created_at: 1, event_kind: 'community', ride_kind: 'blood', needs_approval: false, hide_queue: true, spots: 500, open_to_all: true, bike_slots: '{"_time":"17:00 - 23:00"}' };
const past = { ...session, id: '2026-10-20-bd', session_date: '2026-10-20', day: 'Tuesday' };
const future = '2099-11-05T20:00:00+00:00';
const customers = [
  { id: 'c1', name: 'Sara Haddad', phone: '+966500000001', email: 'sara@example.com', created_at: '2026-01-01', birth_date: '1990-01-01' },
  { id: 'c2', name: 'Omar Saleh', phone: '+966500000002', email: 'omar@example.com', created_at: '2026-01-02', birth_date: '2090-01-01' },
  { id: 'c3', name: 'Nora Ali', phone: '+966500000003', email: 'nora@example.com', created_at: '2026-01-03' },
  { id: 'c4', name: 'Huda Fares', phone: '+966500000004', email: 'huda@example.com', created_at: '2026-01-04', gender: 'female' },
];
const AG = { agreed_version: '2026-11-05', agreed_at: '2026-11-01T10:00:00Z' };
const volunteers = [
  { customer_id: 'c1', status: 'active', tags: [], auto_accept: false, ...AG, days: [4], skills: null, whatsapp: null, created_at: '2026-11-01T10:00:00Z' },
  { customer_id: 'c2', status: 'active', tags: [], auto_accept: false, days: [], skills: null, whatsapp: '+966511111111', created_at: '2026-11-02T10:00:00Z' },
  { customer_id: 'c3', status: 'applied', tags: [], auto_accept: false, days: [5, 6], skills: 'First aid', whatsapp: null, created_at: '2026-11-03T10:00:00Z' },
  { customer_id: 'c4', status: 'active', tags: [], auto_accept: false, ...AG, days: [4, 5], skills: 'Arabic', whatsapp: null, created_at: '2026-11-03T10:00:00Z' },
];
const shifts = [
  { id: 1, session_id: SID, customer_id: 'c1', status: 'accepted', role: null, clock_in: null, clock_out: null, briefed_at: '2026-11-04T10:00:00Z', reminded_at: null, created_at: '2026-11-01T10:00:00Z' },
  { id: 2, session_id: SID, customer_id: 'c2', status: 'accepted', role: null, clock_in: null, clock_out: null, briefed_at: null, reminded_at: null, created_at: '2026-11-02T10:00:00Z' },
  { id: 3, session_id: past.id, customer_id: 'c2', status: 'no_show', clock_in: null, clock_out: null, briefed_at: null, reminded_at: null, created_at: '2026-10-01T10:00:00Z' },
];
const switched = { session_id: SID, enabled: true, closes_at: future, opens_at: null, needed: 5, about: 'Help', briefing: 'Gate 3', signup_open: true, caps: { checkin: true }, hours_mode: 'clock', roles: [], min_age: 18 };
const pastSw = { ...switched, session_id: past.id, closes_at: '2026-10-21T20:00:00+00:00' };
const hours = [{ id: 9, customer_id: 'c1', session_id: past.id, hours: 3.5, worked_on: '2026-10-20', source: 'session', note: null, added_by: 'Admin One' }];
const fx = (x: Record<string, unknown> = {}) => ({
  sessions: [session, past], customers, queue_entries: [], volunteers, volunteer_sessions: [switched, pastSw], volunteer_shifts: shifts, volunteer_hours: hours,
  volunteer_settings: [{ data: { agreement_v: '2026-11-05' } }], volunteer_log: [], ...x,
});
async function staff(page: Page, x: Record<string, unknown> = {}) {
  await page.context().route(/^https:\/\/wa\.me\//, (r) => r.fulfill({ status: 200, body: '' }));
  await stubSupabase(page, fx(x));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await goStaffTab(page, 'volunteers');
  await expect(page.locator('#tab-volunteers .page-title')).toBeVisible();
}
function rpcs(page: Page, name: string): Record<string, unknown>[] {
  const sent: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (new RegExp(`/rpc/${name}$`).test(r.url().split('?')[0])) sent.push(r.postDataJSON()); });
  return sent;
}
const row = (page: Page, id: string) => page.locator(`#vd-list .vd-row[data-cust="${id}"]`);
const acts = (page: Page) => page.locator('#tab-volunteers .vd-acts');
const dlg = (page: Page) => page.locator('#confirm-modal .vm-dlg');
const tab = (page: Page, name: string | RegExp) => page.locator('#tab-volunteers .vx-tabs').getByRole('button', { name, exact: typeof name === 'string' });
// A row's ⋯ menu (the rest of its actions since the rebuild of 2026-11-09), then the item.
async function menu(page: Page, host: ReturnType<Page['locator']>, item: string) {
  await host.locator('.rq-more').first().click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test.describe('@staff:volunteers Volunteers, review part 2', () => {
  test('a shift row says what staff need to know: no agreement, under age, first time, briefed', async ({ page }) => {
    await staff(page);
    await expect(row(page, 'c1')).toContainText('Briefed');
    await expect(row(page, 'c1')).not.toContainText('Agreement not accepted');
    await expect(row(page, 'c1')).not.toContainText('First time'); // hours on an earlier session
    await expect(row(page, 'c2')).toContainText('Agreement not accepted');
    await expect(row(page, 'c2')).toContainText('Under the minimum age');
    await expect(row(page, 'c2')).toContainText('First time');
    await expect(row(page, 'c2')).not.toContainText('Briefed');
  });

  test('Message team: one by one on WhatsApp with the briefing, each marked as sent', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_reminded');
    await staff(page, { 'rpc:staff_volunteer_reminded': { ok: true, n: 1 } });
    await acts(page).getByRole('button', { name: 'Message team' }).click();
    await expect(dlg(page).locator('.vm-res-row')).toHaveCount(2);
    const link = dlg(page).locator('.vm-res-row[data-cust="c2"] a');
    const href = decodeURIComponent((await link.getAttribute('href')) || '');
    expect(href).toContain('https://wa.me/966511111111'); // the WhatsApp number given on the portal
    expect(href).toContain('Gate 3');
    expect(href).toContain('17:00');
    const pop = page.waitForEvent('popup');
    await dlg(page).getByRole('button', { name: /Send the next one \(2 left\)/ }).click();
    await (await pop).close();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ p_session: SID, p_customers: ['c2'] }); // by name: Omar before Sara
    await expect(dlg(page).getByRole('button', { name: /\(1 left\)/ })).toBeVisible();
    await expect(dlg(page).locator('.vm-res-row[data-cust="c2"]')).toContainText('Reminded');
  });

  test('without the database change a reminder is kept on the device', async ({ page }) => {
    await staff(page);
    await acts(page).getByRole('button', { name: 'Message team' }).click();
    const pop = page.waitForEvent('popup');
    await dlg(page).getByRole('button', { name: /Send the next one/ }).click();
    await (await pop).close();
    await expect(dlg(page).locator('.vm-res-row[data-cust="c2"]')).toContainText('Reminded');
    await page.locator('#confirm-modal .x-close').click();
    await expect(row(page, 'c2')).toContainText('Reminded');
  });

  test('Invite lists the agreed volunteers free that weekday and not on the session', async ({ page }) => {
    await staff(page);
    await acts(page).getByRole('button', { name: 'Invite' }).click();
    await expect(dlg(page)).toContainText('Free that day (1)');
    const r = dlg(page).locator('.vm-res-row[data-cust="c4"]');
    await expect(r).toContainText('Huda Fares');
    await expect(r).toContainText('Arabic');
    expect(decodeURIComponent((await r.locator('a').getAttribute('href')) || '')).toContain('volunteer.micromobility.sa/#o/' + SID);
    await expect(dlg(page).locator('.vm-res-row[data-cust="c1"]')).toHaveCount(0); // already on it
    await expect(dlg(page).locator('.vm-res-row[data-cust="c3"]')).toHaveCount(0); // applied, not active
  });

  test('applications: their own page, with Approve', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_save');
    await staff(page, { 'rpc:staff_volunteer_save': { ok: true } });
    await tab(page, /Applications/).click();
    const r = page.locator('#va-list .vx-app[data-cust="c3"]');
    await expect(r).toContainText('First aid');
    await r.getByRole('button', { name: /^Approve ·/ }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ p_customer: 'c3', p_status: 'active' });
  });

  test('availability: weekdays, skills and WhatsApp are edited in the volunteer\'s dialog', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_profile_save');
    await staff(page, { 'rpc:staff_volunteer_profile_save': { ok: true } });
    await tab(page, 'People').click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal .n6w-day[value="6"]').check();
    await page.locator('#n6w-skills').fill('Photos');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Save availability' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ p_customer: 'c1', p_days: [4, 6], p_skills: 'Photos', p_whatsapp: '' });
  });

  test('a certificate for a period, with its serial and check code; before the database, the old one prints', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_cert_issue');
    const cert = { ok: true, id: 1, serial: 'MMV-2026-00001', code: 'ABCDEF123456', name: 'Sara Haddad', from: '2026-10-01', to: '2026-10-31', hours: 3.5, sessions: [{ title: 'Blood Donation', date: '2026-10-20', hours: 3.5 }], issued_at: '2026-11-06T10:00:00Z' };
    await staff(page, { 'rpc:staff_volunteer_cert_issue': cert, volunteer_certs: [] });
    await page.evaluate(`window._openReport=(h)=>{window.__rep=h;return {};}`);
    await tab(page, 'People').click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Certificate' }).click();
    await expect(page.locator('#n6w-cf')).toHaveValue('2026-10-20'); // from the first hours
    await page.locator('#n6w-cf').fill('2026-10-01');
    await page.locator('#n6w-ct').fill('2026-10-31');
    await page.locator('#confirm-modal .ss-form-acts').getByRole('button', { name: 'Make the certificate' }).click();
    await expect.poll(() => sent.length).toBe(1);
    // p_gender rides along, empty here: c1's account says nothing and staff left the choice alone.
    expect(sent[0]).toEqual({ p_customer: 'c1', p_from: '2026-10-01', p_to: '2026-10-31', p_gender: null });
    await expect.poll(() => page.evaluate('window.__rep||""')).toContain('MMV-2026-00001');
    const html = await page.evaluate('window.__rep') as string;
    // The design (certificate/SPEC.md, and certificate/README.md for what the owner has changed):
    // the code is a second line under the certificate's number, and the period stands where an
    // event's name goes. Nothing says where the code is answered any more.
    expect(html).toContain('ABCDEF123456');
    expect(html).toContain('1 October 2026 – 31 October 2026');
    expect(html).toContain('Sara Haddad');
    expect(html).toContain('Ahmad Babalghoum');
    expect(html).not.toContain('Power your path');
    expect(html).not.toContain('micromobility.com.sa');
    expect(html).not.toContain('{{'); // every placeholder filled
  });

  test('a certificate for one event: the session is named on it, and its own day is the date', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_cert_issue_session');
    const cert = { ok: true, id: 2, kind: 'session', serial: 'MMV-2026-00002', code: 'ZZZZ11112222', name: 'Sara Haddad', name_ar: 'سارة حداد',
      gender: 'female', session_id: '2026-10-20-bd', initiative: 'Blood Donation', event_date: '2026-10-20', from: '2026-10-20', to: '2026-10-20',
      hours: 3.5, sessions: [], issued_at: '2026-11-08T10:00:00Z' };
    await staff(page, { 'rpc:staff_volunteer_cert_issue_session': cert, volunteer_certs: [] });
    await page.evaluate(`window._openReport=(h)=>{window.__rep=h;return {};}`);
    await tab(page, 'People').click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Certificate' }).click();
    // The sessions this volunteer has hours on, one Make each.
    const row = page.locator('#n6w-cert-sess .vm-res-row').first();
    await expect(row).toContainText('3.5'); // the hours the ledger holds for that session
    await row.getByRole('button', { name: 'Make the certificate' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_customer).toBe('c1');
    expect(sent[0].p_session).toBe('2026-10-20-bd');
    expect(String(sent[0].p_initiative || '')).not.toBe(''); // the session as the app names it on screen
    // _vcPrint reads the template before it opens the window, so the sheet lands a tick after the call.
    await expect.poll(() => page.evaluate('window.__rep||""')).toContain('MMV-2026-00002');
    const html = await page.evaluate('window.__rep') as string;
    expect(html).toContain('Blood Donation');
    expect(html).toContain('20 October 2026');
    expect(html).toContain('سارة حداد');
    expect(html).toContain('تقديرًا لعطائها ومشاركتها التطوعية في المبادرة'); // she, not he
    expect(html).not.toContain('{{');
  });

  test('a script the host adds to the template never reaches the certificate window', async ({ page }) => {
    // What Cloudflare Pages put into the template in production (2026-11-08), byte for byte but the token.
    const beacon = `<!-- Cloudflare Pages Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "test"}'></script><!-- Cloudflare Pages Analytics -->`;
    await staff(page);
    let injected = 0;
    await page.route('**/assets/certificate.html*', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace('</body>', `${beacon}</body>`);
      if (body.includes('cloudflareinsights')) injected++;
      await route.fulfill({ response: res, body });
    });
    await page.evaluate(`window._openReport=(h)=>{window.__rep=h;return {};}`);
    await tab(page, 'People').click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Certificate' }).click();
    await page.locator('#confirm-modal .ss-form-acts').getByRole('button', { name: 'Make the certificate' }).click();
    await expect.poll(() => page.evaluate('window.__rep||""')).toContain('Sara Haddad');
    const html = await page.evaluate('window.__rep') as string;
    expect(injected, 'the beacon was never put into the template, so this proves nothing').toBeGreaterThan(0);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('cloudflareinsights');
    expect(html).toContain('</body>'); // the rest of the page is untouched
  });

  test('before the database has certificates, Make prints the certificate as before', async ({ page }) => {
    await staff(page);
    await page.evaluate(`window._openReport=(h)=>{window.__rep=h;return {};}`);
    await tab(page, 'People').click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Certificate' }).click();
    await page.locator('#confirm-modal .ss-form-acts').getByRole('button', { name: 'Make the certificate' }).click();
    await expect.poll(() => page.evaluate('window.__rep||""')).toContain('Certificate of Volunteering');
    const html = await page.evaluate('window.__rep') as string;
    expect(html).toContain('Sara Haddad');
    expect(html).not.toContain('MMV-'); // no row was made, so there is no serial and nothing to check
  });

  test('the gender is asked only when the account has none, and both languages follow it', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_cert_issue');
    const cert = { ok: true, id: 3, kind: 'period', serial: 'MMV-2026-00003', code: 'GGGG11112222', name: 'Sara Haddad', gender: 'female',
      words: { lead: 'This certificate is proudly presented to', recognition: 'in recognition of her time, energy and commitment as a volunteer in',
               arabic_line: 'تقديرًا لعطائها ومشاركتها التطوعية في المبادرة' },
      from: '2026-10-01', to: '2026-10-31', hours: 3.5, sessions: [], issued_at: '2026-11-08T10:00:00Z' };
    await staff(page, { 'rpc:staff_volunteer_cert_issue': cert, volunteer_certs: [] });
    await page.evaluate(`window._openReport=(h)=>{window.__rep=h;return {};}`);
    await tab(page, 'People').click();
    // c4 has a gender on the account: nothing to ask.
    await page.locator('#vm-list .vm-row[data-cust="c4"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Certificate' }).click();
    await expect(page.locator('#n6w-cg')).toHaveCount(0);
    await page.locator('#confirm-modal').getByRole('button', { name: 'Close' }).first().click().catch(() => page.keyboard.press('Escape'));
    // c1 has none, so staff say who it is for, and what they say goes with the certificate.
    await tab(page, 'People').click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Certificate' }).click();
    await expect(page.locator('#n6w-cg')).toBeVisible();
    await page.locator('#n6w-cg').selectOption('female');
    await page.locator('#confirm-modal .ss-form-acts').getByRole('button', { name: 'Make the certificate' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_gender).toBe('female');
    await expect.poll(() => page.evaluate('window.__rep||""')).toContain('MMV-2026-00003');
    const html = await page.evaluate('window.__rep') as string;
    expect(html).toContain('in recognition of her time, energy and commitment as a volunteer in');
    expect(html).toContain('تقديرًا لعطائها ومشاركتها التطوعية في المبادرة');
    expect(html).not.toContain('their time');
  });

  test('one day instead of a period: one date is asked for, and the day is what it says', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_cert_issue');
    const cert = { ok: true, id: 5, kind: 'period', serial: 'MMV-2026-00005', code: 'DDDD11112222', name: 'Sara Haddad',
      from: '2026-10-20', to: '2026-10-20', hours: 3.5, sessions: [], issued_at: '2026-11-08T10:00:00Z' };
    await staff(page, { 'rpc:staff_volunteer_cert_issue': cert, volunteer_certs: [] });
    await page.evaluate(`window._openReport=(h)=>{window.__rep=h;return {};}`);
    await tab(page, 'People').click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Certificate' }).click();
    await expect(page.locator('#n6w-cf')).toBeVisible();
    await page.locator('#n6w-cm').selectOption('day');
    await expect(page.locator('#n6w-cf')).toBeHidden(); // one date is all it asks for
    await expect(page.locator('#n6w-ct-t')).toHaveText('Day');
    await page.locator('#n6w-ct').fill('2026-10-20');
    await page.locator('#confirm-modal .ss-form-acts').getByRole('button', { name: 'Make the certificate' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_customer: 'c1', p_from: '2026-10-20', p_to: '2026-10-20' });
    await expect.poll(() => page.evaluate('window.__rep||""')).toContain('MMV-2026-00005');
    const html = await page.evaluate('window.__rep') as string;
    // The green box says the day once, not "20 October 2026 - 20 October 2026".
    expect(html).toContain('20 October 2026');
    expect(html).not.toContain('20 October 2026 – 20 October 2026');
  });

  test('a certificate staff write themselves: their wording, and no account needed', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_cert_issue_custom');
    const cert = { ok: true, id: 4, kind: 'custom', serial: 'MMV-2026-00004', code: 'CUST11112222', name: 'Fahad Al-Harbi', name_ar: 'فهد الحربي',
      gender: 'male', initiative: 'Ride marshal training', event_date: '2026-11-08', from: '2026-11-08', to: '2026-11-08', hours: null, sessions: [],
      words: { lead: 'With our thanks', recognition: 'in recognition of his time, energy and commitment as a volunteer in',
               arabic_line: 'تقديرًا لعطائه ومشاركته التطوعية في المبادرة' },
      issued_at: '2026-11-08T10:00:00Z' };
    await staff(page, { 'rpc:staff_volunteer_cert_issue_custom': cert, volunteer_certs: [] });
    await page.evaluate(`window._openReport=(h)=>{window.__rep=h;return {};}`);
    await tab(page, 'People').click();
    // From the roster itself, for somebody who has no account here at all.
    await page.getByRole('button', { name: 'Write a certificate' }).click();
    await page.locator('#n6w-xn').fill('Fahad Al-Harbi');
    await page.locator('#n6w-xa').fill('فهد الحربي');
    await page.locator('#n6w-xi').fill('Ride marshal training');
    // The lines are prefilled for the gender chosen, and picking one rewrites the two that name it.
    await expect(page.locator('#n6w-xr')).toHaveValue(/their time/);
    await page.locator('#n6w-xg').selectOption('male');
    await expect(page.locator('#n6w-xr')).toHaveValue(/his time/);
    await page.locator('#n6w-xl').fill('With our thanks'); // and any of them may be rewritten
    await page.locator('#confirm-modal .ss-form-acts').getByRole('button', { name: 'Make the certificate' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_name: 'Fahad Al-Harbi', p_name_ar: 'فهد الحربي', p_initiative: 'Ride marshal training',
      p_gender: 'male', p_lead: 'With our thanks', p_customer: null });
    expect(String(sent[0].p_recognition)).toContain('his time');
    await expect.poll(() => page.evaluate('window.__rep||""')).toContain('MMV-2026-00004');
    const html = await page.evaluate('window.__rep') as string;
    expect(html).toContain('With our thanks');
    expect(html).toContain('Ride marshal training');
    expect(html).toContain('فهد الحربي');
    expect(html).toContain('Ahmad Babalghoum'); // the signatory is still the design's
    expect(html).not.toContain('{{');
    // It belongs to nobody, so the form that made it is where it can be found again.
    await expect(page.locator('#n6w-xcerts')).toBeVisible();
  });

  test('many at once: one call for the check-in, one for the hours', async ({ page }) => {
    const many = rpcs(page, 'staff_volunteer_shift_times_many'), one = rpcs(page, 'staff_volunteer_shift_times');
    const hrs = rpcs(page, 'staff_volunteer_hours_add_many'), hr1 = rpcs(page, 'staff_volunteer_hours_add');
    await staff(page, { 'rpc:staff_volunteer_shift_times_many': { ok: true, n: 2, failed: [] }, 'rpc:staff_volunteer_hours_add_many': { ok: true, n: 2, failed: [] } });
    await page.locator('#vd-bar').getByRole('button', { name: 'Select' }).click();
    await page.locator('#vd-sel-bar').getByRole('button', { name: 'Select all' }).click();
    await page.locator('#vd-sel-bar').getByRole('button', { name: 'Check in' }).click();
    await expect.poll(() => many.length).toBe(1);
    expect((many[0].p_rows as { customer_id: string }[]).map((r) => r.customer_id).sort()).toEqual(['c1', 'c2']);
    expect(one.length).toBe(0);
    await tab(page, 'People').click();
    await page.locator('#tab-volunteers .vm-acts, #tab-volunteers .filter-row').getByRole('button', { name: 'Select', exact: true }).first().click();
    await page.locator('#vm-sel-bar').getByRole('button', { name: 'Select all' }).click();
    await page.locator('#vm-sel-bar').getByRole('button', { name: 'Add hours' }).click();
    await page.locator('#vm-h').fill('2');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Add hours' }).click();
    await expect.poll(() => hrs.length).toBe(1);
    expect(hrs[0]).toMatchObject({ p_hours: 2 });
    expect(hr1.length).toBe(0);
  });

  test('offline, a check-in waits in the desk outbox and goes when the network is back', async ({ page, context }) => {
    const one = rpcs(page, 'staff_volunteer_shift_times');
    await staff(page, { 'rpc:staff_volunteer_shift_times': { ok: true } });
    await context.setOffline(true);
    await row(page, 'c1').getByRole('button', { name: 'Check in' }).click();
    await page.waitForFunction(`_DQ.length===1&&_DQ[0].kind==='vtimes'`);
    await expect(row(page, 'c1')).toContainText('Not sent yet');
    await expect(row(page, 'c1')).toContainText('On duty');
    expect(one.length).toBe(0);
    await context.setOffline(false);
    await page.evaluate('_dqFlush()');
    await expect.poll(() => one.length).toBe(1);
    expect(one[0]).toMatchObject({ p_session: SID, p_customer: 'c1', p_out: null });
    await page.waitForFunction('_DQ.length===0');
  });

  // Many at once offline sent nothing, kept nothing and said Saved (bug hunt 2026-11-10): each waits in the outbox now.
  test('offline, a check-in for many waits in the desk outbox, one change each', async ({ page, context }) => {
    const many = rpcs(page, 'staff_volunteer_shift_times_many'), one = rpcs(page, 'staff_volunteer_shift_times');
    await staff(page, { 'rpc:staff_volunteer_shift_times_many': { ok: true, n: 2, failed: [] }, 'rpc:staff_volunteer_shift_times': { ok: true } });
    await page.locator('#vd-bar').getByRole('button', { name: 'Select' }).click();
    await page.locator('#vd-sel-bar').getByRole('button', { name: 'Select all' }).click();
    await context.setOffline(true);
    await page.locator('#vd-sel-bar').getByRole('button', { name: 'Check in' }).click();
    await page.waitForFunction(`_DQ.length===2&&_DQ.every(o=>o.kind==='vtimes')`);
    await expect(page.locator('#toast-live')).toContainText('Saved on this device');
    await expect(row(page, 'c1')).toContainText('Not sent yet');
    await expect(row(page, 'c2')).toContainText('Not sent yet');
    expect(many.length + one.length).toBe(0);
    await context.setOffline(false);
    await page.evaluate('_dqFlush()');
    await expect.poll(() => one.length).toBe(2);
    expect(one.map((x) => x.p_customer).sort()).toEqual(['c1', 'c2']);
    await page.waitForFunction('_DQ.length===0');
  });

  test('the view goes with the account and into saved views', async ({ page }) => {
    await staff(page);
    await expect(page.locator('#tab-volunteers .sv-bar[data-sv="volunteers"]').first()).toBeAttached();
    await menu(page, acts(page), 'View');
    await page.getByRole('checkbox', { name: 'Mobile number and WhatsApp' }).uncheck();
    expect(await page.evaluate(`_pref('state.volunteers',null)`)).toEqual({ 'vdv.phone': false });
    expect(await page.evaluate(`_svGet('volunteers').vdv.phone`)).toBe(false);
  });

  test('Opportunities shows hours given and no-shows; Activity opens on changes only', async ({ page }) => {
    const log = [
      { id: 1, customer_id: 'c1', session_id: SID, action: 'search', at: '2026-11-05T18:00:00Z' },
      { id: 2, customer_id: 'c1', session_id: SID, action: 'checkin', at: '2026-11-05T18:01:00Z' },
    ];
    await staff(page, { volunteer_log: log });
    await tab(page, 'Opportunities').click();
    await page.locator('#tab-volunteers .vx-seg').getByRole('button', { name: 'Past' }).click();
    const p = page.locator(`.vm-row-s[data-sess="${past.id}"]`);
    await expect(p).toContainText('3.5 hours given');
    await expect(p).toContainText('1 no-shows');
    await tab(page, 'Activity').click();
    await expect(page.locator('#tab-volunteers .vm-led .vm-res-row')).toHaveCount(1);
    await page.locator('[aria-controls="fm-vml"]').click(); // the list's filters sit behind its Filters button
    await page.getByRole('combobox', { name: 'Show' }).selectOption('all');
    await expect(page.locator('#tab-volunteers .vm-led .vm-res-row')).toHaveCount(2);
  });

  test('Volunteers in Analytics: hours, who came back, no-shows', async ({ page }) => {
    await staff(page);
    await goStaffTab(page, 'analytics');
    await page.evaluate(`setAnView('volunteers')`);
    const host = page.locator('#an-vl-host');
    await expect(host).toContainText('Volunteer hours');
    await expect(host).toContainText('3.5');
    await expect(host).toContainText('No-show rate');
    await expect(page).toHaveURL(/\/analytics\/volunteers$/);
  });
});

test('the review-2 migration adds and never redefines what the sibling migration changes', () => {
  const sql = readFileSync('supabase/migrations/20261107131000_volunteers_review2.sql', 'utf8');
  for (const f of ['staff_volunteer_shift_times', 'staff_volunteer_hours_add', 'staff_volunteer_save', 'staff_volunteer_decide', 'staff_volunteer_session_save', 'volunteer_enter', 'volunteer_me'])
    expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${f}\\(`));
  expect(sql).toContain('alter table public.volunteer_certs enable row level security');
  expect(sql).toMatch(/grant execute on function public\.%s to anon, authenticated/);
  expect(sql).toContain("values ('20261107131000', 'volunteers_review2')");
  // every definer function keeps its search_path
  const defs = sql.split('create or replace function public.').slice(1);
  for (const d of defs) expect(d.slice(0, 600)).toMatch(/set search_path to 'public'/);
});
