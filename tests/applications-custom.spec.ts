import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Applications, made the admins' own (the owner, 2026-10-07: "add more customization in it", and of the choices
// offered: views and bulk actions, message templates, default tags and rules, form questions). Sort and card
// details are this device's; saved views too. Approve / Reject several at once; default tags and rules live in
// staff_options 'community.app_rules'; the form's questions in site_content 'community.form'.

const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false },
  { id: 'tag_sela', slug: 'sela', name: 'Sela staff', color: '#7c3aed', locked: false, auto_grant: false },
];
const base = {
  submissions: 1, height: 178, gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true,
  decided_at: null, decided_by: null, customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect',
  status: 'pending', instagram: '', linkedin: '',
};
const apps = [
  { ...base, id: 'a1', name: 'Zaid Older', email: 'zaid@example.test', phone: '+966552468011', birth_date: '1980-01-01', workplace: 'Sela', created_at: '2026-09-20T08:00:00Z', updated_at: '2026-09-20T08:00:00Z' },
  { ...base, id: 'a2', name: 'Amal Young', email: 'amal@example.test', phone: '+966552468012', birth_date: '2012-05-05', workplace: 'School', created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z' },
  { ...base, id: 'a3', name: 'Badr Middle', email: 'badr@example.test', phone: '+966552468013', birth_date: '1995-05-05', workplace: 'Aramco', created_at: '2026-09-21T08:00:00Z', updated_at: '2026-09-21T08:00:00Z' },
];
const rules = { defaultTags: ['tag_saturday'], rules: [
  { id: 'r1', field: 'age', op: 'lt', value: '16', action: 'reject', tag: '' },
  { id: 'r2', field: 'workplace', op: 'contains', value: 'sela', action: 'tag', tag: 'tag_sela' },
] };

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await stubSupabase(page, {
    sessions: [], queue_entries: [], bikes: [], customers: [], tags, customer_tags: [], community_applications: apps,
    staff_options: [{ key: 'community.app_rules', items: rules }],
    'rpc:staff_community_approve': { ok: true, customer_id: 'cx', existing: true },
    'rpc:staff_community_decide': { ok: true },
    ...extra,
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`localStorage.removeItem('cq_ca_view');localStorage.removeItem('cq_ca_views');S._caV=null;setStaffTab('community');setCommTab('applications')`);
  await expect(page.locator('.ca-row')).toHaveCount(3);
}
const names = (page: Page) => page.locator('.ca-row .ca-name').allInnerTexts();

test('sort and card details are this device\'s; a saved view brings back the list, its search and its order', async ({ page }) => {
  await boot(page);
  expect(await names(page)).toEqual(['Amal Young', 'Badr Middle', 'Zaid Older']); // newest first
  await page.locator('.ca-tb select').selectOption('young');
  expect(await names(page)).toEqual(['Amal Young', 'Badr Middle', 'Zaid Older']);
  await page.locator('.ca-tb select').selectOption('name');
  expect(await names(page)).toEqual(['Amal Young', 'Badr Middle', 'Zaid Older']);
  await page.locator('.ca-tb select').selectOption('old');
  expect(await names(page)).toEqual(['Zaid Older', 'Badr Middle', 'Amal Young']);
  // Card details: the profession off
  await expect(page.locator('.ca-row').first()).toContainText('Architect');
  await page.getByRole('button', { name: 'Card details' }).click();
  await page.locator('.ca-fields .ca-fld', { hasText: 'Profession' }).locator('input').uncheck();
  await expect(page.locator('.ca-row').first()).not.toContainText('Architect');
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_ca_view')).hide`)).toContain('prof');
  // a saved view
  await page.locator('#ca-view-name').fill('Oldest');
  await page.getByRole('button', { name: 'Save view' }).click();
  await page.locator('.ca-tb select').selectOption('new');
  await page.locator('.ca-view .filter-pill', { hasText: 'Oldest' }).click();
  expect(await names(page)).toEqual(['Zaid Older', 'Badr Middle', 'Amal Young']);
  await page.locator('.ca-view-x').click();
  await expect(page.locator('.ca-view')).toHaveCount(0);
});

test('rules mark the cards; Apply rules rejects only the marked; a tag rule ticks its tag on approval', async ({ page }) => {
  await boot(page);
  await expect(page.locator('.ca-row[data-app-id="a2"] .ca-rule-rej')).toContainText('Age under 16 → Reject');
  await expect(page.locator('.ca-row[data-app-id="a1"] .ca-rule-tag')).toContainText('+ Sela staff');
  await expect(page.locator('.ca-row[data-app-id="a3"] .ca-rule')).toHaveCount(0);
  // the approval dialog starts with the default tag and the rule's
  await page.evaluate(`_caApprove('a1')`);
  expect(await page.evaluate('S._caAp.tags')).toEqual(['tag_saturday', 'tag_sela']);
  await page.evaluate(`_caApClose()`);
  const decided: string[] = [];
  page.on('request', (r) => { if (/rpc\/staff_community_decide/.test(r.url())) decided.push((r.postDataJSON() as { p_id: string }).p_id); });
  await page.getByRole('button', { name: 'Apply rules: reject 1' }).click();
  await page.locator('#confirm-modal').getByRole('button', { name: 'Reject' }).click();
  await expect.poll(() => decided).toEqual(['a2']);
  await expect(page.locator('.ca-row')).toHaveCount(2);
});

test('several approved at once, each with its default tags and rules', async ({ page }) => {
  await boot(page);
  const approved: string[] = [];
  page.on('request', (r) => { if (/rpc\/staff_community_approve/.test(r.url())) approved.push((r.postDataJSON() as { p_id: string }).p_id); });
  await page.locator('.ca-row[data-app-id="a1"] .ca-sel input').check();
  await page.locator('.ca-row[data-app-id="a3"] .ca-sel input').check();
  await expect(page.locator('.ca-bulk')).toContainText('2 selected');
  await page.locator('.ca-bulk').getByRole('button', { name: 'Approve (2)' }).click();
  await expect(page.locator('#confirm-modal')).toContainText('Approve 2 applications?');
  await page.locator('#confirm-modal').getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => approved.sort()).toEqual(['a1', 'a3']);
  await expect(page.locator('.ca-row')).toHaveCount(1); // the approved leave the waiting list
  // select all shown, then clear
  await page.locator('.ca-bulk .ca-fld input').check();
  await expect(page.locator('.ca-bulk')).toContainText('1 selected');
  await page.locator('.ca-bulk').getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.ca-bulk')).not.toContainText('selected');
});

test('admins customize: default tags and rules, the messages in every language, the form\'s questions', async ({ page }) => {
  await boot(page, { site_content: [{ key: 'community.form', value: { q: { profession: { on: true, req: false } } } }] });
  const writes: { url: string; body: unknown }[] = [];
  page.on('request', (r) => { if (['POST', 'PATCH'].includes(r.method()) && /staff_options|site_content/.test(r.url())) writes.push({ url: r.url(), body: r.postDataJSON() }); });
  await page.getByRole('button', { name: 'Customize' }).click();
  const set = page.locator('.ap-set');
  await expect(set.locator('.ap-rule')).toHaveCount(2);
  // a new rule
  await set.locator('.ap-rule-new select').first().selectOption('nationality');
  await set.locator('#ca-rd-val').fill('Egypt');
  await set.locator('.ap-rule-new select').nth(2).selectOption('tag');
  await set.locator('.ap-rule-new select').nth(3).selectOption('tag_sela');
  await set.getByRole('button', { name: 'Add rule' }).click();
  await expect.poll(() => writes.filter((w) => /staff_options/.test(w.url)).length).toBe(1);
  const saved = (writes.find((w) => /staff_options/.test(w.url))!.body as { key: string; items: { rules: unknown[] } });
  expect(saved.key).toBe('community.app_rules');
  expect(saved.items.rules).toHaveLength(3);
  // the messages: the applications' templates, in every language
  await set.getByRole('button', { name: 'Messages', exact: true }).click();
  await set.locator('.tpl-row[data-tpl="ca_approved"]').click();
  await expect(page.locator('#confirm-modal [data-tpl-lang]')).toHaveCount(10);
  await page.locator('#confirm-modal [data-tpl-lang="fr"]').click();
  await expect(page.locator('#tpl-text')).toHaveValue(/Bienvenue/);
  await page.evaluate(`_tplEdClose()`);
  // the form's questions
  await set.getByRole('button', { name: 'Form questions' }).click();
  const prof = set.locator('.cf-row[data-cf="profession"]');
  await expect(prof.locator('input').nth(0)).toBeChecked();      // asked
  await expect(prof.locator('input').nth(1)).not.toBeChecked();  // optional, as saved
  await set.locator('.cf-row[data-cf="linkedin"] input').first().uncheck();
  await expect.poll(() => writes.filter((w) => /site_content/.test(w.url)).length).toBe(1);
  const form = writes.find((w) => /site_content/.test(w.url))!.body as { key: string; value: { q: Record<string, { on?: boolean; req?: boolean }> } };
  expect(form.key).toBe('community.form');
  expect(form.value.q.linkedin.on).toBe(false);
  expect(form.value.q.profession.req).toBe(false); // what was there stays
});
