import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-14 (s06: the booking wizard, tickets, the rating page): "Book my usual" seeds only a bike the
// night offers; a sole ride whose booking window is shut is not picked for the rider; a refused edit gives its
// Confirm back; a rating call that throws does not leave the forced page saving for ever.

const d = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const JCC = { id: d(1), day: 'Thursday', session_date: d(1), capacity: 20, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' };
const ND = { id: d(9) + '-nd', day: 'Friday', session_date: d(9), capacity: 40, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'snd96', open_to_all: true, paid_ride: true, needs_approval: false, bike_slots: '{"_time":"20:00 - 22:00"}' };

async function rider(page: Page, extra: Record<string, unknown> = {}, cust: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [JCC, ND], queue_entries: [], bikes: [], ...extra });
  await loginCustomer(page, cust);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@bh14 s06 booking wizard', () => {
  test('"Book my usual" does not seed "My own bike" on a circuit night: the riders step asks for a bike', async ({ page }) => {
    await rider(page, {}, { height: 172, type_preference: 'Own' });
    await page.evaluate('bookMyUsual()');
    expect(await page.evaluate('S.selSession')).toBe(JCC.id);
    expect(await page.evaluate('S.regStep')).toBe(2); // the riders step, not a review showing "Any"
    expect(await page.evaluate('S.regBikeTypes[0]||null')).toBe(null);
  });

  test('"Book my usual" with a usual bike and a height goes to the review as before', async ({ page }) => {
    await rider(page, {}, { height: 172, type_preference: 'Hybrid' });
    await page.evaluate('bookMyUsual()');
    expect(await page.evaluate('S.regStep')).toBe(3);
    expect(await page.evaluate('S.regBikeTypes[0]')).toBe('Hybrid');
  });

  test('a sole ride whose booking window is shut is not picked; the foot says when it opens', async ({ page }) => {
    await rider(page);
    await page.evaluate(`S._bw={days:3,at:null};S.selEvent='snd96';S.selSession=null;S.regStep=1;goCustomer('register');renderRegister()`);
    expect(await page.evaluate('S.selSession')).toBe(null);
    await expect(page.locator('#rf-why')).toBeVisible();
    expect(await page.locator('#rf-why').textContent()).not.toBe(await page.evaluate(`t('pickRideFirst')`));
    await expect(page.locator('#tab-register .mm-reg-foot .btn-primary')).toBeDisabled();
  });

  test('a refused edit gives the Confirm back', async ({ page }) => {
    const rows = [{ id: 'm1', customer_id: 'c1', session_id: JCC.id, session_date: JCC.session_date, day: JCC.day, status: 'waiting', queue_num: 4, name: 'Spec Rider', type_preference: 'Road', height: 175, price: 75, paid: false }];
    await rider(page, { queue_entries: rows, 'rpc:my_bookings': rows });
    await page.evaluate(`S.selEvent='jcc';S.selSession=${JSON.stringify(JCC.id)};S.regStep=3;goCustomer('register');renderRegister()`);
    expect(await page.evaluate('!!S.modifyEntryId')).toBe(true);
    await page.evaluate(`S.regBikeTypes[0]='Hybrid';window._ownEntryUpdate=async()=>({error:{message:'denied'}})`);
    await page.evaluate('submitModifyBooking()');
    expect(await page.evaluate('S.regSubmitting')).toBe(false);
    await expect(page.locator('#tab-register .mm-reg-foot .btn-primary')).toBeEnabled();
  });
});

test.describe('@bh14 s06 rating page', () => {
  test('a rating call that throws says so and lets the rider try again', async ({ page }) => {
    const done = { id: 'r1', customer_id: 'c1', session_id: JCC.id, session_date: JCC.session_date, day: JCC.day, status: 'done', queue_num: 2, name: 'Spec Rider', type_preference: 'Road', price: 75, paid: true };
    await rider(page, { queue_entries: [done], 'rpc:my_bookings': [done] });
    const r = await page.evaluate(`(async()=>{openRateModal('r1',false);const g=S._rg;['service','bike','experience'].forEach(k=>g.s[k]=10);
      window._ownEntryUpdate=async()=>{throw new Error('net');};await submitRating();return {saving:g.saving,net:g.net,open:S._rg===g};})()`);
    expect(r).toEqual({ saving: false, net: true, open: true });
  });
});
