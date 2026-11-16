import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Reserve's calendar view (the user, 2026-11-16: "add a calendar view in reserve section for customers"): step one's
// dates as a month beside the list, a mark per kind on each day that has sessions, the day's sessions under the month.

const NOW = new Date('2099-11-10T09:00:00+03:00');
const YG = '2099-11-21-yg';
const SAT = '2099-11-14-2';
const PW = '2099-11-15-pw';
const SW = '2099-11-18-sw';
const NY = '2100-01-02-2';
const comm = { status: 'open', created_at: 1, event_kind: 'community', open_to_all: false };
const yoga = {
  ...comm,
  id: YG,
  session_date: '2099-11-21',
  day: 'Saturday',
  capacity: 15,
  ride_kind: 'yoga',
  needs_approval: false,
  hide_queue: true,
  spots: 15,
  paid_ride: false,
  location: 'SILKDEER',
  bike_slots: '{"_time":"16:00 - 17:30","_total":15}',
};
const sat = {
  ...comm,
  id: SAT,
  session_date: '2099-11-14',
  day: 'Saturday',
  capacity: 120,
  ride_kind: 'saturday',
  needs_approval: true,
  hide_queue: true,
  spots: 120,
  bike_slots: '{"_time":"05:45 - 06:15"}',
};
const satNext = { ...sat, id: NY, session_date: '2100-01-02' };
const petro = {
  ...comm,
  id: PW,
  session_date: '2099-11-15',
  day: 'Sunday',
  capacity: 40,
  ride_kind: 'petromin',
  needs_approval: false,
  hide_queue: false,
  paid_ride: true,
  bike_slots: '{"_time":"19:00 - 21:00","_total":40}',
};
const swim = {
  ...comm,
  id: SW,
  session_date: '2099-11-18',
  day: 'Wednesday',
  capacity: 20,
  ride_kind: 'swim',
  needs_approval: true,
  hide_queue: true,
  spots: 20,
  bike_slots: '{"_time":"07:00 - 08:00"}',
};
const ALL = [yoga, sat, petro, swim, satNext];
const bk = (id: string, sid: string) => ({
  id,
  session_id: sid,
  session_day: 'Sunday',
  session_date: sid.slice(0, 10),
  queue_num: 1,
  name: 'Sara Haddad',
  phone: '',
  status: 'waiting',
  customer_id: 'c1',
  price: 0,
  registered_at: '2099-11-01T10:00:00Z',
});

async function boot(page: Page, rows: Record<string, unknown>[] = [], lang = '', view = '') {
  await page.clock.setFixedTime(NOW);
  if (view) await page.addInitScript((v) => localStorage.setItem('cq_reg_view', v), view);
  await stubSupabase(page, {
    sessions: ALL,
    queue_entries: rows,
    'rpc:my_bookings': rows,
    'rpc:community_member': true,
  });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/' + (lang ? `?lang=${lang}` : ''));
  await waitForSb(page);
  await page.evaluate('goLanding()');
  await page.evaluate(`selectEvent('community')`);
}
const reg = (page: Page) => page.locator('#tab-register');
const day = (page: Page, iso: string) => page.locator(`#tab-register [id="rc-d-${iso}"]`);
const row = (page: Page, id: string) => page.locator(`#tab-register [id="sc-${id}"]`);

test.describe('@customer:reserve calendar view on step one', () => {
  test('the list is the start; Calendar draws the first month with its dates, and the choice is kept on the phone', async ({
    page,
  }) => {
    await boot(page);
    await expect(row(page, YG)).toBeVisible();
    await expect(reg(page).locator('.rc-cal')).toHaveCount(0);
    const cal = reg(page).locator('#rc-v-cal');
    await expect(cal).toHaveAttribute('aria-pressed', 'false');
    await expect(reg(page).locator('#rc-v-list')).toHaveAttribute('aria-pressed', 'true');
    await expect(cal).toHaveAccessibleName('Calendar');
    await cal.click();
    await expect(cal).toHaveAttribute('aria-pressed', 'true');
    await expect(cal).toBeFocused(); // the switch keeps the focus through the repaint
    await expect(reg(page).locator('.rc-t')).toHaveText('November 2099');
    // the days with sessions are buttons, every other day a number; the first date is the one shown
    await expect(reg(page).locator('.rc-day.has')).toHaveCount(4);
    await expect(reg(page).locator('button.rc-day')).toHaveCount(4);
    await expect(reg(page).locator('.rc-day')).toHaveCount(30);
    await expect(day(page, '2099-11-14')).toHaveAttribute('aria-pressed', 'true');
    await expect(day(page, '2099-11-14')).toHaveAccessibleName(/^Saturday 14 November · /);
    await expect(reg(page).locator('.rc-day.today')).toHaveText('10'); // today has no session: a number, ringed
    await expect(reg(page).locator('span.rc-day.today')).toHaveCount(1);
    // the month starts on a Sunday column: 1 November 2099 is a Sunday, so no blank before it
    await expect(reg(page).locator('.rc-pad')).toHaveCount(0);
    // one mark per kind, in that kind's colour
    await expect(day(page, '2099-11-14').locator('.rc-marks i.ev-saturday')).toHaveCount(1);
    await expect(day(page, '2099-11-21').locator('.rc-marks i.ev-yoga')).toHaveCount(1);
    // under the month: that day's sessions alone, as the list draws them
    await expect(row(page, SAT)).toBeVisible();
    await expect(row(page, YG)).toHaveCount(0);
    await expect(row(page, PW)).toHaveCount(0);
    expect(await page.evaluate(`localStorage.getItem('cq_reg_view')`)).toBe('cal');
    await page.reload();
    await waitForSb(page);
    await page.evaluate('goLanding()');
    await page.evaluate(`selectEvent('community')`);
    await expect(reg(page).locator('.rc-cal')).toBeVisible();
    await reg(page).locator('#rc-v-list').click();
    await expect(reg(page).locator('.rc-cal')).toHaveCount(0);
    await expect(row(page, YG)).toBeVisible();
    expect(await page.evaluate(`localStorage.getItem('cq_reg_view')`)).toBe('list');
  });

  test('a day shows its sessions; a row still picks, and the picked session’s day is marked on any day', async ({ page }) => {
    await boot(page, [], '', 'cal');
    await day(page, '2099-11-21').click();
    await expect(day(page, '2099-11-21')).toHaveAttribute('aria-pressed', 'true');
    await expect(day(page, '2099-11-21')).toBeFocused();
    await expect(day(page, '2099-11-14')).toHaveAttribute('aria-pressed', 'false');
    await expect(row(page, YG)).toBeVisible();
    await expect(row(page, SAT)).toHaveCount(0);
    expect(await page.evaluate('S.selSession')).toBeFalsy(); // a day only shows
    await row(page, YG).click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(YG);
    await expect(day(page, '2099-11-21')).toHaveClass(/\bsel\b/);
    // another day: the pick stays, named by the bar, and its day keeps the ring
    await day(page, '2099-11-15').click();
    await expect(row(page, PW)).toBeVisible();
    expect(await page.evaluate('S.selSession')).toBe(YG);
    await expect(day(page, '2099-11-21')).toHaveClass(/\bsel\b/);
    await expect(reg(page).locator('.reg-foot-go')).toBeEnabled();
    // coming back to step one shows the day of the session picked
    await page.evaluate(`(()=>{S.regCalDay=null;renderRegister();})()`);
    await expect(day(page, '2099-11-21')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the arrows step to the next month that has sessions, and stop at the ends', async ({ page }) => {
    await boot(page, [], '', 'cal');
    const prev = reg(page).locator('#rc-prev'),
      next = reg(page).locator('#rc-next');
    await expect(prev).toBeDisabled();
    await expect(next).toHaveAccessibleName('Next month');
    await next.click();
    await expect(reg(page).locator('.rc-t')).toHaveText('January 2100'); // December has none
    await expect(day(page, '2100-01-02')).toHaveAttribute('aria-pressed', 'true');
    await expect(row(page, NY)).toBeVisible();
    await expect(next).toBeDisabled();
    await expect(day(page, '2100-01-02')).toBeFocused(); // its arrow went off: the focus lands on the day shown
    // 1 January 2100 is a Friday: five blanks before it
    await expect(reg(page).locator('.rc-pad')).toHaveCount(5);
    await prev.click();
    await expect(reg(page).locator('.rc-t')).toHaveText('November 2099');
    await expect(day(page, '2099-11-14')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the kind switch narrows the month; the rider’s own booking is marked; the keys move along the dates', async ({
    page,
  }) => {
    await boot(page, [bk('p', PW)], '', 'cal');
    await expect(day(page, '2099-11-15')).toHaveClass(/\bmine\b/);
    await expect(day(page, '2099-11-15')).toHaveAccessibleName(/Booked$/);
    await expect(day(page, '2099-11-14')).not.toHaveClass(/\bmine\b/);
    await reg(page).locator('.reg-kind.ev-swim').click();
    await expect(reg(page).locator('.rc-day.has')).toHaveCount(1);
    await expect(day(page, '2099-11-18')).toHaveAttribute('aria-pressed', 'true'); // the day tapped before has no swim
    await expect(row(page, SW)).toBeVisible();
    await reg(page).locator('.reg-kind').first().click(); // All
    await day(page, '2099-11-14').focus();
    await page.keyboard.press('ArrowRight');
    await expect(day(page, '2099-11-15')).toBeFocused();
    await page.keyboard.press('ArrowDown'); // a week on from the 15th: no date on or after the 22nd this month, so it stays
    await expect(day(page, '2099-11-15')).toBeFocused();
    await page.keyboard.press('End');
    await expect(day(page, '2099-11-21')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(day(page, '2099-11-14')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(day(page, '2099-11-14')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('PageDown');
    await expect(reg(page).locator('.rc-t')).toHaveText('January 2100');
  });

  test('in Arabic the month reads right to left in Arabic words, its arrows turned round', async ({ page }) => {
    await boot(page, [], 'ar', 'cal');
    await expect(reg(page).locator('.rc-t')).toHaveText(/نوفمبر/);
    await expect(reg(page).locator('#rc-v-cal')).toHaveAccessibleName('تقويم');
    await expect(reg(page).locator('#rc-v-list')).toHaveAccessibleName('قائمة');
    await expect(reg(page).locator('#rc-next')).toHaveAccessibleName('الشهر التالي');
    const x = await page.evaluate(`(()=>{const a=document.querySelector('[id="rc-d-2099-11-14"]').getBoundingClientRect(),b=document.querySelector('[id="rc-d-2099-11-15"]').getBoundingClientRect();return[a.left,b.left];})()`) as number[];
    expect(x[1]).toBeGreaterThan(x[0]); // Sunday the 15th starts a week, on the right; Saturday the 14th ends one, on the left
    await day(page, '2099-11-15').focus();
    await page.keyboard.press('ArrowLeft'); // later, in a right-to-left month
    await expect(day(page, '2099-11-18')).toBeFocused();
  });

  test('the month fits a phone: seven columns, days a finger can take, no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await boot(page, [], '', 'cal');
    const m = (await page.evaluate(`(()=>{const d=[...document.querySelectorAll('#rc-grid .rc-day.has')].map(e=>e.getBoundingClientRect());const g=document.getElementById('rc-grid').getBoundingClientRect();
      return{w:Math.min(...d.map(r=>r.width)),h:Math.min(...d.map(r=>r.height)),right:g.right,doc:document.documentElement.scrollWidth,vw:innerWidth};})()`)) as Record<string, number>;
    expect(m.w).toBeGreaterThanOrEqual(38);
    expect(m.h).toBeGreaterThanOrEqual(44);
    expect(m.right).toBeLessThanOrEqual(m.vw);
    expect(m.doc).toBeLessThanOrEqual(m.vw);
    const sw = (await page.evaluate(`(()=>{const v=document.querySelector('#tab-register .rc-views').getBoundingClientRect();return[v.right,innerWidth];})()`)) as number[];
    expect(sw[0]).toBeLessThanOrEqual(sw[1]);
  });

  test('a date that stands alone carries no switch', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, { sessions: [yoga], queue_entries: [], 'rpc:my_bookings': [], 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.addInitScript(() => localStorage.setItem('cq_reg_view', 'cal'));
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
    await page.evaluate(`selectEvent('community')`);
    await expect(reg(page).locator('.page-title').first()).toBeVisible();
    await expect(reg(page).locator('.rc-views')).toHaveCount(0);
    await expect(reg(page).locator('.rc-cal')).toHaveCount(0);
  });
});
