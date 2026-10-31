import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Applications froze the staff page and killed phone tabs (2026-10-31). Each pending card asked for the
// Instagram counts while they loaded, so 259 pending cards queued 259 repaints of the whole list (about 30 s
// on a desktop); each card also scanned every account up to four times and every booking once. The list now
// asks once per paint, finds accounts and revoked invitations by index, draws 40 cards at a time, and a tick
// redraws the bulk bar only.

const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false }];
const base = {
  submissions: 1, height: 178, gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true,
  decided_at: null, decided_by: null, customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect',
  status: 'pending', linkedin: '', workplace: 'Aramco',
};
const N = 95;
const apps = Array.from({ length: N }, (_, i) => ({
  ...base, id: 'a' + i, name: 'Applicant ' + String(i).padStart(3, '0'), email: `ap${i}@example.test`, phone: '+9665524' + String(10000 + i),
  instagram: 'ig_' + i, birth_date: '1990-01-01', created_at: new Date(Date.UTC(2026, 9, 1, 0, N - i)).toISOString(), updated_at: null,
}));
const igRows = [{ customer_id: 'c1', handle: 'ig_1', followers: 10, status: 'ok', checked_at: '2026-10-30T10:00:00Z' }];

async function boot(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [], tags, customer_tags: [], community_applications: apps });
  // The counts arrive after a network's delay, as on a phone; the stub answers each page as asked.
  await page.route(/customer_ig_followers/, async (r) => {
    await new Promise((res) => setTimeout(res, 400));
    const u = new URL(r.request().url()), o = +(u.searchParams.get('offset') || 0), l = +(u.searchParams.get('limit') || 1e9);
    await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(igRows.slice(o, o + l)) });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`localStorage.removeItem('cq_ca_view');S._caV=null;S.igRows=null;S._igAt=0;S._igBusy=false;
    window.__paints=0;const o=_caListPaint;window._caListPaint=function(){window.__paints++;return o.apply(this,arguments)};
    setStaffTab('community');setCommTab('applications')`);
  await expect(page.locator('#ca-list .ca-row').first()).toBeVisible();
}

test.describe('@staff:community applications at production size', () => {
  test('the Instagram counts repaint the list once, however many pending cards are drawn', async ({ page }) => {
    await boot(page);
    await page.waitForFunction('!!S.igRows');
    await page.waitForTimeout(200);
    expect(await page.evaluate('window.__paints')).toBeLessThanOrEqual(1);
  });

  test('40 cards at a time; Show more adds the next ones; another list, search or filter starts at the top', async ({ page }) => {
    await boot(page);
    const rows = page.locator('#ca-list .ca-row');
    await expect(rows).toHaveCount(40);
    await expect(page.locator('#ca-list')).toContainText('Showing 40 of 95');
    // The pill still counts every match, not the cards drawn.
    await expect(page.locator('[data-ca-filter="pending"]')).toContainText('(95)');
    await page.locator('#ca-list .ap-more').click();
    await expect(rows).toHaveCount(80);
    await page.locator('#ca-list .ap-more').click();
    await expect(rows).toHaveCount(95);
    await expect(page.locator('#ca-list .ap-more')).toHaveCount(0);
    // A search starts again at the top of its own list.
    await page.locator('#ca-q').fill('Applicant 00');
    await expect(rows).toHaveCount(10);
    await page.locator('#ca-q').fill('');
    await expect(rows).toHaveCount(40);
    // Select all ticks every pending application the list holds, not only the cards drawn.
    await page.evaluate(`_caSelAll(true)`);
    await expect(page.locator('.ca-bulk')).toContainText('95');
  });

  test('a tick redraws the bulk bar and leaves the cards alone', async ({ page }) => {
    await boot(page);
    await page.waitForFunction('!!S.igRows'); // the counts' own repaint is done
    await page.waitForTimeout(200);
    await page.evaluate(`document.querySelector('#ca-list .ca-row[data-app-id="a1"]').dataset.witness='1'`);
    await page.locator('#ca-list .ca-row[data-app-id="a0"] .ca-sel input').check();
    await expect(page.locator('.ca-bulk')).toContainText('1');
    await expect(page.locator('.ca-bulk .btn-primary')).toContainText('(1)');
    expect(await page.evaluate(`document.querySelector('#ca-list .ca-row[data-app-id="a1"]').dataset.witness`)).toBe('1');
    await page.locator('#ca-list .ca-row[data-app-id="a0"] .ca-sel input').uncheck();
    await expect(page.locator('.ca-bulk .btn-primary')).toHaveCount(0);
  });

  test('the account an application lands on, found by index as the scans found it', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`(()=>{
      S.customers=[
        {id:'k0',name:'No Email',email:'',phone:'+966500000001'},
        {id:'k1',name:'By Email',email:' Same@Example.test ',phone:'+966500000002'},
        {id:'k2',name:'Second Same Email',email:'same@example.test',phone:'+966500000003'},
        {id:'k3',name:'By Apple',email:'x@privaterelay.appleid.com',apple_email:'apple@example.test',phone:''},
        {id:'k4',name:'By Phone',email:'p@example.test',phone:'+966 50 000 0009'},
      ];
      const f=a=>{const c=_caAcct(a);return c?c.id:null;};
      return{
        own:f({customer_id:'k4',email:'same@example.test'}),
        email:f({email:'SAME@example.test'}),
        apple:f({email:'apple@example.test'}),
        phone:f({email:'none@example.test',phone:'966500000009'}),
        noEmail:f({email:'',phone:''}),
        none:f({email:'nobody@example.test',phone:'+966511111111'}),
      };})()`);
    expect(r).toEqual({ own: 'k4', email: 'k1', apple: 'k3', phone: 'k4', noEmail: null, none: null });
  });

  test('a tag check still honours a tag that has lapsed or not started', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`(()=>{
      const now=Date.now();
      S.customerTags=[{customer_id:'t1',tag_id:'tag_vip',starts_at:null,expires_at:null},
        {customer_id:'t2',tag_id:'tag_vip',starts_at:null,expires_at:now-1000},
        {customer_id:'t3',tag_id:'tag_vip',starts_at:now+86400000,expires_at:null}];
      return[_hasTagNow('t1','tag_vip'),_hasTagNow('t2','tag_vip'),_hasTagNow('t3','tag_vip'),_hasTagNow('t1','tag_saturday')];})()`);
    expect(r).toEqual([true, false, false, false]);
  });

  test('a stamp reads as it did, in English and Arabic', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`(()=>{
      const iso='2026-10-31T17:05:00Z',o={timeZone:KSA_TZ,day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false};
      const out=[];for(const lg of ['en','ar']){S.lang=lg;out.push(fmtStamp(iso)===new Date(iso).toLocaleString(_locale(),o));}
      S.lang='en';out.push(fmtStamp('not a date'),fmtStamp(''));return out;})()`);
    expect(r).toEqual([true, true, '', '']);
  });
});
