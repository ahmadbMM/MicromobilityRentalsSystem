import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, loginCustomer, type Fixtures } from './helpers/supabase';

// Booking card (the user, 2026-11-10: "add an option on bookings to make staff able to preview it or share as a booking
// card the same way it appears on customers account add it to the 3 dots list on each booking"): every booking's ⋯ menu
// has a Booking card tile. It opens the ticket My Bookings draws for that account, in a frame of its own that carries a
// rider's page (so the rider's look applies, not the staff panel's), and a picture of it to share, save or copy.
// All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const sess = { id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' };
const row = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name: 'Rider ' + id,
  phone: '0550000000', customer_id: 'c1', type_preference: 'Road', status: 'waiting', paid: false,
  price: 75, size: 'M', registered_at: '2099-01-01T10:00:00Z', ...extra,
});
// c1 booked two riders on the night (one card in their account); q3 is a walk-in whose booking was cancelled.
const fixtures: Fixtures = {
  sessions: [sess],
  queue_entries: [row('q1', 1), row('q2', 2), row('q3', 3, { customer_id: null, name: 'Walk In', status: 'cancelled' })],
  bikes: [], customers: [{ id: 'c1', name: 'Rider q1', phone: '0550000000' }], tags: [], customer_tags: [],
};

async function roster(page: Page) {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.sfSession=${JSON.stringify(LIVE)};renderStaffQueue()`);
  await expect(page.locator('#q-results [aria-haspopup="menu"]').first()).toBeVisible();
}
const frame = (page: Page) => page.frameLocator('#confirm-modal .tc-frame');
// From the first ⋯ on the roster: c1's party row on a desk, its card on a phone; the tile is a real tap.
async function openCard(page: Page) {
  await page.locator('#q-results [aria-haspopup="menu"]').first().click();
  await page.locator('.row-sheet [role="menuitem"]', { hasText: 'Booking card' }).click();
  await shown(page);
}
async function shown(page: Page) {
  await expect(page.locator('#confirm-modal .tc-dlg')).toBeVisible();
  await expect(frame(page).locator('.ticket-card')).toBeVisible();
}
const ready = (page: Page) => expect(page.locator('#confirm-modal .tc-save')).toBeEnabled({ timeout: 15000 });

test('every booking\'s menu has Booking card under Booking, whatever its state, a party\'s too', async ({ page }) => {
  await roster(page);
  // every booking or party menu on screen (a desk folds c1's two riders into one party row)
  const onScreen = await page.evaluate(`Object.entries(S._rowMenus).filter(([k])=>!k.includes(':')||/^party(card)?:/.test(k)).map(([k,v])=>k+' '+((v.find(x=>/^_tcOpen\\(/.test(x.run))||{}).g||'none'))`) as string[];
  expect(onScreen.length).toBeGreaterThan(0);
  for (const x of onScreen) expect(x).toMatch(/ bk$/);
  // each state's own menu: waiting, checked in, done, no-show, cancelled
  const states = await page.evaluate(`['waiting','active','done','noshow','cancelled'].map(st=>{const e=Object.assign({},_qGet('q3'),{id:'x-'+st,status:st,paid:true});_entryActions0(e);
    return st+' '+((S._rowMenus['x-'+st].find(x=>/^_tcOpen\\(/.test(x.run))||{}).g||'none');})`);
  expect(states).toEqual(['waiting bk', 'active bk', 'done bk', 'noshow bk', 'cancelled bk']);
});

test('the card is the rider\'s: the account\'s riders on one ticket, its code drawn, nothing to press, the picture made', async ({ page }) => {
  await roster(page);
  await openCard(page);
  const card = frame(page).locator('.ticket-card');
  await expect(card).toContainText('Rider q1');
  await expect(card).toContainText('Rider q2');
  await expect(card.locator('.ticket-num')).toHaveText(/#1\s*–\s*#2/);
  await expect(card.locator('.cu-qr-box.cv canvas.qr-cv')).toHaveCount(1); // the code painted on its canvas, as on the rider's page
  for (const sel of ['.cu-tk-btns', '.wallet-slot', '.cu-tk-actions', '.cw-pay-slot']) await expect(card.locator(sel)).toHaveCount(0);
  // a rider's page: no view-staff on its body, nothing moving
  expect(await frame(page).locator('body').getAttribute('class')).not.toContain('view-staff');
  await expect(frame(page).locator('html')).toHaveClass(/tc-still/);
  // the frame takes the card's height
  const fh = (await page.locator('#confirm-modal .tc-frame').boundingBox())!.height;
  const ph = (await frame(page).locator('.tc-pad').boundingBox())!.height;
  expect(Math.abs(fh - ph)).toBeLessThanOrEqual(2);
  await ready(page);
  const pic = await page.evaluate(`(async()=>{const r=S._tc,bm=await createImageBitmap(r.blob),c=document.createElement('canvas');c.width=bm.width;c.height=bm.height;const x=c.getContext('2d');x.drawImage(bm,0,0);
    const d=x.getImageData(0,0,c.width,c.height).data,seen=new Set();for(let i=0;i<d.length;i+=4*97)seen.add(d[i]+','+d[i+1]+','+d[i+2]);
    const pad=document.querySelector('#confirm-modal .tc-frame').contentDocument.querySelector('.tc-pad').getBoundingClientRect();
    return{type:r.blob.type,name:r.file.name,w:bm.width,h:bm.height,pw:pad.width,ph:pad.height,colours:seen.size};})()`) as { type: string; name: string; w: number; h: number; pw: number; ph: number; colours: number };
  expect(pic.type).toBe('image/png');
  expect(pic.name).toBe(`MicroMobility-booking-${LIVE}-1.png`);
  expect(pic.w).toBe(Math.round(Math.ceil(pic.pw) * 3)); // three times the card's size
  expect(pic.h).toBe(Math.round(Math.ceil(pic.ph) * 3));
  expect(pic.colours).toBeGreaterThan(40); // a drawn card, not a blank
  await expect(page.locator('#confirm-modal .tc-state')).toHaveText('');
});

test('a cancelled walk-in\'s card is its own booking alone, with no code', async ({ page }) => {
  await roster(page);
  await page.evaluate(`_tcOpen('q3')`);
  await shown(page);
  const card = frame(page).locator('.ticket-card');
  await expect(card).toContainText('Walk In');
  await expect(card).not.toContainText('Rider q1');
  await expect(card.locator('.cu-qr-box')).toHaveCount(0);
  await expect(card.locator('.status-badge')).toContainText(/Cancel/i);
  await ready(page);
});

test('Save downloads the picture and logs it; Share hands the file to the share sheet; Copy puts it on the clipboard', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: unknown; __copied: string[] };
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: (d: unknown) => { w.__shared = d; return Promise.resolve(); }, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { write: (items: ClipboardItem[]) => { w.__copied = items.flatMap((i) => i.types); return Promise.resolve(); } }, configurable: true });
  });
  await roster(page);
  await openCard(page);
  await ready(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#confirm-modal .tc-save').click()]);
  expect(dl.suggestedFilename()).toBe(`MicroMobility-booking-${LIVE}-1.png`);
  await page.locator('#confirm-modal .tc-share').click();
  await expect.poll(() => page.evaluate(`window.__shared&&window.__shared.files.map(f=>f.type+' '+f.name).join()`)).toBe(`image/png MicroMobility-booking-${LIVE}-1.png`);
  await page.locator('#confirm-modal .tc-copy').click();
  await expect.poll(() => page.evaluate(`(window.__copied||[]).join()`)).toBe('image/png');
  const log = await page.evaluate(`S.fullLog.slice(-3).map(l=>l.label)`);
  expect(log).toEqual(['Saved the booking card of #1 Rider q1', 'Shared the booking card of #1 Rider q1', 'Copied the booking card of #1 Rider q1']);
  await page.locator('#confirm-modal .bdg-x').click();
  await expect(page.locator('#confirm-modal .tc-dlg')).toHaveCount(0);
  expect(await page.evaluate('S._tc')).toBeNull();
});

test('the card wears what the rider\'s own My Bookings shows', async ({ browser }) => {
  // the rider's page, signed in as c1
  const rider = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await stubSupabase(rider, fixtures);
  await loginCustomer(rider, { id: 'c1', name: 'Rider q1' });
  await rider.goto('/my-bookings');
  await waitForSb(rider);
  const theirs = rider.locator('#tab-myrides .ticket-card').first();
  await expect(theirs).toBeVisible();
  const look = (sel: string) => `(()=>{const k=document.querySelector(${JSON.stringify(sel)});const c=getComputedStyle(k),n=getComputedStyle(k.querySelector('.ticket-num')),h=getComputedStyle(k.querySelector('.ticket-header'));
    return[c.backgroundColor,c.borderRadius,c.color,n.color,n.fontFamily,n.fontSize,h.borderBottomStyle].join(' | ');})()`;
  const want = await rider.evaluate(look('#tab-myrides .ticket-card'));
  await rider.close();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await roster(page);
  await openCard(page);
  const got = await page.frame({ url: /about:srcdoc/ })!.evaluate(look('.tc-pad .ticket-card'));
  expect(got).toBe(want);
  await page.close();
});

// The page's policy on (the suite bypasses it, playwright.config.ts): the frame and the picture trip nothing.
// The app's globals, as the page has them (function form only: the policy forbids eval, which the string form uses).
declare const S: { view: string; _tc: { blob: Blob } | null };
declare function getQueue(): { id: string }[];
declare function _tcOpen(id: string): void;
test.describe('under the page\'s Content-Security-Policy', () => {
  test.use({ bypassCSP: false });
  test('opening the card and making its picture trips nothing, in the page or the frame', async ({ page }) => {
    type W = Window & { __cspv: string[] };
    await page.addInitScript(() => {
      (window as unknown as W).__cspv = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as unknown as W).__cspv.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample || ''}`));
    });
    await stubSupabase(page, fixtures);
    await unlockStaff(page);
    await page.goto('/bookings');
    await page.waitForFunction(() => typeof S !== 'undefined' && S.view === 'staff' && getQueue().some((e) => e.id === 'q1'), undefined, { timeout: 15000 });
    await page.evaluate(() => { _tcOpen('q1'); });
    await expect(page.locator('#confirm-modal .tc-save')).toBeEnabled({ timeout: 15000 });
    await expect(page.locator('#confirm-modal .tc-state')).toHaveText('');
    // a drawn card, not a blank (on WebKit too: a -c config with a WebKit project runs this test as it is)
    const pic = await page.evaluate(async () => {
      const bm = await createImageBitmap(S._tc!.blob), c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
      const x = c.getContext('2d')!; x.drawImage(bm, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data, seen = new Set<string>();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
      return { w: bm.width, colours: seen.size };
    });
    expect(pic.w).toBeGreaterThan(600);
    expect(pic.colours).toBeGreaterThan(40);
    expect(page.frames().map((f) => f.url())).toContain('about:srcdoc'); // the card's frame, which the listener is in too
    for (const f of page.frames()) expect(await f.evaluate(() => (window as unknown as W).__cspv), f.url()).toEqual([]);
  });
});
