import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';
import { freshModule } from './helpers/fresh-module';

// The app's globals, as the page has them, for the function-form calls of the policy check.
declare const S: Record<string, unknown> & { dataLoaded: boolean };
declare const sb: unknown;
declare const _lastLoadOk: boolean | undefined;
declare const _refsLoaded: boolean | undefined;
declare function setCustTab(tab: string): void;
type CspWin = Window & { __cspv: string[] };

// A calendar address of the rider's own (new features build F27, 2026-11-13). Account, Settings, "Calendar" opens a
// centred pop-up: Add to my calendar (a webcal link), Copy the address, Replace the address. The address is
// /api/ics?k=<key> (functions/api/ics.js): the bookings the rider still holds, as calendar events. The row shows only
// once the database has the feature (calendar_link, migration 20261114082700). All Supabase traffic is stubbed; the
// Pages function is called directly, the way Cloudflare does, with the database stood in for.

const sessions = [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];
const profile = { id: 'c1', name: 'Sara Khalid', email: 'sara@example.com', phone: '+966500000001', height: 168, birth_date: '1994-03-02', country: 'Saudi Arabia', city: 'Jeddah', nationality: 'Saudi Arabia', gender: 'female', type_preference: 'Hybrid', photo: null };
const KEYS = ['a1', 'b2', 'c3'].map((x) => x.repeat(32));

// calendar_link as the migration writes it, for one rider: 'peek' makes nothing and sends no key, 'get' makes the key
// on the first ask, 'new' replaces it. `absent` is a database without the function, `down` one that fails.
type Call = { p_id?: string; p_token?: string; p_lang?: string; p_op?: string };
type Db = { key: string | null; made: number; calls: Call[]; absent?: boolean; down?: boolean };
const db = (o: Partial<Db> = {}): Db => ({ key: null, made: 0, calls: [], ...o });
async function open(page: Page, d: Db | null, path = '/') {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [profile], 'rpc:customer_about': [{ profession: 'Architect', workplace: 'Design Co', heard_from: 'instagram' }],
    'rpc:customer_whatsapp': [{ phone: '+966500000001', whatsapp_same: true, whatsapp: null }],
    'rpc:customer_blood_type': 'B-',
    'rpc:customer_emergency': [{ emergency_name: 'Ali Saleh', emergency_phone: '+966551112222', emergency_relation: 'friend' }],
    'rpc:customer_deletion_request': { requested_at: null },
  });
  if (d) {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
    await page.route('**://*.supabase.co/rest/v1/rpc/calendar_link', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fallback();
      const sent = req.postDataJSON() as Call;
      d.calls.push(sent);
      const json = (body: unknown, status = 200) => route.fulfill({ status, headers, body: JSON.stringify(body) });
      if (d.absent) return json({ code: 'PGRST202', message: 'Could not find the function public.calendar_link in the schema cache' }, 404);
      if (d.down && sent.p_op !== 'peek') return json({ code: 'XX000', message: 'down' }, 500);
      if (sent.p_id !== 'c1' || sent.p_token !== 'tok-spec') return json({ ok: false, error: 'denied' });
      if (sent.p_op === 'peek') return json({ ok: true, has: !!d.key });
      if (!d.key || sent.p_op === 'new') d.key = KEYS[d.made++];
      return json({ ok: true, key: d.key });
    });
  }
  await loginCustomer(page, profile);
  await page.goto(path);
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-lang-btn')).toBeVisible();
}
const row = (page: Page) => page.locator('#acc-cal-btn');
const box = (page: Page) => page.locator('#acc-pwd-modal .calf-box');
const host = (page: Page) => new URL(page.url()).host;
async function openPop(page: Page) {
  await expect(row(page)).toBeVisible();
  await row(page).click();
  await expect(box(page).locator('#calf-add')).toBeVisible();
}

test.describe('@customer:account the calendar address', () => {
  test('a database without the function never offers the row, and says nothing', async ({ page }) => {
    const d = db({ absent: true });
    await open(page, d);
    await expect.poll(() => d.calls.length).toBe(1);
    expect(d.calls[0].p_op).toBe('peek');
    await expect(row(page)).toBeHidden();
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0);
    // every other row of the group is where it was
    await expect(page.locator('#acc-lang-btn')).toBeVisible();
    await expect(page.locator('#acc-pwd-btn')).toBeVisible();
  });

  test('the suite\'s default answer keeps the row off too: no other spec sees it', async ({ page }) => {
    await open(page, null);
    await expect(page.locator('#acc-pwd-btn')).toBeVisible();
    await expect(row(page)).toBeHidden();
  });

  test('the row shows once the database answers, in Settings; asking makes no key', async ({ page }) => {
    const d = db();
    await open(page, d);
    await expect(row(page)).toBeVisible();
    await expect(row(page).locator('.acc-row-t')).toHaveText('Calendar');
    // in the Settings group, between Notifications and Language
    const grp = page.locator('.acc-grp').filter({ has: page.locator('#acc-lang-btn') });
    await expect(grp.locator('#acc-cal-btn')).toHaveCount(1);
    const order = await grp.locator('.acc-row').evaluateAll((els) => els.map((e) => e.id));
    expect(order.indexOf('acc-cal-btn')).toBe(order.indexOf('acc-lang-btn') - 1);
    expect(d.calls).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_op: 'peek' }]);
    expect(d.key).toBeNull();
    // a repaint of the page does not ask again
    await page.evaluate(`renderAccount()`);
    await expect(row(page)).toBeVisible();
    expect(d.calls).toHaveLength(1);
  });

  test('the row opens a centred pop-up: a webcal link with the rider\'s key, Copy and Replace', async ({ page }) => {
    const d = db();
    await open(page, d);
    await openPop(page);
    await expect(box(page)).toHaveAttribute('role', 'dialog');
    await expect(box(page).locator('.pg-kicker')).toHaveText('Calendar');
    await expect(box(page).locator('#calf-title')).toHaveText('Your bookings in your calendar');
    await expect(box(page).locator('#calf-add')).toHaveText('Add to my calendar');
    await expect(box(page).locator('#calf-add')).toHaveAttribute('href', `webcal://${host(page)}/api/ics?k=${KEYS[0]}`);
    await expect(box(page).getByRole('button', { name: 'Copy the address' })).toBeVisible();
    await expect(box(page).getByRole('button', { name: 'Replace the address' })).toBeVisible();
    expect(d.calls[1]).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_lang: 'en', p_op: 'get' });
    // centred on the screen at this width, never a bottom sheet
    const b = (await box(page).boundingBox())!, vp = page.viewportSize()!;
    expect(Math.abs(b.x + b.width / 2 - vp.width / 2)).toBeLessThan(8);
    expect(Math.abs(b.y + b.height / 2 - vp.height / 2)).toBeLessThan(8);
    // the key stays out of the page's own address and out of what the phone keeps
    expect(page.url()).not.toContain(KEYS[0]);
    expect(await page.evaluate(`JSON.stringify(localStorage)+JSON.stringify(sessionStorage)`)).not.toContain(KEYS[0]);
    // no hint or subtitle line: the title, the three actions, and nothing said until an action
    await expect(box(page).locator('#calf-note')).toBeHidden();
    await expect(box(page).locator('#calf-err')).toBeEmpty();
    // Escape closes it and the focus is back on the row
    await page.keyboard.press('Escape');
    await expect(box(page)).toHaveCount(0);
    await expect(row(page)).toBeFocused();
    // opened again, the same address is read back (nothing new is made)
    await openPop(page);
    await expect(box(page).locator('#calf-add')).toHaveAttribute('href', `webcal://${host(page)}/api/ics?k=${KEYS[0]}`);
    expect(d.made).toBe(1);
    await box(page).getByRole('button', { name: 'Close' }).click();
    await expect(box(page)).toHaveCount(0);
  });

  test('Copy the address puts the https address on the clipboard and says nothing; a clipboard that refuses shows it instead', async ({ page }) => {
    const d = db();
    await open(page, d);
    await page.evaluate(`window.__clip=[];window.__clipOk=true;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:t=>window.__clipOk?(window.__clip.push(t),Promise.resolve()):Promise.reject(new Error('no'))}})`);
    await openPop(page);
    const addr = `${new URL(page.url()).origin}/api/ics?k=${KEYS[0]}`;
    await box(page).getByRole('button', { name: 'Copy the address' }).click();
    await expect.poll(() => page.evaluate(`window.__clip`)).toEqual([addr]);
    await expect(box(page).locator('#calf-note')).toBeHidden();
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0);
    await page.evaluate(`window.__clipOk=false`);
    await box(page).getByRole('button', { name: 'Copy the address' }).click();
    await expect(box(page).locator('#calf-note')).toHaveText(addr);
    await expect(box(page).locator('#calf-note')).toHaveAttribute('dir', 'ltr');
    // the long address wraps inside the box
    const n = (await box(page).locator('#calf-note').boundingBox())!, b = (await box(page).boundingBox())!;
    expect(n.x).toBeGreaterThanOrEqual(b.x);
    expect(n.x + n.width).toBeLessThanOrEqual(b.x + b.width + 0.5);
    // a copy that works again clears the shown address and says nothing
    await page.evaluate(`window.__clipOk=true`);
    await box(page).getByRole('button', { name: 'Copy the address' }).click();
    await expect(box(page).locator('#calf-note')).toBeHidden();
  });

  test('Replace asks first; Cancel keeps the address; Replace writes a new key, and the link is the new one', async ({ page }) => {
    const d = db();
    await open(page, d);
    await openPop(page);
    const ask = page.locator('#confirm-modal .confirm-box');
    await box(page).getByRole('button', { name: 'Replace the address' }).click();
    await expect(ask.locator('#dlgt-confirm')).toHaveText('Replace the address?');
    await expect(ask).toContainText('The old address stops working. A calendar that uses it will no longer update.');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    await expect(box(page).locator('#calf-add')).toHaveAttribute('href', `webcal://${host(page)}/api/ics?k=${KEYS[0]}`);
    expect(d.calls.filter((c) => c.p_op === 'new')).toHaveLength(0);

    await box(page).getByRole('button', { name: 'Replace the address' }).click();
    await ask.getByRole('button', { name: 'Replace the address' }).click();
    await expect(box(page).locator('#calf-add')).toHaveAttribute('href', `webcal://${host(page)}/api/ics?k=${KEYS[1]}`);
    await expect(box(page).locator('#calf-note')).toBeHidden(); // no confirmation after an action: the new link is the change
    await expect(box(page).locator('#calf-err')).toBeEmpty();
    expect(d.calls.filter((c) => c.p_op === 'new')).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_lang: 'en', p_op: 'new' }]);
    expect(d.key).toBe(KEYS[1]);
    await expect(box(page)).toBeVisible(); // the pop-up stayed open under the question

    // a replace that fails says so and keeps the address the rider has
    d.down = true;
    await box(page).getByRole('button', { name: 'Replace the address' }).click();
    await ask.getByRole('button', { name: 'Replace the address' }).click();
    await expect(box(page).locator('#calf-err')).toHaveText('We could not do that. Please try again.');
    await expect(box(page).locator('#calf-add')).toHaveAttribute('href', `webcal://${host(page)}/api/ics?k=${KEYS[1]}`);
    await expect(box(page).getByRole('button', { name: 'Replace the address' })).toBeEnabled();
  });

  test('a key that does not come is said in the pop-up, with Try again', async ({ page }) => {
    const d = db({ down: true });
    await open(page, d);
    await expect(row(page)).toBeVisible();
    await row(page).click();
    await expect(box(page).locator('#calf-err')).toHaveText('We could not do that. Please try again.');
    await expect(box(page).locator('#calf-add')).toHaveCount(0);
    d.down = false;
    await box(page).getByRole('button', { name: 'Try again' }).click();
    await expect(box(page).locator('#calf-add')).toHaveAttribute('href', `webcal://${host(page)}/api/ics?k=${KEYS[0]}`);
  });

  test('in Arabic: the row, the pop-up, the question and the language the events will be written in', async ({ page }) => {
    const d = db();
    await open(page, d, '/?lang=ar');
    await expect(row(page).locator('.acc-row-t')).toHaveText('تقويم');
    await row(page).click();
    await expect(box(page).locator('#calf-title')).toHaveText('حجوزاتك في تقويمك');
    await expect(box(page).locator('#calf-add')).toHaveText('أضف إلى تقويمي');
    expect(d.calls.find((c) => c.p_op === 'get')!.p_lang).toBe('ar');
    await box(page).getByRole('button', { name: 'استبدال العنوان' }).click();
    await expect(page.locator('#confirm-modal #dlgt-confirm')).toHaveText('استبدال العنوان؟');
    await page.locator('#confirm-modal').getByRole('button', { name: 'استبدال العنوان' }).click();
    await expect(box(page).locator('#calf-add')).toHaveAttribute('href', `webcal://${host(page)}/api/ics?k=${KEYS[1]}`);
    expect(d.calls.find((c) => c.p_op === 'new')!.p_lang).toBe('ar');
    await expect(box(page).locator('#calf-note')).toBeHidden();
  });

  test('every word of the file exists in all ten languages, with Latin digits', async ({ page }) => {
    await open(page, db());
    await openPop(page);
    expect(await page.evaluate(`CALF_LANGS`)).toEqual(['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']);
    expect(await page.evaluate(`Object.entries(CALF_T).filter(([k,v])=>v.length!==10||v.some(x=>!String(x).trim())).map(([k])=>k)`)).toEqual([]);
    expect(await page.evaluate(`Object.entries(CALF_T).filter(([k,v])=>{const h=x=>(x.match(/\\{\\d\\}/g)||[]).sort().join();return v.some(x=>h(x)!==h(v[0]));}).map(([k])=>k)`)).toEqual([]);
    expect(await page.evaluate(`Object.entries(CALF_T).filter(([k,v])=>v.some(x=>/[٠-٩۰-۹०-९০-৯]/.test(x))).map(([k])=>k)`)).toEqual([]);
  });
});

// The suite bypasses the Content-Security-Policy (playwright.config.ts), and the build's handler and inline-style
// checks do not read calendar-feed.js. Here the policy is on, as on a rider's phone.
test.describe('@customer:account the calendar address under the site\'s own policy', () => {
  test.use({ bypassCSP: false });
  test('the file is fetched, the pop-up opens styled and the question is asked, with no violation', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as CspWin).__cspv = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as unknown as CspWin).__cspv.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
    });
    const d = db();
    await stubSupabase(page, { sessions, queue_entries: [], 'rpc:customer_profile': [profile], 'rpc:customer_emergency': [{ emergency_name: 'Ali Saleh', emergency_phone: '+966551112222', emergency_relation: 'friend' }], 'rpc:customer_deletion_request': { requested_at: null } });
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
    await page.route('**://*.supabase.co/rest/v1/rpc/calendar_link', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fallback();
      const sent = req.postDataJSON() as Call;
      d.calls.push(sent);
      if (sent.p_op !== 'peek' && (!d.key || sent.p_op === 'new')) d.key = KEYS[d.made++];
      return route.fulfill({ status: 200, headers, body: JSON.stringify(sent.p_op === 'peek' ? { ok: true, has: !!d.key } : { ok: true, key: d.key }) });
    });
    await loginCustomer(page, profile);
    await page.goto('/');
    await page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && !!S.dataLoaded
      && (typeof _lastLoadOk === 'undefined' || _lastLoadOk === true) && (typeof _refsLoaded === 'undefined' || _refsLoaded === true), undefined, { timeout: 10000 });
    await page.evaluate(() => setCustTab('account'));
    await openPop(page);
    // the stylesheet reaches the file's own classes: the link reads as a button, the two quiet actions stack full width
    const look = await box(page).evaluate((b) => {
      const a = b.querySelector('#calf-add')!, acts = b.querySelector('.calf-acts')!, c = b.querySelector('#calf-copy')!;
      return [getComputedStyle(a).textDecorationLine, getComputedStyle(acts).display, Math.round(c.getBoundingClientRect().width) === Math.round(acts.getBoundingClientRect().width)];
    });
    expect(look).toEqual(['none', 'grid', true]);
    await box(page).getByRole('button', { name: 'Replace the address' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Replace the address' }).click();
    await expect(box(page).locator('#calf-add')).toHaveAttribute('href', `webcal://${host(page)}/api/ics?k=${KEYS[1]}`);
    await page.keyboard.press('Escape');
    await expect(box(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as CspWin).__cspv.slice())).toEqual([]);
  });
});

// ── The address itself: functions/api/ics.js, asked with GET ─────────────────────────────────────────────────────────
// The database is not reachable from the suite, so its two functions are stood in for with the rules the migration
// writes (the last test reads the migration's own text for them): calendar_link makes, answers and replaces a rider's
// key; calendar_feed answers a key with one row per session its rider holds a waiting or active booking on, from
// yesterday in Jeddah on, and a key nobody holds exactly as a rider with no bookings.
type Fn = (ctx: { request: Request; env?: Record<string, string> }) => Promise<Response>;
type Sess = { id: string; session_date: string; bike_slots?: string; event_kind?: string | null; ride_kind?: string | null; needs_approval?: boolean | null; title?: string | null; title_ar?: string | null; meet_url?: string | null; location?: string | null; reveal_at?: string | null; price?: number };
type Booking = { id: string; name: string; customer_id: string; session_id: string; status: string; queue_num: number; price?: number; approval?: string | null };
function standIn(sessionRows: Sess[], bookings: Booking[]) {
  const feeds = new Map<string, { key: string; lang: string; hits: number }>();
  let made = 0;
  const hex = () => (++made).toString(16).padStart(64, '0');
  const ksaYesterday = () => new Date(Date.now() + 3 * 36e5 - 864e5).toISOString().slice(0, 10);
  return {
    asked: [] as string[],
    link(id: string, op = 'get', lang = 'en'): { ok: boolean; has?: boolean; key?: string } {
      const f = feeds.get(id);
      if (op === 'peek') return { ok: true, has: !!f };
      if (!f) feeds.set(id, { key: hex(), lang, hits: 0 });
      else if (op === 'new') { f.key = hex(); f.hits = 0; f.lang = lang; } else f.lang = lang;
      return { ok: true, key: feeds.get(id)!.key };
    },
    feed(key: string) {
      const hit = [...feeds.entries()].find(([, f]) => f.key === key);
      if (!/^[0-9a-f]{64}$/.test(key) || !hit) return { ok: true, items: [] };
      const [id, f] = hit;
      if (++f.hits > 60) return { ok: false, error: 'busy' };
      const from = ksaYesterday(), items: Record<string, unknown>[] = [], seen = new Set<string>();
      for (const q of [...bookings].sort((a, b) => a.queue_num - b.queue_num)) {
        const s = sessionRows.find((x) => x.id === q.session_id);
        if (!s || q.customer_id !== id || !['waiting', 'active'].includes(q.status) || s.session_date < from || seen.has(s.id)) continue;
        seen.add(s.id);
        const held = !!s.reveal_at && Date.parse(s.reveal_at) > Date.now();
        items.push({ id: q.id, date: s.session_date, time: (/"_time"\s*:\s*"([^"]*)"/.exec(s.bike_slots || '') || [])[1] ?? null, ek: s.event_kind ?? null, rk: s.ride_kind ?? null, appr: s.needs_approval ?? null,
          title: (s.title || '').trim() || null, title_ar: (s.title_ar || '').trim() || null, meet: (s.meet_url || '').trim() || null, loc: held ? null : (s.location || '').trim() || null, held });
      }
      const by = (x: Record<string, unknown>) => `${x.date} ${x.time} ${x.id}`; // one row a session (its lowest number), in date order
      return items.length ? { ok: true, lang: f.lang, items: items.sort((x, y) => (by(x) < by(y) ? -1 : 1)) } : { ok: true, items: [] };
    },
  };
}
const SESS: Sess[] = [
  { id: '2099-01-03', session_date: '2099-01-03', bike_slots: '{"_time":"06:30 - 07:00"}', event_kind: 'community', ride_kind: 'saturday', needs_approval: true, meet_url: 'https://maps.app.goo.gl/meet1', price: 0 },
  { id: '2099-01-10', session_date: '2099-01-10', bike_slots: '{"_time":"21:00 - 23:00","_total":12}', location: 'JCC', price: 45 },
  { id: '2099-01-17', session_date: '2099-01-17', bike_slots: '{"_time":"21:00 - 23:00"}', location: 'JCC', price: 45 },
  { id: '2099-01-24', session_date: '2099-01-24', bike_slots: '{"_time":"21:00 - 23:00"}', location: 'JCC', price: 45 },
  { id: '2099-01-31', session_date: '2099-01-31', bike_slots: '{"_time":"21:00 - 23:00"}', location: 'JCC', price: 45 },
  { id: '2020-01-04', session_date: '2020-01-04', bike_slots: '{"_time":"21:00 - 23:00"}', location: 'JCC', price: 45 },
  { id: '2099-02-07-sw', session_date: '2099-02-07', bike_slots: '{"_time":"17:00 - 18:30"}', event_kind: 'community', ride_kind: 'swim', needs_approval: false, title: 'Triathlon Pool Session', price: 60 },
];
const bookingsOf = (): Booking[] => [
  { id: 'a1', name: 'Lina Haddad', customer_id: 'A', session_id: '2099-01-03', status: 'waiting', queue_num: 4, price: 0, approval: 'pending' },
  { id: 'a2', name: 'Lina Haddad', customer_id: 'A', session_id: '2099-01-10', status: 'active', queue_num: 2, price: 45 },
  { id: 'a2b', name: 'Guest Of Lina', customer_id: 'A', session_id: '2099-01-10', status: 'waiting', queue_num: 3, price: 45 }, // a second seat on the same night
  { id: 'a3', name: 'Lina Haddad', customer_id: 'A', session_id: '2099-01-17', status: 'waitlist', queue_num: 9, price: 45 },
  { id: 'a4', name: 'Lina Haddad', customer_id: 'A', session_id: '2099-01-24', status: 'cancelled', queue_num: 1, price: 45 },
  { id: 'a5', name: 'Lina Haddad', customer_id: 'A', session_id: '2099-01-31', status: 'done', queue_num: 1, price: 45 },
  { id: 'a6', name: 'Lina Haddad', customer_id: 'A', session_id: '2020-01-04', status: 'waiting', queue_num: 1, price: 45 },
  { id: 'b1', name: 'Omar Zaki', customer_id: 'B', session_id: '2099-02-07-sw', status: 'waiting', queue_num: 1, price: 60 },
  { id: 'b2', name: 'Omar Zaki', customer_id: 'B', session_id: '2099-01-10', status: 'waiting', queue_num: 5, price: 45 },
];
const uids = (ics: string) => [...ics.matchAll(/^UID:booking-([\w-]+)@micromobility\.sa$/gm)].map((m) => m[1]);
const EMPTY = /^BEGIN:VCALENDAR\r\n(?:(?!BEGIN:VEVENT)[^\r\n]*\r\n)*END:VCALENDAR$/;

test.describe('@customer:account /api/ics, the calendar address', () => {
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });
  const env = { SUPABASE_ANON_KEY: 'anon' };
  const get = (key: string | null, ip = '203.0.113.7') => new Request('https://site.test/api/ics' + (key == null ? '' : `?k=${key}`), { headers: { 'cf-connecting-ip': ip } });
  // The function's one call out, answered by the stand-in. What it sent is kept, to see where the key travelled.
  function wire(d: ReturnType<typeof standIn>, sent: { url: string; body: string }[] = []) {
    globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
      sent.push({ url: String(u), body: String(init?.body) });
      if (!String(u).endsWith('/rest/v1/rpc/calendar_feed')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(d.feed(JSON.parse(String(init?.body)).p_key)));
    }) as typeof fetch;
    return sent;
  }

  test('lists only that rider\'s upcoming bookings: nobody else\'s, nothing past, waitlisted, cancelled or done, no price and no name', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestGet as Fn;
    const d = standIn(SESS, bookingsOf()), sent = wire(d);
    const keyA = d.link('A').key!, keyB = d.link('B').key!;
    const a = await fn({ request: get(keyA), env });
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toContain('text/calendar');
    const ta = await a.text();
    expect(uids(ta)).toEqual(['a1', 'a2']); // one event a session: the second seat on the 10th is the same evening
    expect(ta).toContain('SUMMARY:Saturday Social Ride');
    expect(ta).toContain('SUMMARY:MicroMobility Ride');
    expect(ta).toContain('X-WR-CALNAME:MicroMobility');
    // nobody is named, nothing is priced, nobody else's booking is in it
    expect(ta).not.toMatch(/Lina|Haddad|Guest|Omar|Zaki/);
    expect(ta).not.toMatch(/SAR|ر\.س|\b45\b|\b60\b|price/i);
    expect(ta).not.toContain('Triathlon Pool Session');
    const tb = await (await fn({ request: get(keyB), env })).text();
    expect(uids(tb)).toEqual(['b2', 'b1']);
    expect(tb).toContain('SUMMARY:Triathlon Pool Session');
    expect(tb).not.toContain('Saturday Social Ride');
    // the key went to the database in the body of a POST, never in an address
    expect(sent).toHaveLength(2);
    expect(sent[0].url).toBe('https://qpffkzmsfyilicwcsszz.supabase.co/rest/v1/rpc/calendar_feed');
    expect(JSON.parse(sent[0].body)).toEqual({ p_key: keyA });
  });

  test('a cancelled booking drops out at the next read', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestGet as Fn;
    const rows = bookingsOf(), d = standIn(SESS, rows);
    wire(d);
    const key = d.link('A').key!;
    expect(uids(await (await fn({ request: get(key), env })).text())).toEqual(['a1', 'a2']);
    rows.find((r) => r.id === 'a1')!.status = 'cancelled';
    const after = await (await fn({ request: get(key), env })).text();
    expect(uids(after)).toEqual(['a2']);
    expect(after).not.toContain('Saturday Social Ride');
    // the last seat on a night cancelled too: the night goes, and a rider with nothing left has an empty calendar
    rows.filter((r) => r.session_id === '2099-01-10' && r.customer_id === 'A').forEach((r) => { r.status = 'cancelled'; });
    expect(await (await fn({ request: get(key), env })).text()).toMatch(EMPTY);
  });

  test('a replaced address stops working: the old one answers with an empty calendar, the new one with the bookings', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestGet as Fn;
    const d = standIn(SESS, bookingsOf());
    wire(d);
    const old = d.link('A').key!;
    expect(uids(await (await fn({ request: get(old), env })).text())).toEqual(['a1', 'a2']);
    const next = d.link('A', 'new').key!;
    expect(next).not.toBe(old);
    const gone = await fn({ request: get(old), env });
    expect(gone.status).toBe(200); // not an error: the answer a rider with no bookings gets
    expect(await gone.text()).toMatch(EMPTY);
    expect(uids(await (await fn({ request: get(next), env })).text())).toEqual(['a1', 'a2']);
  });

  test('a key nobody holds, a malformed one and none at all get the same empty calendar, and say nothing more', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestGet as Fn;
    const d = standIn(SESS, bookingsOf()), sent = wire(d);
    const idle = d.link('C').key!; // a rider with an address and no bookings
    const strip = (t: string) => t.replace(/\r\n(DTSTAMP|SEQUENCE):[^\r\n]*/g, '');
    const answers: string[] = [];
    for (const k of [idle, 'f'.repeat(64), 'F'.repeat(64), 'abc', "x' or 1=1 --", '', null]) {
      const r = await fn({ request: get(k == null ? null : encodeURIComponent(k)), env });
      expect(r.status, String(k)).toBe(200);
      expect(r.headers.get('content-type'), String(k)).toContain('text/calendar');
      expect(r.headers.get('cache-control'), String(k)).toBe('private, no-store');
      const t = await r.text();
      expect(t, String(k)).toMatch(EMPTY);
      answers.push(strip(t));
    }
    expect(new Set(answers).size).toBe(1);
    // only a key of the right shape is ever put to the database
    expect(sent.map((s) => JSON.parse(s.body).p_key)).toEqual([idle, 'f'.repeat(64)]);
  });

  test('the answer is private and never cached; a database out of reach is a 503, a spent budget a 429, never an empty calendar', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestGet as Fn;
    const d = standIn(SESS, bookingsOf());
    wire(d);
    const key = d.link('A').key!;
    const ok = await fn({ request: get(key), env });
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('x-robots-tag')).toContain('noindex');
    expect(ok.headers.get('location')).toBeNull();
    for (const broken of [async () => new Response('down', { status: 500 }), async () => { throw new Error('net'); }, async () => new Response('not json'), async () => new Response('null')]) {
      globalThis.fetch = broken as unknown as typeof fetch;
      const r = await fn({ request: get(key), env });
      expect(r.status).toBe(503);
      expect(await r.text()).toBe('');
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    }
    // the database's own meter for one address (60 reads an hour): the 61st read of this key
    wire(d);
    let last = ok;
    for (let i = 0; i < 60; i++) last = await fn({ request: get(key, `198.51.100.${i}`), env });
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBe('600');
    expect(await last.text()).toBe('');
    // no key to the database without the site's own key for it
    expect((await fn({ request: get(key, '198.51.100.200'), env: {} })).status).toBe(503);
  });

  test('each caller is metered before anything is looked at: the 61st call in five minutes is refused, another caller is served', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestGet as Fn;
    const d = standIn(SESS, bookingsOf()), sent = wire(d);
    d.link('A');
    const guess = (i: number) => i.toString(16).padStart(64, 'e'); // a different guess every time
    for (let i = 0; i < 60; i++) expect((await fn({ request: get(guess(i)), env })).status).toBe(200);
    expect(sent).toHaveLength(60);
    const over = await fn({ request: get(guess(60)), env });
    expect(over.status).toBe(429);
    expect(await over.text()).toBe('');
    expect(sent).toHaveLength(60); // refused before the database was asked
    expect((await fn({ request: get(guess(61), '203.0.113.99'), env })).status).toBe(200);
  });

  test('the address and its key are written nowhere: no log line, whatever happens', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestGet as Fn;
    const d = standIn(SESS, bookingsOf());
    const key = d.link('A').key!;
    const said: string[] = [];
    const real = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(real) as (keyof typeof real)[]) console[k] = (...a: unknown[]) => { said.push(a.join(' ')); };
    try {
      wire(d);
      await fn({ request: get(key), env });
      await fn({ request: get('f'.repeat(64)), env });
      globalThis.fetch = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
      await fn({ request: get(key), env });
    } finally { Object.assign(console, real); }
    expect(said).toEqual([]);
    const src = readFileSync('functions/api/ics.js', 'utf8');
    expect(src).not.toMatch(/console\./);
  });
});

test.describe('@customer:account the calendar\'s events', () => {
  type Body = (items: unknown[], lang: string | undefined, origin: string, nowMs: number) => string;
  const NOW = Date.parse('2099-01-02T12:00:00+03:00');
  const lines = (ics: string) => ics.split('\r\n');
  const field = (ics: string, k: string) => lines(ics).filter((l) => l.startsWith(k + ':')).map((l) => l.slice(k.length + 1));
  const load = async () => (await freshModule('functions/api/ics.js')).feedBody as Body;

  test('a ride that gathers starts at the gathering and ends two hours after the start, and names both times and its meeting point', async () => {
    const feedBody = await load();
    const ics = feedBody([{ id: 'q1', date: '2099-01-03', time: '06:30 - 07:00', ek: 'community', rk: 'saturday', appr: true, title: null, title_ar: null, meet: 'https://maps.app.goo.gl/meet1', loc: null, held: false }], 'en', 'https://site.test', NOW);
    expect(field(ics, 'UID')).toEqual(['booking-q1@micromobility.sa']); // the booking's own id, as the ticket's file writes it
    expect(field(ics, 'DTSTART')).toEqual(['20990103T033000Z']); // 06:30 in Jeddah
    expect(field(ics, 'DTEND')).toEqual(['20990103T060000Z']); // 07:00 plus two hours
    expect(field(ics, 'SUMMARY')).toEqual(['Saturday Social Ride']);
    expect(field(ics, 'LOCATION')).toEqual(['https://maps.app.goo.gl/meet1']);
    expect(field(ics, 'DESCRIPTION')[0]).toBe('Gathering 6:30 AM · Start 7 AM\\nYour MicroMobility ride. Be at the meeting point by the gathering time and show your ticket there.\\nMeeting point: https://maps.app.goo.gl/meet1');
    expect(field(ics, 'URL')).toEqual(['https://site.test/my-bookings']);
    expect(field(ics, 'DESCRIPTION')[1]).toBe('Reminder: Saturday Social Ride'); // the alarm's line, as the ticket's file has it
    expect(lines(ics).slice(0, 5)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MicroMobility//Bookings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']);
    expect(lines(ics).at(-1)).toBe('END:VCALENDAR');
  });

  test('a circuit night runs start to end, past midnight into the next day, at the circuit; a pool session says nothing about cycling', async () => {
    const feedBody = await load();
    const ics = feedBody([
      { id: 'n1', date: '2099-01-10', time: '22:00 - 01:00', ek: null, rk: null, loc: 'JCC' },
      { id: 'p1', date: '2099-02-07', time: '17:00 - 18:30', ek: 'community', rk: 'swim', appr: false, title: null, loc: null },
      { id: 'y1', date: '2099-02-08', time: '07:00 - 08:00', ek: 'community', rk: 'yoga', appr: false, title: 'Morning yoga', meet: 'https://maps.app.goo.gl/studio', loc: null },
      { id: 'r1', date: '2099-02-09', time: '05:30 - 06:00', ek: 'community', rk: 'runher', appr: false, loc: null },
    ], 'en', 'https://site.test', NOW);
    expect(field(ics, 'DTSTART')).toEqual(['20990110T190000Z', '20990207T140000Z', '20990208T040000Z', '20990209T023000Z']);
    expect(field(ics, 'DTEND')).toEqual(['20990110T220000Z', '20990207T153000Z', '20990208T050000Z', '20990209T050000Z']);
    expect(field(ics, 'SUMMARY')).toEqual(['MicroMobility Ride', 'Triathlon Pool Session', 'Morning yoga', 'Run for Her']);
    expect(field(ics, 'LOCATION')).toEqual(['Jeddah Corniche Circuit', 'Jeddah Corniche Circuit', 'https://maps.app.goo.gl/studio', 'Jeddah Yacht Club']);
    const blocks = ics.split('BEGIN:VEVENT').slice(1);
    expect(blocks[0]).toContain('DESCRIPTION:Your MicroMobility bike rental. Arrive 10 minutes early and show your ticket at the booth.');
    for (const b of [blocks[1], blocks[2], blocks[3]]) expect(b).not.toMatch(/\b(ride|bike|bikes|cycling|rental)\b/i); // the pool, the yoga date, the run
    expect(blocks[1]).toContain('DESCRIPTION:Your MicroMobility booking. Arrive 10 minutes early and show your ticket when you arrive.');
    expect(blocks[3]).toContain('DESCRIPTION:Gathering 5:30 AM · Start 6 AM\\nYour MicroMobility booking. Be at the meeting point by the gathering time');
  });

  test('what has ended is left out, what is under way stays; a spot not told yet names no place; a link that is not a web address is not served', async () => {
    const feedBody = await load();
    const now = Date.parse('2099-01-10T23:30:00+03:00');
    const ics = feedBody([
      { id: 'early', date: '2099-01-10', time: '17:00 - 19:00', loc: 'JCC' }, // ended at 19:00
      { id: 'late', date: '2099-01-10', time: '22:00 - 01:00', loc: 'JCC' }, // under way until 01:00
      { id: 'yday', date: '2099-01-09', time: '21:00 - 23:00', loc: 'JCC' }, // yesterday's
      { id: 'held', date: '2099-01-17', time: '06:30 - 07:00', ek: 'community', rk: 'saturday', appr: true, meet: null, loc: null, held: true },
      { id: 'bad', date: '2099-01-24', time: '06:30 - 07:00', ek: 'community', rk: 'saturday', appr: true, meet: 'javascript:alert(1)', loc: 'Obhur, north; gate 2\nEND:VCALENDAR', held: false },
      { id: 'late', date: '2099-01-10', time: '22:00 - 01:00', loc: 'JCC' }, // the same booking twice is one event
      { id: '', date: '2099-01-25', time: '06:30 - 07:00' }, { id: 'nodate', date: 'soon' }, null, 'x',
    ], 'en', 'https://site.test', now);
    expect(uids(ics)).toEqual(['late', 'held', 'bad']);
    const blocks = ics.split('BEGIN:VEVENT').slice(1);
    expect(blocks[1]).not.toContain('LOCATION:'); // the held ride: no place, never the circuit
    expect(blocks[2]).not.toContain('javascript');
    expect(blocks[2]).toContain('LOCATION:Obhur\\, north\\; gate 2\\nEND:VCALENDAR'); // stored text cannot end the calendar or start a line
    expect(lines(ics).filter((l) => l === 'END:VCALENDAR')).toHaveLength(1);
  });

  test('the events are written in the rider\'s language: an Arabic name where staff gave one, the day\'s halves and Urdu\'s parts of the day', async () => {
    const feedBody = await load();
    const items = [
      { id: 'q1', date: '2099-01-03', time: '06:30 - 19:00', ek: 'community', rk: 'saturday', appr: true, title: 'Obhur loop', title_ar: 'جولة أبحر', meet: 'https://maps.app.goo.gl/meet1' },
      { id: 'q2', date: '2099-01-04', time: '18:00 - 21:30', ek: 'community', rk: 'vlap', appr: false, title: null, loc: null },
    ];
    const ar = feedBody(items, 'ar', 'https://site.test', NOW);
    expect(field(ar, 'SUMMARY')).toEqual(['جولة أبحر', 'فيكتوري لاب']);
    expect(field(ar, 'DESCRIPTION')[0]).toContain('التجمع 6:30 ص · الانطلاق 7 م');
    expect(field(ar, 'DESCRIPTION')[0]).toContain('نقطة التجمع: https://maps.app.goo.gl/meet1');
    expect(field(ar, 'DESCRIPTION')[2]).toContain('فتح الأبواب 6 م · أول دفعة 9:30 م'); // Victory Lap: doors open, the first heat
    expect(field(ar, 'LOCATION')[1]).toBe('حلبة كورنيش جدة');
    const fr = feedBody(items, 'fr', 'https://site.test', NOW);
    expect(field(fr, 'SUMMARY')).toEqual(['Obhur loop', 'Victory Lap']); // every other language keeps the name staff typed
    expect(field(fr, 'DESCRIPTION')[0]).toContain('Rassemblement 6:30 AM · Départ 7 PM');
    expect(field(fr, 'DESCRIPTION')[1]).toBe('Rappel : Obhur loop');
    const ur = feedBody(items, 'ur', 'https://site.test', NOW);
    expect(field(ur, 'DESCRIPTION')[0]).toContain('اجتماع 6:30 صبح · آغاز 7 شام');
    // a language the app does not speak, or none stored, reads as English
    expect(field(feedBody(items, 'xx', 'https://site.test', NOW), 'SUMMARY')).toEqual(['Obhur loop', 'Victory Lap']);
    expect(field(feedBody(items, undefined, 'https://site.test', NOW), 'DESCRIPTION')[0]).toContain('Gathering 6:30 AM · Start 7 PM');
  });

  test('its words are the app\'s own, in all ten languages', async ({ page }) => {
    const m = await freshModule('functions/api/ics.js');
    const langs = m.FEED_LANGS as string[], words = m.FEED_WORDS as Record<string, string[]>;
    expect(langs).toEqual(['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']);
    const KEY: Record<string, string> = { ride: 'icsRideTitle', petromin: 'evPetroName', swim: 'evSwimName', workshop: 'evWorkshopName', snd96: 'evSnd96Name', event: 'evEventName', runher: 'evRunHerName', vlap: 'evVlapName', arena: 'evArenaName', defe5k: 'evDefeName', blood: 'evBloodName', yoga: 'evYogaName', farm: 'evFarmName', saturday: 'evSatName', jcc: 'evJccName', jyc: 'venueJyc', gym: 'venueGymnation', meet: 'meetPointLbl', gather: 'commGatherShort', start: 'commStartShort', doors: 'vlDoorsShort', heat: 'vlHeatShort', arrive: 'fhArrive', dinner: 'fhDinner', dRide: 'icsDescRide', dMeet: 'icsDescMeet', dBike: 'icsDescBike', dVisit: 'icsDescVisit', alarm: 'icsAlarm' };
    expect(Object.keys(words).sort()).toEqual(Object.keys(KEY).sort());
    for (const [k, row] of Object.entries(words)) {
      expect(row, k).toHaveLength(10);
      expect(row.every((x) => typeof x === 'string' && !!x.trim()), k).toBe(true);
      expect(row.some((x) => /[٠-٩۰-۹०-९০-৯]/.test(x)), k).toBe(false);
    }
    // each row is the string of that name on the rider's page: English from the page itself, the rest from its packs
    await stubSupabase(page, { sessions: [], queue_entries: [] });
    await page.goto('/');
    await waitForSb(page);
    const en = await page.evaluate(`Object.fromEntries(${JSON.stringify(Object.values(KEY))}.map(k=>[k,LANG.en[k]]))`) as Record<string, string>;
    const pack = (code: string) => (code === 'en' ? en : JSON.parse(readFileSync(`lang/${code}.json`, 'utf8')) as Record<string, string>);
    for (const [i, code] of langs.entries()) {
      const p = pack(code);
      for (const [k, key] of Object.entries(KEY)) expect(words[k][i], `${code} ${key}`).toBe(p[key]);
    }
  });
});

test('@customer:account the migration: a locked table, the rider\'s own key, and what an address may read', () => {
  const sql = readFileSync('supabase/migrations/20261114082700_calendar_feed.sql', 'utf8');
  const fn = (name: string) => { const i = sql.indexOf(`function public.${name}(`); expect(i).toBeGreaterThan(-1); return sql.slice(i, sql.indexOf('$function$;', i)); };
  // nobody reads the table: row level security with no policy, every grant taken away, staff included
  expect(sql).toMatch(/alter table public\.calendar_feeds enable row level security;/);
  expect(sql).toMatch(/revoke all on public\.calendar_feeds from public, anon, authenticated;/);
  expect(sql).not.toMatch(/create policy/i);
  expect(sql).not.toMatch(/grant\s+(select|all|insert|update)[^;]*calendar_feeds/i);
  expect(sql).toContain('references public.customers(id) on delete cascade');
  // the rider's own: token-checked before anything, and a peek makes nothing and sends no key
  const link = fn('calendar_link');
  expect(link).toMatch(/security definer\s+set search_path to 'public'/);
  expect(link.indexOf('_cust_token_ok(p_id, p_token)')).toBeGreaterThan(-1);
  expect(link.indexOf('_cust_token_ok(p_id, p_token)')).toBeLessThan(link.indexOf('from calendar_feeds'));
  expect(link).toContain("if p_op = 'peek' then\n    return jsonb_build_object('ok', true, 'has', v_key is not null);");
  // a replace writes a new key over the old one: the old address finds no row
  expect(link).toContain("elsif p_op = 'new' then");
  expect(link).toMatch(/update calendar_feeds f\s+set feed_key = v_new, replaced_at = now\(\)/);
  expect(link).toContain("replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')");
  // what an address reads: its own rider's bookings still standing, from yesterday on, and nothing about anyone
  const feed = fn('calendar_feed');
  expect(feed).toMatch(/security definer\s+set search_path to 'public'/);
  expect(feed).toContain('where q.customer_id = f.customer_id');
  expect(feed).toContain("and q.status in ('waiting', 'active')");
  expect(feed).toContain('and s.session_date >= v_from');
  expect(feed).toContain("(now() at time zone 'Asia/Riyadh')::date - 1");
  expect(feed).not.toMatch(/\bq\.(name|email|phone|price|paid|promo_code|height)\b/);
  expect(feed).not.toMatch(/\bs\.(price|capacity|spots)\b/);
  // a key nobody holds answers as a rider with no bookings does, and the key is metered on its own row
  expect(feed.match(/return jsonb_build_object\('ok', true, 'items', '\[\]'::jsonb\);/g)).toHaveLength(2);
  expect(feed).toContain("if v = '[]'::jsonb then return jsonb_build_object('ok', true, 'items', v); end if;");
  expect(feed).toContain("return jsonb_build_object('ok', false, 'error', 'busy');");
  expect(feed).not.toMatch(/login_throttle|_ip_gate|raise (notice|log|warning)/);
  // the spot staff have not told yet stays unsaid here too
  expect(feed).toContain("'loc', case when b.held then null else nullif(btrim(s.location), '') end");
  // both reachable with the page's key, as every rider function; both in the drift check's list
  expect(sql).toContain('grant execute on function public.calendar_link(text, text, text, text) to anon, authenticated;');
  expect(sql).toContain('grant execute on function public.calendar_feed(text) to anon, authenticated;');
  expect(sql).toContain("values ('20261114082700', 'calendar_feed')");
  const attrs = readFileSync('supabase/checks/security-attributes.sql', 'utf8');
  for (const f of ['calendar_link', 'calendar_feed']) expect(attrs).toContain(`('${f}',`);
});
