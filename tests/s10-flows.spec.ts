import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, checkinAsRow } from './helpers/supabase';

// Staff website round s10 (2026-11-10), the desk's flows: "Check in all paid (N)" in a party's check-in drawer (D2) and the
// check-in docked beside the roster at 1280px and up (D4). All traffic stubbed; invented data, a far-off date (no clock).

const row = (id: string, qn: number, name: string, x: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: qn, name, phone: '', customer_id: null,
  group_id: 'g1', status: 'waiting', paid: false, price: 30, walk_in: true, type_preference: 'Road', registered_at: '2099-01-01T10:00:00Z', ...x,
});
const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const queue = [
  row('e1', 1, 'Grouped One'),                    // owes
  row('e2', 2, 'Grouped Two', { paid: true }),
  row('e3', 3, 'Grouped Three', { paid: true }),
  row('e4', 4, 'Solo Four', { group_id: null }),
];

async function desk(page: Page, q = queue) {
  await stubSupabase(page, { queue_entries: q, sessions, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded');
  await page.evaluate(`S.staffRole='admin';setStaffTab('queue');S.sfSession='s0';renderStaffQueue()`);
}
function checkins(page: Page) {
  const ids: string[] = [];
  page.on('request', (r) => { const ci = checkinAsRow(r); if (ci) ids.push(String(ci.id)); });
  return ids;
}

test.describe('@staff:bookings s10 check-in all paid (D2)', () => {
  test('a rider who owes: the party\'s paid riders go in at once, each logged as a single check-in, and the drawer stays', async ({ page }) => {
    await desk(page);
    const ids = checkins(page);
    await page.evaluate(`showCheckinModal('e1')`);
    const modal = page.locator('#checkin-modal');
    const all = modal.getByRole('button', { name: 'Check in all paid (2)' });
    await expect(all).toBeVisible();
    await all.click();
    await expect.poll(() => [...ids].sort()).toEqual(['e2', 'e3']);
    await expect(modal).toContainText('Grouped One');                  // the rider who owes keeps their own drawer
    await expect(modal.locator('#ci-allpaid')).toHaveCount(0);           // nobody paid is left to take
    await expect(modal.locator('#ci-confirm')).toBeEnabled();
    await expect.poll(() => page.evaluate(`S.actionLog.map(l=>l.label)`)).toEqual(expect.arrayContaining(['Check in: #2 Grouped Two', 'Check in: #3 Grouped Three']));
    expect(await page.evaluate(`['e2','e3'].map(id=>_qGet(id).status)`)).toEqual(['active', 'active']);
    expect(ids).not.toContain('e1');
  });

  test('a paid rider open: they go in with the others, and the rider who owes opens next, as after a Confirm', async ({ page }) => {
    await desk(page);
    const ids = checkins(page);
    await page.evaluate(`showCheckinModal('e2')`);
    const modal = page.locator('#checkin-modal');
    await modal.getByRole('button', { name: 'Check in all paid (2)' }).click();
    await expect.poll(() => [...ids].sort()).toEqual(['e2', 'e3']);
    await expect(modal).toContainText('Grouped One');
    await expect(modal).toContainText('Rider 1 of 3');
  });

  test('not offered for one paid rider who is the one open, nor while that rider\'s drawer holds a change', async ({ page }) => {
    await desk(page, [row('e1', 1, 'Grouped One'), row('e2', 2, 'Grouped Two', { paid: true }), row('e3', 3, 'Grouped Three', { paid: true })]);
    await page.evaluate(`showCheckinModal('e2')`);
    const modal = page.locator('#checkin-modal');
    await expect(modal.locator('#ci-allpaid')).toHaveText('Check in all paid (2)');
    await modal.getByRole('button', { name: 'Hybrid', exact: true }).click(); // a type change: this rider keeps their drawer
    await expect(modal.locator('#ci-allpaid')).toHaveText('Check in all paid (1)');
    await page.evaluate(`showCheckinModal('e3')`);
    await page.evaluate(`getQueue().find(e=>e.id==='e2').paid=false;renderCheckinModal()`);
    await expect(modal.locator('#ci-allpaid')).toHaveCount(0);           // only the rider open is paid: Confirm is that
  });
});

test.describe('@staff:bookings s10 check-in docked beside the roster (D4)', () => {
  test('at 1280px and up: no scrim, the roster takes taps beside it, no Tab trap; Escape closes, focus moves in', async ({ page }) => {
    test.skip(test.info().project.name === 'mobile', 'a desk screen');
    await page.setViewportSize({ width: 1366, height: 900 });
    await desk(page);
    await page.evaluate(`showCheckinModal('e4')`);
    const dlg = page.locator('#checkin-modal [role="dialog"]');
    await expect(dlg).toBeVisible();
    await expect(dlg).toHaveAttribute('aria-modal', 'false');
    await expect.poll(() => page.evaluate(`document.getElementById('checkin-modal').contains(document.activeElement)`)).toBe(true);
    expect(await page.evaluate(`getComputedStyle(document.querySelector('#checkin-modal .ci-drawer-bg')).backgroundColor`)).toBe('rgba(0, 0, 0, 0)');
    expect(await page.evaluate(`document.body.classList.contains('ci-dock')`)).toBe(true);
    // the page makes room: the roster's right edge stops at the panel's left edge
    const panel = (await dlg.boundingBox())!;
    const main = (await page.locator('#staff-main').boundingBox())!;
    expect(panel.x + panel.width).toBeGreaterThanOrEqual(1360);
    expect(await page.evaluate(`parseFloat(getComputedStyle(document.getElementById('staff-main')).paddingInlineEnd)`)).toBeGreaterThanOrEqual(panel.width);
    expect(main.x).toBeLessThan(panel.x);
    // a tap beside the panel lands on the roster, not on a backdrop
    const hit = await page.evaluate(`(()=>{const el=document.elementFromPoint(${Math.round(panel.x - 40)},400);return!!el&&!el.closest('#checkin-modal')})()`);
    expect(hit).toBe(true);
    const search = page.locator('#sf-search-input').filter({ visible: true }).first();
    await search.click();
    await search.fill('Solo');
    await expect.poll(() => page.evaluate('S.sfSearch')).toBe('Solo');
    await expect(dlg).toBeVisible();                                     // still open beside it
    expect(await page.evaluate('S._ciId')).toBe('e4');
    // Tab is not trapped: from the roster it stays there
    await search.press('Tab');
    expect(await page.evaluate(`document.getElementById('checkin-modal').contains(document.activeElement)`)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('#checkin-modal [role="dialog"]')).toHaveCount(0);
    expect(await page.evaluate(`document.body.classList.contains('ci-dock')`)).toBe(false);
  });

  test('below 1280px it stays a dialog over its scrim', async ({ page }) => {
    test.skip(test.info().project.name === 'mobile', 'a desk screen (a phone keeps its sheet)');
    await page.setViewportSize({ width: 1100, height: 800 });
    await desk(page);
    await page.evaluate(`showCheckinModal('e4')`);
    const dlg = page.locator('#checkin-modal [role="dialog"]');
    await expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(await page.evaluate(`getComputedStyle(document.querySelector('#checkin-modal .ci-drawer-bg')).pointerEvents`)).not.toBe('none');
    expect(await page.evaluate(`parseFloat(getComputedStyle(document.getElementById('staff-main')).paddingInlineEnd)`)).toBeLessThan(100);
  });
});
