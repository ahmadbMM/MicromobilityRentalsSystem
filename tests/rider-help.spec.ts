import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Help on the ride and Account > Help (the user, 2026-11-16: "do 1 5" of the booking app's new sections).
// 1. A booking that holds a place has "Need help?" on its ticket from an hour before the session's first time until 3
//    hours after its last. It opens a centred pop-up drawn by the page (not a lazy file, so it opens with no signal): what
//    is wrong, WhatsApp us on the business line with a message naming the rider, the session and the rider's location,
//    Call us, and the ambulance. Nothing is stored.
// 2. Account > Help (/account/help, rider-help.js): the answers staff keep under Website > Help > "Rides & bookings"
//    (site_content help.topics.rides), else the file's own; a message to the team through site_message_send (kind help,
//    topic app), which staff read in Messages; WhatsApp us and Call us. All Supabase traffic is stubbed.

const DAY = '2099-02-01'; // a circuit night, 18:00 - 20:00 in Riyadh
const night = { id: DAY, day: 'Sunday', session_date: DAY, capacity: 20, status: 'open', created_at: 1, location: 'JCC', bike_slots: '{"_time":"18:00 - 20:00","_total":20}' };
const YG = '2099-02-01-yg'; // a yoga date the same evening: no bike anywhere
const yoga = {
  id: YG, session_date: DAY, day: 'Sunday', status: 'open', capacity: 15, created_at: 1, event_kind: 'community', ride_kind: 'yoga', needs_approval: false,
  hide_queue: true, spots: 15, open_to_all: false, paid_ride: false, location: 'SILKDEER', bike_slots: '{"_time":"18:00 - 19:30"}',
};
const bk = (o: Record<string, unknown> = {}) => ({
  id: 'q1', session_id: DAY, session_date: DAY, session_day: 'Sunday', name: 'Spec Rider', customer_id: 'c1', queue_num: 7, status: 'waiting', paid: true, price: 75,
  type_preference: 'Hybrid', registered_at: '2099-01-01T10:00:00Z', ...o,
});
const J = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

async function rider(page: Page, rows: Record<string, unknown>[], at: string, fx: Fixtures = {}) {
  await page.clock.setFixedTime(new Date(at));
  await stubSupabase(page, { sessions: [night, yoga], 'rpc:list_sessions': [night, yoga], bikes: [], customers: [], queue_entries: rows, 'rpc:my_bookings': rows, ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('myrides')`);
  await expect(page.locator('#tab-myrides .ticket-card').first()).toBeVisible();
}
const btn = (page: Page) => page.locator('#tab-myrides .ticket-card .rh-btn');
const dlg = (page: Page) => page.locator('#rh-modal [role="dialog"]');
const repaint = (page: Page, at: string) => page.clock.setFixedTime(new Date(at)).then(() => page.evaluate(`renderMyRides()`));
const waText = async (page: Page) => {
  const href = (await dlg(page).locator('.rh-wa').getAttribute('href')) || '';
  expect(href.startsWith('https://wa.me/966566668818?text=')).toBe(true);
  return decodeURIComponent(href.split('?text=')[1]);
};

test.describe('@customer:bookings Help on the ride', () => {
  test('the button shows from an hour before the session until 3 hours after it, on a place held, never on a waitlist', async ({ page }) => {
    await rider(page, [bk()], '2099-02-01T16:59:00+03:00');
    await expect(btn(page)).toHaveCount(0); // a minute before an hour before 18:00
    await repaint(page, '2099-02-01T17:00:00+03:00');
    await expect(btn(page)).toHaveCount(1);
    await expect(btn(page)).toHaveText('Need help?');
    // checked in, back from the ride: still there, until 3 hours after 20:00
    await page.evaluate(`Object.assign(S.queue.find(e=>e.id==='q1'),{status:'done'});renderMyRides()`);
    await repaint(page, '2099-02-01T22:59:00+03:00');
    await expect(btn(page)).toHaveCount(1);
    await repaint(page, '2099-02-01T23:00:00+03:00');
    await expect(page.locator('#tab-myrides .ticket-card').first()).toBeVisible();
    await expect(btn(page)).toHaveCount(0);
    // a waitlisted place or a cancelled one has none
    await repaint(page, '2099-02-01T18:30:00+03:00');
    await page.evaluate(`S.queue.find(e=>e.id==='q1').status='waitlist';renderMyRides()`);
    await expect(btn(page)).toHaveCount(0);
  });

  test('the pop-up is centred and builds the WhatsApp message from the choice, the rider, the session and the location', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 21.5432109, longitude: 39.1728765 });
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('rider-help.js')) asked.push(r.url()); });
    await rider(page, [bk({ status: 'active' })], '2099-02-01T18:30:00+03:00');
    await btn(page).click();
    await expect(dlg(page)).toBeVisible();
    expect(asked).toHaveLength(0); // drawn by the page: nothing to fetch, so it opens with no signal
    await expect(dlg(page).locator('#rh-title')).toHaveText('Need help?');
    await expect(dlg(page).locator('.brp-opt')).toHaveText(["I can't find the group", "I'm hurt or unwell", 'My bike broke down', 'Something else']);
    await expect(dlg(page).locator('input[name="rh-k"]:checked')).toHaveCount(0);
    const box = (await dlg(page).boundingBox())!, vp = page.viewportSize()!;
    expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - vp.height / 2)).toBeLessThan(2);
    // the phone's location lands in the message, and a pin says so on the button
    await expect(dlg(page).locator('#rh-loc')).toBeVisible();
    let text = await waText(page);
    expect(text.split('\n')[0]).toBe('I need help.');
    expect(text.split('\n')[1]).toMatch(/^Spec Rider · .+ · .+/);
    expect(text.split('\n')[2]).toBe('My location: https://maps.google.com/?q=21.54321,39.17288');
    await dlg(page).locator('.brp-opt', { hasText: "can't find" }).locator('input').check();
    text = await waText(page);
    expect(text.split('\n')[0]).toBe("I can't find the group.");
    await dlg(page).locator('.brp-opt', { hasText: 'hurt' }).locator('input').check();
    expect((await waText(page)).split('\n')[0]).toBe("I'm hurt or unwell.");
    await expect(dlg(page).locator('.rh-wa')).toHaveAttribute('target', '_blank');
    await expect(dlg(page).locator('.rh-call')).toHaveAttribute('href', 'tel:+966566668818');
    await expect(dlg(page).locator('.rh-amb')).toHaveAttribute('href', 'tel:997');
    await expect(dlg(page).locator('.rh-amb')).toHaveText('Ambulance 997');
    if (process.env.SHOT_DIR) await page.locator('#rh-modal .modal-backdrop').screenshot({ path: `${process.env.SHOT_DIR}/rh-popup-${test.info().project.name}.png` });
    // Close and Escape close it; nothing was written anywhere
    await dlg(page).locator('.rh-close').click();
    await expect(dlg(page)).toHaveCount(0);
    await btn(page).click();
    await page.keyboard.press('Escape');
    await expect(dlg(page)).toHaveCount(0);
  });

  test('no location given: the message goes without one and no pin shows', async ({ page }) => {
    await rider(page, [bk()], '2099-02-01T18:30:00+03:00');
    await page.evaluate(`navigator.geolocation.getCurrentPosition=(ok,no)=>no({code:1})`);
    await btn(page).click();
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page).locator('#rh-loc')).toBeHidden();
    const text = await waText(page);
    expect(text.split('\n')).toHaveLength(2);
  });

  test('a session without bikes has no bike choice, and a blood donation no button', async ({ page }) => {
    await rider(page, [bk({ id: 'q5', session_id: YG })], '2099-02-01T18:10:00+03:00');
    await btn(page).click();
    await expect(dlg(page).locator('.brp-opt')).toHaveText(["I can't find the group", "I'm hurt or unwell", 'Something else']);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(`_rhRows({id:'x',session_date:'2099-02-01',ride_kind:'blood',event_kind:'community',bike_slots:'{"_time":"18:00 - 20:00"}'},[{status:'waiting'}]).length`)).toBe(0);
  });

  test('its words are in all ten languages, and in Arabic the message is in Arabic', async ({ page }) => {
    await rider(page, [bk()], '2099-02-01T18:30:00+03:00');
    await page.evaluate(`navigator.geolocation.getCurrentPosition=(ok,no)=>no({code:1})`);
    await page.evaluate(`setLang('ar')`);
    await expect(btn(page)).toHaveText('تحتاج مساعدة؟');
    await btn(page).click();
    await expect(dlg(page).locator('.brp-opt').first()).toHaveText('لا أجد المجموعة');
    expect(await dlg(page).evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    await dlg(page).locator('.brp-opt').first().locator('input').check();
    expect((await waText(page)).split('\n')[0]).toBe('لا أجد المجموعة.');
    await page.keyboard.press('Escape');
    // a language the team does not read: the page in French, the message in English
    await page.evaluate(`setLang('fr')`);
    await expect(btn(page)).toHaveText("Besoin d'aide ?");
    await btn(page).click();
    await dlg(page).locator('.brp-opt').nth(1).locator('input').check();
    expect((await waText(page)).split('\n')[0]).toBe("I'm hurt or unwell.");
  });
});

// ── Account > Help ──────────────────────────────────────────────────────────
async function help(page: Page, fx: Fixtures = {}, cust: Record<string, unknown> = {}) {
  const asked: string[] = [];
  page.on('request', (r) => { if (r.url().includes('rider-help.js')) asked.push(r.url()); });
  await stubSupabase(page, { sessions: [], queue_entries: [], 'rpc:my_bookings': [], ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', ...cust });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await page.locator('#acc-r-help').click();
  await expect(page.locator('#acc-pg-help')).toBeVisible();
  await expect(page.locator('#rh-help .rh-q').first()).toBeVisible();
  return asked;
}
type Msg = { p?: Record<string, unknown> };
async function answer(page: Page, reply: Record<string, unknown>) {
  const calls: Msg[] = [];
  await page.route('**/rest/v1/rpc/site_message_send*', async (r) => {
    calls.push((r.request().postDataJSON() || {}) as Msg);
    await r.fulfill({ status: 200, headers: J, body: JSON.stringify(reply) });
  });
  return calls;
}

test.describe('@customer:account Help', () => {
  test('a Help row in Settings opens /account/help: the answers, a message, WhatsApp and Call', async ({ page }) => {
    const asked = await help(page);
    // the row sits above Tech support, with the page's own title
    const rows = page.locator('#tab-account .acc-grp').filter({ has: page.locator('#acc-r-help') }).locator('.acc-row');
    const ids = await rows.evaluateAll((els) => els.map((e) => e.id));
    expect(ids.indexOf('acc-r-help')).toBe(ids.indexOf('acc-help-row') - 1);
    await expect(page.locator('#acc-r-help .acc-row-t')).toHaveText('Help');
    await expect(page.locator('#acc-pg-help-h')).toHaveText('Help');
    await expect(page).toHaveURL(/\/account\/help$/);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\/rider-help\.js\?v=[0-9a-f]{10}$/);
    // the file's own answers while staff have saved none
    await expect(page.locator('#rh-help .rh-q summary')).toHaveText(['How do I book?', 'Can I cancel my booking?', 'Where do we meet?', 'Do I need my own helmet?', 'What if I need help during a ride?', 'I left something behind.']);
    await expect(page.locator('#rh-help .rh-q p').first()).toBeHidden();
    await page.locator('#rh-help .rh-q summary').nth(3).click();
    await expect(page.locator('#rh-help .rh-q p').nth(3)).toHaveText('No. Helmets are required. One comes with every bike.');
    await expect(page.locator('#rh-help .rh-talk-wa')).toHaveAttribute('href', 'https://wa.me/966566668818');
    await expect(page.locator('#rh-help .rh-talk-call')).toHaveAttribute('href', 'tel:+966566668818');
    await expect(page.locator('#rh-help').getByLabel('Your message')).toHaveCSS('font-size', '16px');
    if (process.env.SHOT_DIR) await page.locator('#acc-pg-help').screenshot({ path: `${process.env.SHOT_DIR}/rh-page-${test.info().project.name}.png` });
    // the address opens it too
    await page.goto('/account/help');
    await waitForSb(page);
    await expect(page.locator('#acc-pg-help')).toBeVisible();
    await expect(page.locator('#rh-help .rh-q')).toHaveCount(6);
  });

  test("staff's saved answers win; another language keeps the file's translation of an answer left as shipped", async ({ page }) => {
    const saved = [
      { q: { en: 'Can I bring a friend?', ar: 'هل أحضر صديقاً؟' }, a: { en: 'Yes, book a place for them too.', ar: 'نعم، احجز له مكاناً أيضاً.' } },
      { q: { en: 'How do I book?', ar: 'كيف أحجز؟' }, a: { en: 'Choose an experience and a date, add who is coming and confirm. Your booking then shows under Bookings.', ar: 'اختر التجربة والتاريخ، وأضف من سيحضر، ثم أكّد. سيظهر حجزك بعدها في «الحجوزات».' } },
      { q: { en: '', ar: '' }, a: { en: 'An answer with no question is left out.', ar: '' } },
    ];
    await help(page, { site_content: [{ key: 'help.topics.rides', value: saved }] });
    await expect(page.locator('#rh-help .rh-q summary')).toHaveText(['Can I bring a friend?', 'How do I book?']);
    await page.evaluate(`setLang('ar');_rhPage()`);
    await expect(page.locator('#rh-help .rh-q summary')).toHaveText(['هل أحضر صديقاً؟', 'كيف أحجز؟']);
    await page.evaluate(`setLang('fr');_rhPage()`);
    await expect(page.locator('#rh-help .rh-q summary')).toHaveText(['Can I bring a friend?', 'Comment réserver ?']);
  });

  test('a message goes to the team with the account linked, and the page shows its reference', async ({ page }) => {
    await help(page);
    const calls = await answer(page, { ok: true, id: 42, ref: 'M-0042' });
    const box = page.locator('#rh-help').getByLabel('Your message');
    await page.locator('#rh-help .rh-send').click();
    await expect(page.locator('#rh-err')).toHaveText('Write your message first.');
    expect(calls).toHaveLength(0);
    await box.fill('  I left my water bottle at the circuit on Sunday.  ');
    await expect(page.locator('#rh-err')).toHaveText('');
    await page.locator('#rh-help .rh-send').click();
    await expect(page.locator('#rh-sent')).toContainText('Message sent');
    await expect(page.locator('#rh-sent .rh-ref')).toHaveText('M-0042');
    expect(calls).toEqual([{ p: { kind: 'help', topic: 'app', name: 'Spec Rider', phone: '+966500000001', email: 'spec@example.com', message: 'I left my water bottle at the circuit on Sunday.', lang: 'en', customer_id: 'c1', token: 'tok-spec' } }]);
    await expect(page.locator('#toast-container .toast:not(.quiet)')).toHaveCount(0); // no bar after it
    await page.locator('#rh-help .rh-again').click();
    await expect(page.locator('#rh-help').getByLabel('Your message')).toHaveValue('');
    await expect(page.locator('#rh-help').getByLabel('Your message')).toBeFocused();
  });

  test('a refusal stays on the page with its words, and what was typed is kept', async ({ page }) => {
    await help(page);
    await answer(page, { ok: false, error: 'throttled' });
    await page.locator('#rh-help').getByLabel('Your message').fill('Hello');
    await page.locator('#rh-help .rh-send').click();
    await expect(page.locator('#rh-err')).toHaveText('Too many messages. Please try again in a few minutes.');
    await expect(page.locator('#rh-help .rh-send')).toBeEnabled();
    // the account page drawn again (a fresh profile read) keeps the text
    await page.evaluate(`renderAccount()`);
    await expect(page.locator('#rh-help').getByLabel('Your message')).toHaveValue('Hello');
  });

  test('an account with no phone or email is told to add one, and nothing is sent', async ({ page }) => {
    await help(page, {}, { phone: '', email: '' });
    const calls = await answer(page, { ok: true, ref: 'M-0001' });
    await page.locator('#rh-help').getByLabel('Your message').fill('Hello');
    await page.locator('#rh-help .rh-send').click();
    await expect(page.locator('#rh-err')).toHaveText('Add a phone number or email under Contact first.');
    expect(calls).toHaveLength(0);
  });

  test('its words and answers are in all ten languages, with Latin digits and no emoji', async ({ page }) => {
    await help(page);
    const ok = await page.evaluate(`RH_LANGS.length===10&&Object.values(RH_T).every(r=>r.length===10&&r.every(x=>typeof x==='string'&&x.trim()))&&RH_QA.length===6&&RH_QA.every(x=>[x.q,x.a].every(r=>r.length===10&&r.every(y=>typeof y==='string'&&y.trim())))`);
    expect(ok).toBe(true);
    const all = `[...Object.values(RH_T).flat(),...RH_QA.flatMap(x=>[...x.q,...x.a])]`;
    expect(await page.evaluate(`${all}.every(x=>!/[\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F\\u09E6-\\u09EF]/.test(x)&&!/\\p{Extended_Pictographic}/u.test(x))`)).toBe(true);
    // no "bring your own" helmet anywhere
    expect(await page.evaluate(`${all}.some(x=>/bring your own/i.test(x))`)).toBe(false);
    await page.evaluate(`setLang('ar')`);
    await expect(page.locator('#acc-pg-help-h')).toHaveText('المساعدة');
    await expect(page.locator('#rh-help .rh-q summary').first()).toHaveText('كيف أحجز؟');
    await expect(page.locator('#rh-help .rh-send')).toHaveText('أرسل الرسالة');
  });
});

// ── Staff: where a message came from ─────────────────────────────────────────
test.describe('@staff:messages Help topics', () => {
  test('a message from the booking app and one from the website\'s Rides tab are named in Messages', async ({ page }) => {
    const m = (o: Record<string, unknown>) => ({
      id: 7, created_at: '2099-05-01T09:30:00Z', kind: 'help', topic: 'app', name: 'Spec Rider', company: null, email: 'spec@example.com', phone: '+966500000001',
      message: 'I left my water bottle.', lang: 'en', customer_id: 'c1', status: 'new', staff_notes: null, updated_at: '2099-05-01T09:30:00Z', updated_by: 'website', ...o,
    });
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], staff_options: [], site_messages: [m({}), m({ id: 8, topic: 'rides' })] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('messages')`);
    await expect.poll(() => page.evaluate(`typeof _smTopic==='function'?[_smTopic({kind:'help',topic:'app'}),_smTopic({kind:'help',topic:'rides'})].join('|'):''`)).toBe('Booking app|Rides & bookings');
  });
});
