import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Sessions, 2026-10-05 fixes: the bike collection time is the form's only when staff type one (it
// follows the start until then, saves nothing, and a time after the start is refused); the template
// link dies with the form; a template's push carries a bike ride's collection time; and the calendar
// counts places by the one rule.

const ride = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_date: id.slice(0, 10), day: 'Tuesday', status: 'open', capacity: 2, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":2}', ...extra,
});
async function sessionsPage(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
async function addForm(page: Page) {
  await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S._nsTplId=null;S.newSessEvent='jcc';S.newSessCollect='';S.newSessStartTime='21:00';S.newSessEndTime='23:00';S.newSessMode='total';S.newSessTotal=10;renderSessions()`);
  await expect(page.locator('#sess-add-form')).toBeVisible();
}
function posts(page: Page, method: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== method || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
    try { const b = r.postDataJSON(); (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => out.push(x)); } catch { /* not JSON */ }
  });
  return out;
}

test.describe('@staff:sessions fix5 sessions', () => {
  test('an untouched collection time follows the start and is not saved', async ({ page }) => {
    await sessionsPage(page);
    await addForm(page);
    const rows = posts(page, 'POST');
    await page.locator('#ns-date').fill('2099-03-03');
    await page.locator('#ns-start').fill('19:00');
    await expect(page.locator('#ns-collect')).toHaveValue('18:15');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(1);
    expect(JSON.parse(String(rows[0].bike_slots))._collect).toBeUndefined();
  });

  test('a typed collection time is saved, and one after the start is refused', async ({ page }) => {
    await sessionsPage(page);
    await addForm(page);
    const rows = posts(page, 'POST');
    await page.locator('#ns-date').fill('2099-03-03');
    await page.locator('#ns-collect').fill('21:30'); // after the 21:00 start
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect(page.locator('#sess-add-form')).toContainText('can’t be later than the start');
    expect(rows.length).toBe(0);
    await page.locator('#ns-collect').fill('20:10');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(1);
    expect(JSON.parse(String(rows[0].bike_slots))._collect).toBe('20:10');
  });

  test('the edit form holds only a collection time the ride has', async ({ page }) => {
    await sessionsPage(page, { sessions: [ride('2099-03-10')] });
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-03-10')`);
    expect(await page.evaluate('S.editSessCollect')).toBe('');
    await expect(page.locator('#es-collect')).toHaveValue('20:15');
    await page.locator('#es-start').fill('19:00');
    await expect(page.locator('#es-collect')).toHaveValue('18:15');
  });

  test('the template link dies with the form', async ({ page }) => {
    await sessionsPage(page, { sessions: [ride('2099-03-10')] });
    await page.evaluate(`setStaffTab('sessions')`);
    const after = (js: string) => page.evaluate(`S._nsTplId='tplX';${js};S._nsTplId`);
    expect(await after(`_calNew('2099-03-20')`)).toBeNull();
    expect(await after(`cloneSession('2099-03-10')`)).toBeNull();
    expect(await after(`_on_renderSessions_22(null,null)`)).toBeNull();
  });

  test("a template's push carries a bike ride's collection time", async ({ page }) => {
    await sessionsPage(page, { sessions: [ride('2099-03-10')] });
    const patches = posts(page, 'PATCH');
    await page.evaluate(`setStaffTab('sessions');_nsTplPush({id:'t1',label:'Circuit',form:{newSessEvent:'jcc',newSessStartTime:'21:00',newSessEndTime:'23:00',newSessCollect:'20:05',newSessMode:'total',newSessTotal:10}},[allSessions().find(x=>x.id==='2099-03-10')])`);
    await expect.poll(() => patches.length).toBe(1);
    expect(JSON.parse(String(patches[0].bike_slots))._collect).toBe('20:05');
  });

  test('the calendar counts places by the one rule', async ({ page }) => {
    const r = ride('2099-03-10');
    const qe = (id: string, n: number, status: string) => ({ id, session_id: r.id, session_day: 'Tuesday', session_date: r.id, queue_num: n, name: 'R' + n, status, type_preference: 'Road', paid: false, price: 75, registered_at: '2099-01-01T09:00:00Z' });
    await sessionsPage(page, { sessions: [r], queue_entries: [qe('a', 1, 'waiting'), qe('b', 2, 'waiting'), qe('c', 3, 'active')] });
    await page.evaluate(`setStaffTab('sessions');S.sessView='cal';S._calYm='2099-03';renderSessions()`);
    await expect(page.locator('.cal-sess em').first()).toHaveText('2/2'); // three riders on two places: full, never 3/2
  });
});
