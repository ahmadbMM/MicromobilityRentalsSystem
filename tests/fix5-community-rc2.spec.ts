import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Community fixes of 2026-10-05 (fix5, slice rc2): Race Ready counted on staff devices, the earned
// badges' holders recounted when what they are worked out from changes, a failed badges or follower
// read said as a connection error and tried again soon, a note typed for one badge not carried to the
// next, gives that never write over another desk's badge (and Undo only what this desk gave), the
// badge editor's choices named in the staff language, the Duplicates grouping kept between paints,
// the merges list's arrow in Arabic, and "Looks fine" written against the row as it was read.
// All Supabase traffic is stubbed; every name and number is invented.

const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const P1 = day(-3);
const slots = JSON.stringify({ _time: '21:00 - 23:00', _total: 40 });
const sessions = [{ id: P1, day: 'Friday', session_date: P1, capacity: 40, status: 'closed', created_at: 0, bike_slots: slots }];
// Everything the profile meter counts but the photo, which a staff device never holds.
const full = { email: 'x@example.com', height: 172, birth_date: '1990-04-04', country: 'SA', city: 'Jeddah', type_preference: 'Road', gender: 'female' };
const customers = [
  { id: 'c1', name: 'Lana Fixture', phone: '+966551870001', created_at: '2026-06-10T09:00:00Z', ...full, email: 'lana@example.com' },
  { id: 'c2', name: 'Omar Fixture', email: 'omar@example.com', phone: '+966551870002', gender: 'male', created_at: '2026-06-11T09:00:00Z' },
  { id: 'c3', name: 'Sami Fixture', email: 'sami@example.com', phone: '+966551870003', gender: 'male', created_at: '2026-06-12T09:00:00Z' },
];
const row = (id: string, qn: number, name: string, customer_id: string | null, status = 'done', paid = true) => ({
  id, session_id: P1, session_day: 'Friday', session_date: P1, queue_num: qn, name, phone: '0551112222',
  customer_id, status, paid, type_preference: 'Road', price: 115, walk_in: !customer_id, registered_at: '2026-09-01T10:00:00Z',
});
const queue_entries = [row('q1', 1, 'Lana Fixture', 'c1'), row('q2', 2, 'Omar Fixture', 'c2'), row('q3', 3, 'Sami Fixture', 'c3')];
const badges = [
  { id: 'bd_complete_profile', slug: 'complete_profile', icon: 'profile', color: 'gold', name: 'Race Ready', system: true, auto: true, retired: false, sort: 5 },
  { id: 'bd_first_lap', slug: 'first_lap', icon: 'flag', color: 'green', name: 'First Lap', system: true, auto: true, retired: false, sort: 100 },
  { id: 'bd_marshal', slug: 'marshal', icon: 'shield', color: 'orange', name: 'Marshal', system: true, auto: false, retired: false, sort: 10 },
  { id: 'bd_champion', slug: 'champion', icon: 'trophy', color: 'gold', name: 'Champion', system: true, auto: false, retired: false, sort: 60 },
];

async function staff(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions, customers, queue_entries, bikes: [], tags: [], customer_tags: [], staff_options: [], badges, customer_badges: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffRole='admin'`);
}
const community = async (page: Page, tab: string) => {
  await page.evaluate(`setStaffTab('community');S.communityTab='${tab}';renderCommunity()`);
  await page.waitForFunction('S._bdgAt>0&&!S._bdgBusy');
};
const sent = (page: Page, table: string, method?: string) => {
  const out: Request[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && (!method || r.method() === method) && new URL(r.url()).pathname.endsWith('/rest/v1/' + table)) out.push(r);
  });
  return out;
};
const reads = (page: Page, table: string) => {
  let n = 0;
  page.on('request', (r) => { if (r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/' + table)) n++; });
  return () => n;
};
const json = (body: unknown, status = 200) => ({ status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(body) });

test.describe('@staff:community fix5 rc2 badges', () => {
  test('Race Ready counts on a staff device, whose rows never carry the photo; the rider\'s own meter still asks for it', async ({ page }) => {
    await staff(page);
    await community(page, 'badges');
    expect(await page.evaluate(`'photo' in _custById('c1')`)).toBe(false);
    expect(await page.evaluate(`_bdgRideOn('c1').has('complete_profile')`)).toBe(true);
    expect(await page.evaluate(`_bdgRideOn('c2').has('complete_profile')`)).toBe(false); // half a profile is not ready
    expect(await page.evaluate(`[..._bdgAutoHolders().get('complete_profile')||[]]`)).toEqual(['c1']);
    await expect(page.locator('.bdg-row[data-badge="bd_complete_profile"]')).toContainText('1 holders');
    // The rider's page holds the photo column: one without a photo is not at 100 there.
    expect(await page.evaluate(`_profPct({..._custById('c1'),photo:null})`)).toBeLessThan(100);
    expect(await page.evaluate(`_profPct({..._custById('c1'),photo:'https://example.com/p.webp'})`)).toBe(100);
  });

  test('the earned holders are worked out again when the accounts, the catalogue or the weeks change, not only the bookings', async ({ page }) => {
    await staff(page);
    await community(page, 'badges');
    const first = await page.evaluate(`_bdgAutoHolders()`);
    expect(await page.evaluate(`_bdgAutoHolders()===_bdgAutoHolders()`)).toBe(true); // kept while nothing moves
    expect(first).toBeTruthy();
    // Lana's height is taken off her account: Race Ready is no longer hers, with the bookings unchanged.
    await page.evaluate(`S.customers=S.customers.map(c=>c.id==='c1'?{...c,height:null}:c)`);
    expect(await page.evaluate(`[..._bdgAutoHolders().get('complete_profile')||[]]`)).toEqual([]);
    const a = await page.evaluate(`(()=>{const x=_bdgAutoHolders();S._bdgWeeks=[{w:'${P1}',ids:['${P1}']}];return x!==_bdgAutoHolders();})()`);
    expect(a).toBe(true);
    const b = await page.evaluate(`(()=>{const x=_bdgAutoHolders();S.badges=S.badges.slice();return x!==_bdgAutoHolders();})()`);
    expect(b).toBe(true);
  });

  test('a badges read that fails on the network says so and is tried again soon; missing tables still say "not set up"', async ({ page }) => {
    await staff(page);
    let fail = true;
    await page.route('**/rest/v1/badges*', (r) => (fail ? r.fulfill(json({ message: 'upstream request timeout' }, 504)) : r.fallback()));
    await page.evaluate(`S.badges=undefined;S.custBadges=undefined;S._bdgAt=0;S._bdgErr=false`);
    const n = reads(page, 'badges');
    await community(page, 'badges');
    await expect(page.locator('#tab-community .empty-state')).toHaveText('Connection error. Check your network.');
    expect(await page.evaluate('S._bdgErr')).toBe(true);
    const before = n();
    // A repaint inside the retry window does not read again (no loop), one after it does.
    await page.evaluate(`renderCommunity()`);
    await page.waitForTimeout(150);
    expect(n()).toBe(before);
    fail = false;
    await page.evaluate(`S._bdgAt=Date.now()-BDG_RETRY_MS-1000;renderCommunity()`);
    await expect.poll(() => n()).toBeGreaterThan(before);
    await expect(page.locator('#tab-community .bdg-row')).toHaveCount(4);
    expect(await page.evaluate('S._bdgErr')).toBe(false);
  });

  test('a rider\'s dialog opened after a failed read reads again at once', async ({ page }) => {
    await staff(page);
    await page.route('**/rest/v1/badges*', (r) => r.fulfill(json({ message: 'timeout' }, 504)));
    await page.evaluate(`S.badges=undefined;S.custBadges=undefined;S._bdgAt=0;S._bdgErr=false`);
    await page.evaluate(`_bdgLoad()`);
    await page.waitForFunction('S._bdgErr===true&&!S._bdgBusy');
    const n = reads(page, 'badges');
    await page.evaluate(`_bdgOpen('c2')`);
    await expect(page.locator('#confirm-modal .bdg-dlg .am-meta').first()).toHaveText('Connection error. Check your network.');
    expect(n()).toBe(1);
  });

  test('a follower-count read that fails on the network says so in the dialog; a missing table does not', async ({ page }) => {
    const cs = customers.map((c) => (c.id === 'c2' ? { ...c, socials: { instagram: 'omar.fixture' } } : c));
    await staff(page, { customers: cs, customer_ig_followers: [] });
    await page.route('**/rest/v1/customer_ig_followers*', (r) => r.fulfill(json({ message: 'upstream request timeout' }, 504)));
    await page.evaluate(`S.igRows=undefined;S._igAt=0;S._igErr=false;_igLoad()`);
    await page.waitForFunction('S._igErr===true&&!S._igBusy');
    await page.evaluate(`_igOpen('c2')`);
    await expect(page.locator('#confirm-modal .ig-dlg .ig-now')).toHaveText('Connection error. Check your network.');
    await page.evaluate(`_igClose()`);
    await page.unroute('**/rest/v1/customer_ig_followers*');
    await page.route('**/rest/v1/customer_ig_followers*', (r) => r.fulfill(json({ code: '42P01', message: 'relation does not exist' }, 404)));
    await page.evaluate(`_igLoad(true)`);
    await page.waitForFunction('S._igErr===false&&!S._igBusy');
    await page.evaluate(`_igOpen('c2')`);
    await expect(page.locator('#confirm-modal .ig-dlg .ig-now')).toHaveText('Follower counts are not set up on the database yet.');
  });

  test('a note typed for one badge is not carried to another badge\'s panel', async ({ page }) => {
    await staff(page);
    await community(page, 'badges');
    const marshal = page.locator('.bdg-row[data-badge="bd_marshal"]'), champ = page.locator('.bdg-row[data-badge="bd_champion"]');
    await marshal.getByRole('button', { name: 'Give to a ride', exact: true }).click();
    await marshal.locator('#bdg-rnote').fill('Swept the Friday ride');
    await champ.getByRole('button', { name: 'Give to a ride', exact: true }).click();
    await expect(champ.locator('#bdg-rnote')).toHaveValue('');
    await champ.getByRole('button', { name: 'Give to a rider' }).click();
    await champ.getByLabel('Find a rider').fill('omar');
    await champ.locator('#bdg-rinote').fill('Champion of the sprint');
    await marshal.getByRole('button', { name: 'Give to a rider' }).click();
    await expect(marshal.getByLabel('Find a rider')).toHaveValue('');
    await expect(marshal.locator('#bdg-rinote')).toHaveValue('');
    expect(await page.evaluate('[S._bdgRideNote,S._bdgRiderNote,S._bdgRiderQ]')).toEqual(['', '', '']);
  });

  test('give to a ride merges and takes back only the riders it went to, never another desk\'s gift', async ({ page }) => {
    await staff(page);
    await community(page, 'badges');
    // Another desk gave Omar the badge a moment ago: the database keeps theirs and answers the insert
    // with Lana and Sami only; a read afterwards holds all three.
    const theirs = { customer_id: 'c2', badge_id: 'bd_marshal', note: 'From the other desk', session_id: P1, awarded_by: 'Desk Two', awarded_at: '2026-10-05T08:00:00Z' };
    const held: Record<string, unknown>[] = [theirs];
    await page.route('**/rest/v1/customer_badges*', async (r) => {
      const req = r.request();
      if (req.method() === 'GET') return r.fulfill(json(held));
      if (req.method() !== 'POST') return r.fallback();
      const went = (req.postDataJSON() as Record<string, unknown>[]).filter((x) => x.customer_id !== 'c2');
      held.push(...went);
      return r.fulfill(json(went.map((x) => ({ customer_id: x.customer_id, badge_id: x.badge_id })), 201));
    });
    const w = sent(page, 'customer_badges');
    const marshal = page.locator('.bdg-row[data-badge="bd_marshal"]');
    await marshal.getByRole('button', { name: 'Give to a ride', exact: true }).click();
    await marshal.getByRole('button', { name: 'Give to 3 riders' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].headers()['prefer']).toContain('resolution=ignore-duplicates');
    expect(w[0].headers()['prefer']).toContain('return=representation');
    expect(new URL(w[0].url()).searchParams.get('select')).toBe('customer_id,badge_id');
    await expect.poll(() => page.evaluate(`S.undoStack.length`)).toBe(1);
    expect(await page.evaluate(`(S.undoStack.at(-1)||{}).label`)).toContain('to 2 riders');
    // The other desk's badge is read in as theirs: its note and giver stand.
    await expect.poll(() => page.evaluate(`(S.custBadges||[]).filter(x=>x.badge_id==='bd_marshal').map(x=>x.customer_id).sort().join()`)).toBe('c1,c2,c3');
    expect(await page.evaluate(`(S.custBadges.find(x=>x.customer_id==='c2')||{}).awarded_by`)).toBe('Desk Two');
    await page.evaluate(`doUndo()`);
    await expect.poll(() => w.length).toBe(2);
    expect(w[1].method()).toBe('DELETE');
    const inList = decodeURIComponent(new URL(w[1].url()).searchParams.get('customer_id') || '');
    expect(inList).toBe('in.(c1,c3)');
  });

  test('give to a rider never writes over another desk\'s badge, and gives nothing to undo when it was given meanwhile', async ({ page }) => {
    await staff(page);
    await community(page, 'badges');
    let answer: unknown[] | null = null;
    await page.route('**/rest/v1/customer_badges*', async (r) => {
      if (r.request().method() !== 'POST' || answer === null) return r.fallback();
      return r.fulfill(json(answer, 201));
    });
    const w = sent(page, 'customer_badges');
    const n = reads(page, 'badges');
    const marshal = page.locator('.bdg-row[data-badge="bd_marshal"]');
    await marshal.getByRole('button', { name: 'Give to a rider' }).click();
    await marshal.getByLabel('Find a rider').fill('omar');
    answer = []; // the database kept the other desk's row: nothing went in
    await marshal.locator('#bdg-rider-res .bdg-hold[data-cust="c2"]').getByRole('button', { name: 'Give badge' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].headers()['prefer']).toContain('resolution=ignore-duplicates');
    await expect.poll(() => n()).toBeGreaterThan(0); // the other desk's badge is read in
    expect(await page.evaluate(`S.undoStack.length`)).toBe(0);
    expect(await page.evaluate(`(S.custBadges||[]).some(x=>x.customer_id==='c2'&&x.badge_id==='bd_marshal')`)).toBe(false);
    // The rider's dialog gives the same way.
    answer = null;
    await page.evaluate(`_bdgOpen('c3')`);
    const dlg = page.locator('#confirm-modal .bdg-dlg');
    await dlg.locator('.bdg-pick', { hasText: 'Champion' }).click();
    await dlg.getByRole('button', { name: 'Give badge' }).click();
    await expect.poll(() => w.length).toBe(2);
    expect(w[1].headers()['prefer']).toContain('resolution=ignore-duplicates');
    await expect(dlg.locator('.bdg-list')).toContainText('Champion');
    expect(await page.evaluate(`S.undoStack.length`)).toBe(1);
  });

  test('the badge editor names its colours and icons in the staff language', async ({ page }) => {
    await staff(page);
    await community(page, 'badges');
    await page.getByRole('button', { name: '+ New badge' }).click();
    const form = page.locator('#tab-community .bdg-form');
    const n = await page.evaluate(`Object.keys(BDG_GLYPH).length`) as number;
    const bolt = await page.evaluate(`Object.keys(BDG_GLYPH).indexOf('bolt')`) as number;
    await expect(form.locator('.bdg-ico').nth(bolt)).toHaveAttribute('aria-label', `Icon ${bolt + 1} of ${n}`);
    await expect(form.locator('.bdg-sw')).toHaveCount(8);
    for (const name of ['Green', 'Gold', 'Blue', 'Red', 'Purple', 'Orange', 'Teal', 'Silver']) await expect(form.getByRole('button', { name, exact: true })).toHaveCount(1);
    await form.getByRole('button', { name: 'Teal', exact: true }).click();
    await expect(form.locator('.bdg-sw.bdc-teal')).toHaveAttribute('aria-pressed', 'true');
    // No label is a code name any more.
    const labels = await form.locator('.bdg-ico, .bdg-sw').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(labels.filter((l) => /^[a-z0-9]+$/.test(String(l)))).toEqual([]);
    await page.evaluate(`setLang('ar')`);
    await expect.poll(() => page.evaluate(`t('bdgClrGreen')`)).toBe('أخضر');
    await page.evaluate(`renderCommunity()`);
    await expect(page.locator('#tab-community .bdg-form .bdg-sw.bdc-green')).toHaveAttribute('aria-label', 'أخضر');
    await expect(page.locator('#tab-community .bdg-form .bdg-ico').first()).toHaveAttribute('aria-label', `الأيقونة 1 من ${n}`);
  });
});

test.describe('@staff:community fix5 rc2 duplicates and looks fine', () => {
  const dupCustomers = [
    { id: 'd1', name: 'Amal Fixture', email: 'amal@example.com', phone: '+966500000101', created_at: '2026-01-01T10:00:00Z', birth_date: '1990-05-05' },
    { id: 'd2', name: 'Amal Fixture', email: 'amal.f@example.com', phone: '+966500000101', created_at: '2026-03-01T10:00:00Z', birth_date: null },
  ];
  const dupRow = (id: string, cust: string, status = 'done') => ({ id, session_id: P1, session_day: 'Friday', session_date: P1, queue_num: 1, name: 'x', phone: '', customer_id: cust, status, paid: true, price: 30, registered_at: '2026-01-01T10:00:00Z' });
  const merges = [{ id: 7, keep_id: 'd1', drop_id: 'dx', keep_name: 'Amal Fixture', drop_name: 'Gone Fixture', merged_at: '2026-09-27T10:00:00Z', merged_by: 'Spec Staff', undone_at: null }];

  test('the pairs are grouped once per list, the bookings counted once per list, and a merge reads its way round in Arabic', async ({ page }) => {
    await staff(page, { customers: dupCustomers, queue_entries: [dupRow('q1', 'd1'), dupRow('q2', 'd2'), dupRow('q3', 'd2'), dupRow('q4', 'd2', 'removed')], customer_merges: merges });
    expect(await page.evaluate(`[_custBookingsN('d1'),_custBookingsN('d2'),_custBookingsN('nobody')]`)).toEqual([1, 2, 0]);
    expect(await page.evaluate(`_dupGroups()===_dupGroups()`)).toBe(true);
    expect(await page.evaluate(`_dupGroups()[0].accts.map(c=>c.id)`)).toEqual(['d2', 'd1']); // more bookings first
    // A new list is grouped again.
    expect(await page.evaluate(`(()=>{const a=_dupGroups();S.customers=S.customers.slice();return a!==_dupGroups();})()`)).toBe(true);
    expect(await page.evaluate(`(()=>{const a=_custBookingsN('d1');S.queue=[...S.queue,entryFromDB(${JSON.stringify(dupRow('q5', 'd1'))})];return [a,_custBookingsN('d1')];})()`)).toEqual([1, 2]);
    await page.evaluate(`setStaffTab('community');setCommTab('duplicates')`);
    const recent = page.locator('#tab-community .mg-row').first();
    await expect(recent).toContainText('Gone Fixture → Amal Fixture');
    await expect(recent.locator('bdi')).toHaveCount(2);
    await page.evaluate(`setLang('ar')`);
    await expect.poll(() => page.evaluate(`_langLoaded('ar')`)).toBe(true);
    await page.evaluate(`renderCommunity()`);
    await expect(page.locator('#tab-community .mg-row').first()).toContainText('Gone Fixture ← Amal Fixture');
  });

  test('"Looks fine" is written against the row as it was read, and a row that moved on is read again and added to', async ({ page }) => {
    const typo = { id: 'lf1', name: 'Typo Fixture', email: 'typo@gmail.con', phone: '+966551870010', gender: 'female', created_at: '2026-01-05T10:00:00Z' };
    const T1 = '2026-10-05T08:00:00.123456+00:00', T2 = '2026-10-05T08:00:01.5+00:00';
    await staff(page, { customers: [typo], queue_entries: [], staff_options: [{ key: 'accounts_look_fine', items: ['other|aaa'], updated_at: T1 }] });
    // The decision's own read (select=items,updated_at): first the row as it was, then as another desk left it.
    let readN = 0, patchN = 0;
    const patches: { url: string; body: Record<string, unknown> }[] = [];
    await page.route('**/rest/v1/staff_options*', async (r) => {
      const req = r.request(), u = new URL(req.url());
      if (req.method() === 'GET' && u.searchParams.get('select') === 'items,updated_at') {
        readN++;
        return r.fulfill(json(readN === 1 ? [{ items: ['other|aaa'], updated_at: T1 }] : [{ items: ['other|aaa', 'desk2|bbb'], updated_at: T2 }]));
      }
      if (req.method() === 'PATCH') {
        patchN++;
        patches.push({ url: req.url(), body: req.postDataJSON() });
        return r.fulfill(json(patchN === 1 ? [] : [{ key: 'accounts_look_fine' }])); // the first finds the row moved on
      }
      return r.fallback();
    });
    const posts = sent(page, 'staff_options', 'POST');
    await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
    await page.waitForFunction('!!_phoneRules');
    await page.evaluate(`_amFilter('amSuspect',true)`);
    await page.locator('.am-row[data-cust="lf1"] .am-sx .am-fine').click();
    await expect(page.locator('.am-row[data-cust="lf1"]')).toHaveCount(0);
    expect(posts.length).toBe(0); // the row is there: updated, never written whole over
    expect(patches.length).toBe(2);
    const p1 = new URL(patches[0].url).searchParams, p2 = new URL(patches[1].url).searchParams;
    expect(p1.get('key')).toBe('eq.accounts_look_fine');
    expect(p1.get('updated_at')).toBe('eq.' + T1);
    expect(p2.get('updated_at')).toBe('eq.' + T2);
    expect((patches[0].body.items as string[])).toEqual(['other|aaa', expect.stringMatching(/^lf1\|/)]);
    expect((patches[1].body.items as string[])).toEqual(['other|aaa', 'desk2|bbb', expect.stringMatching(/^lf1\|/)]); // the other desk's decision kept
    expect(await page.evaluate(`S.staffOptions.accounts_look_fine.length`)).toBe(3);
  });
});
