import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The scanner's Flashlight (the user, 2026-11-10): a button in the corner of the camera view lights the
// phone's torch, for tickets and bike stickers in the dark. It shows only when the camera says it has a
// torch, and the choice lasts the page's life: the camera opened again comes back lit.
// Headless Chromium has no camera, so a canvas stream stands in, its track given a torch (or not).
async function boot(page: Page, torch: boolean) {
  await stubSupabase(page, { queue_entries: [], sessions: [] });
  await unlockStaff(page);
  await page.addInitScript((hasTorch: boolean) => {
    const w = window as unknown as { __torch: boolean[] };
    w.__torch = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 320;
      const g = c.getContext('2d');
      if (g) { g.fillStyle = '#777'; g.fillRect(0, 0, 320, 320); }
      const s = c.captureStream(5), tr = s.getVideoTracks()[0];
      tr.getCapabilities = () => (hasTorch ? { torch: true } : {}) as MediaTrackCapabilities;
      tr.applyConstraints = async (k?: MediaTrackConstraints) => {
        w.__torch.push(!!(k?.advanced?.[0] as { torch?: boolean } | undefined)?.torch);
      };
      return s;
    };
  }, torch);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
}
const openScanner = (page: Page) => page.evaluate(`S.staffTab='queue';renderStaffQueue();openScanModal()`);
const calls = (page: Page) => page.evaluate('window.__torch') as Promise<boolean[]>;

test('the flashlight lights the torch, stays lit when the camera comes back, and goes off again', async ({ page }) => {
  await boot(page, true);
  await openScanner(page);
  const btn = page.locator('#scan-torch-btn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAccessibleName('Flashlight');
  expect(await calls(page)).toEqual([]); // nothing is lit until asked

  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(btn).toHaveClass(/active/);
  expect(await calls(page)).toEqual([true]);

  await page.evaluate('closeScanModal()');
  await openScanner(page);
  await expect(page.locator('#scan-torch-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => calls(page)).toEqual([true, true]); // the new camera lit by itself

  await page.locator('#scan-torch-btn').click();
  await expect(page.locator('#scan-torch-btn')).toHaveAttribute('aria-pressed', 'false');
  expect(await calls(page)).toEqual([true, true, false]);
});

test('a camera without a torch gets no flashlight button', async ({ page }) => {
  await boot(page, false);
  await openScanner(page);
  await expect(page.locator('#scan-video')).toHaveJSProperty('paused', false); // the camera is up
  await page.waitForTimeout(900); // past the second look for a late torch
  await expect(page.locator('#scan-torch-btn')).toBeHidden();
});
