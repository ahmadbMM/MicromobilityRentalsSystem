import { test, expect } from '@playwright/test';

/** The birth date is three selects (day, month, year) over a hidden YYYY-MM-DD input. */
async function pickBirth(page: import('@playwright/test').Page, id: string, iso: string) {
  const [y, m, d] = iso.split('-');
  await page.selectOption(`#${id}-y`, y);
  await page.selectOption(`#${id}-m`, String(+m));
  await page.selectOption(`#${id}-d`, String(+d));
}
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// After a rider's eighth booking, picking an event brings one page before the session list:
// birth date and nationality, both required. Every booking counts except a cancelled one -
// upcoming and waitlisted included; a complete profile never sees it; it never says why.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }];
const past = (i: number) => `2026-0${1 + (i % 8)}-1${i % 9}`;
const row = (i: number, status: string) => ({
  id: 'b' + i, customer_id: 'c1', session_id: past(i), session_day: 'Tuesday', session_date: past(i), queue_num: i + 1,
  name: 'Spec Rider', phone: '0500000001', type_preference: 'Road', size: 'M', status, paid: status !== 'noshow',
  price: 75, registered_at: past(i) + 'T10:00:00Z',
});
const eight = [0, 1, 2, 3].map(i => row(i, 'done')).concat([row(4, 'noshow'), row(5, 'active'), row(6, 'waiting'), row(7, 'waitlist')]); // upcoming and waitlisted count too

async function boot(page: import('@playwright/test').Page, bookings: Record<string, unknown>[], profile: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions, queue_entries: bookings, 'rpc:my_bookings': bookings,   // the direct read (tests) and the secure RPC (production) both carry the account's rows
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', ...profile }],
    'rpc:customer_update_profile': true, ...extra,
  });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
}

// Every page that asks for details opens at sign-in and whenever the site opens on the account, not
// at the next event pick, and nothing but saving (or Log out) takes it away (the owner, 2026-09-30:
// "force them with no way to escape it from when they sign in directly ... not when they try to book").
test('eight bookings and a bare profile: the page opens when the site opens, and Escape or moving about leaves it up', async ({ page }) => {
  await boot(page, eight, { nationality: null, birth_date: null });
  const box = page.locator('#profile-gate .pg-box');
  await expect(box).toBeVisible();                                    // no event picked
  await page.keyboard.press('Escape');
  await expect(box).toBeVisible();
  await page.evaluate(`goCustomer('myrides')`);
  await expect(box).toBeVisible();
  await page.evaluate(`goLanding()`);
  await expect(box).toBeVisible();
  await expect(box.locator('button', { hasText: /not now|later|skip|close/i })).toHaveCount(0);
  await pickBirth(page, 'pg-birth', '1996-03-14');
  await page.selectOption('#pg-nat', 'Egypt');
  await page.click('#pg-save');
  await expect(box).toBeHidden();
});

test('what staff asked to correct opens when the site opens, then the profile page if it is due too', async ({ page }) => {
  await boot(page, eight, { nationality: null, birth_date: null, phone: '0500000001' }, { 'rpc:customer_fix_fields': ['phone'], 'rpc:customer_fix_save': [] });
  const fix = page.locator('#fix-gate .fx-box');
  await expect(fix).toBeVisible();                                    // no event picked
  await page.keyboard.press('Escape');
  await expect(fix).toBeVisible();
  await page.fill('#fx-phone', '0551234567');
  await page.click('#fx-save');
  await expect(fix).toBeHidden();
  await expect(page.locator('#profile-gate .pg-box')).toBeVisible();  // the eighth-booking page follows
});

test('eight bookings and a bare profile: the gate takes the event pick, saves both, then continues', async ({ page }) => {
  await boot(page, eight, { nationality: null, birth_date: null });
  const calls: string[] = [];
  page.on('request', r => { if (/rpc\/customer_update_profile/.test(r.url())) calls.push(r.postData() || ''); });
  await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
  const box = page.locator('#profile-gate .pg-box');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Two details to finish your profile');
  // the page never says why (the day/year selects hold every number, so read the prose only)
  expect(await box.evaluate(el => { const c = el.cloneNode(true) as HTMLElement; c.querySelectorAll('select').forEach(s => s.remove()); return c.textContent || ''; })).not.toMatch(/\b8\b|eight/i);
  expect(await page.evaluate('S.selEvent')).toBe('none');               // the event did not open
  await expect(page.locator('#app-footer')).toBeHidden();
  await expect(page.locator('#pg-save')).toBeDisabled();

  await pickBirth(page, 'pg-birth', '1996-03-14');
  await expect(page.locator('#pg-save')).toBeDisabled();             // one of two
  await page.selectOption('#pg-nat', 'Egypt');
  await expect(page.locator('#pg-save')).toBeEnabled();
  await page.click('#pg-save');
  await expect(box).toBeHidden();
  expect(calls).toHaveLength(1);
  const body = JSON.parse(calls[0]);
  expect(body.p_birth_date).toBe('1996-03-14');
  expect(body.p_nationality).toBe('Egypt');
  expect(body.p_name).toBe('Spec Rider');                            // the rest of the profile carried through
  expect(await page.evaluate('[S.selEvent,S.loggedIn.nationality,S.loggedIn.birth_date]')).toEqual(['jcc', 'Egypt', '1996-03-14']);
  // The gate hides the footer while it is up; afterwards the page is whole again. The footer
  // itself only exists on a desk screen, so check it where it exists.
  expect(await page.evaluate(`document.body.classList.contains('gate-page')`)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('#app-footer')).toBeVisible();
});

test('seven bookings: no gate', async ({ page }) => {
  await boot(page, eight.slice(0, 7), { nationality: null, birth_date: null });
  await page.evaluate(`selectEvent('jcc')`);
  await expect(page.locator('#profile-gate')).toBeHidden();
  expect(await page.evaluate('S.selEvent')).toBe('jcc');
});

test('cancelled bookings do not count', async ({ page }) => {
  await boot(page, eight.slice(0, 6).concat([row(6, 'cancelled'), row(7, 'cancelled')]), { nationality: null, birth_date: null });
  await page.evaluate(`selectEvent('jcc')`);
  await expect(page.locator('#profile-gate')).toBeHidden();
  expect(await page.evaluate('S.selEvent')).toBe('jcc');
});

test('a complete profile never sees it', async ({ page }) => {
  await boot(page, eight, { nationality: 'Jordan', birth_date: '1990-01-01' });
  await page.evaluate(`selectEvent('jcc')`);
  await expect(page.locator('#profile-gate')).toBeHidden();
  expect(await page.evaluate('S.selEvent')).toBe('jcc');
});

test('a birth date that cannot be right is refused before anything is sent', async ({ page }) => {
  await boot(page, eight, { nationality: null, birth_date: null });
  const calls: string[] = [];
  page.on('request', r => { if (/rpc\/customer_update_profile/.test(r.url())) calls.push(r.url()); });
  await page.evaluate(`selectEvent('jcc')`);
  // The chooser cannot even offer a future year; a stale device value still gets refused.
  expect(await page.evaluate(`[...document.querySelectorAll('#pg-birth-y option')].some(o=>o.value==='2099')`)).toBe(false);
  await page.evaluate(`_pgBirth('2099-01-01')`);
  await page.selectOption('#pg-nat', 'Egypt');
  await page.evaluate(`_pgSave()`);
  await expect(page.locator('#profile-gate .pg-msg')).toHaveText("A birth date can't be in the future.");
  // Four years old today is refused too; the rider has to be five.
  const four = await page.evaluate(`(()=>{const p=todayStr().split('-');return (p[0]-4)+'-'+p[1]+'-'+p[2];})()`) as string;
  await page.evaluate(`_pgBirth('${four}')`);
  await page.evaluate(`_pgSave()`);
  await expect(page.locator('#profile-gate .pg-msg')).toHaveText('Riders must be at least 5 years old. Check the birth date.');
  expect(calls).toHaveLength(0);
  await pickBirth(page, 'pg-birth', '1996-03-14');                   // picking clears the error
  await expect(page.locator('#profile-gate .pg-msg')).toHaveCount(0);
});

test('a failed save keeps the values and says so', async ({ page }) => {
  await boot(page, eight, { nationality: null, birth_date: null }, { 'rpc:customer_update_profile': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
  await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
  await pickBirth(page, 'pg-birth', '1996-03-14');
  await page.selectOption('#pg-nat', 'Egypt');
  await page.click('#pg-save');
  // a refusal (not the network) is said as one since 2026-10-05; the connection message is for the network
  await expect(page.locator('#profile-gate .pg-net')).toContainText(/That didn.t work/);
  await expect(page.locator('#pg-birth')).toHaveValue('1996-03-14');
  await expect(page.locator('#pg-nat')).toHaveValue('Egypt');
  await expect(page.locator('#pg-save')).toBeEnabled();
  expect(await page.evaluate('S.selEvent')).toBe('none');
});

test('the birth chooser: month names in the rider\'s language, and the day list follows the month', async ({ page }) => {
  await boot(page, eight, { nationality: null, birth_date: null });
  await page.evaluate(`selectEvent('jcc')`);
  const months = await page.evaluate(`[...document.querySelectorAll('#pg-birth-m option')].map(o=>o.textContent)`) as string[];
  expect(months.slice(1)).toEqual(['January','February','March','April','May','June','July','August','September','October','November','December']);
  await page.selectOption('#pg-birth-y', '1996');
  await page.selectOption('#pg-birth-m', '1');
  await page.selectOption('#pg-birth-d', '31');
  await expect(page.locator('#pg-birth')).toHaveValue('1996-01-31');
  await page.selectOption('#pg-birth-m', '2');                     // February 1996 has 29 days
  expect(await page.evaluate(`document.querySelectorAll('#pg-birth-d option').length - 1`)).toBe(29);
  await expect(page.locator('#pg-birth')).toHaveValue('1996-02-29'); // the 31st was clamped, not dropped
  await page.evaluate(`setLang('ar')`);
  const ar = await page.evaluate(`document.querySelector('#pg-birth-m option[value="1"]').textContent`);
  expect(ar).toBe('يناير');
});

// The save writes the whole profile, so everything but the two answers must be what the account
// holds NOW. This device's sign-in copy still says 'Spec Rider' / 0500000001; staff have since
// corrected the account, and the gate must not write the old copy back over their fix.
test('the save carries the account as it is now, not the copy kept at sign-in', async ({ page }) => {
  await boot(page, eight, { nationality: null, birth_date: null, name: 'Spec Rider Corrected', phone: '+966500000009', email: 'fixed@example.com', country: 'SA', city: 'Jeddah', height: 181 });
  const calls: string[] = [];
  page.on('request', r => { if (/rpc\/customer_update_profile/.test(r.url())) calls.push(r.postData() || ''); });
  await page.evaluate(`selectEvent('jcc')`);
  await pickBirth(page, 'pg-birth', '1996-03-14');
  await page.selectOption('#pg-nat', 'Egypt');
  await page.click('#pg-save');
  await expect(page.locator('#profile-gate .pg-box')).toBeHidden();
  const body = JSON.parse(calls[0]);
  expect([body.p_name, body.p_phone, body.p_email, body.p_country, body.p_city, body.p_height])
    .toEqual(['Spec Rider Corrected', '+966500000009', 'fixed@example.com', 'SA', 'Jeddah', 181]);
  expect(await page.evaluate('[S.loggedIn.name,S.loggedIn.phone]')).toEqual(['Spec Rider Corrected', '+966500000009']); // the device's copy catches up too
});

test('no fresh read, no save: the old copy is never written back', async ({ page }) => {
  await boot(page, eight, { nationality: null, birth_date: null });
  let failReads = false;
  // The gate's own first look succeeds; the read the save makes fails.
  await page.route(/\/rest\/v1\/rpc\/customer_profile/, async (route) => {
    if (!failReads) return route.fallback();
    await route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '', message: 'unavailable' }) });
  });
  const calls: string[] = [];
  page.on('request', r => { if (/rpc\/customer_update_profile/.test(r.url())) calls.push(r.url()); });
  await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
  await pickBirth(page, 'pg-birth', '1996-03-14');
  await page.selectOption('#pg-nat', 'Egypt');
  failReads = true;
  await page.click('#pg-save');
  await expect(page.locator('#profile-gate .pg-net')).toBeVisible();
  expect(calls).toHaveLength(0);
  expect(await page.evaluate('S.selEvent')).toBe('none');
});

// customer_set_birth_nat (migration 20260922150000) writes the gate's two answers and nothing
// else, so nothing is read first and nothing else on the account can be written back stale.
// The specs above run without it (the stub answers it as missing): the whole-profile save.
test.describe('with customer_set_birth_nat on the server', () => {
  const watch = (page: import('@playwright/test').Page) => {
    const calls: { name: string; body: string }[] = [];
    page.on('request', (r) => { const m = r.url().match(/\/rpc\/(customer_set_birth_nat|customer_update_profile|customer_profile)/); if (m) calls.push({ name: m[1], body: r.postData() || '' }); });
    return calls;
  };

  test('the two answers are all that is written', async ({ page }) => {
    await boot(page, eight, { nationality: null, birth_date: null }, { 'rpc:customer_set_birth_nat': true });
    await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
    await expect(page.locator('#profile-gate .pg-box')).toBeVisible();
    await pickBirth(page, 'pg-birth', '1996-03-14');
    await page.selectOption('#pg-nat', 'Egypt');
    const calls = watch(page);
    await page.click('#pg-save');
    await expect(page.locator('#profile-gate .pg-box')).toBeHidden();
    // The booking then starts and reads the rider's perks once (_perksHydrate): a read, not a write.
    expect(calls.filter((c) => c.name !== 'customer_profile').map((c) => c.name)).toEqual(['customer_set_birth_nat']);
    expect(JSON.parse(calls[0].body)).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_birth_date: '1996-03-14', p_nationality: 'Egypt' });
    expect(await page.evaluate('[S.selEvent,S.loggedIn.nationality,S.loggedIn.birth_date]')).toEqual(['jcc', 'Egypt', '1996-03-14']);
  });

  // false is the server not knowing the sign-in (customer_set_birth_nat's token check): since
  // 2026-10-05 the rider is signed out with the session-expired message rather than asked to check
  // a connection that is fine, for ever.
  test('a save the server answers as signed out ends the session and is not retried as a whole-profile save', async ({ page }) => {
    await boot(page, eight, { nationality: null, birth_date: null }, { 'rpc:customer_set_birth_nat': false });
    await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
    await pickBirth(page, 'pg-birth', '1996-03-14');
    await page.selectOption('#pg-nat', 'Egypt');
    const calls = watch(page);
    await page.click('#pg-save');
    await expect.poll(() => page.evaluate('S.loggedIn')).toBeNull();
    await expect(page.locator('#profile-gate .pg-box')).toHaveCount(0);
    expect(calls.map((c) => c.name)).toEqual(['customer_set_birth_nat']);
  });

  test('a server error is said, not a fall back', async ({ page }) => {
    await boot(page, eight, { nationality: null, birth_date: null }, { 'rpc:customer_set_birth_nat': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
    await pickBirth(page, 'pg-birth', '1996-03-14');
    await page.selectOption('#pg-nat', 'Egypt');
    const calls = watch(page);
    await page.click('#pg-save');
    await expect(page.locator('#profile-gate .pg-net')).toBeVisible();
    expect(calls.map((c) => c.name)).toEqual(['customer_set_birth_nat']);
  });

  test('a database without it: tried once, then the fresh read and the whole-profile save', async ({ page }) => {
    await boot(page, eight, { nationality: null, birth_date: null });
    await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
    await pickBirth(page, 'pg-birth', '1996-03-14');
    await page.selectOption('#pg-nat', 'Egypt');
    const calls = watch(page);
    await page.click('#pg-save');
    await expect(page.locator('#profile-gate .pg-box')).toBeHidden();
    // ...and after the save, the booking's own read of the rider's perks (_perksHydrate).
    expect(calls.map((c) => c.name).slice(0, 3)).toEqual(['customer_set_birth_nat', 'customer_profile', 'customer_update_profile']);
    expect(calls.slice(3).every((c) => c.name === 'customer_profile')).toBe(true);
  });
});
