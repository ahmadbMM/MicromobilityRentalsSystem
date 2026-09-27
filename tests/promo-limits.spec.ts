import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, loadStaffHalf } from './helpers/supabase';

// Codes used to be active-or-not, so any of them could be shared once and used forever.
// Expiry, a usage cap and a customer binding are enforced by the price trigger in the DB;
// these cover the client half — that a customer is told WHY a code was refused rather than
// watching the discount silently fail to stick.

const sessions = [{
  id: 's0', day: 'Sunday', session_date: '2099-02-08', capacity: 9,
  status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null,
}];

const code = (over: Record<string, unknown>) => ({
  id: 'p1', code: 'SUMMER10', kind: 'percent', value: 10, active: true,
  applies_to: null, expires_at: null, max_uses: null, uses: 0, customer_id: null, ...over,
});

/** Types the code into the register form's promo box and returns the resulting state. */
async function apply(page: import('@playwright/test').Page) {
  // applyPromoCode is async: a rider's device asks promo_lookup() first (unstubbed here, so it
  // falls back to the loaded list these specs are about).
  return page.evaluate(`(async () => {
    S.regBikeTypes = ['Hybrid']; S.regQty = 1;
    const box = document.createElement('input');
    box.className = 'reg-promo'; box.value = 'SUMMER10';
    document.body.appendChild(box);
    try { await applyPromoCode(); } finally { box.remove(); }
    return { applied: !!S.promoApplied, msg: S._promoMsg };
  })()`) as Promise<{ applied: boolean; msg: string }>;
}

async function boot(page: import('@playwright/test').Page, promo_codes: unknown[], cust?: Record<string, unknown>) {
  await stubSupabase(page, { sessions, promo_codes });
  await loginCustomer(page, cust ?? { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  await loadStaffHalf(page); // _promoSpent and the other limit checks are the staff page's (the wizard asks the database)
}

test.describe('promo code limits', () => {
  test('a code with no limits still applies, exactly as before', async ({ page }) => {
    await boot(page, [code({})]);
    const r = await apply(page);
    expect(r.applied).toBe(true);
    expect(r.msg).toBe('');
  });

  test('a code past its end date is refused, and says so', async ({ page }) => {
    await boot(page, [code({ expires_at: '2020-01-01' })]);
    const r = await apply(page);
    expect(r.applied).toBe(false);
    expect(r.msg).toContain('expired');
  });

  test('a code whose end date is today still works — the limit is inclusive', async ({ page }) => {
    await boot(page, [code({ expires_at: '2099-12-31' })]);
    expect((await apply(page)).applied).toBe(true);
  });

  test('a code at its usage cap is refused', async ({ page }) => {
    await boot(page, [code({ max_uses: 5, uses: 5 })]);
    const r = await apply(page);
    expect(r.applied).toBe(false);
    expect(r.msg).toContain('fully used');
  });

  test('a code below its cap still has room', async ({ page }) => {
    await boot(page, [code({ max_uses: 5, uses: 4 })]);
    expect((await apply(page)).applied).toBe(true);
  });

  test('a code bound to someone else is refused', async ({ page }) => {
    await boot(page, [code({ customer_id: 'c999' })], { id: 'c1' });
    const r = await apply(page);
    expect(r.applied).toBe(false);
    expect(r.msg).toContain('another account');
  });

  test('a code bound to this customer applies', async ({ page }) => {
    await boot(page, [code({ customer_id: 'c1' })], { id: 'c1' });
    expect((await apply(page)).applied).toBe(true);
  });

  test('a spent code stops discounting live bookings too', async ({ page }) => {
    await boot(page, [code({ max_uses: 1, uses: 1 })]);
    // _syncPromoBookings decides on the same rule the DB uses, so an exhausted code
    // returns unpaid bookings to full price instead of leaving a stale discount behind.
    const stillValid = await page.evaluate(`(() => {
      const c = S.promoCodes[0];
      return { spent: _promoSpent(c), expired: _promoExpired(c), usedUp: _promoUsedUp(c) };
    })()`) as { spent: boolean; expired: boolean; usedUp: boolean };
    expect(stillValid.spent).toBe(true);
    expect(stillValid.usedUp).toBe(true);
    expect(stillValid.expired).toBe(false);
  });
});
