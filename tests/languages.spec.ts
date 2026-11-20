import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, waitForSb } from './helpers/supabase';

/** The built packs are the expected values — a word copied here would only be a staler copy. */
const pack = (code: string) =>
  JSON.parse(readFileSync(resolve(__dirname, `../lang/${code}.json`), 'utf8')) as Record<string, string>;

const fixtures = { sessions: [], bikes: [], queue_entries: [] };
const CODES = ['ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn', 'ms'];

// The site speaks eleven languages. The header control is a native <select> listing each one
// by its own name; Arabic and Urdu flip the page right-to-left; the rest read left-to-right.
test.describe('the language dropdown', () => {
  test('lists all eleven languages by their own name and switches the page', async ({ page }) => {
    await stubSupabase(page, fixtures);
    await page.goto('/');
    await waitForSb(page);
    const sel = page.locator('select#lang-btn');
    await expect(sel).toHaveValue('en');
    expect(await sel.locator('option').allTextContents()).toEqual([
      'English', 'العربية', 'Français', 'Español', 'Português', 'اردو', 'हिन्दी', 'Tagalog', 'नेपाली', 'বাংলা', 'Bahasa Melayu',
    ]);
    await sel.selectOption('fr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('#land-sub')).toHaveText(pack('fr').landingSub);
    await expect(sel).toHaveValue('fr');
    expect(new URL(page.url()).searchParams.get('lang')).toBe('fr');
  });

  test('Urdu reads right-to-left like Arabic; Hindi does not', async ({ page }) => {
    await stubSupabase(page, fixtures);
    await page.goto('/');
    await waitForSb(page);
    await page.locator('#lang-btn').selectOption('ur');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('#land-sub')).toHaveText(pack('ur').landingSub);
    await page.locator('#lang-btn').selectOption('hi');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
    await expect(page.locator('#land-sub')).toHaveText(pack('hi').landingSub);
  });

  test('every pack loads and paints its own strings, none falls back to English', async ({ page }) => {
    await stubSupabase(page, fixtures);
    await page.goto('/');
    await waitForSb(page);
    for (const code of CODES) {
      await page.evaluate(`setLang('${code}')`);
      await expect.poll(() => page.evaluate(`t('tabReserve')`)).toBe(pack(code).tabReserve);
      expect(pack(code).tabReserve).not.toBe('Reserve');
      // weekday names come from the browser in the visitor's language, never from a table
      expect(await page.evaluate(`dayLabel('Sunday')`)).not.toBe('Sunday');
    }
  });

  test('the account screen lists the same eleven languages', async ({ page }) => {
    await stubSupabase(page, fixtures);
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate('LANGS.length')).toBe(11);
    expect(await page.evaluate(`LANGS.map(l=>l.code).join(',')`)).toBe('en,ar,fr,es,pt,ur,hi,tl,ne,bn,ms');
  });
});

// With nothing remembered on the device, the site opens in the language the phone is set
// to — mapped onto the ten we carry — and only falls back to English when none matches.
test.describe('the device language', () => {
  test.describe('a Malaysian phone', () => {
    test.use({ locale: 'ms-MY' });
    test('opens in Malay, with Malay dates and Latin digits', async ({ page }) => {
      await stubSupabase(page, fixtures);
      await page.goto('/');
      await waitForSb(page);
      expect(await page.evaluate('S.lang')).toBe('ms');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ms');
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.locator('#land-sub')).toHaveText(pack('ms').landingSub);
      await expect(page.locator('#lang-btn')).toHaveValue('ms');
      expect(await page.evaluate(`dayLabel('Sunday')`)).toBe('Ahad');
      expect(await page.evaluate(`new Date('2026-11-20T12:00:00Z').toLocaleDateString(_locale(),{day:'numeric',month:'long'})`)).toBe('20 November');
    });
  });

  test.describe('a Spanish phone', () => {
    test.use({ locale: 'es-ES' });
    test('opens in Spanish without being asked', async ({ page }) => {
      await stubSupabase(page, fixtures);
      await page.goto('/');
      await waitForSb(page);
      expect(await page.evaluate('S.lang')).toBe('es');
      await expect(page.locator('#land-sub')).toHaveText(pack('es').landingSub);
      await expect(page.locator('#lang-btn')).toHaveValue('es');
    });

    test('a pick from the dropdown is remembered over the device language', async ({ page }) => {
      await stubSupabase(page, fixtures);
      await page.goto('/');
      await waitForSb(page);
      await page.locator('#lang-btn').selectOption('fr');
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
      await page.reload();
      await waitForSb(page);
      expect(await page.evaluate('S.lang')).toBe('fr');
    });

    test('a shared ?lang link beats both the device and the remembered pick', async ({ page }) => {
      await stubSupabase(page, fixtures);
      await page.addInitScript(() => { localStorage.setItem('cq_lang', 'fr'); localStorage.setItem('cq_lang_pick', '1'); });
      await page.goto('/?lang=ne');
      await waitForSb(page);
      expect(await page.evaluate('S.lang')).toBe('ne');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ne');
    });
  });

  test.describe('a Brazilian phone', () => {
    test.use({ locale: 'pt-BR' });
    test('opens in Portuguese', async ({ page }) => {
      await stubSupabase(page, fixtures);
      await page.goto('/');
      await waitForSb(page);
      expect(await page.evaluate('S.lang')).toBe('pt');
    });
  });

  test.describe('a Filipino phone', () => {
    test.use({ locale: 'fil-PH' });
    test('opens in Tagalog — iOS and Android call the language "fil"', async ({ page }) => {
      await stubSupabase(page, fixtures);
      await page.goto('/');
      await waitForSb(page);
      expect(await page.evaluate('S.lang')).toBe('tl');
    });
  });

  test.describe('a Japanese phone', () => {
    test.use({ locale: 'ja-JP' });
    test('falls back to English when the device language is not one we carry', async ({ page }) => {
      await stubSupabase(page, fixtures);
      await page.goto('/');
      await waitForSb(page);
      expect(await page.evaluate('S.lang')).toBe('en');
    });
  });

  test.describe('a Hindi phone that used the site before', () => {
    test.use({ locale: 'hi-IN' });
    // Before the dropdown every boot wrote 'en' back into storage. That must not pin a Hindi
    // phone to English forever: a remembered 'en' counts only once the visitor picked it.
    test('an automatically stored "en" does not pin the site to English', async ({ page }) => {
      await stubSupabase(page, fixtures);
      await page.addInitScript(() => localStorage.setItem('cq_lang', 'en'));
      await page.goto('/');
      await waitForSb(page);
      expect(await page.evaluate('S.lang')).toBe('hi');
    });

    test('an English pick made by hand does', async ({ page }) => {
      await stubSupabase(page, fixtures);
      await page.addInitScript(() => { localStorage.setItem('cq_lang', 'en'); localStorage.setItem('cq_lang_pick', '1'); });
      await page.goto('/');
      await waitForSb(page);
      expect(await page.evaluate('S.lang')).toBe('en');
    });

    test('a remembered Arabic from before the dropdown still counts as a choice', async ({ page }) => {
      await stubSupabase(page, fixtures);
      await page.addInitScript(() => localStorage.setItem('cq_lang', 'ar'));
      await page.goto('/');
      await waitForSb(page);
      expect(await page.evaluate('S.lang')).toBe('ar');
    });
  });
});
