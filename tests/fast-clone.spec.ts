import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Fast clone (the user, 2026-11-15: "add a fast clone option on sessions that when clicked only asks for the date that the
// clone wanted to be in and its status of it open closed etc."): a pop-up with a date and a status, and the session is
// copied as it is to that date, in that status, with no form.

const JCC = {
  id: '2099-03-03', day: 'Tuesday', session_date: '2099-03-03', capacity: 40, status: 'open', created_at: 1, draft: false,
  title: 'Night ride', title_ar: 'ركوب ليلي', addons: '["helmet"]', lockers: true,
  bike_slots: '{"_time":"21:00 - 23:00","_total":40,"_wl":{"m":"count","v":10},"_fbk":1}',
};
const PM = {
  id: '2099-03-04-pw', day: 'Wednesday', session_date: '2099-03-04', capacity: 30, status: 'closed', created_at: 1, draft: false,
  event_kind: 'community', ride_kind: 'petromin', paid_ride: true, hide_queue: false, needs_approval: false,
  bike_slots: '{"_time":"19:00 - 21:00","_total":30,"_collect":"18:15","_inv":{"u":"x"}}',
};

async function staff(page: Page, sessions: Record<string, unknown>[]) {
  await page.clock.setFixedTime(new Date('2099-03-01T09:00:00+03:00'));
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], promo_codes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('sessions')`);
  await page.waitForFunction('S.dataLoaded');
}
function inserts(page: Page) {
  const l: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !/\/rest\/v1\/sessions\b/.test(r.url())) return;
    try { const b = r.postDataJSON(); l.push(...(Array.isArray(b) ? b : [b])); } catch { /* none */ }
  });
  return l;
}
const slotsOf = (r: Record<string, unknown>) => JSON.parse(String(r.bike_slots)) as Record<string, unknown>;
const box = (page: Page) => page.locator('#confirm-modal .fc-box');

test.describe('@staff:fast-clone Fast clone asks only for a date and a status', () => {
  test('the session detail offers it beside Clone, and it opens a pop-up with the date and every status', async ({ page }) => {
    await staff(page, [JCC]);
    await page.evaluate(`selectSessionDetail('${JCC.id}')`);
    const words = await page.evaluate(`(()=>{const o=(S._shMenus||{})['sh:sess']||{},tp=document.createElement('template');tp.innerHTML=(o.grp||[]).map(g=>g[1]||'').join(' ');return tp.content.textContent;})()`);
    expect(words).toContain('Clone');
    expect(words).toContain('Fast clone');
    await page.evaluate(`fastCloneSession('${JCC.id}')`);
    await expect(box(page)).toBeVisible();
    await expect(box(page).locator('#fc-date')).toBeFocused();
    await expect(box(page).locator('.fc-st .toggle-btn')).toHaveText(['Draft', 'Open', 'Closed', 'Fully Booked', 'Full, no waitlist']);
    await expect(box(page).locator('.fc-st .toggle-btn.active')).toHaveText('Draft');
    // nothing else is asked
    await expect(box(page).locator('input, select, textarea')).toHaveCount(1);
  });

  test('without a date nothing is made', async ({ page }) => {
    await staff(page, [JCC]);
    const made = inserts(page);
    await page.evaluate(`fastCloneSession('${JCC.id}')`);
    await box(page).getByRole('button', { name: 'Clone', exact: true }).click();
    await expect(box(page)).toBeVisible();
    await expect(box(page).locator('#fc-date')).toHaveAttribute('aria-invalid', 'true');
    expect(made).toHaveLength(0);
  });

  test('Open: the same session on the picked date, open, with its name, add-ons and waitlist rule', async ({ page }) => {
    await staff(page, [JCC]);
    const made = inserts(page);
    await page.evaluate(`fastCloneSession('${JCC.id}')`);
    await box(page).locator('#fc-date').fill('2099-03-10');
    await box(page).getByRole('button', { name: 'Open', exact: true }).click();
    await expect(box(page).getByRole('button', { name: 'Open', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await box(page).getByRole('button', { name: 'Clone', exact: true }).click();
    await expect.poll(() => made.length).toBe(1);
    const r = made[0];
    expect(r).toMatchObject({ id: '2099-03-10', session_date: '2099-03-10', day: 'Tuesday', status: 'open', draft: false, capacity: 40,
      title: 'Night ride', title_ar: 'ركوب ليلي', addons: '["helmet"]', lockers: true });
    expect(slotsOf(r)).toEqual({ _time: '21:00 - 23:00', _total: 40, _wl: { m: 'count', v: 10 } }); // the original's "full" mark stays behind
    await expect(box(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate('S.selSessionDetail')).toBe('2099-03-10'); // the detail moves to the clone
  });

  test('Full, no waitlist and Draft are closed rows with their marks', async ({ page }) => {
    await staff(page, [JCC]);
    const fb = (await page.evaluate(`_fcRow(_sessGet('${JCC.id}'),'2099-03-17','fbk')`)) as Record<string, unknown>;
    expect([fb.status, fb.draft, slotsOf(fb)._fbk]).toEqual(['closed', false, 1]);
    const dr = (await page.evaluate(`_fcRow(_sessGet('${JCC.id}'),'2099-03-17','draft')`)) as Record<string, unknown>;
    expect([dr.status, dr.draft, slotsOf(dr)._fbk]).toEqual(['closed', true, undefined]);
    const cl = (await page.evaluate(`_fcRow(_sessGet('${JCC.id}'),'2099-03-17','closed')`)) as Record<string, unknown>;
    expect([cl.status, cl.draft]).toEqual(['closed', false]);
    const fu = (await page.evaluate(`_fcRow(_sessGet('${JCC.id}'),'2099-03-17','full')`)) as Record<string, unknown>;
    expect([fu.status, fu.draft]).toEqual(['full', false]);
  });

  test('a Petromin night keeps its mark, takes tonight\'s collection time and no invitation', async ({ page }) => {
    await staff(page, [PM]);
    const r = (await page.evaluate(`_fcRow(_sessGet('${PM.id}'),'2099-03-11','open')`)) as Record<string, unknown>;
    expect(r).toMatchObject({ id: '2099-03-11-pw', session_date: '2099-03-11', ride_kind: 'petromin', paid_ride: true, status: 'open' });
    expect(slotsOf(r)).toEqual({ _time: '19:00 - 21:00', _total: 30, _collect: '18:45' });
  });
});
