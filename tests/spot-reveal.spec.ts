import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// The Saturday ride's meeting point and breakfast spot, told at a time staff choose (the owner, 2026-10-06:
// "add an option for saturday social ride to announce/make the spot and location visible at the time the staff
// chooses"). sessions.reveal_at: until then list_sessions answers riders with location, meet_url, route_slug and
// the breakfast stop blank (migration 20261006150000), and the page says when they are told instead of reading
// the blank as the circuit. Staff set the time on the new-session form and in the editor.

const SAT = '2099-10-24';
const AHEAD = new Date(Date.now() + 2 * 864e5).toISOString();
const PAST = new Date(Date.now() - 864e5).toISOString();
const MEET = 'https://maps.app.goo.gl/meetHere123';
const sat = (extra: Record<string, unknown> = {}) => ({
  id: SAT, session_date: SAT, day: 'Saturday', status: 'open', capacity: 20, spots: 20, created_at: 1, event_kind: 'community',
  ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true, bike_slots: '{"_time":"06:00 - 06:30"}', ...extra,
});
// what list_sessions gives a rider while the time is ahead: the time, and nothing about where
const held = sat({ reveal_at: AHEAD, meet_url: null, breakfast_name: null, breakfast_url: null });
const told = sat({ reveal_at: PAST, meet_url: MEET, breakfast_name: 'Harbour Cafe' });

test.describe('@customer:reveal the meeting point and breakfast spot told at staff’s time', () => {
  async function member(page: Page, sessions: unknown[], mine: unknown[] = []) {
    await stubSupabase(page, { sessions, queue_entries: mine, 'rpc:my_bookings': mine, 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
  }

  test('the date card and Details say when, never the circuit; once told they say where', async ({ page }) => {
    await member(page, [held]);
    await page.evaluate(`selectEvent('community')`);
    const line = page.locator('#tab-register .sess-card .sess-card-reveal');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText('Meeting point and breakfast spot: announced');
    expect(await page.evaluate(`_revealWhen(S.sessions[0])`)).toMatch(/ · \d{1,2}(:\d{2})? (AM|PM)$/);
    await page.evaluate(`showSessInfo('${SAT}')`);
    const facts = page.locator('#bike-info-modal .ev-info-facts');
    await expect(facts).toContainText('Announced');
    await expect(facts).not.toContainText('Jeddah Corniche Circuit');
    await expect(facts.locator('a[href]')).toHaveCount(0);
    await page.evaluate('closeEventInfo()');
    // the time comes and the read brings them: where it meets, and breakfast by name
    await page.evaluate(`(()=>{S.sessions=[${JSON.stringify(told)}];renderRegister();})()`);
    await expect(page.locator('#tab-register .sess-card-reveal')).toHaveCount(0);
    await expect(page.locator('#tab-register .sess-card-bf')).toHaveText('Breakfast at Harbour Cafe');
  });

  test('the ticket says when, offers no directions, and its calendar entry has no place yet', async ({ page }) => {
    const bk = { id: 'q1', name: 'Sara Haddad', customer_id: 'c1', session_id: SAT, session_day: 'Saturday', session_date: SAT, queue_num: 1,
      status: 'waiting', paid: false, price: 0, registered_at: '2099-10-01T10:00:00Z', approval: 'approved', type_preference: 'Road' };
    await member(page, [held], [bk]);
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides');
    await expect(tk.locator('.cu-reveal')).toContainText('Meeting point and breakfast spot: announced');
    await expect(tk.locator('.cu-tk-dir')).toHaveCount(0);
    await expect(tk).not.toContainText('Jeddah Corniche Circuit');
    expect(await page.evaluate(`_venueName(S.sessions[0])`)).toBe('Meeting point');
    expect(await page.evaluate(`_rideRoute(S.sessions[0])`)).toBeNull();
    const ics = await page.evaluate(`(()=>{let txt='';const B=window.Blob;window.Blob=function(p){txt=p.join('');return new B(p);};
      const U=URL.createObjectURL;URL.createObjectURL=()=>'blob:x';try{downloadBookingICS('${SAT}');}finally{window.Blob=B;URL.createObjectURL=U;}return txt;})()`) as string;
    expect(ics).not.toContain('LOCATION:');
    expect(ics).toContain('announced');
    // Arabic says it in Arabic
    await page.evaluate(`setLang('ar')`);
    await expect.poll(() => page.evaluate(`t('revealSpotsAt')`)).toContain('نقطة التجمع');
    await page.evaluate('renderMyRides()');
    await expect(tk.locator('.cu-reveal')).toContainText('نقطة التجمع وموقع الفطور');
  });

  test('a ride told already shows its meeting point, whatever the phone’s clock says', async ({ page }) => {
    await member(page, [sat({ reveal_at: AHEAD, meet_url: MEET, breakfast_name: 'Harbour Cafe' })]);
    // the row came with them, so the server has told them: a phone running behind still shows them
    expect(await page.evaluate(`_spotHeld(S.sessions[0])`)).toBe(false);
    // a row read before the time, after it: still "when" until the read lands, then the plain fallback
    expect(await page.evaluate(`_spotHeld({...S.sessions[0],reveal_at:new Date(Date.now()-60000).toISOString(),meet_url:null,breakfast_name:null})`)).toBe(true);
    expect(await page.evaluate(`_spotHeld({...S.sessions[0],reveal_at:new Date(Date.now()-7*3600e3).toISOString(),meet_url:null,breakfast_name:null})`)).toBe(false);
  });

  test('the page reads again when the soonest time comes, and not for one days away', async ({ page }) => {
    await member(page, [held]);
    expect(await page.evaluate(`_revealT===null`)).toBe(true); // two days ahead: nothing waits that long
    expect(await page.evaluate(`(()=>{S.sessions=[{...S.sessions[0],reveal_at:new Date(Date.now()+60000).toISOString()}];_revealArm();return _revealT!==null;})()`)).toBe(true);
    expect(await page.evaluate(`(()=>{S.sessions=[];_revealArm();return _revealT===null;})()`)).toBe(true);
  });
});

test.describe('@staff:sessions the announce time on the session forms', () => {
  function writes(page: Page, method: string) {
    const out: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() !== method || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
      try { const b = r.postDataJSON(); (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => out.push(x)); } catch { /* not JSON */ }
    });
    return out;
  }
  async function staff(page: Page, sessions: unknown[]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  }

  test('the editor keeps a Riyadh time, says until when, and writes it alone', async ({ page }) => {
    await staff(page, [sat({ meet_url: MEET, breakfast_name: 'Harbour Cafe' })]);
    const patches = writes(page, 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SAT}')`);
    const box = page.locator('#es-reveal');
    await expect(box).toHaveValue('');
    await expect(page.locator('#es-reveal-clr')).toBeHidden();
    await box.fill('2099-10-23T20:00');
    await expect(page.locator('#es-reveal-note')).toContainText('Hidden from riders until');
    await expect(page.locator('#es-reveal-clr')).toBeVisible();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => patches.filter((p) => 'reveal_at' in p).length).toBe(1);
    // 20:00 in Riyadh is 17:00 UTC; the meeting point and breakfast are written where they always were
    expect(patches.find((p) => 'reveal_at' in p)).toEqual({ reveal_at: '2099-10-23T17:00:00.000Z' });
    expect(patches.some((p) => p.meet_url === MEET && p.breakfast_name === 'Harbour Cafe')).toBe(true);
  });

  test('any time is taken, even after the ride gathers; Show now clears it', async ({ page }) => {
    // the owner, 2026-10-06: "make me able to choose anytime i want no need the announcement time to be before the ride starts"
    await staff(page, [sat({ meet_url: MEET, reveal_at: '2099-10-23T17:00:00.000Z' })]);
    const patches = writes(page, 'PATCH');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SAT}')`);
    await expect(page.locator('#es-reveal')).toHaveValue('2099-10-23T20:00');
    await page.locator('#es-reveal').fill('2099-10-24T07:00'); // the ride gathers at 6 that morning
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => patches.filter((p) => 'reveal_at' in p).length).toBe(1);
    expect(patches.find((p) => 'reveal_at' in p)).toEqual({ reveal_at: '2099-10-24T04:00:00.000Z' });
    patches.length = 0;
    await page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='${SAT}'?{...s,reveal_at:'2099-10-24T04:00:00.000Z'}:s);startEditSession('${SAT}')`);
    await expect(page.locator('#es-reveal')).toHaveValue('2099-10-24T07:00');
    await page.locator('#es-reveal-clr').click();
    await expect(page.locator('#es-reveal')).toHaveValue('');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => patches.filter((p) => 'reveal_at' in p).length).toBe(1);
    expect(patches.find((p) => 'reveal_at' in p)).toEqual({ reveal_at: null });
  });

  test('a new Saturday ride carries the time, and each week of a repeat is told as long ahead of its day', async ({ page }) => {
    await staff(page, []);
    const rows = writes(page, 'POST');
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S._nsTplId=null;S.newSessEvent='community';renderSessions()`);
    await expect(page.locator('#ns-reveal')).toBeVisible();
    await page.locator('#ns-repeat').selectOption('2');
    await page.locator('#ns-date').fill('2099-10-24');
    await page.locator('#ns-start').fill('06:00');
    await page.locator('#ns-end').fill('06:30');
    await page.locator('#ns-reveal').fill('2099-10-23T20:00');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => rows.length).toBe(2);
    expect(rows.map((r) => [r.session_date, r.reveal_at])).toEqual([
      ['2099-10-24', '2099-10-23T17:00:00.000Z'], ['2099-10-31', '2099-10-30T17:00:00.000Z']]);
  });

  test('an invitation written before the time leaves the meeting point out', async ({ page }) => {
    await staff(page, [sat({ meet_url: MEET, reveal_at: AHEAD })]);
    expect(await page.evaluate(`_caInvWhen(_sessGet('${SAT}'),'en').join('|')`)).not.toContain(MEET);
    expect(await page.evaluate(`_caInvWhen({..._sessGet('${SAT}'),reveal_at:null},'en').join('|')`)).toContain(MEET);
  });

  test('the Sessions card and its detail say the spot is hidden until when', async ({ page }) => {
    await staff(page, [sat({ meet_url: MEET, reveal_at: AHEAD }), { ...sat({ meet_url: MEET }), id: '2099-10-31', session_date: '2099-10-31' }]);
    await page.evaluate(`setStaffTab('queue');S.queueView='sessions';S.selSessionDetail='${SAT}';renderStaffQueue()`);
    await expect(page.locator('#sess-host .sess-lc .sess-lc-rv')).toHaveCount(1);
    await expect(page.locator('#sess-host .sess-lc .sess-lc-rv')).toContainText('Hidden from riders until');
    await expect(page.locator('#sess-host .sess-detail-rv')).toContainText('Hidden from riders until');
  });
});
