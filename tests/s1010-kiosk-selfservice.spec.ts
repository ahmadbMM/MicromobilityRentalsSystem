import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The self-service kiosk (2026-10-09; migration 20261009230000): a desk tablet in kiosk mode lets a walk-in
// find their account by phone (masked, confirmed by the last four digits) or make one, pick tonight's ride
// (only rides that take walk-ins), the bike (never Any), agree to the waiver and land on the roster as
// Waiting with the Kiosk badge and a bell line. Every write is the staff session's: customer_signup and a
// staff insert. Leaving kiosk mode asks an operator's PIN. Invented people and numbers only.
const KSA = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const TODAY = KSA(new Date());
const NOON = new Date(`${TODAY}T12:00:00+03:00`); // the clock is held at noon in Jeddah: tonight's rides are still to come
const slots = JSON.stringify({ _time: '19:00 - 21:00' });
const sessions = [
  { id: 'jcc1', day: 'Friday', session_date: TODAY, capacity: 20, status: 'open', created_at: 1, ride_kind: 'jcc', bike_slots: slots },
  { id: 'sat1', day: 'Saturday', session_date: TODAY, capacity: 20, status: 'open', created_at: 2, ride_kind: 'saturday', event_kind: 'community', bike_slots: slots },
  { id: 'swim1', day: 'Friday', session_date: TODAY, capacity: 20, status: 'open', created_at: 3, ride_kind: 'swim', event_kind: 'community', open_to_all: true, needs_approval: false, bike_slots: slots },
];
const customers = [
  { id: 'cu1', name: 'Sara Haddad', phone: '+966500000123', email: 'sara@example.com', height: 168, type_preference: 'Hybrid', nationality: 'Jordan', birth_date: null, emergency_phone: '+966511111111', created_at: '2026-01-01T00:00:00Z' },
];
type Sent = { method: string; table: string; body: unknown };

async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(NOON);
  await stubSupabase(page, {
    sessions, customers, queue_entries: [], bikes: [], staff_options: [],
    'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: true }],
    'rpc:staff_pin_approve': { ok: true, token: 'tok-ok' },
    ...fx,
  });
  const sent: Sent[] = [];
  const rpc: { name: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const u = r.url(); let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
    const m = u.match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (m) { rpc.push({ name: m[1], body: (body || {}) as Record<string, unknown> }); return; }
    const t = u.match(/\/rest\/v1\/([^/?]+)/);
    if (t && ['POST', 'PATCH'].includes(r.method())) sent.push({ method: r.method(), table: t[1], body });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  return { sent, rpc };
}
const kiosk = (page: Page) => page.locator('#kiosk');
async function enterKiosk(page: Page) {
  await page.evaluate(`setStaffTab('settings')`);
  await page.locator('#set-kiosk').click();
  await expect(kiosk(page)).toBeVisible();
  await expect(kiosk(page).getByRole('heading', { name: 'Welcome to MicroMobility' })).toBeVisible();
}

test.describe('@staff:bookings s1010 kiosk: self-service walk-ins', () => {
  test('kiosk mode is entered from Settings only with an operator PIN on the team', async ({ page }) => {
    await boot(page, { 'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: false }] });
    await page.evaluate(`setStaffTab('settings')`);
    await page.locator('#set-kiosk').click();
    await expect(page.locator('#toast-container')).toContainText('needs an operator with a PIN');
    await expect(kiosk(page)).toHaveCount(0);
    expect(await page.evaluate(`localStorage.getItem('cq_kiosk')`)).toBeNull();
  });

  test('an account found by phone is masked, confirmed by its last four digits, and joins as Waiting with the kiosk mark and the waiver', async ({ page }) => {
    const { sent } = await boot(page);
    await enterKiosk(page);
    await kiosk(page).getByRole('button', { name: 'I have an account' }).click();
    await kiosk(page).locator('#ko-phone').fill('500000123');
    await kiosk(page).getByRole('button', { name: 'Find', exact: true }).click();
    const hit = kiosk(page).locator('.ko-hit');
    await expect(hit).toHaveCount(1);
    await expect(hit).toContainText('Sa');
    await expect(hit).not.toContainText('Sara'); // a stranger at the tablet never reads the whole name
    await hit.click();
    await kiosk(page).locator('#ko-last4').fill('9999');
    await kiosk(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(kiosk(page).locator('.ko-err')).toContainText('do not match');
    await kiosk(page).locator('#ko-last4').fill('0123');
    await kiosk(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    // nothing is missing on this account: straight to tonight's rides, the Saturday ride and the pool are not offered
    await expect(kiosk(page).getByRole('heading', { name: "Tonight's rides" })).toBeVisible();
    await expect(kiosk(page).locator('.ko-ride')).toHaveCount(1); // the circuit only: no Saturday ride and no pool session (no Walk-in on either)
    await kiosk(page).locator('.ko-ride').first().click();
    // the bike: the account's height and type come along, Any is never offered
    await expect(kiosk(page).locator('#ko-height')).toHaveValue('168');
    await expect(kiosk(page).locator('.ko-type')).not.toContainText(['Any']);
    await expect(kiosk(page).locator('.ko-type[aria-pressed="true"]')).toHaveText('Hybrid');
    await expect(kiosk(page).locator('.ko-fit')).toContainText('Your size');
    await kiosk(page).getByRole('button', { name: 'Continue' }).click();
    // the waiver: Agree stays off until ticked
    const join = kiosk(page).getByRole('button', { name: 'Agree and join' });
    await expect(join).toBeDisabled();
    await kiosk(page).locator('.ko-agree input').check();
    await join.click();
    await expect(kiosk(page).getByRole('heading', { name: 'You are on the list' })).toBeVisible();
    await expect(kiosk(page)).toContainText('Go to the desk');
    const ins = sent.find((s) => s.table === 'queue_entries' && s.method === 'POST');
    expect(ins).toBeTruthy();
    const row = (Array.isArray(ins!.body) ? ins!.body[0] : ins!.body) as Record<string, unknown>;
    expect(row).toMatchObject({ customer_id: 'cu1', session_id: 'jcc1', status: 'waiting', via: 'kiosk', type_preference: 'Hybrid', walk_in: false });
    expect(String(row.waiver_version || '')).toMatch(/^2026-/);
    expect(row.waiver_at).toBeTruthy();
    // staff see it: the row as the server keeps it (the stub's reload has no rows) carries the Kiosk badge and a bell line
    const e = await page.evaluate(`(()=>{const x=entryFromDB(${JSON.stringify(row)});S.queue=[...getQueue().filter(q=>q.id!==x.id),x];return{st:x.status,tag:_kioskTag(x)};})()`) as { st: string; tag: string };
    expect(e && e.st).toBe('waiting');
    expect(e && e.tag).toContain('Kiosk');
    const kinds = await page.evaluate(`_ntKindsNow().find(x=>x.k==='kiosk').items.map(i=>i.txt)`) as string[];
    expect(kinds.join()).toContain('registered at the kiosk');
  });

  test('a new walk-in gives a name, phone, the emergency contact and nationality; customer_signup makes the account through the staff session', async ({ page }) => {
    const { sent, rpc } = await boot(page);
    await enterKiosk(page);
    await kiosk(page).getByRole('button', { name: "I'm new here" }).click();
    await expect(kiosk(page).getByRole('heading', { name: 'Your details' })).toBeVisible();
    await kiosk(page).locator('#ko-first').fill('Omar-');
    await expect(kiosk(page).locator('#ko-first')).toHaveValue('Omar '); // a dash becomes a space as typed
    await kiosk(page).locator('#ko-first').fill('Omar');
    await kiosk(page).locator('#ko-last').fill('Nasser');
    await kiosk(page).locator('#ko-phone').fill('500000777');
    await kiosk(page).getByRole('button', { name: 'Continue' }).click();
    await expect(kiosk(page).locator('.ko-err')).toContainText(/contact/i); // the emergency contact is required
    await kiosk(page).locator('#ko-emName').fill('Huda Nasser');
    await kiosk(page).locator('#ko-emPhone').fill('500000778');
    await kiosk(page).locator('#ko-emRel').selectOption('sibling');
    await kiosk(page).getByRole('button', { name: 'Continue' }).click();
    await expect(kiosk(page).locator('.ko-err')).toContainText('nationality');
    // Saudi Arabia is listed twice (top and its own place), one value
    expect(await kiosk(page).locator('#ko-nat option[value="Saudi Arabia"]').count()).toBe(2);
    await kiosk(page).locator('#ko-nat').selectOption('Saudi Arabia');
    await kiosk(page).getByRole('button', { name: 'Continue' }).click();
    await kiosk(page).locator('.ko-ride').first().click();
    await kiosk(page).locator('#ko-height').fill('180');
    await kiosk(page).getByRole('button', { name: 'Continue' }).click();
    await expect(kiosk(page).locator('.ko-err')).toContainText('bike type'); // no type picked, and none is assumed
    await kiosk(page).locator('.ko-type', { hasText: 'Road' }).first().click();
    await kiosk(page).getByRole('button', { name: 'Continue' }).click();
    await kiosk(page).locator('.ko-agree input').check();
    await kiosk(page).getByRole('button', { name: 'Agree and join' }).click();
    await expect(kiosk(page).getByRole('heading', { name: 'You are on the list' })).toBeVisible();
    const su = rpc.find((c) => c.name === 'customer_signup');
    expect(su && su.body).toMatchObject({ p_name: 'Omar Nasser', p_phone: '+966500000777', p_email: '', p_height: 180, p_type_preference: 'Road', p_heard_from: 'desk' });
    expect(String(su!.body.p_pwd)).toMatch(/^(?=.*[A-Z])(?=.*\d).{8,}$/); // the server's password rule, never shown
    const upd = sent.find((s) => s.table === 'customers' && s.method === 'PATCH');
    expect(upd && upd.body).toMatchObject({ nationality: 'Saudi Arabia', emergency_name: 'Huda Nasser', emergency_phone: '+966500000778', emergency_relation: 'sibling' });
    const ins = sent.find((s) => s.table === 'queue_entries' && s.method === 'POST');
    const row = (Array.isArray(ins!.body) ? ins!.body[0] : ins!.body) as Record<string, unknown>;
    expect(row).toMatchObject({ customer_id: su!.body.p_id, status: 'waiting', via: 'kiosk', type_preference: 'Road', size: 'L' });
  });

  test('a number that already has an account is sent to Find instead of making a second one', async ({ page }) => {
    const { rpc } = await boot(page);
    await enterKiosk(page);
    await kiosk(page).getByRole('button', { name: "I'm new here" }).click();
    await kiosk(page).locator('#ko-first').fill('Sara');
    await kiosk(page).locator('#ko-last').fill('Haddad');
    await kiosk(page).locator('#ko-phone').fill('0500000123');
    await kiosk(page).getByRole('button', { name: 'Continue' }).click();
    await expect(kiosk(page).locator('.ko-err')).toContainText('already has this number');
    await expect(kiosk(page).getByRole('button', { name: 'I have an account' })).toBeVisible();
    expect(rpc.some((c) => c.name === 'customer_signup')).toBe(false);
  });

  test('no ride taking walk-ins tonight says so; the language switcher redraws the screen; leaving asks the PIN', async ({ page }) => {
    await boot(page, { sessions: [sessions[1]] });
    await enterKiosk(page);
    await kiosk(page).getByRole('button', { name: 'I have an account' }).click();
    await kiosk(page).locator('#ko-phone').fill('500000123');
    await kiosk(page).getByRole('button', { name: 'Find', exact: true }).click();
    await kiosk(page).locator('.ko-hit').click();
    await kiosk(page).locator('#ko-last4').fill('0123');
    await kiosk(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(kiosk(page).locator('.ko-empty')).toContainText('No ride takes walk-ins');
    await kiosk(page).locator('.ko-lang select').selectOption('ar');
    await expect(kiosk(page).getByRole('heading', { name: 'رحلات الليلة' })).toBeVisible();
    await kiosk(page).locator('.ko-lang select').selectOption('en');
    // the desk keys are off while the kiosk shows
    await page.keyboard.press('w');
    await expect(page.locator('#walkin-modal .modal-box')).toHaveCount(0);
    // leaving: the operator's keypad, then the panel again
    await kiosk(page).locator('.ko-exit').click();
    const gate = page.locator('#op-gate-modal [role="dialog"]');
    await expect(gate).toContainText('leave kiosk mode');
    for (const d of ['1', '2', '3', '4']) await gate.locator(`.opg-key[data-key="${d}"]`).click();
    await expect(kiosk(page)).toHaveCount(0);
    expect(await page.evaluate(`localStorage.getItem('cq_kiosk')`)).toBeNull();
  });

  test('the done screen goes back to the start on its own after 20 seconds', async ({ page }) => {
    test.setTimeout(60000);
    await boot(page);
    await enterKiosk(page);
    await page.evaluate(`S._kiosk.step='done';S._kiosk.res={qn:3,name:'Sara Haddad',sid:'jcc1'};_koTouch();_koRender()`);
    await expect(kiosk(page).getByRole('heading', { name: 'You are on the list' })).toBeVisible();
    await expect(kiosk(page).getByRole('heading', { name: 'Welcome to MicroMobility' })).toBeVisible({ timeout: 25000 });
  });
});
