import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Front desk round 2 (2026-10-09, s1010-desk): the walk-in's extra riders (B8), the Staff List's light
// reload (B9), suggested bikes (D2), Give bike on a "Needs bike" row (D3), the return after the till (D7),
// the check-in's labels (D11), the desk note and My shift (D13), and joining or leaving a party (D14).
// Invented riders and bikes only. The ride is tomorrow's, so the spec does not turn at midnight.

const T = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [{ id: 's0', day: 'Friday', session_date: T, capacity: 12, status: 'open', created_at: 1 }];
const bikes = [
  { id: 'bk-12', bike_number: 12, name: 'Road M 012', type: 'Road', size: 'M', status: 'available', colors: [] },
  { id: 'bk-14', bike_number: 14, name: 'Road L 014', type: 'Road', size: 'L', status: 'available', colors: [] },
  { id: 'bk-13', bike_number: 13, name: 'Road M 013', type: 'Road', size: 'M', status: 'check', colors: [] },
  { id: 'bk-15', bike_number: 15, name: 'Road M 015', type: 'Road', size: 'M', status: 'maintenance', colors: [] },
  { id: 'bk-21', bike_number: 21, name: 'Hybrid M 021', type: 'Hybrid', size: 'M', status: 'available', colors: [] },
  { id: 'bk-30', bike_number: 30, name: 'Road M 030', type: 'Road', size: 'M', status: 'in-use', colors: [] },
];
const row = (id: string, qn: number, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Friday', session_date: T, queue_num: qn, name, phone: '', customer_id: null, group_id: null,
  status: 'waiting', paid: true, price: 75, walk_in: true, registered_at: '2026-01-01T10:00:00Z', height: 175, type_preference: 'Road',
  desk_note: null, ...extra,
});
const A = 'aaaa1111-0000-4000-8000-000000000001', B = 'bbbb2222-0000-4000-8000-000000000002', W = 'cccc3333-0000-4000-8000-000000000003';
const N = 'dddd4444-0000-4000-8000-000000000004', R = 'eeee5555-0000-4000-8000-000000000005';
const rows = () => [
  row(A, 1, 'Amal Noted', { desk_note: 'Left ID' }),
  row(B, 2, 'Badr Solo'),
  row(W, 3, 'Waleed Waits', { status: 'waitlist', paid: false }),
  row(N, 4, 'Nada Bikeless', { status: 'active', assigned_bike_id: null, checked_in_at: new Date().toISOString() }),
  row(R, 5, 'Rami Owes', { status: 'active', paid: false, assigned_bike_id: 'bk-30', checked_in_at: new Date().toISOString() }),
];

async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { queue_entries: rows(), sessions, bikes, 'rpc:staff_swap_bike': { ok: true, noop: false }, ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
}
function patches(page: Page, table: string) {
  const out: Array<{ url: string; body: Record<string, unknown> }> = [];
  page.on('request', (r) => {
    if (r.method() !== 'PATCH' || !r.url().includes(`/rest/v1/${table}`)) return;
    let body: Record<string, unknown> = {};
    try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
    out.push({ url: decodeURIComponent(r.url()), body });
  });
  return out;
}

test.describe('@staff:bookings s1010 desk', () => {
  test('B8: an unnamed extra walk-in is "Guest of" the first, and its type is asked for, or taken from the linked account', async ({ page }) => {
    await boot(page, { customers: [{ id: 'c9', name: 'Sara Known', email: 's@x.com', phone: '0500000009', type_preference: 'Hybrid' }] });
    const posts: Record<string, unknown>[][] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/queue_entries')) { const b = r.postDataJSON(); posts.push(Array.isArray(b) ? b : [b]); } });
    await page.evaluate('showWalkinModal()');
    const m = page.locator('#walkin-modal');
    await m.locator('#wi-name').fill('Tamer');
    await m.getByRole('button', { name: /\+ Add rider/ }).click();
    await m.getByRole('button', { name: /\+ Add rider/ }).click();
    await expect(m.locator('#wi-r-type-0')).toHaveValue(''); // never Any unasked
    await m.locator('#wi-r-name-1').fill('Sara Known');
    await m.locator('#wi-r-name-1').dispatchEvent('change');
    await expect(m.locator('#wi-r-type-1')).toHaveValue('Hybrid'); // the account's own type
    await m.getByRole('button', { name: /\(3\)/ }).click();
    await expect(m.locator('#wi-name')).toBeVisible(); // refused: the first extra has no type
    await expect(m.locator('#wi-r-type-0')).toHaveAttribute('aria-invalid', 'true');
    expect(posts).toHaveLength(0);
    await m.locator('#wi-r-type-0').selectOption('Road');
    await m.getByRole('button', { name: /\(3\)/ }).click();
    await expect(m).toBeHidden();
    expect(posts[0].map((r) => r.name)).toEqual(['Tamer', 'Guest of Tamer', 'Sara Known']);
    expect(posts[0].map((r) => r.type_preference)).toEqual(['Any', 'Road', 'Hybrid']);
    expect(posts[0].every((r) => /^[\p{L} ]+$/u.test(String(r.name)))).toBe(true);
  });

  test('B9: the light reload reads only the live Staff List rows and lays them over what is held', async ({ page }) => {
    const live = { id: 'w1', name: 'Walk Up', phone: '0551', bike_type: 'Road', status: 'waiting', kind: 'walkup', created_at: '2020-01-01T10:00:00Z' };
    await boot(page, { desk_waitlist: [live] });
    const urls: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/desk_waitlist')) urls.push(decodeURIComponent(r.url())); });
    await page.evaluate(`S.deskWaitlist=[{id:'w0',name:'Old Done',status:'done',created_at:'2020-01-01T10:00:00Z',resolved_at:'2020-01-01T11:00:00Z'},{id:'wx',name:'Gone Elsewhere',status:'waiting',created_at:'2020-01-01T10:00:00Z'}]`);
    await page.evaluate('loadDataLight()');
    await expect.poll(() => urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain('or=(status.eq.waiting,created_at.gte.');
    expect(urls[0]).toContain('order=id');
    expect(await page.evaluate(`S.deskWaitlist.map(w=>w.id).sort()`)).toEqual(['w0', 'w1']);
  });

  test('D2: the check-in suggests free bikes that fit, never one held for a check or in maintenance; a tap fills the field', async ({ page }) => {
    await boot(page);
    await page.evaluate(`showCheckinModal('${A}')`);
    const chips = page.locator('#checkin-modal .bk-sugg-b');
    await expect(chips.first()).toBeVisible();
    const txt = (await chips.allTextContents()).join(' | ');
    expect(txt).toContain('#012');
    expect(txt).not.toMatch(/#013|#015|#021|#030/);
    expect(await chips.count()).toBeLessThanOrEqual(4);
    await chips.filter({ hasText: '#014' }).click();
    await expect(page.locator('#ci-bike')).toHaveValue('14');
    await expect.poll(() => page.evaluate('S._ciBike&&S._ciBike.bike.id')).toBe('bk-14');
    await expect(page.locator('#checkin-modal .bk-sugg')).toHaveCount(0); // a bike is chosen: no more suggestions
  });

  test('D3 + D2: a "Needs bike" row gives a bike; Hand-over opens on that rider and a suggested chip hands it over', async ({ page }) => {
    await boot(page);
    const swaps: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/staff_swap_bike')) swaps.push(r.postDataJSON()); });
    const give = page.locator('.give-bike-btn').filter({ visible: true }).first();
    await expect(give).toHaveText('Give bike');
    await give.click();
    await expect.poll(() => page.evaluate('S.queueView')).toBe('handover');
    expect(await page.evaluate('S._hoSel')).toBe(N);
    const chip = page.locator('#ho-host .bk-sugg-b').first();
    await expect(chip).toBeVisible();
    await chip.click();
    await expect.poll(() => swaps.length).toBe(1);
    expect(swaps[0]).toMatchObject({ p_booking_id: N });
  });

  test('D7: an owing rider\'s return opens on Paid, and after the till the return sheet comes back on Paid', async ({ page }) => {
    await boot(page);
    await page.evaluate(`doReturn('${R}')`);
    const m = page.locator('#return-modal');
    const paidBtn = m.locator('[data-on-click*="_retSetPaid"]').first();
    await expect(paidBtn).toHaveAttribute('aria-pressed', 'true');
    await m.locator('[data-on-click*="_retSetPaid"]').nth(1).click(); // Pending
    await m.locator('[data-on-click*="_retSetCond"]').nth(1).click(); // Needs a check
    await m.locator('#ret-notes').fill('Chain loose');
    await m.locator('[data-on-click*="_retToTill"]').click();
    await expect(page.locator('#cashier-modal .modal-box')).toBeVisible();
    await page.evaluate(`S._cashItem='__custom__';S._cashName='Water';S._cashAmt='5';_cashAddLine()`);
    await expect.poll(() => page.evaluate('!!(S._retAfterTill&&S._retAfterTill.sold)')).toBe(true);
    await page.evaluate('closeCashierModal()');
    await expect(m.locator('#ret-title')).toBeVisible();
    await expect(m.locator('[data-on-click*="_retSetPaid"]').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(m.locator('[data-on-click*="_retSetCond"]').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(m.locator('#ret-notes')).toHaveValue('Chain loose');
  });

  test('D11: Confirm shows the amount, Waiting reads "Save, check in later", and a waitlisted rider says so in the title', async ({ page }) => {
    await boot(page);
    await page.evaluate(`showCheckinModal('${W}')`);
    const m = page.locator('#checkin-modal');
    await expect(m.locator('#dlgt-checkin .ci-ttag')).toHaveText('Waitlist');
    await expect(m.locator('#ci-confirm')).toContainText(/Confirm · Paid SAR 75/);
    await expect(m.locator('#ci-out-waiting')).toHaveText('Save, check in later');
  });

  test('D13: the desk note shows on the row and in the check-in, and is edited from the row menu', async ({ page }) => {
    // The server keeps what it was sent: the editor re-reads the row after its write (_reloadRows), and the
    // stub answers that read from these rows.
    const qrows = rows();
    page.on('request', (r) => {
      if (r.method() !== 'PATCH' || !r.url().includes('/rest/v1/queue_entries')) return;
      try { const b = r.postDataJSON() || {}; const x = qrows.find((q) => decodeURIComponent(r.url()).includes(`id=eq.${q.id}`)); if (x) Object.assign(x, b); } catch { /* not JSON */ }
    });
    await boot(page, { queue_entries: qrows });
    await expect(page.locator('.rq-dnote').filter({ visible: true }).first()).toContainText('Left ID');
    const writes = patches(page, 'queue_entries');
    await page.evaluate(`showCheckinModal('${A}')`);
    await expect(page.locator('#checkin-modal .ci-dnote')).toContainText('Left ID');
    await page.evaluate(`closeCheckinModal()`);
    await page.evaluate(`void _deskNoteEdit('${B}')`);
    await page.locator('#prompt-input').fill('  Pays   on return  ');
    await page.locator('#confirm-modal .btn-primary').click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].body).toEqual({ desk_note: 'Pays on return' });
    expect(writes[0].url).toContain(`id=eq.${B}`);
    await expect.poll(() => page.evaluate(`getQueue().find(e=>e.id==='${B}').deskNote`)).toBe('Pays on return');
  });

  test('D13: before the migration the note editor says the database update is pending and writes nothing', async ({ page }) => {
    await boot(page);
    const writes = patches(page, 'queue_entries');
    await page.evaluate(`_qCols=['id','status','session_id','name']`);
    await page.evaluate(`_deskNoteEdit('${B}')`);
    await expect(page.locator('#toast-container')).toContainText('Waiting for the database update.');
    await expect(page.locator('#prompt-input')).toHaveCount(0);
    expect(writes).toHaveLength(0);
  });

  test('D13: My shift lists this operator\'s actions today and what is still open', async ({ page }) => {
    await boot(page, { staff_actions: [{ at: new Date().toISOString(), action: 'Check In: #9 Someone', who: 'Spec Staff' }] });
    await page.locator('.my-shift-btn').filter({ visible: true }).first().click();
    const s = page.locator('#desk-sheet [role="dialog"]');
    await expect(s).toBeVisible();
    await expect(s.locator('#dk-sheet-t')).toContainText('My shift');
    await expect(s).toContainText('Check In: #9 Someone');
    await expect(s).toContainText('Needs bike · 1');
    await expect(s).toContainText('Nada Bikeless');
    await expect(s).toContainText('Still owing · 1');
    await expect(s).toContainText('Rami Owes');
    await s.getByRole('button', { name: 'Close' }).last().click();
    await expect(s).toHaveCount(0);
  });

  test('D14: a rider joins another\'s party from the row menu and leaves it again (group_id)', async ({ page }) => {
    await boot(page);
    const writes = patches(page, 'queue_entries');
    await page.evaluate(`_partyJoin('${A}')`);
    const s = page.locator('#desk-sheet');
    await s.locator('.dk-pj', { hasText: 'Badr Solo' }).click();
    await expect.poll(() => writes.length).toBe(1);
    const gid = writes[0].body.group_id as string;
    expect(gid).toBeTruthy();
    expect(writes[0].url).toMatch(/id=in\.\(/);
    expect(writes[0].url).toContain(A);
    expect(writes[0].url).toContain(B);
    expect(await page.evaluate(`_partyKey(getQueue().find(e=>e.id==='${A}'))===_partyKey(getQueue().find(e=>e.id==='${B}'))`)).toBe(true);
    await page.evaluate(`_partyLeave('${A}')`);
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].body.group_id).toBeTruthy();
    expect(writes[1].body.group_id).not.toBe(gid);
    expect(await page.evaluate(`_partyOf(getQueue().find(e=>e.id==='${B}')).length`)).toBe(1);
  });
});
