import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The built-in nutrition library (_libNutri) attaches facts to known products by name/brand,
// with no per-item DB writes. Humantra electrolyte sticks share one label across every flavour.

test.describe('nutrition library', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  });

  test('every Humantra product resolves the same electrolyte label without stored nutrition', async ({ page }) => {
    const out = await page.evaluate(() => {
      const items = [
        { id: 'h1', name: 'Humantra Lemon',      brand: 'Humantra', flavour: 'Lemon' },
        { id: 'h2', name: 'Mango Passion',        brand: 'Humantra', flavour: 'Mango' },
        { id: 'h3', name: 'Watermelon sachet',    brand: 'humantra', flavour: '' },
      ];
      // @ts-expect-error app globals
      const nus = items.map((it) => _itemNutri(it));
      // @ts-expect-error app globals
      const hasAll = items.every((it) => _hasNutri(it));
      const first = nus[0];
      return {
        hasAll,
        allSame: nus.every((n) => JSON.stringify(n) === JSON.stringify(first)),
        kcal: first.kcal,
        carbs: first.carbs_g,
        serving: first.serving,
        microCount: first.micros.length,
        b12: first.micros.find((m: { n: string }) => m.n === 'Vitamin B12'),
        sodium: first.micros.find((m: { n: string }) => m.n === 'Sodium'),
      };
    });

    expect(out.hasAll).toBe(true);
    expect(out.allSame).toBe(true);
    expect(out.kcal).toBe(5);
    expect(out.carbs).toBe('<1');
    expect(out.serving).toContain('3.6');
    expect(out.microCount).toBe(10);
    expect(out.b12).toMatchObject({ a: '100', u: 'µg', nrv: '4167' });
    expect(out.sodium).toMatchObject({ a: '180', u: 'mg', nrv: '8' });
  });

  test('VOSS water resolves its zero-calorie low-mineral label', async ({ page }) => {
    const out = await page.evaluate(() => {
      const it = { id: 'v1', name: 'VOSS Water 250ml', brand: 'Voss' };
      // @ts-expect-error app globals
      const n = _itemNutri(it);
      return { kcal: n.kcal, serving: n.serving, microCount: n.micros.length, ca: n.micros.find((m: { n: string }) => m.n === 'Calcium') };
    });
    expect(out.kcal).toBe(0);
    expect(out.serving).toContain('250');
    expect(out.microCount).toBe(4);
    expect(out.ca).toMatchObject({ u: 'mg' });
  });

  test('the Caramel Choco Barebells bar resolves its label, other flavours do not', async ({ page }) => {
    const out = await page.evaluate(() => {
      // @ts-expect-error app globals
      const caramel = _itemNutri({ id: 'b1', name: 'Caramel Choco Protein Bar', brand: 'Barebells' });
      // @ts-expect-error app globals
      const other = _itemNutri({ id: 'b2', name: 'Cookies & Cream Protein Bar', brand: 'Barebells' });
      return { kcal: caramel && caramel.kcal, protein: caramel && caramel.protein_g, sodium: caramel && caramel.sodium_mg, other };
    });
    expect(out.kcal).toBe(200);
    expect(out.protein).toBe(16);
    expect(out.sodium).toBe(190);
    expect(out.other).toBeNull(); // an unlisted Barebells flavour gets no guessed label
  });

  test('each listed Barebells flavour resolves its own numbers', async ({ page }) => {
    const out = await page.evaluate(() => {
      // @ts-expect-error app globals
      const salted = _itemNutri({ id: 'b3', name: 'Salted Caramel Protein Bar', brand: 'Barebells' });
      // @ts-expect-error app globals
      const caramel = _itemNutri({ id: 'b4', name: 'Caramel Choco Bar', brand: 'Barebells' });
      return { saltedKcal: salted.kcal, saltedFat: salted.fat_g, saltedNa: salted.sodium_mg, caramelKcal: caramel.kcal };
    });
    expect(out.saltedKcal).toBe(210);
    expect(out.saltedFat).toBe(11);
    expect(out.saltedNa).toBe(220);
    expect(out.caramelKcal).toBe(200); // the two flavours don't collide
  });

  test('Quest cookies resolve per flavour, and Double Choco does not collide with Choco Chip', async ({ page }) => {
    const out = await page.evaluate(() => {
      // @ts-expect-error app globals
      const chip = _itemNutri({ id: 'q1', name: 'Quest Choco Chip Cookies', brand: 'Quest' });
      // @ts-expect-error app globals
      const dbl = _itemNutri({ id: 'q2', name: 'Quest Double Choco Chips Cookies', brand: 'Quest' });
      // @ts-expect-error app globals
      const blue = _itemNutri({ id: 'q3', name: 'Quest Bake Shop Blueberry Muffins', brand: 'Quest' });
      // @ts-expect-error app globals
      const ccMuffin = _itemNutri({ id: 'q4', name: 'Quest Chocolate Chip Protein Muffins', brand: 'Quest' });
      return {
        chipKcal: chip.kcal, chipFib: chip.fibre_g, dblKcal: dbl.kcal, dblFib: dbl.fibre_g, dblNa: dbl.sodium_mg,
        blueKcal: blue.kcal, blueProt: blue.protein_g,
        muffinKcal: ccMuffin.kcal, muffinFat: ccMuffin.fat_g, muffinServing: ccMuffin.serving,
      };
    });
    expect(out.chipKcal).toBe(240);
    expect(out.chipFib).toBe(9);
    expect(out.dblKcal).toBe(220); // NOT 240 — the double-choco item must not fall back to the plain choco chip preset
    expect(out.dblFib).toBe(11);
    expect(out.dblNa).toBe(190);
    expect(out.blueKcal).toBe(200);
    expect(out.blueProt).toBe(10);
    // The "Chocolate Chip" muffin must not collide with the "Choco Chip" cookie (240 kcal / has sodium)
    expect(out.muffinKcal).toBe(200);
    expect(out.muffinFat).toBe(12);
    expect(out.muffinServing).toContain('muffin');
  });

  test('Spada sparkling water resolves a zero-calorie label', async ({ page }) => {
    const out = await page.evaluate(() => {
      // @ts-expect-error app globals
      const n = _itemNutri({ id: 's1', name: 'Spada Sparkling Water', brand: 'Spada' });
      return { kcal: n.kcal, sugar: n.sugar_g, sodium: n.sodium_mg, serving: n.serving };
    });
    expect(out.kcal).toBe(0);
    expect(out.sugar).toBe(0);
    expect(out.sodium).toBe(10);
    expect(out.serving).toContain('250');
  });

  test('FreeLife gummies resolve per flavour (Kids vs Pineapple protein)', async ({ page }) => {
    const out = await page.evaluate(() => {
      // @ts-expect-error app globals
      const cola = _itemNutri({ id: 'f1', name: 'FreeLife Kids Cola Gummies', brand: 'FreeLife' });
      // @ts-expect-error app globals
      const berry = _itemNutri({ id: 'f2', name: 'Freelife Kids Mixed Berry Gummies', brand: 'Freelife' });
      // @ts-expect-error app globals
      const pine = _itemNutri({ id: 'f3', name: 'FreeLife Pineapple Protein Gummies', brand: 'FreeLife' });
      // @ts-expect-error app globals
      const sour = _itemNutri({ id: 'f4', name: 'FreeLife Sour Mixed Fruit Kids Gummies', brand: 'FreeLife' });
      // @ts-expect-error app globals
      const straw = _itemNutri({ id: 'f5', name: 'Freelife Strawberry Protein Gummies', brand: 'FreeLife' });
      // @ts-expect-error app globals
      const melon = _itemNutri({ id: 'f6', name: 'FreeLife Watermelon Protein Gummies', brand: 'FreeLife' });
      return {
        colaKcal: cola.kcal, colaProt: cola.protein_g,
        berryKcal: berry.kcal, berrySugar: berry.sugar_g,
        pineKcal: pine.kcal, pineProt: pine.protein_g, pineSugar: pine.sugar_g, pineCarbs: pine.carbs_g,
        sourKcal: sour.kcal, sourProt: sour.protein_g,
        strawKcal: straw.kcal, strawProt: straw.protein_g,
        melonKcal: melon.kcal, melonProt: melon.protein_g, melonSugar: melon.sugar_g,
      };
    });
    expect(out.colaKcal).toBe(120);
    expect(out.colaProt).toBe(12);
    expect(out.berryKcal).toBe(120);
    expect(out.berrySugar).toBe(10);
    expect(out.pineKcal).toBe(98); // the protein line has its own macros, not the Kids gummies'
    expect(out.pineProt).toBe(20);
    expect(out.pineSugar).toBe(0);
    expect(out.pineCarbs).toBe('4.5–5');
    expect(out.sourKcal).toBe(120); // Sour Mixed Fruit is a Kids flavour, not the Mixed Berry one
    expect(out.sourProt).toBe(12);
    expect(out.strawKcal).toBe(98); // Strawberry / Watermelon share the protein-line macros
    expect(out.strawProt).toBe(20);
    expect(out.melonKcal).toBe(98);
    expect(out.melonProt).toBe(20);
    expect(out.melonSugar).toBe(0);
  });

  test('SiS gels resolve by line, and both Beta Fuel flavours share one profile', async ({ page }) => {
    const out = await page.evaluate(() => {
      // @ts-expect-error app globals
      const go = _itemNutri({ id: 'g1', name: 'SiS GO Isotonic Energy Gel Blackcurrant', brand: 'SiS' });
      // @ts-expect-error app globals
      const neutral = _itemNutri({ id: 'g2', name: 'SiS Beta Fuel Gel Neutral', brand: 'Science in Sport' });
      // @ts-expect-error app globals
      const orange = _itemNutri({ id: 'g3', name: 'SiS Orange Beta Fuel Energy Gel', brand: 'SiS' });
      // @ts-expect-error app globals
      const goOrange = _itemNutri({ id: 'g4', name: 'SiS GO Isotonic Energy Gel Orange', brand: 'SiS' });
      // @ts-expect-error app globals
      const slBeta = _itemNutri({ id: 'g5', name: 'SiS Beta Fuel Strawberry & Lime Gel', brand: 'SiS' });
      // 'sis' must be a whole word, not a substring of e.g. 'basis'
      // @ts-expect-error app globals
      const notSis = _itemNutri({ id: 'x1', name: 'Basis bar', brand: 'Acme' });
      return {
        goKcal: go.kcal, goCarbs: go.carbs_g, neutralKcal: neutral.kcal,
        orangeKcal: orange.kcal, orangeCarbs: orange.carbs_g,
        goOrangeKcal: goOrange.kcal, goOrangeCarbs: goOrange.carbs_g,
        slBetaKcal: slBeta.kcal, notSis,
      };
    });
    expect(out.goKcal).toBe(87);
    expect(out.goCarbs).toBe(22);
    expect(out.neutralKcal).toBe(158);
    expect(out.orangeKcal).toBe(158); // Orange Beta Fuel matches the Beta Fuel preset, not a GO Orange one
    expect(out.orangeCarbs).toBe(40);
    expect(out.goOrangeKcal).toBe(87); // GO Isotonic Orange is the 87 kcal gel, distinct from Orange Beta Fuel
    expect(out.goOrangeCarbs).toBe(22);
    expect(out.slBetaKcal).toBe(158); // Strawberry & Lime Beta Fuel shares the Beta Fuel profile
    expect(out.notSis).toBeNull();
  });

  test('HIGH5 Orange gel resolves its own label, distinct from SiS', async ({ page }) => {
    const out = await page.evaluate(() => {
      // @ts-expect-error app globals
      const h = _itemNutri({ id: 'hi1', name: 'HIGH5 Orange Energy Gel', brand: 'HIGH5' });
      return { kcal: h.kcal, carbs: h.carbs_g, sugar: h.sugar_g, serving: h.serving };
    });
    expect(out.kcal).toBe(91);
    expect(out.carbs).toBe(23);
    expect(out.sugar).toBe(3);
    expect(out.serving).toContain('40');
  });

  test('the corner macro badge shows protein for snacks and carbs for gels', async ({ page }) => {
    const out = await page.evaluate(async () => {
      // @ts-expect-error app globals
      const bar = _macroBadge({ category: 'ProteinCookies', name: 'Caramel Choco Protein Bar', brand: 'Barebells' }, 38);
      // @ts-expect-error app globals
      const gel = _macroBadge({ category: 'EnergyGels', name: 'SiS GO Isotonic Energy Gel Orange', brand: 'SiS' }, 38);
      // @ts-expect-error app globals
      const drink = _macroBadge({ category: 'Drinks', name: 'VOSS Water', brand: 'Voss' }, 38);
      // @ts-expect-error app globals
      const noFacts = _macroBadge({ category: 'ProteinBars', name: 'Mystery Bar', brand: 'Nobody' }, 38);
      // The badge is drawn by classes scoped to the add-on picker, its size carried in data-cssv
      // (no inline style since 2026-09-28): draw it there and read what it looks like.
      const host = document.createElement('div'); host.id = 'addon-picker-backdrop'; host.innerHTML = bar;
      const green = document.createElement('span'); green.style.color = 'var(--green)';
      document.body.append(host, green);
      await new Promise((r) => requestAnimationFrame(r));
      const cs = getComputedStyle(host.firstElementChild as Element);
      const look = { radius: cs.borderRadius, bg: cs.backgroundColor, color: cs.color, green: getComputedStyle(green).color, size: [cs.width, cs.height, cs.fontSize] };
      host.remove(); green.remove();
      return { bar, gel, drink, noFacts, look };
    });
    // protein snack → its protein grams, in green on a black circle, 38px across
    expect(out.bar).toContain('16g');
    expect(out.look.radius).toBe('50%');
    expect(out.look.color).toBe(out.look.green);
    expect(out.look.bg).toBe('rgb(0, 0, 0)');
    expect(out.look.size).toEqual(['38px', '38px', '12px']);
    // energy gel → its carb grams
    expect(out.gel).toContain('22g');
    // neither category, or no nutrition facts → no badge
    expect(out.drink).toBe('');
    expect(out.noFacts).toBe('');
  });

  test('a saved nutrition object still wins over the library', async ({ page }) => {
    const kcal = await page.evaluate(() =>
      // @ts-expect-error app globals
      _itemNutri({ name: 'Humantra Lemon', brand: 'Humantra', nutrition: { kcal: 42 } }).kcal,
    );
    expect(kcal).toBe(42);
  });
});
