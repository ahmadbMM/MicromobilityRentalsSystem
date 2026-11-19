import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, stubRealtime, unlockStaff, waitForSb } from './helpers/supabase';

// Invite to a session (the user, 2026-11-19: "add a feature to include an invite button to any booking to invite its
// customer and on all accounts include an invite button to invite to any current or future session, include a ready
// message to any session he is invited to"). Invite is a tile on every booking's ⋯ menu and a button on every account
// window; both open one pop-up listing the sessions running now or still to come, and a pick shows the ready message
// (ann_invite) in English or Arabic with Copy and WhatsApp to the rider. Nothing is booked. Invented riders only; the clock
// is fixed on the night at 20:30, so tonight's 20:00 - 22:00 session is running and last week's is over.

const DAY = '2099-05-05';
const NOW = new Date(`${DAY}T20:30:00+03:00`);
const slots = (time: string, x: Record<string, unknown> = {}) => JSON.stringify({ _total: 20, _time: time, _collect: '19:45', ...x });
const sess = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Tuesday', session_date: date, capacity: 20, status: 'open', created_at: 1, bike_slots: slots('20:00 - 22:00'), ...extra,
});
const comm = { event_kind: 'community', needs_approval: false, hide_queue: true, spots: 20 };
const sessions = [
  sess('2099-04-28', '2099-04-28', { status: 'closed' }), // over
  sess(DAY, DAY), // running now
  sess('2099-05-07', '2099-05-07', { status: 'closed' }), // to come, closed for booking: offered, marked
  sess('2099-05-09', '2099-05-09', { ...comm, ride_kind: 'saturday', bike_slots: slots('05:45 - 06:15'), meet_url: 'https://maps.app.goo.gl/meet' }), // gathers
  sess('2099-05-10-x', '2099-05-10', { cancelled_at: '2099-05-01T10:00:00Z' }), // called off
  sess('2099-05-11-d', '2099-05-11', { draft: true }), // a draft
  sess('2099-05-12', '2099-05-12'),
];
const id = (n: number) => `aaaa${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;
const [A, B, C, D, W, AN] = [1, 2, 3, 4, 5, 6].map(id);
const row = (bid: string, sid: string, qn: number, name: string, status: string, cid: string | null, phone = '0500000000') => ({
  id: bid, session_id: sid, session_day: 'Tuesday', session_date: sid.slice(0, 10), queue_num: qn, name, phone, customer_id: cid, group_id: null,
  status, paid: true, price: 75, walk_in: !cid, registered_at: `${DAY}T15:00:00Z`, height: 175, type_preference: 'Road',
});
const customers = [
  { id: 'cust-amal', name: 'Amal Road', phone: '0500000011', whatsapp_same: false, whatsapp: '0511111111', created_at: '2099-01-01T00:00:00Z' },
  { id: 'cust-badr', name: 'Badr Top', phone: '0500000012', created_at: '2099-01-01T00:00:00Z' },
];
const rows = [
  row(A, DAY, 1, 'Amal Road', 'waiting', 'cust-amal'),
  row(AN, '2099-05-12', 1, 'Amal Road', 'waiting', 'cust-amal'), // Amal already holds the 12th
  row(B, DAY, 2, 'Badr Top', 'done', 'cust-badr'),
  row(C, DAY, 3, 'Walk Up', 'noshow', null, '0533333333'),
  row(D, DAY, 4, 'Dina Gone', 'cancelled', null),
  row(W, DAY, 5, 'Wafa List', 'waitlist', null),
];

async function boot(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { queue_entries: rows, sessions, bikes: [], customers, tags: [], customer_tags: [], site_content: [] });
  await stubRealtime(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');setSfSession('${DAY}')`);
  await page.waitForFunction(`(S.customers||[]).length===2&&getQueue().length===${rows.length}`);
}
const menu = (page: Page, bid: string) => page.evaluate(`(_entryActions0(_qGet('${bid}')),(S._rowMenus['${bid}']||[]).map(i=>i.label.replace(/<[^>]+>/g,'').trim()))`) as Promise<string[]>;
const dlg = (page: Page) => page.locator('#confirm-modal .ivt-box');
const opt = (page: Page, sid: string) => dlg(page).locator(`.ivt-opt[data-ivt="${sid}"]`);

test.describe('@staff:bookings Invite to a session', () => {
  test('every booking, whatever its status, has Invite in its menu', async ({ page }) => {
    await boot(page);
    for (const bid of [A, B, C, D, W]) expect(await menu(page, bid), bid).toContain('Invite');
    // a tile under Account, with its own icon
    expect(await page.evaluate(`(_entryActions0(_qGet('${A}')),(S._rowMenus['${A}']||[]).find(i=>/_ivtOpen/.test(i.run)).g)`)).toBe('ac');
  });

  test('the menu tile lists the sessions running now or to come and shows the ready message', async ({ page }) => {
    await boot(page);
    await page.locator(`#q-results [data-id="${A}"] [aria-haspopup="menu"]`).first().click();
    await page.locator('.row-sheet .rmt-tile', { hasText: 'Invite' }).click();
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page).locator('#ivt-title')).toHaveText('Invite Amal Road');
    // tonight (running), the 7th (closed), the Saturday ride, the 12th; not last week's, the called-off one or the draft
    await expect(dlg(page).locator('.ivt-opt')).toHaveCount(4);
    expect(await dlg(page).locator('.ivt-opt').evaluateAll((l) => l.map((b) => b.getAttribute('data-ivt')))).toEqual([DAY, '2099-05-07', '2099-05-09', '2099-05-12']);
    // tonight is this booking's own, the 12th another of Amal's: Booked, not offered
    await expect(opt(page, DAY)).toBeDisabled();
    await expect(opt(page, DAY)).toContainText('Booked');
    await expect(opt(page, '2099-05-12')).toBeDisabled();
    await expect(opt(page, '2099-05-07')).toContainText('Closed');
    await expect(opt(page, '2099-05-07')).toBeEnabled();
    // the find box narrows the list
    await dlg(page).locator('#ivt-q').fill('9 May');
    await expect(dlg(page).locator('.ivt-opt')).toHaveCount(1);
    await dlg(page).locator('#ivt-q').fill('');
    await expect(dlg(page).locator('.ivt-opt')).toHaveCount(4);
    // the Saturday ride gathers: its meet up and start, no window line; the booking link first, opening that ride
    await opt(page, '2099-05-09').click();
    const txt = await dlg(page).locator('#ivt-text').inputValue();
    expect(txt).toMatch(/^Hi Amal,\n\nYou are invited to \*.+\* with MicroMobility\./);
    expect(txt).toContain('Meet up time: 5:45 AM');
    expect(txt).toContain('Start time: 6:15 AM');
    expect(txt).not.toContain('Time: ');
    expect(txt).not.toContain('Bikes from'); // it would repeat the meet up
    expect(txt).toContain('Booking:\nhttps://experiences.micromobility.sa/?ev=community&session=2099-05-09');
    expect(txt.indexOf('experiences.micromobility.sa')).toBeLessThan(txt.indexOf('maps.app.goo.gl'));
    expect(txt).not.toMatch(/\p{Extended_Pictographic}/u);
    // WhatsApp goes to the account's own WhatsApp number, with the message
    const href = await dlg(page).locator('.ivt-wa').getAttribute('href');
    expect(href!.startsWith('https://wa.me/966511111111?text=')).toBe(true);
    expect(decodeURIComponent(href!.split('?text=')[1])).toBe(txt);
    await expect(dlg(page).locator('.ivt-wa')).toHaveAttribute('data-wa-t', 'ann_invite');
    // Arabic on the switch
    await dlg(page).locator('[data-ivt-lang="ar"]').click();
    await expect(dlg(page).locator('#ivt-text')).toHaveAttribute('dir', 'rtl');
    const ar = await dlg(page).locator('#ivt-text').inputValue();
    expect(ar).toMatch(/^مرحباً Amal،/);
    expect(ar).toContain('الحجز:\nhttps://experiences.micromobility.sa/?ev=community&session=2099-05-09');
    // Back to the list, and the circuit night has its window as one line
    await dlg(page).locator('[data-ivt-lang="en"]').click();
    await dlg(page).locator('.ivt-back').click();
    await opt(page, '2099-05-07').click();
    const jcc = await dlg(page).locator('#ivt-text').inputValue();
    expect(jcc).toContain('Time: 8:00 PM – 10:00 PM');
    expect(jcc).toContain('Bikes from: 7:45 PM');
    expect(jcc).not.toContain('Meet up time');
    expect(jcc).toContain('https://experiences.micromobility.sa/?ev=jcc&session=2099-05-07');
    // nothing was booked
    expect(await page.evaluate('getQueue().length')).toBe(rows.length);
  });

  test('a walk-in with no account is invited on the booking\'s own mobile; Copy writes a log line', async ({ page }) => {
    await boot(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(`_ivtOpen('','${C}')`);
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page).locator('#ivt-title')).toHaveText('Invite Walk Up');
    await expect(opt(page, DAY)).toBeEnabled(); // a no-show holds no place
    await opt(page, '2099-05-12').click();
    await expect(dlg(page).locator('.ivt-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/966533333333\?text=/);
    await dlg(page).locator('.ivt-copy').click();
    await expect.poll(() => page.evaluate(`S.fullLog.some(l=>/^Invitation copied · Walk Up · /.test(l.label))`)).toBe(true);
  });

  test('every account window has Invite, which opens the same pop-up for the account', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('customers');S.communityTab='accounts';S.amSearch='';renderCustomers()`);
    await page.locator('.am-row[data-cust="cust-badr"] .am-hist').click();
    const bar = page.locator('#cust-modal .n6p-bar');
    await expect(bar.locator('button', { hasText: 'Invite' })).toBeVisible();
    await bar.locator('button', { hasText: 'Invite' }).click();
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page).locator('#ivt-title')).toHaveText('Invite Badr Top');
    await expect(opt(page, DAY)).toBeDisabled(); // Badr rode tonight
    await expect(opt(page, '2099-05-12')).toBeEnabled();
    await opt(page, '2099-05-12').click();
    await expect(dlg(page).locator('.ivt-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/966500000012\?text=Hi%20Badr%2C/);
    await expect(dlg(page).locator('.ivt-wa')).toHaveAttribute('data-wa-c', 'cust-badr');
  });

  test('the invitation is a message template admins can rewrite', async ({ page }) => {
    await boot(page);
    await page.evaluate(`_annDef('wk_head','en')`);
    expect(await page.evaluate(`_tplDef('ann_invite')[1]`)).toBe('ivtTpl');
    expect(await page.evaluate(`_tplDefault('ann_invite','en')`)).toContain('{booking_link}');
    expect(await page.evaluate(`_tplDefault('ann_invite','ar')`)).toMatch(/[؀-ۿ]/);
    await page.evaluate(`S._tpl={ann_invite:{en:'Come to {title} on {date}, {first_name}: {booking_link}'}}`);
    await page.evaluate(`_ivtOpen('cust-badr','')`);
    await opt(page, '2099-05-12').click();
    await expect(dlg(page).locator('#ivt-text')).toHaveValue(/^Come to .+ on 12th of May, Badr: https:\/\/experiences\.micromobility\.sa\/\?ev=jcc&session=2099-05-12$/);
  });
});
