import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The hours string carries invisible word-joiners (U+2060) and non-breaking spaces so the
// time ranges never wrap mid-range; normalize them away before matching the readable text.
const plain = (s: string) => s.replace(/[\u2060\u00a0]/g, (m) => (m === '\u00a0' ? ' ' : ''));


// The rentals pages carry a mini footer: brand + tagline, three ways to reach the booth,
// where and when it is, three policy links, four socials, the legal line with the VAT number.
// Dark on the light site by design. No newsletter, no shop columns, no payment logos.

// Signed in: for a signed-out visitor the sign-in page is the first page and the footer
// waits behind it.
// The footer is a desk-sized thing and is hidden below 768px (see the last test), so every
// test about its content and look measures it at a width where it exists.
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [] });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
});

test('carries exactly the spec content, and nothing of the full footer', async ({ page }) => {
  const f = page.locator('#app-footer');
  await expect(f).not.toContainText('Power your path');   // the tagline was removed on request
  await expect(f).toContainText('+(966) 56 666 8818');
  await expect(f).toContainText('info@micromobility.sa');
  await expect(f).toContainText('Thu Al-Nurayn St, Al Sharafeyah, Jeddah 23218');
  expect(plain(await f.innerText())).toContain('Sat–Thu 14:00–22:00 · Fri closed');
  // the three policy links were removed on request — the footer is contact + legal only
  await expect(f).not.toContainText('Help Center');
  await expect(f).not.toContainText('Privacy Policy');
  await expect(f).not.toContainText('Terms & Conditions');
  await expect(f).toContainText('© 2026 MicroMobility. All Rights Reserved');
  await expect(f).toContainText('VAT No. 312555068900003');
  const txt = await f.innerText();
  expect(txt).not.toMatch(/newsletter|subscribe/i);           // full-footer things stay out
});

test('the four socials, as 40px circles inside 44px touch targets', async ({ page }) => {
  const links = page.locator('.mf-social a');
  await expect(links).toHaveCount(4);
  const hrefs = await links.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs.join('|')).toContain('instagram.com/micromobilitysa');
  expect(hrefs.join('|')).toContain('x.com/micromobilitysa');
  expect(hrefs.join('|')).toContain('tiktok.com/@micromobilitysa');
  expect(hrefs.join('|')).toContain('wa.me/966566668818');
  const sizes = await page.evaluate(`[...document.querySelectorAll('.mf-social a')].map(a=>{
    const r=a.getBoundingClientRect(),c=a.querySelector('.mf-circle').getBoundingClientRect();
    return {tap:Math.round(Math.min(r.width,r.height)),circle:Math.round(c.width)};})`) as { tap: number; circle: number }[];
  for (const s of sizes) { expect(s.tap).toBeGreaterThanOrEqual(44); expect(s.circle).toBe(40); }
});

test('dark surface with the locked palette, on the light site', async ({ page }) => {
  const bg = await page.evaluate(`getComputedStyle(document.getElementById('app-footer')).backgroundColor`);
  expect(bg).toBe('rgb(17, 21, 17)');                          // #111511
});

test('arabic: full translation, phone and VAT stay LTR', async ({ page }) => {
  await page.evaluate(`setLang('ar')`);
  await page.waitForTimeout(600);
  const f = page.locator('#app-footer');
  await expect(f).toContainText('شارع ذي النورين، الشرفية، جدة 23218');
  expect(plain(await f.innerText())).toContain('السبت–الخميس 14:00–22:00');
  await expect(f).toContainText('جميع الحقوق محفوظة');
  await expect(f).toContainText('الرقم الضريبي: 312555068900003');
  const dirs = await page.evaluate(`[...document.querySelectorAll('#app-footer .mf-ltr')].map(e=>getComputedStyle(e).direction)`) as string[];
  expect(dirs.length).toBeGreaterThanOrEqual(2);
  for (const d of dirs) expect(d).toBe('ltr');                 // digits hold their direction in RTL
});

test('the spec integration event works: mm-lang flips the language', async ({ page }) => {
  await page.evaluate(`localStorage.setItem('mm_lang','ar');window.dispatchEvent(new Event('mm-lang'))`);
  await page.waitForTimeout(600);
  await expect(page.locator('#app-footer')).toContainText('شارع ذي النورين');   // the address, in Arabic
});

test('small screens: the footer is not there at all', async ({ page }) => {
  // On a phone the footer was a screen of its own that a rider scrolled past to reach
  // nothing, and the bottom bar already carries the way around. Everything it holds - the
  // address, the phone, the hours - is on the contact card and the meeting-point link.
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.locator('#app-footer')).toBeHidden();
  // and the page below it does not scroll sideways in its absence
  const overflow = await page.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('it is still there on a desk screen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('#app-footer')).toBeVisible();
});
