import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// The Community tab (rebuilt 2026-11-11, member-hub.js): one feed from one read (hub_feed) - the member's next session, what is
// coming up, their own monthly challenge with a level to pick, a season challenge, the club goal with their own share, the
// club's totals, one staff card, the invitation; the year in December and January. Members see nothing of each other
// (2026-11-04). And what staff run, Community > Activities. All Supabase traffic is stubbed; the rules themselves are the database's.

const sess = (id: string, date: string, o: Record<string, unknown> = {}) => ({ id, day: 'Saturday', session_date: date, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}', ...o });
const sessions = [sess('2099-01-03', '2099-01-03'), sess('2099-01-10', '2099-01-10'), sess('2099-01-17', '2099-01-17'), sess('sw-9', '2099-01-05', { ride_kind: 'swim', gender_only: 'female', day: 'Monday' })];
const feed = (o: Record<string, unknown> = {}) => ({
  ok: true, today: '2026-11-11',
  me: { kind: 'level', levels: [1, 2, 3], target: 2, chosen: false, n: 1, ends_on: '2026-11-30', sats: 4 },
  club: { scope: 'saturday', target: 380, n: 120, mine: 1, from: '2026-11-01', ends_on: '2026-11-30' },
  goals: [{ id: 'goal_cool_season_2026', name: 'Cool Season: 8 Saturdays', name_ar: 'موسم الأجواء الباردة: 8 رحلات سبت', scope: 'saturday', target: 8, n: 2, ends_on: '2027-02-28', badge: { slug: 'cool_season_26', icon: 'wind', color: 'teal' } }],
  numbers: { last: '2026-11-07', last_riders: 96, last_rides: 96, month: 96, all: 2104, since: '2026-06-13' },
  post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null, ...o,
});
async function member(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions, customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed(), ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'male' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
}
const rpcSent = (page: Page) => {
  const out: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rpc\/(\w+)/); if (m) { let b = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ } out.push({ fn: m[1]!, body: b }); } });
  return out;
};

test.describe('@customer:members the Community tab', () => {
  test('the file loads only on this tab, and every word exists in all ten languages', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('member-hub.js')) asked.push(r.url()); });
    await stubSupabase(page, { sessions, customers: [], queue_entries: [], bikes: [], 'rpc:hub_feed': feed() });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await page.waitForTimeout(300);
    expect(asked).toEqual([]);
    await page.evaluate(`setCustTab('members')`);
    await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
    expect(asked).toHaveLength(1);
    const bad = await page.evaluate(`Object.entries(HUB_T).filter(([k,v])=>v.length!==10||v.some(x=>!String(x).trim())).map(([k])=>k)`);
    expect(bad).toEqual([]);
    expect(await page.evaluate(`Array.from({length:HUB_TIPS},(_,i)=>'tip'+i).filter(k=>!HUB_T[k])`)).toEqual([]);
  });

  test('one read, no sub-menu, the page\'s Back, nothing about anyone else, and no sideways scroll', async ({ page }) => {
    const sent = rpcSent(page);
    await member(page);
    expect([...new Set(sent.map((x) => x.fn).filter((f) => f.startsWith('hub_') || f === 'member_directory'))]).toEqual(['hub_feed']);
    await expect(page.locator('#hub-nav, .hub-tab, #tab-members .mb-row, #mb-q')).toHaveCount(0);
    await expect(page.locator('#cust-back-btn')).toBeVisible(); // the Community tab keeps the page's Back (the user, 2026-11-11)
    await expect(page.locator('#hub-body')).not.toContainText(/kudos|No challenge is running/i);
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
    await page.evaluate(`setCustTab('myrides')`);
    await expect(page.locator('#cust-back-btn')).toBeVisible();
  });

  test('the next session to book opens Reserve on it; a session for the other gender is not offered', async ({ page }) => {
    await member(page);
    const hero = page.locator('#hub-body .hub-hero');
    await expect(hero).toContainText('Next session to book');
    await expect(page.locator('#hub-body .hub-soon')).toHaveCount(2); // the two after the first; the women-only pool session is left out
    await expect(page.locator('#hub-body')).not.toContainText('Women');
    await hero.locator('button', { hasText: 'Book' }).click();
    await expect.poll(() => page.evaluate('[S.custTab,S.selSession,S.selEvent]')).toEqual(['register', '2099-01-03', 'community']);
  });

  test('a booked session is the hero, with its ticket a tap away', async ({ page }) => {
    const mine = { id: 'q1', session_id: '2099-01-10', session_date: '2099-01-10', session_day: 'Saturday', customer_id: 'c1', name: 'Lina Haddad', queue_num: 4, status: 'waiting', paid: false, price: 0, type_preference: 'Road', created_at: 1 };
    await member(page, { queue_entries: [mine], 'rpc:my_bookings': [mine] });
    const hero = page.locator('#hub-body .hub-hero');
    await expect(hero).toContainText('Your next session');
    await hero.locator('button', { hasText: 'Show ticket' }).click();
    await expect.poll(() => page.evaluate('S.custTab')).toBe('myrides');
  });

  test('the member picks a level; it is sent and the challenge counts it', async ({ page }) => {
    const sent = rpcSent(page);
    await member(page, { 'rpc:hub_pick_level': { ok: true } });
    const card = page.locator('#hub-body .hub-card', { hasText: 'Your challenge' });
    await expect(card.locator('.hub-lv')).toHaveCount(3);
    await expect(card.locator('.hub-lv.on')).toHaveText('2');
    await card.locator('.hub-lv', { hasText: '3' }).click();
    await expect.poll(() => sent.filter((x) => x.fn === 'hub_pick_level').map((x) => x.body.p_level)).toEqual([3]);
    await expect(card).toContainText('3 sessions this month');
    await expect(card.locator('.hub-lv')).toHaveCount(0);
    await expect(card.locator('[role=progressbar]')).toHaveAttribute('aria-valuetext', '1 / 3');
  });

  test('a first-timer sees their first session; the season, the club goal and the club numbers show without names', async ({ page }) => {
    await member(page, { 'rpc:hub_feed': feed({ me: { kind: 'first', levels: [1], target: 1, chosen: false, n: 0, ends_on: '2026-11-30', sats: 4 } }) });
    await expect(page.locator('#hub-body .hub-card', { hasText: 'Your challenge' })).toContainText('Your first session');
    await expect(page.locator('#hub-body .hub-card', { hasText: 'Season challenge' })).toContainText('2 of 8');
    const club = page.locator('#hub-body .hub-card', { hasText: 'Community goal' });
    await expect(club).toContainText('380 Saturday rides this month');
    await expect(club).toContainText('120 so far');
    await expect(club).toContainText('You: 1 of them');
    await expect(page.locator('#hub-body .hub-stats')).toContainText('2104');
  });

  test('with nothing staff wrote, the tip of the week shows; a Saturday report takes its place', async ({ page }) => {
    await member(page);
    await expect(page.locator('#hub-body')).toContainText('Tip of the week');
    await page.evaluate(`S._hub.d.post={id:'post_1',line:'Great ride, thank you all.',line_ar:'رحلة رائعة',riders:88,rides:88,date:'2026-11-07',img:false};_hubRender()`);
    await expect(page.locator('#hub-body')).toContainText('Saturday report');
    await expect(page.locator('#hub-body')).toContainText('88 riders');
    await expect(page.locator('#hub-body')).not.toContainText('Tip of the week');
  });

  test('a badge the read gives opens once in the badge pop-up', async ({ page }) => {
    await member(page, {
      'rpc:hub_feed': feed({ awarded: ['challenge_1'] }),
      'rpc:customer_my_badges': [{ slug: 'challenge_1', at: new Date().toISOString(), name: 'Challenge Met', icon: 'target', color: 'orange', system: true }],
      'rpc:badge_catalog': [{ id: 'bd_challenge_1', slug: 'challenge_1', name: 'Challenge Met', icon: 'target', color: 'orange', system: true, auto: true, description: 'Meet your monthly challenge.' }],
    });
    await expect(page.locator('#badge-pop')).toBeVisible();
    await expect(page.locator('#badge-pop')).toContainText('Challenge Met');
  });

  test('the year: a card that opens slides, never kudos, and the share is the member\'s own numbers', async ({ page }) => {
    await member(page, { 'rpc:hub_feed': feed({ year: { year: 2026, full: true, sessions: 12, saturdays: 8, first: '2026-06-13', kinds: ['saturday', 'rental'], busiest: '2026-10', sats_held: 22, club: 2104, club_first: '2026-06-07', badges: 3 } }) });
    await page.evaluate(`navigator.canShare=undefined;navigator.share=(d)=>{window._shared=d;return Promise.resolve();}`);
    const card = page.locator('#hub-body .hub-yr');
    await expect(card).toContainText('Your 2026 with MicroMobility');
    await expect(card).toContainText('June to December');
    await card.locator('button', { hasText: 'See your year' }).click();
    await page.locator('#hub-body .hub-slide-nav button', { hasText: 'Next' }).click();
    await page.locator('#hub-body .hub-slide-nav button', { hasText: 'Next' }).click();
    await expect(page.locator('#hub-body .hub-kinds li')).toHaveCount(2); // the circuit ('rental' in the database) is named as the circuit
    for (let i = 0; i < 2; i++) await page.locator('#hub-body .hub-slide-nav button', { hasText: 'Next' }).click();
    await expect(page.locator('#hub-body .hub-slide')).toContainText('Your next challenge is ready');
    await page.locator('#hub-body button', { hasText: 'Share my year' }).click();
    await expect.poll(() => page.evaluate('window._shared&&window._shared.text')).toBe('My 2026 with MicroMobility: 12 sessions, 8 Saturday rides.');
    await page.locator('#hub-body button', { hasText: 'Close' }).last().click();
    await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
  });

  test('a failed read keeps the copy on the phone and offers to try again; without one it says so', async ({ page }) => {
    await member(page);
    await stubSupabase(page, { sessions, customers: [], queue_entries: [], bikes: [], 'rpc:hub_feed': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    await page.evaluate(`S._hub=null;_hubRender();_hubFetch(true)`); // the copy on the phone paints first, then the read fails
    await expect(page.locator('#hub-body .hub-stale')).toContainText('Couldn’t refresh');
    await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
    await page.evaluate(`localStorage.removeItem('cq_hub_c1');S._hub=null;_hubRender()`);
    await expect(page.locator('#hub-body button', { hasText: 'Try again' })).toBeVisible();
  });

  test('a rider who is not a member is sent to Reserve', async ({ page }) => {
    await stubSupabase(page, { sessions, customers: [], queue_entries: [], bikes: [], 'rpc:hub_feed': { ok: false, error: 'member' } });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('members')`);
    await expect.poll(() => page.evaluate('S.custTab')).toBe('register');
  });
});

const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'l@example.com', phone: '+966551876215', created_at: '2026-06-10T00:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'o@example.com', phone: '+966551876216', created_at: '2026-06-11T00:00:00Z' },
];
const round = { id: 'rd1', label: 'Rider of November', label_ar: 'راكب', opens_on: '2026-11-01', closes_on: '2026-11-20', title_id: 'ttl_rotm', winner_id: null, winner_name: null };
async function staff(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], staff_options: [],
    tags: [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: 'green', locked: true }],
    customer_tags: [{ customer_id: 'c1', tag_id: 'tag_saturday', added_at: 1 }, { customer_id: 'c2', tag_id: 'tag_saturday', added_at: Date.now() }],
    titles: [{ id: 'ttl_rotm', name: 'Rider of the Month', name_ar: 'راكب الشهر', color: 'gold', auto_rides: null, retired: false, sort: 500 }], customer_titles: [],
    rotm_rounds: [round], hub_goals: [], squads: [{ id: 'sq1', name: 'Night Owls', code: 'ABC123' }], squad_members: [{ customer_id: 'c1', squad_id: 'sq1' }],
    hub_photos: [{ id: 'ph1', customer_id: 'c2', caption: 'Corniche', status: 'pending', reported_at: null, report_reason: null, created_at: '2026-11-01T00:00:00Z' }],
    member_welcome: [], hub_posts: [], badges: [{ id: 'bd_cool_season_26', slug: 'cool_season_26', name: 'Cool Season 2026', name_ar: 'موسم الأجواء الباردة 2026', retired: false, sort: 98 }],
    'rpc:staff_rotm_tally': [{ customer_id: 'c2', name: 'Omar Saleh', votes: 4 }], 'rpc:staff_goal_progress': [],
    'rpc:staff_hub_numbers': { month: '2026-11-01', first: 20, back: 9, openers: 120, open_days: 300, members: 437, challenges: 150, picked: 60, met: 40, club_target: 380, club_n: 120 }, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
  await page.waitForFunction('S._acAt>0&&!S._acBusy&&!!S._ac');
}
const writes = (page: Page, table: string) => {
  const out: { method: string; body: unknown }[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/' + table)) out.push({ method: r.method(), body: r.postDataJSON() }); });
  return out;
};
const sub = (page: Page, name: RegExp) => page.locator('#tab-community .filter-pill', { hasText: name }).click();

test.describe('@staff:community activities', () => {
  test('the section has its address, and the Photos pill counts what waits', async ({ page }) => {
    await staff(page);
    await expect(page).toHaveURL(/\/people\/activities/);
    await expect(page.locator('#tab-community .filter-pill', { hasText: /^Photos/ })).toContainText('(1)');
  });

  test('crowning the winner names them and gives the title until the end of the next month', async ({ page }) => {
    await staff(page);
    const rd = writes(page, 'rotm_rounds'), tt = writes(page, 'customer_titles');
    await sub(page, /^Rider of the Month/);
    await page.locator('[data-round="rd1"] button', { hasText: 'Votes' }).click();
    await expect(page.locator('#tab-community .tg-holders')).toContainText('4 votes');
    await page.locator('#tab-community .tg-holders button', { hasText: 'Make winner' }).click();
    expect(rd).toHaveLength(0);
    await page.locator('#tab-community .tg-holders button', { hasText: 'Tap again' }).click();
    await expect.poll(() => tt.length).toBe(1);
    expect(rd[0].body).toMatchObject({ winner_id: 'c2', winner_name: 'Omar Saleh' });
    expect(tt[0].body).toMatchObject({ customer_id: 'c2', title_id: 'ttl_rotm', expires_on: '2026-12-31' });
    await expect(page.locator('[data-round="rd1"]')).toContainText('Winner: Omar Saleh');
  });

  test('a template fills the form and saves nothing until Save', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'hub_goals');
    await sub(page, /^Challenges/);
    await expect(page.locator('#tab-community [data-tpl]')).toHaveCount(3);
    await page.locator('#tab-community button', { hasText: 'Show all templates' }).click();
    await page.locator('#tab-community [data-tpl="two"] button').last().click();
    await expect(page.locator('#ac-g-en')).toHaveValue('Two Saturdays This Month');
    await expect(page.locator('#ac-g-ar')).toHaveValue('رحلتا سبت هذا الشهر');
    await expect(page.locator('#ac-g-kind')).toHaveValue('challenge');
    await expect(page.locator('#ac-g-target')).toHaveValue('2');
    await expect(page.locator('#ac-g-badge')).toHaveValue('');
    await expect(page.locator('#ac-g-rw, #ac-g-rwar')).toHaveCount(0); // no reward text: a reward is a promise
    expect(w).toHaveLength(0);
    await page.locator('#tab-community .bdg-foot .btn-primary').click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toMatchObject({ kind: 'challenge', scope: 'saturday', target: 2, badge_id: null });
    expect(w[0].body).not.toHaveProperty('reward');
    await expect.poll(() => page.evaluate(`_acTplList(todayStr()).now.map(f=>f.name)`)).not.toContain('Two Saturdays This Month');
  });

  test('template dates: months, yearly windows, and every target is what the database takes', async ({ page }) => {
    await staff(page);
    const at = (d: string) => page.evaluate(`Object.fromEntries(AC_TEMPLATES.map(x=>[x.id,_acTplFill(x,${JSON.stringify(d)})]))`) as Promise<Record<string, { from: string; to: string; target: number; name: string; name_ar: string } | null>>;
    const a = await at('2026-11-04');
    expect(a.two).toMatchObject({ from: '2026-11-04', to: '2026-11-30' });
    expect(a.every!.target).toBe(4);
    expect(a.cool).toMatchObject({ from: '2026-11-04', to: '2027-02-28', target: 8 });
    expect(a.ramadan).toMatchObject({ from: '2027-02-08', to: '2027-03-09' });
    expect(a.founding).toMatchObject({ from: '2027-02-01', target: 300, name: 'Founding Day: 300 Sessions' });
    expect(a.bikeday).toMatchObject({ from: '2027-05-29', to: '2027-06-05' });
    expect(a.national).toMatchObject({ from: '2027-09-18', target: 194, name: 'National Day 97: 194 Saturday Rides' });
    expect(a.goalsat).toBeUndefined(); // the month's club goal is the app's own, sized to the club's pace
    expect(a.goalall).toBeUndefined();
    const b = await at('2026-12-20');
    expect(b.two).toMatchObject({ from: '2027-01-01', to: '2027-01-31' });
    const c = await at('2027-01-15');
    expect(c.cool).toMatchObject({ from: '2027-01-15', to: '2027-02-28' });
    const later = await at('2030-01-01');
    expect(later.ramadan).toBeNull();
    for (const f of [...Object.values(a), ...Object.values(b), ...Object.values(c)]) {
      if (!f) continue;
      expect(f.name.length).toBeLessThanOrEqual(60);
      expect(f.name_ar.length).toBeLessThanOrEqual(60);
      expect(f.target).toBeGreaterThanOrEqual(1);
      expect(f.to >= f.from).toBe(true);
    }
  });

  test('a challenge needs both names and dates, then saves', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'hub_goals');
    await sub(page, /^Challenges/);
    await page.locator('#tab-community button', { hasText: 'New challenge or goal' }).click();
    await page.locator('#ac-g-en').fill('Three Saturdays');
    await page.locator('#tab-community .bdg-foot .btn-primary').click();
    await expect(page.locator('#toast-container')).toContainText('both names');
    expect(w).toHaveLength(0);
    await page.locator('#ac-g-ar').fill('ثلاثة');
    await page.locator('#ac-g-target').fill('3');
    await page.locator('#ac-g-to').fill('2099-01-31');
    await page.locator('#ac-g-badge').selectOption('bd_cool_season_26');
    await page.locator('#tab-community .bdg-foot .btn-primary').click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toMatchObject({ kind: 'challenge', scope: 'saturday', target: 3, name: 'Three Saturdays', badge_id: 'bd_cool_season_26' });
    await expect(page.locator('#tab-community .am-tag-row', { hasText: 'Three Saturdays' })).toBeVisible();
  });

  test('the Saturday report takes the ride\'s counts, and a photo only with the photo rule ticked', async ({ page }) => {
    const sat = { id: '2026-11-07', day: 'Saturday', session_date: '2026-11-07', capacity: 40, status: 'closed', created_at: 1, event_kind: 'community', ride_kind: 'saturday', bike_slots: '{"_time":"06:00 - 06:30","_total":40}' };
    const done = (id: string, cid: string) => ({ id, session_id: '2026-11-07', session_date: '2026-11-07', session_day: 'Saturday', customer_id: cid, name: cid, queue_num: 1, status: 'done', paid: false, price: 0, type_preference: 'Road', created_at: 1 });
    await staff(page, { sessions: [sat], queue_entries: [done('q1', 'c1'), done('q2', 'c2')] });
    const w = writes(page, 'hub_posts');
    await sub(page, /^Saturday report/);
    await page.locator('#tab-community button', { hasText: 'New Saturday report' }).click();
    await expect(page.locator('#tab-community .bdg-form')).toContainText('2 riders · 2 rides');
    await page.locator('#ac-r-en').fill('Thank you all for a lovely morning.');
    await page.evaluate(`S._acRepImg='data:image/jpeg;base64,AAAA';renderCommunity()`);
    await page.locator('#ac-r-en').fill('Thank you all for a lovely morning.');
    await page.locator('#tab-community .bdg-foot .btn-primary').click();
    await expect(page.locator('#toast-container')).toContainText('Tick the photo rule');
    expect(w).toHaveLength(0);
    await page.locator('#ac-r-rule').check();
    await page.locator('#tab-community .bdg-foot .btn-primary').click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toMatchObject({ session_id: '2026-11-07', riders: 2, rides: 2, line: 'Thank you all for a lovely morning.', img: 'data:image/jpeg;base64,AAAA' });
  });

  test('the numbers read for this month and the last', async ({ page }) => {
    await staff(page);
    await sub(page, /^Numbers/);
    await expect(page.locator('#tab-community')).toContainText('9 (45%)');
    await expect(page.locator('#tab-community')).toContainText('120 / 437');
    await expect(page.locator('#tab-community')).toContainText('120 / 380');
  });

  test('a photo is approved; a rejected one sends the picture away with it', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'hub_photos');
    await sub(page, /^Photos/);
    await page.locator('[data-photo="ph1"] button', { hasText: 'Approve' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toMatchObject({ status: 'approved', decided_by: 'Spec Staff' });
    await page.locator('[data-photo="ph1"] button', { hasText: 'Reject and delete' }).click();
    await page.locator('[data-photo="ph1"] button', { hasText: 'Tap again' }).click();
    await expect.poll(() => w.length).toBe(2);
    expect(w[1].body).toMatchObject({ status: 'rejected', img: null });
    await expect(page.locator('[data-photo="ph1"]')).toHaveCount(0);
  });

  test('a new member is given a welcome buddy; an older member is not listed', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'member_welcome');
    await sub(page, /^Welcome/);
    await expect(page.locator('[data-new="c1"]')).toHaveCount(0);
    await page.locator('[data-new="c2"] select').selectOption('c1');
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toMatchObject({ customer_id: 'c2', buddy_id: 'c1' });
  });

  test('a squad is removed on the second tap', async ({ page }) => {
    await staff(page);
    const w = writes(page, 'squads');
    await sub(page, /^Squads/);
    await expect(page.locator('[data-squad="sq1"]')).toContainText('ABC123');
    await page.locator('[data-squad="sq1"] .btn-red').click();
    expect(w).toHaveLength(0);
    await page.locator('[data-squad="sq1"] .btn-red').click();
    await expect.poll(() => w.length).toBe(1);
    await expect(page.locator('[data-squad="sq1"]')).toHaveCount(0);
  });

  test('a database without the tables says so', async ({ page }) => {
    await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], tags: [], customer_tags: [], staff_options: [] });
    await page.route('**/rest/v1/rotm_rounds*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: 'no table' }) }));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
    await expect(page.locator('#tab-community')).toContainText('not set up on the database');
  });
});
