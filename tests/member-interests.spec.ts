import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// My interests (2026-11-18, migration 20261118210300; the user: "the member picks what they want, such as Road rides,
// night rides, Petromin nights, women's sessions or learning. Coming up and Updates then show those first, and staff can
// aim an Ask page or an update at one interest. It can reuse the sport answer every account already has."). The rider's
// card in the Community tab (member-hub.js), Ask's audience by interest, Community > Activities > Send an update and the
// account window's chips. All Supabase traffic is stubbed: who sees what and who an update reaches are the database's rules.

type Row = Record<string, unknown>;
const ALL = ['saturday', 'circuit', 'road', 'petromin', 'women', 'learn', 'runs', 'races', 'swim', 'yoga', 'farm', 'charity'];
const OFFERED_M = ALL.filter((k) => k !== 'women');
const sess = (id: string, date: string, o: Row = {}) => ({ id, day: 'Saturday', session_date: date, capacity: 40, status: 'open', created_at: 1, event_kind: 'community',
  ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}', ...o });
const sessions = [sess('2099-01-03', '2099-01-03'), sess('2099-01-10', '2099-01-10'), sess('2099-01-17', '2099-01-17'),
  sess('2099-01-20-yg', '2099-01-20', { ride_kind: 'yoga', day: 'Tuesday' }), sess('2099-01-22-fh', '2099-01-22', { ride_kind: 'farm', day: 'Thursday' })];
const feed = () => ({
  ok: true, today: '2026-11-18',
  me: { kind: 'level', levels: [1, 2, 3], target: 2, chosen: false, n: 1, ends_on: '2026-11-30', sats: 4 },
  club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null,
});
const got = (o: Row = {}) => ({ ok: true, saved: false, keys: [], suggested: [], offered: OFFERED_M, ...o });
async function member(page: Page, fx: Fixtures = {}, gender = 'male') {
  await stubSupabase(page, { sessions, customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed(), ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Rana Example', gender });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
}
/** The arguments each call of a database function was made with, in order. */
function calls(page: Page, fn: string) {
  const out: Row[] = [];
  page.on('request', (r: Request) => {
    if (!new URL(r.url()).pathname.endsWith('/rpc/' + fn) || r.method() !== 'POST') return;
    try { out.push((r.postDataJSON() || {}) as Row); } catch { out.push({}); }
  });
  return out;
}

test.describe('@customer:members My interests in the Community tab', () => {
  test('a first-time member: the card right after the next session, ticked from the sport answer; Save keeps the picks, the card moves to the end and Coming up leads with them', async ({ page }) => {
    const sent = calls(page, 'member_interests_set');
    await member(page, { 'rpc:member_interests_get': got({ suggested: ['saturday', 'road'] }), 'rpc:member_interests_set': { ok: true, keys: ['farm'] } });
    const card = page.locator('#hub-body .int-card');
    await expect(card).toBeVisible();
    await expect(page.locator('#hub-pane-sess > .hub-hero + .int-card')).toHaveCount(1);
    await expect(card.locator('.hub-k')).toHaveText('Your interests');
    await expect(card.locator('.int-chip')).toHaveCount(11); // Women's sessions: only for an account the database offers it to
    await expect(card).not.toContainText('Women');
    await expect(card.getByRole('group', { name: 'Your interests' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Saturday Social Rides' })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('button', { name: 'Road bike rides' })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-pressed', 'false');
    await expect(card.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    // nothing is kept until Save: suggestions order nothing, Coming up stays in date order, unmarked
    const soon = page.locator('#hub-body .hub-soon');
    await expect(soon).toHaveCount(3);
    await expect(page.locator('#hub-body .hub-soon.int-on')).toHaveCount(0);
    await expect(soon.nth(2)).toContainText('Hatha Yoga for Cyclists');
    expect(sent).toHaveLength(0);
    await card.getByRole('button', { name: 'Saturday Social Rides' }).click();
    await card.getByRole('button', { name: 'Road bike rides' }).click();
    await card.getByRole('button', { name: 'Farm House Nights' }).click();
    await expect(card.getByRole('button', { name: 'Farm House Nights' })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('button', { name: 'Farm House Nights' })).toBeFocused(); // flipped in place, not drawn again
    await expect(card.getByRole('button', { name: 'Saturday Social Rides' })).toHaveAttribute('aria-pressed', 'false');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_id: 'c1', p_keys: ['farm'] });
    // saved: no longer after the hero; near the end with the picks and Change, and no toast
    await expect(page.locator('#hub-pane-sess > .hub-hero + .int-card')).toHaveCount(0);
    await expect(card.locator('.mt-chips li')).toHaveText(['Farm House Nights']);
    await expect(page.locator('#int-change')).toHaveText('Change');
    await expect(page.locator('#int-change')).toBeFocused();
    await expect(page.locator('.toast')).toHaveCount(0);
    // Coming up: the Farm House Night first, marked; then the Saturdays by date; the yoga session drops out of the three
    await expect(soon).toHaveCount(3);
    await expect(soon.nth(0)).toContainText('Farm House Night');
    await expect(soon.nth(0)).toHaveClass(/\bint-on\b/);
    await expect(page.locator('#hub-body .hub-soon.int-on')).toHaveCount(1);
    await expect(soon.nth(1)).toContainText('Saturday Social Ride');
    await expect(page.locator('#hub-body')).not.toContainText('Hatha Yoga for Cyclists');
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
  });

  test('a saved member: Change opens the chips with Cancel; a refusal is said in words and the picks stay open; Women\'s sessions for a female account', async ({ page }) => {
    const sent = calls(page, 'member_interests_set');
    await member(page, { 'rpc:member_interests_get': got({ saved: true, keys: ['women', 'swim'], offered: ALL }), 'rpc:member_interests_set': { ok: false, error: 'limit' } }, 'female');
    const card = page.locator('#hub-body .int-card');
    await expect(card.locator('.mt-chips li')).toHaveText(['Women’s sessions', 'Swimming']);
    await expect(page.locator('#hub-pane-sess > .hub-hero + .int-card')).toHaveCount(0);
    await expect(card.locator('.int-chip')).toHaveCount(0);
    await page.locator('#int-change').click();
    await expect(card.locator('.int-chip')).toHaveCount(12);
    await expect(card.getByRole('button', { name: 'Women’s sessions' })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.locator('.int-chip').first()).toBeFocused();
    await card.getByRole('button', { name: 'Yoga' }).click();
    await card.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_keys: ['women', 'swim', 'yoga'] }); // the list's order
    await expect(page.locator('.toast.error').last()).toHaveText('Too many changes. Please try again in an hour.');
    await expect(card.getByRole('button', { name: 'Yoga' })).toHaveAttribute('aria-pressed', 'true');
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(card.locator('.int-chip')).toHaveCount(0);
    await expect(card.locator('.mt-chips li')).toHaveText(['Women’s sessions', 'Swimming']);
    await expect(page.locator('#int-change')).toBeFocused();
  });

  test('a database without My interests, or no answer, shows no card and changes nothing in Coming up', async ({ page }) => {
    await member(page, { 'rpc:member_interests_get': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.member_interests_get' } } });
    await page.waitForFunction('!!S._int&&S._int.off===true');
    await expect(page.locator('#hub-body .int-card')).toHaveCount(0);
    await expect(page.locator('#hub-body .hub-soon')).toHaveCount(3);
    await expect(page.locator('#hub-body .hub-soon.int-on')).toHaveCount(0);
  });
});

// ── staff ─────────────────────────────────────────────────────────────────────────────────────────
const tags = [{ id: 'tag_saturday', name: 'Community', slug: 'saturday', color: '#0c7a3d', system: true }];
const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const pageRow = (o: Row = {}): Row => ({ id: 1, slug: 'pool-times', code: '482913', title_en: 'Which pool times suit you?', title_ar: '', intro_en: '', intro_ar: '',
  audience: 'link', tag_ids: [], interest_keys: [], status: 'draft', opens_at: null, closes_at: null, after_close: 'results', pace: 'self', current_q: null, listed: true,
  round: 1, notes: '', look: {}, ver: 3, created_at: ago(300), created_by: 'Desk One', updated_at: ago(30), updated_by: 'Desk One', open: false, questions: 0,
  answers: 0, people: 0, pending: 0, ...o });

test.describe('@staff:ask Ask: members by interest', () => {
  test('a page for members by interest: its chips, at least one, written as interest_keys; another audience writes none; the list names them', async ({ page }) => {
    test.setTimeout(90_000);
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [], tags, customer_tags: [], staff_options: [],
      'rpc:staff_ask_pages': [pageRow(), pageRow({ id: 2, slug: 'run-club', title_en: 'Run club times', audience: 'interests', interest_keys: ['runs', 'swim'] })],
      'rpc:staff_ask_page': { page: { ...pageRow(), screen_key: 'sk_1' }, questions: [], board: [] }, 'rpc:staff_ask_pending': 0 });
    await unlockStaff(page);
    await page.goto('/ask');
    await waitForSb(page);
    await page.waitForFunction(`S.view==='staff'&&S.staffTab==='ask'`);
    const sec = page.locator('#tab-ask');
    await expect(sec.locator('.ask-pg[data-ask-pg="2"] .ask-pg-meta')).toContainText('Members by interest: Runs, Swimming');
    const sent: Row[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /\/rest\/v1\/ask_pages$/.test(new URL(r.url()).pathname)) sent.push(r.postDataJSON() as Row); });
    await page.evaluate(`_askOpen(1,'setup')`);
    await sec.locator('.ask-setup').waitFor();
    const who = sec.locator('section[aria-labelledby="ask-g-who"]');
    await who.getByRole('button', { name: 'Members by interest' }).click();
    const ints = who.getByRole('group', { name: 'Interests' });
    await expect(ints.locator('.filter-pill')).toHaveCount(12);
    await expect(ints.locator('.filter-pill').first()).toHaveText('Saturday Social Rides');
    await expect(who.getByRole('group', { name: 'Gender' })).toBeVisible(); // the rules that narrow a page for accounts stay offered
    await sec.locator('.ask-save').click();
    await expect(who.locator('.ask-err')).toHaveText('Pick at least one interest.');
    expect(sent).toHaveLength(0);
    await ints.getByRole('button', { name: 'Swimming' }).click();
    await ints.getByRole('button', { name: 'Runs' }).click();
    await expect(who.locator('.ask-err')).toHaveCount(0);
    await expect(ints.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-pressed', 'true');
    await sec.locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ audience: 'interests', interest_keys: ['runs', 'swim'], tag_ids: [] });
    await who.getByRole('button', { name: 'Signed-in accounts' }).click();
    await expect(who.getByRole('group', { name: 'Interests' })).toHaveCount(0);
    await sec.locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toMatchObject({ audience: 'accounts', interest_keys: [] });
  });
});

const customers = [{ id: 'c1', name: 'Rana Example', email: 'r@example.com', phone: '+966500000101', gender: 'female', created_at: '2026-06-10T00:00:00Z' }];
const counts = { members: 40, saved: 12, keys: { saturday: 9, circuit: 2, road: 4, petromin: 1, women: 3, learn: 0, runs: 3, races: 1, swim: 7, yoga: 2, farm: 5, charity: 0 } };
const sentRows = [{ id: 3, interest: null, body_en: 'Welcome to the new season', body_ar: 'أهلًا بالموسم الجديد', reach: 40, sent_at: '2026-11-17T10:00:00Z', sent_by_name: 'Desk One' }];
async function staffPeople(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], customers, queue_entries: [], bikes: [], staff_options: [], tags, customer_tags: [], titles: [], customer_titles: [],
    'rpc:staff_interest_counts': counts, interest_updates: sentRows, member_interests: [{ customer_id: 'c1', keys: ['runs', 'swim'] }],
    'rpc:staff_updates_interest': { ok: true, id: 4, reach: 7 }, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
}

test.describe('@staff:community Send an update to an interest, and the account window', () => {
  test('Activities > Send an update: who gets it with the numbers, both texts required, a centred confirm with the reach, then staff_updates_interest; five an hour said in words', async ({ page }) => {
    test.setTimeout(90_000);
    const sent = calls(page, 'staff_updates_interest');
    await staffPeople(page);
    await page.evaluate(`S.staffRole='admin';setStaffTab('community');S.communityTab='activities';renderCommunity()`);
    await page.waitForFunction('S._acAt>0&&!S._acBusy&&!!S._ac');
    const sec = page.locator('#tab-community');
    await sec.locator('.filter-pill', { hasText: 'Send an update' }).click();
    const to = sec.getByRole('group', { name: 'Who gets it' });
    await expect(to.locator('.filter-pill')).toHaveCount(13);
    await expect(to.locator('.filter-pill').first()).toHaveText('All members 40');
    await expect(to.getByRole('button', { name: /^All members/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(sec.locator('.ac-upd-row')).toHaveCount(1);
    await expect(sec.locator('.ac-upd-row')).toContainText('All members · 40 members');
    await expect(sec.locator('.ac-upd-row')).toContainText('Welcome to the new season');
    await expect(sec.locator('.ac-upd-row')).toContainText('Desk One');
    // both texts are required: said, nothing sent
    await sec.getByLabel('Text in English').fill('The pool is open on Monday nights.');
    await sec.locator('#ac-upd-go').click();
    await expect(page.locator('.toast.error').last()).toHaveText('Write the text in English and in Arabic.');
    await expect(sec.getByLabel('Text in Arabic')).toBeFocused();
    expect(sent).toHaveLength(0);
    await to.getByRole('button', { name: /^Swimming/ }).click();
    await expect(to.getByRole('button', { name: /^Swimming/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(sec.getByLabel('Text in English')).toHaveValue('The pool is open on Monday nights.'); // kept across the repaint
    await sec.getByLabel('Text in Arabic').fill('المسبح مفتوح مساء الاثنين.');
    await sec.locator('#ac-upd-go').click();
    const box = page.locator('#confirm-modal [role="dialog"]');
    await expect(box).toContainText('Send this update to 7 members? It goes to their Updates list.');
    await box.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ p_interest: 'swim', p_en: 'The pool is open on Monday nights.', p_ar: 'المسبح مفتوح مساء الاثنين.' });
    await expect(sec.getByLabel('Text in English')).toHaveValue('');
    await expect(sec.getByLabel('Text in Arabic')).toHaveValue('');
    // the sixth in an hour: the database refuses it, the page says so and keeps the texts
    await page.route('**/rest/v1/rpc/staff_updates_interest', (r) => r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'P0001', message: 'RATE_LIMIT', details: null, hint: null }) }));
    await sec.getByLabel('Text in English').fill('Another line');
    await sec.getByLabel('Text in Arabic').fill('سطر آخر');
    await sec.locator('#ac-upd-go').click();
    await box.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.toast.error').last()).toHaveText('At most five updates an hour. Try again later.');
    await expect(sec.getByLabel('Text in English')).toHaveValue('Another line');
  });

  test('the account window lists a member\'s interests as chips, read-only', async ({ page }) => {
    await staffPeople(page);
    await page.evaluate(`openAccountHistory('c1')`);
    const det = page.locator('#cust-modal .n6p-det');
    await expect(det.locator('.n6p-int')).toHaveText(['Runs', 'Swimming']);
    await expect(det.locator('.n6p-dr', { hasText: 'Interests' })).toHaveCount(1);
    await expect(det.locator('.n6p-int button, .n6p-int input')).toHaveCount(0);
  });
});
