import { test, expect, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';
import { tapReports, waitReport } from './helpers/reports';

// Ask's answers report builder (the user, 2026-11-14: "let me be able to extract a report with the answers for each ask
// question with a report builder with all possible fields to include in the report"): a page's answers on a PDF or an
// Excel workbook, each row an answer or a person, with every field an answer or its account carries, each question's
// results, the same group by group, the quiz board, filters, sorts and groups. All Supabase traffic is stubbed.
type Row = Record<string, unknown>;
const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const tags = [{ id: 'tag_saturday', name: 'Community', slug: 'saturday', color: '#0c7a3d', system: true }];
const customers = [
  { id: 'c1', name: 'Lina Haddad', phone: '+966551112222', email: 'lina@example.com', gender: 'female', birth_date: '1995-05-01', nationality: 'Saudi Arabia',
    city: 'Riyadh', profession: 'Engineer', socials: { instagram: 'lina.rides' }, created_at: '2026-01-05T08:00:00Z',
    emergency_name: 'Huda Haddad', emergency_phone: '+966550000001', emergency_relation: 'parent' },
  { id: 'c2', name: 'Omar Saleh', phone: '+966553334444', email: 'omar@example.com', gender: 'male', birth_date: '1988-02-10', nationality: 'Egypt',
    city: 'Jeddah', created_at: '2026-02-05T08:00:00Z' },
  { id: 'c3', name: 'Sara Ali', phone: '+966555556666', email: 'sara@example.com', created_at: '2026-03-05T08:00:00Z' },
];
const pageRow = (o: Row = {}): Row => ({ id: 1, slug: 'farm-day', code: '482913', title_en: 'Farm day', title_ar: '', intro_en: '', intro_ar: '', audience: 'link',
  tag_ids: [], status: 'live', opens_at: null, closes_at: null, after_close: 'results', pace: 'self', current_q: null, listed: true, round: 1, notes: '',
  look: {}, ver: 3, created_at: ago(3000), open: true, questions: 6, answers: 10, people: 3, pending: 1, ...o });
const opt = (id: string, en: string) => ({ id, en, ar: '' });
const qRow = (o: Row): Row => ({ page_id: 1, title_ar: '', help_en: '', help_ar: '', image: null, moderated: true, results: 'live', open: true, reveal: false,
  started_at: null, look: {}, answers: 0, pending: 0, result: { n: 0 }, ...o });
const questions = () => [
  qRow({ id: 41, pos: 1, kind: 'choice', title_en: 'Which day suits you?', config: { options: [opt('a1', 'Thursday'), opt('a2', 'Friday')], max_picks: 1, correct: ['a1'] } }),
  qRow({ id: 42, pos: 2, kind: 'cloud', title_en: 'Your ideas', config: { max_len: 40, per_person: 10 } }),
  qRow({ id: 43, pos: 3, kind: 'quiz', title_en: 'Which wheel?', config: { options: [opt('a1', '26 inch'), opt('a2', '700c')], correct: ['a2'], seconds: 20 } }),
  qRow({ id: 44, pos: 4, kind: 'form', title_en: 'Your details', config: { fields: [{ id: 'f1', en: 'T-shirt size', ar: '', type: 'choice', options: [opt('a1', 'S'), opt('a2', 'M')] },
    { id: 'f2', en: 'Notes', ar: '', type: 'text' }] } }),
  qRow({ id: 45, pos: 5, kind: 'qa', title_en: 'Ask the organisers', config: { max_len: 200, per_person: 3, votes: true } }),
  qRow({ id: 46, pos: 6, kind: 'info', title_en: 'Thank you!', config: {} }),
];
const ans = (id: number, qid: number, cid: string, value: Row, o: Row = {}): Row => {
  const c = customers.find((x) => x.id === cid)!;
  return { id, question_id: qid, round: 1, customer_id: cid, name: c.name, phone: c.phone, value, body: typeof value.t === 'string' ? value.t : null,
    status: 'approved', answered: false, flagged: false, score: null, ms: null, votes: 0, lang: 'en', created_at: ago(400 - id), reviewed_by: null, reviewed_at: null, ...o };
};
// newest first, as the function answers: ten answers, one waiting and one not approved
const answers = (rnd = 1) => [
  ans(310, 45, 'c3', { t: 'Is there parking?' }, { votes: 3, answered: true, lang: 'ar' }),
  ans(309, 44, 'c1', { f: { f1: 'a2', f2: 'Vegetarian' } }),
  ans(308, 43, 'c2', { o: ['a1'] }, { score: 0, ms: 9000 }),
  ans(307, 43, 'c1', { o: ['a2'] }, { score: 870, ms: 5200 }),
  ans(306, 42, 'c3', { t: 'pony rides' }, { status: 'pending' }),
  ans(305, 42, 'c1', { t: 'BBQ' }),
  ans(304, 42, 'c2', { t: 'bbq ' }),
  ans(303, 42, 'c2', { t: 'something rude' }, { status: 'rejected', reviewed_by: 'Malik', reviewed_at: ago(100) }),
  ans(302, 41, 'c2', { o: ['a2'] }),
  ans(301, 41, 'c1', { o: ['a1'] }),
].map((a) => ({ ...a, round: rnd }));
const base = (o: Row = {}): Fixtures => ({ sessions: [], queue_entries: [], bikes: [], customers, tags,
  customer_tags: [{ customer_id: 'c1', tag_id: 'tag_saturday', added_at: 1 }], staff_options: [],
  'rpc:staff_ask_pages': [pageRow(o)], 'rpc:staff_ask_page': { page: { ...pageRow(o), screen_key: 'sk_1' }, questions: questions(), board: [] },
  'rpc:staff_ask_answers': answers(), 'rpc:staff_ask_pending': 1, 'rpc:staff_ask_stats': {}, 'rpc:staff_ask_segment': { by: 'gender', segments: [] } });

async function staff(page: Page, o: Row = {}) {
  await stubSupabase(page, base(o));
  await unlockStaff(page);
  await page.goto('/ask');
  await waitForSb(page);
  await page.waitForFunction(`S.view==='staff'&&S.staffTab==='ask'`);
  await page.locator('#tab-ask .ask-pg[data-ask-pg="1"]').waitFor();
  await page.evaluate(`_askOpen(1,'results')`);
  await page.locator('#tab-ask .ask-share').waitFor();
}
const dlg = (page: Page) => page.locator('#print-opts-modal [role="dialog"]');
const count = (page: Page) => page.locator('#akr-count');
const set = (page: Page, name: string) => dlg(page).locator('[data-akr-set]', { hasText: name });
const field = (page: Page, label: string) => dlg(page).locator(`select[aria-label="${label}"]`);
/** A report's headings and tables, read from its page: { h2: [...], tables: [{ head, rows }] } (cells joined with |). */
async function readReport(page: Page, html: string) {
  return page.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html'), tx = (e: Element) => (e.textContent || '').replace(/\s+/g, ' ').trim();
    return { h2: [...d.querySelectorAll('.rx-main h2')].map(tx), tiles: [...d.querySelectorAll('.total-item')].map((e) => tx(e.querySelector('.total-lbl')!) + '=' + tx(e.querySelector('.total-num')!)),
      tables: [...d.querySelectorAll('.rx-main table')].map((t) => ({ head: [...t.querySelectorAll('thead th')].map(tx).join('|'),
        rows: [...t.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map(tx).join('|')) })) };
  }, html);
}
async function pdf(page: Page) {
  await tapReports(page);
  await dlg(page).locator('.rpt-acts .btn-primary').click();
  return readReport(page, await waitReport(page));
}

test.describe('@staff:ask Ask: the answers report builder', () => {
  test('an answer a row: from the page\'s top bar and its Results, each question\'s results from the approved answers, the list under each question, and Excel', async ({ page }) => {
    await staff(page);
    await expect(page.locator('#tab-ask .ask-share .ask-rb2')).toHaveText(/Report builder/); // Results, beside Export
    await page.locator('#tab-ask .ask-top .ask-rb').click();
    await expect(dlg(page).locator('.modal-title')).toHaveText('Answers report · Farm day');
    await expect(set(page, 'Answer list')).toHaveAttribute('aria-pressed', 'true');
    await expect(count(page)).toHaveText('On the report: 8 / 10'); // approved only, at first
    // every field an answer and its account carry is offered; a person's own columns are not, an answer a row
    const cols = await dlg(page).locator('[data-rep^="cols:"]').evaluateAll((b) => b.map((x) => x.getAttribute('data-rep')!.slice(5)));
    for (const k of ['name', 'phone', 'wa', 'email', 'gender', 'age', 'band', 'dob', 'nat', 'country', 'city', 'height', 'prof', 'work', 'ig', 'x', 'tiktok', 'linkedin',
      'member', 'tags', 'sports', 'heard', 'joined', 'emName', 'emPhone', 'emRel', 'em2', 'acct', 'qno', 'q', 'kind', 'ans', 'form', 'right', 'pts', 'secs', 'votes',
      'status', 'flag', 'answered', 'lang', 'at', 'revBy', 'revAt', 'round', 'aid']) expect(cols).toContain(k);
    for (const k of ['qcols', 'place', 'n', 'first', 'last']) expect(cols).not.toContain(k);
    const r = await pdf(page);
    expect(r.tiles).toEqual(expect.arrayContaining(['Answers=10', 'People=3', 'Approved=8', 'Waiting=1', 'Not approved=1', 'Average points=435', 'Right answers=50%']));
    expect(r.h2).toEqual([
      '1. Which day suits you? · Multiple choice · Answers 2 · People 2', '2. Your ideas · Word cloud · Answers 2 · People 2',
      '3. Which wheel? · Quiz, pick the answer · Answers 2 · People 2', '4. Your details · Short form · Answers 1 · People 1',
      '5. Ask the organisers · Questions from people · Answers 1 · People 1',
      '1. Which day suits you? · 2', '2. Your ideas · 2', '3. Which wheel? · 2', '4. Your details · 1', '5. Ask the organisers · 1']);
    expect(r.tables[0]).toEqual({ head: 'Answer|Answers|%|Right answer', rows: ['Thursday|1|50%|Right', 'Friday|1|50%|—'] });
    expect(r.tables[1].rows).toEqual(['BBQ|2|100%']); // two spellings of one word, the pending and the rejected left out
    expect(r.tables[2].rows).toEqual(['26 inch|1|50%|—', '700c|1|50%|Right']);
    expect(r.tables[3]).toEqual({ head: 'Fields|Answer|Answers', rows: ['T-shirt size|S|0', 'T-shirt size|M|1', 'Notes|—|1'] });
    expect(r.tables[4]).toEqual({ head: 'Answer|Name|Votes|Answered', rows: ['Is there parking?|Sara Ali|3|Yes'] });
    // the list: under each question, the newest first, numbered down the whole sheet
    expect(r.tables[5].head).toBe('No.|Name|Phone|Question|Answer|Status|Time');
    expect(r.tables[5].rows.map((x) => x.split('|').slice(0, 6).join('|'))).toEqual([
      '1|Omar Saleh|+966553334444|Which day suits you?|Friday|Approved', '2|Lina Haddad|+966551112222|Which day suits you?|Thursday|Approved']);
    expect(r.tables[9].rows[0]).toContain('8|Sara Ali|');
    // Excel: the list, the summary and the results
    const [dl] = await Promise.all([page.waitForEvent('download'), dlg(page).locator('.rpt-acts .btn-secondary', { hasText: 'Excel' }).click()]);
    expect(dl.suggestedFilename()).toBe('ask-farm-day_answers.xlsx');
    const buf = readFileSync((await dl.path())!).toString('utf8');
    for (const n of ['The list', 'Summary tiles', 'Each question\'s results']) expect(buf).toContain(`name="${n}"`);
    const s1 = buf.slice(buf.indexOf('<worksheet'), buf.indexOf('</worksheet>'));
    expect(s1).toContain('Group by'); // grouped by question: the group is the first column
    expect(s1.indexOf('Omar Saleh')).toBeLessThan(s1.indexOf('Lina Haddad'));
    expect(s1).not.toContain('something rude');
  });

  test('a person a row: every question in a column and each form field in its own, the filters, Picked, and the quiz board', async ({ page }) => {
    await staff(page);
    await page.locator('#tab-ask .ask-top .ask-rb').click();
    await set(page, 'People and their answers').click();
    await dlg(page).locator('[data-rep="cols:form"]').click();
    await expect(count(page)).toHaveText('On the report: 3 / 3');
    const nat = await page.evaluate(`nationalityLabel('Saudi Arabia')`) as string;
    const age = await page.evaluate(`_sxAgeAt('1995-05-01')`) as number;
    const r = await pdf(page);
    const list = r.tables[r.tables.length - 1];
    expect(list.head).toBe('No.|Name|Phone|Gender|Age|Nationality|Answers|1. Which day suits you?|2. Your ideas|3. Which wheel?|4. Your details · T-shirt size|4. Your details · Notes|5. Ask the organisers');
    expect(list.rows).toEqual([
      `1|Lina Haddad|+966551112222|Female|${age}|${nat}|4|Thursday|BBQ|700c|M|Vegetarian|—`,
      expect.stringMatching(/^2\|Omar Saleh\|\+966553334444\|Male\|\d+\|.+\|3\|Friday\|bbq\|26 inch\|—\|—\|—$/),
      '3|Sara Ali|+966555556666|—|—|—|1|—|—|—|—|—|Is there parking?']);
    // the filters: a gender, then the people who picked Thursday
    await field(page, 'Gender').selectOption('female');
    await expect(count(page)).toHaveText('On the report: 1 / 3');
    await field(page, 'Gender').selectOption('all');
    await dlg(page).locator('[aria-controls="fa-akr"]').click();
    await field(page, 'Picked').selectOption({ label: '1. Thursday' });
    await expect(count(page)).toHaveText('On the report: 1 / 3');
    await field(page, 'Picked').selectOption('');
    await field(page, 'Community').selectOption('yes');
    await expect(count(page)).toHaveText('On the report: 1 / 3');
    await field(page, 'Community').selectOption('all');
    await field(page, 'Status').selectOption('all');
    await expect(count(page)).toHaveText('On the report: 3 / 3');
    await field(page, 'Status').selectOption('approved');
    // Quiz scores: the place, the points, how many they got right and their seconds, and the board
    await set(page, 'Quiz scores').click();
    await expect(dlg(page).locator('[data-rep="secs:board"]')).toHaveAttribute('aria-pressed', 'true');
    const q = await pdf(page);
    const bi = q.h2.indexOf('Board · 2');
    expect(bi).toBeGreaterThan(-1);
    expect(q.tables[bi].rows).toEqual(['1|Lina Haddad|870|2 of 2|5.2', '2|Omar Saleh|0|0 of 2|9']);
    const ql = q.tables[q.tables.length - 1];
    expect(ql.head).toBe('No.|Name|Phone|Right or wrong|Points|Seconds|Place');
    expect(ql.rows.map((x) => x.split('|').slice(0, 7).join('|'))).toEqual([
      '1|Lina Haddad|+966551112222|2 of 2|870|5.2|1', '2|Omar Saleh|+966553334444|0 of 2|0|9|2', '3|Sara Ali|+966555556666|—|—|—|—']);
  });

  test('a page reset once: another round or every round, and each question group by group', async ({ page }) => {
    const seen: Row[] = [];
    page.on('request', (q: Request) => { if (new URL(q.url()).pathname.endsWith('/rpc/staff_ask_answers') && q.method() === 'POST') seen.push(q.postDataJSON() as Row); });
    await staff(page, { round: 2 });
    // round 2 (the one the page is on) holds two answers; round 1 the ten
    await page.route(/\/rest\/v1\/rpc\/staff_ask_answers/, (rt) => {
      const b = (rt.request().postDataJSON() || {}) as Row;
      const rows = b.p_round === 1 ? answers(1) : [ans(402, 41, 'c3', { o: ['a1'] }), ans(401, 41, 'c2', { o: ['a1'] })].map((a) => ({ ...a, round: 2 }));
      return rt.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(rows) });
    });
    await page.locator('#tab-ask .ask-top .ask-rb').click();
    await set(page, 'Answer list').click();
    const rnd = field(page, 'Round');
    await expect(rnd.locator('option')).toHaveText(['Round 2 (now)', 'Round 1', 'All rounds']);
    await expect(count(page)).toHaveText('On the report: 2 / 2');
    seen.length = 0;
    await rnd.selectOption('all');
    await expect(count(page)).toHaveText('On the report: 10 / 12');
    expect(seen.filter((x) => x.p_limit === 3000 && x.p_status === null).map((x) => x.p_round)).toEqual([1, 2]);
    // each question, group by group: by gender, then by the day picked
    await dlg(page).locator('[data-rep="secs:cross"]').click();
    await expect(field(page, 'Split results by')).toHaveValue('gender');
    let r = await pdf(page);
    const ci = r.h2.indexOf('1. Which day suits you? · Gender');
    expect(ci).toBeGreaterThan(-1);
    expect(r.tables[ci].head).toBe('Answer|Female (1)|Male (2)|Not given (1)');
    expect(r.tables[ci].rows).toEqual(['Thursday|1 (100%)|1 (50%)|1 (100%)', 'Friday|0 (0%)|1 (50%)|0 (0%)', 'Right answer|1 (100%)|1 (50%)|1 (100%)']);
    await field(page, 'Split results by').selectOption({ label: '1. Which day suits you?' });
    r = await pdf(page);
    expect(r.h2).not.toContain('1. Which day suits you? · 1. Which day suits you?'); // a question is not split by itself
    const wi = r.h2.indexOf('3. Which wheel? · 1. Which day suits you?');
    expect(r.tables[wi].head).toBe('Answer|Thursday (1)|Friday (1)');
    // the report's line under its title names the round
    await tapReports(page);
    await dlg(page).locator('.rpt-acts .btn-primary').click();
    expect(await waitReport(page)).toContain('All rounds');
  });
});
