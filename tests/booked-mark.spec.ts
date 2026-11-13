import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// A date the rider already holds says so on its row and on its Featured card, and a list's day headings say this year's
// dates without the year (the user's picks from the Featured follow-ups, 2026-11-13: "do 4 6 7"; 6, the kind switch,
// was on the list already and is checked here beside the mark).

const NOW = new Date('2099-11-10T09:00:00+03:00');
const YG = '2099-11-21-yg';
const SAT = '2099-11-14-2';
const PW = '2099-11-15-pw';
const SW = '2099-11-18-sw';
const JCC = '2099-11-17';
const JCC2 = '2099-11-19';
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
const jcc = {
  id: JCC,
  session_date: '2099-11-17',
  day: 'Tuesday',
  status: 'open',
  capacity: 40,
  created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":40}',
};
const jcc2 = { ...jcc, id: JCC2, session_date: '2099-11-19', day: 'Thursday', status: 'full' };
const bk = (id: string, sid: string, x: Record<string, unknown> = {}) => ({
  id,
  session_id: sid,
  session_day: 'Saturday',
  session_date: sid.slice(0, 10),
  queue_num: 1,
  name: 'Sara Haddad',
  phone: '',
  status: 'waiting',
  customer_id: 'c1',
  price: 0,
  registered_at: '2099-11-01T10:00:00Z',
  ...x,
});

async function custBoot(
  page: Page,
  sessions: Record<string, unknown>[],
  rows: Record<string, unknown>[],
  lang = '',
) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, {
    sessions,
    queue_entries: rows,
    'rpc:my_bookings': rows,
    'rpc:community_member': true,
  });
  await loginCustomer(page, {
    id: 'c1',
    name: 'Sara Haddad',
    email: 'sara@example.com',
    birth_date: '1995-05-05',
  });
  await page.goto('/' + (lang ? `?lang=${lang}` : ''));
  await waitForSb(page);
  await page.evaluate('goLanding()');
}
const row = (page: Page, id: string) => page.locator(`#tab-register [id="sc-${id}"]`);
const held = (page: Page, id: string) => row(page, id).locator('.spots-held');

test.describe('@customer:booked-mark a date the rider holds, and the day headings', () => {
  test('the rule: Booked, On the waitlist, and Reserved on a ride staff approve until its list says otherwise', async ({
    page,
  }) => {
    await custBoot(page, [yoga, sat, petro, swim, jcc], []);
    const st = (sess: Record<string, unknown>, rows: Record<string, unknown>[]) =>
      page.evaluate(
        `(()=>{S.queue=${JSON.stringify(rows)}.map(entryFromDB);return _heldSt(${JSON.stringify(sess)});})()`,
      );
    // nothing of theirs on it, another account's place, or a place that is over
    expect(await st(jcc, [])).toBe('');
    expect(await st(jcc, [bk('a', JCC, { customer_id: 'c2' })])).toBe('');
    expect(
      await st(jcc, [
        bk('a', JCC, { status: 'cancelled' }),
        bk('b', JCC, { status: 'done' }),
        bk('c', JCC, { status: 'noshow' }),
        bk('d', JCC, { status: 'removed' }),
      ]),
    ).toBe('');
    // a ride booked as it is made
    expect(await st(jcc, [bk('a', JCC)])).toBe('ok');
    expect(await st(jcc, [bk('a', JCC, { status: 'active' })])).toBe('ok');
    expect(await st(jcc, [bk('a', JCC, { status: 'waitlist' })])).toBe('wl');
    expect(await st(jcc, [bk('a', JCC), bk('b', JCC, { status: 'waitlist', queue_num: 2 })])).toBe('ok'); // one of the party is seated
    expect(await st(yoga, [bk('a', YG)])).toBe('ok');
    // a ride staff approve: reserved until the list is out, whatever staff have marked so far
    expect(await st(sat, [bk('a', SAT)])).toBe('rsv');
    expect(await st(sat, [bk('a', SAT, { approval: 'approved' })])).toBe('rsv');
    expect(await st(sat, [bk('a', SAT, { status: 'waitlist' })])).toBe('rsv');
    const out = { ...sat, hide_queue: false };
    expect(await st(out, [bk('a', SAT, { approval: 'approved' })])).toBe('ok');
    expect(await st(out, [bk('a', SAT)])).toBe('rsv');
    expect(await st(out, [bk('a', SAT, { status: 'waitlist' })])).toBe('wl');
    expect(await st(out, [bk('a', SAT, { approval: 'approved' }), bk('b', SAT, { queue_num: 2 })])).toBe(
      'rsv',
    ); // one rider of the party not approved yet
    expect(await st(sat, [bk('a', SAT, { partner: 'acme' })])).toBe('ok'); // a partner's place is confirmed as it is made
    expect(await st(sat, [bk('a', SAT, { status: 'active' })])).toBe('ok'); // checked in
    // nobody signed in
    expect(
      await page.evaluate(
        `(()=>{S.queue=[${JSON.stringify(bk('a', JCC))}].map(entryFromDB);const k=S.loggedIn;S.loggedIn={};const r=_heldSt(${JSON.stringify(jcc)});S.loggedIn=k;return r;})()`,
      ),
    ).toBe('');
  });

  test('in a list of dates the held ones say so where their places would be said; the others read as before', async ({
    page,
  }) => {
    const rows = [bk('y', YG), bk('s', SAT), bk('p', PW, { status: 'waitlist' })];
    await custBoot(page, [yoga, sat, { ...petro, status: 'full' }, { ...swim, status: 'full' }], rows);
    await page.evaluate(`selectEvent('community')`);
    await expect(row(page, YG)).toBeVisible();
    // yoga, on its own card: Booked with the tick, in the foot beside who leads it
    await expect(held(page, YG)).toHaveText('Booked');
    await expect(held(page, YG)).toHaveAttribute('data-held', 'ok');
    await expect(held(page, YG).locator('svg')).toHaveCount(1);
    await expect(row(page, YG).locator('.yg-card-foot .spots-held')).toHaveCount(1);
    // the Saturday ride, whose list is not out: Reserved, no tick
    await expect(held(page, SAT)).toHaveText('Reserved');
    await expect(held(page, SAT).locator('svg')).toHaveCount(0);
    // a full night they wait on: their own state, not the night's
    await expect(held(page, PW)).toHaveText('On the waitlist');
    await expect(row(page, PW).locator('.spots-red')).toHaveCount(0);
    // a full date they do not hold still says Waitlist, and carries no mark
    await expect(held(page, SW)).toHaveCount(0);
    await expect(row(page, SW).locator('.spots-red')).toHaveText('Waitlist');
    // the mark is part of what the row's radio says, and the row is still picked by a tap
    await expect(row(page, YG)).toContainText('Booked');
    await row(page, YG).click();
    await expect.poll(() => page.evaluate('S.selSession')).toBe(YG);
    await expect(held(page, YG)).toHaveText('Booked');
    // the state is drawn: green for Booked, amber for the two not settled, each readable and with room before it
    const look =
      (await page.evaluate(`(()=>{const c=(id)=>{const e=document.querySelector('[id="sc-'+id+'"] .spots-held'),r=e.getBoundingClientRect(),p=e.previousElementSibling&&e.previousElementSibling.getBoundingClientRect();
      return{col:getComputedStyle(e).color,w:r.width,h:r.height,gap:p?Math.max(r.left-p.right,p.left-r.right):99};};return{y:c(${JSON.stringify(YG)}),s:c(${JSON.stringify(SAT)}),p:c(${JSON.stringify(PW)})};})()`)) as Record<
        string,
        { col: string; w: number; h: number; gap: number }
      >;
    expect(look.y.col).toBe('rgb(6, 96, 59)');
    expect(look.s.col).toBe(look.p.col);
    expect(look.s.col).not.toBe(look.y.col);
    for (const k of ['y', 's', 'p']) {
      expect(look[k].w).toBeGreaterThan(30);
      expect(look[k].h).toBeGreaterThan(10);
    }
  });

  test('the kind switch narrows the rows and a held date keeps its mark under it', async ({ page }) => {
    await custBoot(page, [yoga, sat, petro, swim], [bk('s', SAT), bk('y', YG)]);
    await page.evaluate(`selectEvent('community')`);
    const kinds = page.locator('#tab-register .reg-kinds .reg-kind');
    await expect(kinds).toHaveText(['All', 'Saturday', 'Pool', 'Petromin', 'Hatha Yoga for Cyclists']);
    await kinds.nth(1).click();
    await expect(page.locator('#tab-register .session-cards-grid .sess-card')).toHaveCount(1);
    await expect(held(page, SAT)).toHaveText('Reserved');
    await kinds.nth(4).click();
    await expect(page.locator('#tab-register .session-cards-grid .sess-card')).toHaveCount(1);
    await expect(held(page, YG)).toHaveText('Booked');
    await kinds.nth(0).click();
    await expect(page.locator('#tab-register .session-cards-grid .sess-card')).toHaveCount(4);
  });

  test('the circuit list says it too, and a turned-down rider keeps that note', async ({ page }) => {
    await custBoot(
      page,
      [jcc, jcc2, { ...sat, hide_queue: false }],
      [
        bk('j', JCC2, { session_day: 'Thursday' }),
        bk('s', SAT, { status: 'cancelled', cancelled_by: 'staff', approval: 'rejected' }),
      ],
    ); // turned down: staff's cancel with the verdict (the publish's own write)
    await page.evaluate(`selectEvent('jcc')`);
    await expect(row(page, JCC)).toBeVisible();
    await expect(held(page, JCC)).toHaveCount(0);
    await expect(held(page, JCC2)).toHaveText('Booked'); // the night is full; their place on it is what the row says
    await expect(row(page, JCC2).locator('.spots-red')).toHaveCount(0);
    await page.evaluate(`selectEvent('community')`);
    await expect(row(page, SAT).locator('.spots-rej')).toHaveCount(1);
    await expect(held(page, SAT)).toHaveCount(0);
  });

  test('a Featured card on the event picker says it in place of its places', async ({ page }) => {
    await custBoot(page, [{ ...yoga, status: 'full' }, sat, jcc], [bk('y', YG)]);
    const card = page.locator(`#land-events .feat-card[data-feat="${YG}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('.spots-held')).toHaveText('Booked');
    await expect(card.locator('.spots-held svg')).toHaveCount(1);
    await expect(card.locator('.spots-red')).toHaveCount(0);
    // it stands off the words before it, and nothing on the card is cut
    const fit = await card.evaluate((c) => {
      const h = c.querySelector('.spots-held') as HTMLElement,
        p = h.previousElementSibling as HTMLElement | null,
        r = h.getBoundingClientRect(),
        cr = c.getBoundingClientRect();
      const pr = p ? p.getBoundingClientRect() : null;
      return {
        inside: r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5,
        gap: pr && Math.abs(pr.top - r.top) < 4 ? Math.max(r.left - pr.right, pr.left - r.right) : 99,
      };
    });
    expect(fit.inside).toBe(true);
    expect(fit.gap).toBeGreaterThanOrEqual(8);
    // without a place of theirs the card says what the date says
    await page.evaluate(`S.queue=[];renderLandingAvail()`);
    await expect(card.locator('.spots-held')).toHaveCount(0);
    await expect(card.locator('.spots-red')).toHaveText('Waitlist');
  });

  test('a date not open to book yet that staff already put them on says both', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    const rows = [bk('j', JCC2, { session_day: 'Thursday' })];
    await stubSupabase(page, {
      sessions: [jcc, { ...jcc2, status: 'open' }],
      queue_entries: rows,
      'rpc:my_bookings': rows,
      site_content: [{ key: 'booking.window', value: { days: 8, at: '20:00' } }],
    });
    await loginCustomer(page, {
      id: 'c1',
      name: 'Sara Haddad',
      email: 'sara@example.com',
      birth_date: '1995-05-05',
    });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`selectEvent('jcc')`);
    await page.waitForFunction(`S._bw&&S._bw.days===8`);
    await page.evaluate(`renderRegister()`);
    const soon = page.locator(`#tab-register .sess-card-soon[data-session="${JCC2}"]`);
    await expect(soon).toBeVisible();
    await expect(soon.locator('.spots-held')).toHaveText('Booked');
    await expect(soon.locator('.spots-soon')).toContainText('Booking opens');
  });

  test("the day headings: this year's dates without the year, another year's with it", async ({ page }) => {
    await custBoot(page, [sat, petro, satNext], []);
    await page.evaluate(`selectEvent('community')`);
    const heads = page.locator('#tab-register .sess-day-h');
    await expect(heads).toHaveText(['Saturday · 14 Nov', 'Sunday · 15 Nov', 'Saturday · 2 Jan 2100']);
    // Today and Tomorrow are still said in words before the day
    await page.clock.setFixedTime(new Date('2099-11-14T03:00:00+03:00'));
    await page.evaluate(`renderRegister()`);
    await expect(heads.nth(0)).toHaveText('Today · Saturday · 14 Nov');
    await expect(heads.nth(1)).toHaveText('Tomorrow · Sunday · 15 Nov');
    expect(
      await page.evaluate(
        `[_dayNoYear('2099-12-31'),_dayNoYear('2100-01-01'),_dayNoYear('2098-12-31'),_dayNoYear(''),_dayNoYear('2099-11-21-yg')]`,
      ),
    ).toEqual(['31 Dec', '1 Jan 2100', '31 Dec 2098', '', '21 Nov']);
  });

  test('in Arabic: the words and the heading, and the page does not scroll sideways on a narrow phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await custBoot(
      page,
      [yoga, sat, petro],
      [bk('y', YG), bk('s', SAT), bk('p', PW, { status: 'waitlist' })],
      'ar',
    );
    await expect(page.locator(`#land-events .feat-card[data-feat="${YG}"] .spots-held`)).toHaveText('محجوز');
    await page.evaluate(`selectEvent('community')`);
    await expect(held(page, YG)).toHaveText('محجوز');
    await expect(held(page, PW)).toHaveText('على قائمة الانتظار');
    const h = await page.locator('#tab-register .sess-day-h').first().innerText();
    expect(h).not.toMatch(/2099|٢٠٩٩/);
    const wide = await page.evaluate(
      `document.documentElement.scrollWidth-document.documentElement.clientWidth`,
    );
    expect(wide).toBeLessThanOrEqual(0);
    // no mark runs out of its card
    const out = await page.evaluate(
      `[...document.querySelectorAll('#tab-register .spots-held')].filter(e=>{const r=e.getBoundingClientRect(),c=e.closest('.sess-card').getBoundingClientRect();return r.left<c.left-0.5||r.right>c.right+0.5;}).length`,
    );
    expect(out).toBe(0);
  });
});
