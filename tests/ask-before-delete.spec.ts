import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The owner, 2026-10-07, asked "Deleting a tag (which removes it from everyone) and resetting or deactivating a venue
// login happen in one tap - should they ask first?": "yes". Each now asks in the app's confirm dialog, with the red
// button: No sends nothing and leaves everything as it was, Yes sends what the tap used to. Switching a login back on
// asks nothing. Texts of the new questions are read through t(), so the spec holds before and after the strings land.

const DAY = 864e5;
const modal = (page: Page) => page.locator('#confirm-modal');
const question = (page: Page) => modal(page).locator('.confirm-box');
const tx = (page: Page, key: string, n?: string | number) => page.evaluate(`t(${JSON.stringify(key)})`).then((s) => n == null ? String(s) : String(s).replace('{0}', String(n)));

async function boot(page: Page, fx: Fixtures) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags: [], customers: [], customer_tags: [], staff_options: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@staff:community deleting a tag asks first', () => {
  const now = Date.now();
  const tags = [{ id: 'tag_night', name: 'Night Owls', slug: 'night-owls', color: '#4aa8f8', locked: false, auto_grant: false }];
  const customers = ['c1', 'c2', 'c3'].map((id, i) => ({ id, name: `Rider ${i + 1}`, email: `${id}@example.com`, phone: `+96655000010${i}`, gender: 'female', created_at: '2026-09-01T10:00:00Z' }));
  const customer_tags = [
    { customer_id: 'c1', tag_id: 'tag_night', added_at: now },                                                   // holds it
    { customer_id: 'c2', tag_id: 'tag_night', added_at: now, starts_at: now - DAY, expires_at: now + 9 * DAY },   // holds it for now
    { customer_id: 'c3', tag_id: 'tag_night', added_at: now, starts_at: now - 20 * DAY, expires_at: now - DAY },  // lapsed: not held
  ];

  test('the question names the tag and its holders; No sends nothing, Delete deletes it from everyone', async ({ page }) => {
    await boot(page, { tags, customers, customer_tags });
    await page.waitForFunction('(S.customerTags||[]).length===3');
    const writes: string[] = [];
    page.on('request', (r) => { if (/\/rest\/v1\/(tags|customer_tags)\b/.test(r.url()) && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) writes.push(`${r.method()} ${decodeURIComponent(r.url())}`); });
    await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
    const row = page.locator('.am-tag-row', { hasText: 'Night Owls' });
    await expect(row).toContainText('2 holders');

    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(question(page)).toBeVisible();
    await expect(modal(page).locator('#dlgt-confirm')).toHaveText('Delete Night Owls?');
    await expect(modal(page).locator('.chrome-dbody')).toContainText('2 holders'); // the count the row shows
    await expect(modal(page).locator('.chrome-dbody')).toContainText(await tx(page, 'amTagDelBody'));
    await expect(question(page).locator('button.btn-red')).toHaveText('Delete');

    await question(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(question(page)).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(await page.evaluate(`S.tags.map(x=>x.id)`)).toEqual(['tag_night']);
    expect(await page.evaluate(`S.customerTags.filter(ct=>ct.tag_id==='tag_night').length`)).toBe(3);
    await expect(row).toContainText('2 holders');

    await row.getByRole('button', { name: 'Delete' }).click();
    await question(page).locator('button.btn-red').click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatch(/^DELETE .*\/rest\/v1\/tags\?id=eq\.tag_night/); // the database takes the holders' rows with it
    await expect(page.locator('.am-tag-row', { hasText: 'Night Owls' })).toHaveCount(0);
    expect(await page.evaluate(`S.tags.length`)).toBe(0);
    expect(await page.evaluate(`S.customerTags.filter(ct=>ct.tag_id==='tag_night').length`)).toBe(0); // gone from every holder, lapsed one too
    expect(await page.evaluate(`S.undoStack[S.undoStack.length-1].label`)).toContain('Night Owls'); // Undo as before
  });
});

test.describe('@staff:vendors resetting or deactivating a venue login asks first', () => {
  const venue = {
    id: 1, name: 'Bean Box', name_ar: '', kind: 'cafe', area: 'Al Hamra', map_url: '', seats: 40, contact_name: 'Test Contact', contact_phone: '0550000101',
    contact_email: '', offer_en: '', offer_ar: '', staff_notes: '', tier_id: 'single', status: 'active', created_by: 'Spec Staff', created_at: '2099-04-01T08:00:00Z',
  };
  const tiers = [{ id: 'single', name_en: 'Single', name_ar: 'يوم واحد', modes: ['single'], max_per_month: 1, horizon_days: 60, min_lead_days: 7, cancel_cutoff_days: 5, priority: 1, benefits: [], active: true, sort: 1 }];
  const user = (o: Record<string, unknown>) => ({ venue_id: 1, name: '', role: 'manager', must_change_pwd: false, temp_expires_at: null, active: true,
    last_login_at: '2099-04-02T08:00:00Z', created_by: 'Spec Staff', created_at: '2099-04-01T08:00:00Z', ...o });
  const users = [user({ id: 31, login: 'desk@beanbox.example' }), user({ id: 32, login: 'old@beanbox.example', active: false })];

  type Call = { fn: string; body: Record<string, unknown> };
  async function openVenue(page: Page) {
    await boot(page, { vendor_tiers: tiers, vendor_venues: [venue], vendor_users: users, vendor_dates: [], vendor_series: [], vendor_bookings: [],
      'rpc:staff_vendor_user_reset': 'Tmp7-Ab3c-Xy' });
    const calls: Call[] = [];
    page.on('request', (r) => {
      const m = r.url().match(/\/rest\/v1\/rpc\/(staff_vendor_\w+)/);
      if (m && r.method() === 'POST') calls.push({ fn: m[1], body: r.postDataJSON() });
    });
    await page.evaluate(`setStaffTab('vendors')`);
    await page.locator('#tab-vendors [data-vendor-view="venues"]').click();
    await page.locator('#tab-vendors .vendor-ven[data-vendor-ven="1"] .vendor-ven-open').click();
    await expect(modal(page).locator('#vendor-dlg-title')).toHaveText('Bean Box');
    return calls;
  }
  const urow = (page: Page, id: number) => modal(page).locator(`tr[data-vendor-user="${id}"]`);
  const top = (page: Page, id: number) => urow(page, id).evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const scrolled = (page: Page) => modal(page).locator('.modal-box').evaluate((el) => el.scrollTop);

  test('Reset password names the login; No brings the dialog back as it was, Yes resets it', async ({ page }) => {
    const calls = await openVenue(page);
    await modal(page).locator('#vendor-v-area').fill('Al Rawdah'); // typed, not saved
    const reset = urow(page, 31).locator('.vendor-u-reset');
    await reset.scrollIntoViewIfNeeded();
    const at = await top(page, 31), st = await scrolled(page);

    await reset.click();
    await expect(question(page)).toBeVisible();
    await expect(modal(page).locator('#vendor-dlg-title')).toHaveCount(0); // the question took the dialog's place
    await expect(modal(page).locator('#dlgt-confirm')).toHaveText(await tx(page, 'vndResetQ', 'desk@beanbox.example'));
    await expect(modal(page).locator('.chrome-dbody')).toHaveText(await tx(page, 'vndResetBody'));
    await expect(question(page).locator('button.btn-red')).toHaveText('Reset password');

    await question(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(modal(page).locator('#vendor-dlg-title')).toHaveText('Bean Box');
    expect(calls).toEqual([]);
    await expect(modal(page).locator('#vendor-v-area')).toHaveValue('Al Rawdah'); // what was typed is still there
    await expect(modal(page).locator('.vendor-pw')).toHaveCount(0);
    await expect.poll(() => top(page, 31)).toBe(at); // back where it was, not at the top of the dialog

    await urow(page, 31).locator('.vendor-u-reset').click();
    await question(page).locator('button.btn-red').click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ fn: 'staff_vendor_user_reset', body: { p_user: 31 } });
    await expect(modal(page).locator('.vendor-pw-val')).toHaveText('Tmp7-Ab3c-Xy');
    expect(await scrolled(page)).toBe(st); // the new password is drawn in place, not with the dialog back at its top
    await expect(urow(page, 31).locator('.vendor-u-temp')).toContainText('Temporary password — expires');
    await expect(modal(page).locator('#vendor-v-area')).toHaveValue('Al Rawdah');
  });

  test('Deactivate names the login; No keeps it active, Yes switches it off; Activate asks nothing', async ({ page }) => {
    const calls = await openVenue(page);
    await urow(page, 31).locator('.vendor-u-off').click();
    await expect(question(page)).toBeVisible();
    await expect(modal(page).locator('#dlgt-confirm')).toHaveText(await tx(page, 'vndDeactivateQ', 'desk@beanbox.example'));
    await expect(modal(page).locator('.chrome-dbody')).toHaveText(await tx(page, 'vndDeactivateBody'));
    await expect(question(page).locator('button.btn-red')).toHaveText('Deactivate');

    await question(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(modal(page).locator('#vendor-dlg-title')).toHaveText('Bean Box');
    expect(calls).toEqual([]);
    await expect(urow(page, 31).locator('.vendor-u-off')).toBeVisible();
    expect(await page.evaluate(`S._vendor.users.find(u=>u.id===31).active`)).toBe(true);

    await urow(page, 31).locator('.vendor-u-off').click();
    await question(page).locator('button.btn-red').click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ fn: 'staff_vendor_user_active', body: { p_user: 31, p_active: false } });
    await expect(urow(page, 31).locator('.vendor-u-on')).toBeVisible();
    await expect(urow(page, 31)).toContainText('Off');

    // Switching a login back on: straight away, no question.
    await urow(page, 32).locator('.vendor-u-on').click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toEqual({ fn: 'staff_vendor_user_active', body: { p_user: 32, p_active: true } });
    await expect(question(page)).toHaveCount(0);
    await expect(modal(page).locator('#vendor-dlg-title')).toHaveText('Bean Box');
    await expect(urow(page, 32).locator('.vendor-u-off')).toBeVisible();
  });
});
