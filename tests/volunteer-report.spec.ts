import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb, goStaffTab } from './helpers/supabase';

// The volunteer report builder (the user, 2026-11-12: "create me a report builder for volunteers in the volunteering
// sessions"): from Shifts, Opportunities and an opportunity's menu, the volunteers of one opportunity or several on a PDF
// or an Excel workbook, with starting sets, columns, sections, filters, sorts and groupings. All Supabase traffic is
// stubbed; the upcoming opportunity is dated from now, so nothing turns over at midnight.
const ksa = (days: number) => new Date(Date.now() + 3 * 3600e3 + days * 864e5).toISOString().slice(0, 10);
const SOON = `${ksa(1)}-vl`;
const PAST = '2026-10-20-bd';
const base = { status: 'open', capacity: 500, created_at: 1, event_kind: 'community', ride_kind: 'community', needs_approval: false, hide_queue: true, spots: 500, open_to_all: true, bike_slots: '{"_time":"17:00 - 23:00"}' };
const soon = { ...base, id: SOON, session_date: ksa(1), day: 'Thursday' };
const past = { ...base, id: PAST, session_date: '2026-10-20', day: 'Tuesday', ride_kind: 'blood' };
const customers = [
  { id: 'c1', name: 'Sara Haddad', phone: '+966500000001', email: 'sara@example.com', created_at: '2026-01-01', birth_date: '1990-01-01', gender: 'female', nationality: 'Saudi Arabia', emergency_name: 'Huda Haddad', emergency_phone: '+966511111111', emergency_relation: 'parent' },
  { id: 'c2', name: 'Omar Saleh', phone: '+966500000002', email: 'omar@example.com', created_at: '2026-01-02', birth_date: '2001-03-01', gender: 'male', nationality: 'Egypt' },
  { id: 'c3', name: 'Nora Ali', phone: '+966500000003', email: 'nora@example.com', created_at: '2026-01-03' },
  { id: 'c6', name: 'Maha Yousef', phone: '+966500000006', email: 'maha@example.com', created_at: '2026-01-06', gender: 'female' },
  { id: 'c7', name: 'Laila Omar', phone: '+966500000007', email: 'laila@example.com', created_at: '2026-01-07' },
];
const AG = { agreed_version: '2026-11-05', agreed_at: '2026-11-01T10:00:00Z' };
const volunteers = [
  { customer_id: 'c1', status: 'active', tags: ['Photographer'], ...AG, shirt: 'M', skills: 'First aid', days: [4], created_at: '2026-11-01T10:00:00Z' },
  { customer_id: 'c2', status: 'active', tags: [], ...AG, shirt: 'L', created_at: '2026-11-02T10:00:00Z' },
  { customer_id: 'c3', status: 'active', tags: [], ...AG, created_at: '2026-11-03T10:00:00Z' },
  { customer_id: 'c6', status: 'active', tags: [], ...AG, shirt: 'M', created_at: '2026-11-03T10:00:00Z' },
  { customer_id: 'c7', status: 'active', tags: [], ...AG, created_at: '2026-11-03T10:00:00Z' },
];
const shifts = [
  { id: 1, session_id: SOON, customer_id: 'c1', status: 'accepted', role: 'Gate', coming_at: '2026-11-10T10:00:00Z', created_at: '2026-11-05T10:00:00Z' },
  { id: 2, session_id: SOON, customer_id: 'c2', status: 'accepted', created_at: '2026-11-04T10:00:00Z' },
  { id: 3, session_id: SOON, customer_id: 'c3', status: 'interested', created_at: '2026-11-06T10:00:00Z' },
  { id: 4, session_id: SOON, customer_id: 'c6', status: 'withdrawn', withdraw_reason: 'travel', created_at: '2026-11-06T10:00:00Z' },
  { id: 5, session_id: SOON, customer_id: 'c7', status: 'declined', decline_reason: 'full', created_at: '2026-11-06T10:00:00Z' },
  { id: 7, session_id: PAST, customer_id: 'c1', status: 'done', role: 'Gate', lead: true, clock_in: '2026-10-20T14:00:00Z', clock_out: '2026-10-20T17:00:00Z', created_at: '2026-10-01T10:00:00Z' },
  { id: 8, session_id: PAST, customer_id: 'c2', status: 'done', role: 'Water', clock_in: '2026-10-20T14:00:00Z', clock_out: '2026-10-20T16:30:00Z', created_at: '2026-10-02T10:00:00Z' },
  { id: 9, session_id: PAST, customer_id: 'c6', status: 'no_show', created_at: '2026-10-03T10:00:00Z' },
];
const startIso = new Date(Date.parse(`${ksa(1)}T17:00:00+03:00`) + 8 * 3600e3).toISOString();
const soonSw = { session_id: SOON, enabled: true, closes_at: startIso, opens_at: null, needed: 5, signup_open: true, caps: { checkin: true }, hours_mode: 'clock', roles: ['Gate'], role_needs: [] };
const pastSw = { ...soonSw, session_id: PAST, closes_at: '2026-10-21T20:00:00+00:00', needed: 4, roles: ['Gate', 'Water'], role_needs: [{ name: 'Gate', needed: 2 }, { name: 'Water', needed: 1 }] };
const fx = () => ({
  sessions: [soon, past], customers, queue_entries: [], volunteers, volunteer_sessions: [soonSw, pastSw], volunteer_shifts: shifts,
  volunteer_hours: [{ id: 9, customer_id: 'c1', session_id: PAST, hours: 3, worked_on: '2026-10-20', source: 'session' }],
  promo_codes: [{ id: 'p1', code: 'VL-SARA01', uses: 0, active: true, expires_at: '2099-12-09T20:59:59Z', customer_id: 'c1', volunteer_session_id: PAST, created_at: '2026-10-21T10:00:00Z' }],
  volunteer_certs: [{ id: 'v1', serial: 'MMV-2026-00001', code: 'ABCDEFGHJKLM', kind: 'session', name: 'Sara Haddad', session_id: PAST, customer_id: 'c1', hours: 3, issued_at: '2026-10-21T10:00:00Z', issued_by: 'auto' }],
  volunteer_feedback: [
    { id: 1, shift_id: 7, session_id: PAST, customer_id: 'c1', rating: 5, again: 'yes', comment: 'Great team', created_at: '2026-10-21T09:00:00Z', updated_at: '2026-10-21T09:00:00Z' },
    { id: 2, shift_id: 8, session_id: PAST, customer_id: 'c2', rating: 4, again: 'maybe', comment: null, created_at: '2026-10-21T10:00:00Z', updated_at: '2026-10-21T10:00:00Z' },
  ],
  volunteer_settings: [{ data: { agreement_v: '2026-11-05' } }], volunteer_log: [],
});
async function staff(page: Page) {
  await stubSupabase(page, fx());
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate("localStorage.removeItem('cq_vol_rep_opts')");
  await goStaffTab(page, 'volunteers');
  await expect(page.locator('#tab-volunteers .page-title')).toBeVisible();
}
const dlg = (page: Page) => page.locator('#print-opts-modal');
const count = (page: Page) => dlg(page).locator('#vb-count');
const opp = (page: Page, id: string) => dlg(page).locator(`[data-rep="opp:${id}"]`);
// The rows a choice of options keeps, as "name@session", built from the dialog's read.
const kept = (page: Page, o: Record<string, unknown>) => page.evaluate(`(()=>{const b=_vbBuild(S._vb.d,{..._vbDefaults(),...${JSON.stringify(o)}});return b.rows.map(r=>r.c.name+'@'+(r.sid===${JSON.stringify(PAST)}?'past':'soon')).join(',');})()`);

test.describe('@staff:volunteers Volunteer report builder (2026-11-12)', () => {
  test('from Shifts: one opportunity, its sets and filters, the PDF and the Excel workbook', async ({ page }) => {
    await staff(page);
    await page.locator('#tab-volunteers .vd-sel').selectOption(PAST);
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Report builder' }).click();
    await expect(dlg(page).locator('#dlgt-vb')).toHaveText('Volunteer report');
    await expect(opp(page, PAST)).toHaveAttribute('aria-pressed', 'true');
    await expect(opp(page, SOON)).toHaveAttribute('aria-pressed', 'false');
    // On the team by default: the two who came; the one who did not come is left off the list.
    await expect(count(page)).toContainText('On the report: 2 / 3');
    await dlg(page).locator('select[aria-label="Status"]').selectOption('ns');
    await expect(count(page)).toContainText('On the report: 1 / 3');
    await dlg(page).locator('select[aria-label="Status"]').selectOption('team');
    // A starting set picks its columns.
    await dlg(page).locator('[data-vb-set="signin"]').click();
    expect(await page.evaluate(`Object.keys(_vbOpts().cols).filter(k=>_vbOpts().cols[k]).join(',')`)).toBe('seq,name,role,phone,inAt,outAt,sign');
    const label = await page.evaluate(`_vmSessLabel(${JSON.stringify(PAST)})`);
    const hm = await page.evaluate(`[_vmHm('2026-10-20T14:00:00Z'),_vmHm('2026-10-20T16:30:00Z'),_vmHm('2026-10-20T17:00:00Z')]`) as string[];
    // The PDF: the summary, each opportunity, each role, then the list under the opportunity's heading.
    const [pop] = await Promise.all([page.waitForEvent('popup'), dlg(page).locator('.rpt-acts .btn-primary').click()]);
    await pop.waitForLoadState();
    await pop.waitForSelector('h2'); // the window opens on the tap; the sheet is written once the team is read
    const hs = await pop.evaluate(() => [...document.querySelectorAll('h2')].map((h) => (h.textContent || '').trim()));
    expect(hs).toEqual(['Each opportunity', 'Each role', `${label} · 2`]);
    const tbl = (i: number) => pop.evaluate((n) => [...document.querySelectorAll('table')[n].querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => (c.textContent || '').trim()).join('|')), i);
    // needed, on the team, came, did not come, not coming, interested, hours given, free rides, certificates, rating
    expect(await tbl(0)).toEqual([`${label}|4|2|2|1|0|0|3|1|1|4.5`]);
    expect(await tbl(1)).toEqual(['Gate|2|1|1|0|3', 'Water|1|1|1|0|0', 'No role|—|0|0|1|0']);
    expect(await tbl(2)).toEqual([`1|Omar Saleh|Water|+966500000002|${hm[0]}|${hm[1]}|`, `2|Sara Haddad|Gate|+966500000001|${hm[0]}|${hm[2]}|`]);
    await expect(pop.locator('.total-item')).toHaveCount(7); // the summary's tiles, the rating among them
    await pop.close();
    // Excel: the list, each opportunity and each role; no Signature column on a sheet.
    const [dl] = await Promise.all([page.waitForEvent('download'), dlg(page).locator('.rpt-acts .btn-secondary', { hasText: 'Excel' }).click()]);
    expect(dl.suggestedFilename()).toBe('volunteers_2026-10-20_signin.xlsx');
    const buf = readFileSync((await dl.path())!).toString('utf8');
    for (const n of ['Volunteer list', 'Each opportunity', 'Each role']) expect(buf).toContain(`name="${n}"`);
    const s1 = buf.slice(buf.indexOf('<worksheet'), buf.indexOf('</worksheet>'));
    expect(s1.indexOf('Omar Saleh')).toBeLessThan(s1.indexOf('Sara Haddad'));
    expect(s1).not.toContain('Maha Yousef');
    expect(s1).not.toContain('Signature');
  });

  test('several opportunities: ticked in the dialog, grouped by day, and every filter and sort', async ({ page }) => {
    await staff(page);
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Report builder' }).click();
    await expect(opp(page, SOON)).toHaveAttribute('aria-pressed', 'true');
    await expect(count(page)).toContainText('On the report: 2 / 5');
    await dlg(page).locator('.rr-presets').first().getByRole('button', { name: 'All' }).click();
    await expect(opp(page, PAST)).toHaveAttribute('aria-pressed', 'true');
    await expect(count(page)).toContainText('On the report: 4 / 8');
    // Grouped by opportunity, the earlier day first; inside each, by name.
    expect(await kept(page, {})).toBe('Omar Saleh@past,Sara Haddad@past,Omar Saleh@soon,Sara Haddad@soon');
    expect(await kept(page, { fState: 'asked' })).toBe('Nora Ali@soon');
    expect(await kept(page, { fState: 'off' })).toBe('Laila Omar@soon,Maha Yousef@soon');
    expect(await kept(page, { fState: 'ns' })).toBe('Maha Yousef@past');
    expect(await kept(page, { fState: 'came', fHrs: 'due' })).toBe('Omar Saleh@past');
    expect(await kept(page, { fReward: 'code' })).toBe('Sara Haddad@past');
    expect(await kept(page, { fConf: 'no' })).toBe('Omar Saleh@soon');
    expect(await kept(page, { fRole: 'Gate', group: 'none' })).toBe('Sara Haddad@past,Sara Haddad@soon');
    expect(await kept(page, { fLead: 'yes' })).toBe('Sara Haddad@past');
    expect(await kept(page, { fNat: 'sa', group: 'none' })).toBe('Sara Haddad@past,Sara Haddad@soon');
    expect(await kept(page, { fMiss: 'em', group: 'none' })).toBe('Omar Saleh@past,Omar Saleh@soon');
    expect(await kept(page, { fTag: 'Photographer', group: 'none', sort: 'nameZ' })).toBe('Sara Haddad@past,Sara Haddad@soon');
    expect(await kept(page, { group: 'none', sort: 'worked' })).toBe('Sara Haddad@past,Omar Saleh@past,Omar Saleh@soon,Sara Haddad@soon');
    expect(await kept(page, { fState: 'all', group: 'state', sort: 'name' })).toBe('Omar Saleh@soon,Sara Haddad@soon,Omar Saleh@past,Sara Haddad@past,Nora Ali@soon,Maha Yousef@past,Laila Omar@soon,Maha Yousef@soon');
    // Each opportunity counts every status, with a total line; the list follows the filters.
    const t = await page.evaluate(`(()=>{const b=_vbBuild(S._vb.d,_vbDefaults());const T=_vbTally(b);return [T.sess.map(r=>r.slice(1).join('|')),T.sessTotal.slice(1).join('|')];})()`);
    expect(t).toEqual([['4|2|2|1|0|0|3|1|1|4.5', '5|2|0|0|2|1|0|0|0|'], '9|4|2|1|2|1|3|1|1|4.5']);
    // Unticking the last one says so, and Print does nothing.
    await dlg(page).locator('.rr-presets').first().getByRole('button', { name: 'None' }).click();
    await expect(count(page)).toHaveText('Pick at least one opportunity.');
  });

  test('Opportunities: the builder for its view and on each opportunity\'s menu; the feedback set', async ({ page }) => {
    await staff(page);
    await page.locator('#tab-volunteers .vx-tabs').getByRole('button', { name: 'Opportunities' }).click();
    await page.locator('#tab-volunteers .vx-seg').getByRole('button', { name: 'Past' }).click();
    await page.locator('#tab-volunteers .vx-hacts').getByRole('button', { name: 'Report builder' }).click();
    await expect(opp(page, PAST)).toHaveAttribute('aria-pressed', 'true');
    await expect(opp(page, SOON)).toHaveAttribute('aria-pressed', 'false');
    await dlg(page).getByRole('button', { name: 'Close' }).click();
    await page.locator('#tab-volunteers .vx-seg').getByRole('button', { name: 'Upcoming' }).click();
    const row = page.locator(`#tab-volunteers .vm-row-s[data-sess="${SOON}"]`);
    await row.locator('.rq-more').first().click();
    await page.getByRole('menuitem', { name: 'Report builder', exact: true }).click();
    await expect(opp(page, SOON)).toHaveAttribute('aria-pressed', 'true');
    await expect(opp(page, PAST)).toHaveAttribute('aria-pressed', 'false');
    await opp(page, PAST).click();
    await opp(page, SOON).click();
    await expect(count(page)).toContainText('On the report: 2 / 3');
    // The feedback set: only those who rated, highest first, with the feedback section; leaving it puts those back.
    await dlg(page).locator('[data-vb-set="feedback"]').click();
    await expect(count(page)).toContainText('On the report: 2 / 3');
    expect(await page.evaluate(`(()=>{const b=_vbBuild(S._vb.d,_vbOpts());return b.rows.map(r=>r.c.name+' '+_vbCell('rating',r)+' '+_vbCell('again',r)).join(',');})()`)).toBe('Sara Haddad 5 Yes,Omar Saleh 4 Maybe');
    const [pop] = await Promise.all([page.waitForEvent('popup'), dlg(page).locator('.rpt-acts .btn-primary').click()]);
    await pop.waitForSelector('h2');
    const hs = await pop.evaluate(() => [...document.querySelectorAll('h2')].map((h) => (h.textContent || '').trim()));
    expect(hs[0]).toBe('Feedback · 2');
    await expect(pop.locator('body')).toContainText('Great team');
    await pop.close();
    await dlg(page).locator('[data-vb-set="team"]').click();
    expect(await page.evaluate(`(()=>{const o=_vbOpts();return [o.fRated,o.sort,o.secs.fb,o.secs.summary].join(',');})()`)).toBe('all,name,0,1');
  });
});
