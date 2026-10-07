import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Editing a saved breakfast spot (the owner, 2026-10-05: "add the ability to edit breakfast spot selections"): a spot
// picked in a ride form has Edit beside it. Its name and map link change in the list, and - when ticked - on the rides
// from today on that have it; past rides keep the name they were ridden under. Remove from the list takes it off the
// picker only: the ride being edited keeps it, and saving that ride does not put it back on the list.

const day = (d: number) => new Date(Date.now() - d * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sat = (id: string, date: string, bf: string, created_at: number) => ({
  id, day: 'Saturday', session_date: date, capacity: 40, status: 'open', created_at, event_kind: 'community', ride_kind: 'saturday',
  title: 'Saturday Social Ride', breakfast_name: bf, breakfast_url: 'https://maps.example.com/bloom',
});
const sessions = [
  sat('s-f1', day(-7), 'Cafe Bloom', 1), sat('s-f2', day(-14), 'cafe bloom ', 2), sat('s-past', day(7), 'Cafe Bloom', 3), sat('s-dune', day(-21), 'Dune Bakery', 4),
];
const breakfast_spots = [
  { id: 'sp1', name: 'Cafe Bloom', url: 'https://maps.example.com/bloom', created_at: 1 },
  { id: 'sp2', name: 'Dune Bakery', url: null, created_at: 2 },
];

function writes(page: Page, table: string, method: string) {
  const out: { body: Record<string, unknown> | null; url: string }[] = [];
  page.on('request', (r) => {
    if (r.method() !== method || !new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) return;
    let b: unknown = null; try { b = r.postDataJSON(); } catch { /* none */ }
    out.push({ body: (Array.isArray(b) ? b[0] : b) as Record<string, unknown> | null, url: decodeURIComponent(r.url()) });
  });
  return out;
}
async function boot(page: Page) {
  await stubSupabase(page, { sessions, breakfast_spots, queue_entries: [], bikes: [] });
  // The rides a PATCH names come back as the database answers them (the stub echoes the payload, which has no id).
  await page.route(/\/rest\/v1\/sessions\?/, async (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback();
    const m = decodeURIComponent(r.request().url()).match(/id=in\.\(([^)]*)\)/);
    const ids = m ? m[1].split(',').map((x) => x.replace(/"/g, '')) : [];
    return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(ids.map((id) => ({ id }))) });
  });
  // A removed spot comes back as the row deleted, as the database answers it (the page checks it landed).
  await page.route(/\/rest\/v1\/breakfast_spots\?/, async (r) => {
    if (r.request().method() !== 'DELETE') return r.fallback();
    const m = decodeURIComponent(r.request().url()).match(/id=eq\.([^&]*)/);
    return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(m ? [{ id: m[1] }] : []) });
  });
  await unlockStaff(page);
  await page.goto('/bookings/sessions');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded&&(S.breakfastSpots||[]).length===2&&allSessions().length===4`);
}
async function editRide(page: Page, id: string) {
  await page.evaluate(`setStaffTab('sessions');startEditSession('${id}')`);
  await expect(page.locator('.ss-bf-edit')).toBeVisible();
}

test.describe('@staff:sessions breakfast spots', () => {
  test('Edit renames a spot in the list and on the rides to come that have it', async ({ page }) => {
    await boot(page);
    const spots = writes(page, 'breakfast_spots', 'PATCH'), rides = writes(page, 'sessions', 'PATCH');
    await editRide(page, 's-f1');
    await page.locator('.ss-bf-edit').click();
    await expect(page.locator('#bf-ed-name')).toHaveValue('Cafe Bloom');
    await expect(page.locator('#bf-ed-name')).toBeFocused();
    // the two rides to come that have it (one typed in another case), never the past one
    await expect(page.locator('.ss-bf-apply')).toContainText('Also change it on the 2 upcoming ride(s) that have it');
    await page.locator('#bf-ed-name').fill('Cafe Bloom Corniche');
    await page.locator('#bf-ed-url').fill('https://maps.example.com/bloom-2');
    await page.locator('.ss-bf-save').click();

    await expect.poll(() => spots.length).toBe(1);
    expect(spots[0].url).toContain('id=eq.sp1');
    expect(spots[0].body).toEqual({ name: 'Cafe Bloom Corniche', url: 'https://maps.example.com/bloom-2' });
    await expect.poll(() => rides.length).toBe(1);
    expect(rides[0].body).toEqual({ breakfast_name: 'Cafe Bloom Corniche', breakfast_url: 'https://maps.example.com/bloom-2' });
    expect(rides[0].url).toMatch(/id=in\.\(.*s-f1/);
    expect(rides[0].url).toMatch(/id=in\.\(.*s-f2/);
    expect(rides[0].url).not.toContain('s-past');

    await expect(page.locator('.ss-bf-ed')).toHaveCount(0);
    await expect(page.locator('select:has(option[value="sp1"]) option[value="sp1"]')).toHaveText('Cafe Bloom Corniche');
    expect(await page.evaluate(`[S.editSessBfSel,S.editSessBfName,S.editSessBfUrl]`)).toEqual(['sp1', 'Cafe Bloom Corniche', 'https://maps.example.com/bloom-2']);
    expect(await page.evaluate(`['s-f1','s-f2','s-past'].map(id=>_sessGet(id).breakfast_name)`)).toEqual(['Cafe Bloom Corniche', 'Cafe Bloom Corniche', 'Cafe Bloom']);
  });

  test('unticked, only the list changes; a spot needs a name of its own', async ({ page }) => {
    await boot(page);
    const spots = writes(page, 'breakfast_spots', 'PATCH'), rides = writes(page, 'sessions', 'PATCH');
    await editRide(page, 's-f1');
    await page.locator('.ss-bf-edit').click();
    await page.locator('#bf-ed-name').fill('   ');
    await page.locator('.ss-bf-save').click();
    await expect(page.locator('.ss-bf-err')).toHaveText('Give the spot a name.');
    await page.locator('#bf-ed-name').fill('dune bakery');
    await page.locator('.ss-bf-save').click();
    await expect(page.locator('.ss-bf-err')).toHaveText('Another spot on the list already has this name.');
    expect(spots).toHaveLength(0);

    await page.locator('#bf-ed-name').fill('Bloom');
    await page.locator('.ss-bf-apply input').uncheck();
    await page.locator('.ss-bf-save').click();
    await expect.poll(() => spots.length).toBe(1);
    await page.waitForTimeout(300);
    expect(rides).toHaveLength(0);
    expect(await page.evaluate(`_sessGet('s-f1').breakfast_name`)).toBe('Cafe Bloom');
    // Cancel leaves everything as it was
    await page.locator('.ss-bf-edit').click();
    await page.locator('#bf-ed-name').fill('Something else');
    await page.locator('.ss-bf-ed button', { hasText: 'Cancel' }).click();
    await expect(page.locator('.ss-bf-ed')).toHaveCount(0);
    expect(spots).toHaveLength(1);
  });

  test('Remove from the list: the ride keeps its spot, and saving the ride does not add it back', async ({ page }) => {
    await boot(page);
    const gone = writes(page, 'breakfast_spots', 'DELETE'), added = writes(page, 'breakfast_spots', 'POST');
    await editRide(page, 's-f1');
    await page.locator('.ss-bf-edit').click();
    await page.locator('.ss-bf-del').click();
    await expect(page.locator('#confirm-modal')).toContainText('Remove Cafe Bloom from the list?');
    await page.locator('#confirm-modal .btn-red').click();
    await expect.poll(() => gone.length).toBe(1);
    expect(gone[0].url).toContain('id=eq.sp1');
    // read once the answer is in (the request leaving is not the page having taken it)
    await expect.poll(() => page.evaluate(`S.breakfastSpots.map(x=>x.id)`)).toEqual(['sp2']);
    // the ride's own spot, as typed: still its name and link
    await expect.poll(() => page.evaluate(`[S.editSessBfSel,S.editSessBfName,S.editSessBfUrl]`)).toEqual(['__new', 'Cafe Bloom', 'https://maps.example.com/bloom']);
    await page.evaluate(`_bfSaveNew('editSessBfSel','editSessBfName','editSessBfUrl',_sessGet('s-f1').breakfast_name)`);
    await page.waitForTimeout(300);
    expect(added).toHaveLength(0);

    // A new ride's form that had only picked it goes back to none.
    await page.evaluate(`S.editSessionId=null;S.showAddSession=true;S.newSessEvent='community';S.newSessBfSel='sp2';S.newSessBfName='Dune Bakery';renderSessions()`);
    await page.locator('#sess-add-form .ss-bf-edit').click();
    await page.locator('#sess-add-form .ss-bf-del').click();
    await page.locator('#confirm-modal .btn-red').click();
    await expect.poll(() => gone.length).toBe(2);
    await expect.poll(() => page.evaluate(`[S.newSessBfSel,S.newSessBfName]`)).toEqual(['', '']);
    await expect(page.locator('#sess-add-form select:has(option[value="__new"])')).toHaveValue('');
  });

  test('a name typed again is not a second copy on the list', async ({ page }) => {
    await boot(page);
    const added = writes(page, 'breakfast_spots', 'POST');
    await page.evaluate(`S._bs='__new';S._bn='  dune BAKERY ';S._bu='';_bfSaveNew('_bs','_bn','_bu')`);
    await page.evaluate(`S._bs='__new';S._bn='Harbour Cafe';S._bu='';_bfSaveNew('_bs','_bn','_bu')`);
    await expect.poll(() => added.length).toBe(1);
    expect(added[0].body?.name).toBe('Harbour Cafe');
  });
});
