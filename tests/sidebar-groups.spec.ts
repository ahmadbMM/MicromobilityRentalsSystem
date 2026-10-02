import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The rail's group headings (Rides, Commerce, People...) are read whole at any screen height: on a
// 768px screen the flex column squeezed them to half a line once Settings made the rail one row
// taller than the screen (2026-10-02). The rail scrolls instead.
for (const h of [600, 768, 1000]) {
  test(`every group heading and section is whole on a ${h}px-high desk screen`, async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'the desk rail');
    await page.setViewportSize({ width: 1280, height: h });
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    // the hover rail (Keep sidebar open off), opened under the pointer: the headings unfold there
    await page.evaluate(`document.body.classList.add('rail-hover')`);
    await page.locator('#staff-tab-nav').hover();
    await page.waitForTimeout(300);
    const sizes = await page.locator('#staff-tab-nav .snav-group, #staff-tab-nav .tab-btn').evaluateAll((els) =>
      els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => ({ t: e.textContent!.trim(), h: e.getBoundingClientRect().height, sh: e.scrollHeight })));
    for (const s of sizes) expect(s.h, s.t).toBeGreaterThanOrEqual(s.sh - 1);
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="settings"]')).toBeAttached();
  });
}
