import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// A booking stuck in the offline outbox used to be invisible to everyone: this device showed
// it as booked, the roster had never heard of it, and the flush retried silently forever. The
// one device that knows is the rider's own, so the rider's own screen now says so — a banner
// with three states: still sending (amber, after a grace period), refused by the server (red,
// "show this phone at the booth"), and gone once it lands.

const sessions = [{ id: '2099-07-07', session_date: '2099-07-07', day: 'Sunday', status: 'open', capacity: 10, created_at: 1 }];
const row = (over: Record<string, unknown> = {}) => ({
  id: 'ob1', session_id: '2099-07-07', session_day: 'Sunday', session_date: '2099-07-07',
  queue_num: 5, name: 'Offline Rider', phone: '0550000001', type_preference: 'Road', size: 'M',
  status: 'waiting', paid: false, price: 75, customer_id: 'c-other',
  registered_at: new Date(Date.now() - 60000).toISOString(), ...over,
});

async function boot(page: import('@playwright/test').Page, outbox: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
  // Seeded AFTER boot: the boot flush would otherwise drain it against the stub, which
  // accepts every write — the tests below are about rows that have NOT landed.
  await page.evaluate((o) => {
    localStorage.setItem('cq_book_outbox', o);
  }, JSON.stringify(outbox));
}

test('a booking pending past the grace period is announced', async ({ page }) => {
  await boot(page, [row()]);
  await page.evaluate(`_updateConnUI()`);
  await expect(page.locator('#conn-banner')).toContainText('hasn’t reached the booth');
});

test('a fresh booking gets its grace period — no flash of warning per normal insert', async ({ page }) => {
  await boot(page, [row({ registered_at: new Date().toISOString() })]);
  await page.evaluate(`_updateConnUI()`);
  await expect(page.locator('#conn-banner')).toHaveCount(0);
});

test('three genuine refusals turn it red and name the fix', async ({ page }) => {
  await boot(page, [row({ _tries: 3 })]);
  await page.evaluate(`_updateConnUI()`);
  const b = page.locator('#conn-banner');
  await expect(b).toContainText('show this phone at the booth');
  const bg = await b.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(163, 59, 46)');                     // red, not the amber of "sending"
});

test('an empty outbox shows nothing', async ({ page }) => {
  await boot(page, []);
  await page.evaluate(`_updateConnUI()`);
  await expect(page.locator('#conn-banner')).toHaveCount(0);
});

test('a refusal is counted on the row; a network failure is not', async ({ page }) => {
  await boot(page, [row()]);
  const tries = await page.evaluate(`(async()=>{
    const real=sb.rpc.bind(sb);
    sb.rpc=async(name,args)=>name==='customer_create_booking'
      ?{data:null,error:{message:'booking refused'}}:real(name,args);
    const c={id:'c-other',session_token:'tok',name:'X'};localStorage.setItem('cq_session',JSON.stringify(c));S.loggedIn=c;
    await _bookOutboxFlush();
    sb.rpc=async(name,args)=>name==='customer_create_booking'
      ?{data:null,error:{message:'TypeError: Load failed'}}:real(name,args);
    await _bookOutboxFlush();
    sb.rpc=real;
    return (_bookOutbox()[0]||{})._tries||0;
  })()`);
  expect(tries).toBe(1);                                   // the refusal counted, the outage did not
});

test('the banner clears once the booking lands', async ({ page }) => {
  await boot(page, [row({ _tries: 3 })]);
  await page.evaluate(`_updateConnUI()`);
  await expect(page.locator('#conn-banner')).toBeVisible();
  await page.evaluate(`_bookOutboxSave([]);_updateConnUI()`);
  await expect(page.locator('#conn-banner')).toHaveCount(0);
});
