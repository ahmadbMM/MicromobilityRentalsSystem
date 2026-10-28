import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Men only, women only or mixed (the owner, 2026-10-27: "i want the triathlon pool sessions to be for male only or
// female only or mixed and to be mentioned on the card and event everywhere and only allow the gender selected to
// book it"), shown to everyone (the owner, 2026-10-28: "make all pool sessions visible to all genders but only male
// can book male sessions and female can book female sessions"; 20261028100000). The customer's side: every date is
// listed to a visitor and to either gender; a pick or a confirm by anyone else is refused in words before the
// server's GENDER_ONLY (_sgPick), which is said in words too; the chip names the rule on the cards, the review, the
// tickets and the sheet.

const pool = (date: string, gender: 'male' | 'female' | null) => ({
  id: date, day: 'Thursday', session_date: date, capacity: 20, status: 'open', created_at: 2,
  event_kind: 'community', ride_kind: 'swim', needs_approval: true, hide_queue: true, paid_ride: false,
  spots: 20, title: 'Triathlon Pool Session', meet_url: 'https://maps.example.test/pool',
  bike_slots: '{"_time":"18:00 - 19:30","_total":20}', gender_only: gender,
});
const WOMEN = pool('2099-03-05', 'female');
const MEN = pool('2099-03-12', 'male');
const MIXED = pool('2099-03-19', null);
const SESSIONS = [WOMEN, MEN, MIXED];
const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

// A signed-in member; `cust` lays fields over the remembered session (gender among them), `fx` over the fixtures.
// list_sessions answers with every pool date, as the server does for everyone.
async function boot(page: Page, cust: Record<string, unknown> = {}, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: SESSIONS, queue_entries: [], bikes: [], 'rpc:community_member': true, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Spec Swimmer', ...cust });
  const booked: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rpc/customer_create_booking')) booked.push(r.postData() || '');
  });
  await page.goto('/');
  await waitForSb(page);
  return booked;
}
const card = (page: Page, id: string) => page.locator(`#tab-register .sess-card[data-on-click*="${id}"]`);
const sheet = (page: Page) => page.locator('#bike-info-modal .ev-info');
const fact = (page: Page, label: string) => sheet(page).locator('.ev-info-facts > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd');
const errToast = (page: Page) => page.locator('#toast-container .toast.error');

test.describe('@customer:reserve pool gender: men only, women only or mixed', () => {
  test('a woman sees every date with its chip, men-only too, and books hers', async ({ page }) => {
    const booked = await boot(page, { gender: 'female' });
    await page.evaluate(`selectEvent('community')`);
    await expect(card(page, WOMEN.id).locator('.sg-chip')).toHaveText('Women only');
    await expect(card(page, MIXED.id).locator('.sg-chip')).toHaveText('Mixed');
    await expect(card(page, MEN.id).locator('.sg-chip')).toHaveText('Men only');   // hers to see, not to book
    await card(page, WOMEN.id).click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(WOMEN.id);
    await page.evaluate('regNextFromSession()');
    await expect(page.locator('#tab-register .cu-rv-date .sg-chip')).toHaveText('Women only');   // the review says it
    await page.evaluate('toggleWaiver(true)');
    await page.evaluate('submitReg()');
    await expect.poll(() => booked.length).toBe(1);
    expect(JSON.parse(booked[0]).p_entries[0].session_id).toBe(WOMEN.id);
    await expect(page.locator('#tab-register .ticket-card .sg-chip')).toHaveText('Women only');  // and the ticket
  });

  test('a man sees the women-only date with its chip and cannot book it', async ({ page }) => {
    const booked = await boot(page, { gender: 'male' });
    await page.evaluate(`selectEvent('community')`);
    await expect(card(page, MEN.id).locator('.sg-chip')).toHaveText('Men only');
    await expect(card(page, MIXED.id).locator('.sg-chip')).toHaveText('Mixed');
    await expect(card(page, WOMEN.id).locator('.sg-chip')).toHaveText('Women only');
    // the umbrella's About names the next date, whoever it is for, with its rule
    await page.evaluate(`showEventInfo('community')`);
    await expect(fact(page, 'Next date')).toContainText('Women only');
    await page.evaluate('closeEventInfo()');
    // a mixed date's Details say who may book it
    await page.evaluate(`showSessInfo('${MIXED.id}')`);
    await expect(fact(page, 'Who')).toHaveText('Community members · Mixed');
    await page.evaluate('closeEventInfo()');
    // tapped, it is refused in words and never reaches the server
    await card(page, WOMEN.id).click();
    await expect(errToast(page).last()).toHaveText('This session is for women only.');
    expect(await page.evaluate('S.selSession')).toBeNull();
    await expect(card(page, WOMEN.id)).toHaveCount(1);                 // and it stays on the list
    await page.evaluate(`S.selSession='${WOMEN.id}';S.regStep=3;S.waiverOk=true;S._waiverSess=S.selSession;submitReg()`);
    await expect.poll(() => page.evaluate('S.selSession')).toBeNull();
    await page.waitForTimeout(300);
    expect(booked).toHaveLength(0);
    // his own books
    await card(page, MEN.id).click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(MEN.id);
  });

  test('a visitor who is not signed in keeps every date, men-only and women-only too', async ({ page }) => {
    await stubSupabase(page, { sessions: SESSIONS, queue_entries: [], bikes: [] });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate('allSessions().map(s=>s.id).sort()')).toEqual([WOMEN.id, MEN.id, MIXED.id].sort());
  });

  test('a gender the page has not read yet is asked before a pick is judged', async ({ page }) => {
    const booked = await boot(page);
    await page.route(/\/rest\/v1\/rpc\/customer_profile/, (route) => route.fulfill({ status: 200, headers: head,
      body: JSON.stringify([{ id: 'c1', name: 'Spec Swimmer', gender: 'male', default_pay: null, nationality: null, birth_date: null }]) }));
    await page.evaluate(`S.loggedIn=getSession();delete S.loggedIn.gender;setSession(S.loggedIn)`);   // the sign-in row carries none
    await page.evaluate(`selectEvent('community')`);
    await card(page, WOMEN.id).click();
    await expect(errToast(page).last()).toHaveText('This session is for women only.');
    expect(await page.evaluate('(S.loggedIn||{}).gender')).toBe('male');
    expect(await page.evaluate('S.selSession')).toBeNull();
    expect(booked).toHaveLength(0);
  });

  test('signing in keeps every date; the gender it reads decides the booking', async ({ page }) => {
    await stubSupabase(page, {
      sessions: SESSIONS, queue_entries: [], bikes: [], 'rpc:community_member': true,
      'rpc:customer_login': [{ id: 'c1', name: 'Spec Swimmer', email: 'swim@example.com', phone: '+966500000001', session_token: 'tok-spec' }],
      'rpc:customer_profile': [{ id: 'c1', name: 'Spec Swimmer', gender: 'female', default_pay: null, nationality: null, birth_date: null }],
    });
    // list_sessions as the server answers it: every date, to a visitor and to an account alike
    await page.route(/\/rest\/v1\/rpc\/list_sessions/, (route) => route.fulfill({ status: 200, headers: head, body: JSON.stringify(SESSIONS) }));
    await page.goto('/');
    await waitForSb(page);
    const all = [WOMEN.id, MEN.id, MIXED.id].sort();
    expect(await page.evaluate('allSessions().map(s=>s.id).sort()')).toEqual(all);
    await page.fill('#a-identifier', 'swim@example.com');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.evaluate('doLogin()');
    await expect.poll(() => page.evaluate('(S.loggedIn||{}).gender')).toBe('female');   // read at sign-in
    expect(await page.evaluate('allSessions().map(s=>s.id).sort()')).toEqual(all);
    expect(await page.evaluate(`_sgOk(_sessGet('${MEN.id}'),S.loggedIn)`)).toBe(false);
    expect(await page.evaluate(`_sgOk(_sessGet('${WOMEN.id}'),S.loggedIn)`)).toBe(true);
  });

  test('the server’s GENDER_ONLY refusal is said in the rider’s language', async ({ page }) => {
    await boot(page, { gender: 'female' }, {
      'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'GENDER_ONLY', details: 'female' } },
    });
    await page.evaluate(`setLang('ar')`);
    await expect.poll(() => page.evaluate(`t('errSgFemale')`)).toBe('هذه الفعالية للنساء فقط.');
    await page.evaluate(`selectEvent('community')`);
    await page.evaluate(`S.selSession='${WOMEN.id}';regNextFromSession();toggleWaiver(true);submitReg()`);
    await expect(errToast(page).last()).toHaveText('هذه الفعالية للنساء فقط.');
    expect(await page.evaluate(`_sgErrOf({code:'P0001',message:'GENDER_ONLY',details:'male'})`)).toBe('هذه الفعالية للرجال فقط.');
    // a refused move or a cancel taken back reads the same through the error bar's words
    expect(await page.evaluate(`_errMessage({code:'P0001',message:'GENDER_ONLY',details:'female'})`)).toBe('هذه الفعالية للنساء فقط.');
  });

  test('the ticket, the Details and the waiver page name the rule', async ({ page }) => {
    await boot(page, { gender: 'female' }, {
      queue_entries: [{
        id: 'b1', name: 'Spec Swimmer', customer_id: 'c1', session_id: WOMEN.id, session_day: 'Thursday', session_date: WOMEN.session_date,
        queue_num: 1, status: 'waiting', paid: false, price: 0, type_preference: 'None', size: '', approval: 'pending',
        registered_at: '2099-01-01T10:00:00Z', waiver_version: null,
      }],
    });
    // staff added her (no waiver yet): the page that asks for it names the rule beside the session
    await expect(page.locator('#waiver-gate .wg-ev .sg-chip')).toHaveText('Women only');
    await page.evaluate(`S._wgOff=true;S._wg=null;renderWaiverGate()`);
    await page.evaluate(`goCustomer('myrides')`);
    await expect(page.locator('#tab-myrides .ticket-card .sg-chip')).toHaveText('Women only');
    await page.evaluate(`selectEvent('community')`);
    await page.evaluate(`showSessInfo('${WOMEN.id}')`);
    await expect(sheet(page).locator('#ev-info-title .sg-chip')).toHaveText('Women only');
    await expect(fact(page, 'Who')).toHaveText('Community members · Women only');
  });
});
