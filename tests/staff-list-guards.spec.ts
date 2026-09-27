import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Staff List (the Waitlist view of Bookings) is worked at speed through an arrival rush.
// These pin what the review found it could not take: a stored id that breaks out of an inline
// handler, a second tap on Check In or Add while the first is still writing, and a background
// refresh wiping the walk-up staff are typing in.

const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const bikes = [{ id: 'b1', name: 'R-01', type: 'Road', status: 'available', colors: [] }];
const walkup = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, phone: '0511111111', bike_type: 'Road', status: 'waiting', author: null,
  created_at: '2099-01-01T10:00:00Z', resolved_at: null, ...extra,
});

async function openList(page: import('@playwright/test').Page, fixtures: Record<string, unknown>) {
  await stubSupabase(page, { sessions, bikes, queue_entries: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
}

function countPosts(page: import('@playwright/test').Page, table: string) {
  const rows: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(`/rest/v1/${table}`)) {
      const b = r.postDataJSON();
      (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => rows.push(x));
    }
  });
  return rows;
}

test('a booking id that tries to break out of its handler stays an id', async ({ page }) => {
  // customer_create_booking stores the id the client sends. One carrying a quote and markup
  // must neither run on render nor reach the handler as anything but itself. The row is put
  // straight into state on the Staff List, so only this view's markup is on trial.
  const evil = `x"><img src=x onerror="window.__pwned=1">'`;
  await openList(page, { desk_waitlist: [] });
  // S is a script-level const, not a window property: hand the id in as a JSON literal.
  await page.evaluate(`(()=>{const id=${JSON.stringify(evil)};
    S.queue.push(entryFromDB({id,session_id:'s0',session_day:'Friday',session_date:'2099-02-10',queue_num:7,
      name:'Odd Id',phone:'0555555555',customer_id:null,type_preference:'Road',status:'waiting',
      paid:false,price:75,registered_at:'2099-01-01T09:00:00Z'}));
    S.deskWaitlist.push({id:'m1',name:'Odd Id',phone:'0511111111',bike_type:'Road',status:'waiting',
      kind:'managed',sort_order:1,booking_id:id,created_at:'2099-01-01T10:00:00Z'});
    renderStaffQueue();})()`);
  await expect(page.locator('#mw-host')).toContainText('Odd Id');
  expect(await page.evaluate('window.__pwned')).toBeUndefined();
  expect(await page.locator('#mw-host img[src="x"]').count()).toBe(0);
  await page.evaluate(`window.showCheckinModal=id=>{window.__ciArg=id;}`);
  await page.locator('#mw-host button.btn-green', { hasText: 'Check In' }).first().click();
  expect(await page.evaluate('window.__ciArg')).toBe(evil);
  expect(await page.evaluate('window.__pwned')).toBeUndefined();
});

/** The first JSON string argument of an inline handler, e.g. showCheckinModal("…",event). */
// The first real argument of a handler spec (data-on-*: JSON, the function's name first, then
// the event and element placeholders a helper takes, then the arguments).
function firstJsonArg(h: string): string | null {
  const args = (JSON.parse(h) as unknown[]).slice(1).filter((a) => !(a && typeof a === 'object' && '@' in (a as object)));
  return args.length ? String(args[0]) : null;
}

test('every row action encodes the id, whatever the booking status', async ({ page }) => {
  // _entryActions and _rowMenu build the roster's buttons for every view (the queue table and
  // cards call them too, with party keys like 'party:<id>'). Each status has its own buttons.
  const evil = `x"><img src=x onerror="window.__pwned=1">'`;
  await openList(page, { desk_waitlist: [] });
  const out = await page.evaluate(`(()=>{const id=${JSON.stringify(evil)};const host=document.createElement('div');document.body.appendChild(host);
    const base={id,sessionId:'s0',queueNum:7,name:'Odd Id',status:'waiting',paid:false,price:75,typePreference:'Road'};
    ['waiting','waitlist','active','done','noshow','cancelled','other'].forEach(st=>{host.insertAdjacentHTML('beforeend',_entryActions({...base,status:st}));});
    host.insertAdjacentHTML('beforeend',_rowMenu('party:'+id,[{label:'x',run:'',act:()=>{}}]));
    const hs=[];host.querySelectorAll('[data-on-click],[data-on-change]').forEach(b=>hs.push(b.getAttribute('data-on-change')||b.getAttribute('data-on-click')));
    return{imgs:host.querySelectorAll('img').length,hs};})()`) as { imgs: number; hs: string[] };
  expect(out.imgs).toBe(0);
  const got = out.hs.map(firstJsonArg).filter((x): x is string => x !== null);
  expect(got.length).toBeGreaterThan(6);
  for (const g of got) expect([evil, 'party:' + evil]).toContain(g);
  expect(await page.evaluate('window.__pwned')).toBeUndefined();
});

test('two taps on a walk-up\'s Check In book one bike, not two', async ({ page }) => {
  await openList(page, { desk_waitlist: [walkup('w1', 'Walk Up')] });
  const inserts = countPosts(page, 'queue_entries');
  await page.evaluate(`window.showCheckinModal=()=>{};Promise.all([giveDeskBike('w1'),giveDeskBike('w1')])`);
  await expect.poll(() => inserts.length).toBe(1);
  await page.waitForTimeout(300); // give a second run the time it would need to land
  expect(inserts.length).toBe(1);
});

test('a double-click on Add puts the party on the list once', async ({ page }) => {
  await openList(page, { desk_waitlist: [] });
  const rows = countPosts(page, 'desk_waitlist');
  await page.evaluate(`showWlAddModal()`);
  await page.locator('#wl-name').fill('Family Head');
  await page.locator('#wl-phone').fill('0551234567');
  await page.evaluate(`Promise.all([addDeskWaitlist(),addDeskWaitlist()])`);
  await expect.poll(() => rows.length).toBe(1);
  await page.waitForTimeout(300);
  expect(rows.length).toBe(1);
});

test('a background refresh keeps the walk-up staff are typing in', async ({ page }) => {
  await openList(page, { desk_waitlist: [walkup('w1', 'Walk Up')] });
  await page.locator('#mw-name').fill('New Guest');
  await page.locator('#mw-phone').fill('0551112222');
  await expect(page.locator('#mw-phone')).toBeFocused();
  await page.evaluate(`renderStaffQueue()`); // what every realtime event does
  await expect(page.locator('#mw-phone')).toHaveValue('0551112222');
  await expect(page.locator('#mw-phone')).toBeFocused();
  await expect(page.locator('#mw-name')).toHaveValue('New Guest');
  await expect(page.locator('#mw-host')).toContainText('Walk Up'); // the list itself still repaints
  // and a full rebuild (another view and back) still has the number: it is kept in state
  await page.evaluate(`document.activeElement.blur();renderStaffQueue()`);
  await expect(page.locator('#mw-phone')).toHaveValue('0551112222');
});

test('adding a walk-up empties the boxes for the next name', async ({ page }) => {
  await openList(page, { desk_waitlist: [] });
  const rows = countPosts(page, 'desk_waitlist');
  await page.locator('#mw-name').fill('Walk Up Guest');
  await page.locator('#mw-phone').fill('0553334444');
  await page.locator('#mw-phone').press('Enter');
  await expect.poll(() => rows.length).toBe(1);
  expect(rows[0].phone).toBe('0553334444');
  await expect(page.locator('#mw-name')).toHaveValue('');
  await expect(page.locator('#mw-phone')).toHaveValue('');
});
