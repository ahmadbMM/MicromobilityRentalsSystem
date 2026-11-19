import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, stubRealtime, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// "Note for the desk" (the user, 2026-11-19, item 9: "An optional field on the review step, for things like 'first time on
// a bike' or 'my child is nervous'. Staff see it on the booking."). Migration 20261119600300: queue_entries.rider_note and
// booking_note_set(p_id, p_token, p_booking, p_note), called once the booking stands, on its first row. The ticket's Edit
// changes or clears it; staff see a mark on the roster row (the whole note on a tap), the note in the check-in drawer and
// on the Booking card. Invented riders only.

const D1 = '2099-04-05';
const D2 = '2099-04-12';
const D3 = '2099-04-19';
const night = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_date: id, day: 'Sunday', status: 'open', capacity: 12, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":12}', ...extra,
});
const sessions = [night(D1), night(D2), night(D3)];
const mine = (id: string, sid: string, q: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: sid, queue_num: q, name, phone: '0500000001', customer_id: 'c1',
  type_preference: 'Road', height: 175, status: 'waiting', paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z', ...extra,
});

async function rider(page: Page, fx: Record<string, unknown> = {}, rows: Record<string, unknown>[] = [], lang = '') {
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: rows, 'rpc:my_bookings': rows, ...fx });
  await loginCustomer(page, { height: 175, type_preference: 'Road', nationality: 'SA', birth_date: '1990-01-01' });
  await page.goto('/' + (lang ? `?lang=${lang}` : ''));
  await waitForSb(page);
}
const at = (sid: string, step: number) => `S.lastTickets=[];S.selEvent='jcc';goCustomer('register');S.selSession='${sid}';S.regQty=1;
  S.regBikeHeights=['175'];S.regBikeTypes=['Road'];S.regRiderNames=['Spec Rider'];S.promoApplied=null;S.waiverOk=true;S._waiverSess='${sid}';S.regStep=${step};renderRegister();`;
function calls(page: Page) {
  const seq: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = /\/rest\/v1\/rpc\/(customer_create_booking|booking_note_set)/.exec(r.url());
    if (m && r.method() === 'POST') seq.push({ fn: m[1], body: r.postDataJSON() });
  });
  return seq;
}
const field = (page: Page) => page.locator('#reg-note');
const firstId = (c: { body: Record<string, unknown> }) => (c.body.p_entries as Record<string, unknown>[])[0].id;

test.describe('@customer:reserve note for the desk', () => {
  test('the review has the field, it keeps what was typed, and the booking sends it after the create, on the first row', async ({ page }) => {
    await rider(page, { 'rpc:booking_note_set': { ok: true, note: 'First time on a bike' } });
    const seq = calls(page);
    await page.evaluate(at(D1, 3));
    await expect(page.getByLabel('Note for the desk')).toBeVisible();
    await expect(field(page)).toHaveAttribute('maxlength', '200');
    await expect(field(page)).not.toHaveAttribute('placeholder', /./);
    await field(page).fill('  First time on a bike ');
    // Change and back: kept
    await page.locator('#tab-register .cu-rv-sec-chg .cu-rv-chg').click();
    expect(await page.evaluate('S.regStep')).toBe(2);
    await page.evaluate('regNextToReview()');
    await expect(field(page)).toHaveValue('  First time on a bike ');
    await page.evaluate('submitReg()');
    await expect.poll(() => seq.filter((c) => c.fn === 'booking_note_set').length).toBe(1);
    expect(seq.map((c) => c.fn)).toEqual(['customer_create_booking', 'booking_note_set']);
    const note = seq[1].body;
    expect(note.p_booking).toBe(firstId(seq[0]));
    expect(note.p_note).toBe('First time on a bike');
    expect(note.p_id).toBe('c1');
    expect(note.p_token).toBe('tok-spec');
    await expect(page.locator('#tab-register .bk-ok-t')).toBeVisible();
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    expect(await page.evaluate('S.regNote')).toBe('');
  });

  test('200 characters at most; an empty field sends nothing', async ({ page }) => {
    await rider(page);
    const seq = calls(page);
    await page.evaluate(at(D1, 3));
    await field(page).fill('x'.repeat(250));
    await expect.poll(async () => (await field(page).inputValue()).length).toBe(200);
    expect(await page.evaluate('S.regNote.length')).toBe(200);
    await field(page).fill('   ');
    await page.evaluate('submitReg()');
    await expect(page.locator('#tab-register .bk-ok-t')).toBeVisible();
    expect(seq.filter((c) => c.fn === 'booking_note_set')).toHaveLength(0);
  });

  test('several dates send it for each booking', async ({ page }) => {
    await rider(page, { 'rpc:booking_note_set': { ok: true } });
    const seq = calls(page);
    await page.evaluate(`${at(D1, 3)}S._mdt=['${D1}','${D2}','${D3}'];S.regNote='My child is nervous';renderRegister();`);
    await expect(field(page)).toHaveValue('My child is nervous');
    await page.evaluate('submitReg()');
    await expect.poll(() => seq.filter((c) => c.fn === 'booking_note_set').length).toBe(3);
    const made = seq.filter((c) => c.fn === 'customer_create_booking').map(firstId);
    const notes = seq.filter((c) => c.fn === 'booking_note_set').map((c) => c.body);
    expect(notes.map((n) => n.p_booking)).toEqual(made);
    expect(notes.every((n) => n.p_note === 'My child is nervous')).toBe(true);
    await expect(page.locator('#tab-register .bk-ok-t')).toHaveText('3 dates booked');
  });

  test('a note that did not save is said in words with Try again; the booking stands', async ({ page }) => {
    await rider(page, { 'rpc:booking_note_set': { ok: false, error: 'none' } });
    const seq = calls(page);
    await page.evaluate(at(D1, 3));
    await field(page).fill('First time on a bike');
    await page.evaluate('submitReg()');
    const dlg = page.locator('#confirm-modal .confirm-box');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('Your note for the desk did not save.');
    await expect(page.locator('#tab-register .bk-ok-t')).toBeVisible(); // booked all the same
    await dlg.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => seq.filter((c) => c.fn === 'booking_note_set').length).toBe(2);
    await expect(page.locator('#confirm-modal .confirm-box')).toBeVisible(); // still refused: said again
  });

  test("the ticket's Details show it, and Edit shows it to change or clear", async ({ page }) => {
    const rows = [mine('m1', D1, 4, 'Spec Rider', { rider_note: 'My child is nervous' }), mine('m2', D1, 5, 'Small Rider', { height: 130, type_preference: 'Kids' })];
    await rider(page, { 'rpc:booking_note_set': { ok: true } }, rows);
    const seq = calls(page);
    await page.evaluate(`setCustTab('myrides')`);
    const tk = page.locator('#tab-myrides .ticket-card').first();
    await tk.locator('.tk-more-btn').click();
    await expect(tk.locator('.tk-dnt')).toContainText('Note for the desk');
    await expect(tk.locator('.tk-dnt')).toContainText('My child is nervous');
    // Edit (the booking's riders, then the review)
    await page.evaluate(`S.lastTickets=[];S.selEvent='jcc';S.selSession='${D1}';S.regStep=3;setCustTab('register')`);
    await expect.poll(() => page.evaluate('S.modifyEntryId')).toBe('m1');
    await expect(field(page)).toHaveValue('My child is nervous');
    await field(page).fill('');
    await page.locator('#tab-register .mm-reg-foot .btn-primary').click(); // Update booking
    await expect.poll(() => seq.filter((c) => c.fn === 'booking_note_set').length).toBe(1);
    expect(seq[seq.length - 1].body.p_booking).toBe('m1');
    expect(seq[seq.length - 1].body.p_note).toBe('');
    // an edit that changes nothing does not send it again, and a booking started afterwards starts empty
    await page.evaluate(`S.selEvent='jcc';S.selSession='${D2}';S.regStep=1;renderRegister()`);
    expect(await page.evaluate('S.regNote||""')).toBe('');
  });

  test('Arabic', async ({ page }) => {
    await rider(page, {}, [], 'ar');
    await page.evaluate(at(D1, 3));
    await expect(page.getByLabel('ملاحظة لفريق الاستقبال')).toBeVisible();
  });
});

// ── staff ───────────────────────────────────────────────────────────────────────────────────────
const DAY = '2099-05-05';
const NOW = new Date(`${DAY}T20:00:00+03:00`);
const NOTE = 'First time on a bike, and my daughter is nervous about the start line';
const srow = (id: string, qn: number, name: string, cid: string | null, extra: Record<string, unknown> = {}) => ({
  id, session_id: 's0', session_day: 'Tuesday', session_date: DAY, queue_num: qn, name, phone: '0500000000', customer_id: cid, group_id: null,
  status: 'waiting', paid: true, price: 75, walk_in: !cid, registered_at: `${DAY}T15:00:00Z`, height: 175, type_preference: 'Road', ...extra,
});
const A = 'aaaa0001-0000-4000-8000-000000000000';
const A2 = 'aaaa0002-0000-4000-8000-000000000000';
const B = 'aaaa0003-0000-4000-8000-000000000000';
const staffRows = [srow(A, 1, 'Amal Road', 'cust-amal', { rider_note: NOTE }), srow(A2, 2, 'Sami Road', 'cust-amal', { height: 140, type_preference: 'Kids' }), srow(B, 3, 'Badr Top', 'cust-badr')];
const customers = [
  { id: 'cust-amal', name: 'Amal Road', phone: '0500000011', created_at: '2099-01-01T00:00:00Z' },
  { id: 'cust-badr', name: 'Badr Top', phone: '0500000012', created_at: '2099-01-01T00:00:00Z' },
];

test.describe('@staff:bookings the rider\'s note for the desk', () => {
  test('a mark on the row that carries it, the whole note on a tap, the drawer and the Booking card', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, { queue_entries: staffRows, sessions: [{ id: 's0', day: 'Tuesday', session_date: DAY, capacity: 20, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _total: 20, _time: '20:00 - 22:00' }) }], bikes: [], customers });
    await stubRealtime(page);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
    await page.waitForFunction(`typeof _dntCi==='function'&&typeof _dntOpen==='function'`); // the desk part is in
    const marks = page.locator('#tab-queue .rq-rnote:visible');
    await expect(marks).toHaveCount(1); // on the party's row (or card), once
    await expect(marks).toHaveAccessibleName(`Rider's note: ${NOTE}`);
    // a mark beside the status: the row (a desk's table row, a phone's card) keeps its height
    const rowH = () => page.evaluate(`document.querySelector('#tab-queue [data-id="${A}"]').getBoundingClientRect().height`).then((h) => Math.round(Number(h)));
    const withNote = await rowH();
    await page.evaluate(`S.queue.forEach(x=>{x._rn=x.riderNote;x.riderNote=null;});renderStaffQueue()`);
    await expect(marks).toHaveCount(0);
    expect(await rowH()).toBe(withNote);
    await page.evaluate(`S.queue.forEach(x=>{x.riderNote=x._rn;});renderStaffQueue()`);
    await expect(marks).toHaveCount(1);
    await marks.click();
    const pop = page.locator('#confirm-modal [role="dialog"]');
    await expect(pop).toBeVisible();
    await expect(pop).toContainText(NOTE);
    await expect(pop).toContainText("Rider's note");
    await expect(page.locator('#checkin-modal [role="dialog"]')).toHaveCount(0); // the row did not open too
    await page.evaluate('closeConfirm()');
    // the drawer: on the account holder's rider and the companion's alike, nothing on another booking
    await page.evaluate(`showCheckinModal('${A2}')`);
    const box = page.locator('#checkin-modal [role="dialog"] .dnt-ci');
    await expect(box).toContainText(NOTE);
    await page.evaluate(`closeCheckinModal();showCheckinModal('${B}')`);
    await expect(page.locator('#checkin-modal [role="dialog"]')).toContainText('Badr Top');
    await expect(page.locator('#checkin-modal [role="dialog"] .dnt-ci')).toHaveCount(0);
    await page.evaluate('closeCheckinModal()');
    // the Booking card, as the rider's ticket shows it (Details open)
    await page.evaluate(`_tcOpen('${A}')`);
    const card = page.frameLocator('#confirm-modal .tc-frame').locator('.ticket-card');
    await expect(card.locator('.tk-dnt')).toContainText(NOTE);
  });

  test('Arabic says whose note it is', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, { queue_entries: staffRows, sessions: [{ id: 's0', day: 'Tuesday', session_date: DAY, capacity: 20, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _total: 20, _time: '20:00 - 22:00' }) }], bikes: [], customers });
    await stubRealtime(page);
    await unlockStaff(page);
    await page.goto('/?lang=ar');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
    await page.waitForFunction(`typeof _dntCi==='function'`);
    await page.evaluate(`showCheckinModal('${A}')`);
    await expect(page.locator('#checkin-modal [role="dialog"] .dnt-ci')).toContainText('ملاحظة العميل');
  });
});
