import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Accounts whose details look wrong are listed under "Looks off" with the reason, for staff
// to check and, if they agree, flag. The checks run over the list in hand, so a later account
// is checked as soon as it arrives. "Looks fine" is remembered for exactly those details.

const base = { created_at: '2026-01-05T10:00:00Z', gender: 'female' };
const customers = [
  { ...base, id: 'ok', name: 'Clean Rider', email: 'clean@gmail.com', phone: '+966551876215', height: 170, birth_date: '1994-03-14' },
  { ...base, id: 'typo', name: 'Typo Email', email: 'rider@gmail.con', phone: '+966551876210' },
  { ...base, id: 'short', name: 'Short Phone', email: 'short@hotmail.com', phone: '+96655187620' },
  { ...base, id: 'dob', name: 'Future Birth', email: 'dob@icloud.com', phone: '+966551876211', birth_date: '2099-01-01' },
  { ...base, id: 'tall', name: 'Very Short', email: 'h@outlook.com', phone: '+966551876212', height: 120 },
  { ...base, id: 'emoji', name: 'Sara 🩵', email: 'sara@yahoo.com', phone: '+966551876213' },
  { ...base, id: 'fam1', name: 'Parent One', email: 'p1@gmail.com', phone: '+966551234987' },
  { ...base, id: 'fam2', name: 'Kid Two', email: 'p2@gmail.com', phone: '+966551234987' },
  { ...base, id: 'uk', name: 'Uk Visitor', email: 'uk@gmail.com', phone: '+4479123456' },
  { ...base, id: 'asked', name: 'Already Asked', email: 'asked@gamil.com', phone: '+966551876214', fix_fields: ['email'] },
  // added 2026-09-23: a hand on the keyboard, a pasted sentence, and one inbox under two spellings
  { ...base, id: 'smash', name: 'Kjhgfd Mnbvcx', email: 'smash@gmail.com', phone: '+966551876221' },
  { ...base, id: 'long', name: 'One Two Three Four Five Six Seven', email: 'long@gmail.com', phone: '+966551876222' },
  { ...base, id: 'inbox1', name: 'Same Inbox', email: 'a.b+ride@gmail.com', phone: '+966551876223' },
  { ...base, id: 'inbox2', name: 'Other Inbox', email: 'ab@gmail.com', phone: '+966551876224' },
];

async function accounts(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [], ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  await page.waitForFunction('!!_phoneRules');                     // the libphonenumber rules arrived
  await page.evaluate(`_amFilter('amSuspect',true)`);
}
const line = (page: Page, id: string) => page.locator(`.am-row[data-cust="${id}"] .am-sx`);

test('each kind of wrong detail is listed with its reason; a clean account is not', async ({ page }) => {
  await accounts(page);
  await expect(line(page, 'typo')).toContainText('email ends in gmail.con, probably gmail.com');
  await expect(line(page, 'short')).toContainText('Saudi number too short');
  await expect(line(page, 'dob')).toContainText('birth date is in the future');
  await expect(line(page, 'tall')).toContainText('height 120 cm is unusual');
  await expect(line(page, 'emoji')).toContainText('name has numbers, symbols or emoji');
  await expect(line(page, 'fam1')).toContainText('same phone as Kid Two');
  await expect(line(page, 'uk')).toContainText('not a valid mobile number for +44');
  await expect(line(page, 'smash')).toContainText('a word in the name has no vowels');
  await expect(line(page, 'long')).toContainText('name is unusually long');
  await expect(line(page, 'inbox1')).toContainText('same email as Other Inbox');   // dots and +tags are one inbox
  await expect(line(page, 'inbox2')).toContainText('same email as Same Inbox');
  await expect(page.locator('.am-row[data-cust="ok"]')).toHaveCount(0);
  // A field staff already asked the rider to correct is in hand, not "looks off".
  await expect(page.locator('.am-row[data-cust="asked"]')).toHaveCount(0);
  await expect(page.locator('.am-pick', { hasText: 'Looks off' })).toHaveText('Looks off (12)');
});

test('an account that arrives later is checked the moment it lands', async ({ page }) => {
  await accounts(page);
  await page.evaluate(`S.customers=[...S.customers,{id:'new',name:'New Rider',email:'new@hotmial.com',phone:'+966551876299',created_at:'2026-09-21T12:00:00Z'}];renderCommunity()`);
  await expect(line(page, 'new')).toContainText('email ends in hotmial.com, probably hotmail.com');
  await expect(page.locator('.am-row').first()).toHaveAttribute('data-cust', 'new'); // newest first
});

// Production had no accounts_look_fine row until the first "Looks fine", and a fresh [] in its
// place missed the cache on every call: each account re-checked every account, and the
// Accounts tab froze for tens of seconds at 2,700 accounts.
test('with no "Looks fine" saved yet, the checks still run once per list, not once per account', async ({ page }) => {
  await accounts(page);
  expect(await page.evaluate(`S.staffOptions&&S.staffOptions.accounts_look_fine`)).toBeFalsy();
  expect(await page.evaluate(`_sxIndex()===_sxIndex()`)).toBe(true);
  expect(await page.evaluate(`(()=>{const a=_sxIndex();S.customers.forEach(c=>_sxOf(c));renderCommunity();return a===_sxIndex();})()`)).toBe(true);
});

test('"Looks fine" is shared through staff_options and does not reload the customer list', async ({ page }) => {
  await accounts(page);
  const writes: { url: string; body: unknown }[] = [];
  let customerReads = 0;
  page.on('request', r => {
    if (/rest\/v1\/staff_options/.test(r.url()) && r.method() === 'POST') writes.push({ url: r.url(), body: r.postDataJSON() });
    if (/rest\/v1\/customers/.test(r.url()) && r.method() === 'GET') customerReads++;
  });
  await line(page, 'typo').locator('.am-fine').click();
  await expect(page.locator('.am-row[data-cust="typo"]')).toHaveCount(0);
  expect(writes).toHaveLength(1);
  const row = (Array.isArray(writes[0].body) ? writes[0].body[0] : writes[0].body) as { key: string; items: string[] };
  expect(row.key).toBe('accounts_look_fine');
  expect(row.items).toHaveLength(1);
  expect(row.items[0]).toMatch(/^typo\|[0-9a-z]+$/);
  expect(await page.evaluate('_refDirty')).toBe(false);            // no full reference reload queued
  expect(customerReads).toBe(0);
  // The decision holds for those details only: change the email and the account is back.
  await page.evaluate(`S.customers=S.customers.map(c=>c.id==='typo'?{...c,email:'rider@gmial.com'}:c);renderCommunity()`);
  await expect(line(page, 'typo')).toContainText('gmial.com');
});

test('the flag dialog says why a field looks off, and ticks nothing by itself', async ({ page }) => {
  await accounts(page);
  await page.evaluate(`showFlagFieldsModal('typo')`);
  const row = page.locator('#confirm-modal .fl-row[data-flag="email"]');
  await expect(row.locator('.fl-sx')).toHaveText('email ends in gmail.con, probably gmail.com');
  await expect(row).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#confirm-modal .fl-row[data-flag="name"] .fl-sx')).toHaveCount(0);
});

test('the checks themselves: providers, endings, Saudi shapes, dates and heights', async ({ page }) => {
  await accounts(page);
  const r = await page.evaluate(`(()=>{
    const run=c=>{const o=[];_sxName(c.name,o);_sxEmail(c.email,o);_sxPhone(c,o,'');_sxBody(c,o);return o.map(x=>x.k);};
    return {
      realNear: run({name:'Sara Khalid',email:'a@mail.com',phone:'+966551876215'}),
      regional: run({name:'Sara Khalid',email:'a@hotmail.co.uk',phone:'+966551876215'}),
      gmailCo: run({name:'Sara Khalid',email:'a@gmail.co',phone:'+966551876215'}),
      badTld: run({name:'Sara Khalid',email:'a@jsjs.xs',phone:'+966551876215'}),
      relay: run({name:'Sara Khalid',email:'x@privaterelay.appleid.com',phone:'+966551876215'}),
      twice: run({name:'Sara Khalid',email:'a@b.com',phone:'+966966501234'}),
      zero: run({name:'Sara Khalid',email:'a@b.com',phone:'+9660551876215'}),
      landline: run({name:'Sara Khalid',email:'a@b.com',phone:'+966126543210'}),
      kg: run({name:'Sara Khalid',email:'a@b.com',phone:'+996551876215'}),
      noCode: run({name:'Sara Khalid',email:'a@b.com',phone:'+2895518762'}),
      fake: run({name:'Sara Khalid',email:'a@b.com',phone:'+966500000000'}),
      initial: run({name:'Ahmed A',email:'a@b.com',phone:'+966551876215'}),
      middle: run({name:'Ahmed M Alharbi',email:'a@b.com',phone:'+966551876215'}),
      twoLetters: run({name:'Mo Alharbi',email:'a@b.com',phone:'+966551876215'}),
      title: run({name:'Dr Ahmed Saleh',email:'a@b.com',phone:'+966551876215'}),
      particles: run({name:'Mohammed Al Ghamdi',email:'a@b.com',phone:'+966551876215'}),
      particlesMore: run({name:'Habib ur Rehman',email:'a@b.com',phone:'+966551876215'}),
      arabicParticles: run({name:'فهد بن عبدالله آل سعود',email:'a@b.com',phone:'+966551876215'}),
      mixed: run({name:'Ahmed أحمد',email:'a@b.com',phone:'+966551876215'}),
      diacritics: run({name:'مُحَمَّد العتيبي',email:'a@b.com',phone:'+966551876215'}),
      kid: run({name:'Sara Khalid',email:'a@b.com',phone:'+966551876215',birth_date:'2016-05-05',height:135}),
      tallKid: run({name:'Sara Khalid',email:'a@b.com',phone:'+966551876215',birth_date:'2019-05-05',height:185}),
      afterSignup: run({name:'Sara Khalid',email:'a@b.com',phone:'+966551876215',birth_date:'2026-08-15',created_at:'2026-08-15T09:00:00Z'}),
    };})()`);
  expect(r).toEqual({
    realNear: [], regional: [], gmailCo: ['sxEmailTypo'], badTld: ['sxEmailTld'], relay: [],
    twice: ['sxPhoneSaTwice'], zero: ['sxPhoneSaZero'], landline: ['sxPhoneSaNotMobile'], kg: ['sxPhoneKg'],
    noCode: ['sxPhoneCode'], fake: ['sxPhoneFake'], initial: ['sxNameInitial'], middle: ['sxNameInitial'], mixed: ['sxNameMixed'],
    twoLetters: ['sxNameInitial'], title: ['sxNameInitial'], particles: [], particlesMore: [], arabicParticles: [],
    diacritics: [], kid: [], tallKid: ['sxHeightAge'], afterSignup: ['sxDobYoung'],
  });
});

// Valid names and numbers the checks used to call wrong (review of 2026-09-22).
test('names in scripts with vowel signs, names written without spaces and Kyrgyz riders are not "off"', async ({ page }) => {
  await accounts(page);
  const r = await page.evaluate(`(()=>{
    const run=c=>{const o=[];_sxName(c.name,o);_sxPhone(c,o,'');return o.map(x=>x.k);};
    return {
      bengali: run({name:'মোহাম্মদ রহিম',phone:'+966551876215'}),
      hindi: run({name:'राम कुमार',phone:'+966551876215'}),
      nepali: run({name:'सुनिल थापा',phone:'+966551876215'}),
      chinese: run({name:'王伟',phone:'+966551876215'}),
      korean: run({name:'김민준',phone:'+966551876215'}),
      kgNational: run({name:'Aibek Asanov',phone:'+996551876215',nationality:'Kyrgyzstan'}),
      kgResident: run({name:'Aibek Asanov',phone:'+996551876215',country:'Kyrgyzstan'}),
      stillInitial: run({name:'Ahmed A',phone:'+966551876215'}),
      stillOneWord: run({name:'Sara',phone:'+966551876215'}),
    };})()`);
  expect(r).toEqual({
    bengali: [], hindi: [], nepali: [], chinese: [], korean: [], kgNational: [], kgResident: [],
    stillInitial: ['sxNameInitial'], stillOneWord: ['sxNameOneWord'],
  });
});

// Short forms written into names (user, 2026-09-25): "Md." and "Mohd." are a way of writing
// Muhammad, not initials. Titles and initials written with periods still show.
test('short forms such as Md., Mohd. and Jr. are not initials; Dr., A. and J.R. still are', async ({ page }) => {
  await accounts(page);
  const r = await page.evaluate(`(()=>{
    const run=c=>{const o=[];_sxName(c.name,o);return o.map(x=>x.k);};
    return {
      mdDot: run({name:'Md. Abdul Karim'}), md: run({name:'Md Abdul Karim'}), mohdDot: run({name:'Mohd. Ali Khan'}),
      jr: run({name:'Sara Khan Jr.'}), mdJoined: run({name:'Md.Rahman Khan'}),
      initialDot: run({name:'Ahmed A.'}), dotted: run({name:'J.R. Smith'}), titleDot: run({name:'Dr. Ahmed Saleh'}), mdDotted: run({name:'M.D. Rahman'}),
    };})()`);
  expect(r).toEqual({
    mdDot: [], md: [], mohdDot: [], jr: [], mdJoined: [],
    initialDot: ['sxNameInitial'], dotted: ['sxNameInitial'], titleDot: ['sxNameInitial'], mdDotted: ['sxNameInitial'],
  });
});

test('a phone-rules file that cannot be loaded is not asked for again on every redraw', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [] });
  let asked = 0;
  await page.route(/assets\/phone-rules\.json/, (r) => { asked++; return r.fulfill({ status: 404, body: 'Not found' }); });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  await expect.poll(() => asked).toBe(1);
  await page.waitForFunction('!_phoneRulesReq');
  await page.evaluate(`renderCommunity();renderCommunity();_amFilter('amSuspect',true)`);
  await page.waitForTimeout(300);
  expect(asked).toBe(1);
  await expect(page.locator('.am-row[data-cust="short"] .am-sx')).toContainText('Saudi number too short'); // the Saudi rules still run
});
