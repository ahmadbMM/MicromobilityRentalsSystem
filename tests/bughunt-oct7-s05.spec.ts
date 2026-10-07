import { test, expect } from '@playwright/test';
import { stubSupabase, waitForSb, loginCustomer, unlockStaff } from './helpers/supabase';

// Bug hunt 2026-10-07 (s05): a session's fleet label leaves out the settings keys (a Saturday ride's
// distances read "_km×60"); the ambassador card is only ever the signed-in account's; a photo saved
// while the account form holds edits keeps them, and one landing after a sign-out does not sign the
// rider back in; the bike type pills say which one is pressed.

test.describe('@staff:sessions fleet label (bug hunt oct 7)', () => {
  test('the fleet label names bike types only, never a settings key', async ({ page }) => {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goStaff()');
    const r = await page.evaluate(`[
      slotsLabel({_time:'07:00 - 09:00',_km:{beg:20,int:40}}),
      slotsLabel({_time:'07:00 - 09:00',_km:{beg:20},Road:{S:2,M:3}}),
      slotsLabel({_time:'21:00 - 23:00',Road:4,_wl:{m:'count',v:5}})]`);
    expect(r).toEqual(['—', 'Road×5', 'Road×4']);
  });
});

test.describe('@customer:account bug hunt oct 7 (s05)', () => {
  test('an ambassador answer kept for another account paints no card', async ({ page }) => {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], 'rpc:ambassador_mine': { ok: true, ambassador: true, code: 'RIDE10', status: 'active', earned: 5, balance: 5, uses: 1, events: [] } });
    await loginCustomer(page, { id: 'c1' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#amb-mine')).toContainText('RIDE10');
    const n = await page.evaluate(`(()=>{document.getElementById('amb-mine').remove();S._ambMine={...S._ambMine,forId:'c2'};_ambMinePaint();return document.querySelectorAll('#amb-mine').length;})()`);
    expect(n).toBe(0);
  });

  test('a photo saved while the form holds edits keeps them; one landing after a sign-out keeps the rider signed out', async ({ page }) => {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], 'rpc:customer_set_photo': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', photo: null, type_preference: 'Road' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await page.waitForFunction(`!S._profHydrating`);
    await page.fill('#acc-first', 'Lina'); // typed, not saved
    await page.evaluate(`_saveAccPhoto('data:image/png;base64,iVBORw0KGgo=')`);
    await expect(page.locator('img#acc-photo-img')).toHaveCount(1);
    await expect(page.locator('.cu-photo-btn')).toBeVisible();
    await expect(page.locator('#acc-first')).toHaveValue('Lina');
    // The type pills: the one picked is the one pressed.
    await page.evaluate(`_accPickType('Hybrid')`);
    await expect(page.locator('[id="atp-Hybrid"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[id="atp-Road"]')).toHaveAttribute('aria-pressed', 'false');
    const r = await page.evaluate(`(async()=>{const p=accRemovePhoto();doLogout(true);await p;return {li:!!S.loggedIn,ss:!!getSession()};})()`);
    expect(r).toEqual({ li: false, ss: false });
  });
});
