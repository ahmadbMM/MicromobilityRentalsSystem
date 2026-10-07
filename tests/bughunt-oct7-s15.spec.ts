import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures, type FailWrite } from './helpers/supabase';

// Bug hunt 2026-10-07 (tags, merges, badges, ratings): regressions for the fixes in that range.
// All Supabase traffic is stubbed; every name, phone and email is invented.

const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false },
  { id: 'tag_blacklist', slug: 'blacklist', name: 'Blacklist', color: '#0b0b0b', locked: true, auto_grant: false },
];
const customers = [
  { id: 'c-mem', name: 'Member Rider', email: 'member.rider@example.com', phone: '+966551870001', gender: 'male', created_at: '2026-03-01T22:30:00Z' },
  { id: 'c-two', name: 'Second Rider', email: 'second.rider@example.com', phone: '+966551870002', gender: 'female', created_at: '2026-03-01T10:00:00Z' },
];
const customer_tags = [{ customer_id: 'c-mem', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 }];

async function boot(page: Page, fx: Fixtures = {}, fail?: FailWrite, path = '/') {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags, customers, customer_tags, staff_options: [], ...fx }, fail);
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
}
function writes(page: Page, table: string, method: string) {
  const n: string[] = [];
  page.on('request', (r) => { if (r.method() === method && new URL(r.url()).pathname.endsWith('/rest/v1/' + table)) n.push(r.url()); });
  return n;
}

test.describe('@staff:community bug hunt 2026-10-07', () => {
  test('a double tap on the tag grant writes it once', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
    const posts = writes(page, 'customer_tags', 'POST');
    await page.evaluate(`showTagGrantModal('c-two','tag_saturday')`);
    await page.evaluate(`Promise.all([saveTagGrant(),saveTagGrant()])`);
    expect(posts.length).toBe(1);
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    expect(await page.evaluate(`S.customerTags.filter(ct=>ct.customer_id==='c-two').length`)).toBe(1);
  });

  test('blacklisting a member whose Community removal is refused still closes the dialog and shows the blacklist', async ({ page }) => {
    await boot(page, {}, { table: 'customer_tags', methods: ['DELETE'] });
    await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
    await page.evaluate(`showTagGrantModal('c-mem','tag_blacklist')`);
    await page.evaluate(`saveTagGrant()`);
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    await expect(page.locator('#am-cust-rows .am-row[data-cust="c-mem"] .am-chip.tag-ban')).toHaveCount(1);
    // the refused removal left the Community tag on, as the database still has it
    expect(await page.evaluate(`S.customerTags.some(ct=>ct.customer_id==='c-mem'&&ct.tag_id==='tag_saturday')`)).toBe(true);
  });

  test('the merge card dates an account by its Riyadh day', async ({ page }) => {
    await boot(page);
    // 22:30 UTC on 1 March is 01:30 on 2 March in Riyadh
    const txt = await page.evaluate(`(()=>{const d=document.createElement('div');d.innerHTML=_mgAcctHtml(_custById('c-mem'));return d.textContent;})()`);
    expect(txt).toContain('2 Mar 2026');
    expect(txt).not.toContain('1 Mar 2026');
  });

  test('a double tap on a new badge\'s Save makes one badge, and dated windows take Arabic-Indic digits', async ({ page }) => {
    await boot(page, { badges: [], customer_badges: [] });
    const posts = writes(page, 'badges', 'POST');
    await page.evaluate(`S._bdgEdit={icon:'star',color:'green',rule:null,name:'Spec Badge'}`);
    await page.evaluate(`Promise.all([_bdgSave(),_bdgSave()])`);
    expect(posts.length).toBe(1);
    expect(await page.evaluate(`S.badges.filter(b=>b.name==='Spec Badge').length`)).toBe(1);
    const w = await page.evaluate(`(()=>{
      S._bdgEdit={icon:'star',color:'green',name:'Dated',rule:{rides:1,windows:[{from:'',to:''}]}};
      const f=document.createElement('input');f.id='bdg-w-f-0';f.value='\\u0662\\u0660\\u0662\\u0666-\\u0661\\u0662-\\u0660\\u0661';
      const t=document.createElement('input');t.id='bdg-w-t-0';t.value='\\u06F2\\u06F0\\u06F2\\u06F6-\\u06F1\\u06F2-\\u06F3\\u06F1';
      document.body.append(f,t);_bdgEditPull();f.remove();t.remove();
      return [S._bdgEdit.rule.windows[0],_bdgRuleOf(S._bdgEdit)];
    })()`) as [{ from: string; to: string }, unknown];
    expect(w[0]).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(w[1]).toEqual({ rides: 1, windows: [{ from: '2026-12-01', to: '2026-12-31' }] });
  });
});

const day = (d: number) => new Date(Date.now() - d * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const D1 = day(3);
const rq = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id, session_id: 'jcc-1', session_day: 'Tuesday', session_date: D1, queue_num: n, name: 'Rider ' + n, phone: '05512300' + n,
  customer_id: 'c-' + id, type_preference: 'Road', registered_at: D1 + 'T05:00:00Z', checked_out_at: D1 + 'T08:00:00Z', rated_at: D1 + 'T09:00:00Z',
  status: 'done', paid: true, price: 0, rating_bike: 8, rating_exp: 9, ...extra,
});
const rsessions = [{ id: 'jcc-1', day: 'Tuesday', session_date: D1, capacity: 40, status: 'closed', created_at: 1 }];
const rqueue = [rq('r1', 1), rq('r2', 2), rq('r3', 3), rq('w1', 4, { status: 'waiting' })];

test.describe('@staff:analytics bug hunt 2026-10-07', () => {
  test('the picked count and the pictures are the ratings on the list, not a pick kept from elsewhere', async ({ page }) => {
    await boot(page, { sessions: rsessions, queue_entries: rqueue }, undefined, '/analytics/ratings');
    await page.waitForFunction(`S.dataLoaded&&getQueue().length===4&&S.staffTab==='analytics'`);
    const tab = page.locator('#tab-analytics');
    await tab.locator('.rs-idle').click();
    // a pick kept from another range: a booking the list does not show
    await page.evaluate(`_rsSet().add('w1')`);
    await tab.locator('.rs-pick').nth(0).click();
    await tab.locator('.rs-pick').nth(1).click();
    await expect(tab.locator('.rs-n')).toHaveText('2 selected');
    await tab.locator('.rs-go').click();
    await expect(page.locator('#confirm-modal .rs-dlg .rs-sub')).toHaveText('One picture for each rating: 2');
  });

  test('a report the browser blocks leaves the ratings report dialog up to tap again', async ({ page }) => {
    await boot(page, { sessions: rsessions, queue_entries: rqueue }, undefined, '/analytics/ratings');
    await page.waitForFunction(`S.dataLoaded&&getQueue().length===4&&S.staffTab==='analytics'`);
    await page.locator('#tab-analytics .rr-open').click();
    await expect(page.locator('#print-opts-modal .rr-dlg')).toBeVisible();
    await page.evaluate(`window.open=()=>null`);
    await page.locator('#print-opts-modal .rr-print').click();
    await expect(page.locator('#toast-container')).toContainText('Tap again');
    await expect(page.locator('#print-opts-modal .rr-dlg')).toBeVisible();
  });
});
