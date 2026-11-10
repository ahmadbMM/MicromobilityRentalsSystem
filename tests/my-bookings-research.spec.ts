import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';
import { freshModule } from './helpers/fresh-module';

// The Bookings page after the research round (2026-11-10, reports/Rider Bookings page enhancements; the user: "do
// everything" but the owner's four open decisions): a cancelled booking stays as a row until its day, a ride done but
// not yet paid stays in Past, the lockers come after the bookings ahead, today's code is large and keeps the phone
// awake, the date is one line, the route and add-ons fold behind Details, a waitlist is left (not cancelled), an
// offline change is refused in a dialog, Share sends words and a link, today's bike ride links its live map, the
// calendar event keeps one UID, and Directions go to the place itself.

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const off = (n: number) => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const jcc = (id: string, date: string, o: Record<string, unknown> = {}) => ({ id, day: 'Sunday', session_date: date, capacity: 20, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...o });
let n = 0;
const bk = (sid: string, date: string, o: Record<string, unknown> = {}) => ({ id: 'q' + (++n) + 'abcdefg', name: 'Spec Rider', customer_id: 'c1', session_id: sid, session_day: 'Sunday', session_date: date, queue_num: n, status: 'waiting', paid: false, price: 75, type_preference: 'Road', registered_at: '2026-01-01T10:00:00Z', rating_detail: { form: 'rental', s: { service: 10, bike: 10, experience: 10 } }, ...o });

async function open(page: Page, sessions: unknown[], queue: unknown[], fx: Record<string, unknown> = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('cq_lang', 'en'); localStorage.setItem('cq_lang_pick', '1');
    const w = window as unknown as Record<string, unknown>;
    w.__noRateGate = true; w.__wl = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: () => {
      (w.__wl as string[]).push('req');
      const ls: Array<() => void> = [];
      return Promise.resolve({ release: () => { (w.__wl as string[]).push('rel'); ls.forEach((f) => f()); return Promise.resolve(); }, addEventListener: (_: string, f: () => void) => ls.push(f) });
    } } });
  });
  await stubSupabase(page, { bikes: [], sessions, queue_entries: queue, 'rpc:community_member': true, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`goCustomer('myrides')`);
  await expect(page.locator('#tab-myrides .page-title')).toBeVisible();
}

test.describe('@customer:bookings the Bookings page keeps the record', () => {
  test('a cancelled booking stays as a row until its day; a rejected one and an old one do not; a done ride owed is in Past', async ({ page }) => {
    const sessions = [jcc('u5', off(5)), jcc('c3', off(3)), jcc('c4', off(4)), jcc('cOld', off(-3)), jcc('r6', off(6), { event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, title: 'Dawn Ride' }), jcc('p2', off(-2))];
    await open(page, sessions, [
      bk('u5', off(5)),
      bk('c4', off(4), { status: 'cancelled', cancelled_by: 'customer' }),
      bk('c3', off(3), { status: 'cancelled', cancelled_by: 'staff' }),
      bk('cOld', off(-3), { status: 'cancelled', cancelled_by: 'staff' }),
      bk('r6', off(6), { status: 'cancelled', cancelled_by: 'staff', approval: 'rejected' }),
      bk('p2', off(-2), { status: 'done', paid: false }),
    ]);
    const rows = page.locator('#tab-myrides .mr-cx');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Cancelled by us'); // soonest first
    await expect(rows.nth(1)).toContainText('Cancelled by you');
    await expect(rows.nth(0).locator('canvas, svg, button')).toHaveCount(0); // no code, nothing to press
    // the count is of bookings held; the cancelled rows come after the tickets
    await expect(page.locator('#tab-myrides .analytics-section-title .mr-n').first()).toHaveText('1');
    expect(await page.locator('#tab-myrides .myrides-grid > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['ticket-card', 'mr-cx-list']);
    // the ride done and not yet marked paid is a ride done
    await expect(page.locator('#mr-past #wl-p2')).toBeVisible();
  });

  test('with only cancelled bookings the page says nothing is booked and still lists them', async ({ page }) => {
    await open(page, [jcc('c3', off(3))], [bk('c3', off(3), { status: 'cancelled', cancelled_by: 'staff' })]);
    await expect(page.locator('#tab-myrides .rides-zero')).toHaveCount(0);
    await expect(page.locator('#tab-myrides .empty-state').first()).toContainText('Nothing booked yet.');
    await expect(page.locator('#tab-myrides .mr-cx')).toContainText('Cancelled by us');
  });
});

test.describe('@customer:bookings today at the desk', () => {
  test('today\'s code is large and named, the date is one line, the lockers come after it, and the phone stays awake', async ({ page }) => {
    const lockers = [{ id: 'r1', booking_id: null, day: off(0), period: 'early', status: 'reserved', price: 10, on_bill: false, pay: 'desk', paid: false, code: '7' }];
    await open(page, [jcc('t0', off(0)), jcc('u5', off(5))], [bk('t0', off(0)), bk('u5', off(5))], { 'rpc:customer_lockers': lockers });
    await page.evaluate(`_lkMineLoad(null,true)`);
    await page.waitForFunction(`_lkMine().length===1`);
    await page.evaluate(`renderMyRides()`);
    const first = page.locator('#tab-myrides .ticket-card').first();
    await expect(first).toHaveClass(/tk-today/);
    const big = first.locator('.tk-qr-big .cu-qr-box');
    await expect(big).toHaveAttribute('data-px', '224');
    await expect(big.locator('canvas')).toHaveAttribute('aria-label', /^Booking QR code MMC-\d+-q/);
    await expect(page.locator('#tab-myrides .ticket-card').nth(1).locator('.tk-qr-big')).toHaveCount(0); // another day: the corner code
    await expect(page.locator('#tab-myrides .ticket-card').nth(1).locator('.ticket-right .cu-qr-box')).toHaveAttribute('data-px', '132');
    await expect(first.locator('.tk-when-d')).toContainText(/Today.*Sunday.*9 PM/);
    // the first code on the page is tonight's ticket, the locker's comes after the bookings ahead
    const order = await page.evaluate(`(()=>{const a=document.querySelector('#tab-myrides .myrides-grid'),b=document.querySelector('#tab-myrides .lk-own');return !!(a&&b&&(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING));})()`);
    expect(order).toBe(true);
    await expect.poll(() => page.evaluate(`window.__wl.join(',')`)).toBe('req');
    await page.evaluate(`setCustTab('account')`);
    await expect.poll(() => page.evaluate(`window.__wl.join(',')`)).toBe('req,rel');
  });

  test('no today booking, no wake lock; the countdown is a timer', async ({ page }) => {
    await open(page, [jcc('u5', off(5))], [bk('u5', off(5))]);
    await expect(page.locator('#tab-myrides .ticket-card')).toHaveCount(1);
    expect(await page.evaluate(`window.__wl.length`)).toBe(0);
    expect(await page.evaluate(`_cdHtml(_sessGet('u5'),'${off(1)}')`)).toContain('role="timer"');
  });

  test('today\'s bike ride links its live map; Share sends the booking as words and a link', async ({ page }) => {
    await page.addInitScript(() => { const w = window as unknown as Record<string, unknown>; w.__shared = null; Object.defineProperty(navigator, 'share', { configurable: true, value: (d: unknown) => { w.__shared = d; return Promise.resolve(); } }); });
    await open(page, [jcc('t0', off(0)), jcc('u5', off(5))], [bk('t0', off(0)), bk('u5', off(5))]);
    const [a, b] = [page.locator('#tab-myrides .ticket-card').nth(0), page.locator('#tab-myrides .ticket-card').nth(1)];
    await expect(a.locator('.cu-tk-live')).toHaveAttribute('href', `https://micromobility.sa/live?session=t0`);
    await expect(b.locator('.cu-tk-live')).toHaveCount(0);
    await b.getByRole('button', { name: 'Share' }).click();
    const sh = await page.evaluate(`window.__shared`) as { text: string; url: string };
    expect(sh.text).toContain('Jeddah Corniche Circuit');
    expect(sh.text).toContain('9 PM');
    expect(sh.text).not.toContain('Spec Rider'); // nobody's name, the rider's own included
    expect(sh.url).toMatch(/\/reserve\?ev=jcc&session=u5$/);
  });
});

test.describe('@customer:bookings the ticket\'s parts', () => {
  test('the route folds behind Details, which stays open across a repaint', async ({ page }) => {
    await open(page, [jcc('u5', off(5))], [bk('u5', off(5))]);
    const card = page.locator('#tab-myrides .ticket-card').first();
    const btn = card.locator('.tk-more-btn');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(card.locator('.tk-route')).toBeHidden();
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('.tk-route')).toBeVisible();
    await page.evaluate(`renderMyRides()`);
    await expect(page.locator('#tab-myrides .ticket-card').first().locator('.tk-route')).toBeVisible();
    // the staff Booking card shows it open, with no fold
    const html = await page.evaluate(`renderBookingTicket(getQueue().filter(e=>e.sessionId==='u5'),{card:true})`) as string;
    expect(html).toContain('tk-route');
    expect(html).not.toContain('tk-more-btn');
  });

  test('a waitlisted booking is left, not cancelled', async ({ page }) => {
    await open(page, [jcc('u3', off(3))], [bk('u3', off(3), { status: 'waitlist' })]);
    const card = page.locator('#tab-myrides .ticket-card').first();
    await card.getByRole('button', { name: 'Leave waitlist' }).click();
    await expect(page.locator('#cancel-reason-modal .dk-cr-go')).toHaveText('Leave waitlist');
  });

  test('offline, a change is refused in a centred dialog before any reason is asked', async ({ page }) => {
    await open(page, [jcc('u5', off(5))], [bk('u5', off(5))]);
    await page.context().setOffline(true);
    await page.locator('#tab-myrides .ticket-card').first().getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#confirm-modal [role="dialog"]')).toContainText('You’re offline. Connect to the internet to change this booking.');
    await expect(page.locator('#cancel-reason-modal')).toBeHidden();
    await page.context().setOffline(false);
  });

  test('the calendar event keeps the booking\'s UID however often it is added', async ({ page }) => {
    await open(page, [jcc('u5', off(5))], [bk('u5', off(5))]);
    const id = await page.evaluate(`getQueue().find(e=>e.sessionId==='u5').id`) as string;
    const ics = () => page.evaluate(`new Promise(res=>{const o=URL.createObjectURL;URL.createObjectURL=b=>{URL.createObjectURL=o;b.text().then(res);return o.call(URL,b);};downloadBookingICS('u5','${id}');})`) as Promise<string>;
    const [a, b] = [await ics(), await ics()];
    const uid = (s: string) => (s.match(/^UID:(.*)$/m) || [])[1];
    expect(uid(a)).toBe(`booking-${id}@micromobility.sa`);
    expect(uid(b)).toBe(uid(a));
    expect(a).toMatch(/^SEQUENCE:\d+$/m);
    expect(a).toContain('URL:');
  });

  test('Directions open the booth\'s pin; on an iPhone a centred choice offers Apple Maps and Google Maps', async ({ page }) => {
    await open(page, [jcc('u5', off(5))], [bk('u5', off(5))]);
    await expect(page.locator('#tab-myrides .cu-tk-dir')).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=21.624565%2C39.106812');
    await page.evaluate(`Object.defineProperty(navigator,'userAgent',{configurable:true,get:()=>'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'});renderMyRides();`);
    await page.locator('#tab-myrides .cu-tk-dir').click();
    const dlg = page.locator('#confirm-modal .dir-pick');
    await expect(dlg.getByRole('link', { name: 'Apple Maps' })).toHaveAttribute('href', 'https://maps.apple.com/?daddr=21.624565%2C39.106812&dirflg=d');
    await expect(dlg.getByRole('link', { name: 'Google Maps' })).toHaveAttribute('href', /destination=21\.624565%2C39\.106812/);
  });

  test('on an iPhone the calendar file comes from the server, the token in a form body', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' }); });
    await open(page, [jcc('u5', off(5))], [bk('u5', off(5))]);
    await page.context().route('**/api/ics', (r) => r.fulfill({ status: 200, contentType: 'text/calendar', body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }));
    const [req] = await Promise.all([
      page.context().waitForEvent('request', (r) => r.url().endsWith('/api/ics')),
      page.locator('#tab-myrides .cu-tk-cal').click(),
    ]);
    expect(req.method()).toBe('POST');
    const body = new URLSearchParams(req.postData() || '');
    expect(body.get('k')).toBe('tok-spec');
    expect(body.get('b')).toMatch(/^q\d+abcdefg$/);
    expect(body.get('st')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(req.url()).not.toContain('tok-spec');
  });

  test('painted from the phone\'s copy, the title carries the saved-copy mark', async ({ page }) => {
    await open(page, [jcc('u5', off(5))], [bk('u5', off(5))]);
    await expect(page.locator('#tab-myrides .mr-saved')).toHaveCount(0);
    await page.evaluate(`S._cacheOnly=true;renderMyRides()`);
    await expect(page.locator('#tab-myrides .mr-saved')).toHaveAttribute('aria-label', 'Saved copy');
  });
});

test.describe('@customer:bookings /api/ics', () => {
  type Fn = (ctx: { request: Request; env?: Record<string, string> }) => Promise<Response>;
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });
  const post = (fields: Record<string, string>) => new Request('https://site.test/api/ics', { method: 'POST', body: new URLSearchParams(fields) });
  const base = { c: 'c1', k: 'tok', b: 'q1abc', st: '20991231T180000Z', en: '20991231T200000Z', ti: 'Corniche, night', lo: 'Jeddah; Circuit', de: 'Line one\nLine two', al: 'Soon' };

  test('serves the booking\'s own event to its rider, and nothing to anyone else', async () => {
    const fn = (await freshModule('functions/api/ics.js')).onRequestPost as Fn;
    let asked = '';
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { asked = String(init?.body); return new Response(JSON.stringify([{ id: 'q1abc', status: 'waiting', session_date: '2099-12-31' }])); }) as typeof fetch;
    const env = { SUPABASE_ANON_KEY: 'anon' };
    const ok = await fn({ request: post(base), env });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/calendar');
    const t = await ok.text();
    expect(JSON.parse(asked)).toEqual({ p_id: 'c1', p_token: 'tok' });
    expect(t).toContain('UID:booking-q1abc@micromobility.sa');
    expect(t).toContain('SUMMARY:Corniche\\, night');
    expect(t).toContain('LOCATION:Jeddah\\; Circuit');
    expect(t).toContain('DESCRIPTION:Line one\\nLine two');
    expect(t).toContain('URL:https://site.test/my-bookings');
    // another rider's booking, a cancelled one, a day that is not the booking's, a malformed time
    expect((await fn({ request: post({ ...base, b: 'q9zzz' }), env })).status).toBe(404);
    expect((await fn({ request: post({ ...base, st: '20990101T180000Z', en: '20990101T200000Z' }), env })).status).toBe(400);
    expect((await fn({ request: post({ ...base, st: 'tomorrow' }), env })).status).toBe(400);
    globalThis.fetch = (async () => new Response(JSON.stringify([{ id: 'q1abc', status: 'cancelled', session_date: '2099-12-31' }]))) as typeof fetch;
    expect((await fn({ request: post(base), env })).status).toBe(404);
  });
});
