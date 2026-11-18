import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff Bookings round, 2026-11-18, item 2: "Move selected riders to another session. Tick riders, then 'Move 8 to...'.
// Payments stay with them, the type caps are checked, and it's one server call with a log line per rider."
// The bulk row's Move {0} counts the ticked riders still in line (never one on a bike); the dialog (desk part) picks the
// session, adds the rest of a ticked rider's party with its switch, and moves each row the way Edit Booking's session change
// moves one (_bkMoveCols / _bkMoveWrite), three at a time; a refused row stays ticked and is named in the dialog; a target
// type with no place left is asked about first. Invented riders only. The clock is fixed on the evening of the night.

type Row = Record<string, unknown>;
const DAY = '2099-05-05', TO = '2099-05-12', CAP = '2099-05-19';
const night = (id: string, x: Row = {}): Row => ({ id, session_date: id, day: 'Tuesday', status: 'open', capacity: 10, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":10}', ...x });
const row = (id: string, num: number, status: string, x: Row = {}): Row => ({
  id, session_id: DAY, session_day: 'Tuesday', session_date: DAY, queue_num: num, name: 'Rider ' + id.toUpperCase(),
  phone: '', customer_id: null, group_id: null, status, paid: false, price: 75, walk_in: true,
  registered_at: `2020-01-01T10:0${num}:00Z`, type_preference: 'Road', size: 'M', ...x,
});
const riders = (): Row[] => [
  row('w1', 1, 'waiting', { customer_id: 'c1' }),
  row('w2', 2, 'waiting', { customer_id: 'c1' }),                       // w1's party, not ticked
  row('w3', 3, 'waitlist', { type_preference: 'Hybrid', waitlist_num: 1 }),
  row('a4', 4, 'active', { paid: true }),                                // on a bike: never moved
  row('x1', 1, 'waiting', { session_id: CAP, session_date: CAP }),       // takes CAP's one Road place
];

async function desk(page: Page) {
  const rows = riders();
  await page.clock.setFixedTime(new Date(`${DAY}T20:00:00+03:00`));
  await stubSupabase(page, {
    sessions: [night(DAY), night(TO), night(CAP, { bike_slots: '{"_time":"21:00 - 23:00","_total":10,"Road":1}' })],
    bikes: [], queue_entries: rows,
  });
  // The stub echoes a write without keeping it: keep it, so the read after the move finds the rows where they went.
  await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
    const r = route.request();
    if (r.method() === 'PATCH') {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      const x = rows.find((y) => y.id === id);
      try { if (x) Object.assign(x, r.postDataJSON() || {}); } catch { /* not JSON */ }
    }
    return route.fallback();
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
  await page.evaluate(`S.staffTab='queue';S.queueView='bookings';S.sfSession='${DAY}';S.sfStatus='all';_partyOpenAll();renderStaffQueue()`);
  return rows;
}
const patches = (page: Page) => {
  const out: { url: string; body: Row }[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'PATCH' || !/\/rest\/v1\/queue_entries/.test(r.url())) return;
    let b: Row = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ }
    out.push({ url: decodeURIComponent(r.url()), body: b });
  });
  return out;
};
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function openMove(page: Page, ticked: string[]) {
  await page.evaluate(`S.sfSelected=${JSON.stringify(ticked)};renderStaffQueue()`);
  await page.locator('#bulk-move').click();
  const dlg = page.locator('#desk-sheet [role="dialog"]');
  await expect(dlg.locator('#bmv-go')).toBeVisible();
  return dlg;
}
const pick = (page: Page, sid: string) => page.evaluate(`(()=>{const s=document.getElementById('bmv-sess');s.value='${sid}';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);

test.describe('@staff:bookings bulk move', () => {
  test('Move counts the ticked riders still in line, never one on a bike', async ({ page }) => {
    await desk(page);
    await page.evaluate(`S.sfSelected=['w1','w3','a4'];renderStaffQueue()`);
    await expect(page.locator('#bulk-move')).toHaveText('Move 2');
    await page.evaluate(`S.sfSelected=['a4'];renderStaffQueue()`);
    await expect(page.locator('#q-bulk')).toBeVisible();
    await expect(page.locator('#bulk-move')).toHaveCount(0);
  });

  test('the party switch adds the unticked riders of a ticked rider\'s party, and the button counts them', async ({ page }) => {
    await desk(page);
    const dlg = await openMove(page, ['w1']);
    await expect(dlg).toHaveAttribute('aria-labelledby', 'dk-sheet-t');
    await expect(dlg.locator('#bmv-party')).toBeChecked();
    await expect(dlg.locator('#bmv-go')).toHaveText('Move 2 riders');
    await dlg.locator('#bmv-party').uncheck();
    await expect(dlg.locator('#bmv-go')).toHaveText('Move 1 rider');
    // no session picked: Move says so, and nothing is written
    const sent = patches(page);
    await dlg.locator('#bmv-go').click();
    await expect(dlg.locator('#bmv-err')).toHaveText('Choose a session');
    expect(sent).toHaveLength(0);
    // the picker offers the other open nights, not this one
    const offered = await page.evaluate(`[...document.querySelectorAll('#bmv-sess option')].map(o=>o.value).filter(Boolean)`);
    expect(offered).toEqual([TO, CAP]);
  });

  test('each rider is moved by its own guarded write with the move\'s columns, one Log line each, and leaves the roster', async ({ page }) => {
    await desk(page);
    const sent = patches(page);
    const logs: Row[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/rest\/v1\/staff_actions/.test(r.url())) { try { const b = r.postDataJSON(); logs.push(...(Array.isArray(b) ? b : [b])); } catch { /* none */ } }
    });
    const dlg = await openMove(page, ['w1', 'w3']);
    await pick(page, TO);
    await expect(dlg.locator('.tyl-row')).toContainText('Places left: 10');
    await expect(dlg.locator('#bmv-go')).toHaveText('Move 3 riders');           // w2 comes with w1's party
    await dlg.locator('#bmv-go').click();
    await expect.poll(() => sent.length).toBe(3);
    await expect(page.locator('#desk-sheet [role="dialog"]')).toHaveCount(0); // nothing failed: the dialog closes, no bar
    const by = (id: string) => sent.find((w) => w.url.includes(`id=eq.${id}&`) || w.url.endsWith(`id=eq.${id}`))!;
    for (const id of ['w1', 'w2', 'w3']) {
      const w = by(id);
      expect(w, id).toBeTruthy();
      expect(w.body).toMatchObject({ session_id: TO, session_day: 'Tuesday', session_date: TO });
      expect('paid' in w.body).toBe(false);                                     // the payment stays with the rider
      expect(w.url).toContain(`status=eq.${id === 'w3' ? 'waitlist' : 'waiting'}`);
    }
    expect(by('w3').body.status).toBe('waiting');                             // off the waitlist, in line on the new night
    expect('status' in by('w1').body).toBe(false);
    expect(sent.map((w) => w.body.queue_num).sort()).toEqual([1, 2, 3]);      // numbers of their own on the new night
    await expect(page.locator('#q-results')).not.toContainText('Rider W1');
    await expect(page.locator('#q-results')).toContainText('Rider A4');
    expect(await page.evaluate('S.sfSelected.length')).toBe(0);
    await expect.poll(() => logs.filter((l) => l.kind === 'move').length).toBe(3);
    const mv = logs.filter((l) => l.kind === 'move');
    expect(mv.map((l) => l.entity_id).sort()).toEqual(['w1', 'w2', 'w3']);
    expect(mv.every((l) => l.entity === 'booking' && !!l.client_id)).toBe(true);
    expect(String(mv.find((l) => l.entity_id === 'w1')!.action)).toMatch(/^Moved: #1 Rider W1 → /);
    await expect(page.locator('#topbar-right .undo-btn')).toBeVisible();
  });

  test('a refused rider stays ticked and on the night, named in the dialog with why; the others move', async ({ page }) => {
    await desk(page);
    await page.route(/\/rest\/v1\/queue_entries\?.*id=eq\.w3/, (route) => route.request().method() === 'PATCH'
      ? json(route, { code: 'P0001', message: 'PAID_MOVE: the fare differs', details: null, hint: null }, 400)
      : route.fallback());
    const dlg = await openMove(page, ['w1', 'w3']);
    await pick(page, TO);
    await dlg.locator('#bmv-go').click();
    await expect(dlg.locator('#bmv-err')).toContainText('1 not moved:');
    await expect(dlg.locator('#bmv-err')).toContainText('#3 Rider W3');
    await expect(dlg.locator('#bmv-err')).toContainText('different fare');
    await expect(dlg.locator('#bmv-go')).toHaveText('Move 1 rider');          // the dialog stays on the one left
    expect(await page.evaluate('S.sfSelected')).toEqual(['w3']);
    await expect.poll(() => page.evaluate(`[_qGet('w1').sessionId,_qGet('w2').sessionId,_qGet('w3').sessionId].join()`)).toBe(`${TO},${TO},${DAY}`);
    await expect(page.locator('#q-results')).toContainText('Rider W3');
  });

  test('a target type with no place left is asked about first: Pick another session writes nothing, Move anyway moves', async ({ page }) => {
    await desk(page);
    const sent = patches(page);
    const dlg = await openMove(page, ['w1']);
    await dlg.locator('#bmv-party').uncheck();
    await pick(page, CAP);
    await expect(dlg.locator('.tyl-row')).toContainText('Road 0 left');
    await dlg.locator('#bmv-go').click();
    const ask = page.locator('#confirm-modal [role="dialog"]');
    await expect(ask).toContainText('Road is full on');
    await expect(ask).toContainText('(1 of 1). Move anyway?');
    await ask.getByRole('button', { name: 'Pick another session' }).click();
    await expect(ask).toHaveCount(0);
    await expect(dlg.locator('#bmv-go')).toBeVisible();
    expect(sent).toHaveLength(0);
    await dlg.locator('#bmv-go').click();
    await ask.getByRole('button', { name: 'Move anyway' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toMatchObject({ session_id: CAP, queue_num: 2 });
    await expect(page.locator('#desk-sheet [role="dialog"]')).toHaveCount(0);
  });
});
