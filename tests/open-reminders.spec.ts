import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page, type Request as PwRequest } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';
import { freshModule } from './helpers/fresh-module';

// "Remind me when booking opens" (the customer features round, 2026-11-19, item 2; the user: "On a date that isn't open
// yet, one tap adds the opening time to the rider's calendar with an alarm, and puts a row in Updates when it opens. This
// helps on Saturdays that fill fast."). A list row of a date the rider cannot book yet only because its booking has not
// opened for them carries Remind me; its pop-up offers Add to my calendar (one event at the opening, alarms then and ten
// minutes before; an iPhone gets it from /api/ics, written from the server's row) and Tell me in Updates
// (open_reminder_set, migration 20261119600200, whose job writes the Updates row). Supabase is stubbed; data invented.

const NOW = new Date('2099-11-10T09:00:00+03:00'); // a Tuesday
const PUB = '2099-11-10T09:00:00.000Z'; // 12:00 in Riyadh: members book first ends
const FAR = '2099-11-20', NEAR = '2099-11-12', MF = '2099-11-15', FULL = '2099-11-21';
const sess = (id: string, day: string, o: Record<string, unknown> = {}) => ({ id, session_date: id.slice(0, 10), day, status: 'open', capacity: 40, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":40}', ...o });
const sessions = [
  sess(FAR, 'Friday'), // the booking window (7 days, 20:00) opens it on Friday 13 November at 8 PM
  sess(NEAR, 'Thursday'), // open now
  sess(MF, 'Sunday', { public_at: PUB, bike_slots: '{"_time":"21:00 - 23:00","_total":40,"_mfh":3}' }), // open to members, everyone from 12 PM
  sess(FULL, 'Saturday', { status: 'full' }), // not open yet, but full: nothing to remind of
];
type Sent = { p_id?: string; p_token?: string; p_session?: string; p_on?: boolean };

async function boot(page: Page, o: { member?: boolean; signedIn?: boolean; lang?: string; fx?: Fixtures; hold?: Promise<void> } = {}) {
  const calls: Sent[] = [], mine: unknown[] = [];
  await page.clock.setFixedTime(NOW);
  if (o.lang) await page.addInitScript((l) => localStorage.setItem('cq_lang', l), o.lang);
  await stubSupabase(page, { sessions, queue_entries: [], 'rpc:my_bookings': [], 'rpc:community_member': !!o.member, ...(o.fx || {}) });
  if (o.hold) { // the members check answers only when the test lets it
    const hold = o.hold;
    await page.route('**/rest/v1/rpc/community_member*', async (r) => { await hold; await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: 'false' }); });
  }
  if (!(o.fx && 'rpc:open_reminder_set' in o.fx)) {
    await page.route('**/rest/v1/rpc/open_reminder_set*', async (r) => {
      const b = (r.request().postDataJSON() || {}) as Sent;
      calls.push(b);
      await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, on: !!b.p_on }) });
    });
  }
  page.on('request', (r) => { if (r.url().includes('/rpc/open_reminders_mine')) mine.push(r.postDataJSON()); });
  if (o.signedIn !== false) await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S._bw={days:7,at:'20:00'};goLanding()`);
  await page.evaluate(`selectEvent('jcc')`);
  if (o.member) await expect.poll(() => page.evaluate('_infoMember()')).toBe(true);
  if (!o.hold) await expect.poll(() => page.evaluate('_ormKnown()')).toBe(true); // the members check has answered
  await page.evaluate('renderRegister()');
  return { calls, mine };
}
const row = (page: Page, id: string) => page.locator('#tab-register .sess-wrap').filter({ has: page.locator(`[data-session="${id}"]`) });
const btn = (page: Page, id: string) => row(page, id).locator('.orm-btn');
const pop = (page: Page) => page.locator('#confirm-modal .orm-pop');
/** The calendar file the page saves itself, caught as it is made. */
const icsOf = (page: Page, id: string) => page.evaluate(`new Promise(res=>{const o=URL.createObjectURL;URL.createObjectURL=b=>{URL.createObjectURL=o;b.text().then(res);return o.call(URL,b);};_ormCal('${id}');})`) as Promise<string>;
const line = (ics: string, k: string) => ics.split('\r\n').filter((l) => l.startsWith(k + ':')).map((l) => l.slice(k.length + 1));

test.describe('@customer:reserve Remind me when booking opens', () => {
  test('only on a date not open yet for this rider: the window, and members first for anyone else; never on an open or full date', async ({ page }) => {
    const { mine } = await boot(page);
    await expect(btn(page, FAR)).toHaveText('Remind me');
    await expect(btn(page, FAR)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(btn(page, FAR)).toHaveAttribute('aria-label', /^Remind me · .+ · /);
    await expect(btn(page, MF)).toHaveText('Remind me');
    await expect(btn(page, NEAR)).toHaveCount(0);
    await expect(btn(page, FULL)).toHaveCount(0);
    await expect(row(page, FAR).locator('.sess-card')).toHaveAttribute('aria-disabled', 'true'); // still not bookable
    await expect.poll(() => mine.length).toBe(1); // the rider's asks, read once
    expect(mine[0]).toEqual({ p_id: 'c1', p_token: 'tok-spec' });
    if (process.env.SHOT_DIR) { await page.waitForTimeout(600); await page.locator('#tab-register').screenshot({ path: `${process.env.SHOT_DIR}/orm-row-${test.info().project.name}.png` }); }
    // once the window opens the row is an ordinary date again
    await page.clock.setFixedTime(new Date('2099-11-13T20:00:01+03:00'));
    await page.evaluate('renderRegister()');
    await expect(btn(page, FAR)).toHaveCount(0);
  });

  test('a member: the window still holds the far date, members first holds nothing', async ({ page }) => {
    await boot(page, { member: true });
    await expect(btn(page, FAR)).toHaveText('Remind me');
    await expect(btn(page, MF)).toHaveCount(0);
  });

  test('no bell until the members check has answered', async ({ page }) => {
    let release = () => {};
    const hold = new Promise<void>((r) => { release = r; });
    await boot(page, { hold });
    await expect(row(page, FAR).locator('.sess-card')).toBeVisible();
    await expect.poll(() => page.evaluate('!!(S._infoMem&&S._infoMem.busy)')).toBe(true);
    await expect(page.locator('#tab-register .orm-btn')).toHaveCount(0);
    release();
    await expect(btn(page, FAR)).toHaveText('Remind me'); // the answer repaints the list
    await expect(btn(page, MF)).toHaveText('Remind me'); // not a member: members first holds the date for them
  });

  test('only on a date the rider could book once it opens: members only, a Petromin or Victory Lap tag, never Saturday by code', async ({ page }) => {
    const x = (o: Record<string, unknown>) => JSON.stringify({ id: '2099-11-22', session_date: '2099-11-22', day: 'Sunday', status: 'open', capacity: 40, bike_slots: '{"_time":"06:00 - 06:30"}', event_kind: 'community', ride_kind: 'saturday', open_to_all: false, ...o });
    const has = (o: Record<string, unknown>) => page.evaluate(`_ormBtn(${x(o)}).includes('orm-btn')`);
    await boot(page);
    expect(await has({})).toBe(false); // members only, not a member
    expect(await has({ open_to_all: true })).toBe(true);
    expect(await has({ ride_kind: 'petromin' })).toBe(false);
    expect(await page.evaluate(`(()=>{const c=getSession();S._pmMem={id:c.id,ok:true};return _ormBtn(${x({ ride_kind: 'petromin' })}).includes('orm-btn');})()`)).toBe(true);
    // Victory Lap is booked from the day it is announced (no window); members book first can still hold it for a tag holder
    expect(await has({ ride_kind: 'vlap', public_at: '2099-11-12T09:00:00Z' })).toBe(false);
    expect(await page.evaluate(`(()=>{const c=getSession();S._vlMem={id:c.id,ok:true};return _ormBtn(${x({ ride_kind: 'vlap', public_at: '2099-11-12T09:00:00Z' })}).includes('orm-btn');})()`)).toBe(true);
    expect(await page.evaluate(`(()=>{S._satLink=true;return _ormBtn(${x({ open_to_all: true })}).includes('orm-btn');})()`)).toBe(false); // by code alone at micromobility.sa/saturday
    expect(await has({ open_to_all: true, ride_kind: 'yoga' })).toBe(true);
  });

  test('a member: members-only dates carry the bell', async ({ page }) => {
    await boot(page, { member: true });
    const x = JSON.stringify({ id: '2099-11-22', session_date: '2099-11-22', day: 'Sunday', status: 'open', capacity: 40, bike_slots: '{"_time":"06:00 - 06:30"}', event_kind: 'community', ride_kind: 'saturday', open_to_all: false });
    expect(await page.evaluate(`_ormBtn(${x}).includes('orm-btn')`)).toBe(true);
  });

  test('a failed read of the rider\'s asks is read again on the next paint', async ({ page }) => {
    const { mine } = await boot(page, { fx: { 'rpc:open_reminders_mine': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } } });
    await expect.poll(() => page.evaluate('S._orm')).toBe(null); // the failed read is not kept
    const n = mine.length;
    expect(n).toBeGreaterThan(0);
    await page.evaluate('renderRegister()');
    await expect.poll(() => mine.length).toBe(n + 1);
    await expect(btn(page, FAR)).toHaveText('Remind me');
  });

  test('the pop-up names the opening in Saudi time, and the calendar file is one event at it with two alarms', async ({ page }) => {
    await boot(page);
    await btn(page, FAR).click();
    await expect(pop(page)).toHaveAttribute('aria-labelledby', 'dlgt-orm');
    await expect(page.locator('#dlgt-orm')).toHaveText('Booking opens Fri 13 Nov, 8 PM');
    await expect(pop(page).locator('.orm-acts button')).toHaveText(['Add to my calendar', 'Tell me in Updates']);
    await expect(pop(page).locator('.x-close')).toHaveAttribute('aria-label', 'Close');
    if (process.env.SHOT_DIR) await pop(page).screenshot({ path: `${process.env.SHOT_DIR}/orm-pop-${test.info().project.name}.png` });
    const ics = await icsOf(page, FAR), origin = new URL(page.url()).origin;
    expect(line(ics, 'UID')).toEqual([`opens-${FAR}@micromobility.sa`]);
    expect(line(ics, 'DTSTART')).toEqual(['20991113T170000Z']); // 8 PM in Riyadh
    expect(line(ics, 'DTEND')).toEqual(['20991113T171500Z']);
    expect(line(ics, 'SUMMARY')).toEqual(['Booking opens: MicroMobility Ride']);
    expect(line(ics, 'TRIGGER')).toEqual(['PT0M', '-PT10M']);
    expect(line(ics, 'URL')).toEqual([`${origin}/?ev=jcc&session=${FAR}`]);
    expect(line(ics, 'DESCRIPTION')[0]).toBe(`${origin}/?ev=jcc&session=${FAR}`); // the booking link first
    expect(ics).not.toContain('LOCATION:');
    // members first: the moment everyone may book
    await page.evaluate('closeConfirm()');
    await btn(page, MF).click();
    await expect(page.locator('#dlgt-orm')).toHaveText('Booking opens Tue 10 Nov, 12 PM');
    expect(line(await icsOf(page, MF), 'DTSTART')).toEqual(['20991110T090000Z']);
  });

  test('Tell me in Updates stores the ask; the pop-up and the row then say Reminder set, and Remove takes it back', async ({ page }) => {
    const { calls } = await boot(page);
    await btn(page, FAR).click();
    await pop(page).getByRole('button', { name: 'Tell me in Updates' }).click();
    await expect(pop(page).locator('.orm-state')).toHaveText('Reminder set');
    await expect(pop(page).locator('.orm-acts button')).toHaveText(['Add to my calendar', 'Remove reminder']);
    expect(calls).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_session: FAR, p_on: true }]);
    await expect(btn(page, FAR)).toHaveText('Reminder set');
    await expect(btn(page, FAR)).toHaveClass(/orm-on/);
    if (process.env.SHOT_DIR) await pop(page).screenshot({ path: `${process.env.SHOT_DIR}/orm-set-${test.info().project.name}.png` });
    await pop(page).getByRole('button', { name: 'Remove reminder' }).click();
    await expect(pop(page).locator('.orm-acts button')).toHaveText(['Add to my calendar', 'Tell me in Updates']);
    await expect(pop(page).locator('.orm-state')).toHaveCount(0);
    expect(calls.map((c) => c.p_on)).toEqual([true, false]);
    await expect(btn(page, FAR)).toHaveText('Remind me');
  });

  test('an ask the server holds shows as set from the first paint; a date that opened meanwhile is said in words', async ({ page }) => {
    await boot(page, { fx: { 'rpc:open_reminders_mine': { ok: true, ids: [FAR] }, 'rpc:open_reminder_set': { ok: false, error: 'open' } } });
    await expect(btn(page, FAR)).toHaveText('Reminder set');
    await expect(btn(page, MF)).toHaveText('Remind me');
    await btn(page, MF).click();
    await pop(page).getByRole('button', { name: 'Tell me in Updates' }).click();
    await expect(page.locator('.toast.error')).toContainText('Booking is open now');
    await expect(pop(page)).toHaveCount(0);
  });

  test('signed out: the calendar only, and nothing is read', async ({ page }) => {
    // (the sign-in page covers Reserve for a visitor; a page that offers the row to one gets the calendar alone)
    const { mine } = await boot(page, { signedIn: false });
    await expect(btn(page, FAR)).toHaveText('Remind me');
    await page.evaluate(`_ormOpen('${FAR}')`);
    await expect(pop(page).locator('.orm-acts button')).toHaveText(['Add to my calendar']);
    expect(mine).toHaveLength(0);
  });

  test('on an iPhone the file comes from /api/ics with the opening kind: the session, whose opening, the language, and nothing else', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' }); });
    await boot(page);
    await page.context().route('**/api/ics', (r) => r.fulfill({ status: 200, contentType: 'text/calendar', body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }));
    await btn(page, FAR).click();
    const [req] = await Promise.all([
      page.context().waitForEvent('request', (r: PwRequest) => r.url().endsWith('/api/ics')),
      pop(page).getByRole('button', { name: 'Add to my calendar' }).click(),
    ]);
    expect(req.method()).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(req.postData() || ''))).toEqual({ o: FAR, w: 'a', l: 'en' });
  });

  test('Arabic: the button, the opening in Arabic with Western digits, the two offers', async ({ page }) => {
    await boot(page, { lang: 'ar' });
    await expect(btn(page, FAR)).toHaveText('ذكّرني');
    await btn(page, FAR).click();
    const title = await page.locator('#dlgt-orm').textContent() || '';
    expect(title.startsWith('يفتح الحجز ')).toBe(true);
    expect(title).toContain('13');
    expect(title).toContain('8 م');
    expect(title).not.toMatch(/[٠-٩]/);
    await expect(pop(page).locator('.orm-acts button')).toHaveText(['أضف إلى تقويمي', 'أخبرني في التحديثات']);
    expect(line(await icsOf(page, FAR), 'SUMMARY')).toEqual(['يفتح الحجز: جولة MicroMobility']);
  });

  test('the Updates row "Booking is open" opens that date on Reserve', async ({ page }) => {
    const rows = [{ id: 7, kind: 'info', title: 'Booking is open', body: 'Jeddah Corniche Circuit · 12 Nov', at: '2099-11-10T05:00:00Z', url: `/?ev=jcc&session=${NEAR}`, unread: true }];
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, { sessions, queue_entries: [], 'rpc:my_bookings': [], 'rpc:customer_updates_unread': { ok: true, n: 1, comm: 0 }, 'rpc:customer_updates': { ok: true, rows } });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/account/updates');
    await waitForSb(page);
    const item = page.locator('#inb-body .inb-list > li').first();
    await expect(item.locator('.inb-m')).toContainText('Reserve');
    await item.locator('button.inb-row').click();
    await expect.poll(() => page.evaluate('[S.custTab,S.selEvent,S.selSession]')).toEqual(['register', 'jcc', NEAR]);
  });
});

test.describe('@customer:reserve /api/ics, a date\'s opening', () => {
  type Fn = (ctx: { request: Request; env?: Record<string, string> }) => Promise<Response>;
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });
  const post = (fields: Record<string, string>, ip = '203.0.113.9') => new Request('https://site.test/api/ics', { method: 'POST', body: new URLSearchParams(fields), headers: { 'cf-connecting-ip': ip } });
  const env = { SUPABASE_ANON_KEY: 'anon' };
  const answer = (o: Record<string, unknown>) => { const asked: unknown[] = []; globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { asked.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify(o)); }) as typeof fetch; return asked; };

  test('written from the server\'s row in the asked language, never from words the page sent', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestPost as Fn;
    const asked = answer({ ok: true, id: '2099-11-21', date: '2099-11-21', title: null, title_ar: null, rk: 'saturday', ek: 'community', at: '2099-11-14T17:00:00+00:00' });
    const r = await fn({ request: post({ o: '2099-11-21', w: 'm', l: 'ar', ti: 'Free money', de: 'https://evil.test' }), env });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/calendar');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(asked).toEqual([{ p_session: '2099-11-21', p_member: true }]);
    const t = await r.text();
    expect(t).toContain('UID:opens-2099-11-21@micromobility.sa');
    expect(t).toContain('DTSTART:20991114T170000Z');
    expect(t).toContain('DTEND:20991114T171500Z');
    expect(t).toContain('SUMMARY:يفتح الحجز: جولة السبت الاجتماعية');
    expect(line(t, 'TRIGGER')).toEqual(['PT0M', '-PT10M']);
    expect(t).toContain('URL:https://site.test/?ev=community&session=2099-11-21');
    expect(t).not.toContain('Free money');
    expect(t).not.toContain('evil.test');
    // a circuit night by its ride's name, in English when the language is not one the app speaks
    answer({ ok: true, id: '2099-11-20', date: '2099-11-20', rk: null, ek: null, at: '2099-11-13T17:00:00Z' });
    const c = await (await fn({ request: post({ o: '2099-11-20', w: 'a', l: 'xx' }), env })).text();
    expect(c).toContain('SUMMARY:Booking opens: MicroMobility Ride');
    expect(c).toContain('URL:https://site.test/?ev=jcc&session=2099-11-20');
  });

  test('a refusal sends the phone back to the booking app, on that date when the database named its kind; never English text', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestPost as Fn;
    const go = async (fields: Record<string, string>, e: Record<string, string> = env, ip?: string) => { const r = await fn({ request: post(fields, ip), env: e }); return [r.status, r.headers.get('location'), await r.text()]; };
    answer({ ok: false, error: 'none' }); // unknown or tag-gated: nothing said about it
    expect(await go({ o: '2099-11-20' })).toEqual([303, 'https://site.test/', '']);
    answer({ ok: false, error: 'open', rk: 'saturday', ek: 'community' }); // opened meanwhile: to the date, now bookable
    expect(await go({ o: '2099-11-21' })).toEqual([303, 'https://site.test/?ev=community&session=2099-11-21', '']);
    answer({ ok: false, error: 'none', rk: null, ek: null }); // called off: to the date, which says so
    expect(await go({ o: '2099-11-20' })).toEqual([303, 'https://site.test/?ev=jcc&session=2099-11-20', '']);
    answer({ ok: true, id: '2099-11-20', date: '2099-11-20', rk: null, ek: null, at: '2000-01-01T00:00:00Z' }); // past, whatever the row says
    expect(await go({ o: '2099-11-20' })).toEqual([303, 'https://site.test/?ev=jcc&session=2099-11-20', '']);
    const asked = answer({ ok: true });
    for (const bad of ['../etc', 'a b', '-2099', 'x'.repeat(49), '2099-11-20?x=1']) expect(await go({ o: bad }), bad).toEqual([303, 'https://site.test/', '']);
    expect(await go({ o: '2099-11-20' }, {})).toEqual([303, 'https://site.test/', '']); // not configured
    expect(asked).toHaveLength(0);
    // the per-caller gate the calendar address uses: past it, the database is not asked
    const metered = answer({ ok: false, error: 'none' });
    for (let i = 0; i < 61; i++) await go({ o: '2099-11-20' }, env, '198.51.100.4');
    expect(metered).toHaveLength(60);
  });

  test('every session id the app and the database make is taken', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestPost as Fn;
    // the editor's marks per kind (_sessIdSuffix, staff code: read from the source), a second of a kind on one date ("-2"),
    // staff_move_session's "-n" up to 25, and the hand-made ones the migrations seeded
    const src = readFileSync(resolve(__dirname, '../app.src.html'), 'utf8').split('\n').find((l) => l.startsWith('function _sessIdSuffix('))!;
    const sfx = new Function(`${src};return _sessIdSuffix;`)() as (k: string) => string;
    const ids = ['jcc', 'saturday', 'petromin', 'workshop', 'snd96', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga', 'farm', 'testride'].flatMap((k) => { const d = '2099-11-20' + sfx(k); return [d, d + '-2', d + '-25']; });
    ids.push('2099-11-18-ws', '2026-11-06-ah', '2099-11-20-rh-2');
    expect(new Set(ids).size).toBeGreaterThan(30);
    for (const id of ids) {
      answer({ ok: true, id, date: id.slice(0, 10), rk: null, ek: null, at: '2099-11-13T17:00:00Z' });
      const r = await fn({ request: post({ o: id }, '192.0.2.' + (ids.indexOf(id) % 200)), env });
      expect(r.status, id).toBe(200);
      expect(await r.text(), id).toContain(`UID:opens-${id}@micromobility.sa`);
    }
  });

  test('its words are the app\'s own, in all ten languages', async ({ page }) => {
    const m = await freshModule('functions/api/ics.js');
    const langs = m.FEED_LANGS as string[], words = (m.OPEN_WORDS as Record<string, string[]>).title;
    expect(words).toHaveLength(11);
    await stubSupabase(page, { sessions: [], queue_entries: [] });
    await page.goto('/');
    await waitForSb(page);
    const en = await page.evaluate(`LANG.en.ormIcsT`) as string;
    for (const [i, code] of langs.entries()) {
      const want = code === 'en' ? en : (JSON.parse(readFileSync(`lang/${code}.json`, 'utf8')) as Record<string, string>).ormIcsT;
      expect(words[i], code).toBe(want);
      expect(words[i], code).toContain('{0}');
    }
  });
});

test.describe('@customer:reserve the open_reminders migration', () => {
  const sql = readFileSync(resolve(__dirname, '../supabase/migrations/20261119600200_open_reminders.sql'), 'utf8');
  test('a locked table, the rider\'s own door, the job, and the Updates words', () => {
    expect(sql).toMatch(/create table if not exists public\.open_reminders \(/);
    expect(sql).toMatch(/alter table public\.open_reminders enable row level security;\s*revoke all on public\.open_reminders from public, anon, authenticated;/);
    expect(sql).not.toMatch(/grant [^;]* on (table )?public\.open_reminders /);
    for (const f of ['open_reminder_set\\(text, text, text, boolean\\)', 'open_reminders_mine\\(text, text\\)', 'session_opening\\(text, boolean\\)']) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${f} from public;\\s*grant execute on function public\\.${f} to anon, authenticated;`));
    }
    expect(sql).toMatch(/revoke all on function public\._open_remind_tick\(\) from public, anon, authenticated;/);
    expect(sql).toMatch(/cron\.schedule\('mm-open-remind', '1-59\/5 \* \* \* \*', 'select public\._open_remind_tick\(\)'\)/);
    expect(sql).toMatch(/if exists \(select 1 from cron\.job where jobname = 'mm-open-remind'\) then perform cron\.unschedule\('mm-open-remind'\)/);
    expect(sql).toMatch(/not _cust_token_ok\(p_id, p_token\)/);
    expect(sql).toMatch(/'open-' \|\| s\.id/);
    // a row goes 30 days after it was sent; one never sent only when its date passed or its session went
    expect(sql).toMatch(/where \(o\.sent_at is not null and o\.sent_at < now\(\) - interval '30 days'\)\s*or \(o\.sent_at is null and not exists/);
    expect(sql).not.toMatch(/created_at < now\(\) - interval '30 days'/);
    expect(sql).toMatch(/'open-' \|\| s\.id \|\| '-' \|\| coalesce\(floor\(extract\(epoch from v_at\)\)::bigint, 0\)/); // the opening in the tag
    expect(sql).toMatch(/or not _open_remind_ok\(s, p_id\) then/); // the ask
    expect(sql).toMatch(/or s\.session_date < v_today or not _open_remind_ok\(s, r\.to_id\)/); // and the tick
    expect(sql).toMatch(/s\.status = 'closed' and s\.opens_at is not null and s\.opens_at <= now\(\)/); // a timer that has passed counts as open
    const words = [...sql.matchAll(/^\s*\('bookopen', '([a-z]{2})', '((?:[^']|'')*)', '((?:[^']|'')*)'\)/gm)];
    expect(words.map((w) => w[1])).toEqual(['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']); // Malay came later, in 20261120230000
    for (const w of words) for (const p of ['{0}', '{1}', '{2}']) expect(w[3], w[1]).toContain(p);
    expect(sql).toContain("values ('20261119600200', 'open_reminders')");
  });
});
