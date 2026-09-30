import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Until now the stub answered 2xx to every write, so the ~60% of save paths that never
// checked res.error were indistinguishable from working code in the suite, and an RLS
// denial could not be reproduced at all. These specs drive the failure branches.

const D = '2099-02-08';
const sessions = [{
  id: 's0', day: 'Sunday', session_date: D, capacity: 9,
  status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null,
}];
const inventory = [
  { id: 'i1', name: 'Energy Gel', category: 'Supplements', qty: 10, price: 12, addon: true },
];

test.describe('inventory stock writes', () => {
  test('a refused stock write puts the on-screen count back and says so', async ({ page }) => {
    await stubSupabase(page, { sessions, inventory }, { table: 'inventory', methods: ['PATCH'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    // string form: these are app globals the type-checker cannot see
    const qty = await page.evaluate(`(async () => {
      await _addonStock(['i1'], -3);
      return (S.inventory.find(i => i.id === 'i1') || {}).qty;
    })()`) as number;

    expect(qty).toBe(10); // reverted, not the optimistic 7
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await expect(page.locator('#err-bar-el')).toContainText(/Energy Gel/);
  });

  test('a stock write that succeeds keeps the new count and shows no error', async ({ page }) => {
    await stubSupabase(page, { sessions, inventory });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    const qty = await page.evaluate(`(async () => {
      await _addonStock(['i1'], -3);
      return (S.inventory.find(i => i.id === 'i1') || {}).qty;
    })()`) as number;

    expect(qty).toBe(7);
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
  });

  test('the qty-aware path reverts by exactly what it added', async ({ page }) => {
    await stubSupabase(page, { sessions, inventory }, { table: 'inventory', methods: ['PATCH'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    const qty = await page.evaluate(`(async () => {
      await _addonStockQ([{ id: 'i1', qty: 4 }], -1);
      return (S.inventory.find(i => i.id === 'i1') || {}).qty;
    })()`) as number;

    expect(qty).toBe(10);
  });
});

test.describe('sales outbox', () => {
  test('a sale the server refuses stays queued for retry instead of vanishing', async ({ page }) => {
    await stubSupabase(page, { sessions }, { table: 'cashier_sales' });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    const pending = await page.evaluate(`(async () => {
      _salesApply([{ id: 'sale-1', session_id: '${D}', item_id: 'i1', name: 'Gel',
        category: 'Supplements', qty: 1, price: 12, pay: 'paid' }], []);
      await _outboxFlush();
      return { queued: _outboxCount(), local: (S.cashSales || []).some(r => r.id === 'sale-1') };
    })()`) as { queued: number; local: boolean };

    expect(pending.queued).toBe(1); // still owed to the server
    expect(pending.local).toBe(true); // and still on the receipt locally
  });

  test('the queue drains once the server accepts it', async ({ page }) => {
    await stubSupabase(page, { sessions }, { table: 'cashier_sales', once: true });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    // _salesApply enqueues and kicks off a flush of its own, which the stub refuses once.
    const stuck = await page.evaluate(`(async () => {
      _salesApply([{ id: 'sale-2', session_id: '${D}', item_id: 'i1', name: 'Gel',
        category: 'Supplements', qty: 1, price: 12, pay: 'paid' }], []);
      await _outboxFlush();
      return _outboxCount();
    })()`) as number;
    expect(stuck).toBe(1);

    // A later flush finds the server willing and the op leaves the queue. Polled because
    // the enqueue's own flush may still hold _outboxBusy when the first retry lands.
    await expect.poll(
      () => page.evaluate(`(async () => { await _outboxFlush(); return _outboxCount(); })()`),
      { timeout: 5000 },
    ).toBe(0);
  });
});

test.describe('write errors read as something a person can act on', () => {
  test('an RLS denial is reported as an expired session, not as Postgres text', async ({ page }) => {
    await stubSupabase(page, { sessions });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    const msg = await page.evaluate(`(() => {
      _writeErr({ error: { code: '42501', message: 'new row violates row-level security policy for table "queue_entries"' } }, 'test');
      return document.getElementById('err-bar-el').textContent;
    })()`) as string;

    expect(msg).toContain('session may have expired');
  });

  test('a duplicate key says another device took the number', async ({ page }) => {
    await stubSupabase(page, { sessions });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    const msg = await page.evaluate(`(() => {
      _writeErr({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } }, 'test');
      return document.getElementById('err-bar-el').textContent;
    })()`) as string;

    expect(msg).toContain('another device');
  });

  test('a trigger message is passed through, because it is written for humans', async ({ page }) => {
    await stubSupabase(page, { sessions });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    const msg = await page.evaluate(`(() => {
      _writeErr({ error: { code: 'P0001', message: 'This session is full.' } }, 'test');
      return document.getElementById('err-bar-el').textContent;
    })()`) as string;

    expect(msg).toContain('This session is full.');
  });

  test('the error bar stays put and offers a retry that re-runs the write', async ({ page }) => {
    await stubSupabase(page, { sessions });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    await page.evaluate(`(() => {
      window.__retries = 0;
      _writeErr({ error: { code: '42501', message: 'denied' } }, 'test', () => { window.__retries++; });
    })()`);

    const bar = page.locator('#err-bar-el');
    await expect(bar).toBeVisible();
    await page.waitForTimeout(3200); // a toast would have gone by now
    await expect(bar).toBeVisible();

    await bar.getByRole('button', { name: /try again/i }).click();
    expect(await page.evaluate('window.__retries')).toBe(1);
    await expect(bar).toHaveCount(0);
  });
});

test.describe('connection state', () => {
  test('an unreachable server is reported even while the device claims to be online', async ({ page }) => {
    await stubSupabase(page, { sessions });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    // navigator.onLine stays true on a captive portal; only the poll failing tells the truth.
    const state = await page.evaluate(`(() => {
      S._netDown = true; _updateConnUI();
      const b = document.getElementById('conn-banner');
      return { online: navigator.onLine, offline: _isOffline(), banner: b ? b.textContent : '' };
    })()`) as { online: boolean; offline: boolean; banner: string };

    expect(state.online).toBe(true);
    expect(state.offline).toBe(true);
    expect(state.banner).toContain('can’t be reached');
  });
});

test.describe('session writes stop pretending to have worked', () => {
  const admin = { sessions };

  test('a refused status change reports instead of toasting success', async ({ page }) => {
    await stubSupabase(page, admin, { table: 'sessions', methods: ['PATCH'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    // PostgREST resolves with {error} on a denial rather than throwing, so the enclosing
    // try/catch never saw it and the "Session closed" toast fired regardless.
    await page.evaluate(`toggleSession('s0','closed')`);
    await expect(page.locator('#err-bar-el')).toBeVisible();
    expect(await page.evaluate(`allSessions().find(s=>s.id==='s0').status`)).toBe('open');
  });

  test('a date move that cannot create the new session leaves the old one alone', async ({ page }) => {
    await stubSupabase(page, admin, { table: 'sessions', methods: ['POST'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);

    const seen: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.includes('/rest/v1/')) return;
      if (['POST', 'PATCH', 'DELETE'].includes(r.method())) seen.push(`${r.method()} ${u.split('/rest/v1/')[1].split('?')[0]}`);
    });

    await page.evaluate(`(async () => {
      startEditSession('s0');
      // plain-count mode: the default asks for assigned bikes, which this fixture has none of
      S.editSessMode = 'total'; S.editSessTotal = '10';
      S.editSessDate = '2099-03-01';
      await saveSessionEdit();
    })()`);

    // The insert is attempted and refused...
    expect(seen).toContain('POST sessions');
    // ...and nothing after it runs: no booking move onto an id that does not exist, and no
    // delete of the real session. That combination is what orphaned a whole day's bookings.
    expect(seen).not.toContain('PATCH queue_entries');
    expect(seen).not.toContain('DELETE sessions');
    await expect(page.locator('#err-bar-el')).toBeVisible();
  });
});
