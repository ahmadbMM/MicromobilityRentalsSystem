import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, waitForSb, loadStaffHalf, unlockStaff, type Fixtures } from './helpers/supabase';

// Fixes of 2026-10-05 (bug audit, slice rc1) outside the till: a party's Paid without a whole reload,
// the vendors' Tell / booked count / calendar names, Arabic-only labels in the website editor and the
// catalogue, the leaderboard's free rides, the emailed receipt's money, History's totals, and the
// inventory's delete guard, cost and control names.

const S1 = '2099-12-01';
const FREE = '2099-12-05-sat';
const sessions = [
  { id: S1, session_date: S1, day: 'Tuesday', status: 'open', capacity: 10, created_at: 1 },
  { id: FREE, session_date: '2099-12-05', day: 'Saturday', status: 'open', capacity: 30, created_at: 2, event_kind: 'community', ride_kind: 'saturday', paid_ride: false },
];

async function boot(page: Page, fixtures: Fixtures = {}) {
  await unlockStaff(page);
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], ...fixtures });
  await page.goto('/');
  await waitForSb(page);
  await loadStaffHalf(page);
}

test.describe('@staff:bookings party paid', () => {
  test("a party's Paid repaints from its writes and re-reads only the party's rows", async ({ page }) => {
    await boot(page);
    await page.evaluate(`(()=>{
      S.queue=[{id:'b1',name:'A',sessionId:'${S1}',status:'waiting',queueNum:1,typePreference:'Road',price:60,paid:false,groupId:'g1'},
               {id:'b2',name:'B',sessionId:'${S1}',status:'waiting',queueNum:2,typePreference:'Road',price:60,paid:false,groupId:'g1'}];
      S.deskWaitlist=[{id:'d1',name:'A',status:'waiting',booking_id:'b1',sort_order:1},{id:'d2',name:'B',status:'waiting',booking_id:'b2',sort_order:2}];
    })()`);
    const reads: string[] = [], rows: string[] = [], writes: string[] = [];
    page.on('request', (r) => {
      const u = decodeURIComponent(r.url());
      if (r.method() === 'GET' && /rest\/v1\/(sessions|customers|cashier_sales|inventory)/.test(u)) reads.push(u);
      if (r.method() === 'GET' && /rest\/v1\/queue_entries/.test(u)) rows.push(u);
      if (r.method() === 'PATCH' && /rest\/v1\/queue_entries/.test(u)) writes.push(u);
    });
    // The stub keeps no rows, so the re-read cannot be checked for its result: the paint before it is.
    const painted = await page.evaluate(`(async()=>{let seen=null;const re=window._reloadRows;window._reloadRows=async(ids)=>{seen=['b1','b2'].map(id=>{const e=getQueue().find(x=>x.id===id);return !!e&&e.paid&&e.pay_method;});return re(ids);};try{await mwPartyPaid('d1');}finally{window._reloadRows=re;}return seen;})()`);
    expect(painted).toEqual(['card', 'card']);
    expect(writes).toHaveLength(2);
    expect(rows.some((u) => /id=in\.\(.*b1.*b2|id=in\.\(.*b2.*b1/.test(u))).toBe(true); // only the party's rows are read again
    expect(reads).toEqual([]); // no whole reload (loadData read sessions, customers, sales and stock)
  });
});

test.describe('@staff:vendors vendors', () => {
  const venue = { id: 7, name: 'Bean Box', name_ar: '', contact_name: 'Huda Test', contact_phone: '', status: 'active', tier_id: 'single' };

  test('Tell the venue on a booking cancelled by closing its date says the date closed, with the reason in words', async ({ page }) => {
    await boot(page);
    const out = await page.evaluate(`(()=>{
      const W=_vendor();W.venues=[${JSON.stringify(venue)}];W.dates=[{day:'2099-12-12',state:'closed',reason:'ramadan',capacity:1}];
      W.bk=[{id:31,venue_id:7,day:'2099-12-12',status:'cancelled',cancelled_by:'mm',cancel_reason:'ramadan'},
            {id:32,venue_id:7,day:'2099-12-19',status:'cancelled',cancelled_by:'mm',cancel_reason:'Double booked'}];
      _vendorTellBk(31);const a=S._vendorTell.items[0];const ma=_vendorTellMsg(a,'en');
      _vendorTellBk(32);const b=S._vendorTell.items[0];const mb=_vendorTellMsg(b,'en');
      _vendorDlgClose();
      return {a:a.kind,ma,b:b.kind,mb};
    })()`) as { a: string; ma: string; b: string; mb: string };
    expect(out.a).toBe('close');
    expect(out.ma).toContain('is now closed for breakfast because of Ramadan');
    expect(out.ma).not.toContain('Note: ramadan');
    expect(out.b).toBe('cancel'); // a cancel staff typed a note for stays a cancel
    expect(out.mb).toContain('Note: Double booked');
  });

  test('a rider out on the Saturday ride counts as booked; a no-show and a rejected one do not', async ({ page }) => {
    await boot(page);
    const n = await page.evaluate(`(()=>{
      S.queue=[{id:'q1',sessionId:'${FREE}',status:'waiting'},{id:'q2',sessionId:'${FREE}',status:'active'},{id:'q3',sessionId:'${FREE}',status:'done'},
               {id:'q4',sessionId:'${FREE}',status:'noshow'},{id:'q5',sessionId:'${FREE}',status:'waiting',approval:'rejected'}];
      return _vendorBooked('2099-12-05');
    })()`);
    expect(n).toBe(3);
  });

  test("a calendar day's button names its status, not the date alone", async ({ page }) => {
    await boot(page);
    const labels = await page.evaluate(`(()=>{
      const W=_vendor();W.venues=[${JSON.stringify(venue)}];W.month='2099-12';
      W.dates=[{day:'2099-12-05',state:'open',capacity:1},{day:'2099-12-12',state:'closed',reason:'ramadan',capacity:1},{day:'2099-12-19',state:'open',capacity:1}];
      W.bk=[{id:1,venue_id:7,day:'2099-12-19',status:'confirmed'},{id:2,venue_id:7,day:'2099-12-05',status:'pending'}];
      const d=document.createElement('div');d.innerHTML=_vendorCalHtml();
      return ['05','12','19'].map(x=>d.querySelector('[data-vendor-day="2099-12-'+x+'"]').getAttribute('aria-label'));
    })()`) as string[];
    expect(labels[0]).toMatch(/Open, 1 /);
    expect(labels[1]).toMatch(/Closed, Ramadan$/);
    expect(labels[2]).toMatch(/Confirmed, Bean Box$/);
  });
});

test.describe('@staff:website Arabic labels on the Arabic page only', () => {
  test('in Urdu the website editor and the catalogue read English; in Arabic, Arabic', async ({ page }) => {
    await boot(page);
    const out = await page.evaluate(`(()=>{
      const r={};
      S.lang='ur';r.ur=[_webLbl({en:'Home',ar:'الرئيسية'}),_catBi('Road','طريق')];
      S.lang='ar';r.ar=[_webLbl({en:'Home',ar:'الرئيسية'}),_catBi('Road','طريق')];
      S.lang='en';return r;
    })()`);
    expect(out).toEqual({ ur: ['Home', 'Road'], ar: ['الرئيسية', 'طريق'] });
  });
});

test.describe('@staff:community leaderboard', () => {
  test('a completed free Saturday ride counts; an unpaid paid ride does not; spent is money only', async ({ page }) => {
    await boot(page);
    const m = await page.evaluate(`(()=>{
      S.queue=[{id:'a',name:'Rider One',customerId:'c1',sessionId:'${FREE}',sessionDate:'2099-12-05',status:'done',paid:false,price:0,typePreference:'Road',rideDuration:60},
               {id:'b',name:'Rider One',customerId:'c1',sessionId:'${S1}',sessionDate:'${S1}',status:'done',paid:false,price:60,typePreference:'Road'},
               {id:'c',name:'Rider One',customerId:'c1',sessionId:'${S1}',sessionDate:'${S1}',status:'done',paid:true,price:60,typePreference:'Road'},
               {id:'d',name:'Owner Rider',customerId:'c2',sessionId:'${S1}',sessionDate:'${S1}',status:'done',paid:false,price:0,typePreference:'Own'}];
      const a=_lbAgg('all','rider');return {one:[a['rider one'].count,a['rider one'].spent],own:(a['owner rider']||{}).count};
    })()`);
    expect(m).toEqual({ one: [2, 60], own: 1 }); // was 1 (the paid one only), and the owner not at all
  });
});

test.describe('@staff:history receipt and totals', () => {
  test('the emailed receipt lists add-ons and purchases with the total, and says Free on a free ride', async ({ page }) => {
    await boot(page, { inventory: [{ id: 'gel', name: 'Gel', category: 'EnergyGels', qty: 5, price: 10, low_threshold: 0 }] });
    await page.waitForFunction('(S.inventory||[]).length>0');
    const out = await page.evaluate(`(()=>{
      const paid={id:'r1',name:'Rider',sessionId:'${S1}',status:'done',paid:false,price:60,typePreference:'Road',addons:[{id:'gel',qty:2,p:10}],
        purchases:[{id:'gel',name:'Gel',cat:'EnergyGels',qty:1,price:10,pay:'house'},{id:null,name:'Cap',cat:'Apparel',qty:1,price:30,pay:'paid'}]};
      const free={id:'r2',name:'Rider',sessionId:'${FREE}',status:'done',paid:false,price:0,typePreference:'Road'};
      return {paid:_receiptMoney(paid).join('\\n'),free:_receiptMoney(free).join('\\n')};
    })()`) as { paid: string; free: string };
    expect(out.paid).toMatch(/Gel ×2\s+:\s+SAR 20/);
    expect(out.paid).toMatch(/SAR 80/); // 60 + 2 × 10
    expect(out.paid).toMatch(/Cap\s+:\s+SAR 30.* · Paid/);
    expect(out.paid).toMatch(/Gel\s+:\s+On the house/);
    expect(out.free).not.toMatch(/Pending|SAR/);
    expect(out.free).toMatch(/Free/);
  });

  test("History's Collected counts a paid no-show; Pending leaves out a free ride and an own bike with nothing to pay", async ({ page }) => {
    await boot(page);
    await page.evaluate(`(()=>{
      S.queue=[{id:'h1',name:'Paid Done',sessionId:'${S1}',sessionDate:'${S1}',status:'done',paid:true,price:60,typePreference:'Road',registeredAt:'2099-11-01T00:00:00Z'},
               {id:'h2',name:'Paid Noshow',sessionId:'${S1}',sessionDate:'${S1}',status:'noshow',paid:true,price:60,typePreference:'Road',registeredAt:'2099-11-01T00:00:00Z'},
               {id:'h3',name:'Owes',sessionId:'${S1}',sessionDate:'${S1}',status:'done',paid:false,price:60,typePreference:'Road',registeredAt:'2099-11-01T00:00:00Z'},
               {id:'h4',name:'Free Ride',sessionId:'${FREE}',sessionDate:'2099-12-05',status:'done',paid:false,price:null,typePreference:'Road',registeredAt:'2099-11-01T00:00:00Z'},
               {id:'h5',name:'Own Bike',sessionId:'${S1}',sessionDate:'${S1}',status:'done',paid:false,price:0,typePreference:'Own',registeredAt:'2099-11-01T00:00:00Z'}];
      S.histSess='all';S.histRange='all';S.histStatus='all';S.histPay='pending';S.histType='all';S.histSize='all';S.histSearch='';
      setStaffTab('history');
    })()`);
    const tab = page.locator('#tab-history');
    await expect(tab.locator('.stat-card', { hasText: 'Collected' }).locator('.stat-num')).toHaveText('SAR 120');
    await expect(tab.locator('.stat-card', { hasText: 'Pending' }).first().locator('.stat-num')).toHaveText('1');
    expect(await page.evaluate(`_histRows().filtered.map(e=>e.id)`)).toEqual(['h3']);
  });
});

test.describe('@staff:inventory inventory', () => {
  const inventory = [{ id: 'gel', name: 'Gel', category: 'EnergyGels', qty: 5, price: 10, low_threshold: 0 }];

  test('an item a ridden booking still reads its price from cannot be deleted', async ({ page }) => {
    await boot(page, { inventory });
    await page.waitForFunction('(S.inventory||[]).length>0');
    await page.evaluate(`S.staffRole='admin';S.queue=[{id:'x1',name:'Owes',sessionId:'${S1}',status:'done',paid:false,price:60,addons:[{id:'gel',qty:1,p:10}]}]`);
    await page.evaluate(`delInvItem('gel')`);
    await expect(page.locator('#toast-container')).toContainText('still read this item');
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    // a paid booking whose line kept its price does not hold it
    await page.evaluate(`S.queue=[{id:'x2',name:'Paid',sessionId:'${S1}',status:'done',paid:true,price:60,addons:[{id:'gel',qty:1,p:10}]}]`);
    await page.evaluate(`delInvItem('gel')`);
    await expect(page.locator('#confirm-modal .confirm-box')).toContainText('Gel');
  });

  test('saving an item sends the cost only when its box changed', async ({ page }) => {
    await boot(page, { inventory });
    await page.waitForFunction('(S.inventory||[]).length>0');
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /rest\/v1\/inventory/.test(r.url())) sent.push(r.postDataJSON()); });
    await page.evaluate(`(async()=>{setStaffTab('inventory');startInvEdit('gel');S._invPrice='12';await saveInvEdit();})()`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent.some((b) => 'cost' in b)).toBe(false); // this device holds no cost: a blank must not overwrite it
    sent.length = 0;
    await page.evaluate(`(async()=>{startInvEdit('gel');S._invCost='4';await saveInvEdit();})()`);
    await expect.poll(() => sent.some((b) => b.cost === 4)).toBe(true);
  });

  test('the stock buttons and the item form fields are named in the page language', async ({ page }) => {
    await boot(page, { inventory });
    await page.waitForFunction('(S.inventory||[]).length>0');
    await page.evaluate(`S.invSection='supplements';S.invView='table';setStaffTab('inventory');startInvEdit('gel')`);
    const tab = page.locator('#tab-inventory');
    await expect(tab.locator('button[aria-label="Decrease quantity: Gel"]')).toHaveCount(1);
    await expect(tab.locator('button[aria-label="Increase quantity: Gel"]')).toHaveCount(1);
    await expect(tab.locator('#inv-cat')).toHaveAttribute('aria-label', /.+/);
    await expect(tab.locator('#inv-brand')).toHaveAttribute('aria-label', /.+/);
  });
});
