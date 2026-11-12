import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Featured (the user, 2026-11-13): a date inside MicroMobility Experiences can be featured. It leads the list of dates
// under a heading of its own, and the event picker shows it as a card that opens it. A special event (yoga) is featured
// as it is made; the switch on the session forms says otherwise for any date (bike_slots._feat, 1 or 0).

const YG = '2099-11-21-yg';
const SAT = '2099-11-14-2';
const PW = '2099-11-15-pw';
const SW = '2099-11-18-sw';
const JCC = '2099-11-17';
const comm = { status: 'open', created_at: 1, event_kind: 'community', open_to_all: false };
const yoga = {
  ...comm, id: YG, session_date: '2099-11-21', day: 'Saturday', capacity: 15, ride_kind: 'yoga', needs_approval: false, hide_queue: true, spots: 15,
  paid_ride: false, location: 'SILKDEER', meet_url: 'https://maps.app.goo.gl/TfCSEPEPxA4C5f7d7', bike_slots: '{"_time":"16:00 - 17:30"}',
};
const sat = {
  ...comm, id: SAT, session_date: '2099-11-14', day: 'Saturday', capacity: 120, ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 120,
  bike_slots: '{"_time":"05:45 - 06:15"}',
};
const petro = {
  ...comm, id: PW, session_date: '2099-11-15', day: 'Sunday', capacity: 40, ride_kind: 'petromin', needs_approval: false, hide_queue: false, paid_ride: true,
  bike_slots: '{"_time":"19:00 - 21:00","_total":40}',
};
const swim = {
  ...comm, id: SW, session_date: '2099-11-18', day: 'Wednesday', capacity: 20, ride_kind: 'swim', needs_approval: true, hide_queue: true, spots: 20,
  bike_slots: '{"_time":"07:00 - 08:00"}',
};
const jcc = { id: JCC, session_date: '2099-11-17', day: 'Tuesday', status: 'open', capacity: 40, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' };
const withSlot = (s: Record<string, unknown>, x: Record<string, unknown>) => ({ ...s, bike_slots: JSON.stringify({ ...JSON.parse(String(s.bike_slots)), ...x }) });

async function custBoot(page: Page, sessions: Record<string, unknown>[], fx: Record<string, unknown> = {}, lang = '') {
  await stubSupabase(page, { sessions, queue_entries: [], 'rpc:community_member': true, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/' + (lang ? `?lang=${lang}` : ''));
  await waitForSb(page);
  await page.evaluate('goLanding()');
}

test.describe('@customer:featured Featured dates', () => {
  test('which dates are featured: a special event as made, any Experiences date staff switch, never one outside it', async ({ page }) => {
    await custBoot(page, [yoga, sat, withSlot(swim, { _feat: 1 }), withSlot(jcc, { _feat: 1 }), petro]);
    const f = await page.evaluate(`Object.fromEntries(allSessions().map(s=>[s.id,_featured(s)]))`);
    expect(f).toEqual({ [YG]: true, [SAT]: false, [SW]: true, [JCC]: false, [PW]: false });
    // the switch turned off on a special event, and on for a Saturday ride
    expect(await page.evaluate(`[_featured({event_kind:'community',ride_kind:'yoga',bike_slots:'{"_time":"16:00 - 17:30","_feat":0}'}),
      _featured({event_kind:'community',ride_kind:'saturday',bike_slots:'{"_time":"05:45 - 06:15","_feat":1}'}),
      _featured({event_kind:'community',ride_kind:'runher',bike_slots:'{"_feat":1}'}),_featured(null)]`)).toEqual([false, true, false, false]);
  });

  test('inside Experiences the featured date leads under its heading, the rest follow in date order', async ({ page }) => {
    await custBoot(page, [yoga, sat, petro, swim]);
    await page.evaluate(`selectEvent('community')`);
    const feat = page.locator('#tab-register .sess-feat');
    await expect(feat.locator('.sess-sec-h')).toHaveText('Featured');
    await expect(feat.locator('.sess-card')).toHaveCount(1);
    await expect(feat.locator('.sess-card.yg-card .yg-card-title')).toHaveText('Hatha Yoga for Cyclists');
    await expect(feat.locator('.sess-day-h')).toContainText('21 Nov 2099'); // its day is said above it, as for every date
    await expect(page.locator('#tab-register .sess-sec-rest')).toHaveText('Upcoming');
    // each date once, the featured one first on the page, then the others by date
    const order = await page.locator('#tab-register .session-cards-grid .sess-card').evaluateAll((l) => l.map((b) => b.id));
    expect(order).toEqual([`sc-${YG}`, `sc-${SAT}`, `sc-${PW}`, `sc-${SW}`]);
    // one radio group: the tab stop is the first card on the page, and an arrow moves on to the next
    await expect(page.locator(`[id="sc-${YG}"]`)).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#tab-register .sess-card[tabindex="0"]')).toHaveCount(1);
    await page.locator(`[id="sc-${YG}"]`).click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(YG);
    await expect(page.locator(`[id="sc-${YG}"]`)).toHaveAttribute('aria-checked', 'true');
  });

  test('no featured date: the list as it was, no headings; every date featured: no second heading', async ({ page }) => {
    await custBoot(page, [sat, petro, swim]);
    await page.evaluate(`selectEvent('community')`);
    await expect(page.locator('#tab-register .sess-card')).toHaveCount(3);
    await expect(page.locator('#tab-register .sess-feat')).toHaveCount(0);
    await expect(page.locator('#tab-register .sess-sec-h')).toHaveCount(0);
    await page.evaluate(`S.sessions=S.sessions.map(s=>({...s,bike_slots:JSON.stringify({...JSON.parse(s.bike_slots),_feat:1})}));renderRegister()`);
    await expect(page.locator('#tab-register .sess-feat .sess-card')).toHaveCount(3);
    await expect(page.locator('#tab-register .sess-sec-h')).toHaveCount(1);
  });

  test('the event picker shows it as a card: the day, the name, when and where', async ({ page }) => {
    await custBoot(page, [yoga, sat, petro, jcc]);
    const sec = page.locator('#land-events .feat-land');
    await expect(sec.locator('h2')).toHaveText('Featured');
    const card = sec.locator('.feat-card');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveClass(/\bfeat-yg\b/);
    await expect(card.locator('.feat-date')).toContainText('21');
    await expect(card.locator('.feat-date')).toContainText('Nov');
    await expect(card.locator('.feat-date .feat-wd')).toHaveText('Sat');
    await expect(card.locator('.feat-name')).toHaveText('Hatha Yoga for Cyclists');
    await expect(card.locator('.feat-meta').first()).toContainText('4 PM - 5:30 PM');
    await expect(card.locator('.feat-meta').first()).toContainText('90 min');
    await expect(card.locator('.feat-foot')).toContainText('SILKDEER');
    await expect(card.locator('.feat-foot')).toContainText('with Jassim Alsaady');
    await expect(card).not.toContainText(/ride|bike/i);
    // above the event tiles, which are all still there
    const [f, tiles] = await Promise.all([sec.boundingBox(), page.locator('#land-events .landing-events-grid').boundingBox()]);
    expect(f && tiles && f.y + f.height <= tiles.y).toBeTruthy();
    await expect(page.locator('#land-events .landing-events-grid .landing-event-card')).toHaveCount(2);
  });

  test('a tap opens the date inside its event, picked, through the same gates as the event card', async ({ page }) => {
    await custBoot(page, [yoga, sat, petro]);
    await page.locator('#land-events .feat-card').click();
    await expect.poll(() => page.evaluate('[S.view,S.custTab,S.selEvent,S.selSession,S.regStep]')).toEqual(['customer', 'register', 'community', YG, 1]);
    await expect(page.locator(`[id="sc-${YG}"]`)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#tab-register .mm-reg-foot .btn-primary')).toBeEnabled();
  });

  test('a members date is a member’s to see; one open to everyone shows to all', async ({ page }) => {
    await custBoot(page, [yoga, sat], { 'rpc:community_member': false });
    await expect(page.locator('#land-events .landing-events-grid')).toBeVisible();
    await expect(page.locator('#land-events .feat-land')).toHaveCount(0);
    await page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='${YG}'?{...s,open_to_all:true}:s);renderLandingAvail()`);
    await expect(page.locator('#land-events .feat-card')).toHaveCount(1);
  });

  test('only dates still ahead and live, soonest first, four at most; a full one says Waitlist', async ({ page }) => {
    const more = [1, 2, 3, 4, 5].map((n) => withSlot({ ...swim, id: `2099-12-0${n}-sw`, session_date: `2099-12-0${n}` }, { _feat: 1 }));
    await custBoot(page, [{ ...yoga, status: 'full' }, ...more, withSlot({ ...sat, status: 'closed' }, { _feat: 1 }),
      withSlot({ ...swim, id: '2020-01-01-sw', session_date: '2020-01-01' }, { _feat: 1 })]);
    const cards = page.locator('#land-events .feat-card');
    await expect(cards).toHaveCount(4);
    expect(await cards.evaluateAll((l) => l.map((b) => b.getAttribute('data-feat')))).toEqual([YG, '2099-12-01-sw', '2099-12-02-sw', '2099-12-03-sw']);
    await expect(cards.first().locator('.spots-red')).toHaveText('Waitlist');
    await expect(cards.nth(1).locator('.feat-name')).toHaveText('Triathlon Pool Session');
    await expect(cards.nth(1).locator('.feat-foot')).toContainText('Free');
    // several: one row that scrolls sideways on a phone, so the event tiles stay in view
    await expect(page.locator('#land-events .feat-grid')).toHaveClass(/\bfeat-rail\b/);
  });

  test('the card and the rail stay inside a narrow phone, in Arabic too', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await custBoot(page, [yoga, withSlot(sat, { _feat: 1 })], {}, 'ar');
    await expect(page.locator('#land-events .feat-land h2')).toHaveText('مميّزة');
    const cards = page.locator('#land-events .feat-card');
    await expect(cards).toHaveCount(2);
    // a Latin venue on an Arabic page keeps its whole name: each part of a line sits inside the card's text column
    const cut = await cards.first().evaluate((card) => { const box = card.querySelector('.feat-copy')!.getBoundingClientRect();
      return [...card.querySelectorAll('.feat-meta>span bdi')].filter((b) => { const r = b.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5; }).length; });
    expect(cut).toBe(0);
    // the page itself never scrolls sideways; the rail does
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
    const rail = page.locator('#land-events .feat-grid');
    expect(await rail.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === 'auto')).toBe(true);
    // one card alone fills the row and is not a rail
    await page.evaluate(`S.sessions=S.sessions.filter(s=>s.id==='${YG}');renderLandingAvail()`);
    await expect(rail).not.toHaveClass(/\bfeat-rail\b/);
    const [c, w] = await Promise.all([cards.first().boundingBox(), page.locator('#land-events').boundingBox()]);
    expect(c && w && c.x >= w.x - 0.5 && c.x + c.width <= w.x + w.width + 0.5).toBeTruthy();
  });

  test('the yoga title wears its own lettering on a rider’s page', async ({ page }) => {
    await custBoot(page, [yoga, sat]);
    await expect(page.locator('#land-events .feat-card .feat-name')).toHaveCSS('font-family', /^"?Marcellus/);
    await page.evaluate(`selectEvent('community')`);
    await expect(page.locator('#tab-register .yg-card-title')).toHaveCSS('font-family', /^"?Marcellus/);
  });
});

test.describe('@staff:sessions Featured', () => {
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

  test('the edit form: on for a yoga date, off for a Saturday ride, none on a circuit night; the save writes only a change', async ({ page }) => {
    // the yoga date as the session form makes it: a plain count of places beside its times
    const patches = await staffBoot(page, [withSlot(yoga, { _total: 15 }), sat, jcc]);
    await page.evaluate(`setStaffTab('sessions');startEditSession('${JCC}')`);
    await expect(page.locator('#sess-edit-form')).toBeVisible();
    await expect(page.locator('#es-feat')).toHaveCount(0);
    // yoga: on as made; saved untouched it stores nothing
    await page.evaluate(`startEditSession('${YG}')`);
    await expect(page.locator('#es-feat')).toBeChecked();
    await expect(page.locator('#sess-edit-form .feat-sess')).toContainText('Featured');
    // a switch that can be seen: the staff forms give a bare checkbox no look of its own
    expect(await page.locator('#es-feat').evaluate((el) => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return r.width >= 30 && r.height >= 18 && c.backgroundImage !== 'none'; })).toBe(true);
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(1);
    expect('_feat' in slotsOf(patches[0])).toBe(false);
    // switched off: 0, so the kind's own answer no longer speaks for it
    await page.evaluate(`startEditSession('${YG}')`);
    await page.locator('#es-feat').uncheck();
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(2);
    expect(slotsOf(patches[1])).toMatchObject({ _time: '16:00 - 17:30', _total: 15, _feat: 0 });
    // a Saturday ride: off as made, 1 once switched on
    await page.evaluate(`startEditSession('${SAT}')`);
    await expect(page.locator('#es-feat')).not.toBeChecked();
    await page.locator('#es-feat').check();
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => patches.length).toBe(3);
    expect(slotsOf(patches[2])._feat).toBe(1);
  });

  test('the new form: the switch follows the kind until staff touch it, and a clone is featured as its original', async ({ page }) => {
    await staffBoot(page, [yoga, withSlot(sat, { _feat: 1 }), jcc]);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await expect(page.locator('#ns-feat')).toHaveCount(0); // a circuit night
    await page.locator('#tab-sessions .ev-pick.ev-yoga').click();
    await expect(page.locator('#ns-feat')).toBeChecked();
    expect(await page.evaluate(`'_feat' in _nsSlots('16:00 - 17:30','').slots`)).toBe(false);
    await page.locator('#ns-feat').uncheck();
    expect(await page.evaluate(`_nsSlots('16:00 - 17:30','').slots._feat`)).toBe(0);
    // another kind picked: the switch stays as staff set it, and stores nothing where that is the kind's own answer
    await page.evaluate(`_n6sFormReset();S.newSessEvent='community';renderSessions()`);
    await expect(page.locator('#ns-feat')).not.toBeChecked();
    expect(await page.evaluate(`'_feat' in _nsSlots('05:45 - 06:15','').slots`)).toBe(false);
    await page.locator('#ns-feat').check();
    expect(await page.evaluate(`_nsSlots('05:45 - 06:15','').slots._feat`)).toBe(1);
    // a clone of a featured Saturday ride opens with the switch on
    await page.evaluate(`cloneSession('${SAT}')`);
    await expect(page.locator('#ns-feat')).toBeChecked();
  });

  test('the Sessions list marks a featured date', async ({ page }) => {
    await staffBoot(page, [yoga, sat]);
    // where a list asks for it (the Sessions agenda); the Bookings cards and the pickers stay as short as they were
    expect(await page.evaluate(`(()=>{const y=allSessions().find(x=>x.id==='${YG}'),s=allSessions().find(x=>x.id==='${SAT}');
      return [_sessExtrasHtml(y,{feat:true}).includes('ssx-feat'),_sessExtrasHtml(s,{feat:true}).includes('ssx-feat'),_sessExtrasHtml(y,{}).includes('ssx-feat')];})()`)).toEqual([true, false, false]);
    await page.evaluate(`setStaffTab('sessions')`);
    await expect(page.locator('#tab-sessions .ssx-feat').first()).toContainText('Featured');
  });
});
