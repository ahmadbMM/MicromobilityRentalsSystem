import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07 (registration fields to the row menus): the fixes that a spec can hold.

const DAY = '2099-02-01';
const NOW = new Date('2099-02-01T15:00:00+03:00');

test.describe('@customer:reserve a link to a date', () => {
  test('a second ride of a kind on one date (<date>-ev-2) keeps its date in the parked link', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [] });
    await page.goto('/?ev=event&session=2099-01-11-ev-2');
    await waitForSb(page);
    expect(JSON.parse(await page.evaluate(`sessionStorage.getItem('cq_open_event')`) as string)).toEqual({ ev: 'event', session: '2099-01-11-ev-2' });
  });
});

test.describe('@staff:bookings staff list: Enter acts on a search only', () => {
  const sessions = [{ id: 's0', day: 'Sunday', session_date: DAY, capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null }];
  test('Enter in the empty box parks nobody, though the newest accounts are on show', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], desk_waitlist: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.customers=[{id:'c9',name:'Newest Account',phone:'0559990000',created_at:'2099-01-01T00:00:00Z'}];setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
    const rows: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST' || !r.url().includes('/rest/v1/desk_waitlist')) return;
      const b = r.postDataJSON();
      (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => rows.push(x));
    });
    await page.locator('#mw-name').click(); // the focus opens the newest accounts
    await expect(page.locator('#mw-suggest .mw-sug')).toHaveCount(1);
    await page.locator('#mw-name').press('Enter');
    await expect(page.locator('#mw-name')).toHaveAttribute('aria-invalid', 'true'); // asks for a name
    await page.waitForTimeout(300);
    expect(rows).toHaveLength(0);
    // a search still parks its top line
    await page.locator('#mw-name').fill('Newest');
    await page.locator('#mw-name').press('Enter');
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].name).toBe('Newest Account');
  });
});

test.describe('@customer:landing the ride-day card', () => {
  test('two rides today: the card is the one still to come, with its own number only', async ({ page }) => {
    const jcc = { id: DAY, day: 'Sunday', session_date: DAY, capacity: 20, status: 'open', created_at: 1, location: 'JCC', bike_slots: '{"_time":"18:00 - 20:00","_total":20}' };
    // a morning social ride whose list is not published yet (its numbers are staff's)
    const sat = { id: 'sat1', day: 'Sunday', session_date: DAY, capacity: 20, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'saturday', hide_queue: true, bike_slots: '{"_time":"06:00 - 06:30","_total":20}' };
    const bk = (o: Record<string, unknown>) => ({ name: 'Spec Rider', customer_id: 'c1', session_day: 'Sunday', status: 'waiting', paid: true, price: 75, type_preference: 'Hybrid', registered_at: '2099-01-01T10:00:00Z', ...o });
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, { sessions: [jcc, sat], 'rpc:list_sessions': [jcc, sat], queue_entries: [
      bk({ id: 'b-jcc', session_id: DAY, session_date: DAY, queue_num: 7 }),
      bk({ id: 'b-sat', session_id: 'sat1', session_date: DAY, queue_num: 3, approval: 'approved' }),
    ] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('renderLandingAvail()');
    await expect(page.locator('#land-events .land-today')).toHaveCount(1);
    await expect(page.locator('#land-events .land-today-n')).toHaveText('#7');
  });
});

test.describe('@customer:account the emergency contact read', () => {
  test('a failed read waits for Retry instead of asking again on every repaint', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [], 'rpc:customer_emergency': { __rpcError: { status: 500, code: 'XX000', message: 'failed' } } });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    let asks = 0;
    page.on('request', (r) => { if (r.url().includes('/rpc/customer_emergency')) asks++; });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`goCustomer('account')`);
    await expect(page.locator('#acc-em')).toContainText('Try again');
    await page.waitForTimeout(1500);
    expect(asks).toBe(1);
    await page.locator('#acc-em button', { hasText: 'Try again' }).click();
    await expect.poll(() => asks).toBe(2);
    await page.waitForTimeout(800);
    expect(asks).toBe(2);
  });
});

test.describe('@staff:sessions breakfast spot removal that did not land', () => {
  const sessions = [{ id: 's-f1', day: 'Saturday', session_date: '2099-03-07', capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', title: 'Saturday Social Ride', breakfast_name: 'Cafe Bloom', breakfast_url: null }];
  const breakfast_spots = [{ id: 'sp1', name: 'Cafe Bloom', url: null, created_at: 1 }, { id: 'sp2', name: 'Dune Bakery', url: null, created_at: 2 }];
  async function boot(page: Page) {
    await stubSupabase(page, { sessions, breakfast_spots, queue_entries: [], bikes: [] });
    // RLS refuses a delete in silence: no error, no row
    await page.route(/\/rest\/v1\/breakfast_spots\?/, (r) => r.request().method() === 'DELETE'
      ? r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' })
      : r.fallback());
    await unlockStaff(page);
    await page.goto('/bookings/sessions');
    await waitForSb(page);
    await page.waitForFunction(`S.dataLoaded&&(S.breakfastSpots||[]).length===2`);
  }
  test('the spot stays on the list and the editor says it was not removed', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('sessions');startEditSession('s-f1')`);
    await page.locator('.ss-bf-edit').click();
    await page.locator('.ss-bf-del').click();
    await page.locator('#confirm-modal .btn-red').click();
    await expect(page.locator('.ss-bf-err')).toBeVisible();
    expect(await page.evaluate(`S.breakfastSpots.map(x=>x.id)`)).toEqual(['sp1', 'sp2']);
  });
});
