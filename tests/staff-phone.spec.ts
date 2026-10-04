import { test, expect } from '@playwright/test';
import { stubSupabase, waitForSb, loadStaffHalf } from './helpers/supabase';

// Staff can sign in with email OR phone; _staffPhoneE164 normalizes a raw phone entry
// to E.164 (Saudi default) so it matches the phone stored on the Supabase Auth account.

test('_staffPhoneE164 normalizes Saudi phone formats to E.164', async ({ page }) => {
  await stubSupabase(page);
  await page.goto('/');
  await loadStaffHalf(page); // a staff helper on a customer's page: the staff half is fetched first (2026-10-04)
  const cases: [string, string][] = [
    ['0566668818', '+966566668818'],   // national leading-0
    ['566668818', '+966566668818'],    // bare 9-digit mobile
    ['+966566668818', '+966566668818'],// already E.164
    ['966566668818', '+966566668818'], // country code, no +
    ['00966566668818', '+966566668818'],// international 00 prefix
    ['+966 56 666 8818', '+966566668818'], // spaces stripped
  ];
  for (const [input, expected] of cases) {
    expect(await page.evaluate(`_staffPhoneE164(${JSON.stringify(input)})`)).toBe(expected);
  }
});

test('_staffLoginEmail resolves every phone format (and email) to the account email', async ({ page }) => {
  await stubSupabase(page);
  await page.goto('/');
  await waitForSb(page);
  await loadStaffHalf(page); // the sign-in helpers are the staff half's
  // The hardcoded phone map is gone -- three staff personal mobiles were riding in the public
  // bundle. Resolution now goes through the staff_email_for_phone RPC against the staff_phones
  // TABLE, so what the client owes is: normalize to E.164, ask, and pass the answer through.
  await page.evaluate(`sb.rpc=async(name,args)=>{
    if(name!=='staff_email_for_phone')return {data:null,error:{message:'unexpected '+name}};
    return {data:args.p_phone==='+966562847777'?'salemb@micromobility.sa':null,error:null};
  }`);
  for (const p of ['0562847777', '562847777', '966562847777', '00966562847777', '+966562847777', '+966 56 284 7777']) {
    expect(await page.evaluate(`_staffLoginEmail(${JSON.stringify(p)})`)).toBe('salemb@micromobility.sa');
  }
  // Email passes through (lowercased) without touching the RPC; unknown phone resolves to null.
  expect(await page.evaluate(`_staffLoginEmail('SalemB@Micromobility.SA')`)).toBe('salemb@micromobility.sa');
  expect(await page.evaluate(`_staffLoginEmail('0500000000')`)).toBe(null);
});

test('the personal mobiles are no longer in the shipped page', async ({ page }) => {
  await stubSupabase(page);
  const res = await page.goto('/');
  const html = (await res!.text());
  expect(html).not.toContain('966562847777');   // salem
  expect(html).not.toContain('966565834444');   // ahmad
  // 966566668818 is the PUBLISHED business contact (wa.me links, schema.org) and stays.
});
