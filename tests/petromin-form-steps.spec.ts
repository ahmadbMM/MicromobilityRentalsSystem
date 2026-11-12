import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Form steps (2026-11-11): how far riders get on the registration form at micromobility.sa/petromin, read from
// form_step_counts (migration 20261111030000) in a centred dialog beside the Billing report. Counts only.

const SESS = '2099-02-08-pw';
const sessions = [{
  id: SESS, day: 'Wednesday', session_date: '2099-02-08', capacity: 35, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }), event_kind: 'community',
  ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false, title: "Petromin's Wednesdays",
}];
const row = (step: number, event: string, n: number, field = '', lang = 'en') => ({ day: '2099-02-07', form: 'petromin', step, event, field, lang, n });
const form_step_counts = [
  row(1, 'view', 80), row(1, 'view', 20, '', 'ar'), row(2, 'view', 60), row(3, 'view', 45), row(4, 'view', 40),
  row(4, 'done', 30), row(4, 'done', 6, '', 'ar'),
  row(2, 'error', 5, 'phone'), row(2, 'error', 4, 'phone', 'ar'), row(2, 'error', 3, 'badge'), row(4, 'error', 2, 'waiver'),
  row(4, 'fail', 2, 'duplicate'), row(1, 'found', 5), row(1, 'cancel', 1),
];
// The page's first step since 2026-11-13: the company picked ('pmhome', a 'done' names the pick).
const pick = (field: string, n: number, event = 'done') => ({ day: '2099-02-07', form: 'pmhome', step: 1, event, field, lang: 'en', n });
const picks = [pick('', 120, 'view'), pick('petromin', 50), pick('petrolube', 20), pick('dukan', 20), pick('guest', 10), pick('company', 3, 'error')];

test.describe('@staff:bookings Petromin form steps', () => {
  test('beside the Billing report: the funnel, the fields, the refusals and the languages, for the period picked', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], rider_registrations: [], form_step_counts: [...form_step_counts, ...picks] });
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/form_step_counts')) asked.push(decodeURIComponent(r.url())); });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const btn = page.locator('#pm-host button[data-on-click*="openFormSteps"]');
    // next to the Billing report, for the same staff
    await expect(page.locator('#pm-host button[data-on-click*="openRidersReport"] + button')).toHaveAttribute('data-on-click', /openFormSteps/);
    await btn.click();
    const dlg = page.getByRole('dialog', { name: 'Form steps' });
    await expect(dlg).toBeVisible();
    // 30 days by default, Petromin's rows only, from the KSA day 29 days back
    await expect(dlg.locator('select')).toHaveValue('30');
    const since = await page.evaluate(`_ksaYmd(Date.now()-29*864e5)`);
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked[0]).toContain('form=in.(petromin,pmhome)');
    expect(asked[0]).toContain(`day=gte.${since}`);
    const bar = (label: string) => dlg.locator('.analytics-bar-row', { hasText: label }).locator('.analytics-bar-value');
    // the company each visitor picked on the page's first step, every company together, above the picked form's steps
    const picked = (alt: string) => dlg.locator('.analytics-bar-row', { has: page.locator(`img[alt="${alt}"]`) }).locator('.analytics-bar-value');
    await expect(picked('Petromin')).toHaveText('50 · 50%');
    await expect(picked('Petrolube')).toHaveText('20 · 20%');
    await expect(picked('Dukan')).toHaveText('20 · 20%');
    await expect(bar('Invitees')).toHaveText('10 · 10%');
    await expect(bar('1. Night')).toHaveText('100 · 100%');
    await expect(bar('4. Check and agree')).toHaveText('40 · 40%');
    await expect(bar('Registered')).toHaveText('36 · 36%');
    // centred, not a sheet at the bottom: measured once its rows are drawn (the dialog is drawn again when they land, and a
    // box read in between found the copy just replaced)
    const box = (await dlg.boundingBox())!, vp = page.viewportSize()!;
    expect(Math.abs(box.y + box.height / 2 - vp.height / 2)).toBeLessThan(vp.height * 0.15);
    // the field that stopped a Continue, most first, in the desk's words; the server's refusals by code
    await expect(dlg.locator('.pfs-fill-err').first().locator('xpath=../..')).toContainText('Phone');
    await expect(bar('Phone')).toHaveText('9');
    await expect(bar('Ride waiver')).toHaveText('2');
    await expect(bar('duplicate')).toHaveText('2');
    await expect(dlg.locator('.pfs-kv')).toContainText('Found with Find my booking5');
    await expect(dlg.locator('.pfs-kv')).toContainText('Cancelled from the form1');
    await expect(bar('English')).toHaveText('30 · 83%');
    await expect(bar('العربية')).toHaveText('6 · 17%');
    // another period reads again, from its own day
    await dlg.locator('select').selectOption('7');
    const since7 = await page.evaluate(`_ksaYmd(Date.now()-6*864e5)`);
    await expect.poll(() => asked.some((u) => u.includes(`day=gte.${since7}`))).toBe(true);
    await expect(bar('Registered')).toHaveText('36 · 36%');
    // Dukan's steps on the merged page ('pmdukan', 2026-11-13): its own rows, and a bike step like Petromin's
    const answer = (rows: unknown[]) => ({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(rows) });
    const drow = (form: string, step: number, event: string, n: number) => ({ day: '2099-02-07', form, step, event, field: '', lang: 'en', n });
    await page.route(/\/rest\/v1\/form_step_counts.*form=in\.(\(|%28)pmdukan/, (r) => r.fulfill(answer(
      [drow('pmdukan', 1, 'view', 10), drow('pmdukan', 2, 'view', 8), drow('pmdukan', 3, 'view', 7), drow('pmdukan', 4, 'view', 6), drow('pmdukan', 4, 'done', 5), ...picks])));
    await page.route(/\/rest\/v1\/form_step_counts.*form=in\.(\(|%28)pmguest/, (r) => r.fulfill(answer(
      [drow('pmguest', 1, 'view', 20), drow('pmguest', 2, 'view', 12), drow('pmguest', 3, 'view', 11), drow('pmguest', 4, 'view', 10), drow('pmguest', 4, 'done', 9), ...picks])));
    await expect(dlg.locator('.pfs-form')).toHaveCount(3);
    await expect(dlg.locator('.pfs-form').nth(0)).toHaveAttribute('aria-pressed', 'true');
    await dlg.locator('.pfs-form').nth(1).click();
    await expect.poll(() => asked.some((u) => u.includes('form=in.(pmdukan,pmhome)'))).toBe(true);
    await expect(dlg.locator('.pfs-form').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(bar('1. Night')).toHaveText('10 · 100%');
    await expect(bar('3. Bikes')).toHaveText('7 · 70%');
    await expect(bar('4. Check and agree')).toHaveText('6 · 60%');
    await expect(bar('Registered')).toHaveText('5 · 50%');
    await expect(picked('Dukan')).toHaveText('20 · 20%');
    // Petromin's guests ('pmguest'): the account comes first, then the night, the bike, Check and agree
    await expect(dlg.locator('.pfs-form').nth(2)).toHaveText('Invitees');
    await dlg.locator('.pfs-form').nth(2).click();
    await expect.poll(() => asked.some((u) => u.includes('form=in.(pmguest,pmhome)'))).toBe(true);
    await expect(bar('1. Account')).toHaveText('20 · 100%');
    await expect(bar('2. Night')).toHaveText('12 · 60%');
    await expect(bar('3. Bikes')).toHaveText('11 · 55%');
    await expect(bar('Registered')).toHaveText('9 · 45%');
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
  });

  test('before the database has the table, it says so instead of showing nothing', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], rider_registrations: [] });
    await page.route(/\/rest\/v1\/form_step_counts/, (r) => r.fulfill({
      status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.form_step_counts' in the schema cache" }),
    }));
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders');openFormSteps()`);
    const dlg = page.getByRole('dialog', { name: 'Form steps' });
    await expect(dlg).toContainText('Waiting for the database update.');
    await dlg.getByRole('button', { name: 'Close' }).click();
    await expect(dlg).toHaveCount(0);
  });
});
