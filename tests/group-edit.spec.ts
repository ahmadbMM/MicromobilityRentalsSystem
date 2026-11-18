import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Edit-group modal: one place to change the group's name/contact/main phone and each
// member's details. Members on the old main phone follow the new one; a member's own
// phone wins; group_name/group_contact are stamped on every row.
test('group edit modal updates group info and every member', async ({ page }) => {
  const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
  const row = (id: string, qn: number, name: string): Record<string, unknown> => ({
    id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: qn, name,
    phone: '0512345678', customer_id: null, type_preference: 'Road', status: 'waiting', paid: false,
    price: 30, registered_at: '2099-01-01T10:00:00Z', group_id: 'g1', group_name: 'Tamer Group',
  });
  const queue_entries = [row('e1', 1, 'Tamer Group 1'), row('e2', 2, 'Tamer Group 2')];
  await stubSupabase(page, { sessions, queue_entries });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(() => {
    // @ts-expect-error app globals
    showGroupEditModal('e1');
  });

  const modal = page.locator('#group-edit-modal');
  await expect(modal.locator('#ge-gname')).toHaveValue('Tamer Group');
  // The focus manager moves focus into a new modal 40 ms after it appears. Let that land
  // before typing, or under load it fires between two fills and the phone lands in the name.
  await page.waitForFunction(() => { const m = document.getElementById('group-edit-modal'); return !!m && m.contains(document.activeElement); });
  await modal.locator('#ge-gname').fill('Falcons');
  await modal.locator('#ge-cname').fill('Tamer');
  await modal.locator('#ge-phone').fill('0599999999'); // new main phone: members on the old one follow
  await modal.locator('#ge-r-name-1').fill('Ali');
  await modal.locator('#ge-r-ph-1').fill('0577777777'); // own phone wins over the main phone

  const patches: Record<string, Record<string, unknown>> = {};
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      if (id) patches[id] = r.postDataJSON();
    }
  });
  await modal.getByRole('button', { name: /Save/ }).click();
  await expect(modal).toBeHidden();

  // Request events reach Node asynchronously — poll instead of asserting immediately.
  await expect.poll(() => Object.keys(patches).sort()).toEqual(['e1', 'e2']);
  expect(patches.e1.group_name).toBe('Falcons');
  expect(patches.e2.group_name).toBe('Falcons');
  expect(patches.e1.group_contact).toBe('Tamer');
  expect(patches.e1.phone).toBe('0599999999'); // followed the new main phone
  expect(patches.e2.phone).toBe('0577777777'); // kept their own number
  expect(patches.e2.name).toBe('Ali');
  expect(patches.e1.name).toBe('Tamer Group 1'); // untouched fields stay as they were
});

// Undo writes back only what the edit changed, and only over rows still as the edit left them (bug hunt 2026-11-18, as
// the single booking's Undo): run later from the Log, the whole old rows put a party checked in since back to waiting
// with the bikes still out.
test('group edit undo puts back only the changed fields, and nothing once a member was checked in since', async ({ page }) => {
  const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
  const row = (id: string, qn: number, name: string): Record<string, unknown> => ({
    id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: qn, name,
    phone: '0512345678', customer_id: null, type_preference: 'Road', status: 'waiting', paid: false,
    price: 30, registered_at: '2099-01-01T10:00:00Z', group_id: 'g1', group_name: 'Tamer Group',
  });
  const queue_entries = [row('e1', 1, 'Tamer Group 1'), row('e2', 2, 'Tamer Group 2')];
  await stubSupabase(page, { sessions, queue_entries });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`showGroupEditModal('e1')`);
  const modal = page.locator('#group-edit-modal');
  await expect(modal.locator('#ge-gname')).toHaveValue('Tamer Group');
  await page.waitForFunction(() => { const m = document.getElementById('group-edit-modal'); return !!m && m.contains(document.activeElement); });
  await modal.locator('#ge-gname').fill('Falcons');
  const patches: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) patches.push({ url: decodeURIComponent(r.url()), body: r.postDataJSON() });
  });
  await modal.getByRole('button', { name: /Save/ }).click();
  await expect(modal).toBeHidden();
  await expect.poll(() => patches.length).toBe(2);
  await page.evaluate(`S.undoStack[S.undoStack.length-1].fn()`);
  await expect.poll(() => patches.length).toBe(4);
  for (const p of patches.slice(2)) {
    expect(p.url).toContain('status=eq.waiting');
    expect(p.url).toContain('session_id=eq.s0');
    expect(p.body.group_name).toBe('Tamer Group');
    for (const k of ['queue_num', 'session_id', 'session_date', 'price']) expect(k in p.body).toBe(false);
  }
  // again, with one member checked in since: nothing is written for anyone
  await page.evaluate(`showGroupEditModal('e1')`);
  await page.waitForFunction(() => { const m = document.getElementById('group-edit-modal'); return !!m && m.contains(document.activeElement); });
  await modal.locator('#ge-gname').fill('Hawks');
  await modal.getByRole('button', { name: /Save/ }).click();
  await expect(modal).toBeHidden();
  await expect.poll(() => patches.length).toBe(6);
  queue_entries[0].status = 'active';
  expect(await page.evaluate(`S.undoStack[S.undoStack.length-1].fn()`)).toBe(false);
  expect(patches.length).toBe(6);
});
