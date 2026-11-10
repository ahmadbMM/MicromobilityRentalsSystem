import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, staffReady } from './helpers/supabase';

// Selects are drawn without the native arrow (appearance:none), so the chevron is a
// background image. Both skins re-painted selects with the `background` shorthand, which
// clears background-image too: every dropdown on Account and every staff select read as
// an empty text box. The chevron is back, with room at the end so the text never runs under it.

/** The chevron image and the padding at the end the chevron sits in. */
const look = (el: Element) => {
  const cs = getComputedStyle(el);
  return { image: cs.backgroundImage, padEnd: parseFloat(cs.direction === 'rtl' ? cs.paddingLeft : cs.paddingRight) };
};

test('Account: country, city and birth-date selects carry their chevron', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [] });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account','residence')`);
  await expect(page.locator('#acc-country')).toBeVisible();
  for (const sel of ['#acc-country', '#acc-city', '#acc-birth-y']) {
    const l = await page.locator(sel).evaluate(look);
    expect(l.image, sel).toContain('data:image/svg');
    expect(l.padEnd, sel).toBeGreaterThanOrEqual(24);
  }
});

test('staff: filter selects and plain selects carry their chevron', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubSupabase(page, { sessions: [{ id: '2099-10-10', session_date: '2099-10-10', day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }], queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await staffReady(page);
  await page.evaluate(`setStaffTab('queue')`);
  // a [data-spk] select is the session picker's hidden stand-in (1px, see-through): the picker button is what shows
  const filter = page.locator('#tab-queue select.filter-select:not([data-spk])').filter({ visible: true }).first();
  await expect(filter).toBeVisible();
  const f = await filter.evaluate(look);
  expect(f.image).toContain('data:image/svg');
  expect(f.padEnd).toBeGreaterThanOrEqual(24);

  // A plain form select (the staff forms' country, kind and type pickers) under the staff skin.
  const plain = await page.evaluate(() => {
    const s = document.createElement('select');
    s.innerHTML = '<option>A long option label that fills the field</option>';
    document.querySelector('#view-staff .view-main')!.appendChild(s);
    const cs = getComputedStyle(s);
    const out = { image: cs.backgroundImage, padEnd: parseFloat(cs.paddingRight) };
    s.remove();
    return out;
  });
  expect(plain.image).toContain('data:image/svg');
  expect(plain.padEnd).toBeGreaterThanOrEqual(24);
});
