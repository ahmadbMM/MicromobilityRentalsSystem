import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type FailWrite } from './helpers/supabase';

// Review fixes of 2026-10-05 (community applications): a bike owner approved or invited onto a
// Saturday ride is booked with their own bike; when the ride's booking is refused, the welcome goes
// out without the ride and an invitation is not sent at all (the application stops naming the
// ride, and a password the approval made is still shown once); and the Applications and Flagged
// lists read every row, page by page, instead of the newest thousand.

const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const customers = [
  { id: 'c1', name: 'Huda Saleh', email: 'huda.saleh@example.test', phone: '+966551239876', height: 165, type_preference: 'Own', created_at: '2026-01-05T10:00:00Z' },
];
const base = {
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12',
  gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
  customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect', instagram: '', linkedin: '',
};
const apps = [
  { ...base, id: 'a1', status: 'pending', name: 'Karim Mansour', email: 'karim.mansour@example.test', phone: '+966552468013' },
  { ...base, id: 'a2', status: 'pending', name: 'Huda Saleh', email: 'huda.saleh@example.test', phone: '+966551239876', gender: 'female', bike_type: 'Hybrid', created_at: '2026-09-21T08:00:00Z' },
];
const SAT = '2099-03-07';
const RIDES = [{
  id: SAT, day: 'Saturday', session_date: SAT, status: 'open', capacity: 20, spots: 20, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, bike_slots: '{"_time":"06:00 - 08:00","_total":20}',
}];
const NEW_ACCT = { ok: true, existing: false, customer_id: 'ca01', name: 'Karim Mansour', email: 'karim.mansour@example.test', phone: '+966552468013', password: 'Kp7wXr4Mnq', lang: 'en', oauth: false };
const HUDA = { ok: true, existing: true, customer_id: 'c1', name: 'Huda Saleh', email: 'huda.saleh@example.test', phone: '+966551239876', password: null, lang: 'en', oauth: false };

async function applicationsTab(page: Page, extra: Record<string, unknown> = {}, fail?: FailWrite) {
  await stubSupabase(page, { sessions: RIDES, queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: apps, ...extra }, fail);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
  await expect(page.locator('.ca-row')).toHaveCount(2);
}
const row = (page: Page, id: string) => page.locator(`.ca-row[data-app-id="${id}"]`);
function posts(page: Page, table: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) return;
    try { const b = r.postDataJSON(); out.push(...(Array.isArray(b) ? b : [b])); } catch { /* not json */ }
  });
  return out;
}
function patches(page: Page, table: string) {
  const out: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'PATCH' || !new RegExp(`/rest/v1/${table}\\?`).test(r.url())) return;
    try { out.push({ url: decodeURIComponent(r.url()), body: r.postDataJSON() }); } catch { /* not json */ }
  });
  return out;
}
async function decide(page: Page, id: string, kind: 'approve' | 'invite') {
  await row(page, id).locator(kind === 'approve' ? '.ca-approve' : '.ca-invite').click();
  const dlg = page.locator('#confirm-modal .ca-ap-box');
  await dlg.locator(`.ca-ap-rides [data-ca-ride="${SAT}"]`).click();
  await dlg.locator('.rg-field [data-rg="int"]').click(); // a Saturday ride asks the rider's group
  await dlg.locator('.ca-ap-go').click();
}

test.describe('@staff:community rb1 applications (2026-10-05)', () => {
  test('approving a bike owner onto a Saturday ride books their own bike', async ({ page }) => {
    await applicationsTab(page, { 'rpc:staff_community_approve': HUDA });
    const bookings = posts(page, 'queue_entries');
    await decide(page, 'a2', 'approve');
    await expect.poll(() => bookings.length).toBe(1);
    expect(bookings[0]).toMatchObject({ session_id: SAT, customer_id: 'c1', type_preference: 'Own', approval: 'approved' });
  });

  test('inviting an applicant who said they have their own bike books it as their own', async ({ page }) => {
    await applicationsTab(page, {
      'rpc:staff_community_approve': NEW_ACCT,
      community_applications: apps.map((a) => (a.id === 'a1' ? { ...a, own_bike: true } : a)),
    });
    const bookings = posts(page, 'queue_entries');
    await decide(page, 'a1', 'invite');
    await expect.poll(() => bookings.length).toBe(1);
    expect(bookings[0]).toMatchObject({ session_id: SAT, customer_id: 'ca01', type_preference: 'Own' });
  });

  test('an approval whose ride booking is refused sends the welcome without the ride', async ({ page }) => {
    await applicationsTab(page, { 'rpc:staff_community_approve': HUDA }, { table: 'queue_entries', methods: ['POST'] });
    await decide(page, 'a2', 'approve');
    const msgBox = page.locator('#confirm-modal .ca-msg-box');
    await expect(msgBox).toBeVisible();
    await expect(page.locator('#err-bar-el')).toBeVisible();                       // the refusal is said
    const msg = await msgBox.locator('#ca-msg-text').inputValue();
    expect(msg).toContain('Welcome');
    expect(msg).not.toContain('saved you a place');
    expect(msg).not.toContain('2099');
  });

  test('an invitation whose booking is refused is not sent, and the application stops naming the ride', async ({ page }) => {
    await applicationsTab(page, { 'rpc:staff_community_approve': HUDA }, { table: 'queue_entries', methods: ['POST'] });
    const marks = patches(page, 'community_applications');
    await decide(page, 'a2', 'invite');
    await expect.poll(() => marks.length).toBe(2);
    expect(marks[0].body).toEqual({ invited_session: SAT });
    expect(marks[1].body).toEqual({ invited_session: null });
    expect(marks[1].url).toContain(`invited_session=eq.${SAT}`);                  // guarded on the ride it named
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.locator('#confirm-modal .ca-msg-box')).toHaveCount(0);       // no invitation to a ride with no place
    expect(await page.evaluate(`[_caFind('a2').status,_caFind('a2').invited_session,_caSt(_caFind('a2'))]`)).toEqual(['approved', null, 'approved']);
  });

  test('a refused invitation still shows a password the approval has just made, in its own message', async ({ page }) => {
    await applicationsTab(page, { 'rpc:staff_community_approve': NEW_ACCT }, { table: 'queue_entries', methods: ['POST'] });
    await decide(page, 'a1', 'invite');
    const msgBox = page.locator('#confirm-modal .ca-msg-box');
    await expect(msgBox.locator('.ca-pwd')).toHaveText('Kp7wXr4Mnq');
    const msg = await msgBox.locator('#ca-msg-text').inputValue();
    expect(msg).toContain('Kp7wXr4Mnq');                                              // the password message
    expect(msg).not.toContain('invited');
    expect(msg).not.toContain('Saturday Social Ride');
  });
});

// ── Every row, page by page ──────────────────────────────────────────────────
// The stub answers every GET with the whole fixture; these routes answer the page asked for
// (supabase-js sends .range() as offset/limit), as PostgREST does.
async function paged(page: Page, table: string, rows: Record<string, unknown>[], seen: string[]) {
  await page.route(new RegExp(`/rest/v1/${table}\\?`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const u = new URL(r.request().url());
    seen.push(u.search);
    const off = Number(u.searchParams.get('offset') || 0), lim = Number(u.searchParams.get('limit') || rows.length);
    return r.fulfill({ status: 200, headers: head, body: JSON.stringify(rows.slice(off, off + lim)) });
  });
}

test.describe('@staff:community rb1 lists read whole (2026-10-05)', () => {
  test('the Applications list reads past the newest thousand: the oldest pending one is there', async ({ page }) => {
    const many = Array.from({ length: 1003 }, (_, i) => ({
      ...base, id: `x${String(i).padStart(4, '0')}`, status: i === 1002 ? 'pending' : 'rejected', name: i === 1002 ? 'Oldest Pending' : `Applicant ${i}`,
      email: `applicant${i}@example.test`, phone: '', created_at: new Date(Date.UTC(2026, 8, 22) - i * 60000).toISOString(),
    }));
    await stubSupabase(page, { sessions: RIDES, queue_entries: [], bikes: [], customers, tags: [], customer_tags: [] });
    const seen: string[] = [];
    await paged(page, 'community_applications', many, seen);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
    await page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
    await expect(page.locator('.ca-row')).toHaveCount(1);
    await expect(page.locator('.ca-row .ca-name')).toHaveText('Oldest Pending');
    expect(await page.evaluate('S._caApps.length')).toBe(1003);
    expect(seen.some((s) => /offset=1000/.test(s))).toBe(true);
    expect(seen.every((s) => /order=created_at\.desc%2Cid\.asc|order=created_at\.desc,id\.asc/.test(s))).toBe(true); // a total order, so the pages line up
  });

  test('the Flagged list reads every request, page by page', async ({ page }) => {
    const flags = Array.from({ length: 1002 }, (_, i) => ({
      id: `f${String(i).padStart(4, '0')}`, customer_id: 'c1', fields: ['name'], status: i === 1001 ? 'pending' : 'answered',
      flagged_at: new Date(Date.UTC(2026, 8, 22) - i * 60000).toISOString(), changes: {},
    }));
    await stubSupabase(page, { sessions: RIDES, queue_entries: [], bikes: [], customers, tags: [], customer_tags: [] });
    const seen: string[] = [];
    await paged(page, 'customer_flags', flags, seen);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
    await page.evaluate(`setStaffTab('community');S.communityTab='flagged';renderCommunity()`);
    await page.waitForFunction('Array.isArray(S._flags)&&S._flags.length===1002');
    expect(seen.some((s) => /offset=1000/.test(s))).toBe(true);
    await expect(page.locator('.flg-row[data-flag-id="f1001"]')).toHaveCount(1);
  });
});
