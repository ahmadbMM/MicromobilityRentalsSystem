import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A popup redrawn in place stays put (the owner, 2026-09-29: "when clicking on a badge why does the
// popup refresh"). Most popups redraw by writing their whole markup again, so the new copy played the
// entry animation again, came back scrolled to the top and lost the focus. The page now finishes the
// new copy's entry animations before it is drawn and, for the same popup, keeps its scroll and focus;
// a popup that really opens still animates. Checked in the page itself, in the microtask after the
// write, so the timing of the test runner cannot hide a replayed animation.

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const slots = JSON.stringify({ _time: '21:00 - 23:00', _total: 40 });
const sessions = [{ id: today, day: 'Friday', session_date: today, capacity: 40, status: 'open', created_at: 0, bike_slots: slots }];
const customers = [{ id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', gender: 'female', created_at: '2026-06-10T09:00:00Z' }];
// Enough badges that the dialog scrolls.
const badges = Array.from({ length: 24 }, (_, i) => ({
  id: `bd_${i}`, slug: `bd_${i}`, icon: 'flag', color: 'green', name: `Badge ${String(i).padStart(2, '0')}`,
  description: `How badge ${i} is earned`, system: false, auto: false, retired: false, sort: i,
}));
const entry = {
  id: 'e2', session_id: today, session_day: 'Friday', session_date: today, queue_num: 3, name: 'Riding Rana', phone: '',
  customer_id: null, status: 'active', paid: true, price: 30, walk_in: true, registered_at: '2026-01-01T10:00:00Z',
  type_preference: 'Road', assigned_bike_id: 'b1', checked_in_at: '2026-01-01T18:00:00Z',
};
const bikes = [{ id: 'b1', name: 'Road 042', bike_number: 42, type: 'Road', size: 'M', status: 'in-use', colors: [] }];

async function boot(page: Page) {
  await page.setViewportSize({ width: 1100, height: 640 });
  await stubSupabase(page, { sessions, customers, queue_entries: [entry], bikes, tags: [], customer_tags: [], staff_options: [], badges, customer_badges: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffRole='admin'`);
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  await page.waitForFunction('S._bdgAt>0&&!S._bdgBusy');
}
/** The entry animations running on a popup's shell, as name:state. */
const SHELL = `el=>el?el.getAnimations().concat(el.closest('.modal-backdrop')?el.closest('.modal-backdrop').getAnimations():[]).map(a=>a.animationName+':'+a.playState):[]`;

test('the badges dialog opens with its animation, and a badge\'s "i" opens its description in place: no second animation, the scroll and the focus stay', async ({ page }) => {
  await boot(page);
  const opened = await page.evaluate(async (shell) => {
    // @ts-expect-error app global
    _bdgOpen('c1');
    await null; // the observer's microtask
    return (0, eval)(shell)(document.querySelector('#confirm-modal .bdg-dlg'));
  }, SHELL);
  expect(opened).toContain('modalSlideUp:running');
  const dlg = page.locator('#confirm-modal .bdg-dlg');
  await expect(dlg.locator('.bdg-pick')).toHaveCount(24);
  // The focus manager puts the focus on the dialog's first control once it has opened (which scrolls
  // it to the top): let that happen first.
  await expect.poll(() => dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true);

  // Scrolled down to the last badges, the "i" of one of them.
  await page.evaluate(async () => {
    const d = document.querySelector('#confirm-modal .bdg-dlg') as HTMLElement;
    d.scrollTop = d.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // the scroll event lands
  });
  const before = await dlg.evaluate((d) => d.scrollTop);
  expect(before).toBeGreaterThan(100);
  const after = await page.evaluate(async (shell) => {
    const btn = document.querySelector('#confirm-modal [aria-label="About the Badge 22 badge"]') as HTMLElement;
    btn.focus();
    btn.click();
    const box = document.querySelector('#confirm-modal .bdg-dlg') as HTMLElement;
    const replaced = !box || !box.contains(btn); // the dialog was written again, not patched
    await null;
    const nu = document.querySelector('#confirm-modal .bdg-dlg') as HTMLElement;
    const ae = document.activeElement as HTMLElement;
    return { replaced, anims: (0, eval)(shell)(nu), top: nu.scrollTop, focus: ae && ae.getAttribute('aria-label'), expanded: ae && ae.getAttribute('aria-expanded') };
  }, SHELL);
  expect(after.replaced).toBe(true);
  expect(after.anims.filter((a: string) => a.endsWith(':running'))).toEqual([]);
  expect(Math.abs(after.top - before)).toBeLessThan(3);
  expect(after.focus).toBe('About the Badge 22 badge');
  expect(after.expanded).toBe('true');
  await expect(dlg.locator('.bdg-info')).toContainText('How badge 22 is earned');
  await expect(dlg.locator('.bdg-info')).toBeInViewport();

  // Picking a badge (its description and the note under the grid) stays put the same way.
  const pick = await page.evaluate(async (shell) => {
    const btn = [...document.querySelectorAll('#confirm-modal .bdg-pick')].find((b) => b.textContent!.includes('Badge 20')) as HTMLElement;
    btn.focus();
    btn.click();
    await null;
    const nu = document.querySelector('#confirm-modal .bdg-dlg') as HTMLElement;
    return { anims: (0, eval)(shell)(nu), pressed: (document.activeElement as HTMLElement).getAttribute('aria-pressed') };
  }, SHELL);
  expect(pick.anims.filter((a: string) => a.endsWith(':running'))).toEqual([]);
  expect(pick.pressed).toBe('true');
  await expect(dlg.locator('.bdg-desc')).toContainText('How badge 20 is earned');

  // Closed and opened again - here in one write - it is a new opening, and it animates.
  const again = await page.evaluate(async (shell) => {
    // @ts-expect-error app globals
    _bdgDlgClose(); _bdgOpen('c1');
    await null;
    const nu = document.querySelector('#confirm-modal .bdg-dlg') as HTMLElement;
    return { anims: (0, eval)(shell)(nu), top: nu.scrollTop };
  }, SHELL);
  expect(again.anims).toContain('modalSlideUp:running');
  expect(again.top).toBe(0);
});

test('the Return sheet: a condition tapped keeps the sheet still and the focus on it; the notes typed stay', async ({ page }) => {
  await boot(page);
  await page.evaluate(`S.staffTab='queue';renderStaffQueue();doReturn('e2')`);
  const m = page.locator('#return-modal');
  await expect(m.locator('#ret-title')).toContainText('#3 Riding Rana');
  await m.locator('#ret-notes').fill('Rear brake rubs');
  const r = await page.evaluate(async (shell) => {
    const btn = [...document.querySelectorAll('#return-modal .toggle-btn')].find((b) => b.textContent!.includes('Damaged')) as HTMLElement;
    btn.focus();
    btn.click();
    await null;
    const box = document.querySelector('#return-modal .modal-box') as HTMLElement;
    const ae = document.activeElement as HTMLElement;
    return { anims: (0, eval)(shell)(box), focus: ae && ae.textContent!.trim(), pressed: ae && ae.getAttribute('aria-pressed') };
  }, SHELL);
  expect(r.anims.filter((a: string) => a.endsWith(':running'))).toEqual([]);
  expect(r.focus).toBe('Damaged');
  expect(r.pressed).toBe('true');
  await expect(m).toContainText('Goes to maintenance.');
  await expect(m.locator('#ret-notes')).toHaveValue('Rear brake rubs');
});
