import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, stubRealtime, unlockStaff, waitForSb } from './helpers/supabase';

// Staff round s10 (2026-11-10), items 48-50: a handover note per night (session_notes: the figures bar's Notes (N), its
// centred pop-up, the Dashboard's card, the bell, another desk's note on staff-ref), an incident on a booking
// (booking_incidents: Record incident in the ⋯ menu, the account window, History > Incidents) and the places left per
// bike type in the figures bar and the walk-in form. Migration 20261111130000. Invented riders only; the clock is fixed
// on the session's evening so the night is always "today".

const DAY = '2099-05-05';
const NOW = new Date(`${DAY}T20:00:00+03:00`);
const session = {
  id: 's0', day: 'Tuesday', session_date: DAY, capacity: 12, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ Road: 4, Hybrid: 2, _time: '20:00 - 23:00' }), closed_types: ['Kids'],
};
const row = (id: string, qn: number, name: string, type: string, status = 'waiting', cid: string | null = null): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Tuesday', session_date: DAY, queue_num: qn, name, phone: '', customer_id: cid, group_id: null,
  status, paid: true, price: 75, walk_in: true, registered_at: `${DAY}T15:00:00Z`, height: 175, type_preference: type,
});
const A = 'aaaa1111-0000-4000-8000-0000000000a1', B = 'bbbb2222-0000-4000-8000-0000000000b2', C = 'cccc3333-0000-4000-8000-0000000000c3';
const rows = [row(A, 1, 'Amal Road', 'Road', 'waiting', 'cust-amal'), row(B, 2, 'Badr Road', 'Road'), row(C, 3, 'Carim Hybrid', 'Hybrid', 'active')];
const customers = [{ id: 'cust-amal', name: 'Amal Road', phone: '0500000011', created_at: '2026-01-01T00:00:00Z' }];
const note1 = { id: 1, session_id: 's0', body: 'Lockers 4 and 9 jammed', author_id: 'u-sara', author_name: 'Sara', created_at: `${DAY}T14:00:00Z`, edited_at: null };
const head = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };

// A table as the server would hold it: what is posted comes back stamped (the shared stub only echoes).
function serve(page: Page, table: string, held: Record<string, unknown>[], stamp: (b: Record<string, unknown>) => Record<string, unknown>) {
  const sent: Record<string, unknown>[] = [];
  return page.route(new RegExp(`/rest/v1/${table}`), async (r: Route) => {
    const m = r.request().method();
    if (m === 'POST') {
      const b = r.request().postDataJSON() as Record<string, unknown>;
      sent.push(b);
      const x = { ...b, id: held.length + 100, ...stamp(b) };
      held.push(x);
      return r.fulfill({ status: 201, headers: head, body: JSON.stringify([x]) });
    }
    if (m === 'GET') return r.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${held.length}/${held.length}` }, body: JSON.stringify(held) });
    return r.fallback();
  }).then(() => sent);
}

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { queue_entries: rows, sessions: [session], bikes: [], customers, ...extra });
  const rt = await stubRealtime(page);
  await unlockStaff(page);
  return rt;
}
async function toRoster(page: Page) {
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
}

test.describe('@staff:bookings round s10: notes, incidents, places left', () => {
  test('the figures bar says the places left per bike type and the night\'s notes; the pop-up takes a note with no toast', async ({ page }) => {
    await boot(page);
    const held = [{ ...note1 }];
    const sent = await serve(page, 'session_notes', held, () => ({ author_id: 'me', author_name: 'Desk', created_at: NOW.toISOString(), edited_at: null }));
    await toRoster(page);
    const bar = page.locator('#q-live-count');
    // Road: 4 places less the two Road bookings; Hybrid: 2 less the one on a bike; Kids is closed on this night
    await expect(bar.locator('.tyl-row')).toContainText('Road 2 left');
    await expect(bar.locator('.tyl-row')).toContainText('Hybrid 1 left');
    await expect(bar.locator('.tyl-x')).toContainText('Kids closed');
    const chip = bar.locator('.snt-chip');
    await expect(chip).toHaveText(/Notes \(1\)/);
    await chip.click();
    const sheet = page.locator('#desk-sheet [role="dialog"]');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Handover notes');
    await expect(sheet.locator('.snt-item')).toHaveCount(1);
    await expect(sheet.locator('.snt-item')).toContainText('Sara');
    await expect(sheet.locator('.snt-item')).toContainText('Lockers 4 and 9 jammed');
    await sheet.getByLabel('New note').fill('  Two helmets missing  ');
    await sheet.getByRole('button', { name: 'Add note' }).click();
    await expect(sheet.locator('.snt-item')).toHaveCount(2);
    await expect(sheet.locator('.snt-item').first()).toContainText('Two helmets missing'); // newest first
    expect(sent).toEqual([{ session_id: 's0', body: 'Two helmets missing' }]); // the author and time are the database's to stamp
    await expect(chip).toHaveText(/Notes \(2\)/);
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0); // no bar, no toast after a note
    // the author edits their own note (Edit is offered on it), and the box empties after
    await expect(sheet.locator('.snt-item').first().getByRole('button', { name: 'Edit' })).toBeVisible();
  });

  test('another desk\'s note arrives on staff-ref: the chip counts it and the bell has a line for it', async ({ page }) => {
    const rt = await boot(page, { session_notes: [note1] });
    await toRoster(page);
    await expect(page.locator('#q-live-count .snt-chip')).toHaveText(/Notes \(1\)/);
    await page.evaluate(`S._staffAuthed = true; setupRefRealtime()`);
    await page.waitForFunction('_refLive === true', null, { timeout: 8000 });
    // the bell took today's notes as known once they were read whole: nothing new yet
    await expect.poll(() => page.evaluate(`_ntItems().filter(i=>i.k==='snote').length`)).toBe(0);
    rt.broadcast('realtime:staff-ref', 'session_notes', { op: 'INSERT', row: { id: 7, session_id: 's0', body: 'Gate code changed', author_id: 'u-omar', author_name: 'Omar', created_at: `${DAY}T16:30:00Z`, edited_at: null } });
    await expect(page.locator('#q-live-count .snt-chip')).toHaveText(/Notes \(2\)/);
    await expect.poll(() => page.evaluate(`_ntItems().filter(i=>i.k==='snote').map(i=>i.txt).join('|')`)).toBe('Note from Omar: Gate code changed');
    // a delete from another desk takes it off again
    rt.broadcast('realtime:staff-ref', 'session_notes', { op: 'DELETE', row: null, old: { id: 7, session_id: 's0' } });
    await expect(page.locator('#q-live-count .snt-chip')).toHaveText(/Notes \(1\)/);
    // the Settings switch for the kind is there
    expect(await page.evaluate(`NT_KINDS.some(k=>k[0]==='snote'&&k[2]==='queue')`)).toBe(true);
  });

  test('the Dashboard shows today\'s latest notes', async ({ page }) => {
    await boot(page, { session_notes: [note1] });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('dashboard')`);
    const card = page.locator('#tab-dashboard .dash-card').filter({ has: page.getByRole('heading', { name: 'Handover notes', exact: true }) });
    await expect(card).toContainText('Lockers 4 and 9 jammed');
    await expect(card).toContainText('Sara');
  });

  test('before the database has the tables, Notes and Record incident say so', async ({ page }) => {
    await boot(page);
    const missing = (r: Route) => r.fulfill({ status: 404, headers: head, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table', details: null, hint: null }) });
    await page.route(/\/rest\/v1\/session_notes/, missing);
    await page.route(/\/rest\/v1\/booking_incidents/, missing);
    await toRoster(page);
    await page.waitForFunction(`S._snt&&S._snt.miss===true&&S._inc&&S._inc.miss===true`);
    await page.locator('#q-live-count .snt-chip').click();
    await expect(page.locator('.toast').filter({ hasText: 'Waiting for the database update' }).first()).toBeVisible();
    await expect(page.locator('#desk-sheet [role="dialog"]')).toHaveCount(0);
  });

  test('Record incident: in the menu beside the emergency contact, asks what happened, and shows on the booking, the account and History', async ({ page }) => {
    await boot(page);
    const held: Record<string, unknown>[] = [];
    const sent = await serve(page, 'booking_incidents', held, (b) => ({
      session_id: 's0', customer_id: b.booking_id === A ? 'cust-amal' : null, rider_name: b.booking_id === A ? 'Amal Road' : '', created_at: NOW.toISOString(), author_id: 'me', author_name: 'Desk',
    }));
    await toRoster(page);
    const labels = () => page.evaluate(`(S._rowMenus['${A}']||[]).map(i=>i.label.replace(/<[^>]+>/g,'').trim())`) as Promise<string[]>;
    const before = await labels();
    expect(before).toContain('Record incident');
    expect(before.indexOf('Record incident')).toBe(before.findIndex((l) => /Emergency contact/.test(l)) + 1); // right after it, in its group
    // a walk-in with no account (no emergency contact) has it under Booking, not a heading of its own
    expect(await page.evaluate(`S._rowMenus['${B}'].find(i=>/Record incident/.test(i.label)).g`)).toBe('bk');
    // never in the row's own action slot
    await expect(page.locator('.queue-table tbody tr, .q-card').filter({ hasText: 'Amal Road' }).first().getByRole('button', { name: 'Record incident' })).toHaveCount(0);
    await page.evaluate(`S._rowMenus['${A}'].find(i=>/Record incident/.test(i.label)).act()`);
    const sheet = page.locator('#desk-sheet [role="dialog"]');
    await expect(sheet).toContainText('Record incident · Amal Road');
    await expect(sheet.getByLabel('When')).toHaveValue(`${DAY}T20:00`); // now, in Riyadh
    await sheet.locator('.chrome-dact').getByRole('button', { name: 'Record incident' }).click();
    await expect(sheet.locator('#inc-err')).toHaveText('Choose what happened.');
    expect(sent).toHaveLength(0);
    await sheet.getByRole('button', { name: 'First aid given' }).click();
    await expect(sheet.getByRole('button', { name: 'First aid given' })).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByLabel('Note').fill('Grazed knee, cleaned and dressed');
    await sheet.locator('.chrome-dact').getByRole('button', { name: 'Record incident' }).click();
    await expect(sheet).toHaveCount(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ booking_id: A, kind: 'first_aid', note: 'Grazed knee, cleaned and dressed' });
    expect(Date.parse(String(sent[0].happened_at))).toBe(NOW.getTime());
    await expect.poll(labels).toContain('Record incident (1)');
    // the account window's Stats part
    await page.evaluate(`openAccountHistory('cust-amal')`);
    const stats = page.locator('#cust-modal #ah-pane-stats');
    await expect(stats).toContainText('Incidents');
    await expect(stats).toContainText('First aid given');
    await expect(stats).toContainText('Recorded by Desk');
    await page.evaluate(`closeCustomerProfile()`);
    // History > Incidents, for admins
    await page.evaluate(`setStaffTab('history');S.histView='incidents';renderHistory()`);
    const list = page.locator('#inc-host .inc-hist');
    await expect(list).toContainText('Amal Road');
    await expect(list).toContainText('Grazed knee, cleaned and dressed');
  });

  test('the walk-in form says the places left of each bike type', async ({ page }) => {
    await boot(page);
    await toRoster(page);
    await page.evaluate(`showWalkinModal()`);
    const m = page.locator('#walkin-modal');
    await expect(m.locator('[data-wi-type="Road"] .tyl-wi')).toHaveText('2 left');
    await expect(m.locator('[data-wi-type="Hybrid"] .tyl-wi')).toHaveText('1 left');
    await expect(m.locator('[data-wi-type="Mountain"] .tyl-wi')).toHaveCount(0); // the night does not count Mountain bikes
  });
});
