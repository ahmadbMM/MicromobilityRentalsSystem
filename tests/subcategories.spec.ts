import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Protein Snacks types (Cookies / Gummies / Muffins) are leaf categories. The Sales picker
// lays a department out flat like All items: section headers + items, no drill-in cards.

const fixtures = {
  sessions: [{
    id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12,
    status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null,
  }],
  inventory: [
    { id: 'ck1', name: 'Choc Cookie',  category: 'ProteinCookies', qty: 5, price: 8, low_threshold: 1 },
    { id: 'gm1', name: 'Berry Gummy',  category: 'ProteinGummies', qty: 5, price: 6, low_threshold: 1 },
    { id: 'mf1', name: 'Banana Muffin', category: 'ProteinMuffins', qty: 5, price: 9, low_threshold: 1 },
    { id: 'dr1', name: 'Vitamin Water', category: 'Drinks',        qty: 5, price: 10, low_threshold: 1 },
  ],
};

// Set the drill state, re-render the Sales tab, and return the picker's [data-cat] cards.
async function pickerCards(page: import('@playwright/test').Page, pick: string) {
  return page.evaluate((p) => {
    // @ts-expect-error app globals
    S._ctPickCat = p; renderCashier();
    return [...document.querySelectorAll('#tab-cashier [data-cat]')].map((b) => ({
      cat: (b as HTMLElement).dataset.cat, text: (b.textContent || '').replace(/\s+/g, ' ').trim(),
    }));
  }, pick);
}

test.describe('protein sub-categories', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page, fixtures);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('S.inventory && S.inventory.length > 0');
  });

  test('a department lists its items flat like All items - no category cards', async ({ page }) => {
    // Top level shows departments, not raw categories.
    const top = (await pickerCards(page, '')).map((c) => c.cat);
    expect(top).toEqual(expect.arrayContaining(['__all__', '__sec__supp']));
    expect(top).not.toContain('__grp__ProteinSnacks');

    // Supplements & beverages: items render directly in category sections -
    // no drill-in cards for Protein Snacks or its sub-types.
    const supp = await pickerCards(page, '__sec__supp');
    expect(supp.map((c) => c.cat)).not.toContain('__grp__ProteinSnacks');
    await expect(page.locator('#tab-cashier')).toContainText('Choc Cookie');
    await expect(page.locator('#tab-cashier')).toContainText('Berry Gummy');
    await expect(page.locator('#tab-cashier')).toContainText('Banana Muffin');
  });

  test('the inventory Type dropdown maps a protein snack to its Protein<Type> leaf', async ({ page }) => {
    // Add form in Supplements with Protein Snacks selected → the Type dropdown appears,
    // and picking a type resolves to the leaf category the sales picker nests.
    const res = await page.evaluate(() => {
      // @ts-expect-error app globals
      S.invSection = 'supplements'; toggleAddInv(); S._invCat = 'ProteinSnacks'; S._invSubtype = 'Muffins'; renderInventory();
      return {
        hasField: !!document.getElementById('inv-subtype'),
        // @ts-expect-error app globals
        leaf: _invResolveCat(), parent: _catParent('ProteinMuffins'), label: _invCatLabel('ProteinMuffins'),
      };
    });
    expect(res.hasField).toBe(true);
    expect(res.leaf).toBe('ProteinMuffins');
    expect(res.parent).toBe('ProteinSnacks');
    expect(res.label).toBe('Protein Muffins');

    // A custom multi-word type round-trips through the encode/decode helpers and still nests.
    const custom = await page.evaluate(() => ({
      // @ts-expect-error app globals
      leaf: _proteinLeaf('Energy Balls'), back: _leafSubtype('ProteinEnergyBalls'), grp: _catGroup('ProteinEnergyBalls'),
    }));
    expect(custom).toEqual({ leaf: 'ProteinEnergyBalls', back: 'Energy Balls', grp: 'ProteinSnacks' });

    // Editing a leaf-tagged item shows Protein Snacks + its Type again.
    const edit = await page.evaluate(() => {
      // @ts-expect-error app globals
      startInvEdit('ck1'); return { cat: S._invCat, sub: S._invSubtype };
    });
    expect(edit).toEqual({ cat: 'ProteinSnacks', sub: 'Cookies' });
  });

  test('the inventory list nests protein sub-types under a Protein Snacks umbrella, prefixed', async ({ page }) => {
    const html = await page.evaluate(() => {
      // @ts-expect-error app globals
      S.invSection = 'supplements'; S.invSort = 'cat'; S.invSearch = ''; renderInventory();
      return document.getElementById('tab-inventory')!.innerHTML;
    });
    // Umbrella heading present, and sub-headings carry the "Protein" prefix
    expect(html).toContain('Protein Snacks');
    expect(html).toContain('Protein Cookies');
    expect(html).toContain('Protein Gummies');
    expect(html).toContain('Protein Muffins');
    // Umbrella comes before its sub-sections
    expect(html.indexOf('Protein Snacks')).toBeLessThan(html.indexOf('Protein Cookies'));
  });

  test('each department lists only its own items, flat', async ({ page }) => {
    await page.evaluate(() => {
      S.inventory = [
        { id: 'p1', name: 'Bar', brand: 'Barebells', category: 'ProteinBars', qty: 3, price: 5 },
        { id: 'e1', name: 'Hydrate', category: 'ElectrolyteSachets', qty: 3, price: 5 },
        { id: 'h1', name: 'Helmet', category: 'Helmet', qty: 3, price: 20 },
        { id: 'a1', name: 'Lock', category: 'Accessory', qty: 3, price: 15 },
      ];
    });
    // Top level: All items + two department cards; no raw category/group cards yet
    const top = (await pickerCards(page, '')).map((c) => c.cat);
    expect(top).toEqual(expect.arrayContaining(['__all__', '__sec__supp', '__sec__equip']));
    expect(top).not.toContain('__grp__ProteinSnacks');
    expect(top).not.toContain('Helmet');
    // Supplements & beverages: its items directly (no group cards), none of the equipment
    const suppCards = (await pickerCards(page, '__sec__supp')).map((c) => c.cat);
    expect(suppCards).not.toContain('__grp__ProteinSnacks');
    await expect(page.locator('#tab-cashier')).toContainText('Bar');
    await expect(page.locator('#tab-cashier')).toContainText('Hydrate');
    await expect(page.locator('#tab-cashier')).not.toContainText('Helmet');
    // Equipment: its items directly, no supplements
    await pickerCards(page, '__sec__equip');
    await expect(page.locator('#tab-cashier')).toContainText('Helmet');
    await expect(page.locator('#tab-cashier')).toContainText('Lock');
    await expect(page.locator('#tab-cashier')).not.toContainText('Hydrate');
  });

  test('a price of 0 shows as Free; editing a free item pre-checks the Free toggle', async ({ page }) => {
    const out = await page.evaluate(() => {
      // @ts-expect-error app globals
      const free = _priceLabel(0), paid = _priceLabel(5), none = _priceLabel(null);
      S.inventory = [...(S.inventory || []), { id: 'freebie', name: 'Water sample', category: 'Drinks', qty: 3, price: 0 }];
      // @ts-expect-error app globals
      startInvEdit('freebie');
      return { free, paid, none, invFree: S._invFree, invPrice: S._invPrice };
    });
    expect(out.free).toBe('Free');
    expect(out.paid).toBe('SAR 5');
    expect(out.none).toBe('');
    expect(out.invFree).toBe(true); // the Free toggle turns on when editing a 0-priced item
    expect(out.invPrice).toBe(''); // and the numeric price box is left blank
  });
});
