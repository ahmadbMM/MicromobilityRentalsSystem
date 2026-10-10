import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Nationality is an optional profile field. It is never asked at signup; the customer sets
// it on My Account, staff set it on the account form, and the report lists it.

const sessions = [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];

test('My Account fills nationality in from customer_profile and saves it through the RPC', async ({ page }) => {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', nationality: 'Egypt', gender: 'male' }],
    'rpc:customer_update_profile': true,
  });
  await loginCustomer(page, { id: 'c1' });                       // a session from before the field existed
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-nationality')).toHaveValue('Egypt');   // hydrated, then painted again
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_session')).nationality`)).toBe('Egypt');

  const calls: string[] = [];
  page.on('request', r => { if (/rpc\/customer_update_profile/.test(r.url())) calls.push(r.postData() || ''); });
  await page.selectOption('#acc-nationality', 'Jordan');
  await page.evaluate(`saveAccount()`);
  await expect.poll(() => calls.length).toBe(1);
  expect(JSON.parse(calls[0]).p_nationality).toBe('Jordan');
  expect(await page.evaluate(`S.loggedIn.nationality`)).toBe('Jordan');
});

test('the signup form never asks for nationality', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [] });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`showAuthModal&&showAuthModal('signup')`).catch(() => {});
  expect(await page.evaluate(`document.body.innerHTML.includes('id="sgn-nationality"')`)).toBe(false);
  expect(await page.evaluate(`[...document.querySelectorAll('.auth-field label')].some(l=>/Nationality/.test(l.textContent||''))`)).toBe(false);
});

test('staff set it on the account form and the report lists and filters by it', async ({ page }) => {
  const customers = [
    { id: 'c1', name: 'Amal Member', email: 'amal@example.test', phone: '+966500000001', gender: 'female', nationality: 'Egypt', created_at: '2026-08-20T10:00:00Z' },
    { id: 'c2', name: 'Bader Lapsed', email: 'bader@example.test', phone: '+966500000002', gender: 'male', nationality: null, created_at: '2025-01-05T10:00:00Z' },
  ];
  await stubSupabase(page, { customers, tags: [], customer_tags: [], sessions, queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0');
  await page.evaluate(`localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null;`);

  const cells = await page.evaluate(`_accRows().map(r=>[r.c.id,r.cells.nationality])`) as [string, string][];
  expect(Object.fromEntries(cells)).toEqual({ c1: 'Egypt', c2: '' });
  expect(await page.evaluate(`_accBreakdown('nationality',_accRows(),_accOpts())`)).toEqual([{ label: 'Egypt', value: 1 }, { label: 'Not set', value: 1 }]);
  expect(await page.evaluate(`(()=>{const o=_accOpts();o.fNationality='Egypt';const ids=_accRows().map(r=>r.c.id);o.fNationality='all';return ids;})()`)).toEqual(['c1']);

  const patches: string[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && /customers/.test(r.url())) patches.push(r.postData() || ''); });
  await page.evaluate(`showEditCustomerModal('c2')`);
  await expect(page.locator('#cf-nationality')).toHaveValue('');
  await page.selectOption('#cf-nationality', 'Pakistan');
  await page.evaluate(`saveCustForm()`);
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  expect(JSON.parse(patches[0]).nationality).toBe('Pakistan');
});

test('the list holds every country: Saudi Arabia first, then alphabetical in the rider\'s language with Saudi Arabia again in its place', async ({ page }) => {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', nationality: null, gender: 'male' }],
  });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  const en = await page.evaluate(`[...document.querySelectorAll('#acc-nationality option')].map(o=>[o.value,o.textContent])`) as [string, string][];
  expect(en[0][0]).toBe('');                                  // the placeholder
  expect(en[1]).toEqual(['Saudi Arabia', 'Saudi Arabia']);   // pinned to the top
  const rest = en.slice(2).map(o => o[1]);
  expect(rest.length).toBeGreaterThan(190);                   // every country, not the residence shortlist
  expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, 'en')));
  expect(rest).toContain('Japan');
  expect(rest.filter(l => l === 'Saudi Arabia')).toHaveLength(1);   // and again in its alphabetical place (owner, 2026-10-05)
  expect(en.filter(o => o[0] === 'Saudi Arabia')).toHaveLength(2);

  await page.evaluate(`setLang('ar')`);
  const ar = await page.evaluate(`[...document.querySelectorAll('#acc-nationality option')].map(o=>[o.value,o.textContent])`) as [string, string][];
  expect(ar[1]).toEqual(['Saudi Arabia', 'السعودية']);       // the value never changes, only the label
  const arLabels = ar.slice(2).map(o => o[1]);
  expect(arLabels).toEqual([...arLabels].sort((a, b) => a.localeCompare(b, 'ar')));
  expect(arLabels.filter(l => l === 'السعودية')).toHaveLength(1);
  expect(ar.find(o => o[0] === 'Japan')?.[1]).toBe('اليابان');
});

test('Saudi Arabia\'s two places are one country: the top one shows a saved pick, either one saves the same value, the report counts it once', async ({ page }) => {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', nationality: 'Saudi Arabia', country: 'Saudi Arabia', gender: 'male' }],
    'rpc:customer_update_profile': true,
  });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-nationality')).toHaveValue('Saudi Arabia');
  expect(await page.locator('#acc-nationality').evaluate(el => (el as HTMLSelectElement).selectedIndex)).toBe(1);   // the copy at the top
  expect(await page.locator('#acc-country').evaluate(el => (el as HTMLSelectElement).selectedIndex)).toBe(1);

  // Pick the copy in its alphabetical place: the same value goes to the database.
  const lower = await page.locator('#acc-nationality option[value="Saudi Arabia"]').nth(1).evaluate(o => (o as HTMLOptionElement).index);
  expect(lower).toBeGreaterThan(100);
  await page.locator('#acc-nationality').selectOption({ index: 0 });
  await page.locator('#acc-nationality').selectOption({ index: lower });
  const calls: string[] = [];
  page.on('request', r => { if (/rpc\/customer_update_profile/.test(r.url())) calls.push(r.postData() || ''); });
  await page.evaluate(`saveAccount()`);
  await expect.poll(() => calls.length).toBe(1);
  expect(JSON.parse(calls[0]).p_nationality).toBe('Saudi Arabia');
});

test('staff filters list Saudi Arabia twice and count it once', async ({ page }) => {
  const customers = [
    { id: 'c1', name: 'Amal Member', email: 'amal@example.test', phone: '+966500000001', gender: 'female', nationality: 'Saudi Arabia', country: 'Saudi Arabia', created_at: '2026-08-20T10:00:00Z' },
    { id: 'c2', name: 'Bader Rider', email: 'bader@example.test', phone: '+966500000002', gender: 'male', nationality: 'Saudi Arabia', country: 'Saudi Arabia', created_at: '2026-08-21T10:00:00Z' },
    { id: 'c3', name: 'Carim Rider', email: 'carim@example.test', phone: '+966500000003', gender: 'male', nationality: 'Egypt', country: 'Saudi Arabia', created_at: '2026-08-22T10:00:00Z' },
    { id: 'c4', name: 'Dana Rider', email: 'dana@example.test', phone: '+966500000004', gender: 'female', nationality: 'Yemen', country: 'Yemen', created_at: '2026-08-23T10:00:00Z' },
  ];
  await stubSupabase(page, { customers, tags: [], customer_tags: [], sessions, queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0');
  await page.evaluate(`localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null;`);

  const defs = await page.evaluate(`Object.fromEntries(_accFilterDefs().map(([k,,o])=>[k,o.map(x=>x[0])]))`) as Record<string, string[]>;
  expect(defs.fNationality).toEqual(['all', 'unset', 'Saudi Arabia', 'Egypt', 'Saudi Arabia', 'Yemen']); // 'unset': Not set, accounts with no nationality (2026-10-07)
  expect(defs.fCountry).toEqual(['all', 'Saudi Arabia', 'Saudi Arabia', 'Yemen']);
  expect(await page.evaluate(`_accBreakdown('nationality',_accRows(),_accOpts())`)).toEqual([{ label: 'Saudi Arabia', value: 2 }, { label: 'Egypt', value: 1 }, { label: 'Yemen', value: 1 }]);
  expect(await page.evaluate(`(()=>{const o=_accOpts();o.fNationality='Saudi Arabia';const ids=_accRows().map(r=>r.c.id).sort();o.fNationality='all';return ids;})()`)).toEqual(['c1', 'c2']);

  // The report builder shows the pick on the top copy.
  await page.evaluate(`(()=>{const o=_accOpts();o.fNationality='Saudi Arabia';showAccountReportOptions();})()`);
  const picked = await page.evaluate(`[...document.querySelectorAll('#print-opts-modal select')].map(s=>[...s.options].filter(o=>o.value==='Saudi Arabia').map(o=>o.selected)).filter(a=>a.length===2)`) as boolean[][];
  expect(picked).toContainEqual([true, false]);
  await page.evaluate(`_closePrintOpts();(()=>{const o=_accOpts();o.fNationality='all';})()`);

  // The Accounts list filter: two copies, the top one selected.
  await page.evaluate(`S.amNat='Saudi Arabia';setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  const amSel = page.locator('select[aria-label="Nationality"]').filter({ has: page.locator('option[value="Egypt"]') });
  await expect(amSel).toHaveCount(1);
  expect(await amSel.evaluate(el => [...(el as HTMLSelectElement).options].map(o => [o.value, o.selected]))).toEqual(
    [['', false], ['unset', false], ['Saudi Arabia', true], ['Egypt', false], ['Saudi Arabia', false], ['Yemen', false]]); // 'unset': Not set (2026-10-10)
});

test('phone-code pickers show +966 first and again between +964 and +967, one code for both', async ({ page }) => {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '+966500000001', nationality: null, gender: 'male' }],
    'rpc:customer_update_profile': true,
  });
  await loginCustomer(page, { id: 'c1', phone: '+966500000001' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  const cc = page.locator('#acc-cc');
  await expect(cc).toHaveValue('+966');
  const opts = await cc.evaluate(el => [...(el as HTMLSelectElement).options].map(o => [o.value, o.selected]));
  const at = opts.flatMap(([v], i) => (v === '+966' ? [i] : []));
  expect(at).toHaveLength(2);
  expect(at[0]).toBe(0);
  expect(opts.slice(at[1] - 1, at[1] + 2).map(o => o[0])).toEqual(['+964', '+966', '+967']);
  expect(opts.filter(o => o[1])).toEqual([['+966', true]]);   // the top copy shows the saved code
  // Every phone picker draws the same list.
  expect(await page.evaluate(`(()=>{const d=document.createElement('select');d.innerHTML=_ccOpts('+971');return [d.options.length,[...d.options].filter(o=>o.value==='+966').length,d.value];})()`)).toEqual([opts.length, 2, '+971']);
  expect(await page.evaluate(`COUNTRY_CODES.filter(c=>c[0]==='+966').length`)).toBe(1);   // lookups keep one row per code

  // The lower copy saves the same number.
  await cc.selectOption({ index: at[1] });
  await expect(cc).toHaveValue('+966');
  const calls: string[] = [];
  page.on('request', r => { if (/rpc\/customer_update_profile/.test(r.url())) calls.push(r.postData() || ''); });
  await page.evaluate(`saveAccount()`);
  await expect.poll(() => calls.length).toBe(1);
  expect(JSON.parse(calls[0]).p_phone).toBe('+966500000001');
});
