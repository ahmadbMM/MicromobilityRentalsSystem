import { test, expect, type Page, type Request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, unlockStaff, waitForSb, staffReady, type Fixtures } from './helpers/supabase';

// Ask (the owner, 2026-11-13; migration 20261113010000): questions put to an audience under one link,
// micromobility.sa/ask. Staff make a page that holds one or more questions, say who sees it and for how long, approve the
// written answers before they show and read who wrote what. The staff section is /ask, a part of its own that comes
// with People; the riders' pages are the website's. All Supabase traffic is stubbed: the functions answer from the
// fixtures below (the shapes of the contract), and a spec that needs the database to move answers a route itself.

const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const inDays = (d: number) => new Date(Date.now() + d * 864e5).toISOString();
const tags = [
  { id: 'tag_saturday', name: 'Community', slug: 'saturday', color: '#0c7a3d', system: true },
  { id: 'tag_vip', name: 'VIP', slug: 'vip', color: '#a67c00', system: true },
  { id: 'tag_blacklist', name: 'Blacklist', slug: 'blacklist', color: '#0b0b0b', system: true },
  { id: 'tag_team', name: 'Race team', slug: 'race_team', color: '#3355aa', system: false },
];
type Row = Record<string, unknown>;
const pageRow = (o: Row = {}): Row => ({ id: 1, slug: 'farm-ideas', code: '482913', title_en: 'What would you like to see at the farm?', title_ar: '',
  intro_en: 'A private farm with a big garden.', intro_ar: '', audience: 'link', tag_ids: [], status: 'live', opens_at: null, closes_at: inDays(5),
  after_close: 'results', pace: 'self', current_q: null, listed: true, round: 1, notes: '', look: {}, ver: 12, created_at: ago(3000), created_by: 'Malik',
  updated_at: ago(30), updated_by: 'Malik', open: true, questions: 10, answers: 37, people: 21, pending: 5, ...o });
const pages = () => [
  pageRow(),
  pageRow({ id: 2, slug: 'night-ride-poll', code: '110204', title_en: 'Which night ride next month?', status: 'draft', closes_at: null, open: false, questions: 1,
    answers: 0, people: 0, pending: 0, audience: 'tags', tag_ids: ['tag_saturday', 'tag_vip'] }),
  pageRow({ id: 3, slug: 'october-feedback', code: '774411', title_en: 'October feedback', status: 'ended', closes_at: ago(9000), open: false, questions: 3,
    answers: 112, people: 64, pending: 0, audience: 'accounts' }),
  pageRow({ id: 4, slug: 'kit-colours', code: '330022', title_en: 'Pick the new kit colours', opens_at: inDays(2), closes_at: inDays(9), open: false, questions: 2,
    answers: 0, people: 0, pending: 0 }),
];
const opt = (id: string, en: string, ar = '') => ({ id, en, ar });
const qRow = (o: Row): Row => ({ page_id: 1, title_ar: '', help_en: '', help_ar: '', image: null, moderated: true, results: 'live', open: true, reveal: false,
  started_at: null, look: {}, answers: 0, pending: 0, ...o });
const questions = () => [
  qRow({ id: 11, pos: 1, kind: 'cloud', title_en: 'Your ideas', config: { max_len: 40, per_person: 10 }, answers: 6, pending: 4,
    result: { n: 2, people: 2, words: [{ w: 'BBQ', n: 6 }, { w: 'pony rides', n: 4 }, { w: 'bonfire', n: 1 }] } }),
  qRow({ id: 12, pos: 2, kind: 'choice', title_en: 'Which day suits you?', config: { options: [opt('a1', 'Thursday', 'الخميس'), opt('a2', 'Friday'), opt('a3', 'Saturday')], max_picks: 1, change: false },
    answers: 9, result: { n: 9, counts: { a1: 5, a2: 1, a3: 3 } } }),
  qRow({ id: 13, pos: 3, kind: 'scales', title_en: 'Rate the last ride', config: { options: [opt('a1', 'Route'), opt('a2', 'Pace'), opt('a3', 'Organisation')], min: 1, max: 5, lo_en: 'Poor', lo_ar: '', hi_en: 'Great', hi_ar: '', skip: false },
    answers: 4, result: { n: 4, avg: { a1: 4.5, a2: 3.2, a3: 4 }, dist: {} } }),
  qRow({ id: 14, pos: 4, kind: 'ranking', title_en: 'Order the activities', config: { options: [opt('a1', 'Feeding the animals'), opt('a2', 'Garden games'), opt('a3', 'Barbecue')] },
    answers: 3, result: { n: 3, score: { a1: 7, a2: 4, a3: 6 }, pos: { a1: 1.7, a2: 2.7, a3: 2 } } }),
  qRow({ id: 15, pos: 5, kind: 'points', title_en: 'Share 100 points', config: { options: [opt('a1', 'Food'), opt('a2', 'Games'), opt('a3', 'Transport')], total: 100 },
    answers: 3, result: { n: 3, sum: { a1: 150, a2: 90, a3: 60 }, avg: { a1: 50, a2: 30, a3: 20 } } }),
  qRow({ id: 16, pos: 6, kind: 'number', title_en: 'How many people are you bringing?', config: { min: 0, max: 10, step: 1, unit_en: 'people', unit_ar: '' },
    answers: 4, result: { n: 4, avg: 2.5, min: 1, max: 5, bins: [{ lo: 0, hi: 2, n: 1 }, { lo: 2, hi: 4, n: 2 }, { lo: 4, hi: 6, n: 1 }, { lo: 6, hi: 8, n: 0 }, { lo: 8, hi: 10, n: 0 }] } }),
  qRow({ id: 17, pos: 7, kind: 'qa', title_en: 'Ask the organisers', config: { max_len: 200, per_person: 3, votes: true }, answers: 2, pending: 1,
    result: { n: 1, items: [{ id: 109, t: 'Is there parking at the farm?', v: 4, a: true }] } }),
  qRow({ id: 18, pos: 8, kind: 'open', title_en: 'Anything else?', config: { max_len: 200, per_person: 1, votes: false }, answers: 1,
    result: { n: 1, items: [{ id: 107, t: 'Shade for the little ones, please', v: 0 }] } }),
  qRow({ id: 19, pos: 9, kind: 'info', title_en: 'Thank you!', help_en: 'See you on Thursday.', config: {} }),
  qRow({ id: 20, pos: 10, kind: 'grid', title_en: 'A kind these screens do not draw yet', config: { options: [] }, answers: 1 }), // stage 2: left undrawn
];
const detail = (): { page: Row; questions: Row[]; board: Row[] } => ({ page: { ...pageRow(), screen_key: 'sk_9f2c7a' }, questions: questions(), board: [] });
const ans = (id: number, qid: number, name: string, phone: string, value: Row, o: Row = {}): Row => ({ id, question_id: qid, round: 1, customer_id: 'c' + (id % 5),
  name, phone, value, body: typeof value.t === 'string' ? value.t : null, status: 'approved', answered: false, flagged: false, score: null, ms: null, votes: 0,
  lang: 'en', created_at: ago(200 - id), reviewed_by: null, reviewed_at: null, ...o });
// newest first, as the function answers; five wait (116 is the oldest of them)
const answers = () => [
  ans(120, 11, 'Lina Haddad', '+966551112222', { t: 'kite flying' }, { status: 'pending' }),
  ans(119, 11, 'Omar Saleh', '+966553334444', { t: 'bonfire and marshmallows' }, { status: 'pending' }),
  ans(118, 17, 'Sara Ali', '+966555556666', { t: 'Will there be a prayer area?' }, { status: 'pending' }),
  ans(117, 11, 'Yousef Karim', '+966557778888', { t: 'free crypto visit my site' }, { status: 'pending', flagged: true }),
  ans(116, 11, 'Noura Fahad', '+966559990000', { t: 'pony rides' }, { status: 'pending' }),
  ans(115, 11, 'Lina Haddad', '+966551112222', { t: 'BBQ' }),
  ans(114, 12, 'Omar Saleh', '+966553334444', { o: ['a1'] }),
  ans(113, 13, 'Sara Ali', '+966555556666', { s: { a1: 5, a2: 3, a3: 4 } }),
  ans(112, 14, 'Yousef Karim', '+966557778888', { r: ['a3', 'a1', 'a2'] }),
  ans(111, 15, 'Noura Fahad', '+966559990000', { p: { a1: 50, a2: 30, a3: 20 } }),
  ans(110, 16, 'Lina Haddad', '+966551112222', { n: 3 }),
  ans(109, 17, 'Omar Saleh', '+966553334444', { t: 'Is there parking at the farm?' }, { answered: true, votes: 4 }),
  ans(108, 11, 'Sara Ali', '+966555556666', { t: 'something rude' }, { status: 'rejected', reviewed_by: 'Malik' }),
  ans(107, 18, 'Yousef Karim', '+966557778888', { t: 'Shade for the little ones, please' }),
  ans(106, 20, 'Noura Fahad', '+966559990000', { g: { a1: [1, 2] } }), // an answer of the undrawn kind
];
const base = (): Fixtures => ({ sessions: [], queue_entries: [], bikes: [], customers: [], tags, customer_tags: [], staff_options: [],
  'rpc:staff_ask_pages': pages(), 'rpc:staff_ask_page': detail(), 'rpc:staff_ask_answers': answers(), 'rpc:staff_ask_pending': 5 });

const HEAD = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const json = (body: unknown, status = 200) => ({ status, headers: HEAD, body: JSON.stringify(body) });
/** Every request that is not a read, to a path of the database: [method, table or function, body, query]. */
function writes(page: Page, re: RegExp) {
  const out: { m: string; path: string; body: Row; q: string }[] = [];
  page.on('request', (r: Request) => {
    const u = new URL(r.url());
    if (r.method() === 'GET' || r.method() === 'HEAD' || r.method() === 'OPTIONS' || !re.test(u.pathname)) return;
    let body: Row = {};
    try { body = (r.postDataJSON() || {}) as Row; } catch { /* a delete has none */ }
    out.push({ m: r.method(), path: u.pathname.replace(/^.*\/rest\/v1\//, ''), body, q: u.search });
  });
  return out;
}
async function staff(page: Page, fx: Fixtures = {}, init: Record<string, string> = {}) {
  await stubSupabase(page, { ...base(), ...fx });
  await unlockStaff(page);
  await page.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, init);
  await page.goto('/ask');
  await waitForSb(page);
  await page.waitForFunction(`S.view==='staff'&&S.staffTab==='ask'`);
}
const sec = (page: Page) => page.locator('#tab-ask');
const rail = (page: Page) => page.locator('#staff-tab-nav .tab-btn[data-stab="ask"]');
const row = (page: Page, id: number) => sec(page).locator(`.ask-pg[data-ask-pg="${id}"]`);
const answer = (page: Page, id: number) => sec(page).locator(`.ask-a[data-ask-a="${id}"]`);
const pop = (page: Page) => page.locator('#ask-pop [role="dialog"]');
const confirmBox = (page: Page) => page.locator('#confirm-modal [role="dialog"]');
/** Opens a page of the list on one of its three tabs. */
async function openPage(page: Page, id: number, tab: 'setup' | 'answers' | 'results') {
  await row(page, id).waitFor();
  await page.evaluate(`_askOpen(${id},'${tab}')`);
  await sec(page).locator(tab === 'setup' ? '.ask-setup' : tab === 'answers' ? '#ask-as' : '.ask-share').waitFor();
}

test.describe('@staff:ask Ask: questions put to an audience', () => {
  test('the address /ask opens the section: the pages from staff_ask_pages, the answers waiting on the rail, the state filter behind Filters', async ({ page }) => {
    await staff(page);
    expect(new URL(page.url()).pathname).toBe('/ask');
    await expect(rail(page)).toHaveAttribute('aria-current', 'page');
    await expect(rail(page).locator('.snav-lbl')).toContainText('Ask');
    await expect(rail(page).locator('.tab-badge')).toHaveText('5'); // staff_ask_pending
    await expect(rail(page).locator('.tab-badge')).toHaveAttribute('title', '5 waiting for approval');
    await expect(rail(page).locator('.snav-ico svg')).toHaveCount(1);
    await expect(sec(page).locator('h1')).toHaveText('Ask');
    await expect(sec(page).locator('.ask-pg')).toHaveCount(4);
    // a page: its title, its link with Copy, its state, who sees it, when it closes, the answers and the people, what waits
    const farm = row(page, 1);
    await expect(farm.locator('.ask-pg-t')).toHaveText('What would you like to see at the farm?');
    await expect(farm.locator('.ask-link bdi')).toHaveText('micromobility.sa/ask/farm-ideas');
    await expect(farm.locator('.ask-st')).toHaveText('Open');
    await expect(farm.locator('.ask-pg-meta')).toContainText('Anyone with the link');
    await expect(farm.locator('.ask-pg-meta')).toContainText('Closes ');
    await expect(farm.locator('.ask-pg-meta')).toContainText('Answers 37');
    await expect(farm.locator('.ask-pg-meta')).toContainText('People 21');
    await expect(farm.locator('.ask-pend')).toHaveText('Waiting for approval 5');
    await expect(row(page, 2).locator('.ask-st')).toHaveText('Draft');
    await expect(row(page, 2).locator('.ask-pg-meta')).toContainText('Accounts with a tag: Community, VIP'); // the tags' names, once they have come
    await expect(row(page, 2).locator('.ask-pg-meta')).toContainText('No end');
    await expect(row(page, 2).locator('.ask-pend')).toHaveCount(0);
    await expect(row(page, 3).locator('.ask-st')).toHaveText('Closed');
    await expect(row(page, 3).locator('.ask-pg-meta')).toContainText('Signed-in accounts');
    await expect(row(page, 4).locator('.ask-st')).toContainText('Opens ');
    // Copy puts the whole address on the clipboard
    await page.evaluate(`window.__copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:(t)=>{window.__copied=t;return Promise.resolve();}}})`);
    await farm.getByRole('button', { name: 'Copy micromobility.sa/ask/farm-ideas' }).click();
    await expect.poll(() => page.evaluate(`window.__copied`)).toBe('https://micromobility.sa/ask/farm-ideas');
    // the state filter sits behind the Filters button, which counts it and clears it
    const filters = sec(page).locator('[aria-controls="fm-ask"]');
    await expect(sec(page).locator('#fm-ask')).not.toBeVisible();
    await filters.click();
    await sec(page).locator('#fm-ask select').selectOption('draft');
    await expect(sec(page).locator('.ask-pg')).toHaveCount(1);
    await expect(row(page, 2)).toBeVisible();
    await expect(sec(page).locator('[aria-controls="fm-ask"]')).toContainText('(1)');
    await sec(page).locator('#fm-ask select').selectOption('soon');
    await expect(sec(page).locator('.ask-pg')).toHaveCount(1);
    await expect(row(page, 4)).toBeVisible();
    await sec(page).locator('#fm-ask select').selectOption('closed');
    await expect(row(page, 3)).toBeVisible();
    await sec(page).locator('.f-clr[data-f-clr="ask"]').click();
    await expect(sec(page).locator('.ask-pg')).toHaveCount(4);
    await expect(sec(page).getByRole('button', { name: 'New question' })).toBeVisible();
    // the waiting mark opens the page on its answers
    await farm.locator('.ask-pend').click();
    await expect(sec(page).locator('.filter-pill[data-ask-tab="answers"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(sec(page).locator('.filter-pill[data-ask-at="pending"]')).toHaveText('Waiting (5)');
  });

  test('New question: a word cloud is ready, so a title and Start write the page and its question and put it live; Save alone keeps a draft', async ({ page }) => {
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/(ask_pages|ask_questions|rpc\/staff_ask_control)$/);
    // the database: the page and the question it was sent, with their ids; live once started
    let made: Row | null = null, madeQ: Row | null = null, live = false;
    await page.route(/\/rest\/v1\/ask_pages(\?|$)/, (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      made = { ...(r.request().postDataJSON() as Row), id: 77, code: '654321', round: 1 };
      return r.fulfill(json([made], 201));
    });
    await page.route(/\/rest\/v1\/ask_questions(\?|$)/, (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      madeQ = { ...(r.request().postDataJSON() as Row), id: 501 };
      return r.fulfill(json([madeQ], 201));
    });
    await page.route(/\/rest\/v1\/rpc\/staff_ask_control$/, (r) => { live = true; return r.fulfill(json({ ok: true })); });
    await page.route(/\/rest\/v1\/rpc\/staff_ask_page$/, (r) => r.fulfill(json({ page: { ...made, status: live ? 'live' : 'draft', open: live, screen_key: 'sk_new' },
      questions: [{ ...madeQ, image: null, reveal: false, started_at: null, answers: 0, pending: 0, result: { n: 0, people: 0, words: [] } }], board: [] })));

    await sec(page).getByRole('button', { name: 'New question' }).click();
    await expect(sec(page).locator('h1')).toHaveText('New question');
    await expect(sec(page).locator('.ask-st')).toHaveText('Draft');
    await expect(page.locator('#ask-title-en')).toBeFocused();
    await expect(sec(page).locator('.ask-q')).toHaveCount(1);
    await expect(sec(page).locator('.ask-q .ask-q-txt b')).toHaveText('Word cloud');
    await expect(sec(page).locator('.filter-pill[data-ask-tab]')).toHaveCount(0); // nothing to answer or count yet
    // the link name is suggested from the English title
    await page.locator('#ask-title-en').fill('Farm day: your ideas!');
    await expect(page.locator('#ask-slug')).toHaveValue('farm-day-your-ideas');
    await expect(sec(page).locator('#ask-dirty')).toBeVisible();
    await expect(sec(page).locator('.ask-q .ask-q-txt b')).toHaveText('Word cloud');

    // Save: the page as a draft, then its question, and nothing started
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[0]).toMatchObject({ m: 'POST', path: 'ask_pages' });
    expect(sent[0].body).toEqual({ title_en: 'Farm day: your ideas!', title_ar: '', intro_en: '', intro_ar: '', slug: 'farm-day-your-ideas', audience: 'link', tag_ids: [],
      opens_at: null, closes_at: null, after_close: 'results', listed: true, notes: '', look: {}, status: 'draft', pace: 'self' }); // no code (the database makes it), no theme
    expect(sent[1]).toMatchObject({ m: 'POST', path: 'ask_questions' });
    expect(sent[1].body).toEqual({ kind: 'cloud', pos: 1, title_en: 'Farm day: your ideas!', title_ar: '', help_en: '', help_ar: '', config: { max_len: 25, per_person: 3 },
      moderated: true, results: 'live', look: {}, page_id: 77, open: true }); // a question with no words of its own takes the page's title
    await expect(sec(page).locator('.filter-pill[data-ask-tab]')).toHaveCount(3);
    await expect(sec(page).locator('.ask-st')).toHaveText('Draft');
    await expect(sec(page).locator('#ask-dirty')).toBeHidden();
    await expect(sec(page).locator('h1')).toHaveText('Farm day: your ideas!');

    // Start: nothing changed, so nothing is written again; the page goes live
    await sec(page).locator('.ask-start').click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2]).toMatchObject({ m: 'POST', path: 'rpc/staff_ask_control', body: { p_page: 77, p_action: 'start' } });
    await expect(sec(page).locator('.ask-st')).toHaveText('Open');
    await expect(sec(page).locator('.ask-end')).toBeVisible();
    await expect(sec(page).locator('.ask-start')).toHaveCount(0);
    await expect(page.locator('.toast:not(.quiet), #err-bar-el')).toHaveCount(0); // a done action draws no bar
    expect(sent).toHaveLength(3);
  });

  test('Start on a new page saves it first; a link name another page has says so on the field; a title is asked for', async ({ page }) => {
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/(ask_pages|ask_questions|rpc\/staff_ask_control)$/);
    let taken = true;
    await page.route(/\/rest\/v1\/ask_pages(\?|$)/, (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      if (taken) return r.fulfill(json({ code: '23505', message: 'duplicate key value violates unique constraint "ask_pages_slug_key"', details: 'Key (slug)=(farm-ideas) already exists.', hint: null }, 409));
      return r.fulfill(json([{ ...(r.request().postDataJSON() as Row), id: 78, code: '111222', round: 1 }], 201));
    });
    await page.route(/\/rest\/v1\/ask_questions(\?|$)/, (r) => (r.request().method() === 'POST' ? r.fulfill(json([{ ...(r.request().postDataJSON() as Row), id: 502 }], 201)) : r.fallback()));
    await sec(page).getByRole('button', { name: 'New question' }).click();
    // no title: said on the field, nothing sent
    await sec(page).locator('.ask-start').click();
    await expect(page.locator('#ask-title-en-e')).toHaveText('Write a title in English or Arabic.');
    await expect(page.locator('#ask-title-en')).toHaveAttribute('aria-invalid', 'true');
    expect(sent).toHaveLength(0);
    await page.locator('#ask-title-en').fill('Farm ideas');
    await expect(page.locator('#ask-title-en-e')).toHaveCount(0);
    await expect(page.locator('#ask-slug')).toHaveValue('farm-ideas');
    // the name is taken: the database's 23505 in the section's words, on the field, and no question written
    await sec(page).locator('.ask-start').click();
    await expect(page.locator('#ask-slug-e')).toHaveText('This link name is taken');
    await expect(page.locator('#ask-slug')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#ask-slug')).toBeFocused();
    await expect(page.locator('.toast.error').last()).toHaveText('This link name is taken');
    expect(sent.map((s) => s.path)).toEqual(['ask_pages']);
    // a name of the person's own: lower-case letters, digits and dashes only
    await page.locator('#ask-slug').fill('Farm Ideas 2026!');
    await expect(page.locator('#ask-slug')).toHaveValue('farm-ideas-2026-');
    await expect(page.locator('#ask-slug-e')).toHaveCount(0);
    taken = false;
    await sec(page).locator('.ask-start').click();
    await expect.poll(() => sent.map((s) => s.path)).toEqual(['ask_pages', 'ask_pages', 'ask_questions', 'rpc/staff_ask_control']);
    expect(sent[1].body.slug).toBe('farm-ideas-2026'); // the dash at its end is dropped
    expect(sent[3].body).toEqual({ p_page: 78, p_action: 'start' });
  });

  test('the question pop-up: nine kinds each with its mark, the settings of a kind, options with their ids, and what a kind needs before Done', async ({ page }) => {
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/(ask_pages|ask_questions)$/);
    await page.route(/\/rest\/v1\/ask_pages(\?|$)/, (r) => (r.request().method() === 'POST' ? r.fulfill(json([{ ...(r.request().postDataJSON() as Row), id: 79, code: '111333', round: 1 }], 201)) : r.fallback()));
    await sec(page).getByRole('button', { name: 'New question' }).click();
    await page.locator('#ask-title-en').fill('Farm day');
    await sec(page).getByRole('button', { name: 'Add question' }).click();
    await expect(pop(page)).toHaveAttribute('aria-labelledby', 'ask-q-t');
    await expect(pop(page).locator('#ask-q-t')).toHaveText('Add question');
    // centred, never a sheet at the foot of the screen (once its entry animation has played)
    const vp = page.viewportSize()!;
    await expect.poll(async () => { const b = (await pop(page).boundingBox())!; return Math.max(Math.abs(b.x + b.width / 2 - vp.width / 2), Math.abs(b.y + b.height / 2 - vp.height / 2)); }).toBeLessThan(3);
    await expect(pop(page).locator('.ask-kind')).toHaveText(['Word cloud', 'Open answers', 'Questions from people', 'Multiple choice', 'Scales', 'Ranking', '100 points', 'Number', 'Text slide']);
    expect(await pop(page).locator('.ask-kind svg').count()).toBe(9);
    await expect(pop(page).locator('.ask-kind[data-ask-kind="cloud"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(pop(page).locator('.ask-kind[data-ask-kind="cloud"]')).toBeFocused();
    // a word cloud: the longest answer, how many each, approval on, who sees the results
    await expect(page.locator('#ask-c-max_len')).toHaveValue('25');
    await expect(page.locator('#ask-c-per_person')).toHaveValue('3');
    await expect(page.locator('#ask-q-mod')).toBeChecked();
    await expect(page.locator('#ask-q-res option')).toHaveText(['At once', 'After answering', 'After it closes', 'Staff only']);
    // the other kinds' settings
    await pop(page).locator('.ask-kind[data-ask-kind="qa"]').click();
    await expect(page.locator('#ask-c-votes')).toBeChecked();
    await expect(page.locator('#ask-c-max_len')).toHaveValue('200');
    await pop(page).locator('.ask-kind[data-ask-kind="scales"]').click();
    await expect(pop(page).locator('#ask-o-l')).toHaveText('Statements');
    await expect(page.locator('#ask-c-min')).toHaveValue('1');
    await expect(page.locator('#ask-c-max')).toHaveValue('5');
    await expect(page.locator('#ask-c-lo_en, #ask-c-lo_ar, #ask-c-hi_en, #ask-c-hi_ar')).toHaveCount(4);
    await expect(page.locator('#ask-q-mod')).toHaveCount(0); // approval is for written answers
    await pop(page).locator('.ask-kind[data-ask-kind="points"]').click();
    await expect(page.locator('#ask-c-total')).toHaveValue('100');
    await pop(page).locator('.ask-kind[data-ask-kind="number"]').click();
    await expect(page.locator('#ask-c-min, #ask-c-max, #ask-c-step, #ask-c-unit_en, #ask-c-unit_ar')).toHaveCount(5);
    await page.locator('#ask-c-min').fill('10');
    await page.locator('#ask-c-max').fill('5');
    await page.locator('#ask-q-done').click();
    await expect(page.locator('#ask-q-err')).toHaveText('The largest number must be above the smallest.');
    await pop(page).locator('.ask-kind[data-ask-kind="info"]').click();
    await expect(page.locator('#ask-q-res')).toHaveCount(0); // a slide takes no answers
    await expect(pop(page).locator('.ask-o')).toHaveCount(0);
    // multiple choice: two options to start, a third added, put second; each keeps the id it was given
    await pop(page).locator('.ask-kind[data-ask-kind="choice"]').click();
    await expect(pop(page).locator('#ask-o-l')).toHaveText('Options');
    await expect(pop(page).locator('.ask-o')).toHaveCount(2);
    await page.locator('#ask-q-title-en').fill('Which day suits you?');
    await page.locator('#ask-q-done').click();
    await expect(page.locator('#ask-q-err')).toHaveText('Fill in every option, or remove it.');
    await page.getByRole('textbox', { name: 'Option 1, English' }).fill('Thursday');
    await page.getByRole('textbox', { name: 'Option 1, Arabic' }).fill('الخميس');
    await page.getByRole('textbox', { name: 'Option 2, English' }).fill(' Friday ');
    await pop(page).getByRole('button', { name: 'Add option' }).click();
    await expect(page.locator('#ask-o-en-2')).toBeFocused();
    await page.locator('#ask-o-en-2').fill('Saturday');
    await pop(page).getByRole('button', { name: 'Move up 3' }).click();
    await expect(page.locator('#ask-o-en-1')).toHaveValue('Saturday');
    await expect(pop(page).getByRole('button', { name: 'Remove 1' })).toBeEnabled();
    await page.locator('#ask-c-max_picks').fill('2');
    await page.locator('#ask-c-change').check();
    await page.locator('#ask-q-res').selectOption('closed');
    await page.locator('#ask-q-done').click();
    await expect(pop(page)).toHaveCount(0);
    await expect(sec(page).locator('.ask-q')).toHaveCount(2);
    await expect(sec(page).locator('.ask-q').nth(1).locator('.ask-q-txt b')).toHaveText('Which day suits you?');
    await expect(sec(page).locator('.ask-q').nth(1).locator('.ask-q-txt .am-meta')).toHaveText('Multiple choice');
    await expect(sec(page).locator('.ask-q').nth(1).locator('.ask-q-ed')).toBeFocused();
    // Edit opens it again as it was left; a click outside the box closes it only while nothing was typed
    await sec(page).locator('.ask-q').nth(1).locator('.ask-q-ed').click();
    await expect(pop(page).locator('#ask-q-t')).toHaveText('Edit question');
    await expect(page.locator('#ask-o-en-1')).toHaveValue('Saturday');
    await page.keyboard.press('Escape');
    await expect(pop(page)).toHaveCount(0);
    // Save writes both questions in order, the second with its options
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent.map((s) => s.path)).toEqual(['ask_pages', 'ask_questions', 'ask_questions']);
    expect(sent[1].body).toMatchObject({ kind: 'cloud', pos: 1, page_id: 79 });
    expect(sent[2].body).toEqual({ kind: 'choice', pos: 2, title_en: 'Which day suits you?', title_ar: '', help_en: '', help_ar: '',
      config: { options: [{ id: 'a1', en: 'Thursday', ar: 'الخميس' }, { id: 'a3', en: 'Saturday', ar: '' }, { id: 'a2', en: 'Friday', ar: '' }], max_picks: 2, change: true },
      moderated: true, results: 'closed', look: {}, page_id: 79, open: true });
  });

  test('Answers: Waiting approves and rejects through staff_ask_review, one and several at once; a refusal puts the row back; a new answer shows without a reload', async ({ page }) => {
    test.setTimeout(60_000);
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/rpc\/staff_ask_review$/);
    // the database: what staff_ask_review changes is what staff_ask_answers answers next
    const db = answers();
    let refuse = false;
    await page.route(/\/rest\/v1\/rpc\/staff_ask_answers$/, (r) => r.fulfill(json(db)));
    await page.route(/\/rest\/v1\/rpc\/staff_ask_review$/, (r) => {
      if (refuse) return r.fulfill(json({ code: '42501', message: 'FORBIDDEN', details: null, hint: null }, 403));
      const b = r.request().postDataJSON() as { p_ids: number[]; p_status: string };
      db.forEach((a) => { if (b.p_ids.includes(a.id as number)) a.status = b.p_status; });
      return r.fulfill(json(b.p_ids.length));
    });
    await openPage(page, 1, 'answers');
    const pill = (k: string) => sec(page).locator(`.filter-pill[data-ask-at="${k}"]`);
    await expect(pill('pending')).toHaveText('Waiting (5)');
    await expect(pill('approved')).toHaveText('Approved (8)');
    await expect(pill('rejected')).toHaveText('Not approved (1)');
    await expect(pill('all')).toHaveText('All (14)'); // the answer of a kind these screens do not draw is left out
    await expect(sec(page).locator('.filter-pill[data-ask-tab="answers"] .tab-badge')).toHaveText('5');
    // the longest wait first; each row: the words, who wrote them (the name and the number in full), when, and the question
    await expect(sec(page).locator('.ask-a')).toHaveCount(5);
    expect(await sec(page).locator('.ask-a').evaluateAll((els) => els.map((e) => e.getAttribute('data-ask-a')))).toEqual(['116', '117', '118', '119', '120']);
    await expect(answer(page, 116).locator('.ask-a-txt')).toHaveText('pony rides');
    await expect(answer(page, 116).locator('.ask-a-by')).toContainText('Noura Fahad');
    await expect(answer(page, 116).locator('.ask-a-by a[href="tel:+966559990000"]')).toHaveText('+966559990000');
    await expect(answer(page, 116).locator('.ask-a-by')).toContainText('Your ideas');
    await expect(answer(page, 116).locator('.ask-chip')).toHaveText(['Waiting']);
    await expect(answer(page, 117).locator('.ask-chip')).toHaveText(['Waiting', 'Flagged']); // held by a blocked word
    await expect(answer(page, 118).locator('.ask-a-by')).toContainText('Ask the organisers');
    // one answer approved, one rejected: each leaves Waiting at once
    await answer(page, 116).getByRole('button', { name: 'Approve' }).click();
    await expect(answer(page, 116)).toHaveCount(0);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toEqual({ p_ids: [116], p_status: 'approved' });
    await answer(page, 117).getByRole('button', { name: 'Reject' }).click();
    await expect(answer(page, 117)).toHaveCount(0);
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].body).toEqual({ p_ids: [117], p_status: 'rejected' });
    await expect(pill('pending')).toHaveText('Waiting (3)');
    await expect(pill('approved')).toHaveText('Approved (9)');
    await expect(pill('rejected')).toHaveText('Not approved (2)');
    await expect(page.locator('.toast:not(.quiet), #err-bar-el')).toHaveCount(0);
    // several at once: Select, tick two, Approve 2 selected
    await sec(page).locator('.lt-sel-btn').click();
    await answer(page, 118).locator('.lt-box').check();
    await answer(page, 120).locator('.lt-box').check();
    await expect(sec(page).locator('.ask-ok-n')).toHaveText('Approve 2 selected');
    await expect(sec(page).locator('.ask-no-n')).toHaveText('Reject 2 selected');
    await sec(page).locator('.ask-ok-n').click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2].body.p_status).toBe('approved');
    expect([...(sent[2].body.p_ids as number[])].sort()).toEqual([118, 120]);
    await expect(sec(page).locator('.ask-a')).toHaveCount(1);
    // ... and Reject for the one left, picked the same way
    await answer(page, 119).locator('.lt-box').check();
    await sec(page).locator('.ask-no-n').click();
    await expect.poll(() => sent.length).toBe(4);
    expect(sent[3].body).toEqual({ p_ids: [119], p_status: 'rejected' });
    await sec(page).locator('.lt-row').getByRole('button', { name: 'Done' }).click();
    await expect(pill('pending')).toHaveText('Waiting (0)');
    await expect(sec(page).locator('#ask-as .empty-state')).toHaveText('Nothing here.');
    // back to Waiting from Not approved
    await pill('rejected').click();
    await expect(sec(page).locator('.ask-a')).toHaveCount(3);
    await answer(page, 119).getByRole('button', { name: 'Back to waiting' }).click();
    await expect.poll(() => sent.length).toBe(5);
    expect(sent[4].body).toEqual({ p_ids: [119], p_status: 'pending' });
    await answer(page, 117).getByRole('button', { name: 'Back to waiting' }).click();
    await expect.poll(() => sent.length).toBe(6);
    await pill('pending').click();
    await expect(sec(page).locator('.ask-a')).toHaveCount(2);
    // Approve all waiting asks first, then sends every one of them
    await sec(page).locator('.ask-ok-all').click();
    await expect(confirmBox(page)).toContainText('Approve all 2 waiting answers?');
    await confirmBox(page).getByRole('button', { name: 'Approve' }).click();
    await expect.poll(() => sent.length).toBe(7);
    expect(sent[6].body.p_status).toBe('approved');
    expect([...(sent[6].body.p_ids as number[])].sort()).toEqual([117, 119]);
    await expect(sec(page).locator('.ask-ok-all')).toHaveCount(0);
    // a refusal is said, and the answer is back where it was
    await pill('approved').click();
    refuse = true;
    await answer(page, 115).getByRole('button', { name: 'Reject' }).click();
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await expect(answer(page, 115)).toBeVisible();
    await expect(answer(page, 115).locator('.ask-chip')).toHaveText(['Approved']);
    await page.locator('#err-bar-el [aria-label="Close"]').click();
    refuse = false;
    // a new answer comes in: the list shows it by itself (read again every ten seconds), and the rail counts it
    await pill('pending').click();
    await expect(sec(page).locator('.ask-a')).toHaveCount(0);
    db.unshift(ans(121, 11, 'Huda Qasim', '+966550001111', { t: 'a tractor ride' }, { status: 'pending', created_at: new Date().toISOString() }));
    await expect(answer(page, 121)).toBeVisible({ timeout: 15_000 });
    await expect(answer(page, 121).locator('.ask-a-txt')).toHaveText('a tractor ride');
    await expect(pill('pending')).toHaveText('Waiting (1)');
  });

  test('an answer\'s text is corrected, a question from the audience is marked answered, an answer is deleted: each a checked write', async ({ page }) => {
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/ask_answers$/);
    await openPage(page, 1, 'answers');
    await sec(page).locator('.filter-pill[data-ask-at="all"]').click();
    await expect(sec(page).locator('.ask-a')).toHaveCount(14);
    // what a person answered, in words, for the kinds with no text of their own
    await expect(answer(page, 114).locator('.ask-a-txt')).toHaveText('Thursday');
    await expect(answer(page, 113).locator('.ask-a-txt')).toHaveText('Route: 5, Pace: 3, Organisation: 4');
    await expect(answer(page, 112).locator('.ask-a-txt')).toHaveText('1. Barbecue, 2. Feeding the animals, 3. Garden games');
    await expect(answer(page, 111).locator('.ask-a-txt')).toHaveText('Food: 50, Games: 30, Transport: 20');
    await expect(answer(page, 110).locator('.ask-a-txt')).toHaveText('3 people');
    await expect(answer(page, 114).getByRole('button', { name: 'Edit text' })).toHaveCount(0); // only a written answer has a text to correct
    // Edit text: the body column
    await answer(page, 115).getByRole('button', { name: 'Edit text' }).click();
    await expect(page.locator('#prompt-input')).toHaveValue('BBQ');
    await page.locator('#prompt-input').fill('  Barbecue   night ');
    await page.locator('#prompt-input').press('Enter');
    await expect(answer(page, 115).locator('.ask-a-txt')).toHaveText('Barbecue night');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ m: 'PATCH', path: 'ask_answers', body: { body: 'Barbecue night' } });
    expect(sent[0].q).toContain('id=eq.115');
    // Mark answered, on a question from the audience only
    await expect(answer(page, 115).getByRole('button', { name: 'Mark answered' })).toHaveCount(0);
    await expect(answer(page, 109).locator('.ask-chip')).toHaveText(['Approved', 'Answered']);
    await answer(page, 118).getByRole('button', { name: 'Mark answered' }).click();
    await expect(answer(page, 118).locator('.ask-chip')).toHaveText(['Waiting', 'Answered']);
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toMatchObject({ m: 'PATCH', body: { answered: true } });
    expect(sent[1].q).toContain('id=eq.118');
    await answer(page, 109).getByRole('button', { name: 'Not answered' }).click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2]).toMatchObject({ m: 'PATCH', body: { answered: false } });
    // Delete asks first
    await answer(page, 108).getByRole('button', { name: 'Delete' }).click();
    await expect(confirmBox(page)).toContainText('Delete this answer?');
    await expect(confirmBox(page)).toContainText('something rude');
    await confirmBox(page).getByRole('button', { name: 'Delete' }).click();
    await expect(answer(page, 108)).toHaveCount(0);
    await expect.poll(() => sent.length).toBe(4);
    expect(sent[3]).toMatchObject({ m: 'DELETE', path: 'ask_answers' });
    expect(sent[3].q).toContain('id=eq.108');
    // a write the database refuses is said, and the text is back
    await page.route(/\/rest\/v1\/ask_answers(\?|$)/, (r) => (r.request().method() === 'PATCH' ? r.fulfill(json({ code: '42501', message: 'new row violates row-level security policy' }, 403)) : r.fallback()));
    await answer(page, 107).getByRole('button', { name: 'Edit text' }).click();
    await page.locator('#prompt-input').fill('Shade');
    await page.locator('#prompt-input').press('Enter');
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await expect(answer(page, 107).locator('.ask-a-txt')).toHaveText('Shade for the little ones, please');
  });

  test('Results: a summary for each kind, who answered what, the code and the QR, the big screen and the preview, Export CSV and Reset results', async ({ page }) => {
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/rpc\/staff_ask_control$/);
    await page.route(/\/rest\/v1\/rpc\/staff_ask_control$/, (r) => r.fulfill(json({ ok: true })));
    await row(page, 1).locator('.ask-pg-t').click(); // a page that is live opens on its results
    await expect(sec(page).locator('.filter-pill[data-ask-tab="results"]')).toHaveAttribute('aria-pressed', 'true');
    // the code people type, the link as a QR, the big screen and the preview with the page's screen key
    await expect(sec(page).locator('.ask-code bdi')).toHaveText('482 913');
    const qr = sec(page).locator('canvas#ask-qr');
    await expect(qr).toHaveAttribute('aria-label', 'QR code of the link');
    await expect(qr).toHaveAttribute('data-u', 'https://micromobility.sa/ask/farm-ideas');
    await expect.poll(() => qr.evaluate((c: HTMLCanvasElement) => { const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 80) dark++; return dark > 500; })).toBe(true);
    await expect(sec(page).locator('a.ask-screen')).toHaveAttribute('href', 'https://micromobility.sa/ask/farm-ideas/screen?k=sk_9f2c7a');
    await expect(sec(page).locator('a.ask-screen')).toHaveAttribute('target', '_blank');
    await expect(sec(page).locator('a.ask-screen')).toHaveText('Open big screen');
    await expect(sec(page).locator('a.ask-preview')).toHaveAttribute('href', 'https://micromobility.sa/ask/farm-ideas?k=sk_9f2c7a');
    await expect(sec(page).locator('a.ask-preview')).toHaveText('Preview');
    await expect(sec(page).locator('.ask-share-n')).toContainText('Round 1');
    // one section a question, by its kind; the slide and the kind not drawn yet have none
    const res = (id: number) => sec(page).locator(`.ask-r[data-ask-r="${id}"]`);
    await expect(sec(page).locator('.ask-r')).toHaveCount(8);
    await expect(res(19)).toHaveCount(0);
    await expect(res(20)).toHaveCount(0);
    await expect(res(11).locator('h2')).toHaveText('Your ideas');
    await expect(res(11).locator('.am-meta').first()).toContainText('Word cloud · Answers 6 · Waiting for approval 4');
    await expect(res(11).locator('.ask-word')).toHaveText(['BBQ 6', 'pony rides 4', 'bonfire 1']);
    await expect(res(12).locator('.ask-bar-l')).toHaveText(['Thursday', 'Friday', 'Saturday']);
    await expect(res(12).locator('.ask-bar-x')).toHaveText(['5 · 56%', '1 · 11%', '3 · 33%']);
    expect(await res(12).locator('.ask-bar-f').first().evaluate((e) => getComputedStyle(e).width !== '0px')).toBe(true);
    await expect(res(13).locator('.ask-bar-x')).toHaveText(['4.5', '3.2', '4']);
    await expect(res(14).locator('.ask-bar-l')).toHaveText(['Feeding the animals', 'Barbecue', 'Garden games']); // the most points first
    await expect(res(14).locator('.ask-bar-x')).toHaveText(['Average place 1.7', 'Average place 2', 'Average place 2.7']);
    await expect(res(15).locator('.ask-bar-x')).toHaveText(['50', '30', '20']);
    await expect(res(16).locator('.ask-stat')).toHaveText(['Average2.5', 'Lowest1', 'Highest5']);
    await expect(res(16).locator('.ask-col')).toHaveCount(5);
    await expect(res(17).locator('.ask-texts li')).toHaveText(['Is there parking at the farm? Votes 4 Answered']);
    await expect(res(18).locator('.ask-texts li')).toHaveText(['Shade for the little ones, please']);
    // who answered what: every answer of the nine kinds with its person, in full
    const who = sec(page).locator('.ask-who');
    await expect(who.locator('h2')).toHaveText('Who answered what');
    await expect(who.locator('thead th')).toHaveText(['Name', 'Mobile', 'Question', 'Answer', 'Status', 'Time']);
    await expect(who.locator('tbody tr')).toHaveCount(14);
    await expect(who.locator('tbody tr').filter({ hasText: 'Rate the last ride' }).locator('td')).toContainText(['Sara Ali', '+966555556666', 'Rate the last ride', 'Route: 5, Pace: 3, Organisation: 4', 'Approved']);
    await expect(who.locator('tbody tr').first().locator('td')).toContainText(['Lina Haddad', '+966551112222', 'Your ideas', 'kite flying', 'Waiting']);
    // Export CSV: name, mobile, question, answer, status, time
    const [file] = await Promise.all([page.waitForEvent('download'), sec(page).locator('.ask-csv').click()]);
    expect(file.suggestedFilename()).toBe('ask-farm-ideas.csv');
    const csv = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c as Buffer[]).toString('utf8'));
    const lines = csv.replace(/^\ufeff/, '').split('\n');
    expect(lines[0]).toBe('Name,Mobile,Question,Answer,Status,Time');
    expect(lines).toHaveLength(15);
    expect(lines[1]).toMatch(/^Lina Haddad,\+966551112222,Your ideas,kite flying,Waiting,/);
    expect(csv).toContain('Sara Ali,+966555556666,Rate the last ride,"Route: 5, Pace: 3, Organisation: 4",Approved,');
    // Reset results asks first, and says the older answers are kept
    await sec(page).locator('.ask-reset').click();
    await expect(confirmBox(page)).toContainText('Reset the results?');
    await expect(confirmBox(page)).toContainText('A new round starts with no answers. Older answers are kept.');
    await confirmBox(page).getByRole('button', { name: 'Reset results' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toEqual({ p_page: 1, p_action: 'reset' });
  });

  test('the setup of a saved page: Taking answers acts at once, Save writes what changed (a question moved, one deleted, a closing time), End asks, leaving unsaved asks', async ({ page }) => {
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/(ask_pages|ask_questions|rpc\/staff_ask_control)$/);
    // the database: a question opened or closed, and the page ended, is what staff_ask_page answers next
    const db = detail();
    await page.route(/\/rest\/v1\/rpc\/staff_ask_page$/, (r) => r.fulfill(json(db)));
    await page.route(/\/rest\/v1\/rpc\/staff_ask_control$/, (r) => {
      const b = r.request().postDataJSON() as { p_action: string; p_question?: number };
      const q = db.questions.find((x) => x.id === b.p_question);
      if (q) q.open = b.p_action === 'open';
      if (b.p_action === 'end') db.page.status = 'ended';
      return r.fulfill(json({ ok: true }));
    });
    await openPage(page, 1, 'setup');
    const card = (i: number) => sec(page).locator('.ask-q').nth(i);
    await expect(sec(page).locator('.ask-q')).toHaveCount(10);
    await expect(page.locator('#ask-title-en')).toHaveValue('What would you like to see at the farm?');
    await expect(page.locator('#ask-slug')).toHaveValue('farm-ideas');
    await expect(card(0).locator('.ask-q-txt')).toContainText('Your ideas');
    await expect(card(0).locator('.ask-q-txt .am-meta')).toHaveText('Word cloud · Answers 6 · Waiting for approval 4');
    await expect(card(8).locator('.ask-q-txt .am-meta')).toHaveText('Text slide'); // a slide takes no answers
    await expect(card(8).locator('.web-toggle')).toHaveCount(0);
    await expect(card(9).locator('.ask-q-ed')).toHaveCount(0); // a kind these screens do not draw: kept in its place, not edited
    await expect(sec(page).locator('.ask-save')).toBeVisible();
    await expect(sec(page).locator('.ask-end')).toBeVisible();
    // Taking answers on a saved question: at once, and nothing left unsaved
    await card(1).locator('.web-toggle').uncheck();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ path: 'rpc/staff_ask_control', body: { p_page: 1, p_action: 'close', p_question: 12 } });
    await expect(sec(page).locator('#ask-dirty')).toBeHidden();
    await card(1).locator('.web-toggle').check();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].body).toEqual({ p_page: 1, p_action: 'open', p_question: 12 });
    // a question answered keeps its kind
    await card(0).locator('.ask-q-ed').click();
    await expect(pop(page).locator('.ask-kind[data-ask-kind="choice"]')).toBeDisabled();
    await expect(pop(page).locator('.ask-kind[data-ask-kind="cloud"]')).toBeEnabled();
    await page.locator('#ask-c-per_person').fill('5');
    await page.locator('#ask-q-done').click();
    // move the second question first; delete the third (it has answers: asked first)
    await card(1).getByRole('button', { name: 'Move up: Which day suits you?' }).click();
    await expect(card(0).locator('.ask-q-txt b')).toHaveText('Which day suits you?');
    await expect(sec(page).locator('#ask-dirty')).toBeVisible();
    await card(2).getByRole('button', { name: 'Delete: Rate the last ride' }).click();
    await expect(confirmBox(page)).toContainText('Delete this question and its 4 answers?');
    await confirmBox(page).getByRole('button', { name: 'Delete' }).click();
    await expect(sec(page).locator('.ask-q')).toHaveCount(9);
    // who sees it: a tag (never the blacklist one); closes in 3 days, in Saudi time
    await sec(page).getByRole('button', { name: 'Accounts with a tag' }).click();
    await expect(sec(page).locator('.ask-tags .filter-pill')).toHaveText(['Community', 'VIP', 'Race team']);
    await sec(page).locator('.ask-save').click();
    await expect(sec(page).locator('.ask-tags + .ask-err')).toHaveText('Pick at least one tag.');
    await sec(page).locator('.ask-tags').getByRole('button', { name: 'Community' }).click();
    await sec(page).locator('.ask-tags').getByRole('button', { name: 'Race team' }).click();
    await sec(page).getByRole('button', { name: '3 days' }).click();
    const at = Date.now() + 3 * 864e5;
    await expect(page.locator('#ask-closes')).toHaveAttribute('aria-label', 'Closes, Saudi time');
    expect(Math.abs(Date.parse((await page.locator('#ask-closes').inputValue()) + ':00+03:00') - at)).toBeLessThan(120_000); // the field holds the wall clock in Riyadh
    await page.locator('#ask-notes').fill('For the farm day');
    sent.length = 0;
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.filter((s) => s.path === 'ask_questions').length).toBeGreaterThanOrEqual(10);
    // the page first: only what staff set, the closing time as an instant
    expect(sent[0]).toMatchObject({ m: 'PATCH', path: 'ask_pages' });
    expect(sent[0].q).toContain('id=eq.1');
    expect(sent[0].body).toMatchObject({ slug: 'farm-ideas', audience: 'tags', tag_ids: ['tag_saturday', 'tag_team'], opens_at: null, after_close: 'results', listed: true, notes: 'For the farm day', look: {} });
    expect(Object.keys(sent[0].body).sort()).toEqual(['after_close', 'audience', 'closes_at', 'intro_ar', 'intro_en', 'listed', 'look', 'notes', 'opens_at', 'slug', 'tag_ids', 'title_ar', 'title_en']);
    expect(Math.abs(Date.parse(sent[0].body.closes_at as string) - at)).toBeLessThan(90_000);
    expect(String(sent[0].body.closes_at)).toMatch(/Z$/);
    // then the question deleted, then every question whose place or settings changed, each by its id
    expect(sent[1]).toMatchObject({ m: 'DELETE', path: 'ask_questions' });
    expect(sent[1].q).toContain('id=eq.13');
    const moved = sent.slice(2).map((s) => [Number(/id=eq\.(\d+)/.exec(s.q)![1]), s.m, s.body.pos]);
    expect(moved).toEqual([[12, 'PATCH', 1], [11, 'PATCH', 2], [14, 'PATCH', 3], [15, 'PATCH', 4], [16, 'PATCH', 5], [17, 'PATCH', 6], [18, 'PATCH', 7], [19, 'PATCH', 8], [20, 'PATCH', 9]]);
    expect(sent[3].body).toMatchObject({ kind: 'cloud', config: { max_len: 40, per_person: 5 } });
    expect(sent[3].body).not.toHaveProperty('open'); // Taking answers is the switch's, not the Save's
    expect(sent[2].body).not.toHaveProperty('page_id');
    // End asks first
    sent.length = 0;
    await sec(page).locator('.ask-end').click();
    await expect(confirmBox(page)).toContainText('End this page?');
    await confirmBox(page).getByRole('button', { name: 'End', exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toEqual({ p_page: 1, p_action: 'end' });
    // leaving with something unsaved asks; Keep editing stays
    await page.locator('#ask-notes').fill('Changed my mind');
    await sec(page).locator('.ask-back').click();
    await expect(confirmBox(page)).toContainText('Leave without saving?');
    await confirmBox(page).getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator('#ask-notes')).toHaveValue('Changed my mind');
    await sec(page).locator('.ask-back').click();
    await confirmBox(page).getByRole('button', { name: 'Leave without saving' }).click();
    await expect(sec(page).locator('.ask-pg')).toHaveCount(4);
  });

  test('the window is entered in Saudi time and must close after it opens; Delete page asks first', async ({ page }) => {
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/(ask_pages|ask_questions)$/);
    await openPage(page, 1, 'setup');
    const opens = sec(page).getByRole('group', { name: 'Opens' }), closes = sec(page).getByRole('group', { name: 'Closes' });
    await expect(opens.getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'true');
    await expect(closes.getByRole('button', { name: 'Date and time' })).toHaveAttribute('aria-pressed', 'true'); // the page closes in five days
    await expect(page.locator('#ask-opens')).toHaveCount(0);
    // a date and time to open at: the field starts at now, on the wall clock in Riyadh
    await opens.getByRole('button', { name: 'Date and time' }).click();
    await expect(page.locator('#ask-opens')).toHaveAttribute('aria-label', 'Opens, Saudi time');
    expect(Math.abs(Date.parse((await page.locator('#ask-opens').inputValue()) + ':00+03:00') - Date.now())).toBeLessThan(120_000);
    await expect(sec(page).locator('.ask-when .ask-tz').first()).toHaveText('Saudi time');
    // opening after it closes is refused on the field, and nothing is sent
    await page.locator('#ask-opens').fill('2099-01-01T09:00');
    await sec(page).locator('.ask-save').click();
    await expect(page.locator('#ask-closes-e')).toHaveText('It must close after it opens.');
    await expect(page.locator('#ask-closes')).toHaveAttribute('aria-invalid', 'true');
    expect(sent).toHaveLength(0);
    await page.locator('#ask-closes').fill('2099-01-02T21:30');
    await expect(page.locator('#ask-closes-e')).toHaveCount(0);
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ m: 'PATCH', path: 'ask_pages', body: { opens_at: '2099-01-01T06:00:00.000Z', closes_at: '2099-01-02T18:30:00.000Z' } }); // three hours ahead of UTC
    // Now and No end are no limit on that side (the page opened afresh: the stubbed database kept its old window)
    await page.evaluate(`_askBackGo()`);
    await openPage(page, 1, 'setup');
    await sec(page).getByRole('group', { name: 'Closes' }).getByRole('button', { name: 'No end' }).click();
    await expect(page.locator('#ask-closes')).toHaveCount(0);
    await sec(page).getByRole('group', { name: 'After it closes' }).getByRole('button', { name: 'Hide' }).click();
    await page.locator('#ask-listed').uncheck();
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].body).toMatchObject({ opens_at: null, closes_at: null, after_close: 'hidden', listed: false });
    // Delete page: asked first, with what goes with it
    await sec(page).locator('.ask-del').click();
    await expect(confirmBox(page)).toContainText('Delete this page and all its answers?');
    await expect(confirmBox(page)).toContainText('What would you like to see at the farm?');
    await expect(confirmBox(page)).toContainText('Answers 33');
    await confirmBox(page).getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2]).toMatchObject({ m: 'DELETE', path: 'ask_pages' });
    expect(sent[2].q).toContain('id=eq.1');
    await expect(sec(page).locator('h1')).toHaveText('Ask'); // back on the list
  });

  test('who opens it: whoever opens People; only those who may change People get the write controls; the Team page still saves', async ({ page }) => {
    await staff(page);
    const railShown = () => rail(page).evaluate((b: HTMLElement) => b.style.display !== 'none');
    // the roles: with People (manager, owner, admin), not the desk's
    expect(await page.evaluate(`['admin','manager','owner','frontdesk','leader','mechanic','cashier'].map(r=>_roleTabs(r).includes('ask'))`)).toEqual([true, true, true, false, false, false, false]);
    expect(await page.evaluate(`ROLE_TABS.manager.indexOf('ask')===ROLE_TABS.manager.indexOf('badgereq')+1&&!DESK_TABS.includes('ask')`)).toBe(true);
    expect(await page.evaluate(`STAFF_PATHS.ask`)).toBe('ask');
    expect(await page.evaluate(`_sectionName('ask')`)).toBe('Ask');
    // an account's lists: one naming People names Ask; the database's own list of sections never hears of it
    expect(await page.evaluate(`JSON.stringify(_modIds(['queue','community']))`)).toContain('"ask"');
    expect(await page.evaluate(`JSON.stringify(_modIds(['queue','cashier']))`)).not.toContain('"ask"');
    expect(await page.evaluate(`JSON.stringify(_modSend(_modIds(['queue','community'])))`)).toBe('["queue","community"]');
    expect(await page.evaluate(`JSON.stringify(_modSend(_roleTabs('manager')))`)).not.toContain('"ask"');
    expect(await railShown()).toBe(true);
    await expect(sec(page).getByRole('button', { name: 'New question' })).toBeVisible();
    // an account that opens People without changing it: the section, and nothing to write with
    const sent = writes(page, /\/rest\/v1\/(ask_pages|ask_questions|ask_answers|rpc\/staff_ask_(review|control))$/);
    await page.evaluate(`_accessSet({modules_view:['queue','community'],modules_edit:['queue']},'u1')`);
    await page.evaluate(`setStaffTab('ask')`);
    expect(await page.evaluate(`S.staffTab`)).toBe('ask');
    expect(await railShown()).toBe(true);
    await expect(sec(page).locator('.ask-pg')).toHaveCount(4); // it reads
    await expect(sec(page).getByRole('button', { name: 'New question' })).toHaveCount(0);
    await openPage(page, 1, 'setup');
    await expect(sec(page).locator('.ask-acts, .ask-q-acts, .ask-add')).toHaveCount(0);
    await expect(page.locator('#ask-title-en')).toBeDisabled();
    await expect(page.locator('#ask-slug')).toBeDisabled();
    await expect(sec(page).locator('.ask-q .web-toggle').first()).toBeDisabled();
    await page.evaluate(`_askTab('answers')`);
    await expect(sec(page).locator('.ask-a')).toHaveCount(5);
    await expect(sec(page).locator('.ask-a-acts, .lt-sel-btn, .ask-ok-all')).toHaveCount(0);
    await page.evaluate(`_askTab('results')`);
    await expect(sec(page).locator('.ask-r')).toHaveCount(8);
    await expect(sec(page).locator('.ask-reset')).toHaveCount(0);
    await expect(sec(page).locator('a.ask-screen')).toBeVisible();
    // and a call made anyway is stopped before the wire
    await page.evaluate(`_askReview([116],'approved')`);
    await page.evaluate(`_askSave(true)`);
    expect(sent).toHaveLength(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
    // an account without People: no entry on the rail, and the address lands elsewhere
    await page.evaluate(`_accessSet({modules_view:['queue','cashier'],modules_edit:['queue']},'u1')`);
    expect(await page.evaluate(`_deskTabOk('ask')`)).toBe(false);
    expect(await railShown()).toBe(false);
    expect(await page.evaluate(`S.staffTab`)).not.toBe('ask');
    await page.evaluate(`setStaffTab('ask')`);
    expect(await page.evaluate(`S.staffTab`)).not.toBe('ask');
    await page.evaluate(`setStaffRole('frontdesk');_accessSet({modules_view:null,modules_edit:null},'u1')`);
    expect(await page.evaluate(`_deskTabOk('ask')`)).toBe(false);
    expect(await railShown()).toBe(false);
    await page.evaluate(`setStaffRole('manager')`);
    expect(await page.evaluate(`_deskTabOk('ask')&&_askCan()`)).toBe(true);
    await page.evaluate(`setStaffRole('owner');_accessSet({modules_view:null,modules_edit:[]},'u1')`); // the Owner only looks
    expect(await page.evaluate(`_deskTabOk('ask')&&!_askCan()`)).toBe(true);
  });

  test('a database from before Ask: the section says so, the rail carries no number, and the functions are not asked again', async ({ page }) => {
    const gone = (fn: string) => ({ __rpcError: { status: 404, code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } });
    const asked: string[] = [];
    page.on('request', (r) => { const m = /\/rpc\/(staff_ask_\w+)$/.exec(new URL(r.url()).pathname); if (m) asked.push(m[1]); });
    await staff(page, { 'rpc:staff_ask_pages': gone('staff_ask_pages'), 'rpc:staff_ask_pending': gone('staff_ask_pending') });
    await expect(sec(page).locator('.empty-state')).toHaveText('Ask is not set up on the database yet.');
    await expect(sec(page).locator('h1')).toHaveText('Ask');
    await expect(sec(page).locator('.ask-new')).toHaveCount(0);
    await expect(rail(page).locator('.snav-lbl')).toHaveText('Ask');
    await expect(rail(page).locator('.tab-badge')).toHaveCount(0);
    await expect(page.locator('#err-bar-el, .toast.error')).toHaveCount(0); // a missing function is not an error to show
    const n = asked.length;
    await page.evaluate(`S._askCAt=0;_ask().at=0;setStaffTab('queue');setStaffTab('ask');_secPolls(true)`);
    await page.waitForTimeout(300);
    expect(asked.length).toBe(n);
  });

  test('Arabic: the section runs right to left, in Arabic, with Latin digits', async ({ page }) => {
    const arPages = [pageRow({ title_en: '', title_ar: 'ماذا تود أن ترى في المزرعة؟', slug: 'farm-ideas' }),
      pageRow({ id: 2, slug: 'night-ride', title_en: '', title_ar: 'أي جولة ليلية الشهر القادم؟', status: 'draft', closes_at: null, open: false, pending: 0, answers: 0, people: 0 })];
    const arQs = [qRow({ id: 11, pos: 1, kind: 'cloud', title_en: '', title_ar: 'أفكارك', config: { max_len: 40, per_person: 10 }, answers: 3, pending: 1, result: { n: 2, people: 2, words: [{ w: 'شواء', n: 2 }] } }),
      qRow({ id: 12, pos: 2, kind: 'choice', title_en: '', title_ar: 'أي يوم يناسبك؟', config: { options: [opt('a1', '', 'الخميس'), opt('a2', '', 'الجمعة')], max_picks: 1, change: false }, answers: 1, result: { n: 1, counts: { a1: 1, a2: 0 } } }),
      qRow({ id: 16, pos: 3, kind: 'number', title_en: '', title_ar: 'كم شخصًا ستحضر؟', config: { min: 0, max: 10, step: 1, unit_en: '', unit_ar: 'أشخاص' }, answers: 1, result: { n: 1, avg: 3, min: 3, max: 3, bins: [{ lo: 0, hi: 5, n: 1 }, { lo: 5, hi: 10, n: 0 }] } })];
    const arAns = [ans(120, 11, 'لينا حداد', '+966551112222', { t: 'نزهة' }, { status: 'pending' }), ans(115, 11, 'عمر صالح', '+966553334444', { t: 'شواء' }),
      ans(114, 12, 'سارة علي', '+966555556666', { o: ['a1'] }), ans(110, 16, 'لينا حداد', '+966551112222', { n: 3 })];
    await staff(page, { tags: tags.map((g) => ({ ...g, name: g.id === 'tag_saturday' ? 'المجتمع' : g.id === 'tag_vip' ? 'كبار الشخصيات' : 'فريق السباق' })),
      'rpc:staff_ask_pages': arPages, 'rpc:staff_ask_page': { page: { ...arPages[0], screen_key: 'sk_ar' }, questions: arQs, board: [] }, 'rpc:staff_ask_answers': arAns, 'rpc:staff_ask_pending': 1 },
    { cq_lang: 'ar', cq_lang_pick: '1' });
    await page.locator('html[dir="rtl"]').waitFor();
    await expect(rail(page).locator('.snav-lbl')).toContainText('اسأل');
    await expect(rail(page).locator('.tab-badge')).toHaveAttribute('title', '1 بانتظار الموافقة');
    await expect(sec(page).locator('h1')).toHaveText('اسأل');
    await expect(sec(page).locator('.ask-pg')).toHaveCount(2);
    expect(await sec(page).evaluate((e) => getComputedStyle(e).direction)).toBe('rtl');
    // No English left: every Latin word in a view is the site's address, a file format or a code, and no digit is Arabic-Indic.
    const leftovers = async (root: string) => {
      const text = await page.locator(root).evaluate((e) => { // what is read on screen, and what a screen reader or a hover says
        const vals = [...e.querySelectorAll('[placeholder],[aria-label],[title]')].map((x) => [x.getAttribute('placeholder'), x.getAttribute('aria-label'), x.getAttribute('title')].join(' '));
        return (e as HTMLElement).innerText + ' ' + vals.join(' ');
      });
      expect(text, root).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/);
      return (text.replace(/micromobility\.sa\/ask(\/[a-z0-9-]+)?/g, ' ').replace(/\b(CSV|QR)\b/g, ' ').match(/[A-Za-z]{2,}/g) || []);
    };
    expect(await leftovers('#tab-ask')).toEqual([]);
    await expect(row(page, 1).locator('.ask-st')).toHaveText('مفتوحة');
    await expect(row(page, 1).locator('.ask-pend')).toHaveText('بانتظار الموافقة 5');
    // a new page and its question pop-up
    await sec(page).locator('.ask-new').click();
    await expect(sec(page).locator('h1')).toHaveText('سؤال جديد');
    expect(await leftovers('#tab-ask')).toEqual([]);
    await sec(page).locator('.ask-add').click();
    await expect(pop(page).locator('#ask-q-t')).toHaveText('إضافة سؤال');
    await pop(page).locator('.ask-kind[data-ask-kind="choice"]').click();
    expect(await leftovers('#ask-pop')).toEqual([]);
    await pop(page).locator('.ask-kind[data-ask-kind="scales"]').click();
    expect(await leftovers('#ask-pop')).toEqual([]);
    await pop(page).locator('.ask-kind[data-ask-kind="number"]').click();
    expect(await leftovers('#ask-pop')).toEqual([]);
    await pop(page).locator('.chrome-dact .btn-secondary').click();
    await page.evaluate(`_askBackGo()`);
    // a saved page: its setup, its answers, its results
    await openPage(page, 1, 'setup');
    await sec(page).locator('.ask-opts .toggle-btn').nth(2).click(); // accounts with a tag
    await expect(sec(page).locator('.ask-tags .filter-pill')).toHaveCount(3);
    expect(await leftovers('#tab-ask')).toEqual([]);
    await page.evaluate(`_askTab('answers')`);
    await expect(answer(page, 120).locator('.ask-a-txt')).toHaveText('نزهة');
    await expect(answer(page, 120).locator('.ask-a-acts .btn-primary')).toHaveText('موافقة');
    expect(await leftovers('#tab-ask')).toEqual([]);
    await page.evaluate(`_askATab('all')`);
    await expect(answer(page, 114).locator('.ask-a-txt')).toHaveText('الخميس'); // an option by its Arabic name
    await expect(answer(page, 110).locator('.ask-a-txt')).toHaveText('3 أشخاص');
    expect(await leftovers('#tab-ask')).toEqual([]);
    await page.evaluate(`_askTab('results')`);
    await expect(sec(page).locator('.ask-r')).toHaveCount(3);
    await expect(sec(page).locator('.ask-who h2')).toHaveText('من أجاب بماذا');
    expect(await leftovers('#tab-ask')).toEqual([]);
  });

  test('the part comes only to an account that can open the section, with its strings, and none of it is in the customer half or the desk\'s core', async ({ page }) => {
    // what the build wrote: the section's code and words in staff-parts/ask.js, the rail's number in the desk's core
    const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
    const customer = read('index.html') + read('app.js'), core = read('staff.js'), part = read('staff-parts/ask.js');
    for (const word of ['staff_ask_pages', 'staff_ask_review', 'staff_ask_control', '_askSave', 'askSlugTaken', 'This link name is taken']) {
      expect(customer.includes(word), `customer half: ${word}`).toBe(false);
      expect(core.includes(word), `desk core: ${word}`).toBe(false);
      expect(part.includes(word), `ask part: ${word}`).toBe(true);
    }
    expect(customer).not.toContain('staff_ask_pending');
    expect(core).toContain('staff_ask_pending');
    expect(core).toMatch(/"?tabAsk"?:"Ask"/);
    for (const code of ['ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']) {
      expect(existsSync(resolve(__dirname, '..', `lang/staff-ask-${code}.json`)), code).toBe(true);
      expect(Object.keys(JSON.parse(read(`lang/staff-ask-${code}.json`))).every((k) => /^ask[A-Z0-9]/.test(k)), code).toBe(true);
      expect(JSON.parse(read(`lang/staff-${code}.json`)).tabAsk, code).toBeTruthy(); // the rail's name rides with the core
      expect(JSON.parse(read(`lang/${code}.json`)).tabAsk, code).toBeUndefined(); // and never with the riders' strings
    }
    // a front-desk account never fetches the part; an account that opens People does
    const boot = async (pg: Page, role: string, asked: string[]) => {
      await stubSupabase(pg, base());
      await pg.addInitScript((r) => {
        (window as unknown as { __staffPartsNow?: boolean }).__staffPartsNow = false; // the way a real device gets them
        localStorage.setItem('cq_staff', '1'); localStorage.setItem('cq_op_name', 'Spec Staff'); localStorage.setItem('cq_role', r);
      }, role);
      pg.on('request', (r) => asked.push(new URL(r.url()).pathname));
      await pg.goto('/bookings');
      await staffReady(pg);
      await waitForSb(pg);
    };
    const desk: string[] = [];
    await boot(page, 'frontdesk', desk);
    await expect.poll(() => desk.includes('/staff-parts/cashier.js'), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(500);
    expect(desk.includes('/staff-parts/ask.js')).toBe(false);
    expect(await page.evaluate(`typeof LANG.en.askSlugTaken`)).toBe('undefined');
    await page.evaluate(`S._staffAuthed=true;renderStaffTabs();_secPolls(true)`); // a signed-in desk account's first paint and its polls
    await page.waitForTimeout(300);
    expect(desk.some((p) => /\/rpc\/staff_ask_/.test(p))).toBe(false); // nor does it ask the database about Ask
    await page.close();
    const mgr: string[] = [], page2 = await page.context().newPage(); // a tab of its own: the first one's role is written again on every load
    await boot(page2, 'manager', mgr);
    await expect.poll(() => mgr.includes('/staff-parts/ask.js'), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => page2.evaluate(`typeof _askSave==='function'&&t('askSlugTaken')`)).toBe('This link name is taken');
    // the rail's number: from the first paint of a signed-in account, on any section, and again with the section polls
    const asks = () => mgr.filter((p) => /\/rpc\/staff_ask_pending$/.test(p)).length;
    expect(asks()).toBe(0);
    await page2.evaluate(`S._staffAuthed=true;renderStaffTabs()`);
    await expect.poll(asks).toBe(1);
    await expect(page2.locator('#staff-tab-nav .tab-btn[data-stab="ask"] .tab-badge')).toHaveText('5');
    expect(await page2.evaluate(`S.staffTab`)).toBe('queue');
    await page2.evaluate(`renderStaffTabs()`);
    expect(asks()).toBe(1); // asked once, not on every paint
    await page2.evaluate(`S._askCAt=0;_secPolls(false)`);
    await expect.poll(asks).toBe(2);
  });

  test('no accessibility violation in the list, a page\'s setup, the question pop-up, the answers and the results; on a phone every control is finger-sized', async ({ page }) => {
    test.setTimeout(120_000);
    await staff(page);
    const phone = test.info().project.name === 'mobile';
    const audit = async (label: string, root = '#tab-ask') => {
      await page.waitForTimeout(350); // a pop-up's entry animation
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`), label).toEqual([]);
      if (!phone) return;
      // 44px for a finger: every button, link-button, field and switch (a switch's target is its label)
      const small = await page.locator(root).evaluate((el) => [...el.querySelectorAll('button, a.btn-sm, select, textarea, input')]
        .map((e) => (e.matches('input[type="checkbox"]') ? e.closest('label') || e : e) as HTMLElement)
        .filter((e) => e.getClientRects().length && e.offsetHeight < 44 && !e.matches('.lt-box'))
        .map((e) => `${e.tagName.toLowerCase()}.${e.className} ${e.offsetWidth}x${e.offsetHeight}`));
      expect(small, `${label}: controls under 44px`).toEqual([]);
    };
    await row(page, 1).waitFor();
    await sec(page).locator('[aria-controls="fm-ask"]').click();
    await audit('list');
    await sec(page).locator('.ask-new').click();
    await audit('new page');
    await page.evaluate(`_askBackGo()`);
    await openPage(page, 1, 'setup');
    await sec(page).getByRole('button', { name: 'Accounts with a tag' }).click();
    await sec(page).getByRole('button', { name: '1 week' }).click();
    await audit('setup');
    await sec(page).locator('.ask-q').nth(1).locator('.ask-q-ed').click();
    await pop(page).waitFor();
    await audit('question pop-up: choice', '#ask-pop');
    await pop(page).locator('.chrome-xt').click();
    await sec(page).locator('.ask-q').nth(2).locator('.ask-q-ed').click();
    await audit('question pop-up: scales', '#ask-pop');
    await pop(page).locator('.chrome-xt').click();
    await page.evaluate(`_askBackGo();_askOpen(1,'answers')`);
    await sec(page).locator('.ask-a').first().waitFor();
    await audit('answers');
    await sec(page).locator('.lt-sel-btn').click();
    await answer(page, 116).locator('.lt-box').check();
    await audit('answers, selecting');
    await page.evaluate(`_lsMode('askA');_askTab('results')`);
    await sec(page).locator('.ask-who tbody tr').first().waitFor();
    await audit('results');
  });
});

// The site's real Content-Security-Policy (no inline script, no inline style) is bypassed by the rest of the suite, whose
// string-form evaluate() needs eval. Here it is on, and the section is driven by clicks alone.
test.describe('@staff:ask Ask under the content security policy', () => {
  test.use({ bypassCSP: false });
  type Cspv = Window & { __cspv: string[] };
  test('nothing the section draws is refused: the list, a new page, the question pop-up, the results with their bars and QR, the answers, the setup', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as Cspv).__cspv = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as unknown as Cspv).__cspv.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample || ''}`));
    });
    await stubSupabase(page, base());
    await unlockStaff(page);
    await page.goto('/ask');
    await row(page, 1).waitFor();
    await sec(page).locator('[aria-controls="fm-ask"]').click();
    await sec(page).locator('.ask-new').click();
    await sec(page).locator('.ask-add').click();
    await pop(page).locator('.ask-kind[data-ask-kind="choice"]').click();
    await pop(page).locator('.ask-kind[data-ask-kind="scales"]').click();
    await pop(page).locator('.ask-kind[data-ask-kind="number"]').click();
    await pop(page).locator('.chrome-xt').click();
    await sec(page).locator('.ask-back').click();
    await row(page, 1).locator('.ask-pg-t').click();
    const bar = sec(page).locator('.ask-r[data-ask-r="12"] .ask-bar-f').first();
    await bar.waitFor();
    // a bar's width is a run-time value: it reaches the element through the CSSOM, never a style attribute
    await expect.poll(() => bar.evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(20);
    // the QR was drawn: its library is the site's own file, fetched under the policy
    await expect.poll(() => sec(page).locator('canvas#ask-qr').evaluate((c: HTMLCanvasElement) => { const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 80) dark++; return dark > 500; })).toBe(true);
    await sec(page).locator('.filter-pill[data-ask-tab="answers"]').click();
    await answer(page, 116).waitFor();
    await sec(page).locator('.filter-pill[data-ask-tab="setup"]').click();
    await sec(page).locator('.ask-setup').waitFor();
    await sec(page).getByRole('button', { name: 'Accounts with a tag' }).click();
    await sec(page).getByRole('button', { name: '3 days' }).click();
    expect(await page.evaluate(() => (window as unknown as Cspv).__cspv.slice())).toEqual([]);
  });
});
