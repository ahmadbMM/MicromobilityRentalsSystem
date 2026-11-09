import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, captureBookingRows } from './helpers/supabase';

test.describe('overbooking guard', () => {
  const mk = (cap: number, booked: number) => ({
    sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: cap, status: 'open', created_at: 1 }],
    queue_entries: Array.from({ length: booked }, (_, i) => ({
      id: 'e' + i, name: 'R' + i, session_id: 's1', session_day: 'Friday', session_date: '2099-01-09',
      queue_num: i + 1, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-09T10:00:00Z',
    })),
  });

  test('booking a session at capacity goes to the waitlist even if status is still open', async ({ page }) => {
    await stubSupabase(page, mk(2, 2)); // capacity 2, 2 booked, status NOT marked full
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    const inserts = await captureBookingRows(page);
    await page.evaluate(`S.selSession='s1';S.regQty=1;S.regBikeHeights=[175];S.regBikeTypes=['Hybrid'];S.regRiderNames=['Spec Rider'];`);
    await page.evaluate('S.waiverOk=true;submitReg()');
    await expect.poll(() => inserts.length).toBeGreaterThanOrEqual(1);
    expect(inserts[0].status).toBe('waitlist'); // was 'waiting' → overbooked
  });

  test('a group larger than the remaining spots also waitlists', async ({ page }) => {
    await stubSupabase(page, mk(3, 2)); // 1 spot left, group of 2
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    const inserts = await captureBookingRows(page);
    await page.evaluate(`S.selSession='s1';S.regQty=2;S.regBikeHeights=[175,170];S.regBikeTypes=['Hybrid','Road'];S.regRiderNames=['A B','C D'];`);
    await page.evaluate('S.waiverOk=true;submitReg()');
    await expect.poll(() => inserts.length).toBe(2);
    expect(inserts.every((r) => r.status === 'waitlist')).toBe(true);
  });

  test('a session with room books normally', async ({ page }) => {
    await stubSupabase(page, mk(5, 2));
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    const inserts = await captureBookingRows(page);
    await page.evaluate(`S.selSession='s1';S.regQty=1;S.regBikeHeights=[175];S.regBikeTypes=['Hybrid'];S.regRiderNames=['Spec Rider'];`);
    await page.evaluate('S.waiverOk=true;submitReg()');
    await expect.poll(() => inserts.length).toBeGreaterThanOrEqual(1);
    expect(inserts[0].status).toBe('waiting');
  });
});

test('switching language mid-signup keeps everything typed', async ({ page }) => {
  await stubSupabase(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('openAuthModal();switchAuthMode("signup")');
  await page.fill('#a-first', 'Faisal');
  await page.fill('#a-last', 'Babalghoum');
  await page.fill('#a-email', 'faisal@example.com');
  await page.fill('#a-phone', '0508566560');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.evaluate('setLang("ar")'); // re-renders the open modal
  expect(await page.evaluate('document.getElementById("a-first").value')).toBe('Faisal');
  expect(await page.evaluate('document.getElementById("a-last").value')).toBe('Babalghoum');
  expect(await page.evaluate('document.getElementById("a-email").value')).toBe('faisal@example.com');
  expect(await page.evaluate('document.getElementById("a-pwd").value')).toBe('Zq8xTselah');
  // mode switches still start clean
  await page.evaluate('switchAuthMode("login");switchAuthMode("signup")');
  expect(await page.evaluate('document.getElementById("a-first").value')).toBe('');
});

test('monkey: 40 random staff-panel clicks produce zero page errors', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await stubSupabase(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }],
    bikes: [{ id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 }],
    inventory: [{ id: 'i1', name: 'Gel', category: 'EnergyGels', qty: 5, price: 8, low_threshold: 1 }],
    queue_entries: [{ id: 'q1', name: 'Sara', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 1, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-09T10:00:00Z' }],
  });
  await unlockStaff(page);
  await page.goto('/?staff');
  await waitForSb(page);
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.evaluate(`window.open=()=>null; window.print=()=>{}; lockStaff=async()=>{}; doLogout=()=>{}; `); // no popups/print/navigation (incl. the OAuth redirects on the auth-first landing)
  // Deterministic pseudo-random clicker (mulberry32 seed) over visible buttons
  await page.evaluate(`(async()=>{
    let t=1337; const rnd=()=>{t|=0;t=t+0x6D2B79F5|0;let r=Math.imul(t^t>>>15,1|t);r=r+Math.imul(r^r>>>7,61|r)^r;return((r^r>>>14)>>>0)/4294967296;};
    for(let i=0;i<40;i++){
      const btns=[...document.querySelectorAll('button:not([disabled])')].filter(b=>b.offsetParent!==null);
      if(!btns.length)break;
      const b=btns[Math.floor(rnd()*btns.length)];
      try{b.click();}catch(e){}
      await new Promise(r=>setTimeout(r,25));
    }
  })()`);
  expect(errs, errs.join('\n')).toEqual([]);
});
