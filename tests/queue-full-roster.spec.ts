import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The roster used to stop at 150 rows. A busy ride runs to a little over 200 riders, and
// because cancelled and removed bookings are left out, the 150th visible row already carried
// booking number ~158 — so everyone from #159 up was missing from a screen that gave no sign
// it was incomplete. A chosen session is bounded, so it lists in full. The ALL-sessions view
// spans every ride ever run, so it keeps its cap and its "Show more".

const S1 = '2099-10-10';
const S2 = '2099-10-11';
const sess = (id: string) => ({ id, session_date: id, day: 'Sunday', status: 'open', capacity: 220, created_at: 1 });
const CANCELLED = [12, 30, 44, 71, 90, 110, 130, 150];
const rider = (sid: string, n: number, tag: string) => ({
  id: `${tag}${n}`, session_id: sid, session_day: 'Sunday', session_date: sid, queue_num: n,
  name: `${tag} ${n}`, phone: '05500' + String(n).padStart(5, '0'), type_preference: 'Road',
  status: tag === 'Rider' && CANCELLED.includes(n) ? 'cancelled' : 'waiting',
  paid: true, price: 75, size: 'M', registered_at: '2099-01-01T10:00:00Z',
});
const queue_entries = [
  ...Array.from({ length: 189 }, (_, i) => rider(S1, i + 1, 'Rider')),
  ...Array.from({ length: 40 }, (_, i) => rider(S2, i + 1, 'Other')),
];

async function open(page: import('@playwright/test').Page, session: string) {
  await stubSupabase(page, { sessions: [sess(S1), sess(S2)], queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>100`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${session}';renderStaffQueue()`);
  await page.waitForTimeout(300);
}

/** Booking numbers actually painted on the screen. */
async function shownNums(page: import('@playwright/test').Page, tag: string, upto: number) {
  return page.evaluate(`(()=>{
    const txt=document.getElementById('tab-queue').innerText;const out=[];
    for(let n=1;n<=${upto};n++) if(txt.includes('${tag} '+n+'\\n')||txt.includes('${tag} '+n+' ')) out.push(n);
    return out;
  })()`) as Promise<number[]>;
}

test('a chosen session lists every rider, past 159 and past 189', async ({ page }) => {
  await open(page, S1);
  const shown = await shownNums(page, 'Rider', 189);
  expect(shown).toContain(159);           // the first one the old cap cut off
  expect(shown).toContain(189);           // and the last rider of the night
  expect(shown).toHaveLength(189 - CANCELLED.length);
});

test('cancelled bookings are still left out — the cap was the bug, not the filter', async ({ page }) => {
  await open(page, S1);
  const shown = await shownNums(page, 'Rider', 189);
  for (const n of CANCELLED) expect(shown).not.toContain(n);
});

test('no "Show more" is left dangling once the session lists in full', async ({ page }) => {
  await open(page, S1);
  const more = await page.evaluate(
    `Array.from(document.querySelectorAll('#tab-queue button:not(.sh-more)')).filter(b=>/more/i.test(b.textContent||'')).length`);
  expect(more).toBe(0);
});

test('the all-sessions view keeps its cap, and says how many are held back', async ({ page }) => {
  await open(page, 'all');
  const shown = await shownNums(page, 'Rider', 189);
  expect(shown.length).toBeLessThan(189 - CANCELLED.length);   // still capped
  const label = await page.evaluate(
    `(Array.from(document.querySelectorAll('#tab-queue button:not(.sh-more)')).find(b=>/more/i.test(b.textContent||''))||{}).textContent||''`) as string;
  expect(label).toMatch(/\d+/);                                 // names a number, not just "more"
});

test('the cap lifts as soon as a session is picked', async ({ page }) => {
  await open(page, 'all');
  expect(await shownNums(page, 'Rider', 189)).not.toContain(189);
  await page.evaluate(`setSfSession('${S1}')`);
  await page.waitForTimeout(300);
  expect(await shownNums(page, 'Rider', 189)).toContain(189);
});

test('a long session\'s late rows never land in the view that replaced it', async ({ page }) => {
  await open(page, S1);
  // The long list paints its tail a frame later; switching away inside that frame used to
  // append S1's tail to the capped All view.
  await page.evaluate(`setSfSession('${S1}');setSfSession('all')`);
  await page.waitForTimeout(300);
  expect(await shownNums(page, 'Rider', 189)).not.toContain(189);
});
