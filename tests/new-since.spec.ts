import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, stubRealtime, unlockStaff, waitForSb } from './helpers/supabase';

// New since you last looked (the staff Bookings round, 2026-11-18, item 7): "A figure such as 'New 5' for bookings,
// cancellations and type changes since this device last opened the night. Tapping it filters to them. This is for the
// second shift arriving." The device keeps its last look per night in localStorage (cq_nwx: {sid: iso}, cq_nwx_ty: the
// night's {id: type} then). Invented riders only; the clock is fixed on the night's evening.

const DAY = '2099-05-05';
const NOW = new Date(`${DAY}T20:00:00+03:00`); // 17:00Z
const LOOK = `${DAY}T16:00:00.000Z`; // this device last looked at 19:00 Riyadh
const slots = JSON.stringify({ Road: 10, Hybrid: 10, _time: '20:00 - 23:00' });
const sessions = [
  { id: 's0', day: 'Tuesday', session_date: DAY, capacity: 20, status: 'open', created_at: 1, bike_slots: slots },
  { id: 's1', day: 'Wednesday', session_date: '2099-05-06', capacity: 20, status: 'open', created_at: 2, bike_slots: slots },
];
const row = (id: string, qn: number, name: string, type: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Tuesday', session_date: DAY, queue_num: qn, name, phone: '', customer_id: null, group_id: null,
  status: 'waiting', paid: true, price: 75, walk_in: true, registered_at: `${DAY}T15:00:00Z`, height: 175, type_preference: type, ...o,
});
const A = 'aaaa0000-0000-4000-8000-0000000000a1', B = 'bbbb0000-0000-4000-8000-0000000000b2', C = 'cccc0000-0000-4000-8000-0000000000c3';
const D = 'dddd0000-0000-4000-8000-0000000000d4', E = 'eeee0000-0000-4000-8000-0000000000e5', F = 'ffff0000-0000-4000-8000-0000000000f6';
const queue_entries = [
  row(A, 1, 'Amal Same', 'Road'),
  row(B, 2, 'Badr Switch', 'Hybrid'), // Road at the look
  row(C, 3, 'Carim Fresh', 'Road', { registered_at: `${DAY}T16:30:00Z` }), // booked after the look
  row(D, 4, 'Dana Gone', 'Road', { status: 'cancelled', cancelled_at: `${DAY}T16:40:00Z`, cancelled_by: 'customer' }),
  row(E, 5, 'Eid Old', 'Road', { status: 'cancelled', cancelled_at: `${DAY}T15:30:00Z`, cancelled_by: 'customer' }), // before the look
  row(F, 6, 'Fahd Moved', 'Road'), // not on this night at the look
  row('g1', 1, 'Ghada Elsewhere', 'Road', { session_id: 's1', session_date: '2099-05-06', session_day: 'Wednesday', registered_at: `${DAY}T16:50:00Z` }),
];
const LOOK_TY = { [A]: 'Road', [B]: 'Road', [D]: 'Road' };

async function boot(page: Page, look: boolean, width = 1280, height = 800, rows = queue_entries, now = NOW) {
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(now);
  await page.addInitScript(([at, ty, on]) => {
    try {
      if (on && !sessionStorage.getItem('nwx-seeded')) {
        localStorage.setItem('cq_nwx', JSON.stringify({ s0: at }));
        localStorage.setItem('cq_nwx_ty', JSON.stringify({ s0: ty }));
        sessionStorage.setItem('nwx-seeded', '1');
      }
    } catch { /* storage refused */ }
  }, [LOOK, LOOK_TY, look] as const);
  await stubSupabase(page, { queue_entries: rows, sessions, bikes: [], customers: [] });
  await stubRealtime(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length===${rows.length}`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('s0')`);
}
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('cq_nwx') || '{}') as Record<string, string>);
const rt = (page: Page, r: Record<string, unknown>, kind = 'UPDATE') =>
  page.evaluate(`window.__noWiden=false;_onRt({table:'queue_entries',eventType:'${kind}',new:${JSON.stringify(r)},old:{}})`);

test.describe('@staff:bookings New since you last looked', () => {
  test('the figure counts what is new, cancelled or changed since the last look; tapping it lists them marked; Seen ends it', async ({ page }) => {
    await boot(page, true);
    const chip = page.locator('#q-live-count .q-lc-nwx');
    await expect(chip).toHaveText(/New\s*4/); // Carim new, Dana cancelled, Badr another type, Fahd moved here
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    const rows = page.locator('#q-results .queue-table tbody tr[data-id]');
    await expect(rows).toHaveCount(4);
    await expect(page.locator(`#q-results tr[data-id="${C}"] .nwx-tag`)).toHaveText('New');
    await expect(page.locator(`#q-results tr[data-id="${D}"] .nwx-tag`)).toHaveText('Cancelled'); // a cancelled row shows here
    await expect(page.locator(`#q-results tr[data-id="${B}"] .nwx-tag`)).toHaveText('Changed');
    await expect(page.locator(`#q-results tr[data-id="${F}"] .nwx-tag`)).toHaveText('Changed');
    await expect(page.locator(`#q-results tr[data-id="${A}"]`)).toHaveCount(0);
    await expect(page.locator(`#q-results tr[data-id="${E}"]`)).toHaveCount(0); // cancelled before the look
    // a declared filter: the Filters button counts it and its Clear ends it
    await expect(page.locator('#tab-queue .f-show')).toContainText('(1)');
    await expect(page.locator('#tab-queue .f-clr')).toBeVisible();
    // Seen, in the filter's own result line: the look is now, the figure goes, everyone is back
    await page.locator('#q-result-count .nwx-seen').click();
    await expect(chip).toHaveCount(0);
    await expect(page.locator(`#q-results tr[data-id="${A}"]`)).toHaveCount(1);
    await expect(page.locator(`#q-results tr[data-id="${D}"]`)).toHaveCount(0);
    expect((await stored(page)).s0).toBe(NOW.toISOString());
    expect(await page.evaluate("S.sfStatus")).toBe('all');
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0); // no bar after the action
  });

  test('a night never opened here has no figure; leaving marks the look; live rows count, this device\'s own writes do not', async ({ page }) => {
    await boot(page, false);
    await expect(page.locator('#q-live-count .q-lc-btn').first()).toBeVisible();
    await expect(page.locator('#q-live-count .q-lc-nwx')).toHaveCount(0);
    expect((await stored(page)).s0).toBeUndefined();
    // another night picked: s0 was looked at now
    await page.evaluate("setSfSession('s1')");
    expect((await stored(page)).s0).toBe(NOW.toISOString());
    await page.evaluate("setSfSession('s0')");
    await expect(page.locator('#q-live-count .q-lc-nwx')).toHaveCount(0); // nothing since
    // live: a booking made after the look, and another desk changing Amal's type
    await rt(page, row('h1', 7, 'Hala Late', 'Road', { registered_at: `${DAY}T17:05:00Z` }), 'INSERT');
    await rt(page, row(A, 1, 'Amal Same', 'Hybrid'));
    await expect(page.locator('#q-live-count .q-lc-nwx')).toHaveText(/New\s*2/);
    // this device's own write to Badr (a landed write answers with its row), then the change comes back live: not news
    await page.evaluate(`_writeErr({data:[{id:'${B}'}],error:null},'spec')`);
    await rt(page, row(B, 2, 'Badr Switch', 'Road'));
    await page.evaluate('renderStaffQueue()');
    await expect(page.locator('#q-live-count .q-lc-nwx')).toHaveText(/New\s*2/);
    // leaving the section marks the night too
    await page.evaluate(`localStorage.removeItem('cq_nwx');setStaffTab('sessions')`);
    expect((await stored(page)).s0).toBe(NOW.toISOString());
  });

  test('phone: the figure sits in the night\'s bar and the first card keeps the fold budget', async ({ page }) => {
    // before the ride (no pace line) and no cancellation in the last minutes: those lines are not this figure's to measure
    await boot(page, true, 390, 844, queue_entries.filter((r) => r.status !== 'cancelled'), new Date(`${DAY}T17:00:00+03:00`));
    const chip = page.locator('#q-live-count .q-lc-nwx');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/New\s*3/);
    const box = (await chip.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390); // in sight beside Owing and Not arrived
    const top = await page.locator('#q-results .q-card').first().evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
    expect(top).toBeLessThanOrEqual(400);
  });
});
