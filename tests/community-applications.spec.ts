import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Community > Applications: what riders sent from micromobility.sa/community/registration.
// Approve makes the account through staff_community_approve (or tags the one they already
// have) and shows the welcome message with the temporary password ONCE; Reject offers a
// polite reply. And the rider's side: a temporary password must be replaced at first sign-in.

const customers = [
  { id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', height: 165, created_at: '2026-01-05T10:00:00Z' },
];
const base = {
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12',
  gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
  customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect',
};
const apps = [
  { ...base, id: 'a1', status: 'pending', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', instagram: 'karim.rides', linkedin: 'karim-mansour-arch' },
  { ...base, id: 'a2', status: 'pending', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', gender: 'female', instagram: 'huda.s', linkedin: 'huda-alsaleh', lang: 'ar', bike_type: 'Hybrid', created_at: '2026-09-21T08:00:00Z' },
  // approved, then the account it made was deleted: customer_id is cleared with it
  { ...base, id: 'a4', status: 'approved', name: 'Gone Account', email: 'gone@gmail.com', phone: '+966554445566', instagram: 'gone.a', linkedin: 'gone-a', existing_account: false, customer_id: null, decided_at: '2026-09-22T08:00:00Z', decided_by: 'Desk A' },
  { ...base, id: 'a3', status: 'rejected', name: 'Old Applicant', email: 'old.applicant@gmail.com', phone: '+966553579024', instagram: 'old.a', linkedin: 'old-a', bike_type: 'Mountain', decided_at: '2026-09-20T08:00:00Z', decided_by: 'Desk B' },
];

async function applicationsTab(page: Page, extra: Record<string, unknown> = {}, routes?: () => Promise<unknown>) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: apps, ...extra });
  if (routes) await routes(); // after the stub, so they are asked first
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
  await expect(page.locator('.ca-row')).toHaveCount(2);
}
const row = (page: Page, id: string) => page.locator(`.ca-row[data-app-id="${id}"]`);

test('the Applications tab shows every answer, the handles as links, and an account the rider already has', async ({ page }) => {
  await applicationsTab(page);
  await expect(page.locator('.filter-pill[data-ca-filter="pending"]')).toHaveText('Pending (2)');
  await expect(page.locator('.filter-pill[data-ca-filter="rejected"]')).toHaveText('Rejected (1)');
  await expect(page.locator('.filter-pill', { hasText: /^Applications \(2\)$/ })).toBeVisible();

  const k = row(page, 'a1');
  await expect(k.locator('.ca-name')).toHaveText('Karim Mansour');
  for (const txt of ['+966552468013', 'karim.mansour@gmail.com', 'Egypt', '178 cm', 'Road', 'Architect', 'Male', 'English']) await expect(k).toContainText(txt);
  await expect(k.locator('a.soc-link[href="https://www.instagram.com/karim.rides"]')).toBeVisible();
  await expect(k.locator('a.soc-link[href="https://www.linkedin.com/in/karim-mansour-arch"]')).toBeVisible();
  await expect(k.locator('.ca-acct')).toHaveCount(0);
  // Staff can reach a pending applicant before deciding: a call, or a WhatsApp chat on their number
  await expect(k.locator('a.ca-call')).toHaveAttribute('href', 'tel:+966552468013');
  await expect(k.locator('a.ca-chat')).toHaveAttribute('href', 'https://wa.me/966552468013');
  await expect(k.locator('a.ca-chat')).toHaveAttribute('target', '_blank');

  // Same email as an account on file: staff are told before approving
  await expect(row(page, 'a2').locator('.ca-acct')).toContainText('Already has an account: Huda Al Saleh');

  await page.locator('.filter-pill[data-ca-filter="rejected"]').click();
  await expect(page.locator('.ca-row')).toHaveCount(1);
  await expect(row(page, 'a3')).toContainText('by Desk B');
  await expect(row(page, 'a3').locator('.ca-grid')).toContainText('Mountain');
  await expect(row(page, 'a3').locator('.ca-reopen')).toBeVisible();
  await expect(row(page, 'a3').locator('a.ca-call, a.ca-chat')).toHaveCount(0); // decided: the reply carries its own WhatsApp
});

// How they heard of us: the community form asks it since 2026-09-28 (the booking app's sign-up no
// longer does), and the card shows the answer in the staff member's language.
test('the card shows how the applicant heard of us, and nothing when the form did not ask', async ({ page }) => {
  await applicationsTab(page, { community_applications: apps.map((a) => (a.id === 'a1' ? { ...a, heard_from: 'invited' } : a)) });
  await expect(row(page, 'a1').locator('.ca-grid')).toContainText('How did you hear about us?');
  await expect(row(page, 'a1').locator('.ca-grid')).toContainText('Invited by MicroMobility');
  await expect(row(page, 'a2').locator('.ca-grid')).not.toContainText('How did you hear about us?');
});

test('before the database has heard_from, the list loads without it', async ({ page }) => {
  const asked: string[] = [];
  await applicationsTab(page, {}, () => page.route(/\/rest\/v1\/community_applications\?/, async (r) => {
    const sel = new URL(r.request().url()).searchParams.get('select') || '';
    asked.push(sel);
    if (sel.includes('heard_from')) return r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42703', message: 'column community_applications.heard_from does not exist' }) });
    return r.fallback();
  }));
  await expect(row(page, 'a1').locator('.ca-name')).toHaveText('Karim Mansour');
  expect(asked.some((x) => x.includes('heard_from'))).toBe(true);
  expect(asked.some((x) => !x.includes('heard_from'))).toBe(true);
});

test('Approve makes the account and shows the welcome message with the temporary password once', async ({ page }) => {
  await applicationsTab(page, {
    'rpc:staff_community_approve': { ok: true, existing: false, customer_id: 'ca01', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', password: 'Kp7wXr4Mnq', lang: 'en', oauth: false },
  });
  const calls: Record<string, unknown>[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /rpc\/staff_community_approve/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });

  await row(page, 'a1').locator('.ca-approve').click();
  await expect(page.locator('#confirm-modal')).toContainText('Approve Karim Mansour?');
  await page.locator('#confirm-modal button', { hasText: 'Approve' }).last().click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ p_id: 'a1', p_by: 'Spec Staff' });

  const dlg = page.locator('#confirm-modal .ca-msg-box');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.ca-pwd')).toHaveText('Kp7wXr4Mnq');
  const msg = await dlg.locator('#ca-msg-text').inputValue();
  expect(msg).toContain('Hi Karim,');
  expect(msg).toContain('Welcome to the Micromobility community!');
  expect(msg).toContain('https://micromobilityrentals.pages.dev');
  expect(msg).toContain('Email: karim.mansour@gmail.com');
  expect(msg).toContain('Mobile: 0552468013');
  expect(msg).toContain('Temporary password: Kp7wXr4Mnq');
  expect(msg).toContain('either your email or your mobile number');
  expect(msg).toContain('choose your own password');
  const wa = await dlg.locator('a.ca-wa').getAttribute('href');
  expect(wa).toMatch(/^https:\/\/wa\.me\/966552468013\?text=/);
  expect(decodeURIComponent(wa!.split('text=')[1])).toBe(msg);

  // The message follows the rider's language; staff can switch it
  await dlg.locator('#ca-msg-lang').selectOption('ar');
  const ar = await dlg.locator('#ca-msg-text').inputValue();
  expect(ar).toContain('Kp7wXr4Mnq');
  expect(ar).not.toContain('Welcome to the Micromobility community');
  await expect(dlg.locator('#ca-msg-text')).toHaveAttribute('dir', 'rtl');

  await dlg.locator('.ca-x').click();
  await page.locator('.filter-pill[data-ca-filter="approved"]').click();
  await expect(row(page, 'a1')).toContainText('New account made');
  await expect(row(page, 'a1').locator('.ca-newpwd')).toBeVisible();
});

test('An applicant who already has an account is told to sign in with it, and gets no password', async ({ page }) => {
  await applicationsTab(page, {
    'rpc:staff_community_approve': { ok: true, existing: true, customer_id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', password: null, lang: 'ar', oauth: false },
  });
  await row(page, 'a2').locator('.ca-approve').click();
  await expect(page.locator('#confirm-modal')).toContainText('already has an account (Huda Al Saleh)');
  await page.locator('#confirm-modal button', { hasText: 'Approve' }).last().click();
  const dlg = page.locator('#confirm-modal .ca-msg-box');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.ca-pwd')).toHaveCount(0);
  await expect(dlg.locator('#ca-msg-lang')).toHaveValue('ar'); // the language the rider applied in
  await dlg.locator('#ca-msg-lang').selectOption('en');
  const msg = await dlg.locator('#ca-msg-text').inputValue();
  expect(msg).toContain('You already have an account with us');
  expect(msg).toContain('Email: huda.saleh@gmail.com');
  expect(msg).toContain('Mobile: 0551239876');
  expect(msg).toContain('Forgot password?');
  expect(msg).not.toContain('Temporary password');
});

// Approving can also give more tags and put the rider on the Final list of a Saturday Social Ride
// that is still open (the owner, 2026-09-29). The Community tag is the approval's own and the
// blacklist is not offered; a tag the account holds is shown ticked and cannot be picked.
const TAGS = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false },
  { id: 'tag_blacklist', slug: 'blacklist', name: 'Blacklist', color: '#0b0b0b', locked: true, auto_grant: false },
  { id: 'tag_vip', slug: 'vip', name: 'VIP', color: '#e0a100', locked: false, auto_grant: false },
  { id: 'tag_lead', slug: 'lead', name: 'Ride Lead', color: '#7a3dd8', locked: false, auto_grant: false },
];
const SAT = '2099-03-07', SAT2 = '2099-03-14';
const ride = (id: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Saturday', session_date: id, status: 'open', capacity: 20, spots: 20, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, bike_slots: '{"_time":"06:00 - 08:00","_total":20}', ...extra,
});
const RIDES = [
  ride(SAT), ride(SAT2),
  ride('2099-03-21', { status: 'closed' }), // closed: not offered
  ride('2020-01-04'), // past: not offered
  ride('2099-03-11', { day: 'Wednesday', ride_kind: 'petromin', needs_approval: false }), // not a Saturday ride
];
function writes(page: Page, table: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) return;
    try { const b = r.postDataJSON(); out.push(...(Array.isArray(b) ? b : [b])); } catch { /* not json */ }
  });
  return out;
}
const chip = (page: Page, id: string) => page.locator(`#confirm-modal .ca-ap-tags [data-ca-tag="${id}"]`);

test('Approve can give more tags and put the rider on a Saturday ride’s final list', async ({ page }) => {
  await applicationsTab(page, {
    tags: TAGS, sessions: RIDES,
    'rpc:staff_community_approve': { ok: true, existing: false, customer_id: 'ca01', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', password: 'Kp7wXr4Mnq', lang: 'en', oauth: false },
  });
  const tagRows = writes(page, 'customer_tags'), bookings = writes(page, 'queue_entries');
  await row(page, 'a1').locator('.ca-approve').click();
  const dlg = page.locator('#confirm-modal .ca-ap-box');
  await expect(dlg).toContainText('Approve Karim Mansour?');

  // Community comes with the approval, ticked and fixed; the blacklist is not there
  await expect(chip(page, 'tag_saturday')).toBeDisabled();
  await expect(chip(page, 'tag_saturday')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'tag_blacklist')).toHaveCount(0);
  await expect(chip(page, 'tag_vip')).toHaveAttribute('aria-pressed', 'false');
  await chip(page, 'tag_vip').click();
  await expect(chip(page, 'tag_vip')).toHaveAttribute('aria-pressed', 'true');
  await chip(page, 'tag_lead').click();
  await chip(page, 'tag_lead').click(); // and off again
  await expect(chip(page, 'tag_lead')).toHaveAttribute('aria-pressed', 'false');

  // Only the open Saturday rides, soonest first, after "Not now"
  // Every available Saturday session is a choice on screen, "Not now" first and picked
  const ride = (id: string) => dlg.locator(`.ca-ap-rides [data-ca-ride="${id}"]`);
  expect(await dlg.locator('.ca-ap-rides .ca-ap-ride').evaluateAll((bs) => bs.map((b) => b.getAttribute('data-ca-ride')))).toEqual(['', SAT, SAT2]);
  await expect(ride('')).toHaveAttribute('aria-checked', 'true');
  await expect(ride(SAT)).toContainText('20 spots left');
  await expect(ride(SAT)).toContainText('Sat');
  await ride(SAT2).click();
  await expect(ride(SAT2)).toHaveAttribute('aria-checked', 'true');
  await expect(ride('')).toHaveAttribute('aria-checked', 'false');
  await chip(page, 'tag_lead').click(); // a redraw keeps the ride picked
  await chip(page, 'tag_lead').click();
  await expect(ride(SAT2)).toHaveAttribute('aria-checked', 'true');

  await dlg.locator('.ca-ap-go').click();
  await expect(page.locator('#confirm-modal .ca-msg-box .ca-pwd')).toHaveText('Kp7wXr4Mnq'); // the welcome message still comes
  await expect.poll(() => tagRows.length).toBe(1);
  expect(tagRows[0]).toMatchObject({ customer_id: 'ca01', tag_id: 'tag_vip', added_by: 'staff' });
  expect(tagRows[0].expires_at ?? null).toBeNull(); // permanent
  await expect.poll(() => bookings.length).toBe(1);
  expect(bookings[0]).toMatchObject({ session_id: SAT2, customer_id: 'ca01', name: 'Karim Mansour', status: 'waiting', approval: 'approved', type_preference: 'Road', height: 178, price: 0 });
  expect(typeof bookings[0].queue_num).toBe('number');
  expect(await page.evaluate(`_hasTagNow('ca01','tag_vip')&&_hasTagNow('ca01','tag_saturday')`)).toBe(true);
});

test('Approve with nothing picked writes no tags and no booking; held tags and booked rides cannot be picked', async ({ page }) => {
  await applicationsTab(page, {
    tags: TAGS, sessions: RIDES,
    customer_tags: [{ customer_id: 'c1', tag_id: 'tag_vip', added_by: 'staff', added_at: 1 }],
    queue_entries: [{ id: 'q1', session_id: SAT, customer_id: 'c1', name: 'Huda Al Saleh', status: 'waiting', approval: 'pending', queue_num: 1, session_day: 'Saturday', session_date: SAT, type_preference: 'Hybrid', registered_at: '2026-09-22T08:00:00Z' }],
    'rpc:staff_community_approve': { ok: true, existing: true, customer_id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', password: null, lang: 'ar', oauth: false },
  });
  const tagRows = writes(page, 'customer_tags'), bookings = writes(page, 'queue_entries');
  await row(page, 'a2').locator('.ca-approve').click();
  await expect(chip(page, 'tag_vip')).toBeDisabled(); // she holds it already
  await expect(chip(page, 'tag_vip')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'tag_lead')).toBeEnabled();
  const booked = page.locator(`.ca-ap-rides [data-ca-ride="${SAT}"]`);
  await expect(booked).toBeDisabled();
  await expect(booked).toContainText('already booked');
  await expect(page.locator(`.ca-ap-rides [data-ca-ride="${SAT2}"]`)).toBeEnabled();
  await page.locator('#confirm-modal .ca-ap-go').click();
  await expect(page.locator('#confirm-modal .ca-msg-box')).toBeVisible();
  await page.waitForTimeout(300);
  expect(tagRows).toEqual([]);
  expect(bookings).toEqual([]);
});

test('with no Saturday ride open the approval says so, and Cancel approves nothing', async ({ page }) => {
  await applicationsTab(page, { tags: TAGS, sessions: [RIDES[2], RIDES[3], RIDES[4]] });
  const calls: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/staff_community_approve/.test(r.url())) calls.push(r.url()); });
  await row(page, 'a1').locator('.ca-approve').click();
  const dlg = page.locator('#confirm-modal .ca-ap-box');
  await expect(dlg).toContainText('No Saturday Social Ride is open right now.');
  await expect(dlg.locator('.ca-ap-rides')).toHaveCount(0);
  await dlg.locator('button', { hasText: 'Cancel' }).click();
  await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(calls).toEqual([]);
  await expect(row(page, 'a1')).toHaveAttribute('data-status', 'pending');
});

// Rejecting can tag too (the owner, 2026-09-29), but only an account the applicant already has: a
// rejection makes none. Community is not offered there; the blacklist is, and takes the Community tag away.
test('Reject can tag an applicant’s existing account, the blacklist included; without an account there is nothing to tag', async ({ page }) => {
  await applicationsTab(page, {
    tags: TAGS,
    customer_tags: [{ customer_id: 'c1', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 }],
    'rpc:staff_community_decide': { ok: true, status: 'rejected' },
  });
  const tagRows = writes(page, 'customer_tags'), dels: string[] = [], decided: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && /\/rest\/v1\/customer_tags\?/.test(r.url())) dels.push(decodeURIComponent(r.url()));
    if (r.method() === 'POST' && /rpc\/staff_community_decide/.test(r.url())) decided.push(JSON.parse(r.postData() || '{}'));
  });

  // No account: the dialog says so and offers no tags
  await row(page, 'a1').locator('.ca-reject').click();
  const dlg = page.locator('#confirm-modal .ca-ap-box');
  await expect(dlg).toContainText('Reject Karim Mansour’s application?');
  await expect(dlg).toContainText('There is no account with this email or phone');
  await expect(dlg.locator('.ca-ap-tags')).toHaveCount(0);
  await expect(dlg.locator('.ca-ap-rides')).toHaveCount(0); // no ride on a rejection
  await dlg.locator('button', { hasText: 'Cancel' }).click();

  // Huda has an account, and it holds Community
  await row(page, 'a2').locator('.ca-reject').click();
  await expect(chip(page, 'tag_saturday')).toHaveCount(0);
  await expect(dlg.locator('.tag-ban-opt')).toHaveCount(0);
  await chip(page, 'tag_blacklist').click();
  await expect(chip(page, 'tag_blacklist')).toHaveAttribute('aria-pressed', 'true');
  await expect(dlg.locator('.tag-ban-opt input')).toBeChecked(); // takes Community away unless unticked
  await chip(page, 'tag_vip').click();
  await dlg.locator('.ca-ap-go').click();
  await expect(page.locator('#confirm-modal .ca-msg-box')).toBeVisible(); // the polite reply still comes
  expect(decided).toEqual([{ p_id: 'a2', p_status: 'rejected', p_by: 'Spec Staff' }]);
  await expect.poll(() => tagRows.length).toBe(2);
  expect(tagRows.map((r) => r.tag_id).sort()).toEqual(['tag_blacklist', 'tag_vip']);
  expect(tagRows.every((r) => r.customer_id === 'c1')).toBe(true);
  await expect.poll(() => dels.some((u) => u.includes('customer_id=eq.c1') && u.includes('tag_id=eq.tag_saturday'))).toBe(true);
  expect(await page.evaluate(`_isBlacklisted('c1')&&!_hasTagNow('c1','tag_saturday')`)).toBe(true);
});

test('Reject asks first, then offers the polite reply; a rejected application can go back to pending', async ({ page }) => {
  await applicationsTab(page, { 'rpc:staff_community_decide': { ok: true, status: 'rejected' } });
  const calls: Record<string, unknown>[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /rpc\/staff_community_decide/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });
  await row(page, 'a1').locator('.ca-reject').click();
  await page.locator('#confirm-modal button', { hasText: 'Reject' }).last().click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ p_id: 'a1', p_status: 'rejected', p_by: 'Spec Staff' });
  const dlg = page.locator('#confirm-modal .ca-msg-box');
  await expect(dlg).toBeVisible();
  const msg = await dlg.locator('#ca-msg-text').inputValue();
  expect(msg).toContain('Thank you for applying');
  expect(msg).toContain('apply again');
  await dlg.locator('.ca-x').click();
  await expect(page.locator('.filter-pill[data-ca-filter="rejected"]')).toHaveText('Rejected (2)');
});

test('A rider signed in with a temporary password must choose their own before anything else', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], 'rpc:customer_pwd_state': true, 'rpc:customer_set_own_password': 'tok-new' });
  await loginCustomer(page, { id: 'ca01', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', session_token: 'tok-temp' });
  const calls: Record<string, unknown>[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /rpc\/customer_set_own_password/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });
  await page.goto('/');
  const gate = page.locator('#pwd-gate .pg-box');
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('Choose your own password');
  await page.fill('#pm-new', 'short');
  await page.fill('#pm-new2', 'short');
  await page.click('#pm-save');
  await expect(page.locator('#pm-err')).toContainText('at least 8 characters');
  await page.fill('#pm-new', 'MyOwnPass9');
  await page.fill('#pm-new2', 'MyOwnPass8');
  await page.click('#pm-save');
  await expect(page.locator('#pm-err')).toContainText('do not match');
  await page.fill('#pm-new2', 'MyOwnPass9');
  await page.click('#pm-save');
  await expect(gate).toHaveCount(0);
  expect(calls).toEqual([{ p_id: 'ca01', p_token: 'tok-temp', p_new_pwd: 'MyOwnPass9' }]);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cq_session') || sessionStorage.getItem('cq_session') || '{}'));
  expect(saved.session_token).toBe('tok-new');
});

test('No password screen for a rider who chose their own', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], 'rpc:customer_pwd_state': false });
  await loginCustomer(page);
  let asked = 0;
  page.on('request', r => { if (/rpc\/customer_pwd_state/.test(r.url())) asked++; });
  await page.goto('/');
  await waitForSb(page);
  await expect.poll(() => asked).toBeGreaterThan(0);
  await expect(page.locator('#pwd-gate')).toHaveCount(0);
});

// An application whose account was deleted afterwards used to offer a new temporary password for
// an account that was not there, and the server's "not_new" came back to staff as "check the
// connection" (2026-09-23).
test('an approved application whose account is gone says so and offers the way back', async ({ page }) => {
  await applicationsTab(page);
  await page.locator('.filter-pill[data-ca-filter="approved"]').click();
  const gone = row(page, 'a4');
  await expect(gone).toContainText('The account made for this application is gone');
  await expect(gone.locator('.ca-newpwd')).toHaveCount(0);      // nothing to give a password to
  await expect(gone.locator('.ca-reopen')).toBeVisible();       // back to pending, then approve again
});

test('the server saying there is no account is not reported as a connection fault', async ({ page }) => {
  await applicationsTab(page, { 'rpc:staff_community_new_password': { ok: false, error: 'not_new' } });
  await page.locator('.filter-pill[data-ca-filter="approved"]').click();
  // force the old path: a row that still believes it has an account
  await page.evaluate(`(S._caApps||[]).forEach(a=>{if(a.id==='a4')a.customer_id='ca-gone';});renderCommunity()`);
  await row(page, 'a4').locator('.ca-newpwd').click();
  await page.locator('#confirm-modal .btn-primary').click();
  const toast = page.locator('#toast-container .toast').first();
  await expect(toast).toContainText('is gone');
  await expect(toast).not.toContainText('connection');
});
