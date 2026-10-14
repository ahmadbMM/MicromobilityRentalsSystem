import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Run for Her has a breakfast spot and its announce time, as the Saturday ride (the owner, 2026-10-14: "add a
// breakfast spot for the run for her session and hidden option do the same what's done in saturday social ride").
// While held, list_sessions blanks the run's location too; it still meets at the Jeddah Yacht Club, never the circuit.

const RUN = '2099-10-17-rh';
const AHEAD = new Date(Date.now() + 2 * 864e5).toISOString();
const PAST = new Date(Date.now() - 864e5).toISOString();
const MEET = 'https://maps.app.goo.gl/UYBngHt3YwpayVZo7';
const run = (extra: Record<string, unknown> = {}) => ({
  id: RUN, session_date: '2099-10-17', day: 'Saturday', status: 'open', capacity: 80, spots: 80, created_at: 1, event_kind: 'community',
  ride_kind: 'runher', paid_ride: false, needs_approval: false, hide_queue: true, open_to_all: false, location: 'JYC', meet_url: MEET,
  bike_slots: '{"_time":"06:00 - 06:30"}', ...extra,
});
const held = run({ reveal_at: AHEAD, location: null, breakfast_name: null, breakfast_url: null });
const told = run({ reveal_at: PAST, breakfast_name: 'Harbour Cafe', breakfast_url: 'https://maps.app.goo.gl/cafe1' });
const bk = { id: 'q1', name: 'Sara Haddad', customer_id: 'c1', session_id: RUN, session_day: 'Saturday', session_date: '2099-10-17', queue_num: 1,
  status: 'waiting', paid: false, price: 0, registered_at: '2099-10-01T10:00:00Z', run_km: 5 };

test.describe('@customer:runher the run’s breakfast spot, told at staff’s time', () => {
  async function member(page: Page, sessions: unknown[], mine: unknown[] = []) {
    await stubSupabase(page, { sessions, queue_entries: mine, 'rpc:my_bookings': mine, 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
  }

  test('held: says when, and still meets at the Jeddah Yacht Club', async ({ page }) => {
    await member(page, [held], [bk]);
    expect(await page.evaluate(`_spotHeld(S.sessions[0])`)).toBe(true);
    expect(await page.evaluate(`_venueName(S.sessions[0])`)).toBe('Jeddah Yacht Club');
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides');
    await expect(tk.locator('.cu-reveal').first()).toContainText('Breakfast spot: announced');
    await expect(tk).not.toContainText('Jeddah Corniche Circuit');
  });

  test('told: the ticket links the breakfast spot by name', async ({ page }) => {
    await member(page, [told], [bk]);
    expect(await page.evaluate(`_bfAt(S.sessions[0])`)).toBe('Breakfast at Harbour Cafe');
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides');
    await expect(tk.locator('.cu-reveal')).toHaveCount(0);
    await expect(tk.locator('a.cmy-bf')).toHaveAttribute('href', 'https://maps.app.goo.gl/cafe1');
    await expect(tk.locator('a.cmy-bf')).toContainText('Harbour Cafe');
  });
});

test.describe('@staff:sessions the run’s breakfast spot and announce time', () => {
  function writes(page: Page, method: string) {
    const out: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== method || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
      try { const b = r.postDataJSON(); (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => out.push(x)); } catch { /* not JSON */ }
    });
    return out;
  }
  async function staff(page: Page, sessions: unknown[]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], breakfast_spots: [{ id: 'sp1', name: 'Harbour Cafe', url: 'https://maps.app.goo.gl/cafe1' }] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  }

  test('the new-run form asks for both', async ({ page }) => {
    await staff(page, []);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S._nsTplId=null;S.newSessEvent='runher';renderSessions()`);
    await expect(page.locator('#ns-reveal')).toBeVisible();
    await expect(page.locator('select').filter({ has: page.locator('option[value="__new"]') }).first()).toBeVisible();
  });

  test('the run’s editor saves the spot and the time', async ({ page }) => {
    await staff(page, [run()]);
    const patches = writes(page, 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${RUN}')`);
    await page.waitForFunction(`(S.breakfastSpots||[]).length===1`);
    await page.evaluate(`renderSessions()`);
    await page.locator('select:has(option[value="__new"])').first().selectOption('sp1');
    await page.locator('#es-reveal').fill('2099-10-16T20:00');
    await expect(page.locator('#es-reveal-note')).toContainText('Breakfast spot hidden until');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => patches.filter((p) => 'reveal_at' in p).length).toBe(1);
    expect(patches.find((p) => 'reveal_at' in p)).toEqual({ reveal_at: '2099-10-16T17:00:00.000Z' });
    expect(patches.some((p) => p.breakfast_name === 'Harbour Cafe' && p.location === 'JYC')).toBe(true);
  });
});
