import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type FailWrite, type Fixtures } from './helpers/supabase';

// Cashier and stock-room regressions from the September review: what the till shows is what it
// books, a sale on a booking is never reported when it was not saved, a receipt edit cannot drive
// a receipt negative, queued sales land in the order they were made, and stock moves as deltas.

const sessions = [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }];
const booking = {
  id: 'q1', name: 'Counter Test', size: 'M', type_preference: 'Any', paid: false, price: 30,
  session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 4, status: 'active',
  registered_at: '2099-01-09T10:00:00Z', walk_in: false,
};
const inventory = [
  { id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 10, price: 12, low_threshold: 1 },
  { id: 'i2', name: 'Loose Strap', category: 'Accessory', qty: 4, price: null, low_threshold: 0 },
  { id: 'neg', name: 'Oversold Bar', category: 'ProteinBars', qty: -2, price: 9, low_threshold: 0 },
];

async function boot(page: Page, extra: Fixtures = {}, fail?: FailWrite) {
  await stubSupabase(page, { sessions, queue_entries: [booking], inventory, ...extra }, fail);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.inventory||[]).length>0');
}

test.describe('cashier tab', () => {
  test('the total and card figure on screen after a redraw are the ones the receipt books', async ({ page }) => {
    await boot(page);
    // 100 paid + 100 MM Team, 10% off, all of it on card. The discount is sized from the
    // chargeable 100, so the customer pays 90 on card. A redraw used to size it from the whole
    // 200 and show card 80.
    await page.evaluate(`(() => {
      setStaffTab('cashier'); S._ctSession = 's1';
      S._ctCart = [
        { item_id: null, name: 'Jersey', cat: 'Apparel', qty: 1, price: 100, pay: 'paid', team: '' },
        { item_id: null, name: 'Team jersey', cat: 'Apparel', qty: 1, price: 100, pay: 'team', team: 'Rakan' },
      ];
      S._ctDisc = '10'; S._ctDiscPct = true; S._ctCard = '100'; S._ctCardPct = true;
      renderCashier();
    })()`);
    await expect(page.locator('#ct-grand')).toHaveText('SAR 190');
    await expect(page.locator('#ct-split')).toContainText('SAR 90');
    const booked = await page.evaluate(`(() => {
      const rows = []; const orig = window._salesApply;
      window._salesApply = (r) => { rows.push(...r); return false; };
      try { _ctRecord(); } finally { window._salesApply = orig; }
      return { card: (rows.find((r) => r.category === '__cardmeta__') || {}).price,
        total: rows.filter((r) => r.category !== '__cardmeta__').reduce((s, r) => s + r.qty * r.price, 0) };
    })()`) as { card: number; total: number };
    expect(booked).toEqual({ card: 90, total: 190 });
  });

  test('a recorded receipt does not carry its customer or linked account into the next sale', async ({ page }) => {
    await boot(page, { customers: [{ id: 'c1', name: 'First Rider', phone: '+966551111111', created_at: '2026-01-01T00:00:00Z' }] });
    await page.evaluate(`(() => {
      setStaffTab('cashier'); S._ctSession = 's1'; S._ctCust = 'First Rider'; S._ctCustId = 'c1';
      S._ctCart = [{ item_id: 'i1', name: 'Gel', cat: 'EnergyGels', qty: 1, price: 12, pay: 'paid', team: '' }];
    })()`);
    await page.evaluate('_ctRecord()');
    expect(await page.evaluate('[S._ctCust, S._ctCustId, (S.cashSales||[]).filter(r=>r.customer_id==="c1").length]')).toEqual(['', '', 1]);
  });

  test('a receipt the device cannot store is not half-recorded', async ({ page }) => {
    await boot(page);
    const left = await page.evaluate(`(() => {
      S._ctSession = 's1';
      S._ctCart = [
        { item_id: 'i1', name: 'Gel', cat: 'EnergyGels', qty: 1, price: 12, pay: 'paid', team: '' },
        { item_id: null, name: 'Cap', cat: 'Apparel', qty: 1, price: 30, pay: 'paid', team: '' },
      ];
      const orig = window._outboxSave; window._outboxSave = () => false; // storage full
      try { _ctRecord(); } finally { window._outboxSave = orig; }
      return { sales: (S.cashSales || []).length, cart: S._ctCart.length, outbox: _outboxCount() };
    })()`);
    expect(left).toEqual({ sales: 0, cart: 2, outbox: 0 });
  });

  test('the amount follows the latest choice: on the house keeps the price, a priceless item clears it', async ({ page }) => {
    await boot(page);
    const amts = await page.evaluate(`(() => {
      setStaffTab('cashier');
      _ctSet('_ctItem', 'i1'); const a = S._ctAmt;
      _ctSet('_ctPay', 'house'); const b = S._ctAmt;
      _ctSet('_ctPay', 'paid'); const c = S._ctAmt;
      _ctSet('_ctItem', 'i2'); const d = S._ctAmt;
      return [a, b, c, d];
    })()`);
    // On the house keeps the list price since 2026-10-05 (the line takes nothing: _lineCharge; the reports
    // say what was given away). Before that: 12, 0, 12, and earlier still 12, 0, 0 (a paid sale for nothing).
    expect(amts).toEqual(['12', '12', '12', '']);
  });

  test('voiding a receipt asks first, then deletes it and writes it to the action log', async ({ page }) => {
    await boot(page);
    await page.evaluate(`(() => {
      setStaffTab('cashier'); S._ctSession = 's1';
      S.cashSales = [{ id: 'cs1', receipt_id: 'r1', session_id: 's1', customer_name: 'Walk Up', item_id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 2, price: 12, pay: 'paid', created_at: '2099-01-09T11:00:00Z' }];
      _ctVoidReceipt('r1');
    })()`);
    await expect(page.locator('#confirm-modal .confirm-box')).toContainText('SAR 24');
    expect(await page.evaluate('S.cashSales.length')).toBe(1); // nothing happens before the answer
    await page.locator('#confirm-modal .btn-red').click();
    await expect.poll(() => page.evaluate('S.cashSales.length')).toBe(0);
    // The stock count moves on screen before its write goes out, and the void is logged once
    // that write has come back, so the log is waited for on its own, not read after the count.
    await expect.poll(() => page.evaluate('S.inventory.find(i=>i.id==="i1").qty')).toBe(12);
    await expect.poll(() => page.evaluate('S.fullLog.some(l=>/SAR 24/.test(l.label)&&l.label.includes(t("cashVoid")))')).toBe(true);
  });

  test('refund, mark-paid and edit of a receipt are written to the action log', async ({ page }) => {
    await boot(page);
    await page.evaluate(`(() => {
      S._ctSession = 's1';
      S.cashSales = [
        { id: 'p1', receipt_id: 'rp', session_id: 's1', name: 'Gel', category: 'EnergyGels', qty: 1, price: 12, pay: 'pending', created_at: '2099-01-09T11:00:00Z' },
        { id: 'e1', receipt_id: 're', session_id: 's1', name: 'Cap', category: 'Apparel', qty: 1, price: 30, pay: 'paid', created_at: '2099-01-09T11:00:00Z' },
      ];
      _ctMarkReceiptPaid('rp');
      showReceiptEdit('re'); S._reEdit[0].price = '25';
    })()`);
    await page.evaluate('saveReceiptEdit()'); // a lower price asks the operator's PIN first (none here), 2026-10-05
    await page.evaluate(`_ctRefundReceipt('rp')`);
    await page.locator('#confirm-modal .btn-muted').click();
    await expect.poll(() => page.evaluate('S.cashSales.find(r=>r.id==="p1").pay')).toBe('refunded');
    // As with a void, the refund is logged after its restock write, a moment after the row turns.
    await expect.poll(() => page.evaluate('S.fullLog.some(l=>l.label.includes(t("cashRefund")))')).toBe(true);
    const [labels, markPaid, refund, edit] = await page.evaluate(`[S.fullLog.map(l=>l.label), t('cashMarkPaid'), t('cashRefund'), t('receiptEditTitle')]`) as [string[], string, string, string];
    expect(labels.some((l) => l.includes(markPaid) && l.includes('SAR 12'))).toBe(true);
    expect(labels.some((l) => l.includes(refund) && l.includes('SAR 12'))).toBe(true);
    expect(labels.some((l) => l.includes(edit) && l.includes('30 → 25'))).toBe(true);
  });

  test('making a discounted line free re-books the discount instead of driving the receipt negative', async ({ page }) => {
    await boot(page);
    const after = await page.evaluate(`(async () => {
      S._ctSession = 's1';
      S.cashSales = [
        { id: 'g1', receipt_id: 'r1', session_id: 's1', name: 'Gel', item_id: 'i1', category: 'EnergyGels', qty: 1, price: 50, pay: 'paid', created_at: '2099-01-09T11:00:00Z' },
        { id: 'g2', receipt_id: 'r1', session_id: 's1', name: 'Cap', item_id: null, category: 'Apparel', qty: 1, price: 20, pay: 'paid', created_at: '2099-01-09T11:00:00Z' },
        { id: 'd1', receipt_id: 'r1', session_id: 's1', name: 'Discount', item_id: null, category: '__discount__', qty: 1, price: -30, pay: 'paid', created_at: '2099-01-09T11:00:00Z' },
      ];
      showReceiptEdit('r1');
      S._reEdit.find(l => l.id === 'g1').pay = 'house';
      await saveReceiptEdit(); // On the house asks the operator's PIN first (none here), 2026-10-05
      const rows = S.cashSales.filter(r => r.receipt_id === 'r1');
      return { total: _rcTotal(rows), collected: _salesTotals(_cashSessionLines('s1')).collected, disc: rows.filter(r => r.category === '__discount__').map(r => r.price) };
    })()`);
    // 30 off could only ever come off what is still charged: the 20 cap. Was -10 on the receipt and in Collected.
    expect(after).toEqual({ total: 0, collected: 0, disc: [-20] });
  });

  test('an emptied amount box in the receipt editor is refused, not saved as free', async ({ page }) => {
    await boot(page);
    const price = await page.evaluate(`(() => {
      S.cashSales = [{ id: 'g1', receipt_id: 'r1', session_id: 's1', name: 'Gel', category: 'EnergyGels', qty: 1, price: 50, pay: 'paid', created_at: '2099-01-09T11:00:00Z' }];
      showReceiptEdit('r1'); S._reEdit[0].price = ''; saveReceiptEdit();
      return S.cashSales[0].price;
    })()`);
    expect(price).toBe(50);
  });
});

test.describe('sales outbox order', () => {
  test('a later op for a sale replaces the one still waiting, so a refund cannot be replayed under "paid"', async ({ page }) => {
    await boot(page, {}, { table: 'cashier_sales' }); // the server refuses every sale write
    const ops = await page.evaluate(`(async () => {
      _salesApply([{ id: 'x1', session_id: 's1', name: 'Gel', category: 'EnergyGels', qty: 1, price: 12, pay: 'paid' }], []);
      _salesApply([{ id: 'x1', session_id: 's1', name: 'Gel', category: 'EnergyGels', qty: 1, price: 12, pay: 'refunded' }], []);
      await _outboxFlush();
      return _outbox().map(o => o.kind + ':' + (o.data ? o.data.pay : ''));
    })()`);
    expect(ops).toEqual(['upsert:refunded']);
  });

  test('when an older op for a sale fails, a newer one for the same sale waits behind it', async ({ page }) => {
    // An outbox written before ops were merged: an upsert and then the void of the same sale.
    await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('cq_sales_outbox', JSON.stringify([
      { oid: 'o1', kind: 'upsert', id: 'x1', data: { id: 'x1', session_id: 's1', name: 'Gel', qty: 1, price: 12, pay: 'paid' } },
      { oid: 'o2', kind: 'delete', id: 'x1', data: null },
    ])); } });
    await stubSupabase(page, { sessions, queue_entries: [booking], inventory });
    const sent: string[] = [];
    let refuse = true;
    await page.route(/\/rest\/v1\/cashier_sales/, async (route) => {
      const m = route.request().method();
      if (m === 'GET') return route.fallback();
      sent.push(m);
      if (m === 'POST' && refuse) {
        refuse = false; // one dropped upsert
        return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'busy' }) });
      }
      return route.fallback();
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await expect.poll(async () => { await page.evaluate('_outboxFlush()'); return page.evaluate('_outboxCount()'); }).toBe(0);
    // The first upsert was dropped, so the void behind it waited for the retry. Sent straight
    // away (POST, DELETE, POST), the retried upsert landed last and brought the voided sale back.
    expect(sent).toEqual(['POST', 'POST', 'DELETE']);
  });
});

test.describe('sales on a booking', () => {
  test('a sale the server refuses is not shown as added and takes nothing off the shelf', async ({ page }) => {
    await boot(page, {}, { table: 'queue_entries', methods: ['PATCH'] });
    await page.evaluate(`(async () => { showCashierModal('q1'); _cashSet('_cashItem','i1'); await _cashAddLine(); })()`);
    expect(await page.evaluate(`entryPurchases(getQueue().find(e => e.id === 'q1')).length`)).toBe(0);
    expect(await page.evaluate(`S.inventory.find(i => i.id === 'i1').qty`)).toBe(10);
    await expect(page.locator('#err-bar-el')).toBeVisible();
  });

  test('a void the server refuses leaves the sale on the booking and the stock where it was', async ({ page }) => {
    const withSale = { ...booking, purchases: JSON.stringify([{ id: 'i1', name: 'Gel', cat: 'EnergyGels', qty: 2, price: 12, pay: 'paid', at: '2099-01-09T11:00:00Z' }]) };
    await stubSupabase(page, { sessions, queue_entries: [withSale], inventory }, { table: 'queue_entries', methods: ['PATCH'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`showCashierModal('q1'); _cashVoid(0);`);
    await page.locator('#confirm-modal .btn-red').click();
    await expect(page.locator('#err-bar-el')).toBeVisible();
    expect(await page.evaluate(`entryPurchases(getQueue().find(e => e.id === 'q1')).length`)).toBe(1);
    expect(await page.evaluate(`S.inventory.find(i => i.id === 'i1').qty`)).toBe(10);
  });
});

test.describe('stock room', () => {
  const patches = (page: Page) => {
    const out: { url: string; body: Record<string, unknown> }[] = [];
    page.on('request', (r) => { if (/rest\/v1\/inventory/.test(r.url()) && r.method() === 'PATCH') out.push({ url: decodeURIComponent(r.url()), body: r.postDataJSON() }); });
    return out;
  };

  test('+ moves the row by a delta the row must still match, not by a number this screen last loaded', async ({ page }) => {
    await boot(page);
    const sent = patches(page);
    await page.evaluate(`adjInv('i1', 1)`);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].url).toContain('qty=eq.10'); // conditional on the row still holding 10
    expect(sent[0].body.qty).toBe(11);
  });

  test('- on an oversold item does nothing (it used to jump to 0 and log "+2")', async ({ page }) => {
    await boot(page);
    const sent = patches(page);
    await page.evaluate(`adjInv('neg', -1)`);
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(0);
    expect(await page.evaluate(`S.inventory.find(i => i.id === 'neg').qty`)).toBe(-2);
  });

  test('saving an item edit leaves the stock alone unless the box was changed, and then moves it by the change', async ({ page }) => {
    await boot(page);
    const sent = patches(page);
    await page.evaluate(`(async () => { setStaffTab('inventory'); startInvEdit('i1'); S._invPrice = '15'; await saveInvEdit(); })()`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent.some((p) => 'qty' in p.body)).toBe(false); // a price fix used to write the form's 10 back over any sale since

    sent.length = 0;
    await page.evaluate(`(async () => {
      startInvEdit('i1'); S._invQty = '12';                               // +2 typed into the box
      S.inventory.find(i => i.id === 'i1').qty = 8;                        // two sold on another till meanwhile
      await saveInvEdit();
    })()`);
    const q = sent.find((p) => 'qty' in p.body)!;
    expect(q.url).toContain('qty=eq.8');
    expect(q.body.qty).toBe(10); // 8 + 2, not 12
  });

  test('the delete question shows the item name as text', async ({ page }) => {
    await boot(page, { inventory: [{ id: 'h1', name: '<b>Bold</b> Bottle', category: 'Accessory', qty: 1, price: 5, low_threshold: 0 }] });
    await page.evaluate(`delInvItem('h1')`);
    await expect(page.locator('#confirm-modal .confirm-box')).toContainText('<b>Bold</b> Bottle');
  });

  test('the sort menu is labelled with a key that exists', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.invSection = 'supplements'; setStaffTab('inventory'); renderInventory();`);
    await expect(page.locator('#tab-inventory select.filter-select').first()).toHaveAttribute('aria-label', 'Sort by'); // the Filter panel's own dropdowns follow it
  });
});

test.describe('MM Team roster', () => {
  test('adding a name here never deletes names another desk added', async ({ page }) => {
    await boot(page, { team_members: [{ name: 'Rakan' }] });
    const writes: string[] = [];
    page.on('request', (r) => { if (/rest\/v1\/team_members/.test(r.url()) && r.method() !== 'GET') writes.push(r.method() + ' ' + decodeURIComponent(r.url())); });
    await page.evaluate(`S.teamMembers = ['Rakan']; _teamRosterAdd('Omar');`); // 'Huda' was added on another desk since
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatch(/^POST/);
    await page.waitForTimeout(300);
    expect(writes.some((w) => w.startsWith('DELETE'))).toBe(false);

    writes.length = 0;
    await page.evaluate(`showTeamManager(); S._teamDraft = ['Omar']; saveTeamManager();`); // Rakan removed here
    await expect.poll(() => writes.some((w) => w.startsWith('DELETE'))).toBe(true);
    const del = writes.find((w) => w.startsWith('DELETE'))!;
    expect(del).toContain('Rakan');
    expect(del).not.toContain('Huda');
  });
});
