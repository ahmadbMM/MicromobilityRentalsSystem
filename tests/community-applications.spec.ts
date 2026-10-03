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
  await expect(page.locator('.filter-pill', { hasText: /^Applications( \(\d+\))?$/ })).toBeVisible();

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
  await expect(k.locator('a.ca-call')).toHaveAttribute('aria-label', 'Call'); // icons, the words are their labels
  await expect(k.locator('a.ca-call svg, a.ca-chat svg')).toHaveCount(2);
  expect((await k.locator('a.ca-call').innerText()).trim()).toBe('');

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
test('the card shows how the applicant heard of us, and Not answered when it is empty', async ({ page }) => {
  await applicationsTab(page, { community_applications: apps.map((a) => (a.id === 'a1' ? { ...a, heard_from: 'invited' } : a)) });
  await expect(row(page, 'a1').locator('.ca-grid')).toContainText('How did you hear about us?');
  await expect(row(page, 'a1').locator('.ca-grid')).toContainText('Invited by MicroMobility');
  await expect(row(page, 'a2').locator('.ca-kv', { hasText: 'How did you hear about us?' })).toContainText('Not answered');
});

// Every question the form asks keeps its line on the card, answered or not (the owner,
// 2026-09-29: "show the unanswered/filled fields, don't hide them").
test('every question has its line, an empty answer reading Not answered', async ({ page }) => {
  const blank = { instagram: '', linkedin: '', workplace: null, heard_from: null, profession: '', own_bike: null };
  await applicationsTab(page, { community_applications: apps.map((a) => (a.id === 'a2' ? { ...a, ...blank } : a.id === 'a1' ? { ...a, workplace: 'Aramco', heard_from: 'friend', own_bike: true } : a)) });
  const labels = ['Mobile', 'Email', 'Born', 'Gender', 'Nationality', 'Height', 'Own bike', 'Bike', 'Profession', 'Company', 'How did you hear about us?', 'Instagram', 'LinkedIn', 'Ride news', 'Form language'];
  for (const id of ['a1', 'a2']) expect(await row(page, id).locator('.ca-kv > span').allTextContents()).toEqual(labels);
  const k = row(page, 'a1');
  await expect(k.locator('.ca-kv-none')).toHaveCount(0);
  await expect(k.locator('.ca-kv', { hasText: 'Company' })).toContainText('Aramco');
  await expect(k.locator('.ca-kv', { hasText: 'Own bike' }).locator('b')).toHaveText('Yes'); // asked since 2026-09-30
  await expect(k.locator('.ca-kv', { hasText: 'Instagram' }).locator('a.soc-link')).toHaveAttribute('href', 'https://www.instagram.com/karim.rides');
  // the handle reads as typed, not in the labels' capitals
  await expect(k.locator('.ca-kv', { hasText: 'Instagram' }).locator('.soc-link span')).toHaveCSS('text-transform', 'none');
  const h = row(page, 'a2');
  const empty = ['Own bike', 'Profession', 'Company', 'How did you hear about us?', 'Instagram', 'LinkedIn'];
  await expect(h.locator('.ca-kv-none')).toHaveCount(empty.length);
  for (const k2 of empty) await expect(h.locator('.ca-kv', { hasText: k2 }).locator('b')).toHaveText('Not answered');
  await expect(h.locator('.soc-link')).toHaveCount(0);
  await expect(h.locator('.ca-kv', { hasText: 'Ride news' })).toContainText('Yes');

  // in Arabic too
  await page.evaluate(`setLang('ar')`);
  await expect(row(page, 'a2').locator('.ca-kv-none b').first()).toHaveText('لم تتم الإجابة');
});

// Since 2026-09-30 the form makes the applicant's account first and the application carries it
// (customer_id): the card names that account, whatever its email or mobile is now.
test('an application sent from an account names that account', async ({ page }) => {
  await applicationsTab(page, { community_applications: [{ ...apps[0], customer_id: 'c1', email: 'karim.new@gmail.com', phone: '+966559990000' }, ...apps.slice(1)] });
  await expect(row(page, 'a1').locator('.ca-acct')).toContainText('Already has an account: Huda Al Saleh');
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

// No application reply carries account details (the owner, 2026-09-30): the welcome is the welcome.
// An application from before the form made accounts gets one made by its approval; its temporary
// password is shown once, and goes to the rider in the password message.
test('Approve (an application from before the form made accounts): a welcome without account details, the password in its own message', async ({ page }) => {
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
  expect(msg).toBe(['Hi Karim,', '', 'Welcome to the MicroMobility community!', '',
    'We’re delighted to let you know that your membership application has been approved. You’re now part of a community of riders who love riding together, and we can’t wait to ride with you.', '',
    'You can now book our community rides, which are open to members only.', '',
    'Follow us on Instagram for ride photos and news:', 'https://www.instagram.com/MicroMobilitySA/', '', // every application message (2026-09-30)
    'See you on the road!', 'The MicroMobility team'].join('\n'));
  for (const none of ['Kp7wXr4Mnq', 'karim.mansour@gmail.com', '0552468013', 'micromobilityrentals.pages.dev', 'password', 'sign in', 'Google', 'Apple']) expect(msg).not.toContain(none);
  const wa = await dlg.locator('a.ca-wa').getAttribute('href');
  expect(wa).toMatch(/^https:\/\/wa\.me\/966552468013\?text=/);
  expect(decodeURIComponent(wa!.split('text=')[1])).toBe(msg);

  // The message follows the rider's language; staff can switch it
  await dlg.locator('#ca-msg-lang').selectOption('ar');
  const ar = await dlg.locator('#ca-msg-text').inputValue();
  expect(ar).toContain('يمكنك الآن حجز جولات المجتمع');
  expect(ar).not.toContain('Kp7wXr4Mnq');
  await expect(dlg.locator('#ca-msg-text')).toHaveAttribute('dir', 'rtl');

  // The password message: the password, where to sign in, and that it is changed at once.
  await dlg.locator('#ca-msg-lang').selectOption('en');
  await dlg.locator('.ca-tp-go').click();
  const pw = await dlg.locator('#ca-msg-text').inputValue();
  expect(pw).toBe(['Hi Karim,', '', 'We’ve set a temporary password for your MicroMobility account:', 'Kp7wXr4Mnq', '', 'Sign in with it here:', 'https://micromobilityrentals.pages.dev', '',
    'As soon as you sign in with it, you’ll be asked to change it to a password of your own.', '',
    'Follow us on Instagram for ride photos and news:', 'https://www.instagram.com/MicroMobilitySA/', '', 'The MicroMobility team'].join('\n'));
  await expect(dlg.locator('.ca-tp-go')).toHaveCount(0);

  await dlg.locator('.ca-x').click();
  await page.locator('.filter-pill[data-ca-filter="approved"]').click();
  await expect(row(page, 'a1')).toContainText('New account made');
  await expect(row(page, 'a1').locator('.ca-newpwd')).toBeVisible();
});

test('An applicant with an account gets the welcome, with no account details and no password', async ({ page }) => {
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
  await expect(dlg.locator('.ca-tp-go')).toHaveCount(0);
  await dlg.locator('#ca-msg-lang').selectOption('en');
  const msg = await dlg.locator('#ca-msg-text').inputValue();
  expect(msg).toContain('Hi Huda,');
  expect(msg).toContain('your membership application has been approved');
  expect(msg).toContain('You can now book our community rides');
  for (const none of ['huda.saleh@gmail.com', '0551239876', 'micromobilityrentals.pages.dev', 'password', 'Forgot', 'sign in', 'Google']) expect(msg).not.toContain(none);
});

// Approving can also give more tags and put the rider on the Final list of a Saturday Social Ride
// that is still open (the owner, 2026-09-29). The Community tag starts ticked and can be unticked
// (the owner, 2026-09-29, later); the blacklist is not offered; a tag the account holds is shown
// ticked and cannot be picked.
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

  // Community comes with the approval, ticked to start with but free to untick; the blacklist is not there
  await expect(chip(page, 'tag_saturday')).toBeEnabled();
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
  // a Saturday ride asks the rider's group before the approval can go (2026-10-02)
  await expect(dlg.locator('.ca-ap-go')).toBeDisabled();
  await dlg.locator('.rg-field [data-rg="int"]').click();

  await dlg.locator('.ca-ap-go').click();
  await expect(page.locator('#confirm-modal .ca-msg-box .ca-pwd')).toHaveText('Kp7wXr4Mnq'); // the welcome message still comes
  // the welcome names the ride picked and what to do before it (the owner, 2026-09-30)
  const welcome = await page.locator('#confirm-modal #ca-msg-text').inputValue();
  expect(welcome).toContain('We’ve also saved you a place on this Saturday Social Ride:');
  expect(welcome).toContain('Before the ride:\n• Your booking and its QR code are waiting in “My Bookings”.');
  expect(welcome).toContain('please cancel from “My Bookings” so someone else can take your place.\n\nFollow us on Instagram for ride photos and news:\nhttps://www.instagram.com/MicroMobilitySA/\n\nSee you on the road!');
  await expect.poll(() => tagRows.length).toBe(1);
  expect(tagRows[0]).toMatchObject({ customer_id: 'ca01', tag_id: 'tag_vip', added_by: 'staff' });
  expect(tagRows[0].expires_at ?? null).toBeNull(); // permanent
  await expect.poll(() => bookings.length).toBe(1);
  expect(bookings[0]).toMatchObject({ session_id: SAT2, customer_id: 'ca01', name: 'Karim Mansour', status: 'waiting', approval: 'approved', type_preference: 'Road', height: 178, price: 0, ride_group: 'int' });
  expect(typeof bookings[0].queue_num).toBe('number');
  expect(await page.evaluate(`_hasTagNow('ca01','tag_vip')&&_hasTagNow('ca01','tag_saturday')`)).toBe(true);
});

// The owner, 2026-09-29: "dont force the community tag selection when approving a community form
// registration, pre select it but give the staff the choice to unselect it".
test('Community can be unticked: the approval then asks the server for no Community tag', async ({ page }) => {
  await applicationsTab(page, {
    tags: TAGS, sessions: RIDES,
    'rpc:staff_community_approve': { ok: true, existing: false, customer_id: 'ca01', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', password: 'Kp7wXr4Mnq', lang: 'en', oauth: false },
  });
  const calls: Record<string, unknown>[] = [], dels: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /rpc\/staff_community_approve/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}'));
    if (r.method() === 'DELETE' && /\/rest\/v1\/customer_tags\?/.test(r.url())) dels.push(r.url());
  });
  await row(page, 'a1').locator('.ca-approve').click();
  const dlg = page.locator('#confirm-modal .ca-ap-box');
  await expect(dlg).toContainText('and the Community tag is added');
  await chip(page, 'tag_saturday').click();
  await expect(chip(page, 'tag_saturday')).toHaveAttribute('aria-pressed', 'false');
  await expect(dlg).toContainText('without the Community tag');
  await chip(page, 'tag_saturday').click(); // back on, and off again
  await expect(dlg).toContainText('and the Community tag is added');
  await chip(page, 'tag_saturday').click();
  await dlg.locator('.ca-ap-go').click();
  await expect(page.locator('#confirm-modal .ca-msg-box .ca-pwd')).toHaveText('Kp7wXr4Mnq');
  expect(calls).toEqual([{ p_id: 'a1', p_by: 'Spec Staff', p_community: false }]);
  await page.waitForTimeout(300);
  expect(dels).toEqual([]); // the server left it out; nothing to take off
  expect(await page.evaluate(`_hasTagNow('ca01','tag_saturday')`)).toBe(false);
});

test('unticked on a database from before p_community: approved the old way, then the tag it gave comes off', async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  await applicationsTab(page, { tags: TAGS }, () => page.route(/\/rest\/v1\/rpc\/staff_community_approve/, async (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    calls.push(body);
    if ('p_community' in body) return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.staff_community_approve(p_by, p_community, p_id) in the schema cache' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, existing: true, customer_id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', password: null, lang: 'ar', oauth: false }) });
  }));
  const dels: string[] = [];
  page.on('request', (r) => { if (r.method() === 'DELETE' && /\/rest\/v1\/customer_tags\?/.test(r.url())) dels.push(decodeURIComponent(r.url())); });
  await row(page, 'a2').locator('.ca-approve').click();
  const dlg = page.locator('#confirm-modal .ca-ap-box');
  await expect(dlg).toContainText('It gets the Community tag');
  await chip(page, 'tag_saturday').click();
  await expect(dlg).toContainText('It does not get the Community tag');
  await dlg.locator('.ca-ap-go').click();
  await expect(page.locator('#confirm-modal .ca-msg-box')).toBeVisible();
  expect(calls).toEqual([{ p_id: 'a2', p_by: 'Spec Staff', p_community: false }, { p_id: 'a2', p_by: 'Spec Staff' }]);
  await expect.poll(() => dels.some((u) => u.includes('customer_id=eq.c1') && u.includes('tag_id=eq.tag_saturday'))).toBe(true);
  expect(await page.evaluate(`_hasTagNow('c1','tag_saturday')`)).toBe(false);
  // the approved card does not claim it tagged the account
  await page.evaluate(`_caMsgClose()`);
  await page.locator('.filter-pill[data-ca-filter="approved"]').click();
  await expect(row(page, 'a2').locator('.ca-acct')).toContainText('Uses their existing account');
});

test('an account that already holds Community shows it ticked and fixed, and approving leaves its grant alone', async ({ page }) => {
  await applicationsTab(page, {
    tags: TAGS,
    customer_tags: [{ customer_id: 'c1', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 }],
    'rpc:staff_community_approve': { ok: true, existing: true, customer_id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', password: null, lang: 'ar', oauth: false },
  });
  const calls: Record<string, unknown>[] = [], dels: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /rpc\/staff_community_approve/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}'));
    if (r.method() === 'DELETE' && /\/rest\/v1\/customer_tags\?/.test(r.url())) dels.push(r.url());
  });
  await row(page, 'a2').locator('.ca-approve').click();
  await expect(chip(page, 'tag_saturday')).toBeDisabled();
  await expect(chip(page, 'tag_saturday')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#confirm-modal .ca-ap-go').click();
  await expect(page.locator('#confirm-modal .ca-msg-box')).toBeVisible();
  expect(calls).toEqual([{ p_id: 'a2', p_by: 'Spec Staff' }]);
  await page.waitForTimeout(300);
  expect(dels).toEqual([]);
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
  await expect(gate.locator('.pg-kicker')).toHaveText('Password'); // any account may be here, not only a new member
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

// Invite to ride (the owner, 2026-09-30): an approval without the Community tag that puts the
// rider on a Saturday Social Ride staff must pick, with no tag ticked to start with, and an
// invitation to send, the community's WhatsApp group link added when staff tick it. The invitation
// carries no account details: no reply to a community application does (the owner, 2026-09-30).
const WA_GROUP = 'https://chat.whatsapp.com/DEWPeDbRwb503PHu0R9qax?s=cl&p=i&mlu=0&ilr=4';
const MEET = 'https://maps.app.goo.gl/meetHere';
const INV_RIDES = [RIDES[0], { ...RIDES[1], meet_url: MEET, title: 'Sunrise Loop' }, ...RIDES.slice(2)];
function patches(page: Page, table: string) {
  const out: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'PATCH' || !new RegExp(`/rest/v1/${table}\\?`).test(r.url())) return;
    try { out.push({ url: decodeURIComponent(r.url()), body: r.postDataJSON() }); } catch { /* not json */ }
  });
  return out;
}

test('Invite to ride: no tag ticked, a ride to pick, then the approval without Community, the booking and the invitation', async ({ page }) => {
  await applicationsTab(page, {
    tags: TAGS, sessions: INV_RIDES,
    'rpc:staff_community_approve': { ok: true, existing: false, customer_id: 'ca01', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', password: 'Kp7wXr4Mnq', lang: 'en', oauth: false },
  });
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/staff_community_approve/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });
  const tagRows = writes(page, 'customer_tags'), bookings = writes(page, 'queue_entries'), marks = patches(page, 'community_applications');

  await expect(row(page, 'a1').locator('.ca-invite')).toHaveText('Invite to ride');
  await row(page, 'a1').locator('.ca-invite').click();
  const dlg = page.locator('#confirm-modal .ca-ap-box');
  await expect(dlg).toHaveAttribute('data-ca-kind', 'invite');
  await expect(dlg).toContainText('Invite Karim Mansour to ride?');
  await expect(dlg).toContainText('No tag is added unless you pick one');
  // every tag offered but the blacklist, none ticked, Community included
  for (const id of ['tag_saturday', 'tag_vip', 'tag_lead']) {
    await expect(chip(page, id)).toBeEnabled();
    await expect(chip(page, id)).toHaveAttribute('aria-pressed', 'false');
  }
  await expect(chip(page, 'tag_blacklist')).toHaveCount(0);
  // the live Saturday rides and nothing else: no "Not now", none picked, and Invite waits for one
  const ride = (id: string) => dlg.locator(`.ca-ap-rides [data-ca-ride="${id}"]`);
  expect(await dlg.locator('.ca-ap-rides .ca-ap-ride').evaluateAll((bs) => bs.map((b) => b.getAttribute('data-ca-ride')))).toEqual([SAT, SAT2]);
  await expect(dlg.locator('.ca-ap-rides [aria-checked="true"]')).toHaveCount(0);
  await expect(dlg.locator('.ca-ap-go')).toBeDisabled();
  await expect(dlg.locator('.ca-ap-go')).toHaveText('Invite to ride');
  await chip(page, 'tag_vip').click();
  await ride(SAT2).click();
  await expect(ride(SAT2)).toHaveAttribute('aria-checked', 'true');
  await expect(dlg.locator('.ca-ap-go')).toBeDisabled(); // the group comes next (2026-10-02)
  await dlg.locator('.rg-field [data-rg="beg"]').click();
  await expect(dlg.locator('.ca-ap-go')).toBeEnabled();
  await dlg.locator('.ca-ap-go').click();

  const msgBox = page.locator('#confirm-modal .ca-msg-box');
  await expect(msgBox.locator('.ca-pwd')).toHaveText('Kp7wXr4Mnq'); // to staff, once; never in the message
  expect(calls).toEqual([{ p_id: 'a1', p_by: 'Spec Staff', p_community: false }]);
  await expect.poll(() => marks.length).toBe(1);
  expect(marks[0].url).toContain('id=eq.a1');
  expect(marks[0].body).toEqual({ invited_session: SAT2 });
  await expect.poll(() => tagRows.length).toBe(1);
  expect(tagRows[0]).toMatchObject({ customer_id: 'ca01', tag_id: 'tag_vip' });
  await expect.poll(() => bookings.length).toBe(1);
  expect(bookings[0]).toMatchObject({ session_id: SAT2, customer_id: 'ca01', status: 'waiting', approval: 'approved' });
  expect(await page.evaluate(`_hasTagNow('ca01','tag_saturday')`)).toBe(false);

  // the invitation: the ride's title, day, times and meeting point, and nothing about the account
  await expect(msgBox.locator('.ca-msg-sub')).toHaveText('Send this to the rider. They are already on the final list of this ride.');
  const text = () => msgBox.locator('#ca-msg-text').inputValue();
  let msg = await text();
  expect(msg).toBe([
    'Hi Karim,', '',
    'You’re invited to our Saturday Social Ride!', '',
    'Thank you for applying to join the MicroMobility community. We’d love to ride with you, so we’ve saved you a place on this ride:',
    'Sunrise Loop', 'Saturday, 14 March 2099', 'Gathering 6:00 am · Ride starts 8:00 am', 'Meeting point: ' + MEET, '',
    'Before the ride:',
    '• Your booking and its QR code are waiting in “My Bookings”.',
    '• Have your QR code ready when you arrive; we scan it to check you in.',
    '• If you can’t make it, please cancel from “My Bookings” so someone else can take your place.', '',
    'Follow us on Instagram for ride photos and news:', 'https://www.instagram.com/MicroMobilitySA/', '',
    'See you on the road!', 'The MicroMobility team',
  ].join('\n'));
  for (const none of ['Kp7wXr4Mnq', 'karim.mansour@gmail.com', '0552468013', 'micromobilityrentals.pages.dev', 'password', 'chat.whatsapp.com']) expect(msg).not.toContain(none);
  const wa = msgBox.locator('#ca-msg-wa');
  await expect(wa).not.toBeChecked();
  await expect(msgBox.locator('.ca-wa-opt')).toContainText('Include the WhatsApp group link');
  await wa.check();
  msg = await text();
  expect(msg).toContain('Join our WhatsApp group for ride updates:\n' + WA_GROUP + '\n\nFollow us on Instagram');
  const href = await msgBox.locator('a.ca-wa').getAttribute('href');
  expect(decodeURIComponent(href!.split('text=')[1])).toBe(msg); // what WhatsApp opens with is the text shown
  // another language keeps the tick
  await msgBox.locator('#ca-msg-lang').selectOption('ar');
  msg = await text();
  expect(msg).toContain('ندعوك إلى جولة السبت الاجتماعية');
  expect(msg).toContain(WA_GROUP);
  await expect(msgBox.locator('#ca-msg-wa')).toBeChecked();
  await msgBox.locator('#ca-msg-wa').uncheck();
  expect(await text()).not.toContain(WA_GROUP);

  // the card: Invited, a list of its own, naming the ride
  await msgBox.locator('.ca-x').click();
  await expect(page.locator('.filter-pill[data-ca-filter="invited"]')).toHaveText('Invited (1)');
  await expect(page.locator('.filter-pill[data-ca-filter="pending"]')).toHaveText('Pending (1)');
  await page.locator('.filter-pill[data-ca-filter="invited"]').click();
  const k = row(page, 'a1');
  await expect(k).toHaveAttribute('data-status', 'invited');
  await expect(k.locator('.ca-status')).toHaveText('Invited');
  const day = await page.evaluate(`dayLabel('Saturday')+' '+shortDate('${SAT2}')`);
  await expect(k.locator('.ca-acct')).toContainText(`Invited to the Saturday Social Ride on ${day} · New account made`);
  await expect(k.locator('.ca-inv-msg')).toHaveText('Invitation message');
  await expect(k.locator('.ca-newpwd')).toBeVisible();
});

test('an invited application reads Invited and writes its invitation again; a new password goes in the account message', async ({ page }) => {
  const invited = [
    { ...base, id: 'a5', status: 'approved', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', gender: 'female', instagram: '', linkedin: '', lang: 'ar', decided_at: '2026-09-29T08:00:00Z', decided_by: 'Desk A', customer_id: 'c1', existing_account: true, account_oauth: false, invited_session: SAT },
    { ...base, id: 'a6', status: 'approved', name: 'Sami Haddad', email: 'sami.haddad@gmail.com', phone: '+966557771122', instagram: '', linkedin: '', decided_at: '2026-09-29T08:00:00Z', decided_by: 'Desk A', customer_id: 'ca06', existing_account: false, account_oauth: false, invited_session: SAT2 },
  ];
  await applicationsTab(page, {
    sessions: INV_RIDES, community_applications: [...apps, ...invited],
    'rpc:staff_community_new_password': { ok: true, existing: false, customer_id: 'ca06', name: 'Sami Haddad', email: 'sami.haddad@gmail.com', phone: '+966557771122', password: 'Nw4pQx8Lrt', lang: 'en' },
  });
  await expect(page.locator('.filter-pill[data-ca-filter="invited"]')).toHaveText('Invited (2)');
  await expect(page.locator('.filter-pill[data-ca-filter="approved"]')).toHaveText('Approved (1)'); // the plain approval only
  await page.locator('.filter-pill[data-ca-filter="invited"]').click();
  await expect(page.locator('.ca-row')).toHaveCount(2);
  const h = row(page, 'a5');
  await expect(h.locator('.ca-acct')).toContainText('Invited to the Saturday Social Ride on');
  await expect(h.locator('.ca-acct')).toContainText('Uses their existing account');
  await expect(h.locator('.ca-newpwd')).toHaveCount(0); // her own account: no password to give

  await h.locator('.ca-inv-msg').click();
  const msgBox = page.locator('#confirm-modal .ca-msg-box');
  await expect(msgBox.locator('#ca-msg-lang')).toHaveValue('ar'); // the language she applied in
  await expect(msgBox.locator('.ca-msg-sub')).toContainText('already on the final list');
  await expect(msgBox.locator('.ca-pwd')).toHaveCount(0);
  await msgBox.locator('#ca-msg-lang').selectOption('en');
  const msg = await msgBox.locator('#ca-msg-text').inputValue();
  expect(msg).toContain('Hi Huda,');
  expect(msg).toContain('You’re invited to our Saturday Social Ride!');
  expect(msg).toContain('Saturday, 7 March 2099');
  expect(msg).not.toContain('Meeting point'); // this ride has no meeting point link
  for (const none of ['huda.saleh@gmail.com', '0551239876', 'micromobilityrentals.pages.dev', 'password']) expect(msg).not.toContain(none);
  await msgBox.locator('.ca-x').click();

  // an account the invitation made: a new temporary password goes in the account message, not the invitation
  await row(page, 'a6').locator('.ca-newpwd').click();
  await page.locator('#confirm-modal .btn-primary').click();
  await expect(msgBox.locator('.ca-pwd')).toHaveText('Nw4pQx8Lrt');
  const again = await msgBox.locator('#ca-msg-text').inputValue();
  expect(again).toContain('We’ve set a temporary password for your MicroMobility account:\nNw4pQx8Lrt');
  expect(again).toContain('As soon as you sign in with it, you’ll be asked to change it to a password of your own.');
  for (const none of ['sami.haddad@gmail.com', '0557771122']) expect(again).not.toContain(none);
  expect(again).not.toContain('invited');
  await msgBox.locator('.ca-x').click();
  // its invitation again carries only the ride
  await row(page, 'a6').locator('.ca-inv-msg').click();
  await expect(msgBox.locator('.ca-pwd')).toHaveCount(0);
  const inv = await msgBox.locator('#ca-msg-text').inputValue();
  expect(inv).toContain('Saturday, 14 March 2099');
  expect(inv).not.toContain('password');
});

test('with no Saturday ride open, Invite to ride cannot go ahead', async ({ page }) => {
  await applicationsTab(page, { tags: TAGS, sessions: [RIDES[2], RIDES[3], RIDES[4]] });
  const calls: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/staff_community_approve/.test(r.url())) calls.push(r.url()); });
  await row(page, 'a1').locator('.ca-invite').click();
  const dlg = page.locator('#confirm-modal .ca-ap-box');
  await expect(dlg).toContainText('No Saturday Social Ride is open right now.');
  await expect(dlg.locator('.ca-ap-go')).toBeDisabled();
  await page.evaluate(`_caApGo()`); // even called directly, nothing is approved
  await page.waitForTimeout(200);
  expect(calls).toEqual([]);
  await expect(row(page, 'a1')).toHaveAttribute('data-status', 'pending');
});

test('before the database has invited_session, the list loads and an invitation still goes out', async ({ page }) => {
  const asked: string[] = [];
  await applicationsTab(page, {
    tags: TAGS, sessions: INV_RIDES,
    'rpc:staff_community_approve': { ok: true, existing: true, customer_id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', password: null, lang: 'ar', oauth: false },
  }, async () => {
    await page.route(/\/rest\/v1\/community_applications\?/, async (r) => {
      const req = r.request();
      const hdr = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
      if (req.method() === 'GET') {
        const sel = new URL(req.url()).searchParams.get('select') || '';
        asked.push(sel);
        if (sel.includes('invited_session')) return r.fulfill({ status: 400, headers: hdr, body: JSON.stringify({ code: '42703', message: 'column community_applications.invited_session does not exist' }) });
      }
      if (req.method() === 'PATCH') return r.fulfill({ status: 400, headers: hdr, body: JSON.stringify({ code: 'PGRST204', message: "Could not find the 'invited_session' column of 'community_applications' in the schema cache" }) });
      return r.fallback();
    });
  });
  await expect(row(page, 'a2').locator('.ca-name')).toHaveText('Huda Al Saleh');
  expect(asked.some((x) => x.includes('invited_session'))).toBe(true);
  expect(asked.some((x) => !x.includes('invited_session') && x.includes('workplace'))).toBe(true); // only that column is dropped
  await row(page, 'a2').locator('.ca-invite').click();
  await page.locator(`#confirm-modal .ca-ap-rides [data-ca-ride="${SAT}"]`).click();
  await page.locator('#confirm-modal .rg-field [data-rg="beg"]').click();
  await page.locator('#confirm-modal .ca-ap-go').click();
  await expect(page.locator('#confirm-modal .ca-msg-box')).toBeVisible();
  await expect(page.locator('#err-bar-el')).toHaveCount(0); // a column still to come is not an error for staff
  await page.locator('#confirm-modal #ca-msg-lang').selectOption('en');
  expect(await page.locator('#ca-msg-text').inputValue()).toContain('Saturday, 7 March 2099');
});

// A phone folds the search into a button: open it first
const openSearch = async (page: Page, key: string) => {
  const b = page.locator(`[data-srch="${key}"] .srch-btn`);
  if (await b.isVisible()) await b.click();
};

// Both Applications lists have a search (the owner, 2026-09-30: "add a search button for the
// applications sections"): a name, an email, a phone in any format, a company or a handle. It
// narrows the list the status pill picks, each pill counting its matches.
test('the search narrows the list, finds a phone typed the Saudi way and a handle, and the pills count the matches', async ({ page }) => {
  await applicationsTab(page, { community_applications: apps.map((a) => (a.id === 'a1' ? { ...a, workplace: 'Red Sea Global' } : a)) });
  const q = page.locator('#ca-q');
  await expect(q).toHaveAttribute('placeholder', 'Search name, email or phone');
  await openSearch(page, 'caq');
  await q.fill('huda');
  await expect(page.locator('.ca-row')).toHaveCount(1);
  await expect(row(page, 'a2')).toBeVisible();
  await expect(page.locator('.filter-pill[data-ca-filter="pending"]')).toHaveText('Pending (1)');
  await expect(page.locator('.filter-pill[data-ca-filter="rejected"]')).toHaveText('Rejected (0)');
  await expect(q).toBeFocused(); // typing repaints the list and the counts, not the box
  // Old Applicant's +966553579024 typed the Saudi way: not pending, the Rejected pill counts it
  await q.fill('0553579024');
  await expect(page.locator('.ca-list')).toContainText('Nothing found.');
  await expect(page.locator('.filter-pill[data-ca-filter="pending"]')).toHaveText('Pending (0)');
  await expect(page.locator('.filter-pill[data-ca-filter="rejected"]')).toHaveText('Rejected (1)');
  await page.locator('.filter-pill[data-ca-filter="rejected"]').click();
  await expect(page.locator('.ca-row')).toHaveCount(1);
  await expect(row(page, 'a3')).toBeVisible();
  await expect(page.locator('#ca-q')).toHaveValue('0553579024'); // the search stays across the pills
  await page.locator('.filter-pill[data-ca-filter="pending"]').click();
  for (const [text, id] of [['@karim.rides', 'a1'], ['red sea', 'a1'], ['HUDA.SALEH@', 'a2']]) {
    await page.locator('#ca-q').fill(text);
    await expect(page.locator('.ca-row')).toHaveCount(1);
    await expect(row(page, id)).toBeVisible();
  }
  // × empties it and brings the whole list back
  await page.locator('[data-srch="caq"] .search-clear').click();
  await expect(page.locator('#ca-q')).toHaveValue('');
  await expect(page.locator('.ca-row')).toHaveCount(2);
  await expect(page.locator('.filter-pill[data-ca-filter="rejected"]')).toHaveText('Rejected (1)');
});

test('a redraw of Community while staff type keeps the search, its text and its focus', async ({ page }) => {
  await applicationsTab(page);
  await openSearch(page, 'caq');
  await page.locator('#ca-q').fill('karim');
  await expect(page.locator('.ca-row')).toHaveCount(1);
  await page.evaluate(`renderCommunity()`); // what a list reload or a realtime change does
  await expect(page.locator('#ca-q')).toBeFocused();
  await expect(page.locator('#ca-q')).toHaveValue('karim');
  await expect(page.locator('.ca-row')).toHaveCount(1);
  await page.keyboard.type('x');
  await expect(page.locator('.ca-list')).toContainText('Nothing found.');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the Applications search is a search button that opens where it stands and folds back on ×', async ({ page }) => {
    await applicationsTab(page);
    const wrap = page.locator('[data-srch="caq"]');
    await expect(page.locator('#ca-q')).toBeHidden();
    await wrap.locator('.srch-btn').click();
    await expect(page.locator('#ca-q')).toBeFocused();
    await page.locator('#ca-q').fill('huda');
    await expect(page.locator('.ca-row')).toHaveCount(1);
    await wrap.locator('.search-clear').click();
    await expect(page.locator('#ca-q')).toBeHidden();
    await expect(wrap.locator('.srch-btn')).toBeVisible();
    await expect(page.locator('.ca-row')).toHaveCount(2);
  });
});

// The owner, 2026-09-30: an invited rider is taken into the community (the Community tag) or
// blacklisted (the blacklist tag), with buttons on the Invited card.
test('Invited: Add to Community gives the Community tag; Blacklist gives the blacklist tag and takes Community off', async ({ page }) => {
  const people = [...customers, { id: 'c2', name: 'Omar Hadi', email: 'omar.hadi@gmail.com', phone: '+966557778899', height: 180, created_at: '2026-01-05T10:00:00Z' }];
  const inv = (id: string, name: string, cid: string) => ({ ...base, id, status: 'approved', name, email: `${cid}@example.test`, phone: '+966550000000',
    instagram: '', linkedin: '', existing_account: true, customer_id: cid, decided_at: '2026-09-23T08:00:00Z', invited_session: SAT });
  const dels: string[] = [];
  page.on('request', (r) => { if (r.method() === 'DELETE' && /\/rest\/v1\/customer_tags\?/.test(r.url())) dels.push(decodeURIComponent(r.url())); });
  await stubSupabase(page, { sessions: [ride(SAT)], queue_entries: [], bikes: [], customers: people, tags: TAGS,
    customer_tags: [{ customer_id: 'c2', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 }],
    community_applications: [apps[0], inv('i1', 'Huda Al Saleh', 'c1'), inv('i2', 'Omar Hadi', 'c2')] });
  const tagRows = writes(page, 'customer_tags');
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>1');
  await page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
  await page.locator('.filter-pill[data-ca-filter="invited"]').click();
  // not yet in the community: both buttons; a member already: Blacklist only
  await expect(row(page, 'i1').locator('.ca-inv-comm')).toHaveText('Add to Community');
  await expect(row(page, 'i1').locator('.ca-inv-ban')).toHaveText('Blacklist');
  await expect(row(page, 'i2').locator('.ca-inv-comm')).toHaveCount(0);
  await expect(row(page, 'i2').locator('.ca-inv-out[data-out="comm"]')).toContainText('In the community');
  await expect(row(page, 'i1').locator('.ca-inv-out')).toHaveCount(0);

  await row(page, 'i1').locator('.ca-inv-comm').click();
  await expect(page.locator('#confirm-modal')).toContainText('Add Huda Al Saleh to the community?');
  await page.locator('#confirm-modal .btn-primary').click();
  await expect.poll(() => tagRows.length).toBe(1);
  expect(tagRows[0]).toMatchObject({ customer_id: 'c1', tag_id: 'tag_saturday', added_by: 'staff' });
  await expect(row(page, 'i1').locator('.ca-inv-out[data-out="comm"]')).toContainText('In the community');
  await expect(row(page, 'i1').locator('.ca-inv-comm')).toHaveCount(0);
  expect(await page.evaluate(`_hasTagNow('c1','tag_saturday')`)).toBe(true);

  await row(page, 'i2').locator('.ca-inv-ban').click();
  await expect(page.locator('#confirm-modal')).toContainText('Blacklist Omar Hadi?');
  await page.locator('#confirm-modal .btn-red').click();
  await expect.poll(() => tagRows.length).toBe(2);
  expect(tagRows[1]).toMatchObject({ customer_id: 'c2', tag_id: 'tag_blacklist', added_by: 'staff' });
  await expect.poll(() => dels.some((u) => /customer_id=eq\.c2/.test(u) && /tag_id=eq\.tag_saturday/.test(u))).toBe(true);
  await expect(row(page, 'i2').locator('.ca-inv-out[data-out="ban"]')).toContainText('Blacklisted');
  await expect(row(page, 'i2').locator('.ca-inv-ban, .ca-inv-comm')).toHaveCount(0);
  expect(await page.evaluate(`_isBlacklisted('c2')&&!_hasTagNow('c2','tag_saturday')`)).toBe(true);
});
