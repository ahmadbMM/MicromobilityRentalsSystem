import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Instagram followers against the community's average (the owner, 2026-10-09): the average is the followers of
// every community member with a count, over how many members have one; a count at the average is yellow, half of
// it or less full red, double or more full green, on the followers chip of the accounts lists (Customers and
// Community members) and the applications' cards. The report builders offer the average as a section. Stubbed.

const customers = [
  { id: 'm1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', socials: { instagram: 'lina.rides' }, created_at: '2026-06-10T09:00:00Z' },
  { id: 'm2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', socials: { instagram: 'omar_s' }, created_at: '2026-06-11T09:00:00Z' },
  { id: 'm3', name: 'Sara Nabil', email: 'sara.nabil@gmail.com', socials: { instagram: 'sara.n' }, created_at: '2026-06-12T09:00:00Z' },
  { id: 'c4', name: 'Hadi Karam', email: 'hadi.karam@gmail.com', phone: '+966551876218', socials: { instagram: 'hadi.k' }, created_at: '2026-06-13T09:00:00Z' },
];
const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#00e585', locked: true }];
const customer_tags = ['m1', 'm2', 'm3'].map((id) => ({ customer_id: id, tag_id: 'tag_saturday', added_at: Date.now() - 864e5, expires_at: null, starts_at: null }));
const row = (cid: string, handle: string, followers: number) => ({ customer_id: cid, handle, followers, source: 'staff', counted_at: '2026-10-01T10:00:00Z', status: 'ok', tried_at: null, updated_by: 'Staff' });
// members: 1,000 and 4,000 counted, Sara not yet -> average 2,500; Hadi is no member, so his 10,000 is not in it
const customer_ig_followers = [row('m1', 'lina.rides', 1000), row('m2', 'omar_s', 4000), row('c4', 'hadi.k', 10000)];
const app = {
  id: 'a1', status: 'pending', name: 'Hadi Karam', email: 'hadi.karam@gmail.com', phone: '+966551876218', instagram: 'hadi.k', linkedin: null,
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12', gender: 'male',
  nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null, customer_id: 'c4',
};

async function staff(page: Page) {
  await page.route('**/api/ig-followers', (r) => r.fulfill({ contentType: 'application/json', body: '{"ok":false,"skipped":"not configured"}' }));
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags, customer_tags, staff_options: [], customer_ig_followers, community_applications: [app] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===4');
  await page.evaluate(`S.staffRole='admin';sb.auth.getSession=async()=>({data:{session:{access_token:'spec-token'}}})`);
}
const chip = (page: Page, id: string) => page.locator(`#am-cust-rows .am-row[data-cust="${id}"] .ig-chip`);
const hue = (page: Page, id: string) => chip(page, id).evaluate((el) => (el as HTMLElement).style.getPropertyValue('--igh'));

test.describe('@staff:community instagram followers against the community average', () => {
  test('the average counts members with a count only, and the scale runs red - yellow - green', async ({ page }) => {
    await staff(page);
    await page.evaluate('_igFetch()');
    expect(await page.evaluate('_igAvg()')).toEqual({ avg: 2500, counted: 2, members: 3, sum: 5000 });
    const tone = (n: number) => page.evaluate(`_igTone(${n},2500).hue`);
    expect(await tone(2500)).toBe(50);   // yellow at the average
    expect(await tone(1250)).toBe(0);    // half or less: full red
    expect(await tone(500)).toBe(0);
    expect(await tone(5000)).toBe(135);  // double or more: full green
    expect(await tone(3500)).toBeGreaterThan(50);
    expect(await tone(3500)).toBeLessThan(135);
  });

  test('Customers: every counted account is coloured, with the gap in words; none uncounted', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
    await expect(chip(page, 'm1')).toHaveClass(/ig-tone/);
    expect(await hue(page, 'm1')).toBe('0');
    await expect(chip(page, 'm1')).toHaveAttribute('title', '60% below the community average (2,500)');
    await expect(chip(page, 'm2')).toHaveAttribute('title', '60% above the community average (2,500)');
    expect(Number(await hue(page, 'c4'))).toBe(135);
    await expect(chip(page, 'm3')).not.toHaveClass(/ig-tone/);
    await expect(chip(page, 'm3')).toHaveClass(/ig-none/);
  });

  test('Community members: the same colours; a typed count moves the average and repaints every chip', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
    await expect(chip(page, 'm2')).toHaveClass(/ig-tone/);
    expect(Number(await hue(page, 'm2'))).toBeGreaterThan(50);
    await chip(page, 'm3').click();
    await page.fill('#ig-typed', '1000');
    await page.locator('#confirm-modal .ig-dlg .btn-primary').click();
    await page.evaluate('_igClose()');
    // members 1,000 + 4,000 + 1,000 over 3 -> 2,000: Omar is double, full green now
    await expect.poll(() => hue(page, 'm2')).toBe('135');
    await expect(chip(page, 'm3')).toHaveClass(/ig-tone/);
  });

  test('an application card shows its account\'s coloured count beside the Instagram link', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
    const card = page.locator('.ca-row[data-app-id="a1"]');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.ig-chip.ig-tone')).toHaveText('10k followers');
  });

  test('the report builders offer the average, beside the community\'s', async ({ page }) => {
    await staff(page);
    await page.evaluate(`localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null;showAccountReportOptions()`);
    const m = page.locator('#print-opts-modal');
    await expect(m).toContainText('Average Instagram followers');
    // every account: 1,000 + 4,000 + 10,000 over 3 counted
    await expect(m.locator('#acr-ig')).toContainText('average: 5,000 · community average 2,500');
    await page.evaluate(`_closePrintOpts();_accOpts().sections.igAvg=1`);
    const html = await page.evaluate('_accReportHtml()') as string;
    expect(html).toContain('5,000');
    expect(html).toContain('Average Instagram followers · over 3 accounts with a count · community average 2,500');
    expect(html).not.toContain('Total Instagram followers'); // the total is its own pick
  });
});
