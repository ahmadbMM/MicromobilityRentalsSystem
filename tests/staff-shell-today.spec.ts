import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The staff shell, 2026-11-06 review (ST09-ST13, ST16, ST17): Sessions and Volunteers repaint at a measured pace, a
// fuller Today page with ways on from each session, a section that does not open says why, Team says what each account
// can do, Sessions and Volunteers get counts on the rail and lines in the bell, G then a letter opens a section, the
// phone bar follows the role, and table headings line up in Arabic.

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const PAST = '2026-01-10';
const slots = '{"_time":"21:00 - 23:00","_total":4}';
const sessions = [
  { id: TODAY, session_date: TODAY, day: 'Friday', status: 'open', capacity: 4, created_at: 1, bike_slots: slots },
  { id: PAST, session_date: PAST, day: 'Saturday', status: 'open', capacity: 4, created_at: 2, bike_slots: slots },
];
const row = (id: string, n: number, sid: string, x: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Friday', session_date: sid, queue_num: n, name: 'Rider ' + n, phone: '055000000' + n, customer_id: null,
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: `${sid}T10:0${n}:00Z`, ...x,
});
const fixtures = {
  sessions,
  queue_entries: [row('t1', 1, TODAY), row('t2', 2, TODAY), row('t3', 3, TODAY), row('p1', 1, PAST)],
  customers: [{ id: 'c1', name: 'Huda Saleh', phone: '0551112222', created_at: '2026-01-01T00:00:00Z' }],
  bikes: [],
};
async function staff(page: Page, x: Record<string, unknown> = {}, path = '/') {
  await stubSupabase(page, { ...fixtures, ...x });
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded');
}
// The Volunteers page's lists, as its part reads them (S.vm), laid by hand.
const VM = `S.vm={rows:[{customer_id:'c1',status:'applied',created_at:'${TODAY}T08:00:00Z'}],sess:[{session_id:'${TODAY}',enabled:true,closes_at:'2099-01-01T00:00:00Z'},{session_id:'${PAST}',enabled:true,closes_at:'${PAST}T23:00:00Z'}],
  shifts:[{id:1,session_id:'${TODAY}',customer_id:'c1',status:'accepted',clock_in:'${TODAY}T15:00:00Z',clock_out:null},{id:2,session_id:'${TODAY}',customer_id:'c1',status:'interested'},
  {id:3,session_id:'${PAST}',customer_id:'c1',status:'accepted',clock_in:'${PAST}T15:00:00Z',clock_out:null}],hours:[],cfg:{},log:null,busy:false,missing:false,err:false,at:Date.now(),sel:null,
  f:{status:'active',tag:'',band:'',agree:'',sort:'name',q:''},hf:{q:'',from:'',to:'',src:''},lf:{q:'',act:'',sess:''},sv:'next'}`;

test.describe('@staff:shell the staff shell (2026-11-06)', () => {
  test('Sessions and Volunteers repaint in the background at most every 2.5 and 5 seconds', async ({ page }) => {
    await staff(page);
    expect(await page.evaluate('[_BG_GAP.sessions,_BG_GAP.volunteers]')).toEqual([2500, 5000]);
  });

  test('the Today page: ways on from each session, volunteers, people waiting and nights left open', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('dashboard')`);
    const el = page.locator('#tab-dashboard');
    const jumps = el.locator('.dash-jumps').first();
    await expect(jumps.locator('button')).toHaveText(['Bookings', 'Session', 'Volunteers']);
    await expect(el.locator('[data-dash="vol"]')).toContainText("See today's volunteers");
    await expect(el.locator('[data-dash="office"]')).toContainText('See membership applications'); // Waiting on the office since s10
    const open = el.locator('[data-dash="open"]');
    await expect(open).toContainText('Nights left open');
    await expect(open.locator('.dash-row')).toHaveCount(1);
    await expect(open.locator('.dash-row')).toContainText(': 1');
    await page.evaluate(VM);
    await page.evaluate(`renderDashboard()`);
    await expect(el.locator('[data-dash="vol"] .dash-row')).toHaveText([/On duty\s*1/, /Interested\s*1/]);
    await jumps.locator('button', { hasText: 'Session' }).click();
    expect(await page.evaluate('[S.staffTab,S.selSessionDetail]')).toEqual(['sessions', TODAY]);
    await page.evaluate(`setStaffTab('dashboard')`);
    await el.locator('.dash-jumps').first().locator('button', { hasText: 'Volunteers' }).click();
    expect(await page.evaluate('[S.staffTab,S.vm.vd.sid,S.volView]')).toEqual(['volunteers', TODAY, 'shift']);
  });

  test('a manager or an owner with no Start on of their own opens on the Dashboard; the desk keeps Bookings', async ({ page }) => {
    await staff(page);
    expect(await page.evaluate(`(()=>{const o={};for(const r of ['admin','manager','owner','frontdesk']){S.staffRole=r;o[r]=_startTab();}S.staffRole='admin';return o;})()`))
      .toEqual({ admin: '', manager: 'dashboard', owner: 'dashboard', frontdesk: '' });
    await page.evaluate(`S.staffRole='manager';_prefSet('start','history')`);
    expect(await page.evaluate('_startTab()')).toBe('history');
  });

  test('G then a letter opens a section, on an Arabic layout too; a section the account cannot open says why', async ({ page }) => {
    await staff(page);
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    expect(await page.evaluate('S.staffTab')).toBe('sessions');
    // an Arabic layout: the keys by their place
    await page.evaluate(`for(const [key,code] of [['ل','KeyG'],['ي','KeyD']])document.body.dispatchEvent(new KeyboardEvent('keydown',{key,code,bubbles:true}))`);
    expect(await page.evaluate('S.staffTab')).toBe('dashboard');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="sessions"]')).toHaveAttribute('aria-keyshortcuts', 'G S');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="volunteers"]')).toHaveAttribute('title', 'Volunteers (G V)');
    await page.keyboard.press('Shift+?');
    await expect(page.locator('#confirm-modal .kb-list')).toContainText('G, then a letter: go to a section');
    await page.keyboard.press('Escape');
    await page.evaluate(`setStaffRole('cashier')`);
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page.locator('#toast-container')).toContainText('Sessions is not open to your account; an admin can change this in Team.');
    expect(await page.evaluate('S.staffTab')).not.toBe('sessions');
  });

  test('the bell and the rail count Sessions and Volunteers', async ({ page }) => {
    await staff(page);
    await page.evaluate(VM);
    const kinds = await page.evaluate(`Object.fromEntries(_ntKinds().filter(x=>['coopen','sfull','vsign','vopen'].includes(x.k)).map(x=>[x.k,x.ids]))`);
    expect(kinds).toEqual({ coopen: [PAST], sfull: [TODAY + '|' + TODAY], vsign: ['ap:c1', 'sh:2'], vopen: ['3'] });
    await page.evaluate('_ntSync()');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="sessions"] .tab-badge')).toHaveText('2');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="volunteers"] .tab-badge')).toHaveText('3');
    await page.evaluate(`setStaffRole('frontdesk')`);
    await page.evaluate('_ntSync()');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="volunteers"] .tab-badge')).toHaveCount(0);
  });

  test('Team says what each account can see, change and not do', async ({ page }) => {
    await staff(page, {
      'rpc:staff_team_list': [
        { user_id: 'u-me', email: 'me@x.sa', role: 'admin', modules_view: null, modules_edit: null, is_me: true },
        { user_id: 'u-mech', email: 'mech@x.sa', role: 'mechanic', modules_view: null, modules_edit: ['workshop'], is_me: false },
      ],
      'rpc:staff_operator_list': [],
    });
    await page.evaluate(`setStaffTab('team')`);
    const can = page.locator('.tm-can[data-can="u-mech"]');
    await expect(can).toContainText('Sees Inventory, Workshop');
    await expect(can).toContainText('Changes Workshop');
    await expect(page.locator('.tm-can[data-can="u-me"]')).toContainText('Sees Every section');
  });

  test('the phone bar follows the role, and table headings line up in Arabic', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await staff(page);
    const bar = page.locator('#staff-tabbar');
    await expect(bar.locator('.tb-btn[data-tb]')).toHaveText(['Bookings', 'Sessions', 'People', 'Sales']);
    await page.evaluate(`setStaffRole('manager')`);
    expect(await bar.locator('.tb-btn[data-tb]').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.tb))).toEqual(['dashboard', 'queue', 'community', 'cashier']);
    await page.evaluate(`setStaffRole('admin');setStaffTab('sessions');S.sessView='table';renderSessions()`);
    await page.evaluate(`setLang('ar')`);
    await expect(page.locator('#tab-sessions .sess-admin-table th').first()).toBeVisible();
    await expect.poll(() => page.evaluate(`(()=>{const x=document.querySelector('#tab-sessions .sess-admin-table th');return x?getComputedStyle(x).textAlign:'';})()`)).toBe('start');
  });
});
