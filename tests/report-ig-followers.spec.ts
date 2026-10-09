import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Instagram followers on the reports (the owner, 2026-10-09: "i want to be able to see how many total
// instagram followers do we have from all the accounts included in the report"). The session report,
// the Saturday roster and the account report (Customers and Community) each offer a column and a
// total; an account counts once, and only for the handle it has now.

const D = '2099-02-08';
const S2 = '2099-02-14';
const sessions = [
  { id: 's0', day: 'Sunday', session_date: D, capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null },
  { id: S2, day: 'Saturday', session_date: S2, capacity: 20, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'saturday', needs_approval: true, spots: 20, bike_slots: '{"_time":"05:30 - 06:00"}' },
];
const customers = [
  { id: 'c1', name: 'Lina Haddad', socials: { instagram: 'lina.rides' }, created_at: '2026-06-10T09:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', socials: { instagram: 'omar_s' }, created_at: '2026-06-11T09:00:00Z' },
  { id: 'c3', name: 'Sara Nabil', created_at: '2026-06-12T09:00:00Z' },
  { id: 'c4', name: 'Hadi Karam', socials: { instagram: 'hadi.new' }, created_at: '2026-06-13T09:00:00Z' },
  { id: 'c5', name: 'Rana Aziz', socials: { instagram: 'rana.a' }, created_at: '2026-06-14T09:00:00Z' },
];
const customer_ig_followers = [
  { customer_id: 'c1', handle: 'lina.rides', followers: 12400, source: 'auto', counted_at: '2026-10-01T10:00:00Z', status: 'ok' },
  { customer_id: 'c4', handle: 'hadi.old', followers: 900, source: 'staff', counted_at: '2026-09-01T10:00:00Z', status: 'ok' }, // an older handle
  { customer_id: 'c5', handle: 'rana.a', followers: 600, source: 'staff', counted_at: '2026-09-01T10:00:00Z', status: 'ok' },
];
const qe = (id: string, num: number, cust: string | null, sess = 's0', extra: Record<string, unknown> = {}) => ({
  id, session_id: sess, session_day: sess === 's0' ? 'Sunday' : 'Saturday', session_date: sess === 's0' ? D : S2, queue_num: num,
  name: cust ? customers.find((c) => c.id === cust)!.name : 'Walk In', customer_id: cust, type_preference: 'Hybrid', size: 'M',
  status: 'waiting', registered_at: `2099-01-01T10:0${num}:00Z`, ...extra,
});
const queue_entries = [
  qe('q1', 1, 'c1'), qe('q2', 2, 'c1'), // two bookings, one account: counted once
  qe('q3', 3, 'c2'), qe('q4', 4, 'c4'), qe('q5', 5, null),
  qe('q6', 1, 'c5', S2), qe('q7', 2, 'c2', S2),
];

async function boot(page: Page) {
  await stubSupabase(page, { sessions, customers, queue_entries, bikes: [], tags: [], customer_tags: [], staff_options: [], customer_ig_followers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getCustomers().length===5`);
  await page.evaluate(`localStorage.removeItem('cq_rep_opts');localStorage.removeItem('cq_acc_rep_opts');S._repOpts=null;S._accOpts=null`);
}
const csvOf = (call: string) => `(async()=>{let out='';const _B=window.Blob;window.Blob=function(p){out=p.join('');return new _B(p,{type:'text/plain'});};
  const _a=document.createElement.bind(document);document.createElement=(t)=>{const el=_a(t);if(t==='a')el.click=()=>{};return el;};
  const _c=URL.createObjectURL;URL.createObjectURL=()=>'blob:x';
  try{await (0,eval)(${JSON.stringify(call)});}finally{window.Blob=_B;document.createElement=_a;URL.createObjectURL=_c;}return out;})()`;
const printed = (call: string) => `(async()=>{let html='';const real=window._openReport;window._openReport=(h)=>{html=h;return {};};
  const orig=window.open;window.open=()=>({document:{write:(h)=>{html=h;},close(){}},focus(){},print(){}});
  try{await (0,eval)(${JSON.stringify(call)});}finally{window._openReport=real;window.open=orig;}return html;})()`;

test.describe('@staff instagram followers on reports', () => {
  test('the account report: the builder adds them up, and the sheet and the file carry the column and the total', async ({ page }) => {
    await boot(page);
    await page.evaluate(`showAccountReportOptions()`);
    const m = page.locator('#print-opts-modal');
    await expect(m).toContainText('Total Instagram followers');
    // c1 12,400 + c5 600; c4's count is for an older handle; c2 has none yet; c3 no Instagram
    await expect(m.locator('#acr-ig')).toContainText('Instagram followers: 13,000 · 2 of 4 accounts with Instagram counted');
    await page.evaluate(`_closePrintOpts();const o=_accOpts();o.cols.igFollowers=1;o.sections.ig=1`);
    const html = await page.evaluate(printed('printAccountReport()')) as string;
    expect(html).toContain('13,000');
    expect(html).toContain('2 of 4 accounts with Instagram counted');
    expect(html).toContain('<th>Instagram followers</th>');
    const csv = await page.evaluate(csvOf('exportAccountsCsv()')) as string;
    expect(csv).toContain('Instagram followers,13000,2 of 4 accounts with Instagram counted');
    expect(csv).toMatch(/Lina Haddad[^\n]*12400/);
  });

  test('the account report leaves both out until they are ticked', async ({ page }) => {
    await boot(page);
    await page.evaluate(`_igFetch()`);
    const html = await page.evaluate(`_accReportHtml()`) as string;
    expect(html).not.toContain('accounts with Instagram counted');
    expect(html).not.toContain('<th>Instagram followers</th>');
  });

  test('the session report: one count per account, walk-ins have none, the builder and the file agree', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.sfSession='s0';showPrintReportOptions()`);
    const m = page.locator('#print-opts-modal');
    await expect(m.locator('#rep-ig')).toContainText('Instagram followers: 12,400 · 1 of 3 accounts with Instagram counted');
    await page.evaluate(`_closePrintOpts();const o=_repOpts();o.cols.ig=1;o.sections.ig=1`);
    const html = await page.evaluate(printed('printSessionReport()')) as string;
    expect(html).toContain('12,400');
    expect(html).toContain('1 of 3 accounts with Instagram counted');
    expect(html).toContain('<th>Instagram followers</th>');
    const csv = await page.evaluate(csvOf('exportSessionExcel()')) as string;
    expect(csv).toContain('Instagram followers,12400,1 of 3 accounts with Instagram counted');
  });

  test('the Saturday roster carries them too', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.sfSession='${S2}';showPrintReportOptions()`);
    await expect(page.locator('#rep-ig')).toContainText('Instagram followers: 600 · 1 of 2 accounts with Instagram counted');
    await page.evaluate(`_closePrintOpts();const o=_repOpts();o.cols.ig=1;o.sections.ig=1`);
    const html = await page.evaluate(printed('printSessionReport()')) as string;
    expect(html).toContain('<th>Instagram followers</th>');
    expect(html).toContain('1 of 2 accounts with Instagram counted');
    const csv = await page.evaluate(csvOf('exportSessionExcel()')) as string;
    expect(csv).toContain('Instagram followers,600,1 of 2 accounts with Instagram counted');
  });
});
