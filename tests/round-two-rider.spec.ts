import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, captureBookingRows } from './helpers/supabase';

// Round two of the rider app (the owner's picks, 2026-11-08): Choose a ride as one list (its day switch was removed
// the same day), the tab bar that steps aside while a booking is made (d_smallbars), the booked moment with its polite
// announcement and one short buzz (d_buzz), and the cancel dialog's reasons as a real radio list with nothing picked.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const sess = (d: string, o: Record<string, unknown> = {}) => ({
  id: d, session_date: d, day: DOW[new Date(d + 'T12:00:00Z').getUTCDay()], status: 'open', capacity: 12, created_at: 1, location: 'JCC',
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 12 }), ...o,
});
const TODAY = '2026-09-24', TOMORROW = '2026-09-25';
const days = [sess(TODAY), sess(TOMORROW), sess('2026-09-27'), sess('2026-09-28')];

async function rider(page: Page, sessions: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [], ...extra });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
}
test.describe('@customer:round-two choose a ride', () => {
  // The Today / Tomorrow / Later switch is gone (the user, 2026-11-08: "remove the tomorrow and later filters"):
  // every ride is in one list, a heading a day, and the heading says Today or Tomorrow in words.
  test('every ride in one list with no day switch; the headings say Today and Tomorrow', async ({ page }) => {
    await rider(page, days);
    await page.evaluate(`S.selEvent='jcc';setCustTab('register')`);
    await expect(page.locator('#tab-register .sess-card')).toHaveCount(4);
    await expect(page.locator('#tab-register .reg-days, #tab-register .reg-day, #tab-register .reg-day-pane')).toHaveCount(0);
    const heads = page.locator('#tab-register .sess-day-h');
    await expect(heads).toHaveCount(4); // one heading a day
    await expect(heads.nth(0)).toContainText('Today');
    await expect(heads.nth(1)).toContainText('Tomorrow');
    await expect(heads.nth(2)).toContainText('Sunday');
  });

  test('the Continue bar names the picked ride', async ({ page }) => {
    await rider(page, days);
    await page.evaluate(`S.selEvent='jcc';S.selSession='2026-09-27';setCustTab('register')`);
    await expect(page.locator('#tab-register .sess-selected')).toHaveCount(1);
    await expect(page.locator('#tab-register .mm-reg-foot .reg-foot-sum')).toContainText('Sunday');
    await expect(page.locator('#tab-register .mm-reg-foot .reg-foot-sum')).toContainText('27 Sept');
  });

  test('a list on one day; the picked ride wears the tick', async ({ page }) => {
    await rider(page, [sess('2026-09-28'), sess('2026-09-28-b', { session_date: '2026-09-28', bike_slots: JSON.stringify({ _time: '18:00 - 20:00', _total: 12 }) })]);
    await page.evaluate(`S.selEvent='jcc';setCustTab('register')`);
    await expect(page.locator('#tab-register .sess-card')).toHaveCount(2);
    await expect(page.locator('#tab-register .sess-day-list')).toHaveCount(1); // the day's rides in one list
    await page.locator('#tab-register .sess-card').first().click();
    await expect(page.locator('#tab-register .sess-card.sess-selected .sess-tick')).toBeVisible();
    await expect(page.locator('#tab-register .sess-card.sess-selected')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('@customer:round-two the tab bar steps aside on a phone', () => {
  test.use({ viewport: { width: 390, height: 700 } });
  test('hidden on the booking steps, the Continue bar alone near the bottom; back on the tickets and other tabs', async ({ page }) => {
    const many = Array.from({ length: 8 }, (_, i) => sess(`2099-02-${String(i + 1).padStart(2, '0')}`));
    await rider(page, many);
    await page.evaluate(`S.selEvent='jcc';setCustTab('register')`);
    await page.locator('#tab-register .sess-card').first().click();
    await expect(page.locator('#cust-bottom-nav')).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, 200));
    const btn = page.locator('#tab-register .mm-reg-foot button', { hasText: 'Continue' });
    const box = (await page.locator('#tab-register .mm-reg-foot').boundingBox())!;
    expect(700 - (box.y + box.height)).toBeGreaterThanOrEqual(8);  // off the edge (the safe area's floor)
    expect(700 - (box.y + box.height)).toBeLessThanOrEqual(24);    // and not lifted for a bar that is gone
    const onTop = await btn.evaluate((el) => {
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === el || el.contains(hit));
    });
    expect(onTop).toBe(true);
    await page.evaluate(`setCustTab('myrides')`);
    await expect(page.locator('#cust-bottom-nav')).toBeVisible();
    await page.evaluate(`S.lastTickets=[{id:'t1',queueNum:3,name:'Spec Rider',sessionId:'2099-02-01',sessionDay:'Sunday',sessionDate:'2099-02-01',status:'waiting'}];setCustTab('register')`);
    await expect(page.locator('#tab-register .bk-ok')).toBeVisible();
    await expect(page.locator('#cust-bottom-nav')).toBeVisible(); // the tickets are not a booking step
  });
});

test.describe('@customer:round-two the booked moment', () => {
  async function book(page: Page) {
    await page.addInitScript(() => {
      const w = window as unknown as { __vib: unknown[] };
      w.__vib = [];
      Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p: unknown) => { w.__vib.push(p); return true; } });
    });
    await rider(page, [sess('2099-02-01')]);
    await captureBookingRows(page);
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='2099-02-01';S.regStep=2;
      S.regQty=1;S.regRiderNames=['Spec Rider'];S.regBikeHeights=['175'];S.regBikeTypes=['Road'];ensureBikeSizes();renderRegister()`);
    await page.evaluate(`regNextToReview();toggleWaiver(true)`);
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
  }

  test('a drawn tick, the ride, the number large, the way to the ticket; said politely and buzzed once', async ({ page }) => {
    await book(page);
    const ok = page.locator('#tab-register .bk-ok');
    await expect(ok).toBeVisible();
    await expect(ok.locator('.bk-ok-t')).toHaveText('You’re booked');
    await expect(ok.locator('.bk-ok-disc svg path')).toHaveCount(1);
    await expect(ok.locator('.bk-ok-q b')).toHaveText(/^#\d+$/);
    expect(await ok.locator('.bk-ok-q b').evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toContain('tabular-nums');
    await expect(ok.locator('.bk-ok-btns .btn-primary')).toHaveText('Show my ticket');
    await expect(page.locator('#toast-live')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#toast-live .toast.quiet')).toContainText('Booked, number #');
    expect(await page.evaluate(() => (window as unknown as { __vib: unknown[] }).__vib)).toEqual([30]);
    // it plays on the booking only: a repaint shows it still
    await page.evaluate(`renderRegister()`);
    await expect(page.locator('#tab-register .bk-ok.play')).toHaveCount(0);
    await ok.locator('.bk-ok-btns .btn-primary').click();
    await expect(page.locator('#tab-register .ticket-card').first()).toBeFocused();
  });

  test('no buzz for a rider who asks for reduced motion, and the tick is drawn at once', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await book(page);
    await expect(page.locator('#tab-register .bk-ok')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __vib: unknown[] }).__vib)).toEqual([]);
    expect(await page.locator('#tab-register .bk-ok-disc path').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('Confirm spins inside itself while the booking is on its way, its label kept', async ({ page }) => {
    await rider(page, [sess('2099-02-01')]);
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='2099-02-01';S.regStep=3;S.regQty=1;S.regRiderNames=['Spec Rider'];
      S.regBikeHeights=['175'];S.regBikeTypes=['Road'];ensureBikeSizes();S.waiverOk=true;S._waiverSess=S.selSession;S.regSubmitting=true;renderRegister()`);
    const b = page.locator('#tab-register .mm-reg-foot .btn-primary');
    await expect(b).toHaveAttribute('aria-busy', 'true');
    await expect(b).toHaveText('Confirm booking');
    expect(await b.evaluate((el) => getComputedStyle(el, '::after').animationName)).toBe('mmSpin');
  });
});

test.describe('@customer:round-two the cancel dialog', () => {
  test('one list of real radios, nothing picked, 48px rows; the answers stacked, the cancel first, neither wrapping', async ({ page }) => {
    const e = (id: string, n: number) => ({ id, session_id: '2099-01-01', session_day: 'Thursday', session_date: '2099-01-01', queue_num: n, name: 'Rider ' + id,
      type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2098-12-20T10:00:00Z', customer_id: 'c1' });
    await page.emulateMedia({ reducedMotion: 'reduce' }); // measured still: the dialog settles in on a scale otherwise
    await rider(page, [sess('2099-01-01')], { queue_entries: [e('b1', 1), e('b2', 2)] });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(`showCancelReasonModal('b1')`);
    const m = page.locator('#cancel-reason-modal');
    await expect(m.locator('[role="radiogroup"]')).toHaveAttribute('aria-labelledby', 'cr-title');
    const radios = m.locator('input[type="radio"][name="cr-reason"]');
    expect(await radios.count()).toBeGreaterThanOrEqual(5);
    for (const r of await radios.all()) await expect(r).not.toBeChecked();
    for (const row of await m.locator('.cancel-reason-opt').all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    const [go, keep] = await m.locator('.cr-acts > button').all();
    await expect(go).toHaveText('Cancel the booking for all 2');
    await expect(keep).toHaveText('Keep booking');
    const g = (await go.boundingBox())!, k = (await keep.boundingBox())!;
    expect(k.y).toBeGreaterThan(g.y + g.height - 1); // stacked, the cancel first
    expect(Math.round(g.width)).toBe(Math.round(k.width)); // both the full width
    for (const b of [go, keep]) expect(await b.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().height < 60)).toBe(true);
    // nothing picked: the dialog says so, inside itself
    await go.click();
    await expect(m.locator('#cr-err')).not.toBeEmpty();
    await m.locator('.cancel-reason-opt', { hasText: 'The weather' }).click();
    await expect(m.locator('input[type="radio"]:checked')).toHaveCount(1);
    await expect(m.locator('#cr-err')).toBeEmpty();
  });
});
