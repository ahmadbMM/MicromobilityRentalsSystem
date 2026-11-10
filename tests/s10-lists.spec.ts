import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Staff round s10, builder "lists" (2026-11-10): one toolbar for the office lists (search, pills, Filters, saved views,
// Select with its actions in the same row, Export), an exact Filters count with a Clear on the closed button, private
// saved views in the account's prefs, People in five groups, Team's search and names, History > Log merged on client
// ids, an admin's check-in undo from any device, and Workshop / Messages / Ambassadors asking the count probe, not
// reading their whole list, on a repaint. All Supabase traffic is stubbed.

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const job = (o: Record<string, unknown> = {}) => ({
  id: 42, created_at: '2026-10-01T09:30:00Z', customer_id: null, name: 'Sara Ali', phone: '+966551234567', email: null,
  service: 'full-service', service_label: 'Full service', price_quoted: 409, parts: [], lane: 'dropoff', pickup_address: null,
  preferred_date: null, preferred_time: null, bike: null, notes: null, lang: 'en', status: 'ready', scheduled_for: null,
  price_final: 350, staff_notes: null, updated_at: '2026-10-03T09:30:00Z', updated_by: 'Desk', mechanic: null, parts_used: [],
  paid_at: null, paid_receipt: null, ...o,
});
const msg = (o: Record<string, unknown>) => ({
  id: 7, created_at: '2099-05-01T09:30:00Z', kind: 'business', topic: 'fleet-programmes', name: 'Omar Hassan', company: null,
  email: 'omar@example.test', phone: '+966551234567', message: 'We need bikes.', lang: 'en', customer_id: null,
  status: 'new', staff_notes: null, updated_at: '2099-05-01T09:30:00Z', updated_by: 'website', ...o,
});
const sent = (page: Page, re: RegExp) => {
  const out: Request[] = [];
  page.on('request', (r) => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) && re.test(new URL(r.url()).pathname)) out.push(r); });
  return out;
};
async function boot(page: Page, fx: Fixtures = {}, tab?: string) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], staff_options: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  if (tab) await page.evaluate(`setStaffTab(${JSON.stringify(tab)})`);
}

test.describe('@staff:lists one toolbar for the office lists', () => {
  test('Workshop: Select puts the actions in the toolbar row, Select all names every match, Close N jobs closes them', async ({ page }) => {
    await boot(page, { workshop_jobs: [job(), job({ id: 43, status: 'in_workshop', name: 'Omar Saleh' }), job({ id: 44, status: 'new', name: 'Lina Haddad' })], workshop_job_events: [] }, 'workshop');
    const tab = page.locator('#tab-workshop');
    await page.evaluate(`_wsSetFilter('all')`);
    await expect(tab.locator('.ws-row')).toHaveCount(3);
    const w = sent(page, /\/rest\/v1\/workshop_jobs$/);
    await tab.locator('.lt-sel-btn').click();
    const bar = tab.locator('.lt-row.lt-sel');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.am-seln')).toHaveText('Selected: 0');
    await tab.locator('.ws-row[data-ws-id="42"] .lt-box').check();
    await tab.locator('.ws-row[data-ws-id="43"] .lt-box').check();
    await expect(bar.locator('.am-seln')).toHaveText('Selected: 2');
    await expect(bar.getByRole('button', { name: 'Close 2 jobs' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Assign 2 jobs' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Select all 3 matching' })).toBeVisible();
    await expect(page.locator('.bulk-bar, .sel-bottom-bar')).toHaveCount(0); // never a bar at the foot
    await bar.getByRole('button', { name: 'Close 2 jobs' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Close 2 jobs' }).click();
    await expect.poll(() => w.filter((r) => r.method() === 'PATCH').length).toBe(2);
    for (const r of w) expect(r.postDataJSON()).toMatchObject({ status: 'completed' });
  });

  test('Workshop: a repaint a minute on asks the head-count probe, never the whole list', async ({ page }) => {
    await boot(page, { workshop_jobs: [job()], workshop_job_events: [] }, 'workshop');
    await page.evaluate(`_wsSetFilter('all')`);
    await expect(page.locator('#tab-workshop .ws-row')).toHaveCount(1);
    const reads: string[] = [];
    page.on('request', (r) => { if (/\/rest\/v1\/workshop_jobs/.test(r.url())) reads.push(r.method()); });
    await page.evaluate(`S._staffAuthed=true;_ws().at=Date.now()-120000;_ws().pAt=0;renderWorkshop();renderWorkshop();renderWorkshop()`); // the probe asks only for a signed-in account
    await expect.poll(() => reads.filter((m) => m === 'HEAD').length).toBe(1);
    expect(reads.filter((m) => m === 'GET')).toHaveLength(0);
  });

  test('Workshop, Messages, Ambassadors, Vendors and Badge requests export what they show', async ({ page }) => {
    await boot(page, { workshop_jobs: [job()], workshop_job_events: [] }, 'workshop');
    await page.evaluate(`_wsSetFilter('ready')`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#tab-workshop').getByRole('button', { name: 'Export CSV' }).click()]);
    expect(dl.suggestedFilename()).toBe('workshop_jobs.csv');
    for (const f of ['_smCsv', '_ambCsv', '_vendorBkCsv', '_bdrCsv', '_apCsv']) expect(await page.evaluate(`typeof ${f}`)).toBe('function');
  });
});

test.describe('@staff:lists Filters count and Clear', () => {
  test('the closed Filters button counts each filter and its Clear puts them all back without opening the panel', async ({ page }) => {
    await boot(page, { site_messages: [msg({}), msg({ id: 8, kind: 'help' })] }, 'messages');
    const tab = page.locator('#tab-messages');
    await page.evaluate(`_sm().kind='business';_sm().who='__none';renderMessages()`);
    await expect(tab.locator('.f-show')).toContainText('(2)');
    await expect(tab.locator('#fm-sm')).not.toHaveClass(/open/);
    await tab.locator('.f-clr').click();
    expect(await page.evaluate('[_sm().kind,_sm().who]')).toEqual(['all', '']);
    await expect(tab.locator('.f-show')).not.toContainText('(');
    await expect(tab.locator('.f-clr')).toHaveCount(0);
    await expect(tab.locator('#fm-sm')).not.toHaveClass(/open/);
  });

  test('a spec counts what a regex over the markup missed: a typed box and a period', async ({ page }) => {
    await boot(page);
    // the customer box in History > Customer activity is a text input; the volunteers' hours period is a picker with dates
    expect(await page.evaluate(`S._cactCustQ='lina';S._cactDay='7';_fOn([..._fS(S,'_cactDay=all'),{key:'q',isOn:()=>!!S._cactCustQ}])`)).toBe(2);
    expect(await page.evaluate(`_fOn(_fS({a:'all',b:'',c:[],d:false,e:'x',f:'active'},'a b c d e f=active'))`)).toBe(1);
    expect(await page.evaluate(`const o={s:'all'};_fS(o,'s=active')[0].isOn()`)).toBe(true);
  });
});

test.describe('@staff:lists saved views follow the account', () => {
  test('a private view is saved in the account prefs (views.<section>), and this browser\'s old views move there', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cq_views', JSON.stringify([{ id: 'old1', sec: 'workshop', name: 'Ready ones', state: { filter: 'ready', q: '' } }])));
    await boot(page, { workshop_jobs: [job()], workshop_job_events: [] });
    const rpc = sent(page, /\/rpc\/staff_my_prefs$/);
    await page.evaluate(`S._staffAuthed=true;setStaffTab('workshop')`);
    await expect.poll(() => page.evaluate(`_pref('views.workshop',[]).map(v=>v.name)`)).toEqual(['Ready ones']);
    expect(await page.evaluate(`localStorage.getItem('cq_views')`)).toBeNull();
    // a new one goes in beside it, slim: only what differs from the section's defaults
    await page.evaluate(`_wsSetFilter('all')`);
    await page.locator('#tab-workshop .sv-save').click();
    await page.fill('#sv-name', 'Everything');
    await page.click('#sv-ok');
    await expect.poll(() => page.evaluate(`_pref('views.workshop',[]).map(v=>v.name)`)).toEqual(['Ready ones', 'Everything']);
    expect(await page.evaluate(`_pref('views.workshop',[])[1].state`)).toEqual({ filter: 'all' });
    await expect.poll(() => rpc.some((r) => Object.keys((r.postDataJSON() || {}).p_set || {}).includes('views.workshop')), { timeout: 8000 }).toBe(true);
    // Inventory and Analytics can save views too
    expect(await page.evaluate(`!!SV_SECS.inventory&&!!SV_SECS.analytics&&_svBar('inventory').includes('sv-save')`)).toBe(true);
  });
});

test.describe('@staff:lists People in five groups', () => {
  test('the groups, their second row, and a view reached by its address lights its group', async ({ page }) => {
    await boot(page, { customers: [{ id: 'c1', name: 'Lina Haddad', email: 'l@example.test', phone: '0551112222', created_at: iso(864e5) }] }, 'community');
    const tab = page.locator('#tab-community');
    const groups = tab.locator('.cmy-nav').first().locator('.filter-pill');
    await expect(groups).toHaveText(['Overview', /^Accounts/, 'Membership', 'Recognition', 'Activity', 'More']);
    await groups.filter({ hasText: 'Recognition' }).click();
    expect(await page.evaluate('S.communityTab')).toBe('badges');
    await expect(tab.locator('.ppl-sub .filter-pill')).toHaveText(['Badges', 'Titles', 'Members’ page']);
    await page.evaluate(`setCommTab('referrals')`);
    await expect(tab.locator('[data-ppl-grp="activity"]')).toHaveClass(/active/);
    await expect(tab.locator('.ppl-sub .filter-pill')).toHaveText(['Activity', /^Referrals/]);
    await expect(tab.locator('.ppl-sub .filter-pill.active')).toHaveText(/^Referrals/);
  });
});

test.describe('@staff:lists Team', () => {
  test('cards carry the name with the email under it; a search and Filters find an account', async ({ page }) => {
    await boot(page, {
      'rpc:staff_operator_list': [],
      'rpc:staff_team_list': [{ user_id: 'u1', email: 'sara@example.test', role: 'frontdesk', modules_view: null, modules_edit: null }, { user_id: 'u2', email: 'omar@example.test', role: 'mechanic', modules_view: null, modules_edit: null }],
      'rpc:staff_team_more': [{ user_id: 'u1', display_name: 'Sara Ali', caps: {} }],
    }, 'team');
    const tab = page.locator('#tab-team');
    await expect(tab.locator('.tm-acct')).toHaveCount(2);
    await expect(tab.locator('.tm-acct[data-acct="u1"] .tm-acct-head strong')).toHaveText('Sara Ali');
    await expect(tab.locator('.tm-acct[data-acct="u1"] .tm-mail')).toHaveText('sara@example.test');
    await expect(tab.locator('.tm-acct[data-acct="u2"] .tm-acct-head strong')).toHaveText('omar@example.test');
    await page.evaluate(`_tmF('fr','mechanic')`);
    await expect(tab.locator('.tm-acct')).toHaveCount(1);
    await expect(tab.locator('.f-show')).toContainText('(1)');
    await tab.locator('.f-clr').click();
    await expect(tab.locator('.tm-acct')).toHaveCount(2);
    const fold = tab.locator('[data-srch="tm"] .srch-btn'); // a phone folds the search into a button
    if (await fold.isVisible()) await fold.click();
    await page.locator('#tm-q').fill('sara');
    await expect(tab.locator('.tm-acct')).toHaveCount(1);
    await expect(page.locator('#tm-q')).toBeFocused();
  });
});

test.describe('@staff:lists History > Log', () => {
  test('device and shared lines merge on their client id: two desks logging the same words in a minute both show', async ({ page }) => {
    await boot(page, { staff_actions: [
      { id: 1, at: iso(20000), action: 'Marked paid: #4 Lina', who: 'Desk 1', client_id: 'cidA' },
      { id: 2, at: iso(10000), action: 'Marked paid: #4 Lina', who: 'Desk 2', client_id: 'cidB' },
    ] });
    // this device wrote cidA (in the table) and cidC (not there yet: its insert has not landed)
    await page.evaluate(`S.fullLog=[{ts:Date.now()-20000,cid:'cidA',label:'Marked paid: #4 Lina',by:'Desk 1'},{ts:Date.now()-15000,cid:'cidC',label:'Marked paid: #4 Lina',by:'Desk 1'}];setStaffTab('history');S.histView='log';renderHistory()`);
    await expect(page.locator('#hist-log-host .lg-row, #tab-history .lg-row')).toHaveCount(3);
  });

  test('a line from logAction carries a client id to staff_actions', async ({ page }) => {
    await boot(page);
    const w = sent(page, /\/rest\/v1\/staff_actions$/);
    const cid = await page.evaluate(`logAction('Spec line')`);
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].postDataJSON()).toMatchObject({ action: 'Spec line', client_id: cid });
  });

  test('an admin undoes another device\'s check-in from the Log; the line is marked undone', async ({ page }) => {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    await boot(page, {
      sessions: [{ id: day, day: 'Monday', session_date: day, capacity: 40, status: 'open', created_at: 1 }],
      queue_entries: [{ id: 'b3', session_id: day, session_day: 'Monday', session_date: day, queue_num: 3, name: 'Laila', phone: '0500000003', status: 'active', paid: true, price: 75, type_preference: 'Road', registered_at: iso(864e5), checked_in_at: iso(600000), assigned_bike_id: null }],
      staff_actions: [{ id: 11, at: iso(600000), action: 'Check in: #3 Laila', who: 'Desk 2', kind: 'checkin', entity: 'booking', entity_id: 'b3', client_id: 'k1' }],
    });
    const q = sent(page, /\/rest\/v1\/queue_entries$/), a = sent(page, /\/rest\/v1\/staff_actions$/);
    await page.evaluate(`setStaffTab('history');S.histView='log';renderHistory()`);
    const row = page.locator('#tab-history .lg-row', { hasText: 'Check in: #3 Laila' });
    await row.getByRole('button', { name: 'Undo' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => q.some((r) => r.method() === 'PATCH' && (r.postDataJSON() || {}).status === 'waiting')).toBe(true);
    await expect.poll(() => a.map((r) => r.postDataJSON()).find((b) => b && b.client_id === 'u:k1')).toMatchObject({ kind: 'uncheckin', entity: 'booking', entity_id: 'b3' });
    await expect(page.locator('#tab-history .lg-row', { hasText: 'Check in: #3 Laila' }).locator('.lg-undone')).toHaveText('Already undone');
  });

  test('a check-in already returned is not undone: it says so', async ({ page }) => {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    await boot(page, {
      sessions: [{ id: day, day: 'Monday', session_date: day, capacity: 40, status: 'open', created_at: 1 }],
      queue_entries: [{ id: 'b3', session_id: day, session_day: 'Monday', session_date: day, queue_num: 3, name: 'Laila', phone: '0500000003', status: 'done', paid: true, price: 75, type_preference: 'Road', registered_at: iso(864e5) }],
      staff_actions: [{ id: 11, at: iso(600000), action: 'Check in: #3 Laila', who: 'Desk 2', kind: 'checkin', entity: 'booking', entity_id: 'b3', client_id: 'k1' }],
    });
    const q = sent(page, /\/rest\/v1\/queue_entries$/);
    await page.evaluate(`setStaffTab('history');S.histView='log';renderHistory()`);
    await page.locator('#tab-history .lg-row', { hasText: 'Check in: #3 Laila' }).getByRole('button', { name: 'Undo' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('#toast, .toast').first()).toContainText('Already returned');
    expect(q.filter((r) => r.method() === 'PATCH')).toHaveLength(0);
  });
});
