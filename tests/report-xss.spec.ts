import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A malicious customer email/name must not break out of the printed session report (which runs
// in the app's own origin via window.open + document.write).
test('session report escapes hostile customer email/name/bike in the print HTML', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }],
    bikes: [{ id: 'b1', name: '<img src=x onerror=alert(1)>', size: 'M', type: 'Hybrid', status: 'in-use', rental_price: 57.5 }],
    queue_entries: [{
      id: 'q1', name: '<b>Bad</b>', phone: '"><script>evil()</script>', email: 'x"><script>steal()</script>@e.com',
      session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 1, status: 'done',
      paid: true, price: 30, assigned_bike_id: 'b1', registered_at: '2099-01-09T10:00:00Z',
    }],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const html = await page.evaluate(`(()=>{
    let captured='';
    const realOpen=window.open;
    S._rxTap=(h)=>{captured+=h;return true;};
    S.sfSession='s1';
    try{ printSessionReport(); }finally{ window.open=realOpen; }
    return captured;
  })()`) as string;
  expect(html.length).toBeGreaterThan(100);
  // no live injection survived
  expect(html).not.toContain('<script>steal');
  expect(html).not.toContain('<script>evil');
  expect(html).not.toContain('<img src=x onerror'); // live tag; the escaped &lt;img…&gt; text is inert
  expect(html).not.toContain('"><script>');
  // the data is present, but escaped. (Template B prints no phone/email columns, so the
  // hostile email never reaches the HTML at all — name and bike name are the printed surfaces.)
  expect(html).toContain('&lt;b&gt;Bad');
  expect(html).toContain('&lt;img src=x onerror');
});
