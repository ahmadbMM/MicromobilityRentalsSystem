import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// "Message these riders" in each rider's own language (2026-10-09): the language their community application
// was sent in, else the staff member's. The text is written once per language among them.
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina@example.com', phone: '0551876215', ride_news: true, created_at: '2026-06-10T09:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar@example.com', phone: '0551876216', ride_news: true, created_at: '2026-06-11T09:00:00Z' },
];

async function boot(page: Page) {
  await stubSupabase(page, { customers, tags: [], customer_tags: [], badges: [], customer_badges: [], sessions: [], queue_entries: [], staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S._caApps=[{id:'a1',customer_id:'c2',lang:'ar',status:'approved'}];window.__opened=[];window.open=(u)=>{window.__opened.push(String(u));return null;};setStaffTab('customers');setCustomersTab('accounts')`);
  await page.evaluate(`_amSelMode();S.amSel=new Set(['c1','c2']);renderCommunity()`);
  await page.locator('#am-sel-bar button', { hasText: 'Act on 2' }).click();
  await page.locator('#confirm-modal .seg-tabs button', { hasText: 'Message' }).click();
}

test.describe('@staff:customers messages in each rider\'s language', () => {
  test('one text per language; each chat opens in the rider\'s own', async ({ page }) => {
    await boot(page);
    const langs = page.locator('#confirm-modal .seg-langs button');
    await expect(langs).toHaveText(['English · 1', 'العربية · 1']);
    await expect(langs.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await page.fill('#seg-text', 'Hi {first_name}, the ride starts at 9');
    await langs.nth(1).click();
    await expect(page.locator('#seg-text')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('#seg-text')).toHaveValue(/مرحباً/); // the built-in Arabic opening
    await page.fill('#seg-text', 'مرحباً {first_name}، تبدأ الرحلة الساعة 9');
    await langs.nth(0).click();
    await expect(page.locator('#seg-text')).toHaveValue('Hi {first_name}, the ride starts at 9'); // kept per language
    await page.locator('#confirm-modal button', { hasText: 'Start (2 chats)' }).click();
    await expect(page.locator('#confirm-modal .seg-who')).toContainText('English');
    await page.locator('#confirm-modal button', { hasText: 'Open WhatsApp' }).click();
    await expect(page.locator('#confirm-modal .seg-who')).toContainText('العربية');
    await page.locator('#confirm-modal button', { hasText: 'Open WhatsApp' }).click();
    const opened = (await page.evaluate('window.__opened') as string[]).map((u) => decodeURIComponent(u));
    expect(opened).toHaveLength(2);
    expect(opened[0]).toContain('Hi Lina, the ride starts at 9');
    expect(opened[1]).toContain('مرحباً Omar، تبدأ الرحلة الساعة 9');
  });
});
