import { test, expect, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { stubSupabase, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Going and first-timer counts (new features build F19, 2026-11-13), then taken off the page the same day (the user:
// "dont mention this to customers 216 going · 48 first-timers", with the club-in-numbers card: riders last Saturday,
// Saturday rides this month, Saturday rides since the start). The database may still send hub_feed's `going` and
// `numbers` (migration 20261114081900 stays applied); the page reads neither, so no customer screen shows a head count.
// All Supabase traffic is stubbed; the function's own rules are still read from the migration's text below.

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
// What the read may still carry: head counts for every date, and the club's totals (the user's own figures of 2026-11-13).
const going = { [A]: { n: 216, first: 48 }, [B]: { n: 216, first: 48 }, [C]: { n: 216, first: 48 } };
const numbers = { last: '2026-11-08', last_riders: 137, last_rides: 137, month: 137, all: 1712, since: '2026-06' };
const COUNT = /\b216\b|\b48\b|\b137\b|1712|1,712|\bgoing\b|first-timers|in numbers|Riders last Saturday|Saturday rides since/i;

test.describe('@customer:members no head counts for customers', () => {
  test('the next session to book carries no going or first-timer count, and the tab has no club-in-numbers card', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await member(page, { 'rpc:hub_feed': feed({ going, numbers }) });
    await expect(hero(page)).toContainText('Next session to book');
    await expect(hero(page).locator('button', { hasText: 'Book' })).toBeVisible();
    await expect(page.locator('#hub-body .hub-soon')).toHaveCount(2);
    await expect(page.locator('.hub-going, [data-go]')).toHaveCount(0);
    await expect(page.locator('#hub-body')).not.toContainText(COUNT);
    expect(await page.evaluate(`typeof _hubGoing + typeof _numsHtml + ['going','firstT','nums','numLast','numMonth','numAll'].filter(k=>k in HUB_T).join()`)).toBe('undefinedundefined');
    expect(errors).toEqual([]);
  });

  test('the member\'s own booked session carries none either', async ({ page }) => {
    const mine = booking('q1', B);
    await member(page, { queue_entries: [mine], 'rpc:my_bookings': [mine], 'rpc:hub_feed': feed({ going, numbers }) });
    await expect(hero(page)).toContainText('Your next session');
    await expect(hero(page)).toContainText('Show ticket');
    await expect(page.locator('#hub-body')).not.toContainText(COUNT);
  });

  test('nothing on the Experiences card, the Reserve screens or Bookings', async ({ page }) => {
    const mine = booking('q1', C);
    await member(page, { queue_entries: [mine], 'rpc:my_bookings': [mine], 'rpc:hub_feed': feed({ going, numbers }) });
    const clean = async (sel: string) => {
      await expect(page.locator(`${sel} .hub-going, ${sel} [data-go]`)).toHaveCount(0);
      await expect(page.locator(sel)).not.toContainText(/\b216\b|\b48\b|\bgoing\b|first-timers/i);
    };
    await clean('#hub-body');
    await page.evaluate(`goLanding()`);
    await expect(page.locator('#land-events .landing-event-card.ev-community')).toHaveCount(1);
    await clean('#view-landing');
    await page.locator('#land-events .landing-event-card.ev-community').click();
    await expect.poll(() => page.evaluate('[S.view,S.custTab,S.selEvent]')).toEqual(['customer', 'register', 'community']);
    await expect(page.locator('#tab-register .sess-card').first()).toBeVisible();
    await clean('#tab-register');
    await page.evaluate(`selectSessCard('${A}')`);
    await expect.poll(() => page.evaluate('S.selSession')).toBe(A);
    await clean('#tab-register');
    await clean('#confirm-modal');
    await page.evaluate(`setCustTab('myrides')`);
    await expect(page.locator('#tab-myrides .ticket-card').first()).toBeVisible();
    await clean('#tab-myrides');
  });

  test('in every language: no count on the card in Arabic, Urdu, French, Bengali or Nepali', async ({ page }) => {
    await member(page, { 'rpc:hub_feed': feed({ going, numbers }) });
    for (const [lang, a, b] of [['ar', 'سيحضرون', 'يشاركون لأول مرة'], ['ur', 'آ رہے ہیں', 'پہلی بار'], ['fr', 'participants', 'nouveaux venus'], ['bn', 'জন আসছেন', 'জন প্রথমবার'], ['ne', 'जना आउँदै', 'जना पहिलो पटक']] as const) {
      await page.evaluate(`setLang('${lang}');setCustTab('members')`);
      await expect(hero(page)).toBeVisible();
      await expect(page.locator('#hub-body')).not.toContainText(a);
      await expect(page.locator('#hub-body')).not.toContainText(b);
      await expect(page.locator('#hub-body')).not.toContainText(/216|1712/);
    }
  });
});

// The database's side, read from the migration's text: the same rules, held there first.
test.describe('@customer:members F19 the migration', () => {
  const FILE = 'supabase/migrations/20261114081900_hub_going.sql';
  const sql = readFileSync(FILE, 'utf8');
  const block = (text: string, from: string, to: string) => { const a = text.indexOf(from), b = text.indexOf(to, a); expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); return text.slice(a, b + to.length); };
  const going = block(sql, 'create or replace function public._hub_going()', 'revoke all on function public._hub_going() from public, anon, authenticated;');

  test('one file with this number; transaction, ledger row, schema reload and a read-only check', () => {
    expect(readdirSync('supabase/migrations').filter((f) => f.startsWith('20261114081900'))).toEqual(['20261114081900_hub_going.sql']);
    expect(sql).toMatch(/\nbegin;\n/);
    expect(sql).toMatch(/insert into supabase_migrations\.schema_migrations \(version, name\)\s+values \('20261114081900', 'hub_going'\)\s+on conflict \(version\) do nothing;\s+commit;\s+notify pgrst, 'reload schema';/);
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
