import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Every community member gives their Instagram (the owner, 2026-10-09: "force all community members to add their
// instagram accounts for whoever who hasn't have it"). The server asks it of a member with none on file
// (_customer_asks, 20261009235000); the check-up opens at sign-in with its own words, no "I don't have one", and
// Log out as the only other way off. A handle staff flagged keeps "I don't have one". Every person here is made up.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }];

function rpcBodies(page: Page, fn: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new RegExp(`/rpc/${fn}(\\?|$)`).test(r.url())) out.push(r.postDataJSON()); });
  return out;
}
async function open(page: Page, socials: Record<string, string> | null) {
  await stubSupabase(page, {
    sessions, queue_entries: [], 'rpc:my_bookings': [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', socials }],
    'rpc:customer_fix_fields': ['instagram'],
    'rpc:customer_fix_save': [],
  });
  const sent = rpcBodies(page, 'customer_fix_save');
  await loginCustomer(page, { id: 'c1', phone: '0500000001' });
  await page.goto('/');
  await waitForSb(page);
  await expect(page.locator('#fix-gate .fx-box')).toBeVisible();
  return sent;
}

test.describe('@customer:fix a community member without an Instagram', () => {
  test('the check-up says why, has no "I don\'t have one", and saves the handle', async ({ page }) => {
    const sent = await open(page, null);
    await expect(page.locator('#fx-title')).toHaveText('Add your Instagram');
    await expect(page.locator('#fx-sub')).toContainText('every community member');
    await expect(page.locator('#fix-gate .fx-none')).toHaveCount(0);
    await expect(page.locator('#fix-gate .gate-out')).toBeVisible(); // Log out, the only other way off
    await page.keyboard.press('Escape');
    await expect(page.locator('#fix-gate .fx-box')).toBeVisible();
    await page.click('#fx-save');
    await expect(page.locator('.fx-item[data-fx="instagram"].err')).toBeVisible();
    expect(sent).toHaveLength(0);
    await page.fill('#fx-soc-instagram', '@lina.rides');
    await page.click('#fx-save');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_values).toEqual({ instagram: 'lina.rides' });
    await expect(page.locator('#fix-gate .fx-box')).toHaveCount(0);
  });

  test('a handle staff flagged still offers "I don\'t have one"', async ({ page }) => {
    await open(page, { instagram: 'old.handle' });
    await expect(page.locator('#fix-gate .fx-none')).toHaveCount(1);
    await expect(page.locator('#fx-title')).not.toHaveText('Add your Instagram');
  });
});
