import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Bug hunt 2026-10-14 (s09): the booking editor's names and emptied boxes, the walk-in type pills,
// the kiosk's "ride gone" message, and the learn-to-ride schedule dialog's learner lines.

const LIVE = '2099-03-01';
const sess = (id: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Sunday', session_date: id.slice(0, 10), status: 'open', capacity: 20, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...extra,
});
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: 1, name: 'Rider ' + id,
  phone: '0550000000', customer_id: null, type_preference: 'Road', status: 'waiting', paid: false,
  price: 75, size: 'M', height: 175, registered_at: '2099-01-01T10:00:00Z', ...extra,
});
async function boot(page: Page, fx: Fixtures) {
  await stubSupabase(page, { bikes: [], customers: [], tags: [], customer_tags: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
function patches(page: Page, table: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'PATCH' || !new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) return;
    try { out.push(r.postDataJSON() as Record<string, unknown>); } catch { /* none */ }
  });
  return out;
}

test.describe('@bh14 s09', () => {
  test('the booking editor saves a name as letters and spaces, and an emptied phone survives a type tap', async ({ page }) => {
    await boot(page, { sessions: [sess(LIVE)], queue_entries: [row('b1', { name: 'Old Name' })] });
    await page.waitForFunction('getQueue().length===1');
    const sent = patches(page, 'queue_entries');
    await page.evaluate(`setStaffTab('queue');showBookingEditModal('b1')`);
    await page.locator('#be-phone').fill('');
    await page.locator('#booking-edit-modal [data-on-click*="_on_showBookingEditModal_1"]').filter({ hasText: /Hybrid/ }).first().click();
    await expect(page.locator('#be-phone')).toHaveValue('');
    await page.evaluate(`document.getElementById('be-name').value='Sara-Al 2 Harbi';saveBookingEdit()`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0].name).toBe('Sara Al Harbi');
    expect(sent[0].phone).toBe('');
  });

  test('a walk-in type pick wears the drawn classes, with no inline colours', async ({ page }) => {
    await boot(page, { sessions: [sess(LIVE)], queue_entries: [] });
    await page.waitForFunction('S.dataLoaded');
    await page.evaluate(`S.sfSession=${JSON.stringify(LIVE)};showWalkinModal();_wiSetType('Road')`);
    const road = page.locator('#walkin-modal [data-wi-type="Road"]');
    await expect(road).toHaveClass('dk-wi-ty-on');
    await expect(road).not.toHaveAttribute('style', /.+/);
    await expect(page.locator('#walkin-modal [data-wi-type="Any"]')).toHaveClass('dk-wi-ty');
  });

  test('the kiosk says the ride has gone when it went while the rider was on the waiver', async ({ page }) => {
    await boot(page, { sessions: [sess(LIVE)], queue_entries: [] });
    await page.waitForFunction('S.dataLoaded');
    const err = await page.evaluate(`(()=>{const h=document.createElement('div');h.id='kiosk';document.body.appendChild(h);
      S._kiosk={lang0:S.lang};_koReset(true);const K=S._kiosk;K.step='waiver';K.sid='no-such-ride';K.acct={id:'c1',name:'A B'};
      _koSubmit();return [K.step,K.err,(document.querySelector('#kiosk .ko-err')||{}).textContent||''];})()`) as string[];
    expect(err[0]).toBe('ride');
    expect(err[1]).not.toBe('');
    expect(err[2]).toBe(err[1]);
    await page.evaluate(`clearTimeout(S._kiosk.timer);S._kiosk=null;document.getElementById('kiosk').remove()`);
  });

  test('the lesson dialog leaves out a learner age and level that were not given', async ({ page }) => {
    await boot(page, { sessions: [sess(LIVE)], queue_entries: [] });
    await page.waitForFunction('S.dataLoaded');
    const sub = await page.evaluate(`(()=>{S._laApps=[{id:'la1',status:'pending',name:'Huda Ali',for_whom:'child',learner_name:'Sara Ali',learner_age:null,level:null,lang:'en',created_at:'2099-01-01T10:00:00Z'}];
      _laSchedule('la1');return (document.querySelector('#confirm-modal .ca-msg-sub')||{}).textContent||'';})()`) as string;
    expect(sub).toContain('Sara Ali');
    expect(sub).not.toContain('undefined');
    expect(sub.trim().endsWith('·')).toBe(false);
  });
});
