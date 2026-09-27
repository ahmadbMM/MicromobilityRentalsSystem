import { test, expect } from '@playwright/test';
import { stubSupabase, loadStaffHalf } from './helpers/supabase';

// Regression for the "duplicate key value violates unique constraint
// queue_entries_session_qnum_uniq" crash on cancel: closing the number gap must
// renumber WAITING rows around the numbers held by live COMPLETED/active rows,
// never onto them (those share the partial unique index).

test('_shiftPlan skips numbers held by completed bookings when closing a gap', async ({ page }) => {
  await stubSupabase(page);
  await page.goto('/');
  await loadStaffHalf(page); // _shiftPlan is the desk's

  // Mirrors the reported session: #34 and #37 are COMPLETE (done); the rest waiting.
  // #29 was just cancelled → fromNum = 29.
  const queue = [
    { id: 'w30', sessionId: 's1', status: 'waiting', queueNum: 30 },
    { id: 'd34', sessionId: 's1', status: 'done', queueNum: 34 },
    { id: 'w35', sessionId: 's1', status: 'waiting', queueNum: 35 },
    { id: 'w36', sessionId: 's1', status: 'waiting', queueNum: 36 },
    { id: 'd37', sessionId: 's1', status: 'done', queueNum: 37 },
    { id: 'w38', sessionId: 's1', status: 'waiting', queueNum: 38 },
  ];

  const plan = await page.evaluate(
    `_shiftPlan(${JSON.stringify(queue)}, 's1', 29)`,
  ) as Array<{ id: string; to: number }>;

  // No waiting row is renumbered onto a completed booking's number.
  const blocked = new Set([34, 37]);
  for (const p of plan) expect(blocked.has(p.to)).toBe(false);

  // Targets are unique (no two rows collide with each other either).
  const tos = plan.map((p) => p.to);
  expect(new Set(tos).size).toBe(tos.length);

  // The waiting rows compact into the free slots 29..32, hopping over 34 and 37.
  expect(plan).toEqual([
    { id: 'w30', to: 29 },
    { id: 'w35', to: 30 },
    { id: 'w36', to: 31 },
    { id: 'w38', to: 32 },
  ]);
});
