import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The staff review's leftovers, marked Build now on 2026-10-28 and built 2026-11-04, sessions part:
// S02-core2-13 one Save, one write; S02-core2-12 only the rows that changed are read again;
// S02-core2-09 an event's price and audience in the editor; S02-core2-14 the new form fills from the last ride of its kind;
// S02-core2-11 the Saturday ride's messages once per ride.

const D1 = '2099-03-06', D2 = '2099-03-13', D0 = '2099-02-27';
const ride = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, day: 'Saturday', session_date: date, capacity: 30, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":30}', ...over,
});
const sat = (id: string, date: string, over: Record<string, unknown> = {}) => ride(id, date, {
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false, spots: 40,
  meet_url: 'https://maps.example/meet', bike_slots: '{"_time":"05:30 - 06:00","_wl":{"m":"count","v":7}}', ...over,
});
const event = (id: string, date: string, over: Record<string, unknown> = {}) => ride(id, date, {
  event_kind: 'community', ride_kind: 'event', needs_approval: false, hide_queue: true, paid_ride: true, price: 90, open_to_all: true, spots: 50,
  title: 'Spring Fair', bike_slots: '{"_time":"18:00 - 20:00"}', ...over,
});

async function staff(page: Page, fixtures: Record<string, unknown> = {}) {
  const fx: Record<string, unknown> = { sessions: [sat(`${D1}-s`, D1)], queue_entries: [], bikes: [], promo_codes: [], ...fixtures };
  await stubSupabase(page, fx);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('sessions')`);
  await page.waitForFunction('S.dataLoaded');
  return fx;
}
type Sent = { method: string; url: string; body: Record<string, unknown> };
function sent(page: Page) {
  const list: Sent[] = [];
  page.on('request', (r) => {
    if (!r.url().includes('/rest/v1/') || r.method() === 'OPTIONS') return;
    let body = {};
    try { body = r.postDataJSON() || {}; } catch { /* a read */ }
    list.push({ method: r.method(), url: r.url(), body });
  });
  return list;
}
const patches = (l: Sent[]) => l.filter((x) => x.method === 'PATCH' && /\/rest\/v1\/sessions\b/.test(x.url));
const reads = (l: Sent[], table: string) => l.filter((x) => x.method === 'GET' && new RegExp(`/rest/v1/${table}\\b`).test(x.url));

test.describe('@staff:sessions one Save, one write', () => {
  test('a named ride saves in one update holding every field, and the bookings are not read again', async ({ page }) => {
    await staff(page);
    const l = sent(page);
    await page.evaluate(`startEditSession('${D1}-s');S.editSessGender='female';S.editSessDesc='New words';S.editSessBfName='Cafe';S.editSessBfSel='__x';renderSessions()`);
    await page.fill('#es-spots', '44');
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => page.evaluate('S.editSessionId')).toBe(null);
    expect(patches(l)).toHaveLength(1);
    const b = patches(l)[0].body;
    expect(b).toMatchObject({ capacity: 44, spots: 44, gender_only: 'female', description: 'New words', ride_kind: 'saturday', event_kind: 'community', status: 'open' });
    expect(b).toHaveProperty('addons');
    expect(b).toHaveProperty('bike_slots');
    expect(reads(l, 'queue_entries')).toHaveLength(0);
    expect(reads(l, 'bikes')).toHaveLength(0);
    expect(reads(l, 'sessions').some((x) => /id=in\./.test(x.url))).toBe(true);
  });

  test('a refused save writes nothing more, and the form stays open', async ({ page }) => {
    await staff(page);
    const l = sent(page);
    await page.route(/\/rest\/v1\/sessions\b/, (r) => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42501', message: 'row-level security' }) })
      : r.fallback());
    await page.evaluate(`startEditSession('${D1}-s');renderSessions();_saveSessionEdit()`);
    await expect(page.locator('#err-bar-el')).toBeVisible();
    expect(patches(l)).toHaveLength(1);
    expect(await page.evaluate('S.editSessionId')).toBe(`${D1}-s`);
  });

  test('a database without a newer column loses only that field', async ({ page }) => {
    await staff(page);
    const l = sent(page);
    await page.route(/\/rest\/v1\/sessions\b/, (r) => {
      if (r.request().method() !== 'PATCH') return r.fallback();
      const b = r.request().postDataJSON() as Record<string, unknown>;
      const missing = Object.keys(b).length > 1 || 'gender_only' in b;
      return missing
        ? r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'PGRST204', message: "Could not find the 'gender_only' column" }) })
        : r.fallback();
    });
    await page.evaluate(`startEditSession('${D1}-s');S.editSessGender='male';renderSessions();_saveSessionEdit()`);
    await expect.poll(() => page.evaluate('S.editSessionId')).toBe(null);
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
    const singles = patches(l).slice(1).map((x) => Object.keys(x.body)[0]);
    expect(singles).toEqual(expect.arrayContaining(['capacity', 'status', 'ride_kind', 'gender_only']));
    expect(await page.evaluate('S.editSessionId')).toBe(null);
  });
});

test.describe('@staff:sessions only what changed is read again', () => {
  test('opening or closing a ride reads that ride, not the whole data set', async ({ page }) => {
    await staff(page);
    const l = sent(page);
    await page.evaluate(`toggleSession('${D1}-s','closed')`);
    await expect.poll(() => reads(l, 'sessions').length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    expect(reads(l, 'queue_entries')).toHaveLength(0);
    expect(reads(l, 'bikes')).toHaveLength(0);
    expect(reads(l, 'sessions').filter((x) => /id=in\./.test(x.url))).toHaveLength(1);
  });

  test('the row read back replaces the one held; others and their order stay', async ({ page }) => {
    await staff(page, { sessions: [ride('a', D0), sat('b', D1), ride('c', D2)] });
    await page.route(/\/rest\/v1\/sessions\b.*id=in\./, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ ...sat('b', D1), status: 'closed' }]) }));
    await page.evaluate(`_sessReload(['b'])`);
    await page.waitForFunction(`_sessGet('b').status==='closed'`);
    expect(await page.evaluate('S.sessions.map(s=>s.id)')).toEqual(['a', 'b', 'c']);
  });

  test('a row no longer there leaves, and a new one joins', async ({ page }) => {
    await staff(page, { sessions: [ride('a', D0), sat('b', D1)] });
    await page.route(/\/rest\/v1\/sessions\b.*id=in\./, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([ride('n', D2)]) }));
    await page.evaluate(`_sessReload(['b','n'])`);
    await page.waitForFunction(`!!_sessGet('n')&&!_sessGet('b')`);
    expect(await page.evaluate('S.sessions.map(s=>s.id)')).toEqual(['a', 'n']);
  });

  test('a read that fails falls back on the full reload', async ({ page }) => {
    await staff(page);
    const l = sent(page);
    await page.route(/\/rest\/v1\/sessions\b.*id=in\./, (r) => r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'XX000', message: 'down' }) }));
    await page.evaluate(`_sessReload(['${D1}-s'])`);
    await expect.poll(() => reads(l, 'queue_entries').length).toBeGreaterThan(0);
  });

  test('a promo code switched off reads the promo codes alone', async ({ page }) => {
    await staff(page, { promo_codes: [{ id: 'p1', code: 'SAVE', active: true, discount_type: 'percent', discount_value: 10 }] });
    await page.waitForFunction('(S.promoCodes||[]).length===1');
    const l = sent(page);
    await page.evaluate(`togglePromoActive('p1')`);
    await expect.poll(() => reads(l, 'promo_codes').length).toBeGreaterThan(0);
    expect(reads(l, 'queue_entries')).toHaveLength(0);
    expect(reads(l, 'bikes')).toHaveLength(0);
  });

  test('a date move still reloads everything: the bookings moved too', async ({ page }) => {
    await staff(page);
    const l = sent(page);
    await page.evaluate(`startEditSession('${D1}-s');S.editSessDate='${D2}';renderSessions();_saveSessionEdit()`);
    await expect.poll(() => reads(l, 'queue_entries').length).toBeGreaterThan(0);
  });
});

test.describe('@staff:sessions an event in the editor', () => {
  const row = (id: string, paid: boolean) => ({ id, session_id: `${D1}-e`, session_date: D1, session_day: 'Saturday', queue_num: 1, name: 'R', phone: '050', status: 'waiting', paid, price: 90, type_preference: 'None', registered_at: '2099-01-01T00:00:00Z' });

  test('its price and audience are offered and saved in the one write', async ({ page }) => {
    await staff(page, { sessions: [event(`${D1}-e`, D1)], queue_entries: [row('r1', false), row('r2', true)] });
    const l = sent(page);
    await page.evaluate(`startEditSession('${D1}-e');renderSessions()`);
    await expect(page.locator('#es-price')).toHaveValue('90');
    await page.fill('#es-price', '120');
    await page.getByRole('button', { name: 'Community members' }).or(page.locator('[data-on-click*="_esWho"]').nth(1)).first().click();
    await page.evaluate('_saveSessionEdit()');
    await expect(page.locator('.toast', { hasText: 'New bookings pay the new price. 1 unpaid' })).toBeVisible();
    expect(patches(l)).toHaveLength(1);
    expect(patches(l)[0].body).toMatchObject({ price: 120, paid_ride: true, open_to_all: false, ride_kind: 'event' });
  });

  test('a price of nothing makes it free: paid_ride follows, and no warning without bookings', async ({ page }) => {
    await staff(page, { sessions: [event(`${D1}-e`, D1)] });
    const l = sent(page);
    await page.evaluate(`startEditSession('${D1}-e');renderSessions()`);
    await page.fill('#es-price', '0');
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => page.evaluate('S.editSessionId')).toBe(null);
    expect(patches(l)[0].body).toMatchObject({ price: 0, paid_ride: false });
    await expect(page.locator('.toast', { hasText: 'New bookings pay' })).toHaveCount(0);
  });

  test('the Undo puts the price back', async ({ page }) => {
    await staff(page, { sessions: [event(`${D1}-e`, D1)] });
    expect(await page.evaluate(`_sessEditCols(_sessGet('${D1}-e')).price`)).toBe(90);
  });

  test('only an event asks: a Saturday ride shows no price', async ({ page }) => {
    await staff(page);
    await page.evaluate(`startEditSession('${D1}-s');renderSessions()`);
    await expect(page.locator('#es-title, #es-spots').first()).toBeVisible();
    await expect(page.locator('#es-price')).toHaveCount(0);
  });
});

test.describe('@staff:sessions the new form fills from the last of its kind', () => {
  const open = (page: Page) => page.evaluate(`S.showAddSession=true;S.editSessionId=null;renderSessions()`);
  const fields = `({a:S.newSessStartTime,b:S.newSessEndTime,sp:S.newSessSpots,map:S.newSessMapUrl,wl:S.newSessWlVal,kind:S.newSessEvent,title:S.newSessTitle,price:S.newSessPrice,from:S._nsFilledFrom})`;

  test('the kind is asked first', async ({ page }) => {
    await staff(page);
    await open(page);
    const y = await page.evaluate(`[document.getElementById('ns-kind-lbl').getBoundingClientRect().top,document.getElementById('ns-date').getBoundingClientRect().top]`) as number[];
    expect(y[0]).toBeLessThan(y[1]);
  });

  test('picking a kind brings the latest ride of it, not its name or date, and says so', async ({ page }) => {
    await staff(page, { sessions: [sat('old', D0, { spots: 11 }), sat('new', D1, { title: 'Big Ride' }), ride('jcc', D2)] });
    await open(page);
    await page.locator('.ev-pick.ev-saturday').click();
    const f = await page.evaluate(fields) as Record<string, unknown>;
    expect(f).toMatchObject({ a: '05:30', b: '06:00', sp: '40', map: 'https://maps.example/meet', wl: '7', kind: 'community', from: D1 });
    expect(f.title || '').toBe('');
    await expect(page.locator('.ss-filled')).toContainText('Filled from');
    expect(await page.evaluate('S.newSessDate')).toBe('');
  });

  test('what the staffer typed stays; what the last pick put there moves on', async ({ page }) => {
    await staff(page, { sessions: [sat('s', D1), event('e', D1)] });
    await open(page);
    await page.evaluate(`S.newSessSpots='99';_on_renderSessions_9(null,null)`);
    let f = await page.evaluate(fields) as Record<string, unknown>;
    expect(f).toMatchObject({ sp: '99', a: '05:30', map: 'https://maps.example/meet' });
    await page.evaluate('_on_renderSessions_ev(null,null)');
    f = await page.evaluate(fields) as Record<string, unknown>;
    expect(f).toMatchObject({ sp: '99', a: '18:00', b: '20:00', map: '', kind: 'event' });
    expect(f.price || '').toBe('');
  });

  test('no ride of that kind yet: a Saturday ride starts at dawn, and nothing claims to be filled', async ({ page }) => {
    await staff(page, { sessions: [ride('jcc', D1)] });
    await open(page);
    await page.locator('.ev-pick.ev-saturday').click();
    expect(await page.evaluate(fields)).toMatchObject({ a: '05:30', b: '06:00', from: null });
    await expect(page.locator('.ss-filled')).toHaveCount(0);
  });

  test('a deleted ride is not copied, and a clone is left as it came', async ({ page }) => {
    await staff(page, { sessions: [sat('dead', D2, { status: 'deleted', spots: 5 }), sat('live', D1, { spots: 33 }), sat('tpl', D0, { spots: 22 })] });
    await open(page);
    await page.locator('.ev-pick.ev-saturday').click();
    expect(await page.evaluate(fields)).toMatchObject({ sp: '33', from: D1 });
    await page.evaluate(`cloneSession('tpl')`);
    await expect.poll(() => page.evaluate('S.newSessSpots')).toBe('22');
    await page.evaluate('_on_renderSessions_9(null,null)');
    expect(await page.evaluate(fields)).toMatchObject({ sp: '22' });
  });
});

test.describe('@staff:bookings the Saturday ride messages, once per ride', () => {
  test('the button on the ride opens the three messages, with a WhatsApp link that names nobody', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${D1}-s';S._sfPicked=true;renderStaffQueue()`);
    await page.locator('.rm-open').first().click();
    const dlg = page.getByRole('dialog', { name: 'Ride messages' });
    await expect(dlg).toBeVisible();
    await dlg.locator('[data-rm="ride"]').click();
    await expect(dlg.locator('#rm-msg-text')).not.toBeEmpty();
    const href = await dlg.locator('.rm-wa').getAttribute('href');
    expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  test('the language picked is remembered on this device', async ({ page }) => {
    await staff(page);
    await page.evaluate(`_rmOpenSess('${D1}-s');_rmPick('etiq');_rmLang('ar');_rmClose();_rmOpenSess('${D1}-s')`);
    expect(await page.evaluate('S._rmMsg.lang')).toBe('ar');
  });

  test('it is the Saturday ride\'s alone, and on the ride\'s own detail too', async ({ page }) => {
    await staff(page, { sessions: [sat(`${D1}-s`, D1), ride(`${D2}-j`, D2)] });
    expect(await page.evaluate(`[!!_rmSessBtn('${D1}-s'),!!_rmSessBtn('${D2}-j')]`)).toEqual([true, false]);
    await page.evaluate(`selectSessionDetail('${D1}-s')`);
    await expect(page.locator('.sess-detail-actions .rm-open')).toBeVisible();
  });
});
