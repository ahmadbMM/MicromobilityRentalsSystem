import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, goStaffTab } from './helpers/supabase';

// The staff side of the volunteer enhancements (2026-11-11, migration 20261111140000; the owner: "implement them all"):
// an opportunity's details for volunteers, when each plans to leave and whether they confirmed they are coming, why they
// withdrew or were declined, the optional reason staff give when they decline (D9), how long offers and applications have
// waited (D10), the close-out thank-you and the feedback, the motive, the two new settings (D3, D10) and the certificate's
// Saudi field set. All Supabase traffic is stubbed; the dates are relative to now, so nothing turns over at midnight.
const ksa = (days: number) => new Date(Date.now() + 3 * 3600e3 + days * 864e5).toISOString().slice(0, 10);
const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
const SOON = `${ksa(1)}-vl`; // tomorrow, 17:00 KSA: within 48 hours
const PAST = '2026-10-20-bd';
const base = { status: 'open', capacity: 500, created_at: 1, event_kind: 'community', ride_kind: 'community', needs_approval: false, hide_queue: true, spots: 500, open_to_all: true, bike_slots: '{"_time":"17:00 - 23:00"}' };
const soon = { ...base, id: SOON, session_date: ksa(1), day: 'Thursday' };
const past = { ...base, id: PAST, session_date: '2026-10-20', day: 'Tuesday', ride_kind: 'blood' };
const customers = [
  { id: 'c1', name: 'Sara Haddad', phone: '+966500000001', email: 'sara@example.com', created_at: '2026-01-01', birth_date: '1990-01-01' },
  { id: 'c2', name: 'Omar Saleh', phone: '+966500000002', email: 'omar@example.com', created_at: '2026-01-02', birth_date: '2001-03-01' },
  { id: 'c3', name: 'Nora Ali', phone: '+966500000003', email: 'nora@example.com', created_at: '2026-01-03', birth_date: '1998-05-05' },
  { id: 'c5', name: 'Khalid Nasser', phone: '+966500000005', email: 'khalid@example.com', created_at: '2026-01-05', birth_date: '2003-02-02' },
  { id: 'c6', name: 'Maha Yousef', phone: '+966500000006', email: 'maha@example.com', created_at: '2026-01-06' },
  { id: 'c7', name: 'Laila Omar', phone: '+966500000007', email: 'laila@example.com', created_at: '2026-01-07' },
];
const AG = { agreed_version: '2026-11-05', agreed_at: '2026-11-01T10:00:00Z' };
const volunteers = [
  { customer_id: 'c1', status: 'active', tags: [], ...AG, days: [4], profile_at: '2026-11-01T09:00:00Z', created_at: '2026-11-01T10:00:00Z', motive: 'community' },
  { customer_id: 'c2', status: 'active', tags: [], ...AG, days: [4], profile_at: '2026-11-02T09:00:00Z', created_at: '2026-11-02T10:00:00Z' },
  { customer_id: 'c3', status: 'applied', tags: [], days: [5], skills: 'Photography', profile_at: ago(72), created_at: ago(72), motive: 'learn' },
  { customer_id: 'c5', status: 'applied', tags: [], days: [0], profile_at: ago(2), created_at: ago(2) },
  { customer_id: 'c6', status: 'active', tags: [], ...AG, created_at: '2026-11-03T10:00:00Z' },
  { customer_id: 'c7', status: 'active', tags: [], ...AG, created_at: '2026-11-03T10:00:00Z' },
];
const shifts = [
  { id: 1, session_id: SOON, customer_id: 'c1', status: 'accepted', plan_leave: '15:30', coming_at: ago(5), created_at: ago(100) },
  { id: 2, session_id: SOON, customer_id: 'c2', status: 'accepted', plan_leave: null, coming_at: null, created_at: ago(100) },
  { id: 3, session_id: SOON, customer_id: 'c3', status: 'interested', created_at: ago(74) },
  { id: 4, session_id: SOON, customer_id: 'c5', status: 'interested', created_at: ago(2) },
  { id: 5, session_id: SOON, customer_id: 'c6', status: 'withdrawn', withdraw_reason: 'travel', created_at: ago(90) },
  { id: 6, session_id: SOON, customer_id: 'c7', status: 'declined', decline_reason: 'full', created_at: ago(90) },
  { id: 7, session_id: PAST, customer_id: 'c1', status: 'done', clock_in: '2026-10-20T14:00:00Z', clock_out: '2026-10-20T17:00:00Z', created_at: '2026-10-01T10:00:00Z' },
  { id: 8, session_id: PAST, customer_id: 'c2', status: 'done', clock_in: '2026-10-20T14:00:00Z', clock_out: '2026-10-20T17:00:00Z', created_at: '2026-10-01T10:00:00Z' },
];
const startIso = new Date(Date.parse(`${ksa(1)}T17:00:00+03:00`) + 8 * 3600e3).toISOString();
const switched = { session_id: SOON, enabled: true, closes_at: startIso, opens_at: null, needed: 5, briefing: 'Gate 3', signup_open: true, caps: { checkin: true }, hours_mode: 'clock', roles: [] };
const pastSw = { ...switched, session_id: PAST, closes_at: '2026-10-21T20:00:00+00:00' };
const volunteer_feedback = [
  { id: 1, shift_id: 7, session_id: PAST, customer_id: 'c1', rating: 5, again: 'yes', comment: 'Great team, well briefed', created_at: '2026-10-21T09:00:00Z', updated_at: '2026-10-21T09:00:00Z' },
  { id: 2, shift_id: 8, session_id: PAST, customer_id: 'c2', rating: 4, again: 'maybe', comment: null, created_at: '2026-10-21T10:00:00Z', updated_at: '2026-10-21T10:00:00Z' },
  { id: 3, shift_id: 99, session_id: 'elsewhere', customer_id: 'c3', rating: 1, again: 'no', comment: 'Not this one', created_at: '2026-10-21T10:00:00Z', updated_at: '2026-10-21T10:00:00Z' },
];
const fx = (x: Record<string, unknown> = {}) => ({
  sessions: [soon, past], customers, queue_entries: [], volunteers, volunteer_sessions: [switched, pastSw], volunteer_shifts: shifts,
  volunteer_hours: [{ id: 9, customer_id: 'c1', session_id: PAST, hours: 3, worked_on: '2026-10-20', source: 'session' }], promo_codes: [], volunteer_certs: [],
  volunteer_settings: [{ data: { agreement_v: '2026-11-05' } }], volunteer_log: [], volunteer_feedback, ...x,
});
async function staff(page: Page, x: Record<string, unknown> = {}) {
  await stubSupabase(page, fx(x));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await goStaffTab(page, 'volunteers');
  await expect(page.locator('#tab-volunteers .page-title')).toBeVisible();
}
// Every call to the named functions, in order, with what was sent.
function calls(page: Page, names: string[]) {
  const sent: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { const m = r.url().split('?')[0].match(/\/rpc\/([a-z_]+)$/); if (m && names.includes(m[1])) sent.push({ fn: m[1], body: r.postDataJSON() }); });
  return sent;
}
const tab = (page: Page, name: RegExp) => page.locator('#tab-volunteers .vx-tabs').getByRole('button', { name });
const row = (page: Page, id: string) => page.locator(`#vd-list .vd-row[data-cust="${id}"]`);
const app = (page: Page, id: string) => page.locator(`#va-list .vx-app[data-cust="${id}"]`);
const dlg = (page: Page) => page.locator('#confirm-modal .vm-dlg');

test.describe('@staff:volunteers Volunteer enhancements (2026-11-11)', () => {
  test('Shifts: when they leave, who confirmed, why they are not coming, Not confirmed, how long offers have waited', async ({ page }) => {
    await staff(page);
    await expect(row(page, 'c1')).toContainText('Leaves 15:30');
    await expect(row(page, 'c1').locator('.vx-coming')).toHaveText('Confirmed coming');
    await expect(row(page, 'c2').locator('.vx-coming')).toHaveCount(0);
    // The offers waiting longest are flagged after 48 hours (D10).
    await expect(row(page, 'c3').locator('.vx-wait.vx-late')).toContainText('Waiting 3 days');
    await expect(row(page, 'c5').locator('.vx-wait')).toContainText('Waiting 2 h');
    await expect(row(page, 'c5').locator('.vx-late')).toHaveCount(0);
    // Not confirmed: the session starts within 48 hours, so the filter is there; it leaves the accepted who have not said.
    await page.locator('#vd-bar .f-show').click();
    await page.locator('#vd-bar select[aria-label="Coming"]').selectOption('no');
    await expect(page.locator('#vd-list .vd-row[data-cust]')).toHaveCount(1);
    await expect(row(page, 'c2')).toBeVisible();
    await expect(row(page, 'c2').getByRole('link', { name: 'WhatsApp' })).toBeVisible(); // to ask them by hand
    await page.locator('#vd-bar select[aria-label="Coming"]').selectOption('');
    // Waiting over 48 h, under Advanced: the one offer that has.
    await page.locator('#vd-bar .filter-toggle:not(.f-show)').click();
    await page.locator('#vd-bar select[aria-label="Waiting"]').selectOption('48');
    await expect(page.locator('#vd-list .vd-row[data-cust]')).toHaveCount(1);
    await expect(row(page, 'c3')).toBeVisible();
    await page.locator('#vd-bar select[aria-label="Waiting"]').selectOption('');
    // Not coming says why.
    await page.locator('#tab-volunteers .vx-figs').getByRole('button', { name: /Not coming/ }).click();
    await expect(row(page, 'c6').locator('.vx-why')).toHaveText('Withdrew: Travelling');
    await expect(row(page, 'c7').locator('.vx-why')).toHaveText('Declined: The team is full');
  });

  test('declining an offer asks for an optional reason, sent after the decline and shown on the row', async ({ page }) => {
    const sent = calls(page, ['staff_volunteer_decide', 'staff_volunteer_reason']);
    await staff(page, { 'rpc:staff_volunteer_decide': { ok: true, n: 1, skipped: 0 }, 'rpc:staff_volunteer_reason': { ok: true, reason: 'timing' } });
    await row(page, 'c5').getByRole('button', { name: /^Decline/ }).click();
    await expect(dlg(page)).toContainText('Decline: Khalid Nasser');
    await dlg(page).getByLabel('Reason (they will see it)').selectOption('timing');
    await dlg(page).getByRole('button', { name: 'Decline', exact: true }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[0]).toEqual({ fn: 'staff_volunteer_decide', body: { p_session: SOON, p_customers: ['c5'], p_status: 'declined' } });
    expect(sent[1]).toEqual({ fn: 'staff_volunteer_reason', body: { p_customer: 'c5', p_session: SOON, p_reason: 'timing' } });
    await page.locator('#tab-volunteers .vx-figs').getByRole('button', { name: /Not coming/ }).click();
    await expect(row(page, 'c5').locator('.vx-why')).toHaveText('Declined: The timing does not fit');
    // No reason chosen: the decline alone.
    await page.locator('#tab-volunteers .vx-figs').getByRole('button', { name: /Not coming/ }).click(); // back to the team
    await row(page, 'c3').getByRole('button', { name: /^Decline/ }).click();
    await dlg(page).getByRole('button', { name: 'Decline', exact: true }).click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2].fn).toBe('staff_volunteer_decide');
  });

  test('Applications: the motive, how long each has waited, Waiting over 48 h, and Decline with a reason', async ({ page }) => {
    const sent = calls(page, ['staff_volunteer_save', 'staff_volunteer_reason']);
    await staff(page, { 'rpc:staff_volunteer_save': { ok: true }, 'rpc:staff_volunteer_reason': { ok: true, reason: 'profile' } });
    await tab(page, /Applications/).click();
    await expect(app(page, 'c3').locator('.vx-fact', { hasText: 'Why they volunteer' })).toContainText('To learn new skills');
    await expect(app(page, 'c3').locator('.vx-late')).toContainText('Waiting 3 days');
    await expect(app(page, 'c5').locator('.vx-late')).toHaveCount(0);
    await page.locator('#va-bar .f-show').click();
    await expect(page.locator('#va-bar select[aria-label="Sort"] option').first()).toHaveText('Waiting longest');
    await page.locator('#va-bar select[aria-label="Waiting"]').selectOption('48');
    await expect(page.locator('#va-list .vx-app')).toHaveCount(1);
    await app(page, 'c3').getByRole('button', { name: /^Decline/ }).click();
    await dlg(page).getByLabel('Reason (they will see it)').selectOption('profile');
    await dlg(page).getByRole('button', { name: 'Decline', exact: true }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[0]).toEqual({ fn: 'staff_volunteer_save', body: { p_customer: 'c3', p_status: 'removed' } });
    expect(sent[1]).toEqual({ fn: 'staff_volunteer_reason', body: { p_customer: 'c3', p_reason: 'profile' } }); // no session: the application
    await expect(app(page, 'c3')).toHaveCount(0);
  });

  test('close-out: Thank the team says when and to how many; Feedback shows the average, again and every comment', async ({ page }) => {
    const sent = calls(page, ['staff_volunteer_thanks']);
    await staff(page, { 'rpc:staff_volunteer_thanks': { ok: true, sent: 2, new: 2 } });
    await page.locator('#tab-volunteers .vd-sel').selectOption(PAST);
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Thank the team' }).click();
    await expect(dlg(page).locator('#vx-thx')).toHaveValue(/Thank you for giving your time at/);
    await dlg(page).locator('#vx-thx').fill('Thank you all, the donors loved it.');
    await dlg(page).getByRole('button', { name: 'Send to 2' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toEqual({ p_session: PAST, p_note: 'Thank you all, the donors loved it.' });
    await expect(dlg(page)).toHaveCount(0); // no bar: the heading says it
    await expect(page.locator('#tab-volunteers .vx-sess .vx-thx')).toContainText(' to 2');
    await expect(page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Edit the thank-you' })).toBeVisible();
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Feedback' }).click();
    await expect(dlg(page).locator('.vx-fb-avg')).toContainText('4.5');
    await expect(dlg(page).locator('.vx-fb-avg')).toContainText('Answers: 2'); // the other event's answer is not counted
    await expect(dlg(page).locator('.vx-fb-sum .vx-c-yes')).toContainText('1');
    await expect(dlg(page).locator('.vx-fb-sum .vx-c-ask')).toContainText('1');
    await expect(dlg(page).locator('.vx-fb-row')).toHaveCount(2);
    await expect(dlg(page).locator('.vx-fb-row').first()).toContainText('Sara Haddad'); // staff may see names
    await expect(dlg(page).locator('.vx-fb-row').first()).toContainText('Great team, well briefed');
    await expect(dlg(page).locator('.vx-fb-row').first().locator('.vx-star.on')).toHaveCount(5);
  });

  test('the opportunity\'s details for volunteers are saved after the session, all thirteen together', async ({ page }) => {
    const sent = calls(page, ['staff_volunteer_session_save', 'staff_volunteer_details_save']);
    await staff(page, {
      'rpc:staff_volunteer_session_save': { ok: true },
      'rpc:staff_volunteer_details_save': { ok: true, details: { meet_point: 'Gate 3', meet_map: 'https://maps.app.goo.gl/abc', bring: null, provided: null, shirt_pickup: null, demands: null, contact_name: 'Huda', contact_phone: '+966501234567', partner: 'Saudi Red Crescent', partner_ar: null, skills: null, skills_ar: null, gender: 'female' } },
    });
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Volunteer settings' }).click();
    await expect(dlg(page).getByRole('heading', { name: 'Details for volunteers' })).toBeVisible();
    await dlg(page).getByLabel('Meeting point').fill('  Gate 3 ');
    await dlg(page).getByLabel('Map link').fill('http://maps.example/abc');
    await dlg(page).getByLabel('Contact on the day (staff)').fill('Huda');
    await dlg(page).getByLabel('Contact’s mobile').fill('0501234567');
    await dlg(page).getByLabel('Partner or co-host', { exact: true }).fill('Saudi Red Crescent');
    await dlg(page).getByLabel('Who can join').selectOption('female');
    await dlg(page).getByRole('button', { name: 'Save' }).click();
    // An http:// map link is refused here, beside its field, before the details go anywhere.
    await expect(dlg(page).locator('.vsf-err')).toHaveText('The map link must start with https://');
    await expect(dlg(page).locator('#vsf-d-meet-map')).toHaveAttribute('aria-invalid', 'true');
    expect(sent.filter((x) => x.fn === 'staff_volunteer_details_save')).toHaveLength(0);
    await dlg(page).locator('#vsf-d-meet-map').fill('https://maps.app.goo.gl/abc');
    await dlg(page).getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => sent.filter((x) => x.fn === 'staff_volunteer_details_save').length).toBe(1);
    const det = sent.filter((x) => x.fn === 'staff_volunteer_details_save')[0].body;
    expect(det).toEqual({ p_session: SOON, p_data: { meet_point: 'Gate 3', meet_map: 'https://maps.app.goo.gl/abc', bring: '', provided: '', shirt_pickup: '', demands: '', contact_name: 'Huda', contact_phone: '+966501234567', partner: 'Saudi Red Crescent', partner_ar: '', skills: '', skills_ar: '', gender: 'female' } });
    // The session's own save went first, each time.
    expect(sent.map((x) => x.fn)).toEqual(['staff_volunteer_session_save', 'staff_volunteer_session_save', 'staff_volunteer_details_save']);
    await expect(dlg(page)).toHaveCount(0);
    await expect(page.locator('#tab-volunteers .vx-sess .vx-who')).toHaveText('Women only');
  });

  test('a detail the database refuses is said beside the field it names', async ({ page }) => {
    await staff(page, {
      'rpc:staff_volunteer_session_save': { ok: true },
      'rpc:staff_volunteer_details_save': { __rpcError: { status: 400, code: '22023', message: 'BAD_INPUT', details: 'partner' } },
    });
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Volunteer settings' }).click();
    await dlg(page).getByLabel('Partner or co-host', { exact: true }).fill('Somebody');
    await dlg(page).getByRole('button', { name: 'Save' }).click();
    await expect(dlg(page).locator('#vsf-d-partner')).toHaveAttribute('aria-invalid', 'true');
    await expect(dlg(page).locator('#vsf-d-partner + .vsf-err')).toHaveText('This detail could not be saved as it is.');
    await expect(dlg(page).locator('.vsf-err')).toHaveCount(1);
    await expect(dlg(page)).toBeVisible(); // nothing closed on a refusal
  });

  test('Settings: the youngest age (blank is the default) and returning volunteers accepted automatically', async ({ page }) => {
    const sent = calls(page, ['staff_volunteer_settings_save']);
    await staff(page, { 'rpc:staff_volunteer_settings_save': { ok: true } });
    await tab(page, /Settings/).click();
    const age = page.getByLabel('Youngest volunteer age');
    await expect(age).toHaveValue('18');
    await age.fill('16');
    await age.blur();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toEqual({ p_data: { min_age: 16 } });
    await page.getByLabel('Youngest volunteer age').fill('');
    await page.getByLabel('Youngest volunteer age').blur();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].body).toEqual({ p_data: { min_age: null } });
    const ret = page.locator('#tab-volunteers .vm-switch', { hasText: 'Accept returning volunteers automatically' }).locator('input');
    await expect(ret).toBeChecked(); // on unless turned off (D10)
    await ret.uncheck();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2].body).toEqual({ p_data: { auto_returning: false } });
  });

  test('the person\'s window shows why they volunteer', async ({ page }) => {
    await staff(page);
    await tab(page, /People/).click();
    await page.locator('#vm-list .vm-row[data-cust="c1"]').getByRole('button', { name: /^Manage/ }).click();
    await expect(dlg(page).locator('.vx-mot')).toHaveText('Why they volunteer: To give back to the community');
  });

  test('a certificate is filled with the Saudi field set: role, skills, partner, the issue date and the QR code of its check address', async ({ page }) => {
    await staff(page);
    const v = await page.evaluate(async () => {
      type Fn = (...a: unknown[]) => unknown;
      type QrApi = { paint: (cv: HTMLCanvasElement, text: string, o: unknown) => boolean };
      const w = window as unknown as { _loadQrcode: () => Promise<void>; _vcView: (c: Record<string, unknown>) => Record<string, string>; eval: (s: string) => unknown } & Record<string, Fn>;
      await w._loadQrcode();
      const seen: string[] = [];
      const Q = w.eval('QR') as QrApi; // a top-level const, not a property of window
      const paint = Q.paint;
      Q.paint = (cv: HTMLCanvasElement, text: string, o: unknown) => { seen.push(text); return paint(cv, text, o); };
      const ev = w._vcView({ kind: 'session', name: 'Sara Haddad', serial: 'MMV-2026-00012', code: 'ABCD12345678', initiative: 'Blood drive', event_date: '2026-10-20', issued_at: '2026-10-22T09:00:00Z', hours: 3, role: 'Check-in desk', skills: 'Crowd care', skills_ar: 'إدارة الحشود', partner: 'SRCA', partner_ar: 'الهلال الأحمر' });
      const per = w._vcView({ kind: 'period', name: 'Sara Haddad', serial: 'MMV-2026-00013', from: '2026-10-01', to: '2026-10-20', issued_at: '2026-10-22T09:00:00Z', hours: 6 });
      const none = w._vcView({ kind: 'period', name: 'Sara Haddad', from: '2026-10-01', to: '2026-10-20', issued_at: '2026-10-22', hours: 6 });
      Q.paint = paint;
      return { ev, per, none, seen };
    });
    expect(v.ev).toMatchObject({ role: 'Check-in desk', skills: 'Crowd care', skills_ar: 'إدارة الحشود', partner: 'SRCA', partner_ar: 'الهلال الأحمر', issued: '22 October 2026', event_date: '20 October 2026' });
    expect(v.ev.qr).toMatch(/^data:image\/png;base64,/);
    expect(v.seen[0]).toBe('https://volunteer.micromobility.sa/#check/ABCD12345678');
    // A period certificate's date already is the day it was issued: no second line. Nothing it lacks is filled.
    expect(v.per).toMatchObject({ issued: '', role: '', skills: '', partner: '' });
    expect(v.none.qr).toBe(''); // no code, nothing to check
  });
});
