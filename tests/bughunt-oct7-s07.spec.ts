import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07 (Community > Applications): Back to pending on an application whose account is
// gone, an approval over a lapsed Community grant, and a learn-to-ride Undo the server refuses.

const customers = [
  { id: 'c1', name: 'Rana Example', email: 'rana.example@example.com', phone: '+966550000101', height: 165, created_at: '2026-01-05T10:00:00Z' },
];
const base = {
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 170, birth_date: '1994-03-12',
  gender: 'female', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
  customer_id: null, existing_account: null, account_oauth: null, profession: 'Engineer', instagram: '', linkedin: '',
};
const apps = [
  { ...base, id: 'b1', status: 'pending', name: 'Rana Example', email: 'rana.example@example.com', phone: '+966550000101', customer_id: 'c1' },
  { ...base, id: 'b2', status: 'approved', name: 'Gone Example', email: 'gone.example@example.com', phone: '+966550000102', existing_account: false, decided_at: '2026-09-22T08:00:00Z', decided_by: 'Desk A' },
];
const TAGS = [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false }];
const row = (page: Page, id: string) => page.locator(`.ca-row[data-app-id="${id}"]`);

async function applicationsTab(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: TAGS, customer_tags: [], community_applications: apps, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');S.communityTab='applications';renderCommunity()`);
  await expect(page.locator('.ca-row')).toHaveCount(1);
}

test.describe('@staff:community bug hunt oct 7 (applications)', () => {
  test('Back to pending on an application whose account is gone is a guarded write, not the refusing RPC', async ({ page }) => {
    await applicationsTab(page);
    const rpc: string[] = [], patches: { url: string; body: unknown }[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /rpc\/staff_community_decide/.test(r.url())) rpc.push(r.url());
      if (r.method() === 'PATCH' && /\/rest\/v1\/community_applications\?/.test(r.url())) patches.push({ url: decodeURIComponent(r.url()), body: r.postDataJSON() });
    });
    await page.locator('.filter-pill[data-ca-filter="approved"]').click();
    await row(page, 'b2').locator('.ca-reopen').click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].body).toEqual({ status: 'pending', decided_at: null, decided_by: null });
    for (const part of ['id=eq.b2', 'status=eq.approved', 'customer_id=is.null']) expect(patches[0].url).toContain(part);
    expect(rpc).toHaveLength(0);
    await expect(page.locator('.filter-pill[data-ca-filter="pending"]')).toHaveText('Pending (2)');
    await expect(page.locator('#toast-container')).not.toContainText('already decided');
  });

  test('approving over a lapsed Community grant gives a live one', async ({ page }) => {
    const lapsed = { customer_id: 'c1', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1, expires_at: Date.now() - 864e5, starts_at: null, note: null };
    await applicationsTab(page, {
      customer_tags: [lapsed],
      'rpc:staff_community_approve': { ok: true, existing: true, customer_id: 'c1', name: 'Rana Example', email: 'rana.example@example.com', phone: '+966550000101', password: null, lang: 'en', oauth: false },
    });
    const dels: string[] = [], ins: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (!/\/rest\/v1\/customer_tags(\?|$)/.test(r.url())) return;
      if (r.method() === 'DELETE') dels.push(decodeURIComponent(r.url()));
      if (r.method() === 'POST') { const b = r.postDataJSON(); ins.push(...(Array.isArray(b) ? b : [b])); }
    });
    expect(await page.evaluate(`_hasTagNow('c1','tag_saturday')`)).toBe(false);
    await row(page, 'b1').locator('.ca-approve').click();
    await page.locator('#confirm-modal .ca-ap-go').click();
    await expect(page.locator('#confirm-modal .ca-msg-box')).toBeVisible();
    await expect.poll(() => ins.length).toBe(1);
    expect(dels.some((u) => u.includes('customer_id=eq.c1') && u.includes('tag_id=eq.tag_saturday'))).toBe(true);
    expect(ins[0]).toMatchObject({ customer_id: 'c1', tag_id: 'tag_saturday' });
    expect(ins[0].expires_at ?? null).toBeNull();
    expect(await page.evaluate(`_hasTagNow('c1','tag_saturday')`)).toBe(true);
  });
});

test.describe('@staff:settings bug hunt oct 7 (message templates)', () => {
  test('a failed read of the admins\' texts is asked again, not taken as "none of our own"', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], site_content: [{ key: 'msg.templates', value: { rm_privacy: { en: 'Our own words' } } }] });
    let fail = true;
    await page.route(/\/rest\/v1\/site_content(\?|$)/, (r) => (fail && r.request().method() === 'GET'
      ? r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'XX000', message: 'read failed' }) })
      : r.fallback()));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('_tplLoad()');
    expect(await page.evaluate('S._tpl===undefined')).toBe(true);
    fail = false;
    await page.evaluate(`setStaffTab('queue')`);
    await page.waitForFunction(`S._tpl&&S._tpl.rm_privacy`);
    expect(await page.evaluate(`_tplOver('rm_privacy','en')`)).toBe('Our own words');
  });
});

test.describe('@staff:community bug hunt oct 7 (learn to ride)', () => {
  test('an Undo the server refuses stays undoable instead of reading as done', async ({ page }) => {
    const signup = {
      id: 'l3', status: 'scheduled', created_at: '2026-09-27T08:00:00Z', updated_at: '2026-09-27T08:00:00Z', submissions: 1, for_whom: 'self',
      name: 'Omar Example', email: 'omar.example@example.com', phone: '+966550000103', learner_name: null, learner_age: 41, learner_gender: 'male',
      learner_height: 180, level: 'refresh', notes: '', lang: 'en', lesson_at: '2026-10-04T15:00:00Z', lesson_place: 'JCC',
      decided_at: '2026-09-27T09:00:00Z', decided_by: 'Desk A', customer_id: 'c1', existing_account: true, account_oauth: false,
    };
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: [], learn_applications: [signup], 'rpc:staff_learn_decide': { ok: true } });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
    await page.evaluate(`setStaffTab('community');setCommTab('learning');S._laFilter='scheduled';renderCommunity()`);
    await expect(page.locator('.la-row[data-learn-id="l3"]')).toHaveCount(1);
    await page.locator('.la-row[data-learn-id="l3"] .la-done').click();
    await expect(page.locator('.filter-pill[data-la-filter="done"]')).toHaveText('Done (1)');
    const n0 = await page.evaluate('S.undoStack.length');
    // the sign-up was moved on elsewhere: the reversal is refused
    await page.route(/\/rest\/v1\/rpc\/staff_learn_decide/, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'decided' }) }));
    await page.locator('#topbar-right .undo-btn').click();
    await expect(page.locator('#toast-container')).toContainText('already');
    await expect(page.locator('#toast-container')).toContainText('Undo failed');
    await expect.poll(() => page.evaluate('S.undoStack.length')).toBe(n0);
    expect(await page.evaluate(`(S.actionLog||[]).filter(l=>l.undone).length`)).toBe(0);
  });
});
