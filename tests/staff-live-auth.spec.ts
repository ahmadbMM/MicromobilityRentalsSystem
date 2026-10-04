import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bookings the moment they are made (the owner, 2026-10-04: "i want the bookings to appear as soon
// as theyre booked, realtime"). Bookings are staff-only under RLS, so the realtime server sends a
// booking only to a channel that joined with a staff member's token. A staff device's live channel
// could join on the anon key - before its session was read, or before the staff signed in - and
// still say SUBSCRIBED, so the poll stood down to five minutes and no booking ever arrived.

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub: string) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const staffUser = { id: 'u-staff-1', aud: 'authenticated', role: 'authenticated', email: 'staff@example.com' };
const session = (token: string) => ({
  access_token: token, token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r1', user: staffUser,
});

type Join = { topic: string; token: string | null };
// Answers the page's socket as stubRealtime does, and keeps what each join of the live channel
// carried: the access token the server would read the subscriber's rights from.
async function liveSocket(page: Page): Promise<Join[]> {
  const joins: Join[] = [];
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    ws.onMessage((raw) => {
      let p: unknown;
      try { p = JSON.parse(String(raw)); } catch { return; }
      const arr = Array.isArray(p);
      const [join_ref, ref, topic, event, payload] = arr ? p as unknown[] : (() => { const o = p as Record<string, unknown>; return [o.join_ref, o.ref, o.topic, o.event, o.payload]; })();
      if (ref == null) return;
      const pl = (payload || {}) as { access_token?: string; config?: { postgres_changes?: unknown[] } };
      if (event === 'phx_join' && topic === 'realtime:mmcq-live') joins.push({ topic: String(topic), token: pl.access_token ?? null });
      const bindings = event === 'phx_join' ? (pl.config?.postgres_changes || []) as Record<string, unknown>[] : [];
      const reply = { status: 'ok', response: event === 'phx_join' ? { postgres_changes: bindings.map((b, i) => ({ ...b, id: i + 1 })) } : {} };
      ws.send(JSON.stringify(arr ? [join_ref, ref, topic, 'phx_reply', reply] : { join_ref, ref, topic, event: 'phx_reply', payload: reply }));
    });
  });
  return joins;
}

test.describe('@staff:live the live channel joins as staff', () => {
  test('a staff device with a session joins the live channel with the staff token', async ({ page }) => {
    const token = jwt('u-staff-1');
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], staff: [{ user_id: 'u-staff-1', role: 'admin' }] });
    const joins = await liveSocket(page);
    await page.addInitScript((s) => localStorage.setItem('sb-qpffkzmsfyilicwcsszz-auth-token', JSON.stringify(s)), session(token));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S._staffAuthed===true&&S._rtConnected===true`);
    expect(joins.length).toBeGreaterThan(0);
    expect(joins[0].token).toBe(token); // the very first join, not a later correction
    expect(await page.evaluate(`_rtJoinUid`)).toBe('u-staff-1');
    expect(await page.evaluate(`_rtLive()`)).toBe(true);
    expect(await page.evaluate(`_pollPlan(1,_rtLive())`)).toBe('skip'); // events keep it current
  });

  test('a channel that joined before the staff signed in is not counted live, and the sign-in rejoins it as staff', async ({ page }) => {
    const token = jwt('u-staff-1');
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], staff: [{ user_id: 'u-staff-1', role: 'admin' }], 'auth:token': session(token) });
    const joins = await liveSocket(page);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S._rtConnected===true`);
    expect(joins.map((j) => j.token)).toEqual([null]); // no session: the anon key
    // An anon channel on a signed-in staff device hears no booking: the 30-second poll keeps going.
    await page.evaluate(`S._staffAuthed=true`);
    expect(await page.evaluate(`_rtLive()`)).toBe(false);
    expect(await page.evaluate(`_pollPlan(1,_rtLive())`)).toBe('light');
    await page.evaluate(`S._staffAuthed=false`);

    expect(await page.evaluate(`staffAuthSignIn('staff@example.com','hunter2A1').then(r=>r.ok)`)).toBe(true);
    await expect.poll(() => joins.length).toBe(2);
    expect(joins[1].token).toBe(token);
    await page.waitForFunction(`_rtJoinUid==='u-staff-1'&&S._rtConnected===true`);
    expect(await page.evaluate(`_rtLive()`)).toBe(true);
  });

  test('a customer device is unchanged: live as soon as its channel joins', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [] });
    const joins = await liveSocket(page);
    await page.addInitScript(() => localStorage.setItem('cq_session', JSON.stringify({ id: 'c1', name: 'Spec Rider', session_token: 'tok-spec' })));
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S._rtConnected===true`);
    expect(joins.map((j) => j.token)).toEqual([null]);
    expect(await page.evaluate(`_rtLive()`)).toBe(true);
  });
});
