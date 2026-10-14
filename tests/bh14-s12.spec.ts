import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-14 (s12): reports, History's Restore, the scanner.
//   - A second tap on Restore while the first was out sent a second write that found the row restored
//     already and said "changed elsewhere" over a restore that had worked.
//   - A report window opened on the tap and closed by the staffer while the caller read threw on write.

const FUT = '2099-11-11';
const sessions = [{ id: FUT, session_date: FUT, day: 'Wednesday', status: 'open', capacity: 5, created_at: 1 }];
const e = (id: string, n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: FUT, session_day: 'Wednesday', session_date: FUT, queue_num: n, name: 'Rider ' + id,
  phone: '05590000' + n, type_preference: 'Road', status, paid: false, price: 75, size: 'M',
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});

async function boot(page: Page, queue_entries: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
}

test.describe('@bh14 s12', () => {
  test('two taps on Restore send one restore', async ({ page }) => {
    await boot(page, [e('a', 1, 'waiting'), e('r', 2, 'removed', { removed_from: 'noshow' })]);
    const restores: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries') && r.url().includes('id=eq.r')) restores.push(r.postData() || '');
    });
    await page.evaluate(`Promise.all([doRestoreEntry('r'),doRestoreEntry('r')])`);
    await page.waitForTimeout(300);
    expect(restores.filter((b) => /"status":"noshow"/.test(b)).length).toBe(1);
  });

  test('a report window closed before it was written opens a new one', async ({ page }) => {
    await boot(page, [e('a', 1, 'waiting')]);
    const fresh = await page.evaluate(`(()=>{const gone={closed:true,document:null};const w=_openReport('<!DOCTYPE html><p>x</p>',200,200,gone);const ok=!!w&&w!==gone;try{w&&w.close();}catch(_){}return ok;})()`);
    expect(fresh).toBe(true);
  });
});
