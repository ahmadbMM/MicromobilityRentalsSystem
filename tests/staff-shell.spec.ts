import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Claude Design #16 to #20: one search over the whole desk, a bell for what needs attention,
// Sync now, a bottom bar on phones and tablets, and a day sheet for today.

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [
  { id: TODAY, session_date: TODAY, day: 'Friday', status: 'open', capacity: 40, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' },
  { id: '2099-02-01', session_date: '2099-02-01', day: 'Sunday', status: 'closed', capacity: 40, created_at: 2, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' },
];
const row = (id: string, n: number, name: string, x: Record<string, unknown> = {}) => ({
  id, session_id: TODAY, session_day: 'Friday', session_date: TODAY, queue_num: n, name, phone: '0550000001', customer_id: null,
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: `${TODAY}T10:0${n}:00Z`, ...x,
});
const threeHoursAgo = () => new Date(Date.now() - 3 * 3600_000).toISOString();
const fixtures = {
  sessions,
  queue_entries: [
    row('e1', 1, 'Amal Saad', { phone: '0551234567' }),
    row('e2', 2, 'Badr Omar', { status: 'active', paid: true, checked_in_at: threeHoursAgo() }),
    row('e3', 3, 'Dana Faisal', { status: 'waitlist' }),
  ],
  customers: [{ id: 'c1', name: 'Amal Saad', phone: '0551234567', email: 'amal@example.com', created_at: '2026-01-01T00:00:00Z' }],
  bikes: [{ id: 'b1', name: 'Road 9001', bike_number: 9001, type: 'Road', size: 'M', status: 'available', colors: [], brand: 'Triban', model: 'RC120' }],
  inventory: [{ id: 'i1', name: 'Medium helmet', category: 'Helmet', qty: 1, low_threshold: 3, price: 15 }],
};
async function staff(page: Page, x: Record<string, unknown> = {}) {
  await stubSupabase(page, { ...fixtures, ...x });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test('the staff bar holds a search button, not a search bar, and no Admin / Front Desk switch', async ({ page }) => {
  await staff(page);
  const btn = page.locator('#topbar .gs-btn');
  await expect(btn).toHaveAttribute('aria-label', 'Search');
  await expect(btn).toHaveText('');
  const box = await btn.boundingBox();
  expect(box!.width).toBeLessThan(48);
  await expect(page.locator('#topbar .role-seg')).toHaveCount(0);
  await expect(page.locator('#topbar')).not.toContainText('Front Desk');
  await btn.click();
  await expect(page.locator('#gs-panel .gs-box')).toBeVisible();
});

test('the staff bar searches bookings, accounts, bikes and items, phones in any format', async ({ page }) => {
  await staff(page);
  await page.keyboard.press('Control+k');
  const box = page.locator('#gs-panel .gs-box');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Type two or more letters or digits.');
  await page.locator('#gs-input').fill('+966 55 123 4567');
  await expect(box.locator('.gs-item')).toHaveCount(2);
  await expect(box.locator('.gs-item').nth(0)).toContainText('Booking');
  await expect(box.locator('.gs-item').nth(0)).toContainText('#1 Amal Saad');
  await expect(box.locator('.gs-item').nth(1)).toContainText('Account');
  await page.locator('#gs-input').fill('9001');
  await expect(box.locator('.gs-item')).toHaveText([/Bike\s*Road 9001/]);
  await page.locator('#gs-input').fill('helmet');
  await expect(box.locator('.gs-item')).toHaveText([/Item\s*Medium helmet/]);
  await page.locator('#gs-input').fill('zzzz');
  await expect(box).toContainText('Nothing found.');
  // Enter opens the booking where it lives: the roster, on its night, found by name
  await page.locator('#gs-input').fill('dana');
  await page.locator('#gs-input').press('Enter');
  await expect(page.locator('#gs-panel .gs-box')).toHaveCount(0);
  expect(await page.evaluate(`({tab:S.staffTab,sess:S.sfSession,q:S.sfSearch})`)).toEqual({ tab: 'queue', sess: TODAY, q: 'Dana Faisal' });
  // a bike opens its profile
  await page.locator('#topbar .gs-btn').click();
  await page.locator('#gs-input').fill('9001');
  await expect(page.locator('#gs-panel .gs-item').first()).toContainText('Road 9001'); // the list repaints a beat after typing
  await page.locator('#gs-panel .gs-item').first().click();
  await expect(page.locator('#bike-profile-modal')).toContainText('Road 9001');
});

// The bar's × empties it, as every search's does, and closes the search once it is empty (the
// owner, 2026-09-30: "when the x button is clicked in the search bar it doesn't always empty the
// bar"). It used to close with the text kept, beside the browser's own × that did empty it.
test('the × in the search bar empties it, then closes the search', async ({ page }) => {
  await staff(page);
  await page.locator('#topbar .gs-btn').click();
  const input = page.locator('#gs-input'), x = page.locator('#gs-panel .gs-x');
  await expect(x).toHaveAttribute('aria-label', 'Close');
  await input.fill('dana');
  await expect(page.locator('#gs-panel .gs-item').first()).toContainText('Dana Faisal');
  await expect(x).toHaveAttribute('aria-label', 'Clear');
  await x.click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(page.locator('#gs-panel .gs-box')).toContainText('Type two or more letters or digits.');
  expect(await page.evaluate(`S._gsQ`)).toBe('');
  await expect(x).toHaveAttribute('aria-label', 'Close');
  await x.click();
  await expect(page.locator('#gs-panel .gs-box')).toHaveCount(0);
  await page.locator('#topbar .gs-btn').click();
  await expect(page.locator('#gs-input')).toHaveValue('');
});

test('Front Desk searches only what its own sections hold', async ({ page }) => {
  await staff(page);
  await page.evaluate(`S.staffRole='frontdesk';renderTopbarRight();_gsOpen()`);
  await page.locator('#gs-input').fill('amal');
  await expect(page.locator('#gs-panel .gs-item')).toHaveText([/Booking\s*#1 Amal Saad/]);
});

// The bell tells what is NEW, one line per thing (the owner, 2026-10-02: "dont show applications: 32
// show a new application was submitted each time a new application has been submitted"). What a
// list already held the first time it loaded on this device is known, not news.
test('the bell says nothing about what was already there, then one line for each new thing', async ({ page }) => {
  await staff(page);
  await page.waitForFunction('_ntLoaded().inv&&_ntLoaded().queue');
  const bell = page.locator('#nt-btn');
  await page.evaluate('_ntSync()');
  await expect(bell.locator('.nt-badge')).toHaveCount(0); // a ride past two hours and a helmet low on stock: already there
  await bell.click();
  await expect(page.locator('#nt-panel .nt-empty')).toHaveText('No new notifications.');
  await page.evaluate('_ntClose()');
  // gloves run out: that is new
  await page.evaluate(`S.inventory=[...S.inventory,{id:'i2',name:'Gloves',category:'Gloves',qty:0,low_threshold:2,price:10}];_ntSync()`);
  await expect(bell.locator('.nt-badge')).toHaveText('1');
  await bell.click();
  const panel = page.locator('#nt-panel .nt-box');
  await expect(panel.locator('.nt-row')).toHaveText([/Gloves is out of stock/]);
  await panel.locator('.nt-row').click(); // opening it reads it
  await expect(page.locator('#nt-panel .nt-box')).toHaveCount(0);
  expect(await page.evaluate('S.staffTab')).toBe('inventory');
  await expect(bell.locator('.nt-badge')).toHaveCount(0);
  // Front Desk is not told about stock it cannot open
  await page.evaluate(`S.staffRole='frontdesk';renderTopbarRight();S.inventory=[...S.inventory,{id:'i3',name:'Lights',category:'Lights',qty:0,low_threshold:2,price:10}];_ntSync()`);
  await expect(page.locator('#nt-btn .nt-badge')).toHaveCount(0);
});

test('what was marked read stays read across a reload, while the page shows its snapshot and the inventory is on its way', async ({ page }) => {
  await staff(page);
  await page.waitForFunction('_ntLoaded().inv&&_ntLoaded().queue');
  const bell = page.locator('#nt-btn');
  await page.evaluate(`_ntSync();S.inventory=[...S.inventory,{id:'i2',name:'Gloves',category:'Gloves',qty:0,low_threshold:2,price:10}];_ntSync()`);
  await expect(bell.locator('.nt-badge')).toHaveText('1');
  await bell.click();
  await page.locator('#nt-panel').getByRole('button', { name: 'Mark all read' }).click();
  await expect(bell.locator('.nt-badge')).toHaveCount(0);
  // the snapshot this device keeps holds no inventory; the inventory read takes a while
  await page.evaluate(`localStorage.setItem('cq_snapshot',JSON.stringify({q:S.queue,ses:S.sessions,bk:S.bikes,inv:[],cs:[]}))`);
  await page.route(/\/rest\/v1\/inventory/, async route => { await new Promise(r => setTimeout(r, 1500)); await route.fallback(); });
  await page.reload();
  await waitForSb(page);
  await page.waitForFunction('S.inventory.length===1');
  await page.evaluate('_ntSync()');
  await expect(page.locator('#nt-btn .nt-badge')).toHaveCount(0);
});

test('Mark all read clears the bell however many new things are listed', async ({ page }) => {
  await staff(page);
  await page.waitForFunction('_ntLoaded().inv&&_ntLoaded().queue');
  await page.evaluate(`_ntSync();S.inventory=Array.from({length:350},(_,i)=>({id:'k'+i,name:'Item '+i,category:'Helmet',qty:0,low_threshold:1,price:1}));_ntSync()`);
  const bell = page.locator('#nt-btn');
  await expect(bell.locator('.nt-badge')).toHaveText('99+');
  await bell.click();
  await expect(page.locator('#nt-panel .nt-row')).toHaveCount(60); // the latest sixty are listed
  await page.locator('#nt-panel').getByRole('button', { name: 'Mark all read' }).click();
  await expect(bell.locator('.nt-badge')).toHaveCount(0);
});

test('a different item is new even at the same count, and a read one that clears and returns is new again', async ({ page }) => {
  await staff(page);
  await page.waitForFunction('_ntLoaded().inv&&_ntLoaded().queue');
  const bell = page.locator('#nt-btn');
  await page.evaluate('_ntSync()');
  await bell.click();
  const read = page.locator('#nt-panel').getByRole('button', { name: 'Mark all read' });
  // another item low on stock in place of the helmet: still one, but not the one known
  await page.evaluate(`S.inventory=[{id:'i2',name:'Gloves',category:'Gloves',qty:0,low_threshold:2,price:10}];_ntSync()`);
  await expect(bell.locator('.nt-badge')).toHaveText('1');
  await read.click();
  await expect(bell.locator('.nt-badge')).toHaveCount(0);
  // restocked: gone from the loaded list, so forgotten; low again later, so new again
  await page.evaluate(`S.inventory=[];_ntSync();S.inventory=[{id:'i2',name:'Gloves',category:'Gloves',qty:0,low_threshold:2,price:10}];_ntSync()`);
  await expect(bell.locator('.nt-badge')).toHaveText('1');
});

test('a kind turned off on Settings is neither shown nor counted', async ({ page }) => {
  await staff(page);
  await page.waitForFunction('_ntLoaded().inv&&_ntLoaded().queue');
  await page.evaluate(`_ntSync();S._ntOff=['stock'];S.inventory=[...S.inventory,{id:'i2',name:'Gloves',category:'Gloves',qty:0,low_threshold:2,price:10}];_ntSync()`);
  await expect(page.locator('#nt-btn .nt-badge')).toHaveCount(0);
  await page.evaluate(`S._ntOff=[];_ntSync()`);
  await expect(page.locator('#nt-btn .nt-badge')).toHaveText('1');
});

test('Sync now sends what is waiting and says when all is up to date', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('queue')`);
  await page.locator('#tab-queue .sync-now').click();
  await expect(page.locator('#toast-container')).toContainText('Up to date');
});

test('phones and tablets get a bottom bar with the most used sections and More', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await staff(page);
  const bar = page.locator('#staff-tabbar');
  await expect(bar).toBeVisible();
  await expect(bar.locator('.tb-btn')).toHaveText(['Bookings', 'Sales', 'Inventory', 'Workshop', 'More']);
  await bar.locator('.tb-btn', { hasText: 'Sales' }).click();
  expect(await page.evaluate('S.staffTab')).toBe('cashier');
  await expect(bar.locator('.tb-btn.active')).toHaveText('Sales');
  await bar.locator('.tb-more').click();
  await expect(page.locator('body')).toHaveClass(/snav-open/);
  await page.evaluate(`setStaffRole('frontdesk')`);
  await expect(bar.locator('.tb-btn')).toHaveText(['Bookings', 'Sales', 'Workshop']);
});

test('the desktop keeps the rail and has no bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await staff(page);
  await expect(page.locator('#staff-tabbar')).toBeHidden();
});

test('the day sheet prints today\'s riders still expected or out', async ({ page }) => {
  await staff(page);
  await page.evaluate(`window.__sheet='';window.open=()=>({document:{write:h=>{window.__sheet+=h;},close(){}},focus(){},print(){}})`);
  await page.evaluate(`setStaffTab('queue');setSfSession('all')`);
  await page.locator('#tab-queue .day-sheet-btn').click();
  const html = await page.evaluate('window.__sheet') as string;
  expect(html).toContain('Day sheet');
  for (const name of ['Amal Saad', 'Badr Omar', 'Dana Faisal']) expect(html).toContain(name);
  expect(html).toContain('#3'); // the booking number, and the waitlist place beside it
  expect(html).not.toContain('colName');
});

test('with no session today the day sheet says so', async ({ page }) => {
  await staff(page, { sessions: [sessions[1]], queue_entries: [] });
  await page.evaluate(`printDaySheet()`);
  await expect(page.locator('#toast-container')).toContainText('No session today.');
});

// The sign-in dialog's markup stays in the page, hidden, once drawn; the shortcut handler and
// pull-to-refresh asked "is there a backdrop" and were dead on the staff page as long as it was.
test('the desk shortcuts work with the hidden sign-in markup in the page', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'keyboard shortcuts are for the desk computer');
  await staff(page);
  expect(await page.evaluate(`!!document.querySelector('.auth-backdrop')`)).toBe(true);
  await page.evaluate(`setStaffTab('cashier')`);
  await page.locator('body').press('/');
  await expect(page.locator('#sf-search-input')).toBeFocused();
  expect(await page.evaluate('S.staffTab')).toBe('queue');
});
