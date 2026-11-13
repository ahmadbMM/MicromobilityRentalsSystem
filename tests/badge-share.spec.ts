import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Share a badge, a title or a finished challenge as a picture (new features build F12, 2026-11-13; badge-share.js). A
// Share button sits in an earned badge's pop-up, under the member's title on Account > Badges and on a finished challenge
// on the Community tab. It opens a pop-up with the picture (1080 x 1920, drawn on the phone), a switch to add the rider's
// first name (off every time) and one button: Share where the browser can hand a file to its share sheet (the picture
// alone, no words), Save image where it cannot. The picture's words are also its alternative text, which these specs
// read; its pixels are checked for the medal, the mark and the title's colour. All Supabase traffic is stubbed.

// The app's globals, as the page has them (const/let bindings are not window properties): for the function-form calls of
// the spec that runs under the page's own policy.
declare const S: { dataLoaded: boolean };
declare const sb: unknown;
declare const _lastLoadOk: boolean | undefined;
declare const _refsLoaded: boolean | undefined;
declare function setCustTab(tab: string, part?: string): void;

const EMOJI = /\p{Extended_Pictographic}/u;
const RIDE = '2026-09-01'; // before the rating gate's first day: a done ride here asks for no rating
const sessions = [{ id: RIDE, day: 'Tuesday', session_date: RIDE, capacity: 40, status: 'closed', created_at: 0, bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }) }];
const queue_entries = [{ id: 'q1', session_id: RIDE, session_day: 'Tuesday', session_date: RIDE, queue_num: 2, name: 'Lina Haddad', phone: '0551112222', customer_id: 'c1', status: 'done', paid: true, type_preference: 'Road', price: 115, walk_in: false, registered_at: '2026-08-30T10:00:00Z' }];
// A badge staff gave weeks ago (so it does not pop up as new), and a Community badge the database gave.
const marshal = { slug: 'marshal', icon: 'shield', color: 'orange', name: 'Marshal', system: true, note: null, at: '2026-09-20T10:00:00Z' };
const met = { slug: 'challenge_1', icon: 'target', color: 'blue', name: 'Challenge Met', system: true, note: null, at: '2026-10-31T20:00:00Z' };
const catalog = [{ id: 'bd_challenge_1', slug: 'challenge_1', name: 'Challenge Met', icon: 'target', color: 'blue', system: true, auto: true, description: 'Meet your monthly challenge.' }];
const titles = { ok: true, member: true, hidden: false, shown: 'ttl_leg', titles: [
  { id: 'ttl_cap', name: 'Ride Captain', name_ar: 'قائد الرحلة', color: 'gold', auto: false, expires_on: '2099-01-31' }, // no day: a database before 20261114081200
  { id: 'ttl_leg', name: 'Legend', name_ar: 'أسطورة', color: 'purple', auto: true, expires_on: null, at: '2026-11-02' },
] };
const sat = (id: string) => ({ id, day: 'Saturday', session_date: id, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' });
const feed = (o: Record<string, unknown> = {}) => ({
  ok: true, today: '2026-11-11',
  me: { kind: 'level', levels: [1, 2, 3], target: 2, chosen: true, n: 2, ends_on: '2026-11-30', sats: 4 },
  club: null,
  goals: [{ id: 'goal_cool', name: 'Cool Season: 8 Saturdays', name_ar: 'موسم الأجواء الباردة: 8 رحلات سبت', scope: 'saturday', target: 8, n: 8, ends_on: '2027-02-28', badge: { slug: 'cool_season_26', icon: 'wind', color: 'teal' } }],
  numbers: { last: '2026-11-07', last_riders: 96, last_rides: 96, month: 96, all: 2104, since: '2026-06-13' },
  post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null, ...o,
});
// Five circuit rides ridden: the monthly challenge's slot shows the challenge, which a finished one is shared from. Under
// five rides that slot shows the first-five-rides path instead (new features build F1, tests/first-five-rides.spec.ts).
const rode5 = ['2026-08-28', '2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25'].map((d, i) => ({ id: 'o' + i, name: 'Lina Haddad', customer_id: 'c1', session_id: 'j-' + d, session_day: 'Friday', session_date: d, queue_num: 1, status: 'done', paid: true, price: 30 }));
// The Community tab's copy on the phone: where a member's picture finds the club's total away from that tab.
const hubCopy = (page: Page, numbers: Record<string, unknown>) =>
  page.addInitScript((v) => localStorage.setItem('cq_hub_c1', v), JSON.stringify({ at: Date.now(), d: { ok: true, numbers } }));

async function rider(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions, customers: [], queue_entries, bikes: [], 'rpc:customer_my_badges': [marshal], ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account','badges')`);
  await expect(page.locator('#tab-account .mr-badge').first()).toBeVisible();
}
async function member(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [sat('2099-01-03')], customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed(), ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'male' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('members')`);
  await expect(page.locator('#hub-body .hub-hero')).toBeVisible();
}
// The browser's share sheet, stood in for: it takes files, and what it was handed is kept.
const canShare = (page: Page) => page.evaluate(`navigator.canShare=(d)=>!!(d&&d.files&&d.files.length);navigator.share=(d)=>{window._shared=d;return Promise.resolve();}`);
const cannotShare = (page: Page) => page.evaluate(`navigator.canShare=undefined;navigator.share=undefined`);
const pop = (page: Page) => page.locator('#badge-pop');
const pic = (page: Page) => page.locator('#badge-pop #shr-img');
// A badge's tile, its pop-up, then Share in it.
async function shareBadge(page: Page, name: string) {
  await page.locator('#tab-account .mr-badge', { hasText: name }).click();
  await expect(pop(page).locator('.badge-pop-nm')).toHaveText(name);
  await pop(page).locator('.badge-pop-shr button').click();
  await expect(pic(page)).toBeVisible();
}
// How many of a picture's pixels in a box are near a colour: the picture file, read back.
const near = (page: Page, src: string, box: number[], rgb: number[]) => page.evaluate(`(async()=>{
  const bm=await createImageBitmap(await (${src}));const cv=document.createElement('canvas');cv.width=bm.width;cv.height=bm.height;
  const x=cv.getContext('2d');x.drawImage(bm,0,0);const b=${JSON.stringify(box)},c=${JSON.stringify(rgb)},d=x.getImageData(b[0],b[1],b[2],b[3]).data;
  let n=0;for(let i=0;i<d.length;i+=4)if(Math.abs(d[i]-c[0])<40&&Math.abs(d[i+1]-c[1])<40&&Math.abs(d[i+2]-c[2])<40)n++;
  return{w:bm.width,h:bm.height,n};})()`) as Promise<{ w: number; h: number; n: number }>;
const shown = `fetch(document.getElementById('shr-img').src).then(r=>r.blob())`;

test.describe('@customer:account share a badge, a title or a finished challenge', () => {
  test('a badge: the file is fetched on the tap, the picture is drawn with no name, and it goes alone to the share sheet', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('badge-share.js')) asked.push(r.url()); });
    await rider(page);
    await canShare(page);
    await page.locator('#tab-account .mr-badge', { hasText: 'Marshal' }).click();
    const share = pop(page).locator('.badge-pop-shr button');
    await expect(share).toHaveText('Share');
    await expect(pop(page).getByRole('button', { name: 'Close' })).toBeFocused(); // the pop-up's Close keeps the focus
    expect(asked).toEqual([]);
    await share.click();
    await expect(pic(page)).toBeVisible();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\/badge-share\.js\?v=[0-9a-f]{10}$/);
    await expect(page.locator('#badge-pop')).toHaveCount(1); // it takes the badge pop-up's place
    await expect(pop(page).getByRole('dialog', { name: 'Share' })).toBeVisible();
    // its words: the mark's name, what it is, the badge, its level, the day staff gave it; nobody's name, no club line
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Badge earned · Marshal · Level 1 of 5 · 20 Sep\w* 2026$/);
    await expect(page.locator('#shr-name')).not.toBeChecked();
    // the picture: 1080 x 1920, the medal in the badge's orange, the mark in the brand green
    const medal = await near(page, shown, [280, 460, 520, 520], [249, 138, 60]);
    expect([medal.w, medal.h]).toEqual([1080, 1920]);
    expect(medal.n).toBeGreaterThan(2000);
    expect((await near(page, shown, [472, 140, 136, 120], [3, 255, 137])).n).toBeGreaterThan(1500);
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
    // the button: Share, and the sheet is handed the picture and nothing else
    const go = pop(page).locator('#shr-go');
    await expect(go).toHaveText('Share');
    await expect(go).toBeEnabled();
    await go.click();
    await expect.poll(() => page.evaluate('!!window._shared')).toBe(true);
    expect(await page.evaluate(`({keys:Object.keys(window._shared),n:window._shared.files.length,type:window._shared.files[0].type,name:window._shared.files[0].name,big:window._shared.files[0].size>5000})`))
      .toEqual({ keys: ['files'], n: 1, type: 'image/png', name: 'micromobility-marshal.png', big: true });
    await expect(pop(page)).toBeVisible(); // it stays, for a second app
    await pop(page).getByRole('button', { name: 'Close' }).click();
    await expect(pop(page)).toHaveCount(0);
    await expect(page.locator('#tab-account .mr-badge', { hasText: 'Marshal' })).toBeFocused(); // back on the badge tapped
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0);
  });

  test('the first name is added only by the switch, and is off again the next time', async ({ page }) => {
    await rider(page);
    await canShare(page);
    await shareBadge(page, 'Marshal');
    await expect(pop(page).locator('.shr-sw')).toContainText('Include my first name');
    await expect(pic(page)).not.toHaveAttribute('alt', /Lina|Haddad/);
    const plain = await page.evaluate(`${shown}.then(b=>b.size)`);
    await pop(page).locator('.shr-sw').click();
    await expect(page.locator('#shr-name')).toBeChecked();
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Lina · Badge earned · Marshal · /);
    await expect(pic(page)).not.toHaveAttribute('alt', /Haddad/); // the first name only
    await pop(page).locator('#shr-go').click();
    await expect.poll(() => page.evaluate('!!window._shared')).toBe(true);
    expect(await page.evaluate('window._shared.files[0].size')).not.toBe(plain); // the picture with the name is the one sent
    await pop(page).locator('.shr-sw').click();
    await expect(pic(page)).not.toHaveAttribute('alt', /Lina/);
    await page.keyboard.press('Escape');
    await expect(pop(page)).toHaveCount(0);
    await shareBadge(page, 'Marshal');
    await expect(page.locator('#shr-name')).not.toBeChecked();
    await expect(pic(page)).not.toHaveAttribute('alt', /Lina/);
  });

  test('where files cannot be shared the button saves the picture instead', async ({ page }) => {
    await rider(page);
    await cannotShare(page);
    await shareBadge(page, 'First Lap');
    // a badge earned by riding: the day of the ride that earned it
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Badge earned · First Lap · Level 1 of 4 · 1 Sep\w* 2026$/);
    const go = pop(page).locator('#shr-go');
    await expect(go).toHaveText('Save image');
    const dl = page.waitForEvent('download');
    await go.click();
    expect((await dl).suggestedFilename()).toBe('micromobility-first_lap.png');
    await expect(page.locator('#toast-container')).toContainText('Image saved');
    await expect(pop(page)).toBeVisible();
    // a browser that shares words but not files saves too
    await page.evaluate(`navigator.share=()=>{window._textShared=true;return Promise.resolve();};navigator.canShare=()=>false`);
    const dl2 = page.waitForEvent('download');
    await go.click();
    expect((await dl2).suggestedFilename()).toBe('micromobility-first_lap.png');
    expect(await page.evaluate('!!window._textShared')).toBe(false);
  });

  test('a level reached by riding carries the day of the night that reached it; a badge with no one day carries none', async ({ page }) => {
    const days = ['2026-08-04', '2026-08-11', '2026-08-18', '2026-08-25', RIDE];
    const ss = days.map((d) => ({ ...sessions[0]!, id: d, session_date: d }));
    const qs = days.map((d, i) => ({ ...queue_entries[0]!, id: `r${i}`, session_id: d, session_date: d, queue_num: i ? 2 : 1 }));
    qs.push({ ...queue_entries[0]!, id: 'r9', session_id: days[0]!, session_date: days[0]!, queue_num: 3 }); // a second rider on the booking: one night, not two
    await rider(page, { sessions: ss, queue_entries: qs, 'rpc:customer_my_badges': [] });
    await cannotShare(page);
    await shareBadge(page, 'Grid Regular'); // five nights: the fifth one's day, not the first's and not the sixth row's
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Badge earned · Grid Regular · Level 2 of 4 · 1 Sep\w* 2026$/);
    await pop(page).getByRole('button', { name: 'Close' }).click();
    await shareBadge(page, 'Front Row'); // first in the queue once: no day the app can name
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Badge earned · Front Row · Level 1 of 5$/);
  });

  test('a share the phone refuses saves the picture; a sheet the rider closes does nothing', async ({ page }) => {
    await rider(page);
    await canShare(page);
    await shareBadge(page, 'Marshal');
    const saved: string[] = [];
    page.on('download', (d) => saved.push(d.suggestedFilename()));
    await page.evaluate(`window._asked=0;navigator.share=()=>{window._asked++;return Promise.reject(Object.assign(new Error('closed'),{name:'AbortError'}));}`);
    await pop(page).locator('#shr-go').click();
    await expect.poll(() => page.evaluate('window._asked')).toBe(1);
    await page.evaluate(`navigator.share=()=>{window._asked++;return Promise.reject(Object.assign(new Error('no'),{name:'NotAllowedError'}));}`);
    await pop(page).locator('#shr-go').click();
    await expect.poll(() => saved.length).toBe(1);
    await expect(page.locator('#toast-container')).toContainText('Image saved');
    expect(saved).toEqual(['micromobility-marshal.png']); // one save, for the share that failed; none for the sheet they closed
    expect(await page.evaluate('window._asked')).toBe(2);
  });

  test('a badge not earned has no Share; a file that cannot be fetched says so and the next tap asks again', async ({ page }) => {
    await rider(page);
    await page.locator('#tab-account #mr-badges-more').click();
    await page.locator('#tab-account .mr-badge.locked').first().click();
    await expect(pop(page)).toBeVisible();
    await expect(pop(page).locator('.badge-pop-shr')).toHaveCount(0);
    await pop(page).getByRole('button', { name: 'Close' }).click();
    await page.route('**/badge-share.js*', (r) => r.abort());
    await page.locator('#tab-account .mr-badge', { hasText: 'Marshal' }).click();
    await pop(page).locator('.badge-pop-shr button').click();
    await expect(page.locator('#toast-container')).toContainText('We could not load this page');
    await expect(pop(page).locator('.badge-pop-nm')).toHaveText('Marshal'); // the badge's pop-up is still there
    await page.unroute('**/badge-share.js*');
    await pop(page).locator('.badge-pop-shr button').click();
    await expect(pic(page)).toBeVisible();
  });

  test('a title: the picture carries its chip in its colour, the day it was earned and the club total; no name', async ({ page }) => {
    await hubCopy(page, { all: 2104, since: '2026-06-13' });
    await rider(page, { 'rpc:community_member': true, 'rpc:customer_my_titles': titles });
    await canShare(page);
    const btn = page.locator('#tt-mine .tt-shr');
    await expect(btn).toHaveText('Share');
    await btn.click();
    await expect(pic(page)).toBeVisible();
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Title · Legend · 2 Nov\w* 2026 · The club: 2104 Saturday rides since June 2026$/);
    await expect(page.locator('#shr-name')).not.toBeChecked();
    const chip = await near(page, shown, [90, 640, 900, 210], [157, 108, 255]); // the chip's bar and edge, in the title's purple
    expect([chip.w, chip.h]).toEqual([1080, 1920]);
    expect(chip.n).toBeGreaterThan(3000);
    await pop(page).locator('.shr-sw').click();
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Title · Legend · Lina · 2 Nov/);
    await pop(page).locator('#shr-go').click();
    await expect.poll(() => page.evaluate('window._shared&&window._shared.files[0].name')).toBe('micromobility-title.png');
    expect(await page.evaluate('Object.keys(window._shared)')).toEqual(['files']);
    await pop(page).getByRole('button', { name: 'Close' }).click();
    await expect(btn).toBeFocused();
  });

  test('a title from a database before the migration has no day; a club total under 10 is never drawn', async ({ page }) => {
    await hubCopy(page, { all: 9, since: '2026-06-13' });
    await rider(page, { 'rpc:community_member': true, 'rpc:customer_my_titles': { ...titles, shown: 'ttl_cap' } });
    await page.locator('#tt-mine .tt-shr').click();
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Title · Ride Captain$/);
  });

  test('the club total goes on a Community badge, not on another badge, and only for a member who has it on the phone', async ({ page }) => {
    await hubCopy(page, { all: 2104 });
    await rider(page, { 'rpc:customer_my_badges': [marshal, met], 'rpc:badge_catalog': catalog });
    await shareBadge(page, 'Challenge Met');
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Badge earned · Challenge Met · .*31 Oct\w* 2026 · The club: 2104 Saturday rides$/);
    await pop(page).getByRole('button', { name: 'Close' }).click();
    await shareBadge(page, 'Marshal');
    await expect(pic(page)).not.toHaveAttribute('alt', /club/i);
    await pop(page).getByRole('button', { name: 'Close' }).click();
    // nothing on the phone (a rider who is not a member): no club line
    await page.evaluate(`localStorage.removeItem('cq_hub_c1')`);
    await shareBadge(page, 'Challenge Met');
    await expect(pic(page)).not.toHaveAttribute('alt', /club/i);
  });

  test('a Community badge the pulse brings is shared from its own pop-up, beside Community and Done', async ({ page }) => {
    await hubCopy(page, { all: 2104 });
    await stubSupabase(page, { sessions, customers: [], queue_entries, bikes: [], 'rpc:community_member': true, 'rpc:customer_my_badges': [met], 'rpc:badge_catalog': catalog,
      'rpc:hub_pulse': { ok: true, member: true, dot: false, me: null, goals: [], fresh: [{ slug: 'challenge_1', at: met.at }] }, 'rpc:hub_seen': { ok: true, n: 1 } });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
    await page.goto('/');
    await waitForSb(page);
    await expect(pop(page).locator('.badge-pop-nm')).toHaveText('Challenge Met');
    await expect(pop(page).locator('button')).toHaveText(['Share', 'Community', 'Done']);
    await expect(pop(page).locator('button', { hasText: 'Done' })).toBeFocused(); // Done keeps the focus
    await pop(page).locator('.badge-pop-shr button').click();
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Badge earned · Challenge Met · .*31 Oct\w* 2026 · The club: 2104 Saturday rides$/);
    await expect(page.locator('#shr-name')).not.toBeChecked();
    await pop(page).getByRole('button', { name: 'Close' }).click();
    await expect(pop(page)).toHaveCount(0);
  });

  test('every word exists in all ten languages, none an emoji; Arabic draws its own words', async ({ page }) => {
    await rider(page);
    await shareBadge(page, 'Marshal');
    expect(await page.evaluate(`Object.entries(SHR_T).filter(([k,v])=>v.length!==SHR_LANGS.length||v.some(x=>!String(x).trim())).map(([k])=>k)`)).toEqual([]);
    expect(await page.evaluate('SHR_LANGS')).toEqual(['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']);
    expect(EMOJI.test(await page.evaluate('JSON.stringify(SHR_T)'))).toBe(false);
    // the same placeholders in every language
    expect(await page.evaluate(`Object.entries(SHR_T).filter(([k,v])=>v.some(x=>(x.match(/\\{\\d\\}/g)||[]).sort().join()!==(v[0].match(/\\{\\d\\}/g)||[]).sort().join())).map(([k])=>k)`)).toEqual([]);
    expect(await page.evaluate(`/[٠-٩۰-۹०-९০-৯]/.test(JSON.stringify(SHR_T))`)).toBe(false); // Latin digits everywhere
    await pop(page).getByRole('button', { name: 'Close' }).click();
    await page.evaluate(`setLang('ar');setCustTab('account','badges')`);
    await page.locator('#tab-account .mr-badge').first().click();
    await pop(page).locator('.badge-pop-shr button').click();
    await expect(pic(page)).toBeVisible();
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · وسام مكتسب · /);
    await expect(pic(page)).toHaveAttribute('alt', /المستوى 1 من 5/); // the level's numbers stay Latin, and in order
    await expect(pop(page).locator('.shr-sw')).toContainText('إضافة اسمي الأول');
    expect(EMOJI.test(await pop(page).innerText())).toBe(false);
    expect(await page.evaluate('document.documentElement.dir')).toBe('rtl');
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
  });
});

test.describe('@customer:members share a finished challenge', () => {
  test('a finished monthly challenge and a finished season challenge are shared; one still running is not', async ({ page }) => {
    await member(page, { queue_entries: rode5 });
    await canShare(page);
    const mine = page.locator('#hub-body .hub-card', { hasText: 'Your challenge' });
    const season = page.locator('#hub-body .hub-card', { hasText: 'Season challenge' });
    await expect(mine.locator('.shr-btn')).toHaveText('Share');
    await mine.locator('.shr-btn').click();
    await expect(pic(page)).toBeVisible();
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Challenge completed · 2 sessions in a month · November 2026 · The club: 2104 Saturday rides since June 2026$/);
    await expect(page.locator('#shr-name')).not.toBeChecked();
    expect((await near(page, shown, [280, 460, 520, 520], [3, 255, 137])).n).toBeGreaterThan(2000); // its medal, in green
    await pop(page).locator('#shr-go').click();
    await expect.poll(() => page.evaluate('window._shared&&window._shared.files[0].name')).toBe('micromobility-challenge.png');
    await pop(page).getByRole('button', { name: 'Close' }).click();
    await season.locator('.shr-btn').click();
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Challenge completed · Cool Season: 8 Saturdays · The club: 2104/);
    await pop(page).getByRole('button', { name: 'Close' }).click();
    // not finished: no button
    await page.evaluate(`S._hub.d.me.n=1;S._hub.d.goals[0].n=3;_hubRender()`);
    await expect(page.locator('#hub-body .hub-card', { hasText: 'Your challenge' })).toBeVisible();
    await expect(page.locator('#hub-body .shr-btn')).toHaveCount(0);
  });

  test('a first session done is shared by its own name, with nothing about anyone else', async ({ page }) => {
    await member(page, { queue_entries: rode5, 'rpc:hub_feed': feed({ me: { kind: 'first', levels: [1], target: 1, chosen: false, n: 1, ends_on: '2026-11-30', sats: 4 }, goals: [], numbers: {} }) });
    await page.locator('#hub-body .hub-card', { hasText: 'Your challenge' }).locator('.shr-btn').click();
    await expect(pic(page)).toHaveAttribute('alt', /^MicroMobility · Challenge completed · First session · November 2026$/);
  });
});

// The page's real policy (the suite bypasses it elsewhere): the medal and the mark go in as data: pictures, the preview as
// a blob: one, and nothing the pop-up draws trips it. Function-form calls only: the policy allows no eval.
test.describe('@customer:account share a badge under the page\'s policy', () => {
  test.use({ bypassCSP: false });
  test('the picture is made, medal and all, and nothing is refused', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __cspv: string[] };
      w.__cspv = [];
      document.addEventListener('securitypolicyviolation', (e) => w.__cspv.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await stubSupabase(page, { sessions, customers: [], queue_entries, bikes: [], 'rpc:customer_my_badges': [marshal] });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad' });
    await page.goto('/');
    await page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && !!S.dataLoaded
      && (typeof _lastLoadOk === 'undefined' || _lastLoadOk === true) && (typeof _refsLoaded === 'undefined' || _refsLoaded === true), undefined, { timeout: 10000 });
    await page.evaluate(() => setCustTab('account', 'badges'));
    await page.locator('#tab-account .mr-badge', { hasText: 'Marshal' }).click();
    await pop(page).locator('.badge-pop-shr button').click();
    await expect(pic(page)).toBeVisible();
    const n = await page.evaluate(async () => {
      const im = document.getElementById('shr-img') as HTMLImageElement;
      await im.decode();
      const cv = document.createElement('canvas'); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      const x = cv.getContext('2d')!; x.drawImage(im, 0, 0);
      const d = x.getImageData(280, 460, 520, 520).data; let k = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - 249) < 40 && Math.abs(d[i + 1]! - 138) < 40 && Math.abs(d[i + 2]! - 60) < 40) k++;
      return k;
    });
    expect(n).toBeGreaterThan(2000);
    expect(await page.evaluate(() => (window as unknown as { __cspv: string[] }).__cspv.slice())).toEqual([]);
  });
});
