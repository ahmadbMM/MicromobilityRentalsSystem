import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The printed session report is what the booth reconciles against, so the money on it has
// to follow the same rules as the close-out:
//   COLLECTED  every paid row except cancelled/removed — a paid no-show left cash behind.
//   CARD/CASH  card rows in full, split rows their card share, cash the remainder.
// The filters the report builder exposes must narrow the ROWS without ever moving those
// totals, which are computed from the session, not from the filtered list.

const D = '2099-02-08';
const sessions = [{
  id: 's0', day: 'Sunday', session_date: D, capacity: 12,
  status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null,
}];

const qe = (id: string, num: number, name: string, extra: Record<string, unknown>) => ({
  id, session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: num, name,
  phone: `05000000${num}`, customer_id: null, type_preference: 'Hybrid',
  registered_at: '2099-01-01T10:00:00Z', status: 'done', ...extra,
});

// 80 (split: 55 card / 25 cash) + 40 (card) + 30 (cash, no-show but paid) = 150 collected.
const queue_entries = [
  qe('e1', 1, 'Split Rider', { paid: true, price: 80, pay_method: 'split', card_amount: 55 }),
  qe('e2', 2, 'Card Rider', { paid: true, price: 40, pay_method: 'card', type_preference: 'Road' }),
  qe('e3', 3, 'Paid No-show', { status: 'noshow', paid: true, price: 30, pay_method: 'cash' }),
  qe('e4', 4, 'Unpaid Rider', { paid: false, price: 30 }),
  qe('e5', 5, 'Cancelled Paid', { status: 'cancelled', paid: true, price: 99, pay_method: 'cash' }),
];

/** Renders the session report without opening a print window. */
async function reportHtml(page: import('@playwright/test').Page, opts?: Record<string, unknown>) {
  return page.evaluate(`(() => {
    let cap = '';
    const orig = window.open;
    S._rxTap=(h)=>{cap = h;return true;};
    try {
      S.sfSession = 's0';
      // _repOpts() memoises into S._repOpts, so set the live object rather than storage.
      S._repOpts = Object.assign(_repDefaults(), ${opts ? JSON.stringify(opts) : '{}'});
      printSessionReport();
    } finally { window.open = orig; }
    return cap;
  })()`) as Promise<string>;
}

test.describe('printed session report', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  });

  test('collected excludes the cancelled-but-paid row and the unpaid rider', async ({ page }) => {
    const html = await reportHtml(page);
    expect(html).toContain('150'); // 80 + 40 + 30
    expect(html).not.toContain('249'); // would mean the cancelled 99 leaked in
  });

  test('card and cash split the collected total between them', async ({ page }) => {
    const split = await page.evaluate(`(() => {
      const r2 = (n) => Math.round(n * 100) / 100;
      const paid = getQueue().filter(e => e.sessionId === 's0' && e.paid
        && e.status !== 'cancelled' && e.status !== 'removed');
      const collected = r2(paid.reduce((s, e) => s + (e.price ?? 0), 0));
      const card = r2(paid.reduce((s, e) => s + (e.pay_method === 'card' ? (e.price ?? 0)
        : e.pay_method === 'split' ? (e.card_amount || 0) : 0), 0));
      return { collected, card, cash: r2(collected - card) };
    })()`) as { collected: number; card: number; cash: number };

    expect(split.collected).toBe(150);
    expect(split.card).toBe(95); // 40 card + 55 card-share of the split
    expect(split.cash).toBe(55); // 25 split remainder + 30 cash
    expect(split.card + split.cash).toBe(split.collected);
  });

  test('the cancelled row never appears as a line either', async ({ page }) => {
    const html = await reportHtml(page);
    expect(html).not.toContain('Cancelled Paid');
  });

  test('a bike-type filter narrows the rows but leaves the money alone', async ({ page }) => {
    const html = await reportHtml(page, { fType: 'Road' });
    expect(html).toContain('Card Rider'); // the one Road booking
    expect(html).not.toContain('Split Rider'); // filtered out of the rows
    expect(html).toContain('150'); // ...but the drawer still holds the whole session
  });

  test('an unpaid-only filter still reports the full collected figure', async ({ page }) => {
    const html = await reportHtml(page, { fPay: 'pending' });
    expect(html).toContain('Unpaid Rider');
    expect(html).not.toContain('Card Rider');
    expect(html).toContain('150');
  });
});
