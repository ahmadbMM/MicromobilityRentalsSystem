import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb, staffReady, type Fixtures } from './helpers/supabase';

// Staff round s10, builder "trust" (items 42-46): section rights at the database, the accessibility gate, 24px targets,
// focus clear of the sticky stack, the roster's pending state said to a screen reader, and Arabic slips.
// All Supabase traffic stubbed; invented people and numbers.

const DAY = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); // tomorrow in Riyadh: never "yesterday" after 23:00
const sessions = [{ id: DAY, session_date: DAY, day: 'Saturday', status: 'open', capacity: 20, created_at: 1 }];
const customers = [1, 2, 3].map((i) => ({ id: `c${i}`, name: ['Lina Haddad', 'Omar Saleh', 'Sara Ali'][i - 1], phone: `055000000${i}`, created_at: '2026-10-01T09:00:00Z' }));
const queue_entries = [1, 2, 3].map((i) => ({ id: `q${i}`, session_id: DAY, session_day: 'Saturday', session_date: DAY, queue_num: i, name: customers[i - 1].name,
  phone: customers[i - 1].phone, customer_id: `c${i}`, type_preference: 'Road', size: 'M', status: i === 3 ? 'done' : 'waiting', paid: false, price: 75, registered_at: DAY + 'T10:00:00Z' }));
const bikes = [1, 2, 3, 4].map((i) => ({ id: `b${i}`, name: `R-${i}`, type: 'Road', size: 'M', status: i > 2 ? 'maintenance' : 'available', colors: ['#c0392b'], bike_number: i }));

async function boot(page: Page, fx: Fixtures = {}, lang = 'en') {
  await stubSupabase(page, { sessions, customers, queue_entries, bikes, ...fx });
  await unlockStaff(page);
  await page.addInitScript((l) => localStorage.setItem('cq_lang', l), lang);
  await page.goto('/');
  await staffReady(page);
  await waitForSb(page);
  if (lang === 'ar') await page.locator('html[dir="rtl"]').waitFor();
}
const box = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });

test.describe('@staff:shell s10 trust: Arabic', () => {
  test('the rail names Lockers and Volunteers in Arabic, and the Store\'s spec placeholders are Arabic', async ({ page }) => {
    await boot(page, {}, 'ar');
    const lbl = (k: string) => page.locator(`#staff-tab-nav .tab-btn[data-stab="${k}"] .snav-lbl`);
    await expect(lbl('lockers')).toHaveText('الخزائن');
    await expect(lbl('volunteers')).not.toHaveText('Volunteers');
    expect(await page.evaluate(`[t('stoSpecKeyPh'),t('stoSpecValPh')]`)).toEqual(['الإطار', 'ألمنيوم']);
  });

  test('a History log line keeps a phone number, a booking code and an amount in order (bdi)', async ({ page }) => {
    await boot(page, {}, 'ar');
    const html = await page.evaluate(`_bdiRuns('سجّل الحضور #3 Lina · +966 55 123 4567 · BD-89E0AB7D · SAR 75 <b>')`);
    expect(html).toContain('<bdi>+966 55 123 4567</bdi>');
    expect(html).toContain('<bdi>BD-89E0AB7D</bdi>');
    expect(html).toContain('<bdi>SAR 75</bdi>');
    expect(html).toContain('#3 Lina'); // a party number is not a phone
    expect(html).toContain('&lt;b&gt;'); // still escaped
  });
});

test.describe('@staff:checkin s10 trust: focus and status', () => {
  test('a pending row is said in the status region (no bar), then said saved', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue');S.sfSession='${DAY}';renderStaffQueue()`);
    const live = page.locator('#toast-live');
    await expect(live).toHaveAttribute('role', 'status');
    await page.evaluate(`_rowPending('q1',true)`);
    await expect(live).toContainText('Sending: #1 Lina Haddad');
    await expect(page.locator('#toast-live .toast')).toHaveCount(0); // said, never drawn
    await page.evaluate(`_rowPending('q1',false)`);
    await expect(live).toContainText('Saved: #1 Lina Haddad');
    // a refused row is said by its own message, not "Saved"
    await page.evaluate(`_rowPending('q2',true);_rowPending('q2',false);_rowSay('q2','Refused for the spec')`);
    await page.waitForTimeout(600);
    await expect(live).not.toContainText('Saved: #2');
  });

  test('scroll-padding-top covers the top bar plus the Bookings stack, and drops it on other sections', async ({ page }) => {
    test.skip(page.viewportSize()!.width < 1024, 'the table header sticks on desktop only');
    await boot(page);
    await page.evaluate(`setStaffTab('queue');S.sfSession='${DAY}';renderStaffQueue()`);
    await page.locator('#q-live-count').waitFor();
    const read = () => page.evaluate(() => {
      const lc = document.getElementById('q-live-count'), th = document.querySelector('#tab-queue .queue-table-desktop-wrap .queue-table thead') as HTMLElement | null;
      const tb = document.getElementById('topbar');
      return { pad: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop), want: (tb ? tb.offsetHeight : 0) + (lc ? lc.offsetHeight : 0) + (th ? th.offsetHeight : 0) + 12,
        stack: document.documentElement.style.getPropertyValue('--q-stack') };
    });
    await expect.poll(async () => { const r = await read(); return Math.abs(r.pad - r.want) <= 1 && parseFloat(r.stack) > 0; }).toBe(true);
    await page.evaluate(`setStaffTab('sessions')`);
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--q-stack'))).toBe('0px');
  });
});

test.describe('@staff:shell s10 trust: 24px targets', () => {
  test('sort headers, session links, attention links and badge request names give a 24px hit area, the rows keep their height', async ({ page }) => {
    const ago = (h: number) => new Date(Date.now() - h * 36e5).toISOString();
    await boot(page, {
      badges: [{ id: 'bd_marshal', slug: 'marshal', icon: 'shield', color: 'orange', name: 'Marshal', system: true, auto: false, retired: false, sort: 10 }],
      customer_badges: [],
      badge_requests: [{ id: 1, customer_id: 'c1', badge_id: 'bd_marshal', comment: 'Swept 12 rides', proof_kind: null, proof_name: null, status: 'pending', created_at: ago(2), decided_at: null, decided_by: null, reply: null }],
    });
    await page.evaluate(`S.sessView='table';setStaffTab('sessions')`);
    await page.locator('#tab-sessions .ss-th-btn').first().waitFor();
    expect((await box(page, '#tab-sessions .ss-th-btn')).h).toBeGreaterThanOrEqual(24);
    expect((await box(page, '#tab-sessions .ss-tbl .ss-link')).h).toBeGreaterThanOrEqual(24);
    // the header row is no taller than its text needs
    expect((await box(page, '#tab-sessions .ss-tbl thead tr')).h).toBeLessThan(60);
    await page.evaluate(`setStaffTab('history')`);
    await page.locator('#tab-history th .q-sort-btn').first().waitFor();
    expect((await box(page, '#tab-history th .q-sort-btn')).h).toBeGreaterThanOrEqual(24);
    await page.evaluate(`setStaffTab('inventory')`);
    const attn = page.locator('.bk-attn-link').first();
    if (await attn.count()) expect((await box(page, '.bk-attn-link')).h).toBeGreaterThanOrEqual(24);
    await page.evaluate(`setStaffTab('badgereq')`);
    await page.locator('#tab-badgereq .bdr-who').first().waitFor();
    expect((await box(page, '#tab-badgereq .bdr-who')).h).toBeGreaterThanOrEqual(24);
  });
});

test.describe('@staff:team s10 trust: section rights', () => {
  test('a device without Inventory changes does not push its old lists to the shared rows', async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('cq_inv_cats_eq', JSON.stringify(['Pumps'])); });
    const writes: string[] = [];
    page.on('request', (r) => { if (/\/rest\/v1\/staff_options/.test(r.url()) && r.method() === 'POST') writes.push(r.url()); });
    await boot(page, { staff_options: [] });
    await page.evaluate(`S.staffRole='leader';S._myView=null;S._myEdit=null;localStorage.removeItem('cq_devopt_moved');_devOptSync()`);
    await page.waitForTimeout(400);
    expect(writes).toEqual([]);
    expect(await page.evaluate(`localStorage.getItem('cq_devopt_moved')`)).toBeNull(); // tried again once the account may change Inventory
  });

  test('the migration reads a NULL list as the role\'s sections and checks workshop, messages and shared options by section', () => {
    const sql = readFileSync('supabase/migrations/20261111180200_section_checks.sql', 'utf8');
    // the page's ROLE_TABS, in the database's ids
    expect(sql).toMatch(/when 'mechanic' then array\['inventory','workshop'\]/);
    expect(sql).toMatch(/when 'leader' then array\['queue'\]/);
    expect(sql).toMatch(/coalesce\(s\.modules_edit, s\.modules_view, _staff_role_mods\(s\.role\)\)/);
    expect(sql).not.toMatch(/modules_view end\) is null/); // the old "NULL passes every section"
    expect(sql).toMatch(/create policy "workshop staff update"[\s\S]*?_staff_mod\('workshop', true\)\) or \(select _staff_mod\('cashier', true\)\)/);
    expect(sql).toMatch(/create policy "site messages staff read"[\s\S]*?_staff_mod\('messages'\)\)/);
    expect(sql).toMatch(/create trigger staff_options_views_guard before insert or update or delete on public\.staff_options/);
    expect(sql).toMatch(/when p_key = 'biz' or p_key like 'biz\.%' then is_admin\(\)/);
    // definer helpers keep their attributes
    for (const fn of ['_staff_mod', '_staff_opt_ok', '_staff_views_guard']) {
      expect(sql).toMatch(new RegExp(`function public\\.${fn}\\([^)]*\\)[\\s\\S]*?security definer[\\s\\S]*?set search_path = public`));
    }
    // the client's role map and the database's agree on what each role opens
    const src = readFileSync('app.src.html', 'utf8');
    const m = /const ROLE_TABS=(\{[^;]*\});/.exec(src);
    expect(m).not.toBeNull();
    const desk = /const DESK_TABS=(\[[^\]]*\])/.exec(src)![1];
    const roleTabs = new Function('DESK_TABS', `return ${m![1]}`)(JSON.parse(desk.replace(/'/g, '"'))) as Record<string, string[]>;
    const parent: Record<string, string> = { sessions: 'queue', lockers: 'queue', waitlist: 'queue', badgereq: 'community', store: 'cashier', payments: 'cashier' };
    for (const [role, tabs] of Object.entries(roleTabs)) {
      const line = new RegExp(`when '${role}' then array\\[([^\\]]*)\\]`).exec(sql);
      const dbIds = line ? line[1].replace(/'/g, '').split(',').filter(Boolean) : (role === 'frontdesk' ? ['queue', 'cashier', 'workshop'] : []);
      for (const tab of tabs) expect(dbIds, `${role} opens ${tab}`).toContain(parent[tab] || tab);
    }
  });
});
