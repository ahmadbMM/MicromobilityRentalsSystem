import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Three defects found by reading, now fixed:
//
//   1. A REMOVAL frees the rider's place (_holdsSpot counts neither removed nor cancelled)
//      but never handed it on, so the waitlist did not move — the place sat empty until
//      somebody else cancelled. Cancel and no-show already promoted.
//   2. Staff stock writes sent an ABSOLUTE quantity computed from the device's own copy, so
//      two tills selling the same item overwrote each other and stock drifted upward.
//   3. A bulk check-in stamped checked_in_at on every id, including rows whose guarded status
//      write had been refused — giving a cancelled booking an arrival time.

const S1 = '2099-11-11';
const sessions = [{ id: S1, session_date: S1, day: 'Wednesday', status: 'open', capacity: 2, created_at: 1 }];
const e = (id: string, n: number, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: S1, session_day: 'Wednesday', session_date: S1, queue_num: n, name,
  phone: '05590000' + n, type_preference: 'Road', status, paid: true, price: 75, size: 'M',
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});

async function boot(page: import('@playwright/test').Page, queue_entries: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries, bikes: [], ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
}

/** Every PATCH sent to a table, as raw bodies. */
function watch(page: import('@playwright/test').Page, table: string, method = 'PATCH') {
  const out: { url: string; body: string }[] = [];
  page.on('request', (r) => {
    if (r.method() === method && r.url().includes(`/rest/v1/${table}`)) out.push({ url: r.url(), body: r.postData() || '' });
  });
  return out;
}

test.describe('a freed place reaches the waitlist', () => {
  const rows = [
    e('a', 1, 'Rider One', 'waiting'),
    e('b', 2, 'Rider Two', 'waiting'),
    e('w', 3, 'Waitlisted', 'waitlist', { waitlist_num: 1 }),
  ];

  test('removing a booking promotes the next waitlisted rider', async ({ page }) => {
    await boot(page, rows);
    const patches = watch(page, 'queue_entries');
    await page.evaluate(`doRemove('a')`);
    await expect
      .poll(() => patches.some((p) => /"status":"waiting"/.test(p.body) && p.url.includes('w')), { timeout: 5000 })
      .toBe(true);
  });

  test('the promotion is still guarded, so a stale device cannot take it twice', async ({ page }) => {
    await boot(page, rows);
    const patches = watch(page, 'queue_entries');
    await page.evaluate(`doRemove('a')`);
    await expect.poll(() => patches.some((p) => /"status":"waiting"/.test(p.body))).toBe(true);
    const promote = patches.find((p) => /"status":"waiting"/.test(p.body));
    // the conditional is what stops two devices promoting the same row
    expect(promote!.url).toMatch(/status=eq\.waitlist/);
  });

  test('a removal with nobody waiting promotes nobody', async ({ page }) => {
    await boot(page, [e('a', 1, 'Rider One', 'waiting'), e('b', 2, 'Rider Two', 'waiting')]);
    const patches = watch(page, 'queue_entries');
    await page.evaluate(`doRemove('a')`);
    await expect.poll(() => patches.some((p) => /"status":"removed"/.test(p.body))).toBe(true);
    await page.waitForTimeout(400);
    expect(patches.some((p) => /"status":"waiting"/.test(p.body))).toBe(false);
  });
});

test.describe('stock movements survive two tills', () => {
  const inventory = [{ id: 'gel', name: 'Energy Gel', category: 'EnergyGels', qty: 10, price: 12 }];

  test('a stock change is written as a delta against what the row actually holds', async ({ page }) => {
    await boot(page, [e('a', 1, 'Rider One', 'waiting')], { inventory });
    const patches = watch(page, 'inventory');
    await page.evaluate(`_invApplyDelta('gel',-1)`);
    await expect.poll(() => patches.length).toBe(1);
    // Conditional on the row still holding what was read — that is what makes it safe.
    expect(patches[0].url).toMatch(/qty=eq\.10/);
    expect(JSON.parse(patches[0].body).qty).toBe(9);
  });

  test('the happy path still costs one write, not a read plus a write', async ({ page }) => {
    await boot(page, [e('a', 1, 'Rider One', 'waiting')], { inventory });
    const reads: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'GET' && r.url().includes('/rest/v1/inventory')) reads.push(r.url());
    });
    await page.evaluate(`_invApplyDelta('gel',-1)`);
    await page.waitForTimeout(300);
    // it bets on what this device last saw; the read is only paid for when that bet loses
    expect(reads.length).toBe(0);
  });

  test('stock is still allowed to go negative — a clamp would mint phantom stock on refund', async ({ page }) => {
    await boot(page, [e('a', 1, 'Rider One', 'waiting')], {
      inventory: [{ id: 'gel', name: 'Energy Gel', category: 'EnergyGels', qty: 0, price: 12 }],
    });
    const patches = watch(page, 'inventory');
    await page.evaluate(`_invApplyDelta('gel',-2)`);
    await expect.poll(() => patches.length).toBe(1);
    expect(JSON.parse(patches[0].body).qty).toBe(-2);
  });

  test('the add-on helpers route through the delta path', async ({ page }) => {
    await boot(page, [e('a', 1, 'Rider One', 'waiting')], { inventory });
    const patches = watch(page, 'inventory');
    await page.evaluate(`_addonStockQ([{id:'gel',qty:2}],-1)`);
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].url).toMatch(/qty=eq\./);        // conditional, not a blind write
    expect(JSON.parse(patches[0].body).qty).toBe(8);
  });
});

test.describe('check-in timestamps follow the status write', () => {
  // The status and the arrival stamp are one staff_checkin call (2026-10-04): the server stamps it.
  test('a rider who checks in gets an arrival time, in the same call as the status', async ({ page }) => {
    await boot(page, [e('a', 1, 'Rider One', 'waiting')]);
    const patches = watch(page, 'queue_entries');
    const calls: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/staff_checkin')) calls.push(r.postData() || ''); });
    await page.evaluate(`_checkinMany(['a'])`);
    await expect.poll(() => calls.length, { timeout: 5000 }).toBe(1);
    expect(JSON.parse(calls[0])).toMatchObject({ p_booking_id: 'a', p_bike_id: null });
    await page.waitForTimeout(300);
    expect(patches.some((p) => /"checked_in_at"/.test(p.body))).toBe(false); // nothing stamped from the page
  });

  test('a row whose status write was refused gets no arrival time', async ({ page }) => {
    // 'done' is not in ('waiting','waitlist'), so the guarded status write matches nothing —
    // exactly the shape of a row another device has already dealt with.
    await boot(page, [e('a', 1, 'Rider One', 'done')]);
    const patches = watch(page, 'queue_entries');
    await page.evaluate(`_checkinMany(['a'])`);
    await page.waitForTimeout(600);
    expect(patches.some((p) => /"checked_in_at"/.test(p.body))).toBe(false);
  });
});

// A dropped request during password reset used to be answered with a generic connection error
// and no retry — error_log shows riders tapping the button three to five times in a minute.
test.describe('auth survives a dropped request', () => {
  test('a network failure on reset is retried before giving up', async ({ page }) => {
    await boot(page, [e('a', 1, 'Rider One', 'waiting')]);
    const calls = await page.evaluate(`(async()=>{
      let n=0; const real=sb.rpc.bind(sb);
      sb.rpc=async(name,args)=>{ if(name==='customer_reset'){n++; return {data:null,error:{message:'TypeError: Load failed'}};} return real(name,args); };
      await _rpcResilient('customer_reset',{p_email:'x@y.z'});
      sb.rpc=real; return n;
    })()`);
    expect(calls).toBe(2);                       // tried twice, not once
  });

  test('a genuine refusal is not retried — it is the answer', async ({ page }) => {
    await boot(page, [e('a', 1, 'Rider One', 'waiting')]);
    const calls = await page.evaluate(`(async()=>{
      let n=0; const real=sb.rpc.bind(sb);
      sb.rpc=async(name)=>{ if(name==='customer_login'){n++; return {data:null,error:{message:'LOCKED'}};} return real(name); };
      await _rpcResilient('customer_login',{p_identifier:'a'});
      sb.rpc=real; return n;
    })()`);
    expect(calls).toBe(1);
  });

  test('signup is deliberately left alone, so a landed insert is never repeated', async ({ page }) => {
    await boot(page, [e('a', 1, 'Rider One', 'waiting')]);
    // the build minifies quote style, so match on the call shape rather than the literal
    const signup = await page.evaluate(`doSignup.toString()`) as string;
    expect(/_rpcResilient\(\s*["']customer_signup/.test(signup)).toBe(false);
    expect(/sb\.rpc\(\s*["']customer_signup/.test(signup)).toBe(true);
  });
});
