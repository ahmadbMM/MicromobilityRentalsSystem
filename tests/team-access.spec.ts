import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Claude Design #7 to #9: a PIN per operator name, checked on the server; the admin's Team page
// for PINs and for what each sign-in account can open and change; and read-only sections.

const ME = '11111111-1111-1111-1111-111111111111';
const DESK = '22222222-2222-2222-2222-222222222222';
const team = [
  { user_id: ME, email: 'owner@example.com', role: 'admin', modules_view: null, modules_edit: null, is_me: true },
  { user_id: DESK, email: 'desk@example.com', role: 'frontdesk', modules_view: null, modules_edit: null, is_me: false },
];
const ops = [{ name: 'Malik', has_pin: false }, { name: 'Salem', has_pin: true }];

async function boot(page: Page, x: Record<string, unknown> = {}, opName: string | null = 'Spec Staff') {
  await stubSupabase(page, { 'rpc:staff_operator_list': ops, 'rpc:staff_team_list': team, ...x });
  await unlockStaff(page);
  if (opName === null) await page.addInitScript(() => localStorage.removeItem('cq_op_name'));
  await page.goto('/');
  await waitForSb(page);
}
// Answers for one RPC, in turn: the stub's fixture is one fixed answer.
async function rpcSequence(page: Page, name: string, answers: unknown[]) {
  const calls: unknown[] = [];
  await page.route(`**/rest/v1/rpc/${name}*`, async (route) => {
    calls.push(route.request().postDataJSON());
    const body = answers[Math.min(calls.length - 1, answers.length - 1)];
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  return calls;
}

test('a name with a PIN opens a keypad; a wrong PIN shakes and clears, the right one signs the operator in', async ({ page }) => {
  await boot(page, {}, null);
  const calls = await rpcSequence(page, 'staff_check_operator_pin', [{ ok: false, reason: 'wrong', left: 4 }, { ok: true }]);
  const gate = page.locator('#op-gate-modal .op-gate');
  await expect(gate.locator('.opg-name')).toHaveText(['Malik', /Salem/]);
  // while any name has a PIN, a name cannot be typed in
  await expect(gate.locator('#op-gate-name')).toHaveCount(0);
  await gate.locator('.opg-name', { hasText: 'Salem' }).click();
  await expect(gate).toContainText('PIN for Salem');
  for (const d of ['1', '2', '3', '4']) await gate.locator(`.opg-key[data-key="${d}"]`).click();
  await expect(gate.locator('.opg-msg')).toHaveText('Wrong PIN. 4 tries left.');
  await expect(gate.locator('.opg-dot.on')).toHaveCount(0);
  await page.keyboard.type('4321'); // the keyboard's digits work too
  await expect(page.locator('#op-gate-modal .op-gate')).toHaveCount(0);
  expect(await page.evaluate('_opName()')).toBe('Salem');
  expect(calls).toEqual([{ p_name: 'Salem', p_pin: '1234' }, { p_name: 'Salem', p_pin: '4321' }]);
  await expect(page.locator('#topbar .op-chip')).toContainText('Salem');
});

test('a lock says how long to wait', async ({ page }) => {
  await boot(page, { 'rpc:staff_check_operator_pin': { ok: false, reason: 'locked', seconds: 60 } }, null);
  const gate = page.locator('#op-gate-modal .op-gate');
  await gate.locator('.opg-name', { hasText: 'Salem' }).click();
  await page.keyboard.type('0000');
  await expect(gate.locator('.opg-msg')).toHaveText('Too many tries. Wait 60 seconds.');
});

test('a name without a PIN is picked straight away, and the operator chip switches with Cancel', async ({ page }) => {
  await boot(page, {}, null);
  await page.locator('#op-gate-modal .opg-name', { hasText: 'Malik' }).click();
  expect(await page.evaluate('_opName()')).toBe('Malik');
  await page.locator('#topbar .op-chip').click();
  const gate = page.locator('#op-gate-modal .op-gate');
  await expect(gate).toContainText('Switch operator');
  await gate.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#op-gate-modal .op-gate')).toHaveCount(0);
  expect(await page.evaluate('_opName()')).toBe('Malik');
});

test('before the database update, the gate still takes a typed name', async ({ page }) => {
  await boot(page, { 'rpc:staff_operator_list': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_operator_list' } } }, null);
  const input = page.locator('#op-gate-modal #op-gate-name');
  await expect(input).toBeVisible();
  await input.fill('New Person');
  await input.press('Enter');
  expect(await page.evaluate('_opName()')).toBe('New Person');
});

test('the Team page sets PINs and what another account can open and change, never your own', async ({ page }) => {
  await boot(page);
  const pinCalls = await rpcSequence(page, 'staff_set_operator_pin', [true]);
  const accessCalls = await rpcSequence(page, 'staff_set_access', [true]);
  await page.evaluate(`setStaffTab('team')`);
  const tab = page.locator('#tab-team');
  await expect(tab.locator('.tm-op[data-op="Salem"] .tm-pin')).toHaveText('PIN set');
  await expect(tab.locator('.tm-op[data-op="Malik"] .tm-pin')).toHaveText('No PIN');
  // a PIN is 4 digits
  await tab.locator('.tm-op[data-op="Malik"]').getByRole('button', { name: 'Set PIN' }).click();
  await page.locator('#prompt-input').fill('12');
  await page.locator('#prompt-input').press('Enter');
  await expect(page.locator('#toast-container')).toContainText('A PIN is 4 digits.');
  expect(pinCalls).toEqual([]);
  await tab.locator('.tm-op[data-op="Malik"]').getByRole('button', { name: 'Set PIN' }).click();
  await page.locator('#prompt-input').fill('0427');
  await page.locator('#prompt-input').press('Enter');
  await expect.poll(() => pinCalls).toEqual([{ p_name: 'Malik', p_pin: '0427' }]);
  // your own account cannot be changed here
  const mine = tab.locator(`.tm-acct[data-acct="${ME}"]`);
  await expect(mine).toContainText('You');
  await expect(mine.locator('select')).toBeDisabled();
  await expect(mine.getByRole('button', { name: 'Save' })).toHaveCount(0);
  // the front desk account: its role's sections only; take Sales off what it can open
  const desk = tab.locator(`.tm-acct[data-acct="${DESK}"]`);
  await expect(desk.locator('.tm-chip[data-sec^="view:"]')).toHaveText(['Bookings', 'Sales', 'Workshop']);
  await desk.locator('.tm-chip[data-sec="view:cashier"]').click();
  await expect(desk.locator('.tm-chip[data-sec^="edit:"]')).toHaveText(['Bookings', 'Workshop']);
  await desk.locator('.tm-chip[data-sec="edit:workshop"]').click();
  await desk.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => accessCalls).toEqual([{ p_user: DESK, p_role: 'frontdesk', p_view: ['queue', 'workshop'], p_edit: ['queue'] }]);
});

test('an account sees only its sections, and a section it may not change is read-only', async ({ page }) => {
  await boot(page);
  await page.evaluate(`_accessSet({modules_view:['queue','cashier','community'],modules_edit:['cashier']},'u1')`);
  // the sections the rail offers (on a phone the rail sits behind the menu, so not "visible")
  const offered = () => page.evaluate(`[...document.querySelectorAll('#staff-tab-nav .tab-btn')].filter(b=>b.style.display!=='none').map(b=>b.querySelector('.snav-lbl').textContent.trim())`);
  await expect.poll(offered).toEqual(['Bookings', 'Sales', 'Community', 'Settings']) // Settings is every account's own page (2026-10-02);
  await page.evaluate(`setStaffTab('queue')`);
  await expect(page.locator('#ro-banner')).toHaveText('Read-only mode: no changes allowed');
  const refused = await page.evaluate(`sb.from('queue_entries').update({paid:true}).eq('id','x').select().then(r=>r.error&&r.error.code)`);
  expect(refused).toBe('READONLY');
  await expect(page.locator('#toast-container')).toContainText('Read-only mode: no changes allowed');
  // reads, the audit log and the database's own read calls still go through
  expect(await page.evaluate(`sb.from('queue_entries').select('id').then(r=>r.error)`)).toBeNull();
  expect(await page.evaluate(`sb.from('staff_actions').insert({action:'x'}).then(r=>r.error&&r.error.code)`)).not.toBe('READONLY');
  expect(await page.evaluate(`sb.rpc('staff_sync',{}).then(r=>r.error&&r.error.code)`)).not.toBe('READONLY');
  expect(await page.evaluate(`sb.rpc('staff_checkin',{}).then(r=>r.error&&r.error.code)`)).toBe('READONLY');
  // a section it may change is not
  await page.evaluate(`setStaffTab('cashier')`);
  await expect(page.locator('#ro-banner')).toBeHidden();
  expect(await page.evaluate(`sb.from('queue_entries').update({paid:true}).eq('id','x').then(r=>r.error&&r.error.code)`)).not.toBe('READONLY');
  // a section outside its list is not reachable
  await page.evaluate(`setStaffTab('analytics')`);
  expect(await page.evaluate('S.staffTab')).toBe('queue');
});
