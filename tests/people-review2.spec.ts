import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// People, second review (2026-11-06): a likely duplicate while making an account, Needs you today, the find box's keys
// and booking numbers, the timeline, last messaged, profile completeness, member facts, clearer labels, no-show strikes
// and wallet fees behind their Settings switches.

const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const TD = day(0), P1 = day(-7), P2 = day(-20);
const slots = (time: string) => JSON.stringify({ _time: time, _total: 40 });
const sessions = [
  { id: TD, day: 'Tuesday', session_date: TD, capacity: 40, status: 'open', created_at: 0, bike_slots: slots('21:00 - 23:00') },
  { id: P1, day: 'Sunday', session_date: P1, capacity: 40, status: 'open', created_at: 1, bike_slots: slots('21:00 - 23:00') },
  { id: P2, day: 'Monday', session_date: P2, capacity: 40, status: 'open', created_at: 2, bike_slots: slots('21:00 - 23:00') },
];
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551874471', gender: 'female', birth_date: '1995-02-01', nationality: 'SA', height: 165, created_at: '2026-06-10T09:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', created_at: '2026-06-11T09:00:00Z' },
];
const row = (id: string, s: { id: string; day: string; session_date: string }, qn: number, name: string, customer_id: string | null, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: s.id, session_day: s.day, session_date: s.session_date, queue_num: qn, name,
  phone: '+966551874471', customer_id, status, paid: false, type_preference: 'Road', price: 115, walk_in: !customer_id,
  registered_at: '2026-09-01T10:00:00Z', ...extra,
});
const queue_entries = [
  row('t1', sessions[0], 42, 'Lina Haddad', 'c1', 'waiting'),
  row('h1', sessions[1], 2, 'Lina Haddad', 'c1', 'done', { paid: true }),
  row('h2', sessions[1], 3, 'Maya Haddad', 'c1', 'done', { paid: true }),
  row('h3', sessions[2], 4, 'Lina Haddad', 'c1', 'noshow', { noshow_at: '2026-10-17T19:00:00Z' }),
];

async function staff(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries, bikes: [], customers, tags: [], customer_tags: [], staff_options: [], ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===2&&(S.queue||[]).length===4');
}

test('making an account warns of a likely duplicate and opens it instead', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity();showNewAcctModal()`);
  await page.locator('#cf-phone').fill('551874471');
  const dup = page.locator('#n6q-dup');
  await expect(dup).toContainText('Looks like Lina Haddad (…4471, 2 rides)');
  await expect(dup).toContainText('Same phone');
  await dup.getByRole('button', { name: 'Open instead' }).click();
  await expect(page.locator('#new-acct-modal')).toBeHidden();
  await expect(page.locator('#cust-modal #ah-title')).toHaveText('Lina Haddad');
});

test('the find box goes by keys and finds a booking number', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('community');S.communityTab='overview';renderCommunity()`);
  const q = page.locator('#ppl-q');
  await q.fill('a');
  await expect(page.locator('#ppl-res .ppl-hit')).toHaveCount(2);
  await expect(page.locator('#ppl-res .ppl-hit').first()).toHaveClass(/n6q-on/);
  await q.press('ArrowDown');
  await expect(page.locator('#ppl-res .ppl-hit').nth(1)).toHaveClass(/n6q-on/);
  await q.fill('#42');
  await expect(page.locator('#ppl-res .n6q-bk')).toContainText('#42');
  await q.press('Enter');
  await expect(page.locator('#cust-modal #ah-title')).toHaveText('Lina Haddad');
  // Accounts has one search box: its own
  await page.evaluate(`closeCustomerProfile();setCommTab('accounts')`);
  await expect(page.locator('#ppl-q')).toHaveCount(0);
  await expect(page.locator('#am-search')).toHaveCount(1);
});

test('the account window: labels, timeline, last messaged, completeness, strikes', async ({ page }) => {
  await staff(page, {
    customer_contacts: [{ id: 1, customer_id: 'c1', channel: 'whatsapp', at: new Date(Date.now() - 3 * 864e5).toISOString(), by_name: 'Huda' }],
    staff_options: [{ key: 'biz', items: { ns_strikes_on: true, ns_strikes_n: 1, ns_strikes_days: 90 } }],
  });
  await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity();openAccountHistory('c1')`);
  const m = page.locator('#cust-modal');
  await expect(m.locator('.ah-facts')).toContainText('Account since');
  await expect(m.locator('.ah-facts')).toContainText('No-shows: 1 of last 3');
  await expect(m.locator('.ah-facts')).toContainText('Own rides: 1, for others: 1');
  await expect(m.locator('.n6q-ct')).toContainText('Messaged 3 days ago by Huda');
  await expect(m.locator('.n6q-pct')).toContainText('Profile 100% complete');
  await expect(m.locator('.n6q-strk')).toContainText('No-shows: 1 of 1 in the last 90 days');
  await expect(m.locator('.n6q-strk')).toContainText('Limit reached');
  await m.getByRole('button', { name: 'Show the timeline' }).click();
  await expect(m.locator('#n6q-tl .n6q-tl-row').first()).toBeVisible();
  await expect(m.locator('#n6q-tl')).toContainText('Booked');
  await expect(m.locator('#n6q-tl')).toContainText('Messaged on WhatsApp');
  await expect(m.locator('#n6q-tl')).toContainText('Account made');
});

test('Accounts: the completeness filter, the ask to complete, member facts on Members, Needs you today', async ({ page }) => {
  await staff(page, {
    tags: [{ id: 'tag_saturday', name: 'Community', color: '#00e585' }],
    customer_tags: [{ customer_id: 'c1', tag_id: 'tag_saturday', added_at: Date.parse('2026-07-01T10:00:00Z'), added_by: 'Huda' }],
  });
  await page.evaluate(`setStaffTab('community');S.communityTab='accounts';S.n6qPct='lt60';renderCommunity()`);
  await expect(page.locator('#am-cust-rows .am-row')).toHaveCount(1);
  await expect(page.locator('#am-cust-rows .am-row')).toHaveAttribute('data-cust', 'c2');
  await page.evaluate(`S.n6qPct='';_pplScope('yes')`);
  await expect(page.locator('.am-row[data-cust="c1"] .n6q-mem')).toContainText('Member since');
  await expect(page.locator('.am-row[data-cust="c1"] .n6q-mem')).toContainText('Saturday level');
  await page.evaluate(`_pplScope('');_amSelMode()`);
  await expect(page.locator('#am-sel-bar')).toContainText('Ask to complete');
  await page.evaluate(`S.customers.find(c=>c.id==='c2').deletion_requested_at=new Date(Date.now()-25*864e5).toISOString();setCommTab('overview')`);
  await expect(page.locator('.n6q-needs')).toContainText('Deletion request');
  await expect(page.locator('.n6q-needs')).toContainText('5 days left');
});

test('fees: off until switched on; an admin charges from the wallet', async ({ page }) => {
  let sent: Record<string, unknown> | null = null;
  await staff(page, {
    'rpc:staff_wallet_balances': [{ customer_id: 'c1', balance: 50 }],
    'rpc:staff_wallet_fees': [],
    staff_options: [{ key: 'biz', items: { late_fee_on: true, late_fee_noshow: 20 } }],
  });
  await page.route(/\/rest\/v1\/rpc\/staff_wallet_fee$/, async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, amount: 20, balance: 30 }) });
  });
  await page.evaluate(`localStorage.setItem('cq_role','admin');setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
  await page.waitForFunction('typeof _cwOk==="function"&&_cwOk()');
  await page.evaluate(`openAccountHistory('c1')`);
  const fee = page.locator('#cust-modal .n6q-fee');
  await expect(fee).toContainText('No-Show');
  const btn = fee.getByRole('button', { name: /Charge SAR 20 from wallet/ });
  if (await page.evaluate('isAdmin()')) {
    await btn.click();
    await expect.poll(() => sent && (sent as Record<string, unknown>).p_booking_id).toBe('h3');
  }
});
