import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// Safety feedback (the user, 2026-11-21: "i dont want it to be an incident report but more of a way we can gather info
// and feedback on how we can make our services better and safer and more responsive"; migration 20261121400000).
// Riders: a past booking's Safety feedback button (My bookings) opens Account > Safety feedback (/account/safety,
// rider-safety.js); ?b=<entry> on an arrival names the booking. Staff: the section Safety feedback (/safety), from the
// Bookings right. Every function is stubbed here as the migration answers it.

const J = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
type Row = Record<string, unknown>;
type Call = { fn: string; body: Row };
const d = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sess = (date: string, o: Row = {}) => ({ id: date, day: 'Friday', session_date: date, capacity: 20, status: 'open', created_at: 1,
  title: 'Night ride', bike_slots: '{"_time":"19:00 - 21:00"}', ...o });
const row = (id: string, sid: string, date: string, extra: Row = {}) => ({
  id, name: 'Spec Rider', customer_id: 'c1', session_id: sid, session_day: 'Friday', session_date: date, queue_num: 1,
  status: 'done', paid: true, price: 0, checked_out_at: date + 'T18:00:00Z', registered_at: date + 'T15:00:00Z', ...extra,
});
const entry = (id: string, date: string, name = 'Spec Rider') => ({ entry_id: id, session_id: date, name, date, title: 'Night ride', title_ar: null, ended_at: date + 'T18:00:00Z', until: '2099-01-01T00:00:00Z' });

// ── The rider's functions, as an account's database answers them ───────────────────────────────────────────────────
type RiderDb = { mine: { ok: true; now: string; items: Row[]; entries: Row[] }; send?: Row; calls: Call[] };
const mine = (o: Partial<RiderDb['mine']> = {}): RiderDb['mine'] => ({ ok: true, now: '2099-01-01T00:00:00Z', items: [], entries: [], ...o });
async function riderDb(page: Page, db: RiderDb) {
  await page.route(/\/rest\/v1\/rpc\/(safety_mine|safety_send)\b/, async (route) => {
    const fn = /rpc\/(\w+)/.exec(route.request().url())![1];
    let body: Row = {};
    try { body = route.request().postDataJSON() as Row; } catch { /* no body */ }
    db.calls.push({ fn, body });
    let out: unknown;
    if (fn === 'safety_mine') out = db.mine;
    else {
      out = db.send ?? { ok: true, id: 901, status: 'new' };
      if ((out as Row).ok === true) {
        const e = db.mine.entries.find((x) => x.entry_id === body.p_entry)!;
        db.mine.entries = db.mine.entries.filter((x) => x !== e);
        db.mine.items = [{ id: 901, entry_id: e.entry_id, session_id: e.session_id, rider_name: e.name, kind: (body.p_data as Row).kind, status: 'new', staff_reply: null, replied_at: null, created_at: '2099-01-01T00:00:00Z', date: e.date, title: e.title, title_ar: null }, ...db.mine.items];
      }
    }
    return route.fulfill({ status: 200, headers: J, body: JSON.stringify(out) });
  });
}
const calls = (db: RiderDb, fn: string) => db.calls.filter((c) => c.fn === fn);
async function rider(page: Page, db: RiderDb, fx: Fixtures, path = '/') {
  const q = (fx.queue_entries as Row[]) || [];
  await stubSupabase(page, { bikes: [], customers: [], 'rpc:my_bookings': q, ...fx });
  await riderDb(page, db);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto(path);
  await waitForSb(page);
}
const pg = (page: Page) => page.locator('#sfy-page');

test.describe('@customer:account safety feedback, the rider', () => {
  test('a past booking within its 7 days carries the button; an older one and a booking ahead do not', async ({ page }) => {
    const a = d(-2), old = d(-12), ahead = d(5);
    const db: RiderDb = { mine: mine({ entries: [entry('q1', a)] }), calls: [] };
    await rider(page, db, { sessions: [sess(a), sess(old), sess(ahead)], queue_entries: [row('q1', a, a), row('q2', old, old), row('q3', ahead, ahead, { status: 'waiting' })] });
    await page.evaluate(`goCustomer('myrides')`);
    const tab = page.locator('#tab-myrides');
    await expect.poll(() => calls(db, 'safety_mine').length).toBe(1); // asked once, with a past booking on screen
    await expect(tab.locator('.myrides-grid .sfy-btn')).toHaveCount(0); // the booking ahead: none
    const open = async (sid: string) => { const s = tab.locator(`#wl-${sid} .wl-strip`); if (await s.count()) await s.click(); };
    await open(a);
    await expect(tab.locator(`#wl-${a} .sfy-btn`)).toHaveText(/Safety feedback/);
    await open(old);
    await expect(tab.locator(`#wl-${old} .sfy-btn`)).toHaveCount(0);
    // before the database answers, the card judges by the session's end and its date
    const local = await page.evaluate(`(()=>{const sm=S._sfyM;S._sfyM=null;const g=_myRideGroups(S.loggedIn).past;const r=g.map(x=>[x[0].id,!!_sfyBtn(x)]);S._sfyM=sm;return r;})()`);
    expect(Object.fromEntries(local as [string, boolean][])).toEqual({ q1: true, q2: false });
  });

  test('the button opens the page for that booking: the rider picked, what is missing said, the answers sent as asked', async ({ page }) => {
    const a = d(-1);
    const db: RiderDb = { mine: mine({ entries: [entry('q1', a), entry('q4', a, 'Lina Rider')] }), calls: [] };
    await rider(page, db, { sessions: [sess(a)], queue_entries: [row('q1', a, a), row('q4', a, a, { name: 'Lina Rider', queue_num: 2 })] });
    await page.evaluate(`goCustomer('myrides')`);
    const tab = page.locator('#tab-myrides');
    const strip = tab.locator(`#wl-${a} .wl-strip`);
    if (await strip.count()) await strip.click();
    await tab.locator(`#wl-${a} .sfy-btn`).click();
    await expect(pg(page).locator('.sfy-send')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/account/safety');
    await expect(page.locator('#acc-pg-safety-h')).toHaveText('Safety feedback');
    const p = pg(page), err = p.locator('.tst-err');
    // the riders of that booking, the one tapped first
    await expect(p.locator('[data-fk^="who-"]')).toHaveText(['Spec Rider', 'Lina Rider']);
    await expect(p.locator('[data-fk="who-q1"]')).toHaveAttribute('aria-pressed', 'true');
    await p.locator('[data-fk="who-q4"]').click();
    await expect(p.locator('[data-fk="who-q4"]')).toHaveAttribute('aria-pressed', 'true');
    await p.locator('.sfy-send').click();
    await expect(err).toHaveText('Pick what happened.');
    await expect(p.locator('[data-fk^="parts-"]')).toHaveCount(0); // nothing about an injury until one is told
    await p.locator('[data-fk="kind-injury"]').click();
    await expect(err).toHaveCount(0);
    await expect(p.locator('[data-fk="kind-injury"]')).toBeFocused(); // the tap keeps its place on a redraw
    await p.locator('[data-fk="parts-knee"]').click();
    await p.locator('[data-fk="parts-hand"]').click();
    await p.locator('.sfy-send').click();
    await expect(err).toHaveText('Say how serious the injury was.');
    await p.locator('[data-fk="sev-first_aid"]').click();
    await p.locator('[data-fk="brief-partly"]').click();
    await p.locator('[data-fk="helm-yes"]').click();
    await p.locator('[data-fk="bike-no"]').click();
    await p.locator('[data-fk="causes-route"]').click();
    await p.locator('[data-fk="causes-speed"]').click();
    await p.locator('#sfy-prevent').fill('A warning before the downhill');
    await p.locator('[data-fk="rs-5"]').click();
    await p.locator('[data-fk="rc-4"]').click();
    await p.locator('[data-fk="fna"]').click(); // first aid: not needed
    await p.locator('#sfy-com').fill('Came at once');
    await p.locator('#sfy-ideas').fill('More marshals on the bends');
    await p.locator('.sfy-send').click();
    await expect(err).toHaveText('Tick the box to send it.');
    expect(calls(db, 'safety_send')).toHaveLength(0);
    await expect(p.locator('#sfy-ok')).toHaveAttribute('aria-required', 'true');
    await p.locator('#sfy-ok').click();
    await p.locator('.sfy-send').click();
    await expect(p.locator('#sfy-sent')).toContainText('Thank you. Our team will read it and follow up with you if needed.');
    const sent = calls(db, 'safety_send');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_entry: 'q4', p_data: {
      kind: 'injury', injury_parts: ['knee', 'hand'], injury_severity: 'first_aid', briefing: 'partly', helmet_ok: 'yes', bike_ok: 'no', ready: null,
      causes: ['route', 'speed'], prevent: 'A warning before the downhill', rate_speed: 5, rate_care: 4, rate_first_aid: null,
      resp_comment: 'Came at once', ideas: 'More marshals on the bends', consent: true, lang: 'en' } });
    await expect(p.locator('.sfy-item .sfy-st')).toHaveText('Received');
    // the other rider on the booking can still be told about
    await expect(p.locator('.sfy-more .sfy-tell')).toHaveCount(1);
  });

  test('a refusal is said in the rider’s words', async ({ page }) => {
    const a = d(-1);
    const db: RiderDb = { mine: mine({ entries: [entry('q1', a)] }), send: { ok: false, error: 'late' }, calls: [] };
    await rider(page, db, { sessions: [sess(a)], queue_entries: [row('q1', a, a)] });
    await page.evaluate(`_sfyGo('q1')`);
    const p = pg(page);
    await p.locator('[data-fk="kind-none"]').click();
    await expect(p.locator('[data-fk^="causes-"]')).toHaveCount(0); // nothing happened: no cause asked
    await p.locator('#sfy-ok').click();
    await p.locator('.sfy-send').click();
    await expect(p.locator('.tst-err')).toHaveText('It is more than 7 days since this ride ended.');
  });

  test('arriving by its link: ?b= names the booking and comes off; a sent one shows its state and the team’s reply, on the card too', async ({ page }) => {
    const a = d(-3);
    const db: RiderDb = { mine: mine({ items: [{ id: 5, entry_id: 'q1', session_id: a, rider_name: 'Spec Rider', kind: 'fall', status: 'followed', staff_reply: 'We have fixed the brakes on that bike.', replied_at: '2099-01-01T09:00:00Z', created_at: '2099-01-01T08:00:00Z', date: a, title: 'Night ride', title_ar: null }] }), calls: [] };
    await rider(page, db, { sessions: [sess(a)], queue_entries: [row('q1', a, a)] }, '/account/safety?b=q1');
    const p = pg(page);
    await expect(p.locator('.sfy-item .sfy-st')).toHaveText('Followed up');
    await expect(p.locator('.sfy-reply')).toContainText('Reply from our team');
    await expect(p.locator('.sfy-reply p')).toHaveText('We have fixed the brakes on that bike.');
    expect(new URL(page.url()).search).toBe('');
    await page.evaluate(`goCustomer('myrides')`);
    const tab = page.locator('#tab-myrides');
    const strip = tab.locator(`#wl-${a} .wl-strip`);
    if (await strip.count()) await strip.click();
    await expect(tab.locator(`#wl-${a} .sfy-btn`)).toHaveText(/Safety feedback: Followed up/);
  });

  test('the page without a booking lists what can still be told and the rider’s own', async ({ page }) => {
    const a = d(-1);
    const db: RiderDb = { mine: mine({ entries: [entry('q1', a)], items: [{ id: 6, entry_id: 'q0', session_id: 'x', rider_name: 'Spec Rider', kind: 'near_miss', status: 'closed', staff_reply: null, created_at: '2099-01-01T08:00:00Z', date: d(-20), title: 'Old ride' }] }), calls: [] };
    await rider(page, db, { sessions: [sess(a)], queue_entries: [row('q1', a, a)] }, '/account/safety');
    const p = pg(page);
    await expect(p.locator('.sfy-due')).toHaveCount(1);
    await expect(p.locator('.sfy-mine .sfy-st')).toHaveText('Closed');
    await p.locator('.sfy-tell').click();
    await expect(p.locator('.sfy-send')).toBeVisible();
  });
});

// ── Staff ───────────────────────────────────────────────────────────────────────────────────────────────────────
type StaffDb = { items: Row[]; calls: Call[] };
const F = (id: number, o: Row = {}): Row => ({ id, customer_id: 'c77', entry_id: 'e' + id, session_id: '2099-01-02', rider_name: 'Huda Saleh', kind: 'fall',
  injury_parts: [], injury_severity: null, briefing: 'yes', helmet_ok: 'yes', bike_ok: 'yes', ready: 'yes', causes: ['route'], prevent: null,
  rate_speed: 4, rate_care: 5, rate_first_aid: null, resp_comment: null, ideas: null, lang: 'en', consent_at: '2099-01-02T20:00:00Z', status: 'new',
  staff_note: null, staff_reply: null, replied_at: null, handled_by: null, handled_at: null, created_at: '2099-01-02T20:00:00Z',
  customer_name: 'Huda Saleh', customer_phone: '0551234567', session_title: 'Night ride', session_date: '2099-01-02', session_location: 'Riyadh Front', ...o });
async function staffDb(page: Page, db: StaffDb) {
  await page.route(/\/rest\/v1\/rpc\/staff_safety_/, async (route) => {
    const fn = /rpc\/(\w+)/.exec(route.request().url())![1];
    let body: Row = {};
    try { body = route.request().postDataJSON() as Row; } catch { /* none */ }
    db.calls.push({ fn, body });
    const ok = (v: unknown) => route.fulfill({ status: 200, headers: J, body: JSON.stringify(v) });
    if (fn === 'staff_safety_list') {
      const n = (s: string) => db.items.filter((x) => x.status === s).length;
      return ok({ counts: { new: n('new'), followed: n('followed'), closed: n('closed'), urgent: db.items.filter((x) => x.status === 'new' && ['crash', 'injury'].includes(String(x.kind))).length },
        items: db.items.filter((x) => !body.p_status || x.status === body.p_status) });
    }
    const x = db.items.find((y) => y.id === body.p_id);
    if (!x) return ok(0);
    if (body.p_status) x.status = body.p_status;
    if (body.p_note != null) x.staff_note = body.p_note || null;
    if (body.p_reply != null) x.staff_reply = body.p_reply || null;
    x.handled_by = 'Spec Staff'; x.handled_at = '2099-01-03T09:00:00Z';
    return ok(1);
  });
}
const scalls = (db: StaffDb, fn: string) => db.calls.filter((c) => c.fn === fn);
async function staff(page: Page, db: StaffDb) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [{ id: 'c77', name: 'Huda Saleh', phone: '0551234567' }], site_content: [] });
  await staffDb(page, db);
  await unlockStaff(page);
  await page.goto('/safety');
  await waitForSb(page);
  await page.waitForFunction(`S.view==='staff'&&S.staffTab==='safety'`);
  await expect(page.locator('#tab-safety .sfs-trends')).toBeVisible();
}

test.describe('@staff:safety the section', () => {
  test('the list, its counts and trends, the filters, and the rail’s number', async ({ page }) => {
    const db: StaffDb = { items: [F(1, { kind: 'crash', causes: ['speed', 'route'], rate_speed: 2 }), F(2), F(3, { kind: 'injury', injury_severity: 'clinic', injury_parts: ['knee'], session_id: '2099-01-05', session_title: 'Morning ride', session_location: 'Wadi Hanifa' }),
      F(4, { status: 'closed', kind: 'unsafe', causes: ['other_people'] })], calls: [] };
    await staff(page, db);
    const tab = page.locator('#tab-safety');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="safety"] .tab-badge')).toHaveText('3');
    await expect(tab.locator('.filter-pill')).toHaveText(['New (3)', 'Followed up (0)', 'Closed (1)', 'All (4)']);
    await expect(tab.locator('.sfs-row')).toHaveCount(3);
    // trends over every one: what happened, the causes, the averages, the session and place told twice
    const tr = tab.locator('.sfs-trends');
    await expect(tr).toContainText('4 sent');
    await expect(tr.locator('.sfs-tchip.hot')).toHaveCount(2);
    await expect(tr.locator('.sfs-tcol').nth(1).locator('.sfs-tchip').first()).toHaveText('Route or road surface 3');
    await expect(tr.locator('.sfs-avg').first()).toContainText('3.5');
    await expect(tr.locator('.sfs-replist li')).toHaveCount(2); // the night (3 reports) and Riyadh Front (3)
    // a row: what happened, how serious, where, the answers
    const r3 = tab.locator('.sfs-row[data-sid="3"]');
    await expect(r3.locator('.sfs-h')).toContainText('Injury');
    await expect(r3.locator('.sfs-h')).toContainText('Clinic or doctor');
    await expect(r3).toContainText('Hurt: Knee');
    await expect(r3).toContainText('Morning ride');
    // Filters: what happened
    await tab.locator('.f-show').click();
    await tab.locator('select[aria-label="What happened"]').selectOption('crash');
    await expect(tab.locator('.sfs-row')).toHaveCount(1);
    await expect(tab.locator('.f-show')).toContainText('(1)');
    // a repeated session filters to it
    await tab.locator('select[aria-label="What happened"]').selectOption('');
    await tab.locator('.sfs-rep').first().click();
    await expect(tab.locator('.sfs-row')).toHaveCount(2);
  });

  test('Mark followed up, Back to new, and the note and reply, each sent as asked', async ({ page }) => {
    const db: StaffDb = { items: [F(1, { kind: 'crash' })], calls: [] };
    await staff(page, db);
    const tab = page.locator('#tab-safety'), r = tab.locator('.sfs-row[data-sid="1"]');
    await r.getByRole('button', { name: 'Mark followed up' }).click();
    await expect.poll(() => scalls(db, 'staff_safety_set').length).toBe(1);
    expect(scalls(db, 'staff_safety_set')[0].body).toEqual({ p_id: 1, p_status: 'followed', p_note: null, p_reply: null });
    await tab.locator('.filter-pill', { hasText: 'Followed up' }).click();
    await expect(r.locator('.sfs-c-followed')).toHaveText('Followed up');
    await r.getByRole('button', { name: 'Note and reply' }).click();
    await r.locator('#sfs-note-1').fill('Called her, brakes checked');
    await r.locator('#sfs-reply-1').fill('Thank you. We checked the bike and the route.');
    await r.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => scalls(db, 'staff_safety_set').length).toBe(2);
    expect(scalls(db, 'staff_safety_set')[1].body).toEqual({ p_id: 1, p_status: null, p_note: 'Called her, brakes checked', p_reply: 'Thank you. We checked the bike and the route.' });
    await expect(r).toContainText('Our reply');
    await r.getByRole('button', { name: 'Back to new' }).click();
    await expect.poll(() => scalls(db, 'staff_safety_set').length).toBe(3);
    expect(scalls(db, 'staff_safety_set')[2].body.p_status).toBe('new');
  });

  test('the bell names a new crash or injury only; the section comes with Bookings', async ({ page }) => {
    const db: StaffDb = { items: [F(1, { kind: 'crash' }), F(2, { kind: 'injury', injury_severity: 'minor' }), F(3, { kind: 'fall' }), F(4, { kind: 'crash', status: 'closed' })], calls: [] };
    await staff(page, db);
    const bell = await page.evaluate(`(()=>{const out=[];_ntOffice((k,items)=>{if(k==='sfy')out.push(...items.map(x=>x.id+':'+x.txt));});return out;})()`);
    expect(bell).toEqual(['1:From Huda Saleh: Crash', '2:From Huda Saleh: Injury']);
    expect(await page.evaluate(`JSON.stringify(_modIds(['queue']))`)).toContain('"safety"');
    expect(await page.evaluate(`_MOD_PARENT.safety`)).toBe('queue');
  });
});

test.describe('@build safety feedback', () => {
  test('rider-safety.js carries every word in eleven languages and is stamped into the page', async ({ page }) => {
    await stubSupabase(page, {});
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`SFY_V`)).toMatch(/^[0-9a-f]{10}$/);
    expect(await page.evaluate(`_sfyLoad()`)).toBe(true);
    const bad = await page.evaluate(`Object.entries(SFR_T).filter(([,r])=>r.length!==11||r.some(w=>!w)).map(([k])=>k)`);
    expect(bad).toEqual([]);
  });
});
