import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Acting on a selection (2026-10-09, M16): the accounts ticked in Select mode, or the account report's list, get
// one dialog to add or take a tag, give a badge (Squad Captain and Fuel Stop never), export them (admins, with the
// operator's PIN), or message them on WhatsApp one chat at a time from a template; marketing goes only to riders
// who agreed to ride news.
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina@example.com', phone: '0551876215', ride_news: true, created_at: '2026-06-10T09:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar@example.com', phone: '0551876216', ride_news: false, created_at: '2026-06-11T09:00:00Z' },
  { id: 'c3', name: 'Sara Nour', email: 'sara@example.com', phone: '', ride_news: true, created_at: '2026-06-12T09:00:00Z' },
];
const tags = [{ id: 'tag_x', slug: 'x', name: 'Morning crew', color: '#0c7a3d' }];
const badges = [
  { id: 'b_squad', slug: 'squad', icon: 'people', color: 'blue', name: 'Squad Captain', system: true, auto: true, retired: false, sort: 1 },
  { id: 'b_fuel', slug: 'fuel', icon: 'bottle', color: 'red', name: 'Fuel Stop', system: true, auto: true, retired: false, sort: 2 },
  { id: 'b_marshal', slug: 'marshal', icon: 'flag', color: 'green', name: 'Marshal', system: true, auto: false, retired: false, sort: 3 },
];

async function boot(page: Page) {
  await stubSupabase(page, { customers, tags, customer_tags: [], badges, customer_badges: [], sessions: [], queue_entries: [], staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`window.__opened=[];window.open=(u)=>{window.__opened.push(String(u));return null;};setStaffTab('customers');setCustomersTab('accounts')`);
  await page.evaluate(`_amSelMode();S.amSel=new Set(['c1','c2','c3']);renderCommunity()`);
  await page.locator('#am-sel-bar button', { hasText: 'Act on 3' }).click();
  await expect(page.locator('#confirm-modal .seg-dlg')).toBeVisible();
}

test.describe('@staff:customers acting on a selection', () => {
  test('a tag is added to every selected account on a second tap', async ({ page }) => {
    const posts: unknown[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/customer_tags')) posts.push(r.postDataJSON()); });
    await boot(page);
    await expect(page.locator('#seg-title')).toHaveText('Act on 3 accounts');
    const add = page.locator('#confirm-modal button', { hasText: 'Add to 3' });
    await add.click();
    await expect(page.locator('#confirm-modal .seg-sure')).toContainText('Add Morning crew to 3 accounts?');
    expect(posts.length).toBe(0);
    await add.click();
    await expect.poll(() => posts.length).toBe(1);
    expect((posts[0] as Record<string, unknown>[]).map((r) => r.customer_id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(await page.evaluate(`(S.customerTags||[]).filter(x=>x.tag_id==='tag_x').length`)).toBe(3);
  });

  test('the badge tab never offers Squad Captain or Fuel Stop', async ({ page }) => {
    const ups: unknown[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/customer_badges')) ups.push(r.postDataJSON()); });
    await boot(page);
    await page.locator('#confirm-modal .seg-tabs button', { hasText: 'Badge' }).click();
    await expect(page.locator('#confirm-modal .bdg-pick')).toHaveCount(1);
    await expect(page.locator('#confirm-modal .bdg-pick')).toContainText('Marshal');
    await page.locator('#confirm-modal .bdg-pick').click();
    const give = page.locator('#confirm-modal button', { hasText: 'Give to 3' });
    await give.click();
    await give.click();
    await expect.poll(() => ups.length).toBe(1);
    expect((ups[0] as Record<string, unknown>[]).every((r) => r.badge_id === 'b_marshal')).toBe(true);
    // a hand-picked Squad Captain is refused even if asked for directly
    await page.evaluate(`S._seg.badge='b_squad';_segBadge()`);
    await page.waitForTimeout(200);
    expect(ups.length).toBe(1);
  });

  test('marketing reaches only riders who agreed to ride news; each chat opens in turn', async ({ page }) => {
    await boot(page);
    await page.locator('#confirm-modal .seg-tabs button', { hasText: 'Message' }).click();
    await expect(page.locator('#confirm-modal .seg-body')).toContainText('2 will get it · 0 did not agree to ride news · 1 have no number');
    await page.locator('#confirm-modal .seg-kind button', { hasText: 'Marketing' }).click();
    await expect(page.locator('#confirm-modal .seg-body')).toContainText('1 will get it · 1 did not agree to ride news · 1 have no number');
    await page.fill('#seg-text', 'Hi {first_name}, Saturday ride news');
    await page.locator('#confirm-modal button', { hasText: 'Start (1 chats)' }).click();
    await expect(page.locator('#confirm-modal .seg-who')).toContainText('Lina Haddad');
    await page.locator('#confirm-modal button', { hasText: 'Open WhatsApp' }).click();
    await expect(page.locator('#confirm-modal .seg-prog')).toContainText('Done.');
    const opened = await page.evaluate('window.__opened') as string[];
    expect(opened.length).toBe(1);
    expect(opened[0]).toMatch(/^https:\/\/wa\.me\/966551876215\?text=/);
    expect(decodeURIComponent(opened[0])).toContain('Hi Lina, Saturday ride news');
  });

  test('the export is a CSV of the selected accounts', async ({ page }) => {
    await boot(page);
    await page.evaluate(`window._pinApprove=async()=>true`);
    await page.locator('#confirm-modal .seg-tabs button', { hasText: 'Export' }).click();
    const dl = page.waitForEvent('download');
    await page.locator('#confirm-modal button', { hasText: 'Export 3' }).click();
    const text = await (await import('node:fs/promises')).readFile(await (await dl).path() as string, 'utf8');
    expect(text).toContain('Lina Haddad');
    expect(text).toContain('Sara Nour');
    expect(text.split('\n').length).toBe(4);
  });

  test('the account report acts on the accounts it lists', async ({ page }) => {
    await stubSupabase(page, { customers, tags, customer_tags: [], badges, customer_badges: [], sessions: [], queue_entries: [], staff_options: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('customers');setCustomersTab('accounts');showAccountReportOptions()`);
    await page.locator('#print-opts-modal button', { hasText: 'Act on 3' }).click();
    await expect(page.locator('#confirm-modal #seg-title')).toHaveText('Act on 3 accounts');
  });
});
