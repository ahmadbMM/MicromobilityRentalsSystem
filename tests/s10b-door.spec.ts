import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Door role (staff round s10, D11; the owner, 2026-11-11: "do it all"; migration 20261111180500): a staff account
// whose only job is checking riders in at the entrance signs in to one locked scan screen. Paid and free riders are
// checked in there; anyone who owes, is on the waitlist or needs anything else is sent to the desk.

const DAY = '2026-11-15';
const sessions = [{ id: DAY, session_date: DAY, day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];
const row = (id: string, x: Record<string, unknown> = {}) => ({
  id, session_id: DAY, session_day: 'Sunday', session_date: DAY, queue_num: 1, name: 'R ' + id, phone: '0550000001',
  type_preference: 'Road', size: 'M', height: 172, status: 'waiting', paid: false, price: 57.5, waiver_version: '2026-10-01',
  waiver_at: `${DAY}T10:00:00Z`, registered_at: `${DAY}T09:00:00Z`, ...x });
const queue = [
  row('paid1aa', { queue_num: 1, name: 'Paid Rider', paid: true, pay_method: 'card' }),
  row('owes2bb', { queue_num: 2, name: 'Owing Rider', phone: '0551234567' }),
  row('came3cc', { queue_num: 3, name: 'Early Bird', status: 'active', paid: true, checked_in_at: `${DAY}T14:05:00Z`, checked_in_by: 'Desk Staff' }),
];
type Call = { name: string; body: Record<string, unknown> };
const rpcs = (page: Page) => {
  const calls: Call[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); } });
  return calls;
};

async function door(page: Page) {
  await page.clock.setFixedTime(new Date(`${DAY}T18:00:00+03:00`));
  await stubSupabase(page, { sessions, queue_entries: queue, bikes: [] });
  await unlockStaff(page);
  await page.addInitScript(() => { localStorage.setItem('cq_role', 'door'); });
  await page.goto('/');
  await waitForSb(page);
  await expect(page.locator('#door-page h1')).toHaveText('Door check-in');
}

test.describe('@staff:door the Door role', () => {
  test('signs in straight to the scan screen: the day\'s counts and arrivals, no rail, menu or Ctrl K', async ({ page }) => {
    await door(page);
    await expect(page.locator('#view-staff')).toBeHidden();
    await expect(page.locator('#staff-tab-nav')).toBeHidden();
    await expect(page.locator('#snav-burger')).toBeHidden();
    await expect(page.locator('#topbar-right')).toBeHidden();
    await expect(page.locator('#door-page .rq-more')).toHaveCount(0);
    await expect(page.locator('#zg-figs .zg-fig')).toHaveText(['1Arrived', '2Still to come', '3Expected']);
    await expect(page.locator('#zg-arr .zg-row')).toHaveCount(1);
    await expect(page.locator('#zg-arr .zg-row')).toContainText('Early Bird');
    await expect(page.locator('#zg-arr .zg-row')).toContainText('Desk Staff');
    await page.keyboard.press('Control+k');
    await expect(page.locator('#gs-panel')).toBeHidden();
    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await expect(page.locator('#door-page')).toBeVisible();
    await expect(page.locator('#view-staff')).toBeHidden();
  });

  test('the address stays locked: a typed address, a section asked for and Back all keep the scan screen', async ({ page }) => {
    await page.clock.setFixedTime(new Date(`${DAY}T18:00:00+03:00`));
    await stubSupabase(page, { sessions, queue_entries: queue, bikes: [] });
    await unlockStaff(page);
    await page.addInitScript(() => { localStorage.setItem('cq_role', 'door'); });
    await page.goto('/history');
    await waitForSb(page);
    await expect(page.locator('#door-page h1')).toHaveText('Door check-in');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await page.evaluate(`setStaffTab('team')`);
    await expect(page.locator('#view-staff')).toBeHidden();
    await expect(page.locator('#door-page')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#door-page')).toBeVisible();
    await expect(page.locator('#view-staff')).toBeHidden();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await page.evaluate(`goLanding()`);
    await expect(page.locator('#door-page')).toBeVisible();
  });

  test('a scanned paid rider is checked in through staff_checkin alone, and counts as arrived', async ({ page }) => {
    await door(page);
    const calls = rpcs(page);
    await page.evaluate(`_onScanPayload('MMC-1-paid1aa')`);
    const card = page.locator('#zg-card');
    await expect(card).toContainText('Paid Rider');
    await expect(card).toContainText('172 cm');
    await expect(card.getByRole('button', { name: 'Check in' })).toBeFocused();
    await card.getByRole('button', { name: 'Check in' }).click();
    await expect(card.locator('.zg-why')).toContainText('Checked in at');
    await expect(card.getByRole('button', { name: 'Check in' })).toHaveCount(0);
    const ci = calls.filter((c) => c.name === 'staff_checkin');
    expect(ci).toHaveLength(1);
    expect(ci[0].body).toMatchObject({ p_booking_id: 'paid1aa', p_bike_id: null });
    for (const k of ['p_paid', 'p_price', 'p_pay_method', 'p_card_amount']) expect(ci[0].body).not.toHaveProperty(k);
    await expect(page.locator('#zg-figs .zg-fig').first()).toHaveText('2Arrived');
    await expect(page.locator('#zg-arr .zg-row')).toHaveCount(2);
    await expect(page.locator('#zg-scan')).toBeFocused(); // the next rider is scanned, never opened by itself
  });

  test('an unpaid rider is sent to the desk with what they owe, and no Check in', async ({ page }) => {
    await door(page);
    const calls = rpcs(page);
    await page.fill('#zg-q', 'owing');
    await expect(page.locator('#zg-hits .zg-row')).toHaveCount(1);
    await page.press('#zg-q', 'Enter');
    const card = page.locator('#zg-card');
    await expect(card).toContainText('Owing Rider');
    await expect(card.locator('.zg-why')).toHaveText('Owes SAR 57.5 · send them to the desk');
    await expect(card.getByRole('button', { name: 'Check in' })).toHaveCount(0);
    // found by the mobile too, and a refusal from the database is said on the row
    await page.fill('#zg-q', '055 123 4567');
    await expect(page.locator('#zg-hits .zg-row')).toContainText('Owing Rider');
    expect(calls.filter((c) => c.name === 'staff_checkin')).toHaveLength(0);
  });

  test('a refusal from the database is said on the rider\'s row', async ({ page }) => {
    await page.clock.setFixedTime(new Date(`${DAY}T18:00:00+03:00`));
    await stubSupabase(page, { sessions, queue_entries: queue, bikes: [],
      'rpc:staff_checkin': { __rpcError: { status: 403, code: '42501', message: 'DOOR_UNPAID: #1 has not paid; the desk takes the payment' } } });
    await unlockStaff(page);
    await page.addInitScript(() => { localStorage.setItem('cq_role', 'door'); });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`_onScanPayload('MMC-1-paid1aa')`);
    await page.locator('#zg-card').getByRole('button', { name: 'Check in' }).click();
    await expect(page.locator('#zg-card .zg-err')).toHaveText('Not paid · send them to the desk');
  });

  test('sign out asks first', async ({ page }) => {
    await door(page);
    await page.locator('#door-page').getByRole('button', { name: 'Sign out' }).click();
    const dlg = page.getByRole('dialog', { name: 'Sign out of the door screen?' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#door-page')).toBeVisible();
  });
});

test.describe('@staff:door Team', () => {
  const ME = '11111111-1111-1111-1111-111111111111';
  const DESK = '22222222-2222-2222-2222-222222222222';
  const team = [
    { user_id: ME, email: 'owner@example.com', role: 'admin', modules_view: null, modules_edit: null, is_me: true },
    { user_id: DESK, email: 'gate@example.com', role: 'frontdesk', modules_view: ['queue'], modules_edit: ['queue'], is_me: false },
  ];
  const more = [
    { user_id: ME, disabled_at: null, caps: null, display_name: 'Owner', last_sign_in_at: '2026-10-08T18:00:00Z' },
    { user_id: DESK, disabled_at: null, caps: null, display_name: 'Gate', last_sign_in_at: null },
  ];
  async function admin(page: Page) {
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], 'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: false }],
      'rpc:staff_team_list': team, 'rpc:staff_team_more': more, 'rpc:staff_invite': { ok: true, user_id: '33333333-3333-3333-3333-333333333333' },
      'rpc:staff_invite_check': { ok: true, staff: true, auth: true, identity: true, confirmed: true, password: true }, 'rpc:staff_set_access': true });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`confirmDialog=(o)=>o.onConfirm&&o.onConfirm();S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();setStaffTab('team')`);
  }

  test('Team invites a Door account', async ({ page }) => {
    await admin(page);
    const calls = rpcs(page);
    await expect(page.locator('#tm-inv-role option[value="door"]')).toHaveText('Door');
    await page.fill('#tm-inv-email', 'gate.helper@example.com');
    await page.fill('#tm-inv-name', 'Gate Helper');
    await page.selectOption('#tm-inv-role', 'door');
    await page.click('#tm-inv-go');
    await expect.poll(() => calls.filter((c) => c.name === 'staff_invite').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_invite')!.body).toMatchObject({ p_email: 'gate.helper@example.com', p_name: 'Gate Helper', p_role: 'door' });
  });

  test('Team switches an account to Door: no section chips, and the lists are left to the database', async ({ page }) => {
    await admin(page);
    const calls = rpcs(page);
    const acct = page.locator(`.tm-acct[data-acct="${DESK}"]`);
    await acct.locator('.tm-role').selectOption('door');
    await expect(acct.locator('.tm-door')).toContainText('one locked screen');
    await expect(acct.locator('[data-sec]')).toHaveCount(0);
    await acct.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_set_access').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_set_access')!.body).toEqual({ p_user: DESK, p_role: 'door', p_view: null, p_edit: null });
  });
});

test('@staff:door the migration: the role map, the two ways in, no capability and the guards', () => {
  const sql = readFileSync('supabase/migrations/20261111180500_door_role.sql', 'utf8');
  const fn = (name: string) => { const i = sql.indexOf(`function public.${name}(`); expect(i).toBeGreaterThan(-1); return sql.slice(i, sql.indexOf('$function$;', i)); };
  expect(fn('_staff_role_mods')).toContain("when 'door' then array['queue']");
  expect(fn('_staff_role_mods')).toContain("else array['queue','cashier','workshop']"); // the rest of 20261111180200's map, unchanged
  for (const f of ['staff_invite', 'staff_set_access']) expect(fn(f)).toMatch(/'owner', 'volunteer', 'door'\)/);
  expect(fn('staff_set_access')).toContain("when p_role = 'door' then array['queue']::text[]");
  expect(fn('staff_set_access')).toContain("modules_edit = case when p_role in ('volunteer', 'door') then '{}'::text[]");
  expect(fn('_staff_cap')).toContain("s.role is distinct from 'door'");
  const guard = fn('_door_queue_guard');
  expect(guard).toContain("old.status = 'waiting' and new.status = 'active'");
  expect(guard).toContain('pg_trigger_depth() > 1');
  expect(guard).toContain('DOOR_UNPAID');
  for (const tb of ['queue_entries', 'cashier_sales', 'wallet_ledger', 'locker_rentals', 'lockers', 'locker_items', 'staff_options', 'customers', 'sessions']) {
    expect(sql).toContain(`create trigger a_door_guard before insert or update or delete on public.${tb}`);
  }
  expect(sql).not.toMatch(/a_door_guard before[^;]*on public\.bikes/); // staff_checkin claims the booking's bike itself
  expect(sql).toContain("values ('20261111180500', 'door_role')");
});
