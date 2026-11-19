import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Medical doctor and PIF & subsidiaries tags (the user, 2026-11-19: "add a new medical doctor tag and pif &
// subsidaries tag give me options to choose from, for pif include the logo as an option", then their picks): Medical
// doctor a heart with a heartbeat cut out of it on hospital blue, PIF & subsidiaries PIF's seal and letters on a white
// chip edged in PIF gold. Staff give them and only staff see them: the mark after the holder's name on bookings and
// beside the account's name, the band (the name keeps its own colour), filters and report counts, never on the printed
// sheets. A PIF holder may carry the company they work at, or none ("let the staff have the option to put the company
// in pif or not include one"), kept in customer_tags.note. All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const BLUE = 'rgb(25, 113, 194)';
const GOLD = 'rgb(140, 106, 44)';
const TAUPE = 'rgb(125, 107, 93)';
const WHITE = 'rgb(255, 255, 255)';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const tag = (id: string, slug: string, name: string, color: string, description: string | null) => ({ id, slug, name, color, description, locked: true, auto_grant: false });
const tags = [
  tag('tag_saturday', 'saturday', 'Community', '#0c7a3d', 'Marks Saturday Social Ride regulars.'),
  tag('tag_lawyer', 'lawyer', 'Lawyer', '#7d6b5d', 'A lawyer: given by staff, seen only by staff.'),
  tag('tag_doctor', 'doctor', 'Medical doctor', '#1971c2', 'A medical doctor: given by staff, seen only by staff.'),
  tag('tag_pif', 'pif', 'PIF & subsidiaries', '#8c6a2c', 'Works at PIF or one of its companies.'),
];
const cust = (id: string, name: string) => ({ id, name, email: id + '@example.test', phone: '05000000' + id.slice(1).padStart(2, '0'), height: 170, created_at: '2026-01-01T00:00:00Z' });
const customers = [cust('c1', 'Dana Doctor'), cust('c2', 'Pia Pif'), cust('c3', 'Omar Nocompany'), cust('c4', 'Leo Lawyer'),
  cust('c5', 'Bea Both'), cust('c6', 'Nora Nobody')];
const ct = (customer_id: string, tag_id: string, note: string | null = null) => ({ customer_id, tag_id, added_by: 'staff', added_at: 1, note });
const customer_tags = [
  ct('c1', 'tag_doctor'), ct('c2', 'tag_pif', 'NEOM'), ct('c3', 'tag_pif'), ct('c4', 'tag_lawyer'),
  ct('c5', 'tag_doctor'), ct('c5', 'tag_pif', 'Acme Holdings'),
];
const row = (n: number, cid: string, name: string) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-11-19T10:00:00Z',
});
const queue_entries = customers.map((c, i) => row(i + 1, c.id, c.name));

async function boot(page: Page, width = 1440) {
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
const nameRow = (page: Page, name: string) => page.locator('#am-cust-rows .am-cust', { has: page.locator('.am-cust-name', { hasText: name }) });

test.describe('@staff:tags The Medical doctor and PIF & subsidiaries tags', () => {
  test('their chips: the heartbeat on hospital blue, the PIF logo on white edged in gold, with the company', async ({ page }) => {
    await boot(page);
    await accounts(page);
    const doc = page.locator('#am-cust-rows .am-chip.tag-brand', { has: page.locator('.tag-svg-doc') }).first();
    await expect(doc).toBeVisible();
    await expect(doc).toHaveCSS('background-color', BLUE);
    await expect(doc).toHaveAttribute('title', 'Medical doctor');
    await expect(doc.locator('svg.pro-ico path')).toHaveAttribute('fill-rule', 'evenodd');
    const pif = nameRow(page, 'Pia Pif').locator('.am-chip.tag-brand', { has: page.locator('img.tag-img-pif') });
    await expect(pif).toHaveCount(1);
    await expect(pif).toHaveCSS('background-color', WHITE);
    await expect(pif).toHaveCSS('border-top-color', GOLD);
    await expect(pif).toHaveAttribute('title', 'PIF & subsidiaries · NEOM');
    await expect(pif).toContainText('NEOM');
    expect(await pif.locator('img').evaluate((im: HTMLImageElement) => im.complete && im.naturalWidth > 0)).toBe(true);
    // no company: the logo alone
    const none = nameRow(page, 'Omar Nocompany').locator('.am-chip.tag-brand', { has: page.locator('img.tag-img-pif') });
    await expect(none).toHaveAttribute('title', 'PIF & subsidiaries');
    await expect(none.locator('span')).toHaveCount(0);
  });

  test('beside the account\'s name on Accounts and on the account page', async ({ page }) => {
    await boot(page);
    await accounts(page);
    await expect(nameRow(page, 'Dana Doctor').locator('.am-c-nm .doc-mk')).toHaveCount(1);
    await expect(nameRow(page, 'Pia Pif').locator('.am-c-nm .pif-mk img')).toHaveCount(1);
    await expect(nameRow(page, 'Bea Both').locator('.am-c-nm .doc-mk + .pif-mk')).toHaveCount(1);
    // the work tags still stay off the account's name
    await expect(nameRow(page, 'Leo Lawyer').locator('.am-c-nm .pro-mk')).toHaveCount(0);
    await page.evaluate(`openAccountHistory('c2')`);
    await expect(page.locator('#ah-title')).toBeVisible();
    await expect(page.locator('#ah-title .pif-mk')).toHaveAttribute('title', 'PIF & subsidiaries · NEOM');
  });

  test('Bookings: the mark after the name and the band; the name keeps its own colour', async ({ page }) => {
    await boot(page);
    await roster(page);
    const plain = await tr(page, 'q6').locator('.rider-name').first().evaluate((el) => getComputedStyle(el).color);
    await expect(tr(page, 'q1')).toHaveClass(/\bpro-row\b.*\bdoc-row\b.*\bpro-nt\b/);
    await expect(tr(page, 'q1').locator('.doc-mk')).toHaveCSS('background-color', BLUE);
    await expect(tr(page, 'q1').locator('.doc-mk')).toHaveAttribute('title', 'Medical doctor');
    expect(await sh(page, 'q1')).toContain(BLUE);
    await expect(tr(page, 'q1').locator('.rider-name').first()).toHaveCSS('color', plain);
    await expect(tr(page, 'q2').locator('.pif-mk')).toHaveAttribute('title', 'PIF & subsidiaries · NEOM');
    await expect(tr(page, 'q2').locator('.pif-mk')).toHaveCSS('background-color', WHITE);
    expect(await sh(page, 'q2')).toContain(GOLD);
    await expect(tr(page, 'q2').locator('.rider-name').first()).toHaveCSS('color', plain);
    await expect(tr(page, 'q3').locator('.pif-mk')).toHaveAttribute('title', 'PIF & subsidiaries');
    // a holder of both: both marks, the doctor's band
    await expect(tr(page, 'q5').locator('.doc-mk + .pif-mk')).toHaveCount(1);
    expect(await sh(page, 'q5')).toContain(BLUE);
    // the lawyer keeps the name in its colour
    await expect(tr(page, 'q4').locator('.rider-name').first()).toHaveCSS('color', TAUPE);
    await expect(tr(page, 'q6').locator('.pro-mk')).toHaveCount(0);
    if (process.env.SHOT_DIR) await page.locator('#tab-queue .queue-table').screenshot({ path: `${process.env.SHOT_DIR}/doctor-pif-roster.png` });
  });

  test('off the printed sheets, still counted', async ({ page }) => {
    await boot(page);
    const onScreen: string = await page.evaluate(`_proChips(getQueue().find(e=>e.id==='q5'))`);
    expect(onScreen).toMatch(/doc-mk[\s\S]*pif-mk/);
    const printed: string = await page.evaluate(`_proChips(getQueue().find(e=>e.id==='q5'),1)`);
    expect(printed).not.toContain('doc-mk');
    expect(printed).not.toContain('pif-mk');
    expect(await page.evaluate(`_proChips(getQueue().find(e=>e.id==='q4'),1)`)).toContain('law-mk');
    const tiles: string = await page.evaluate(`_proTiles(getQueue())`);
    expect(tiles).toContain('Medical doctor');
    expect(tiles).toContain('PIF &amp; subsidiaries');
    expect(tiles).toContain('50%'); // 3 of 6
  });

  test('the filters: People by tag and by company, Bookings by tag', async ({ page }) => {
    await boot(page);
    const pick = (k: string, v: string): Promise<string[]> => page.evaluate(`(()=>{const d=_amDefs(true).find(x=>x[0]==='${k}');return S.customers.filter(c=>d[3](c,${JSON.stringify(v)})).map(c=>c.id).sort();})()`);
    expect(await pick('amDoc', 'yes')).toEqual(['c1', 'c5']);
    expect(await pick('amPif', 'yes')).toEqual(['c2', 'c3', 'c5']);
    expect(await pick('amPif', 'no')).toEqual(['c1', 'c4', 'c6']);
    expect(await pick('amPif', 'co:NEOM')).toEqual(['c2']);
    expect(await pick('amPif', 'co:Acme Holdings')).toEqual(['c5']);
    expect(await pick('amPif', 'co:')).toEqual(['c3']);
    const opts: string[][] = await page.evaluate(`_amDefs(true).find(x=>x[0]==='amPif')[2]`);
    expect(opts.map((o) => o[0])).toEqual(['yes', 'no', 'co:Acme Holdings', 'co:NEOM', 'co:']);
    expect(opts[4][1]).toBe('No company');
    await roster(page);
    await page.evaluate(`S.sfPif='yes';renderStaffQueue()`);
    for (const id of ['q2', 'q3', 'q5']) await expect(tr(page, id)).toHaveCount(1);
    for (const id of ['q1', 'q4', 'q6']) await expect(tr(page, id)).toHaveCount(0);
    await page.evaluate(`S.sfPif='all';S.sfDoc='no';renderStaffQueue()`);
    for (const id of ['q1', 'q5']) await expect(tr(page, id)).toHaveCount(0);
    await expect(tr(page, 'q2')).toHaveCount(1);
  });

  test('the account report: a section for each, and a count per PIF company', async ({ page }) => {
    await boot(page);
    const html: string = await page.evaluate(`_accReportHtml()`);
    expect(html).toContain('<h2>Medical doctor</h2>');
    expect(html).toContain('<h2>PIF &amp; subsidiaries</h2>');
    for (const co of ['NEOM', 'Acme Holdings', 'No company']) expect(html).toContain(`<span class="total-lbl">${co}</span>`);
    expect(await page.evaluate(`['proDoc','proPif'].every(k=>_ACC_COLS.some(c=>c.k===k)&&_ACC_SECTIONS.some(c=>c.k===k))`)).toBe(true);
  });

  test('giving PIF asks the company: No company by default, a company from the list, or Other with a name', async ({ page }) => {
    const posts: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/rest/v1/customer_tags')) { const b = r.postDataJSON(); posts.push(...(Array.isArray(b) ? b : [b])); }
    });
    await boot(page);
    await accounts(page);
    const grant = page.locator('#confirm-modal .btn-primary', { hasText: 'Add tag' });
    // a company from the list
    await page.evaluate(`showTagGrantModal('c6','tag_pif')`);
    await expect(page.locator('#pif-co')).toHaveValue('');
    await expect(page.locator('#pif-co option')).toHaveCount(18); // No company, 16 companies, Other
    await page.locator('#pif-co').selectOption('NEOM');
    await grant.click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ customer_id: 'c6', tag_id: 'tag_pif', note: 'NEOM' });
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    // Other: a name is needed (each save closes its own dialog when its write answers: wait for that before the next)
    await page.evaluate(`S.customerTags=S.customerTags.filter(x=>!(x.customer_id==='c4'&&x.tag_id==='tag_pif'));showTagGrantModal('c4','tag_pif')`);
    await page.locator('#pif-co').selectOption('_other');
    await expect(page.locator('#pif-co-other')).toBeFocused();
    await grant.click();
    await expect(page.locator('.toast.error')).toContainText('Type the company name, or pick No company.');
    expect(posts.length).toBe(1);
    await page.locator('#pif-co-other').fill('  Acme Holdings ');
    await grant.click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toMatchObject({ customer_id: 'c4', tag_id: 'tag_pif', note: 'Acme Holdings' });
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    // no company
    await page.evaluate(`showTagGrantModal('c1','tag_pif')`);
    await grant.click();
    await expect.poll(() => posts.length).toBe(3);
    expect(posts[2]).toMatchObject({ customer_id: 'c1', tag_id: 'tag_pif', note: null });
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    // another tag asks nothing and writes no note
    await page.evaluate(`showTagGrantModal('c6','tag_doctor')`);
    await expect(page.locator('#pif-co')).toHaveCount(0);
    await grant.click();
    await expect.poll(() => posts.length).toBe(4);
    expect(posts[3]).not.toHaveProperty('note');
  });

  test('tapping a PIF holder\'s mark shows the company, and Change company writes it', async ({ page }) => {
    const patches: { url: string; body: unknown }[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customer_tags')) patches.push({ url: r.url(), body: r.postDataJSON() }); });
    await boot(page);
    await roster(page);
    await tr(page, 'q2').locator('.pif-mk').click();
    await expect(page.locator('#dlgt-taginfo')).toHaveText('PIF & subsidiaries');
    await expect(info(page).locator('.tag-info-cov')).toHaveText('NEOM');
    await info(page).locator('button', { hasText: 'Change company' }).click();
    await expect(page.locator('#dlgt-pifco')).toHaveText('Change company');
    await expect(page.locator('#pif-co')).toHaveValue('NEOM');
    await page.locator('#pif-co').selectOption('Riyadh Air');
    await page.locator('#confirm-modal .btn-primary', { hasText: 'Save' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].body).toEqual({ note: 'Riyadh Air' });
    expect(patches[0].url).toContain('customer_id=eq.c2');
    expect(patches[0].url).toContain('tag_id=eq.tag_pif');
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    expect(await page.evaluate(`_pifCo('c2')`)).toBe('Riyadh Air');
    await expect(tr(page, 'q2').locator('.pif-mk')).toHaveAttribute('title', 'PIF & subsidiaries · Riyadh Air');
    // a typed company opens on Other with its name; clearing it to No company writes null
    await tr(page, 'q5').locator('.pif-mk').click();
    await expect(info(page).locator('.tag-info-cov')).toHaveText('Acme Holdings');
    await info(page).locator('button', { hasText: 'Change company' }).click();
    await expect(page.locator('#pif-co')).toHaveValue('_other');
    await expect(page.locator('#pif-co-other')).toHaveValue('Acme Holdings');
    await page.locator('#pif-co').selectOption('');
    await page.locator('#confirm-modal .btn-primary', { hasText: 'Save' }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1].body).toEqual({ note: null });
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    // no company: it says so
    await tr(page, 'q3').locator('.pif-mk').click();
    await expect(info(page).locator('.tag-info-cov')).toHaveText('No company');
    await page.evaluate(`closeConfirm()`);
    // the doctor's mark and a PIF tap with no account carry no company line
    await tr(page, 'q1').locator('.doc-mk').click();
    await expect(page.locator('#dlgt-taginfo')).toHaveText('Medical doctor');
    await expect(info(page).locator('.tag-info-co')).toHaveCount(0);
    await page.evaluate(`closeConfirm();_tagInfo('tag_pif',null)`);
    await expect(info(page).locator('.tag-info-co')).toHaveCount(0);
  });
});
