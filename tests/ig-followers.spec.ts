import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Instagram follower counts, staff only (2026-10-03, migration 20261003220000). A count sits beside
// the rider's Instagram link in Community > Accounts; its dialog checks it now through
// /api/ig-followers (Instagram's Business Discovery, dormant until the Meta keys are set) or takes a
// typed number. A count made for the rider's old handle is not shown. All traffic is stubbed.

const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', gender: 'female', socials: { instagram: 'lina.rides' }, created_at: '2026-06-10T09:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', gender: 'male', socials: { instagram: 'omar_s' }, created_at: '2026-06-11T09:00:00Z' },
  { id: 'c3', name: 'Sara Nabil', email: 'sara.nabil@gmail.com', phone: '+966551876217', gender: 'female', created_at: '2026-06-12T09:00:00Z' },
  { id: 'c4', name: 'Hadi Karam', email: 'hadi.karam@gmail.com', phone: '+966551876218', gender: 'male', socials: { instagram: 'hadi.new' }, created_at: '2026-06-13T09:00:00Z' },
];
const customer_ig_followers = [
  { customer_id: 'c1', handle: 'lina.rides', followers: 12400, source: 'auto', counted_at: '2026-10-01T10:00:00Z', status: 'ok', tried_at: '2026-10-01T10:00:00Z', updated_by: 'Instagram' },
  { customer_id: 'c4', handle: 'hadi.old', followers: 900, source: 'staff', counted_at: '2026-09-01T10:00:00Z', status: 'ok', tried_at: null, updated_by: 'Malik' },
];

type Api = (body: Record<string, unknown>) => Record<string, unknown>;
async function staff(page: Page, api: Api, fx: Fixtures = {}, noTable = false) {
  const calls: Record<string, unknown>[] = [];
  await page.route('**/api/ig-followers', async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(api(body)) });
  });
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], tags: [], customer_tags: [], staff_options: [], customer_ig_followers, ...fx });
  if (noTable) await page.route('**/rest/v1/customer_ig_followers*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"42P01","message":"relation does not exist"}' }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  // The endpoint is staff-only: the app sends the Supabase session's token, which the stub lacks.
  await page.evaluate(`S.staffRole='admin'`);
  await page.evaluate(`sb.auth.getSession=async()=>({data:{session:{access_token:'spec-token'}}})`);
  await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
  await page.waitForFunction('S._igAt>0&&!S._igBusy');
  return calls;
}
const row = (page: Page, id: string) => page.locator(`#am-cust-rows .am-row[data-cust="${id}"]`);
const modal = (page: Page) => page.locator('#confirm-modal .ig-dlg');
const writes = (page: Page) => {
  const out: Request[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/customer_ig_followers')) out.push(r); });
  return out;
};

test.describe('@staff:community instagram followers', () => {
  test('rows show the count for the current handle only, and a typed number is saved', async ({ page }) => {
    const calls = await staff(page, () => ({ ok: false, skipped: 'not configured' }));
    await expect(row(page, 'c1').locator('.ig-chip')).toHaveText('12.4k followers');
    await expect(row(page, 'c2').locator('.ig-chip.ig-none')).toHaveText('Followers');
    await expect(row(page, 'c3').locator('.ig-chip')).toHaveCount(0); // no Instagram, no chip
    await expect(row(page, 'c4').locator('.ig-chip.ig-none')).toHaveText('Followers'); // counted for hadi.old
    // Opening Accounts asked once for the accounts that are due.
    await expect.poll(() => calls.filter((c) => c.stale === true).length).toBe(1);
    expect(calls[0].staffToken).toBe('spec-token');

    const sent = writes(page);
    await row(page, 'c2').locator('.ig-chip').click();
    await expect(modal(page)).toContainText('Instagram followers · Omar Saleh');
    await expect(modal(page)).toContainText('Not counted yet.');
    await modal(page).locator('#ig-typed').fill('nope');
    await modal(page).getByRole('button', { name: 'Save' }).click();
    expect(sent.length).toBe(0);
    await modal(page).locator('#ig-typed').fill('3.2k');
    await modal(page).getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].postDataJSON()).toMatchObject({ customer_id: 'c2', handle: 'omar_s', followers: 3200, source: 'staff', updated_by: 'Spec Staff' });
    await expect(modal(page)).toContainText('3,200 followers');
    await expect(modal(page)).toContainText('Typed by Spec Staff');
    await expect(row(page, 'c2').locator('.ig-chip')).toHaveText('3.2k followers');

    // The server said automatic counting is not set up (on the Accounts visit): the dialog says so
    // and does not offer Check now.
    await expect(modal(page)).toContainText("Automatic counting isn't set up yet");
    await expect(modal(page).getByRole('button', { name: 'Check now' })).toHaveCount(0);

    // Remove the number deletes the row.
    await modal(page).getByRole('button', { name: 'Remove the number' }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].method()).toBe('DELETE');
    expect(sent[1].url()).toContain('customer_id=eq.c2');
    await expect(row(page, 'c2').locator('.ig-chip')).toHaveText('Followers');
  });

  test('Check now shows what Instagram counted, and says when it cannot count an account', async ({ page }) => {
    const at = '2026-10-03T08:00:00Z';
    await staff(page, (b) => {
      if (b.stale) return { ok: true, checked: 0, reason: 'recent' };
      const id = (b.customerIds as string[])[0];
      return id === 'c4'
        ? { ok: true, checked: 1, results: [{ customer_id: 'c4', handle: 'hadi.new', followers: null, source: null, counted_at: null, status: 'unavailable', tried_at: at, updated_by: null }] }
        : { ok: true, checked: 1, results: [{ customer_id: id, handle: 'omar_s', followers: 51234, source: 'auto', counted_at: at, status: 'ok', tried_at: at, updated_by: 'Instagram' }] };
    });
    await row(page, 'c2').locator('.ig-chip').click();
    await modal(page).getByRole('button', { name: 'Check now' }).click();
    await expect(modal(page)).toContainText('51,234 followers');
    await expect(modal(page)).toContainText('Counted by Instagram');
    await expect(row(page, 'c2').locator('.ig-chip')).toHaveText('51.2k followers');
    await modal(page).getByRole('button', { name: 'Close' }).first().click();

    await row(page, 'c4').locator('.ig-chip').click();
    await modal(page).getByRole('button', { name: 'Check now' }).click();
    await expect(modal(page)).toContainText("Instagram can't count this account");
    await expect(row(page, 'c4').locator('.ig-chip')).toHaveText('Followers');
  });

  test('a database without the table draws no chips', async ({ page }) => {
    await staff(page, () => ({ ok: false, skipped: 'not configured' }), {}, true);
    await expect(row(page, 'c1')).toBeVisible();
    await expect(page.locator('.ig-chip')).toHaveCount(0);
  });
});
