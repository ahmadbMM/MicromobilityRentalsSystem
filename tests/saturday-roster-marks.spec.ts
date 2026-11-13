import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Marks on the staff Saturday roster (new features build F4; the owner marked it Build now on 2026-11-13). Staff only.
// On a Saturday ride's Bookings a small mark after a rider's name says First Saturday, Second Saturday, Back after N
// missed (three or more) or the badge ladder's step this ride reaches; "Milestones this Saturday" above the roster
// names the riders reaching a step, without the accounts holding the No call-out tag. One read for the session
// (staff_sat_marks, migration 20261114080400): each account's Saturday rides before this one and the Saturdays held
// since its last. All Supabase traffic is stubbed.

// the circuit night is the earliest session, so the page's own first Bookings paint opens it and not the Saturday ride
const SAT = '2099-01-10', JCC = '2099-01-09', POOL = '2099-01-12';
const sessions = [
  { id: SAT, session_date: SAT, day: 'Saturday', status: 'open', capacity: 120, created_at: 1, event_kind: 'community', ride_kind: 'saturday',
    paid_ride: false, needs_approval: true, hide_queue: true, spots: 120, title: 'Saturday Social Ride', bike_slots: '{"_time":"06:30 - 07:00"}' },
  { id: JCC, session_date: JCC, day: 'Friday', status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' },
  { id: POOL, session_date: POOL, day: 'Monday', status: 'open', capacity: 30, created_at: 1, event_kind: 'community', ride_kind: 'swim',
    paid_ride: false, needs_approval: false, spots: 30, title: 'Triathlon Pool Session', bike_slots: '{"_time":"18:00 - 19:00"}' },
];
// who, the Saturday rides finished before this one, the Saturdays missed since the last
const people: [string, string, number, number, Record<string, unknown>?][] = [
  ['c1', 'Nada First', 0, 0],
  ['c2', 'Sami Second', 1, 0],
  ['c3', 'Rana Returns', 7, 4],
  ['c4', 'Dana Five', 4, 0],
  ['c5', 'Tariq Ten', 9, 0], // holds the No call-out tag
  ['c6', 'Uma Twentyfive', 24, 3],
  ['c7', 'Omar Regular', 3, 2],
  ['c8', 'Hala Hundred', 99, 0, { status: 'waitlist', waitlist_num: 1 }],
  ['c9', 'Fadi Fifty', 49, 0, { status: 'cancelled' }],
  ['c10', 'Bana Back', 1, 5],
  ['c11', 'Riad Rejected', 4, 0, { approval: 'rejected' }],
  ['c12', 'Pia Pending', 4, 0, { approval: 'pending' }], // a request still waiting on Approve
  ['c13', 'Nour Noverdict', 9, 0, { approval: null }], // and one with no verdict written: pending too
];
const row = (sid: string, n: number, cid: string, name: string, x: Record<string, unknown> = {}) => ({
  id: (sid === SAT ? 'q' : sid === JCC ? 'j' : 'p') + n, session_id: sid, session_day: 'Saturday', session_date: sid, queue_num: n, name, customer_id: cid,
  phone: '05500000' + String(n).padStart(2, '0'), size: 'M', type_preference: 'Hybrid', status: 'waiting', paid: false, price: 0,
  approval: 'approved', registered_at: '2099-01-01T10:00:00Z', ride_group: 'beg', ...x,
});
const queue_entries = [
  ...people.map(([cid, name, , , x], i) => row(SAT, i + 1, cid, name, x)),
  row(JCC, 1, 'c1', 'Nada First', { price: 75, approval: null }), row(JCC, 2, 'c4', 'Dana Five', { price: 75, approval: null }),
  row(POOL, 1, 'c1', 'Nada First', { approval: null }), row(POOL, 2, 'c4', 'Dana Five', { approval: null }),
];
const marks = { ok: true, riders: people.map(([c, , n, miss]) => ({ c, n, miss })) };
const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#0c7a3d', locked: true, auto_grant: false },
  { id: 'tag_no_callout', slug: 'no_callout', name: 'No call-out', color: '#5f6b7a', locked: true, auto_grant: false },
];
const customers = people.map(([id, name], i) => ({ id, name, email: id + '@example.test', phone: '05500000' + String(i + 1).padStart(2, '0'), height: 170, created_at: '2026-01-01T00:00:00Z' }));
const customer_tags = [{ customer_id: 'c5', tag_id: 'tag_no_callout', added_by: 'staff', added_at: 1 }, { customer_id: 'c1', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 }];

async function boot(page: Page, fx: Fixtures = {}, width = 1440, ls: Record<string, string> = {}) {
  await page.setViewportSize({ width, height: 1000 });
  await stubSupabase(page, { sessions, queue_entries, bikes: [], tags, customers, customer_tags, staff_options: [], saturday_codes: [], saturday_code_rides: [], saturday_settings: [{ link_only: false }], 'rpc:staff_sat_marks': marks, ...fx });
  await unlockStaff(page);
  await page.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, ls);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0&&(S.customerTags||[]).length>0');
}
// the session is set before the section opens, so the section's own first paint is already of that session
const roster = (page: Page, sid = SAT) => page.evaluate(`S.staffRole='admin';S.queueView='bookings';S.sfSession='${sid}';S._sfPicked=true;S.sfStatus='all';S.sfShowFinished=true;setStaffTab('queue');renderStaffQueue()`);
const tr = (page: Page, id: string) => page.locator(`#tab-queue .queue-table tbody tr[data-id="${id}"]`);
const mk = (page: Page, id: string) => tr(page, id).locator('.srm-mk');
const panel = (page: Page) => page.locator('#tab-queue .srm-panel');
/** Counts the roster's reads from here on. */
function reads(page: Page) {
  const seen = { n: 0 };
  page.on('request', (r) => { if (r.method() === 'POST' && /\/rest\/v1\/rpc\/staff_sat_marks\b/.test(r.url())) seen.n++; });
  return seen;
}

test.describe('@staff:bookings Marks on the Saturday roster', () => {
  test('each mark appears for its history: first, second, back after three or more missed, and the ladder step reached today', async ({ page }) => {
    await boot(page);
    await roster(page);
    await expect(mk(page, 'q1')).toHaveText(['First Saturday']);
    await expect(mk(page, 'q1')).toHaveClass(/\bsrm-first\b/);
    await expect(mk(page, 'q2')).toHaveText(['Second Saturday']);
    await expect(mk(page, 'q2')).toHaveClass(/\bsrm-second\b/);
    await expect(mk(page, 'q3')).toHaveText(['Back after 4 missed']); // ride 8: no step
    await expect(mk(page, 'q3')).toHaveClass(/\bsrm-back\b/);
    await expect(mk(page, 'q4')).toHaveText(['Saturday ride 5']);
    await expect(mk(page, 'q4')).toHaveClass(/\bsrm-mile\b/);
    await expect(mk(page, 'q4').locator('svg.art-medal')).toHaveCount(1);
    await expect(mk(page, 'q5')).toHaveText(['Saturday ride 10']); // No call-out keeps the mark
    await expect(mk(page, 'q6')).toHaveText(['Back after 3 missed', 'Saturday ride 25']);
    await expect(mk(page, 'q7')).toHaveCount(0); // ride 4, two missed: nothing to say
    await expect(mk(page, 'q8')).toHaveText(['Saturday ride 100']); // waitlisted: marked on the roster
    await expect(mk(page, 'q10')).toHaveText(['Second Saturday', 'Back after 5 missed']);
    await expect(tr(page, 'q11')).toHaveCount(1);
    await expect(mk(page, 'q11')).toHaveCount(0); // not selected for the ride
    await expect(mk(page, 'q12')).toHaveText(['Saturday ride 5']); // waiting on Approve: marked on the roster
    await expect(mk(page, 'q13')).toHaveText(['Saturday ride 10']);
    await expect(mk(page, 'q9')).toHaveCount(0); // cancelled
    // white on a solid fill, like the First ride chip beside it
    await expect(mk(page, 'q4')).toHaveCSS('background-color', 'rgb(138, 101, 0)');
    await expect(mk(page, 'q4')).toHaveCSS('color', 'rgb(255, 255, 255)');
  });

  test('the steps are the badge ladder\'s own, and rides one and two are not milestones', async ({ page }) => {
    await boot(page);
    await roster(page);
    await expect(mk(page, 'q1')).toHaveCount(1);
    // read off the ladder where it is defined: the rows of Rolling Start's family in _mrBadges, each with its number.
    // Nothing here pins the ladder's length, so a step added to it (rides 2 and 3, say) is a step here too.
    const family = await page.evaluate(`BDG_LADDER_OF.get('rolling_start')[0]`) as string[];
    const ladder = await page.evaluate(`(()=>{const L=BDG_LADDER_OF.get('rolling_start')[0];return _mrBadges([],[],[],null).filter(x=>L.includes(x.s)).map(x=>[x.s,Number(String(x.p).split('/')[1])]);})()`) as [string, number][];
    expect(ladder.map((x) => x[0]).sort()).toEqual([...family].sort()); // every badge of the family, each with a number
    const steps = ladder.map((x) => x[1]);
    for (const n of steps) expect(Number.isInteger(n) && n > 0, `step ${n}`).toBe(true);
    expect(steps).toEqual(expect.arrayContaining([1, 5, 10, 25, 50, 100]));
    expect(await page.evaluate('_srmSteps()')).toEqual(steps);
    await expect(tr(page, 'q1').locator('.srm-mile')).toHaveCount(0);
    await expect(tr(page, 'q2').locator('.srm-mile')).toHaveCount(0);
    // every step past the second ride is a milestone, and no other ride is: rides one and two have their own marks
    const stepOf = (n: number) => page.evaluate(`(()=>{S._srm.by.set('c7',{n:${n - 1},miss:0});const m=_srmOf(getQueue().find(e=>e.id==='q7'));return !!(m&&m.mile);})()`);
    for (const n of steps.filter((x) => x > 2)) expect(await stepOf(n), `ride ${n}`).toBe(true);
    for (const n of [1, 2, ...[4, 6, 9, 11, 24, 26, 49, 51, 99, 101].filter((x) => !steps.includes(x))]) expect(await stepOf(n), `ride ${n}`).toBe(false);
  });

  test('Milestones this Saturday names each rider reaching a step, highest first, and leaves out a No call-out rider', async ({ page }) => {
    await boot(page);
    await roster(page);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('aria-label', 'Milestones this Saturday');
    await expect(panel(page).locator('.ptn-title')).toHaveText('Milestones this Saturday2');
    const items = panel(page).locator('.satc-li');
    await expect(items).toHaveText(['Uma Twentyfive Saturday ride 25', 'Dana Five Saturday ride 5']);
    // Tariq Ten holds No call-out; Hala Hundred is waitlisted, Fadi Fifty cancelled, Riad Rejected not selected, and
    // Pia Pending and Nour Noverdict are requests still waiting on Approve: not riding until they are selected
    for (const name of ['Tariq Ten', 'Hala Hundred', 'Fadi Fifty', 'Riad Rejected', 'Pia Pending', 'Nour Noverdict', 'Nada First', 'Sami Second', 'Rana Returns']) await expect(panel(page)).not.toContainText(name);
    // selected, the rider is on the list
    await page.evaluate(`(()=>{S.queue=S.queue.map(e=>e.id==='q13'?{...e,approval:'approved'}:e);renderStaffQueue();})()`);
    await expect(items).toHaveText(['Uma Twentyfive Saturday ride 25', 'Nour Noverdict Saturday ride 10', 'Dana Five Saturday ride 5']);
    await page.evaluate(`(()=>{S.queue=S.queue.map(e=>e.id==='q13'?{...e,approval:null}:e);renderStaffQueue();})()`);
    await expect(items).toHaveText(['Uma Twentyfive Saturday ride 25', 'Dana Five Saturday ride 5']);
    await expect(mk(page, 'q5')).toHaveText(['Saturday ride 10']);
    // it sits above the roster, on the screen staff already use: no dialog, one button, the arrow that folds it
    await expect(panel(page).locator('button, a')).toHaveCount(1);
    await expect(page.locator('#confirm-modal [role="dialog"]')).toHaveCount(0);
  });

  test('Milestones this Saturday folds to its title and count with the arrow, and stays folded on this device', async ({ page }) => {
    await boot(page);
    await roster(page);
    const fold = panel(page).locator('button.satc-fold');
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(panel(page).locator('.srm-n')).toHaveText('2');
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page).locator('#srm-body')).toBeHidden();
    await expect(panel(page)).toHaveClass(/\bfolded\b/);
    // a repaint of the roster keeps it folded, and so does the next visit on this device
    await page.evaluate('renderStaffQueue()');
    await expect(panel(page).locator('#srm-body')).toBeHidden();
    expect(await page.evaluate(`localStorage.getItem('cq_srm_fold')`)).toBe('1');
    await panel(page).locator('button.satc-fold').click();
    await expect(panel(page).locator('#srm-body')).toBeVisible();
    await expect(panel(page).locator('.satc-li')).toHaveCount(2);
  });

  test('nobody reaching a step: the marks show and there is no list', async ({ page }) => {
    await boot(page, { 'rpc:staff_sat_marks': { ok: true, riders: [{ c: 'c1', n: 0, miss: 0 }, { c: 'c2', n: 1, miss: 0 }, { c: 'c3', n: 7, miss: 4 }] } });
    await roster(page);
    await expect(mk(page, 'q1')).toHaveText(['First Saturday']);
    await expect(mk(page, 'q3')).toHaveText(['Back after 4 missed']);
    await expect(panel(page)).toHaveCount(0);
  });

  test('the account window\'s switch: on, the rider leaves the list and keeps the mark; off, they are back', async ({ page }) => {
    await boot(page);
    await roster(page);
    await expect(panel(page).locator('.satc-li')).toHaveCount(2);
    const writes: { method: string; url: string; body: unknown }[] = [];
    page.on('request', (r) => { if (/\/rest\/v1\/customer_tags\b/.test(r.url()) && r.method() !== 'GET' && r.method() !== 'OPTIONS') writes.push({ method: r.method(), url: r.url(), body: r.postDataJSON() }); });
    await page.evaluate(`openAccountHistory('c4')`);
    const bar = page.locator('#cust-modal .n6p-bar');
    await expect(bar).toBeVisible();
    const tile = (name: string) => page.locator('.row-sheet').getByRole('menuitem', { name, exact: true });
    await bar.locator('.sh-more').click();
    await expect(tile('No call-out at the briefing')).toBeVisible();
    await tile('No call-out at the briefing').click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].method).toBe('POST');
    expect(writes[0].url).toContain('on_conflict=customer_id%2Ctag_id');
    expect(writes[0].body).toMatchObject({ customer_id: 'c4', tag_id: 'tag_no_callout', added_by: 'Spec Staff', starts_at: null, expires_at: null });
    await expect(panel(page).locator('.satc-li')).toHaveText(['Uma Twentyfive Saturday ride 25']);
    await expect(mk(page, 'q4')).toHaveText(['Saturday ride 5']);
    // the tile says it is on; a second tap takes the tag off
    await bar.locator('.sh-more').click();
    await expect(tile('No call-out at the briefing ✓')).toBeVisible();
    await tile('No call-out at the briefing ✓').click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].method).toBe('DELETE');
    expect(writes[1].url).toContain('customer_id=eq.c4');
    expect(writes[1].url).toContain('tag_id=eq.tag_no_callout');
    await expect(panel(page).locator('.satc-li')).toHaveText(['Uma Twentyfive Saturday ride 25', 'Dana Five Saturday ride 5']);
  });

  test('a refused write changes nothing, and an account that may not edit People gets no switch', async ({ page }) => {
    await boot(page, {});
    await roster(page);
    await page.route(/\/rest\/v1\/customer_tags\b/, (r) => (r.request().method() === 'POST'
      ? r.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42501', message: 'new row violates row-level security policy' }) })
      : r.fallback()));
    await page.evaluate(`openAccountHistory('c4')`);
    const bar = page.locator('#cust-modal .n6p-bar');
    await bar.locator('.sh-more').click();
    await page.locator('.row-sheet').getByRole('menuitem', { name: 'No call-out at the briefing', exact: true }).click();
    await expect.poll(() => page.evaluate('S._srmBusy')).toBe(false);
    expect(await page.evaluate(`_srmNoCall('c4')`)).toBe(false);
    await expect(panel(page).locator('.satc-li')).toHaveCount(2);
    // view only on People
    await page.evaluate(`S._myEdit=['queue'];_ahRender(true)`);
    await bar.locator('.sh-more').click();
    await expect(page.locator('.row-sheet').getByRole('menuitem', { name: 'Tags', exact: true })).toBeVisible();
    await expect(page.locator('.row-sheet').getByRole('menuitem', { name: /No call-out/ })).toHaveCount(0);
  });

  test('a database without the tag: no switch on the account window', async ({ page }) => {
    await boot(page, { tags: tags.filter((g) => g.id !== 'tag_no_callout'), customer_tags: customer_tags.filter((g) => g.tag_id !== 'tag_no_callout') });
    await roster(page);
    await page.evaluate(`openAccountHistory('c4')`);
    const bar = page.locator('#cust-modal .n6p-bar');
    await bar.locator('.sh-more').click();
    await expect(page.locator('.row-sheet').getByRole('menuitem', { name: 'Tags', exact: true })).toBeVisible();
    await expect(page.locator('.row-sheet').getByRole('menuitem', { name: /No call-out/ })).toHaveCount(0);
  });

  test('a circuit night and a members\' session of another kind show no marks and no list, and ask nothing', async ({ page }) => {
    const seen = reads(page);
    await boot(page);
    await roster(page, JCC);
    await expect(tr(page, 'j1')).toHaveCount(1);
    await expect(page.locator('#tab-queue .srm-mk')).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    await roster(page, POOL);
    await expect(tr(page, 'p1')).toHaveCount(1);
    await expect(page.locator('#tab-queue .srm-mk')).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    // every session together: no session is open, so nothing is asked and nothing marked
    await roster(page, 'all');
    await expect(tr(page, 'q1')).toHaveCount(1);
    await expect(page.locator('#tab-queue .srm-mk')).toHaveCount(0);
    expect(seen.n).toBe(0);
    // the Saturday ride asks, and its marks stay off the other sessions' rows of the same accounts
    await roster(page);
    await expect(mk(page, 'q1')).toHaveText(['First Saturday']);
    expect(seen.n).toBe(1);
    await roster(page, JCC);
    await expect(tr(page, 'j2')).toHaveCount(1);
    await expect(page.locator('#tab-queue .srm-mk')).toHaveCount(0);
    // and off every session together, though the Saturday ride's answer is in hand
    await roster(page, 'all');
    await expect(tr(page, 'q1')).toHaveCount(1);
    await expect(page.locator('#tab-queue .srm-mk')).toHaveCount(0);
    expect(seen.n).toBe(1);
  });

  test('one read for a session\'s open, however often the roster repaints; a booking by an account not read yet asks once more, and once again a minute later', async ({ page }) => {
    const seen = reads(page);
    await boot(page);
    await roster(page);
    await expect(mk(page, 'q1')).toHaveCount(1);
    for (let i = 0; i < 5; i++) await page.evaluate('renderStaffQueue()');
    await roster(page, JCC);
    await roster(page);
    await expect(mk(page, 'q1')).toHaveCount(1);
    expect(seen.n).toBe(1);
    // a new booking lands (as realtime would hand it over): one more read, then none
    await page.evaluate(`(()=>{const e={...getQueue().find(x=>x.id==='q7'),id:'q20',customerId:'c20',name:'Lina Late',queueNum:20};S.queue=[...S.queue,e];renderStaffQueue();})()`);
    await expect.poll(() => seen.n).toBe(2);
    for (let i = 0; i < 5; i++) await page.evaluate('renderStaffQueue()');
    await page.waitForTimeout(300);
    expect(seen.n).toBe(2); // the answer still does not name c20: not asked again for it on a repaint
    await expect(tr(page, 'q20')).toHaveCount(1);
    await expect(mk(page, 'q20')).toHaveCount(0);
    await expect(mk(page, 'q4')).toHaveText(['Saturday ride 5']);
    // a desk add kept in the outbox is on the roster before its row is in the database: a minute on, one more read
    const minuteOn = () => page.evaluate('S._srm.at-=61e3;renderStaffQueue()');
    await expect.poll(() => page.evaluate('S._srm.busy')).toBe(false);
    await minuteOn();
    await expect.poll(() => seen.n).toBe(3);
    await expect.poll(() => page.evaluate('S._srm.busy')).toBe(false);
    // and then no more until the five minutes are up
    await minuteOn();
    for (let i = 0; i < 3; i++) await page.evaluate('renderStaffQueue()');
    await page.waitForTimeout(300);
    expect(seen.n).toBe(3);
    await page.evaluate('S._srm.at-=3e5;renderStaffQueue()');
    await expect.poll(() => seen.n).toBe(4);
  });

  test('a database without the function: the roster is as it was, nothing is said, and it is asked once', async ({ page }) => {
    const seen = reads(page);
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await boot(page, { 'rpc:staff_sat_marks': undefined });
    await roster(page);
    await expect(tr(page, 'q1')).toHaveCount(1);
    await expect.poll(() => page.evaluate('S._srmOff')).toBe(true);
    for (let i = 0; i < 3; i++) await page.evaluate('renderStaffQueue()');
    await roster(page, JCC);
    await roster(page);
    await expect(page.locator('#tab-queue .srm-mk')).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('.toast.error, .toast.warning')).toHaveCount(0);
    expect(seen.n).toBe(1);
    expect(errs).toEqual([]);
  });

  test('a read that fails says nothing and leaves the roster unmarked', async ({ page }) => {
    await boot(page, { 'rpc:staff_sat_marks': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    await roster(page);
    await expect(tr(page, 'q1')).toHaveCount(1);
    await expect.poll(() => page.evaluate('!!S._srm&&S._srm.busy===false')).toBe(true);
    await expect(page.locator('#tab-queue .srm-mk')).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('.toast.error, .toast.warning')).toHaveCount(0);
    expect(await page.evaluate('!!S._srmOff')).toBe(false); // asked again later, not switched off
  });

  test('a phone\'s cards carry the marks and the list', async ({ page }) => {
    await boot(page, {}, 390);
    await roster(page);
    const card = (id: string) => page.locator(`#tab-queue .queue-mobile-view .q-card[data-id="${id}"]`);
    await expect(card('q1').locator('.srm-mk')).toHaveText(['First Saturday']);
    await expect(card('q6').locator('.srm-mk')).toHaveText(['Back after 3 missed', 'Saturday ride 25']);
    await expect(card('q7').locator('.srm-mk')).toHaveCount(0);
    await expect(panel(page).locator('.satc-li')).toHaveCount(2);
    expect(await page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth')).toBe(true);
  });

  test('Arabic: the marks and the list in Arabic, right to left, with Latin digits', async ({ page }) => {
    await boot(page, {}, 1440, { cq_lang: 'ar', cq_lang_pick: '1' });
    await page.locator('html[dir="rtl"]').waitFor();
    await roster(page);
    await expect(mk(page, 'q1')).toHaveText(['أول سبت']);
    await expect(mk(page, 'q2')).toHaveText(['ثاني سبت']);
    await expect(mk(page, 'q3')).toHaveText(['عاد بعد تفويت 4']);
    await expect(mk(page, 'q4')).toHaveText(['جولة السبت رقم 5']);
    await expect(panel(page).locator('.ptn-title')).toHaveText('إنجازات هذا السبت2');
    await expect(panel(page).locator('.satc-li')).toHaveText(['Uma Twentyfive جولة السبت رقم 25', 'Dana Five جولة السبت رقم 5']);
  });

  test('every staff language pack holds the words, with their numbers\' places and Latin digits', async () => {
    const core = ['srmTitle', 'srmFirst', 'srmSecond', 'srmBack', 'srmMile'];
    for (const code of ['ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']) {
      const pack = JSON.parse(readFileSync(`lang/staff-${code}.json`, 'utf8')) as Record<string, string>;
      const people = JSON.parse(readFileSync(`lang/staff-community-${code}.json`, 'utf8')) as Record<string, string>;
      const rider = JSON.parse(readFileSync(`lang/${code}.json`, 'utf8')) as Record<string, string>;
      for (const k of core) {
        expect(String(pack[k] || '').trim(), `${code} ${k}`).not.toBe('');
        expect(pack[k], `${code} ${k}`).not.toMatch(/[٠-٩۰-۹०-९০-৯]/);
        expect(rider[k], `${code} ${k} stays out of the rider's pack`).toBeUndefined();
      }
      for (const k of ['srmBack', 'srmMile']) expect(pack[k], `${code} ${k}`).toContain('{0}');
      expect(String(people.srmNoCall || '').trim(), `${code} srmNoCall`).not.toBe('');
      expect(rider.srmNoCall, `${code} srmNoCall stays out of the rider's pack`).toBeUndefined();
    }
  });

  test('nothing of it reaches a rider\'s page', async () => {
    const rider = readFileSync('app.js', 'utf8') + readFileSync('index.html', 'utf8');
    expect(rider).not.toMatch(/staff_sat_marks|_srm[A-Z]|srm-mk|srmFirst|tag_no_callout/);
  });
});
