import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';
import { freshModule } from './helpers/fresh-module';

// Club calendar (2026-11-18; the user picked "Club calendar: the Calendar row would also offer every upcoming Saturday ride
// and featured session, not just the rider's own bookings. It uses the existing calendar address."). The Calendar pop-up
// (calendar-feed.js) gains a "Club sessions too" switch kept on the server (calendar_club_set, migration 20261118211000);
// the rider's own /api/ics?k=<key> then also lists the club's sessions calendar_feed sends (marked club), each as its own
// event: UID club-<session>, the booking app's link first, no alarm, never a breakfast spot and nothing of the place
// before the spot is told. All Supabase traffic is stubbed; the Pages function is called directly.

const sessions = [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];
const profile = { id: 'c1', name: 'Sara Khalid', email: 'sara@example.com', phone: '+966500000001', height: 168, birth_date: '1994-03-02', country: 'Saudi Arabia', city: 'Jeddah', nationality: 'Saudi Arabia', gender: 'female', type_preference: 'Hybrid', photo: null };
const KEY = 'c3'.repeat(32);
type Call = { p_id?: string; p_token?: string; p_lang?: string; p_op?: string; p_on?: boolean };
type Db = { club: boolean | null; calls: Call[]; sets: Call[]; refuse?: boolean };

async function open(page: Page, d: Db, path = '/') {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [profile], 'rpc:customer_emergency': [{ emergency_name: 'Ali Saleh', emergency_phone: '+966551112222', emergency_relation: 'friend' }],
    'rpc:customer_deletion_request': { requested_at: null },
  });
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
  // calendar_link as 20261118211000 writes it: 'get' carries where the switch stands (a database before it does not)
  await page.route('**://*.supabase.co/rest/v1/rpc/calendar_link', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    const sent = route.request().postDataJSON() as Call;
    d.calls.push(sent);
    const body = sent.p_op === 'peek' ? { ok: true, has: true } : d.club === null ? { ok: true, key: KEY } : { ok: true, key: KEY, club: d.club };
    return route.fulfill({ status: 200, headers, body: JSON.stringify(body) });
  });
  await page.route('**://*.supabase.co/rest/v1/rpc/calendar_club_set', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    const sent = route.request().postDataJSON() as Call;
    d.sets.push(sent);
    if (d.refuse) return route.fulfill({ status: 500, headers, body: JSON.stringify({ code: 'XX000', message: 'down' }) });
    d.club = sent.p_on === true;
    return route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, club: d.club }) });
  });
  await loginCustomer(page, profile);
  await page.goto(path);
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-cal-btn')).toBeVisible();
  await page.locator('#acc-cal-btn').click();
  await expect(page.locator('#acc-pwd-modal .calf-box #calf-add')).toBeVisible();
}
const box = (page: Page) => page.locator('#acc-pwd-modal .calf-box');
const sw = (page: Page) => page.locator('#calf-club');

test.describe('@customer:account the club sessions switch in the Calendar pop-up', () => {
  test('a switch under Add to my calendar, off at first; turning it on is kept on the server and says nothing', async ({ page }) => {
    const d: Db = { club: false, calls: [], sets: [] };
    await open(page, d);
    await expect(sw(page)).toHaveAttribute('role', 'switch');
    await expect(sw(page)).not.toBeChecked();
    await expect(box(page).locator('label.calf-club')).toHaveText('Club sessions too');
    // between Add to my calendar and the two quiet actions
    const order = await box(page).evaluate((b) => [...b.querySelectorAll('#calf-add, .calf-club, .calf-acts')].map((e) => e.id || e.className));
    expect(order).toEqual(['calf-add', 'cw-sw calf-club', 'calf-acts']);
    await box(page).locator('label.calf-club').click();
    await expect.poll(() => d.sets.length).toBe(1);
    expect(d.sets[0]).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_on: true });
    await expect(sw(page)).toBeChecked();
    await expect(sw(page)).toBeEnabled();
    await expect(box(page).locator('#calf-err')).toBeEmpty();
    await expect(box(page).locator('#calf-note')).toBeHidden();
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0);
    // the same address: the link is unchanged, nothing new was made
    await expect(box(page).locator('#calf-add')).toHaveAttribute('href', new RegExp(`/api/ics\\?k=${KEY}$`));
    // opened again, it reads where the switch stands
    await page.keyboard.press('Escape');
    await page.locator('#acc-cal-btn').click();
    await expect(sw(page)).toBeChecked();
    await box(page).locator('label.calf-club').click();
    await expect.poll(() => d.sets.length).toBe(2);
    expect(d.sets[1].p_on).toBe(false);
    await expect(sw(page)).not.toBeChecked();
  });

  test('a refusal puts the switch back and says so', async ({ page }) => {
    const d: Db = { club: false, calls: [], sets: [], refuse: true };
    await open(page, d);
    await box(page).locator('label.calf-club').click();
    await expect.poll(() => d.sets.length).toBe(1);
    await expect(box(page).locator('#calf-err')).toHaveText('We could not do that. Please try again.');
    await expect(sw(page)).not.toBeChecked();
    await expect(sw(page)).toBeEnabled();
  });

  test('a database before the switch offers none; the rest of the pop-up is as before', async ({ page }) => {
    const d: Db = { club: null, calls: [], sets: [] };
    await open(page, d);
    await expect(sw(page)).toHaveCount(0);
    await expect(box(page).getByRole('button', { name: 'Copy the address' })).toBeVisible();
  });

  test('in Arabic, and its words in all ten languages with Latin digits', async ({ page }) => {
    const d: Db = { club: true, calls: [], sets: [] };
    await open(page, d, '/?lang=ar');
    await expect(box(page).locator('label.calf-club')).toHaveText('جلسات النادي أيضًا');
    await expect(sw(page)).toBeChecked();
    const row = await page.evaluate(`CALF_T.club`) as string[];
    expect(row).toHaveLength(11);
    expect(row.every((x) => !!x.trim() && !/[٠-٩۰-۹०-९০-৯]/.test(x))).toBe(true);
    // no inline handler or style in what the file drew
    expect(await box(page).evaluate((b) => b.outerHTML)).not.toMatch(/style=|\son[a-z]+=/i);
  });
});

test.describe('@customer:account club sessions in the calendar address', () => {
  type Body = (items: unknown[], lang: string | undefined, origin: string, nowMs: number) => string;
  type Fn = (ctx: { request: Request; env?: Record<string, string> }) => Promise<Response>;
  const NOW = Date.parse('2099-01-02T12:00:00+03:00');
  const lines = (ics: string) => ics.split('\r\n');
  const blocks = (ics: string) => ics.split('BEGIN:VEVENT').slice(1);
  const field = (b: string, k: string) => lines(b).filter((l) => l.startsWith(k + ':')).map((l) => l.slice(k.length + 1));
  const booking = { id: 'q1', date: '2099-01-10', time: '06:30 - 07:00', ek: 'community', rk: 'saturday', appr: true, title: null, title_ar: null, meet: 'https://maps.app.goo.gl/meet1', loc: null, held: false };
  const clubSat = { id: '2099-01-03', club: true, date: '2099-01-03', time: '06:30 - 07:00', ek: 'community', rk: 'saturday', appr: true, title: null, title_ar: null, meet: 'https://maps.app.goo.gl/meet2', loc: null, held: false };
  const clubYoga = { id: '2099-01-05-yg', club: true, date: '2099-01-05', time: '07:00 - 08:00', ek: 'community', rk: 'yoga', appr: false, title: 'Morning yoga', title_ar: 'يوغا الصباح', meet: 'https://maps.app.goo.gl/studio', loc: null, held: false };
  const clubHeld = { id: '2099-01-17', club: true, date: '2099-01-17', time: '06:30 - 07:00', ek: 'community', rk: 'saturday', appr: true, title: null, title_ar: null, meet: 'https://maps.app.goo.gl/secret', loc: 'Secret Cafe', held: true };

  test('a club session is its own event: the booking app\'s link first, its link as the URL, no alarm, no ticket line', async () => {
    const feedBody = (await freshModule('functions/api/ics.js')).feedBody as Body;
    const ics = feedBody([booking, clubSat, clubYoga], 'en', 'https://site.test', NOW);
    const [b, s, y] = blocks(ics);
    expect(field(b, 'UID')).toEqual(['booking-q1@micromobility.sa']);
    expect(b).toContain('BEGIN:VALARM'); // the rider's own booking still rings
    expect(field(s, 'UID')).toEqual(['club-2099-01-03@micromobility.sa']);
    expect(field(s, 'SUMMARY')).toEqual(['Saturday Social Ride']);
    expect(field(s, 'DTSTART')).toEqual(['20990103T033000Z']);
    expect(field(s, 'DTEND')).toEqual(['20990103T060000Z']);
    expect(field(s, 'DESCRIPTION')).toEqual(['https://site.test/?ev=community&session=2099-01-03\\nGathering 6:30 AM · Start 7 AM\\nMeeting point: https://maps.app.goo.gl/meet2']);
    expect(field(s, 'URL')).toEqual(['https://site.test/?ev=community&session=2099-01-03']);
    expect(field(s, 'LOCATION')).toEqual(['https://maps.app.goo.gl/meet2']);
    for (const c of [s, y]) {
      expect(c).not.toContain('VALARM');
      expect(c).not.toMatch(/ticket|booking|rental/i); // not booked: no "show your ticket"
    }
    expect(field(y, 'UID')).toEqual(['club-2099-01-05-yg@micromobility.sa']);
    expect(field(y, 'SUMMARY')).toEqual(['Morning yoga']);
    expect(field(y, 'DESCRIPTION')[0]).toBe('https://site.test/?ev=community&session=2099-01-05-yg\\nMeeting point: https://maps.app.goo.gl/studio');
    expect(y).not.toMatch(/\b(ride|bike|cycling)\b/i);
    // in Arabic: the Arabic title, the link still first
    const ar = blocks(feedBody([clubYoga], 'ar', 'https://site.test', NOW))[0];
    expect(field(ar, 'SUMMARY')).toEqual(['يوغا الصباح']);
    expect(field(ar, 'DESCRIPTION')[0].startsWith('https://site.test/?ev=community&session=2099-01-05-yg\\n')).toBe(true);
  });

  test('before the spot is told a club session names no place and no meeting point, whatever the row carries', async () => {
    const feedBody = (await freshModule('functions/api/ics.js')).feedBody as Body;
    const [h] = blocks(feedBody([clubHeld], 'en', 'https://site.test', NOW));
    expect(h).not.toContain('LOCATION:');
    expect(h).not.toMatch(/secret|Meeting point/i);
    expect(field(h, 'DESCRIPTION')).toEqual(['https://site.test/?ev=community&session=2099-01-17\\nGathering 6:30 AM · Start 7 AM']);
    // a booking held the same way keeps its meeting point, as the feed always did
    const [bk] = blocks(feedBody([{ ...clubHeld, club: undefined, id: 'q9' }], 'en', 'https://site.test', NOW));
    expect(bk).toContain('Meeting point: https://maps.app.goo.gl/secret');
  });

  test('one address, one subscription: the bookings and the club sessions come together, each session once', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestGet as Fn;
    const realFetch = globalThis.fetch;
    const sent: string[] = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      sent.push(String(init?.body));
      return new Response(JSON.stringify({ ok: true, lang: 'en', items: [booking, clubSat, clubYoga, clubSat] }));
    }) as typeof fetch;
    try {
      const r = await fn({ request: new Request(`https://site.test/api/ics?k=${'ab'.repeat(32)}`, { headers: { 'cf-connecting-ip': '203.0.113.50' } }), env: { SUPABASE_ANON_KEY: 'anon' } });
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      const ics = await r.text();
      expect([...ics.matchAll(/^UID:([\w-]+)@micromobility\.sa$/gm)].map((m) => m[1])).toEqual(['booking-q1', 'club-2099-01-03', 'club-2099-01-05-yg']);
      expect(JSON.parse(sent[0])).toEqual({ p_key: 'ab'.repeat(32) }); // the key in the body, as before
    } finally { globalThis.fetch = realFetch; }
  });
});

test('@customer:account the migration: a switch on the rider\'s own row, and which club sessions an address may read', () => {
  const sql = readFileSync('supabase/migrations/20261118211000_club_calendar.sql', 'utf8');
  const code = sql.replace(/^\s*--.*$/gm, ''); // comments say what is left out; the code must not read it
  const fn = (name: string) => { const i = code.indexOf(`function public.${name}(`); expect(i).toBeGreaterThan(-1); return code.slice(i, code.indexOf('$function$;', i)); };
  expect(code).toContain('alter table public.calendar_feeds add column if not exists club boolean not null default false;');
  // no policy and no grant on the table: it stays nobody's to read
  expect(code).not.toMatch(/create policy|grant\s+(select|all|insert|update)[^;]*calendar_feeds/i);
  // the link keeps its header and its peek, and tells where the switch stands
  const link = fn('calendar_link');
  expect(link).toMatch(/volatile\s+security definer\s+set search_path to 'public'/);
  expect(link).toContain("if p_op = 'peek' then\n    return jsonb_build_object('ok', true, 'has', v_key is not null);");
  expect(link).toContain("return jsonb_build_object('ok', true, 'key', v_key, 'club', coalesce(v_club, false));");
  // the switch: the caller's own row, token first
  const set = fn('calendar_club_set');
  expect(set).toMatch(/volatile\s+security definer\s+set search_path to 'public'/);
  expect(set.indexOf('_cust_token_ok(p_id, p_token)')).toBeLessThan(set.indexOf('update calendar_feeds'));
  expect(set).toContain('update calendar_feeds f set club = p_on where f.customer_id = p_id');
  // the feed: the booking rows as before, club rows only when switched on, and their rules
  const feed = fn('calendar_feed');
  expect(feed).toContain("and q.status in ('waiting', 'active')");
  expect(feed).toContain("return jsonb_build_object('ok', false, 'error', 'busy');");
  expect(feed.match(/return jsonb_build_object\('ok', true, 'items', '\[\]'::jsonb\);/g)).toHaveLength(2);
  expect(feed).toContain('if f.club then');
  expect(feed).toContain("to_char(v_today + 60, 'YYYY-MM-DD')");
  expect(feed).toContain("(k.kind = 'saturday' and v_mem)");
  expect(feed).toContain("then k.kind in ('yoga', 'defe5k', 'farm')");
  expect(feed).toContain("a.sj->>'gender_only' = v_g");
  expect(feed).toContain("coalesce((a.sj->>'open_to_all')::boolean, false) or v_mem");
  expect(feed).toContain("'meet', case when b.held then null else nullif(btrim(a.sj->>'meet_url'), '') end");
  expect(feed).not.toMatch(/breakfast|\bs\.(price|capacity|spots)\b|\bq\.(name|email|phone|price)\b/);
  // FEAT_KINDS and the featurable kinds are the app's own
  const app = readFileSync('app.src.html', 'utf8');
  expect(app).toContain("const FEAT_KINDS=['yoga','defe5k','farm'];");
  for (const f of ['calendar_link', 'calendar_feed', 'calendar_club_set']) {
    expect(code).toContain(`grant execute on function public.${f}(`);
    expect(readFileSync('supabase/checks/security-attributes.sql', 'utf8')).toContain(`('${f}',`);
  }
  expect(code).toContain("values ('20261118211000', 'club_calendar')");
});
