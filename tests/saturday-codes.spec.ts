import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Saturday ride codes (the owner, 2026-11-08, migration 20261108120000): riders book a Saturday Social Ride at
// micromobility.sa/saturday with a code staff give out; a valid code is needed and is enough. One list of codes
// serves every Saturday ride and each ride can change it. While staff have switched the page on, a Saturday date
// in the app sends the rider there; staff see the code's name beside each booking, filter and sort by it.

const SAT = '2099-01-10';
const satur = (over: Record<string, unknown> = {}) => ({
  id: SAT, session_date: SAT, day: 'Saturday', status: 'open', capacity: 120, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true,
  spots: 120, title: 'Saturday Social Ride', bike_slots: '{"_time":"06:30 - 07:00"}', ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: 'bk1', session_id: SAT, session_day: 'Saturday', session_date: SAT, queue_num: 4, name: 'Spec Rider',
  phone: '0550000001', size: 'M', type_preference: 'Hybrid', status: 'waiting', paid: false, price: 0,
  customer_id: 'c1', approval: 'pending', registered_at: '2099-01-01T10:00:00Z', ride_group: 'beg', ...over,
});
const HANDOFF = 'cd34'.repeat(12);
// How many bookings name the codes being removed (the dialog's count before a delete); the preflight goes to the stub.
const countRoute = (page: import('@playwright/test').Page, n: number) => page.route(/\/rest\/v1\/queue_entries\?.*ride_code=in/, (r) => (r.request().method() === 'OPTIONS' ? r.fallback()
  : r.fulfill({ status: 200, headers: { 'content-range': `*/${n}`, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range' }, body: '' })));

test.describe('@customer:saturday Saturday rides at micromobility.sa/saturday', () => {
  test('switched on: a Saturday date opens the way to micromobility.sa/saturday, signed in there', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [], 'rpc:community_member': true, 'rpc:saturday_link_only': true, 'rpc:customer_handoff_create': HANDOFF });
    await page.route('https://micromobility.sa/saturday**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>saturday</title>' }));
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='community';goCustomer('register');selectSessCard('${SAT}')`);
    const dlg = page.locator('#confirm-modal [role="dialog"][aria-labelledby="sat-link-title"]');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('Saturday Social Ride places are booked at micromobility.sa/saturday, with the ride code you were given.');
    expect(await page.evaluate('S.selSession')).not.toBe(SAT); // no booking steps here
    await dlg.locator('.sat-link-go').click();
    await page.waitForURL('https://micromobility.sa/saturday**');
    expect(page.url()).toBe(`https://micromobility.sa/saturday?lang=en&code=${HANDOFF}`);
  });

  test('switched off, or a database without the switch: the Saturday date books here as before', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [], 'rpc:community_member': true, 'rpc:saturday_link_only': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.saturday_link_only' } } });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='community';goCustomer('register');selectSessCard('${SAT}')`);
    await expect.poll(() => page.evaluate('S.selSession')).toBe(SAT);
    await expect(page.locator('#confirm-modal [aria-labelledby="sat-link-title"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate('S._satLink')).toBe(false);
  });

  test('a SATURDAY_LINK refusal (switched on while the rider was booking) opens the way there', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [], 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`_bookRefused({code:'P0001',message:'Saturday Social Ride places are booked at micromobility.sa/saturday.',details:'SATURDAY_LINK'},_sessGet('${SAT}'))`);
    await expect(page.locator('#confirm-modal [aria-labelledby="sat-link-title"]')).toBeVisible();
    expect(await page.evaluate('S._satLink')).toBe(true);
  });

  test('a rider who is not a member is offered the code way to the Saturday ride, only while it is switched on', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [], 'rpc:community_member': false, 'rpc:saturday_link_only': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`showCommMembersModal(false)`);
    const box = page.locator('#confirm-modal .cm-box');
    await expect(box.locator('.cm-apply')).toBeVisible();
    await expect(box.locator('.cm-sat')).toHaveText('I have a Saturday ride code');
    // a bike-free session's gate (Run for Her and the like) is not about the Saturday ride
    await page.evaluate(`closeConfirm();showCommMembersModal(true)`);
    await expect(box.locator('.cm-apply')).toBeVisible();
    await expect(box.locator('.cm-sat')).toHaveCount(0);
  });

  test('switched off, the members pop-up is as it was', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [], 'rpc:community_member': false, 'rpc:saturday_link_only': false });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`showCommMembersModal(false)`);
    await expect(page.locator('#confirm-modal .cm-apply')).toBeVisible();
    await expect.poll(() => page.evaluate('S._satLink')).toBe(false);
    await expect(page.locator('#confirm-modal .cm-sat')).toHaveCount(0);
  });

  test('?handoff=saturday sends a signed-in rider back to micromobility.sa/saturday, signed in there', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [], 'rpc:customer_handoff_create': HANDOFF });
    await page.route('https://micromobility.sa/saturday**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>saturday</title>' }));
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/?handoff=saturday&lang=ar');
    await page.waitForURL('https://micromobility.sa/saturday**');
    expect(page.url()).toBe(`https://micromobility.sa/saturday?lang=ar&code=${HANDOFF}`);
  });
});

test.describe('@staff:bookings Saturday ride codes', () => {
  const entries = [
    row({ id: 'r1', name: 'Imc Rider', customer_id: 'c2', ride_code: 'IMC', queue_num: 11 }),
    row({ id: 'r2', name: 'Imc Two', customer_id: 'c3', ride_code: 'IMC', queue_num: 12, status: 'cancelled' }),
    row({ id: 'r3', name: 'Club Rider', customer_id: 'c4', ride_code: 'CLUB', queue_num: 13 }),
    row({ id: 'm1', name: 'Member One', customer_id: 'c5', queue_num: 1 }),
  ];
  const codes = [
    { code: 'IMC', name: 'IMC staff', places: 20, active: true, created_at: '2026-11-08T10:00:00Z' },
    { code: 'CLUB', name: '', places: null, active: true, created_at: '2026-11-08T10:01:00Z' },
    { code: 'ONLYHERE', name: 'Guests', places: null, active: false, created_at: '2026-11-08T10:02:00Z' },
    { code: 'SPARE', name: 'Spare', places: 5, active: true, created_at: '2026-11-08T10:03:00Z' },
  ];
  async function boot(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
    await stubSupabase(page, {
      sessions: [satur()], queue_entries: entries, bikes: [],
      saturday_codes: codes,
      saturday_code_rides: [{ session_id: SAT, code: 'ONLYHERE', active: true, own_places: true, places: 3 }, { session_id: SAT, code: 'SPARE', active: false, own_places: false, places: null }],
      saturday_settings: [{ link_only: false }],
      ...extra,
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length>0`);
    await page.evaluate(`S.staffRole='admin';setStaffTab('queue');S.queueView='bookings';S.sfSession='${SAT}';renderStaffQueue()`);
  }
  const names = (page: import('@playwright/test').Page) => page.evaluate(`[...document.querySelectorAll('#q-results tbody tr, #q-results .q-card')].map(r=>r.innerText).join('|')`) as Promise<string>;

  test('the summary: the codes on for this ride with their bookings, the switch, and each booking\'s code by name', async ({ page }) => {
    await boot(page);
    const panel = page.locator('#tab-queue .satc-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.ptn-title')).toContainText('Ride codes · micromobility.sa/saturday');
    const items = panel.locator('.satc-li');
    await expect(items).toHaveCount(3); // IMC, CLUB, ONLYHERE (on for this ride); SPARE is off here
    await expect(items.nth(0)).toContainText('IMC staff');
    await expect(items.nth(0)).toContainText('IMC · 1 of 20 booked'); // the cancelled booking gives its place back
    await expect(items.nth(1)).toContainText('CLUB · 1 booked');
    await expect(items.nth(2)).toContainText('Guests');
    await expect(items.nth(2)).toContainText('ONLYHERE · 0 of 3 booked');
    await expect(panel.locator('#satc-link')).not.toBeChecked();
    await expect(panel).toContainText('Riders can still book Saturday rides in the app too.');
    // each booking that came with a code wears its name (a code without a name, the code itself)
    await expect(page.locator('#q-results .satc-chip').filter({ hasText: 'IMC staff' }).first()).toBeVisible();
    await expect(page.locator('#q-results .satc-chip').filter({ hasText: /^CLUB$/ }).first()).toBeVisible();
    expect(await page.evaluate(`_ptnChip(getQueue().find(e=>e.id==='m1'))`)).toBe('');
    // the roster's export carries a Ride code column: the name and the code, or the code alone
    const rows = await page.evaluate(`(()=>{let out=null;const o=window._downloadCsv;window._downloadCsv=(n,r)=>{out=r;};try{exportSessionExcel();}finally{window._downloadCsv=o;}return out;})()`) as string[][] | null;
    expect(rows).not.toBeNull();
    const col = rows![0].indexOf('Ride code');
    expect(col).toBeGreaterThan(0);
    const byName = Object.fromEntries(rows!.slice(1).map((r) => [r[1], r[col]]));
    expect(byName['Imc Rider']).toBe('IMC staff · IMC');
    expect(byName['Club Rider']).toBe('CLUB');
    expect(byName['Member One']).toBe('');
  });

  test('the Ride code filter and sort', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.sfRc='IMC';renderStaffQueue()`);
    let n = await names(page);
    expect(n).toContain('Imc Rider');
    expect(n).not.toContain('Club Rider');
    expect(n).not.toContain('Member One');
    await page.evaluate(`S.sfRc='none';renderStaffQueue()`);
    n = await names(page);
    expect(n).toContain('Member One');
    expect(n).not.toContain('Imc Rider');
    await page.evaluate(`S.sfRc='all';S.sfSort='rc';S.sfSortDir=1;renderStaffQueue()`);
    n = await names(page);
    expect(n.indexOf('Club Rider')).toBeLessThan(n.indexOf('Imc Rider')); // CLUB before IMC staff, no code last
    expect(n.indexOf('Imc Rider')).toBeLessThan(n.indexOf('Member One'));
    // the Filter panel offers each code by its name, and no code
    const opts = await page.evaluate(`(()=>{const h=document.createElement('div');h.innerHTML=_qSel('sfRc','x',[['all','All'],..._qxCols(getQueue(),false).rcs.map(c=>[c,_satcName(c)])]);return [...h.querySelectorAll('option')].map(o=>o.value+'='+o.textContent).join('|');})()`);
    expect(opts).toContain('IMC=IMC staff');
    expect(opts).toContain('SPARE=Spare');
  });

  test('the switch: on asks first and saves; off saves at once', async ({ page }) => {
    await boot(page);
    const patches: unknown[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/saturday_settings')) patches.push(r.postDataJSON()); });
    await page.locator('#satc-link').click();
    const ask = page.locator('#confirm-modal [aria-labelledby="dlgt-confirm"]');
    await expect(ask).toContainText('Riders will no longer book Saturday rides in the app.');
    await expect(page.locator('#satc-link')).not.toBeChecked(); // the saved state while it asks
    expect(patches).toEqual([]);
    await ask.locator('.chrome-dact button').last().click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toMatchObject({ link_only: true });
    await expect(page.locator('#satc-link')).toBeChecked();
    await expect(page.locator('#tab-queue .satc-panel')).toContainText('Riders book Saturday rides only at micromobility.sa/saturday');
    await page.locator('#satc-link').click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toMatchObject({ link_only: false });
  });

  test('Edit codes, All rides: rename, set places, switch off, remove an unused code, add one', async ({ page }) => {
    await boot(page);
    await countRoute(page, 0);
    const writes: { m: string; url: string; body: unknown }[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'HEAD' && /saturday_code/.test(r.url())) writes.push({ m: r.method(), url: decodeURIComponent(r.url()), body: r.postDataJSON() }); });
    await page.locator('#tab-queue .satc-edit').click();
    const dlg = page.locator('#confirm-modal .satc-dlg');
    await expect(dlg.locator('#satc-title')).toContainText('Ride codes');
    await dlg.locator('.satc-tab').filter({ hasText: 'All rides' }).click();
    const imc = dlg.locator('.satc-row[data-code="IMC"]');
    await expect(imc.locator('.satc-del')).toBeDisabled(); // it has bookings
    await imc.locator('input[type=text]').fill('IMC team');
    await imc.locator('input[type=number]').fill('25');
    await dlg.locator('.satc-row[data-code="CLUB"] input[type=checkbox]').uncheck();
    await dlg.locator('.satc-row[data-code="SPARE"] .satc-del').click();
    await expect(dlg.locator('.satc-row[data-code="SPARE"]')).toHaveCount(0);
    // a new code: one already there in another case is refused before anything is written
    await dlg.locator('.satc-add').click();
    await dlg.locator('#satc-anc-0').fill('club');
    await dlg.locator('.satc-save').click();
    await expect(page.locator('.toast').last()).toContainText('The code club is there twice.');
    expect(writes).toEqual([]);
    await dlg.locator('#satc-anc-0').fill('NEW26');
    await dlg.locator('#satc-anm-0').fill('Run club');
    await dlg.locator('.satc-save').click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[0].m).toBe('DELETE');
    expect(writes[0].url).toContain('/saturday_codes?code=in.(SPARE)');
    expect(writes[1].m).toBe('POST');
    expect(writes[1].url).toContain('on_conflict=code');
    expect(writes[1].body).toEqual([
      { code: 'IMC', name: 'IMC team', places: 25, active: true },
      { code: 'CLUB', name: '', places: null, active: false },
      { code: 'NEW26', name: 'Run club', places: null, active: true },
    ]);
    await expect(page.locator('#confirm-modal .satc-dlg')).toHaveCount(0);
  });

  test('Edit codes, This ride: off here, own places, back to the list, and a code for this ride only', async ({ page }) => {
    await boot(page);
    const writes: { m: string; url: string; body: unknown }[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'HEAD' && /saturday_code/.test(r.url())) writes.push({ m: r.method(), url: decodeURIComponent(r.url()), body: r.postDataJSON() }); });
    await page.locator('#tab-queue .satc-edit').click();
    const dlg = page.locator('#confirm-modal .satc-dlg');
    const imc = dlg.locator('.satc-row[data-code="IMC"]');
    await expect(imc).toContainText('1 booked');
    await expect(imc.locator('select').first()).toHaveValue('list');
    await imc.locator('select').first().selectOption('off');
    await dlg.locator('.satc-row[data-code="CLUB"] select').nth(1).selectOption('num');
    await expect(dlg.locator('.satc-row[data-code="CLUB"] input[type=number]')).toBeVisible();
    await dlg.locator('.satc-row[data-code="CLUB"] input[type=number]').fill('7');
    await dlg.locator('.satc-row[data-code="ONLYHERE"] select').first().selectOption('list');
    await dlg.locator('.satc-row[data-code="ONLYHERE"] select').nth(1).selectOption('list');
    // a typed value survives a redraw (another select's change paints the dialog again)
    await dlg.locator('.satc-add').click();
    await dlg.locator('#satc-rnc-0').fill('VIPS1');
    await dlg.locator('#satc-rnp-0').fill('4');
    await dlg.locator('.satc-row[data-code="SPARE"] select').nth(1).selectOption('none');
    await expect(dlg.locator('#satc-rnc-0')).toHaveValue('VIPS1');
    await dlg.locator('.satc-save').click();
    await expect.poll(() => writes.length).toBe(3);
    expect(writes[0]).toMatchObject({ m: 'POST', body: [{ code: 'VIPS1', name: '', places: null, active: false }] }); // made for this ride: off for the others
    expect(writes[1].m).toBe('DELETE');
    expect(writes[1].url).toContain(`saturday_code_rides?session_id=eq.${SAT}&code=in.(ONLYHERE)`);
    expect(writes[2].m).toBe('POST');
    expect(writes[2].url).toContain('on_conflict=session_id,code');
    expect(writes[2].body).toEqual([
      { session_id: SAT, code: 'IMC', active: false, own_places: false, places: null },
      { session_id: SAT, code: 'CLUB', active: null, own_places: true, places: 7 },
      { session_id: SAT, code: 'SPARE', active: false, own_places: true, places: null },
      { session_id: SAT, code: 'VIPS1', active: true, own_places: true, places: 4 },
    ]);
  });

  test('a code the database finds bookings for is not removed', async ({ page }) => {
    await boot(page);
    await countRoute(page, 2);
    const deletes: string[] = [];
    page.on('request', (r) => { if (r.method() === 'DELETE' && /saturday_code/.test(r.url())) deletes.push(r.url()); });
    await page.locator('#tab-queue .satc-edit').click();
    const dlg = page.locator('#confirm-modal .satc-dlg');
    await dlg.locator('.satc-tab').filter({ hasText: 'All rides' }).click();
    await dlg.locator('.satc-row[data-code="SPARE"] .satc-del').click();
    await dlg.locator('.satc-save').click();
    await expect(page.locator('.toast').last()).toContainText('This code has bookings, so it stays. Switch it off instead.');
    expect(deletes).toEqual([]);
    await expect(dlg.locator('.satc-save')).toBeEnabled();
  });

  test('an account that may not edit Bookings sees the summary only', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S._myEdit=['cashier'];renderStaffQueue()`); // only admins open a Saturday ride; this one may look, not change
    const panel = page.locator('#tab-queue .satc-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.satc-edit')).toHaveCount(0);
    await expect(panel.locator('#satc-link')).toHaveCount(0);
    await expect(panel).toContainText('Only at micromobility.sa/saturday: Off');
  });

  test('without the tables (a database before the migration) there is no panel and the roster draws as before', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], queue_entries: entries.map((e) => ({ ...e, ride_code: undefined })), bikes: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length>0`);
    await page.evaluate(`S.staffRole='admin';setStaffTab('queue');S.queueView='bookings';S.sfSession='${SAT}';renderStaffQueue()`);
    await expect.poll(() => page.evaluate('S._satc')).toBe(null);
    await expect(page.locator('#tab-queue .satc-panel')).toHaveCount(0);
    expect(await names(page)).toContain('Member One');
  });
});
