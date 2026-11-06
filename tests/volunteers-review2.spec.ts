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
  { id: 'c4', name: 'Huda Fares', phone: '+966500000004', email: 'huda@example.com', created_at: '2026-01-04' },
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
const tab = (page: Page, name: string | RegExp) => page.locator('#tab-volunteers .inv-tabs').getByRole('button', { name, exact: typeof name === 'string' });

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

  test('applications: an Applied pill on the roster, with Accept and Decline', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_save');
    await staff(page, { 'rpc:staff_volunteer_save': { ok: true } });
    await tab(page, 'Volunteers').click();
    await page.locator('#tab-volunteers .filter-pill', { hasText: 'Applied (1)' }).click();
    const r = page.locator('#vm-list .vm-row[data-cust="c3"]');
    await expect(r).toContainText('First aid');
    await r.getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ p_customer: 'c3', p_status: 'active' });
  });

  test('availability: weekdays, skills and WhatsApp are edited in the volunteer\'s dialog', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_profile_save');
    await staff(page, { 'rpc:staff_volunteer_profile_save': { ok: true } });
    await tab(page, 'Volunteers').click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal .n6w-day[value="6"]').check();
    await page.locator('#n6w-skills').fill('Photos');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Save availability' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ p_customer: 'c1', p_days: [4, 6], p_skills: 'Photos', p_whatsapp: '' });
  });

  test('a certificate for a period, with its serial and check link; before the database, the old one prints', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_cert_issue');
    const cert = { ok: true, id: 1, serial: 'MMV-2026-00001', code: 'ABCDEF123456', name: 'Sara Haddad', from: '2026-10-01', to: '2026-10-31', hours: 3.5, sessions: [{ title: 'Blood Donation', date: '2026-10-20', hours: 3.5 }], issued_at: '2026-11-06T10:00:00Z' };
    await staff(page, { 'rpc:staff_volunteer_cert_issue': cert, volunteer_certs: [] });
    await page.evaluate(`window._openReport=(h)=>{window.__rep=h;return {};}`);
    await tab(page, 'Volunteers').click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Certificate' }).click();
    await expect(page.locator('#n6w-cf')).toHaveValue('2026-10-20'); // from the first hours
    await page.locator('#n6w-cf').fill('2026-10-01');
    await page.locator('#n6w-ct').fill('2026-10-31');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Make the certificate' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ p_customer: 'c1', p_from: '2026-10-01', p_to: '2026-10-31' });
    await expect.poll(() => page.evaluate('window.__rep||""')).toContain('MMV-2026-00001');
    const html = await page.evaluate('window.__rep') as string;
    expect(html).toContain('volunteer.micromobility.sa/#check/ABCDEF123456');
    expect(html).toContain('Blood Donation');
  });

  test('before the database has certificates, Make prints the certificate as before', async ({ page }) => {
    await staff(page);
    await page.evaluate(`window._openReport=(h)=>{window.__rep=h;return {};}`);
    await tab(page, 'Volunteers').click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: 'Manage' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Certificate' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Make the certificate' }).click();
    await expect.poll(() => page.evaluate('window.__rep||""')).toContain('Certificate of Volunteering');
  });

  test('many at once: one call for the check-in, one for the hours', async ({ page }) => {
    const many = rpcs(page, 'staff_volunteer_shift_times_many'), one = rpcs(page, 'staff_volunteer_shift_times');
    const hrs = rpcs(page, 'staff_volunteer_hours_add_many'), hr1 = rpcs(page, 'staff_volunteer_hours_add');
    await staff(page, { 'rpc:staff_volunteer_shift_times_many': { ok: true, n: 2, failed: [] }, 'rpc:staff_volunteer_hours_add_many': { ok: true, n: 2, failed: [] } });
    await acts(page).getByRole('button', { name: 'Select' }).click();
    await page.locator('#vd-sel-bar').getByRole('button', { name: 'Select all' }).click();
    await page.locator('#vd-sel-bar').getByRole('button', { name: 'Check in' }).click();
    await expect.poll(() => many.length).toBe(1);
    expect((many[0].p_rows as { customer_id: string }[]).map((r) => r.customer_id).sort()).toEqual(['c1', 'c2']);
    expect(one.length).toBe(0);
    await tab(page, 'Volunteers').click();
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

  test('the view goes with the account and into saved views', async ({ page }) => {
    await staff(page);
    await expect(page.locator('#tab-volunteers .sv-bar[data-sv="volunteers"]').first()).toBeAttached();
    await acts(page).getByRole('button', { name: 'View' }).click();
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
    await page.locator('#tab-volunteers .filter-pill', { hasText: 'Past' }).click();
    const p = page.locator(`.vm-row-s[data-sess="${past.id}"]`);
    await expect(p).toContainText('3.5 hours given');
    await expect(p).toContainText('1 no-shows');
    await tab(page, 'Activity').click();
    await expect(page.locator('#tab-volunteers .vm-led .vm-res-row')).toHaveCount(1);
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
