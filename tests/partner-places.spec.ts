import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Partner places (the owner, 2026-10-17): Defe gets places on top of the members on a Saturday ride.
// Its bookings (queue_entries.partner, made by partner_book from the website) are confirmed at once;
// members past sessions.member_cap book with their own bike; the website signs a rider in here with
// ?signin=<code>; staff see a DEFE chip, a Partner filter and a panel of the partner's places.

const SAT = '2099-01-10';
const satur = (over: Record<string, unknown> = {}) => ({
  id: SAT, session_date: SAT, day: 'Saturday', status: 'open', capacity: 150, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true,
  spots: 150, title: 'Saturday Social Ride', bike_slots: '{"_time":"06:30 - 07:00"}', member_cap: 70, ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: 'bk1', session_id: SAT, session_day: 'Saturday', session_date: SAT, queue_num: 4, name: 'Spec Rider',
  phone: '0550000001', size: 'M', type_preference: 'Hybrid', status: 'waiting', paid: false, price: 0,
  customer_id: 'c1', approval: 'pending', registered_at: '2099-01-01T10:00:00Z', ...over,
});
const qr = (p: import('@playwright/test').Page) => p.locator('#tab-myrides svg[role="img"][aria-label]:has(g[shape-rendering="crispEdges"])');

test.describe('@customer:partner partner places', () => {
  test('a Defe booking is confirmed with its code before Publish, and says who it is with', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [row({ partner: 'defe', partner_code: true, approval: 'approved' })], 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`showView('customer');setCustTab('myrides')`);
    const card = page.locator('#tab-myrides');
    await expect(card.locator('.appr-ok')).toContainText('Your place is confirmed');
    await expect(qr(page)).toHaveCount(1);
    await expect(card.locator('.qr-hold')).toHaveCount(0);
    await expect(card.locator('.ptn-line')).toHaveText('With Defe');
    expect(await page.evaluate(`_walletOk(_sessGet('${SAT}'),[getQueue().find(e=>e.id==='bk1')])`)).toBe(true);
    // a member's own booking on the same unpublished ride still waits for the list
    expect(await page.evaluate(`_walletOk(_sessGet('${SAT}'),[{...getQueue().find(e=>e.id==='bk1'),partner:null}])`)).toBe(false);
  });

  test('?signin= signs the rider in and opens My Bookings; the code leaves the address', async ({ page }) => {
    const code = 'a'.repeat(48);
    await stubSupabase(page, {
      sessions: [satur()], bikes: [], queue_entries: [row({ partner: 'defe', approval: 'approved' })],
      'rpc:customer_handoff_redeem': [{ id: 'c1', name: 'Spec Rider', session_token: 'tok-new' }],
      'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0550000001', height: 175 }],
      'rpc:customer_token_ok': true,
    });
    const redeem: unknown[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/customer_handoff_redeem')) redeem.push(r.postDataJSON()); });
    await page.goto(`/?signin=${code}&tab=bookings`);
    await waitForSb(page);
    await expect.poll(() => page.evaluate(`S.custTab`)).toBe('myrides');
    expect(redeem).toEqual([{ p_code: code }]);
    expect(await page.evaluate(`(S.loggedIn||{}).session_token`)).toBe('tok-new');
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_session')).id`)).toBe('c1');
    expect(page.url()).not.toContain('signin');
    expect(page.url()).not.toContain('tab=bookings');
    await expect(page.locator('#tab-myrides .ptn-line')).toBeVisible();
  });

  test('a spent ?signin= code changes nothing', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [] }); // redeem answers no row
    await page.goto(`/?signin=${'b'.repeat(48)}`);
    await waitForSb(page);
    expect(await page.evaluate(`!!(S.loggedIn||getSession())`)).toBe(false);
    expect(page.url()).not.toContain('signin');
  });

  test('our bikes all taken: only Own is offered, picked, with the notice', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [], 'rpc:community_member': true, 'rpc:member_bikes_open': false });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='community';goCustomer('register');S.regStep=2;selectSessCard('${SAT}')`);
    const note = page.locator('#tab-register .mb-full-note');
    await expect(note).toHaveText('Our bikes are taken for this ride. You can still join with your own bike.');
    const own = page.locator('#reg-type-wrap-0 button[data-type="Own"]');
    await expect(own).toBeEnabled();
    await expect(own).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#reg-type-wrap-0 button[data-type="Hybrid"]')).toBeDisabled();
    expect(await page.evaluate(`S.regBikeTypes[0]`)).toBe('Own');
  });

  test('our bikes taken but the members\' waitlist has room: every type stays open, with the waitlist notice', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur({ member_wl: 15 })], bikes: [], queue_entries: [], 'rpc:community_member': true, 'rpc:member_bikes_state': 'waitlist', 'rpc:member_bikes_open': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='community';goCustomer('register');S.regStep=2;selectSessCard('${SAT}')`);
    await expect(page.locator('#tab-register .mb-full-note')).toHaveText('Our bikes are taken for this ride. Choose one to join the waitlist, or come with your own bike.');
    await expect(page.locator('#reg-type-wrap-0 button[data-type="Hybrid"]')).toBeEnabled();
    await expect(page.locator('#reg-type-wrap-0 button[data-type="Own"]')).toBeEnabled();
  });

  test('member_bikes_state full: only Own, as before', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [], 'rpc:community_member': true, 'rpc:member_bikes_state': 'full' });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='community';goCustomer('register');S.regStep=2;selectSessCard('${SAT}')`);
    await expect(page.locator('#tab-register .mb-full-note')).toHaveText('Our bikes are taken for this ride. You can still join with your own bike.');
    await expect(page.locator('#reg-type-wrap-0 button[data-type="Hybrid"]')).toBeDisabled();
  });

  test('without member_bikes_open (before the migration) every type stays open', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [], 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='community';goCustomer('register');S.regStep=2;selectSessCard('${SAT}')`);
    await expect(page.locator('#reg-type-wrap-0 button[data-type="Hybrid"]')).toBeEnabled();
    await page.waitForTimeout(300);
    await expect(page.locator('#tab-register .mb-full-note')).toHaveCount(0);
  });

  test('a MEMBER_BIKES_FULL refusal says so and goes back to the bike, own bike only', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [], 'rpc:community_member': true, 'rpc:member_bikes_open': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='community';goCustomer('register');S.regStep=2;selectSessCard('${SAT}')`);
    await expect(page.locator('#reg-type-wrap-0 button[data-type="Hybrid"]')).toBeEnabled();
    await page.evaluate(`S.regStep=3;_bookRefused({code:'P0001',message:'Our bikes are taken for this ride. You can still join with your own bike.',details:'MEMBER_BIKES_FULL'},_sessGet('${SAT}'))`);
    expect(await page.evaluate('S.regStep')).toBe(2);
    await expect(page.locator('.toast').filter({ hasText: 'Our bikes are taken' }).first()).toBeVisible();
    await expect(page.locator('#reg-type-wrap-0 button[data-type="Hybrid"]')).toBeDisabled();
    await expect(page.locator('#reg-type-wrap-0 button[data-type="Own"]')).toHaveAttribute('aria-pressed', 'true');
    // staff read the same refusal with the limit
    expect(await page.evaluate(`S.view='staff';S.sfSession='${SAT}';const m=_errMessage({code:'P0001',message:'x',details:'MEMBER_BIKES_FULL'});S.view='customer';m`))
      .toBe("Members' bikes are all taken on this ride (limit 70). Add them with their own bike.");
  });
});

test.describe('@customer:badges Rode with Defe', () => {
  test('checked in on the Defe ride (2026-10-24), member or Defe rider, earns the ribbon wheel; a no-show or another ride does not', async ({ page }) => {
    await stubSupabase(page, { sessions: [satur()], bikes: [], queue_entries: [] });
    await page.goto('/');
    await waitForSb(page);
    const on = (sid: string, st: string, partner: string | null = null) => page.evaluate(([s, t, p]) =>
      (window as unknown as { _mrBadges: (a: unknown[], b: unknown[]) => { s: string; on: boolean; hide?: boolean }[] })
        ._mrBadges([{ id: 'x', sessionId: s, status: t, paid: false, partner: p }], []).find((b) => b.s === 'defe_ride'), [sid, st, partner]);
    expect(await on('2026-10-24', 'active')).toMatchObject({ on: true, hide: true });
    expect(await on('2026-10-24', 'done', 'defe')).toMatchObject({ on: true });
    expect(await on('2026-10-24', 'waiting')).toMatchObject({ on: false });
    expect(await on('2026-10-24', 'noshow')).toMatchObject({ on: false });
    expect(await on('2026-10-17', 'done')).toMatchObject({ on: false });
    const svg = await page.evaluate(`_bdgMedal('defewheel','defe')`) as string;
    expect(svg).toContain('bdg-sp');
    expect(svg).toContain('#f6c3d6');
    expect(await page.evaluate(`t('bdgDefeRide')`)).toBe('Rode with Defe');
  });
});

test.describe('@staff:bookings partner places', () => {
  const entries = [
    row({ id: 'd1', name: 'Defe Rider', customer_id: 'c2', partner: 'defe', partner_code: true, approval: 'approved', queue_num: 11 }),
    row({ id: 'd2', name: 'Defe Two', customer_id: 'c3', partner: 'defe', partner_code: false, approval: 'approved', queue_num: 12 }),
    row({ id: 'm1', name: 'Member One', customer_id: 'c4', queue_num: 1 }),
  ];
  async function boot(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
    await stubSupabase(page, { sessions: [satur()], queue_entries: entries, bikes: [], ...extra });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length>0`);
    await page.evaluate(`S.staffRole='admin';setStaffTab('queue');S.queueView='bookings';S.sfSession='${SAT}';renderStaffQueue()`);
  }

  test('the DEFE chip, the Partner filter, the number, and the panel', async ({ page }) => {
    await boot(page, { session_partners: [{ session_id: SAT, partner: 'defe', label: 'Defe', places: 80, code: 'PINK24', code_needed: true, code_limit: 40 }] });
    const tab = page.locator('#tab-queue');
    await expect(tab.locator('.ptn-chip').filter({ hasText: /^DEFE$/ }).first()).toBeVisible();
    // the panel: Defe 2 / 80, 1 by code, members 1 / 70
    const panel = tab.locator('.ptn-panel');
    await expect(panel).toContainText('Defe booked 2 / 80');
    await expect(panel).toContainText('Booked with the code: 1');
    await expect(panel).toContainText('Members booked 1 / 70 (then own bike only)');
    await expect(panel.locator('#ptn-defe-code')).toHaveValue('PINK24');
    // Save writes the partner row
    const patches: { url: string; body: unknown }[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/session_partners')) patches.push({ url: decodeURIComponent(r.url()), body: r.postDataJSON() }); });
    await panel.locator('#ptn-defe-places').fill('90');
    await panel.locator('#ptn-defe-limit').fill('');
    await panel.locator('#ptn-defe-need').uncheck();
    await panel.locator('.ptn-card[data-partner="defe"] .ptn-save').click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].body).toEqual({ places: 90, code_needed: false, code: 'PINK24', code_limit: null });
    expect(patches[0].url).toContain('partner=eq.defe');
    // the Partner filter
    await page.evaluate(`S.sfPtn='defe';renderStaffQueue()`);
    let names = await page.evaluate(`[...document.querySelectorAll('#q-results tbody tr, #q-results .q-card')].map(r=>r.innerText).join('|')`) as string;
    expect(names).toContain('Defe Rider');
    expect(names).not.toContain('Member One');
    await page.evaluate(`S.sfPtn='members';renderStaffQueue()`);
    names = await page.evaluate(`[...document.querySelectorAll('#q-results tbody tr, #q-results .q-card')].map(r=>r.innerText).join('|')`) as string;
    expect(names).toContain('Member One');
    expect(names).not.toContain('Defe Rider');
    // the partner's rows carry their number before Publish; a member's still does not
    await page.evaluate(`S.sfPtn='all';renderStaffQueue()`);
    const defeRow = await page.evaluate(`[...document.querySelectorAll('#q-results tbody tr, #q-results .q-card')].map(r=>r.innerText).find(t=>t.includes('Defe Rider'))`) as string;
    expect(defeRow).toContain('#11');
    // the report builder offers Partner, off by default
    expect(await page.evaluate(`_repDefaults().cols.ptn`)).toBe(0);
    expect(await page.evaluate(`_repColFits(_sessGet('${SAT}'),'ptn')`)).toBe(true);
  });

  test('the ribbon badge and the rose stripe mark Defe wherever staff see the booking; a member has neither', async ({ page }) => {
    await boot(page);
    const res = page.locator('#q-results');
    // the desktop draws the Bookings table, a phone the cards: whichever is on show carries the marks
    await expect(res.locator('[data-id="d1"]').first()).toBeVisible();
    const cards = (await res.locator('.q-card[data-id="d1"]').count()) > 0;
    const sel = (id: string) => (cards ? `.q-card[data-id="${id}"]` : `tbody tr[data-id="${id}"]`);
    const dRow = res.locator(sel('d1'));
    await expect(dRow).toHaveClass(/ptn-row-mark/);
    const chip = dRow.locator('.ptn-chip');
    await expect(chip).toHaveText('DEFE');
    await expect(chip.locator('svg.ptn-rb path')).toHaveCount(2);
    await expect(chip).toHaveAttribute('aria-label', 'With Defe');
    // berry on blush in the staff light theme, whatever the customer side's theme is
    expect(await chip.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color])).toEqual(['rgb(251, 228, 238)', 'rgb(162, 43, 99)']);
    // the stripe is drawn: a rose inset on the start edge (the table's first cell, the card itself)
    const edge = cards ? dRow : dRow.locator('td').first();
    expect(await edge.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('rgb(215, 130, 160)');
    // a member's has neither
    const mRow = res.locator(sel('m1'));
    await expect(mRow).toBeVisible();
    await expect(mRow).not.toHaveClass(/ptn-row-mark/);
    await expect(mRow.locator('.ptn-chip')).toHaveCount(0);
    expect(await (cards ? mRow : mRow.locator('td').first()).evaluate((el) => getComputedStyle(el).boxShadow)).not.toContain('rgb(215, 130, 160)');
    // the check-in desk
    await page.evaluate(`showCheckinModal('d1')`);
    await expect(page.locator('#dlgt-checkin .ptn-chip svg.ptn-rb')).toHaveCount(1);
    await expect(page.locator('#dlgt-checkin .ptn-chip')).toHaveText('DEFE');
    await page.evaluate(`closeCheckinModal()`);
    await page.evaluate(`showCheckinModal('m1')`);
    await expect(page.locator('#dlgt-checkin')).toContainText('Member One');
    await expect(page.locator('#dlgt-checkin .ptn-chip')).toHaveCount(0);
    await page.evaluate(`closeCheckinModal()`);
    // the booking editor
    await page.evaluate(`showBookingEditModal('d1')`);
    await expect(page.locator('#dlgt-editBookingTitle .ptn-chip')).toHaveText('DEFE');
    await page.evaluate(`closeBookingEditModal();showBookingEditModal('m1')`);
    await expect(page.locator('#dlgt-editBookingTitle')).toBeVisible();
    await expect(page.locator('#dlgt-editBookingTitle .ptn-chip')).toHaveCount(0);
    await page.evaluate(`closeBookingEditModal()`);
  });

  test('the report puts Partner on for a ride with partner rows, off for one without; a pick holds for its ride', async ({ page }) => {
    await boot(page);
    await page.evaluate(`localStorage.removeItem('cq_rep_opts');S._repOpts=null;showPrintReportOptions()`);
    await expect(page.locator('#print-opts-modal [data-rep="cols:ptn"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(`_repOpts().cols.ptn`)).toBe(1);
    // a ride without partner rows: off
    expect(await page.evaluate(`_repPtnSync('2099-01-17').cols.ptn`)).toBe(0);
    // staff untick it on this ride: it stays off here, and another ride still decides for itself
    await page.evaluate(`_repPtnSync('${SAT}');_repToggle('cols','ptn')`);
    expect(await page.evaluate(`_repPtnSync('${SAT}').cols.ptn`)).toBe(0);
    expect(await page.evaluate(`_repPtnSync('2099-01-17').cols.ptn`)).toBe(0);
    await page.evaluate(`_repReset()`);
    expect(await page.evaluate(`_repPtnSync('${SAT}').cols.ptn`)).toBe(1);
    // the CSV's Partner column: the label for Defe, empty for a member
    const rows = await page.evaluate(`(()=>{let out=null;const o=window._downloadCsv;window._downloadCsv=(n,r)=>{out=r;};try{exportSessionExcel();}finally{window._downloadCsv=o;}return out;})()`) as string[][] | null;
    expect(rows).not.toBeNull();
    const head = rows![0], pi = head.indexOf('Partner'), ni = head.indexOf('Name');
    expect(pi).toBeGreaterThan(-1);
    const byName = (n: string) => rows!.find((r) => r[ni] === n)!;
    expect(byName('Defe Rider')[pi]).toBe('Defe');
    expect(byName('Member One')[pi]).toBe('');
  });

  test('several codes, each with its own places: booked per code, add, remove, save (2026-10-23)', async ({ page }) => {
    const ents = entries.map((e) => (e.id === 'd1' ? { ...e, partner_code_used: 'PINK10' } : e));
    await stubSupabase(page, {
      sessions: [satur()], queue_entries: ents, bikes: [],
      session_partners: [{ session_id: SAT, partner: 'defe', label: 'Defe', places: 80, code: 'DEFE24', code_needed: true }],
      session_partner_codes: [
        { session_id: SAT, partner: 'defe', code: 'PINK10', places: 2, created_at: '2026-10-23T10:00:00Z' },
        { session_id: SAT, partner: 'defe', code: 'ROSE5', places: 5, created_at: '2026-10-23T10:01:00Z' },
      ],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length>0`);
    await page.evaluate(`S.staffRole='admin';setStaffTab('queue');S.queueView='bookings';S.sfSession='${SAT}';renderStaffQueue()`);
    const panel = page.locator('#tab-queue .ptn-panel');
    await expect(panel).toContainText('Code places 7 · partner places 80');
    await expect(panel.locator('#ptn-defe-code')).toHaveCount(0); // the single code's boxes are gone
    const pink = panel.locator('.ptn-code[data-code="PINK10"]'), rose = panel.locator('.ptn-code[data-code="ROSE5"]');
    await expect(pink).toContainText('Booked 1 / 2');
    await expect(rose).toContainText('Booked 0 / 5');
    await expect(pink.locator('.ptn-code-del')).toBeDisabled(); // it has a booking
    // the report's Partner column names the code
    expect(await page.evaluate(`[_ptnLabel('defe'),getQueue().find(e=>e.id==='d1').partnerCodeUsed].join(' · ')`)).toBe('Defe · PINK10');
    const writes: { m: string; url: string; body: unknown }[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && /session_partner/.test(r.url())) writes.push({ m: r.method(), url: decodeURIComponent(r.url()), body: r.postDataJSON() }); });
    // a code typed twice (any case) is refused before anything is written
    await panel.locator('.ptn-code-add').click();
    await panel.locator('.ptn-code-new .ptn-code-in').fill('pink10');
    await panel.locator('.ptn-card[data-partner="defe"] .ptn-form .ptn-save').click();
    await expect(page.locator('.toast').last()).toContainText('The code pink10 is there twice.');
    expect(writes).toEqual([]);
    await panel.locator('.ptn-code-new .ptn-code-in').fill('NEW20');
    await panel.locator('.ptn-code-new .ptn-code-places').fill('20');
    await pink.locator('.ptn-code-places').fill('3');
    await rose.locator('.ptn-code-del').click();
    await expect(rose).toBeHidden();
    await panel.locator('.ptn-card[data-partner="defe"] .ptn-form .ptn-save').click();
    await expect.poll(() => writes.length).toBe(3);
    expect(writes[0]).toMatchObject({ m: 'PATCH', body: { places: 80, code_needed: true } });
    expect(writes[1].m).toBe('DELETE');
    expect(writes[1].url).toContain('code=in.(ROSE5)');
    expect(writes[2].m).toBe('POST');
    expect(writes[2].body).toEqual([
      { session_id: SAT, partner: 'defe', code: 'PINK10', places: 3, name: null },
      { session_id: SAT, partner: 'defe', code: 'NEW20', places: 20, name: null },
    ]);
  });

  test('a code\'s name beside its bookings, saved from the panel; the Bookings filters and Sort by cut and order the night (2026-10-23)', async ({ page }) => {
    const ents = [
      row({ id: 'd1', name: 'Defe Rider', customer_id: 'c2', partner: 'defe', partner_code: true, partner_code_used: 'pink10', approval: 'approved', queue_num: 11, partner_ask: { shirt_got: false, shirt: 'L' } }),
      row({ id: 'd2', name: 'Defe Two', customer_id: 'c3', partner: 'defe', partner_code: true, partner_code_used: 'ROSE5', approval: 'approved', queue_num: 12, partner_ask: { shirt_got: true } }),
      row({ id: 'm1', name: 'Member One', customer_id: 'c4', queue_num: 1 }),
    ];
    await stubSupabase(page, {
      sessions: [satur()], queue_entries: ents, bikes: [],
      customers: [
        { id: 'c2', name: 'Defe Rider', phone: '0550000002', gender: 'female', nationality: 'Saudi Arabia', birth_date: '1990-05-01' },
        { id: 'c3', name: 'Defe Two', phone: '0550000003', gender: 'male', nationality: 'Egypt', birth_date: '2012-05-01' },
        { id: 'c4', name: 'Member One', phone: '0550000004', gender: 'female', nationality: 'Egypt' },
      ],
      session_partners: [{ session_id: SAT, partner: 'defe', label: 'Defe', places: 80, code_needed: true }],
      session_partner_codes: [
        { session_id: SAT, partner: 'defe', code: 'PINK10', name: 'Jeddah runners', places: 5, created_at: '2026-10-23T10:00:00Z' },
        { session_id: SAT, partner: 'defe', code: 'ROSE5', name: null, places: 5, created_at: '2026-10-23T10:01:00Z' },
      ],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length>0`);
    await page.evaluate(`S.staffRole='admin';setStaffTab('queue');S.queueView='bookings';S.sfSession='${SAT}';renderStaffQueue()`);
    const tab = page.locator('#tab-queue');
    const rowOf = (n: string) => tab.locator('#q-results tbody tr, #q-results .q-card').filter({ hasText: n }).first();
    // the name beside the booking (any case of the code), the code while unnamed
    await expect(rowOf('Defe Rider').locator('.ptn-codetag')).toHaveText('Jeddah runners');
    await expect(rowOf('Defe Rider').locator('.ptn-codetag')).toHaveAttribute('title', 'Code used to book: pink10');
    await expect(rowOf('Defe Two').locator('.ptn-codetag')).toHaveText('ROSE5');
    await expect(rowOf('Member One').locator('.ptn-codetag')).toHaveCount(0);
    // the report's Partner column names it too
    expect(await page.evaluate(`_ptnCodeName(getQueue().find(e=>e.id==='d1'))`)).toBe('Jeddah runners');
    // the panel's name box saves with the code
    const panel = tab.locator('.ptn-panel');
    await expect(panel.locator('.ptn-code[data-code="PINK10"] .ptn-code-nm')).toHaveValue('Jeddah runners');
    const posts: unknown[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/session_partner_codes')) posts.push(r.postDataJSON()); });
    await panel.locator('.ptn-code[data-code="ROSE5"] .ptn-code-nm').fill('  Pink   Riders ');
    await panel.locator('.ptn-card[data-partner="defe"] .ptn-form .ptn-save').click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toEqual([
      { session_id: SAT, partner: 'defe', code: 'PINK10', places: 5, name: 'Jeddah runners' },
      { session_id: SAT, partner: 'defe', code: 'ROSE5', places: 5, name: 'Pink Riders' },
    ]);
    const shown = () => page.evaluate<string>(`[...document.querySelectorAll('#q-results tbody tr, #q-results .q-card')].map(r=>(r.innerText.match(/Defe Rider|Defe Two|Member One/)||[''])[0]).filter(Boolean).join(',')`);
    const reset = `S.sfCode=S.sfShirt=S.sfGen=S.sfAge=S.sfNat='all';S.sfSort='queue';S.sfSortDir=1;`;
    // the filters: code (by name in the list), shirt, gender, age, nationality
    await page.evaluate(`S._fOpen=Object.assign(S._fOpen||{},{q:true});renderStaffQueue()`);
    await expect(tab.locator('select[aria-label="Partner code"] option')).toHaveText(['All', 'Jeddah runners · PINK10', 'ROSE5', 'Booked without a code']);
    await page.evaluate(`${reset}S.sfCode='pink10';renderStaffQueue()`);
    expect(await shown()).toBe('Defe Rider');
    await page.evaluate(`${reset}S.sfShirt='need';renderStaffQueue()`);
    expect(await shown()).toBe('Defe Rider');
    await page.evaluate(`${reset}S.sfShirt='has';renderStaffQueue()`);
    expect(await shown()).toBe('Defe Two');
    await page.evaluate(`${reset}S.sfGen='female';renderStaffQueue()`);
    expect((await shown()).split(',').sort()).toEqual(['Defe Rider', 'Member One']);
    await page.evaluate(`${reset}S.sfAge='u18';renderStaffQueue()`);
    expect(await shown()).toBe('Defe Two');
    await page.evaluate(`${reset}S.sfAge='unset';renderStaffQueue()`);
    expect(await shown()).toBe('Member One');
    await page.evaluate(`${reset}S.sfNat='Egypt';renderStaffQueue()`);
    expect((await shown()).split(',').sort()).toEqual(['Defe Two', 'Member One']);
    // Sort by: the code's name (unnamed after named; members last), age (youngest first; unknown last), descending
    await page.evaluate(`${reset}S.sfSort='code';renderStaffQueue()`);
    expect(await shown()).toBe('Defe Rider,Defe Two,Member One');
    await page.evaluate(`${reset}S.sfSort='age';renderStaffQueue()`);
    expect(await shown()).toBe('Defe Two,Defe Rider,Member One');
    await page.evaluate(`${reset}S.sfSort='age';S.sfSortDir=-1;renderStaffQueue()`);
    expect(await shown()).toBe('Member One,Defe Rider,Defe Two');
    await expect(tab.locator('select.q-sort-pick')).toHaveValue('age');
    await expect(tab.locator('select.q-sort-dir')).toHaveValue('-1');
    // a saved view keeps them
    expect(await page.evaluate(`(()=>{S.sfCode='rose5';return _svGet('queue').sfCode})()`)).toBe('rose5');
  });

  test('the members\' waitlist: its own count in the panel, out of the members\' places, and saved with the limit', async ({ page }) => {
    await boot(page, {
      sessions: [satur({ member_wl: 15 })],
      session_partners: [{ session_id: SAT, partner: 'defe', label: 'Defe', places: 80, code: 'PINK24', code_needed: true }],
      queue_entries: [...entries, row({ id: 'w1', name: 'Wait One', customer_id: 'c9', queue_num: 20, status: 'waitlist', waitlist_num: 1 })],
    });
    const panel = page.locator('#tab-queue .ptn-panel');
    await expect(panel).toContainText('Members booked 1 / 70');
    await expect(panel).toContainText('Waitlist 1 / 15');
    await expect(panel.locator('#ptn-mwl')).toHaveValue('15');
    const patches: unknown[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/sessions')) patches.push(r.postDataJSON()); });
    await panel.locator('#ptn-mwl').fill('20');
    await panel.locator('.ptn-mem .ptn-save').click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ member_cap: 70, member_wl: 20 });
  });

  test('the Defe shirt answer: on the row, the sizes to give in the panel, and in the report', async ({ page }) => {
    await boot(page, {
      session_partners: [{ session_id: SAT, partner: 'defe', label: 'Defe', places: 80, code: 'PINK24', code_needed: false }],
      queue_entries: [
        row({ id: 'd1', name: 'Defe Rider', customer_id: 'c2', partner: 'defe', approval: 'approved', queue_num: 11, partner_code_used: 'PINK24', partner_ask: { shirt_got: false, shirt: 'M' } }),
        row({ id: 'd2', name: 'Defe Two', customer_id: 'c3', partner: 'defe', approval: 'approved', queue_num: 12, partner_ask: { shirt_got: true } }),
        row({ id: 'd3', name: 'Defe Three', customer_id: 'c5', partner: 'defe', approval: 'approved', queue_num: 13, partner_ask: { shirt_got: false, shirt: 'M' } }),
        row({ id: 'm1', name: 'Member One', customer_id: 'c4', queue_num: 1 }),
      ],
    });
    const tab = page.locator('#tab-queue');
    await expect(tab.locator('.ptn-panel .ptn-shirts')).toHaveText('Defe shirts: 1 already have one · to give: M 2');
    const rowOf = (n: string) => tab.locator('#q-results tbody tr, #q-results .q-card').filter({ hasText: n }).first();
    await expect(rowOf('Defe Rider').locator('.ptn-shirt.ptn-shirt-need')).toHaveText('Shirt to give: M');
    await expect(rowOf('Defe Two').locator('.ptn-shirt')).toHaveText('Has a Defe shirt');
    await expect(rowOf('Member One').locator('.ptn-shirt')).toHaveCount(0);
    // The code each Defe booking came with, beside it in plain sight (2026-10-23).
    await expect(rowOf('Defe Rider').locator('.ptn-codetag')).toHaveText('PINK24');
    await expect(rowOf('Defe Two').locator('.ptn-codetag')).toHaveCount(0);
    const rows = await page.evaluate(`(()=>{let out=null;const o=window._downloadCsv;window._downloadCsv=(n,r)=>{out=r;};try{localStorage.removeItem('cq_rep_opts');S._repOpts=null;exportSessionExcel();}finally{window._downloadCsv=o;}return out;})()`) as string[][] | null;
    const head = rows![0], pi = head.indexOf('Partner'), ni = head.indexOf('Name');
    expect(rows!.find((r) => r[ni] === 'Defe Rider')![pi]).toBe('Defe · PINK24 · Shirt to give: M');
    expect(rows!.find((r) => r[ni] === 'Defe Two')![pi]).toBe('Defe · Has a Defe shirt');
  });

  test('without the table there is no panel and the roster draws as before', async ({ page }) => {
    await boot(page); // session_partners answers PGRST205
    await page.waitForTimeout(400);
    await expect(page.locator('#tab-queue .ptn-panel')).toHaveCount(0);
    await expect(page.locator('#tab-queue .ptn-chip').first()).toBeVisible(); // the rows still say Defe
  });

  // The partner report builder (the owner, 2026-10-23: "add report builder for defe in 24 oct session ... make staff
  // choose what fields they want in it and what groups (different code bookings) they want and all types of sorts
  // and filters"): the codes as groups, members off until ticked, filters, sorts, grouping, PDF and Excel.
  test('the partner report builder: codes as groups, members off until ticked, filters, sorts, PDF and Excel', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const q = [
      row({ id: 'd1', name: 'Defe Rose', customer_id: 'c2', partner: 'defe', partner_code: true, partner_code_used: 'PINK10', approval: 'approved', queue_num: 11, partner_ask: { shirt_got: false, shirt: 'M' } }),
      row({ id: 'd2', name: 'Defe Amal', customer_id: 'c3', partner: 'defe', partner_code: true, partner_code_used: 'ROSE5', approval: 'approved', queue_num: 12, status: 'active', partner_ask: { shirt_got: true } }),
      row({ id: 'd3', name: 'Defe Zain', customer_id: 'c5', partner: 'defe', partner_code: true, partner_code_used: 'PINK10', approval: 'approved', queue_num: 13, type_preference: 'Own', partner_ask: { shirt_got: false, shirt: 'S' } }),
      row({ id: 'd4', name: 'Defe Gone', customer_id: 'c6', partner: 'defe', partner_code: true, partner_code_used: 'PINK10', approval: 'approved', queue_num: 14, status: 'cancelled' }),
      row({ id: 'm1', name: 'Member One', customer_id: 'c4', queue_num: 1 }),
    ];
    const cust = [
      { id: 'c2', name: 'Defe Rose', email: 'rose@example.com', phone: '0550000002', birth_date: '1990-05-01', gender: 'female', nationality: 'Saudi Arabia', socials: { instagram: 'rose.rides' } },
      { id: 'c3', name: 'Defe Amal', email: 'amal@example.com', phone: '0550000003', birth_date: '2000-05-01', gender: 'female', nationality: 'Egypt' },
      { id: 'c5', name: 'Defe Zain', email: 'zain@example.com', phone: '0550000005', birth_date: '1980-05-01', gender: 'male', nationality: 'Saudi Arabia' },
      { id: 'c6', name: 'Defe Gone', email: 'gone@example.com', phone: '0550000006' },
      { id: 'c4', name: 'Member One', email: 'm1@example.com', phone: '0550000004' },
    ];
    await stubSupabase(page, {
      sessions: [satur()], queue_entries: q, bikes: [], customers: cust,
      session_partners: [{ session_id: SAT, partner: 'defe', label: 'Defe', places: 80, code: 'DEFE24', code_needed: true }],
      session_partner_codes: [
        { session_id: SAT, partner: 'defe', code: 'PINK10', name: 'Pink team', places: 10, created_at: '2026-10-23T10:00:00Z' },
        { session_id: SAT, partner: 'defe', code: 'ROSE5', places: 5, created_at: '2026-10-23T10:01:00Z' },
      ],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length>0`);
    await page.evaluate(`localStorage.removeItem('cq_ptn_rep_opts');S._prbO=null;S.staffRole='admin';setStaffTab('queue');S.queueView='bookings';S.sfSession='${SAT}';renderStaffQueue()`);
    await page.locator('#tab-queue .ptn-panel .ptn-rep').click();
    const m = page.locator('#print-opts-modal');
    await expect(m.locator('#dlgt-prb')).toHaveText('Defe report');
    // the groups: each code with its bookings against its places, then our members, off
    const grp = (k: string) => m.locator(`[data-rep="gOff:${k}"]`);
    await expect(grp('c:pink10')).toContainText('Pink team · PINK10 · 2 / 10'); // the name staff gave the code (20261023220000)
    await expect(grp('c:rose5')).toContainText('ROSE5 · 1 / 5');
    await expect(grp('mem')).toHaveAttribute('aria-pressed', 'false');
    await expect(m.locator('#prb-count')).toContainText('On the report: 3 / 5'); // the cancelled one and the member left out
    const ids = (o: string) => page.evaluate(`(async()=>{const d=await _prbLoad('${SAT}',true);const b=_prbBuild(d,{..._prbDefaults(),...${o}});return b.rows.map(r=>r.e.id).join(',');})()`);
    expect(await ids('{}')).toBe('d1,d3,d2'); // grouped by code: PINK10 then ROSE5
    expect(await ids('{group:"none",sort:"nameZ"}')).toBe('d3,d1,d2');
    expect(await ids('{group:"none",sort:"young"}')).toBe('d2,d1,d3');
    expect(await ids('{gOff:{"c:pink10":1}}')).toBe('d2,m1');
    expect(await ids('{fStatus:"all"}')).toBe('d1,d3,d4,d2');
    expect(await ids('{fShirt:"give"}')).toBe('d1,d3');
    expect(await ids('{fShirt:"S"}')).toBe('d3');
    expect(await ids('{fNat:"sa"}')).toBe('d1,d3');
    expect(await ids('{fBike:"own"}')).toBe('d3');
    expect(await ids('{fIg:"yes"}')).toBe('d1');
    expect(await ids('{fStatus:"came"}')).toBe('d2');
    expect(await ids('{group:"shirt"}')).toBe('d3,d1,d2'); // S, then M, then has one
    // ticking the members brings them in; a filter in the dialog changes the count
    await grp('mem').click();
    await expect(m.locator('#prb-count')).toContainText('On the report: 4 / 5');
    await m.locator('select[aria-label="Gender"]').selectOption('female');
    await expect(m.locator('#prb-count')).toContainText('On the report: 2 / 5');
    await m.locator('select[aria-label="Gender"]').selectOption('all');
    await grp('mem').click();
    // a starting set picks its columns
    await m.locator('[data-prb-set="shirts"]').click();
    expect(await page.evaluate(`Object.keys(_prbOpts().cols).filter(k=>_prbOpts().cols[k]).join(',')`)).toBe('seq,num,name,code,shirtGot,shirt');
    // the PDF: a heading per code, the per-code table and the shirts table
    const [pop] = await Promise.all([page.waitForEvent('popup'), m.locator('.rpt-acts .btn-primary').click()]);
    await pop.waitForLoadState();
    await pop.waitForSelector('h2'); // the window opens on the tap; the sheet is written once the accounts are read
    const hs = await pop.evaluate(() => [...document.querySelectorAll('h2')].map((h) => (h.textContent || '').trim()));
    expect(hs).toEqual(['Bookings per code', 'Shirts by code', 'Pink team · PINK10 · 2', 'ROSE5 · 1']);
    const last = await pop.evaluate(() => [...[...document.querySelectorAll('table')].pop()!.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => (c.textContent || '').trim()).join('|')));
    expect(last).toEqual(['3|#12|Defe Amal|ROSE5|Yes|—']);
    await pop.close();
    // Excel: the list, the codes and the shirts sheets; the group column first
    const [dl] = await Promise.all([page.waitForEvent('download'), m.locator('.rpt-acts .btn-secondary', { hasText: 'Excel' }).click()]);
    const buf = readFileSync((await dl.path())!).toString('utf8');
    expect(dl.suggestedFilename()).toBe(`defe_${SAT}_shirts.xlsx`);
    for (const n of ['Rider list', 'Bookings per code', 'Shirt']) expect(buf).toContain(`name="${n}"`);
    const s1 = buf.slice(buf.indexOf('<worksheet'), buf.indexOf('</worksheet>'));
    expect(s1.indexOf('Defe Rose')).toBeLessThan(s1.indexOf('Defe Zain'));
    expect(s1.indexOf('Defe Zain')).toBeLessThan(s1.indexOf('Defe Amal'));
    expect(s1).not.toContain('Defe Gone');
    // Shirt requests (2026-10-23): the panel's button opens the builder on its own set - only the riders who asked for a
    // shirt, grouped and ordered by size, with the shirts table - and leaving the set puts those choices back.
    await expect(page.locator('#tab-queue .ptn-panel .ptn-rep-shirts')).toHaveText(/Shirt requests/);
    await page.evaluate(`_prbOpen('${SAT}','shirtreq')`);
    await expect(m.locator('[data-prb-set="shirtreq"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(m.locator('#prb-count')).toContainText('On the report: 2 / 5');
    const o = await page.evaluate(`(()=>{const o=_prbOpts();return {f:o.fShirt,g:o.group,s:o.sort,secs:o.secs,cols:Object.keys(o.cols).filter(k=>o.cols[k]).join(',')};})()`);
    expect(o).toEqual({ f: 'give', g: 'shirt', s: 'shirt', secs: { summary: 0, codes: 0, shirts: 1, list: 1 }, cols: 'seq,num,name,code,phone,shirt' });
    expect(await page.evaluate(`(async()=>{const d=await _prbLoad('${SAT}',true);return _prbBuild(d,_prbOpts()).rows.map(r=>r.e.name+' '+r.size).join(',');})()`)).toBe('Defe Zain S,Defe Rose M');
    await m.locator('[data-prb-set="full"]').click();
    expect(await page.evaluate(`(()=>{const o=_prbOpts();return [o.fShirt,o.group,o.sort,o.secs.codes].join(',');})()`)).toBe('all,code,num,1');
  });

  test('the export dialog offers the partner report builder on a partner ride only', async ({ page }) => {
    await boot(page);
    await page.evaluate(`showPrintReportOptions()`);
    const m = page.locator('#print-opts-modal');
    await expect(m.getByText('Defe report')).toBeVisible();
    await m.locator('.rpt-km-acts .btn-sm', { hasText: 'Report builder' }).click();
    await expect(m.locator('#dlgt-prb')).toHaveText('Defe report');
  });
});
