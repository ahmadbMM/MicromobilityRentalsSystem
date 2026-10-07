import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Bug hunt 2026-10-07 (cashier, stock room, booking outbox): a double tap that rang a sale up
// twice, a stock change applied again when an item's save was retried, the outbox's own refusal
// count written into a booking row, and a receipt that lost its customer to an MM Team line.

const sessions = [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }];
const booking = {
  id: 'q1', name: 'Counter Test', size: 'M', type_preference: 'Any', paid: false, price: 30,
  session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 4, status: 'active',
  registered_at: '2099-01-09T10:00:00Z', walk_in: false,
};
const inventory = [{ id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 10, price: 12, low_threshold: 1 }];

async function bootStaff(page: Page, extra: Fixtures = {}) {
  await stubSupabase(page, { sessions, queue_entries: [booking], inventory, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.inventory||[]).length>0');
}

test.describe('@staff:cashier bug hunt Oct 7', () => {
  test('a second tap on Ring up while the first sale is being written rings it up once', async ({ page }) => {
    await bootStaff(page);
    await page.evaluate(`(async () => { showCashierModal('q1'); _cashSet('_cashItem','i1'); await Promise.all([_cashAddLine(), _cashAddLine()]); })()`);
    expect(await page.evaluate(`entryPurchases(getQueue().find(e => e.id === 'q1')).length`)).toBe(1);
    expect(await page.evaluate(`S.inventory.find(i => i.id === 'i1').qty`)).toBe(9);
  });

  test('a receipt names its customer even when its first line is an MM Team one', async ({ page }) => {
    await bootStaff(page);
    await page.evaluate(`(() => {
      S.cashSales = [
        { id: 'a1', receipt_id: 'r1', session_id: 's1', customer_name: null, team_name: 'Desk Mate', item_id: null, name: 'Water', category: 'Other', qty: 1, price: 5, pay: 'team', created_at: '2099-01-09T11:00:00Z' },
        { id: 'a2', receipt_id: 'r1', session_id: 's1', customer_name: 'Walk Rider', item_id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 1, price: 12, pay: 'paid', created_at: '2099-01-09T11:00:00Z' },
      ];
      setStaffTab('cashier'); S._ctSession = 's1'; renderCashier();
    })()`);
    await expect(page.locator('#tab-cashier .sl-rc-head').first()).toContainText('Walk Rider');
  });
});

test.describe('@staff:inventory bug hunt Oct 7', () => {
  test('saving an item again after its second write was refused does not move the stock twice', async ({ page }) => {
    await bootStaff(page);
    const qtyPatches: string[] = [];
    page.on('request', (r) => {
      if (/rest\/v1\/inventory/.test(r.url()) && r.method() === 'PATCH' && 'qty' in (r.postDataJSON() || {})) qtyPatches.push(decodeURIComponent(r.url()));
    });
    await page.evaluate(`(async () => {
      setStaffTab('inventory'); startInvEdit('i1'); S._invQty = '12';           // +2 typed into the box
      const real = window._wr; let n = 0;
      window._wr = async (p, ctx) => { if (ctx === 'save item' && ++n === 2) { await p; return true; } return real(p, ctx); };
      try { await saveInvEdit(); } finally { window._wr = real; }               // the +2 lands, the rest is refused
      await saveInvEdit();                                                      // saved again from the same form
    })()`);
    expect(qtyPatches).toHaveLength(1); // the +2 once; the retry used to send it again (12 -> 14)
    expect(await page.evaluate(`S.editInvId`)).toBeNull();
  });
});

test.describe('@customer:reserve bug hunt Oct 7', () => {
  test('a queued booking sent straight to the table carries no outbox bookkeeping', async ({ page }) => {
    await stubSupabase(page, { sessions: [{ ...sessions[0], id: '2099-07-07', session_date: '2099-07-07', day: 'Sunday' }], queue_entries: [], bikes: [] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S.dataLoaded===true`);
    const bodies: string[] = [];
    page.on('request', (r) => { if (/rest\/v1\/queue_entries/.test(r.url()) && r.method() === 'POST') bodies.push(r.postData() || ''); });
    // Booked on this phone by another account (not the one signed in now), refused once before.
    await page.evaluate((o) => localStorage.setItem('cq_book_outbox', o), JSON.stringify([{
      id: 'ob1', session_id: '2099-07-07', session_day: 'Sunday', session_date: '2099-07-07', queue_num: 5, name: 'Offline Rider',
      phone: '0550000001', type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, customer_id: 'c-other',
      registered_at: new Date(Date.now() - 60000).toISOString(), _tries: 1,
    }]));
    await page.evaluate(`_bookOutboxFlush()`);
    await expect.poll(() => bodies.length).toBeGreaterThan(0);
    expect(bodies.join('\n')).not.toContain('_tries'); // no such column: the insert was refused for it alone
    expect(bodies.join('\n')).toContain('ob1');
  });
});
