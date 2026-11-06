import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Hide on both Applications lists (the owner, 2026-11-06): the card leaves its list for Hidden, keeps its status,
// and Unhide puts it back. The Applications pill carries no count.

const customers = [{ id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', height: 165, created_at: '2026-01-05T10:00:00Z' }];
const base = {
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12', gender: 'male',
  nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null, customer_id: null, existing_account: null,
  account_oauth: null, profession: 'Architect', hidden_at: null as string | null, hidden_by: null as string | null,
};
const apps = [
  { ...base, id: 'a1', status: 'pending', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', instagram: 'karim.rides', linkedin: 'karim-m' },
  { ...base, id: 'a2', status: 'pending', name: 'Hidden Earlier', email: 'hidden.earlier@gmail.com', phone: '+966551110000', instagram: 'h.e', linkedin: 'h-e', hidden_at: '2026-11-05T08:00:00Z', hidden_by: 'Desk A' },
];
const learners = [
  { ...base, id: 'l1', status: 'pending', for_whom: 'self', learner_name: null, learner_gender: 'female', learner_height: 162, level: 'never', notes: '', lesson_at: null, lesson_place: null, name: 'Nadia Omar', email: 'nadia.omar@gmail.com', phone: '+966552220001', learner_age: 34 },
];

async function open(page: Page, sub: 'applications' | 'learning', writes: { url: string; body: Record<string, unknown> }[]) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: apps, learn_applications: learners });
  page.on('request', (r) => { if (r.method() === 'PATCH' && /_applications\?/.test(r.url())) writes.push({ url: decodeURIComponent(r.url()), body: JSON.parse(r.postData() || '{}') }); });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');setCommTab('${sub}')`);
}

test('community: Hide moves the card to Hidden, Unhide brings it back; the Applications pill has no number', async ({ page }) => {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  await open(page, 'applications', writes);
  await expect(page.locator('.ca-row')).toHaveCount(1); // the hidden one is not in Pending
  await expect(page.locator('#tab-community .filter-pill', { hasText: /^Applications$/ })).toHaveCount(1);
  await expect(page.locator('[data-ca-filter="pending"]')).toHaveText('Pending (1)');
  await expect(page.locator('[data-ca-filter="hidden"]')).toHaveText('Hidden (1)');
  await page.locator('.ca-row[data-app-id="a1"] .ap-hide').click();
  await expect(page.locator('.ca-row')).toHaveCount(0);
  await expect(page.locator('[data-ca-filter="hidden"]')).toHaveText('Hidden (2)');
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].url).toContain('community_applications?id=eq.a1');
  expect(writes[0].body.hidden_at).toBeTruthy();
  await page.locator('[data-ca-filter="hidden"]').click();
  await expect(page.locator('.ca-row')).toHaveCount(2);
  await expect(page.locator('.ca-row[data-app-id="a2"] .ca-when')).toContainText('Desk A');
  await expect(page.locator('.ca-row[data-app-id="a2"] .ca-sel')).toHaveCount(0); // not picked for bulk actions
  await page.locator('.ca-row[data-app-id="a1"] .ap-hide').filter({ hasText: 'Unhide' }).click();
  await expect(page.locator('.ca-row')).toHaveCount(1);
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].body).toEqual({ hidden_at: null, hidden_by: null });
  await expect(page.locator('[data-ca-filter="pending"]')).toHaveText('Pending (1)');
});

test('learn to ride: Hide and Unhide the same way', async ({ page }) => {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  await open(page, 'learning', writes);
  await expect(page.locator('.la-row')).toHaveCount(1);
  await page.locator('.la-row[data-learn-id="l1"] .ap-hide').click();
  await expect(page.locator('.la-row')).toHaveCount(0);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].url).toContain('learn_applications?id=eq.l1');
  await page.locator('[data-la-filter="hidden"]').click();
  await expect(page.locator('.la-row[data-learn-id="l1"]')).toHaveCount(1);
  await page.locator('.la-row[data-learn-id="l1"] .ap-hide').click();
  await expect(page.locator('.la-row')).toHaveCount(0);
  await page.locator('[data-la-filter="pending"]').click();
  await expect(page.locator('.la-row[data-learn-id="l1"]')).toHaveCount(1);
});
