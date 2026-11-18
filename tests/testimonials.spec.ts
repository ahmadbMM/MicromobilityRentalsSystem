import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, rateGateOn, type Fixtures } from './helpers/supabase';

// Testimonials (the user, 2026-11-18: "Create a testimonials page but don't make it visible, People write their
// testimonials on our services & community rides. Then we publish them in a testimonials page"; migration 20261119120000).
// Riders: Account > Write a testimonial (/account/testimonial, rider-testimonial.js), working by its address whatever the
// switch says; the Account row only while site_content testimonials.on is true; after a rating of 9 or 10 the same
// pop-up offers to share it; once, an old comment is asked about. Staff: the section Testimonials (/testimonials) under
// People. Every function is stubbed here as the migration answers it.

const J = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const ON = { key: 'testimonials.on', value: true };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
type Row = Record<string, unknown>;
type Call = { fn: string; body: Row };

// ── The rider's functions, as an account's database answers them ───────────────────────────────────────────────────
type RiderDb = { mine: Row & { items: Row[] }; send?: Row; old?: Row; calls: Call[] };
const mine = (o: Row = {}) => ({ ok: true, on: true, names: { full: 'Sara Ahmed Ali', short: 'Sara A.' }, since: { year: 2025, rides: 12 }, items: [] as Row[], ask: null, ...o });
async function riderDb(page: Page, db: RiderDb) {
  await page.route(/\/rest\/v1\/rpc\/(testimonial_mine|testimonial_send|testimonial_delete|testimonial_old_answer)\b/, async (route) => {
    const fn = /rpc\/(\w+)/.exec(route.request().url())![1];
    let body: Row = {};
    try { body = route.request().postDataJSON() as Row; } catch { /* no body */ }
    db.calls.push({ fn, body });
    let out: unknown;
    if (fn === 'testimonial_mine') out = db.mine;
    else if (fn === 'testimonial_send') {
      const names = db.mine.names as Row, name = body.p_name_mode === 'anon' ? null : names[String(body.p_name_mode)];
      out = db.send ?? { ok: true, id: 501, status: 'pending', body: String(body.p_body).trim(), display_name: name };
      if ((out as Row).ok === true) db.mine.items = [{ id: 501, about: body.p_about, stars: body.p_stars, body: body.p_body, name_mode: body.p_name_mode, display_name: name, status: 'pending', photo: !!body.p_photo, source: body.p_source, entry_id: body.p_entry, created_at: '2099-01-10T10:00:00Z' }, ...db.mine.items];
    } else if (fn === 'testimonial_delete') { db.mine.items = db.mine.items.filter((x) => x.id !== body.p_tid); out = { ok: true }; }
    else { out = db.old ?? { ok: true, id: body.p_yes ? 777 : null }; if ((out as Row).ok === true) db.mine.ask = null; }
    return route.fulfill({ status: 200, headers: J, body: JSON.stringify(out) });
  });
}
const calls = (db: RiderDb, fn: string) => db.calls.filter((c) => c.fn === fn);
async function rider(page: Page, db: RiderDb, fx: Fixtures = {}, path = '/') {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [], ...fx });
  await riderDb(page, db);
  await loginCustomer(page, { id: 'c1', name: 'Sara Ahmed Ali' });
  await page.goto(path);
  await waitForSb(page);
}
const pg = (page: Page) => page.locator('#tst-page');
async function openPage(page: Page) {
  await page.evaluate(`setCustTab('account','testimonial')`);
  await expect(pg(page).locator('.tst-send')).toBeVisible();
}

test.describe('@customer:testimonials the rider', () => {
  test('the Account row shows only while the switch is on; the page opens by its own address either way', async ({ page }) => {
    const db: RiderDb = { mine: mine({ on: false }), calls: [] };
    await rider(page, db, { site_content: [{ key: 'testimonials.on', value: false }] });
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#acc-r-personal')).toBeVisible();
    await expect(page.locator('#acc-r-testimonial')).toBeHidden();
    expect(await page.evaluate(`S._tstOn`)).toBe(false);
    expect(calls(db, 'testimonial_mine')).toHaveLength(0); // off: nothing asked on its own
    // the address works while it is off
    await page.goto('/account/testimonial');
    await waitForSb(page);
    await expect(pg(page).locator('.tst-send')).toBeVisible();
    await expect(page.locator('#acc-pg-testimonial-h')).toHaveText('Write a testimonial');
    expect(new URL(page.url()).pathname).toBe('/account/testimonial');
  });

  test('switch on: the row opens the page; the switch rides in the boot read, no request of its own', async ({ page }) => {
    const db: RiderDb = { mine: mine(), calls: [] };
    const reads: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/site_content')) reads.push(decodeURIComponent(r.url())); });
    await rider(page, db, { site_content: [ON] });
    await expect.poll(() => page.evaluate(`S._tstOn`)).toBe(true);
    expect(reads.filter((u) => u.includes('testimonials.on'))).toHaveLength(1);
    expect(reads.find((u) => u.includes('testimonials.on'))).toContain('biz.public'); // one read with the business settings
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#acc-r-testimonial')).toBeVisible();
    await expect(page.locator('#acc-r-testimonial .acc-row-t')).toHaveText('Write a testimonial');
    await expect(page.locator('#acc-g-activity')).toBeVisible();
    await page.locator('#acc-r-testimonial').click();
    await expect(pg(page).locator('.tst-send')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/account/testimonial');
  });

  test('the form checks what is missing, sends with the name as chosen, lists it waiting, and Delete asks a second tap', async ({ page }) => {
    const db: RiderDb = { mine: mine(), calls: [] };
    await rider(page, db);
    await openPage(page);
    const p = pg(page), err = p.locator('.tst-err');
    await p.locator('.tst-send').click();
    await expect(err).toHaveText('Pick what it is about.');
    await p.locator('.tst-pill[data-ab="session"]').click();
    await expect(err).toHaveCount(0);
    await expect(p.locator('.tst-pill[data-ab="session"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(p.locator('.tst-pill')).toHaveText(['Saturday community ride', 'Session or rental', 'Learn to ride', 'Event', 'Workshop or store', 'Something else']);
    await p.locator('.tst-send').click();
    await expect(err).toHaveText('Pick from 1 to 5 stars.');
    await p.locator('.tst-sb[data-n="4"]').click();
    await expect(p.locator('.tst-sb[aria-checked="true"]')).toHaveAttribute('data-n', '4');
    await expect(p.locator('.tst-sb .tst-star.on')).toHaveCount(4); // drawn, never a glyph
    await p.locator('#tst-w-f').fill('Too short');
    await expect(p.locator('#tst-n-f')).toHaveText('9 / 800');
    await p.locator('.tst-send').click();
    await expect(err).toHaveText('Write between 20 and 800 characters.');
    const words = 'The circuit night was so well run, thank you all!';
    await p.locator('#tst-w-f').fill(words);
    await expect(p.locator('#tst-n-f')).toHaveText(`${words.length} / 800`);
    // the names exactly as the database will write them, the short one first chosen, the since line beside a name
    await expect(p.locator('.tst-nm')).toHaveText(['Sara Ahmed Ali', 'Sara A.', 'Anonymous']);
    await expect(p.locator('input[name="tst-nm-f"]:checked')).toHaveValue('short');
    await expect(p.locator('#tst-shows-f')).toHaveText(/Sara A\.\s*Rider since 2025 · 12 rides/);
    await p.locator('input[name="tst-nm-f"][value="anon"]').check();
    await expect(p.locator('#tst-shows-f')).toHaveText('A MicroMobility rider'); // no since line without a name
    await p.locator('input[name="tst-nm-f"][value="full"]').check();
    await expect(p.locator('#tst-shows-f')).toHaveText(/Sara Ahmed Ali\s*Rider since 2025 · 12 rides/);
    await p.locator('.tst-send').click();
    await expect(err).toHaveText('Tick the box so MicroMobility may publish it.');
    expect(calls(db, 'testimonial_send')).toHaveLength(0);
    await expect(p.locator('#tst-ok-f')).toHaveAttribute('aria-required', 'true');
    await expect(p.locator('#tst-ok-f')).toContainText('MicroMobility may publish this testimonial on its website');
    await p.locator('#tst-ok-f').click();
    await expect(p.locator('#tst-ok-f')).toHaveAttribute('aria-checked', 'true');
    await p.locator('.tst-send').click();
    await expect(p.locator('#tst-sent')).toHaveText('Thank you. Our team will review it soon.');
    const sent = calls(db, 'testimonial_send');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_body: words, p_stars: 4, p_about: 'session', p_name_mode: 'full', p_consent: true, p_photo: null, p_source: 'app', p_entry: null, p_lang: 'en' });
    // the list: the new one, waiting, with its words as written
    const item = p.locator('.tst-item');
    await expect(item).toHaveCount(1);
    await expect(item.locator('.tst-st')).toHaveText('Waiting for review');
    await expect(item.locator('.tst-body')).toHaveText(words);
    await expect(item.locator('.tst-body')).toHaveAttribute('dir', 'auto');
    await expect(item.locator('.tst-stars')).toHaveAttribute('aria-label', '4 out of 5 stars');
    await expect(item.locator('.tst-item-m')).toContainText('Session or rental · Sara Ahmed Ali');
    // Write another: an empty form
    await p.locator('.tst-again').click();
    await expect(p.locator('#tst-w-f')).toHaveValue('');
    await expect(p.locator('#tst-ok-f')).toHaveAttribute('aria-checked', 'false');
    // Delete: the first tap arms it, the second deletes
    await item.locator('.tst-del').click();
    await expect(item.locator('.tst-del')).toHaveText('Tap again to delete');
    expect(calls(db, 'testimonial_delete')).toHaveLength(0);
    await item.locator('.tst-del').click();
    await expect(p.locator('.tst-item')).toHaveCount(0);
    expect(calls(db, 'testimonial_delete')[0].body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_tid: 501 });
  });

  test('every refusal the database gives is said in the rider\'s words; the states read Waiting, Published and Not published', async ({ page }) => {
    const db: RiderDb = { mine: mine({ items: [
      { id: 1, about: 'saturday', stars: 5, body: 'Lovely Saturday ride with friends and coffee', name_mode: 'short', display_name: 'Sara A.', status: 'published', photo: true, source: 'web', created_at: '2099-01-01T10:00:00Z' },
      { id: 2, about: 'event', stars: 3, body: 'It was fine but the queue was long at the start', name_mode: 'anon', display_name: null, status: 'rejected', photo: false, source: 'app', created_at: '2099-01-02T10:00:00Z' },
      { id: 3, about: 'learn', stars: 4, body: 'Learnt to ride in two lessons, great teachers', name_mode: 'full', display_name: 'Sara Ahmed Ali', status: 'hidden', photo: false, source: 'rating', created_at: '2099-01-03T10:00:00Z' },
    ] }), calls: [] };
    await rider(page, db);
    await openPage(page);
    const p = pg(page);
    await expect(p.locator('.tst-item .tst-st')).toHaveText(['Published', 'Not published', 'Not published']);
    await expect(p.locator('.tst-item').nth(1).locator('.tst-item-m')).toContainText('Event · Anonymous');
    await p.locator('.tst-pill[data-ab="other"]').click();
    await p.locator('.tst-sb[data-n="5"]').click();
    await p.locator('#tst-w-f').fill('Twenty characters at the very least here');
    await p.locator('#tst-ok-f').click();
    const said: Record<string, string> = {
      link: 'Please leave out links.', limit: 'Three of yours are waiting for review. Please wait until our team has read them.',
      throttled: 'You have sent five today. Please try again tomorrow.', name: 'Your account has no name for this choice. Pick another one.',
      photo: 'This photo cannot be used. Try another one.', body: 'Write between 20 and 800 characters.', signin: 'Please sign in again.',
      consent: 'Tick the box so MicroMobility may publish it.', invalid: 'We could not send it. Please try again.',
    };
    for (const [code, words] of Object.entries(said)) {
      db.send = { ok: false, error: code };
      await p.locator('.tst-send').click();
      await expect(p.locator('.tst-err')).toHaveText(words);
    }
    expect(calls(db, 'testimonial_send')).toHaveLength(Object.keys(said).length);
    await expect(p.locator('#tst-w-f')).toHaveValue('Twenty characters at the very least here'); // a refusal keeps what was written
  });

  test('a photo is made small on the phone and sent as a JPEG data: URL under 600,000 bytes; Remove photo takes it off', async ({ page }) => {
    const db: RiderDb = { mine: mine({ names: { full: 'Sara', short: 'Sara' } }), calls: [] };
    await rider(page, db);
    await openPage(page);
    const p = pg(page);
    await expect(p.locator('.tst-nm')).toHaveText(['Sara', 'Anonymous']); // one name word: offered once
    await p.locator('#tst-file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await expect(p.locator('.tst-thumb')).toBeVisible();
    await p.locator('.tst-ph-drop').click();
    await expect(p.locator('.tst-thumb')).toHaveCount(0);
    await p.locator('#tst-file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await expect(p.locator('.tst-thumb')).toBeVisible();
    await p.locator('.tst-pill[data-ab="workshop"]').click();
    await p.locator('.tst-sb[data-n="5"]').click();
    await p.locator('#tst-w-f').fill('The workshop fixed my brakes in no time at all.');
    await p.locator('#tst-ok-f').click();
    await p.locator('.tst-send').click();
    await expect(p.locator('#tst-sent')).toBeVisible();
    const b = calls(db, 'testimonial_send')[0].body;
    expect(String(b.p_photo)).toMatch(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/);
    expect(String(b.p_photo).length).toBeLessThanOrEqual(600000);
    expect(b.p_name_mode).toBe('full');
  });

  test('Arabic words go as Arabic, and the page reads in Arabic right to left', async ({ page }) => {
    const db: RiderDb = { mine: mine(), calls: [] };
    await rider(page, db);
    await page.evaluate(`setLang('ar')`);
    await openPage(page);
    const p = pg(page);
    await expect(p.locator('.tst-pill').first()).toHaveText('جولة السبت المجتمعية');
    expect(await p.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    await p.locator('.tst-pill[data-ab="saturday"]').click();
    await p.locator('.tst-sb[data-n="5"]').click();
    await p.locator('#tst-w-f').fill('جولة رائعة مع فريق رائع، شكراً لكم جميعاً');
    await p.locator('#tst-ok-f').click();
    await p.locator('.tst-send').click();
    await expect(p.locator('#tst-sent')).toHaveText('شكراً لك. سيراجعها فريقنا قريباً.');
    expect(calls(db, 'testimonial_send')[0].body.p_lang).toBe('ar');
  });
});

// ── After a rating of 9 or 10 ────────────────────────────────────────────────────────────────────────────────────────
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const done = (id: string, extra: Row = {}) => ({ id, name: 'Sara Ahmed Ali', customer_id: 'c1', session_id: 's-' + today, session_day: 'Friday', session_date: today, queue_num: 1,
  status: 'done', paid: true, price: 30, checked_out_at: today + 'T11:00:00Z', registered_at: today + 'T10:00:00Z', ...extra });
const sess = (extra: Row = {}) => ({ id: 's-' + today, day: 'Friday', session_date: today, capacity: 12, status: 'open', created_at: 1, ...extra });
async function rated(page: Page, db: RiderDb, on: boolean, s: Row = sess()) {
  const q = [done('q1')];
  await stubSupabase(page, { sessions: [s], queue_entries: q, 'rpc:my_bookings': q, 'rpc:customer_booking_update': true, site_content: on ? [ON] : [] });
  await riderDb(page, db);
  await rateGateOn(page);
  await loginCustomer(page, { id: 'c1', name: 'Sara Ahmed Ali' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.view='customer'; setCustTab('myrides')`);
  await expect(page.locator('#rate-modal .rg-box')).toBeVisible();
}
async function rate(page: Page, service: number, bike: number, note: string) {
  const m = page.locator('#rate-modal');
  await m.locator(`#rgq-service .rg-b[data-v="${service}"]`).click();
  await m.locator(`#rgq-bike .rg-b[data-v="${bike}"]`).click();
  await m.locator('#rate-note').fill(note);
  await m.locator('.pg-btn').click();
}

test.describe('@customer:testimonials after a rating', () => {
  const note = 'Lovely night with a great team, thank you so much!';
  test('a 9 or 10 with the switch on: the same pop-up offers it prefilled, and Send shares it with the booking', async ({ page }) => {
    const db: RiderDb = { mine: mine(), calls: [] };
    await rated(page, db, true);
    await rate(page, 9, 10, note);
    const step = page.locator('#rate-modal .tst-rate');
    await expect(step).toBeVisible();
    await expect(step.locator('#tst-rate-t')).toHaveText('Share it as a testimonial?');
    await expect(step.locator('.tst-pill[aria-pressed="true"]')).toHaveText('Session or rental'); // the booking's kind, as _tm_about reads it
    await expect(step.locator('.tst-sb[aria-checked="true"]')).toHaveAttribute('data-n', '5'); // 9 halved, rounded
    await expect(step.locator('#tst-w-r')).toHaveValue(note);
    await expect(step.locator('.tst-ph')).toHaveCount(0); // no photo here
    // centred
    const box = (await step.boundingBox())!, vp = page.viewportSize()!;
    expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(2);
    // the rating is saved already; Send needs the tick
    await step.locator('.tst-rate-send').click();
    await expect(step.locator('.tst-err')).toHaveText('Tick the box so MicroMobility may publish it.');
    await step.locator('#tst-ok-r').click();
    await step.locator('.tst-rate-send').click();
    // then the rating's own last screen, as before (a first ride: the path of five)
    await expect(page.locator('#rate-modal .rg-fin .rg-fin-n')).toHaveText('1 of 5');
    const s = calls(db, 'testimonial_send');
    expect(s).toHaveLength(1);
    expect(s[0].body).toMatchObject({ p_body: note, p_stars: 5, p_about: 'session', p_name_mode: 'short', p_consent: true, p_photo: null, p_source: 'rating', p_entry: 'q1' });
    await page.locator('#rate-modal .rg-fin .gate-out').click();
    await expect.poll(() => page.evaluate(`!!S._rg`)).toBe(false);
  });

  test('Not now and Escape go on to what the rating had next; a Saturday ride prefills Saturday', async ({ page }) => {
    const db: RiderDb = { mine: mine(), calls: [] };
    await rated(page, db, true, sess({ event_kind: 'community', ride_kind: 'saturday', day: 'Saturday' }));
    const m = page.locator('#rate-modal');
    // a Saturday ride's form: every score 10, no breakfast
    await m.locator('.rg-skip').click();
    for (const k of ['ride_checkin', 'ride_staff', 'ride_route', 'ride', 'overall']) { const b = m.locator(`#rgq-${k} .rg-b[data-v="10"]`); if (await b.count()) await b.click(); }
    const bike = m.locator('#rgq-ride_bike .rg-b[data-v="10"]'); if (await bike.count()) await bike.click();
    await m.locator('.pg-btn').click();
    const step = m.locator('.tst-rate');
    await expect(step).toBeVisible();
    await expect(step.locator('.tst-pill[aria-pressed="true"]')).toHaveText('Saturday community ride');
    await expect(step.locator('#tst-w-r')).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(m.locator('.tst-rate')).toHaveCount(0);
    expect(calls(db, 'testimonial_send')).toHaveLength(0);
  });

  test('an 8, or the switch off: no step, the rating goes on exactly as before', async ({ page }) => {
    const db: RiderDb = { mine: mine(), calls: [] };
    await rated(page, db, true);
    await rate(page, 8, 10, note);
    await expect(page.locator('#rate-modal .rg-fin')).toBeVisible();
    await expect(page.locator('#rate-modal .tst-rate')).toHaveCount(0);
    expect(calls(db, 'testimonial_mine')).toHaveLength(0);
  });

  test('switch off: a 10 shows no step', async ({ page }) => {
    const db: RiderDb = { mine: mine({ on: false }), calls: [] };
    await rated(page, db, false);
    await rate(page, 10, 10, note);
    await expect(page.locator('#rate-modal .rg-fin')).toBeVisible();
    await expect(page.locator('#rate-modal .tst-rate')).toHaveCount(0);
    expect(calls(db, 'testimonial_mine')).toHaveLength(0);
  });

  test('a booking already shared (or the server off) shows no step', async ({ page }) => {
    const db: RiderDb = { mine: mine({ items: [{ id: 9, entry_id: 'q1', status: 'pending', about: 'session', stars: 5, body: 'x'.repeat(30), name_mode: 'anon' }] }), calls: [] };
    await rated(page, db, true);
    await rate(page, 10, 10, note);
    await expect(page.locator('#rate-modal .rg-fin')).toBeVisible();
    await expect(page.locator('#rate-modal .tst-rate')).toHaveCount(0);
    expect(calls(db, 'testimonial_mine')).toHaveLength(1); // asked, and nothing to offer
  });
});

// ── The one-time ask about an old comment ───────────────────────────────────────────────────────────────────────────
const ASK = { entry_id: 'q-old', body: 'Best Saturday ride ever, the team was amazing and kind to everyone.', rating: 10, date: '2026-10-10', about: 'saturday', title: 'Saturday Social Ride', title_ar: 'جولة السبت' };
test.describe('@customer:testimonials the old comment', () => {
  test('asked once in a centred pop-up: the words, the ride, a name and the tick; Publish it answers yes and it never comes back', async ({ page }) => {
    const db: RiderDb = { mine: mine({ ask: ASK }), calls: [] };
    await rider(page, db, { site_content: [ON] });
    const ask = page.locator('#tst-ask .tst-ask');
    await expect(ask).toBeVisible();
    await expect(ask.locator('#tst-ask-t')).toHaveText('May we publish your words?');
    await expect(ask.locator('.tst-quote')).toHaveText(ASK.body);
    await expect(ask.locator('.rg-meta')).toContainText('Saturday Social Ride');
    await expect(ask.locator('.tst-nm')).toHaveText(['Sara Ahmed Ali', 'Sara A.', 'Anonymous']);
    const box = (await ask.boundingBox())!, vp = page.viewportSize()!;
    expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - vp.height / 2)).toBeLessThan(4);
    await expect(page.locator('body')).toHaveClass(/fix-open/);
    // no close: Escape leaves it
    await page.keyboard.press('Escape');
    await expect(ask).toBeVisible();
    await ask.locator('.tst-ask-yes').click();
    await expect(ask.locator('.tst-err')).toHaveText('Tick the box so MicroMobility may publish it.');
    expect(calls(db, 'testimonial_old_answer')).toHaveLength(0);
    await ask.locator('input[name="tst-nm-a"][value="anon"]').check();
    await ask.locator('#tst-ok-a').click();
    await ask.locator('.tst-ask-yes').click();
    await expect(page.locator('#tst-ask .tst-ask')).toHaveCount(0);
    expect(calls(db, 'testimonial_old_answer')[0].body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_entry: 'q-old', p_yes: true, p_name_mode: 'anon', p_consent: true });
    await expect(page.locator('body')).not.toHaveClass(/fix-open/);
    // answered: this device never asks again, not even the server
    const before = calls(db, 'testimonial_mine').length;
    await page.reload();
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    await page.waitForTimeout(500);
    await expect(page.locator('#tst-ask .tst-ask')).toHaveCount(0);
    expect(calls(db, 'testimonial_mine').length).toBe(before);
  });

  test('No thanks answers no; with the switch off nothing is asked', async ({ page }) => {
    const db: RiderDb = { mine: mine({ ask: ASK }), calls: [] };
    await rider(page, db, { site_content: [ON] });
    const ask = page.locator('#tst-ask .tst-ask');
    await expect(ask).toBeVisible();
    await ask.locator('.tst-ask-no').click();
    await expect(page.locator('#tst-ask .tst-ask')).toHaveCount(0);
    expect(calls(db, 'testimonial_old_answer')[0].body).toMatchObject({ p_entry: 'q-old', p_yes: false, p_consent: false });
  });

  test('switch off: no ask, not even the read', async ({ page }) => {
    const db: RiderDb = { mine: mine({ ask: ASK }), calls: [] };
    await rider(page, db, { site_content: [] });
    await page.evaluate(`setCustTab('myrides');_forceRatingPrompt()`);
    await page.waitForTimeout(400);
    await expect(page.locator('#tst-ask .tst-ask')).toHaveCount(0);
    expect(calls(db, 'testimonial_mine')).toHaveLength(0);
  });

  test('it waits while another forced pop-up is open: the rating first, then the ask', async ({ page }) => {
    const db: RiderDb = { mine: mine({ ask: ASK }), calls: [] };
    await rated(page, db, true);
    await expect(page.locator('#tst-ask .tst-ask')).toHaveCount(0);
    await rate(page, 7, 7, '');
    await expect(page.locator('#rate-modal .rg-fin')).toBeVisible();
    await expect(page.locator('#tst-ask .tst-ask')).toHaveCount(0); // the rating's own last screen is still up
    await page.locator('#rate-modal .rg-fin .gate-out').click();
    await page.evaluate(`renderMyRides()`); // moving about, as the rider does
    await expect(page.locator('#tst-ask .tst-ask')).toBeVisible();
  });
});

// ── Staff: the section ───────────────────────────────────────────────────────────────────────────────────────────────
type StaffDb = { items: Row[]; on: boolean; calls: Call[]; featureLimit?: boolean; addErr?: string };
const T = (id: number, o: Row = {}): Row => ({ id, customer_id: 'c' + id, entry_id: null, source: 'app', about: 'session', stars: 5, body: `Testimonial number ${id}, a lovely ride`, lang: 'en',
  name_mode: 'short', display_name: `Rider${id} S.`, photo: false, consent_at: '2099-01-0' + (id % 9 + 1) + 'T09:00:00Z', consent_note: null, status: 'pending', featured: false, sort_order: null,
  staff_note: null, reviewed_by: null, reviewed_at: null, published_at: null, created_by: null, created_at: '2099-01-0' + (id % 9 + 1) + 'T10:00:00Z', customer_name: `Rider${id} Saleh`,
  customer_phone: '05000000' + String(id).padStart(2, '0'), since: { year: 2025, rides: id }, ride_title: null, ride_date: null, ...o });
const items = () => [
  T(1, { photo: true, source: 'web' }),
  T(2, { source: 'rating', entry_id: 'q2', ride_title: 'Circuit night', ride_date: '2099-01-01', about: 'saturday', name_mode: 'anon', display_name: null }),
  T(3, { status: 'published', published_at: '2099-01-03T12:00:00Z', stars: 4, featured: true, sort_order: 1 }),
  T(4, { status: 'published', published_at: '2099-01-04T12:00:00Z', stars: 5, sort_order: 2, photo: true }),
  T(5, { status: 'rejected', staff_note: 'Off topic', reviewed_by: 'Spec Staff', reviewed_at: '2099-01-05T12:00:00Z' }),
  T(6, { status: 'hidden', source: 'staff', customer_id: null, customer_name: null, customer_phone: null, since: null, stars: null, consent_note: 'WhatsApp, 12 November', created_by: 'Spec Staff', name_mode: 'full', display_name: 'Omar Faruq' }),
];
async function staffDb(page: Page, db: StaffDb) {
  await page.route(/\/rest\/v1\/rpc\/staff_testimonial/, async (route) => {
    const fn = /rpc\/(\w+)/.exec(route.request().url())![1];
    let body: Row = {};
    try { body = route.request().postDataJSON() as Row; } catch { /* none */ }
    db.calls.push({ fn, body });
    const ok = (v: unknown) => route.fulfill({ status: 200, headers: J, body: JSON.stringify(v) });
    if (fn === 'staff_testimonials') {
      const n = (s: string) => db.items.filter((x) => x.status === s).length;
      return ok({ on: db.on, counts: { pending: n('pending'), published: n('published'), rejected: n('rejected'), hidden: n('hidden'), featured: db.items.filter((x) => x.featured).length },
        asks: { yes: 3, no: 4 }, items: db.items.filter((x) => !body.p_status || x.status === body.p_status) });
    }
    if (fn === 'staff_testimonial_photo') return ok('data:image/png;base64,' + PNG.toString('base64'));
    if (fn === 'staff_testimonial_set') {
      if (body.p_action === 'feature' && db.featureLimit) return route.fulfill({ status: 400, headers: J, body: JSON.stringify({ code: 'P0001', message: 'FEATURE_LIMIT', details: null, hint: null }) });
      const st: Record<string, string> = { publish: 'published', reject: 'rejected', hide: 'hidden', pending: 'pending' };
      let n = 0;
      for (const x of db.items) {
        if (!(body.p_ids as number[]).includes(x.id as number)) continue;
        const a = String(body.p_action);
        if (st[a] && x.status !== st[a]) { x.status = st[a]; if (a === 'reject') x.photo = false; if (st[a] !== 'published') x.featured = false; if (body.p_note) x.staff_note = body.p_note; x.reviewed_by = 'Spec Staff'; x.reviewed_at = '2099-01-09T09:00:00Z'; n++; }
        if (a === 'feature' && !x.featured) { x.featured = true; n++; }
        if (a === 'unfeature' && x.featured) { x.featured = false; n++; }
        if (a === 'drop_photo' && x.photo) { x.photo = false; n++; }
      }
      return ok(n);
    }
    if (fn === 'staff_testimonial_order') { (body.p_ids as number[]).forEach((id, i) => { const x = db.items.find((y) => y.id === id); if (x) x.sort_order = i + 1; }); return ok((body.p_ids as number[]).length); }
    if (fn === 'staff_testimonial_delete') { const was = db.items.length; db.items = db.items.filter((x) => x.id !== body.p_tid); return ok(was - db.items.length); }
    if (fn === 'staff_testimonial_add') {
      if (db.addErr) return route.fulfill({ status: 400, headers: J, body: JSON.stringify({ code: '22023', message: db.addErr, details: null, hint: null }) });
      db.items.unshift(T(40, { source: 'staff', body: body.p_body, about: body.p_about, stars: body.p_stars, status: body.p_publish ? 'published' : 'pending', consent_note: body.p_consent_note }));
      return ok(40);
    }
    return ok(null);
  });
}
const scalls = (db: StaffDb, fn: string) => db.calls.filter((c) => c.fn === fn);
async function staff(page: Page, db: StaffDb, path = '/testimonials', fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [{ id: 'c77', name: 'Huda Saleh', phone: '0551234567', email: 'huda@example.com' }], site_content: [], ...fx });
  await staffDb(page, db);
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
  await page.waitForFunction(`S.view==='staff'&&S.staffTab==='testimonials'`);
  await expect(page.locator('#tab-testimonials .tsm-top')).toBeVisible();
}
const sec = (page: Page) => page.locator('#tab-testimonials');
const trow = (page: Page, id: number) => sec(page).locator(`.tsm-row[data-tid="${id}"]`);
const pill = (page: Page, name: RegExp) => sec(page).locator('.filter-pill', { hasText: name });

test.describe('@staff:testimonials the section', () => {
  test('under People with its own address and the waiting number; the summary, the pills, the rows with all staff need', async ({ page }) => {
    const db: StaffDb = { items: items(), on: false, calls: [] };
    await staff(page, db);
    expect(new URL(page.url()).pathname).toBe('/testimonials');
    const order = await page.locator('#staff-tab-nav .tab-btn[data-stab]').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.stab));
    expect(order.indexOf('testimonials')).toBe(order.indexOf('ask') + 1);
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="testimonials"] .tab-badge')).toHaveText('2');
    await expect(sec(page).locator('h1')).toHaveText('Testimonials');
    // the published average and how many, the old comments' answers, the switch, the public page
    await expect(sec(page).locator('.tsm-avg')).toContainText('4.5');
    await expect(sec(page).locator('.tsm-avg')).toContainText('average from 2 published');
    await expect(sec(page).locator('.tsm-asks')).toHaveText('Old comments: 3 said yes, 4 said no');
    await expect(sec(page).locator('#tsm-on')).not.toBeChecked();
    await expect(sec(page).locator('.tsm-open')).toHaveAttribute('href', 'https://micromobility.sa/testimonials');
    // the pills, Waiting first
    await expect(sec(page).locator('.filter-pill')).toHaveText(['Waiting (2)', 'Published (2)', 'Not published (2)', 'All (6)']);
    await expect(sec(page).locator('.tsm-row')).toHaveCount(2);
    const r1 = trow(page, 1);
    await expect(r1.locator('.tsm-meta')).toContainText('Account: Rider1 Saleh · 0500000001');
    await expect(r1.locator('.tsm-meta')).toContainText('Shows as: Rider1 S. · Rider since 2025 · 1 ride');
    await expect(r1.locator('.tsm-meta')).toContainText('Website');
    await expect(r1.locator('.tsm-body')).toHaveAttribute('dir', 'auto');
    await expect(trow(page, 2).locator('.tsm-meta')).toContainText('Shows as: A MicroMobility rider (anonymous)');
    await expect(trow(page, 2).locator('.tsm-meta')).toContainText('After a rating · Circuit night');
    await expect(trow(page, 2).locator('.tsm-chip')).toContainText(['Waiting', 'Saturday community ride']);
    // a photo is read only when opened
    expect(scalls(db, 'staff_testimonial_photo')).toHaveLength(0);
    await r1.locator('.tsm-ph-btn').click();
    await expect(r1.locator('img.tsm-img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    expect(scalls(db, 'staff_testimonial_photo')[0].body).toEqual({ p_tid: 1 });
    await r1.locator('.tsm-ph-btn').click();
    await expect(r1.locator('img.tsm-img')).toHaveCount(0);
    // Not published holds the rejected and the hidden; a staff-added one says where they agreed and has no account
    await pill(page, /^Not published/).click();
    await expect(sec(page).locator('.tsm-row')).toHaveCount(2);
    await expect(trow(page, 5).locator('.tsm-meta')).toContainText('Reviewed by Spec Staff');
    await expect(trow(page, 5).locator('.tsm-meta')).toContainText('Note: Off topic');
    await expect(trow(page, 6).locator('.tsm-meta')).toContainText('Account: No account');
    await expect(trow(page, 6).locator('.tsm-meta')).toContainText('WhatsApp, 12 November');
    await expect(trow(page, 6).locator('.tsm-nostar')).toHaveText('No stars');
    // search and Filters
    await pill(page, /^All/).click();
    if (!(await sec(page).locator('#tsm-q').isVisible())) await sec(page).locator('[data-srch="tsm"] .srch-btn').click(); // a phone folds the search into a button
    await sec(page).locator('#tsm-q').fill('Rider4');
    await expect(sec(page).locator('.tsm-row')).toHaveCount(1);
    await sec(page).locator('#tsm-q').fill('');
    await sec(page).locator('[aria-controls="fm-tsm"]').click();
    await sec(page).locator('#fm-tsm select[aria-label="About"]').selectOption('saturday');
    await expect(sec(page).locator('.tsm-row')).toHaveCount(1);
    await expect(sec(page).locator('[aria-controls="fm-tsm"]')).toContainText('(1)');
  });

  test('Publish, Reject with a second tap and a note, Hide, Back to waiting, Feature (12 at most), order, Remove photo, Delete', async ({ page }) => {
    const db: StaffDb = { items: items(), on: true, calls: [] };
    await staff(page, db);
    const set = () => scalls(db, 'staff_testimonial_set').map((c) => c.body);
    await trow(page, 1).locator('button', { hasText: /^Publish$/ }).click();
    await expect.poll(() => set().length).toBe(1);
    expect(set()[0]).toEqual({ p_ids: [1], p_action: 'publish', p_note: null });
    await expect(trow(page, 1)).toHaveCount(0); // it left Waiting
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="testimonials"] .tab-badge')).toHaveText('1');
    // Reject: the first tap asks, with a note for the team
    await trow(page, 2).locator('button', { hasText: /^Reject$/ }).click();
    await expect(trow(page, 2).locator('button', { hasText: 'Reject now' })).toBeVisible();
    expect(set()).toHaveLength(1);
    await trow(page, 2).locator('#tsm-note-2').fill('Not about us');
    await trow(page, 2).locator('button', { hasText: 'Reject now' }).click();
    await expect.poll(() => set().length).toBe(2);
    expect(set()[1]).toEqual({ p_ids: [2], p_action: 'reject', p_note: 'Not about us' });
    // Published: Feature, the limit said, the order, Hide
    await pill(page, /^Published/).click();
    await expect(sec(page).locator('.tsm-row')).toHaveCount(3);
    expect(await sec(page).locator('.tsm-row').evaluateAll((r) => r.map((x) => (x as HTMLElement).dataset.tid))).toEqual(['3', '4', '1']); // the website's order
    db.featureLimit = true;
    await trow(page, 4).locator('button', { hasText: /^Feature$/ }).click();
    await expect(page.locator('.toast', { hasText: '12 are featured already. Unfeature one first.' })).toHaveCount(1);
    db.featureLimit = false;
    await trow(page, 4).locator('button', { hasText: /^Feature$/ }).click();
    await expect.poll(() => set().at(-1)).toEqual({ p_ids: [4], p_action: 'feature', p_note: null });
    await expect(trow(page, 4).locator('.tsm-c-feat')).toBeVisible();
    await trow(page, 4).locator('.tsm-mv[aria-label="Move up"]').click();
    await expect.poll(() => scalls(db, 'staff_testimonial_order').length).toBe(1);
    expect(scalls(db, 'staff_testimonial_order')[0].body).toEqual({ p_ids: [4, 3, 1] });
    await expect(trow(page, 4).locator('.tsm-mv[aria-label="Move up"]')).toBeDisabled();
    await trow(page, 3).locator('button', { hasText: /^Hide$/ }).click();
    await expect.poll(() => set().at(-1)).toEqual({ p_ids: [3], p_action: 'hide', p_note: null });
    // Not published: Back to waiting; Remove photo and Delete ask a second tap
    await pill(page, /^Not published/).click();
    await trow(page, 6).locator('button', { hasText: 'Back to waiting' }).click();
    await expect.poll(() => set().at(-1)).toEqual({ p_ids: [6], p_action: 'pending', p_note: null });
    await pill(page, /^All/).click();
    await trow(page, 4).locator('button', { hasText: /^Remove photo$/ }).click();
    await expect(trow(page, 4).locator('button', { hasText: 'Tap again to remove the photo' })).toBeVisible();
    await trow(page, 4).locator('button', { hasText: 'Tap again to remove the photo' }).click();
    await expect.poll(() => set().at(-1)).toEqual({ p_ids: [4], p_action: 'drop_photo', p_note: null });
    await trow(page, 5).locator('button', { hasText: /^Delete$/ }).click();
    expect(scalls(db, 'staff_testimonial_delete')).toHaveLength(0);
    await trow(page, 5).locator('button', { hasText: 'Tap again to delete' }).click();
    await expect.poll(() => scalls(db, 'staff_testimonial_delete').length).toBe(1);
    expect(scalls(db, 'staff_testimonial_delete')[0].body).toEqual({ p_tid: 5 });
    await expect(trow(page, 5)).toHaveCount(0);
    // each change is in the log, with who did it
    expect(await page.evaluate(`S.fullLog.map(l=>l.label).filter(l=>/Testimonial/.test(l)).length`)).toBeGreaterThanOrEqual(6);
  });

  test('Add testimonial: a typed name or an account, where they agreed is required, Publish now', async ({ page }) => {
    const db: StaffDb = { items: items(), on: true, calls: [] };
    await staff(page, db);
    await sec(page).locator('.tsm-add-btn').click();
    const d = page.locator('#confirm-modal .tsm-add');
    await expect(d).toBeVisible();
    await expect(d.locator('#tsm-add-t')).toHaveText('Add a testimonial');
    await d.locator('#tsm-a-go').click();
    await expect(d.locator('.pg-net')).toHaveText('Write between 20 and 800 characters.');
    await d.locator('#tsm-a-body').fill('They said on WhatsApp the ride was the best of their year.');
    await d.locator('#tsm-a-go').click();
    await expect(d.locator('.pg-net')).toHaveText('Pick what it is about.');
    await d.locator('#tsm-a-about').selectOption('event');
    await d.locator('#tsm-a-go').click();
    await expect(d.locator('.pg-net')).toHaveText('Type the name, pick an account or choose Anonymous.');
    await d.locator('#tsm-a-name').fill('Lina Hassan Omar');
    await expect(d.locator('#tsm-a-shows')).toHaveText('Shows as: Lina O.');
    await d.locator('#tsm-a-go').click();
    await expect(d.locator('.pg-net')).toHaveText('Say where they agreed (3 characters at least).');
    expect(scalls(db, 'staff_testimonial_add')).toHaveLength(0);
    await d.locator('#tsm-a-where').fill('WhatsApp, 12 November');
    await d.locator('#tsm-a-stars').selectOption('4');
    // the server's refusal is said in the dialog
    db.addErr = 'NAME';
    await d.locator('#tsm-a-go').click();
    await expect(d.locator('.pg-net')).toHaveText('Type the name, pick an account or choose Anonymous.');
    db.addErr = undefined;
    await d.locator('#tsm-a-pub').check();
    await d.locator('#tsm-a-go').click();
    await expect(page.locator('#confirm-modal .tsm-add')).toHaveCount(0);
    const a = scalls(db, 'staff_testimonial_add');
    expect(a.at(-1)!.body).toEqual({ p_customer: null, p_name: 'Lina Hassan Omar', p_name_mode: 'short', p_body: 'They said on WhatsApp the ride was the best of their year.', p_stars: 4,
      p_about: 'event', p_consent_note: 'WhatsApp, 12 November', p_photo: null, p_publish: true });
    // with an account: picked from the search, its name comes from it
    await sec(page).locator('.tsm-add-btn').click();
    await d.locator('#tsm-a-q').fill('Huda');
    await d.locator('.tsm-a-hit').first().click();
    await expect(d.locator('.tsm-a-who')).toContainText('Huda Saleh');
    await expect(d.locator('#tsm-a-name')).toHaveCount(0);
    await d.locator('input[name="tsm-a-mode"][value="full"]').check();
    await expect(d.locator('#tsm-a-shows')).toHaveText('Shows as: Huda Saleh');
    await d.locator('#tsm-a-body').fill('Huda told us at the desk how much she loved it all.');
    await d.locator('#tsm-a-about').selectOption('session');
    await d.locator('#tsm-a-where').fill('At the desk, in person');
    await d.locator('#tsm-a-file').setInputFiles({ name: 'h.png', mimeType: 'image/png', buffer: PNG });
    await expect(d.locator('.tsm-a-thumb')).toBeVisible();
    await d.locator('#tsm-a-go').click();
    await expect(page.locator('#confirm-modal .tsm-add')).toHaveCount(0);
    const b = scalls(db, 'staff_testimonial_add').at(-1)!.body;
    expect(b).toMatchObject({ p_customer: 'c77', p_name: null, p_name_mode: 'full', p_stars: null, p_about: 'session', p_publish: false });
    expect(String(b.p_photo)).toMatch(/^data:image\/jpeg;base64,/);
  });

  test('the switch: an admin is asked what it turns on, then site_content testimonials.on; other roles see its state only', async ({ page }) => {
    const db: StaffDb = { items: items(), on: false, calls: [] };
    const writes: Row[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/site_content') && r.method() !== 'GET') { try { writes.push(r.postDataJSON() as Row); } catch { /* none */ } } });
    await staff(page, db);
    await sec(page).locator('#tsm-on').click();
    const q = page.locator('#confirm-modal');
    await expect(q).toContainText('Show testimonials to riders?');
    await expect(q).toContainText('Write a testimonial');
    await expect(q).toContainText('the one-time ask about an old comment');
    await expect(sec(page).locator('#tsm-on')).not.toBeChecked(); // not until confirmed
    expect(writes).toHaveLength(0);
    await q.locator('button', { hasText: 'Show them' }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({ key: 'testimonials.on', value: true });
    await expect(sec(page).locator('#tsm-on')).toBeChecked();
    expect(await page.evaluate(`S.fullLog.some(l=>l.label==='Testimonials shown to riders')`)).toBe(true);
    // a manager sees which way it is, and cannot change it
    await page.evaluate(`setStaffRole('manager');renderTestimonials()`);
    await expect(sec(page).locator('#tsm-on')).toBeDisabled();
    await expect(sec(page).locator('.tsm-sw')).toContainText('Only an admin can change this.');
  });

  test('derived from People: its rights come with People and never reach staff_set_access; a database without it says so', async ({ page }) => {
    const db: StaffDb = { items: [], on: false, calls: [] };
    await staff(page, db);
    expect(await page.evaluate(`JSON.stringify(_modIds(['community']))`)).toContain('"testimonials"');
    expect(await page.evaluate(`JSON.stringify(_modSend(['community','testimonials','queue']))`)).toBe('["community","queue"]');
    expect(await page.evaluate(`['admin','manager','owner','frontdesk','leader','mechanic','cashier'].map(r=>_roleTabs(r).includes('testimonials'))`)).toEqual([true, true, true, false, false, false, false]);
    expect(await page.evaluate(`STAFF_PATHS.testimonials`)).toBe('testimonials');
    await expect(sec(page).locator('.tsm-none')).toHaveText('Nothing is waiting for review.');
    // a database from before the migration
    await page.route(/\/rest\/v1\/rpc\/staff_testimonials\b/, (r) => r.fulfill({ status: 404, headers: J, body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.staff_testimonials in the schema cache' }) }));
    await page.evaluate(`S._tsm=null;S._tsmAt=0;renderTestimonials()`);
    await expect(sec(page)).toContainText('Testimonials are not set up on the database yet.');
  });
});
