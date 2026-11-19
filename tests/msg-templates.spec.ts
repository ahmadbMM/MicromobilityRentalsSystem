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
  // the ride's details keep the booking link where the admin wrote it (the user, 2026-11-14: just above the location)
  expect(txt).toBe('Ride on *3rd of October*\nMeet at 5:45AM\nBook: https://experiences.micromobility.sa/');
});

// The user, 2026-11-18: "i only want that the first link in every message to be the booking app website link" (2026-11-14
// had put it on top of every one). WhatsApp previews a message's first link, so in every prepared message with a link the
// first is the booking app's, and none is put on top (not lm_anniv, a card line never sent).
test('the booking app\'s link is the first link of every message template, never put on top, in every language', async ({ page }) => {
  await boot(page);
  await page.waitForFunction(`typeof globalThis['_remDef'+'ault']==='function'`);
  // The WhatsApp announcements (wk_, ann_; 2026-11-16) keep it just above the place, as the Saturday ride does: tests/week-announce.spec.ts
  const bad = await page.evaluate(`(()=>{const out=[];for(const[,list]of TPL)for(const[id]of list)if(id!=='lm_anniv'&&!/^(wk|ann)_/.test(id))for(const g of _tplLangs()){
    const v=_tplDefault(id,g);if(!v.trim()){out.push(id+'/'+g+' empty');continue;}
    if(v.startsWith('https://experiences.micromobility.sa/'))out.push(id+'/'+g+' on top');
    const m=/https?:\\/\\/[^\\s*]+|\\{([a-z_]*link|site)\\}/.exec(v);
    if(m&&!(m[1]!=null?['booking_link','cancel_link','claim_link','link','site'].includes(m[1]):m[0].startsWith('https://experiences.micromobility.sa')))out.push(id+'/'+g+' first link '+m[0]);
    if(id==='rm_ride'&&!v.includes(g==='ar'?'الحجز:\\n{booking_link}\\n\\nموقع التجمّع:\\n{meet_link}':'Booking:\\n{booking_link}\\n\\nMeet Up Location:\\n{meet_link}'))out.push(id+'/'+g+': '+v.slice(0,40));}return out;})()`);
  expect(bad).toEqual([]);
  const bk = (s: string) => page.evaluate(`_bkFirst(${JSON.stringify(s)})`);
  // no link: as written
  expect(await bk('Hi Sara,\n\nSee you on the road!')).toBe('Hi Sara,\n\nSee you on the road!');
  expect(await bk('')).toBe('');
  // the first link is already the booking app's (any page of it, or a fill-in that becomes one): as written
  expect(await bk('Booking:\nhttps://experiences.micromobility.sa/\n\nLocation:\nhttps://maps.app.goo.gl/x')).toBe('Booking:\nhttps://experiences.micromobility.sa/\n\nLocation:\nhttps://maps.app.goo.gl/x');
  expect(await bk('Can\'t come? Cancel here:\nhttps://experiences.micromobility.sa/my-rides?lang=en')).toBe('Can\'t come? Cancel here:\nhttps://experiences.micromobility.sa/my-rides?lang=en');
  expect(await bk('Hi {first_name},\n\n{ride}\n\n{cancel_link}')).toBe('Hi {first_name},\n\n{ride}\n\n{cancel_link}');
  // another link first: the booking app's goes just above it, above its label when it sits under one, and once only
  const grp = 'Hi Sara,\nYou are invited.\nJoin the group:\nhttps://chat.whatsapp.com/abc\n\nThe team';
  const want = 'Hi Sara,\nYou are invited.\n\nhttps://experiences.micromobility.sa/\n\nJoin the group:\nhttps://chat.whatsapp.com/abc\n\nThe team';
  expect(await bk(grp)).toBe(want);
  expect(await bk(want)).toBe(want);
  expect(await bk('Hi\n\nMap: https://maps.app.goo.gl/x')).toBe('Hi\n\nhttps://experiences.micromobility.sa/\n\nMap: https://maps.app.goo.gl/x');
  expect(await bk('{ride}\n\n{group_link}')).toBe('{ride}\n\nhttps://experiences.micromobility.sa/\n\n{group_link}');
});

test('with no text of its own a message is the built-in one', async ({ page }) => {
  await boot(page);
  const txt = await page.evaluate(`_rmText(getQueue()[0],'ride','en')`) as string;
  expect(txt).toContain('Saturday Community Ride');
  expect(txt).toContain('Meet up time: *5:45AM*');
  expect(txt).not.toContain('Meet Up Location'); // as before: no meeting point, no lines for it
  // in Arabic too (bug hunt 2026-11-18): the heading stayed with nothing under it
  const ar = await page.evaluate(`_rmText(getQueue()[0],'ride','ar')`) as string;
  expect(ar).toContain('الحجز:');
  expect(ar).not.toContain('موقع التجمّع');
});

test('the rider messages come in English and Arabic, an admin\'s Arabic text first', async ({ page }) => {
  await boot(page, { rm_privacy: { ar: 'تذكير بالخصوصية يا {first_name}' } });
  await page.waitForFunction(`S._tpl&&S._tpl.rm_privacy`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${SAT}';renderStaffQueue()`);
  await page.locator('#tab-queue .rq-msg').first().click();
  const box = page.locator('#confirm-modal .ca-msg-box');
  await box.locator('.rm-opt[data-rm="ride"]').click();
  await box.locator('[data-rm-lang="ar"]').click(); // the built-in Arabic ride details, the ride's own date and times
  await expect(box.locator('#rm-msg-text')).toHaveValue(/^جولة MicroMobility الاجتماعية[\s\S]*وقت التجمّع: \*5:45 ص\*[\s\S]*وقت الانطلاق: \*6:15 ص\*[\s\S]*الحجز:\nhttps:\/\/experiences\.micromobility\.sa\//);
  await box.locator('[data-rm-lang="en"]').click();
  await box.locator('.rm-back').click();
  await box.locator('.rm-opt[data-rm="privacy"]').click();
  await expect(box.locator('#rm-msg-text')).toHaveValue(/A Friendly Privacy Reminder/);
  await box.locator('[data-rm-lang="ar"]').click();
  await expect(box.locator('#rm-msg-text')).toHaveValue('تذكير بالخصوصية يا {first_name}'); // a word it does not know stays as written; no link, none added (2026-11-18)
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
  await expect(sec.locator('.tpl-row')).toHaveCount(51); // 2026-11-19: ann_invite, the invitation to a session; 2026-11-16: the 14 WhatsApp announcements with a built-in text (ANN_HAS); 2026-11-13: lm_anniv, the first-ride anniversary card's line (F16); 2026-11-07: remind_late (BK13); 2026-10-09: the two messages to a selection (seg_ops, seg_news); R7: remind_24h, remind_2h, wl_offer
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

test('Front desk does not see the templates', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffRole('frontdesk');setStaffTab('settings')`);
  await expect(page.locator('#tab-settings .form-title')).toHaveText(['Profile', 'Sign-in', 'Notifications', 'This device', 'Personal', 'Display']);
});

test('every message opens in the editor with Arabic text on its Arabic tab', async ({ page }) => {
  await boot(page);
  // The announcements' built-in texts come with their part (2026-11-16); a type with none (ANN_HAS lists those with one) is
  // written by the admins, and until then its announcement asks for it.
  await page.evaluate(`_annDef('wk_head','ar')`);
  const empty = await page.evaluate(`(()=>{const out=[];TPL.forEach(([,l])=>l.forEach(([id])=>{if(/^(wk|ann)_/.test(id)&&!ANN_HAS.includes(id))return;if(!/[\\u0600-\\u06FF]/.test(_tplDefault(id,'ar')))out.push(id);}));return out;})()`);
  expect(empty).toEqual([]);
});
