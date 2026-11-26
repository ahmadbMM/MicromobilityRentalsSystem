import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Banker tag (the user, 2026-11-26: "add a new banker tag and give me multiple options to choose", then their
// picks): a bank drawn in lines on bank green #14532d, for anyone in banking or finance. Shown where the Doctor and PIF
// tags show (the mark after the name on bookings and beside the account's name, the band, filters, report counts, off
// the printed sheets). Like PIF, staff may note the bank (a list, Other typed, or none) in customer_tags.note.
// All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const GREEN = 'rgb(20, 83, 45)';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const tag = (id: string, slug: string, name: string, color: string, description: string | null) => ({ id, slug, name, color, description, locked: true, auto_grant: false });
const tags = [
  tag('tag_saturday', 'saturday', 'Community', '#0c7a3d', 'Marks Saturday Social Ride regulars.'),
  tag('tag_pif', 'pif', 'PIF & subsidiaries', '#8c6a2c', 'Works at PIF.'),
  tag('tag_banker', 'banker', 'Banker', '#14532d', 'Works in banking or finance.'),
];
const cust = (id: string, name: string) => ({ id, name, email: id + '@example.test', phone: '05000000' + id.slice(1).padStart(2, '0'), height: 170, created_at: '2026-01-01T00:00:00Z' });
const customers = [cust('c1', 'Bilal Bank'), cust('c2', 'Tala Typed'), cust('c3', 'Nada Nobank'), cust('c4', 'Nora Nobody'), cust('c5', 'Pia Pif')];
const ct = (customer_id: string, tag_id: string, note: string | null) => ({ customer_id, tag_id, added_by: 'staff', added_at: 1, note });
const customer_tags = [ct('c1', 'tag_banker', 'Al Rajhi Bank'), ct('c2', 'tag_banker', 'Emirates NBD'), ct('c3', 'tag_banker', null), ct('c5', 'tag_pif', 'NEOM')];
const row = (n: number, cid: string, name: string) => ({
  id: 'q' + n, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-11-26T10:00:00Z',
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
const nameRow = (page: Page, name: string) => page.locator('#am-cust-rows .am-cust', { has: page.locator('.am-cust-name', { hasText: name }) });
const info = (page: Page) => page.locator('#confirm-modal .tag-info');

test.describe('@staff:tags The Banker tag', () => {
  test('its chip, and the mark beside the account\'s name', async ({ page }) => {
    await boot(page);
    await accounts(page);
    const chip = nameRow(page, 'Bilal Bank').locator('.am-chip.tag-brand', { has: page.locator('.tag-svg-bnk') });
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveCSS('background-color', GREEN);
    await expect(chip).toHaveAttribute('title', 'Banker · Al Rajhi Bank');
    await expect(nameRow(page, 'Bilal Bank').locator('.am-c-nm .bnk-mk')).toHaveCount(1);
    await expect(nameRow(page, 'Nora Nobody').locator('.am-c-nm .pro-mk')).toHaveCount(0);
  });

  test('Bookings: the mark (titled with the bank) and the band; the name keeps its own colour', async ({ page }) => {
    await boot(page);
    await roster(page);
    const plain = await tr(page, 'q4').locator('.rider-name').first().evaluate((el) => getComputedStyle(el).color);
    await expect(tr(page, 'q1')).toHaveClass(/\bpro-row\b.*\bbnk-row\b.*\bpro-nt\b/);
    const mk = tr(page, 'q1').locator('.bnk-mk');
    await expect(mk).toHaveCSS('background-color', GREEN);
    await expect(mk).toHaveAttribute('title', 'Banker · Al Rajhi Bank');
    await expect(mk.locator('svg.pro-ico')).toHaveCount(1);
    await expect(tr(page, 'q3').locator('.bnk-mk')).toHaveAttribute('title', 'Banker');
    expect(await sh(page, 'q1')).toContain(GREEN);
    await expect(tr(page, 'q1').locator('.rider-name').first()).toHaveCSS('color', plain);
    await expect(tr(page, 'q4').locator('.pro-mk')).toHaveCount(0);
    await page.evaluate(`document.documentElement.setAttribute('data-staff-theme','dark')`);
    await roster(page);
    expect(await sh(page, 'q1')).toContain('rgb(64, 160, 102)');
  });

  test('off the printed sheets, still counted, filtered by bank and in the account report', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`_proChips(getQueue().find(e=>e.id==='q1'),1)`)).not.toContain('bnk-mk');
    expect(await page.evaluate(`_proTiles(getQueue())`)).toContain('Banker');
    const pick = (k: string, v: string): Promise<string[]> => page.evaluate(`(()=>{const d=_amDefs(true).find(x=>x[0]==='${k}');return S.customers.filter(c=>d[3](c,${JSON.stringify(v)})).map(c=>c.id).sort();})()`);
    expect(await pick('amBnk', 'yes')).toEqual(['c1', 'c2', 'c3']);
    expect(await pick('amBnk', 'co:Al Rajhi Bank')).toEqual(['c1']);
    expect(await pick('amBnk', 'co:')).toEqual(['c3']);
    expect(await pick('amPif', 'co:NEOM')).toEqual(['c5']);
    const opts: string[] = await page.evaluate(`_amDefs(true).find(x=>x[0]==='amBnk')[2].map(o=>o[1])`);
    expect(opts).toEqual(['Yes', 'No', 'Al Rajhi Bank', 'Emirates NBD', 'No bank']);
    await roster(page);
    await page.evaluate(`S.sfBnk='yes';renderStaffQueue()`);
    await expect(tr(page, 'q1')).toHaveCount(1);
    await expect(tr(page, 'q4')).toHaveCount(0);
    const html: string = await page.evaluate(`_accReportHtml()`);
    expect(html).toContain('<h2>Banker</h2>');
    for (const b of ['Al Rajhi Bank', 'Emirates NBD', 'No bank']) expect(html).toContain(`<span class="total-lbl">${b}</span>`);
    expect(await page.evaluate(`_ACC_COLS.some(c=>c.k==='proBnk')&&_ACC_SECTIONS.some(c=>c.k==='proBnk')`)).toBe(true);
  });

  test('giving Banker asks the bank: No bank by default, one from the list, or Other with a name', async ({ page }) => {
    const posts: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/rest/v1/customer_tags')) { const b = r.postDataJSON(); posts.push(...(Array.isArray(b) ? b : [b])); }
    });
    await boot(page);
    await accounts(page);
    const grant = page.locator('#confirm-modal .btn-primary', { hasText: 'Add tag' });
    await page.evaluate(`showTagGrantModal('c4','tag_banker')`);
    await expect(page.locator('label[for="pif-co"]')).toHaveText('Bank');
    await expect(page.locator('#pif-co')).toHaveValue('');
    await expect(page.locator('#pif-co option')).toHaveCount(14); // No bank, 12 banks, Other
    await expect(page.locator('#pif-co option').first()).toHaveText('No bank');
    await page.locator('#pif-co').selectOption('_other');
    await expect(page.locator('#pif-co-other')).toHaveAttribute('placeholder', 'Bank name');
    await grant.click();
    await expect(page.locator('.toast.error')).toContainText('Type the bank name, or pick No bank.');
    expect(posts.length).toBe(0);
    await page.locator('#pif-co').selectOption('Riyad Bank');
    await grant.click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ customer_id: 'c4', tag_id: 'tag_banker', note: 'Riyad Bank' });
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    // PIF keeps its own words and list
    await page.evaluate(`showTagGrantModal('c4','tag_pif')`);
    await expect(page.locator('label[for="pif-co"]')).toHaveText('Company');
    await expect(page.locator('#pif-co option')).toHaveCount(18);
  });

  test('tapping a holder\'s mark shows the bank, and Change bank writes it', async ({ page }) => {
    const patches: { url: string; body: unknown }[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customer_tags')) patches.push({ url: r.url(), body: r.postDataJSON() }); });
    await boot(page);
    await roster(page);
    await tr(page, 'q2').locator('.bnk-mk').click();
    await expect(page.locator('#dlgt-taginfo')).toHaveText('Banker');
    await expect(info(page).locator('.tag-info-cov')).toHaveText('Emirates NBD');
    await info(page).locator('button', { hasText: 'Change bank' }).click();
    await expect(page.locator('#dlgt-pifco')).toHaveText('Change bank');
    await expect(page.locator('#pif-co')).toHaveValue('_other');
    await expect(page.locator('#pif-co-other')).toHaveValue('Emirates NBD');
    await page.locator('#pif-co').selectOption('SAB');
    await page.locator('#confirm-modal .btn-primary', { hasText: 'Save' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].body).toEqual({ note: 'SAB' });
    expect(patches[0].url).toContain('customer_id=eq.c2');
    expect(patches[0].url).toContain('tag_id=eq.tag_banker');
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    await expect(tr(page, 'q2').locator('.bnk-mk')).toHaveAttribute('title', 'Banker · SAB');
    await tr(page, 'q3').locator('.bnk-mk').click();
    await expect(info(page).locator('.tag-info-cov')).toHaveText('No bank');
  });

  test('every language names it and its bank words', async () => {
    for (const c of ['ar', 'bn', 'es', 'fr', 'hi', 'ms', 'ne', 'pt', 'tl', 'ur']) {
      // the build keeps the desk's own words in the staff pack (lang/staff-<code>.json), the shared ones in lang/<code>.json
      const pack = { ...JSON.parse(readFileSync(`lang/${c}.json`, 'utf8')), ...JSON.parse(readFileSync(`lang/staff-${c}.json`, 'utf8')) };
      for (const k of ['bnkLabel', 'bnkCoLabel', 'bnkCoNone', 'bnkCoOtherPh', 'bnkCoChange', 'bnkCoNeed']) expect(pack[k], c + ' ' + k).toBeTruthy();
    }
    expect(JSON.parse(readFileSync('lang/ar.json', 'utf8')).bnkLabel).toBe('مصرفي');
  });
});
