import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The bell's read state on the account (staff.prefs.ntread, 2026-10-09) and message templates in every
// staff language with English as the fallback.

const sent: Record<string, unknown>[] = [];
const inv = [{ id: 'i1', name: 'Medium helmet', category: 'Helmet', qty: 1, low_threshold: 3, price: 15 }];
async function staff(page: Page, x: Record<string, unknown> = {}, path = '/') {
  sent.length = 0;
  page.on('request', (r) => {
    if (/\/rest\/v1\/rpc\/staff_my_prefs/.test(r.url()) && r.method() === 'POST') sent.push(r.postDataJSON());
  });
  await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], inventory: inv, 'rpc:staff_my_prefs': {}, ...x });
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
}
const gloves = `{id:'i2',name:'Gloves',category:'Gloves',qty:0,low_threshold:2,price:10}`;

test.describe('@staff:bell read state follows the account', () => {
  test('Mark all read goes to the account with the time, and a line opened goes by its id', async ({ page }) => {
    await staff(page);
    await page.waitForFunction('_ntLoaded().inv');
    await page.evaluate(`S._staffAuthed=true;_ntSync();S.inventory=[...S.inventory,${gloves}];_ntSync()`);
    await expect(page.locator('#nt-btn .nt-badge')).toHaveText('1');
    await page.locator('#nt-btn').click();
    await page.locator('#nt-panel').getByRole('button', { name: 'Mark all read' }).click();
    await expect.poll(() => sent.length, { timeout: 5000 }).toBeGreaterThan(0);
    const nr = (sent[sent.length - 1].p_set as Record<string, { b: Record<string, string>; ids: Record<string, string[]> }>).ntread;
    expect(nr.ids.stock).toEqual(expect.arrayContaining(['i1|low', 'i2|out']));
    expect(Date.parse(nr.b.stock)).toBeGreaterThan(Date.now() - 60000);
  });

  test('what another device read is read here too; what is new here stays new', async ({ page }) => {
    await staff(page);
    await page.waitForFunction('_ntLoaded().inv');
    await page.evaluate(`_ntSync();S.inventory=[...S.inventory,${gloves},{id:'i3',name:'Lights',category:'Lights',qty:0,low_threshold:2,price:10}];_ntSync()`);
    await expect(page.locator('#nt-btn .nt-badge')).toHaveText('2');
    // the account's row arrives with the gloves read on another phone
    await page.evaluate(`S._prefSrv={ntread:{b:{},ids:{stock:['i1|low','i2|out']}}};_ntSync()`);
    await expect(page.locator('#nt-btn .nt-badge')).toHaveText('1');
    await page.locator('#nt-btn').click();
    await expect(page.locator('#nt-panel .nt-row')).toHaveText([/Lights is out of stock/]);
  });

  test('a thing read that clears and comes back is news again, with the account in step', async ({ page }) => {
    await staff(page);
    await page.waitForFunction('_ntLoaded().inv');
    await page.evaluate(`S._staffAuthed=true;_ntSync();S.inventory=[${gloves}];_ntSync();_ntMarkRead()`);
    await expect(page.locator('#nt-btn .nt-badge')).toHaveCount(0);
    await page.evaluate(`S.inventory=[];_ntSync();S.inventory=[${gloves}];_ntSync()`);
    await expect(page.locator('#nt-btn .nt-badge')).toHaveText('1');
    expect(await page.evaluate(`_pref('ntread').ids.stock`)).not.toContain('i2|out');
  });
});

test.describe('@staff:settings message templates in every language', () => {
  test('the editor offers all ten languages and keeps each one', async ({ page }) => {
    await staff(page, { site_content: [] }, '/settings');
    await page.waitForFunction(`S._tpl!==undefined`);
    await page.locator('#tab-settings .tpl-row[data-tpl="wa_turn"]').click();
    const langs = page.locator('.tpl-box [data-tpl-lang]');
    await expect(langs).toHaveCount(10);
    await page.locator('.tpl-box [data-tpl-lang="fr"]').click();
    await expect(page.locator('.tpl-box [data-tpl-lang="fr"]')).toHaveAttribute('aria-pressed', 'true');
    await page.fill('#tpl-text', 'C\'est votre tour !');
    await page.locator('#tpl-save').click();
    await expect.poll(() => page.evaluate(`S._tpl&&S._tpl.wa_turn&&S._tpl.wa_turn.fr`)).toBe('C\'est votre tour !');
  });

  test('a language with no text of its own takes the admins\' English, Arabic keeps its built-in', async ({ page }) => {
    await staff(page, { site_content: [{ key: 'msg.templates', value: { wa_turn: { en: 'Your turn now', ur: 'آپ کی باری' } } }] });
    await page.waitForFunction(`S._tpl&&S._tpl.wa_turn`);
    expect(await page.evaluate(`_tplUse('wa_turn','ur',{})`)).toBe('آپ کی باری');
    expect(await page.evaluate(`_tplUse('wa_turn','fr',{})`)).toBe('Your turn now');
    expect(await page.evaluate(`_tplUse('wa_turn','ar',{})`)).toBeNull();
    expect(await page.evaluate(`_tplUse('bd_wish','fr',{})`)).toBeNull();
  });
});
