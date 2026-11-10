import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The Blood Donation free ride as a code the rider keeps (the owner, 2026-11-06): it stays on the event picker until used
// or past its date, the bike step offers it as a Redeem box once rider 1 has a bike, and it pays for the owner's own ride
// only (one use, never Carbon). The database refuses it on anyone else's account (promo_lookup not_yours, the price trigger).

const jcc = { id: 's0', day: 'Sunday', session_date: '2099-02-08', capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null };
const sat = { id: 's1', day: 'Saturday', session_date: '2099-02-07', capacity: 9, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', location: 'JCC' };
const OPEN = { entry_id: 'q1', code: 'BD-1A2B3C4D', expires_at: '2099-12-05', used: false };
const ok = { ok: true, code: 'BD-1A2B3C4D', kind: 'percent', value: 100, applies_to: null };

async function boot(page: Page, rewards: unknown[], x: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [jcc, sat], 'rpc:customer_blood_rewards': rewards, 'rpc:promo_lookup': ok, ...x });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('showView("landing");renderLandingAvail()');
}
const step2 = (page: Page, qty: number, types: string[]) =>
  page.evaluate(`showView('customer');setCustTab('register');S.selEvent='jcc';S.selSession='s0';S.regStep=2;S.regQty=${qty};S.regBikeTypes=${JSON.stringify(types)};renderRegister()`);

test.describe('Blood Donation free ride code', () => {
  test('the event picker keeps an open code in view, and not a used or past one', async ({ page }) => {
    await boot(page, [OPEN, { entry_id: 'q2', code: 'BD-USED0001', expires_at: '2099-12-05', used: true }, { entry_id: 'q3', code: 'BD-OLD00001', expires_at: '2020-01-01', used: false }]);
    const card = page.locator('#land-free-rides .fr-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('BD-1A2B3C4D');
    await expect(card).toContainText('Only you can use it');
    await card.locator('.fr-go').click();
    await expect.poll(() => page.evaluate('S.selEvent')).toBe('jcc');
  });

  test('no code, no card', async ({ page }) => {
    await boot(page, []);
    await expect(page.locator('#land-events .landing-events-grid')).toBeVisible();
    await expect(page.locator('.fr-card')).toHaveCount(0);
  });

  test('the bike step offers Redeem once rider 1 has a bike, and it pays for rider 1 alone', async ({ page }) => {
    await boot(page, [OPEN]);
    await expect.poll(() => page.evaluate('(S._bldR||[]).length')).toBe(1);
    await step2(page, 2, []);
    await expect(page.locator('#bld-redeem')).toBeAttached();
    await expect(page.locator('#bld-redeem .fr-card')).toHaveCount(0);
    await page.evaluate(`setBikeType(0,'Hybrid');setBikeType(1,'Hybrid')`);
    const box = page.locator('#bld-redeem .fr-card');
    await expect(box).toContainText('BD-1A2B3C4D');
    await box.locator('.fr-go').click();
    await expect.poll(() => page.evaluate('S.promoApplied&&S.promoApplied.one')).toBe(true);
    await expect(page.locator('#bld-redeem .fr-card')).toHaveCount(0); // the promo box now holds the code, with Remove
    const r = await page.evaluate(`(()=>{const fare=priceForType('Hybrid');const es=[{price:fare,typePreference:'Hybrid'},{price:fare,typePreference:'Hybrid'}];
      _applyPromoToEntries(es);return{fare,disc:_regPromoDisc(),prices:es.map(e=>e.price),codes:es.map(e=>e.promoCode||null)};})()`) as { fare: number; disc: number; prices: number[]; codes: (string | null)[] };
    expect(r.fare).toBeGreaterThan(0);
    expect(r.disc).toBe(r.fare);
    expect(r.prices).toEqual([0, r.fare]);
    expect(r.codes).toEqual(['BD-1A2B3C4D', null]);
  });

  test('rider 1 on Carbon: the box says why, with nothing to tap', async ({ page }) => {
    await boot(page, [OPEN]);
    await expect.poll(() => page.evaluate('(S._bldR||[]).length')).toBe(1);
    await step2(page, 1, ['Road Carbon']);
    const box = page.locator('#bld-redeem .fr-card');
    await expect(box).toContainText('Carbon');
    await expect(box.locator('.fr-go')).toHaveCount(0);
  });

  // the user, 2026-11-10: a ride free anyway never spends the code (the database gives it back, 20261110235950)
  test('not offered when rider 1 brings an own bike', async ({ page }) => {
    await boot(page, [OPEN]);
    await expect.poll(() => page.evaluate('(S._bldR||[]).length')).toBe(1);
    await step2(page, 1, ['Own']);
    await expect(page.locator('#bld-redeem')).toBeAttached();
    await expect(page.locator('#bld-redeem .fr-card')).toHaveCount(0);
    await page.evaluate(`setBikeType(0,'Hybrid')`);
    await expect(page.locator('#bld-redeem .fr-card')).toContainText('BD-1A2B3C4D');
  });

  test('not offered when rider 1 rides on the house', async ({ page }) => {
    await stubSupabase(page, { sessions: [jcc, sat], 'rpc:customer_blood_rewards': [OPEN], 'rpc:promo_lookup': ok });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05', default_pay: 'house' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('showView("landing");renderLandingAvail()');
    await expect.poll(() => page.evaluate('(S._bldR||[]).length')).toBe(1);
    await expect(page.locator('#land-free-rides .fr-card')).toContainText('BD-1A2B3C4D'); // still theirs to keep
    await step2(page, 1, ['Hybrid']);
    await expect(page.locator('#bld-redeem')).toBeAttached();
    await expect(page.locator('#bld-redeem .fr-card')).toHaveCount(0);
  });

  test('not offered on a ride the code does not pay for', async ({ page }) => {
    await boot(page, [OPEN]);
    expect(await page.evaluate(`[_bldCodeSessOk(_sessDisp('s0')),_bldCodeSessOk(_sessDisp('s1'))]`)).toEqual([true, false]);
  });

  test("someone else's code is refused by the server's answer", async ({ page }) => {
    await boot(page, [], { 'rpc:promo_lookup': { ok: false, reason: 'not_yours' } });
    await step2(page, 1, ['Hybrid']);
    await page.evaluate('S._promoOpen=true;renderRegister()'); // the field opens from its link (row 10)
    await page.locator('#reg-promo-step2').fill('BD-1A2B3C4D');
    await page.locator('#reg-promo-btn-step2').click();
    await expect.poll(() => page.evaluate('S._promoMsg')).toContain('another account');
    expect(await page.evaluate('S.promoApplied')).toBeNull();
  });
});

// A volunteer's free ride for an event worked (VL-, migration 20261109120000): customer_blood_rewards lists it beside the blood
// codes (entry 'vl-<session>'), on the same rules; the cards say it is the volunteer's, with the Volunteer badge's raised hand.
test.describe('@customer:reserve the volunteer free ride code', () => {
  const VL = { entry_id: 'vl-2026-11-05-bd', code: 'VL-7F3A92C1', expires_at: '2099-12-05', used: false };
  const vlOk = { 'rpc:promo_lookup': { ok: true, code: 'VL-7F3A92C1', kind: 'percent', value: 100, applies_to: null } };

  test('the event picker says it is the volunteer free ride, with its mark; Redeem pays for rider 1 alone', async ({ page }) => {
    await boot(page, [VL], vlOk);
    const card = page.locator('#land-free-rides .fr-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.fr-t')).toHaveText('Your volunteer free ride');
    await expect(card.locator('.fr-t .code-k-vl svg.code-ic')).toHaveCount(1);
    await expect(card).toContainText('VL-7F3A92C1');
    await expect.poll(() => page.evaluate('(S._bldR||[]).length')).toBe(1);
    await step2(page, 2, ['Hybrid', 'Hybrid']);
    const box = page.locator('#bld-redeem .fr-card');
    await expect(box.locator('.fr-t')).toHaveText('You have a volunteer free ride');
    await box.locator('.fr-go').click();
    await expect.poll(() => page.evaluate('S.promoApplied&&S.promoApplied.one')).toBe(true);
    await expect(page.locator('.cu-promo-disc .code-k-vl, .cu-promo-disc .code-ic').first()).toBeAttached();
    expect(await page.evaluate(`[_codeKindOf('VL-7F3A92C1'),_codeOne('vl-7f3a92c1'),_codeKindOf('BD-1A2B3C4D'),_frVl({entry_id:'q1',code:'BD-1A2B3C4D'})]`)).toEqual(['vl', true, 'bd', false]);
  });

  test('the blood codes\' rules: Carbon says why, a Saturday ride does not offer it', async ({ page }) => {
    await boot(page, [VL], vlOk);
    await expect.poll(() => page.evaluate('(S._bldR||[]).length')).toBe(1);
    await step2(page, 1, ['Road Carbon']);
    const box = page.locator('#bld-redeem .fr-card');
    await expect(box.locator('.fr-t')).toHaveText('You have a volunteer free ride');
    await expect(box).toContainText('Carbon');
    await expect(box.locator('.fr-go')).toHaveCount(0);
    await page.evaluate('S._promoOpen=true;renderRegister()'); // the field opens from its link (row 10)
    await page.locator('#reg-promo-step2').fill('VL-7F3A92C1');
    await page.locator('#reg-promo-btn-step2').click();
    await expect.poll(() => page.evaluate('S._promoMsg')).toContain('Carbon');
    // the session rule is the blood codes' (_bldCodeSessOk): a JCC ride takes it, the Saturday ride does not
    expect(await page.evaluate(`[_bldOpenCodes().filter(y=>!y.ref&&_bldCodeSessOk(_sessDisp('s0'))).length,_bldOpenCodes().filter(y=>!y.ref&&_bldCodeSessOk(_sessDisp('s1'))).length]`)).toEqual([1, 0]);
  });
});
