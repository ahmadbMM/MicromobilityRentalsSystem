import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// The code a booking used, its kind and its mark (the owner, 2026-11-08: "when a code is used show it besides the booking
// and what type of code it is with a logo"): the Bookings table's Code column (still "Ride code", names only, while every
// code in view is a Saturday ride's: tests/saturday-codes.spec.ts), the chip beside a name, the booking window, the
// report's and History's files, and the rider's ticket. All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const row = (n: number, name: string, x: Record<string, unknown> = {}) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: null, phone: '', email: '',
  type_preference: 'Hybrid', size: 'M', status: 'waiting', paid: false, price: 57.5, registered_at: '2026-11-06T10:00:00Z', ...x,
});
const queue_entries = [
  row(1, 'Pat Promo', { promo_code: 'SUMMER10', price: 51.75 }),
  row(2, 'Fay Friend', { promo_code: 'RW-K7MQ2X-4FZ', price: 28.75 }),
  row(3, 'Rex Referrer', { promo_code: 'RF-1A2B3C4D', price: 0 }),
  row(4, 'Bea Bonus', { promo_code: 'RB-9F8E7D6C', price: 0 }),
  row(5, 'Dana Donor', { promo_code: 'BD-1A2B3C4D', price: 0 }),
  row(6, 'Nora Nobody'),
  row(7, 'Vic Volunteer', { promo_code: 'VL-7F3A92C1', price: 0 }),
];
const promo_codes = [
  { id: 'p1', code: 'SUMMER10', kind: 'percent', value: 10, active: true, uses: 1 },
  { id: 'rw-c9', code: 'RW-K7MQ2X-4FZ', kind: 'percent', value: 50, active: true, uses: 1, max_uses: 1, customer_id: 'c9', referral_welcome_of: 'c9' },
  { id: 'rf-c8', code: 'RF-1A2B3C4D', kind: 'percent', value: 100, active: true, uses: 1, max_uses: 1, customer_id: 'c7', referral_friend_id: 'c8' },
  { id: 'rb-c7', code: 'RB-9F8E7D6C', kind: 'percent', value: 100, active: true, uses: 1, max_uses: 1, customer_id: 'c7', referral_bonus_of: 'c7' },
  { id: 'bd-1', code: 'BD-1A2B3C4D', kind: 'percent', value: 100, active: true, uses: 1, max_uses: 1, customer_id: 'c6', blood_entry_id: 'x1' },
  // a volunteer's free ride for an event worked (VL-, 20261109120000): staff read its kind off volunteer_session_id
  { id: 'vl-1', code: 'VL-7F3A92C1', kind: 'percent', value: 100, active: true, uses: 1, max_uses: 1, customer_id: 'c5', volunteer_session_id: '2099-02-01' },
];

async function boot(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 1000 });
  await stubSupabase(page, { sessions, queue_entries, promo_codes, bikes: [], staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.promoCodes||[]).length===6');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${LIVE}';S.sfShowFinished=true;renderStaffQueue()`);
}
const tr = (page: Page, id: string) => page.locator(`#tab-queue .queue-table tbody tr[data-id="${id}"]`);

test.describe('@staff:bookings the code each booking used', () => {
  test('a Code column: each code with its kind\'s mark and name, a dash for none', async ({ page }) => {
    test.skip(test.info().project.name === 'mobile', 'the desktop roster table, which a phone does not show');
    await boot(page);
    const table = page.locator('#q-results .queue-table');
    await expect(tr(page, 'q1')).toBeVisible();
    const heads = await table.locator('thead th').allInnerTexts();
    const col = heads.findIndex((h) => h.trim() === 'Code');
    expect(col).toBeGreaterThan(heads.findIndex((h) => /Rider/.test(h)));
    const cell = (id: string) => tr(page, id).locator('> td').nth(col);
    const want: [string, string, string, string][] = [
      ['q1', 'promo', 'Promo code', 'SUMMER10'],
      ['q2', 'rw', 'Referral discount', 'RW-K7MQ2X-4FZ'],
      ['q3', 'rf', 'Referral free ride', 'RF-1A2B3C4D'],
      ['q4', 'rb', 'Referral bonus ride', 'RB-9F8E7D6C'],
      ['q5', 'bd', 'Blood donation free ride', 'BD-1A2B3C4D'],
      ['q7', 'vl', 'Volunteer free ride', 'VL-7F3A92C1'],
    ];
    for (const [id, k, kind, code] of want) {
      const tag = cell(id).locator(`.code-tag.code-k-${k}`);
      await expect(tag).toHaveCount(1);
      await expect(tag.locator('svg.code-ic')).toHaveCount(1); // the kind's own drawn mark
      await expect(tag.locator('.code-kn')).toHaveText(kind);
      await expect(tag.locator('.code-c')).toHaveText(code);
      await expect(tag).toHaveAttribute('title', `${kind}: ${code}`);
    }
    await expect(cell('q6')).toHaveText('—');
    // the marks differ by kind, in colour too
    const inks = await Promise.all(['q1', 'q2', 'q5', 'q7'].map((id) => cell(id).locator('svg.code-ic').evaluate((el) => getComputedStyle(el).color)));
    expect(new Set(inks).size).toBe(4);
    // not beside the name as well
    await expect(tr(page, 'q1').locator('.rq-rider .code-tag')).toHaveCount(0);
  });

  test('a tight roster never cuts the code short (Arabic, the booth theme: "WELC..." after the look pass)', async ({ page }) => {
    test.skip(test.info().project.name === 'mobile', 'the desktop roster table, which a phone does not show');
    await boot(page, 1280);
    await page.evaluate(`setLang('ar');document.documentElement.setAttribute('data-staff-theme','booth');renderStaffQueue()`);
    await expect(tr(page, 'q1').locator('.code-c')).toBeVisible();
    // squeeze the table to its narrowest: each column at its min-content width, as a crowded night leaves it
    await page.evaluate(`(()=>{const t=document.querySelector('#tab-queue .queue-table');t.style.width='600px';t.style.minWidth='0';})()`);
    const cut = await page.locator('#tab-queue .queue-table .code-cell .code-c').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    expect(cut).toEqual([]);
  });

  test('phone cards and the booking window: the mark and the code beside the name, the kind in the title', async ({ page }) => {
    await boot(page, 390);
    const card = page.locator('#tab-queue .queue-mobile-view .q-card[data-id="q2"]');
    const tag = card.locator('.code-tag.code-k-rw');
    await expect(tag).toHaveCount(1);
    await expect(tag).toHaveText('RW-K7MQ2X-4FZ');
    await expect(tag).toHaveAttribute('title', 'Referral discount: RW-K7MQ2X-4FZ');
    await page.evaluate(`showBookingEditModal('q3')`);
    await expect(page.locator('#dlgt-editBookingTitle .code-tag.code-k-rf')).toHaveAttribute('title', 'Referral free ride: RF-1A2B3C4D');
  });

  test('in words for the files: the report\'s Code column and History\'s', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`_codeTxt(getQueue().filter(e=>e.id==='q1'||e.id==='q3'))`)).toBe('Promo code · SUMMER10; Referral free ride · RF-1A2B3C4D');
    expect(await page.evaluate(`_REP_COLS.some(c=>c.k==='code')&&_repDefaults().cols.code`)).toBe(1);
    // History's file (as tests/history-fixes.spec.ts reads it): a Code column after the price
    // History lists finished bookings: two of these, done
    await page.evaluate(`getQueue().forEach(e=>{if(e.id==='q2'||e.id==='q5')e.status='done';});setStaffTab('history');S.histRange='all';S.histSess='${LIVE}';renderHistory()`);
    const dl = page.waitForEvent('download');
    await page.evaluate(`exportHistoryCSV()`);
    const text = await (await import('node:fs/promises')).readFile(await (await dl).path() as string, 'utf8');
    const head = text.split(/\r?\n/)[0];
    expect(head).toMatch(/Price.*,Code,/);
    expect(text).toContain('Referral discount · RW-K7MQ2X-4FZ');
    expect(text).toContain('Blood donation free ride · BD-1A2B3C4D');
  });
});

test.describe('@customer:account the code on the rider\'s ticket', () => {
  test('the row that used it shows the mark, the kind, the code and what it took off', async ({ page }) => {
    const jcc = { id: 's0', day: 'Sunday', session_date: '2099-02-08', capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null };
    await stubSupabase(page, { sessions: [jcc] });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    const fare = await page.evaluate(`priceForType('Hybrid')`) as number;
    const html = await page.evaluate(`renderBookingTicket([
      {id:'t1',queueNum:3,name:'Sara Haddad',sessionId:'s0',sessionDay:'Sunday',sessionDate:'2099-02-08',status:'waiting',price:${fare / 2},paid:false,typePreference:'Hybrid',promoCode:'RW-K7MQ2X-4FZ',customerId:'c1',registeredAt:'2026-11-08T10:00:00Z'},
      {id:'t2',queueNum:4,name:'Omar Haddad',sessionId:'s0',sessionDay:'Sunday',sessionDate:'2099-02-08',status:'waiting',price:${fare},paid:false,typePreference:'Hybrid',customerId:'c1',registeredAt:'2026-11-08T10:00:00Z'}])`) as string;
    await page.evaluate((h) => { const d = document.createElement('div'); d.id = 'tk-probe'; d.innerHTML = h; document.body.appendChild(d); }, html);
    const rows = page.locator('#tk-probe .cu-tr-row');
    await expect(rows).toHaveCount(2);
    const line = rows.nth(0).locator('.cu-tr-code');
    await expect(line.locator('.code-tag.code-k-rw .code-kn')).toHaveText('Referral discount');
    await expect(line.locator('.code-c')).toHaveText('RW-K7MQ2X-4FZ');
    await expect(line.locator('.code-off')).toContainText(String(fare / 2));
    await expect(rows.nth(1).locator('.cu-tr-code')).toHaveCount(0); // the guest's seat used no code
  });

  test('a volunteer free ride on the ticket: its kind read off the VL- prefix, rider 1 only', async ({ page }) => {
    const jcc = { id: 's0', day: 'Sunday', session_date: '2099-02-08', capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null };
    await stubSupabase(page, { sessions: [jcc] });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    const html = await page.evaluate(`renderBookingTicket([{id:'t1',queueNum:3,name:'Sara Haddad',sessionId:'s0',sessionDay:'Sunday',sessionDate:'2099-02-08',status:'waiting',price:0,paid:false,typePreference:'Hybrid',promoCode:'VL-7F3A92C1',customerId:'c1',registeredAt:'2026-11-08T10:00:00Z'}])`) as string;
    await page.evaluate((h) => { const d = document.createElement('div'); d.id = 'tk-probe'; d.innerHTML = h; document.body.appendChild(d); }, html);
    const tag = page.locator('#tk-probe .cu-tr-code .code-tag.code-k-vl');
    await expect(tag.locator('.code-kn')).toHaveText('Volunteer free ride');
    await expect(tag.locator('.code-c')).toHaveText('VL-7F3A92C1');
    expect(await page.evaluate(`_codeOne('VL-7F3A92C1')`)).toBe(true);
  });
});
