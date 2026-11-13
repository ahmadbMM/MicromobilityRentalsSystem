import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// The learn-to-ride ladder (new features build F21, 2026-11-13; migration 20261114012100, learn-ladder.js).
// Four levels (balance, pedal, steer and brake, ride the circuit), four skills in each, seeded in the ten languages.
// Staff: on a scheduled or done sign-up in People > Applications > Learn to ride, each learner has a Skills button;
// the instructor ticks what the learner can do and writes one line (staff_learn_progress_set). A skill not ticked
// reads "Practising"; nothing is marked failed.
// Rider: the account the sign-up landed on sees its own learners' ladder and the line under Account > Learn to ride
// (learn_ladder; no row without a lesson or on a database without the function). A complete level gives a
// certificate image drawn on the phone; the whole ladder also shows the way to a Saturday ride.

const LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
type Skill = { key: string; level: number; sort: number; name: Record<string, string>; active: boolean };
// The skills as the migration seeds them: the fixtures are the seed itself.
const SQL = readFileSync(resolve(__dirname, '../supabase/migrations/20261114012100_learn_ladder.sql'), 'utf8');
const SKILLS: Skill[] = [...SQL.matchAll(/\('([a-z_]+)', (\d), (\d+), '(\{[^']+\})'::jsonb\)/g)]
  .map((m) => ({ key: m[1]!, level: Number(m[2]), sort: Number(m[3]), name: JSON.parse(m[4]!) as Record<string, string>, active: true }));
const KEYS = SKILLS.map((s) => s.key);
const level = (n: number) => SKILLS.filter((s) => s.level === n).map((s) => s.key);
const ticked = (keys: string[], at = '2026-11-10T15:00:00Z') => Object.fromEntries(keys.map((k) => [k, at]));
// Arabic-Indic, Persian, Devanagari and Bengali digits: every language shows 0-9.
const nativeDigit = (s: string) => [...s].some((ch) => { const c = ch.codePointAt(0)!; return (c >= 0x660 && c <= 0x669) || (c >= 0x6f0 && c <= 0x6f9) || (c >= 0x966 && c <= 0x96f) || (c >= 0x9e6 && c <= 0x9ef); });

const rpcCalls = (page: Page, name: string) => {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new RegExp(`rpc/${name}$`).test(r.url().split('?')[0]!)) calls.push(JSON.parse(r.postData() || '{}') as Record<string, unknown>); });
  return calls;
};

test.describe('@build the learn-to-ride ladder: its skills', () => {
  test('the migration seeds four levels of four skills, each named in the ten languages with Latin digits', () => {
    expect(SKILLS).toHaveLength(16);
    expect(new Set(KEYS).size).toBe(16);
    for (const n of [1, 2, 3, 4]) expect(level(n)).toHaveLength(4);
    for (const s of SKILLS) {
      expect(Object.keys(s.name).sort(), s.key).toEqual([...LANGS].sort());
      for (const l of LANGS) {
        expect(String(s.name[l]).trim().length, `${s.key} ${l}`).toBeGreaterThan(3);
        expect(nativeDigit(s.name[l]!), `${s.key} ${l} digits`).toBe(false);
      }
    }
    // the tables are locked: staff read, nobody writes from a page, riders go through the function
    expect(SQL).toContain('alter table public.learn_skills enable row level security;');
    expect(SQL).toContain('alter table public.learn_progress enable row level security;');
    expect(SQL).toContain('where a.customer_id = p_id and a.status in (\'scheduled\', \'done\')');
    expect(SQL).toContain('not _cust_token_ok(p_id, p_token)');
    expect(SQL).toContain('_staff_mod(\'community\', true)');
    // a row of ticks is read only for the learner it was written for
    expect(SQL).toContain('and p.learner_who = n.who and (n.who = \'self\' or lower(p.learner_name) = lower(n.name))');
  });
});

// ── Staff ───────────────────────────────────────────────────────────────────────────────────────
const customers = [{ id: 'la01', name: 'Omar Farouk', email: 'omar.farouk@gmail.com', phone: '+966553330002', height: 180, created_at: '2026-01-05T10:00:00Z' }];
const base = {
  created_at: '2026-09-27T08:00:00Z', updated_at: '2026-09-27T08:00:00Z', submissions: 1, for_whom: 'self', learner_name: null,
  learner_gender: 'female', learner_height: 162, level: 'never', notes: '', lang: 'en',
  lesson_at: null as string | null, lesson_place: null as string | null, decided_at: null as string | null, decided_by: null as string | null,
  customer_id: null as string | null, existing_account: null as boolean | null, account_oauth: null as boolean | null,
};
const signups = [
  { ...base, id: 'l1', status: 'pending', name: 'Nadia Omar', email: 'nadia.omar@gmail.com', phone: '+966552220001', learner_age: 34 },
  { ...base, id: 'l3', status: 'scheduled', name: 'Omar Farouk', email: 'omar.farouk@gmail.com', phone: '+966553330002', learner_age: 41, learner_gender: 'male', learner_height: 180,
    lesson_at: '2026-10-04T15:00:00Z', lesson_place: 'JCC', decided_at: '2026-09-27T09:00:00Z', decided_by: 'Desk A', customer_id: 'la01', existing_account: false, account_oauth: false,
    learners: [{ who: 'self', name: null, age: 41, gender: 'male', height: 180, level: 'never' }, { who: 'child', name: 'Sara Farouk', age: 7, gender: 'female', height: 120, level: 'tried' }] },
];
const progress = [{ application_id: 'l3', learner_idx: 0, learner_who: 'self', learner_name: '', skills: ticked(['bal_walk']), feedback: 'Sits well on the saddle', updated_at: '2026-11-10T15:00:00Z', updated_by: 'Desk A' }];

async function learnTab(page: Page, extra: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: [], learn_applications: signups, learn_skills: SKILLS, learn_progress: progress, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');setCommTab('learning')`);
  await expect(page.locator('.la-row')).toHaveCount(1);
}
const row = (page: Page, id: string) => page.locator(`.la-row[data-learn-id="${id}"]`);

test.describe('@staff:community the learn-to-ride ladder', () => {
  test('the instructor ticks a learner\'s skills and writes one line, and both are stored', async ({ page }) => {
    await learnTab(page, { 'rpc:staff_learn_progress_set': { ok: true, skills: ticked(['bal_walk', 'bal_sit', 'bal_scoot']), feedback: 'Looks ahead well', updated_at: '2026-11-13T10:00:00Z' } });
    const sent = rpcCalls(page, 'staff_learn_progress_set');
    // a sign-up with no lesson yet has no ladder
    await expect(row(page, 'l1').locator('.la-skills')).toHaveCount(0);
    await page.locator('.filter-pill[data-la-filter="scheduled"]').click();
    // each learner of the lesson has their own button, with what is ticked so far
    await expect(row(page, 'l3').locator('.la-skills')).toHaveCount(2);
    await expect(row(page, 'l3').locator('.la-skills[data-ll-idx="0"]')).toHaveText('Skills 1/16');
    await expect(row(page, 'l3').locator('.la-skills[data-ll-idx="1"]')).toHaveText('Skills 0/16');
    await row(page, 'l3').locator('.la-skills[data-ll-idx="0"]').click();
    const dlg = page.locator('#confirm-modal .ws-dlg');
    await expect(dlg.locator('#ws-dlg-title')).toHaveText('Skills: Omar Farouk');
    // the four levels by name, four skills in each
    await expect(dlg.locator('.lls-lv legend')).toHaveText(['Balance', 'Pedal', 'Steer and brake', 'Ride the circuit']);
    await expect(dlg.locator('.lls-cb')).toHaveCount(16);
    await expect(dlg.locator('.lls-lv[data-ll-level="1"] .lls-sk-n').first()).toHaveText('Walk beside the bike and steer it by the handlebars');
    await expect(dlg.locator('.lls-cb:checked')).toHaveCount(1);
    await expect(dlg.locator('#lls-fb')).toHaveValue('Sits well on the saddle');
    // a skill not ticked reads Practising; nothing says failed
    await expect(dlg.locator('.lls-st:visible')).toHaveCount(15);
    await expect(dlg.locator('.lls-st:visible').first()).toHaveText('Practising');
    await expect(dlg).not.toContainText(/fail/i);
    await dlg.locator('.lls-cb[value="bal_sit"]').check();
    await dlg.locator('.lls-cb[value="bal_scoot"]').check();
    await expect(dlg.locator('.lls-st:visible')).toHaveCount(13);
    await dlg.locator('#lls-fb').fill('Looks ahead well');
    await dlg.locator('.lls-save').click();
    await expect(page.locator('#confirm-modal .ws-dlg')).toHaveCount(0);
    expect(sent).toEqual([{ p_app: 'l3', p_idx: 0, p_skills: ['bal_walk', 'bal_sit', 'bal_scoot'], p_feedback: 'Looks ahead well', p_by: 'Spec Staff' }]);
    // the card and the dialog show what was stored
    await expect(row(page, 'l3').locator('.la-skills[data-ll-idx="0"]')).toHaveText('Skills 3/16');
    await row(page, 'l3').locator('.la-skills[data-ll-idx="0"]').click();
    await expect(page.locator('#confirm-modal .lls-cb:checked')).toHaveCount(3);
    await expect(page.locator('#confirm-modal #lls-fb')).toHaveValue('Looks ahead well');
  });

  test('the second learner of a sign-up is stored under their own place, and a skill can be un-ticked', async ({ page }) => {
    await learnTab(page, {
      learn_progress: [...progress, { application_id: 'l3', learner_idx: 1, learner_who: 'child', learner_name: 'Sara Farouk', skills: ticked(['bal_walk', 'bal_sit']), feedback: '', updated_at: '2026-11-10T15:00:00Z', updated_by: 'Desk A' }],
      'rpc:staff_learn_progress_set': { ok: true, skills: ticked(['bal_walk']), feedback: '', updated_at: '2026-11-13T10:00:00Z' },
    });
    const sent = rpcCalls(page, 'staff_learn_progress_set');
    await page.locator('.filter-pill[data-la-filter="scheduled"]').click();
    await row(page, 'l3').locator('.la-skills[data-ll-idx="1"]').click();
    await expect(page.locator('#ws-dlg-title')).toHaveText('Skills: Sara Farouk');
    await page.locator('#confirm-modal .lls-cb[value="bal_sit"]').uncheck();
    await page.locator('#confirm-modal .lls-save').click();
    await expect(page.locator('#confirm-modal .ws-dlg')).toHaveCount(0);
    expect(sent).toEqual([{ p_app: 'l3', p_idx: 1, p_skills: ['bal_walk'], p_feedback: '', p_by: 'Spec Staff' }]);
    await expect(row(page, 'l3').locator('.la-skills[data-ll-idx="1"]')).toHaveText('Skills 1/16');
    await expect(row(page, 'l3').locator('.la-skills[data-ll-idx="0"]')).toHaveText('Skills 1/16');
  });

  test('ticks written for another learner at that place are not this learner\'s', async ({ page }) => {
    // the sign-up was sent again with another child second: the row left there is not read for her
    await learnTab(page, {
      learn_progress: [...progress, { application_id: 'l3', learner_idx: 1, learner_who: 'child', learner_name: 'Yousef Farouk', skills: ticked(level(1)), feedback: 'Glides well', updated_at: '2026-10-01T15:00:00Z', updated_by: 'Desk A' }],
      'rpc:staff_learn_progress_set': { ok: true, who: 'child', name: 'Sara Farouk', skills: ticked(['bal_walk']), feedback: '', updated_at: '2026-11-13T10:00:00Z' },
    });
    await page.locator('.filter-pill[data-la-filter="scheduled"]').click();
    await expect(row(page, 'l3').locator('.la-skills[data-ll-idx="0"]')).toHaveText('Skills 1/16');
    await expect(row(page, 'l3').locator('.la-skills[data-ll-idx="1"]')).toHaveText('Skills 0/16');
    await row(page, 'l3').locator('.la-skills[data-ll-idx="1"]').click();
    await expect(page.locator('#ws-dlg-title')).toHaveText('Skills: Sara Farouk');
    await expect(page.locator('#confirm-modal .lls-cb:checked')).toHaveCount(0);
    await expect(page.locator('#confirm-modal #lls-fb')).toHaveValue('');
    // saved, the row is hers
    await page.locator('#confirm-modal .lls-cb[value="bal_walk"]').check();
    await page.locator('#confirm-modal .lls-save').click();
    await expect(page.locator('#confirm-modal .ws-dlg')).toHaveCount(0);
    await expect(row(page, 'l3').locator('.la-skills[data-ll-idx="1"]')).toHaveText('Skills 1/16');
  });

  test('a refused save stays in the dialog with its words, and a view-only account gets no Save', async ({ page }) => {
    await learnTab(page, { 'rpc:staff_learn_progress_set': { __rpcError: { status: 403, code: '42501', message: 'not staff' } } });
    await page.locator('.filter-pill[data-la-filter="scheduled"]').click();
    await row(page, 'l3').locator('.la-skills[data-ll-idx="0"]').click();
    await page.locator('#confirm-modal .lls-cb[value="bal_sit"]').check();
    await page.locator('#confirm-modal .lls-save').click();
    await expect(page.locator('#ws-dlg-err')).not.toBeEmpty();
    await expect(page.locator('#confirm-modal .lls-cb[value="bal_sit"]')).toBeChecked();
    await page.evaluate(`closeConfirm()`);
    await expect(row(page, 'l3').locator('.la-skills[data-ll-idx="0"]')).toHaveText('Skills 1/16');
    // view only: the ticks and the line are read, nothing can be changed
    await page.evaluate(`S._myEdit=['queue'];_llsOpen('l3',0)`);
    await expect(page.locator('#confirm-modal .lls-cb')).toHaveCount(16);
    await expect(page.locator('#confirm-modal .lls-cb:disabled')).toHaveCount(16);
    await expect(page.locator('#confirm-modal #lls-fb')).toBeDisabled();
    await expect(page.locator('#confirm-modal .lls-save')).toHaveCount(0);
  });

  test('a database without the ladder shows the sign-ups as before, with no Skills button', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: [], learn_applications: signups });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
    await page.evaluate(`setStaffTab('community');setCommTab('learning')`);
    await page.locator('.filter-pill[data-la-filter="scheduled"]').click();
    await expect(row(page, 'l3').locator('.la-learner')).toHaveCount(2);
    await expect(page.locator('.la-skills')).toHaveCount(0);
    await expect(page.locator('.la-retry')).toHaveCount(0);
  });
});

// ── Rider ───────────────────────────────────────────────────────────────────────────────────────
type Learner = { who: string; name: string | null; lesson_at: string | null; ticked: Record<string, string>; feedback: string; updated_at: string | null };
const me = (keys: string[], feedback = '', at?: string): Learner => ({ who: 'self', name: null, lesson_at: '2026-10-04T15:00:00Z', ticked: ticked(keys, at), feedback, updated_at: '2026-11-10T15:00:00Z' });
const ladder = (learners: Learner[]) => ({ ok: true, skills: SKILLS.map(({ key, level: lv, name }) => ({ key, level: lv, name })), learners });

async function account(page: Page, fx: Fixtures = {}, cust: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [], customers: [], queue_entries: [], bikes: [], ...fx });
  await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'female', ...cust });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-r-personal')).toBeVisible();
}
async function openLadder(page: Page) {
  await expect(page.locator('#acc-r-learn')).toBeVisible();
  await page.locator('#acc-r-learn').click();
  await expect(page.locator('#ll-box')).toBeVisible();
}
const lv = (page: Page, n: number) => page.locator(`#ll-box .ll-lv[data-ll-level="${n}"]`);

test.describe('@customer:account the learn-to-ride ladder', () => {
  test('a learner sees their own ladder and the instructor\'s line; the file loads on the tap, in ten languages', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('learn-ladder.js')) asked.push(r.url()); });
    const reads = rpcCalls(page, 'learn_ladder');
    await account(page, { 'rpc:learn_ladder': ladder([me(['bal_walk', 'bal_sit', 'ped_start'], 'Great balance today')]) });
    await expect(page.locator('#acc-r-learn .acc-row-t')).toHaveText('Learn to ride');
    expect(asked).toEqual([]);
    expect(reads[0]).toEqual({ p_id: 'c1', p_token: 'tok-spec' });
    await openLadder(page);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\/learn-ladder\.js\?v=[0-9a-f]{10}$/);
    await expect(page.locator('#ll-box')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#ll-title')).toHaveText('Learn to ride');
    // four named levels, the skills in each, what is ticked and what is still being practised
    await expect(page.locator('#ll-box .ll-lv-t')).toHaveText(['Balance', 'Pedal', 'Steer and brake', 'Ride the circuit']);
    await expect(page.locator('#ll-box .ll-sk')).toHaveCount(16);
    await expect(lv(page, 1).locator('.ll-lv-c')).toHaveText('2/4');
    await expect(lv(page, 2).locator('.ll-lv-c')).toHaveText('1/4');
    await expect(lv(page, 4).locator('.ll-lv-c')).toHaveText('0/4');
    await expect(page.locator('#ll-box .ll-sk.on')).toHaveCount(3);
    await expect(page.locator('#ll-box .ll-sk[data-ll-skill="bal_walk"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('#ll-box .ll-sk[data-ll-skill="bal_walk"] .ll-prac')).toHaveCount(0);
    await expect(page.locator('#ll-box .ll-sk[data-ll-skill="bal_glide"] .ll-prac')).toHaveText('Practising');
    await expect(page.locator('#ll-box .ll-prac')).toHaveCount(13);
    await expect(page.locator('#ll-box')).not.toContainText(/fail/i);
    await expect(page.locator('#ll-box .ll-fb')).toContainText('Great balance today');
    // one learner: no switch; no level complete: no certificate, no invitation
    await expect(page.locator('#ll-box .ll-who')).toHaveCount(0);
    await expect(page.locator('#ll-box .ll-cert-b')).toHaveCount(0);
    await expect(page.locator('#ll-box .ll-inv')).toHaveCount(0);
    // every word of the file in all ten languages
    const bad = await page.evaluate(`Object.entries(LL_T).filter(([k,v])=>v.length!==10||v.some(x=>!String(x).trim())).map(([k])=>k)`);
    expect(bad).toEqual([]);
    expect(await page.evaluate(`LL_LANGS.join()`)).toBe(LANGS.join());
    await page.locator('#ll-box .ll-x').click();
    await expect(page.locator('#ll-box')).toHaveCount(0);
    // in Arabic: the levels and the seeded skill names in Arabic
    await page.evaluate(`S.lang='ar';_llOpen()`);
    await expect(page.locator('#ll-title')).toHaveText('تعلّم ركوب الدراجة');
    await expect(page.locator('#ll-box .ll-sk[data-ll-skill="bal_walk"] .ll-sk-n')).toHaveText(SKILLS[0]!.name.ar!);
    expect(asked).toHaveLength(1);
  });

  test('no Learn to ride row for an account with no lesson, nor on a database without the ladder', async ({ page }) => {
    const reads = rpcCalls(page, 'learn_ladder');
    await account(page, { 'rpc:learn_ladder': ladder([]) });
    await expect.poll(() => reads.length).toBe(1);
    await page.waitForTimeout(200);
    await expect(page.locator('#acc-r-learn')).toBeHidden();
  });
  test('a database without learn_ladder: no row, no error, and it is not asked again', async ({ page }) => {
    const reads = rpcCalls(page, 'learn_ladder');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await account(page);
    await expect.poll(() => reads.length).toBe(1);
    await page.evaluate(`renderAccount()`);
    await page.waitForTimeout(300);
    await expect(page.locator('#acc-r-learn')).toBeHidden();
    await expect(page.locator('.toast.error')).toHaveCount(0);
    expect(reads).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('a complete level gives a certificate image to save or share', async ({ page }) => {
    await page.addInitScript(() => {
      const n = navigator as unknown as { share: (d: { files?: File[] }) => Promise<void>; canShare: (d: unknown) => boolean };
      n.canShare = () => true;
      n.share = (d) => { (window as unknown as { __shared: unknown }).__shared = (d.files || []).map((f) => [f.name, f.type, f.size > 1000]); return Promise.resolve(); };
    });
    await account(page, { 'rpc:learn_ladder': ladder([me([...level(1), 'ped_start'], '', '2026-11-10T15:00:00Z')]) });
    await openLadder(page);
    // level 1 is complete, level 2 is not
    await expect(lv(page, 1)).toHaveClass(/\bdone\b/);
    await expect(lv(page, 1).locator('.ll-cert-b')).toHaveText('Certificate');
    await expect(lv(page, 2).locator('.ll-cert-b')).toHaveCount(0);
    await expect(page.locator('#ll-box .ll-cert-b')).toHaveCount(1);
    await lv(page, 1).locator('.ll-cert-b').click();
    // drawn on the phone: a 1080 x 1350 PNG behind a blob address
    const img = page.locator('#ll-box img.ll-cert-img');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect(img).toHaveAttribute('alt', 'Certificate: Balance');
    await expect.poll(() => img.evaluate((el) => [(el as HTMLImageElement).naturalWidth, (el as HTMLImageElement).naturalHeight])).toEqual([1080, 1350]);
    const png = await page.evaluate(`fetch(document.querySelector('.ll-cert-img').src).then(r=>r.blob()).then(b=>[b.type,b.size>5000])`);
    expect(png).toEqual(['image/png', true]);
    await expect(page.locator('#ll-box a.ll-save')).toHaveAttribute('download', 'micromobility-learn-to-ride-level-1.png');
    await expect(page.locator('#ll-box a.ll-save')).toHaveAttribute('href', /^blob:/);
    await expect(page.locator('#ll-box a.ll-save')).toHaveText('Save image');
    await page.locator('#ll-box .ll-share').click();
    await expect.poll(() => page.evaluate('window.__shared')).toEqual([['micromobility-learn-to-ride-level-1.png', 'image/png', true]]);
    // Back: the ladder again
    await page.locator('#ll-box .ll-back').click();
    await expect(page.locator('#ll-box .ll-lv')).toHaveCount(4);
    await expect(page.locator('#ll-box .ll-cert-img')).toHaveCount(0);
  });

  test('the Saturday invitation shows only when the last level is complete, and leads a member to the rides', async ({ page }) => {
    await account(page, { 'rpc:learn_ladder': ladder([me(KEYS.filter((k) => k !== 'cir_signal'))]), 'rpc:community_member': true });
    await openLadder(page);
    // three levels complete, the last one a skill short: three certificates, no invitation
    await expect(page.locator('#ll-box .ll-cert-b')).toHaveCount(3);
    await expect(page.locator('#ll-box .ll-inv')).toHaveCount(0);
    // the instructor ticks the last skill: a fresh read shows it
    await page.evaluate(`(async()=>{S._llMine.d.learners[0].ticked.cir_signal='2026-11-12T16:00:00Z';window._llRender(true);})()`);
    await expect(page.locator('#ll-box .ll-cert-b')).toHaveCount(4);
    await expect(page.locator('#ll-box .ll-inv-t')).toHaveText('You are ready for an easy group on a Saturday ride');
    await page.locator('#ll-box .ll-inv-b').click();
    await expect(page.locator('#ll-box')).toHaveCount(0);
    await expect.poll(() => page.evaluate('[S.custTab,S.selEvent]')).toEqual(['register', 'community']);
  });

  test('the invitation shows someone who is not a member how to apply', async ({ page }) => {
    await account(page, { 'rpc:learn_ladder': ladder([me(KEYS)]), 'rpc:community_member': false });
    await openLadder(page);
    await expect(page.locator('#ll-box .ll-inv-b')).toHaveText('Join a Saturday ride');
    await page.locator('#ll-box .ll-inv-b').click();
    await expect(page.locator('#ll-box')).toHaveCount(0);
    await expect(page.locator('#confirm-modal #cm-title')).toBeVisible();
    await expect(page.locator('#confirm-modal .cm-apply')).toBeVisible();
  });

  test('two learners on one account: each has their own ladder, line and certificates', async ({ page }) => {
    const child: Learner = { who: 'child', name: 'Sara Haddad', lesson_at: '2026-10-04T15:00:00Z', ticked: ticked(level(1)), feedback: 'Sara glides on her own', updated_at: '2026-11-10T15:00:00Z' };
    await account(page, { 'rpc:learn_ladder': ladder([me(['bal_walk'], 'Keep your eyes up'), child]) });
    await openLadder(page);
    await expect(page.locator('#ll-box .ll-who-b')).toHaveText(['Lina Haddad', 'Sara Haddad']);
    await expect(page.locator('#ll-box .ll-who-b').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#ll-box .ll-fb')).toContainText('Keep your eyes up');
    await expect(page.locator('#ll-box .ll-cert-b')).toHaveCount(0);
    await page.evaluate(`window.__llBox=document.getElementById('ll-box')`);
    await page.locator('#ll-box .ll-who-b').nth(1).click();
    await expect(page.locator('#ll-box .ll-who-b').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#ll-box .ll-fb')).toContainText('Sara glides on her own');
    await expect(lv(page, 1).locator('.ll-lv-c')).toHaveText('4/4');
    await expect(page.locator('#ll-box .ll-cert-b')).toHaveCount(1);
    await expect(page.locator('#ll-box .ll-inv')).toHaveCount(0);
    // a repaint changes what is inside the pop-up, never the pop-up: the box is the element it was, so it does not
    // settle in a second time
    expect(await page.evaluate(`window.__llBox===document.getElementById('ll-box')`)).toBe(true);
    // and a rider reading the lower levels keeps their place when a fresh read lands by itself
    await page.setViewportSize({ width: 390, height: 600 });
    expect(await page.evaluate(`(()=>{const b=document.getElementById('ll-box');b.scrollTop=120;return b.scrollTop;})()`)).toBe(120);
    const reads = rpcCalls(page, 'learn_ladder');
    await page.evaluate(`_llMineLoad(S.loggedIn||getSession(),true)`);
    expect(reads).toHaveLength(1);
    expect(await page.evaluate(`[window.__llBox===document.getElementById('ll-box'),window.__llBox.scrollTop]`)).toEqual([true, 120]);
    await expect(page.locator('#ll-box .ll-who-b').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#ll-box .ll-fb')).toContainText('Sara glides on her own');
    // a view the rider asks for (her certificate) opens in the same box, from its top
    await lv(page, 1).locator('.ll-cert-b').click();
    await expect(page.locator('#ll-box img.ll-cert-img')).toBeVisible();
    expect(await page.evaluate(`[window.__llBox===document.getElementById('ll-box'),window.__llBox.scrollTop]`)).toEqual([true, 0]);
  });
});
