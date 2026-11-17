import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A Petromin night's visitor (the user, 2026-11-17: "add a visitor choice in petromin nights that only staff can see and
// give to members and consider it free 0 sar"): queue_entries.pm_visitor (migration 20261117120000). Staff give it from a
// member's booking menu on Bookings, asked first; the database makes the ride paid at 0 (_pm_visitor_guard). A visitor
// wears Visitor on Bookings and is company Visitors on the Petromin page; there is no payment to take from them. A booking
// with no account, a guest's I- booking and a booking on another kind of night are not offered it; a booking paid with
// money is told to go back to Pending first. All Supabase traffic is stubbed.

const PM = '2099-02-08-pw', JC = '2099-02-09-jcc';
const sess = (id: string, date: string, over: Record<string, unknown>) => ({
  id, day: 'Sunday', session_date: date, capacity: 40, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 40 }), location: null, addons: null, needs_approval: false, ...over,
});
const sessions = [
  sess(PM, '2099-02-08', { event_kind: 'community', ride_kind: 'petromin', paid_ride: true, title: "Petromin's Circuit Night" }),
  sess(JC, '2099-02-09', { ride_kind: 'jcc' }),
];
const bk = (id: string, n: number, over: Record<string, unknown> = {}) => ({
  id, session_id: PM, session_day: 'Sunday', session_date: '2099-02-08', queue_num: n, name: `Rider ${id}`,
  phone: `+9665000000${String(n).padStart(2, '0')}`, customer_id: null, type_preference: 'Hybrid', size: 'M', height: 175,
  status: 'waiting', paid: false, price: 57.5, registered_at: '2099-02-01T10:00:00Z', walk_in: false, pm_visitor: false, ...over,
});
const rows = [
  bk('mem1', 1, { customer_id: 'c1' }),                                                    // a member, unpaid
  bk('mem2', 2, { customer_id: 'c2', paid: true, price: 57.5, pay_method: 'card' }),         // a member who paid
  bk('walk', 3, { walk_in: true }),                                                         // no account
  bk('gues', 4, { customer_id: 'c4', via: 'invite', invite_no: 'I-001', invite_company: 'Aramco' }), // a guest's I- booking
  bk('visi', 5, { customer_id: 'c5', pm_visitor: true, paid: true, price: 0 }),             // already a visitor
  bk('jccm', 1, { customer_id: 'c6', session_id: JC, session_date: '2099-02-09' }),           // a member on a circuit night
];

type Row = Record<string, unknown>;
async function boot(page: Page) {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));
  await page.setViewportSize({ width: 1280, height: 900 });
  await stubSupabase(page, { sessions, bikes: [], queue_entries: rows, customers: [], rider_registrations: [] });
  const patches: Row[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && /\/rest\/v1\/queue_entries/.test(r.url()) && /pm_visitor/.test(r.postData() || '')) patches.push(r.postDataJSON());
  });
  // The stub echoes writes without keeping them: a reload reads the rows as the database's trigger leaves them.
  await page.route(/\/rest\/v1\/queue_entries/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const last = patches.length ? patches[patches.length - 1] : null;
    const body = rows.map((x) => (x.id === 'mem1' && last ? { ...x, pm_visitor: last.pm_visitor, paid: !!last.pm_visitor, price: last.pm_visitor ? 0 : 57.5 } : x));
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  return { errs, patches };
}
const labels = (page: Page, id: string) =>
  page.evaluate(`((S._rowMenus||{})['${id}']||[]).map(x=>x.label.replace(/<[^>]*>/g,'').trim())`) as Promise<string[]>;
const showNight = (page: Page, sid: string) =>
  page.evaluate(`(()=>{setStaffTab('queue');S.queueView='bookings';setSfSession(${JSON.stringify(sid)});})()`);

test.describe('@staff:bookings Petromin visitor', () => {
  test('offered on a member\'s booking on a Petromin night, asked first; the ride then reads Visitor and has nothing to pay', async ({ page }) => {
    const { errs, patches } = await boot(page);
    await showNight(page, PM);
    await expect.poll(() => labels(page, 'mem1')).toContain('Make visitor (free)');
    expect(await labels(page, 'walk')).not.toContain('Make visitor (free)');   // no account
    expect(await labels(page, 'gues')).not.toContain('Make visitor (free)');   // a guest's I- booking
    expect(await labels(page, 'visi')).toContain('Not a visitor');
    // the visitor already there: its mark, and no payment pill
    const visi = page.locator('#tab-queue tr[data-id="visi"]').first();
    await expect(visi.locator('.pmv-badge')).toHaveText('Visitor');
    await expect(visi.locator('.pay-toggle')).toHaveCount(0);
    // an unpaid member pays until made a visitor
    const mem1 = page.locator('#tab-queue tr[data-id="mem1"]').first();
    await expect(mem1.locator('.pay-toggle')).toHaveCount(1);
    await expect(mem1.locator('.pmv-badge')).toHaveCount(0);

    const ask = page.locator('#confirm-modal');
    void page.evaluate(`void _pmVisToggle('mem1')`).catch(() => {});
    await expect(ask).toContainText('Make Rider mem1 a visitor? The ride is free.');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(100);
    expect(patches).toEqual([]);

    void page.evaluate(`void _pmVisToggle('mem1')`).catch(() => {});
    await ask.getByRole('button', { name: 'Make visitor (free)' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ pm_visitor: true });
    await expect(mem1.locator('.pmv-badge')).toHaveText('Visitor');
    await expect(mem1.locator('.pay-toggle')).toHaveCount(0);
    expect(await page.evaluate(`(e=>[e.pmVisitor,e.paid,e.price])(_qGet('mem1'))`)).toEqual([true, true, 0]);
    await expect.poll(() => labels(page, 'mem1')).toContain('Not a visitor');

    // taken away, asked first
    void page.evaluate(`void _pmVisToggle('mem1')`).catch(() => {});
    await expect(ask).toContainText('Take visitor off Rider mem1?');
    await ask.getByRole('button', { name: 'Not a visitor' }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toEqual({ pm_visitor: false });
    await expect(mem1.locator('.pmv-badge')).toHaveCount(0);
    await expect(mem1.locator('.pay-toggle')).toHaveCount(1);
    expect(errs).toEqual([]);
  });

  test('a booking paid with money is told to go back to Pending first; another kind of night offers no visitor', async ({ page }) => {
    const { errs, patches } = await boot(page);
    await showNight(page, PM);
    await expect.poll(() => labels(page, 'mem2')).toContain('Make visitor (free)');
    await page.evaluate(`void _pmVisToggle('mem2')`);
    await expect(page.locator('.toast').last()).toContainText('This booking is paid. Set it back to Pending first.');
    await expect(page.locator('#confirm-modal')).not.toBeVisible();
    expect(patches).toEqual([]);
    // the database's refusal says the same words
    expect(await page.evaluate(`_errMessage({code:'P0001',message:'VISITOR_PAID'})`)).toBe('This booking is paid. Set it back to Pending first.');

    await showNight(page, JC);
    await expect.poll(() => page.evaluate(`Object.keys(S._rowMenus||{}).includes('jccm')`)).toBe(true);
    expect(await labels(page, 'jccm')).not.toContain('Make visitor (free)');
    expect(errs).toEqual([]);
  });

  test('a database without the column offers no visitor', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions, bikes: [], customers: [], rider_registrations: [],
      queue_entries: rows.filter((x) => !x.pm_visitor).map(({ pm_visitor: _drop, ...x }) => x) });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await showNight(page, PM);
    await expect.poll(() => page.evaluate(`Object.keys(S._rowMenus||{}).includes('mem1')`)).toBe(true);
    // the columns are learned from a full read (the poll, a reload); once known without pm_visitor, the menu leaves it out
    await page.evaluate(`(()=>{_qColsLearn(S.queue.slice(0,1).map(entryToDB));renderStaffQueue();})()`);
    await expect.poll(() => page.evaluate(`(_qCols||[]).includes('status')&&!(_qCols||[]).includes('pm_visitor')`)).toBe(true);
    await expect.poll(() => labels(page, 'mem1')).not.toContain('Make visitor (free)');
    expect(await labels(page, 'mem1')).toContain('Edit');
  });

  test('the Petromin page lists a visitor as company Visitors, and the Company filter keeps them alone', async ({ page }) => {
    const { errs } = await boot(page);
    await page.evaluate(`openPetrominPage(${JSON.stringify(PM)},'all')`);
    const visi = page.locator('#pm-host tr[data-id="visi"]');
    await expect(visi.locator('.pmv-badge')).toHaveText('Visitor');
    await expect(page.locator('#pm-host tr[data-id="mem1"] .bk-badge')).toHaveCount(1);
    const pick = page.locator('#pm-host select[aria-label="Company"]').first();
    await expect(pick.locator('option[value="Visitors"]')).toHaveText('Visitors');
    await page.evaluate(`openPetrominPage(${JSON.stringify(PM)},'Visitors')`);
    await expect(page.locator('#pm-host tbody tr')).toHaveCount(1);
    await expect(page.locator('#pm-host tbody tr[data-id="visi"]')).toHaveCount(1);
    expect(errs).toEqual([]);
  });

  test('a visitor\'s check-in asks no payment and reads Free', async ({ page }) => {
    const { errs } = await boot(page);
    await showNight(page, PM);
    await page.evaluate(`showCheckinModal('visi')`);
    const m = page.locator('#checkin-modal');
    await expect(m.locator('#ci-money .own-free')).toHaveText('Free');
    await expect(m.getByRole('button', { name: 'Pending', exact: true })).toHaveCount(0);
    expect(errs).toEqual([]);
  });
});
