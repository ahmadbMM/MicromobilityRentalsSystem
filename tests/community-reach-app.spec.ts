import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, rateGateOn, type Fixtures } from './helpers/supabase';

// Community where members already are (2026-11-13, reports/Community tab reach after launch.md: R1, R4-R7, and the
// ticket's part of R9-R10). One light read, hub_pulse, wherever a member is in the app: it lights a dot on the Community
// tab, brings a Community badge they have not seen (the badge pop-up with Community and Done, or the rating pop-up's last
// screen when a ride waits to be rated), and carries their challenge to the rating's last screen and to "You're booked".
// /members signed out signs in and comes back; ?src= says how a member came. The ticket shows the ride's status and opens
// the meeting point's coordinates. All Supabase traffic is stubbed; the rules themselves are the database's.

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const month = today.slice(0, 7);
const other = (() => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; })();
const me = (o: Record<string, unknown> = {}) => ({ kind: 'level', target: 4, n: 3, ends_on: `${month}-28`, sats: 4, levels: [2, 3, 4], chosen: true, ...o });
const season = { id: 'goal_cool', name: 'Cool Season: 8 Saturdays', name_ar: 'موسم الأجواء الباردة', target: 8, n: 2, ends_on: '2099-02-28', badge: { slug: 'cool_season_26', icon: 'wind', color: 'teal' } };
const pulse = (o: Record<string, unknown> = {}) => ({ ok: true, member: true, dot: false, me: me(), goals: [season], fresh: [], ...o });
const badge = { slug: 'challenge_1', at: new Date().toISOString(), name: 'Challenge Met', icon: 'target', color: 'orange', system: true };
const badges: Fixtures = {
  'rpc:customer_my_badges': [badge],
  'rpc:badge_catalog': [{ id: 'bd_challenge_1', slug: 'challenge_1', name: 'Challenge Met', icon: 'target', color: 'orange', system: true, auto: true, description: 'Meet your monthly challenge.' }],
  'rpc:hub_seen': { ok: true, n: 1 },
};
const feed = { ok: true, today, me: me(), club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null };
const circuit = (date: string, o: Record<string, unknown> = {}) => ({ id: 's-' + date, day: 'Friday', session_date: date, capacity: 12, status: 'open', created_at: 1, bike_slots: '{"_time":"18:00 - 20:00","_total":12}', ...o });
const ride = (id: string, date: string, o: Record<string, unknown> = {}) => ({
  id, name: 'Spec Rider', customer_id: 'c1', session_id: 's-' + date, session_day: 'Friday', session_date: date, queue_num: 1,
  status: 'done', paid: true, price: 30, checked_out_at: date + 'T11:00:00Z', registered_at: date + 'T10:00:00Z', ...o,
});
// Four rides ridden before the rating page existed: with today's the rider has five, so the rating's last screen is this
// build's own. Under five rides it is the first-five-rides path (new features build F1, tests/first-five-rides.spec.ts).
const rode4 = ['2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25'].map((d, i) => ride('o' + i, d));

// Every RPC the page sent, with its body.
function rpcLog(page: Page) {
  const out: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rpc\/(\w+)/); if (m) { let b = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ } out.push({ fn: m[1]!, body: b }); } });
  return out;
}
const sent = (log: { fn: string }[], fn: string) => log.filter((x) => x.fn === fn).length;
// What the page set S._hubSrc to, in order (member-hub.js reads it once when the tab loads, and may clear it).
const srcSpy = (page: Page) => page.evaluate(`window.__src=[];(()=>{let v=S._hubSrc;Object.defineProperty(S,'_hubSrc',{configurable:true,get:()=>v,set:(x)=>{v=x;window.__src.push(x);}});})()`);
const srcs = (page: Page) => page.evaluate('window.__src') as Promise<unknown[]>;

async function boot(page: Page, fx: Fixtures = {}, o: { member?: boolean; path?: string; rate?: boolean } = {}) {
  const log = rpcLog(page);
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], 'rpc:community_member': o.member !== false, 'rpc:hub_pulse': pulse(), 'rpc:hub_feed': feed, ...fx });
  if (o.rate) await rateGateOn(page);
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'male' });
  await page.goto(o.path || '/');
  await waitForSb(page);
  return log;
}
// The Community tab as the rider sees it: the bar on a phone, the top tabs on a wide screen.
const commTab = (page: Page) => page.locator('#bnav-members:visible, #customer-tab-nav [data-ctab="members"]:visible').first();
const dotOn = (page: Page) => page.evaluate(`['#customer-tab-nav [data-ctab="members"]','#bnav-members'].map(q=>{const b=document.querySelector(q);return !!b&&b.classList.contains('has-dot')})`);

test.describe('@customer:members Community where members are', () => {
  test('the dot: lit by the pulse on opening, said in the tab\'s name, gone as the tab opens, and a tap on it counted as the dot\'s', async ({ page }) => {
    const log = await boot(page, { 'rpc:hub_pulse': pulse({ dot: true }) });
    await expect.poll(() => sent(log, 'hub_pulse')).toBe(1);
    expect(log.find((x) => x.fn === 'hub_pulse')!.body).toEqual({ p_id: 'c1', p_token: 'tok-spec' });
    await expect.poll(() => dotOn(page)).toEqual([true, true]);
    await expect(commTab(page)).toHaveAttribute('aria-label', 'Community, new');
    await expect(commTab(page)).toHaveAccessibleName('Community, new');
    // never a number: the mark is the button's own ::after, no text
    await expect(commTab(page)).toHaveText(/^\s*Community\s*$/);
    const dot = await page.evaluate(`(()=>{const s=getComputedStyle(document.getElementById('bnav-members'),'::after');return{c:s.content,w:s.width,bg:s.backgroundColor}})()`);
    expect(dot).toMatchObject({ c: '""', w: '9px' });
    await srcSpy(page);
    await commTab(page).click();
    await expect.poll(() => page.evaluate('S.custTab')).toBe('members');
    expect(await srcs(page)).toContain('dot');
    expect(await dotOn(page)).toEqual([false, false]);
    await expect(commTab(page)).not.toHaveAttribute('aria-label', /.*/);
    // a pulse asked before the tab opened does not light it again when its answer lands afterwards
    await page.evaluate(`setCustTab('register');window.__p=_pulse(true);setCustTab('members')`);
    await expect.poll(() => sent(log, 'hub_pulse')).toBe(2);
    await page.evaluate('window.__p');
    await page.evaluate(`setCustTab('register')`);
    expect(await dotOn(page)).toEqual([false, false]);
  });

  test('a tap with no dot is the tab\'s; coming back into view asks again only after ten minutes; a non-member is never asked', async ({ page }) => {
    const log = await boot(page);
    await expect.poll(() => sent(log, 'hub_pulse')).toBe(1);
    expect(await dotOn(page)).toEqual([false, false]);
    await page.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
    await page.waitForTimeout(300);
    expect(sent(log, 'hub_pulse')).toBe(1);
    await page.evaluate(`S._pls.at=Date.now()-11*60e3;document.dispatchEvent(new Event('visibilitychange'))`);
    await expect.poll(() => sent(log, 'hub_pulse')).toBe(2);
    await srcSpy(page);
    await commTab(page).click();
    await expect.poll(() => srcs(page)).toContain('tab');
  });

  test('a non-member: no pulse, no dot, no tab', async ({ page }) => {
    const log = await boot(page, { 'rpc:hub_pulse': pulse({ dot: true }) }, { member: false });
    await page.waitForTimeout(600);
    expect(sent(log, 'hub_pulse')).toBe(0);
    await expect(page.locator('#bnav-members, #customer-tab-nav [data-ctab="members"]')).toHaveCount(2);
    await expect(page.locator('#bnav-members:visible, #customer-tab-nav [data-ctab="members"]:visible')).toHaveCount(0);
  });

  test('the dot sits in the mirrored corner in Arabic and keeps its own colour on the night bar', async ({ page }) => {
    await boot(page, { 'rpc:hub_pulse': pulse({ dot: true }) });
    await expect.poll(() => dotOn(page)).toEqual([true, true]);
    // which edge the dot keeps to, read off the tab on screen: the end (right) in English, the start mirrored in Arabic
    const side = async () => {
      const id = await commTab(page).evaluate((b) => (b.id ? '#' + b.id : '#customer-tab-nav [data-ctab="members"]'));
      return page.evaluate(`(()=>{const s=getComputedStyle(document.querySelector('${id}'),'::after');return parseFloat(s.left)>parseFloat(s.right)?'right':'left'})()`);
    };
    expect(await side()).toBe('right');
    await page.evaluate(`setLang('ar')`);
    await expect.poll(() => page.evaluate('document.documentElement.dir')).toBe('rtl');
    expect(await side()).toBe('left');
    await expect(commTab(page)).toHaveAttribute('aria-label', 'المجتمع، جديد');
    const bg = () => page.evaluate(`getComputedStyle(document.getElementById('bnav-members'),'::after').backgroundColor`); // the bar's (hidden on a wide screen, still styled)
    const day = await bg();
    await page.evaluate(`document.getElementById('cust-bottom-nav').classList.add('lq-night')`);
    expect(await bg()).not.toBe(day);
  });

  test('a Community badge the server gave opens once in the badge pop-up, with Community and Done, and is marked seen there', async ({ page }) => {
    const log = await boot(page, { 'rpc:hub_pulse': pulse({ fresh: [{ slug: 'challenge_1', at: badge.at }] }), ...badges });
    const pop = page.locator('#badge-pop');
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Challenge Met');
    await expect(pop.locator('button')).toHaveText(['Share', 'Community', 'Done']); // Share: an earned badge's picture (F12, tests/badge-share.spec.ts)
    await expect.poll(() => log.filter((x) => x.fn === 'hub_seen').map((x) => x.body)).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_slugs: ['challenge_1'] }]);
    await expect(pop.locator('button', { hasText: 'Done' })).toBeFocused();
    await pop.locator('button', { hasText: 'Done' }).click();
    await expect(pop).toHaveCount(0);
    // seen: neither the next pulse nor Account's own pop-up shows it again
    await page.evaluate(`S._pls.at=0;_pulse()`);
    await page.evaluate(`setCustTab('account')`);
    await page.waitForTimeout(500);
    await expect(pop).toHaveCount(0);
    expect(sent(log, 'hub_seen')).toBe(1);
  });

  test('the badge pop-up\'s Community button opens the tab, counted as the badge\'s', async ({ page }) => {
    await boot(page, { 'rpc:hub_pulse': pulse({ fresh: [{ slug: 'challenge_1', at: badge.at }] }), ...badges });
    await expect(page.locator('#badge-pop')).toBeVisible();
    await srcSpy(page);
    await page.locator('#badge-pop button', { hasText: 'Community' }).click();
    await expect.poll(() => page.evaluate('S.custTab')).toBe('members');
    expect(await srcs(page)).toContain('badge');
    await expect(page.locator('#badge-pop')).toHaveCount(0);
  });

  test('with a ride to rate, the badge waits for the rating and shows on its last screen, one thing with Community and Done', async ({ page }) => {
    const q = [...rode4, ride('q1', today)];
    const log = await boot(page, { sessions: [circuit(today)], queue_entries: q, 'rpc:my_bookings': q, 'rpc:customer_booking_update': true,
      'rpc:hub_pulse': pulse({ fresh: [{ slug: 'challenge_1', at: badge.at }] }), ...badges }, { rate: true });
    const m = page.locator('#rate-modal');
    await expect(m.locator('.rg-q').first()).toBeVisible();
    await expect.poll(() => sent(log, 'hub_pulse')).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await expect(page.locator('#badge-pop')).toHaveCount(0); // never two pop-ups at once
    expect(sent(log, 'hub_seen')).toBe(0);
    await m.locator('#rgq-service .rg-b[data-v="10"]').click();
    await m.locator('#rgq-bike .rg-b[data-v="10"]').click();
    await m.locator('.pg-btn').click();
    const fin = m.locator('.rg-fin');
    await expect(fin).toBeVisible();
    await expect(fin.locator('#rate-title')).toHaveText('Challenge Met');
    await expect(fin.locator('.rg-fin-medal')).toHaveCount(1);
    await expect(fin.locator('[role=progressbar], p')).toHaveCount(0);
    await expect(fin.locator('button')).toHaveText(['Community', 'Done']);
    await expect(page.locator('#toast-live')).toContainText('Thanks for rating your ride.'); // still said, as before
    await expect.poll(() => log.filter((x) => x.fn === 'hub_seen').map((x) => x.body.p_slugs)).toEqual([['challenge_1']]);
    await srcSpy(page);
    await fin.locator('button', { hasText: 'Community' }).click();
    await expect.poll(() => page.evaluate('[!!S._rg,S.custTab]')).toEqual([false, 'members']);
    expect(await srcs(page)).toContain('rating');
    await expect(page.locator('#badge-pop')).toHaveCount(0);
  });

  test('the last screen shows the month\'s challenge this ride moved: dots for four, the count written; Done and Escape close it', async ({ page }) => {
    const q = [...rode4, ride('q1', today)];
    await boot(page, { sessions: [circuit(today)], queue_entries: q, 'rpc:my_bookings': q, 'rpc:customer_booking_update': true }, { rate: true });
    const m = page.locator('#rate-modal');
    await m.locator('#rgq-service .rg-b[data-v="9"]').click();
    await m.locator('#rgq-bike .rg-b[data-v="9"]').click();
    await m.locator('.pg-btn').click();
    const fin = m.locator('.rg-fin');
    await expect(fin.locator('#rate-title')).toHaveText('4 sessions this month');
    await expect(fin.locator('[role=progressbar]')).toHaveAttribute('aria-valuetext', '3 / 4');
    await expect(fin.locator('.hp-dots i')).toHaveCount(4);
    await expect(fin.locator('.hp-dots i.on')).toHaveCount(3);
    await expect(fin.locator('.rg-fin-n')).toHaveText('3 / 4');
    // centred: the card's middle is the screen's middle
    const box = (await fin.boundingBox())!, vp = page.viewportSize()!;
    expect(Math.abs(box.y + box.height / 2 - vp.height / 2)).toBeLessThan(24);
    expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(4);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate('!!S._rg')).toBe(false);
    await expect(m).toBeHidden();
  });

  test('a ride from another month: the season challenge\'s count instead, as a bar; nothing to show closes as before', async ({ page }) => {
    const q = [...rode4, ride('q1', today)];
    await boot(page, { sessions: [circuit(today)], queue_entries: q, 'rpc:my_bookings': q, 'rpc:customer_booking_update': true,
      'rpc:hub_pulse': pulse({ me: me({ ends_on: `${other}-28` }) }) }, { rate: true });
    const m = page.locator('#rate-modal');
    await m.locator('#rgq-service .rg-b[data-v="9"]').click();
    await m.locator('#rgq-bike .rg-b[data-v="9"]').click();
    await m.locator('.pg-btn').click();
    const fin = m.locator('.rg-fin');
    await expect(fin.locator('#rate-title')).toHaveText('Cool Season: 8 Saturdays');
    await expect(fin.locator('.hp-bar')).toHaveCount(1);
    await expect(fin.locator('.rg-fin-n')).toHaveText('2 / 8');
    await fin.locator('button', { hasText: 'Done' }).click();
    await expect.poll(() => page.evaluate('!!S._rg')).toBe(false);
  });

  for (const [name, fx, member] of [['nothing to show', { 'rpc:hub_pulse': pulse({ me: null, goals: [] }) }, true], ['not a member', {}, false]] as const) {
    test(`${name}: the rating closes with its thank-you, as it always did`, async ({ page }) => {
      const q = [...rode4, ride('q1', today)];
      const log = await boot(page, { sessions: [circuit(today)], queue_entries: q, 'rpc:my_bookings': q, 'rpc:customer_booking_update': true, ...fx }, { rate: true, member });
      const m = page.locator('#rate-modal');
      await m.locator('#rgq-service .rg-b[data-v="9"]').click();
      await m.locator('#rgq-bike .rg-b[data-v="9"]').click();
      await m.locator('.pg-btn').click();
      await expect.poll(() => page.evaluate('!!S._rg')).toBe(false);
      await expect(m.locator('.rg-fin')).toHaveCount(0);
      await expect(page.locator('#toast-live')).toContainText('Thanks for rating your ride.');
      if (!member) expect(sent(log, 'hub_pulse')).toBe(0);
    });
  }

  test('"You\'re booked" for a community session: the challenge with this booking outlined, a link to Community; the ticket unchanged', async ({ page }) => {
    const s = { id: today, day: 'Saturday', session_date: today, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' };
    const mine = { id: 'q9', session_id: today, session_date: today, session_day: 'Saturday', customer_id: 'c1', name: 'Lina Haddad', queue_num: 4, status: 'waiting', paid: false, price: 0, type_preference: 'Own', created_at: 1 };
    const log = await boot(page, { sessions: [s], queue_entries: [mine], 'rpc:my_bookings': [mine], 'rpc:hub_pulse': pulse({ me: me({ n: 1 }) }) });
    await expect.poll(() => sent(log, 'hub_pulse')).toBe(1);
    // the booking's own paint, then the pulse after it, as submitReg does
    await page.evaluate(`S.lastTickets=[_qGet('q9')];setCustTab('register');_bkHubAfter()`);
    await expect.poll(() => sent(log, 'hub_pulse')).toBe(2);
    const hub = page.locator('#bk-ok-hub');
    await expect(hub.locator('.bk-hub')).toBeVisible();
    await expect(hub).toContainText('4 sessions this month');
    expect(await hub.locator('.hp-dots i').evaluateAll((els) => els.map((e) => e.className))).toEqual(['on', 'nx', '', '']);
    await expect(hub.locator('.bk-hub')).toHaveAccessibleName(/With this booking: 2 of 4/);
    await expect(page.locator('.ticket-card .bk-hub, .ticket-card #bk-ok-hub')).toHaveCount(0);
    await srcSpy(page);
    await hub.locator('.bk-hub').click();
    await expect.poll(() => page.evaluate('S.custTab')).toBe('members');
    expect(await srcs(page)).toContain('booked');
  });

  test('"You\'re booked": nothing when the challenge is done, the ride is in another month, or the session is not a community one', async ({ page }) => {
    const s = { id: today, day: 'Saturday', session_date: today, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' };
    const mine = { id: 'q9', session_id: today, session_date: today, session_day: 'Saturday', customer_id: 'c1', name: 'Lina Haddad', queue_num: 4, status: 'waiting', paid: false, price: 0, type_preference: 'Own', created_at: 1 };
    await boot(page, { sessions: [s], queue_entries: [mine], 'rpc:my_bookings': [mine] });
    await expect.poll(() => page.evaluate('!!(S._pls&&S._pls.d)')).toBe(true);
    await page.evaluate(`S.lastTickets=[_qGet('q9')]`);
    for (const m of [me({ n: 4 }), me({ ends_on: `${other}-28` })]) {
      await page.evaluate(`S._pls.d.me=${JSON.stringify(m)};setCustTab('register')`);
      await expect(page.locator('.bk-ok')).toBeVisible();
      await expect(page.locator('#bk-ok-hub .bk-hub')).toHaveCount(0);
    }
    await page.evaluate(`S._pls.d.me=${JSON.stringify(me())};_sessGet('${today}').event_kind=null;_sessGet('${today}').ride_kind=null;setCustTab('register')`);
    await expect(page.locator('#bk-ok-hub')).toHaveCount(0);
  });

  test('/members signed out: the sign-in, then the Community tab; ?src= is read and taken off the address', async ({ page }) => {
    const log = rpcLog(page);
    const cust = { id: 'c9', name: 'Test User', email: 'x@y.com', phone: '+966508727012', session_token: 'tok9' };
    await stubSupabase(page, { sessions: [], 'rpc:customer_login': [cust], 'rpc:customer_profile': [cust], 'rpc:community_member': true, 'rpc:hub_feed': feed, 'rpc:hub_pulse': pulse() });
    await page.goto('/members?src=wa-recap');
    await waitForSb(page);
    await expect(page.locator('#a-identifier')).toBeVisible();
    expect(await page.evaluate('location.search')).toBe('');
    expect(await page.evaluate('S._hubSrc')).toBe('wa');
    await page.fill('#a-identifier', 'x@y.com');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.press('#a-pwd', 'Enter');
    await expect.poll(() => page.evaluate('[S.view,S.custTab]')).toEqual(['customer', 'members']);
    await expect.poll(() => sent(log, 'hub_feed')).toBeGreaterThan(0);
    expect(await page.evaluate('location.pathname')).toBe('/members');
  });

  test('?src=push is push, a plain /members link is a link; the tab drawn signed out shows the sign-in, never a blank page', async ({ page }) => {
    await stubSupabase(page, { sessions: [] });
    await page.goto('/members?src=push');
    await waitForSb(page);
    expect(await page.evaluate('[S._hubSrc,location.search]')).toEqual(['push', '']);
    await page.goto('/members');
    await waitForSb(page);
    expect(await page.evaluate('S._hubSrc')).toBe('link');
    await page.goto('/my-bookings?src=wa-x');
    await waitForSb(page);
    expect(await page.evaluate('[S._hubSrc===undefined,location.search]')).toEqual([true, '']);
    // the tab itself, asked for with nobody signed in
    await page.evaluate(`try{sessionStorage.removeItem('cq_open_tab')}catch(e){};closeAuthModal();showView('customer');setCustTab('members')`);
    await expect.poll(() => page.evaluate('S.view')).toBe('landing');
    await expect(page.locator('#a-identifier')).toBeVisible();
    expect(await page.evaluate(`sessionStorage.getItem('cq_open_tab')`)).toBe('members');
  });

  test('the manifest names the app and reuses an open window for a link', async ({ request }) => {
    const m = await (await request.get('/manifest.json')).json();
    expect(m.id).toBe(m.start_url);
    expect(m.launch_handler).toEqual({ client_mode: ['navigate-existing', 'auto'] });
  });

  test('the ticket: the ride\'s status as a chip, the meeting point\'s coordinates on the map button and its name as the place', async ({ page }) => {
    const day = '2099-01-03';
    const s = { id: day, day: 'Saturday', session_date: day, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, hide_queue: false,
      bike_slots: '{"_time":"06:00 - 06:30","_total":40}', meet_lat: 21.5292, meet_lng: 39.1611, meet_name: 'Corniche parking', meet_name_ar: 'موقف الكورنيش', ride_status: 'moved' };
    const mine = { id: 'q9', session_id: day, session_date: day, session_day: 'Saturday', customer_id: 'c1', name: 'Lina Haddad', queue_num: 4, status: 'waiting', approval: 'approved', paid: false, price: 0, type_preference: 'Own', created_at: 1 };
    await boot(page, { sessions: [s], queue_entries: [mine], 'rpc:my_bookings': [mine] });
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card').first();
    await expect(tk.locator('.tk-rs')).toHaveText('Start moved');
    await expect(tk.locator('.tk-venue')).toHaveText('Corniche parking');
    await expect(tk.locator('a.cu-tk-dir')).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=21.5292,39.1611');
    await page.evaluate(`_sessGet('${day}').ride_status='cancelled';renderMyRides()`);
    await expect(tk.locator('.tk-rs.tk-rs-cancelled')).toHaveText('Cancelled');
    await page.evaluate(`_sessGet('${day}').ride_status=null;renderMyRides()`);
    await expect(tk.locator('.tk-rs')).toHaveCount(0);
    await page.evaluate(`setLang('ar')`);
    await expect(tk.locator('.tk-venue')).toHaveText('موقف الكورنيش');
  });
});
