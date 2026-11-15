import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A new date in the session editor is asked about before anything is written (the user, 2026-11-15: "whenever i clone a
// session to a new date it changes the same original session to the new date and doesn't create a new one"). Save used to
// move the ride and its bookings unasked. Now: Move (as before), Clone (the new-session form, filled from the ride and what
// was typed, on the new date; the ride is left alone) or Cancel.

const SAT = {
  id: '2099-03-14-2', day: 'Saturday', session_date: '2099-03-14', capacity: 120, spots: 120, status: 'open', created_at: '2026-11-11T12:40:16.639Z',
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, open_to_all: false,
  meet_url: 'https://maps.example.test/meet', reveal_at: '2099-03-14T05:15:00+00:00', bike_slots: '{"_time":"05:45 - 06:15"}',
};
const booking = (id: string, n: number) => ({
  id, session_id: SAT.id, session_day: 'Saturday', session_date: SAT.session_date, queue_num: n, name: `Spec Rider ${n}`,
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 0, registered_at: '2099-01-01T10:00:00Z', approval: 'approved',
});

type Sent = { method: string; path: string; body: Record<string, unknown> };
async function open(page: Page) {
  await stubSupabase(page, {
    sessions: [SAT], queue_entries: [booking('q1', 1), booking('q2', 2)],
    'rpc:staff_move_session': { ok: true, id: '2099-03-21', day: 'Saturday' },
  });
  const sent: Sent[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.includes('/rest/v1/') || ['GET', 'HEAD', 'OPTIONS'].includes(r.method())) return;
    let body = {};
    try { body = r.postDataJSON() || {}; } catch { /* no body */ }
    sent.push({ method: r.method(), path: u.split('/rest/v1/')[1].split('?')[0], body });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0&&getQueue().length>1');
  await page.evaluate(`setStaffTab('sessions');selectSessionDetail('${SAT.id}')`);
  await page.locator('.sess-detail-actions').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#sess-edit-form')).toBeVisible();
  return sent;
}
const sessionWrites = (sent: Sent[]) => sent.filter((x) => x.path === 'sessions' || x.path === 'rpc/staff_move_session');
const save = (page: Page) => page.locator('#sess-edit-form .ss-form-acts .btn-primary').click();

test.describe('@staff:sessions a new date in the session editor', () => {
  test('asks first; Clone opens the new-session form on that date with what was typed, and the ride stays where it is', async ({ page }) => {
    const sent = await open(page);
    await page.locator('#es-date').fill('2099-03-21');
    await page.locator('#es-spots').fill('200');
    await save(page);
    const dlg = page.getByRole('dialog', { name: /Move .* to / });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('Its 2 bookings move with it');
    await dlg.getByRole('button', { name: 'Clone' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator('#sess-add-form')).toBeVisible();
    await expect(page.locator('#sess-edit-form')).toHaveCount(0);
    await expect(page.locator('#ns-date')).toHaveValue('2099-03-21');
    await expect(page.locator('#ns-spots')).toHaveValue('200');
    expect(await page.evaluate('[S.editSessionId,S.newSessEvent,S.newSessMapUrl,S.newSessReveal]'))
      .toEqual([null, 'community', 'https://maps.example.test/meet', '2099-03-21T08:15']); // its announce time a week on, as a move takes it
    expect(sessionWrites(sent)).toEqual([]); // nothing written to the ride

    await page.locator('#sess-add-form .ss-form-acts .btn-primary').click();
    await expect.poll(() => sessionWrites(sent).length).toBe(1);
    const [made] = sessionWrites(sent);
    expect(made).toMatchObject({ method: 'POST', path: 'sessions', body: { id: '2099-03-21', session_date: '2099-03-21', spots: 200, capacity: 200, ride_kind: 'saturday', meet_url: 'https://maps.example.test/meet', reveal_at: '2099-03-21T05:15:00.000Z' } });
    await page.waitForTimeout(300);
    expect(sessionWrites(sent)).toHaveLength(1); // no move, no delete of the original
    expect(sent.filter((x) => x.path === 'queue_entries')).toEqual([]); // its bookings stay on it
  });

  test('Move moves it, bookings and all, as before', async ({ page }) => {
    const sent = await open(page);
    await page.locator('#es-date').fill('2099-03-21');
    await save(page);
    await page.locator('#es-mv-move').click();
    await expect.poll(() => sent.filter((x) => x.path === 'rpc/staff_move_session').map((x) => x.body))
      .toEqual([{ p_from: SAT.id, p_to_id: '2099-03-21', p_date: '2099-03-21', p_exact: false }]);
    await page.waitForFunction('S.editSessionId===null');
    expect(sent.filter((x) => x.method === 'POST' && x.path === 'sessions')).toEqual([]); // moved, not copied
  });

  test('Cancel writes nothing and leaves the editor open on the new date', async ({ page }) => {
    const sent = await open(page);
    await page.locator('#es-date').fill('2099-03-21');
    await save(page);
    await page.getByRole('dialog', { name: /Move .* to / }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#es-mv-move')).toHaveCount(0);
    await expect(page.locator('#sess-edit-form')).toBeVisible();
    await expect(page.locator('#es-date')).toHaveValue('2099-03-21');
    await page.waitForTimeout(300);
    expect(sessionWrites(sent)).toEqual([]);
    // the save is free again: a second Save asks again
    await save(page);
    await expect(page.locator('#es-mv-copy')).toBeVisible();
    await page.keyboard.press('Escape'); // Escape is Cancel
    await expect(page.locator('#es-mv-copy')).toHaveCount(0);
    expect(sessionWrites(sent)).toEqual([]);
  });

  test('a save on the same date is not asked', async ({ page }) => {
    const sent = await open(page);
    await page.locator('#es-spots').fill('150');
    await save(page);
    await expect.poll(() => sessionWrites(sent).filter((x) => x.method === 'PATCH').length).toBeGreaterThan(0);
    await expect(page.locator('#es-mv-move')).toHaveCount(0);
    expect(sessionWrites(sent).filter((x) => x.path === 'rpc/staff_move_session' || x.method !== 'PATCH')).toEqual([]);
  });
});
