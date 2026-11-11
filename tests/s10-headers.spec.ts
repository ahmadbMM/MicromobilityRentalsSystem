import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff round s10 (2026-11-10), "headers": one section header on the busy pages (the title, at most one solid primary, up
// to four outline buttons used every night, More actions with the rest as the booking menu's grouped tiles), the phone's
// one Desk tools button, a full-width search, the figures bar's Owing in sight, the list padded for the floating pair,
// the KPI tiles in a Summary sub-view, fold budgets at 390x844, the account window's address (/people?acct=<id>) and
// its side panel from 1280px (D5), and the floating pair stepping aside while the search keyboard is up (D9).

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24', NEXT = '2026-09-26';
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOf = (d: string) => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
const sess = (d: string, o: Record<string, unknown> = {}) => ({ id: d, day: dayOf(d), session_date: d, capacity: 40, status: 'open', location: 'JCC', bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }), created_at: 1, ...o });
const sessions = [sess(TODAY), sess(NEXT)];
const q = (id: string, n: number, o: Record<string, unknown> = {}) => ({
  id, session_id: TODAY, session_day: dayOf(TODAY), session_date: TODAY, queue_num: n, name: 'Rider ' + n, status: 'waiting', paid: false,
  price: 80, type_preference: 'Hybrid', size: 'M', height: 172, phone: '05500000' + String(n).padStart(2, '0'), registered_at: '2026-09-15T10:00:00Z', ...o,
});
const queue_entries = [
  q('w1', 1, { name: 'Wafa Waiting', customer_id: 'c1' }), q('w2', 2), q('w3', 3), q('w4', 4), q('w5', 5), q('w6', 6),
  q('a1', 7, { name: 'Adel Owes', status: 'active', checked_in_at: '2026-09-24T17:00:00Z' }), // on a bike, not paid: Owing
  q('d1', 8, { name: 'Dina Done', status: 'done', paid: true }),
];
const customers = [
  { id: 'c1', name: 'Wafa Haddad', email: 'wafa.haddad@example.com', phone: '+966551876215', gender: 'female', created_at: '2025-01-10T09:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@example.com', phone: '+966551876216', gender: 'male', created_at: new Date(NOW - 2 * 864e5).toISOString() },
];
const sale = { id: 'sale1', receipt_id: 'r1', session_id: TODAY, item_id: 'it1', name: 'Water', qty: 2, price: 5, pay: 'paid', category: 'drinks', created_at: '2026-09-24T17:10:00Z', customer_name: 'Buyer', sold_by_name: 'Spec Staff' };

async function open(page: Page, width = 1280, height = 900, extra: Record<string, unknown> = {}) {
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, queue_entries, customers, cashier_sales: [sale], bikes: [], tags: [], customer_tags: [], ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.locator('#snav-burger, #staff-tab-nav, #staff-tabbar').filter({ visible: true }).first().waitFor();
}
async function bookings(page: Page) {
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${TODAY}';S._sfPicked=true;S.sfStatus='all';S.sfSearch='';renderStaffQueue()`);
  await expect(page.locator('#q-results [data-id="w1"]').first()).toBeVisible();
}
const sheet = (page: Page) => page.locator('.row-sheet');
const tiles = (page: Page) => sheet(page).locator('.rmt-tile');
const tileNames = async (page: Page) => (await tiles(page).allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());

test.describe('@staff:bookings s10 section header', () => {
  test('Bookings: + Walk-in solid, Session settings and Close out in sight, the rest grouped in More', async ({ page }) => {
    await open(page);
    await bookings(page);
    const head = page.locator('#tab-queue .rq-hacts');
    await expect(head.locator('.walkin-head')).toBeVisible();
    await expect(head.locator('.walkin-head')).toHaveClass(/btn-green/);
    await expect(head.locator('.co-head')).toBeVisible();
    await expect(head.locator('.n6t-sess')).toBeVisible();
    expect(await head.locator('.btn-green').filter({ visible: true }).count()).toBe(1); // at most one solid primary
    for (const name of ['Reminders', 'Print report', 'Bike prep', 'First-timers', 'My shift', 'Add group', 'Share my location'])
      await expect(page.locator('#tab-queue').getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(page.locator('#tab-queue .density-toggle, #tab-queue .q-views .live-share')).toHaveCount(0); // the second and third rows are folded
    const more = head.locator('.sh-more');
    await expect(more).toHaveText(/More actions/);
    await more.click();
    await expect(sheet(page).locator('.rmt-grp-h')).toHaveText(['Session', 'Add', 'People', 'Reports', 'Your shift', 'View']); // Session: Open the night (D10)
    const names = await tileNames(page);
    for (const n of ['Open the night', 'Add group', 'Reminders', 'Print report', 'Bike prep', 'First-timers', 'My shift', 'Share my location · Ride leader', 'Share my location · Sweeper', 'Comfortable', 'Compact']) expect(names.join('|')).toContain(n);
    expect(names.join('|')).not.toContain('Close out'); // in sight on a desk: not twice
    await sheet(page).getByRole('menuitem', { name: 'My shift' }).click(); // a tile runs the button it stands for
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator('#desk-sheet [role="dialog"]')).toBeVisible();
  });

  test('phone: one Desk tools button, a full-width search, Owing in sight, and the first card within the fold budget', async ({ page }) => {
    await open(page, 390, 844);
    await bookings(page);
    const tools = page.locator('#tab-queue .rq-hacts .sh-more');
    await expect(tools).toBeVisible();
    await expect(tools).toHaveText(/Desk tools/);
    for (const sel of ['.co-head', '.n6t-sess', '.walkin-head']) await expect(page.locator(`#tab-queue .rq-hacts ${sel}`)).toBeHidden();
    await expect(page.locator('.fab-row .walkin-fab')).toBeVisible(); // the floating pair stays
    await tools.click();
    expect((await sheet(page).locator('.rmt-grp-h').allInnerTexts())[0]).toBe('Session');
    const names = (await tileNames(page)).join('|');
    for (const n of ['Session settings', 'Close out (7)', 'Add group', 'Reminders', 'My shift', 'Bike prep']) expect(names).toContain(n);
    expect(names).not.toContain('Comfortable'); // the desk's table density is no phone's
    await sheet(page).getByRole('menuitem', { name: /Close out/ }).click();
    await page.locator('#desk-sheet .ck-go').click(); // the close-night checklist comes first (D10, 2026-11-11)
    await expect(page.locator('#confirm-modal')).toContainText(/close/i);
    await page.evaluate('closeConfirm()');
    // search is a field across the row
    const search = page.locator('#sf-search-input');
    await expect(search).toBeVisible();
    expect((await search.boundingBox())!.width).toBeGreaterThan(300);
    // the figures bar: Owing beside Not arrived, inside the screen
    const owe = page.locator('#q-live-count .q-lc-owing');
    await expect(owe).toBeVisible();
    const ob = (await owe.boundingBox())!;
    expect(ob.x + ob.width).toBeLessThanOrEqual(390);
    const na = (await page.locator('#q-live-count .q-lc-waiting').boundingBox())!;
    expect(ob.x).toBeGreaterThan(na.x); // right after it
    // fold budget (item 17): the first roster card
    const top = await page.locator('#q-results .q-card').first().evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
    console.log('first roster card y at 390x844:', top);
    expect(top).toBeLessThanOrEqual(BOOKINGS_FOLD);
  });

  test('phone: at the foot of the roster the floating pair covers no card; it steps aside while search is typed in (D9)', async ({ page }) => {
    await open(page, 390, 844);
    await bookings(page);
    await page.evaluate('scrollTo(0,document.documentElement.scrollHeight)');
    const fab = (await page.locator('.fab-row').boundingBox())!;
    const last = (await page.locator('#q-results .q-card').last().boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(fab.y);
    await page.evaluate('scrollTo(0,0)');
    await page.locator('#sf-search-input').focus();
    await expect(page.locator('.fab-row')).toBeHidden();
    await page.evaluate('document.activeElement.blur()');
    await expect(page.locator('.fab-row')).toBeVisible();
  });

  test('Sessions detail: Edit and Open in Bookings in sight, the others in More, the dangerous ones at its foot', async ({ page }) => {
    await open(page);
    await page.evaluate(`setStaffTab('sessions');S.sessView='list';selectSessionDetail('${TODAY}')`);
    const acts = page.locator('#tab-sessions .sess-detail-actions');
    await expect(acts.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await expect(acts.getByRole('button', { name: 'Open in Bookings' })).toBeVisible();
    for (const name of ['Clone', 'Copy link', 'Riders CSV', 'Mark full', 'Close bike types', 'Print lead sheet'])
      await expect(page.locator('#tab-sessions').getByRole('button', { name, exact: true })).toHaveCount(0);
    await acts.locator('.sh-more').click();
    await expect(sheet(page).locator('.rmt-grp-h')).toHaveText(['Status', 'Share', 'Session']);
    const names = (await tileNames(page)).join('|');
    for (const n of ['Mark full', 'Close bike types', 'Close out (7)', 'Copy link', 'Riders CSV', 'Clone', 'Print lead sheet']) expect(names).toContain(n);
    await expect(sheet(page).locator('.rmt-foot .rmt-tile')).toHaveText(['Close', 'Cancel session (7)', 'Delete']);
    await expect(sheet(page).locator('.rmt-foot').getByRole('menuitem', { name: 'Delete' })).toBeDisabled(); // it has bookings
  });

  test('a sales receipt: Print and ⋯ (Edit, Share, Changes; Refund and Void at the foot)', async ({ page }) => {
    await open(page);
    await page.evaluate(`setStaffTab('cashier');S._ctSession='${TODAY}';renderCashier()`);
    const acts = page.locator('#tab-cashier .sl-rc-acts').first();
    await expect(acts.getByRole('button', { name: 'Print', exact: true })).toBeVisible();
    for (const name of ['Edit', 'Share', 'Refund', 'Void', 'Changes']) await expect(acts.getByRole('button', { name, exact: true })).toHaveCount(0);
    await acts.locator('.sh-more').click();
    await expect(sheet(page).locator('.rmt-grid .rmt-tile')).toHaveText(['Edit', 'Share', 'Changes']);
    await expect(sheet(page).locator('.rmt-foot .rmt-tile')).toHaveText(['Refund', 'Void']);
  });

  test('Inventory and Analytics: the rare ones in More', async ({ page }) => {
    await open(page);
    await page.evaluate(`setStaffTab('inventory')`);
    const inv = page.locator('#tab-bikes .section-header');
    await expect(inv.locator('.flt-addbtn')).toBeVisible();
    await expect(inv.getByRole('button', { name: 'Maintenance report' })).toBeVisible();
    await expect(inv.getByRole('button', { name: 'CSV template' })).toHaveCount(0);
    await inv.locator('.sh-more').click();
    expect(await tileNames(page)).toEqual(['Import CSV', 'CSV template']);
    await page.locator('.row-sheet-close').click();
    await page.evaluate(`setStaffTab('analytics')`);
    const an = page.locator('#tab-analytics .an-title-btns');
    await expect(an.getByRole('button', { name: 'Share digest' })).toBeVisible();
    await expect(an.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(an.getByRole('button', { name: /Height & bike report/ })).toHaveCount(0);
    await an.locator('.sh-more').click();
    expect(await tileNames(page)).toEqual(['Height & bike report', 'Height & bike report CSV']);
  });
});

test.describe('@staff:people s10 account window', () => {
  test('Call, WhatsApp and Edit in sight, the rest in More; its address is /people?acct=<id> while open, and Copy link copies it', async ({ page }) => {
    await open(page);
    await page.evaluate(`window.__copied='';navigator.clipboard.writeText=(t)=>{window.__copied=t;return Promise.resolve();};setStaffTab('community')`);
    await page.evaluate(`openAccountHistory('c1')`);
    const m = page.locator('#cust-modal');
    const bar = m.locator('.n6p-bar');
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('link', { name: 'Call' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Edit customer' })).toBeVisible();
    for (const name of ['Tags', 'Merge', 'New booking', 'Copy link', 'Changes']) await expect(m.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(m.locator('.modal-sub')).toContainText('551876215'); // personal data in full on staff screens
    await expect.poll(() => page.evaluate('location.pathname+location.search')).toBe('/people?acct=c1');
    await bar.locator('.sh-more').click();
    const names = (await tileNames(page)).join('|');
    for (const n of ['Tags', 'New booking', 'Ask to correct', 'Merge', 'Copy link', 'Changes']) expect(names).toContain(n);
    await sheet(page).getByRole('menuitem', { name: 'Copy link' }).click();
    await expect.poll(() => page.evaluate('window.__copied')).toBe(await page.evaluate('location.origin') + '/people?acct=c1');
    await m.locator('.ah-close').click();
    await expect.poll(() => page.evaluate('location.pathname+location.search')).toBe('/people');
  });

  test('D5: from 1280px the window is a side panel and the list beside it stays in view; a narrower screen keeps the dialog', async ({ page }) => {
    await open(page, 1366, 900);
    await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
    await page.evaluate(`openAccountHistory('c1')`);
    // at the viewport's end edge once the window has settled (it draws again when the account's history arrives)
    const rect = `(()=>{const x=document.querySelector('#cust-modal .ah-box');if(!x)return null;const r=x.getBoundingClientRect();return {x:r.left,width:r.width,right:Math.round(r.right)};})()`;
    await expect.poll(async () => ((await page.evaluate(rect)) as { right: number } | null)?.right || 0).toBeGreaterThanOrEqual(1365);
    const box = (await page.evaluate(rect)) as { x: number; width: number };
    expect(box.width).toBeLessThanOrEqual(560);
    const title = (await page.locator('#tab-community .page-title').boundingBox())!;
    expect(title.x + title.width).toBeLessThanOrEqual(box.x); // the page moved over
    expect(await page.evaluate(`!document.elementFromPoint(${Math.round(title.x + 10)},${Math.round(title.y + 10)}).closest('#cust-modal')`)).toBe(true); // no scrim over it
    await page.locator('#cust-modal .ah-close').click();
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.evaluate(`openAccountHistory('c1')`);
    const b2 = (await page.locator('#cust-modal .ah-box').boundingBox())!;
    expect(Math.abs(b2.x + b2.width / 2 - 512)).toBeLessThan(40); // centred
  });
});

test.describe('@staff s10 summary sub-views and fold budgets', () => {
  test('People: the figures are the Summary view at /people/summary; the overview opens on the find box and people (390x844)', async ({ page }) => {
    await open(page, 390, 844, { community_applications: [{ id: 'a1', created_at: '2026-09-21T10:00:00Z', status: 'pending', name: 'Amal Top', phone: '+966551876217' }] });
    await page.evaluate(`setStaffTab('community');setCommTab('overview')`);
    await expect(page.locator('#tab-community .dash-kpi')).toHaveCount(0);
    const row = page.locator('#tab-community .dash-row', { hasText: 'Amal Top' }).first(); // a person who needs staff today
    await expect(row).toBeVisible();
    await page.waitForTimeout(300); // the applications' repaint
    const r = await row.evaluate((el) => Math.round(el.getBoundingClientRect().bottom + scrollY));
    console.log('first person row bottom at 390x844:', r);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(PEOPLE_FOLD);
    await page.evaluate(`setCommTab('summary')`);
    expect(await page.evaluate('location.pathname')).toBe('/people/summary');
    await expect(page.locator('#tab-community .dash-kpi').first()).toBeVisible();
  });

  test('Sessions: the figures are the Summary layout at /sessions/summary; the list comes first (390x844)', async ({ page }) => {
    await open(page, 390, 844);
    await page.evaluate(`setStaffTab('sessions');S.sessView='list';S.selSessionDetail=null;renderSessions()`);
    await expect(page.locator('#tab-sessions .ss-figs')).toHaveCount(0);
    const first = page.locator('#tab-sessions .sess-lc').first();
    await expect(first).toBeVisible();
    const top = await first.evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
    console.log('first session top at 390x844:', top);
    expect(top).toBeLessThanOrEqual(SESSIONS_FOLD);
    await page.evaluate(`_ssLay('sum')`);
    expect(await page.evaluate('location.pathname')).toBe('/sessions/summary');
    await expect(page.locator('#tab-sessions .ss-figs')).toBeVisible();
    await page.locator('#tab-sessions .ss-figs .dash-kpi', { hasText: 'Upcoming' }).click(); // a figure opens its list
    expect(await page.evaluate('[S.sessView,location.pathname]')).toEqual(['list', '/sessions']);
  });
});

// The fold budgets at 390x844 (item 17): the tab bar takes the screen's last 76px.
const BOOKINGS_FOLD = 400; // 385-391 measured on 2026-11-10 (582 before); 250 needs the search or the figures off the first screen
const PEOPLE_FOLD = 768;
const SESSIONS_FOLD = 768;
