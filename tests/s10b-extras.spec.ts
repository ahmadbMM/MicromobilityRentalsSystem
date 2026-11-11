import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff round s10, second batch "extras" (2026-11-11): follow-up reminders on a person (account_followups, migration
// 20261111180700: More > Follow up on the account window, its open ones there, People > Activity > Follow-ups with Mark
// done, a bell line when due, a count in the Dashboard's "Waiting on the office"), the WhatsApp sent log (a wa.me tap
// writes one shared log line, kind 'whatsapp', shown on the account window as Messages sent and in History > Log's
// WhatsApp pill) and the search operators (tag: type: status: paid: size: session: phone: email:) in Ctrl K and the
// list searches. Invented people only; the clock is fixed on the night's evening.

const DAY = '2099-05-05';
const YDAY = '2099-05-04';
const NOW = new Date(`${DAY}T20:00:00+03:00`);
const session = { id: 's0', day: 'Tuesday', session_date: DAY, capacity: 12, status: 'open', created_at: 1, title: 'Tuesday social', bike_slots: JSON.stringify({ _time: '20:00 - 23:00' }) };
const row = (id: string, qn: number, name: string, type: string, status: string, cid: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Tuesday', session_date: DAY, queue_num: qn, name, phone: '', email: '', customer_id: cid, group_id: null,
  status, paid: true, price: 75, walk_in: false, registered_at: `${DAY}T15:00:00Z`, height: 175, size: 'L', type_preference: type, ...extra,
});
const A = 'aaaa1111-0000-4000-8000-0000000000a1', B = 'bbbb2222-0000-4000-8000-0000000000b2', C = 'cccc3333-0000-4000-8000-0000000000c3';
const D = 'dddd4444-0000-4000-8000-0000000000d4', E = 'eeee5555-0000-4000-8000-0000000000e5';
const rows = [
  row(A, 1, 'Amal Road', 'Road', 'waiting', 'cust-amal', { phone: '0500000011', email: 'amal@example.test', size: 'M' }),
  row(B, 2, 'Badr Hybrid', 'Hybrid', 'active', 'cust-badr', { paid: false, phone: '0500000022' }),
  row(C, 3, 'Carim Road', 'Road', 'done', null),
  row(D, 4, 'Dana Kids', 'Kids', 'noshow', 'cust-dana'),
  row(E, 5, 'Eid Road', 'Road', 'waitlist', null, { waitlist_num: 1 }),
];
const customers = [
  { id: 'cust-amal', name: 'Amal Road', phone: '0500000011', email: 'amal@example.test', created_at: '2026-01-01T00:00:00Z' },
  { id: 'cust-badr', name: 'Badr Hybrid', phone: '0500000022', email: 'badr@example.test', created_at: '2026-01-01T00:00:00Z' },
  { id: 'cust-dana', name: 'Dana Kids', phone: '0500000033', email: 'dana@example.test', created_at: '2026-01-01T00:00:00Z' },
];
const tags = [{ id: 'tag_vip', slug: 'vip', name: 'VIP', color: '#a67c00', locked: true, auto_grant: false }];
const customer_tags = [{ customer_id: 'cust-amal', tag_id: 'tag_vip', added_by: 'staff', added_at: 1 }];
const head = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };

// account_followups as the server would hold it: an insert comes back stamped, an update stamps done.
async function serveFollowups(page: Page, held: Record<string, unknown>[]) {
  const sent: { m: string; b: Record<string, unknown> }[] = [];
  await page.route(/\/rest\/v1\/account_followups/, async (r: Route) => {
    const m = r.request().method();
    if (m === 'GET') return r.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${held.length}/${held.length}` }, body: JSON.stringify(held) });
    if (m === 'POST') {
      const b = r.request().postDataJSON() as Record<string, unknown>;
      sent.push({ m, b });
      const x = { ...b, id: 100 + held.length, created_by_name: 'Desk', created_at: NOW.toISOString(), done_at: null, done_by_name: null };
      held.push(x);
      return r.fulfill({ status: 201, headers: head, body: JSON.stringify([x]) });
    }
    if (m === 'PATCH') {
      const b = r.request().postDataJSON() as Record<string, unknown>;
      sent.push({ m, b });
      const id = Number(new URL(r.request().url()).searchParams.get('id')?.replace('eq.', ''));
      const x = held.find((h) => h.id === id);
      if (x) Object.assign(x, { done_at: NOW.toISOString(), done_by_name: 'Desk' });
      return r.fulfill({ status: 200, headers: head, body: JSON.stringify(x ? [x] : []) });
    }
    return r.fallback();
  });
  return sent;
}

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { queue_entries: rows, sessions: [session], bikes: [], customers, tags, customer_tags, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`typeof _sqParse==='function'&&typeof _fupAhSec==='function'`);
}

test.describe('@staff round s10b extras: follow-ups, the WhatsApp log, search operators', () => {
  test('a follow-up from the account window: the pop-up, the window, the bell, the Dashboard, People and Mark done', async ({ page }) => {
    const held: Record<string, unknown>[] = [];
    await boot(page);
    const sent = await serveFollowups(page, held);
    await page.evaluate(`setStaffTab('dashboard')`);
    // the bell has read the (empty) due list once: from now on a due follow-up is news
    await page.waitForFunction(`S._fup&&S._fup.got['due@${DAY}']`);
    await page.evaluate(`_ntSync()`);
    await page.evaluate(`openAccountHistory('cust-amal')`);
    const win = page.locator('#cust-modal');
    // More actions holds Follow up (never a button of its own in the bar)
    await win.getByRole('button', { name: /More actions/ }).click();
    await page.getByRole('menuitem', { name: 'Follow up', exact: true }).click();
    const dlg = page.locator('#confirm-modal [role="dialog"]');
    await expect(dlg).toContainText('Follow up · Amal Road');
    await expect(dlg.getByLabel('Due on')).toHaveValue('2099-05-06'); // tomorrow unless changed
    await dlg.getByRole('button', { name: 'Save follow-up' }).click();
    await expect(dlg.locator('#fup-err')).toHaveText('Write what to follow up on.');
    expect(sent).toHaveLength(0);
    await dlg.getByLabel('Due on').fill(DAY);
    await dlg.getByLabel('What to follow up on').fill('  Call about the Petromin invoice ');
    await dlg.getByRole('button', { name: 'Save follow-up' }).click();
    await expect(dlg).toHaveCount(0);
    expect(sent).toEqual([{ m: 'POST', b: { customer_id: 'cust-amal', due_on: DAY, note: 'Call about the Petromin invoice' } }]);
    // the window's Account part shows it, due today
    const sec = win.locator('.fup-ah');
    await expect(sec).toContainText('Follow-ups');
    await expect(sec).toContainText('Due today');
    await expect(sec).toContainText('Call about the Petromin invoice');
    await expect(sec).toContainText('Set by Desk');
    await expect(page.locator('.toast:not(.quiet)')).toHaveCount(0); // no bar after the save
    // the bell has a line for it
    await expect.poll(() => page.evaluate(`_ntItems().filter(i=>i.k==='fup').map(i=>i.txt).join('|')`)).toBe('Follow up with Amal Road today: Call about the Petromin invoice');
    expect(await page.evaluate(`NT_KINDS_OFF.some(k=>k[0]==='fup'&&k[2]==='community')`)).toBe(true);
    // the log took a line
    expect(await page.evaluate(`S.fullLog.some(l=>/^Follow-up: Amal Road/.test(l.label))`)).toBe(true);
    await page.evaluate(`closeCustomerProfile()`);
    // the Dashboard's "Waiting on the office" counts it
    await page.evaluate(`renderDashboard()`);
    await expect(page.locator('#tab-dashboard [data-dash="office"]')).toContainText('Follow-ups due: 1');
    // People > Activity > Follow-ups lists it with Mark done
    await page.evaluate(`setStaffTab('community');setCommTab('followups')`);
    const list = page.locator('#tab-community .fup-page');
    await expect(list.locator('.fup-li')).toHaveCount(1);
    await expect(list).toContainText('Amal Road');
    await expect(page.locator('#tab-community [data-ppl-grp="activity"]')).toHaveAttribute('aria-pressed', 'true');
    await list.getByRole('button', { name: 'Mark done' }).click();
    await expect(page.locator('#tab-community .fup-page')).toHaveCount(0);
    await expect(page.locator('#tab-community')).toContainText('No follow-ups open.');
    expect(sent[1].m).toBe('PATCH');
    expect(Object.keys(sent[1].b)).toEqual(['done_at']); // who and when are the database's to stamp
    await expect.poll(() => page.evaluate(`_ntItems().filter(i=>i.k==='fup').length`)).toBe(0);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('#tab-community .fup-page')).toContainText('Done by Desk');
  });

  test('an overdue follow-up says so in the list and the bell, and the table missing says the update is pending', async ({ page }) => {
    const held = [{ id: 7, customer_id: 'cust-badr', due_on: YDAY, note: 'Ask for the waiver photo', created_by_name: 'Sara', created_at: `${YDAY}T09:00:00Z`, done_at: null }];
    await boot(page);
    await serveFollowups(page, held);
    await page.evaluate(`setStaffTab('community');setCommTab('followups')`);
    const li = page.locator('#tab-community .fup-li');
    await expect(li).toContainText('Overdue since');
    await expect(li).toContainText('Badr Hybrid');
    await expect(li).toHaveClass(/fup-late/);
    expect(await page.evaluate(`(()=>{const o=[];_fupBell((k,items)=>o.push(...items.map(i=>i.txt)));return o.join('|')})()`)).toBe('Overdue follow-up with Badr Hybrid: Ask for the waiver photo');
  });

  test('before the database has the table, Follow up says the update is pending', async ({ page }) => {
    await boot(page);
    await page.route(/\/rest\/v1\/account_followups/, (r) => r.fulfill({ status: 404, headers: head, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table', details: null, hint: null }) }));
    await page.evaluate(`setStaffTab('community');setCommTab('followups')`);
    await expect(page.locator('#tab-community')).toContainText('Waiting for the database update');
    await page.evaluate(`_fupOpen('cust-amal')`);
    await expect(page.locator('.toast').filter({ hasText: 'Waiting for the database update' }).first()).toBeVisible();
    await expect(page.locator('#confirm-modal [role="dialog"]')).toHaveCount(0);
  });

  test('a WhatsApp tap writes one log line; the account window shows Messages sent and History > Log filters them', async ({ page }) => {
    const shared = [{ id: 1, at: `${DAY}T12:00:00Z`, action: 'WhatsApp: Reminder the day before · Amal Road', who: 'Sara', kind: 'whatsapp', entity: 'booking', entity_id: A, client_id: 'other-1' }];
    await boot(page, { staff_actions: shared });
    const posted: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/rest\/v1\/staff_actions/.test(r.url())) posted.push(r.postDataJSON()); });
    // the tab WhatsApp opens is not this test's business
    await page.evaluate(`document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('a[href*="wa.me"]'))e.preventDefault();})`);
    await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
    const link = page.locator(`[data-id="${A}"] a[aria-label="WhatsApp"]`).first();
    await link.click();
    await expect.poll(() => page.evaluate(`(S.fullLog.filter(l=>l.m&&l.m.kind==='whatsapp').pop()||{}).label`)).toBe('WhatsApp: Your turn is coming · Amal Road');
    expect(await page.evaluate(`S.fullLog.filter(l=>l.m&&l.m.kind==='whatsapp').pop().m`)).toEqual({ kind: 'whatsapp', entity: 'booking', entity_id: A });
    await expect.poll(() => posted.filter((p) => p.kind === 'whatsapp').length).toBe(1);
    expect(posted.find((p) => p.kind === 'whatsapp')).toMatchObject({ action: 'WhatsApp: Your turn is coming · Amal Road', entity: 'booking', entity_id: A });
    expect(typeof posted.find((p) => p.kind === 'whatsapp')?.client_id).toBe('string');
    // the account window's own WhatsApp: on the account
    await page.evaluate(`openAccountHistory('cust-amal')`);
    const win = page.locator('#cust-modal');
    await win.locator('.n6p-bar a[href^="https://wa.me/"]').first().click();
    await expect.poll(() => page.evaluate(`(S.fullLog.filter(l=>l.m&&l.m.kind==='whatsapp').pop()||{}).m`)).toEqual({ kind: 'whatsapp', entity: 'account', entity_id: 'cust-amal' });
    // Messages sent: this device's two lines and the other desk's, who sent which
    const sec = win.locator('.wal-ah');
    await expect(sec.locator('.wal-li')).toHaveCount(3);
    await expect(sec).toContainText('Messages sent');
    await expect(sec).toContainText('message · Amal Road'); // (the clock is frozen: all three share a minute, so no order to check)
    await expect(sec).toContainText('Your turn is coming · Amal Road');
    await expect(sec).toContainText('Reminder the day before · Amal Road');
    await expect(sec).toContainText('Sara');
    await expect(sec).toContainText('Spec Staff');
    // a helper that opens the chat itself (a reminder, a waitlist offer) says what it sent
    await page.evaluate(`_waLog('https://wa.me/966500000022',{t:'wl_offer',b:'${B}'})`);
    expect(await page.evaluate(`S.fullLog.filter(l=>l.m&&l.m.kind==='whatsapp').pop().label`)).toBe('WhatsApp: A waitlist place to claim · Badr Hybrid');
    // a share with no number is no message to a rider
    const n = await page.evaluate(`S.fullLog.length`);
    await page.evaluate(`_waLog('https://wa.me/?text=hello',null)`);
    expect(await page.evaluate(`S.fullLog.length`)).toBe(n);
    await page.evaluate(`closeCustomerProfile()`);
    // History > Log: the WhatsApp pill
    await page.evaluate(`setStaffTab('history');S.histView='log';renderHistory()`);
    await page.locator('#tab-history').getByRole('button', { name: 'WhatsApp', exact: true }).click();
    const lines = page.locator('#tab-history .lg-chip').filter({ hasText: 'WhatsApp' });
    await expect.poll(() => lines.count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator('#tab-history')).not.toContainText('Follow-up');
  });

  test('search operators: each one, with words, in Arabic, unknown ones as text, Ctrl K, the lists, the tips', async ({ page }) => {
    await boot(page);
    const hits = (q: string) => page.evaluate(`getQueue().filter(e=>_searchHit(e,${JSON.stringify(q)})).map(e=>e.name).sort().join(',')`);
    expect(await hits('tag:vip')).toBe('Amal Road');
    expect(await hits('type:road')).toBe('Amal Road,Carim Road,Eid Road');
    expect(await hits('type:road amal')).toBe('Amal Road'); // with words
    expect(await hits('status:waiting')).toBe('Amal Road');
    expect(await hits('status:onbike')).toBe('Badr Hybrid');
    expect(await hits('status:done')).toBe('Carim Road');
    expect(await hits('status:noshow')).toBe('Dana Kids');
    expect(await hits('status:waitlist')).toBe('Eid Road');
    expect(await hits('paid:no')).toBe('Badr Hybrid');
    expect(await hits('paid:yes type:hybrid')).toBe('');
    expect(await hits('size:m')).toBe('Amal Road');
    expect(await hits(`session:${DAY} status:noshow`)).toBe('Dana Kids');
    expect(await hits('session:"tuesday social" size:m')).toBe('Amal Road');
    expect(await hits('session:2099-06')).toBe('');
    expect(await hits('phone:0500000022')).toBe('Badr Hybrid');
    expect(await hits('email:amal@')).toBe('Amal Road');
    expect(await hits('حالة:راكب')).toBe('Badr Hybrid'); // Arabic names
    expect(await hits('مدفوع:لا')).toBe('Badr Hybrid');
    expect(await hits('status:')).toBe('Amal Road,Badr Hybrid,Carim Road,Dana Kids,Eid Road'); // still being typed: asks nothing
    expect(await hits('foo:bar')).toBe(''); // not an operator: plain text, which nobody's name holds
    // accounts: their own tags, numbers and emails, a booking's operators through their bookings
    const accts = (q: string) => page.evaluate(`S.customers.filter(c=>_dkXAcctHit(c,${JSON.stringify(q)})).map(c=>c.name).sort().join(',')`);
    expect(await accts('tag:vip')).toBe('Amal Road');
    expect(await accts('status:noshow')).toBe('Dana Kids');
    expect(await accts('phone:0500000033 dana')).toBe('Dana Kids');
    expect(await accts('email:badr')).toBe('Badr Hybrid');
    // Bookings' own search box: the rows the operators name, no party mates pulled in
    await page.evaluate(`setStaffTab('queue');setSfSession('s0')`);
    await page.locator('#sf-search-input').fill('paid:no');
    await expect(page.locator(`#q-results [data-id="${B}"]`).first()).toBeVisible();
    await expect(page.locator(`#q-results [data-id="${A}"]`)).toHaveCount(0);
    // Ctrl K: bookings and accounts answering them
    expect(await page.evaluate(`_gsHits('status:noshow').map(h=>h.k+':'+h.l).join('|')`)).toBe('gsKindBooking:#4 Dana Kids|gsKindAccount:Dana Kids');
    // an office list's own row (Workshop, Messages, Ambassadors, Team, Badge requests)
    expect(await page.evaluate(`_wsHit({id:9,name:'Fixer',phone:'0500000044',status:'ready'},'phone:0500000044 status:ready')`)).toBe(true);
    expect(await page.evaluate(`_wsHit({id:9,name:'Fixer',phone:'0500000044',status:'ready'},'status:completed')`)).toBe(false);
    // the tips: the ? sheet and the palette while its bar is empty
    await page.evaluate(`_kbHelp()`);
    await expect(page.locator('#confirm-modal .kb-list')).toContainText('Search tips: tag:vip');
    await page.evaluate(`closeConfirm();S._gsQ='';_gsOpen()`);
    await expect(page.locator('#gs-tips')).toBeVisible();
    await page.locator('#gs-input').fill('tag:vip');
    await expect(page.locator('#gs-tips')).toBeHidden();
    await expect(page.locator('#gs-results .gs-item').first()).toContainText('Amal Road');
    // never on a rider's screen
    expect(await page.evaluate(`(()=>{const v=S.view;S.view='customer';const r=_sqOf('tag:vip');S.view=v;return r})()`)).toBe(null);
  });
});
