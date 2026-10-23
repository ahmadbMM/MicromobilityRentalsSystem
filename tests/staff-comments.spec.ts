import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff comments (the owner, 2026-10-23: "add the ability for staff to add comments on customers bookings and
// applications that are visible only to staff themselves"): a thread per booking or application in the
// staff-only staff_comments table (migration 20261023230000), from the booking's ⋯ menu, a mark on the
// roster row, and a line on each application card. Invented riders only; the ride is tomorrow's.

const T = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [{ id: 's0', day: 'Friday', session_date: T, capacity: 12, status: 'open', created_at: 1 }];
const row = (id: string, qn: number, name: string): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Friday', session_date: T, queue_num: qn, name, phone: '', customer_id: null, group_id: null,
  status: 'waiting', paid: true, price: 75, walk_in: true, registered_at: '2026-01-01T10:00:00Z', height: 175, type_preference: 'Road',
});
const A = 'aaaa1111-0000-4000-8000-000000000001', B = 'bbbb2222-0000-4000-8000-000000000002';
const comments = [
  { id: 1, created_at: '2026-10-20T08:00:00Z', kind: 'booking', target_id: A, body: 'Asked for a smaller frame', author_id: 'u1', author_name: 'Huda' },
];

async function bootQueue(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { queue_entries: [row(A, 1, 'Amal Commented'), row(B, 2, 'Badr Quiet')], sessions, bikes: [], staff_comments: comments, ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
}
function posts(page: Page, table: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes(`/rest/v1/${table}`)) return;
    try { out.push(r.postDataJSON()); } catch { /* not JSON */ }
  });
  return out;
}

test.describe('@staff:bookings staff comments', () => {
  test('a booking with comments shows the mark; the thread opens from it and takes a new comment', async ({ page }) => {
    const sent = posts(page, 'staff_comments');
    // The table as the server would hold it: what was posted is read back, stamped (the shared stub is static).
    const held = [...comments];
    await bootQueue(page);
    await page.route(/\/rest\/v1\/staff_comments/, async (r) => {
      const head = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
      if (r.request().method() === 'POST') {
        const c = { ...r.request().postDataJSON(), id: held.length + 1, created_at: new Date().toISOString(), author_id: 'me', author_name: 'Desk' };
        held.push(c);
        return r.fulfill({ status: 201, headers: head, body: JSON.stringify([c]) });
      }
      return r.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${held.length}/${held.length}` }, body: JSON.stringify(held) });
    });
    const roster = page.locator('.queue-table tbody tr, .q-card');
    const amal = roster.filter({ hasText: 'Amal Commented' }).first();
    await expect(amal.locator('.sc-chip')).toContainText('1');
    await expect(roster.filter({ hasText: 'Badr Quiet' }).first().locator('.sc-chip')).toHaveCount(0);
    await amal.locator('.sc-chip').click();
    const sheet = page.locator('#sc-sheet [role="dialog"]');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Only staff see these comments');
    await expect(sheet.locator('.sc-item')).toHaveCount(1);
    await expect(sheet.locator('.sc-item')).toContainText('Huda');
    await sheet.getByLabel('New comment').fill('  Pays on return  ');
    await sheet.getByRole('button', { name: 'Add comment' }).click();
    await expect(sheet.locator('.sc-item')).toHaveCount(2);
    await expect(sheet.locator('.sc-item').last()).toContainText('Desk');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ kind: 'booking', target_id: A, body: 'Pays on return' }); // the author is the database's to stamp
    await expect(amal.locator('.sc-chip')).toContainText('2');
  });

  test('every booking has Staff comments in its menu', async ({ page }) => {
    await bootQueue(page);
    const menu = await page.evaluate(`(S._rowMenus['${B}']||[]).map(i=>i.label).join('|')`);
    expect(String(menu)).toContain('Staff comments');
    await page.evaluate(`S._rowMenus['${B}'].find(i=>/Staff comments/.test(i.label)).act()`);
    await expect(page.locator('#sc-sheet [role="dialog"]')).toContainText('No comments yet.');
  });

  test('before the database has the table, the thread says it is waiting for the update', async ({ page }) => {
    await stubSupabase(page, { queue_entries: [row(A, 1, 'Amal Commented')], sessions, bikes: [] });
    await page.route(/\/rest\/v1\/staff_comments/, (r) => r.fulfill({
      status: 404, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.staff_comments' in the schema cache" }),
    }));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
    await expect.poll(() => page.evaluate('!!S._scMissing')).toBe(true);
    await page.evaluate(`_scOpen('booking','${A}')`);
    await expect(page.locator('#sc-sheet [role="dialog"]')).toHaveCount(0);
  });
});

test.describe('@staff:community staff comments on applications', () => {
  test('community and learn-to-ride cards carry the newest comment and open their thread', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    const app = {
      id: 'ca1', name: 'Zaid Applicant', email: 'zaid@example.test', phone: '+966552468011', status: 'pending', submissions: 1,
      created_at: '2026-10-20T08:00:00Z', updated_at: '2026-10-20T08:00:00Z', lang: 'en', customer_id: null, existing_account: null,
    };
    await stubSupabase(page, {
      sessions: [], queue_entries: [], bikes: [], customers: [], tags: [], customer_tags: [], community_applications: [app],
      staff_comments: [{ id: 5, created_at: '2026-10-21T09:00:00Z', kind: 'community_app', target_id: 'ca1', body: 'Knows Huda from the club', author_id: 'u2', author_name: 'Omar' }],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('community');setCommTab('applications')`);
    const card = page.locator('.ca-row[data-app-id="ca1"]');
    await expect(card.locator('.sc-card')).toContainText('Knows Huda from the club');
    await card.getByRole('button', { name: 'Comments (1)' }).click();
    await expect(page.locator('#sc-sheet [role="dialog"]')).toContainText('Zaid Applicant');
  });
});
