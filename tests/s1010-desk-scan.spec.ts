import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Front desk round 2 (2026-10-09, s1010-desk): a Petromin ticket scanned in Express checks the party in
// from the scan and the banner says who and on which bike (D8); the pop-up's Change bike takes the camera
// (D8); a bike tag tapped on a phone with a staff tab open goes to that tab, and the new tab only says so
// (D15). Invented riders and bikes only.

const PW = '2099-02-11-pw';
const sessions = [
  { id: PW, day: 'Wednesday', session_date: '2099-02-11', capacity: 35, status: 'open', created_at: 2, bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }), event_kind: 'community', ride_kind: 'petromin', paid_ride: true, title: "Petromin's Wednesdays" },
];
const bikes = [
  { id: 'b1', name: 'Road 01', bike_number: 1, type: 'Road', size: 'M', status: 'available', frame_type: 'Aluminium' },
  { id: 'b2', name: 'Road 02', bike_number: 2, type: 'Road', size: 'L', status: 'available', frame_type: 'Aluminium' },
];
const queue_entries = [{
  id: 'q1', session_id: PW, session_day: 'Wednesday', session_date: '2099-02-11', queue_num: 1, name: 'Tall Road', phone: '0551112222',
  customer_id: null, group_id: null, status: 'waiting', paid: false, price: 50, walk_in: true, type_preference: 'Road', registered_at: '2099-01-01T10:00:00Z', desk_note: 'Pays at the end',
}];
const rider_registrations = [{
  id: 1, source: 'petromin', session_id: PW, booking_no: 'P-001', party_no: 1, badge: 'B-1', name: 'Tall Road', phone: '+966500000011',
  company: 'Petromin', height: 185, type_preference: 'Road', matched_entry_id: 'q1', matched_customer_id: null, match_kind: 'booking',
  submissions: 1, price: null, checked_in_at: null, checked_in_by: null, checked_out_at: null, checked_out_by: null,
  created_at: '2099-02-10T09:00:00Z', updated_at: '2099-02-10T09:00:00Z',
}];

async function desk(page: Page) {
  await stubSupabase(page, { sessions, bikes, queue_entries, rider_registrations, 'rpc:staff_resolve_bike': { found: false } });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`(async()=>{S._staffAuthed=true;await loadData();await loadRiders();})()`);
  const checkins: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/staff_checkin')) { try { checkins.push(r.postDataJSON()); } catch { /* none */ } } });
  return checkins;
}

test.describe('@staff:petromin s1010 desk: Petromin scans', () => {
  test('D8: in Express a Petromin ticket checks the rider in from the scan; the banner says who, which bike and the desk note', async ({ page }) => {
    const checkins = await desk(page);
    await page.evaluate(`window.__said=[];_scanExpress=true;_scanRiderGo(S.riders.find(x=>x.id===1),'P-001',(m,c)=>window.__said.push([m,c]))`);
    await expect.poll(() => checkins.length).toBeGreaterThan(0);
    expect(checkins[0]).toMatchObject({ p_booking_id: 'q1', p_bike_id: 'b2' }); // 185 cm: the Road L
    await expect.poll(() => page.evaluate('window.__said.length')).toBeGreaterThan(0);
    const [msg, colour] = await page.evaluate('window.__said[window.__said.length-1]') as [string, string];
    expect(msg).toContain('P-001 · Tall Road · #002');
    expect(msg).toContain('Desk note: Pays at the end');
    expect(colour).toBe('var(--green)');
    expect(await page.evaluate('!!S._riderModalId')).toBe(false); // no pop-up: the camera stays the desk's
    // scanned again: already in, nothing sent twice
    await page.evaluate(`_scanRiderGo(S.riders.find(x=>x.id===1),'P-001',(m,c)=>window.__said.push([m,c]))`);
    await expect.poll(() => page.evaluate('window.__said[window.__said.length-1][0]')).toContain('already');
    expect(checkins.length).toBe(1);
  });

  test('D8: the pop-up\'s Change bike takes a bike from the camera', async ({ page }) => {
    await desk(page);
    await page.evaluate('openRiderModal(1)');
    const m = page.locator('#rider-modal');
    await expect(m.locator('#rider-bike-now')).toContainText('#002');
    await m.locator('[data-on-click*="_riderBikeScan"]').click();
    expect(await page.evaluate('_scanToRider')).toBe('1');
    await page.evaluate(`_onScanPayload('https://micromobility.sa/bikes/1')`);
    await expect(m.locator('#rider-bike-now')).toContainText('#001');
    expect(await page.evaluate('_scanToRider')).toBeNull();
  });
});

test.describe('@staff:bookings s1010 desk: a bike tag with a staff tab open', () => {
  test('D15: the tab the tag opens hands the bike to the open staff tab and loads nothing', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, queue_entries });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`window.__arrived=[];_bikeArrived=(c,s)=>{window.__arrived.push([c,s]);return Promise.resolve();}`);
    const tab = await page.context().newPage();
    await stubSupabase(tab, { sessions, bikes, queue_entries });
    const reads: string[] = [];
    // the page's one-row schema probes (_probeSchema, outside the boot) are not data
    tab.on('request', (r) => { if (r.url().includes('/rest/v1/') && !r.url().endsWith('limit=1')) reads.push(r.url()); });
    await tab.goto('/?bike=042');
    await expect(tab.locator('#nfc-sent')).toBeVisible();
    await expect(tab.locator('#nfc-sent h1')).toHaveText('Sent to your open tab');
    await expect(tab.locator('#nfc-sent')).toContainText('Bike 042');
    await expect.poll(() => page.evaluate('window.__arrived')).toEqual([['042', 'nfc']]);
    expect(reads).toEqual([]); // nothing loaded in the new tab
    expect(new URL(tab.url()).search).toBe(''); // the code is off the address bar
    await tab.close();
  });

  test('D15: with no staff tab open the tag opens as before', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, queue_entries });
    await unlockStaff(page);
    await page.goto('/?bike=042');
    await waitForSb(page);
    await expect(page.locator('#nfc-sent')).toHaveCount(0);
    expect(await page.evaluate('S.view')).toBe('staff');
  });
});
