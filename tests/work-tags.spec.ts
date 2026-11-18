import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The four work tags (the user, 2026-11-18: "create new lawyer hr senior marketing, show me a lot of design options",
// then their picks on the new staff tags page): Lawyer, the scales of justice on taupe; HR, the letters HR on berry;
// Senior, a necktie on chocolate; Marketing, the word itself on indigo. Staff give them and only staff see them: the
// mark after the holder's name on their bookings (not beside the account's name), a band in the tag's colour on their
// Bookings row with the name in it, a filter on People and Bookings, and report counts. And tapping any tag's mark or
// chip on a staff screen opens its name and description (the user, same day: "make clicking on a tag from staff shows
// the name and description of it"). All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const TAUPE = 'rgb(125, 107, 93)';
const BERRY = 'rgb(166, 30, 77)';
const CHOC = 'rgb(138, 75, 31)';
const INDIGO = 'rgb(76, 63, 209)';
const PLUM = 'rgb(134, 46, 156)';
const GREEN = 'rgb(12, 122, 61)';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const tag = (id: string, slug: string, name: string, color: string, description: string | null) => ({ id, slug, name, color, description, locked: true, auto_grant: false });
const baseTags = [
  tag('tag_saturday', 'saturday', 'Community', '#0c7a3d', 'Marks Saturday Social Ride regulars.'),
  tag('tag_influencer', 'influencer', 'Influencer', '#862e9c', 'An influencer: given by staff, seen only by staff.'),
  tag('tag_lawyer', 'lawyer', 'Lawyer', '#7d6b5d', 'A lawyer: given by staff, seen only by staff.'),
  tag('tag_hr', 'hr', 'HR', '#a61e4d', 'Works in HR (human resources): given by staff, seen only by staff.'),
  tag('tag_senior', 'senior', 'Senior', '#8a4b1f', 'Holds a senior role: given by staff, seen only by staff.'),
  tag('tag_marketing', 'marketing', 'Marketing', '#4c3fd1', null),
];
const cust = (id: string, name: string) => ({ id, name, email: id + '@example.test', phone: '05000000' + id.slice(1).padStart(2, '0'), height: 170, created_at: '2026-01-01T00:00:00Z' });
const customers = [cust('c1', 'Lara Lawyer'), cust('c2', 'Hana Hr'), cust('c3', 'Sami Senior'), cust('c4', 'Mona Marketing'),
  cust('c5', 'Leo Both'), cust('c6', 'Ivy Influencer'), cust('c7', 'Nora Nobody'), cust('c8', 'Carl Community')];
const ct = (customer_id: string, tag_id: string) => ({ customer_id, tag_id, added_by: 'staff', added_at: 1 });
const customer_tags = [
  ct('c1', 'tag_lawyer'), ct('c2', 'tag_hr'), ct('c3', 'tag_senior'), ct('c4', 'tag_marketing'),
  ct('c5', 'tag_lawyer'), ct('c5', 'tag_senior'),
  ct('c6', 'tag_influencer'), ct('c6', 'tag_lawyer'),
  ct('c8', 'tag_saturday'), ct('c8', 'tag_marketing'),
];
const row = (n: number, cid: string, name: string) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-11-18T10:00:00Z',
});
const queue_entries = customers.map((c, i) => row(i + 1, c.id, c.name));

async function boot(page: Page, width = 1440, tags: Record<string, unknown>[] = baseTags) {
  await page.setViewportSize({ width, height: 1000 });
  await stubSupabase(page, { sessions, queue_entries, bikes: [], tags, customers, customer_tags, staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0&&(S.customerTags||[]).length>0');
}
const tr = (page: Page, id: string) => page.locator(`#tab-queue .queue-table tbody tr[data-id="${id}"]`);
const roster = (page: Page) => page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${LIVE}';S.sfShowFinished=true;renderStaffQueue()`);
const accounts = (page: Page) => page.evaluate(`setStaffTab('customers');S.communityTab='accounts';renderCustomers()`);
const sh = (page: Page, id: string) => tr(page, id).locator('td').first().evaluate((el) => getComputedStyle(el).boxShadow);
const info = (page: Page) => page.locator('#confirm-modal .tag-info');

test.describe('@staff:tags The work tags: Lawyer, HR, Senior, Marketing', () => {
  test('their chips: the scales on taupe, HR on berry, the tie on chocolate, the word on indigo', async ({ page }) => {
    await boot(page);
    await accounts(page);
    const chip = (cls: string) => page.locator('#am-cust-rows .am-chip.tag-brand', { has: page.locator('.tag-svg-' + cls) }).first();
    for (const [cls, col, name] of [['law', TAUPE, 'Lawyer'], ['hrt', BERRY, 'HR'], ['snr', CHOC, 'Senior'], ['mkt', INDIGO, 'Marketing']]) {
      await expect(chip(cls)).toBeVisible();
      await expect(chip(cls)).toHaveCSS('background-color', col);
      await expect(chip(cls)).toHaveAttribute('title', name);
    }
    for (const cls of ['law', 'hrt', 'snr']) await expect(chip(cls).locator('svg.pro-ico')).toHaveCount(1);
    // Marketing is the word itself, in capitals
    await expect(chip('mkt').locator('.pro-wd')).toHaveText('Marketing');
    await expect(chip('mkt').locator('.pro-wd')).toHaveCSS('text-transform', 'uppercase');
  });

  test('Bookings: the mark after a holder\'s name, a band and the name in the tag\'s colour', async ({ page }) => {
    await boot(page);
    await roster(page);
    const cases: [string, string, string, string][] = [['q1', 'law', TAUPE, 'Lawyer'], ['q2', 'hrt', BERRY, 'HR'], ['q3', 'snr', CHOC, 'Senior'], ['q4', 'mkt', INDIGO, 'Marketing']];
    for (const [id, k, col, name] of cases) {
      await expect(tr(page, id)).toHaveClass(new RegExp(`\\bpro-row\\b.*\\b${k}-row\\b`));
      await expect(tr(page, id).locator(`.${k}-mk`)).toHaveAttribute('title', name);
      await expect(tr(page, id).locator(`.${k}-mk`)).toHaveCSS('background-color', col);
      expect(await sh(page, id)).toContain(col);
      await expect(tr(page, id).locator('.rider-name').first()).toHaveCSS('color', col);
    }
    await expect(tr(page, 'q4').locator('.mkt-mk .pro-wd')).toHaveText('Marketing');
    await expect(tr(page, 'q7')).not.toHaveClass(/\bpro-row\b/);
    await expect(tr(page, 'q7').locator('.pro-mk')).toHaveCount(0);
    // a holder of two: both marks, the first one's band
    await expect(tr(page, 'q5').locator('.law-mk + .snr-mk')).toHaveCount(1);
    expect(await sh(page, 'q5')).toContain(TAUPE);
    expect(await sh(page, 'q5')).not.toContain(CHOC);
    // an influencer keeps the plum band; both marks show
    expect(await sh(page, 'q6')).toContain(PLUM);
    expect(await sh(page, 'q6')).not.toContain(TAUPE);
    await expect(tr(page, 'q6').locator('.inf-mk ~ .law-mk')).toHaveCount(1);
    // a member: the green band, then the tag's inside it
    const both = await sh(page, 'q8');
    expect(both).toContain(GREEN);
    expect(both).toContain(INDIGO);
    expect(both.indexOf(GREEN)).toBeLessThan(both.indexOf(INDIGO));
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/work-tags-roster.png` });
    // the phone cards too
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(`renderStaffQueue()`);
    const card = page.locator('#tab-queue .queue-mobile-view .q-card[data-id="q2"]');
    await expect(card).toHaveClass(/\bhrt-row\b/);
    await expect(card.locator('.hrt-mk')).toHaveCount(1);
    expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(BERRY);
  });

  test('not beside the account\'s name: Accounts and the account page carry no mark', async ({ page }) => {
    await boot(page);
    await accounts(page);
    const nameRow = page.locator('#am-cust-rows .am-cust', { has: page.locator('.am-cust-name', { hasText: 'Lara Lawyer' }) });
    await expect(nameRow).toHaveCount(1);
    await expect(nameRow.locator('.am-c-nm .pro-mk')).toHaveCount(0);
    await page.evaluate(`openAccountHistory('c1')`);
    await expect(page.locator('#ah-title')).toBeVisible();
    await expect(page.locator('#ah-title .pro-mk')).toHaveCount(0);
  });

  test('the filters on Bookings and on People', async ({ page }) => {
    await boot(page);
    await roster(page);
    await page.evaluate(`S.sfLaw='yes';renderStaffQueue()`);
    for (const id of ['q1', 'q5', 'q6']) await expect(tr(page, id)).toHaveCount(1);
    for (const id of ['q2', 'q3', 'q4', 'q7', 'q8']) await expect(tr(page, id)).toHaveCount(0);
    await page.evaluate(`S.sfLaw='all';S.sfMkt='no';renderStaffQueue()`);
    await expect(tr(page, 'q4')).toHaveCount(0);
    await expect(tr(page, 'q8')).toHaveCount(0);
    await expect(tr(page, 'q1')).toHaveCount(1);
    const pick = (k: string): Promise<string[]> => page.evaluate(`(()=>{const d=_amDefs(true).find(x=>x[0]==='${k}');return S.customers.filter(c=>d[3](c,'yes')).map(c=>c.id).sort();})()`);
    expect(await pick('amLaw')).toEqual(['c1', 'c5', 'c6']);
    expect(await pick('amHrt')).toEqual(['c2']);
    expect(await pick('amSnr')).toEqual(['c3', 'c5']);
    expect(await pick('amMkt')).toEqual(['c4', 'c8']);
  });

  test('the reports count holders: the account report\'s sections and columns, the session sheet\'s tiles', async ({ page }) => {
    await boot(page);
    const html: string = await page.evaluate(`_accReportHtml()`);
    for (const h of ['Lawyer', 'HR', 'Senior', 'Marketing']) expect(html).toContain(`<h2>${h}</h2>`);
    expect(await page.evaluate(`['proLaw','proHrt','proSnr','proMkt'].every(k=>_ACC_COLS.some(c=>c.k===k)&&_ACC_SECTIONS.some(c=>c.k===k))`)).toBe(true);
    const tiles: string = await page.evaluate(`_proTiles(getQueue())`);
    expect(tiles).toContain('Lawyer');
    expect(tiles).toContain('38%'); // 3 of 8
    // and the printed rosters carry the marks
    expect(await page.evaluate(`_proChips(getQueue().find(e=>e.id==='q5'))`)).toMatch(/law-mk[\s\S]*snr-mk/);
  });

  test('hidden on the Tags page, a tag is off the roster, the filters and the reports; the others stay', async ({ page }) => {
    await boot(page, 1440, baseTags.map((t) => (t.id === 'tag_lawyer' ? { ...t, hidden_at: '2026-11-18T12:00:00Z', hidden_by: 'staff' } : t)));
    await roster(page);
    await expect(tr(page, 'q1')).toHaveCount(1);
    await expect(tr(page, 'q1')).not.toHaveClass(/\bpro-row\b/);
    await expect(page.locator('#tab-queue .law-mk')).toHaveCount(0);
    // the senior mark and its band take over for a holder of both
    await expect(tr(page, 'q5').locator('.snr-mk')).toHaveCount(1);
    expect(await sh(page, 'q5')).toContain(CHOC);
    expect(await page.evaluate(`_amDefs(true).some(x=>x[0]==='amLaw')`)).toBe(false);
    expect(await page.evaluate(`_accReportHtml()`)).not.toContain('<h2>Lawyer</h2>');
  });
});

test.describe('@staff:tags Tapping a tag shows its name and description', () => {
  test('a mark on Bookings opens the centred pop-up with the tag\'s name and description', async ({ page }) => {
    await boot(page);
    await roster(page);
    await tr(page, 'q1').locator('.law-mk').click();
    await expect(info(page)).toBeVisible();
    await expect(page.locator('#dlgt-taginfo')).toHaveText('Lawyer');
    await expect(info(page).locator('.tag-info-d')).toHaveText('A lawyer: given by staff, seen only by staff.');
    await expect(info(page).locator('.tag-info-h .tag-svg-law')).toHaveCount(1);
    // centred
    const box = await info(page).boundingBox();
    expect(box && Math.abs(box.x + box.width / 2 - 720) < 4).toBe(true);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/tag-info.png` });
    await info(page).locator('.x-close').click();
    await expect(info(page)).toHaveCount(0);
    // the other tags' marks too: the influencer's star and the community's mark
    await tr(page, 'q6').locator('.inf-mk').click();
    await expect(page.locator('#dlgt-taginfo')).toHaveText('Influencer');
    await page.evaluate(`closeConfirm()`);
    await tr(page, 'q8').locator('.cm-mk').click();
    await expect(page.locator('#dlgt-taginfo')).toHaveText('Community');
    await expect(info(page).locator('.tag-info-d')).toHaveText('Marks Saturday Social Ride regulars.');
  });

  test('a tag with no description says so', async ({ page }) => {
    await boot(page);
    await roster(page);
    await tr(page, 'q4').locator('.mkt-mk').click();
    await expect(page.locator('#dlgt-taginfo')).toHaveText('Marketing');
    await expect(info(page).locator('.tag-info-none')).toHaveText('No description yet. Admins write one on the Tags page.');
  });

  test('a tag chip on Accounts opens it too', async ({ page }) => {
    await boot(page);
    await accounts(page);
    await page.locator('#am-cust-rows .am-chip.tag-brand', { has: page.locator('.tag-svg-snr') }).first().click();
    await expect(page.locator('#dlgt-taginfo')).toHaveText('Senior');
    await expect(info(page).locator('.tag-info-d')).toHaveText('Holds a senior role: given by staff, seen only by staff.');
  });

  test('the tap stops at the mark: what it sits in does not open as well', async ({ page }) => {
    await boot(page);
    await roster(page);
    // a button with its own click around a mark, as the hand-over and door rows are
    await page.evaluate(`(()=>{window.__rowTaps=0;window._wtRowTap=function(){window.__rowTaps++;};
      const b=document.createElement('button');b.type='button';b.id='wt-host';b.setAttribute('data-on-click',JSON.stringify(['_wtRowTap']));
      b.innerHTML='Host '+_proChips(getQueue().find(e=>e.id==='q2'));document.body.appendChild(b);})()`);
    await page.locator('#wt-host .hrt-mk').click();
    await expect(page.locator('#dlgt-taginfo')).toHaveText('HR');
    expect(await page.evaluate(`window.__rowTaps`)).toBe(0);
    await page.evaluate(`closeConfirm()`);
    await page.locator('#wt-host').click({ position: { x: 4, y: 4 } });
    expect(await page.evaluate(`window.__rowTaps`)).toBe(1);
    // with another pop-up up, the tap is left alone
    await page.evaluate(`confirmDialog({title:'Something else',body:'',confirmLabel:'OK',confirmClass:'btn-primary',onConfirm:()=>{}})`);
    await page.evaluate(`_tagInfo('tag_hr',null)`);
    await expect(page.locator('#dlgt-confirm')).toHaveText('Something else');
    await expect(info(page)).toHaveCount(0);
  });
});
