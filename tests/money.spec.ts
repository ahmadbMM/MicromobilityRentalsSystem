import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, staffReady } from './helpers/supabase';

// Phase-0 money paths: the flows where a silent regression costs real money.
// All Supabase traffic is stubbed (see helpers/supabase.ts) — no production data.

const openSession = {
  id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12,
  status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null,
};

test.describe('booking flow', () => {
  test('select session → rider details → confirm → ticket shown', async ({ page }) => {
    await stubSupabase(page, { sessions: [openSession] });
    // A remembered login boots onto the PICK YOUR EVENT page; entering the JCC
    // event card opens the Reserve tab (booking requires an account anyway).
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.locator('#land-events .landing-event-card.ev-jcc').click();

    // Step 1 — pick the open session (the click auto-waits for the card to render)
    await page.locator('.sess-card').first().click();
    await page.locator('button', { hasText: 'Continue' }).first().click();

    // Step 2 — rider details (height drives size, type is required)
    await page.fill('#reg-height-0', '175');
    await page.locator('[data-type-slot="0"][data-type="Hybrid"]').click();
    await page.locator('button', { hasText: 'Review booking' }).click();

    // Step 3 — the review: the waiver, one tap on behalf of the whole booking (Confirm is off without it),
    // then confirm; the stub echoes the insert back as success
    await page.locator('#reg-waiver-cb').check();
    await page.locator('button', { hasText: 'Confirm booking' }).click();

    const panel = page.locator('#tab-register');
    await expect(panel).toContainText('Spec Rider');
    await expect(panel).toContainText('#1'); // first queue number of the session
    const ticketCount = await page.evaluate(`S.lastTickets.length`);
    expect(ticketCount).toBe(1);
  });
});

test.describe('point of sale', () => {
  const fixtures = {
    sessions: [openSession],
    queue_entries: [{
      id: 'q1', name: 'Counter Test', size: 'M', type_preference: 'Any', paid: false,
      price: 30, session_id: 's1', session_day: 'Friday', session_date: '2099-01-09',
      queue_num: 4, status: 'active', registered_at: '2099-01-09T10:00:00Z', walk_in: false,
    }],
    inventory: [{ id: 'i1', name: 'Vitamin Water', category: 'Drinks', qty: 5, price: 10, low_threshold: 1, flavour: 'Berry' }],
  };

  test.beforeEach(async ({ page }) => {
    await stubSupabase(page, fixtures);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await staffReady(page);
    await page.waitForFunction('S.inventory && S.inventory.length > 0');
  });

  test('rental purchase decrements stock and voiding it restores stock', async ({ page }) => {
    await page.evaluate(`showCashierModal('q1'); _cashSet('_cashItem','i1'); _cashSet('_cashQty','2');`);
    await page.evaluate(`_cashAddLine()`);

    expect(await page.evaluate(`S.inventory.find(i => i.id === 'i1').qty`)).toBe(3);
    const line = await page.evaluate(`entryPurchases(getQueue().find(e => e.id === 'q1'))[0]`);
    expect(line).toMatchObject({ id: 'i1', name: 'Vitamin Water', qty: 2, price: 10, pay: 'paid' });

    await page.evaluate(`_cashVoid(0)`);
    await page.locator('#confirm-modal .btn-red').click(); // voiding deletes the sale, so it asks first
    await expect.poll(() => page.evaluate(`S.inventory.find(i => i.id === 'i1').qty`)).toBe(5);
    expect(await page.evaluate(`entryPurchases(getQueue().find(e => e.id === 'q1')).length`)).toBe(0);
  });

  test('refunding a receipt flips its lines to refunded and restocks the items', async ({ page }) => {
    await page.evaluate(`
      S.cashSales = [{ id: 'cs1', receipt_id: 'r1', session_id: 's1', name: 'Vitamin Water',
        item_id: 'i1', category: 'Drinks', qty: 2, price: 10, pay: 'paid', created_at: '2099-01-09T11:00:00Z' }];
      _ctRefundReceipt('r1');0
    `);
    // the refund asks why first (a reason is required since 2026-10-09)
    await page.locator('#mny-modal .mny-chip').first().click();
    await page.locator('#mny-mr-go').click();

    await expect.poll(() => page.evaluate(`S.cashSales[0].pay`)).toBe('refunded');
    expect(await page.evaluate(`S.inventory.find(i => i.id === 'i1').qty`)).toBe(7); // 5 + 2 restocked
  });
});

test.describe('close-out totals (pure logic)', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await staffReady(page);
  });

  test('_salesTotals: collected/pending/free/team, refunds reversed, discounts reduce', async ({ page }) => {
    const totals = await page.evaluate(`_salesTotals([
      { name: 'A',    cat: 'Drinks',       qty: 2, price: 10, pay: 'paid' },
      { name: 'B',    cat: 'Drinks',       qty: 1, price: 15, pay: 'pending' },
      { name: 'C',    cat: 'Helmet',       qty: 1, price: 5,  pay: 'house' },
      { name: 'D',    cat: 'Helmet',       qty: 1, price: 8,  pay: 'team' },
      { name: 'E',    cat: 'Drinks',       qty: 1, price: 12, pay: 'refunded' },
      { name: 'Disc', cat: '__discount__', qty: 1, price: -3, pay: 'paid' },
      { name: 'meta', cat: '__cardmeta__', qty: 0, price: 20, pay: 'paid' },
    ])`);
    expect(totals).toMatchObject({
      units: 5, value: 45, collected: 17, pending: 15,
      free: 5, team: 8, refunded: 12, discount: 3,
    });
  });

  test('_cashCardCash: card/cash split honours card metadata and skips refunds', async ({ page }) => {
    const split = await page.evaluate(`(() => {
      S.cashSales = [
        { id: 'x1', receipt_id: 'rA', session_id: 's9', qty: 1, price: 30, pay: 'paid',     category: 'Drinks',       name: 'A' },
        { id: 'x2', receipt_id: 'rA', session_id: 's9', qty: 0, price: 20, pay: 'paid',     category: '__cardmeta__', name: 'card' },
        { id: 'x3', receipt_id: 'rB', session_id: 's9', qty: 1, price: 15, pay: 'paid',     category: 'Drinks',       name: 'B' },
        { id: 'x4', receipt_id: 'rC', session_id: 's9', qty: 1, price: 50, pay: 'refunded', category: 'Drinks',       name: 'C' },
      ];
      return _cashCardCash('s9');
    })()`);
    expect(split).toEqual({ card: 20, cash: 25 });
  });
});
