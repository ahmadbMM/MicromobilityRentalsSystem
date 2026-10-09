import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The second emergency contact, staff side (the owner, 2026-10-07: "add a second optional emergency contact field, show
// it in the customer My Account, and allow the staff to flag it"; customers.emergency2_*, migration 20261007150000).
// The account editor reads and writes it beside the first (a second typed alone becomes the first, never the first's
// number), the row menu's Emergency contact popup shows it with its own Call and WhatsApp, and the flag dialog offers
// it once the database is known to have it: before the migration staff_flag_customer drops a name it does not know and
// withdraws a request left with none. The Run for Her report stays the first contact only: it is the paperwork shared
// with Sela and JYC, and runners agreed to share one contact. A database without the columns refuses a read naming
// them (42703), and every screen carries on with the first contact alone.

const HEAD = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const FIRST = { emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' };
const SECOND = { emergency2_name: 'Omar Saleh', emergency2_phone: '+966551230077', emergency2_relation: 'friend' };
const acct = (x: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'Sami Nabil Haddad', email: 'sami.haddad@example.test', phone: '+966551230011', created_at: '2026-06-10T09:00:00Z', ...x,
});

async function boot(page: Page, customers: Record<string, unknown>[], extra: Record<string, unknown> = {}, old = false) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags: [], customer_tags: [], customer_flags: [], customers, ...extra });
  if (old) await oldDb(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
}
/** A database from before 20261007150000: a read that names the second contact's columns is refused. */
async function oldDb(page: Page) {
  await page.route(/\/rest\/v1\/customers\?/, (r) => {
    if (r.request().method() === 'GET' && decodeURIComponent(r.request().url()).includes('emergency2_')) {
      return r.fulfill({ status: 400, headers: HEAD, body: JSON.stringify({ code: '42703', message: 'column customers.emergency2_name does not exist', details: null, hint: null }) });
    }
    return r.fallback();
  });
}
/** The account rows the editor's save sends. */
function patches(page: Page) {
  const sent: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /\/rest\/v1\/customers\?/.test(r.url())) sent.push(r.postDataJSON()); });
  return sent;
}
/** What staff_flag_customer is asked. */
function flagCalls(page: Page) {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /rpc\/staff_flag_customer/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });
  return calls;
}

test.describe('@staff:accounts second emergency contact', () => {
  test('the account editor shows both contacts and saves the second beside the first', async ({ page }) => {
    await boot(page, [acct({ ...FIRST, ...SECOND })]);
    const sent = patches(page);
    await page.evaluate(`showEditCustomerModal('c1')`);
    const m = page.locator('#new-acct-modal');
    await expect(m.locator('#cf-em-name')).toHaveValue('Nora Haddad');
    await expect(m.locator('#cf-em-phone')).toHaveValue('551234567');
    await expect(m.locator('#cf-em-rel')).toHaveValue('sibling');
    await expect(m.locator('#cf-em2-name')).toHaveValue('Omar Saleh');
    await expect(m.locator('#cf-em2-cc')).toHaveValue('+966');
    await expect(m.locator('#cf-em2-phone')).toHaveValue('551230077');
    await expect(m.locator('#cf-em2-rel')).toHaveValue('friend');
    await expect(m.locator('fieldset.cf-em legend')).toHaveText(['Emergency contact', 'Second emergency contact (optional)']);
    // the second changed, its number typed in Arabic-Indic digits
    await page.fill('#cf-em2-name', 'Omar Nabil Saleh');
    await page.fill('#cf-em2-phone', '٠٥٥١٢٣٠٠٩٩');
    await page.selectOption('#cf-em2-rel', 'colleague');
    await page.evaluate('saveCustForm()');
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ ...FIRST, emergency2_name: 'Omar Nabil Saleh', emergency2_phone: '+966551230099', emergency2_relation: 'colleague' });
  });

  test('the same number twice is refused before anything is sent, and a second typed alone is saved as the first', async ({ page }) => {
    await boot(page, [acct({ ...FIRST, ...SECOND })]);
    const sent = patches(page);
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(page.locator('#cf-em2-name')).toHaveValue('Omar Saleh');
    // the first contact's number, written another way
    await page.fill('#cf-em2-phone', '0551234567');
    await page.evaluate('saveCustForm()');
    await expect(page.locator('#toast-container')).toContainText('The two emergency contacts can’t have the same number.');
    await expect(page.locator('#cf-em2-phone')).toBeFocused();
    // half a contact is refused as the first one is
    await page.fill('#cf-em2-phone', '551230077');
    await page.selectOption('#cf-em2-rel', '');
    await page.evaluate('saveCustForm()');
    await expect(page.locator('#cf-em2-rel')).toBeFocused();
    expect(sent).toHaveLength(0);
    // the first cleared, the second kept: it moves up, and the second's columns are cleared
    await page.selectOption('#cf-em2-rel', 'friend');
    await page.fill('#cf-em-name', '');
    await page.fill('#cf-em-phone', '');
    await page.selectOption('#cf-em-rel', '');
    await page.evaluate('saveCustForm()');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ emergency_name: 'Omar Saleh', emergency_phone: '+966551230077', emergency_relation: 'friend',
      emergency2_name: null, emergency2_phone: null, emergency2_relation: null });
  });

  test('a database without the second contact: the editor offers the first alone and never writes the second', async ({ page }) => {
    await boot(page, [acct(FIRST)], {}, true);
    const sent = patches(page);
    const asked: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && /\/rest\/v1\/customers\?.*emergency/.test(decodeURIComponent(r.url()))) asked.push(decodeURIComponent(r.url())); });
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(page.locator('#cf-em-name')).toHaveValue('Nora Haddad');
    await expect(page.locator('#new-acct-modal fieldset.cf-em')).toHaveCount(1);
    await expect(page.locator('#cf-em2-name')).toHaveCount(0);
    expect(await page.evaluate('S._em2Db')).toBe(false);
    await page.fill('#cf-em-name', 'Nora Saleh Haddad');
    await page.evaluate('saveCustForm()');
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ emergency_name: 'Nora Saleh Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' });
    expect(Object.keys(sent[0]).filter((k) => k.startsWith('emergency2'))).toEqual([]);
    // the row menu's popup then reads the first contact alone: the second's columns are asked for once a page
    await page.evaluate(`_runEmShow('c1')`);
    await expect(page.locator('#confirm-modal .run-em-card')).toHaveCount(1);
    await expect(page.locator('#confirm-modal .run-em-card')).toContainText('Nora Haddad');
    await expect(page.locator('#confirm-modal .run-em-h2')).toHaveCount(0);
    expect(asked.filter((u) => u.includes('emergency2_'))).toHaveLength(1);
  });

  test('the row menu\'s Emergency contact popup shows the second contact under the first, each with Call and WhatsApp', async ({ page }) => {
    await boot(page, [acct({ ...FIRST, ...SECOND })]);
    await page.evaluate(`_runEmShow('c1')`);
    const m = page.locator('#confirm-modal');
    await expect(m.locator('#run-em-title')).toHaveText('Emergency contact');
    await expect(m.locator('.run-em-card')).toHaveCount(2);
    await expect(m.locator('.run-em-card').nth(0)).toContainText('N•••'); // both contacts masked until a tap (2026-10-10)
    await m.locator('.pii-m').first().click();
    await expect(m.locator('.pii-m')).toHaveCount(0);
    await expect(m.locator('.run-em-card').nth(0)).toContainText('Nora Haddad');
    await expect(m.locator('.run-em-card').nth(0)).toContainText('Brother or sister');
    await expect(m.locator('.run-em-h2')).toHaveText('Second emergency contact');
    await expect(m.locator('.run-em-card').nth(1)).toContainText('Omar Saleh');
    await expect(m.locator('.run-em-card').nth(1)).toContainText('Friend');
    await expect(m.locator('.run-em-acts')).toHaveCount(2);
    await expect(m.locator('a[href="tel:+966551234567"]')).toBeVisible();
    await expect(m.locator('a[href="tel:+966551230077"]')).toBeVisible();
    await expect(m.locator('a[href="https://wa.me/966551234567"]')).toBeVisible();
    await expect(m.locator('a[href="https://wa.me/966551230077"]')).toBeVisible();
  });

  test('the flag dialog offers the second contact after the first and sends it to staff_flag_customer', async ({ page }) => {
    await boot(page, [acct()]);
    const calls = flagCalls(page);
    await page.evaluate(`showFlagFieldsModal('c1')`);
    const dlg = page.locator('#confirm-modal .fl-box');
    const keys = await dlg.locator('.fl-row').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.flag));
    expect(keys).toHaveLength(21); // every field of the account, WhatsApp (2026-10-07) and the second emergency contact
    expect(keys.slice(-2)).toEqual(['emergency', 'emergency2']);
    await expect(dlg.locator('.fl-row[data-flag="emergency2"] .fl-lbl')).toHaveText('Second emergency contact');
    await dlg.locator('.fl-row[data-flag="emergency2"]').click();
    await expect(dlg.locator('.fl-row[data-flag="emergency2"]')).toHaveAttribute('aria-pressed', 'true');
    await dlg.locator('.fl-row[data-flag="name"]').click();
    await expect(page.locator('#fl-send')).toHaveText(/Ask to correct \(2\)/);
    await page.click('#fl-send');
    await expect(dlg).toBeHidden();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_customer_id: 'c1', p_fields: ['name', 'emergency2'] });
  });

  test('a database without the second contact: the flag dialog does not offer it, nor send it for a Flag again', async ({ page }) => {
    await boot(page, [acct()], {}, true);
    const calls = flagCalls(page);
    await page.evaluate(`showFlagFieldsModal('c1',['name','emergency2'])`);
    const dlg = page.locator('#confirm-modal .fl-box');
    await expect(dlg.locator('.fl-row')).toHaveCount(20);
    await expect(dlg.locator('.fl-row[data-flag="emergency2"]')).toHaveCount(0);
    await expect(dlg).not.toContainText('Second emergency contact');
    expect(await page.evaluate('S._em2Db')).toBe(false);
    await expect(page.locator('#fl-send')).toHaveText(/Ask to correct \(1\)/);
    await page.click('#fl-send');
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_customer_id: 'c1', p_fields: ['name'] });
  });

  test('a probe that fails for another reason offers nothing, and the next dialog asks again', async ({ page }) => {
    await boot(page, [acct()]);
    let down = true;
    await page.route(/\/rest\/v1\/customers\?select=emergency2_name/, (r) => (down
      ? r.fulfill({ status: 503, headers: HEAD, body: JSON.stringify({ message: 'upstream unavailable' }) })
      : r.fallback()));
    await page.evaluate(`showFlagFieldsModal('c1')`);
    const dlg = page.locator('#confirm-modal .fl-box');
    await expect(dlg.locator('.fl-row')).toHaveCount(20);
    expect(await page.evaluate('S._em2Db===undefined')).toBe(true);
    await page.evaluate('_flagClose()');
    down = false;
    // the next dialog asks again; on a slow machine its answer can land after the 1.5 s the dialog waits, and is
    // then for the dialog after it (a row never joins a dialog on show)
    await page.evaluate(`showFlagFieldsModal('c1')`);
    await expect.poll(() => page.evaluate('S._em2Db')).toBe(true);
    await page.evaluate('_flagClose()');
    await page.evaluate(`showFlagFieldsModal('c1')`);
    await expect(dlg.locator('.fl-row')).toHaveCount(21);
    await expect(dlg.locator('.fl-row[data-flag="emergency2"]')).toHaveCount(1);
  });

  test('the Flagged list shows the second contact before and after, and Flag again asks for it once more', async ({ page }) => {
    await boot(page, [acct()], { customer_flags: [{ id: 'f1', customer_id: 'c1', fields: ['emergency2'], status: 'answered',
      flagged_at: '2026-10-07T09:00:00Z', answered_at: '2026-10-07T10:00:00Z', flagged_by: 'Desk', changes: {
        emergency2: { before: { name: 'Omar Saleh', phone: '+966551230077', relation: 'friend' },
          after: { name: 'Omar Nabil Saleh', phone: '+966551230099', relation: 'colleague' }, at: '2026-10-07T10:00:00Z' } } }] });
    const calls = flagCalls(page);
    await page.evaluate(`setStaffTab('customers');S.customersTab='flagged';renderCustomers()`);
    const row = page.locator('.flg-row[data-flag-id="f1"]');
    await expect(row.locator('.flg-asked')).toHaveText('Asked to correct: Second emergency contact');
    const ch = row.locator('.flg-change[data-field="emergency2"]');
    await expect(ch.locator('.cmy-flg-field')).toHaveText('Second emergency contact');
    await expect(ch.locator('.flg-before')).toHaveText('Omar Saleh · +966551230077 · Friend');
    await expect(ch.locator('.flg-after')).toHaveText('Omar Nabil Saleh · +966551230099 · Colleague');
    await row.locator('.flg-again').click();
    const dlg = page.locator('#confirm-modal .fl-box');
    await expect(dlg.locator('.fl-row[data-flag="emergency2"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#fl-send')).toHaveText(/Ask to correct \(1\)/);
    await page.click('#fl-send');
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_customer_id: 'c1', p_fields: ['emergency2'] });
  });
});

// Run for Her's report is what goes to Sela and JYC: the first contact only, and the second is never even read for it.
const RUN = '2099-10-17-rh';
const run = {
  id: RUN, session_date: '2099-10-17', day: 'Saturday', status: 'open', capacity: 80, created_at: 1,
  event_kind: 'community', ride_kind: 'runher', needs_approval: false, hide_queue: true, spots: 80, open_to_all: false,
  paid_ride: false, location: 'JYC', bike_slots: '{"_time":"06:00 - 06:30"}',
};
const runner = (id: string, km: number) => ({
  id, session_id: RUN, session_day: 'Saturday', session_date: '2099-10-17', queue_num: Number(id.slice(1)), name: 'Runner ' + id,
  phone: '055000000' + id.slice(1), type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0,
  registered_at: '2099-10-01T10:00:00Z', customer_id: 'c' + id, run_km: km,
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');

test.describe('@staff:bookings Run for Her report keeps one emergency contact', () => {
  test('the print and the CSV carry the first contact alone, and the read never asks for the second', async ({ page }) => {
    const reads: string[] = [];
    page.on('request', (r) => { if (r.method() === 'GET' && /\/rest\/v1\/customers\?.*emergency/.test(decodeURIComponent(r.url()))) reads.push(decodeURIComponent(r.url())); });
    await stubSupabase(page, { sessions: [run], bikes: [], queue_entries: [runner('r1', 5)],
      customers: [{ id: 'cr1', name: 'Runner r1', phone: '0550000001', ...FIRST, ...SECOND }] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getQueue().length>0');
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${RUN}';renderStaffQueue();S._repOpts=null;showPrintReportOptions()`);
    // every report the page opens, as written into its window, and every CSV it hands to the browser (as in run-report-per-distance.spec.ts)
    await page.evaluate(`window.__rep=[];window.open=()=>{const w={document:{write:(h)=>{window.__rep.push(h);},close(){},querySelectorAll:()=>[],fonts:{ready:Promise.resolve()},images:[]},focus(){},print(){}};return w;}`);
    await page.evaluate(`window.__csv=[];const _B=window.Blob;window.Blob=function(p,o){window.__csv.push(p.join(''));return new _B(p,o);};
      URL.createObjectURL=()=>'blob:x';const _a=document.createElement.bind(document);
      document.createElement=(t)=>{const el=_a(t);if(t==='a')el.click=()=>{};return el;};`);
    const m = page.locator('#print-opts-modal');
    await m.locator('[data-rep="cols:em"]').click();
    await expect.poll(() => page.evaluate(`_repEmReady('${RUN}')`)).toBe(true);
    await m.locator('.rpt-km-row').nth(1).getByRole('button', { name: 'Print' }).click();
    const html = (await page.evaluate('window.__rep') as string[])[0];
    expect(text(html)).toMatch(/Runner r1 .*Nora Haddad Brother or sister \+966551234567/);
    expect(html).not.toContain('Omar Saleh');
    expect(html).not.toContain('Second emergency contact');
    await m.locator('.rpt-km-row').nth(1).getByRole('button', { name: 'CSV' }).click();
    const [csv] = await page.evaluate('window.__csv') as string[];
    expect(csv).toContain('Nora Haddad · Brother or sister · +966551234567');
    expect(csv).not.toContain('Omar Saleh');
    expect(csv).not.toContain('Second emergency contact');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((u) => u.includes('emergency2_'))).toEqual([]);
  });
});
