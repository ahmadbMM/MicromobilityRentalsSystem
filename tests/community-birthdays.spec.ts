import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Community members owe a birth date and a nationality: the server asks for whichever is empty
// (_customer_asks, 20260925170000), the app raises the profile page when the site opens on
// their account, and their bookings wait until both are on file. Staff see every member's
// birthday in Community > Birthdays, soonest first, and wish them on WhatsApp.

// Sunday 4 October 2026, noon in Riyadh.
const NOW = new Date('2026-10-04T09:00:00Z');
const DAY = 86_400_000;

async function pickBirth(page: Page, id: string, iso: string) {
  const [y, m, d] = iso.split('-');
  await page.selectOption(`#${id}-y`, y);
  await page.selectOption(`#${id}-m`, String(+m));
  await page.selectOption(`#${id}-d`, String(+d));
}

test.describe('a community member who has not given both', () => {
  async function rider(page: Page, asks: string[], profile: Record<string, unknown> = {}) {
    await stubSupabase(page, {
      sessions: [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }],
      queue_entries: [], 'rpc:my_bookings': [],
      'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', gender: 'male', nationality: null, birth_date: null, ...profile }],
      'rpc:customer_fix_fields': asks,
      'rpc:customer_fix_save': [],
    });
    await loginCustomer(page, { id: 'c1' });
    await page.goto('/');
    await waitForSb(page);
  }
  function saves(page: Page) {
    const bodies: Record<string, unknown>[] = [];
    page.on('request', r => { if (/rpc\/customer_fix_save/.test(r.url())) bodies.push(JSON.parse(r.postData() || '{}')); });
    return bodies;
  }

  test('meets the profile page as soon as the site opens, and it goes once both are saved', async ({ page }) => {
    const sent = saves(page);
    await rider(page, ['birth_date', 'nationality']);
    const box = page.locator('#profile-gate .pg-box');
    await expect(box).toBeVisible();
    await expect(box).toContainText('Community members');
    await expect(box).toContainText('Two details for your community profile');
    await expect(page.locator('#fix-gate')).toBeHidden();       // not the correction message
    await expect(page.locator('#pg-save')).toBeDisabled();
    await pickBirth(page, 'pg-birth', '1996-03-14');
    await page.selectOption('#pg-nat', 'Egypt');
    await page.click('#pg-save');
    await expect(box).toBeHidden();
    expect(sent).toHaveLength(1);
    expect(sent[0].p_values).toEqual({ birth_date: '1996-03-14', nationality: 'Egypt' });
    expect(await page.evaluate('[S.loggedIn.birth_date,S.loggedIn.nationality,S._fixCache.fields]')).toEqual(['1996-03-14', 'Egypt', []]);
  });

  // The owner, 2026-09-29: no way past it. The header's links, an event pick and Escape leave it
  // up; Log out is the one way off it, and it leaves the account.
  test('the page stays up however the rider moves, and the event stays shut', async ({ page }) => {
    await rider(page, ['nationality'], { birth_date: '1990-05-05' });
    const box = page.locator('#profile-gate .pg-box');
    await expect(box).toBeVisible();
    await page.keyboard.press('Escape');
    for (const go of [`showView('customer')`, `goCustomer('myrides')`, `goCustomer('account')`, `goLanding()`]) {
      await page.evaluate(go);
      await expect(box).toBeVisible();
    }
    expect(await page.evaluate(`document.body.classList.contains('gate-page')`)).toBe(true);
    await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
    await expect(box).toContainText('Two details for your community profile');
    expect(await page.evaluate('S.selEvent')).toBe('none');
    // what the account already holds is filled in; only the missing one is left to answer
    await expect(page.locator('#pg-birth')).toHaveValue('1990-05-05');
    await expect(page.locator('#profile-gate button')).toHaveText(['Save and continue', 'Log out']);
  });

  test('Log out leaves the account and takes the page with it', async ({ page }) => {
    await rider(page, ['birth_date', 'nationality']);
    await expect(page.locator('#profile-gate .pg-box')).toBeVisible();
    await page.click('#profile-gate .gate-out');
    await expect(page.locator('#profile-gate .pg-box')).toHaveCount(0);
    expect(await page.evaluate('[!!S.loggedIn,!!getSession(),!!S._pg]')).toEqual([false, false, false]);
    expect(await page.evaluate(`document.body.classList.contains('gate-page')`)).toBe(false);
  });

  test('nothing asked: the site opens with no page', async ({ page }) => {
    await rider(page, [], { birth_date: '1990-05-05', nationality: 'Jordan' });
    await page.waitForTimeout(400);
    await expect(page.locator('#profile-gate .pg-box')).toHaveCount(0);
  });

  // Every page that asks for details opens at sign-in, not at the event pick (the owner, 2026-09-30):
  // a staff flag on a nationality the account already holds opens as a correction, at once.
  test('a staff flag on a nationality the account already holds opens as a correction when the site opens', async ({ page }) => {
    await rider(page, ['nationality'], { birth_date: '1990-05-05', nationality: 'Jordan' });
    await expect(page.locator('#fix-gate .fx-box')).toBeVisible();
    await expect(page.locator('#fix-gate .pg-title')).toHaveText('Let’s get your details right');
    await expect(page.locator('#profile-gate .pg-box')).toHaveCount(0);
  });
});

test.describe('Community > Birthdays', () => {
  const now = NOW.getTime();
  const customers = [
    { id: 'm1', name: 'Amal Today', phone: '0551112222', birth_date: '1995-10-04', ride_news: true, created_at: '2026-01-01' },
    { id: 'm2', name: 'Badr Tomorrow', phone: '0553334444', birth_date: '2008-10-05', ride_news: false, created_at: '2026-01-02' },
    { id: 'm3', name: 'Dana Leap', phone: '0555556666', birth_date: '2000-02-29', ride_news: true, created_at: '2026-01-03' },
    { id: 'm4', name: 'Faisal Recent', phone: '0557778888', birth_date: '1990-10-01', ride_news: true, created_at: '2026-01-04' },
    { id: 'm5', name: 'Huda Nodate', phone: '0559990000', birth_date: null, created_at: '2026-01-05' },
    { id: 'm6', name: 'Omar Soon', phone: '0551231234', birth_date: '1980-10-20', ride_news: true, created_at: '2026-01-06' },
    { id: 'm7', name: 'Expired Tag', phone: '0551010101', birth_date: '1999-10-04', ride_news: true, created_at: '2026-01-07' },
    { id: 'n1', name: 'Not Member', phone: '0552020202', birth_date: '1999-10-04', ride_news: true, created_at: '2026-01-08' },
  ];
  const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#03ff89' }];
  const member = (id: string, x: Record<string, unknown> = {}) => ({ customer_id: id, tag_id: 'tag_saturday', added_at: 1, ...x });
  const customer_tags = [member('m1'), member('m2'), member('m3'), member('m4'), member('m5'), member('m6'), member('m7', { expires_at: now - DAY })];
  const sessions = [
    { id: '2026-10-10', session_date: '2026-10-10', day: 'Saturday', status: 'open', capacity: 20, created_at: 1 },
    { id: '2026-10-18', session_date: '2026-10-18', day: 'Sunday', status: 'open', capacity: 20, created_at: 2 },
  ];
  const booking = (id: string, sid: string, cust: string, name: string) => ({
    id, session_id: sid, session_day: 'Saturday', session_date: sid, queue_num: 1, name, phone: '', customer_id: cust,
    status: 'waiting', paid: false, price: 57.5, type_preference: 'Hybrid', registered_at: '2026-10-01T10:00:00Z',
  });
  const queue_entries = [booking('b1', '2026-10-10', 'm1', 'Amal Today'), booking('b2', '2026-10-18', 'm6', 'Omar Soon')];

  async function staff(page: Page, x: Record<string, unknown> = {}) {
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, { customers, tags, customer_tags, sessions, queue_entries, staff_options: [], ...x });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('community')`);
  }
  const names = (page: Page) => page.locator('#bd-list .bd-row .bd-name');

  test('lists the members soonest first, with how far off, the age they turn and who rides that week', async ({ page }) => {
    await staff(page);
    const pill = page.locator('#tab-community .filter-pill', { hasText: 'Birthdays' });
    await expect(pill).toHaveText('Birthdays 1');
    await pill.click();
    const tab = page.locator('#tab-community');
    await expect(names(page)).toHaveText(['Amal Today', 'Badr Tomorrow', 'Omar Soon', 'Dana Leap', 'Faisal Recent']); // expired tags and non-members stay out
    const row = (n: string) => page.locator('#bd-list .bd-row', { hasText: n });
    await expect(row('Amal Today')).toContainText('Today');
    await expect(row('Amal Today')).toContainText('Turns 31');
    await expect(row('Badr Tomorrow')).toContainText('Tomorrow');
    await expect(row('Badr Tomorrow').locator('.bd-ms')).toContainText('Milestone');       // eighteen
    await expect(row('Omar Soon')).toContainText('In 16 days');
    await expect(row('Omar Soon').locator('.bd-ride')).toContainText('Birthday week');     // rides on the 18th, birthday the 20th
    await expect(row('Amal Today').locator('.bd-ride')).toHaveCount(0);                   // rides on the 10th
    // A leap-day birthday falls on 28 February when there is no 29th.
    await expect(row('Dana Leap')).toContainText('28 Feb');
    await expect(row('Dana Leap')).toContainText('Turns 27');
    await expect(tab.locator('.bd-missing')).toContainText('Without a birth date: 1.');
    // today's card, and the belated wishes
    await expect(tab.locator('.bd-hero')).toContainText('Amal Today');
    await expect(tab.locator('.bd-late')).toContainText('Faisal Recent');
    await expect(tab.locator('.bd-late')).toContainText('3 days ago');
    await expect(tab.locator('.bd-late')).toContainText('Turned 36');
  });

  test('WhatsApp wishes go only to riders who said yes to ride news, in their words, and count as wished', async ({ page }) => {
    const writes: { items?: { id: string; y: number; by: string }[] }[] = [];
    page.on('request', r => { if (/rest\/v1\/staff_options/.test(r.url()) && r.method() === 'POST') writes.push(JSON.parse(r.postData() || '{}')); });
    await staff(page);
    await page.evaluate(`setCommTab('birthdays')`);
    const amal = page.locator('#bd-list .bd-row', { hasText: 'Amal Today' });
    const wa = amal.locator('a.bd-wa');
    expect(await wa.getAttribute('href')).toBe('https://wa.me/966551112222?text=' + encodeURIComponent('Happy birthday, Amal! Everyone at MicroMobility wishes you a wonderful year ahead, full of great rides. See you on the road!'));
    // a birthday greeting does not wait for ride news (owner, 2026-09-25): Badr said no and still gets the button
    await expect(page.locator('#bd-list .bd-row', { hasText: 'Badr Tomorrow' }).locator('a.bd-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/966553334444\?text=/);
    // only an account with no mobile number has nothing to open
    expect(await page.evaluate(`_bdWishHtml({id:'x',name:'No Phone',phone:''},2026)`)).toContain('bd-wa off" role="img" title="No mobile number on this account."');
    // Arabic, by the staff pick
    await page.locator('.bd-lang select').selectOption('ar');
    expect(decodeURIComponent((await page.locator('#bd-list .bd-row', { hasText: 'Amal Today' }).locator('a.bd-wa').getAttribute('href'))!)).toContain('كل عام وأنت بخير يا Amal!');
    await page.locator('.bd-lang select').selectOption('auto');
    // the bell counts today's birthday until someone wishes it
    expect(await page.evaluate(`_ntRows().find(r=>r.k==='bday')?.n`)).toBe(1);
    await page.locator('#bd-list .bd-row', { hasText: 'Amal Today' }).locator('.bd-wish').click();
    await expect(page.locator('#bd-list .bd-row', { hasText: 'Amal Today' }).locator('.bd-wish')).toHaveAttribute('aria-pressed', 'true');
    expect(writes.at(-1)?.items).toEqual([expect.objectContaining({ id: 'm1', y: 2026, by: 'Spec Staff' })]);
    expect(await page.evaluate(`_ntRows().find(r=>r.k==='bday')`)).toBeUndefined();
    // and it can be taken back
    await page.locator('#bd-list .bd-row', { hasText: 'Amal Today' }).locator('.bd-wish').click();
    await expect(page.locator('#bd-list .bd-row', { hasText: 'Amal Today' }).locator('.bd-wish')).toHaveAttribute('aria-pressed', 'false');
    expect(writes.at(-1)?.items).toEqual([]);
  });

  test('narrows by window, by month and by search', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setCommTab('birthdays')`);
    await page.locator('#tab-community .filter-pill', { hasText: /^7 days$/ }).click();
    await expect(names(page)).toHaveText(['Amal Today', 'Badr Tomorrow']);
    await page.locator('#tab-community .filter-pill', { hasText: 'All year' }).click();
    await page.locator('.bd-mon').nth(1).click();                                           // February
    await expect(names(page)).toHaveText(['Dana Leap']);
    await page.locator('.bd-mon').nth(1).click();                                           // tapped again: every month
    await expect(names(page)).toHaveCount(5);
    const search = page.locator('#bd-search');
    if (!(await search.isVisible())) await page.locator('[data-srch="bd"] .srch-btn').click(); // a phone folds the search into a button
    await search.fill('omar');
    await expect(names(page)).toHaveText(['Omar Soon']);
    await search.fill('0557778888');                                                        // a phone number finds its owner
    await expect(names(page)).toHaveText(['Faisal Recent']);
  });

  test('filters by tag: the Community by default, then any tag or every account; the bell still counts the Community', async ({ page }) => {
    const jcc = { id: 'tag_jcc', slug: 'jcc', name: 'Jeddah Corniche Circuit', color: '#2f63ad' };
    await staff(page, { tags: [...tags, jcc], customer_tags: [...customer_tags, { customer_id: 'n1', tag_id: 'tag_jcc', added_at: 1 }] });
    await page.evaluate(`setCommTab('birthdays')`);
    await expect(names(page)).toHaveCount(5);                                               // the Community, as before
    const filter = page.locator('#tab-community .filter-toggle');
    await expect(filter).not.toContainText('(1)');
    await filter.click();
    await page.locator('#fm-bd select[aria-label="Tag"]').selectOption('tag_jcc');
    await expect(names(page)).toHaveText(['Not Member']);
    await expect(filter).toContainText('(1)');
    await expect(page.locator('#tab-community')).toContainText('Birthdays, soonest first.');  // no longer "Community members'"
    await page.locator('#fm-bd select[aria-label="Tag"]').selectOption('all');
    await expect(names(page)).toHaveCount(7);                                               // everyone with a date, a lapsed tag too
    expect(await page.evaluate('_bdTodayOpen().length')).toBe(1);                           // the bell: Amal alone, not the other two born today
  });

  test('the Tag filter shows the list in use, and every account comes a page at a time', async ({ page }) => {
    const jcc = { id: 'tag_jcc', slug: 'jcc', name: 'Jeddah Corniche Circuit', color: '#2f63ad' };
    // the Community tag missing from the tag list: the picker still says what is listed
    await staff(page, { tags: [jcc], customer_tags: [...customer_tags, { customer_id: 'n1', tag_id: 'tag_jcc', added_at: 1 }] });
    await page.evaluate(`setCommTab('birthdays')`);
    await expect(names(page)).toHaveCount(5);
    await page.locator('#tab-community .filter-toggle').click();
    await expect(page.locator('#fm-bd select[aria-label="Tag"]')).toHaveValue('tag_saturday');
    await expect(page.locator('#fm-bd select[aria-label="Tag"] option:checked')).toHaveText('Community');
    await page.locator('#fm-bd select[aria-label="Tag"]').selectOption('tag_jcc');                            // the first tag can be picked
    await expect(names(page)).toHaveText(['Not Member']);
    // 700 more riders with a birth date: every account, 300 at a time
    await page.evaluate(`S.customers=[...S.customers,...Array.from({length:700},(_,i)=>({id:'x'+i,name:'Rider '+i,phone:'',birth_date:'1990-01-15',created_at:'2026-01-01T00:00:00Z'}))];_bdSetTag('all')`);
    await expect(names(page)).toHaveCount(300);
    await expect(page.locator('#bd-list')).toContainText('Showing 300 of 707');
    await page.locator('#bd-list button', { hasText: 'Show 300 more' }).click();
    await expect(names(page)).toHaveCount(600);
    await page.locator('#bd-list button', { hasText: 'Show 107 more' }).click();
    await expect(names(page)).toHaveCount(707);
    await expect(page.locator('#bd-list button', { hasText: /^Show / })).toHaveCount(0);
    // a search starts again from the first page
    await page.evaluate(`S._bdQ='rider';S._bdShow=0;_bdPaintList()`);
    await expect(names(page)).toHaveCount(300);
    // rows are kept for one copy of the lists only
    expect(await page.evaluate(`(()=>{_bdRows('any');_bdRows('tag_jcc');S.customers=[...S.customers];_bdRows(BD_TAG);return _bdCache.size;})()`)).toBe(1);
  });

  // Since 2026-10-02 the bell tells only what is new: a birthday already there when the list first
  // loads is known, and must stay known through the empty list RLS hands back before staff sign-in.
  test('a known birthday stays known when the rider list comes back empty before staff sign-in', async ({ page }) => {
    await staff(page);
    const bell = page.locator('#nt-btn');
    await page.evaluate('_ntSync()');
    await expect(bell.locator('.nt-badge')).toHaveCount(0);
    // RLS answers a read made before the staff session with no rows, not an error
    await page.evaluate(`(()=>{const c=S.customers;S.customers=[];_ntSync();S.customers=c;_ntSync();})()`);
    await expect(bell.locator('.nt-badge')).toHaveCount(0);
  });

  test('Add to calendar saves every birthday as a yearly event, day and month only', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setCommTab('birthdays')`);
    const dl = page.waitForEvent('download');
    await page.locator('#tab-community button', { hasText: 'Add to calendar' }).click();
    const file = await (await dl).path();
    const ics = readFileSync(file!, 'utf8');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(5);
    expect(ics).toContain('SUMMARY:Amal Today: birthday');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261004');
    expect(ics).toContain('RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1');                    // the leap-day birthday
    expect(ics).not.toContain('1995');                                                      // no birth year leaves the page
  });
});
