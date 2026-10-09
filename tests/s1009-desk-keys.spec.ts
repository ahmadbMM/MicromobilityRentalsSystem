import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Front desk 2026-10-09 (s1009-desk), D9: the desk's keys work with the check-in drawer open ([ ] for the
// previous and next rider, 1 2 3 for the payment, X for No-show), J/K and Enter walk the roster, keys are
// matched on their place (an Arabic layout presses the same ones), the device's "keyboard shortcuts off"
// is honoured, and a scanner gun's bike code in the search opens that bike. Invented riders only.

const SID = 's0';
const SESSION = { id: SID, day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 };
const row = (id: string, num: number, x: Record<string, unknown> = {}) => ({
  id, session_id: SID, session_day: 'Friday', session_date: '2099-02-10', queue_num: num, name: 'Rider ' + id.toUpperCase(),
  phone: '', customer_id: null, group_id: null, status: 'waiting', paid: false, price: 57.5, walk_in: true,
  registered_at: `2099-01-01T10:0${num}:00Z`, type_preference: 'Road', size: 'M', ...x,
});
const BIKE = { id: 'b1', name: 'Road 042', bike_number: 42, type: 'Road', size: 'M', status: 'available', colors: ['#000000'], color_names: ['Black'] };

async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { queue_entries: [row('a', 1), row('b', 2), row('c', 3)], sessions: [SESSION], bikes: [BIKE], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('${SID}')`);
  await page.waitForFunction('(S._qOrder||[]).length===3');
}
const blur = (page: Page) => page.evaluate('document.activeElement&&document.activeElement.blur()');

test.describe('@staff:bookings s1009 desk: keyboard', () => {
  test('with the drawer open: ] and [ step riders, 1 2 3 pick the payment, X picks No-show', async ({ page }, ti) => {
    test.skip(ti.project.name === 'mobile', 'a laptop desk: on a phone the check-in is a full dialog that keeps its Bike field focused, and there is no keyboard');
    await boot(page);
    await page.evaluate(`showCheckinModal('a')`);
    await expect(page.locator('#ci-confirm')).toBeVisible();
    await page.waitForTimeout(250); // the drawer's own focus (the Bike field)
    await page.keyboard.press(']'); // from the Bike field too: no bike number holds a bracket
    await expect.poll(() => page.evaluate('S._ciId')).toBe('b');
    await page.waitForTimeout(250); // the next rider's drawer puts focus in its Bike field first, for a scan
    await blur(page);
    await page.keyboard.press('[');
    await expect.poll(() => page.evaluate('S._ciId')).toBe('a');
    await page.waitForTimeout(250);
    await blur(page);
    await page.keyboard.press('3');
    await expect.poll(() => page.evaluate('S._ciPaid')).toBe('house');
    await expect(page.locator('#ci-confirm')).toBeFocused(); // focus rests on Confirm: the next key is a shortcut, Enter confirms
    await page.keyboard.press('1');
    await expect.poll(() => page.evaluate('S._ciPaid')).toBe('pending');
    await expect(page.locator('#ci-confirm')).toBeFocused(); // focus rests on Confirm: the next key is a shortcut, Enter confirms
    await page.keyboard.press('2');
    await expect.poll(() => page.evaluate('S._ciPaid')).toBe('card');
    await expect(page.locator('#ci-confirm')).toBeFocused(); // focus rests on Confirm: the next key is a shortcut, Enter confirms
    await page.keyboard.press('x');
    await expect.poll(() => page.evaluate('S._ciOutcome')).toBe('noshow');
    await expect(page.locator('#ci-out-noshow')).toHaveAttribute('aria-checked', 'true');
  });

  test('digits typed into the Bike field stay a bike number', async ({ page }) => {
    await boot(page);
    await page.evaluate(`showCheckinModal('a')`);
    await page.locator('#ci-bike').fill('');
    await page.locator('#ci-bike').focus();
    await page.keyboard.type('3');
    expect(await page.evaluate('S._ciPaid')).toBe('card');
    await expect(page.locator('#ci-bike')).toHaveValue('3');
  });

  test('J and K walk the roster and Enter opens the marked rider, on the key\'s place (Arabic layout)', async ({ page }) => {
    await boot(page);
    await blur(page);
    await page.keyboard.press('j');
    const cur = page.locator('#q-results .kb-cur');
    await expect(cur).toHaveCount(1);
    const first = await cur.getAttribute('data-id');
    // an Arabic layout: the key at J types "ت", its code is still KeyJ
    await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ت',code:'KeyJ',bubbles:true}))`);
    await expect.poll(() => cur.getAttribute('data-id')).not.toBe(first);
    await page.keyboard.press('k');
    await expect.poll(() => cur.getAttribute('data-id')).toBe(first);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate('S._ciId')).toBe(first);
  });

  test('keyboard shortcuts off on this device (cq_kb_off): the new keys do nothing', async ({ page }) => {
    await boot(page);
    await page.evaluate(`localStorage.setItem('cq_kb_off','1')`);
    await blur(page);
    await page.keyboard.press('j');
    await expect(page.locator('#q-results .kb-cur')).toHaveCount(0);
    await page.evaluate(`showCheckinModal('a')`);
    await blur(page);
    await page.keyboard.press(']');
    await page.waitForTimeout(200);
    expect(await page.evaluate('S._ciId')).toBe('a');
  });

  test('a scanner gun\'s bike URL in the search opens that bike; the list of keys names the new ones', async ({ page }, ti) => {
    test.skip(ti.project.name === 'mobile', 'a scanner gun types into the laptop roster\'s search field');
    await boot(page, { 'rpc:staff_resolve_bike': { found: true, bike: BIKE, rented_to: null } });
    const s = page.locator('#sf-search-input');
    await s.fill('https://micromobility.sa/bikes/42');
    await s.press('Enter');
    await expect(page.locator('#bike-profile-modal')).toHaveCSS('display', 'flex');
    await expect(page.locator('#bike-profile-modal')).toContainText('Road 042');
    expect(await page.evaluate('S.sfSearch')).toBe('');
    await page.evaluate(`closeBikeProfile&&closeBikeProfile()`).catch(() => {});
    await page.evaluate('_kbHelp()');
    const list = page.locator('#confirm-modal .kb-list');
    await expect(list).toContainText('Move through the roster');
    await expect(list).toContainText('Previous / next rider');
    await expect(list).toContainText('Pending / Paid / On the house');
  });
});
