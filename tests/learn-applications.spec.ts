import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Community > Applications > Learn to ride: the sign-ups from micromobility.sa/experiences/learn.
// Setting the lesson's day and time runs staff_learn_schedule, which (the first time) makes the
// account or finds the one the person has, and the message then carries the lesson's day, time
// and place: with the temporary password for a new account, the sign-in line for an existing one,
// and only the new time when a lesson moves. Done and Cancel can be undone from the topbar.
// A sign-up carries one or more learners (the applicant, their children, other adults); rows from
// before the learners column read as their one learner.

const customers = [
  { id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', height: 165, created_at: '2026-01-05T10:00:00Z' },
];
const base = {
  created_at: '2026-09-27T08:00:00Z', updated_at: '2026-09-27T08:00:00Z', submissions: 1, for_whom: 'self', learner_name: null,
  learner_gender: 'female', learner_height: 162, level: 'never', notes: '', lang: 'en',
  lesson_at: null as string | null, lesson_place: null as string | null, decided_at: null as string | null, decided_by: null as string | null,
  customer_id: null as string | null, existing_account: null as boolean | null, account_oauth: null as boolean | null,
};
const learners = [
  { ...base, id: 'l1', status: 'pending', name: 'Nadia Omar', email: 'nadia.omar@gmail.com', phone: '+966552220001', learner_age: 34, notes: 'A bit nervous around traffic' },
  { ...base, id: 'l2', status: 'pending', for_whom: 'child', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', learner_name: 'Sara', learner_age: 7, learner_height: 120, level: 'tried', lang: 'ar', created_at: '2026-09-26T08:00:00Z' },
  { ...base, id: 'l3', status: 'scheduled', name: 'Omar Farouk', email: 'omar.farouk@gmail.com', phone: '+966553330002', learner_age: 41, learner_gender: 'male', learner_height: 180, level: 'refresh',
    lesson_at: '2026-10-04T15:00:00Z', lesson_place: 'JCC', decided_at: '2026-09-27T09:00:00Z', decided_by: 'Desk A', customer_id: 'la01', existing_account: false, account_oauth: false },
  { ...base, id: 'l4', status: 'cancelled', name: 'Old Learner', email: 'old.learner@gmail.com', phone: '+966554440003', learner_age: 29, decided_at: '2026-09-25T09:00:00Z', decided_by: 'Desk B' },
];

// A day two days from now, in Riyadh, as the date input gives it.
const soon = () => new Date(Date.now() + 2 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });

async function learnTab(page: Page, extra: Record<string, unknown> = {}, routes?: () => Promise<unknown>) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: [], learn_applications: learners, ...extra });
  if (routes) await routes(); // after the stub, so they are asked first
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');setCommTab('learning')`);
  await expect(page.locator('.la-row')).toHaveCount(2);
}
const row = (page: Page, id: string) => page.locator(`.la-row[data-learn-id="${id}"]`);
const rpcCalls = (page: Page, name: string) => {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new RegExp(`rpc/${name}$`).test(r.url().split('?')[0])) calls.push(JSON.parse(r.postData() || '{}')); });
  return calls;
};

test.describe('@staff:community learn to ride', () => {
  test('Applications holds two lists; the learn-to-ride one shows who is learning and what they asked for', async ({ page }) => {
    await learnTab(page);
    // one pill for both lists, the pending ones of both counted; its own address
    await expect(page.locator('.filter-pill', { hasText: /^Applications \(2\)$/ })).toHaveClass(/active/);
    await expect(page.locator('.apps-kind[data-apps-kind="learning"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.apps-kind[data-apps-kind="learning"] .apps-kind-n')).toHaveText('2');
    expect(new URL(page.url()).pathname).toBe('/community/applications/learning');
    await expect(page.locator('.filter-pill[data-la-filter="pending"]')).toHaveText('New (2)');
    await expect(page.locator('.filter-pill[data-la-filter="scheduled"]')).toHaveText('Scheduled (1)');
    await expect(page.locator('.filter-pill[data-la-filter="cancelled"]')).toHaveText('Cancelled (1)');

    const n = row(page, 'l1');
    await expect(n.locator('.ca-name')).toHaveText('Nadia Omar');
    for (const txt of ['+966552220001', 'nadia.omar@gmail.com', '34 years', 'Female', '162 cm', 'Never ridden', 'English']) await expect(n).toContainText(txt);
    await expect(n.locator('.la-learners-h')).toHaveText('Learners (1)');
    await expect(n.locator('.la-learner')).toHaveText(/Nadia Omar\s+Applicant/);
    // the form does not ask when suits them: staff pick the time
    await expect(n.locator('.ca-kv span', { hasText: /best/i })).toHaveCount(0);
    await expect(n.locator('.la-notes')).toContainText('A bit nervous around traffic');

    // a child: the parent is the sign-up, the child its learner, and the parent's account on file
    const s = row(page, 'l2');
    await expect(s.locator('.ca-name')).toHaveText('Huda Al Saleh');
    await expect(s.locator('.la-learner[data-who="child"]')).toContainText('Sara');
    await expect(s.locator('.la-kid')).toHaveText('Child');
    await expect(s.locator('.la-learners')).toContainText('7 years · Female · 120 cm · Tried, can’t ride yet');
    await expect(s.locator('.ca-acct')).toContainText('Already has an account: Huda Al Saleh');

    // the scheduled list shows the lesson; the community list is one tap away and back
    await page.locator('.filter-pill[data-la-filter="scheduled"]').click();
    await expect(row(page, 'l3').locator('.la-lesson')).toContainText('JCC');
    await expect(row(page, 'l3')).toContainText('by Desk A');
    await page.locator('.apps-kind[data-apps-kind="applications"]').click();
    expect(new URL(page.url()).pathname).toBe('/community/applications');
    await expect(page.locator('.la-row')).toHaveCount(0);
    await page.locator('.apps-kind[data-apps-kind="learning"]').click();
    await expect(page.locator('.la-row')).toHaveCount(1);
    // and the address opens the list
    expect(await page.evaluate(`JSON.stringify(_parsePath('/community/applications/learning'))`)).toBe(JSON.stringify({ view: 'staff', stab: 'community', sub: 'applications/learning' }));
    expect(await page.evaluate(`_setSub('community','applications/learning'),S.communityTab`)).toBe('learning');
    // the bell counts them
    expect(await page.evaluate(`(_ntKinds().find(k=>k.k==='learn')||{ids:[]}).ids.length`)).toBe(2);
  });

  test('Setting the lesson for someone new makes the account and writes the message with the time, the place and the password', async ({ page }) => {
    await learnTab(page, {
      'rpc:staff_learn_schedule': { ok: true, existing: false, first: true, customer_id: 'la02', name: 'Nadia Omar', email: 'nadia.omar@gmail.com', phone: '+966552220001', password: 'Tq8mZr3Kpw', lang: 'en', oauth: false, lesson_at: null, lesson_place: 'JCC Gate 3', must_change: true },
    });
    const calls = rpcCalls(page, 'staff_learn_schedule');
    await row(page, 'l1').locator('.la-schedule').click();
    const dlg = page.locator('#confirm-modal .ws-dlg');
    await expect(dlg).toContainText('Lesson for Nadia Omar');
    await expect(dlg).toContainText('Nadia Omar (Applicant) · 34 years · Never ridden');
    // nothing picked yet: it asks
    await dlg.locator('.la-sched-save').click();
    await expect(dlg.locator('#ws-dlg-err')).toHaveText('Pick both the day and the time.');
    const d = soon();
    await dlg.locator('#ws-d').fill(d);
    await dlg.locator('#ws-t').fill('18:30');
    await dlg.locator('#la-place').fill('JCC Gate 3');
    await dlg.locator('.la-sched-save').click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_id: 'l1', p_at: `${d}T18:30:00+03:00`, p_place: 'JCC Gate 3', p_by: 'Spec Staff' });

    const box = page.locator('#confirm-modal .ca-msg-box');
    await expect(box).toBeVisible();
    await expect(box.locator('.ca-pwd')).toHaveText('Tq8mZr3Kpw');
    const msg = await box.locator('#la-msg-text').inputValue();
    const day = new Intl.DateTimeFormat('en-GB-u-ca-gregory', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Riyadh' }).format(new Date(`${d}T18:30:00+03:00`));
    for (const txt of ['Hi Nadia,', 'learn-to-ride lesson', 'Your lesson is booked:', `📅 ${day}`, '🕕 6:30 pm', '📍 JCC Gate 3', 'https://micromobilityrentals.pages.dev',
      'Email: nadia.omar@gmail.com', 'Mobile: 0552220001', 'Temporary password: Tq8mZr3Kpw', 'choose your own password', 'reply to this message']) expect(msg).toContain(txt);
    const wa = await box.locator('a.la-wa').getAttribute('href');
    expect(wa).toMatch(/^https:\/\/wa\.me\/966552220001\?text=/);
    expect(decodeURIComponent(wa!.split('text=')[1])).toBe(msg);
    await box.locator('#la-msg-lang').selectOption('ar');
    await expect(box.locator('#la-msg-text')).toHaveAttribute('dir', 'rtl');
    expect(await box.locator('#la-msg-text').inputValue()).toContain('تم حجز درسك');
    await box.locator('.ca-x').click();

    // the row moved to Scheduled, with its account; the place is remembered for the next lesson
    await expect(page.locator('.filter-pill[data-la-filter="scheduled"]')).toHaveText('Scheduled (2)');
    await row(page, 'l2').locator('.la-schedule').click();
    await expect(page.locator('#la-place')).toHaveValue('JCC Gate 3');
  });

  test('A child whose parent already has an account: the child is named, the parent signs in with their own', async ({ page }) => {
    await learnTab(page, {
      'rpc:staff_learn_schedule': { ok: true, existing: true, first: true, customer_id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', password: null, lang: 'ar', oauth: false, lesson_at: null, lesson_place: null, must_change: false },
    });
    await row(page, 'l2').locator('.la-schedule').click();
    await page.locator('#ws-d').fill(soon());
    await page.locator('#ws-t').fill('09:00');
    await page.locator('#la-place').fill('');
    await page.locator('.la-sched-save').click();
    const box = page.locator('#confirm-modal .ca-msg-box');
    await expect(box).toBeVisible();
    await expect(box.locator('.ca-pwd')).toHaveCount(0);
    await expect(box.locator('#la-msg-lang')).toHaveValue('ar'); // the language of the sign-up
    await box.locator('#la-msg-lang').selectOption('en');
    const msg = await box.locator('#la-msg-text').inputValue();
    for (const txt of ['Hi Huda,', 'Sara’s lesson is booked:', '🕕 9:00 am', 'You already have a Micromobility account', 'Email: huda.saleh@gmail.com', 'Forgot password?']) expect(msg).toContain(txt);
    expect(msg).not.toContain('📍');
    expect(msg).not.toContain('Temporary password');
  });

  test('A lesson moved to another time sends only the new time; the message again carries the sign-in lines', async ({ page }) => {
    await learnTab(page, {
      'rpc:staff_learn_schedule': { ok: true, existing: false, first: false, customer_id: 'la01', name: 'Omar Farouk', email: 'omar.farouk@gmail.com', phone: '+966553330002', password: null, lang: 'en', oauth: false, lesson_at: null, lesson_place: 'JCC', must_change: true },
    });
    await page.locator('.filter-pill[data-la-filter="scheduled"]').click();
    await row(page, 'l3').locator('.la-reschedule').click();
    // the current lesson, in Riyadh time
    await expect(page.locator('#ws-d')).toHaveValue('2026-10-04');
    await expect(page.locator('#ws-t')).toHaveValue('18:00');
    await expect(page.locator('#la-place')).toHaveValue('JCC');
    await page.locator('#ws-d').fill(soon());
    await page.locator('.la-sched-save').click();
    const box = page.locator('#confirm-modal .ca-msg-box');
    await expect(box).toBeVisible();
    let msg = await box.locator('#la-msg-text').inputValue();
    expect(msg).toContain('Your lesson has a new time:');
    expect(msg).toContain('🕕 6:00 pm');
    expect(msg).not.toContain('Sign in here');
    await box.locator('.ca-x').click();

    await row(page, 'l3').locator('.la-msg').click();
    msg = await page.locator('#la-msg-text').inputValue();
    for (const txt of ['Your lesson is booked:', 'Your account is ready', 'Email: omar.farouk@gmail.com', 'Forgot password?']) expect(msg).toContain(txt);
    expect(msg).not.toContain('Temporary password');
    await expect(row(page, 'l3').locator('.la-newpwd')).toBeVisible(); // the account this sign-up made
  });

  // Several learners on one sign-up (the owner, 2026-09-28): the card lists each, the lesson window
  // names each, and the message books the lesson for all of them by name.
  test('a sign-up with several learners lists them, and the message books the lesson for all of them', async ({ page }) => {
    const family = { ...learners[0], name: 'Rania Haddad', email: 'rania.haddad@gmail.com', phone: '+966556660004', notes: '',
      learners: [
        { who: 'self', name: null, age: 36, gender: 'female', height: 160, level: 'never' },
        { who: 'child', name: 'Yousef', age: 8, gender: 'male', height: 128, level: 'tried' },
        { who: 'other', name: 'Karim Haddad', age: 40, gender: 'male', height: 182, level: 'refresh' },
      ] };
    await learnTab(page, {
      learn_applications: learners.map((l) => (l.id === 'l1' ? family : l)),
      'rpc:staff_learn_schedule': { ok: true, existing: false, first: true, customer_id: 'la05', name: 'Rania Haddad', email: 'rania.haddad@gmail.com', phone: '+966556660004', password: 'Hm4pWq7Rtz', lang: 'en', oauth: false, lesson_at: null, lesson_place: 'JCC', must_change: true },
    });
    const r = row(page, 'l1');
    await expect(r.locator('.ca-name')).toHaveText('Rania Haddad');
    await expect(r.locator('.la-learners-h')).toHaveText('Learners (3)');
    await expect(r.locator('.la-learner')).toHaveCount(3);
    await expect(r.locator('.la-learner[data-who="self"]')).toContainText('Rania Haddad');
    await expect(r.locator('.la-learner[data-who="self"] .la-kid')).toHaveText('Applicant');
    await expect(r.locator('.la-learner[data-who="child"]')).toContainText('Yousef');
    await expect(r.locator('.la-learner[data-who="child"]')).toContainText('8 years · Male · 128 cm · Tried, can’t ride yet');
    await expect(r.locator('.la-learner[data-who="other"] .la-kid')).toHaveText('Adult');

    await r.locator('.la-schedule').click();
    const dlg = page.locator('#confirm-modal .ws-dlg');
    await expect(dlg).toContainText('Lesson for Rania Haddad');
    for (const line of ['Rania Haddad (Applicant) · 36 years · Never ridden', 'Yousef (Child) · 8 years · Tried, can’t ride yet', 'Karim Haddad (Adult) · 40 years · Needs a refresher']) await expect(dlg).toContainText(line);
    await dlg.locator('#ws-d').fill(soon());
    await dlg.locator('#ws-t').fill('17:00');
    await dlg.locator('.la-sched-save').click();
    const box = page.locator('#confirm-modal .ca-msg-box');
    await expect(box).toBeVisible();
    const msg = await box.locator('#la-msg-text').inputValue();
    for (const txt of ['Hi Rania,', 'The lesson for Rania, Yousef and Karim Haddad is booked:', '🕕 5:00 pm', 'Temporary password: Hm4pWq7Rtz']) expect(msg).toContain(txt);
    await box.locator('#la-msg-lang').selectOption('ar');
    expect(await box.locator('#la-msg-text').inputValue()).toContain('تم حجز الدرس لكلٍّ من Rania');
  });

  // How they heard of us (the owner, 2026-09-28: asked by this form and the community one, no longer
  // by the booking app's sign-up), in the staff member's language; nothing when there is no answer.
  test('the card shows how the applicant heard of us', async ({ page }) => {
    await learnTab(page, { learn_applications: learners.map((l) => (l.id === 'l1' ? { ...l, heard_from: 'friend' } : l)) });
    await expect(row(page, 'l1')).toContainText('How did you hear about us?');
    await expect(row(page, 'l1')).toContainText('A friend or family');
    // not answered: the line stays, and says so (the owner, 2026-09-29)
    await expect(row(page, 'l2').locator('.ca-kv', { hasText: 'How did you hear about us?' })).toContainText('Not answered');
  });

  // The person signing up gives what the community form asks (owner, 2026-09-28): the card shows it.
  test('the card shows the person\'s own details, as a community application does', async ({ page }) => {
    const person = { birth_date: '1992-03-04', gender: 'female', nationality: 'Egypt', height: 162, profession: 'Architect', instagram: 'nadia.o', linkedin: 'nadia-omar', ride_news: true };
    await learnTab(page, { learn_applications: learners.map((l) => (l.id === 'l1' ? { ...l, ...person } : l)) });
    const r = row(page, 'l1');
    await expect(r).toContainText('Born');
    await expect(r).toContainText(/\b3[0-9] years\b/);
    await expect(r).toContainText('Nationality');
    await expect(r).toContainText('Egypt');
    await expect(r).toContainText('Architect');
    await expect(r.locator('.ca-kv', { hasText: 'Ride news' })).toContainText('Yes');
    await expect(r.locator('.ca-kv', { hasText: 'Instagram' }).locator('a.soc-link[href*="instagram.com/nadia.o"]')).toHaveCount(1);
    await expect(r.locator('.ca-kv', { hasText: 'LinkedIn' }).locator('a.soc-link[href*="nadia-omar"]')).toHaveCount(1);
    await expect(r.locator('.ca-kv-none')).toHaveCount(2); // Company and How did you hear about us?
    // A sign-up without those details keeps every line, each saying Not answered (the owner,
    // 2026-09-29: "show the unanswered/filled fields, don't hide them").
    const l2 = row(page, 'l2');
    for (const k of ['Born', 'Gender', 'Nationality', 'Height', 'Profession', 'Company', 'How did you hear about us?', 'Instagram', 'LinkedIn', 'Ride news']) {
      await expect(l2.locator('.ca-kv', { hasText: k })).toHaveClass(/ca-kv-none/);
      await expect(l2.locator('.ca-kv', { hasText: k }).locator('b')).toHaveText('Not answered');
    }
    await expect(l2.locator('.soc-link')).toHaveCount(0);
    await expect(l2.locator('.la-notes')).toHaveClass(/la-notes-none/);
    await expect(l2.locator('.la-notes')).toContainText('Not answered');
    await expect(r.locator('.la-notes')).not.toHaveClass(/la-notes-none/);
  });

  test('before the database has the person\'s details, the list loads without them', async ({ page }) => {
    const asked: string[] = [];
    await learnTab(page, {}, () => page.route(/\/rest\/v1\/learn_applications\?/, async (r) => {
      const sel = new URL(r.request().url()).searchParams.get('select') || '';
      asked.push(sel);
      if (sel.includes('birth_date')) return r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42703', message: 'column learn_applications.birth_date does not exist' }) });
      return r.fallback();
    }));
    await expect(row(page, 'l1')).toContainText('Nadia Omar');
    expect(asked.some((x) => x.includes('birth_date'))).toBe(true);
    expect(asked.some((x) => x.includes('learners') && !x.includes('birth_date'))).toBe(true);
  });

  test('before the database has heard_from, the list loads without it', async ({ page }) => {
    const asked: string[] = [];
    await learnTab(page, {}, () => page.route(/\/rest\/v1\/learn_applications\?/, async (r) => {
      const sel = new URL(r.request().url()).searchParams.get('select') || '';
      asked.push(sel);
      if (sel.includes('heard_from')) return r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42703', message: 'column learn_applications.heard_from does not exist' }) });
      return r.fallback();
    }));
    await expect(row(page, 'l1')).toContainText('Nadia Omar');
    expect(asked.some((x) => x.includes('heard_from'))).toBe(true);
    expect(asked.some((x) => !x.includes('heard_from'))).toBe(true);
  });

  test('before the database has the learners column, a sign-up reads as its one learner', async ({ page }) => {
    const asked: string[] = [];
    await learnTab(page, {}, () => page.route(/\/rest\/v1\/learn_applications\?/, async (r) => {
      const sel = new URL(r.request().url()).searchParams.get('select') || '';
      asked.push(sel);
      if (sel.includes('learners')) return r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42703', message: 'column learn_applications.learners does not exist' }) });
      return r.fallback();
    }));
    await expect(row(page, 'l2').locator('.la-learner[data-who="child"]')).toContainText('Sara');
    expect(asked.some((x) => x.includes('learners'))).toBe(true);
    expect(asked.some((x) => x.includes('heard_from') && !x.includes('learners'))).toBe(true);
  });

  test('Done and Cancel can be undone from the topbar; a cancelled sign-up goes back to New', async ({ page }) => {
    await learnTab(page, { 'rpc:staff_learn_decide': { ok: true } });
    const calls = rpcCalls(page, 'staff_learn_decide');
    await page.locator('.filter-pill[data-la-filter="scheduled"]').click();
    await row(page, 'l3').locator('.la-done').click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_id: 'l3', p_status: 'done', p_by: 'Spec Staff' });
    await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', /Omar Farouk: lesson done/);
    await expect(page.locator('.filter-pill[data-la-filter="done"]')).toHaveText('Done (1)');
    await page.locator('#topbar-right .undo-btn').click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toEqual({ p_id: 'l3', p_status: 'scheduled', p_by: 'Spec Staff' });
    await expect(page.locator('.filter-pill[data-la-filter="scheduled"]')).toHaveText('Scheduled (1)');

    await page.locator('.filter-pill[data-la-filter="pending"]').click();
    await row(page, 'l1').locator('.la-cancel').click();
    await expect(page.locator('#confirm-modal')).toContainText('Cancel Nadia Omar’s sign-up?');
    await page.locator('#confirm-modal button', { hasText: 'Cancel sign-up' }).last().click();
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2]).toEqual({ p_id: 'l1', p_status: 'cancelled', p_by: 'Spec Staff' });
    await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', /Nadia Omar’s sign-up cancelled/);
    await expect(page.locator('.filter-pill[data-la-filter="cancelled"]')).toHaveText('Cancelled (2)');

    await page.locator('.filter-pill[data-la-filter="cancelled"]').click();
    await row(page, 'l4').locator('.la-reopen').click();
    await expect.poll(() => calls.length).toBe(4);
    expect(calls[3]).toEqual({ p_id: 'l4', p_status: 'pending', p_by: 'Spec Staff' });
    await expect(page.locator('.filter-pill[data-la-filter="pending"]')).toHaveText('New (2)');
  });
});

// The search (the owner, 2026-09-30: "add a search button for the applications sections") also
// finds a sign-up by one of its learners.
test.describe('@staff:community learn to ride search', () => {
  test('the search finds a sign-up by a learner\'s name or a phone, and the pills count the matches', async ({ page }) => {
    await learnTab(page);
    const q = page.locator('#la-q');
    const fold = page.locator('[data-srch="laq"] .srch-btn');
    if (await fold.isVisible()) await fold.click(); // a phone folds the search into a button
    await q.fill('sara'); // Huda's child
    await expect(page.locator('.la-row')).toHaveCount(1);
    await expect(page.locator('.la-row[data-learn-id="l2"]')).toBeVisible();
    await expect(page.locator('.filter-pill[data-la-filter="pending"]')).toHaveText('New (1)');
    await expect(q).toBeFocused();
    // Omar's +966553330002 the Saudi way: his lesson is scheduled
    await q.fill('055 333 0002');
    await expect(page.locator('#la-list')).toContainText('Nothing found.');
    await expect(page.locator('.filter-pill[data-la-filter="scheduled"]')).toHaveText('Scheduled (1)');
    await expect(page.locator('.filter-pill[data-la-filter="cancelled"]')).toHaveText('Cancelled (0)');
    await page.locator('.filter-pill[data-la-filter="scheduled"]').click();
    await expect(page.locator('.la-row')).toHaveCount(1);
    await expect(page.locator('.la-row[data-learn-id="l3"]')).toBeVisible();
    await page.locator('[data-srch="laq"] .search-clear').click();
    await expect(page.locator('#la-q')).toHaveValue('');
    await expect(page.locator('.filter-pill[data-la-filter="pending"]')).toHaveText('New (2)');
  });
});
