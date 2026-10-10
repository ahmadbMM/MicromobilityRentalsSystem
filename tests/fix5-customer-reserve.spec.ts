import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, captureBookingRows } from './helpers/supabase';

// The booking form, 2026-10-05 fixes: a type staff hid from the rider, rider 1's name on a solo
// booking, Book my usual on the circuit list only, focus kept across the step's own redraws, the
// server's booking-window and outdated-waiver refusals said in words, the waitlist cap on riders
// added to a booking, and a party queued offline in one stored write.

const S1 = '2099-02-10';
const S2 = '2099-02-17';
const jcc = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_date: id.slice(0, 10), day: 'Tuesday', status: 'open', capacity: 12, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":12}', ...extra,
});
const row = (id: string, sid: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Tuesday', session_date: sid.slice(0, 10), queue_num: 1, name: 'Spec Rider',
  phone: '0500000001', customer_id: 'c1', type_preference: 'Road', status: 'waiting', paid: false, price: 75,
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});
async function open(page: Page, fx: Record<string, unknown> = {}, cust: Record<string, unknown> = {}) {
  const sessions = (fx.sessions as unknown[]) || [jcc(S1)];
  await stubSupabase(page, { 'rpc:list_sessions': sessions, ...fx, sessions });
  await loginCustomer(page, cust);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@customer:reserve fix5 booking form', () => {
  test('a type staff hid from the rider is never seeded, kept or booked', async ({ page }) => {
    await open(page, {}, { type_preference: 'Hybrid', hidden_types: 'Hybrid', height: 175 });
    // the profile's preference does not seed it
    expect(await page.evaluate(`S.regBikeTypes=[];prefillFromAccount();S.regBikeTypes[0]||null`)).toBeNull();
    // carried over from elsewhere, it reads as not chosen, and its pill is not drawn
    await page.evaluate(`S.selEvent='jcc';S.selSession='${S1}';S.regStep=2;S.regBikeHeights=['175'];S.regBikeTypes=['Hybrid'];setCustTab('register')`);
    expect(await page.evaluate('S.regBikeTypes[0]||null')).toBeNull();
    await expect(page.locator('#tab-register [data-type="Hybrid"]')).toHaveCount(0);
    await expect(page.locator('#tab-register [data-type="Road"]')).toHaveCount(1);
    // and the check before the review refuses it however it got into the state
    expect(await page.evaluate(`S.regBikeTypes=['Hybrid'];validateRegInputs()`)).toBe(false);
    expect(await page.evaluate(`S.regBikeTypes=['Road'];validateRegInputs()`)).toBe(true);
  });

  test("rider 1's name typed for a party does not follow a solo booking", async ({ page }) => {
    await open(page, {}, { height: 175 });
    const rows = await captureBookingRows(page);
    await page.evaluate(`S.selEvent='jcc';S.selSession='${S1}';S.regStep=2;S.regQty=2;S.regBikeHeights=['175','170'];S.regBikeTypes=['Road','Road'];S.regRiderNames=['A Friend','Second Rider'];setCustTab('register')`);
    await page.evaluate('changeRegQty(-1)');
    expect(await page.evaluate('[S.regQty,S.regRiderNames[0]===undefined]')).toEqual([1, true]);
    // another event starts from the account holder too
    await page.evaluate(`S.regRiderNames=['A Friend'];selectEvent('jcc')`);
    expect(await page.evaluate('S.regRiderNames[0]===undefined')).toBe(true);
    // and a one-rider booking is filed under the account holder whatever the state holds
    await page.evaluate(`S.selEvent='jcc';S.selSession='${S1}';S.regQty=1;S.regBikeHeights=['175'];S.regBikeTypes=['Road'];S.regRiderNames=['A Friend'];S.waiverOk=true;S._waiverSess='${S1}';submitReg()`);
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0].name).toBe('Spec Rider');
  });

  test('Book my usual shows on the circuit list only', async ({ page }) => {
    // an open Saturday ride too: the community list has a ride on it, where the button used to show
    const sat = { id: '2099-02-14', session_date: '2099-02-14', day: 'Saturday', status: 'open', capacity: 20, created_at: 1, event_kind: 'community', needs_approval: true, bike_slots: '{"_time":"06:30 - 07:00"}' };
    const sessions = [jcc(S1), jcc(S2), jcc('2026-01-06', { status: 'closed' }), sat];
    await open(page, { sessions, queue_entries: [row('d1', '2026-01-06', { status: 'done', paid: true })] }, { height: 175, type_preference: 'Road' });
    await page.evaluate(`S.selEvent='jcc';S.selSession=null;S.regStep=1;setCustTab('register')`);
    await expect(page.locator('#tab-register .cu-usual')).toHaveCount(1);
    await page.evaluate(`S.selEvent='community';renderRegister()`);
    await expect(page.locator('#tab-register .cu-usual')).toHaveCount(0);
  });

  test('the stepper and the waiver tick keep the keyboard focus through the redraw', async ({ page }) => {
    await open(page, {}, { height: 175 });
    await page.evaluate(`S.selEvent='jcc';S.selSession='${S1}';S.regStep=2;S.regBikeHeights=['175'];S.regBikeTypes=['Road'];setCustTab('register')`);
    await page.locator('#reg-qty-inc').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate('S.regQty')).toBe(2);
    await expect(page.locator('#reg-qty-inc')).toBeFocused();
    await page.evaluate(`S.regQty=1;S.regStep=3;renderRegister()`);
    await page.locator('#reg-waiver-cb').focus();
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate('S.waiverOk')).toBe(true);
    await expect(page.locator('#reg-waiver-cb')).toBeFocused();
  });

  test("the booking window's refusal is said in words, with the day it opens", async ({ page }) => {
    await open(page);
    await page.evaluate(`setCustTab('register');_bookRefused({code:'P0001',message:'NOT_OPEN_YET: booking for 2099-02-10 opens on 2099-02-03'},null)`);
    const day = await page.evaluate(`shortDate('2099-02-03')`) as string;
    const box = page.locator('#toast-container');
    await expect(box).toContainText('Booking opens');
    await expect(box).toContainText(day);
    await expect(box).not.toContainText('NOT_OPEN_YET');
  });

  test('a waiver the server no longer takes says the page is out of date', async ({ page }) => {
    await open(page);
    await page.evaluate(`setCustTab('register');_bookRefused({code:'P0001',message:'WAIVER_OUTDATED: the waiver changed'},null)`);
    await expect(page.locator('#toast-container')).toContainText('out of date');
    await expect(page.locator('#toast-container')).not.toContainText('WAIVER_OUTDATED');
  });

  test('riders added to a booking on a full night meet the waitlist cap', async ({ page }) => {
    const full = jcc(S1, { status: 'full', bike_slots: '{"_time":"21:00 - 23:00","_total":12,"_wl":{"m":"count","v":1}}' });
    await open(page, { sessions: [full], queue_entries: [row('w1', S1, { status: 'waitlist', waitlist_num: 1 })] }, { height: 175 });
    const creates: unknown[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/customer_create_booking')) creates.push(r.postData()); });
    await page.evaluate(`S.lastTickets=[];S.selEvent='jcc';S.selSession='${S1}';S.regStep=2;setCustTab('register')`);
    await expect.poll(() => page.evaluate('S.modifyEntryId')).toBe('w1');
    await page.evaluate(`S.regQty=2;ensureBikeSizes();S.regBikeTypes=['Road','Road'];S.regBikeHeights=['175','170'];S.regRiderNames=['Spec Rider','Friend Two'];S.waiverOk=true;S._waiverSess='${S1}';submitModifyBooking()`);
    await expect(page.locator('#toast-container')).toContainText('waitlist for this session is full');
    expect(creates.length).toBe(0);
  });

  test('a party queued offline is stored in one write: all of it or none', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(`(()=>{
      const real=Storage.prototype.setItem;let writes=0;
      Storage.prototype.setItem=function(k,v){if(k==='cq_book_outbox'){writes++;if(JSON.parse(v).length>=3)throw new DOMException('full','QuotaExceededError');}return real.call(this,k,v);};
      try{
        const two=_bookOutboxAddAll([{id:'o1'},{id:'o2'}]),afterTwo=_bookOutbox().length,w=writes;
        localStorage.removeItem('cq_book_outbox');
        const three=_bookOutboxAddAll([{id:'o3'},{id:'o4'},{id:'o5'}]);
        return [two,afterTwo,w,three,_bookOutbox().length];
      }finally{Storage.prototype.setItem=real;}
    })()`);
    // two riders: stored together in one write; three that do not fit: none of them is kept
    expect(r).toEqual([true, 2, 1, false, 0]);
  });
});
