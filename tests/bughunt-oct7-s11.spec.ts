import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07: the check-in's Bike field, Reserve bike's Undo, the bike form's option
// lists and the fleet import's line numbers. Invented riders and bikes only.

const B42 = { id: 'b1', name: 'Road 042', bike_number: 42, type: 'Road', size: 'M', status: 'available', colors: ['#000000'], color_names: ['Black'], frame_type: 'Carbon' };
const B43 = { id: 'b2', name: 'Road 043', bike_number: 43, type: 'Road', size: 'M', status: 'available', colors: ['#ffffff'], color_names: ['White'], frame_type: 'Carbon' };
const SESSION = { id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 };
const ENTRY = {
  id: 'e1', session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 7,
  name: 'Rider Seven', phone: '', customer_id: null, group_id: null, status: 'waiting', paid: false,
  price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z', type_preference: 'Road', size: 'M',
};

function rpcBodies(page: Page, name: string) {
  const out: Array<Record<string, unknown>> = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(`/rest/v1/rpc/${name}`)) { try { out.push(r.postDataJSON()); } catch { /* none */ } }
  });
  return out;
}

test.describe('@staff:bookings bug hunt 2026-10-07 (s11)', () => {
  test('Confirm waits for a bike number still being looked up, then hands over THAT bike', async ({ page }) => {
    const fx: Record<string, unknown> = {
      queue_entries: [ENTRY], sessions: [SESSION], bikes: [B42, B43],
      'rpc:staff_resolve_bike': { found: true, bike: B42, rented_to: null },
    };
    await stubSupabase(page, fx);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const checkins = rpcBodies(page, 'staff_checkin');
    // @ts-expect-error app globals
    await page.evaluate(() => { S.staffTab = 'queue'; renderStaffQueue(); showCheckinModal('e1'); });
    const modal = page.locator('#checkin-modal');
    await modal.locator('#ci-bike').fill('42');
    await modal.locator('#ci-bike').press('Enter');
    await expect(modal.locator('#ci-bike-spec')).toContainText('042');
    await expect(modal.locator('#ci-confirm')).toBeEnabled();
    // The staffer corrects the number; the answer for 43 is slow.
    fx['rpc:staff_resolve_bike'] = { found: true, bike: B43, rented_to: null };
    await page.route(/\/rest\/v1\/rpc\/staff_resolve_bike/, async (route) => {
      if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 1200));
      await route.fallback();
    });
    await modal.locator('#ci-bike').fill('43');
    await expect(modal.locator('#ci-confirm')).toBeDisabled();       // it used to stay enabled on bike 42
    await expect(modal.locator('#ci-bike-spec')).toContainText('043');
    await expect(modal.locator('#ci-confirm')).toBeEnabled();
    await modal.locator('#ci-confirm').click();
    await expect.poll(() => checkins.length).toBe(1);
    expect(checkins[0]).toMatchObject({ p_booking_id: 'e1', p_bike_id: 'b2' });
  });

  test('a lookup typed for one party rider does not leave "Looking" (and Confirm off) on the next', async ({ page }) => {
    const rows = [
      { ...ENTRY, id: 'p1', group_id: 'grp', name: 'First Rider' },
      { ...ENTRY, id: 'p2', group_id: 'grp', name: 'Second Rider', queue_num: 8 },
    ];
    await stubSupabase(page, { queue_entries: rows, sessions: [SESSION], bikes: [B42], 'rpc:staff_resolve_bike': { found: false } });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    // @ts-expect-error app globals
    await page.evaluate(() => { S.staffTab = 'queue'; renderStaffQueue(); showCheckinModal('p1'); });
    const modal = page.locator('#checkin-modal');
    await modal.locator('#ci-bike').fill('R-11');
    // straight on to the second rider, inside the field's debounce
    await modal.getByRole('list', { name: 'Riders in this party' }).getByRole('button', { name: /2 Second/ }).click();
    await expect(modal).toContainText('Rider 2 of 2');
    await page.waitForTimeout(700);
    await expect(modal.locator('#ci-bike-spec')).not.toContainText('Looking');
    await expect(modal.locator('#ci-confirm')).toBeEnabled();
  });

  test('Undo of Reserve bike puts the "to be reserved" mark back', async ({ page }) => {
    const rows: Record<string, unknown>[] = [{ ...ENTRY, id: 'q1', name: 'Marked One', to_reserve: true }];
    await stubSupabase(page, { queue_entries: rows, sessions: [SESSION], bikes: [B42] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const patches: Array<Record<string, unknown>> = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /queue_entries\?.*id=eq\.q1/.test(r.url())) patches.push(JSON.parse(r.postData() || '{}')); });
    await page.evaluate(`setStaffTab('queue');openModal('q1');pickBike('b1')`);
    await page.evaluate(`reserveBike()`);
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ assigned_bike_id: 'b1', to_reserve: false });
    await page.evaluate(`doUndo()`);
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toEqual({ assigned_bike_id: null, to_reserve: true });
    expect(await page.evaluate(`getQueue().find(e=>e.id==='q1').toReserve`)).toBe(true);
  });

  test('renaming the brand the form has picked keeps it picked, under its new name, with its model', async ({ page }) => {
    const lists = [{ key: 'bike_brands', items: [{ name: 'Giant', models: ['TCR'] }, { name: 'Trek', models: ['Domane'] }] }];
    await stubSupabase(page, { sessions: [SESSION], queue_entries: [], bikes: [], staff_options: lists });
    await page.route(/\/rest\/v1\/staff_options/, async (route) => {
      if (route.request().method() === 'POST') {
        const b = JSON.parse(route.request().postData() || '{}');
        const row = lists.find((r) => r.key === b.key); if (row) row.items = b.items;
      }
      await route.fallback();
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S.staffOptions && S.staffOptions.bike_brands`);
    await page.waitForTimeout(300);
    await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';renderInventory();S.showAddBike=true;S._bkBrand='Giant';S._bkModel='TCR';renderBikes()`);
    await page.locator('.opt-edit[data-on-click*="brands"]').click();
    const modal = page.locator('#optlist-modal');
    await modal.locator('input[aria-label="Giant"]').fill('Giant Bicycles');
    await modal.locator('#optlist-save').click();
    await expect(modal).toBeHidden();
    expect(await page.evaluate(`[S._bkBrand,S._bkModel]`)).toEqual(['Giant Bicycles', 'TCR']);
  });

  test('a refused list save leaves the form\'s lists as the database holds them', async ({ page }) => {
    await stubSupabase(page, { sessions: [SESSION], queue_entries: [], bikes: [], staff_options: [{ key: 'bike_groupsets', items: ['Shimano 105'] }] },
      { table: 'staff_options', methods: ['POST'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S.staffOptions && S.staffOptions.bike_groupsets`);
    const ok = await page.evaluate(`_optWrite('bike_groupsets',['Shimano 105','Ultegra'])`);
    expect(ok).toBe(false);
    expect(await page.evaluate(`_bkGroupsetList()`)).toEqual(['Shimano 105']);
  });

  test('the import preview numbers each row by its line in the file, blank lines included', async ({ page }) => {
    await stubSupabase(page, { sessions: [SESSION], queue_entries: [], bikes: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('inventory')`);
    const lines = await page.evaluate(`_bkCsvRows('number,type\\n\\n42,Road\\n\\n\\n43,"Hybrid"\\n').rows.map(r=>r.line)`);
    expect(lines).toEqual([3, 6]);
  });
});
