import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The roster repaints by pieces: a party's rows (its card on a phone) are replaced only when their
// markup changed, and the rest stand. Whichever way the list was built, it reads the same.

const S1 = '2099-01-09';
const sessions = [{ id: S1, day: 'Friday', session_date: S1, capacity: 50, status: 'open', created_at: 1 }];
const bikes = [{ id: 'b1', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: [] }];
const row = (id: string, n: number, x: Record<string, unknown> = {}) => ({
  id, name: 'Rider ' + id, session_id: S1, session_day: 'Friday', session_date: S1, queue_num: n, status: 'waiting', paid: false,
  price: 75, registered_at: S1 + 'T10:00:00Z', type_preference: 'Road', size: 'M', phone: '05500000' + n, ...x });
const rows = [
  row('w1', 1), row('w2', 2), row('a1', 3, { status: 'active' }), row('d1', 4, { status: 'done', paid: true }),
  row('p1', 5, { group_id: 'g', name: 'Holder One' }), row('p2', 6, { group_id: 'g' }), row('p3', 7, { group_id: 'g', paid: true }),
  row('w3', 8), row('n1', 9, { status: 'noshow' }),
];

const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const roster = (page: Page) => page.evaluate(`document.getElementById('q-results').innerHTML`) as Promise<string>;
// The same state built from nothing: the container emptied, so the next paint writes from scratch.
async function rebuilt(page: Page) {
  await page.evaluate(`document.getElementById('q-results').replaceChildren();renderStaffQueue()`);
  await settle(page);
  return roster(page);
}
async function boot(page: Page, q: Record<string, unknown>[] = rows) {
  await stubSupabase(page, { sessions, bikes, queue_entries: q });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length===${q.length}`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${S1}';S.sfStatus='all';S.sfShowFinished=true;renderStaffQueue()`);
  await settle(page);
}

test('a repaint over the roster reads exactly as a rebuild of the same state', async ({ page }) => {
  await boot(page);
  // one rider checked in, one paid, the party's holder renamed: three pieces change, six stand
  await page.evaluate(`const q=getQueue();q.find(e=>e.id==='w2').status='active';q.find(e=>e.id==='w1').paid=true;q.find(e=>e.id==='p1').name='Holder Renamed';renderStaffQueue()`);
  await settle(page);
  const patched = await roster(page);
  expect(patched).toContain('Holder Renamed');
  expect(patched).toBe(await rebuilt(page));
});

test('the pieces that did not change keep their nodes; the one that did is replaced', async ({ page }) => {
  await boot(page);
  // A rename touches one rider's markup and nothing else's (a check-in would move every waiting
  // rider's position badge, so those rows change too, and are meant to).
  const r = await page.evaluate(`(()=>{
    const w1=document.querySelector('[data-ck="g:w1"]'),w2=document.querySelector('[data-ck="g:w2"]'),party=document.querySelector('[data-ck="g:p1"]');
    w1.__keep=1;w2.__keep=1;party.__keep=1;
    getQueue().find(e=>e.id==='w2').name='Rider Renamed';
    renderStaffQueue();
    const n1=document.querySelector('[data-ck="g:w1"]'),n2=document.querySelector('[data-ck="g:w2"]'),np=document.querySelector('[data-ck="g:p1"]');
    return {w1:n1===w1&&!!n1.__keep,party:np===party,w2Replaced:n2!==w2&&!n2.__keep,w2Renamed:n2.textContent.includes('Rider Renamed')};
  })()`) as Record<string, boolean>;
  expect(r).toEqual({ w1: true, party: true, w2Replaced: true, w2Renamed: true });
});

test('a check-in replaces one piece; the other waiting riders keep their nodes and only their position badges move', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(`(()=>{
    const w3=document.querySelector('[data-ck="g:w3"]');const before=w3.querySelector('.pos-badge').textContent;
    getQueue().find(e=>e.id==='w1').status='active';
    renderStaffQueue();
    const n3=document.querySelector('[data-ck="g:w3"]');
    return {kept:n3===w3,before,after:n3.querySelector('.pos-badge').textContent};
  })()`) as { kept: boolean; before: string; after: string };
  expect(r.kept).toBe(true);
  expect(r.before).not.toBe(r.after);
  expect(await roster(page)).toBe(await rebuilt(page));
});

test('a booking that arrives takes its place in order, one that leaves is gone, and the list still matches a rebuild', async ({ page }) => {
  await boot(page);
  await page.evaluate(`const q=getQueue();q.push(entryFromDB(${JSON.stringify(row('w0', 0))}));q.splice(q.findIndex(e=>e.id==='w3'),1);renderStaffQueue()`);
  await settle(page);
  const keys = await page.evaluate(`[...document.querySelectorAll('#q-results [data-ck^="g:"]')].map(e=>e.getAttribute('data-ck'))`) as string[];
  expect(keys[0]).toBe('g:w0');
  expect(keys).not.toContain('g:w3');
  expect(await roster(page)).toBe(await rebuilt(page));
});

test('the parts around the roster keep their nodes while their markup stands, and a search keeps its focus', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(`(()=>{
    _mountSearchClears(); // the clear button arrives 60 ms after a paint; here it is on screen before the repaints, every run
    const bar=document.querySelector('#tab-queue .filter-bar'),strip=document.querySelector('#tab-queue .stat-strip');
    getQueue().find(e=>e.id==='w2').name='Rider Renamed';  // one row's markup; nothing around the roster
    renderStaffQueue();
    const kept={bar:document.querySelector('#tab-queue .filter-bar')===bar,strip:document.querySelector('#tab-queue .stat-strip')===strip};
    getQueue().find(e=>e.id==='w1').status='active';     // now the summary strip's counts move
    renderStaffQueue();
    kept.barAfterCounts=document.querySelector('#tab-queue .filter-bar')===bar;
    kept.stripReplaced=document.querySelector('#tab-queue .stat-strip')!==strip;
    return kept;
  })()`) as Record<string, boolean>;
  expect(r).toEqual({ bar: true, strip: true, barAfterCounts: true, stripReplaced: true });
  if (!(await page.locator('#sf-search-input').isVisible())) await page.locator('[data-srch="q"] .srch-btn').click(); // a phone folds the search behind its button
  await page.locator('#sf-search-input').click();
  expect(await page.evaluate(`document.activeElement.id`)).toBe('sf-search-input');
  await page.keyboard.type('Rider w');
  await expect.poll(() => page.evaluate(`document.getElementById('q-results').innerText`)).not.toContain('Holder One');
  expect(await page.evaluate(`document.activeElement.id`)).toBe('sf-search-input');
  expect(await roster(page)).toBe(await rebuilt(page));
});

test('a repaint before the deferred rows landed still ends with every row, once', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'the table and its deferred rows are the desktop layout');
  const many = Array.from({ length: 100 }, (_, i) => row('m' + (i + 1), i + 1));
  await boot(page, many);
  await page.evaluate(`document.getElementById('q-results').replaceChildren();renderStaffQueue();getQueue()[0].paid=true;renderStaffQueue()`);
  await settle(page);
  expect(await page.evaluate(`document.querySelectorAll('#q-results .queue-table tbody[data-ck^="g:"]').length`)).toBe(100);
  expect(await roster(page)).toBe(await rebuilt(page));
});
