import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// No bar at the bottom when an action is done (the owner, 2026-09-29, after the undo bar went on
// 2026-09-28). A finished action's toast is quiet: it is still put in the toast area, a polite live
// region, so a screen reader says it, but it is not drawn. A bar still shows for what the person has
// to know - an error, a warning, and 'info' (nothing was done, text to copy by hand, an upload under way).

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [{ id: today, day: 'Friday', session_date: today, capacity: 40, status: 'open', created_at: 0 }];
const entry = {
  id: 'e1', session_id: today, session_day: 'Friday', session_date: today, queue_num: 7, name: 'Rider Seven', phone: '',
  customer_id: null, status: 'waiting', paid: true, price: 30, walk_in: true, registered_at: '2026-01-01T10:00:00Z', type_preference: 'Road',
};

/** Every toast on the page: its text, its classes, and whether anything of it is drawn. */
const toasts = (page: Page) => page.locator('#toast-container .toast').evaluateAll((els) => els.map((el) => {
  const r = el.getBoundingClientRect();
  return { text: el.textContent, cls: el.className, drawn: r.width > 2 && r.height > 2 };
}));

for (const side of ['staff', 'customer'] as const) {
  test(`${side}: a finished action's toast is said, not drawn; errors, warnings and info still show`, async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [entry], bikes: [] });
    if (side === 'staff') await unlockStaff(page); else await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await expect(page.locator('#toast-container')).toHaveAttribute('aria-live', 'polite');
    await page.evaluate(() => {
      // @ts-expect-error app global
      toast('Saved'); toast('Copied', 'success'); toast('Could not save', 'error'); toast('Bike is out', 'warning'); toast('Nothing to export', 'info');
    });
    const all = await toasts(page);
    expect(all.map((x) => [x.text, x.drawn])).toEqual([
      ['Saved', false], ['Copied', false], ['Could not save', true], ['Bike is out', true], ['Nothing to export', true],
    ]);
    expect(all[0].cls).toContain('quiet');
    expect(all[2].cls).not.toContain('quiet');
  });
}

test('marking a rider pending at the desk puts no bar up (it used to show as a warning)', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [entry], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffTab='queue';renderStaffQueue()`);
  await page.evaluate(`togglePayment('e1','pending')`);
  await expect.poll(() => toasts(page)).toContainEqual(expect.objectContaining({ text: 'Pending', drawn: false }));
  expect((await toasts(page)).filter((x) => x.drawn)).toEqual([]);
});
