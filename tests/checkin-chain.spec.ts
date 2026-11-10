import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Claude Design #2: on a desktop, check-in opens as a panel beside the roster, and Previous / Next
// walk every rider still to check in on the roster as it is shown, so the desk can clear a queue
// without closing it. What was set for a rider (payment, type) is kept when the desk steps away.

const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const rider = (id: string, n: number, name: string, o: Record<string, unknown> = {}) => ({
  id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: n, name, phone: `050000000${n}`, customer_id: null,
  type_preference: 'Any', size: 'M', status: 'waiting', paid: false, price: 60, height: 178, registered_at: `2099-02-10T10:0${n}:00Z`, ...o,
});
const queue = [rider('e1', 1, 'Ali Saad'), rider('e2', 2, 'Badr Omar'), rider('e3', 3, 'Omar Ali', { status: 'active' }), rider('e4', 4, 'Dana Faisal')];

test('Previous and Next walk the riders still to check in, and keep what was set for each', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await stubSupabase(page, { sessions, queue_entries: queue, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue')`);
  await page.evaluate(`showCheckinModal('e1')`);
  const modal = page.locator('#checkin-modal');
  const chain = modal.locator('.ci-chain');
  await expect(chain.locator('.ci-chain-pos')).toHaveText('1 / 3'); // the active rider is not in it
  await expect(chain.locator('.ci-prev')).toBeDisabled();
  await expect(chain.locator('.ci-next')).toContainText('Badr');

  await modal.getByRole('button', { name: 'Road', exact: true }).click();
  await chain.locator('.ci-next').click();
  await expect(modal.getByText('#2 Badr Omar')).toBeVisible();
  await expect(chain.locator('.ci-chain-pos')).toHaveText('2 / 3');
  await chain.locator('.ci-next').click();
  await expect(modal.getByText('#4 Dana Faisal')).toBeVisible();
  await expect(chain.locator('.ci-next')).toBeDisabled();
  await chain.locator('.ci-prev').click();
  await chain.locator('.ci-prev').click();
  await expect(modal.getByText('#1 Ali Saad')).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Road', exact: true })).toHaveClass(/active/);
});

test('on a desktop the check-in is a panel at the side, the roster still in view', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await stubSupabase(page, { sessions, queue_entries: queue, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue')`);
  await page.evaluate(`showCheckinModal('e2')`);
  const box = await page.locator('#checkin-modal .ci-drawer-bg > .modal-box').boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.x + box!.width)).toBeGreaterThanOrEqual(1360);
  expect(box!.width).toBeLessThanOrEqual(481);
  // docked under the top bar since staff round s10 (D4): the rest of the height, to the foot
  const top = await page.evaluate(`document.getElementById('topbar').offsetHeight`) as number;
  expect(Math.round(box!.y)).toBeLessThanOrEqual(top + 1);
  expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(898);
});
