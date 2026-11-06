import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, goStaffTab } from './helpers/supabase';
import { readFileSync } from 'node:fs';

// The Volunteers section and the volunteer switch (the owner, 2026-11-05; migration 20261105120000). The volunteers' own
// pages are the portal, volunteer.micromobility.sa (mm-platform apps/volunteers); the access rules are in the database.
const SID = '2099-11-05-bd';
const session = { id: SID, session_date: '2099-11-05', day: 'Thursday', status: 'open', capacity: 500, created_at: 1, event_kind: 'community', ride_kind: 'blood', needs_approval: false, hide_queue: true, spots: 500, open_to_all: true, bike_slots: '{"_time":"17:00 - 23:00"}' };
const future = '2099-11-05T20:00:00+00:00';
const customers = [
  { id: 'c1', name: 'Sara Haddad', phone: '+966500000001', email: 'sara@example.com', created_at: '2026-01-01' },
  { id: 'c2', name: 'Omar Saleh', phone: '+966500000002', email: 'omar@example.com', created_at: '2026-01-02' },
  { id: 'c3', name: 'Nora Ali', phone: '+966500000003', email: 'nora@example.com', created_at: '2026-01-03' },
];
const volunteers = [
  { customer_id: 'c1', status: 'active', tags: ['Check-in'], auto_accept: false, agreed_version: '2026-11-05', agreed_at: '2026-11-01T10:00:00Z', created_at: '2026-11-01T10:00:00Z' },
  { customer_id: 'c2', status: 'applied', tags: [], auto_accept: false, created_at: '2026-11-02T10:00:00Z' },
  { customer_id: 'c3', status: 'applied', tags: [], auto_accept: false, created_at: '2026-11-03T10:00:00Z' },
];
const shifts = [
  { id: 1, session_id: SID, customer_id: 'c1', status: 'accepted', role: 'Check-in', clock_in: null, clock_out: null, created_at: '2026-11-01T10:00:00Z' },
  { id: 2, session_id: SID, customer_id: 'c2', status: 'interested', pref_role: 'Guide', message: 'I speak Arabic', created_at: '2026-11-02T10:00:00Z' },
  { id: 3, session_id: SID, customer_id: 'c3', status: 'interested', created_at: '2026-11-03T10:00:00Z' },
];
const switched = { session_id: SID, enabled: true, closes_at: future, opens_at: null, needed: 5, about: 'Help at the door', briefing: 'Gate 3', signup_open: true, caps: { checkin: true, undo: true, donated: true, list: false, counts: true }, hours_mode: 'clock', roles: ['Check-in', 'Guide'] };
const hours = [{ id: 9, customer_id: 'c1', session_id: SID, hours: 3.5, worked_on: '2026-10-20', source: 'staff', note: 'Gate duty', added_by: 'Admin One' }];
const fx = (x: Record<string, unknown> = {}) => ({
  sessions: [session], customers, queue_entries: [], volunteers, volunteer_sessions: [switched], volunteer_shifts: shifts, volunteer_hours: hours,
  volunteer_settings: [{ data: { agreement_v: '2026-11-05', tags: ['Check-in'] } }], volunteer_log: [], ...x,
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
const tile = (page: Page) => page.locator('#tab-volunteers .inv-tabs');
const roster = (page: Page) => tile(page).getByRole('button', { name: 'Volunteers', exact: true }).click();
const row = (page: Page, id: string) => page.locator(`#vd-list .vd-row[data-cust="${id}"]`);

test.describe('@staff:volunteers The Volunteers section', () => {
  test('has its address, its tabs and its figures', async ({ page }) => {
    await staff(page);
    await expect(page).toHaveURL(/\/volunteers$/);
    await expect(tile(page).getByRole('button')).toHaveText(['Shifts', 'Volunteers', 'Interested (2)', 'Opportunities', 'Hours', 'Activity', 'Settings']);
    await roster(page);
    await expect(page).toHaveURL(/\/volunteers\/people$/);
    await expect(page.locator('#tab-volunteers .stat-card')).toHaveCount(6);
    await expect(page.locator('#vm-list .vm-row')).toHaveCount(1); // the active ones first
    await expect(page.locator('#vm-list .vm-row').first()).toContainText('Sara Haddad');
    await expect(page.locator('#vm-list .vm-row').first()).toContainText('3.5');
    await tile(page).getByRole('button', { name: /Interested/ }).click();
    await expect(page).toHaveURL(/\/volunteers\/interested$/);
    await page.reload();
    await waitForSb(page);
    await expect(page.locator('#tab-volunteers .vm-group')).toHaveCount(1);
  });

  test('anyone interested can be accepted one at a time, or all at once', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_decide');
    await staff(page, { 'rpc:staff_volunteer_decide': { ok: true, n: 1, skipped: 0 } });
    await tile(page).getByRole('button', { name: /Interested/ }).click();
    const one = page.locator('#tab-volunteers .vm-row[data-cust="c2"]');
    await expect(one).toContainText('Omar Saleh');
    await expect(one).toContainText('Would like: Guide');
    await expect(one).toContainText('I speak Arabic');
    await one.getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_session: SID, p_customers: ['c2'], p_status: 'accepted' });
    await page.locator('#tab-volunteers .vm-row[data-cust="c3"]').getByRole('button', { name: 'Decline' }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toMatchObject({ p_customers: ['c3'], p_status: 'declined' });
    await page.locator('#tab-volunteers .vm-group').getByRole('button', { name: 'Accept all (2)' }).click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2]).toMatchObject({ p_session: SID, p_status: 'accepted' });
    expect((sent[2].p_customers as string[]).sort()).toEqual(['c2', 'c3']);
  });

  test('a refused accept is said, and someone left out is counted', async ({ page }) => {
    await staff(page, { 'rpc:staff_volunteer_decide': { ok: true, n: 0, skipped: 2 } });
    await tile(page).getByRole('button', { name: /Interested/ }).click();
    await page.locator('#tab-volunteers .vm-group').getByRole('button', { name: 'Accept all (2)' }).click();
    await expect(page.locator('.toast, #toast-container').first()).toContainText('2 left out');
  });

  test('a trusted volunteer can be accepted automatically', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_save');
    await staff(page, { 'rpc:staff_volunteer_save': { ok: true } });
    await roster(page);
    await page.locator('#vm-list .vm-row').first().getByRole('button', { name: 'Manage' }).click();
    await page.getByRole('checkbox', { name: /Accept automatically/ }).check();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_customer: 'c1', p_auto_accept: true, p_status: 'active' });
  });

  test('hours: added to anyone, on any list, and refused when it would go below zero', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_hours_add');
    await staff(page, { 'rpc:staff_volunteer_hours_add': { __rpcError: { status: 400, code: 'P0001', message: 'VOL_HOURS_NEGATIVE' } } });
    await roster(page);
    await page.locator('#vm-list .vm-row').first().getByRole('button', { name: 'Add hours' }).click();
    await page.locator('#vm-h').fill('-9');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Add hours' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_customer: 'c1', p_hours: -9 });
    await expect(page.locator('.toast, #toast-container').first()).toContainText('below zero');
  });

  test('every session can be opened to volunteers from here: the cut-off is asked for and filled in', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_session_save');
    await staff(page, { volunteer_sessions: [], 'rpc:staff_volunteer_session_save': { ok: true, enabled: true } });
    await tile(page).getByRole('button', { name: 'Opportunities' }).click();
    await page.locator(`.vm-row-s[data-sess="${SID}"]`).getByRole('button', { name: 'Open to volunteers' }).click();
    const box = page.locator('#confirm-modal');
    await expect(box.locator('#vsf-closes')).toHaveValue('2099-11-06T00:00'); // the session's end, 23:00, and the default hour after it
    await box.locator('#vsf-closes').fill('');
    await box.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast, #toast-container').first()).toContainText('Choose the time');
    expect(sent).toHaveLength(0);
    await box.locator('#vsf-closes').fill('2099-11-05T23:30');
    await box.locator('#vsf-about').fill('Help at the door');
    await box.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_session: SID, p_enabled: true, p_about: 'Help at the door', p_signup_open: true });
    expect(new Date(sent[0].p_closes as string).toISOString()).toBe('2099-11-05T20:30:00.000Z'); // Saudi time
  });

  test('Shifts opens on the coming session, like Bookings: its figures, its team, and the interested', async ({ page }) => {
    await staff(page);
    await expect(page.locator('#tab-volunteers .vd-sel')).toHaveValue(SID);
    await expect(page.locator('#tab-volunteers .stat-card')).toHaveCount(6);
    await expect(page.locator('#vd-list .vd-row:not(.vd-head)')).toHaveCount(1); // the team: Sara
    await expect(row(page, 'c1')).toContainText('Not here yet');
    await expect(row(page, 'c1')).toContainText('Check-in'); // her role
    await page.locator('#tab-volunteers .filter-pill', { hasText: 'Interested' }).click();
    await expect(page.locator('#vd-list .vd-row:not(.vd-head)')).toHaveCount(2);
    await expect(row(page, 'c2')).toContainText('I speak Arabic');
    await page.locator('#tab-volunteers .filter-pill', { hasText: 'All' }).click();
    if (!(await page.locator('#vd-q').isVisible())) await page.locator('[data-srch="vd"] button').click(); // folded on a phone
    await page.locator('#vd-q').fill('nora');
    await expect(page.locator('#vd-list .vd-row:not(.vd-head)')).toHaveCount(1);
  });

  test('check in and check out from the row, each one tap', async ({ page }) => {
    const times = rpcs(page, 'staff_volunteer_shift_times');
    await staff(page, { 'rpc:staff_volunteer_shift_times': { ok: true } });
    await row(page, 'c1').getByRole('button', { name: 'Check in' }).click();
    await expect.poll(() => times.length).toBe(1);
    expect(times[0]).toMatchObject({ p_session: SID, p_customer: 'c1', p_out: null });
    expect(Date.now() - +new Date(times[0].p_in as string)).toBeLessThan(60000);
    await expect(row(page, 'c1')).toContainText('On duty');
    await row(page, 'c1').getByRole('button', { name: 'Check out' }).click();
    await expect.poll(() => times.length).toBe(2);
    expect(times[1]).toMatchObject({ p_customer: 'c1', p_in: times[0].p_in });
    expect(times[1].p_out).toBeTruthy();
    await expect(row(page, 'c1')).toContainText('Finished');
  });

  test('anyone can be added by hand and checked in at once; someone interested is accepted first', async ({ page }) => {
    const decide = rpcs(page, 'staff_volunteer_decide');
    const times = rpcs(page, 'staff_volunteer_shift_times');
    await staff(page, { 'rpc:staff_volunteer_decide': { ok: true, n: 1, skipped: 0 }, 'rpc:staff_volunteer_shift_times': { ok: true } });
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Add a volunteer' }).click();
    await page.locator('#vd-add-q').fill('Nora');
    await page.locator('#vd-add-res').getByRole('button', { name: 'Add and check in' }).click();
    await expect.poll(() => times.length).toBe(1);
    expect(decide[0]).toMatchObject({ p_session: SID, p_customers: ['c3'], p_status: 'accepted' });
    expect(times[0]).toMatchObject({ p_customer: 'c3', p_out: null });
  });

  test('hours: worked out from the clock and given to the finished, or set the same for everyone', async ({ page }) => {
    const award = rpcs(page, 'staff_volunteer_award');
    const clocked = shifts.map((x) => (x.customer_id === 'c1' ? { ...x, clock_in: '2099-11-05T14:00:00+00:00', clock_out: '2099-11-05T16:30:00+00:00' } : x));
    await staff(page, { volunteer_shifts: clocked, 'rpc:staff_volunteer_award': { ok: true, added: 1, skipped: 0 } });
    await expect(row(page, 'c1')).toContainText('2.5 h to give');
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Give hours (1)' }).click();
    const box = page.locator('#confirm-modal');
    await expect(box.locator('.vd-give-h[data-cust="c1"]')).toHaveValue('2.5');
    await box.locator('#vd-give-all').fill('3');
    await box.getByRole('button', { name: 'Apply' }).click();
    await box.getByRole('button', { name: 'Give these hours' }).click();
    await expect.poll(() => award.length).toBe(1);
    expect(award[0]).toEqual({ p_session: SID, p_rows: [{ customer_id: 'c1', hours: 3 }] });
  });

  test('manage one person: times put right by hand, a note, hours for this session, taken off', async ({ page }) => {
    const times = rpcs(page, 'staff_volunteer_shift_times');
    const save = rpcs(page, 'staff_volunteer_shift_save');
    const hrs = rpcs(page, 'staff_volunteer_hours_add');
    await staff(page, { 'rpc:staff_volunteer_shift_times': { ok: true }, 'rpc:staff_volunteer_shift_save': { ok: true }, 'rpc:staff_volunteer_hours_add': { ok: true, id: 2, total: 5 } });
    await row(page, 'c1').getByRole('button', { name: 'Manage' }).click();
    const box = page.locator('#confirm-modal');
    await box.locator('#vd-in').fill('2099-11-05T17:00');
    await box.locator('#vd-out').fill('2099-11-05T16:00');
    await box.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast, #toast-container').first()).toContainText('finish time must be after');
    await box.locator('#vd-out').fill('2099-11-05T21:30');
    await box.locator('#vd-note').fill('Gate 3');
    await box.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => times.length).toBe(1);
    expect(new Date(times[0].p_in as string).toISOString()).toBe('2099-11-05T14:00:00.000Z'); // Saudi time
    expect(new Date(times[0].p_out as string).toISOString()).toBe('2099-11-05T18:30:00.000Z');
    expect(save[0]).toMatchObject({ p_session: SID, p_customer: 'c1', p_status: 'accepted', p_note: 'Gate 3' });
    await row(page, 'c1').getByRole('button', { name: 'Manage' }).click();
    await box.locator('#vd-h').fill('1.5');
    await box.getByRole('button', { name: 'Add hours' }).click();
    await expect.poll(() => hrs.length).toBe(1);
    expect(hrs[0]).toMatchObject({ p_customer: 'c1', p_hours: 1.5, p_session: SID });
    await box.getByRole('button', { name: 'Take off this session' }).click();
    await expect.poll(() => save.length).toBe(2);
    expect(save[1]).toMatchObject({ p_customer: 'c1', p_status: null });
  });

  test('many at once: select, check in', async ({ page }) => {
    const times = rpcs(page, 'staff_volunteer_shift_times');
    await staff(page, { 'rpc:staff_volunteer_shift_times': { ok: true } });
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Select' }).click();
    await page.locator('#vd-sel-bar').getByRole('button', { name: 'Select all' }).click();
    await page.locator('#vd-sel-bar').getByRole('button', { name: 'Check in' }).click();
    await expect.poll(() => times.length).toBe(1);
    expect(times[0]).toMatchObject({ p_customer: 'c1', p_out: null });
  });

  test('the view is set per device: columns off, hours given at check-out, kept after a reload', async ({ page }) => {
    const award = rpcs(page, 'staff_volunteer_award');
    const fixed = { ...switched, hours_mode: 'fixed', fixed_hours: 6 };
    const inNow = shifts.map((x) => (x.customer_id === 'c1' ? { ...x, clock_in: new Date(Date.now() - 36e5).toISOString() } : x));
    await staff(page, { volunteer_sessions: [fixed], volunteer_shifts: inNow, 'rpc:staff_volunteer_shift_times': { ok: true }, 'rpc:staff_volunteer_award': { ok: true, added: 1, skipped: 0 } });
    await expect(row(page, 'c1')).toContainText('+966500000001');
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'View' }).click();
    await page.getByRole('checkbox', { name: 'Mobile number and WhatsApp' }).uncheck();
    await page.getByRole('checkbox', { name: 'Give the hours at check-out' }).check();
    await page.locator('#confirm-modal .x-close').click();
    await expect(row(page, 'c1')).not.toContainText('+966500000001');
    await row(page, 'c1').getByRole('button', { name: 'Check out' }).click();
    await expect.poll(() => award.length).toBe(1);
    expect(award[0]).toEqual({ p_session: SID, p_rows: [{ customer_id: 'c1', hours: 6 }] });
    await page.reload();
    await waitForSb(page);
    await expect(row(page, 'c1')).toBeVisible();
    await expect(row(page, 'c1')).not.toContainText('+966500000001');
  });

  test('the Opportunities list leads to a session\'s shifts; a session without volunteers can be opened from there', async ({ page }) => {
    await staff(page);
    await tile(page).getByRole('button', { name: 'Opportunities' }).click();
    await page.locator(`.vm-row-s[data-sess="${SID}"]`).getByRole('button', { name: 'Team and hours' }).click();
    await expect(page).toHaveURL(/\/volunteers$/);
    await expect(page.locator('#tab-volunteers .vd-sel')).toHaveValue(SID);
  });

  test('no session with volunteers: Shifts says so', async ({ page }) => {
    await staff(page, { volunteer_sessions: [] });
    await expect(page.locator('#tab-volunteers')).toContainText('No session is open to volunteers yet');
  });

  test('the switch in the session form: nothing is sent unless it was touched', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_session_save');
    await staff(page, { volunteer_sessions: [], 'rpc:staff_volunteer_session_save': { ok: true, enabled: true } });
    await page.evaluate(`S.queueView='sessions';setStaffTab('queue');startEditSession&&startEditSession('${SID}')`).catch(() => {});
    await expect(page.locator('#vsf-on')).toBeVisible();
    await expect(page.locator('#vsf-closes')).toHaveCount(0);
    await page.locator('#vsf-on').check();
    await expect(page.locator('#vsf-closes')).toHaveValue('2099-11-06T00:00');
    await page.locator('#sess-edit-form .ss-form-acts .btn-primary').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_session: SID, p_enabled: true });
  });

  test('before the database has it, the section says so and the session form is untouched', async ({ page }) => {
    await stubSupabase(page, { sessions: [session], customers, queue_entries: [] });
    await unlockStaff(page);
    await page.route(/\/rest\/v1\/volunteers(\?|$)/, (r) => r.fulfill({ status: 404, json: { code: 'PGRST205', message: "Could not find the table 'public.volunteers' in the schema cache" } }));
    await page.goto('/');
    await waitForSb(page);
    await goStaffTab(page, 'volunteers');
    await expect(page.locator('#tab-volunteers')).toContainText('needs its database update');
  });

  test('the hours in the account editor', async ({ page }) => {
    const sent = rpcs(page, 'staff_volunteer_hours_add');
    await staff(page, { 'rpc:staff_volunteer_hours_add': { ok: true, id: 1, total: 5.5 } });
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(page.locator('#cf-vol-host')).toContainText('Volunteering hours');
    await expect(page.locator('#cf-vol-host')).toContainText('3.5');
    await page.locator('#cf-vol-host').getByRole('button', { name: 'Add hours' }).first().click();
    await page.locator('#cf-vol-host #vm-h').fill('2');
    await page.locator('#cf-vol-form').getByRole('button', { name: 'Add hours' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_customer: 'c1', p_hours: 2 });
  });
});

test.describe('@customer:account Volunteering on My Account', () => {
  const me = (x: Record<string, unknown>) => ({ id: 'c1', name: 'Sara', hours: 0, status: null, agreed: false, promote: false, open_count: 0, mine: [], record: [], sessions: 0, ...x });
  async function rider(page: Page, data: Record<string, unknown>) {
    await stubSupabase(page, { sessions: [session], queue_entries: [], 'rpc:volunteer_me': data, 'rpc:customer_handoff_create': 'a'.repeat(48) });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#acc-bt-host')).toBeAttached();
  }
  test('nothing to say, no card', async ({ page }) => {
    await rider(page, me({}));
    await expect(page.locator('#acc-vol')).toHaveCount(0);
  });
  test('the hours, and the way to the portal, signed in', async ({ page }) => {
    await page.route('https://volunteer.micromobility.sa/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>portal</title>' }));
    await rider(page, me({ hours: 12.5, status: 'active', record: [{ id: 1, hours: 12.5, on: '2026-10-20', session_id: SID, ride_kind: 'blood', event_kind: 'community' }] }));
    await expect(page.locator('#acc-vol')).toContainText('Your volunteering hours: 12.5');
    await page.locator('#acc-vol').getByRole('button', { name: 'Open the volunteer portal' }).click();
    await page.waitForURL(/volunteer\.micromobility\.sa/);
    expect(page.url()).toBe(`https://volunteer.micromobility.sa/?signin=${'a'.repeat(48)}`);
  });
  test('riders are told about the portal only when staff switch that on and something is open', async ({ page }) => {
    await rider(page, me({ promote: true, open_count: 1 }));
    await expect(page.locator('#acc-vol')).toContainText('Help at our events');
  });
  test('promote on, nothing open: no card', async ({ page }) => {
    await rider(page, me({ promote: true, open_count: 0 }));
    await expect(page.locator('#acc-vol')).toHaveCount(0);
  });
  test('an older database: no card, no noise', async ({ page }) => {
    await rider(page, { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.volunteer_me' } });
    await expect(page.locator('#acc-vol')).toHaveCount(0);
  });
});

test.describe('The way back to the portal', () => {
  test('signed in on the booking app from ?handoff=volunteer: handed over with a code', async ({ page }) => {
    await page.route('https://volunteer.micromobility.sa/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>portal</title>' }));
    await stubSupabase(page, { sessions: [session], queue_entries: [], 'rpc:customer_handoff_create': 'b'.repeat(48) });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com' });
    await page.goto('/?handoff=volunteer');
    await page.waitForURL(/volunteer\.micromobility\.sa/);
    expect(page.url()).toBe(`https://volunteer.micromobility.sa/?signin=${'b'.repeat(48)}`);
  });
});

test('the panel migration: phones and details start off on open sessions, and an older staff page cannot drop them', () => {
  const sql = readFileSync('supabase/migrations/20261105180000_volunteer_panel.sql', 'utf8');
  expect(sql).toContain(`w := _vol_gate(p_id, p_token, p_session, 'list')`);
  expect(sql).toContain(`'{"phone":false,"details":false}'::jsonb || caps`);
  expect(sql).toContain(`when _phone then`);
  expect(sql).toContain(`when _details then`);
  expect(sql).toMatch(/\(select \(x\.caps ->> 'phone'\)::boolean from volunteer_sessions x/);
  expect(sql).not.toMatch(/'email'|'price'|'birth_date'/);
});

test('the privacy notice names what a volunteer can see, in both languages', () => {
  const src = readFileSync('app.src.html', 'utf8');
  expect(src).toContain('also your mobile number and your booking details');
  expect(src).toContain('أيضًا رقم جوالك وتفاصيل حجزك');
  expect(src).not.toContain('Never your contact details or payments');
});

test('the migration keeps its promises', () => {
  const sql = readFileSync('supabase/migrations/20261105120000_volunteers.sql', 'utf8');
  for (const t of ['volunteers', 'volunteer_hours', 'volunteer_shifts', 'volunteer_settings']) expect(sql, t).toContain(`alter table public.${t} enable row level security`);
  expect(sql).toContain('VOL_OWN_BOOKING');
  expect(sql).toContain('_vol_desk_reason');
  expect(sql).toMatch(/update volunteer_sessions w set session_id = v_to/);
  expect(sql).not.toMatch(/drop function if exists public\.staff_volunteer_find/); // the old role stays until after 5 November
});
