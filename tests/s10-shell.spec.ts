import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff round s10, the shell (2026-11-10): the rail in six groups that scrolls the open section into view, Ctrl K's
// sub-views, office records, Arabic aliases and shortcuts, the bell's four office queues and its grouped switches, the
// Dashboard's office card, next seven nights and a mechanic's own figures, the leave-without-saving guard, confirm
// buttons that are red only when asked, and a volunteer's record leading to their account window.

const DAY = '2099-05-05'; // "today": the clock is fixed, so the hour is never the machine's
const D2 = '2099-05-07';
const slots = '{"_time":"21:00 - 23:00","_total":20}';
const sessions = [
  { id: DAY, session_date: DAY, day: 'Tuesday', status: 'open', capacity: 20, created_at: 1, bike_slots: slots },
  { id: D2, session_date: D2, day: 'Thursday', status: 'open', capacity: 20, created_at: 2, bike_slots: slots },
];
const row = (id: string, n: number, name: string, x: Record<string, unknown> = {}) => ({
  id, session_id: DAY, session_day: 'Tuesday', session_date: DAY, queue_num: n, name, phone: '055000000' + n, customer_id: null,
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: `${DAY}T10:0${n}:00Z`, ...x,
});
const fixtures = {
  sessions,
  queue_entries: [row('e1', 1, 'Amal Saad'), row('e2', 2, 'Badr Omar'), row('e3', 3, 'Dana Faisal', { session_id: D2, session_date: D2, session_day: 'Thursday' })],
  customers: [{ id: 'c1', name: 'Amal Saad', phone: '0551234567', email: 'amal@example.com', created_at: '2026-01-01T00:00:00Z' }],
  bikes: [{ id: 'b1', name: 'Road 9001', bike_number: 9001, type: 'Road', size: 'M', status: 'available', colors: [] }],
};
async function staff(page: Page, w = 1280, h = 900) {
  await page.setViewportSize({ width: w, height: h });
  await page.clock.setFixedTime(new Date(`${DAY}T15:00:00+03:00`));
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded&&S.view==='staff'`);
}

test.describe('@staff:shell s10', () => {
  test('the rail: six groups in order, and the open section scrolled into view', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'the desk rail');
    await staff(page, 1280, 600);
    const nav = page.locator('#staff-tab-nav');
    expect(await nav.locator('.snav-group').allTextContents()).toEqual(['Today', 'Fleet', 'Money', 'People', 'Partners & web', 'Admin']);
    const order = await nav.locator('.tab-btn[data-stab]').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.stab));
    expect(order).toEqual(['dashboard', 'queue', 'waitlist', 'sessions', 'lockers', 'volunteers', 'inventory', 'workshop', 'catalog', 'cashier', 'payments', 'store',
      'community', 'badgereq', 'ask', 'vendors', 'ambassadors', 'website', 'messages', 'analytics', 'history', 'reports', 'team', 'settings']); // Ask (2026-11-13), under People; Reports after History (2026-11-13)
    await page.evaluate(`setStaffTab('settings')`);
    const inView = () => page.evaluate(`(()=>{const n=document.getElementById('staff-tab-nav'),a=n.querySelector('.tab-btn[data-stab="settings"]').getBoundingClientRect(),b=n.getBoundingClientRect();return a.top>=b.top-1&&a.bottom<=b.bottom+1;})()`);
    await expect.poll(inView).toBe(true);
    // a rail the staffer scrolled stays put through the repaints of the same section
    await page.evaluate(`document.getElementById('staff-tab-nav').scrollTop=0;renderStaffTabs()`);
    expect(await page.evaluate(`document.getElementById('staff-tab-nav').scrollTop`)).toBe(0);
  });

  test('Ctrl K: sub-views, shortcuts, Arabic aliases, office records and the lists it does not read', async ({ page }) => {
    await staff(page);
    const r = await page.evaluate(`(()=>{
      const hits=q=>(_gsHits(q)||[]);
      const sub=hits('applications').find(h=>h.l==='People › Applications');
      const ar=hits('الحجوزات').find(h=>h.k==='gsKindGo'&&h.go[2]==='queue');
      const go=hits('bookings').find(h=>h.k==='gsKindGo'&&h.go[2]==='queue');
      const idleSubs=(_gsHits('')||[]).filter(h=>h.sub).length;
      S._bdrRows=[{id:'r1',customer_id:'c1',badge_id:'x',status:'pending',created_at:'2099-05-01T10:00:00Z',comment:'my first ride'}];
      S._amb=undefined;
      const amal=hits('amal');
      const li=amal.findIndex(h=>h.hd==='gsLookIn'),look=li<0?[]:amal.slice(li).map(h=>h.go[2]);
      setStaffRole('manager');const mgr=hits('duplicates').map(h=>h.l);setStaffRole('admin');
      return{sub:sub&&sub.go,ar:!!ar,sc:go&&go.sc,idleSubs,bdr:amal.some(h=>h.k==='bdrStTitle'&&h.go[1]==='bdr'),look,mgr,adm:hits('duplicates').map(h=>h.l)};})()`) as Record<string, unknown>;
    expect(r.sub).toEqual(['_n6tCmd', 'sub', 'community', 'applications']);
    expect(r.ar).toBe(true);
    expect(r.sc).toBe('G B');
    expect(r.idleSubs).toBe(0); // the sub-views come only when typed for
    expect(r.bdr).toBe(true);
    expect(r.look).toContain('ambassadors'); // not read on this device: its Go to instead
    expect(r.mgr).not.toContain('People › Duplicates');
    expect(r.adm).toContain('People › Duplicates');
    // the bar draws the shortcut, and a sub-view opens on its own page
    await page.keyboard.press('Control+k');
    await page.locator('#gs-input').fill('bookings');
    await expect(page.locator('#gs-results .gs-item', { hasText: 'Bookings' }).first().locator('.gs-kbd')).toHaveText('G B');
    await page.locator('#gs-input').fill('applications');
    await page.locator('#gs-results .gs-item', { hasText: 'People › Applications' }).click();
    await expect.poll(() => page.evaluate(`[S.staffTab,S.communityTab]`)).toEqual(['community', 'applications']);
  });

  test('a volunteer found by Ctrl K opens their account window', async ({ page }) => {
    await staff(page);
    await page.evaluate(`_gsGo('vol','c1')`);
    await expect.poll(() => page.evaluate(`S._ah&&S._ah.custId`)).toBe('c1');
  });

  test('the bell: badge requests, store orders, refunds owed and flagged accounts; the applications counted; switches grouped', async ({ page }) => {
    await staff(page);
    const k = await page.evaluate(`(()=>{
      S._storeReady=true; // the database has the store (staff_store_ready): Store and Payments open
      S._bdrRows=[{id:'r1',customer_id:'c1',status:'pending',created_at:'2099-05-01T10:00:00Z'},{id:'r2',customer_id:'c1',status:'given'}];
      S._stoPaid=[{id:'o1',no:1001,name:'Huda',paid_at:'2099-05-04T10:00:00Z'}];S._payDue=[{id:'f1',amount:60,created_at:'2099-05-04T11:00:00Z'}];
      S._flags=[{id:'g1',customer_id:'c1',status:'pending',flagged_at:'2099-05-03T10:00:00Z'},{id:'g2',customer_id:'c1',status:'answered'}];
      S._caApps=undefined;S._caWaitB=1;S._caWaitN=3;
      const ks=_ntKinds(),by=Object.fromEntries(ks.map(x=>[x.k,x]));
      return{bdr:by.bdr.ids,sto:by.stoord.items[0].txt,ref:by.refowed.ids,flags:by.flags.ids,apps:by.apps.items.map(i=>i.txt)};})()`) as Record<string, unknown>;
    expect(k.bdr).toEqual(['r1']);
    expect(k.sto).toBe('Order MM-1001 · Huda to prepare');
    expect(k.ref).toEqual(['f1']);
    expect(k.flags).toEqual(['g1']);
    expect(k.apps).toEqual(['Membership applications waiting: 3']);
    await page.evaluate(`setStaffTab('settings')`);
    const heads = page.locator('#tab-settings .set-ntg .set-ntg-h');
    await expect(heads.first()).toHaveText('Desk');
    expect(await heads.allTextContents()).toEqual(['Desk', 'People', 'Fleet', 'Volunteers', 'Office']);
    await expect(page.locator('#tab-settings .set-ntg', { hasText: 'Office' }).locator('input[data-nt-kind="refowed"]')).toHaveCount(1);
    await expect(page.locator('#tab-settings .set-ntg', { hasText: 'People' }).locator('input[data-nt-kind="bdr"]')).toHaveCount(1);
  });

  test('the Dashboard: waiting on the office, the next seven nights, and a mechanic\'s own figures', async ({ page }) => {
    await staff(page);
    await page.evaluate(`S._bdrRows=[{id:'r1',customer_id:'c1',status:'pending'}];S._ws={jobs:[{id:'j1',status:'new'},{id:'j2',status:'completed'}]};S._caWaitN=2;setStaffTab('dashboard')`);
    const dash = page.locator('#tab-dashboard');
    const office = dash.locator('[data-dash="office"]');
    await expect(office).toContainText('Waiting on the office');
    await expect(office).toContainText('Badge requests waiting: 1');
    await expect(office).toContainText('Open workshop jobs: 1');
    await expect(office).toContainText('Membership applications waiting: 2');
    const nights = dash.locator('[data-dash="week"] .dash-night');
    await expect(nights).toHaveCount(2);
    await expect(nights.first().locator('strong')).toHaveText('2/20');
    await nights.nth(1).click();
    await expect.poll(() => page.evaluate(`[S.staffTab,S.sfSession]`)).toEqual(['queue', D2]);
    // a mechanic: no greyed tiles, the workshop's queue leads
    await page.evaluate(`setStaffRole('mechanic');S._ws={jobs:[{id:'j1',status:'new'}]};renderDashboard()`);
    await expect(dash.locator('.dash-hero .dash-hero-k')).toHaveText('Workshop queue');
    await expect(dash.locator('.dash-kpi[disabled], .dash-hero[disabled]')).toHaveCount(0);
  });

  test('leaving a section with unsaved work asks first, centred, with named buttons', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('team');window.__dirty=true;_draftReg('spec','team',()=>window.__dirty,()=>{window.__dirty=false;window.__dropped=1;})`);
    await page.evaluate(`setStaffTab('queue')`);
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box).toContainText('Leave without saving?');
    await box.getByRole('button', { name: 'Keep editing' }).click();
    expect(await page.evaluate('S.staffTab')).toBe('team');
    await page.evaluate(`setStaffTab('queue')`);
    const leave = box.getByRole('button', { name: 'Leave without saving' });
    await expect(leave).toHaveClass(/btn-red/);
    await leave.click();
    await expect.poll(() => page.evaluate('[S.staffTab,window.__dropped]')).toEqual(['queue', 1]);
    // Back into the section and Back out of it again with a draft: the address comes back and the pop-up asks
    await page.evaluate(`setStaffTab('team');window.__dirty=true`);
    await page.goBack();
    await expect(box).toContainText('Leave without saving?');
    expect(await page.evaluate('S.staffTab')).toBe('team');
    expect(new URL(page.url()).pathname).toBe('/team');
  });

  test('a confirm with no class is the neutral button, and the build names every call\'s class', async ({ page }) => {
    await staff(page);
    await page.evaluate(`confirmDialog({title:'Publish',confirmLabel:'Publish',onConfirm(){}})`);
    await expect(page.locator('#confirm-modal .chrome-dact button').last()).toHaveClass(/btn-primary/);
    const m = (await import('../scripts/check-confirm-class.mjs' as string)) as { confirmClassOffenders(code: string): { calls: number; offenders: { name: string; line: number }[] } };
    const r = m.confirmClassOffenders(`confirmDialog({title:'a',confirmLabel:'b'});\naskConfirm({title:'a',confirmClass:'btn-red'});\naskConfirm(x?{confirmClass:'btn-primary'}:{confirmClass:'btn-red'});\naskConfirm(opts);`);
    expect(r.calls).toBe(4);
    expect(r.offenders).toEqual([{ name: 'confirmDialog', line: 1 }, { name: 'askConfirm', line: 4 }]);
  });
});
