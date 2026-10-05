import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// A rider's page on a bad day (2026-10-05 review, slice ra1):
// - a members check that does not answer is a connection problem, said as one: it used to answer
//   "no", so a real member on a weak signal was told the rides are for members only;
// - a device whose site storage refuses to be read still loads its rides: the staff-device mark
//   was read outside a try in the data load, and one refusal there failed every load.

const jcc = { id: '2099-01-09', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1, location: 'JCC' };
const sat = {
  id: 'comm1', day: 'Saturday', session_date: '2099-01-10', capacity: 20, status: 'open', created_at: 1, location: 'JCC',
  event_kind: 'community', needs_approval: true, hide_queue: true, spots: 20, title: 'Saturday Social Ride',
};
const head = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };

test.describe('@customer:reserve fix5 ra1 members check', () => {
  test('a members check that fails says so; a real no still shows the members popup', async ({ page }) => {
    await stubSupabase(page, {
      sessions: [jcc, sat], bikes: [], queue_entries: [],
      'rpc:community_member': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } },
    });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await waitForSb(page);
    const conn = await page.evaluate(`t('errConnection')`) as string;
    await page.evaluate(`selectEvent('community')`);
    await expect(page.locator('#toast-container')).toContainText(conn);
    await expect(page.locator('#confirm-modal .cm-box')).toHaveCount(0);
    expect(await page.evaluate(`S.selEvent`)).not.toBe('community');
    // the same from a ride's card
    await page.evaluate(`S.selEvent='community';setCustTab('register')`);
    await page.locator('.sess-card-comm').click();
    await expect(page.locator('#confirm-modal .cm-box')).toHaveCount(0);
    expect(await page.evaluate(`S.selSession`)).toBeNull();
    // a real "no" is still the members popup
    await page.route(/\/rest\/v1\/rpc\/community_member/, (r) => r.fulfill({ status: 200, headers: head, body: 'false' }));
    await page.locator('.sess-card-comm').click();
    await expect(page.locator('#confirm-modal')).toContainText('Community members only');
  });
});

test.describe('@customer:reserve fix5 ra1 blocked storage', () => {
  test('a device whose storage refuses to say whether it is a staff device still loads its rides', async ({ page }) => {
    await stubSupabase(page, { sessions: [jcc], bikes: [], queue_entries: [] });
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (this: Storage, k: string) {
        if (k === 'cq_staff') throw new DOMException('The operation is insecure.', 'SecurityError');
        return get.call(this, k);
      };
    });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`allSessions().map(s => s.id)`)).toEqual([jcc.id]);
  });
});
