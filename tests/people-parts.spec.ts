import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, staffReady, goStaffTab } from './helpers/supabase';

// People in parts (staff round s10, item 47). The community part was a quarter of every staff part, and an
// account with People fetched all of it to open the Accounts list. People's rarely opened views are parts of
// their own now, inside community (STAFF_PART_UP in scripts/split-staff.mjs): peopleapps (Applications) and
// peoplemore (Recognition, Birthdays, Referrals, Tags, Duplicates, the activity log, the account report, the
// actions on a group). Each is fetched the first time one of its views is opened; until then the view's
// renderer is a stand-in answering a promise, People draws a loading line (_pplPartHtml) and paints again.

const customers = [
  { id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', height: 165, created_at: '2026-01-05T10:00:00Z' },
  { id: 'c2', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', height: 178, created_at: '2026-02-05T10:00:00Z' },
];
const app = {
  created_at: '2026-09-22T08:00:00Z', updated_at: '2026-09-22T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12',
  gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null,
  customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect',
  id: 'a1', status: 'pending', name: 'Omar Haddad', email: 'omar.haddad@gmail.com', phone: '+966553579024', instagram: 'omar.h', linkedin: 'omar-h',
};

// A real device: the parts come after the desk's first paint, only those the account's sections use.
async function boot(page: Page, asked: string[]) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: [app] });
  await page.addInitScript(() => {
    (window as unknown as { __staffPartsNow?: boolean }).__staffPartsNow = false;
    localStorage.setItem('cq_role', 'admin');
  });
  await unlockStaff(page);
  page.on('request', (r) => { const p = new URL(r.url()).pathname; if (p.startsWith('/staff-parts/')) asked.push(p); });
  await page.goto('/bookings', { waitUntil: 'domcontentloaded' }); // a part held back holds the load event
  await staffReady(page);
  await waitForSb(page);
}
const n = (asked: string[], part: string) => asked.filter((p) => p === `/staff-parts/${part}.js`).length;

test.describe('@staff People in parts (item 47)', () => {
  test('Accounts works before the new parts come, and Applications fetches its part once', async ({ page }) => {
    const asked: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await boot(page, asked);
    // the account's sections' parts arrive after the first paint; People's own two are not among them
    await expect.poll(() => n(asked, 'community'), { timeout: 10000 }).toBe(1);
    await goStaffTab(page, 'community');
    await page.locator('#tab-community .filter-pill[data-ppl-grp="accounts"]').click();
    await expect(page.locator('#am-cust-rows .am-row')).toHaveCount(2);
    await expect(page.locator('#am-cust-rows .am-row[data-cust="c2"]')).toContainText('Karim Mansour');
    await page.waitForTimeout(400);
    expect(n(asked, 'peopleapps')).toBe(0);
    expect(n(asked, 'peoplemore')).toBe(0);
    // still the stand-ins: their code has not been fetched
    expect(await page.evaluate(`/_partGo/.test(String(_commApplications))&&/_partGo/.test(String(_commBirthdays))`)).toBe(true);

    // Applications: a loading line while its part comes, then the list; the part is fetched once
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/staff-parts/peopleapps.js*', async (route) => { await held; await route.continue(); });
    await page.locator('#tab-community .filter-pill[data-ppl-grp="membership"]').click();
    await expect(page.locator('#ppl-part-wait [role="status"]')).toBeVisible();
    await expect(page.locator('#tab-community .ppl-sub')).toBeVisible(); // People's own bar is drawn meanwhile
    release();
    await expect(page.locator('.ca-row[data-app-id="a1"]')).toBeVisible();
    await expect(page.locator('#ppl-part-wait')).toHaveCount(0);
    expect(n(asked, 'peopleapps')).toBe(1);
    expect(await page.evaluate(`/_partGo/.test(String(_commApplications))`)).toBe(false);
    // away and back: nothing fetched again, and the other part still not asked for
    await page.locator('#tab-community .filter-pill[data-ppl-grp="accounts"]').click();
    await expect(page.locator('#am-cust-rows .am-row')).toHaveCount(2);
    await page.locator('#tab-community .filter-pill[data-ppl-grp="membership"]').click();
    await expect(page.locator('.ca-row[data-app-id="a1"]')).toBeVisible();
    expect(n(asked, 'peopleapps')).toBe(1);
    expect(n(asked, 'peoplemore')).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a view whose part did not come says so, and Try again fetches it', async ({ page }) => {
    const asked: string[] = [];
    await boot(page, asked);
    await expect.poll(() => n(asked, 'community'), { timeout: 10000 }).toBe(1);
    let fail = true;
    await page.route('**/staff-parts/peoplemore.js*', async (route) => { if (fail) await route.abort(); else await route.continue(); });
    await goStaffTab(page, 'community');
    await page.evaluate(`setCommTab('tags')`);
    await expect(page.locator('#ppl-part-wait')).toContainText('This view did not load. Check your connection and try again.');
    fail = false;
    await page.locator('#ppl-part-wait button', { hasText: 'Try again' }).click();
    await expect(page.locator('#ppl-part-wait')).toHaveCount(0);
    await expect(page.locator('#tab-community .ppl-sub .filter-pill.active')).toContainText('Tags');
    expect(n(asked, 'peoplemore')).toBe(2);
    // the parent came first and once; the child after it
    expect(n(asked, 'community')).toBe(1);
    expect(asked.indexOf('/staff-parts/community.js')).toBeLessThan(asked.indexOf('/staff-parts/peoplemore.js'));
  });

  test('a session\'s report is out of the desk\'s core, and its dialog opens from the stand-in', async ({ page }) => {
    const asked: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/staff-parts/sessreport.js*', async (route) => { await held; await route.continue(); });
    await boot(page, asked);
    // the desk is drawn without it: staff.js no longer carries the report's code
    expect(await page.evaluate(`/_partGo/.test(String(showPrintReportOptions))&&typeof _repRows==='undefined'`)).toBe(true);
    const opened = page.evaluate(`showPrintReportOptions()`); // the Bookings menu's Print report, before the part is here
    release();
    await opened;
    await expect(page.locator('#print-opts-modal .rpt-row').first()).toBeVisible();
    expect(n(asked, 'sessreport')).toBe(1);
    expect(await page.evaluate(`typeof _repRows`)).toBe('function');
  });
});

// The rule itself, on a small script: what a part and the part inside it both reach stays in the outer part
// (it has always come first), where two plain parts would hand it back to the core; the strings likewise.
type Split = {
  splitSections(code: string, parts: Record<string, string[]>, roots: string[], up: Record<string, string>): { core: string; parts: Record<string, string> };
  partLangKeys(keys: Set<string>, core: string, parts: Record<string, string>, dynamic: RegExp[], up: Record<string, string>): { core: Set<string>; parts: Record<string, Set<string>> };
};
test('@build a part inside another keeps what they share; a third part still sends it to the core', async () => {
  const { splitSections, partLangKeys } = await (import('../scripts/split-staff.mjs' as string) as Promise<Split>);
  const code = [
    'function outer(){return shared()+onlyOuter();}', 'function inner(){return shared()+onlyInner();}', 'function other(){return mine();}',
    'function shared(){return 1;}', 'function onlyOuter(){return 2;}', 'function onlyInner(){return 3;}', 'function mine(){return 4;}',
  ].join('\n') + '\n';
  const has = (text: string, fn: string) => text.includes(`function ${fn}(`);
  const nested = splitSections(code, { a: ['outer'], b: ['inner'], c: ['other'] }, [], { b: 'a' });
  expect(has(nested.parts.a, 'shared') && has(nested.parts.a, 'onlyOuter')).toBe(true);
  expect(has(nested.parts.b, 'onlyInner') && !has(nested.parts.b, 'shared')).toBe(true);
  expect(has(nested.core, 'shared')).toBe(false);
  expect(nested.core).toContain('var STAFF_PART_UP={"b":"a"};');
  // the stand-ins hand over through one body
  expect(nested.core).toContain('function inner(...a){return _partGo("inner","b",a);}');
  const flat = splitSections(code, { a: ['outer'], b: ['inner'], c: ['other'] }, [], {});
  expect(has(flat.core, 'shared')).toBe(true);
  const third = splitSections(code.replace('return mine();', 'return mine()+shared();'), { a: ['outer'], b: ['inner'], c: ['other'] }, [], { b: 'a' });
  expect(has(third.core, 'shared')).toBe(true);
  // a key the outer part and the inner one both say rides with the outer one; one only the inner says, with it
  const home = partLangKeys(new Set(['kBoth', 'kInner', 'kOther']), '', { a: "t('kBoth')", b: "t('kBoth');t('kInner')", c: "t('kOther')" }, [], { b: 'a' });
  expect([...home.parts.a]).toEqual(['kBoth']);
  expect([...home.parts.b]).toEqual(['kInner']);
  expect([...home.parts.c]).toEqual(['kOther']);
  expect(home.core.size).toBe(0);
});
