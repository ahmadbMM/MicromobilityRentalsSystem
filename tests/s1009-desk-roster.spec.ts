import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';
// These specs cover the automatic promotion: Settings > Business wl_offer_mode 'auto' (the default is 'staff' since
// 2026-10-09, R7: staff choose who gets a freed place, tests/s1010-remind-waitlist.spec.ts).
const WL_AUTO = [{ key: 'biz', items: { wl_offer_mode: 'auto' } }];

// Front desk 2026-10-09 (s1009-desk), on the roster: No-show in one tap and for a selection, with Select
// all shown (D6); the night's live count at the top (D16); the place a no-show frees told in a centred
// dialog with a WhatsApp link that reaches a local 05 number (B7); the offline banner's staff wording
// (B6). Invented riders only.

const SID = 's0';
const SESSION = { id: SID, day: 'Friday', session_date: '2099-02-10', capacity: 3, status: 'open', created_at: 1 };
const row = (id: string, num: number, status: string, x: Record<string, unknown> = {}) => ({
  id, session_id: SID, session_day: 'Friday', session_date: '2099-02-10', queue_num: num, name: 'Rider ' + id.toUpperCase(),
  phone: '', customer_id: null, group_id: null, status, paid: true, price: 57.5, walk_in: true,
  registered_at: `2099-01-01T10:0${num}:00Z`, type_preference: 'Road', size: 'M', ...x,
});
const ROWS = [
  row('a', 1, 'waiting'), row('b', 2, 'waiting'), row('c', 3, 'active', { checked_in_at: '2099-02-10T18:00:00Z' }),
  row('d', 4, 'done'), row('w', 5, 'waitlist', { waitlist_num: 1, phone: '0551234567', name: 'Waiting Wafa' }),
];

async function boot(page: Page, rows = ROWS) {
  await stubSupabase(page, { staff_options: WL_AUTO, queue_entries: rows, sessions: [SESSION], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('${SID}')`);
}
function patches(page: Page) {
  const out: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) { try { out.push({ url: decodeURIComponent(r.url()), body: r.postDataJSON() }); } catch { /* none */ } }
  });
  return out;
}

test.describe('@staff:bookings s1009 desk: no-show', () => {
  test('D6: a row\'s No-show is one tap, with an Undo', async ({ page }) => {
    await boot(page);
    const p = patches(page);
    await page.evaluate(`confirmNoShow('a')`);
    await expect.poll(() => p.some((x) => x.body.status === 'noshow' && x.url.includes('id=eq.a'))).toBe(true);
    await expect(page.locator('#confirm-modal .confirm-box').filter({ hasText: 'Mark as No-Show' })).toHaveCount(0);
    await page.waitForFunction(`S.undoStack.some(u=>/No-show #1/i.test(u.label))`);
  });

  test('D6: the selection bar has No-show (n) and Select all shown, and the bulk no-show is one Undo', async ({ page }) => {
    await boot(page);
    const p = patches(page);
    await page.evaluate(`S.sfSelected=['a'];renderStaffQueue()`);
    const all = page.locator('#bulk-selall');
    await expect(all).toContainText('Select all shown (3)'); // a, b expected; c on a bike
    await all.click();
    expect(await page.evaluate('S.sfSelected.slice().sort().join()')).toBe('a,b,c');
    const ns = page.locator('#bulk-noshow');
    await expect(ns).toContainText(/No-show \(2\)/i);
    await ns.click();
    await expect.poll(() => p.filter((x) => x.body.status === 'noshow').length).toBe(2);
    await expect(page.locator('#confirm-modal .confirm-box').filter({ hasText: /No-show/i })).toHaveCount(0); // no question first
    await page.waitForFunction(`S.undoStack.some(u=>/No-show · 2/i.test(u.label))`);
    expect(await page.evaluate('S.sfSelected.join()')).toBe('c'); // the rider on a bike stays selected
  });
});

test.describe('@staff:bookings s1009 desk: the night at a glance', () => {
  test('D16: On bike · Booked · Not arrived at the top of the roster, live, each one a filter', async ({ page }) => {
    await boot(page);
    const lc = page.locator('#q-live-count');
    await expect(lc).toBeVisible();
    await expect(lc.locator('.q-lc-active')).toContainText('1');
    await expect(lc.locator('.q-lc-all')).toContainText('4'); // 2 expected + 1 on a bike + 1 back
    await expect(lc.locator('.q-lc-waiting')).toContainText('2');
    expect(await lc.evaluate((el) => getComputedStyle(el).position)).toBe('sticky'); // at the top as it scrolls, never a bar at the foot
    await lc.locator('.q-lc-waiting').click();
    expect(await page.evaluate('S.sfStatus')).toBe('waiting');
    await expect(lc.locator('.q-lc-waiting')).toHaveAttribute('aria-pressed', 'true');
    // a check-in elsewhere (merged as realtime merges it) moves the count on the next paint
    await page.evaluate(`getQueue().find(e=>e.id==='a').status='active';S.queue=S.queue.slice();renderStaffQueue()`);
    await expect(lc.locator('.q-lc-active')).toContainText('2');
    await expect(lc.locator('.q-lc-waiting')).toContainText('1');
  });

  test('B7: the rider a no-show moves up is told in a centred dialog; WhatsApp reaches +966', async ({ page }) => {
    await boot(page);
    await page.evaluate(`doNoShow('a')`);
    const d = page.locator('#promo-nudge');
    await expect(d).toBeVisible();
    await expect(d).toHaveAttribute('role', 'dialog');
    await expect(d).toContainText('Waiting Wafa');
    const href = await d.locator('a.pn-wa').getAttribute('href');
    expect(href).toMatch(/^https:\/\/wa\.me\/966551234567\?text=/);
    // not a fixed bar: it sits in the dialog host, centred over the page
    expect(await page.evaluate(`!!document.querySelector('#confirm-modal #promo-nudge')`)).toBe(true);
    await d.getByRole('button', { name: 'Close' }).first().click();
    await expect(d).toHaveCount(0);
  });

  test('B6: the staff offline banner says what works offline (the desk outbox, 2026-10-10); the customer one keeps its wording', async ({ page }) => {
    await boot(page);
    await page.evaluate(`Object.defineProperty(navigator,'onLine',{value:false,configurable:true});_updateConnUI()`);
    const b = page.locator('#conn-banner');
    await expect(b).toContainText('Check-ins, returns, payments, no-shows and bike hand-overs are saved on this device');
    await page.evaluate(`showView('customer');_updateConnUI()`);
    await expect(b).toContainText('Changes are saved and will sync');
  });
});
