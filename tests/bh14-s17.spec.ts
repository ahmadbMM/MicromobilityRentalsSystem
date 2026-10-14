import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-14 (s17): the accounts list's Birthday filter, the Instagram count typed with Persian
// digits, the follower check answered after its dialog closed, and Select all.

const customers = [
  { id: 'c1', name: 'Huda Saleh', email: 'huda@example.test', phone: '+966551239876', gender: 'female', birth_date: null, socials: { instagram: 'huda.rides' }, created_at: '2026-01-05T10:00:00Z' },
  { id: 'c2', name: 'Karim Mansour', email: 'karim@example.test', phone: '+201005553412', gender: 'male', birth_date: null, socials: null, created_at: '2026-02-05T10:00:00Z' },
  { id: 'c3', name: 'Zaid Newcomer', email: 'zaid@example.test', phone: '+966551230000', gender: 'male', birth_date: null, socials: null, created_at: '2026-09-05T10:00:00Z' },
];

async function open(page: Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], customer_flags: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  await page.waitForFunction('typeof _amDefs==="function"&&typeof _igParse==="function"');
}

test.describe('@bh14 s17 accounts and Instagram', () => {
  test('Birthday "This month" keeps a birthday already passed this month', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const w = window as unknown as Record<string, (...a: unknown[]) => unknown>;
      const today = String(w.todayStr()), y = today.slice(0, 4), m = today.slice(5, 7), d = +today.slice(8, 10);
      const f = ((w._amDefs(true) as unknown[][]).find((x) => x[0] === 'amBday') as unknown[])[3] as (c: unknown, v: string) => boolean;
      const born = (day: number) => ({ birth_date: `1990-${m}-${String(day).padStart(2, '0')}` });
      const nm = +m === 12 ? '01' : String(+m + 1).padStart(2, '0');
      return {
        d, y,
        passed: d > 1 ? f(born(1), 'month') : true, // the 1st, already gone unless today is the 1st
        today: f(born(d), 'month'),
        nextMonth: f({ birth_date: `1990-${nm}-15` }, 'month'),
        nextMonthPick: f({ birth_date: `1990-${nm}-15` }, 'next'),
      };
    });
    expect(r.passed).toBe(true);
    expect(r.today).toBe(true);
    expect(r.nextMonth).toBe(false);
    expect(r.nextMonthPick).toBe(true);
  });

  test('a typed follower count reads Arabic-Indic and Persian digits', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const p = (window as unknown as { _igParse: (v: string) => number | null })._igParse;
      return [p('١٢٬٤٠٠'), p('۱۲۴۰۰'), p('۱۲٫۴k'), p('12.4k'), p('abc')];
    });
    expect(r).toEqual([12400, 12400, 12400, 12400, null]);
  });

  test('a follower check that answers after its dialog closed still keeps the count', async ({ page }) => {
    await open(page);
    const n = await page.evaluate(`(async () => {
      S.igRows = new Map();
      let release = () => {};
      window._igCall = () => new Promise((res) => { release = res; });
      _igOpen('c1');
      const done = _igCheck();
      _igClose();
      release({ results: [{ customer_id: 'c1', handle: 'huda.rides', followers: 777, status: 'ok', source: 'auto' }] });
      await done;
      const row = S.igRows.get('c1');
      return row ? row.followers : null;
    })()`);
    expect(n).toBe(777);
  });

  test('Select all ticks every account shown, once', async ({ page }) => {
    await open(page);
    await page.evaluate(`_amSelMode()`);
    await page.evaluate(`S.amSel.add('c2');_amSelAll()`);
    expect(await page.evaluate(`[...S.amSel].map(String).sort()`)).toEqual(['c1', 'c2', 'c3']);
    await expect(page.locator('#am-cust-rows .am-sel[aria-pressed="true"]')).toHaveCount(3);
  });
});
