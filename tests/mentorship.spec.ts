import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// The mentorship programme (2026-11-13, migration 20261114050000): the Community tab's card and page (member-hub.js),
// the two registrations (mentee and mentor), offers on the anonymous profiles, the student's answer, the match's
// WhatsApp and check, and People > Mentorship on the staff side.

const sess = (id: string, date: string) => ({ id, day: 'Saturday', session_date: date, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' });
const sessions = [sess('2099-01-03', '2099-01-03')];
const feed = { ok: true, today: '2026-11-13', me: null, club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null };
const prof = (num: number, o: Record<string, unknown> = {}) => ({ num, university: 'IE University', field: 'Business Administration', city: 'Madrid', country: 'ES', class_year: 2026, helps: ['cv', 'unilife'], goal: null, offered: null, ...o });
const mt = (o: Record<string, unknown> = {}) => ({ ok: true, ask: null, mentor: null, profiles: [prof(3), prof(7, { university: 'Concordia University', field: 'Industrial Engineering', city: 'Montreal', country: 'CA' })], offers: [], ...o });
const mentorReg = { university: 'KAU', field: 'Marketing', work: 'Advertising', places: 'Jeddah', helps: ['cv'], about: 'I work in advertising.' };

const rpcSent = (page: Page) => {
  const out: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rpc\/(\w+)/); if (m) { let b = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ } out.push({ fn: m[1]!, body: b }); } });
  return out;
};
// mentor_feed answers whatever the test holds now, so a write can change what the next read sees.
async function member(page: Page, first: Record<string, unknown> | null, fx: Fixtures = {}) {
  const state = { mt: first as Record<string, unknown> | null };
  await stubSupabase(page, { sessions, customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed, 'rpc:mentor_join': { ok: true }, 'rpc:mentor_offer': { ok: true }, 'rpc:mentor_ask': { ok: true }, 'rpc:mentor_answer': { ok: true }, 'rpc:mentor_check': { ok: true }, 'rpc:mentor_leave': { ok: true }, ...fx });
  await page.route('**/rest/v1/rpc/mentor_feed*', (route) => state.mt
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.mt) })
    : route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.mentor_feed' }) }));
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'female' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  return state;
}

test.describe('@customer:members mentorship', () => {
  test('the card: how many students look for a mentor, and both registrations', async ({ page }) => {
    await member(page, mt());
    const card = page.locator('#hub-body .mt-card');
    await expect(card).toContainText('Students looking for a mentor: 2');
    await expect(card.getByRole('button', { name: 'Register as a mentor' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'See the students' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Register as a mentee' })).toBeVisible();
    const bad = await page.evaluate(`Object.entries(HUB_T).filter(([k,v])=>v.length!==10||v.some(x=>!String(x).trim())).map(([k])=>k)`);
    expect(bad).toEqual([]);
  });

  test('a database without the programme shows no card', async ({ page }) => {
    await member(page, null);
    await expect(page.locator('#hub-body .hub-card').first()).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.locator('#hub-body .mt-card')).toHaveCount(0);
  });

  test('the list names nobody; I can help asks for the mentor registration first, then the offer', async ({ page }) => {
    const sent = rpcSent(page);
    const state = await member(page, mt());
    await page.locator('.mt-card').getByRole('button', { name: 'See the students' }).click();
    const cards = page.locator('#hub-body .mt-prof');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('Profile 3');
    await expect(cards.first()).toContainText('IE University');
    await expect(cards.first()).toContainText('Madrid, Spain');
    await expect(page.locator('#hub-body')).not.toContainText('Lina');
    await cards.nth(1).getByRole('button', { name: 'I can help' }).click();
    const dlg = page.getByRole('dialog', { name: 'Register as a mentor' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Send' }).click();
    await expect(dlg.locator('.pg-msg').first()).toBeVisible(); // nothing filled: each field says so
    await dlg.getByLabel('Where you studied').fill('KAU');
    await dlg.getByLabel('What you studied').fill('Marketing');
    await dlg.getByLabel('Your work or industry').fill('Advertising');
    await dlg.getByRole('button', { name: 'CV review' }).click();
    await dlg.getByLabel('How your experience could help students').fill('I work in advertising.');
    await dlg.getByRole('checkbox').check();
    state.mt = mt({ mentor: mentorReg });
    await dlg.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => sent.find((x) => x.fn === 'mentor_join')?.body).toMatchObject({ p_university: 'KAU', p_field: 'Marketing', p_work: 'Advertising', p_helps: ['cv'], p_about: 'I work in advertising.', p_ok: true });
    const offer = page.getByRole('dialog', { name: 'Profile 7' });
    await expect(offer).toBeVisible();
    await expect(offer.getByRole('button', { name: 'CV review' })).toHaveAttribute('aria-pressed', 'true'); // the registration's help, picked already
    await offer.getByRole('button', { name: 'Same university' }).click();
    await offer.getByLabel('How could your experience help?').fill('I can review your CV.');
    await offer.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => sent.find((x) => x.fn === 'mentor_offer')?.body).toMatchObject({ p_num: 7, p_links: ['uni'], p_helps: ['cv'], p_note: 'I can review your CV.' });
  });

  test('a mentee registers with the country list and the gender they prefer', async ({ page }) => {
    const sent = rpcSent(page);
    await member(page, mt());
    await page.locator('.mt-card').getByRole('button', { name: 'Register as a mentee' }).click();
    const dlg = page.getByRole('dialog', { name: 'Register as a mentee' });
    await dlg.getByLabel('University', { exact: true }).fill('University of Reading');
    await dlg.getByLabel('Field of study').fill('Architectural Engineering');
    await dlg.getByLabel('City').fill('Reading');
    await dlg.getByLabel('Country').selectOption('GB');
    await expect(dlg.getByLabel('Country').locator('option[value="IL"]')).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Summer internships' }).click();
    await dlg.getByLabel('Mentor you prefer').selectOption('female');
    await dlg.getByRole('checkbox').check();
    await dlg.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => sent.find((x) => x.fn === 'mentor_ask')?.body).toMatchObject({ p_university: 'University of Reading', p_field: 'Architectural Engineering', p_city: 'Reading', p_country: 'GB', p_helps: ['internship'], p_gender_pref: 'female', p_ok: true });
  });

  test('the student accepts an offer; a match gives WhatsApp and the check', async ({ page }) => {
    const sent = rpcSent(page);
    const ask = { num: 9, status: 'open', university: 'King Abdulaziz University', field: 'Marketing', city: 'Jeddah', country: 'SA', class_year: 2026, helps: ['cv'], goal: null, gender_pref: 'any',
      proposed: [{ id: 'mo_1', links: ['uni', 'industry'], helps: ['cv'], summary: 'KAU Marketing graduate, works in advertising' }], matches: [] };
    const state = await member(page, mt({ ask }));
    await expect(page.locator('.mt-card .mt-alert')).toContainText('A member offered to help you');
    await page.locator('.mt-card').getByRole('button', { name: 'See the students' }).click();
    await expect(page.locator('.mt-ask .mt-sub')).toContainText('KAU Marketing graduate, works in advertising');
    state.mt = mt({ ask: { ...ask, status: 'matched', proposed: [], matches: [{ id: 'mo_1', name: 'Sara', wa: '966501234567', at: '2026-10-01T00:00:00Z', links: ['uni'], helps: ['cv'], summary: null, due: true }] } });
    await page.locator('.mt-ask').getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => sent.find((x) => x.fn === 'mentor_answer')?.body).toMatchObject({ p_offer: 'mo_1', p_yes: true });
    const match = page.locator('.mt-match');
    await expect(match).toContainText('Your mentor');
    await expect(match).toContainText('Sara');
    await expect(match.getByRole('link', { name: /WhatsApp/ })).toHaveAttribute('href', 'https://wa.me/966501234567');
    await match.getByRole('button', { name: 'Yes' }).click();
    await expect.poll(() => sent.find((x) => x.fn === 'mentor_check')?.body).toMatchObject({ p_offer: 'mo_1', p_answer: 'yes' });
  });

  test('a mentor sees their offers and can leave the programme', async ({ page }) => {
    const sent = rpcSent(page);
    await member(page, mt({ mentor: mentorReg, offers: [{ id: 'mo_2', num: 3, university: 'IE University', field: 'BBA', city: 'Madrid', country: 'ES', class_year: 2026, status: 'offered', name: null, wa: null, at: null, due: false }] }), { 'rpc:mentor_quit': { ok: true } });
    await page.locator('.mt-card').getByRole('button', { name: 'See the students' }).click();
    await expect(page.locator('.mt-list')).toContainText('Offer sent');
    await expect(page.locator('.mt-me')).toContainText('KAU');
    await page.locator('.mt-me').getByRole('button', { name: 'Leave the programme' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave the programme' }).click();
    await expect.poll(() => sent.some((x) => x.fn === 'mentor_quit')).toBe(true);
  });
});

// ── Staff ──────────────────────────────────────────────────────────────────────────────────────────
const customers = [
  { id: 'c1', name: 'Lina Haddad', phone: '+966501111111', gender: 'female', created_at: 1 },
  { id: 'c2', name: 'Omar Saleh', phone: '+966502222222', gender: 'male', created_at: 1 },
  { id: 'c3', name: 'Sara Ali', phone: '+966503333333', gender: 'female', created_at: 1 },
];
const profiles = [
  { id: 'mp_1', num: null, customer_id: 'c1', university: 'University of Reading', field: 'Architectural Engineering', city: 'Reading', country: 'GB', class_year: 2026, helps: ['cv'], goal: 'Work in design', gender_pref: 'female', status: 'pending', source: 'self', staff_note: null, created_at: '2026-11-12T10:00:00Z' },
  { id: 'mp_2', num: 3, customer_id: 'c2', university: 'IE University', field: 'BBA', city: 'Madrid', country: 'ES', class_year: 2026, helps: ['unilife'], goal: null, gender_pref: 'female', status: 'open', source: 'staff', staff_note: null, created_at: '2026-11-10T10:00:00Z' },
];
const offers = [{ id: 'mo_1', profile_id: 'mp_2', mentor_id: 'c3', links: ['uni'], helps: ['unilife'], note: 'I studied at IE.', summary: null, status: 'offered', ended_by: null, created_at: '2026-11-11T10:00:00Z', matched_at: null }];
const mentors = [{ customer_id: 'c3', university: 'IE University', field: 'BBA', work: 'Banking', places: 'Madrid', helps: ['unilife'], about: 'Happy to help.', status: 'active', created_at: '2026-11-11T09:00:00Z' }];
async function staff(page: Page) {
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], staff_options: [],
    tags: [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: 'green', locked: true }],
    customer_tags: [{ customer_id: 'c1', tag_id: 'tag_saturday', added_at: 1 }, { customer_id: 'c2', tag_id: 'tag_saturday', added_at: 1 }, { customer_id: 'c3', tag_id: 'tag_saturday', added_at: 1 }],
    mentor_profiles: profiles, mentor_offers: offers, mentor_checks: [], mentor_mentors: mentors });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='mentors';renderCommunity()`);
  await expect(page.locator('#tab-community .mts-card').first()).toBeVisible();
}
const writes = (page: Page, table: string) => {
  const out: { method: string; url: string; body: unknown }[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/' + table)) out.push({ method: r.method(), url: r.url(), body: r.postDataJSON() }); });
  return out;
};

test.describe('@staff:community mentorship', () => {
  test('a request is published from its own address, with the student and their preference', async ({ page }) => {
    const w = writes(page, 'mentor_profiles');
    await staff(page);
    await expect(page).toHaveURL(/\/people\/mentorship/);
    const card = page.locator('.mts-card').first();
    await expect(card).toContainText('Request');
    await expect(card).toContainText('Lina Haddad');
    await expect(card).toContainText('Prefers a woman mentor');
    await card.getByRole('button', { name: 'Publish' }).click();
    await expect.poll(() => w.find((x) => x.method === 'PATCH')?.body).toMatchObject({ status: 'open' });
  });

  test('an offer is proposed with the line the student sees; the gender the student asked for is checked', async ({ page }) => {
    const w = writes(page, 'mentor_offers');
    await staff(page);
    await page.locator('#tab-community .filter-pill', { hasText: /^Open/ }).click();
    const card = page.locator('.mts-card', { hasText: 'Profile 3' });
    await expect(card.locator('.mts-offer')).toContainText('Sara Ali');
    await expect(card.locator('.mts-offer .mts-warn')).toHaveCount(0); // Sara is a woman, as asked
    await card.getByRole('button', { name: 'Propose' }).click();
    const dlg = page.getByRole('dialog', { name: 'Propose to the student' });
    await dlg.getByLabel('Line the student sees').fill('Studied at IE, works in banking');
    await dlg.getByRole('button', { name: 'Propose' }).click();
    await expect.poll(() => w.find((x) => x.method === 'PATCH')?.body).toMatchObject({ status: 'proposed', summary: 'Studied at IE, works in banking' });
  });

  test('Mentors lists who registered; a profile is added for a student account', async ({ page }) => {
    const w = writes(page, 'mentor_profiles');
    await staff(page);
    await page.locator('#tab-community .filter-pill', { hasText: /^Mentors \(/ }).click();
    await expect(page.locator('.mts-card')).toContainText('Sara Ali');
    await expect(page.locator('.mts-card')).toContainText('Banking');
    await page.getByRole('button', { name: '+ Add a profile' }).click();
    const dlg = page.getByRole('dialog', { name: "Add a student's profile" });
    await dlg.getByRole('searchbox', { name: 'Student' }).fill('Omar');
    await dlg.locator('.mts-hit', { hasText: 'Omar Saleh' }).click();
    await dlg.getByLabel('University').fill('Penn State');
    await dlg.getByLabel('Field of study').fill('Economics');
    await dlg.getByLabel('City').fill('Pennsylvania');
    await dlg.getByLabel('Country').selectOption('US');
    await dlg.getByRole('button', { name: 'First job' }).click();
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg.locator('.mts-err')).toContainText("Tick the student's agreement.");
    await dlg.getByLabel(/The student agreed/).check();
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => w.find((x) => x.method === 'POST')?.body).toMatchObject({ customer_id: 'c2', university: 'Penn State', country: 'US', helps: ['job'], source: 'staff', status: 'open' });
  });
});
