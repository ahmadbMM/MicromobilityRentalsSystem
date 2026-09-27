import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Templates that reach their rides, and the booking window (2026-09-28).
//  - A template saved again keeps its id and offers to update the future rides made from it; the
//    rides made from a template carry its id; one Undo puts them back.
//  - Admins set how far ahead riders may book (site_content booking.window); a rider's list shows a
//    ride that is not open yet greyed, with the day it opens, and never selects it.
const d = (n: number) => { const x = new Date(Date.now() + n * 864e5); return x.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); };
const sess = (id: string, date: string, extra: Record<string, unknown> = {}) => ({ id, day: 'Friday', session_date: date, capacity: 12, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":12}', ...extra });
const sessions = [sess(d(3), d(3), { template_id: 'tplX' }), sess(d(10), d(10), { template_id: 'tplX' }), sess(d(-2), d(-2), { template_id: 'tplX' }), sess(d(5), d(5))];
const templates = [{ key: 'session_templates', items: [{ id: 'tplX', label: 'Thu night', form: { newSessEvent: 'jcc', newSessStartTime: '20:00', newSessEndTime: '22:30', newSessMode: 'total', newSessTotal: '15', newSessAddons: [], newSessWlMode: '', newSessWlVal: '' } }] }];

function patches(page: Page, table: string) {
  const out: Array<{ id: string; body: Record<string, unknown> }> = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes(`/rest/v1/${table}`)) { const id = decodeURIComponent((r.url().match(/id=eq\.([^&]+)/) || [])[1] || ''); let body: Record<string, unknown> = {}; try { body = r.postDataJSON() || {}; } catch { /* */ } out.push({ id, body }); } });
  return out;
}

test.describe('booking window', () => {
  test('a ride beyond the window is not open yet; on the boundary day the hour decides', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    const r = await page.evaluate(`(()=>{
      const s=(n)=>({session_date:new Date(Date.now()+n*864e5).toLocaleDateString('en-CA',{timeZone:'Asia/Riyadh'})});
      S._bw={days:7,at:'23:59'};
      const out={far:_bwOpensOn(s(10)),near:_bwOpensOn(s(3)),edge:_bwOpensOn(s(7))};
      S._bw={days:7,at:'00:00'};out.edgeOpen=_bwOpensOn(s(7));
      S._bw=null;out.none=_bwOpensOn(s(300));
      S._bw={days:'x'};out.bad=_bwOpensOn(s(300));
      return out;})()`) as Record<string, unknown>;
    expect(r.far).toMatchObject({ day: d(3), at: '23:59' });
    expect(r.near).toBeNull();
    expect(r.edge).toMatchObject({ day: d(0) }); // opens today at 23:59, so not yet
    expect(r.edgeOpen).toBeNull();
    expect(r.none).toBeNull();
    expect(r.bad).toBeNull();
  });

  test("a rider sees the far ride greyed with the day it opens, cannot pick it, and the window is read from site_content", async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], site_content: [{ key: 'booking.window', value: { days: 7, at: '20:00' } }] });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('register')`);
    await page.waitForFunction(`S._bw&&S._bw.days===7`);
    await page.evaluate(`renderRegister()`);
    const soon = page.locator(`.sess-card-soon[data-session="${d(10)}"]`);
    await expect(soon).toBeVisible();
    await expect(soon).toContainText('Booking opens');
    await expect(page.locator('button.sess-card')).toHaveCount(2); // the rides 3 and 5 days out
    await page.evaluate(`S.selSession=${JSON.stringify(d(10))};renderRegister()`);
    expect(await page.evaluate(`S.selSession`)).not.toBe(d(10));
  });

  test('the admin sets it on Sessions; blank clears it', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], site_content: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const posts: Record<string, unknown>[] = []; let dels = 0;
    page.on('request', (r) => { if (r.url().includes('/rest/v1/site_content')) { if (r.method() === 'POST') { try { posts.push(r.postDataJSON()); } catch { /* */ } } if (r.method() === 'DELETE') dels++; } });
    await page.evaluate(`setStaffTab('sessions')`);
    await expect(page.locator('.bw-card')).toBeVisible();
    await page.locator('#bw-days').fill('7');
    await page.locator('#bw-at').fill('20:00');
    await page.locator('.bw-card button', { hasText: 'Save' }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ key: 'booking.window', value: { days: 7, at: '20:00' } });
    await expect.poll(() => page.evaluate(`_bwGet()`)).toEqual({ days: 7, at: '20:00' });
    await page.locator('#bw-days').fill('');
    await page.locator('.bw-card button', { hasText: 'Save' }).click();
    await expect.poll(() => dels).toBe(1);
    await expect.poll(() => page.evaluate(`_bwGet()`)).toEqual({ days: null, at: null });
    // Front Desk has no card
    await page.evaluate(`S.staffRole='frontdesk';S.queueView='sessions';renderSessions()`);
    await expect(page.locator('.bw-card')).toHaveCount(0);
  });
});

test.describe('templates reach their rides', () => {
  test('the future rides made from a template are found, and the template push rewrites them from its saved form with one undo', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], staff_options: templates });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions')`);
    const fut = await page.evaluate(`_nsTplFuture('tplX').map(s=>s.id).sort()`);
    expect(fut).toEqual([d(3), d(10)].sort()); // not the ride two days ago
    const w = patches(page, 'sessions');
    await page.evaluate(`_nsTplPush(_nsTpls()[0],_nsTplFuture('tplX'))`);
    await expect.poll(() => w.length).toBe(2);
    for (const p of w) {
      expect(p.body.capacity).toBe(15);
      expect(JSON.parse(String(p.body.bike_slots))).toMatchObject({ _time: '20:00 - 22:30', _total: 15 });
    }
    expect(await page.evaluate(`S.undoStack.length`)).toBe(1);
    // the form on screen was left as it was
    expect(await page.evaluate(`S.newSessTotal`)).not.toBe('15');
  });

  test('saving a template under a name it already has keeps its id, and applying one marks the next rides', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], staff_options: templates });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions')`);
    await page.evaluate(`_nsTplApply('tplX')`);
    expect(await page.evaluate(`S._nsTplId`)).toBe('tplX');
    // saving again under the same label: the id stays, and the question about the future rides comes
    await page.evaluate(`S.newSessTotal='18'`);
    const opts: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/staff_options') && r.method() !== 'GET') { try { opts.push(r.postDataJSON()); } catch { /* */ } } });
    const save = page.evaluate(`_nsTplSave()`);
    await page.locator('#prompt-input').fill('Thu night');
    await page.locator('#confirm-modal .btn-primary').click(); // the prompt lives in the confirm host
    await expect(page.locator('#confirm-modal')).toContainText('2 future rides were made from "Thu night"');
    await page.locator('#confirm-modal button', { hasText: 'Cancel' }).click();
    await save;
    await expect.poll(() => opts.length).toBe(1);
    const items = (opts[0] as { items: Array<{ id: string; label: string; form: { newSessTotal: string } }> }).items;
    expect(items[0].id).toBe('tplX');
    expect(items[0].label).toBe('Thu night');
    expect((items[0] as { form: { newSessTotal: string } }).form.newSessTotal).toBe('18');
  });
});
