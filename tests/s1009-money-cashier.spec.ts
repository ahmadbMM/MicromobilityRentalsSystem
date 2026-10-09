import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Money controls at the desk (2026-10-09; migration 20261009150000): a void or a refund asks why and
// sends it (B3), History's bulk Mark paid asks how they paid (B2), the till opens with a float, is
// counted and closed with expected vs counted (M4), a sale on a day with no ride belongs to no session
// and every sale names its seller (M5), and the printed receipt is a simplified tax invoice (M23).
const TOMORROW = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [{ id: 's0', day: 'Friday', session_date: TOMORROW, capacity: 12, status: 'open', created_at: 1 }];
const sale = { id: 'sale1', receipt_id: 'r1', session_id: 's0', item_id: 'it1', name: 'Water', qty: 2, price: 5, pay: 'paid', category: 'drinks', created_at: new Date().toISOString(), customer_name: 'Buyer', sold_by_name: 'Spec Staff' };
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, session_id: 's0', session_day: 'Friday', session_date: TOMORROW, queue_num: 1, name: 'Rider ' + id, phone: '0500000001', status: 'done', paid: false, price: 75, type_preference: 'Road', registered_at: '2026-01-01T10:00:00Z', ...extra });
type Call = { name: string; body: Record<string, unknown> };
const one = (b: unknown) => (Array.isArray(b) ? b[0] : b) as Record<string, unknown>;

async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [row('q1')], bikes: [], cashier_sales: [sale], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`localStorage.setItem('cq_op_name','Spec Staff');S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();`);
}
const rpcs = (page: Page) => {
  const calls: Call[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); } });
  return calls;
};
const posts = (page: Page, table: string) => {
  const out: { method: string; body: unknown; url: string }[] = [];
  page.on('request', (r) => { if (['PATCH', 'POST'].includes(r.method()) && r.url().includes(`/rest/v1/${table}`)) { let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ } out.push({ method: r.method(), body, url: r.url() }); } });
  return out;
};

test.describe('@staff:sales money controls at the desk', () => {
  test('a void asks why: a reason is required, Other needs words, and the reason goes to the server and the log', async ({ page }) => {
    await boot(page, { 'rpc:staff_void_receipt': { ok: true, receipt_id: 'r1', count: 1, items: [] } });
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('cashier');S._ctSession='s0';renderCashier()`);
    await page.locator('#tab-cashier').getByRole('button', { name: 'Void', exact: true }).first().click();
    const dlg = page.getByRole('dialog', { name: /Why is this sale voided/ });
    await expect(dlg).toBeVisible();
    const go = dlg.getByRole('button', { name: 'Void', exact: true });
    await expect(go).toBeDisabled();
    await dlg.getByRole('button', { name: 'Other' }).click();
    await expect(dlg.getByRole('button', { name: 'Other' })).toHaveAttribute('aria-pressed', 'true');
    await expect(go).toBeDisabled(); // Other needs words
    await dlg.locator('textarea').fill('Card machine charged twice');
    await expect(go).toBeEnabled();
    await go.click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_void_receipt').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_void_receipt')!.body).toMatchObject({ p_receipt_id: 'r1', p_reason: 'other: Card machine charged twice' });
    const last = await page.evaluate(`S.fullLog[S.fullLog.length-1]`) as { label: string; m: Record<string, unknown> };
    expect(last.label).toContain('Card machine charged twice');
    expect(last.m).toMatchObject({ kind: 'void', entity: 'receipt', entity_id: 'r1' });
  });

  test('a refund asks why, and an offline one keeps the reason in the outbox', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('cashier');S._ctSession='s0';renderCashier()`);
    await page.route(/\/rest\/v1\/rpc\/staff_refund_receipt/, (r) => r.abort('internetdisconnected'));
    await page.locator('#tab-cashier').getByRole('button', { name: 'Refund', exact: true }).first().click();
    const dlg = page.getByRole('dialog', { name: /Why is this receipt refunded/ });
    await dlg.getByRole('button', { name: 'Faulty or damaged' }).click();
    await dlg.getByRole('button', { name: 'Refund', exact: true }).click();
    await expect.poll(() => page.evaluate(`_outbox().filter(o=>o.kind==='refund').map(o=>o.data.p_reason)`)).toEqual(['faulty']);
  });

  test('cancelling the reason voids nothing', async ({ page }) => {
    await boot(page);
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('cashier');S._ctSession='s0';renderCashier()`);
    await page.locator('#tab-cashier').getByRole('button', { name: 'Void', exact: true }).first().click();
    await page.getByRole('dialog', { name: /Why is this sale voided/ }).getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(200);
    expect(calls.filter((c) => /void/.test(c.name))).toEqual([]);
    expect(await page.evaluate(`S.cashSales.some(r=>r.id==='sale1')`)).toBe(true);
  });

  test('History bulk Mark paid asks how they paid and records cash as cash', async ({ page }) => {
    await boot(page, { queue_entries: [row('h1'), row('h2')] });
    const w = posts(page, 'queue_entries');
    await page.evaluate(`setStaffTab('history');renderHistory();S.histSelected=['h1','h2'];void bulkHistMarkPaid()`);
    const dlg = page.getByRole('dialog', { name: 'How did they pay?' });
    await expect(dlg).toContainText('2 booking(s)');
    await dlg.getByRole('button', { name: 'Cash', exact: true }).click();
    await expect.poll(() => w.filter((x) => x.method === 'PATCH').length).toBe(2);
    w.forEach((x) => expect(x.body).toMatchObject({ paid: true, pay_method: 'cash', card_amount: null }));
  });

  test('the till: open with a float, count, close with expected vs counted, and the Z-report', async ({ page }) => {
    await boot(page, { till_sessions: [], till_counts: [], queue_entries: [row('c1', { paid: true, price: 75 })] });
    const ts = posts(page, 'till_sessions');
    const tc = posts(page, 'till_counts');
    await page.evaluate(`setStaffTab('cashier');S._ctSession='s0';renderCashier()`);
    await page.locator('#tab-cashier').getByRole('button', { name: 'Till', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: /^Till/ });
    await expect(dlg).toContainText('No till is open');
    await dlg.locator('#mny-till-float').fill('100');
    await dlg.getByRole('button', { name: 'Open till' }).click();
    await expect.poll(() => ts.filter((x) => x.method === 'POST').length).toBe(1);
    expect(one(ts[0].body)).toMatchObject({ session_id: 's0', float: 100, day: TOMORROW, opened_by_name: 'Spec Staff' });
    // expected cash: the float + the cash rental (75, no card) + the cash sale (10)
    await expect(dlg).toContainText('SAR 185');
    await dlg.locator('#mny-till-cash').fill('180');
    await dlg.getByRole('button', { name: 'Count the drawer' }).click();
    await expect.poll(() => tc.length).toBe(1);
    expect(one(tc[0].body)).toMatchObject({ counted_cash: 180, expected_cash: 185 });
    await expect(dlg).toContainText('Short SAR 5');
    await dlg.locator('#mny-till-cash').fill('185');
    await dlg.locator('#mny-till-card').fill('0');
    await dlg.getByRole('button', { name: 'Close till' }).click();
    await expect.poll(() => ts.filter((x) => x.method === 'PATCH').length).toBe(1);
    expect(ts.find((x) => x.method === 'PATCH')!.body).toMatchObject({ counted_cash: 185, expected_cash: 185, card_expected: 0, card_terminal_total: 0 });
    await expect(dlg).toContainText('Till closed');
    await expect(dlg).toContainText('Exact');
    await page.evaluate(`window.open=()=>({closed:false,document:{write:(h)=>{window.__z=(window.__z||'')+h;},close(){},querySelectorAll:()=>[]},focus(){},print(){},close(){}})`);
    await dlg.getByRole('button', { name: /Z-report/ }).click();
    await expect.poll(() => page.evaluate(`window.__z||''`)).toContain('Opening float');
    expect(await page.evaluate(`window.__z`)).toContain('SAR 185.00');
    const logged = await page.evaluate(`S.fullLog.slice(-4).map(l=>(l.m||{}).kind)`);
    expect(logged).toEqual(expect.arrayContaining(['till_open', 'till_count', 'till_close']));
  });

  test('with no ride at all, the shop sells: no session, the seller named', async ({ page }) => {
    await boot(page, { sessions: [], queue_entries: [], cashier_sales: [] });
    const cs = posts(page, 'cashier_sales');
    await page.evaluate(`setStaffTab('cashier');renderCashier()`);
    await expect(page.locator('#tab-cashier select').first()).toHaveValue('__shop__');
    await page.evaluate(`S._ctCart=[{name:'Gel',cat:'EnergyGels',qty:1,price:12,pay:'paid',item_id:null}];_ctRecord()`);
    await expect.poll(() => cs.filter((x) => x.method === 'POST').length).toBeGreaterThan(0);
    const body = cs.find((x) => x.method === 'POST')!.body as Record<string, unknown>[];
    const lines = Array.isArray(body) ? body : [body];
    expect(lines[0]).toMatchObject({ session_id: null, sold_by_name: 'Spec Staff', name: 'Gel' });
    await expect(page.locator('#tab-cashier')).toContainText('Gel');
  });

  test('the receipt is a simplified tax invoice: seller, VAT number, number, VAT inside, ZATCA QR', async ({ page }) => {
    await boot(page, { receipt_numbers: [{ receipt_id: 'r1', no: 42 }] });
    await page.evaluate(`S.staffOptions={...S.staffOptions,biz:{vat_no:'300000000000003',legal_name:'MicroMobility Test Co.'}}`);
    const pop = page.waitForEvent('popup');
    await page.evaluate(`setStaffTab('cashier');S._ctSession='s0';renderCashier();_ctReprint('r1')`);
    const w = await pop;
    const body = w.locator('body');
    await expect(body).toContainText('MicroMobility Test Co.');
    await expect(body).toContainText('300000000000003');
    await expect(body).toContainText('000042');
    await expect(body).toContainText('VAT 15%');
    await expect(body).toContainText('SAR 1.3'); // 10 incl. 15%: 1.30 VAT
    await expect(body).toContainText('Spec Staff');
    await expect(w.locator('.rc-qr img')).toHaveAttribute('src', /^data:image\/png/);
    // the QR's TLV: tag 1 seller, 2 VAT number, 3 time, 4 total, 5 VAT
    const tlv = await page.evaluate(`(()=>{const b=atob(_zatcaTlv(['A','300000000000003','2026-10-09T18:00:00Z','10.00','1.30']));const out=[];let i=0;while(i<b.length){const tg=b.charCodeAt(i),n=b.charCodeAt(i+1);out.push([tg,b.slice(i+2,i+2+n)]);i+=2+n;}return out;})()`);
    expect(tlv).toEqual([[1, 'A'], [2, '300000000000003'], [3, '2026-10-09T18:00:00Z'], [4, '10.00'], [5, '1.30']]);
  });
});
