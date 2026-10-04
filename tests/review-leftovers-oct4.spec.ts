import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// The last of the 2026-10-03 review (2026-10-04): a ticketed event takes up to five seats, each
// at the event's own price (in the wizard, with a code, and when staff change a code); cloning an
// event or applying a template keeps what an event is; Edit opens a step the ride has; "Book my
// usual" keeps to the booking window; the week streak counts the ride's own KSA weeks; an account
// with no name on it still draws.

const d = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const EV = {
  id: d(4) + '-ev', day: 'Friday', session_date: d(4), capacity: 30, spots: 30, status: 'open', created_at: 2,
  event_kind: 'community', ride_kind: 'event', paid_ride: true, price: 40, open_to_all: false, needs_approval: false,
  hide_queue: true, title: 'Bike maintenance class', description: 'Bring your own bike.', bike_slots: '{"_time":"19:00 - 21:00"}',
};
const WS = {
  id: d(5) + '-tw', day: 'Tuesday', session_date: d(5), capacity: 30, spots: 30, status: 'open', created_at: 3,
  event_kind: 'community', ride_kind: 'workshop', needs_approval: true, hide_queue: true, paid_ride: false,
  open_to_all: true, title: 'Workshop', bike_slots: '{"_time":"18:00 - 20:00","_total":30}',
};
const JCC = { id: d(3), day: 'Wednesday', session_date: d(3), capacity: 20, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' };

async function rider(page: Page, extra: Record<string, unknown> = {}, cust: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [EV, WS, JCC], queue_entries: [], bikes: [], 'rpc:community_member': true, ...extra });
  await loginCustomer(page, cust);
  await page.goto('/');
  await waitForSb(page);
}
async function staff(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [EV, WS, JCC], queue_entries: [], bikes: [], ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@customer:reserve event seats', () => {
  test('an event takes up to five seats, a name on each, every seat at the seat price', async ({ page }) => {
    await rider(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(`S.selEvent='event';goCustomer('register');S.regStep=1;renderRegister();S.selSession=${JSON.stringify(EV.id)};S.regQty=1;ensureBikeSizes();regNextFromSession()`);
    expect(await page.evaluate('S.regStep')).toBe(2);
    const panel = page.locator('#tab-register');
    await expect(panel).toContainText('Participants');
    await expect(panel).toContainText('up to 5 riders');
    for (let i = 0; i < 7; i++) await page.evaluate('changeRegQty(1)');
    expect(await page.evaluate('S.regQty')).toBe(5); // the server's cap for an event (_group_ride_cap)
    for (let i = 0; i < 3; i++) await page.evaluate('changeRegQty(-1)');
    expect(await page.evaluate('S.regQty')).toBe(2);
    await expect(page.locator('#reg-rider-name-0')).toHaveValue('Spec Rider');
    await expect(page.locator('#reg-rider-name-1')).toHaveValue('');
    await expect(panel.locator('.price-preview')).toContainText('80'); // 2 x 40, the seat, not a bike
    // the second seat needs a name before the waiver
    await page.evaluate('regNextToReview()');
    expect(await page.evaluate('S.regStep')).toBe(2);
    await page.locator('#reg-rider-name-1').fill('Lina Guest');
    await page.evaluate('regNextToReview()');
    expect(await page.evaluate('S.regStep')).toBe(2.5);
    await panel.locator('input[type="checkbox"]').check();
    await panel.locator('.mm-reg-foot .btn-primary').click();
    expect(await page.evaluate('S.regStep')).toBe(3);
    await page.evaluate('submitReg()');
    await expect.poll(() => rows.length, { timeout: 6000 }).toBe(2);
    expect(rows.map((r) => [r.name, r.type_preference, r.price])).toEqual([['Spec Rider', 'None', 40], ['Lina Guest', 'None', 40]]);
  });

  test('a code comes off the seat, in the preview as on the stored rows', async ({ page }) => {
    await rider(page);
    const r = await page.evaluate(`(()=>{S.selEvent='event';S.selSession=${JSON.stringify(EV.id)};S.regQty=2;ensureBikeSizes();
      S.promoApplied={code:'HALF',kind:'pct',value:50};
      const e=[{price:40,typePreference:'None'},{price:40,typePreference:'None'}];_applyPromoToEntries(e);
      return {disc:_regPromoDisc(),grand:_regGrandStr(allSessions().find(s=>s.id===${JSON.stringify(EV.id)})),rows:e.map(x=>x.price)};})()`) as { disc: number; grand: string; rows: number[] };
    expect(r.disc).toBe(40);        // half of 2 x 40 - it used to be half of two bike fares
    expect(r.grand).toContain('40');
    expect(r.rows).toEqual([20, 20]);
  });

  test('Edit opens a step the ride has: an event its seats, a workshop its waiver, the circuit its riders', async ({ page }) => {
    await rider(page);
    const steps = await page.evaluate(`[${JSON.stringify(EV.id)},${JSON.stringify(WS.id)},${JSON.stringify(JCC.id)}].map(id=>{const s=allSessions().find(x=>x.id===id);_on_renderBookingTicket_1(null,null,_evOf(s),id);return S.regStep;})`);
    expect(steps).toEqual([2, 2.5, 2]);
  });
});

test.describe('@customer:reserve book my usual', () => {
  test('"Book my usual" skips a night the booking window has not opened', async ({ page }) => {
    const far = { ...JCC, id: d(9), session_date: d(9), day: 'Monday' };
    const near = { ...JCC, id: d(2), session_date: d(2), day: 'Saturday', bike_slots: '{"_time":"18:00 - 20:00","_total":20}' };
    // the rider's usual is 21:00, which only the far night has; the window is three days
    await rider(page, { sessions: [far, near], queue_entries: [{ id: 'old', customer_id: 'c1', session_id: 'past', session_date: '2026-01-01', status: 'done', queue_num: 1, name: 'Spec Rider', type_preference: 'Road' }] });
    await page.evaluate(`S.sessions.push({id:'past',session_date:'2026-01-01',day:'Thursday',status:'closed',bike_slots:'{"_time":"21:00 - 23:00","_total":20}'});S._bw={days:3,at:null}`);
    expect(await page.evaluate(`_bwOpen(allSessions().find(s=>s.id===${JSON.stringify(far.id)}))`)).toBe(false);
    await page.evaluate('bookMyUsual()');
    expect(await page.evaluate('S.selSession')).toBe(near.id); // not the far night: the list does not offer it
  });
});

test.describe('my rides on a phone set to London', () => {
  test.use({ timezoneId: 'Europe/London' });
  test('the week streak runs across a clock change', async ({ page }) => {
    await rider(page);
    // thirty Sundays back from this week, KSA days: they cross the March 2026 change in London
    const n = await page.evaluate(`(()=>{const t=todayStr(),out=[];for(let k=0;k<30;k++){const x=new Date(t+'T12:00:00Z');x.setUTCDate(x.getUTCDate()-7*k);out.push({sessionDate:x.toISOString().slice(0,10)});}return _mrStreak(out);})()`);
    expect(n).toBe(30);
  });
});

test.describe('@customer:account nameless account', () => {
  test('an account with no name on it still draws its page', async ({ page }) => {
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await rider(page, { 'rpc:customer_about': [{ profession: null, workplace: null, heard_from: null }] }, { name: null, photo: null });
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#acc-photo-img')).toBeVisible();
    expect(errs.filter((m) => /split|name/i.test(m))).toEqual([]);
  });
});

test.describe('@staff:sessions event clone and templates', () => {
  test('cloning an event makes an event, with its price, words and audience', async ({ page }) => {
    await staff(page);
    const r = await page.evaluate(`(()=>{S.newSessDesc='typed before';S.newSessPrice='99';cloneSession(${JSON.stringify(EV.id)});
      const ev={k:S.newSessEvent,p:S.newSessPrice,d:S.newSessDesc,o:S.newSessOpenAll};
      cloneSession(${JSON.stringify(JCC.id)});
      return {ev,jcc:{k:S.newSessEvent,p:S.newSessPrice,d:S.newSessDesc,o:S.newSessOpenAll}};})()`);
    expect(r).toEqual({ ev: { k: 'event', p: '40', d: 'Bring your own bike.', o: false }, jcc: { k: 'jcc', p: '', d: '', o: true } });
  });

  test('a template keeps an event\'s price and words, and one without them clears what was typed', async ({ page }) => {
    await staff(page);
    const r = await page.evaluate(`(()=>{
      S.staffOptions=S.staffOptions||{};
      S.staffOptions.session_templates=[
        {id:'t1',label:'Members class',form:{newSessEvent:'event',newSessTitle:'Class',newSessPrice:'50',newSessDesc:'Words',newSessOpenAll:false}},
        {id:'t2',label:'Old one',form:{newSessEvent:'event',newSessTitle:'Old'}}];
      _nsTplApply('t1');const a={p:S.newSessPrice,d:S.newSessDesc,o:S.newSessOpenAll};
      _nsTplApply('t2');const b={p:S.newSessPrice,d:S.newSessDesc,o:S.newSessOpenAll};
      return {a,b,keys:['newSessDesc','newSessPrice','newSessOpenAll','newSessKm'].every(k=>NS_TPL_KEYS.includes(k))};})()`);
    expect(r).toEqual({ a: { p: '50', d: 'Words', o: false }, b: { p: '', d: '', o: true }, keys: true });
  });

  test('changing a code reprices an event row from its seat, not from a bike fare', async ({ page }) => {
    await staff(page, {
      queue_entries: [{ id: 'q1', customer_id: 'c1', session_id: EV.id, session_date: EV.session_date, status: 'waiting', queue_num: 1, name: 'Spec Rider', type_preference: 'None', price: 57.5, paid: false, promo_code: 'HALF' }],
      promo_codes: [{ id: 'p1', code: 'HALF', active: true, kind: 'pct', value: 50 }],
    });
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) patches.push(r.postDataJSON() || {}); });
    await page.evaluate(`_syncPromoBookings('HALF')`);
    await expect.poll(() => patches.length).toBeGreaterThan(0);
    expect(patches[0]).toMatchObject({ price: 20 }); // half of the 40 seat (it was half of 57.5)
  });
});
