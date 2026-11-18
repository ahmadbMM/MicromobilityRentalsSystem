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

// Other riders' bookings as a rider's page reads them (no names, as the queue_public view).
const pub = (sid: string, date: string, n: number, x: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({
  id: `${sid}-p${i}`, session_id: sid, session_day: 'Thursday', session_date: date, queue_num: i + 1, status: 'waiting', size: 'M',
  type_preference: 'Road', paid: false, price: 0, assigned_bike_id: null, walk_in: false, ride_duration: null, ...x,
}));

async function custBoot(page: Page, sessions: Record<string, unknown>[], lang = '', queuePublic: Record<string, unknown>[] = []) {
  await stubSupabase(page, { sessions, queue_entries: queuePublic, queue_public: queuePublic, 'rpc:community_member': true }); // whichever the page reads (secure mode reads the view)
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

// Automatic (the user, 2026-11-18: "Automatic Few spots left. The switch turns itself on once places left drop to a number
// staff set"): bike_slots._fewAt, counted as the rider's page counts its places (spotsLeft).
test.describe('@customer:farm Few spots left, automatic', () => {
  const few = (id: string) => `_sessFew(allSessions().find(x=>x.id==='${id}'))`;
  test('on at the number staff set, off above it; a waitlisted request holds no place', async ({ page }) => {
    // 130 places, 110 requests held (and five on the waitlist, which hold none): 20 left, the number set
    await custBoot(page, [withSlot(farm, { _fewAt: 20 }), sat], '', [...pub(FH, '2099-11-19', 110), ...pub(FH, '2099-11-19', 5, { status: 'waitlist', id: undefined }).map((r, i) => ({ ...r, id: `wl${i}` }))]);
    expect(await page.evaluate(`[spotsLeft('${FH}'),${few(FH)}]`)).toEqual([20, true]);
    await expect(page.locator('#land-events .feat-card.feat-fh .feat-foot .sess-card-spots')).toHaveText('Few spots left');
    await page.evaluate(`selectEvent('community')`);
    await expect(page.locator('#tab-register .sess-card.fh-card .fh-card-foot .sess-card-spots')).toHaveText('Few spots left');
    // one request taken back: 21 left, above the number, and nothing is said
    await page.evaluate(`S.queue=S.queue.filter(e=>e.id!=='${FH}-p0');renderRegister()`);
    expect(await page.evaluate(`[spotsLeft('${FH}'),${few(FH)}]`)).toEqual([21, false]);
    await expect(page.locator('#tab-register .sess-card.fh-card .sess-card-spots')).toHaveCount(0);
  });

  test('a ride that counts its places: Details says it at the number, and a count of three or fewer still says itself', async ({ page }) => {
    await custBoot(page, [withSlot(jcc, { _fewAt: 10 })], '', pub(JCC, '2099-11-17', 30));
    expect(await page.evaluate(`[spotsLeft('${JCC}'),${few(JCC)}]`)).toEqual([10, true]);
    await page.evaluate(`showSessInfo('${JCC}')`);
    await expect(page.locator('#bike-info-modal .ev-info-facts')).toContainText('Few spots left');
    await page.evaluate('closeEventInfo()');
    await page.evaluate(`S.queue=S.queue.concat(${JSON.stringify(pub(JCC, '2099-11-17', 8).map((r) => ({ ...r, id: r.id + 'x' })))}.map(entryFromDB))`);
    expect(await page.evaluate(`spotsLeft('${JCC}')`)).toBe(2);
    await page.evaluate(`showSessInfo('${JCC}')`);
    await expect(page.locator('#bike-info-modal .ev-info-facts')).toContainText('2 spots left');
    await expect(page.locator('#bike-info-modal .ev-info-facts')).not.toContainText('Few spots left');
  });

  test('the switch still says it whatever the count; a ride staff approve that names no places is the switch\'s alone; full or not a number says nothing', async ({ page }) => {
    await custBoot(page, [withSlot(farm, { _few: 1, _fewAt: 5 }), sat]);
    expect(await page.evaluate(`[spotsLeft('${FH}'),${few(FH)}]`)).toEqual([130, true]);
    const r = await page.evaluate(`(()=>{const s=allSessions().find(x=>x.id==='${SAT}');return[
      _sessFew({...s,spots:null,capacity:null,bike_slots:'{"_fewAt":999}'}),
      _sessFew({...s,bike_slots:'{"_fewAt":999}'}),
      _sessFew({...s,bike_slots:'{"_fewAt":999}',status:'full'}),
      _sessFew({...s,bike_slots:'{"_fewAt":"lots"}'}),
      _sessFew({...s,bike_slots:'{"_fewAt":0}'})];})()`);
    expect(r).toEqual([false, true, false, false, false]);
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

  test('the number it says itself at: the edit form opens on it, a save carries it, emptied it goes', async ({ page }) => {
    const patches = await staffBoot(page, [withSlot(farm, { _total: 130, _fewAt: 20 }), jcc]);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${FH}')`);
    await expect(page.locator('#es-few')).not.toBeChecked();
    await expect(page.getByLabel('Few spots left · Automatically at · places left')).toHaveValue('20');
    await expect(page.locator('#sess-edit-form .few-at')).toContainText('places left');
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(1);
    expect(slotsOf(patches[0])).toMatchObject({ _time: '16:30 - 20:30', _fewAt: 20 });
    expect('_few' in slotsOf(patches[0])).toBe(false);
    await page.evaluate(`startEditSession('${FH}')`);
    await page.locator('#es-fewat').fill('35');
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(2);
    expect(slotsOf(patches[1])._fewAt).toBe(35);
    await page.evaluate(`startEditSession('${FH}')`);
    await page.locator('#es-fewat').fill('');
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(3);
    expect('_fewAt' in slotsOf(patches[2])).toBe(false);
  });

  test('the new form stores the number; a clone, a template and a copied week carry it, the switch stays behind', async ({ page }) => {
    await staffBoot(page, [withSlot(farm, { _few: 1, _fewAt: 20 }), jcc]);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await page.locator('#tab-sessions .ev-pick.ev-farm').click();
    await expect(page.locator('#ns-fewat')).toHaveValue('');
    expect(await page.evaluate(`'_fewAt' in _nsSlots('16:30 - 20:30','').slots`)).toBe(false);
    await page.locator('#ns-fewat').fill('15');
    expect(await page.evaluate(`_nsSlots('16:30 - 20:30','').slots._fewAt`)).toBe(15);
    await page.evaluate(`_n6sFormReset();renderSessions()`);
    await expect(page.locator('#ns-fewat')).toHaveValue('');
    const r = await page.evaluate(`(()=>{const s=allSessions().find(x=>x.id==='${FH}'),c=_nsCopy(s,{newSessEvent:'farm'}),w=JSON.parse(_n6sCopyRow(s,7).bike_slots);
      return[c.newSessFewAt,c.newSessFew,NS_TPL_KEYS.includes('newSessFewAt'),NS_TPL_BLANK.newSessFewAt,w._fewAt,'_few' in w];})()`);
    expect(r).toEqual(['20', undefined, true, '', 20, false]);
  });
});
