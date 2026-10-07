import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07 (boot, realtime and the light reload): what a light reload may overwrite,
// and the repaint a hidden page drops.
const SID = '2099-03-12';
const sessions = [{ id: SID, day: 'Thursday', session_date: SID, capacity: 12, status: 'open', created_at: 1 }];
const row = (id: string, qn: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: SID, session_day: 'Thursday', session_date: SID, queue_num: qn, name, phone: '0500000002', email: '', customer_id: null,
  group_id: null, status: 'waiting', paid: false, price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z',
  type_preference: 'Road', size: 'M', purchases: null, addons: null, ...extra,
});
// queue_public's columns only: no name, phone, email or account.
const pub = (id: string, qn: number) => ({
  id, session_id: SID, session_day: 'Thursday', session_date: SID, queue_num: qn, status: 'waiting', size: 'M',
  type_preference: 'Road', paid: false, price: 30, assigned_bike_id: null, walk_in: true, ride_duration: null,
});

test.describe('@staff:sync bug hunt 2026-10-07', () => {
  test('a light reload through the public view keeps the riders a staff device already knew', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_public: [pub('e1', 1)], queue_entries: [], desk_waitlist: [], cashier_sales: [] });
    await page.addInitScript(() => localStorage.setItem('cq_secure_auth', '1'));
    await page.goto('/');
    await waitForSb(page);
    // A staff device whose Auth session could not be renewed (the unlock is kept, the session is not).
    const out = await page.evaluate(`(async()=>{
      localStorage.setItem('cq_staff','1');S._staffAuthed=false;
      S.queue=[entryFromDB(${JSON.stringify(row('e1', 1, 'Known Rider'))})];
      await loadDataLight();
      const e=S.queue.find(x=>x.id==='e1');
      return e?{name:e.name,phone:e.phone}:null;
    })()`);
    expect(out).toEqual({ name: 'Known Rider', phone: '0500000002' });
  });

  test('a desk-list change that lands while a light reload is in flight is not undone by it', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [row('e1', 1, 'First')], desk_waitlist: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let seen = false;
    await page.route(/\/rest\/v1\/desk_waitlist/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      seen = true;
      await held; // the answer is the list as it was before the walk-in below
      return route.fallback();
    });
    await page.evaluate("window.__noWiden=false; S.view='staff'; window.__p=loadDataLight(); 0");
    await expect.poll(() => seen).toBe(true);
    await page.evaluate(`_onRt({table:'desk_waitlist',eventType:'INSERT',new:{id:'w1',name:'Walk In',created_at:'2099-03-12T17:00:00Z'},old:{}})`);
    release();
    await page.evaluate('window.__p');
    expect(await page.evaluate('(S.deskWaitlist||[]).map(x=>x.id)')).toEqual(['w1']);
  });

  test('a background repaint dropped while the page is hidden is drawn when it comes back', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [row('e1', 1, 'First')] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const out = await page.evaluate(`(async()=>{
      S.view='staff';S.staffTab='analytics';_lastFp='drawn';
      _bgAt.analytics=Date.now()-4800; // the analytics repaint is held to one every five seconds
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
      try{_bgRenderStaffTab();await new Promise(r=>setTimeout(r,500));}
      finally{delete document.hidden;}
      return _lastFp;
    })()`);
    expect(out).toBeNull();
  });
});
