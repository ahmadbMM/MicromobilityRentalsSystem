import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The People review (2026-11-06, PP01-PP09): saved views start from a clean slate, the server's whole riding record
// per account, the account window as a profile (details, action bar, notes, stage, a link of its own), a fuller
// duplicate finder with "Not the same person", and the October leftovers. Invented people only.

const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const TD = day(0), P1 = day(-10);
const sessions = [
  { id: TD, day: 'Friday', session_date: TD, capacity: 40, status: 'open', created_at: 0 },
  { id: P1, day: 'Monday', session_date: P1, capacity: 40, status: 'open', created_at: 1 },
];
const OLD = '2025-01-10T09:00:00Z';
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', gender: 'female', height: 170, type_preference: 'Road', created_at: OLD, workplace: 'Acme Labs', socials: { instagram: 'lina_rides' } },
  { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', gender: 'male', created_at: OLD },
  { id: 'c3', name: 'Sara Ali', email: 'sara.ali@gmail.com', phone: '+966500000001', gender: 'female', created_at: OLD },
  { id: 'c4', name: 'Sara A', email: 'SaraAli+bike@gmail.com', phone: '+966511111112', gender: 'female', created_at: OLD },
  { id: 'c5', name: 'New Person', email: 'new.person@gmail.com', phone: '+966522222223', gender: 'male', created_at: new Date().toISOString() },
];
const row = (id: string, s: { id: string; day: string; session_date: string }, qn: number, name: string, customer_id: string, status: string) => ({
  id, session_id: s.id, session_day: s.day, session_date: s.session_date, queue_num: qn, name, phone: '', customer_id, status,
  paid: status === 'done', type_preference: 'Road', price: 100, walk_in: false, registered_at: '2026-09-01T10:00:00Z',
});
const queue_entries = [
  row('q1', sessions[0], 1, 'Lina Haddad', 'c1', 'waiting'),
  row('q2', sessions[1], 2, 'Lina Haddad', 'c1', 'done'),
];
const notes = [{ id: 7, created_at: '2026-11-01T08:00:00Z', kind: 'customer', target_id: 'c1', body: 'Needs the small helmet', author_id: 'u1', author_name: 'Huda' }];

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries, bikes: [], customers, tags: [], customer_tags: [], staff_options: [], staff_comments: notes, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===5&&(S.queue||[]).length===2');
}

test.describe('@staff:people People review', () => {
  test('a saved view clears every filter it does not set, on Accounts and on Sessions (PP01)', async ({ page }) => {
    await boot(page);
    await page.evaluate(`localStorage.setItem('cq_views',JSON.stringify([{id:'v1',sec:'accounts',name:'Members',state:{amMember:'yes'}},{id:'v2',sec:'sessions',name:'Find',state:{sessQ:'lap'}}]))`);
    await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
    await page.evaluate(`S.amNat='Saudi';S.amGender='female';S.amSuspect=true;_svPick('accounts','v1')`);
    expect(await page.evaluate('[S.amMember,S.amNat,S.amGender,S.amSuspect]')).toEqual(['yes', '', '', false]);
    await page.evaluate(`S.sessKind='community';S.sessFill='full';_svPick('sessions','v2')`);
    expect(await page.evaluate('[S.sessQ,S.sessKind,S.sessFill]')).toEqual(['lap', 'all', 'all']);
  });

  test('the server\'s record lifts the list and the window above what the device holds (PP02)', async ({ page }) => {
    await boot(page, { 'rpc:staff_customer_stats': [['c2', 7, 5, 1, '2025-02-01', '2025-06-01', 2, 1, 300, 500]] });
    await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
    await page.waitForFunction('S._n6pCs&&S._n6pCs.size===1');
    expect(await page.evaluate(`(()=>{const s=_amStOf(_custById('c2'));return[s.rides,s.lastRide,s.noshows,s.bookings]})()`)).toEqual([5, '2025-06-01', 2, 7]);
    // the device's own count still wins where it knows more (c1 rode once here, the server says nothing of her)
    expect(await page.evaluate(`_amStOf(_custById('c1')).rides`)).toBe(1);
    await page.evaluate(`openAccountHistory('c2')`);
    await expect(page.locator('#cust-modal .ah-kpi-v').first()).toHaveText('5');
    // and it is not asked again within ten minutes
    const asked = await page.evaluate('_n6pCsAt');
    await page.evaluate('renderCommunity()');
    expect(await page.evaluate('_n6pCsAt')).toBe(asked);
  });

  test('the window is a profile: details, actions, the newest note, the stage; tags repaint it (PP03, PP06, PP07, PP08)', async ({ page }) => {
    await boot(page, { tags: [{ id: 't9', name: 'Helper', color: '#2f63ad' }] });
    await page.evaluate(`setStaffTab('queue')`);
    // the account's newest note on the Bookings row
    await expect(page.locator('.n6p-pin').first()).toContainText('Needs the small helmet');
    await page.evaluate(`openAccountHistory('c1')`);
    const m = page.locator('#cust-modal');
    await expect(m.locator('.n6p-det')).toContainText('Acme Labs');
    await expect(m.locator('.n6p-det')).toContainText('lina_rides');
    await expect(m.locator('.n6p-notes')).toContainText('Needs the small helmet');
    await expect(m.locator('.n6p-bar')).toContainText('Edit customer'); // Call, WhatsApp and Edit in sight, the rest in More (staff round s10)
    await m.locator('.n6p-bar .sh-more').click();
    await expect(page.locator('.row-sheet')).toContainText('New booking');
    await page.locator('.row-sheet-close').click();
    await expect(m.locator('.n6p-stage')).toHaveText('First rides');
    await expect(m.locator('.am-chips')).toHaveCount(0);
    await page.evaluate(`S.customerTags=[{customer_id:'c1',tag_id:'t9',added_at:Date.now()}];renderCommunity()`);
    await expect(m.locator('.am-chips')).toContainText('Helper');
  });

  test('opened from Bookings the window reads the applications and says a hidden one (PP04)', async ({ page }) => {
    await boot(page, {
      community_applications: [{ id: 'a1', created_at: '2026-10-01T10:00:00Z', status: 'pending', name: 'Lina Haddad', customer_id: 'c1', hidden_at: '2026-10-02T10:00:00Z' }],
      learn_applications: [{ id: 'l1', created_at: '2026-10-03T10:00:00Z', status: 'pending', name: 'Lina Haddad', customer_id: 'c1' }],
    });
    await page.evaluate(`setStaffTab('queue');openAccountHistory('c1')`);
    const c = page.locator('#cust-modal .ppl-ah-comm');
    await expect(c).toContainText('Application hidden by staff');
    await expect(c).toContainText('Learn to ride: Pending');
  });

  test('a /people/a/<id> link opens that account (PP06)', async ({ page }) => {
    await boot(page);
    await page.goto('/people/a/c1');
    await waitForSb(page);
    await expect(page.locator('#cust-modal #ah-title')).toHaveText('Lina Haddad');
  });

  test('stages filter Accounts, and the new-account tiles open it (PP05, PP08)', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('community');S.communityTab='summary';renderCommunity()`); // the figures are People's Summary (staff round s10)
    await page.locator('#tab-community .dash-kpi', { hasText: 'New this week' }).click();
    expect(await page.evaluate('[S.communityTab,S.amJoined]')).toEqual(['accounts', '7']);
    await expect(page.locator('#am-cust-rows .am-row')).toHaveCount(1);
    await page.evaluate(`_n6pStageGo('never')`);
    await expect(page.locator('#am-cust-rows .am-row')).toHaveCount(3); // c2, c3, c4: old accounts, no ride
    await expect(page.locator('#am-cust-rows .n6p-stage').first()).toHaveText('Never rode');
  });

  test('duplicates match a Gmail address with dots or a +tag, and "Not the same person" puts them away (PP09)', async ({ page }) => {
    await boot(page);
    await page.evaluate(`isAdmin=()=>true;setStaffTab('community');S.communityTab='duplicates';renderCommunity()`);
    const g = page.locator('#tab-community .mg-group');
    await expect(g).toHaveCount(1);
    await expect(g.locator('.mg-why')).toContainText('Same email');
    await g.locator('.n6p-notsame').click();
    await page.locator('.chrome-dact button.chrome-mw100').last().click();
    await expect(g).toHaveCount(0);
    expect(await page.evaluate(`_optList('dup_ok').map(x=>x.k)`)).toEqual(['c3|c4']);
  });

  test('names fold across Arabic and Latin with the same last seven digits (PP09)', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`_n6pFold('محمد العتيبي')===_n6pFold('Mohammed Alotaibi')`)).toBe(true);
    expect(await page.evaluate(`_n6pMail('Sara.Ali+x@googlemail.com')`)).toBe('saraali@gmail.com');
  });
});
