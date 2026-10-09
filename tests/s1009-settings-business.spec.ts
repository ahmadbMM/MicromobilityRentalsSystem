import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, loginCustomer } from './helpers/supabase';

// Settings > Business and > Pricing (2026-10-09, migrations 20261009160000 / 161000): the values an
// admin changes without a deploy. Each keeps its built-in constant until a setting says otherwise;
// staff read staff_options 'biz', riders the public copy (site_content 'biz.public') and ride_prices.

type Call = { name: string; body: Record<string, unknown> };
const rpcs = (page: Page) => {
  const calls: Call[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); } });
  return calls;
};
async function staff(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], staff_options: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();`);
}

test.describe('@staff:settings business settings', () => {
  test('the built-in values stand until a setting says otherwise, then the constants follow it', async ({ page }) => {
    await staff(page);
    expect(await page.evaluate('[GROUP_RIDE_MAX,EVENT_SEAT_MAX,JCC_ACCOUNT_CAP,COLLECT_BEFORE_MIN,OVERDUE_RIDE_MIN,RG_LOW,KIDS_MAX_CM,PIN_HOLD_MS,DEFAULT_PRICE]'))
      .toEqual([2, 5, 3, 45, 120, 8, 144, 270000, 57.5]);
    const after = await page.evaluate(`(()=>{S._staffAuthed=true;S.staffOptions={biz:{group_ride_max:4,event_seat_max:6,jcc_account_cap:2,collect_before_min:30,overdue_ride_min:90,
      rg_low:7,kids_max_cm:150,pin_hold_s:120,vat_pct:10,rider_companies:['Petromin','Acme'],equip_cats:['Helmet','Gloves'],reorder_mult:3,reorder_min:6,
      cancel_off:['price'],cancel_custom:[{code:'c_parking',label:'No parking'}],bd_milestones:[30],vendor_rs:['eid'],
      size_chart:{Road:[[160,'S'],[180,'M'],[null,'L']],Hybrid:[[170,'M'],[null,'L']]},pin_hold_bad:1}};_listOk.opts=true;_bizFromOpts();
      return[GROUP_RIDE_MAX,EVENT_SEAT_MAX,JCC_ACCOUNT_CAP,COLLECT_BEFORE_MIN,OVERDUE_RIDE_MIN,RG_LOW,KIDS_MAX_CM,PIN_HOLD_MS,_vatRate(),RIDER_COMPANIES.join(),
        EQUIP_CATS.join(),INV_CATS.includes('Gloves'),_reorderNeed(0,2,1),CANCEL_REASONS.map(r=>r[0]).includes('price'),CANCEL_REASONS[CANCEL_REASONS.length-1][0],
        CANCEL_REASONS[CANCEL_REASONS.length-2][1],BD_MILESTONES.join(),VENDOR_RS.join(),bikeFit(175,'Road'),bikeFit(175,'Mountain'),_CANCEL_OTHER===CANCEL_REASONS.length-1];})()`);
    expect(after).toEqual([4, 6, 2, 30, 90, 7, 150, 120000, 0.1, 'Petromin,Acme', 'Helmet,Gloves', true, 6, false, 'other', 'No parking', '30', 'eid', 'M', 'L', true]);
    // a setting that does not hold (out of range, Petromin dropped) keeps the built-in value
    const bad = await page.evaluate(`(()=>{S.staffOptions={biz:{group_ride_max:99,rider_companies:['Acme'],pin_hold_s:600}};_bizFromOpts();return[GROUP_RIDE_MAX,RIDER_COMPANIES.join(),PIN_HOLD_MS];})()`);
    expect(bad).toEqual([2, 'Petromin,Petrolube', 270000]);
  });

  test('an admin saves a card through staff_set_biz; the page then reads the new values', async ({ page }) => {
    await staff(page, { 'rpc:staff_set_biz': { group_ride_max: 3, event_seat_max: 8 } });
    const calls = rpcs(page);
    await page.evaluate(`S._staffAuthed=true;setStaffTab('settings');setSettingsView('business')`);
    expect(new URL(page.url()).pathname).toBe('/settings/business');
    const card = page.locator('[data-biz-card="limits"]');
    await expect(card.locator('#biz-group_ride_max')).toHaveAttribute('placeholder', '2');
    await card.locator('#biz-group_ride_max').fill('3');
    await card.locator('#biz-event_seat_max').fill('8');
    await card.locator('#biz-save-limits').click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_set_biz').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_set_biz')!.body).toEqual({ p_patch: { group_ride_max: 3, event_seat_max: 8, jcc_account_cap: null } });
    await expect.poll(() => page.evaluate('[GROUP_RIDE_MAX,EVENT_SEAT_MAX,JCC_ACCOUNT_CAP]')).toEqual([3, 8, 3]);
  });

  test('a value out of range is refused on the card, nothing is sent', async ({ page }) => {
    await staff(page);
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('settings');setSettingsView('business')`);
    const card = page.locator('[data-biz-card="times"]');
    await card.locator('#biz-pin_hold_s').fill('600');
    await card.locator('#biz-save-times').click();
    await expect(page.locator('#biz-err-times')).toHaveText('Enter a number from 30 to 270.');
    expect(calls.filter((c) => c.name === 'staff_set_biz')).toHaveLength(0);
  });

  test('a database before the settings says so instead of saving', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('settings');setSettingsView('business')`);
    await page.locator('#biz-group_ride_max').fill('3');
    await page.locator('#biz-save-limits').click();
    await expect(page.locator('.toast').last()).toContainText(/database/i);
    expect(await page.evaluate('GROUP_RIDE_MAX')).toBe(2);
  });

  test('a staffer who is not an admin reads the settings without save buttons', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffRole('frontdesk');setStaffTab('settings');setSettingsView('business')`);
    await expect(page.locator('#tab-settings .tm-note').first()).toHaveText('Only an admin can change these settings.');
    await expect(page.locator('[id^="biz-save-"]')).toHaveCount(0);
    await expect(page.locator('#biz-group_ride_max')).toBeDisabled();
  });

  test('Pricing writes a fare through staff_set_ride_price with the approval, and the fares follow', async ({ page }) => {
    await staff(page, { 'rpc:staff_set_ride_price': { ok: true }, ride_prices: [{ type: 'Road', price: 75, max_price: null, employee_price: null }, { type: 'Hybrid', price: 57.5, max_price: null, employee_price: 50 }] });
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('settings');setSettingsView('pricing')`);
    expect(new URL(page.url()).pathname).toBe('/settings/pricing');
    const row = page.locator('tr[data-pr="Road"]');
    await row.locator('#pr-road-p').fill('80');
    await row.locator('#pr-road-e').fill('60');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_set_ride_price').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_set_ride_price')!.body).toMatchObject({ p_type: 'Road', p_price: 80, p_max: null, p_employee: 60, p_op: 'Spec Staff' });
    await expect.poll(() => page.evaluate(`[RIDE_PRICES.Road,RIDE_PRICES_MAX.Any,EMPLOYEE_PRICES.Road,EMPLOYEE_PRICES.Hybrid,priceForType('Road')]`)).toEqual([80, 80, 60, 50, 80]); // applied once the answer is in
  });

  test('the highest fare may not be under the fare', async ({ page }) => {
    await staff(page);
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('settings');setSettingsView('pricing')`);
    const row = page.locator('tr[data-pr="Hybrid"]');
    await row.locator('#pr-hybrid-m').fill('40');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#pr-err')).toHaveText('The highest fare cannot be lower than the fare.');
    expect(calls.filter((c) => c.name === 'staff_set_ride_price')).toHaveLength(0);
  });
});

test.describe('@customer:reserve business settings', () => {
  test("a rider's page reads the public copy and the fares", async ({ page }) => {
    await stubSupabase(page, {
      sessions: [], queue_entries: [], bikes: [],
      site_content: [{ key: 'biz.public', value: { group_ride_max: 4, jcc_account_cap: 5, vat_no: '300000000000003', addr: { en: 'New Street 1, Jeddah', ar: 'شارع جديد 1، جدة' } } }],
      ride_prices: [{ type: 'Road', price: 80 }, { type: 'Hybrid', price: 60, employee_price: 45 }],
    });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await expect.poll(() => page.evaluate('[GROUP_RIDE_MAX,JCC_ACCOUNT_CAP,RIDE_PRICES.Road,RIDE_PRICES.Hybrid,EMPLOYEE_PRICES.Hybrid,RIDE_PRICES_MAX.Any]')).toEqual([4, 5, 80, 60, 45, 80]);
    await expect(page.locator('#mf-addr')).toHaveText('New Street 1, Jeddah');
    await expect(page.locator('#mf-vat')).toContainText('300000000000003');
  });

  test('with no settings and no fare rows the built-in values stand', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [] });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate('[GROUP_RIDE_MAX,RIDE_PRICES.Road,RIDE_PRICES_MAX.Any,EMPLOYEE_PRICES.Any,DEFAULT_PRICE]')).toEqual([2, 75, 75, 50, 57.5]);
    await expect(page.locator('#mf-vat')).toContainText('312555068900003');
  });
});
