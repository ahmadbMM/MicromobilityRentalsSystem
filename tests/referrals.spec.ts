import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Referrals (the owner, 2026-11-08, migration 20261108160000): a rider shares their own link or code; a friend who makes
// an account with it and completes a paid JCC ride earns the rider one free ride, a personal RF- code that shows with the
// other free rides (event picker, Redeem on the bike step). The database decides who may be referred and gives the free
// ride; these specs cover what the page shows and sends.

type Call = { name: string; body: Record<string, unknown> };
const rpcs = (page: Page) => {
  const calls: Call[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); } });
  return calls;
};
const jcc = { id: 's0', day: 'Sunday', session_date: '2099-02-08', capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null };
const sat = { id: 's1', day: 'Saturday', session_date: '2099-02-07', capacity: 9, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', location: 'JCC' };
const RF = { code: 'RF-1A2B3C4D', expires_at: '2099-12-05', used: false };
const card = (x: Record<string, unknown> = {}) => ({ ok: true, on: true, code: 'K7MQ2X', days: 60, cap: 10, joined: 3, rode: 1, earned: 1, referred: false, can_enter: false, rewards: [], ...x });

async function rider(page: Page, fx: Record<string, unknown> = {}, path = '/') {
  await stubSupabase(page, { sessions: [jcc, sat], ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto(path);
  await waitForSb(page);
}
const account = (page: Page) => page.evaluate(`showView('customer');setCustTab('account')`);

test.describe('@customer:account referrals', () => {
  test('the Invite friends card: the code, the counts, a free ride waiting, and the link it shares', async ({ page }) => {
    const calls = rpcs(page);
    await rider(page, { 'rpc:customer_referral': card({ rewards: [RF, { code: 'RF-USED0001', expires_at: '2099-12-05', used: true }] }) });
    await account(page);
    const box = page.locator('#ref-mine');
    await expect(box).toBeVisible();
    await expect(box.locator('.ref-code strong')).toHaveText('K7MQ2X');
    await expect(box.locator('.ref-stats dd')).toHaveText(['3', '1', '1']);
    await expect(box.locator('.ref-has')).toContainText('Free rides waiting for you: 1');
    await expect(box.locator('.ref-enter')).toHaveCount(0);
    expect(calls.find((c) => c.name === 'customer_referral')!.body).toMatchObject({ p_id: 'c1' });
    // The event picker only reads (p_make false); a card whose account has no code yet asks for one to be made.
    await page.evaluate(`S._refMine={...S._refMine,code:null,at:Date.now()};_refLoad(S.loggedIn||getSession(),true)`);
    await expect.poll(() => calls.some((c) => c.name === 'customer_referral' && c.body.p_make === true)).toBe(true);
    const link = await page.evaluate(`_refLink('K7MQ2X')`) as string;
    expect(new URL(link).pathname).toBe('/signup');
    expect(new URL(link).searchParams.get('ref')).toBe('K7MQ2X');
    expect(await page.evaluate(`t('refMsg')`)).toContain('{0}');
  });

  test('no card while referrals are off, or before the database has them', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': card({ on: false }) });
    await account(page);
    await expect.poll(() => page.evaluate('!!(S._refMine&&S._refMine.on===false)')).toBe(true);
    await expect(page.locator('#ref-mine')).toBeHidden();
  });

  test('a database without customer_referral draws nothing and stops asking', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_referral in the schema cache' } } });
    await account(page);
    await expect.poll(() => page.evaluate('S._refOff===true')).toBe(true);
    await expect(page.locator('#ref-mine')).toBeHidden();
  });

  test('a new account types a friend\'s code; a refusal is said on the card', async ({ page }) => {
    const calls = rpcs(page);
    await rider(page, { 'rpc:customer_referral': card({ can_enter: true, joined: 0, rode: 0, earned: 0 }), 'rpc:customer_set_referrer': { ok: false, reason: 'self' } });
    await account(page);
    const box = page.locator('#ref-mine');
    await box.locator('#ref-in').fill('k7mq2x');
    await box.getByRole('button', { name: 'Apply' }).click();
    await expect(box.locator('#ref-in-msg')).toContainText('your own');
    expect(calls.find((c) => c.name === 'customer_set_referrer')!.body).toEqual({ p_id: 'c1', p_token: expect.any(String), p_code: 'k7mq2x', p_via: 'code' });
  });

  test('a code that takes: thanked, and the card asked again', async ({ page }) => {
    const calls = rpcs(page);
    await rider(page, { 'rpc:customer_referral': card({ can_enter: true }), 'rpc:customer_set_referrer': { ok: true } });
    await account(page);
    await page.locator('#ref-in').fill('K7MQ2X');
    await page.locator('#ref-mine').getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('#toast-container')).toContainText('Your friend gets a free ride');
    await expect.poll(() => calls.filter((c) => c.name === 'customer_referral').length).toBeGreaterThan(1);
  });
});

for (const lang of ['en', 'ar']) test(`@customer:account the Invite friends card fits a 320px phone (${lang})`, async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'a phone');
  await page.setViewportSize({ width: 320, height: 760 });
  await page.addInitScript((l) => { localStorage.setItem('cq_lang', l); localStorage.setItem('cq_lang_pick', '1'); }, lang);
  await rider(page, { 'rpc:customer_referral': card({ can_enter: true, joined: 12, rode: 10, earned: 10, rewards: [RF] }) });
  await account(page);
  await expect(page.locator('#ref-mine #ref-in')).toBeVisible();
  // as tests/cust-fit.spec.ts: nothing wider than the screen, no text field under 16px, no button under 48px
  const r = await page.evaluate(() => {
    const box = document.getElementById('ref-mine')!, W = document.documentElement.clientWidth;
    const inputs = [...box.querySelectorAll('input')].filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id);
    const btns = [...box.querySelectorAll('button')].map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h < 48);
    const out = [...box.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.right > W + 1 || b.left < -1; }).map((e) => e.className || e.tagName);
    return { wide: document.documentElement.scrollWidth - W, inputs, btns, out };
  });
  expect(r).toEqual({ wide: 0, inputs: [], btns: [], out: [] });
});

test.describe('@customer:signup referral links', () => {
  test('?ref= is kept on the device, leaves the address, and the Create account page says a friend invited them', async ({ page }) => {
    await stubSupabase(page, { sessions: [jcc] });
    await page.goto('/signup?ref=k7-mq2x');
    await waitForSb(page);
    expect(new URL(page.url()).searchParams.has('ref')).toBe(false);
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_ref')).c`)).toBe('K7MQ2X');
    await page.evaluate(`S.authMode='signup';renderAuthModal()`);
    await expect(page.locator('.auth-note').filter({ hasText: 'A friend invited you' })).toBeVisible();
  });

  test('a signed-in new account sends the parked link once, and the link is spent', async ({ page }) => {
    const calls = rpcs(page);
    await page.addInitScript(() => { try { localStorage.setItem('cq_ref', JSON.stringify({ c: 'K7MQ2X', t: Date.now() })); } catch { /* none */ } });
    await rider(page, { 'rpc:customer_referral': card({ can_enter: true }), 'rpc:customer_set_referrer': { ok: true } });
    await account(page);
    await expect.poll(() => calls.filter((c) => c.name === 'customer_set_referrer').length).toBe(1);
    expect(calls.find((c) => c.name === 'customer_set_referrer')!.body).toMatchObject({ p_id: 'c1', p_code: 'K7MQ2X', p_via: 'link' });
    await expect.poll(() => page.evaluate(`localStorage.getItem('cq_ref')`)).toBeNull();
  });

  test('an account that cannot be referred drops the parked link without sending it', async ({ page }) => {
    const calls = rpcs(page);
    await page.addInitScript(() => { try { localStorage.setItem('cq_ref', JSON.stringify({ c: 'K7MQ2X', t: Date.now() })); } catch { /* none */ } });
    await rider(page, { 'rpc:customer_referral': card({ can_enter: false }) });
    await account(page);
    await expect.poll(() => page.evaluate(`localStorage.getItem('cq_ref')`)).toBeNull();
    expect(calls.filter((c) => c.name === 'customer_set_referrer')).toHaveLength(0);
  });

  test('a link older than 30 days is not used', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('cq_ref', JSON.stringify({ c: 'K7MQ2X', t: Date.now() - 31 * 864e5 })); } catch { /* none */ } });
    await stubSupabase(page, { sessions: [jcc] });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate('_refParked()')).toBe('');
  });
});

test.describe('@customer:reserve referral free rides', () => {
  const ok = { ok: true, code: 'RF-1A2B3C4D', kind: 'percent', value: 100, applies_to: null, session_id: null, ride_kind: 'jcc' };
  test('shown on the event picker beside the other free rides, redeemed on a JCC ride for rider 1 only', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': card({ rewards: [RF] }), 'rpc:customer_blood_rewards': [], 'rpc:promo_lookup': ok });
    await page.evaluate('showView("landing");renderLandingAvail()');
    const land = page.locator('#land-free-rides .fr-card');
    await expect(land).toHaveCount(1);
    await expect(land).toContainText('RF-1A2B3C4D');
    expect(await page.evaluate(`[_refCodeSessOk(_sessDisp('s0')),_refCodeSessOk(_sessDisp('s1'))]`)).toEqual([true, false]);
    await page.evaluate(`showView('customer');setCustTab('register');S.selEvent='jcc';S.selSession='s0';S.regStep=2;S.regQty=2;S.regBikeTypes=['Hybrid','Hybrid'];renderRegister()`);
    const box = page.locator('#bld-redeem .fr-card');
    await expect(box).toContainText('RF-1A2B3C4D');
    await box.locator('.fr-go').click();
    await expect.poll(() => page.evaluate('S.promoApplied&&S.promoApplied.one')).toBe(true);
  });

  test('not offered on a community ride, and Carbon is told why', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': card({ rewards: [RF] }), 'rpc:customer_blood_rewards': [] });
    await page.evaluate('showView("landing");renderLandingAvail()');
    await expect.poll(() => page.evaluate('_refRewards().length')).toBe(1);
    await page.evaluate(`showView('customer');setCustTab('register');S.selEvent='community';S.selSession='s1';S.regStep=2;S.regQty=1;S.regBikeTypes=['Hybrid'];renderRegister()`);
    await expect(page.locator('#bld-redeem .fr-card')).toHaveCount(0);
    await page.evaluate(`S.selEvent='jcc';S.selSession='s0';S.regBikeTypes=['Road Carbon'];renderRegister()`);
    const box = page.locator('#bld-redeem .fr-card');
    await expect(box).toContainText('Carbon');
    await expect(box.locator('.fr-go')).toHaveCount(0);
  });
});

test.describe('@staff:people referrals on the account window', () => {
  const customers = [
    { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', created_at: '2026-11-01T09:00:00Z' },
    { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', created_at: '2026-06-11T09:00:00Z' },
    { id: 'c3', name: 'Maya Nasser', email: 'maya.nasser@gmail.com', phone: '+966551876217', created_at: '2026-11-02T09:00:00Z' },
  ];
  async function staff(page: Page, fx: Record<string, unknown> = {}) {
    await stubSupabase(page, { sessions: [jcc], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [], ...fx });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length===3');
  }
  const referrals = [
    { friend_id: 'c1', referrer_id: 'c2', code: 'K7MQ2X', via: 'link', created_at: '2026-11-02T10:00:00Z', rode_at: '2026-11-03T20:00:00Z', reward_code: 'RF-1A2B3C4D', capped: false },
    { friend_id: 'c3', referrer_id: 'c2', code: 'K7MQ2X', via: 'code', created_at: '2026-11-04T10:00:00Z', rode_at: null, reward_code: null, capped: false },
  ];

  test('who referred the account, its free ride, and the friends the referrer brought', async ({ page }) => {
    await staff(page, { referrals, referral_codes: [{ customer_id: 'c2', code: 'K7MQ2X' }] });
    await page.evaluate(`openAccountHistory('c1')`);
    const sec = page.locator('#cust-modal .ref-ah');
    await expect(sec).toContainText('Referred by Omar Saleh');
    await expect(sec).toContainText('with their link');
    await expect(sec).toContainText('RF-1A2B3C4D');
    await expect(sec.getByRole('button', { name: 'Remove referral' })).toHaveCount(0); // the free ride was given
  });

  test('staff link a referrer by code or mobile, and remove one not yet rewarded', async ({ page }) => {
    const calls = rpcs(page);
    await staff(page, { referrals: [], referral_codes: [], 'rpc:staff_set_referrer': { ok: true, rewarded: false } });
    await page.evaluate(`openAccountHistory('c3')`);
    const sec = page.locator('#cust-modal .ref-ah');
    await expect(sec).toContainText('Not referred by anyone');
    await sec.getByRole('textbox', { name: 'Referrer’s code or mobile' }).fill('0551876216');
    await sec.getByRole('button', { name: 'Link' }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_set_referrer').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_set_referrer')!.body).toEqual({ p_friend: 'c3', p_ref: '0551876216' });
  });

  test('a refusal is said in words', async ({ page }) => {
    await staff(page, { referrals: [], referral_codes: [], 'rpc:staff_set_referrer': { ok: false, reason: 'many' } });
    await page.evaluate(`openAccountHistory('c3')`);
    const sec = page.locator('#cust-modal .ref-ah');
    await sec.getByRole('textbox', { name: 'Referrer’s code or mobile' }).fill('0551876216');
    await sec.getByRole('button', { name: 'Link' }).click();
    await expect(page.locator('#toast-container')).toContainText('More than one account has that mobile');
  });
});

test.describe('@staff:settings the Referrals card', () => {
  test('on unless switched off, with the database\'s own numbers as placeholders; off saves false', async ({ page }) => {
    const calls = rpcs(page);
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], staff_options: [], 'rpc:staff_set_biz': { ref_on: false } });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S._staffAuthed=true;setStaffTab('settings');setSettingsView('business')`);
    const c = page.locator('[data-biz-card="referral"]');
    await expect(c.locator('#biz-ref_on')).toBeChecked();
    await expect(c.locator('#biz-ref_days')).toHaveAttribute('placeholder', '60');
    await expect(c.locator('#biz-ref_cap')).toHaveAttribute('placeholder', '10');
    await c.locator('#biz-ref_on').uncheck();
    await c.locator('#biz-save-referral').click();
    await expect.poll(() => calls.filter((x) => x.name === 'staff_set_biz').length).toBe(1);
    expect(calls.find((x) => x.name === 'staff_set_biz')!.body).toEqual({ p_patch: { ref_on: false, ref_days: null, ref_cap: null } });
  });
});
