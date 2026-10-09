import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, goStaffTab } from './helpers/supabase';

// Desk speed (2026-10-04), the booth's check-in and bike handling:
//  - the scanner says what each scan did in a full-width banner, in a word and a mark as well as a
//    colour (OK / Check / Stop), with a WebAudio tone (muted by the Sound switch) and a buzz; OK
//    clears itself, Check and Stop stay; a blacklisted rider is a Stop with Make an exception;
//  - "Open the next rider" (per device) opens the next rider still expected after a single Confirm;
//  - Not here yet: a stat chip on Bookings for riders still expected after the ride's start;
//  - the screen stays on at the desk (Wake Lock) and Booth mode is a high-contrast look, both in
//    Settings > This device;
//  - the sync label counts what this device still has to send, the outbox flushes under a Web Lock,
//    and the browser is asked once to keep the storage;
//  - a return's ride time reads the server's check-in stamp; recently cancelled is read off the
//    synced bookings, with no names kept on the device.
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const slots = JSON.stringify({ _time: '00:00 - 23:59', _total: 40 });
const sessions = [
  { id: 's0', day: 'Friday', session_date: today, capacity: 40, status: 'open', created_at: 1, bike_slots: slots },
  { id: 's1', day: 'Saturday', session_date: tomorrow, capacity: 40, status: 'open', created_at: 2, bike_slots: slots },
];
const row = (id: string, qn: number, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Friday', session_date: today, queue_num: qn, name, phone: `05500000${qn}0`, customer_id: null,
  group_id: null, status: 'waiting', paid: true, price: 30, walk_in: true, type_preference: 'Hybrid', registered_at: '2026-01-01T10:00:00Z', height: 175, ...extra,
});
const A = 'aaaa1111-0000-4000-8000-000000000001', B = 'bbbb2222-0000-4000-8000-000000000002', C = 'cccc3333-0000-4000-8000-000000000003';
const E = 'eeee5555-0000-4000-8000-000000000005', T = 'ffff6666-0000-4000-8000-000000000006';
const rows = () => [
  row(A, 1, 'Paid Amal'),
  row(B, 2, 'Banned Badr', { customer_id: 'c-ban' }),
  row(C, 3, 'Next Cala'),
  row(E, 5, 'Riding Eid', { status: 'active', paid: false, assigned_bike_id: null, checked_in_at: new Date(Date.now() - 20 * 60000).toISOString() }),
  row(T, 6, 'Tomorrow Tariq', { session_id: 's1', session_day: 'Saturday', session_date: tomorrow }),
];

// Records what the page asks of the device: tones, buzzes, the wake lock, the storage, the locks.
function deviceSpies() {
  const w = window as unknown as Record<string, unknown>;
  w.__tones = 0; w.__buzz = []; w.__wl = []; w.__persist = 0; w.__locks = [];
  class FakeAC {
    state = 'running'; currentTime = 0; destination = {};
    createOscillator() { w.__tones = (w.__tones as number) + 1; return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    resume() { return Promise.resolve(); }
  }
  w.AudioContext = FakeAC;
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p: unknown) => { (w.__buzz as unknown[]).push(p); return true; } });
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: () => {
    (w.__wl as string[]).push('req');
    const ls: Array<() => void> = [];
    return Promise.resolve({ release: () => { (w.__wl as string[]).push('rel'); ls.forEach((f) => f()); return Promise.resolve(); }, addEventListener: (_: string, f: () => void) => ls.push(f) });
  } } });
  try { Object.defineProperty(navigator.storage, 'persist', { configurable: true, value: () => { (w.__persist as number)++; return Promise.resolve(true); } }); } catch { /* no StorageManager */ }
  if (navigator.locks) {
    const orig = navigator.locks.request.bind(navigator.locks);
    Object.defineProperty(navigator.locks, 'request', { configurable: true, value: (name: string, ...rest: unknown[]) => { (w.__locks as string[]).push(name); return (orig as (...a: unknown[]) => unknown)(name, ...rest); } });
  }
}

async function boot(page: Page, fixtures: Record<string, unknown> = {}, init?: () => void) {
  const q = (fixtures.queue_entries as Record<string, unknown>[] | undefined) || rows();
  await stubSupabase(page, { sessions, bikes: [], 'rpc:staff_return': { ok: true }, ...fixtures, queue_entries: q });
  // The writes land on the stub's copy, as the database would keep them.
  await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
    const r = route.request();
    if (r.method() === 'PATCH') {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      const x = q.find((y) => y.id === id);
      if (x) Object.assign(x, body);
    }
    return route.fallback();
  });
  await page.addInitScript(deviceSpies);
  await unlockStaff(page);
  if (init) await page.addInitScript(init);
  await page.goto('/');
  await waitForSb(page);
}
async function openScanner(page: Page) {
  await page.evaluate(`S.staffTab='queue';S.sfSession='s0';renderStaffQueue();openScanModal()`);
  await expect(page.locator('#scan-msg')).toContainText(/camera/i, { timeout: 15000 }); // headless has no camera: its error first
}
const scan = (page: Page, code: string) => page.evaluate((c) => {
  // @ts-expect-error app global
  _onScanPayload(c);
}, code);
const banner = (page: Page) => page.locator('#scan-banner');
const patches = (page: Page) => {
  const out: { id: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) { const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1]; try { out.push({ id, body: r.postDataJSON() }); } catch { /* not JSON */ } }
  });
  return out;
};

test.describe('@staff:bookings scanner feedback', () => {
  test('an Express check-in is OK in a word, a mark and a tone, and clears itself', async ({ page }) => {
    await boot(page, {}, () => localStorage.setItem('cq_scan_express', '1'));
    await openScanner(page);
    // OK lasts 1.2 s: a slow machine can miss it by looking, so every state it takes is recorded.
    await page.evaluate(`window.__bn=[];const el=document.getElementById('scan-banner');new MutationObserver(()=>window.__bn.push(el.className+'|'+(el.querySelector('svg')?'svg|':'')+el.textContent)).observe(el,{childList:true,subtree:true,attributes:true})`);
    await scan(page, 'MMC-1-aaaa1111');
    await expect.poll(() => page.evaluate(`window.__bn.some(x=>/scan-bn-ok\\|svg\\|OK.*#1 Paid Amal checked in/.test(x))`)).toBe(true);
    expect(await page.evaluate('window.__tones')).toBeGreaterThan(0);
    expect((await page.evaluate('window.__buzz') as unknown[]).length).toBeGreaterThan(0);
    await expect(banner(page)).toBeEmpty({ timeout: 3000 }); // ready for the next ticket
    await expect(page.locator('#scan-modal [role="dialog"]')).toBeVisible();
  });

  test('a ticket nobody holds is Stop and stays until tapped; the banner never moves the controls', async ({ page }) => {
    await boot(page);
    await openScanner(page);
    const y = async () => (await page.locator('#scan-msg').boundingBox())!.y;
    const y0 = await y();
    await scan(page, 'MMC-1-zzzz9999');
    await expect(banner(page)).toHaveClass(/scan-bn-err/);
    expect(await y()).toBe(y0); // it lies over the camera view, so nothing under a thumb slides when it comes or goes
    await expect(banner(page)).toContainText('Stop');
    await page.waitForTimeout(1600);
    await expect(banner(page)).toContainText('No booking matches');
    await banner(page).locator('button').click();
    await expect(banner(page)).toBeEmpty();
    expect(await y()).toBe(y0);
  });

  test('a rider already in is Check: since when, what they owe, and that they need a bike', async ({ page }) => {
    await boot(page);
    await openScanner(page);
    await scan(page, 'MMC-5-eeee5555');
    await expect(banner(page)).toHaveClass(/scan-bn-warn/);
    await expect(banner(page)).toContainText('Check');
    await expect(banner(page)).toContainText('#5 Riding Eid is already checked in');
    await expect(banner(page)).toContainText('since');
    await expect(banner(page)).toContainText('owes SAR 30');
    await expect(banner(page)).toContainText('Needs bike');
    await page.waitForTimeout(1600);
    await expect(banner(page)).toHaveClass(/scan-bn-warn/);
  });

  test('another night is Stop, with Make an exception still there', async ({ page }) => {
    await boot(page);
    await openScanner(page);
    await scan(page, 'MMC-6-ffff6666');
    await expect(banner(page)).toHaveClass(/scan-bn-err/);
    await expect(banner(page)).toContainText('not today');
    await expect(page.locator('#scan-exception-btn')).toBeVisible();
  });

  test('a blacklisted rider is Stop; Make an exception carries on to the check-in', async ({ page }) => {
    await boot(page);
    await openScanner(page);
    await page.evaluate(`S.customerTags=[{customer_id:'c-ban',tag_id:TAG_BLACKLIST,added_by:'staff',added_at:1}]`);
    await scan(page, 'MMC-2-bbbb2222');
    await expect(banner(page)).toHaveClass(/scan-bn-err/);
    await expect(banner(page)).toContainText('blacklist');
    expect(await page.evaluate('S._ciId')).toBeFalsy();
    await page.locator('#scan-exception-btn').click();
    await expect.poll(() => page.evaluate('S._ciId')).toBe(B);
  });

  test('the Sound switch silences the tone and is kept on the device', async ({ page }) => {
    await boot(page, {}, () => localStorage.setItem('cq_scan_mute', '1'));
    await openScanner(page);
    await expect(page.locator('#scan-mute-btn')).toHaveAttribute('aria-pressed', 'false');
    await scan(page, 'MMC-1-zzzz9999');
    await expect(banner(page)).toHaveClass(/scan-bn-err/);
    expect(await page.evaluate('window.__tones')).toBe(0);
    await page.locator('#scan-mute-btn').click();
    expect(await page.evaluate(`localStorage.getItem('cq_scan_mute')`)).toBe('0');
  });

  test('Keep scanning: after the Confirm the camera comes back saying who was checked in', async ({ page }) => {
    await boot(page, {}, () => localStorage.setItem('cq_scan_cont', '1'));
    await openScanner(page);
    await scan(page, 'MMC-1-aaaa1111');
    await expect(page.locator('#ci-confirm')).toBeVisible();
    await page.evaluate(`window.__bn=[];const m=document.getElementById('scan-modal');new MutationObserver(()=>{const el=document.getElementById('scan-banner');if(el)window.__bn.push(el.className+'|'+el.textContent);}).observe(m,{childList:true,subtree:true,attributes:true})`);
    await page.locator('#ci-confirm').click();
    await expect(page.locator('#scan-modal [role="dialog"]')).toBeVisible();
    await expect.poll(() => page.evaluate(`window.__bn.some(x=>x.includes('scan-bn-ok')&&x.includes('#1 Paid Amal checked in'))`)).toBe(true);
    expect(await page.evaluate('S._ciId')).toBeNull(); // the camera, not the next rider
  });
});

test.describe('@staff:bookings check-in', () => {
  test('"Open the next rider" opens the next one still expected after a Confirm; off, the panel closes', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await boot(page);
    await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
    await page.evaluate(`showCheckinModal('${A}')`);
    const tog = page.locator('#ci-autonext');
    await expect(tog).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#ci-confirm').click();
    await expect.poll(() => page.evaluate('S._ciId')).toBeNull();

    await tog.waitFor({ state: 'detached' });
    await page.evaluate(`showCheckinModal('${C}')`);
    await page.locator('#ci-autonext').click();
    expect(await page.evaluate(`localStorage.getItem('cq_ci_next')`)).toBe('1');
    await expect(page.locator('#ci-autonext')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#ci-confirm').click();
    await expect.poll(() => page.evaluate('S._ciId')).toBe(B); // after #3, back round to the first still expected
  });
});

test.describe('@staff:bookings not here yet', () => {
  test('a chip counts the riders still expected after the start, and filters the roster to them with their contacts', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
    const chip = page.locator('#tab-queue .stat-chip', { hasText: 'Not here yet' });
    await expect(chip).toContainText('3');
    await chip.click();
    expect(await page.evaluate('S.sfStatus')).toBe('nothere');
    await expect.poll(() => page.evaluate(`[...document.querySelectorAll('#tab-queue a[href^="tel:"]')].length`)).toBeGreaterThan(0);
    expect(await page.evaluate(`getQueue().filter(_notHere).map(e=>e.queueNum).sort()`)).toEqual([1, 2, 3]);
    expect(await page.evaluate(`_notHere(getQueue().find(e=>e.id==='${T}'))`)).toBe(false); // tomorrow's
  });
});

test.describe('@staff:bookings device', () => {
  test('the screen stays on while Bookings is open, and lets go elsewhere or when switched off', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue')`);
    await expect.poll(() => page.evaluate(`window.__wl.filter(x=>x==='req').length`)).toBeGreaterThan(0);
    await page.evaluate(`setStaffTab('history')`);
    await expect.poll(() => page.evaluate(`window.__wl[window.__wl.length-1]`)).toBe('rel');
    await goStaffTab(page, 'settings');
    await expect(page.locator('#set-wake')).toBeChecked();
    await page.locator('#set-wake').uncheck();
    expect(await page.evaluate(`localStorage.getItem('cq_wake')`)).toBe('0');
    const n = await page.evaluate(`window.__wl.length`);
    await page.evaluate(`setStaffTab('queue')`);
    await page.waitForTimeout(200);
    expect(await page.evaluate(`window.__wl.length`)).toBe(n);
  });

  test('Booth mode is a staff setting kept on the device: black ink on white', async ({ page }) => {
    await boot(page);
    await goStaffTab(page, 'settings');
    // Booth is one of the Theme choices since 2026-10-09 (Light / Dark / Booth / Follow this device), kept as cq_staff_theme
    await page.locator('#set-theme').selectOption('booth');
    await expect(page.locator('html')).toHaveAttribute('data-staff-theme', 'booth');
    expect(await page.evaluate(`localStorage.getItem('cq_staff_theme')`)).toBe('booth');
    await page.reload();
    await waitForSb(page);
    await expect(page.locator('html')).toHaveAttribute('data-staff-theme', 'booth');
    expect(await page.evaluate(`getComputedStyle(document.body).color`)).toBe('rgb(0, 0, 0)');
  });

  test('the sync label counts unsent changes and says Offline; the flush runs under the outbox lock; storage is asked once', async ({ page, context }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue')`);
    expect(await page.evaluate('window.__persist')).toBe(1);
    await context.setOffline(true);
    await page.evaluate(`localStorage.setItem('cq_sales_outbox',JSON.stringify([{oid:'o1',kind:'upsert',id:'cs1',data:{id:'cs1'}},{oid:'o2',kind:'upsert',id:'cs2',data:{id:'cs2'}}]));_updateConnUI()`);
    await expect(page.locator('#staff-refresh-label')).toHaveText('Offline · 2 unsent');
    await context.setOffline(false);
    await expect.poll(() => page.evaluate(`window.__locks.includes('mm-outbox')`)).toBe(true);
    await expect.poll(() => page.evaluate(`_outboxCount()`)).toBe(0);
    await page.evaluate(`_updateConnUI()`);
    await expect(page.locator('#staff-refresh-label')).not.toContainText('unsent');
  });
});

test.describe('@staff:bookings return and cancellations', () => {
  test("a return's ride time is read from the server's check-in stamp", async ({ page }) => {
    const q = [row('r1', 1, 'Back Rider', { status: 'active', paid: true, assigned_bike_id: 'b1', checked_in_at: new Date(Date.now() - 30 * 60000).toISOString() })];
    await boot(page, { queue_entries: q, bikes: [{ id: 'b1', name: 'Hybrid 01', type: 'Hybrid', size: 'M', status: 'in-use' }] });
    expect(await page.evaluate(`localStorage.getItem('cq_ct_r1')`)).toBeNull(); // checked in on another device
    const w = patches(page);
    await page.evaluate(`S.staffTab='queue';S.sfSession='s0';renderStaffQueue();doReturn('r1')`);
    await page.locator('#ret-confirm').click();
    await expect.poll(() => w.find((x) => x.id === 'r1' && x.body.ride_duration != null)?.body.ride_duration).toBeGreaterThanOrEqual(29);
    expect(Number(w.find((x) => x.id === 'r1' && x.body.ride_duration != null)?.body.ride_duration)).toBeLessThanOrEqual(31);
  });

  test('recently cancelled is read off the synced bookings; closing one keeps only its id on the device', async ({ page }) => {
    const q = [
      row('x1', 1, 'Gone Ghada', { status: 'cancelled', cancelled_at: new Date(Date.now() - 60000).toISOString(), cancelled_by: 'staff' }),
      row('x2', 2, 'Long Gone Lama', { status: 'cancelled', cancelled_at: new Date(Date.now() - 10 * 60000).toISOString() }),
      row('w1', 3, 'Still Here', {}),
      // cancelled long ago, before cancelled_at existed, and touched a minute ago (a merge moved it): not news
      row('x3', 4, 'Old Omar', { session_id: 's9', session_day: 'Monday', session_date: '2026-09-01', status: 'cancelled', updated_at: new Date(Date.now() - 60000).toISOString() }),
    ];
    await boot(page, { queue_entries: q }, () => localStorage.setItem('cq_cancellations', JSON.stringify([{ entryId: 'old', name: 'Old Name', timestamp: Date.now() }])));
    expect(await page.evaluate(`localStorage.getItem('cq_cancellations')`)).toBeNull(); // the old log, names and all, is gone
    await page.evaluate(`setStaffTab('queue');setSfSession('all')`);
    const strip = page.locator('#tab-queue .rq-cx');
    await expect(strip).toHaveCount(1);
    await expect(strip).toContainText('Gone Ghada');
    const x = strip.locator('.rq-cxx');
    await expect(x).toHaveAttribute('aria-label', 'Hide the cancellation of #1 Gone Ghada');
    await x.click();
    await expect(strip).toHaveCount(0);
    expect(await page.evaluate(`localStorage.getItem('cq_cx_hide')`)).toBe('["x1"]');
  });
});
