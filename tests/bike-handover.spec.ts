import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, checkinAsRow } from './helpers/supabase';

// Handing a bike over, from the picker and from the quick check-in:
//   - the picker repriced a paid booking (the drawer then read money nobody took) and priced a
//     Petromin employee at the public fare instead of their company's;
//   - Confirm ran twice on a double tap, and again when the other tab had already confirmed;
//   - a reserved bike given to someone else stayed reserved for the first rider too;
//   - "Link this tag to bike N" offered whatever number was typed last, however long ago;
//   - scanning a bike's sticker from inside a check-in ended Keep scanning;
//   - bike text from the bike form went into the page unescaped.

const D = '2099-03-10';
const SESSION = { id: 's0', day: 'Tuesday', session_date: D, capacity: 12, status: 'open', created_at: 1 };
const PM = { id: 'pm', day: 'Tuesday', session_date: D, capacity: 30, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'petromin', paid_ride: true };
const bike = (id: string, n: number, type: string, status = 'available', extra: Record<string, unknown> = {}) => ({
  id, name: `${type} ${String(n).padStart(3, '0')}`, bike_number: n, type, size: 'M', status, colors: ['#000000'], color_names: [''], ...extra,
});
const entry = (id: string, n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: 's0', session_day: 'Tuesday', session_date: D, queue_num: n, name: 'Rider ' + id, phone: '',
  customer_id: null, status, paid: false, price: 57.5, type_preference: 'Hybrid', size: 'M', walk_in: true,
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});

async function boot(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, { sessions: [SESSION, PM], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
}
function watch(page: Page, table: string, method = 'PATCH') {
  const out: { url: string; body: string }[] = [];
  page.on('request', (r) => {
    if (r.method() === method && r.url().includes(`/rest/v1/${table}`)) out.push({ url: r.url(), body: r.postData() || '' });
  });
  return out;
}
function watchRpcs(page: Page) {
  const calls: string[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m && r.method() === 'POST') calls.push(m[1]); });
  return calls;
}
/** A picker check-in is one staff_checkin call since 2026-10-05 (the direct writes are its fallback):
 *  read as the row it writes. */
function watchCheckins(page: Page) {
  const rows: Record<string, unknown>[] = [];
  page.on('request', (r) => { const row = checkinAsRow(r); if (row) rows.push(row); });
  return rows;
}

test.describe('the bike picker', () => {
  test('changing the bike of a rider who has paid leaves what they paid alone', async ({ page }) => {
    await boot(page, {
      queue_entries: [entry('e1', 1, 'active', { paid: true, price: 57.5, assigned_bike_id: 'h1', pay_method: 'card' })],
      bikes: [bike('h1', 1, 'Hybrid', 'in-use'), bike('r1', 2, 'Road')],
    });
    const patches = watch(page, 'queue_entries');
    const rpcs = watchRpcs(page);
    await page.evaluate(`openModal('e1');S.modalBikes=['r1'];confirmAssign()`);
    // a bike change is one staff_swap_bike (no fallback writes since 2026-10-04), and no fare write follows
    await expect.poll(() => rpcs.filter((n) => n === 'staff_swap_bike').length).toBe(1);
    await page.waitForTimeout(300);
    expect(patches.filter((p) => p.url.includes('id=eq.e1') && /"price"/.test(p.body))).toEqual([]);
  });

  test('an unpaid rider is still priced from the bike handed over', async ({ page }) => {
    await boot(page, {
      queue_entries: [entry('e1', 1, 'waiting')],
      bikes: [bike('r1', 2, 'Road')],
    });
    const checkins = watchCheckins(page);
    await page.evaluate(`openModal('e1');S.modalBikes=['r1'];confirmAssign()`);
    await expect.poll(() => checkins.filter((c) => c.id === 'e1').length).toBe(1);
    expect(checkins[0]).toMatchObject({ assigned_bike_id: 'r1', price: 75 });
  });

  test('a Petromin employee handed a Hybrid is priced at the employee fare, not 57.50', async ({ page }) => {
    await boot(page, {
      queue_entries: [entry('e1', 1, 'waiting', { session_id: 'pm', price: 50 })],
      bikes: [bike('h1', 1, 'Hybrid')],
      rider_registrations: [{ id: 'r1', name: 'Rider e1', booking_no: 'A-1001', source: 'petromin', matched_entry_id: 'e1', updated_at: '2099-01-01T10:00:00Z' }],
    });
    const checkins = watchCheckins(page);
    await page.evaluate(`openModal('e1');S.modalBikes=['h1'];confirmAssign()`);
    await expect.poll(() => checkins.filter((c) => c.id === 'e1').length).toBe(1);
    expect(checkins[0].price).toBe(50);
  });

  test('reserving a bike held for another rider moves the reservation instead of sharing it', async ({ page }) => {
    await boot(page, {
      queue_entries: [entry('e1', 1, 'waiting'), entry('e2', 2, 'waiting', { assigned_bike_id: 'h1' })],
      bikes: [bike('h1', 1, 'Hybrid')],
    });
    const patches = watch(page, 'queue_entries');
    const done = page.evaluate(`openModal('e1');S.modalBikes=['h1'];reserveBike()`);
    await expect(page.locator('#confirm-modal .confirm-box')).toBeVisible();
    await page.evaluate(`_doConfirm()`);
    await done;
    await expect.poll(() => patches.find((p) => p.url.includes('id=eq.e2'))?.body).toBe(JSON.stringify({ assigned_bike_id: null }));
    // only while e2 still holds exactly that reservation
    expect(patches.find((p) => p.url.includes('id=eq.e2'))!.url).toMatch(/assigned_bike_id=eq\.h1/);
  });

  test('bike text from the bike form is shown as text, and a colour that is not one is not used', async ({ page }) => {
    await boot(page, {
      queue_entries: [entry('e1', 1, 'waiting')],
      bikes: [bike('h1', 1, 'Hybrid', 'available', {
        groupset: '<img src=x onerror="window.__pwned=1">', size: 'M<b>', colors: ['red;background-image:url(x)'],
      })],
    });
    await page.evaluate(`openModal('e1')`);
    await expect(page.locator('#bike-modal')).toContainText('<img src=x');
    await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';S.bkStatus='all';S.bkView='table';renderInventory();renderBikes()`);
    await expect(page.locator('#tab-bikes')).toContainText('M<b>');
    expect(await page.evaluate(`window.__pwned`)).toBeUndefined();
    const html = await page.evaluate(`document.getElementById('bike-modal').innerHTML+document.getElementById('tab-bikes').innerHTML`) as string;
    expect(html).not.toContain('background-image:url(x)');
  });

  test('the retired-and-maintenance section says which each bike is', async ({ page }) => {
    await boot(page, {
      queue_entries: [entry('e1', 1, 'waiting')],
      bikes: [bike('m1', 1, 'Hybrid', 'maintenance'), bike('x1', 2, 'Hybrid', 'retired')],
    });
    await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';S.bkStatus='all';S.bkShowRetired=true;S.bkView='table';renderInventory();renderBikes()`);
    const rowOf = (name: string) => page.locator('#tab-bikes tr', { hasText: name });
    await expect(rowOf('Hybrid 001')).toContainText('Maintenance');
    await expect(rowOf('Hybrid 002')).toContainText('Retired');
  });
});

test.describe('the quick check-in', () => {
  const B1 = bike('b1', 42, 'Hybrid');
  const fx = (over: Record<string, unknown> = {}) => ({
    queue_entries: [entry('e1', 7, 'waiting')],
    bikes: [B1],
    'rpc:staff_resolve_bike': { found: true, bike: B1, rented_to: null },
    'rpc:staff_checkin': { ok: true, noop: false, assignment_id: 'a1' },
    ...over,
  });
  const openWithBike = `showCheckinModal('e1');S._ciBike={found:true,bike:getBikes().find(b=>b.id==='b1')};S._ciBikeCode='42';renderCheckinModal()`;

  test('a double tap on Confirm checks the rider in once', async ({ page }) => {
    await boot(page, fx());
    const rpcs = watchRpcs(page);
    await page.evaluate(openWithBike);
    await page.evaluate(`Promise.all([confirmCheckinModal(),confirmCheckinModal()])`);
    await expect.poll(() => rpcs.filter((n) => n === 'staff_checkin').length).toBe(1);
    await page.waitForTimeout(300);
    expect(rpcs.filter((n) => n === 'staff_checkin')).toHaveLength(1);
  });

  test('when the other tab already confirmed, nothing is done a second time', async ({ page }) => {
    const inventory = [{ id: 'gel', name: 'Energy Gel', category: 'EnergyGels', qty: 10, price: 12 }];
    await boot(page, fx({
      'rpc:staff_checkin': { ok: true, noop: true },
      inventory,
      queue_entries: [entry('e1', 7, 'waitlist', { waitlist_num: 1, addons: [{ id: 'gel', qty: 1 }] })],
    }));
    const inv = watch(page, 'inventory');
    const patches = watch(page, 'queue_entries');
    await page.evaluate(openWithBike);
    await page.evaluate(`confirmCheckinModal()`);
    await expect(page.locator('#checkin-modal')).toBeHidden();
    await page.waitForTimeout(300);
    expect(inv).toHaveLength(0); // the add-on was taken from stock by the check-in that did it
    expect(patches.some((p) => /pay_method/.test(p.body))).toBe(false);
  });

  test('a bike reserved for another rider is named, asked about, and the reservation moves', async ({ page }) => {
    await boot(page, fx({ queue_entries: [entry('e1', 7, 'waiting'), entry('e2', 8, 'waiting', { assigned_bike_id: 'b1' })] }));
    const rpcs = watchRpcs(page);
    const patches = watch(page, 'queue_entries');
    await page.evaluate(openWithBike);
    await expect(page.locator('#ci-bike-spec')).toContainText('Reserved');
    await expect(page.locator('#ci-bike-spec')).toContainText('Rider e2');
    const done = page.evaluate(`confirmCheckinModal()`);
    await expect(page.locator('#confirm-modal .confirm-box')).toBeVisible();
    await page.evaluate(`_doConfirm()`);
    await done;
    expect(rpcs).toContain('staff_checkin');
    await expect.poll(() => patches.find((p) => p.url.includes('id=eq.e2'))?.body).toBe(JSON.stringify({ assigned_bike_id: null }));
  });

  test('saying no to the reserved bike checks nobody in', async ({ page }) => {
    await boot(page, fx({ queue_entries: [entry('e1', 7, 'waiting'), entry('e2', 8, 'waiting', { assigned_bike_id: 'b1' })] }));
    const rpcs = watchRpcs(page);
    await page.evaluate(openWithBike);
    const done = page.evaluate(`confirmCheckinModal()`);
    await expect(page.locator('#confirm-modal .confirm-box')).toBeVisible();
    await page.evaluate(`closeConfirm()`);
    await done;
    expect(rpcs).not.toContain('staff_checkin');
    await expect(page.locator('#ci-confirm')).toBeEnabled();
  });

  test('"Link this tag" offers only the number just keyed in for this rider', async ({ page }) => {
    await boot(page, fx({ 'rpc:staff_resolve_bike': { found: false } }));
    const offer = (last: string) => page.evaluate(`(async()=>{showCheckinModal('e1');S._ciLastNumber=${last};S._ciBikeCode='04A1B2C3D4E5';await _ciResolve('04A1B2C3D4E5');return !!S._ciLinkOffer;})()`);
    expect(await offer(`{bike:getBikes()[0],ci:'e1',at:Date.now()}`)).toBe(true);
    expect(await offer(`{bike:getBikes()[0],ci:'e1',at:Date.now()-20*60000}`)).toBe(false); // twenty minutes ago
    expect(await offer(`{bike:getBikes()[0],ci:'e9',at:Date.now()}`)).toBe(false); // for another rider
  });

  test('a bike sticker scanned from inside a check-in keeps Keep scanning going', async ({ page }) => {
    await boot(page, fx());
    const after = (ciOpen: boolean) => page.evaluate(`(()=>{S._ciId=${ciOpen ? "'e1'" : 'null'};_scanResume=true;_scanCount=3;closeScanModal(false);const r=[_scanResume,_scanCount];S._ciId=null;return r;})()`);
    expect(await after(true)).toEqual([true, 3]);
    expect(await after(false)).toEqual([false, 0]);
  });

  test('the loaded-fleet fallback names when the rider took the bike', async ({ page }) => {
    await boot(page, fx({
      queue_entries: [entry('e1', 7, 'active', { assigned_bike_id: 'b1', checked_in_at: '2099-03-10T18:05:00Z' })],
      bikes: [{ ...B1, status: 'in-use' }],
    }));
    expect(await page.evaluate(`_ciResolveLocal('42').rented_to.since`)).toBe('2099-03-10T18:05:00Z');
  });

  test('a tab unloading with its check-in open forgets it, so a later tag tap opens the bike, not that rider', async ({ page }) => {
    await boot(page, fx());
    await page.evaluate(`showCheckinModal('e1')`);
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('mm_active_checkin')).entryId`)).toBe('e1');
    await page.evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}))`);
    expect(await page.evaluate(`localStorage.getItem('mm_active_checkin')`)).toBeNull();
  });

  test('a camera that answers after the scanner was closed and reopened is switched off', async ({ page }) => {
    await boot(page, fx());
    await page.evaluate(`(()=>{window.__stopped=[];window.__started=[];let n=0;
      navigator.mediaDevices.getUserMedia=()=>new Promise(res=>{const k=++n;setTimeout(()=>{window.__started.push(k);const st=new MediaStream();st.getTracks=()=>[{stop(){window.__stopped.push(k);}}];res(st);},k===1?500:50);});})()`);
    await page.evaluate(`openScanModal();closeScanModal();openScanModal()`);
    // Where the browser has a BarcodeDetector both starts ask for a camera and the late first
    // one must be stopped; where the scanner first loads its QR decoder (Linux Chromium, CI),
    // the closed start never asks at all. Either way exactly one camera runs: the one on screen.
    const running = `window.__started.filter(k=>!window.__stopped.includes(k))`;
    await page.waitForTimeout(700); // past the slow first answer
    await expect.poll(() => page.evaluate(`${running}.length`), { timeout: 4000 }).toBe(1);
    expect(await page.evaluate(`${running}[0]===Math.max(...window.__started)`)).toBe(true); // and it is the newest
    await page.evaluate(`closeScanModal()`);
    await expect.poll(() => page.evaluate(`${running}.length`)).toBe(0);
  });
});
