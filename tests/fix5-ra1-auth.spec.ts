import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Signing in and out (2026-10-05 review, slice ra1):
// - a sign-out ends THIS device's session: supabase-js signs out 'global' by default, so the Lock
//   button, the idle lock and a rider's Log out ended that account's session on every device;
// - a boot that finds the unlock no longer backed by a staff account takes off the device what a
//   sign-out takes (the staff logs, the team list, the role, the ride clocks, the access lists);
// - a staff sign-in that fails says why in the person's language, and Supabase's own English
//   message goes to the error log instead of the screen;
// - a rider's sign-in and sign-out leave no name in the device's action log.

const SESSION = {
  access_token: 'fake-jwt', token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fake-refresh',
  user: { id: 'u-staff-1', aud: 'authenticated', role: 'authenticated', email: 'staff@example.com' },
};
const head = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };

function logouts(page: Page) {
  const out: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/auth/v1/logout')) out.push(r.url()); });
  return out;
}

test.describe('@staff:security fix5 ra1 sign-out scope', () => {
  test('locking a staff device ends the session on this device only', async ({ page }) => {
    await stubSupabase(page, { sessions: [], staff: [{ user_id: 'u-staff-1', role: 'admin' }], 'auth:token': SESSION });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const out = logouts(page);
    expect(await page.evaluate(`staffAuthSignIn('staff@example.com','Passw0rd!').then(r=>r.ok)`)).toBe(true);
    expect(await page.evaluate(`staffAuthSignOut(true)`)).toBe(true);
    await expect.poll(() => out.length).toBe(1);
    expect(new URL(out[0]).searchParams.get('scope')).toBe('local');
  });

  test('a rider logging out ends the provider session on this device only', async ({ page }) => {
    await stubSupabase(page, { sessions: [], 'auth:token': { ...SESSION, user: { ...SESSION.user, id: 'u-rider', email: 'rider@example.com' } } });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    // the session a Google or Apple sign-in leaves on the device
    await page.evaluate(`sb.auth.signInWithPassword({email:'rider@example.com',password:'x'})`);
    const out = logouts(page);
    await page.evaluate(`doLogout()`);
    await expect.poll(() => out.length).toBe(1);
    expect(new URL(out[0]).searchParams.get('scope')).toBe('local');
  });
});

test.describe('@staff:security fix5 ra1 staff sign-in messages', () => {
  async function signIn(page: Page, answer: (r: import('@playwright/test').Route) => Promise<void>) {
    await stubSupabase(page, { sessions: [] });
    await unlockStaff(page);
    await page.route(/\/auth\/v1\/token/, answer); // after the stub: the newest route answers
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`localStorage.removeItem('cq_errors')`);
    return await page.evaluate(`staffAuthSignIn('staff@example.com','Passw0rd!')`) as { ok: boolean; msg: string };
  }
  const logged = (page: Page) => page.evaluate(`JSON.parse(localStorage.getItem('cq_errors')||'[]').map(e=>e.msg).join('\\n')`) as Promise<string>;

  test('too many tries says so in the person’s words; Supabase’s message is logged, not shown', async ({ page }) => {
    const res = await signIn(page, (r) => r.fulfill({ status: 429, headers: head, body: JSON.stringify({ code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }) }));
    expect(res.ok).toBe(false);
    expect(res.msg).toBe(await page.evaluate(`t('errTooManyTries')`));
    expect(await logged(page)).toContain('Request rate limit reached');
  });

  test('a request that never arrives is a connection error, not "Failed to fetch"', async ({ page }) => {
    const res = await signIn(page, (r) => r.abort());
    expect(res.ok).toBe(false);
    expect(res.msg).toBe(await page.evaluate(`t('errConnection')`));
    expect(res.msg).not.toMatch(/fetch/i);
  });

  test('a server error is a connection error, with its own words in the log', async ({ page }) => {
    const res = await signIn(page, (r) => r.fulfill({ status: 500, headers: head, body: JSON.stringify({ code: 500, error_code: 'unexpected_failure', msg: 'Database error querying schema' }) }));
    expect(res.msg).toBe(await page.evaluate(`t('errConnection')`));
    expect(await logged(page)).toContain('Database error querying schema');
  });

  test('a wrong password is still a wrong password, and is not logged as an error', async ({ page }) => {
    const res = await signIn(page, (r) => r.fulfill({ status: 400, headers: head, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }) }));
    expect(res.msg).toBe(await page.evaluate(`t('errInvalidCredentials')`));
    expect(await logged(page)).toBe('');
  });
});

test.describe('@staff:security fix5 ra1 boot revoke', () => {
  test('a boot that finds no session behind the unlock takes the staff data and access lists off the device', async ({ page }) => {
    await stubSupabase(page, { sessions: [] });
    await page.addInitScript(() => localStorage.setItem('cq_secure_auth', '1'));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const keys = ['cq_staff', 'cq_full_log', 'cq_cancellations', 'cq_team', 'cq_role', 'cq_role_uid', 'cq_ho', 'cq_ct_q1', 'cq_access'];
    await page.evaluate(`(async () => {
      for (const k of ${JSON.stringify(keys)}) localStorage.setItem(k, k === 'cq_staff' ? '1' : '[]');
      S._myView = ['queue']; S._myEdit = ['queue']; S.fullLog = [{ ts: 1, label: 'x', by: 'Spec Staff' }];
      sb.auth.getSession = async () => ({ data: { session: null } });
      sb.auth.refreshSession = async () => ({ data: { session: null }, error: { name: 'AuthSessionMissingError', message: 'Auth session missing!' } });
      await staffAuthRestore();
    })()`);
    await expect.poll(() => page.evaluate(`${JSON.stringify(keys)}.filter(k => localStorage.getItem(k) !== null)`)).toEqual([]);
    expect(await page.evaluate(`[S._myView, S._myEdit, S.fullLog.length]`)).toEqual([null, null, 0]);
  });

  test('a network blip keeps the unlock and everything with it', async ({ page }) => {
    await stubSupabase(page, { sessions: [] });
    await page.addInitScript(() => localStorage.setItem('cq_secure_auth', '1'));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const left = await page.evaluate(`(async () => {
      localStorage.setItem('cq_staff', '1'); localStorage.setItem('cq_team', '[]'); localStorage.setItem('cq_access', '{}');
      sb.auth.getSession = async () => ({ data: { session: null } });
      sb.auth.refreshSession = async () => { throw new TypeError('Failed to fetch'); };
      await staffAuthRestore();
      await new Promise(r => setTimeout(r, 300));
      return [localStorage.getItem('cq_staff'), localStorage.getItem('cq_team'), localStorage.getItem('cq_access')];
    })()`);
    expect(left).toEqual(['1', '[]', '{}']);
  });
});

test.describe('@customer:auth fix5 ra1 no names in the device log', () => {
  test('a rider signing in and out on this device leaves no name in its action log', async ({ page }) => {
    await stubSupabase(page, {
      sessions: [],
      'rpc:customer_login': [{ id: 'c7', name: 'Lina Example', email: 'lina@example.com', phone: '0500000007', created_at: '2026-01-01T00:00:00Z', session_token: 'tok7' }],
    });
    await page.goto('/');
    await waitForSb(page);
    await expect(page.locator('#a-identifier')).toBeVisible();
    await page.fill('#a-identifier', 'lina@example.com');
    await page.fill('#a-pwd', 'Passw0rdX');
    await page.evaluate(`doLogin()`);
    await expect.poll(() => page.evaluate(`S.loggedIn && S.loggedIn.name`)).toBe('Lina Example');
    await page.evaluate(`doLogout(true)`);
    const log = await page.evaluate(`[localStorage.getItem('cq_full_log')||'', JSON.stringify(S.fullLog||[])]`) as string[];
    expect(log.join(' ')).not.toContain('Lina');
  });
});
