import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Bug hunt 2026-10-14 (s18): Analytics Reports and Months, the Height & bike report.
const json = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

async function boot(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, fx);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@bh14 s18 analytics', () => {
  test('a failed Reports read is not asked again round and round while the view is open', async ({ page }) => {
    await boot(page);
    let reads = 0;
    await page.route(/\/rest\/v1\/report_snapshots/, (r) => {
      if (r.request().url().includes('period_to')) reads++; // the inbox's read, not the bell's
      return r.fulfill({ status: 404, headers: json, body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.report_snapshots' in the schema cache" }) });
    });
    await page.evaluate(`setStaffTab('analytics');setAnView('reports')`);
    await expect(page.locator('#an-rp-host')).toContainText('Waiting for the database update.');
    await page.waitForTimeout(1500);
    expect(reads).toBeLessThanOrEqual(2); // it used to ask again after every answer, dozens a second
  });

  test('a Months read that failed is asked again later instead of loading for ever', async ({ page }) => {
    await boot(page);
    await page.evaluate(`(()=>{const m=S._anSrv||(S._anSrv=new Map());m.clear();S._anSrvOff=false;
      const real=sb.rpc.bind(sb);window.__calls=0;sb.rpc=(fn,a)=>{if(fn==='staff_monthly_totals'){window.__calls++;return Promise.resolve({data:null,error:{message:'Failed to fetch'}});}return real(fn,a);};
      const st=window.setTimeout;window.setTimeout=(f,d,...x)=>d===30000?(window.__retry=f,0):st(f,d,...x);
      _anSrv('2024-01-01','2024-02-01');})()`);
    await expect.poll(() => page.evaluate(`typeof window.__retry`)).toBe('function');
    expect(await page.evaluate(`[_anSrv('2024-01-01','2024-02-01'),window.__calls]`)).toEqual([null, 1]); // kept a while: no ask-paint loop
    await page.evaluate(`window.__retry()`); // the thirty seconds are up
    await page.evaluate(`_anSrv('2024-01-01','2024-02-01')`);
    expect(await page.evaluate(`window.__calls`)).toBe(2);
  });

  test('the month names under the Months chart carry no stray words (Portuguese)', async ({ page }) => {
    await boot(page);
    const html = await page.evaluate(`(()=>{const m=S._anSrv||(S._anSrv=new Map());S._anSrvOff=false;
      m.set(AN_EPOCH+'|'+todayStr(),{rows:[{month:todayStr().slice(0,7),rides:3,riders:2,rev_rides:100,rev_sales:0,noshows:0,cancellations:0,seats:10,bookings:3}],total:null});
      S.lang='pt';return _anMonthsView();})()`) as string;
    expect(html).not.toMatch(/\. de</);
  });

  test('a blocked pop-up for the Height & bike report says so', async ({ page }) => {
    await boot(page);
    await page.evaluate(`window.open=()=>null;_anHeightBikeData=()=>[{sess:{day:'Monday',session_date:'2026-10-12',id:'x'},people:[],typeCounts:{},other:0,rented:0,hSummary:{count:0},hRanges:[]}];printHeightBikeReport()`);
    await expect(page.locator('.toast').last()).toBeVisible();
  });
});
