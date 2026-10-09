import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, staffReady, goStaffTab } from './helpers/supabase';

// The staff half in parts (2026-10-01, splitSections in scripts/split-staff.mjs): staff.js is the desk's
// core, and each section (Analytics, Community, the till, the bikes...) is a file of its own under
// staff-parts/, fetched once the desk has painted. The rest of the suite loads every part up front
// (window.__staffPartsNow, tests/helpers/supabase.ts); this spec is the way a real device gets them.
test('the desk paints before the sections arrive, and a section opens once its part has come', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [] });
  await page.addInitScript(() => { (window as unknown as { __staffPartsNow?: boolean }).__staffPartsNow = false; });
  await unlockStaff(page);
  // Hold every part back until the desk is up.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const asked: string[] = [];
  await page.route(/\/staff-parts\/[a-z]+\.js/, async (route) => { asked.push(new URL(route.request().url()).pathname); await held; await route.continue(); });
  await page.goto('/bookings', { waitUntil: 'domcontentloaded' }); // a part held back holds the load event
  await waitForSb(page);
  await staffReady(page);
  // The desk is drawn from staff.js alone: no part has arrived.
  expect(await page.evaluate('_staffPartsReady()')).toBe(false);
  expect(await page.evaluate(`typeof renderStaffQueue==='function'&&!!document.getElementById('q-results')`)).toBe(true);
  // Opening a section before its part has come waits for it; nothing throws.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await goStaffTab(page, 'analytics');
  release();
  await expect(page.locator('#tab-analytics')).not.toBeEmpty();
  // Every part an admin's sections use was asked for, not only Analytics; the two only an action
  // reaches (Sela's report, the roster import) wait for it (2026-10-09, _staffPartWanted).
  await expect.poll(() => asked.length).toBeGreaterThan(5);
  expect(asked.some((u) => /\/(sela|imports)\.js/.test(u))).toBe(false);
  expect(errors).toEqual([]);
});

test('a handler of a part that has not arrived yet runs once it has', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [] });
  await page.addInitScript(() => { (window as unknown as { __staffPartsNow?: boolean }).__staffPartsNow = false; });
  await unlockStaff(page);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(/\/staff-parts\/[a-z]+\.js/, async (route) => { await held; await route.continue(); });
  await page.goto('/bookings', { waitUntil: 'domcontentloaded' }); // a part held back holds the load event
  await waitForSb(page);
  await staffReady(page);
  // A button naming a function that lives in a part (renderAnalytics's own helpers are not in staff.js).
  const inPart = await page.evaluate(`(()=>{const own=Object.keys(STAFF_PARTS_V);return own.length})()`);
  expect(inPart).toBeGreaterThan(5);
  await page.evaluate(`window.__ran=0;window.__partProbe=null;`);
  await page.evaluate(`(()=>{const b=document.createElement('button');b.id='probe';b.setAttribute('data-on-click',JSON.stringify(['_zzNotYet']));document.body.appendChild(b);})()`);
  await page.evaluate(`document.getElementById('probe').click()`);
  // the name is unknown until the parts land; define it as if a part brought it, then let them in
  await page.evaluate(`window._zzNotYet=function(){window.__ran++;}`);
  release();
  await expect.poll(() => page.evaluate('window.__ran')).toBe(1);
});

test('a several-call handler whose first call waits for a part runs every call, in order, once it has come', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [] });
  await page.addInitScript(() => { (window as unknown as { __staffPartsNow?: boolean }).__staffPartsNow = false; });
  await unlockStaff(page);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(/\/staff-parts\/[a-z]+\.js/, async (route) => { await held; await route.continue(); });
  await page.goto('/bookings', { waitUntil: 'domcontentloaded' });
  await waitForSb(page);
  await staffReady(page);
  expect(await page.evaluate('_staffPartsReady()')).toBe(false);
  await page.evaluate(`window.__calls=[];window._zzLater=function(n){window.__calls.push('b'+n);};`);
  await page.evaluate(`(()=>{const b=document.createElement('button');b.id='probe2';b.setAttribute('data-on-click',JSON.stringify([['_zzFirst',1],['_zzLater',2]]));document.body.appendChild(b);})()`);
  await page.evaluate(`document.getElementById('probe2').click()`);
  await page.evaluate(`window._zzFirst=function(n){window.__calls.push('a'+n);}`);
  release();
  await expect.poll(() => page.evaluate('window.__calls')).toEqual(['a1', 'b2']);
});
