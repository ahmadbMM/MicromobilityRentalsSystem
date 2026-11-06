import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The staff shell, 2026-11-06 review (ST01-ST08): search and the bell follow the account's sections, the Dashboard
// leads only where the account may go, S opens Sessions, Ctrl K jumps to a booking by its number and is a command bar,
// Bookings / Sessions / Volunteers link to each other, and /sessions?session= opens that session.

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [
  { id: TODAY, session_date: TODAY, day: 'Friday', status: 'open', capacity: 40, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' },
  { id: '2099-02-01', session_date: '2099-02-01', day: 'Sunday', status: 'open', capacity: 40, created_at: 2, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' },
];
const row = (id: string, n: number, name: string, x: Record<string, unknown> = {}) => ({
  id, session_id: TODAY, session_day: 'Friday', session_date: TODAY, queue_num: n, name, phone: '055000000' + n, customer_id: null,
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: `${TODAY}T10:0${n}:00Z`, ...x,
});
const fixtures = {
  sessions,
  queue_entries: [
    row('e1', 1, 'Amal Saad'),
    row('e2', 2, 'Badr Omar', { status: 'done', paid: true }),
    row('e3', 3, 'Dana Faisal'),
    row('e4', 4, 'Faris Later', { session_id: '2099-02-01', session_date: '2099-02-01', session_day: 'Sunday' }),
  ],
  customers: [{ id: 'c1', name: 'Amal Saad', phone: '0551234567', email: 'amal@example.com', created_at: '2026-01-01T00:00:00Z' }],
  bikes: [{ id: 'b1', name: 'Road 9001', bike_number: 9001, type: 'Road', size: 'M', status: 'available', colors: [], brand: 'Triban', model: 'RC120' }],
  inventory: [{ id: 'i1', name: 'Medium helmet', category: 'Helmet', qty: 1, low_threshold: 3, price: 15 }],
};
async function staff(page: Page, path = '/') {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded&&S.view==='staff'`);
}

test('ST01: a manager with People and Inventory finds accounts, bikes and items; the bell follows the sections too', async ({ page }) => {
  await staff(page);
  const r = await page.evaluate(`(()=>{
    setStaffRole('manager');
    const hit=q=>(_gsHits(q)||[]).map(h=>h.k);
    const out={acct:hit('amal'),bike:hit('9001'),item:hit('helmet'),kinds:NT_KINDS.filter(([,,sec])=>_deskTabOk(sec)).map(x=>x[0])};
    S._myView=['queue','inventory'];
    out.narrow=hit('amal');
    S._myView=null;setStaffRole('admin');
    return out;})()`) as Record<string, string[]>;
  expect(r.acct).toContain('gsKindAccount');
  expect(r.bike).toContain('gsKindBike');
  expect(r.item).toContain('gsKindItem');
  expect(r.kinds).toEqual(expect.arrayContaining(['apps', 'stock', 'msgs', 'vlate']));
  expect(r.narrow).not.toContain('gsKindAccount'); // no People: no account
});

test('ST02: the Owner preset reads the Dashboard without its actions; a manager gets no way into Sessions', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffRole('owner');S._myEdit=[];setStaffTab('dashboard')`);
  const dash = page.locator('#tab-dashboard');
  await expect(dash).toContainText('Today');
  await expect(dash.getByRole('button', { name: 'Check in next' })).toHaveCount(0);
  await expect(dash.getByRole('button', { name: /New sale/i })).toHaveCount(0);
  await page.evaluate(`S._myEdit=null;setStaffRole('manager');renderDashboard()`);
  await expect(dash.getByRole('button', { name: 'Check in next' })).toHaveCount(1);
  expect(await dash.locator('.dash-kpi').evaluateAll(els => els.map(e => e.getAttribute('data-on-click') || '').filter(x => x.includes('"sessions"')).length)).toBe(0);
  await expect(dash.getByRole('button', { name: /New Session/ })).toHaveCount(0);
});

test('ST03: S opens Sessions in one step; an account without Sessions stays where it is', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('dashboard')`);
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(`document.activeElement&&document.activeElement.blur&&document.activeElement.blur()`);
  await page.keyboard.press('s');
  await expect.poll(() => page.evaluate(`S.staffTab`)).toBe('sessions');
  await page.evaluate(`setStaffRole('manager');setStaffTab('dashboard')`);
  await page.keyboard.press('s');
  await page.waitForTimeout(150);
  expect(await page.evaluate(`S.staffTab`)).toBe('dashboard');
});

test('ST04 + ST08: a booking picked in Ctrl K opens its ride with the filters off, by its number, in one paint', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('dashboard');S.sfStatus='done';S.sfBike='Hybrid';window.__paints=0;const f=renderStaffQueue;window.renderStaffQueue=function(...a){window.__paints++;return f.apply(this,a);}`);
  await page.keyboard.press('Control+k');
  await page.locator('#gs-input').fill('faris');
  await expect(page.locator('#gs-panel .gs-item').first()).toContainText('Faris Later');
  await page.locator('#gs-input').press('Enter');
  await expect(page.locator('#gs-panel .gs-box')).toHaveCount(0);
  expect(await page.evaluate(`({tab:S.staffTab,sess:S.sfSession,q:S.sfSearch,st:S.sfStatus,bike:S.sfBike,paints:window.__paints})`))
    .toEqual({ tab: 'queue', sess: '2099-02-01', q: '4', st: 'all', bike: 'all', paints: 1 });
  await expect(page.locator('#q-results').locator('tr[data-id="e4"], .q-card[data-id="e4"]').first()).toBeVisible();
});

test('ST06: Ctrl K lists actions and sections, finds a section by name, and keeps what was opened', async ({ page }) => {
  await staff(page);
  await page.keyboard.press('Control+k');
  const box = page.locator('#gs-panel .gs-box');
  await expect(box).toContainText('Actions and sections');
  await expect(box.locator('.gs-item', { hasText: 'Walk-in' })).toHaveCount(1);
  await page.locator('#gs-input').fill('invent');
  await expect(box.locator('.gs-item').first()).toContainText('Inventory');
  await page.locator('#gs-input').press('Enter');
  await expect.poll(() => page.evaluate(`S.staffTab`)).toBe('inventory');
  await page.keyboard.press('Control+k');
  await page.locator('#gs-input').fill('');
  await expect(box.locator('.gs-hd').first()).toHaveText(/Recent/i);
  await expect(box.locator('.gs-item').first()).toContainText('Inventory');
  await page.keyboard.press('Escape');
  // the Owner preset is offered no actions
  await page.evaluate(`setStaffRole('owner');S._myEdit=[]`);
  await page.keyboard.press('Control+k');
  await expect(box.locator('.gs-item', { hasText: 'Walk-in' })).toHaveCount(0);
  await expect(box.locator('.gs-item', { hasText: 'Check in next' })).toHaveCount(0);
});

test('ST05 + ST07: Bookings links to its session in Sessions, whose address names it, and the address opens it again', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('queue',{sid:'2099-02-01'})`);
  const btn = page.locator('#tab-queue .n6t-sess');
  await expect(btn).toHaveText(/Session settings/);
  await btn.click();
  await expect.poll(() => page.evaluate(`({tab:S.staffTab,sel:S.selSessionDetail})`)).toEqual({ tab: 'sessions', sel: '2099-02-01' });
  await expect(page).toHaveURL(/\/sessions\?session=2099-02-01$/);
  await page.goBack();
  await expect.poll(() => page.evaluate(`S.staffTab`)).toBe('queue');
  await page.goto('/sessions?session=2099-02-01');
  await page.waitForFunction(`S.dataLoaded&&S.staffTab==='sessions'`);
  await expect.poll(() => page.evaluate(`S.selSessionDetail`)).toBe('2099-02-01');
});

test('ST07: /people?acct=<id> opens that account window', async ({ page }) => {
  await staff(page, '/people?acct=c1');
  await expect.poll(() => page.evaluate(`S._ah&&S._ah.custId`)).toBe('c1');
  await expect(page.locator('#cust-modal [role="dialog"]').first()).toBeVisible();
  await expect(page.locator('#cust-modal')).toContainText('Amal Saad');
});
