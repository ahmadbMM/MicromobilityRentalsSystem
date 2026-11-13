import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Who sees the Saturday ride's breakfast spot (the owner, 2026-11-13: "add a switch on the breakfast spot to choose to
// show it to all booking cards or only members booking cards"). bike_slots._bfm 1 = community members only: a rider
// who is not a member (community_member says no; a ride code lets one book) sees no name, link, offer or "announced at"
// line on the date card, Details, the ticket or the calendar file. Staff set it under the breakfast picker.

const SAT = '2099-10-24';
const AHEAD = new Date(Date.now() + 2 * 864e5).toISOString();
const MEET = 'https://maps.app.goo.gl/meetHere123';
const BF = 'https://maps.app.goo.gl/harbourCafe1';
const sat = (extra: Record<string, unknown> = {}) => ({
  id: SAT, session_date: SAT, day: 'Saturday', status: 'open', capacity: 20, spots: 20, created_at: 1, event_kind: 'community',
  ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true, meet_url: MEET, breakfast_name: 'Harbour Cafe',
  breakfast_url: BF, bike_slots: '{"_time":"06:00 - 06:30"}', ...extra,
});
const MEM_SLOTS = '{"_time":"06:00 - 06:30","_bfm":1}';
const bk = { id: 'q1', name: 'Sara Haddad', customer_id: 'c1', session_id: SAT, session_day: 'Saturday', session_date: SAT, queue_num: 1,
  status: 'waiting', paid: false, price: 0, registered_at: '2099-10-01T10:00:00Z', approval: 'approved', type_preference: 'Road' };
const icsOf = (page: Page) => page.evaluate(`(()=>{let txt='';const B=window.Blob;window.Blob=function(p){txt=p.join('');return new B(p);};
  const U=URL.createObjectURL;URL.createObjectURL=()=>'blob:x';try{downloadBookingICS('${SAT}');}finally{window.Blob=B;URL.createObjectURL=U;}return txt;})()`) as Promise<string>;

test.describe('@customer:bfmem the breakfast spot for members only', () => {
  async function rider(page: Page, sessions: unknown[], isMember: boolean, mine: unknown[] = [bk]) {
    await stubSupabase(page, { sessions, queue_entries: mine, 'rpc:my_bookings': mine, 'rpc:community_member': isMember });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
  }

  test('a member sees it on the ticket, the date card and Details', async ({ page }) => {
    await rider(page, [sat({ bike_slots: MEM_SLOTS })], true);
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides');
    await expect(tk.locator('.cmy-bf')).toContainText('Harbour Cafe');
    await expect(tk.locator(`a.cmy-bf[href="${BF}"]`)).toHaveCount(1);
    await page.evaluate(`selectEvent('community')`);
    await expect(page.locator('#tab-register .sess-card-bf')).toHaveText('Breakfast at Harbour Cafe');
    await page.evaluate(`showSessInfo('${SAT}')`);
    await expect(page.locator('#bike-info-modal .ev-info-facts')).toContainText('Breakfast at Harbour Cafe');
  });

  test('a rider who is not a member sees nothing of it, and still has the meeting point', async ({ page }) => {
    await rider(page, [sat({ bike_slots: MEM_SLOTS })], false);
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides');
    await expect(tk.locator('.cu-tk-dir')).toHaveAttribute('href', MEET);
    await expect(tk.locator('.cmy-bf')).toHaveCount(0);
    await expect(tk).not.toContainText('Harbour Cafe');
    expect(await page.evaluate(`_bfAt(S.sessions[0])`)).toBe('');
    const ics = await icsOf(page);
    expect(ics).not.toContain('Harbour Cafe');
    expect(ics).toContain('LOCATION:' + MEET);
  });

  test('an "announced at" line is not said to a rider who will not be told', async ({ page }) => {
    const held = sat({ bike_slots: MEM_SLOTS, reveal_at: AHEAD, breakfast_name: null, breakfast_url: null });
    await rider(page, [held], false);
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    await expect(page.locator('#tab-myrides .cu-tk-dir')).toHaveAttribute('href', MEET);
    await expect(page.locator('#tab-myrides .cu-reveal')).toHaveCount(0);
    expect(await icsOf(page)).not.toContain('Breakfast spot: announced');
    // a member is told when, as before
    expect(await page.evaluate(`(()=>{S._commAccess={custId:'c1',ok:true};return _spotSaid(S.sessions[0]);})()`)).toBe(true);
  });

  test('with every booking chosen, a rider who is not a member sees it as before', async ({ page }) => {
    await rider(page, [sat()], false);
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    await expect(page.locator('#tab-myrides .cmy-bf')).toContainText('Harbour Cafe');
  });
});

test.describe('@staff:bfmem the switch under the breakfast picker', () => {
  function writes(page: Page, method: string) {
    const out: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== method || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
      try { const b = r.postDataJSON(); (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => out.push(x)); } catch { /* not JSON */ }
    });
    return out;
  }
  const slotsOf = (p: Record<string, unknown>) => JSON.parse(String(p.bike_slots || '{}'));
  async function staff(page: Page, sessions: unknown[]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  }

  test('the editor sets it and takes it back off', async ({ page }) => {
    await staff(page, [sat()]);
    const patches = writes(page, 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SAT}')`);
    const grp = page.locator('#es-bfmem');
    await expect(grp).toContainText('Who sees the breakfast spot');
    await expect(grp.getByRole('button', { name: 'All bookings' })).toHaveAttribute('aria-pressed', 'true');
    await grp.getByRole('button', { name: 'Members only' }).click();
    await expect(grp.getByRole('button', { name: 'Members only' })).toHaveAttribute('aria-pressed', 'true');
    await expect(grp.getByRole('button', { name: 'All bookings' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => patches.filter((p) => 'bike_slots' in p).length).toBe(1);
    expect(slotsOf(patches.find((p) => 'bike_slots' in p)!)).toMatchObject({ _time: '06:00 - 06:30', _bfm: 1 });
    await expect(page.locator('#es-bfmem')).toHaveCount(0); // the save has finished and closed the editor
    patches.length = 0;
    await page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='${SAT}'?{...s,bike_slots:'${MEM_SLOTS}'}:s);startEditSession('${SAT}')`);
    await expect(page.locator('#es-bfmem').getByRole('button', { name: 'Members only' })).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#es-bfmem').getByRole('button', { name: 'All bookings' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => patches.filter((p) => 'bike_slots' in p).length).toBe(1);
    expect(slotsOf(patches.find((p) => 'bike_slots' in p)!)).not.toHaveProperty('_bfm');
  });

  test('a new Saturday ride carries it', async ({ page }) => {
    await staff(page, []);
    const rows = writes(page, 'POST');
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S._nsTplId=null;S.newSessEvent='community';renderSessions()`);
    await page.locator('#ns-date').fill('2099-10-24');
    await page.locator('#ns-start').fill('06:00');
    await page.locator('#ns-end').fill('06:30');
    await page.locator('#ns-bfmem').getByRole('button', { name: 'Members only' }).click();
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(1);
    expect(slotsOf(rows[0])).toMatchObject({ _bfm: 1 });
  });

  test('a template remembers it, and a clone takes the original’s', async ({ page }) => {
    await staff(page, [sat({ bike_slots: MEM_SLOTS })]);
    expect(await page.evaluate(`NS_TPL_KEYS.includes('newSessBfMem')`)).toBe(true);
    expect(await page.evaluate(`_nsCopy(_sessGet('${SAT}'),{}).newSessBfMem`)).toBe(true);
    expect(await page.evaluate(`_nsCopy({..._sessGet('${SAT}'),bike_slots:'{"_time":"06:00 - 06:30"}'},{}).newSessBfMem`)).toBe(false);
  });

  test('the Sessions card and its detail say members only; staff still see the spot', async ({ page }) => {
    await staff(page, [sat({ bike_slots: MEM_SLOTS })]);
    await page.evaluate(`setStaffTab('queue');S.queueView='sessions';S.selSessionDetail='${SAT}';renderStaffQueue()`);
    await expect(page.locator('#tab-sessions .sess-lc .sess-lc-bf')).toHaveText('Breakfast at Harbour Cafe · Members only');
    await expect(page.locator('#tab-sessions .sess-detail-bf')).toHaveText('Breakfast at Harbour Cafe · Members only');
  });
});
