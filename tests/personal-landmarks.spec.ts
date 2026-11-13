import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Personal landmarks (new features build F16, 2026-11-13), both on the rider's Stats and both private.
// The anniversary of the first ride: for the seven days from its date, every year, a card leads Stats - the years, the
// first ride's date, one line from the team (the admins' own from Settings > Message templates, else the built-in one
// in the reader's language) and the team's name. The kinds tried: a checklist under By event of every kind the rider can
// still book or has done, ticked once one was completed; a bike-free kind keeps its own name and is never called a ride.
// Nothing is sent as a message.

const ROOT = resolve(__dirname, '..');
const LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const pack = (code: string) => JSON.parse(readFileSync(resolve(ROOT, code === 'ar' ? 'lang/ar.json' : `i18n/${code}.json`), 'utf8')) as Record<string, string>;

const sess = (id: string, date: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({ id, day: 'Sunday', session_date: date, capacity: 20, status: 'closed', created_at: 1, location: 'JCC', bike_slots: '{"_time":"18:00 - 20:00","_total":20}', ...o });
const comm = (kind: string, o: Record<string, unknown> = {}) => ({ event_kind: 'community', ride_kind: kind, location: null, ...o });
const rated = { rating_exp: 9, rating_detail: { form: 'rental', s: { experience: 9 }, why: {} }, rated_at: '2097-01-05T10:00:00Z' };
const bk = (id: string, sid: string, date: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({ id, session_id: sid, session_date: date, name: 'Spec Rider', customer_id: 'c1', session_day: 'Sunday', queue_num: 3, status: 'done', paid: true, price: 75, type_preference: 'Road', registered_at: '2096-10-01T10:00:00Z', ...rated, ...o });

// The record: a pool session first (2096-11-01), the first bike ride on 2097-01-04, another ride in 2098, Run for Her
// in 2098 (over, not on offer again) and a yoga class that was booked and cancelled. On offer from here on: the circuit,
// the Saturday ride, a pool session and a yoga class. A National Day ride that is over and was never ridden.
const sessions = [
  sess('sw-0', '2096-11-01', comm('swim')),
  sess('2097-01-04', '2097-01-04'),
  sess('2098-02-06', '2098-02-06'),
  sess('rh-1', '2098-03-08', comm('runher')),
  sess('nd-1', '2098-09-23', { ride_kind: 'snd96' }),
  sess('yg-1', '2099-05-01', comm('yoga')),
  sess('2099-12-20', '2099-12-20', { status: 'open' }),
  sess('sat-9', '2099-12-26', comm('saturday', { status: 'full', day: 'Saturday' })),
  sess('sw-9', '2099-12-21', comm('swim', { status: 'open' })),
  sess('yg-9', '2099-12-22', comm('yoga', { status: 'open' })),
];
const rows = (yoga: Record<string, unknown> = { status: 'cancelled', paid: false }) => [
  bk('p', 'sw-0', '2096-11-01', { type_preference: 'None', price: 0 }),
  bk('a', '2097-01-04', '2097-01-04'),
  bk('b', '2098-02-06', '2098-02-06'),
  bk('r', 'rh-1', '2098-03-08', { type_preference: 'None' }),
  bk('y', 'yg-1', '2099-05-01', { type_preference: 'None', price: 0, ...yoga }),
];

async function open(page: Page, when: string, o: { lang?: string; fx?: Record<string, unknown>; rows?: Record<string, unknown>[] } = {}) {
  await page.clock.setFixedTime(new Date(when));
  const r = o.rows || rows();
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: r, 'rpc:my_bookings': r, ...(o.fx || {}) });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/account/stats?lang=' + (o.lang || 'en'));
  await waitForSb(page);
  await page.evaluate(`_bdgPopClose()`); // a badge's pop-up, should one be new on this date
  await expect(page.locator('#acc-pane-stats .mr-season')).toBeVisible();
}
const card = (page: Page) => page.locator('#acc-pane-stats .lm-anniv');
const kinds = (page: Page) => page.locator('#acc-pane-stats .lm-kinds');

test.describe('@customer:account personal landmarks: the anniversary of the first ride', () => {
  test('on the day: the years, the first ride\'s date, the team\'s line and its name, above the season', async ({ page }) => {
    await open(page, '2099-01-04T09:00:00+03:00');
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('.lm-anniv-t')).toHaveText('2 years since your first ride');
    await expect(card(page).locator('.lm-anniv-d')).toHaveText('First ride · 4 Jan 2097'); // the first BIKE ride, not the pool session before it
    await expect(card(page).locator('.lm-anniv-l')).toHaveText('Thank you for riding with us. Here is to many more rides together.');
    await expect(card(page).locator('.lm-anniv-s')).toHaveText('The MicroMobility team');
    const first = await page.locator('#acc-pane-stats > *').first().getAttribute('id');
    expect(first).toBe('lm-anniv');
  });

  for (const [when, shown, what] of [
    ['2099-01-03T23:30:00+03:00', false, 'the evening before'],
    ['2099-01-04T00:10:00+03:00', true, 'the first minutes of the day in Riyadh'],
    ['2099-01-10T23:30:00+03:00', true, 'the seventh day'],
    ['2099-01-11T00:30:00+03:00', false, 'the eighth day'],
    ['2099-06-15T12:00:00+03:00', false, 'any other week'],
    ['2098-11-03T12:00:00+03:00', false, 'two years after the pool session, which is not a ride'],
  ] as const) {
    test(`${what}: the card is ${shown ? 'shown' : 'not shown'}`, async ({ page }) => {
      const reads: string[] = [];
      page.on('request', (r) => { if (r.url().includes('/rest/v1/site_content') && r.url().includes('lm_anniv')) reads.push(r.url()); });
      await open(page, when);
      await expect(card(page)).toHaveCount(shown ? 1 : 0);
      // the team's line is read only in a week the card shows, and only that one text
      if (shown) {
        await expect.poll(() => reads.length).toBe(1);
        const u = new URL(reads[0]);
        expect(u.searchParams.get('select')).toBe('v:value->lm_anniv');
        expect(u.searchParams.get('key')).toBe('eq.msg.templates');
      } else expect(reads).toEqual([]);
    });
  }

  test('the first anniversary says one year; Arabic says it in its own singular and dual', async ({ page }) => {
    await open(page, '2098-01-06T12:00:00+03:00');
    await expect(card(page).locator('.lm-anniv-t')).toHaveText('1 year since your first ride');
    const ar = pack('ar');
    await open(page, '2098-01-06T12:00:00+03:00', { lang: 'ar' });
    await expect(card(page).locator('.lm-anniv-t')).toHaveText(ar.lmAnniv_one);
    expect(ar.lmAnniv_one).not.toContain('{0}');
    await expect(card(page).locator('.lm-anniv-l')).toHaveText(ar.lmLine);
    await expect(card(page).locator('.lm-anniv-s')).toHaveText(ar.lmSign);
    await open(page, '2099-01-06T12:00:00+03:00', { lang: 'ar' });
    await expect(card(page).locator('.lm-anniv-t')).toHaveText(ar.lmAnniv_two);
  });

  test('a first ride on 29 February keeps 28 February in other years, and a week over New Year is found', async ({ page }) => {
    await open(page, '2099-06-15T12:00:00+03:00');
    const got = await page.evaluate(`[
      _lmAnniv('2096-02-29','2097-02-27'), _lmAnniv('2096-02-29','2097-02-28'), _lmAnniv('2096-02-29','2097-03-06'), _lmAnniv('2096-02-29','2097-03-07'),
      _lmAnniv('2096-02-29','2104-02-29'), _lmAnniv('2096-02-29','2104-02-28'),
      _lmAnniv('2096-12-28','2098-01-03'), _lmAnniv('2096-12-28','2098-01-04'),
      _lmAnniv('2097-01-04','2097-01-04'), _lmAnniv('','2099-01-04'), _lmAnniv('2097-01-04','2096-01-04'),
    ].map(a=>a?a.years:0)`);
    expect(got).toEqual([0, 1, 1, 0, 8, 0, 1, 0, 0, 0, 0]);
  });

  test('the admins\' line replaces the built-in one in its language; another language keeps its own built-in line', async ({ page }) => {
    const fx = { site_content: [{ key: 'msg.templates', v: { en: 'Two laps round the sun with us. Thank you.' } }] };
    await open(page, '2099-01-05T12:00:00+03:00', { fx });
    await expect(card(page).locator('.lm-anniv-l')).toHaveText('Two laps round the sun with us. Thank you.');
    await expect(card(page).locator('.lm-anniv-s')).toHaveText('The MicroMobility team'); // always signed
    await open(page, '2099-01-05T12:00:00+03:00', { fx, lang: 'fr' });
    await expect(card(page).locator('.lm-anniv-l')).toHaveText(pack('fr').lmLine);
    await expect(card(page).locator('.lm-anniv-t')).toHaveText('2 ans depuis votre première sortie');
  });

  test('the card and the checklist fit a phone in Arabic', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await open(page, '2099-01-05T12:00:00+03:00', { lang: 'ar' });
    for (const box of [card(page), kinds(page)]) {
      await expect(box).toBeVisible();
      const over = await box.evaluate((b) => {
        const r = b.getBoundingClientRect();
        return r.right > document.documentElement.clientWidth + 0.5 || r.left < -0.5 || b.scrollWidth > b.clientWidth + 1;
      });
      expect(over).toBe(false);
    }
  });
});

test.describe('@customer:account personal landmarks: the kinds tried', () => {
  test('every kind on offer or done is listed, ticked where one was completed', async ({ page }) => {
    await open(page, '2099-06-15T12:00:00+03:00');
    const k = kinds(page);
    await expect(k.locator('.lm-kinds-h span')).toHaveText('Tried so far');
    await expect(k.locator('.lm-kinds-h bdi')).toHaveText('3/5');
    // the circuit, the Saturday ride, the pool and yoga are on offer; Run for Her is over but was done; the National
    // Day ride is over and was not, so it is not listed
    await expect(k.locator('li > span:not(.sr-only)')).toHaveText(['Jeddah Corniche Circuit', 'Saturday Social Ride', 'Triathlon Pool Session', 'Hatha Yoga for Cyclists', 'Run for Her']);
    await expect(k.locator('li .sr-only')).toHaveText(['Done', 'Not yet', 'Done', 'Not yet', 'Done']); // a cancelled yoga booking is not a class done
    await expect(k.locator('li.on')).toHaveCount(3);
    await expect(k.locator('li.on svg')).toHaveCount(3);
    await expect(k.locator('li:not(.on) i')).toHaveCount(2);
    // it sits under By event, above Badges earned
    const order = await page.locator('#acc-pane-stats .myr-c').evaluateAll((els) => els.map((e) => (e.classList.contains('lm-kinds') ? 'kinds' : e.classList.contains('myr-bd') ? 'badges' : e.querySelector('.myr-h')?.textContent || '')));
    expect(order.slice(-3)).toEqual(['By event', 'kinds', 'badges']);
  });

  test('a kind is ticked once a session of it is completed', async ({ page }) => {
    await open(page, '2099-06-15T12:00:00+03:00', { rows: rows({ status: 'done', paid: true }) });
    const k = kinds(page);
    await expect(k.locator('.lm-kinds-h bdi')).toHaveText('4/5');
    await expect(k.locator('li .sr-only')).toHaveText(['Done', 'Not yet', 'Done', 'Done', 'Done']);
  });

  test('a bike-free kind keeps its own words: no row or heading calls it a ride, in English or Arabic', async ({ page }) => {
    await open(page, '2099-06-15T12:00:00+03:00');
    const k = kinds(page);
    await expect(k.locator('.lm-kinds-h')).not.toContainText(/ride|bike|cycl/i);
    for (const name of ['Triathlon Pool Session', 'Run for Her']) {
      const li = k.locator('li', { hasText: name });
      await expect(li).toHaveText(name + 'Done'); // its name and its state, nothing else
      await expect(li).not.toContainText(/\bride\b|bike/i);
    }
    const ar = pack('ar');
    await open(page, '2099-06-15T12:00:00+03:00', { lang: 'ar' });
    await expect(kinds(page).locator('.lm-kinds-h span')).toHaveText(ar.lmKinds);
    expect(ar.lmKinds + ar.lmDone + ar.lmNotYet).not.toMatch(/جولة|جولات|دراج/); // ride, rides, bike
    await expect(kinds(page).locator('li', { hasText: ar.evSwimName })).toHaveText(ar.evSwimName + ar.lmDone);
  });

  test('one kind alone is not a checklist', async ({ page }) => {
    const only = sessions.filter((s) => !s.ride_kind); // the circuit's nights
    await open(page, '2099-06-15T12:00:00+03:00', { fx: { sessions: only, 'rpc:list_sessions': only }, rows: rows().filter((r) => only.some((s) => s.id === r.session_id)) });
    await expect(page.locator('#acc-pane-stats .myr-c:has(dl)')).toHaveCount(2); // Rides by bike, By event
    await expect(kinds(page)).toHaveCount(0);
  });

  test('the new words are in all ten languages, plural forms and all', () => {
    const src = readFileSync(resolve(ROOT, 'app.src.html'), 'utf8');
    const keys = ['lmAnniv_zero', 'lmAnniv_one', 'lmAnniv_two', 'lmAnniv_few', 'lmAnniv_many', 'lmAnniv_other', 'lmLine', 'lmSign', 'lmKinds', 'lmDone', 'lmNotYet', 'tplgLm', 'tplLmAnniv'];
    for (const k of keys) expect((src.match(new RegExp(`[ ,]${k}:'[^']+'`, 'g')) || []).length, k).toBe(2); // English and Arabic, inline
    for (const code of LANGS.filter((c) => c !== 'en' && c !== 'ar')) {
      const p = pack(code);
      for (const k of keys) expect(String(p[k] || '').trim(), `${code} ${k}`).not.toBe('');
      expect(p.lmSign, code).toContain('MicroMobility');
      expect(keys.map((k) => p[k]).join(''), code).not.toMatch(/[०-९০-৯٠-٩۰-۹]/); // Latin digits
    }
  });
});

test.describe('@staff:settings personal landmarks: the anniversary line in Message templates', () => {
  async function boot(page: Page) {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], site_content: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  }

  test('the editor starts from the built-in line in each of the ten languages, the same words the riders\' packs carry', async ({ page }) => {
    await boot(page);
    const def = await page.evaluate(`Object.fromEntries(${JSON.stringify(LANGS)}.map(c=>[c,_tplDefault('lm_anniv',c)]))`) as Record<string, string>;
    const en = await page.evaluate(`LANG.en.lmLine`);
    expect(def.en).toBe(en);
    for (const code of LANGS.filter((c) => c !== 'en')) expect(def[code], code).toBe(pack(code).lmLine);
    expect(new Set(Object.values(def)).size).toBe(10);
  });

  test('an admin rewrites the line on Settings and it is saved where the riders\' page reads it', async ({ page }) => {
    await boot(page);
    const saved: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/site_content')) saved.push(r.postDataJSON()); });
    await page.evaluate(`setStaffTab('settings')`);
    const sec = page.locator('#tab-settings .set-card', { hasText: 'Message templates' });
    const grp = sec.locator('.tpl-grp', { hasText: 'Shown in the app' });
    await expect(grp.locator('.tpl-row')).toHaveCount(1);
    await expect(grp.locator('.tpl-row[data-tpl="lm_anniv"] span').first()).toHaveText('First ride anniversary message');
    await grp.locator('.tpl-row[data-tpl="lm_anniv"]').click();
    const ed = page.locator('#confirm-modal .tpl-box');
    await expect(ed.locator('#tpl-text')).toHaveValue('Thank you for riding with us. Here is to many more rides together.');
    await expect(ed.locator('.tpl-fill')).toHaveCount(0); // a plain line: nothing to fill in
    await expect(ed.locator('[data-tpl-lang]')).toHaveCount(10);
    await ed.locator('[data-tpl-lang="fr"]').click();
    await expect(ed.locator('#tpl-text')).toHaveValue(pack('fr').lmLine);
    await ed.locator('[data-tpl-lang="en"]').click();
    await ed.locator('#tpl-text').fill('Another year on the circuit with us. Thank you.');
    await ed.locator('#tpl-save').click();
    await expect.poll(() => saved.length).toBe(1);
    const body = saved[0] as { key: string; value: Record<string, Record<string, string>> };
    expect(body.key).toBe('msg.templates');
    expect(body.value).toEqual({ lm_anniv: { en: 'Another year on the circuit with us. Thank you.' } }); // French left as built in: nothing kept
    await expect(grp.locator('.tpl-row[data-tpl="lm_anniv"] .tpl-own')).toHaveText('Customized');
  });
});
