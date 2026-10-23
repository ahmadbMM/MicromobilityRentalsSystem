import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// Petromin's invitation (the owner, 2026-10-23): before a Petromin night is booked, a pop-up shows
// Petromin's invitation into the circuit and asks the rider to show it at the gate. It is skippable:
// Continue, Skip and the close button all go on to book. Other rides never show it. The Petromin ticket
// keeps the invitation for the gate, opened from the ticket with Close only. Each night has its own
// image (bike_slots._inv, set on the session form); a night without one shows nothing, and a walk-in
// (how the Petromin form's riders reach the ride) never sees it. Supabase is stubbed.

const INV = 'https://abcd.supabase.co/storage/v1/object/public/photos/p/pminv-n1.webp';

const PW = '2099-10-14-pw';
const pw = {
  id: PW, session_date: '2099-10-14', day: 'Wednesday', status: 'open', capacity: 35, created_at: 1,
  event_kind: 'community', ride_kind: 'petromin', needs_approval: false, open_to_all: false, paid_ride: true,
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 35, _inv: INV }), location: 'JCC',
};
const PW2 = '2099-10-21-pw';
const pwNoInv = { ...pw, id: PW2, session_date: '2099-10-21', bike_slots: '{"_time":"21:00 - 23:00"}' };
const jcc = { id: '2099-10-18', session_date: '2099-10-18', day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC' };

async function boot(page: Page) {
  await stubSupabase(page, { sessions: [pw, pwNoInv, jcc], queue_entries: [], 'rpc:community_member': false, 'rpc:petromin_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Omar Saleh', birth_date: '1990-01-01' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}
const book = (page: Page, id: string) => page.evaluate(`S.selSession=${JSON.stringify(id)};S.regQty=1;S.regBikeHeights=[175];S.regBikeTypes=['Road'];S.regRiderNames=['Omar Saleh'];S.promoApplied=null;S.waiverOk=true;S._waiverSess=S.selSession;submitReg()`);
const pop = (page: Page) => page.locator('#confirm-modal .pminv-box');

test.describe('@customer:petromin Petromin invitation', () => {
  test('a Petromin night shows the invitation first and books on Continue', async ({ page }) => {
    await boot(page);
    const rows = await captureBookingRows(page);
    await page.locator('#land-events .landing-event-card.ev-petromin').click();
    await page.locator(`#tab-register .sess-card[data-on-click*="${PW}"]`).click();
    await book(page, PW);
    await expect(pop(page)).toBeVisible();
    await expect(pop(page)).toContainText('show this invitation at the gate');
    await expect(pop(page).locator('img.pminv-img')).toHaveAttribute('src', INV);
    await expect(pop(page).locator('a.pminv-save')).toHaveAttribute('download', /petromin/);
    expect(rows.length).toBe(0); // nothing booked while it is open
    await pop(page).locator('#pminv-ok').click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: PW });
    await expect(pop(page)).toHaveCount(0);
  });

  test('Skip and the close button book too', async ({ page }) => {
    await boot(page);
    const rows = await captureBookingRows(page);
    await page.locator('#land-events .landing-event-card.ev-petromin').click();
    await page.locator(`#tab-register .sess-card[data-on-click*="${PW}"]`).click();
    await book(page, PW);
    await pop(page).getByRole('button', { name: 'Skip' }).first().click();
    await expect.poll(() => rows.length).toBe(1);
  });

  test('a ride that is not Petromin never shows it', async ({ page }) => {
    await boot(page);
    await book(page, jcc.id);
    await page.waitForTimeout(300);
    await expect(pop(page)).toHaveCount(0);
  });

  test('a Petromin night without an invitation books straight away', async ({ page }) => {
    await boot(page);
    const rows = await captureBookingRows(page);
    await page.locator('#land-events .landing-event-card.ev-petromin').click();
    await page.locator(`#tab-register .sess-card[data-on-click*="${PW2}"]`).click();
    await book(page, PW2);
    await expect.poll(() => rows.length).toBe(1);
    await expect(pop(page)).toHaveCount(0);
  });

  test('the Petromin ticket shows the invitation again, and opening it books nothing', async ({ page }) => {
    const mine = {
      id: 'm1', session_id: PW, session_day: 'Wednesday', session_date: '2099-10-14', queue_num: 1, waitlist_num: null,
      name: 'Omar Saleh', size: 'M', type_preference: 'Road', status: 'waiting', paid: false, price: 75, customer_id: 'c1',
      registered_at: '2099-10-01T10:00:00Z',
    };
    const walkin = { ...mine, id: 'm2', session_id: PW2, session_date: '2099-10-21', walk_in: true };
    const formNight = { ...pw, id: PW2, session_date: '2099-10-21' };
    await stubSupabase(page, { sessions: [pw, formNight, jcc], bikes: [], queue_entries: [mine, walkin], 'rpc:community_member': false, 'rpc:petromin_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Omar Saleh', birth_date: '1990-01-01' });
    await page.goto('/');
    await waitForSb(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(`showView('customer');setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .pminv-tk');
    await expect(page.locator('#tab-myrides .ticket-card')).toHaveCount(2);
    await expect(tk).toHaveCount(1); // the walk-in place (a Petromin form rider checked in at the desk) has none
    await expect(tk).toContainText('Show it at the gate');
    await tk.getByRole('button', { name: 'Show invitation' }).last().click();
    await expect(pop(page)).toBeVisible();
    await expect(pop(page).getByRole('button', { name: 'Skip' })).toHaveCount(0);
    await pop(page).locator('#pminv-ok').click();
    await expect(pop(page)).toHaveCount(0);
    expect(rows.length).toBe(0);
  });

  test('staff see the field on a Petromin night only, and saving keeps the night’s image', async ({ page }) => {
    await stubSupabase(page, { sessions: [pw, jcc], queue_entries: [], bikes: [] });
    await page.route(/\/rest\/v1\/sessions\?/, async (r) => {
      if (r.request().method() !== 'PATCH') return r.fallback();
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ id: PW }]) });
    });
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'PATCH' || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
      try { const b = r.postDataJSON(); patches.push(Array.isArray(b) ? b[0] : b); } catch { /* none */ }
    });
    await unlockStaff(page);
    await page.goto('/bookings/sessions');
    await waitForSb(page);
    await page.waitForFunction('S.dataLoaded&&allSessions().length===2');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${jcc.id}')`);
    await expect(page.locator('.pminv-fld')).toHaveCount(0);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${PW}')`);
    await expect(page.locator('.pminv-fld img')).toHaveAttribute('src', INV);
    await expect(page.locator('.pminv-fld')).toContainText('Replace');
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBeGreaterThan(0);
    expect(JSON.parse(String(patches[0].bike_slots))._inv).toBe(INV);
  });

  test('staff upload a night’s invitation and the saved night carries it', async ({ page }) => {
    const bare = { ...pw, bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 35 }) };
    await stubSupabase(page, { sessions: [bare], queue_entries: [], bikes: [] });
    const uploads: string[] = [];
    await page.route(/\/storage\/v1\/object\/photos\//, async (r) => {
      uploads.push(decodeURIComponent(r.request().url()));
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '{"Key":"photos/x"}' });
    });
    await page.route(/\/rest\/v1\/sessions\?/, async (r) => {
      if (r.request().method() !== 'PATCH') return r.fallback();
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ id: PW }]) });
    });
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'PATCH' || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
      try { const b = r.postDataJSON(); patches.push(Array.isArray(b) ? b[0] : b); } catch { /* none */ }
    });
    await unlockStaff(page);
    await page.goto('/bookings/sessions');
    await waitForSb(page);
    await page.waitForFunction('S.dataLoaded&&allSessions().length===1');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${PW}')`);
    // a small red PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAA8AQMAAAAud2qjAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6goXDh05VoIs3QAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMC0yM1QxNDoyOTo1NyswMDowMJJ2CgAAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTAtMjNUMTQ6Mjk6NTcrMDA6MDDjK7K8AAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTEwLTIzVDE0OjI5OjU3KzAwOjAwtD6TYwAAAA1JREFUGNNjYBgF9AAAAWgAAdm2FbQAAAAASUVORK5CYII=', 'base64');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.pminv-fld button', { hasText: 'Upload invitation' }).click();
    await (await chooser).setFiles({ name: 'invite.png', mimeType: 'image/png', buffer: png });
    await expect.poll(() => uploads.length).toBe(1);
    expect(uploads[0]).toMatch(/\/photos\/p\/pminv-[A-Za-z0-9_-]+\.(png|jpg)$/);
    await expect(page.locator('.pminv-fld img')).toHaveAttribute('src', /\/object\/public\/photos\/p\/pminv-/);
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBeGreaterThan(0);
    expect(JSON.parse(String(patches[0].bike_slots))._inv).toMatch(/\/photos\/p\/pminv-/);
  });
});
