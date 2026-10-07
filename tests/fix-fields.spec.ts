import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Staff flag account fields that may be wrong (customers.fix_fields). The next time the rider
// picks an event, one message lists those fields and the booking waits until every one is
// answered; the answers go through customer_fix_save, which clears what it took.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }];

async function rider(page: Page, flags: string[], extra: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions, queue_entries: [], 'rpc:my_bookings': [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', nationality: 'Jordan', gender: 'male', birth_date: '1990-01-01' }],
    'rpc:customer_fix_fields': flags,
    'rpc:customer_fix_save': [],
    ...extra,
  });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
}
function saves(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', r => { if (/rpc\/customer_fix_save/.test(r.url())) bodies.push(JSON.parse(r.postData() || '{}')); });
  return bodies;
}

test('a flagged account meets one message at the event pick, answers it, then the event opens', async ({ page }) => {
  await rider(page, ['city', 'email', 'nationality']);
  const sent = saves(page);
  await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
  const box = page.locator('#fix-gate .fx-box');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Let’s get your details right');
  expect(await page.evaluate('S.selEvent')).toBe('none');                     // the event did not open
  // One item per answer, in the account's order; country and city are one answer.
  await expect(page.locator('#fix-gate .fx-item')).toHaveCount(3);
  expect(await page.locator('#fix-gate .fx-item').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.fx))).toEqual(['email', 'nationality', 'residence']);
  await expect(page.locator('#fix-gate .fx-count')).toHaveText('3');
  await expect(page.locator('#fix-gate .fx-item[data-fx="email"] .fx-was')).toHaveText('On your account: spec@example.com');
  await expect(page.locator('#fix-gate .fx-item[data-fx="nationality"] .fx-was')).toContainText('Jordan');
  await expect(page.locator('#fx-email')).toHaveValue('');                    // typed fresh, not pre-filled

  // Save with nothing answered: every item says so, nothing is sent.
  await page.click('#fx-save');
  await expect(page.locator('#fix-gate .fx-item.err')).toHaveCount(3);
  expect(sent).toHaveLength(0);

  await page.fill('#fx-email', 'New@Example.com');
  await expect(page.locator('#fix-gate .fx-item.err')).toHaveCount(2);        // typing clears its own error only
  await page.selectOption('#fx-nat', 'Egypt');
  await page.selectOption('#fx-country', 'Saudi Arabia');
  await page.waitForSelector('#fx-city option[value="Jeddah"]', { state: 'attached' });
  await page.selectOption('#fx-city', 'Jeddah');
  await page.click('#fx-save');
  await expect(box).toBeHidden();
  expect(sent).toHaveLength(1);
  expect(sent[0].p_values).toEqual({ email: 'new@example.com', nationality: 'Egypt', country: 'Saudi Arabia', city: 'Jeddah' });
  expect(await page.evaluate('[S.selEvent,S.loggedIn.email,S.loggedIn.city]')).toEqual(['jcc', 'new@example.com', 'Jeddah']);
  expect(await page.evaluate(`document.body.classList.contains('fix-open')`)).toBe(false);
});

test('nothing flagged: the event opens straight away', async ({ page }) => {
  await rider(page, []);
  await page.evaluate(`selectEvent('jcc')`);
  await expect(page.locator('#fix-gate')).toBeHidden();
  expect(await page.evaluate('S.selEvent')).toBe('jcc');
});

// The owner, 2026-09-29: riders must answer it; there is no "Not now". Moving about the site
// leaves it up, and Log out, the one other button, leaves the account.
test('there is no way past it: no "Not now", and moving about the site leaves it up', async ({ page }) => {
  await rider(page, ['gender']);
  await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
  const box = page.locator('#fix-gate .fx-box');
  await expect(box).toBeVisible();
  await expect(box).not.toContainText('Not now');
  await expect(page.locator('#fix-gate button:not(.fx-opt)')).toHaveText(['Save and continue', 'Log out']);
  await page.keyboard.press('Escape');
  await expect(box).toBeVisible();
  for (const go of [`goCustomer('myrides')`, `goCustomer('account')`, `goLanding()`, `showView('customer')`]) {
    await page.evaluate(go);
    await expect(box).toBeVisible();
  }
  expect(await page.evaluate('S.selEvent')).toBe('none');
  expect(await page.evaluate(`document.body.classList.contains('fix-open')`)).toBe(true);
});

test('however the wizard was reached, Confirm raises the same request and books nothing', async ({ page }) => {
  await rider(page, ['gender']);
  const bookings: string[] = [];
  page.on('request', r => { if (/rpc\/customer_create_booking|rest\/v1\/queue_entries/.test(r.url()) && r.method() === 'POST') bookings.push(r.url()); });
  await page.evaluate(`S.selEvent='jcc';S.selSession='${S1}';S.regQty=1;S.waiverOk=true;submitReg()`);
  await expect(page.locator('#fix-gate .fx-box')).toBeVisible();
  expect(bookings).toHaveLength(0);
});

test('Log out leaves the account and takes the request with it', async ({ page }) => {
  await rider(page, ['gender']);
  await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
  await expect(page.locator('#fix-gate .fx-box')).toBeVisible();
  await page.click('#fix-gate .gate-out');
  await expect(page.locator('#fix-gate')).toBeHidden();
  expect(await page.evaluate('[!!S.loggedIn,!!getSession(),!!S._fix]')).toEqual([false, false, false]);
  expect(await page.evaluate(`document.body.classList.contains('fix-open')`)).toBe(false);
});

test('what the server refuses stays asked; what it took is the account now', async ({ page }) => {
  await rider(page, ['email', 'gender'], { 'rpc:customer_fix_save': ['email'] });
  await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
  await page.fill('#fx-email', 'odd@example.com');
  await page.click('#fix-gate .fx-opt >> nth=1');                            // Female
  await page.click('#fx-save');
  await expect(page.locator('#fix-gate .fx-item')).toHaveCount(1);
  await expect(page.locator('#fix-gate .fx-item[data-fx="email"] .pg-msg')).toHaveText('That didn’t look right. Please check it and try again.');
  expect(await page.evaluate('[S.loggedIn.gender,S.loggedIn.email]')).toEqual(['female', 'spec@example.com']);
  expect(await page.evaluate('S.selEvent')).toBe('none');                     // still not booked in
});

test('a booking the server refuses for owed details (FIX_FIRST) opens the request instead of an error', async ({ page }) => {
  // The device's cached answer says nothing is owed; the server knows better.
  await rider(page, ['gender'], { 'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'FIX_FIRST' } } });
  await page.evaluate(`S._fixCache={id:'c1',at:Date.now(),fields:[]}`);
  await page.evaluate(`S.selEvent='jcc';S.selSession='${S1}';S.regQty=1;S.regBikeHeights=[175];S.regBikeTypes=['Road'];S.regRiderNames=['Spec Rider'];S.promoApplied=null;S.waiverOk=true;submitReg()`);
  await expect(page.locator('#fix-gate .fx-item[data-fx="gender"]')).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'FIX_FIRST' })).toHaveCount(0);
  expect(await page.evaluate('S.regSubmitting')).toBe(false);                 // Confirm is usable again once it is answered
});

test('an email already on another account is named under the email box', async ({ page }) => {
  await rider(page, ['email'], { 'rpc:customer_fix_save': { __rpcError: { status: 409, code: '23505', message: 'email_taken' } } });
  await page.evaluate(`selectEvent('jcc')`);
  await page.fill('#fx-email', 'taken@example.com');
  await page.click('#fx-save');
  await expect(page.locator('#fix-gate .fx-item[data-fx="email"] .pg-msg')).toHaveText('An account with this email already exists.');
  await expect(page.locator('#fx-email')).toHaveValue('taken@example.com');
  await expect(page.locator('#fix-gate .pg-net')).toHaveCount(0);
});

test('switching language repaints the message and keeps what was typed', async ({ page }) => {
  await rider(page, ['name', 'height']);
  await page.evaluate(`selectEvent('jcc')`);
  await page.fill('#fx-first', 'Sara');
  await page.fill('#fx-height', '171');
  await page.evaluate(`setLang('ar')`);
  await expect(page.locator('#fix-gate .pg-title')).toHaveText('لنتأكد من صحة بياناتك');
  await expect(page.locator('#fx-first')).toHaveValue('Sara');
  await expect(page.locator('#fx-height')).toHaveValue('171');
});

test('a photo request offers an upload and will not save without one', async ({ page }) => {
  await rider(page, ['photo']);
  const sent = saves(page);
  await page.evaluate(`selectEvent('jcc')`);
  await expect(page.locator('#fix-gate .fx-item[data-fx="photo"] input[type="file"]')).toHaveCount(1);
  await page.click('#fx-save');
  await expect(page.locator('#fix-gate .fx-item[data-fx="photo"] .pg-msg')).toHaveText('Upload a photo to continue.');
  expect(sent).toHaveLength(0);
});

// ── Staff ─────────────────────────────────────────────────────────────────────
const customers = [
  { id: 'c1', name: 'Amal Al Rashid', email: 'amal@example.test', phone: '+966500000001', gender: 'female', birth_date: '1994-03-14', nationality: 'Jordan', created_at: '2026-01-05T10:00:00Z' },
  { id: 'c2', name: 'Omar Flagged', email: 'omar@example.test', phone: '+966500000002', fix_fields: ['name'], created_at: '2026-01-06T10:00:00Z' },
];
async function accounts(page: Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [] });
  await unlockStaff(page);
  const gets: string[] = [];
  page.on('request', r => { if (r.method() === 'GET' && /rest\/v1\/customers/.test(r.url())) gets.push(decodeURIComponent(r.url())); });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
  return gets;
}
// A flag is written by staff_flag_customer now (it keeps the history row in step), so read what
// the RPC was asked to store, in the shape the column takes: the fields, or null when cleared.
function patches(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', r => {
    if (r.method() !== 'POST' || !/rest\/v1\/rpc\/staff_flag_customer/.test(r.url())) return;
    const b = JSON.parse(r.postData() || '{}');
    bodies.push({ fix_fields: b.p_fields && b.p_fields.length ? b.p_fields : null });
  });
  return bodies;
}

test('staff tick fields in a report-builder dialog and the row says what was asked', async ({ page }) => {
  const gets = await accounts(page);
  expect(gets.some(u => u.includes('fix_fields'))).toBe(true);                // the list carries the flags
  const sent = patches(page);
  await expect(page.locator('.am-row[data-cust="c2"] .am-fix')).toHaveText(/Asked to correct: Name/);
  await expect(page.locator('.am-row[data-cust="c1"] .am-fix')).toHaveCount(0);
  await page.click('.am-row[data-cust="c1"] .am-flag');
  const dlg = page.locator('#confirm-modal .fl-box');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.fl-preview')).toContainText('Let’s get your details right'); // the rider's message, above the fields
  await expect(dlg.locator('.fl-row')).toHaveCount(20); // every field of the account since 2026-10-06, WhatsApp since 2026-10-07 (flag-every-field.spec.ts)
  await expect(dlg.locator('.fl-row[data-flag="email"] .fl-val')).toHaveText('amal@example.test');
  await expect(page.locator('#fl-send')).toBeDisabled();
  await dlg.locator('.fl-row[data-flag="phone"]').click();
  await dlg.locator('.fl-row[data-flag="email"]').click();
  await expect(dlg.locator('.fl-row[data-flag="email"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#fl-send')).toHaveText(/Ask to correct \(2\)/);
  await page.click('#fl-send');
  await expect(dlg).toBeHidden();
  expect(sent).toEqual([{ fix_fields: ['email', 'phone'] }]);                  // the account's order, not the tap order
  expect(await page.evaluate('_refDirty')).toBe(false);                        // no full customer-list reload queued for one flag
  await expect(page.locator('.am-row[data-cust="c1"] .am-fix')).toHaveText(/Asked to correct: Email Address, Phone Number/);
  await expect(page.locator('.am-row[data-cust="c1"] .am-flag')).toHaveClass(/\bon\b/);
});

test('the account editor shows the request and can withdraw it', async ({ page }) => {
  await accounts(page);
  const sent = patches(page);
  await page.evaluate(`showEditCustomerModal('c2')`);
  await expect(page.locator('#cf-flag-wrap .fl-open')).toHaveText(/Correction asked \(1\)/);
  await expect(page.locator('#cf-fix-line')).toContainText('Asked to correct: Name');
  await page.click('#cf-flag-wrap .fl-open');
  await expect(page.locator('#confirm-modal .fl-row[data-flag="name"]')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#confirm-modal button:has-text("Withdraw request")');
  await expect(page.locator('#confirm-modal .fl-box')).toBeHidden();
  expect(sent).toEqual([{ fix_fields: null }]);
  await expect(page.locator('#cf-flag-wrap .fl-open')).toHaveText(/Ask to correct/);
  await expect(page.locator('#cf-fix-line')).toBeEmpty();
  await expect(page.locator('#new-acct-modal .modal-box')).toBeVisible();     // the editor underneath is untouched
});

test('a database from before the column still loads the customer list', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [] });
  await page.route(/rest\/v1\/customers\?.*fix_fields/, r => r.request().method() === 'GET'
    ? r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42703', message: 'column customers.fix_fields does not exist' }) })
    : r.fallback());
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===2');
});
