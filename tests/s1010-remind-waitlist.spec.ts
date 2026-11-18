import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Who a freed waitlist place goes to (2026-10-09, R7): Settings > Business wl_offer_mode 'auto' (the default:
// the old automatic promotion), 'staff' (a centred dialog, staff give the place) or 'claim' (a timed
// offer the rider claims from a link; waitlist_offers + staff_offer_spot, 20261009225000).
const sessions = [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 2, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '19:00 - 21:00' }) }];
const qe = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id, name: 'Rider ' + ['One', 'Two', 'Three', 'Four'][n - 1], phone: '05000000' + n + n, session_id: 's1', session_day: 'Friday', session_date: '2099-01-09',
  queue_num: n, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-08T10:00:00Z', ...extra,
});
const rows = () => [qe('e1', 1), qe('e2', 2), qe('e3', 3, { status: 'waitlist', waitlist_num: 1 }), qe('e4', 4, { status: 'waitlist', waitlist_num: 2 })];

async function open(page: Page, mode?: string, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: rows(), bikes: [], staff_options: mode ? [{ key: 'biz', items: { wl_offer_mode: mode } }] : [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0&&S.staffOptions&&typeof _r7Bell==='function'`);
  await page.evaluate(`window.__opened=[];window.open=(u)=>{window.__opened.push(String(u));return null;};`);
}
function writes(page: Page) {
  const out: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('queue_entries')) out.push(decodeURIComponent(r.url()) + ' ' + (r.postData() || '')); });
  return out;
}

test.describe('@staff:bookings waitlist offers', () => {
  test('with no setting the mode is Automatic, exactly as before', async ({ page }) => {
    await open(page);
    expect(await page.evaluate('_wlMode()')).toBe('auto');
    const w = writes(page);
    await page.evaluate(`setStaffTab('queue');setSfSession('s1');doNoShow('e1')`);
    await expect.poll(() => w.find((x) => /"status":"waiting"/.test(x) && /id=eq\.e3/.test(x))).toBeTruthy();
    await page.waitForTimeout(900);
    await expect(page.locator('#wlo-title')).toHaveCount(0);
  });

  test('in Staff choose a no-show promotes nobody: staff choose in a centred dialog', async ({ page }) => {
    // three places: the stub reads its fixture back after each write, so the place stays free after the reload
    await open(page, 'staff', { sessions: [{ ...sessions[0], capacity: 3 }] });
    expect(await page.evaluate('_wlMode()')).toBe('staff');
    const w = writes(page);
    await page.evaluate(`setStaffTab('queue');setSfSession('s1');doNoShow('e1')`);
    const dlg = page.locator('[role="dialog"][aria-labelledby="wlo-title"]');
    await expect(dlg).toBeVisible();
    expect(w.filter((x) => /"status":"waiting"/.test(x))).toHaveLength(0);
    await expect(dlg.locator('.rem-row')).toHaveCount(2);
    await dlg.locator('.rem-row').first().getByRole('button', { name: 'Give the place' }).click();
    await expect.poll(() => w.find((x) => /"status":"waiting"/.test(x))).toBeTruthy();
    const p = w.find((x) => /"status":"waiting"/.test(x))!;
    expect(p).toContain('id=eq.e3');
    expect(p).toContain('status=eq.waitlist');
    await expect(dlg.getByText('Has the place now')).toBeVisible();
    // the place-opened message for this ride in the rider's language, not the booth's "your turn", and the row owes it
    // until it is sent (bug hunt 2026-11-18)
    const wa = dlg.locator('a[data-wa-t="wl_moved"]');
    await expect(wa).toHaveCount(1);
    await expect(dlg.locator('a[data-wa-t="wa_turn"]')).toHaveCount(0);
    expect(await wa.getAttribute('href')).toBe(await page.evaluate(`_ptLink(_qGet('e3'))`));
    expect(await page.evaluate(`_ptList().includes('e3')`)).toBe(true);
    await page.evaluate(`_wloTold('e3')`);
    expect(await page.evaluate(`_ptList().includes('e3')`)).toBe(false);
  });

  // Give the place on the server (bug hunt 2026-11-18, app33-3; staff_give_spot, 20261119000700): the database counts the places
  // under the ride's promotion lock, so two desks never both give the last one. Its NO_PLACE says the ride is full and writes nothing.
  test('in Staff choose, Give the place goes through staff_give_spot when the database has it', async ({ page }) => {
    await open(page, 'staff', { sessions: [{ ...sessions[0], capacity: 3 }], 'rpc:staff_give_spot': { ok: true, id: 'e3' } });
    const w = writes(page);
    const calls: { name: string; body: unknown }[] = [];
    page.on('request', (r) => { const m = r.url().match(/\/rpc\/([^/?]+)/); if (m) calls.push({ name: m[1], body: r.postDataJSON() }); });
    await page.evaluate(`setStaffTab('queue');setSfSession('s1');doNoShow('e1')`);
    const dlg = page.locator('[role="dialog"][aria-labelledby="wlo-title"]');
    await dlg.locator('.rem-row').first().getByRole('button', { name: 'Give the place' }).click();
    await expect.poll(() => calls.find((c) => c.name === 'staff_give_spot')).toBeTruthy();
    expect(calls.find((c) => c.name === 'staff_give_spot')!.body).toEqual({ p_session_id: 's1', p_booking_id: 'e3' });
    await expect(dlg.getByText('Has the place now')).toBeVisible();
    expect(w.filter((x) => /"status":"waiting"/.test(x))).toHaveLength(0); // the database wrote it
  });

  test('in Staff choose, the database\'s NO_PLACE says the ride is full and gives nothing', async ({ page }) => {
    await open(page, 'staff', { sessions: [{ ...sessions[0], capacity: 3 }], 'rpc:staff_give_spot': { __rpcError: { status: 400, code: 'P0001', message: 'NO_PLACE' } } });
    const w = writes(page);
    await page.evaluate(`setStaffTab('queue');setSfSession('s1');doNoShow('e1')`);
    const dlg = page.locator('[role="dialog"][aria-labelledby="wlo-title"]');
    await dlg.locator('.rem-row').first().getByRole('button', { name: 'Give the place' }).click();
    await expect(page.getByText('The ride has no free place now.').first()).toBeVisible();
    await expect(dlg.getByText('Has the place now')).toHaveCount(0);
    expect(w.filter((x) => /"status":"waiting"/.test(x))).toHaveLength(0);
    expect(await page.evaluate(`_qGet('e3').status`)).toBe('waitlist');
  });

  test('in Automatic the next in line gets the place at once, as before', async ({ page }) => {
    await open(page, 'auto');
    const w = writes(page);
    await page.evaluate(`setStaffTab('queue');setSfSession('s1');doNoShow('e1')`);
    await expect.poll(() => w.find((x) => /"status":"waiting"/.test(x) && /id=eq\.e3/.test(x))).toBeTruthy();
    await page.waitForTimeout(900);
    await expect(page.locator('#wlo-title')).toHaveCount(0);
  });

  test('a free place with riders waiting shows on Bookings and in the bell', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [qe('e1', 1), qe('e3', 3, { status: 'waitlist', waitlist_num: 1 })], bikes: [], staff_options: [{ key: 'biz', items: { wl_offer_mode: 'staff' } }] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getQueue().length>0&&typeof _r7Bell==='function'`);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('s1')`);
    await expect(page.locator('.wl-open')).toContainText('1 free');
    const items = await page.evaluate(`(()=>{const out=[];_r7Bell((k,items)=>out.push([k,items.map(i=>i.id)]),{queue:true});return out;})()`);
    expect((items as unknown[])[1]).toEqual(['wlfree', ['wl:s1:1']]);
    if (await page.locator('.wl-open').isVisible()) await page.locator('.wl-open').click();
    else { await page.locator('#tab-queue .sh-more').click(); await page.getByRole('menuitem', { name: /free/ }).click(); } // a phone's Desk tools (staff round s10)
    await expect(page.locator('#wlo-title')).toBeVisible();
  });

  test('the timed offer reads as Staff until the database has its offers', async ({ page }) => {
    await open(page, 'claim');
    await page.evaluate(`openWlOffers('s1')`);
    await expect.poll(() => page.evaluate('_wlMode()')).toBe('staff');
    await expect(page.locator('#wlo-title')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Offer', exact: true })).toHaveCount(0);
  });

  test('Offer asks the database for a timed link, and Send opens WhatsApp with it', async ({ page }) => {
    const token = 'ab'.repeat(16);
    await open(page, 'claim', {
      waitlist_offers: [],
      'rpc:staff_offer_spot': { id: 'o1', booking_id: 'e3', session_id: 's1', token, offered_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 60000).toISOString(), status: 'open' },
    });
    const calls: { name: string; body: unknown }[] = [];
    page.on('request', (r) => { const m = r.url().match(/\/rpc\/([^/?]+)/); if (m) calls.push({ name: m[1], body: r.postDataJSON() }); });
    // a place frees up: the rider who had one cancels
    await page.evaluate(`S.queue=S.queue.map(e=>e.id==='e1'?{...e,status:'cancelled'}:e);openWlOffers('s1')`);
    const dlg = page.locator('[role="dialog"][aria-labelledby="wlo-title"]');
    await dlg.locator('.rem-row').first().getByRole('button', { name: 'Offer', exact: true }).click();
    await expect.poll(() => calls.find((c) => c.name === 'staff_offer_spot')).toBeTruthy();
    expect(calls.find((c) => c.name === 'staff_offer_spot')!.body).toEqual({ p_session_id: 's1', p_booking_id: 'e3' });
    await dlg.getByRole('button', { name: 'Send on WhatsApp' }).click();
    await expect.poll(() => page.evaluate('window.__opened.length')).toBe(1);
    const text = decodeURIComponent(((await page.evaluate('window.__opened[0]')) as string).split('text=')[1]);
    expect(text).toContain('/?claim=' + token + '&lang=en');
    expect(text).toMatch(/within (29|30) minutes/);
  });

  test('Settings offers the claim link only once the database has the offers', async ({ page }) => {
    await open(page);
    await page.evaluate(`S._staffAuthed=true;setStaffTab('settings');setSettingsView('business')`);
    const sel = page.locator('#biz-wl_offer_mode');
    await expect(sel).toHaveValue('auto'); // the default
    await expect.poll(() => sel.locator('option').count()).toBe(2);
  });

  test('with the offers in the database, an admin can choose the claim link', async ({ page }) => {
    await open(page, undefined, { waitlist_offers: [] });
    await page.evaluate(`S._staffAuthed=true;setStaffTab('settings');setSettingsView('business')`);
    await expect.poll(() => page.locator('#biz-wl_offer_mode option').count()).toBe(3);
  });
});
