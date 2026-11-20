import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';
import { hubPart } from './helpers/hub';

// The Ramadan season (2026-11-18; the user picked "Ramadan season (about 8 Feb to 8 Mar 2027): a Ramadan challenge from the
// existing template, a season badge, an Eid ride and a Ramadan look for the tab"). Migration 20261118210900 seeds the two
// challenges and their badges and adds hub_season, the tab's read of Ramadan's dates; member-hub.js opens the tab with a
// "Ramadan Kareem" card and gives the next session's card a night-blue and gold accent while Ramadan runs, and "Eid Mubarak"
// on Eid al-Fitr's first three days. The clock is held in Riyadh with Playwright's clock. All Supabase traffic is stubbed.

const sess = (id: string, date: string) => ({ id, day: 'Saturday', session_date: date, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' });
const sessions = [sess('2099-01-03', '2099-01-03'), sess('2099-01-10', '2099-01-10')];
const rode5 = ['2026-08-28', '2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25'].map((d, i) => ({ id: 'o' + i, name: 'Lina Haddad', customer_id: 'c1', session_id: 'j-' + d, session_day: 'Friday', session_date: d, queue_num: 1, status: 'done', paid: true, price: 30 }));
const RAM = { year: 2027, starts_on: '2027-02-08', ends_on: '2027-03-09', eid_on: '2027-03-10' };
const ramGoal = { id: 'goal_ramadan_2027', name: 'Ramadan Rhythm: 2 Sessions', name_ar: 'إيقاع رمضان: مشاركتان', scope: 'community', target: 2, n: 1, ends_on: '2027-03-09', badge: { slug: 'ramadan_2027', icon: 'crescent', color: 'blue' } };
const eidGoal = { id: 'goal_eid_2027', name: 'Eid Ride', name_ar: 'رحلة العيد', scope: 'community', target: 1, n: 0, ends_on: '2027-03-13', badge: { slug: 'eid_2027', icon: 'lantern', color: 'gold' } };
const feed = (today: string, goals: unknown[] = []) => ({
  ok: true, today,
  me: { kind: 'level', levels: [1, 2, 3], target: 2, chosen: false, n: 1, ends_on: '2027-02-28', sats: 4 },
  club: null, goals, numbers: {}, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null,
});
const at = (ymd: string) => new Date(`${ymd}T10:00:00+03:00`);

async function member(page: Page, ymd: string, fx: Fixtures = {}, path = '/') {
  await page.clock.setFixedTime(at(ymd));
  await stubSupabase(page, { sessions, customers: [], queue_entries: rode5, 'rpc:my_bookings': rode5, bikes: [], 'rpc:community_member': true,
    'rpc:hub_feed': feed(ymd), 'rpc:hub_season': { ok: true, today: ymd, ramadan: RAM }, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'female' });
  await page.goto(path);
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
}
const card = (page: Page) => page.locator('#hub-body .hub-ssn');
const body = (page: Page) => page.locator('#hub-body');
const calls = (page: Page, fn: string) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/rpc/' + fn)) out.push(r.postDataJSON() || {}); });
  return out;
};

test.describe('@customer:members the Ramadan season on the Community tab', () => {
  test('during Ramadan the tab opens with a drawn Ramadan Kareem card, and the next session wears night blue and gold', async ({ page }) => {
    const asked = calls(page, 'hub_season');
    await member(page, '2027-02-20', { 'rpc:hub_feed': feed('2027-02-20', [ramGoal]) });
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveText('Ramadan Kareem');
    await expect(card(page)).toHaveClass(/hub-ssn-ramadan/);
    // first in the Sessions part (2026-11-20), before the next session's card
    expect(await page.locator('#hub-pane-sess').evaluate((b) => b.firstElementChild?.classList.contains('hub-ssn'))).toBe(true);
    // the crescent and two lanterns are drawn, never an emoji, never an inline style
    const art = card(page).locator('svg.hub-ssn-art');
    await expect(art).toHaveAttribute('aria-hidden', 'true');
    await expect(art.locator('.hs-moon')).toHaveCount(1);
    await expect(art.locator('.hs-glass')).toHaveCount(2);
    const html = await card(page).evaluate((el) => el.outerHTML);
    expect(html).not.toMatch(/style=|\son[a-z]+=/i);
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    // the accent: the hero's night and neon become the season's night blue and gold
    await expect(body(page)).toHaveClass(/hub-ssn-on/);
    const look = await page.locator('#hub-body .hub-hero').evaluate((h) => {
      const cs = getComputedStyle(h), k = h.querySelector('.hub-k');
      return { night: cs.getPropertyValue('--night').trim().toUpperCase(), bg: cs.backgroundImage, k: k ? getComputedStyle(k).color : '' };
    });
    expect(look.night).toBe('#0F1E3D');
    expect(look.bg).toContain('gradient');
    expect(look.k).toBe('rgb(243, 213, 142)'); // the gold, where the neon was
    // the season challenge is the seeded one, its badge drawn as the new crescent (in the Challenges part)
    await hubPart(page, 'goals');
    const season = page.locator('#hub-body .hub-card', { hasText: 'Ramadan Rhythm: 2 Sessions' });
    await expect(season).toBeVisible();
    expect(await season.locator('svg.hub-medal').evaluate((s) => s.innerHTML)).toContain('M15.6 3.2A9.3 9.3 0 1 0 15.6 20.8');
    // one read of the dates, with the member's own token
    expect(asked).toEqual([{ p_id: 'c1', p_token: 'tok-spec' }]);
  });

  test('in Arabic the card says رمضان كريم', async ({ page }) => {
    await member(page, '2027-03-09', {}, '/?lang=ar');
    await expect(card(page)).toHaveText('رمضان كريم');
  });

  test('on Eid al-Fitr\'s first three days the card says Eid Mubarak; the day after, the tab is as before', async ({ page }) => {
    await member(page, '2027-03-12', { 'rpc:hub_feed': feed('2027-03-12', [eidGoal]) });
    await expect(card(page)).toHaveText('Eid Mubarak');
    await expect(card(page)).toHaveClass(/hub-ssn-eid/);
    await expect(body(page)).toHaveClass(/hub-ssn-on/);
    await hubPart(page, 'goals');
    await expect(page.locator('#hub-body .hub-card', { hasText: 'Eid Ride' })).toBeVisible();
    await page.clock.setFixedTime(at('2027-03-13'));
    await page.evaluate(`_hubRender()`);
    await expect(card(page)).toHaveCount(0);
    await expect(body(page)).not.toHaveClass(/hub-ssn-on/);
  });

  test('before Ramadan nothing of it shows: no card, no accent, no word', async ({ page }) => {
    await member(page, '2027-02-07');
    await expect(card(page)).toHaveCount(0);
    await expect(body(page)).not.toHaveClass(/hub-ssn-on/);
    await expect(body(page)).not.toContainText(/Ramadan|Eid/);
  });

  test('the dates are kept on the phone: a repaint and a second open do not ask again, and the card paints at once', async ({ page }) => {
    const asked = calls(page, 'hub_season');
    await member(page, '2027-02-10');
    await expect(card(page)).toBeVisible();
    await page.evaluate(`_hubRender()`);
    await page.evaluate(`setCustTab('account')`);
    await page.evaluate(`setCustTab('members')`);
    await expect(card(page)).toBeVisible();
    expect(asked).toHaveLength(1);
    const kept = await page.evaluate(`JSON.parse(localStorage.getItem('cq_hub_ssn_c1'))`) as { at: number; ram: unknown };
    expect(kept.ram).toEqual({ from: '2027-02-08', to: '2027-03-09', eid: '2027-03-10' });
    // a fresh page: the copy on the phone paints the card while the read is still out
    await page.evaluate(`S._ssn=null;localStorage.setItem('cq_hub_ssn_c1',JSON.stringify({at:Date.now(),ram:{from:'2027-02-08',to:'2027-03-09',eid:'2027-03-10'}}));_hubRender()`);
    await expect(card(page)).toBeVisible();
    expect(asked).toHaveLength(1);
  });

  test('a database without the read, a refusal or a failed read shows nothing and says nothing', async ({ page }) => {
    await member(page, '2027-02-20', { 'rpc:hub_season': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.hub_season in the schema cache' } } });
    await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await expect(body(page)).not.toHaveClass(/hub-ssn-on/);
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0);
    expect(await page.evaluate(`S._ssn&&S._ssn.off`)).toBe(true);
  });

  test('a non-member answer shows nothing', async ({ page }) => {
    await member(page, '2027-02-20', { 'rpc:hub_season': { ok: false, error: 'member' } });
    await expect.poll(() => page.evaluate(`!!(S._ssn&&S._ssn.id==='c1')`)).toBe(true);
    await expect(card(page)).toHaveCount(0);
    await expect(body(page)).not.toHaveClass(/hub-ssn-on/);
  });

  test('the suite\'s default answer shows nothing', async ({ page }) => {
    await member(page, '2027-02-20', { 'rpc:hub_season': undefined });
    await expect.poll(() => page.evaluate(`!!(S._ssn&&S._ssn.id==='c1')`)).toBe(true);
    await expect(card(page)).toHaveCount(0);
  });

  test('the words exist in all ten languages, with Latin digits; the crescent is a glyph of its own', async ({ page }) => {
    await member(page, '2027-02-20');
    expect(await page.evaluate(`['ssnRam','ssnEid'].filter(k=>!HUB_T[k]||HUB_T[k].length!==11||HUB_T[k].some(x=>!String(x).trim()||/[٠-٩۰-۹०-९০-৯]/.test(x)))`)).toEqual([]);
    expect(await page.evaluate(`HUB_T.ssnRam[1]+'|'+HUB_T.ssnEid[1]`)).toBe('رمضان كريم|عيد مبارك');
    const medal = await page.evaluate(`_bdgMedal('crescent','blue')`) as string;
    expect(medal).toContain('M15.6 3.2A9.3 9.3 0 1 0 15.6 20.8');
    expect(medal).toContain('bdc-blue');
    expect(await page.evaluate(`BDG_GLYPH.crescent!==BDG_GLYPH.moon&&!!BDG_GLYPH.lantern`)).toBe(true);
  });
});

test.describe('@staff:community a seeded season challenge is moved in Activities', () => {
  const goal = { id: 'goal_ramadan_2027', kind: 'challenge', name: 'Ramadan Rhythm: 2 Sessions', name_ar: 'إيقاع رمضان: مشاركتان', scope: 'community', target: 2, starts_on: '2027-02-08', ends_on: '2027-03-09', badge_id: 'bd_ramadan_2027', ramadan_any: true };
  async function staff(page: Page, badgesInUse?: (cors: Record<string, string>) => { status: number; body: unknown }) {
    await stubSupabase(page, { sessions: [], customers: [{ id: 'c1', name: 'Lina Haddad', email: 'l@example.com', phone: '+966551000001', created_at: '2026-01-01T00:00:00Z' }], queue_entries: [], bikes: [], staff_options: [],
      tags: [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: 'green', locked: true }], customer_tags: [], titles: [], customer_titles: [],
      rotm_rounds: [], hub_goals: [goal], squads: [], squad_members: [], hub_photos: [], member_welcome: [], hub_posts: [],
      hub_ramadan: [{ year: 2027, starts_on: '2027-02-08', ends_on: '2027-03-09', confirmed: false }],
      badges: [{ id: 'bd_ramadan_2027', slug: 'ramadan_2027', name: 'Ramadan 2027', name_ar: 'رمضان 2027', retired: false, sort: 99 }, { id: 'bd_eid_2027', slug: 'eid_2027', name: 'Eid 2027', name_ar: 'عيد 2027', retired: false, sort: 100 }],
      'rpc:staff_rotm_tally': [], 'rpc:staff_goal_progress': [], 'rpc:staff_hub_numbers': {} });
    // the badges a challenge may give (Activities reads those not retired), answered apart where a test says so
    if (badgesInUse) await page.route(/\/rest\/v1\/badges\?.*retired=eq\.false/, (r) => {
      const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, a = badgesInUse(cors);
      return r.fulfill({ status: a.status, headers: cors, body: JSON.stringify(a.body) });
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
    await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
    await page.waitForFunction('S._acAt>0&&!S._acBusy&&!!S._ac');
    await page.locator('#tab-community .filter-pill', { hasText: /^Challenges/ }).click();
  }

  test('Edit fills the form with the challenge; Save writes its new dates on the same row and keeps its Ramadan flag', async ({ page }) => {
    await staff(page);
    const w: { method: string; url: string; body: Record<string, unknown> }[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/hub_goals')) w.push({ method: r.method(), url: r.url(), body: r.postDataJSON() }); });
    const row = page.locator('#tab-community [data-goal="goal_ramadan_2027"]');
    await expect(row).toContainText('Ramadan 2027');
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#ac-g-en')).toHaveValue('Ramadan Rhythm: 2 Sessions');
    await expect(page.locator('#ac-g-ar')).toHaveValue('إيقاع رمضان: مشاركتان');
    await expect(page.locator('#ac-g-scope')).toHaveValue('community');
    await expect(page.locator('#ac-g-target')).toHaveValue('2');
    await expect(page.locator('#ac-g-from')).toHaveValue('2027-02-08');
    await expect(page.locator('#ac-g-to')).toHaveValue('2027-03-09');
    await expect(page.locator('#ac-g-badge')).toHaveValue('bd_ramadan_2027');
    await page.locator('#ac-g-from').fill('2027-02-09');
    await page.locator('#ac-g-to').fill('2027-03-10');
    await page.locator('#tab-community .bdg-foot .btn-primary').click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].method).toBe('PATCH');
    expect(w[0].url).toContain('id=eq.goal_ramadan_2027');
    expect(w[0].body).toMatchObject({ starts_on: '2027-02-09', ends_on: '2027-03-10', target: 2, scope: 'community', badge_id: 'bd_ramadan_2027' });
    expect(w[0].body).not.toHaveProperty('id');
    expect(w[0].body).not.toHaveProperty('ramadan_any');
    await expect(page.locator('#ac-g-en')).toHaveCount(0);
    await expect(page.locator('#tab-community [data-goal]')).toHaveCount(1);
    expect(await page.evaluate(`S._ac.goals.find(g=>g.id==='goal_ramadan_2027').ramadan_any`)).toBe(true);
  });

  // bug hunt 2026-11-18, cf-rentals0-2: the form listed only the badges in use, so a challenge whose badge was retired (or
  // read while the badges failed to load) was saved with No badge
  test('a retired badge stays chosen through Edit and Save', async ({ page }) => {
    await staff(page, () => ({ status: 200, body: [{ id: 'bd_eid_2027', slug: 'eid_2027', name: 'Eid 2027', name_ar: 'عيد 2027', retired: false, sort: 100 }] }));
    await page.evaluate(`S.badges=[{id:'bd_ramadan_2027',slug:'ramadan_2027',name:'Ramadan 2027',name_ar:'رمضان 2027',retired:true,sort:99}]`);
    const w: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname.endsWith('/rest/v1/hub_goals')) w.push(r.postDataJSON()); });
    await page.locator('#tab-community [data-goal="goal_ramadan_2027"]').getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#ac-g-badge')).toHaveValue('bd_ramadan_2027');
    await expect(page.locator('#ac-g-badge option:checked')).toHaveText('Ramadan 2027');
    await expect(page.locator('#ac-g-badge option')).toHaveCount(3); // No badge, the challenge's own, the one in use
    await page.locator('#tab-community .bdg-foot .btn-primary').click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0]).toMatchObject({ badge_id: 'bd_ramadan_2027' });
  });

  test('with the badges unread, Edit is refused in words and nothing is written', async ({ page }) => {
    await staff(page, () => ({ status: 500, body: { code: '57014', message: 'canceling statement due to statement timeout' } }));
    const w: string[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/hub_goals')) w.push(r.method()); });
    await expect(page.locator('#tab-community [data-goal="goal_ramadan_2027"]')).toBeVisible();
    expect(await page.evaluate('S._ac.badges')).toBe(null);
    await page.locator('#tab-community [data-goal="goal_ramadan_2027"]').getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Connection error. Check your network.' })).toBeVisible();
    await expect(page.locator('#ac-g-en')).toHaveCount(0);
    expect(w).toEqual([]);
  });
});

test('@customer:members the migration: two seeded challenges from hub_ramadan, their badges, and a members-only read of the dates', () => {
  const sql = readFileSync('supabase/migrations/20261118210900_ramadan_season.sql', 'utf8');
  const code = sql.replace(/^--.*$/gm, '');
  // the badges: held only, the crescent and the lantern
  expect(code).toContain("('bd_ramadan_2027', 'ramadan_2027', 'crescent', 'blue', 'Ramadan 2027', 'رمضان 2027',");
  expect(code).toContain("('bd_eid_2027', 'eid_2027', 'lantern', 'gold', 'Eid 2027', 'عيد 2027',");
  // the Ramadan challenge is the staff template's own words and target, dated from hub_ramadan's 2027 row
  const tpl = readFileSync('app.src.html', 'utf8').match(/\{id:'ramadan',season:1,kind:'challenge',scope:'community',target:\(\)=>(\d+),en:\(\)=>'([^']+)',ar:\(\)=>'([^']+)'/);
  expect(tpl).not.toBeNull();
  expect(code).toContain(`'goal_ramadan_2027', 'challenge', '${tpl![2]}', '${tpl![3]}', 'community', ${tpl![1]},`);
  expect(code).toContain("(select starts_on from public.hub_ramadan where year = 2027)");
  expect(code).toMatch(/'bd_ramadan_2027', true, r\.starts_on::timestamp at time zone 'Asia\/Riyadh'/);
  expect(code).toMatch(/'goal_eid_2027', 'challenge', 'Eid Ride', 'رحلة العيد', 'community', 1,/);
  expect(code).toContain("(select ends_on from public.hub_ramadan where year = 2027), date '2027-03-09') + 1 as eid");
  // seeded once: staff moving hub_ramadan never moves them
  expect(code.match(/on conflict \(id\) do nothing;/g)).toHaveLength(2);
  expect(code).not.toMatch(/update public\.hub_goals/);
  // the read: definer, token first, members only, the running or next Ramadan, no Hijri
  const fn = code.slice(code.indexOf('create or replace function public.hub_season('), code.indexOf('end $$;', code.indexOf('function public.hub_season(')));
  expect(fn).toMatch(/language plpgsql stable security definer set search_path to 'public'/);
  expect(fn.indexOf('_cust_token_ok(p_id, p_token)')).toBeLessThan(fn.indexOf('_member_active(p_id)'));
  expect(fn).toContain('where h.ends_on + 3 >= v_today order by h.starts_on limit 1');
  expect(fn).not.toMatch(/hijri|islamic/i);
  expect(code).toContain('grant execute on function public.hub_season(text, text) to anon, authenticated;');
  expect(code).toContain("values ('20261118210900', 'ramadan_season')");
  expect(readFileSync('supabase/checks/security-attributes.sql', 'utf8')).toContain("('hub_season', true,");
});
