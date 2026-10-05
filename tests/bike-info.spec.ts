import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The "i" beside each bike-type pill opens a sheet with the bike's picture, a brief and a rider
// level, and can choose that type. All Supabase traffic is stubbed (helpers/supabase.ts).

const openSession = {
  id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12,
  status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null,
};

async function toRiderStep(page: Page) {
  await stubSupabase(page, { sessions: [openSession] });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  await page.locator('#land-events .landing-event-card.ev-jcc').click();
  await page.locator('.sess-card').first().click();
  await page.locator('button', { hasText: 'Continue' }).first().click();
  await expect(page.locator('[data-type-slot="0"]').first()).toBeVisible();
}

test.describe('bike type info', () => {
  test('every real bike has an "i"; Any is not offered to riders; the pills keep their hooks', async ({ page }) => {
    await toRiderStep(page);
    const types: string[] = await page.evaluate(`Array.from(document.querySelectorAll('[data-type-slot="0"]')).map(b=>b.dataset.type)`);
    expect(types).not.toContain('Any'); // Any is staff's to give (the owner, 2026-10-02)
    await expect(page.locator('#reg-type-wrap-0 .type-info-btn')).toHaveCount(types.filter((t) => t !== 'Any' && t !== 'Own').length);
    expect(await page.locator('.type-info-btn[data-type-slot]').count()).toBe(0);
    await expect(page.locator('#reg-type-wrap-0 .type-info-btn').first()).toHaveAttribute('aria-label', 'About Road bikes');
    // The form says which type is the easy choice.
    await expect(page.locator('#reg-type-wrap-0 .bike-info-hint')).toContainText('Hybrid is the easiest choice');
    // The picker is an even grid: every cell the same width and height, in two or three columns.
    const boxes: number[][] = await page.locator('#reg-type-wrap-0 .type-grid > *').evaluateAll((els) =>
      els.map((e) => { const r = e.getBoundingClientRect(); return [r.width, r.height, Math.round(r.left)]; }));
    expect(boxes.length).toBe(types.length);
    const spread = (i: number) => Math.max(...boxes.map((b) => b[i])) - Math.min(...boxes.map((b) => b[i]));
    expect(spread(0)).toBeLessThan(1.5);
    expect(spread(1)).toBeLessThan(1.5);
    expect([2, 3]).toContain(new Set(boxes.map((b) => b[2])).size);
  });

  test('the sheet shows the brief and the level, draws the glyph without a picture, and Choose picks the type', async ({ page }) => {
    await toRiderStep(page);
    await page.locator('.type-info-btn[aria-label="About Hybrid bikes"]').click();
    const dlg = page.locator('#bike-info-modal [role="dialog"]');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#bike-info-title')).toHaveText('Hybrid');
    await expect(dlg.locator('.bike-info-kicker')).toHaveText('Alvas Cross');
    await expect(dlg.locator('.bike-info-level')).toHaveClass(/easy/);
    await expect(dlg.locator('.bike-info-level')).toContainText('Beginner friendly');
    await expect(dlg).toContainText('flat handlebar');
    await expect(dlg).toContainText('Best for:');
    // The picture is a 16:10 WebP under assets/bikes/, asked for with the build's stamp.
    const img = dlg.locator('img');
    await expect(img).toBeVisible();
    expect(await img.getAttribute('src')).toMatch(/^\/assets\/bikes\/hybrid\.webp\?v=[0-9a-f]{10}$/);
    expect(await img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth)).toBe(1280);
    await expect(dlg.locator('.bike-info-fallback')).toBeHidden();
    await dlg.locator('button', { hasText: 'Choose this bike' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.locator('[data-type-slot="0"][data-type="Hybrid"]')).toHaveClass(/active/);
    expect(await page.evaluate('S.regBikeTypes[0]')).toBe('Hybrid');
  });

  // Pop-ups sit in the middle of the screen at every width (the owner, 2026-09-30: "always center
  // pages that pop up in the website why is it always at the bottom of the page").
  test('the sheet opens in the middle of the screen, not at the bottom', async ({ page }) => {
    await toRiderStep(page);
    await page.locator('.type-info-btn[aria-label="About Hybrid bikes"]').click();
    const box = page.locator('#bike-info-modal .modal-box');
    await expect(box).toBeVisible();
    await box.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
    const r = (await box.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(Math.abs(r.x + r.width / 2 - vp.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.y + r.height / 2 - vp.height / 2)).toBeLessThanOrEqual(1);
    expect(r.y).toBeGreaterThan(0);
  });

  test('a picture that cannot be fetched gives way to the bike glyph', async ({ page }) => {
    await toRiderStep(page);
    await page.route('**/assets/bikes/*.webp*', (r) => r.abort());
    await page.locator('.type-info-btn[aria-label="About Kids bikes"]').click();
    const dlg = page.locator('#bike-info-modal [role="dialog"]');
    await expect(dlg.locator('.bike-info-fallback')).toBeVisible();
    await expect(dlg.locator('img')).toBeHidden();
    await expect(dlg.locator('.bike-info-kicker')).toHaveText('Alvas Beta');
  });

  test('Road Carbon is marked for experienced riders, and no sheet exists for Any', async ({ page }) => {
    await toRiderStep(page);
    await page.locator('.type-info-btn[aria-label="About Road Carbon bikes"]').click();
    const dlg = page.locator('#bike-info-modal [role="dialog"]');
    await expect(dlg.locator('.bike-info-level')).toContainText('For experienced riders');
    await expect(dlg.locator('.bike-info-level')).not.toHaveClass(/easy/);
    await page.evaluate(`closeBikeInfo();showBikeInfo('Any',0)`);
    await expect(dlg).toHaveCount(0);
  });

  test('Escape and the backdrop close the sheet without choosing', async ({ page }) => {
    await toRiderStep(page);
    const before = await page.evaluate('S.regBikeTypes[0]||null');
    await page.locator('.type-info-btn[aria-label="About Road bikes"]').click();
    const dlg = page.locator('#bike-info-modal [role="dialog"]');
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    expect(await page.evaluate('S.regBikeTypes[0]||null')).toBe(before);
    await page.locator('.type-info-btn[aria-label="About Road bikes"]').click();
    await expect(dlg).toBeVisible();
    await page.locator('#bike-info-modal .modal-backdrop').click({ position: { x: 4, y: 4 } });
    await expect(dlg).toBeHidden();
    expect(await page.evaluate('S.regBikeTypes[0]||null')).toBe(before);
  });

  test('the account page has the same "i", and Choose sets the saved preference', async ({ page }) => {
    await stubSupabase(page, { sessions: [openSession] });
    await loginCustomer(page);
    await page.goto('/account');
    await waitForSb(page);
    await expect(page.locator('#atp-Road')).toBeVisible();
    await page.locator('.type-info-btn[aria-label="About Mountain bikes"]').click();
    await page.locator('#bike-info-modal button', { hasText: 'Choose this bike' }).click();
    await expect(page.locator('#atp-Mountain')).toHaveClass(/active/);
    await expect(page.locator('#atp-Road')).not.toHaveClass(/active/);
  });

  // A pill and its "i" are one button, and no name, price or icon leaves it at any width or in a long
  // language (the owner, 2026-10-05): long names wrap, the price drops under them, the cells stay even.
  test('every pill and its "i" are one even button, and nothing spills out of it', async ({ page }) => {
    await toRiderStep(page);
    await page.locator('[data-type-slot="0"][data-type="Road Carbon"]').click();
    for (const lang of ['en', 'pt']) {
      if (lang !== 'en') await page.evaluate(`setLang('${lang}')`);
      for (const width of [320, 390, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        const bad: string[] = await page.locator('#reg-type-wrap-0 .type-grid').evaluate((g) => {
          const out: string[] = [], cells = [...g.children], hs = cells.map((c) => c.getBoundingClientRect().height);
          if (Math.max(...hs) - Math.min(...hs) > 1) out.push('uneven ' + hs.map(Math.round));
          for (const c of cells) {
            const pill = (c.matches('.toggle-btn') ? c : c.querySelector('.toggle-btn')) as HTMLElement, i = c.querySelector('.type-info-btn');
            const pr = pill.getBoundingClientRect(), name = pill.textContent!.trim();
            if (pill.scrollWidth > pill.clientWidth || pill.scrollHeight > pill.clientHeight) out.push('clipped ' + name);
            if (!i) continue;
            const ir = i.getBoundingClientRect(), sr = i.querySelector('svg')!.getBoundingClientRect();
            if (Math.abs(ir.top - pr.top) > .5 || Math.abs(ir.height - pr.height) > .5 || ir.left > pr.right) out.push('apart ' + name);
            if (sr.left < ir.left || sr.right > ir.right || sr.top < ir.top || sr.bottom > ir.bottom) out.push('icon out ' + name);
            if (getComputedStyle(pill).borderStartEndRadius !== '0px' || getComputedStyle(i).borderStartStartRadius !== '0px') out.push('two shapes ' + name);
          }
          return out;
        });
        expect(bad, `${lang} at ${width}px`).toEqual([]);
      }
    }
    // the picked pill fills its "i" too
    const on = page.locator('.type-pick:has(.toggle-btn.active) .type-info-btn');
    expect(await on.evaluate((e) => getComputedStyle(e).backgroundColor))
      .toBe(await page.locator('.toggle-btn.active[data-type-slot="0"]').evaluate((e) => getComputedStyle(e).backgroundColor));
  });
});
