import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, goStaffTab } from './helpers/supabase';

// Staff rate volunteers (2026-11-15, migration 20261115230000; the user: "add a feature that allows staff to rate volunteers
// and for them to have an average rating and add comments with the rating, request a rating for each volunteer after each
// volunteering experience"). One rating for each shift worked, 1 to 5 stars and an optional comment; the average on People,
// on an offer waiting for an answer and in the person's window; the request once their part is over: Rate on the row, Rate
// the team, the line on Shifts naming the opportunities of the last 30 days still waiting, and the Shifts tab's count. All
// Supabase traffic is stubbed; the dates are relative to now (Saudi time), so nothing turns over at midnight.
const ksa = (days: number) => new Date(Date.now() + 3 * 3600e3 + days * 864e5).toISOString().slice(0, 10);
const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
const SOON = `${ksa(1)}-vl`; // tomorrow: the page opens on it
const PAST = `${ksa(-3)}-bd`; // three days ago: inside the 30 days the request covers
const OLD = `${ksa(-60)}-vl`; // two months ago: rated from its rows, never asked for on Shifts
const base = { status: 'open', capacity: 500, created_at: 1, event_kind: 'community', ride_kind: 'community', needs_approval: false, hide_queue: true, spots: 500, open_to_all: true, bike_slots: '{"_time":"17:00 - 23:00"}' };
const sess = (id: string, d: string) => ({ ...base, id, session_date: d, day: 'Thursday' });
const customers = [
  { id: 'c1', name: 'Sara Haddad', phone: '+966500000001', email: 'sara@example.com', created_at: '2026-01-01' },
  { id: 'c2', name: 'Omar Saleh', phone: '+966500000002', email: 'omar@example.com', created_at: '2026-01-02' },
  { id: 'c3', name: 'Nora Ali', phone: '+966500000003', email: 'nora@example.com', created_at: '2026-01-03' },
  { id: 'c6', name: 'Maha Yousef', phone: '+966500000006', email: 'maha@example.com', created_at: '2026-01-06' },
];
const AG = { agreed_version: '2026-11-05', agreed_at: '2026-11-01T10:00:00Z', created_at: '2026-11-01T10:00:00Z' };
const volunteers = ['c1', 'c2', 'c3', 'c6'].map((id) => ({ customer_id: id, status: 'active', tags: [], ...AG }));
const inAt = (d: string, h: number) => `${d}T${String(h).padStart(2, '0')}:00:00+03:00`;
const shifts = [
  { id: 1, session_id: PAST, customer_id: 'c1', status: 'done', clock_in: inAt(ksa(-3), 17), clock_out: inAt(ksa(-3), 20), created_at: ago(300) },
  { id: 2, session_id: PAST, customer_id: 'c2', status: 'done', clock_in: inAt(ksa(-3), 17), clock_out: inAt(ksa(-3), 20), created_at: ago(300) },
  { id: 3, session_id: PAST, customer_id: 'c3', status: 'accepted', created_at: ago(300) }, // never came: nothing to rate
  { id: 4, session_id: OLD, customer_id: 'c1', status: 'done', created_at: ago(1600) },
  { id: 5, session_id: OLD, customer_id: 'c6', status: 'done', created_at: ago(1600) },
  { id: 6, session_id: OLD, customer_id: 'c2', status: 'done', created_at: ago(1600) },
  { id: 7, session_id: SOON, customer_id: 'c1', status: 'accepted', created_at: ago(10) },
  { id: 8, session_id: SOON, customer_id: 'c6', status: 'interested', created_at: ago(5) },
];
const rate = (id: number, shift: number, sid: string, cid: string, rating: number, comment: string | null, by: string) =>
  ({ id, shift_id: shift, session_id: sid, customer_id: cid, rating, comment, rated_by: by, created_at: ago(40), updated_at: ago(40) });
const volunteer_ratings = [
  rate(1, 1, PAST, 'c1', 4, 'Calm at the gate', 'Malik'),
  rate(2, 4, OLD, 'c1', 1, null, 'Huda'),
  rate(3, 5, OLD, 'c6', 5, 'Brilliant', 'Malik'),
];
const sw = (sid: string, closes: string) => ({ session_id: sid, enabled: true, closes_at: closes, opens_at: null, needed: 5, signup_open: true, caps: { checkin: true }, hours_mode: 'clock', roles: [] });
const award = (id: number, sid: string, cid: string, on: string) => ({ id, customer_id: cid, session_id: sid, hours: 3, worked_on: on, source: 'session' });
const fx = () => ({
  sessions: [sess(SOON, ksa(1)), sess(PAST, ksa(-3)), sess(OLD, ksa(-60))], customers, queue_entries: [], volunteers,
  volunteer_sessions: [sw(SOON, new Date(Date.now() + 3 * 864e5).toISOString()), sw(PAST, ago(48)), sw(OLD, ago(1400))], volunteer_shifts: shifts,
  volunteer_hours: [award(1, PAST, 'c1', ksa(-3)), award(2, PAST, 'c2', ksa(-3))], promo_codes: [], volunteer_certs: [],
  volunteer_settings: [{ data: { agreement_v: '2026-11-05' } }], volunteer_log: [], volunteer_feedback: [], volunteer_ratings,
});
async function staff(page: Page, x: Record<string, unknown> = {}, noTable = false) {
  const f: Record<string, unknown> = { ...fx(), ...x };
  if (noTable) delete f.volunteer_ratings; // a database before 20261115230000
  await stubSupabase(page, f);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await goStaffTab(page, 'volunteers');
  await expect(page.locator('#tab-volunteers .page-title')).toBeVisible();
}
function calls(page: Page, names: string[]) {
  const sent: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { const m = r.url().split('?')[0].match(/\/rpc\/([a-z_]+)$/); if (m && names.includes(m[1])) sent.push({ fn: m[1], body: r.postDataJSON() }); });
  return sent;
}
const tab = (page: Page, name: RegExp) => page.locator('#tab-volunteers .vx-tabs').getByRole('button', { name });
const row = (page: Page, id: string) => page.locator(`#vd-list .vd-row[data-cust="${id}"]`);
const person = (page: Page, id: string) => page.locator(`#vm-list .vm-row[data-cust="${id}"]`);
const dlg = (page: Page) => page.locator('#confirm-modal .vm-dlg');
const toast = (page: Page) => page.locator('#toast-live, #toast-container').first();
const order = (page: Page) => page.locator('#vm-list .vm-row').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-cust')));
const saved = (o: Record<string, unknown>) => ({ ok: true, id: 9, shift_id: 2, created_at: ago(0), updated_at: ago(0), rated_by: 'Malik', ...o });

test.describe('@staff:volunteers Staff rate volunteers (2026-11-15)', () => {
  test('Shifts asks for the ratings still owed, and Rate the team saves each one given stars', async ({ page }) => {
    const sent = calls(page, ['staff_volunteer_rate']);
    await staff(page, { 'rpc:staff_volunteer_rate': saved({ rating: 5, comment: 'Kind and quick', avg: 5, n: 1 }) });
    // The page opens on tomorrow's opportunity: the Shifts count is the offer waiting plus the one rating owed, and the line
    // names the opportunity three days ago (the one two months ago is older than the request covers).
    await expect(tab(page, /Shifts/).locator('.vx-tab-n')).toHaveText('2');
    const line = page.locator('#tab-volunteers .vrt-other');
    await expect(line).toContainText('Waiting for your rating');
    await expect(line.getByRole('button')).toHaveCount(1);
    await expect(line.getByRole('button')).toContainText('· 1');
    // The offer waiting for an answer carries the person's average, to decide on it.
    await expect(row(page, 'c6').locator('.vrt-avg')).toContainText('5.0');
    await line.getByRole('button').click();
    await expect(dlg(page)).toContainText('Rate the team');
    await expect(dlg(page).locator('.vrt-row')).toHaveCount(1); // only Omar: Sara is rated, Nora never came
    await dlg(page).getByRole('button', { name: 'Save rating' }).click();
    await expect(toast(page)).toContainText('Choose the stars first.');
    expect(sent).toHaveLength(0);
    const g = dlg(page).getByRole('radiogroup', { name: 'Rating · Omar Saleh' });
    await g.getByRole('radio', { name: '5 out of 5' }).click();
    await expect(g.getByRole('radio', { name: '5 out of 5' })).toHaveAttribute('aria-checked', 'true');
    await expect(g.locator('.vrt-s.on')).toHaveCount(5);
    await dlg(page).locator('.vrt-row[data-cust="c2"] textarea').fill('  Kind and quick ');
    await dlg(page).getByRole('button', { name: 'Save rating' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toEqual({ p_session: PAST, p_customer: 'c2', p_rating: 5, p_comment: 'Kind and quick' });
    await expect(toast(page)).toContainText('Rating saved.');
    await expect(dlg(page)).toBeHidden();
    // On that opportunity now: Omar's row shows his five stars, nobody is left to rate, and the count is the offer alone.
    await expect(page.locator('#tab-volunteers .vd-sel')).toHaveValue(PAST);
    await expect(row(page, 'c2').locator('.vrt-chip .vx-star.on')).toHaveCount(5);
    await expect(row(page, 'c1').locator('.vrt-chip .vx-star.on')).toHaveCount(4);
    await expect(page.locator('#tab-volunteers .vrt-team')).toHaveCount(0);
    await expect(page.locator('#vd-list .vrt-rate')).toHaveCount(0);
    await expect(tab(page, /Shifts/).locator('.vx-tab-n')).toHaveText('1');
  });

  test('on the opportunity: Rate on the row of whoever worked it, a rating changed with the arrow keys, and removed', async ({ page }) => {
    const sent = calls(page, ['staff_volunteer_rate']);
    await staff(page, { 'rpc:staff_volunteer_rate': { ok: true, shift_id: 1, rating: null, avg: 1, n: 1 } });
    await page.locator('#tab-volunteers .vd-sel').selectOption(PAST);
    await expect(page.locator('#tab-volunteers .vrt-team')).toHaveText('Rate the team (1)');
    await expect(row(page, 'c2').getByRole('button', { name: 'Rate · Omar Saleh' })).toBeVisible();
    await expect(row(page, 'c3').locator('.vrt-rate')).toHaveCount(0); // accepted, never came
    await expect(row(page, 'c1').locator('.vrt-chip')).toHaveAttribute('title', 'Calm at the gate');
    await row(page, 'c1').locator('.vrt-chip').click();
    await expect(dlg(page)).toContainText('Rate Sara Haddad');
    const g = dlg(page).getByRole('radiogroup', { name: 'Rating · Sara Haddad' });
    await expect(g.getByRole('radio', { name: '4 out of 5' })).toHaveAttribute('aria-checked', 'true');
    await expect(dlg(page).locator('textarea')).toHaveValue('Calm at the gate');
    await g.getByRole('radio', { name: '4 out of 5' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(g.getByRole('radio', { name: '3 out of 5' })).toHaveAttribute('aria-checked', 'true');
    await expect(g.getByRole('radio', { name: '3 out of 5' })).toBeFocused();
    await expect(g.locator('.vrt-s.on')).toHaveCount(3);
    // Remove asks first; No goes back to the rating window as it was.
    await dlg(page).getByRole('button', { name: 'Remove rating' }).click();
    await expect(page.locator('#confirm-modal')).toContainText('Remove this rating?');
    await page.locator('#confirm-modal').getByRole('button', { name: 'No' }).click();
    await expect(dlg(page)).toContainText('Rate Sara Haddad');
    expect(sent).toHaveLength(0);
    await dlg(page).getByRole('button', { name: 'Remove rating' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Remove rating' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toEqual({ p_session: PAST, p_customer: 'c1', p_rating: null });
    await expect(toast(page)).toContainText('Rating removed.');
    await expect(row(page, 'c1').locator('.vrt-chip')).toHaveCount(0);
    await expect(row(page, 'c1').getByRole('button', { name: 'Rate · Sara Haddad' })).toBeVisible();
    await expect(page.locator('#tab-volunteers .vrt-team')).toHaveText('Rate the team (2)');
  });

  test('People: the average in its own column, the sorts and the filter, and each rating in the person\'s window', async ({ page }) => {
    await staff(page);
    await tab(page, /People/).click();
    await expect(page.locator('#vm-list .vx-th')).toContainText('Rating');
    await expect(person(page, 'c1').locator('.vm-rt-c')).toContainText('2.5');
    await expect(person(page, 'c1').locator('.vm-rt-c')).toContainText('(2)');
    await expect(person(page, 'c6').locator('.vm-rt-c')).toContainText('5.0');
    await expect(person(page, 'c2').locator('.vm-rt-c')).toBeEmpty();
    await page.locator('#vm-bar .f-show').click();
    await page.locator('#vm-bar select[aria-label="Sort"]').selectOption('rateHi');
    expect(await order(page)).toEqual(['c6', 'c1', 'c3', 'c2']); // the unrated after, by name
    await page.locator('#vm-bar select[aria-label="Sort"]').selectOption('rateLo');
    expect(await order(page)).toEqual(['c1', 'c6', 'c3', 'c2']);
    await page.locator('#vm-bar .filter-toggle:not(.f-show)').click();
    const f = page.locator('#vm-bar select[aria-label="Rating"]');
    await f.selectOption('3');
    expect(await order(page)).toEqual(['c1']);
    await f.selectOption('4');
    expect(await order(page)).toEqual(['c6']);
    await f.selectOption('none');
    expect((await order(page)).sort()).toEqual(['c2', 'c3']);
    await f.selectOption('');
    // Sara's window: the average, then each rating, the newest opportunity first, with who gave it.
    await person(page, 'c1').getByRole('button', { name: 'Manage · Sara Haddad' }).click();
    await expect(dlg(page).locator('.vrt-h')).toContainText('2.5');
    const rs = dlg(page).locator('#vm-rt .vrt-p-row');
    await expect(rs).toHaveCount(2);
    await expect(rs.nth(0)).toHaveAttribute('data-sess', PAST);
    await expect(rs.nth(0)).toContainText('Calm at the gate');
    await expect(rs.nth(0)).toContainText('Rated by Malik');
    await expect(rs.nth(1)).toContainText('Rated by Huda');
    // Omar's: the two opportunities he worked, neither rated, each with Rate (the one two months ago too); Cancel comes back.
    await page.locator('#confirm-modal .x-close').click();
    await person(page, 'c2').getByRole('button', { name: 'Manage · Omar Saleh' }).click();
    const os = dlg(page).locator('#vm-rt .vrt-p-row');
    await expect(os).toHaveCount(2);
    await expect(os.nth(0)).toContainText('Not rated yet');
    await os.nth(1).getByRole('button', { name: 'Rate' }).click();
    await expect(dlg(page)).toContainText('Rate Omar Saleh');
    await dlg(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg(page).locator('#vm-rt')).toBeVisible();
  });

  test('a database without the ratings table asks for none and shows none', async ({ page }) => {
    await staff(page, {}, true);
    await expect(tab(page, /Shifts/).locator('.vx-tab-n')).toHaveText('1'); // the offer alone
    await expect(page.locator('#tab-volunteers .vrt-other')).toHaveCount(0);
    await expect(row(page, 'c6').locator('.vrt-avg')).toHaveCount(0);
    await page.locator('#tab-volunteers .vd-sel').selectOption(PAST);
    await expect(row(page, 'c2')).toBeVisible();
    await expect(page.locator('#tab-volunteers .vrt-team')).toHaveCount(0);
    await expect(page.locator('#vd-list .vrt-rate, #vd-list .vrt-chip')).toHaveCount(0);
    await tab(page, /People/).click();
    await expect(person(page, 'c1')).toBeVisible();
    await expect(page.locator('#vm-list .vx-th')).not.toContainText('Rating');
    await expect(page.locator('#vm-list .vm-rt-c')).toHaveCount(0);
  });

  test('the report builder\'s Staff ratings set: this opportunity\'s rating, its comment and the average', async ({ page }) => {
    await staff(page);
    await page.evaluate("localStorage.removeItem('cq_vol_rep_opts')");
    await page.locator('#tab-volunteers .vd-sel').selectOption(PAST);
    await page.locator('#tab-volunteers .vd-acts').getByRole('button', { name: 'Report builder' }).click();
    const rep = page.locator('#print-opts-modal');
    await expect(rep.locator('#dlgt-vb')).toHaveText('Volunteer report');
    await rep.locator('[data-vb-set="staffrt"]').click();
    expect(await page.evaluate(`Object.keys(_vbOpts().cols).filter(k=>_vbOpts().cols[k]).join(',')`)).toBe('seq,name,role,srate,scomm,savg');
    await expect.poll(() => page.evaluate('!!(S._vb&&S._vb.d)')).toBe(true);
    expect(await page.evaluate(`(()=>{const b=_vbBuild(S._vb.d,_vbOpts());return b.rows.map(r=>[r.c.name,_vbCell('srate',r),_vbCell('scomm',r),_vbCell('savg',r)].join('|')).join(',');})()`))
      .toBe('Sara Haddad|4|Calm at the gate|2.5,Nora Ali|||,Omar Saleh|||');
  });
});
