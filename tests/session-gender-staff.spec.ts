import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Men only, women only or mixed (the owner, 2026-10-27: "i want the triathlon pool sessions to be for male only
// or female only or mixed and to be mentioned on the card and event everywhere and only allow the gender
// selected to book it and make it visible only for the gender it is for"). The staff side: the pool session's
// forms ask "Who can book", sessions.gender_only is written only when it is men or women only (or changed),
// the chip names the rule on the staff screens, and the desk refuses an account of the other gender (the
// server leaves staff's adds to staff). All Supabase traffic is stubbed.

const SWIM_F = 'swim-f', SWIM_X = 'swim-x', SAT = '2099-03-07', JCC = '2099-03-03', JCC_F = '2099-03-04';
const pool = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Thursday', session_date: date, capacity: 20, status: 'open', created_at: 2,
  event_kind: 'community', ride_kind: 'swim', needs_approval: true, hide_queue: true, paid_ride: false,
  spots: 20, title: 'Triathlon Pool Session', bike_slots: '{"_time":"18:00 - 19:30"}', ...extra,
});
const night = (id: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Tuesday', session_date: id, capacity: 20, status: 'open', created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...extra,
});
const sessions = [
  pool(SWIM_F, '2099-03-05', { gender_only: 'female' }),
  pool(SWIM_X, '2099-03-12'),
  night(SAT, { day: 'Saturday', event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 20 }),
];
const customers = [
  { id: 'm1', name: 'Omar Man', gender: 'male', created_at: '2026-01-01T00:00:00Z' },
  { id: 'w1', name: 'Huda Woman', gender: 'female', created_at: '2026-01-02T00:00:00Z' },
  { id: 'n1', name: 'Sam Unsaid', created_at: '2026-01-03T00:00:00Z' },
];

async function boot(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], tags: [], customer_tags: [], customers, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0&&(S.customers||[]).length>0');
}
/** Every row the page sends to a table, by method. */
function sent(page: Page, table: string, method: 'POST' | 'PATCH') {
  const rows: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== method || !new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) return;
    try { const b = r.postDataJSON(); rows.push(...(Array.isArray(b) ? b : [b])); } catch { /* not json */ }
  });
  return rows;
}
async function newForm(page: Page, kind: string) {
  await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.editSessionId=null;S.newSessEvent='${kind}';renderSessions()`);
  await expect(page.locator('#sess-add-form')).toBeVisible();
}
const pick = (page: Page, form: string, name: string) =>
  page.locator(form).getByRole('group', { name: 'Who can book' }).getByRole('button', { name, exact: true });

test.describe('@staff:sessions pool gender', () => {
  test('a women-only pool session is created with gender_only female', async ({ page }) => {
    await boot(page);
    const rows = sent(page, 'sessions', 'POST');
    await newForm(page, 'swim');
    await expect(pick(page, '#sess-add-form', 'Mixed')).toHaveAttribute('aria-pressed', 'true'); // mixed until staff say otherwise
    await pick(page, '#sess-add-form', 'Women only').click();
    await expect(pick(page, '#sess-add-form', 'Women only')).toHaveAttribute('aria-pressed', 'true');
    await expect(pick(page, '#sess-add-form', 'Mixed')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#ns-date').fill('2099-04-02');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ ride_kind: 'swim', gender_only: 'female' });
    await expect.poll(() => page.evaluate('S.showAddSession')).toBe(false); // made: the form closes...
    expect(await page.evaluate('S.newSessGender')).toBe('');                // ...and the next one starts mixed again
  });

  test('a mixed pool session names no gender_only at all (a database before the column takes it)', async ({ page }) => {
    await boot(page);
    const rows = sent(page, 'sessions', 'POST');
    await newForm(page, 'swim');
    await page.locator('#ns-date').fill('2099-04-02');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].ride_kind).toBe('swim');
    expect('gender_only' in rows[0]).toBe(false);
  });

  test('only the pool session asks; a pick left on it never reaches another kind', async ({ page }) => {
    await boot(page);
    const rows = sent(page, 'sessions', 'POST');
    await newForm(page, 'swim');
    await pick(page, '#sess-add-form', 'Men only').click();
    await page.evaluate(`S.newSessEvent='community';renderSessions()`);
    await expect(page.locator('#sess-add-form').getByRole('group', { name: 'Who can book' })).toHaveCount(0);
    await page.locator('#ns-date').fill('2099-04-04');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].ride_kind).toBe('saturday');
    expect('gender_only' in rows[0]).toBe(false);
  });

  test('the editor shows the session\'s own rule and writes gender_only only when it changes', async ({ page }) => {
    await boot(page);
    const patches = sent(page, 'sessions', 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SWIM_F}')`);
    const form = '#sess-edit-form';
    await expect(page.locator(form)).toBeVisible();
    await expect(page.locator(`${form} .form-title .sg-chip`)).toHaveText('Women only'); // the dialog's title says it too
    await expect(pick(page, form, 'Women only')).toHaveAttribute('aria-pressed', 'true');
    // saved untouched: nothing about it is written
    await page.locator(`${form} .ss-form-acts .btn-primary`).click();
    await expect.poll(() => page.evaluate('S.editSessionId')).toBeNull(); // the save has finished
    expect(patches.some((p) => 'ride_kind' in p)).toBe(true);
    expect(patches.some((p) => 'gender_only' in p)).toBe(false);
    // Men only now
    await page.evaluate(`startEditSession('${SWIM_F}')`);
    await pick(page, form, 'Men only').click();
    await page.locator(`${form} .ss-form-acts .btn-primary`).click();
    await expect.poll(() => patches.filter((p) => 'gender_only' in p)).toEqual([{ gender_only: 'male' }]);
  });

  test('back to Mixed writes null; a mixed pool session can be made women only', async ({ page }) => {
    await boot(page);
    const patches = sent(page, 'sessions', 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SWIM_F}')`);
    await pick(page, '#sess-edit-form', 'Mixed').click();
    await page.locator('#sess-edit-form .ss-form-acts .btn-primary').click();
    await expect.poll(() => patches.filter((p) => 'gender_only' in p)).toEqual([{ gender_only: null }]);
    await expect.poll(() => page.evaluate('S.editSessionId')).toBeNull();
    await page.evaluate(`startEditSession('${SWIM_X}')`);
    await expect(pick(page, '#sess-edit-form', 'Mixed')).toHaveAttribute('aria-pressed', 'true');
    await pick(page, '#sess-edit-form', 'Women only').click();
    await page.locator('#sess-edit-form .ss-form-acts .btn-primary').click();
    await expect.poll(() => patches.filter((p) => 'gender_only' in p)).toEqual([{ gender_only: null }, { gender_only: 'female' }]);
  });

  test('made women only with a man booked on it: staff are told, and his place stands', async ({ page }) => {
    const bk = (id: string, name: string, cid: string) => ({
      id, session_id: SWIM_X, session_day: 'Thursday', session_date: '2099-03-12', queue_num: Number(id.slice(1)), name,
      type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, customer_id: cid,
      registered_at: '2099-01-01T10:00:00Z', approval: 'approved',
    });
    await boot(page, { queue_entries: [bk('q1', 'Omar Man', 'm1'), bk('q2', 'Huda Woman', 'w1'), bk('q3', 'Sam Unsaid', 'n1')] });
    const patches = sent(page, 'sessions', 'PATCH');
    const bookings = sent(page, 'queue_entries', 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SWIM_X}')`);
    await pick(page, '#sess-edit-form', 'Women only').click();
    await page.locator('#sess-edit-form .ss-form-acts .btn-primary').click();
    await expect.poll(() => patches.filter((p) => 'gender_only' in p)).toEqual([{ gender_only: 'female' }]);
    // one man; the woman and the account with no gender on file are not counted
    await expect(page.locator('.toast.warning').filter({ hasText: 'Booked already and of the other gender: 1.' })).toBeVisible();
    expect(bookings).toHaveLength(0); // nobody is moved or cancelled by the save
  });

  test('a session that is not the pool\'s, and has no rule, is not asked', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SAT}')`);
    await expect(page.locator('#sess-edit-form')).toBeVisible();
    await expect(page.locator('#sess-edit-form').getByRole('group', { name: 'Who can book' })).toHaveCount(0);
  });

  test('a clone keeps the rule and creates the copy with it; an older template clears it', async ({ page }) => {
    await boot(page, { staff_options: [{ key: 'session_templates', items: [
      { id: 'tplA', label: 'Pool evening', form: { newSessEvent: 'swim', newSessStartTime: '18:00', newSessEndTime: '19:30' } },
    ] }] });
    const rows = sent(page, 'sessions', 'POST');
    await page.evaluate(`setStaffTab('sessions');cloneSession('${SWIM_F}')`);
    expect(await page.evaluate('S.newSessGender')).toBe('female');
    await expect(pick(page, '#sess-add-form', 'Women only')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#ns-date').fill('2099-04-09');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ ride_kind: 'swim', gender_only: 'female' });
    await expect.poll(() => page.evaluate('S.showAddSession')).toBe(false); // the create has finished
    // a template saved before the rule existed is a mixed session, whatever the last form said
    await page.evaluate(`cloneSession('${SWIM_F}')`);
    await expect(pick(page, '#sess-add-form', 'Women only')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#sess-add-form .ns-tpl-use', { hasText: 'Pool evening' }).click();
    expect(await page.evaluate('S.newSessGender')).toBe('');
    await expect(pick(page, '#sess-add-form', 'Mixed')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the chip names the rule on the Sessions list, the Bookings strip and the roster', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, { queue_entries: [{
      id: 'q1', session_id: SWIM_F, session_day: 'Thursday', session_date: '2099-03-05', queue_num: 1, name: 'Huda Woman',
      type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, customer_id: 'w1',
      registered_at: '2099-01-01T10:00:00Z', approval: 'approved',
    }] });
    await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue()`);
    const card = (id: string) => page.locator(`.sess-lc[data-on-click*='"${id}"']`);
    await expect(card(SWIM_F).locator('.sg-chip.sg-female')).toHaveText('Women only');
    await expect(card(SWIM_X).locator('.sg-chip.sg-mixed')).toHaveText('Mixed');  // the pool's mixed sessions say so
    await expect(card(SAT).locator('.sg-chip')).toHaveCount(0);                  // a ride without the choice says nothing
    await page.evaluate(`selectSessionDetail('${SWIM_F}')`);
    await expect(page.locator('.sess-detail-head .sg-chip')).toHaveText('Women only');
    // Bookings: the strip's chip, its title, and the phone's picker
    await page.evaluate(`S.queueView='bookings';S.sfSession='all';renderStaffQueue()`);
    const chip = page.locator(`.sess-summary-chip[data-on-click*='"${SWIM_F}"']`);
    await expect(chip.locator('.sg-chip')).toHaveText('Women only');
    await expect(chip).toHaveAttribute('title', /Women only/);
    await expect(page.locator(`.sess-bar-mobile option[value="${SWIM_F}"]`)).toContainText('Women only');
    // the roster's heading for that session when every session is listed
    await expect(page.locator('tr.sess-group-hdr .sg-chip.sg-female')).toHaveCount(1);
  });

  test('the Add rider dialog greys out and refuses a man on a women-only session', async ({ page }) => {
    await boot(page);
    const rows = sent(page, 'queue_entries', 'POST');
    await page.evaluate(`setStaffTab('queue');S.sfSession='${SWIM_F}';showCommAddModal()`);
    const dlg = page.locator('#comm-add-modal');
    await expect(dlg.locator('select')).toContainText('Women only');
    const man = dlg.locator('.cmy-ca-row', { hasText: 'Omar Man' });
    await expect(man).toBeDisabled();
    await expect(man).toContainText('This session is for women only.');
    await expect(dlg.locator('.cmy-ca-row', { hasText: 'Huda Woman' })).toBeEnabled();
    // picked anyway (a stale pick, a script): refused with the reason, nothing written
    await page.evaluate(`S._caSel='m1';_saveCommAdd()`);
    await expect(page.locator('.toast.error').filter({ hasText: 'Omar Man: This session is for women only.' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(rows).toHaveLength(0);
    // a woman is added, and so is an account with no gender on file (staff's judgement)
    await page.evaluate(`S._caSel='w1';_saveCommAdd()`);
    await expect.poll(() => rows.map((r) => r.customer_id)).toEqual(['w1']);
    await expect.poll(() => page.evaluate(`_busyKeys.has('commAdd')`)).toBe(false); // one add at a time
    await page.evaluate(`S._caSel='n1';_saveCommAdd()`);
    await expect.poll(() => rows.map((r) => r.customer_id)).toEqual(['w1', 'n1']);
    expect(rows.every((r) => r.session_id === SWIM_F)).toBe(true);
  });

  test('a booking is not moved onto a session for the other gender', async ({ page }) => {
    // the rule holds for any session that carries it, not only the pool's
    await boot(page, {
      sessions: [...sessions, night(JCC), night(JCC_F, { day: 'Wednesday', gender_only: 'female' })],
      queue_entries: [{
        id: 'q1', session_id: JCC, session_day: 'Tuesday', session_date: JCC, queue_num: 1, name: 'Omar Man',
        type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 50, customer_id: 'm1',
        registered_at: '2099-01-01T10:00:00Z',
      }],
    });
    const moves = sent(page, 'queue_entries', 'PATCH');
    await page.evaluate(`setStaffTab('queue');showBookingEditModal('q1')`);
    await expect(page.locator(`#be-sess option[value="${JCC_F}"]`)).toContainText('Women only');
    await page.locator('#be-sess').selectOption(JCC_F);
    await page.evaluate(`saveBookingEdit()`);
    await expect(page.locator('.toast.error').filter({ hasText: 'Omar Man: This session is for women only.' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(moves.filter((p) => 'session_id' in p)).toHaveLength(0);
  });
});
