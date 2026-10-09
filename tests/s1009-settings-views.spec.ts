import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Saved views, History's own dates, Messages assignment, the Dashboard's targets, retention and the
// lists that used to live on one device (2026-10-09).

const tomorrow = (() => { const d = new Date(Date.now() + 864e5); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); })();
const sessions = [
  { id: '2026-01-05', day: 'Monday', session_date: '2026-01-05', capacity: 12, status: 'closed', created_at: 1 },
  { id: '2026-02-10', day: 'Tuesday', session_date: '2026-02-10', capacity: 12, status: 'closed', created_at: 2 },
];
const q = (id: string, sid: string, name: string) => ({ id, session_id: sid, session_day: 'Monday', session_date: sid, queue_num: 1, name, phone: '0500000001', status: 'done', paid: true, price: 75, type_preference: 'Road', registered_at: '2026-01-01T10:00:00Z' });
const writes = (page: Page, table: string) => {
  const out: { method: string; body: unknown }[] = [];
  page.on('request', (r) => { if (['PATCH', 'POST', 'DELETE'].includes(r.method()) && r.url().includes(`/rest/v1/${table}`)) { let b: unknown = null; try { b = r.postDataJSON(); } catch { /* none */ } out.push({ method: r.method(), body: b }); } });
  return out;
};
async function boot(page: Page, fx: Record<string, unknown> = {}, init?: () => void) {
  await stubSupabase(page, { sessions, queue_entries: [q('a', '2026-01-05', 'January Rider'), q('b', '2026-02-10', 'February Rider')], bikes: [], staff_options: [], ...fx });
  await unlockStaff(page);
  if (init) await page.addInitScript(init);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@staff:history saved views and dates', () => {
  test('History takes any two days; a saved private view brings the filters back', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('history');setHistRange('custom');setHistDates('histFrom','2026-02-01');setHistDates('histTo','2026-02-28')`);
    expect(await page.evaluate(`_histRows().filtered.map(e=>e.name)`)).toEqual(['February Rider']);
    // the wrong way round reads the right way
    await page.evaluate(`setHistDates('histFrom','2026-01-31');setHistDates('histTo','2026-01-01')`);
    expect(await page.evaluate(`_histRows().filtered.map(e=>e.name)`)).toEqual(['January Rider']);
    // save it as a view, move away, pick it again
    await page.locator('#tab-history .sv-save').click();
    await page.fill('#sv-name', 'January');
    await page.click('#sv-ok');
    await expect.poll(() => page.evaluate(`_savedViews('history').map(v=>v.name)`)).toEqual(['January']);
    await page.evaluate(`setHistRange('all')`);
    const id = await page.evaluate(`_savedViews('history')[0].id`);
    await page.evaluate(`_svPick('history',${JSON.stringify(id)})`);
    expect(await page.evaluate('[S.histRange,S.histFrom,S.histTo]')).toEqual(['custom', '2026-01-31', '2026-01-01']);
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_views')).length`)).toBe(1);
  });

  test('a view shared with the team is written to staff_options views', async ({ page }) => {
    await boot(page);
    const w = writes(page, 'staff_options');
    await page.evaluate(`setStaffTab('history')`);
    await page.evaluate(`S.histStatus='noshow';renderHistory()`);
    await page.locator('#tab-history .sv-save').click();
    await page.fill('#sv-name', 'No shows');
    await page.check('#sv-shared');
    await page.click('#sv-ok');
    await expect.poll(() => w.length).toBe(1);
    const body = w[0].body as { key: string; items: { name: string; sec: string; state: Record<string, unknown> }[] };
    expect(body.key).toBe('views');
    expect(body.items[0]).toMatchObject({ name: 'No shows', sec: 'history', state: { histStatus: 'noshow' } });
  });

  test('_svGet and _svSet read and set a section filter state', async ({ page }) => {
    await boot(page);
    await page.evaluate(`_svSet('queue',{sfStatus:'waiting',sfPay:'pending',nope:1})`);
    expect(await page.evaluate(`[S.sfStatus,S.sfPay,S.nope,_svGet('queue').sfPay]`)).toEqual(['waiting', 'pending', undefined, 'pending']);
  });
});

test.describe('@staff:messages assignment', () => {
  const msg = { id: 7, created_at: '2026-10-08T08:00:00Z', kind: 'help', topic: 'booking', name: 'Asker', company: null, email: 'a@example.com', phone: null, message: 'Hello', lang: 'en', customer_id: null, status: 'replied', staff_notes: null, updated_at: '2026-10-08T10:00:00Z', updated_by: 'Spec Staff', assigned_to: null, first_reply_at: '2026-10-08T09:30:00Z' };
  test('a message is assigned to an operator and shows how long the first reply took', async ({ page }) => {
    await boot(page, { site_messages: [msg], team_members: [{ name: 'Huda' }] });
    const w = writes(page, 'site_messages');
    await page.evaluate(`S.teamMembers=['Huda','Spec Staff'];setStaffTab('messages');_sm().filter='all';renderMessages()`);
    const row = page.locator('.sm-row[data-sm-id="7"]');
    await expect(row.locator('.ca-when')).toContainText('first reply after 1.5 h');
    await row.locator('.sm-assign select').selectOption('Huda');
    await expect.poll(() => w.length).toBe(1);
    expect(w[0]).toMatchObject({ method: 'PATCH', body: { assigned_to: 'Huda' } });
  });
});

test.describe('@staff:dashboard targets', () => {
  test('the Dashboard shows this month against the targets, and nothing without them', async ({ page }) => {
    const today = tomorrow.slice(0, 8) + '01';
    await boot(page, { sessions: [{ id: today, day: 'Monday', session_date: today, capacity: 10, status: 'closed', created_at: 1 }], queue_entries: [{ ...q('c', today, 'Done Rider'), session_date: today, rating_exp: 9 }] });
    await page.evaluate(`setStaffTab('dashboard')`);
    await expect(page.locator('.kpi-card')).toHaveCount(0);
    await page.evaluate(`S._staffAuthed=true;S.staffOptions={biz:{kpi_targets:{rides:4,rating:9}}};_listOk.opts=true;_bizFromOpts();renderDashboard()`);
    const card = page.locator('.kpi-card');
    await expect(card.locator('[data-kpi="rides"] .kpi-top b')).toHaveText(todayOk(today) ? '1 / 4' : '0 / 4');
    await expect(card.locator('[data-kpi="rides"] .kpi-bar')).toHaveAttribute('aria-valuenow', todayOk(today) ? '25' : '0');
    await expect(card.locator('[data-kpi]')).toHaveCount(2);
  });
});
function todayOk(first: string) { return first <= new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); }

test.describe('@staff:settings retention', () => {
  test('Preview shows what would go; Purge now asks, then runs staff_purge_old', async ({ page }) => {
    await boot(page, { 'rpc:staff_purge_preview': { staff_actions: 3, customer_activity: 0, audit_log: 2, site_content_history: 0, error_log: 9, anon: 0 }, 'rpc:staff_purge_old': { staff_actions: 3, audit_log: 2, error_log: 9, anon: 0 } });
    const purged: string[] = [];
    page.on('request', (r) => { if (/rpc\/staff_purge_old/.test(r.url())) purged.push('x'); });
    await page.evaluate(`confirmDialog=(o)=>o.onConfirm&&o.onConfirm();S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();setStaffTab('settings');setSettingsView('business')`);
    await page.click('#ret-preview');
    await expect(page.locator('.ret-prev')).toContainText('Action log 3');
    await page.click('#ret-purge');
    await expect.poll(() => purged.length).toBe(1);
  });
});

test.describe('@staff:inventory shared lists', () => {
  test("this device's own lists are added to the shared ones once, merged", async ({ page }) => {
    await boot(page, { staff_options: [{ key: 'inv_cats_eq', items: ['Gloves'] }] }, () => {
      localStorage.setItem('cq_inv_cats_eq', JSON.stringify(['Lights', 'Gloves']));
      localStorage.setItem('cq_protein_subtypes', JSON.stringify(['Brownies']));
    });
    const w = writes(page, 'staff_options');
    await page.evaluate(`S._staffAuthed=true;_listOk.opts=true;_bizFromOpts()`);
    await expect.poll(() => w.length).toBe(2);
    const keys = w.map((x) => (x.body as { key: string; items: string[] }));
    expect(keys.find((k) => k.key === 'inv_cats_eq')!.items).toEqual(['Gloves', 'Lights']);
    expect(keys.find((k) => k.key === 'protein_subtypes_own')!.items).toEqual(['Brownies']);
    await expect.poll(() => page.evaluate(`localStorage.getItem('cq_devopt_moved')`)).toBe('1');
    expect(await page.evaluate('S.invCatsEquip')).toEqual(['Gloves', 'Lights']);
    // a second load writes nothing more
    await page.evaluate(`_devOptSync()`);
    await page.waitForTimeout(300);
    expect(w.length).toBe(2);
  });
});
