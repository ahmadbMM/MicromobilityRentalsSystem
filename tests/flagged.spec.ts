import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Community > Flagged: every request staff made for a rider to correct their account, kept in
// customer_flags because the request itself (customers.fix_fields) is cleared the moment it is
// answered. And the rule for what a name may hold: letters of any script and their combining
// marks and spaces - no dashes, nothing else - wherever a customer's name is set.

const customers = [
  { id: 'c1', name: 'Amal Al Rashid', email: 'amal@example.test', phone: '+966500000001', height: 181, created_at: '2026-01-05T10:00:00Z' },
  { id: 'c2', name: 'Omar Flagged', email: 'omar@example.test', phone: '+966500000002', fix_fields: ['name'], created_at: '2026-01-06T10:00:00Z' },
  { id: 'c3', name: 'Sara Noor', email: 'sara@example.test', phone: '+966500000003', created_at: '2026-01-07T10:00:00Z' },
];
const flags = [
  { id: 'f1', customer_id: 'c2', fields: ['name'], status: 'pending', flagged_by: 'Desk A', flagged_at: '2026-09-20T10:00:00Z', answered_at: null, changes: {} },
  { id: 'f2', customer_id: 'c1', fields: ['name', 'height'], status: 'answered', flagged_by: 'Desk B', flagged_at: '2026-09-18T10:00:00Z', answered_at: '2026-09-19T09:00:00Z',
    changes: { name: { before: 'Amal R', after: 'Amal Al Rashid', at: '2026-09-19T09:00:00Z' }, height: { before: 170, after: 181, at: '2026-09-19T09:00:00Z' } } },
  { id: 'f3', customer_id: 'c3', fields: ['email'], status: 'withdrawn', flagged_by: null, flagged_at: '2026-09-16T10:00:00Z', answered_at: '2026-09-17T10:00:00Z', changes: {} },
];

async function flaggedTab(page: Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, customer_flags: flags, tags: [], customer_tags: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');S.communityTab='flagged';renderCommunity()`);
  await expect(page.locator('.flg-row')).toHaveCount(3);
}
const row = (page: Page, id: string) => page.locator(`.flg-row[data-flag-id="${id}"]`);

test('the Flagged tab lists every request: what was asked, where it stands, what changed', async ({ page }) => {
  await flaggedTab(page);
  await expect(page.locator('.filter-pill', { hasText: 'All (3)' })).toBeVisible();
  await expect(page.locator('.filter-pill', { hasText: 'Pending (1)' })).toBeVisible();
  await expect(page.locator('.filter-pill', { hasText: 'Replied (1)' })).toBeVisible();
  await expect(page.locator('.filter-pill', { hasText: 'Withdrawn (1)' })).toBeVisible();

  // still waiting: says for what, and cannot be flagged again while it is open
  await expect(row(page, 'f1')).toContainText('Omar Flagged');
  await expect(row(page, 'f1').locator('.flg-status')).toHaveText('Pending');
  await expect(row(page, 'f1').locator('.flg-asked')).toHaveText('Asked to correct: Name');
  await expect(row(page, 'f1').locator('.flg-waiting')).toHaveText('Waiting for: Name');
  await expect(row(page, 'f1')).toContainText('by Desk A');
  await expect(row(page, 'f1').locator('.flg-again')).toHaveCount(0);

  // replied: the actual modification, field by field, before and after
  await expect(row(page, 'f2').locator('.flg-status')).toHaveText('Replied');
  await expect(row(page, 'f2').locator('.flg-change[data-field="name"] .flg-before')).toHaveText('Amal R');
  await expect(row(page, 'f2').locator('.flg-change[data-field="name"] .flg-after')).toHaveText('Amal Al Rashid');
  await expect(row(page, 'f2').locator('.flg-change[data-field="height"] .flg-before')).toHaveText('170 cm');
  await expect(row(page, 'f2').locator('.flg-change[data-field="height"] .flg-after')).toHaveText('181 cm');
  await expect(row(page, 'f2').locator('.flg-waiting')).toHaveCount(0);
  await expect(row(page, 'f2').locator('.flg-again')).toHaveText('Flag again');

  await expect(row(page, 'f3').locator('.flg-status')).toHaveText('Withdrawn');
  await expect(row(page, 'f3').locator('.flg-again')).toHaveCount(1);

  await page.locator('.filter-pill', { hasText: 'Pending (1)' }).click();
  await expect(page.locator('.flg-row')).toHaveCount(1);
  await expect(page.locator('.flg-row')).toHaveAttribute('data-flag-id', 'f1');
});

test('Flag again reopens the dialog with the same fields and asks through staff_flag_customer', async ({ page }) => {
  await flaggedTab(page);
  const calls: Record<string, unknown>[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /rpc\/staff_flag_customer/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });
  const reloads: string[] = [];
  page.on('request', r => { if (r.method() === 'GET' && /rest\/v1\/customer_flags/.test(r.url())) reloads.push(r.url()); });

  await row(page, 'f2').locator('.flg-again').click();
  const dlg = page.locator('#confirm-modal .fl-box');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.fl-row[data-flag="name"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(dlg.locator('.fl-row[data-flag="height"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(dlg.locator('.fl-row[data-flag="email"]')).toHaveAttribute('aria-pressed', 'false');
  await page.click('#fl-send');
  await expect(dlg).toBeHidden();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ p_customer_id: 'c1', p_fields: ['name', 'height'], p_by: 'Spec Staff' });
  await expect.poll(() => reloads.length).toBeGreaterThan(0);          // the list comes back with the new request
});

// ── the name rule ─────────────────────────────────────────────────────────────
test('a name may hold letters of any script, spaces and periods - nothing else, not even a dash', async ({ page }) => {
  await stubSupabase(page, {});
  await page.goto('/');
  await waitForSb(page);
  const ok = ['Malik Anas', 'Anne Marie', 'Al Harbi', 'محمد عبد الرحمن', 'مُحَمَّد', 'अमित कुमार', 'सुनिल श्रेष्ठ', 'রবীন্দ্রনাথ ঠাকুর', 'عمران خان', 'José Müller', 'Mohd. Ali', 'Md.Rahman'];
  const bad = ['Malik 2', 'محمد ٣', 'अमित ५', 'রবি ৭', "O'Brien", '.Ali', 'Ali .Omar', 'Md.. Ali', 'ali@x', 'Malik 😀', 'Sara ❤', 'a_b', 'علي، محمد', 'Anne-Marie', 'Al–Harbi'];
  expect(await page.evaluate(`${JSON.stringify(ok)}.map(n=>_nameCharsOk(n))`)).toEqual(ok.map(() => true));
  expect(await page.evaluate(`${JSON.stringify(bad)}.map(n=>_nameCharsOk(n))`)).toEqual(bad.map(() => false));
  expect(await page.evaluate(`_isNameCharsErr({message:'name_chars'})`)).toBe(true);
  // where a name is cleaned rather than filtered as typed (the walk-in box also searches by phone)
  expect(await page.evaluate(`['Al-Harbi','Kerry–Ann  Stander','Soso —','Malik 2'].map(_nameClean)`)).toEqual(['Al Harbi', 'Kerry Ann Stander', 'Soso', 'Malik']);
});

test('sign-up: signs are dropped as they are typed, and a name that still carries one never leaves', async ({ page }) => {
  const calls: unknown[] = [];
  await stubSupabase(page, {});
  await page.route(/\/rest\/v1\/rpc\/customer_signup/, async r => { calls.push(r.request().postDataJSON()); await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' }); });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('openAuthModal()');
  await page.evaluate('switchAuthMode("signup")');
  await page.fill('#a-first', "Mal1k😀-Ann'e");
  await expect(page.locator('#a-first')).toHaveValue('Malk Anne');                     // digit, emoji and apostrophe gone; the dash is a space
  await expect(page.locator('.toast').last()).toContainText('letters, spaces and periods');
  await page.fill('#a-last', 'Babalghoum');
  await page.evaluate('setSignupGender("male")');
  await page.fill('#a-email', 'faisal@example.com');
  await page.fill('#a-phone', '0508566560');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.fill('#a-pwd2', 'Zq8xTselah');
  await page.fill('#a-height', '175');
  // a value that arrives without typing (autofill, a script) is still judged at submit
  await page.evaluate(`document.getElementById('a-last').value='Babalghoum 2'`);
  await page.evaluate('S.signupAck=true;doSignup()');
  await expect(page.locator('#auth-err')).toContainText('Names can only contain letters, spaces and periods.');
  expect(calls).toHaveLength(0);
});

test('sign-up: the server refusing the name reads as the same message', async ({ page }) => {
  await stubSupabase(page, {});
  await page.route(/\/rest\/v1\/rpc\/customer_signup/, r => r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: '22023', message: 'name_chars', hint: 'A name may contain letters, spaces and periods only.' }) }));
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('openAuthModal()');
  await page.evaluate('switchAuthMode("signup")');
  await page.fill('#a-first', 'Faisal');
  await page.fill('#a-last', 'Babalghoum');
  await page.evaluate('setSignupGender("male")');
  await page.fill('#a-email', 'faisal@example.com');
  await page.fill('#a-phone', '0508566560');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.fill('#a-pwd2', 'Zq8xTselah');
  await page.fill('#a-height', '175');
  await page.evaluate('S.signupAck=true;doSignup()');
  await expect(page.locator('#auth-err')).toContainText('Names can only contain letters, spaces and periods.');
});

test('My Account: an existing name is not re-judged, a new one is', async ({ page }) => {
  const saves: Record<string, unknown>[] = [];
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Malik 2 Anas', email: 'spec@example.com', phone: '0500000001' }] });
  await page.route(/\/rest\/v1\/rpc\/customer_update_profile/, async r => { saves.push(r.request().postDataJSON()); await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: 'true' }); });
  await loginCustomer(page, { id: 'c1', name: 'Malik 2 Anas', session_token: 'tok' });   // one of the older names the rule would refuse
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-first')).toBeVisible();
  // unchanged: saves as it is
  await page.evaluate('saveAccount()');
  await expect.poll(() => saves.length).toBe(1);
  // changed to something with a digit: refused here, before the server
  await page.evaluate(`document.getElementById('acc-first').value='Malik3'`);
  await page.evaluate('saveAccount()');
  await expect(page.locator('#acc-err')).toHaveText('Names can only contain letters, spaces and periods.');
  expect(saves).toHaveLength(1);
});

test('a name from Google or Apple arrives with its dashes turned into spaces', async ({ page }) => {
  await stubSupabase(page, {});
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S._pendingGoogle={email:'k@x.com',name:'Kerry-Ann Al–Stander'};openGoogleComplete()`);
  const both = await page.evaluate(`[document.getElementById('a-first').value, document.getElementById('a-last').value].join(' ')`) as string;
  expect(both).not.toMatch(/[-–—]/);
  expect(both.replace(/\s+/g, ' ')).toBe('Kerry Ann Al Stander');
});
