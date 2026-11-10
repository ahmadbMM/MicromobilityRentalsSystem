import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Competing in a sport (the user, 2026-11-10: "add a question and keep as a field in all accounts and force it on
// community members the next time they open or sign in the website, Do you compete in a professional/amateur
// capacity in a sport? yes or no and the answers if yes be" the Saudi sports federations; migration 20261110233000).
// The server asks it of a Community member with no answer (_customer_asks 'sport'): its own pop-up at sign-in, No
// saves at once, Yes asks for one or more federations. Every account has it on My Account, and staff see and edit it
// in the account editor. Every person here is made up.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }];

function rpcBodies(page: Page, fn: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new RegExp(`/rpc/${fn}(\\?|$)`).test(r.url())) out.push(r.postDataJSON()); });
  return out;
}

test.describe('@customer:fix the sport question for a Community member', () => {
  async function open(page: Page, fields: string[] = ['sport']) {
    await stubSupabase(page, {
      sessions, queue_entries: [], 'rpc:my_bookings': [],
      'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', socials: null }],
      'rpc:customer_fix_fields': fields,
      'rpc:customer_fix_save': [],
      'rpc:customer_sport': [{ competes: null, federations: null, asked: true }],
      'rpc:community_member': true,
    });
    const sent = rpcBodies(page, 'customer_fix_save');
    await loginCustomer(page, { id: 'c1', phone: '0500000001' });
    await page.goto('/');
    await waitForSb(page);
    return sent;
  }

  test('opens on its own as the site opens: the question, Yes or No, Log out; No saves at once', async ({ page }) => {
    const sent = await open(page);
    const box = page.locator('#fix-gate .fx-sp-box');
    await expect(box).toBeVisible();
    await expect(page.locator('#fx-title')).toHaveText('Do you compete in a sport, professionally or as an amateur?');
    await expect(box.locator('.fx-opt')).toHaveText(['Yes', 'No']);
    await expect(page.locator('#fx-save')).toBeHidden(); // nothing to save before Yes
    await expect(box.locator('.gate-out')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(box).toBeVisible();
    await box.locator('.fx-opt', { hasText: 'No' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_values).toEqual({ sport: { competes: false } });
    await expect(page.locator('#fix-gate .fx-box')).toHaveCount(0);
  });

  test('Yes asks for the federations: none is refused, they are added, removed and sent in the list\'s order', async ({ page }) => {
    const sent = await open(page);
    const box = page.locator('#fix-gate .fx-sp-box');
    await box.locator('.fx-opt', { hasText: 'Yes' }).click();
    const add = page.locator('#fx-sp-add');
    await expect(add).toBeVisible();
    await expect(add).toBeFocused();
    // ten groups as the user gave them, 74 federations and committees
    await expect(add.locator('optgroup')).toHaveCount(10);
    await expect(add.locator('optgroup option')).toHaveCount(74);
    await expect(add.locator('optgroup').first()).toHaveAttribute('label', 'Endurance, Cycling & Water Sports');
    await page.click('#fx-save');
    await expect(page.locator('.fx-item[data-fx="sport"] .pg-msg')).toHaveText('Choose at least one federation.');
    expect(sent).toHaveLength(0);
    await add.selectOption('padel');
    await add.selectOption('swimming');
    await add.selectOption('cycling');
    await expect(page.locator('.fx-item[data-fx="sport"] .pg-msg')).toHaveCount(0);
    await expect(box.locator('.sp-chip')).toHaveText(['Saudi Cycling Federation', 'Saudi Swimming Federation', 'Saudi Padel Committee']);
    await expect(add.locator('option[value="cycling"]')).toHaveCount(0); // a picked one is not offered again
    await box.locator('.sp-x[aria-label="Remove Saudi Swimming Federation"]').click();
    await expect(box.locator('.sp-chip')).toHaveCount(2);
    await page.click('#fx-save');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_values).toEqual({ sport: { competes: true, federations: ['cycling', 'padel'] } });
    await expect(page.locator('#fix-gate .fx-box')).toHaveCount(0);
  });

  test('with other things asked too it is one item of the check-up', async ({ page }) => {
    const sent = await open(page, ['instagram', 'sport']);
    await expect(page.locator('#fix-gate .fx-box')).toBeVisible();
    await expect(page.locator('#fix-gate .fx-sp-box')).toHaveCount(0);
    const item = page.locator('.fx-item[data-fx="sport"]');
    await expect(item.locator('.fx-q')).toHaveText('Do you compete in a sport, professionally or as an amateur?');
    await page.fill('#fx-soc-instagram', 'spec.rider');
    await page.click('#fx-save');
    await expect(item).toHaveClass(/err/); // not answered
    expect(sent).toHaveLength(0);
    await item.locator('.fx-opt', { hasText: 'Yes' }).click();
    await page.locator('#fx-sp-add').selectOption('athletics');
    await expect(page.locator('#fx-soc-instagram')).toHaveValue('spec.rider'); // the typed handle stays
    await page.click('#fx-save');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_values).toEqual({ instagram: 'spec.rider', sport: { competes: true, federations: ['athletics'] } });
  });

  test('in Arabic the groups and federations read in Arabic', async ({ page }) => {
    await open(page);
    await page.evaluate(`setLang('ar')`);
    await page.locator('#fix-gate .fx-sp-box .fx-opt').first().click();
    const add = page.locator('#fx-sp-add');
    await expect(add.locator('optgroup').first()).toHaveAttribute('label', 'التحمل والدراجات والرياضات المائية');
    await add.selectOption('cycling');
    await expect(page.locator('#fix-gate .sp-chip')).toHaveText(['الاتحاد السعودي للدراجات']);
  });
});

test.describe('@customer:account the sport card', () => {
  async function account(page: Page, fx: Record<string, unknown>) {
    await stubSupabase(page, { sessions: [], queue_entries: [], 'rpc:my_bookings': [], 'rpc:customer_set_sport': true, ...fx });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account','sport')`);
  }

  test('not answered: the question, and Yes with a federation saves', async ({ page }) => {
    const sent = rpcBodies(page, 'customer_set_sport');
    await account(page, { 'rpc:customer_sport': [{ competes: null, federations: null, asked: false }] });
    const card = page.locator('#acc-sp');
    await expect(card).toContainText('Do you compete in a sport, professionally or as an amateur?');
    await page.locator('#acc-sp-save').click();
    await expect(page.locator('#acc-sp-err')).toHaveText('Choose one to continue.');
    await card.locator('.fx-opt', { hasText: 'Yes' }).click();
    await page.locator('#acc-sp-save').click();
    await expect(page.locator('#acc-sp-err')).toHaveText('Choose at least one federation.');
    expect(sent).toHaveLength(0);
    await page.locator('#acc-sp-add').selectOption('chess');
    await page.locator('#acc-sp-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_competes: true, p_federations: ['chess'] });
    await expect(card).toContainText('Saudi Chess Federation');
    await expect(card.locator('button', { hasText: 'Change' })).toBeVisible();
  });

  test('an answer reads as one line; Change asks again, and No sends no federations', async ({ page }) => {
    const sent = rpcBodies(page, 'customer_set_sport');
    await account(page, { 'rpc:customer_sport': [{ competes: true, federations: ['triathlon', 'cycling'], asked: false }] });
    const card = page.locator('#acc-sp');
    await expect(card.locator('.run-em-n')).toHaveText('Yes');
    await expect(card.locator('.run-em-m')).toHaveText('Saudi Cycling Federation · Saudi Triathlon Federation');
    await card.locator('button', { hasText: 'Change' }).click();
    await expect(card.locator('.sp-chip')).toHaveCount(2);
    await card.locator('.fx-opt', { hasText: 'No' }).click();
    await expect(card.locator('.sp-chip')).toHaveCount(0);
    await page.locator('#acc-sp-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_competes: false, p_federations: null });
    await expect(card.locator('.run-em-n')).toHaveText('No');
  });

  test('a database from before the field shows no card', async ({ page }) => {
    await account(page, { 'rpc:customer_sport': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_sport in the schema cache' } } });
    await expect(page.locator('#acc-em-host')).toBeAttached();
    await expect(page.locator('#acc-sp')).toHaveCount(0);
  });
});

test.describe('@staff:accounts the sport answer', () => {
  const base = { id: 'c1', name: 'Huda Saleh', email: 'huda@example.com', phone: '+966550000009', created_at: '2026-06-10T09:00:00Z', type_preference: 'Road', height: 165 };
  async function editor(page: Page, row: Record<string, unknown>) {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], customers: [{ ...base, ...row }] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`(S.customers||[]).length>0`);
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customers')) sent.push(r.postDataJSON()); });
    await page.evaluate(`showEditCustomerModal('c1')`);
    return sent;
  }

  test('the account editor shows the answer and saves a change', async ({ page }) => {
    const sent = await editor(page, { sport_competes: true, sport_federations: ['football'] });
    const host = page.locator('#cf-sp-host');
    await expect(host.locator('.sp-chip')).toHaveText(['Saudi Arabian Football Federation']);
    await page.locator('#cf-sp-add').selectOption('basketball');
    await page.evaluate(`saveCustForm()`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ sport_competes: true, sport_federations: ['football', 'basketball'] });
  });

  test('an account that has not answered stays unanswered, and a yes needs a federation', async ({ page }) => {
    const sent = await editor(page, { sport_competes: null, sport_federations: null });
    const host = page.locator('#cf-sp-host');
    await expect(host.locator('.fx-opt')).toHaveText(['Yes', 'No']);
    await page.evaluate(`saveCustForm()`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).not.toHaveProperty('sport_competes');
    await page.evaluate(`showEditCustomerModal('c1')`); // the save closed it
    await host.locator('.fx-opt', { hasText: 'Yes' }).click();
    await expect(page.locator('#cf-sp-add')).toBeVisible();
    await page.evaluate(`saveCustForm()`);
    await expect(page.locator('.toast', { hasText: 'Choose at least one federation.' }).first()).toBeVisible();
  });

  test('never saves an answer it could not read', async ({ page }) => {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], customers: [base] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`(S.customers||[]).length>0`);
    await page.route(/\/rest\/v1\/customers\?.*select=sport_competes/, (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '42703', message: 'column customers.sport_competes does not exist' }) }));
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customers')) sent.push(r.postDataJSON()); });
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(page.locator('#cf-em-host')).toBeAttached();
    await expect(page.locator('#cf-sp-host .fx-seg')).toHaveCount(0);
    await page.evaluate(`saveCustForm()`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).not.toHaveProperty('sport_competes');
  });
});

// "Other" and the sports staff add (the user, 2026-11-10: "add an option called other that opens a text field to allow
// them to write their choice and add this choice later on to the list").
test.describe('@customer:fix Other and the sports added to the list', () => {
  async function open(page: Page, opts: unknown[] = []) {
    await stubSupabase(page, {
      sessions, queue_entries: [], 'rpc:my_bookings': [],
      'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', socials: null }],
      'rpc:customer_fix_fields': ['sport'], 'rpc:customer_fix_save': [], 'rpc:community_member': true,
      'rpc:customer_sport': [{ competes: null, federations: null, other: null, asked: true }],
      'rpc:sport_option_list': opts,
    });
    const sent = rpcBodies(page, 'customer_fix_save');
    await loginCustomer(page, { id: 'c1', phone: '0500000001' });
    await page.goto('/');
    await waitForSb(page);
    await page.locator('#fix-gate .fx-sp-box .fx-opt', { hasText: 'Yes' }).click();
    return sent;
  }

  test('Other opens a box for their own sport, which is required and sent with it', async ({ page }) => {
    const sent = await open(page);
    const add = page.locator('#fx-sp-add');
    await expect(add.locator('option[value="other"]')).toHaveText('Other');
    await add.selectOption('other');
    const box = page.locator('#fx-sp-other');
    await expect(box).toBeFocused();
    await expect(add.locator('option[value="other"]')).toHaveCount(0);
    await page.click('#fx-save');
    await expect(page.locator('.fx-item[data-fx="sport"] .pg-msg')).toHaveText('Write your sport in 2 to 60 characters.');
    expect(sent).toHaveLength(0);
    await box.fill('  Kite   surfing ');
    await add.selectOption('golf');
    await expect(page.locator('#fx-sp-other')).toHaveValue('  Kite   surfing '); // a redraw keeps what was typed
    await page.click('#fx-save');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_values).toEqual({ sport: { competes: true, federations: ['golf', 'other'], other: 'Kite surfing' } });
  });

  test('removing Other takes its box away; the sports staff added are offered under More sports', async ({ page }) => {
    await open(page, [{ code: 'x_kite_surfing', name_en: 'Kite surfing', name_ar: 'ركوب الأمواج بالطائرة الورقية' }]);
    const add = page.locator('#fx-sp-add');
    await expect(add.locator('optgroup[label="More sports"] option')).toHaveText(['Kite surfing']);
    await add.selectOption('other');
    await expect(page.locator('#fx-sp-other')).toBeVisible();
    await page.locator('.sp-x[aria-label="Remove Other"]').click();
    await expect(page.locator('#fx-sp-other')).toHaveCount(0);
    await add.selectOption('x_kite_surfing');
    await expect(page.locator('#fix-gate .sp-chip')).toHaveText(['Kite surfing']);
  });
});

test.describe('@customer:account Other on the sport card', () => {
  test('an answer with Other reads with what they wrote, and a change sends it', async ({ page }) => {
    const sent = rpcBodies(page, 'customer_set_sport');
    await stubSupabase(page, { sessions: [], queue_entries: [], 'rpc:my_bookings': [], 'rpc:customer_set_sport': true, 'rpc:sport_option_list': [],
      'rpc:customer_sport': [{ competes: true, federations: ['cycling', 'other'], other: 'Kite surfing', asked: false }] });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account','sport')`);
    const card = page.locator('#acc-sp');
    await expect(card.locator('.run-em-m')).toHaveText('Saudi Cycling Federation · Kite surfing');
    await card.locator('button', { hasText: 'Change' }).click();
    await expect(page.locator('#acc-sp-other')).toHaveValue('Kite surfing');
    await page.fill('#acc-sp-other', 'x');
    await page.locator('#acc-sp-save').click();
    await expect(page.locator('#acc-sp-err')).toHaveText('Write your sport in 2 to 60 characters.');
    await page.fill('#acc-sp-other', 'Padel tennis');
    await page.locator('#acc-sp-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_competes: true, p_federations: ['cycling', 'other'], p_other: 'Padel tennis' });
  });
});

// Analytics > Sports we have (the user, 2026-11-10: "add to reports as an option called sports we have and graphs and
// stats on it", "add as much analytics options as you can for it").
test.describe('@staff:analytics Sports we have', () => {
  const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#03ff89' }];
  const cust = (id: string, name: string, x: Record<string, unknown> = {}) => ({ id, name, email: `${id}@example.com`, phone: '+96655000000' + id.slice(-1), created_at: '2026-06-10T09:00:00Z', height: 170, ...x });
  const customers = [
    cust('c1', 'Huda Saleh', { gender: 'female', birth_date: '1995-03-01', nationality: 'Saudi Arabia', type_preference: 'Road' }),
    cust('c2', 'Omar Faris', { gender: 'male', birth_date: '1988-07-20', nationality: 'Egypt', type_preference: 'Hybrid' }),
    cust('c3', 'Lina Haddad', { gender: 'female', birth_date: '2001-01-15', nationality: 'Saudi Arabia' }),
    cust('c4', 'Sami Noor', { gender: 'male' }),
    cust('c5', 'Rami Aziz', { gender: 'male' }),
  ];
  const answers = [
    { id: 'c1', sport_competes: true, sport_federations: ['cycling', 'triathlon'], sport_other: null, sport_answered_at: new Date().toISOString() },
    { id: 'c2', sport_competes: true, sport_federations: ['cycling', 'other'], sport_other: 'Kite surfing', sport_answered_at: new Date().toISOString() },
    { id: 'c3', sport_competes: true, sport_federations: ['other'], sport_other: 'kite  SURFING', sport_answered_at: new Date().toISOString() },
    { id: 'c4', sport_competes: false, sport_federations: null, sport_other: null, sport_answered_at: new Date().toISOString() },
  ];
  async function view(page: Page) {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], customers, tags,
      customer_tags: [{ customer_id: 'c1', tag_id: 'tag_saturday', added_at: 1 }, { customer_id: 'c5', tag_id: 'tag_saturday', added_at: 1 }],
      'rpc:sport_option_list': [], 'rpc:staff_sport_option_add': 'x_kite_surfing' });
    await page.route(/\/rest\/v1\/customers\?.*sport_answered_at/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answers) }));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`(S.customers||[]).length>0`);
    await page.evaluate(`setStaffTab('analytics');setAnView('sports')`);
    const host = page.locator('#an-sp-host');
    await expect(host.locator('.analytics-kpi-card').first()).toBeVisible();
    return host;
  }

  test('the figures, the federations with their names, and what was written under Other, grouped', async ({ page }) => {
    const host = await view(page);
    await expect(page.locator('#tab-analytics .an-nav-btn[data-anview="sports"]')).toHaveText('Sports we have');
    const kpi = (label: string) => host.locator('.analytics-kpi-card', { has: page.locator('.analytics-kpi-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.analytics-kpi-value');
    await expect(kpi('Answered')).toHaveText('4');
    await expect(kpi('Compete in a sport')).toHaveText('3');
    await expect(kpi('Do not compete')).toHaveText('1');
    await expect(kpi('Not answered yet')).toHaveText('1');
    await expect(kpi('Community members still to answer')).toHaveText('1'); // c5
    await expect(kpi('In more than one sport')).toHaveText('2');
    const cycling = host.locator('.sp-an-fed', { hasText: 'Saudi Cycling Federation' });
    await expect(cycling.locator('.analytics-bar-value')).toContainText('2');
    await cycling.locator('.sp-an-fed-btn').click();
    await expect(host.locator('.sp-an-fed', { hasText: 'Saudi Cycling Federation' }).locator('.sp-an-names li')).toHaveText([/Huda Saleh/, /Omar Faris/]);
    // two spellings of one written answer are one row
    const others = host.locator('.sp-an-tbl', { has: page.locator('th', { hasText: 'Your sport' }) }).locator('tbody tr');
    await expect(others).toHaveCount(1);
    await expect(others.locator('td').nth(1)).toHaveText('2');
    for (const title of ['Yes, no and not answered', 'By group', 'Sports per athlete', 'Athletes by gender', 'Athletes by age', 'Athletes by nationality', 'Athletes by preferred bike', 'Answers by week', 'Riding: athletes and everyone else'])
      await expect(host.locator('.chart-card-title', { hasText: title })).toHaveCount(1);
  });

  test('Community members only, and female accounts only, narrow every figure', async ({ page }) => {
    const host = await view(page);
    await host.locator('.filter-pill', { hasText: 'Community members' }).click();
    const kpi = (label: string) => host.locator('.analytics-kpi-card', { has: page.locator('.analytics-kpi-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.analytics-kpi-value');
    await expect(kpi('Answered')).toHaveText('1');
    await host.locator('.filter-pill', { hasText: 'All accounts' }).click();
    await host.locator('.filter-pill', { hasText: 'Female' }).click();
    await expect(kpi('Answered')).toHaveText('2');
    await expect(kpi('Compete in a sport')).toHaveText('2');
  });

  test('Add to the list sends the names and what riders wrote, then reads again', async ({ page }) => {
    const host = await view(page);
    const sent = rpcBodies(page, 'staff_sport_option_add');
    await host.locator('button', { hasText: 'Add to the list' }).click();
    await expect(page.locator('#sp-an-en')).toHaveValue('Kite surfing');
    await page.fill('#sp-an-ar', 'ركوب الأمواج بالطائرة الورقية');
    await page.click('#sp-an-dlg-go');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ p_name_en: 'Kite surfing', p_name_ar: 'ركوب الأمواج بالطائرة الورقية', p_from: 'Kite surfing' });
    await expect(page.locator('#sp-an-en')).toHaveCount(0);
  });

  test('the answers download as a CSV with the federations by name', async ({ page }) => {
    const host = await view(page);
    const dl = page.waitForEvent('download');
    await host.locator('button', { hasText: 'Answers (CSV)' }).click();
    const file = await dl;
    const text = await (await file.createReadStream()).toArray().then((b) => Buffer.concat(b).toString('utf8'));
    expect(text).toContain('Huda Saleh');
    expect(text).toContain('Saudi Cycling Federation; Saudi Triathlon Federation');
    expect(text).toContain('Kite surfing');
  });
});
