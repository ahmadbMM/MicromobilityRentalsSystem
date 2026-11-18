import { readFileSync } from 'fs';
import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The People round (the user's picks, 2026-11-18: "2 3 5 6 7 8"; migration 20261118210000): watch a person (a bell line
// when they book or arrive), family links (and Book for the family), rides with, the last bike (the account window and
// the check-in drawer), download their data (admins) and the account owner (My people, and follow-ups for the owner).
// Invented people only; the clock is fixed on the night's evening.

const DAY = '2099-05-05';
const PAST = '2099-04-28';
const PAST2 = '2099-04-21';
const NOW = new Date(`${DAY}T20:00:00+03:00`);
const sess = (id: string, date: string, title: string) => ({ id, day: 'Tuesday', session_date: date, capacity: 12, status: 'open', created_at: 1, title, bike_slots: JSON.stringify({ _time: '20:00 - 23:00' }) });
const sessions = [sess('s0', DAY, 'Tuesday social'), sess('s1', PAST, 'Tuesday social'), sess('s2', PAST2, 'Tuesday social')];
const row = (id: string, sid: string, date: string, qn: number, name: string, type: string, status: string, cid: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: sid, session_day: 'Tuesday', session_date: date, queue_num: qn, name, phone: '', email: '', customer_id: cid, group_id: null,
  status, paid: true, price: 75, walk_in: false, registered_at: `${date}T15:00:00Z`, height: 175, size: 'L', type_preference: type, ...extra,
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rows = [
  // a week ago: Amal, the son she booked for and Rana, in one group
  row(id(1), 's1', PAST, 1, 'Amal Road', 'Road', 'done', 'cust-amal', { group_id: 'g1', size: 'M', checked_in_at: `${PAST}T17:10:00Z` }),
  row(id(2), 's1', PAST, 2, 'Sami Road', 'Hybrid', 'done', 'cust-amal', { group_id: 'g1', size: 'S' }),
  row(id(3), 's1', PAST, 3, 'Rana Hybrid', 'Hybrid', 'done', 'cust-rana', { group_id: 'g1' }),
  // two weeks ago: Amal and Rana again
  row(id(4), 's2', PAST2, 1, 'Amal Road', 'Hybrid', 'done', 'cust-amal', { group_id: 'g2', size: 'L', checked_in_at: `${PAST2}T17:10:00Z` }),
  row(id(5), 's2', PAST2, 2, 'Rana Hybrid', 'Hybrid', 'done', 'cust-rana', { group_id: 'g2' }),
  // tonight: Amal is waiting at the desk, Rana booked this afternoon and is on a bike
  row(id(6), 's0', DAY, 1, 'Amal Road', 'Road', 'waiting', 'cust-amal'),
  row(id(7), 's0', DAY, 2, 'Rana Hybrid', 'Hybrid', 'active', 'cust-rana', { checked_in_at: `${DAY}T16:30:00Z` }),
];
const customers = [
  { id: 'cust-amal', name: 'Amal Road', phone: '0500000011', email: 'amal@example.test', created_at: '2026-01-01T00:00:00Z', height: 168 },
  { id: 'cust-rana', name: 'Rana Hybrid', phone: '0500000022', email: 'rana@example.test', created_at: '2026-01-01T00:00:00Z' },
  { id: 'cust-sami', name: 'Sami Road', phone: '0500000033', email: 'sami@example.test', created_at: '2026-01-01T00:00:00Z', height: 132, type_preference: 'Hybrid', birth_date: '2090-03-01' },
];
const head = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
const ME = 'aaaaaaaa-0000-4000-8000-00000000000a', NORA = 'bbbbbbbb-0000-4000-8000-00000000000b';
const choices = [{ user_id: ME, name: 'Desk One' }, { user_id: NORA, name: 'Nora Lead' }];

// One small table the way the server holds it: reads answer the rows, an upsert or update comes back as the rows
// it wrote (with what the triggers stamp), a delete as the rows it took.
async function serveTable(page: Page, table: string, held: Record<string, unknown>[], key: string, stamp: (x: Record<string, unknown>) => Record<string, unknown> = (x) => x) {
  const sent: { m: string; b: unknown; url: string }[] = [];
  await page.route(new RegExp(`/rest/v1/${table}(\\?|$)`), async (r: Route) => {
    const m = r.request().method(), url = r.request().url();
    if (m === 'GET') return r.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${held.length}/${held.length}` }, body: JSON.stringify(held) });
    const b = m === 'DELETE' ? null : r.request().postDataJSON();
    sent.push({ m, b, url });
    if (m === 'POST') {
      const list = (Array.isArray(b) ? b : [b]).map((x: Record<string, unknown>) => stamp({ ...x }));
      list.forEach((x) => { const i = held.findIndex((h) => h[key] === x[key]); if (i >= 0) held[i] = { ...held[i], ...x }; else held.push(x); });
      return r.fulfill({ status: 201, headers: head, body: JSON.stringify(list) });
    }
    const q = new URL(url).searchParams.get(key) || '';
    const ids = q.startsWith('in.(') ? q.slice(4, -1).split(',').map((s) => s.replace(/"/g, '')) : [q.replace('eq.', '')];
    const hit = held.filter((h) => ids.includes(String(h[key])));
    if (m === 'PATCH') { hit.forEach((h) => Object.assign(h, b)); return r.fulfill({ status: 200, headers: head, body: JSON.stringify(hit) }); }
    if (m === 'DELETE') { for (const h of hit) held.splice(held.indexOf(h), 1); return r.fulfill({ status: 200, headers: head, body: JSON.stringify(hit) }); }
    return r.fallback();
  });
  return sent;
}

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript((me) => localStorage.setItem('cq_role_uid', me), ME);
  await stubSupabase(page, { queue_entries: rows, sessions, bikes: [], customers, tags: [], customer_tags: [], 'rpc:staff_owner_choices': choices, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`typeof _prdAhSec==='function'&&typeof _prdLast==='function'`);
  await page.evaluate(`S.staffRole='admin'`);
}
const more = async (page: Page, item: string) => {
  await page.locator('#cust-modal').getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
};
const dlg = (page: Page) => page.locator('#confirm-modal [role="dialog"]');

test.describe('@staff:people the People round: watch, family, rides with, last bike, data download, owner', () => {
  test('rides with and the last bike, in the account window and the check-in drawer', async ({ page }) => {
    await boot(page);
    await page.evaluate(`openAccountHistory('cust-amal','', 'stats')`);
    const win = page.locator('#cust-modal');
    // Rana came on both group rides, the son Amal booked for on one; Amal's own row is not a companion
    const withList = win.locator('.prd-with li');
    await expect(withList).toHaveCount(2);
    await expect(withList.nth(0)).toHaveText('Rana Hybrid × 2');
    await expect(withList.nth(1)).toHaveText('Sami Road × 1');
    await withList.nth(0).getByRole('button', { name: 'Rana Hybrid' }).click();
    await expect(page.locator('#ah-title')).toHaveText('Rana Hybrid');
    // the last bike: Amal's own newest ride (a week ago, Road M), never the son's row on it
    const last = await page.evaluate(`_prdLastTxt(_prdLast('cust-amal','s0'))`);
    expect(last).toMatch(/^Road · M · /);
    await page.evaluate(`openAccountHistory('cust-amal','', 'stats')`);
    await expect(win.locator('.ah-facts')).toContainText(`Last bike: ${last}`);
    await page.evaluate(`closeCustomerProfile()`);
    // the check-in drawer of tonight's booking says it; a friend's booking on the account would not
    await page.evaluate(`setStaffTab('queue');showCheckinModal('${id(6)}')`);
    await expect(page.locator('.prd-last')).toHaveText(`Last bike: ${last}`);
    expect(await page.evaluate(`_prdLastCi({...getQueue().find(e=>e.id==='${id(6)}'),name:'Guest of Amal'})`)).toBe('');
  });

  test('watch a person: the More action, the bell lines from then on, the Accounts filter', async ({ page }) => {
    await boot(page);
    await page.evaluate(`openAccountHistory('cust-rana')`);
    await more(page, 'Watch');
    await expect.poll(() => page.evaluate(`_prdWatchList().map(x=>x[0]).join()`)).toBe('cust-rana');
    await page.locator('#cust-modal').getByRole('button', { name: /More actions/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Watch ✓', exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
    // from the moment on the list: put it three hours back, before tonight's booking (18:00) and arrival (19:30)
    await page.evaluate(`_prefSet('state.watch',[['cust-rana',Date.now()-3*36e5]])`);
    const lines = await page.evaluate(`(()=>{const o=[];_prdBell((k,items)=>o.push(...items.map(i=>i.id+' '+i.txt)),{queue:true});return o})()`);
    const ride = await page.evaluate(`_evName(_sessGet('s0'))+' · '+shortDate('${DAY}')`);
    expect(lines).toEqual([`b|cust-rana|s0 Rana Hybrid booked ${ride}`, `a|cust-rana|s0 Rana Hybrid arrived for ${ride}`]);
    expect(await page.evaluate(`_ntkOut=null,_ntKinds().some(k=>k.k==='watch'&&k.ids.length===2)`)).toBe(true); // _prdWatchTog drops the bell's cache; a pref set by hand does not
    expect(await page.evaluate(`NT_KINDS.some(k=>k[0]==='watch'&&k[2]==='community')`)).toBe(true);
    // put on the list after both: nothing
    await page.evaluate(`_prefSet('state.watch',[['cust-rana',Date.now()]])`);
    expect(await page.evaluate(`(()=>{let n=0;_prdBell((k,items)=>{n+=items.length;},{queue:true});return n})()`)).toBe(0);
    const f = await page.evaluate(`(()=>{const d=_amDefs().find(x=>x[0]==='amWatch');return[d[3]({id:'cust-rana'},'yes'),d[3]({id:'cust-amal'},'yes')]})()`);
    expect(f).toEqual([true, false]);
    // off again
    await page.evaluate(`_prdWatchTog('cust-rana')`);
    expect(await page.evaluate(`_prdWatchList().length`)).toBe(0);
  });

  test('family links: add with a role, the window lists them, Book for the family, take one out', async ({ page }) => {
    await boot(page);
    const held: Record<string, unknown>[] = [];
    const sent = await serveTable(page, 'account_family', held, 'customer_id', (x) => ({ added_by_name: 'Desk One', added_at: NOW.toISOString(), ...x }));
    await page.evaluate(`openAccountHistory('cust-amal')`);
    await more(page, 'Add to family');
    await expect(dlg(page)).toContainText('Add to family · Amal Road');
    await dlg(page).getByLabel('Role in the family').selectOption('child');
    await dlg(page).getByLabel(/Find/).fill('Sami');
    await dlg(page).locator('.prd-fhit', { hasText: 'Sami Road' }).click();
    await expect(dlg(page)).toHaveCount(0);
    const post = sent.find((s) => s.m === 'POST')!.b as Record<string, unknown>[];
    expect(post.map((x) => [x.customer_id, x.role])).toEqual([['cust-amal', null], ['cust-sami', 'child']]);
    expect(post[0].family_id).toBe(post[1].family_id);
    expect(String(post[0].family_id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const fam = page.locator('#cust-modal .prd-fam');
    await expect(fam.locator('.prd-fam-li')).toHaveCount(2);
    await expect(fam.locator('.bdg-strip-h')).toHaveText('Family 2');
    await expect(fam.getByLabel('Role in the family · Sami Road')).toHaveValue('child');
    expect(await page.evaluate(`S.fullLog.some(l=>l.label==='Family: Amal Road + Sami Road')`)).toBe(true);
    // the Accounts filter
    expect(await page.evaluate(`(()=>{const d=_amDefs().find(x=>x[0]==='amFamily');return[d[3]({id:'cust-sami'},'yes'),d[3]({id:'cust-rana'},'yes')]})()`)).toEqual([true, false]);
    // Book for the family: Amal first, the son as the other rider with his own account, height and type
    await fam.getByRole('button', { name: 'Book for the family' }).click();
    await expect(page.locator('#wi-name')).toHaveValue('Amal Road');
    await expect(page.locator('#wi-r-name-0')).toHaveValue('Sami Road');
    await expect(page.locator('#wi-r-h-0')).toHaveValue('132');
    expect(await page.evaluate(`S._wiRiders[0].custId`)).toBe('cust-sami');
    await page.evaluate(`closeWalkinModal()`);
    // out of the family: two make none, so both rows go
    await page.evaluate(`openAccountHistory('cust-amal')`);
    await fam.getByRole('button', { name: 'Remove · Sami Road' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Remove' }).click();
    await expect(fam).toHaveCount(0);
    const del = sent.find((s) => s.m === 'DELETE')!;
    expect(new URL(del.url).searchParams.get('customer_id')).toMatch(/^in\.\(.*cust-amal.*cust-sami.*\)$|^in\.\(.*cust-sami.*cust-amal.*\)$/);
  });

  // The device's copy of the family links is up to five minutes old (bug hunt 2026-11-18, ppl-rentals0-3): an account another desk
  // had put in a family meanwhile looked unlinked, and the add moved it out to a new family. The add reads the two links first.
  test('family links: an account linked on another desk meanwhile keeps its family', async ({ page }) => {
    await boot(page);
    const held: Record<string, unknown>[] = [];
    const sent = await serveTable(page, 'account_family', held, 'customer_id', (x) => ({ added_by_name: 'Desk One', added_at: NOW.toISOString(), ...x }));
    await page.evaluate(`openAccountHistory('cust-amal')`);
    await page.waitForFunction(`_prdO().got&&!_prdO().busy`);
    const F1 = '11111111-0000-4000-8000-000000000001';
    held.push({ customer_id: 'cust-amal', family_id: F1, role: 'parent', added_by_name: 'Desk Two', added_at: NOW.toISOString() },
      { customer_id: 'cust-rana', family_id: F1, role: null, added_by_name: 'Desk Two', added_at: NOW.toISOString() });
    await more(page, 'Add to family');
    await dlg(page).getByLabel('Role in the family').selectOption('child');
    await dlg(page).getByLabel(/Find/).fill('Sami');
    await dlg(page).locator('.prd-fhit', { hasText: 'Sami Road' }).click();
    await expect(dlg(page)).toHaveCount(0);
    const post = sent.find((s) => s.m === 'POST')!.b as Record<string, unknown>[];
    expect(post.map((x) => [x.customer_id, x.family_id, x.role])).toEqual([['cust-sami', F1, 'child']]);
    await expect(page.locator('#cust-modal .prd-fam .prd-fam-li')).toHaveCount(3);
  });

  test('the account owner: More > Owner, the window, My people, a follow-up for the owner and the bell', async ({ page }) => {
    await boot(page);
    const owners: Record<string, unknown>[] = [];
    const sent = await serveTable(page, 'account_owners', owners, 'customer_id', (x) => ({ ...x, owner_name: choices.find((c) => c.user_id === x.owner_id)?.name, set_by_name: 'Desk One', set_at: NOW.toISOString() }));
    const fups: Record<string, unknown>[] = [];
    const fsent = await serveTable(page, 'account_followups', fups, 'id', (x) => ({ id: 500 + fups.length, created_by_name: 'Desk One', created_at: NOW.toISOString(), done_at: null, ...x }));
    await page.evaluate(`openAccountHistory('cust-amal')`);
    await more(page, 'Owner');
    await expect(dlg(page)).toContainText('Owner · Amal Road');
    await dlg(page).getByLabel('Owner').selectOption({ label: 'Nora Lead' });
    await dlg(page).getByRole('button', { name: 'Save' }).click();
    await expect(dlg(page)).toHaveCount(0);
    expect(sent.find((s) => s.m === 'POST')!.b).toEqual({ customer_id: 'cust-amal', owner_id: NORA });
    await expect(page.locator('#cust-modal .prd-own')).toContainText('Nora Lead');
    expect(await page.evaluate(`S.fullLog.some(l=>l.label==='Owner: Amal Road · Nora Lead')`)).toBe(true);
    // My people is this staffer's; the owner's own name is an option too
    const f = await page.evaluate(`(()=>{const d=_amDefs().find(x=>x[0]==='amOwner');return[d[2].map(o=>o[1]).join('|'),d[3]({id:'cust-amal'},'me'),d[3]({id:'cust-amal'},'${NORA}'),d[3]({id:'cust-rana'},'none')]})()`);
    expect(f).toEqual(['My people|Has an owner|No owner|Nora Lead', false, true, true]);
    expect(await page.evaluate(`AM_MAIN.includes('amOwner')&&AM_FKEYS.includes('amOwner')`)).toBe(true);
    // a follow-up made on the account is for its owner unless changed
    await more(page, 'Follow up');
    await expect(dlg(page).getByLabel('For')).toHaveValue(NORA);
    await dlg(page).getByLabel('Due on').fill(DAY);
    await dlg(page).getByLabel('What to follow up on').fill('Call about the company invoice');
    await dlg(page).getByRole('button', { name: 'Save follow-up' }).click();
    await expect(dlg(page)).toHaveCount(0);
    expect(fsent.find((s) => s.m === 'POST')!.b).toEqual({ customer_id: 'cust-amal', due_on: DAY, note: 'Call about the company invoice', assignee: NORA });
    // the bell tells the staffer it is for, not this one; Mine lists it for them only
    await page.evaluate(`_fupNeed('due',0)`);
    await expect.poll(() => page.evaluate(`S._fup.rows.size`)).toBe(1);
    const bell = (me: string) => page.evaluate(`(()=>{localStorage.setItem('cq_role_uid','${me}');const o=[];_fupBell((k,items)=>o.push(...items));return o.length})()`);
    expect(await bell(ME)).toBe(0);
    expect(await bell(NORA)).toBe(1);
    await page.evaluate(`closeCustomerProfile();setStaffTab('community');S._fupV='mine';setCommTab('followups')`);
    await expect(page.locator('#tab-community .fup-li')).toHaveCount(1);
    await expect(page.locator('#tab-community .fup-li')).toContainText('For Nora Lead');
    await page.evaluate(`localStorage.setItem('cq_role_uid','${ME}');renderCommunity()`);
    await expect(page.locator('#tab-community .fup-li')).toHaveCount(0);
  });

  test('download their data: admins only, one JSON file, on the record', async ({ page }) => {
    const data = { account_id: 'cust-amal', account: { id: 'cust-amal', name: 'Amal Road' }, staff_notes: [], tables: { queue_entries: [{ id: id(1) }, { id: id(4) }] } };
    await boot(page, { 'rpc:staff_customer_export': data });
    await page.evaluate(`openAccountHistory('cust-amal')`);
    const [file] = await Promise.all([page.waitForEvent('download'), more(page, 'Download their data')]);
    expect(file.suggestedFilename()).toBe(`Amal-Road-data-${DAY}.json`);
    const path = await file.path();
    const body = JSON.parse(readFileSync(path, 'utf8'));
    expect(body.tables.queue_entries).toHaveLength(2);
    expect(await page.evaluate(`S.fullLog.some(l=>l.label==='Account data downloaded: Amal Road')`)).toBe(true);
    // not an admin: no such action
    await page.evaluate(`S.staffRole='frontdesk';openAccountHistory('cust-amal')`);
    await page.locator('#cust-modal').getByRole('button', { name: /More actions/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Download their data', exact: true })).toHaveCount(0);
  });
});
