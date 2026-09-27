import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Second pass on the staff queue: the payment pill is the whole control, the check-in modal
// carries the money (this rider, the party) and follows edits live, a free ride's approved
// riders are completed when it closes, tonight's session leads the strip, and the phone
// header keeps every queue action on screen in a sideways-scrolling strip.

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const S1 = '2099-01-09';
const sessions = [
  { id: S1, day: 'Friday', session_date: S1, capacity: 12, status: 'open', created_at: 1 },
  { id: today, day: 'Today', session_date: today, capacity: 12, status: 'open', created_at: 2 },
];
const bikes = [{ id: 'b1', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: [] }];
const row = (id: string, x: Record<string, unknown> = {}) => ({
  id, name: 'Rider ' + id, session_id: S1, session_day: 'Friday', session_date: S1, queue_num: 1, status: 'waiting', paid: false,
  price: 75, registered_at: S1 + 'T10:00:00Z', type_preference: 'Road', size: 'M', phone: '0550000001', ...x });

async function boot(page: import('@playwright/test').Page, rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, bikes, queue_entries: rows, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getBikes().length>0');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${S1}';renderStaffQueue()`);
}

test('the payment pill opens one menu that also edits the price; the pencil is gone', async ({ page }) => {
  await boot(page, [row('q1')]);
  await expect(page.locator(`button[data-on-click*="showEditPriceModal"]`)).toHaveCount(0);
  await page.locator('.pay-toggle:visible').first().click();
  const menu = page.locator('.pay-menu-popup');
  await expect(menu).toContainText('Pending');
  await expect(menu).toContainText('Edit Price');
  await menu.getByRole('menuitem', { name: /Edit Price/ }).click();   // an action among the states (menuitemradio)
  await expect.poll(() => page.evaluate(`document.getElementById('edit-price-modal').style.display`)).toBe('flex');
});

test('the check-in modal shows the amount, the party total, and follows a price edit live', async ({ page }) => {
  const rows = [row('p1', { group_id: 'g', paid: true }), row('p2', { group_id: 'g', queue_num: 2 }), row('p3', { group_id: 'g', queue_num: 3, price: 95 })];
  await boot(page, rows);
  await page.route(/\/rest\/v1\/queue_entries\?.*id=eq\.p2/, async (route) => {
    if (route.request().method() === 'PATCH') { const b = JSON.parse(route.request().postData() || '{}'); if ('price' in b) (rows[1] as Record<string, unknown>).price = b.price; }
    await route.fallback();
  });
  await page.evaluate(`showCheckinModal('p2')`);
  await page.locator('#checkin-modal').getByRole('button', { name: 'Pending', exact: true }).click(); // opens on Paid now; this is about the arithmetic
  const money = page.locator('#ci-money');
  const line = () => money.innerText().then(x => x.replace(/\s+/g, ' ').trim());
  await expect.poll(line).toBe('SAR 75 · party SAR 245 SAR 170 due');       // one line: this rider · the party's total and what is due
  await expect(money).not.toContainText('paid');                            // p2 has not paid
  await page.evaluate(`saveEditedPrice('p2',105)`);         // staff edit the price while the modal is open
  await expect.poll(line).toBe('SAR 105 · party SAR 275 SAR 200 due');     // the party total moved with it
  await expect(page.locator('#checkin-modal .pg-box, #checkin-modal .modal-box')).toBeVisible(); // still open
});

test('closing a future free ride leaves its riders as they are (sign-ups only pause)', async ({ page }) => {
  const free = { id: '2099-02-01', day: 'Saturday', session_date: '2099-02-01', capacity: 20, status: 'open', created_at: 3, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, spots: 20 };
  await stubSupabase(page, { sessions: [...sessions, free], bikes, queue_entries: [row('f1', { session_id: free.id, session_date: free.id, session_day: 'Saturday', status: 'waiting', approval: 'approved', price: 0 })] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const patches: string[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && /queue_entries/.test(r.url())) patches.push(r.url()); });
  await page.evaluate(`toggleSession('${free.id}','closed')`);
  await page.waitForTimeout(600);
  expect(patches).toEqual([]);
});

test('closing a free session marks its approved riders completed, and no one else', async ({ page }) => {
  // on the ride's own day: closing a future one only pauses sign-ups (next test)
  const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  const free = { id: TODAY + '-sat', day: 'Saturday', session_date: TODAY, capacity: 20, status: 'open', created_at: 3, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, spots: 20 };
  const fr = (id: string, status: string, approval: string | null) => row(id, { session_id: free.id, session_date: free.session_date, session_day: 'Saturday', status, approval, price: 0 });
  await stubSupabase(page, { sessions: [...sessions, free], bikes, queue_entries: [fr('a1', 'waiting', 'approved'), fr('a2', 'active', 'approved'), fr('a3', 'waiting', 'pending'), fr('a4', 'waiting', null)] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const patches: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && /queue_entries/.test(r.url())) patches.push({ url: decodeURIComponent(r.url()), body: JSON.parse(r.postData() || '{}') }); });
  await page.evaluate(`toggleSession('${free.id}','closed')`);
  await expect.poll(() => patches.length).toBe(2);
  const act = patches.find(p => p.url.includes('a2'))!, wait = patches.find(p => p.url.includes('a1'))!;
  expect(act.body.status).toBe('done'); expect(act.body.checked_out_at).toBeTruthy(); expect(act.body.checked_in_at).toBeUndefined();
  expect(wait.body.status).toBe('done'); expect(wait.body.checked_in_at).toBeTruthy();
  expect(patches.some(p => p.url.includes('a3') || p.url.includes('a4'))).toBe(false);   // never selected: untouched
});

test('a paid session closing leaves its riders alone', async ({ page }) => {
  await boot(page, [row('q1', { status: 'active' })]);
  const patches: string[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && /queue_entries/.test(r.url())) patches.push(r.url()); });
  await page.evaluate(`toggleSession('${S1}','closed')`);
  await page.waitForTimeout(500);
  expect(patches).toHaveLength(0);
});

test("tonight's session leads the strip and is the large chip", async ({ page }) => {
  await boot(page, [row('q1')]);
  const chips = page.locator('.sess-summary-bar .sess-summary-chip');
  await expect(chips.first()).toHaveClass(/today-sess/);
  await expect(chips.nth(1)).not.toHaveClass(/today-sess/);
});

test('a reserved rider shows the held bike under the status', async ({ page }) => {
  await boot(page, [row('q1', { assigned_bike_id: 'b1' })]);
  const cell = page.locator('.queue-table tbody tr, .q-card').filter({ hasText: 'Rider q1' }).first();
  await expect(cell).toContainText('Reserved');
  await expect(cell).toContainText('R-11');
});

// Every queue action stays on screen: the header row scrolls sideways rather than folding
// anything away. The night's two busiest actions — a walk-up and a scanned ticket — sit on the
// page on a desktop and float within thumb reach on a phone (asked for 2026-09-22), where they
// stay put as the roster scrolls, and each appears once, never twice.
test('the phone header keeps every queue action on screen', async ({ page }, info) => {
  await boot(page, [row('q1')]);
  const head = page.locator('#tab-queue .section-header');
  for (const name of ['Add group', 'Add rider', 'Print Report']) {
    await expect(head.locator('button', { hasText: name })).toBeVisible();
  }
  await expect(page.locator('#tab-queue button[aria-label="More"]')).toHaveCount(0);
  if (info.project.name === 'mobile') {
    await expect(page.locator('#tab-queue .scan-fab')).toBeVisible();
    await expect(page.locator('#tab-queue .walkin-fab')).toBeVisible();
    await expect(page.locator('#tab-queue .scan-inline')).toBeHidden();
    await expect(page.locator('#tab-queue .walkin-head')).toBeHidden();
    // the floating pair says what it does without words
    await expect(page.locator('#tab-queue .scan-fab')).toHaveAttribute('aria-label', 'Scan ticket');
    await expect(page.locator('#tab-queue .walkin-fab')).toHaveAttribute('aria-label', 'Walk-in');
    // what is left of the header fits or scrolls; it never stacks rows of buttons above the roster
    const strip = page.locator('.sf-head-actions');
    expect(await strip.evaluate((e) => e.getBoundingClientRect().height < 96)).toBe(true);
  } else {
    await expect(head.locator('button', { hasText: '+ Walk-in' })).toBeVisible();
    await expect(page.locator('#tab-queue .scan-inline')).toBeVisible();
    await expect(page.locator('#tab-queue .fab-row')).toBeHidden();
  }
});

// Closing or confirming a check-in must not move the page: focus goes back without scrolling,
// and a roster repaint keeps the scroll position, deferred rows included.
test('the page stays put when a check-in modal closes and the roster repaints', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'the phone roster is cards; the desktop table is where the jump showed');
  const many = Array.from({ length: 45 }, (_, i) => row('m' + i, { queue_num: i + 1, phone: '05500' + String(100 + i) }));
  await boot(page, many);
  await page.evaluate('window.scrollTo(0, 900)');
  await page.waitForTimeout(100);
  const y0 = await page.evaluate('window.scrollY') as number;
  expect(y0).toBeGreaterThan(500);
  await page.evaluate(`showCheckinModal('m30')`);
  await page.waitForTimeout(200);
  await page.evaluate(`closeCheckinModal()`);
  await page.waitForTimeout(300);                                        // the focus manager and the deferred rows have had their turn
  expect(Math.abs((await page.evaluate('window.scrollY') as number) - y0)).toBeLessThan(3);
  await page.evaluate(`renderStaffQueue()`);
  await page.waitForTimeout(300);
  expect(Math.abs((await page.evaluate('window.scrollY') as number) - y0)).toBeLessThan(3);
});
