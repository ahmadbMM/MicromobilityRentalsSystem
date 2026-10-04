import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Claude Design #11. New session repeats on the weekdays staff pick (Sun + Tue, say) for the
// chosen number of weeks, with a line that says what will be made; and a set-up session can be
// saved as a named template, shared by every device, that fills the form again in one tap.

async function openForm(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessMode='total';S.newSessTotal=40;renderSessions()`);
  await expect(page.locator('#sess-add-form')).toBeVisible();
}
function sessionInserts(page: Page) {
  const rows: { id: string; day: string; session_date: string }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/rest\/v1\/sessions(\?|$)/.test(r.url())) {
      try { const b = r.postDataJSON(); rows.push(...(Array.isArray(b) ? b : [b])); } catch { /* not JSON */ }
    }
  });
  return rows;
}
const day = (page: Page, name: string) => page.locator('#sess-add-form .ns-day', { hasText: name });

test('picked weekdays make a session on each, from the start date on, for the chosen weeks', async ({ page }) => {
  await openForm(page);
  const rows = sessionInserts(page);
  await page.locator('#ns-date').fill('2099-01-01'); // a Thursday
  await day(page, 'Sun').click();
  await day(page, 'Tue').click();
  await expect(day(page, 'Sun')).toHaveAttribute('aria-pressed', 'true');
  // with days picked, one "week" is what the first choice means
  await expect(page.locator('#ns-repeat option').first()).toHaveText('1 week');
  await page.locator('#ns-repeat').selectOption('2');
  await expect(page.locator('#ns-fill')).toContainText('4 sessions');
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect.poll(() => rows.map((r) => r.id)).toEqual(['2099-01-04', '2099-01-06', '2099-01-11', '2099-01-13']);
  expect(rows.map((r) => r.day)).toEqual(['Sunday', 'Tuesday', 'Sunday', 'Tuesday']);
});

test('with no day picked, the repeat stays on the start date\'s weekday', async ({ page }) => {
  await openForm(page);
  const rows = sessionInserts(page);
  await page.locator('#ns-date').fill('2099-01-01');
  await expect(page.locator('#ns-repeat option').first()).toHaveText('Just this date');
  await expect(page.locator('#ns-fill')).toHaveText('');
  await page.locator('#ns-repeat').selectOption('3');
  await expect(page.locator('#ns-fill')).toContainText('3 sessions');
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect.poll(() => rows.map((r) => r.id)).toEqual(['2099-01-01', '2099-01-08', '2099-01-15']);
});

test('a template saves the setup, fills the form but not its date, and can be removed and undone', async ({ page }) => {
  await openForm(page);
  const saved: unknown[][] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rest/v1/staff_options')) {
      const b = r.postDataJSON();
      if (b && b.key === 'session_templates') saved.push(b.items);
    }
  });
  const form = page.locator('#sess-add-form');
  await expect(form.locator('.ns-tpl')).toContainText('No templates yet');
  // the session templates' own heading, not the Settings card's "Message templates"
  await expect(form.locator('.ns-tpl-title')).toHaveText('Templates');
  await page.evaluate(`S.newSessEvent='community';S.newSessSpots='35';S.newSessStartTime='05:45';S.newSessEndTime='06:15';S.newSessDays=[6];renderSessions()`);
  await form.getByRole('button', { name: 'Save setup as template' }).click();
  const name = page.locator('#prompt-input');
  await expect(name).toHaveValue(/Saturday Social Ride 05:45/);
  await name.fill('Saturday social');
  await name.press('Enter');
  await expect.poll(() => saved.length).toBe(1);
  // the confirmation names the template it saved
  expect(await page.evaluate(`t('nsTplSaved').replace('{0}','Saturday social')`)).toBe('Template saved: Saturday social');
  await expect.poll(() => page.evaluate(`JSON.stringify(S.fullLog||[])`)).toContain('Template saved: Saturday social');
  expect(saved[0]).toEqual([expect.objectContaining({ label: 'Saturday social', form: expect.objectContaining({ newSessEvent: 'community', newSessSpots: '35', newSessDays: [6] }) })]);
  expect(JSON.stringify(saved[0])).not.toContain('newSessDate');

  // a fresh form, with a date already chosen: the template fills everything but the date
  await page.evaluate(`S.newSessEvent='jcc';S.newSessSpots='';S.newSessStartTime='21:00';S.newSessEndTime='23:00';S.newSessDays=[];S.newSessDate='2099-02-01';renderSessions()`);
  await form.locator('.ns-tpl-use', { hasText: 'Saturday social' }).click();
  expect(await page.evaluate(`({ev:S.newSessEvent,spots:S.newSessSpots,start:S.newSessStartTime,days:S.newSessDays,date:S.newSessDate})`))
    .toEqual({ ev: 'community', spots: '35', start: '05:45', days: [6], date: '2099-02-01' });
  await expect(day(page, 'Sat')).toHaveAttribute('aria-pressed', 'true');

  // removed at once, with Undo
  await form.getByRole('button', { name: 'Remove template Saturday social' }).click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1]).toEqual([]);
  await expect(form.locator('.ns-tpl-use')).toHaveCount(0);
  await page.locator('#topbar-right .undo-btn').click();
  await expect.poll(() => saved.length).toBe(3);
  await expect(form.locator('.ns-tpl-use', { hasText: 'Saturday social' })).toBeVisible();
});

test('templates saved on another device show up here', async ({ page }) => {
  await openForm(page, { staff_options: [{ key: 'session_templates', items: [
    { id: 'tplA', label: 'Tuesday circuit', form: { newSessEvent: 'jcc', newSessStartTime: '21:00', newSessEndTime: '23:00', newSessDays: [0, 2], newSessMode: 'total', newSessTotal: 120 } },
    { bad: true },
  ] }] });
  const form = page.locator('#sess-add-form');
  await expect(form.locator('.ns-tpl-use')).toHaveText(['Tuesday circuit']);
  await form.locator('.ns-tpl-use').click();
  expect(await page.evaluate(`({total:S.newSessTotal,days:S.newSessDays})`)).toEqual({ total: 120, days: [0, 2] });
});
