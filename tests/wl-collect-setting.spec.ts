import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// The owner, 2026-11-10: "add the bike collection time for waitlist as a field staff can change from session's
// settings" (bike_slots._wlCollect; untouched, a circuit night still says 15 minutes after the start), and "hide add
// on on sessions addition or modification of a session and clickable makes it open and show the add ons so it
// doesn't take space".

const ride = (id: string, slots: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id, session_date: id.slice(0, 10), day: 'Tuesday', status: 'open', capacity: 2, created_at: 1, event_kind: null, ride_kind: null,
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _collect: '20:15', _total: 2, ...slots }), ...extra,
});
const INV = [
  { id: 'i1', name: 'Water', qty: 5, price: 5, category: 'Drinks' },
  { id: 'i2', name: 'Gloves', qty: 3, price: 25, category: 'Gear' },
];
async function sessionsPage(page: Page, sessions: unknown[] = []) {
  await stubSupabase(page, { sessions });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
function writes(page: Page, method: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== method || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
    try { const b = r.postDataJSON(); (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => out.push(x)); } catch { /* not JSON */ }
  });
  return out;
}
const slotsOf = (row: Record<string, unknown>) => JSON.parse(String(row.bike_slots));

test.describe('@staff:sessions the waitlist collection time', () => {
  test('the edit form shows the circuit default, follows the start until typed in, and saves a typed time', async ({ page }) => {
    await sessionsPage(page, [ride('2099-03-10')]);
    const patches = writes(page, 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-03-10')`);
    await expect(page.locator('#es-wlcollect')).toHaveValue('21:15');
    await expect(page.locator('label[for="es-wlcollect"]')).toContainText('Waitlist bike collection');
    await page.locator('#es-start').fill('20:30');
    await expect(page.locator('#es-wlcollect')).toHaveValue('20:45');
    await page.locator('#es-start').fill('21:00');
    await page.locator('#es-wlcollect').fill('21:40');
    await page.locator('#es-start').fill('20:50'); // typed: no longer follows
    await expect(page.locator('#es-wlcollect')).toHaveValue('21:40');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => patches.filter((p) => 'bike_slots' in p).length).toBeGreaterThan(0);
    expect(slotsOf(patches.find((p) => 'bike_slots' in p)!)._wlCollect).toBe('21:40');
  });

  test('an untouched box saves nothing, and a time before the bike collection is refused', async ({ page }) => {
    await sessionsPage(page, [ride('2099-03-10')]);
    const patches = writes(page, 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-03-10')`);
    await page.locator('#es-wlcollect').fill('20:00'); // before the 20:15 collection
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.locator('#sess-edit-form')).toContainText('can’t collect bikes before the bike collection time');
    expect(patches.filter((p) => 'bike_slots' in p).length).toBe(0);
    await page.evaluate(`startEditSession('2099-03-10')`);
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => patches.filter((p) => 'bike_slots' in p).length).toBeGreaterThan(0);
    expect('_wlCollect' in slotsOf(patches.find((p) => 'bike_slots' in p)!)).toBe(false);
  });

  test('a box staff emptied on a circuit night is kept empty', async ({ page }) => {
    await sessionsPage(page, [ride('2099-03-10')]);
    const patches = writes(page, 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-03-10')`);
    await page.locator('#es-wlcollect').fill('');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => patches.filter((p) => 'bike_slots' in p).length).toBeGreaterThan(0);
    expect(slotsOf(patches.find((p) => 'bike_slots' in p)!)._wlCollect).toBe('');
    expect(await page.evaluate(`[_wlCollectTime({id:'x',bike_slots:'{"_time":"21:00 - 23:00","_wlCollect":""}'}),_wlCollectTime({id:'x',bike_slots:'{"_time":"21:00 - 23:00"}'})]`)).toEqual(['', '21:15']);
  });

  test('the add form saves a typed waitlist time, and nothing when untouched', async ({ page }) => {
    await sessionsPage(page);
    const rows = writes(page, 'POST');
    const open = `setStaffTab('sessions');_n6rNsOpen('2099-03-03');S.newSessMode='total';S.newSessTotal=10;renderSessions()`;
    await page.evaluate(open);
    await expect(page.locator('#ns-wlcollect')).toHaveValue('21:15');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(1);
    expect('_wlCollect' in slotsOf(rows[0])).toBe(false);
    await expect(page.locator('#sess-add-form')).toHaveCount(0); // the first create has finished and closed the form
    await page.evaluate(open.replace('2099-03-03', '2099-03-04'));
    await page.locator('#ns-wlcollect').fill('21:30');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(2);
    expect(slotsOf(rows[1])._wlCollect).toBe('21:30');
  });
});

test.describe('@customer:bookings the waitlist collection time staff set', () => {
  const qe = (sid: string) => ({ id: 'c', session_id: sid, session_day: 'Tuesday', session_date: sid.slice(0, 10), queue_num: 12, waitlist_num: 3, name: 'Rider 12', size: 'M', type_preference: 'Road', status: 'waitlist', paid: false, price: 75, customer_id: 'c1', registered_at: '2099-01-01T10:00:00Z' });
  async function myRides(page: Page, sess: Record<string, unknown>) {
    await stubSupabase(page, { sessions: [sess], bikes: [], queue_entries: [qe(String(sess.id))], 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Rider 12' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`showView('customer');setCustTab('myrides')`);
  }

  test('a circuit night says the time staff set', async ({ page }) => {
    await myRides(page, ride('2099-01-13', { _wlCollect: '21:40' }));
    await expect(page.locator('#tab-myrides .ticket-card .wl-collect').first()).toHaveText('Waitlisted riders collect bikes from 9:40 PM');
    await expect(page.locator('#tab-myrides')).not.toContainText('9:15');
  });

  test('a Petromin night says one when staff set it', async ({ page }) => {
    await myRides(page, ride('2099-01-14-pm', { _time: '19:00 - 21:00', _collect: '18:45', _wlCollect: '19:30' }, { event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false, title: 'Petromin Wednesday Ride' }));
    await expect(page.locator('#tab-myrides .ticket-card .wl-collect').first()).toHaveText('Waitlisted riders collect bikes from 7:30 PM');
  });

  test('a circuit night whose box staff emptied says none', async ({ page }) => {
    await myRides(page, ride('2099-01-13', { _wlCollect: '' }));
    await expect(page.locator('#tab-myrides .ticket-card .wl-loud').first()).toBeVisible();
    await expect(page.locator('#tab-myrides .ticket-card .wl-collect')).toHaveCount(0);
  });
});

test.describe('@staff:sessions the add-ons fold', () => {
  test('the add and edit forms fold the add-ons under one button that opens them', async ({ page }) => {
    await sessionsPage(page, [ride('2099-03-10', {}, { addons: JSON.stringify(['i1']) })]);
    await page.evaluate(`S.inventory=${JSON.stringify(INV)};setStaffTab('sessions');_n6rNsOpen('2099-03-03')`);
    const tog = page.locator('#ns-ad-tog');
    await expect(tog).toHaveAttribute('aria-expanded', 'false');
    await expect(tog).toContainText('Add-ons offered');
    await expect(page.locator('#ns-ad-tog .ss-ad-n')).toHaveText('1'); // the form copies the last ride's offer
    await expect(page.locator('#ns-ad-body')).toBeHidden();
    await expect(page.locator('#sess-add-form .ss-ad')).toHaveCount(2);
    await expect(page.locator('#sess-add-form .ss-ad').first()).toBeHidden();
    await tog.click();
    await expect(tog).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#ns-ad-body')).toBeVisible();
    await page.locator('#sess-add-form .ss-ad', { hasText: 'Gloves' }).click(); // picking one keeps it open, and counts it
    await expect(page.locator('#ns-ad-body')).toBeVisible();
    await expect(page.locator('#ns-ad-tog .ss-ad-n')).toHaveText('2');
    await page.locator('#ns-ad-tog').click();
    await expect(page.locator('#ns-ad-body')).toBeHidden();

    await page.evaluate(`startEditSession('2099-03-10')`);
    await expect(page.locator('#es-ad-tog')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#es-ad-tog .ss-ad-n')).toHaveText('1'); // the ride offers one
    await expect(page.locator('#es-ad-body')).toBeHidden();
    await page.locator('#es-ad-tog').click();
    await expect(page.locator('#es-ad-body .ss-ad-on')).toHaveCount(1);
  });
});
