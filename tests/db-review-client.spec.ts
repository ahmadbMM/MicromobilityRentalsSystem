import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The client half of the 2026-09-22 database fixes (supabase/migrations/20260922122000 and
// 20260922124000):
//   · promo_codes is staff-only, so a rider's promo box asks promo_lookup() about the one code
//     typed - and falls back to the loaded list on a database that has no such function yet;
//   · inventory is read by named columns (cost is staff-only), and staff get the costs from
//     staff_inventory_costs();
//   · photos upload with upsert:false - the bucket grants INSERT only;
//   · Account names a phone another account holds (customer_update_profile's phone_taken).

const sessions = [{
  id: 's0', day: 'Sunday', session_date: '2099-02-08', capacity: 9,
  status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null,
}];
const listed = { id: 'p1', code: 'SUMMER10', kind: 'percent', value: 10, active: true, applies_to: null, expires_at: null, max_uses: null, uses: 0, customer_id: null };

/** Types the code into a promo box, applies it, and returns what the form now shows. */
async function apply(page: import('@playwright/test').Page, typed = 'SUMMER10') {
  return page.evaluate(`(async () => {
    S.regBikeTypes = ['Hybrid']; S.regQty = 1;
    const box = document.createElement('input');
    box.className = 'reg-promo'; box.value = ${JSON.stringify(typed)};
    document.body.appendChild(box);
    try { await applyPromoCode(); } finally { box.remove(); }
    return { applied: S.promoApplied ? S.promoApplied.code : null, value: S.promoApplied ? S.promoApplied.value : null, msg: S._promoMsg };
  })()`) as Promise<{ applied: string | null; value: number | null; msg: string }>;
}

test.describe('promo box asks the server about one code', () => {
  test('a rider applies a code the table no longer shows them', async ({ page }) => {
    await stubSupabase(page, { sessions, promo_codes: [],
      'rpc:promo_lookup': { ok: true, code: 'SUMMER10', kind: 'percent', value: 10, applies_to: null } });
    await loginCustomer(page, { id: 'c1', session_token: 'tok-1' });
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/promo_lookup')) sent.push(r.postDataJSON()); });
    await page.goto('/');
    await waitForSb(page);
    const r = await apply(page, 'summer10');
    expect(r).toEqual({ applied: 'SUMMER10', value: 10, msg: '' });
    expect(sent[0]).toMatchObject({ p_code: 'summer10', p_id: 'c1', p_token: 'tok-1' });
  });

  test('the server says why a code is refused', async ({ page }) => {
    await stubSupabase(page, { sessions, promo_codes: [listed], 'rpc:promo_lookup': { ok: false, reason: 'used_up' } });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    const r = await apply(page);
    expect(r.applied).toBeNull();
    // the server's answer wins over a stale list that still shows the code as usable
    expect(r.msg).toBe(await page.evaluate(`t('promoUsedUpMsg')`));
  });

  test('a database without promo_lookup falls back to the loaded list', async ({ page }) => {
    await stubSupabase(page, { sessions, promo_codes: [listed],
      'rpc:promo_lookup': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.promo_lookup' } } });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    expect((await apply(page)).applied).toBe('SUMMER10');
  });
});

test.describe('inventory cost is staff-only', () => {
  test('the inventory is read by named columns, without cost, and customers never ask for costs', async ({ page }) => {
    await stubSupabase(page, { sessions, inventory: [{ id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 5, price: 8, low_threshold: 1 }] });
    await loginCustomer(page);
    const invUrls: string[] = []; let costCalls = 0;
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('/rest/v1/inventory') && r.method() === 'GET') invUrls.push(decodeURIComponent(u));
      if (u.includes('/rpc/staff_inventory_costs')) costCalls++;
    });
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('S.inventory && S.inventory.length === 1');
    expect(invUrls.length).toBeGreaterThan(0);
    for (const u of invUrls) {
      expect(u).toContain('select=id,name,category,qty');
      expect(u).not.toMatch(/select=[^&]*cost/);
    }
    expect(costCalls).toBe(0);
  });

  test('staff get the costs merged in from their own RPC', async ({ page }) => {
    await stubSupabase(page, { sessions, inventory: [{ id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 5, price: 8 }],
      'rpc:staff_inventory_costs': [{ id: 'i1', cost: 3.5 }] });
    await page.goto('/');
    await waitForSb(page);
    const cost = await page.evaluate(`(async () => { S._staffAuthed = true; try { await _optionalFetch(); } finally { S._staffAuthed = false; }
      return (S.inventory.find(i => i.id === 'i1') || {}).cost; })()`);
    expect(cost).toBe(3.5);
  });
});

test('a photo is uploaded without upsert (the bucket grants INSERT only)', async ({ page }) => {
  await stubSupabase(page, { sessions });
  const uploads: { url: string; upsert: string | undefined }[] = [];
  await page.route(/\/storage\/v1\/object\//, async (route) => {
    uploads.push({ url: route.request().url(), upsert: route.request().headers()['x-upsert'] });
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ Key: 'photos/p/x.jpg' }) });
  });
  await page.goto('/');
  await waitForSb(page);
  const out = await page.evaluate(`new Promise(res => { const c = document.createElement('canvas'); c.width = 4; c.height = 4; _photoOut(c, res); })`);
  expect(uploads.length).toBe(1);
  expect(uploads[0].url).toMatch(/\/photos\/p\/[a-z0-9]+\.jpg/);
  expect(uploads[0].upsert).toBe('false');
  expect(String(out)).toContain('/photos/p/');
});

test('Account says the phone is taken when the server refuses it', async ({ page }) => {
  // Save reads the account fresh first (it writes over the account as it is now), so the
  // profile is answered; the refusal comes from the write itself.
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Lina Haddad', email: 'lina@example.com', phone: '+966500000001' }],
    'rpc:customer_update_profile': { __rpcError: { status: 409, code: '23505', message: 'phone_taken' } } });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', email: 'lina@example.com', phone: '+966500000001', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-err')).toBeAttached();
  // The tab reads the profile when it opens and draws itself again with the answer (an untouched form): saved before that
  // answer, the redraw wiped the message under test whenever another request on the tab (the wallet, the Invite friends
  // card) made it land late.
  await page.waitForFunction(`!!(S._profFresh&&S._profFresh.id==='c1')`);
  await page.evaluate(`saveAccount()`);
  await expect(page.locator('#acc-err')).toHaveText(await page.evaluate(`t('errPhoneExists')`) as string);
});
