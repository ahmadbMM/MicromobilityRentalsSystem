import { test, expect } from '@playwright/test';
import { stubSupabase, loadStaffHalf } from './helpers/supabase';

// Guards the first extracted module (src/js/ticket-calendar.js): the directions link
// helper and the .ics calendar export. These run in the app's global scope after the
// build-time include is inlined, so we exercise them straight from the page context.

test.beforeEach(async ({ page }) => {
  await stubSupabase(page);
  await page.goto('/');
  await loadStaffHalf(page); // nothing on the customer pages calls these yet, so they sit in the staff half
});

test('_mapUrl builds Google Maps links for known branches and unknown locations', async ({ page }) => {
  const jcc = await page.evaluate(`_mapUrl('JCC')`);
  expect(jcc).toContain('google.com/maps/search/');
  expect(jcc).toContain(encodeURIComponent('21.624565,39.106812')); // exact booth pin

  const shar = await page.evaluate(`_mapUrl('Sharafeyah Branch')`);
  expect(shar).toContain(encodeURIComponent('Sharafeyah, Jeddah'));

  // Unknown branch falls back to "<name>, Jeddah" so directions still resolve.
  const other = await page.evaluate(`_mapUrl('Somewhere Else')`);
  expect(other).toContain(encodeURIComponent('Somewhere Else, Jeddah'));
});

test('_ticketCal emits a valid VEVENT .ics with a 2-hour reminder for the booking', async ({ page }) => {
  // Capture the object URL the download would use by stubbing Blob → text.
  const ics = await page.evaluate(`(async () => {
    let captured = '';
    const realBlob = window.Blob;
    // @ts-ignore
    window.Blob = function(parts){ captured = (parts && parts[0]) || ''; return new realBlob(parts, { type: 'text/calendar' }); };
    const realCreate = URL.createObjectURL; URL.createObjectURL = () => 'blob:stub';
    const realClick = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){};
    S.lastTickets = [{ queueNum: 7, sessionId: 'sX', sessionDate: '2099-03-14', name: 'Cal Rider' }];
    S.sessions = [{ id: 'sX', session_date: '2099-03-14', bike_slots: JSON.stringify({ _time: '09:00 - 11:00' }), location: 'JCC' }];
    _ticketCal(0);
    window.Blob = realBlob; URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick;
    return captured;
  })()`);

  expect(ics).toContain('BEGIN:VCALENDAR');
  expect(ics).toContain('BEGIN:VEVENT');
  expect(ics).toContain('DTSTART:20990314T060000Z'); // 09:00 Jeddah, in UTC
  expect(ics).toContain('DTEND:20990314T080000Z');
  expect(ics).toContain('SUMMARY:MicroMobility Rental #7');
  expect(ics).toContain('TRIGGER:-PT2H'); // 2-hour reminder
  expect(ics).toContain('END:VCALENDAR');
});
