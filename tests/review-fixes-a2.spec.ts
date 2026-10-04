import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, waitForSb, loadStaffHalf, unlockStaff, type Fixtures, type FailWrite } from './helpers/supabase';

// Fixes from the review of the auth, staff-list and topbar code (2026-10-04): the W box, the party's
// Paid, the day sheet's order, the house PIN on a desk row, Back to login, the Google photo, a session
// without a name, a refused breakfast spot and the heard-from label.

const S1 = '2099-12-01';
const sessions = [{ id: S1, session_date: S1, day: 'Tuesday', status: 'open', capacity: 10, created_at: 1 }];

async function boot(page: Page, fixtures: Fixtures = {}, opts: { staff?: boolean; failWrite?: FailWrite } = {}) {
  if (opts.staff) await unlockStaff(page);
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], ...fixtures }, opts.failWrite);
  await page.goto('/');
  await waitForSb(page);
  await loadStaffHalf(page);
}

/** Every PATCH sent to a table, with its address (the filters ride in the query). */
function patches(page: Page, table: string) {
  const out: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes(`/rest/v1/${table}`)) {
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON(); } catch { /* none */ }
      out.push({ url: decodeURIComponent(r.url()), body });
    }
  });
  return out;
}

test('an emptied W box leaves the waitlist order alone; a number still moves the rider', async ({ page }) => {
  await boot(page, {}, { staff: true });
  const sent = patches(page, 'queue_entries');
  await page.evaluate(`(()=>{
    S.queue=[{id:'w1',name:'A',sessionId:'${S1}',status:'waitlist',waitlistNum:1,queueNum:1},
             {id:'w2',name:'B',sessionId:'${S1}',status:'waitlist',waitlistNum:2,queueNum:2}];
  })()`);
  await page.evaluate(`wlSetPos('w2','')`);
  expect(await page.evaluate(`S.queue.map(e=>e.id+':'+e.waitlistNum).join(',')`)).toBe('w1:1,w2:2');
  expect(sent.length).toBe(0);
  await page.evaluate(`wlSetPos('w2','1')`);
  expect(await page.evaluate(`S.queue.map(e=>e.id+':'+e.waitlistNum).join(',')`)).toBe('w1:2,w2:1');
  expect(sent.length).toBe(2);
});

test("a party's Paid charges an incidental 0 and only rows still unpaid", async ({ page }) => {
  await boot(page, {}, { staff: true });
  const sent = patches(page, 'queue_entries');
  await page.evaluate(`(()=>{
    S.queue=[{id:'b1',name:'A',sessionId:'${S1}',status:'waiting',queueNum:1,typePreference:'Road',price:0,paid:false,groupId:'g1'},
             {id:'b2',name:'B',sessionId:'${S1}',status:'waiting',queueNum:2,typePreference:'Road',price:0,paid:false,promoCode:'FREE',groupId:'g1'}];
    S.deskWaitlist=[{id:'d1',name:'A',status:'waiting',booking_id:'b1',sort_order:1},{id:'d2',name:'B',status:'waiting',booking_id:'b2',sort_order:2}];
  })()`);
  await page.evaluate(`mwPartyPaid('d1')`);
  expect(sent.length).toBe(2);
  for (const p of sent) expect(p.url).toContain('paid=eq.false');
  const b1 = sent.find((p) => p.url.includes('id=eq.b1'))!;
  const b2 = sent.find((p) => p.url.includes('id=eq.b2'))!;
  expect(Number(b1.body.price)).toBeGreaterThan(0); // no promo: the bike's fare, not on the house
  expect('price' in b2.body).toBe(false); // a promo's 0 stands
});

test('the day sheet orders rides by their start, not by the printed time', async ({ page }) => {
  await boot(page, {}, { staff: true });
  const out = await page.evaluate(`[
    _dsStart({bike_slots:JSON.stringify({_time:'13:00 - 15:00'})}),
    _dsStart({bike_slots:JSON.stringify({_time:'9:00 - 11:00'})}),
    _dsStart({}),
  ]`);
  expect(out).toEqual(['13:00', '09:00', '09:00']);
  expect((out as string[])[1].localeCompare((out as string[])[0])).toBeLessThan(0);
});

test('On the house on a paid desk row with no stored price still asks for the PIN', async ({ page }) => {
  await boot(page, {}, { staff: true });
  const asked = await page.evaluate(`(async()=>{
    S.deskWaitlist=[{id:'d1',name:'A',status:'waiting',bike_type:'Road',paid:true}];
    let n=0;window._pinApprove=async()=>{n++;return false;};
    await toggleWlPayment('d1','house');
    return {n,price:S.deskWaitlist[0].price};
  })()`) as { n: number; price: unknown };
  expect(asked.n).toBe(1);
  expect(asked.price).toBeUndefined(); // refused: nothing changed
});

test('Back to login on the second reset step opens Sign in', async ({ page }) => {
  await boot(page);
  await page.evaluate(`(()=>{S.authMode='forgot';S.forgotStep=2;S.forgotVerified='pending';S.forgotEmail='a@b.co';renderAuthModal();document.getElementById('auth-modal').style.display='flex';})()`);
  await page.locator('#auth-modal .cu-back-btn').click();
  expect(await page.evaluate(`S.authMode`)).toBe('login');
  await expect(page.locator('#a-identifier')).toBeVisible();
});

test('a Google photo the server refused is not kept on the device', async ({ page }) => {
  await boot(page, {
    'rpc:customer_oauth_login': [{ id: 'c9', name: 'Gee Rider', email: 'g@example.com', session_token: 'tk', photo: null }],
    'rpc:customer_set_photo': { __rpcError: { status: 400, code: 'P0001', message: 'refused' } },
  });
  const r = await page.evaluate(`(async()=>{
    sb.auth.getSession=async()=>({data:{session:{user:{email:'g@example.com',user_metadata:{avatar_url:'https://lh3.example.com/p.jpg'}}}}});
    const v=await handleGoogleReturn();
    return {v,photo:S.loggedIn&&S.loggedIn.photo};
  })()`) as { v: string; photo: unknown };
  expect(r.v).toBe('loggedin');
  expect(r.photo).toBeFalsy();
});

test('a customer session without a name still draws the top bar', async ({ page }) => {
  await boot(page);
  const html = await page.evaluate(`(()=>{
    S.view='customer';S.loggedIn={id:'c1',email:'n@example.com',session_token:'t'};
    renderTopbarRight();return document.getElementById('topbar-right').innerHTML;
  })()`);
  expect(String(html)).toContain('n@example.com');
});

test('a refused breakfast spot is said and not added to the list', async ({ page }) => {
  await boot(page, {}, { staff: true, failWrite: { table: 'breakfast_spots', methods: ['POST'] } });
  const n = await page.evaluate(`(async()=>{
    S.breakfastSpots=[];S._bs='__new';S._bn='Cafe';S._bu='';
    await _bfSaveNew('_bs','_bn','_bu');return S.breakfastSpots.length;
  })()`);
  expect(n).toBe(0);
  await expect(page.locator('#err-bar-el')).toBeVisible();
});

test('an unknown heard-from code is plain text, escaped once where it is drawn', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(`heardLabel('a&b')`)).toBe('a&b');
  expect(await page.evaluate(`heardLabel('instagram')`)).not.toContain('&');
});
