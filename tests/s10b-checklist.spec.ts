import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, stubRealtime, unlockStaff, waitForSb } from './helpers/supabase';

// Staff round s10, second batch (2026-11-11), owner decision D10: the night checklists. The close-night list opens when staff
// press Close out, before the close-out runs (the app's own checks: riders on a bike, owing with Leave owing, lockers, this
// phone's unsent changes, the drawer count; then the staff-ticked items), names what is open with Go back and Close out
// anyway, and logs the result; the Settings switch keeps Close out refused while an item is open. The opening list is
// "Open the night" in Bookings' More and a Dashboard prompt. Admins edit both lists in Settings > Business
// (staff_options 'night_checklists'). Ticks are session_checks rows (migration 20261111180400), another desk's arrive on
// staff-ref. Invented riders only; the clock is fixed on the night so it is always "today".

const DAY = '2099-05-05';
const NOW = new Date(`${DAY}T22:30:00+03:00`);
const session = {
  id: 's0', day: 'Tuesday', session_date: DAY, capacity: 12, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ Road: 6, _time: '20:00 - 22:00' }),
};
const row = (id: string, qn: number, name: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Tuesday', session_date: DAY, queue_num: qn, name, phone: '', customer_id: null, group_id: null,
  status, paid: true, price: 75, walk_in: true, registered_at: `${DAY}T15:00:00Z`, height: 175, type_preference: 'Road', ...extra,
});
const A = 'aaaa1111-0000-4000-8000-0000000000a1', B = 'bbbb2222-0000-4000-8000-0000000000b2', C = 'cccc3333-0000-4000-8000-0000000000c3';
const head = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
const tillCounted = [{ id: 't1', day: DAY, session_id: 's0', opened_at: `${DAY}T16:00:00Z`, closed_at: `${DAY}T19:20:00Z` }];

// session_checks as the server would hold it: a POST comes back stamped, a DELETE takes the row away.
async function serveChecks(page: Page, held: Record<string, unknown>[]) {
  const sent: { m: string; body?: Record<string, unknown>; url: string }[] = [];
  await page.route(/\/rest\/v1\/session_checks/, async (r: Route) => {
    const m = r.request().method(), url = r.request().url();
    if (m === 'POST') {
      const b = r.request().postDataJSON() as Record<string, unknown>;
      sent.push({ m, body: b, url });
      const x = { ...b, id: held.length + 100, done_by: 'me', done_by_name: 'Desk Dana', done_at: NOW.toISOString() };
      held.push(x);
      return r.fulfill({ status: 201, headers: head, body: JSON.stringify([x]) });
    }
    if (m === 'DELETE') {
      sent.push({ m, url });
      const id = decodeURIComponent(url).match(/id=eq\.(\d+)/)?.[1];
      const i = held.findIndex((x) => String(x.id) === id);
      const gone = i >= 0 ? held.splice(i, 1) : [];
      return r.fulfill({ status: 200, headers: head, body: JSON.stringify(gone.map((x) => ({ id: x.id }))) });
    }
    if (m === 'GET') return r.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${held.length}/${held.length}` }, body: JSON.stringify(held) });
    return r.fallback();
  });
  return sent;
}

async function boot(page: Page, rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { queue_entries: rows, sessions: [session], bikes: [], till_sessions: tillCounted, till_counts: [], ...extra });
  const rt = await stubRealtime(page);
  await unlockStaff(page);
  return rt;
}
async function toRoster(page: Page) {
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
}
const sheet = (page: Page) => page.locator('#desk-sheet [role="dialog"]');
const logLines = (page: Page) => page.evaluate(`S.fullLog.map(l=>l.label)`) as Promise<string[]>;

test.describe('@staff:bookings round s10b: night checklists', () => {
  test('Close out opens the close-night list first: the app\'s own checks with their reasons, Leave owing, ticks, then Close out anyway and its log line', async ({ page }) => {
    await boot(page, [
      row(A, 1, 'Amal Road', 'active', { checked_in_at: `${DAY}T17:05:00Z` }),
      row(B, 2, 'Badr Road', 'done', { paid: false, checked_in_at: `${DAY}T17:06:00Z` }),
      row(C, 3, 'Carim Road', 'waiting'),
    ]);
    const held: Record<string, unknown>[] = [];
    const sent = await serveChecks(page, held);
    await toRoster(page);
    const co = page.locator('#tab-queue .section-header .co-head');
    if (await co.isVisible()) await co.click();
    else { await page.locator('#tab-queue .sh-more').first().click(); await page.getByRole('menuitem', { name: /Close out/ }).click(); } // a phone's Desk tools
    const dlg = sheet(page);
    await expect(dlg).toContainText('Close-night checklist');
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0); // the close-out itself has not started
    const auto = dlg.locator('.ck-list').first().locator('.ck-li');
    await expect(auto).toHaveCount(5);
    await expect(auto.nth(0)).toContainText('No one is still on a bike');
    await expect(auto.nth(0)).toContainText('1 still on a bike: #1 Amal Road');
    await expect(auto.nth(0).locator('.ck-no')).toHaveCount(1);
    await expect(auto.nth(1)).toContainText('Everyone who owes has paid');
    await expect(auto.nth(1)).toContainText('1 still owe');
    await expect(auto.nth(2)).toContainText('No lockers tonight');
    await expect(auto.nth(2).locator('.ck-ok')).toHaveCount(1);
    await expect(auto.nth(3)).toContainText('Everything is sent');
    await expect(auto.nth(4)).toContainText('The cash drawer is counted');
    await expect(auto.nth(4)).toContainText('Counted');                        // the night's till was closed
    // the staff-ticked items: the four built-in ones, none ticked
    const man = dlg.locator('.ck-tick');
    await expect(man).toHaveCount(4);
    await expect(man.nth(0)).toHaveAttribute('aria-checked', 'false');
    await expect(dlg.locator('.ck-open')).toContainText('Not done yet: No one is still on a bike, Everyone who owes has paid, Helmets counted and back');
    await expect(dlg.getByRole('button', { name: 'Go back' })).toBeVisible();
    // tick one: the database stamps who and when; it shows on the item
    await dlg.getByRole('checkbox', { name: 'Helmets counted and back' }).click();
    await expect(dlg.getByRole('checkbox', { name: 'Helmets counted and back' })).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.locator('.ck-li').filter({ hasText: 'Helmets counted and back' })).toContainText('Desk Dana');
    expect(sent[0].body).toEqual({ session_id: 's0', list: 'close', item_key: 'helmets' });
    // Badr is left owing on purpose: the owing item is done
    await dlg.getByRole('button', { name: 'Leave owing' }).click();
    await expect(auto.nth(1)).toContainText('Everyone who owes is left owing on purpose');
    await expect(dlg.getByRole('button', { name: 'Leave owing' })).toHaveAttribute('aria-pressed', 'true');
    expect(sent[1].body).toEqual({ session_id: 's0', list: 'close', item_key: `owe:${B}` });
    // untick takes the row away
    await dlg.getByRole('checkbox', { name: 'Helmets counted and back' }).click();
    await expect(dlg.getByRole('checkbox', { name: 'Helmets counted and back' })).toHaveAttribute('aria-checked', 'false');
    expect(sent[2].m).toBe('DELETE');
    // the incident item leads to History > Incidents (an admin), the note item to the night's notes
    await expect(dlg.locator('.ck-li').filter({ hasText: 'Any incident written down' }).getByRole('button', { name: 'Incidents' })).toBeVisible();
    await expect(dlg.locator('.ck-li').filter({ hasText: 'Handover note written' }).getByRole('button', { name: 'Notes' })).toBeVisible();
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0); // no bar, no toast after a tick
    // Close out anyway: on to the close-out's own question, then its log names what was open
    await dlg.getByRole('button', { name: 'Close out anyway' }).click();
    await expect(sheet(page)).toHaveCount(0);
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box).toBeVisible();
    await box.locator('.btn-red').click();
    await expect.poll(async () => (await logLines(page)).find((l) => l.startsWith('Close checklist')) || '').toMatch(/^Close checklist: closed with 5 open \(No one is still on a bike, Helmets counted and back, Bikes locked and stored, container closed, Any incident written down, Handover note written for the next shift\)$/);
    // the next Close out asks the list again
    await page.evaluate(`closeOutSession('s0')`);
    await expect(sheet(page)).toContainText('Close-night checklist');
  });

  test('every item done: the list says so, Close out goes on, the handover note ticks itself and the log says done', async ({ page }) => {
    const ticks = ['helmets', 'stored', 'incident'].map((k, i) => ({ id: i + 1, session_id: 's0', list: 'close', item_key: k, done_by: 'u-sara', done_by_name: 'Sara', done_at: `${DAY}T19:00:00Z` }));
    await boot(page, [row(A, 1, 'Amal Road', 'waiting', { checked_in_at: `${DAY}T17:05:00Z` })], {
      session_notes: [{ id: 1, session_id: 's0', body: 'Two helmets missing', author_id: 'u-sara', author_name: 'Sara', created_at: `${DAY}T18:00:00Z`, edited_at: null }],
    });
    await serveChecks(page, ticks);
    await toRoster(page);
    await page.evaluate(`closeOutSession('s0')`);
    const dlg = sheet(page);
    await expect(dlg.locator('.ck-prog')).toHaveText('All done');
    await expect(dlg.getByRole('checkbox', { name: /Handover note written/ })).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.locator('.ck-li').filter({ hasText: 'Handover note written' })).toContainText('The night has a handover note');
    await expect(dlg.locator('.ck-li').filter({ hasText: 'Helmets counted and back' })).toContainText('Sara');
    await expect(dlg.locator('.ck-open')).toHaveCount(0);
    await expect(dlg.getByRole('button', { name: 'Close out anyway' })).toHaveCount(0);
    await dlg.locator('.ck-go.btn-primary').click();
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box).toBeVisible();
    await box.locator('.btn-red').click();
    await expect.poll(async () => (await logLines(page)).includes('Close checklist done')).toBe(true);
  });

  test('the Settings switch: Close out stays refused until every item is done', async ({ page }) => {
    const opt = { key: 'night_checklists', items: { v: 1, must: true, open: [], close: [{ k: 'helmets', lk: 'ckHelmetsBack' }, { k: 'radio1', l: 'Radios on charge' }] } };
    await boot(page, [row(A, 1, 'Amal Road', 'waiting', { checked_in_at: `${DAY}T17:05:00Z` })], { staff_options: [opt] });
    await serveChecks(page, []);
    await toRoster(page);
    await page.evaluate(`closeOutSession('s0')`);
    const dlg = sheet(page);
    await expect(dlg.locator('.ck-tick')).toHaveCount(2);                     // the admins' list, not the built-in four
    await expect(dlg.locator('.ck-open')).toContainText('The checklist must be complete before Close out');
    await expect(dlg.locator('.ck-go')).toHaveCount(0);                       // no Close out, no Close out anyway
    await expect(dlg.getByRole('button', { name: 'Go back' })).toBeVisible();
    // _ckGo itself refuses too
    await page.evaluate(`_ckGo('s0')`);
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    await dlg.getByRole('checkbox', { name: 'Helmets counted and back' }).click();
    await expect(dlg.locator('.ck-go')).toHaveCount(0);
    await dlg.getByRole('checkbox', { name: 'Radios on charge' }).click();
    await expect(dlg.locator('.ck-go')).toHaveText('Close out');
    await dlg.locator('.ck-go').click();
    await expect(page.locator('#confirm-modal .confirm-box')).toBeVisible();
  });

  test('Open the night: in Bookings\' More and as a Dashboard prompt, ticks shared with the other desks on staff-ref', async ({ page }) => {
    // a night still ahead of its end (the list is for opening it)
    const rt = await boot(page, [row(A, 1, 'Amal Road', 'waiting')], { sessions: [{ ...session, bike_slots: JSON.stringify({ Road: 6, _time: '22:00 - 23:50' }) }] });
    const held: Record<string, unknown>[] = [];
    const sent = await serveChecks(page, held);
    await toRoster(page);
    await page.locator('#tab-queue .sh-more').first().click();
    await page.getByRole('menuitem', { name: /Open the night/ }).click();
    const dlg = sheet(page);
    await expect(dlg).toContainText('Opening checklist');
    await expect(dlg.locator('.ck-tick')).toHaveCount(5);
    await expect(dlg.locator('.ck-prog')).toHaveText('0 of 5 done');
    await expect(dlg.locator('.ck-li').filter({ hasText: 'Bike prep done' }).getByRole('button', { name: 'Bike prep' })).toBeVisible();
    await expect(dlg.locator('.ck-li').filter({ hasText: 'Scanner phone' }).getByRole('button', { name: 'Test the scanner' })).toBeVisible();
    await dlg.getByRole('checkbox', { name: 'Helmets out' }).click();
    await expect(dlg.locator('.ck-prog')).toHaveText('1 of 5 done');
    expect(sent[0].body).toEqual({ session_id: 's0', list: 'open', item_key: 'helmets_out' });
    await dlg.getByRole('button', { name: 'Close' }).last().click();
    // the Dashboard asks while the list is not finished
    await page.evaluate(`setStaffTab('dashboard')`);
    const card = page.locator('#tab-dashboard .dash-card').filter({ has: page.getByRole('heading', { name: 'Open the night', exact: true }) });
    await expect(card).toContainText('1 of 5 done');
    // another desk ticks: it arrives on staff-ref, no read
    await page.evaluate(`S._staffAuthed = true; setupRefRealtime()`);
    await page.waitForFunction('_refLive === true', null, { timeout: 8000 });
    const omar = { id: 9, session_id: 's0', list: 'open', item_key: 'scanner', done_by_name: 'Omar', done_at: NOW.toISOString() };
    held.push(omar); // in the database, as the other desk's insert put it there
    rt.broadcast('realtime:staff-ref', 'session_checks', { op: 'INSERT', row: omar });
    await expect(card).toContainText('2 of 5 done');
    await card.locator('.dash-row').click();
    await expect(dlg.getByRole('checkbox', { name: /Scanner phone/ })).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.locator('.ck-li').filter({ hasText: 'Scanner phone' })).toContainText('Omar');
    for (const n of ['Bike prep done', 'Cash float counted', 'Lockers checked']) await dlg.getByRole('checkbox', { name: n }).click();
    await expect(dlg.locator('.ck-prog')).toHaveText('All done');
    await dlg.getByRole('button', { name: 'Close' }).last().click();
    await expect(card).toHaveCount(0);                                       // finished: no prompt
    // a delete from another desk opens it again
    held.splice(held.indexOf(omar), 1);
    rt.broadcast('realtime:staff-ref', 'session_checks', { op: 'DELETE', row: null, old: { id: 9, session_id: 's0', list: 'open', item_key: 'scanner' } });
    await expect(page.locator('#tab-dashboard .dash-card').filter({ hasText: 'Open the night' })).toContainText('4 of 5 done');
  });

  test('before the database has the table, ticks stay on this device and the list says so', async ({ page }) => {
    await boot(page, [row(A, 1, 'Amal Road', 'waiting')]);
    await page.route(/\/rest\/v1\/session_checks/, (r: Route) => r.fulfill({ status: 404, headers: head, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table', details: null, hint: null }) }));
    await toRoster(page);
    await page.evaluate(`_ckOpen('open','s0')`);
    const dlg = sheet(page);
    await expect(dlg.locator('.ck-note')).toHaveText('Waiting for the database update.');
    await dlg.getByRole('checkbox', { name: 'Helmets out' }).click();
    await expect(dlg.getByRole('checkbox', { name: 'Helmets out' })).toHaveAttribute('aria-checked', 'true');
  });

  test('Settings > Business: admins add, rename, reorder and remove items and set the switch; one admin-only row', async ({ page }) => {
    await boot(page, [row(A, 1, 'Amal Road', 'waiting')]);
    const ups: Record<string, unknown>[] = [];
    await page.route(/\/rest\/v1\/staff_options/, async (r: Route) => {
      if (r.request().method() === 'POST') { const b = r.request().postDataJSON() as Record<string, unknown>; ups.push(b); return r.fulfill({ status: 201, headers: head, body: JSON.stringify([{ key: b.key }]) }); }
      return r.fallback();
    });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('settings');setSettingsView('business')`);
    const card = page.locator('#ck-set');
    await expect(card).toContainText('Night checklists');
    await expect(card.locator('#ck-must')).not.toBeChecked();                   // off unless set
    await expect(card.locator('#ck-in-open-0')).toHaveValue('Bike prep done');
    await expect(card.locator('#ck-in-close-3')).toHaveValue('Handover note written for the next shift');
    // rename one, add one, move it up, remove one, switch on
    await card.locator('#ck-in-open-1').fill('Helmets out and cleaned');
    await card.locator('#ck-b-close-add').click();
    await expect(card.locator('#ck-in-close-4')).toBeFocused();
    await card.locator('#ck-in-close-4').fill('Radios on charge');
    await card.locator('#ck-b-close-4--1').click();                            // up, above the handover note
    await expect(card.locator('#ck-in-close-3')).toHaveValue('Radios on charge');
    await expect(card.locator('#ck-in-open-1')).toHaveValue('Helmets out and cleaned'); // what was typed survives the redraw
    await card.locator('#ck-b-open-2-0').click();                              // remove "Cash float counted"
    await expect(card.locator('#ck-set-ol, .ck-set-ol').first().locator('li')).toHaveCount(4);
    await card.locator('#ck-must').check();
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card.locator('#ck-set-ok')).toHaveText('Saved');
    expect(ups).toHaveLength(1);
    const items = (ups[0] as { key: string; items: { must: boolean; open: { k: string; l?: string; lk?: string }[]; close: { k: string; l?: string; lk?: string }[] } });
    expect(items.key).toBe('night_checklists');
    expect(items.items.must).toBe(true);
    expect(items.items.open.map((x) => x.k)).toEqual(['prep', 'helmets_out', 'scanner', 'lockers']);
    expect(items.items.open[0]).toEqual({ k: 'prep', lk: 'ckPrep' });          // a built-in name left alone keeps its language key
    expect(items.items.open[1]).toEqual({ k: 'helmets_out', l: 'Helmets out and cleaned' });
    expect(items.items.close.map((x) => x.l || x.lk)).toEqual(['ckHelmetsBack', 'ckStored', 'ckIncident', 'Radios on charge', 'ckNote']);
    // the next close-out reads the new list
    await page.evaluate(`setStaffTab('queue');setSfSession('s0');_ckOpen('open','s0')`);
    await expect(sheet(page).locator('.ck-tick')).toHaveCount(4);
    await expect(sheet(page).getByRole('checkbox', { name: 'Helmets out and cleaned' })).toBeVisible();
    // a manager reads it, cannot change it
    await page.evaluate(`_dkClose();setStaffRole('manager');setStaffTab('settings');setSettingsView('business')`);
    await expect(page.locator('#ck-set #ck-in-open-0')).toBeDisabled();
    await expect(page.locator('#ck-set #ck-set-save')).toHaveCount(0);
  });

  test('a night without bikes leaves the bike and helmet items off, and the Arabic list reads right to left', async ({ page }) => {
    const swim = { ...session, id: 's1', title: 'Swim night', event_kind: 'community', ride_kind: 'swim', bike_slots: null };
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, { queue_entries: [{ ...row(A, 1, 'Amal Swim', 'waiting', { checked_in_at: `${DAY}T17:05:00Z` }), session_id: 's1' }], sessions: [session, swim], bikes: [], till_sessions: tillCounted });
    await stubRealtime(page);
    await unlockStaff(page);
    await serveChecks(page, []);
    await page.goto('/');
    await waitForSb(page);
    const nb = await page.evaluate(`!_needsBike(_sessGet('s1'))`);
    test.skip(!nb, 'this build reads the swim night as a bike ride');
    await page.evaluate(`setStaffTab('queue');setSfSession('s1');_ckOpen('close','s1',1)`);
    const dlg = sheet(page);
    await expect(dlg.locator('.ck-tick')).toHaveCount(2);                      // incident and note
    await expect(dlg).not.toContainText(/bike|helmet/i);
    await page.evaluate(`_dkClose();setLang('ar')`);
    await page.waitForFunction(`_partLangsReady('ar')`);
    await page.evaluate(`_ckOpen('close','s1',1)`);
    await expect(sheet(page)).toContainText('قائمة إنهاء الليلة');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(sheet(page).getByRole('button', { name: 'رجوع' })).toBeVisible();
  });
});
