import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff "Add group" / booking-editor added riders: rows sharing a group_id must render as
// ONE roster group even with no customer account (walk-ins), while account-less rows
// without a group_id stay solo. Consecutive groups show a "#1 - #2" queue-number range in
// both the desktop table and the mobile cards; solo rows never do.
test('riders sharing a group_id render as one group even without customer accounts', async ({ page }) => {
  const row = (id: string, qn: number, name: string, groupId: string | null): Record<string, unknown> => ({
    id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: qn,
    name, phone: '', customer_id: null, group_id: groupId, status: 'waiting', paid: false,
    price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z',
  });
  const q = [
    row('e1', 1, 'Grouped One', 'g1'),
    row('e2', 2, 'Grouped Two', 'g1'),
    row('e3', 3, 'Solo Three', null),
    row('e4', 4, 'Solo Four', null),
  ];
  const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
  await stubSupabase(page, { queue_entries: q, sessions });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);

  const txt = await page.evaluate(() => {
    // @ts-expect-error app globals
    S.staffTab = 'queue'; renderStaffQueue();
    return document.body.textContent || '';
  });
  expect(txt).toMatch(/#1\s*[-–]\s*#2/); // e1+e2 grouped by group_id
  expect(txt).not.toMatch(/#2\s*[-–]\s*#3/); // the group does not swallow the next solo row
  expect(txt).not.toMatch(/#3\s*[-–]\s*#4/); // account-less rows without group_id stay solo

  // The grouped pair (and only it) gets a one-tap "Mark paid" that pays every member: in its row's ⋯ menu since round two
  // (2026-11-08), the party's one action being Check in (2) while its riders are expected.
  expect(await page.evaluate(`Object.keys(S._rowMenus).filter(k=>/^party(card)?:/.test(k)&&S._rowMenus[k].some(i=>/^groupMarkPaid/.test(i.run))).length`)).toBe(1);
  await page.locator('#tab-queue').locator(':is(tr.party-row, .party-card) .rq-more').filter({ visible: true }).first().click();
  const paidBtn = page.getByRole('menuitem', { name: /Mark paid/ });
  const patched: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      if (id) patched.push(id);
    }
  });
  await paidBtn.click();
  await expect.poll(() => patched.sort()).toEqual(['e1', 'e2']);
});
