import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Ask in the Community tab (2026-11-13; the user: "add the asks questions in the community section in the bookings app"):
// the feed's "Have your say" card (member-hub.js, ask_list) and the page a member answers in the app (member-ask.js:
// ask_page, ask_live, ask_send, ask_unsend, ask_vote, ask_react). Supabase is stubbed; the rules are the database's
// (migration 20261113010000), so these check what the app sends and draws.

const sess = (id: string, date: string) => ({ id, day: 'Saturday', session_date: date, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' });
const sessions = [sess('2099-01-03', '2099-01-03')];
const feed = { ok: true, today: '2026-11-13', me: null, club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null };
const list = (pages: Record<string, unknown>[]) => ({ signed: true, pages });
const card = (slug: string, o: Record<string, unknown> = {}) => ({ slug, title_en: 'Farm day ideas', title_ar: 'أفكار يوم المزرعة', intro_en: '', intro_ar: '', opens_at: null, closes_at: null, questions: 1, answered: 0, ...o });
const q = (id: number, kind: string, o: Record<string, unknown> = {}) => ({ id, pos: id, kind, title_en: `Question ${id}`, title_ar: `السؤال ${id}`, help_en: '', help_ar: '', image: null, look: {}, config: {}, moderated: false, results: 'live', open: true, reveal: false, started_at: null, ...o });
type Doc = Record<string, unknown>;
const live = (o: Doc = {}) => ({ ok: true, ver: 1, now: new Date().toISOString(), state: 'ok', open: true, pace: 'self', current_q: null, round: 1, q: {}, results: {}, reactions: {}, stats: { answers: 0, people: 0 }, ...o });
const askPage = (questions: Doc[], o: Doc = {}, pg: Doc = {}) => ({
  state: 'ok', preview: false, signed: true, can_answer: true, now: new Date().toISOString(), rk: 'rk-1',
  page: { id: 1, slug: 'farm-ideas', code: '123456', title_en: 'Farm day ideas', title_ar: 'أفكار يوم المزرعة', intro_en: 'Tell us what you want on the farm day.', intro_ar: '', audience: 'link', pace: 'self', current_q: null, opens_at: null, closes_at: null, round: 1, look: {}, open: true, ...pg },
  questions, mine: {}, voted: [], reacted: {}, me: null, live: live(), ...o,
});
const rpcSent = (page: Page) => {
  const out: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rpc\/(\w+)/); if (m) { let b = {}; try { b = r.postDataJSON() || {}; } catch { /* none */ } out.push({ fn: m[1]!, body: b }); } });
  return out;
};
// ask_page and ask_live answer whatever the test holds now; ask_send answers by the test's rule.
async function member(page: Page, st: { list: Doc; page: Doc; live?: Doc; send?: (body: Doc) => Doc }, fx: Fixtures = {}, lang?: string) {
  await stubSupabase(page, { sessions, customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed, 'rpc:ask_unsend': { ok: true }, 'rpc:ask_vote': { ok: true, votes: 3 }, 'rpc:ask_react': { ok: true }, ...fx });
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/rest/v1/rpc/ask_list*', (r) => r.fulfill(json(st.list)));
  await page.route('**/rest/v1/rpc/ask_page*', (r) => r.fulfill(json(st.page)));
  await page.route('**/rest/v1/rpc/ask_live*', (r) => r.fulfill(json(st.live ?? (st.page as Doc).live)));
  await page.route('**/rest/v1/rpc/ask_send*', (r) => r.fulfill(json(st.send ? st.send(r.request().postDataJSON()) : { ok: true, status: 'approved', score: null, mine: [] })));
  await page.route('https://img.test/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#ccc"/></svg>' }));
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'female' });
  await page.goto('/');
  await waitForSb(page);
  if (lang) await page.evaluate(`setLang(${JSON.stringify(lang)})`);
  await page.evaluate(`setCustTab('members')`);
}
const openPage = async (page: Page, title = 'Farm day ideas') => {
  const c = page.locator('#hub-body .ak-card');
  await expect(c).toBeVisible();
  await c.locator('.ak-row', { hasText: title }).getByRole('button').click();
  await expect(page.locator('#ak-view #ak-title')).toHaveText(title);
};

test.describe('@customer:members Ask in the Community tab', () => {
  test('the card lists the open pages with how far the member got; the page file loads only when one opens', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('member-ask.js')) asked.push(r.url()); });
    await member(page, { list: list([card('farm-ideas', { questions: 3, answered: 1 }), card('ride-survey', { title_en: 'Saturday ride survey', title_ar: '', closes_at: '2099-01-03T18:00:00Z' })]), page: askPage([q(1, 'cloud')]) });
    const c = page.locator('#hub-body .ak-card');
    await expect(c).toContainText('Have your say');
    await expect(c.locator('.ak-row')).toHaveCount(2);
    await expect(c.locator('.ak-row').first()).toContainText('1 of 3 answered');
    await expect(c.locator('.ak-row').nth(1)).toContainText('Open until');
    await expect(c.locator('.ak-row').nth(1).getByRole('button')).toHaveText('Answer');
    expect(asked).toEqual([]);
    await openPage(page);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/member-ask\.js\?v=[a-f0-9]{10}$/);
    // every word of the page exists in all ten languages, with Latin digits only (tests/bh14-m.spec.ts's rule)
    const bad = await page.evaluate(`Object.entries(AK_T).filter(([k,v])=>v.length!==10||v.some(x=>!String(x).trim()||/[\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F\\u09E6-\\u09EF]/.test(x))).map(([k])=>k)`);
    expect(bad).toEqual([]);
    const badHub = await page.evaluate(`['akTitle','akGo','akOpen','akProg','akUntil'].filter(k=>!HUB_T[k]||HUB_T[k].length!==10)`);
    expect(badHub).toEqual([]);
  });

  test('no open page, or a database without Ask: no card', async ({ page }) => {
    await member(page, { list: list([]), page: askPage([]) });
    await expect(page.locator('#hub-body .hub-card').first()).toBeVisible();
    await expect(page.locator('#hub-body .ak-card')).toHaveCount(0);
  });

  test('a word cloud: typed, sent with Enter, waiting for approval, taken back; the approved words drawn', async ({ page }) => {
    const sent = rpcSent(page);
    const pg = askPage([q(7, 'cloud', { moderated: true, config: { max_len: 25, per_person: 3 } })], { live: live({ results: { 7: { n: 4, people: 3, words: [{ w: 'BBQ', n: 3 }, { w: 'Horses', n: 1 }] } } }) });
    await member(page, { list: list([card('farm-ideas')]), page: pg, send: (b) => ({ ok: true, status: 'pending', score: null, mine: [{ id: 91, value: { t: (b.p_value as Doc).t }, body: (b.p_value as Doc).t, status: 'pending', answered: false, score: null, created_at: '2026-11-13T10:00:00Z', votes: 0 }] }) });
    await openPage(page);
    await expect(page.locator('#ak-view')).toContainText('Your name is never shown with an answer');
    const res = page.locator('#ak-q-7 .ak-res');
    await expect(res).toContainText('4 answers');
    await expect(res.locator('.ak-w5')).toHaveText('BBQ (3)');
    const box = page.locator('#ak-in-7');
    await box.fill('Camel rides');
    await expect(page.locator('#ak-q-7 .ak-left')).toHaveText('14');
    await box.press('Enter');
    await expect.poll(() => sent.filter((x) => x.fn === 'ask_send').map((x) => [x.body.p_question, x.body.p_value, x.body.p_id, typeof x.body.p_token])).toEqual([[7, { t: 'Camel rides' }, 'c1', 'string']]);
    const mine = page.locator('#ak-q-7 .ak-mine-row');
    await expect(mine).toContainText('Camel rides');
    await expect(mine).toContainText('Waiting for approval');
    await expect(box).toHaveValue('');
    await expect(box).toBeFocused();
    await mine.getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => sent.filter((x) => x.fn === 'ask_unsend').map((x) => x.body.p_answer)).toEqual([91]);
    await expect(page.locator('#ak-q-7 .ak-mine-row')).toHaveCount(0);
  });

  test('what is being typed survives the page being polled and redrawn', async ({ page }) => {
    const st = { list: list([card('farm-ideas')]), page: askPage([q(7, 'open', { results: 'live' })]), live: live({ ver: 1 }) as Doc };
    await member(page, st);
    await openPage(page);
    await page.locator('#ak-in-7').fill('More shade');
    st.live = live({ ver: 2, results: { 7: { n: 1, items: [{ id: 5, t: 'Bring water', v: 2 }] } } });
    await page.evaluate('_akPollNow()');
    await expect(page.locator('#ak-q-7 .ak-texts')).toContainText('Bring water');
    await expect(page.locator('#ak-in-7')).toHaveValue('More shade');
    await expect(page.locator('#ak-in-7')).toBeFocused();
  });

  test('choice, scales, ranking, points, number and a form send the values the database checks', async ({ page }) => {
    const sent = rpcSent(page);
    const opts = [{ id: 'a', en: 'Bikes', ar: 'دراجات' }, { id: 'b', en: 'Kayaks', ar: 'قوارب' }, { id: 'c', en: 'Hiking', ar: 'مشي' }];
    const pg = askPage([
      q(1, 'choice', { config: { options: opts, max_picks: 2 } }),
      q(2, 'scales', { config: { options: [{ id: 's1', en: 'Route', ar: '' }, { id: 's2', en: 'Pace', ar: '' }], min: 1, max: 5, lo_en: 'Poor', hi_en: 'Great' } }),
      q(3, 'ranking', { config: { options: opts } }),
      q(4, 'points', { config: { options: opts.slice(0, 2), total: 10 } }),
      q(5, 'number', { config: { min: 0, max: 100, step: 1, unit_en: 'km' } }),
      q(6, 'form', { config: { fields: [{ id: 'nm', en: 'Team name', ar: '', type: 'text', required: true }, { id: 'sz', en: 'Size', ar: '', type: 'choice', options: [{ id: 's', en: 'Small', ar: '' }, { id: 'l', en: 'Large', ar: '' }], required: false }] } }),
    ]);
    await member(page, { list: list([card('farm-ideas', { questions: 6 })]), page: pg });
    await openPage(page);
    const values = () => sent.filter((x) => x.fn === 'ask_send').map((x) => [x.body.p_question, x.body.p_value]);
    // choice: two of three, in the order staff wrote them
    const q1 = page.locator('#ak-q-1');
    await q1.getByRole('checkbox', { name: 'Kayaks' }).click();
    await q1.getByRole('checkbox', { name: 'Bikes' }).click();
    await expect(q1.getByRole('checkbox', { name: 'Hiking' })).toBeDisabled();
    await q1.getByRole('button', { name: 'Send' }).click();
    // scales: Send waits for every statement
    const q2 = page.locator('#ak-q-2');
    await expect(q2.getByRole('button', { name: 'Send' })).toBeDisabled();
    await q2.locator('#ak-m-2-s1-4').click();
    await q2.locator('#ak-m-2-s2-2').click();
    await expect(q2).toContainText('Great');
    await q2.getByRole('button', { name: 'Send' }).click();
    // ranking: Hiking moved to the top
    const q3 = page.locator('#ak-q-3');
    await q3.getByRole('button', { name: 'Move Hiking up' }).click();
    await q3.getByRole('button', { name: 'Move Hiking up' }).click();
    await q3.getByRole('button', { name: 'Send' }).click();
    // points: 10 to share
    const q4 = page.locator('#ak-q-4');
    for (let i = 0; i < 3; i++) await q4.getByRole('button', { name: 'More points for Bikes' }).click();
    await expect(q4.locator('.ak-pleft')).toHaveText('7 left');
    await q4.locator('#ak-pb-4-b').fill('9');
    await expect(q4.locator('#ak-pb-4-b')).toHaveValue('7'); // never more than is left
    await q4.getByRole('button', { name: 'Send' }).click();
    // number: Arabic digits read as Latin; out of range said in words
    const q5 = page.locator('#ak-q-5');
    await q5.locator('#ak-in-5').fill('140');
    await q5.getByRole('button', { name: 'Send' }).click();
    await expect(q5.locator('.ak-err')).toHaveText('That answer does not fit the question.');
    await q5.locator('#ak-in-5').fill('٤٢');
    await q5.getByRole('button', { name: 'Send' }).click();
    // form: the required field first
    const q6 = page.locator('#ak-q-6');
    await q6.getByRole('button', { name: 'Send' }).click();
    await expect(q6.locator('.ak-err')).toHaveText('Type your answer first.');
    await q6.getByLabel(/Team name/).fill('Fast Falcons');
    await q6.getByRole('radio', { name: 'Large' }).click();
    await q6.getByRole('button', { name: 'Send' }).click();
    await expect.poll(values).toEqual([
      [1, { o: ['a', 'b'] }],
      [2, { s: { s1: 4, s2: 2 } }],
      [3, { r: ['c', 'a', 'b'] }],
      [4, { p: { a: 3, b: 7 } }],
      [5, { n: 42 }],
      [6, { f: { nm: 'Fast Falcons', sz: 'l' } }],
    ]);
  });

  test('an answer on file is shown back locked; results with "answered" wait for one', async ({ page }) => {
    const opts = [{ id: 'a', en: 'Yes', ar: 'نعم' }, { id: 'b', en: 'No', ar: 'لا' }];
    const pg = askPage([q(1, 'choice', { results: 'answered', config: { options: opts } }), q(2, 'choice', { results: 'answered', config: { options: opts } })], {
      mine: { 1: [{ id: 3, value: { o: ['b'] }, body: '', status: 'approved', answered: false, score: null, created_at: '2026-11-13T09:00:00Z', votes: 0 }] },
      live: live({ results: { 1: { n: 5, counts: { a: 2, b: 3 } }, 2: { n: 5, counts: { a: 5, b: 0 } } } }),
    });
    await member(page, { list: list([card('farm-ideas', { questions: 2, answered: 1 })]), page: pg });
    await openPage(page);
    const q1 = page.locator('#ak-q-1');
    await expect(q1.getByRole('radio', { name: 'No' })).toHaveAttribute('aria-checked', 'true');
    await expect(q1.getByRole('radio', { name: 'Yes' })).toBeDisabled();
    await expect(q1.getByRole('button', { name: 'Send' })).toHaveCount(0);
    await expect(q1.locator('.ak-bar').nth(1)).toContainText('3 · 60%');
    await expect(page.locator('#ak-q-2 .ak-res')).toHaveCount(0);
  });

  test('a quiz: one tap is the answer, the clock counts down, and the reveal says right with its points', async ({ page }) => {
    const sent = rpcSent(page);
    const opts = [{ id: 'a', en: 'Riyadh', ar: '' }, { id: 'b', en: 'Jeddah', ar: '' }];
    const started = new Date(Date.now() - 2000).toISOString();
    const st = {
      list: list([card('farm-ideas')]),
      page: askPage([q(4, 'quiz', { config: { options: opts, seconds: 20 }, started_at: started })]) as Doc,
      send: () => ({ ok: true, status: 'approved', score: 940, mine: [{ id: 50, value: { o: ['b'] }, body: '', status: 'approved', answered: false, score: 940, created_at: new Date().toISOString(), votes: 0 }] }),
    };
    await member(page, st);
    await openPage(page);
    await expect(page.locator('#ak-q-4 .ak-clock')).toBeVisible();
    await expect.poll(async () => Number(await page.locator('#ak-q-4 .ak-clock-n').textContent())).toBeLessThanOrEqual(18);
    await page.locator('#ak-q-4').getByRole('button', { name: 'Jeddah' }).click();
    await expect.poll(() => sent.filter((x) => x.fn === 'ask_send').map((x) => x.body.p_value)).toEqual([{ o: ['b'] }]);
    await expect(page.locator('#ak-q-4 .ak-own')).toHaveText('Answer sent');
    await expect(page.locator('#ak-q-4').getByRole('button', { name: /Riyadh/ })).toBeDisabled();
    // staff reveal: the page is read again (the member's score is the page's to say)
    st.page = askPage([q(4, 'quiz', { config: { options: opts, seconds: 20, correct: ['b'] }, started_at: started, open: false, reveal: true })], {
      mine: { 4: [{ id: 50, value: { o: ['b'] }, body: '', status: 'approved', answered: false, score: 940, created_at: '2026-11-13T10:00:00Z', votes: 0 }] },
      me: { score: 940, rank: 1, players: 12 },
      live: live({ ver: 5, q: { 4: { open: false, reveal: true, started_at: started } }, results: { 4: { n: 12, counts: { a: 4, b: 8 }, correct: ['b'] } } }),
    });
    await page.evaluate('S._ak.readAt=0;_akRead(true)');
    await expect(page.locator('#ak-me')).toHaveText('Your score 940 · place 1 of 12');
    await expect(page.locator('#ak-q-4 .ak-own')).toContainText('Correct');
    await expect(page.locator('#ak-q-4 .ak-own')).toContainText('940 points');
    await expect(page.locator('#ak-q-4 .ak-res')).toContainText('8 of 12 got it right');
  });

  test('a page staff pace shows only the question on screen and follows them', async ({ page }) => {
    const qs = [q(1, 'choice', { config: { options: [{ id: 'a', en: 'Up', ar: '' }, { id: 'b', en: 'Down', ar: '' }] } }), q(2, 'open')];
    const st = { list: list([card('farm-ideas')]), page: askPage([qs[0]!], { live: live({ pace: 'live', current_q: null }) }, { pace: 'live' }) as Doc, live: live({ ver: 1, pace: 'live', current_q: null }) as Doc };
    await member(page, st);
    await openPage(page);
    await expect(page.locator('#ak-view')).toContainText('Waiting for the next question');
    await expect(page.locator('#ak-view .ak-q')).toHaveCount(0);
    st.page = askPage(qs, { live: live({ ver: 2, pace: 'live', current_q: 2, q: { 1: { open: true, reveal: false, started_at: null }, 2: { open: true, reveal: false, started_at: new Date().toISOString() } } }) }, { pace: 'live', current_q: 2 });
    st.live = (st.page as Doc).live as Doc;
    await page.evaluate('_akPollNow()');
    await expect(page.locator('#ak-view .ak-q')).toHaveCount(1);
    await expect(page.locator('#ak-q-2')).toBeVisible();
  });

  test('a pin on the picture and a grid of items: placed with taps, sent as shares and values', async ({ page }) => {
    const sent = rpcSent(page);
    const pg = askPage([
      q(1, 'pin', { image: 'https://img.test/map.svg' }),
      q(2, 'grid', { config: { options: [{ id: 'x1', en: 'Shade', ar: '' }, { id: 'x2', en: 'Food', ar: '' }], max: 10, x_en: 'Effort', y_en: 'Fun' } }),
    ]);
    await member(page, { list: list([card('farm-ideas', { questions: 2 })]), page: pg });
    await openPage(page);
    const pin = page.locator('#ak-pa-1');
    const b = (await pin.boundingBox())!;
    await pin.click({ position: { x: b.width * 0.25, y: b.height * 0.5 } });
    await expect(page.locator('#ak-q-1 .ak-pm')).toBeVisible();
    await page.locator('#ak-q-1').getByRole('button', { name: 'Send' }).click();
    const area = page.locator('#ak-ga-2');
    await expect(page.locator('#ak-q-2').getByRole('button', { name: 'Send' })).toBeDisabled();
    const g = (await area.boundingBox())!;
    await area.click({ position: { x: g.width * 0.8, y: g.height * 0.2 } });
    await area.click({ position: { x: g.width * 0.1, y: g.height * 0.9 } });
    await page.locator('#ak-q-2').getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => sent.filter((x) => x.fn === 'ask_send').map((x) => [x.body.p_question, x.body.p_value])).toEqual([
      [1, { x: expect.closeTo(0.25, 1), y: expect.closeTo(0.5, 1) }],
      [2, { g: { x1: [8, 8], x2: [1, 1] } }],
    ]);
  });

  test('upvotes on someone else\'s answer and reactions when the page has them', async ({ page }) => {
    const sent = rpcSent(page);
    const pg = askPage([q(3, 'qa')], {
      live: live({ results: { 3: { n: 2, items: [{ id: 21, t: 'Will there be parking?', v: 2, a: false }, { id: 22, t: 'What time?', v: 0, a: true }] } }, reactions: { 3: { love: 2 } } }),
    }, { look: { reactions: true } });
    await member(page, { list: list([card('farm-ideas')]), page: pg });
    await openPage(page);
    const items = page.locator('#ak-q-3 .ak-text');
    await expect(items.nth(1)).toContainText('Answered');
    await items.first().getByRole('button', { name: 'Upvote (2)' }).click();
    await expect.poll(() => sent.filter((x) => x.fn === 'ask_vote').map((x) => [x.body.p_answer, x.body.p_on])).toEqual([[21, true]]);
    await expect(items.first().locator('.ak-vote')).toHaveAttribute('aria-pressed', 'true');
    await expect(items.first().locator('.ak-vote')).toContainText('3');
    const love = page.locator('#ak-re-3-love');
    await expect(love).toHaveAttribute('aria-label', 'Love (2)');
    await love.click();
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(love).toHaveAttribute('aria-label', 'Love (3)');
    await expect.poll(() => sent.filter((x) => x.fn === 'ask_react').map((x) => [x.body.p_question, x.body.p_kind, x.body.p_on])).toEqual([[3, 'love', true]]);
    // nothing on the page names anyone
    await expect(page.locator('#ak-view')).not.toContainText('Lina');
  });

  test('a refused answer is said in words; a page for other accounts says so; Close goes back to the feed', async ({ page }) => {
    const st = { list: list([card('farm-ideas'), card('members-only', { title_en: 'Members only' })]), page: askPage([q(1, 'open')]) as Doc, send: () => ({ ok: false, error: 'limit' }) };
    await member(page, st);
    await openPage(page);
    await page.locator('#ak-in-1').fill('Another idea');
    await page.locator('#ak-q-1').getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('#ak-q-1 .ak-err')).toHaveText('You have sent all your answers to this question.');
    await page.locator('#ak-view').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#ak-view')).toHaveCount(0);
    await expect(page.locator('#hub-body .ak-card')).toBeVisible();
    st.page = { state: 'audience' };
    await page.locator('#hub-body .ak-row', { hasText: 'Members only' }).getByRole('button').click();
    await expect(page.locator('#ak-view')).toContainText('This page is not open to your account.');
  });

  test('in Arabic: the page\'s own Arabic words, and no sideways scroll on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const pg = askPage([q(1, 'scales', { config: { options: [{ id: 's1', en: 'Route', ar: 'المسار' }], min: 1, max: 10 } }), q(2, 'quiz_text', { config: { accept: ['Jeddah'], seconds: 30 } })]);
    await member(page, { list: list([card('farm-ideas')]), page: pg }, {}, 'ar');
    await openPage(page, 'أفكار يوم المزرعة');
    await expect(page.locator('#ak-q-1')).toContainText('المسار');
    await expect(page.locator('#ak-q-1 .ak-send')).toHaveText('إرسال');
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
  });
});
