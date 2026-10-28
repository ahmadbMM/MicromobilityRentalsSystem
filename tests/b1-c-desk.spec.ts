import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The staff review's first batch, desk part (2026-10-28):
// P04 the check-in panel keeps Close and Confirm on screen (a sticky footer inside the dialog, the Saturday
//     footer too) and draws the chosen outcome pressed, with a tick, never filled like Confirm;
// P05 search: a booking number matches phones only from 4 digits and puts the number typed in full first with its
//     party; one fold (Arabic digits, hamza, taa marbuta, alef maqsura, marks, tatweel, accents) in the roster, the
//     number test, Accounts, Add rider and Ctrl K; a search that finds nobody says where the rider is; Enter opens
//     the one rider or party left; the account search finds the WhatsApp number and the Instagram handle;
// P06 fares: the walk-in's first rider, Edit booking's added riders and Add group pick a bike type (or take the
//     account's own), never Any unasked; Add group's names are letters and spaces, blank rows "Guest of".

const ksaDay = (n = 0) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10); // UTC+3 arithmetic
const TODAY = ksaDay(0), D1 = ksaDay(1), D2 = ksaDay(2), D3 = ksaDay(3);
const ar = (...c: number[]) => String.fromCharCode(...c);
const TATWEEL = ar(0x0640);
const MUHAMMAD_MARKED = ar(0x0645, 0x064f, 0x062d, 0x064e, 0x0645, 0x0651, 0x064e, 0x062f); // with damma, fatha, shadda

const jcc = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, day: 'Sunday', session_date: date, capacity: 40, status: 'open', created_at: 1, location: 'JCC',
  bike_slots: '{"_time":"21:00 - 23:00","_total":40}', ...over,
});
const bk = (id: string, sid: string, date: string, n: number, over: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: date, queue_num: n, name: `Rider ${id}`,
  phone: `05500000${String(n).padStart(2, '0')}`, customer_id: null, type_preference: 'Road', size: 'M', height: 178,
  status: 'waiting', paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z', ...over,
});
const bike = (n: number, type = 'Road', size = 'M') => ({ id: `bk${n}`, name: `R-${String(n).padStart(2, '0')}`, bike_number: n, type, size, status: 'available', colors: [] });

async function boot(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, { bikes: [], queue_entries: [], customers: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0');
}
/** Every booking row the page inserts (a walk-in sends its party as one array, Edit booking one row at a time). */
function inserts(page: Page) {
  const rows: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/rest\/v1\/queue_entries(\?|$)/.test(r.url())) {
      const b = r.postDataJSON();
      rows.push(...(Array.isArray(b) ? b : [b]));
    }
  });
  return rows;
}

test.describe('@staff:bookings b1-c check-in panel (2026-10-28)', () => {
  // The panel slides in: measure once its entry animation is over.
  const settled = (page: Page) => page.locator('#checkin-modal .modal-box').evaluate((b) => Promise.all(b.getAnimations().map((a) => a.finished)).then(() => true));
  // Is Confirm on screen, inside the panel's visible box, and the topmost thing at its centre?
  const geo = (page: Page) => page.evaluate(`(()=>{
    const b=document.querySelector('#checkin-modal .modal-box'),f=b.querySelector(':scope>.modal-footer'),c=document.getElementById('ci-confirm');
    const x=b.getBoundingClientRect(),r=c.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return{scrolls:b.scrollHeight>b.clientHeight+4,pos:getComputedStyle(f).position,bg:getComputedStyle(f).backgroundColor,
      seen:r.top>=x.top-1&&r.bottom<=x.bottom+1&&r.top>=0&&r.bottom<=innerHeight,top:!!hit&&(hit===c||c.contains(hit))};
  })()`) as Promise<{ scrolls: boolean; pos: string; bg: string; seen: boolean; top: boolean }>;

  for (const vp of [{ width: 360, height: 740 }, { width: 390, height: 844 }]) {
    test(`Close and Confirm stay on screen on a ${vp.width}x${vp.height} phone while the panel scrolls under them`, async ({ page }) => {
      await page.setViewportSize(vp);
      // a party of three with a desk note and bikes to suggest: the longest panel the desk draws
      const q = [bk('p1', 's1', D1, 1, { group_id: 'g1', desk_note: 'Left an ID at the booth' }), bk('p2', 's1', D1, 2, { group_id: 'g1' }), bk('p3', 's1', D1, 3, { group_id: 'g1' })];
      await boot(page, { sessions: [jcc('s1', D1)], queue_entries: q, bikes: [bike(1), bike(2), bike(3), bike(4)] });
      await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('s1');showCheckinModal('p1')`);
      await expect(page.locator('#checkin-modal #ci-confirm')).toBeVisible();
      await expect(page.locator('#checkin-modal .ci-dnote')).toBeVisible();
      await expect(page.locator('#checkin-modal .bk-sugg')).toBeVisible();           // the suggested bikes are drawn
      await settled(page);
      let g = await geo(page);
      expect(g.scrolls).toBe(true);                        // the panel is taller than the screen
      expect(g.pos).toBe('sticky');
      expect(g.bg).not.toBe('rgba(0, 0, 0, 0)');           // the card's own colour: nothing shows through
      expect(g.seen && g.top).toBe(true);                  // on screen without scrolling to it
      for (const at of [0.5, 1]) {
        await page.locator('#checkin-modal .modal-box').evaluate((b, k) => { b.scrollTop = b.scrollHeight * k; }, at);
        g = await geo(page);
        expect(g.seen && g.top).toBe(true);
      }
      // the Close beside it too
      const close = await page.locator('#checkin-modal .modal-footer .btn-secondary').evaluate((c) => {
        const r = c.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0;
      });
      expect(close).toBe(true);
    });
  }

  test('the side panel on a desk keeps Confirm at its foot as well', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 700 });
    const q = [bk('p1', 's1', D1, 1, { group_id: 'g1', desk_note: 'Pays on return' }), bk('p2', 's1', D1, 2, { group_id: 'g1' }), bk('p3', 's1', D1, 3, { group_id: 'g1' })];
    await boot(page, { sessions: [jcc('s1', D1)], queue_entries: q, bikes: [bike(1), bike(2), bike(3)] });
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('s1');showCheckinModal('p1')`);
    await expect(page.locator('#checkin-modal #ci-confirm')).toBeVisible();
    await settled(page);
    const g = await geo(page);
    expect(g.pos).toBe('sticky');
    expect(g.seen && g.top).toBe(true);
  });

  test('the Saturday check-in keeps its three buttons on screen too', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const sat = { id: 'sat1', session_date: D2, day: 'Saturday', status: 'open', capacity: 30, created_at: 1, event_kind: 'community',
      ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false, spots: 30, bike_slots: '{"_time":"05:45 - 06:15"}' };
    const rows = [1, 2, 3].map((n) => bk(`a${n}`, 'sat1', D2, n, { customer_id: 'c-sat', approval: 'approved', price: 0 }));
    await boot(page, { sessions: [sat], queue_entries: rows });
    await page.evaluate(`showCheckinModal('a1')`);
    const foot = page.locator('#checkin-modal .ci-sat-foot');
    await expect(foot.locator('button')).toHaveCount(3);
    await expect(foot).toHaveCSS('position', 'sticky');
    await settled(page);
    const seen = await foot.locator('#ci-confirm').evaluate((c) => {
      const r = c.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.bottom <= innerHeight && r.top >= 0 && !!hit && (hit === c || c.contains(hit));
    });
    expect(seen).toBe(true);
  });

  test('the chosen outcome is drawn pressed with a tick, never filled like Confirm', async ({ page }) => {
    await boot(page, { sessions: [jcc('s1', D1)], queue_entries: [bk('e1', 's1', D1, 7, { name: 'Quick Rider' })] });
    await page.evaluate(`showCheckinModal('e1')`);
    const out = (v: string) => page.locator(`#checkin-modal #ci-out-${v}`);
    await expect(out('checkin')).toHaveAttribute('aria-checked', 'true');
    await expect(out('checkin').locator('svg')).toHaveCount(1);          // the tick
    await expect(out('waiting').locator('svg')).toHaveCount(0);
    const look = (sel: string) => page.locator(sel).evaluate((e) => {
      const s = getComputedStyle(e);
      return { bg: s.backgroundColor, border: s.borderTopColor, color: s.color, bw: parseFloat(s.borderTopWidth), shadow: s.boxShadow };
    });
    const on = await look('#ci-out-checkin'), off = await look('#ci-out-waiting'), confirm = await look('#ci-confirm');
    expect(on.bg).not.toBe(on.border);        // a light wash, not its colour poured in
    expect(on.color).toBe(on.border);         // its words in its own colour, not white on a fill
    expect(on.bg).not.toBe(confirm.bg);       // and never the action's fill
    expect(on.bw).toBeGreaterThan(off.bw);    // a thicker outline than the ones not chosen
    expect(on.shadow).toContain('inset');     // sunk, as a pressed key
    await out('noshow').click();
    await expect(out('noshow')).toHaveAttribute('aria-checked', 'true');
    await expect(out('noshow').locator('svg')).toHaveCount(1);
    await expect(out('checkin')).toHaveAttribute('aria-checked', 'false');
    await expect(out('checkin').locator('svg')).toHaveCount(0);
  });
});

test.describe('@staff:bookings b1-c search (2026-10-28)', () => {
  test('a booking number matches phones only from 4 digits, and the number typed in full comes first with its party', async ({ page }) => {
    const q = [
      bk('b', 's1', D1, 3, { name: 'Phone Holder', phone: '0599994242' }), // "42" sits in the phone
      bk('c', 's1', D1, 420, { name: 'Aaron Four Twenty' }),
      bk('d', 's1', D1, 42, { name: 'Zed Forty Two', group_id: 'g42' }),
      bk('e', 's1', D1, 43, { name: 'Zed Party Mate', group_id: 'g42' }),
      bk('f', 's1', D1, 1, { name: 'First Rider' }),
    ];
    await boot(page, { sessions: [jcc('s1', D1)], queue_entries: q });
    const hits = (s: string) => page.evaluate(`getQueue().filter(e=>_searchHit(e,${JSON.stringify(s)})).map(e=>e.id).sort()`);
    expect(await hits('42')).toEqual(['c', 'd']);           // #42 and #420, not the phone holding 42
    expect(await hits('4242')).toEqual(['b']);              // four digits: a phone
    expect(await hits(ar(0x0664, 0x0662))).toEqual(['c', 'd']); // ٤٢ on an Arabic keyboard is the same number
    expect(await hits(ar(0x06f4, 0x06f2))).toEqual(['c', 'd']); // and the Persian digits
    // sorted by name, #420 Aaron would lead: the number typed in full goes first, with its party
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('s1');S.sfSort='name';S.sfSortDir=1;setSfSearch('42')`);
    await expect.poll(() => page.evaluate('S._qOrder')).toEqual(['d', 'e', 'c']);
    await page.evaluate(`setSfSearch('Zed')`);              // a name keeps the chosen sort
    await expect.poll(() => page.evaluate('S._qOrder')).toEqual(['d', 'e']);
  });

  test('one fold for names: hamza, taa marbuta, alef maqsura, marks, tatweel and Latin accents, on both sides', async ({ page }) => {
    const names = { a1: 'أحمد العلي', a2: 'فاطمة سعيد', a3: 'مصطفى كمال', a4: 'José Núñez', a5: 'عبد' + TATWEEL + 'الله', a6: MUHAMMAD_MARKED + ' علي' };
    const q = Object.entries(names).map(([id, name], i) => bk(id, 's1', D1, i + 1, { name }));
    await boot(page, { sessions: [jcc('s1', D1)], queue_entries: q });
    const hit = (s: string) => page.evaluate(`getQueue().filter(e=>_searchHit(e,${JSON.stringify(s)})).map(e=>e.id).sort()`);
    expect(await hit('احمد')).toEqual(['a1']);
    expect(await hit('أحمد')).toEqual(['a1']);
    expect(await hit('فاطمه')).toEqual(['a2']);
    expect(await hit('مصطفي')).toEqual(['a3']);
    expect(await hit('jose nunez')).toEqual(['a4']);
    expect(await hit('NÚÑEZ')).toEqual(['a4']);
    expect(await hit('عبدالله')).toEqual(['a5']);
    expect(await hit('محمد')).toEqual(['a6']);
    expect(await hit('عب' + TATWEEL + 'د')).toEqual(['a5']);   // a query's own tatweel goes too
    // what is stored is never touched
    expect(await page.evaluate(`getQueue().find(e=>e.id==='a1').name`)).toBe(names.a1);
    // folded once and kept: a second pass over the same names adds nothing to the memo
    const n1 = await page.evaluate(`(getQueue().forEach(e=>_searchHit(e,'zz')),_dkXF.m.size)`);
    const n2 = await page.evaluate(`(getQueue().forEach(e=>_searchHit(e,'zz')),_dkXF.m.size)`);
    expect(n2).toBe(n1);
  });

  test('Accounts, Add rider and Ctrl K fold alike and find the WhatsApp number and the Instagram handle', async ({ page }) => {
    const customers = [
      { id: 'c1', name: 'أحمد سالم', email: 'ahmed@example.com', phone: '+966551110000', whatsapp_same: false, whatsapp: '+966507778888',
        socials: { instagram: 'ahmed.rides' }, created_at: '2026-01-01T00:00:00Z' },
      { id: 'c2', name: 'Other Person', email: 'o@example.com', phone: '+966552220000', created_at: '2026-01-02T00:00:00Z' },
    ];
    await boot(page, { sessions: [jcc('s1', D1)], customers });
    // Ctrl K (the desk's core)
    const gs = (s: string) => page.evaluate(`(_gsHits(${JSON.stringify(s)})||[]).filter(h=>h.k==='gsKindAccount').map(h=>h.go[2])`);
    expect(await gs('احمد')).toEqual(['c1']);
    expect(await gs('0507778888')).toEqual(['c1']);       // the WhatsApp number, not the mobile
    expect(await gs('@ahmed.rides')).toEqual(['c1']);
    // Add rider
    const ca = (s: string) => page.evaluate(`(S._caSess='s1',S._caSearch=${JSON.stringify(s)},_caRows())`) as Promise<string>;
    expect(await ca('احمد')).toContain(customers[0].name);
    expect(await ca('احمد')).not.toContain('Other Person');
    expect(await ca('ahmed.rides')).toContain(customers[0].name);
    // Customers > Accounts (the community part)
    await page.evaluate(`setStaffTab('customers')`);
    await page.waitForFunction(`typeof _amFiltered==='function'`);
    const am = (s: string) => page.evaluate(`(S.amSearch=${JSON.stringify(s)},_amFiltered().map(c=>c.id))`);
    expect(await am('احمد')).toEqual(['c1']);
    expect(await am('0507778888')).toEqual(['c1']);
    expect(await am('٠٥٠٧٧٧٨٨٨٨')).toEqual(['c1']);       // typed on an Arabic keyboard
    expect(await am('@ahmed.rides')).toEqual(['c1']);
    expect(await am('rides')).toEqual(['c1']);
    expect(await am('person')).toEqual(['c2']);
  });

  test('a search that finds nobody names the other night the rider booked, and one tap opens it with the search kept', async ({ page }) => {
    const q = [bk('x1', 'sa', D2, 1, { name: 'Tonight Rider' }), bk('y1', 'sb', D3, 5, { name: 'Wrong Night' })];
    await boot(page, { sessions: [jcc('sa', D2), jcc('sb', D3)], queue_entries: q });
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('sa');setSfSearch('wrong night')`);
    const miss = page.locator('#tab-queue .q-miss');
    await expect(miss).toContainText('Booked on');
    await expect(miss).toContainText('#5 Wrong Night');
    await miss.getByRole('button', { name: 'Open that ride' }).click();
    await expect.poll(() => page.evaluate('S.sfSession')).toBe('sb');
    expect(await page.evaluate('S.sfSearch')).toBe('wrong night');
    await expect(page.locator('#q-results')).toContainText('Wrong Night');
    await expect(page.locator('#tab-queue .q-miss')).toHaveCount(0);
  });

  test('a search a filter hides says how many match with the filters off, and Clear filters keeps the search', async ({ page }) => {
    await boot(page, { sessions: [jcc('sa', D2)], queue_entries: [bk('x1', 'sa', D2, 1, { name: 'Waiting Rider' })] });
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('sa');S.sfStatus='active';S.sfPay='paid';setSfSearch('waiting')`);
    const miss = page.locator('#tab-queue .q-miss');
    await expect(miss).toContainText('Matches with the filters off: 1');
    await expect(miss).not.toContainText('Booked on');
    await miss.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('#q-results')).toContainText('Waiting Rider');
    expect(await page.evaluate('[S.sfStatus,S.sfPay,S.sfSearch]')).toEqual(['all', 'all', 'waiting']);
  });

  test('Enter opens the check-in when the search leaves one rider, or one party, still expected', async ({ page }) => {
    const q = [
      bk('n1', 'st', TODAY, 1, { name: 'Nadia Solo', phone: '0551230001' }),
      bk('n2', 'st', TODAY, 2, { name: 'Omar Party', group_id: 'gp' }),
      bk('n3', 'st', TODAY, 3, { name: 'Omar Friend', group_id: 'gp' }),
      bk('n4', 'st', TODAY, 4, { name: 'Sami One' }),
      bk('n5', 'st', TODAY, 5, { name: 'Sami Two' }),
      bk('n6', 'st', TODAY, 6, { name: 'Done Rider', status: 'done' }),
    ];
    await boot(page, { sessions: [jcc('st', TODAY)], queue_entries: q });
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('st')`);
    // typed and Enter at once: the search's repaint has not run yet when Enter lands
    const enter = async (s: string) => {
      await page.evaluate(`closeCheckinModal();setSfSearch(${JSON.stringify(s)});sfSearchEnter()`);
      await page.waitForTimeout(150);
      return page.evaluate('S._ciId||null');
    };
    expect(await enter('nadia')).toBe('n1');
    expect(await enter('omar party')).toBe('n2');                  // the party: its first rider, the others as steps
    await expect(page.locator('#checkin-modal .bkm-steps li')).toHaveCount(2);
    expect(await enter('sami')).toBeNull();                        // two riders: nothing opens
    expect(await enter('done rider')).toBeNull();                  // nobody still expected
    expect(await enter('1230001')).toBe('n1');                      // a phone, from 4 digits
    expect(await enter(ar(0x0660, 0x0665, 0x0665, 0x0661, 0x0662, 0x0663, 0x0660, 0x0660, 0x0660, 0x0661))).toBe('n1'); // ٠٥٥١٢٣٠٠٠١
    expect(await enter(ar(0x0664))).toBe('n4');                    // ٤ = booking #4, the number rule
    expect(await enter('5')).toBe('n5');
  });
});

test.describe('@staff:bookings b1-c fares (2026-10-28)', () => {
  test('the walk-in opens with no type pressed, asks for one, and books the one tapped', async ({ page }) => {
    await boot(page, { sessions: [jcc('s1', D1)] });
    const rows = inserts(page);
    await page.evaluate('showWalkinModal()');
    const m = page.locator('#walkin-modal');
    await expect(m.locator('[data-wi-type]').first()).toBeVisible();
    await expect(m.locator('[data-wi-type][aria-pressed="true"]')).toHaveCount(0);
    await m.locator('#wi-name').fill('Walk Up');
    await page.evaluate('saveWalkin()');
    await expect(m.locator('#wi-type-grp .field-err')).toContainText('Pick a bike type.');
    expect(rows.length).toBe(0);
    await m.locator('[data-wi-type="Road"]').click();
    await expect(m.locator('#wi-type-grp .field-err')).toHaveCount(0);
    await page.evaluate('saveWalkin()');
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ name: 'Walk Up', type_preference: 'Road', price: 75 });
  });

  test('Any stays a type staff can choose on purpose', async ({ page }) => {
    await boot(page, { sessions: [jcc('s1', D1)] });
    const rows = inserts(page);
    await page.evaluate('showWalkinModal()');
    const m = page.locator('#walkin-modal');
    await m.locator('#wi-name').fill('Any Walker');
    await m.locator('[data-wi-type="Any"]').click();
    await page.evaluate('saveWalkin()');
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ type_preference: 'Any', price: 57.5 });
  });

  test('a picked account brings its own type, an account on Any brings none, and a typed name that links takes its own', async ({ page }) => {
    const customers = [
      { id: 'h1', name: 'Hybrid Owner', email: '', phone: '+966551112222', height: 170, type_preference: 'Hybrid', created_at: '2026-01-01T00:00:00Z' },
      { id: 'a1', name: 'Any Owner', email: '', phone: '+966553334444', height: 170, type_preference: 'Any', created_at: '2026-01-02T00:00:00Z' },
    ];
    await boot(page, { sessions: [jcc('s1', D1)], customers });
    const rows = inserts(page);
    const m = page.locator('#walkin-modal');
    await page.evaluate(`showWalkinModal();_wiPickCust('h1')`);
    await expect(m.locator('[data-wi-type="Hybrid"]')).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate('saveWalkin()');
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ customer_id: 'h1', type_preference: 'Hybrid' });

    await expect(m).toBeHidden();
    await page.evaluate(`showWalkinModal();_wiPickCust('a1')`);
    await expect(m.locator('[data-wi-type][aria-pressed="true"]')).toHaveCount(0);   // Any is never chosen for staff
    await page.evaluate('saveWalkin()');
    await expect(m.locator('#wi-type-grp .field-err')).toBeVisible();
    expect(rows.length).toBe(1);

    await page.evaluate(`closeWalkinModal();showWalkinModal()`);
    await m.locator('#wi-name').fill('Hybrid Owner');                    // typed, not picked: the booking links by name
    await page.evaluate('_wiHideSuggest();saveWalkin()');
    await expect.poll(() => rows.length).toBe(2);
    expect(rows[1]).toMatchObject({ customer_id: 'h1', type_preference: 'Hybrid' });
  });

  test('a ride without bikes asks no type and books its seats as None', async ({ page }) => {
    const ev = jcc('ev1', D2, { day: 'Thursday', event_kind: 'community', ride_kind: 'event', needs_approval: false, hide_queue: true,
      paid_ride: true, price: 50, spots: 30, bike_slots: '{"_time":"19:00 - 21:00"}' });
    await boot(page, { sessions: [ev] });
    const rows = inserts(page);
    await page.evaluate('showWalkinModal()');
    const m = page.locator('#walkin-modal');
    await expect(m.locator('#wi-name')).toBeVisible();
    await expect(m.locator('#wi-type-grp, [data-wi-type]')).toHaveCount(0);
    await m.locator('#wi-name').fill('Seat Holder');
    await m.getByRole('button', { name: /\+ Add rider/ }).click();
    await expect(m.locator('#wi-r-name-0')).toBeVisible();
    await expect(m.locator('#wi-r-type-0')).toHaveCount(0);
    await page.evaluate('saveWalkin()');
    await expect.poll(() => rows.length).toBe(2);
    expect(rows.map((r) => r.type_preference)).toEqual(['None', 'None']);
    expect(rows.map((r) => r.name)).toEqual(['Seat Holder', 'Guest of Seat']);
  });

  test('a rider added in Edit booking picks a type, or takes the account of that name’s own', async ({ page }) => {
    const customers = [{ id: 'k1', name: 'Kid Rider', email: '', phone: '+966551119999', height: 130, type_preference: 'Kids', created_at: '2026-01-01T00:00:00Z' }];
    await boot(page, { sessions: [jcc('s1', D1)], queue_entries: [bk('e1', 's1', D1, 1, { name: 'Parent Rider' })], customers });
    const rows = inserts(page);
    const patches: unknown[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) patches.push(r.postDataJSON()); });
    await page.evaluate(`showBookingEditModal('e1')`);
    const m = page.locator('#booking-edit-modal');
    await m.getByRole('button', { name: '+ Add rider' }).click();
    await expect(m.locator('#be-nr-type-0')).toHaveValue('');                  // "Bike type…": nothing chosen
    await m.locator('#be-nr-name-0').fill('Second Rider');
    await page.evaluate('saveBookingEdit()');
    await expect(m.locator('#be-nr-type-0')).toHaveAttribute('aria-invalid', 'true');
    await expect(m).toContainText('Pick a bike type.');
    expect(rows.length).toBe(0);
    expect(patches.length).toBe(0);                                            // nothing written before it is answered
    await m.locator('#be-nr-type-0').selectOption('Road');
    // a second row named after an account takes that account's type when the name is entered
    await m.getByRole('button', { name: '+ Add rider' }).click();
    await m.locator('#be-nr-name-1').fill('Kid Rider');
    await m.locator('#be-nr-name-1').dispatchEvent('change');
    await expect(m.locator('#be-nr-type-1')).toHaveValue('Kids');
    await page.evaluate('saveBookingEdit()');
    await expect.poll(() => rows.length).toBe(2);
    expect(rows.map((r) => [r.name, r.type_preference, r.price])).toEqual([['Second Rider', 'Road', 75], ['Kid Rider', 'Kids', 57.5]]);
  });

  test('Add group: names are letters and spaces, blank rows are Guest of the contact, and every type is picked', async ({ page }) => {
    await boot(page, { sessions: [jcc('s1', D1)] });
    const rows = inserts(page);
    await page.evaluate('showJccGroupModal()');
    const m = page.locator('#jcc-group-modal');
    await m.locator('#jg-name').fill('Tamer Group');
    await m.locator('#jg-cname').fill('Ahmed Saleh');
    await expect(m.locator('#jg-r-type-0')).toHaveValue('');
    await expect(m.locator('#jg-r-type-1')).toHaveValue('');
    await page.evaluate(`document.getElementById('jg-r-name-0').value='ali-2 hassan'`); // as a paste lands, past the box's own filter
    await page.evaluate('saveJccGroup()');
    await expect(m.locator('#jg-r-type-0')).toHaveAttribute('aria-invalid', 'true');
    expect(rows.length).toBe(0);
    await m.locator('#jg-r-type-0').selectOption('Road');
    await page.evaluate('saveJccGroup()');
    await expect(m.locator('#jg-r-type-1')).toHaveAttribute('aria-invalid', 'true');
    await m.locator('#jg-r-type-1').selectOption('Any');
    await page.evaluate('saveJccGroup()');
    await expect.poll(() => rows.length).toBe(2);
    expect(rows.map((r) => r.name)).toEqual(['Ali Hassan', 'Guest of Ahmed']);
    expect(rows.map((r) => [r.type_preference, r.price])).toEqual([['Road', 75], ['Any', 57.5]]);
    expect(rows[0].group_name).toBe('Tamer Group');
  });

  test('the group editor keeps member names to letters and spaces', async ({ page }) => {
    const q = [bk('g1', 's1', D1, 1, { name: 'First Member', group_id: 'gg', group_name: 'Falcons' }), bk('g2', 's1', D1, 2, { name: 'Second Member', group_id: 'gg' })];
    await boot(page, { sessions: [jcc('s1', D1)], queue_entries: q });
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) patches.push(r.postDataJSON()); });
    await page.evaluate(`showGroupEditModal('g1')`);
    await page.evaluate(`document.getElementById('ge-r-name-1').value='Second-3 Member'`);
    await page.evaluate('saveGroupEdit()');
    await expect.poll(() => patches.length).toBe(2);
    expect(patches.map((p) => p.name)).toEqual(['First Member', 'Second Member']);
  });
});
