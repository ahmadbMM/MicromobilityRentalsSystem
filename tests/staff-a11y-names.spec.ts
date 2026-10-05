import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff accessibility pass (2026-10-04): every popup has a name, a repaint gives the focus back,
// a section change is said or focused, the cards and chips a pointer taps work from the keyboard,
// the error bar is not inside the polite region, and times read right in Urdu.

const S1 = '2099-01-01', S2 = '2099-01-02';
const slots = JSON.stringify({ _time: '21:00 - 23:00', _total: 40 });
const sessions = [
  { id: S1, session_date: S1, day: 'Thursday', status: 'open', capacity: 20, created_at: 1, bike_slots: slots },
  { id: S2, session_date: S2, day: 'Friday', status: 'open', capacity: 20, created_at: 2, bike_slots: slots },
];
const bikes = [{ id: 'bM', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: [] }];
const e = (id: string, x: Record<string, unknown> = {}) => ({
  id, session_id: S1, session_day: 'Thursday', session_date: S1, queue_num: 1, name: 'R ' + id,
  phone: '0550000001', type_preference: 'Road', size: 'M', status: 'waiting', paid: false,
  price: 75, registered_at: '2099-01-01T10:00:00Z', ...x });

async function boot(page: Page, height = 900) {
  await page.setViewportSize({ width: 1200, height });
  await stubSupabase(page, { sessions, bikes, queue_entries: [e('a1'), e('a2', { queue_num: 2, name: 'Second Rider' })] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>1&&getBikes().length>0`);
  await page.evaluate(`S.staffRole='admin';setStaffTab('queue');S.queueView='bookings';S.sfSession='${S1}';renderStaffQueue()`);
  await page.waitForTimeout(250);
}

test.describe('@staff:a11y names, focus and keyboard', () => {
  test('the check-in popup has a name and keeps its focus and scroll when the roster repaints', async ({ page }) => {
    await boot(page, 420); // short: the popup scrolls
    await page.evaluate(`showCheckinModal('a1')`);
    const dlg = page.locator('#checkin-modal [role="dialog"]');
    await expect(dlg).toHaveAccessibleName(/R a1/);
    await expect.poll(() => dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.waitForTimeout(400); // the focus manager (40 ms) and the modal's own first focus (120 ms) have had their turn
    const before = await page.evaluate(async () => {
      const box = document.querySelector('#checkin-modal [role="dialog"]') as HTMLElement;
      const sc = [box, ...box.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY !== 'visible') as HTMLElement;
      const btn = [...box.querySelectorAll('button[data-on-click]')].pop() as HTMLElement; // the last control, down the popup
      btn.focus();
      if (sc) sc.scrollTop = sc.scrollHeight;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { top: sc ? sc.scrollTop : 0, on: btn.getAttribute('data-on-click'), scrolls: !!sc };
    });
    expect(before.scrolls, 'the popup scrolls at this height').toBe(true);
    expect(before.top).toBeGreaterThan(20);
    const after = await page.evaluate(async () => {
      const old = document.querySelector('#checkin-modal [role="dialog"]');
      // @ts-expect-error app global
      renderStaffQueue(); // a roster repaint redraws the open check-in popup
      await null;
      await new Promise((r) => requestAnimationFrame(r));
      const box = document.querySelector('#checkin-modal [role="dialog"]') as HTMLElement;
      const sc = [box, ...box.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY !== 'visible') as HTMLElement;
      const ae = document.activeElement as HTMLElement;
      return { redrawn: box !== old, top: sc.scrollTop, on: ae && ae.getAttribute('data-on-click'), inside: box.contains(ae) };
    });
    expect(after.redrawn).toBe(true);
    expect(after.inside).toBe(true);
    expect(after.on).toBe(before.on);
    expect(Math.abs(after.top - before.top)).toBeLessThan(3);
  });

  test('a roster row written again gives the focus back to the same button', async ({ page }) => {
    await boot(page);
    const sel = '#tab-queue [data-on-click*="showCheckinModal"][data-on-click*="a2"]';
    await page.locator(sel).first().focus();
    const r = await page.evaluate((s) => {
      const old = document.querySelector(s);
      // @ts-expect-error app global
      getQueue().find((x) => x.id === 'a2').name = 'Renamed Rider'; renderStaffQueue();
      const ae = document.activeElement as HTMLElement;
      return { replaced: !old!.isConnected, same: ae && ae.matches(s), row: ae && (ae.closest('tr,[data-ck]') as HTMLElement)?.textContent?.includes('Renamed Rider') };
    }, sel);
    expect(r.replaced, 'the row was written again, not patched').toBe(true);
    expect(r.same).toBe(true);
    expect(r.row).toBe(true);
  });

  test('a section opened from the rail takes the focus to its title; one opened from code leaves the focus alone', async ({ page }) => {
    await boot(page);
    await page.locator('#staff-tab-nav .tab-btn[data-stab="inventory"]').focus();
    await page.evaluate(`setStaffTab('inventory')`);
    await expect(page.locator('#tab-inventory .page-title').first()).toBeFocused();
    // a section without a title: the focus stays on the rail and the section's name is said
    await page.locator('#staff-tab-nav .tab-btn[data-stab="cashier"]').focus();
    await page.evaluate(`setStaffTab('cashier')`);
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="cashier"]')).toBeFocused();
    await expect(page.locator('#toast-live')).toContainText((await page.locator('#staff-tab-nav .tab-btn[data-stab="cashier"] .snav-lbl').textContent()) || 'Sales');
    // from code (a link, boot), not from the rail: the focus is not moved, the section is only said
    const moved = await page.evaluate(`(()=>{document.activeElement.blur();setStaffTab('analytics');return document.activeElement!==document.body;})()`);
    expect(moved).toBe(false);
  });

  // 2026-10-05: the strip's chips and the session forms' bike cards are real <button>s (their parts are spans:
  // a button holds phrasing content only); the bike picker's table rows stay rows, focusable, answering Enter.
  test('session chips and bike cards are real buttons; the bike picker\'s rows answer Enter like a click', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.sfSession='all';renderStaffQueue()`);
    const chip = page.locator(`#tab-queue button.sess-summary-chip[data-on-click*="${S2}"]`).first();
    await expect(chip).toHaveAttribute('type', 'button');
    await expect(chip).not.toHaveAttribute('role', /.*/);
    await expect(chip).not.toHaveAttribute('tabindex', /.*/);
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate('S.sfSession')).toBe(S2);
    await expect(page.locator(`#tab-queue button.sess-summary-chip[data-on-click*="${S2}"]`).first()).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(`document.querySelectorAll('#tab-queue button.sess-summary-chip :is(div,p,ul,ol,table,section)').length`)).toBe(0);
    // every toggle pill says whether it is on
    const pills = page.locator('#tab-queue .filter-pill');
    expect(await pills.count()).toBeGreaterThan(1);
    for (const p of await pills.all()) await expect(p).toHaveAttribute('aria-pressed', /^(true|false)$/);
    // the new-session form's bike cards: a button to pick, Space as well as a tap
    await page.evaluate(`S.queueView='sessions';renderStaffQueue();S.showAddSession=true;S.editSessionId=null;S.newSessMode='fleet';S.newSessAssignedIds=[];renderSessions()`);
    const card = page.locator('#sess-add-form button.bike-assign-card').first();
    await expect(card).toHaveAttribute('type', 'button');
    await expect(card).toHaveAttribute('aria-pressed', 'false');
    await card.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate('S.newSessAssignedIds.length')).toBe(1);
    await expect(page.locator('#sess-add-form button.bike-assign-card').first()).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(`document.querySelectorAll('#sess-add-form button.bike-assign-card div').length`)).toBe(0);
    // the bike picker's rows: still table rows (a row cannot be a button), Enter picks
    await page.evaluate(`S.showAddSession=false;S.queueView='bookings';renderStaffQueue();openModal('a1')`);
    const tr = page.locator('#bike-modal tr.bkm-tr[tabindex="0"]').first();
    await expect(tr).toBeVisible();
    await tr.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate('S.modalBikes.length')).toBe(1);
  });

  test('the error bar is an alert outside the polite region; toasts are said through #toast-live', async ({ page }) => {
    await boot(page);
    await page.evaluate(`errorBar('Could not save the booking');toast('Saved')`);
    const bar = page.locator('#err-bar-el');
    await expect(bar).toHaveAttribute('role', 'alert');
    expect(await bar.evaluate((b) => !!b.closest('[aria-live]'))).toBe(false);
    await expect(page.locator('#toast-live')).toContainText('Saved');
  });

  test('times read in Urdu day parts, Arabic and English unchanged; a pasted PIN goes into the keypad', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`(()=>{const o={};for(const l of ['en','ar','ur']){S.lang=l;o[l]=fmt12h('06:30 - 21:00');}S.lang='en';return o;})()`);
    expect(r).toEqual({ en: '6:30 AM - 9 PM', ar: '6:30 ص - 9 م', ur: '6:30 صبح - 9 رات' });
    const digits = await page.evaluate(() => {
      S._opg = { pick: 'Spec Staff', digits: '', msg: '', list: [{ name: 'Spec Staff', has_pin: true }] };
      const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
      Object.defineProperty(ev, 'clipboardData', { value: { getData: () => ' 1 2a3 ' } });
      document.dispatchEvent(ev);
      const d = S._opg.digits; S._opg = null; return d;
    });
    expect(digits).toBe('123');
  });
});
