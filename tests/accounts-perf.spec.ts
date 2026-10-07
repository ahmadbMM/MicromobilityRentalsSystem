import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, captureBookingRows } from './helpers/supabase';

// The accounts list used to render every account into one innerHTML — at production scale
// 2,609 rows, 3.8 MB of markup and 47,252 DOM nodes — and a tag change repainted all of it.
// Measured at 4x CPU throttling, one tap on a row's Tags button cost 895 ms.

const tags = [
  { id: 'tag_sat', slug: 'saturday', name: 'Community', color: '#00e585', locked: true },
  { id: 'tag_vip', slug: 'vip', name: 'VIP', color: '#ff0000' },
];
const sessions = [{ id: 's0', day: 'Sunday', session_date: '2099-02-08', capacity: 40, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }), location: 'JCC', addons: null }];

// 200 accounts is well past the 60-row page and cheap to set up.
const SEED = `(()=>{const NC=200;
  S.customers=Array.from({length:NC},(_,i)=>({id:'c'+i,name:'Rider '+String(i).padStart(3,'0')+' Name',
    email:'r'+i+'@example.test',phone:'+96650'+String(1000000+i),gender:'male',birth_date:'1995-01-01',
    nationality:'Saudi Arabia',created_at:new Date(Date.UTC(2026,4,1,0,i)).toISOString()}));
  S.customerTags=S.customers.map((c,i)=>({customer_id:c.id,tag_id:i%2?'tag_vip':'tag_sat',
    added_at:Date.now()-86400000,expires_at:null,starts_at:null}));
  renderCommunity();return S.customers.length;})()`;

async function accounts(page: import('@playwright/test').Page) {
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [], customers: [], tags, customer_tags: [], inventory: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';S.amShow=null;S.amSearch='';S.amTagFilter='';S.amMissing=false`);
  expect(await page.evaluate(SEED)).toBe(200);
}

test('the list shows a page at a time instead of every account at once', async ({ page }) => {
  await accounts(page);
  const rows = page.locator('#am-cust-rows .am-cust');
  await expect(rows).toHaveCount(60);
  await expect(page.locator('#am-cust-rows')).toContainText('Showing 60 of 200');

  await page.getByRole('button', { name: /show 60 more/i }).click();
  await expect(rows).toHaveCount(120);

  // The newest account leads, as it always did.
  await expect(rows.first()).toContainText('Rider 199 Name');
});

test('a new search or filter starts again at the top', async ({ page }) => {
  await accounts(page);
  await page.getByRole('button', { name: /show 60 more/i }).click();
  expect(await page.evaluate(`S.amShow`)).toBe(120);

  await page.evaluate(`_amSearchInput('Rider 01')`);
  expect(await page.evaluate(`S.amShow`)).toBe(60);

  await page.evaluate(`_amSearchInput('')`);
  await page.evaluate(`_amFilter('amTagFilter','tag_vip')`);
  expect(await page.evaluate(`S.amShow`)).toBe(60);
  // Every row on a VIP-filtered list really does hold that tag.
  const allVip = await page.evaluate(`[...document.querySelectorAll('#am-cust-rows .am-row')].every(el=>_ctRowsFor(el.dataset.cust).some(ct=>ct.tag_id==='tag_vip'))`);
  expect(allVip).toBe(true);
});

test('opening the tag picker repaints that row and leaves the rest alone', async ({ page }) => {
  await accounts(page);
  // Mark a neighbour: if the list were rebuilt wholesale the mark would be gone.
  await page.evaluate(`document.querySelector('#am-cust-rows .am-row[data-cust="c198"] .am-cust').dataset.witness='1'`);
  await page.evaluate(`_amPickTags('c199')`);
  await expect(page.locator('#am-cust-rows .am-row[data-cust="c199"] .am-picker')).toBeVisible();
  expect(await page.evaluate(`document.querySelector('#am-cust-rows .am-row[data-cust="c198"] .am-cust').dataset.witness`)).toBe('1');

  // Closing it puts the neighbour's witness through the same test.
  await page.evaluate(`_amPickTags('c199')`);
  await expect(page.locator('#am-cust-rows .am-row[data-cust="c199"] .am-picker')).toHaveCount(0);
  expect(await page.evaluate(`document.querySelector('#am-cust-rows .am-row[data-cust="c198"] .am-cust').dataset.witness`)).toBe('1');
});

test('a row that is not on screen still repaints, by falling back to the whole list', async ({ page }) => {
  await accounts(page);
  // c0 is the oldest account, so it is well past the first page.
  expect(await page.evaluate(`!!document.querySelector('#am-cust-rows .am-row[data-cust="c0"]')`)).toBe(false);
  expect(await page.evaluate(`_amRepaintRow('c0')`)).toBe(false);   // nothing to repaint...
  await page.evaluate(`_amPickTags('c0')`);                          // ...so the picker falls back
  expect(await page.evaluate(`S.tagCustId`)).toBe('c0');
});

test('confirming a booking re-syncs the light window, not the whole year', async ({ page }) => {
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [], inventory: [],
    customers: [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.test' }] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await captureBookingRows(page);
  const calls = await page.evaluate(`(()=>{
    window.__calls=[];
    const full=window.loadData, light=window.loadDataLight;
    window.loadData=(...a)=>{window.__calls.push('full');return full(...a);};
    window.loadDataLight=(...a)=>{window.__calls.push('light');return light(...a);};
    S.selSession='s0';S.regQty=1;S.regBikeHeights=[175];S.regBikeTypes=['Road'];
    S.regRiderNames=['Spec Rider'];S.promoApplied=null;S.waiverOk=true;
    return submitReg().then(()=>window.__calls);
  })()`) as string[];
  expect(calls).toContain('light');
  expect(calls).not.toContain('full');
});
