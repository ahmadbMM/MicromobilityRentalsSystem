import { test, expect, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { stubSupabase, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Going and first-timer counts (new features build F19, 2026-11-13). The Community tab's next-session card, and only that
// card, says "N going" and "N first-timers" for the session it shows. Each number only at 10 or more (under 10 it is
// simply absent), only once the session is published (its list no longer hidden) and open for booking. The numbers ride
// in the tab's one read (hub_feed's `going`, keyed by session: migration 20261114011900); no names, no list. The owner
// refused any count on the Experiences card and the Reserve screens. All Supabase traffic is stubbed; the function's own
// rules are read from the migration's text (no spec reaches a database).

const A = '2099-01-03', B = '2099-01-10', C = '2099-01-17';
// A Saturday Social Ride as staff make it (needs approval, list hidden), here already published: hide_queue false.
const sess = (id: string, o: Record<string, unknown> = {}) => ({ id, day: 'Saturday', session_date: id.slice(0, 10), capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}', ...o });
const open = [sess(A), sess(B), sess(C)];
const feed = (o: Record<string, unknown> = {}) => ({
  ok: true, today: '2026-11-13',
  me: { kind: 'first', levels: [1], target: 1, chosen: false, n: 0, ends_on: '2026-11-30', sats: 4 },
  club: null, goals: [], numbers: { last: null, last_riders: null, last_rides: null, month: null, all: null, since: null },
  post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null, ...o,
});
const booking = (id: string, sid: string, o: Record<string, unknown> = {}) => ({ id, session_id: sid, session_date: sid.slice(0, 10), session_day: 'Saturday', customer_id: 'c1', name: 'Lina Haddad', queue_num: 4, status: 'waiting', approval: 'approved', paid: false, price: 0, type_preference: 'Road', created_at: 1, ...o });
async function member(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: open, customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed(), ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'male' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
}
const hero = (page: Page) => page.locator('#hub-body .hub-hero');
const line = (page: Page) => page.locator('#hub-body .hub-going');
// The read's answer swapped on the page and the tab painted again from it (no second read: the copy is fresh).
const repaint = (page: Page, going: unknown) => page.evaluate(`S._hub.d.going=${JSON.stringify(going)};_hubRender()`);

test.describe('@customer:members F19 going and first-timer counts', () => {
  test('the next session to book says how many are going and how many come for the first time', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await member(page, { 'rpc:hub_feed': feed({ going: { [A]: { n: 34, first: 12 } } }) });
    await expect(hero(page)).toContainText('Next session to book');
    await expect(line(page)).toHaveCount(1);
    await expect(hero(page).locator('.hub-going')).toHaveText('34 going · 12 first-timers');
    await expect(line(page).locator('[data-go="going"]')).toHaveText('34 going');
    await expect(line(page).locator('[data-go="firstT"]')).toHaveText('12 first-timers');
    // totals only: nothing to tap, no link, no list, no name
    await expect(line(page).locator('a, button, li, img')).toHaveCount(0);
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('the member\'s own booked session carries its counts', async ({ page }) => {
    const mine = booking('q1', B);
    await member(page, { queue_entries: [mine], 'rpc:my_bookings': [mine], 'rpc:hub_feed': feed({ going: { [A]: { n: 77, first: 21 }, [B]: { n: 41, first: 15 } } }) });
    await expect(hero(page)).toContainText('Your next session');
    await expect(line(page)).toHaveCount(1);
    await expect(hero(page).locator('.hub-going')).toHaveText('41 going · 15 first-timers'); // the card's own session, not the earlier one
    await expect(page.locator('#hub-body')).not.toContainText('77');
  });

  test('each number is hidden under 10', async ({ page }) => {
    await member(page, { 'rpc:hub_feed': feed({ going: { [A]: { n: 34 } } }) }); // the read left the small one out
    await expect(line(page)).toHaveText('34 going');
    await expect(line(page).locator('[data-go="firstT"]')).toHaveCount(0);
    await expect(hero(page)).not.toContainText('first-timers');
    // The page holds the rule too: an answer that carried a small number still shows none of it.
    await repaint(page, { [A]: { n: 34, first: 9 } });
    await expect(line(page)).toHaveText('34 going');
    await repaint(page, { [A]: { n: 9, first: 4 } });
    await expect(line(page)).toHaveCount(0);
    await expect(hero(page)).not.toContainText(/going|first-timers/);
    await repaint(page, { [A]: { n: 10, first: 10 } }); // ten is shown
    await expect(line(page)).toHaveText('10 going · 10 first-timers');
    await repaint(page, { [A]: { n: 9, first: 12 } });
    await expect(line(page)).toHaveText('12 first-timers'); // each number on its own
    for (const bad of [{ [A]: {} }, { [A]: null }, { [A]: { n: '34 riders', first: -20 } }, {}, null, 'x', [34, 12]]) {
      await repaint(page, bad);
      await expect(line(page)).toHaveCount(0);
    }
    await expect(hero(page)).toBeVisible();
  });

  test('only a published session that is open for booking shows them', async ({ page }) => {
    const going = { [A]: { n: 34, first: 12 }, [B]: { n: 41, first: 15 } };
    const mine = booking('q1', A);
    // Booked on a Saturday ride staff have not published yet: the read may hold a number, the card shows none.
    await member(page, { sessions: [sess(A, { hide_queue: true }), sess(B), sess(C)], queue_entries: [mine], 'rpc:my_bookings': [mine], 'rpc:hub_feed': feed({ going }) });
    await expect(hero(page)).toContainText('Your next session');
    await expect(hero(page)).toContainText('Show ticket');
    await expect(line(page)).toHaveCount(0);
    await expect(page.locator('#hub-body')).not.toContainText(/\d+ going|first-timers/);
    // The rule itself, state by state, on the page's own copy of a session (the same answer from the read each time).
    const shown = await page.evaluate(`(()=>{
      const s=S.sessions.find(x=>x.id==='${B}'),on=(o)=>_hubGoing({...s,...o})!=='';
      const un={...s};delete un.hide_queue;
      const out={published:on({}),hidden:on({hide_queue:true}),unsaid:_hubGoing(un)!=='',nullish:on({hide_queue:null}),
        full:on({status:'full'}),closed:on({status:'closed'}),deleted:on({status:'deleted'}),
        past:on({session_date:'2020-01-04'}),notCommunity:on({event_kind:null,ride_kind:null}),snd:on({ride_kind:'snd96'}),
        paidRide:on({needs_approval:false,ride_kind:'petromin',paid_ride:true}),pool:on({ride_kind:'swim'}),none:_hubGoing(null)!==''};
      const keep=S._bw;S._bw={days:7,at:null};out.windowShut=on({});S._bw=keep;out.windowOpen=on({});
      return out;})()`);
    expect(shown).toEqual({
      published: true, hidden: false, unsaid: false, nullish: false, // published = the list is no longer hidden
      full: false, closed: false, deleted: false, // open for booking
      past: false, notCommunity: false, snd: false,
      paidRide: true, pool: true, // any published community session, by whatever name
      none: false, windowShut: false, windowOpen: true, // bookings open a week before: 2099 is not open yet
    });
  });

  test('a session that is over shows none', async ({ page }) => {
    const mine = booking('q1', '2026-11-07', { status: 'done', rating_detail: { overall: 5 } });
    await page.clock.setFixedTime(new Date('2026-11-13T18:00:00+03:00'));
    await member(page, { sessions: [sess('2026-11-07'), ...open], queue_entries: [mine], 'rpc:my_bookings': [mine], 'rpc:hub_feed': feed({ going: { '2026-11-07': { n: 90, first: 30 }, [A]: { n: 34, first: 12 } } }) });
    await expect(hero(page)).toContainText('Next session to book');
    await expect(line(page)).toHaveText('34 going · 12 first-timers');
    await expect(page.locator('#hub-body')).not.toContainText('90 going');
    expect(await page.evaluate(`_hubGoing(S.sessions.find(x=>x.id==='2026-11-07'))`)).toBe('');
  });

  test('only the next-session card: Coming up and the rest of the tab carry none', async ({ page }) => {
    await member(page, { 'rpc:hub_feed': feed({ going: { [A]: { n: 34, first: 12 }, [B]: { n: 137, first: 113 }, [C]: { n: 137, first: 113 } } }) });
    await expect(page.locator('#hub-body .hub-soon')).toHaveCount(2);
    await expect(page.locator('.hub-going')).toHaveCount(1);
    await expect(page.locator('#hub-body .hub-hero .hub-going')).toHaveCount(1);
    await expect(page.locator('#hub-body')).not.toContainText(/137|113/);
    expect(await page.evaluate(`[...document.querySelectorAll('#hub-body *')].filter(x=>!x.closest('.hub-hero')&&/going|first-timers/i.test(x.textContent||'')).length`)).toBe(0);
  });

  test('nothing on the Experiences card, the Reserve screens or Bookings', async ({ page }) => {
    const mine = booking('q1', C);
    const going = { [A]: { n: 137, first: 113 }, [B]: { n: 137, first: 113 }, [C]: { n: 137, first: 113 } };
    await member(page, { queue_entries: [mine], 'rpc:my_bookings': [mine], 'rpc:hub_feed': feed({ going }) });
    await expect(line(page)).toHaveText('137 going · 113 first-timers'); // the read is in and the tab shows it
    const clean = async (sel: string) => {
      await expect(page.locator(`${sel} .hub-going, ${sel} [data-go]`)).toHaveCount(0);
      await expect(page.locator(sel)).not.toContainText(/137|113|\bgoing\b|first-timers/i);
    };
    // the Experiences cards (the first page's list of what can be booked)
    await page.evaluate(`goLanding()`);
    await expect(page.locator('#land-events .landing-event-card').first()).toBeVisible();
    await expect(page.locator('#land-events .landing-event-card.ev-community')).toHaveCount(1);
    await clean('#view-landing');
    // Reserve: the Saturday ride opened from its card, its dates listed, and one date picked
    await page.locator('#land-events .landing-event-card.ev-community').click();
    await expect.poll(() => page.evaluate('[S.view,S.custTab,S.selEvent]')).toEqual(['customer', 'register', 'community']);
    await expect(page.locator('#tab-register .sess-card').first()).toBeVisible();
    await clean('#tab-register');
    await page.evaluate(`selectSessCard('${A}')`);
    await expect.poll(() => page.evaluate('S.selSession')).toBe(A);
    await clean('#tab-register');
    await clean('#confirm-modal');
    // Bookings: the ticket of the booked session
    await page.evaluate(`setCustTab('myrides')`);
    await expect(page.locator('#tab-myrides .ticket-card').first()).toBeVisible();
    await clean('#tab-myrides');
    // and the tab's own line is the only one in the whole page
    await expect(page.locator('.hub-going')).toHaveCount(1);
    expect(await page.evaluate(`[...document.querySelectorAll('.hub-going')].every(x=>!!x.closest('#hub-body .hub-hero'))`)).toBe(true);
  });

  test('one read: the counts come with hub_feed and no other request is made for them', async ({ page }) => {
    const fns: string[] = [];
    page.on('request', (r) => { const m = /\/rest\/v1\/rpc\/([a-z_0-9]+)/.exec(r.url()); if (m) fns.push(m[1]); });
    await member(page, { 'rpc:hub_feed': feed({ going: { [A]: { n: 34, first: 12 } } }) });
    await expect(line(page)).toHaveText('34 going · 12 first-timers');
    expect(fns.filter((f) => f === 'hub_feed')).toHaveLength(1);
    expect(fns.filter((f) => /going|first/.test(f))).toEqual([]);
    // kept on the phone with the rest of the read, so the tab paints with it at once next time
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_hub_c1')).d.going['${A}']`)).toEqual({ n: 34, first: 12 });
  });

  test('a database before the migration: the card as it was, no count and no error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await member(page); // hub_feed answers without `going`
    await expect(hero(page)).toContainText('Next session to book');
    await expect(hero(page).locator('button', { hasText: 'Book' })).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    await expect(page.locator('#hub-body')).not.toContainText(/\d+ going|first-timers/);
    await expect(page.locator('#hub-body [role="status"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('all ten languages, Latin digits; Arabic and Urdu read right to left', async ({ page }) => {
    await member(page, { 'rpc:hub_feed': feed({ going: { [A]: { n: 34, first: 12 } } }) });
    const rows = await page.evaluate(`['going','firstT'].map(k=>[k,(HUB_T[k]||[]).length,(HUB_T[k]||[]).every(x=>String(x).trim()&&x.includes('{0}')&&!/\\p{Extended_Pictographic}/u.test(x)&&!/[0-9\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F\\u09E6-\\u09EF]/.test(x.replace('{0}','')))])`);
    expect(rows).toEqual([['going', 10, true], ['firstT', 10, true]]);
    // nine translations, none left in English
    expect(await page.evaluate(`['going','firstT'].map(k=>new Set(HUB_T[k]).size>=9&&HUB_T[k].slice(1).every(x=>x!==HUB_T[k][0]))`)).toEqual([true, true]);
    // no count wording says ride, bike or cycling: the card also names the pool, a workshop and other sessions
    expect(await page.evaluate(`['going','firstT'].every(k=>!/ride|bike|cycl/i.test(HUB_T[k][0]))`)).toBe(true);
    for (const [lang, a, b] of [['ar', '34 سيحضرون', '12 يشاركون لأول مرة'], ['ur', '34 آ رہے ہیں', '12 پہلی بار'], ['fr', '34 participants', '12 nouveaux venus'], ['bn', '34 জন আসছেন', '12 জন প্রথমবার'], ['ne', '34 जना आउँदै', '12 जना पहिलो पटक']] as const) {
      await page.evaluate(`setLang('${lang}');setCustTab('members')`);
      await expect(line(page).locator('[data-go="going"]')).toHaveText(a);
      await expect(line(page).locator('[data-go="firstT"]')).toHaveText(b);
      expect(await page.evaluate(`getComputedStyle(document.querySelector('#hub-body .hub-going')).direction`)).toBe(lang === 'ar' || lang === 'ur' ? 'rtl' : 'ltr');
      expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
    }
  });
});

// The database's side, read from the migration's text: the same rules, held there first.
test.describe('@customer:members F19 the migration', () => {
  const FILE = 'supabase/migrations/20261114011900_hub_going.sql';
  const sql = readFileSync(FILE, 'utf8');
  const block = (text: string, from: string, to: string) => { const a = text.indexOf(from), b = text.indexOf(to, a); expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); return text.slice(a, b + to.length); };
  const going = block(sql, 'create or replace function public._hub_going()', 'revoke all on function public._hub_going() from public, anon, authenticated;');

  test('one file with this number; transaction, ledger row, schema reload and a read-only check', () => {
    expect(readdirSync('supabase/migrations').filter((f) => f.startsWith('20261114011900'))).toEqual(['20261114011900_hub_going.sql']);
    expect(sql).toMatch(/\nbegin;\n/);
    expect(sql).toMatch(/insert into supabase_migrations\.schema_migrations \(version, name\)\s+values \('20261114011900', 'hub_going'\)\s+on conflict \(version\) do nothing;\s+commit;\s+notify pgrst, 'reload schema';/);
    expect(sql).not.toMatch(/\bcreate table\b|\balter table\b|\binsert into public\.|\bupdate public\.|\bdelete from\b/i); // no table changes, no data written
    expect(readFileSync('supabase/checks/security-attributes.sql', 'utf8')).toContain(`('_hub_going', true,`);
  });

  test('totals of 10 or more only, for published sessions open for booking; nothing about any one rider', () => {
    expect(going).toContain('language plpgsql stable security definer set search_path to \'public\'');
    // each number under 10 is left out; a session with neither is left out whole
    expect(going).toContain(`'n', case when z.n >= 10 then z.n end`);
    expect(going).toContain(`'first', case when z.f >= 10 then z.f end`);
    expect(going).toContain('jsonb_strip_nulls(');
    expect(going).toContain('where z.n >= 10 or z.f >= 10;');
    // a community session, published, open for booking, not over, inside the booking window
    expect(going).toContain(`s.event_kind = 'community' and s.ride_kind is distinct from 'snd96'`);
    expect(going).toContain('s.hide_queue is false');
    expect(going).toContain('s.required_tag_id is null'); // a private (tag-gated) ride is never counted, not even said to exist
    expect(going).toContain(`s.status = 'open' and s.cancelled_at is null and s.ride_status is distinct from 'cancelled'`);
    expect(going).toContain('s.session_date >= v_today');
    expect(going).toContain(`where key = 'booking.window'`);
    // going: bookings holding a place, approved where the session needs approval
    expect(going).toContain(`q.status in ('waiting', 'active', 'done')`);
    expect(going).toContain(`when s.needs_approval is distinct from false then q.approval is not distinct from 'approved'`);
    expect(going).toContain(`else q.approval is distinct from 'rejected'`);
    // first-timers: an account with no finished community session before this one, once
    expect(going).toContain('count(distinct g.customer_id) filter (where g.is_first)');
    expect(going).toMatch(/q\.customer_id is not null and not exists \(\s+select 1 from queue_entries q2 join sessions s2 on s2\.id = q2\.session_id\s+where q2\.customer_id = q\.customer_id and q2\.status = 'done' and s2\.event_kind = 'community'\s+and s2\.session_date < s\.session_date\)/);
    // members see nobody: the answer is keyed by session and holds two integers; no customer column leaves the function
    expect(going).toContain('jsonb_object_agg(z.id,');
    expect(going).not.toMatch(/\bcustomers\b|\.name\b|phone|email|photo|title|badge/i);
    const answer = going.slice(going.indexOf('select jsonb_object_agg('), going.indexOf('into v_out'));
    expect(answer).toContain(`'n', case when z.n >= 10 then z.n end`);
    expect(answer).not.toMatch(/customer|\bq\.|\bg\./); // an account is read to count it, never answered
    // a helper: nobody calls it but hub_feed
    expect(sql).toContain('revoke all on function public._hub_going() from public, anon, authenticated;');
    expect(sql).not.toMatch(/grant execute on function public\._hub_going/);
  });

  test('hub_feed is the reach build\'s own, with one added key', () => {
    const FROM = 'create or replace function public.hub_feed(p_id text, p_token text, p_src text default null)';
    const TO = 'grant execute on function public.hub_feed(text, text, text) to anon, authenticated;';
    const reach = readdirSync('supabase/migrations').find((f) => f.endsWith('_community_reach.sql'))!; // its number moved on main
    const before = block(readFileSync('supabase/migrations/' + reach, 'utf8'), FROM, TO);
    const after = block(sql, FROM, TO);
    expect(after).toContain(`    'year', v_year_doc,\n    'going', _hub_going());`);
    expect(after.replace(`    'year', v_year_doc,\n    'going', _hub_going());`, `    'year', v_year_doc);`)).toBe(before);
    // still token-checked and for active members before anything is read
    expect(after).toContain(`if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;`);
    expect(after.indexOf('_member_active(p_id)')).toBeLessThan(after.indexOf('_hub_going()'));
    expect(sql).toContain('revoke all on function public.hub_feed(text, text, text) from public;');
    expect(sql.indexOf('create or replace function public._hub_going()')).toBeLessThan(sql.indexOf(FROM));
  });
});
