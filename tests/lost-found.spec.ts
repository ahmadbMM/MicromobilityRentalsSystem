import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, stubRealtime, unlockStaff, waitForSb } from './helpers/supabase';

// Lost and found for any item (the user, 2026-11-18, item 10 of the staff Bookings round: "Lost and found for any item.
// The Lockers section already keeps a left-behind list (kept until, WhatsApp, donated). This opens it to anything found
// at a night, linked to a booking when known."). Migration 20261118221000 (found_items): the database copies the owner
// from the booking or the account and stamps who and when; this is what the desk asks for and draws. Invented riders
// only; the clock is fixed on the session's evening.

type Row = Record<string, unknown>;
const DAY = '2099-05-05';
const NOW = new Date(`${DAY}T20:00:00+03:00`);
const sessions = [
  { id: 's0', day: 'Tuesday', session_date: DAY, capacity: 12, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '20:00 - 23:00', _total: 12 }) },
  { id: 's1', day: 'Friday', session_date: '2099-05-01', capacity: 12, status: 'closed', created_at: 2, bike_slots: JSON.stringify({ _time: '20:00 - 23:00', _total: 12 }) },
];
const row = (id: string, qn: number, name: string, status = 'waiting', cid: string | null = null, phone = ''): Row => ({
  id, session_id: 's0', session_day: 'Tuesday', session_date: DAY, queue_num: qn, name, phone, customer_id: cid, group_id: null,
  status, paid: true, price: 75, walk_in: true, registered_at: `${DAY}T15:00:00Z`, height: 175, type_preference: 'Road',
});
const A = 'aaaa1111-0000-4000-8000-0000000000a1', B = 'bbbb2222-0000-4000-8000-0000000000b2', C = 'cccc3333-0000-4000-8000-0000000000c3';
const rows = [row(A, 1, 'Amal Road', 'waiting', 'cust-amal'), row(B, 2, 'Badr Road', 'waiting', null, '0500000022'), row(C, 3, 'Carim Hybrid', 'active')];
const customers = [
  { id: 'cust-amal', name: 'Amal Road', phone: '0500000011', created_at: '2026-01-01T00:00:00Z' },
  { id: 'cust-omar', name: 'Omar Other', phone: '0500000033', created_at: '2026-01-02T00:00:00Z' },
];
const lockers = [{ id: 'L4', code: '4', status: 'available', note: '', created_at: '2099-01-01T00:00:00Z' }];
const lockerItem = { rental_id: 'R1', note: 'Gym bag', state: 'kept', keep_until: '2099-05-10', created_at: '2099-04-26T20:00:00Z',
  locker_rentals: { day: '2099-04-26', period: 'late', name: 'Rana Rider', customer_id: null, locker_id: 'L4', booking_id: null, lockers: { code: '4' } } };
const item = (id: string, x: Row): Row => ({ id, session_id: 's0', booking_id: null, customer_id: null, name: null, what: '', place: '', note: '',
  state: 'kept', keep_until: '2099-05-19', created_at: `${DAY}T17:00:00Z`, created_by: 'Desk', updated_at: `${DAY}T17:00:00Z`, updated_by: 'Desk', ...x });
const head = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };

// found_items as the server would hold it: an insert comes back with its owner copied and its id, an update guarded on
// the state it left answers no row when that state moved.
function serveFound(page: Page, held: Row[]) {
  const sent: { method: string; body: Row; url: string }[] = [];
  return page.route(/\/rest\/v1\/found_items/, async (r: Route) => {
    const req = r.request(), m = req.method(), url = new URL(req.url());
    if (m === 'GET') return r.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${held.length}/${held.length}` }, body: JSON.stringify(held) });
    if (m === 'POST') {
      const b = req.postDataJSON() as Row;
      sent.push({ method: m, body: b, url: req.url() });
      const bk = rows.find((x) => x.id === b.booking_id), cu = customers.find((c) => c.id === b.customer_id);
      const x = item(`f${held.length + 1}`, { ...b, session_id: bk ? bk.session_id : b.session_id, customer_id: bk ? bk.customer_id : b.customer_id ?? null,
        name: bk ? bk.name : cu ? cu.name : null, keep_until: b.keep_until || '2099-05-19', created_at: NOW.toISOString() });
      delete x.photo;
      held.push(x);
      return r.fulfill({ status: 201, headers: head, body: JSON.stringify([x]) });
    }
    if (m === 'PATCH') {
      const b = req.postDataJSON() as Row;
      sent.push({ method: m, body: b, url: req.url() });
      const id = (url.searchParams.get('id') || '').replace(/^eq\./, ''), st = url.searchParams.get('state'), x = held.find((y) => String(y.id) === id);
      if (!x || (st && st !== `eq.${x.state}`)) return r.fulfill({ status: 200, headers: head, body: '[]' });
      Object.assign(x, b);
      return r.fulfill({ status: 200, headers: head, body: JSON.stringify([x]) });
    }
    return r.fallback();
  }).then(() => sent);
}

async function boot(page: Page, extra: Row = {}) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { queue_entries: rows, sessions, bikes: [], customers, lockers, locker_rentals: [], locker_items: [lockerItem], ...extra });
  const rt = await stubRealtime(page);
  await unlockStaff(page);
  return rt;
}
async function toRoster(page: Page) {
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffRole='admin';setStaffTab('queue');setSfSession('s0')`);
}
const sheetOf = (page: Page) => page.locator('#desk-sheet [role="dialog"]');
const addBtn = (page: Page) => sheetOf(page).locator('.chrome-dact').getByRole('button', { name: 'Add found item' });

test.describe('@staff:bookings Lost and found', () => {
  test('from the Session tools: the night\'s items, Add with no owner and with a booking picked by its number; no toast', async ({ page }) => {
    await boot(page);
    const held: Row[] = [];
    const sent = await serveFound(page, held);
    await toRoster(page);
    await page.locator('#tab-queue .sh-more').first().click();
    await page.getByRole('menuitem', { name: 'Lost and found' }).click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('#dk-sheet-t')).toContainText('Lost and found');
    await expect(sheet.locator('#lnf-this')).toContainText('Nothing found here yet.');
    await addBtn(page).click();
    await expect(sheet.getByLabel('Keep until')).toHaveValue('2099-05-19'); // 14 days after the night, as the locker items
    await addBtn(page).click(); // never greyed out: tapped short, it says what is missing
    await expect(sheet.locator('#lnf-err')).toHaveText('Say what was found.');
    expect(sent).toHaveLength(0);
    await sheet.getByLabel('What was found').fill('Blue helmet');
    await sheet.getByLabel('Where it was found').fill('Rack 2');
    await addBtn(page).click();
    await expect(sheet.locator('#lnf-this .lnf-row')).toHaveCount(1);
    expect(sent[0].body).toEqual({ what: 'Blue helmet', place: 'Rack 2', note: '', keep_until: '2099-05-19', booking_id: null, customer_id: null, session_id: 's0' });
    await expect(sheet.locator('#lnf-this .lnf-row')).toContainText('Rack 2');
    // a booking of this night by its number
    await addBtn(page).click();
    await sheet.getByLabel('What was found').fill('Sunglasses');
    await sheet.getByLabel('Belongs to').fill('2');
    await sheet.locator('.lnf-sug-b', { hasText: 'Badr Road' }).click();
    await expect(sheet.locator('.lnf-who-p')).toContainText('Badr Road · #2');
    await addBtn(page).click();
    await expect(sheet.locator('#lnf-this .lnf-row')).toHaveCount(2);
    expect(sent[1].body).toMatchObject({ what: 'Sunglasses', booking_id: B, customer_id: null, session_id: 's0' });
    await expect(sheet.locator('#lnf-this .lnf-row', { hasText: 'Sunglasses' })).toContainText('Badr Road · #2');
    // an account through the account search
    await addBtn(page).click();
    await sheet.getByLabel('What was found').fill('Jacket');
    await sheet.getByLabel('Belongs to').fill('Omar');
    await sheet.locator('.lnf-sug-c', { hasText: 'Omar Other' }).click();
    await addBtn(page).click();
    await expect(sheet.locator('#lnf-this .lnf-row')).toHaveCount(3);
    expect(sent[2].body).toMatchObject({ what: 'Jacket', booking_id: null, customer_id: 'cust-omar' });
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0); // no bar, no toast after a save
  });

  test('Record found item in a booking\'s menu: the booking filled in; the owner\'s WhatsApp; Mark collected writes guarded', async ({ page }) => {
    await boot(page);
    const held: Row[] = [item('f9', { booking_id: B, name: 'Badr Road', what: 'Water bottle' })];
    const sent = await serveFound(page, held);
    await toRoster(page);
    const labels = (id: string) => page.evaluate(`(S._rowMenus['${id}']||[]).map(i=>i.label.replace(/<[^>]+>/g,'').trim())`) as Promise<string[]>;
    const l = await labels(A);
    expect(l.indexOf('Record found item')).toBe(l.findIndex((x) => /^Record incident/.test(x)) + 1); // right after it, in its group
    expect(await page.evaluate(`S._rowMenus['${B}'].find(i=>/Record found item/.test(i.label)).g`)).toBe('bk'); // no account: under Booking, as Record incident
    expect(await labels(C)).toContain('Record found item'); // on a bike too
    await page.evaluate(`S._rowMenus['${A}'].find(i=>/Record found item/.test(i.label)).act()`);
    const sheet = sheetOf(page);
    await expect(sheet.locator('#dk-sheet-t')).toContainText('Add found item');
    await expect(sheet.locator('.lnf-who-p')).toContainText('Amal Road · #1');
    await sheet.getByLabel('What was found').fill('Phone');
    await sheet.getByLabel('Note').fill('Black case');
    await addBtn(page).click();
    await expect(sheet).toHaveCount(0); // from the menu, the save closes it
    expect(sent[0].body).toEqual({ what: 'Phone', place: '', note: 'Black case', keep_until: '2099-05-19', booking_id: A, customer_id: null, session_id: 's0' });
    // the night's list: the owner's WhatsApp (the account's number), in English and Arabic
    await page.evaluate(`_lnfOpen('s0')`);
    const phone = sheet.locator('#lnf-this .lnf-row', { hasText: 'Phone' });
    await expect(phone).toContainText('Amal Road · #1');
    const wa = phone.locator('a.lnf-wa');
    await expect(wa).toHaveAttribute('data-wa-t', 'lnfTitle');
    await expect(wa).toHaveAttribute('data-wa-b', A);
    const href = String(await wa.getAttribute('href'));
    expect(href).toMatch(/^https:\/\/wa\.me\/966500000011\?text=/);
    const text = decodeURIComponent(href.split('?text=')[1]);
    expect(text).toMatch(/^MicroMobility: we found something of yours at Jeddah Corniche Circuit on .*5 May.*: Phone\. We keep it until .*19 May.*\. Reply here to arrange collection\.\n/);
    expect(text).toContain('MicroMobility: وجدنا غرضاً يخصّك في');
    // a walk-in with no account: the booking's own phone
    await expect(sheet.locator('#lnf-this .lnf-row', { hasText: 'Water bottle' }).locator('a.lnf-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/966500000022\?text=/);
    // Mark collected: painted, written guarded on kept
    await phone.getByRole('button', { name: 'Mark collected' }).click();
    await expect(phone.locator('.lnf-st')).toHaveText('Collected');
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].body).toEqual({ state: 'collected' });
    expect(sent[1].url).toContain('state=eq.kept');
    await expect(phone.getByRole('button', { name: 'Mark collected' })).toHaveCount(0);
    await expect(phone.locator('a.lnf-wa')).toHaveCount(0); // nothing to arrange once collected
    // another desk already settled the bottle: the write answers no row, the row goes back and is read again
    held[0].state = 'collected';
    const bottle = sheet.locator('#lnf-this .lnf-row', { hasText: 'Water bottle' });
    await bottle.getByRole('button', { name: 'Mark donated or disposed of' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'This item was just changed on another device' }).first()).toBeVisible();
    await expect(bottle.locator('.lnf-st')).toHaveText('Collected');
    expect(sent[2].body).toEqual({ state: 'disposed' });
  });

  test('Still kept: other nights\' items and the lockers\' items; a locker\'s opens its Lockers record; another desk\'s item arrives on staff-ref', async ({ page }) => {
    const rt = await boot(page);
    const held: Row[] = [
      item('f1', { session_id: 's1', customer_id: 'cust-omar', name: 'Omar Other', what: 'Red scarf', keep_until: '2099-05-15' }),
      item('f2', { session_id: 's1', what: 'Blue cap', state: 'collected' }),
    ];
    await serveFound(page, held);
    await toRoster(page);
    await page.evaluate(`_lnfOpen('s0')`);
    const sheet = sheetOf(page);
    const kept = sheet.locator('#lnf-kept');
    await expect(kept.locator('.lnf-row')).toHaveCount(2);
    await expect(kept).toContainText('Red scarf');
    await expect(kept).toContainText('Omar Other');
    await expect(kept).toContainText('Jeddah Corniche Circuit'); // the night it was found
    await expect(kept).not.toContainText('Blue cap'); // collected on another night: not this list's
    await expect(kept.locator('.lnf-lk')).toContainText('Locker 4');
    await expect(kept.locator('.lnf-lk')).toContainText('Gym bag');
    // another desk adds one to this night
    await page.evaluate(`S._staffAuthed = true; setupRefRealtime()`);
    await page.waitForFunction('_refLive === true', null, { timeout: 8000 });
    rt.broadcast('realtime:staff-ref', 'found_items', { op: 'INSERT', row: item('f7', { what: 'Car keys', place: 'Desk', has_photo: false }), old: null });
    await expect(sheet.locator('#lnf-this .lnf-row', { hasText: 'Car keys' })).toHaveCount(1);
    // the locker's item opens Lockers' own record
    await kept.locator('.lnf-lk').getByRole('button', { name: 'Open' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: /Items left/ })).toBeVisible();
  });

  test('Lockers > Items lists the found items beside the locker items; Open edits one in Lost and found', async ({ page }) => {
    await boot(page);
    const held: Row[] = [item('f1', { what: 'Blue helmet', place: 'Rack 2' })];
    const sent = await serveFound(page, held);
    await toRoster(page);
    await page.evaluate(`setStaffTab('lockers');_lkView('items')`);
    const list = page.locator('#tab-lockers .lk-res');
    await expect(list.locator('.lk-res-row')).toHaveCount(2);
    const fi = list.locator('.lk-fi-row');
    await expect(fi).toContainText('Blue helmet');
    await expect(fi).toContainText('Jeddah Corniche Circuit'); // where: the session's label
    await expect(fi).toContainText('Rack 2');
    await expect(list.locator('.lk-res-row:not(.lk-fi-row)')).toContainText('Locker 4'); // where: the locker
    await fi.getByRole('button', { name: 'Open' }).click();
    const sheet = sheetOf(page);
    await expect(sheet.getByLabel('What was found')).toHaveValue('Blue helmet');
    await sheet.getByRole('button', { name: 'Collected' }).click();
    await sheet.locator('.chrome-dact').getByRole('button', { name: 'Save' }).click();
    await expect(sheet).toHaveCount(0);
    expect(sent.filter((x) => x.method === 'PATCH').map((x) => x.body)).toEqual([
      { what: 'Blue helmet', place: 'Rack 2', note: '', keep_until: '2099-05-19', booking_id: null, customer_id: null, state: 'collected' },
    ]);
    await expect(fi.locator('.lk-res-st')).toHaveText('Collected');
  });

  test('before the database has the table, Lost and found says so and Lockers > Items lists the locker items alone', async ({ page }) => {
    await boot(page);
    await page.route(/\/rest\/v1\/found_items/, (r) => r.fulfill({ status: 404, headers: head, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table', details: null, hint: null }) }));
    await toRoster(page);
    await page.evaluate(`_lnfOpen('s0')`);
    await expect(page.locator('.toast').filter({ hasText: 'Waiting for the database update' }).first()).toBeVisible();
    await expect(sheetOf(page)).toHaveCount(0);
    await page.evaluate(`setStaffTab('lockers');_lkView('items')`);
    await expect(page.locator('#tab-lockers .lk-res .lk-res-row')).toHaveCount(1);
  });
});
