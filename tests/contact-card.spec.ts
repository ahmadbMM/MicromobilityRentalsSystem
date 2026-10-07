import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff ring and message riders all evening from the desk phone. The accounts list holds the
// name, the number and the rest already; one button hands the phone a card it understands,
// so the next call comes from a name instead of a number.

const customers = [
  {
    id: 'c1', name: 'Amal Al Rashid', email: 'amal@example.test', phone: '+966500000001',
    height: 168, type_preference: 'Road', gender: 'female', birth_date: '1994-03-14',
    city: 'Jeddah', country: 'Saudi Arabia', nationality: 'Jordan',
    socials: { instagram: 'amal.rides' }, created_at: '2026-01-05T10:00:00Z',
  },
  { id: 'c2', name: 'No Contact', email: null, phone: null, created_at: '2026-01-06T10:00:00Z' },
];
const tags = [{ id: 'tag_saturday', name: 'Saturday', slug: 'saturday', color: '#077A4B', locked: true }];
const customer_tags = [{ customer_id: 'c1', tag_id: 'tag_saturday', starts_at: null, expires_at: null }];

async function accounts(page: import('@playwright/test').Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags, customer_tags });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  await expect(page.locator('.am-vcard')).toHaveCount(2);
}


test('the card carries what staff would otherwise come back for', async ({ page }) => {
  await accounts(page);
  const vcf = await page.evaluate(`_vcardFor((S.customers||[]).find(c=>c.id==='c1'))`) as string;
  expect(vcf.startsWith('BEGIN:VCARD')).toBe(true);
  expect(vcf.trim().endsWith('END:VCARD')).toBe(true);
  expect(vcf).toContain('FN:Amal Al Rashid');
  expect(vcf).toContain('N:Rashid;Amal Al;;;');            // family name last, the rest given
  expect(vcf).toContain('TEL;TYPE=CELL:+966500000001');
  expect(vcf).toContain('EMAIL;TYPE=INTERNET:amal@example.test');
  expect(vcf).toContain('BDAY:1994-03-14');
  expect(vcf).toContain('ORG:MicroMobility');
  expect(vcf).toContain('Jeddah');
  expect(vcf).toContain('instagram.com/amal.rides');
  expect(vcf).toMatch(/NOTE:.*168/);                        // height
  expect(vcf).toMatch(/NOTE:.*Saturday/);                   // the tag they hold
  expect(vcf.split('\r\n').length).toBeGreaterThan(8);      // vCard lines end CRLF
});

test('the button is on every row and downloads a .vcf named for the rider', async ({ page }) => {
  await accounts(page);
  // The list is newest first, so pick the button by the id its handler carries.
  const btn = page.locator(`.am-vcard[data-on-click*="c1"]`);
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-label', 'Save contact');
  const [file] = await Promise.all([page.waitForEvent('download'), btn.click()]);
  expect(file.suggestedFilename()).toBe('Amal Al Rashid.vcf');
  await expect(page.locator('.toast')).toContainText('saved as a contact');
});

test('an account with no phone and no email says so instead of handing over an empty card', async ({ page }) => {
  await accounts(page);
  await page.evaluate(`saveCustomerContact('c2')`);
  await expect(page.locator('.toast')).toContainText('no phone or email');
});

test('a name with no surname still makes a valid card', async ({ page }) => {
  await accounts(page);
  const vcf = await page.evaluate(`_vcardFor({id:'x',name:'Mononym',phone:'+966500000009'})`) as string;
  expect(vcf).toContain('FN:Mononym');
  expect(vcf).toContain('N:;Mononym;;;');
});

// Safari answered "cannot download this file" to the blob-plus-download route, and on a phone
// a download lands in Files where nobody looks for it. The share sheet is the path that
// reaches Contacts, so it is tried first and the download is the desktop fallback.
test('a phone hands the card to the share sheet instead of downloading it', async ({ page }) => {
  await accounts(page);
  const shared = await page.evaluate(`(()=>{
    let got=null;
    navigator.canShare=(d)=>!!(d&&d.files&&d.files.length);
    navigator.share=(d)=>{got={name:d.files[0].name,type:d.files[0].type};return Promise.resolve();};
    document.querySelector('.am-vcard[data-on-click*="c1"]').click();
    return got;
  })()`) as { name: string; type: string } | null;
  expect(shared).not.toBeNull();
  expect(shared?.type).toBe('text/vcard');
  expect(shared?.name).toMatch(/\.vcf$/);
});

test('what is handed over starts at BEGIN:VCARD, with no byte-order mark in front', async ({ page }) => {
  await accounts(page);
  const first = await page.evaluate(`(()=>{
    let text='';
    navigator.canShare=(d)=>!!(d&&d.files&&d.files.length);
    navigator.share=(d)=>{return d.files[0].text().then(t=>{text=t;});};
    document.querySelector('.am-vcard[data-on-click*="c1"]').click();
    return new Promise(r=>setTimeout(()=>r(text),120));
  })()`) as string;
  expect(first.startsWith('BEGIN:VCARD')).toBe(true);   // a BOM here is what broke the parse
  expect(first).toContain('\r\n');
});

// An iPhone has no route from a card the page makes to Contacts: the share sheet has no
// Contacts in it and a download lands in Files. Served from the site as text/vcard, Safari
// opens it as the contact with "Create New Contact", so on an iPhone the card is posted to
// /api/contact in a new tab. (What that endpoint answers is in pages-functions.spec.ts.)
test.describe('on an iPhone', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1' });

  test('the card is posted to the site and opens in a new tab, with nothing claimed as saved', async ({ page, context }) => {
    await accounts(page);
    let posted = '';
    await context.route('**/api/contact', async (route) => {
      posted = route.request().postData() || '';
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'the card' });
    });
    const shared = await page.evaluate(`(()=>{window.__shared=false;navigator.share=()=>{window.__shared=true;return Promise.resolve();};navigator.canShare=()=>true;return 0;})()`);
    expect(shared).toBe(0);
    const [tab] = await Promise.all([context.waitForEvent('page'), page.locator('.am-vcard[data-on-click*="c1"]').click()]);
    await tab.waitForLoadState();
    expect(tab.url()).toContain('/api/contact');
    const sent = new URLSearchParams(posted);
    expect(sent.get('vcf')?.startsWith('BEGIN:VCARD')).toBe(true);
    expect(sent.get('vcf')).toContain('FN:Amal Al Rashid');
    expect(sent.get('vcf')).toContain('TEL;TYPE=CELL:+966500000001');
    expect(sent.get('name')).toBe('Amal Al Rashid');
    expect(await page.evaluate('window.__shared')).toBe(false);          // not the share sheet
    await expect(page.locator('.toast', { hasText: 'saved as a contact' })).toHaveCount(0);
  });
});
