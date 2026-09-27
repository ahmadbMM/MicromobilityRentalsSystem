import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, waitForSb } from './helpers/supabase';

// A phone number belongs to the country picked beside it, whatever the number looks like.
// The mask used to cut every number to ten digits (an Egyptian 010…, a Pakistani 03… or a
// Chinese mobile lost its last digit), and the normaliser took any number starting with the
// country code's digits for one that already carried it (an Indian 91…, every Kazakh 7…).

async function signupForm(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, fixtures);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('openAuthModal();switchAuthMode("signup")');
}

async function captureRpc(page: Page, fn: string, result: unknown) {
  const calls: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}`), async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(result) });
  });
  return calls;
}

async function fillRest(page: Page) {
  await page.fill('#a-first', 'Faisal');
  await page.fill('#a-last', 'Babalghoum');
  await page.evaluate('setSignupGender("male");S.signupHeard="invited"');
  await page.fill('#a-email', 'faisal@example.com');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.fill('#a-pwd2', 'Zq8xTselah');
  await page.fill('#a-height', '175');
}

test('a national number that starts with its country code digits keeps the code', async ({ page }) => {
  await stubSupabase(page);
  await page.goto('/');
  const cases: [string, string, string][] = [
    ['9123456789', '+91', '+919123456789'],     // an Indian mobile that starts 91
    ['09123456789', '+91', '+919123456789'],
    ['919123456789', '+91', '+919123456789'],   // typed with the code: still one code
    ['9876543210', '+91', '+919876543210'],
    ['7011234567', '+7', '+77011234567'],       // every Kazakh mobile starts with 7
    ['77011234567', '+7', '+77011234567'],
    ['963123456', '+963', '+963963123456'],     // Syrian 0963… typed without its 0
    ['3931234567', '+39', '+393931234567'],     // Italian 393…
    ['96512345678', '+965', '+96512345678'],    // Kuwait with its code
    ['96512345', '+965', '+96596512345'],       // …and a Kuwaiti number that starts 965
    ['966562989838', '+966', '+966562989838'],  // the Saudi forms are unchanged
    ['562989838', '+966', '+966562989838'],
  ];
  for (const [input, cc, expected] of cases) {
    expect(await page.evaluate(`_normPhone(${JSON.stringify(input)}, ${JSON.stringify(cc)})`), `${cc} ${input}`).toBe(expected);
  }
});

test('an eleven-digit number keeps every digit, and signs up under its own country', async ({ page }) => {
  await signupForm(page);
  const calls = await captureRpc(page, 'customer_signup', [{ session_token: 'tok-new' }]);
  await page.selectOption('#a-cc', '+20');
  await page.locator('#a-phone').pressSequentially('01012345678');
  await expect(page.locator('#a-phone')).toHaveValue('010 123 45678'); // the eighth… eleventh digit survives
  await fillRest(page);
  await page.evaluate('S.signupAck=true;doSignup()');
  await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
  expect(calls[0].p_phone).toBe('+201012345678');
});

test('an Indian mobile that starts 91 signs up with +91 in front', async ({ page }) => {
  await signupForm(page);
  const calls = await captureRpc(page, 'customer_signup', [{ session_token: 'tok-new' }]);
  await page.selectOption('#a-cc', '+91');
  await page.locator('#a-phone').pressSequentially('9123456789');
  await expect(page.locator('#a-phone')).toHaveValue('912 345 6789');
  await fillRest(page);
  await page.evaluate('S.signupAck=true;doSignup()');
  await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
  expect(calls[0].p_phone).toBe('+919123456789');
});

test('an autofilled international number moves the picker to its country', async ({ page }) => {
  await signupForm(page);
  await expect(page.locator('#a-cc')).toHaveValue('+966');
  await page.fill('#a-phone', '+20 101 234 5678');                 // what autofill types in one go
  await expect(page.locator('#a-cc')).toHaveValue('+20');
  await expect(page.locator('#a-phone')).toHaveValue('101 234 5678');
  // Typed by hand, the + waits until a code is recognised, then the picker follows.
  await page.fill('#a-phone', '');
  await page.selectOption('#a-cc', '+966');
  await page.locator('#a-phone').pressSequentially('+44');
  await expect(page.locator('#a-cc')).toHaveValue('+44');
  await page.locator('#a-phone').pressSequentially('7911123456');
  await expect(page.locator('#a-phone')).toHaveValue('791 112 3456');
  // A Saudi paste still reads the way riders know it.
  await page.selectOption('#a-cc', '+966');
  await page.fill('#a-phone', '+966 508 727 012');
  await expect(page.locator('#a-phone')).toHaveValue('050 872 7012');
});

test('a language switch keeps the country code the rider picked', async ({ page }) => {
  await signupForm(page);
  await page.selectOption('#a-cc', '+20');
  await page.fill('#a-phone', '01012345678');
  await page.evaluate(`setLang('ar')`);
  await expect(page.locator('#a-cc')).toHaveValue('+20');
  await expect(page.locator('#a-phone')).toHaveValue('010 123 45678');
});

test('phone login: a number that cannot be Saudi asks for its country code', async ({ page }) => {
  await stubSupabase(page, { 'rpc:customer_login': [] });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('openAuthModal()');
  const calls = await captureRpc(page, 'customer_login', []);
  await page.fill('#a-identifier', '01012345678');                 // an Egyptian number, typed the local way
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.evaluate('doLogin()');
  await expect(page.locator('#auth-err')).not.toBeEmpty();
  expect(await page.locator('#auth-err').textContent()).not.toContain('Incorrect credentials');
  expect(calls[0].p_identifier).toBe('+9661012345678');            // still tried as Saudi first
  // A Saudi mobile that finds nothing is a plain wrong login, as before.
  await page.fill('#a-identifier', '0508727012');
  await page.evaluate('doLogin()');
  await expect(page.locator('#auth-err')).toContainText('Incorrect credentials');
});
