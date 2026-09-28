import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// micromobility.sa is controlled from the staff page (owner, 2026-09-24). The Website section
// reads site_content, edits the Coming Soon screen's words in English and Arabic, shows the
// Coming Soon switch (it opens the site, after a confirmation), switches the built pages on and off,
// and keeps a history where any change can be put back. Admin only.

const sessions = [{ id: '2099-05-05', day: 'Tuesday', session_date: '2099-05-05', capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}' }];

type Write = { method: string; url: string; body: unknown; prefer: string };
async function open(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], site_content: [], site_content_history: [], ...extra });
  await unlockStaff(page);
  const writes: Write[] = [];
  page.on('request', r => {
    if (/\/rest\/v1\/site_content(\?|$)/.test(r.url()) && r.method() !== 'GET' && r.method() !== 'OPTIONS') {
      let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
      writes.push({ method: r.method(), url: decodeURIComponent(r.url()), body, prefer: r.headers()['prefer'] || '' });
    }
  });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('website')`);
  return writes;
}
const panel = (page: Page) => page.locator('#tab-website');

test('admins find it in the menu; Front Desk does not', async ({ page }) => {
  await open(page);
  const item = page.locator('#staff-tab-nav .tab-btn[data-stab="website"]');
  await expect(item).toHaveText('micromobility.sa');
  await expect(item).toHaveClass(/active/);
  await page.evaluate(`S.staffRole='frontdesk';renderStaffTabs();setStaffTab('website')`);
  await expect(item).toBeHidden();
  expect(await page.evaluate('S.staffTab')).toBe('queue');
});

test('before the database update it says so, instead of failing', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await page.route(/\/rest\/v1\/site_content(\?|$)/, r => r.fulfill({
    status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.site_content' in the schema cache" }),
  }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('website')`);
  await expect(panel(page)).toContainText("isn't set up yet");
});

test('Coming Soon is on; the switch opens the website only once confirmed', async ({ page }) => {
  // Home is built (2026-09-25), so the switch is the one thing that opens the site.
  const writes = await open(page, { site_content: [{ key: 'site.coming_soon', value: true, updated_at: '2026-09-24T10:00:00Z', updated_by: 'migration' }] });
  await expect(panel(page)).toContainText('Coming Soon is on');
  const sw = page.locator('#web-cs-switch');
  await expect(sw).toBeChecked();
  await expect(sw).toBeEnabled();
  await expect(panel(page)).not.toContainText('once the Home page is built');
  await expect(panel(page).locator('.web-table').first()).toContainText('Not built yet'); // the Store
  await sw.click();
  await expect(page.locator('#confirm-modal')).toContainText('Open the website?');
  expect(writes.length).toBe(0); // nothing until it is confirmed
  await page.locator('#confirm-modal').getByRole('button', { name: 'Open the website' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual([{ key: 'site.coming_soon', value: false, updated_by: 'Spec Staff' }]);
});

test('the Coming Soon words show what is saved, else the original wording', async ({ page }) => {
  await open(page, { site_content: [{ key: 'coming_soon.title', value: { en: 'Almost there.', ar: 'اقتربنا.' } }] });
  await expect(page.locator('input[data-web-key="coming_soon.title"][data-web-lang="en"]')).toHaveValue('Almost there.');
  await expect(page.locator('input[data-web-key="coming_soon.title"][data-web-lang="ar"]')).toHaveValue('اقتربنا.');
  await expect(page.locator('input[data-web-key="coming_soon.sub"][data-web-lang="en"]')).toHaveValue('Our new website is on its way.');
  await expect(page.locator('input[data-web-key="coming_soon.sub"][data-web-lang="ar"]')).toHaveValue('موقعنا الجديد قيد التجهيز.');
});

test('an edit is saved as one upsert, signed with the operator, and can be undone', async ({ page }) => {
  const writes = await open(page);
  await expect(page.locator('#web-save')).toBeDisabled();
  await page.locator('input[data-web-key="coming_soon.sub"][data-web-lang="en"]').fill('Launching this autumn.');
  await expect(page.locator('#web-save')).toBeEnabled();
  await page.locator('#web-save').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].method).toBe('POST');
  expect(writes[0].prefer).toContain('merge-duplicates');
  expect(writes[0].body).toEqual([{ key: 'coming_soon.sub', value: { en: 'Launching this autumn.', ar: 'موقعنا الجديد قيد التجهيز.' }, updated_by: 'Spec Staff' }]);
  await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', /Website: changed/); // the topbar's Undo names it
  // Undo: the key did not exist before, so it is removed and the site shows the original words.
  await page.evaluate(`doUndo()`);
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].method).toBe('DELETE');
  expect(writes[1].url).toContain('key=in.(coming_soon.sub)');
});

test('an empty text is refused, in either language', async ({ page }) => {
  const writes = await open(page);
  await page.locator('input[data-web-key="coming_soon.title"][data-web-lang="ar"]').fill('   ');
  await page.locator('#web-save').click();
  await expect(page.locator('.toast').last()).toContainText("can't be empty");
  expect(writes).toHaveLength(0);
});

test('Discard puts the fields back without saving', async ({ page }) => {
  const writes = await open(page);
  const f = page.locator('input[data-web-key="coming_soon.title"][data-web-lang="en"]');
  await f.fill('Nope');
  await page.locator('#web-discard').click();
  await expect(f).toHaveValue('Coming soon.');
  await expect(page.locator('#web-save')).toBeDisabled();
  expect(writes).toHaveLength(0);
});

test('a change in the history can be put back', async ({ page }) => {
  const writes = await open(page, {
    site_content: [{ key: 'coming_soon.title', value: { en: 'Soon!', ar: 'قريباً!' } }],
    site_content_history: [
      { id: 7, key: 'coming_soon.title', old_value: { en: 'Coming soon.', ar: 'قريباً.' }, new_value: { en: 'Soon!', ar: 'قريباً!' }, changed_at: '2026-09-24T11:00:00Z', changed_by: 'Malik' },
    ],
  });
  const row = panel(page).locator('.web-table tr', { hasText: 'Malik' });
  await expect(row).toContainText('Soon!');
  await expect(row).toContainText('Coming soon.');
  await row.getByRole('button', { name: 'Put back' }).click();
  await page.locator('#confirm-modal').getByRole('button', { name: 'Put back' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual([{ key: 'coming_soon.title', value: { en: 'Coming soon.', ar: 'قريباً.' }, updated_by: 'Spec Staff' }]);
});

test('a failed save says so and keeps what was typed', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], site_content: [], site_content_history: [] }, { table: 'site_content', status: 403, once: true });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('website')`);
  const f = page.locator('input[data-web-key="coming_soon.eyebrow"][data-web-lang="en"]');
  await f.fill('Micromobility KSA');
  await page.locator('#web-save').click();
  await expect(page.locator('.toast').last()).toContainText('Could not save');
  await expect(f).toHaveValue('Micromobility KSA');
  await expect(page.locator('#web-save')).toBeEnabled();
});

test('a built page is switched on from the Pages list at once, with undo', async ({ page }) => {
  const writes = await open(page);
  const pages = panel(page).locator('.web-pages');
  const row = pages.locator('tr', { hasText: 'Experiences' });
  await expect(row).toContainText('Hidden');
  const sw = row.locator('input.web-toggle');
  await expect(sw).toBeEnabled();
  await expect(sw).not.toBeChecked();
  // Home opens with the Coming Soon switch, and a page that is not built cannot be switched on.
  await expect(pages.locator('tr', { hasText: 'Home' }).locator('input.web-toggle')).toBeDisabled();
  await expect(pages.locator('tr', { hasText: 'Store' }).locator('input.web-toggle')).toBeDisabled();
  await sw.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual([{ key: 'page.experiences.visible', value: true, updated_by: 'Spec Staff' }]);
  await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', /Page switched on: Experiences/);
  // Undo: the key did not exist before, so it is removed and the page is off again.
  await page.evaluate(`doUndo()`);
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].method).toBe('DELETE');
  expect(writes[1].url).toContain('key=in.(page.experiences.visible)');
});

test('a page that is on waits for Coming Soon, then is live; off writes false', async ({ page }) => {
  const writes = await open(page, { site_content: [{ key: 'page.club.visible', value: true }] });
  const club = panel(page).locator('.web-pages tr', { hasText: 'Club' });
  await expect(club).toContainText('On - opens with the site');
  await expect(club.locator('input.web-toggle')).toBeChecked();
  await club.locator('input.web-toggle').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual([{ key: 'page.club.visible', value: false, updated_by: 'Spec Staff' }]);
  await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', /Page switched off: Club/);
});

test('with the site open, a page that is on is Live', async ({ page }) => {
  await open(page, { site_content: [{ key: 'site.coming_soon', value: false }, { key: 'page.help.visible', value: true }] });
  await expect(panel(page).locator('.web-pages tr', { hasText: 'Help' })).toContainText('Live');
  await expect(panel(page).locator('.web-pages tr', { hasText: 'Workshop' })).toContainText('Hidden');
});

test('each built page opens in preview on its own', async ({ page }) => {
  await open(page);
  await page.evaluate(`sb.auth.getSession=async()=>({data:{session:{access_token:'tok.en'}}});window.__opened=[];window.open=u=>{window.__opened.push(u);return null;}`);
  await panel(page).getByRole('button', { name: 'Preview · Workshop' }).click();
  await expect.poll(() => page.evaluate('window.__opened.length')).toBe(1);
  expect(await page.evaluate('window.__opened[0]')).toBe('https://micromobility.sa/en/preview#t=tok.en&to=%2Fworkshop');
  // a page that is not built has nothing to preview
  await expect(panel(page).locator('.web-pages tr', { hasText: 'Store' }).getByRole('button')).toHaveCount(0);
});

test('in Arabic the section reads right to left', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('cq_lang', 'ar'); localStorage.setItem('cq_lang_pick', '1'); } catch { /* */ } });
  await open(page);
  await expect(panel(page)).toContainText('شاشة «قريباً»');
  await expect(page.locator('#staff-tab-nav .snav-group[data-group="snavWebsite"]')).toHaveText('الموقع');
});
