import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Badges staff give (2026-09-29). Staff give a rider a badge from their row in Accounts (with a note
// the rider reads) or to everyone who rode a ride from Community > Badges, and take one back on a
// second tap. Admins make badges from the app's drawn icons and eight colours: no badge is an emoji
// (the owner). The rider sees the badges staff gave first on their account page, and a new one
// pops up once. All Supabase traffic is stubbed.

const EMOJI = /\p{Extended_Pictographic}/u;
const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const P1 = day(-3), OLD = day(-60);
const slots = JSON.stringify({ _time: '21:00 - 23:00', _total: 40 });
const sessions = [
  { id: P1, day: 'Friday', session_date: P1, capacity: 40, status: 'closed', created_at: 0, bike_slots: slots },
  { id: OLD, day: 'Monday', session_date: OLD, capacity: 40, status: 'closed', created_at: 1, bike_slots: slots },
];
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', gender: 'female', created_at: '2026-06-10T09:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', gender: 'male', created_at: '2026-06-11T09:00:00Z' },
  { id: 'c3', name: 'Sara Nabil', email: 'sara.nabil@gmail.com', phone: '+966551876217', gender: 'female', created_at: '2026-06-12T09:00:00Z' },
];
const row = (id: string, session: string, qn: number, name: string, customer_id: string | null, status: string, paid = false) => ({
  id, session_id: session, session_day: 'Friday', session_date: session, queue_num: qn, name, phone: '0551112222',
  customer_id, status, paid, type_preference: 'Road', price: 115, walk_in: !customer_id, registered_at: '2026-09-01T10:00:00Z',
});
const queue_entries = [
  row('q1', P1, 2, 'Lina Haddad', 'c1', 'done', true),
  row('q2', P1, 3, 'Omar Saleh', 'c2', 'done', true),
  row('q3', P1, 4, 'Sara Nabil', 'c3', 'noshow'),
  row('q4', P1, 5, 'Walk Person', null, 'done', true),
  row('q5', OLD, 2, 'Sara Nabil', 'c3', 'done', true), // outside the 30 days
];
const badges = [
  { id: 'bd_first_lap', slug: 'first_lap', icon: 'flag', color: 'green', name: 'First Lap', description: 'Completed your first circuit ride', system: true, auto: true, retired: false, sort: 100 },
  { id: 'bd_marshal', slug: 'marshal', icon: 'shield', color: 'orange', name: 'Marshal', description: 'Led or swept a group ride', system: true, auto: false, retired: false, sort: 10 },
  { id: 'bd_champion', slug: 'champion', icon: 'trophy', color: 'gold', name: 'Champion', description: 'Won a challenge', system: true, auto: false, retired: false, sort: 60 },
  { id: 'bd_cnight', slug: 'bd_cnight', icon: 'moon', color: 'purple', name: 'Night Owl', name_ar: 'بومة الليل', description: 'Rode a late ride', system: false, auto: false, retired: false, sort: 500 },
];
const customer_badges = [
  { customer_id: 'c2', badge_id: 'bd_champion', note: 'Won the sprint', session_id: null, awarded_by: 'Malik', awarded_at: '2026-09-20T18:00:00Z' },
];

async function staff(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions, customers, queue_entries, bikes: [], tags: [], customer_tags: [], staff_options: [], badges, customer_badges, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffRole='admin'`);
}
const community = async (page: Page, tab: string) => {
  await page.evaluate(`setStaffTab('community');S.communityTab='${tab}';renderCommunity()`);
  await page.waitForFunction('S._bdgAt>0&&!S._bdgBusy');
};
const writes = (page: Page, table: string) => {
  const out: Request[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/' + table)) out.push(r); });
  return out;
};
const modal = (page: Page) => page.locator('#confirm-modal .bdg-dlg');

test.describe('@staff:community badges', () => {
  test('a rider\'s Badges dialog gives a badge with a note, and takes one back on the second tap', async ({ page }) => {
    await staff(page);
    await community(page, 'accounts');
    const sent = writes(page, 'customer_badges');
    const lina = page.locator('#am-cust-rows .am-row[data-cust="c1"]');
    await lina.locator('.am-bdg-btn').click();
    await expect(modal(page)).toContainText('Badges · Lina Haddad');
    // First Lap is hers by riding: listed as held, not offered.
    await expect(modal(page).locator('.bdg-list')).toContainText('First Lap');
    await expect(modal(page).locator('.bdg-list')).toContainText('Earned by riding');
    await expect(modal(page).locator('.bdg-pick')).toHaveText(['Marshal', 'Champion', 'Night Owl']);
    await expect(modal(page).locator('.bdg-pick svg.bdg-m')).toHaveCount(3);

    // Each badge's "i" opens what it means and how it is earned under it; a second tap closes it.
    const info = modal(page).locator('.bdg-pickw', { hasText: 'Marshal' }).getByRole('button', { name: 'About the Marshal badge' });
    await info.click();
    await expect(modal(page).locator('.bdg-info')).toContainText('Marshals keep a race safe and running');
    await expect(modal(page).locator('.bdg-info .bdg-info-how')).toContainText('Led or swept a group ride');
    await expect(modal(page).getByRole('button', { name: 'About the Marshal badge' })).toHaveAttribute('aria-expanded', 'true');
    await modal(page).getByRole('button', { name: 'About the First Lap badge' }).click(); // a held one has its own
    await expect(modal(page).locator('.bdg-info')).toHaveCount(1);
    await expect(modal(page).locator('.bdg-info')).toContainText('Every rider\'s story starts with one lap');
    await modal(page).getByRole('button', { name: 'About the First Lap badge' }).click();
    await expect(modal(page).locator('.bdg-info')).toHaveCount(0);
    await modal(page).locator('.bdg-pick', { hasText: 'Marshal' }).click();
    await expect(modal(page).locator('.bdg-pick.on')).toHaveText('Marshal');
    await modal(page).locator('#bdg-note').fill('Swept the Friday ride');
    await modal(page).getByRole('button', { name: 'Give badge' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].postDataJSON()).toMatchObject({ customer_id: 'c1', badge_id: 'bd_marshal', note: 'Swept the Friday ride', awarded_by: 'Spec Staff' });
    await expect(modal(page).locator('.bdg-list')).toContainText('Swept the Friday ride');
    await expect(modal(page).locator('.bdg-pick', { hasText: 'Marshal' })).toHaveCount(0);
    await expect(lina.locator('.am-bdg svg.bdg-m')).toHaveCount(1); // the row shows it too
    expect(await page.evaluate('(S.undoStack.at(-1)||{}).label')).toBe('Badge given: Marshal to Lina Haddad');

    // Take back asks once more on the same button; only the second tap writes.
    const take = modal(page).locator('.bdg-item', { hasText: 'Marshal' }).getByRole('button', { name: 'Take back' });
    await take.click();
    await expect(modal(page).locator('.bdg-item', { hasText: 'Marshal' }).locator('.btn-red')).toHaveText('Take it back?');
    expect(sent.length).toBe(1);
    await modal(page).locator('.bdg-item', { hasText: 'Marshal' }).locator('.btn-red').click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].method()).toBe('DELETE');
    expect(sent[1].url()).toContain('customer_id=eq.c1');
    expect(sent[1].url()).toContain('badge_id=eq.bd_marshal');
    await expect(modal(page).locator('.bdg-pick', { hasText: 'Marshal' })).toHaveCount(1);
    expect(EMOJI.test(await modal(page).innerText())).toBe(false);
  });

  test('Community > Badges lists holders, gives to everyone who rode a ride, and an admin\'s new badge is drawn', async ({ page }) => {
    await staff(page);
    await community(page, 'badges');
    const tab = page.locator('#tab-community');
    await expect(tab.locator('.bdg-row')).toHaveCount(4);
    const champ = tab.locator('.bdg-row[data-badge="bd_champion"]');
    await expect(champ).toContainText('1 holders');
    await champ.getByRole('button', { name: 'Holders' }).click();
    await expect(champ.locator('.bdg-hold')).toContainText('Omar Saleh');
    await expect(champ.locator('.bdg-hold')).toContainText('Won the sprint');

    // Give to a ride: the accounts checked in on it (done), not the no-show, not a walk-in.
    const sent = writes(page, 'customer_badges');
    const marshal = tab.locator('.bdg-row[data-badge="bd_marshal"]');
    await marshal.getByRole('button', { name: 'Give to a ride' }).click();
    await expect(marshal.locator('#bdg-ride option')).toHaveCount(1); // the old ride is past the 30 days
    await marshal.locator('#bdg-rnote').fill('National Day ride');
    await marshal.getByRole('button', { name: 'Give to 2 riders' }).click();
    await expect.poll(() => sent.length).toBe(1);
    const rows = sent[0].postDataJSON() as Record<string, unknown>[];
    expect(rows.map((r) => r.customer_id).sort()).toEqual(['c1', 'c2']);
    expect(rows.every((r) => r.session_id === P1 && r.badge_id === 'bd_marshal' && r.note === 'National Day ride')).toBe(true);
    expect(sent[0].headers()['prefer']).toContain('resolution=ignore-duplicates');
    await expect(marshal).toContainText('2 holders');

    // Champion: Omar holds it already, so only Lina is left to give it to.
    await champ.getByRole('button', { name: 'Give to a ride' }).click();
    await expect(champ.getByRole('button', { name: 'Give to 1 riders' })).toBeVisible();

    // A new badge: an icon from the set and a colour, never an emoji.
    const made = writes(page, 'badges');
    await tab.getByRole('button', { name: '+ New badge' }).click();
    const form = tab.locator('.bdg-form');
    await form.locator('.bdg-ico[aria-label="bolt"]').click();
    await form.locator('.bdg-sw[aria-label="teal"]').click();
    await form.locator('#bdg-f-name').fill('Night Rider');
    await form.locator('#bdg-f-name_ar').fill('راكب الليل');
    await expect(form.locator('.bdg-preview svg.bdg-m.bdc-teal')).toHaveCount(1);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => made.length).toBe(1);
    expect(made[0].postDataJSON()).toMatchObject({ icon: 'bolt', color: 'teal', name: 'Night Rider', name_ar: 'راكب الليل' });
    expect(String((made[0].postDataJSON() as Record<string, unknown>).slug)).toMatch(/^bd_c[a-z0-9]+$/);
    await expect(tab.locator('.bdg-row')).toHaveCount(5);
    expect(EMOJI.test(await tab.innerText())).toBe(false);

    // Front desk give and take back, but do not make or edit badges.
    await page.evaluate(`S.staffRole='frontdesk';renderCommunity()`);
    await expect(tab.getByRole('button', { name: '+ New badge' })).toHaveCount(0);
    await expect(tab.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(tab.getByRole('button', { name: 'Give to a ride' }).first()).toBeVisible();
  });

  test('a database without the badges tables: no Badges button, and the tab says why', async ({ page }) => {
    await staff(page, { badges: [], customer_badges: [] });
    await community(page, 'accounts');
    await expect(page.locator('#am-cust-rows .am-row[data-cust="c1"]')).toBeVisible();
    await expect(page.locator('#am-cust-rows .am-bdg-btn')).toHaveCount(0);
    await page.evaluate(`S.communityTab='badges';renderCommunity()`);
    await expect(page.locator('#tab-community')).toContainText('Badges are not set up on the database yet.');
  });
});

test.describe('@customer:account badges', () => {
  const mine = [
    { slug: 'bd_cnight', icon: 'moon', color: 'purple', name: 'Night Owl', name_ar: 'بومة الليل', description: 'Rode a late ride', system: false, note: null, at: '2026-09-01T10:00:00Z' },
    { slug: 'marshal', icon: 'shield', color: 'orange', name: 'Marshal', system: true, note: 'Thanks for sweeping', at: new Date(Date.now() - 36e5).toISOString() },
  ];
  async function rider(page: Page, fx: Fixtures) {
    await stubSupabase(page, { sessions, queue_entries: [row('q1', P1, 2, 'Spec Rider', 'c1', 'done', true)], ...fx });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
  }

  test('the badges staff gave come first among the earned, drawn, and the newest pops up once', async ({ page }) => {
    await rider(page, { 'rpc:customer_my_badges': mine });
    const pop = page.locator('#badge-pop');
    await expect(pop).toContainText('New badge!');
    await expect(pop).toContainText('Marshal');
    await expect(pop).toContainText('Thanks for sweeping');
    await expect(pop).toContainText('Given by the MicroMobility team');
    await expect(pop.locator('svg.bdg-m.bdc-orange')).toHaveCount(1);
    await pop.getByRole('button', { name: 'Close' }).click();

    const chips = page.locator('#tab-account .mr-badges .mr-badge');
    // Every badge (2026-09-29): the two given and First Lap earned, then the twenty to earn by riding
    // (National Day 96 and Back on Track wait until earned), then the six other ones staff give.
    await expect(chips).toHaveCount(28);
    await expect(page.locator('#tab-account .mr-badges-n')).toHaveText('3/28');
    await expect(chips.nth(0)).toContainText('Night Owl');
    await expect(chips.nth(1)).toContainText('Marshal');
    await expect(chips.nth(2)).toContainText('First Lap');
    await expect(chips.nth(2)).not.toHaveClass(/locked/); // a done, paid ride
    await expect(chips.nth(3)).toContainText('Race Ready');
    await expect(chips.nth(3)).toHaveClass(/locked/); // name, email and phone only: a third of the profile
    await expect(chips.nth(3)).toContainText('33%');
    await expect(chips.nth(27)).toContainText('Race Spirit');
    await expect(chips.nth(27)).toHaveClass(/locked/);
    await expect(page.locator('#tab-account .mr-badges svg.bdg-m')).toHaveCount(28);
    expect(EMOJI.test(await page.locator('#tab-account .mr-badges').innerText())).toBe(false);

    // Seen on this device: asked again, it does not pop up a second time.
    await page.evaluate(`S._bdgMine.at=0;renderAccount()`);
    await page.waitForFunction('S._bdgMine&&!S._bdgMine.busy');
    await page.waitForTimeout(200);
    await expect(pop).toHaveCount(0);

    // A badge an admin made reads its Arabic name in Arabic, its English one elsewhere.
    expect(await page.evaluate(`(()=>{const b=S._bdgMine.list[0],en=_bdgName(b);S.lang='ar';const ar=_bdgName(b);S.lang='en';return[en,ar];})()`)).toEqual(['Night Owl', 'بومة الليل']);
  });

  test('a database without customer_my_badges still shows the ride badges', async ({ page }) => {
    await rider(page, { 'rpc:customer_my_badges': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_my_badges' } } });
    await page.waitForFunction('S._bdgMine&&!S._bdgMine.busy');
    await expect(page.locator('#tab-account .mr-badges .mr-badge')).toHaveCount(27); // the twenty ride badges and the seven staff give
    await expect(page.locator('#badge-pop')).toHaveCount(0);
    await page.locator('#tab-account .mr-badge', { hasText: 'First Lap' }).click();
    await expect(page.locator('#badge-pop')).toContainText('First Lap');
    await expect(page.locator('#badge-pop .badge-pop-about')).toContainText('Every rider\'s story starts with one lap');
    await expect(page.locator('#badge-pop')).toContainText('Earned');
  });

  test('the whole catalogue in order, in equal tiles: a retired badge only for a rider who holds it, an admin\'s own greyed until given', async ({ page }) => {
    const sys = (slug: string, sort: number, auto = true) => ({ slug, icon: 'flag', color: 'green', name: slug, system: true, auto, sort });
    const catalog = [
      ...['marshal', 'pit_crew', 'green_flag', 'super_licence', 'scrutineer', 'champion', 'spirit'].map((x, i) => sys(x, 10 + i * 10, false)),
      ...['national_day_96', 'complete_profile', 'first_lap', 'regular', 'podium', 'front_row', 'carbon', 'streak', 'squad', 'corniche25', 'back_on_track', 'safety_car',
        'endurance', 'triple_crown', 'slipstream', 'paceline', 'peloton', 'clean_sheet', 'works_team', 'winter_series'].map((x, i) => sys(x, 90 + i * 10)),
      // 'fuel' is not here: retired. Night Owl is an admin's own, not given to this rider.
      { slug: 'bd_cnight', icon: 'moon', color: 'purple', name: 'Night Owl', description: 'Rode a late ride', system: false, auto: false, sort: 500 },
    ];
    await rider(page, {
      'rpc:customer_my_badges': [mine[1]],
      'rpc:badge_catalog': catalog,
      'rpc:badge_seasons': [{ slug: 'winter_series', icon: 'snow', color: 'blue', name: 'Winter Series', system: true, rule: { rides: 6, windows: [{ from: '12-01', to: '02-28' }] } }],
    });
    await page.waitForFunction('S._bdgCat&&S._bdgCat.length>0');
    const chips = page.locator('#tab-account .mr-badges .mr-badge');
    const names = () => chips.evaluateAll((els) => els.map((e) => e.querySelector('.mr-badge-nm')!.textContent));
    await expect.poll(names).toEqual([
      'Marshal', 'First Lap', // earned: the given one, then by riding
      'Race Ready', 'Grid Regular', 'Podium Pace', 'Front Row', 'Carbon Club', 'Hot Streak', 'Squad Captain', 'Corniche 25', 'Safety Car',
      'Endurance', 'Triple Crown', 'Clean Sheet', 'Slipstream', 'Paceline', 'Peloton', 'Works Team', // to earn by riding (no Fuel Stop: retired)
      'Winter Series', // dated, shown out of season
      'Pit Crew', 'Green Flag', 'Super Licence', 'Scrutineer', 'Champion', 'Race Spirit', 'Night Owl', // staff give them
    ]);
    await expect(page.locator('#tab-account .mr-badges-n')).toHaveText('2/26');
    // Every tile the same size.
    const sizes = await chips.evaluateAll((els) => [...new Set(els.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); }))]);
    expect(sizes).toHaveLength(1);
    // Out of season, its popup says when it opens (after the new Marshal's own popup is closed).
    await page.locator('#badge-pop').getByRole('button', { name: 'Close' }).click();
    await chips.filter({ hasText: 'Winter Series' }).click();
    await expect(page.locator('#badge-pop')).toContainText('Opens');
  });
});

// The ride badges added 2026-09-29, read straight off _mrBadges with made-up rides dated from today.
test.describe('@customer:account ride badges from the research', () => {
  const setup = `(()=>{
    const day=n=>new Date(Date.now()+n*864e5).toLocaleDateString('en-CA',{timeZone:'Asia/Riyadh'});
    window.__ses=(id,d,kind)=>({id,session_date:d,day:'Friday',status:'closed',event_kind:kind&&kind!=='jcc'?'community':null,ride_kind:kind==='jcc'?null:kind});
    window.__e=(sid,d,status,extra)=>Object.assign({id:sid+Math.random(),sessionId:sid,sessionDate:d,status:status||'done',paid:true,customerId:'c1',queueNum:5},extra||{});
    window.__day=day;
    window.__run=(entries,sessions,seasons)=>{S.sessions=sessions;const L=_mrBadges(entries,entries.filter(_rideCompleted),seasons||[]);return Object.fromEntries(L.map(r=>[r.s,{on:!!r.on,p:r.p||null,hide:!!r.hide}]));};
  })()`;
  type Got = Record<string, { on: boolean; p: string | null; hide: boolean }>;
  const ev = (page: Page, expr: string) => page.evaluate(expr) as Promise<Got>;
  async function page0(page: Page) {
    await stubSupabase(page, { sessions: [], queue_entries: [] });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(setup);
  }
  const nights = (spec: [number, string, string?][]) => `(()=>{const S_=[],E=[];${JSON.stringify(spec)}.forEach(([n,kind,st],i)=>{const d=__day(n),id='s'+i;S_.push(__ses(id,d,kind));E.push(__e(id,d,st));});return [E,S_];})()`;

  test('Back on Track is a surprise: hidden until a ride two months after the last', async ({ page }) => {
    await page0(page);
    const near = await ev(page, `(()=>{const[E,S_]=${nights([[-40, 'jcc'], [-10, 'jcc']])};return __run(E,S_);})()`);
    expect(near.back_on_track).toEqual({ on: false, p: null, hide: true });
    const back = await ev(page, `(()=>{const[E,S_]=${nights([[-100, 'jcc'], [-20, 'jcc']])};return __run(E,S_);})()`);
    expect(back.back_on_track.on).toBe(true);
  });

  test('Safety Car forgives one quiet week in four; Hot Streak keeps a run that has ended', async ({ page }) => {
    await page0(page);
    // Five weeks with a quiet one inside: forgiven, but five is not six.
    const five = await ev(page, `(()=>{const[E,S_]=${nights([[-28, 'jcc'], [-21, 'jcc'], [-7, 'jcc'], [0, 'jcc']])};return __run(E,S_);})()`);
    expect(five.safety_car).toEqual({ on: false, p: '5/6', hide: false });
    // Six weeks, the fourth quiet: forgiven, so the run spans six.
    const six = await ev(page, `(()=>{const[E,S_]=${nights([[-35, 'jcc'], [-28, 'jcc'], [-21, 'jcc'], [-7, 'jcc'], [0, 'jcc']])};return __run(E,S_);})()`);
    expect(six.safety_car.on).toBe(true);
    const six2 = await ev(page, `(()=>{const[E,S_]=${nights([[-42, 'jcc'], [-35, 'jcc'], [-28, 'jcc'], [-14, 'jcc'], [-7, 'jcc'], [0, 'jcc']])};return __run(E,S_);})()`);
    expect(six2.safety_car.on).toBe(true);
    expect(six2.endurance.hide).toBe(false);
    // Two quiet weeks inside four end it.
    const broken = await ev(page, `(()=>{const[E,S_]=${nights([[-49, 'jcc'], [-42, 'jcc'], [-28, 'jcc'], [-14, 'jcc'], [-7, 'jcc'], [0, 'jcc']])};return __run(E,S_);})()`);
    expect(broken.safety_car.on).toBe(false);
    expect(broken.endurance.hide).toBe(false); // every tier shows from the start since 2026-09-29
    // Three weeks running, half a year ago and nothing since: Hot Streak stays earned.
    const old = await ev(page, `(()=>{const[E,S_]=${nights([[-200, 'jcc'], [-193, 'jcc'], [-186, 'jcc']])};return __run(E,S_);})()`);
    expect(old.streak.on).toBe(true);
    expect(old.streak.p).toBe('0/3');
  });

  test('Triple Crown, Slipstream and its tiers, Works Team, counted in ride nights', async ({ page }) => {
    await page0(page);
    const r = await ev(page, `(()=>{const[E,S_]=${nights([[-60, 'jcc'], [-50, 'saturday'], [-43, 'saturday'], [-36, 'saturday'], [-29, 'saturday'], [-22, 'saturday'], [-15, 'petromin'], [-8, 'petromin']])};
      E.push(__e('s1',__day(-50),'done'),__e('s1',__day(-50),'done'),__e('s1',__day(-50),'done')); // a party of four on one night
      return __run(E,S_);})()`);
    expect(r.triple_crown.on).toBe(true);
    expect(r.slipstream).toEqual({ on: true, p: '5/5', hide: false });
    expect(r.paceline).toEqual({ on: false, p: '5/15', hide: false });
    expect(r.peloton).toEqual({ on: false, p: '5/30', hide: false }); // shown before its tier since 2026-09-29
    expect(r.works_team).toEqual({ on: false, p: '2/3', hide: false });
    const none = await ev(page, `(()=>{const[E,S_]=${nights([[-10, 'jcc']])};return __run(E,S_);})()`);
    expect(none.slipstream).toEqual({ on: false, p: '0/5', hide: false });
    expect(none.works_team).toEqual({ on: false, p: '0/3', hide: false });
    expect(none.triple_crown).toEqual({ on: false, p: '1/3', hide: false });
  });

  test('Perfect Week is every session of a week ridden; Perfect Month is four in a row, a thin week skipped', async ({ page }) => {
    await page0(page);
    // Weeks run Sunday to Saturday. w5..w1 are past weeks, w0 this one.
    const plan = (missW2: boolean, weeks = true) => `(()=>{
      const add=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
      const t=todayStr(),w0=add(t,-new Date(t+'T00:00:00Z').getUTCDay()),w=n=>add(w0,-7*n);
      S._bdgWeeks=${weeks}?[
        {w:w(5),ids:['a5','b5']},              // ridden both
        {w:w(4),ids:['a4']},                   // one session: left out, breaks nothing
        {w:w(3),ids:['a3','b3']},              // ridden both
        {w:w(2),ids:['a2','b2','swim2']},      // a swim counts too
        {w:w(1),ids:['a1','b1']},              // ridden both
        {w:w0,ids:['a0','b0','c0']},           // this week: one of three so far
      ]:undefined;
      const E=[['a5',w(5)],['b5',add(w(5),2)],['a3',w(3)],['b3',add(w(3),2)],['a2',w(2)],['b2',add(w(2),2)],${missW2 ? '' : "['swim2',add(w(2),4)],"}['a1',w(1)],['b1',add(w(1),2)],['a0',w0]].map(([id,d])=>__e(id,d));
      return __run(E,[]);})()`;
    const all = await ev(page, plan(false));
    expect(all.perfect_week).toEqual({ on: true, p: '1/3', hide: false });
    expect(all.perfect_month).toEqual({ on: true, p: '4/4', hide: false }); // this week under way breaks nothing
    const missed = await ev(page, plan(true));
    expect(missed.perfect_week.on).toBe(true);
    expect(missed.perfect_month).toEqual({ on: false, p: '1/4', hide: false }); // the missed swim ended the run
    const unknown = await ev(page, plan(false, false));
    expect(unknown.perfect_week).toEqual({ on: false, p: null, hide: false }); // no badge_weeks: nothing can be told
    expect(unknown.perfect_month).toEqual({ on: false, p: null, hide: false });
  });

  test('Clean Sheet is ten nights in a row with no no-show, and stays earned', async ({ page }) => {
    await page0(page);
    const spec: [number, string, string?][] = [];
    for (let i = 0; i < 10; i++) spec.push([-100 + i * 7, 'jcc']);
    spec.push([-20, 'jcc', 'noshow'], [-10, 'jcc'], [-5, 'jcc', 'cancelled']);
    const r = await ev(page, `(()=>{const[E,S_]=${nights(spec)};return __run(E,S_);})()`);
    expect(r.clean_sheet).toEqual({ on: true, p: '1/10', hide: false });
    const short = await ev(page, `(()=>{const[E,S_]=${nights([[-30, 'jcc'], [-20, 'jcc', 'noshow'], [-10, 'jcc']])};return __run(E,S_);})()`);
    expect(short.clean_sheet.on).toBe(false);
  });

  test('a dated badge counts the nights inside one window, and shows all year with its next window', async ({ page }) => {
    await page0(page);
    const rule = (from: string, to: string, rides: number) => `{slug:'bd_cx',system:false,icon:'moon',color:'purple',name:'Late Loop',rule:{rides:${rides},windows:[{from:${from},to:${to}}]}}`;
    const open = await ev(page, `(()=>{const[E,S_]=${nights([[-3, 'jcc'], [-40, 'jcc']])};return __run(E,S_,[${rule("__day(-5)", "__day(5)", 2)}]);})()`);
    expect(open.bd_cx).toEqual({ on: false, p: '1/2', hide: false });
    const done = await ev(page, `(()=>{const[E,S_]=${nights([[-3, 'jcc'], [-4, 'jcc']])};return __run(E,S_,[${rule("__day(-5)", "__day(5)", 2)}]);})()`);
    expect(done.bd_cx.on).toBe(true);
    const far = await ev(page, `(()=>{const[E,S_]=${nights([[-3, 'jcc']])};return __run(E,S_,[${rule("__day(90)", "__day(99)", 1)}]);})()`);
    expect(far.bd_cx).toEqual({ on: false, p: '0/1', hide: false });
    // Every year, across New Year: a ride on 3 January counts for the window 12-15 to 01-15.
    const yearly = await page.evaluate(`(()=>{const y=+__day(0).slice(0,4)-1,d=y+'-01-03';S.sessions=[__ses('w',d,'jcc')];const E=[__e('w',d)];
      const L=_mrBadges(E,E.filter(_rideCompleted),[{slug:'bd_cy',system:false,rule:{rides:1,windows:[{from:'12-15',to:'01-15'}]}}]);return L.find(r=>r.s==='bd_cy').on;})()`);
    expect(yearly).toBe(true);
  });

  test('the rider sees a dated badge that is open, with its window in the popup', async ({ page }) => {
    const now = new Date();
    const d = (n: number) => new Date(now.getTime() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    await stubSupabase(page, {
      sessions, queue_entries: [row('q1', P1, 2, 'Spec Rider', 'c1', 'done', true)],
      'rpc:badge_seasons': [{ slug: 'bd_cloop', icon: 'moon', color: 'purple', name: 'Late Loop', description: 'Two late rides', system: false, rule: { rides: 2, windows: [{ from: d(-5), to: d(5) }] } }],
    });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    const chip = page.locator('#tab-account .mr-badge', { hasText: 'Late Loop' });
    await expect(chip).toContainText('1/2');
    await expect(chip).toHaveClass(/locked/);
    await chip.click();
    await expect(page.locator('#badge-pop')).toContainText('On now, until');
    await expect(page.locator('#badge-pop')).toContainText('Two late rides');
  });
});

test.describe('@staff:community dated badges', () => {
  const dated = [...badges, { id: 'bd_winter_series', slug: 'winter_series', icon: 'snow', color: 'blue', name: 'Winter Series', system: true, auto: true, retired: false, sort: 280, rule: { rides: 6, windows: [{ from: '12-01', to: '02-29' }] } }];
  test('an admin moves a season\'s dates; a date that is not one is refused before any write', async ({ page }) => {
    await staff(page, { badges: dated });
    await community(page, 'badges');
    const tab = page.locator('#tab-community');
    const row = tab.locator('.bdg-row[data-badge="bd_winter_series"]');
    await expect(row.locator('.bdg-dated')).toContainText('12-01 – 02-29');
    await row.getByRole('button', { name: 'Edit' }).click();
    const form = tab.locator('.bdg-form');
    await expect(form.locator('.bdg-ico')).toHaveCount(0); // the app's own badge: its dates alone
    await expect(form.locator('#bdg-f-name')).toHaveCount(0);
    const sent = writes(page, 'badges');
    await form.getByRole('button', { name: '+ Add dates' }).click();
    await form.locator('#bdg-w-f-1').fill('2027-13-01');
    await form.locator('#bdg-w-t-1').fill('2027-01-10');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast').last()).toContainText('Check the dates');
    expect(sent.length).toBe(0);
    await form.locator('#bdg-w-f-1').fill('11-20');
    await form.locator('#bdg-w-t-1').fill('11-30');
    await form.locator('#bdg-f-rides').fill('5');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].method()).toBe('PATCH');
    expect(sent[0].postDataJSON()).toEqual({ rule: { rides: 5, windows: [{ from: '12-01', to: '02-29' }, { from: '11-20', to: '11-30' }] } });
    await expect(row.locator('.bdg-dated')).toContainText('11-20 – 11-30');
  });

  test('an admin\'s own badge given dates is earned by riding', async ({ page }) => {
    await staff(page);
    await community(page, 'badges');
    const tab = page.locator('#tab-community');
    const made = writes(page, 'badges');
    await tab.getByRole('button', { name: '+ New badge' }).click();
    const form = tab.locator('.bdg-form');
    await form.locator('#bdg-f-name').fill('National Day Ride');
    await form.getByRole('button', { name: '+ Add dates' }).click();
    await form.locator('#bdg-w-f-0').fill('2027-09-20');
    await form.locator('#bdg-w-t-0').fill('2027-09-26');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => made.length).toBe(1);
    expect(made[0].postDataJSON()).toMatchObject({ name: 'National Day Ride', auto: true, rule: { rides: 1, windows: [{ from: '2027-09-20', to: '2027-09-26' }] } });
  });
});

test.describe('@customer:account Race Ready and the about lines', () => {
  const full = { name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', height: 176, birth_date: '1995-04-02', country: 'Saudi Arabia', city: 'Jeddah', photo: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', type_preference: 'Road' };
  async function rider(page: Page, cust: Record<string, unknown>) {
    await stubSupabase(page, { sessions, queue_entries: [row('q1', P1, 2, 'Spec Rider', 'c1', 'done', true)] });
    await loginCustomer(page, cust);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
  }

  test('a whole profile earns Race Ready: drawn special, and it pops up once', async ({ page }) => {
    await rider(page, full);
    const pop = page.locator('#badge-pop');
    await expect(pop).toContainText('New badge!');
    await expect(pop).toContainText('Race Ready');
    await expect(pop.locator('.badge-pop-box.special')).toHaveCount(1);
    await expect(pop.locator('svg.bdg-sp')).toHaveCount(1);
    await expect(pop.locator('.badge-pop-about')).toContainText('A complete profile helps us fit your bike');
    await pop.getByRole('button', { name: 'Close' }).click();
    const chip = page.locator('#tab-account .mr-badge', { hasText: 'Race Ready' });
    await expect(chip).toHaveClass(/special/);
    await expect(chip).not.toHaveClass(/locked/);
    await expect(chip.locator('svg.bdg-sp linearGradient')).toHaveCount(1);
    // Seen: a repaint does not pop it again.
    await page.evaluate(`renderAccount()`);
    await page.waitForTimeout(200);
    await expect(pop).toHaveCount(0);
  });

  test('every app badge explains itself, and Grid Regular says what the grid is', async ({ page }) => {
    await rider(page, {});
    await page.locator('#tab-account .mr-badge', { hasText: 'Grid Regular' }).click();
    await expect(page.locator('#badge-pop .badge-pop-about')).toContainText('the grid is where the cars line up to start');
    await expect(page.locator('#badge-pop .badge-pop-d')).toHaveText('Completed 5 rides');
    // Every badge the app knows has a name, a how-to line and an about line (check-i18n holds the
    // other nine languages to the same keys).
    const missing = await page.evaluate(`Object.values(BD_SYS).flatMap(([,,k])=>[k,k+'D',k+'A']).filter(k=>!LANG.en[k])`);
    expect(missing).toEqual([]);
  });
});

test.describe('@customer:account National Day 96', () => {
  const nd = { id: '2026-09-23-nd', day: 'Wednesday', session_date: '2026-09-23', capacity: 80, status: 'closed', created_at: 5, bike_slots: slots, ride_kind: 'snd96', event_kind: null };
  async function rider(page: Page, status: string) {
    await stubSupabase(page, { sessions: [...sessions, nd], queue_entries: [row('n1', nd.id, 7, 'Spec Rider', 'c1', status, false)] });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
  }
  test('a rider checked in on the National Day ride gets it, drawn in the greens, and it pops up once', async ({ page }) => {
    await rider(page, 'done'); // unpaid: it is attendance
    const pop = page.locator('#badge-pop');
    await expect(pop).toContainText('New badge!');
    await expect(pop).toContainText('National Day 96');
    await expect(pop.locator('.badge-pop-about')).toContainText('filled the Corniche in green');
    await expect(pop.locator('.badge-pop-box.special.sp-national')).toHaveCount(1);
    await pop.getByRole('button', { name: 'Close' }).click();
    const chip = page.locator('#tab-account .mr-badge', { hasText: 'National Day 96' });
    await expect(chip).toHaveClass(/special sp-national/);
    await expect(chip.locator('svg.bdg-sp stop').first()).toHaveAttribute('stop-color', '#5fd99a');
    await page.evaluate(`renderAccount()`);
    await page.waitForTimeout(200);
    await expect(pop).toHaveCount(0);
  });
  test('a no-show on it never sees it', async ({ page }) => {
    await rider(page, 'noshow');
    await expect(page.locator('#tab-account .mr-badges')).toBeVisible();
    await expect(page.locator('#tab-account .mr-badge', { hasText: 'National Day 96' })).toHaveCount(0);
    await expect(page.locator('#badge-pop')).toHaveCount(0);
  });
});
