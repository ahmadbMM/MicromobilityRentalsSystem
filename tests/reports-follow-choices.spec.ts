import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The account report and the session exports, and the numbers they print:
//   - on a KSA device the "Joined" chart began a month early and never had the current month;
//   - a saved filter whose choice no longer exists emptied the report while its select read "All";
//   - the printed filter line showed stored values ('rode', '14no') instead of the labels;
//   - "Spent" counted bookings that were paid and then cancelled;
//   - the session Excel ignored the export dialog's filters, columns and sections;
//   - the close-out printed its rider count as money ("SAR 45");
//   - an old split whose card slice covered add-ons printed a negative cash figure.

test.use({ timezoneId: 'Asia/Riyadh' });

const D = '2099-02-08';
const sessions = [{ id: 's0', day: 'Sunday', session_date: D, capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null }];
const qe = (id: string, num: number, name: string, extra: Record<string, unknown>) => ({
  id, session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: num, name,
  phone: `05000000${num}`, email: `${id}@example.test`, customer_id: null, type_preference: 'Hybrid', size: 'M',
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});

async function boot(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, { sessions, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
/** The CSV exportSessionExcel / exportAccountsCsv hands to the browser, without a download. */
const csvOf = (call: string) => `(async()=>{let out='';const _B=window.Blob;window.Blob=function(p){out=p.join('');return new _B(p,{type:'text/plain'});};
  const _a=document.createElement.bind(document);document.createElement=(t)=>{const el=_a(t);if(t==='a')el.click=()=>{};return el;};
  const _c=URL.createObjectURL;URL.createObjectURL=()=>'blob:x';
  try{await (0,eval)(${JSON.stringify(call)});}finally{window.Blob=_B;document.createElement=_a;URL.createObjectURL=_c;}return out;})()`;
const printed = (call: string) => `(()=>{let html='';const real=window._openReport;window._openReport=(h)=>{html=h;};
  const orig=window.open;window.open=()=>({document:{write:(h)=>{html=h;},close(){}},focus(){},print(){}});
  try{${call};}finally{window._openReport=real;window.open=orig;}return html;})()`;

test.describe('the account report', () => {
  const customers = [
    { id: 'c1', name: 'Amal Now', created_at: new Date().toISOString(), city: 'Jeddah' },
    { id: 'c2', name: 'Bader Before', created_at: '2020-01-01T10:00:00Z', city: 'Jeddah' },
  ];
  const account = async (page: Page, extra: Record<string, unknown> = {}) => {
    await boot(page, { customers, tags: [], customer_tags: [], queue_entries: [], ...extra });
    await page.waitForFunction(`getCustomers().length===2`);
  };

  test('the Joined chart ends on the current month, with this month\'s sign-ups on it', async ({ page }) => {
    await account(page);
    const r = await page.evaluate(`(()=>{const it=_accBreakdown('joined',_accRows(),_accOpts());
      return {n:it.length,last:it[it.length-1],want:new Date().toLocaleDateString(_locale(),{month:'short',year:'2-digit',timeZone:'Asia/Riyadh'})};})()`) as { n: number; last: { label: string; value: number }; want: string };
    expect(r.n).toBe(12);
    expect(r.last.label).toBe(r.want);
    expect(r.last.value).toBe(1);
  });

  test('a saved tag filter for a tag that is gone is dropped when the builder opens', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cq_acc_rep_opts', JSON.stringify({ fTag: 'tag_deleted', fCity: 'Nowhere' })));
    await account(page);
    await page.evaluate(`S._accOpts=null;showAccountReportOptions()`);
    await expect(page.locator('#acr-count')).toContainText('2 / 2');
    expect(await page.evaluate(`[_accOpts().fTag,_accOpts().fCity]`)).toEqual(['all', 'all']);
  });

  test('the printed filter line reads the choices, not their stored values', async ({ page }) => {
    await account(page);
    const html = await page.evaluate(printed(`S._accOpts=null;Object.assign(_accOpts(),{fRides:'never',fActive:'14no'});printAccountReport()`)) as string;
    expect(html).toContain('Rides: Never rode');
    expect(html).toContain('Last active: No booking in the last 14 days');
    expect(html).not.toMatch(/: (never|14no)\b/);
  });

  test('Spent leaves out a booking that was paid and then cancelled', async ({ page }) => {
    await account(page, {
      queue_entries: [
        qe('q1', 1, 'Amal Now', { customer_id: 'c1', status: 'done', paid: true, price: 57.5 }),
        qe('q2', 2, 'Amal Now', { customer_id: 'c1', status: 'cancelled', paid: true, price: 75 }),
      ],
    });
    expect(await page.evaluate(`_accRows().find(r=>r.c.id==='c1').cells.spent`)).toBe('57.5');
  });
});

test.describe('the session exports', () => {
  const rows = [
    qe('e1', 1, 'Paid Rider', { status: 'done', paid: true, price: 57.5, pay_method: 'card' }),
    qe('e2', 2, 'Unpaid Rider', { status: 'done', paid: false, price: 57.5 }),
    qe('e3', 3, 'Paid NoShow', { status: 'noshow', paid: true, price: 57.5, pay_method: 'card' }),
    qe('e4', 4, 'Old Split', { status: 'done', paid: true, price: 57.5, pay_method: 'split', card_amount: 80 }),
  ];
  const excel = (opts: string) => csvOf(`S._repOpts=null;Object.assign(_repOpts(),${opts});S.sfSession='s0';exportSessionExcel()`);

  test('the Excel carries the riders the dialog asked for', async ({ page }) => {
    await boot(page, { queue_entries: rows });
    const pending = await page.evaluate(excel(`{fPay:'pending'}`)) as string;
    expect(pending).toContain('Unpaid Rider');
    expect(pending).not.toContain('Paid Rider');
    const noshow = await page.evaluate(excel(`{fStatus:'noshow'}`)) as string;
    expect(noshow).toContain('Paid NoShow'); // a paid no-show used to be missing from the file altogether
    expect(noshow).not.toContain('Unpaid Rider');
  });

  test('the Excel has the ticked columns only', async ({ page }) => {
    await boot(page, { queue_entries: rows });
    const off = await page.evaluate(excel(`{cols:{..._repDefaults().cols,phone:0,payment:0}}`)) as string;
    const head = off.replace(/^\uFEFF/, '').split('\n')[0];
    expect(head).not.toContain('Phone');
    expect(head).not.toContain('Payment');
    const on = await page.evaluate(excel(`{cols:{..._repDefaults().cols,phone:1}}`)) as string;
    expect(on.split('\n')[0]).toContain('Phone');
    expect(on).toContain('e2@example.test');
  });

  test('the close-out prints the rider count as a count', async ({ page }) => {
    await boot(page, { queue_entries: rows });
    const html = await page.evaluate(printed(`S._ctSession='s0';printCloseout()`)) as string;
    expect(html).toMatch(/Total Riders<\/span><strong[^>]*>\d+<\/strong>/);
  });

  test('an old split whose card slice also paid add-ons does not print a negative cash figure', async ({ page }) => {
    await boot(page, { queue_entries: [rows[3]] });
    const html = await page.evaluate(printed(`S._repOpts=null;S.sfSession='s0';printSessionReport()`)) as string;
    // Card and Cash are tiles of their own since 2026-10-01
    expect(html).toMatch(/SAR 57\.50<\/bdi><\/span><span class="total-lbl">Card</);
    expect(html).toMatch(/SAR 0\.00<\/bdi><\/span><span class="total-lbl">Cash</);
    expect(html).not.toMatch(/SAR -\d/);
  });

  test('a printed sheet is titled with the ride\'s own name', async ({ page }) => {
    const sat = { id: 'sat', day: 'Saturday', session_date: D, capacity: 20, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'saturday', needs_approval: true, spots: 20, title: null };
    await boot(page, { sessions: [...sessions, sat], queue_entries: [...rows, { ...qe('s1', 1, 'Sat Rider', { status: 'waiting', approval: 'approved' }), session_id: 'sat' }] });
    const roster = await page.evaluate(printed(`S._repOpts=null;S.sfSession='sat';printSessionReport()`)) as string;
    const [named, umbrella] = await page.evaluate(`[t('evSatName'),t('landCommTitle')]`) as string[];
    expect(roster).toContain(named);
    expect(roster).not.toContain(umbrella);
    const jcc = await page.evaluate(printed(`S._repOpts=null;S.sfSession='s0';printSessionReport()`)) as string;
    expect(jcc).toContain('Jeddah Corniche Circuit');
  });
});
