import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The Marketplace, the staff section, first half (MK-S1, 2026-11-20; migration 20261121300000). The user: "add a
// marketplace section in the main website ... i want people to be able to sell products on this page". The website shows
// the listings; here staff look after them: /marketplace under People on the rail, offered only where the database has
// the tables (staff_market_mode), with the views Listings, Held, Reports and Sellers. The views of the second half
// (Shops, Our listings, Commission, Settings, Categories) are wired by name and offered only when their functions are
// there. Every staff function is stubbed here as the contract's section 5 answers it; nothing reaches a database.

const J = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
type Row = Record<string, unknown>;
type Call = { fn: string; body: Row };
type Db = { listings: Row[]; reports: Row[]; sellers: Row[]; threads: Record<number, Row>; events: Row[]; calls: Call[]; mode?: 'full' | 'absent'; on?: boolean; cap?: number; fail?: Record<string, { code: string; message: string; status?: number }> };

const AT = '2099-01-10T09:00:00+00:00';
const NOW = '2099-01-12T10:30:00+00:00';
const CATS = [
  { slug: 'running', parent: null, name_en: 'Running', name_ar: 'الجري', sort: 20 },
  { slug: 'cycling', parent: null, name_en: 'Cycling', name_ar: 'الدراجات الهوائية', sort: 10 },
  { slug: 'swimming', parent: null, name_en: 'Swimming', name_ar: 'السباحة', sort: 30 },
  { slug: 'cycling-bike-road', parent: 'cycling', name_en: 'Road bikes', name_ar: 'دراجات الطريق', sort: 10 },
  { slug: 'cycling-bike-mountain', parent: 'cycling', name_en: 'Mountain bikes', name_ar: 'الدراجات الجبلية', sort: 30 },
  { slug: 'cycling-helmets', parent: 'cycling', name_en: 'Helmets', name_ar: 'الخوذات', sort: 130 },
  { slug: 'running-shoes', parent: 'running', name_en: 'Shoes', name_ar: 'الأحذية', sort: 30 },
  { slug: 'swimming-equipment', parent: 'swimming', name_en: 'Equipment', name_ar: 'المعدات', sort: 10 },
];
const PEOPLE: Record<string, { name: string; phone: string }> = {
  c1: { name: 'Sara Ahmed Ali', phone: '0551234567' }, c2: { name: 'Omar Faruq', phone: '0552223334' }, c3: { name: 'Wadi Owner', phone: '0553334445' },
  c8: { name: 'Bilal Buyer', phone: '0558889990' }, c9: { name: 'Huda Saleh', phone: '0559990001' },
};
const SHOP = { id: 5, owner_id: 'c3', slug: 'wadi-cycles', name_en: 'Wadi Cycles', name_ar: 'وادي للدراجات', cr_no: '4030123456', cr_activity: 'Bicycle retail', vat_no: '300123456700003', city: 'jeddah', status: 'approved', owner_name: 'Wadi Owner', owner_phone: '0553334445', live: 1 };
const PH = (id: number, c: string) => `l${id}/${c.repeat(32)}.jpg`;
const L = (id: number, o: Row = {}): Row => ({
  id, seller_kind: 'private', customer_id: 'c1', shop_id: null, category: 'cycling-bike-road', title: `Listing ${id}`, description: 'Ridden on weekends, serviced last month.', condition: 'good', faults: null,
  price: 1000, negotiable: false, city: 'jeddah', facts: {}, serial: null, declarations: {}, name_mode: 'short', display_name: 'Sara A.', consent_at: AT, photos: [], status: 'live', hold_reason: null,
  published_at: AT, expires_at: '2099-03-11T09:00:00+00:00', sold_at: null, sold_price: null, commission_pct: null, commission_due: null, commission_received: false, commission_received_at: null,
  commission_received_by: null, commission_note: null, checked_at: null, checked_by: null, hidden_reason: null, hidden_at: null, hidden_by: null, deleted_at: null, created_at: AT,
  updated_at: `2099-01-${40 - id}T09:00:00+00:00`, ...o,
});
const listings = (): Row[] => [
  L(11, { title: 'Trek Domane SL 5', price: 6500, negotiable: true, condition: 'excellent', faults: 'A scratch on the top tube.', serial: 'WTU123456789', photos: [PH(11, 'a'), PH(11, 'b'), PH(11, 'c')],
    facts: { brand: 'Trek', model: 'Domane SL 5', year: 2022, frame_size: '54', wheel_size: '700c' } }),
  L(12, { customer_id: 'c2', display_name: 'Omar F.', category: 'running-shoes', title: 'Running shoes', price: 250, city: 'riyadh', status: 'held', hold_reason: 'words', photos: [PH(12, 'd')], facts: { brand: 'Stride', size: '43', for_whom: 'men' } }),
  L(13, { seller_kind: 'shop', customer_id: 'c3', shop_id: 5, name_mode: 'none', display_name: null, category: 'cycling-bike-mountain', title: 'Giant Talon', price: 2100, status: 'held', hold_reason: 'serial', serial: 'WTU123456789' }),
  L(14, { customer_id: 'c2', display_name: null, name_mode: 'none', category: 'cycling-helmets', title: 'Old helmet', price: 90, city: 'dammam', status: 'hidden', hidden_reason: 'This item may not be sold on the Marketplace.', hidden_at: AT, hidden_by: 'Spec Staff' }),
  L(15, { seller_kind: 'company', customer_id: null, name_mode: null, display_name: null, title: 'Fleet road bike', price: 3000, photos: ['/media/market/fleet-1.jpg'] }),
  L(16, { category: 'swimming-equipment', title: 'Swim fins', price: 120, city: 'khobar', status: 'sold', sold_at: AT, sold_price: 100 }),
];
const R = (id: number, o: Row = {}): Row => ({ id, target: 'listing', listing_id: 12, thread_id: null, reporter_id: 'c9', reported_id: 'c2', reason: 'counterfeit', note: null, status: 'open', decided_by: null, decided_at: null, decision_note: null, created_at: `2099-01-1${id}T08:00:00+00:00`, ...o });
const reports = (): Row[] => [
  R(1, { note: 'These are copies.' }),
  R(2, { target: 'thread', listing_id: 11, thread_id: 7, reporter_id: 'c8', reported_id: 'c1', reason: 'abuse', note: 'Rude messages.' }),
  R(3, { listing_id: 14, reason: 'prohibited', status: 'actioned', decided_by: 'Spec Staff', decided_at: AT, decision_note: 'hide: not allowed' }),
];
const SE = (cid: string, o: Row = {}): Row => ({ customer_id: cid, name: PEOPLE[cid].name, phone: PEOPLE[cid].phone, account_created_at: '2025-03-04T10:00:00.000Z', status: 'ok', strikes: 0, staff_note: null, met_by_team: false, met_at: null, met_by: null,
  suspended_at: null, suspended_reason: null, terms_at: AT, established: true, live: 1, sold: 1, reports_open: 0, shop_id: null, shop_name: null, ...o });
const sellers = (): Row[] => [
  SE('c1', { reports_open: 1 }),
  SE('c2', { strikes: 1, staff_note: 'Asked twice about copies.', established: false, live: 0, sold: 0, reports_open: 1 }),
  SE('c3', { status: 'suspended', suspended_at: AT, suspended_reason: 'Unpaid dispute', shop_id: 5, shop_name: 'Wadi Cycles', sold: 0 }),
];
const threads = (): Record<number, Row> => ({
  7: { id: 7, listing_id: 11, listing_title: 'Trek Domane SL 5', buyer: { id: 'c8', ...PEOPLE.c8, shown_as: 'Bilal B.' }, seller: { id: 'c1', ...PEOPLE.c1, shown_as: 'Sara A.' }, buyer_wa_at: null, seller_wa_at: AT, blocked: true, created_at: AT, more: true,
    messages: [{ id: 1, side: 'buyer', body: 'Is it still available?', at: AT }, { id: 2, side: 'seller', body: 'Stop asking.', at: AT }] },
  8: { id: 8, listing_id: 11, listing_title: 'Trek Domane SL 5', buyer: { id: 'c9', ...PEOPLE.c9, shown_as: null }, seller: { id: 'c1', ...PEOPLE.c1, shown_as: 'Sara A.' }, buyer_wa_at: null, seller_wa_at: null, blocked: false, created_at: AT, messages: [] },
});
const events = (): Row[] => [
  { id: 2, at: AT, actor_kind: 'system', actor: null, action: 'hold', listing_id: 12, detail: { reason: 'words' } },
  { id: 1, at: AT, actor_kind: 'customer', actor: 'c1', action: 'publish', listing_id: 11, detail: {} },
];
const fresh = (o: Partial<Db> = {}): Db => ({ listings: listings(), reports: reports(), sellers: sellers(), threads: threads(), events: events(), calls: [], ...o });

// ── The staff functions, as the contract's section 5 answers them ──
const person = (cid: unknown) => PEOPLE[String(cid)] || null;
const repOut = (db: Db, r: Row): Row => {
  const l = db.listings.find((x) => x.id === r.listing_id);
  return { ...r, listing_title: l ? l.title : null, listing_status: l ? l.status : null, reporter_name: person(r.reporter_id)?.name ?? null, reporter_phone: person(r.reporter_id)?.phone ?? null, reported_name: person(r.reported_id)?.name ?? null };
};
const rowOut = (db: Db, x: Row): Row => ({
  id: x.id, title: x.title, price: x.price, status: x.status, hold_reason: x.hold_reason, seller_kind: x.seller_kind, customer_id: x.customer_id, customer_name: person(x.customer_id)?.name ?? null,
  customer_phone: person(x.customer_id)?.phone ?? null, shop_id: x.shop_id, shop_name: x.shop_id ? SHOP.name_en : null, category: x.category, city: x.city, photo: (x.photos as string[])[0] ?? null,
  photos: (x.photos as string[]).length, reports_open: db.reports.filter((r) => r.listing_id === x.id && r.status === 'open').length, checked_at: x.checked_at, published_at: x.published_at, expires_at: x.expires_at, updated_at: x.updated_at,
});
const fullOut = (db: Db, x: Row): Row => {
  const c = CATS.find((k) => k.slug === x.category);
  return { ...x, customer_name: person(x.customer_id)?.name ?? null, customer_phone: person(x.customer_id)?.phone ?? null, display_as: x.seller_kind === 'shop' ? SHOP.name_en : x.seller_kind === 'company' ? 'MicroMobility' : x.display_name,
    seller: db.sellers.find((s) => s.customer_id === x.customer_id) ?? null, shop: x.shop_id ? SHOP : null, category_name_en: c ? c.name_en : null, category_name_ar: c ? c.name_ar : null,
    reports: db.reports.filter((r) => r.listing_id === x.id).map((r) => repOut(db, r)), events: db.events.filter((e) => e.listing_id === x.id), threads: x.id === 11 ? 2 : 0 };
};
async function marketDb(page: Page, db: Db) {
  await page.route(/\/rest\/v1\/rpc\/staff_market_/, async (route: Route) => {
    const fn = /rpc\/(\w+)/.exec(route.request().url())![1];
    let body: Row = {};
    try { body = (route.request().postDataJSON() as Row) || {}; } catch { /* none */ }
    db.calls.push({ fn, body });
    const ok = (v: unknown) => route.fulfill({ status: 200, headers: J, body: JSON.stringify(v) });
    const no = (message: string, code = 'P0001', status = 400) => route.fulfill({ status, headers: J, body: JSON.stringify({ code, message, details: null, hint: null }) });
    const f = db.fail && db.fail[fn];
    if (f) return no(f.message, f.code, f.status);
    const ev = (o: Row) => db.events.unshift({ id: db.events.length + 1, at: NOW, actor_kind: 'staff', actor: 'Spec Staff', detail: {}, ...o });
    const hay = (...v: unknown[]) => v.filter(Boolean).join(' ').toLowerCase();
    if (fn === 'staff_market_mode') return db.mode === 'absent' ? no('Could not find the function public.staff_market_mode without parameters in the schema cache', 'PGRST202', 404) : ok('full');
    if (fn === 'staff_market_counts') return ok({ on: db.on === true, held: db.listings.filter((x) => x.status === 'held').length, reports: db.reports.filter((r) => r.status === 'open').length, shops_pending: 2, commission_due: 1, live: db.listings.filter((x) => x.status === 'live').length });
    if (fn === 'staff_market_listings') {
      const p = (body.p || {}) as Row, st = String(p.status ?? 'live'), q = String(p.q || '').toLowerCase();
      const all = db.listings.filter((x) => (st === 'all' || x.status === st) && (!p.kind || x.seller_kind === p.kind)
        && (!q || hay(x.title, x.id, x.serial, person(x.customer_id)?.name, person(x.customer_id)?.phone).includes(q)))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      const off = Number(p.offset) || 0, lim = Math.min(Number(p.limit) || 100, db.cap || 200);
      return ok({ items: all.slice(off, off + lim).map((x) => rowOut(db, x)), total: all.length });
    }
    if (fn === 'staff_market_listing_get') { const x = db.listings.find((l) => l.id === body.p_listing); return ok(x ? fullOut(db, x) : null); }
    if (fn === 'staff_market_listing_set') {
      const x = db.listings.find((l) => l.id === body.p_listing), a = String(body.p_action), note = body.p_note == null ? '' : String(body.p_note);
      if (!x) return no('MKT_GONE');
      if (a === 'hide') {
        if (note.length < 3 || note.length > 300) return no('BAD_INPUT', '22023');
        if (['draft', 'deleted', 'hidden'].includes(String(x.status))) return no('MKT_STATE');
        Object.assign(x, { status: 'hidden', hidden_reason: note, hidden_at: NOW, hidden_by: 'Spec Staff' });
      } else if (a === 'restore') { if (x.status !== 'hidden') return no('MKT_STATE'); Object.assign(x, { status: 'live', hidden_reason: null, hidden_at: null, hidden_by: null }); }
      else if (a === 'release') { if (x.status !== 'held') return no('MKT_STATE'); Object.assign(x, { status: 'live', hold_reason: null }); }
      else if (a === 'check') Object.assign(x, { checked_at: NOW, checked_by: 'Spec Staff' });
      else if (a === 'uncheck') Object.assign(x, { checked_at: null, checked_by: null });
      else return no('BAD_INPUT', '22023');
      ev({ action: a, listing_id: x.id, detail: note ? { reason: note } : {} });
      return ok({ listing: fullOut(db, x) });
    }
    if (fn === 'staff_market_reports') { const items = db.reports.filter((r) => !body.p_status || r.status === body.p_status).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((r) => repOut(db, r)); return ok({ items, total: items.length }); }
    if (fn === 'staff_market_report_set') {
      const r = db.reports.find((x) => x.id === body.p_report), a = String(body.p_action);
      if (!r) return no('MKT_GONE');
      if (!['actioned', 'dismissed', 'open'].includes(a)) return no('BAD_INPUT', '22023');
      Object.assign(r, a === 'open' ? { status: 'open', decided_by: null, decided_at: null, decision_note: null } : { status: a, decided_by: 'Spec Staff', decided_at: NOW, decision_note: body.p_note ?? null });
      return ok({ report: repOut(db, r) });
    }
    if (fn === 'staff_market_thread') { const id = Number(body.p_thread); return db.reports.some((r) => r.thread_id === id) && db.threads[id] ? ok(db.threads[id]) : no('FORBIDDEN', '42501', 403); }
    if (fn === 'staff_market_sellers') {
      const p = (body.p || {}) as Row, st = String(p.status ?? 'all'), q = String(p.q || '').toLowerCase();
      const all = db.sellers.filter((s) => (st === 'all' || s.status === st) && (!q || hay(s.name, s.phone, s.customer_id).includes(q)));
      return ok({ items: all.slice(Number(p.offset) || 0, (Number(p.offset) || 0) + (Number(p.limit) || 100)), total: all.length });
    }
    if (fn === 'staff_market_seller_set') {
      const s = db.sellers.find((x) => x.customer_id === body.p_customer), a = String(body.p_action), note = body.p_note == null ? '' : String(body.p_note);
      if (!s) return no('MKT_GONE');
      const reason = () => note.length >= 3 && note.length <= 300;
      if (a === 'note') s.staff_note = body.p_note ?? null;
      else if (a === 'strike') { if (!reason()) return no('BAD_INPUT', '22023'); s.strikes = Number(s.strikes) + 1; }
      else if (a === 'unstrike') s.strikes = Math.max(0, Number(s.strikes) - 1);
      else if (a === 'suspend') { if (!reason()) return no('BAD_INPUT', '22023'); Object.assign(s, { status: 'suspended', suspended_at: NOW, suspended_reason: note }); }
      else if (a === 'restore') Object.assign(s, { status: 'ok', suspended_at: null, suspended_reason: null });
      else if (a === 'met') Object.assign(s, { met_by_team: true, met_at: '2099-01-12', met_by: 'Spec Staff' });
      else if (a === 'unmet') Object.assign(s, { met_by_team: false, met_at: null, met_by: null });
      else return no('BAD_INPUT', '22023');
      return ok({ seller: s });
    }
    return ok(null);
  });
  // a seller's photo is an object of the market bucket: the small copy of listing 11's second photo is not there
  await page.route(/\/storage\/v1\/object\/public\/market\//, (route) => (route.request().url().includes(`${'b'.repeat(32)}.w480.`)
    ? route.fulfill({ status: 404, headers: J, body: '{}' }) : route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' }, body: PNG })));
  await page.route(/^https:\/\/micromobility\.sa\/media\/market\//, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG }));
}
const calls = (db: Db, fn: string) => db.calls.filter((c) => c.fn === fn).map((c) => c.body);
const last = (db: Db, fn: string) => calls(db, fn).at(-1);
async function staff(page: Page, db: Db, path = '/marketplace', fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [], site_content: [], market_categories: CATS, ...fx });
  await marketDb(page, db);
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
  if (db.mode === 'absent') { await page.waitForFunction(`S._mkMode===false`); return; }
  await page.waitForFunction(`S.view==='staff'&&S.staffTab==='market'`);
  await expect(sec(page).locator('.mk-views')).toBeVisible();
}
const sec = (page: Page) => page.locator('#tab-market');
const pop = (page: Page) => page.locator('#mk-modal [role="dialog"]');
const view = (page: Page, k: string) => sec(page).locator(`.mk-views .filter-pill[data-mkv="${k}"]`);
const lrow = (page: Page, id: number) => sec(page).locator(`.mk-row[data-lid="${id}"]`);
const rep = (page: Page, id: number) => sec(page).locator(`.mk-rep[data-rid="${id}"]`);
const sel = (page: Page, cid: string) => sec(page).locator(`.mk-sel[data-cid="${cid}"]`);
const kv = (page: Page, label: string) => pop(page).locator('.mk-kv').filter({ has: page.locator('span', { hasText: new RegExp(`^${label}$`) }) }).first();
const logged = (page: Page) => page.evaluate(`S.fullLog.map(l=>l.label)`) as Promise<string[]>;
async function search(page: Page, key: string, text: string) {
  const q = sec(page).locator(`#${key}-q`);
  if (!(await q.isVisible())) await sec(page).locator(`[data-srch="${key}"] .srch-btn`).click(); // a phone folds the search into a button
  await q.fill(text);
}
/** The pop-up sits in the middle of the screen, whatever its width (no bottom sheet). */
async function centred(page: Page) {
  const off = async () => { const b = (await pop(page).boundingBox())!, v = page.viewportSize()!; return Math.max(Math.abs(b.x + b.width / 2 - v.width / 2), Math.abs(b.y + b.height / 2 - v.height / 2)); };
  await expect.poll(off).toBeLessThanOrEqual(3); // once it has slid in
}

test.describe('@staff:market the section', () => {
  test('a database without the tables has no Marketplace: not on the rail, not among the sections, and its address opens elsewhere', async ({ page }) => {
    const db = fresh({ mode: 'absent' });
    await staff(page, db);
    expect(calls(db, 'staff_market_mode')).toHaveLength(1);
    expect(await page.evaluate(`getComputedStyle(document.querySelector('#staff-tab-nav .tab-btn[data-stab="market"]')).display`)).toBe('none');
    expect(await page.evaluate(`[_staffSections().includes('market'),_roleTabs('manager').includes('market'),_deskTabOk('market'),S.staffTab==='market']`)).toEqual([false, false, false, false]);
    expect(new URL(page.url()).pathname).not.toBe('/marketplace');
    expect(calls(db, 'staff_market_counts')).toHaveLength(0);
    expect(calls(db, 'staff_market_listings')).toHaveLength(0);
    // asked once a page: another paint of the rail does not ask again
    await page.evaluate(`renderStaffTabs()`);
    expect(calls(db, 'staff_market_mode')).toHaveLength(1);
  });

  test('under People after Testimonials, at /marketplace, with what waits for the team on the rail; its right comes with People', async ({ page }) => {
    const db = fresh();
    await staff(page, db);
    expect(new URL(page.url()).pathname).toBe('/marketplace');
    const order = await page.locator('#staff-tab-nav .tab-btn[data-stab]').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.stab));
    expect(order.indexOf('market')).toBe(order.indexOf('testimonials') + 1);
    // 2 held + 2 open reports + 2 shops waiting
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="market"] .tab-badge')).toHaveText('6');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="market"] .tab-badge')).toHaveAttribute('title', '6 waiting for the team');
    await expect(sec(page).locator('h1')).toHaveText('Marketplace');
    await expect(sec(page).locator('.mk-open')).toHaveCount(0); // the public page is linked only while the website shows it
    expect(await page.evaluate(`JSON.stringify(S._mkCounts)`)).toBe('{"on":false,"held":2,"reports":2,"shops_pending":2,"commission_due":1,"live":2}');
    expect(calls(db, 'staff_market_mode')).toHaveLength(1);
    // derived from People: never sent to staff_set_access, opened by the roles that open People
    expect(await page.evaluate(`JSON.stringify(_modIds(['community']))`)).toContain('"market"');
    expect(await page.evaluate(`JSON.stringify(_modSend(['community','market','queue']))`)).toBe('["community","queue"]');
    expect(await page.evaluate(`['admin','manager','owner','frontdesk','leader','mechanic','cashier'].map(r=>_roleTabs(r).includes('market'))`)).toEqual([true, true, true, false, false, false, false]);
    expect(await page.evaluate(`[STAFF_PATHS.market,SECTION_KEY.market,_MOD_PARENT.market,STAFF_PART_TABS.market.join()]`)).toEqual(['marketplace', 'mkTitle', 'community', 'market']);
    // the views of this half, Listings first; the others are not offered while their functions are not there
    await expect(sec(page).locator('.mk-views .filter-pill')).toHaveText([/^Listings$/, /^Held\s*2$/, /^Reports\s*2$/, /^Sellers$/].concat(await page.evaluate(`typeof _mkShopsHtml`) === 'function' ? [/^Shops/, /^Our listings/, /^Commission/, /^Settings/, /^Categories/] : []));
  });

  test('a view has its own address; an address that names none, or a view that is not there, opens Listings', async ({ page }) => {
    const db = fresh();
    await staff(page, db, '/marketplace/reports');
    await expect(view(page, 'reports')).toHaveAttribute('aria-pressed', 'true');
    await expect(sec(page).locator('.mk-rep')).toHaveCount(2);
    await view(page, 'held').click();
    expect(new URL(page.url()).pathname).toBe('/marketplace/held');
    await view(page, 'sellers').click();
    expect(new URL(page.url()).pathname).toBe('/marketplace/sellers');
    await view(page, 'listings').click();
    expect(new URL(page.url()).pathname).toBe('/marketplace');
    await page.goBack();
    await expect(view(page, 'sellers')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(`JSON.stringify(SUB_PATHS.market)`)).toBe('{"listings":"","held":"held","reports":"reports","sellers":"sellers","shops":"shops","ours":"our-listings","commission":"commission","settings":"settings","cats":"categories"}');
    await page.evaluate(`_setSub('market','nope');renderMarket()`);
    await expect(view(page, 'listings')).toHaveAttribute('aria-pressed', 'true');
    // Ctrl K opens the views too, as it does every section's
    expect(await page.evaluate(`_n6tCmds().filter(c=>c.sub&&c.go[2]==='market').map(c=>c.l)`)).toEqual(expect.arrayContaining(['Marketplace › Held', 'Marketplace › Reports', 'Marketplace › Sellers']));
    await page.evaluate(`_n6tCmd('sub','market','sellers')`);
    await expect(view(page, 'sellers')).toHaveAttribute('aria-pressed', 'true');
    expect(new URL(page.url()).pathname).toBe('/marketplace/sellers');
    await view(page, 'listings').click();
    // the switch on: the head links the public page
    db.on = true;
    await page.evaluate(`_mkCount(true)`);
    await expect(sec(page).locator('.mk-open')).toHaveAttribute('href', 'https://micromobility.sa/marketplace');
    await expect(sec(page).locator('.mk-open')).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('the probe: no count for an account that cannot open the section; a refusal sent before the session was confirmed is no answer; an answer that came late leaves the page where the staffer is', async ({ page }) => {
    const db = fresh();
    await staff(page, db);
    const modes = () => calls(db, 'staff_market_mode').length;
    // the page as it is before the database has answered
    const unasked = (pre = '') => page.evaluate(`(()=>{${pre}S._mkMode=undefined;S._mkProbeAt=0;S._mkCAt=0;S._mkCounts=null;S._mkN=0;})()`);
    // Front Desk: the database has the Marketplace, this account does not open it, so nothing is counted for it
    await page.evaluate(`setStaffRole('frontdesk')`);
    await unasked();
    const counts = calls(db, 'staff_market_counts').length;
    await page.evaluate(`renderStaffTabs()`);
    await page.waitForFunction(`S._mkMode==='full'&&!S._mkProbing`);
    expect(await page.evaluate(`[_deskTabOk('market'),!!S._mkCAt]`)).toEqual([false, false]); // _mkCount stamps S._mkCAt the moment it asks
    expect(calls(db, 'staff_market_counts')).toHaveLength(counts);
    // ... and the rail asks once the account can open it
    await page.evaluate(`setStaffRole('manager');renderStaffTabs()`);
    await expect.poll(() => calls(db, 'staff_market_counts').length).toBe(counts + 1);
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="market"] .tab-badge')).toHaveText('6');
    await page.evaluate(`setStaffRole('admin');setStaffTab('queue')`);
    // asked for by the address over a minute ago (the first ask got no answer): the answer no longer moves the page
    await unasked(`S._mkWant=Date.now()-61e3;`);
    await page.evaluate(`renderStaffTabs()`);
    await page.waitForFunction(`S._mkMode==='full'&&!S._mkProbing`);
    expect(await page.evaluate(`[S.staffTab,S._mkWant]`)).toEqual(['queue', null]);
    // asked for a moment ago: not there yet, then opened once the database says it has it
    await unasked();
    expect(await page.evaluate(`(()=>{setStaffTab('market');return[S.staffTab==='market',typeof S._mkWant];})()`)).toEqual([false, 'number']);
    await page.waitForFunction(`S._mkMode==='full'&&S.staffTab==='market'`);
    // a permission refusal that answers an ask sent before the staff session was confirmed is not "no Marketplace":
    // not asked again within the minute while still unconfirmed, asked at once when the session is confirmed
    await page.evaluate(`setStaffTab('queue')`);
    const authed = await page.evaluate(`S._staffAuthed===true`);
    db.fail = { staff_market_mode: { code: '42501', message: 'permission denied for function staff_market_mode', status: 403 } };
    await unasked(`S._staffAuthed=false;`);
    let n = modes();
    await page.evaluate(`renderStaffTabs()`);
    await expect.poll(modes).toBe(n + 1);
    await page.waitForFunction(`!S._mkProbing`);
    expect(await page.evaluate(`(()=>{renderStaffTabs();return[S._mkMode===undefined,S._mkProbing];})()`)).toEqual([true, false]); // no answer, and not asked again
    db.fail = undefined;
    await page.evaluate(`S._staffAuthed=true;renderStaffTabs()`);
    await page.waitForFunction(`S._mkMode==='full'&&!S._mkProbing`);
    expect(modes()).toBe(n + 2);
    // the same refusal to a confirmed session is an answer: no Marketplace for this page, and not asked again
    db.fail = { staff_market_mode: { code: '42501', message: 'FORBIDDEN', status: 403 } };
    await unasked();
    n = modes();
    await page.evaluate(`renderStaffTabs()`);
    await page.waitForFunction(`S._mkMode===false`);
    expect(await page.evaluate(`(()=>{renderStaffTabs();return[_deskTabOk('market'),!!S._mkProbing];})()`)).toEqual([false, false]);
    expect(modes()).toBe(n + 1);
    await page.evaluate(`S._staffAuthed=${authed}`);
  });
});

test.describe('@staff:market Listings', () => {
  test('every listing, searched by the database, with Filters holding status, seller type, sport and city', async ({ page }) => {
    const db = fresh();
    await staff(page, db);
    expect(calls(db, 'staff_market_listings')[0]).toEqual({ p: { status: 'all', limit: 100, offset: 0 } });
    await expect(sec(page).locator('.mk-row')).toHaveCount(6);
    await expect(sec(page).locator('.mk-count')).toHaveText('Listings: 6');
    // a row: the title, its number, product type and city, who sells and how, the price, the state
    const r11 = lrow(page, 11);
    await expect(r11.locator('.mk-r-main')).toContainText('Trek Domane SL 5');
    await expect(r11.locator('.mk-r-main')).toContainText('#11 · Road bikes · Jeddah');
    await expect(r11.locator('.mk-r-main b')).toHaveAttribute('dir', 'auto');
    await expect(r11.locator('.mk-r-who')).toContainText('Sara Ahmed Ali');
    await expect(r11.locator('.mk-r-who')).toContainText('Private seller · 0551234567');
    await expect(r11.locator('.mk-r-amt')).toHaveText('SAR 6,500');
    await expect(r11.locator('.mk-pill')).toHaveText('On sale');
    await expect(r11.locator('img.mk-th')).toHaveAttribute('src', new RegExp(`/storage/v1/object/public/market/l11/a{32}\\.w480\\.jpg$`));
    await expect(lrow(page, 12).locator('.mk-r-tags')).toContainText('Held');
    await expect(lrow(page, 12).locator('.mk-r-tags')).toContainText('Blocked words');
    await expect(lrow(page, 12).locator('.mk-r-tags')).toContainText('Open reports: 1');
    await expect(lrow(page, 13).locator('.mk-r-who')).toContainText('Wadi Cycles');
    await expect(lrow(page, 13).locator('.mk-r-who')).toContainText('Shop');
    await expect(lrow(page, 15).locator('.mk-r-who')).toHaveText('MicroMobility');
    await expect(lrow(page, 15).locator('img.mk-th')).toHaveAttribute('src', 'https://micromobility.sa/media/market/fleet-1.jpg?w=480');
    await expect(lrow(page, 16).locator('.mk-th-no')).toHaveCount(1); // no photo: a drawn mark, never a broken picture
    // the search is the database's (title, number, serial, the seller's name or phone)
    await search(page, 'mkl', 'trek');
    await expect.poll(() => last(db, 'staff_market_listings')).toEqual({ p: { status: 'all', limit: 100, offset: 0, q: 'trek' } });
    await expect(sec(page).locator('.mk-row')).toHaveCount(1);
    await expect(sec(page).locator('#mkl-q')).toBeFocused();
    await search(page, 'mkl', 'zzz');
    await expect(sec(page).locator('#mk-list')).toContainText('Nothing matches.');
    await search(page, 'mkl', '');
    await expect(sec(page).locator('.mk-row')).toHaveCount(6);
    // Filters: one button, four lists
    const fb = sec(page).locator('[aria-controls="fm-mkl"]');
    await fb.click();
    const f = (name: string) => sec(page).locator(`#fm-mkl select[aria-label="${name}"]`);
    await expect(sec(page).locator('#fm-mkl select')).toHaveCount(4);
    await expect(f('Status').locator('option')).toHaveText(['All', 'Draft', 'On sale', 'Held', 'Reserved', 'Sold', 'Expired', 'Hidden', 'Deleted']);
    await expect(f('Seller type').locator('option')).toHaveText(['All', 'Private seller', 'Shop', 'MicroMobility']);
    await expect(f('Sport').locator('option')).toHaveText(['All', 'Cycling', 'Running', 'Swimming']); // the sports of market_categories, in their order
    await expect(f('City').locator('option')).toHaveCount(32);
    await f('Status').selectOption('held');
    await expect.poll(() => last(db, 'staff_market_listings')).toEqual({ p: { status: 'held', limit: 100, offset: 0 } });
    await expect(sec(page).locator('.mk-row')).toHaveCount(2);
    await expect(fb).toContainText('(1)');
    await f('Seller type').selectOption('shop');
    await expect.poll(() => last(db, 'staff_market_listings')).toEqual({ p: { status: 'held', limit: 100, offset: 0, kind: 'shop' } });
    await expect(sec(page).locator('.mk-row')).toHaveCount(1);
    await expect(fb).toContainText('(2)');
    await sec(page).locator('.f-clr[data-f-clr="mkl"]').click();
    await expect(sec(page).locator('.mk-row')).toHaveCount(6);
    // the sport and the city go to the database and are applied to the rows that came
    await f('Sport').selectOption('cycling');
    await expect.poll(() => last(db, 'staff_market_listings')).toEqual({ p: { status: 'all', limit: 200, offset: 0, sport: 'cycling' } });
    await expect(sec(page).locator('.mk-row')).toHaveCount(4);
    await expect(sec(page).locator('.mk-count')).toHaveText('Listings: 4');
    await f('City').selectOption('jeddah');
    await expect.poll(() => last(db, 'staff_market_listings')).toEqual({ p: { status: 'all', limit: 200, offset: 0, sport: 'cycling', city: 'jeddah' } });
    await expect(sec(page).locator('.mk-row')).toHaveCount(3);
    await expect(fb).toContainText('(2)');
  });

  test('more than a page: Show more reads the next rows', async ({ page }) => {
    const db = fresh({ cap: 4 });
    await staff(page, db);
    await expect(sec(page).locator('.mk-row')).toHaveCount(4);
    await expect(sec(page).locator('.mk-count')).toHaveText('Listings: 6');
    // a Show more that could not be read says so, and the rows read so far stay
    db.fail = { staff_market_listings: { code: 'XX000', message: 'spec: no answer' } };
    await sec(page).locator('.mk-more button').click();
    await expect(page.locator('.toast', { hasText: 'Connection error. Check your network.' })).toHaveCount(1);
    await expect(sec(page).locator('.mk-row')).toHaveCount(4);
    await expect(sec(page).locator('.mk-more button')).toBeEnabled();
    db.fail = undefined;
    await sec(page).locator('.mk-more button').click();
    await expect(sec(page).locator('.mk-row')).toHaveCount(6);
    expect(last(db, 'staff_market_listings')).toEqual({ p: { status: 'all', limit: 100, offset: 4 } });
    await expect(sec(page).locator('.mk-more')).toHaveCount(0);
    // a search that could not be read shows the error with its retry, never the rows of the question before
    db.fail = { staff_market_listings: { code: 'XX000', message: 'spec: no answer' } };
    await search(page, 'mkl', 'trek');
    await expect(sec(page).locator('#mk-list .es-err')).toContainText('Connection error. Check your network.');
    await expect(sec(page).locator('.mk-row')).toHaveCount(0);
    db.fail = undefined;
    await sec(page).locator('#mk-list .es-err button', { hasText: 'Try again' }).click();
    await expect(sec(page).locator('.mk-row')).toHaveCount(1);
    await expect(lrow(page, 11)).toHaveCount(1);
    // the same question read again and not answered (the minute's refresh, the read after a write) keeps its rows
    db.fail = { staff_market_listings: { code: 'XX000', message: 'spec: no answer' } };
    await page.evaluate(`_mkListLoad(true)`);
    await expect(lrow(page, 11)).toHaveCount(1);
    await expect(sec(page).locator('#mk-list .es-err')).toHaveCount(0);
  });

  test('a listing\'s history is in the desk\'s words: why it was held and the word found, a report and its decision, a conversation read, WhatsApp shared, a block; "Another city" in the language on screen', async ({ page }) => {
    const db = fresh();
    db.listings.find((x) => x.id === 12)!.city = 'other';
    const e = (id: number, actor_kind: string, actor: string | null, action: string, detail: Row = {}): Row => ({ id, at: AT, actor_kind, actor, action, listing_id: 12, detail });
    db.events = [
      e(9, 'customer', 'c9', 'unblock'), e(8, 'customer', 'c9', 'block'), e(7, 'customer', 'c2', 'wa_share'), e(6, 'staff', 'Spec Staff', 'thread_read'),
      e(5, 'staff', 'Spec Staff', 'report_set', { status: 'dismissed', note: 'Looked at the photos.' }), e(4, 'customer', 'c9', 'report', { target: 'listing', reason: 'counterfeit' }),
      e(3, 'system', null, 'hold', { title: 'Running shoes', reason: 'words', word: 'first copy', on: 'publish' }), e(2, 'staff', 'Spec Staff', 'hold', { reason: 'staff', on: 'suspend' }),
      e(1, 'system', null, 'a_later_action'),
    ];
    await staff(page, db);
    await expect(lrow(page, 12).locator('.mk-r-main')).toContainText('#12 · Shoes · Another city');
    await lrow(page, 12).locator('.mk-row-open').click();
    await expect(kv(page, 'City')).toContainText('Another city');
    // the database keeps codes (words, staff, counterfeit, dismissed, thread_read ...): the desk reads words
    await expect(pop(page).locator('.mk-sec', { hasText: 'History' }).locator('li')).toHaveText([
      /Block lifted\s*· Customer$/, /One blocked the other\s*· Customer$/, /Shared WhatsApp\s*· Customer$/, /Conversation read\s*· Spec Staff$/,
      /Report decided\s*· Spec Staff\s*Dismissed · Looked at the photos\.$/, /Reported\s*· Customer\s*Counterfeit$/,
      /Held\s*· System\s*Blocked words: first copy$/, /Held\s*· Spec Staff\s*Seller suspended$/,
      /a_later_action\s*· System$/, // an action the database adds later shows as written until it is named here
    ]);
    await pop(page).locator('.mk-x').click();
    // in a language the cities have no names in, "Another city" is still said in it; so are the history's words
    await page.evaluate(`setLang('fr')`);
    await expect(lrow(page, 12).locator('.mk-r-main')).toContainText('Autre ville');
    await lrow(page, 12).locator('.mk-row-open').click();
    await expect(kv(page, 'Ville')).toContainText('Autre ville');
    await expect(pop(page).locator('.mk-tl li', { hasText: 'Conversation lue' })).toHaveCount(1);
    await expect(pop(page).locator('.mk-tl li', { hasText: 'Blocage levé' })).toHaveCount(1);
    await expect(pop(page).locator('.mk-tl li', { hasText: 'Mots bloqués: first copy' })).toHaveCount(1);
  });

  test('a listing opens in a centred pop-up: its photos, facts, the whole serial number, the seller as staff see them, reports and history', async ({ page }) => {
    const db = fresh();
    await staff(page, db);
    expect(calls(db, 'staff_market_listing_get')).toHaveLength(0);
    await lrow(page, 11).locator('.mk-row-open').click();
    await expect(pop(page).locator('#mk-pop-t')).toContainText('Trek Domane SL 5');
    expect(calls(db, 'staff_market_listing_get')).toEqual([{ p_listing: 11 }]);
    await expect(pop(page)).toHaveAttribute('aria-modal', 'true');
    await expect(pop(page)).toHaveAttribute('aria-labelledby', 'mk-pop-t');
    await centred(page);
    // photos: the first one large, each a button; a small copy that is missing shows the full one
    await expect(pop(page).locator('.mk-gal-main img')).toHaveAttribute('src', new RegExp(`/market/l11/a{32}\\.jpg$`));
    await expect(pop(page).locator('.mk-gal-b')).toHaveCount(3);
    await expect(pop(page).locator('.mk-gal-b').nth(1).locator('img')).toHaveAttribute('src', new RegExp(`/market/l11/b{32}\\.jpg$`));
    await pop(page).locator('.mk-gal-b').nth(2).click();
    await expect(pop(page).locator('.mk-gal-main img')).toHaveAttribute('src', new RegExp(`/market/l11/c{32}\\.jpg$`));
    await expect(pop(page).locator('.mk-gal-b').nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(pop(page).locator('.mk-gal-b').nth(2)).toBeFocused(); // the photo picked keeps the focus through the redraw
    // ... and the pop-up, drawn again, does not make its entrance a second time
    expect(await page.evaluate(`(()=>{const b=document.querySelector('#mk-modal .modal-backdrop');return[b.classList.contains('mk-still'),getComputedStyle(b).animationName,getComputedStyle(b.firstElementChild).animationName];})()`)).toEqual([true, 'none', 'none']);
    // facts
    await expect(kv(page, 'Price')).toContainText('SAR 6,500 · Negotiable');
    await expect(kv(page, 'Condition')).toContainText('Excellent');
    await expect(kv(page, 'Category')).toContainText('Road bikes');
    await expect(kv(page, 'City')).toContainText('Jeddah');
    await expect(kv(page, 'Brand')).toContainText('Trek');
    await expect(kv(page, 'Frame size')).toContainText('54');
    await expect(kv(page, 'Wheel size')).toContainText('700c');
    await expect(kv(page, 'Frame or serial number').locator('b')).toHaveText('WTU123456789'); // whole: buyers see the last three only
    await expect(kv(page, 'Buyers see')).toContainText('Sara A.');
    await expect(kv(page, 'Conversations')).toContainText('2');
    await expect(pop(page).locator('.mk-sec', { hasText: 'Description' }).locator('p')).toHaveAttribute('dir', 'auto');
    await expect(pop(page).locator('.mk-sec', { hasText: 'Known faults' })).toContainText('A scratch on the top tube.');
    // the seller's account as staff see it
    await expect(kv(page, 'Account').locator('.mk-who')).toHaveText('Sara Ahmed Ali');
    await expect(kv(page, 'Account').locator('.mk-who')).toHaveAttribute('dir', 'auto'); // a name in the other alphabet keeps its own order
    await expect(kv(page, 'Phone')).toContainText('0551234567');
    await expect(kv(page, 'Strikes')).toContainText('0');
    await expect(kv(page, 'Status').locator('.mk-pill')).toHaveText('Active');
    // reports on it, and what happened to it
    await expect(pop(page).locator('.mk-sec', { hasText: 'Reports' }).locator('li')).toContainText(['Abuse']);
    await expect(pop(page).locator('.mk-sec', { hasText: 'History' }).locator('li')).toContainText(['Published']);
    await expect(pop(page).locator('.mk-sec', { hasText: 'History' }).locator('li')).toContainText(['Customer']);
    // Escape closes it, and the focus goes back to the row
    await page.keyboard.press('Escape');
    await expect(pop(page)).toHaveCount(0);
    // a shop's listing names the shop and its registration; MicroMobility's own says so; a listing that is gone says so
    await lrow(page, 13).locator('.mk-row-open').click();
    await expect(kv(page, 'Shop')).toContainText('Wadi Cycles');
    await expect(kv(page, 'Commercial registration')).toContainText('4030123456');
    await expect(kv(page, 'VAT number')).toContainText('300123456700003');
    await expect(kv(page, 'Status').locator('.mk-pill')).toHaveText('Suspended');
    await pop(page).locator('.mk-x').click();
    await lrow(page, 15).locator('.mk-row-open').click();
    await expect(pop(page)).toContainText("MicroMobility's own listing.");
    await expect(pop(page).locator('.mk-gal-main img')).toHaveAttribute('src', 'https://micromobility.sa/media/market/fleet-1.jpg');
    await pop(page).locator('.mk-x').click();
    await page.evaluate(`_mkOpen(999)`);
    await expect(pop(page)).toContainText('This no longer exists.');
    // Open in Sellers: that account, in the Sellers view
    await pop(page).locator('.mk-x').click();
    await lrow(page, 11).locator('.mk-row-open').click();
    await pop(page).locator('button', { hasText: 'Open in Sellers' }).click();
    await expect(pop(page)).toHaveCount(0);
    await expect(view(page, 'sellers')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => last(db, 'staff_market_sellers')).toEqual({ p: { status: 'all', limit: 100, offset: 0, q: 'c1' } });
    await expect(sec(page).locator('.mk-sel')).toHaveCount(1);
  });

  test('Mark checked and Unmark, Hide with a reason picked and a note, Restore: each one call, logged, and undone from the top bar', async ({ page }) => {
    const db = fresh();
    await staff(page, db);
    await lrow(page, 11).locator('.mk-row-open').click();
    const act = (name: string | RegExp) => pop(page).locator('.mk-pop-a button', { hasText: name });
    await expect(pop(page).locator('.mk-pop-a button')).toHaveText(['Mark checked by our team', 'Hide']);
    await act('Mark checked by our team').click();
    await expect.poll(() => calls(db, 'staff_market_listing_set')).toEqual([{ p_listing: 11, p_action: 'check', p_note: null }]);
    await expect(pop(page).locator('.mk-tags')).toContainText('Checked by our team');
    await expect(kv(page, 'Checked by our team')).toContainText('Spec Staff');
    await expect(lrow(page, 11).locator('.mk-r-tags')).toContainText('Checked by our team');
    await expect(page.locator('.toast', { hasText: 'Marketplace: listing #11 Trek Domane SL 5 marked checked by our team' })).toHaveCount(1);
    await expect.poll(() => logged(page)).toContain('Marketplace: listing #11 Trek Domane SL 5 marked checked by our team');
    // Undo takes the mark back
    await page.evaluate(`doUndo()`);
    await expect.poll(() => last(db, 'staff_market_listing_set')).toEqual({ p_listing: 11, p_action: 'uncheck', p_note: null });
    await expect(pop(page).locator('.mk-tags')).not.toContainText('Checked by our team');
    await act('Mark checked by our team').click();
    await act('Remove the checked mark').click();
    await expect.poll(() => last(db, 'staff_market_listing_set')).toEqual({ p_listing: 11, p_action: 'uncheck', p_note: null });
    await expect.poll(() => logged(page)).toContain('Marketplace: checked mark removed from listing #11 Trek Domane SL 5');
    // Hide: a reason must be picked; Other needs the note
    const n = calls(db, 'staff_market_listing_set').length;
    await act(/^Hide$/).click();
    await expect(pop(page).locator('#mk-why')).toBeFocused();
    await expect(pop(page).locator('#mk-why option')).toHaveText(['Choose a reason', 'Item not allowed', 'Counterfeit', 'Ownership not confirmed', 'Misleading description', 'Against the rules', 'Duplicate listing', 'Link or phone number in the text', 'Other']);
    await centred(page);
    await pop(page).locator('.mk-form button', { hasText: 'Hide listing' }).click();
    await expect(pop(page).locator('.mk-bad')).toHaveText('Choose a reason.');
    await pop(page).locator('#mk-why').selectOption('other');
    await pop(page).locator('#mk-note').fill('x');
    await pop(page).locator('.mk-form button', { hasText: 'Hide listing' }).click();
    await expect(pop(page).locator('.mk-bad')).toHaveText('Write at least 3 characters.');
    expect(calls(db, 'staff_market_listing_set')).toHaveLength(n);
    // the seller reads the reason in English and Arabic, then the note
    await pop(page).locator('#mk-why').selectOption('fake');
    await pop(page).locator('#mk-note').fill('Seen on another site.');
    await pop(page).locator('.mk-form button', { hasText: 'Hide listing' }).click();
    await expect.poll(() => last(db, 'staff_market_listing_set')).toEqual({ p_listing: 11, p_action: 'hide', p_note: 'Counterfeit or copied items are not allowed. لا يُسمح بالمنتجات المقلدة أو المنسوخة. Seen on another site.' });
    await expect(pop(page).locator('.mk-form')).toHaveCount(0);
    await expect(pop(page).locator('.mk-tags .mk-pill')).toHaveText('Hidden');
    await expect(kv(page, 'Reason')).toContainText('Seen on another site.');
    await expect(lrow(page, 11).locator('.mk-pill')).toHaveText('Hidden');
    await expect.poll(() => logged(page)).toContain('Marketplace: listing #11 Trek Domane SL 5 hidden');
    expect(await page.evaluate(`S.undoStack.at(-1).label`)).toBe('Marketplace: listing #11 Trek Domane SL 5 hidden'); // it was on sale: Undo is Restore
    await expect(pop(page).locator('.mk-sec', { hasText: 'History' }).locator('li').first()).toContainText('Hidden');
    // Restore
    await expect(pop(page).locator('.mk-pop-a button')).toHaveText(['Restore']);
    await act('Restore').click();
    await expect.poll(() => last(db, 'staff_market_listing_set')).toEqual({ p_listing: 11, p_action: 'restore', p_note: null });
    await expect(pop(page).locator('.mk-tags .mk-pill')).toHaveText('On sale');
    await expect.poll(() => logged(page)).toContain('Marketplace: listing #11 Trek Domane SL 5 restored');
    // the shared log's line names the listing
    expect(await page.evaluate(`S.fullLog.filter(l=>/^Marketplace: listing/.test(l.label)).every(l=>l.m&&l.m.kind==='market'&&l.m.entity==='market_listings'&&l.m.entity_id==='11')`)).toBe(true);
  });

  test('a refusal is said in the desk\'s words, and the page is read again', async ({ page }) => {
    const db = fresh();
    await staff(page, db);
    await lrow(page, 14).locator('.mk-row-open').click();
    await expect(pop(page).locator('.mk-pop-a button')).toHaveText(['Restore']);
    db.fail = { staff_market_listing_set: { code: 'P0001', message: 'MKT_STATE' } };
    const reads = calls(db, 'staff_market_listing_get').length;
    await pop(page).locator('.mk-pop-a button', { hasText: 'Restore' }).click();
    await expect(page.locator('.toast', { hasText: 'That is not possible from this state. The page was read again.' })).toHaveCount(1);
    await expect.poll(() => calls(db, 'staff_market_listing_get').length).toBeGreaterThan(reads);
    expect((await logged(page)).some((l) => /restored/.test(l))).toBe(false);
    db.fail = { staff_market_listing_set: { code: '42501', message: 'FORBIDDEN', status: 403 } };
    await pop(page).locator('.mk-pop-a button', { hasText: 'Restore' }).click();
    await expect(page.locator('.toast', { hasText: 'This account cannot change the Marketplace.' })).toHaveCount(1);
  });
});

test.describe('@staff:market Held', () => {
  test('what the blocked words, a serial number already on sale or reports held: Release, or Hide with its reason', async ({ page }) => {
    const db = fresh();
    await staff(page, db, '/marketplace/held');
    expect(last(db, 'staff_market_listings')).toEqual({ p: { status: 'held', limit: 200, offset: 0 } });
    await expect(sec(page).locator('.mk-row')).toHaveCount(2);
    await expect(lrow(page, 12).locator('.mk-r-tags')).toContainText('Blocked words');
    await expect(lrow(page, 13).locator('.mk-r-tags')).toContainText('Duplicate serial number');
    await expect(lrow(page, 12).locator('.mk-r-acts button')).toHaveText(['Release', 'Hide']);
    await lrow(page, 12).locator('.mk-r-acts button', { hasText: 'Release' }).click();
    await expect.poll(() => calls(db, 'staff_market_listing_set')).toEqual([{ p_listing: 12, p_action: 'release', p_note: null }]);
    await expect(sec(page).locator('.mk-row')).toHaveCount(1);
    await expect(view(page, 'held').locator('.tab-badge')).toHaveText('1');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="market"] .tab-badge')).toHaveText('5');
    await expect.poll(() => logged(page)).toContain('Marketplace: listing #12 Running shoes released');
    // Hide opens the listing with the reason asked for
    await lrow(page, 13).locator('.mk-r-acts button', { hasText: 'Hide' }).click();
    await expect(pop(page).locator('#mk-pop-t')).toContainText('Giant Talon');
    await expect(pop(page).locator('.mk-form')).toBeVisible();
    await pop(page).locator('#mk-why').selectOption('dup');
    await pop(page).locator('.mk-form button', { hasText: 'Hide listing' }).click();
    await expect.poll(() => last(db, 'staff_market_listing_set')).toEqual({ p_listing: 13, p_action: 'hide', p_note: 'This item is already listed. هذا المنتج معروض في إعلان آخر.' });
    // a held listing that is hidden has no Undo: Restore would put it on sale, which it never was. It is logged, and Restore stays a button
    await expect.poll(() => logged(page)).toContain('Marketplace: listing #13 Giant Talon hidden');
    expect(await page.evaluate(`S.undoStack.some(u=>/#13 Giant Talon hidden/.test(u.label))`)).toBe(false);
    await expect(pop(page).locator('.mk-pop-a button')).toHaveText(['Restore']);
    await pop(page).locator('.mk-x').click();
    await expect(sec(page)).toContainText('No listing is held.');
    await expect(view(page, 'held').locator('.tab-badge')).toHaveCount(0);
  });
});

test.describe('@staff:market Reports', () => {
  test('the open ones first; the reported listing; a reported conversation read only when opened, and each read logged', async ({ page }) => {
    const db = fresh();
    await staff(page, db, '/marketplace/reports');
    expect(calls(db, 'staff_market_reports')[0]).toEqual({ p_status: 'open' });
    await expect(sec(page).locator('.mk-pills .filter-pill')).toHaveText(['Open (2)', 'Actioned', 'Dismissed', 'All']);
    await expect(sec(page).locator('.mk-rep')).toHaveCount(2);
    const r1 = rep(page, 1), r2 = rep(page, 2);
    await expect(r1.locator('.mk-rep-h')).toContainText('Open');
    await expect(r1.locator('.mk-rep-h')).toContainText('Listing');
    await expect(r1.locator('.mk-rep-h')).toContainText('Counterfeit');
    await expect(r1.locator('.mk-rep-l')).toContainText('Running shoes #12');
    await expect(r1.locator('.mk-rep-l .mk-pill')).toHaveText('Held');
    await expect(r1.locator('p.mk-text')).toHaveText('These are copies.');
    await expect(r1.locator('.mk-meta')).toContainText('Reported by: Huda Saleh · 0559990001');
    await expect(r1.locator('.mk-meta')).toContainText('About: Omar Faruq');
    await expect(r1.locator('.mk-acts button')).toHaveText(['Open listing', 'Dismiss', 'Hide listing', 'Add a strike', 'Suspend']);
    await expect(r2.locator('.mk-rep-h')).toContainText('Conversation');
    await expect(r2.locator('.mk-acts button')).toHaveText(['Open listing', 'Read the messages', 'Dismiss', 'Hide listing', 'Add a strike', 'Suspend']);
    // the listing a report is about
    await r1.locator('button', { hasText: 'Open listing' }).click();
    await expect(pop(page).locator('#mk-pop-t')).toContainText('Running shoes');
    await expect(kv(page, 'For')).toContainText('Men');
    await pop(page).locator('.mk-x').click();
    // the conversation: nothing is read until staff ask
    expect(calls(db, 'staff_market_thread')).toHaveLength(0);
    await r2.locator('button', { hasText: 'Read the messages' }).click();
    await expect(pop(page).locator('#mk-pop-t')).toHaveText('Reported conversation');
    await expect(pop(page).locator('.mk-msg')).toHaveCount(2);
    expect(calls(db, 'staff_market_thread')).toEqual([{ p_thread: 7 }]);
    await centred(page);
    await expect(pop(page).locator('.mk-msg').first()).toContainText('Buyer');
    await expect(pop(page).locator('.mk-msg').first().locator('p')).toHaveText('Is it still available?');
    await expect(pop(page).locator('.mk-msg').first().locator('p')).toHaveAttribute('dir', 'auto');
    await expect(pop(page).locator('.mk-msg').nth(1)).toContainText('Seller');
    await expect(kv(page, 'Buyer')).toContainText('Bilal Buyer · 0558889990 · Buyers see: Bilal B.');
    await expect(kv(page, 'Seller')).toContainText('Sara Ahmed Ali');
    await expect(kv(page, 'Seller')).toContainText('Shared WhatsApp');
    await expect(pop(page)).toContainText('One blocked the other');
    await expect(pop(page).locator('.mk-msgs-more')).toHaveText('Older messages are not shown.'); // the database returns the newest 1,000 and says when there are more
    await expect.poll(() => logged(page)).toContain('Marketplace: read the reported conversation on listing #11 Trek Domane SL 5');
    await pop(page).locator('.mk-x').click();
    // a conversation nobody reported is refused by the database, and the desk says why
    await page.evaluate(`_mkThread(8)`);
    await expect(pop(page)).toContainText('Only a reported conversation can be read.');
    expect((await logged(page)).filter((l) => /read the reported conversation/.test(l))).toHaveLength(1);
  });

  test('Dismiss and Reopen; Hide the listing, a strike or a suspension settle the report they came from', async ({ page }) => {
    const db = fresh();
    await staff(page, db, '/marketplace/reports');
    const set = () => calls(db, 'staff_market_report_set');
    // Dismiss: one tap, undone by reopening
    await rep(page, 2).locator('button', { hasText: 'Dismiss' }).click();
    await expect.poll(set).toEqual([{ p_report: 2, p_action: 'dismissed', p_note: null }]);
    await expect(sec(page).locator('.mk-rep')).toHaveCount(1);
    await expect(sec(page).locator('.mk-pills .filter-pill').first()).toHaveText('Open (1)');
    await expect.poll(() => logged(page)).toContain('Marketplace: report on #11 Trek Domane SL 5 dismissed');
    await sec(page).locator('.mk-pills .filter-pill', { hasText: 'Dismissed' }).click();
    await expect.poll(() => last(db, 'staff_market_reports')).toEqual({ p_status: 'dismissed' });
    await expect(rep(page, 2).locator('.mk-meta')).toContainText('Decided by Spec Staff');
    await expect(rep(page, 2).locator('.mk-acts button')).toHaveText(['Open listing', 'Read the messages', 'Reopen']);
    await rep(page, 2).locator('button', { hasText: 'Reopen' }).click();
    await expect.poll(() => set().at(-1)).toEqual({ p_report: 2, p_action: 'open', p_note: null });
    await sec(page).locator('.mk-pills .filter-pill', { hasText: /^Open/ }).click();
    await expect(sec(page).locator('.mk-rep')).toHaveCount(2);
    // a strike: its reason is asked for in a centred pop-up, then the report is marked actioned
    await rep(page, 2).locator('button', { hasText: 'Add a strike' }).click();
    await expect(pop(page).locator('#mk-pop-t')).toHaveText('Add a strike to Sara Ahmed Ali');
    await centred(page);
    await pop(page).locator('.mk-pop-a button', { hasText: 'Add a strike' }).click();
    await expect(pop(page).locator('.mk-bad')).toHaveText('Write at least 3 characters.');
    expect(calls(db, 'staff_market_seller_set')).toHaveLength(0);
    await pop(page).locator('#mk-ask-v').fill('Rude to a buyer.');
    await pop(page).locator('.mk-pop-a button', { hasText: 'Add a strike' }).click();
    await expect.poll(() => calls(db, 'staff_market_seller_set')).toEqual([{ p_customer: 'c1', p_action: 'strike', p_note: 'Rude to a buyer.' }]);
    await expect.poll(() => set().at(-1)).toEqual({ p_report: 2, p_action: 'actioned', p_note: 'strike: Rude to a buyer.' });
    await expect(pop(page)).toHaveCount(0);
    await expect(sec(page).locator('.mk-rep')).toHaveCount(1);
    await expect.poll(() => logged(page)).toEqual(expect.arrayContaining(['Marketplace: strike added to Sara Ahmed Ali', 'Marketplace: report on #11 Trek Domane SL 5 actioned']));
    // Hide listing: the report's reason picks the reason offered
    await rep(page, 1).locator('button', { hasText: 'Hide listing' }).click();
    await expect(pop(page).locator('#mk-why')).toHaveValue('fake');
    await pop(page).locator('.mk-form button', { hasText: 'Hide listing' }).click();
    const text = 'Counterfeit or copied items are not allowed. لا يُسمح بالمنتجات المقلدة أو المنسوخة.';
    await expect.poll(() => last(db, 'staff_market_listing_set')).toEqual({ p_listing: 12, p_action: 'hide', p_note: text });
    await expect.poll(() => set().at(-1)).toEqual({ p_report: 1, p_action: 'actioned', p_note: 'hide: ' + text });
    // the pop-up still open on that listing shows the report as it now is
    await expect(pop(page).locator('.mk-sec', { hasText: 'Reports' }).locator('li')).toContainText(['Actioned']);
    await expect(pop(page).locator('.mk-tags')).not.toContainText('Open reports');
    await pop(page).locator('.mk-x').click();
    await expect(sec(page)).toContainText('No open reports.');
    await expect(view(page, 'reports').locator('.tab-badge')).toHaveCount(0);
    // All: every report, and a suspension from one
    await sec(page).locator('.mk-pills .filter-pill', { hasText: /^All$/ }).click();
    await expect.poll(() => last(db, 'staff_market_reports')).toEqual({ p_status: null });
    await expect(sec(page).locator('.mk-rep')).toHaveCount(3);
    await rep(page, 3).locator('button', { hasText: 'Reopen' }).click();
    await expect(rep(page, 3).locator('.mk-rep-h .mk-pill')).toHaveText('Open');
    await expect(sec(page).locator('.mk-rep').first()).toHaveAttribute('data-rid', '3'); // the open one leads
    await expect(rep(page, 3).locator('.mk-acts button')).toHaveText(['Open listing', 'Dismiss', 'Add a strike', 'Suspend']); // its listing is hidden already
    await rep(page, 3).locator('button', { hasText: 'Suspend' }).click();
    await expect(pop(page).locator('#mk-pop-t')).toHaveText('Suspend Omar Faruq');
    await pop(page).locator('#mk-ask-v').fill('Sold copies twice.');
    await pop(page).locator('.mk-pop-a button', { hasText: 'Suspend' }).click();
    await expect.poll(() => calls(db, 'staff_market_seller_set').at(-1)).toEqual({ p_customer: 'c2', p_action: 'suspend', p_note: 'Sold copies twice.' });
    await expect.poll(() => set().at(-1)).toEqual({ p_report: 3, p_action: 'actioned', p_note: 'suspend: Sold copies twice.' });
    await expect.poll(() => logged(page)).toContain('Marketplace: Omar Faruq suspended');
  });
});

test.describe('@staff:market Sellers', () => {
  test('the accounts that list: strikes, the staff note, met by our team, suspend and restore', async ({ page }) => {
    const db = fresh();
    await staff(page, db, '/marketplace/sellers');
    expect(calls(db, 'staff_market_sellers')[0]).toEqual({ p: { status: 'all', limit: 100, offset: 0 } });
    await expect(sec(page).locator('.mk-sel')).toHaveCount(3);
    await expect(sec(page).locator('.mk-count')).toHaveText('Sellers: 3');
    const c2 = sel(page, 'c2'), c3 = sel(page, 'c3');
    await expect(c2.locator('.mk-sel-h')).toContainText('Omar Faruq');
    await expect(c2.locator('.mk-sel-h')).toContainText('0552223334');
    await expect(c2.locator('.mk-sel-h')).toContainText('New account');
    await expect(c2.locator('.mk-meta')).toContainText('Strikes: 1 · On sale: 0 · Sold: 0 · Open reports: 1');
    await expect(c2.locator('.mk-sel-note')).toHaveText('Staff note: Asked twice about copies.');
    await expect(c2.locator('.mk-acts button')).toHaveText(['Staff note', 'Add a strike', 'Remove a strike', 'Suspend']);
    await expect(c3.locator('.mk-sel-h .mk-pill')).toHaveText('Suspended');
    await expect(c3.locator('.mk-sel-h')).toContainText('Shop: Wadi Cycles');
    await expect(c3.locator('.mk-meta')).toContainText('Reason: Unpaid dispute');
    await expect(c3.locator('.mk-acts button')).toHaveText(['Staff note', 'Add a strike', 'Lift the suspension']);
    const set = () => calls(db, 'staff_market_seller_set');
    // the staff note: its own pop-up, the text there to change
    await c2.locator('button', { hasText: 'Staff note' }).click();
    await expect(pop(page).locator('#mk-pop-t')).toHaveText('Staff note about Omar Faruq');
    await expect(pop(page).locator('#mk-ask-v')).toHaveValue('Asked twice about copies.');
    await centred(page);
    await pop(page).locator('#mk-ask-v').fill('Warned on 12 January.');
    await pop(page).locator('.mk-pop-a button', { hasText: 'Save' }).click();
    await expect.poll(set).toEqual([{ p_customer: 'c2', p_action: 'note', p_note: 'Warned on 12 January.' }]);
    await expect(pop(page)).toHaveCount(0);
    await expect(c2.locator('.mk-sel-note')).toHaveText('Staff note: Warned on 12 January.');
    await expect.poll(() => logged(page)).toContain('Marketplace: staff note saved for Omar Faruq');
    // met by our team: a tick, with who and when
    await expect(c2.locator('.mk-tick input')).not.toBeChecked();
    await c2.locator('.mk-tick input').click();
    await expect.poll(() => set().at(-1)).toEqual({ p_customer: 'c2', p_action: 'met', p_note: null });
    await expect(c2.locator('.mk-tick input')).toBeChecked();
    await expect(c2.locator('.mk-tick')).toContainText('Spec Staff');
    await c2.locator('.mk-tick input').click();
    await expect.poll(() => set().at(-1)).toEqual({ p_customer: 'c2', p_action: 'unmet', p_note: null });
    // strikes
    await c2.locator('button', { hasText: 'Remove a strike' }).click();
    await expect.poll(() => set().at(-1)).toEqual({ p_customer: 'c2', p_action: 'unstrike', p_note: null });
    await expect(c2.locator('.mk-meta')).toContainText('Strikes: 0');
    await expect(c2.locator('button', { hasText: 'Remove a strike' })).toHaveCount(0);
    await c2.locator('button', { hasText: 'Add a strike' }).click();
    await pop(page).locator('#mk-ask-v').fill('A third copy.');
    await pop(page).locator('.mk-pop-a button', { hasText: 'Add a strike' }).click();
    await expect.poll(() => set().at(-1)).toEqual({ p_customer: 'c2', p_action: 'strike', p_note: 'A third copy.' });
    await expect(c2.locator('.mk-meta')).toContainText('Strikes: 1');
    // suspend with its reason, and restore
    await c2.locator('button', { hasText: 'Suspend' }).click();
    await pop(page).locator('#mk-ask-v').fill('Three strikes.');
    await pop(page).locator('.mk-pop-a button', { hasText: 'Suspend' }).click();
    await expect.poll(() => set().at(-1)).toEqual({ p_customer: 'c2', p_action: 'suspend', p_note: 'Three strikes.' });
    await expect(c2.locator('.mk-sel-h .mk-pill')).toHaveText('Suspended');
    await expect(c2.locator('.mk-meta')).toContainText('Reason: Three strikes.');
    await c3.locator('button', { hasText: 'Lift the suspension' }).click();
    await expect.poll(() => set().at(-1)).toEqual({ p_customer: 'c3', p_action: 'restore', p_note: null });
    await expect(c3.locator('.mk-sel-h .mk-pill')).toHaveText('Active');
    await expect.poll(() => logged(page)).toEqual(expect.arrayContaining(['Marketplace: Omar Faruq marked met by our team', 'Marketplace: met mark removed from Omar Faruq', 'Marketplace: strike removed from Omar Faruq',
      'Marketplace: strike added to Omar Faruq', 'Marketplace: Omar Faruq suspended', 'Marketplace: suspension lifted for Wadi Owner']));
    // the search and the state are the database's
    await search(page, 'mkp', 'wadi');
    await expect.poll(() => last(db, 'staff_market_sellers')).toEqual({ p: { status: 'all', limit: 100, offset: 0, q: 'wadi' } });
    await expect(sec(page).locator('.mk-sel')).toHaveCount(1);
    await search(page, 'mkp', '');
    await sec(page).locator('.filter-pill', { hasText: /^Suspended$/ }).click();
    await expect.poll(() => last(db, 'staff_market_sellers')).toEqual({ p: { status: 'suspended', limit: 100, offset: 0 } });
    await expect(sec(page).locator('.mk-sel')).toHaveCount(1);
    await expect(sel(page, 'c2')).toHaveCount(1);
  });
});

test.describe('@staff:market rights, the second half\'s views, Arabic', () => {
  test('an account that reads People without changing it sees no write button anywhere, and can still read', async ({ page }) => {
    const db = fresh();
    await staff(page, db, '/marketplace/held');
    await page.evaluate(`setStaffRole('owner');S._myEdit=[];renderMarket()`);
    await expect(sec(page).locator('.mk-row')).toHaveCount(2);
    await expect(sec(page).locator('.mk-r-acts')).toHaveCount(0);
    await lrow(page, 12).locator('.mk-row-open').click();
    await expect(pop(page).locator('#mk-pop-t')).toContainText('Running shoes');
    await expect(pop(page).locator('.mk-pop-a')).toHaveCount(0);
    await pop(page).locator('.mk-x').click();
    await view(page, 'reports').click();
    await expect(rep(page, 1).locator('.mk-acts button')).toHaveText(['Open listing']);
    await expect(rep(page, 2).locator('.mk-acts button')).toHaveText(['Open listing', 'Read the messages']);
    await rep(page, 2).locator('button', { hasText: 'Read the messages' }).click();
    await expect(pop(page).locator('.mk-msg')).toHaveCount(2); // a read: allowed
    await pop(page).locator('.mk-x').click();
    await view(page, 'sellers').click();
    await expect(sel(page, 'c2').locator('.mk-acts button')).toHaveCount(0);
    await expect(sel(page, 'c2').locator('.mk-tick input')).toBeDisabled();
    // a write asked for by name is refused before it is sent
    await page.evaluate(`_mkAct(12,'release')`);
    await page.evaluate(`_mkSeller('c2','unstrike')`);
    await page.evaluate(`_mkRep(1,'dismissed')`);
    await page.evaluate(`_mkAsk('suspend','c2')`);
    await expect(pop(page)).toHaveCount(0);
    expect(calls(db, 'staff_market_listing_set').concat(calls(db, 'staff_market_seller_set'), calls(db, 'staff_market_report_set'))).toHaveLength(0);
  });

  test('the second half\'s views are offered only while their two functions are there, by the names of the seam, with their names and numbers', async ({ page }) => {
    const db = fresh();
    await staff(page, db);
    // before MK-S2 is in the build the registry draws four views; once it is, this test stands in for nothing
    if (await page.evaluate(`typeof _mkShopsHtml==='function'`)) test.skip();
    await expect(sec(page).locator('.mk-views .filter-pill')).toHaveCount(4);
    expect(await page.evaluate(`typeof _mkPaint`)).toBe('function');
    await page.evaluate(`(()=>{
      window.__s2=[];
      const mk=(n,k)=>{window['_mk'+n+'Html']=()=>'<div class="s2-body" data-k="'+k+'">S2 '+k+(S._s2Data&&S._s2Data[k]?' ready':'')+'</div>';
        window['_mk'+n+'Load']=(force)=>{window.__s2.push(k+':'+force);return new Promise(r=>setTimeout(()=>{(S._s2Data=S._s2Data||{})[k]=1;r();},30));};};
      mk('Shops','shops');mk('Ours','ours');mk('Com','commission');mk('Set','settings');mk('Cats','cats');
      delete window._mkSetLoad; // a view with one of its two functions missing is not offered
      renderMarket();
    })()`);
    await expect(sec(page).locator('.mk-views .filter-pill')).toHaveText([/^Listings$/, /^Held\s*2$/, /^Reports\s*2$/, /^Sellers$/, /^Shops\s*2$/, /^Our listings$/, /^Commission\s*1$/, /^Categories$/]);
    await page.evaluate(`window._mkSetLoad=()=>Promise.resolve();renderMarket()`);
    await expect(sec(page).locator('.mk-views .filter-pill')).toHaveText([/^Listings$/, /^Held\s*2$/, /^Reports\s*2$/, /^Sellers$/, /^Shops\s*2$/, /^Our listings$/, /^Commission\s*1$/, /^Settings$/, /^Categories$/]);
    expect(await page.evaluate(`window.__s2.length`)).toBe(0); // nothing is loaded until its view is opened
    // opened: its load is asked once, and the section is drawn again when it settles
    await view(page, 'shops').click();
    expect(new URL(page.url()).pathname).toBe('/marketplace/shops');
    await expect(sec(page).locator('.s2-body')).toHaveText('S2 shops ready');
    expect(await page.evaluate(`window.__s2.join()`)).toBe('shops:false');
    await view(page, 'commission').click();
    expect(new URL(page.url()).pathname).toBe('/marketplace/commission');
    await expect(sec(page).locator('.s2-body')).toHaveText('S2 commission ready');
    await view(page, 'ours').click();
    expect(new URL(page.url()).pathname).toBe('/marketplace/our-listings');
    await view(page, 'cats').click();
    expect(new URL(page.url()).pathname).toBe('/marketplace/categories');
    await view(page, 'shops').click();
    expect(await page.evaluate(`window.__s2.join()`)).toBe('shops:false,commission:false,ours:false,cats:false'); // not asked again within the minute
    // S2 asks for a repaint by one name
    await page.evaluate(`S._s2Data.shops=0;_mkPaint()`);
    await expect(sec(page).locator('.s2-body')).toHaveText('S2 shops');
    // a view that throws does not take the section down
    await page.evaluate(`window._mkShopsHtml=()=>{throw new Error('spec')};_mkPaint()`);
    await expect(sec(page).locator('.mk-views .filter-pill')).toHaveCount(9);
    await expect(sec(page).locator('.mk-body')).toContainText('Try again');
  });

  test('Arabic: the section, its views and a listing read right to left, with the cities and product types in Arabic', async ({ page }) => {
    const db = fresh();
    await staff(page, db);
    await page.evaluate(`setLang('ar')`);
    await expect(sec(page).locator('h1')).toHaveText('السوق');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="market"] .snav-lbl')).toContainText('السوق');
    expect(await page.evaluate(`document.documentElement.dir`)).toBe('rtl');
    await expect(view(page, 'listings')).toHaveText('الإعلانات');
    await expect(view(page, 'held')).toContainText('الموقوفة');
    await expect(view(page, 'reports')).toContainText('البلاغات');
    await expect(view(page, 'sellers')).toHaveText('البائعون');
    await expect(lrow(page, 11).locator('.mk-r-main')).toContainText('دراجات الطريق · جدة');
    await expect(lrow(page, 11).locator('.mk-pill')).toHaveText('معروض للبيع');
    await expect(lrow(page, 12).locator('.mk-r-tags')).toContainText('كلمات محظورة');
    await lrow(page, 11).locator('.mk-row-open').click();
    await expect(kv(page, 'رقم الهيكل أو الرقم التسلسلي').locator('bdi')).toHaveAttribute('dir', 'ltr');
    await expect(kv(page, 'المدينة')).toContainText('جدة');
    await expect(pop(page).locator('.mk-pop-a button')).toHaveText(['وضع علامة «فحصه فريقنا»', 'إخفاء']);
    await centred(page);
    // no sideways scroll on the section at this width
    expect(await page.evaluate(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`)).toBe(true);
  });
});
