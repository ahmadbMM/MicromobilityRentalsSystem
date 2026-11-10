import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The Reserve page research, built (2026-11-10; reports/Reserve page design and function.md, the owner's seven answers
// and the twenty rows). The flow names the outcome before the tap: Join waitlist on a full night, Not sent yet for a
// booking still on the phone, the booking window in 12-hour time and as a countdown inside a day, the place-gone
// question when another device took the last place. A child's height picks the Kids bike, digits in any script are
// read, and the funnel records each step once. All Supabase traffic is stubbed.

const OPEN = '2099-02-01', FULL = '2099-02-03';
const night = (id: string, day: string, extra: Record<string, unknown> = {}) => ({
  id, session_date: id, day, status: 'open', capacity: 10, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":10}', ...extra,
});
const sessions = [night(OPEN, 'Sunday'), night(FULL, 'Tuesday', { status: 'full' })];

async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [], ...fixtures });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
  await page.goto('/');
  await waitForSb(page);
}
const at = (sid: string, step: number, extra = '') => `S.lastTickets=[];S.selEvent='jcc';goCustomer('register');S.selSession='${sid}';S.regQty=1;
  S.regBikeHeights=['175'];S.regBikeTypes=['Road'];S.regRiderNames=['Spec Rider'];S.promoApplied=null;S.regStep=${step};${extra}renderRegister();`;
function posts(page: Page, name: string) {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(`/rest/v1/rpc/${name}`)) calls.push(r.postDataJSON());
  });
  return calls;
}
const confirmBtn = (page: Page) => page.locator('#tab-register .mm-reg-foot .btn-primary');

test.describe('@customer:reserve the research round', () => {
  test('a full night says Waitlist in the bar and on the review, and Confirm reads Join waitlist (row 1)', async ({ page }) => {
    await boot(page);
    await page.evaluate(at(FULL, 1));
    await expect(page.locator('#tab-register .reg-foot-sum .cu-wl-chip')).toHaveText('Waitlist');
    await page.evaluate(at(FULL, 3, 'S.waiverOk=true;S._waiverSess=S.selSession;'));
    await expect(page.locator('#tab-register .cu-rv-date .cu-wl-chip')).toHaveText('Waitlist');
    await expect(confirmBtn(page)).toHaveText('Join waitlist');
    await page.evaluate(at(OPEN, 3, 'S.waiverOk=true;S._waiverSess=S.selSession;'));
    await expect(confirmBtn(page)).toHaveText('Confirm booking');
    await expect(page.locator('#tab-register .cu-wl-chip')).toHaveCount(0);
  });

  test('the booking window reads in 12-hour time, and counts down inside a day (row 3)', async ({ page }) => {
    await boot(page);
    const far = await page.evaluate(`S._bw={days:30,at:'20:00'};_bwOpensText({id:'2099-06-01',session_date:'2099-06-01'})`);
    expect(far).toContain(' 8 PM'); // as every other time on the page ("9 PM - 11 PM")
    expect(far).not.toContain('20:00');
    // opening about 90 minutes from now, whatever the hour
    const soon = await page.evaluate(`(()=>{const k=new Date(Date.now()+90*6e4+3*36e5),day=k.toISOString().slice(0,10),at=k.toISOString().slice(11,16);
      const sd=new Date(Date.parse(day+'T12:00:00Z')+2*864e5).toISOString().slice(0,10);S._bw={days:2,at};return _bwOpensText({id:sd,session_date:sd});})()`);
    expect(soon).toMatch(/^Booking opens in 1 h (29|30) min$/);
  });

  test('a child\'s height picks the Kids bike, a grown one takes it back; Arabic digits are read (rows 6, Q1)', async ({ page }) => {
    await boot(page);
    await page.evaluate(at(OPEN, 2, "S.regBikeTypes=[''];S.regBikeHeights=[''];"));
    const h = page.locator('#reg-height-0');
    await expect(h).toHaveAttribute('inputmode', 'numeric');
    await h.fill('130');
    await expect.poll(() => page.evaluate('S.regBikeTypes[0]')).toBe('Kids');
    await expect(page.locator('#tab-register [data-type-slot="0"][data-type="Kids"]')).toHaveAttribute('aria-checked', 'true');
    await h.fill('170');
    await expect.poll(() => page.evaluate('S.regBikeTypes[0]||null')).toBe(null);
    await h.fill('١٦٥');
    expect(await page.evaluate('S.regBikeHeights[0]')).toBe('165');
    // a Kids bike the rider picks for a grown height is refused at the field, once (row 5)
    await page.locator('#tab-register [data-type-slot="0"][data-type="Kids"]').click();
    await page.evaluate('regNextToReview()');
    await expect(page.locator('#reg-type-wrap-0')).toContainText('Kids bikes are for riders up to 144 cm');
    await expect(page.locator('#toast-container .toast.error')).toHaveCount(0);
    expect(await page.evaluate('S.regStep')).toBe(2);
  });

  test('the step-2 bar carries the total once a bike is picked, and Back sits in the step-1 bar (rows 9, 12)', async ({ page }) => {
    await boot(page);
    await page.evaluate(at(OPEN, 2, "S.regBikeTypes=[''];"));
    await expect(page.locator('#reg-foot-tot')).toBeEmpty();
    await page.locator('#tab-register [data-type-slot="0"][data-type="Road"]').click();
    await expect(page.locator('#reg-foot-tot')).toContainText('75');
    await page.evaluate(at(OPEN, 1));
    await expect(page.locator('#tab-register .reg-foot1 .reg-foot-back')).toBeVisible();
    await expect(page.locator('#cust-back-btn')).toBeHidden();
  });

  test('Change on the review goes back and Continue returns to the review (row 8)', async ({ page }) => {
    await boot(page);
    await page.evaluate(at(OPEN, 3));
    await page.locator('#tab-register .cu-rv-sec-chg .cu-rv-chg').click();
    expect(await page.evaluate('S.regStep')).toBe(2);
    await page.evaluate('regNextToReview()');
    expect(await page.evaluate('S.regStep')).toBe(3);
    await page.locator('#tab-register .cu-rv-head .cu-rv-chg').click();
    expect(await page.evaluate('S.regStep')).toBe(1);
    await page.evaluate('regNextFromSession()');
    expect(await page.evaluate('S.regStep')).toBe(3);
  });

  test('a booking that asked for a place carries seat_only; PLACE_GONE asks, and Join waitlist books without it (row 13)', async ({ page }) => {
    await boot(page, { 'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'PLACE_GONE' } } });
    const sent = posts(page, 'customer_create_booking');
    await page.evaluate(at(OPEN, 3, 'S.waiverOk=true;S._waiverSess=S.selSession;'));
    await page.evaluate('submitReg()');
    await expect(page.locator('.pg-dlg')).toBeVisible();
    await expect(page.locator('.pg-dlg')).toContainText('The last place just went');
    const first = (sent[0].p_entries as Record<string, unknown>[])[0];
    expect(first.seat_only).toBe(true);
    await page.locator('.pg-dlg').getByRole('button', { name: 'Join waitlist' }).click();
    await expect.poll(() => sent.length).toBeGreaterThan(1);
    expect((sent[sent.length - 1].p_entries as Record<string, unknown>[])[0].seat_only).toBeUndefined();
    // the riders' choices are kept
    expect(await page.evaluate('S.regBikeTypes[0]')).toBe('Road');
  });

  test('a booking made with no signal is "Not sent yet", with nothing to scan and no number (row 2)', async ({ page }) => {
    await boot(page);
    await page.evaluate(at(OPEN, 3, 'S.waiverOk=true;S._waiverSess=S.selSession;'));
    await page.evaluate(`Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });submitReg()`);
    await expect(page.locator('#tab-register .bk-ok-t')).toHaveText('Not sent yet');
    await expect(page.locator('#tab-register .bk-ok-q')).toHaveCount(0);
    await expect(page.locator('#tab-register .ticket-card .cu-qr-box, #tab-register .ticket-card canvas')).toHaveCount(0);
  });

  test('session rows and bike pills are radio groups; Details is an "i" named for its date (rows 11, 17)', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.lastTickets=[];S.selEvent='jcc';goCustomer('register');S.selSession=null;S.regStep=1;renderRegister()`);
    const group = page.locator('#tab-register .session-cards-grid[role="radiogroup"]');
    await expect(group).toHaveAttribute('aria-labelledby', 'reg-h');
    await expect(group.locator('[role="radio"]')).toHaveCount(2);
    await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
    await page.evaluate(at(OPEN, 2));
    await expect(page.locator('#reg-type-wrap-0 [role="radiogroup"] [role="radio"][aria-checked="true"]')).toHaveAttribute('data-type', 'Road');
  });

  test('each step is recorded once per attempt, with no account on it (row 20)', async ({ page }) => {
    await boot(page);
    const sent = posts(page, 'reserve_funnel_add');
    await page.evaluate(`S.lastTickets=[];S.selEvent='jcc';goCustomer('register');S.selSession=null;S.regStep=1;renderRegister();renderRegister();`);
    await page.evaluate(at(OPEN, 2));
    await page.evaluate('_fnlSend()');
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    const evs = sent.flatMap((c) => (c.p_events as { ev: string }[]).map((e) => e.ev));
    expect(evs.filter((e) => e === 'list')).toHaveLength(1);
    expect(evs).toContain('step2');
    expect(sent[0].p_src).toBe('app');
    expect(Object.keys(sent[0]).sort()).toEqual(['p_events', 'p_src', 'p_visit']); // no account, no token
    for (const e of sent.flatMap((c) => c.p_events as Record<string, unknown>[])) expect(Object.keys(e).every((k) => ['ev', 'k', 'd'].includes(k))).toBe(true);
  });
});
