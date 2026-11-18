import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, stubRealtime, unlockStaff, waitForSb } from './helpers/supabase';

// The calling screen (the user's pick of the staff Bookings features, 2026-11-18: "Now-calling screen. A big-screen mode on
// a staff device, like Ask's big screen. It shows booking numbers only ('Desk 1: #23'), so the crowd waits without
// asking."; migration 20261118220500). A desk calls a booking (the booking's menu, or Call next in the header's tools) as a
// broadcast on the private topic staff-desk; /bookings/screen shows each desk's latest number large and the ones called
// before. Invented riders only.

const DAY = '2026-11-15';
const SESSION = { id: DAY, session_date: DAY, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"18:30 - 21:00"}' }; // tonight, not over at 18:00
const row = (id: string, n: number, name: string, x: Record<string, unknown> = {}) => ({
  id, session_id: DAY, session_day: 'Sunday', session_date: DAY, queue_num: n, name, phone: '0551234567', customer_id: null,
  group_id: null, status: 'waiting', paid: false, price: 57.5, walk_in: true, type_preference: 'Hybrid', size: 'M', height: 176,
  waiver_version: '2026-10-01', waiver_at: `${DAY}T10:00:00Z`, registered_at: `${DAY}T09:0${n % 10}:00Z`, ...x,
});
const QUEUE = [
  row('w3aaaa11', 3, 'Wait Listed', { status: 'waitlist', waitlist_num: 1 }),
  row('c5bbbb22', 5, 'Gone Rider', { status: 'cancelled' }),
  row('e7cccc33', 7, 'Rider Seven'),
  row('e8dddd44', 8, 'Rider Eight'),
  row('a9eeee55', 9, 'Rider Nine', { status: 'active', checked_in_at: `${DAY}T15:04:00Z` }),
];

async function boot(page: Page, path = '/') {
  await page.clock.setFixedTime(new Date(`${DAY}T18:00:00+03:00`));
  await stubSupabase(page, { sessions: [SESSION], queue_entries: QUEUE, bikes: [] });
  const rt = await stubRealtime(page); // after stubSupabase: this route answers the socket, and can push a broadcast
  await unlockStaff(page);
  await page.addInitScript(() => { localStorage.setItem('cq_desk_no', '2'); });
  await page.goto(path);
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  return rt;
}
// The desk's live channel (staff-desk) joined as a signed-in staff device's is, with what it sends kept for the spec.
async function joinDesk(page: Page) {
  await page.evaluate('S._staffAuthed=true;_n6bPresStart()');
  await page.waitForFunction('typeof _n6bPresCh!=="undefined"&&!!_n6bPresCh&&_n6bPresCh.state==="joined"');
  await page.evaluate('window.__qs=[];const c=_n6bPresCh,o=c.send.bind(c);c.send=m=>{window.__qs.push(m);return o(m);}');
}
const sent = (page: Page) => page.evaluate('window.__qs.filter(m=>m.type==="broadcast")') as Promise<{ type: string; event: string; payload: Record<string, unknown> }[]>;
const roster = (page: Page, name: string) => page.locator('.queue-table tbody tr, .q-card').filter({ hasText: name }).first();
async function openQueue(page: Page) {
  await page.evaluate(`setStaffTab('queue',{sid:'${DAY}'})`);
  await expect(roster(page, 'Rider Seven')).toBeVisible();
}

test.describe('@staff:bookings the calling screen', () => {
  test('Call to the desk sends the booking number and this device\'s desk; the row says Called', async ({ page }) => {
    await boot(page);
    await openQueue(page);
    await joinDesk(page);
    // a rider on a bike has nothing to be called for
    await roster(page, 'Rider Nine').locator('.rq-more').click();
    await expect(page.locator('.rmt-body')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Call to the desk' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await roster(page, 'Rider Seven').locator('.rq-more').click();
    await page.getByRole('menuitem', { name: 'Call to the desk' }).click();
    await expect.poll(async () => (await sent(page)).length).toBe(1);
    const [m] = await sent(page);
    expect(m.type).toBe('broadcast');
    expect(m.event).toBe('qcl');
    expect(m.payload).toMatchObject({ sid: DAY, id: 'e7cccc33', num: '#7', desk: 2 });
    expect(Date.parse(String(m.payload.at))).toBeGreaterThan(0);
    await expect(roster(page, 'Rider Seven').locator('.qcl-pill')).toContainText('Called');
    await expect(roster(page, 'Rider Eight').locator('.qcl-pill')).toHaveCount(0);
    await expect(page.locator('#toast-container .toast.error')).toHaveCount(0); // the channel answered: nothing to say
  });

  test('Call next calls the lowest number still waiting that no desk has called, then says nobody is left', async ({ page }) => {
    await boot(page);
    await openQueue(page);
    await joinDesk(page);
    // another desk called #7 already: heard on the channel, the row says so here too
    await page.evaluate(`_qclRx({sid:'${DAY}',id:'e7cccc33',num:'#7',desk:1,at:new Date().toISOString()})`);
    await expect(roster(page, 'Rider Seven').locator('.qcl-pill')).toBeVisible();
    const more = page.locator('#tab-queue .rq-hacts .sh-more');
    await more.click();
    await page.getByRole('menuitem', { name: 'Call next' }).click();
    await expect.poll(async () => (await sent(page)).length).toBe(1);
    expect((await sent(page))[0].payload).toMatchObject({ id: 'e8dddd44', num: '#8', desk: 2 }); // not the waitlist's #3, not #5 cancelled
    await expect(roster(page, 'Rider Eight').locator('.qcl-pill')).toBeVisible();
    await more.click();
    await page.getByRole('menuitem', { name: 'Call next' }).click();
    await expect(page.locator('#toast-container')).toContainText('Nobody is waiting to be called');
    expect((await sent(page)).length).toBe(1);
  });

  test('two desks that take the same booking with Call next: the later call moves on to the next number (bug hunt 2026-11-18)', async ({ page }) => {
    await boot(page);
    await openQueue(page);
    await joinDesk(page);
    await page.evaluate(`_qclNext('${DAY}')`); // this desk (2) calls #7 at 15:00:00.000
    await expect.poll(async () => (await sent(page)).length).toBe(1);
    expect((await sent(page))[0].payload).toMatchObject({ id: 'e7cccc33', desk: 2 });
    // desk 1 called #7 a moment later: desk 1 is the one to move on, this desk keeps #7
    await page.evaluate(`_qclRx({sid:'${DAY}',id:'e7cccc33',num:'#7',desk:1,at:'${DAY}T15:00:00.300Z'})`);
    await page.waitForTimeout(200);
    expect((await sent(page)).length).toBe(1);
    // desk 3 had called #7 before this desk: this desk calls the next number
    await page.evaluate(`_qclRx({sid:'${DAY}',id:'e7cccc33',num:'#7',desk:3,at:'${DAY}T14:59:59.900Z'})`);
    await expect.poll(async () => (await sent(page)).length).toBe(2);
    expect((await sent(page))[1].payload).toMatchObject({ id: 'e8dddd44', num: '#8', desk: 2 });
  });

  test('a call taken again at another desk leaves the first desk; the screen drawn again after leaving it without Exit is filled (bug hunt 2026-11-18)', async ({ page }) => {
    await boot(page, `/bookings/screen?s=${DAY}`);
    const scr = page.locator('#qcl-page');
    await expect(scr).toBeVisible();
    await page.evaluate(`_qclRx({sid:'${DAY}',id:'e7cccc33',num:'#7',desk:1,at:'${DAY}T15:00:00.000Z'})`);
    await page.evaluate(`_qclRx({sid:'${DAY}',id:'e7cccc33',num:'#7',desk:2,at:'${DAY}T15:02:00.000Z'})`);
    await expect(scr.locator('.qcl-desk .qcl-num')).toHaveText(['#7']);
    await expect(scr.locator('.qcl-desk .qcl-dk')).toContainText('Desk 2');
    await expect(scr.locator('.qcl-list li')).toHaveCount(0);
    // Back to Bookings (no Exit), then the screen again with no call in between
    await page.evaluate(`S.queueView='bookings';renderStaffQueue()`);
    await expect(page.locator('#qcl-page')).toHaveCount(0);
    await page.evaluate(`S.queueView='screen';renderStaffQueue()`);
    await expect(page.locator('#qcl-page .qcl-exit')).toBeVisible();
    await expect(page.locator('#qcl-page .qcl-desk .qcl-num')).toHaveText(['#7']);
  });

  test('a call the live channel cannot carry is said; the row still shows it on this desk', async ({ page }) => {
    await boot(page);
    await openQueue(page); // no staff session here: the desk channel never joined
    await page.evaluate(`_qclCall('e7cccc33')`);
    await expect(page.locator('#toast-container')).toContainText('The call did not reach the screens');
    await expect(roster(page, 'Rider Seven').locator('.qcl-pill')).toBeVisible();
  });

  test('Calling screen opens the night\'s screen in a window of its own; Settings keeps the desk number', async ({ page }) => {
    await boot(page);
    await openQueue(page);
    await page.evaluate('window.__open=null;window.open=(u)=>{window.__open=u;return {opener:1};}');
    await page.locator('#tab-queue .rq-hacts .sh-more').click();
    await page.getByRole('menuitem', { name: 'Calling screen' }).click();
    await expect.poll(() => page.evaluate('window.__open')).toBe(`/bookings/screen?s=${DAY}`);
    await expect(page.locator('#qcl-page')).toHaveCount(0); // this desk stays on Bookings
    await page.evaluate(`setStaffTab('settings')`);
    await page.locator('#set-desk-no').selectOption('4');
    expect(await page.evaluate(`localStorage.getItem('cq_desk_no')`)).toBe('4');
  });

  test('the screen shows the newest call big, the one before under Called, numbers only; Exit returns to Bookings', async ({ page }) => {
    const rt = await boot(page, `/bookings/screen?s=${DAY}`);
    const scr = page.locator('#qcl-page');
    await expect(scr).toBeVisible();
    await expect(page.locator('#view-staff')).toBeHidden();
    await expect(page.locator('#topbar')).toBeHidden();
    await expect(scr.locator('.qcl-h').first()).toContainText('Now calling');
    await expect(scr.locator('.qcl-h').first()).toContainText('النداء الحالي');
    await expect(scr.locator('.qcl-num')).toHaveCount(0); // starts empty
    // a call heard on the live channel (the realtime stub pushes the broadcast the server would)
    await joinDesk(page);
    rt.broadcast('realtime:staff-desk', 'qcl', { sid: DAY, id: 'e7cccc33', num: '#7', desk: 1, at: `${DAY}T14:59:00.000Z` });
    await expect(scr.locator('.qcl-desk .qcl-num')).toHaveText(['#7']);
    await expect(scr.locator('.qcl-desk .qcl-dk')).toContainText('Desk 1');
    // the same desk calls the next one: #8 takes its place and #7 moves to Called; another desk's call stands beside it
    await page.evaluate(`_qclRx({sid:'${DAY}',id:'e8dddd44',num:'#8',desk:1,at:'${DAY}T15:00:00.000Z'})`);
    await page.evaluate(`_qclRx({sid:'${DAY}',id:'pm00aa66',num:'PM-004',desk:3,at:'${DAY}T15:01:00.000Z'})`);
    await page.evaluate(`_qclRx({sid:'2026-11-16',id:'zz00bb77',num:'#1',desk:2,at:'${DAY}T15:02:00.000Z'})`); // another night: not this screen's
    await expect(scr.locator('.qcl-desk .qcl-num')).toHaveText(['#8', 'PM-004']);
    await expect(scr.locator('.qcl-desk.qcl-new .qcl-num')).toHaveText('PM-004');
    await expect(scr.locator('.qcl-list li')).toHaveText(['#7']);
    // numbers only: nothing about a rider anywhere in the screen
    const html = await scr.innerHTML();
    for (const s of ['Rider Seven', 'Rider Eight', '0551234567', 'Hybrid', 'e7cccc33']) expect(html).not.toContain(s);
    // Sound off is remembered on the device
    await scr.locator('.qcl-snd').click();
    await expect(scr.locator('.qcl-snd')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(`localStorage.getItem('cq_qcl_snd')`)).toBe('0');
    await scr.locator('.qcl-exit').click();
    await expect(page.locator('#qcl-page')).toHaveCount(0);
    await expect(page.locator('#view-staff')).toBeVisible();
    await expect(roster(page, 'Rider Seven')).toBeVisible();
    expect(await page.evaluate('location.pathname')).toBe('/bookings');
    expect(await page.evaluate('document.body.classList.contains("qcl-mode")')).toBe(false);
  });
});
