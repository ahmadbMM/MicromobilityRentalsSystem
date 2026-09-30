import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

const fixtures = {
  sessions: [
    { id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1, location: 'JCC', addons: JSON.stringify(['i1']) },
    { id: 's2', day: 'Saturday', session_date: '2099-01-10', capacity: 2, status: 'full', created_at: 2, location: 'Sharafeyah Branch' },
  ],
  bikes: [{ id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 }],
  inventory: [{ id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 5, price: 8, low_threshold: 1 }],
  queue_entries: [
    { id: 'q1', name: 'Spec Rider', customer_id: 'c1', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 1, status: 'done', paid: true, price: 30, registered_at: '2099-01-09T10:00:00Z', addons: JSON.stringify([{ id: 'i1', qty: 1 }]) },
    { id: 'q2', name: 'Spec Rider', customer_id: 'c1', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 2, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-09T10:05:00Z' },
  ],
};

// The service worker's self-updater reloads the page when it detects a new deploy, unless it
// already reloaded this session. Programmatic .click() never sets its _userTouched flag, so in a
// test it would reload mid-run and destroy the context. Pre-set its own guard so it never fires.
async function noAutoReload(page: import('@playwright/test').Page) {
  await page.addInitScript(() => sessionStorage.setItem('cq_upd_reload', '1'));
}

// Deterministic chaos: random clicks + random text typed into visible inputs.
const MONKEY = (clicks: number, seed: number) => `(async()=>{
  let t=${seed}; const rnd=()=>{t|=0;t=t+0x6D2B79F5|0;let r=Math.imul(t^t>>>15,1|t);r=r+Math.imul(r^r>>>7,61|r)^r;return((r^r>>>14)>>>0)/4294967296;};
  const junk=['','0','-1','٩٩٩','<b>x</b>','\\u200Fمرحبا','999999999999','a@b','  spaces  ','\\'"; drop--'];
  for(let i=0;i<${clicks};i++){
    // #lang-btn is left out: picking a language that loads a pack reloads the page on purpose
    // (/?lang=pt), which ends the run the way window.open or a sign-out would.
    const inputs=[...document.querySelectorAll('input:not([disabled]),select:not([disabled]):not(#lang-btn)')].filter(e=>e.offsetParent!==null);
    if(inputs.length&&rnd()<0.35){
      const el=inputs[Math.floor(rnd()*inputs.length)];
      try{ if(el.tagName==='SELECT'){const o=el.options[Math.floor(rnd()*el.options.length)];if(o){el.value=o.value;el.dispatchEvent(new Event('change',{bubbles:true}));}}
        else{el.value=junk[Math.floor(rnd()*junk.length)];el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));} }catch(e){}
      continue;
    }
    const btns=[...document.querySelectorAll('button:not([disabled])')].filter(b=>b.offsetParent!==null);
    if(!btns.length)break;
    try{btns[Math.floor(rnd()*btns.length)].click();}catch(e){}
    await new Promise(r=>setTimeout(r,15));
  }
})()`;

for (const lang of ['en', 'ar']) {
  test(`monkey(${lang}): 120 chaotic customer-side actions, zero page errors`, async ({ page }) => {
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
    await stubSupabase(page, fixtures);
    await loginCustomer(page, { id: 'c1' });
    await noAutoReload(page);
    await page.addInitScript((l) => localStorage.setItem('cq_lang', l), lang);
    await page.goto('/');
    await waitForSb(page);
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.evaluate(`window.open=()=>null;window.print=()=>{};doLogout=()=>{};signInGoogle=()=>{};signInApple=()=>{};_formHandoff=async()=>{};`); // _formHandoff leaves for the website's forms
    await page.evaluate(MONKEY(120, lang === 'ar' ? 4242 : 1717));
    expect(errs, errs.join('\n')).toEqual([]);
  });

  test(`monkey(${lang}): 120 chaotic staff-panel actions incl. inputs, zero page errors`, async ({ page }) => {
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
    await stubSupabase(page, fixtures);
    await unlockStaff(page);
    await noAutoReload(page);
    await page.addInitScript((l) => localStorage.setItem('cq_lang', l), lang);
    await page.goto('/?staff');
    await waitForSb(page);
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.evaluate(`window.open=()=>null;window.print=()=>{};lockStaff=async()=>{};doLogout=()=>{};signInGoogle=()=>{};signInApple=()=>{};`);
    await page.evaluate(MONKEY(120, lang === 'ar' ? 9001 : 5150));
    expect(errs, errs.join('\n')).toEqual([]);
  });
}

test('Arabic end-to-end: full booking flow in RTL', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  // Dedicated fixtures: this customer must have NO existing booking in the session, or the
  // register tab shows the "modify existing booking" path instead of a fresh booking.
  await stubSupabase(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1, location: 'JCC' }],
    bikes: [{ id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 }],
    queue_entries: [],
  });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await noAutoReload(page);
  await page.addInitScript(() => localStorage.setItem('cq_lang', 'ar'));
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('register')`);
  expect(await page.evaluate('document.documentElement.dir')).toBe('rtl');

  await page.locator('.sess-card').first().click();
  await page.locator('button', { hasText: 'متابعة' }).first().click();     // Continue (regNextFromSession)
  await page.fill('#reg-height-0', '175');
  await page.locator('[data-type-slot="0"][data-type="Hybrid"]').click();
  await page.locator('button', { hasText: 'مراجعة الحجز' }).click();        // Review booking (regNextToReview)
  await page.locator('#tab-register input[type="checkbox"]').check();        // the ride waiver
  await page.locator('#tab-register .mm-reg-foot .btn-primary').click();     // متابعة (regWaiverContinue)
  await page.locator('button', { hasText: 'تأكيد الحجز' }).click();          // Confirm booking (submitReg)
  await expect(page.locator('#tab-register')).toContainText('Spec Rider');
  expect(errs, errs.join('\n')).toEqual([]);
});
