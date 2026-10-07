import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07 (s12): the bike form's "+ Add new" Cancel, a second tap on a Petromin rider while
// the first action is on its way, and the Riyadh day of a rider's purchases in their history.

test.describe('@staff:bikes bike option lists', () => {
  const sessions = [{ id: '2099-01-09', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }];
  const staff_options = [
    { key: 'bike_brands', items: [{ name: 'Brandone', models: ['Alpha'] }, { name: 'Brandtwo', models: ['Beta', 'Gamma'] }] },
    { key: 'bike_groupsets', items: ['Groupset A', 'Groupset B'] },
    { key: 'bike_frames', items: [] },
  ];

  test('Cancel on "+ Add new" puts back the value the field held', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], staff_options });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S.staffOptions && S.staffOptions.bike_brands`);
    await page.waitForTimeout(300);
    await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';renderInventory();S.showAddBike=true;S._bkBrand='';S._bkModel='';S._bkGroupset='';renderBikes()`);
    await page.selectOption('#bk-brand', 'Brandtwo');
    await page.selectOption('#bk-model', 'Gamma');
    await page.selectOption('#bk-groupset', 'Groupset B');

    // A model typed and then thought better of: the model the bike had comes back.
    await page.selectOption('#bk-model', '__add__');
    await expect(page.locator('input#bk-model')).toBeVisible();
    await page.evaluate(`_bkOptCancel('bk-model')`);
    await expect(page.locator('select#bk-model')).toHaveValue('Gamma');

    // The same for the brand, and its model stays with it.
    await page.selectOption('#bk-brand', '__add__');
    await page.evaluate(`_bkOptCancel('bk-brand')`);
    await expect(page.locator('select#bk-brand')).toHaveValue('Brandtwo');
    await expect(page.locator('select#bk-model')).toHaveValue('Gamma');

    await page.selectOption('#bk-groupset', '__add__');
    await page.evaluate(`_bkOptCancel('bk-groupset')`);
    await expect(page.locator('select#bk-groupset')).toHaveValue('Groupset B');

    // A model remembered for one brand is not put back under another.
    await page.selectOption('#bk-model', '__add__');
    await page.selectOption('#bk-brand', 'Brandone');
    await page.evaluate(`_bkOptCancel('bk-model')`);
    await expect(page.locator('select#bk-model')).toHaveValue('');
  });
});

test.describe('@staff:riders Petromin desk actions', () => {
  const D = '2099-02-08', SESS = '2099-02-08-pw';
  const sessions = [{
    id: SESS, day: 'Wednesday', session_date: D, capacity: 35, status: 'open', created_at: 1,
    bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }), location: 'JCC', addons: null,
    event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false,
  }];
  const rider_registrations = [{
    id: 1, source: 'petromin', session_id: SESS, booking_no: 'P-001', badge: 'Z-01', company: 'Petromin', name: 'Test Rider',
    phone: '+966500000091', height: 170, type_preference: 'Hybrid', matched_entry_id: null, matched_customer_id: null,
    match_kind: 'none', submissions: 1, checked_in_at: null, checked_out_at: null, checked_in_by: null, checked_out_by: null,
    price: null, created_at: '2099-02-08T09:00:00Z', updated_at: '2099-02-08T09:00:00Z',
  }];

  test('a second tap while the check-in is on its way does not return the rider', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], rider_registrations });
    const patches: Record<string, unknown>[] = [];
    // The check-in's write takes a moment, as on the desk's connection.
    await page.route(/\/rest\/v1\/rider_registrations/, async (route) => {
      if (route.request().method() === 'PATCH') { patches.push(route.request().postDataJSON()); await new Promise(r => setTimeout(r, 400)); }
      await route.fallback();
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    await expect(page.locator('#pm-host tbody tr')).toHaveCount(1);

    // Check in, and at once the button that took its place (Return): the second is dropped.
    await page.evaluate(`window.__ci=riderCheckin(1);riderReturn(1)`);
    await page.evaluate(`window.__ci`);
    expect(patches.length).toBe(1);
    expect(typeof patches[0].checked_in_at).toBe('string');
    expect(await page.evaluate(`!!S.riders[0].checked_in_at&&!S.riders[0].checked_out_at`)).toBe(true);

    // Once it has landed, Return works as before.
    await page.evaluate(`riderReturn(1)`);
    expect(patches.length).toBe(2);
    expect(typeof patches[1].checked_out_at).toBe('string');
  });
});

test.describe('@staff:community account history', () => {
  test('a purchase made after midnight in Riyadh shows that day, not the UTC one', async ({ page }) => {
    const customers = [{ id: 'c1', name: 'Test Person', email: 'test.person@example.com', phone: '+966500000092', gender: 'female', created_at: '2099-01-31T22:30:00Z' }];
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length===1');
    const [shown, want, since] = await page.evaluate(`(()=>{
      S.cashSales=[{id:'s1',customer_id:'c1',name:'Water',qty:1,price:5,pay:'card',category:'drinks',created_at:'2099-02-08T22:30:00Z'}];
      openAccountHistory('c1');
      return [document.querySelector('#cust-modal .ah-purch-row > span.ah-muted')?.textContent||'',shortDate('2099-02-09'),shortDate('2099-02-01')];
    })()`) as string[];
    expect(shown).toBe(want);
    await expect(page.locator('#cust-modal .ah-facts')).toContainText(since);
  });
});
