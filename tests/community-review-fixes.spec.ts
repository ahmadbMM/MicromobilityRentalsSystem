import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type FailWrite, type Fixtures } from './helpers/supabase';

// Community-tab regressions from the September review: stored ids cannot break out of the staff
// panel's buttons, tag counts and the tag filter agree, a lapsed grant can be renewed, dated
// grants run on Riyadh's clock, a tag-delete undo is checked, and the leaderboard's streaks,
// arrows, names and upcoming rides tell the truth.

const DAY = 864e5;
async function boot(page: Page, fx: Fixtures, fail?: FailWrite) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags: [], customers: [], customer_tags: [], staff_options: [], ...fx }, fail);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
const ksaDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });

test.describe('ids in the staff panel', () => {
  // customer_signup stores whatever id the caller sends; the newest account is first in both lists.
  const evilId = 'x"><img src=x onerror="window.__pwned=1">\');window.__pwned=2;(\'';
  const customers = [
    { id: evilId, name: 'Evil Name', email: 'e@gmail.com', phone: '+966551876200', gender: 'male', created_at: '2026-09-22T10:00:00Z' },
    { id: 'c-ok', name: 'Plain Rider', email: 'p@gmail.com', phone: '+966551876201', gender: 'male', created_at: '2026-09-01T10:00:00Z' },
  ];

  test('an account id with quotes and markup renders as data and still reaches the handlers intact', async ({ page }) => {
    await boot(page, { customers, tags: [{ id: 'tag_vip', name: 'VIP', slug: 'vip', color: '#e5a100' }],
      sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }] });
    await page.waitForFunction('(S.customers||[]).length>1');
    await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
    const row = page.locator('.am-row', { hasText: 'Evil Name' });
    await expect(row).toBeVisible();
    await page.waitForTimeout(200);
    expect(await page.evaluate('window.__pwned')).toBeUndefined();
    await row.getByRole('button', { name: 'Tags' }).click();
    expect(await page.evaluate('S.tagCustId')).toBe(evilId);
    expect(await page.evaluate('window.__pwned')).toBeUndefined();

    // The cashier's customer box lists the newest accounts the moment it gets focus.
    await page.evaluate(`setStaffTab('cashier');S._ctSession='';renderCashier();_ctCustSuggest(true)`);
    const pick = page.locator('#ct-cust-sug button', { hasText: 'Evil Name' });
    await expect(pick).toBeVisible();
    await pick.click();
    expect(await page.evaluate('S._ctCustId')).toBe(evilId);
    expect(await page.evaluate('window.__pwned')).toBeUndefined();
  });
});

test.describe('tag grants', () => {
  const now = Date.now();
  const tags = [{ id: 'tag_vip', name: 'VIP', slug: 'vip', color: '#e5a100' }];
  const customers = ['c1', 'c2', 'c3'].map((id, i) => ({ id, name: `Rider ${i + 1}`, email: `${id}@gmail.com`, phone: `+96655187620${i}`, gender: 'male', created_at: '2026-09-01T10:00:00Z' }));
  const customer_tags = [
    { customer_id: 'c1', tag_id: 'tag_vip', added_at: now },                                                  // held
    { customer_id: 'c2', tag_id: 'tag_vip', added_at: now, starts_at: now - 20 * DAY, expires_at: now - DAY }, // lapsed
    { customer_id: 'c3', tag_id: 'tag_vip', added_at: now, starts_at: now + 5 * DAY, expires_at: now + 9 * DAY }, // starts later
  ];
  const open = async (page: Page, fail?: FailWrite) => {
    await boot(page, { tags, customers, customer_tags }, fail);
    await page.waitForFunction('(S.customerTags||[]).length===3');
    await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  };

  test('the tag filter lists exactly the riders its count says hold the tag now', async ({ page }) => {
    await open(page);
    await expect(page.locator('.am-pick[title="VIP"]')).toContainText('(1)');
    await page.locator('.am-pick[title="VIP"]').click();
    await expect(page.locator('.am-row')).toHaveCount(1); // was 3: the lapsed and the future grant were listed too
    await expect(page.locator('.am-row')).toContainText('Rider 1');
  });

  test('a lapsed grant shows as not held, and tapping it grants the tag afresh instead of deleting it', async ({ page }) => {
    await open(page);
    const writes: string[] = [];
    page.on('request', (r) => { if (/rest\/v1\/customer_tags/.test(r.url()) && r.method() !== 'GET') writes.push(r.method()); });
    await page.evaluate(`_amPickTags('c2')`);
    const pick = page.locator('.am-row[data-cust="c2"] .am-picker .am-pick');
    await expect(pick).toContainText('+'); // was ✓
    await pick.click();
    await expect(page.locator('#confirm-modal')).toContainText('Add tag');
    expect(writes).toEqual([]); // nothing deleted by the tap
    await page.locator('#confirm-modal .btn-primary').click(); // permanent
    await expect.poll(() => writes).toEqual(['DELETE', 'POST']); // the lapsed row gives way to the new grant
    const rows = await page.evaluate(`S.customerTags.filter(ct=>ct.customer_id==='c2')`) as { expires_at?: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at == null).toBe(true);
  });

  test('a grant that has not started yet can still be taken back from the picker', async ({ page }) => {
    await open(page);
    await page.evaluate(`_amPickTags('c3')`);
    const pick = page.locator('.am-row[data-cust="c3"] .am-picker .am-pick');
    await expect(pick).toContainText('✓');
    await pick.click();
    await expect.poll(() => page.evaluate(`S.customerTags.some(ct=>ct.customer_id==='c3')`)).toBe(false);
  });

  test('undoing a tag delete checks its writes and does not show the tag twice', async ({ page }) => {
    await open(page);
    await page.evaluate(`void deleteTag('tag_vip')`);
    await page.locator('#confirm-modal .btn-red').click(); // it asks first (the owner, 2026-10-07)
    await expect.poll(() => page.evaluate(`S.tags.length`)).toBe(0);
    // The staff-ref echo of the restore often lands before the answer does.
    const res = await page.evaluate(`(async () => { S.tags = [...S.tags, { id: 'tag_vip', name: 'VIP', slug: 'vip' }]; return await S.undoStack[S.undoStack.length - 1].fn(); })()`);
    expect(res).not.toBe(false);
    expect(await page.evaluate(`S.tags.filter(x => x.id === 'tag_vip').length`)).toBe(1);
    expect(await page.evaluate(`S.customerTags.filter(ct => ct.tag_id === 'tag_vip').length`)).toBe(3);
  });

  test('an undo the server refuses says so instead of showing the tag restored', async ({ page }) => {
    await open(page, { table: 'tags', methods: ['POST'] });
    await page.evaluate(`void deleteTag('tag_vip')`);
    await page.locator('#confirm-modal .btn-red').click(); // it asks first (the owner, 2026-10-07)
    await expect.poll(() => page.evaluate(`S.tags.length`)).toBe(0);
    const res = await page.evaluate(`S.undoStack[S.undoStack.length - 1].fn()`);
    expect(res).toBe(false);
    expect(await page.evaluate(`S.tags.length`)).toBe(0);
    expect(await page.evaluate(`S.customerTags.filter(ct => ct.tag_id === 'tag_vip').length`)).toBe(0);
  });
});

test.describe('dated tag grants on a desk set to another timezone', () => {
  test.use({ timezoneId: 'Asia/Karachi' }); // UTC+5, two hours ahead of Riyadh

  test('the first and last day are Riyadh days', async ({ page }) => {
    await boot(page, {
      tags: [{ id: 'tag_vip', name: 'VIP', slug: 'vip', color: '#e5a100' }],
      customers: [{ id: 'c1', name: 'Rider One', email: 'c1@gmail.com', phone: '+966551876209', created_at: '2026-09-01T10:00:00Z' }],
    });
    const sent: Record<string, number>[] = [];
    page.on('request', (r) => { if (/rest\/v1\/customer_tags/.test(r.url()) && r.method() === 'POST') { const b = r.postDataJSON(); sent.push(Array.isArray(b) ? b[0] : b); } });
    await page.evaluate(`(async () => {
      showTagGrantModal('c1', 'tag_vip');
      Object.assign(S._tg, { kind: 'temp', mode: 'dates', today: false, start: '2026-10-01', end: '2026-10-05' });
      await saveTagGrant();
    })()`);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].starts_at).toBe(Date.parse('2026-10-01T00:00:00+03:00'));
    expect(sent[0].expires_at).toBe(Date.parse('2026-10-05T23:59:59.999+03:00')); // was 21:59:59 Riyadh on the 5th
  });
});

// The leaderboard and statistics are Community's first two tabs (Claude Design #15).
test.describe('leaderboard', () => {
  const done = (id: string, cust: string, name: string, date: string, q = 1) => ({
    id, name, customer_id: cust, session_id: 's-' + date, session_day: 'Friday', session_date: date, queue_num: q,
    status: 'done', paid: true, price: 45, registered_at: date + 'T15:00:00Z', walk_in: false,
  });

  test('a streak is the rider\'s real run up to now, whatever window the board shows', async ({ page }) => {
    const queue_entries = [
      ...[0, -7, -14].map((d, i) => done('n' + i, 'c1', 'Now Rider', ksaDay(d))),
      ...['2025-01-05', '2025-01-12', '2025-01-19', '2025-01-26'].map((d, i) => done('o' + i, 'c2', 'Old Rider', d)),
    ];
    await boot(page, { queue_entries, customers: [{ id: 'c1', name: 'Now Rider', created_at: '2025-01-01T00:00:00Z' }, { id: 'c2', name: 'Old Rider', created_at: '2025-01-01T00:00:00Z' }] });
    await page.waitForFunction('getQueue().length===7');
    const [streak, oldStreak] = await page.evaluate(`[t('lbStreakTip').replace('{0}',3), t('lbStreakTip').replace('{0}',4)]`) as [string, string];
    await page.evaluate(`S.anView='leaderboard';setStaffTab('analytics');S.lbWindow='week';renderCommunity()`);
    await expect(page.locator('#tab-analytics')).toContainText(streak, { useInnerText: true }); // the week window used to cap every streak at 1
    await page.evaluate(`S.lbWindow='all';renderCommunity()`);
    await expect(page.locator('#tab-analytics')).toContainText('Old Rider', { useInnerText: true });
    await expect(page.locator('#tab-analytics')).toContainText(streak, { useInnerText: true });
    await expect(page.locator('#tab-analytics')).not.toContainText(oldStreak, { useInnerText: true }); // its run ended in January 2025
  });

  test('the owner board names an account by the account, not by a companion it booked', async ({ page }) => {
    await boot(page, {
      queue_entries: [done('k1', 'c1', 'Kid Rider', '2099-01-02', 1), done('p1', 'c1', 'Parent Rider', '2099-01-09', 5)],
      customers: [{ id: 'c1', name: 'Parent Account', created_at: '2025-01-01T00:00:00Z' }],
    });
    await page.waitForFunction('getQueue().length===2&&(S.customers||[]).length===1');
    await page.evaluate(`S.anView='leaderboard';setStaffTab('analytics');S.lbScope='owner';S.lbWindow='all';renderCommunity()`);
    await expect(page.locator('#tab-analytics')).toContainText('Parent Account', { useInnerText: true });
    await expect(page.locator('#tab-analytics')).not.toContainText('Kid Rider', { useInnerText: true });
  });

  test('on the 31st, the month board still compares with last month', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-31T09:00:00Z')); // noon in Riyadh
    const queue_entries = [
      ...['2026-09-04', '2026-09-11', '2026-09-18'].map((d, i) => done('a' + i, 'cA', 'Amal', d)),
      done('b0', 'cB', 'Badr', '2026-09-25'),
      ...['2026-10-02', '2026-10-09', '2026-10-16'].map((d, i) => done('b' + (i + 1), 'cB', 'Badr', d)),
      done('a3', 'cA', 'Amal', '2026-10-23'),
    ];
    await boot(page, { queue_entries, customers: [{ id: 'cA', name: 'Amal', created_at: '2025-01-01T00:00:00Z' }, { id: 'cB', name: 'Badr', created_at: '2025-01-01T00:00:00Z' }] });
    await page.waitForFunction('getQueue().length===8');
    await page.evaluate(`S.anView='leaderboard';setStaffTab('analytics');S.lbScope='owner';S.lbMetric='count';S.lbWindow='month';renderCommunity()`);
    await expect(page.locator('#tab-analytics')).toContainText('▲1', { useInnerText: true }); // Badr was 2nd in September; it read "–" from the 29th on
    await expect(page.locator('#tab-analytics')).toContainText('▼1', { useInnerText: true });
  });

  test('upcoming rides leave out deleted sessions', async ({ page }) => {
    await boot(page, { sessions: [
      { id: 's-open', day: 'Friday', session_date: '2099-03-06', capacity: 12, status: 'open', created_at: 1 },
      { id: 's-gone', day: 'Tuesday', session_date: '2099-03-03', capacity: 12, status: 'deleted', created_at: 2 },
    ] });
    await page.evaluate(`S.anView='community';setStaffTab('analytics');renderCommunity()`);
    const [kept, gone] = await page.evaluate(`[shortDate('2099-03-06'), shortDate('2099-03-03')]`) as [string, string];
    await expect(page.locator('#tab-analytics')).toContainText(kept, { useInnerText: true });
    await expect(page.locator('#tab-analytics')).not.toContainText(gone, { useInnerText: true });
  });
});
