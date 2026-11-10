import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, staffReady } from './helpers/supabase';

// Staff round s10 (2026-11-10), the roster's paint and selection: a repaint asked for after an action's first paint waits
// for the next frame and every ask in that frame is one paint (_qPaintSoon); a tick redraws the selection's actions, not
// the roster; Shift-click ticks a range, Space ticks the marked row; waitlisted rows can be ticked; the "?" list has one
// Enter and one X; the figures bar says "Updated h:mm" while the live channel is down; no row Undo after a check-in (the
// owner's D1): every check-in's Log line names its booking, one line per rider when several go in at once.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
const sess = { id: TODAY, day: 'Thursday', session_date: TODAY, capacity: 40, status: 'open', location: 'JCC', bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }), created_at: 1 };
const q = (id: string, n: number, o: Record<string, unknown> = {}) => ({
  id, session_id: TODAY, session_day: 'Thursday', session_date: TODAY, queue_num: n, name: 'Rider ' + n, status: 'waiting', paid: false,
  price: 80, type_preference: 'Hybrid', size: 'M', height: 172, phone: '05500000' + String(n).padStart(2, '0'), registered_at: '2026-09-15T10:00:00Z', ...o,
});
const queue_entries = [
  q('w1', 1), q('w2', 2, { paid: true }), q('w3', 3), q('w4', 4), q('w5', 5),
  q('l1', 6, { status: 'waitlist', waitlist_num: 1 }),
  q('a1', 7, { status: 'active', paid: true, checked_in_at: '2026-09-24T17:00:00Z' }),
];

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions: [sess], queue_entries });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await staffReady(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${TODAY}';S._sfPicked=true;S.sfStatus='all';S.sfSearch='';S.sfSelected=[];renderStaffQueue()`);
  await expect(row(page, 'w1')).toBeVisible();
}
const row = (page: Page, id: string) => page.locator(`#q-results .queue-table tbody tr[data-id="${id}"]`);
const box = (page: Page, id: string) => row(page, id).locator('input.rq-chki');
// every roster paint from here on, counted
const countPaints = (page: Page) => page.evaluate(`(()=>{window.__rsq=0;const o=window.renderStaffQueue;if(o.__n)return;const w=function(){window.__rsq++;return o.apply(this,arguments);};w.__n=1;window.renderStaffQueue=w;})()`);
const paints = (page: Page) => page.evaluate('window.__rsq') as Promise<number>;
const frames = (page: Page, n = 3) => page.evaluate(`new Promise(r=>{let k=${n};const f=()=>--k?requestAnimationFrame(f):r();requestAnimationFrame(f);})`);
// what the page sends to the shared action log, one object per line
const logRows = (page: Page) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes('/rest/v1/staff_actions')) return;
    const b = r.postDataJSON();
    (Array.isArray(b) ? b : [b]).forEach((x) => out.push(x));
  });
  return out;
};

test.describe('@staff:bookings s10 roster paint and selection', () => {
  test('repaints asked for in one frame are one paint, and a direct paint takes the one waiting', async ({ page }) => {
    await open(page);
    await countPaints(page);
    expect(await page.evaluate('_qPaintSoon();_qPaintSoon();_qPaintSoon();window.__rsq')).toBe(0); // not yet: the next frame
    await frames(page);
    expect(await paints(page)).toBe(1);
    await page.evaluate('_qPaintSoon();renderStaffQueue()');
    await frames(page);
    expect(await paints(page)).toBe(2); // the direct one, and nothing after it
  });

  test('a check-in paints its row at once, then at most twice more: no row Undo, and its Log line names the booking', async ({ page }) => {
    await open(page);
    const sent = logRows(page);
    await page.evaluate(`showCheckinModal('w1')`);
    await countPaints(page);
    await page.locator('#ci-confirm').click();
    await expect(row(page, 'w1').locator('td.rq-mng .rq-act')).toHaveText('Return Bike');
    await expect(row(page, 'w1')).not.toHaveClass(/rq-pend/);
    await page.waitForTimeout(600);
    expect(await paints(page)).toBeLessThanOrEqual(3); // the tap, the answer, the re-read (it was 4, and a 5th when the Undo ran out)
    await expect(row(page, 'w1').locator('.rq-undo')).toHaveCount(0);
    await expect.poll(() => sent.filter((x) => x.kind === 'checkin')).toEqual([expect.objectContaining({ entity: 'booking', entity_id: 'w1', action: 'Check In: #1 Rider 1' })]);
  });

  test('a tick redraws the selection\'s actions, not the roster; the first and the last swap the filter row', async ({ page }) => {
    await open(page);
    await box(page, 'w1').check();
    const bulk = page.locator('#tab-queue > #q-bulk');
    await expect(bulk.locator('.rq-bulkn')).toHaveText('1 selected');
    await countPaints(page);
    await box(page, 'w3').check();
    await expect(bulk.locator('.rq-bulkn')).toHaveText('2 selected');
    await box(page, 'w3').uncheck();
    await expect(bulk.locator('.rq-bulkn')).toHaveText('1 selected');
    expect(await paints(page)).toBe(0);
    expect(await page.locator('#q-results .rq-selall').evaluate((i) => (i as HTMLInputElement).indeterminate)).toBe(true);
    // the sticky offset follows the new actions row
    expect(await page.evaluate(`document.getElementById('tab-queue').style.getPropertyValue('--q-bk-h')`)).not.toBe('0px');
    await box(page, 'w1').uncheck();
    await expect(bulk).toHaveCount(0);
    await expect(page.locator('#tab-queue .filter-bar #sf-search-input')).toBeVisible();
    expect(await paints(page)).toBe(1);
    // a full repaint after ticks keeps what the ticks drew
    await box(page, 'w2').check();
    await box(page, 'w4').check();
    await page.evaluate('renderStaffQueue()');
    await expect(bulk.locator('.rq-bulkn')).toHaveText('2 selected');
    await expect(box(page, 'w2')).toBeChecked();
    await expect(box(page, 'w4')).toBeChecked();
    await expect(box(page, 'w3')).not.toBeChecked();
  });

  test('Shift-click ticks every row from the last box clicked; Shift-click on a ticked one clears the range', async ({ page }) => {
    await open(page);
    await box(page, 'w1').click();
    await box(page, 'w4').click({ modifiers: ['Shift'] });
    await expect.poll(() => page.evaluate('S.sfSelected.slice().sort()')).toEqual(['w1', 'w2', 'w3', 'w4']);
    await expect(page.locator('#q-bulk .rq-bulkn')).toHaveText('4 selected');
    for (const id of ['w2', 'w3', 'w4']) await expect(box(page, id)).toBeChecked();
    await box(page, 'w2').click({ modifiers: ['Shift'] }); // unticks w2, and w3 and w4 with it (from w4, the last clicked)
    await expect.poll(() => page.evaluate('S.sfSelected.slice().sort()')).toEqual(['w1']);
    for (const id of ['w2', 'w3', 'w4']) await expect(box(page, id)).not.toBeChecked();
  });

  test('Space ticks and unticks the marked row', async ({ page }, ti) => {
    test.skip(ti.project.name === 'mobile', 'a keyboard at the desk');
    await open(page);
    await page.evaluate('document.activeElement&&document.activeElement.blur()');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    const marked = await page.evaluate('S._kbRowId') as string;
    expect(marked).toBeTruthy();
    const y = await page.evaluate('window.scrollY');
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate('S.sfSelected')).toEqual([marked]);
    await expect(box(page, marked)).toBeChecked();
    expect(await page.evaluate('window.scrollY')).toBe(y); // Space did not scroll the page
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate('S.sfSelected')).toEqual([]);
  });

  test('a waitlisted rider can be ticked: Check in counts them, No-show does not; one Log line per rider', async ({ page }) => {
    await open(page);
    const sent = logRows(page);
    await expect(box(page, 'l1')).toHaveCount(1);
    await box(page, 'l1').check();
    await box(page, 'w3').check();
    const bulk = page.locator('#q-bulk');
    await expect(bulk.getByRole('button', { name: 'No-Show (1)' })).toBeVisible();
    await bulk.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect.poll(() => sent.filter((x) => x.kind === 'checkin').map((x) => x.entity_id).sort()).toEqual(['l1', 'w3']);
    for (const x of sent.filter((r) => r.kind === 'checkin')) expect(x).toMatchObject({ entity: 'booking', action: expect.stringMatching(/^Check In: #(3|6) Rider (3|6)$/) });
    expect(await page.evaluate(`S.fullLog.filter(l=>l.m&&l.m.kind==='checkin').map(l=>l.m.entity_id).sort()`)).toEqual(['l1', 'w3']);
    expect(await page.evaluate(`S.fullLog.some(l=>/in bulk|checked in \\d/i.test(l.label))`)).toBe(false); // the count line went
  });

  test('the "?" list names Enter once, X once, and Space', async ({ page }) => {
    await open(page);
    await page.evaluate('_kbHelp()');
    const keys = await page.locator('#confirm-modal .kb-list .kb-row').evaluateAll((rs) => rs.map((r) => [...r.querySelectorAll('kbd')].map((k) => k.textContent).join('+')));
    expect(keys.filter((k) => k === 'X')).toHaveLength(1);
    expect(keys.filter((k) => k === 'Enter')).toHaveLength(1);
    expect(keys).toContain('Space');
    const list = page.locator('#confirm-modal .kb-list');
    await expect(list).toContainText('No-show: the marked rider (asks first), or the open check-in (then Confirm)');
    await expect(list).toContainText('Open the marked rider, or return them if on a bike');
  });

  test('while the live channel is down the figures bar says when the copy was read, inline; back up, it goes', async ({ page }) => {
    await open(page);
    expect(await page.evaluate('_rtLive()')).toBe(true);
    await expect(page.locator('#q-live-count .q-lc-upd')).toHaveCount(0);
    await page.evaluate('S._rtConnected=false;_tickRefreshLabel()'); // the five-second connection tick sees the drop
    const upd = page.locator('#q-live-count .q-lc-upd');
    await expect(upd).toHaveText('Updated 8:30 PM');
    // a small text among the bar's figures, not a bar of its own
    const st = await upd.evaluate((e) => ({ pos: getComputedStyle(e).position, fs: getComputedStyle(e).fontSize, inBar: e.parentElement?.id, tall: (e as HTMLElement).offsetHeight <= 20 }));
    expect(st).toEqual({ pos: 'static', fs: '12px', inBar: 'q-live-count', tall: true });
    await page.evaluate('S._rtConnected=true;_tickRefreshLabel()');
    await expect(upd).toHaveCount(0);
  });
});
