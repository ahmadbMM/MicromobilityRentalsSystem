import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The two system tags wear their brands instead of their names: the Jeddah Corniche Circuit
// symbol on blue, the micromobility mark on green. A tag staff create keeps its name. The name
// stays available to screen readers and hover titles.

const tags = [
  { id: 'tag_jcc', name: 'Jeddah Corniche Circuit', slug: 'jcc', color: '#00e585', locked: true, auto_grant: true },
  { id: 'tag_saturday', name: 'Community', slug: 'saturday', color: '#4aa8f8', locked: true },
  { id: 'tag_lead', name: 'Ride Lead', slug: 'lead', color: '#e5a100' }, // a tag staff made (VIP is a system tag since 2026-09-29)
];
const customers = [{ id: 'c1', name: 'Sara Khalid', email: 'sara@gmail.com', phone: '+966551876215', gender: 'female', created_at: '2026-09-20T10:00:00Z' }];
const customer_tags = [
  { customer_id: 'c1', tag_id: 'tag_jcc' },
  { customer_id: 'c1', tag_id: 'tag_saturday', expires_at: Date.now() + 20 * 864e5 },
  { customer_id: 'c1', tag_id: 'tag_lead' },
];

test('the circuit and community tags show their logos; other tags keep their names', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags, customers, customer_tags, staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0&&(S.tags||[]).length>0');
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  const chips = page.locator('.am-row[data-cust="c1"] .am-chips .am-chip');
  await expect(chips).toHaveCount(3);

  const jcc = chips.filter({ has: page.locator('.tag-logo-jcc') });
  await expect(jcc.locator('.tag-logo-jcc')).toHaveAttribute('aria-label', 'Jeddah Corniche Circuit');
  await expect(jcc).toHaveAttribute('title', 'Jeddah Corniche Circuit');
  expect((await jcc.innerText()).trim()).toBe('');                               // a logo, not the words
  expect(await jcc.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(4, 102, 175)');   // blue

  const comm = chips.filter({ has: page.locator('.tag-logo-mm') });
  await expect(comm.locator('.tag-logo-mm')).toHaveAttribute('aria-label', 'Community');
  await expect(comm).not.toContainText('Community');
  await expect(comm).toContainText('until');                                    // the window still reads
  expect(await comm.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(12, 122, 61)');  // green

  await expect(chips.filter({ hasText: 'Ride Lead' })).toHaveCount(1);                 // a staff tag keeps its name
  await expect(page.locator('.am-row[data-cust="c1"] .tag-logo')).toHaveCount(2);

  // Filter pills and the picker wear the same faces.
  await expect(page.locator('.am-pick[title="Jeddah Corniche Circuit"] .tag-logo-jcc')).toHaveCount(1);
  await expect(page.locator('.am-pick[title="Community"] .tag-logo-mm')).toHaveCount(1);
  await page.evaluate(`_amPickTags('c1')`);
  await expect(page.locator('.am-picker .am-pick .tag-logo')).toHaveCount(2);
  await expect(page.locator('.am-picker .am-pick', { hasText: 'Ride Lead' })).toHaveCount(1);
});
