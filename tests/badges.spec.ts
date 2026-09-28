import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Badges staff give (2026-09-29). Staff give a rider a badge from their row in Accounts (with a note
// the rider reads) or to everyone who rode a ride from Community > Badges, and take one back on a
// second tap. Admins make badges from the app's drawn icons and eight colours: no badge is an emoji
// (the owner). The rider sees the badges staff gave first on their account page, and a new one
// pops up once. All Supabase traffic is stubbed.

const EMOJI = /\p{Extended_Pictographic}/u;
const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const P1 = day(-3), OLD = day(-60);
const slots = JSON.stringify({ _time: '21:00 - 23:00', _total: 40 });
const sessions = [
  { id: P1, day: 'Friday', session_date: P1, capacity: 40, status: 'closed', created_at: 0, bike_slots: slots },
  { id: OLD, day: 'Monday', session_date: OLD, capacity: 40, status: 'closed', created_at: 1, bike_slots: slots },
];
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', gender: 'female', created_at: '2026-06-10T09:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', gender: 'male', created_at: '2026-06-11T09:00:00Z' },
  { id: 'c3', name: 'Sara Nabil', email: 'sara.nabil@gmail.com', phone: '+966551876217', gender: 'female', created_at: '2026-06-12T09:00:00Z' },
];
const row = (id: string, session: string, qn: number, name: string, customer_id: string | null, status: string, paid = false) => ({
  id, session_id: session, session_day: 'Friday', session_date: session, queue_num: qn, name, phone: '0551112222',
  customer_id, status, paid, type_preference: 'Road', price: 115, walk_in: !customer_id, registered_at: '2026-09-01T10:00:00Z',
});
const queue_entries = [
  row('q1', P1, 2, 'Lina Haddad', 'c1', 'done', true),
  row('q2', P1, 3, 'Omar Saleh', 'c2', 'done', true),
  row('q3', P1, 4, 'Sara Nabil', 'c3', 'noshow'),
  row('q4', P1, 5, 'Walk Person', null, 'done', true),
  row('q5', OLD, 2, 'Sara Nabil', 'c3', 'done', true), // outside the 30 days
];
const badges = [
  { id: 'bd_first_lap', slug: 'first_lap', icon: 'flag', color: 'green', name: 'First Lap', description: 'Completed your first circuit ride', system: true, auto: true, retired: false, sort: 100 },
  { id: 'bd_marshal', slug: 'marshal', icon: 'shield', color: 'orange', name: 'Marshal', description: 'Led or swept a group ride', system: true, auto: false, retired: false, sort: 10 },
  { id: 'bd_champion', slug: 'champion', icon: 'trophy', color: 'gold', name: 'Champion', description: 'Won a challenge', system: true, auto: false, retired: false, sort: 60 },
  { id: 'bd_cnight', slug: 'bd_cnight', icon: 'moon', color: 'purple', name: 'Night Owl', name_ar: 'بومة الليل', description: 'Rode a late ride', system: false, auto: false, retired: false, sort: 500 },
];
const customer_badges = [
  { customer_id: 'c2', badge_id: 'bd_champion', note: 'Won the sprint', session_id: null, awarded_by: 'Malik', awarded_at: '2026-09-20T18:00:00Z' },
];

async function staff(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions, customers, queue_entries, bikes: [], tags: [], customer_tags: [], staff_options: [], badges, customer_badges, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffRole='admin'`);
}
const community = async (page: Page, tab: string) => {
  await page.evaluate(`setStaffTab('community');S.communityTab='${tab}';renderCommunity()`);
  await page.waitForFunction('S._bdgAt>0&&!S._bdgBusy');
};
const writes = (page: Page, table: string) => {
  const out: Request[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.endsWith('/rest/v1/' + table)) out.push(r); });
  return out;
};
const modal = (page: Page) => page.locator('#confirm-modal .bdg-dlg');

test.describe('@staff:community badges', () => {
  test('a rider\'s Badges dialog gives a badge with a note, and takes one back on the second tap', async ({ page }) => {
    await staff(page);
    await community(page, 'accounts');
    const sent = writes(page, 'customer_badges');
    const lina = page.locator('#am-cust-rows .am-row[data-cust="c1"]');
    await lina.locator('.am-bdg-btn').click();
    await expect(modal(page)).toContainText('Badges · Lina Haddad');
    // First Lap is hers by riding: listed as held, not offered.
    await expect(modal(page).locator('.bdg-list')).toContainText('First Lap');
    await expect(modal(page).locator('.bdg-list')).toContainText('Earned by riding');
    await expect(modal(page).locator('.bdg-pick')).toHaveText(['Marshal', 'Champion', 'Night Owl']);
    await expect(modal(page).locator('.bdg-pick svg.bdg-m')).toHaveCount(3);

    await modal(page).locator('.bdg-pick', { hasText: 'Marshal' }).click();
    await expect(modal(page).locator('.bdg-pick.on')).toHaveText('Marshal');
    await modal(page).locator('#bdg-note').fill('Swept the Friday ride');
    await modal(page).getByRole('button', { name: 'Give badge' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].postDataJSON()).toMatchObject({ customer_id: 'c1', badge_id: 'bd_marshal', note: 'Swept the Friday ride', awarded_by: 'Spec Staff' });
    await expect(modal(page).locator('.bdg-list')).toContainText('Swept the Friday ride');
    await expect(modal(page).locator('.bdg-pick', { hasText: 'Marshal' })).toHaveCount(0);
    await expect(lina.locator('.am-bdg svg.bdg-m')).toHaveCount(1); // the row shows it too
    expect(await page.evaluate('(S.undoStack.at(-1)||{}).label')).toBe('Badge given: Marshal to Lina Haddad');

    // Take back asks once more on the same button; only the second tap writes.
    const take = modal(page).locator('.bdg-item', { hasText: 'Marshal' }).getByRole('button');
    await take.click();
    await expect(modal(page).locator('.bdg-item', { hasText: 'Marshal' }).locator('.btn-red')).toHaveText('Take it back?');
    expect(sent.length).toBe(1);
    await modal(page).locator('.bdg-item', { hasText: 'Marshal' }).locator('.btn-red').click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].method()).toBe('DELETE');
    expect(sent[1].url()).toContain('customer_id=eq.c1');
    expect(sent[1].url()).toContain('badge_id=eq.bd_marshal');
    await expect(modal(page).locator('.bdg-pick', { hasText: 'Marshal' })).toHaveCount(1);
    expect(EMOJI.test(await modal(page).innerText())).toBe(false);
  });

  test('Community > Badges lists holders, gives to everyone who rode a ride, and an admin\'s new badge is drawn', async ({ page }) => {
    await staff(page);
    await community(page, 'badges');
    const tab = page.locator('#tab-community');
    await expect(tab.locator('.bdg-row')).toHaveCount(4);
    const champ = tab.locator('.bdg-row[data-badge="bd_champion"]');
    await expect(champ).toContainText('1 holders');
    await champ.getByRole('button', { name: 'Holders' }).click();
    await expect(champ.locator('.bdg-hold')).toContainText('Omar Saleh');
    await expect(champ.locator('.bdg-hold')).toContainText('Won the sprint');

    // Give to a ride: the accounts checked in on it (done), not the no-show, not a walk-in.
    const sent = writes(page, 'customer_badges');
    const marshal = tab.locator('.bdg-row[data-badge="bd_marshal"]');
    await marshal.getByRole('button', { name: 'Give to a ride' }).click();
    await expect(marshal.locator('#bdg-ride option')).toHaveCount(1); // the old ride is past the 30 days
    await marshal.locator('#bdg-rnote').fill('National Day ride');
    await marshal.getByRole('button', { name: 'Give to 2 riders' }).click();
    await expect.poll(() => sent.length).toBe(1);
    const rows = sent[0].postDataJSON() as Record<string, unknown>[];
    expect(rows.map((r) => r.customer_id).sort()).toEqual(['c1', 'c2']);
    expect(rows.every((r) => r.session_id === P1 && r.badge_id === 'bd_marshal' && r.note === 'National Day ride')).toBe(true);
    expect(sent[0].headers()['prefer']).toContain('resolution=ignore-duplicates');
    await expect(marshal).toContainText('2 holders');

    // Champion: Omar holds it already, so only Lina is left to give it to.
    await champ.getByRole('button', { name: 'Give to a ride' }).click();
    await expect(champ.getByRole('button', { name: 'Give to 1 riders' })).toBeVisible();

    // A new badge: an icon from the set and a colour, never an emoji.
    const made = writes(page, 'badges');
    await tab.getByRole('button', { name: '+ New badge' }).click();
    const form = tab.locator('.bdg-form');
    await form.locator('.bdg-ico[aria-label="bolt"]').click();
    await form.locator('.bdg-sw[aria-label="teal"]').click();
    await form.locator('#bdg-f-name').fill('Night Rider');
    await form.locator('#bdg-f-name_ar').fill('راكب الليل');
    await expect(form.locator('.bdg-preview svg.bdg-m.bdc-teal')).toHaveCount(1);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => made.length).toBe(1);
    expect(made[0].postDataJSON()).toMatchObject({ icon: 'bolt', color: 'teal', name: 'Night Rider', name_ar: 'راكب الليل' });
    expect(String((made[0].postDataJSON() as Record<string, unknown>).slug)).toMatch(/^bd_c[a-z0-9]+$/);
    await expect(tab.locator('.bdg-row')).toHaveCount(5);
    expect(EMOJI.test(await tab.innerText())).toBe(false);

    // Front desk give and take back, but do not make or edit badges.
    await page.evaluate(`S.staffRole='frontdesk';renderCommunity()`);
    await expect(tab.getByRole('button', { name: '+ New badge' })).toHaveCount(0);
    await expect(tab.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(tab.getByRole('button', { name: 'Give to a ride' }).first()).toBeVisible();
  });

  test('a database without the badges tables: no Badges button, and the tab says why', async ({ page }) => {
    await staff(page, { badges: [], customer_badges: [] });
    await community(page, 'accounts');
    await expect(page.locator('#am-cust-rows .am-row[data-cust="c1"]')).toBeVisible();
    await expect(page.locator('#am-cust-rows .am-bdg-btn')).toHaveCount(0);
    await page.evaluate(`S.communityTab='badges';renderCommunity()`);
    await expect(page.locator('#tab-community')).toContainText('Badges are not set up on the database yet.');
  });
});

test.describe('@customer:account badges', () => {
  const mine = [
    { slug: 'bd_cnight', icon: 'moon', color: 'purple', name: 'Night Owl', name_ar: 'بومة الليل', description: 'Rode a late ride', system: false, note: null, at: '2026-09-01T10:00:00Z' },
    { slug: 'marshal', icon: 'shield', color: 'orange', name: 'Marshal', system: true, note: 'Thanks for sweeping', at: new Date(Date.now() - 36e5).toISOString() },
  ];
  async function rider(page: Page, fx: Fixtures) {
    await stubSupabase(page, { sessions, queue_entries: [row('q1', P1, 2, 'Spec Rider', 'c1', 'done', true)], ...fx });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
  }

  test('the badges staff gave come first, drawn, and the newest pops up once', async ({ page }) => {
    await rider(page, { 'rpc:customer_my_badges': mine });
    const pop = page.locator('#badge-pop');
    await expect(pop).toContainText('New badge!');
    await expect(pop).toContainText('Marshal');
    await expect(pop).toContainText('Thanks for sweeping');
    await expect(pop).toContainText('Given by the MicroMobility team');
    await expect(pop.locator('svg.bdg-m.bdc-orange')).toHaveCount(1);
    await pop.getByRole('button', { name: 'Close' }).click();

    const chips = page.locator('#tab-account .mr-badges .mr-badge');
    await expect(chips).toHaveCount(11); // the two given, then the nine ride badges
    await expect(chips.nth(0)).toContainText('Night Owl');
    await expect(chips.nth(1)).toContainText('Marshal');
    await expect(chips.nth(2)).toContainText('First Lap');
    await expect(chips.nth(2)).not.toHaveClass(/locked/); // a done, paid ride
    await expect(page.locator('#tab-account .mr-badges svg.bdg-m')).toHaveCount(11);
    expect(EMOJI.test(await page.locator('#tab-account .mr-badges').innerText())).toBe(false);

    // Seen on this device: asked again, it does not pop up a second time.
    await page.evaluate(`S._bdgMine.at=0;renderAccount()`);
    await page.waitForFunction('S._bdgMine&&!S._bdgMine.busy');
    await page.waitForTimeout(200);
    await expect(pop).toHaveCount(0);

    // A badge an admin made reads its Arabic name in Arabic, its English one elsewhere.
    expect(await page.evaluate(`(()=>{const b=S._bdgMine.list[0],en=_bdgName(b);S.lang='ar';const ar=_bdgName(b);S.lang='en';return[en,ar];})()`)).toEqual(['Night Owl', 'بومة الليل']);
  });

  test('a database without customer_my_badges still shows the ride badges', async ({ page }) => {
    await rider(page, { 'rpc:customer_my_badges': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_my_badges' } } });
    await page.waitForFunction('S._bdgMine&&!S._bdgMine.busy');
    await expect(page.locator('#tab-account .mr-badges .mr-badge')).toHaveCount(9);
    await expect(page.locator('#badge-pop')).toHaveCount(0);
    await page.locator('#tab-account .mr-badge').first().click();
    await expect(page.locator('#badge-pop')).toContainText('First Lap');
    await expect(page.locator('#badge-pop')).toContainText('Earned');
  });
});
