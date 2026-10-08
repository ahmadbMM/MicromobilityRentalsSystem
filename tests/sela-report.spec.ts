import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Run for Her's Report for Sela (the owner, 2026-10-08: "add it as a button to print updated whenever needed"):
// one line in the export dialog, Print and Excel. Every live booking, the waitlist after the booked runners in
// waitlist order and shaded, with the details Sela asked for, read from the accounts at each tap.

const RUN = '2099-10-17-rh';
const run = {
  id: RUN, session_date: '2099-10-17', day: 'Saturday', status: 'open', capacity: 80, created_at: 1,
  event_kind: 'community', ride_kind: 'runher', needs_approval: false, hide_queue: true, spots: 80, open_to_all: false,
  paid_ride: false, location: 'JYC', bike_slots: '{"_time":"06:00 - 06:30"}',
};
const jcc = { id: '2099-10-18', session_date: '2099-10-18', day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC' };
const row = (id: string, qn: number, km: number | null, x: Record<string, unknown> = {}) => ({
  id, session_id: RUN, session_day: 'Saturday', session_date: '2099-10-17', queue_num: qn, name: 'Booked as ' + id,
  phone: '0550000000', type_preference: 'None', size: '', status: 'waiting', paid: false, price: 0,
  registered_at: '2099-10-01T10:00:00Z', customer_id: 'c' + id, run_km: km, ...x,
});
const queue_entries = [
  row('r2', 2, 3, { data_share_at: '2099-10-02T10:00:00Z' }), row('r1', 1, 5), row('r9', 9, 5, { status: 'cancelled' }),
  row('w2', 12, 3, { status: 'waitlist', waitlist_num: 5 }), row('w1', 11, 5, { status: 'waitlist', waitlist_num: 3, data_share_at: '2099-10-03T10:00:00Z' }),
];
const customers = [
  { id: 'cr1', name: 'Test Runner One', email: 'one@example.test', phone: '0550000001', birth_date: '1990-04-02', emergency_name: 'Contact One', emergency_phone: '+966551234567', emergency_relation: 'sibling', emergency2_name: 'Second Contact' },
  { id: 'cr2', name: 'Test Runner Two', email: 'two@example.test', phone: '0550000002', birth_date: null, emergency_name: null, emergency_phone: null, emergency_relation: null },
  { id: 'cw1', name: 'Test Waiter One', email: 'w1@example.test', phone: '0550000003', birth_date: '2001-12-31', emergency_name: 'Contact W', emergency_phone: '+966559999999', emergency_relation: 'parent' },
  { id: 'cw2', name: 'Test Waiter Two', email: 'w2@example.test', phone: '0550000004' },
];

async function boot(page: Page, sessId = RUN) {
  await stubSupabase(page, { sessions: [run, jcc], bikes: [], queue_entries, customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${sessId}';renderStaffQueue();S._repOpts=null;showPrintReportOptions()`);
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');

test.describe('@staff:bookings Run for Her report for Sela', () => {
  test('Print: booked runners in number order, then the waitlist shaded, with the account details read fresh', async ({ page }) => {
    await boot(page);
    const reads: string[] = [];
    page.on('request', (r) => { if (/\/rest\/v1\/customers\?.*birth_date/.test(r.url())) reads.push(r.url()); });
    await page.evaluate(`window.__rep=[];window.open=()=>({document:{write:(h)=>{window.__rep.push(h);},close(){},querySelectorAll:()=>[],fonts:{ready:Promise.resolve()},images:[]},focus(){},print(){},close(){}})`);
    const m = page.locator('#print-opts-modal');
    await expect(m.getByText('Report for Sela')).toBeVisible();
    const line = m.locator('.rpt-sela-row');
    await line.getByRole('button', { name: 'Print' }).click();
    await expect.poll(() => page.evaluate('window.__rep.length')).toBe(1);
    expect(reads.length).toBe(1);
    const html = (await page.evaluate('window.__rep') as string[])[0];
    const body = text(html);
    expect(html).toContain('MM-RPT-991017-SELA');
    // order: #1, #2, then the waitlist by its own order (3 before 5), numbered 1 and 2; the cancelled one is gone
    const names = [...body.matchAll(/Test (Runner|Waiter) (One|Two)/g)].map((x) => x[0]);
    expect(names).toEqual(['Test Runner One', 'Test Runner Two', 'Test Waiter One', 'Test Waiter Two']);
    expect(body).not.toContain('Booked as r9');
    expect(html.match(/<tr class="rp-wl">/g)?.length).toBe(2);
    expect(body).toMatch(/#11 Waitlist 1 Test Waiter One/);
    expect(body).toMatch(/#12 Waitlist 2 Test Waiter Two/);
    // what Sela asked for, the first emergency contact only, and a gap shown as a dash
    expect(body).toMatch(/#1 Booked Test Runner One one@example\.test 02\/04\/1990 5 km Contact One \+966551234567 Brother or sister No/);
    expect(body).toMatch(/#2 Booked Test Runner Two two@example\.test — 3 km — — — Yes/);
    expect(body).not.toContain('Second Contact');
    for (const h of ['Runner number', 'Email', 'Birth date', 'Distance', 'Emergency contact', 'Relationship', 'Agreed to share']) expect(html).toContain(`<th>${h}</th>`);
    expect(body).toMatch(/2 Booked/);
    expect(body).toMatch(/1 3 km/);
    expect(body).toMatch(/1 5 km/);
    expect(body).toMatch(/2 Waitlist/);
    expect(body).toMatch(/2 \/ 4 Agreed to share/);
  });

  test('Excel: a real .xlsx with the header styled and the waitlist rows shaded', async ({ page }) => {
    await boot(page);
    await page.evaluate(`window.__x=[];const _B=window.Blob;window.Blob=function(p,o){window.__x.push({parts:p,type:o&&o.type});return new _B(p,o);};
      URL.createObjectURL=()=>'blob:x';const _a=document.createElement.bind(document);
      document.createElement=(t)=>{const el=_a(t);if(t==='a')el.click=()=>{window.__x[window.__x.length-1].name=el.download;};return el;};`);
    await page.locator('#print-opts-modal .rpt-sela-row').getByRole('button', { name: 'Excel' }).click();
    await expect.poll(() => page.evaluate('window.__x.filter(x=>x.name).length')).toBe(1);
    const f = await page.evaluate(`(()=>{const x=window.__x.find(x=>x.name);const bytes=[];x.parts.forEach(p=>bytes.push(...p));
      return{name:x.name,type:x.type,head:bytes.slice(0,2),text:new TextDecoder().decode(new Uint8Array(bytes))};})()`) as { name: string; type: string; head: number[]; text: string };
    expect(f.name).toBe('run-for-her_2099-10-17_sela.xlsx');
    expect(f.type).toContain('spreadsheetml.sheet');
    expect(f.head).toEqual([0x50, 0x4b]); // "PK": a zip
    for (const p of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) expect(f.text).toContain(p);
    expect(f.text).toContain('<c r="A1" s="1" t="inlineStr"><is><t>Runner number</t></is></c>');
    expect(f.text).toMatch(/<row r="2"><c r="A2" s="0"[^>]*><is><t>#1<\/t>/);
    expect(f.text).toMatch(/<row r="4"><c r="A4" s="2"[^>]*><is><t>#11<\/t>/);
    expect(f.text).toContain('<t>Test Waiter Two</t>');
    expect(f.text).toContain('<autoFilter ref="A1:J5"/>');
    expect(f.text).toContain('FFFEF3C7');
  });

  test('a ride night has no Report for Sela', async ({ page }) => {
    await boot(page, jcc.id);
    const m = page.locator('#print-opts-modal');
    await expect(m.locator('.modal-title')).toBeVisible();
    await expect(m.getByText('Report for Sela')).toHaveCount(0);
  });
});
