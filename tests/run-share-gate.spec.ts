import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, rateGateOn, unlockStaff } from './helpers/supabase';

// Run for Her: a runner agrees before their details go to Sela and JYC (the owner, 2026-10-06: "add a pop
// up for all customers that are booking or already have booked or even added to the run for her and force
// them to approve it, that we will share the following info about them with Sela/JYC in order to
// participate in the race"; "its for the run for her participants only"). The booking's own ask is in
// run-for-her.spec.ts. Here: a runner booked before the change, or added at the desk, gets a page that
// stays up until they agree (Log out is the only way off), after any waiver and before the rating;
// agreeing calls customer_accept_share (20261006180000). Staff see who agreed on the run's report.

const RUN = '2099-10-17-rh';
const run = {
  id: RUN, session_date: '2099-10-17', day: 'Saturday', status: 'open', capacity: 80, created_at: 1,
  event_kind: 'community', ride_kind: 'runher', needs_approval: false, hide_queue: true, spots: 80, open_to_all: false,
  paid_ride: false, location: 'JYC', bike_slots: '{"_time":"06:00 - 06:30"}',
};
const jcc = { id: '2099-10-18', session_date: '2099-10-18', day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":12}' };
const row = (id: string, x: Record<string, unknown> = {}) => ({
  id, name: 'Spec Runner', customer_id: 'c1', session_id: RUN, session_day: 'Saturday', session_date: '2099-10-17', queue_num: 7,
  type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0, registered_at: '2099-10-01T10:00:00Z', run_km: 5,
  waiver_version: 'activity-2026-10-v2', waiver_at: '2099-10-01T10:00:00Z', data_share_at: null, ...x,
});
const open = (page: Page) => page.evaluate(`!!S._sg&&document.getElementById('share-gate').style.display==='block'`);

async function boot(page: Page, queue: unknown[], extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [run, jcc], 'rpc:list_sessions': [run, jcc], queue_entries: queue, 'rpc:my_bookings': queue,
    'rpc:customer_accept_share': 1, 'rpc:customer_accept_waiver': 1, 'rpc:community_member': true, ...extra });
  await rateGateOn(page);
  await loginCustomer(page, { id: 'c1' });
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/customer_accept_share')) { try { calls.push(r.postDataJSON()); } catch { /* */ } } });
  await page.goto('/');
  await waitForSb(page);
  return calls;
}

test.describe('@customer:runher a runner agrees to share their details', () => {
  test('a runner booked before opens an unskippable page with what is shared; agreeing records it', async ({ page }) => {
    const calls = await boot(page, [row('q1')]);
    await expect.poll(() => open(page)).toBe(true);
    const m = page.locator('#share-gate');
    await expect(m.locator('.fx-kicker')).toHaveText('Before the race');
    await expect(m.locator('#sg-title')).toHaveText('Sharing your details for the race');
    await expect(m.locator('.wg-ev')).toHaveText('Run for Her');
    await expect(m.locator('.wg-ln').nth(0)).toContainText('Saturday');
    await expect(m.locator('.wg-ln').nth(2)).toContainText('Jeddah Yacht Club');
    await expect(m.locator('#sg-sub')).toHaveText('To take part in the race, we will share these details about you with Sela and Jeddah Yacht Club (JYC):');
    await expect(m.locator('.sg-list li')).toHaveText(['Full name', 'Email address', 'Birth date', 'Distance chosen · 5 km', 'Emergency contact']);
    await expect(m.locator('.gate-out')).toHaveText('Log out'); // the only way off: no close
    const btn = m.locator('.pg-btn');
    await expect(btn).toBeDisabled();
    // Escape, a tab change and the backdrop leave it up
    await page.keyboard.press('Escape');
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    await m.locator('.auth-backdrop').click({ position: { x: 3, y: 3 } });
    expect(await open(page)).toBe(true);
    await m.locator('.wg-cb').check();
    await btn.click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_session_id: RUN });
    await expect.poll(() => open(page)).toBe(false);
    expect(await page.evaluate(`typeof getQueue().find(e=>e.id==='q1').shareAt`)).toBe('string');
    await page.evaluate(`setCustTab('register');setCustTab('myrides')`);
    expect(await open(page)).toBe(false);
  });

  test('only the run asks, and only a live row ahead that has not agreed', async ({ page }) => {
    const { data_share_at: _drop, ...noColumn } = row('q5');
    void _drop;
    await boot(page, [
      row('q1', { data_share_at: '2099-10-02T08:00:00Z' }),
      row('q2', { status: 'cancelled' }),
      row('q3', { status: 'done' }),
      row('q4', { session_id: jcc.id, session_day: 'Sunday', session_date: jcc.session_date, type_preference: 'Hybrid', price: 75, run_km: null, waiver_version: '2026-10-v3' }),
      row('q6', { session_id: '2020-10-17-rh', session_date: '2020-10-17' }),
      noColumn,
    ]);
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    await page.waitForTimeout(300);
    expect(await open(page)).toBe(false);
  });

  test('a runner staff added agrees to the waiver first, then to sharing', async ({ page }) => {
    const calls = await boot(page, [row('q1', { waiver_version: null, waiver_at: null })]);
    await expect.poll(() => page.evaluate(`!!S._wg`)).toBe(true);
    expect(await open(page)).toBe(false);
    await page.locator('#waiver-gate .wg-cb').check();
    await page.locator('#waiver-gate .pg-btn').click();
    await expect.poll(() => open(page)).toBe(true);
    await page.locator('#share-gate .wg-cb').check();
    await page.locator('#share-gate .pg-btn').click();
    await expect.poll(() => open(page)).toBe(false);
    expect(calls.length).toBe(1);
  });

  test('a failed save keeps the page up and says so; a database without the function lets the runner through', async ({ page }) => {
    const calls = await boot(page, [row('q1')], { 'rpc:customer_accept_share': -1 });
    await expect.poll(() => open(page)).toBe(true);
    const m = page.locator('#share-gate');
    await m.locator('.wg-cb').check();
    await m.locator('.pg-btn').click();
    await expect(m.locator('.pg-net')).toBeVisible();
    expect(await open(page)).toBe(true);
    expect(calls.length).toBe(1);
    await page.route('**/rest/v1/rpc/customer_accept_share', (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.customer_accept_share in the schema cache' }) }));
    await m.locator('.pg-btn').click();
    await expect.poll(() => open(page)).toBe(false);
  });

  test('in Arabic the page names Sela and the Yacht Club in Arabic', async ({ page }) => {
    await boot(page, [row('q1')]);
    await expect.poll(() => open(page)).toBe(true);
    await page.evaluate(`setLang('ar')`);
    await expect(page.locator('#share-gate #sg-title')).toHaveText('مشاركة بياناتك للسباق');
    await expect(page.locator('#share-gate #sg-sub')).toContainText('صلة ونادي جدة لليخوت');
  });

  test('Log out takes the page down with the account', async ({ page }) => {
    await boot(page, [row('q1')]);
    await expect.poll(() => open(page)).toBe(true);
    await page.locator('#share-gate .gate-out').click();
    await expect.poll(() => open(page)).toBe(false);
    expect(await page.evaluate(`S.loggedIn`)).toBe(null);
  });
});

test.describe('@staff:bookings the run report says who agreed to share', () => {
  test('an "Agreed to share" column on the run, Yes or Not yet', async ({ page }) => {
    const rows = [
      row('r1', { customer_id: 'c1', name: 'Runner One', queue_num: 1, data_share_at: '2099-10-02T08:00:00Z' }),
      row('r2', { customer_id: 'c2', name: 'Runner Two', queue_num: 2 }),
    ];
    await stubSupabase(page, { sessions: [run, jcc], bikes: [], queue_entries: rows });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${RUN}';renderStaffQueue();S._repOpts=null;showPrintReportOptions()`);
    await expect(page.locator('#print-opts-modal [data-rep="cols:share"]')).toBeVisible();
    await page.evaluate(`window.__rep=[];window.open=()=>{const w={document:{write:(h)=>{window.__rep.push(h);},close(){},querySelectorAll:()=>[],fonts:{ready:Promise.resolve()},images:[]},focus(){},print(){}};return w;}`);
    await page.evaluate('printSessionReport()');
    await expect.poll(() => page.evaluate('window.__rep.length')).toBe(1);
    const html = (await page.evaluate('window.__rep[0]')) as string;
    expect(html).toMatch(/<th>Agreed to share<\/th>/);
    const tr = (who: string) => html.split('<tr>').find((x) => x.includes(who)) || '';
    expect(tr('Runner One')).toContain('<td>Yes</td>');
    expect(tr('Runner Two')).toContain('>Not yet</span></td>');
    // a ride night has no such column
    await page.evaluate(`S.sfSession='${jcc.id}';renderStaffQueue();S._repOpts=null;showPrintReportOptions()`);
    await expect(page.locator('#print-opts-modal [data-rep="cols:share"]')).toHaveCount(0);
  });
});
