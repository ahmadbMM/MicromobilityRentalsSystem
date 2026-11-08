import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Badge requests (the owner, 2026-11-08: "add a button on badges for customers to request a badge and adding a proof
// either a pdf or an image as optional and a comment too optional"; migration 20261108210000). A rider asks for one of
// the badges staff give, from the Badges section or a badge's popup, with an optional comment and an optional picture
// or PDF; staff give or decline it in People > Badges. All Supabase traffic is stubbed. The stub answers the new table and
// functions as an empty database that has them (the rest of the suite sees nothing: no catalogue, no rows); the specs
// below about a database without them answer 404 themselves.

const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
// Three days back, but never the Defe ride's day (a done ride on 2026-10-24 earns Rode with Defe and pops up first).
const P1 = day(-3) === '2026-10-24' ? day(-4) : day(-3);
const slots = JSON.stringify({ _time: '21:00 - 23:00', _total: 40 });
const sessions = [{ id: P1, day: 'Friday', session_date: P1, capacity: 40, status: 'closed', created_at: 0, bike_slots: slots }];
const ride = { id: 'q1', session_id: P1, session_day: 'Friday', session_date: P1, queue_num: 2, name: 'Spec Rider', phone: '0551112222',
  customer_id: 'c1', status: 'done', paid: true, type_preference: 'Road', price: 115, walk_in: false, registered_at: '2026-09-01T10:00:00Z',
  rating_detail: { form: 'rental', s: { service: 10, bike: 10, experience: 10 } } };
const sys = (slug: string, sort: number, auto = false) => ({ slug, icon: 'flag', color: 'green', name: slug, system: true, auto, sort });
const catalog = [
  sys('marshal', 10), sys('senior_marshal', 11), sys('chief_marshal', 12),
  sys('first_lap', 90, true),
  sys('t25', 200), sys('t50', 201), sys('t100', 202),
  { slug: 'bd_cnight', icon: 'moon', color: 'purple', name: 'Night Owl', description: 'Rode a late ride', system: false, auto: false, sort: 500 },
];
// A 1x1 picture and a small PDF.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const calls = (page: Page, re: RegExp) => {
  const out: Request[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && re.test(new URL(r.url()).pathname)) out.push(r); });
  return out;
};

test.describe('@customer:account badge requests', () => {
  async function rider(page: Page, fx: Fixtures = {}) {
    await stubSupabase(page, { sessions, queue_entries: [ride], 'rpc:customer_my_badges': [], 'rpc:badge_catalog': catalog,
      'rpc:customer_my_badge_requests': [], 'rpc:customer_badge_request': { ok: true, id: 41 }, ...fx });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await page.waitForFunction('S._bdgCat&&S._bdgCat.length>0&&S._bdrMine&&!S._bdrMine.busy');
  }
  const dlg = (page: Page) => page.locator('#confirm-modal .bdr-box');

  test('Request a badge: pick one staff give, a comment and a picture; it then waits on the badge', async ({ page }) => {
    await rider(page);
    const sent = calls(page, /\/rpc\/customer_badge_request$/);
    const host = page.locator('#mr-badges-host');
    await expect(host.locator('.mr-bdr-hint')).toContainText('Ask our team for it, with a proof if you have one.');
    await host.getByRole('button', { name: 'Request a badge' }).click();
    await expect(dlg(page)).toHaveAttribute('aria-labelledby', 'bdr-title');
    // Only the badges staff give, every level not reached, and nothing picked until the rider picks.
    await expect(dlg(page).locator('#bdr-badge option')).toHaveText(['Choose a badge', 'Marshal · Level 1 of 5', 'Senior Marshal · Level 2 of 5',
      'Chief Marshal · Level 3 of 5', 'T25 Finisher · Level 1 of 3', 'T50 Finisher · Level 2 of 3', 'T100 Finisher · Level 3 of 3', 'Night Owl']);
    await expect(dlg(page).getByRole('button', { name: 'Send request' })).toBeDisabled();
    await dlg(page).getByLabel('Badge', { exact: true }).selectOption('senior_marshal');
    await expect(dlg(page).locator('.bdr-pick')).toContainText('Senior Marshal');
    await dlg(page).getByLabel('Comment').fill('Swept 12 Saturday rides');
    await dlg(page).locator('input[type=file]').setInputFiles({ name: 'race.png', mimeType: 'image/png', buffer: PNG });
    await expect(dlg(page).locator('.bdr-file img.bdr-thumb')).toHaveCount(1);
    await expect(dlg(page).locator('.bdr-fname')).toHaveText('race.png');
    await expect(dlg(page).getByText('Choose another file')).toBeVisible();
    await dlg(page).getByRole('button', { name: 'Send request' }).click();
    await expect(dlg(page)).toHaveCount(0);
    expect(sent).toHaveLength(1);
    const b = sent[0].postDataJSON();
    expect(b).toMatchObject({ p_id: 'c1', p_token: 'tok-spec', p_badge: 'senior_marshal', p_comment: 'Swept 12 Saturday rides', p_proof_name: 'race.png' });
    expect(b.p_proof).toMatch(/^data:image\/jpeg;base64,/); // made small as a receipt is
    await expect(page.locator('.toast').last()).toContainText('Request sent. Our team will look at it.');
    await expect(host.locator('.mr-bdr-hint')).toHaveText('Requests waiting for our team: 1');
    await expect(host.getByRole('button', { name: 'Request a badge' })).toBeFocused();
    // The Marshal tile says it waits, and its popup names the level asked for.
    await page.locator('#mr-badges-more').click();
    const tile = host.locator('.mr-badge', { hasText: 'Marshal' });
    await expect(tile).toHaveAttribute('aria-label', /\(Requested\)$/);
    await tile.click();
    const pop = page.locator('#badge-pop');
    await expect(pop.locator('.badge-pop-reqst')).toContainText('Senior Marshal');
    await expect(pop.locator('.badge-pop-reqst')).toContainText('You asked for it on');
    await expect(pop.getByRole('button', { name: 'Close' })).toBeFocused();
    await pop.getByRole('button', { name: 'Change your request' }).click();
    await expect(page.locator('#badge-pop')).toHaveCount(0);
    await expect(dlg(page).locator('#bdr-badge')).toHaveValue('senior_marshal');
    await expect(dlg(page).locator('.bdr-was')).toContainText('Sending again replaces that request.');
    await dlg(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg(page)).toHaveCount(0);
  });

  test('a PDF goes as it is; a file that is not one, or one over 2 MB, is refused', async ({ page }) => {
    await rider(page);
    const sent = calls(page, /\/rpc\/customer_badge_request$/);
    await page.locator('#mr-badges-more').click();
    await page.locator('#mr-badges-host .mr-badge', { hasText: 'Night Owl' }).click();
    await page.locator('#badge-pop').getByRole('button', { name: 'Request this badge' }).click();
    await expect(dlg(page).locator('#bdr-badge')).toHaveValue('bd_cnight');
    const file = dlg(page).locator('input[type=file]');
    await file.setInputFiles({ name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('hello') });
    await expect(dlg(page).getByRole('alert')).toHaveText('This file can’t be sent. Choose a picture, or a PDF of 2 MB at most.');
    await file.setInputFiles({ name: 'big.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF, Buffer.alloc(2e6)]) });
    await expect(dlg(page).getByRole('alert')).toBeVisible();
    await file.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    await expect(dlg(page).getByRole('alert')).toBeVisible();
    await file.setInputFiles({ name: 'cert.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(dlg(page).getByRole('alert')).toHaveCount(0);
    await expect(dlg(page).locator('.bdr-file .bdr-doc svg')).toHaveCount(1);
    await expect(dlg(page).locator('.bdr-fname')).toHaveText('cert.pdf');
    await dlg(page).getByRole('button', { name: 'Remove' }).click();
    await expect(dlg(page).locator('.bdr-file')).toHaveCount(0);
    await dlg(page).locator('input[type=file]').setInputFiles({ name: 'cert.pdf', mimeType: 'application/pdf', buffer: PDF });
    await dlg(page).getByRole('button', { name: 'Send request' }).click();
    await expect(dlg(page)).toHaveCount(0);
    const b = sent[0].postDataJSON();
    expect(b).toMatchObject({ p_badge: 'bd_cnight', p_comment: null, p_proof_name: 'cert.pdf' });
    expect(b.p_proof).toBe('data:application/pdf;base64,' + PDF.toString('base64'));
  });

  test('a declined request says so with staff\'s note; a refused send keeps the dialog with the reason', async ({ page }) => {
    await rider(page, {
      'rpc:customer_my_badge_requests': [{ id: 7, slug: 't100', status: 'declined', at: '2026-10-30T10:00:00Z', decided_at: '2026-11-01T10:00:00Z', reply: 'Send the finisher certificate', proof_kind: null }],
      'rpc:customer_badge_request': { ok: false, error: 'limit' },
    });
    await page.locator('#mr-badges-more').click();
    await page.locator('#mr-badges-host .mr-badge', { hasText: 'T25 Finisher' }).click();
    const pop = page.locator('#badge-pop');
    await expect(pop.locator('.badge-pop-reqst')).toContainText('T100 Finisher');
    await expect(pop.locator('.badge-pop-reqst')).toContainText('Our team did not give it this time.');
    await expect(pop.locator('.badge-pop-req .badge-pop-note')).toHaveText('Send the finisher certificate');
    await pop.getByRole('button', { name: 'Ask again' }).click();
    await expect(dlg(page).locator('#bdr-badge')).toHaveValue('t100');
    await dlg(page).getByRole('button', { name: 'Send request' }).click();
    await expect(dlg(page).getByRole('alert')).toHaveText('You have 10 requests waiting. Our team needs to answer them first.');
    await expect(dlg(page).getByRole('button', { name: 'Send request' })).toBeEnabled();
  });

  test('without the database\'s side nothing offers a request, and Arabic reads its own words', async ({ page }) => {
    const gone = (fn: string) => ({ __rpcError: { status: 404, code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } });
    await rider(page, { 'rpc:customer_my_badge_requests': gone('customer_my_badge_requests'), 'rpc:customer_badge_request': gone('customer_badge_request') });
    await page.waitForFunction('S._bdrOff===true');
    await expect(page.locator('#mr-badges-host .mr-bdr')).toHaveCount(0);
    await page.locator('#mr-badges-more').click();
    await page.locator('#mr-badges-host .mr-badge', { hasText: 'Night Owl' }).click();
    await expect(page.locator('#badge-pop .badge-pop-req')).toHaveCount(0);
  });

  test('in Arabic the button and the dialog read Arabic', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cq_lang', 'ar'));
    await rider(page);
    await page.locator('#mr-badges-host').getByRole('button', { name: 'اطلب وسامًا' }).click();
    await expect(dlg(page).locator('#bdr-title')).toHaveText('طلب وسام');
    await expect(dlg(page).getByRole('button', { name: 'أرسل الطلب' })).toBeDisabled();
  });
});

test.describe('@staff:community badge requests', () => {
  const customers = [
    { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', gender: 'female', created_at: '2026-06-10T09:00:00Z' },
    { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', gender: 'male', created_at: '2026-06-11T09:00:00Z' },
  ];
  const badges = [
    { id: 'bd_marshal', slug: 'marshal', icon: 'shield', color: 'orange', name: 'Marshal', system: true, auto: false, retired: false, sort: 10 },
    { id: 'bd_senior_marshal', slug: 'senior_marshal', icon: 'shield', color: 'orange', name: 'Senior Marshal', system: true, auto: false, retired: false, sort: 11 },
    { id: 'bd_t100', slug: 't100', icon: 'medal', color: 'gold', name: 'T100 Finisher', system: true, auto: false, retired: false, sort: 202 },
  ];
  const ago = (h: number) => new Date(Date.now() - h * 36e5).toISOString();
  const requests = [
    { id: 1, customer_id: 'c1', badge_id: 'bd_senior_marshal', comment: 'Swept 12 rides', proof_kind: 'image', proof_name: 'race.png', status: 'pending', created_at: ago(2), decided_at: null, decided_by: null, reply: null },
    { id: 2, customer_id: 'c2', badge_id: 'bd_t100', comment: null, proof_kind: 'pdf', proof_name: 'cert.pdf', status: 'pending', created_at: ago(5), decided_at: null, decided_by: null, reply: null },
    { id: 3, customer_id: 'c2', badge_id: 'bd_marshal', comment: null, proof_kind: null, proof_name: null, status: 'declined', created_at: ago(90), decided_at: ago(80), decided_by: 'Malik', reply: 'Not yet' },
  ];
  async function staff(page: Page, fx: Fixtures = {}, gone = false) {
    await stubSupabase(page, { sessions, customers, queue_entries: [], bikes: [], tags: [], customer_tags: [], staff_options: [], badges, customer_badges: [], badge_requests: requests, ...fx });
    // a database without the table (PGRST205)
    if (gone) await page.route(/\/rest\/v1\/badge_requests/, (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.badge_requests' in the schema cache" }) }));
    // The proof, read alone by its id.
    await page.route(/\/rest\/v1\/badge_requests\?select=proof/, (r) => {
      const id = new URL(r.request().url()).searchParams.get('id')?.replace('eq.', '');
      const proof = id === '1' ? { proof: 'data:image/png;base64,' + PNG.toString('base64'), proof_name: 'race.png' }
        : id === '2' ? { proof: 'data:application/pdf;base64,' + PDF.toString('base64'), proof_name: 'cert.pdf' } : { proof: null, proof_name: null };
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([proof]) });
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('community');S.communityTab='badges';renderCommunity()`);
    await page.waitForFunction('(Array.isArray(S._bdrRows)||S._bdrGone)&&S._bdgAt>0&&!S._bdgBusy');
  }
  const box = (page: Page) => page.locator('#tab-community .bdr-st');
  const row = (page: Page, id: number) => box(page).locator(`.bdr-row[data-req="${id}"]`);

  test('the requests head Badges with their number; each proof opens; Give writes the badge with the levels under it', async ({ page }) => {
    await staff(page);
    await expect(page.locator('#tab-community .cmy-nav .filter-pill', { hasText: 'Badges' })).toHaveText('Badges (2)');
    await expect(box(page).locator('#bdr-st-h')).toContainText('Badge requests');
    await expect(box(page).locator('.bdr-st-list').first().locator('.bdr-row')).toHaveCount(2);
    await expect(row(page, 1)).toContainText('Senior Marshal · Level 2 of 5');
    await expect(row(page, 1)).toContainText('Lina Haddad');
    await expect(row(page, 1).locator('.bdr-cmt')).toHaveText('Swept 12 rides');

    await row(page, 1).getByRole('button', { name: 'View picture' }).click();
    const pf = page.locator('#confirm-modal .bdr-pf');
    await expect(pf.locator('img.vt-rc-img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await pf.getByRole('button', { name: 'Close' }).first().click();
    await row(page, 2).getByRole('button', { name: 'View PDF' }).click();
    await expect(pf.locator('.bdr-pf-doc')).toContainText('cert.pdf');
    await expect(pf.getByRole('link', { name: 'Open PDF' })).toHaveAttribute('href', /^blob:/);
    await expect(pf.getByRole('link', { name: 'Save file' })).toHaveAttribute('download', 'cert.pdf');
    await pf.getByRole('button', { name: 'Close' }).first().click();
    await expect(pf).toHaveCount(0);

    const answered = calls(page, /\/rest\/v1\/badge_requests$/), given = calls(page, /\/rest\/v1\/customer_badges$/);
    await row(page, 1).getByLabel('Note for the rider').fill('Thanks for sweeping');
    await row(page, 1).getByRole('button', { name: 'Give badge' }).click();
    await expect(page.locator('.toast').last()).toContainText('Badge given: Senior Marshal to Lina Haddad');
    // Claimed first (still waiting), then given: the level and the one under it, the note with both.
    expect(answered).toHaveLength(1);
    const q = new URL(answered[0].url()).searchParams;
    expect([q.get('id'), q.get('status')]).toEqual(['eq.1', 'eq.pending']);
    expect(answered[0].postDataJSON()).toMatchObject({ status: 'given', reply: 'Thanks for sweeping', decided_by: 'Spec Staff' });
    expect(given).toHaveLength(1);
    const rows = given[0].postDataJSON();
    expect(rows.map((x: { badge_id: string }) => x.badge_id)).toEqual(['bd_senior_marshal', 'bd_marshal']);
    expect(rows[0]).toMatchObject({ customer_id: 'c1', note: 'Thanks for sweeping' });
    await expect(page.locator('#tab-community .cmy-nav .filter-pill', { hasText: 'Badges' })).toHaveText('Badges (1)');
    await expect(row(page, 1)).toHaveCount(0); // folded with the answered ones
    await box(page).getByRole('button', { name: 'Answered in the last 30 days (2)' }).click();
    await expect(row(page, 1).locator('.bdr-chip.bdr-given')).toHaveText(/^Given .+ by Spec Staff$/);
    await expect(row(page, 3).locator('.bdr-chip.bdr-declined')).toHaveText(/^Declined .+ by Malik$/);
    await expect(row(page, 3)).toContainText('Not yet');

    // Undo takes the badges back and the request waits again.
    await page.evaluate('doUndo()');
    await expect.poll(() => answered.length).toBe(2);
    expect(answered[1].postDataJSON()).toEqual({ status: 'pending', decided_at: null, decided_by: null, reply: null });
    await expect(page.locator('#tab-community .cmy-nav .filter-pill', { hasText: 'Badges' })).toHaveText('Badges (2)');
  });

  test('Decline asks on a second tap; a request another desk answered is left alone', async ({ page }) => {
    await staff(page);
    const answered = calls(page, /\/rest\/v1\/badge_requests$/);
    await row(page, 2).getByLabel('Note for the rider').fill('Send the official result');
    await row(page, 2).getByRole('button', { name: 'Decline' }).click();
    expect(answered).toHaveLength(0);
    await row(page, 2).getByRole('button', { name: 'Decline it?' }).click();
    await expect(page.locator('.toast').last()).toContainText('Request declined: T100 Finisher for Omar Saleh');
    expect(answered[0].postDataJSON()).toMatchObject({ status: 'declined', reply: 'Send the official result' });

    // Another desk answered the first one meanwhile: the claim comes back empty, nothing is given.
    await page.route(/\/rest\/v1\/badge_requests\?id=eq\.1/, (r) => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' }) : r.fallback());
    const given = calls(page, /\/rest\/v1\/customer_badges$/);
    await row(page, 1).getByRole('button', { name: 'Give badge' }).click();
    await expect(page.locator('.toast').last()).toContainText('Another staff member already answered this request.');
    expect(given).toHaveLength(0);
  });

  test('without the table, Badges shows no requests and no number', async ({ page }) => {
    await staff(page, {}, true);
    await page.waitForFunction('S._bdrGone===true');
    await expect(box(page)).toHaveCount(0);
    await expect(page.locator('#tab-community .cmy-nav .filter-pill', { hasText: 'Badges' })).toHaveText('Badges');
  });
});
