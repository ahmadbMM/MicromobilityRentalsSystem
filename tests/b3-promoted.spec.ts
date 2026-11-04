import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The staff review's leftovers, marked Build now on 2026-10-28 and built 2026-11-04 (S03-core3-09): every rider a freed place
// went to is told, not only the first, in their own language; a dialog already open makes it wait, not vanish; the row says
// "Tell them" until the link is tapped.

const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const session = { id: today, day: 'Today', session_date: today, capacity: 3, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":3}' };
const row = (id: string, n: number, over: Record<string, unknown> = {}) => ({
  id, session_id: today, session_day: 'Today', session_date: today, queue_num: n, name: `Rider ${id}`, phone: '0551234567', customer_id: `c-${id}`,
  type_preference: 'Road', height: 175, size: 'M', status: 'waiting', paid: false, price: 75, registered_at: `2026-01-01T10:00:0${n}Z`, ...over,
});
const customers = [{ id: 'c-w1', name: 'Rider w1', nationality: 'Pakistan' }, { id: 'c-w2', name: 'Rider w2', nationality: 'France' }];

// _ptOpen is the remind part's: its first call fetches the part, so what it draws comes a moment later.
async function desk(page: Page) {
  await stubSupabase(page, { sessions: [session], bikes: [], customers, queue_entries: [row('a', 1), row('b', 2), row('w1', 3, { status: 'waitlist', waitlist_num: 1 }), row('w2', 4, { status: 'waitlist', waitlist_num: 2 })] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');renderStaffQueue()`);
  await page.waitForFunction('S.dataLoaded&&!!_qGet("w1")');
}
const wl = (page: Page, ids: string[]) => page.evaluate(`_promoNudge(${JSON.stringify(ids)}.map(id=>_qGet(id)))`);

test.describe('@staff:bookings told of a place', () => {
  test('every rider moved up is listed, each with a link in their own language', async ({ page }) => {
    await desk(page);
    await page.evaluate(`S.customers=${JSON.stringify(customers)}`);
    await wl(page, ['w1', 'w2']);
    const d = page.locator('#promo-nudge');
    await expect(d).toBeVisible();
    await expect(d.locator('.pn-row')).toHaveCount(2);
    const hrefs = await d.locator('a.pn-wa').evaluateAll((a) => a.map((x) => decodeURIComponent((x as HTMLAnchorElement).href)));
    expect(hrefs[0]).toContain('https://wa.me/966551234567?text=');
    expect(hrefs[0]).toContain('مائیکرو موبیلٹی'); // Pakistan: Urdu
    expect(hrefs[1]).toContain('Bonne nouvelle'); // France: French
  });

  test('a tapped link gets its tick and stays listed; the last one closes the dialog', async ({ page, context }) => {
    await desk(page);
    await context.route('https://wa.me/**', (r) => r.fulfill({ status: 200, body: 'ok' }));
    await wl(page, ['w1', 'w2']);
    const d = page.locator('#promo-nudge');
    const opened = context.waitForEvent('page');
    await d.locator('a.pn-wa').first().click();
    await (await opened).close();
    await expect(d.locator('.pn-sent')).toHaveCount(1);
    await expect(d.locator('a.pn-wa')).toHaveCount(1);
    const second = context.waitForEvent('page');
    await d.locator('a.pn-wa').first().click();
    await (await second).close();
    await expect(d).toHaveCount(0);
    expect(await page.evaluate('_ptList()')).toEqual([]);
  });

  test('one rider reads as it did', async ({ page }) => {
    await desk(page);
    await wl(page, ['w1']);
    const d = page.locator('#promo-nudge');
    await expect(d).toContainText('#3 Rider w1');
    await expect(d.locator('.pn-list')).toHaveCount(0);
    await expect(d.locator('a.pn-wa')).toHaveCount(1);
  });

  test('a dialog already open makes it wait, and it shows when that one closes', async ({ page }) => {
    await desk(page);
    await page.evaluate(`document.getElementById('confirm-modal').style.display='block';document.getElementById('confirm-modal').innerHTML='<div id="other-dlg">x</div>'`);
    await wl(page, ['w1', 'w2']);
    await expect(page.locator('#promo-nudge')).toHaveCount(0);
    await expect(page.locator('#other-dlg')).toBeVisible();
    await page.evaluate('closeConfirm()');
    await expect(page.locator('#promo-nudge .pn-row')).toHaveCount(2);
  });

  test('closed without sending, the row says Tell them and opens it again, across a reload', async ({ page }) => {
    await desk(page);
    await wl(page, ['w1']);
    await page.locator('#promo-nudge').getByRole('button', { name: 'Close' }).first().click();
    await page.evaluate('renderStaffQueue()');
    const chip = page.locator('#tab-queue .rq-tell');
    await expect(chip.first()).toHaveText('Tell them');
    await chip.first().click();
    await expect(page.locator('#promo-nudge')).toBeVisible();
    await page.reload();
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');renderStaffQueue()`);
    await page.waitForFunction('S.dataLoaded&&!!_qGet("w1")');
    await page.evaluate('renderStaffQueue()');
    await expect(page.locator('#tab-queue .rq-tell').first()).toBeVisible();
  });

  test('a rider who has since arrived or left is not asked about', async ({ page }) => {
    await desk(page);
    await wl(page, ['w1']);
    await expect(page.locator('#promo-nudge')).toBeVisible();
    await page.evaluate(`closeConfirm();_qGet('w1').status='active';renderStaffQueue();_ptOpen()`);
    await page.waitForTimeout(150);
    await expect(page.locator('#tab-queue .rq-tell')).toHaveCount(0);
    await expect(page.locator('#promo-nudge')).toHaveCount(0);
  });

  test('an undone promotion takes them off the list', async ({ page }) => {
    await desk(page);
    await wl(page, ['w1']);
    await page.evaluate(`closeConfirm();_undoPromotion(_qGet('w1'),_qGet('a')).catch(()=>{});`);
    await expect.poll(() => page.evaluate('_ptList()')).toEqual([]);
  });

  test('the message says no ride or bike words of its own, and admins can edit it', async ({ page }) => {
    await desk(page);
    await page.evaluate(`_loadStaffPart('remind')`);
    const t = String(await page.evaluate(`_remDefault('wl_moved','en',_sessGet('${today}'))`));
    expect(t).toContain('{first_name}');
    expect(t.replace(/\{[a-z_]+\}/g, '')).not.toMatch(/\b(ride|bike|cycling)\b/i);
    const all = await page.evaluate(`['en','ar','fr','es','pt','ur','hi','tl','ne','bn'].map(l=>_remDefault('wl_moved',l,_sessGet('${today}')))`) as string[];
    all.forEach((x) => { expect(x).toContain('{cancel_link}'); expect(x).toContain('{date}'); });
    expect(await page.evaluate(`_tplDefault('wl_moved','en')`)).toContain('{first_name}');
  });
});
