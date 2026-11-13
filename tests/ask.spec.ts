import { test, expect, type Page, type Request, type Locator, type Route } from '@playwright/test';
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
  qRow({ id: 20, pos: 10, kind: 'later', title_en: 'A kind these screens do not draw yet', config: { options: [] }, answers: 1 }), // a kind from a later version: kept in its place, left undrawn
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
// staff_ask_stats: 37 answers from 21 people over three Saudi days; the groups count people
const stats = (o: Row = {}): Row => ({ answers: 37, people: 21, approved: 30, pending: 5, rejected: 2, flagged: 1, audience: null, first_at: '2026-11-10T06:05:00Z', last_at: '2026-11-12T18:40:00Z',
  by_day: [{ d: '2026-11-10', n: 9, people: 7 }, { d: '2026-11-11', n: 16, people: 11 }, { d: '2026-11-12', n: 12, people: 9 }],
  by_hour: [0, 0, 0, 0, 0, 0, 0, 1, 2, 4, 3, 2, 1, 0, 0, 2, 5, 6, 7, 3, 1, 0, 0, 0],
  by_gender: { male: 12, female: 6, none: 3 }, by_age: { '<18': 1, '18-24': 4, '25-34': 8, '35-44': 5, '45-54': 1, '55-64': 0, '65+': 0, none: 2 },
  by_member: { member: 9, other: 12 }, by_nationality: [{ code: 'SAUDI ARABIA', n: 11 }, { code: 'EGYPT', n: 4 }, { code: 'none', n: 3 }, { code: 'other', n: 3 }],
  by_lang: { en: 25, ar: 12 },
  by_question: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((id, i) => ({ id, answers: [6, 9, 4, 3, 3, 4, 2, 1, 0, 1][i], people: [5, 9, 4, 3, 3, 4, 2, 1, 0, 1][i], pending: id === 11 ? 4 : id === 17 ? 1 : 0 })),
  top_people: [{ customer_id: 'c1', name: 'Lina Haddad', answers: 6, approved: 5 }, { customer_id: 'c2', name: 'Omar Saleh', answers: 4, approved: 4 }], ...o });
// staff_ask_segment for "Which day suits you?" by gender: a result of the question's kind for each group, ordered by key
const segment = (): Row => ({ by: 'gender', segments: [{ key: 'female', n: 3, result: { n: 3, counts: { a1: 1, a2: 0, a3: 2 } } },
  { key: 'male', n: 5, result: { n: 5, counts: { a1: 4, a2: 1, a3: 0 } } }, { key: 'none', n: 1, result: { n: 1, counts: { a1: 0, a2: 0, a3: 1 } } }] });
const base = (): Fixtures => ({ sessions: [], queue_entries: [], bikes: [], customers: [], tags, customer_tags: [], staff_options: [],
  'rpc:staff_ask_pages': pages(), 'rpc:staff_ask_page': detail(), 'rpc:staff_ask_answers': answers(), 'rpc:staff_ask_pending': 5,
  'rpc:staff_ask_stats': stats(), 'rpc:staff_ask_segment': segment() });
// Stage 2 (2026-11-13): a page staff lead (pace live), holding the five more kinds, a multiple choice and a number with
// a right answer, a text slide, and the board staff_ask_page gives a page with quiz questions.
const PIC = 'https://micromobility.sa/media/ask/tent.jpg';
const liveQs = (): Row[] => [
  qRow({ id: 31, pos: 1, kind: 'quiz', title_en: 'Which wheel is a road bike\'s?', config: { options: [opt('a1', '26 inch'), opt('a2', '700c'), opt('a3', '20 inch')], correct: ['a2'], seconds: 20, speed: true }, answers: 9,
    result: { n: 9, counts: { a1: 2, a2: 6, a3: 1 }, correct: ['a2'] } }),
  qRow({ id: 32, pos: 2, kind: 'quiz_text', title_en: 'Name the city of the Saturday ride', config: { accept: ['Riyadh', 'الرياض'], seconds: 30, speed: true, max_len: 40 }, answers: 7,
    result: { n: 7, right: 5, correct: ['Riyadh', 'الرياض'], top: [{ w: 'Riyadh', n: 4 }, { w: 'Jeddah', n: 2 }, { w: 'الرياض', n: 1 }] } }),
  qRow({ id: 33, pos: 3, kind: 'grid', title_en: 'Place each idea', config: { options: [opt('a1', 'Night ride'), opt('a2', 'Farm day')], x_en: 'Effort', x_ar: '', y_en: 'Fun', y_ar: '', max: 10 }, answers: 5,
    result: { n: 5, pts: { a1: [3.2, 8.4], a2: [5.5, 9.1] } } }),
  qRow({ id: 34, pos: 4, kind: 'pin', title_en: 'Where should the tent go?', image: PIC, config: { correct: { x: 0.7, y: 0.35, r: 0.12 } }, answers: 3,
    result: { n: 3, pins: [[0.2, 0.3], [0.68, 0.33], [0.72, 0.4]], correct: { x: 0.7, y: 0.35, r: 0.12 } } }),
  qRow({ id: 35, pos: 5, kind: 'form', title_en: 'Your details', config: { fields: [{ id: 'f1', en: 'T-shirt size', ar: '', type: 'choice', required: true, options: [opt('a1', 'S'), opt('a2', 'M')] },
    { id: 'f2', en: 'Children', ar: '', type: 'number', required: false }, { id: 'f3', en: 'Notes', ar: '', type: 'text', required: false }] }, answers: 2, result: { n: 2 } }),
  qRow({ id: 36, pos: 6, kind: 'choice', title_en: 'Which day?', config: { options: [opt('a1', 'Thursday'), opt('a2', 'Friday')], max_picks: 1, change: false, correct: ['a1'] }, answers: 4,
    result: { n: 4, counts: { a1: 3, a2: 1 }, correct: ['a1'] } }),
  qRow({ id: 37, pos: 7, kind: 'number', title_en: 'Guess the distance', config: { min: 0, max: 100, step: 1, unit_en: 'km', unit_ar: '', correct: 42 }, answers: 2,
    result: { n: 2, avg: 40, min: 38, max: 42, correct: 42, bins: [{ lo: 30, hi: 40, n: 1 }, { lo: 40, hi: 50, n: 1 }] } }),
  qRow({ id: 38, pos: 8, kind: 'info', title_en: 'Thank you!', config: {} }),
];
const liveDetail = (o: Row = {}): { page: Row; questions: Row[]; board: Row[] } => ({ page: { ...pageRow(), pace: 'live', current_q: null, screen_key: 'sk_9f2c7a', ...o }, questions: liveQs(),
  board: [{ customer_id: 'c1', name: 'Lina Haddad', score: 1870, answers: 2 }, { customer_id: 'c2', name: 'Sara Ali', score: 1000, answers: 1 }, { customer_id: 'c3', name: 'Omar Saleh', score: 0, answers: 1 }] });
const liveAnswers = () => [
  ans(220, 31, 'Lina Haddad', '+966551112222', { o: ['a2'] }, { score: 870, ms: 5200 }),
  ans(219, 31, 'Omar Saleh', '+966553334444', { o: ['a1'] }, { score: 0, ms: 9100 }),
  ans(218, 32, 'Sara Ali', '+966555556666', { t: 'Riyadh' }, { score: 1000 }),
  ans(217, 33, 'Yousef Karim', '+966557778888', { g: { a1: [3, 8], a2: [6, 9] } }),
  ans(216, 34, 'Noura Fahad', '+966559990000', { x: 0.68, y: 0.33 }),
  ans(215, 35, 'Lina Haddad', '+966551112222', { f: { f1: 'a2', f2: 2, f3: 'Vegetarian, please' } }),
  ans(214, 35, 'Omar Saleh', '+966553334444', { f: { f1: 'a1' } }),
  ans(213, 36, 'Sara Ali', '+966555556666', { o: ['a1'] }),
  ans(212, 37, 'Yousef Karim', '+966557778888', { n: 42 }),
];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAA8AQMAAAAud2qjAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6goXDh05VoIs3QAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMC0yM1QxNDoyOTo1NyswMDowMJJ2CgAAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTAtMjNUMTQ6Mjk6NTcrMDA6MDDjK7K8AAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTEwLTIzVDE0OjI5OjU3KzAwOjAwtD6TYwAAAA1JREFUGNNjYBgF9AAAAWgAAdm2FbQAAAAASUVORK5CYII='; // a small red picture

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
/** The arguments each call of a database function was made with, in order. */
function calls(page: Page, fn: string) {
  const out: Row[] = [];
  page.on('request', (r: Request) => {
    if (!new URL(r.url()).pathname.endsWith('/rpc/' + fn) || r.method() !== 'POST') return;
    try { out.push((r.postDataJSON() || {}) as Row); } catch { out.push({}); }
  });
  return out;
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
      not_tag_ids: [], only_gender: null, min_age: null, max_age: null, opens_at: null, closes_at: null, after_close: 'results', listed: true, notes: '', look: {}, block_words: [],
      status: 'draft', pace: 'self' }); // no code (the database makes it), no theme
    expect(sent[1]).toMatchObject({ m: 'POST', path: 'ask_questions' });
    expect(sent[1].body).toEqual({ kind: 'cloud', pos: 1, title_en: 'Farm day: your ideas!', title_ar: '', help_en: '', help_ar: '', config: { max_len: 25, per_person: 3 },
      moderated: true, results: 'live', look: {}, image: null, page_id: 77, open: true }); // a question with no words of its own takes the page's title
    await expect(sec(page).locator('.filter-pill[data-ask-tab]')).toHaveText(['Setup', 'Answers', 'Results', 'Stats']);
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

  test('the question pop-up: fourteen kinds each with its mark, the settings of a kind, options with their ids, and what a kind needs before Done', async ({ page }) => {
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
    await expect(pop(page).locator('.ask-kind')).toHaveText(['Word cloud', 'Open answers', 'Questions from people', 'Multiple choice', 'Scales', 'Ranking', '100 points', 'Two-axis grid', 'Number',
      'Pin on a picture', 'Short form', 'Quiz, pick the answer', 'Quiz, type the answer', 'Text slide']); // the database's fourteen, in its order
    expect(await pop(page).locator('.ask-kind svg').count()).toBe(14);
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
      moderated: true, results: 'closed', look: {}, image: null, page_id: 79, open: true });
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
    await expect(page.locator('.toast.error').last()).toHaveText('This account can look at Ask but not change it.'); // FORBIDDEN, in the section's own words
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
    await expect(answer(page, 115)).toBeVisible();
    await expect(answer(page, 115).locator('.ask-chip')).toHaveText(['Approved']);
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
    await expect(page.locator('.toast.error').last()).toHaveText('This account can look at Ask but not change it.');
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
    await expect(answer(page, 107).locator('.ask-a-txt')).toHaveText('Shade for the little ones, please');
  });

  test('Results: a summary for each kind, who answered what, the QR and no code, the big screen and the preview, Export CSV and Reset results', async ({ page }) => {
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/rpc\/staff_ask_control$/);
    await page.route(/\/rest\/v1\/rpc\/staff_ask_control$/, (r) => r.fulfill(json({ ok: true })));
    await row(page, 1).locator('.ask-pg-t').click(); // a page that is live opens on its results
    await expect(sec(page).locator('.filter-pill[data-ask-tab="results"]')).toHaveAttribute('aria-pressed', 'true');
    // the link as a QR, the big screen and the preview with the page's screen key; no code (nobody types one: the
    // user, 2026-11-13: "i don't want the ask page to need a code to be able to access it")
    await expect(sec(page).locator('.ask-code')).toHaveCount(0);
    await expect(sec(page).locator('.ask-share')).not.toContainText('482');
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
    expect(Object.keys(sent[0].body).sort()).toEqual(['after_close', 'audience', 'block_words', 'closes_at', 'intro_ar', 'intro_en', 'listed', 'look', 'max_age', 'min_age', 'not_tag_ids', 'notes',
      'only_gender', 'opens_at', 'pace', 'slug', 'tag_ids', 'title_ar', 'title_en']);
    expect(sent[0].body).toMatchObject({ not_tag_ids: [], only_gender: null, min_age: null, max_age: null, block_words: [] }); // nothing more was asked of the audience
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
      'rpc:staff_ask_pages': arPages, 'rpc:staff_ask_page': { page: { ...arPages[0], screen_key: 'sk_ar' }, questions: arQs, board: [] }, 'rpc:staff_ask_answers': arAns, 'rpc:staff_ask_pending': 1,
      'rpc:staff_ask_stats': stats({ by_lang: { ar: 4 }, top_people: [{ customer_id: 'c1', name: 'لينا حداد', answers: 3, approved: 2 }] }) },
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
    for (const k of ['grid', 'pin', 'form', 'quiz', 'quiz_text']) { // stage 2's kinds, each with its own settings
      await pop(page).locator(`.ask-kind[data-ask-kind="${k}"]`).click();
      expect(await leftovers('#ask-pop'), k).toEqual([]);
    }
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
    // the numbers: a nationality by its Arabic name, a breakdown's groups in Arabic
    await page.evaluate(`_askTab('stats')`);
    await expect(sec(page).locator('.ask-sc[data-ask-s="nat"] .ask-bar-l').first()).toHaveText('السعودية');
    await page.locator('#ask-sg-q').selectOption('12');
    await expect(sec(page).locator('.ask-mult-c h3').first()).toContainText('ذكر');
    expect(await leftovers('#tab-ask')).toEqual([]);
    // a page staff lead: the presenter's strip, in Arabic
    await page.evaluate(`_askPg().pace='live';_askTab('results')`);
    await expect(sec(page).locator('.ask-live h2')).toHaveText('على الشاشة الآن');
    await expect(sec(page).locator('.ask-live .ask-show').first()).toHaveText('اعرض الآن');
    expect(await leftovers('#tab-ask')).toEqual([]);
  });

  test('the part comes only to an account that can open the section, with its strings, and none of it is in the customer half or the desk\'s core', async ({ page }) => {
    // what the build wrote: the section's code and words in staff-parts/ask.js, the rail's number in the desk's core
    const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
    const customer = read('index.html') + read('app.js'), core = read('staff.js'), part = read('staff-parts/ask.js');
    for (const word of ['staff_ask_pages', 'staff_ask_review', 'staff_ask_control', '_askSave', 'askSlugTaken', 'This link name is taken', 'staff_ask_stats', 'staff_ask_segment', '_askStatsHtml', '_askLiveHtml', '_askDup', 'askKquiz_text',
      'ASK_PALETTES', 'askKindLocked', 'Only an admin can upload pictures.']) {
      expect(customer.includes(word), `customer half: ${word}`).toBe(false);
      expect(core.includes(word), `desk core: ${word}`).toBe(false);
      expect(part.includes(word), `ask part: ${word}`).toBe(true);
    }
    expect(customer).not.toContain('staff_ask_pending');
    expect(core).toContain('staff_ask_pending');
    expect(customer).not.toContain('_askAddr'); // the open page in the address: the desk core writes it, the riders' half never hears of it
    expect(core).toContain('function _askAddr');
    expect(part).not.toContain('function _askAddr');
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

  test('no accessibility violation in the list, a page\'s setup, the question pop-up, the answers, the results and the stats; on a phone every control is finger-sized', async ({ page }) => {
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
    await page.evaluate(`_ask().cur.d.block_words=['casino','crypto'];renderAsk()`); // two blocked words, as chips
    await sec(page).locator('.ask-wchip').first().waitFor();
    await audit('setup');
    await sec(page).locator('.ask-q').nth(1).locator('.ask-q-ed').click();
    await pop(page).waitFor();
    await audit('question pop-up: choice', '#ask-pop');
    await pop(page).locator('.chrome-xt').click();
    await sec(page).locator('.ask-q').nth(2).locator('.ask-q-ed').click();
    await audit('question pop-up: scales', '#ask-pop');
    await pop(page).locator('.chrome-xt').click();
    await sec(page).locator('.ask-add').click(); // a new question takes any kind
    for (const k of ['quiz', 'form']) { // a quiz's right option and seconds; a form's fields, one of them a list
      await pop(page).locator(`.ask-kind[data-ask-kind="${k}"]`).click();
      if (k === 'form') await pop(page).locator('#ask-ff-ty-0').selectOption('choice');
      await audit(`question pop-up: ${k}`, '#ask-pop');
    }
    await pop(page).locator('.chrome-xt').click();
    await page.evaluate(`_askBackGo();_askOpen(1,'answers')`);
    await sec(page).locator('.ask-a').first().waitFor();
    await page.evaluate(`_askPg().round=3;renderAsk()`); // a page on its third round: the round picker
    await page.locator('#ask-round').waitFor();
    await audit('answers');
    await sec(page).locator('.lt-sel-btn').click();
    await answer(page, 116).locator('.lt-box').check();
    await audit('answers, selecting');
    await page.evaluate(`_lsMode('askA');_askTab('results')`);
    await sec(page).locator('.ask-who tbody tr').first().waitFor();
    await audit('results');
    await sec(page).locator('.filter-pill[data-ask-tab="stats"]').click();
    await page.locator('#ask-sg-q').selectOption('12');
    await sec(page).locator('.ask-mult-c').first().waitFor();
    await sec(page).locator('.ask-sc[data-ask-s="day"] summary').click();
    await audit('stats');
    // stage 2: a page staff lead with the five more kinds (the strip, a grid's square, pins on a picture, the board), and a pin's right area
    await page.route('https://micromobility.sa/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }));
    await page.route(/\/rest\/v1\/rpc\/staff_ask_page$/, (r) => r.fulfill(json(liveDetail({ current_q: 31 }))));
    await page.evaluate(`_askBackGo();_askOpen(1,'results')`);
    await sec(page).locator('.ask-live .ask-run-q').first().waitFor();
    await sec(page).locator('.ask-board tbody tr').first().waitFor();
    await audit('results of a page staff lead');
    await page.evaluate(`_askTab('setup')`);
    await sec(page).locator('.ask-q').nth(3).locator('.ask-q-ed').click();
    await pop(page).locator('#ask-pin-x').waitFor();
    await page.evaluate(`_askTop()`); // the page behind the pop-up back at its top: a row half under the phone's bars is not a target to measure
    await audit('question pop-up: pin', '#ask-pop');
    await pop(page).locator('.chrome-xt').click();
  });

  // ── The second pass (2026-11-13): the look, pictures, who else a page leaves out, blocked words, Stats, older rounds,
  // the answers a page at a time, the open page in the address. No change to the database. ──

  test('the page\'s look: the theme and the chart colours as swatches, the line after an answer, one question at a time, the big screen\'s QR, count and pace; written into look, what these screens do not know kept', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    const kept = { future: { x: 1 }, theme: 'sand', screen: { qr: true, count: true, rotate: 0, later: 'kept' } };
    await staff(page, { 'rpc:staff_ask_page': { ...detail(), page: { ...detail().page, look: kept } } });
    const sent = writes(page, /\/rest\/v1\/ask_pages$/);
    await openPage(page, 1, 'setup');
    const look = sec(page).locator('section[aria-labelledby="ask-g-look"]');
    await expect(look.locator('h2')).toHaveText('Look');
    const themes = look.getByRole('group', { name: 'Theme' }), pals = look.getByRole('group', { name: 'Chart colours' });
    await expect(themes.locator('.ask-swb')).toHaveText(['Light', 'Dark', 'Green', 'Sand']);
    expect(await themes.locator('.ask-swb svg').count()).toBe(4);
    await expect(themes.locator('.ask-swb[data-ask-theme="sand"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(pals.locator('.ask-swb')).toHaveText(['Brand', 'Forest', 'Ocean', 'Sunset', 'Berry', 'Mono']);
    await expect(pals.locator('.ask-swb[data-ask-palette="brand"]')).toHaveAttribute('aria-pressed', 'true'); // nothing said: the first
    // a palette's swatch is its six colours, read from the one list the section holds
    expect(await pals.locator('.ask-swb[data-ask-palette="ocean"] svg rect').evaluateAll((els) => els.slice(1).map((e) => e.getAttribute('fill'))))
      .toEqual(await page.evaluate(`ASK_PALETTES.ocean`));
    expect(await page.evaluate(`Object.keys(ASK_PALETTES).join()+' '+Object.values(ASK_PALETTES).every(p=>p.length===6&&p.every(c=>/^#[0-9a-f]{6}$/.test(c)))`)).toBe('brand,forest,ocean,sunset,berry,mono true');
    await themes.getByRole('button', { name: 'Dark' }).click();
    await expect(themes.locator('.ask-swb[data-ask-theme="dark"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(themes.locator('.ask-swb[data-ask-theme="dark"]')).toBeFocused(); // the form was drawn again: the keyboard stays on the choice
    await pals.getByRole('button', { name: 'Ocean' }).click();
    await expect(page.locator('#ask-thanks_en')).toHaveAttribute('maxlength', '120');
    await look.getByLabel('Line after an answer (English)').fill('  Thank you,  see you there! ');
    await look.getByLabel('Line after an answer (Arabic)').fill('شكرًا لك');
    await look.getByRole('group', { name: 'Questions shown' }).getByRole('button', { name: 'One at a time' }).click();
    const scr = look.getByRole('group', { name: 'The big screen shows' });
    await expect(scr.locator('.ask-sw')).toHaveText(['QR code', 'How many answered']); // the QR and the count: a page needs no code
    await expect(scr.getByRole('switch', { name: 'QR code' })).toBeChecked();
    await expect(scr.getByRole('switch', { name: 'How many answered' })).toBeChecked();
    await scr.getByRole('switch', { name: 'QR code' }).uncheck();
    await expect(look.getByLabel('The big screen moves to the next question').locator('option')).toHaveText(['Not by itself', 'Every 10 seconds', 'Every 15 seconds', 'Every 20 seconds',
      'Every 30 seconds', 'Every 45 seconds', 'Every 60 seconds', 'Every 90 seconds', 'Every 120 seconds']);
    await page.locator('#ask-scr-rot').selectOption('30');
    await expect(sec(page).locator('#ask-dirty')).toBeVisible();
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body.look).toEqual({ future: { x: 1 }, theme: 'dark', screen: { qr: false, count: true, rotate: 30, later: 'kept' }, palette: 'ocean',
      thanks_en: 'Thank you, see you there!', thanks_ar: 'شكرًا لك', layout: 'steps' });
    // the first of each list is what the pages take when nothing is said, so it is not written (the stubbed database
    // still holds the page as it was: Sand)
    await expect(themes.locator('.ask-swb[data-ask-theme="sand"]')).toHaveAttribute('aria-pressed', 'true');
    await themes.getByRole('button', { name: 'Light' }).click();
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].body.look).toEqual({ future: { x: 1 }, screen: { qr: true, count: true, rotate: 0, later: 'kept' } });
  });

  test('a question\'s look: its chart picked from small drawings, the colours, and only the choices its kind and chart take; written into the question\'s look; a unit is 12 characters', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    const d = detail();
    d.questions[0].look = { viz: 'bars', angle: 'mixed', glow: true }; // a word cloud drawn as bars, with a key from a newer app
    await staff(page, { 'rpc:staff_ask_page': d });
    const sent = writes(page, /\/rest\/v1\/ask_questions$/);
    await openPage(page, 1, 'setup');
    const card = (i: number) => sec(page).locator('.ask-q').nth(i), lk = pop(page).locator('.ask-look');
    // multiple choice: six charts, each a drawing with its name; bars is the kind's own
    await card(1).locator('.ask-q-ed').click();
    await expect(lk.locator('.ask-viz')).toHaveText(['Bars', 'Columns', 'Donut', 'Pie', 'Dots', 'Tiles']);
    expect(await lk.locator('.ask-viz svg.ask-viz-pic').count()).toBe(6);
    await expect(lk.locator('.ask-viz[data-ask-viz="bars"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(pop(page).locator('#ask-l-sort, #ask-l-values, #ask-l-total')).toHaveCount(3);
    await expect(pop(page).locator('#ask-l-limit, #ask-l-case, #ask-l-angle, #ask-l-size')).toHaveCount(0); // a word cloud's and a list's
    await lk.locator('.ask-viz[data-ask-viz="donut"]').click();
    await expect(lk.locator('.ask-viz[data-ask-viz="donut"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(lk.locator('.ask-viz[data-ask-viz="donut"]')).toBeFocused();
    // the colours: the page's until the question picks its own, and the drawings take them
    const pals = lk.getByRole('group', { name: 'Chart colours' });
    await expect(pals.locator('.ask-swb')).toHaveText(['As the page', 'Brand', 'Forest', 'Ocean', 'Sunset', 'Berry', 'Mono']);
    await expect(pals.locator('.ask-swb').first()).toHaveAttribute('aria-pressed', 'true');
    const strokes = () => lk.locator('.ask-viz[data-ask-viz="donut"] svg circle').evaluateAll((els) => els.map((e) => e.getAttribute('stroke')));
    expect(await strokes()).toEqual(await page.evaluate(`ASK_PALETTES.brand.slice(0,4)`));
    await pals.getByRole('button', { name: 'Berry' }).click();
    await expect(pals.locator('.ask-swb[data-ask-palette="berry"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await strokes()).toEqual(await page.evaluate(`ASK_PALETTES.berry.slice(0,4)`));
    // one colour for a chart of one thing: the bars' drawing fills with the palette's first only
    expect(await lk.locator('.ask-viz[data-ask-viz="bars"] svg rect').evaluateAll((els) => [...new Set(els.slice(1).map((e) => e.getAttribute('fill')))])).toEqual([await page.evaluate(`ASK_PALETTES.berry[0]`)]);
    await expect(pop(page).getByLabel('Order', { exact: true }).locator('option')).toHaveText(['As written', 'Largest first']);
    await expect(pop(page).getByLabel('Numbers on the chart').locator('option')).toHaveText(['Count and percent', 'Count', 'Percent', 'None']);
    await page.locator('#ask-l-sort').selectOption('count');
    await page.locator('#ask-l-values').selectOption('percent');
    await expect(pop(page).getByRole('switch', { name: 'Show how many answered' })).toBeChecked();
    await page.locator('#ask-l-total').uncheck();
    await page.locator('#ask-q-done').click();
    // the word cloud drawn as bars: no angle to choose until it is a cloud again; what it held is kept
    await card(0).locator('.ask-q-ed').click();
    await expect(lk.locator('.ask-viz')).toHaveText(['Word cloud', 'Bubbles', 'Bars', 'Tiles', 'Ranked list']);
    await expect(lk.locator('.ask-viz[data-ask-viz="bars"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#ask-l-angle')).toHaveCount(0);
    await expect(pop(page).getByLabel('How many it shows')).toHaveAttribute('placeholder', '10');
    await lk.locator('.ask-viz[data-ask-viz="cloud"]').click();
    await expect(page.locator('#ask-l-angle')).toHaveValue('mixed');
    await expect(pop(page).getByLabel('Words', { exact: true }).locator('option')).toHaveText(['All level', 'Some on their side']);
    await expect(page.locator('#ask-l-limit')).toHaveAttribute('placeholder', '60');
    await expect(pop(page).locator('#ask-l-values, #ask-l-sort, #ask-l-size')).toHaveCount(0);
    await page.locator('#ask-l-limit').fill('500');
    await expect(pop(page).getByLabel('Letters', { exact: true }).locator('option')).toHaveText(['As typed', 'CAPITALS', 'small letters']);
    await page.locator('#ask-l-case').selectOption('upper');
    await page.locator('#ask-q-done').click();
    // open answers: cards, a wall, one at a time, a stream; a text size, no order
    await card(7).locator('.ask-q-ed').click();
    await expect(lk.locator('.ask-viz')).toHaveText(['Cards', 'Sticky notes', 'Spotlight', 'Stream']);
    await expect(pop(page).getByLabel('Text size').locator('option')).toHaveText(['Medium', 'Small', 'Large']);
    await expect(page.locator('#ask-l-limit')).toHaveCount(1);
    await lk.locator('.ask-viz[data-ask-viz="spotlight"]').click();
    await expect(page.locator('#ask-l-limit')).toHaveCount(0); // one answer at a time: no count to set
    await page.locator('#ask-l-size').selectOption('l');
    await page.locator('#ask-q-done').click();
    // every kind with results has its charts; a text slide has none
    expect(await page.evaluate(`JSON.stringify(Object.fromEntries(Object.entries(ASK_VIZ).map(([k,v])=>[k,v.length])))`)).toBe('{"cloud":5,"open":4,"qa":2,"choice":6,"scales":4,"ranking":3,"points":3,"number":3,"grid":1,"pin":2,"quiz":2,"quiz_text":2,"form":0}');
    expect(await page.evaluate(`Object.values(ASK_VIZ).flat().every(v=>_askVizSvg(v,ASK_PALETTES.brand).length>200&&t('askVz'+v)!=='askVz'+v)`)).toBe(true);
    await card(8).locator('.ask-q-ed').click();
    await expect(pop(page).locator('.ask-look')).toHaveCount(0);
    await pop(page).locator('.chrome-xt').click();
    // a number: its three charts, and a unit of 12 characters, as the database checks
    await card(5).locator('.ask-q-ed').click();
    await expect(lk.locator('.ask-viz')).toHaveText(['Histogram', 'Gauge', 'Strip']);
    await expect(page.locator('#ask-c-unit_en')).toHaveAttribute('maxlength', '12');
    await expect(page.locator('#ask-c-unit_ar')).toHaveAttribute('maxlength', '12');
    await page.evaluate(`_askCfgIn('unit_en','kilometres per hour')`);
    await page.locator('#ask-q-done').click();
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(4);
    const by = (id: number) => sent.find((s) => s.q.includes(`id=eq.${id}`))!.body;
    expect(by(12).look).toEqual({ viz: 'donut', palette: 'berry', sort: 'count', values: 'percent', total: false });
    expect(by(11).look).toEqual({ angle: 'mixed', glow: true, limit: 150, case: 'upper' }); // the kind's own chart is not written; 500 is 150 at most
    expect(by(18).look).toEqual({ viz: 'spotlight', size: 'l' });
    expect((by(16).config as Row).unit_en).toBe('kilometres p');
    expect(by(16).look).toEqual({});
  });

  test('pictures go up the way the website editor\'s do: the cover and a text slide\'s, kept by their address on the website; anyone but an admin is told why not', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/(ask_pages|ask_questions)$/);
    const ups: string[] = []; let refuse = false;
    await page.route(/\/storage\/v1\/object\/site\//, (r) => {
      if (refuse) return r.fulfill(json({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }, 400));
      if (r.request().method() === 'POST') ups.push(new URL(r.request().url()).pathname.replace(/^.*\/object\/site\//, ''));
      return r.fulfill(json({ Key: 'site/x', Id: 'x' }));
    });
    const png = Buffer.from(PNG, 'base64');
    await page.route('https://micromobility.sa/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png }));
    const pick = async (btn: Locator) => { const ch = page.waitForEvent('filechooser'); await btn.click(); await (await ch).setFiles({ name: 'farm.png', mimeType: 'image/png', buffer: png }); };
    await openPage(page, 1, 'setup');
    const cover = sec(page).getByRole('group', { name: 'Cover picture' });
    await expect(cover.locator('img')).toHaveCount(0);
    await pick(cover.getByRole('button', { name: 'Upload picture' }));
    await expect.poll(() => ups.length).toBe(1);
    expect(ups[0]).toMatch(/^ask\/[a-z0-9]+-[a-z0-9]+\.(png|jpg)$/); // the site bucket, as the website editor's uploads
    await expect(cover.locator('img')).toHaveAttribute('src', `https://micromobility.sa/media/${ups[0]}?w=640`);
    await expect(cover.locator('img')).toHaveAttribute('alt', 'Cover picture');
    await expect(cover.getByRole('button', { name: 'Replace picture' })).toBeVisible();
    await expect(sec(page).locator('#ask-dirty')).toBeVisible();
    await expect(page.locator('.toast:not(.quiet), #err-bar-el')).toHaveCount(0);
    await sec(page).getByRole('switch', { name: 'How many answered' }).uncheck(); // (and one of the big screen's switches, on a look that says nothing yet)
    // a text slide's picture, in its pop-up
    await sec(page).locator('.ask-q').nth(8).locator('.ask-q-ed').click();
    const pic = pop(page).getByRole('group', { name: 'Picture' });
    await pick(pic.getByRole('button', { name: 'Upload picture' }));
    await expect.poll(() => ups.length).toBe(2);
    await expect(pic.locator('img')).toHaveAttribute('src', `https://micromobility.sa/media/${ups[1]}?w=640`);
    await page.locator('#ask-q-done').click();
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[0]).toMatchObject({ m: 'PATCH', path: 'ask_pages' });
    expect(sent[0].body.look).toEqual({ cover: 'https://micromobility.sa/media/' + ups[0], screen: { qr: true, count: false, rotate: 0 } }); // an https address the website draws from /media; the big screen's three, no more
    expect(sent[1].q).toContain('id=eq.19');
    expect(sent[1].body.image).toBe('https://micromobility.sa/media/' + ups[1]);
    // Remove takes a picture off the draft (the stubbed database holds the page as it was: no cover)
    await expect(cover.locator('img')).toHaveCount(0);
    await pick(cover.getByRole('button', { name: 'Upload picture' }));
    await expect(cover.locator('img')).toHaveCount(1);
    await cover.getByRole('button', { name: 'Remove: Cover picture' }).click();
    await expect(cover.locator('img')).toHaveCount(0);
    expect(await page.evaluate(`JSON.stringify(_ask().cur.d.look)`)).toBe('{}');
    await expect(cover.getByRole('button', { name: 'Upload picture' })).toBeFocused();
    // the bucket takes a picture from an admin only: said, and nothing is kept
    refuse = true;
    await pick(cover.getByRole('button', { name: 'Upload picture' }));
    await expect(page.locator('.toast.error').last()).toHaveText('Only an admin can upload pictures.');
    await expect(cover.locator('img')).toHaveCount(0);
    await expect(cover.getByRole('button', { name: 'Upload picture' })).toBeEnabled();
  });

  test('who sees it, further: a page for accounts leaves out tags, a gender, ages; a link page is not offered them and sends none', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/ask_pages$/);
    await openPage(page, 1, 'setup');
    const who = sec(page).locator('section[aria-labelledby="ask-g-who"]');
    const link = who.getByRole('button', { name: 'Anyone with the link' });
    // anyone with the link: the database refuses these rules there, so they are not offered
    await expect(link).toHaveAttribute('aria-pressed', 'true');
    await expect(who.locator('.ask-not, .ask-gen, .ask-ages')).toHaveCount(0);
    await who.getByRole('button', { name: 'Signed-in accounts' }).click();
    const not = who.getByRole('group', { name: 'Not for accounts with' }), gen = who.getByRole('group', { name: 'Gender' });
    await expect(not.locator('.filter-pill')).toHaveText(['Community', 'VIP', 'Blacklist', 'Race team']); // the Blacklist too: a tag to leave out
    await expect(gen.locator('.toggle-btn')).toHaveText(['Everyone', 'Male', 'Female']);
    await expect(gen.getByRole('button', { name: 'Everyone' })).toHaveAttribute('aria-pressed', 'true');
    await expect(who.getByLabel('Youngest age')).toHaveValue('');
    await expect(who.getByLabel('Oldest age')).toHaveAttribute('max', '120');
    // an age rule says plainly who it leaves out, from the first digit
    await expect(page.locator('#ask-age-note')).toBeHidden();
    await page.locator('#ask-min_age').fill('16');
    await expect(page.locator('#ask-age-note')).toBeVisible();
    await expect(page.locator('#ask-age-note')).toHaveText('An age rule leaves out every account with no birth date. Most accounts have none.');
    // the youngest above the oldest: said on the fields, nothing sent
    await page.locator('#ask-max_age').fill('12');
    await sec(page).locator('.ask-save').click();
    await expect(page.locator('#ask-age-e')).toHaveText('Ages are whole years from 1 to 120, and the youngest cannot be above the oldest.');
    await expect(page.locator('#ask-min_age')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#ask-min_age')).toBeFocused();
    expect(sent).toHaveLength(0);
    await page.locator('#ask-max_age').fill('40');
    await expect(page.locator('#ask-age-e')).toHaveCount(0);
    await expect(page.locator('#ask-max_age')).toBeFocused(); // the error went without the form being drawn again
    await not.getByRole('button', { name: 'VIP' }).click();
    await not.getByRole('button', { name: 'Blacklist' }).click();
    await gen.getByRole('button', { name: 'Female' }).click();
    await expect(page.locator('#ask-min_age')).toHaveValue('16');
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toMatchObject({ audience: 'accounts', tag_ids: [], not_tag_ids: ['tag_vip', 'tag_blacklist'], only_gender: 'female', min_age: 16, max_age: 40 });
    await expect(link).toHaveAttribute('aria-pressed', 'true'); // the stubbed database holds the page as it was
    // accounts with a tag: a tag is asked for or left out, never both
    await who.getByRole('button', { name: 'Accounts with a tag' }).click();
    await who.locator('.ask-tags').getByRole('button', { name: 'Community' }).click();
    await who.locator('.ask-tags').getByRole('button', { name: 'VIP' }).click();
    await who.getByRole('group', { name: 'Not for accounts with' }).getByRole('button', { name: 'VIP' }).click();
    await expect(who.locator('.ask-tags').getByRole('button', { name: 'VIP' })).toHaveAttribute('aria-pressed', 'false');
    await expect(who.getByRole('group', { name: 'Not for accounts with' }).getByRole('button', { name: 'VIP' })).toHaveAttribute('aria-pressed', 'true');
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].body).toMatchObject({ audience: 'tags', tag_ids: ['tag_saturday'], not_tag_ids: ['tag_vip'], only_gender: null, min_age: null, max_age: null });
    await expect(link).toHaveAttribute('aria-pressed', 'true');
    // back to anyone with the link: whatever was set goes as nothing
    await who.getByRole('button', { name: 'Signed-in accounts' }).click();
    await who.getByRole('group', { name: 'Gender' }).getByRole('button', { name: 'Male', exact: true }).click();
    await page.locator('#ask-min_age').fill('18');
    await link.click();
    await expect(who.locator('.ask-not, .ask-gen, .ask-ages')).toHaveCount(0);
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2].body).toMatchObject({ audience: 'link', tag_ids: [], not_tag_ids: [], only_gender: null, min_age: null, max_age: null });
  });

  test('blocked words: a chip each, several added at once, the same word once, 200 of 40 characters at most; written as block_words', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    await staff(page, { 'rpc:staff_ask_page': { ...detail(), page: { ...detail().page, block_words: ['casino', 'crypto'] } } });
    const sent = writes(page, /\/rest\/v1\/ask_pages$/);
    await openPage(page, 1, 'setup');
    const bw = sec(page).locator('section[aria-labelledby="ask-g-bw"]'), long = 'x'.repeat(60);
    await expect(bw.locator('h2')).toHaveText('Blocked words');
    await expect(bw.locator('.ask-wchip')).toHaveText(['casino', 'crypto']);
    const field = bw.getByRole('textbox', { name: 'Add words, with commas between them' });
    await field.fill(`  Spam , CASINO, free   money,${long}`);
    await bw.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(bw.locator('.ask-wchip')).toHaveText(['casino', 'crypto', 'Spam', 'free money', 'x'.repeat(40)]); // the same word once, whatever its capitals; 40 characters
    await expect(field).toHaveValue('');
    await expect(field).toBeFocused();
    await field.fill('scam');
    await field.press('Enter'); // Enter adds too
    await expect(bw.locator('.ask-wchip')).toHaveCount(6);
    await bw.getByRole('button', { name: 'Remove: crypto' }).click();
    await expect(bw.locator('.ask-wchip')).toHaveCount(5);
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body.block_words).toEqual(['casino', 'Spam', 'free money', 'x'.repeat(40), 'scam']);
    // 200 at most, said on the field (the stubbed database holds the page as it was: two words)
    await expect(bw.locator('.ask-wchip')).toHaveCount(2);
    await field.fill(Array.from({ length: 205 }, (_, i) => `w${i}`).join(','));
    await bw.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(bw.locator('.ask-wchip')).toHaveCount(200);
    await expect(page.locator('#ask-bw-e')).toHaveText('A page takes 200 blocked words at most.');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  test('Stats: how many and who by group from staff_ask_stats, reach against the audience, columns by day and hour with their table, and one question group by group from staff_ask_segment', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    const d = detail();
    d.questions.push(qRow({ id: 21, pos: 11, kind: 'choice', title_en: 'Bringing children?', config: { options: [opt('a1', 'Yes'), opt('a2', 'No')], max_picks: 1, change: false }, answers: 2,
      result: { n: 2, counts: { a1: 1, a2: 1 } } }));
    await staff(page, { 'rpc:staff_ask_page': d });
    const asked = calls(page, 'staff_ask_stats'), segs = calls(page, 'staff_ask_segment');
    let st = stats();
    await page.route(/\/rest\/v1\/rpc\/staff_ask_stats$/, (r) => r.fulfill(json(st)));
    await page.route(/\/rest\/v1\/rpc\/staff_ask_segment$/, (r) => r.fulfill(json((r.request().postDataJSON() as Row).p_by === 'q:21'
      ? { by: 'q:21', segments: [{ key: 'a1', n: 2, result: { n: 2, counts: { a1: 1, a2: 0, a3: 1 } } }, { key: 'a2', n: 1, result: { n: 1, counts: { a1: 1, a2: 0, a3: 0 } } }, { key: 'none', n: 4, result: { n: 4, counts: { a1: 3, a2: 1, a3: 0 } } }] }
      : segment())));
    await row(page, 1).locator('.ask-pg-t').click();
    const tab = sec(page).locator('.filter-pill[data-ask-tab="stats"]');
    await expect(tab).toHaveText('Stats');
    expect(asked).toHaveLength(0); // read when the tab is opened, not before
    await tab.click();
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toEqual({ p_page: 1, p_round: null });
    const box = sec(page).locator('.ask-stt'), cardOf = (id: string) => box.locator(`.ask-sc[data-ask-s="${id}"]`);
    // the headline numbers as tiles
    await expect(box.locator('.ask-stats .ask-stat')).toHaveText(['Answers37', 'People21', 'Approved30', 'Waiting5', 'Not approved2', 'Flagged1']);
    await expect(box.locator('.ask-s-when')).toContainText('First answer');
    await expect(box.locator('.ask-s-when')).toContainText('Last answer');
    await expect(cardOf('reach')).toHaveCount(0); // anyone with the link: no audience to measure against
    // by day: a column a day in one colour, its number read by a pointer and in the table under it
    await expect(cardOf('day').locator('h2')).toHaveText('Answers by day');
    await expect(cardOf('day').locator('.ask-time')).toHaveAttribute('role', 'img');
    await expect(cardOf('day').locator('.ask-time')).toHaveAttribute('aria-label', 'Answers by day');
    expect(await cardOf('day').locator('.ask-tcol').evaluateAll((els) => els.map((e) => e.getAttribute('title')))).toEqual(['10 Nov · 9', '11 Nov · 16', '12 Nov · 12']);
    await expect(cardOf('day').locator('.ask-time-max')).toHaveText('16');
    const tall = await cardOf('day').locator('.ask-tcol-b').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(tall[1]).toBeGreaterThan(tall[2]);
    expect(tall[2]).toBeGreaterThan(tall[0]);
    expect(tall[0]).toBeGreaterThan(10);
    expect(new Set(await cardOf('day').locator('.ask-tcol-b').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))).size).toBe(1);
    await expect(cardOf('day').locator('.ask-tlbls bdi')).toHaveText(['10 Nov', '11 Nov', '12 Nov']);
    await expect(cardOf('day').locator('tbody')).toBeHidden();
    await cardOf('day').locator('summary').click();
    await expect(cardOf('day').locator('summary')).toHaveText('Table');
    await expect(cardOf('day').locator('thead th')).toHaveText(['Day', 'Answers', 'People']);
    await expect(cardOf('day').locator('tbody tr').nth(1).locator('td')).toHaveText(['11 Nov', '16', '11']);
    await expect(cardOf('hour').locator('h2')).toHaveText('Answers by hour, Saudi time');
    await expect(cardOf('hour').locator('.ask-tcol')).toHaveCount(24);
    await expect(cardOf('hour').locator('.ask-tcol').nth(18)).toHaveAttribute('title', '18:00 · 7');
    await expect(cardOf('hour').locator('.ask-tlbls bdi')).toHaveText(['00', '', '', '03', '', '', '06', '', '', '09', '', '', '12', '', '', '15', '', '', '18', '', '', '21', '', '']);
    // who by group: people, each with its share, the numbers written beside the bars
    const bars = async (id: string) => [await cardOf(id).locator('.ask-bar-l').allTextContents(), await cardOf(id).locator('.ask-bar-x').allTextContents()];
    expect(await bars('gender')).toEqual([['Male', 'Female', 'Not given'], ['12 · 57%', '6 · 29%', '3 · 14%']]);
    expect(await bars('age')).toEqual([['<18', '18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'Not given'], ['1 · 5%', '4 · 19%', '8 · 38%', '5 · 24%', '1 · 5%', '0 · 0%', '0 · 0%', '2 · 10%']]);
    expect(await bars('member')).toEqual([['Members', 'Other'], ['9 · 43%', '12 · 57%']]);
    expect(await bars('nat')).toEqual([['Saudi Arabia', 'Egypt', 'Not given', 'Other'], ['11 · 52%', '4 · 19%', '3 · 14%', '3 · 14%']]); // an account's nationality, by the country lists' own names
    await expect(cardOf('lang').locator('h2')).toHaveText('Language of the answers');
    expect(await bars('lang')).toEqual([['English', 'العربية'], ['25 · 68%', '12 · 32%']]);
    // each question, and who answered most
    await expect(cardOf('q').locator('.ask-bar-l')).toHaveText(['Your ideas', 'Which day suits you?', 'Rate the last ride', 'Order the activities', 'Share 100 points', 'How many people are you bringing?',
      'Ask the organisers', 'Anything else?']);
    await expect(cardOf('q').locator('.ask-bar-x').first()).toHaveText('6 · People 5');
    await expect(cardOf('top').locator('thead th')).toHaveText(['Name', 'Answers', 'Approved']);
    await expect(cardOf('top').locator('tbody tr').first().locator('td')).toHaveText(['Lina Haddad', '6', '5']);
    // one question group by group: the question's own drawing, once a group
    const seg = cardOf('seg');
    await expect(seg.locator('h2')).toHaveText('One question, group by group');
    await expect(seg.getByLabel('Question', { exact: true }).locator('option')).toHaveText(['Choose a question', 'Your ideas', 'Which day suits you?', 'Rate the last ride', 'Order the activities', 'Share 100 points',
      'How many people are you bringing?', 'Ask the organisers', 'Anything else?', 'Bringing children?']);
    await expect(seg.locator('.ask-mult')).toHaveCount(0);
    expect(segs).toHaveLength(0);
    await page.locator('#ask-sg-q').focus();
    await page.locator('#ask-sg-q').selectOption('12');
    await expect.poll(() => segs.length).toBe(1);
    expect(segs[0]).toEqual({ p_question: 12, p_by: 'gender', p_round: null });
    await expect(seg.locator('.ask-mult-c')).toHaveCount(3);
    expect(await seg.locator('.ask-mult-c').evaluateAll((els) => els.map((e) => e.getAttribute('data-ask-seg')))).toEqual(['male', 'female', 'none']); // in the groups' own order, not their keys'
    await expect(seg.locator('.ask-mult-c h3')).toHaveText(['Male People 5', 'Female People 3', 'Not given People 1']);
    await expect(seg.locator('.ask-mult-c').first().locator('.ask-bar-l')).toHaveText(['Thursday', 'Friday', 'Saturday']);
    await expect(seg.locator('.ask-mult-c').first().locator('.ask-bar-x')).toHaveText(['4 · 80%', '1 · 20%', '0 · 0%']);
    await expect(page.locator('#ask-sg-q')).toBeFocused();
    // by the answer to another multiple-choice question of the page (never by itself)
    await expect(seg.getByLabel('Group by').locator('option')).toHaveText(['Gender', 'Age', 'Community', 'Language of the answers', 'Bringing children?']);
    await page.locator('#ask-sg-by').selectOption('q:21');
    await expect.poll(() => segs.length).toBe(2);
    expect(segs[1]).toEqual({ p_question: 12, p_by: 'q:21', p_round: null });
    await expect(seg.locator('.ask-mult-c h3')).toHaveText(['Yes People 2', 'No People 1', 'No answer People 4']);
    // a page for accounts: how far it reached, against the accounts it is for
    st = stats({ audience: 180 });
    await page.evaluate(`_askStats()`);
    await expect(cardOf('reach').locator('h2')).toHaveText('Reach');
    await expect(cardOf('reach').locator('.ask-bar-x')).toHaveText('21 of 180 accounts · 12%');
    expect(await cardOf('reach').locator('.ask-bar-f').evaluate((e) => { const b = e.getBoundingClientRect(), t = e.parentElement!.getBoundingClientRect(); return Math.round(b.width / t.width * 100); })).toBe(12);
    // no answers yet: the tiles at nothing, and no empty chart
    st = stats({ answers: 0, people: 0, approved: 0, pending: 0, rejected: 0, flagged: 0, audience: null, first_at: null, last_at: null, by_day: [], top_people: [] });
    await page.evaluate(`_askStats()`);
    await expect(box.locator('.ask-stats .ask-stat').first()).toHaveText('Answers0');
    await expect(box.locator('.ask-sc')).toHaveCount(0);
    await expect(box.locator('.ask-r-none')).toHaveText('No answers yet.');
  });

  test('older rounds: a picker on Answers, Results and Stats reads the round asked for; the setup and Reset results are the current round\'s', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    const d = detail(); d.page.round = 3;
    const old = detail(); old.page.round = 3; old.page.shown_round = 2;
    old.questions.forEach((q) => { q.answers = q.id === 12 ? 2 : 0; q.pending = 0; });
    old.questions[1].result = { n: 2, counts: { a1: 0, a2: 2, a3: 0 } };
    const oldAns = [ans(60, 12, 'Huda Qasim', '+966550001111', { o: ['a2'] }, { round: 2 }), ans(59, 12, 'Lina Haddad', '+966551112222', { o: ['a2'] }, { round: 2 })];
    await staff(page, { 'rpc:staff_ask_pages': pages().map((p) => (p.id === 1 ? { ...p, round: 3 } : p)) });
    const pg = calls(page, 'staff_ask_page'), an = calls(page, 'staff_ask_answers'), st = calls(page, 'staff_ask_stats');
    const round = (r: Route) => (r.request().postDataJSON() as Row).p_round;
    await page.route(/\/rest\/v1\/rpc\/staff_ask_page$/, (r) => r.fulfill(json(round(r) === 2 ? old : d)));
    await page.route(/\/rest\/v1\/rpc\/staff_ask_answers$/, (r) => r.fulfill(json(round(r) === 2 ? oldAns : answers())));
    await page.route(/\/rest\/v1\/rpc\/staff_ask_stats$/, (r) => r.fulfill(json(round(r) === 2 ? stats({ answers: 2, people: 2, approved: 2, pending: 0, rejected: 0, flagged: 0 }) : stats())));
    await openPage(page, 1, 'setup');
    await expect(page.locator('#ask-round')).toHaveCount(0); // the setup is the page's, whatever the round
    await sec(page).locator('.filter-pill[data-ask-tab="results"]').click();
    const pick = sec(page).getByLabel('Round', { exact: true });
    await expect(pick.locator('option')).toHaveText(['Round 3 (now)', 'Round 2', 'Round 1']);
    await expect(pick).toHaveValue('3');
    await expect(sec(page).locator('.ask-share-n')).toContainText('Round 3');
    await expect(sec(page).locator('.ask-reset')).toBeVisible();
    await expect(sec(page).locator('.ask-who tbody tr')).toHaveCount(14);
    // an older round: its results and its answers are asked for by its number
    await pick.selectOption('2');
    await expect.poll(() => pg.some((a) => a.p_round === 2)).toBe(true);
    expect(pg.find((a) => a.p_round === 2)).toEqual({ p_page: 1, p_round: 2 });
    await expect.poll(() => an.some((a) => a.p_round === 2)).toBe(true);
    expect(an.find((a) => a.p_round === 2)).toEqual({ p_page: 1, p_status: null, p_round: 2, p_before: null, p_limit: 300 });
    await expect(sec(page).locator('.ask-share-n')).toContainText('Round 2 · Answers 2 · People 2');
    await expect(sec(page).locator('.ask-r[data-ask-r="12"] .ask-bar-x')).toHaveText(['0 · 0%', '2 · 100%', '0 · 0%']);
    await expect(sec(page).locator('.ask-who tbody tr')).toHaveCount(2);
    await expect(sec(page).locator('.ask-reset')).toHaveCount(0); // a new round starts from the one the page is on
    await expect(page.locator('#ask-round')).toBeFocused();
    const [file] = await Promise.all([page.waitForEvent('download'), sec(page).locator('.ask-csv').click()]);
    expect(file.suggestedFilename()).toBe('ask-farm-ideas-r2.csv'); // the CSV is that round's
    // Answers and Stats keep the round
    await sec(page).locator('.filter-pill[data-ask-tab="answers"]').click();
    await expect(page.locator('#ask-round')).toHaveValue('2');
    await expect(sec(page).locator('.filter-pill[data-ask-at="pending"]')).toHaveText('Waiting (0)');
    await sec(page).locator('.filter-pill[data-ask-at="all"]').click();
    await expect(sec(page).locator('.ask-a')).toHaveCount(2);
    await sec(page).locator('.filter-pill[data-ask-tab="stats"]').click();
    await expect.poll(() => st.length).toBeGreaterThan(0);
    expect(st[st.length - 1]).toEqual({ p_page: 1, p_round: 2 });
    await expect(sec(page).locator('.ask-stats .ask-stat').first()).toHaveText('Answers2');
    // the setup stays the page's own: its questions with the current round's counts
    await sec(page).locator('.filter-pill[data-ask-tab="setup"]').click();
    await expect(sec(page).locator('.ask-q').first().locator('.ask-q-txt .am-meta')).toHaveText('Word cloud · Answers 6 · Waiting for approval 4');
    // back to the round the page is on
    await sec(page).locator('.filter-pill[data-ask-tab="stats"]').click();
    an.length = 0;
    await page.locator('#ask-round').selectOption('3');
    await expect(sec(page).locator('.ask-stats .ask-stat').first()).toHaveText('Answers37');
    expect(st[st.length - 1]).toEqual({ p_page: 1, p_round: null });
    await expect.poll(() => an.some((a) => a.p_round === null)).toBe(true);
  });

  test('a page with many answers is read a page at a time: the newest and every one waiting, older ones with Show more, and the CSV holds them all', async ({ page }) => {
    test.setTimeout(120_000);
    // n answers to the word cloud, newest first; the twelve oldest wait for approval
    const make = (n: number) => Array.from({ length: n }, (_, i) => { const id = 1000 + n - i;
      return ans(id, 11, `Rider ${id}`, `+9665${10000000 + id}`, { t: `idea ${id}` }, { status: id <= 1012 ? 'pending' : 'approved', created_at: ago(9000 - id) }); });
    let db = make(320);
    const d = detail();
    const count = () => d.questions.forEach((q) => { q.answers = q.id === 11 ? db.length : 0; q.pending = q.id === 11 ? db.filter((a) => a.status === 'pending').length : 0; });
    count();
    await staff(page);
    const asked = calls(page, 'staff_ask_answers'), sent = writes(page, /\/rest\/v1\/rpc\/staff_ask_review$/);
    await page.route(/\/rest\/v1\/rpc\/staff_ask_page$/, (r) => r.fulfill(json(d)));
    await page.route(/\/rest\/v1\/rpc\/staff_ask_answers$/, (r) => {
      const a = r.request().postDataJSON() as { p_status: string | null; p_before: number | null; p_limit: number };
      return r.fulfill(json(db.filter((x) => (!a.p_status || x.status === a.p_status) && (a.p_before == null || (x.id as number) < a.p_before)).slice(0, a.p_limit)));
    });
    await page.route(/\/rest\/v1\/rpc\/staff_ask_review$/, (r) => {
      const b = r.request().postDataJSON() as { p_ids: number[]; p_status: string };
      db.forEach((a) => { if (b.p_ids.includes(a.id as number)) a.status = b.p_status; });
      count();
      return r.fulfill(json(b.p_ids.length));
    });
    await openPage(page, 1, 'answers');
    const pill = (k: string) => sec(page).locator(`.filter-pill[data-ask-at="${k}"]`);
    // the newest 300, and beside them every answer that waits: approval never works from a cut list
    await expect(pill('pending')).toHaveText('Waiting (12)');
    expect(asked[0]).toEqual({ p_page: 1, p_status: null, p_round: null, p_before: null, p_limit: 300 });
    expect(asked[1]).toEqual({ p_page: 1, p_status: 'pending', p_round: null, p_before: null, p_limit: 3000 });
    await expect(sec(page).locator('.ask-a')).toHaveCount(12); // though none of them is among the newest 300
    await expect(pill('all')).toHaveText('All (320)'); // the page's own count
    await expect(pill('approved')).toHaveText('Approved (300+)'); // of the rows read so far: at least
    await expect(pill('rejected')).toHaveText('Not approved (0+)');
    await expect(sec(page).locator('.filter-pill[data-ask-tab="answers"] .tab-badge')).toHaveText('12');
    await expect(sec(page).locator('.ask-more')).toHaveCount(0); // everything waiting is on screen
    // one of them approved: it leaves Waiting, and the list is read again
    await answer(page, 1001).getByRole('button', { name: 'Approve' }).click();
    await expect(answer(page, 1001)).toHaveCount(0);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toEqual({ p_ids: [1001], p_status: 'approved' });
    await expect(pill('pending')).toHaveText('Waiting (11)');
    // Show more: the rows read first, then older ones from the database, from the last id received
    await pill('all').click();
    await expect(sec(page).locator('.ask-a')).toHaveCount(60);
    for (let i = 2; i <= 5; i++) {
      await expect(sec(page).locator('.ask-more')).toHaveText('Show 60 more');
      await sec(page).locator('.ask-more').click();
      await expect(sec(page).locator('.ask-a')).toHaveCount(60 * i);
    }
    await expect(sec(page).locator('.ask-more')).toHaveText('Show older answers');
    asked.length = 0;
    await sec(page).locator('.ask-more').click();
    await expect(sec(page).locator('.ask-a')).toHaveCount(320);
    expect(asked.find((a) => a.p_before != null)).toEqual({ p_page: 1, p_status: null, p_round: null, p_before: 1021, p_limit: 300 });
    await expect(sec(page).locator('.ask-more')).toHaveCount(0);
    await expect(pill('approved')).toHaveText('Approved (309)'); // every answer read: the counts are exact
    await expect(pill('all')).toHaveText('All (320)');
    // Who answered what pages the same way, and the CSV of a longer page is read anew, 3000 at a time: nothing is cut
    db = make(3200); count();
    await page.evaluate(`_askBackGo();_askOpen(1,'results')`);
    await expect(sec(page).locator('.ask-who tbody tr')).toHaveCount(50);
    await expect(sec(page).locator('.ask-share-n')).toHaveText('Round 1 · Answers 3200'); // the people are counted from the answers: only once all are read
    asked.length = 0;
    const [file] = await Promise.all([page.waitForEvent('download'), sec(page).locator('.ask-csv').click()]);
    const csv = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c as Buffer[]).toString('utf8'));
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(3201);
    expect(lines[1]).toContain('Rider 4200,+966510004200,Your ideas,idea 4200,Approved,');
    expect(lines[3200]).toContain('Rider 1001,+966510001001,Your ideas,idea 1001,Waiting,');
    expect(asked.filter((a) => a.p_limit === 3000 && a.p_status === null)).toEqual([{ p_page: 1, p_status: null, p_round: null, p_before: null, p_limit: 3000 },
      { p_page: 1, p_status: null, p_round: null, p_before: 1201, p_limit: 3000 }]);
  });

  test('refusals in the section\'s own words: reading without the right, a write that changes nothing, another type for a question that has answers', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    const d = detail(); d.questions[7].answers = 0; d.questions[7].result = { n: 0, items: [] }; // no answer in this round: the type is free on screen
    await staff(page, { 'rpc:staff_ask_page': d });
    let how = 'locked';
    await page.route(/\/rest\/v1\/ask_questions(\?|$)/, (r) => (r.request().method() !== 'PATCH' ? r.fallback()
      : r.fulfill(how === 'locked' ? json({ code: '23514', message: 'ASK_KIND_LOCKED', details: null, hint: null }, 400) : json([]))));
    await openPage(page, 1, 'setup');
    await sec(page).locator('.ask-q').nth(7).locator('.ask-q-ed').click();
    await pop(page).locator('.ask-kind[data-ask-kind="cloud"]').click();
    await page.locator('#ask-q-done').click();
    // an older round's answers hold the type: the database says so, in the section's words
    await sec(page).locator('.ask-save').click();
    await expect(page.locator('.toast.error').last()).toHaveText('This question has answers, so its type cannot change.');
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
    await expect(sec(page).locator('#ask-dirty')).toBeVisible(); // the draft keeps what was not written
    // an update that changes no row: the account may look, not change
    how = 'none';
    await sec(page).locator('.ask-save').click();
    await expect(page.locator('.toast.error').last()).toHaveText('This account can look at Ask but not change it.');
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
    // a read the database refuses: who may not open it, said in place of the list
    await page.route(/\/rest\/v1\/rpc\/staff_ask_pages$/, (r) => r.fulfill(json({ code: '42501', message: 'FORBIDDEN', details: null, hint: null }, 403)));
    await page.evaluate(`_askBackGo();_ask().pages=null;_ask().at=0;renderAsk()`);
    await expect(sec(page).locator('.empty-state')).toHaveText('This account cannot open Ask.');
    await expect(sec(page).locator('.es-err')).toHaveCount(0);
  });

  test('the open page is in the address: a reload returns to it, and it leaves the address with the page or the section', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    await staff(page);
    const q = () => new URL(page.url()).searchParams.get('ask');
    await row(page, 1).waitFor();
    expect(q()).toBe(null);
    await row(page, 1).locator('.ask-pend').click(); // opens on its answers
    await expect.poll(q).toBe('1.answers');
    await sec(page).locator('.filter-pill[data-ask-tab="setup"]').click();
    await expect.poll(q).toBe('1');
    await sec(page).locator('.filter-pill[data-ask-tab="stats"]').click();
    await expect.poll(q).toBe('1.stats');
    expect(new URL(page.url()).pathname).toBe('/ask');
    // a reload comes back to the page and its tab
    await page.reload();
    await waitForSb(page);
    await expect(sec(page).locator('.filter-pill[data-ask-tab="stats"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(sec(page).locator('h1')).toHaveText('What would you like to see at the farm?');
    await expect(sec(page).locator('.ask-stats .ask-stat').first()).toHaveText('Answers37');
    expect(q()).toBe('1.stats');
    // another section: the address is that section's alone; Back returns to the page
    await page.evaluate(`setStaffTab('queue')`);
    await expect.poll(() => page.url()).not.toContain('ask=');
    expect(new URL(page.url()).pathname).toBe('/bookings');
    await page.goBack();
    await expect.poll(() => page.evaluate(`S.staffTab`)).toBe('ask');
    await expect.poll(q).toBe('1.stats');
    await expect(sec(page).locator('.filter-pill[data-ask-tab="stats"]')).toHaveAttribute('aria-pressed', 'true');
    // back on the list: nothing named
    await sec(page).locator('.ask-back').click();
    await expect.poll(q).toBe(null);
    await expect(sec(page).locator('.ask-pg')).toHaveCount(4);
    // a new page has no address until it is saved
    await sec(page).locator('.ask-new').click();
    expect(q()).toBe(null);
    await page.evaluate(`_askBackGo()`);
    // an address that names a page that is not there opens the list and forgets it
    await page.goto('/ask?ask=999.results');
    await waitForSb(page);
    await row(page, 1).waitFor();
    await expect.poll(q).toBe(null);
    // a link straight to a page's results
    await page.goto('/ask?ask=3.results');
    await waitForSb(page);
    await expect(sec(page).locator('.filter-pill[data-ask-tab="results"]')).toHaveAttribute('aria-pressed', 'true');
    await sec(page).locator('.ask-share').waitFor();
    expect(q()).toBe('3.results');
  });

  // ── Stage 2 (2026-11-13): the five more kinds (grid, pin, form, quiz, quiz_text), a right answer, the pace and the
  // presenter's strip, the board, the Reactions switch, Duplicate. No change to the database. ──

  test('the pop-up takes the five more kinds: each with its settings, its limits said in words before Done, and what Save writes; a multiple choice and a number may have a right answer', async ({ page }) => {
    test.setTimeout(120_000); // a long walk through the screens: room for a busy machine
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/ask_questions$/);
    let made = 0;
    await page.route(/\/rest\/v1\/ask_pages(\?|$)/, (r) => (r.request().method() === 'POST' ? r.fulfill(json([{ ...(r.request().postDataJSON() as Row), id: 80, code: '111444', round: 1 }], 201)) : r.fallback()));
    await page.route(/\/rest\/v1\/ask_questions(\?|$)/, (r) => (r.request().method() === 'POST' ? r.fulfill(json([{ ...(r.request().postDataJSON() as Row), id: 600 + ++made }], 201)) : r.fallback()));
    await sec(page).getByRole('button', { name: 'New question' }).click();
    await page.locator('#ask-title-en').fill('Quiz night');
    const done = page.locator('#ask-q-done'), err = page.locator('#ask-q-err'), kind = (k: string) => pop(page).locator(`.ask-kind[data-ask-kind="${k}"]`);
    // a grid: its items, the two axes by name, the highest value
    await sec(page).locator('.ask-q').first().locator('.ask-q-ed').click();
    await kind('grid').click();
    await expect(pop(page).locator('#ask-o-l')).toHaveText('Items');
    await expect(pop(page).locator('.ask-o')).toHaveCount(2);
    await page.getByRole('textbox', { name: 'Option 1, English' }).fill('Night ride');
    await page.getByRole('textbox', { name: 'Option 2, English' }).fill('Farm day');
    await done.click();
    await expect(err).toHaveText('Name both axes.');
    await pop(page).getByLabel('Horizontal axis (English)').fill('Effort');
    await pop(page).getByLabel('Vertical axis (Arabic)').fill('المتعة');
    await expect(pop(page).getByLabel('Highest value').locator('option')).toHaveText(['3', '4', '5', '6', '7', '8', '9', '10']);
    await expect(pop(page).getByLabel('Highest value')).toHaveValue('10');
    await pop(page).getByLabel('Highest value').selectOption('7');
    await done.click();
    await expect(pop(page)).toHaveCount(0);
    // a quiz: 2 to 6 options, the right one marked (it needs one), the seconds, points for speed
    const add = sec(page).getByRole('button', { name: 'Add question' });
    await add.click();
    await kind('quiz').click();
    await page.getByRole('textbox', { name: 'Option 1, English' }).fill('Yes');
    await page.getByRole('textbox', { name: 'Option 2, English' }).fill('No');
    await pop(page).getByRole('button', { name: 'Add option' }).click();
    await page.getByRole('textbox', { name: 'Option 3, English' }).fill('Maybe');
    await expect(pop(page).getByLabel('Seconds to answer')).toHaveValue('20');
    await expect(pop(page).getByRole('switch', { name: 'More points for a faster answer' })).toBeChecked();
    await done.click();
    await expect(err).toHaveText('Mark the right answer.');
    const right = (n: number) => pop(page).getByRole('button', { name: `Option ${n} is right` });
    await expect(right(2)).toHaveText('Right');
    await expect(right(2)).toHaveAttribute('aria-pressed', 'false');
    await right(2).click();
    await expect(right(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(right(2)).toBeFocused();
    await pop(page).getByLabel('Seconds to answer').fill('15');
    await pop(page).getByRole('switch', { name: 'More points for a faster answer' }).uncheck();
    await done.click();
    await expect(pop(page)).toHaveCount(0);
    // a typed quiz: the answers it accepts, one a line (1 to 10), its seconds and the longest answer
    await add.click();
    await kind('quiz_text').click();
    const accept = pop(page).getByLabel('Accepted answers, one a line');
    await done.click();
    await expect(err).toHaveText('Write at least one accepted answer.');
    await accept.fill(Array.from({ length: 11 }, (_, i) => `answer ${i + 1}`).join('\n'));
    await done.click();
    await expect(err).toHaveText('10 accepted answers at most.');
    await accept.fill('Riyadh\n riyadh   city \n\nالرياض\nRiyadh');
    await expect(pop(page).getByLabel('Seconds to answer')).toHaveValue('30');
    await pop(page).getByLabel('Longest answer, in characters').fill('30');
    await done.click();
    await expect(pop(page)).toHaveCount(0);
    // a short form: 1 to 8 fields, each a label, what it takes and whether it must be filled
    await add.click();
    await kind('form').click();
    await expect(pop(page).locator('#ask-ff-l')).toHaveText('Fields');
    await expect(pop(page).locator('.ask-ff')).toHaveCount(1);
    await expect(page.locator('#ask-q-res')).toHaveCount(1);
    await done.click();
    await expect(err).toHaveText('Give every field a label, or remove it.');
    await page.getByRole('textbox', { name: 'Field 1, English' }).fill('T-shirt size');
    await expect(pop(page).getByLabel('Field 1, what it takes').locator('option')).toHaveText(['Text', 'Number', 'One of a list']);
    await pop(page).getByLabel('Field 1, what it takes').selectOption('choice');
    await expect(pop(page).locator('.ask-ffo .ask-o')).toHaveCount(2);
    await done.click();
    await expect(err).toHaveText('A list field needs at least 2 options, each filled in.');
    await page.getByRole('textbox', { name: 'Field 1, option 1, English' }).fill('S');
    await page.getByRole('textbox', { name: 'Field 1, option 2, English' }).fill('M');
    await pop(page).getByRole('button', { name: 'Add field' }).click();
    await expect(page.getByRole('textbox', { name: 'Field 2, English' })).toBeFocused();
    await page.getByRole('textbox', { name: 'Field 2, English' }).fill('Children');
    await pop(page).getByLabel('Field 2, what it takes').selectOption('number');
    await pop(page).locator('.ask-ff').nth(1).getByRole('switch', { name: 'Required' }).uncheck();
    await expect(pop(page).getByRole('button', { name: 'Remove 2', exact: true })).toBeEnabled();
    await done.click();
    await expect(pop(page)).toHaveCount(0);
    // a multiple choice and a number may say which answer is right
    await add.click();
    await kind('choice').click();
    await page.getByRole('textbox', { name: 'Option 1, English' }).fill('Thursday');
    await page.getByRole('textbox', { name: 'Option 2, English' }).fill('Friday');
    await right(1).click();
    await done.click();
    await add.click();
    await kind('number').click();
    await pop(page).getByLabel('Right answer (optional)').fill('500');
    await done.click();
    await expect(err).toHaveText('The right answer must be between the smallest and the largest number.');
    await pop(page).getByLabel('Right answer (optional)').fill('42');
    await done.click();
    await expect(sec(page).locator('.ask-q .ask-q-txt .am-meta')).toHaveText(['Two-axis grid', 'Quiz, pick the answer', 'Quiz, type the answer', 'Short form', 'Multiple choice', 'Number']);
    // Save: each kind's settings as the database takes them
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(6);
    const cfg = (i: number) => [sent[i].body.kind, sent[i].body.config];
    expect(cfg(0)).toEqual(['grid', { options: [{ id: 'a1', en: 'Night ride', ar: '' }, { id: 'a2', en: 'Farm day', ar: '' }], max: 7, x_en: 'Effort', x_ar: '', y_en: '', y_ar: 'المتعة' }]);
    expect(cfg(1)).toEqual(['quiz', { options: [{ id: 'a1', en: 'Yes', ar: '' }, { id: 'a2', en: 'No', ar: '' }, { id: 'a3', en: 'Maybe', ar: '' }], correct: ['a2'], seconds: 15, speed: false }]);
    expect(cfg(2)).toEqual(['quiz_text', { accept: ['Riyadh', 'riyadh city', 'الرياض'], seconds: 30, speed: true, max_len: 30 }]);
    expect(cfg(3)).toEqual(['form', { fields: [{ id: 'f1', en: 'T-shirt size', ar: '', type: 'choice', required: true, options: [{ id: 'a1', en: 'S', ar: '' }, { id: 'a2', en: 'M', ar: '' }] },
      { id: 'f2', en: 'Children', ar: '', type: 'number', required: false }] }]);
    expect(cfg(4)).toEqual(['choice', { options: [{ id: 'a1', en: 'Thursday', ar: '' }, { id: 'a2', en: 'Friday', ar: '' }], correct: ['a1'], max_picks: 1, change: false }]);
    expect(cfg(5)).toEqual(['number', { min: 0, max: 100, step: 1, unit_en: '', unit_ar: '', correct: 42 }]);
    expect(sent.every((s) => s.body.image === null && s.body.page_id === 80)).toBe(true);
  });

  test('a pin question needs its picture, and its right area is marked on it: a tap for its centre, sliders to move and size it', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    await staff(page);
    const sent = writes(page, /\/rest\/v1\/ask_questions$/);
    const ups: string[] = [], png = Buffer.from(PNG, 'base64');
    let made = 0;
    await page.route(/\/storage\/v1\/object\/site\//, (r) => { if (r.request().method() === 'POST') ups.push(new URL(r.request().url()).pathname.replace(/^.*\/object\/site\//, '')); return r.fulfill(json({ Key: 'site/x', Id: 'x' })); });
    await page.route('https://micromobility.sa/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png }));
    await page.route(/\/rest\/v1\/ask_questions(\?|$)/, (r) => (r.request().method() === 'POST' ? r.fulfill(json([{ ...(r.request().postDataJSON() as Row), id: 650 + ++made }], 201)) : r.fallback()));
    await openPage(page, 1, 'setup');
    await sec(page).getByRole('button', { name: 'Add question' }).click();
    await pop(page).locator('.ask-kind[data-ask-kind="pin"]').click();
    await page.locator('#ask-q-title-en').fill('Where should the tent go?');
    // no picture: said before anything is written (the database refuses a pin without one)
    await expect(pop(page).locator('.ask-pin')).toHaveCount(0);
    await page.locator('#ask-q-done').click();
    await expect(page.locator('#ask-q-err')).toHaveText('A pin question needs its picture.');
    const ch = page.waitForEvent('filechooser');
    await pop(page).getByRole('group', { name: 'Picture' }).getByRole('button', { name: 'Upload picture' }).click();
    await (await ch).setFiles({ name: 'field.png', mimeType: 'image/png', buffer: png });
    await expect.poll(() => ups.length).toBe(1);
    const url = 'https://micromobility.sa/media/' + ups[0];
    // the picture, to mark the right area on; none yet, and none is needed
    const box = pop(page).locator('#ask-pin');
    await expect(box.locator('img')).toHaveAttribute('src', url + '?w=640');
    await expect(pop(page).locator('#ask-pin-l')).toHaveText('Right area (optional): tap the picture');
    await expect(box.locator('.ask-pin-ring')).toHaveCount(0);
    await pop(page).getByRole('button', { name: 'Mark a right area' }).click();
    const ring = box.locator('.ask-pin-ring'), at = () => ring.evaluate((e: HTMLElement) => ['--x', '--y', '--d'].map((k) => e.style.getPropertyValue(k)));
    await expect(ring).toHaveCount(1);
    expect(await at()).toEqual(['50%', '50%', '20%']);
    await expect(pop(page).getByLabel('Across')).toBeFocused(); // the sliders are the keyboard's way to the same thing
    await expect(pop(page).getByLabel('Across')).toHaveValue('50');
    await expect(pop(page).getByLabel('Size')).toHaveValue('10');
    // a tap on the picture puts the centre there
    await expect.poll(() => box.evaluate((e: HTMLElement) => e.style.getPropertyValue('--ar'))).toBe('0.6667'); // the box takes the picture's proportions: 40 by 60
    const b = (await box.boundingBox())!;
    expect(Math.abs(b.width / b.height - 2 / 3)).toBeLessThan(0.02);
    expect(b.height).toBeLessThan(page.viewportSize()!.height * 0.6);
    await box.click({ position: { x: Math.round(b.width * 0.7), y: Math.round(b.height * 0.35) } });
    await expect(pop(page).getByLabel('Across')).toHaveValue('70');
    await expect(pop(page).getByLabel('Down')).toHaveValue('35');
    // a slider sizes it, and the ring follows without the pop-up being drawn again
    await pop(page).getByLabel('Size').evaluate((e: HTMLInputElement) => { e.value = '12'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(await at()).toEqual(['70%', '35%', '24%']);
    const ringBox = (await ring.boundingBox())!;
    expect(Math.abs(ringBox.width - ringBox.height)).toBeLessThan(1); // a circle, 24% of the picture's width across
    expect(Math.abs(ringBox.width / b.width - 0.24)).toBeLessThan(0.02);
    await page.locator('#ask-q-done').click();
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toMatchObject({ kind: 'pin', pos: 11, title_en: 'Where should the tent go?', image: url, config: { correct: { x: 0.7, y: 0.35, r: 0.12 } } });
    expect(sent[0].body.config).toEqual({ correct: { x: 0.7, y: 0.35, r: 0.12 } });
  });

  test('pace: Setup says who leads; on a page staff lead, Results opens with the presenter\'s strip, and every control asks staff_ask_control and is drawn only once the database said yes', async ({ page }) => {
    test.setTimeout(120_000); // a long walk through the screens: room for a busy machine
    const db = liveDetail();
    await staff(page, { 'rpc:staff_ask_answers': liveAnswers() });
    const sent = writes(page, /\/rest\/v1\/(ask_pages|rpc\/staff_ask_control)$/);
    // the database: a control changes what staff_ask_page answers next; `gate` holds its answer back, `refuse` refuses it
    let refuse = false, gate: Promise<void> | null = null, letGo: () => void = () => {};
    await page.route(/\/rest\/v1\/rpc\/staff_ask_page$/, (r) => r.fulfill(json(db)));
    await page.route(/\/rest\/v1\/rpc\/staff_ask_control$/, async (r) => {
      if (gate) await gate;
      if (refuse) return r.fulfill(json({ code: '42501', message: 'FORBIDDEN', details: null, hint: null }, 403));
      const c = r.request().postDataJSON() as { p_action: string; p_question: number }, q = db.questions.find((x) => x.id === c.p_question)!;
      if (c.p_action === 'show') { q.started_at = new Date().toISOString(); q.open = true; q.reveal = false; db.page.current_q = q.id; }
      else if (c.p_action === 'reveal') { q.reveal = true; q.open = false; }
      else if (c.p_action === 'hide') q.reveal = false;
      else q.open = c.p_action === 'open';
      return r.fulfill(json({ ok: true }));
    });
    await openPage(page, 1, 'setup');
    // Setup: the pace is the page's, written with it
    const pace = sec(page).getByRole('group', { name: 'Pace' });
    await expect(pace.locator('.toggle-btn')).toHaveText(['Everyone at their own pace', 'We show one question at a time']);
    await expect(pace.getByRole('button', { name: 'We show one question at a time' })).toHaveAttribute('aria-pressed', 'true');
    await pace.getByRole('button', { name: 'Everyone at their own pace' }).click();
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ m: 'PATCH', path: 'ask_pages', body: { pace: 'self' } });
    await expect(pace.getByRole('button', { name: 'We show one question at a time' })).toHaveAttribute('aria-pressed', 'true'); // the stubbed database holds the page as it was
    sent.length = 0;
    // Results leads with the strip: nothing shown yet, every question with its own Show now
    await sec(page).locator('.filter-pill[data-ask-tab="results"]').click();
    const strip = sec(page).locator('.ask-live'), now = strip.locator('.ask-live-now'), run = (id: number) => strip.locator(`.ask-run-q[data-ask-run="${id}"]`);
    const btn = (name: string) => strip.locator('.ask-live-acts').getByRole('button', { name, exact: true });
    await expect(strip.locator('h2')).toHaveText('On screen now');
    expect(await sec(page).locator('.ask-body > *').first().evaluate((e) => e.className)).toContain('ask-live'); // it leads the tab
    await expect(now).toHaveText('Nothing shown yet');
    await expect(btn('Previous')).toBeDisabled();
    await expect(btn('Next')).toBeEnabled();
    await expect(strip.locator('.ask-run-q')).toHaveCount(8); // the text slide too: it is shown like any other
    await expect(strip.locator('.ask-run-q .ask-chip')).toHaveText(Array(8).fill('Not shown yet'));
    await expect(strip.locator('.ask-show')).toHaveCount(8);
    // Next shows the first question: asked, and drawn only once the database has answered
    gate = new Promise<void>((go) => { letGo = go; });
    await btn('Next').click();
    await expect(btn('Next')).toBeDisabled();
    await expect(now).toHaveText('Nothing shown yet');
    await expect(run(31).locator('.ask-chip')).toHaveText('Not shown yet');
    gate = null; letGo();
    await expect(now.locator('b')).toHaveText('Which wheel is a road bike\'s?');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ m: 'POST', path: 'rpc/staff_ask_control', body: { p_page: 1, p_action: 'show', p_question: 31 } });
    await expect(run(31).locator('.ask-chip')).toHaveText('On screen');
    await expect(run(31).locator('.ask-show')).toHaveCount(0);
    await expect(run(32).locator('.ask-chip')).toHaveText('Not shown yet');
    // a quiz on screen: its clock, counted down from the moment it was shown
    const clock = now.locator('#ask-clock');
    await expect(clock).toHaveAttribute('role', 'timer');
    await expect(clock).toHaveText(/^0:(20|1\d)$/);
    const first = await clock.textContent();
    await expect.poll(() => clock.textContent(), { timeout: 8000 }).not.toBe(first);
    // Close and Open, Reveal and Hide: each its own call; revealing also stops the question taking answers
    await btn('Close answers').click();
    await expect(btn('Open for answers')).toBeVisible();
    await btn('Open for answers').click();
    await expect(btn('Close answers')).toBeVisible();
    await btn('Reveal the answer').click();
    await expect(btn('Hide the answer')).toBeVisible();
    await expect(btn('Open for answers')).toBeVisible();
    await expect(sec(page).locator('.ask-r[data-ask-r="31"] .am-meta').first()).toContainText('Closed · Answer revealed');
    await btn('Hide the answer').click();
    await expect(btn('Reveal the answer')).toBeVisible();
    expect(sent.slice(1).map((s) => [s.body.p_action, s.body.p_question])).toEqual([['close', 31], ['open', 31], ['reveal', 31], ['hide', 31]]);
    // Show now on any question; one with no right answer has nothing to reveal, and no clock
    await run(33).getByRole('button', { name: 'Show now: Place each idea' }).click();
    await expect(now.locator('b')).toHaveText('Place each idea');
    await expect(run(31).locator('.ask-chip')).toHaveText('Shown');
    await expect(run(33).locator('.ask-chip')).toHaveText('On screen');
    await expect(clock).toHaveCount(0);
    await expect(btn('Reveal the answer')).toHaveCount(0);
    await expect(btn('Close answers')).toBeVisible();
    // Previous and Next go by the questions' places
    await btn('Previous').click();
    await expect(now.locator('b')).toHaveText('Name the city of the Saturday ride');
    await expect(clock).toHaveText(/^0:(30|2\d)$/);
    await btn('Next').click();
    await expect(now.locator('b')).toHaveText('Place each idea');
    expect(sent.slice(5).map((s) => [s.body.p_action, s.body.p_question])).toEqual([['show', 33], ['show', 32], ['show', 33]]);
    // the last one: a text slide is shown too, with nothing to open, close or reveal; Next has nowhere to go
    await run(38).getByRole('button', { name: 'Show now: Thank you!' }).click();
    await expect(now.locator('b')).toHaveText('Thank you!');
    await expect(btn('Next')).toBeDisabled();
    await expect(strip.locator('.ask-live-acts .btn-sm')).toHaveText(['Previous', 'Next']);
    // a refusal is said in words, and the strip stays as the database has it
    refuse = true;
    await btn('Previous').click();
    await expect(page.locator('.toast.error').last()).toHaveText('This account can look at Ask but not change it.');
    await expect(now.locator('b')).toHaveText('Thank you!');
    await expect(btn('Previous')).toBeEnabled();
    refuse = false;
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
    // a page at its own pace has no strip; a question with a right answer is still revealed and hidden from its results
    db.page.pace = 'self';
    await page.evaluate(`_askDetail()`);
    await expect(strip).toHaveCount(0);
    const res = (id: number) => sec(page).locator(`.ask-r[data-ask-r="${id}"]`);
    await expect(res(33).locator('.ask-reveal')).toHaveCount(0);
    await expect(res(35).locator('.ask-reveal')).toHaveCount(0);
    sent.length = 0;
    await res(36).getByRole('button', { name: 'Reveal the answer' }).click();
    await expect(res(36).getByRole('button', { name: 'Hide the answer' })).toBeVisible();
    await expect(res(36).locator('.am-meta').first()).toContainText('Answer revealed');
    expect(sent.map((s) => s.body)).toEqual([{ p_page: 1, p_action: 'reveal', p_question: 36 }]);
    await expect(sec(page).locator('.ask-reveal')).toHaveCount(5); // the two quizzes, the pin, the multiple choice and the number with a right answer
  });

  test('Results and Answers of the five more kinds: a grid\'s square, pins on the picture, a form\'s answers by their labels, a quiz with its right answer, points and time, the board; the CSV carries them', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    await staff(page, { 'rpc:staff_ask_page': liveDetail({ pace: 'self' }), 'rpc:staff_ask_answers': liveAnswers() });
    await page.route('https://micromobility.sa/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }));
    await row(page, 1).locator('.ask-pg-t').click();
    const res = (id: number) => sec(page).locator(`.ask-r[data-ask-r="${id}"]`);
    await expect(sec(page).locator('.ask-live')).toHaveCount(0);
    await expect(sec(page).locator('.ask-r')).toHaveCount(7); // the slide has none
    // a quiz: the right option marked in words, and how many were right
    await expect(res(31).locator('.am-meta').first()).toContainText('Quiz, pick the answer · Answers 9');
    await expect(res(31).locator('.ask-r-right')).toHaveText('Right: 6 of 9');
    await expect(res(31).locator('.ask-bar-l')).toHaveText(['26 inch', '700c Right', '20 inch']);
    await expect(res(31).locator('.ask-bar-x')).toHaveText(['2 · 22%', '6 · 67%', '1 · 11%']);
    // a typed quiz: how many were right, what is taken as right, what people typed most
    await expect(res(32).locator('.ask-r-right')).toHaveText('Right: 5 of 7 · Accepted: Riyadh, الرياض');
    await expect(res(32).locator('.ask-bar-l')).toHaveText(['Riyadh Right', 'Jeddah', 'الرياض Right']);
    await expect(res(32).locator('.ask-bar-x')).toHaveText(['4', '2', '1']);
    // a grid: each item's average place on the square, a numbered mark with the same number in the key
    await expect(res(33).locator('svg.ask-grid-svg')).toHaveAttribute('aria-label', 'Place each idea');
    await expect(res(33).locator('circle.ask-grid-dot')).toHaveCount(2);
    expect(await res(33).locator('circle.ask-grid-dot').first().evaluate((e) => [e.getAttribute('cx'), e.getAttribute('cy')])).toEqual(['34.9', '21.4']); // 3.2 and 8.4 of 10, from the bottom left
    await expect(res(33).locator('text.ask-grid-n')).toHaveText(['1', '2']);
    await expect(res(33).locator('.ask-grid-key li')).toHaveText(['Night ride 3.2, 8.4', 'Farm day 5.5, 9.1']);
    await expect(res(33).locator('.ask-grid-x')).toHaveText('Effort');
    await expect(res(33).locator('.ask-grid-y')).toHaveText('Fun');
    // a pin: every pin a dot on the picture, the right area ringed
    await expect(res(34).locator('.ask-pin img')).toHaveAttribute('src', PIC + '?w=640');
    await expect(res(34).locator('.ask-pin-dots circle')).toHaveCount(3);
    expect(await res(34).locator('.ask-pin-dots circle').nth(1).evaluate((e) => [e.getAttribute('cx'), e.getAttribute('cy')])).toEqual(['68.0%', '33.0%']);
    expect(await res(34).locator('.ask-pin-ring').evaluate((e: HTMLElement) => ['--x', '--y', '--d'].map((k) => e.style.getPropertyValue(k)))).toEqual(['70.0%', '35.0%', '24.0%']);
    // a multiple choice and a number with a right answer
    await expect(res(36).locator('.ask-r-right')).toHaveText('Right: 3 of 4');
    await expect(res(36).locator('.ask-bar-l')).toHaveText(['Thursday Right', 'Friday']);
    await expect(res(37).locator('.ask-stat')).toHaveText(['Average40', 'Lowest38', 'Highest42', 'Right answer42']);
    // the board: staff only, by name
    const board = sec(page).locator('.ask-board');
    await expect(board.locator('h2')).toHaveText('Board');
    await expect(board.locator('thead th')).toHaveText(['Place', 'Name', 'Points', 'Answers']);
    await expect(board.locator('tbody tr')).toHaveCount(3);
    await expect(board.locator('tbody tr').first().locator('td')).toHaveText(['1', 'Lina Haddad', '1870', '2']);
    // the CSV: a quiz answer's points and seconds, and a column for each field of the form
    const [file] = await Promise.all([page.waitForEvent('download'), sec(page).locator('.ask-csv').click()]);
    const csv = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c as Buffer[]).toString('utf8'));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0].replace(/^[^N]*/, '')).toBe('Name,Mobile,Question,Answer,Status,Time,Points,Seconds,T-shirt size,Children,Notes');
    expect(lines).toHaveLength(10);
    expect(lines[1]).toMatch(/^Lina Haddad,\+966551112222,Which wheel is a road bike's\?,700c,Approved,("[^"]*"|[^,]*),870,5\.2,,,$/);
    expect(lines[2]).toMatch(/^Omar Saleh,\+966553334444,Which wheel is a road bike's\?,26 inch,Approved,("[^"]*"|[^,]*),0,9\.1,,,$/);
    expect(lines[3]).toMatch(/^Sara Ali,\+966555556666,Name the city of the Saturday ride,Riyadh,Approved,("[^"]*"|[^,]*),1000,,,,$/);
    expect(lines[6]).toMatch(/^Lina Haddad,\+966551112222,Your details,"T-shirt size: M · Children: 2 · Notes: Vegetarian, please",Approved,("[^"]*"|[^,]*),,,M,2,"Vegetarian, please"$/);
    expect(lines[7]).toMatch(/^Omar Saleh,\+966553334444,Your details,T-shirt size: S,Approved,("[^"]*"|[^,]*),,,S,,$/);
    // a form: nothing public but how many, and the way to its answers, read by their labels
    await expect(res(35).locator('.am-meta').first()).toContainText('Short form · Answers 2');
    await res(35).getByRole('button', { name: 'See the answers' }).click();
    await expect(sec(page).locator('.filter-pill[data-ask-tab="answers"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(sec(page).locator('.filter-pill[data-ask-at="all"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(sec(page).locator('.ask-a .ask-a-txt')).toHaveText(['T-shirt size: M · Children: 2 · Notes: Vegetarian, please', 'T-shirt size: S']);
    // every answer in words: a quiz answer with its points and its time, right or wrong
    await page.evaluate(`_askAQ('')`);
    await expect(sec(page).locator('.ask-a')).toHaveCount(9);
    await expect(answer(page, 220).locator('.ask-a-txt')).toHaveText('700c · 870 points · 5.2 s');
    await expect(answer(page, 220).locator('.ask-chip')).toHaveText(['Approved', 'Right']);
    await expect(answer(page, 219).locator('.ask-a-txt')).toHaveText('26 inch · 0 points · 9.1 s');
    await expect(answer(page, 219).locator('.ask-chip')).toHaveText(['Approved', 'Wrong']);
    await expect(answer(page, 218).locator('.ask-a-txt')).toHaveText('Riyadh · 1000 points'); // at its own pace: no clock ran
    await expect(answer(page, 218).getByRole('button', { name: 'Edit text' })).toHaveCount(0); // a quiz answer is not corrected
    await expect(answer(page, 217).locator('.ask-a-txt')).toHaveText('Night ride: 3, 8 · Farm day: 6, 9');
    await expect(answer(page, 216).locator('.ask-a-txt')).toHaveText('68%, 33%');
    await expect(answer(page, 212).locator('.ask-a-txt')).toHaveText('42 km');
  });

  test('Duplicate makes a draft copy: the page with (copy) and a link name of its own, then every question with its settings, its look and its picture; none of the answers', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    const d = liveDetail({ look: { theme: 'dark', reactions: true }, audience: 'tags', tag_ids: ['tag_saturday'], not_tag_ids: ['tag_vip'], only_gender: 'female', min_age: 16, max_age: null, block_words: ['casino'],
      title_ar: 'ماذا تود أن ترى؟', notes: 'For the farm day', opens_at: ago(4000), closes_at: inDays(5), listed: false, after_close: 'hidden', round: 3 });
    d.questions[0].look = { viz: 'columns' };
    const list = [...pages(), pageRow({ id: 9, slug: 'farm-ideas-copy', title_en: 'An older copy', status: 'draft', open: false, answers: 0, people: 0, pending: 0 })];
    await staff(page, { 'rpc:staff_ask_pages': list, 'rpc:staff_ask_page': d });
    const sent = writes(page, /\/rest\/v1\/(ask_pages|ask_questions)$/);
    let clash = 1, made = 0;
    await page.route(/\/rest\/v1\/ask_pages(\?|$)/, (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      if (clash-- > 0) return r.fulfill(json({ code: '23505', message: 'duplicate key value violates unique constraint "ask_pages_slug_key"', details: null, hint: null }, 409));
      return r.fulfill(json([{ ...(r.request().postDataJSON() as Row), id: 90, code: '555666', round: 1 }], 201));
    });
    await page.route(/\/rest\/v1\/ask_questions(\?|$)/, (r) => (r.request().method() === 'POST' ? r.fulfill(json([{ id: 700 + ++made }], 201)) : r.fallback()));
    await openPage(page, 1, 'setup');
    const dup = sec(page).getByRole('button', { name: 'Duplicate' });
    // something unsaved: asked to save first, and nothing is sent
    await page.locator('#ask-notes').fill('changed');
    await dup.click();
    await expect(page.locator('.toast.error').last()).toHaveText('Save the page before duplicating it.');
    expect(sent).toHaveLength(0);
    await page.locator('#ask-notes').fill('For the farm day');
    await expect(sec(page).locator('#ask-dirty')).toBeHidden();
    await dup.click();
    await expect.poll(() => sent.length).toBe(10);
    // the link name: -copy is another page's here, -copy-2 the database refused (taken meanwhile), -copy-3 it is
    expect(sent.slice(0, 2).map((s) => [s.m, s.path, s.body.slug])).toEqual([['POST', 'ask_pages', 'farm-ideas-copy-2'], ['POST', 'ask_pages', 'farm-ideas-copy-3']]);
    // the page: its titles say (copy), its look, who sees it and its blocked words come too; a draft with no window
    expect(sent[1].body).toEqual({ title_en: 'What would you like to see at the farm? (copy)', title_ar: 'ماذا تود أن ترى؟ (نسخة)', intro_en: 'A private farm with a big garden.', intro_ar: '', slug: 'farm-ideas-copy-3',
      audience: 'tags', tag_ids: ['tag_saturday'], not_tag_ids: ['tag_vip'], only_gender: 'female', min_age: 16, max_age: null, opens_at: null, closes_at: null, after_close: 'hidden', listed: false,
      notes: 'For the farm day', look: { theme: 'dark', reactions: true }, block_words: ['casino'], pace: 'live', status: 'draft' }); // no round, no code, no current question: a new page
    // then its questions in order, each with its settings, its look and its picture, open and never shown
    const qs = sent.slice(2), src = liveQs();
    expect(qs.map((s) => [s.m, s.path, s.body.page_id, s.body.pos, s.body.kind])).toEqual(src.map((q, i) => ['POST', 'ask_questions', 90, i + 1, q.kind]));
    expect(qs[0].body).toEqual({ page_id: 90, pos: 1, kind: 'quiz', title_en: 'Which wheel is a road bike\'s?', title_ar: '', help_en: '', help_ar: '', config: src[0].config, moderated: true, results: 'live',
      look: { viz: 'columns' }, image: null, open: true });
    expect(qs[3].body).toMatchObject({ kind: 'pin', image: PIC, config: { correct: { x: 0.7, y: 0.35, r: 0.12 } } });
    expect(qs[4].body.config).toEqual(src[4].config);
    expect(qs.every((s) => !('started_at' in s.body) && !('reveal' in s.body) && !('answers' in s.body))).toBe(true);
    // it lands on the copy's Setup, quietly
    await expect.poll(() => new URL(page.url()).searchParams.get('ask')).toBe('90');
    await expect(sec(page).locator('.filter-pill[data-ask-tab="setup"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
  });

  test('look, stage two: the Reactions switch is written only when on; the five kinds\' charts and choices are the contract\'s, and a form has no chart', async ({ page }) => {
    test.setTimeout(90_000); // a long walk through the screens: room for a busy machine
    await staff(page, { 'rpc:staff_ask_page': liveDetail({ pace: 'self' }) });
    await page.route('https://micromobility.sa/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }));
    const sent = writes(page, /\/rest\/v1\/(ask_pages|ask_questions)$/);
    await openPage(page, 1, 'setup');
    // the page's Reactions: off when nothing is said, so only "on" is written
    const react = sec(page).getByRole('switch', { name: 'Reaction buttons under each question' });
    await expect(react).not.toBeChecked();
    await react.check();
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ m: 'PATCH', path: 'ask_pages' });
    expect(sent[0].body.look).toEqual({ reactions: true });
    await expect(react).not.toBeChecked(); // the stubbed database holds the page as it was
    await react.check();
    await react.uncheck();
    expect(await page.evaluate(`JSON.stringify(_ask().cur.d.look)`)).toBe('{}');
    await expect(sec(page).locator('#ask-dirty')).toBeHidden();
    sent.length = 0;
    // the lists the website's must equal (contract H4)
    expect(await page.evaluate(`JSON.stringify([ASK_VIZ.grid,ASK_VIZ.pin,ASK_VIZ.quiz,ASK_VIZ.quiz_text,ASK_VIZ.form,ASK_LOOKS.grid,ASK_LOOKS.pin,ASK_LOOKS.quiz,ASK_LOOKS.quiz_text,ASK_LOOKS.form])`))
      .toBe('[["scatter"],["dots","heat"],["bars","columns"],["list","cloud"],[],"t","t","vt","tvnc","t"]');
    const card = (i: number) => sec(page).locator('.ask-q').nth(i), lk = pop(page).locator('.ask-look'), done = page.locator('#ask-q-done');
    // a quiz: bars or columns, the numbers and the count; never sorted
    await card(0).locator('.ask-q-ed').click();
    await expect(lk.locator('.ask-viz')).toHaveText(['Bars', 'Columns']);
    await expect(pop(page).locator('#ask-l-values, #ask-l-total')).toHaveCount(2);
    await expect(pop(page).locator('#ask-l-sort, #ask-l-limit, #ask-l-case')).toHaveCount(0);
    await lk.locator('.ask-viz[data-ask-viz="columns"]').click();
    await page.locator('#ask-l-values').selectOption('count');
    await done.click();
    // a typed quiz: a ranked list or a word cloud of what was typed
    await card(1).locator('.ask-q-ed').click();
    await expect(lk.locator('.ask-viz')).toHaveText(['Ranked list', 'Word cloud']);
    await expect(pop(page).locator('#ask-l-values, #ask-l-total, #ask-l-limit, #ask-l-case')).toHaveCount(4);
    await pop(page).locator('.chrome-xt').click();
    // a grid: one chart
    await card(2).locator('.ask-q-ed').click();
    await expect(lk.locator('.ask-viz')).toHaveText(['Scatter']);
    await expect(lk.locator('.ask-viz svg.ask-viz-pic')).toHaveCount(1);
    await expect(pop(page).locator('#ask-l-total')).toHaveCount(1);
    await expect(pop(page).locator('#ask-l-values, #ask-l-sort')).toHaveCount(0);
    await pop(page).locator('.chrome-xt').click();
    // a pin: dots or a heat map, the dots drawn as pins on a picture
    await card(3).locator('.ask-q-ed').click();
    await expect(lk.locator('.ask-viz')).toHaveText(['Dots', 'Heat map']);
    expect(await lk.locator('.ask-viz[data-ask-viz="dots"] svg circle').count()).toBe(5);
    expect(await lk.locator('.ask-viz[data-ask-viz="dots"] svg path').count()).toBe(1);
    await lk.locator('.ask-viz[data-ask-viz="heat"]').click();
    await done.click();
    // a form has no chart and no colours: only whether it says how many answered
    await card(4).locator('.ask-q-ed').click();
    await expect(lk).toHaveCount(1);
    await expect(lk.locator('.ask-viz, .ask-swb')).toHaveCount(0);
    await expect(pop(page).getByRole('switch', { name: 'Show how many answered' })).toBeChecked();
    await page.locator('#ask-l-total').uncheck();
    await done.click();
    await sec(page).locator('.ask-save').click();
    await expect.poll(() => sent.length).toBe(3);
    const by = (id: number) => sent.find((s) => s.q.includes(`id=eq.${id}`))!.body;
    expect(by(31).look).toEqual({ viz: 'columns', values: 'count' });
    expect(by(34).look).toEqual({ viz: 'heat' });
    expect(by(35).look).toEqual({ total: false });
    expect(by(31).config).toEqual(liveQs()[0].config); // its settings as they were
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
    for (const k of ['grid', 'pin', 'form', 'quiz', 'quiz_text']) await pop(page).locator(`.ask-kind[data-ask-kind="${k}"]`).click(); // stage 2's kinds
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
    // the second pass: a theme and a palette (drawings with their colours as attributes), a chart's drawing in the pop-up, the columns of the Stats tab
    await sec(page).locator('.ask-swb[data-ask-theme="dark"]').click();
    await sec(page).locator('.ask-swb[data-ask-palette="ocean"]').click();
    await sec(page).locator('.ask-q').nth(1).locator('.ask-q-ed').click();
    await pop(page).locator('.ask-viz[data-ask-viz="donut"]').click();
    await pop(page).locator('.ask-swb[data-ask-palette="berry"]').click();
    const berry = await pop(page).locator('.ask-swb[data-ask-palette="berry"] svg rect').nth(1).getAttribute('fill'); // the palette's first colour, off its swatch
    expect(berry).toMatch(/^#[0-9a-f]{6}$/);
    await expect(pop(page).locator('.ask-viz[data-ask-viz="donut"] svg circle').first()).toHaveAttribute('stroke', berry!);
    await pop(page).locator('.chrome-xt').click();
    await sec(page).locator('.filter-pill[data-ask-tab="stats"]').click();
    const col = sec(page).locator('.ask-sc[data-ask-s="day"] .ask-tcol-b').nth(1);
    await col.waitFor();
    await expect.poll(() => col.evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThan(20); // a column's height is a run-time value too
    await page.locator('#ask-sg-q').selectOption('12');
    await sec(page).locator('.ask-mult-c .ask-bar-f').first().waitFor();
    expect(await page.evaluate(() => (window as unknown as Cspv).__cspv.slice())).toEqual([]);
  });
});
