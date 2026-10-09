import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, staffReady, waitForSb } from './helpers/supabase';

// The 2026-10-09 accessibility and consistency pass on the staff app (A1-A13, B11, C1-C7 of the deep
// research): the keyboard shortcuts' switch and layout-proof keys, the theme choice, Skip to content,
// the search as a combobox in the dialog system, errors that stay, sortable headers as buttons, the
// focus kept through a repaint, field errors tied to their field, and one money format.

const DAY = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); // tomorrow: a live ride
const fixtures = () => ({
  sessions: [{ id: DAY, session_date: DAY, day: 'Saturday', status: 'open', capacity: 20, created_at: 1 }],
  bikes: [{ id: 'b1', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: ['#111111'], color_names: ['Black'], bike_number: 11 }],
  customers: [{ id: 'c1', name: 'Lina Haddad', phone: '0550000001', email: 'lina@example.com' }],
  queue_entries: [{ id: 'q1', session_id: DAY, session_day: 'Saturday', session_date: DAY, queue_num: 1, name: 'Lina Haddad',
    phone: '0550000001', customer_id: 'c1', type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75,
    registered_at: DAY + 'T10:00:00Z' }],
});

async function boot(page: Page, init: Record<string, string> = {}) {
  await stubSupabase(page, fixtures());
  await page.addInitScript((kv) => {
    localStorage.setItem('cq_staff', '1');
    localStorage.setItem('cq_op_name', 'Spec Staff');
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, init);
  await page.goto('/');
  await staffReady(page);
  await waitForSb(page);
}

test.describe('@staff:a11y the desk by keyboard and screen reader (2026-10-09)', () => {
  test('a shortcut letter works on an Arabic layout, and the switch in Settings turns them all off', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue')`);
    // Arabic layout: the key where a QWERTY I is types "ه"; e.code still says KeyI
    await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ه',code:'KeyI',bubbles:true}))`);
    await expect.poll(() => page.evaluate('S.staffTab')).toBe('inventory');
    await page.evaluate(`setStaffTab('settings')`);
    const kb = page.locator('#set-kb');
    await expect(kb).toBeChecked();
    await kb.uncheck();
    expect(await page.evaluate(`localStorage.getItem('cq_kb_off')`)).toBe('1');
    await page.locator('#set-kb').blur();
    await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'b',code:'KeyB',bubbles:true}))`);
    await page.waitForTimeout(200);
    expect(await page.evaluate('S.staffTab')).toBe('settings'); // B did nothing
  });

  test('Theme offers Light, Dark, Booth and Follow this device, kept on the device', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('settings')`);
    const sel = page.locator('#set-theme');
    await expect(sel).toHaveValue('light');
    await expect(sel.locator('option')).toHaveCount(4);
    await sel.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-staff-theme', 'dark');
    await page.reload();
    await waitForSb(page);
    await expect(page.locator('html')).toHaveAttribute('data-staff-theme', 'dark');
    // the roster's rows take the dark washes, not the paper colours
    await page.evaluate(`setStaffTab('queue');S.sfSession='${DAY}';renderStaffQueue()`);
    const bg = await page.locator('.queue-table tbody tr.row-waiting td, .q-card.row-waiting').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(16, 19, 24)');
  });

  test('Follow this device follows the device', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await boot(page, { cq_staff_theme: 'system' });
    await expect(page.locator('html')).toHaveAttribute('data-staff-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveAttribute('data-staff-theme', /.+/);
  });

  test('Skip to content is the first Tab stop and lands on the section heading', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('settings')`);
    await page.evaluate(`document.activeElement&&document.activeElement.blur()`);
    await page.keyboard.press('Tab');
    const skip = page.locator('#skip-main');
    await expect(skip).toBeFocused();
    await expect(skip).toHaveText('Skip to content');
    await page.keyboard.press('Enter');
    await expect(page.locator('#tab-settings h1.page-title')).toBeFocused();
  });

  test('the search is a combobox: arrows move the selected option, Escape closes it and gives the focus back', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue')`);
    const btn = page.locator('#nt-btn');
    await btn.focus();
    await page.evaluate(`_gsOpen()`);
    const input = page.locator('#gs-input');
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('role', 'combobox');
    await input.fill('Lina');
    await expect(page.locator('#gs-results [role="option"]').first()).toBeVisible();
    await expect(input).toHaveAttribute('aria-activedescendant', 'gs-opt-0');
    await expect(page.locator('#gs-opt-0')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('#gs-panel')).toBeHidden();
    await expect(btn).toBeFocused();
  });

  test('an error toast is an alert that stays while it is pointed at', async ({ page }) => {
    await boot(page);
    await page.evaluate(`toast('Could not save','error')`);
    const tt = page.locator('#toast-container > .toast.error');
    await expect(tt).toHaveAttribute('role', 'alert');
    await page.waitForTimeout(3200);
    await expect(tt).toBeVisible(); // a quiet one is gone after 2.8 s; an error stays 7
  });

  test('History\'s headers sort through buttons and say the order', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('history')`);
    const th = page.locator('#tab-history thead th').filter({ has: page.locator('.q-sort-btn') }).first();
    await expect(th).toBeVisible();
    await th.locator('.q-sort-btn').click();
    await expect(page.locator('#tab-history thead th[aria-sort]').first()).toHaveAttribute('aria-sort', /ascending|descending/);
  });

  test('a repaint keeps the focus on the control that had it (Inventory\'s view toggle)', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('inventory');S.invSection='equipment';renderInventory()`);
    const table = page.locator('#tab-inventory .view-toggle-btn[aria-pressed]').nth(1);
    await table.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#tab-inventory .view-toggle-btn').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tab-inventory .view-toggle-btn').nth(1)).toBeFocused();
  });

  test('Inventory says a missing name at the field', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('inventory');S.invSection='equipment';toggleAddInv();renderInventory()`);
    await page.evaluate(`addInvItem()`);
    const f = page.locator('#inv-name');
    await expect(f).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#inv-name-err')).toBeVisible();
  });

  test('money has one format: thousands grouped, cents only when there are any', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`[_money(12450,_NOISO),_money(57.5,_NOISO),_money(75,_NOISO),_rpSar(1310)]`))
      .toEqual(['SAR 12,450', 'SAR 57.50', 'SAR 75', '<bdi>SAR 1,310.00</bdi>']);
  });
});
