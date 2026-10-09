import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// Run for Her (the owner, 2026-10-05): a running event for community members only, free, 18 and over,
// first come first served to its 80 places, one place per account, a 3 km or a 5 km run picked per
// booking, an emergency contact on the account, the pink ribbon badge for finishing it. Its card on the
// event picker behaves as MicroMobility Experiences does (the members gate answers the tap).

const RUN = '2099-10-17-rh';
const run = {
  id: RUN, session_date: '2099-10-17', day: 'Saturday', status: 'open', capacity: 80, created_at: 1,
  event_kind: 'community', ride_kind: 'runher', needs_approval: false, hide_queue: true, spots: 80, open_to_all: false,
  paid_ride: false, location: 'JYC', meet_url: 'https://maps.app.goo.gl/UYBngHt3YwpayVZo7?g_st=ac', bike_slots: '{"_time":"06:00 - 06:30"}',
};
const jcc = { id: '2099-10-18', session_date: '2099-10-18', day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC' };
const profile = (x: Record<string, unknown> = {}) => [{ id: 'c1', name: 'Sara', email: '', phone: '+966500000001', birth_date: '1995-05-05', height: 165, type_preference: 'Any', nationality: 'SA', ...x }];
const noContact = [{ emergency_name: null, emergency_phone: null, emergency_relation: null }];
const contact = [{ emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' }];
const row = (id: string, km: number | null, x: Record<string, unknown> = {}) => ({
  id, session_id: RUN, session_day: 'Saturday', session_date: '2099-10-17', queue_num: Number(id.slice(1)), name: 'Runner ' + id,
  phone: '055000000' + id.slice(1), type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0,
  registered_at: '2099-10-01T10:00:00Z', customer_id: 'c' + id, run_km: km, ...x,
});

async function custBoot(page: Page, fx: Record<string, unknown> = {}, cust: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [run, jcc], queue_entries: [], 'rpc:community_member': true, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Sara', birth_date: '1995-05-05', ...cust });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
}

test.describe('@customer:runher Run for Her', () => {
  test('the card shows while a run is on the books, and only members get past it', async ({ page }) => {
    await custBoot(page, { 'rpc:community_member': false });
    const card = page.locator('#land-events .landing-event-card.ev-runher');
    await expect(card).toBeVisible();
    await expect(card.locator('.lec-title')).toHaveText('Run for Her');
    await expect(card.locator('.rf-meta')).toContainText('6:30 AM');
    await expect(card.locator('.rf-meta')).toContainText('3 or 5 km');
    await expect(card.locator('.rf-logos img')).toHaveAttribute('src', '/assets/runher-partners.webp');
    await card.click();
    await expect(page.locator('#confirm-modal')).toContainText('Community members only');
    expect(await page.evaluate('S.view')).toBe('landing');
    // no run on the books: no card
    await page.evaluate(`S.sessions=S.sessions.filter(s=>s.ride_kind!=='runher');renderLandingAvail()`);
    await expect(card).toHaveCount(0);
  });

  test('a member under 18 on race day is turned away at the card', async ({ page }) => {
    await custBoot(page, {}, { birth_date: '2085-01-01' });
    await page.locator('#land-events .landing-event-card.ev-runher').click();
    const m = page.locator('#confirm-modal');
    await expect(m).toContainText('For runners 18 and over');
    await expect(m).toContainText('aged 18 and over on race day');
    expect(await page.evaluate('S.view')).toBe('landing');
  });

  test('the runner step asks only what the account lacks, saves it, and the booking carries the distance', async ({ page }) => {
    const sent: { u: string; b: Record<string, unknown> }[] = [];
    page.on('request', (r) => { const m = /rpc\/(customer_set_emergency|customer_update_profile)/.exec(r.url()); if (m) sent.push({ u: m[1], b: r.postDataJSON() }); });
    await custBoot(page, { 'rpc:customer_profile': profile(), 'rpc:customer_emergency': noContact, 'rpc:customer_update_profile': true, 'rpc:customer_set_emergency': true });
    const rows = await captureBookingRows(page);
    await page.locator('#land-events .landing-event-card.ev-runher').click();
    // one run on the books: the flow opens on it (once the members check has answered)
    await expect.poll(() => page.evaluate('S.selSession')).toBe(RUN);
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect(page.locator('#run-km-wrap [data-km]')).toHaveText(['3 km', '5 km']);
    // a full name is missing (one word), and the email; the birth date is on file
    await expect(page.locator('#run-first')).toHaveValue('Sara');
    await expect(page.locator('#run-email')).toBeVisible();
    await expect(page.locator('#run-dob-row')).toHaveCount(0);
    // no distance: no further
    await page.locator('#run-next').click();
    await expect(page.locator('#run-km-wrap .field-err')).toContainText('Pick 3 km or 5 km.');
    await page.locator('#run-km-wrap [data-km="5"]').click();
    await page.fill('#run-last', 'Haddad');
    await page.fill('#run-email', 'sara@example.com');
    await page.fill('#run-em-name', 'Nora Haddad');
    await page.fill('#run-em-phone', '0500000001'); // the runner's own number
    await page.selectOption('#run-em-rel', 'sibling');
    await page.locator('#run-next').click();
    await expect(page.locator('#run-em-phone-err')).toContainText('can’t be your own');
    await page.fill('#run-em-phone', '0551234567');
    await page.locator('#run-next').click();
    // the details are saved; the runner agrees that they go to Sela and JYC before moving on (2026-10-06)
    const sg = page.locator('#share-gate');
    await expect(sg.locator('#sg-title')).toHaveText('Sharing your details for the race');
    await expect(sg.locator('.sg-list li')).toHaveText(['Full name', 'Email address', 'Birth date', 'Distance chosen · 5 km', 'Emergency contact']);
    await expect(sg.locator('.gate-out')).toHaveText('Back');
    await sg.locator('.wg-cb').check();
    await sg.locator('.pg-btn').click();
    await expect(page.locator('#reg-waiver-cb')).toBeVisible();
    await expect(sg.locator('.sg-box')).toHaveCount(0);
    expect(sent.map((x) => x.u)).toEqual(['customer_update_profile', 'customer_set_emergency']);
    expect(sent[0].b).toMatchObject({ p_name: 'Sara Haddad', p_email: 'sara@example.com', p_phone: '+966500000001', p_birth_date: '1995-05-05', p_nationality: 'SA' });
    expect(sent[1].b).toMatchObject({ p_name: 'Nora Haddad', p_phone: '+966551234567', p_relation: 'sibling' });
    await page.locator('#reg-waiver-cb').check();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect(page.locator('#tab-register .run-km-chip')).toHaveText('5 km');
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: RUN, run_km: 5, type_preference: 'None', price: 0, share_ok: true });
    expect(String(rows[0].waiver_version)).toMatch(/^activity-/);
    const tk = page.locator('#tab-register .ticket-card');
    await expect(tk).toContainText('Runner number');
    await expect(tk).toContainText('Jeddah Yacht Club');
    await expect(tk).toContainText('5 km');
    await expect(tk.locator('a.cu-tk-link')).toHaveAttribute('href', run.meet_url);
  });

  test('an account that holds everything is asked the distance only', async ({ page }) => {
    await custBoot(page, { 'rpc:customer_profile': profile({ name: 'Sara Haddad', email: 'sara@example.com' }), 'rpc:customer_emergency': contact }, { name: 'Sara Haddad' });
    await page.locator('#land-events .landing-event-card.ev-runher').click();
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click();
    await expect(page.locator('#run-km-wrap')).toBeVisible();
    await expect(page.locator('#run-first, #run-email, #run-dob-row, #run-em-name')).toHaveCount(0);
    await expect(page.locator('.run-em-card')).toContainText('Nora Haddad');
    await expect(page.locator('.run-em-card')).toContainText('Brother or sister');
    await page.locator('#run-km-wrap [data-km="3"]').click();
    await page.locator('#run-next').click();
    // Back keeps the runner on the step; agreeing moves on, and is not asked again on the way back through
    const sg = page.locator('#share-gate');
    await expect(sg.locator('.sg-list li').nth(3)).toHaveText('Distance chosen · 3 km');
    await sg.locator('.gate-out').click();
    await expect(sg.locator('.sg-box')).toHaveCount(0);
    await expect(page.locator('#run-km-wrap')).toBeVisible();
    await page.locator('#run-next').click();
    await expect(sg.locator('.pg-btn')).toBeDisabled();
    await sg.locator('.wg-cb').check();
    await sg.locator('.pg-btn').click();
    await expect(page.locator('#reg-waiver-cb')).toBeVisible();
    await page.evaluate('S.regStep=2;renderRegister()');
    await page.locator('#run-next').click();
    await expect(page.locator('#reg-waiver-cb')).toBeVisible();
    await expect(sg.locator('.sg-box')).toHaveCount(0);
  });

  test('the server’s runner refusals are said in the rider’s words', async ({ page }) => {
    await custBoot(page, { 'rpc:customer_profile': profile({ name: 'Sara Haddad', email: 'sara@example.com' }), 'rpc:customer_emergency': contact,
      'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'Runners must be 18 or over.', details: 'RUN_AGE' } } }, { name: 'Sara Haddad' });
    await page.evaluate(`S.selEvent='runher';S.selSession='${RUN}';S.regRunKm=5;S.regShare='${RUN}';S.waiverOk=true;S._waiverSess='${RUN}';S.regStep=3;setCustTab('register')`);
    await page.evaluate('submitReg()');
    await expect(page.locator('#confirm-modal')).toContainText('For runners 18 and over');
  });

  test('a booking that reaches the server without the runner\'s agreement asks for it (RUN_SHARE)', async ({ page }) => {
    await custBoot(page, { 'rpc:customer_profile': profile({ name: 'Sara Haddad', email: 'sara@example.com' }), 'rpc:customer_emergency': contact,
      'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'Agree to share your details for the race.', details: 'RUN_SHARE' } } }, { name: 'Sara Haddad' });
    await page.evaluate(`S.selEvent='runher';S.selSession='${RUN}';S.regRunKm=5;S.regShare='${RUN}';S.waiverOk=true;S._waiverSess='${RUN}';S.regStep=3;setCustTab('register')`);
    await page.evaluate('submitReg()');
    await expect(page.locator('#share-gate #sg-title')).toBeVisible();
    expect(await page.evaluate('S.regShare')).toBe(null);
    // and a page that skipped the step is asked before anything is sent
    await page.locator('#share-gate .gate-out').click();
    await page.evaluate('submitReg()');
    await expect(page.locator('#share-gate #sg-title')).toBeVisible();
  });

  test('My Account keeps the emergency contact and saves a new one', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (/rpc\/customer_set_emergency/.test(r.url())) sent.push(r.postDataJSON()); });
    await custBoot(page, { 'rpc:customer_emergency': contact, 'rpc:customer_set_emergency': true, 'rpc:customer_profile': profile() });
    await page.evaluate(`setCustTab('account')`);
    const box = page.locator('#acc-em');
    await expect(box).toContainText('Emergency contact');
    await expect(box).toContainText('Nora Haddad');
    await box.getByRole('button', { name: 'Change' }).click();
    await page.fill('#acc-em-name', 'Omar Haddad');
    await page.selectOption('#acc-em-rel', 'spouse');
    await box.getByRole('button', { name: 'Save' }).click();
    await expect(box).toContainText('Omar Haddad');
    await expect(box).toContainText('Spouse');
    expect(sent).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_name: 'Omar Haddad', p_phone: '+966551234567', p_relation: 'spouse' }]);
  });

  test('the finisher’s badge: the pink ribbon, shown once the run is finished', async ({ page }) => {
    await custBoot(page);
    const slugs = (st: string) => page.evaluate(([s, sid]) => {
      const e = [{ id: 'x', sessionId: sid, sessionDate: '2099-10-17', status: s, paid: false, price: 0, customerId: 'c1', queueNum: 3 }];
      return (window as unknown as { _mrBadges: (a: unknown[], b: unknown[]) => { s: string; on: boolean; hide?: boolean }[] })._mrBadges(e, s === 'done' ? e : [])
        .filter((b) => b.s === 'run_for_her').map((b) => ({ on: b.on, hide: !!b.hide }));
    }, [st, RUN]);
    expect(await slugs('active')).toEqual([{ on: false, hide: true }]);
    expect(await slugs('done')).toEqual([{ on: true, hide: true }]);
    const medal = await page.evaluate(`_bdgMedal('ribbon','pink')`);
    expect(medal).toContain('bdg-sp');
    expect(medal).toContain('class="rb');
  });
});

test.describe('@staff:bookings Run for Her', () => {
  async function staffBoot(page: Page, q: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    await stubSupabase(page, { sessions: [run, jcc], bikes: [], queue_entries: q, ...extra });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${RUN}';renderStaffQueue()`);
  }

  test('the roster shows each runner’s distance and splits them by it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await staffBoot(page, [row('r1', 5, { status: 'active' }), row('r2', 3), row('r3', 5), row('r4', null)]);
    const tq = page.locator('#tab-queue');
    await expect(tq.locator('.queue-table thead')).toContainText('Distance');
    await expect(tq.locator('.run-split-b')).toHaveText([/3 km\s*1/, /5 km\s*2/, /No distance\s*1/]);
    await tq.locator('.run-split-b').nth(1).click();
    await expect(tq.locator('.queue-table tbody tr[data-id]')).toHaveCount(2);
    await expect(tq.locator('.queue-table tbody .run-km-chip')).toHaveText(['5 km', '5 km']);
    // a second tap shows everyone again
    await tq.locator('.run-split-b').nth(1).click();
    await expect(tq.locator('.queue-table tbody tr[data-id]')).toHaveCount(4);
    // a runner on the run finishes; there is no bike to return
    await expect(tq.locator('tr[data-id="r1"]')).toContainText('Finished');
    await expect(tq.locator('tr[data-id="r1"]')).not.toContainText('Return Bike');
  });

  test('the roster shows who is a member, filters and sorts by it, with no Approve or Publish', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#00e585', locked: true }];
    const customer_tags = [{ customer_id: 'cr1', tag_id: 'tag_saturday', added_at: 1, expires_at: null, starts_at: null }];
    await staffBoot(page, [row('r1', 5), row('r2', 3)], { tags, customer_tags });
    await page.evaluate(`(()=>{S.tags=${JSON.stringify(tags)};S.customerTags=${JSON.stringify(customer_tags)};renderStaffQueue();})()`);
    const tq = page.locator('#tab-queue');
    await expect(tq.locator('.queue-table thead')).toContainText('Membership');
    await expect(tq.locator('tr[data-id="r1"] td[data-label="Membership"]')).toHaveText('Member');
    await expect(tq.locator('tr[data-id="r2"] td[data-label="Membership"]')).toHaveText('Non-member');
    await page.evaluate(`S.sfMember='no';renderStaffQueue()`);
    await expect(tq.locator('.queue-table tbody tr[data-id]')).toHaveCount(1);
    await expect(tq.locator('.queue-table tbody tr[data-id="r2"]')).toHaveCount(1);
    await page.evaluate(`S.sfMember='all';S.sfSort='member';S.sfSortDir=-1;renderStaffQueue()`);
    expect(await page.evaluate(`S._qOrder.join()`)).toBe('r1,r2');
    // the run takes no approvals: those buttons stay on the Saturday ride
    await expect(tq.getByRole('button', { name: 'Publish' })).toHaveCount(0);
    // another night's roster has no Membership column
    await page.evaluate(`S.sfSession='2099-10-18';S.sfSort='queue';renderStaffQueue()`);
    await expect(tq.locator('.queue-table thead')).not.toContainText('Membership');
  });

  test('Finished ends a free run at once: no payment question for a runner who owes nothing', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await staffBoot(page, [row('r1', 5, { status: 'active', checked_in_at: '2099-10-17T03:00:00Z' })]);
    await page.locator('#tab-queue tr[data-id="r1"]').getByRole('button', { name: 'Finished' }).click();
    await expect.poll(() => page.evaluate(`(getQueue().find(e=>e.id==='r1')||{}).status`)).toBe('done');
    await expect(page.locator('#return-pay-modal')).toBeHidden();
  });

  test('the emergency contact is read when asked, with a call button', async ({ page }) => {
    await staffBoot(page, [row('r1', 5)], { customers: [{ id: 'cr1', name: 'Runner r1', phone: '0550000001', emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' }] });
    await page.evaluate(`_runEmShow('cr1')`);
    const m = page.locator('#confirm-modal');
    await expect(m).toContainText('Nora Haddad');
    await expect(m).toContainText('Brother or sister');
    await expect(m.locator('a[href="tel:+966551234567"]')).toBeVisible();
  });

  test('the session form makes a Run for Her session: members only, free, first come first served, the Yacht Club', async ({ page }) => {
    const ins: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/rest\/v1\/sessions/.test(r.url())) { const b = r.postDataJSON(); (Array.isArray(b) ? b : [b]).forEach((x) => ins.push(x)); } });
    await staffBoot(page, [row('r1', 5)]);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='runher';renderSessions()`);
    await expect(page.locator('#ns-spots')).toHaveValue('80');
    await page.evaluate(`document.getElementById('ns-date').value='2099-11-20';document.getElementById('ns-start').value='06:00';document.getElementById('ns-end').value='06:30';S.newSessMapUrl='https://maps.app.goo.gl/UYBngHt3YwpayVZo7';addSession()`);
    await expect.poll(() => ins.length).toBe(1);
    expect(ins[0]).toMatchObject({ id: '2099-11-20-rh', ride_kind: 'runher', event_kind: 'community', needs_approval: false, open_to_all: false,
      paid_ride: false, location: 'JYC', capacity: 80, spots: 80, meet_url: 'https://maps.app.goo.gl/UYBngHt3YwpayVZo7' });
    expect(JSON.parse(String(ins[0].bike_slots))._time).toBe('06:00 - 06:30');
  });
});
