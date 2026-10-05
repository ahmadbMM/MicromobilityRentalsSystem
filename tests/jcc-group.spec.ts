import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// JCC "Add group": walk-in style — free-text riders under ONE group name. Unnamed riders
// become "<group name> 2/3…", a named rider matching a saved customer gets linked, and all
// rows share a group_id + group_name in a single queue_entries insert.
test('JCC group modal books multiple walk-in riders under one group name', async ({ page }) => {
  const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
  const customers = [{ id: 'c9', name: 'Known Rider', email: 'k@x.com', phone: '0599999999', height: 175 }];
  await stubSupabase(page, { sessions, customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);

  // the header button, on the phone as on the desktop
  await page.getByRole('button', { name: 'Add group' }).click();
  const modal = page.locator('#jcc-group-modal');
  await page.waitForTimeout(120); // let the modal's autofocus timer settle before filling
  await modal.locator('#jg-name').fill('Tamer Group');
  await modal.locator('#jg-cname').fill('Tamer'); // who the main phone belongs to
  await modal.locator('#jg-phone').fill('0512345678');
  await modal.locator('#jg-r-name-0').fill('Known Rider'); // matches the saved customer
  // rider's own phone wins over the group contact; it is the saved account's number, so it finds the account
  // (a number that matches nobody is not overruled by a namesake: tests/fix5-ra1-desk.spec.ts, 2026-10-05)
  await modal.locator('#jg-r-ph-0').fill('0599999999');
  await modal.locator('#jg-r-h-1').fill('170'); // second rider: no name, just a height
  await modal.getByRole('button', { name: /\+ Add rider/ }).click(); // third rider: empty row still holds a bike
  await expect(modal.locator('#jg-r-name-2')).toBeVisible();

  const posts: Record<string, unknown>[][] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rest/v1/queue_entries')) {
      const sent = r.postDataJSON();
      posts.push(Array.isArray(sent) ? sent : [sent]);
    }
  });
  await modal.getByRole('button', { name: /Add group \(3\)/ }).click();
  await expect(modal).toBeHidden(); // save completed and closed the modal (toast is too short-lived to assert under load)

  expect(posts).toHaveLength(1);
  const rows = posts[0];
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.name)).toEqual(['Known Rider', 'Tamer Group 2', 'Tamer Group 3']);
  expect(new Set(rows.map((r) => r.group_id)).size).toBe(1); // one shared group
  expect(rows.every((r) => r.group_name === 'Tamer Group')).toBe(true);
  expect(rows.every((r) => r.session_id === 's0' && r.status === 'waiting')).toBe(true);
  expect(rows.map((r) => r.phone)).toEqual(['0599999999', '0512345678', '0512345678']); // own phone first, group phone as fallback
  expect(rows.every((r) => r.group_contact === 'Tamer')).toBe(true); // main phone's owner stored on the booking
  expect(rows.every((r) => r.group_phone === '0512345678')).toBe(true); // responsible person's own number kept on every row
  expect(rows[0].customer_id).toBe('c9'); // the known customer gets linked, like Walk-in
  expect(rows[0].walk_in).toBe(false);
  expect(rows[1].walk_in).toBe(true);
  expect(rows[1].height).toBe(170);
});
