import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Message templates (the owner, 2026-10-02): admins rewrite any prepared message in English or
// Arabic on Settings; it is kept in site_content 'msg.templates'. A message with no text of its own
// is built as before. A written one is filled in, and a line whose fill-in is empty is left out.

const SAT = 'sat-1';
const sat = { id: SAT, session_date: '2099-10-03', day: 'Saturday', status: 'open', capacity: 30, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false, spots: 30,
  bike_slots: JSON.stringify({ _time: '05:45-06:15' }) }; // no meeting point on this one
const row = { id: 'a', session_id: SAT, session_day: 'Saturday', session_date: '2099-10-03', queue_num: 1, name: 'Huda Saleh',
  phone: '0550000009', type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 0,
  registered_at: '2099-01-01T10:00:00Z', approval: 'approved', customer_id: 'c-a' };

async function boot(page: Page, templates?: Record<string, unknown>) {
  await stubSupabase(page, { sessions: [sat], bikes: [], queue_entries: [row],
    site_content: templates ? [{ key: 'msg.templates', value: templates }] : [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
}

test('the fill-ins are filled, and a line whose fill-in is empty is left out', async ({ page }) => {
  await boot(page, { rm_ride: { en: 'Ride on *{date}*\nMeet at {meet_time}\nMap: {meet_link}\nBook: {booking_link}' } });
  await page.waitForFunction(`S._tpl&&S._tpl.rm_ride`);
  const txt = await page.evaluate(`_rmText(getQueue()[0],'ride','en')`);
  expect(txt).toBe('Ride on *3rd of October*\nMeet at 5:45AM\nBook: https://micromobilityrentals.pages.dev/');
});

test('with no text of its own a message is the built-in one', async ({ page }) => {
  await boot(page);
  const txt = await page.evaluate(`_rmText(getQueue()[0],'ride','en')`) as string;
  expect(txt).toContain('Saturday Community Ride');
  expect(txt).toContain('Meet up time: *5:45AM*');
  expect(txt).not.toContain('Meet Up Location'); // as before: no meeting point, no lines for it
});

test('the rider messages come in English and Arabic, an admin\'s Arabic text first', async ({ page }) => {
  await boot(page, { rm_privacy: { ar: 'تذكير بالخصوصية يا {first_name}' } });
  await page.waitForFunction(`S._tpl&&S._tpl.rm_privacy`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${SAT}';renderStaffQueue()`);
  await page.locator('#tab-queue .rq-msg').first().click();
  const box = page.locator('#confirm-modal .ca-msg-box');
  await box.locator('.rm-opt[data-rm="ride"]').click();
  await box.locator('[data-rm-lang="ar"]').click(); // the built-in Arabic ride details, the ride's own date and times
  await expect(box.locator('#rm-msg-text')).toHaveValue(/جولة MicroMobility الاجتماعية[\s\S]*وقت التجمّع: \*5:45 ص\*[\s\S]*وقت الانطلاق: \*6:15 ص\*/);
  await box.locator('[data-rm-lang="en"]').click();
  await box.locator('.rm-back').click();
  await box.locator('.rm-opt[data-rm="privacy"]').click();
  await expect(box.locator('#rm-msg-text')).toHaveValue(/A Friendly Privacy Reminder/);
  await box.locator('[data-rm-lang="ar"]').click();
  await expect(box.locator('#rm-msg-text')).toHaveValue('تذكير بالخصوصية يا {first_name}'); // a word it does not know stays as written
  await expect(box.locator('#rm-msg-text')).toHaveAttribute('dir', 'rtl');
});

test('an admin edits a message on Settings and it is saved for everyone', async ({ page }) => {
  await boot(page);
  const saved: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rest/v1/site_content')) saved.push(r.postDataJSON());
  });
  await page.evaluate(`setStaffTab('settings')`);
  const sec = page.locator('#tab-settings .set-card', { hasText: 'Message templates' });
  await expect(sec.locator('.tpl-row')).toHaveCount(28);
  await sec.locator('.tpl-row[data-tpl="bd_wish"]').click();
  const ed = page.locator('#confirm-modal .tpl-box');
  await expect(ed.locator('#tpl-text')).toHaveValue(/Happy birthday, \{first_name\}!/); // the built-in text, its fill-in showing
  await ed.locator('#tpl-text').fill('Happy birthday ');
  await ed.locator('.tpl-fill', { hasText: '{first_name}' }).click();
  await ed.locator('[data-tpl-lang="ar"]').click();
  await expect(ed.locator('#tpl-text')).toHaveAttribute('dir', 'rtl');
  await expect(ed.locator('#tpl-text')).toHaveValue(/\{first_name\}/); // the Arabic built-in text, its fill-in showing
  expect(await ed.locator('#tpl-text').inputValue()).toMatch(/[\u0600-\u06FF]/);
  await ed.locator('[data-tpl-lang="en"]').click();
  await expect(ed.locator('#tpl-text')).toHaveValue('Happy birthday {first_name}');
  await ed.locator('#tpl-save').click();
  await expect.poll(() => saved.length).toBe(1);
  const body = saved[0] as { key: string; value: Record<string, Record<string, string>> };
  expect(body.key).toBe('msg.templates');
  expect(body.value).toEqual({ bd_wish: { en: 'Happy birthday {first_name}' } }); // Arabic left as built in: nothing kept
  await expect(sec.locator('.tpl-row[data-tpl="bd_wish"] .tpl-own')).toHaveText('Customized');
});

test('Front Desk does not see the templates', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffRole('frontdesk');setStaffTab('settings')`);
  await expect(page.locator('#tab-settings .form-title')).toHaveText(['Profile', 'Sign-in', 'Notifications']);
});

test('every message opens in the editor with Arabic text on its Arabic tab', async ({ page }) => {
  await boot(page);
  const empty = await page.evaluate(`(()=>{const out=[];TPL.forEach(([,l])=>l.forEach(([id])=>{if(!/[\\u0600-\\u06FF]/.test(_tplDefault(id,'ar')))out.push(id);}));return out;})()`);
  expect(empty).toEqual([]);
});
