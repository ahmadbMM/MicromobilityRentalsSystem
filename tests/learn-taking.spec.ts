import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type FailWrite } from './helpers/supabase';

// Community > Applications > Learn to ride: "Taking sign-ups" (the owner, 2026-10-04: stop taking
// learn-to-ride applications and have the website say so). The switch is the website's own
// (site_content 'experiences.learn.taking', also in the Website editor): admins turn it off after a
// confirmation and on at once, with undo; the rest of the team sees which way it is. "Offer lessons"
// off is said too. customer_learn_apply refuses a sign-up meanwhile (20261004201500).

const customers = [{ id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', height: 165, created_at: '2026-01-05T10:00:00Z' }];
const learners = [{
  id: 'l1', status: 'pending', name: 'Nadia Omar', email: 'nadia.omar@gmail.com', phone: '+966552220001', created_at: '2026-09-27T08:00:00Z', updated_at: '2026-09-27T08:00:00Z',
  submissions: 1, for_whom: 'self', learner_name: null, learner_age: 34, learner_gender: 'female', learner_height: 162, level: 'never', notes: '', lang: 'en',
  lesson_at: null, lesson_place: null, decided_at: null, decided_by: null, customer_id: null, existing_account: null, account_oauth: null,
}];

async function learnTab(page: Page, siteContent: { key: string; value: unknown }[] = [], role = 'admin', fail?: FailWrite) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: [], learn_applications: learners, site_content: siteContent }, fail);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S.staffRole=${JSON.stringify(role)};setStaffTab('community');setCommTab('learning')`);
  await expect(page.locator('.la-row')).toHaveCount(1);
  await expect(page.locator('.la-taking')).toBeVisible();
}
const writes = (page: Page) => {
  const sent: { key: string; value: unknown }[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/rest\/v1\/site_content/.test(r.url())) sent.push(...[JSON.parse(r.postData() || '{}')].flat()); });
  return sent;
};

test.describe('@staff:community learn to ride: taking sign-ups', () => {
  test('on until switched off: an admin stops sign-ups after confirming, and takes them again at once', async ({ page }) => {
    await learnTab(page);
    const sent = writes(page);
    const sw = page.locator('#la-taking');
    await expect(sw).toBeChecked();
    await expect(sw).toBeEnabled();
    await expect(page.locator('.la-taking')).not.toHaveClass(/\boff\b/);
    await expect(page.locator('.la-taking-hint')).toHaveText('The sign-up form on micromobility.sa/experiences/learn is open.');
    await expect(page.locator('.la-taking-note')).toHaveCount(0);

    // Off asks first; Cancel leaves it on and writes nothing.
    await sw.click();
    await expect(page.locator('#confirm-modal')).toContainText('Stop taking sign-ups?');
    await expect(sw).toBeChecked();
    await page.locator('#confirm-modal').getByRole('button', { name: /cancel/i }).click();
    await expect(sw).toBeChecked();
    expect(sent).toHaveLength(0);

    await sw.click();
    await page.locator('#confirm-modal .btn-red').click();
    await expect(page.locator('.la-taking')).toHaveClass(/\boff\b/);
    await expect(sw).not.toBeChecked();
    await expect(page.locator('.la-taking-hint')).toHaveText('The website says sign-ups are closed for now, and nobody can sign up.');
    expect(sent).toEqual([expect.objectContaining({ key: 'experiences.learn.taking', value: false })]);
    await expect.poll(() => page.evaluate('S.undoStack.map(u=>u.label)')).toContain('Learn to ride: stopped taking sign-ups');

    // On again: no question.
    await sw.click();
    await expect(sw).toBeChecked();
    await expect(page.locator('.la-taking')).not.toHaveClass(/\boff\b/);
    expect(sent[1]).toEqual(expect.objectContaining({ key: 'experiences.learn.taking', value: true }));
    await expect(page.locator('#confirm-modal')).toBeHidden();
  });

  test('reads what the website has, and says when lessons are switched off altogether', async ({ page }) => {
    await learnTab(page, [{ key: 'experiences.learn.taking', value: false }, { key: 'experiences.learn.on', value: false }]);
    await expect(page.locator('#la-taking')).not.toBeChecked();
    await expect(page.locator('.la-taking')).toHaveClass(/\boff\b/);
    await expect(page.locator('.la-taking-note')).toContainText('Lessons are switched off on the website');
  });

  test('the rest of the team sees it but cannot change it', async ({ page }) => {
    await learnTab(page, [{ key: 'experiences.learn.taking', value: false }], 'owner');
    await expect(page.locator('#la-taking')).toBeDisabled();
    await expect(page.locator('#la-taking')).not.toBeChecked();
    await expect(page.locator('.la-taking-hint')).toContainText('Only an admin can change this.');
  });

  test('a refused save says so and keeps what is saved', async ({ page }) => {
    await learnTab(page, [], 'admin', { table: 'site_content' });
    await page.locator('#la-taking').click();
    await page.locator('#confirm-modal .btn-red').click();
    await expect(page.locator('#err-bar-el')).toContainText('did not save'); // the error bar, like every refused write
    await expect(page.locator('#la-taking')).toBeChecked();
    expect(await page.evaluate('S.undoStack.length')).toBe(0);
  });
});
