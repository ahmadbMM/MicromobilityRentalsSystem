import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, waitForSb } from './helpers/supabase';

const pack = (c: string) => JSON.parse(readFileSync(resolve(__dirname, `../${c === 'ar' ? 'lang' : 'i18n'}/${c}.json`), 'utf8')) as Record<string, string>;

test.describe('bh14 m: head markup and translation packs @bh14', () => {
  test('the booth popup is a named dialog, its close button named before it first opens', async ({ page }) => {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [] });
    await page.goto('/');
    await waitForSb(page);
    const box = page.locator('#booth-popup .booth-popup-box');
    await expect(box).toHaveAttribute('role', 'dialog');
    await expect(box).toHaveAttribute('aria-labelledby', 'booth-popup-title');
    await expect(page.locator('.booth-popup-close')).toHaveAttribute('aria-label', /.+/);
    await page.evaluate(`_showPopup('Spec title','msg')`);
    await expect(page.getByRole('dialog', { name: 'Spec title' })).toBeVisible();
  });

  test('Arabic names Booth mode and Kiosk mode differently', () => {
    const src = readFileSync(resolve(__dirname, '../app.src.html'), 'utf8');
    const ar = src.slice(src.indexOf('\nar:{'));
    const val = (k: string) => (ar.match(new RegExp(`[,{\\s]${k}:'([^']*)'`)) || [])[1] || '';
    const all = { setBooth: val('setBooth'), kioskEnter: val('kioskEnter') };
    expect(all.setBooth).toBeTruthy();
    expect(all.kioskEnter).toBeTruthy();
    expect(all.setBooth.startsWith(all.kioskEnter)).toBe(false);
  });

  test('the sync age reads in seconds and minutes, not a stray syllable', () => {
    expect(pack('hi').secondsAgo).toContain('सेकंड');
    expect(pack('ne').secondsAgo).toContain('सेकेन्ड');
    expect(pack('bn').secondsAgo).toContain('সেকেন্ড');
  });

  test('Nepali and Bengali text uses the same Latin digits as the rest of the app', () => {
    for (const c of ['ne', 'bn']) {
      const bad = Object.entries(pack(c)).filter(([, v]) => /[०-९০-৯]/.test(v)).map(([k]) => k);
      expect(bad, c).toEqual([]);
    }
  });
});
