import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Plan my Saturdays (new features build F10, 2026-11-13): on the Community tab, beside the monthly challenge, the current
// month's Saturdays as tick boxes. A tick books nothing and holds no place: it stores that the member plans to come, and
// the database sends one "booking is open" message when that Saturday's ride opens, unless they have booked it already.
// Past Saturdays show, locked; nothing is pre-ticked; a member's ticks are read by that member alone. All Supabase traffic
// is stubbed (hub_plan, hub_plan_set are the contract of migration 20261114081000); what only the database can enforce
// is checked in the migration's own text.

const NOV = ['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28'];
const OCT = ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31'];
const sess = (id: string) => ({ id, day: 'Saturday', session_date: id, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' });
const feed = (today: string) => ({
  ok: true, today,
  me: { kind: 'level', target: 3, n: 1, ends_on: today.slice(0, 8) + '30', sats: 4, levels: [2, 3, 4], chosen: true },
  club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null,
});
const absent = (fn: string) => ({ __rpcError: { status: 404, code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } });

// The database's side of the card, kept across reloads: which Saturdays are ticked, and every write the page sent.
type Plan = { on: Set<string>; sets: Record<string, unknown>[]; reads: number; refuse: Record<string, unknown> | null; down: boolean };
async function planServer(page: Page, sats: string[], today: string, on: string[] = []): Promise<Plan> {
  const st: Plan = { on: new Set(on), sets: [], reads: 0, refuse: null, down: false };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/rest\/v1\/rpc\/hub_plan$/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    st.reads++;
    return json(route, { ok: true, today, month: today.slice(0, 7), days: sats.map((d) => ({ date: d, on: st.on.has(d), past: d < today })) });
  });
  await page.route(/\/rest\/v1\/rpc\/hub_plan_set$/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const b = (route.request().postDataJSON() || {}) as Record<string, unknown>;
    st.sets.push(b);
    if (st.down) return json(route, { code: 'XX000', message: 'boom' }, 500);
    if (st.refuse) return json(route, st.refuse);
    if (b.p_on) st.on.add(String(b.p_date)); else st.on.delete(String(b.p_date));
    return json(route, { ok: true, date: b.p_date, on: !!b.p_on });
  });
  return st;
}
async function open(page: Page) {
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
}
// A member on the Community tab at a fixed Riyadh moment. `plan: false` leaves hub_plan to the fixtures (or to no stub).
async function member(page: Page, o: { at?: string; sats?: string[]; on?: string[]; fx?: Fixtures; plan?: boolean } = {}) {
  const at = o.at || '2026-11-13T18:00:00+03:00', today = at.slice(0, 10);
  await page.clock.setFixedTime(new Date(at));
  await stubSupabase(page, { sessions: [sess('2099-01-03')], customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed(today), ...(o.fx || {}) });
  const st = o.plan === false ? null : await planServer(page, o.sats || NOV, today, o.on);
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'female' });
  await page.goto('/');
  await open(page);
  return st as Plan;
}
const card = (page: Page) => page.locator('#hub-body .hub-plan');
const boxes = (page: Page) => card(page).getByRole('checkbox');
const box = (page: Page, day: number) => card(page).getByRole('checkbox', { name: new RegExp(`\\b${day}\\b`) });
const ticked = (page: Page) => boxes(page).evaluateAll((els) => els.filter((e) => e.getAttribute('aria-checked') === 'true').map((e) => (e.textContent || '').trim()));

test.describe('@customer:members F10 Plan my Saturdays', () => {
  test('the card: beside the monthly challenge, the month\'s Saturdays as tick boxes, none ticked, the ones gone locked', async ({ page }) => {
    await member(page);
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('.hub-k')).toHaveText(/Plan my Saturdays/);
    await expect(card(page).locator('.hub-name')).toHaveText('November');
    // directly after the member's own challenge
    await expect(page.locator('#hub-body .hub-card:has-text("Your challenge") + .hub-plan')).toBeVisible();
    await expect(boxes(page)).toHaveCount(4);
    await expect(boxes(page)).toHaveText(['7', '14', '21', '28']);
    expect(await ticked(page)).toEqual([]); // nothing is ticked for them
    await expect(box(page, 21)).toHaveAccessibleName(/^Saturday,? 21 November$/);
    await expect(box(page, 7)).toBeDisabled(); // the 7th is gone (today is the 13th)
    for (const d of [14, 21, 28]) await expect(box(page, d)).toBeEnabled();
    // no hint line, no button that books: the card is its name, the month and the boxes
    await expect(card(page).locator('small, .hub-meta, .btn-primary, .btn-secondary')).toHaveCount(0);
    expect((await card(page).innerText()).replace(/\s+/g, ' ').trim()).toBe('Plan my Saturdays November 7 14 21 28');
  });

  test('a tick and an untick persist: written at once, still there after a reload, and nothing is booked', async ({ page }) => {
    const wrote: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (r.method() !== 'GET' && r.method() !== 'OPTIONS' && /queue_entries|customer_create_booking|saturday_book|customer_booking_update/.test(u.pathname)) wrote.push(u.pathname); });
    const st = await member(page);
    await box(page, 21).click();
    await expect(box(page, 21)).toHaveAttribute('aria-checked', 'true');
    await expect(box(page, 21)).toHaveClass(/\bon\b/);
    await expect(box(page, 21)).toBeFocused(); // the repaint keeps the box the member is on
    await expect.poll(() => st.sets).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_date: '2026-11-21', p_on: true }]);
    await box(page, 28).click();
    await expect.poll(() => st.sets.length).toBe(2);
    expect(await ticked(page)).toEqual(['21', '28']);

    await page.reload();
    await open(page);
    await expect(boxes(page)).toHaveCount(4);
    expect(await ticked(page)).toEqual(['21', '28']);

    await box(page, 21).click();
    await expect(box(page, 21)).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => st.sets[2]).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_date: '2026-11-21', p_on: false });
    await page.reload();
    await open(page);
    await expect(boxes(page)).toHaveCount(4);
    expect(await ticked(page)).toEqual(['28']);
    expect(wrote).toEqual([]); // a tick books nothing and holds no place
    // and the ticks are not kept on the phone: only the member's own read brings them back
    expect(await page.evaluate(`Object.keys(localStorage).filter(k=>/plan/i.test(k)||String(localStorage.getItem(k)).includes('2026-11-28'))`)).toEqual([]);
  });

  test('a Saturday already gone is locked: shown as it was, never written', async ({ page }) => {
    const st = await member(page, { at: '2026-11-14T10:00:00+03:00', on: ['2026-11-07'] });
    await expect(box(page, 7)).toBeDisabled();
    await expect(box(page, 7)).toHaveAttribute('aria-checked', 'true'); // what they planned stays on show
    await expect(box(page, 14)).toBeEnabled(); // today's Saturday is not gone yet
    await box(page, 7).click({ force: true });
    await page.evaluate(`_planTick('2026-11-07')`);
    await page.evaluate(`_planTick('2026-12-05')`); // not on the card at all
    await page.waitForTimeout(200);
    expect(st.sets).toEqual([]);
    expect(await ticked(page)).toEqual(['7']);
    // the tab left open past midnight: the 14th is gone by the page's own clock, whatever its last read said
    await page.clock.setFixedTime(new Date('2026-11-15T00:30:00+03:00'));
    await page.evaluate(`_hubRender()`);
    await expect(box(page, 14)).toBeDisabled();
    await page.evaluate(`_planTick('2026-11-14')`);
    await page.waitForTimeout(200);
    expect(st.sets).toEqual([]);
  });

  test('a write the database refuses, or that never lands, puts the tick back and says so', async ({ page }) => {
    const st = await member(page);
    st.refuse = { ok: false, error: 'past' };
    await box(page, 21).click();
    await expect(page.locator('#toast-container')).toContainText('We could not do that. Please try again.');
    await expect(box(page, 21)).toHaveAttribute('aria-checked', 'false');
    st.refuse = null; st.down = true;
    await box(page, 28).click();
    await expect.poll(() => st.sets.length).toBe(2);
    await expect(box(page, 28)).toHaveAttribute('aria-checked', 'false');
    st.down = false;
    await box(page, 28).click();
    await expect(box(page, 28)).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => st.sets.length).toBe(3);
    expect(await ticked(page)).toEqual(['28']);
  });

  test('a second tap while the first is on its way is not sent twice', async ({ page }) => {
    const st = await member(page);
    await page.evaluate(`_planTick('2026-11-21');_planTick('2026-11-21');_planTick('2026-11-28')`);
    await expect.poll(() => st.sets.length).toBe(2);
    await page.waitForTimeout(200);
    expect(st.sets.map((b) => [b.p_date, b.p_on])).toEqual([['2026-11-21', true], ['2026-11-28', true]]);
    expect(await ticked(page)).toEqual(['21', '28']);
  });

  test('before the database has it: no card, no error, and it is not asked for again', async ({ page }) => {
    let asked = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/rpc/hub_plan')) asked++; });
    await member(page, { plan: false, fx: { 'rpc:hub_plan': absent('hub_plan') } });
    await expect.poll(() => asked).toBe(1);
    await expect(page.locator('#hub-body .hub-card', { hasText: 'Your challenge' })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await page.evaluate(`_hubRender();_hubRender()`);
    await page.waitForTimeout(200);
    expect(asked).toBe(1);
    await expect(card(page)).toHaveCount(0);
    expect(await page.evaluate(`(document.getElementById('toast-container')||{}).textContent||''`)).toBe('');
    await expect(page.locator('#hub-body')).not.toContainText('Try again');
  });

  test('the card\'s read leaves beside the feed\'s, on a first open with nothing kept on the phone too', async ({ page }) => {
    const today = '2026-11-13';
    await page.clock.setFixedTime(new Date(`${today}T18:00:00+03:00`));
    await stubSupabase(page, { sessions: [sess('2099-01-03')], customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true });
    const st = await planServer(page, NOV, today, ['2026-11-21']);
    let release: () => void = () => {};
    const held = new Promise<void>((ok) => { release = ok; });
    await page.route(/\/rest\/v1\/rpc\/hub_feed$/, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await held;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed(today)) });
    });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'female' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('members')`);
    await expect.poll(() => st.reads).toBe(1); // asked while the feed is still on its way
    await expect(page.locator('#hub-body .hub-hero')).toHaveCount(0);
    release();
    await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
    await expect(boxes(page)).toHaveCount(4);
    expect(await ticked(page)).toEqual(['21']);
    expect(st.reads).toBe(1);
  });

  test('an answer that is not the plan (a refusal, an empty one) draws no card either', async ({ page }) => {
    await member(page, { plan: false, fx: { 'rpc:hub_plan': { ok: false, error: 'member' } } });
    await expect(page.locator('#hub-body .hub-card', { hasText: 'Your challenge' })).toBeVisible();
    await page.waitForTimeout(200);
    await expect(card(page)).toHaveCount(0);
    expect(await page.evaluate(`(document.getElementById('toast-container')||{}).textContent||''`)).toBe('');
  });

  test('a month with five Saturdays fits a narrow phone: one row, nothing off the side', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await member(page, { at: '2026-10-02T09:00:00+03:00', sats: OCT });
    await expect(boxes(page)).toHaveCount(5);
    await expect(boxes(page)).toHaveText(['3', '10', '17', '24', '31']);
    await expect(card(page).locator('.hub-name')).toHaveText('October');
    const geo = await card(page).evaluate((el) => {
      const c = el.getBoundingClientRect();
      const b = [...el.querySelectorAll('.hub-sat')].map((x) => x.getBoundingClientRect());
      return { inside: b.every((r) => r.left >= c.left && r.right <= c.right), oneRow: new Set(b.map((r) => Math.round(r.top))).size === 1, minH: Math.min(...b.map((r) => r.height)), minW: Math.min(...b.map((r) => r.width)), side: document.documentElement.scrollWidth <= window.innerWidth };
    });
    expect(geo.inside).toBe(true);
    expect(geo.oneRow).toBe(true);
    expect(geo.side).toBe(true);
    expect(geo.minH).toBeGreaterThanOrEqual(44);
    expect(geo.minW).toBeGreaterThanOrEqual(40);
  });

  test('its own words in all ten languages, and the card in Arabic', async ({ page }) => {
    await member(page);
    expect(await page.evaluate(`HUB_T.plan.length===10&&HUB_T.plan.every(x=>String(x).trim())&&new Set(HUB_T.plan).size===10`)).toBe(true);
    expect(await page.evaluate(`HUB_T.plan.filter(x=>/[\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F\\u09E6-\\u09EF]/.test(x))`)).toEqual([]);
    await page.evaluate(`setLang('ar')`);
    await expect(card(page).locator('.hub-k')).toHaveText(/خطتي لأيام السبت/);
    await expect(card(page).locator('.hub-name')).toHaveText('نوفمبر');
    await expect(boxes(page)).toHaveText(['7', '14', '21', '28']); // Latin digits in every language
    await expect(boxes(page).nth(2)).toHaveAccessibleName(/السبت/);
  });
});

test.describe('@customer:members F10 Plan my Saturdays: the database\'s rules', () => {
  const sql = readFileSync(resolve(__dirname, '../supabase/migrations/20261114081000_plan_saturdays.sql'), 'utf8');
  const code = sql.replace(/^\s*--.*$/gm, ''); // the statements, without the comments
  const fn = (name: string) => {
    const a = code.indexOf(`create or replace function public.${name}(`);
    expect(a, name).toBeGreaterThan(-1);
    const b = code.indexOf('end $$;', a);
    return code.slice(a, b);
  };

  test('private: nobody can read the table, and only the member\'s own token-checked read returns their ticks', () => {
    expect(code).toContain('alter table public.hub_plans enable row level security;');
    expect(code).toContain('revoke all on public.hub_plans from public, anon, authenticated;');
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/grant [^;]* on (table )?public\.hub_plans/i);
    // the only functions that touch the table: the member's read, the member's write, and the job
    const made = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]!);
    expect(made.sort()).toEqual(['_hub_plan_tick', '_hub_plan_window_open', 'hub_plan', 'hub_plan_set']);
    expect(made.filter((n) => fn(n).includes('hub_plans')).sort()).toEqual(['_hub_plan_tick', 'hub_plan', 'hub_plan_set']);
    for (const n of ['hub_plan', 'hub_plan_set']) {
      const f = fn(n), body = f.slice(f.indexOf('begin'));
      expect(body.trimStart().slice(5).trimStart(), n).toMatch(/^if p_id is null or p_token is null or not _cust_token_ok\(p_id, p_token\) then return jsonb_build_object\('ok', false, 'error', 'denied'\); end if;\s+if not _member_active\(p_id\) then return jsonb_build_object\('ok', false, 'error', 'member'\); end if;/);
      expect(f, n).toContain('security definer');
      // every row it reads or removes is one of the caller's own accounts'
      const reads = [...f.matchAll(/hub_plans(?: p)? where ([^;]{0,48})/g)].map((m) => m[1]!);
      expect(reads.length, n).toBeGreaterThan(0);
      for (const w of reads) expect(w, n).toMatch(/^(p\.)?customer_id = any\((v_accts\)|_accts_of\(p_id\)\))/);
    }
    expect(fn('hub_plan')).not.toMatch(/customers|name|phone|count\(/); // their own ticks, nobody else's, no totals
    expect(code).toContain('revoke all on function public.hub_plan(text, text) from public;');
    expect(code).toContain('grant execute on function public.hub_plan(text, text) to anon, authenticated;');
    expect(code).toContain('grant execute on function public.hub_plan_set(text, text, text, boolean) to anon, authenticated;');
    for (const h of ['_hub_plan_tick()', '_hub_plan_window_open(date)']) expect(code, h).toContain(`revoke all on function public.${h} from public, anon, authenticated;`);
  });

  test('a tick books nothing, and a Saturday gone or outside the month is refused', () => {
    expect(code).not.toMatch(/(insert into|update|delete from)\s+(public\.)?(queue_entries|sessions)\b/i);
    const f = fn('hub_plan_set');
    expect(f).toContain("if v_day < v_today then return jsonb_build_object('ok', false, 'error', 'past'); end if;");
    expect(f).toContain("if extract(isodow from v_day) <> 6 or v_day < v_month or v_day >= (v_month + interval '1 month')::date then");
    expect(f.indexOf("'error', 'past'")).toBeLessThan(f.indexOf('insert into hub_plans'));
    expect(f.indexOf("'error', 'past'")).toBeLessThan(f.indexOf('delete from hub_plans'));
    expect(f).toContain('on conflict (customer_id, plan_date) do nothing');
    // the read lists the current month's Saturdays and marks the ones gone; nothing is ticked that has no row
    const r = fn('hub_plan');
    expect(r).toContain('where extract(isodow from g.d) = 6');
    expect(r).toContain("'past', g.d < v_today");
    expect(r).toContain("'on', exists (select 1 from hub_plans p where p.customer_id = any(v_accts) and p.plan_date = g.d)");
    expect(code).toContain('check (extract(isodow from plan_date) = 6)');
  });

  test('the message is queued once per ticked Saturday, when that Saturday\'s ride is open to riders', () => {
    const f = fn('_hub_plan_tick');
    // only ticks not yet told, on Saturdays not yet gone
    expect(f).toContain('from hub_plans p where p.told_at is null and p.plan_date >= v_today');
    expect(f).toContain('where p.plan_date = d.plan_date and p.told_at is null');
    // "booking is open": inside the booking window, and the Saturday ride open, not a draft, not cancelled, not started
    expect(f).toContain('if not _hub_plan_window_open(d.plan_date) then continue; end if;');
    const ride = f.slice(f.indexOf('if not exists (select 1 from sessions x cross join lateral _session_window(x) w'), f.indexOf('for r in select'));
    for (const c of ["x.ride_kind = 'saturday'", 'x.session_date = v_date', "x.status = 'open'", 'not coalesce(x.draft, false)', 'x.cancelled_at is null', "x.ride_status is distinct from 'cancelled'", 'w.starts_at > now()']) expect(ride, c).toContain(c);
    expect(ride).toMatch(/\) then\s+continue;\s+end if;/);
    expect(f).toContain("v_date := to_char(d.plan_date, 'YYYY-MM-DD');");
    // one row per member and Saturday in the message store, whatever happens to the tick afterwards
    expect(f).toContain("'hub-plan-' || to_char(d.plan_date, 'YYYYMMDD')");
    expect(f).toContain('on conflict (customer_id, tag) do nothing;');
    expect(f.match(/insert into push_outbox/g)).toHaveLength(1);
    const ins = f.indexOf('insert into push_outbox'), told = f.lastIndexOf('update hub_plans set told_at = now() where customer_id = r.customer_id and plan_date = d.plan_date;');
    expect(told).toBeGreaterThan(ins); // told once the row is written: the next run skips this tick
    // through the message store the Updates list reads: Community's category, the words' key and the day
    expect(f).toContain("'/members?src=push', 'community', 'planopen', array[v_day])");
    expect(f).toContain("insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)");
    expect(f).not.toMatch(/push_subscriptions|push_prefs/); // written with push on or off: the gate decides the push
    // by day, never at night
    expect(f).toContain('if extract(hour from v_ksa) < 7 or extract(hour from v_ksa) >= 23 then return 0; end if;');
    expect(code).toContain("select cron.schedule('mm-hub-plan', '*/10 * * * *', 'select public._hub_plan_tick()');");
    // the window is read as the booking guard reads it
    const w = fn('_hub_plan_window_open');
    expect(w).toContain("select value into w from site_content where key = 'booking.window';");
    expect(w).toContain('open_day := p_day - days;');
    expect(w).toContain('if open_day > today then return false; end if;');
  });

  test('never for a member who has already booked it: marked told, with no message', () => {
    const f = fn('_hub_plan_tick');
    const booked = f.indexOf('if exists (select 1 from queue_entries q join sessions x on x.id = q.session_id'), ins = f.indexOf('insert into push_outbox');
    expect(booked).toBeGreaterThan(-1);
    expect(booked).toBeLessThan(ins);
    const branch = f.slice(booked, ins);
    expect(branch).toContain("where x.ride_kind = 'saturday' and x.session_date = v_date"); // that Saturday's ride, whichever session of it
    expect(branch).toContain('and q.customer_id = any(_accts_of(r.to_id))');
    expect(branch).toContain("coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')");
    expect(branch).toMatch(/update hub_plans set told_at = now\(\) where customer_id = r\.customer_id and plan_date = d\.plan_date;\s+continue;\s+end if;/);
    // and only for members
    expect(f).toContain('if not _member_active(r.to_id) then continue; end if;');
    expect(f.indexOf('if not _member_active(r.to_id) then continue; end if;')).toBeLessThan(ins);
  });

  test('the words in all ten languages, the ledger row, the drift check, and nobody else\'s function redefined', () => {
    const langs = [...sql.matchAll(/\('planopen', '([a-z]{2})', '([^']+)', '([^']+)'\)/g)];
    expect(langs.map((m) => m[1]).sort()).toEqual(['ar', 'bn', 'en', 'es', 'fr', 'hi', 'ne', 'pt', 'tl', 'ur']);
    for (const m of langs) { expect(m[2]!.trim(), m[1]).not.toBe(''); expect(m[3], m[1]).toContain('{0}'); expect(m[3], m[1]).not.toContain('{1}'); }
    expect(new Set(langs.map((m) => m[2])).size).toBe(10); // ten titles, each its own
    expect(new Set(langs.map((m) => m[3])).size).toBe(10);
    expect(sql).not.toMatch(new RegExp('[\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F\\u09E6-\\u09EF]'));
    expect(code).toContain("values ('20261114081000', 'plan_saturdays')");
    expect(code).toMatch(/^begin;/m);
    expect(code).toMatch(/^commit;/m);
    expect(code).toContain("notify pgrst, 'reload schema';");
    expect(code).not.toMatch(/function public\.(hub_feed|hub_pulse|_hub_tick|_hub_push_tick|_push_outbox_gate|customer_updates|customer_updates_unread)\(/);
    const checks = readFileSync(resolve(__dirname, '../supabase/checks/security-attributes.sql'), 'utf8');
    for (const n of ['hub_plan', 'hub_plan_set', '_hub_plan_window_open', '_hub_plan_tick']) expect(checks, n).toContain(`('${n}', true, 'Plan my Saturdays`);
  });
});
