import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Nobody under five, and no birth date in the future. The chooser cannot offer one: the
// years stop five years back, and in that year the months and days still to come are greyed
// out. Every save checks again, which also catches a date stored before the rule.

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const [Y, M, D] = today().split('-').map(Number);
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const FIVE = iso(Y - 5, M, D);    // five today: the youngest allowed
const FOUR = iso(Y - 4, M, D);    // four today: refused
const YOUNG = 'Riders must be at least 5 years old. Check the birth date.';
const FUTURE = "A birth date can't be in the future.";

async function account(page: Page, birth_date: string | null = null) {
  const saves: Record<string, unknown>[] = [];
  // The account as the server holds it: My Account reads it before painting and before saving.
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Lina Haddad', email: 'spec@example.com', phone: '0500000001', birth_date }] });
  await page.route(/\/rest\/v1\/rpc\/customer_update_profile/, async r => {
    saves.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: 'true' });
  });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', session_token: 'tok', birth_date });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-birth-y')).toBeVisible();
  return saves;
}

test('the chooser stops five years back and greys out what is still to come in that year', async ({ page }) => {
  await account(page);
  const years = await page.evaluate(`[...document.querySelectorAll('#acc-birth-y option')].map(o=>o.value).filter(Boolean).map(Number)`) as number[];
  expect(Math.max(...years)).toBe(Y - 5);
  await page.selectOption('#acc-birth-y', String(Y - 5));
  const offMonths = await page.evaluate(`[...document.querySelectorAll('#acc-birth-m option:disabled')].map(o=>+o.value)`) as number[];
  expect(offMonths).toEqual(Array.from({ length: 12 - M }, (_, i) => M + 1 + i));
  await page.selectOption('#acc-birth-m', String(M));
  const dim = new Date(Y - 5, M, 0).getDate();
  const offDays = await page.evaluate(`[...document.querySelectorAll('#acc-birth-d option:disabled')].map(o=>+o.value)`) as number[];
  expect(offDays).toEqual(Array.from({ length: dim - D }, (_, i) => D + 1 + i));
  await page.selectOption('#acc-birth-d', String(D));
  await expect(page.locator('#acc-birth')).toHaveValue(FIVE);
});

// An iPhone on iOS 17.2 laid en-CA dates out as 10/27/2026: today read wrong, the year list came
// out empty and every date comparison went astray (2026-10-27). The app now counts Riyadh's day
// itself; this fakes that phone's layout for en-CA and sv-SE.
test('a phone that lays out en-CA dates as 10/27/2026 still gets the years, today and the save', async ({ page }) => {
  await page.addInitScript(() => {
    const us = (l?: string | string[]) => (l === 'en-CA' || l === 'sv-SE' ? 'en-US' : l);
    const Real = Intl.DateTimeFormat;
    const Fake = function (l?: string | string[], o?: Intl.DateTimeFormatOptions) { return new Real(us(l), o); };
    Object.assign(Fake, { supportedLocalesOf: Real.supportedLocalesOf, prototype: Real.prototype });
    Intl.DateTimeFormat = Fake as unknown as typeof Intl.DateTimeFormat;
    const day = Date.prototype.toLocaleDateString, full = Date.prototype.toLocaleString;
    Date.prototype.toLocaleDateString = function (this: Date, l?: string | string[], o?: Intl.DateTimeFormatOptions) { return day.call(this, us(l), o); };
    Date.prototype.toLocaleString = function (this: Date, l?: string | string[], o?: Intl.DateTimeFormatOptions) { return full.call(this, us(l), o); };
  });
  const saves = await account(page);
  expect(await page.evaluate(`new Date(2026,9,27,12).toLocaleDateString('en-CA')`)).toBe('10/27/2026');
  expect(await page.evaluate('todayStr()')).toBe(today());
  expect(await page.evaluate(`fmtDate(new Date('2026-10-27T21:30:00Z'))`)).toBe('2026-10-28');
  const years = await page.evaluate(`[...document.querySelectorAll('#acc-birth-y option')].map(o=>o.value).filter(Boolean).map(Number)`) as number[];
  expect(Math.max(...years)).toBe(Y - 5);
  await page.evaluate(`document.getElementById('acc-birth').value='${FIVE}';saveAccount()`);
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].p_birth_date).toBe(FIVE);
});

test('moving to the last year clears a month that year has not reached', async ({ page }) => {
  test.skip(M === 12, 'in December every month of the last year is already past');
  await account(page);
  await page.selectOption('#acc-birth-y', String(Y - 6));
  await page.selectOption('#acc-birth-m', '12');
  await page.selectOption('#acc-birth-d', '31');
  await expect(page.locator('#acc-birth')).toHaveValue(iso(Y - 6, 12, 31));
  await page.selectOption('#acc-birth-y', String(Y - 5));
  await expect(page.locator('#acc-birth-m')).toHaveValue('');
  await expect(page.locator('#acc-birth')).toHaveValue('');
});

test('My Account refuses a rider of four or a future date, and saves one of five', async ({ page }) => {
  const saves = await account(page);
  await page.evaluate(`document.getElementById('acc-birth').value='${FOUR}';saveAccount()`);
  await expect(page.locator('#acc-err')).toHaveText(YOUNG);
  await page.evaluate(`document.getElementById('acc-birth').value='${iso(Y + 1, 1, 1)}';saveAccount()`);
  await expect(page.locator('#acc-err')).toHaveText(FUTURE);
  expect(saves).toHaveLength(0);
  await page.evaluate(`document.getElementById('acc-birth').value='${FIVE}';saveAccount()`);
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].p_birth_date).toBe(FIVE);
});

test('a date stored before the rule shows as it is and has to be fixed before the next save', async ({ page }) => {
  const saves = await account(page, '2099-01-01');
  await expect(page.locator('#acc-birth-y')).toHaveValue('2099');
  await page.evaluate('saveAccount()');
  await expect(page.locator('#acc-err')).toHaveText(FUTURE);
  expect(saves).toHaveLength(0);
});

test('the staff account editor holds to the same rule', async ({ page }) => {
  const writes: string[] = [];
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags: [], customer_tags: [], customers: [
    { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', gender: 'female', height: 165, created_at: '2026-06-10T09:00:00Z' },
  ] });
  await unlockStaff(page);
  page.on('request', r => { if (/rest\/v1\/customers/.test(r.url()) && r.method() === 'PATCH') writes.push(r.url()); });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===1');
  await page.evaluate(`showEditCustomerModal('c1')`);
  await page.evaluate(`document.getElementById('cf-birth').value='${FOUR}';saveCustForm()`);
  await expect(page.locator('.toast')).toContainText(YOUNG);
  expect(writes).toHaveLength(0);
  await page.evaluate(`document.getElementById('cf-birth').value='${FIVE}';saveCustForm()`);
  await expect.poll(() => writes.length).toBe(1);
});

test('the rule itself: five today passes, a day younger does not, the future never does', async ({ page }) => {
  await account(page);
  const dayAfter = new Date(Date.UTC(Y - 5, M - 1, D + 1)).toISOString().slice(0, 10);
  expect(await page.evaluate(`[_dobErr(''),_dobErr('${FIVE}'),_dobErr('${dayAfter}'),_dobErr('${FOUR}'),_dobErr('2099-01-01'),_dobErr('1990-05-05')]`))
    .toEqual(['', '', YOUNG, YOUNG, FUTURE, '']);
});
