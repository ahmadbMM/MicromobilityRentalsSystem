import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// End-of-day drawer reconciliation. These figures decide whether the cash counted at the
// booth is "right", so the rules they encode are worth pinning down:
//   COLLECTED  every booking marked paid, whatever its status (a rider who paid and then
//              no-showed left their money in the drawer) — but never cancelled/removed.
//   PENDING    unpaid riders who actually rode (active/done only).
//   CARD/CASH  card rows count in full, split rows count their card share, cash is the rest.

const D = '2099-02-08';
const sessions = [{
  id: 's0', day: 'Sunday', session_date: D, capacity: 9,
  status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null,
}];

const qe = (id: string, num: number, name: string, extra: Record<string, unknown>) => ({
  id, session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: num, name,
  phone: `05000000${num}`, customer_id: null, type_preference: 'Any',
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});

// 75 (split: 50 card / 25 cash) + 57.5 (card) + 30 (cash, no-show but paid) = 162.50 collected.
// The cancelled-but-paid 99 must stay out. The unpaid rider who rode owes 30.
const queue_entries = [
  qe('e1', 1, 'Split', { status: 'done', paid: true, price: 75, pay_method: 'split', card_amount: 50 }),
  qe('e2', 2, 'Card', { status: 'done', paid: true, price: 57.5, pay_method: 'card' }),
  qe('e3', 3, 'Paid no-show', { status: 'noshow', paid: true, price: 30, pay_method: 'cash' }),
  qe('e4', 4, 'Unpaid rider', { status: 'done', paid: false, price: 30 }),
  qe('e5', 5, 'Cancelled paid', { status: 'cancelled', paid: true, price: 99, pay_method: 'cash' }),
];

/** Renders the close-out and returns its HTML without opening a print window. */
async function closeoutHtml(page: import('@playwright/test').Page) {
  return page.evaluate(`(() => {
    let cap = '';
    const orig = window.open;
    window.open = () => ({ document: { write: (h) => { cap = h; }, close() {} }, focus() {}, print() {} });
    try { S._ctSession = 's0'; printCloseout(); } finally { window.open = orig; }
    return cap;
  })()`) as Promise<string>;
}

test.describe('close-out reconciliation', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  });

  test('collected counts every paid booking except cancelled, and excludes unpaid riders', async ({ page }) => {
    const html = await closeoutHtml(page);
    expect(html).toContain('162.5'); // 75 + 57.5 + 30
    expect(html).not.toContain('261.5'); // would mean the cancelled-but-paid 99 leaked in
  });

  test('the cancelled-but-paid booking never reaches the drawer total', async ({ page }) => {
    const html = await closeoutHtml(page);
    expect(html).not.toMatch(/SAR\s*99\b/);
  });

  test('pending counts only unpaid riders who actually rode', async ({ page }) => {
    const html = await closeoutHtml(page);
    expect(html).toMatch(/SAR\s*30\b/); // the one unpaid done rider
  });

  test('card and cash split adds back up to the collected total', async ({ page }) => {
    const split = await page.evaluate(`(() => {
      const r2 = (n) => Math.round(n * 100) / 100;
      const paid = getQueue().filter(e => e.paid && e.status !== 'cancelled' && e.status !== 'removed');
      const collected = r2(paid.reduce((s, e) => s + (e.price ?? 0), 0));
      const card = r2(paid.reduce((s, e) => s + (e.pay_method === 'card' ? (e.price ?? 0)
        : e.pay_method === 'split' ? (e.card_amount || 0) : 0), 0));
      return { collected, card, cash: r2(collected - card) };
    })()`) as { collected: number; card: number; cash: number };
    expect(split.collected).toBe(162.5);
    expect(split.card).toBe(107.5); // 57.5 card + 50 card-share of the split
    expect(split.cash).toBe(55); // 25 split remainder + 30 cash
    expect(Math.round((split.card + split.cash) * 100) / 100).toBe(split.collected);
  });
});

// A Victory Lap athlete who pays the race's organiser by bank transfer is marked paid with pay_method
// 'transfer' (customer_vl_ticket, 2026-10-23). That money is the organiser's: it is in no total of ours,
// neither card nor cash, and the close-out and the night's summary show it on a line of its own
// ("Paid by transfer") (2026-10-24).
test.describe('@staff:money a transfer to the organiser is never our money', () => {
  const vqueue = [
    qe('v1', 1, 'Card athlete', { status: 'done', paid: true, price: 150, pay_method: 'card' }),
    qe('v2', 2, 'Transfer athlete', { status: 'waiting', paid: true, price: 150, pay_method: 'transfer' }),
    qe('v3', 3, 'Transfer finisher', { status: 'done', paid: true, price: 150, pay_method: 'transfer' }),
  ];
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: vqueue });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length===3');
  });

  test('revenue, the drawer and the night summary leave it out, and name it apart', async ({ page }) => {
    const got = await page.evaluate(`(() => {
      const q = getQueue().filter((e) => e.sessionId === 's0');
      const m = _eonModel('s0'), take = _tillTake(_tillCtx('s0'));
      return { revenue: _revenueOf(q), card: m.card, cash: m.cash, toOrg: m.toOrg, drawerCash: take.cash, drawerCard: take.card };
    })()`);
    expect(got).toEqual({ revenue: 150, card: 150, cash: 0, toOrg: { n: 2, sum: 300 }, drawerCash: 0, drawerCard: 150 });
    await page.evaluate(`_eonOpen('s0',{})`);
    await expect(page.locator('#eon-modal [role="dialog"]')).toContainText('Paid by transfer');
  });

  test('the close-out prints it on its own line, outside what was collected', async ({ page }) => {
    const html = await closeoutHtml(page);
    expect(html).toContain('Paid by transfer');
    expect(html).toContain('300.00'); // the two transfers, apart
    expect(html).not.toContain('450.00'); // would mean they joined what we collected
  });
});
