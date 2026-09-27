import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A closed party offers what used to need opening it: Return all for the riders on a bike,
// and, in its menu, Undo check-in and No-show. Several bikes come back through one screen
// (every bike OK unless tapped otherwise, one question about anyone unpaid), from a party or
// from riders ticked on the roster. The /petromin form's registrations have their own page in
// Queue, opened from a chip with the Petromin logo, where the Riders tab used to be.

const D = '2099-02-10';
const sessions = [
  { id: D, day: 'Tuesday', session_date: D, capacity: 40, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }) },
  { id: '2099-02-11-pw', day: 'Wednesday', session_date: '2099-02-11', capacity: 35, status: 'open', created_at: 2, bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }), event_kind: 'community', ride_kind: 'petromin', paid_ride: true, title: "Petromin's Wednesdays" },
];
const bikes = [
  { id: 'b1', name: 'Road 01', type: 'Road', size: 'M', status: 'in-use' },
  { id: 'b2', name: 'Road 02', type: 'Road', size: 'M', status: 'in-use' },
  { id: 'b3', name: 'Hybrid 03', type: 'Hybrid', size: 'M', status: 'in-use' },
];
const row = (id: string, qn: number, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: D, session_day: 'Tuesday', session_date: D, queue_num: qn, name, phone: '0551112222',
  customer_id: null, group_id: 'g1', status, paid: true, price: 115, walk_in: true, type_preference: 'Road',
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});
const queue_entries = [
  row('p1', 1, 'Party One', 'active', { assigned_bike_id: 'b1' }),
  row('p2', 2, 'Party Two', 'active', { assigned_bike_id: 'b2', paid: false }),
  row('p3', 3, 'Party Three', 'waiting'),
  row('s1', 4, 'Solo Rider', 'active', { group_id: null, assigned_bike_id: 'b3', paid: false }),
];
const regBase = { source: 'petromin', session_id: '2099-02-11-pw', created_at: '2099-02-10T09:00:00Z', updated_at: '2099-02-10T09:00:00Z', price: null, checked_in_by: null, checked_out_by: null, company: 'Petromin', matched_entry_id: null, matched_customer_id: null, match_kind: 'none', submissions: 1, height: 170, type_preference: 'Road' };
const rider_registrations = [
  { ...regBase, id: 1, booking_no: 'MMP-101', party_no: 1, badge: 'A-1', name: 'Emp Lead', phone: '+966500000011', checked_in_at: '2099-02-11T16:00:00Z', checked_out_at: null },
  { ...regBase, id: 2, booking_no: 'MMP-101', party_no: 2, badge: 'A-1', name: 'Emp Guest', phone: '+966500000011', checked_in_at: '2099-02-11T16:00:00Z', checked_out_at: null },
  { ...regBase, id: 3, booking_no: 'MMP-102', party_no: 1, badge: 'B-2', name: 'Emp Solo', phone: '+966500000012', checked_in_at: null, checked_out_at: null },
];

async function queue(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries, bikes, rider_registrations, 'rpc:staff_return': { ok: true }, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffTab='queue';S.queueView='bookings';S.sfSession='${D}';renderStaffQueue()`);
}
const returns = (page: Page) => {
  const calls: { id: string; cond: string; notes: string | null }[] = [];
  page.on('request', r => {
    if (/rpc\/staff_return/.test(r.url())) { const b = r.postDataJSON(); calls.push({ id: b.p_booking_id, cond: b.p_return_condition, notes: b.p_notes }); }
  });
  return calls;
};
const patches = (page: Page) => {
  const out: { id: string; body: Record<string, unknown> }[] = [];
  page.on('request', r => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      try { out.push({ id, body: r.postDataJSON() }); } catch { /* not JSON */ }
    }
  });
  return out;
};
const vis = (page: Page, sel: string) => page.locator(sel).filter({ visible: true });

test('a closed party returns everyone on a bike through one screen', async ({ page }) => {
  await queue(page);
  const calls = returns(page), writes = patches(page);
  await vis(page, '#tab-queue .party-return').first().click();
  const m = page.locator('#return-modal');
  await expect(m.locator('#br-title')).toHaveText('Return bikes (2)');
  await expect(m.locator('.br-row')).toHaveCount(2);                     // the waiting rider is not in it
  await expect(m.locator('.br-seg.on')).toHaveCount(2);                  // both OK to begin with
  await expect(m.locator('#br-notes')).toHaveCount(0);
  // One of them has not paid: Return waits for an answer.
  await expect(m.locator('.br-pay-q')).toContainText('Not paid yet: 1');
  await expect(m.locator('#br-go')).toBeDisabled();
  await m.locator('.br-row', { hasText: 'Party Two' }).locator('.br-seg', { hasText: 'Damaged' }).click();
  await m.locator('#br-notes').fill('Rear wheel bent');
  await m.locator('.toggle-btn', { hasText: 'Mark them paid' }).click();
  await m.locator('#br-go').click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls.find(c => c.id === 'p1')).toEqual({ id: 'p1', cond: 'ok', notes: null });
  expect(calls.find(c => c.id === 'p2')).toEqual({ id: 'p2', cond: 'damaged', notes: 'Rear wheel bent' });
  await expect.poll(() => writes.some(w => w.id === 'p2' && w.body.paid === true)).toBe(true);
  expect(writes.some(w => w.id === 'p1' && w.body.paid === true)).toBe(false); // already paid: untouched
  await expect(page.locator('.toast').last()).toContainText('Bikes returned: 2');
});

test('return without payment leaves the unpaid rider unpaid', async ({ page }) => {
  await queue(page);
  const calls = returns(page), writes = patches(page);
  await vis(page, '#tab-queue .party-return').first().click();
  await page.locator('#return-modal .toggle-btn', { hasText: 'Return without payment' }).click();
  await page.locator('#br-go').click();
  await expect.poll(() => calls.length).toBe(2);
  expect(writes.some(w => w.body.paid === true)).toBe(false);
});

test('the party menu undoes the check-in of everyone riding, and marks the rest no-show', async ({ page }) => {
  await queue(page);
  const writes = patches(page);
  const menuBtn = vis(page, '#tab-queue [aria-haspopup="menu"]').first();
  await menuBtn.click();
  await page.getByRole('menuitem', { name: 'Undo Check-in (2)' }).click();
  await expect(page.locator('#confirm-modal')).toContainText('Party One');
  await expect(page.locator('#confirm-modal')).toContainText('Party Two');
  await page.locator('#confirm-modal button', { hasText: 'Undo Check-in' }).click();
  await expect.poll(() => writes.filter(w => w.body.status === 'waiting').map(w => w.id).sort()).toEqual(['p1', 'p2']);

  await vis(page, '#tab-queue [aria-haspopup="menu"]').first().click();
  await page.getByRole('menuitem', { name: 'No-Show (1)' }).click();         // only the rider still waiting
  await expect(page.locator('#confirm-modal')).toContainText('Party Three');
  await page.locator('#confirm-modal button', { hasText: 'No-Show' }).click();
  await expect.poll(() => writes.some(w => w.id === 'p3' && w.body.status === 'noshow')).toBe(true);
});

test('riders ticked on the roster come back together from the selection bar', async ({ page }) => {
  await queue(page);
  const calls = returns(page);
  await page.evaluate(`S.sfSelected=['p1','s1'];renderStaffQueue()`);
  await page.getByRole('button', { name: 'Return bikes (2)' }).click();
  await expect(page.locator('#return-modal .br-row')).toHaveCount(2);
  await page.locator('#return-modal .toggle-btn', { hasText: 'Mark them paid' }).click();
  await page.locator('#br-go').click();
  await expect.poll(() => calls.map(c => c.id).sort()).toEqual(['p1', 's1']);
  await expect.poll(() => page.evaluate('S.sfSelected.length')).toBe(0);
});

test('the Petromin registrations have their own page in Queue, opened from a logo chip', async ({ page }) => {
  await queue(page);
  await expect(page.locator('[data-stab="riders"]')).toHaveCount(0);   // the Riders tab is gone
  const chip = page.locator('#tab-queue .sess-bar-desktop .pm-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip.locator('img.pm-logo')).toHaveAttribute('alt', 'Petromin');
  // Right after that night's own chip.
  const order = await page.evaluate(`[...document.querySelectorAll('#tab-queue .sess-bar-desktop .sess-summary-chip')].map(c=>c.classList.contains('pm-chip')?'pm':c.getAttribute('data-on-click'))`) as string[];
  expect(order.indexOf('pm')).toBe(order.findIndex(o => o && o.includes('2099-02-11-pw')) + 1);
  await expect(chip).toContainText('3 registered');
  await page.evaluate(`openPetrominPage('2099-02-11-pw')`);
  await expect(page.locator('#pm-host .pm-logo-lg')).toBeVisible();
  await expect(page.locator('#pm-host tbody tr')).toHaveCount(2);            // one party folded, one solo
  // The folded party: Return all and Undo check-in, without opening it.
  const party = page.locator('#pm-host tbody tr', { hasText: 'MMP-101' });
  await expect(party.getByRole('button', { name: 'Return all (2)' })).toBeVisible();
  await expect(party.getByRole('button', { name: 'Undo Check-in (2)' })).toBeVisible();
  const regWrites: string[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && /rider_registrations/.test(r.url())) regWrites.push(r.url()); });
  await party.getByRole('button', { name: 'Return all (2)' }).click();
  await page.locator('#confirm-modal button', { hasText: 'Return all' }).click();
  await expect.poll(() => regWrites.length).toBe(2);
  // A session chip leaves the page again.
  await page.evaluate(`setSfSession('${D}')`);
  expect(await page.evaluate('S.queueView')).toBe('bookings');
  await expect(page.locator('#pm-host')).toHaveCount(0);
});

test('with no Petromin night open, the chip opens the latest night that has registrations', async ({ page }) => {
  await queue(page, { sessions: [sessions[0], { ...sessions[1], status: 'closed' }] });
  const chip = page.locator('#tab-queue .sess-bar-desktop .pm-chip');
  await expect(chip).toHaveCount(1);
  await chip.dispatchEvent('click');                                    // phones reach it from the dropdown; same page
  expect(await page.evaluate('[S.queueView,S.ridersSession]')).toEqual(['petromin', '2099-02-11-pw']);
});

test('a rider cancelling picks from the everyday reasons, and Other asks for their own words', async ({ page }) => {
  await queue(page);
  await page.evaluate(`showCancelReasonModal('p3')`);
  const opts = page.locator('#cancel-reason-modal .cancel-reason-opt');
  await expect(opts).toHaveText(['Change of plans', 'Work or family commitment', 'Feeling unwell or injured', 'The weather (heat, wind or dust)',
    'Booked the wrong date or time', "Can't get there on time (traffic or transport)", "My group can't make it", 'Found a better price elsewhere', 'Other']);
  await expect(page.locator('#cancel-other-wrap')).toBeHidden();
  await opts.last().click();
  await expect(page.locator('#cancel-other-wrap')).toBeVisible();
  await opts.nth(3).click();
  await expect(page.locator('#cancel-other-wrap')).toBeHidden();
});
