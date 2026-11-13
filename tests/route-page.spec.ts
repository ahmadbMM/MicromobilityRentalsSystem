import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// The app's globals, as the page has them, for the function-form calls of the policy checks at the end.
declare const S: Record<string, unknown> & { dataLoaded: boolean; _routes?: unknown[] };
declare const sb: unknown;
declare const _lastLoadOk: boolean | undefined;
declare const _refsLoaded: boolean | undefined;
declare function goCustomer(tab: string): void;
declare function setStaffTab(tab: string): void;
declare function renderSessions(): void;
type CspWin = Window & { __cspv: string[] };

// Routes switched on (new features build F11, 2026-11-13). A ride tied to a route (sessions.route_slug, the website's Routes
// list) opens the route's own page from its ticket and from the session card's Details: the line drawn from the stored
// points, the distance, the surface, the turn points and a GPX file written from the stored route. The page is route-page.js,
// fetched only when a route is opened. Staff tie a ride to a route in both session forms, and admins store a route's line
// (a GPX file read in the browser) and its turn points in site_content 'route.track.<slug>'. No elevation, no base map,
// nothing outside the app is called. All Supabase traffic is stubbed.

const DAY = '2099-02-07';
const sat = (o: Record<string, unknown> = {}) => ({
  id: DAY, session_date: DAY, day: 'Saturday', status: 'open', capacity: 40, spots: 40, created_at: 1, event_kind: 'community',
  ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true, bike_slots: '{"_time":"06:00 - 06:30"}', route_slug: 'obhur-coast', ...o,
});
const jcc = (id: string, o: Record<string, unknown> = {}) => ({ id, session_date: id, day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":12}', ...o });
const bk = (o: Record<string, unknown> = {}) => ({ id: 'b1', name: 'Spec Rider', customer_id: 'c1', session_id: DAY, session_date: DAY, session_day: 'Saturday', queue_num: 7, status: 'waiting', paid: true, price: 0, size: 'M', type_preference: 'Hybrid', approval: 'approved', registered_at: '2099-01-01T10:00:00Z', ...o });
// The Routes list as the Website editor saves it, and one route's stored line and turn points.
const ROUTES = { key: 'routes.routes.items', value: [
  { slug: { en: 'the-corniche', ar: 'the-corniche' }, name: { en: 'The Corniche', ar: 'الكورنيش' }, km: 12, surface: { en: 'Paved', ar: 'مُعبّد' }, level: { en: 'Easy', ar: 'سهل' } },
  { slug: { en: 'obhur-coast', ar: 'obhur-coast' }, name: { en: 'Obhur coast', ar: 'ساحل أبحر' }, km: 30, climb: 140, surface: { en: 'Paved', ar: 'مُعبّد' }, level: { en: 'Moderate', ar: 'متوسط' }, href: { href: 'https://maps.app.goo.gl/obhur' } },
] };
const PTS: [number, number][] = [[21.6, 39.1], [21.62, 39.1], [21.64, 39.105], [21.66, 39.11], [21.7, 39.11], [21.72, 39.1]];
const TRACK = { key: 'route.track.obhur_2d_coast', value: { v: 1, pts: PTS, turns: [{ km: 4.5, en: 'Yacht Club', ar: 'نادي اليخوت' }, { km: 13, en: 'Marine Sciences roundabout', ar: '' }] } };

type Row = { key: string; value: unknown };
type Write = { method: string; url: string; body: unknown };
// site_content answered by key, as the database does: the suite's stub gives every row of a table to every read, and
// a single-row read (the Routes list, the booking window) refuses more than one. A write whose key the table's own
// check would refuse (site_content_key_shape: letters, digits and _ between dots, 80 at most) is refused here too.
const KEY_SHAPE = /^[a-z][a-zA-Z0-9_]*([.][a-zA-Z0-9_]+)*$/;
async function siteContent(page: Page, rows: Row[], writes: Write[] = []) {
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
  await page.route('**://*.supabase.co/rest/v1/site_content*', async (route) => {
    const req = route.request(), url = new URL(req.url()), m = req.method();
    if (m === 'OPTIONS') return route.fallback();
    if (m === 'GET' || m === 'HEAD') {
      const k = url.searchParams.get('key') || '';
      const want = k.startsWith('eq.') ? [k.slice(3)] : k.startsWith('in.(') ? k.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, '')) : null;
      const out = want ? rows.filter((r) => want.includes(r.key)) : rows;
      return route.fulfill({ status: 200, headers: { ...headers, 'content-range': `0-${out.length}/${out.length}` }, body: JSON.stringify(out) });
    }
    let body: unknown = null;
    try { body = req.postDataJSON(); } catch { /* a delete has none */ }
    const keys = (Array.isArray(body) ? body : body ? [body] : []).map((r) => String((r as Row).key));
    if (keys.some((k) => k.length > 80 || !KEY_SHAPE.test(k))) return route.fulfill({ status: 400, headers, body: JSON.stringify({ code: '23514', message: 'new row for relation "site_content" violates check constraint "site_content_key_shape"' }) });
    writes.push({ method: m, url: req.url(), body });
    return route.fulfill({ status: m === 'POST' ? 201 : 200, headers, body: '[]' });
  });
}
async function rider(page: Page, rows: Row[], sessions: Record<string, unknown>[] = [sat()], entries: Record<string, unknown>[] = [bk()]) {
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, bikes: [], queue_entries: entries, 'rpc:community_member': true });
  await siteContent(page, rows);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate("goCustomer('myrides')");
}
const box = (page: Page) => page.locator('#bike-info-modal .rtp-box');
async function openFromTicket(page: Page) {
  const card = page.locator('#tab-myrides .ticket-card').first();
  await card.locator('.tk-more-btn').click();
  await card.locator('.tk-rt-open').click();
  await expect(box(page)).toBeVisible();
}
async function staff(page: Page, rows: Row[], sessions: Record<string, unknown>[], writes: Write[] = []) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await siteContent(page, rows, writes);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
const NEW_FORM = `setStaffTab('sessions');S.showAddSession=true;S._nsTplId=null;S.newSessEvent='jcc';S.newSessRoute='';S.newSessCollect='';S.newSessStartTime='21:00';S.newSessEndTime='23:00';S.newSessMode='total';S.newSessTotal=10;renderSessions()`;
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="spec" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="21.64" lon="39.105"><name>Fish market</name></wpt>
<trk><name>Obhur</name><trkseg>
${PTS.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"><ele>3</ele></trkpt>`).join('\n')}
</trkseg></trk></gpx>`;

test.describe('@customer:bookings the route page', () => {
  test('the ticket of a ride tied to a route opens its page: the line, the distance, the surface and the turn points, from the stored route', async ({ page }) => {
    const asked: string[] = [], hosts = new Set<string>();
    page.on('request', (r) => { if (r.url().includes('route-page.js')) asked.push(r.url()); });
    await rider(page, [ROUTES, TRACK]);
    const card = page.locator('#tab-myrides .ticket-card').first();
    await expect(card).toBeVisible();
    expect(asked).toEqual([]); // no rider carries the page until a route is opened
    page.on('request', (r) => hosts.add(new URL(r.url()).hostname));
    await openFromTicket(page);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\/route-page\.js\?v=[0-9a-f]{10}$/);
    await expect(box(page).locator('#rtp-title')).toHaveText('Obhur coast');
    await expect(box(page).locator('.bike-info-kicker')).toHaveText('Route');
    // the stored turn points, in order, each with how far from the start
    await expect(box(page).locator('.rtp-turns li')).toHaveCount(2);
    await expect(box(page).locator('.rtp-turns li').nth(0)).toHaveText('1Yacht Club4.5 km');
    await expect(box(page).locator('.rtp-turns li').nth(1)).toHaveText('2Marine Sciences roundabout13 km');
    const facts = await box(page).locator('.rtp-facts > div').evaluateAll((els) => els.map((e) => [e.querySelector('dt')!.textContent, e.querySelector('dd')!.textContent]));
    expect(facts).toEqual([['Distance', '30 km'], ['Surface', 'Paved'], ['Level', 'Moderate']]);
    // the line is drawn from the stored points: one vertex each, the start and each turn point marked
    const d = await box(page).locator('svg.rtp-map path').getAttribute('d');
    expect(d!.split('L')).toHaveLength(PTS.length);
    await expect(box(page).locator('svg.rtp-map circle.rtp-st')).toHaveCount(1);
    await expect(box(page).locator('svg.rtp-map circle.rtp-tn')).toHaveCount(2);
    await expect(box(page).locator('svg.rtp-map')).toHaveAttribute('aria-label', 'The route as a line, north at the top');
    await expect(box(page).getByRole('link', { name: 'Open the map' })).toHaveAttribute('href', 'https://maps.app.goo.gl/obhur');
    await expect(box(page).getByRole('button', { name: 'Save GPX file' })).toBeVisible();
    // no elevation anywhere (dropped by the owner): the list's climb is not shown, and nothing outside the app is asked
    await expect(box(page)).not.toContainText(/140|climb|elevation/i);
    expect([...hosts].filter((h) => h !== 'localhost' && h !== '127.0.0.1' && !h.endsWith('.supabase.co'))).toEqual([]);
    // nothing spills past the pop-up, and Escape closes it
    expect(await box(page).evaluate((b) => b.scrollWidth <= b.clientWidth + 1)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(box(page)).toHaveCount(0);
  });

  test('Save GPX file gives valid XML holding the route\'s points, with the turn points as waypoints on the line', async ({ page }) => {
    await rider(page, [ROUTES, TRACK]);
    await openFromTicket(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), box(page).getByRole('button', { name: 'Save GPX file' }).click()]);
    expect(dl.suggestedFilename()).toBe('obhur-coast.gpx');
    const xml = await readFile((await dl.path())!, 'utf8');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const got = await page.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const ll = (e: Element) => [Number(e.getAttribute('lat')), Number(e.getAttribute('lon'))];
      return {
        bad: doc.getElementsByTagName('parsererror').length, root: doc.documentElement.nodeName, ns: doc.documentElement.namespaceURI, ver: doc.documentElement.getAttribute('version'),
        name: doc.querySelector('trk > name')!.textContent, trk: [...doc.querySelectorAll('trk > trkseg > trkpt')].map(ll),
        wpt: [...doc.querySelectorAll('gpx > wpt')].map((e) => ({ at: ll(e), name: e.querySelector('name')!.textContent })), ele: doc.getElementsByTagName('ele').length,
      };
    }, xml);
    expect(got.bad).toBe(0);
    expect(got).toMatchObject({ root: 'gpx', ns: 'http://www.topografix.com/GPX/1/1', ver: '1.1', name: 'Obhur coast', ele: 0 });
    expect(got.trk).toEqual(PTS); // every stored point, in order
    expect(got.wpt.map((w) => w.name)).toEqual(['1. Yacht Club', '2. Marine Sciences roundabout']);
    // a waypoint sits on the line: the first is 4.5 km up the first two stretches, which run due north
    expect(got.wpt[0]!.at[1]).toBeCloseTo(39.1005, 2);
    expect(got.wpt[0]!.at[0]).toBeGreaterThan(21.62);
    expect(got.wpt[0]!.at[0]).toBeLessThan(21.66);
  });

  test('on an iPhone the file goes to the phone\'s own sheet', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1' });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d: { files?: File[] }) => !!(d && d.files && d.files.length) });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: { files: File[] }) => { w.__gpx = { name: d.files[0]!.name, type: d.files[0]!.type, text: await d.files[0]!.text() }; } });
    });
    await rider(page, [ROUTES, TRACK]);
    await openFromTicket(page);
    await box(page).getByRole('button', { name: 'Save GPX file' }).click();
    await page.waitForFunction('!!window.__gpx');
    const f = await page.evaluate('window.__gpx') as { name: string; type: string; text: string };
    expect(f.name).toBe('obhur-coast.gpx');
    expect(f.type).toBe('application/gpx+xml');
    expect(f.text.match(/<trkpt /g)).toHaveLength(PTS.length);
  });

  test('a route with no stored line shows what the list says and offers no file; a ride with no route has no button', async ({ page }) => {
    const sessions = [sat({ route_slug: 'the-corniche' }), jcc('2099-02-08')];
    await rider(page, [ROUTES, TRACK], sessions, [bk(), bk({ id: 'b2', session_id: '2099-02-08', session_date: '2099-02-08', session_day: 'Sunday', queue_num: 3 })]);
    const cards = page.locator('#tab-myrides .ticket-card');
    await expect(cards).toHaveCount(2);
    // the circuit night: its built-in drawing, no page of its own
    const circuit = cards.filter({ has: page.locator('.tk-rt-map') });
    await circuit.locator('.tk-more-btn').click();
    await expect(circuit.locator('.tk-route')).toBeVisible();
    await expect(circuit.locator('.tk-rt-open')).toHaveCount(0);
    const ride = cards.filter({ hasNot: page.locator('.tk-rt-map') });
    await ride.locator('.tk-more-btn').click();
    await ride.locator('.tk-rt-open').click();
    await expect(box(page).locator('#rtp-title')).toHaveText('The Corniche');
    await expect(box(page)).not.toHaveAttribute('aria-busy', 'true');
    await expect(box(page).locator('.rtp-facts')).toContainText('12 km');
    await expect(box(page).locator('svg.rtp-map')).toHaveCount(0);
    await expect(box(page).locator('.rtp-turns')).toHaveCount(0);
    await expect(box(page).getByRole('button', { name: 'Save GPX file' })).toHaveCount(0);
    await box(page).getByRole('button', { name: 'Close' }).click();
    await expect(box(page)).toHaveCount(0);
  });

  test('the session card\'s Details names the route and opens its page, in the rider\'s language', async ({ page }) => {
    const sessions = [jcc('2099-02-08', { route_slug: 'obhur-coast' })];
    await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, bikes: [], queue_entries: [] });
    await siteContent(page, [ROUTES, TRACK]);
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/?lang=ar');
    await waitForSb(page);
    await page.evaluate(`_routesLoad()`);
    await page.waitForFunction(`Array.isArray(S._routes)&&S._routes.length===2`);
    await page.evaluate(`showSessInfo('2099-02-08')`);
    const row = page.locator('#bike-info-modal .ev-info-facts > div').filter({ has: page.locator('.tk-rt-open') });
    await expect(row.locator('dt')).toHaveText('المسار');
    await expect(row.locator('dd')).toContainText('ساحل أبحر');
    await row.locator('.tk-rt-open').click();
    await expect(box(page).locator('#rtp-title')).toHaveText('ساحل أبحر');
    await expect(page.locator('#bike-info-modal .ev-info-facts .tk-rt-open')).toHaveCount(0); // the Details sheet gave way to it
    await expect(box(page).locator('.rtp-turns li').nth(0)).toContainText('نادي اليخوت');
    await expect(box(page).locator('.rtp-turns li').nth(1)).toContainText('Marine Sciences roundabout'); // no Arabic name stored: the English one
    await expect(box(page).locator('.rtp-facts')).toContainText('مُعبّد');
    await expect(box(page).getByRole('button', { name: 'حفظ ملف GPX' })).toBeVisible();
    await expect(box(page).locator('svg.rtp-map')).toHaveAttribute('direction', 'ltr'); // a map does not turn round for Arabic
  });

  test('every word of the file exists in all ten languages, with the same placeholders and Latin digits', async ({ page }) => {
    await rider(page, [ROUTES, TRACK]);
    await openFromTicket(page);
    expect(await page.evaluate(`RTP_LANGS`)).toEqual(['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']);
    expect(await page.evaluate(`Object.entries(RTP_T).filter(([k,v])=>v.length!==10||v.some(x=>!String(x).trim())).map(([k])=>k)`)).toEqual([]);
    expect(await page.evaluate(`Object.entries(RTP_T).filter(([k,v])=>{const h=x=>(x.match(/\\{\\d\\}/g)||[]).sort().join();return v.some(x=>h(x)!==h(v[0]));}).map(([k])=>k)`)).toEqual([]);
    expect(await page.evaluate(`Object.entries(RTP_T).filter(([k,v])=>v.some(x=>/[٠-٩۰-۹०-९০-৯]/.test(x))).map(([k])=>k)`)).toEqual([]);
  });
});

test.describe('@staff:sessions the Route step', () => {
  test('the New session form has the step on a bike ride before any route exists, and says where routes are made', async ({ page }) => {
    await staff(page, [], []);
    await page.evaluate(NEW_FORM);
    await page.waitForFunction(`Array.isArray(S._routes)`);
    const group = page.locator('#sess-add-form .form-group').filter({ has: page.locator('#ns-route') });
    // said in place once the list has been read
    await expect(group.locator('label .label-hint')).toBeVisible();
    await expect(group.locator('label .label-hint')).toHaveText('None yet. Add them in micromobility.sa, Routes.');
    await expect(page.locator('#ns-route option')).toHaveText(['No route']);
    await expect(page.locator('#ns-route-line')).toBeDisabled();
  });

  test('the Edit form shows the ride\'s route, and a new pick is written with the save, only when it changed', async ({ page }) => {
    const writes: Write[] = [];
    await staff(page, [ROUTES], [jcc('2099-03-10', { day: 'Tuesday', route_slug: 'the-corniche' })], writes);
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/sessions')) { try { patches.push(r.postDataJSON()); } catch { /* none */ } } });
    await page.evaluate(`setStaffTab('sessions');startEditSession('2099-03-10')`);
    await page.waitForFunction(`Array.isArray(S._routes)&&S._routes.length===2`);
    const sel = page.locator('#es-route');
    await expect(sel).toHaveValue('the-corniche');
    await expect(sel.locator('option')).toHaveText(['No route', 'The Corniche · 12 km', 'Obhur coast · 30 km']);
    // saved untouched: the route is not written
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect('route_slug' in patches[0]!).toBe(false);
    await expect(page.locator('#sess-edit-form')).toHaveCount(0); // the save is through and the form has closed
    // a new pick goes with the one write
    await page.evaluate(`startEditSession('2099-03-10')`);
    await page.locator('#es-route').selectOption('obhur-coast');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toMatchObject({ route_slug: 'obhur-coast' });
    expect(writes).toEqual([]); // attaching a route writes the session, never the Routes list
  });

  test('an admin stores a route\'s line from a GPX file and its turn points', async ({ page }) => {
    const writes: Write[] = [];
    await staff(page, [ROUTES], [], writes);
    await page.evaluate(NEW_FORM);
    await page.waitForFunction(`Array.isArray(S._routes)&&S._routes.length===2`);
    await expect(page.locator('#ns-route-line')).toBeDisabled(); // no route picked yet
    await page.locator('#ns-route').selectOption('obhur-coast');
    await page.locator('#ns-route-line').click();
    const ed = page.locator('#confirm-modal .rtp-ed');
    await expect(ed).toBeVisible();
    await expect(ed.locator('#rtp-ed-title')).toHaveText('Line and turn points · Obhur coast');
    await expect(ed.locator('#rtp-line-txt')).toHaveText('No line yet');
    await ed.locator('#rtp-file').setInputFiles({ name: 'obhur.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(GPX) });
    await expect(ed.locator('#rtp-line-txt')).toHaveText(/^6 points, 13\.\d+ km$/);
    // the file's own waypoint came in as a turn point, at its place on the line
    await expect(ed.locator('#rtp-en-0')).toHaveValue('Fish market');
    await expect(ed.locator('#rtp-km-0')).toHaveValue('4.5');
    await ed.getByRole('button', { name: 'Add turn point' }).click();
    await ed.locator('#rtp-km-1').fill('2,5');
    await ed.locator('#rtp-en-1').fill('  Yacht   Club ');
    await ed.locator('#rtp-ar-1').fill('نادي اليخوت');
    // a turn point past the end of the line is refused, and nothing is written
    await ed.getByRole('button', { name: 'Add turn point' }).click();
    await ed.locator('#rtp-km-2').fill('99');
    await ed.locator('#rtp-en-2').fill('Too far');
    await ed.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast-container')).toContainText('Each turn point needs a name and a distance within the route.');
    expect(writes).toEqual([]);
    await ed.getByRole('button', { name: 'Remove turn point 3' }).click();
    await ed.getByRole('button', { name: 'Save' }).click();
    await expect(ed).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe('POST');
    const sent = writes[0]!.body as { key: string; value: { v: number; pts: number[][]; turns: Record<string, unknown>[] }; updated_by: string };
    expect(sent.key).toBe('route.track.obhur_2d_coast'); // the slug's dash written as the table's keys allow
    expect(sent.updated_by).toBe('Spec Staff');
    expect(sent.value.v).toBe(1);
    expect(sent.value.pts).toEqual(PTS);
    expect(sent.value.turns).toEqual([{ km: 2.5, en: 'Yacht Club', ar: 'نادي اليخوت' }, { km: 4.5, en: 'Fish market', ar: '' }]); // in the order they are met
    expect(JSON.stringify(sent.value)).not.toMatch(/ele/); // the file's heights are not kept
    // every slug has a key of its own that the table takes, however it is spelled or however long it is
    const keys = await page.evaluate(`['obhur-coast','obhur_coast','obhur.coast','ساحل أبحر','x'.repeat(90),'y'.repeat(90)].map(_rtpKey)`) as string[];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k.length > 80 || !KEY_SHAPE.test(k) || !k.startsWith('route.track.'))).toEqual([]);
  });

  test('a file with no route in it is said and changes nothing; a long recording is thinned', async ({ page }) => {
    const writes: Write[] = [];
    await staff(page, [ROUTES, TRACK], [], writes);
    await page.evaluate(NEW_FORM);
    await page.waitForFunction(`Array.isArray(S._routes)&&S._routes.length===2`);
    await page.locator('#ns-route').selectOption('obhur-coast');
    await page.locator('#ns-route-line').click();
    const ed = page.locator('#confirm-modal .rtp-ed');
    // what is stored is what the form starts from
    await expect(ed.locator('#rtp-line-txt')).toHaveText(/^6 points, /);
    await expect(ed.locator('#rtp-en-0')).toHaveValue('Yacht Club');
    await expect(ed.locator('#rtp-ar-0')).toHaveValue('نادي اليخوت');
    await ed.locator('#rtp-file').setInputFiles({ name: 'notes.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from('<gpx><metadata/></gpx>') });
    await expect(page.locator('#toast-container')).toContainText('This file has no route in it.');
    await expect(ed.locator('#rtp-line-txt')).toHaveText(/^6 points, /);
    // 3,000 recorded points along a winding road come down to 600 at most, the same length to within a hundredth
    const long = Array.from({ length: 3000 }, (_, i) => `<trkpt lat="${(21.5 + i * 0.00004).toFixed(6)}" lon="${(39.1 + Math.sin(i / 35) * 0.002).toFixed(6)}"/>`).join('');
    await ed.locator('#rtp-file').setInputFiles({ name: 'long.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(`<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${long}</trkseg></trk></gpx>`) });
    await expect(ed.locator('#rtp-line-txt')).not.toHaveText(/^6 points, /);
    const n = Number((await ed.locator('#rtp-line-txt').textContent())!.split(' ')[0]);
    expect(n).toBeGreaterThan(20);
    expect(n).toBeLessThanOrEqual(600);
    const lens = await page.evaluate(`[_rtpLenKm(S._rtpEd.pts), _rtpLenKm(Array.from({length:3000},(_,i)=>[21.5+i*0.00004,39.1+Math.sin(i/35)*0.002]))]`) as number[];
    expect(Math.abs(lens[0]! - lens[1]!) / lens[1]!).toBeLessThan(0.01);
    await page.keyboard.press('Escape');
    await expect(ed).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  test('an account that is not an admin picks the route and has no line button; a failed read never opens a blank form', async ({ page }) => {
    await staff(page, [ROUTES], []);
    await page.evaluate(NEW_FORM);
    await page.waitForFunction(`Array.isArray(S._routes)&&S._routes.length===2`);
    await expect(page.locator('#ns-route-line')).toHaveCount(1);
    // site_content is the admins' to write: an account given Sessions without being one has the picker alone
    await page.evaluate(`S.staffRole='manager';renderSessions()`);
    await expect(page.locator('#ns-route option')).toHaveCount(3);
    await expect(page.locator('#ns-route-line')).toHaveCount(0);
    // an admin whose read of the stored route fails is told, and gets no form to save a blank over it
    await page.evaluate(`S.staffRole='admin';renderSessions()`);
    await page.locator('#ns-route').selectOption('obhur-coast');
    await page.route('**://*.supabase.co/rest/v1/site_content*', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'XX000', message: 'down' }) }) : r.fallback()));
    await page.locator('#ns-route-line').click();
    await expect(page.locator('#toast-container')).toContainText('We could not do that. Please try again.');
    await expect(page.locator('#confirm-modal .rtp-ed')).toHaveCount(0);
  });
});

// The suite bypasses the Content-Security-Policy (playwright.config.ts); the build's handler and inline-style checks do
// not read route-page.js. Here the policy is on, as on a rider's phone, and the page is driven with function-form calls.
test.describe('@customer:bookings the route page under the site\'s own policy', () => {
  test.use({ bypassCSP: false });
  const watch = (page: Page) => page.addInitScript(() => {
    (window as unknown as CspWin).__cspv = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as CspWin).__cspv.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
  });
  const ready = (page: Page) => page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && !!S.dataLoaded
    && (typeof _lastLoadOk === 'undefined' || _lastLoadOk === true) && (typeof _refsLoaded === 'undefined' || _refsLoaded === true), undefined, { timeout: 10000 });

  test('a rider opens the page, sees the line styled and saves the file, with no violation', async ({ page }) => {
    await watch(page);
    await stubSupabase(page, { sessions: [sat()], 'rpc:list_sessions': [sat()], bikes: [], queue_entries: [bk()], 'rpc:community_member': true });
    await siteContent(page, [ROUTES, TRACK]);
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await ready(page);
    await page.evaluate(() => goCustomer('myrides'));
    await openFromTicket(page);
    await expect(box(page).locator('.rtp-turns li')).toHaveCount(2);
    // the stylesheet reaches the drawing: a stroked line with no fill, the turn list without bullets
    const look = await box(page).evaluate((b) => [getComputedStyle(b.querySelector('svg.rtp-map path')!).fill, getComputedStyle(b.querySelector('svg.rtp-map path')!).strokeWidth, getComputedStyle(b.querySelector('.rtp-turns')!).listStyleType]);
    expect(look).toEqual(['none', '3px', 'none']);
    const [dl] = await Promise.all([page.waitForEvent('download'), box(page).getByRole('button', { name: 'Save GPX file' }).click()]);
    expect(dl.suggestedFilename()).toBe('obhur-coast.gpx');
    await page.keyboard.press('Escape');
    await expect(box(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as CspWin).__cspv.slice())).toEqual([]);
  });

  test('an admin opens the line editor, adds a turn point and saves, with no violation', async ({ page }) => {
    const writes: Write[] = [];
    await watch(page);
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [] });
    await siteContent(page, [ROUTES, TRACK], writes);
    await unlockStaff(page);
    await page.goto('/');
    await ready(page);
    await page.evaluate(() => { setStaffTab('sessions'); Object.assign(S, { showAddSession: true, _nsTplId: null, newSessEvent: 'jcc', newSessRoute: '' }); renderSessions(); });
    await page.waitForFunction(() => Array.isArray(S._routes) && S._routes.length === 2);
    await page.locator('#ns-route').selectOption('obhur-coast');
    await page.locator('#ns-route-line').click();
    const ed = page.locator('#confirm-modal .rtp-ed');
    await expect(ed.locator('#rtp-en-0')).toHaveValue('Yacht Club');
    await ed.getByRole('button', { name: 'Add turn point' }).click();
    await ed.locator('#rtp-km-2').fill('7');
    await ed.locator('#rtp-en-2').fill('Bridge');
    await ed.getByRole('button', { name: 'Save' }).click();
    await expect(ed).toHaveCount(0);
    expect((writes[0]!.body as { value: { turns: { en: string }[] } }).value.turns.map((x) => x.en)).toEqual(['Yacht Club', 'Bridge', 'Marine Sciences roundabout']);
    expect(await page.evaluate(() => (window as unknown as CspWin).__cspv.slice())).toEqual([]);
  });
});

