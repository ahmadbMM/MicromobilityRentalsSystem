import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stubSupabase, unlockStaff, waitForSb, staffReady } from './helpers/supabase';

// A realtime event on a busy night repaints one party of the Bookings roster. What that costs is
// mostly style work: how many elements the browser has to restyle. A selector that reaches across
// the parties (a backward positional pseudo-class over the <tbody>s, a :has() keyed on the data-ck
// every piece carries) made one changed row restyle all 250 parties - 5,200 elements, ~55 ms on a
// booth tablet (2026-10-01). The count is read from a Chrome trace, so it does not depend on how
// fast the machine running the suite is.
const N = 250;
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const rows = (d: string) => Array.from({ length: N }, (_, i) => ({ id: `e${i}`, session_id: 'live', session_day: 'Friday', session_date: d,
  queue_num: i + 1, name: 'Rider Number ' + i, phone: '05' + (10000000 + i), customer_id: 'c' + i,
  status: i % 5 === 0 ? 'active' : i % 7 === 0 ? 'done' : 'waiting', paid: i % 2 === 0, price: 30, type_preference: 'Road',
  bike_number: i % 5 === 0 ? String(100 + i) : null, registered_at: '2099-01-01T10:00:00Z' }));

test('a one-row change on a 250-booking roster restyles that row, not the roster', async ({ page, browser }) => {
  const d = today();
  await stubSupabase(page, { queue_entries: rows(d), sessions: [{ id: 'live', day: 'Friday', session_date: d, capacity: 400, status: 'open', created_at: 1, start_time: '00:00', end_time: '23:59' }] });
  await unlockStaff(page);
  await page.goto('/bookings');
  await waitForSb(page);
  await staffReady(page);
  await page.waitForFunction(`document.querySelectorAll("#q-results [data-ck]").length > 40`);
  await page.evaluate(`new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)))`);
  const path = join(mkdtempSync(join(tmpdir(), 'mm-trace-')), 't.json');
  await browser.startTracing(page, { path, categories: ['devtools.timeline', 'blink.user_timing'] });
  await page.evaluate(`(async () => {
    for (let k = 0; k < 3; k++) {
      performance.mark('rs' + k);
      const q = S.queue.slice(); const i = 5 + k * 10; q[i] = { ...q[i], name: q[i].name + ' X' }; S.queue = q;
      _bgRenderStaffTab(); void document.body.offsetHeight;
      performance.mark('re' + k);
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
    }
  })()`);
  await browser.stopTracing();
  const ev = (JSON.parse(readFileSync(path, 'utf8')).traceEvents || []) as { name: string; ph: string; ts: number; dur?: number; args?: { elementCount?: number } }[];
  const mark = (n: string) => ev.find((e) => e.name === n)!.ts;
  const counts: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = mark('rs' + k), b = mark('re' + k);
    counts.push(ev.filter((e) => e.name === 'UpdateLayoutTree' && e.ph === 'X' && e.ts >= a && e.ts <= b).reduce((s, e) => s + (e.args?.elementCount || 0), 0));
  }
  test.info().annotations.push({ type: 'restyled', description: counts.join(', ') });
  for (const c of counts) expect(c, `elements restyled by one row's repaint (${counts.join(', ')})`).toBeLessThan(1500);
});
