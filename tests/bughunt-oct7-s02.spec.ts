import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07 (pricing, auth and session helpers): regressions for what was fixed there.

const JSON_HDR = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

test.describe('@staff:bookings release a reserved bike', () => {
  const S1 = '2099-01-09';
  const sessions = [{ id: S1, day: 'Friday', session_date: S1, capacity: 12, status: 'open', created_at: 1 }];
  const bikes = [{ id: 'rM', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: [] }];

  test('a rider another desk has checked in keeps the bike: the release is guarded and says so', async ({ page }) => {
    const held: Record<string, unknown> = {
      id: 'q1', name: 'Rider q1', session_id: S1, session_day: 'Friday', session_date: S1, queue_num: 1, status: 'waiting', paid: false,
      price: 75, registered_at: S1 + 'T10:00:00Z', type_preference: 'Road', size: 'M', phone: '0550000001', assigned_bike_id: 'rM' };
    await stubSupabase(page, { sessions, bikes, queue_entries: [held] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getBikes().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${S1}';renderStaffQueue()`);
    expect(await page.evaluate(`_isReserved(getQueue().find(e=>e.id==='q1'))`)).toBe(true);
    // Meanwhile the rider was checked in on another desk: the guarded write matches no row.
    held.status = 'active';
    const urls: string[] = [];
    await page.route(/\/rest\/v1\/queue_entries\?.*id=eq\.q1/, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      urls.push(decodeURIComponent(route.request().url()));
      await route.fulfill({ status: 200, headers: JSON_HDR, body: '[]' });
    });
    await page.evaluate(`_releaseReserved('q1')`);
    await expect.poll(() => urls.length).toBe(1);
    expect(urls[0]).toContain('status=in.(waiting,waitlist)');
    expect(urls[0]).toContain('assigned_bike_id=eq.rM');
    await expect.poll(() => page.evaluate(`(e=>e&&e.status+'|'+e.assignedBikeId)(getQueue().find(e=>e.id==='q1'))`)).toBe('active|rM');
  });
});

test.describe('@customer:account signing out and in again', () => {
  test('the same account signing in again gets its ride news and deletion sections back', async ({ page }) => {
    await stubSupabase(page, {
      'rpc:customer_login': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '+966500000001', session_token: 'tok-2' }],
      'rpc:customer_deletion_request': { requested_at: null },
    });
    const consents: Record<string, unknown>[] = [];
    await page.route(/\/rest\/v1\/rpc\/customer_consents/, async (route) => {
      consents.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, headers: JSON_HDR, body: JSON.stringify({ privacy_version: '2099-01-01', privacy_at: '2026-09-22T10:00:00Z', ride_news: false, ride_news_at: '2026-09-01T10:00:00Z' }) });
    });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#acc-ride-news')).toBeVisible();
    await expect(page.locator('#acc-delete')).toBeVisible();
    const before = consents.length;
    await page.evaluate('doLogout(true)');
    await page.evaluate('openAuthModal()');
    await page.locator('#a-identifier').fill('spec@example.com');
    await page.locator('#a-pwd').fill('Password1');
    await page.evaluate('doLogin()');
    await page.waitForFunction(`S.loggedIn&&S.loggedIn.session_token==='tok-2'`);
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#acc-ride-news')).toBeVisible();
    await expect(page.locator('#acc-delete')).toBeVisible();
    expect(consents.length).toBeGreaterThan(before);
    expect(consents[consents.length - 1]).toMatchObject({ p_id: 'c1', p_token: 'tok-2' });
  });
});

test('@customer:reserve the photo lightbox close button is named Close', async ({ page }: { page: Page }) => {
  await stubSupabase(page, {});
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`(()=>{const i=document.createElement('img');i.src='/logo-dark.webp';i.alt='Water bottle';document.body.appendChild(i);_photoZoom(i);})()`);
  await expect(page.locator('#photo-lightbox .photo-lightbox-close')).toHaveAttribute('aria-label', 'Close');
});
