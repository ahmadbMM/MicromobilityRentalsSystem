import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Named circuit challenge (new features build F25, 2026-11-13; migration 20261114012500).
// Staff name a lap target for a season under Community > Activities > Circuit laps; its poster at the start line (or a
// plain NFC tag) holds /?lap=<code>. A scan opens the lap page (lap-page.js, fetched only then), which sends the scan to
// circuit_lap: the database counts ONE lap when the rider is signed in, is checked in on a circuit session running then
// and is past the challenge's seconds since their last lap; otherwise it adds nothing. Either way the page shows the
// rider's own count against the target and no reason. With no signal the scan is kept and sent when the connection
// returns. The target reached gives the challenge's own badge. Stats shows the same count.
// No spec reaches a database: lapServer() below answers circuit_lap by the rules the migration writes, and the last
// group reads the migration itself for those rules.

const ROOT = resolve(__dirname, '..');
const CODE = 'abc234de';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const CH = { name: 'Winter 100', name_ar: 'شتاء 100', names: { fr: 'Hiver 100' } };

type Sent = { p_id?: string; p_token?: string; p_code?: string; p_add?: boolean; p_key?: string; p_ago?: number };
type Srv = { target: number; gap: number; checkedIn: boolean; live: boolean; down: boolean; laps: number[]; keys: Set<string>; held: boolean; calls: Sent[] };

/** circuit_lap as the migration writes it, for one rider: st.laps are the times of the laps already counted. */
async function lapServer(page: Page, o: Partial<Srv> = {}) {
  const st: Srv = { target: 100, gap: 300, checkedIn: true, live: true, down: false, laps: [], keys: new Set(), held: false, calls: [], ...o };
  await page.route('**/rest/v1/rpc/circuit_lap', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS });
    if (st.down) return route.abort('internetdisconnected');
    const b = (req.postDataJSON() || {}) as Sent;
    st.calls.push(b);
    const json = (body: unknown) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!b.p_id || b.p_token !== 'tok-spec') return json({ ok: false, error: 'denied' });
    if (b.p_code !== CODE) return json({ ok: false, error: 'none' });
    let added = false, why: string | null = null;
    if (b.p_add) {
      const at = Date.now() - Math.min(Math.max(Number(b.p_ago) || 0, 0), 3600) * 1000;
      if (b.p_key && st.keys.has(b.p_key)) added = true;
      else if (!st.live) why = 'season';
      else if (!st.checkedIn) why = 'booking';
      else if (st.laps.some((t) => Math.abs(t - at) < st.gap * 1000)) why = 'gap';
      else { st.laps.push(at); if (b.p_key) st.keys.add(b.p_key); added = true; }
    }
    const n = st.laps.length, fresh = !st.held && n >= st.target;
    if (fresh) st.held = true;
    return json({ ok: true, ...CH, target: st.target, n, added, why, live: st.live, starts_on: '2026-11-01', ends_on: '2099-02-28', gap: st.gap, badge: st.held, new_badge: fresh, badge_slug: 'lap_0123456789ab' });
  });
  return st;
}
/** n laps counted long ago (each an hour apart, the last one an hour before now). */
const old = (n: number) => Array.from({ length: n }, (_, i) => Date.now() - (i + 1) * 3600e3);

async function rider(page: Page, fx: Fixtures = {}, signedIn = true) {
  await stubSupabase(page, { sessions: [], queue_entries: [], 'rpc:my_bookings': [], ...fx });
  if (signedIn) await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
}
async function scan(page: Page, lang = 'en') {
  await page.goto(`/?lap=${CODE}&lang=${lang}`);
  await waitForSb(page);
}
const pop = (page: Page) => page.locator('#lap-pop');

test.describe('@customer:laps circuit challenge: the lap page', () => {
  test('a lap is counted for a rider who is checked in: the count, the target and one line', async ({ page }) => {
    await rider(page);
    const st = await lapServer(page, { laps: old(4) });
    await scan(page);
    await expect(pop(page).locator('.lap-box')).toBeVisible();
    await expect(pop(page).locator('#lap-title')).toHaveText('Winter 100');
    await expect(pop(page).locator('#lap-n')).toHaveText('5');
    await expect(pop(page).locator('.lap-n-of')).toHaveText('/ 100 laps');
    await expect(pop(page).locator('#lap-state')).toHaveText('Lap counted');
    await expect(pop(page).locator('.lap-bar')).toHaveAttribute('aria-label', '5 of 100 laps');
    await expect(pop(page).locator('#lap-badge')).toHaveCount(0);
    // what was sent: the poster's code, the rider's own id and token, a key of the scan's own and how long ago it was
    expect(st.calls).toHaveLength(1);
    expect(st.calls[0]).toMatchObject({ p_id: 'c1', p_token: 'tok-spec', p_code: CODE, p_add: true });
    expect(st.calls[0].p_key).toMatch(/^[a-z0-9]{16}$/);
    expect(st.calls[0].p_ago).toBeGreaterThanOrEqual(0);
    expect(st.calls[0].p_ago).toBeLessThan(60);
    // the code is off the address and the scan is done with: a reload counts nothing again
    expect(new URL(page.url()).searchParams.has('lap')).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem('cq_lap'))).toBeNull();
    await page.reload();
    await waitForSb(page);
    await expect(pop(page)).toHaveCount(0);
    expect(st.calls).toHaveLength(1);
    expect(st.laps).toHaveLength(5);
  });

  test('a second scan inside the minimum interval adds nothing, and the page only shows the count', async ({ page }) => {
    await rider(page);
    const st = await lapServer(page, { laps: old(4), gap: 300 });
    await scan(page);
    await expect(pop(page).locator('#lap-n')).toHaveText('5');
    await scan(page); // straight away: well inside five minutes
    await expect(pop(page).locator('#lap-n')).toHaveText('5');
    await expect(pop(page).locator('#lap-state')).toBeHidden(); // no "Lap counted", and no reason either
    await expect(pop(page).locator('.lap-box')).not.toContainText(/interval|wait|minute|second|too soon/i);
    expect(st.calls).toHaveLength(2);
    expect(st.calls[1].p_key).not.toBe(st.calls[0].p_key); // a new scan, its own key
    expect(st.laps).toHaveLength(5);
    // the interval over, the next scan counts
    st.laps = st.laps.map((t) => t - 301e3);
    await scan(page);
    await expect(pop(page).locator('#lap-n')).toHaveText('6');
    await expect(pop(page).locator('#lap-state')).toHaveText('Lap counted');
  });

  test('without a checked-in booking nothing is added: the count as it was, said quietly', async ({ page }) => {
    await rider(page);
    const st = await lapServer(page, { laps: old(4), checkedIn: false });
    await scan(page);
    await expect(pop(page).locator('#lap-title')).toHaveText('Winter 100');
    await expect(pop(page).locator('#lap-n')).toHaveText('4');
    await expect(pop(page).locator('#lap-state')).toBeHidden();
    await expect(pop(page).locator('.lap-box')).not.toContainText(/check|booking|session/i);
    expect(st.calls).toHaveLength(1);
    expect(st.laps).toHaveLength(4);
    await pop(page).locator('#lap-close').click();
    await expect(pop(page)).toHaveCount(0);
  });

  test('the lap that reaches the target earns the season badge', async ({ page }) => {
    await rider(page);
    const st = await lapServer(page, { laps: old(4), target: 5 });
    await scan(page);
    await expect(pop(page).locator('#lap-n')).toHaveText('5');
    await expect(pop(page).locator('.lap-n-of')).toHaveText('/ 5 laps');
    await expect(pop(page).locator('#lap-badge')).toBeVisible();
    await expect(pop(page).locator('#lap-badge b')).toHaveText('Challenge complete');
    await expect(pop(page).locator('#lap-badge small')).toHaveText('Season badge earned');
    await expect(pop(page).locator('#lap-badge svg.bdg-m')).toHaveCount(1);
    await expect(pop(page).locator('.lap-bar i')).toHaveJSProperty('offsetWidth', await pop(page).locator('.lap-bar').evaluate((e) => (e as HTMLElement).clientWidth));
    expect(st.held).toBe(true);
    // one lap short of it, there is no badge
    const p2 = await page.context().newPage();
    await rider(p2);
    await lapServer(p2, { laps: old(3), target: 5 });
    await scan(p2);
    await expect(pop(p2).locator('#lap-n')).toHaveText('4');
    await expect(pop(p2).locator('#lap-badge')).toHaveCount(0);
  });

  test('with no signal the scan is kept, and it is sent with its own key when the connection returns', async ({ page }) => {
    await rider(page);
    const st = await lapServer(page, { laps: old(4), down: true });
    await scan(page);
    await expect(pop(page).locator('#lap-state')).toHaveText('Lap saved. It will be sent when you are back online.');
    await expect(pop(page).locator('#lap-title')).toHaveText('Circuit challenge');
    const kept = JSON.parse((await page.evaluate(() => sessionStorage.getItem('cq_lap'))) || '[]') as { c: string; k: string; t: number }[];
    expect(kept).toHaveLength(1);
    expect(kept[0].c).toBe(CODE);
    expect(st.calls).toHaveLength(0);
    st.down = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(pop(page).locator('#lap-n')).toHaveText('5');
    await expect(pop(page).locator('#lap-state')).toHaveText('Lap counted');
    expect(st.calls).toHaveLength(1);
    expect(st.calls[0].p_key).toBe(kept[0].k);
    expect(st.calls[0].p_add).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem('cq_lap'))).toBeNull();
  });

  test('a kept scan survives a reload, and an answer lost on the way back is not a second lap', async ({ page }) => {
    await rider(page);
    const st = await lapServer(page, { laps: old(4), down: true });
    await scan(page);
    await expect(pop(page).locator('#lap-state')).toHaveText(/Lap saved/);
    const key = (JSON.parse((await page.evaluate(() => sessionStorage.getItem('cq_lap'))) || '[]') as { k: string }[])[0].k;
    st.keys.add(key); st.laps.push(Date.now()); // the database did store it: only the answer never arrived
    st.down = false;
    await page.reload();
    await waitForSb(page);
    await expect(pop(page).locator('#lap-n')).toHaveText('5');
    await expect(pop(page).locator('#lap-state')).toHaveText('Lap counted');
    expect(st.calls[0].p_key).toBe(key);
    expect(st.laps).toHaveLength(5);
  });

  test('signed out: the page offers Sign in, and counts the scan once the rider is in', async ({ page }) => {
    await rider(page, {}, false);
    const st = await lapServer(page, { laps: old(4) });
    await scan(page);
    await expect(pop(page).locator('#lap-title')).toHaveText('Circuit challenge');
    await expect(pop(page).locator('.pg-sub')).toHaveText('Sign in to count your laps');
    expect(st.calls).toHaveLength(0);
    await pop(page).locator('#lap-signin').click();
    await expect(pop(page)).toHaveCount(0);
    await expect(page.locator('#auth-modal .auth-backdrop')).toBeVisible(); // the sign-in has the screen
    await page.evaluate(`S.loggedIn={id:'c1',name:'Spec Rider',email:'spec@example.com',phone:'0500000001',session_token:'tok-spec'};S.rememberMe=true;setSession(S.loggedIn)`);
    await expect(pop(page).locator('#lap-n')).toHaveText('5', { timeout: 8000 });
    await expect(pop(page).locator('#lap-state')).toHaveText('Lap counted');
    expect(st.calls).toHaveLength(1);
    expect(st.calls[0]).toMatchObject({ p_id: 'c1', p_code: CODE, p_add: true });
  });

  test('a session the database no longer takes waits for a sign-in and is not asked again and again', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [], 'rpc:my_bookings': [] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok-old' });
    const st = await lapServer(page, { laps: old(4) });
    await scan(page);
    await expect(pop(page).locator('.pg-sub')).toHaveText('Sign in to count your laps');
    await page.waitForTimeout(4500); // two looks for a sign-in
    expect(st.calls).toHaveLength(1);
    expect(st.laps).toHaveLength(4);
  });

  test('a database from before the challenge, or a poster it does not know: nothing is shown and nothing is kept', async ({ page }) => {
    await rider(page); // circuit_lap answers PGRST202 here, as production does until the migration runs
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/circuit_lap')) asked.push(r.method()); });
    await scan(page);
    await expect.poll(() => asked.filter((m) => m === 'POST').length).toBe(1);
    await expect(pop(page)).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('cq_lap'))).toBeNull();
    expect(await page.evaluate(`S.view`)).toBe('landing'); // the app itself opened as usual

    const p2 = await page.context().newPage();
    await rider(p2);
    const st = await lapServer(p2);
    await p2.goto('/?lap=zzzz9999');
    await waitForSb(p2);
    await expect.poll(() => st.calls.length).toBe(1);
    await expect(pop(p2)).toHaveCount(0);
    expect(await p2.evaluate(() => sessionStorage.getItem('cq_lap'))).toBeNull();
  });

  test('the page is its own file, fetched only by a scan; a code that is not one is ignored', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('lap-page.js')) asked.push(r.url()); });
    await rider(page);
    const st = await lapServer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.goto('/?lap=' + encodeURIComponent('<b>x</b>'));
    await waitForSb(page);
    expect(new URL(page.url()).searchParams.has('lap')).toBe(false);
    expect(asked).toEqual([]);
    expect(st.calls).toHaveLength(0);
    await scan(page);
    await expect(pop(page).locator('#lap-n')).toHaveText('1');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\/lap-page\.js\?v=[0-9a-f]{10}$/);
  });

  test('the name is staff\'s own in the reader\'s language, and the pop-up sits under the forced pages', async ({ page }) => {
    await rider(page);
    await lapServer(page, { laps: old(4) });
    await scan(page, 'ar');
    await expect(pop(page).locator('#lap-title')).toHaveText('شتاء 100');
    await expect(pop(page).locator('#lap-state')).toHaveText('تم احتساب اللفة');
    await expect(pop(page).locator('.lap-n-of')).toHaveText('/ 100 لفة');
    expect(await pop(page).locator('.auth-backdrop').evaluate((e) => getComputedStyle(e).zIndex)).toBe('198');
    expect(await pop(page).locator('.lap-box').getAttribute('role')).toBe('dialog');
    await page.keyboard.press('Escape');
    await expect(pop(page)).toHaveCount(0);

    const p2 = await page.context().newPage();
    await rider(p2);
    await lapServer(p2, { laps: old(4) });
    await scan(p2, 'fr');
    await expect(pop(p2).locator('#lap-title')).toHaveText('Hiver 100');
    await expect(pop(p2).locator('#lap-state')).toHaveText('Tour compté');
    const p3 = await page.context().newPage();
    await rider(p3);
    await lapServer(p3, { laps: old(4) });
    await scan(p3, 'bn'); // no Bengali name was written: the English one
    await expect(pop(p3).locator('#lap-title')).toHaveText('Winter 100');
    await expect(pop(p3).locator('.lap-n-of')).toHaveText('/ 100 ল্যাপ');
  });

  test('every word of the page is there in all ten languages, with the same blanks and Latin digits', async ({ page }) => {
    await rider(page);
    await lapServer(page);
    await scan(page);
    await expect(pop(page).locator('#lap-n')).toHaveText('1');
    expect(await page.evaluate(`LAP_LANGS`)).toEqual(['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']);
    const T = await page.evaluate(`LAP_T`) as Record<string, string[]>;
    expect(Object.keys(T).length).toBeGreaterThanOrEqual(10);
    for (const [k, row] of Object.entries(T)) {
      expect(row, k).toHaveLength(10);
      const blanks = (s: string) => (s.match(/\{\d\}/g) || []).sort().join();
      for (const s of row) {
        expect(String(s).trim(), k).not.toBe('');
        expect(blanks(s), k).toBe(blanks(row[0]));
        expect(s, k).not.toMatch(/[٠-٩۰-۹०-९০-৯]/);
      }
    }
  });
});

test.describe('@customer:account circuit challenge: the laps on Stats', () => {
  const mine = (o: Record<string, unknown> = {}) => ({ ok: true, list: [{ ...CH, target: 100, n: 12, starts_on: '2026-11-01', ends_on: '2099-02-28', badge: false, ...o }] });
  async function stats(page: Page, fx: Fixtures, lang = 'en') {
    await rider(page, fx);
    await page.goto('/account/stats?lang=' + lang);
    await waitForSb(page);
    await page.evaluate(`_bdgPopClose()`);
    await expect(page.locator('#acc-pane-stats .mr-season')).toBeVisible();
  }
  const card = (page: Page) => page.locator('#acc-pane-stats #lap-stats .lap-c');

  test('a running challenge shows its name, a bar and the rider\'s own laps against the target', async ({ page }) => {
    const asked: Sent[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/circuit_mine')) asked.push(r.postDataJSON() as Sent); });
    await stats(page, { 'rpc:circuit_mine': mine() });
    await expect(card(page)).toHaveCount(1);
    await expect(card(page).locator('.myr-h')).toHaveText('Winter 100');
    await expect(card(page).locator('dt')).toHaveText(['Laps']);
    await expect(card(page).locator('dd')).toHaveText(['12/100']);
    const [bar, fill] = [await card(page).locator('.lap-bar').evaluate((e) => (e as HTMLElement).clientWidth), await card(page).locator('.lap-bar i').evaluate((e) => (e as HTMLElement).offsetWidth)];
    expect(Math.abs(fill - bar * 0.12)).toBeLessThan(1.5);
    expect(asked[0]).toEqual({ p_id: 'c1', p_token: 'tok-spec' }); // the rider's own, nothing else asked
    await expect(card(page)).not.toContainText(/rank|faster|fastest|speed|km\/h|other riders/i);
  });

  test('no laps yet still shows the challenge; the target reached says so; the name follows the language', async ({ page }) => {
    await stats(page, { 'rpc:circuit_mine': mine({ n: 0 }) });
    await expect(card(page).locator('dd')).toHaveText(['0/100']);
    expect(await card(page).locator('.lap-bar i').evaluate((e) => (e as HTMLElement).offsetWidth)).toBe(0);
    const p2 = await page.context().newPage();
    await stats(p2, { 'rpc:circuit_mine': mine({ n: 104, badge: true }) }, 'ar');
    await expect(card(p2).locator('.myr-h')).toHaveText('شتاء 100');
    await expect(card(p2).locator('dt')).toHaveText(['اللفات', 'اكتمل التحدي']);
    await expect(card(p2).locator('dd').first()).toHaveText('104/100');
    const [bar, fill] = [await card(p2).locator('.lap-bar').evaluate((e) => (e as HTMLElement).clientWidth), await card(p2).locator('.lap-bar i').evaluate((e) => (e as HTMLElement).offsetWidth)];
    expect(fill).toBe(bar); // never past the end
    const p3 = await page.context().newPage();
    await stats(p3, { 'rpc:circuit_mine': mine() }, 'fr');
    await expect(card(p3).locator('.myr-h')).toHaveText('Hiver 100');
    await expect(card(p3).locator('dt')).toHaveText(['Tours']);
  });

  test('none running, or a database from before the challenge: Stats draws nothing for it and asks once', async ({ page }) => {
    await stats(page, { 'rpc:circuit_mine': { ok: true, list: [] } });
    await expect(page.locator('#acc-pane-stats #lap-stats')).toBeHidden();
    await expect(card(page)).toHaveCount(0);

    const p2 = await page.context().newPage();
    let n = 0;
    p2.on('request', (r) => { if (r.url().includes('/rpc/circuit_mine') && r.method() === 'POST') n++; });
    await stats(p2, { 'rpc:circuit_mine': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.circuit_mine in the schema cache' } } });
    await expect(card(p2)).toHaveCount(0);
    await p2.waitForFunction('S._lapOff===true');
    await p2.evaluate(`S._lapMine=null;renderAccount()`);
    await p2.evaluate(`S._lapMine=null;renderAccount()`);
    expect(n).toBe(1);
  });

  test('a lap counted on the lap page moves the count on Stats', async ({ page }) => {
    const m = mine({ n: 4 });
    await rider(page, {});
    await page.route('**/rest/v1/rpc/circuit_mine', (route) => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 200, headers: CORS })
      : route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(m) }));
    const st = await lapServer(page, { laps: old(4) });
    await page.goto('/account/stats');
    await waitForSb(page);
    await page.evaluate(`_bdgPopClose()`);
    await expect(card(page).locator('dd')).toHaveText(['4/100']);
    // a scan in this same tab (the poster's address, opened again)
    m.list[0].n = 5;
    await page.evaluate(`history.replaceState(history.state,'','/account/stats?lap=${CODE}');_readLapParam()&&_lapLoad()`);
    await expect(pop(page).locator('#lap-n')).toHaveText('5');
    expect(st.laps).toHaveLength(5);
    await pop(page).locator('#lap-close').click();
    await expect(card(page).locator('dd')).toHaveText(['5/100']);
  });
});

test.describe('@staff:community circuit challenge: Community > Activities > Circuit laps', () => {
  const row = { id: 'cc_1', code: CODE, ...CH, target: 100, starts_on: '2026-11-01', ends_on: '2027-02-28', min_gap_s: 300, badge_id: 'bd_lap_0123456789ab', created_by: 'Spec Staff', created_at: '2026-11-13T10:00:00Z' };
  async function staff(page: Page, fx: Fixtures = {}) {
    const f: Fixtures = { sessions: [], customers: [{ id: 'c1', name: 'Lina Haddad', phone: '0500000001', created_at: 1 }], queue_entries: [], bikes: [], staff_options: [],
      rotm_rounds: [], hub_goals: [], squads: [], squad_members: [], hub_photos: [], member_welcome: [], hub_posts: [], badges: [],
      circuit_challenges: [row], 'rpc:staff_circuit_totals': [{ id: 'cc_1', riders: 14, laps: 230, done: 2 }], ...fx };
    for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k]; // undefined: as a database without it
    await stubSupabase(page, f);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
    await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
    await page.waitForFunction('S._acAt>0&&!S._acBusy&&!!S._ac');
    await page.locator('#tab-community .filter-pill', { hasText: /^Circuit laps$/ }).click();
    await page.waitForFunction('S._acLapAt>0&&!S._acLapBusy');
  }
  const writes = (page: Page) => {
    const out: { method: string; url: string; body: Record<string, unknown> }[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'OPTIONS' && new URL(r.url()).pathname.endsWith('/rest/v1/circuit_challenges')) out.push({ method: r.method(), url: r.url(), body: (r.postDataJSON() || {}) as Record<string, unknown> }); });
    return out;
  };
  const line = (page: Page) => page.locator('#tab-community .am-tag-row[data-lap="cc_1"]');

  test('a challenge\'s row: its name, target, seconds between laps, season and counts; the poster shows the code and the address', async ({ page }) => {
    await staff(page);
    await expect(line(page).locator('strong')).toHaveText('Winter 100');
    await expect(line(page).locator('.am-meta')).toContainText('100 laps · at least 300 s apart');
    await expect(line(page).locator('.am-meta')).toContainText('14 riders · 230 laps · 2 finished');
    await expect(page.locator('#tab-community .bk-page')).toHaveCount(0);
    await line(page).getByRole('button', { name: 'Poster' }).click();
    const box = page.locator('#tab-community .bk-page');
    await expect(box.locator('.bk-page-qr svg')).toBeVisible();
    await expect(box.locator('.bk-page-url')).toHaveText(`experiences.micromobility.sa/?lap=${CODE}`);
    await expect(box.locator('.bk-page-url')).toHaveAttribute('href', `https://experiences.micromobility.sa/?lap=${CODE}`);
    await expect(box.locator('.bk-page-sub')).toContainText('plain NFC tag');
    const [dl] = await Promise.all([page.waitForEvent('download'), box.getByRole('button', { name: 'Download the code' }).click()]);
    expect(dl.suggestedFilename()).toBe(`circuit-challenge-${CODE}.svg`);
  });

  test('a new challenge: both names, the other languages written, the target, the season and the seconds between laps', async ({ page }) => {
    await staff(page);
    const w = writes(page);
    await page.getByRole('button', { name: '+ New circuit challenge' }).click();
    await expect(page.locator('#ac-l-gap')).toHaveValue('300');
    await expect(page.locator('label[for="ac-l-n-fr"]')).toHaveText('Name (Français)');
    expect(await page.locator('#tab-community .inline-form input[id^="ac-l-n-"]').count()).toBe(8);
    await page.locator('#ac-l-en').fill('Spring 50');
    // no Arabic name, no last day: refused here, nothing sent
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Fill in both names, a lap target, valid dates and 10 seconds or more between laps.')).toBeVisible();
    expect(w).toHaveLength(0);
    await page.locator('#ac-l-ar').fill('ربيع 50');
    await page.locator('#ac-l-n-es').fill('Primavera 50');
    await page.locator('#ac-l-target').fill('50');
    await page.locator('#ac-l-gap').fill('240');
    await page.locator('#ac-l-from').fill('2027-03-01');
    await page.locator('#ac-l-to').fill('2027-05-31');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].method).toBe('POST');
    expect(w[0].body).toEqual({ name: 'Spring 50', name_ar: 'ربيع 50', names: { es: 'Primavera 50' }, target: 50, min_gap_s: 240, starts_on: '2027-03-01', ends_on: '2027-05-31', created_by: 'Spec Staff' });
    await expect(page.locator('#ac-l-en')).toHaveCount(0); // the form is put away
  });

  test('changing one and deleting one: the form opens filled, and Delete asks twice', async ({ page }) => {
    await staff(page);
    const w = writes(page);
    await line(page).getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#ac-l-en')).toHaveValue('Winter 100');
    await expect(page.locator('#ac-l-ar')).toHaveValue('شتاء 100');
    await expect(page.locator('#ac-l-n-fr')).toHaveValue('Hiver 100');
    await expect(page.locator('#ac-l-to')).toHaveValue('2027-02-28');
    await page.locator('#ac-l-to').fill('2027-03-31');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].method).toBe('PATCH');
    expect(new URL(w[0].url).searchParams.get('id')).toBe('eq.cc_1');
    expect(w[0].body).toMatchObject({ name: 'Winter 100', names: { fr: 'Hiver 100' }, target: 100, min_gap_s: 300, ends_on: '2027-03-31' });
    expect(w[0].body).not.toHaveProperty('code'); // the poster already printed keeps its address
    await page.waitForFunction('!S._acLapBusy');
    await line(page).getByRole('button', { name: 'Delete' }).click();
    expect(w).toHaveLength(1);
    await line(page).getByRole('button', { name: 'Tap again to confirm' }).click();
    await expect.poll(() => w.length).toBe(2);
    expect(w[1].method).toBe('DELETE');
    await expect(line(page)).toHaveCount(0);
  });

  test('an account that only views People gets the list and the poster, no control that writes', async ({ page }) => {
    await staff(page);
    await page.evaluate(`S._myEdit=[];renderCommunity()`);
    await expect(line(page).getByRole('button', { name: 'Poster' })).toBeVisible();
    await expect(line(page).getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(line(page).getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '+ New circuit challenge' })).toHaveCount(0);
  });

  test('a database from before the table says so on this tab and keeps the others; without the counts the rows still show', async ({ page }) => {
    await staff(page, { circuit_challenges: undefined });
    await expect(page.locator('#tab-community')).toContainText('Activities are not set up on the database yet.');
    await page.locator('#tab-community .filter-pill', { hasText: /^Challenges$/ }).click();
    await expect(page.getByRole('button', { name: '+ New challenge or goal' })).toBeVisible();

    const p2 = await page.context().newPage();
    await staff(p2, { 'rpc:staff_circuit_totals': undefined }); // PGRST202
    await expect(line(p2).locator('.am-meta')).toContainText('100 laps · at least 300 s apart');
    await expect(line(p2).locator('.am-meta')).not.toContainText('riders');
  });
});

test.describe('@staff:community circuit challenge: the migration', () => {
  const sql = readFileSync(resolve(ROOT, 'supabase/migrations/20261114012500_circuit_challenge.sql'), 'utf8');
  const fn = (name: string) => { const i = sql.indexOf(`create or replace function public.${name}(`); return sql.slice(i, sql.indexOf('end $$;', i)); };

  test('circuit_lap counts only a signed-in rider, checked in on a running circuit session, past the interval', () => {
    const f = fn('circuit_lap');
    expect(f).toContain("if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;");
    expect(f).toContain("q.status = 'active'"); // checked in, not yet checked out
    expect(f).toContain("coalesce(s.event_kind, '') <> 'community' or s.ride_kind in ('petromin', 'snd96')"); // bikes on the circuit, never the Saturday road ride or a bike-free kind
    expect(f).toMatch(/v_at >= w\.starts_at - interval '15 minutes' and v_at <= w\.ends_at \+ interval '30 minutes'/); // running then
    expect(f).toContain('l.at > v_at - make_interval(secs => c.min_gap_s)'); // the minimum interval, either side of the lap
    expect(f).toContain('v_today between c.starts_on and c.ends_on'); // the season
    expect(f).toContain('pg_advisory_xact_lock'); // two taps of one scan cannot both pass
    expect(f).toContain('l.client_key = v_key'); // a retry is the same lap
    expect(f).toContain('least(greatest(coalesce(p_ago, 0), 0), 3600)'); // a kept scan counts at its own time, an hour back at most
    // the badge at the target, once
    expect(f).toMatch(/v_n >= c\.target[\s\S]*insert into customer_badges \(customer_id, badge_id, awarded_by, note\)[\s\S]*on conflict do nothing/);
  });

  test('what riders get back is their own count: no name, time, speed or rank of anyone', () => {
    for (const name of ['circuit_lap', 'circuit_mine']) {
      const f = fn(name);
      const out = f.slice(f.lastIndexOf('jsonb_build_object('));
      expect(out, name).not.toMatch(/customers|\.phone|\.email|rank|speed|leader/i);
      expect(f, name).toContain('l.customer_id = any(v_accts)'); // every count is of the caller's own accounts
      expect(f, name).not.toMatch(/'at'|'laps',|'times'/);
    }
    expect(sql).toContain('revoke all on public.circuit_laps from public, anon, authenticated;'); // nobody reads the laps table
    expect(sql).not.toMatch(/grant [a-z, ]+ on public\.circuit_laps/);
    expect(sql).toContain("if not coalesce(_staff_mod('community', false), false) then raise exception 'not staff'");
    expect(sql).toContain('revoke all on function public.staff_circuit_totals() from public, anon;');
  });

  test('each challenge has its own badge, made with it, and the checks list names every new function', () => {
    expect(sql).toMatch(/create trigger circuit_challenges_badge before insert or update on public\.circuit_challenges/);
    expect(fn('_circuit_badge')).toContain("'lapring', 'gold'");
    const checks = readFileSync(resolve(ROOT, 'supabase/checks/security-attributes.sql'), 'utf8');
    for (const name of ['circuit_lap', 'circuit_mine', 'staff_circuit_totals', '_circuit_badge', '_circuit_badge_gone', '_circuit_ts']) expect(checks, name).toContain(`('${name}',`);
  });
});
