import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The desk, 2026-10-05 fixes: Front Desk never meets the Saturday side (search, day sheet, the
// bell, the Staff List's rides and Browse), a walk-up's price follows its bike type, a phone typed
// in Arabic-Indic digits is taken, a slow press on a Staff List suggestion still picks it, and a
// unit of an add-on added after a price change is charged at today's price.

const T = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); // the KSA day, as todayStr()
const ago = new Date(Date.now() - 3 * 3600e3).toISOString();
const circuit = { id: T, session_date: T, day: 'Monday', status: 'open', capacity: 12, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' };
const sat = { id: T + '-sat', session_date: T, day: 'Monday', status: 'open', capacity: 20, created_at: 2, event_kind: 'community', needs_approval: true, bike_slots: '{"_time":"06:30 - 07:00"}' };
const later = { id: '2099-02-10', session_date: '2099-02-10', day: 'Tuesday', status: 'open', capacity: 12, created_at: 3, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' };
const qe = (id: string, s: { id: string; session_date: string }, n: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: s.id, session_day: 'Monday', session_date: s.session_date, queue_num: n, name, phone: '05000000' + String(n).padStart(2, '0'),
  customer_id: null, type_preference: 'Road', status: 'waiting', paid: false, price: 75, registered_at: '2099-01-01T09:00:00Z', ...extra,
});
const walkup = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, phone: '0511111111', bike_type: 'Road', status: 'waiting', paid: false, author: null, kind: 'managed', sort_order: 1,
  created_at: '2099-01-01T10:00:00Z', resolved_at: null, ...extra,
});
async function desk(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, { sessions: [circuit, sat, later], bikes: [], queue_entries: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
}
function bodies(page: Page, method: string, path: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== method || !r.url().includes(path)) return;
    try { const b = r.postDataJSON(); (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => out.push(x)); } catch { /* not JSON */ }
  });
  return out;
}

test.describe('@staff:bookings fix5 desk', () => {
  test('Front Desk never meets the Saturday side', async ({ page }) => {
    await desk(page, { queue_entries: [
      qe('j1', circuit, 1, 'Circuit Walker'), qe('s1', sat, 1, 'Saturday Walker'),
      qe('j2', circuit, 2, 'Circuit Long', { status: 'active', checked_in_at: ago }), qe('s2', sat, 2, 'Saturday Long', { status: 'active', checked_in_at: ago }),
    ] });
    await page.evaluate(`setStaffRole('frontdesk')`);
    const fd = await page.evaluate(`(()=>{
      window._openReport=h=>{window.__ds=h;};printDaySheet();
      return {hits:(_gsHits('Walker')||[]).map(h=>h.l),opts:_mwSessOpts().map(x=>x.id),add:(S._mwSess='all',_mwAddableBookings().map(e=>e.id)),
        long:(_ntKindsNow().find(k=>k.k==='long')||{ids:[]}).ids,sheet:String(window.__ds||'')};
    })()`) as { hits: string[]; opts: string[]; add: string[]; long: string[]; sheet: string };
    expect(fd.hits.join('|')).toContain('Circuit Walker');
    expect(fd.hits.join('|')).not.toContain('Saturday');
    expect(fd.opts).not.toContain(sat.id);
    expect(fd.add).toContain('j1');
    expect(fd.add).not.toContain('s1');
    expect(fd.long).toEqual(['j2']);
    expect(fd.sheet).toContain('Circuit Walker');
    expect(fd.sheet).not.toContain('Saturday Walker');
    // an admin still sees both
    await page.evaluate(`setStaffRole('admin')`);
    expect((await page.evaluate(`(_gsHits('Walker')||[]).map(h=>h.l).join('|')`)) as string).toContain('Saturday Walker');
  });

  test("a walk-up's price follows its bike type, unless it was set by hand", async ({ page }) => {
    await desk(page, { desk_waitlist: [walkup('w1', 'Walk Up'), walkup('w2', 'Hand Priced', { sort_order: 2 })] });
    const patches = bodies(page, 'PATCH', '/rest/v1/desk_waitlist');
    const p = await page.evaluate(`(()=>{const a=S.deskWaitlist.find(w=>w.id==='w1'),b=S.deskWaitlist.find(w=>w.id==='w2');a.price=priceForType('Road');b.price=12;return [priceForType('Road'),priceForType('Hybrid')];})()`) as number[];
    expect(p[0]).not.toBe(p[1]); // the two fares differ, or this says nothing
    await page.evaluate(`mwSetType('w1','Hybrid')`);
    await expect.poll(() => patches.find((b) => b.bike_type === 'Hybrid' && 'price' in b)?.price).toBe(p[1]);
    await page.evaluate(`mwSetType('w2','Hybrid')`);
    await expect.poll(() => patches.filter((b) => b.bike_type === 'Hybrid').length).toBe(2);
    expect('price' in patches.filter((b) => b.bike_type === 'Hybrid')[1]).toBe(false); // the hand-set 12 stays
  });

  test('a waitlist phone typed in Arabic-Indic digits is taken, and stored as every phone is', async ({ page }) => {
    await desk(page, { desk_waitlist: [] });
    const rows = bodies(page, 'POST', '/rest/v1/desk_waitlist');
    await page.evaluate('showWlAddModal()');
    await page.locator('#wl-name').fill('Digit Guest');
    await page.locator('#wl-phone').fill('٠٥٥١٢٣٤٥٦٧');
    await page.evaluate('addDeskWaitlist()');
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].phone).toBe('+966551234567');
  });

  test('a slow press on a Staff List suggestion still picks it', async ({ page }) => {
    await desk(page, { queue_entries: [qe('k1', later, 4, 'Slow Pick')], desk_waitlist: [] });
    const rows = bodies(page, 'POST', '/rest/v1/desk_waitlist');
    await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
    await page.locator('#mw-name').click();
    await page.locator('#mw-name').pressSequentially('Slow');
    const sug = page.locator('#mw-suggest .mw-sug', { hasText: 'Slow Pick' });
    await expect(sug).toBeVisible();
    const box = (await sug.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(450); // longer than the box's 180 ms close
    await page.mouse.up();
    await expect.poll(() => rows.some((r) => r.booking_id === 'k1')).toBe(true);
  });

  test('a unit added after a price change goes on a line at today\'s price', async ({ page }) => {
    await desk(page, {
      queue_entries: [qe('b1', later, 1, 'Addon Rider', { addons: '[{"id":"i1","qty":1,"p":5}]' })],
      inventory: [{ id: 'i1', name: 'Gel', price: 8, qty: 10, category: 'Supplements' }],
    });
    const patches = bodies(page, 'PATCH', '/rest/v1/queue_entries');
    await page.evaluate(`_entryAddonMutate('b1','i1',1)`);
    await expect.poll(() => patches.filter((b) => 'addons' in b).length).toBe(1);
    expect(JSON.parse(String(patches.filter((b) => 'addons' in b)[0].addons))).toEqual([{ id: 'i1', qty: 1, p: 5 }, { id: 'i1', qty: 1 }]);
    expect(await page.evaluate(`addonsCost(entryAddons(getQueue().find(e=>e.id==='b1')))`)).toBe(13); // 5 then, 8 now
    // and taking one off takes the newest
    await page.evaluate(`_entryAddonMutate('b1','i1',-1)`);
    await expect.poll(() => patches.filter((b) => 'addons' in b).length).toBe(2);
    expect(JSON.parse(String(patches.filter((b) => 'addons' in b)[1].addons))).toEqual([{ id: 'i1', qty: 1, p: 5 }]);
  });
});
