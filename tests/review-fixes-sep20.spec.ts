import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, captureBookingRows, checkinAsRow } from './helpers/supabase';

// The 2026-09-20 review: writes that reported success without happening, a device with no
// room left that still handed out tickets, and two checks that measured the wrong thing.

const D = '2099-02-08';
const PAST = '2020-01-05';
const sess = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Sunday', session_date: date, capacity: 9, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 9 }), location: 'JCC', addons: null, ...extra,
});
const sessions = [sess('s0', D), sess('s1', '2099-02-15')];
const inventory = [{ id: 'i1', name: 'Energy Gel', category: 'Supplements', qty: 10, price: 12, addon: true }];
const bikes = [
  { id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 },
  { id: 'b2', name: 'B2', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 },
];

test.describe('a customer reschedule really moves the booking', () => {
  const customers = [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.test', phone: '0500000001' }];
  const queue_entries = [{
    id: 'e1', customer_id: 'c1', session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: 3,
    name: 'Spec Rider', type_preference: 'Hybrid', size: 'M', status: 'waiting', paid: false, price: 57.5,
    registered_at: '2099-01-01T10:00:00Z',
  }];

  test('it goes through the customer RPC, not a bare table write that RLS drops', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, customers, queue_entries, 'rpc:customer_booking_update': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
    await page.goto('/');
    await waitForSb(page);
    const rpcs: Record<string, unknown>[] = [];
    const patches: string[] = [];
    page.on('request', (r) => {
      if (/rpc\/customer_booking_update/.test(r.url())) rpcs.push(JSON.parse(r.postData() || '{}'));
      if (r.method() === 'PATCH' && /rest\/v1\/queue_entries/.test(r.url())) patches.push(r.url());
    });
    await page.evaluate(`rescheduleBooking('s0','s1')`);
    await expect.poll(() => rpcs.length).toBe(1);
    // queue_entries UPDATE is is_staff()-only: a bare PATCH matches no policy, changes nothing
    // and returns no error, which used to read as success.
    expect(patches).toHaveLength(0);
    expect(rpcs[0].p_entry_id).toBe('e1');
    expect(rpcs[0].p_token).toBe('tok');
    expect((rpcs[0].p_patch as Record<string, unknown>).session_id).toBe('s1');
  });

  test('a refused move says so instead of toasting Rescheduled', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, customers, queue_entries, 'rpc:customer_booking_update': false });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`rescheduleBooking('s0','s1')`);
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await expect(page.locator('.toast', { hasText: /Rescheduled/i })).toHaveCount(0);
  });
});

test('handing a rider a bike keeps the price their promo code bought', async ({ page }) => {
  const queue_entries = [{
    id: 'e1', session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: 1, name: 'Promo Rider',
    type_preference: 'Hybrid', size: 'M', status: 'waiting', paid: false, price: 47.5, promo_code: 'SAVE10',
    registered_at: '2099-01-01T10:00:00Z',
  }];
  await stubSupabase(page, { sessions, bikes, queue_entries, inventory });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const patches: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    // the check-in is one staff_checkin call since 2026-10-05: read as the row it writes
    const row = checkinAsRow(r); if (row) { patches.push(row); return; }
    if (r.method() === 'PATCH' && /queue_entries/.test(r.url())) patches.push(JSON.parse(r.postData() || '{}'));
  });
  await page.evaluate(`(async()=>{S.modalRider='e1';S.modalBikes=['b1'];await confirmAssign();})()`);
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  // The bike's list price is 57.5; the discount they were quoted is 47.5.
  expect(patches.some((p) => Number(p.price) === 57.5)).toBe(false);
});

test.describe('a device with no room left does not hand out what it cannot store', () => {
  // localStorage that throws on every write, the way Safari does in private mode and any
  // browser does at the quota. The booking and the sale must both refuse, not confirm.
  const fillStorage = `(()=>{const t=localStorage.setItem.bind(localStorage);
    localStorage.setItem=(k,v)=>{if(String(k).startsWith('cq_'))throw new DOMException('QuotaExceededError');return t(k,v);};})()`;

  test('an offline booking that cannot be queued is refused, not confirmed', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, inventory, customers: [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.test' }] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
    await page.goto('/');
    await waitForSb(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(fillStorage);
    await page.evaluate(`Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true})`);
    await page.evaluate(
      `S.selSession='s0'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Hybrid'];
       S.regRiderNames=['Spec Rider']; S.promoApplied=null; S.waiverOk=true; submitReg();`,
    );
    await expect(page.locator('.toast', { hasText: /storage is full/i }).first()).toBeVisible();
    expect(rows).toHaveLength(0);                                  // nothing reached the server either
    expect(await page.evaluate(`_bookOutboxCount()`)).toBe(0);     // and nothing is queued to sync
    expect(await page.evaluate(`S.lastTickets.length`)).toBe(0);   // so no ticket was issued
  });

  test('a sale that cannot be queued is not reported as taken', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, inventory });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('cashier')`);
    await page.evaluate(fillStorage);
    await page.evaluate(`S._ctSession='s0';S._ctCart=[{item_id:'i1',name:'Energy Gel',cat:'Supplements',qty:1,price:12,pay:'paid',team:''}];`);
    await page.evaluate(`_ctRecord()`);
    await expect(page.locator('.toast', { hasText: /storage is full/i }).first()).toBeVisible();
    await expect(page.locator('.toast', { hasText: /recorded/i })).toHaveCount(0);
    expect(await page.evaluate(`(S._ctCart||[]).length`)).toBe(1); // the receipt stays to be re-entered
  });

  test('the storage writer frees what is disposable before giving up', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    // Only the first two writes fail: dropping the snapshot must be enough to get through.
    const ok = await page.evaluate(`(()=>{
      localStorage.setItem('cq_snapshot','x');
      const real=localStorage.setItem.bind(localStorage);let n=0;
      localStorage.setItem=(k,v)=>{if(k==='cq_probe'&&n++<1)throw new DOMException('QuotaExceededError');return real(k,v);};
      const r=_lsSetCritical('cq_probe','v');
      localStorage.setItem=real;
      return {r,snapshot:localStorage.getItem('cq_snapshot'),probe:localStorage.getItem('cq_probe')};
    })()`) as { r: boolean; snapshot: string | null; probe: string | null };
    expect(ok.r).toBe(true);
    expect(ok.snapshot).toBeNull();   // the disposable cache went
    expect(ok.probe).toBe('v');       // and the thing that matters landed
  });

  test('the voided-sale list stops growing without end', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const n = await page.evaluate(`(()=>{localStorage.removeItem('cq_sales_voided');
      for(let i=0;i<700;i++)_voidedAdd('v'+i);
      return JSON.parse(localStorage.getItem('cq_sales_voided')||'[]').length;})()`) as number;
    expect(n).toBe(500);
  });
});

test.describe('staff writes that used to report success without happening', () => {
  const queue_entries = [{
    id: 'e1', session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: 1, name: 'Spec Rider',
    type_preference: 'Hybrid', size: 'M', status: 'waiting', paid: false, price: 57.5,
    registered_at: '2099-01-01T10:00:00Z',
  }];

  test('a refused removal raises the error bar and does not say the rider was removed', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, queue_entries, inventory }, { table: 'queue_entries', methods: ['PATCH'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`doRemove('e1')`);
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await expect(page.locator('.toast', { hasText: /removed/i })).toHaveCount(0);
  });

  test('a refused cancel raises the error bar and does not say the booking was cancelled', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, queue_entries, inventory }, { table: 'queue_entries', methods: ['PATCH'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`_staffCancelNow('e1')`);
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await expect(page.locator('.toast', { hasText: /cancelled/i })).toHaveCount(0);
  });

  test('a refused bike delete says so instead of claiming the bike is gone', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, queue_entries }, { table: 'bikes', methods: ['DELETE'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffRole('admin')`);
    await page.evaluate(`delBike('b1')`);
    await page.locator('.confirm-box').getByRole('button', { name: /^delete$/i }).click();
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await expect(page.locator('.toast', { hasText: /removed/i })).toHaveCount(0);
  });

  test('a stock-take keeps the counts already typed when a write is refused', async ({ page }) => {
    const inv = [
      { id: 'i1', name: 'Gel', category: 'Supplements', qty: 10, price: 12, addon: true },
      { id: 'i2', name: 'Bar', category: 'Supplements', qty: 5, price: 9, addon: true },
    ];
    await stubSupabase(page, { sessions, bikes, inventory: inv }, { table: 'inventory', methods: ['PATCH'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('inventory');S.invSection='supplements';S.invCount=true;S.invCounts={i1:7,i2:4};renderInventory()`);
    await page.evaluate(`applyStockTake()`);
    await page.locator('.confirm-box').getByRole('button', { name: /apply/i }).click();
    await expect(page.locator('#err-bar-el')).toBeVisible();
    // Nothing applied, so both counts survive and the mode stays on.
    expect(await page.evaluate(`Object.keys(S.invCounts).length`)).toBe(2);
    expect(await page.evaluate(`S.invCount`)).toBe(true);
  });
});

test('a product still on a live booking cannot be deleted out from under it', async ({ page }) => {
  const queue_entries = [{
    id: 'e1', session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: 1, name: 'Spec Rider',
    type_preference: 'Hybrid', size: 'M', status: 'waiting', paid: false, price: 57.5,
    addons: JSON.stringify([{ id: 'i1', qty: 1 }]), registered_at: '2099-01-01T10:00:00Z',
  }];
  await stubSupabase(page, { sessions, bikes, queue_entries, inventory });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffRole('admin')`);
  const deletes: string[] = [];
  page.on('request', (r) => { if (r.method() === 'DELETE' && /inventory/.test(r.url())) deletes.push(r.url()); });
  await page.evaluate(`delInvItem('i1')`);
  await expect(page.locator('.toast', { hasText: /live booking/i })).toBeVisible();
  expect(deletes).toHaveLength(0);
});

test('a night that has already been and gone is not offered or accepted', async ({ page }) => {
  await stubSupabase(page, { sessions: [sess('sPast', PAST), sess('s1', '2099-02-15')], bikes, inventory,
    customers: [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.test' }] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  expect(await page.evaluate(`_sessPastDay(allSessions().find(s=>s.id==='sPast'))`)).toBe(true);
  expect(await page.evaluate(`_sessPastDay(allSessions().find(s=>s.id==='s1'))`)).toBe(false);
  const rows = await captureBookingRows(page);
  await page.evaluate(
    `S.selSession='sPast'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Hybrid'];
     S.regRiderNames=['Spec Rider']; S.promoApplied=null; S.waiverOk=true; submitReg();`,
  );
  await expect(page.locator('.toast')).toBeVisible();
  expect(rows).toHaveLength(0);
});

test('the staff move counts a place as held right through the ride', async ({ page }) => {
  // Capacity 9, nine live rows of which eight are done: spotsLeft is 0, so the move is refused.
  const rows = Array.from({ length: 9 }, (_, i) => ({
    id: `q${i}`, session_id: 's1', session_day: 'Sunday', session_date: '2099-02-15', queue_num: i + 1,
    name: `R${i}`, type_preference: 'Hybrid', size: 'M', status: i < 8 ? 'done' : 'waiting',
    paid: true, price: 57.5, registered_at: '2099-01-01T10:00:00Z',
  }));
  rows.push({ id: 'mover', session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: 1,
    name: 'Mover', type_preference: 'Hybrid', size: 'M', status: 'waiting', paid: false, price: 57.5,
    registered_at: '2099-01-01T10:00:00Z' } as (typeof rows)[number]);
  await stubSupabase(page, { sessions, bikes, queue_entries: rows, inventory });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  expect(await page.evaluate(`spotsLeft('s1')`)).toBe(0);
  const patches: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /queue_entries/.test(r.url())) patches.push(r.url()); });
  await page.evaluate(`showBookingEditModal('mover')`);
  await page.evaluate(`document.getElementById('be-sess').value='s1';saveBookingEdit()`);
  await expect(page.locator('.toast')).toBeVisible();
  expect(patches).toHaveLength(0);
});

test.describe('the till and the sheet agree about money', () => {
  const inv = [{ id: 'i1', name: 'Gel', category: 'Supplements', qty: 10, price: 12, addon: true }];

  test('a discount is sized from what the customer pays, not from the team tab', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, inventory: inv });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('cashier')`);
    // 40 on the customer's own tab, 60 on Ahmed's team tab, half off.
    await page.evaluate(`S._ctSession='s0';S._ctDisc='50';S._ctDiscPct=true;S._ctCart=[
      {item_id:null,name:'Water',cat:'Drinks',qty:1,price:40,pay:'paid',team:''},
      {item_id:null,name:'Gel',cat:'Supplements',qty:1,price:60,pay:'team',team:'Ahmed'}];`);
    expect(await page.evaluate(`_ctChargeableTotal(S._ctCart)`)).toBe(40);
    // Half of the chargeable 40, not half of the whole 100.
    expect(await page.evaluate(`_ctDiscountSAR(_ctChargeableTotal(S._ctCart))`)).toBe(20);
    await page.evaluate(`_ctRecord()`);
    const t = await page.evaluate(`_salesTotals(_cashSessionLines('s0'))`) as { collected: number; pending: number; team: number };
    expect(t.collected).toBe(20);   // paid 40 less the 20 that was actually theirs
    expect(t.pending).toBe(0);      // nothing pushed into pending that nobody owes
    expect(t.team).toBe(60);        // the team's line is untouched
  });

  test('the printed sheet and the CSV both carry the discount line, so the rows add up', async ({ page }) => {
    // The export needs a rider on the night, or it bails before it reaches the sales block.
    const queue_entries = [{
      id: 'e1', session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: 1, name: 'Spec Rider',
      type_preference: 'Hybrid', size: 'M', status: 'done', paid: true, price: 57.5,
      registered_at: '2099-01-01T10:00:00Z',
    }];
    await stubSupabase(page, { sessions, bikes, inventory: inv, queue_entries });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('cashier')`);
    await page.evaluate(`S._ctSession='s0';S._ctDisc='5';S._ctDiscPct=false;S._ctCart=[
      {item_id:null,name:'Water',cat:'Drinks',qty:2,price:10,pay:'paid',team:''}];`);
    await page.evaluate(`_ctRecord()`);
    const tot = await page.evaluate(`_salesTotals(_cashSessionLines('s0'))`) as { value: number; discount: number };
    expect(tot.discount).toBe(5);
    expect(tot.value).toBe(15);
    // printSessionReport opens a window; catch what it hands to _openReport instead.
    const sheet = await page.evaluate(`(()=>{const real=window._openReport;let html='';
      window._openReport=(h)=>{html=h;};S.sfSession='s0';printSessionReport();window._openReport=real;return html;})()`) as string;
    expect(sheet).toMatch(/Discount/i);
    expect(sheet).toContain('SAR -5');
    const csv = await page.evaluate(`(()=>{let out='';const _B=window.Blob;window.Blob=function(p){out=p.join('');return new _B(p,{type:'text/plain'});};
      const _a=document.createElement.bind(document);document.createElement=(t)=>{const el=_a(t);if(t==='a')el.click=()=>{};return el;};
      const _c=URL.createObjectURL;URL.createObjectURL=()=>'blob:x';
      S.sfSession='s0';exportSessionExcel();window.Blob=_B;document.createElement=_a;URL.createObjectURL=_c;return out;})()`) as string;
    expect(csv).toMatch(/Discount/i);
    expect(csv).toContain('-5');
  });
});

test.describe('when bikes start going out is on the ticket, not only in Wallet', () => {
  const D2 = '2099-02-08';
  // 9pm circuit session: collection is three quarters of an hour before, at 8:15pm.
  const circuit = [{
    id: 'c0', day: 'Sunday', session_date: D2, capacity: 9, status: 'open', created_at: 1,
    bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 9 }), location: 'JCC', addons: null,
  }];

  test('the ticket names the collection time beside the ride window', async ({ page }) => {
    await stubSupabase(page, { sessions: circuit, bikes, inventory,
      customers: [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.test' }] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`sessionCollectTime(allSessions().find(s=>s.id==='c0'))`)).toBe('20:15');
    await page.evaluate(`S.lastTickets=[{id:'t1',queueNum:7,name:'Spec Rider',sessionId:'c0',sessionDay:'Sunday',sessionDate:'${D2}',status:'waiting'}];S.regStep=4;setCustTab('register')`);
    const card = page.locator('.ticket-card').first();
    await expect(card).toContainText('8:15 PM');                 // when bikes start going out
    await expect(card).toContainText('9 PM - 11 PM');            // and the ride window itself
  });

  test('a session with no bike to collect shows no collection time', async ({ page }) => {
    const pool = [{ ...circuit[0], id: 'p0', event_kind: 'community', ride_kind: 'swim',
      needs_approval: true, bike_slots: JSON.stringify({ _time: '19:00 - 21:00' }) }];
    await stubSupabase(page, { sessions: pool, bikes, inventory,
      customers: [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.test' }] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`_needsBike(allSessions().find(s=>s.id==='p0'))`)).toBe(false);
    await page.evaluate(`S.lastTickets=[{id:'t1',queueNum:1,name:'Spec Rider',sessionId:'p0',sessionDay:'Sunday',sessionDate:'${D2}',status:'waiting'}];S.regStep=4;setCustTab('register')`);
    await expect(page.locator('.ticket-card').first()).not.toContainText(/collection/i);
  });
});
