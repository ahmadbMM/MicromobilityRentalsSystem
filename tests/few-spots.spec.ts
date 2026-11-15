import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Few spots left (the user, 2026-11-15: "in the farmhouse session show everywhere that there are few spots remaining on
// the event card too"): staff switch it on a session (bike_slots._few 1), and riders read "Few spots left" on the date's
// card, the event picker's card, Details and the farm's booking plate, on a ride staff approve too, which never counts
// its places out loud. A count of three or fewer still says itself on a ride that counts.

const FH = '2099-11-19-fh';
const JCC = '2099-11-17';
const SAT = '2099-11-21-2';
const withSlot = (s: Record<string, unknown>, x: Record<string, unknown>) => ({ ...s, bike_slots: JSON.stringify({ ...JSON.parse(String(s.bike_slots)), ...x }) });
const farm = {
  id: FH, session_date: '2099-11-19', day: 'Thursday', status: 'open', capacity: 130, created_at: 1,
  event_kind: 'community', ride_kind: 'farm', needs_approval: true, hide_queue: true, spots: 130, open_to_all: false,
  paid_ride: false, title: 'The Farmhouse Night', title_ar: 'ليلة فارم هاوس', location: 'Farmhouse, Dhahban',
  meet_name: 'Farmhouse, Dhahban', meet_url: 'https://maps.app.goo.gl/BYteRL5JCueWZUEs6', bike_slots: '{"_time":"16:30 - 20:30","_ig":"thefarmhouse.jed"}',
};
const sat = {
  id: SAT, session_date: '2099-11-21', day: 'Saturday', status: 'open', capacity: 120, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 120, open_to_all: false,
  bike_slots: '{"_time":"05:45 - 06:15"}',
};
const jcc = { id: JCC, session_date: '2099-11-17', day: 'Tuesday', status: 'open', capacity: 40, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' };
const fewFarm = withSlot(farm, { _few: 1 });

async function custBoot(page: Page, sessions: Record<string, unknown>[], lang = '') {
  await stubSupabase(page, { sessions, queue_entries: [], 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/' + (lang ? `?lang=${lang}` : ''));
  await waitForSb(page);
  await page.evaluate('goLanding()');
}

test.describe('@customer:farm Few spots left', () => {
  test('the event picker\'s card, the date\'s card, Details and the booking plate all say it', async ({ page }) => {
    await custBoot(page, [fewFarm, sat]);
    // the event picker's card
    const feat = page.locator('#land-events .feat-card.feat-fh');
    await expect(feat).toHaveCount(1);
    await expect(feat.locator('.feat-foot .sess-card-spots')).toHaveText('Few spots left');
    // the date's card inside Experiences; the Saturday ride beside it says nothing
    await page.evaluate(`selectEvent('community')`);
    const card = page.locator('#tab-register .sess-card.fh-card');
    await expect(card.locator('.fh-card-foot .sess-card-spots')).toHaveText('Few spots left');
    await expect(card).not.toContainText(/\d+ spots? left/);
    await expect(page.locator('#tab-register .sess-card:not(.fh-card) .sess-card-spots')).toHaveCount(0);
    // the chip stays inside the card at a phone's width
    await page.setViewportSize({ width: 320, height: 700 });
    const [c, chip] = await Promise.all([card.boundingBox(), card.locator('.sess-card-spots').boundingBox()]);
    expect(c && chip && chip.x >= c.x - 0.5 && chip.x + chip.width <= c.x + c.width + 0.5).toBeTruthy();
    await page.setViewportSize({ width: 1280, height: 900 });
    // Details
    await page.evaluate(`showSessInfo('${FH}')`);
    await expect(page.locator('#bike-info-modal .ev-info-facts')).toContainText('Few spots left');
    await page.evaluate('closeEventInfo()');
    // the plate on the booking steps
    await page.evaluate(`selectSessCard('${FH}')`);
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => page.evaluate('S.regStep')).toBe(2);
    await expect(page.locator('#tab-register .fh-flow-head .fh-flow-few')).toHaveText('Few spots left');
  });

  test('in Arabic too', async ({ page }) => {
    await custBoot(page, [fewFarm, sat], 'ar');
    await expect(page.locator('#land-events .feat-card .sess-card-spots')).toHaveText('أماكن قليلة متبقية');
  });

  test('without the switch nothing is said, and a full date says Waitlist instead', async ({ page }) => {
    await custBoot(page, [farm, sat]);
    await expect(page.locator('#land-events .feat-card .sess-card-spots')).toHaveCount(0);
    await page.evaluate(`selectEvent('community')`);
    await expect(page.locator('#tab-register .sess-card.fh-card .sess-card-spots')).toHaveCount(0);
    await page.evaluate(`showSessInfo('${FH}')`);
    await expect(page.locator('#bike-info-modal .ev-info-facts')).not.toContainText('Few spots left');
    // marked full, the waitlist speaks
    expect(await page.evaluate(`_sessFew({...allSessions().find(x=>x.id==='${FH}'),bike_slots:'{"_few":1}',status:'full'})`)).toBe(false);
  });

  test('on a ride that counts its places, Details says Few spots left in place of a long count', async ({ page }) => {
    await custBoot(page, [withSlot(jcc, { _few: 1 })]);
    const r = await page.evaluate(`(()=>{const s=allSessions().find(x=>x.id==='${JCC}');return [_sessFew(s),spotsLeft(s.id)];})()`);
    expect(r).toEqual([true, 40]);
    await page.evaluate(`showSessInfo('${JCC}')`);
    await expect(page.locator('#bike-info-modal .ev-info-facts')).toContainText('Few spots left');
  });
});

test.describe('@staff:sessions Few spots left', () => {
  async function staffBoot(page: Page, sessions: Record<string, unknown>[]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await page.route(/\/rest\/v1\/sessions\?/, async (r) => {
      if (r.request().method() !== 'PATCH') return r.fallback();
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'x' }]) });
    });
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'PATCH' || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
      try { const b = r.postDataJSON(); patches.push(Array.isArray(b) ? b[0] : b); } catch { /* none */ }
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S.dataLoaded&&allSessions().length===${sessions.length}`);
    return patches;
  }
  const slotsOf = (p: Record<string, unknown>) => JSON.parse(String(p.bike_slots)) as Record<string, unknown>;

  test('the edit form opens on what the date has, keeps it through a save and takes it off', async ({ page }) => {
    const patches = await staffBoot(page, [withSlot(farm, { _total: 130 }), jcc]);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${FH}')`);
    await expect(page.locator('#sess-edit-form')).toBeVisible();
    await expect(page.locator('#es-few')).not.toBeChecked();
    await page.locator('#es-few').check();
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(1);
    expect(slotsOf(patches[0])).toMatchObject({ _time: '16:30 - 20:30', _ig: 'thefarmhouse.jed', _few: 1 });
  });

  test('a date that has it keeps it when saved untouched, and loses it once switched off', async ({ page }) => {
    const patches = await staffBoot(page, [withSlot(farm, { _total: 130, _few: 1 }), jcc]);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${FH}')`);
    await expect(page.locator('#es-few')).toBeChecked();
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(1);
    expect(slotsOf(patches[0])._few).toBe(1);
    await page.evaluate(`startEditSession('${FH}')`);
    await page.locator('#es-few').uncheck();
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(2);
    expect('_few' in slotsOf(patches[1])).toBe(false);
  });

  test('the new form starts off and stores it once switched on', async ({ page }) => {
    await staffBoot(page, [farm, jcc]);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await page.locator('#tab-sessions .ev-pick.ev-farm').click();
    await expect(page.locator('#ns-few')).not.toBeChecked();
    expect(await page.evaluate(`'_few' in _nsSlots('16:30 - 20:30','').slots`)).toBe(false);
    await page.locator('#ns-few').check();
    expect(await page.evaluate(`_nsSlots('16:30 - 20:30','').slots._few`)).toBe(1);
    await page.evaluate(`_n6sFormReset();renderSessions()`);
    await expect(page.locator('#ns-few')).not.toBeChecked();
  });
});
