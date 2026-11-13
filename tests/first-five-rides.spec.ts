import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, rateGateOn, type Fixtures } from './helpers/supabase';

// The first five rides (new features build F1, the owner 2026-11-13). A rider with fewer than five rides ridden, counted
// as the ride tier counts them, is on one path of five marks. The rating pop-up's last screen shows it in place of the
// month's challenge, to members and non-members, with a Book button when nothing is booked ahead; the Community tab
// shows it in the challenge's slot; the Saturday ladder has steps at 2 and 3 rides. From the fifth ride every screen
// is the reach build's. All Supabase traffic is stubbed.

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const month = today.slice(0, 7);
const AHEAD = '2099-01-03';
const me = (o: Record<string, unknown> = {}) => ({ kind: 'level', target: 4, n: 3, ends_on: `${month}-28`, sats: 4, levels: [2, 3, 4], chosen: true, ...o });
const pulse = (o: Record<string, unknown> = {}) => ({ ok: true, member: true, dot: false, me: me(), goals: [], fresh: [], ...o });
const feed = { ok: true, today, me: me(), club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null };
const circuit = (date: string, o: Record<string, unknown> = {}) => ({ id: 's-' + date, day: 'Friday', session_date: date, capacity: 12, status: 'open', created_at: 1, bike_slots: '{"_time":"18:00 - 20:00","_total":12}', ...o });
const ride = (id: string, date: string, o: Record<string, unknown> = {}) => ({
  id, name: 'Spec Rider', customer_id: 'c1', session_id: 's-' + date, session_day: 'Friday', session_date: date, queue_num: 1,
  status: 'done', paid: true, price: 30, checked_out_at: date + 'T11:00:00Z', registered_at: date + 'T10:00:00Z', ...o,
});
// Rides ridden before the rating page existed (RATE_FROM), so none of them waits to be rated.
const OLD = ['2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25', '2026-08-28', '2026-08-21'];
const before = (n: number) => OLD.slice(0, n).map((d, i) => ride('o' + i, d));
const booked = ride('up1', AHEAD, { status: 'waiting', paid: false, checked_out_at: null });

function rpcLog(page: Page) {
  const out: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rpc\/(\w+)/); if (m) { let b = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ } out.push({ fn: m[1]!, body: b }); } });
  return out;
}
const sent = (log: { fn: string }[], fn: string) => log.filter((x) => x.fn === fn).length;

// A rider with `rides` rides ridden, the last of them today and waiting for its rating.
async function boot(page: Page, rides: number, o: { member?: boolean; ahead?: boolean; fx?: Fixtures; rate?: boolean; last?: Record<string, unknown> } = {}) {
  const log = rpcLog(page);
  const q = [...before(Math.max(0, rides - 1)), ...(rides > 0 ? [ride('q1', today, o.last)] : []), ...(o.ahead ? [booked] : [])];
  await stubSupabase(page, { sessions: [circuit(today), circuit(AHEAD)], queue_entries: q, 'rpc:my_bookings': q, 'rpc:customer_booking_update': true, bikes: [],
    'rpc:community_member': o.member === true, 'rpc:hub_pulse': pulse(), 'rpc:hub_feed': feed, ...(o.fx || {}) });
  if (o.rate !== false) await rateGateOn(page);
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'male' });
  await page.goto('/');
  await waitForSb(page);
  return log;
}
async function rate(page: Page) {
  const m = page.locator('#rate-modal');
  await m.locator('#rgq-service .rg-b[data-v="9"]').click();
  await m.locator('#rgq-bike .rg-b[data-v="9"]').click();
  await m.locator('.pg-btn').click();
  return m;
}

test.describe('@customer:rating the first five rides on the rating\'s last screen', () => {
  test('a non-member with two rides and nothing booked: "2 of 5" on five marks, Book and Done, no Community, no sentence', async ({ page }) => {
    const log = await boot(page, 2);
    const m = await rate(page);
    const fin = m.locator('.rg-fin');
    await expect(fin).toBeVisible();
    await expect(fin.locator('#rate-title')).toHaveText('Your first five rides');
    await expect(fin.locator('.hp-dots i')).toHaveCount(5);
    await expect(fin.locator('.hp-dots i.on')).toHaveCount(2);
    await expect(fin.locator('.rg-fin-n')).toHaveText('2 of 5');
    await expect(fin.locator('[role=progressbar]')).toHaveAttribute('aria-valuetext', '2 of 5');
    await expect(fin.locator('[role=progressbar]')).toHaveAttribute('aria-valuemax', '5');
    await expect(fin.locator('button')).toHaveText(['Book your next ride', 'Done']);
    await expect(fin.locator('p, .rg-fin-k, .rg-fin-medal')).toHaveCount(0); // one thing, no text line
    await expect(page.locator('#toast-live')).toContainText('Thanks for rating your ride.');
    expect(sent(log, 'hub_pulse')).toBe(0); // a non-member is still never asked for the pulse
    // Book: Reserve, with nothing chosen
    await page.evaluate(`S.selSession='s-${AHEAD}';S.regStep=3;S.regQty=3`);
    await fin.locator('button', { hasText: 'Book your next ride' }).click();
    await expect.poll(() => page.evaluate('[!!S._rg,S.view,S.custTab,S.selSession,S.regStep,S.regQty,(S.lastTickets||[]).length]')).toEqual([false, 'customer', 'register', null, 1, 1, 0]);
    await expect(m).toBeHidden();
    await expect(page.locator('#tab-register')).toBeVisible();
  });

  test('the first ride is already one mark; with a booking ahead there is no Book button', async ({ page }) => {
    await boot(page, 1, { ahead: true });
    const fin = (await rate(page)).locator('.rg-fin');
    await expect(fin.locator('#rate-title')).toHaveText('Your first five rides');
    await expect(fin.locator('.hp-dots i.on')).toHaveCount(1);
    await expect(fin.locator('.rg-fin-n')).toHaveText('1 of 5');
    await expect(fin.locator('button')).toHaveText(['Done']);
    await fin.locator('button', { hasText: 'Done' }).click();
    await expect.poll(() => page.evaluate('!!S._rg')).toBe(false);
  });

  test('a member with three rides: the path in place of the month\'s challenge, Book first, then Community and Done', async ({ page }) => {
    const log = await boot(page, 3, { member: true });
    const fin = (await rate(page)).locator('.rg-fin');
    await expect(fin.locator('#rate-title')).toHaveText('Your first five rides'); // not "4 sessions this month"
    await expect(fin.locator('.hp-dots i')).toHaveCount(5);
    await expect(fin.locator('.hp-dots i.on')).toHaveCount(3);
    await expect(fin.locator('.rg-fin-n')).toHaveText('3 of 5');
    await expect(fin.locator('button')).toHaveText(['Book your next ride', 'Community', 'Done']);
    await expect(fin.locator('button', { hasText: 'Community' })).toHaveClass(/rg-fin-2/);
    expect(sent(log, 'hub_pulse')).toBeGreaterThan(0);
    // the outlined button is not the filled one
    const bg = (t: string) => fin.locator('button', { hasText: t }).evaluate((b) => getComputedStyle(b).backgroundColor);
    expect(await bg('Community')).not.toBe(await bg('Book your next ride'));
    await fin.locator('button', { hasText: 'Community' }).click();
    await expect.poll(() => page.evaluate('[!!S._rg,S.custTab]')).toEqual([false, 'members']);
  });

  test('a member with a booking ahead: the path with the screen\'s own two buttons', async ({ page }) => {
    await boot(page, 4, { member: true, ahead: true });
    const fin = (await rate(page)).locator('.rg-fin');
    await expect(fin.locator('.rg-fin-n')).toHaveText('4 of 5');
    await expect(fin.locator('button')).toHaveText(['Community', 'Done']);
    await expect(fin.locator('button', { hasText: 'Community' })).not.toHaveClass(/rg-fin-2/);
    await page.keyboard.press('Escape'); // Escape is Done, as before
    await expect.poll(() => page.evaluate('!!S._rg')).toBe(false);
  });

  test('five rides: a member sees the month\'s challenge exactly as before, with nothing booked too', async ({ page }) => {
    await boot(page, 5, { member: true });
    const fin = (await rate(page)).locator('.rg-fin');
    await expect(fin.locator('#rate-title')).toHaveText('4 sessions this month');
    await expect(fin.locator('.hp-dots i')).toHaveCount(4);
    await expect(fin.locator('.rg-fin-n')).toHaveText('3 / 4');
    await expect(fin.locator('.rg-fin-n')).toHaveAttribute('dir', 'ltr');
    await expect(fin.locator('button')).toHaveText(['Community', 'Done']);
    await expect(fin.locator('.rg-fin-2')).toHaveCount(0);
  });

  test('five rides: a non-member\'s rating closes with its thank-you, as it always did', async ({ page }) => {
    await boot(page, 5);
    const m = await rate(page);
    await expect.poll(() => page.evaluate('!!S._rg')).toBe(false);
    await expect(m.locator('.rg-fin')).toHaveCount(0);
    await expect(page.locator('#toast-live')).toContainText('Thanks for rating your ride.');
  });

  test('a badge the server just gave still comes first, and a rider on the path gets the Book button with it', async ({ page }) => {
    const at = new Date().toISOString();
    const fx: Fixtures = {
      'rpc:hub_pulse': pulse({ fresh: [{ slug: 'challenge_1', at }] }),
      'rpc:customer_my_badges': [{ slug: 'challenge_1', at, name: 'Challenge Met', icon: 'target', color: 'orange', system: true }],
      'rpc:badge_catalog': [{ id: 'bd_challenge_1', slug: 'challenge_1', name: 'Challenge Met', icon: 'target', color: 'orange', system: true, auto: true, description: 'Meet your monthly challenge.' }],
      'rpc:hub_seen': { ok: true, n: 1 },
    };
    await boot(page, 1, { member: true, fx });
    const fin = (await rate(page)).locator('.rg-fin');
    await expect(fin.locator('#rate-title')).toHaveText('Challenge Met');
    await expect(fin.locator('.rg-fin-medal')).toHaveCount(1);
    await expect(fin.locator('[role=progressbar]')).toHaveCount(0);
    await expect(fin.locator('button')).toHaveText(['Book your next ride', 'Community', 'Done']);
  });

  test('a database without the pulse: a member on the path still gets it', async ({ page }) => {
    await boot(page, 2, { member: true, fx: { 'rpc:hub_pulse': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.hub_pulse' } } } });
    const fin = (await rate(page)).locator('.rg-fin');
    await expect(fin.locator('#rate-title')).toHaveText('Your first five rides');
    await expect(fin.locator('.rg-fin-n')).toHaveText('2 of 5');
    await expect(fin.locator('button')).toHaveText(['Book your next ride', 'Community', 'Done']);
  });

  test('a session without a bike is not a ride: its rating shows no path', async ({ page }) => {
    const swim = { id: 's-' + today, day: 'Friday', session_date: today, capacity: 20, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'swim', hide_queue: true, paid_ride: false, title: 'Pool morning', bike_slots: '{"_time":"07:00 - 08:30"}' };
    await boot(page, 2, { fx: { sessions: [swim] }, last: { price: 0, paid: false } });
    const m = page.locator('#rate-modal');
    await expect(m.locator('.rg-q').first()).toBeVisible();
    for (const q of await m.locator('.rg-q').all()) await q.locator('.rg-b[data-v="9"]').click();
    await m.locator('.pg-btn').click();
    await expect.poll(() => page.evaluate('!!S._rg')).toBe(false);
    await expect(m.locator('.rg-fin')).toHaveCount(0);
  });

  test('in Arabic the count reads in its own direction', async ({ page }) => {
    await boot(page, 2);
    await page.evaluate(`setLang('ar')`);
    await expect.poll(() => page.evaluate('document.documentElement.dir')).toBe('rtl');
    const fin = (await rate(page)).locator('.rg-fin');
    await expect(fin.locator('#rate-title')).toHaveText('جولاتك الخمس الأولى');
    await expect(fin.locator('.rg-fin-n')).toHaveText('2 من 5');
    await expect(fin.locator('.rg-fin-n')).not.toHaveAttribute('dir', 'ltr');
    await expect(fin.locator('button')).toHaveText(['احجز جولتك القادمة', 'تم']);
  });
});

test.describe('@customer:members the first five rides in the Community tab', () => {
  async function tab(page: Page, rides: number) {
    await boot(page, rides, { member: true, rate: false, last: { rating_detail: { form: 'rental', s: { service: 9, bike: 9 }, why: {} } } });
    await page.evaluate(`setCustTab('members')`);
    await expect(page.locator('#hub-body .hub-card').first()).toBeVisible();
  }

  test('under five rides the challenge\'s slot shows the path: five marks, the count, no monthly challenge', async ({ page }) => {
    await tab(page, 2);
    const card = page.locator('#hub-body .hub-p5');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.hub-name')).toHaveText('Your first five rides');
    await expect(card.locator('.hub-dots span')).toHaveCount(5);
    await expect(card.locator('.hub-dots span.on')).toHaveCount(2);
    await expect(card.locator('[role=progressbar]')).toHaveAttribute('aria-label', 'Your first five rides');
    await expect(card.locator('.hub-meta')).toHaveText('2 of 5');
    await expect(page.locator('#hub-body')).not.toContainText('4 sessions this month');
    await expect(page.locator('#hub-body .hub-pick')).toHaveCount(0);
  });

  test('a member who has not ridden yet starts at 0 of 5', async ({ page }) => {
    await tab(page, 0);
    const card = page.locator('#hub-body .hub-p5');
    await expect(card.locator('.hub-dots span')).toHaveCount(5);
    await expect(card.locator('.hub-dots span.on')).toHaveCount(0);
    await expect(card.locator('.hub-meta')).toHaveText('0 of 5');
  });

  test('from the fifth ride the slot is the month\'s challenge again', async ({ page }) => {
    await tab(page, 5);
    await expect(page.locator('#hub-body')).toContainText('4 sessions this month');
    await expect(page.locator('#hub-body .hub-p5')).toHaveCount(0);
  });

  test('a page that lends no path (an older one) leaves the challenge in its slot', async ({ page }) => {
    await tab(page, 2);
    await page.evaluate(`delete window._hubDeps.p5;window._hubRender()`);
    await expect(page.locator('#hub-body .hub-p5')).toHaveCount(0);
    await expect(page.locator('#hub-body')).toContainText('4 sessions this month');
  });
});

test.describe('@customer:badges the Saturday ladder\'s steps at 2 and 3 rides', () => {
  const KEYS = ['bdgTailwind', 'bdgTailwindD', 'bdgTailwindA', 'bdgMomentum', 'bdgMomentumD', 'bdgMomentumA', 'p5Title', 'p5Of'];

  test('the ladder is 1, 2, 3, 5, 10, 25, 50, 100, each step counted on Saturday ride days and drawn as the rest', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [] });
    await loginCustomer(page, { id: 'c1' });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`BDG_LADDERS.find(L=>L[0]==='rolling_start')`)).toEqual(['rolling_start', 'tailwind', 'momentum', 'slipstream', 'paceline', 'peloton', 'grand_tour', 'hall_of_fame']);
    expect(await page.evaluate(`[BD_SYS.tailwind,BD_SYS.momentum]`)).toEqual([['wind', 'silver', 'bdgTailwind'], ['wind', 'orange', 'bdgMomentum']]);
    // n Saturday rides, a rental night among them that does not count
    const got = (n: number) => page.evaluate(`(()=>{
      const E=[],SS=[{id:'j1',session_date:'2026-09-01',day:'Tuesday'}];
      E.push({id:'ej',sessionId:'j1',sessionDate:'2026-09-01',status:'done',paid:true,customerId:'c1',queueNum:1});
      for(let i=0;i<${n};i++){const d='2026-09-'+String(5+i*7).padStart(2,'0');SS.push({id:d,session_date:d,day:'Saturday',event_kind:'community',ride_kind:'saturday',paid_ride:false});
        E.push({id:'e'+i,sessionId:d,sessionDate:d,status:'done',paid:false,customerId:'c1',queueNum:1});}
      S.sessions=SS; // a Saturday ride is free: done alone counts (_freeSessIds reads the session)
      const L=_mrBadges(E,E.filter(_bdgRode),[]);
      return Object.fromEntries(['rolling_start','tailwind','momentum','slipstream'].map(s=>{const r=L.find(x=>x.s===s);return[s,[!!r.on,r.p]];}));})()`);
    expect(await got(1)).toEqual({ rolling_start: [true, '1/1'], tailwind: [false, '1/2'], momentum: [false, '1/3'], slipstream: [false, '1/5'] });
    expect(await got(2)).toEqual({ rolling_start: [true, '1/1'], tailwind: [true, '2/2'], momentum: [false, '2/3'], slipstream: [false, '2/5'] });
    expect(await got(3)).toEqual({ rolling_start: [true, '1/1'], tailwind: [true, '2/2'], momentum: [true, '3/3'], slipstream: [false, '3/5'] });
    // drawn with the ladder's own icon, no emoji
    const svg = await page.evaluate(`_bdgMedal(BD_SYS.tailwind[0],BD_SYS.tailwind[1])+_bdgMedal(BD_SYS.momentum[0],BD_SYS.momentum[1])`) as string;
    expect(svg).toContain('bdc-silver');
    expect(svg).toContain('bdc-orange');
    expect(svg).not.toMatch(/\p{Extended_Pictographic}/u);
    // English is the page's own; Arabic comes with its pack
    const words = () => page.evaluate(`${JSON.stringify(KEYS)}.map(k=>t(k))`) as Promise<string[]>;
    const en = await words();
    en.forEach((v, i) => { expect(v, KEYS[i]).toBeTruthy(); expect(v, KEYS[i]).not.toBe(KEYS[i]); });
    expect(en.slice(0, 2)).toEqual(['Tailwind', '2 community rides']);
    await page.evaluate(`setLang('ar')`);
    await expect.poll(() => page.evaluate(`t('bdgTailwind')`)).toBe('الرياح المواتية');
    const ar = await words();
    ar.forEach((v, i) => { expect(v, KEYS[i]).toBeTruthy(); expect(v, KEYS[i]).not.toBe(en[i]); });
  });

  test('every new word is in the eight other languages, with the same placeholders and Latin digits', async () => {
    for (const code of ['fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']) {
      const pack = JSON.parse(readFileSync(`i18n/${code}.json`, 'utf8')) as Record<string, string>;
      for (const k of KEYS) {
        expect(String(pack[k] || '').trim(), `${code} ${k}`).not.toBe('');
        expect(pack[k], `${code} ${k}`).not.toMatch(/[٠-٩۰-۹०-९০-৯]/);
        expect(pack[k], `${code} ${k}`).not.toMatch(/\p{Extended_Pictographic}/u);
      }
      expect(pack.p5Of, code).toContain('{0}');
      expect(pack.p5Of, code).toContain('{1}');
      expect(pack.bdgTailwindD, code).toContain('2');
      expect(pack.bdgMomentumD, code).toContain('3');
    }
  });

  test('the migration adds the two steps to the catalogue between Rolling Start and Slipstream, and nothing else', async () => {
    const sql = readFileSync('supabase/migrations/20261114010100_saturday_ladder_2_3.sql', 'utf8');
    expect(sql).toMatch(/\('bd_tailwind', 'tailwind', 'wind', 'silver',[^\n]*true, true, 226\)/);
    expect(sql).toMatch(/\('bd_momentum', 'momentum', 'wind', 'orange',[^\n]*true, true, 228\)/);
    expect(sql).toContain("values ('20261114010100', 'saturday_ladder_2_3')");
    expect(sql).not.toMatch(/create (table|or replace function)|alter table|drop /i);
  });
});
