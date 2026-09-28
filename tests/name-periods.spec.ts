import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, waitForSb } from './helpers/supabase';

// Names may hold periods (user rule, 2026-09-25): "Md. Rahman", "Mohd. Ali". A period comes right
// after a letter; one that would start the name or a word, or follow another period, is dropped
// as typed and refused by the database ('name_chars'). A period ends a word for the two-letter
// rule, so "A. Khan" and "J.R. Smith" are still initials.

const SHORT = 'Write each name in full: every name needs at least two letters.';
const CHARS = 'Names can only contain letters, spaces and periods.';

async function ready(page: Page) {
  await stubSupabase(page, {});
  await page.goto('/');
  await waitForSb(page);
}

test('the rule: a period after a letter stays, a stray one goes, and an initial with a period is still an initial', async ({ page }) => {
  await ready(page);
  expect(await page.evaluate(`['Md. Rahman','Mohd.Ali','.Ali Omar','Ali .Omar','Md.. Ali','Al-Harbi','Ali, Omar!','Sara Khan Jr.'].map(_nameClean)`)).toEqual(
    ['Md. Rahman', 'Mohd.Ali', 'Ali Omar', 'Ali Omar', 'Md. Ali', 'Al Harbi', 'Ali Omar', 'Sara Khan Jr.']);
  expect(await page.evaluate(`['Md.','Rahman','.Ali','Ali .Omar','Md..','Ali!','Ali-Omar'].map(v=>_nameCharsOk(v))`)).toEqual(
    [true, true, false, false, false, false, false]);
  expect(await page.evaluate(`['Md. Rahman','Mohd.Ali','Sara Khan Jr.','A. Rahman','J.R. Smith','Ahmed A.'].map(v=>_namePartsOk(v))`)).toEqual(
    [true, true, true, false, false, false]);
  expect(await page.evaluate(`['md. rahman','mohd.ali'].map(_titleCaseName)`)).toEqual(['Md. Rahman', 'Mohd.Ali']);
});

test('as typed: a period stays, a stray one goes without a word, a symbol still says why', async ({ page }) => {
  await ready(page);
  const typed = (v: string) => page.evaluate(`(()=>{
    const said=[],real=window.toast;window.toast=m=>said.push(m);_nameHintAt=0;
    const el=document.createElement('input');document.body.appendChild(el);el.value=${JSON.stringify(v)};
    _nameInput(el);const out={value:el.value,said};el.remove();window.toast=real;return out;})()`);
  expect(await typed('Md. Rahman')).toEqual({ value: 'Md. Rahman', said: [] });
  expect(await typed('Md..')).toEqual({ value: 'Md.', said: [] });
  expect(await typed('Md .')).toEqual({ value: 'Md ', said: [] });
  expect(await typed('.')).toEqual({ value: '', said: [] });
  expect(await typed('Md3')).toEqual({ value: 'Md', said: [CHARS] });
});

test('sign-up: "Md. Rahman" is sent as written; "A. Rahman" is an initial and never leaves the form', async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  await stubSupabase(page, {});
  await page.route(/\/rest\/v1\/rpc\/customer_signup/, async r => { sent.push(r.request().postDataJSON()); await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' }); });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('openAuthModal()');
  await page.evaluate('switchAuthMode("signup")');
  await page.fill('#a-first', 'A.');
  await page.fill('#a-last', 'Rahman');
  await page.evaluate('setSignupGender("male")');
  await page.fill('#a-email', 'rahman@example.com');
  await page.fill('#a-phone', '0508566560');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.fill('#a-pwd2', 'Zq8xTselah');
  await page.fill('#a-height', '175');
  await page.evaluate('S.signupAck=true;doSignup()');
  await expect(page.locator('#auth-err')).toContainText(SHORT);
  expect(sent).toHaveLength(0);
  await page.fill('#a-first', 'md.');
  await expect(page.locator('#a-first')).toHaveValue('md.');
  await page.evaluate('doSignup()');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].p_name).toBe('Md. Rahman');
});

test('the database refusing a name reads as the rule, periods included', async ({ page }) => {
  await stubSupabase(page, {});
  await page.route(/\/rest\/v1\/rpc\/customer_signup/, r => r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: '22023', message: 'name_chars', hint: 'A name may contain letters, spaces and periods only.' }) }));
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('openAuthModal()');
  await page.evaluate('switchAuthMode("signup")');
  await page.fill('#a-first', 'Mohd.');
  await page.fill('#a-last', 'Ali');
  await page.evaluate('setSignupGender("male")');
  await page.fill('#a-email', 'mohd@example.com');
  await page.fill('#a-phone', '0508566561');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.fill('#a-pwd2', 'Zq8xTselah');
  await page.fill('#a-height', '175');
  await page.evaluate('S.signupAck=true;doSignup()');
  await expect(page.locator('#auth-err')).toContainText(CHARS);
});
