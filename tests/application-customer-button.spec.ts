import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A Customer button on every application card (the user, 2026-11-27: "add a customer button on all applications that can
// do anything to a customer account", then "adding tags is included"). It opens the account window, whose bar and More
// hold every action on the account: edit, tags, wallet, badges, a new booking, a follow-up, flag, merge. A card with no
// account (a pending applicant who has none yet) has no button. All Supabase traffic is stubbed.

const customers = [
  { id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', height: 165, created_at: '2026-01-05T10:00:00Z' },
];
const base = {
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12',
  gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
  customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect',
};
const apps = [
  { ...base, id: 'a1', status: 'pending', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013' },
  { ...base, id: 'a2', status: 'pending', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', gender: 'female' },
];

async function staff(page: Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: apps });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
}

test.describe('@staff:people the Customer button on applications', () => {
  test('a community application with an account opens the account window, tags included; one without has none', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
    const row = (id: string) => page.locator(`.ca-row[data-app-id="${id}"]`);
    await expect(row('a2')).toBeVisible();
    await expect(row('a1').locator('.app-cust-btn')).toHaveCount(0);
    const btn = row('a2').locator('.ca-actions .app-cust-btn');
    await expect(btn).toHaveText('Customer');
    await btn.click();
    const win = page.locator('#cust-modal');
    await expect(win.locator('.modal-box')).toBeVisible(); // the container is an empty box; visibility is the dialog's
    await expect(win).toContainText('Huda Al Saleh');
    expect(await page.evaluate('S._ah&&S._ah.custId')).toBe('c1');
    // Every action on the account is there: edit, and the tags (More's account group)
    await expect(win.getByRole('button', { name: 'Edit customer' }).first()).toBeVisible();
    await win.locator('.n6p-bar .sh-more').click(); // tags sit in More's account group
    const tags = page.getByRole('menuitem', { name: 'Tags', exact: true });
    await expect(tags).toBeVisible();
    await tags.click();
    await expect.poll(() => page.evaluate('!!S._n6pAhTags')).toBe(true); // the window's tag editor is open
  });

  test('learning to ride, volunteers, ambassadors, badge requests and mentorship cards carry it too', async ({ page }) => {
    await staff(page);
    await page.evaluate('_loadStaffParts()');
    await page.waitForFunction(`['_laRow','_vaRow','_ambRow','_bdrStRow','_mtsCard'].every(n=>typeof window[n]==='function')`);
    const html: Record<string, string> = await page.evaluate(`(()=>{
      const out={},one=(k,f)=>{try{out[k]=f();}catch(e){out[k]='ERR '+e;}};
      one('la',()=>_laRow({id:'l1',status:'approved',name:'Huda Al Saleh',customer_id:'c1',created_at:'2026-11-01T08:00:00Z'}));
      one('va',()=>_vaRow({customer_id:'c1',status:'applied',profile_at:'2026-11-01T08:00:00Z',days:[]}));
      one('amb',()=>_ambRow({id:'m1',status:'pending',name:'Huda Al Saleh',phone:'+966551239876',customer_id:'c1',created_at:'2026-11-01T08:00:00Z'}));
      S.badges=[{id:'b1',slug:'marshal',icon:'flag',color:'green',name:'Marshal',system:true,auto:false,sort:10}];
      one('bdr',()=>_bdrStRow({id:9,badge_id:'b1',customer_id:'c1',status:'pending',created_at:'2026-11-01T08:00:00Z'}));
      one('mts',()=>_mtsCard({id:'p1',status:'open',customer_id:'c1',university:'KAU',field:'Law',city:'Jeddah',country:'SA',class_year:2027,helps:[],gender_pref:'any',created_at:'2026-11-01T08:00:00Z'},[],{},false));
      return out;})()`);
    expect(Object.keys(html)).toHaveLength(5);
    for (const [k, h] of Object.entries(html)) {
      expect(h, k).not.toMatch(/^ERR/);
      expect(h, k).toContain('app-cust-btn');
      expect(h, k).toContain('openAccountHistory');
    }
  });
});
