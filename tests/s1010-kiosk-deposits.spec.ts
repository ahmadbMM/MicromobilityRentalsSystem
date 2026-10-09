import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The deposit ledger (2026-10-09; migration 20261009230000): Settings > Business names the bike types that
// leave a deposit and how much; the check-in asks how it was taken (card hold, cash, ID left) with a
// reference and writes it to `deposits`; the return hands it back or keeps part with a reason; the night
// summary lists what is held; the till counts held cash deposits in the drawer apart from the takings
// (never revenue); Exceptions lists kept deposits. Without the table the page carries on. Invented data only.
const SESSION = { id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 };
const ENTRY = {
  id: 'e1', session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 7,
  name: 'Rider Seven', phone: '', customer_id: null, group_id: null, status: 'waiting', paid: false,
  price: 120, walk_in: true, registered_at: '2099-01-01T10:00:00Z', type_preference: 'Road Carbon', size: 'M', height: 176,
};
const BIKE = { id: 'b1', name: 'Road 042', bike_number: 42, type: 'Road', size: 'M', status: 'available', colors: [], color_names: [] };
const BIZ = [{ key: 'biz', items: { deposits: { 'Road Carbon': 500 } } }];
const held = (x: Record<string, unknown> = {}) => ({ id: 'd1', booking_id: 'e1', bike_id: 'b1', session_id: 's0', day: '2099-02-10', customer_name: 'Rider Seven', amount: 500, method: 'cash', ref: 'Slip 12', taken_at: '2099-02-10T18:00:00Z', taken_by_name: 'Spec Staff', returned_at: null, returned_by_name: null, kept_amount: 0, kept_reason: '', ...x });
type Sent = { method: string; body: Record<string, unknown>; url: string };

async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { queue_entries: [ENTRY], sessions: [SESSION], bikes: [BIKE], staff_options: BIZ, ...fx });
  const sent: Sent[] = [];
  page.on('request', (r) => {
    if (!r.url().includes('/rest/v1/deposits') || !['POST', 'PATCH'].includes(r.method())) return;
    let b: unknown = {}; try { b = r.postDataJSON(); } catch { /* none */ }
    sent.push({ method: r.method(), body: (Array.isArray(b) ? b[0] : b) as Record<string, unknown>, url: decodeURIComponent(r.url()) });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  return sent;
}

test.describe('@staff:checkin s1010 deposits', () => {
  test('the check-in of a Road Carbon asks how the deposit was taken and writes it to the ledger; a Hybrid asks nothing', async ({ page }) => {
    const sent = await boot(page, { deposits: [] });
    await page.evaluate(`S.staffTab='queue';renderStaffQueue();showCheckinModal('e1')`);
    const modal = page.locator('#checkin-modal');
    const dep = modal.locator('.ci-dep');
    await expect(dep).toContainText('Deposit: take SAR 500');
    await modal.locator('#ci-confirm').click();
    await expect(modal.locator('#ci-error')).toContainText('how the deposit was taken'); // nothing is checked in yet
    await dep.locator('[data-dep-m="cash"]').click();
    await expect(dep.locator('[data-dep-m="cash"]')).toHaveAttribute('aria-pressed', 'true');
    await modal.locator('#ci-dep-ref').fill('Slip 12');
    await modal.locator('#ci-confirm').click();
    await expect.poll(() => sent.filter((s) => s.method === 'POST').length).toBe(1);
    expect(sent[0].body).toMatchObject({ booking_id: 'e1', amount: 500, method: 'cash', ref: 'Slip 12', session_id: 's0', day: '2099-02-10' });
    // the booking's own money is untouched: a deposit is not revenue
    const e = await page.evaluate(`(()=>{const e=getQueue().find(x=>x.id==='e1');return{price:e.price}})()`) as { price: number };
    expect(e.price).toBe(120);
    // another type: no deposit block
    await page.evaluate(`closeCheckinModal();S._deps=[];S._ciType='Hybrid';const e=getQueue().find(x=>x.id==='e1');e.status='waiting';e.typePreference='Hybrid';showCheckinModal('e1')`);
    await expect(modal.locator('.ci-dep')).toHaveCount(0);
  });

  test('the return hands the deposit back, or keeps part only with an amount and a reason', async ({ page }) => {
    const sent = await boot(page, { deposits: [held()], queue_entries: [{ ...ENTRY, status: 'active', assigned_bike_id: 'b1', paid: true }] });
    await page.evaluate(`_depLoad(true)`);
    await page.waitForFunction(`!!_depHeld('e1')`);
    await page.evaluate(`_execReturn('e1',false)`);
    const box = page.locator('#return-modal [role="dialog"]');
    await expect(box.locator('.ret-dep')).toContainText('Deposit held: SAR 500 · Cash');
    await box.getByRole('button', { name: 'Damaged' }).click();
    await box.locator('#ret-notes').fill('Bent wheel');
    await box.getByRole('button', { name: 'Keep part' }).click();
    await expect(box.locator('#ret-dep-why')).toHaveValue(/Damaged/); // the reason starts from the return's own words
    await box.locator('#ret-dep-amt').fill('900');
    await box.locator('#ret-confirm').click();
    await expect(box).toBeVisible(); // more than was taken: refused
    await box.locator('#ret-dep-amt').fill('150');
    await box.locator('#ret-confirm').click();
    await expect.poll(() => sent.filter((s) => s.method === 'PATCH').length).toBe(1);
    const p = sent.find((s) => s.method === 'PATCH')!;
    expect(p.body).toMatchObject({ kept_amount: 150 });
    expect(String(p.body.kept_reason)).toContain('Bent wheel');
    expect(p.url).toContain('id=eq.d1');
    expect(p.url).toContain('returned_at=is.null');
  });

  test('the night summary lists held deposits and settles one; the till counts held cash apart from the takings', async ({ page }) => {
    const sent = await boot(page, { deposits: [held()], queue_entries: [{ ...ENTRY, status: 'done', paid: true, pay_method: 'card' }], till_sessions: [{ id: 't1', day: '2099-02-10', session_id: 's0', float: 100, opened_at: '2099-02-10T17:00:00Z', opened_by_name: 'Spec Staff', closed_at: null }], till_counts: [] });
    // the ledger as the server keeps it: a settle is read back settled
    const store = [held()];
    await page.route(/\/rest\/v1\/deposits/, async (route) => {
      const req = route.request(), head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
      if (req.method() === 'PATCH') { Object.assign(store[0], req.postDataJSON()); return route.fulfill({ status: 200, headers: head, body: JSON.stringify(store) }); }
      if (req.method() === 'GET') return route.fulfill({ status: 200, headers: head, body: JSON.stringify(store) });
      return route.fallback();
    });
    await page.evaluate(`_depLoad(true)`);
    await page.waitForFunction(`!!_depHeld('e1')`);
    // the till: SAR 120 card rental, so cash sales 0; the deposit is in the drawer, not in the sales
    const take = await page.evaluate(`_tillTake(_tillCtx('s0'))`) as { cash: number; card: number; dep: number };
    expect(take).toMatchObject({ cash: 0, dep: 500 });
    await page.evaluate(`_eonOpen('s0',{})`);
    const sum = page.locator('#eon-modal [role="dialog"]');
    await expect(sum).toContainText('Deposits held');
    await expect(sum).toContainText('Rider Seven');
    await sum.getByRole('button', { name: 'Settle' }).click();
    const dlg = page.locator('#dep-modal [role="dialog"]');
    await expect(dlg).toContainText('Deposit held: SAR 500');
    await dlg.locator('#dep-go').click();
    await expect.poll(() => sent.filter((s) => s.method === 'PATCH').length).toBe(1);
    expect(sent[0].body).toMatchObject({ kept_amount: 0, kept_reason: '' });
    await expect(page.locator('#dep-modal [role="dialog"]')).toHaveCount(0);
    const take2 = await page.evaluate(`_tillTake(_tillCtx('s0'))`) as { dep: number };
    expect(take2.dep).toBe(0); // handed back: out of the drawer
  });

  test('Exceptions lists a kept deposit with its amount, who kept it and why', async ({ page }) => {
    await boot(page, { deposits: [held({ returned_at: '2099-02-10T21:00:00Z', returned_by_name: 'Spec Staff', kept_amount: 150, kept_reason: 'Damaged: bent wheel' })] });
    await page.evaluate(`_exS().from='2099-02-01';_exS().to='2099-02-28';_exLoad()`);
    await page.waitForFunction(`Array.isArray(_exS().items)&&!_exS().busy`);
    const it = await page.evaluate(`_exS().items.find(i=>i.type==='dep_kept')`) as Record<string, unknown>;
    expect(it).toMatchObject({ amt: 150, op: 'Spec Staff', reason: 'Damaged: bent wheel', cust: 'Rider Seven' });
  });

  test('Settings > Business saves the deposit amounts; without the table the check-in carries on with no deposit', async ({ page }) => {
    await boot(page, { staff_options: [] });
    await page.evaluate(`S.setView='business';setStaffTab('settings')`);
    const card = page.locator('[data-biz-card="deposits"]');
    await expect(card).toContainText('Deposits');
    await expect(card.locator('#biz-deposits-0')).toBeVisible();
    const r = await page.evaluate(`(()=>{document.getElementById('biz-deposits-0').value='500';document.getElementById('biz-deposits-2').value='12.5';return _bizRead('deposits');})()`) as { patch?: Record<string, unknown>; err?: unknown };
    expect(r.err).toBeTruthy();
    const ok = await page.evaluate(`(()=>{document.getElementById('biz-deposits-2').value='';return _bizRead('deposits');})()`) as { patch: Record<string, unknown> };
    expect(ok.patch).toEqual({ deposits: { 'Road Carbon': 500 } });
    // no deposits table (TABLES_NOT_YET_IN_DB): the load marks it off, and the check-in asks nothing
    await page.evaluate(`S.staffOptions={...(S.staffOptions||{}),biz:{deposits:{'Road Carbon':500}}};_depLoad(true)`);
    await page.waitForFunction(`S._depOff===true`);
    await page.evaluate(`setStaffTab('queue');showCheckinModal('e1')`);
    await expect(page.locator('#checkin-modal .ci-dep')).toHaveCount(0);
  });
});
