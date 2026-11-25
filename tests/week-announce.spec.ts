import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The week on Bookings and its WhatsApp announcements (the user, 2026-11-16): "create a weekly view for the session cards
// on top of the page of bookings and add a weekly announcement template that fills automatically depending on the sessions
// of the week starting from sunday until saturday, dont extract the announcement if there was a new session ask the staff
// to update it if this happens, and create a template for each session for whatsapp announcement". The user's picks: seven
// day columns that replace the row of cards (on a phone the days as rows, today first); the week's message blocked only by
// a session TYPE it has no block for; one message per type; English with Arabic on a switch; admins write the texts.
// The clock is fixed on a Monday, so the week is 15-21 Nov 2099 on every machine. All Supabase traffic is stubbed.

const TODAY = '2099-11-16';
const night = (id: string, day: string, x: Record<string, unknown> = {}) => ({ id, day, session_date: id.slice(0, 10), capacity: 150, status: 'open', created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":150,"_collect":"20:15"}', ...x });
const comm = { event_kind: 'community', needs_approval: true, hide_queue: true, spots: 20 };
const pw = { event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false, capacity: 40,
  bike_slots: '{"_time":"19:00 - 21:00","_total":40,"_collect":"18:45"}' };
const sessions = [
  night('2099-11-15', 'Sunday', { status: 'closed' }),
  night('2099-11-16-pw', 'Monday', { ...pw, title: "Petromin's Circuit Night" }),
  night('2099-11-17', 'Tuesday'),
  night('2099-11-17-x', 'Tuesday', { status: 'closed', cancelled_at: '2099-11-10T10:00:00Z' }), // called off: in no announcement
  night('2099-11-18-pw', 'Wednesday', pw),
  night('2099-11-18-d', 'Wednesday', { draft: true }), // a draft: in no announcement
  night('2099-11-19', 'Thursday', { ...comm, ride_kind: 'swim', gender_only: 'male', bike_slots: '{"_time":"18:00 - 19:00"}' }),
  night('2099-11-19-fh', 'Thursday', { ...comm, ride_kind: 'farm', title: 'The Farmhouse Night', meet_name: 'Farmhouse, Dhahban', location: 'Farmhouse, Dhahban',
    meet_url: 'https://maps.app.goo.gl/BYteRL5JCueWZUEs6', bike_slots: '{"_time":"16:30 - 20:30","_ig":"thefarmhouse.jed"}' }),
  night('2099-11-21-2', 'Saturday', { ...comm, ride_kind: 'saturday', bike_slots: '{"_time":"05:45 - 06:15"}' }),
  night('2099-11-21', 'Saturday', { ...comm, ride_kind: 'swim', gender_only: 'female', bike_slots: '{"_time":"11:30 - 12:45"}' }),
  night('2099-11-21-yg', 'Saturday', { ...comm, ride_kind: 'yoga', status: 'full', location: 'SILKDEER', bike_slots: '{"_time":"16:00 - 17:30"}' }),
  night('2099-11-22', 'Sunday'),
  night('2099-12-05-rh', 'Saturday', { ...comm, ride_kind: 'runher', bike_slots: '{"_time":"06:00 - 06:30"}' }),
];

async function boot(page: Page, opt: { width?: number; height?: number; templates?: Record<string, unknown>; role?: string; bare?: string[] } = {}) {
  await page.setViewportSize({ width: opt.width || 1440, height: opt.height || 1000 });
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+03:00`));
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], tags: [], customer_tags: [], customers: [],
    site_content: opt.templates ? [{ key: 'msg.templates', value: opt.templates }] : [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0');
  await page.evaluate(`${opt.role ? `S.staffRole='${opt.role}';` : ''}setStaffTab('queue');S.queueView='bookings';S.sfSession='${TODAY}-pw';renderStaffQueue()`);
  // Every session type has its built-in texts since 2026-11-25; a test of a type with none takes its texts away here
  if (opt.bare) await page.evaluate(`_annDef('wk_head','ar');for(const id of ${JSON.stringify(opt.bare)}){delete ANN_TPL.en[id];delete ANN_TPL.ar[id];const i=ANN_HAS.indexOf(id);if(i>=0)ANN_HAS.splice(i,1);}`);
}
const chip = (page: Page, id: string) => page.locator(`#sess-strip .wk-grid .sess-summary-chip[data-sid="${id}"]`);
const dlg = (page: Page) => page.locator('#confirm-modal .ann-box');
async function openAnn(page: Page, pick?: string) {
  await page.locator('#sess-strip .wk-ann').click();
  await expect(dlg(page)).toBeVisible();
  if (pick) await dlg(page).locator(`.rm-opt[data-ann="${pick}"]`).click();
}

const WEEK_EN = `*MicroMobility’s Weekly Schedule*
15 – 21 November

Hi everyone! Here’s when and where to find the MicroMobility team this week.

Booking:
https://experiences.micromobility.sa/

*Sunday | Jeddah Corniche Circuit (JCC)*
Running hours: 6:00 PM – 8:00 PM
Cycling hours: 9:00 PM – 11:00 PM (bikes from 8:15 PM)
Open to everyone. Bike rental is paid.

*Monday | Petromin Night at JCC*
Cycling hours: 7:00 PM – 9:00 PM (bikes from 6:45 PM)
Community Members only, each welcome to bring 1 guest. Bike rental is paid.

*Tuesday | Jeddah Corniche Circuit (JCC)*
Running hours: 6:00 PM – 8:00 PM
Cycling hours: 9:00 PM – 11:00 PM (bikes from 8:15 PM)
Open to everyone. Bike rental is paid.

*Wednesday | Petromin Night at JCC*
Cycling hours: 7:00 PM – 9:00 PM (bikes from 6:45 PM)
Community Members only, each welcome to bring 1 guest. Bike rental is paid.

*Thursday | The Farmhouse Night*
Arrival 4:30 PM, dinner 8:30 PM

*Thursday | Men’s Swimming*
Al Andalus Private School, Az Zahra Branch
6:00 PM – 7:00 PM
Male Community Members only. All levels welcome.

*Saturday | Community Ride | Jeddah Corniche*
Meet up 5:45 AM, start 6:15 AM, breakfast after the ride
Community Members and confirmed invitees only.
Bikes are free, subject to availability and confirmation.

*Saturday | Women’s Swimming*
11:30 AM – 12:45 PM
Female Community Members only. All levels welcome.

*Saturday | Hatha Yoga for Cyclists*
4:00 PM – 5:30 PM at SILKDEER

Every bike comes with a free helmet.
Pass by JCC on Sunday, Monday, Tuesday or Wednesday to say hello and ask us anything about bikes, cycling or MicroMobility.

*MicroMobility Team*`;
const WRITTEN = { wk_farm: { en: '*{day} | {title}*\nArrival {meet_time}, dinner {start_time}' }, wk_yoga: { en: '*{day} | {title}*\n{time} at {place}' } };

test.describe('@staff:bookings the week on Bookings', () => {
  test('seven days from Sunday, today marked, each session in its day; the arrows move a week', async ({ page }) => {
    await boot(page);
    const days = page.locator('#sess-strip .wk-grid .wk-day');
    await expect(days).toHaveCount(7);
    await expect(days.first().locator('.wk-dh')).toContainText('Sun');
    await expect(days.last().locator('.wk-dh')).toContainText('Sat');
    await expect(page.locator('#sess-strip .wk-title')).toContainText('15 Nov');
    await expect(page.locator('#sess-strip .wk-title')).toContainText('21 Nov');
    await expect(days.nth(1)).toHaveClass(/wk-today/);
    await expect(days.nth(1).locator('.wk-dh')).toContainText('Today');
    await expect(days.nth(2).locator('.wk-dh')).toContainText('Tomorrow');
    await expect(days.nth(1).locator(`.sess-summary-chip[data-sid="${TODAY}-pw"]`)).toHaveCount(1);
    await expect(days.nth(5).locator('.wk-none')).toHaveText('No sessions'); // Friday
    // a closed night stands in its day, grey; Saturday holds its three sessions in start order
    await expect(chip(page, '2099-11-15')).toHaveClass(/ss-closed/);
    await expect(days.nth(6).locator('.sess-summary-chip')).toHaveCount(3);
    expect(await days.nth(6).locator('.sess-summary-chip').evaluateAll((els) => els.map((e) => e.getAttribute('data-sid')))).toEqual(['2099-11-21-2', '2099-11-21', '2099-11-21-yg']);
    // a card in a column keeps its name on whole words
    const nameH = await chip(page, '2099-11-21-yg').locator('.sess-chip-event').evaluate((e) => e.getBoundingClientRect().height);
    expect(nameH).toBeLessThan(50);
    // a later week is an arrow away, and This week brings today back
    await expect(page.locator('#sess-strip .wk-this')).toHaveCount(0);
    await page.locator('#sess-strip .wk-next').click();
    await expect(chip(page, '2099-11-22')).toHaveCount(1);
    await expect(chip(page, TODAY + '-pw')).toHaveCount(0);
    await page.locator('#sess-strip .wk-this').click();
    await expect(chip(page, TODAY + '-pw')).toHaveCount(1);
    await page.locator('#sess-strip .wk-prev').click();
    await expect(page.locator('#sess-strip .wk-title')).toContainText('8 Nov');
    // a session picked elsewhere (the phone's picker) brings its own week
    await page.evaluate(`setSfSession('2099-11-22')`);
    await expect(chip(page, '2099-11-22')).toHaveAttribute('aria-pressed', 'true');
    // a card still picks its session
    await page.evaluate(`_wkGo(0)`);
    await chip(page, '2099-11-17').click();
    await expect.poll(() => page.evaluate('S.sfSession')).toBe('2099-11-17');
    await expect(chip(page, '2099-11-17')).toHaveAttribute('aria-pressed', 'true');
  });

  // On a phone the week is a pop-up from the Week button beside the session picker (the user, 2026-11-16: the rows on the
  // page pushed the first rider past the 400px fold budget, tests/s10-headers.spec.ts).
  test('on a phone the week opens from its button: the days with sessions as rows, today first and the days gone after', async ({ page }) => {
    await boot(page, { width: 390, height: 844 });
    await expect(page.locator('#sess-strip .wk-grid')).toBeHidden();
    await expect(page.locator('#sess-strip .wk-head')).toBeHidden();
    await expect(page.locator('#sess-strip .wk-list')).toHaveCount(0);
    const btn = page.locator('#sess-strip .wk-open');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText('Week');
    expect((await btn.boundingBox())!.y).toBeLessThan((await page.locator('#q-live-count').boundingBox())!.y); // on the picker's line, above the figures
    await btn.click();
    const pop = page.locator('#confirm-modal .wk-pop');
    await expect(pop).toBeVisible();
    await expect(pop).toHaveAttribute('aria-labelledby', 'wk-pop-t');
    await expect(pop.locator('.wk-head .wk-title')).toContainText('15 Nov');
    const list = pop.locator('.wk-list');
    await expect(list).toBeVisible();
    await expect(list.locator('.wk-lday').first()).toHaveClass(/wk-today/);
    await expect(list.locator('.wk-lday')).toHaveCount(6); // Mon, Tue, Wed, Thu, Sat, then Sunday gone; no Friday
    await expect(list.locator('.wk-earlier')).toHaveText('Earlier this week');
    await expect(list.locator('.wk-lday').last()).toContainText('Sun');
    const row = list.locator('.wk-row[data-sid="2099-11-17"]');
    await expect(row).toContainText('Jeddah Corniche Circuit');
    await expect(row).toContainText('9 PM');
    // the rows are full-width taps, no narrower than the page's own buttons
    expect(await list.locator('.wk-row').first().evaluate((e) => (e as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44); // its layout height: the pop-up scales in
    // the arrows move the pop-up's week
    await pop.locator('.wk-next').click();
    await expect(pop.locator('.wk-row[data-sid="2099-11-22"]')).toHaveCount(1);
    await pop.locator('.wk-this').click();
    // a row picks its session and closes the pop-up
    await pop.locator('.wk-row[data-sid="2099-11-17"]').click();
    await expect(page.locator('#confirm-modal .wk-pop')).toHaveCount(0);
    await expect.poll(() => page.evaluate('S.sfSession')).toBe('2099-11-17');
    await btn.click();
    await expect(page.locator('#confirm-modal .wk-pop .wk-row[data-sid="2099-11-17"]')).toHaveAttribute('aria-pressed', 'true');
    // its Announcements opens the week's messages
    await page.locator('#confirm-modal .wk-pop .wk-ann').click();
    await expect(dlg(page).locator('.rm-opt[data-ann="week"]')).toBeVisible();
  });

  test('a desk account sees no ride staff approve in the week, but its announcements speak of every session', async ({ page }) => {
    await boot(page, { role: 'frontdesk', bare: ['wk_farm', 'wk_yoga'] });
    await expect(chip(page, '2099-11-21-2')).toHaveCount(0);
    await expect(chip(page, '2099-11-19-fh')).toHaveCount(0);
    await expect(chip(page, '2099-11-17')).toHaveCount(1);
    await openAnn(page);
    await expect(dlg(page).locator('.rm-opt[data-ann="2099-11-19-fh"]')).toHaveCount(1);
    await expect(dlg(page).locator('.rm-opt[data-ann="2099-11-17-x"], .rm-opt[data-ann="2099-11-18-d"]')).toHaveCount(0);
    // the week's message misses two types: a desk account is told to ask an admin, and is given no text to send
    await dlg(page).locator('.rm-opt[data-ann="week"]').click();
    await expect(dlg(page).locator('.ann-miss')).toContainText('no English block yet');
    await expect(dlg(page).locator('.ann-miss li b')).toHaveText(['Farm House Night', 'Hatha Yoga for Cyclists']);
    await expect(dlg(page).locator('.ann-write')).toHaveCount(0);
    await expect(dlg(page).locator('.ann-miss')).toContainText('Ask an admin to add it in Settings > Message templates.');
    await expect(dlg(page).locator('#ann-text, .ann-copy, .ann-wa')).toHaveCount(0);
    // ...or skips them (the user, 2026-11-20: "in the weekly schedule message allow staff to skip creating a message for the
    // new session type"): the week's message goes without those sessions, says what it left out, and Put back asks again
    await expect(dlg(page).locator('.ann-skip')).toHaveCount(2);
    await dlg(page).locator('.ann-skip[data-ann-skip="farm"]').click();
    await expect(dlg(page).locator('.ann-miss li b')).toHaveText(['Hatha Yoga for Cyclists']);
    await expect(dlg(page).locator('.ann-skipped')).toContainText('Left out: Farm House Night');
    await dlg(page).locator('.ann-skip[data-ann-skip="yoga"]').click();
    const txt = await dlg(page).locator('#ann-text').inputValue();
    expect(txt).toContain('*MicroMobility’s Weekly Schedule*');
    expect(txt).toContain('Petromin Night');
    expect(txt).not.toMatch(/Farm|Yoga/i);
    await expect(dlg(page).locator('.ann-skipped')).toContainText('Left out: Farm House Night, Hatha Yoga for Cyclists');
    // the skip holds in Arabic too, and Put back brings the question back
    await dlg(page).locator('[data-ann-lang="ar"]').click();
    await expect(dlg(page).locator('#ann-text')).toBeVisible();
    await dlg(page).locator('[data-ann-lang="en"]').click();
    await dlg(page).locator('.ann-unskip').click();
    await expect(dlg(page).locator('.ann-miss li b')).toHaveText(['Farm House Night', 'Hatha Yoga for Cyclists']);
    await expect(dlg(page).locator('.ann-skipped')).toHaveCount(0);
    // a session's own announcement has no Skip: it is that one session
    expect(await page.evaluate(`JSON.stringify(_annWeek('2099-11-29','en',['runher']))`)).toBe('{"none":true}');
  });
});

test.describe('@staff:bookings the week\'s WhatsApp announcement', () => {
  test('with a block for every type it is the week in order, the cancelled and draft sessions left out', async ({ page }) => {
    await boot(page, { templates: WRITTEN, bare: ['wk_farm', 'wk_yoga'] });
    await page.waitForFunction('S._tpl&&S._tpl.wk_farm');
    await openAnn(page, 'week');
    await expect(dlg(page).locator('#ann-text')).toHaveValue(WEEK_EN);
    // WhatsApp asks where it goes (no number), and carries the same text
    const href = await dlg(page).locator('a.ann-wa').getAttribute('href');
    expect(href!.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(href!.slice('https://wa.me/?text='.length))).toBe(WEEK_EN);
    // Arabic: the admins wrote the two blocks in English only, so the Arabic message waits for them
    await dlg(page).locator('[data-ann-lang="ar"]').click();
    await expect(dlg(page).locator('.ann-miss')).toContainText('Arabic');
    await expect(dlg(page).locator('.ann-miss li')).toHaveText([/Farm House Night/, /Hatha Yoga for Cyclists/]);
    // Back lists the week again
    await dlg(page).locator('.ann-back').click();
    await expect(dlg(page).locator('.rm-opt[data-ann="week"]')).toBeVisible();
  });

  test('a week the built-in blocks cover comes in Arabic too', async ({ page }) => {
    await boot(page);
    await page.evaluate(`_annDef('wk_head','ar')`); // the announce part
    expect(await page.evaluate(`_annWeek('2099-11-22','ar').txt`)).toBe(`*جدول MicroMobility الأسبوعي*
22 – 28 نوفمبر

مرحباً بالجميع! إليكم مواعيد وأماكن تواجد فريق MicroMobility هذا الأسبوع.

الحجز:
https://experiences.micromobility.sa/

*الأحد | حلبة كورنيش جدة (JCC)*
ساعات الجري: 6:00 م – 8:00 م
ساعات ركوب الدراجات: 9:00 م – 11:00 م (استلام الدراجات من 8:15 م)
مفتوحة للجميع. استئجار الدراجة مدفوع.

الخوذة مجانية مع كل دراجة.
مرّوا علينا في حلبة كورنيش جدة يوم الأحد للسلام علينا، واسألونا عن أي شيء يخص الدراجات وركوبها وMicroMobility.

*فريق MicroMobility*`);
    // a week with no session says so; a week of only Run for Her misses its block
    expect(await page.evaluate(`JSON.stringify(_annWeek('2099-12-06','en'))`)).toBe('{"none":true}');
    // a week of only Run for Her has its block since 2026-11-25; with it taken away the week asks for it
    expect(await page.evaluate(`_annWeek('2099-11-29','en').txt`)).toContain('*Saturday | Run for Her*');
    await page.evaluate(`delete ANN_TPL.en.wk_runher`);
    expect(await page.evaluate(`JSON.stringify(_annWeek('2099-11-29','en'))`)).toBe('{"miss":["runher"]}');
  });

  test('an admin writes a missing block from the announcement and comes back to it', async ({ page }) => {
    await boot(page, { bare: ['wk_farm', 'wk_yoga'] });
    const saved: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/site_content')) saved.push(r.postDataJSON()); });
    await openAnn(page, 'week');
    await expect(dlg(page).locator('.ann-write')).toHaveCount(2);
    await dlg(page).locator('.ann-miss li', { hasText: 'Farm House Night' }).locator('.ann-write').click();
    const ed = page.locator('#confirm-modal .tpl-box');
    await expect(ed).toBeVisible();
    await expect(ed.locator('#tpl-title')).toHaveText('Farm House Night');
    await expect(ed.locator('#tpl-text')).toHaveValue(''); // no built-in block for the farm
    await expect(ed.locator('.tpl-fill', { hasText: '{meet_time}' })).toHaveCount(1);
    await ed.locator('#tpl-text').fill('*{day} | {title}*');
    await ed.locator('#tpl-save').click();
    await expect.poll(() => saved.length).toBe(1);
    expect((saved[0] as { value: Record<string, unknown> }).value).toEqual({ wk_farm: { en: '*{day} | {title}*' } });
    // back on the week's announcement: only the yoga block is missing now
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page).locator('.ann-miss li')).toHaveText([/Hatha Yoga for Cyclists/]);
  });
});

test.describe('@staff:bookings each session\'s WhatsApp announcement', () => {
  test('each type has its own message, filled from the session; the Saturday ride\'s is its ride details', async ({ page }) => {
    await boot(page);
    await openAnn(page, `${TODAY}-pw`);
    await expect(dlg(page).locator('#ann-text')).toHaveValue(`MicroMobility’s Petromin Circuit Night *16th of November*

Bike collection: *6:45 PM*
Ride time: *7:00 PM – 9:00 PM*

For Petromin, Petrolube and Dukan employees and their invited guests.

Booking:
https://micromobility.sa/petromin

Location: Jeddah Corniche Circuit
https://maps.app.goo.gl/zJLjmiaJgfJDKQwY7

*No Registration & QR Code = No Participation*
*Helmet comes free with every bike*`);
    await dlg(page).locator('[data-ann-lang="ar"]').click();
    await expect(dlg(page).locator('#ann-text')).toHaveAttribute('dir', 'rtl');
    await expect(dlg(page).locator('#ann-text')).toHaveValue(/^ليلة بترومين في الحلبة مع MicroMobility \*16 نوفمبر\*/);
    await dlg(page).locator('[data-ann-lang="en"]').click();
    const one = (id: string, l = 'en') => page.evaluate(`JSON.stringify(_annOne(_sessGet('${id}'),'${l}'))`).then((x) => JSON.parse(x as string));
    expect((await one('2099-11-21-2')).txt).toBe(await page.evaluate(`_rmRideText(_sessGet('2099-11-21-2'),'en')`));
    const farm = (await one('2099-11-19-fh')).txt as string;
    expect(farm.startsWith('The Farmhouse Night *Thursday, 19th of November*\n\nArrival time: *4:30 PM*\nDinner time: *8:30 PM*')).toBe(true);
    expect(farm).toContain('Booking:\nhttps://experiences.micromobility.sa/\n\nLocation: Farmhouse, Dhahban\nhttps://maps.app.goo.gl/BYteRL5JCueWZUEs6');
    expect(farm).toContain('Instagram: https://www.instagram.com/thefarmhouse.jed/');
    // a place the session lacks takes its lines with it
    const swimF = (await one('2099-11-21', 'ar')).txt as string;
    expect(swimF).not.toContain('الموقع');
    expect(swimF).toContain('11:30 ص – 12:45 م');
    // a type with no message of its own asks for one
    // Run for Her has its own message since 2026-11-25; a type with none asks for one
    expect(((await one('2099-12-05-rh')).txt as string).startsWith('Run for Her with MicroMobility *Saturday, 5th of December*')).toBe(true);
    await page.evaluate(`delete ANN_TPL.en.ann_runher`);
    expect(await one('2099-12-05-rh')).toEqual({ miss: ['runher'] });
  });

  test('every session type has its weekly block and its own message built in, in English and Arabic', async ({ page }) => {
    // the user, 2026-11-25: "create a whatsapp message for all sessions in the weekly announcement and session announcement"
    await boot(page);
    await page.evaluate(`_annDef('wk_head','ar')`);
    const miss = await page.evaluate(`(()=>{const out=[];for(const[k]of ANN_TYPES)for(const id of ['wk_'+k,...(k==='saturday'?[]:['ann_'+k])])
      for(const l of ['en','ar'])if(!ANN_HAS.includes(id)||!_annDef(id,l).trim())out.push(id+'/'+l);return out;})()`);
    expect(miss).toEqual([]);
  });

  test('the built-in texts: English and Arabic, no emoji, the booking link before the place', async ({ page }) => {
    await boot(page);
    await page.evaluate(`_annDef('wk_head','ar')`);
    const bad = await page.evaluate(`(()=>{const out=[];for(const id of ANN_HAS)for(const l of ['en','ar']){
      const v=_tplDefault(id,l);if(!v.trim()){out.push(id+'/'+l+' empty');continue;}
      if(/\\p{Extended_Pictographic}/u.test(v))out.push(id+'/'+l+' emoji');
      if(l==='ar'&&!/[\\u0600-\\u06FF]/.test(v))out.push(id+'/ar not Arabic');
      const bk=v.search(/^(Booking:|الحجز:|التسجيل:)$/m),pl=v.search(/^(Location|Meet Up Location|الموقع|موقع التجمّع)/m);
      if(id.startsWith('ann_')&&(bk<0||(pl>=0&&pl<bk)))out.push(id+'/'+l+' link after the place');}
      for(const[,list]of TPL)for(const[id]of list)if(/^(wk|ann)_/.test(id)&&!ANN_HAS.includes(id)&&_tplDefault(id,'en'))out.push(id+' has a text ANN_HAS misses');
      return out;})()`);
    expect(bad).toEqual([]);
  });

  test('Settings lists the announcements that have a text, and one the admins wrote', async ({ page }) => {
    await boot(page, { templates: { ann_runher: { en: 'Run for Her on {date}' } }, bare: ['wk_farm'] });
    await page.waitForFunction('S._tpl&&S._tpl.ann_runher');
    await page.evaluate(`setStaffTab('settings')`);
    const sec = page.locator('#tab-settings .set-card', { hasText: 'Message templates' });
    await expect(sec.locator('.set-k', { hasText: 'Weekly announcement' })).toHaveCount(1);
    await expect(sec.locator('.tpl-row[data-tpl="wk_jcc"]')).toHaveCount(1);
    await expect(sec.locator('.tpl-row[data-tpl="wk_farm"]')).toHaveCount(0);
    await expect(sec.locator('.tpl-row[data-tpl="ann_runher"] .tpl-own')).toHaveText('Customized');
    // the editor opens on the built-in block, its fill-ins offered
    await sec.locator('.tpl-row[data-tpl="wk_petromin"]').click();
    const ed = page.locator('#confirm-modal .tpl-box');
    await expect(ed.locator('#tpl-text')).toHaveValue(/^\*\{day\} \| Petromin Night at JCC\*/);
    await expect(ed.locator('.tpl-fill', { hasText: '{bikes_from}' })).toHaveCount(1);
  });
});
