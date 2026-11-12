import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Sports in the account report builder (the user, 2026-11-11: "add to the report builder the sports new option the
// number of sports and the number of customers in each sport, add them as options and as visuals too"). The answers
// are Analytics' read of the sport question; the builder offers the Sports and Number of sports columns, the "Sports in
// numbers" tiles, each sport with its accounts by name, three charts, filters and a sort. All Supabase traffic is stubbed.

const tags = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#03ff89', locked: true }];
const cust = (id: string, name: string) => ({ id, name, email: `${id}@example.test`, phone: '05000000' + id.slice(1).padStart(2, '0'), created_at: '2026-06-10T09:00:00Z', height: 170 });
const customers = [cust('c1', 'Huda Saleh'), cust('c2', 'Omar Faris'), cust('c3', 'Lina Haddad'), cust('c4', 'Sami Noor'), cust('c5', 'Rami Aziz')];
const at = new Date().toISOString();
const answers = [
  { id: 'c1', sport_competes: true, sport_federations: ['cycling', 'triathlon'], sport_other: null, sport_answered_at: at },
  { id: 'c2', sport_competes: true, sport_federations: ['cycling', 'other'], sport_other: 'Kite surfing', sport_answered_at: at },
  { id: 'c3', sport_competes: true, sport_federations: ['other'], sport_other: 'kite  SURFING', sport_answered_at: at },
  { id: 'c4', sport_competes: false, sport_federations: null, sport_other: null, sport_answered_at: at },
];

async function staff(page: Page) {
  await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], customers, tags,
    customer_tags: [{ customer_id: 'c1', tag_id: 'tag_saturday', added_at: 1 }], 'rpc:sport_option_list': [] });
  await page.route(/\/rest\/v1\/customers\?.*sport_competes=not\.is\.null/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answers) }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getCustomers().length===5`);
  await page.evaluate(`localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null;setStaffTab('customers');S.communityTab='accounts';renderCustomers()`);
}
// Opens the builder; it reads the answers and draws itself again with them.
async function builder(page: Page) {
  await page.evaluate(`showAccountReportOptions()`);
  await page.waitForFunction(`_acrSpOk()`);
  const dlg = page.locator('#print-opts-modal [role="dialog"]');
  await expect(dlg.locator('select option', { hasText: 'Kite surfing' })).toHaveCount(1);
  return dlg;
}
const ids = (page: Page, f: string) => page.evaluate(`(()=>{S._accOpts=null;Object.assign(_accOpts(),${f});return _accRows().map(r=>r.c.id);})()`);

test.describe('@staff:accounts Sports in the account report builder', () => {
  test('the options: columns, sections, charts, filters and a sort', async ({ page }) => {
    await staff(page);
    const dlg = await builder(page);
    for (const label of ['Sports', 'Number of sports', 'Sports in numbers', 'Customers in each sport, by name'])
      await expect(dlg.locator('button.rpt-row-b', { hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
    for (const label of ['Customers in each sport', 'Sports per athlete', 'Yes, no and not answered'])
      await expect(dlg.locator('button.rpt-row-c', { hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
    // the sports named are offered, by their short name, what was written under Other once
    const sports = await page.evaluate(`_accFilterDefs().find(d=>d[0]==='fSport')[2].map(o=>o[1])`);
    expect(sports).toEqual(['All', 'Cycling', 'Kite surfing', 'Triathlon']);
    expect(await page.evaluate(`_accSortOpts().some(o=>o[0]==='sportN'&&o[1]==='Most sports first')`)).toBe(true);
    // on by default: the tiles and the customers in each sport
    expect(await page.evaluate(`[_accOpts().sections.sports,_accOpts().chartsOn.sports,_accOpts().cols.sports]`)).toEqual([1, 1, 0]);
  });

  test('the charts count the accounts on the list', async ({ page }) => {
    await staff(page);
    await builder(page);
    const bd = (k: string) => page.evaluate(`_accBreakdown('${k}',_accRows(),_accOpts())`);
    expect(await bd('sports')).toEqual([{ label: 'Cycling', value: 2 }, { label: 'Kite surfing', value: 2 }, { label: 'Triathlon', value: 1 }]);
    expect(await bd('sportN')).toEqual([{ label: '1', value: 1 }, { label: '2', value: 2 }]);
    expect(await bd('sportAns')).toEqual([{ label: 'Yes', value: 3 }, { label: 'No', value: 1 }, { label: 'Not answered', value: 1 }]);
  });

  test('the filters, the sort and the columns', async ({ page }) => {
    await staff(page);
    await builder(page);
    expect(await ids(page, `{fSport:'cycling'}`)).toEqual(['c1', 'c2']);
    expect((await ids(page, `{fSport:'o:kite surfing'}`) as string[]).sort()).toEqual(['c2', 'c3']);
    expect(await ids(page, `{fSportAns:'yes'}`)).toEqual(['c1', 'c3', 'c2']); // by name: Huda, Lina, Omar
    expect(await ids(page, `{fSportAns:'no'}`)).toEqual(['c4']);
    expect(await ids(page, `{fSportAns:'unset'}`)).toEqual(['c5']);
    expect(await ids(page, `{fSportN:'2'}`)).toEqual(['c1', 'c2']);
    expect(await ids(page, `{fSportN:'1'}`)).toEqual(['c3']);
    expect(await ids(page, `{fSportN:'3'}`)).toEqual([]);
    expect(await ids(page, `{sort:'sportN'}`)).toEqual(['c1', 'c2', 'c3', 'c5', 'c4']); // 2, 2, 1, then Rami and Sami
    const cells = await page.evaluate(`(()=>{S._accOpts=null;const m={};_accRows().forEach(r=>m[r.c.id]=[r.cells.sports,r.cells.sportN]);return m;})()`);
    expect(cells).toEqual({ c1: ['Cycling, Triathlon', '2'], c2: ['Cycling, Kite surfing', '2'], c3: ['Kite surfing', '1'], c4: ['No', '0'], c5: ['', ''] });
  });

  test('the sheet: the tiles, the chart with its share of athletes, and who is in each sport', async ({ page }) => {
    await staff(page);
    await builder(page);
    const html: string = await page.evaluate(`(()=>{S._accOpts=null;Object.assign(_accOpts().sections,{sportWho:1});return _accReportHtml();})()`);
    const tile = (label: string) => new RegExp(`total-num">${'([^<]*)'}</span><span class="total-lbl">${label}</span>`).exec(html)?.[1];
    expect(tile('Sports in use')).toBe('3');
    expect(tile('Compete in a sport')).toBe('3');
    expect(tile('Answered')).toBe('4');
    expect(tile('Not answered yet')).toBe('1');
    expect(html).toContain('<h2>Customers in each sport</h2>');
    expect(html).toMatch(/Cycling<\/td><td>2<\/td><td>67%<\/td>/); // 2 of the 3 athletes
    expect(html).toContain('Customers in each sport, by name · 3');
    expect(html).toContain('<td>Huda Saleh, Omar Faris</td>');
    // the read not in: the sheet goes without them
    const bare: string = await page.evaluate(`(()=>{const a=S._acrSpA.rows;S._acrSpA.rows=null;try{return _accReportHtml();}finally{S._acrSpA.rows=a;}})()`);
    expect(bare).not.toContain('Sports in use');
    expect(bare).not.toContain('Customers in each sport');
  });

  // the user, 2026-11-12: "an option that has each sport and the names under each sport the same way you do with nationalities"
  test('each sport with its names under it, the way a nationality lists its accounts', async ({ page }) => {
    await staff(page);
    const dlg = await builder(page);
    await expect(dlg.locator('button.rpt-row-b', { hasText: /^Each sport, names under it$/ })).toHaveCount(1);
    expect(await page.evaluate(`_accOpts().sections.sportList`)).toBe(0); // off until picked
    expect(await page.evaluate(`(()=>{S._accOpts=null;return _accReportHtml();})()`)).not.toContain('Each sport, names under it');
    const html: string = await page.evaluate(`(()=>{S._accOpts=null;Object.assign(_accOpts().sections,{sportList:1});return _accReportHtml();})()`);
    expect(html).toContain('<h2>Each sport, names under it · 3</h2>');
    // most first, the names A to Z, each with its phone, under the sport in bold with its count
    expect(html).toContain('<li class="rp-natgrp"><b>Cycling</b> <span class="rp-c888">2</span><ul class="rp-natppl"><li>Huda Saleh <span class="rp-c888">0500000001</span></li><li>Omar Faris <span class="rp-c888">0500000002</span></li></ul></li>');
    expect(html).toContain('<b>Kite surfing</b> <span class="rp-c888">2</span><ul class="rp-natppl"><li>Lina Haddad');
    expect(html.indexOf('<b>Kite surfing</b>')).toBeLessThan(html.indexOf('<b>Triathlon</b>'));
    expect(html).not.toContain('Sami Noor <span'); // answered No: in no sport
    // the file: the sport with its count, then each name and phone on a line under it
    const csv = await page.evaluate(`(async()=>{let out='';const _c=URL.createObjectURL;URL.createObjectURL=()=>'blob:x';
      const _a=document.createElement.bind(document);document.createElement=(tag)=>{const el=_a(tag);if(tag==='a')el.click=()=>{};return el;};
      const _B=window.Blob;window.Blob=function(parts,o){out=parts.join('');return new _B(parts,o);};
      await exportAccountsCsv();window.Blob=_B;document.createElement=_a;URL.createObjectURL=_c;return out;})()`) as string;
    expect(csv.replace(/\r/g, '')).toContain('"Each sport, names under it",3\nCycling,2\n,Huda Saleh,0500000001\n,Omar Faris,0500000002\nKite surfing,2\n,Lina Haddad,0500000003\n');
  });

  test('the CSV carries the sport columns and blocks', async ({ page }) => {
    await staff(page);
    await builder(page);
    await page.evaluate(`(()=>{const o=_accOpts();o.cols.sports=1;o.cols.sportN=1;o.sections.sportWho=1;_accSave();})()`);
    const csv = await page.evaluate(`(async()=>{let out='';const _c=URL.createObjectURL;URL.createObjectURL=()=>'blob:x';
      const _a=document.createElement.bind(document);document.createElement=(tag)=>{const el=_a(tag);if(tag==='a')el.click=()=>{};return el;};
      const _B=window.Blob;window.Blob=function(parts,o){out=parts.join('');return new _B(parts,o);};
      await exportAccountsCsv();window.Blob=_B;document.createElement=_a;URL.createObjectURL=_c;return out;})()`) as string;
    expect(csv).toContain('Huda Saleh');
    expect(csv).toContain('"Cycling, Triathlon",2');
    expect(csv).toContain('Customers in each sport,#,Share');
    expect(csv).toContain('Cycling,2,67%');
    expect(csv).toContain('Sports in use,3');
    expect(csv).toContain('"Huda Saleh, Omar Faris"');
  });

  test('a sport\'s short name, in English and Arabic', async ({ page }) => {
    await staff(page);
    expect(await page.evaluate(`['cycling','football','cyber_drones'].map(_acrSpShort)`)).toEqual(['Cycling', 'Football', 'Cybersecurity, Programming and Drones']);
    expect(await page.evaluate(`(()=>{S.lang='ar';try{return['cycling','football','athletics'].map(_acrSpShort);}finally{S.lang='en';}})()`)).toEqual(['الدراجات', 'كرة القدم', 'ألعاب القوى']);
  });
});
