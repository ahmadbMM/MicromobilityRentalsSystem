import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The new fleet (2026-09-28): a bike can be reported missing (out of the pool until it is found,
// with Mark missing / Found beside Maintenance), and a whole fleet comes in from one CSV - every
// row checked and shown before anything is written, the good rows inserted with one Undo.
const bikes = [
  { id: 'bk-1', bike_number: 1, name: 'Hybrid M 001', type: 'Hybrid', size: 'M', status: 'available', colors: ['#03ff89'], frame_type: 'Aluminum' },
  { id: 'bk-2', bike_number: 2, name: 'Road S 002', type: 'Road', size: 'S', status: 'missing', retired_date: '2026-09-20', colors: ['#03ff89'], frame_type: 'Carbon' },
  { id: 'bk-3', bike_number: 3, name: 'Kids XS 003', type: 'Kids', size: 'XS', status: 'in-use', colors: ['#03ff89'], frame_type: 'Aluminum' },
];
const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];

async function boot(page: Page) {
  await stubSupabase(page, { bikes, sessions, queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';renderInventory()`);
  await expect(page.locator('#tab-bikes')).toBeVisible();
}
function watchWrites(page: Page, table: string, method: string) {
  const writes: Array<{ url: string; body: unknown }> = [];
  page.on('request', (r) => {
    if (r.method() === method && r.url().includes(`/rest/v1/${table}`)) { let body: unknown = null; try { body = r.postDataJSON(); } catch { /* not JSON */ } writes.push({ url: r.url(), body }); }
  });
  return writes;
}

test.describe('missing bikes', () => {
  test('a missing bike is out of the pool, labelled, filterable, and flagged for attention', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`({
      out: _bkOut(getBikes().find(b=>b.id==='bk-2')), avail: _bkOut(getBikes().find(b=>b.id==='bk-1')),
      label: _bkStatusLabel(getBikes().find(b=>b.id==='bk-2')),
      ci: _ciBikeStatusText({bike:getBikes().find(b=>b.id==='bk-2')}),
      attn: _bkAttnRows(getBikes()).filter(x=>x.b.id==='bk-2').map(x=>x.flags.map(f=>f[1])),
    })`) as { out: boolean; avail: boolean; label: string; ci: string; attn: string[][] };
    expect(r.out).toBe(true);
    expect(r.avail).toBe(false);
    expect(r.label).toBe('Missing');
    expect(r.ci).toBe('This bike is reported missing.');
    expect(r.attn).toEqual([['Reported missing']]);
    // the filter offers it, and the folded section names it
    await expect(page.locator('#tab-bikes select option[value="missing"]')).toHaveCount(1);
    await expect(page.locator('#tab-bikes')).toContainText('Retired & Maintenance & Missing');
  });

  test('Mark missing and Found write the status and stamp the day, with an undo', async ({ page }) => {
    await boot(page);
    const writes = watchWrites(page, 'bikes', 'PATCH');
    // Missing is in the bike row's ⋯ menu since 2026-10-03 (the registry is what the row offers)
    await expect(page.locator('#tab-bikes .rq-more').first()).toBeVisible(); // the fleet is drawn
    expect(await page.evaluate(`((S._rowMenus||{})['bike:bk-1']||[]).map(i=>i.label)`)).toContain('Missing');
    await page.evaluate(`setMissing('bk-1')`);
    await expect.poll(() => writes.length).toBeGreaterThan(0);
    const w = writes[0].body as Record<string, unknown>;
    expect(w.status).toBe('missing');
    expect(String(w.retired_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await page.evaluate(`S.undoStack.length`)).toBe(1);
    // a bike on a ride cannot go missing from here
    await page.evaluate(`setMissing('bk-3')`);
    expect(writes.length).toBe(1);
    // Found: back in the pool, the day cleared
    await page.evaluate(`setMissing('bk-2')`);
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].body).toEqual({ status: 'available', retired_date: null });
  });
});

test.describe('CSV import', () => {
  test('the parser takes quotes, doubled quotes, CR LF, a BOM and semicolons', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`_csvParse('\\ufeffa;b;c\\r\\n1;"x;y";"say ""hi"""\\r\\n\\r\\n2;;\\n')`);
    expect(r).toEqual([['a', 'b', 'c'], ['1', 'x;y', 'say "hi"'], ['2', '', '']]);
  });

  test('every row is checked: numbers, types, sizes, statuses, dates, and duplicates in the fleet or the file', async ({ page }) => {
    await boot(page);
    const csv = [
      'Bike,Type,Size,Make,Model,Serial,Purchase,Status,Colour',
      '42,Hybrid,M,Alvas,Cross 21S,SN42,2026-10-01,available,#112233',
      '1,Road,S,,,,,,',                    // number already in the fleet
      '43,mtb,,Alvas,Strom,,,maintenance,', // MTB reads as Mountain; no size means M
      '43,Kids,XS,,,,,,',                   // repeated in the file
      '0,Hybrid,L,,,,,,',                   // out of range
      '44,Scooter,M,,,,,,',                 // unknown type
      '45,Road,XXL,,,,2026-13-01,parked,',  // bad size, date and status
    ].join('\n');
    const r = await page.evaluate((c) => {
      // @ts-expect-error app global
      const out = _bkCsvRows(c);
      return { err: out.err, rows: out.rows.map((x: { line: number; errs: string[]; bike: Record<string, unknown> }) => ({ line: x.line, errs: x.errs, n: x.bike.bike_number, type: x.bike.type, size: x.bike.size, status: x.bike.status, name: x.bike.name, colors: x.bike.colors, brand: x.bike.brand, inSvc: x.bike.in_service_date, retired: x.bike.retired_date })) };
    }, csv) as { err: string | null; rows: Array<Record<string, unknown>> };
    expect(r.err).toBeNull();
    expect(r.rows.map((x) => x.errs)).toEqual([[], ['bkImportErrDup'], [], ['bkImportErrDupFile'], ['bkImportErrNum'], ['bkImportErrType'], ['bkImportErrSize', 'bkImportErrStatus', 'bkImportErrDate']]);
    expect(r.rows[0]).toMatchObject({ n: 42, type: 'Hybrid', size: 'M', status: 'available', colors: ['#112233'], brand: 'Alvas', inSvc: '2026-10-01', retired: null });
    expect(r.rows[2]).toMatchObject({ n: 43, type: 'Mountain', size: 'M', status: 'maintenance' });
    expect(String(r.rows[2].retired)).toMatch(/^\d{4}-\d{2}-\d{2}$/); // in for maintenance from the day it arrives
    expect(String(r.rows[0].name)).toContain('042');
    // a file without a heading row for number and type is refused as a whole
    expect(await page.evaluate(`_bkCsvRows('a,b\\n1,2').err`)).toBe('head');
    expect(await page.evaluate(`_bkCsvRows('number,type').err`)).toBe('empty');
  });

  test('the preview says what will go in, the import writes the good rows in one insert, and Undo deletes them', async ({ page }) => {
    await boot(page);
    const posts = watchWrites(page, 'bikes', 'POST'), dels = watchWrites(page, 'bikes', 'DELETE');
    await expect(page.locator('#tab-bikes label', { hasText: 'Import CSV' })).toBeVisible();
    await expect(page.locator('#tab-bikes button', { hasText: 'CSV template' })).toBeVisible();
    await page.evaluate(`_bkCsvPreview('number,type,size\\n42,Hybrid,M\\n43,Road,S\\n1,Road,S\\n')`);
    const m = page.locator('#confirm-modal');
    await expect(m).toContainText('Import bikes');
    await expect(m.locator('#bk-import-sum')).toHaveText('2 ready to import, 1 with problems (skipped).');
    await expect(m.locator('.bk-import-table tbody tr')).toHaveCount(3);
    await expect(m.locator('.bk-import-table tbody tr').nth(2)).toContainText('Number already in the fleet');
    await m.locator('button', { hasText: 'Import 2 bikes' }).click();
    await expect.poll(() => posts.length).toBe(1);
    const rows = posts[0].body as Array<Record<string, unknown>>;
    expect(rows.map((b) => b.bike_number)).toEqual([42, 43]);
    expect(rows[0]).toMatchObject({ type: 'Hybrid', size: 'M', status: 'available', frame_type: 'Aluminum', colors: ['#03ff89'] });
    expect(typeof rows[0].id).toBe('string');
    await expect(page.locator('.toast, #toast, [role="status"]').filter({ hasText: '2 bikes imported' }).first()).toBeAttached(); // quiet: said, not drawn
    await page.evaluate(`doUndo()`);
    await expect.poll(() => dels.length).toBe(1);
    expect(dels[0].url).toContain('id=in.');
  });

  // Tags as the resolver reads them (2026-10-04 review): a UID typed with colons or in lower case
  // was saved as typed and never matched a tap; the same tag on two rows was not caught.
  test('tags are saved as letters and digits in upper case, and a tag twice in the file is refused', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`(()=>{
      const out=_bkCsvRows('number,type,tag\\n42,Hybrid,04:a3:2b:1c\\n43,Road,04 A3 2B 1C\\n44,Road,\\n');
      return {tags:out.rows.map(x=>x.bike.tag_uid),errs:out.rows.map(x=>x.errs),form:_bkPrivVal('tag',' 04:a3-2B 1c ')};
    })()`) as { tags: (string | null)[]; errs: string[][]; form: string };
    expect(r.tags).toEqual(['04A32B1C', '04A32B1C', null]);
    expect(r.errs).toEqual([[], ['bkTagTaken'], []]);
    expect(r.form).toBe('04A32B1C');
  });

  test('a row whose tag is already on a fleet bike stays out, and the rest of the file still goes in', async ({ page }) => {
    await boot(page);
    const posts: unknown[] = [];
    // The plain read cannot see tags, so the clash is the insert's: a chunk holding it is refused whole.
    await page.route(/\/rest\/v1\/bikes/, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const b = route.request().postDataJSON();
      posts.push(b);
      const rows = Array.isArray(b) ? b : [b];
      const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
      if (rows.some((x: Record<string, unknown>) => x.tag_uid === 'TAKEN')) {
        return route.fulfill({ status: 409, headers: head, body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "bikes_tag_uid_uniq"' }) });
      }
      return route.fulfill({ status: 201, headers: head, body: '[]' });
    });
    await page.evaluate(`_bkCsvPreview('number,type,tag\\n42,Hybrid,\\n43,Road,taken\\n44,Road,\\n')`);
    await page.locator('#confirm-modal button', { hasText: 'Import 3 bikes' }).click();
    // one chunk of three (refused), then each row on its own: 42 and 44 go in, 43 stays out
    await expect.poll(() => posts.length).toBe(4);
    expect(posts.slice(1).map((b) => (b as Record<string, unknown>).bike_number)).toEqual([42, 43, 44]);
    await expect(page.locator('.toast, #toast, [role="status"]').filter({ hasText: '2 bikes imported' }).first()).toBeAttached();
  });

  test('a file with nothing importable leaves the Import button disabled', async ({ page }) => {
    await boot(page);
    await page.evaluate(`_bkCsvPreview('number,type\\n1,Road\\n')`);
    await expect(page.locator('#confirm-modal .btn-green')).toBeDisabled();
  });
});
