import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, goStaffTab } from './helpers/supabase';

// The staff Volunteers section rebuilt with the rework of 2026-11-09 (the owner: "redesign the whole staff Volunteers
// section"; migration 20261109120000): Applications (a profile waiting for staff's yes), the team lead of an opportunity,
// what an event worked gives (the VL- free ride, the certificate) shown on its row and under Hours and rewards, the
// offers that ended without an answer, and the new Activity entries. All Supabase traffic is stubbed.
const SID = '2099-11-05-bd';
const PAST = '2026-10-20-bd';
const session = { id: SID, session_date: '2099-11-05', day: 'Thursday', status: 'open', capacity: 500, created_at: 1, event_kind: 'community', ride_kind: 'blood', needs_approval: false, hide_queue: true, spots: 500, open_to_all: true, bike_slots: '{"_time":"17:00 - 23:00"}' };
const past = { ...session, id: PAST, session_date: '2026-10-20', day: 'Tuesday' };
const customers = [
  { id: 'c1', name: 'Sara Haddad', phone: '+966500000001', email: 'sara@example.com', created_at: '2026-01-01', birth_date: '1990-01-01' },
  { id: 'c2', name: 'Omar Saleh', phone: '+966500000002', email: 'omar@example.com', created_at: '2026-01-02', birth_date: '2001-03-01' },
  { id: 'c3', name: 'Nora Ali', phone: '+966500000003', email: 'nora@example.com', created_at: '2026-01-03', birth_date: '1998-05-05' },
  { id: 'c5', name: 'Khalid Nasser', phone: '+966500000005', email: 'khalid@example.com', created_at: '2026-01-05', birth_date: '2003-02-02' },
  { id: 'c6', name: 'Maha Yousef', phone: '+966500000006', email: 'maha@example.com', created_at: '2026-01-06' },
];
const AG = { agreed_version: '2026-11-05', agreed_at: '2026-11-01T10:00:00Z' };
const volunteers = [
  { customer_id: 'c1', status: 'active', tags: [], auto_accept: false, ...AG, days: [4], profile_at: '2026-11-01T09:00:00Z', created_at: '2026-11-01T10:00:00Z' },
  { customer_id: 'c2', status: 'active', tags: [], auto_accept: false, ...AG, days: [4], profile_at: '2026-11-02T09:00:00Z', created_at: '2026-11-02T10:00:00Z' },
  { customer_id: 'c3', status: 'applied', tags: [], auto_accept: false, days: [5, 6], skills: 'Photography', shirt: 'S', profile_at: '2026-11-08T09:00:00Z', created_at: '2026-11-08T10:00:00Z' },
  { customer_id: 'c5', status: 'applied', tags: [], auto_accept: false, days: [0], shirt: 'XL', profile_at: '2026-11-09T07:00:00Z', created_at: '2026-11-09T07:00:00Z' },
  { customer_id: 'c6', status: 'applied', tags: [], auto_accept: false, days: [], profile_at: null, created_at: '2026-11-01T07:00:00Z' }, // applied before the profile existed
];
const shifts = [
  { id: 1, session_id: SID, customer_id: 'c1', status: 'accepted', lead: false, clock_in: null, clock_out: null, created_at: '2026-11-01T10:00:00Z' },
  { id: 2, session_id: SID, customer_id: 'c2', status: 'done', lead: false, clock_in: '2099-11-05T14:10:00Z', clock_in_by: 'lead', clock_out: '2099-11-05T17:40:00Z', clock_out_by: 'lead', created_at: '2026-11-02T10:00:00Z' },
  { id: 3, session_id: PAST, customer_id: 'c1', status: 'done', clock_in: '2026-10-20T14:00:00Z', clock_out: '2026-10-20T17:00:00Z', created_at: '2026-10-01T10:00:00Z' },
  { id: 4, session_id: SID, customer_id: 'c6', status: 'ended', created_at: '2026-11-03T10:00:00Z' },
];
const switched = { session_id: SID, enabled: true, closes_at: '2099-11-05T20:00:00+00:00', opens_at: null, needed: 5, briefing: 'Gate 3', signup_open: true, caps: { checkin: true }, hours_mode: 'clock', roles: [] };
const pastSw = { ...switched, session_id: PAST, closes_at: '2026-10-21T20:00:00+00:00' };
const hours = [
  { id: 9, customer_id: 'c1', session_id: PAST, hours: 3, worked_on: '2026-10-20', source: 'session', added_by: 'Admin One' },
  { id: 10, customer_id: 'c2', session_id: SID, hours: 3.5, worked_on: '2026-11-05', source: 'session', added_by: 'Admin One' },
];
const promo_codes = [
  { id: 'vl-1', code: 'VL-7F3A92C1', kind: 'percent', value: 100, active: true, uses: 0, max_uses: 1, expires_at: '2099-12-05', customer_id: 'c2', volunteer_session_id: SID, created_at: '2026-11-05T20:00:00Z' },
  { id: 'vl-2', code: 'VL-11B0E5D4', kind: 'percent', value: 100, active: true, uses: 1, max_uses: 1, expires_at: '2026-11-20', customer_id: 'c1', volunteer_session_id: PAST, created_at: '2026-10-20T20:00:00Z' },
];
const volunteer_certs = [
  { id: 41, serial: 'MMV-2026-00012', code: 'ABCD12345678', kind: 'session', name: 'Omar Saleh', session_id: SID, customer_id: 'c2', hours: 3.5, issued_at: '2026-11-05T20:00:00Z', issued_by: 'auto', revoked_at: null },
  { id: 42, serial: 'MMV-2026-00004', code: 'EFGH12345678', kind: 'session', name: 'Sara Haddad', session_id: PAST, customer_id: 'c1', hours: 3, issued_at: '2026-10-20T20:00:00Z', issued_by: 'auto', revoked_at: null },
];
const fx = (x: Record<string, unknown> = {}) => ({
  sessions: [session, past], customers, queue_entries: [{ id: 'q1', session_id: PAST, session_date: '2026-10-20', session_day: 'Tuesday', queue_num: 1, name: 'Nora Ali', customer_id: 'c3', status: 'done', paid: true, price: 0, registered_at: '2026-10-01T10:00:00Z' }],
  volunteers, volunteer_sessions: [switched, pastSw], volunteer_shifts: shifts, volunteer_hours: hours, promo_codes, volunteer_certs,
  volunteer_settings: [{ data: { agreement_v: '2026-11-05' } }], volunteer_log: [], ...x,
});
async function staff(page: Page, x: Record<string, unknown> = {}) {
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
const tab = (page: Page, name: RegExp) => page.locator('#tab-volunteers .vx-tabs').getByRole('button', { name });
const row = (page: Page, id: string) => page.locator(`#vd-list .vd-row[data-cust="${id}"]`);
const app = (page: Page, id: string) => page.locator(`#va-list .vx-app[data-cust="${id}"]`);
async function menu(page: Page, host: ReturnType<Page['locator']>, item: string) {
  await host.locator('.rq-more').first().click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test.describe('@staff:volunteers Volunteers, the rework of 2026-11-09', () => {
  test('Applications: the profile, the facts staff decide on, Approve, Approve and trust, Decline', async ({ page }) => {
    const save = rpcs(page, 'staff_volunteer_save');
    await staff(page, { 'rpc:staff_volunteer_save': { ok: true } });
    await expect(tab(page, /Applications/)).toHaveText('Applications 2'); // the two with a profile; one without it waits for it
    await tab(page, /Applications/).click();
    await expect(page).toHaveURL(/\/volunteers\/applications$/);
    await expect(page.locator('#va-list .vx-app')).toHaveCount(3);
    await expect(page.locator('#va-list .vx-app').first()).toHaveAttribute('data-cust', 'c3'); // oldest profile first
    const nora = app(page, 'c3');
    for (const fact of ['Age', 'Usually free on', 'T-shirt size', 'Rides with us', 'No-shows', 'Photography']) await expect(nora).toContainText(fact);
    await expect(nora.locator('.vx-fact', { hasText: 'Rides with us' })).toContainText('1'); // her one ride with us
    await expect(nora.locator('.vx-fact', { hasText: 'T-shirt size' })).toContainText('S');
    await expect(page.locator('#va-list')).toContainText('Applied before the profile, no profile yet');
    await nora.getByRole('button', { name: /^Approve and trust/ }).click();
    await expect.poll(() => save.length).toBe(1);
    expect(save[0]).toEqual({ p_customer: 'c3', p_status: 'active', p_auto_accept: true });
    await expect(app(page, 'c3')).toHaveCount(0);
    await expect(tab(page, /Applications/)).toHaveText('Applications 1');
    await app(page, 'c5').getByRole('button', { name: /^Decline/ }).click();
    await expect.poll(() => save.length).toBe(2);
    expect(save[1]).toEqual({ p_customer: 'c5', p_status: 'removed' });
  });

  test('Applications: approve many at once', async ({ page }) => {
    const bulk = rpcs(page, 'staff_volunteers_bulk');
    await staff(page, { 'rpc:staff_volunteers_bulk': { ok: true, n: 2 } });
    await tab(page, /Applications/).click();
    await page.locator('#va-bar').getByRole('button', { name: 'Select' }).click();
    await app(page, 'c3').getByRole('button', { name: /Select/ }).click();
    await app(page, 'c5').getByRole('button', { name: /Select/ }).click();
    await expect(page.locator('#va-sel-bar')).toContainText('2 selected');
    await page.locator('#va-sel-bar').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => bulk.length).toBe(1);
    expect(bulk[0]).toMatchObject({ p_status: 'active' });
    expect((bulk[0].p_ids as string[]).sort()).toEqual(['c3', 'c5']);
  });

  test('the team lead: one per opportunity, marked on the row and in the heading, moved by marking another', async ({ page }) => {
    const lead = rpcs(page, 'staff_volunteer_lead');
    await staff(page, { 'rpc:staff_volunteer_lead': { ok: true, lead: true } });
    await expect(row(page, 'c1').locator('.vx-lead')).toHaveCount(0);
    await menu(page, row(page, 'c1'), 'Make team lead');
    await expect.poll(() => lead.length).toBe(1);
    expect(lead[0]).toEqual({ p_session: SID, p_customer: 'c1', p_on: true });
    await expect(row(page, 'c1').locator('.vx-lead')).toContainText('Lead');
    await expect(row(page, 'c1').locator('.vx-lead svg.art-lead')).toHaveCount(1); // the two-tone mark
    await expect(page.locator('#tab-volunteers .vx-sess')).toContainText('Lead: Sara Haddad');
    await menu(page, row(page, 'c2'), 'Make team lead');
    await expect.poll(() => lead.length).toBe(2);
    await expect(row(page, 'c1').locator('.vx-lead')).toHaveCount(0); // one lead per opportunity
    await expect(row(page, 'c2').locator('.vx-lead')).toHaveCount(1);
    await menu(page, row(page, 'c2'), 'Remove as team lead');
    await expect.poll(() => lead.length).toBe(3);
    expect(lead[2]).toEqual({ p_session: SID, p_customer: 'c2', p_on: false });
    await expect(page.locator('#vd-list .vx-lead')).toHaveCount(0);
  });

  test('marks the lead made say so; an offer that ended without an answer is under Not coming', async ({ page }) => {
    await staff(page);
    await expect(row(page, 'c2')).toContainText('In 17:10 by the lead');
    await expect(row(page, 'c2')).toContainText('Out 20:40 by the lead');
    await expect(row(page, 'c6')).toHaveCount(0);
    await page.locator('#tab-volunteers .vx-figs').getByRole('button', { name: /Not coming/ }).click();
    await expect(row(page, 'c6')).toContainText('Ended without an answer');
  });

  test('what an event worked gave, on its row: the VL- free ride with its last day, and the certificate', async ({ page }) => {
    await staff(page);
    const r = row(page, 'c2');
    await expect(r.locator('.code-tag.code-k-vl')).toHaveText('VL-7F3A92C1');
    await expect(r.locator('.code-tag.code-k-vl')).toHaveAttribute('title', 'Volunteer free ride: VL-7F3A92C1');
    await expect(r.locator('.vx-rw-st')).toHaveText('Until 5 Dec 2099');
    await expect(r.locator('.vx-cert')).toContainText('MMV-2026-00012');
    await expect(row(page, 'c1').locator('.vx-rws')).toHaveCount(0); // nothing given on this event yet
  });

  test('Give hours reads the free ride and the certificate the database made with them', async ({ page }) => {
    const award = rpcs(page, 'staff_volunteer_award');
    const reads: string[] = [];
    page.on('request', (q) => { const u = q.url(); if (/\/rest\/v1\/(promo_codes|volunteer_certs)\?/.test(u)) reads.push(decodeURIComponent(u)); });
    const clocked = shifts.map((x) => (x.customer_id === 'c1' && x.session_id === SID ? { ...x, clock_in: '2099-11-05T14:00:00Z', clock_out: '2099-11-05T16:30:00Z' } : x));
    await staff(page, { volunteer_shifts: clocked, 'rpc:staff_volunteer_award': { ok: true, added: 1, skipped: 0, reached: [] } });
    reads.length = 0;
    await row(page, 'c1').getByRole('button', { name: /Give 2.5 h/ }).click();
    await expect.poll(() => award.length).toBe(1);
    await expect(page.locator('#toast-live, #toast-container').first()).toContainText('with the free ride, the certificate and the Volunteer badge');
    await expect.poll(() => reads.some((u) => u.includes('promo_codes') && u.includes(`volunteer_session_id=eq.${SID}`))).toBe(true);
    await expect.poll(() => reads.some((u) => u.includes('volunteer_certs') && u.includes(`session_id=eq.${SID}`))).toBe(true);
  });

  test('Hours and rewards: every free ride and certificate, its state, a certificate withdrawn', async ({ page }) => {
    const revoke = rpcs(page, 'staff_volunteer_cert_revoke');
    await staff(page, { 'rpc:staff_volunteer_cert_revoke': { ok: true } });
    await tab(page, /Hours and rewards/).click();
    await page.locator('#tab-volunteers .vx-seg').getByRole('button', { name: 'Rewards' }).click();
    const list = page.locator('#vmr-list .vr-row');
    await expect(list).toHaveCount(4);
    await expect(page.locator('#vmr-list .vr-row[data-rw="code-vl-2"]')).toContainText('Used');
    await expect(page.locator('#vmr-list .vr-row[data-rw="code-vl-1"]')).toContainText('Until 5 Dec 2099');
    await expect(page.locator('#vmr-list .vr-row[data-rw="cert-41"]')).toContainText('Made automatically');
    await page.locator('[aria-controls="fm-vmr"]').click();
    await page.locator('#tab-volunteers select[aria-label="Kind"]').selectOption('cert');
    await expect(list).toHaveCount(2);
    await page.locator('#vmr-list .vr-row[data-rw="cert-41"]').getByRole('button', { name: 'Withdraw' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Withdraw' }).click();
    await expect.poll(() => revoke.length).toBe(1);
    expect(revoke[0]).toEqual({ p_id: 41 });
    await expect(page.locator('#vmr-list .vr-row[data-rw="cert-41"]')).toContainText('Withdrawn');
  });

  test("a person's window lists their rewards", async ({ page }) => {
    await staff(page);
    await tab(page, /People/).click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: /Manage/ }).click();
    const rw = page.locator('#confirm-modal #vm-rw');
    await expect(rw.locator('.code-k-vl')).toHaveText('VL-11B0E5D4');
    await expect(rw).toContainText('Used');
    await expect(rw).toContainText('MMV-2026-00004');
  });

  test('Activity names the new entries: the lead\'s marks with the teammate, rewards, offers ended by themselves', async ({ page }) => {
    const log = [
      { id: 1, at: '2099-11-05T14:10:00Z', customer_id: 'c1', session_id: SID, action: 'lead_in', entry_id: '2' },
      { id: 2, at: '2026-11-05T20:00:00Z', customer_id: 'c2', session_id: SID, action: 'reward', actor: 'Admin One' },
      { id: 3, at: '2026-11-04T10:00:00Z', customer_id: 'c1', session_id: SID, action: 'staff_lead', actor: 'Admin One' },
      { id: 4, at: '2026-10-22T10:00:00Z', customer_id: 'c6', session_id: SID, action: 'ended', actor: 'auto' },
    ];
    await staff(page, { volunteer_log: log });
    await tab(page, /Activity/).click();
    const rows = page.locator('#tab-volunteers .vm-led .vm-res-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('The lead checked a teammate in · Omar Saleh');
    await expect(rows.nth(1)).toContainText("Given the event’s free ride, certificate and badge");
    await expect(rows.nth(2)).toContainText('Team lead changed');
    await expect(rows.nth(3)).toContainText('Offer ended without an answer');
    await expect(rows.nth(3)).toContainText('automatically');
  });

  test('a phone: each row is a card, the table head hidden, the row menu centred', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'the phone layout');
    await staff(page);
    await expect(page.locator('#vd-list .vd-head')).toBeHidden();
    await expect(row(page, 'c1').getByRole('button', { name: /Check in/ })).toBeVisible();
    const box = await row(page, 'c1').boundingBox();
    expect(box && box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});
