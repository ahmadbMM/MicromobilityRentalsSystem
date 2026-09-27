import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Apple "Hide My Email" accounts carry only a private relay address. The check-up asks them
// for the email they actually use and a password; that email becomes the main one and the
// relay address stays linked for Continue with Apple. The server decides who is asked
// (customer_fix_fields adds 'email' / 'password' for every relay account, new sign-ups
// included); these specs stub its answer.

const RELAY = 'x7kd9f2@privaterelay.appleid.com';
const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }];

async function rider(page: Page, email: string, asks: string[], extra: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions, queue_entries: [], 'rpc:my_bookings': [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Sara Khalid', email, phone: '0500000001', nationality: 'Jordan', gender: 'female' }],
    'rpc:customer_fix_fields': asks,
    'rpc:customer_fix_save': [],
    ...extra,
  });
  await loginCustomer(page, { id: 'c1', name: 'Sara Khalid', email });
  await page.goto('/');
  await waitForSb(page);
}
function saves(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', r => { if (/rpc\/customer_fix_save/.test(r.url())) bodies.push(JSON.parse(r.postData() || '{}')); });
  return bodies;
}
const setVal = (page: Page, id: string, v: string) => page.evaluate(([i, x]) => { (document.getElementById(i) as HTMLInputElement).value = x; }, [id, v]);

test('an Apple relay account is asked for its everyday email and a password, then books', async ({ page }) => {
  await rider(page, RELAY, ['email', 'password']);
  const sent = saves(page);
  await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
  const box = page.locator('#fix-gate .fx-box');
  await expect(box).toBeVisible();
  await expect(box.locator('.fx-kicker')).toHaveText('Account check-up');
  await expect(box.locator('.pg-title')).toHaveText('Add your everyday email');
  await expect(box.locator('.pg-sub')).toContainText('chose to keep your email private');
  await expect(box.locator('.pg-note')).toContainText('Continue with Apple keeps working');
  expect(await page.locator('#fix-gate .fx-item').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.fx))).toEqual(['email', 'password']);
  await expect(page.locator('#fix-gate .fx-item[data-fx="email"] .fx-was')).toHaveText(`On your account: ${RELAY}`);
  await expect(page.locator('#fix-gate .fx-item[data-fx="email"] .fx-hint')).toContainText('Your private Apple address stays linked');
  expect(await page.evaluate('S.selEvent')).toBe('none');

  // The relay address itself is not an answer.
  await setVal(page, 'fx-email', 'other@privaterelay.appleid.com');
  await setVal(page, 'fx-pw', 'Welcome9A'); await setVal(page, 'fx-pw2', 'Welcome9A');
  await page.click('#fx-save');
  await expect(page.locator('#fix-gate .fx-item[data-fx="email"] .pg-msg')).toHaveText('That’s a private Apple address. Enter the email you use every day.');
  await expect(page.locator('#fx-pw')).toHaveValue('Welcome9A');                // a repaint keeps the password it was given
  // Weak, then mismatched.
  await setVal(page, 'fx-email', 'Sara@Example.com');
  await setVal(page, 'fx-pw', 'weakpass'); await setVal(page, 'fx-pw2', 'weakpass');
  await page.click('#fx-save');
  await expect(page.locator('#fix-gate .fx-item[data-fx="password"] .pg-msg')).toContainText('at least 8 characters');
  await setVal(page, 'fx-pw', 'Welcome9A'); await setVal(page, 'fx-pw2', 'Welcome9B');
  await page.click('#fx-save');
  await expect(page.locator('#fix-gate .fx-item[data-fx="password"] .pg-msg')).toHaveText('Passwords do not match.');
  expect(sent).toHaveLength(0);
  expect(await page.locator('#fix-gate').innerHTML()).not.toContain('Welcome9');  // never written into the markup

  await setVal(page, 'fx-pw2', 'Welcome9A');
  await page.click('#fx-save');
  await expect(box).toBeHidden();
  expect(sent).toHaveLength(1);
  expect(sent[0].p_values).toEqual({ email: 'sara@example.com', password: 'Welcome9A' });
  expect(await page.evaluate('[S.selEvent,S.loggedIn.email,"password" in S.loggedIn]')).toEqual(['jcc', 'sara@example.com', false]);
});

test('an account that already has its real email is asked only for a password', async ({ page }) => {
  await rider(page, 'sara@example.com', ['password']);
  await page.evaluate(`selectEvent('jcc')`);
  const box = page.locator('#fix-gate .fx-box');
  await expect(box.locator('.pg-title')).toHaveText('Create a password');
  await expect(box.locator('.pg-sub')).toContainText('also sign in with sara@example.com');
  await expect(page.locator('#fix-gate .fx-item')).toHaveCount(1);
});

test('with a staff flag as well, the general message covers all of it', async ({ page }) => {
  await rider(page, RELAY, ['height', 'email', 'password']);
  await page.evaluate(`selectEvent('jcc')`);
  await expect(page.locator('#fix-gate .pg-title')).toHaveText('Let’s get your details right');
  expect(await page.locator('#fix-gate .fx-item').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.fx))).toEqual(['email', 'height', 'password']);
});

test('an email already on another account is named, and nothing else is lost', async ({ page }) => {
  await rider(page, RELAY, ['email', 'password'], { 'rpc:customer_fix_save': { __rpcError: { status: 409, code: '23505', message: 'email_taken' } } });
  await page.evaluate(`selectEvent('jcc')`);
  await setVal(page, 'fx-email', 'taken@example.com');
  await setVal(page, 'fx-pw', 'Welcome9A'); await setVal(page, 'fx-pw2', 'Welcome9A');
  await page.click('#fx-save');
  await expect(page.locator('#fix-gate .fx-item[data-fx="email"] .pg-msg')).toHaveText('An account with this email already exists.');
  await expect(page.locator('#fx-email')).toHaveValue('taken@example.com');
  expect(await page.evaluate('S.loggedIn.email')).toBe(RELAY);
});

// ── Signing up with Apple and a hidden email ─────────────────────────────────
// The sign-up form is the plain one; the new account meets the check-up at its first event
// pick (_customer_asks on the server; the specs above stub its answer).
async function signup(page: Page, email: string, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { 'rpc:customer_exists': false, ...fixtures });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`openAuthModal();S._pendingGoogle={email:${JSON.stringify(email)},name:"New Rider"};openGoogleComplete();setSignupGender("male");S.signupHeard='invited'`);
  await setVal(page, 'a-height', '175');
  await setVal(page, 'a-phone', '0508727012');
}
function rpcBodies(page: Page, fn: string) {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', r => { if (new RegExp(`rpc/${fn}(\\?|$)`).test(r.url())) bodies.push(JSON.parse(r.postData() || '{}')); });
  return bodies;
}

test('Apple sign-up with a hidden email asks nothing extra; the check-up comes at the first event pick', async ({ page }) => {
  await signup(page, 'n1@privaterelay.appleid.com', { 'rpc:customer_oauth_signup': [{ id: 'x', session_token: 'tokN' }] });
  const plain = rpcBodies(page, 'customer_oauth_signup');
  await expect(page.locator('#a-email')).toHaveCount(0);
  await expect(page.locator('#a-pwd')).toHaveCount(0);
  await page.evaluate('S.signupAck=true;doCompleteGoogle()');
  await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
  expect(plain).toHaveLength(1);
  expect(plain[0].p_email).toBe('n1@privaterelay.appleid.com');
  expect(await page.evaluate('S.loggedIn.email')).toBe('n1@privaterelay.appleid.com');
});

// ── Staff ─────────────────────────────────────────────────────────────────────
const customers = [
  { id: 'c1', name: 'Still Hidden', email: RELAY, phone: '+966500000001', created_at: '2026-01-05T10:00:00Z', apple_email: RELAY },
  { id: 'c2', name: 'Done Already', email: 'zz.real@example.com', phone: '+966500000002', created_at: '2026-01-06T10:00:00Z', apple_email: 'zz99@privaterelay.appleid.com' },
];
const queue_entries = [{
  id: 'b1', customer_id: 'c2', session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: 1,
  name: 'Done Already', phone: '+966500000002', email: 'zz99@privaterelay.appleid.com', type_preference: 'Road', size: 'M',
  status: 'waiting', paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z',
}];

test('staff see the Apple address in the editor, find accounts by it, and see current emails on old bookings', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries, bikes: [], customers, tags: [], customer_tags: [] });
  await unlockStaff(page);
  const gets: string[] = [];
  page.on('request', r => { if (r.method() === 'GET' && /rest\/v1\/customers/.test(r.url())) gets.push(decodeURIComponent(r.url())); });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===2');
  expect(gets.some(u => u.includes('apple_email') && u.includes('fix_fields'))).toBe(true);
  await page.evaluate(`showEditCustomerModal('c1')`);
  await expect(page.locator('#new-acct-modal .cf-apple')).toHaveText('Private Apple address — the rider will be asked for their everyday email before their next booking.');
  await page.evaluate(`closeCustFormModal();showEditCustomerModal('c2')`);
  await expect(page.locator('#new-acct-modal .cf-apple')).toHaveText('Apple sign-in: zz99@privaterelay.appleid.com');
  await page.evaluate(`closeCustFormModal()`);
  expect(await page.evaluate(`S.amSearch='zz99@private';_amFiltered().map(c=>c.id)`)).toEqual(['c2']);
  // The booking was made under the relay address; staff see the account's email now.
  expect(await page.evaluate(`_bookEmail(getQueue().find(e=>e.id==='b1'))`)).toBe('zz.real@example.com');
  await page.evaluate(`openCustomerProfile('b1')`);
  await expect(page.locator('#cust-modal .modal-sub')).toContainText('zz.real@example.com');
  expect(await page.evaluate(`!!_searchHit(getQueue().find(e=>e.id==='b1'),'zz.real')`)).toBe(true);   // searchable by it too
  // A password is never something staff can flag.
  await page.evaluate(`closeCustomerProfile();showFlagFieldsModal('c2')`);
  await expect(page.locator('#confirm-modal .fl-row')).toHaveCount(10);
  await expect(page.locator('#confirm-modal .fl-row[data-flag="password"]')).toHaveCount(0);
});

test('a database without apple_email still loads the customer list, flags included', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [] });
  const asked: string[] = [];
  await page.route(/rest\/v1\/customers\?/, r => {
    const u = decodeURIComponent(r.request().url());
    if (r.request().method() !== 'GET') return r.fallback();
    asked.push(u);
    return u.includes('apple_email')
      ? r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42703', message: 'column customers.apple_email does not exist' }) })
      : r.fallback();
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===2');
  expect(asked.some(u => !u.includes('apple_email') && u.includes('fix_fields'))).toBe(true);
});
