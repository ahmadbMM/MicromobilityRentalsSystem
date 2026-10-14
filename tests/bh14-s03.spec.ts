import { test, expect } from '@playwright/test';
import { stubSupabase, waitForSb, loadStaffHalf, unlockStaff } from './helpers/supabase';

// Bug hunt 2026-10-14 (s03): the privacy notice, the waitlist cap field, spotsLeft and the staff
// sign-in's background role check.

const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [{ id: tomorrow, session_date: tomorrow, day: 'Tuesday', status: 'open', capacity: 10, created_at: 1 }];

test.describe('@bh14 s03 core helpers', () => {
  test('the privacy notice gives focus back to what opened it', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await page.goto('/');
    await waitForSb(page);
    const out = await page.evaluate(`(()=>{
      const b=document.createElement('button');b.id='pv-opener';b.textContent='x';document.body.appendChild(b);b.focus();
      showPrivacyNotice();
      const open=!!document.getElementById('privacy-backdrop')&&document.activeElement&&document.activeElement.classList.contains('pv-x');
      closePrivacyNotice();
      const r={open,back:document.activeElement&&document.activeElement.id,gone:!document.getElementById('privacy-backdrop')};
      b.remove();return r;
    })()`);
    expect(out).toEqual({ open: true, back: 'pv-opener', gone: true });
  });

  test('the waitlist cap label names its field', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await page.goto('/');
    await waitForSb(page);
    await loadStaffHalf(page); // the session form lives in the staff half
    const out = await page.evaluate(`(()=>{
      const h=document.createElement('div');h.innerHTML=_wlCapFieldHtml('ns');document.body.appendChild(h);
      const l=h.querySelector('label');const r={for:l.getAttribute('for'),hasField:!!document.getElementById(l.getAttribute('for'))};
      h.remove();return r;
    })()`);
    expect(out).toEqual({ for: 'ns-wl', hasField: true });
  });

  test('spotsLeft reads the session through the index and counts held places', async ({ page }) => {
    await stubSupabase(page, {
      sessions,
      queue_entries: [
        { id: 'q1', session_id: tomorrow, session_date: tomorrow, queue_num: 1, status: 'waiting', name: 'A', type_preference: 'Hybrid', size: 'M', paid: false, price: 57.5 },
        { id: 'q2', session_id: tomorrow, session_date: tomorrow, queue_num: 2, status: 'cancelled', name: 'B', type_preference: 'Hybrid', size: 'M', paid: false, price: 57.5 },
      ],
      bikes: [],
    });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`[spotsLeft(${JSON.stringify(tomorrow)}),spotsLeft('nope')]`)).toEqual([9, 12]);
  });

  test('the background role check after a failed lookup signs a disabled account out instead of confirming it', async ({ page }) => {
    const SESSION = {
      access_token: 'fake-jwt', token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fake-refresh',
      user: { id: 'u-staff-1', aud: 'authenticated', role: 'authenticated', email: 'staff@example.com' },
    };
    const head = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
    const ROW = { user_id: 'u-staff-1', role: 'admin', modules_view: null, modules_edit: null, must_change_pwd: false, display_name: 'Gone', disabled_at: '2026-10-10T00:00:00Z' };
    await stubSupabase(page, { sessions: [], staff: [ROW], 'auth:token': SESSION });
    await unlockStaff(page);
    let asks = 0;
    await page.route(/\/rest\/v1\/staff\?/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback();
      if (asks++ === 0) return r.fulfill({ status: 500, headers: head, body: JSON.stringify({ code: 'XX000', message: 'unavailable' }) });
      return r.fulfill({ status: 200, headers: head, body: JSON.stringify([ROW]) });
    });
    await page.goto('/');
    await waitForSb(page);
    // secure mode as in production; the lock itself is watched, not followed (it navigates)
    await page.evaluate(`window.__locked=[];window.lockStaff=a=>{window.__locked.push(a);};`);
    const secure = await page.evaluate(`SECURE_AUTH`);
    expect(await page.evaluate(`staffAuthSignIn('staff@example.com','Passw0rd!').then(r=>r.ok)`)).toBe(true);
    expect(await page.evaluate(`S.staffRole`)).toBe('frontdesk'); // the guess while the lookup failed
    await expect.poll(() => asks, { timeout: 15000 }).toBeGreaterThan(1);
    await page.waitForTimeout(300);
    expect(await page.evaluate(`S.staffRole`)).toBe('frontdesk'); // a disabled row's admin role is never confirmed
    expect(await page.evaluate(`JSON.stringify(window.__locked)`)).toBe(secure ? '[true]' : '[]');
  });
});
