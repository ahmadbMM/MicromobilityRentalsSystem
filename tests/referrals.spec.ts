import { readFileSync } from 'node:fs';
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

async function rider(page: Page, fx: Record<string, unknown> = {}, path = '/', seen = true) {
  // the free-ride pop-up shows a code once per device: the specs not about it have seen RF-1A2B3C4D already
  // and the Recruiter badge's own pop-up (BDG_CHEER) has been seen at every level
  if (seen) await page.addInitScript(() => { try { localStorage.setItem('cq_ref_seen_c1', JSON.stringify(['RF-1A2B3C4D'])); ['rec1', 'rec3', 'rec5', 'rec10'].forEach((k) => localStorage.setItem('cq_bdg_' + k + '_c1', '1')); } catch { /* none */ } });
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

  test('the card says how long the free ride lasts, as the database sets it (the user, 2026-11-08: 30 days)', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': card({ days: 30 }) });
    await account(page);
    const note = page.locator('#ref-mine .ref-note');
    await expect(note).toContainText('you get a free ride to use within 30 days.');
    await page.evaluate(`S._refMine={...S._refMine,days:45};_refPaint()`);
    await expect(note).toContainText('within 45 days.');
    for (const l of ['ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']) {
      const how = JSON.parse(readFileSync(`lang/${l}.json`, 'utf8')).refHow as string;
      expect(how, l).toContain('{0}'); expect(how, l).toContain('{1}');
    }
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
    const body = calls.find((c) => c.name === 'customer_set_referrer')!.body;
    expect(body).toMatchObject({ p_id: 'c1', p_token: expect.any(String), p_code: 'k7mq2x', p_via: 'code' });
    expect(String(body.p_device)).toMatch(/^[0-9a-f]{24}$/); // this browser's id, for the device check
  });

  test('a code that takes: thanked, and the card asked again', async ({ page }) => {
    const calls = rpcs(page);
    await rider(page, { 'rpc:customer_referral': card({ can_enter: true }), 'rpc:customer_set_referrer': { ok: true } });
    await account(page);
    await page.locator('#ref-in').fill('K7MQ2X');
    await page.locator('#ref-mine').getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('#toast-container')).toContainText('your friend gets a free ride');
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
    await expect(c.locator('#biz-ref_days')).toHaveAttribute('placeholder', '30');
    await expect(c.locator('#biz-ref_cap')).toHaveAttribute('placeholder', '10');
    await expect(c.locator('#biz-ref_pct')).toHaveAttribute('placeholder', '50'); // the friend's discount (20261108200000)
    await c.locator('#biz-ref_on').uncheck();
    await c.locator('#biz-save-referral').click();
    await expect.poll(() => calls.filter((x) => x.name === 'staff_set_biz').length).toBe(1);
    expect(calls.find((x) => x.name === 'staff_set_biz')!.body).toEqual({ p_patch: { ref_on: false, ref_pct: null, ref_days: null, ref_cap: null } });
  });
});

// The extras (the owner, 2026-11-08: "in more ideas do 2 3 6 8", migration 20261108180000): the free ride said once on the
// device and its last days on the card, the Recruiter badge and the fifth friend's bonus on any bike, the device check
// with its held referrals for staff, and the People > Referrals report.
const RB = { code: 'RB-9F8E7D6C', expires_at: '2099-12-05', used: false, bonus: true };
const inDays = (n: number) => new Date(Date.now() + 3 * 36e5 + n * 864e5).toISOString().slice(0, 10);

test.describe('@customer:account referral extras', () => {
  test('a free ride this device has not shown pops up once, then never again', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': card({ rewards: [RF] }), 'rpc:customer_blood_rewards': [] }, '/', false);
    await page.evaluate('showView("landing");renderLandingAvail()');
    const pop = page.locator('#confirm-modal');
    await expect(pop).toContainText('You earned a free ride');
    await expect(pop).toContainText('RF-1A2B3C4D');
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_ref_seen_c1'))`)).toEqual(['RF-1A2B3C4D']);
    await page.evaluate(`document.getElementById('confirm-modal').style.display='none';document.getElementById('confirm-modal').innerHTML='';S._refMine=null;_refLoad(S.loggedIn||getSession(),false,true)`);
    await expect.poll(() => page.evaluate('!!S._refMine')).toBe(true);
    await expect(page.locator('#confirm-modal .modal-backdrop')).toHaveCount(0);
  });

  test('a free ride in its last seven days says so on the event picker', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': card({ rewards: [{ ...RF, expires_at: inDays(3) }] }), 'rpc:customer_blood_rewards': [] });
    await page.evaluate('showView("landing");renderLandingAvail()');
    await expect(page.locator('#land-free-rides .fr-soon')).toHaveText('Ends in 3 days');
  });

  test('the bonus of the fifth friend is not offered for Carbon either (20261108200000: no referral code pays for Carbon)', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': card({ rewards: [RF, RB] }), 'rpc:customer_blood_rewards': [] });
    await page.evaluate('showView("landing");renderLandingAvail()');
    await expect.poll(() => page.evaluate('_refRewards().length')).toBe(2);
    await page.evaluate(`localStorage.setItem('cq_ref_seen_c1',JSON.stringify(['RF-1A2B3C4D','RB-9F8E7D6C']));document.getElementById('confirm-modal').style.display='none';document.getElementById('confirm-modal').innerHTML=''`);
    await page.evaluate(`showView('customer');setCustTab('register');S.selEvent='jcc';S.selSession='s0';S.regStep=2;S.regQty=1;S.regBikeTypes=['Hybrid'];renderRegister()`);
    await expect(page.locator('#bld-redeem .fr-card')).toContainText('RF-1A2B3C4D');
    await page.evaluate(`S.regBikeTypes=['Road Carbon'];renderRegister()`);
    const box = page.locator('#bld-redeem .fr-card');
    await expect(box).toContainText('Carbon');
    await expect(box).not.toContainText('RB-9F8E7D6C');
    await expect(box.locator('.fr-go')).toHaveCount(0);
  });

  test('the Recruiter badge counts the friends who rode, as levels at 1, 3, 5 and 10', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': card({ rode: 3 }), 'rpc:customer_blood_rewards': [] });
    await account(page);
    await expect.poll(() => page.evaluate('S._refMine&&S._refMine.rode')).toBe(3);
    const x = await page.evaluate(`(()=>{const L=_mrBadgeList(S.loggedIn||getSession());const y=L.find(z=>z.lv&&z.lv.some(w=>w.b.slug==='recruiter'));return y?[y.lvN,y.nx&&y.nx.b.slug,y.lv.length]:null;})()`);
    expect(x).toEqual([2, 'recruiter_5', 4]);
  });

  test('a friend\'s code goes with this browser\'s id; a database without it is asked again without the id', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await rider(page, { 'rpc:customer_referral': card({ can_enter: true }) });
    await page.route(/\/rest\/v1\/rpc\/customer_set_referrer/, async (route) => {
      const b = route.request().postDataJSON() as Record<string, unknown>;
      sent.push(b);
      if ('p_device' in b) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.customer_set_referrer(p_code, p_device, p_id, p_token, p_via)' }) });
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) });
    });
    await account(page);
    await page.locator('#ref-in').fill('K7MQ2X');
    await page.locator('#ref-mine').getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('#toast-container')).toContainText('your friend gets a free ride');
    expect(sent).toHaveLength(2);
    expect(String(sent[0].p_device)).toMatch(/^[0-9a-f]{24}$/);
    expect('p_device' in sent[1]).toBe(false);
  });
});

test.describe('@staff:people referral extras', () => {
  const customers = [
    { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', created_at: '2026-11-01T09:00:00Z' },
    { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', created_at: '2026-06-11T09:00:00Z' },
    { id: 'c3', name: 'Maya Nasser', email: 'maya.nasser@gmail.com', phone: '+966551876217', created_at: '2026-11-02T09:00:00Z' },
  ];
  const now = new Date().toISOString();
  const referrals = [
    { friend_id: 'c1', referrer_id: 'c2', code: 'K7MQ2X', via: 'link', created_at: now, rode_at: now, reward_code: 'RF-1A2B3C4D', rewarded_at: now, capped: false, held: false, device: 'd1' },
    { friend_id: 'c3', referrer_id: 'c2', code: 'K7MQ2X', via: 'link', created_at: now, rode_at: null, reward_code: null, rewarded_at: null, capped: false, held: true, device: 'd1' },
  ];
  async function staff(page: Page, fx: Record<string, unknown> = {}) {
    await stubSupabase(page, { sessions: [jcc], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [],
      promo_codes: [{ id: 'rf-c1', code: 'RF-1A2B3C4D', kind: 'percent', value: 100, active: true, uses: 1, max_uses: 1, customer_id: 'c2', referral_friend_id: 'c1', ride_kind: 'jcc' }],
      referrals, referral_codes: [{ customer_id: 'c2', code: 'K7MQ2X' }], ...fx });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length===3');
  }

  test('People > Referrals: the figures, the referral to check with Allow, and the top referrer', async ({ page }) => {
    const calls = rpcs(page);
    await staff(page, { 'rpc:staff_referral_review': { ok: true, rewarded: false } });
    await page.evaluate(`setStaffTab('community');setCommTab('referrals')`);
    expect(new URL(page.url()).pathname).toBe('/people/referrals');
    const tab = page.locator('#tab-community');
    await expect(tab.locator('.rp-kpis .dash-kpi')).toHaveCount(7);
    await expect(tab.locator('.rp-check')).toContainText('Maya Nasser');
    await expect(tab.locator('.rp-check')).toContainText('2 accounts with this code in a day');
    await expect(tab.locator('.rp-table').last()).toContainText('Omar Saleh');
    await tab.locator('.rp-check').getByRole('button', { name: 'Allow' }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_referral_review').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_referral_review')!.body).toEqual({ p_friend: 'c3', p_allow: true });
  });

  test('the bell lists the referrals to check, and the account window says one waits', async ({ page }) => {
    await staff(page);
    await page.evaluate(`S._refHeld=[{friend_id:'c3',referrer_id:'c2',created_at:new Date().toISOString()}]`);
    const k = await page.evaluate(`(()=>{const x=_ntKindsNow().find(y=>y.k==='refheld');return x?[x.ids,x.items[0].txt]:null;})()`) as [string[], string];
    expect(k[0]).toEqual(['c3']);
    expect(k[1]).toContain('Maya Nasser');
    expect(await page.evaluate(`NT_KINDS.some(r=>r[0]==='refheld')`)).toBe(true);
    await page.evaluate(`openAccountHistory('c3')`);
    const sec = page.locator('#cust-modal .ref-ah');
    await expect(sec.locator('.ref-ah-held')).toContainText('Waiting for a staff check');
    await expect(sec.getByRole('button', { name: 'Allow' })).toBeVisible();
  });
});

// The friend's half (the owner, 2026-11-08: "the person who uses the referral code for the first time gets a 50% discount
// for his booking (for one bike)", migration 20261108200000): a new account linked to a referrer holds its own code (RW-),
// pct off the account holder's own bike, on a JCC ride or a Petromin night, never Carbon. It comes off by itself on the
// bike step; a friend's code typed in the promo box links the account and puts it on.
const W = { code: 'RW-K7MQ2X-4FZ', expires_at: '2099-12-05', used: false, pct: 50 };
const pm = { id: 's2', day: 'Wednesday', session_date: '2099-02-11', capacity: 9, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'petromin', paid_ride: true, location: 'JCC' };
async function friend(page: Page, fx: Record<string, unknown> = {}) {
  // the pop-ups seen (the friend's code is said once on a device, tested on its own below)
  await page.addInitScript(() => { try { localStorage.setItem('cq_ref_seen_c1', JSON.stringify(['RF-1A2B3C4D', 'RW-K7MQ2X-4FZ'])); ['rec1', 'rec3', 'rec5', 'rec10'].forEach((k) => localStorage.setItem('cq_bdg_' + k + '_c1', '1')); } catch { /* none */ } });
  await rider(page, { sessions: [jcc, sat, pm], 'rpc:customer_referral': card({ referred: true, joined: 0, rode: 0, earned: 0, welcome: W }), 'rpc:customer_blood_rewards': [], ...fx }, '/', false);
  await page.evaluate('showView("landing");renderLandingAvail()');
  await expect.poll(() => page.evaluate('!!_refWOpen()')).toBe(true);
}
const step2 = (page: Page, sid: string, types: string[]) => page.evaluate(`showView('customer');setCustTab('register');S.selSession=${JSON.stringify(sid)};S.selEvent=_evOf(_sessDisp(S.selSession));S.regStep=2;S.regQty=${types.length};S.regBikeTypes=${JSON.stringify(types)};renderRegister()`);

test.describe('@customer:reserve the friend\'s referral discount', () => {
  test('on the event picker and the Invite card, then on rider 1\'s bike by itself: half off, a second rider pays in full', async ({ page }) => {
    await friend(page);
    const land = page.locator('#land-free-rides .fr-welcome');
    await expect(land).toContainText('A friend’s invite: 50% off');
    await expect(land).toContainText('RW-K7MQ2X-4FZ');
    await account(page);
    await expect(page.locator('#ref-mine .ref-w')).toContainText('50% off your own bike');
    await step2(page, 's0', ['Hybrid', 'Hybrid']);
    expect(await page.evaluate('S.promoApplied&&[S.promoApplied.code,S.promoApplied.one,S.promoApplied.auto,S.promoApplied.value]')).toEqual(['RW-K7MQ2X-4FZ', true, true, 50]);
    const fare = await page.evaluate(`priceForType('Hybrid')`) as number;
    await expect(page.locator('#reg-promo-disc-step2')).toContainText(String(fare / 2));
    // what is booked: rider 1 at half, carrying the code; rider 2 at the full fare, without it (one use, one bike)
    const rows = await page.evaluate(`(()=>{const es=[{price:${fare},typePreference:'Hybrid'},{price:${fare},typePreference:'Hybrid'}];_applyPromoToEntries(es);return es.map(e=>[e.price,e.promoCode||null]);})()`);
    expect(rows).toEqual([[fare / 2, 'RW-K7MQ2X-4FZ'], [fare, null]]);
  });

  test('never on Carbon; taken off it stays off on this ride, and Redeem puts it back', async ({ page }) => {
    await friend(page, { 'rpc:promo_lookup': { ok: true, code: 'RW-K7MQ2X-4FZ', kind: 'percent', value: 50, applies_to: null, session_id: null, ride_kind: null } });
    await step2(page, 's0', ['Road Carbon']);
    expect(await page.evaluate('S.promoApplied')).toBeNull();
    await expect(page.locator('#bld-redeem .fr-card')).toContainText('isn’t valid on a Carbon bike');
    await page.evaluate(`setBikeType(0,'Hybrid')`);
    await expect.poll(() => page.evaluate('S.promoApplied&&S.promoApplied.auto')).toBe(true);
    await page.evaluate('removePromo()');
    expect(await page.evaluate('[S.promoApplied,S._rwOff]')).toEqual([null, 's0']);
    await page.evaluate(`setBikeType(0,'Road')`);
    expect(await page.evaluate('S.promoApplied')).toBeNull(); // still off
    const box = page.locator('#bld-redeem .fr-card');
    await expect(box).toContainText('RW-K7MQ2X-4FZ');
    await box.locator('.fr-go').click();
    await expect.poll(() => page.evaluate('S.promoApplied&&[S.promoApplied.code,S.promoApplied.one]')).toEqual(['RW-K7MQ2X-4FZ', true]);
  });

  test('a Petromin night takes it; a Saturday ride and an edit do not', async ({ page }) => {
    await friend(page);
    expect(await page.evaluate(`[_refCodeSessOk(_sessDisp('s0')),_refCodeSessOk(_sessDisp('s2')),_refCodeSessOk(_sessDisp('s1'))]`)).toEqual([true, true, false]);
    await step2(page, 's2', ['Hybrid']);
    await expect.poll(() => page.evaluate('S.promoApplied&&S.promoApplied.code')).toBe('RW-K7MQ2X-4FZ');
    await page.evaluate(`S.promoApplied=null;S.selEvent='community';S.selSession='s1';renderRegister()`);
    expect(await page.evaluate('S.promoApplied')).toBeNull();
    expect(await page.evaluate(`S.selEvent='jcc';S.selSession='s0';S.modifyEntryId='q9';[_refWAuto(),S.promoApplied]`)).toEqual([false, null]);
  });

  test('used on a booking: not offered again', async ({ page }) => {
    await rider(page, { sessions: [jcc, sat, pm], 'rpc:customer_referral': card({ referred: true, welcome: { ...W, used: true } }), 'rpc:customer_blood_rewards': [] });
    await page.evaluate('showView("landing");renderLandingAvail()');
    await expect.poll(() => page.evaluate('!!(S._refMine&&S._refMine.welcome)')).toBe(true);
    await expect(page.locator('#land-free-rides .fr-welcome')).toHaveCount(0);
    await step2(page, 's0', ['Hybrid']);
    expect(await page.evaluate('S.promoApplied')).toBeNull();
  });

  test('a friend\'s code typed in the promo box links the account and puts the discount on', async ({ page }) => {
    const calls = rpcs(page);
    let linked = false;
    await rider(page, { sessions: [jcc, sat, pm], 'rpc:customer_blood_rewards': [], 'rpc:promo_lookup': { ok: false, reason: 'invalid' } }, '/', false);
    const json = (b: unknown) => ({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(b) });
    await page.route(/\/rest\/v1\/rpc\/customer_referral/, (r) => r.fulfill(json(card({ can_enter: !linked, referred: linked, joined: 0, rode: 0, earned: 0, welcome: linked ? W : null }))));
    await page.route(/\/rest\/v1\/rpc\/customer_set_referrer/, (r) => { linked = true; return r.fulfill(json({ ok: true, held: false, welcome: W.code })); });
    await step2(page, 's0', ['Hybrid']);
    expect(await page.evaluate('S.promoApplied')).toBeNull();
    await page.locator('#reg-promo-step2').fill('k7mq2x');
    await page.locator('#reg-promo-btn-step2').click();
    await expect.poll(() => page.evaluate('S.promoApplied&&[S.promoApplied.code,S.promoApplied.one]')).toEqual(['RW-K7MQ2X-4FZ', true]);
    expect(calls.find((c) => c.name === 'customer_set_referrer')!.body).toMatchObject({ p_id: 'c1', p_code: 'k7mq2x', p_via: 'code' });
    await expect(page.locator('#toast-container')).toContainText('You get 50% off your own bike');
  });

  test('a typed friend\'s code the server refuses says why in the promo box', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': card({ can_enter: false }), 'rpc:customer_blood_rewards': [], 'rpc:promo_lookup': { ok: false, reason: 'invalid' }, 'rpc:customer_set_referrer': { ok: false, reason: 'not_new' } });
    await step2(page, 's0', ['Hybrid']);
    await page.locator('#reg-promo-step2').fill('K7MQ2X');
    await page.locator('#reg-promo-btn-step2').click();
    await expect(page.locator('.cu-promo-err')).toContainText('only on a new account');
    // a code that is not shaped like a friend's is only "invalid", without asking
    await page.locator('#reg-promo-step2').fill('SUMMER10');
    await page.locator('#reg-promo-btn-step2').click();
    await expect(page.locator('.cu-promo-err')).toContainText('Invalid or inactive code');
  });

  test('the friend hears of their code once on this device', async ({ page }) => {
    await rider(page, { 'rpc:customer_referral': card({ referred: true, welcome: W }), 'rpc:customer_blood_rewards': [] }, '/', false);
    await page.evaluate('showView("landing");renderLandingAvail()');
    const pop = page.locator('#confirm-modal');
    await expect(pop).toContainText('A friend’s invite: 50% off');
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_ref_seen_c1'))`)).toEqual(['RW-K7MQ2X-4FZ']);
  });

  test('the server\'s refusals are said in the rider\'s words', async ({ page }) => {
    await rider(page, { 'rpc:customer_blood_rewards': [] });
    for (const [d, k] of [['REF_CODE_CARBON', 'errRefCodeCarbon'], ['REF_CODE_SESSION', 'errRefCodeSession']]) {
      await page.evaluate(`document.getElementById('toast-container').innerHTML='';_bookRefused({message:'x',details:${JSON.stringify(d)}},_sessDisp('s0'))`);
      await expect(page.locator('#toast-container')).toContainText(await page.evaluate(`t(${JSON.stringify(k)})`) as string);
    }
  });
});

test.describe('@staff:people the friend\'s code on the account window', () => {
  test('its percent, the code and whether it was used', async ({ page }) => {
    const customers = [
      { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', created_at: '2026-06-11T09:00:00Z' },
      { id: 'c3', name: 'Maya Nasser', email: 'maya.nasser@gmail.com', phone: '+966551876217', created_at: '2026-11-02T09:00:00Z' },
    ];
    await stubSupabase(page, { sessions: [jcc], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [],
      referrals: [{ friend_id: 'c3', referrer_id: 'c2', code: 'K7MQ2X', via: 'code', created_at: '2026-11-04T10:00:00Z', rode_at: null, reward_code: null, capped: false, held: false }],
      referral_codes: [{ customer_id: 'c2', code: 'K7MQ2X' }],
      promo_codes: [
        { id: 'rf-x', code: 'RF-1A2B3C4D', kind: 'percent', value: 100, active: true, uses: 0, customer_id: 'c2', referral_friend_id: 'cx' },
        { id: 'rw-c3', code: 'RW-K7MQ2X-4FZ', kind: 'percent', value: 50, active: true, uses: 0, max_uses: 1, expires_at: '2099-12-05', customer_id: 'c3', referral_welcome_of: 'c3' },
      ] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length===2');
    await page.evaluate(`openAccountHistory('c3')`);
    const line = page.locator('#cust-modal .ref-ah .ref-ah-w');
    await expect(line).toContainText('Their 50% off: RW-K7MQ2X-4FZ');
    await expect(line).toContainText('not used yet');
  });
});
