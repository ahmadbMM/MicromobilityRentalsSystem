import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type FailWrite, type Fixtures } from './helpers/supabase';
// These specs cover the automatic promotion: Settings > Business wl_offer_mode 'auto' (the default is 'staff' since
// 2026-10-09, R7: staff choose who gets a freed place, tests/s1010-remind-waitlist.spec.ts).
const WL_AUTO = [{ key: 'biz', items: { wl_offer_mode: 'auto' } }];

// The last writes that read .error themselves go through _writeErr (2026-10-05): a refusal is
// said in the error bar, and written to the error log, in words that fit what was refused. A
// unique key other than a booking number used to read "That booking number was just taken by
// another device"; a refused promotion from the waitlist used to say nothing at all.

const FUT = '2099-11-11';
async function boot(page: Page, fx: Fixtures, fail?: FailWrite) {
  await stubSupabase(page, { staff_options: WL_AUTO, sessions: [], queue_entries: [], bikes: [], tags: [], customers: [], customer_tags: [], ...fx }, fail);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
const bar = (page: Page) => page.locator('#err-bar-el');

test.describe('@staff:writes refused writes are said', () => {
  test('only a booking-number clash reads as one; any other duplicate already exists', async ({ page }) => {
    await boot(page, {});
    const said = await page.evaluate(`({
      qnum: _errMessage({ code: '23505', message: 'duplicate key value violates unique constraint "queue_entries_session_qnum_uniq"', details: 'Key (session_id, queue_num)=(s0, 3) already exists.' }),
      tag: _errMessage({ code: '23505', message: 'duplicate key value violates unique constraint "tags_slug_uniq"' }),
    })`) as { qnum: string; tag: string };
    expect(said.qnum).toContain('booking number');
    expect(said.tag).toContain('already exists');
    expect(said.tag).not.toContain('booking number');
  });

  test('a tag already on the account is said as existing, and the grant stays open', async ({ page }) => {
    await boot(page, {
      tags: [{ id: 'tag_vip', name: 'VIP', slug: 'vip', color: '#e5a100' }],
      customers: [{ id: 'c1', name: 'Test Rider', email: 'rider@example.com', phone: '+966500000000', created_at: '2026-09-01T10:00:00Z' }],
    }, { table: 'customer_tags', methods: ['POST'], status: 409, code: '23505', message: 'duplicate key value violates unique constraint "customer_tags_pkey"' });
    await page.evaluate(`(async () => { showTagGrantModal('c1', 'tag_vip'); await saveTagGrant(); })()`);
    await expect(bar(page)).toContainText('already exists');
    await expect(bar(page)).not.toContainText('booking number');
    expect(await page.evaluate(`!!S._tg`)).toBe(true);
    expect(await page.evaluate(`(S.customerTags || []).some(ct => ct.customer_id === 'c1' && ct.tag_id === 'tag_vip')`)).toBe(false);
  });

  test('a refused promotion from the waitlist is said, and claims none', async ({ page }) => {
    await boot(page, {
      sessions: [{ id: FUT, session_date: FUT, day: 'Wednesday', status: 'open', capacity: 2, created_at: 1 }],
      queue_entries: [{
        id: 'w1', session_id: FUT, session_day: 'Wednesday', session_date: FUT, queue_num: 3, waitlist_num: 1, name: 'Test Rider',
        phone: '0500000000', type_preference: 'Road', status: 'waitlist', paid: false, price: 75, size: 'M', registered_at: '2099-01-01T10:00:00Z',
      }],
    }, { table: 'queue_entries', methods: ['PATCH'] });
    await page.waitForFunction(`getQueue().length>0`);
    expect(await page.evaluate(`_autoPromoteOldestWaitlist('${FUT}')`)).toBe(false);
    await expect(bar(page)).toBeVisible();
  });

  test('a refused promo-code switch is said in the bar, and the code stays as it was', async ({ page }) => {
    await boot(page, {
      promo_codes: [{ id: 'p1', code: 'TEST10', kind: 'percent', value: 10, active: true, created_at: '2026-09-01T10:00:00Z' }],
    }, { table: 'promo_codes', methods: ['PATCH'] });
    await page.waitForFunction(`(S.promoCodes || []).length > 0`);
    await page.evaluate(`togglePromoActive('p1')`);
    await expect(bar(page)).toBeVisible();
    expect(await page.evaluate(`S.promoCodes.find(c => c.id === 'p1').active`)).toBe(true);
  });
});
