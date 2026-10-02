import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Every Saturday Social Ride booking carries an envelope in plain sight (not in the ⋯ menu). It
// opens three messages - ride details, the photo and privacy reminder, road etiquette - each to
// copy or send on WhatsApp. The ride details read the day, the gathering and start times and the
// meeting point off the session. A JCC booking has no envelope.

const SAT = 'sat-1', JCC = 'jcc-1';
const MEET = 'https://maps.app.goo.gl/spec-meet';
const sessions = [
  { id: SAT, session_date: '2099-10-03', day: 'Saturday', status: 'open', capacity: 30, created_at: 1,
    event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false, spots: 30,
    bike_slots: JSON.stringify({ _time: '05:45-06:15' }), meet_url: MEET },
  { id: JCC, session_date: '2099-10-04', day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC' },
];
const e = (id: string, sid: string, x: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Saturday', session_date: '2099-10-03', queue_num: 1,
  name: 'R ' + id, phone: '0550000009', type_preference: 'Any', size: 'M', status: 'waiting',
  paid: false, price: 0, registered_at: '2099-01-01T10:00:00Z', approval: 'approved', customer_id: 'cust-' + id, ...x });

async function boot(page: import('@playwright/test').Page, sid: string, rows: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries: rows, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${sid}';renderStaffQueue()`);
  await page.waitForTimeout(250);
}

test('a Saturday booking opens its three messages, ride details read off the session', async ({ page }) => {
  await boot(page, SAT, [e('a', SAT), e('p', SAT, { approval: 'pending' }), e('w', SAT, { status: 'waitlist', waitlist_num: 1 })]);
  // one envelope per booking, whatever its status
  await expect(page.locator('#tab-queue .rq-msg')).toHaveCount(3);
  await page.locator('#tab-queue .rq-msg').first().click();
  const box = page.locator('#confirm-modal .ca-msg-box');
  await expect(box.locator('.rm-opt')).toHaveText([/Ride details/, /Photo & privacy reminder/, /Road etiquette/]);

  await box.locator('.rm-opt[data-rm="ride"]').click();
  const txt = await box.locator('#rm-msg-text').inputValue();
  expect(txt).toContain('Saturday Community Ride');
  expect(txt).toContain('*3rd of October*');
  expect(txt).toContain('Meet up time: *5:45AM*');
  expect(txt).toContain('Start time: *6:15AM*');
  expect(txt).toContain(MEET);
  expect(txt).toContain('https://micromobilityrentals.pages.dev/');
  const wa = await box.locator('a.rm-wa').getAttribute('href');
  expect(wa).toMatch(/^https:\/\/wa\.me\/966550000009\?text=/);
  expect(decodeURIComponent(wa!.split('text=')[1])).toBe(txt);

  // back to the list, then the etiquette, emoji intact
  await box.locator('.rm-back').click();
  await box.locator('.rm-opt[data-rm="etiq"]').click();
  const et = await box.locator('#rm-msg-text').inputValue();
  expect(et).toContain('Public Road Cycling Etiquette');
  expect(et).toContain('\u{1F4DE} *+966 56 666 8818*');
  await box.locator('.rm-back').click();
  await box.locator('.rm-opt[data-rm="privacy"]').click();
  expect(await box.locator('#rm-msg-text').inputValue()).toMatch(/^\u{1F512} \*A Friendly Privacy Reminder\*/u);
  await box.locator('.ca-x').click();
  await expect(page.locator('#confirm-modal .ca-msg-box')).toHaveCount(0);
});

test('a JCC booking carries no envelope', async ({ page }) => {
  await boot(page, JCC, [e('j', JCC, { session_day: 'Sunday', session_date: '2099-10-04', approval: null })]);
  await expect(page.locator('#tab-queue .rq-more').first()).toBeVisible();
  await expect(page.locator('#tab-queue .rq-msg')).toHaveCount(0);
});
