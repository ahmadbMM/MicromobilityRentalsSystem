import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Checking in and out on a session without bikes says nothing about bikes (the owner, 2026-11-27: "change all non bike
// related to not include anything related to bikes especially when checking in and out"). A yoga morning's check-in
// shows no height, size, type or last bike; the roster says Checked in, not On bike; nobody is "out over 2 h"; the
// close-out speaks of participants; a bike session keeps every bike word.
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const BIKE = /\b(bike|bikes|cycling|cyclist|ride|rides|rider|riders)\b/i;
const sess = (id: string, kind: string | null) => ({ id, day: 'Friday', session_date: today, capacity: 20, status: 'open', created_at: 1,
  ...(kind ? { ride_kind: kind, event_kind: 'community', paid_ride: true, price: 40, open_to_all: true, needs_approval: false, title: 'Morning yoga' } : {}),
  bike_slots: '{"_time":"00:00 - 23:59"}' });
const row = (id: string, sid: string, qn: number, extra: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Friday', session_date: today, queue_num: qn, name: 'Sam Jones ' + qn, phone: '', customer_id: null,
  status: 'waiting', paid: true, price: 40, height: 172, type_preference: 'Road', registered_at: today + 'T05:00:00Z', ...extra });
const long = { status: 'active', checked_in_at: new Date(Date.now() - 3 * 3600e3).toISOString() };

async function boot(page: import('@playwright/test').Page, kind: string | null) {
  const sid = kind ? today + '-yg' : today;
  await stubSupabase(page, { sessions: [sess(sid, kind)], queue_entries: [row('w1', sid, 1), row('a1', sid, 2, long)], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length===2`);
  await page.evaluate(`S.staffTab='queue';S.sfSession=${JSON.stringify(sid)};renderStaffQueue()`);
  return sid;
}

test.describe('@staff:bookings a session without bikes at check-in and check-out', () => {
  test('yoga: the drawer, the roster and the close-out name no bike, size or rider', async ({ page }) => {
    const sid = await boot(page, 'yoga');
    // the roster: Checked in, no two-hour warning, no On bike figure
    const tab = page.locator('#tab-queue');
    await expect(tab.locator('.status-badge', { hasText: 'Checked in' }).first()).toBeVisible();
    await expect(tab.locator('.status-badge', { hasText: /On bike/i })).toHaveCount(0);
    await expect(tab.locator('.overdue-banner')).toHaveCount(0);
    await expect(tab.locator('.rq-el-late')).toHaveCount(0);
    await expect(tab.locator('.q-lc-nums')).not.toContainText(/On bike/i);
    expect(await page.evaluate(`_ntKindsNow().filter(k=>k.k==='long').reduce((a,k)=>a+k.ids.length,0)`).catch(() => 0)).toBe(0);
    // the drawer: no height row, no type, no bike field
    await page.evaluate(`showCheckinModal('w1')`);
    const m = page.locator('#checkin-modal .modal-box');
    await expect(m).toBeVisible();
    await expect(m.locator('.bkm-hrow')).toHaveCount(0);
    await expect(m.locator('.prd-last')).toHaveCount(0);
    await expect(m.locator('#ci-bike')).toHaveCount(0);
    await expect(m).not.toContainText(BIKE);
    await expect(m).not.toContainText('172');
    // a bike tag scanned meanwhile does not go into this check-in
    await page.evaluate(`_ciReceiveBike({found:true,bike:{id:'b1',name:'Road 1',bike_number:7,type:'Road',status:'available'}})`);
    expect(await page.evaluate(`!!S._ciBike`)).toBe(false);
    await page.evaluate(`closeCheckinModal(true)`);
    // the scanner's details list: names only
    expect(await page.evaluate(`(_scanDetailsPaint(_scanDetailsOf(_qGet('w1'))),1)`)).toBe(1);
    // close-out speaks of participants
    await page.evaluate(`closeOutSession(${JSON.stringify(sid)})`);
    const ck = page.locator('#desk-sheet');
    await expect(ck).not.toContainText(BIKE); // the close-night checklist comes first, without its bike items
    await ck.locator('.ck-go').click();
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box).toContainText('participant');
    await expect(box).not.toContainText(BIKE);
  });

  test('a bike session keeps its words: On bike, the height and size, the two-hour warning', async ({ page }) => {
    await boot(page, null);
    const tab = page.locator('#tab-queue');
    await expect(tab.locator('.status-badge', { hasText: /On bike/i }).first()).toBeVisible();
    await expect(tab.locator('.overdue-banner')).toHaveCount(1);
    await page.evaluate(`showCheckinModal('w1')`);
    await expect(page.locator('#checkin-modal .bkm-hrow')).toContainText('172');
  });
});
