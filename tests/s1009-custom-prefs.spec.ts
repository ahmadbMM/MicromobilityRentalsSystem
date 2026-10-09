import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Personal customisation (2026-10-09, the staff research report section 4): a staffer's own choices kept on the
// account (staff.prefs through staff_my_prefs, migration 20261009190000) with this device's copy read at once,
// and this device's text size and density. Without the function everything stays on the device.

const sent: Record<string, unknown>[] = [];
async function open(page: Page, x: Record<string, unknown> = {}, path = '/settings') {
  sent.length = 0;
  page.on('request', (r) => {
    if (/\/rest\/v1\/rpc\/staff_my_prefs/.test(r.url()) && r.method() === 'POST') sent.push(r.postDataJSON());
  });
  await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], ...x });
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
}

test.describe('@staff:settings personal customisation', () => {
  test('Start on opens the chosen section when no address names one; an address still wins', async ({ page, context }) => {
    await open(page);
    await page.selectOption('#set-start', 'inventory');
    expect(await page.evaluate(`_pref('start')`)).toBe('inventory');
    const p2 = await context.newPage();
    await p2.goto('/');
    await waitForSb(p2);
    await expect.poll(() => p2.evaluate('S.staffTab')).toBe('inventory');
    const p3 = await context.newPage();
    await p3.goto('/history');
    await waitForSb(p3);
    expect(await p3.evaluate('S.staffTab')).toBe('history');
    // a section the account may not open is not a start
    await p2.evaluate(`S._myView=['queue'];`);
    expect(await p2.evaluate('_startTab()')).toBe('');
  });

  test('the phone tab bar shows the sections picked, at most four', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    const box = (k: string) => page.locator(`#tab-settings input[data-set-tb="${k}"]`);
    await expect(box('queue')).toBeChecked();
    await box('inventory').uncheck();
    await box('history').check();
    await expect(page.locator('#staff-tabbar .tb-btn[data-tb]')).toHaveCount(4);
    expect(await page.locator('#staff-tabbar .tb-btn[data-tb]').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.tb)))
      .toEqual(['queue', 'community', 'cashier', 'history']);
    expect(await page.evaluate(`_pref('tabbar')`)).toEqual(['queue', 'community', 'cashier', 'history']);
    // four picked: the rest cannot be ticked until one goes
    await expect(box('team')).toBeDisabled();
    await page.click('#set-tb-reset');
    expect(await page.evaluate(`_pref('tabbar',null)`)).toBeNull();
    await expect(page.locator('#staff-tabbar .tb-btn[data-tb]')).toHaveCount(4);
    await expect(page.locator('#staff-tabbar .tb-btn[data-tb="inventory"]')).toBeAttached();
  });

  test('filters are kept per section across a reload, and Reset filters puts them back', async ({ page, context }) => {
    await open(page, {}, '/history');
    await page.evaluate(`S.histStatus='noshow';S.histSort='name';setStaffTab('queue')`);
    expect(await page.evaluate(`_pref('state.history')`)).toEqual({ histStatus: 'noshow', histSort: 'name' });
    const p2 = await context.newPage();
    await p2.goto('/history');
    await waitForSb(p2);
    await expect.poll(() => p2.evaluate('S.histStatus')).toBe('noshow');
    await p2.evaluate(`setStaffTab('settings')`);
    await p2.click('#set-st-reset');
    expect(await p2.evaluate('S.histStatus')).toBe('all');
    expect(await p2.evaluate(`_pref('state.history',null)`)).toBeNull();
  });

  test('the Bikes layout (grid or table) is remembered like Inventory\'s', async ({ page }) => {
    await open(page, {}, '/inventory');
    await page.evaluate(`_stLoad('bikes');S.bkView=S.bkView==='grid'?'table':'grid';_stSaveAll()`);
    const v = await page.evaluate('S.bkView');
    expect(await page.evaluate(`_pref('state.bikes')`)).toEqual({ bkView: v });
  });

  test('text size zooms the staff page, and 130% at 320px never scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await open(page);
    await page.click('#tab-settings [data-set-fs="130"]');
    await expect(page.locator('html')).toHaveAttribute('data-staff-fs', '130');
    await expect(page.locator('#tab-settings [data-set-fs="130"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(`getComputedStyle(document.body).zoom`)).toBe('1.3');
    for (const tab of ['settings', 'queue']) {
      await page.evaluate(`setStaffTab('${tab}')`);
      const over = await page.evaluate(`document.documentElement.scrollWidth-document.documentElement.clientWidth`);
      expect(over, tab).toBeLessThanOrEqual(1);
    }
    await page.evaluate(`setStaffTab('settings')`);
    await page.click('#tab-settings [data-set-fs="100"]');
    expect(await page.evaluate(`document.documentElement.hasAttribute('data-staff-fs')`)).toBe(false);
  });

  test('compact density packs tables on a laptop and leaves a phone\'s targets alone', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    await page.click('#tab-settings [data-set-dn="compact"]');
    await expect(page.locator('html')).toHaveAttribute('data-staff-density', 'compact');
    expect(await page.evaluate('S.queueDensity')).toBe('compact');
    const pad = () => page.evaluate(`getComputedStyle(document.querySelector('#tab-settings .set-tog')).paddingTop`);
    expect(await pad()).toBe('6px');
    await page.setViewportSize({ width: 390, height: 800 });
    expect(await pad()).toBe('10px');
    const seg = await page.locator('#tab-settings [data-set-dn="compact"]').boundingBox();
    expect(seg!.height).toBeGreaterThanOrEqual(44);
  });

  test('the language can be changed on Settings too', async ({ page }) => {
    await open(page);
    await page.selectOption('#set-lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('#set-h-pers')).toHaveText('تفضيلاتي');
    expect(await page.evaluate(`document.getElementById('lang-btn').value`)).toBe('ar');
  });

  test('without the database function the choices stay on the device and nothing complains', async ({ page }) => {
    await open(page);
    await page.evaluate(`S._staffAuthed=true`);
    await page.selectOption('#set-start', 'history');
    await expect.poll(() => sent.length, { timeout: 5000 }).toBe(1);
    await expect.poll(() => page.evaluate('!!S._prefNoDb')).toBe(true);
    await expect(page.locator('#toast-container .toast.error')).toHaveCount(0);
    const c = JSON.parse(await page.evaluate(`localStorage.getItem('cq_prefs')`) as string);
    expect(c.v.start).toBe('history');
    expect(c.dirty).toContain('start');
  });

  test('with the function the changed keys go up, and the account\'s copy comes back over the device\'s', async ({ page }) => {
    await open(page, { 'rpc:staff_my_prefs': { start: 'history', tabbar: ['queue', 'history'] } });
    await page.evaluate(`S._staffAuthed=true`);
    await page.selectOption('#set-start', 'history');
    await expect.poll(() => sent.length, { timeout: 5000 }).toBe(1);
    expect(sent[0]).toEqual({ p_set: { start: 'history' } });
    await expect.poll(() => page.evaluate(`JSON.stringify(_pref('tabbar'))`)).toBe('["queue","history"]');
    expect(await page.evaluate(`Object.keys(S._prefDirty)`)).toEqual([]);
    // the row read at sign-in carries the account's prefs; a key changed here and not yet sent stays this device's
    await page.evaluate(`S._prefDirty.start=1;S._prefs.start='workshop';S._prefSrv={start:'queue',tabbar:['cashier']};_ntSync()`);
    expect(await page.evaluate(`_pref('start')`)).toBe('workshop');
    expect(await page.evaluate(`JSON.stringify(_pref('tabbar'))`)).toBe('["cashier"]');
  });
});
