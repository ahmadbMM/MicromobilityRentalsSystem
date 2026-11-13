import { test, expect, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Helper path (new features F23, 2026-11-13; migration 20261114082300): rider, helper, trainee ride leader, ride leader.
// The three steps after rider are titles of the catalogue (titles.path_step), given where titles are given; helper days
// are the days of the volunteer shifts a member attended. A member sees their own step, their helper days, the next
// step's name and the helper-day ladder (helper-path.js, fetched for members only); staff set the step and see helper
// days per member in Community > Titles. Members see nobody: the read answers about its caller alone.
// All Supabase traffic is stubbed; the SQL is read as text (no spec reaches a database).

const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina@example.com', phone: '+966551876215', gender: 'female', created_at: '2026-06-10T00:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar@example.com', phone: '+966551876216', gender: 'male', created_at: '2026-06-11T00:00:00Z' },
  { id: 'c3', name: 'Sara Nabil', email: 'sara@example.com', phone: '+966551876217', gender: 'female', created_at: '2026-06-12T00:00:00Z' },
  { id: 'c4', name: 'Dana Farouk', email: 'dana@example.com', phone: '+966551876218', gender: 'female', created_at: '2026-06-13T00:00:00Z' },
];
const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: 'green', locked: true }];
const customer_tags = ['c1', 'c2', 'c4'].map((id) => ({ customer_id: id, tag_id: 'tag_saturday', added_at: 1 })); // c3 is not a member
const captain = { id: 'ttl_cap', name: 'Ride Captain', name_ar: 'قائد الرحلة', color: 'gold', auto_rides: null, retired: false, sort: 500 };
const pathTitles = [
  { id: 'ttl_path_helper', name: 'Helper', name_ar: 'مساعد', color: 'teal', auto_rides: null, retired: false, sort: 9001, path_step: 1 },
  { id: 'ttl_path_trainee', name: 'Trainee ride leader', name_ar: 'قائد جولة متدرّب', color: 'blue', auto_rides: null, retired: false, sort: 9002, path_step: 2 },
  { id: 'ttl_path_leader', name: 'Ride leader', name_ar: 'قائد الجولة', color: 'gold', auto_rides: null, retired: false, sort: 9003, path_step: 3 },
];
const PATH_IDS = pathTitles.map((x) => x.id);
const held = [{ customer_id: 'c1', title_id: 'ttl_path_trainee', expires_on: null, given_by: 'Spec Staff', given_at: '2026-11-01T10:00:00+00:00' }];
const days = [{ customer_id: 'c1', days: 12 }, { customer_id: 'c3', days: 9 }, { customer_id: 'c2', days: 3 }];
const STEPS = ['Rider', 'Helper', 'Trainee ride leader', 'Ride leader'];
const SQL = readFileSync(resolve(__dirname, '../supabase/migrations/20261114082300_helper_path.sql'), 'utf8');

const rpcCalls = (page: Page, fn: string) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r: Request) => { if (new URL(r.url()).pathname.endsWith('/rpc/' + fn)) out.push(r.postDataJSON() || {}); });
  return out;
};
const writes = (page: Page, table: string) => {
  const out: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  page.on('request', (r: Request) => {
    if (r.method() !== 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/' + table)) out.push({ method: r.method(), url: decodeURIComponent(r.url()), body: r.postDataJSON() });
  });
  return out;
};
const own = (step: number, n: number) => ({ ok: true, member: true, step, days: n });

async function rider(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], 'rpc:community_member': true,
    'rpc:customer_my_titles': { ok: true, member: true, hidden: false, shown: null, titles: [] }, 'rpc:customer_helper_path': own(1, 7), ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
  await page.goto('/');
  await waitForSb(page);
}
const badges = (page: Page) => page.evaluate(`setCustTab('account','badges')`);
// The account page is painted and the read has answered (card or no card).
const settled = (page: Page) => page.waitForFunction(`!!S._hpMine&&!S._hpBusy&&!S._hpLoading&&document.querySelector('#acc-pane-badges')&&document.querySelector('#acc-pane-badges').children.length>0`);

async function staff(page: Page, fx: Fixtures = {}, init = '') {
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], tags, customer_tags, staff_options: [],
    titles: [captain, ...pathTitles], customer_titles: held, 'rpc:staff_helper_days': days, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffRole='admin';${init}setStaffTab('community');S.communityTab='titles';renderCommunity()`);
  await page.waitForFunction('S._ttAt>0&&!S._ttBusy&&!S._hpDaysBusy');
}
const row = (page: Page, id: string) => page.locator(`#hp-staff [data-hp="${id}"]`);
// A member row drawn whole at this width: the helper days are not cut short (their own box holds them, and each end of
// them is theirs at that point, so nothing clips or covers it), and the step select is as wide as its longest word needs.
const rowWhole = (r: Element) => {
  r.scrollIntoView({ block: 'center' });
  const dn = r.querySelector('.hp-dn') as HTMLElement, sel = r.querySelector('select') as HTMLSelectElement;
  const b = dn.getBoundingClientRect(), y = b.top + b.height / 2;
  const mine = (x: number) => { const hit = document.elementFromPoint(x, y); return !!hit && dn.contains(hit); };
  const free = sel.cloneNode(true) as HTMLSelectElement;
  free.style.maxWidth = 'none'; free.style.position = 'absolute';
  r.appendChild(free);
  const need = free.getBoundingClientRect().width;
  free.remove();
  return { days: b.width > 0 && dn.scrollWidth <= dn.clientWidth && mine(b.left + 1) && mine(b.right - 1), select: sel.getBoundingClientRect().width >= need - 0.5, inRow: r.scrollWidth <= r.clientWidth };
};

test.describe('@customer:account helper path', () => {
  test('a member sees their own step, the next step, their helper days and the helper-day ladder', async ({ page }) => {
    const asked = rpcCalls(page, 'customer_helper_path'), files: string[] = [];
    page.on('request', (r) => { if (r.url().includes('helper-path.js')) files.push(r.url()); });
    await rider(page);
    await badges(page);
    const card = page.locator('#hp-mine');
    await expect(card).toBeVisible();
    await expect(card.locator('.amb-mine-title')).toHaveText('Helper path');
    await expect(card.locator('.hp-step')).toHaveText(STEPS);
    await expect(card.locator('.hp-step[aria-current="step"]')).toHaveText('Helper');
    await expect(card.locator('.hp-step.done')).toHaveText(['Rider']);
    await expect(card.locator('.hp-next')).toHaveText('Next step: Trainee ride leader');
    await expect(card.locator('.hp-days')).toHaveText(/^\s*7\s*Helper days\s*$/);
    // the ladder, drawn as the badge tiles are: 1 and 5 reached, 10 and 25 greyed with how far along
    await expect(card.locator('.hp-badges .mr-badge .mr-badge-nm')).toHaveText(['1 helper day', '5 helper days', '10 helper days', '25 helper days']);
    await expect(card.locator('.hp-badges .mr-badge:not(.locked)')).toHaveCount(2);
    await expect(card.locator('.hp-badges .mr-badge.locked .mr-badge-p')).toHaveText(['7/10', '7/25']);
    await expect(card.locator('.hp-badges .mr-badge svg.bdg-m')).toHaveCount(4);
    // between the badges and the titles card
    expect(await page.evaluate(`[...document.querySelector('#acc-pane-badges').children].map(e=>e.id)`)).toEqual(['mr-badges-host', 'hp-mine', 'tt-mine']);
    // shown like rides: a line on the Stats part, under the season's numbers
    await page.evaluate(`setCustTab('account','stats')`);
    await expect(page.locator('#acc-pane-stats .mr-season #hp-line')).toBeVisible();
    await expect(page.locator('#hp-line')).toHaveText('Helper days: 7');
    // one read, with the member's own id and token and nothing else; the file comes with the build's stamp
    expect(asked).toEqual([{ p_id: 'c1', p_token: 'tok-spec' }]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\/helper-path\.js\?v=[0-9a-f]{10}$/);
  });

  for (const [step, next] of [[0, 'Helper'], [1, 'Trainee ride leader'], [2, 'Ride leader'], [3, '']] as [number, string][]) {
    test(`the step shown matches the title held: step ${step} reads ${STEPS[step]}`, async ({ page }) => {
      await rider(page, { 'rpc:customer_helper_path': own(step, 2) });
      await badges(page);
      const card = page.locator('#hp-mine');
      await expect(card.locator('.hp-step[aria-current="step"]')).toHaveText(STEPS[step]);
      await expect(card.locator('.hp-step.done')).toHaveText(STEPS.slice(0, step));
      await expect(card.locator('.hp-step[aria-current="step"]')).toHaveCount(1);
      if (next) await expect(card.locator('.hp-next')).toHaveText('Next step: ' + next);
      else await expect(card.locator('.hp-next')).toHaveCount(0); // the last step names no next one
    });
  }

  test('no helper day yet: the card says 0, every level is still to earn, and Stats has no line', async ({ page }) => {
    await rider(page, { 'rpc:customer_helper_path': own(0, 0) });
    await badges(page);
    await expect(page.locator('#hp-mine .hp-days-n')).toHaveText('0');
    await expect(page.locator('#hp-mine .hp-badges .mr-badge.locked')).toHaveCount(4);
    await expect(page.locator('#hp-mine .hp-badges .mr-badge-p')).toHaveText(['0/1', '0/5', '0/10', '0/25']);
    await expect(page.locator('#hp-line')).toHaveCount(0);
  });

  test('every level reached at 25 helper days', async ({ page }) => {
    await rider(page, { 'rpc:customer_helper_path': own(3, 31) });
    await badges(page);
    await expect(page.locator('#hp-mine .hp-badges .mr-badge')).toHaveCount(4);
    await expect(page.locator('#hp-mine .hp-badges .mr-badge.locked')).toHaveCount(0);
    await expect(page.locator('#hp-mine .hp-badges .mr-badge-p')).toHaveCount(0);
  });

  test('another member\'s data is unreachable: the page asks only about its own account and draws nothing else', async ({ page }) => {
    // An answer carrying more than the function ever returns: none of it reaches the page.
    const asked = rpcCalls(page, 'customer_helper_path'), staffRead = rpcCalls(page, 'staff_helper_days');
    const tables: string[] = [];
    page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rest\/v1\/(customer_titles|titles|volunteer_shifts)$/); if (m) tables.push(m[1]); });
    await rider(page, { 'rpc:customer_helper_path': { ...own(2, 4), name: 'Omar Saleh', others: [{ id: 'c2', name: 'Omar Saleh', step: 3, days: 40 }] } });
    await badges(page);
    await expect(page.locator('#hp-mine')).toBeVisible();
    await expect(page.locator('#hp-mine')).not.toContainText('Omar');
    await expect(page.locator('#hp-mine')).not.toContainText('40');
    await expect(page.locator('#hp-mine .hp-step[aria-current="step"]')).toHaveText('Trainee ride leader');
    await page.evaluate(`renderAccount()`);
    await settled(page);
    for (const sent of asked) expect(sent).toEqual({ p_id: 'c1', p_token: 'tok-spec' }); // no argument names another account
    expect(asked.length).toBeGreaterThan(0);
    expect(staffRead).toHaveLength(0); // the staff read is never a rider's
    expect(tables).toEqual([]); // nor the tables behind it
    expect(await page.evaluate(`Object.keys(S._hpMine).sort()`)).toEqual(['at', 'days', 'forId', 'on', 'step']);
  });

  test('a rider who is not a member gets no card and never fetches the file', async ({ page }) => {
    await rider(page, { 'rpc:customer_helper_path': { ok: true, member: false } });
    const files: string[] = [];
    page.on('request', (r) => { if (r.url().includes('helper-path.js')) files.push(r.url()); });
    await badges(page);
    await settled(page);
    await expect(page.locator('#hp-mine')).toHaveCount(0);
    await expect(page.locator('#hp-line')).toHaveCount(0);
    expect(files).toEqual([]);
  });

  for (const [what, answer] of [
    ['a database without the function', { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_helper_path in the schema cache' } }],
    ['a refused token', { ok: false, error: 'denied' }],
    ['a failed read', { __rpcError: { status: 500, code: 'XX000', message: 'boom' } }],
  ] as [string, unknown][]) {
    test(`${what} shows no card, no line and no error`, async ({ page }) => {
      await rider(page, { 'rpc:customer_helper_path': answer });
      await badges(page);
      await settled(page);
      await expect(page.locator('#hp-mine')).toHaveCount(0);
      await expect(page.locator('#hp-line')).toHaveCount(0);
      await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0);
      await expect(page.locator('#tt-mine')).toBeVisible(); // the rest of the page is as before
    });
  }

  test('a database without the function is asked once on a page load, however often the account paints', async ({ page }) => {
    const asked = rpcCalls(page, 'customer_helper_path');
    await rider(page, { 'rpc:customer_helper_path': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_helper_path in the schema cache' } } });
    await badges(page);
    await settled(page);
    await page.evaluate(`S._hpMine.at=S._hpMine.at-36e5;renderAccount();renderAccount()`); // an hour on: a read that only failed would be asked again
    await settled(page);
    await page.waitForTimeout(300);
    expect(asked).toHaveLength(1);
    await expect(page.locator('#hp-mine')).toHaveCount(0);
  });

  test('the file not fetched: no card and no error, and the next paint asks again', async ({ page }) => {
    await rider(page);
    let fail = true;
    await page.route('**/helper-path.js*', (r) => (fail ? r.abort() : r.continue()));
    await badges(page);
    await page.waitForFunction(`!!S._hpMine&&!S._hpLoading&&!S._hpBusy`);
    await expect(page.locator('#hp-mine')).toHaveCount(0);
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0);
    fail = false;
    await page.evaluate(`renderAccount()`);
    await expect(page.locator('#hp-mine')).toBeVisible();
  });

  test('a repaint of the account page draws the card and the line once', async ({ page }) => {
    await rider(page);
    await badges(page);
    await expect(page.locator('#hp-mine')).toBeVisible();
    await page.evaluate(`renderAccount();renderAccount();window._hpRender();window._hpRender()`);
    await settled(page);
    await expect(page.locator('#hp-mine')).toHaveCount(1);
    await expect(page.locator('#hp-line')).toHaveCount(1);
    // another account signed in on this device: the first one's card is not drawn for it
    await page.evaluate(`S._hpMine.forId='someone-else';window._hpRender()`);
    await expect(page.locator('#hp-mine')).toHaveCount(0);
    await expect(page.locator('#hp-line')).toHaveCount(0);
  });

  test('its words: ten languages each, the same placeholders, Latin digits; Arabic reads Arabic', async ({ page }) => {
    await rider(page);
    await badges(page);
    await expect(page.locator('#hp-mine')).toBeVisible();
    expect(await page.evaluate(`HP_LANGS`)).toEqual(['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']);
    expect(await page.evaluate(`Object.entries(HP_T).filter(([k,v])=>v.length!==10||v.some(x=>!String(x).trim())).map(([k])=>k)`)).toEqual([]);
    expect(await page.evaluate(`Object.entries(HP_T).filter(([k,v])=>v.some(x=>x.includes('{0}')!==v[0].includes('{0}'))).map(([k])=>k)`)).toEqual([]);
    expect(await page.evaluate(`Object.entries(HP_T).filter(([k,v])=>v.some(x=>/[\\u0660-\\u0669\\u06f0-\\u06f9\\u0966-\\u096f\\u09e6-\\u09ef]/.test(x))).map(([k])=>k)`)).toEqual([]);
    expect(await page.evaluate(`['b5','b10','b25'].filter(k=>HP_T[k].some(x=>!x.includes(k.slice(1))))`)).toEqual([]); // each level's name carries its count
    await page.evaluate(`S.lang='ar';window._hpRender()`);
    await expect(page.locator('#hp-mine .amb-mine-title')).toHaveText('مسار المساعد');
    await expect(page.locator('#hp-mine .hp-step[aria-current="step"]')).toHaveText('مساعد');
    await expect(page.locator('#hp-mine .hp-next')).toHaveText('الخطوة التالية: قائد جولة متدرّب');
    await page.evaluate(`S.lang='bn';window._hpRender()`);
    await expect(page.locator('#hp-mine .hp-days')).toContainText('7');
    await expect(page.locator('#hp-mine .hp-step[aria-current="step"]')).not.toHaveText('Helper');
  });
});

test.describe('@staff:community helper path', () => {
  test('Titles has the Helper path: members on the path or with helper days, their days and their step', async ({ page }) => {
    await staff(page);
    const sec = page.locator('#hp-staff');
    await expect(sec.locator('h2')).toHaveText('Helper path');
    // members only (Sara has helper days but is not a member; Dana is a member with neither): the furthest along first
    await expect(sec.locator('[data-hp] strong')).toHaveText(['Lina Haddad', 'Omar Saleh']);
    await expect(row(page, 'c1').locator('.hp-dn')).toHaveText('Helper days: 12');
    await expect(row(page, 'c2').locator('.hp-dn')).toHaveText('Helper days: 3');
    // read whole on a phone as on a desk: the days are not inside the row's one-line detail, and the select is not squeezed
    for (const id of ['c1', 'c2']) expect(await row(page, id).evaluate(rowWhole), id).toEqual({ days: true, select: true, inRow: true });
    // the step shown matches the title held
    await expect(row(page, 'c1').locator('select')).toHaveValue('2');
    await expect(row(page, 'c1').locator('select option:checked')).toHaveText('Trainee ride leader');
    await expect(row(page, 'c2').locator('select')).toHaveValue('0');
    await expect(row(page, 'c1').locator('select option')).toHaveText(STEPS);
    await expect(row(page, 'c1').locator('select')).toHaveAttribute('aria-label', 'Step for Lina Haddad');
    // the path's titles sit in the catalogue, marked; edited, but never retired, deleted or made automatic
    const cat = page.locator('#tab-community [data-title="ttl_path_helper"]');
    await expect(cat).toContainText('Helper path');
    await expect(cat.locator('button')).toHaveText(['Holders', 'Edit']);
    await expect(page.locator('#tab-community [data-title="ttl_cap"] button')).toHaveText(['Holders', 'Edit', 'Retire', 'Delete']);
    // one found retired (a page from before the path still offers Retire on it) can be put back, and is still not deleted
    await page.evaluate(`S.titles.find(x=>x.id==='ttl_path_leader').retired=true;renderCommunity()`);
    await expect(page.locator('#tab-community [data-title="ttl_path_leader"] button')).toHaveText(['Holders', 'Edit', 'Restore']);
    await cat.locator('button', { hasText: 'Edit' }).click();
    await expect(page.locator('#tt-f-name')).toHaveValue('Helper');
    await expect(page.locator('#tt-f-auto')).toHaveCount(0);
  });

  test('moving a member along gives that step\'s title, and the device keeps one path title for them', async ({ page }) => {
    await staff(page);
    const sent = writes(page, 'customer_titles'), log = writes(page, 'staff_actions');
    await row(page, 'c1').locator('select').selectOption('3');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toContain('on_conflict=customer_id,title_id');
    expect(sent[0].body).toMatchObject({ customer_id: 'c1', title_id: 'ttl_path_leader', expires_on: null, given_by: 'Spec Staff' });
    await expect(row(page, 'c1').locator('select')).toHaveValue('3');
    await expect(row(page, 'c1').locator('select')).toBeFocused(); // the list was drawn again: the focus is back on the member's select
    expect(await page.evaluate(`S.custTitles.filter(ct=>ct.customer_id==='c1').map(ct=>ct.title_id)`)).toEqual(['ttl_path_leader']);
    await expect.poll(() => log.map((w) => w.body && w.body.action)).toContain('Helper path step: Ride leader');
    expect(log.find((w) => w.body && w.body.action === 'Helper path step: Ride leader')!.body).toMatchObject({ entity: 'customer', entity_id: 'c1' });
    // and back a step: staff move a member either way
    await row(page, 'c1').locator('select').selectOption('1');
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].body).toMatchObject({ customer_id: 'c1', title_id: 'ttl_path_helper' });
    expect(await page.evaluate(`S.custTitles.filter(ct=>ct.customer_id==='c1').map(ct=>ct.title_id)`)).toEqual(['ttl_path_helper']);
  });

  test('Rider takes the path titles back, and no other title', async ({ page }) => {
    await staff(page, { customer_titles: [...held, { customer_id: 'c1', title_id: 'ttl_cap', expires_on: null, given_by: 'Spec Staff', given_at: '2026-10-01T10:00:00+00:00' }] });
    const sent = writes(page, 'customer_titles');
    await row(page, 'c1').locator('select').selectOption('0');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].method).toBe('DELETE');
    expect(sent[0].url).toContain('customer_id=eq.c1');
    expect(sent[0].url).toContain(`title_id=in.(${PATH_IDS.join(',')})`);
    await expect(row(page, 'c1').locator('select')).toHaveValue('0'); // still listed: 12 helper days
    expect(await page.evaluate(`S.custTitles.filter(ct=>ct.customer_id==='c1').map(ct=>ct.title_id)`)).toEqual(['ttl_cap']);
  });

  test('a search reaches a member who is not on the path yet, and never an account that is not a member', async ({ page }) => {
    await staff(page);
    const sent = writes(page, 'customer_titles');
    await expect(row(page, 'c4')).toHaveCount(0);
    // typed a key at a time: the list is drawn again under the typing, and the box keeps the focus and what was typed
    await page.locator('#hp-q').click();
    await page.keyboard.type('da');
    await expect(page.locator('#hp-staff [data-hp] strong')).toHaveText(['Lina Haddad', 'Dana Farouk']); // "da" is in Haddad too; the member on the path first
    await expect(page.locator('#hp-q')).toBeFocused();
    await page.keyboard.type('na');
    await expect(page.locator('#hp-q')).toHaveValue('dana');
    await expect(page.locator('#hp-q')).toBeFocused();
    await expect(page.locator('#hp-staff [data-hp] strong')).toHaveText(['Dana Farouk']);
    await row(page, 'c4').locator('select').selectOption('1');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toMatchObject({ customer_id: 'c4', title_id: 'ttl_path_helper' });
    await page.locator('#hp-q').fill('sara');
    await expect(page.locator('#hp-staff [data-hp]')).toHaveCount(0);
    await expect(page.locator('#hp-staff')).toContainText('No matching customers.');
  });

  test('a write that fails says so and leaves the member on the step held', async ({ page }) => {
    await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], tags, customer_tags, staff_options: [], titles: [captain, ...pathTitles], customer_titles: held, 'rpc:staff_helper_days': days },
      { table: 'customer_titles' });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='titles';renderCommunity()`);
    await page.waitForFunction('S._ttAt>0&&!S._ttBusy&&!S._hpDaysBusy');
    await row(page, 'c1').locator('select').selectOption('3');
    await expect(page.locator('#err-bar-el')).toContainText('That did not save');
    await expect(row(page, 'c1').locator('select')).toHaveValue('2');
    expect(await page.evaluate(`S.custTitles.filter(ct=>ct.customer_id==='c1').map(ct=>ct.title_id)`)).toEqual(['ttl_path_trainee']);
  });

  test('giving a path title from its own holders panel replaces the member\'s other one on the device', async ({ page }) => {
    await staff(page);
    await page.locator('#tab-community [data-title="ttl_path_leader"] button', { hasText: 'Holders' }).click();
    await page.locator('#tt-q').fill('lina');
    await page.locator('#tab-community .tg-give button', { hasText: 'Give title' }).click();
    await expect(row(page, 'c1').locator('select')).toHaveValue('3');
    expect(await page.evaluate(`S.custTitles.filter(ct=>ct.customer_id==='c1').map(ct=>ct.title_id)`)).toEqual(['ttl_path_leader']);
    // a title outside the path leaves the step alone
    await page.evaluate(`_ttGive('c1','ttl_cap')`);
    await expect.poll(() => page.evaluate(`S.custTitles.filter(ct=>ct.customer_id==='c1').map(ct=>ct.title_id).sort()`)).toEqual(['ttl_cap', 'ttl_path_leader']);
  });

  test('a view-only account reads the steps and has nothing to change them with', async ({ page }) => {
    await staff(page, {}, `S._myEdit=[];`);
    await expect(row(page, 'c1')).toContainText('Trainee ride leader');
    await expect(row(page, 'c1')).toContainText('Helper days: 12');
    await expect(row(page, 'c2').locator('.hp-step-ro')).toHaveText('Rider');
    await expect(page.locator('#hp-staff select')).toHaveCount(0);
  });

  test('a database from before the path: no section, and helper days are never asked for', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/staff_helper_days')) asked.push(r.url()); });
    await staff(page, { titles: [captain], customer_titles: [] });
    await expect(page.locator('#tab-community [data-title="ttl_cap"]')).toBeVisible();
    await expect(page.locator('#hp-staff')).toHaveCount(0);
    expect(asked).toEqual([]);
  });

  test('helper days not read: the steps still show and are still set, the rows just say nothing about days', async ({ page }) => {
    await staff(page, { 'rpc:staff_helper_days': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    await expect(page.locator('#hp-staff [data-hp] strong')).toHaveText(['Lina Haddad']);
    await expect(page.locator('#hp-staff .hp-dn')).toHaveCount(0);
    await expect(row(page, 'c1').locator('select')).toHaveValue('2');
  });

  test('the section is in the staff languages, from the part\'s own string packs', async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('cq_lang', 'fr'); localStorage.setItem('cq_lang_pick', '1'); });
    await staff(page);
    await expect(page.locator('#hp-staff h2')).toHaveText('Parcours d’assistant');
    await expect(row(page, 'c1').locator('select option')).toHaveText(['Cycliste', 'Assistant', 'Chef de sortie en formation', 'Chef de sortie']);
    await expect(row(page, 'c1').locator('.hp-dn')).toHaveText('Jours d’aide : 12');
    expect(await row(page, 'c1').evaluate(rowWhole)).toEqual({ days: true, select: true, inRow: true }); // longer words, still whole
  });

  test('what the build wrote: the staff words stay out of the riders\' half, the riders\' words out of the main bundle', () => {
    const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
    const customer = read('index.html') + read('app.js'), core = read('staff.js'), part = read('staff-parts/peoplemore.js'), mod = read('helper-path.js');
    for (const word of ['_hpStaffHtml', '_hpSet', 'A helper day is a day with a volunteer shift attended']) {
      expect(customer.includes(word), `customer half: ${word}`).toBe(false);
      expect(core.includes(word), `desk core: ${word}`).toBe(false);
      expect(part.includes(word), `people part: ${word}`).toBe(true);
    }
    for (const word of ['Next step: {0}', '25 helper days', 'Trainee ride leader']) {
      expect(customer.includes(word), `main bundle: ${word}`).toBe(false);
      expect(mod.includes(word), `helper-path.js: ${word}`).toBe(true);
    }
    expect(customer).toContain('/helper-path.js?v=');
    for (const code of ['ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']) {
      const pack = JSON.parse(read(`lang/staff-peoplemore-${code}.json`));
      for (const k of ['hpTitle', 'hpSub', 'hpStep0', 'hpStep1', 'hpStep2', 'hpStep3', 'hpDaysN', 'hpStepFor', 'hpNone', 'hpLogStep']) expect(pack[k], `${code} ${k}`).toBeTruthy();
      expect(JSON.parse(read(`lang/${code}.json`)).hpTitle, code).toBeUndefined(); // never with the riders' strings
    }
    // the file ships, and nothing in it would break the page's policy (the build's checks do not read it)
    expect(read('scripts/assemble-dist.mjs')).toContain("'helper-path.js'");
    expect(mod).not.toMatch(/\son[a-z]+\s*=\s*["'`]|style\s*=\s*["'`]|javascript:|setAttribute\(\s*['"]style/);
    expect(mod).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

test.describe('@staff:community helper path SQL (migration 20261114082300, read as text)', () => {
  const fn = (name: string) => {
    const m = SQL.match(new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)[\\s\\S]*?\\$function\\$;`));
    expect(m, name).not.toBeNull();
    return { args: m![1], body: m![0] };
  };

  test('helper days are counted from attended shifts only', () => {
    const rule = fn('_helper_shift_days').body;
    // attended: the session was not called off, and the shift is done, or accepted with a clock-in
    expect(rule).toContain('from volunteer_shifts sh');
    expect(rule).toContain('s.cancelled_at is null');
    expect(rule).toContain(`and (sh.status = 'done' or (sh.status = 'accepted' and sh.clock_in is not null))`);
    // no other status is ever named, so interested, declined, withdrawn, blocked, ended and no_show cannot count
    expect([...rule.matchAll(/status\s*(?:=|<>|!=|in)\s*\(?\s*'([a-z_]+)'/g)].map((m) => m[1])).toEqual(['done', 'accepted']);
    expect(rule).not.toMatch(/interested|declined|withdrawn|blocked|no_show|ended|volunteer_hours/);
    // a day, not a shift: one row per account and day, counted distinct
    expect(rule).toMatch(/select distinct sh\.customer_id, coalesce\(nullif\(left\(s\.session_date, 10\), ''\), s\.id\)/);
    // the one rule: neither count reads the shifts by itself
    for (const name of ['_helper_days', 'staff_helper_days', 'customer_helper_path']) expect(fn(name).body, name).not.toContain('volunteer_shifts');
    expect(fn('_helper_days').body).toContain('select count(distinct d.day)::integer from _helper_shift_days() d where d.customer_id = any(p_accts)');
    expect(fn('staff_helper_days').body).toMatch(/count\(distinct d\.day\)::integer as n\s+from _helper_shift_days\(\) d/);
    expect(fn('customer_helper_path').body).toContain(`'days', _helper_days(v_accts)`);
  });

  test('the member\'s read answers about its caller alone, and the step is the path title held', () => {
    const f = fn('customer_helper_path');
    expect(f.args).toBe('p_id text, p_token text'); // no argument can name another account
    const lines = f.body.split('\n').map((l) => l.trim()), begin = lines.indexOf('begin');
    expect(lines[begin + 1]).toBe(`if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;`);
    expect(lines[begin + 2]).toBe(`if not _member_active(p_id) then return jsonb_build_object('ok', true, 'member', false); end if;`);
    // the accounts read are the caller's own: theirs and those merged into it
    expect(f.body).toContain('select array_agg(c.id) into v_accts from customers c where c.id = p_id or c.merged_into = p_id;');
    expect([...f.body.matchAll(/any\(([a-z_]+)\)/g)].map((m) => m[1])).toEqual(['v_accts']);
    // the step: the path title held and not ended
    expect(f.body).toMatch(/select t\.path_step into v_step\s+from customer_titles ct join titles t on t\.id = ct\.title_id\s+where ct\.customer_id = any\(v_accts\) and t\.path_step is not null/);
    expect(f.body).toContain(`(ct.expires_on is null or ct.expires_on >= (now() at time zone 'Asia/Riyadh')::date)`);
    // the answer: ok, member, step, days. No name, phone, id or list of anyone
    expect(f.body).toContain(`return jsonb_build_object('ok', true, 'member', true, 'step', coalesce(v_step, 0), 'days', _helper_days(v_accts));`);
    expect([...f.body.matchAll(/jsonb_build_object\(([^;]*)\);/g)].flatMap((m) => [...m[1].matchAll(/'([a-z_]+)',/g)].map((k) => k[1])).sort())
      .toEqual(['days', 'error', 'member', 'member', 'ok', 'ok', 'ok', 'step']);
    expect(f.body).not.toMatch(/jsonb_agg|\bname\b|phone|email/);
    expect(f.body).toMatch(/stable security definer\s+set search_path to 'public'/);
  });

  test('who may call what: the page reaches the member\'s read, only staff the list, nobody the helpers', () => {
    expect(SQL).toContain('revoke all on function public.customer_helper_path(text, text) from public;');
    expect(SQL).toContain('grant execute on function public.customer_helper_path(text, text) to anon, authenticated;');
    expect(SQL).toContain('revoke all on function public.staff_helper_days() from public, anon;');
    expect(SQL).toContain('grant execute on function public.staff_helper_days() to authenticated;');
    expect(fn('staff_helper_days').body).toContain(`if not coalesce(is_staff(), false) then raise exception 'not staff' using errcode = '42501'; end if;`);
    for (const sig of ['_helper_shift_days()', '_helper_days(text[])', '_title_path_one()']) expect(SQL, sig).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
    for (const name of ['_helper_shift_days', '_helper_days', 'customer_helper_path', 'staff_helper_days', '_title_path_one']) {
      expect(fn(name).body, name).toMatch(/security definer\s+set search_path to 'public'/);
      expect(readFileSync(resolve(__dirname, '../supabase/checks/security-attributes.sql'), 'utf8'), name).toContain(`('${name}', true,`);
    }
  });

  test('the steps are three titles, one per step, never automatic, and a member holds one at a time', () => {
    expect(SQL).toContain('alter table public.titles add column if not exists path_step smallint;');
    expect(SQL).toContain('check (path_step between 1 and 3)');
    expect(SQL).toContain('check (path_step is null or auto_rides is null)');
    expect(SQL).toContain('create unique index if not exists titles_path_step_one on public.titles (path_step) where path_step is not null;');
    // sorted after the catalogue's titles (500 and up), so a step given never goes ahead of another title staff gave
    for (const [id, step] of [['ttl_path_helper', 1], ['ttl_path_trainee', 2], ['ttl_path_leader', 3]] as const) expect(SQL).toMatch(new RegExp(`\\('${id}',\\s+'[^']+',\\s+'[^']+',\\s+'[a-z]+', ${step}, ${9000 + step}\\)`));
    const one = fn('_title_path_one').body;
    expect(one).toContain('if exists (select 1 from titles t where t.id = new.title_id and t.path_step is not null) then');
    expect(one).toMatch(/delete from customer_titles ct\s+where ct\.customer_id = new\.customer_id and ct\.title_id <> new\.title_id\s+and ct\.title_id in \(select t\.id from titles t where t\.path_step is not null\);/);
    expect(SQL).toMatch(/create trigger customer_titles_path_one\s+after insert or update on public\.customer_titles\s+for each row execute function public\._title_path_one\(\);/);
    // the file's shape: one transaction, its ledger row, the schema reload, and nothing dropped but its own trigger and constraints
    expect(SQL).toMatch(/\nbegin;\n[\s\S]*\ncommit;\n\nnotify pgrst, 'reload schema';/);
    expect(SQL).toContain(`values ('20261114082300', 'helper_path')`);
    expect(SQL.replace(/^--.*$/gm, '')).not.toMatch(/drop (table|column|function|policy)|create table|truncate|delete from public\./i);
  });
});
