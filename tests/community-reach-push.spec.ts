import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { freshModule } from './helpers/fresh-module';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Push with consent (the Community tab reach build, 2026-11-13: R16, R17, R18 and R12 of the report).
// Push ships dormant: app.src.html keeps VAPID_PUBLIC_KEY empty until the owner sets the Cloudflare Pages secrets. These
// specs switch it on for the page alone (app.js is served with a key in its line), and stand in for the browser's
// permission, the service worker's PushManager and every Supabase call:
//   - Account > Notifications: two switches, My rides and Community, each as easy to turn off as on; every change stored
//     with its consent record (customer_push_prefs_set: both switches, language, the words shown, PRIVACY_VERSION, device);
//   - "Remind me" on You're booked: the browser's own question from the tap in an installed app, Android or a computer,
//     the Add to Home Screen steps in a centred pop-up in a Safari tab on an iPhone; never on load, never twice after a no;
//   - every open of the app re-checks the subscription (WebKit never fires pushsubscriptionchange);
//   - the sender's one payload, Declarative Web Push, read by the service worker in both shapes; 404 and 410 drop the address;
//   - the Apple pass's iOS 18 relevantDates window and the meeting point staff put on the map.

const JSON_HDR = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const KEY = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url'); // any 65-byte key: the stand-in PushManager never checks it
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY = '2099-02-07';
const sess = { id: DAY, session_date: DAY, day: DOW[new Date(DAY + 'T12:00:00Z').getUTCDay()], status: 'open', capacity: 12, created_at: 1, location: 'JCC', bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 12 }) };
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

type Calls = Record<string, Record<string, unknown>[]>;
type Env = { perm?: 'default' | 'granted' | 'denied'; answer?: 'default' | 'granted' | 'denied'; sub?: string | null; standalone?: boolean;
  mark?: { id: string; ep: string } | null; prefs?: { rides: boolean; community: boolean } | 'missing'; key?: boolean };

/** The page with push switched on (or not), the browser's permission and push stood in for, and the push RPCs recorded. */
async function open(page: Page, env: Env = {}) {
  await stubSupabase(page, { sessions: [sess], bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
  if (env.key !== false) {
    await page.route(/\/app\.js(\?|$)/, async (route) => {
      const res = await route.fetch();
      const js = await res.text();
      if (!js.includes('VAPID_PUBLIC_KEY=""')) throw new Error('app.js no longer carries VAPID_PUBLIC_KEY=""');
      await route.fulfill({ response: res, body: js.replace('VAPID_PUBLIC_KEY=""', `VAPID_PUBLIC_KEY="${KEY}"`) });
    });
  }
  await page.addInitScript((o) => {
    const w = window as unknown as Record<string, unknown> & { __perm: string; __answer: string; __asked: number; __subs: number; __unsubs: number; __ep: string | null };
    w.__perm = o.perm || 'default'; w.__answer = o.answer || 'granted'; w.__asked = 0; w.__subs = 0; w.__unsubs = 0; w.__ep = o.sub || null;
    if (o.mark) localStorage.setItem('cq_push_ep', JSON.stringify(o.mark));
    if (o.standalone) Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    const N = function Notification() { /* never constructed */ } as unknown as Record<string, unknown>;
    Object.defineProperty(N, 'permission', { get: () => w.__perm });
    N.requestPermission = () => { w.__asked++; w.__perm = w.__answer; return Promise.resolve(w.__perm); };
    (window as unknown as Record<string, unknown>).Notification = N;
    const mk = (ep: string) => ({ endpoint: ep, getKey: (n: string) => new Uint8Array(n === 'auth' ? 16 : 65).fill(7).buffer,
      unsubscribe: () => { w.__unsubs++; w.__ep = null; return Promise.resolve(true); } });
    const reg = { pushManager: {
      getSubscription: () => Promise.resolve(w.__ep ? mk(w.__ep) : null),
      subscribe: () => { w.__subs++; w.__ep = 'https://fcm.googleapis.com/fcm/send/new-' + w.__subs; return Promise.resolve(mk(w.__ep)); },
    } };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { configurable: true, get: () => Promise.resolve(reg) });
  }, { perm: env.perm, answer: env.answer, sub: env.sub ?? null, standalone: !!env.standalone, mark: env.mark ?? null });
  const calls: Calls = { customer_push_subscribe: [], customer_push_unsubscribe: [], customer_push_prefs: [], customer_push_prefs_set: [] };
  const prefs = env.prefs === 'missing' ? null : { rides: true, community: false, ...(env.prefs || {}) };
  await page.route(/\/rest\/v1\/rpc\/customer_push_(subscribe|unsubscribe|prefs_set|prefs)\b/, async (route) => {
    const fn = 'customer_push_' + /customer_push_(\w+)/.exec(route.request().url())![1];
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls[fn].push(body);
    if (fn === 'customer_push_prefs' && !prefs)
      return route.fulfill({ status: 404, headers: JSON_HDR, body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.customer_push_prefs' }) });
    let answer: unknown = true;
    if (fn === 'customer_push_prefs') answer = { ok: true, ...prefs, lang: 'en' };
    if (fn === 'customer_push_prefs_set') { prefs!.rides = !!body.p_rides; prefs!.community = !!body.p_community; answer = { ok: true }; }
    return route.fulfill({ status: 200, headers: JSON_HDR, body: JSON.stringify(answer) });
  });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
  return calls;
}
const booked = (page: Page) => page.evaluate(`S.lastTickets=[{id:'t1',queueNum:3,name:'Spec Rider',sessionId:'${DAY}',sessionDay:'Saturday',sessionDate:'${DAY}',status:'waiting'}];setCustTab('register')`);
const win = (page: Page, k: string) => page.evaluate(`window.${k}`);

test.describe('@customer:push "Remind me" on You\'re booked', () => {
  test('in a browser that can push: the question from the tap, then My rides on with its consent record; never on load', async ({ page }) => {
    const calls = await open(page);
    await booked(page);
    const rm = page.locator('#tab-register .bk-ok #bk-rm');
    await expect(rm.locator('button')).toHaveText('Remind me');
    await expect(rm.locator('button svg')).toHaveCount(1); // the app's own bell, no emoji
    expect(await win(page, '__asked')).toBe(0); // nothing asked on load
    const toasts = await page.locator('#toast-live .toast').count();
    await rm.locator('button').click();
    await expect(rm).toContainText('Reminder on');
    expect(await win(page, '__asked')).toBe(1);
    expect(await win(page, '__subs')).toBe(1);
    expect(calls.customer_push_subscribe).toHaveLength(1);
    expect(calls.customer_push_subscribe[0]).toMatchObject({ p_id: 'c1', p_token: 'tok', p_endpoint: 'https://fcm.googleapis.com/fcm/send/new-1' });
    const version = await page.evaluate('PRIVACY_VERSION');
    expect(calls.customer_push_prefs_set).toEqual([{ p_id: 'c1', p_token: 'tok', p_rides: true, p_community: false, p_lang: 'en',
      p_words: 'Remind me', p_notice: version, p_device: expect.stringMatching(/^(Linux|Windows|Mac|Android) Chrome$/) }]);
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_push_ep'))`)).toEqual({ id: 'c1', ep: 'https://fcm.googleapis.com/fcm/send/new-1' });
    await expect(page.locator('#toast-live .toast')).toHaveCount(toasts); // no bar, banner or toast after the tap
    // the next booked moment: My rides is on in this browser, so there is nothing to ask
    await page.evaluate(`S.lastTickets=[{...S.lastTickets[0],id:'t2'}];renderRegister()`);
    await expect(page.locator('#bk-rm')).toBeHidden();
  });

  test('after a no it is gone for the session, and asked once only', async ({ page }) => {
    const calls = await open(page, { answer: 'denied' });
    await booked(page);
    await page.locator('#bk-rm button').click();
    await expect(page.locator('#bk-rm')).toBeHidden();
    expect(await win(page, '__asked')).toBe(1);
    expect(calls.customer_push_subscribe).toHaveLength(0);
    expect(calls.customer_push_prefs_set).toHaveLength(0);
    expect(await page.evaluate(`sessionStorage.getItem('cq_push_no')`)).toBe('1');
    await page.evaluate(`renderRegister()`);
    await expect(page.locator('#bk-rm')).toBeHidden();
  });

  test('a prompt closed without an answer counts as a no too', async ({ page }) => {
    await open(page, { answer: 'default' });
    await booked(page);
    await page.locator('#bk-rm button').click();
    await expect(page.locator('#bk-rm')).toBeHidden();
    expect(await page.evaluate(`sessionStorage.getItem('cq_push_no')`)).toBe('1');
  });

  test('hidden while push is dormant, when the browser blocks it, and when My rides is on already', async ({ page }) => {
    await open(page, { key: false });
    await booked(page);
    await expect(page.locator('#tab-register .bk-ok')).toBeVisible();
    await expect(page.locator('#bk-rm')).toBeHidden();
    expect(await page.evaluate('pushSupported()')).toBe(false);
  });

  test('hidden when the browser has blocked notifications', async ({ page }) => {
    await open(page, { perm: 'denied' });
    await booked(page);
    await expect(page.locator('#tab-register .bk-ok')).toBeVisible();
    await expect(page.locator('#bk-rm')).toBeHidden();
  });

  test('hidden when My rides is on with a live subscription', async ({ page }) => {
    const ep = 'https://fcm.googleapis.com/fcm/send/live';
    await open(page, { perm: 'granted', sub: ep, mark: { id: 'c1', ep }, prefs: { rides: true, community: false } });
    await booked(page);
    await expect(page.locator('#tab-register .bk-ok')).toBeVisible();
    await expect(page.locator('#bk-rm')).toBeHidden();
  });

  test('shown when the browser is subscribed but My rides is off; the tap keeps Community as it was', async ({ page }) => {
    const ep = 'https://fcm.googleapis.com/fcm/send/live';
    const calls = await open(page, { perm: 'granted', sub: ep, mark: { id: 'c1', ep }, prefs: { rides: false, community: true } });
    await booked(page);
    await page.locator('#bk-rm button').click();
    await expect(page.locator('#bk-rm')).toContainText('Reminder on');
    expect(await win(page, '__asked')).toBe(0); // granted already: no question
    expect(calls.customer_push_prefs_set.at(-1)).toMatchObject({ p_rides: true, p_community: true });
  });
});

test.describe('@customer:push "Remind me" on an iPhone', () => {
  test.use({ userAgent: IPHONE_SAFARI, viewport: { width: 390, height: 760 } });

  test('a Safari tab gets the Add to Home Screen steps as icons in a centred pop-up, and no question', async ({ page }) => {
    const calls = await open(page);
    await booked(page);
    await page.locator('#bk-rm button').click();
    const dlg = page.locator('#bike-info-modal .pi-dlg');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#pi-t')).toHaveText('Add the app to your Home Screen');
    const steps = dlg.locator('.pi-steps li');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toHaveText(/Tap Share/);
    await expect(steps.nth(1)).toHaveText(/Add to Home Screen/);
    await expect(steps.nth(2)).toHaveText(/Open it from your Home Screen/);
    for (let i = 0; i < 3; i++) await expect(steps.nth(i).locator('.pi-ic svg path, .pi-ic svg rect').first()).toBeAttached();
    expect(await dlg.innerText()).not.toMatch(/\p{Extended_Pictographic}/u); // no emoji
    const box = (await dlg.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 195)).toBeLessThan(4); // centred
    expect(await win(page, '__asked')).toBe(0);
    expect(calls.customer_push_subscribe).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(page.locator('#bk-rm')).toBeHidden(); // shown once a session
  });

  test('the installed app asks straight from the tap, and names the device', async ({ page }) => {
    const calls = await open(page, { standalone: true });
    await booked(page);
    await page.locator('#bk-rm button').click();
    await expect(page.locator('#bk-rm')).toContainText('Reminder on');
    await expect(page.locator('.pi-dlg')).toHaveCount(0);
    expect(await win(page, '__asked')).toBe(1);
    expect(calls.customer_push_prefs_set[0]).toMatchObject({ p_rides: true, p_device: 'iPhone Safari Home Screen' });
  });
});

test.describe('@customer:push Account > Notifications', () => {
  const openPage = (page: Page) => page.evaluate(`setCustTab('account');_accOpen('notifications')`);

  test('two switches, each one tap on and one tap off; both off unsubscribes; every change is recorded', async ({ page }) => {
    const calls = await open(page);
    await openPage(page);
    const card = page.locator('#acc-push');
    await expect(card).toBeVisible();
    await expect(card.locator('h2')).toHaveText('Notifications');
    const rides = card.locator('#pp-rides'), comm = card.locator('#pp-community');
    await expect(card.locator('label[for="pp-rides"]')).toHaveText('My rides');
    await expect(card.locator('label[for="pp-community"]')).toHaveText('Community');
    await expect(rides).not.toBeChecked(); // this browser gets nothing yet, whatever the account says
    await expect(comm).not.toBeChecked();
    expect(calls.customer_push_prefs).toHaveLength(1);
    const words = 'Notifications | My rides | Community';

    await card.locator('label[for="pp-rides"]').click();
    await expect(rides).toBeChecked();
    await expect(rides).toBeEnabled();
    expect(await win(page, '__asked')).toBe(1);
    expect(calls.customer_push_subscribe).toHaveLength(1);
    expect(calls.customer_push_prefs_set.at(-1)).toMatchObject({ p_rides: true, p_community: false, p_words: words, p_lang: 'en' });

    await card.locator('label[for="pp-community"]').click();
    await expect(comm).toBeChecked();
    await expect(comm).toBeEnabled();
    expect(calls.customer_push_subscribe).toHaveLength(1); // subscribed already
    expect(calls.customer_push_prefs_set.at(-1)).toMatchObject({ p_rides: true, p_community: true });

    await card.locator('label[for="pp-rides"]').click();
    await expect(rides).not.toBeChecked();
    await expect(rides).toBeEnabled();
    expect(calls.customer_push_prefs_set.at(-1)).toMatchObject({ p_rides: false, p_community: true });
    expect(calls.customer_push_unsubscribe).toHaveLength(0);

    await card.locator('label[for="pp-community"]').click();
    await expect(comm).not.toBeChecked();
    await expect(comm).toBeEnabled();
    expect(calls.customer_push_prefs_set.at(-1)).toMatchObject({ p_rides: false, p_community: false, p_words: words });
    expect(calls.customer_push_unsubscribe).toEqual([{ p_id: 'c1', p_token: 'tok', p_endpoint: 'https://fcm.googleapis.com/fcm/send/new-1' }]);
    expect(await win(page, '__unsubs')).toBe(1);
    expect(await page.evaluate(`localStorage.getItem('cq_push_ep')`)).toBeNull();
    expect(calls.customer_push_prefs_set).toHaveLength(4);
  });

  test('the words recorded are the ones on screen, in the page\'s language', async ({ page }) => {
    const calls = await open(page);
    await page.evaluate(`setLang('ar')`);
    await page.waitForFunction(`_langLoaded('ar')`);
    await openPage(page);
    await page.locator('label[for="pp-rides"]').click();
    await expect.poll(() => calls.customer_push_prefs_set.length).toBe(1);
    await expect(page.locator('#pp-rides')).toBeChecked();
    expect(calls.customer_push_prefs_set[0]).toMatchObject({ p_lang: 'ar', p_words: 'الإشعارات | رحلاتي | المجتمع' });
  });

  test('a browser already on reads the account\'s switches', async ({ page }) => {
    const ep = 'https://fcm.googleapis.com/fcm/send/live';
    await open(page, { perm: 'granted', sub: ep, mark: { id: 'c1', ep }, prefs: { rides: false, community: true } });
    await openPage(page);
    await expect(page.locator('#pp-rides')).not.toBeChecked();
    await expect(page.locator('#pp-community')).toBeChecked();
  });

  test('blocked in the browser: the switches are off and say so', async ({ page }) => {
    await open(page, { perm: 'denied' });
    await openPage(page);
    await expect(page.locator('#acc-push .cu-push-blocked')).toHaveText('Notifications are blocked for this site in your browser settings.');
    await expect(page.locator('#pp-rides')).toBeDisabled();
  });

  test('no card where the server cannot keep the switches, and none while push is dormant', async ({ page }) => {
    await open(page, { prefs: 'missing' });
    await openPage(page);
    await expect(page.locator('#acc-push')).toBeHidden();
    await booked(page);
    await expect(page.locator('#bk-rm')).toBeHidden(); // no consent can be stored: no ask either
  });
});

test.describe('@customer:push the privacy notice', () => {
  test('names notifications and the two switches; nobody is asked to accept it again', async ({ page }) => {
    await open(page, { key: false });
    expect(await page.evaluate('PRIVACY_VERSION')).toBe('2026-11-14'); // 2026-11-13 for these rows, moved by the new features build's rows
    expect(await page.evaluate('PRIVACY_ASK_FROM')).toBe('2026-10-02'); // the owner, 2026-10-07: never ask current customers again
    await page.evaluate('showPrivacyNotice()');
    const row = page.locator('#privacy-backdrop tr', { hasText: 'Notifications on your phone or computer' });
    await expect(row).toContainText('My rides');
    await expect(row).toContainText('Community');
    await expect(row).toContainText('turning both off deletes that address');
  });
});

test.describe('@customer:push every open of the app', () => {
  test('a subscription that went missing is made again; the old address leaves the server', async ({ page }) => {
    const old = 'https://web.push.apple.com/old';
    const calls = await open(page, { perm: 'granted', sub: null, mark: { id: 'c1', ep: old } });
    await expect.poll(() => calls.customer_push_subscribe.length).toBe(1);
    expect(calls.customer_push_subscribe[0].p_endpoint).toBe('https://fcm.googleapis.com/fcm/send/new-1');
    await expect.poll(() => calls.customer_push_unsubscribe.map((c) => c.p_endpoint)).toEqual([old]);
    expect(await win(page, '__asked')).toBe(0); // silent: no question on load
  });

  test('an unchanged subscription is confirmed to the server', async ({ page }) => {
    const ep = 'https://web.push.apple.com/same';
    const calls = await open(page, { perm: 'granted', sub: ep, mark: { id: 'c1', ep } });
    await expect.poll(() => calls.customer_push_subscribe.length).toBe(1);
    expect(calls.customer_push_subscribe[0].p_endpoint).toBe(ep);
    expect(await win(page, '__subs')).toBe(0);
    expect(calls.customer_push_unsubscribe).toHaveLength(0);
  });

  test('permission taken back in the browser: the server forgets this browser', async ({ page }) => {
    const ep = 'https://web.push.apple.com/gone';
    const calls = await open(page, { perm: 'denied', sub: ep, mark: { id: 'c1', ep } });
    await expect.poll(() => calls.customer_push_unsubscribe.map((c) => c.p_endpoint)).toEqual([ep]);
    expect(calls.customer_push_subscribe).toHaveLength(0);
    await expect.poll(() => page.evaluate(`localStorage.getItem('cq_push_ep')`)).toBeNull();
  });

  test('a browser another account turned push on in is left alone', async ({ page }) => {
    const ep = 'https://fcm.googleapis.com/fcm/send/theirs';
    const calls = await open(page, { perm: 'granted', sub: ep, mark: { id: 'c9', ep } });
    await page.waitForTimeout(400);
    expect(calls.customer_push_subscribe).toHaveLength(0);
    expect(calls.customer_push_unsubscribe).toHaveLength(0);
  });

  test('signing out stops this browser\'s notifications', async ({ page }) => {
    const ep = 'https://fcm.googleapis.com/fcm/send/mine';
    const calls = await open(page, { perm: 'granted', sub: ep, mark: { id: 'c1', ep } });
    await page.evaluate('doLogout(true)');
    await expect.poll(() => calls.customer_push_unsubscribe.map((c) => c.p_endpoint)).toEqual([ep]);
    await expect.poll(() => win(page, '__unsubs')).toBe(1);
  });
});

test.describe('@staff:security the sender speaks Declarative Web Push', () => {
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });

  /** A subscriber's key pair, and the way to read what was sent to it (RFC 8291, the receiving side). */
  async function subscriber() {
    const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const hkdf = async (salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) => {
      const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
      return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, n * 8));
    };
    const cat = (...a: Uint8Array<ArrayBuffer>[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
    const te = new TextEncoder();
    const read = async (body: Uint8Array<ArrayBuffer>) => {
      const salt = body.slice(0, 16), idLen = body[20], asPub = body.slice(21, 21 + idLen), ct = body.slice(21 + idLen);
      const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, keys.privateKey, 256));
      const ikm = await hkdf(authSecret, shared, cat(te.encode('WebPush: info\0'), pub, asPub), 32);
      const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
      const k = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, k, ct));
      return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2))));
    };
    return { p256dh: Buffer.from(pub).toString('base64url'), auth: Buffer.from(authSecret).toString('base64url'), read };
  }
  async function vapid() {
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    return {
      VAPID_PRIVATE_KEY: Buffer.from(await crypto.subtle.exportKey('pkcs8', k.privateKey)).toString('base64url'),
      VAPID_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('raw', k.publicKey)).toString('base64url'),
      SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test',
    };
  }

  test('the drain sends {web_push: 8030, notification} with an absolute navigate, the row\'s language and direction; 404 and 410 drop the address', async () => {
    const s = await subscriber();
    const env = await vapid();
    const outbox = [
      { id: 1, customer_id: 'c1', tag: 'rem-q1', title: 'رحلة غدًا', body: 'جولة السبت، التجمع 6:30 م', url: '/my-bookings', created_at: new Date().toISOString(), cat: 'rides', lang: 'ar' },
      { id: 2, customer_id: 'c2', tag: 'challenge-2099-02', title: 'Your new challenge is ready', body: 'Open Community to see this month\'s challenge', url: '/members?src=push', created_at: new Date().toISOString(), cat: 'community', lang: 'en' },
    ];
    const subs: Record<string, string[]> = { c1: ['https://web.push.apple.com/a1', 'https://fcm.googleapis.com/fcm/send/gone'], c2: ['https://fcm.googleapis.com/fcm/send/b2'] };
    const got: Record<string, unknown> = {};
    const deleted: string[] = [];
    let listUrl = '';
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('/rest/v1/push_outbox') && (!init || !init.method || init.method === 'GET')) { listUrl = url; return new Response(JSON.stringify(outbox)); }
      if (url.includes('/rest/v1/push_outbox') && init?.method === 'PATCH') return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
      if (url.includes('/rest/v1/push_subscriptions') && init?.method === 'DELETE') { deleted.push(decodeURIComponent(new URL(url).searchParams.get('endpoint')!.replace(/^eq\./, ''))); return new Response(null, { status: 204 }); }
      if (url.includes('/rest/v1/push_subscriptions')) {
        const who = new URL(url).searchParams.get('customer_id')!.replace('eq.', '');
        return new Response(JSON.stringify(subs[who].map((endpoint) => ({ endpoint, p256dh: s.p256dh, auth: s.auth }))));
      }
      if (url.endsWith('/gone')) return new Response('', { status: 410 });
      got[url] = await s.read(new Uint8Array(init!.body as ArrayBuffer));
      return new Response('', { status: 201 });
    }) as typeof fetch;
    const post = (await freshModule('functions/api/push-send.js')).onRequestPost as (c: { request: Request; env: Record<string, string> }) => Promise<Response>;
    const res = await post({ request: new Request('https://experiences.micromobility.sa/api/push-send', { method: 'POST', body: JSON.stringify({ drain: true }) }), env });
    expect(await res.json()).toMatchObject({ ok: true, drained: 2, sent: 2 });
    expect(listUrl).toContain('select=*'); // cat and lang come with the row
    expect(got['https://web.push.apple.com/a1']).toEqual({ web_push: 8030, notification: {
      title: 'رحلة غدًا', body: 'جولة السبت، التجمع 6:30 م', navigate: 'https://experiences.micromobility.sa/my-bookings', tag: 'rem-q1', lang: 'ar', dir: 'rtl' } });
    expect(got['https://fcm.googleapis.com/fcm/send/b2']).toMatchObject({ web_push: 8030, notification: {
      navigate: 'https://experiences.micromobility.sa/members?src=push', lang: 'en', dir: 'ltr' } });
    expect(deleted).toEqual(['https://fcm.googleapis.com/fcm/send/gone']);
  });

  test('a staff send carries the same shape; without a language, Urdu script still reads right to left', async () => {
    const s = await subscriber();
    const env = await vapid();
    const got: unknown[] = [];
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('/rpc/is_staff')) return new Response('true');
      if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: '0f8fad5b-d9cb-469f-a165-70867728950e' }));
      if (url.includes('/rest/v1/staff_actions') && init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': '*/0' } });
      if (url.includes('/rest/v1/staff_actions')) return new Response(null, { status: 201 });
      if (url.includes('/rest/v1/push_subscriptions')) return new Response(JSON.stringify([{ endpoint: 'https://web.push.apple.com/x', p256dh: s.p256dh, auth: s.auth }]));
      got.push(await s.read(new Uint8Array(init!.body as ArrayBuffer)));
      return new Response('', { status: 201 });
    }) as typeof fetch;
    const post = (await freshModule('functions/api/push-send.js')).onRequestPost as (c: { request: Request; env: Record<string, string> }) => Promise<Response>;
    const send = (extra: Record<string, unknown>) => post({ request: new Request('https://experiences.micromobility.sa/api/push-send', { method: 'POST',
      body: JSON.stringify({ staffToken: 'st', customerId: 'c1', title: 'A spot opened up', message: 'Booking #4', url: '/', tag: 'booking-q1', ...extra }) }), env });
    await send({ lang: 'en' });
    await send({ title: 'جگہ خالی ہو گئی', message: 'بکنگ #4' });
    expect(got[0]).toEqual({ web_push: 8030, notification: { title: 'A spot opened up', body: 'Booking #4', navigate: 'https://experiences.micromobility.sa/', tag: 'booking-q1', lang: 'en', dir: 'ltr' } });
    expect(got[1]).toMatchObject({ notification: { lang: 'ur', dir: 'rtl' } });
  });

  test('the service worker shows both shapes, and the tap leads to navigate', async () => {
    const src = readFileSync(resolve(__dirname, '../service-worker.js'), 'utf8');
    const on: Record<string, (e: unknown) => void> = {};
    const shown: { title: string; opts: Record<string, unknown> }[] = [];
    const self = { location: { hostname: 'experiences.micromobility.sa', origin: 'https://experiences.micromobility.sa', href: 'https://experiences.micromobility.sa/service-worker.js' },
      addEventListener: (k: string, f: (e: unknown) => void) => { on[k] = f; },
      registration: { showNotification: (title: string, opts: Record<string, unknown>) => { shown.push({ title, opts }); return Promise.resolve(); } } };
    new Function('self', 'caches', src)(self, {});
    const push = (d: unknown) => on.push({ data: { json: () => d }, waitUntil: () => {} });
    push({ web_push: 8030, notification: { title: 'Ride tomorrow', body: 'Saturday Social Ride, meet at 6:30 PM', navigate: 'https://experiences.micromobility.sa/my-bookings', tag: 'rem-q1', lang: 'en', dir: 'ltr' } });
    push({ title: 'A spot opened up', body: 'Booking #4', url: '/', tag: 'booking-q1' });
    push(null);
    expect(shown[0]).toMatchObject({ title: 'Ride tomorrow', opts: { body: 'Saturday Social Ride, meet at 6:30 PM', tag: 'rem-q1', data: { url: 'https://experiences.micromobility.sa/my-bookings' }, lang: 'en', dir: 'ltr' } });
    expect(shown[1]).toMatchObject({ title: 'A spot opened up', opts: { body: 'Booking #4', tag: 'booking-q1', data: { url: '/' } } });
    expect(shown[2].title).toBe('MicroMobility'); // never a push that shows nothing
  });
});

test.describe('@staff:security the Apple pass on iOS 18 and at the meeting point on the map', () => {
  const FIX = resolve(__dirname, 'fixtures', 'wallet');
  const p12b64 = readFileSync(resolve(FIX, 'test-pass.p12')).toString('base64');
  const wwdrDer = new Uint8Array(readFileSync(resolve(FIX, 'test-ca.der')));
  const booking = { id: 'abcdef123456', session_id: 's1', session_date: '2026-09-23', session_day: 'Wednesday', queue_num: 7, name: 'Rider', status: 'waiting', approval: null as string | null, price: 50 };
  const circuit = { id: 's1', event_kind: 'rental', ride_kind: null as string | null, bike_slots: JSON.stringify({ _time: '21:00 - 23:00' }), meet_url: null as string | null, needs_approval: false, hide_queue: false };
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });
  async function pass(sess: Record<string, unknown>) {
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes('/rpc/my_bookings')) return new Response(JSON.stringify([booking]));
      if (url.includes('/rpc/list_sessions')) return new Response(JSON.stringify([sess]));
      if (url.includes('apple.com')) return new Response(wwdrDer);
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const post = (await freshModule('functions/api/wallet-pass.js')).onRequestPost as (c: { request: Request; env: Record<string, string> }) => Promise<Response>;
    const res = await post({
      request: new Request('https://site.test/api/wallet-pass', { method: 'POST', body: JSON.stringify({ customerId: 'c1', token: 't', bookingId: booking.id }) }),
      env: { APPLE_PASS_P12_BASE64: p12b64, APPLE_PASS_P12_PASSWORD: 'secret123', APPLE_PASS_TYPE_ID: 'pass.test', APPLE_TEAM_ID: 'TEAM', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' },
    });
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.pkpass');
    return JSON.parse(strFromU8(unzipSync(new Uint8Array(await res.arrayBuffer()))['pass.json']));
  }

  test('relevantDates runs from the bike collection to the end, beside the old relevantDate', async () => {
    const j = await pass(circuit);
    expect(j.relevantDate).toBe('2026-09-23T20:15:00+03:00'); // older iOS
    expect(j.relevantDates).toEqual([{ startDate: '2026-09-23T20:15:00+03:00', endDate: '2026-09-23T23:00:00+03:00' }]);
    expect(j.expirationDate).toBe('2026-09-23T23:00:00+03:00');
  });

  test('a ride that gathers: from the gathering time; past midnight, to the next day', async () => {
    const sat = { ...circuit, event_kind: 'community', ride_kind: 'saturday', needs_approval: false, bike_slots: JSON.stringify({ _time: '18:30 - 19:00' }) };
    const j = await pass(sat);
    expect(j.relevantDates[0].startDate).toBe(j.relevantDate);
    expect(Date.parse(j.relevantDates[0].endDate)).toBeGreaterThan(Date.parse(j.relevantDates[0].startDate));
    const late = await pass({ ...circuit, bike_slots: JSON.stringify({ _time: '21:00 - 00:30' }) });
    expect(late.relevantDates).toEqual([{ startDate: '2026-09-23T20:15:00+03:00', endDate: '2026-09-24T00:30:00+03:00' }]);
  });

  test('the meeting point staff put on the map is the pass\'s place, named on the Lock Screen', async () => {
    const pool = { ...circuit, event_kind: 'community', ride_kind: 'swim', needs_approval: false };
    const j = await pass({ ...pool, meet_url: 'https://maps.app.goo.gl/abc123', meet_lat: 21.5433, meet_lng: 39.1728, meet_name: 'Al Hamra pool gate', meet_name_ar: 'بوابة مسبح الحمراء' });
    expect(j.locations).toEqual([{ latitude: 21.5433, longitude: 39.1728, relevantText: 'Al Hamra pool gate' }]);
    expect(j.semantics.venueLocation).toEqual({ latitude: 21.5433, longitude: 39.1728 });
    // over the circuit's own point too, and without a name the old words
    const c = await pass({ ...circuit, meet_lat: 21.61, meet_lng: 39.105 });
    expect(c.locations).toEqual([{ latitude: 21.61, longitude: 39.105, relevantText: 'Your ride\'s meeting point is nearby' }]);
    // half a point, or none, is read as before
    const half = await pass({ ...circuit, meet_lat: 21.61, meet_lng: null });
    expect(half.locations[0]).toMatchObject({ latitude: 21.6266, longitude: 39.1099 });
  });
});
